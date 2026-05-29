// mail-receiver — minimal SMTP server that translates each received
// message into a SendGrid Inbound Parse-shaped multipart POST and
// hands it to the api's existing /webhooks/sendgrid-inbound webhook.
//
// Why custom Go and not Postfix-in-a-container: at our volume (handful
// of emails per week) Postfix's flexibility is overkill, and the
// translation step needs custom code anyway. emersion/go-smtp gives us
// the entire SMTP receive path in ~80 lines of glue.
//
// What this is NOT:
//   * An outbound relay. Resend handles all outbound; we never send
//     mail from this process. AuthPlain returns success but isn't used.
//   * A spam filter. Inbound traffic is low; we accept everything and
//     let the operator delete junk from the admin inbox. A future
//     iteration can pipe through rspamd if needed.
//   * A general-purpose mail server. We strictly forward to one
//     webhook URL; the destination is the operator's backoffice.
//
// Auth model: anyone can connect and send mail (mail servers don't
// authenticate inbound senders generally — they rely on SPF / DKIM /
// DMARC at the application layer; we skip those checks since SendGrid's
// inbound parse format provides spam_score in the payload, and we can
// surface low-trust senders in the admin UI without rejecting them).
//
// Recipient gate: we only accept mail addressed to OUR_DOMAIN (anything
// else is RCPT-rejected, which keeps us from being an open relay).

package main

import (
	"context"
	"errors"
	"io"
	"net"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/emersion/go-smtp"
	"github.com/rs/zerolog"
	"github.com/rs/zerolog/log"

	"github.com/oddzilla/mail-receiver/internal/relay"
)

func main() {
	zerolog.TimeFieldFormat = zerolog.TimeFormatUnix
	log.Logger = log.With().Str("service", "mail-receiver").Logger()

	cfg, err := loadConfig()
	if err != nil {
		log.Fatal().Err(err).Msg("config")
	}

	relayClient := relay.New(cfg.WebhookURL, cfg.WebhookSecret)
	backend := &Backend{
		domain:          cfg.Domain,
		relay:           relayClient,
		maxConnsPerIP:   cfg.MaxConnsPerIP,
		maxMsgsPerIPMin: cfg.MaxMsgsPerIPMin,
		activeByIP:      make(map[string]int),
		msgByIP:         make(map[string]*ipMsgWindow),
	}

	srv := smtp.NewServer(backend)
	srv.Addr = cfg.Listen
	srv.Domain = cfg.Domain
	srv.ReadTimeout = 60 * time.Second
	srv.WriteTimeout = 60 * time.Second
	// Inbound message size cap. The webhook endpoint also rejects >8 MiB;
	// matching it here means we refuse the bytes at SMTP time rather
	// than reading them and then 413'ing inside the webhook.
	srv.MaxMessageBytes = 8 * 1024 * 1024
	srv.MaxRecipients = 50
	srv.AllowInsecureAuth = true
	// We never advertise STARTTLS in this iteration. Real-world MX
	// records widely accept plaintext inbound; senders that require TLS
	// will downgrade or skip us and we lose those messages. If
	// reliability becomes a concern we mount Caddy's Let's Encrypt cert
	// and enable srv.TLSConfig.
	srv.EnableSMTPUTF8 = true

	log.Info().
		Str("listen", cfg.Listen).
		Str("domain", cfg.Domain).
		Str("webhook", cfg.WebhookURL).
		Msg("mail-receiver listening")

	errCh := make(chan error, 1)
	go func() {
		errCh <- srv.ListenAndServe()
	}()

	// Graceful shutdown on SIGTERM. Stops accepting new connections,
	// lets in-flight sessions drain; the SMTP library's Close is
	// synchronous so we don't need an extra wait group.
	sig := make(chan os.Signal, 1)
	signal.Notify(sig, syscall.SIGTERM, syscall.SIGINT)
	select {
	case err := <-errCh:
		log.Fatal().Err(err).Msg("smtp server exited")
	case s := <-sig:
		log.Info().Str("signal", s.String()).Msg("shutting down")
		ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer cancel()
		_ = ctx
		_ = srv.Close()
	}
}

type config struct {
	Listen          string
	Domain          string
	WebhookURL      string
	WebhookSecret   string
	MaxConnsPerIP   int
	MaxMsgsPerIPMin int
}

func loadConfig() (config, error) {
	c := config{
		// Default to a high (non-privileged) port inside the container.
		// docker-compose maps host port 25 → container 2525 so the
		// container runs as `nobody` without needing NET_BIND_SERVICE.
		Listen:        envOrDefault("MAIL_RECEIVER_LISTEN", ":2525"),
		Domain:        envOrDefault("MAIL_RECEIVER_DOMAIN", "oddzilla.cc"),
		WebhookURL:    os.Getenv("MAIL_WEBHOOK_URL"),
		WebhookSecret: os.Getenv("SENDGRID_INBOUND_SECRET"),
		// Abuse caps. The MX is public and unauthenticated, so without
		// these a single source could open unlimited concurrent
		// connections or fire unlimited messages (DoS + unbounded inbound
		// storage). Tunable; 0 disables a given cap.
		MaxConnsPerIP:   envIntOrDefault("MAIL_MAX_CONNS_PER_IP", 10),
		MaxMsgsPerIPMin: envIntOrDefault("MAIL_MAX_MSGS_PER_IP_MIN", 30),
	}
	if c.WebhookURL == "" {
		return c, errors.New("MAIL_WEBHOOK_URL is required (e.g. http://api:3001/webhooks/sendgrid-inbound)")
	}
	if c.WebhookSecret == "" {
		return c, errors.New("SENDGRID_INBOUND_SECRET is required")
	}
	return c, nil
}

