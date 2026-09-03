// fonbet-ingester — polls the public Fonbet KZ line and writes it into the
// oddzilla catalog (sports, tournaments, matches, markets, outcomes,
// odds_history) + Redis (odds.raw stream, odds:match:{id} pub/sub), so the
// existing odds-publisher → ws-gateway → storefront chain serves
// traditional sports next to Oddin's esports.
//
// Boot order:
//  1. config.Load() — DATABASE_URL / REDIS_URL required.
//  2. Postgres + Redis connect + ping (fatal on failure).
//  3. /healthz on HEALTH_PORT (default 8087).
//  4. If FONBET_ENABLED != true → idle (health only).
//  5. Discover line hosts, fetch the factor catalogue (FONBET_LANG + en),
//     write market/outcome descriptions, load previous state from pg.
//  6. Poll loop every FONBET_POLL_INTERVAL_MS; staleness watchdog suspends
//     the Fonbet catalog when no snapshot lands for FONBET_STALE_SUSPEND_SECONDS.
//  7. SIGINT/SIGTERM → suspend the Fonbet catalog (odds would otherwise
//     freeze while the container is down) and exit.

package main

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"os"
	"os/signal"
	"sync/atomic"
	"syscall"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/redis/go-redis/v9"
	"github.com/rs/zerolog"

	"github.com/oddzilla/fonbet-ingester/internal/bus"
	"github.com/oddzilla/fonbet-ingester/internal/config"
	"github.com/oddzilla/fonbet-ingester/internal/fonbet"
	"github.com/oddzilla/fonbet-ingester/internal/ingest"
	"github.com/oddzilla/fonbet-ingester/internal/mapper"
	"github.com/oddzilla/fonbet-ingester/internal/settle"
	"github.com/oddzilla/fonbet-ingester/internal/store"
)

var (
	lastSnapshotUnix atomic.Int64
	cycleInFlight    atomic.Bool
	lastMatches      atomic.Int64
	lastOutcomes     atomic.Int64
	catalogSuspended atomic.Bool
)

