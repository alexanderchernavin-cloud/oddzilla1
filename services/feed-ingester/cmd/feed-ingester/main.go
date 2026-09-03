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
	"flag"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"sync"
	"sync/atomic"
	"syscall"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/redis/go-redis/v9"
	"github.com/rs/zerolog"

	amqpkit "github.com/oddzilla/feed-ingester/internal/amqp"
	"github.com/oddzilla/feed-ingester/internal/automap"
	"github.com/oddzilla/feed-ingester/internal/backupstream"
	"github.com/oddzilla/feed-ingester/internal/bifrost"
	"github.com/oddzilla/feed-ingester/internal/bus"
	"github.com/oddzilla/feed-ingester/internal/config"
	"github.com/oddzilla/feed-ingester/internal/handler"
	"github.com/oddzilla/feed-ingester/internal/oddinrest"
	"github.com/oddzilla/feed-ingester/internal/oddinxml"
	"github.com/oddzilla/feed-ingester/internal/store"
)

func main() {
	backfillRiskTier := flag.Bool(
		"backfill-tournament-metadata",
		false,
		"Run tournament risk_tier backfill and exit (does not start the AMQP consumer).",
	)
	flag.Parse()

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

	// Adopt the operator's feed source before anything below decides
	// whether it may call Oddin's REST API (descriptions refresh,
	// competitor backfill, the resolver). runSourceSwitch keeps it current.
	loadFeedSource(ctx, pool, logger)

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
	// Second fixture source for the auto-mapper. With Oddin's REST meta
	// API down, unknown matches would otherwise land as placeholders
	// under `unclassified` even while the Bifrost backup keeps their odds
	// flowing; Bifrost's `match` query carries the same hierarchy.
	if cfg.Bifrost.Enabled {
		resolver = resolver.WithBifrostFallback(bifrost.New(bifrost.Config{
			URL:    cfg.Bifrost.URL,
			APIKey: cfg.Bifrost.APIKey,
			Locale: cfg.Bifrost.Locale,
			Origin: cfg.Bifrost.Origin,
		}))
		logger.Info().Msg("bifrost fixture fallback enabled for auto-mapping")
	}
	if len(cfg.Oddin.BlockedSportSlugs) == 0 {
		logger.Warn().Msg("sport blocklist disabled — every Oddin sport will be persisted")
	} else {
		blocked := make([]string, 0, len(cfg.Oddin.BlockedSportSlugs))
		for slug := range cfg.Oddin.BlockedSportSlugs {
			blocked = append(blocked, slug)
		}
		logger.Info().Strs("sports", blocked).Msg("sport blocklist active")
	}

	if *backfillRiskTier {
		if restClient == nil {
			logger.Fatal().Msg("backfill requires ODDIN_TOKEN")
		}
		logger.Info().Msg("running tournament risk_tier backfill")
		n, err := resolver.BackfillTournamentRiskTier(ctx)
		if err != nil {
			logger.Fatal().Err(err).Int("updated", n).Msg("backfill failed")
		}
		logger.Info().Int("updated", n).Msg("backfill finished")
		return
	}

	// While the operator has forced the Backup source, no Oddin feed REST
	// endpoint is called from this process: fixtures resolve through
	// Bifrost, tournament tier / rosters / description refreshes wait, and
	// no recovery request is sent. Widgets, video and OBB live in the api
	// against other Oddin hosts and are unaffected.
	restAllowed := func() bool { return !feedSourceIsBackup.Load() }
	resolver = resolver.WithRESTGate(restAllowed)

	deps := handler.Deps{
		Store:           st,
		Resolver:        resolver,
		Bus:             oddsBus,
		Log:             logger,
		Rest:            restClient,
		NodeID:          cfg.Oddin.NodeID,
		Alive:           handler.NewAliveState(),
		RestAllowed:     restAllowed,
		DescriptionLang: cfg.Oddin.Lang,
	}

	// ── Health server ──────────────────────────────────────────────────
	healthSrv := startHealth(cfg.HealthPort, pool, rdb, logger)
	defer func() {
		shutCtx, shutCancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer shutCancel()
		if err := healthSrv.Shutdown(shutCtx); err != nil {
			logger.Warn().Err(err).Msg("health server shutdown failed")
		}
	}()

	// ── Feed message cleanup (always on) ───────────────────────────────
	// Even with the feed disabled there may be stale rows left from a
	// previous run; a small hourly sweep keeps the table bounded.
	go runFeedMessageCleanup(ctx, st, logger)

	// ── Alive watchdog (safety net for a silent feed) ──────────────────
	// Suspends the active catalog when no AMQP message (alive heartbeat,
	// odds_change, anything) has arrived for FEED_STALE_SUSPEND_SECONDS.
	// Independent of connection state, so it covers the case the
	// OnConnect flush cannot: a server-side token revocation where every
	// reconnect fails and OnConnect never runs (the 2026-05-29 incident).
	// Armed whenever Oddin is enabled; also armed when creds are absent
	// but stale active markets linger from a prior run so they can't stay
	// bettable at frozen odds. <=0 disables it.
	if cfg.FeedStaleSuspendSeconds > 0 {
		staleAfter := time.Duration(cfg.FeedStaleSuspendSeconds) * time.Second
		go runAliveWatchdog(ctx, deps, rdb, time.Now(), staleAfter, logger)
	} else {
		logger.Warn().Msg("alive watchdog disabled (FEED_STALE_SUSPEND_SECONDS<=0) — a silent feed will NOT auto-suspend the catalog")
	}

	// ── Operator feed-source switch ──────────────────────────────────────
	// The backoffice (PUT /admin/feed/source) writes Redis `feed:source`:
	// auto / prod / backup. In `backup` this process keeps the AMQP
	// connection (transport liveness still stamps) but acks every delivery
	// without applying it, after suspending the catalogue once so the
	// Bifrost backup's full re-emit lands on a clean slate. Switching back
	// runs the same flush + 24 h Oddin replay a reconnect would.
	go runSourceSwitch(ctx, pool, deps, func() {
		// Catch up on the REST-sourced metadata the backup window skipped.
		if restClient == nil {
			return
		}
		for _, lang := range descriptionLangs(cfg.Oddin.Lang) {
			if err := refreshMarketDescriptions(ctx, restClient, st, lang, logger); err != nil {
				logger.Warn().Err(err).Str("lang", lang).Msg("post-backup market descriptions refresh failed")
			}
		}
		backfillCompetitorProfiles(ctx, resolver, st, logger)
	}, logger)

	// ── AMQP (optional) ────────────────────────────────────────────────
	// Backup feed stream (Bifrost). services/bifrost-feed publishes
	// Oddin-shaped odds_change and fixture_change documents onto the
	// `oddin.backup` Redis stream while the AMQP feed is silent. They flow
	// through the same handler.Handle; the only thing they must NOT do is
	// bump lastAmqpMessageUnix, which is the primary-liveness signal the
	// alive watchdog and the backup's own gate both key off. Attached
	// regardless of AMQP creds so the backup works even on a box where
	// Oddin never configured them.
	if cfg.BackupStreamEnabled {
		consumer, _ := os.Hostname()
		if consumer == "" {
			consumer = "feed-ingester"
		}
		go backupstream.Run(ctx, rdb, "feed-ingester", consumer,
			func(ctx context.Context, rk string, body []byte) error {
				return handler.Handle(ctx, deps, rk, body)
			}, logger)
	} else {
		logger.Info().Msg("backup stream consumer disabled (BACKUP_STREAM_ENABLED=false)")
	}

	if !cfg.Oddin.Enabled {
		logger.Warn().Msg("Oddin creds absent (ODDIN_TOKEN/ODDIN_CUSTOMER_ID); running idle — health endpoint only")
	} else {
		go runAMQP(ctx, cfg, deps, rdb, logger)
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
			if feedSourceIsBackup.Load() {
				logger.Warn().Msg("feed source is Backup; skipping the boot-time market descriptions refresh (Oddin REST not called)")
			} else {
				for _, lang := range descriptionLangs(cfg.Oddin.Lang) {
					if err := refreshMarketDescriptions(ctx, restClient, st, lang, logger); err != nil {
						logger.Warn().Err(err).Str("lang", lang).Msg("initial market descriptions refresh failed; UI will fall back to ids")
					}
				}
			}
			go runDescriptionsRefresher(ctx, restClient, st, descriptionLangs(cfg.Oddin.Lang), logger)
			// Backfill competitor profiles for any active match whose
			// teams we haven't fetched yet. Fire-and-forget because
			// there can be hundreds of URNs — a fresh boot with no
			// cache shouldn't hold up the main AMQP loop.
			go backfillCompetitorProfiles(ctx, resolver, st, logger)
			// LISTEN on fixture_refresh so the API can ask us to re-pull
			// a single fixture from REST when an admin clicks through to
			// a specific match. Per-URN cooldown lives inside the
			// listener. (No periodic phantom-drain — `<sport_event_status>`
			// inside every odds_change is the lifecycle source of truth;
			// matches that drift out of sync are a real bug to surface,
			// not noise to mop up.)
			go runFixtureRefreshListener(ctx, pool, resolver, logger)

			// Broadcaster URLs land on the fixture at/after kickoff, not
			// before, so the refresh fired on the live transition is too
			// early to see them and nothing else re-asks. This sweeper
			// re-requests shortly after go-live; it rides the same
			// listener (and its cooldown) via pg_notify.
			go runStreamBackfillSweeper(ctx, st, logger)
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
	// Storefront + DB use BCP-47 primary subtags (cs/pt/ru/es); Oddin's
	// /v1/descriptions/{lang} endpoint uses ISO-639-1-with-quirks where
	// Czech is `cz`. Translate at the request boundary so the DB row
	// keys stay aligned with the storefront cookie.
	oddinLang := oddinLangCode(lang)
	body, err := rc.MarketDescriptions(ctx, oddinLang)
	if err != nil {
		return err
	}
	var parsed oddinxml.MarketDescriptions
	if err := xml.Unmarshal(body, &parsed); err != nil {
		return err
	}
	if err := store.UpsertMarketDescriptions(ctx, st.Pool(), lang, parsed.Markets); err != nil {
		return err
	}
	n, _ := store.CountMarketDescriptions(ctx, st.Pool())
	log.Info().
		Str("lang", lang).
		Str("oddin_lang", oddinLang).
		Int("markets_seen", len(parsed.Markets)).
		Int("rows_in_cache", n).
		Msg("market descriptions refreshed")
	return nil
}

// oddinLangCode maps a storefront locale slug to the language code
// Oddin's REST API accepts. Discovered the hard way during the first
// deploy: cs → cz (no ISO 639-1 alpha-2 cs). Defaults to identity for
// codes Oddin already accepts (en, pt, ru, es).
func oddinLangCode(storefrontLocale string) string {
	switch storefrontLocale {
	case "cs":
		return "cz"
	default:
		return storefrontLocale
	}
}

// descriptionLangs returns the language codes feed-ingester should
// pull descriptions for. Storefront ships en/cs/pt/ru/es/hr so we fetch
// the same set; the operator's configured ODDIN_LANG always leads so
// the legacy "fetch only one language" boot path keeps reporting the
// same primary catalogue. Duplicates are stripped.
func descriptionLangs(primary string) []string {
	out := []string{}
	seen := map[string]bool{}
	add := func(lang string) {
		if lang == "" || seen[lang] {
			return
		}
		seen[lang] = true
		out = append(out, lang)
	}
	add(primary)
	for _, lang := range []string{"en", "cs", "pt", "ru", "es", "hr"} {
		add(lang)
	}
	return out
}

// runDescriptionsRefresher refreshes the market description cache every
// 6 hours, once per shipped language. First refresh happens in main()
// before this goroutine starts, so the cache is warm immediately; this
// loop just keeps it current.
func runDescriptionsRefresher(ctx context.Context, rc *oddinrest.Client, st *store.Store, langs []string, log zerolog.Logger) {
	const refreshEvery = 6 * time.Hour
	t := time.NewTicker(refreshEvery)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			if feedSourceIsBackup.Load() {
				log.Info().Msg("feed source is Backup; market descriptions refresh skipped (Oddin REST not called)")
				continue
			}
			for _, lang := range langs {
				if err := refreshMarketDescriptions(ctx, rc, st, lang, log); err != nil {
					log.Warn().Err(err).Str("lang", lang).Msg("market descriptions refresh failed")
				}
			}
		}
	}
}

