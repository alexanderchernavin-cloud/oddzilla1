// bifrost-feed: backup odds + settlement feed sourced from Oddin's Bifrost
// GraphQL API (the white-label esports front end behind maxbet.rs/en/esport).
//
// Boot order:
//  1. Parse env (fail fast on DATABASE_URL / REDIS_URL).
//  2. Open pgxpool + redis; fail if either unreachable.
//  3. Serve /healthz on HEALTH_PORT.
//  4. If BIFROST_API_KEY is empty or BIFROST_MODE=off → log and idle.
//  5. Else run the liveness gate + the Bifrost runner; every synthesised
//     Oddin-shaped message goes to the `oddin.backup` Redis stream.
//
// `-dry-run` skips Postgres and Redis entirely, forces the gate active and
// logs every message it would publish. Use it to eyeball the translation
// against live Bifrost data from a laptop:
//
//	BIFROST_API_KEY=... go run ./cmd/bifrost-feed -dry-run -dry-run-seconds 90

package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/redis/go-redis/v9"
	"github.com/rs/zerolog"

	"github.com/oddzilla/bifrost-feed/internal/bifrost"
	"github.com/oddzilla/bifrost-feed/internal/config"
	"github.com/oddzilla/bifrost-feed/internal/dbstate"
	"github.com/oddzilla/bifrost-feed/internal/feed"
	"github.com/oddzilla/bifrost-feed/internal/gate"
	"github.com/oddzilla/bifrost-feed/internal/publisher"
)

