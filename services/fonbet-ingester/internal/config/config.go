// Env parsing for fonbet-ingester. Fail-fast on the two required vars
// (DATABASE_URL, REDIS_URL); everything Fonbet-specific has a default so
// the service boots without any extra configuration. FONBET_ENABLED=false
// (the default) keeps the service in graceful-idle mode: it connects to
// Postgres + Redis, serves /healthz and does nothing else. Flip it on
// once the operator is happy with the market mapping on a dev stack.

package config

import (
	"fmt"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/oddzilla/fonbet-ingester/internal/fonbet"
)

type Config struct {
	ServiceName string
	LogLevel    string

	DatabaseURL string
	RedisURL    string

	HealthPort string

	Fonbet FonbetConfig
}

type FonbetConfig struct {
	// Enabled gates the poll loop. Default false — see package doc.
	Enabled bool

	// URLsJSON is the public bootstrap document that lists the current
	// line API hosts (they rotate). Default https://fon.bet/urls.json.
	URLsJSON string
	// Hosts is the static fallback when urls.json is unreachable.
	Hosts []string
	// SiteOrigin is the site the line belongs to; it rides on every
	// request as Origin / Referer, and the hosts 403 without it.
	SiteOrigin string
	// LogoCDN is the static host the logo paths hang off (follows the
	// site).
	LogoCDN string
	// Lang is the catalogue / event language requested from Fonbet.
	// Sub-event labels (halves, maps, players) and every team / tournament
	// name come back in this language. It is pinned to "en": the settlement
	// grader reads the same text and carries an English vocabulary only —
	// Load refuses anything else — see docs/FONBET.md "Settlement". Market
	// descriptions are additionally written in the other storefront locales
	// (descriptionLangs in main.go); that is display data and never reaches
	// the grader.
	Lang string
	// ScopeMarket is the Fonbet market scope, and it is paired with the
	// site: fon.bet answers 1600, fonbet.kz answers 1800 and 404s on 1600.
	ScopeMarket int

	// PollInterval is how often the full line snapshot is refetched.
	PollInterval time.Duration
	// HTTPTimeout bounds one request (the snapshot is ~1 MB gzipped).
	HTTPTimeout time.Duration
	// StaleSuspendAfter: when no snapshot has been fetched successfully for
	// this long, every active Fonbet market is suspended (status=-1) so the
	// storefront stops quoting frozen odds. <=0 disables the watchdog.
	StaleSuspendAfter time.Duration

	// BlockedSportIDs are Fonbet root sport ids that are never ingested.
	// Default blocks 29086 (esports) because Oddin already supplies that
	// vertical and two providers for the same match would double-list it.
	BlockedSportIDs map[int]struct{}
	// AllowedSportIDs, when non-empty, restricts ingestion to these root
	// sport ids (applied after the blocklist). Empty = every sport.
	AllowedSportIDs map[int]struct{}

	// IncludeSubEvents controls whether halves / maps / corners / player
	// props (Fonbet level 2 and 3 events) are ingested as extra markets on
	// the parent match. Default true.
	IncludeSubEvents bool

	// MaxMatches caps the number of level-1 events ingested per snapshot
	// (soonest first, live first). 0 = unlimited. Useful on small boxes.
	MaxMatches int

	// SettleEnabled runs the results-based settlement worker (grades
	// closed matches from Fonbet's results feed and hands them to
	// services/settlement over the settlement.external stream). Default
	// FALSE, independently of FONBET_ENABLED: the worker moves real money
	// through the same apply-once path as Oddin settlements, and the
	// grading rules must be soaked against Fonbet's own results on a
	// staging stack before an operator switches it on. With the feed on
	// and this off, Fonbet markets stay open for manual settlement.
	SettleEnabled bool
	// OddsPublisherGroup is odds-publisher's consumer group on odds.raw
	// (same env var, same default as odds-publisher). The ingester reads
	// its lag to apply backpressure during a cold-start republish instead
	// of relying on a larger stream cap.
	OddsPublisherGroup string
	// SettleInterval is how often closed matches are checked against the
	// results feed.
	SettleInterval time.Duration
	// CommonHosts is the static fallback for the clientsapi hosts the
	// results feed lives on (urls.json `common` overrides it).
	CommonHosts []string
}

