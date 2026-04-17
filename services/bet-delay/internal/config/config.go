package config

import (
	"fmt"
	"os"
	"strconv"
	"time"
)

type Config struct {
	ServiceName      string
	LogLevel         string
	DatabaseURL      string
	RedisURL         string
	HealthPort       string
	SweepInterval    time.Duration
	DriftToleranceBp int // 500 = 5%. Matches DEFAULT_ODDS_DRIFT_TOLERANCE in @oddzilla/types.
	BatchSize        int
}

func Load() (Config, error) {
	cfg := Config{
		ServiceName:      getEnvDefault("SERVICE_NAME", "bet-delay"),
		LogLevel:         getEnvDefault("LOG_LEVEL", "info"),
		HealthPort:       getEnvDefault("HEALTH_PORT", "8084"),
		SweepInterval:    time.Duration(atoiDefault("BET_DELAY_SWEEP_MS", 1000)) * time.Millisecond,
		DriftToleranceBp: atoiDefault("BET_DELAY_DRIFT_BP", 500),
		BatchSize:        atoiDefault("BET_DELAY_BATCH", 100),
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