func envOrDefault(name, def string) string {
	if v := os.Getenv(name); v != "" {
		return v
	}
	return def
}

func envIntOrDefault(name string, def int) int {
	if v := os.Getenv(name); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			return n
		}
	}
	return def
}

// ─── SMTP backend ──────────────────────────────────────────────────────────

type ipMsgWindow struct {
	count       int
	windowStart time.Time
}

type Backend struct {
	domain          string
	relay           *relay.Client
	maxConnsPerIP   int
	maxMsgsPerIPMin int

	mu         sync.Mutex
	activeByIP map[string]int
	msgByIP    map[string]*ipMsgWindow
}

// remoteIP extracts the bare host from a connection's remote address,
// falling back to the raw string when it isn't host:port shaped.
func remoteIP(c *smtp.Conn) string {
	addr := c.Conn().RemoteAddr().String()
	if host, _, err := net.SplitHostPort(addr); err == nil {
		return host
	}
	return addr
}

// acquireConn enforces the per-IP concurrent-connection cap. Returns false
// when the IP is already at the cap; the caller rejects the session.
func (b *Backend) acquireConn(ip string) bool {
	if b.maxConnsPerIP <= 0 {
		return true
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.activeByIP[ip] >= b.maxConnsPerIP {
		return false
	}
	b.activeByIP[ip]++
	return true
}

func (b *Backend) releaseConn(ip string) {
	if b.maxConnsPerIP <= 0 {
		return
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	if n := b.activeByIP[ip]; n <= 1 {
		delete(b.activeByIP, ip)
	} else {
		b.activeByIP[ip] = n - 1
	}
}

// allowMessage enforces a per-IP fixed-window message rate. Returns false
// when the IP has exhausted its quota for the current minute.
func (b *Backend) allowMessage(ip string, now time.Time) bool {
	if b.maxMsgsPerIPMin <= 0 {
		return true
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	w := b.msgByIP[ip]
	if w == nil || now.Sub(w.windowStart) >= time.Minute {
		b.msgByIP[ip] = &ipMsgWindow{count: 1, windowStart: now}
		return true
	}
	if w.count >= b.maxMsgsPerIPMin {
		return false
	}
	w.count++
	return true
}

func (b *Backend) NewSession(c *smtp.Conn) (smtp.Session, error) {
	ip := remoteIP(c)
	if !b.acquireConn(ip) {
		log.Warn().Str("remote", ip).Int("max", b.maxConnsPerIP).
			Msg("rejecting connection — per-IP cap reached")
		return nil, &smtp.SMTPError{
			Code:         421,
			EnhancedCode: smtp.EnhancedCode{4, 7, 0},
			Message:      "too many concurrent connections, slow down",
		}
	}
	return &Session{
		backend: b,
		ip:      ip,
		domain:  b.domain,
		relay:   b.relay,
		log: log.With().
			Str("remote", ip).
			Logger(),
	}, nil
}

type Session struct {
	backend *Backend
	ip      string
	domain  string
	relay   *relay.Client
	log     zerolog.Logger

	from string
	to   []string
}

// No AuthMechanisms / Auth methods — go-smtp's AuthSession check sees
// us as auth-less and stops advertising AUTH on EHLO. We don't need
// auth on inbound (no sane mail server authenticates inbound senders).

func (s *Session) Mail(from string, opts *smtp.MailOptions) error {
	s.from = from
	s.log = s.log.With().Str("envelope_from", from).Logger()
	return nil
}

func (s *Session) Rcpt(to string, opts *smtp.RcptOptions) error {
	// Only accept mail for our domain — refuse to act as an open relay.
	if !strings.HasSuffix(strings.ToLower(to), "@"+strings.ToLower(s.domain)) {
		return &smtp.SMTPError{
			Code:         550,
			EnhancedCode: smtp.EnhancedCode{5, 7, 1},
			Message:      "not a recipient on this server",
		}
	}
	s.to = append(s.to, to)
	return nil
}

func (s *Session) Data(r io.Reader) error {
	// Per-IP message rate limit. Reject before buffering the body so a
	// flood can't make us read 8 MiB per message. 451 = temporary failure,
	// so a legitimate sender retries later.
	if !s.backend.allowMessage(s.ip, time.Now()) {
		s.log.Warn().Int("max", s.backend.maxMsgsPerIPMin).
			Msg("rejecting message — per-IP rate cap reached")
		return &smtp.SMTPError{
			Code:         451,
			EnhancedCode: smtp.EnhancedCode{4, 7, 0},
			Message:      "rate limit exceeded, please retry later",
		}
	}
	raw, err := io.ReadAll(io.LimitReader(r, 8*1024*1024))
	if err != nil {
		return &smtp.SMTPError{Code: 451, Message: "could not read data"}
	}
	if len(raw) == 0 {
		return &smtp.SMTPError{Code: 554, Message: "empty body"}
	}
	if err := s.relay.Forward(relay.Input{
		EnvelopeFrom: s.from,
		Recipients:   append([]string(nil), s.to...),
		Raw:          raw,
	}); err != nil {
		s.log.Error().Err(err).Msg("relay failed")
		// 451 = "temporary failure, retry later". Most senders will
		// retry every few minutes for up to 24-48h, which gives us a
		// long window to fix any webhook outage without losing mail.
		return &smtp.SMTPError{
			Code:         451,
			EnhancedCode: smtp.EnhancedCode{4, 7, 0},
			Message:      "transient relay failure, please retry",
		}
	}
	s.log.Info().
		Strs("rcpt", s.to).
		Int("bytes", len(raw)).
		Msg("relayed to webhook")
	return nil
}

func (s *Session) Reset() {
	s.from = ""
	s.to = nil
}

func (s *Session) Logout() error {
	s.backend.releaseConn(s.ip)
	return nil
}
