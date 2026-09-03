// Bifrost fixture fallback for the auto-mapper.
//
// When Oddin's REST meta API is unreachable, ResolveMatch used to create
// every unknown match as a placeholder under the `unclassified` sport. The
// backup feed (services/bifrost-feed) keeps odds flowing in that scenario,
// so the mapper needs a second source of fixture metadata: Bifrost's
// `match` query carries the same sport → tournament → competitors →
// start-time hierarchy, and every id in it is base64 of an Oddin URN. This
// client asks Bifrost and reshapes the answer into the exact
// oddinxml.FixtureResponse the REST path produces, so the rest of the
// resolver does not know which source answered.
//
// Same brand key, headers and endpoint as services/bifrost-feed; the two
// are deliberately not a shared module (one Go module per service).

package bifrost

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/oddzilla/feed-ingester/internal/oddinxml"
)

// ErrNotFound is returned when Bifrost knows no match with that URN (both
// the active and historic views answered null).
var ErrNotFound = errors.New("bifrost: match not found")

type Config struct {
	URL    string
	APIKey string
	Locale string
	Origin string
}

type Client struct {
	cfg  Config
	http *http.Client
}

func New(cfg Config) *Client {
	return &Client{cfg: cfg, http: &http.Client{Timeout: 20 * time.Second}}
}

const matchQuery = `query match($matchId: ID!, $historic: Boolean!) {
  match(id: $matchId, historic: $historic) {
    id datePlannedStart state
    teams { team { id name icon } }
    tournament { id name sport { id name } }
    allStreams { url locale name }
  }
}`

type matchPayload struct {
	Data struct {
		Match *struct {
			ID               string `json:"id"`
			DatePlannedStart string `json:"datePlannedStart"`
			State            string `json:"state"`
			Teams            []struct {
				Team struct {
					ID   string `json:"id"`
					Name string `json:"name"`
					Icon string `json:"icon"`
				} `json:"team"`
			} `json:"teams"`
			Tournament *struct {
				ID    string `json:"id"`
				Name  string `json:"name"`
				Sport *struct {
					ID   string `json:"id"`
					Name string `json:"name"`
				} `json:"sport"`
			} `json:"tournament"`
			AllStreams []struct {
				URL    string `json:"url"`
				Locale string `json:"locale"`
				Name   string `json:"name"`
			} `json:"allStreams"`
		} `json:"match"`
	} `json:"data"`
	Errors []struct {
		Message string `json:"message"`
	} `json:"errors"`
}

// TeamIcon is the competitor icon Bifrost carries, offered to the
// resolver so competitor_profiles can be seeded without the REST profile
// endpoint.
type TeamIcon struct {
	URN  string
	Name string
	Icon string
}

// Fixture returns the fixture shaped like the REST endpoint would, plus
// the team icons. Tries the active view first and then the historic one.
func (c *Client) Fixture(ctx context.Context, matchURN string) (*oddinxml.FixtureResponse, []TeamIcon, error) {
	id := base64.StdEncoding.EncodeToString([]byte("match/" + matchURN))
	for _, historic := range []bool{false, true} {
		p, err := c.query(ctx, id, historic)
		if err != nil {
			return nil, nil, err
		}
		if p.Data.Match == nil {
			continue
		}
		m := p.Data.Match
		fx := &oddinxml.FixtureResponse{}
		fx.Fixture.ID = matchURN
		fx.Fixture.Scheduled = m.DatePlannedStart
		fx.Fixture.StartTime = m.DatePlannedStart
		fx.Fixture.Status = mapState(m.State)
		if m.Tournament != nil {
			fx.Fixture.Tournament.ID = urnOf(m.Tournament.ID)
			fx.Fixture.Tournament.Name = m.Tournament.Name
			if m.Tournament.Sport != nil {
				fx.Fixture.Tournament.Sport.ID = urnOf(m.Tournament.Sport.ID)
				fx.Fixture.Tournament.Sport.Name = m.Tournament.Sport.Name
				// Oddin's REST abbreviation is what the resolver slugifies
				// for new sports and matches against the sport blocklist.
				// Bifrost has no abbreviation; the name with spaces removed
				// reproduces the common cases ("eFootball Bots" ->
				// "eFootballBots" -> slug "efootballbots").
				fx.Fixture.Tournament.Sport.Abbr = strings.ReplaceAll(m.Tournament.Sport.Name, " ", "")
			}
		}
		var icons []TeamIcon
		for i, t := range m.Teams {
			qualifier := "home"
			if i == 1 {
				qualifier = "away"
			}
			if i > 1 {
				break
			}
			urn := urnOf(t.Team.ID)
			fx.Fixture.Competitors.Competitors = append(fx.Fixture.Competitors.Competitors, oddinxml.FixtureCompetitor{
				ID:        urn,
				Name:      t.Team.Name,
				Qualifier: qualifier,
			})
			if urn != "" {
				icons = append(icons, TeamIcon{URN: urn, Name: t.Team.Name, Icon: t.Team.Icon})
			}
		}
		for _, s := range m.AllStreams {
			if strings.TrimSpace(s.URL) == "" {
				continue
			}
			fx.Fixture.TvChannels.Channels = append(fx.Fixture.TvChannels.Channels, oddinxml.FixtureTvChannel{
				Name:      s.Name,
				Language:  strings.ToLower(s.Locale),
				StreamURL: s.URL,
			})
		}
		return fx, icons, nil
	}
	return nil, nil, ErrNotFound
}

func (c *Client) query(ctx context.Context, id string, historic bool) (*matchPayload, error) {
	body, _ := json.Marshal(map[string]any{
		"operationName": "match",
		"query":         matchQuery,
		"variables":     map[string]any{"matchId": id, "historic": historic},
	})
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.cfg.URL, bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json")
	req.Header.Set("Origin", c.cfg.Origin)
	req.Header.Set("Referer", c.cfg.Origin+"/")
	req.Header.Set("User-Agent", "oddzilla-feed-ingester/1.0")
	req.Header.Set("X-Api-Key", c.cfg.APIKey)
	req.Header.Set("X-Locale", c.cfg.Locale)
	req.Header.Set("x-sbi", "feed-ingester-fixture-fallback")
	resp, err := c.http.Do(req)
	if err != nil {
		return nil, fmt.Errorf("bifrost match: %w", err)
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(resp.Body, 4<<20))
	if err != nil {
		return nil, fmt.Errorf("bifrost match: read: %w", err)
	}
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("bifrost match: HTTP %d", resp.StatusCode)
	}
	var p matchPayload
	if err := json.Unmarshal(raw, &p); err != nil {
		return nil, fmt.Errorf("bifrost match: decode: %w", err)
	}
	if p.Data.Match == nil && len(p.Errors) > 0 {
		return nil, fmt.Errorf("bifrost match: %s", p.Errors[0].Message)
	}
	return &p, nil
}

// mapState translates Bifrost match states onto the fixture status words
// automap.mapFixtureStatus already understands.
func mapState(s string) string {
	switch s {
	case "NOT_STARTED":
		return "not_started"
	case "STARTED":
		return "live"
	case "CLOSED":
		return "closed"
	}
	return ""
}

func urnOf(id string) string {
	raw, err := base64.StdEncoding.DecodeString(id)
	if err != nil {
		raw, err = base64.RawStdEncoding.DecodeString(id)
		if err != nil {
			return ""
		}
	}
	parts := strings.SplitN(string(raw), "/", 3)
	if len(parts) < 2 {
		return ""
	}
	return parts[1]
}
