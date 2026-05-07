package config

import (
	"fmt"
	"os"
	"strconv"
	"strings"
	"time"
)

// Config drives wallet-watcher. Post-0032 the service runs a single
// loop against Ethereum, polling deposit_intents and crediting wallets
// when the receipt of the user-claimed tx hash clears the configured
// confirmation threshold.
type Config struct {
	ServiceName string
	LogLevel    string
	DatabaseURL string
	HealthPort  string

	Ethereum EthereumConfig

	PollInterval time.Duration
}

type EthereumConfig struct {
	Enabled bool
	RPCURL  string
	// USDC contract address on Ethereum mainnet. Defaulted to the
	// real circle-issued contract; override for testnets.
	USDCContract string
	// The single shared address users send their USDC to. The watcher
	// only credits intents whose Transfer recipient matches this
	// address; anything else is rejected.
	ReceiveAddress string
	Confirmations  int
	// Max block range fetched per discovery tick. Keeps the eth_getLogs
	// payload bounded; Alchemy's free tier caps at 10k blocks per call.
	DiscoveryMaxBlockRange int
	// Block to start the discovery cursor from on first boot. 0 =
	// bootstrap from `head - DiscoveryStartLookback` so we don't try
	// to scan years of history.
	DiscoveryStartBlock int64
	// On bootstrap (cursor == 0 and DiscoveryStartBlock == 0), how many
	// blocks back from head to begin scanning. ~6500 blocks ≈ 24h on
	// Ethereum mainnet — picks up recent linked-wallet sends without
	// re-scanning ancient history.
	DiscoveryStartLookback int64
}

func Load() (Config, error) {
	cfg := Config{
		ServiceName:  getEnvDefault("SERVICE_NAME", "wallet-watcher"),
		LogLevel:     getEnvDefault("LOG_LEVEL", "info"),
		HealthPort:   getEnvDefault("HEALTH_PORT", "8085"),
		PollInterval: time.Duration(atoiDefault("WALLET_POLL_MS", 5000)) * time.Millisecond,
	}
	cfg.DatabaseURL = os.Getenv("DATABASE_URL")
	if cfg.DatabaseURL == "" {
		return cfg, fmt.Errorf("DATABASE_URL is required")
	}

	cfg.Ethereum = EthereumConfig{
		RPCURL:                 strings.TrimRight(os.Getenv("ETH_RPC_URL"), "/"),
		USDCContract:           strings.ToLower(getEnvDefault("ETH_USDC_CONTRACT", "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48")),
		ReceiveAddress:         strings.ToLower(strings.TrimSpace(os.Getenv("DEPOSIT_RECEIVE_ADDRESS"))),
		Confirmations:          atoiDefault("ETH_CONFIRMATIONS", 12),
		DiscoveryMaxBlockRange: atoiDefault("ETH_DISCOVERY_MAX_BLOCK_RANGE", 1000),
		DiscoveryStartBlock:    int64(atoiDefault("ETH_DISCOVERY_START_BLOCK", 0)),
		DiscoveryStartLookback: int64(atoiDefault("ETH_DISCOVERY_START_LOOKBACK", 6500)),
	}
	cfg.Ethereum.Enabled = cfg.Ethereum.RPCURL != "" && cfg.Ethereum.ReceiveAddress != ""

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
