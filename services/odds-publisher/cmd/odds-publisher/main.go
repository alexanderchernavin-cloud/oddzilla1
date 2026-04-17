// odds-publisher: reads odds.raw stream, applies payback margin, writes
// published_odds, fans out to Redis pub/sub for ws-gateway.
//
// Graceful boot: if Redis or Postgres are unreachable we die loudly. If the
// stream doesn't exist yet we create it via MKSTREAM so boot before the
// ingester's first event is safe.

package main

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/redis/go-redis/v9"
	"github.com/rs/zerolog"

	"github.com/oddzilla/odds-publisher/internal/bus"
	"github.com/oddzilla/odds-publisher/internal/config"
	"github.com/oddzilla/odds-publisher/internal/publisher"
	"github.com/oddzilla/odds-publisher/internal/store"
)

func main() {
	cfg, err := config.Load()
	logger := newLogger(cfg.LogLevel, cfg.ServiceName)
	if err != nil {
		logger.Fatal().Err(err).Msg("config")
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	// ── Postgres ───────────────────────────────────────────────────────
	pool, err := pgxpool.New(ctx, cfg.DatabaseURL)
	if err != nil {
		logger.Fatal().Err(err).Msg("postgres pool")
	}
	defer pool.Close()
	if err := pool.Ping(ctx); err != nil {
		logger.Fatal().Err(err).Msg("postgres ping")
	}
	logger.Info().Msg("connected to postgres")

	// ── Redis ──────────────────────────────────────────────────────────
	ropts, err := redis.ParseURL(cfg.RedisURL)
	if err != nil {
		logger.Fatal().Err(err).Msg("redis url")
	}
	rdb := redis.NewClient(ropts)
	defer rdb.Close()
	if err := rdb.Ping(ctx).Err(); err != nil {
		logger.Fatal().Err(err).Msg("redis ping")
	}
	logger.Info().Msg("connected to redis")

	// ── Wire store + publisher ─────────────────────────────────────────
	st := store.New(pool)
	// Warm the margin cache so the first event doesn't pay the full
	// cascade-load penalty.
	if _, err := st.LoadMarginCache(ctx); err != nil {
		logger.Warn().Err(err).Msg("initial margin cache load failed; continuing (will retry lazily)")
	}

	pub := publisher.New(st, rdb, cfg.MarginCacheTTL, logger)

	cons := bus.NewConsumer(
		rdb,
		cfg.ConsumerGroup,
		cfg.ConsumerName,
		cfg.BatchSize,
		cfg.BlockPeriod,
		cfg.ClaimIdle,
		pub.Handle,
		logger,
	)

	// ── Health ─────────────────────────────────────────────────────────
	healthSrv := startHealth(cfg.HealthPort, pool, rdb, pub, logger)
	defer func() {
		shutCtx, shutCancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer shutCancel()
		_ = healthSrv.Shutdown(shutCtx)
	}()

	// ── Consumer ───────────────────────────────────────────────────────
	go func() {
		if err := cons.Run(ctx); err != nil && !errors.Is(err, context.Canceled) {
			logger.Error().Err(err).Msg("consumer exited")
		}
	}()

	// ── Wait for signal ────────────────────────────────────────────────
	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)
	<-sigCh
	logger.Info().Msg("shutting down")
	cancel()
}

// ─── Health ────────────────────────────────────────────────────────────────

func startHealth(port string, pool *pgxpool.Pool, rdb *redis.Client, pub *publisher.Publisher, log zerolog.Logger) *http.Server {
	startedAt := time.Now()
	mux := http.NewServeMux()
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, r *http.Request) {
		dbOk := pool.Ping(r.Context()) == nil
		redisOk := rdb.Ping(r.Context()).Err() == nil
		status := "ok"
		if !dbOk || !redisOk {
			status = "degraded"
			w.WriteHeader(http.StatusServiceUnavailable)
		}
		processed, errs := pub.Stats()
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"status":        status,
			"service":       "odds-publisher",
			"db":            okOrDown(dbOk),
			"redis":         okOrDown(redisOk),
			"uptimeSeconds": int64(time.Since(startedAt).Seconds()),
			"processed":     processed,
			"errors":        errs,
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
