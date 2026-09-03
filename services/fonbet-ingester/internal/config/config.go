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
	// line API hosts (they rotate). Default https://fonbet.kz/urls.json.
	URLsJSON string
	// Hosts is the static fallback when urls.json is unreachable.
	Hosts []string
	// Lang is the catalogue / event language requested from Fonbet.
	// Sub-event labels (halves, maps, players) come back in this language
	// and are written to market_descriptions for both `Lang` and "en".
	Lang string
	// ScopeMarket is the Fonbet market scope. 1800 = Kazakhstan. The RU
	// site uses 1600; the KZ line servers 404 on it.
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
		Enabled:           strings.EqualFold(getEnvDefault("FONBET_ENABLED", "false"), "true"),
		URLsJSON:          getEnvDefault("FONBET_URLS_JSON", "https://fonbet.kz/urls.json"),
		Hosts:             splitList(getEnvDefault("FONBET_LINE_HOSTS", "https://line01-w.kzac51-resources.kz,https://line05-w.kzac51-resources.kz,https://line21-w.kzac51-resources.kz,https://line31-w.kzac51-resources.kz,https://line51-w.kzac51-resources.kz")),
		Lang:              getEnvDefault("FONBET_LANG", "ru"),
		ScopeMarket:       atoiDefault("FONBET_SCOPE_MARKET", 1800),
		PollInterval:      time.Duration(atoiDefault("FONBET_POLL_INTERVAL_MS", 5000)) * time.Millisecond,
		HTTPTimeout:       time.Duration(atoiDefault("FONBET_HTTP_TIMEOUT_MS", 30000)) * time.Millisecond,
		StaleSuspendAfter: time.Duration(atoiDefault("FONBET_STALE_SUSPEND_SECONDS", 60)) * time.Second,
		BlockedSportIDs:   parseIntSet(getEnvDefault("FONBET_BLOCKED_SPORT_IDS", "29086")),
		AllowedSportIDs:   parseIntSet(getEnvDefault("FONBET_ALLOWED_SPORT_IDS", "")),
		IncludeSubEvents:  !strings.EqualFold(getEnvDefault("FONBET_INCLUDE_SUB_EVENTS", "true"), "false"),
		MaxMatches:        atoiDefault("FONBET_MAX_MATCHES", 0),
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