// backfillCompetitorProfiles fetches the competitor profile for every
// active-match home/away team URN that isn't already cached. Paces the
// REST calls so we don't burst into Oddin's rate limiter — 20 per second
// is well under their per-endpoint ceiling.
func backfillCompetitorProfiles(ctx context.Context, res *automap.Resolver, st *store.Store, log zerolog.Logger) {
	if feedSourceIsBackup.Load() {
		log.Warn().Msg("feed source is Backup; competitor profile backfill skipped (Oddin REST not called)")
		return
	}
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

// runFixtureRefreshListener subscribes to Postgres notifications on the
// `fixture_refresh` channel. Each NOTIFY's payload is a single match
// URN (e.g. "od:match:12345"); we re-fetch its fixture from Oddin's REST
// and let RefreshFromFixture overwrite matches.status. Used by the API
// to clear stuck-live or stuck-not_started matches that never received a
// match_status_change (because we missed it during a recovery gap, or
// because Oddin's broker simply never emitted one).
//
// Per-URN cooldown of 5 minutes prevents a popular phantom-stale match
// from hammering Oddin's REST endpoint when many users hit the detail
// page in rapid succession.
func runFixtureRefreshListener(ctx context.Context, pool *pgxpool.Pool, res *automap.Resolver, log zerolog.Logger) {
	var lastFired sync.Map // map[string]time.Time
	const cooldown = 5 * time.Minute

	for ctx.Err() == nil {
		if err := listenFixtureRefreshOnce(ctx, pool, res, &lastFired, cooldown, log); err != nil && !errors.Is(err, context.Canceled) {
			log.Warn().Err(err).Msg("fixture_refresh LISTEN errored; reconnecting in 2s")
			select {
			case <-ctx.Done():
				return
			case <-time.After(2 * time.Second):
			}
		}
	}
}

func listenFixtureRefreshOnce(
	ctx context.Context,
	pool *pgxpool.Pool,
	res *automap.Resolver,
	lastFired *sync.Map,
	cooldown time.Duration,
	log zerolog.Logger,
) error {
	conn, err := pool.Acquire(ctx)
	if err != nil {
		return err
	}
	defer conn.Release()
	if _, err := conn.Exec(ctx, "LISTEN fixture_refresh"); err != nil {
		return err
	}
	log.Info().Msg("listening on fixture_refresh channel")
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
		urn := n.Payload
		if urn == "" {
			continue
		}
		if t, ok := lastFired.Load(urn); ok {
			if since := time.Since(t.(time.Time)); since < cooldown {
				log.Debug().Str("urn", urn).Dur("since", since).
					Msg("fixture_refresh dedupe (cooldown)")
				continue
			}
		}
		lastFired.Store(urn, time.Now())
		log.Info().Str("urn", urn).Msg("fixture_refresh: re-fetching from REST")
		if err := res.RefreshFromFixture(ctx, urn); err != nil {
			log.Warn().Err(err).Str("urn", urn).Msg("fixture_refresh failed")
		}
	}
	return nil
}

