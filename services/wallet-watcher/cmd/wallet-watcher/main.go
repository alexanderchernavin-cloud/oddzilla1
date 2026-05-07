// wallet-watcher — Ethereum USDC deposit verifier.
//
// Post-0032 the service runs a single intent-driven loop:
//   1. Poll deposit_intents for rows in {pending, confirming}.
//   2. Resolve each user-submitted tx hash via eth_getTransactionReceipt.
//   3. Validate the Transfer event (USDC contract, recipient = the
//      shared receive address, positive amount).
//   4. Count confirmations against the chain head, reorg-verify the
//      block hash at threshold, and credit atomically.
//
// Boots cleanly when ETH_RPC_URL or DEPOSIT_RECEIVE_ADDRESS is empty —
// the loop is skipped, /healthz reports the disabled state, and the
// process serves as a no-op until both vars are set.

package main

import (
	"context"
	"encoding/json"
	"net/http"
	"os"
	"os/signal"
	"sync/atomic"
	"syscall"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/rs/zerolog"

	"github.com/oddzilla/wallet-watcher/internal/config"
	"github.com/oddzilla/wallet-watcher/internal/deposits"
	"github.com/oddzilla/wallet-watcher/internal/ethereum"
	"github.com/oddzilla/wallet-watcher/internal/store"
)

// chainHealth tracks the last successful tick + observed head block.
// Stale lastTickUnix (>5 min) is the canonical "RPC is dead" signal
// for monitoring; without it an outage would leave the container
// "healthy" while no user got credited.
type chainHealth struct {
	enabled       bool
	lastTickUnix  int64
	lastHeadBlock int64
}

func main() {
	cfg, err := config.Load()
	logger := newLogger(cfg.LogLevel, cfg.ServiceName)
	if err != nil {
		logger.Fatal().Err(err).Msg("config")
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	pool, err := pgxpool.New(ctx, cfg.DatabaseURL)
	if err != nil {
		logger.Fatal().Err(err).Msg("postgres pool")
	}
	defer pool.Close()
	if err := pool.Ping(ctx); err != nil {
		logger.Fatal().Err(err).Msg("postgres ping")
	}
	logger.Info().Msg("connected to postgres")

	st := store.New(pool)

	ethHealth := &chainHealth{enabled: cfg.Ethereum.Enabled}
	var processor *deposits.Processor

	if cfg.Ethereum.Enabled {
		client := ethereum.NewClient(cfg.Ethereum.RPCURL)
		verifier := ethereum.NewVerifier(
			client,
			st,
			cfg.Ethereum.USDCContract,
			cfg.Ethereum.ReceiveAddress,
			cfg.Ethereum.Confirmations,
			cfg.Ethereum.DiscoveryMaxBlockRange,
			cfg.Ethereum.DiscoveryStartBlock,
			cfg.Ethereum.DiscoveryStartLookback,
			logger,
		)
		processor = deposits.New(st, verifier, logger)
		go runLoop(ctx, processor, verifier, cfg.PollInterval, ethHealth, logger)
		logger.Info().
			Str("contract", cfg.Ethereum.USDCContract).
			Str("receive", cfg.Ethereum.ReceiveAddress).
			Int("confirmations", cfg.Ethereum.Confirmations).
			Int("discovery_max_blocks", cfg.Ethereum.DiscoveryMaxBlockRange).
			Dur("poll", cfg.PollInterval).
			Msg("ERC20 USDC verifier running (paste-hash + linked-wallet discovery)")
	} else {
		logger.Warn().
			Bool("rpc_set", cfg.Ethereum.RPCURL != "").
			Bool("receive_set", cfg.Ethereum.ReceiveAddress != "").
			Msg("Ethereum verifier disabled (ETH_RPC_URL or DEPOSIT_RECEIVE_ADDRESS missing)")
	}

	healthSrv := startHealth(cfg.HealthPort, pool, processor, ethHealth, logger)
	defer func() {
		shutCtx, shutCancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer shutCancel()
		_ = healthSrv.Shutdown(shutCtx)
	}()

	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)
	<-sigCh
	logger.Info().Msg("shutting down")
	cancel()
}

type headProvider interface {
	HeadBlock(ctx context.Context) (int64, error)
}

func runLoop(ctx context.Context, p *deposits.Processor, head headProvider, poll time.Duration, h *chainHealth, log zerolog.Logger) {
	t := time.NewTicker(poll)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		}
		if err := p.Tick(ctx); err != nil {
			log.Warn().Err(err).Msg("processor tick failed")
			continue
		}
		atomic.StoreInt64(&h.lastTickUnix, time.Now().Unix())
		if hb, err := head.HeadBlock(ctx); err == nil {
			atomic.StoreInt64(&h.lastHeadBlock, hb)
		}
	}
}

func startHealth(port string, pool *pgxpool.Pool, p *deposits.Processor, h *chainHealth, log zerolog.Logger) *http.Server {
	startedAt := time.Now()
	mux := http.NewServeMux()
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, r *http.Request) {
		dbOk := pool.Ping(r.Context()) == nil
		status := "ok"
		if !dbOk {
			status = "degraded"
			w.WriteHeader(http.StatusServiceUnavailable)
		}
		w.Header().Set("Content-Type", "application/json")
		var credited int64
		if p != nil {
			credited = p.Stats()
		}
		_ = json.NewEncoder(w).Encode(map[string]any{
			"status":        status,
			"service":       "wallet-watcher",
			"db":            okOrDown(dbOk),
			"uptimeSeconds": int64(time.Since(startedAt).Seconds()),
			"credited":      credited,
			"ethereum":      chainSnapshot(h),
		})
	})
	srv := &http.Server{
		Addr:              ":" + port,
		Handler:           mux,
		ReadHeaderTimeout: 5 * time.Second,
	}
	go func() {
		log.Info().Str("port", port).Msg("health server listening")
		if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			log.Error().Err(err).Msg("health server")
		}
	}()
	return srv
}

func newLogger(levelStr, service string) zerolog.Logger {
	lvl, err := zerolog.ParseLevel(levelStr)
	if err != nil || lvl == zerolog.NoLevel {
		lvl = zerolog.InfoLevel
	}
	zerolog.SetGlobalLevel(lvl)
	return zerolog.New(os.Stdout).With().Timestamp().Str("service", service).Logger()
}

func okOrDown(b bool) string {
	if b {
		return "ok"
	}
	return "down"
}

func chainSnapshot(h *chainHealth) map[string]any {
	if !h.enabled {
		return map[string]any{"enabled": false}
	}
	out := map[string]any{
		"enabled":       true,
		"lastHeadBlock": atomic.LoadInt64(&h.lastHeadBlock),
	}
	ts := atomic.LoadInt64(&h.lastTickUnix)
	if ts > 0 {
		out["lastTickAt"] = time.Unix(ts, 0).UTC().Format(time.RFC3339)
		out["staleSeconds"] = int64(time.Since(time.Unix(ts, 0)).Seconds())
	} else {
		out["lastTickAt"] = nil
	}
	return out
}
