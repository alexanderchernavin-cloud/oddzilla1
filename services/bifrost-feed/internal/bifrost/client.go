// HTTP GraphQL client. One POST per operation; auth is the brand key in
// X-Api-Key plus the browser-shaped headers Bifrost's own front end sends
// (X-Locale drives names, x-sbi is a per-session browser id it expects to
// exist, Origin must be a host the key is registered for).

package bifrost

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"time"

	"github.com/rs/zerolog"
)

// ErrUnauthorized is returned when Bifrost rejects the key (401 / 403).
// The runner treats it as non-retryable within a connection cycle so a
// revoked key logs loudly instead of spinning.
var ErrUnauthorized = errors.New("bifrost: key rejected")

type Client struct {
	url     string
	apiKey  string
	locale  string
	origin  string
	sbi     string
	http    *http.Client
	log     zerolog.Logger
	maxBody int64
}

type ClientConfig struct {
	URL    string
	APIKey string
	Locale string
	Origin string
}

func NewClient(cfg ClientConfig, log zerolog.Logger) *Client {
	return &Client{
		url:    cfg.URL,
		apiKey: cfg.APIKey,
		locale: cfg.Locale,
		origin: cfg.Origin,
		sbi:    newSessionID(),
		http: &http.Client{
			Timeout: 30 * time.Second,
		},
		log:     log.With().Str("component", "bifrost-http").Logger(),
		maxBody: 32 << 20, // a 184-market match is ~150 KB; 32 MiB is a hard stop
	}
}

// Headers returns the header set Bifrost expects on both HTTP and the
// WebSocket connection_init payload.
func (c *Client) Headers() map[string]string {
	return map[string]string{
		"X-Api-Key":            c.apiKey,
		"X-Locale":             c.locale,
		"x-sbi":                c.sbi,
		"X-Display-Resolution": "1280x720",
	}
}

func (c *Client) APIKey() string { return c.apiKey }
func (c *Client) Origin() string { return c.origin }

type gqlRequest struct {
	OperationName string         `json:"operationName"`
	Query         string         `json:"query"`
	Variables     map[string]any `json:"variables,omitempty"`
}

type gqlError struct {
	Message string `json:"message"`
}

type gqlResponse struct {
	Data   json.RawMessage `json:"data"`
	Errors []gqlError      `json:"errors"`
}