func main() {
	dryRun := flag.Bool("dry-run", false, "connect to Bifrost and log the messages that would be published; no Postgres, no Redis")
	dryRunSeconds := flag.Int("dry-run-seconds", 60, "how long a dry run keeps the socket open")
	flag.Parse()

	if *dryRun {
		// The DB / Redis URLs are required by config.Load; a dry run has
		// neither, so satisfy the parser with placeholders it never dials.
		if os.Getenv("DATABASE_URL") == "" {
			_ = os.Setenv("DATABASE_URL", "postgres://dry-run")
		}
		if os.Getenv("REDIS_URL") == "" {
			_ = os.Setenv("REDIS_URL", "redis://dry-run")
		}
		_ = os.Setenv("BIFROST_MODE", string(config.ModeActive))
	}

	cfg, err := config.Load()
	logger := newLogger(cfg.LogLevel, cfg.ServiceName)
	if err != nil {
		logger.Fatal().Err(err).Msg("config")
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	if *dryRun {
		runDryRun(ctx, cfg, time.Duration(*dryRunSeconds)*time.Second, logger)
		return
	}

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

	var (
		g      *gate.Gate
		runner *feed.Runner
		pub    *publisher.Redis
	)
	switch {
	case cfg.Mode == config.ModeOff:
		logger.Warn().Msg("BIFROST_MODE=off; idling (health endpoint only)")
	case !cfg.Bifrost.Enabled:
		logger.Warn().Msg("BIFROST_API_KEY absent; idling (health endpoint only)")
	default:
		client := bifrost.NewClient(bifrost.ClientConfig{
			URL:    cfg.Bifrost.HTTPURL,
			APIKey: cfg.Bifrost.APIKey,
			Locale: cfg.Bifrost.Locale,
			Origin: cfg.Bifrost.Origin,
		}, logger)
		g = gate.New(rdb, cfg.Mode, time.Duration(cfg.TakeoverAfterSeconds)*time.Second, logger)
		pub = publisher.NewRedis(rdb, logger)
		runner = feed.New(cfg, client, pub, dbstate.New(pool), g, logger)
		go g.Run(ctx)
		go runner.Run(ctx)
		go publishStatus(ctx, pub, g, runner, logger)
		logger.Info().
			Str("mode", string(cfg.Mode)).
			Int("takeover_after_s", cfg.TakeoverAfterSeconds).
			Str("ws", cfg.Bifrost.WSURL).
			Msg("bifrost backup feed started")
	}

	healthSrv := startHealth(cfg.HealthPort, pool, rdb, g, runner, logger)
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

// runDryRun exercises the whole path against live Bifrost data with a
// logging publisher and a permissive DB view, then exits.
func runDryRun(ctx context.Context, cfg config.Config, d time.Duration, logger zerolog.Logger) {
	if !cfg.Bifrost.Enabled {
		logger.Fatal().Msg("dry run needs BIFROST_API_KEY")
	}
	client := bifrost.NewClient(bifrost.ClientConfig{
		URL:    cfg.Bifrost.HTTPURL,
		APIKey: cfg.Bifrost.APIKey,
		Locale: cfg.Bifrost.Locale,
		Origin: cfg.Bifrost.Origin,
	}, logger)
	g := gate.New(nil, config.ModeActive, time.Minute, logger)
	pub := publisher.NewDryRun(logger)
	runner := feed.New(cfg, client, pub, dbstate.Permissive{}, g, logger)
	runCtx, cancel := context.WithTimeout(ctx, d)
	defer cancel()
	go runner.Run(runCtx)
	<-runCtx.Done()
	s := runner.Stats()
	logger.Info().
		Int64("frames", s.Frames).
		Int("tracked", s.Tracked).
		Int64("odds_changes", s.OddsChanges).
		Int64("settlements", s.Settlements).
		Int64("settled_markets", s.SettledMarkets).
		Str("last_error", s.LastError).
		Msg("dry run finished")
}

// publishStatus refreshes the Redis hash the admin backoffice renders.
func publishStatus(ctx context.Context, pub *publisher.Redis, g *gate.Gate, runner *feed.Runner, log zerolog.Logger) {
	t := time.NewTicker(5 * time.Second)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			gs := g.Snapshot()
			rs := runner.Stats()
			fields := map[string]any{
				"mode":              string(gs.Mode),
				"default_mode":      string(gs.DefaultMode),
				"source":            gs.Source,
				"waiting_for_flush": boolStr(gs.WaitingForFlush),
				"primary_connected": boolStr(gs.PrimaryConnected),
				"active":            boolStr(gs.Active),
				"since_unix":        gs.Since.Unix(),
				"connected":         boolStr(rs.Connected),
				"client_id":         rs.ClientID,
				"client_name":       rs.ClientName,
				"tracked":           rs.Tracked,
				"frames":            rs.Frames,
				"reconnects":        rs.Reconnects,
				"odds_changes":      rs.OddsChanges,
				"settlements":       rs.Settlements,
				"settled_markets":   rs.SettledMarkets,
				"fixture_changes":   rs.FixtureChanges,
				"last_frame_unix":   unixOrZero(rs.LastFrameAt),
				"last_publish_unix": unixOrZero(rs.LastPublishAt),
				"last_resync_unix":  unixOrZero(rs.LastResyncAt),
				"last_error":        rs.LastError,
				"last_error_unix":   unixOrZero(rs.LastErrorAt),
				"heartbeat_unix":    time.Now().Unix(),
				"takeover_after_s":  gs.TakeoverAfterSeconds,
				"gate_transitions":  gs.Transitions,
			}
			if err := pub.WriteStatus(ctx, fields); err != nil {
				log.Debug().Err(err).Msg("status hash write failed")
			}
		}
	}
}

type healthResp struct {
	Status        string       `json:"status"`
	Service       string       `json:"service"`
	DB            string       `json:"db"`
	Redis         string       `json:"redis"`
	UptimeSeconds int64        `json:"uptimeSeconds"`
	Gate          *gate.Status `json:"gate,omitempty"`
	Feed          *feed.Stats  `json:"feed,omitempty"`
}

func startHealth(port string, pool *pgxpool.Pool, rdb *redis.Client, g *gate.Gate, runner *feed.Runner, log zerolog.Logger) *http.Server {
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
		resp := healthResp{
			Status:        status,
			Service:       "bifrost-feed",
			DB:            okOrDown(dbOk),
			Redis:         okOrDown(redisOk),
			UptimeSeconds: int64(time.Since(startedAt).Seconds()),
		}
		if g != nil {
			gs := g.Snapshot()
			resp.Gate = &gs
		}
		if runner != nil {
			rs := runner.Stats()
			resp.Feed = &rs
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(resp)
	})
	srv := &http.Server{
		Addr:              ":" + port,
		Handler:           mux,
		ReadHeaderTimeout: 5 * time.Second,
	}
	go func() {
		log.Info().Str("port", port).Msg("health server listening")
		if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
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

func boolStr(b bool) string {
	if b {
		return "1"
	}
	return "0"
}

func unixOrZero(t time.Time) int64 {
	if t.IsZero() {
		return 0
	}
	return t.Unix()
}
