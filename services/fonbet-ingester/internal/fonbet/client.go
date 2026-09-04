// HTTP client for the Fonbet KZ line API. No credentials — the line is
// public. Hosts rotate, so we bootstrap them from urls.json and fall back
// to a static list; a failing host is moved to the back of the queue.
//
// Endpoints (verified 2026-09-03, see docs/FONBET.md):
//   GET https://fonbet.kz/urls.json                       host discovery
//   GET <line>/events/list?lang=ru&version=0&scopeMarket=1800   full snapshot
//   GET <line>/line/factorsCatalog/tables?version=0&lang=ru&sysId=NN
//
// Responses are gzip-encoded even when not requested, so the body is
// sniffed for the gzip magic before decoding.

package fonbet

import (
	"bytes"
	"compress/gzip"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/rs/zerolog"
)

const (
	// maxResponseBytes caps a decoded body. The full KZ line is ~1.2 MB
	// decoded; 64 MiB leaves headroom without letting a misbehaving
	// upstream exhaust memory.
	maxResponseBytes = 64 << 20
	userAgent        = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/128 Safari/537.36 oddzilla-fonbet-ingester"
)

type Config struct {
	URLsJSON    string
	Hosts       []string // line hosts fallback
	CommonHosts []string // clientsapi hosts fallback (results feed)
	Lang        string
	ScopeMarket int
	Timeout     time.Duration
}

type Client struct {
	cfg  Config
	http *http.Client
	log  zerolog.Logger

	// trusted is the set of registrable domains (last two labels) of the
	// operator-configured hosts. Hosts discovered from urls.json are only
	// adopted when they sit under one of these — see normalizeHosts.
	trusted map[string]struct{}

	mu     sync.Mutex
	hosts  []string
	common []string
}

var hostNumRe = regexp.MustCompile(`line(\d+)`)

func New(cfg Config, log zerolog.Logger) *Client {
	if cfg.Timeout <= 0 {
		cfg.Timeout = 30 * time.Second
	}
	return &Client{
		cfg:     cfg,
		http:    &http.Client{Timeout: cfg.Timeout},
		log:     log.With().Str("component", "fonbet-client").Logger(),
		trusted: trustedSuffixes(cfg.Hosts, cfg.CommonHosts, []string{cfg.URLsJSON}),
		hosts:   append([]string(nil), cfg.Hosts...),
		common:  append([]string(nil), cfg.CommonHosts...),
	}
}

// Hosts returns the current line host queue (first = preferred).
func (c *Client) Hosts() []string {
	c.mu.Lock()
	defer c.mu.Unlock()
	return append([]string(nil), c.hosts...)
}

// CommonHosts returns the clientsapi hosts (results feed).
func (c *Client) CommonHosts() []string {
	c.mu.Lock()
	defer c.mu.Unlock()
	return append([]string(nil), c.common...)
}

// normalizeHosts turns the host strings from urls.json into base URLs we
// are willing to fetch odds and results from. Accepted: `https://host` or
// the scheme-relative `//host` form, on a registrable domain that one of
// the OPERATOR-configured hosts (FONBET_LINE_HOSTS / FONBET_COMMON_HOSTS /
// FONBET_URLS_JSON) also uses. Everything else is returned in `skipped`:
// an http:// host (silent downgrade to plaintext for a feed we pay out
// against), any other scheme, or a domain we were never told about. The
// list is served by a third party over the network — a compromised or
// spoofed urls.json must not be able to point this process at an arbitrary
// origin, nor at internal addresses.
func normalizeHosts(in []string, trusted map[string]struct{}) (ok, skipped []string) {
	for _, raw := range in {
		h := strings.TrimSpace(raw)
		if h == "" {
			continue
		}
		if strings.HasPrefix(h, "//") {
			h = "https:" + h
		}
		u, err := url.Parse(h)
		if err != nil || u.Scheme != "https" || u.Hostname() == "" || u.User != nil {
			skipped = append(skipped, raw)
			continue
		}
		if _, known := trusted[registrableDomain(u.Hostname())]; !known {
			skipped = append(skipped, raw)
			continue
		}
		ok = append(ok, "https://"+u.Host)
	}
	return ok, skipped
}

