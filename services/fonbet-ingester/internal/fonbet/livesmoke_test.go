//go:build livesmoke

// Live end-to-end smoke against the configured Fonbet line, using the
// real client + config defaults and no database. Run with:
//
//	go test -tags livesmoke ./internal/fonbet/ -run TestLiveSmoke -v
package fonbet

import (
	"context"
	"os"
	"testing"
	"time"

	"github.com/rs/zerolog"
)

func TestLiveSmoke(t *testing.T) {
	log := zerolog.New(os.Stdout)
	c := New(Config{
		URLsJSON:    "https://fon.bet/urls.json",
		Hosts:       []string{"https://line-lb51.bk6bba-resources.com", "https://line-lb52.bk6bba-resources.ru", "https://line-vk-w.bk6bba-resources.ru"},
		CommonHosts: []string{"https://clientsapi-lb51.bk6bba-resources.com", "https://clientsapi-lb52.bk6bba-resources.ru", "https://clientsapi-vk-w.bk6bba-resources.ru"},
		Lang:        "en",
		ScopeMarket: 1600,
		Timeout:     45 * time.Second,
	}, log)

	ctx, cancel := context.WithTimeout(context.Background(), 4*time.Minute)
	defer cancel()

	if err := c.DiscoverHosts(ctx); err != nil {
		t.Fatalf("DiscoverHosts: %v", err)
	}
	t.Logf("line hosts: %v", c.Hosts())
	t.Logf("common hosts: %v", c.CommonHosts())

	list, err := c.FetchList(ctx)
	if err != nil {
		t.Fatalf("FetchList: %v", err)
	}
	t.Logf("snapshot: sports=%d events=%d customFactors=%d", len(list.Sports), len(list.Events), len(list.CustomFactors))
	for i, s := range list.Sports {
		if s.ParentID == nil {
			t.Logf("  root sport %d %q", s.ID, s.Name)
		}
		if i > 60 {
			break
		}
	}

	cat, err := c.FetchCatalog(ctx, "en")
	if err != nil {
		t.Fatalf("FetchCatalog(en): %v", err)
	}
	idx := BuildIndex(cat)
	t.Logf("catalogue en: groups=%d tables=%d factors=%d", len(cat.Groups), len(idx.Tables), len(idx.Factors))

	catRU, err := c.FetchCatalog(ctx, "ru")
	if err != nil {
		t.Fatalf("FetchCatalog(ru): %v", err)
	}
	t.Logf("catalogue ru: tables=%d", len(BuildIndex(catRU).Tables))

	logos, err := c.FetchLogos(ctx)
	if err != nil {
		t.Fatalf("FetchLogos: %v", err)
	}
	t.Logf("logos: teams=%d competitions=%d sports=%d", len(logos.Teams), len(logos.Competitions), len(logos.Sports))
	for id, u := range logos.Teams {
		t.Logf("  sample team logo %d -> %s", id, u)
		break
	}

	// Fonbet files a results document per UTC+3 calendar day.
	day := time.Now().In(time.FixedZone("UTC+3", 3*3600)).AddDate(0, 0, -1).Format("2006-01-02")
	res, err := c.FetchResults(ctx, day)
	if err != nil {
		t.Fatalf("FetchResults(%s): %v", day, err)
	}
	t.Logf("results %s: lang=%q events=%d sections=%d", day, res.Lang, len(res.Events), len(res.Sections))
}