// Query runs one operation and returns the raw `data` object. GraphQL
// errors with a null data object are returned as errors; partial data
// with errors is returned with the errors logged (Bifrost answers a
// malformed date filter that way).
func (c *Client) Query(ctx context.Context, operationName, query string, variables map[string]any) (json.RawMessage, error) {
	body, err := json.Marshal(gqlRequest{OperationName: operationName, Query: query, Variables: variables})
	if err != nil {
		return nil, fmt.Errorf("marshal %s: %w", operationName, err)
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.url, bytes.NewReader(body))
	if err != nil {
		return nil, fmt.Errorf("build request %s: %w", operationName, err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json")
	req.Header.Set("Origin", c.origin)
	req.Header.Set("Referer", c.origin+"/")
	req.Header.Set("User-Agent", "oddzilla-bifrost-feed/1.0")
	for k, v := range c.Headers() {
		req.Header.Set(k, v)
	}
	resp, err := c.http.Do(req)
	if err != nil {
		return nil, fmt.Errorf("%s: %w", operationName, err)
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(resp.Body, c.maxBody))
	if err != nil {
		return nil, fmt.Errorf("%s: read body: %w", operationName, err)
	}
	switch {
	case resp.StatusCode == http.StatusUnauthorized || resp.StatusCode == http.StatusForbidden:
		return nil, fmt.Errorf("%s: HTTP %d: %w", operationName, resp.StatusCode, ErrUnauthorized)
	case resp.StatusCode >= 500:
		return nil, fmt.Errorf("%s: HTTP %d (transient)", operationName, resp.StatusCode)
	case resp.StatusCode != http.StatusOK:
		return nil, fmt.Errorf("%s: HTTP %d: %s", operationName, resp.StatusCode, truncate(raw, 300))
	}
	var parsed gqlResponse
	if err := json.Unmarshal(raw, &parsed); err != nil {
		return nil, fmt.Errorf("%s: decode: %w", operationName, err)
	}
	if len(parsed.Errors) > 0 {
		if len(parsed.Data) == 0 || string(parsed.Data) == "null" {
			return nil, fmt.Errorf("%s: graphql error: %s", operationName, parsed.Errors[0].Message)
		}
		c.log.Warn().Str("op", operationName).Str("error", parsed.Errors[0].Message).Msg("graphql partial errors; using data")
	}
	return parsed.Data, nil
}

// MatchRef is one row of the timeline listing.
type MatchRef struct {
	ID               string
	State            string
	DatePlannedStart string
}

// ListMatches pages allMatch until exhaustion. historic=false is the
// active offer (NOT_STARTED + STARTED plus matches that closed minutes
// ago); historic=true with a date window is the results list.
func (c *Client) ListMatches(ctx context.Context, historic bool, dateFrom, dateTo string) ([]MatchRef, error) {
	var out []MatchRef
	var after *string
	for page := 0; page < 200; page++ {
		vars := map[string]any{
			"first":     50,
			"sportType": "ESPORTS",
			"historic":  historic,
			"sort":      "DATE",
		}
		if after != nil {
			vars["after"] = *after
		}
		if dateFrom != "" {
			vars["dateFrom"] = dateFrom
		}
		if dateTo != "" {
			vars["dateTo"] = dateTo
		}
		data, err := c.Query(ctx, "allMatch", QueryAllMatch, vars)
		if err != nil {
			return out, err
		}
		var parsed struct {
			AllMatch struct {
				Edges []struct {
					Node struct {
						ID               string `json:"id"`
						State            string `json:"state"`
						DatePlannedStart string `json:"datePlannedStart"`
					} `json:"node"`
				} `json:"edges"`
				PageInfo struct {
					HasNextPage bool   `json:"hasNextPage"`
					EndCursor   string `json:"endCursor"`
				} `json:"pageInfo"`
			} `json:"allMatch"`
		}
		if err := json.Unmarshal(data, &parsed); err != nil {
			return out, fmt.Errorf("allMatch: decode: %w", err)
		}
		for _, e := range parsed.AllMatch.Edges {
			out = append(out, MatchRef{ID: e.Node.ID, State: e.Node.State, DatePlannedStart: e.Node.DatePlannedStart})
		}
		if !parsed.AllMatch.PageInfo.HasNextPage || parsed.AllMatch.PageInfo.EndCursor == "" {
			break
		}
		cursor := parsed.AllMatch.PageInfo.EndCursor
		after = &cursor
	}
	return out, nil
}

// FetchMatch loads the full detail for one match. Tries the active view
// first and falls back to the historic one, which is what Bifrost's own
// front end does when it does not know the state up front.
// FetchMatch reads one match detail. It asks the live view first and the
// historic view second, and prefers whichever answer actually carries
// markets.
//
// The market check is load-bearing, not a nicety. Once a match finishes,
// Bifrost still answers `historic: false` with a real object — correct id,
// state CLOSED — but an EMPTY marketGroups list; every settled market is
// only reachable through `historic: true` (measured 2026-09-03 on three
// finished CS2 matches: 0 markets live vs 532-607 CLOSED markets historic,
// all outcomes WON/LOST). Returning on the first non-nil result therefore
// handed the settlement sweep a market-less snapshot, SettleCandidates
// found nothing, and the sweep logged `matches_settled: 0` on every pass
// while its fetch list grew without bound. Those matches stayed `live` in
// our catalogue with no prices on the storefront.
func (c *Client) FetchMatch(ctx context.Context, id string) (*Match, error) {
	var fallback *Match
	for _, historic := range []bool{false, true} {
		data, err := c.Query(ctx, "match", QueryMatch, map[string]any{"matchId": id, "historic": historic})
		if err != nil {
			return nil, err
		}
		var parsed struct {
			Match *Match `json:"match"`
		}
		if err := json.Unmarshal(data, &parsed); err != nil {
			return nil, fmt.Errorf("match: decode: %w", err)
		}
		if parsed.Match == nil {
			continue
		}
		if len(parsed.Match.MarketGroups) > 0 || len(parsed.Match.MainMarketGroups) > 0 {
			return parsed.Match, nil
		}
		// Keep the market-less answer only as a last resort: callers that
		// just want lifecycle state still get something to read.
		if fallback == nil {
			fallback = parsed.Match
		}
	}
	return fallback, nil
}

func truncate(b []byte, n int) string {
	if len(b) <= n {
		return string(b)
	}
	return string(b[:n]) + "..."
}
