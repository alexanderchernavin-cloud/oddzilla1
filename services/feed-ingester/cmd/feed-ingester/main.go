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
	"encoding/xml"
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
	"github.com/oddzilla/feed-ingester/internal/handler"
	"github.com/oddzilla/feed-ingester/internal/oddinrest"
	"github.com/oddzilla/feed-ingester/internal/oddinxml"
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

	// Fallback sport + category for unknown-tournament branches. Any
	// seeded sport works; we pick CS2 as the conventional default since
	// its seed slug is deterministic.
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
	resolver := automap.New(
		st,
		restClient,
		logger.With().Str("component", "automap").Logger(),
		fallbackSportID,
		fallbackCategoryID,
		cfg.Oddin.BlockedSportSlugs,
	)
	if len(cfg.Oddin.BlockedSportSlugs) == 0 {
		logger.Warn().Msg("sport blocklist disabled — every Oddin sport will be persisted")
	} else {
		blocked := make([]string, 0, len(cfg.Oddin.BlockedSportSlugs))
		for slug := range cfg.Oddin.BlockedSportSlugs {
			blocked = append(blocked, slug)
		}
		logger.Info().Strs("sports", blocked).Msg("sport blocklist active")
	}

	deps := handler.Deps{
		Store:    st,
		Resolver: resolver,
		Bus:      oddsBus,
		Log:      logger,
		Rest:     restClient,
		NodeID:   cfg.Oddin.NodeID,
		Alive:    handler.NewAliveState(),
	}

	// ── Health server ──────────────────────────────────────────────────
	healthSrv := startHealth(cfg.HealthPort, pool, rdb, logger)
	defer func() {
		shutCtx, shutCancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer shutCancel()
		_ = healthSrv.Shutdown(shutCtx)
	}()

	// ── Feed message cleanup (always on) ───────────────────────────────
	// Even with the feed disabled there may be stale rows left from a
	// previous run; a small hourly sweep keeps the table bounded.
	go runFeedMessageCleanup(ctx, st, logger)

	// ── AMQP (optional) ────────────────────────────────────────────────
	if !cfg.Oddin.Enabled {
		logger.Warn().Msg("Oddin creds absent (ODDIN_TOKEN/ODDIN_CUSTOMER_ID); running idle — health endpoint only")
	} else {
		go runAMQP(ctx, cfg, deps, logger)
		// Background sweeper: any market stuck at status=-2 (handed over
		// from pre-match to live) for more than 60s gets demoted to -1
		// (suspended). Per Oddin docs §1.4 — if the live producer doesn't
		// pick up within "a reasonable time" we should treat the market as
		// suspended so bet placement keeps rejecting cleanly.
		go runHandoverSweeper(ctx, st, logger)
		// LISTEN on feed_recovery so an admin can trigger a full Oddin
		// replay without restarting the container. The API's
		// POST /admin/feed/recovery rewinds `amqp_state.after_ts` and
		// fires pg_notify('feed_recovery', ...); TriggerRecovery reads
		// the fresh cursor and issues InitiateRecovery to Oddin.
		go runRecoveryListener(ctx, pool, deps, logger)
		if restClient != nil {
			// Market descriptions refresh. Runs once synchronously on
			// boot (so the cache is warm before any /match/:id request
			// lands) and then every few hours. The endpoint returns ~80
			// KB of XML and changes rarely, so we don't need a tight
			// cadence. Failures are logged but never fatal — stale
			// descriptions are better than no descriptions.
			if err := refreshMarketDescriptions(ctx, restClient, st, cfg.Oddin.Lang, logger); err != nil {
				logger.Warn().Err(err).Msg("initial market descriptions refresh failed; UI will fall back to ids")
			}
			go runDescriptionsRefresher(ctx, restClient, st, cfg.Oddin.Lang, logger)
			// Backfill competitor profiles for any active match whose
			// teams we haven't fetched yet. Fire-and-forget because
			// there can be hundreds of URNs — a fresh boot with no
			// cache shouldn't hold up the main AMQP loop.
			go backfillCompetitorProfiles(ctx, resolver, st, logger)
		}
	}

	// ── Wait for signal ────────────────────────────────────────────────
	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)
	<-sigCh
	logger.Info().Msg("shutting down")
	cancel()
}

