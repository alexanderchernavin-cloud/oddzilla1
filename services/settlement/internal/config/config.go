// Env parsing for settlement. Mirrors feed-ingester's structure but binds
// to a narrower routing key set (settlement-family messages only).

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
	HealthPort  string

	Oddin OddinConfig

	RollbackBatchSize int

	// StaleSweepInterval is how often the periodic sweeper checks for
	// tickets stuck `accepted` past their match's scheduled_at. Defaults
	// to 30 minutes; both the recovery notification and the void/refund
	// flow run on this cadence.
	StaleSweepInterval time.Duration
	// StaleRecoveryAgeHours sets the lower bound of the recovery window
	// in hours after the match's scheduled start. Below this we leave
	// the ticket alone (the live broker may still be retrying). Above
	// this and below the void age we re-pull the fixture from REST so
	// matches.status reflects reality.
	StaleRecoveryAgeHours int
	// StaleVoidAgeHours is the cut-off after which stuck legs are
	// voided and the ticket is settled (refunding the stake portion).
	// Tickets younger than this stay in the recovery window. Two days
	// is the default — generous enough to give Oddin a chance to retry
	// and for the operator to spot any larger outage.
	StaleVoidAgeHours int
}

type OddinConfig struct {
	Enabled     bool
	Env         string
	Token       string
	CustomerID  string
	AMQPHost    string
	AMQPPort    int
	AMQPTLS     bool
	// Routing key binding for our queue. Default filters to settlement-
	// related message types only — cheaper than consuming everything.
	AMQPRouting string
	RESTBaseURL string
	Heartbeat   time.Duration
}

func Load() (Config, error) {
	cfg := Config{
		ServiceName:           getEnvDefault("SERVICE_NAME", "settlement"),
		LogLevel:              getEnvDefault("LOG_LEVEL", "info"),
		HealthPort:            getEnvDefault("HEALTH_PORT", "8083"),
		RollbackBatchSize:     atoiDefault("SETTLEMENT_ROLLBACK_BATCH", 100),
		StaleSweepInterval:    durationDefault("SETTLEMENT_STALE_SWEEP_INTERVAL", 30*time.Minute),
		StaleRecoveryAgeHours: atoiDefault("SETTLEMENT_STALE_RECOVERY_AGE_HOURS", 5),
		StaleVoidAgeHours:     atoiDefault("SETTLEMENT_STALE_VOID_AGE_HOURS", 48),
	}
	cfg.DatabaseURL = os.Getenv("DATABASE_URL")
	if cfg.DatabaseURL == "" {
		return cfg, fmt.Errorf("DATABASE_URL is required")
	}
	cfg.RedisURL = os.Getenv("REDIS_URL")
	if cfg.RedisURL == "" {
		return cfg, fmt.Errorf("REDIS_URL is required")
	}

	cfg.Oddin = OddinConfig{
		Env:         getEnvDefault("ODDIN_ENV", "integration"),
		Token:       os.Getenv("ODDIN_TOKEN"),
		CustomerID:  os.Getenv("ODDIN_CUSTOMER_ID"),
		AMQPHost:    getEnvDefault("ODDIN_AMQP_HOST", "mq.integration.oddin.gg"),
		AMQPPort:    atoiDefault("ODDIN_AMQP_PORT", 5671),
		AMQPTLS:     strings.EqualFold(getEnvDefault("ODDIN_AMQP_TLS", "true"), "true"),
		AMQPRouting: getEnvDefault("SETTLEMENT_AMQP_ROUTING_KEY", "#"),
		RESTBaseURL: getEnvDefault("ODDIN_REST_BASE_URL", "https://api-mq.integration.oddin.gg"),
		Heartbeat:   30 * time.Second,
	}
	cfg.Oddin.Enabled = cfg.Oddin.Token != "" && cfg.Oddin.CustomerID != ""
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

func durationDefault(key string, fallback time.Duration) time.Duration {
	if v, ok := os.LookupEnv(key); ok && v != "" {
		if d, err := time.ParseDuration(v); err == nil && d > 0 {
			return d
		}
	}
	return fallback
}
