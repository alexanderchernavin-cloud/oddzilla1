// settlement worker. AMQP consumer that applies bet_settlement,
// bet_cancel, rollback_bet_settlement, and rollback_bet_cancel messages
// to tickets and wallets with apply-once semantics.
//
// Boot order:
//   1. Parse env; fail fast on DATABASE_URL / REDIS_URL.
//   2. Open pgxpool + redis; fail on unreachable deps.
//   3. Serve /healthz.
//   4. If Oddin creds present → start AMQP consumer. Else → log and idle
//      (same pattern as feed-ingester).
//   5. Block on SIGINT/SIGTERM.

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

	amqpkit "github.com/oddzilla/settlement/internal/amqp"
	"github.com/oddzilla/settlement/internal/config"
	"github.com/oddzilla/settlement/internal/settler"
	"github.com/oddzilla/settlement/internal/store"
	"github.com/oddzilla/settlement/internal/sweeper"
)

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

	st := store.New(pool)
	stt := settler.New(st, rdb, cfg.RollbackBatchSize, logger)
	swp := sweeper.New(sweeper.Config{
		RecoveryAgeHours: cfg.StaleRecoveryAgeHours,
		VoidAgeHours:     cfg.StaleVoidAgeHours,
		Interval:         cfg.StaleSweepInterval,
	}, st, stt, rdb, logger)

	healthSrv := startHealth(cfg.HealthPort, pool, rdb, stt, swp, logger)
	defer func() {
		shutCtx, shutCancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer shutCancel()
		_ = healthSrv.Shutdown(shutCtx)
	}()

	if !cfg.Oddin.Enabled {
		logger.Warn().Msg("Oddin creds absent; settlement idling — health only")
	} else {
		go runAMQP(ctx, cfg, stt, logger)
	}

	// The stale-ticket sweeper does not depend on AMQP. Run it even when
	// Oddin creds are absent so any tickets stuck from a previous run get
	// refunded after the void window.
	go swp.Run(ctx)

	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)
	<-sigCh
	logger.Info().Msg("shutting down")
	cancel()
}

func runAMQP(ctx context.Context, cfg config.Config, stt *settler.Settler, log zerolog.Logger) {
	cons := amqpkit.New(
		amqpkit.Config{
			Host:       cfg.Oddin.AMQPHost,
			Port:       cfg.Oddin.AMQPPort,
			TLS:        cfg.Oddin.AMQPTLS,
			Token:      cfg.Oddin.Token,
			CustomerID: cfg.Oddin.CustomerID,
			RoutingKey: cfg.Oddin.AMQPRouting,
			Heartbeat:  cfg.Oddin.Heartbeat,
		},
		func(ctx context.Context, rk string, body []byte) error {
			return stt.Handle(ctx, rk, body)
		},
		func(ctx context.Context) error {
			// Nothing to do on reconnect for settlement — we don't
			// need snapshot recovery because settlement messages are
			// naturally retried by Oddin until acked.
			log.Info().Msg("amqp (re)connected")
			return nil
		},
		log,
	)
	if err := cons.Run(ctx); err != nil && !errors.Is(err, context.Canceled) {
		log.Error().Err(err).Msg("amqp consumer exited")
	}
}

type healthResp struct {
	Status            string `json:"status"`
	Service           string `json:"service"`
	DB                string `json:"db"`
	Redis             string `json:"redis"`
	UptimeSeconds     int64  `json:"uptimeSeconds"`
	Settled           int64  `json:"settled"`
	Cancelled         int64  `json:"cancelled"`
	RolledBack        int64  `json:"rolledBack"`
	Skipped           int64  `json:"skipped"`
	Errors            int64  `json:"errors"`
	StaleTicks        int64  `json:"staleTicks"`
	StaleRecoveries   int64  `json:"staleRecoveries"`
	StaleVoided       int64  `json:"staleVoided"`
	StaleVoidFailures int64  `json:"staleVoidFailures"`
}

func startHealth(port string, pool *pgxpool.Pool, rdb *redis.Client, stt *settler.Settler, swp *sweeper.Sweeper, log zerolog.Logger) *http.Server {
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
		settled, cancelled, rolled, skipped, errs := stt.Stats()
		ticks, recov, voided, failed := swp.Stats()
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(healthResp{
			Status:            status,
			Service:           "settlement",
			DB:                okOrDown(dbOk),
			Redis:             okOrDown(redisOk),
			UptimeSeconds:     int64(time.Since(startedAt).Seconds()),
			Settled:           settled,
			Cancelled:         cancelled,
			RolledBack:        rolled,
			Skipped:           skipped,
			Errors:            errs,
			StaleTicks:        ticks,
			StaleRecoveries:   recov,
			StaleVoided:       voided,
			StaleVoidFailures: failed,
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
