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

// DefaultLogoCDN is the static host every logo path hangs off. It follows
// the site: fon.bet serves them from cdn-ec.bk6bba-resources.com, fonbet.kz
// from cdn-cf.kzac51-resources.kz. Both carry the same paths, so a mismatch
// still resolves — the default just keeps the assets on the same estate as
// the line. Overridable via FONBET_LOGO_CDN.
const DefaultLogoCDN = "https://cdn-ec.bk6bba-resources.com"

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
		return resolveLogos(&resp, c.cfg.LogoCDN), nil
	}
	return nil, fmt.Errorf("line/logos: all hosts failed: %s", strings.Join(errs, "; "))
}

func resolveLogos(r *logosResponse, cdn string) *Logos {
	if cdn == "" {
		cdn = DefaultLogoCDN
	}
	cdn = strings.TrimSuffix(cdn, "/")
	out := &Logos{Teams: map[int64]string{}, Competitions: map[int]string{}, Sports: map[int]string{}}
	for teamID, logoID := range r.Teams {
		id, err := strconv.ParseInt(teamID, 10, 64)
		if err != nil || logoID == "none" {
			continue
		}
		if p := r.TeamLogos[logoID].path("logoMedium", "logoLarge", "logoSmall"); p != "" {
			out.Teams[id] = cdn + p
		}
	}
	for segID, logoID := range r.Competitions {
		id, err := strconv.Atoi(segID)
		if err != nil || logoID == "none" {
			continue
		}
		if p := r.CompetitionLogos[logoID].path("logoVector", "logoLargeVector", "logoLarge", "logoMedium"); p != "" {
			out.Competitions[id] = cdn + p
		}
	}
	for sportID, logoID := range r.SportKinds {
		id, err := strconv.Atoi(sportID) // "all-sports" and other synthetic keys are skipped
		if err != nil || logoID == "none" {
			continue
		}
		if p := r.SportKindLogos[logoID].path("logoColor2", "logoColor", "logoMonochromeBlack2", "logoMonochromeBlack"); p != "" {
			out.Sports[id] = cdn + p
		}
	}
	return out
}

// TournamentIcons is the SECOND place Fonbet keeps competition marks, and
// it is a different asset tree from the one line/logos serves: those paths
// sit under /Logotypes/CompetitionLogos/, these under /Logotypes/Tournament/.
// The data rides on every events/list snapshot (tournamentInfos, keyed by
// the segment node's tournamentInfoId), so reading it costs no extra
// request — hence a pure function over a response we already hold rather
// than a fetch of its own.
//
// Country flags are deliberately DROPPED. Fonbet has a real mark for only
// about half its leagues (measured 2026-09-05: 384 of 761 live segments)
// and falls back to the country flag for the rest — their own England
// Championship page draws /ContentCommon/NewFlags/Circle/England.svg. Our
// sidebar already carries that flag on the category header the tournament
// renders under, so importing it per row would stamp the same flag a dozen
// times inside one country bucket. A row with no real mark shows none; see
// TournamentLogoMark in apps/web/src/components/shell/sidebar.tsx, which
// holds the slot open so the names still line up.
func (c *Client) TournamentIcons(resp *ListResponse) map[int]string {
	if resp == nil {
		return nil
	}
	cdn := strings.TrimSuffix(c.cfg.LogoCDN, "/")
	if cdn == "" {
		cdn = DefaultLogoCDN
	}
	icons := make(map[int]string, len(resp.TournamentInfos))
	for _, t := range resp.TournamentInfos {
		if !strings.HasPrefix(t.Icon, "/") || isFlagPath(t.Icon) {
			continue
		}
		icons[t.ID] = cdn + t.Icon
	}
	if len(icons) == 0 {
		return nil
	}
	out := make(map[int]string)
	for _, s := range resp.Sports {
		if s.TournamentInfoID == nil {
			continue
		}
		if url, ok := icons[*s.TournamentInfoID]; ok {
			out[s.ID] = url
		}
	}
	return out
}

// isFlagPath reports whether a CDN path is one of Fonbet's country flags
// rather than a competition mark.
func isFlagPath(p string) bool {
	return strings.Contains(strings.ToLower(p), "/newflags/")
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
	c.setSiteHeaders(req)
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