// runFeedMessageCleanup sweeps the feed_messages table once per hour.
// Uniform 7-day retention since received_at; the same call also backfills
// match_id for rows whose URN now resolves (closes the insert/auto-map
// race that previously left orphan rows stuck at NULL). Admin /admin/logs
// only surfaces matches still within the 7-day window, so anything older
// is invisible anyway.
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

// runStreamBackfillSweeper re-asks Oddin for the fixture of live matches that
// still have no broadcaster URLs, shortly after they go live.
//
// Broadcaster URLs are not on the fixture at kickoff. Oddin attaches them at
// or just after it, but our only refresh fires ON the not_started -> live
// transition, seconds too early, and the fixture_change STREAM_URL (106)
// event that should cover later attachment does not arrive in practice. So
// the column stayed NULL forever and the storefront showed no stream tab at
// all — measured on production 2026-08-31 as 649 of 724 live matches with
// NULL tv_channels and zero of 523 upcoming, while Oddin was serving three
// channels for a match we had stored as NULL. One manual refresh populated
// it, which is what proves the parse and persist paths are fine and this is
// purely a matter of asking again a bit later.
//
// It goes through pg_notify rather than calling the resolver directly so it
// inherits the per-URN cooldown in runFixtureRefreshListener: a URN emitted
// on several consecutive ticks costs one REST call per cooldown window, not
// one per tick.
//
// Bounded on purpose. Plenty of matches genuinely have no broadcaster, and
// without the age ceiling every one of them would burn REST calls for its
// whole duration; the batch cap keeps a busy minute (hundreds of sim matches
// kicking off together) from turning into a burst against Oddin's REST.
func runStreamBackfillSweeper(ctx context.Context, st *store.Store, log zerolog.Logger) {
	const (
		sweepEvery = 60 * time.Second
		// Skip the transition itself — runFixtureRefreshListener already
		// covered that moment, and Oddin has not attached anything yet.
		minAge = 60 * time.Second
		// Past this a match almost certainly has no broadcaster at all.
		maxAge = 15 * time.Minute
		// Per tick. With the listener's 5-minute cooldown this is a ceiling
		// on notifications, not on REST calls.
		batch = 40
	)
	t := time.NewTicker(sweepEvery)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			urns, err := store.SelectLiveMatchesMissingStreams(ctx, st.Pool(), minAge, maxAge, batch)
			if err != nil {
				log.Warn().Err(err).Msg("stream backfill sweep: query failed")
				continue
			}
			if len(urns) == 0 {
				continue
			}
			sent := 0
			for _, urn := range urns {
				if _, err := st.Pool().Exec(ctx, `SELECT pg_notify('fixture_refresh', $1)`, urn); err != nil {
					log.Warn().Err(err).Str("urn", urn).Msg("stream backfill sweep: notify failed")
					continue
				}
				sent++
			}
			log.Info().
				Int("candidates", len(urns)).
				Int("notified", sent).
				Msg("stream backfill sweep: re-requested fixtures for live matches with no tv_channels")
		}
	}
}

