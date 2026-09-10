// HTTP client for Sportradar's open statistics host. No credential — the
// host answers ordinary server-to-server requests — but it 403s a bare
// client, so every request carries a browser-shaped User-Agent (the same
// one services/api/src/lib/sportradar/fixture-source.ts sends).
//
// Endpoints:
//
//	GET <base>/match_timelinedelta/<srMatchId>   last ~8 events, _maxage 3 s
//	GET <base>/match_timeline/<srMatchId>        full event list, _maxage 20 s

package sportradar

import (
	"bytes"
	"compress/gzip"
	"context"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"time"

	"github.com/rs/zerolog"
)

const (
	userAgent = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36"
	// maxResponseBytes caps a decoded body. A full timeline of a long game
	// is a few hundred KB; 16 MiB leaves headroom without letting a
	// misbehaving upstream exhaust the 128 MiB container.
	maxResponseBytes = 16 << 20
)

type Client struct {
	base string
	http *http.Client
	log  zerolog.Logger
}

func New(base string, timeout time.Duration, log zerolog.Logger) *Client {
	if timeout <= 0 {
		timeout = 10 * time.Second
	}
	return &Client{
		base: base,
		http: &http.Client{Timeout: timeout},
		log:  log.With().Str("component", "sportradar-client").Logger(),
	}
}

// TimelineDelta fetches the last few events plus the match block.
func (c *Client) TimelineDelta(ctx context.Context, srMatchID int64) (*Timeline, error) {
	return c.fetch(ctx, "match_timelinedelta/"+strconv.FormatInt(srMatchID, 10))
}

// Timeline fetches the full event list plus the match block.
func (c *Client) Timeline(ctx context.Context, srMatchID int64) (*Timeline, error) {
	return c.fetch(ctx, "match_timeline/"+strconv.FormatInt(srMatchID, 10))
}

func (c *Client) fetch(ctx context.Context, path string) (*Timeline, error) {
	body, err := c.get(ctx, path)
	if err != nil {
		return nil, err
	}
	t, err := Parse(body)
	if err != nil {
		return nil, fmt.Errorf("%s: %w", path, err)
	}
	return t, nil
}

func (c *Client) get(ctx context.Context, path string) ([]byte, error) {
	url := c.base + "/" + path
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, fmt.Errorf("build request %s: %w", path, err)
	}
	req.Header.Set("User-Agent", userAgent)
	req.Header.Set("Accept", "application/json, text/plain, */*")
	req.Header.Set("Accept-Language", "en-US,en;q=0.9")
	resp, err := c.http.Do(req)
	if err != nil {
		return nil, fmt.Errorf("GET %s: %w", path, err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("GET %s: http %d", path, resp.StatusCode)
	}
	raw, err := io.ReadAll(io.LimitReader(resp.Body, maxResponseBytes+1))
	if err != nil {
		return nil, fmt.Errorf("read %s: %w", path, err)
	}
	if len(raw) > maxResponseBytes {
		return nil, fmt.Errorf("read %s: body over %d bytes", path, maxResponseBytes)
	}
	// net/http decompresses transparently only when it added the
	// Accept-Encoding header itself; sniff the gzip magic in case the host
	// compresses regardless.
	if len(raw) >= 2 && raw[0] == 0x1f && raw[1] == 0x8b {
		zr, err := gzip.NewReader(bytes.NewReader(raw))
		if err != nil {
			return nil, fmt.Errorf("gunzip %s: %w", path, err)
		}
		defer zr.Close()
		raw, err = io.ReadAll(io.LimitReader(zr, maxResponseBytes+1))
		if err != nil {
			return nil, fmt.Errorf("gunzip read %s: %w", path, err)
		}
		if len(raw) > maxResponseBytes {
			return nil, fmt.Errorf("gunzip %s: body over %d bytes", path, maxResponseBytes)
		}
	}
	return raw, nil
}
