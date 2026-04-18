// feed-ingester: Oddin AMQP consumer + Postgres + Redis Streams writer.
//
// Boot order:
//   1. Parse env (fail fast on DATABASE_URL / REDIS_URL).
//   2. Open pgxpool + redis clients; fail if either unreachable.
//   3. Serve /healthz on HEALTH_PORT.
//   4. Resolve fallback sport/category (seed guarantees CS2 dummy category).
//   5. If Oddin creds present → start AMQP consumer. Else → log and idle.
//   6. Block on SIGINT/SIGTERM.

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

	amqpkit "github.com/oddzilla/feed-ingester/internal/amqp"
	"github.com/oddzilla/feed-ingester/internal/automap"
	"github.com/oddzilla/feed-ingester/internal/bus"
	"github.com/oddzilla/feed-ingester/internal/config"
	"github.com/oddzilla/feed-ingester/internal/oddinrest"
	"github.com/oddzilla/feed-ingester/internal/handler"
	"github.com/oddzilla/feed-ingester/internal/store"
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

	// ── Store + resolver + bus ─────────────────────────────────────────
	st := store.New(pool)
	oddsBus := bus.New(rdb)

	// Fallback sport + category for unknown-tournament branches. Any of
	// the four MVP esports work; we pick CS2 as the conventional default
	// since its seed slug is deterministic.
	fallbackSportID, fallbackCategoryID, err := resolveFallback(ctx, st)
	if err != nil {
		logger.Fatal().Err(err).Msg("resolve fallback sport/category (run `make seed`?)")
	}
	logger.Info().
		Int("sport_id", fallbackSportID).
		Int("category_id", fallbackCategoryID).
		Msg("fallback sport/category resolved")

	// REST client for auto-mapping unknown match URNs. Optional — when
	// the token is absent the resolver runs in fallback-only mode.
	var restClient *oddinrest.Client
	if cfg.Oddin.Token != "" {
		rc, rerr := oddinrest.New(oddinrest.Config{
			BaseURL: cfg.Oddin.RESTBaseURL,
			Token:   cfg.Oddin.Token,
		})
		if rerr != nil {
			logger.Warn().Err(rerr).Msg("oddin rest client init failed; auto-mapping will use placeholders")
		} else {
			restClient = rc
		}
	}
	resolver := automap.New(st, restClient, logger.With().Str("component", "automap").Logger(), fallbackSportID, fallbackCategoryID)

	deps := handler.Deps{
		Store:    st,
		Resolver: resolver,
		Bus:      oddsBus,
		Log:      logger,
	}

	// ── Health server ──────────────────────────────────────────────────
	healthSrv := startHealth(cfg.HealthPort, pool, rdb, logger)
	defer func() {
		shutCtx, shutCancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer shutCancel()
		_ = healthSrv.Shutdown(shutCtx)
	}()

	// ── AMQP (optional) ────────────────────────────────────────────────
	if !cfg.Oddin.Enabled {
		logger.Warn().Msg("Oddin creds absent (ODDIN_TOKEN/ODDIN_CUSTOMER_ID); running idle — health endpoint only")
	} else {
		go runAMQP(ctx, cfg, deps, logger)
	}

	// ── Wait for signal ────────────────────────────────────────────────
	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)
	<-sigCh
	logger.Info().Msg("shutting down")
	cancel()
}

func runAMQP(ctx context.Context, cfg config.Config, deps handler.Deps, log zerolog.Logger) {
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
			return handler.Handle(ctx, deps, rk, body)
		},
		func(ctx context.Context) error {
			// Snapshot recovery hook. For phase 3 we log only; the REST
			// client is ready, but wiring per-fixture recovery requires
			// the market_descriptions + fixtures pre-fetch that lands in
			// a phase-3 follow-up ticket (flagged in docs/ODDIN.md).
			log.Info().Msg("amqp (re)connected; snapshot recovery not yet wired")
			return nil
		},
		log,
	)

	if err := cons.Run(ctx); err != nil && !errors.Is(err, context.Canceled) {
		log.Error().Err(err).Msg("amqp consumer exited")
	}
}

func resolveFallback(ctx context.Context, st *store.Store) (int, int, error) {
	// CS2 is always seeded. Any other esport works too; we just need *some*
	// sport id + dummy category id for automap's unknown-tournament path.
	sportID, ok, err := store.FindSportBySlug(ctx, st.Pool(), "cs2")
	if err != nil {
		return 0, 0, err
	}
	if !ok {
		return 0, 0, errors.New("sport 'cs2' not found — run `make seed` first")
	}
	categoryID, err := store.FindDummyCategoryForSport(ctx, st.Pool(), sportID)
	if err != nil {
		return 0, 0, err
	}
	return sportID, categoryID, nil
}

// ─── Health + logging ──────────────────────────────────────────────────────

type healthResp struct {
	Status        string `json:"status"`
	Service       string `json:"service"`
	DB            string `json:"db"`
	Redis         string `json:"redis"`
	UptimeSeconds int64  `json:"uptimeSeconds"`
}

func startHealth(port string, pool *pgxpool.Pool, rdb *redis.Client, log zerolog.Logger) *http.Server {
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
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(healthResp{
			Status:        status,
			Service:       "feed-ingester",
			DB:            okOrDown(dbOk),
			Redis:         okOrDown(redisOk),
			UptimeSeconds: int64(time.Since(startedAt).Seconds()),
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
