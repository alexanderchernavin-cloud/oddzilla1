// fonbet-ingester — polls the public Fonbet KZ line and writes it into the
// oddzilla catalog (sports, tournaments, matches, markets, outcomes,
// odds_history) + Redis (odds.raw stream, odds:match:{id} pub/sub), so the
// existing odds-publisher → ws-gateway → storefront chain serves
// traditional sports next to Oddin's esports.
//
// Boot order:
//  1. config.Load() — DATABASE_URL / REDIS_URL required.
//  2. Postgres + Redis connect + ping (fatal on failure).
//  3. /healthz on HEALTH_PORT (default 8087); status hash for the
//     backoffice card refreshed every 5 s.
//  4. Control loop: the operator switch in feed_control.fonbet_enabled
//     (PUT /admin/feed/fonbet, migration 0099) is read every 2 s; NULL
//     means "follow FONBET_ENABLED". While OFF the service idles (health +
//     status only). When it turns ON: discover line hosts, fetch the
//     factor catalogue (FONBET_LANG + en), write market / outcome
//     descriptions, load previous state from pg, then poll every
//     FONBET_POLL_INTERVAL_MS with the staleness watchdog armed.
//  5. When the switch turns OFF (or on SIGINT/SIGTERM): suspend the whole
//     Fonbet catalog so nothing quotes frozen odds, stop polling, and
//     acknowledge the position in feed_control.fonbet_applied_*. The
//     first cycle after ON re-activates whatever Fonbet still quotes.

package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"os/signal"
	"sync"
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

	// feedRunning: the poll loop is active (switch ON and boot succeeded).
	feedRunning atomic.Bool
	// effectiveEnabled: COALESCE(admin switch, FONBET_ENABLED), i.e. what
	// the service is trying to do right now.
	effectiveEnabled atomic.Bool
	// switchFromAdmin: the effective position came from feed_control rather
	// than the env default.
	switchFromAdmin atomic.Bool

	lastErrorMu   sync.Mutex
	lastErrorMsg  string
	lastErrorUnix int64
)

// switchPollInterval mirrors feed-ingester's runSourceSwitch cadence.
const switchPollInterval = 2 * time.Second

// bootRetryAfter is the pause before retrying runFeed after a boot failure
// (Fonbet catalogue unreachable, Postgres hiccup) while the switch is ON.
// A log.Fatal here would crashloop the container with the switch design.
const bootRetryAfter = 30 * time.Second

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
	b := bus.New(rdb, cfg.Fonbet.OddsPublisherGroup)
	health := startHealth(cfg.HealthPort, pool, rdb, log)
	defer func() {
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		_ = health.Shutdown(shutdownCtx)
	}()
	go runStatusWriter(ctx, b, cfg, log)

	sw := newSwitchWatcher(pool, cfg.Fonbet.Enabled, log)
	for {
		if ctx.Err() != nil {
			return
		}
		if !sw.current(ctx) {
			sw.ack(ctx, false)
			if !feedRunning.Load() {
				log.Warn().Bool("env_default", cfg.Fonbet.Enabled).Bool("from_admin", switchFromAdmin.Load()).
					Msg("fonbet feed is OFF — idling with health endpoint only (switch on at /admin/feed or set FONBET_ENABLED=true)")
			}
			if !sw.waitUntil(ctx, true) {
				return // shutting down
			}
			log.Warn().Msg("fonbet feed switched ON")
			continue
		}

		// ON: run the feed until the switch flips off or we are shutting
		// down. A goroutine watches the switch and cancels runCtx; runFeed
		// suspends the catalog on the way out either way.
		runCtx, cancel := context.WithCancel(ctx)
		go func() {
			if sw.waitUntil(runCtx, false) {
				log.Warn().Msg("fonbet feed switched OFF: suspending the catalog and stopping the poll loop")
				cancel()
			}
		}()
		err := runFeed(runCtx, cfg, st, b, log, func() { sw.ack(ctx, true) })
		cancel()
		if ctx.Err() != nil {
			return
		}
		if err != nil {
			recordError(err)
			log.Error().Err(err).Dur("retry_in", bootRetryAfter).Msg("fonbet feed failed to start; retrying while the switch stays on")
			select {
			case <-ctx.Done():
				return
			case <-time.After(bootRetryAfter):
			}
		}
	}
}

