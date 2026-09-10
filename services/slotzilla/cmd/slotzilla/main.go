// slotzilla — the 15-second live-basketball slot. Polls Sportradar's open
// statistics host for every confirmed basketball fixture the game runs
// on, stores the play-by-play in sr_live_events, derives the 5-second
// windows, publishes the public state frame, and settles / voids spins on
// the scout's clock through the same apply-once wallet + ledger path
// services/settlement uses. Design: docs/SLOTZILLA.md.
//
// Boot order:
//  1. config.Load() — DATABASE_URL / REDIS_URL required.
//  2. Postgres + Redis connect + ping (fatal on failure).
//  3. /healthz on HEALTH_PORT (default 8088).
//  4. SLOTZILLA_DISABLED=true parks the process on health + status only.
//     Otherwise one engine tick per SLOTZILLA_POLL_INTERVAL_MS; the tick
//     itself idles (config re-read every 5 s) while
//     slotzilla_config.enabled is false.

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

	"github.com/oddzilla/slotzilla/internal/bus"
	"github.com/oddzilla/slotzilla/internal/config"
	"github.com/oddzilla/slotzilla/internal/engine"
	"github.com/oddzilla/slotzilla/internal/sportradar"
	"github.com/oddzilla/slotzilla/internal/store"
)

func main() {
	cfg, err := config.Load()
	if err != nil {
		boot := zerolog.New(os.Stderr).With().Timestamp().Str("service", "slotzilla").Logger()
		boot.Fatal().Err(err).Msg("config")
	}
	log := newLogger(cfg.LogLevel, cfg.ServiceName)

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	pool, err := pgxpool.New(ctx, cfg.DatabaseURL)
	if err != nil {
		log.Fatal().Err(err).Msg("pgxpool")
	}
	defer pool.Close()
	if err := pool.Ping(ctx); err != nil {
		log.Fatal().Err(err).Msg("postgres ping")
	}
	log.Info().Msg("connected to postgres")

	ropt, err := redis.ParseURL(cfg.RedisURL)
	if err != nil {
		log.Fatal().Err(err).Msg("redis url")
	}
	rdb := redis.NewClient(ropt)
	defer rdb.Close()
	if err := rdb.Ping(ctx).Err(); err != nil {
		log.Fatal().Err(err).Msg("redis ping")
	}
	log.Info().Msg("connected to redis")

	st := store.New(pool)
	b := bus.New(rdb)
	client := sportradar.New(cfg.StatsBase, cfg.HTTPTimeout, log)
	eng := engine.New(st, client, b, log, engine.Options{
		ReconcileInterval: cfg.ReconcileInterval,
		MaxConcurrent:     cfg.MaxConcurrentFetches,
		PollInterval:      cfg.PollInterval,
	})

	health := startHealth(cfg, st, b, eng, log)
	defer func() {
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		_ = health.Shutdown(shutdownCtx)
	}()

	if cfg.Disabled {
		log.Warn().Msg("SLOTZILLA_DISABLED=true; idling with health + status only")
		runIdleStatus(ctx, b, cfg, log)
		return
	}

	log.Info().Dur("poll", cfg.PollInterval).Dur("reconcile", cfg.ReconcileInterval).Str("stats_base", cfg.StatsBase).Msg("poll loop started")
	eng.Tick(ctx)
	ticker := time.NewTicker(cfg.PollInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			log.Info().Msg("slotzilla stopped")
			return
		case <-ticker.C:
			eng.Tick(ctx)
		}
	}
}

// runIdleStatus keeps the backoffice hash fresh while the env switch
// parks the service, so the card can tell "switched off" from "down".
func runIdleStatus(ctx context.Context, b *bus.Bus, cfg config.Config, log zerolog.Logger) {
	write := func() {
		wctx, cancel := context.WithTimeout(ctx, 3*time.Second)
		defer cancel()
		fields := map[string]any{
			"updated_unix": time.Now().Unix(),
			"enabled":      0,
			"games":        0,
			"live_games":   0,
			"open_spins":   0,
			"last_error":   "SLOTZILLA_DISABLED=true",
			"poll_ms":      cfg.PollInterval.Milliseconds(),
		}
		if err := b.WriteStatus(wctx, fields); err != nil && ctx.Err() == nil {
			log.Debug().Err(err).Msg("status hash write failed")
		}
	}
	write()
	t := time.NewTicker(5 * time.Second)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			write()
		}
	}
}

type healthResp struct {
	Status        string `json:"status"`
	Service       string `json:"service"`
	DB            string `json:"db"`
	Redis         string `json:"redis"`
	Enabled       bool   `json:"enabled"`  // slotzilla_config.enabled as last read
	Disabled      bool   `json:"disabled"` // SLOTZILLA_DISABLED env switch
	UptimeSeconds int64  `json:"uptimeSeconds"`
	Games         int    `json:"games"`
	LiveGames     int    `json:"liveGames"`
	LastFetchAt   string `json:"lastFetchAt,omitempty"`
	LastError     string `json:"lastError,omitempty"`
}

func startHealth(cfg config.Config, st *store.Store, b *bus.Bus, eng *engine.Engine, log zerolog.Logger) *http.Server {
	startedAt := time.Now()
	mux := http.NewServeMux()
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, r *http.Request) {
		dbOk := st.Ping(r.Context()) == nil
		redisOk := b.Ping(r.Context()) == nil
		status := "ok"
		if !dbOk || !redisOk {
			status = "degraded"
			w.WriteHeader(http.StatusServiceUnavailable)
		}
		h := eng.Health()
		resp := healthResp{
			Status: status, Service: cfg.ServiceName, DB: okOrDown(dbOk), Redis: okOrDown(redisOk),
			Enabled: h.Enabled, Disabled: cfg.Disabled,
			UptimeSeconds: int64(time.Since(startedAt).Seconds()),
			Games:         h.Games, LiveGames: h.LiveGames, LastError: h.LastError,
		}
		if h.LastFetchUnix > 0 {
			resp.LastFetchAt = time.Unix(h.LastFetchUnix, 0).UTC().Format(time.RFC3339)
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(resp)
	})
	srv := &http.Server{Addr: ":" + cfg.HealthPort, Handler: mux, ReadHeaderTimeout: 5 * time.Second}
	go func() {
		log.Info().Str("port", cfg.HealthPort).Msg("health server listening")
		if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Error().Err(err).Msg("health server")
		}
	}()
	return srv
}

func okOrDown(ok bool) string {
	if ok {
		return "ok"
	}
	return "down"
}

func newLogger(levelStr, service string) zerolog.Logger {
	lvl, err := zerolog.ParseLevel(levelStr)
	if err != nil || lvl == zerolog.NoLevel {
		lvl = zerolog.InfoLevel
	}
	zerolog.TimeFieldFormat = time.RFC3339Nano
	return zerolog.New(os.Stdout).Level(lvl).With().Timestamp().Str("service", service).Logger()
}
