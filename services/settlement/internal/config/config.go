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
		ServiceName:       getEnvDefault("SERVICE_NAME", "settlement"),
		LogLevel:          getEnvDefault("LOG_LEVEL", "info"),
		HealthPort:        getEnvDefault("HEALTH_PORT", "8083"),
		RollbackBatchSize: atoiDefault("SETTLEMENT_ROLLBACK_BATCH", 100),
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