func Load() (Config, error) {
	cfg := Config{
		ServiceName: getEnvDefault("SERVICE_NAME", "fonbet-ingester"),
		LogLevel:    getEnvDefault("LOG_LEVEL", "info"),
		HealthPort:  getEnvDefault("HEALTH_PORT", "8087"),
	}

	cfg.DatabaseURL = os.Getenv("DATABASE_URL")
	if cfg.DatabaseURL == "" {
		return cfg, fmt.Errorf("DATABASE_URL is required")
	}
	cfg.RedisURL = os.Getenv("REDIS_URL")
	if cfg.RedisURL == "" {
		return cfg, fmt.Errorf("REDIS_URL is required")
	}

	cfg.Fonbet = FonbetConfig{
		Enabled:            strings.EqualFold(getEnvDefault("FONBET_ENABLED", "false"), "true"),
		URLsJSON:           getEnvDefault("FONBET_URLS_JSON", "https://fon.bet/urls.json"),
		Hosts:              splitList(getEnvDefault("FONBET_LINE_HOSTS", "https://line-lb51.bk6bba-resources.com,https://line-lb52.bk6bba-resources.ru,https://line-vk-w.bk6bba-resources.ru")),
		SiteOrigin:         getEnvDefault("FONBET_SITE_ORIGIN", fonbet.DefaultSiteOrigin),
		LogoCDN:            getEnvDefault("FONBET_LOGO_CDN", fonbet.DefaultLogoCDN),
		Lang:               getEnvDefault("FONBET_LANG", "en"),
		ScopeMarket:        atoiDefault("FONBET_SCOPE_MARKET", 1600),
		PollInterval:       time.Duration(atoiDefault("FONBET_POLL_INTERVAL_MS", 5000)) * time.Millisecond,
		HTTPTimeout:        time.Duration(atoiDefault("FONBET_HTTP_TIMEOUT_MS", 30000)) * time.Millisecond,
		StaleSuspendAfter:  time.Duration(atoiDefault("FONBET_STALE_SUSPEND_SECONDS", 60)) * time.Second,
		BlockedSportIDs:    parseIntSet(getEnvDefault("FONBET_BLOCKED_SPORT_IDS", "29086")),
		AllowedSportIDs:    parseIntSet(getEnvDefault("FONBET_ALLOWED_SPORT_IDS", "")),
		IncludeSubEvents:   !strings.EqualFold(getEnvDefault("FONBET_INCLUDE_SUB_EVENTS", "true"), "false"),
		MaxMatches:         atoiDefault("FONBET_MAX_MATCHES", 0),
		SettleEnabled:      strings.EqualFold(getEnvDefault("FONBET_SETTLE_ENABLED", "false"), "true"),
		SettleInterval:     time.Duration(atoiDefault("FONBET_SETTLE_INTERVAL_MS", 120000)) * time.Millisecond,
		OddsPublisherGroup: getEnvDefault("ODDS_PUBLISHER_GROUP", "odds-publisher"),
		CommonHosts:        splitList(getEnvDefault("FONBET_COMMON_HOSTS", "https://clientsapi-lb51.bk6bba-resources.com,https://clientsapi-lb52.bk6bba-resources.ru,https://clientsapi-vk-w.bk6bba-resources.ru")),
	}
	// The settlement grader reads Fonbet's own text — table names, sub-event
	// labels, results-feed statistic rows — and carries an English vocabulary
	// only (the Russian one that served the fonbet.kz era was removed on
	// 2026-09-06). Any other feed language would leave it unable to
	// recognise the shapes it must grade or refuse, so it is a startup error
	// rather than a silent degradation.
	if !strings.EqualFold(cfg.Fonbet.Lang, "en") {
		return cfg, fmt.Errorf("FONBET_LANG must be \"en\" (got %q): the settlement grader understands English only", cfg.Fonbet.Lang)
	}
	cfg.Fonbet.Lang = "en"
	if cfg.Fonbet.SettleInterval < 10*time.Second {
		cfg.Fonbet.SettleInterval = 10 * time.Second
	}
	if cfg.Fonbet.PollInterval < time.Second {
		cfg.Fonbet.PollInterval = time.Second
	}
	return cfg, nil
}

// parseIntSet accepts a comma-separated list of integers. "*" or "" yields
// nil (no filter).
func parseIntSet(raw string) map[int]struct{} {
	raw = strings.TrimSpace(raw)
	if raw == "" || raw == "*" {
		return nil
	}
	out := make(map[int]struct{})
	for _, p := range strings.Split(raw, ",") {
		p = strings.TrimSpace(p)
		if p == "" {
			continue
		}
		if n, err := strconv.Atoi(p); err == nil {
			out[n] = struct{}{}
		}
	}
	if len(out) == 0 {
		return nil
	}
	return out
}

func splitList(raw string) []string {
	var out []string
	for _, p := range strings.Split(raw, ",") {
		p = strings.TrimSpace(p)
		if p != "" {
			out = append(out, p)
		}
	}
	return out
}

func getEnvDefault(key, fallback string) string {
	if v, ok := os.LookupEnv(key); ok && v != "" {
		return v
	}
	return fallback
}

func atoiDefault(key string, fallback int) int {
	if v, ok := os.LookupEnv(key); ok && v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			return n
		}
	}
	return fallback
}
