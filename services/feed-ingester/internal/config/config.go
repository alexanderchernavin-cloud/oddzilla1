// Env parsing for feed-ingester. Fail-fast on missing required vars;
// optional Oddin creds can be absent (service boots to idle health-only).

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

	// Oddin — all optional. If Token is empty, the ingester boots idle
	// (health endpoint only) until credentials arrive.
	Oddin OddinConfig
}

type OddinConfig struct {
	Enabled     bool
	Env         string // "integration" or "production"
	Token       string
	CustomerID  string
	NodeID      int
	AMQPHost    string
	AMQPPort    int
	AMQPTLS     bool
	AMQPRouting string
	RESTBaseURL string
	Lang        string
	Heartbeat   time.Duration

	// AllowedSportURNs restricts auto-mapping to this set of Oddin sport
	// URNs. Any odds/fixture message whose sport is outside this set is
	// dropped before any DB rows are created. Empty means no filter
	// (legacy behavior — every sport the feed emits is persisted).
	//
	// Default is the 4 MVP esports per CLAUDE.md (CS2, Dota2, LoL,
	// Valorant). Override with the env var ALLOWED_ODDIN_SPORT_URNS,
	// comma-separated (e.g. "od:sport:3,od:sport:2,od:sport:1,od:sport:13").
	// Set to "*" to disable filtering entirely.
	AllowedSportURNs map[string]struct{}
}

func Load() (Config, error) {
	cfg := Config{
		ServiceName: getEnvDefault("SERVICE_NAME", "feed-ingester"),
		LogLevel:    getEnvDefault("LOG_LEVEL", "info"),
		HealthPort:  getEnvDefault("HEALTH_PORT", "8081"),
	}

	cfg.DatabaseURL = os.Getenv("DATABASE_URL")
	if cfg.DatabaseURL == "" {
		return cfg, fmt.Errorf("DATABASE_URL is required")
	}
	cfg.RedisURL = os.Getenv("REDIS_URL")
	if cfg.RedisURL == "" {
		return cfg, fmt.Errorf("REDIS_URL is required")
	}

	// Oddin
	cfg.Oddin = OddinConfig{
		Env:         getEnvDefault("ODDIN_ENV", "integration"),
		Token:       os.Getenv("ODDIN_TOKEN"),
		CustomerID:  os.Getenv("ODDIN_CUSTOMER_ID"),
		AMQPHost:    getEnvDefault("ODDIN_AMQP_HOST", "mq.integration.oddin.gg"),
		AMQPPort:    atoiDefault("ODDIN_AMQP_PORT", 5671),
		AMQPTLS:     strings.EqualFold(getEnvDefault("ODDIN_AMQP_TLS", "true"), "true"),
		AMQPRouting: getEnvDefault("ODDIN_AMQP_ROUTING_KEY", "#"),
		RESTBaseURL: getEnvDefault("ODDIN_REST_BASE_URL", "https://api-mq.integration.oddin.gg"),
		Lang:        getEnvDefault("ODDIN_LANG", "en"),
		NodeID:      atoiDefault("ODDIN_NODE_ID", 1),
		Heartbeat:   30 * time.Second,
	}
	cfg.Oddin.Enabled = cfg.Oddin.Token != "" && cfg.Oddin.CustomerID != ""
	cfg.Oddin.AllowedSportURNs = parseAllowedSports(
		getEnvDefault("ALLOWED_ODDIN_SPORT_URNS", "od:sport:3,od:sport:2,od:sport:1,od:sport:13"),
	)

	return cfg, nil
}

// parseAllowedSports accepts a comma-separated list of Oddin sport URNs.
// "*" disables filtering (returns nil); empty string also returns nil so
// misconfiguration doesn't silently drop every message. Returns a set for
// O(1) lookup.
func parseAllowedSports(raw string) map[string]struct{} {
	raw = strings.TrimSpace(raw)
	if raw == "" || raw == "*" {
		return nil
	}
	out := make(map[string]struct{})
	for _, p := range strings.Split(raw, ",") {
		p = strings.TrimSpace(p)
		if p == "" {
			continue
		}
		out[p] = struct{}{}
	}
	if len(out) == 0 {
		return nil
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
