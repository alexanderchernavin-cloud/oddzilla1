// Oddin REST client. Used for:
//   - /users/whoami (bootstrap: customer_id for AMQP vhost)
//   - /v1/descriptions/en/fixtures (catalog prefetch in phase 3)
//   - /v1/descriptions/en/fixtures/{id}/odds/{product}/{after_ts} (recovery)
//   - /v1/descriptions/en/sports, /markets (descriptions)
//
// Rate-limit handling is deliberately simple for MVP: exponential backoff on
// 429/5xx, up to 5 retries, max 30 s total. Recovery endpoints have stricter
// tiers (see docs/ODDIN.md); callers must rate-limit themselves.

package oddinrest

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"time"
)

const (
	defaultTimeout = 15 * time.Second
	userAgent      = "oddzilla-feed-ingester/0.1"
)

// Config for a REST client instance.
type Config struct {
	BaseURL    string        // e.g. https://api-mq.integration.oddin.gg
	Token      string        // x-access-token header value
	Timeout    time.Duration // per-request; 0 → defaultTimeout
	MaxRetries int           // on 429/5xx; 0 → 5
}

// Client is a thin wrapper around http.Client with token auth and retries.
type Client struct {
	cfg     Config
	http    *http.Client
	baseURL *url.URL
}

func New(cfg Config) (*Client, error) {
	if cfg.BaseURL == "" {
		return nil, errors.New("oddinrest: BaseURL is required")
	}
	u, err := url.Parse(cfg.BaseURL)
	if err != nil {
		return nil, fmt.Errorf("oddinrest: parse BaseURL: %w", err)
	}
	if cfg.Timeout == 0 {
		cfg.Timeout = defaultTimeout
	}
	if cfg.MaxRetries == 0 {
		cfg.MaxRetries = 5
	}
	return &Client{
		cfg:     cfg,
		baseURL: u,
		http:    &http.Client{Timeout: cfg.Timeout},
	}, nil
}

// Get issues an HTTP GET and returns the body bytes on 2xx. Non-2xx returns
// an HTTPError with status + body. Retries on 429/5xx with exponential
// backoff.
func (c *Client) Get(ctx context.Context, path string, query url.Values) ([]byte, error) {
	u := *c.baseURL
	u.Path = joinURLPath(u.Path, path)
	if query != nil {
		u.RawQuery = query.Encode()
	}

	var backoff time.Duration = 500 * time.Millisecond
	var lastErr error
	for attempt := 0; attempt <= c.cfg.MaxRetries; attempt++ {
		if attempt > 0 {
			select {
			case <-ctx.Done():
				return nil, ctx.Err()
			case <-time.After(backoff):
			}
			backoff *= 2
			if backoff > 8*time.Second {
				backoff = 8 * time.Second
			}
		}

		req, err := http.NewRequestWithContext(ctx, http.MethodGet, u.String(), nil)
		if err != nil {
			return nil, fmt.Errorf("oddinrest: build request: %w", err)
		}
		req.Header.Set("x-access-token", c.cfg.Token)
		req.Header.Set("accept", "application/xml,text/xml;q=0.9,*/*;q=0.5")
		req.Header.Set("user-agent", userAgent)

		resp, err := c.http.Do(req)
		if err != nil {
			lastErr = fmt.Errorf("oddinrest: %s: %w", u.String(), err)
			continue
		}

		body, readErr := io.ReadAll(resp.Body)
		resp.Body.Close()
		if readErr != nil {
			lastErr = fmt.Errorf("oddinrest: read body: %w", readErr)
			continue
		}

		if resp.StatusCode >= 200 && resp.StatusCode < 300 {
			return body, nil
		}

		if resp.StatusCode == http.StatusTooManyRequests || resp.StatusCode >= 500 {
			lastErr = &HTTPError{Status: resp.StatusCode, Body: body, URL: u.String()}
			continue
		}

		// 4xx (not 429) — don't retry.
		return nil, &HTTPError{Status: resp.StatusCode, Body: body, URL: u.String()}
	}

	if lastErr == nil {
		lastErr = errors.New("oddinrest: exhausted retries")
	}
	return nil, lastErr
}

// SnapshotRecovery requests an odds snapshot for a given fixture since
// afterTs (ms). `product` is 1 (pre-match) or 2 (live). Returns raw XML the
// caller should feed back through the same handlers as live AMQP messages.
func (c *Client) SnapshotRecovery(ctx context.Context, lang, fixtureURN string, product int, afterTsMs int64) ([]byte, error) {
	path := fmt.Sprintf(
		"/v1/descriptions/%s/fixtures/%s/odds/%d/%d",
		lang, fixtureURN, product, afterTsMs,
	)
	return c.Get(ctx, path, nil)
}

