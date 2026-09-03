// Results feed: GET <common>/results/results.json.php?locale=ru&lineDate=YYYY-MM-DD
// on the `common` (clientsapi) hosts from urls.json. One document per line
// day: every finished / cancelled event of that day with its final score
// and per-period breakdown, grouped into sections keyed by the same
// competition (segment) ids the line uses.
//
// Observed shape (2026-09-03):
//
//	events[]   {id:"1", name:"Оренбург – Рубин", score:"1:1 (0-1 1-0)",
//	            startTime:1788354900, status:3, comment1..3, goalOrder}
//	           status 3 = finished, 4 = cancelled / not played ("0:0")
//	sections[] {id, events:[1,2,3,...], fonbetSportId:1, fonbetCompetitionId:58540, name}
//
// Within a section the events are ordered: a match ("A – B") followed by
// its statistic rows ("угловые", "желтые карты", "эйсы",
// "дополнительное время", "серия пенальти", ...) sharing its startTime.
// Ids are local to the results document — they are NOT line event ids.

package fonbet

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"regexp"
	"strconv"
	"strings"
)

type ResultsResponse struct {
	Events    []ResultEvent   `json:"events"`
	Sections  []ResultSection `json:"sections"`
	IsArchive bool            `json:"isArchive"`
	Lang      string          `json:"lang"`
}

type ResultEvent struct {
	ID        json.Number `json:"id"`
	Name      string      `json:"name"`
	Score     string      `json:"score"`
	StartTime int64       `json:"startTime"`
	Status    int         `json:"status"`
	Comment1  string      `json:"comment1"`
	Comment2  string      `json:"comment2"`
	Comment3  string      `json:"comment3"`
}

type ResultSection struct {
	ID                  int    `json:"id"`
	Events              []int  `json:"events"`
	FonbetSportID       int    `json:"fonbetSportId"`
	FonbetCompetitionID int    `json:"fonbetCompetitionId"`
	Name                string `json:"name"`
}

const (
	ResultFinished  = 3
	ResultCancelled = 4
)

// FetchResults downloads the results document for one line date
// (YYYY-MM-DD). Rotates through the common hosts on failure.
func (c *Client) FetchResults(ctx context.Context, date string) (*ResultsResponse, error) {
	hosts := c.CommonHosts()
	if len(hosts) == 0 {
		return nil, errors.New("no common hosts configured")
	}
	q := url.Values{}
	q.Set("locale", c.cfg.Lang)
	q.Set("lineDate", date)
	var errs []string
	for _, host := range hosts {
		body, err := c.getURL(ctx, host+"/results/results.json.php?"+q.Encode())
		if err != nil {
			if ctx.Err() != nil {
				return nil, ctx.Err()
			}
			errs = append(errs, host+": "+err.Error())
			continue
		}
		var out ResultsResponse
		if err := json.Unmarshal(body, &out); err != nil {
			return nil, fmt.Errorf("results decode: %w", err)
		}
		return &out, nil
	}
	return nil, fmt.Errorf("results: all common hosts failed: %s", strings.Join(errs, "; "))
}

// Score is a parsed "H:A (p1h-p1a p2h-p2a ...)" string.
type Score struct {
	Home, Away int
	Periods    [][2]int
}

var (
	scoreHeadRe   = regexp.MustCompile(`^\s*(\d+)\s*:\s*(\d+)`)
	scorePeriodRe = regexp.MustCompile(`(\d+)\s*-\s*(\d+)`)
)

// ParseScore decodes Fonbet's score text. Returns ok=false for anything
// that is not "H:A" at the start (walkovers, text-only results).
func ParseScore(s string) (Score, bool) {
	m := scoreHeadRe.FindStringSubmatch(s)
	if m == nil {
		return Score{}, false
	}
	h, _ := strconv.Atoi(m[1])
	a, _ := strconv.Atoi(m[2])
	sc := Score{Home: h, Away: a}
	if i := strings.IndexByte(s, '('); i >= 0 {
		for _, pm := range scorePeriodRe.FindAllStringSubmatch(s[i:], -1) {
			ph, _ := strconv.Atoi(pm[1])
			pa, _ := strconv.Atoi(pm[2])
			sc.Periods = append(sc.Periods, [2]int{ph, pa})
		}
	}
	return sc, true
}

// IsMatchName reports whether a results row is a match ("A – B") rather
// than a statistic row ("угловые").
func IsMatchName(name string) bool {
	return strings.Contains(name, " – ") || strings.Contains(name, " - ") || strings.Contains(name, " — ")
}

// NormalizeMatchName collapses whitespace and dash variants so a line
// event ("team1", "team2") and a results row ("team1 – team2") compare
// equal.
func NormalizeMatchName(s string) string {
	s = strings.ReplaceAll(s, " — ", " – ")
	s = strings.ReplaceAll(s, " - ", " – ")
	return strings.ToLower(strings.Join(strings.Fields(s), " "))
}
