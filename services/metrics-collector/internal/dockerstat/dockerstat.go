// Package dockerstat reads container state from the Docker Engine API
// over the host's Unix socket.
//
// The collector uses only the read-only listing endpoint
// (`GET /containers/json?all=1`); per-container CPU/mem stats are not
// requested in v1 because the Docker Engine API streams cumulative
// counters that need delta tracking, and the per-container costs add
// O(N) syscalls per /snapshot. The list endpoint already exposes
// State (running / restarting / paused / exited) and Status (the
// "Up 2 hours (healthy)" string), which is what powers the
// container-health table on the admin page.

package dockerstat

import (
	"context"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"regexp"
	"sort"
	"strings"
	"time"
)

const (
	// Default path mirrors the docker-compose.yml bind mount. Override
	// only for unit tests against a mock socket.
	DockerSocketPath = "/var/run/docker.sock"

	// Docker Engine API call timeout. /containers/json is fast (low ms
	// even on busy hosts); cap aggressively so a hung dockerd can't
	// stall /snapshot.
	dockerTimeout = 3 * time.Second
)

// Container is the merged view returned to the API. Health is parsed
// out of Status because /containers/json doesn't return the structured
// Health field — it's only on /containers/<id>/json, which would be N
// extra round-trips.
type Container struct {
	Name      string `json:"name"`
	Image     string `json:"image"`
	State     string `json:"state"`     // running / restarting / paused / exited / dead / created
	Status    string `json:"status"`    // human string from docker ps
	Health    string `json:"health"`    // healthy / unhealthy / starting / none
	CreatedAt int64  `json:"createdAt"` // unix seconds
}

// Client wraps an HTTP client that dials the docker.sock Unix socket.
type Client struct {
	http       *http.Client
	socketPath string
}

func NewClient(socketPath string) *Client {
	if socketPath == "" {
		socketPath = DockerSocketPath
	}
	transport := &http.Transport{
		DialContext: func(ctx context.Context, network, addr string) (net.Conn, error) {
			return (&net.Dialer{Timeout: dockerTimeout}).DialContext(ctx, "unix", socketPath)
		},
	}
	return &Client{
		http:       &http.Client{Transport: transport, Timeout: dockerTimeout},
		socketPath: socketPath,
	}
}

// rawContainer is the subset of /containers/json we care about. Field
// names (capitalized) follow the Docker Engine API JSON shape.
type rawContainer struct {
	ID      string   `json:"Id"`
	Names   []string `json:"Names"`
	Image   string   `json:"Image"`
	State   string   `json:"State"`
	Status  string   `json:"Status"`
	Created int64    `json:"Created"`
	Labels  map[string]string `json:"Labels"`
}

func (c *Client) ListContainers(ctx context.Context) ([]Container, error) {
	// Host portion of the URL is unused — the dialer goes to the Unix
	// socket regardless — but the http client requires *something*.
	req, err := http.NewRequestWithContext(ctx, http.MethodGet,
		"http://docker/containers/json?all=1", nil)
	if err != nil {
		return nil, err
	}
	resp, err := c.http.Do(req)
	if err != nil {
		return nil, fmt.Errorf("docker socket: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("docker engine returned %d", resp.StatusCode)
	}
	var raws []rawContainer
	if err := json.NewDecoder(resp.Body).Decode(&raws); err != nil {
		return nil, fmt.Errorf("decode: %w", err)
	}
	out := make([]Container, 0, len(raws))
	for _, r := range raws {
		out = append(out, Container{
			Name:      pickName(r.Names),
			Image:     trimImageDigest(r.Image),
			State:     r.State,
			Status:    r.Status,
			Health:    parseHealth(r.Status),
			CreatedAt: r.Created,
		})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	return out, nil
}

// pickName returns the first /-prefixed name with the slash stripped.
// Docker's API gives names like "/oddzilla-postgres-1"; the leading /
// is a relic of the legacy linking syntax.
func pickName(names []string) string {
	if len(names) == 0 {
		return ""
	}
	n := names[0]
	return strings.TrimPrefix(n, "/")
}

// trimImageDigest strips an `@sha256:...` suffix from image refs so the
// admin UI shows `postgres:16-alpine` instead of the long pinned form.
// Tags are kept; only the digest is dropped.
func trimImageDigest(image string) string {
	if i := strings.Index(image, "@"); i > 0 {
		return image[:i]
	}
	return image
}

// healthRe extracts the `(healthy)` / `(unhealthy)` / `(starting)`
// suffix Docker appends to Status when the container has a healthcheck.
var healthRe = regexp.MustCompile(`\((healthy|unhealthy|starting|health: starting)\)`)

func parseHealth(status string) string {
	m := healthRe.FindStringSubmatch(status)
	if m == nil {
		return "none"
	}
	if m[1] == "health: starting" {
		return "starting"
	}
	return m[1]
}
