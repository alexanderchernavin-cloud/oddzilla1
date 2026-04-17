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
	HealthPort  string

	Tron     ChainConfig
	Ethereum ChainConfig

	PollInterval time.Duration
}

// ChainConfig holds what we need to poll one chain. Disabled chains
// (missing RPC URL) are skipped gracefully at boot.
type ChainConfig struct {
	Enabled           bool
	RPCURL            string
	USDTContract      string
	Confirmations     int
	// StartBlock is the block number to begin scanning from on first
	// boot when the scanner cursor is zero. Set to a recent-enough
	// block to avoid scanning all history. 0 → "current chain head -
	// a safe buffer" fallback resolved at runtime.
	StartBlock int64
	// MaxBlockRange is the largest range passed to eth_getLogs /
	// TronGrid in a single call. Keeps provider rate limits happy.
	MaxBlockRange int
}

func Load() (Config, error) {
	cfg := Config{
		ServiceName: getEnvDefault("SERVICE_NAME", "wallet-watcher"),
		LogLevel:    getEnvDefault("LOG_LEVEL", "info"),
		HealthPort:  getEnvDefault("HEALTH_PORT", "8085"),
		PollInterval: time.Duration(atoiDefault("WALLET_POLL_MS", 5000)) * time.Millisecond,
	}
	cfg.DatabaseURL = os.Getenv("DATABASE_URL")
	if cfg.DatabaseURL == "" {
		return cfg, fmt.Errorf("DATABASE_URL is required")
	}

	cfg.Tron = ChainConfig{
		RPCURL:        strings.TrimRight(os.Getenv("TRON_RPC_URL"), "/"),
		USDTContract:  getEnvDefault("TRON_USDT_CONTRACT", "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t"),
		Confirmations: atoiDefault("TRON_CONFIRMATIONS", 19),
		StartBlock:    int64(atoiDefault("TRON_START_BLOCK", 0)),
		MaxBlockRange: atoiDefault("TRON_MAX_BLOCK_RANGE", 50),
	}
	cfg.Tron.Enabled = cfg.Tron.RPCURL != ""

	cfg.Ethereum = ChainConfig{
		RPCURL:        strings.TrimRight(os.Getenv("ETH_RPC_URL"), "/"),
		USDTContract:  strings.ToLower(getEnvDefault("ETH_USDT_CONTRACT", "0xdAC17F958D2ee523a2206206994597C13D831ec7")),
		Confirmations: atoiDefault("ETH_CONFIRMATIONS", 12),
		StartBlock:    int64(atoiDefault("ETH_START_BLOCK", 0)),
		MaxBlockRange: atoiDefault("ETH_MAX_BLOCK_RANGE", 1000),
	}
	cfg.Ethereum.Enabled = cfg.Ethereum.RPCURL != ""

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