// flushBeforeRecover unconditionally suspends the active catalog before
// every recovery trigger. Rationale (per operator decision 2026-05-11):
// any feed gap — even a few seconds — can leave a market quoting odds
// that no longer reflect Oddin's truth, and a single placement at stale
// odds can cost real money. Better to lose a few seconds of bet uptime
// per reconnect than risk paying out on a price the bookmaker already
// moved off of.
//
// Behaviour: deletes orphan markets/matches with no money attached,
// suspends and null-prices the rest, lets the subsequent
// `InitiateRecovery` replay re-activate only what Oddin re-confirms.
// Anything Oddin omits stays suspended → drops from the storefront via
// the catalog filter. Best-effort: a flush failure logs and falls
// through to plain recovery (stale data beats no data).
func flushBeforeRecover(ctx context.Context, deps handler.Deps, log zerolog.Logger) {
	summary, err := store.FlushAndSuspendActiveCatalog(ctx, deps.Store.Pool())
	if err != nil {
		log.Error().Err(err).Msg("flush-before-recover failed; proceeding with plain recovery")
		return
	}
	log.Warn().
		Int64("suspended_markets", summary.SuspendedMarkets).
		Int64("suspended_outcomes", summary.SuspendedOutcomes).
		Int("suspended_matches", len(summary.SuspendedMatchIDs)).
		Msg("flush-before-recover complete; awaiting replay to re-activate")
	broadcastMatchesSuspended(ctx, deps, summary.SuspendedMatchIDs, log)

	// Rewind the recovery cursor for both producers to the full
	// RecoveryWindowCap. Without this, the cursor stays pinned to "now
	// minus a few seconds" (BumpAfterTs bumps it on every odds_change
	// the ingester processed before this reconnect), so the subsequent
	// InitiateRecovery asks Oddin to replay only the past few seconds
	// — and stable prematch markets that haven't changed in hours
	// never get re-confirmed. Result: the flush suspends everything,
	// the replay re-activates ~nothing, and matches surface to the
	// storefront with most of their markets stuck at status=-1.
	//
	// Safe to overwrite unconditionally here because OnConnect runs
	// synchronously BEFORE the consumer's delivery loop starts, so no
	// odds_change handler is concurrently calling BumpAfterTs. The
	// next BumpAfterTs from the replay's first odds_change will move
	// the cursor forward from the rewound value normally.
	rewoundMs := time.Now().Add(-handler.RecoveryWindowCap).UnixMilli()
	for _, key := range []string{"producer:1", "producer:2"} {
		if rerr := store.RewindAfterTs(ctx, deps.Store.Pool(), key, rewoundMs); rerr != nil {
			log.Warn().Err(rerr).Str("key", key).
				Msg("flush: rewind after_ts failed; recovery window will be too narrow")
		}
	}
	log.Info().
		Int64("rewound_to_ms", rewoundMs).
		Dur("window", handler.RecoveryWindowCap).
		Msg("flush: rewound recovery cursor for full replay window")

	// Broadcast the status flip per market so any open storefront
	// session locks placement immediately — without this the page
	// keeps showing pre-flush prices until Oddin's replay reaches the
	// match, and any click in that window dead-ends at
	// `market_not_active`.
	broadcastSuspended(ctx, deps, summary.SuspendedRefs, log)
}

