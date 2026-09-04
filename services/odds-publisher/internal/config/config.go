// Env parsing for odds-publisher.

package config

import (
	"fmt"
	"os"
	"strconv"
	"time"
)

type Config struct {
	ServiceName string
	LogLevel    string

	DatabaseURL string
	RedisURL    string
	HealthPort  string

	// Consumer group name. Multiple odds-publisher replicas share the
	// group so each message is processed exactly once (within the group).
	ConsumerGroup string
	ConsumerName  string // per-replica; default = hostname

	BatchSize   int           // XREADGROUP COUNT
	BlockPeriod time.Duration // XREADGROUP BLOCK
	ClaimIdle   time.Duration // auto-claim pending entries older than this

	// MarginCacheTTL is how stale the in-memory odds_config cache may be.
	// Admin edits take effect within this window.
	MarginCacheTTL time.Duration

	// HistorySkipPMIDMin: ticks with provider_market_id >= this value skip
	// the odds_history INSERT (published_odds is still written). 0 = keep
	// history for every tick. An operator brake for a provider whose tick
	// volume outruns the odds_history partition retention — the Fonbet
	// namespace starts at 1_000_000 (ODDS_HISTORY_SKIP_PMID_MIN).
	HistorySkipPMIDMin int
}

func Load() (Config, error) {
	cfg := Config{
		ServiceName:    getEnvDefault("SERVICE_NAME", "odds-publisher"),
		LogLevel:       getEnvDefault("LOG_LEVEL", "info"),
		HealthPort:     getEnvDefault("HEALTH_PORT", "8082"),
		ConsumerGroup:  getEnvDefault("ODDS_PUBLISHER_GROUP", "odds-publisher"),
		ConsumerName:   getEnvDefault("ODDS_PUBLISHER_NAME", hostnameDefault()),
		BatchSize:      atoiDefault("ODDS_PUBLISHER_BATCH", 128),
		BlockPeriod:    2 * time.Second,
		ClaimIdle:      60 * time.Second,
		MarginCacheTTL: 5 * time.Second,

		HistorySkipPMIDMin: atoiDefault("ODDS_HISTORY_SKIP_PMID_MIN", 0),
	}
	cfg.DatabaseURL = os.Getenv("DATABASE_URL")
	if cfg.DatabaseURL == "" {
		return cfg, fmt.Errorf("DATABASE_URL is required")
	}
	cfg.RedisURL = os.Getenv("REDIS_URL")
	if cfg.RedisURL == "" {
		return cfg, fmt.Errorf("REDIS_URL is required")
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

func hostnameDefault() string {
	if h, err := os.Hostname(); err == nil && h != "" {
		return h
	}
	return "odds-publisher"
}
