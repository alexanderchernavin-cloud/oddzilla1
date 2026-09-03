// Logo catalogue: POST <line>/line/logos with {"teams":"actual",
// "competitions":"actual","sportKinds":"actual"} returns every logo Fonbet
// currently uses — team crests (PNG), competition marks (PNG + SVG) and
// sport glyphs (several monochrome / colour SVG variants). Paths are
// relative to the static CDN. Reverse-engineered from the site's `Logos`
// store (chunk 85037 of build 2.9.63).

package fonbet

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"
)

// LogoCDN is the static host every logo path hangs off.
const LogoCDN = "https://cdn-cf.kzac51-resources.kz"

// Logos is the resolved logo map: Fonbet entity id → absolute URL.
type Logos struct {
	Teams        map[int64]string // team id → crest (logoMedium)
	Competitions map[int]string   // segment id → mark (SVG preferred, PNG fallback)
	Sports       map[int]string   // root sport id → colour glyph (SVG)
}

type logosResponse struct {
	Result           string               `json:"result"`
	Teams            map[string]string    `json:"teams"`
	Competitions     map[string]string    `json:"competitions"`
	SportKinds       map[string]string    `json:"sportKinds"`
	TeamLogos        map[string]logoEntry `json:"teamLogos"`
	CompetitionLogos map[string]logoEntry `json:"competitionLogos"`
	SportKindLogos   map[string]logoEntry `json:"sportKindLogos"`
}

type logoEntry struct {
	Object map[string]any `json:"object"`
}

func (e logoEntry) path(keys ...string) string {
	for _, k := range keys {
		if v, ok := e.Object[k].(string); ok && strings.HasPrefix(v, "/") {
			return v
		}
	}
	return ""
}

// FetchLogos downloads the full current logo catalogue.
func (c *Client) FetchLogos(ctx context.Context) (*Logos, error) {
	hosts := c.Hosts()
	if len(hosts) == 0 {
		return nil, errors.New("no line hosts configured")
	}
	var errs []string
	for range hosts {
		host := c.Hosts()[0]
		body, err := c.postJSON(ctx, host+"/line/logos", map[string]any{
			"lang": c.cfg.Lang, "sysId": hostNum(host),
			"teams": "actual", "competitions": "actual", "sportKinds": "actual",
		})
		if err != nil {
			if ctx.Err() != nil {
				return nil, ctx.Err()
			}
			errs = append(errs, host+": "+err.Error())
			c.rotate(host)
			continue
		}
		var resp logosResponse
		if err := json.Unmarshal(body, &resp); err != nil {
			return nil, fmt.Errorf("line/logos decode: %w", err)
		}
		return resolveLogos(&resp), nil
	}
	return nil, fmt.Errorf("line/logos: all hosts failed: %s", strings.Join(errs, "; "))
}

func resolveLogos(r *logosResponse) *Logos {
	out := &Logos{Teams: map[int64]string{}, Competitions: map[int]string{}, Sports: map[int]string{}}
	for teamID, logoID := range r.Teams {
		id, err := strconv.ParseInt(teamID, 10, 64)
		if err != nil || logoID == "none" {
			continue
		}
		if p := r.TeamLogos[logoID].path("logoMedium", "logoLarge", "logoSmall"); p != "" {
			out.Teams[id] = LogoCDN + p
		}
	}
	for segID, logoID := range r.Competitions {
		id, err := strconv.Atoi(segID)
		if err != nil || logoID == "none" {
			continue
		}
		if p := r.CompetitionLogos[logoID].path("logoVector", "logoLargeVector", "logoLarge", "logoMedium"); p != "" {
			out.Competitions[id] = LogoCDN + p
		}
	}
	for sportID, logoID := range r.SportKinds {
		id, err := strconv.Atoi(sportID) // "all-sports" and other synthetic keys are skipped
		if err != nil || logoID == "none" {
			continue
		}
		if p := r.SportKindLogos[logoID].path("logoColor2", "logoColor", "logoMonochromeBlack2", "logoMonochromeBlack"); p != "" {
			out.Sports[id] = LogoCDN + p
		}
	}
	return out
}

func (c *Client) postJSON(ctx context.Context, u string, payload any) ([]byte, error) {
	body, err := json.Marshal(payload)
	if err != nil {
		return nil, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, u, bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent", userAgent)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json, text/plain, */*")
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