func main() {
	cfg, err := config.Load()
	if err != nil {
		boot := zerolog.New(os.Stderr).With().Timestamp().Str("service", "fonbet-ingester").Logger()
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
	health := startHealth(cfg.HealthPort, pool, rdb, cfg.Fonbet.Enabled, log)
	defer func() {
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		_ = health.Shutdown(shutdownCtx)
	}()

	if !cfg.Fonbet.Enabled {
		log.Warn().Msg("FONBET_ENABLED is not true — idling with health endpoint only")
		<-ctx.Done()
		return
	}

	client := fonbet.New(fonbet.Config{
		URLsJSON:    cfg.Fonbet.URLsJSON,
		Hosts:       cfg.Fonbet.Hosts,
		CommonHosts: cfg.Fonbet.CommonHosts,
		Lang:        cfg.Fonbet.Lang,
		ScopeMarket: cfg.Fonbet.ScopeMarket,
		Timeout:     cfg.Fonbet.HTTPTimeout,
	}, log)
	if err := client.DiscoverHosts(ctx); err != nil {
		log.Warn().Err(err).Msg("host discovery failed; using static hosts")
	}

	opt := mapper.Options{
		BlockedSports:    cfg.Fonbet.BlockedSportIDs,
		AllowedSports:    cfg.Fonbet.AllowedSportIDs,
		IncludeSubEvents: cfg.Fonbet.IncludeSubEvents,
		MaxMatches:       cfg.Fonbet.MaxMatches,
	}
	ing := ingest.New(st, b, log)

	// Catalogue in the feed language (labels used for variant rows) plus
	// English for the default storefront locale.
	idx, err := loadCatalog(ctx, client, cfg.Fonbet.Lang, log)
	if err != nil {
		log.Fatal().Err(err).Msg("factor catalogue")
	}
	if err := ing.WriteStaticDescriptions(ctx, mapper.StaticDescriptions(idx, opt)); err != nil {
		log.Fatal().Err(err).Msg("write descriptions")
	}
	if cfg.Fonbet.Lang != "en" {
		if idxEN, err := loadCatalog(ctx, client, "en", log); err != nil {
			log.Warn().Err(err).Msg("english catalogue unavailable; storefront falls back to feed language")
		} else if err := ing.WriteStaticDescriptions(ctx, mapper.StaticDescriptions(idxEN, opt)); err != nil {
			log.Warn().Err(err).Msg("write english descriptions")
		}
	}
	if err := ing.Bootstrap(ctx); err != nil {
		log.Fatal().Err(err).Msg("bootstrap previous state")
	}
	// Logos are applied after the first cycle has created the rows (see the
	// loop below) and refreshed every 6 h alongside the catalogue.
	var logos *fonbet.Logos
	if l, err := client.FetchLogos(ctx); err != nil {
		log.Warn().Err(err).Msg("logo catalogue unavailable; entities keep initials")
	} else {
		logos = l
		log.Info().Int("teams", len(l.Teams)).Int("competitions", len(l.Competitions)).Int("sports", len(l.Sports)).Msg("logo catalogue loaded")
	}

	go runWatchdog(ctx, ing, cfg.Fonbet.StaleSuspendAfter, log)
	go runHostRefresh(ctx, client, log)

	// Results-based settlement: closed matches → Fonbet results feed →
	// graded markets → settlement.external stream → services/settlement.
	var indexPtr atomic.Pointer[fonbet.Index]
	indexPtr.Store(idx)
	if cfg.Fonbet.SettleEnabled {
		worker := settle.New(st, b, client, &indexPtr, cfg.Fonbet.Lang, log)
		go worker.Run(ctx, cfg.Fonbet.SettleInterval)
		log.Info().Dur("interval", cfg.Fonbet.SettleInterval).Msg("settlement worker started")
	} else {
		log.Warn().Msg("FONBET_SETTLE_ENABLED=false — fonbet markets will not be settled automatically")
	}

	log.Info().Dur("interval", cfg.Fonbet.PollInterval).Int("scope_market", cfg.Fonbet.ScopeMarket).Msg("poll loop started")
	ticker := time.NewTicker(cfg.Fonbet.PollInterval)
	defer ticker.Stop()
	catalogRefresh := time.NewTicker(6 * time.Hour)
	defer catalogRefresh.Stop()
	logoTicker := time.NewTicker(10 * time.Minute) // cheap: only NULL logo rows are touched
	defer logoTicker.Stop()
	for {
		cycle(ctx, client, idx, opt, ing, log)
		if logos != nil {
			// Right after a cycle every new sport / team / tournament row
			// exists, so the first pass and each periodic pass fill gaps.
			if err := ing.ApplyLogos(ctx, logos); err != nil {
				log.Warn().Err(err).Msg("apply logos")
			}
			logos = nil
		}
		select {
		case <-ctx.Done():
			// Container going down: suspend so nothing quotes frozen odds
			// while we're away. The first cycle after restart re-activates.
			sctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
			if err := ing.SuspendAll(sctx, time.Now().UnixMilli()); err != nil {
				log.Error().Err(err).Msg("suspend on shutdown")
			}
			cancel()
			log.Info().Msg("shutdown")
			return
		case <-catalogRefresh.C:
			if fresh, err := loadCatalog(ctx, client, cfg.Fonbet.Lang, log); err == nil {
				idx = fresh
				indexPtr.Store(fresh)
				if err := ing.WriteStaticDescriptions(ctx, mapper.StaticDescriptions(idx, opt)); err != nil {
					log.Warn().Err(err).Msg("refresh descriptions")
				}
			}
		case <-logoTicker.C:
			if l, err := client.FetchLogos(ctx); err != nil {
				log.Warn().Err(err).Msg("logo refresh failed")
			} else {
				logos = l // applied right after the next cycle
			}
		case <-ticker.C:
		}
	}
}

func cycle(ctx context.Context, client *fonbet.Client, idx *fonbet.Index, opt mapper.Options, ing *ingest.Ingester, log zerolog.Logger) {
	cycleInFlight.Store(true)
	defer cycleInFlight.Store(false)
	t0 := time.Now()
	resp, err := client.FetchList(ctx)
	if err != nil {
		if ctx.Err() == nil {
			log.Error().Err(err).Msg("fetch events/list failed")
		}
		return
	}
	snap := mapper.Build(resp, idx, opt)
	stats, err := ing.Apply(ctx, snap, time.Now().UnixMilli())
	if err != nil {
		log.Error().Err(err).Msg("apply snapshot failed")
		return
	}
	lastSnapshotUnix.Store(time.Now().Unix())
	lastMatches.Store(int64(stats.Matches))
	outcomes := 0
	for _, m := range snap.Matches {
		for _, mk := range m.Markets {
			outcomes += len(mk.Outcomes)
		}
	}
	lastOutcomes.Store(int64(outcomes))
	catalogSuspended.Store(false)
	ev := log.Info().
		Dur("took", time.Since(t0)).
		Int64("packet", snap.PacketVersion).
		Int("matches", stats.Matches).
		Int("new_matches", stats.NewMatches).
		Int("closed", stats.ClosedMatches).
		Int("markets_up", stats.MarketsUpserted).
		Int("markets_off", stats.MarketsDeactivated).
		Int("outcomes_up", stats.OutcomesUpserted).
		Int("outcomes_off", stats.OutcomesDeactivated).
		Int("odds_events", stats.OddsEvents).
		Int("failed", stats.Failed)
	if len(stats.Skipped) > 0 {
		ev = ev.Interface("skipped", stats.Skipped)
	}
	ev.Msg("cycle")
}

func loadCatalog(ctx context.Context, client *fonbet.Client, lang string, log zerolog.Logger) (*fonbet.Index, error) {
	cat, err := client.FetchCatalog(ctx, lang)
	if err != nil {
		return nil, err
	}
	if cat.Lang == "" {
		cat.Lang = lang
	}
	idx := fonbet.BuildIndex(cat)
	log.Info().Str("lang", lang).Int("tables", len(idx.Tables)).Int("factors", len(idx.Factors)).Msg("factor catalogue loaded")
	return idx, nil
}

// runWatchdog suspends the Fonbet catalog when no snapshot has been
// applied for `staleAfter` (host outage, geo-block, Fonbet maintenance).
func runWatchdog(ctx context.Context, ing *ingest.Ingester, staleAfter time.Duration, log zerolog.Logger) {
	if staleAfter <= 0 {
		return
	}
	startedAt := time.Now()
	t := time.NewTicker(5 * time.Second)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case now := <-t.C:
			last := lastSnapshotUnix.Load()
			var silence time.Duration
			if last > 0 {
				silence = now.Sub(time.Unix(last, 0))
			} else {
				silence = now.Sub(startedAt)
			}
			// A cycle still running is not silence: the cold-start Apply of a
			// full line can outlast the threshold, and Apply/SuspendAll are
			// serialised by the ingester's mutex anyway.
			if silence >= staleAfter && !ing.Suspended() && !cycleInFlight.Load() {
				log.Error().Dur("silence", silence).Msg("no snapshot past threshold; suspending fonbet catalog")
				if err := ing.SuspendAll(ctx, now.UnixMilli()); err != nil {
					log.Error().Err(err).Msg("watchdog suspend failed")
				} else {
					catalogSuspended.Store(true)
				}
			}
		}
	}
}

