// Env parsing for slotzilla. Fail-fast on the two required vars
// (DATABASE_URL, REDIS_URL); everything else has a default so the service
// boots with no extra configuration. SLOTZILLA_DISABLED=true keeps the
// process in graceful-idle mode: it connects to Postgres + Redis, serves
// /healthz and writes the status hash, and nothing else. The runtime
// switch is slotzilla_config.enabled in Postgres (set from
// /admin/slotzilla), which the engine re-reads every 5 s.

package config

import (
	"fmt"
	"os"
	"strconv"
	"strings"
	"time"
)

// DefaultStatsBase is Sportradar's open statistics host (the same host the
// Sportradar mapping sweeper in the api reads). No credential; the feed
// 403s a non-browser User-Agent, which the client supplies.
const DefaultStatsBase = "https://stats.fn.sportradar.com/betradar/en/Etc:UTC/gismo"

type Config struct {
	ServiceName string
	LogLevel    string

	DatabaseURL string
	RedisURL    string

	HealthPort string

	// Disabled parks the service on health + status only, whatever the
	// database switch says.
	Disabled bool

	// PollInterval is the per-game delta fetch cadence (the delta document
	// caches for 3 s upstream, so faster buys nothing).
	PollInterval time.Duration
	// ReconcileInterval is how often the FULL timeline is refetched per
	// game to pick up scout corrections (updated_uts, disabled).
	ReconcileInterval time.Duration
	// StatsBase is the Sportradar gismo base URL.
	StatsBase string
	// HTTPTimeout bounds one feed request.
	HTTPTimeout time.Duration
	// MaxConcurrentFetches bounds how many games are polled at once inside
	// one tick.
	MaxConcurrentFetches int
}

func Load() (Config, error) {
	cfg := Config{
		ServiceName:          getEnvDefault("SERVICE_NAME", "slotzilla"),
		LogLevel:             getEnvDefault("LOG_LEVEL", "info"),
		HealthPort:           getEnvDefault("HEALTH_PORT", "8088"),
		Disabled:             strings.EqualFold(getEnvDefault("SLOTZILLA_DISABLED", "false"), "true"),
		PollInterval:         time.Duration(atoiDefault("SLOTZILLA_POLL_INTERVAL_MS", 3000)) * time.Millisecond,
		ReconcileInterval:    time.Duration(atoiDefault("SLOTZILLA_RECONCILE_INTERVAL_MS", 60000)) * time.Millisecond,
		StatsBase:            strings.TrimRight(getEnvDefault("SLOTZILLA_STATS_BASE", DefaultStatsBase), "/"),
		HTTPTimeout:          time.Duration(atoiDefault("SLOTZILLA_HTTP_TIMEOUT_MS", 10000)) * time.Millisecond,
		MaxConcurrentFetches: atoiDefault("SLOTZILLA_MAX_CONCURRENT_FETCHES", 8),
	}

	cfg.DatabaseURL = os.Getenv("DATABASE_URL")
	if cfg.DatabaseURL == "" {
		return cfg, fmt.Errorf("DATABASE_URL is required")
	}
	cfg.RedisURL = os.Getenv("REDIS_URL")
	if cfg.RedisURL == "" {
		return cfg, fmt.Errorf("REDIS_URL is required")
	}
	if cfg.PollInterval < time.Second {
		cfg.PollInterval = time.Second
	}
	if cfg.ReconcileInterval < 10*time.Second {
		cfg.ReconcileInterval = 10 * time.Second
	}
	if cfg.HTTPTimeout < time.Second {
		cfg.HTTPTimeout = time.Second
	}
	if cfg.MaxConcurrentFetches < 1 {
		cfg.MaxConcurrentFetches = 1
	}
	return cfg, nil
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