// switchWatcher resolves the effective on/off position: the operator's
// feed_control.fonbet_enabled when set, otherwise the FONBET_ENABLED env
// default. It also acknowledges transitions in feed_control.fonbet_applied_*.
type switchWatcher struct {
	pool       *pgxpool.Pool
	envDefault bool
	log        zerolog.Logger

	mu        sync.Mutex
	last      bool // last resolved position (falls back here on read errors)
	lastAck   *bool
	errLogged time.Time
}

func newSwitchWatcher(pool *pgxpool.Pool, envDefault bool, log zerolog.Logger) *switchWatcher {
	effectiveEnabled.Store(envDefault)
	return &switchWatcher{pool: pool, envDefault: envDefault, last: envDefault, log: log.With().Str("component", "fonbet-switch").Logger()}
}

// current reads the switch once. A read error keeps the previous position
// (logged at most once a minute) so a Postgres blip cannot flap the feed.
func (w *switchWatcher) current(ctx context.Context) bool {
	w.mu.Lock()
	defer w.mu.Unlock()
	v, err := store.ReadFonbetSwitch(ctx, w.pool)
	if err != nil {
		if ctx.Err() == nil && time.Since(w.errLogged) > time.Minute {
			w.log.Warn().Err(err).Bool("keeping", w.last).Msg("fonbet switch read failed; keeping the previous position")
			w.errLogged = time.Now()
		}
		return w.last
	}
	enabled := w.envDefault
	if v != nil {
		enabled = *v
	}
	w.last = enabled
	effectiveEnabled.Store(enabled)
	switchFromAdmin.Store(v != nil)
	return enabled
}

// waitUntil blocks until the switch resolves to `want` (true) or ctx ends
// (false), polling every switchPollInterval.
func (w *switchWatcher) waitUntil(ctx context.Context, want bool) bool {
	t := time.NewTicker(switchPollInterval)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return false
		case <-t.C:
		}
		if w.current(ctx) == want {
			return true
		}
	}
}

// ack writes fonbet_applied_* once per transition.
func (w *switchWatcher) ack(ctx context.Context, enabled bool) {
	w.mu.Lock()
	already := w.lastAck != nil && *w.lastAck == enabled
	if !already {
		v := enabled
		w.lastAck = &v
	}
	w.mu.Unlock()
	if already {
		return
	}
	if err := store.AckFonbetSwitch(ctx, w.pool, enabled); err != nil && ctx.Err() == nil {
		w.log.Warn().Err(err).Msg("fonbet switch acknowledgement write failed")
	}
}