// refreshMarketDescriptions fetches Oddin's market/outcome description
// catalog and upserts it to Postgres. Idempotent; safe to call on boot
// and again on every refresh tick. Errors are wrapped with enough
// context for the caller to log + proceed.
func refreshMarketDescriptions(ctx context.Context, rc *oddinrest.Client, st *store.Store, lang string, log zerolog.Logger) error {
	body, err := rc.MarketDescriptions(ctx, lang)
	if err != nil {
		return err
	}
	var parsed oddinxml.MarketDescriptions
	if err := xml.Unmarshal(body, &parsed); err != nil {
		return err
	}
	if err := store.UpsertMarketDescriptions(ctx, st.Pool(), parsed.Markets); err != nil {
		return err
	}
	n, _ := store.CountMarketDescriptions(ctx, st.Pool())
	log.Info().
		Int("markets_seen", len(parsed.Markets)).
		Int("rows_in_cache", n).
		Msg("market descriptions refreshed")
	return nil
}

// runDescriptionsRefresher refreshes the market description cache every
// 6 hours. First refresh happens in main() before this goroutine starts,
// so the cache is warm immediately; this loop just keeps it current.
func runDescriptionsRefresher(ctx context.Context, rc *oddinrest.Client, st *store.Store, lang string, log zerolog.Logger) {
	const refreshEvery = 6 * time.Hour
	t := time.NewTicker(refreshEvery)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			if err := refreshMarketDescriptions(ctx, rc, st, lang, log); err != nil {
				log.Warn().Err(err).Msg("market descriptions refresh failed")
			}
		}
	}
}

// backfillCompetitorProfiles fetches the competitor profile for every
// active-match home/away team URN that isn't already cached. Paces the
// REST calls so we don't burst into Oddin's rate limiter — 20 per second
// is well under their per-endpoint ceiling.
func backfillCompetitorProfiles(ctx context.Context, res *automap.Resolver, st *store.Store, log zerolog.Logger) {
	urns, err := store.MissingCompetitorURNs(ctx, st.Pool())
	if err != nil {
		log.Warn().Err(err).Msg("competitor profile backfill query failed")
		return
	}
	if len(urns) == 0 {
		log.Info().Msg("competitor profile cache already current")
		return
	}
	log.Info().Int("count", len(urns)).Msg("competitor profile backfill starting")
	tick := time.NewTicker(50 * time.Millisecond)
	defer tick.Stop()
	for _, urn := range urns {
		select {
		case <-ctx.Done():
			return
		case <-tick.C:
		}
		res.CacheCompetitorProfile(ctx, urn)
	}
	log.Info().Int("count", len(urns)).Msg("competitor profile backfill complete")
}

// runRecoveryListener subscribes to Postgres notifications on the
// `feed_recovery` channel. Each NOTIFY triggers a fresh recovery for
// both Oddin producers, using whatever cursor timestamp the operator
// wrote into `amqp_state.after_ts` (the API endpoint handles the
// rewind). Reconnects with 2 s backoff on error; a dead listener is
// not fatal for ingest.
func runRecoveryListener(ctx context.Context, pool *pgxpool.Pool, deps handler.Deps, log zerolog.Logger) {
	for ctx.Err() == nil {
		if err := listenRecoveryOnce(ctx, pool, deps, log); err != nil && !errors.Is(err, context.Canceled) {
			log.Warn().Err(err).Msg("feed_recovery LISTEN errored; reconnecting in 2s")
			select {
			case <-ctx.Done():
				return
			case <-time.After(2 * time.Second):
			}
		}
	}
}