// broadcastSuspended publishes a marketStatus=-1 WS frame for every
// market a flush just suspended so open storefront sessions lock their
// bet slips immediately. Uses the current wall clock as the frame
// timestamp — a flush isn't tied to a specific Oddin message. Best-
// effort: a pub/sub failure is logged at debug and never blocks.
func broadcastSuspended(ctx context.Context, deps handler.Deps, refs []store.FlushSuspendedRef, log zerolog.Logger) {
	if deps.Bus == nil || len(refs) == 0 {
		return
	}
	nowMs := time.Now().UnixMilli()
	for _, ref := range refs {
		if perr := deps.Bus.PublishMarketStatus(ctx, ref.MatchID, ref.MarketID, -1, nowMs); perr != nil {
			log.Debug().Err(perr).
				Int64("match", ref.MatchID).Int64("market", ref.MarketID).
				Msg("publish market status failed")
		}
	}
}

// broadcastMatchesSuspended tells open pages that these matches left the
// offer, so the LIVE pill goes away in the same moment the prices do.
// Without it a viewer keeps a live-looking header over a dead board until
// they reload.
func broadcastMatchesSuspended(ctx context.Context, deps handler.Deps, ids []int64, log zerolog.Logger) {
	if deps.Bus == nil || len(ids) == 0 {
		return
	}
	nowMs := time.Now().UnixMilli()
	for _, id := range ids {
		if perr := deps.Bus.PublishMatchStatus(ctx, id, "suspended", nowMs); perr != nil {
			log.Debug().Err(perr).Int64("match", id).
				Msg("publish match status failed")
		}
	}
}

// runAliveWatchdog is the safety net for a silent feed. Oddin sends an
// `alive` heartbeat on every producer every ~10s (docs §2.4.7); the
// consumer's handler closure bumps lastAmqpMessageUnix on EVERY delivery,
// so a stale value means no message of any kind — alive, odds_change, or
// settlement — has arrived recently. That is the canonical "producer
// down / token revoked / network partition" signal.
//
// The connection-driven flush (OnConnect → flushBeforeRecover) only fires
// on a SUCCESSFUL (re)connect, so it cannot help when the token is
// revoked server-side: the reconnect attempts fail, OnConnect never runs,
// and the catalog keeps quoting frozen odds indefinitely (the 2026-05-29
// token-revocation incident — 8k markets stayed bettable for over an
// hour). This time-based watchdog closes that gap; it fires regardless of
// connection state and suspends the active catalog the moment the feed
// goes quiet past the threshold.
//
// It suspends at most once per silence episode (guarded by `suspended`)
// and clears the guard when fresh data resumes. Re-activation rides the
// existing recovery paths — OnConnect flush+recover on a fresh connect,
// or the alive-gap recovery when heartbeats resume on a live connection.
func runAliveWatchdog(ctx context.Context, deps handler.Deps, rdb *redis.Client, startedAt time.Time, staleAfter time.Duration, log zerolog.Logger) {
	const checkEvery = 5 * time.Second
	t := time.NewTicker(checkEvery)
	defer t.Stop()
	suspended := false
	var backupUnhealthySince time.Time
	log.Info().Dur("threshold", staleAfter).Msg("alive watchdog armed")
	for {
		select {
		case <-ctx.Done():
			return
		case now := <-t.C:
			// Forced Backup: AMQP silence is irrelevant (its deliveries are
			// not applied), so the watchdog guards the source that IS
			// feeding the catalogue — bifrost-feed's heartbeat and socket,
			// read from its Redis status hash. A dead backup service or a
			// lost Bifrost socket suspends the catalogue after the same
			// threshold; bifrost-feed's re-emit on reconnect brings it back.
			if feedSourceIsBackup.Load() {
				healthy, why := backupHealthy(ctx, rdb, now, staleAfter)
				switch {
				case healthy:
					backupUnhealthySince = time.Time{}
					if suspended {
						log.Warn().Msg("backup feed healthy again; staleness guard cleared (its re-emit re-activates markets)")
						suspended = false
					}
				case backupUnhealthySince.IsZero():
					backupUnhealthySince = now
				case now.Sub(backupUnhealthySince) >= staleAfter && !suspended:
					log.Error().Str("reason", why).Dur("threshold", staleAfter).
						Msg("backup feed unhealthy past threshold while forced; suspending active catalog")
					suspendCatalogForStaleness(ctx, deps, log)
					suspended = true
				}
				continue
			}
			backupUnhealthySince = time.Time{}
			sinceLast := feedSilence(lastAmqpMessageUnix.Load(), now, startedAt)
			stale := sinceLast >= staleAfter
			switch {
			case stale && !suspended:
				log.Error().
					Dur("since_last_msg", sinceLast).
					Dur("threshold", staleAfter).
					Msg("feed silent past threshold — no alive/odds; suspending active catalog")
				suspendCatalogForStaleness(ctx, deps, log)
				suspended = true
			case !stale && suspended:
				log.Warn().
					Dur("since_last_msg", sinceLast).
					Msg("feed resumed; staleness guard cleared (recovery re-activates markets)")
				suspended = false
			}
		}
	}
}