// trustedSuffixes collects the registrable domains of the configured URLs.
func trustedSuffixes(lists ...[]string) map[string]struct{} {
	out := map[string]struct{}{}
	for _, list := range lists {
		for _, raw := range list {
			raw = strings.TrimSpace(raw)
			if raw == "" {
				continue
			}
			if strings.HasPrefix(raw, "//") {
				raw = "https:" + raw
			}
			u, err := url.Parse(raw)
			if err != nil || u.Hostname() == "" {
				continue
			}
			if d := registrableDomain(u.Hostname()); d != "" {
				out[d] = struct{}{}
			}
		}
	}
	return out
}

// registrableDomain is the last two DNS labels, lower-cased
// ("line05-w.kzac51-resources.kz" → "kzac51-resources.kz"). Good enough
// for the ccTLD-free domains Fonbet uses; an IP literal or a bare label
// yields "" and is therefore never trusted.
func registrableDomain(host string) string {
	host = strings.ToLower(strings.TrimSuffix(host, "."))
	if net.ParseIP(host) != nil {
		return ""
	}
	labels := strings.Split(host, ".")
	if len(labels) < 2 {
		return ""
	}
	return strings.Join(labels[len(labels)-2:], ".")
}

// DiscoverHosts refreshes the line host list from urls.json. Failure is
// non-fatal: the static fallback list stays in place.
func (c *Client) DiscoverHosts(ctx context.Context) error {
	if c.cfg.URLsJSON == "" {
		return nil
	}
	body, err := c.getURL(ctx, c.cfg.URLsJSON)
	if err != nil {
		return fmt.Errorf("urls.json: %w", err)
	}
	var doc struct {
		Line   []string `json:"line"`
		Common []string `json:"common"`
	}
	if err := json.Unmarshal(body, &doc); err != nil {
		return fmt.Errorf("urls.json decode: %w", err)
	}
	hosts, skippedLine := normalizeHosts(doc.Line, c.trusted)
	common, skippedCommon := normalizeHosts(doc.Common, c.trusted)
	if skipped := append(skippedLine, skippedCommon...); len(skipped) > 0 {
		// Not an error: the static lists stay authoritative. Loud, because
		// a legitimate Fonbet domain move shows up here first and needs
		// FONBET_LINE_HOSTS / FONBET_COMMON_HOSTS updated by hand.
		c.log.Warn().Strs("skipped", skipped).Msg("urls.json listed hosts outside the trusted domains or not https; ignored")
	}
	if len(hosts) == 0 {
		return errors.New("urls.json: no acceptable line hosts (see skipped)")
	}
	c.mu.Lock()
	c.hosts = hosts
	if len(common) > 0 {
		c.common = common
	}
	c.mu.Unlock()
	c.log.Info().Strs("hosts", hosts).Strs("common", common).Msg("line hosts discovered")
	return nil
}

// FetchList downloads the full line snapshot.
func (c *Client) FetchList(ctx context.Context) (*ListResponse, error) {
	q := url.Values{}
	q.Set("lang", c.cfg.Lang)
	q.Set("version", "0")
	q.Set("scopeMarket", strconv.Itoa(c.cfg.ScopeMarket))
	body, _, err := c.getLine(ctx, "/events/list", q)
	if err != nil {
		return nil, err
	}
	var out ListResponse
	if err := json.Unmarshal(body, &out); err != nil {
		return nil, fmt.Errorf("events/list decode: %w", err)
	}
	if len(out.Sports) == 0 {
		return nil, errors.New("events/list: empty sports array (wrong scopeMarket?)")
	}
	return &out, nil
}

