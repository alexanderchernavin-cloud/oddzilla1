// Package oddinrest is the settlement service's minimal Oddin REST
// client — it only exposes what settlement needs (recovery initiation
// on AMQP reconnect). Per the per-service-Go-module convention
// (CLAUDE.md), it duplicates the recovery shape rather than sharing a
// module with feed-ingester.
//
// The single endpoint we hit:
//
//   POST /v1/{product}/recovery/initiate_request?after={ms}&request_id={id}
//
// Oddin replays every message in (after, now] to all queues bound to
// the oddinfeed exchange — that includes our settlement queue, so any
// in-flight bet_settlement / bet_cancel / rollback_* that we missed
// (e.g. across a worker restart) is re-delivered.

package oddinrest

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// Client wraps an HTTP client + auth token. Construct via New; safe for
// concurrent use.
type Client struct {
	baseURL string
	token   string
	http    *http.Client
}

func New(baseURL, token string) *Client {
	return &Client{
		baseURL: strings.TrimRight(baseURL, "/"),
		token:   token,
		http: &http.Client{
			Timeout: 15 * time.Second,
		},
	}
}

// HTTPError carries the non-2xx response so callers can decide whether
// the failure is transient (5xx) or terminal (4xx).
type HTTPError struct {
	Status int
	Body   []byte
	URL    string
}

func (e *HTTPError) Error() string {
	return fmt.Sprintf("oddinrest: %s -> %d %s", e.URL, e.Status, string(e.Body))
}

// InitiateRecovery asks Oddin to re-emit every message in the (afterMs,
// now] window for the given product to every queue bound to the
// oddinfeed exchange. `productName` is "pre" (producer 1) or "live"
// (producer 2). afterMs=0 yields a current-state snapshot only.
//
// Recovery requests are throttled by Oddin: 20 per 10 min and 60 per
// hour in the lenient tier (cursor within 24 h). Beyond that the
// caller pays a stricter limit. Settlement only fires recovery on
// reconnect, which is rare, so we stay safely under the cap.
func (c *Client) InitiateRecovery(ctx context.Context, productName string, afterMs int64, requestID int) error {
	q := url.Values{}
	if afterMs > 0 {
		q.Set("after", fmt.Sprintf("%d", afterMs))
	}
	if requestID > 0 {
		q.Set("request_id", fmt.Sprintf("%d", requestID))
	}
	path := fmt.Sprintf("/v1/%s/recovery/initiate_request", productName)
	u := c.baseURL + path
	if q.Encode() != "" {
		u += "?" + q.Encode()
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, u, nil)
	if err != nil {
		return fmt.Errorf("oddinrest: build request: %w", err)
	}
	req.Header.Set("x-access-token", c.token)

	resp, err := c.http.Do(req)
	if err != nil {
		return fmt.Errorf("oddinrest: post: %w", err)
	}
	defer func() { _ = resp.Body.Close() }()
	body, _ := io.ReadAll(resp.Body)
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return &HTTPError{Status: resp.StatusCode, Body: body, URL: u}
	}
	return nil
}