// backupHealthy reads services/bifrost-feed's status hash: healthy when
// its heartbeat is fresh and its Bifrost socket is connected.
func backupHealthy(ctx context.Context, rdb *redis.Client, now time.Time, staleAfter time.Duration) (bool, string) {
	vals, err := rdb.HMGet(ctx, "bifrost:feed:status", "heartbeat_unix", "connected").Result()
	if err != nil || len(vals) != 2 {
		// Redis unreachable: cannot judge; do not flap.
		return true, ""
	}
	hb, _ := vals[0].(string)
	n, perr := strconv.ParseInt(hb, 10, 64)
	if hb == "" || perr != nil {
		return false, "bifrost-feed has published no status heartbeat"
	}
	if now.Sub(time.Unix(n, 0)) > staleAfter {
		return false, "bifrost-feed heartbeat stale (service down?)"
	}
	if c, _ := vals[1].(string); c != "1" {
		return false, "bifrost-feed reports its Bifrost socket disconnected"
	}
	return true, ""
}

// feedSilence reports how long the feed has been quiet. It measures from
// the last delivery (lastMsgUnix, seconds since epoch) when one exists, or
// from boot (startedAt) when nothing has arrived yet — the dead-token-at-
// startup case, where lastMsgUnix is 0 and we must still eventually
// suspend rather than wait forever for a first message that never comes.
func feedSilence(lastMsgUnix int64, now, startedAt time.Time) time.Duration {
	if lastMsgUnix > 0 {
		return now.Sub(time.Unix(lastMsgUnix, 0))
	}
	return now.Sub(startedAt)
}

// suspendCatalogForStaleness flushes the active catalog and broadcasts the
// suspension, called by the watchdog when the feed has gone silent. Unlike
// flushBeforeRecover it does NOT rewind the recovery cursor or trigger a
// replay — there is no live feed to replay from. Re-activation happens
// later through the normal recovery paths once the feed returns.
func suspendCatalogForStaleness(ctx context.Context, deps handler.Deps, log zerolog.Logger) {
	summary, err := store.FlushAndSuspendActiveCatalog(ctx, deps.Store.Pool())
	if err != nil {
		log.Error().Err(err).Msg("watchdog: flush active catalog failed")
		return
	}
	log.Warn().
		Int64("suspended_markets", summary.SuspendedMarkets).
		Int64("suspended_outcomes", summary.SuspendedOutcomes).
		Int("suspended_matches", len(summary.SuspendedMatchIDs)).
		Msg("watchdog: active catalog suspended due to feed silence")
	broadcastSuspended(ctx, deps, summary.SuspendedRefs, log)
	broadcastMatchesSuspended(ctx, deps, summary.SuspendedMatchIDs, log)
}

// PrimaryLivenessKey is the Redis key services/bifrost-feed's gate reads
// to decide whether the primary AMQP feed is alive. Value: unix seconds of
// the last delivery of any kind. Written at most once per second.
const PrimaryLivenessKey = "feed:primary:last_msg_unix"

// PrimaryConnectedKey is the second liveness signal: refreshed every 2 s
// with a 15 s TTL for as long as the AMQP connection is open, deleted the
// moment it drops. The gate treats the primary as alive while EITHER key
// is fresh. Deliveries alone were not enough: after a restart, the
// OnConnect flush plus Oddin's replay ramp leave 60-100 s with the
// connection open but nothing delivered (measured 2026-09-03 during the
// deploy that shipped the backup), and the backup took over for 33 s on
// a perfectly healthy feed. The outages the backup exists for — token
// revoked, broker unreachable, network partition — all drop the
// connection, so they still stop this stamp.
const PrimaryConnectedKey = "feed:primary:connected_unix"

const primaryConnectedTTL = 15 * time.Second

// lastLivenessWriteUnix throttles the Redis heartbeat to one SET per
// second — the handler closure runs per delivery, which peaks at
// thousands per second during live bursts.
var lastLivenessWriteUnix atomic.Int64

