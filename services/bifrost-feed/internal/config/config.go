// Env parsing for bifrost-feed. Fail-fast on DATABASE_URL / REDIS_URL;
// the Bifrost credential is optional so the container boots idle (health
// only) until an operator supplies it — same graceful-idle contract every
// other Oddzilla worker follows.

package config

import (
	"fmt"
	"os"
	"strconv"
	"strings"
)

// Mode selects how the service behaves relative to the primary AMQP feed.
type Mode string

const (
	// ModeAuto publishes only while the primary feed is silent past the
	// takeover threshold and stands down as soon as it resumes.
	ModeAuto Mode = "auto"
	// ModeActive publishes unconditionally. Operator override for a
	// planned failover or for exercising the path on a staging box.
	ModeActive Mode = "active"
	// ModeOff keeps the service idle: no Bifrost connection, no publishing.
	ModeOff Mode = "off"
)

type Config struct {
	ServiceName string
	LogLevel    string
	HealthPort  string

	DatabaseURL string
	RedisURL    string

	Bifrost BifrostConfig

	// Mode is BIFROST_MODE — auto (default), active, or off.
	Mode Mode

	// TakeoverAfterSeconds is how long the primary feed must be silent
	// before auto mode starts publishing. feed-ingester's alive watchdog
	// suspends the catalog after FEED_STALE_SUSPEND_SECONDS (20 s); the
	// default 45 s sits comfortably past that so a routine AMQP reconnect
	// blip never triggers a takeover, while a real outage hands over well
	// inside a minute.
	TakeoverAfterSeconds int

	// ResyncIntervalSeconds is how often the runner re-lists the active
	// catalog over HTTP to catch matches the state stream never announced,
	// and sweeps recently closed matches for settlements still open in
	// our DB. Bifrost is state-based, so this doubles as its "recovery".
	ResyncIntervalSeconds int

	// SubscriptionBatch is how many per-match subscriptions are sent to
	// the socket before yielding. Bifrost accepted 50 in one burst during
	// the 2026-09-03 probe; this just keeps a 1000-match catalogue from
	// arriving as one write.
	SubscriptionBatch int
}

type BifrostConfig struct {
	// Enabled is derived: true when APIKey is non-empty.
	Enabled bool
	// HTTPURL is the GraphQL query endpoint.
	HTTPURL string
	// WSURL is the graphql-transport-ws endpoint (same path over wss).
	WSURL string
	// APIKey is the brand token Bifrost identifies the client by. Oddin
	// authorised Oddzilla to use MaxBet's key (client 101) on 2026-09-03;
	// the value lives only in .env.
	APIKey string
	// Locale is sent as X-Locale; drives market / selection names.
	Locale string
	// Origin is sent as the Origin header. Bifrost is fronted by the same
	// kind of allowed-origin check as the video API, so the value must be
	// one the key is registered for.
	Origin string
}

func Load() (Config, error) {
	cfg := Config{
		ServiceName:           getEnvDefault("SERVICE_NAME", "bifrost-feed"),
		LogLevel:              getEnvDefault("LOG_LEVEL", "info"),
		HealthPort:            getEnvDefault("HEALTH_PORT", "8086"),
		Mode:                  Mode(strings.ToLower(getEnvDefault("BIFROST_MODE", string(ModeAuto)))),
		TakeoverAfterSeconds:  atoiDefault("BIFROST_TAKEOVER_AFTER_SECONDS", 45),
		ResyncIntervalSeconds: atoiDefault("BIFROST_RESYNC_INTERVAL_SECONDS", 300),
		SubscriptionBatch:     atoiDefault("BIFROST_SUBSCRIPTION_BATCH", 50),
	}
	switch cfg.Mode {
	case ModeAuto, ModeActive, ModeOff:
	default:
		return cfg, fmt.Errorf("BIFROST_MODE must be auto, active, or off (got %q)", cfg.Mode)
	}

	cfg.DatabaseURL = os.Getenv("DATABASE_URL")
	if cfg.DatabaseURL == "" {
		return cfg, fmt.Errorf("DATABASE_URL is required")
	}
	cfg.RedisURL = os.Getenv("REDIS_URL")
	if cfg.RedisURL == "" {
		return cfg, fmt.Errorf("REDIS_URL is required")
	}

	httpURL := getEnvDefault("BIFROST_API_URL", "https://api-bifrost.oddin.gg/main/bifrost/query")
	cfg.Bifrost = BifrostConfig{
		HTTPURL: httpURL,
		WSURL:   getEnvDefault("BIFROST_WS_URL", deriveWSURL(httpURL)),
		APIKey:  os.Getenv("BIFROST_API_KEY"),
		Locale:  getEnvDefault("BIFROST_LOCALE", "en"),
		Origin:  getEnvDefault("BIFROST_ORIGIN", "https://bifrost.oddin.gg"),
	}
	cfg.Bifrost.Enabled = cfg.Bifrost.APIKey != ""
	if cfg.TakeoverAfterSeconds < 5 {
		cfg.TakeoverAfterSeconds = 5
	}
	if cfg.ResyncIntervalSeconds < 30 {
		cfg.ResyncIntervalSeconds = 30
	}
	if cfg.SubscriptionBatch < 1 {
		cfg.SubscriptionBatch = 1
	}
	return cfg, nil
}

// deriveWSURL swaps the scheme of the HTTP endpoint: Bifrost serves
// subscriptions on the exact same path over wss.
func deriveWSURL(httpURL string) string {
	switch {
	case strings.HasPrefix(httpURL, "https://"):
		return "wss://" + strings.TrimPrefix(httpURL, "https://")
	case strings.HasPrefix(httpURL, "http://"):
		return "ws://" + strings.TrimPrefix(httpURL, "http://")
	}
	return httpURL
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