// runFeed boots the Fonbet client, catalogue, previous state and workers,
// then polls until ctx is cancelled (switch OFF or shutdown), suspending
// the whole Fonbet catalog on the way out so nothing quotes frozen odds
// while the feed is not being asserted. Returns an error only for a boot
// failure; a normal stop returns nil.
func runFeed(ctx context.Context, cfg config.Config, st *store.Store, b *bus.Bus, log zerolog.Logger, onRunning func()) error {
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
		return fmt.Errorf("factor catalogue: %w", err)
	}
	if err := ing.WriteStaticDescriptions(ctx, mapper.StaticDescriptions(idx, opt)); err != nil {
		return fmt.Errorf("write descriptions: %w", err)
	}
	if cfg.Fonbet.Lang != "en" {
		if idxEN, err := loadCatalog(ctx, client, "en", log); err != nil {
			log.Warn().Err(err).Msg("english catalogue unavailable; storefront falls back to feed language")
		} else if err := ing.WriteStaticDescriptions(ctx, mapper.StaticDescriptions(idxEN, opt)); err != nil {
			log.Warn().Err(err).Msg("write english descriptions")
		}
	}
	if err := ing.Bootstrap(ctx); err != nil {
		return fmt.Errorf("bootstrap previous state: %w", err)
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
	// Runs only while the feed is on: with the switch off, Fonbet markets
	// stay open for manual settlement.
	var indexPtr atomic.Pointer[fonbet.Index]
	indexPtr.Store(idx)
	if cfg.Fonbet.SettleEnabled {
		worker := settle.New(st, b, client, &indexPtr, cfg.Fonbet.Lang, log)
		go worker.Run(ctx, cfg.Fonbet.SettleInterval)
		log.Info().Dur("interval", cfg.Fonbet.SettleInterval).Msg("settlement worker started")
	} else {
		log.Warn().Msg("FONBET_SETTLE_ENABLED=false — fonbet markets will not be settled automatically")
	}

	feedRunning.Store(true)
	defer feedRunning.Store(false)
	if onRunning != nil {
		onRunning()
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
			// Switch turned off or container going down: suspend so nothing
			// quotes frozen odds while the feed is not asserted. The first
			// cycle after ON / restart re-activates.
			sctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
			if err := ing.SuspendAll(sctx, time.Now().UnixMilli()); err != nil {
				log.Error().Err(err).Msg("suspend on stop")
			} else {
				catalogSuspended.Store(true)
			}
			cancel()
			log.Info().Msg("fonbet feed stopped")
			return nil
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
			recordError(err)
			log.Error().Err(err).Msg("fetch events/list failed")
		}
		return
	}
	snap := mapper.Build(resp, idx, opt)
	stats, err := ing.Apply(ctx, snap, time.Now().UnixMilli())
	if err != nil {
		if ctx.Err() == nil {
			recordError(err)
			log.Error().Err(err).Msg("apply snapshot failed")
		}
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
// Scoped to one runFeed: it stops with the feed.
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
			if last > 0 && time.Unix(last, 0).After(startedAt) {
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

// runStatusWriter refreshes the backoffice status hash every 5 s for the
// lifetime of the process (on or off), so the card can tell "service
// offline" from "feed switched off".
func runStatusWriter(ctx context.Context, b *bus.Bus, cfg config.Config, log zerolog.Logger) {
	write := func() {
		src := "env"
		if switchFromAdmin.Load() {
			src = "admin"
		}
		msg, at := lastError()
		fields := map[string]any{
			"heartbeat_unix":     time.Now().Unix(),
			"env_default":        boolInt(cfg.Fonbet.Enabled),
			"effective_enabled":  boolInt(effectiveEnabled.Load()),
			"switch_source":      src,
			"running":            boolInt(feedRunning.Load()),
			"catalog_suspended":  boolInt(catalogSuspended.Load()),
			"settle_enabled":     boolInt(cfg.Fonbet.SettleEnabled),
			"matches":            lastMatches.Load(),
			"outcomes":           lastOutcomes.Load(),
			"last_snapshot_unix": lastSnapshotUnix.Load(),
			"last_error":         msg,
			"last_error_unix":    at,
		}
		wctx, cancel := context.WithTimeout(ctx, 3*time.Second)
		defer cancel()
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

func recordError(err error) {
	lastErrorMu.Lock()
	lastErrorMsg = err.Error()
	lastErrorUnix = time.Now().Unix()
	lastErrorMu.Unlock()
}

func lastError() (string, int64) {
	lastErrorMu.Lock()
	defer lastErrorMu.Unlock()
	return lastErrorMsg, lastErrorUnix
}

func boolInt(b bool) int {
	if b {
		return 1
	}
	return 0
}

type healthResp struct {
	Status           string `json:"status"`
	Service          string `json:"service"`
	DB               string `json:"db"`
	Redis            string `json:"redis"`
	Enabled          bool   `json:"enabled"`      // effective switch position (admin or env)
	Running          bool   `json:"running"`      // poll loop active
	SwitchSource     string `json:"switchSource"` // "admin" | "env"
	UptimeSeconds    int64  `json:"uptimeSeconds"`
	LastSnapshotAt   string `json:"lastSnapshotAt,omitempty"`
	StaleSeconds     *int64 `json:"snapshotStaleSeconds,omitempty"`
	Matches          int64  `json:"matches"`
	Outcomes         int64  `json:"outcomes"`
	CatalogSuspended bool   `json:"catalogSuspended"`
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
		src := "env"
		if switchFromAdmin.Load() {
			src = "admin"
		}
		resp := healthResp{
			Status: status, Service: "fonbet-ingester", DB: okOrDown(dbOk), Redis: okOrDown(redisOk),
			Enabled: effectiveEnabled.Load(), Running: feedRunning.Load(), SwitchSource: src,
			UptimeSeconds: int64(time.Since(startedAt).Seconds()),
			Matches:       lastMatches.Load(), Outcomes: lastOutcomes.Load(), CatalogSuspended: catalogSuspended.Load(),
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
