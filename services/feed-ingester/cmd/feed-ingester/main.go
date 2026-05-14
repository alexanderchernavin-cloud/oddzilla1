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
	"sync"
	"sync/atomic"
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
			for _, lang := range descriptionLangs(cfg.Oddin.Lang) {
				if err := refreshMarketDescriptions(ctx, restClient, st, lang, logger); err != nil {
					logger.Warn().Err(err).Str("lang", lang).Msg("initial market descriptions refresh failed; UI will fall back to ids")
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
// pull descriptions for. Storefront ships en/cs/pt/ru/es so we fetch
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
	for _, lang := range []string{"en", "cs", "pt", "ru", "es"} {
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
		Msg("flush-before-recover complete; awaiting replay to re-activate")

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
	// `market_not_active`. Use the current wall clock as the WS frame
	// timestamp — the flush isn't tied to a specific Oddin message.
	if deps.Bus != nil && len(summary.SuspendedRefs) > 0 {
		nowMs := time.Now().UnixMilli()
		for _, ref := range summary.SuspendedRefs {
			if perr := deps.Bus.PublishMarketStatus(ctx, ref.MatchID, ref.MarketID, -1, nowMs); perr != nil {
				log.Debug().Err(perr).
					Int64("match", ref.MatchID).Int64("market", ref.MarketID).
					Msg("flush: publish market status failed")
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
			// Update the healthz signal first — even a delivery the
			// handler later rejects proves the AMQP transport is live.
			lastAmqpMessageUnix.Store(time.Now().Unix())
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