// FetchCatalog downloads the factor catalogue (market layouts + labels)
// for one language.
func (c *Client) FetchCatalog(ctx context.Context, lang string) (*Catalog, error) {
	q := url.Values{}
	q.Set("version", "0")
	q.Set("lang", lang)
	// sysId (= the line host number) is filled in by getLine per host.
	body, _, err := c.getLine(ctx, "/line/factorsCatalog/tables", q)
	if err != nil {
		return nil, err
	}
	var out Catalog
	if err := json.Unmarshal(body, &out); err != nil {
		return nil, fmt.Errorf("factorsCatalog decode: %w", err)
	}
	if len(out.Groups) == 0 {
		return nil, errors.New("factorsCatalog: empty groups")
	}
	return &out, nil
}

// getLine tries each host in queue order; a host that errors is rotated to
// the back. Returns the body and the host that served it.
func (c *Client) getLine(ctx context.Context, path string, q url.Values) ([]byte, string, error) {
	hosts := c.Hosts()
	if len(hosts) == 0 {
		return nil, "", errors.New("no line hosts configured")
	}
	var errs []string
	for range hosts {
		host := c.Hosts()[0]
		if strings.Contains(path, "factorsCatalog") && q.Get("sysId") == "" {
			q.Set("sysId", strconv.Itoa(hostNum(host)))
		}
		body, err := c.getURL(ctx, host+path+"?"+q.Encode())
		if err == nil {
			return body, host, nil
		}
		if ctx.Err() != nil {
			return nil, "", ctx.Err()
		}
		errs = append(errs, host+": "+err.Error())
		c.rotate(host)
		q.Del("sysId")
	}
	return nil, "", fmt.Errorf("all line hosts failed: %s", strings.Join(errs, "; "))
}

func (c *Client) rotate(dead string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if len(c.hosts) < 2 || c.hosts[0] != dead {
		return
	}
	c.hosts = append(c.hosts[1:], c.hosts[0])
	c.log.Warn().Str("host", dead).Str("next", c.hosts[0]).Msg("line host rotated")
}

func (c *Client) getURL(ctx context.Context, u string) ([]byte, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent", userAgent)
	req.Header.Set("Accept", "application/json, text/plain, */*")
	req.Header.Set("Accept-Encoding", "gzip")
	req.Header.Set("Origin", "https://fonbet.kz")
	req.Header.Set("Referer", "https://fonbet.kz/")
	resp, err := c.http.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, &HTTPError{Status: resp.StatusCode, URL: u}
	}
	raw, err := io.ReadAll(io.LimitReader(resp.Body, maxResponseBytes+1))
	if err != nil {
		return nil, fmt.Errorf("read body: %w", err)
	}
	return decodeBody(raw, resp.Header.Get("Content-Encoding"))
}

// decodeBody enforces the size cap and transparently gunzips (the line
// servers gzip even when not asked).
func decodeBody(raw []byte, contentEncoding string) ([]byte, error) {
	if len(raw) > maxResponseBytes {
		return nil, fmt.Errorf("response exceeds %d bytes", maxResponseBytes)
	}
	if strings.EqualFold(contentEncoding, "gzip") || (len(raw) > 2 && raw[0] == 0x1f && raw[1] == 0x8b) {
		zr, err := gzip.NewReader(bytes.NewReader(raw))
		if err != nil {
			return nil, fmt.Errorf("gzip: %w", err)
		}
		defer zr.Close()
		raw, err = io.ReadAll(io.LimitReader(zr, maxResponseBytes+1))
		if err != nil {
			return nil, fmt.Errorf("gunzip: %w", err)
		}
		if len(raw) > maxResponseBytes {
			return nil, fmt.Errorf("decoded response exceeds %d bytes", maxResponseBytes)
		}
	}
	return raw, nil
}

// HTTPError is a non-200 upstream answer.
type HTTPError struct {
	Status int
	URL    string
}

func (e *HTTPError) Error() string {
	return fmt.Sprintf("http %d from %s", e.Status, e.URL)
}

func hostNum(host string) int {
	m := hostNumRe.FindStringSubmatch(host)
	if len(m) != 2 {
		return 1
	}
	n, _ := strconv.Atoi(m[1])
	if n == 0 {
		return 1
	}
	return n
}