func listenRecoveryOnce(ctx context.Context, pool *pgxpool.Pool, deps handler.Deps, log zerolog.Logger) error {
	conn, err := pool.Acquire(ctx)
	if err != nil {
		return err
	}
	defer conn.Release()
	if _, err := conn.Exec(ctx, "LISTEN feed_recovery"); err != nil {
		return err
	}
	log.Info().Msg("listening on feed_recovery channel")
	for ctx.Err() == nil {
		n, err := conn.Conn().WaitForNotification(ctx)
		if err != nil {
			if errors.Is(err, context.Canceled) {
				return nil
			}
			return err
		}
		if n == nil {
			continue
		}
		log.Info().Str("payload", n.Payload).Msg("feed_recovery notification received")
		handler.TriggerRecovery(ctx, deps, log)
	}
	return nil
}

// runFeedMessageCleanup sweeps the feed_messages table once per hour.
// Rows whose match's scheduled_at + 24h is in the past get deleted;
// unmatched rows older than 48h are also purged as a hard safety bound.
// Admin /admin/logs only surfaces matches that are still within their
// window, so anything older is effectively invisible anyway.
func runFeedMessageCleanup(ctx context.Context, st *store.Store, log zerolog.Logger) {
	const sweepEvery = 1 * time.Hour
	// Run once on boot so a long-stopped instance doesn't carry a
	// backlog into the first live tick.
	if n, err := store.SweepFeedMessages(ctx, st.Pool()); err != nil {
		log.Warn().Err(err).Msg("feed_messages initial sweep failed")
	} else if n > 0 {
		log.Info().Int64("deleted", n).Msg("feed_messages initial sweep")
	}
	t := time.NewTicker(sweepEvery)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			n, err := store.SweepFeedMessages(ctx, st.Pool())
			if err != nil {
				log.Warn().Err(err).Msg("feed_messages sweep failed")
				continue
			}
			if n > 0 {
				log.Info().Int64("deleted", n).Msg("feed_messages hourly sweep")
			}
		}
	}
}

// runHandoverSweeper polls every 15s and demotes markets stuck at -2
// for >60s to -1. Single-statement update; no contention with the
// AMQP-driven UpsertMarket path (any in-flight odds_change would just
// re-set the status from the latest message anyway).
func runHandoverSweeper(ctx context.Context, st *store.Store, log zerolog.Logger) {
	const (
		sweepEvery        = 15 * time.Second
		handoverTimeoutMs = int64(60_000) // 60s per Oddin docs
	)
	t := time.NewTicker(sweepEvery)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			n, err := store.SweepHandoverTimeouts(ctx, st.Pool(), handoverTimeoutMs)
			if err != nil {
				log.Warn().Err(err).Msg("handover sweep failed")
				continue
			}
			if n > 0 {
				log.Info().Int64("demoted", n).Msg("handover sweep: -2 markets timed out → -1 (suspended)")
			}
		}
	}
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
			// On (re)connect: ask Oddin to replay any messages we missed
			// since our last cursor. Per the docs we issue one request
			// per producer ("pre" + "live"). The replay arrives via AMQP
			// and ends with a snapshot_complete message we already handle.
			if deps.Rest == nil {
				log.Info().Msg("amqp (re)connected; recovery skipped (no rest client)")
				return nil
			}
			handler.TriggerRecovery(ctx, deps, log)
			return nil
		},
		log,
	)

	if err := cons.Run(ctx); err != nil && !errors.Is(err, context.Canceled) {
		log.Error().Err(err).Msg("amqp consumer exited")
	}
}

func resolveFallback(ctx context.Context, st *store.Store) (int, int, error) {
	// Fallback sport for matches whose Oddin fixture lookup fails.
	// Migration 0004 creates `unclassified` with active=FALSE so these
	// matches never appear on the public catalog. Previously we used `cs2`
	// which polluted the CS2 page with soccer/eFootball test data.
	sportID, ok, err := store.FindSportBySlug(ctx, st.Pool(), "unclassified")
	if err != nil {
		return 0, 0, err
	}
	if !ok {
		return 0, 0, errors.New("sport 'unclassified' not found — run migrations (0004)")
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