func runAMQP(ctx context.Context, cfg config.Config, deps handler.Deps, rdb *redis.Client, log zerolog.Logger) {
	// Connection-level liveness stamp (see PrimaryConnectedKey). Started
	// at the top of every OnConnect, BEFORE the flush + recovery that can
	// hold the delivery loop for over a minute; stopped and the key deleted
	// on disconnect so a dropped connection reads as down within 2 s
	// rather than after the TTL.
	var (
		stampMu   sync.Mutex
		stampStop chan struct{}
	)
	startConnectedStamp := func() {
		stampMu.Lock()
		defer stampMu.Unlock()
		if stampStop != nil {
			return
		}
		stop := make(chan struct{})
		stampStop = stop
		go func() {
			t := time.NewTicker(2 * time.Second)
			defer t.Stop()
			for {
				if err := rdb.Set(ctx, PrimaryConnectedKey, time.Now().Unix(), primaryConnectedTTL).Err(); err != nil {
					log.Debug().Err(err).Msg("primary connected stamp write failed")
				}
				select {
				case <-ctx.Done():
					return
				case <-stop:
					return
				case <-t.C:
				}
			}
		}()
	}
	stopConnectedStamp := func() {
		stampMu.Lock()
		defer stampMu.Unlock()
		if stampStop != nil {
			close(stampStop)
			stampStop = nil
		}
		if err := rdb.Del(context.Background(), PrimaryConnectedKey).Err(); err != nil {
			log.Debug().Err(err).Msg("primary connected stamp delete failed")
		}
	}

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
			// Update the healthz signal first — even a delivery the
			// handler later rejects proves the AMQP transport is live.
			now := time.Now().Unix()
			lastAmqpMessageUnix.Store(now)
			// Mirror it to Redis for the backup feed's gate. Best-effort
			// and throttled; a missed write just delays takeover detection
			// by a second.
			if lastLivenessWriteUnix.Load() != now && lastLivenessWriteUnix.Swap(now) != now {
				if err := rdb.Set(ctx, PrimaryLivenessKey, now, 0).Err(); err != nil {
					log.Debug().Err(err).Msg("primary liveness heartbeat write failed")
				}
			}
			// Operator forced the backup source: the AMQP transport stays
			// up (and keeps stamping liveness, so the alive watchdog does
			// not re-suspend the catalogue the backup just re-activated)
			// but nothing from it is applied.
			if dropAMQP.Load() {
				return nil
			}
			return handler.Handle(ctx, deps, rk, body)
		},
		func(ctx context.Context) error {
			// On (re)connect: suspend the active catalog FIRST, then ask
			// Oddin to replay messages since our last cursor. Per the
			// docs we issue one request per producer ("pre" + "live"); the
			// replay arrives via AMQP and ends with a snapshot_complete
			// message we already handle.
			//
			// Suspend-before-recover is unconditional: even a few seconds
			// of feed gap can leave a market quoting odds Oddin already
			// moved off of, and a single placement at stale odds is a
			// real-money loss. The 2026-05-09 disk-full incident wedged
			// 33 matches this way — Oddin's replay didn't carry their
			// terminal status because they were no longer in Oddin's
			// active state by the time we reconnected. Flushing first
			// guarantees anything Oddin omits drops out of the catalog
			// (status=-1 fails the storefront filter) instead of silently
			// keeping its pre-outage snapshot.
			startConnectedStamp()
			if feedSourceIsBackup.Load() {
				// The backup is feeding the catalogue: flushing it here
				// would wipe what Bifrost just fed, and the replay request
				// is an Oddin REST call the operator asked us not to make.
				log.Warn().Msg("amqp (re)connected while feed source is Backup; no flush, no recovery request")
				return nil
			}
			if deps.Rest == nil {
				log.Info().Msg("amqp (re)connected; recovery skipped (no rest client)")
				return nil
			}
			flushBeforeRecover(ctx, deps, log)
			handler.TriggerRecovery(ctx, deps, log)
			return nil
		},
		log,
	)
	cons.OnDisconnect = stopConnectedStamp

	if err := cons.Run(ctx); err != nil && !errors.Is(err, context.Canceled) {
		log.Error().Err(err).Msg("amqp consumer exited")
	}
}

// The feed source switch lives in the singleton `feed_control` Postgres
// row (migration 0095), written by the api and read every 2 s here and in
// services/bifrost-feed. It was Redis keys for one day: production Redis is
// an allkeys-lru cache and evicted them when the backup stream filled it,
// silently turning a forced Backup back into Auto.
const feedSourceBackup = "backup"

// dropAMQP is true while the operator has forced the backup source: AMQP
// deliveries are acked without being applied. Read on the hot path, so an
// atomic rather than a mutex.
var dropAMQP atomic.Bool

// feedSourceIsBackup gates every Oddin feed REST call (resolver fixtures,
// tournament info, competitor profiles, descriptions refresh, recovery)
// and switches the alive watchdog to guarding bifrost-feed instead of
// AMQP. Set together with dropAMQP on the way INTO backup; on the way OUT
// it is cleared FIRST so the reconnect-style replay request is allowed,
// while dropAMQP stays set until that request is sent (a concurrent
// BumpAfterTs would otherwise narrow the rewound recovery window).
var feedSourceIsBackup atomic.Bool

// currentFeedSource is what runSourceSwitch last observed, for /healthz.
var currentFeedSource atomic.Pointer[string]

// runSourceSwitch polls Redis `feed:source` every 2 s and applies
// transitions:
//
//	→ backup : stop applying AMQP, suspend the active catalogue once,
//	           acknowledge with feed:source:flushed_unix so bifrost-feed
//	           knows it may re-emit.
//	backup → : rewind + flush + ask Oddin for the full replay (the same
//	           sequence a reconnect runs), then resume applying AMQP.
//
// The value present at boot is adopted without a flush: a restart while
// forced to backup must not wipe the catalogue the backup is feeding.
// readFeedSource returns the normalised switch position and whether the
// read succeeded. A missing row means auto.
func readFeedSource(ctx context.Context, pool *pgxpool.Pool, log zerolog.Logger) (string, bool) {
	var v string
	err := pool.QueryRow(ctx, `SELECT COALESCE((SELECT source FROM feed_control WHERE id = 1), 'auto')`).Scan(&v)
	if err != nil {
		if ctx.Err() == nil {
			log.Debug().Err(err).Msg("feed_control read failed")
		}
		return "", false
	}
	switch v {
	case "auto", "prod", feedSourceBackup:
		return v, true
	}
	return "auto", true
}

