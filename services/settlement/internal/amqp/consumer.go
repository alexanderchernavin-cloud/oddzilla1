// AMQP consumer for the Oddin odds feed.
//
// Connection model (from Oddin docs + docs/ODDIN.md):
//   - AMQPS on port 5671 (TLS)
//   - virtual host: /oddinfeed/{customer_id}
//   - username = access token, password = ""
//   - consume from exchange `oddinfeed` (topic) via an exclusive
//     auto-delete queue with a topic binding
//
// The consumer auto-reconnects with exponential backoff. On each successful
// connect it invokes OnConnect so callers can trigger REST-based snapshot
// recovery using the amqp_state cursor.

package amqp

import (
	"context"
	"crypto/tls"
	"errors"
	"fmt"
	"net/url"
	"time"

	amqp "github.com/rabbitmq/amqp091-go"
	"github.com/rs/zerolog"
)

// Config controls connection + routing.
type Config struct {
	Host        string // e.g. mq.integration.oddin.gg
	Port        int    // 5671 (TLS) or 5672 (plain)
	TLS         bool
	Token       string // AMQP username
	CustomerID  string // drives vhost: /oddinfeed/{CustomerID}
	RoutingKey  string // binding key, e.g. "#"
	QueueName   string // usually empty → server-named
	Prefetch    int    // per-consumer QoS; 256 is a safe default
	Exchange    string // usually "oddinfeed"
	DialTimeout time.Duration
	Heartbeat   time.Duration
}

// Handler is invoked for each delivery. Return an error to cause nack +
// requeue; return nil to ack. The body is the raw XML payload.
type Handler func(ctx context.Context, routingKey string, body []byte) error

// OnConnect is called each time we successfully (re)open a channel. Use it
// to trigger snapshot recovery (REST) using amqp_state.after_ts.
type OnConnect func(ctx context.Context) error

// Consumer owns the connection loop. Call Run to block until ctx is done.
type Consumer struct {
	cfg       Config
	handler   Handler
	onConnect OnConnect
	log       zerolog.Logger
}

func New(cfg Config, handler Handler, onConnect OnConnect, log zerolog.Logger) *Consumer {
	if cfg.Prefetch == 0 {
		cfg.Prefetch = 256
	}
	if cfg.Exchange == "" {
		cfg.Exchange = "oddinfeed"
	}
	if cfg.RoutingKey == "" {
		cfg.RoutingKey = "#"
	}
	if cfg.DialTimeout == 0 {
		cfg.DialTimeout = 15 * time.Second
	}
	if cfg.Heartbeat == 0 {
		cfg.Heartbeat = 30 * time.Second
	}
	return &Consumer{
		cfg:       cfg,
		handler:   handler,
		onConnect: onConnect,
		log:       log.With().Str("component", "amqp").Logger(),
	}
}

// Run blocks until ctx is cancelled. It dials, consumes, and reconnects
// forever, with exponential backoff capped at 30 s.
func (c *Consumer) Run(ctx context.Context) error {
	var backoff = time.Second
	for {
		if err := ctx.Err(); err != nil {
			return err
		}
		err := c.runOnce(ctx)
		if err == nil || errors.Is(err, context.Canceled) {
			return nil
		}
		c.log.Warn().Err(err).Dur("backoff", backoff).Msg("amqp disconnected; reconnecting")
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(backoff):
		}
		backoff *= 2
		if backoff > 30*time.Second {
			backoff = 30 * time.Second
		}
	}
}

func (c *Consumer) runOnce(ctx context.Context) error {
	dialURL := c.dialURL()
	cfg := amqp.Config{
		Heartbeat: c.cfg.Heartbeat,
		Dial:      amqp.DefaultDial(c.cfg.DialTimeout),
	}
	if c.cfg.TLS {
		cfg.TLSClientConfig = &tls.Config{
			ServerName: c.cfg.Host,
			MinVersion: tls.VersionTLS12,
		}
	}

	conn, err := amqp.DialConfig(dialURL, cfg)
	if err != nil {
		return fmt.Errorf("dial: %w", err)
	}
	defer conn.Close()

	ch, err := conn.Channel()
	if err != nil {
		return fmt.Errorf("open channel: %w", err)
	}
	defer ch.Close()

	if err := ch.Qos(c.cfg.Prefetch, 0, false); err != nil {
		return fmt.Errorf("qos: %w", err)
	}

	q, err := ch.QueueDeclare(
		c.cfg.QueueName, // name ("" → server-named)
		false,           // durable
		true,            // auto-delete
		true,            // exclusive
		false,           // no-wait
		nil,             // args
	)
	if err != nil {
		return fmt.Errorf("queue declare: %w", err)
	}

	if err := ch.QueueBind(q.Name, c.cfg.RoutingKey, c.cfg.Exchange, false, nil); err != nil {
		return fmt.Errorf("queue bind: %w", err)
	}

	deliveries, err := ch.Consume(q.Name, "", false, true, false, false, nil)
	if err != nil {
		return fmt.Errorf("consume: %w", err)
	}

	c.log.Info().
		Str("host", c.cfg.Host).
		Int("port", c.cfg.Port).
		Str("queue", q.Name).
		Str("routing_key", c.cfg.RoutingKey).
		Msg("amqp connected")

	// Trigger snapshot recovery on each fresh connect.
	if c.onConnect != nil {
		if err := c.onConnect(ctx); err != nil {
			c.log.Warn().Err(err).Msg("onConnect (snapshot recovery) failed; continuing with live stream")
		}
	}

	closeCh := conn.NotifyClose(make(chan *amqp.Error, 1))

	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case cerr := <-closeCh:
			if cerr == nil {
				return errors.New("amqp: connection closed")
			}
			return fmt.Errorf("amqp close: %w", cerr)
		case d, ok := <-deliveries:
			if !ok {
				return errors.New("amqp: deliveries channel closed")
			}
			if err := c.handler(ctx, d.RoutingKey, d.Body); err != nil {
				c.log.Error().Err(err).Str("rk", d.RoutingKey).Msg("handler error; nack+requeue")
				_ = d.Nack(false, true)
				continue
			}
			if err := d.Ack(false); err != nil {
				c.log.Warn().Err(err).Msg("ack failed")
			}
		}
	}
}

func (c *Consumer) dialURL() string {
	scheme := "amqp"
	if c.cfg.TLS {
		scheme = "amqps"
	}
	// Oddin vhost: "/oddinfeed/{customer_id}" — the leading slash is part
	// of the vhost NAME, not just a URL separator. We assemble the URL
	// string by hand because net/url's URL.Path field re-escapes any "%"
	// characters when it serializes — so writing PathEscape(vhost) into
	// Path produces "%252F..." not "%2F..." and amqp091-go then sees a
	// vhost with literal "%2F" substrings, which the broker rejects with
	// "no access to this vhost".
	vhost := "/oddinfeed/" + c.cfg.CustomerID
	return fmt.Sprintf("%s://%s:@%s:%d/%s",
		scheme,
		url.QueryEscape(c.cfg.Token),
		c.cfg.Host,
		c.cfg.Port,
		url.QueryEscape(vhost),
	)
}