func runHostRefresh(ctx context.Context, client *fonbet.Client, log zerolog.Logger) {
	t := time.NewTicker(6 * time.Hour)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			if err := client.DiscoverHosts(ctx); err != nil {
				log.Warn().Err(err).Msg("host refresh failed")
			}
		}
	}
}

type healthResp struct {
	Status           string `json:"status"`
	Service          string `json:"service"`
	DB               string `json:"db"`
	Redis            string `json:"redis"`
	Enabled          bool   `json:"enabled"`
	UptimeSeconds    int64  `json:"uptimeSeconds"`
	LastSnapshotAt   string `json:"lastSnapshotAt,omitempty"`
	StaleSeconds     *int64 `json:"snapshotStaleSeconds,omitempty"`
	Matches          int64  `json:"matches"`
	Outcomes         int64  `json:"outcomes"`
	CatalogSuspended bool   `json:"catalogSuspended"`
}

func startHealth(port string, pool *pgxpool.Pool, rdb *redis.Client, enabled bool, log zerolog.Logger) *http.Server {
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
			Status: status, Service: "fonbet-ingester", DB: okOrDown(dbOk), Redis: okOrDown(redisOk),
			Enabled: enabled, UptimeSeconds: int64(time.Since(startedAt).Seconds()),
			Matches: lastMatches.Load(), Outcomes: lastOutcomes.Load(), CatalogSuspended: catalogSuspended.Load(),
		}
		if ts := lastSnapshotUnix.Load(); ts > 0 {
			resp.LastSnapshotAt = time.Unix(ts, 0).UTC().Format(time.RFC3339)
			stale := int64(time.Since(time.Unix(ts, 0)).Seconds())
			resp.StaleSeconds = &stale
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(resp)
	})
	srv := &http.Server{Addr: ":" + port, Handler: mux, ReadHeaderTimeout: 5 * time.Second}
	go func() {
		log.Info().Str("port", port).Msg("health server listening")
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