// markApplied records what this process adopted, for the backoffice card.
func markApplied(ctx context.Context, pool *pgxpool.Pool, source string, log zerolog.Logger) {
	if _, err := pool.Exec(ctx,
		`UPDATE feed_control SET applied_source = $1, applied_at = NOW(), updated_at = NOW() WHERE id = 1`, source,
	); err != nil && ctx.Err() == nil {
		log.Debug().Err(err).Msg("feed_control applied write failed")
	}
}

// loadFeedSource adopts the stored switch position at boot: sets both
// flags without any flush (a restart while forced to Backup must not wipe
// the catalogue the backup is feeding) and records what was applied.
func loadFeedSource(ctx context.Context, pool *pgxpool.Pool, log zerolog.Logger) string {
	cur, ok := readFeedSource(ctx, pool, log)
	if !ok {
		cur = "auto"
	}
	isBackup := cur == feedSourceBackup
	feedSourceIsBackup.Store(isBackup)
	dropAMQP.Store(isBackup)
	c := cur
	currentFeedSource.Store(&c)
	markApplied(ctx, pool, cur, log)
	if isBackup {
		log.Warn().Msg("booted with feed source forced to Backup: AMQP deliveries acked without being applied, no Oddin feed REST calls")
	}
	return cur
}

// runSourceSwitch polls the switch and applies transitions. onResume runs
// (in its own goroutine) after a Backup → Prod/Auto transition, once REST
// is allowed again, so the work skipped during the backup window
// (descriptions refresh, competitor backfill) catches up immediately.
func runSourceSwitch(ctx context.Context, pool *pgxpool.Pool, deps handler.Deps, onResume func(), log zerolog.Logger) {
	log = log.With().Str("component", "feed-source").Logger()
	read := func() (string, bool) { return readFeedSource(ctx, pool, log) }
	prev := loadFeedSource(ctx, pool, log)

	t := time.NewTicker(2 * time.Second)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		}
		cur, ok := read()
		if !ok || cur == prev {
			continue
		}
		switch {
		case cur == feedSourceBackup:
			feedSourceIsBackup.Store(true)
			dropAMQP.Store(true)
			log.Warn().Str("from", prev).Msg("feed source switched to BACKUP: suspending catalogue, ignoring AMQP and Oddin feed REST until switched back")
			suspendCatalogForStaleness(ctx, deps, log)
			// Acknowledge the flush for THIS switch only (source still
			// backup); bifrost-feed re-emits once flushed_at >= switched_at.
			if _, err := pool.Exec(ctx,
				`UPDATE feed_control SET flushed_at = NOW(), updated_at = NOW() WHERE id = 1 AND source = 'backup'`,
			); err != nil {
				log.Warn().Err(err).Msg("flush acknowledgement write failed; bifrost-feed will activate after its 15 s ceiling")
			}
		case prev == feedSourceBackup:
			log.Warn().Str("to", cur).Msg("feed source switched back to PROD: flushing and replaying from Oddin")
			// REST is allowed again from here; dropAMQP stays true until
			// the replay request is sent so a concurrent BumpAfterTs
			// cannot narrow the rewound window.
			feedSourceIsBackup.Store(false)
			if deps.Rest != nil {
				flushBeforeRecover(ctx, deps, log)
				handler.TriggerRecovery(ctx, deps, log)
			} else {
				log.Warn().Msg("no Oddin REST client; catalogue left as the backup last fed it")
			}
			dropAMQP.Store(false)
			if onResume != nil {
				go onResume()
			}
		default:
			log.Info().Str("from", prev).Str("to", cur).Msg("feed source changed (backup stays in standby either way)")
		}
		prev = cur
		p := cur
		currentFeedSource.Store(&p)
		markApplied(ctx, pool, cur, log)
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

// lastAmqpMessageUnix is updated by the consumer's handler closure on
// every successfully-decoded delivery. Read by /healthz so operators
// can alert on staleness during live matches (Oddin sends `alive`
// messages every ~10s on each producer; > 60s of silence is the canary
// for a feed outage). Zero = no message yet.
var lastAmqpMessageUnix atomic.Int64

type healthResp struct {
	Status            string `json:"status"`
	Service           string `json:"service"`
	DB                string `json:"db"`
	Redis             string `json:"redis"`
	UptimeSeconds     int64  `json:"uptimeSeconds"`
	LastAmqpMessageAt string `json:"lastAmqpMessageAt,omitempty"`
	StaleSeconds      *int64 `json:"amqpStaleSeconds,omitempty"`
	// FeedSource is the operator switch as last observed (auto / prod /
	// backup); AmqpApplied is false while deliveries are acked unprocessed.
	FeedSource  string `json:"feedSource,omitempty"`
	AmqpApplied bool   `json:"amqpApplied"`
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
		resp := healthResp{
			Status:        status,
			Service:       "feed-ingester",
			DB:            okOrDown(dbOk),
			Redis:         okOrDown(redisOk),
			UptimeSeconds: int64(time.Since(startedAt).Seconds()),
		}
		if ts := lastAmqpMessageUnix.Load(); ts > 0 {
			resp.LastAmqpMessageAt = time.Unix(ts, 0).UTC().Format(time.RFC3339)
			stale := int64(time.Since(time.Unix(ts, 0)).Seconds())
			resp.StaleSeconds = &stale
		}
		if src := currentFeedSource.Load(); src != nil {
			resp.FeedSource = *src
		}
		resp.AmqpApplied = !dropAMQP.Load()
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
