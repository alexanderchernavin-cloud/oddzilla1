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
	"fmt"
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
	"github.com/oddzilla/settlement/internal/oddinrest"
	"github.com/oddzilla/settlement/internal/settler"
	"github.com/oddzilla/settlement/internal/store"

	"math/rand"
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

	healthSrv := startHealth(cfg.HealthPort, pool, rdb, stt, logger)
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

	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)
	<-sigCh
	logger.Info().Msg("shutting down")
	cancel()
}

func runAMQP(ctx context.Context, cfg config.Config, stt *settler.Settler, log zerolog.Logger) {
	// Stable named queue per (customer, deployment). The settlement
	// stream needs at-least-once delivery across worker restarts; a
	// server-named auto-delete queue silently drops unacked messages
	// when the consumer disconnects (queue is garbage-collected with
	// the connection). Pinning to a stable name with durable+true
	// keeps unacked deliveries pending until a fresh consumer attaches.
	//
	// Naming pattern: `oddzilla-settlement-<customerID>` — customerID
	// scopes per Oddin product, and the static prefix lets ops grep
	// for our queues against the Oddin broker.
	queueName := fmt.Sprintf("oddzilla-settlement-%s", cfg.Oddin.CustomerID)

	// Recovery client. Triggered from onConnect to ask Oddin to replay
	// any messages we may have missed during the disconnect window.
	// Defense-in-depth: the durable queue alone covers worker-restart
	// gaps, but recovery additionally covers:
	//   • fresh deployments (first time the queue exists, nothing to
	//     resume)
	//   • broker outages that lose persistent storage
	//   • settlement messages stuck in a long-running tx that
	//     ultimately rolled back AFTER feed-ingester's own recovery
	//     ran on its earlier reconnect
	restClient := oddinrest.New(cfg.Oddin.RESTBaseURL, cfg.Oddin.Token)

	cons := amqpkit.New(
		amqpkit.Config{
			Host:       cfg.Oddin.AMQPHost,
			Port:       cfg.Oddin.AMQPPort,
			TLS:        cfg.Oddin.AMQPTLS,
			Token:      cfg.Oddin.Token,
			CustomerID: cfg.Oddin.CustomerID,
			RoutingKey: cfg.Oddin.AMQPRouting,
			QueueName:  queueName,
			Heartbeat:  cfg.Oddin.Heartbeat,
		},
		func(ctx context.Context, rk string, body []byte) error {
			return stt.Handle(ctx, rk, body)
		},
		func(ctx context.Context) error {
			// Trigger recovery on every (re)connect. Window = 1 h
			// back from now — long enough to cover a reasonable
			// restart gap, short enough to stay in Oddin's lenient
			// rate-limit tier (60/h, 20/10min). Even though our
			// durable queue persists unacked messages, the recovery
			// call is the safety net for the cases the queue alone
			// doesn't cover (see comment above the restClient).
			//
			// Errors are logged but never bubble up — the live feed
			// already covers the steady state; recovery is a one-shot
			// best-effort top-up.
			log.Info().Str("queue", queueName).Msg("amqp (re)connected")
			afterMs := time.Now().Add(-1 * time.Hour).UnixMilli()
			for _, product := range []string{"pre", "live"} {
				reqID := int(rand.Int31n(1_000_000_000)) //nolint:gosec // not security-sensitive
				if err := restClient.InitiateRecovery(ctx, product, afterMs, reqID); err != nil {
					log.Warn().Err(err).Str("product", product).
						Int64("after_ms", afterMs).Int("request_id", reqID).
						Msg("recovery: initiate_request failed")
					continue
				}
				log.Info().Str("product", product).Int64("after_ms", afterMs).
					Int("request_id", reqID).Msg("recovery: initiate_request sent")
			}
			return nil
		},
		log,
	)
	if err := cons.Run(ctx); err != nil && !errors.Is(err, context.Canceled) {
		log.Error().Err(err).Msg("amqp consumer exited")
	}
}

type healthResp struct {
	Status        string `json:"status"`
	Service       string `json:"service"`
	DB            string `json:"db"`
	Redis         string `json:"redis"`
	UptimeSeconds int64  `json:"uptimeSeconds"`
	Settled       int64  `json:"settled"`
	Cancelled     int64  `json:"cancelled"`
	RolledBack    int64  `json:"rolledBack"`
	Skipped       int64  `json:"skipped"`
	Errors        int64  `json:"errors"`
}

func startHealth(port string, pool *pgxpool.Pool, rdb *redis.Client, stt *settler.Settler, log zerolog.Logger) *http.Server {
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
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(healthResp{
			Status:        status,
			Service:       "settlement",
			DB:            okOrDown(dbOk),
			Redis:         okOrDown(redisOk),
			UptimeSeconds: int64(time.Since(startedAt).Seconds()),
			Settled:       settled,
			Cancelled:     cancelled,
			RolledBack:    rolled,
			Skipped:       skipped,
			Errors:        errs,
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
