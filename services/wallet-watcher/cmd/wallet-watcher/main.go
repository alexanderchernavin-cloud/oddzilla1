// wallet-watcher: TRC20 + ERC20 USDT deposit poller.
//
// Each enabled chain runs two loops:
//   1. Scanner: pulls fresh Transfer events into the deposits table.
//   2. Processor: walks pending deposits, ticks confirmations, and
//      credits via wallet_ledger when the per-chain threshold is met.
//
// Boot order matches the other Go services (Postgres → optional chain
// clients → health → loops). Both chains are independent — one missing
// RPC URL doesn't block the other from running.

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
	"github.com/oddzilla/wallet-watcher/internal/tron"
)

// Per-chain healthcheck state. The scanner loop writes after each
// successful Tick + HeadBlock; the healthz handler reads. Stale values
// (lastTickUnix more than ~5 min ago) signal an RPC outage that the
// operator should escalate before deposits start backing up. Without
// this, an hours-long Tron / Alchemy outage would leave the container
// "healthy" while no user got credited.
type chainHealth struct {
	enabled       bool
	lastTickUnix  int64 // 0 = never
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
	processor := deposits.New(st, logger)

	tronHealth := &chainHealth{enabled: cfg.Tron.Enabled}
	ethHealth := &chainHealth{enabled: cfg.Ethereum.Enabled}

	healthSrv := startHealth(cfg.HealthPort, pool, processor, tronHealth, ethHealth, logger)
	defer func() {
		shutCtx, shutCancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer shutCancel()
		_ = healthSrv.Shutdown(shutCtx)
	}()

	if cfg.Tron.Enabled {
		client := tron.NewClient(cfg.Tron.RPCURL)
		scanner := tron.NewScanner(client, st, cfg.Tron.USDTContract,
			cfg.Tron.MaxBlockRange, cfg.Tron.Confirmations, cfg.Tron.StartBlock, logger)
		go runChain(ctx, "TRC20", store.ChainTRC20, scanner, processor, cfg.PollInterval, tronHealth, logger)
	} else {
		logger.Warn().Msg("Tron RPC URL absent; TRC20 scanner disabled")
	}

	if cfg.Ethereum.Enabled {
		client := ethereum.NewClient(cfg.Ethereum.RPCURL)
		scanner := ethereum.NewScanner(client, st, cfg.Ethereum.USDTContract,
			cfg.Ethereum.MaxBlockRange, cfg.Ethereum.Confirmations, cfg.Ethereum.StartBlock, logger)
		go runChain(ctx, "ERC20", store.ChainERC20, scanner, processor, cfg.PollInterval, ethHealth, logger)
	} else {
		logger.Warn().Msg("Ethereum RPC URL absent; ERC20 scanner disabled")
	}

	if !cfg.Tron.Enabled && !cfg.Ethereum.Enabled {
		logger.Warn().Msg("no chains enabled; wallet-watcher idling on health endpoint only")
	}

	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)
	<-sigCh
	logger.Info().Msg("shutting down")
	cancel()
}

// chainScanner unifies the two scanner types under one loop. We use a
// small interface so the loop body doesn't care which chain it runs.
// Must mirror deposits.HeadProvider so the same value can satisfy both.
type chainScanner interface {
	Tick(ctx context.Context) error
	HeadBlock(ctx context.Context) (int64, error)
	Confirmations() int
	VerifyDeposit(ctx context.Context, dep store.PendingDeposit) (bool, error)
}

func runChain(ctx context.Context, name string, chain store.Chain, sc chainScanner, p *deposits.Processor, poll time.Duration, h *chainHealth, log zerolog.Logger) {
	clog := log.With().Str("loop", name).Logger()
	clog.Info().Dur("poll_interval", poll).Msg("scanner loop running")

	t := time.NewTicker(poll)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		}
		tickErr := sc.Tick(ctx)
		if tickErr != nil {
			clog.Warn().Err(tickErr).Msg("scanner tick failed")
		} else {
			// Update healthz signal only on success — staleness is the
			// signal we want operators to alert on. HeadBlock is a
			// secondary read; if it's down too, leave the previous
			// value (operators can still see lastTickAt advancing).
			atomic.StoreInt64(&h.lastTickUnix, time.Now().Unix())
			if head, err := sc.HeadBlock(ctx); err == nil {
				atomic.StoreInt64(&h.lastHeadBlock, head)
			}
		}
		if err := p.TickChain(ctx, chain, sc); err != nil {
			clog.Warn().Err(err).Msg("deposit processor tick failed")
		}
	}
}

// ─── Health ────────────────────────────────────────────────────────────────

func startHealth(port string, pool *pgxpool.Pool, p *deposits.Processor, tronH, ethH *chainHealth, log zerolog.Logger) *http.Server {
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
		_ = json.NewEncoder(w).Encode(map[string]any{
			"status":        status,
			"service":       "wallet-watcher",
			"db":            okOrDown(dbOk),
			"uptimeSeconds": int64(time.Since(startedAt).Seconds()),
			"credited":      p.Stats(),
			"tron":          chainSnapshot(tronH),
			"ethereum":      chainSnapshot(ethH),
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
	return zerolog.New(os.Stdout).With().
		Timestamp().
		Str("service", service).
		Logger()
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