// WhoAmI returns the customer_id needed to build the AMQP virtual host path.
// Parsed by the caller from the returned body (shape varies by Oddin env).
func (c *Client) WhoAmI(ctx context.Context) ([]byte, error) {
	return c.Get(ctx, "/users/whoami", nil)
}

// Fixtures returns the paginated fixtures list XML. offset+limit semantics
// per Oddin docs (max limit 200 in practice).
func (c *Client) Fixtures(ctx context.Context, lang string, offset, limit int) ([]byte, error) {
	q := url.Values{}
	q.Set("offset", fmt.Sprintf("%d", offset))
	q.Set("limit", fmt.Sprintf("%d", limit))
	return c.Get(ctx, fmt.Sprintf("/v1/descriptions/%s/fixtures", lang), q)
}

// SportEventFixture returns the full hierarchy (tournament + sport + teams)
// for a single match URN. Used by the auto-mapping resolver to build proper
// catalog rows when an unknown match URN arrives on the feed.
//   GET /v1/sports/{lang}/sport_events/{eventURN}/fixture
func (c *Client) SportEventFixture(ctx context.Context, lang, eventURN string) ([]byte, error) {
	path := fmt.Sprintf("/v1/sports/%s/sport_events/%s/fixture", lang, eventURN)
	return c.Get(ctx, path, nil)
}

// Sports lists every sport Oddin exposes. Used to refresh sport metadata
// after auto-creating one from a fixture (the fixture endpoint returns the
// sport's name + abbreviation, so this is mainly useful as a slug source for
// sports that arrive ahead of any fixture call).
//   GET /v1/sports/{lang}/sports
func (c *Client) Sports(ctx context.Context, lang string) ([]byte, error) {
	return c.Get(ctx, fmt.Sprintf("/v1/sports/%s/sports", lang), nil)
}

// IsNotFound returns true when the error is an HTTPError with status 404,
// which is what Oddin returns for unknown sport events / tournaments.
func IsNotFound(err error) bool {
	he, ok := err.(*HTTPError)
	return ok && he.Status == http.StatusNotFound
}

// post is a minimal POST helper used by InitiateRecovery. The recovery
// endpoint takes its parameters via query string and returns an XML body
// we mostly ignore (the actual recovery messages flow through AMQP).
func (c *Client) post(ctx context.Context, path string, query url.Values) ([]byte, error) {
	u := *c.baseURL
	u.Path = joinURLPath(u.Path, path)
	if query != nil {
		u.RawQuery = query.Encode()
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, u.String(), nil)
	if err != nil {
		return nil, fmt.Errorf("oddinrest: build request: %w", err)
	}
	req.Header.Set("x-access-token", c.cfg.Token)
	req.Header.Set("accept", "application/xml,text/xml;q=0.9,*/*;q=0.5")
	req.Header.Set("user-agent", userAgent)
	resp, err := c.http.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, fmt.Errorf("oddinrest: read body: %w", err)
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, &HTTPError{Status: resp.StatusCode, Body: body, URL: u.String()}
	}
	return body, nil
}

// InitiateRecovery requests Oddin to re-send all messages since the given
// timestamp through the AMQP feed. Per the Oddin docs the recovery window
// is bounded to 3 days; an after of 0 (or a timestamp older than 3 days)
// returns just the current snapshot for active matches. The flow:
//
//	POST /v1/{product}/recovery/initiate_request?after={ms}&request_id={id}&node_id={n}
//
// `productName` is "pre" (producer 1) or "live" (producer 2). The caller
// is responsible for picking a unique `requestID` and watching for the
// `snapshot_complete` AMQP message before re-opening markets.
func (c *Client) InitiateRecovery(ctx context.Context, productName string, afterMs int64, requestID, nodeID int) error {
	q := url.Values{}
	if afterMs > 0 {
		q.Set("after", fmt.Sprintf("%d", afterMs))
	}
	if requestID > 0 {
		q.Set("request_id", fmt.Sprintf("%d", requestID))
	}
	if nodeID > 0 {
		q.Set("node_id", fmt.Sprintf("%d", nodeID))
	}
	path := fmt.Sprintf("/v1/%s/recovery/initiate_request", productName)
	_, err := c.post(ctx, path, q)
	return err
}

// HTTPError is returned for any non-2xx response the client couldn't
// recover from.
type HTTPError struct {
	Status int
	Body   []byte
	URL    string
}

func (e *HTTPError) Error() string {
	return fmt.Sprintf("oddinrest: %d at %s: %s", e.Status, e.URL, string(e.Body))
}

func joinURLPath(base, suffix string) string {
	if base == "" {
		return suffix
	}
	if len(base) > 0 && base[len(base)-1] == '/' {
		base = base[:len(base)-1]
	}
	if len(suffix) == 0 || suffix[0] != '/' {
		return base + "/" + suffix
	}
	return base + suffix
}
