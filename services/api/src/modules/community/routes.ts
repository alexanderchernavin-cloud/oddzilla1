// /community/* endpoints (Phase 10.1 + 10.2).
//
// Public reads:
//   GET    /community/feed?currency=&sport=&page=&pageSize=
//   GET    /community/users/:nickname/profile?currency=USDC|OZ
//   GET    /community/users/:nickname/tickets?currency=&page=&pageSize=
//
// Authed self-management:
//   GET    /community/me
//   PATCH  /community/me/visibility
//   PATCH  /community/me/profile
//
// Phase 10.3 will add /community/copy/:communityTicketId. Admin
// backfill lives at POST /admin/community/backfill (admin/community.ts).

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { and, eq, sql, desc, asc, type SQL } from "drizzle-orm";
import {
  users,
  communityTickets,
  tickets,
  ticketSelections,
  markets,
  marketOutcomes,
  matches,
  tournaments,
  categories,
  sports,
  achievementDefinitions,
  userAchievements,
  avatarTemplates,
} from "@oddzilla/db";
import type {
  CommunityProfile,
  CommunityMe,
  CommunityVisibilityRequest,
  CommunityProfileRequest,
  CommunityFeedResponse,
  CommunityUserTicketsResponse,
  CommunityTicketSummary,
  CommunityCopyResponse,
  CommunityAchievement,
  Currency,
  ApplySamePlayResponse,
  SamePlayCandidate,
  SamePlayOriginator,
  SamePlayRole,
} from "@oddzilla/types";
import { isCurrency, DEFAULT_CURRENCY } from "@oddzilla/types";
import {
  BadRequestError,
  ConflictError,
  NotFoundError,
} from "../../lib/errors.js";
import { resolveOptionalAvatarUrl } from "./avatar-url.js";
import { emitNotification } from "./notifications.js";

// Same shape AuthService uses for `users` writes — limit per-IP-per-user
// abuse on the nickname squat path.
const writeRateLimit = {
  rateLimit: { max: 30, timeWindow: "1 minute" },
};

// Cap public reads so a scraper can't paginate the entire feed in linear
// time. Anonymous endpoints, so per-IP is the only key we have. Bumping
// the page-size limit doesn't help an attacker because each call still
// counts towards the cap.
const readRateLimit = {
  rateLimit: { max: 60, timeWindow: "1 minute" },
};

// Mirrors the DB-side CHECK constraint from migration 0024.
const NICKNAME_RE = /^[A-Za-z0-9_]{3,20}$/;

// UUID v4 with hyphens — the format Drizzle's defaultRandom() emits
// for tickets.id. Used to fail-fast on malformed copy IDs without
// touching the DB.
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const visibilityBody = z.object({
  ticketsPublic: z.boolean(),
});

const profileBody = z
  .object({
    nickname: z
      .string()
      .regex(NICKNAME_RE, "nickname_invalid")
      .nullable()
      .optional(),
    bio: z.string().max(280).nullable().optional(),
  })
  .strict();

// Feed query. Defaults match the storefront: 20 cards a page, USDC
// (the locked-leaderboards currency under D4) gets the default tab,
// "all sports" when sport is omitted.
//
// `tab=recent` (default) → live in-flight bets on still-bettable
//   matches (Recent feed).
// `tab=best`             → settled wins from the projection (Best
//   Wins / Big Wins surface). `sort` and `bigWinsOnly` then carve
//   the Best Wins surface into the four UI sort modes. They are
//   ignored when tab=recent.
//
// `sort` values when tab=best:
//   recent  — settled_at DESC (default).
//   copied  — inspiration_count DESC, settled_at DESC. Powered by
//             community_tickets_inspirations_idx (migration 0033).
//   stakes  — profit DESC, settled_at DESC. PRD calls it "High
//             Stakes" but spec'd it as profit ranking; we honour
//             the spec.
//   live    — Phase A placeholder. The PRD's "Live Matches" sort
//             requires a still-live underlying match on a settled
//             ticket — only meaningful for cashed-out bets, and
//             the catalog join is heavyweight on the Best Wins
//             query plan. Falls back to recent until a follow-up
//             adds the live-match flag to the projection. Kept on
//             the enum so the UI can ship the four-button row now.
const feedQuery = z.object({
  currency: z.string().optional(),
  sport: z.coerce.number().int().positive().optional(),
  // `tab` and `sort` are decoupled because the Big Wins design has
  // three sort modes inside the Best Wins tab; the legacy single
  // enum couldn't express that without ambiguity.
  tab: z.enum(["recent", "best"]).default("recent"),
  sort: z.enum(["recent", "copied", "stakes", "live"]).default("recent"),
  // True restricts Best Wins to tickets whose profit clears the
  // per-currency Big Win floor. The UI sets it on the dedicated Big
  // Wins entry point; the standard Best Wins tab leaves it off so
  // the surface keeps surfacing every win.
  bigWinsOnly: z.coerce.boolean().default(false),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(50).default(20),
});

// Best Wins window. Long enough to catch a slow Sunday afternoon;
// short enough that ancient blowout wins don't squat the top of the
// feed indefinitely. See docs/COMMUNITY_PLAN.md §scoring.
const BEST_WINS_WINDOW = sql`now() - interval '7 days'`;

// Per-currency Big Win profit floor in micro units (1e6 per unit).
// Profit = payout_micro − stake_micro; a row clears the floor when
// profit ≥ this number. The PRD's flat €500 maps directly to USDC;
// OZ is a demo currency and the threshold is a placeholder until
// product picks one. Kept here (not in DB / config) because:
//   • the floor varies per currency, not per row;
//   • the PRD's Open Question #8 explicitly anticipates per-operator
//     re-tuning, and a code-side map is the cheapest seam to revisit;
//   • a SQL constant per query keeps the planner's predicate inline.
// Both values are bigint literals — never coerce to Number, the
// rest of the codebase treats _micro as bigint end-to-end.
const BIG_WIN_PROFIT_MICRO: Record<Currency, bigint> = {
  USDC: 500_000_000n, // 500 USDC ≈ €500 (PRD spec).
  OZ: 500_000_000n,   // 500 OZ — half the signup bonus. Tune later.
};

// Recent tab freshness window. Per the Community Wall spec
// (notion.so/oddin/Community-Wall) the Feed tab is "bets you can
// place now" — accepted tickets on still-bettable matches. We cap
// recency at 24h so the feed doesn't surface a ticket from days ago
// just because the underlying match is still scheduled.
const RECENT_WINDOW = sql`now() - interval '24 hours'`;

const userTicketsQuery = z.object({
  currency: z.string().optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(50).default(20),
});

// Statuses that surface on the community feed. `voided` carries a
// stake-refund payout, which is still public proof of how a ticket
// resolved; keeping it lets the feed show all settled outcomes rather
// than only winners. Phase 10.3 may filter further on the client side.
//
// Stored as the bare comma-separated list — the IN call site wraps in
// its own parens. Wrapping here too produces `IN ((...))` which
// Postgres parses as a record-vs-text comparison and 500s with
// "operator does not exist: text = record". The original form (with
// internal parens) shipped behind a path that didn't trigger it
// because no settled tickets existed; loadProfileStats turned out to
// be the path that broke once /u/:nickname loaded a user with stats.
const FEED_STATUSES = sql`'settled', 'cashed_out', 'voided'`;

export default async function communityRoutes(app: FastifyInstance) {
  // ─── Feed ────────────────────────────────────────────────────────────────
  //
  // Two surfaces, one endpoint:
  //
  //   sort=recent (default) — "bets you can place now" per the
  //     Community Wall spec. Reads from the live `tickets` table:
  //     accepted tickets on matches that haven't gone terminal, from
  //     public bettors. The community_tickets projection only carries
  //     settled rows; using it here would surface unbettable tickets
  //     (the original complaint).
  //
  //   sort=best — Best Wins. Reads the `community_tickets` projection:
  //     settled tickets where payout > stake (won), within the 7-day
  //     window so a one-time monster ROI from a year ago can't squat
  //     the top forever.
  //
  // Both surfaces apply the same visibility filter: tickets_public=true
  // AND nickname IS NOT NULL.
  app.get("/community/feed", { config: readRateLimit }, async (request): Promise<CommunityFeedResponse> => {
    const q = feedQuery.parse(request.query);
    const currency: Currency | null =
      q.currency && isCurrency(q.currency) ? q.currency : null;

    if (q.tab === "best") {
      return loadBestWinsFeed(app, {
        currency,
        sport: q.sport,
        page: q.page,
        pageSize: q.pageSize,
        sort: q.sort,
        bigWinsOnly: q.bigWinsOnly,
      });
    }
    return loadRecentFeed(app, { currency, sport: q.sport, page: q.page, pageSize: q.pageSize });
  });

  // ─── Public profile ──────────────────────────────────────────────────────
  //
  // Returns nickname / bio / joinedAt and a per-currency stats block
  // computed from `community_tickets` aggregates. Anonymous; no auth
  // required. Returns 404 for users with `tickets_public=false` to
  // avoid leaking that the handle is taken.
  app.get<{
    Params: { nickname: string };
    Querystring: { currency?: string };
  }>("/community/users/:nickname/profile", { config: readRateLimit }, async (request) => {
    const nickname = request.params.nickname;
    if (!NICKNAME_RE.test(nickname)) throw new NotFoundError();

    const currency: Currency =
      request.query.currency && isCurrency(request.query.currency)
        ? request.query.currency
        : DEFAULT_CURRENCY;

    const [u] = await app.db
      .select({
        id: users.id,
        nickname: users.nickname,
        bio: users.bio,
        ticketsPublic: users.ticketsPublic,
        createdAt: users.createdAt,
        avatarSlug: avatarTemplates.slug,
        avatarImagePath: avatarTemplates.imagePath,
      })
      .from(users)
      .leftJoin(avatarTemplates, eq(avatarTemplates.id, users.avatarTemplateId))
      .where(eq(users.nickname, nickname))
      .limit(1);

    if (!u || !u.nickname || !u.ticketsPublic) throw new NotFoundError();

    const [stats, achievements] = await Promise.all([
      loadProfileStats(app.db, u.id, currency),
      loadAchievements(app.db, u.id),
    ]);

    const avatarUrl = resolveOptionalAvatarUrl(
      u.avatarSlug
        ? { slug: u.avatarSlug, imagePath: u.avatarImagePath }
        : null,
    );

    const profile: CommunityProfile = {
      nickname: u.nickname,
      bio: u.bio,
      avatarUrl,
      joinedAt: u.createdAt.toISOString(),
      stats: {
        currency,
        settledTickets: stats.settledTickets,
        wins: stats.wins,
        winRatePct: stats.winRatePct,
        roiPct: stats.roiPct,
        badgeCount: achievements.length,
      },
      achievements,
    };
    return profile;
  });

  // ─── Per-user tickets ────────────────────────────────────────────────────
  //
  // Returns the user's recent settled / cashed-out / voided tickets in
  // the same shape as the feed. Same visibility filter as the profile
  // — non-public users 404. Default currency is USDC to match the
  // profile-stats default.
  app.get<{
    Params: { nickname: string };
  }>(
    "/community/users/:nickname/tickets",
    { config: readRateLimit },
    async (request): Promise<CommunityUserTicketsResponse> => {
      const nickname = request.params.nickname;
      if (!NICKNAME_RE.test(nickname)) throw new NotFoundError();
      const q = userTicketsQuery.parse(request.query);
      const currency: Currency =
        q.currency && isCurrency(q.currency) ? q.currency : DEFAULT_CURRENCY;

      const [u] = await app.db
        .select({
          id: users.id,
          nickname: users.nickname,
          bio: users.bio,
          ticketsPublic: users.ticketsPublic,
        })
        .from(users)
        .where(eq(users.nickname, nickname))
        .limit(1);
      if (!u || !u.nickname || !u.ticketsPublic) throw new NotFoundError();

      const rows = await app.db
        .select({
          ticketId: communityTickets.ticketId,
          nickname: users.nickname,
          bio: users.bio,
          currency: communityTickets.currency,
          status: communityTickets.status,
          betType: communityTickets.betType,
          stakeMicro: communityTickets.stakeMicro,
          payoutMicro: communityTickets.payoutMicro,
          totalOdds: communityTickets.totalOdds,
          numLegs: communityTickets.numLegs,
          sportIds: communityTickets.sportIds,
          inspirationCount: communityTickets.inspirationCount,
          avatarSlug: avatarTemplates.slug,
          avatarImagePath: avatarTemplates.imagePath,
          // Per-user history is settled rows only; `at` carries the
          // settled-at value to match the type's contract.
          at: communityTickets.settledAt,
        })
        .from(communityTickets)
        .innerJoin(users, eq(users.id, communityTickets.userId))
        .leftJoin(
          avatarTemplates,
          eq(avatarTemplates.id, users.avatarTemplateId),
        )
        .where(
          and(
            eq(communityTickets.userId, u.id),
            eq(communityTickets.currency, currency),
            sql`${communityTickets.status}::text IN ('settled', 'cashed_out', 'voided')`,
          ),
        )
        .orderBy(desc(communityTickets.settledAt))
        .limit(q.pageSize + 1)
        .offset((q.page - 1) * q.pageSize);

      const hasMore = rows.length > q.pageSize;
      const page = rows.slice(0, q.pageSize).map(toFeedSummary);

      return {
        nickname: u.nickname,
        tickets: page,
        page: q.page,
        pageSize: q.pageSize,
        hasMore,
      };
    },
  );

  // ─── Copy-to-bet (Phase 10.3) ────────────────────────────────────────────
  //
  // Returns a prefill payload in the shape POST /bets accepts. The web
  // client adds the selections to the bet-slip; the user confirms and
  // submits via the normal placement flow. Authentication is NOT
  // required here — this is a read endpoint and the actual placement
  // is gated downstream. We still respect the same visibility filter
  // as the public profile / feed: a copy from a non-public profile
  // 404s to avoid leaking the handle.
  app.post<{ Params: { communityTicketId: string } }>(
    "/community/copy/:communityTicketId",
    { config: writeRateLimit },
    async (request): Promise<CommunityCopyResponse> => {
      const id = request.params.communityTicketId;
      if (!UUID_RE.test(id)) throw new NotFoundError();

      const [ct] = await app.db
        .select({
          ticketId: communityTickets.ticketId,
          currency: communityTickets.currency,
          betType: communityTickets.betType,
          ownerId: communityTickets.userId,
          ownerNickname: users.nickname,
        })
        .from(communityTickets)
        .innerJoin(users, eq(users.id, communityTickets.userId))
        .where(
          and(
            eq(communityTickets.ticketId, id),
            eq(users.ticketsPublic, true),
            sql`${users.nickname} IS NOT NULL`,
          ),
        )
        .limit(1);
      if (!ct) throw new NotFoundError();

      const rows = await app.db
        .select({
          matchId: matches.id,
          marketId: ticketSelections.marketId,
          outcomeId: ticketSelections.outcomeId,
          odds: ticketSelections.oddsAtPlacement,
          providerMarketId: markets.providerMarketId,
          marketStatus: markets.status,
          matchStatus: matches.status,
          homeTeam: matches.homeTeam,
          awayTeam: matches.awayTeam,
          outcomeName: marketOutcomes.name,
          sportSlug: sports.slug,
        })
        .from(ticketSelections)
        .innerJoin(markets, eq(markets.id, ticketSelections.marketId))
        .innerJoin(matches, eq(matches.id, markets.matchId))
        .innerJoin(tournaments, eq(tournaments.id, matches.tournamentId))
        .innerJoin(categories, eq(categories.id, tournaments.categoryId))
        .innerJoin(sports, eq(sports.id, categories.sportId))
        .leftJoin(
          marketOutcomes,
          and(
            eq(marketOutcomes.marketId, markets.id),
            eq(marketOutcomes.outcomeId, ticketSelections.outcomeId),
          ),
        )
        .where(eq(ticketSelections.ticketId, id))
        // Order by selection id so the slip prefill matches the
        // visual order of the original ticket card.
        .orderBy(ticketSelections.id);

      const selections = rows.map((r) => ({
        matchId: r.matchId.toString(),
        marketId: r.marketId.toString(),
        outcomeId: r.outcomeId,
        odds: r.odds,
        homeTeam: r.homeTeam,
        awayTeam: r.awayTeam,
        // Mirrors the storefront naming convention for unlabeled
        // markets — see CLAUDE.md "Which markets?" entry.
        marketLabel: `Market #${r.providerMarketId}`,
        outcomeLabel: r.outcomeName ?? r.outcomeId,
        sportSlug: r.sportSlug,
        // Available = market is open AND match isn't already over.
        // Same predicate the storefront uses to decide whether to
        // show odds buttons. POST /bets re-validates anyway, so this
        // is a UX hint, not a security gate.
        available:
          r.marketStatus === 1 &&
          (r.matchStatus === "not_started" || r.matchStatus === "live"),
      }));

      // Best-effort inspiration counter bump. Drives the Most
      // Copied sort on the Big Wins tab. Fire-and-forget — a
      // failed counter must never break the prefill response,
      // since the user-visible Copy flow is what matters and the
      // counter is a coarse sort signal (PRD: "Most Copied" is a
      // sort key, not a number we ask the user to trust).
      // Inflation is bounded by the route's existing 30/min/IP
      // rate limit; tighter dedup (per-viewer cookie) is tracked
      // for the audit-table follow-up.
      app.db
        .update(communityTickets)
        .set({ inspirationCount: sql`${communityTickets.inspirationCount} + 1` })
        .where(eq(communityTickets.ticketId, id))
        .catch((err: unknown) => {
          app.log.warn({ err, ticketId: id }, "inspiration_count bump failed");
        });

      // Emit `pick_copied` to the ticket owner. Same fire-and-forget
      // contract as the counter bump above — a failed emit must not
      // break the prefill. The actor is whoever is signed in
      // (request.user is populated when a JWT cookie verifies, even
      // on this auth-optional route); we silently skip when anonymous
      // because the panel needs an actor name to render "X copied
      // your bet". The emit helper itself drops self-emits.
      const actor = request.user;
      if (actor) {
        (async () => {
          const [actorRow] = await app.db
            .select({ nickname: users.nickname })
            .from(users)
            .where(eq(users.id, actor.id))
            .limit(1);
          if (!actorRow?.nickname) return;
          await emitNotification(app, {
            userId: ct.ownerId,
            type: "pick_copied",
            actorId: actor.id,
            payload: {
              actorNickname: actorRow.nickname,
              sourceCommunityTicketId: id,
            },
            // Group on the source ticket so "3 people copied your
            // bet" collapses correctly within the dedup window.
            groupKey: `pick_copied:${id}`,
            // Deep-link to the copier's profile. The owner can see
            // who's copying them.
            deepLink: actorRow.nickname ? `/u/${encodeURIComponent(actorRow.nickname)}` : null,
          });
        })().catch((err: unknown) => {
          app.log.warn({ err, ticketId: id }, "pick_copied emit failed");
        });
      }

      return {
        // CHAR(4) → trim padding at the API boundary, same convention
        // as the feed / per-user-tickets paths above.
        currency: ct.currency.trim() as Currency,
        betType: ct.betType,
        selections,
        anyAvailable: selections.some((s) => s.available),
      };
    },
  );

  // ─── Apply Same Play (Phase 10.4) ────────────────────────────────────────
  //
  // Companion to /community/copy. Takes a single-leg winning ticket
  // and proposes upcoming matches the user could run the same play
  // on. The scoring + ranking lives client-side
  // (apps/web/src/lib/same-play-scorer.ts) so the algorithm is
  // visible in code review and the chips/popover read from one
  // source of truth. The backend's job is two-fold:
  //
  //   1. Hydrate the originator's structured `play` (provider
  //      market id + outcome id), `teams` (with picked-side / role),
  //      league tier, and stake/odds for the stake-conversion math.
  //   2. Return a pool of upcoming candidate matches in the same
  //      sport with the same provider_market_id + outcome_id
  //      currently quoted on at least one open market. Capped at
  //      30 — the FE shows the top 10 by score, but more raw
  //      candidates make the ranking less brittle when a few rows
  //      get knocked out by suspended-market state.
  //
  // V1 limits (documented in @oddzilla/types):
  //   • Combo originators return 400 combo_unsupported.
  //   • Non-winning originators return 400 not_a_win — Apply Same
  //     Play only makes sense as a "do this again" affordance on a
  //     bet that paid out.
  app.get<{ Params: { communityTicketId: string } }>(
    "/community/apply-same-play/:communityTicketId/candidates",
    { config: readRateLimit },
    async (request): Promise<ApplySamePlayResponse> => {
      const id = request.params.communityTicketId;
      if (!UUID_RE.test(id)) throw new NotFoundError();

      // Originator pull. Same visibility filter as /community/copy
      // — non-public bettors are invisible to the lookup. Single
      // SELECT joins all the way through to tournaments so the
      // role inference can read the originator's odds + competitor
      // ids without a second roundtrip.
      const [orig] = await app.db
        .select({
          ticketId: tickets.id,
          numLegs: sql<number>`(
            SELECT COUNT(*)::int FROM ticket_selections WHERE ticket_id = ${tickets.id}
          )`,
          status: tickets.status,
          currency: tickets.currency,
          stakeMicro: tickets.stakeMicro,
          actualPayoutMicro: tickets.actualPayoutMicro,
          marketId: ticketSelections.marketId,
          outcomeId: ticketSelections.outcomeId,
          oddsAtPlacement: ticketSelections.oddsAtPlacement,
          providerMarketId: markets.providerMarketId,
          matchId: matches.id,
          homeTeam: matches.homeTeam,
          awayTeam: matches.awayTeam,
          homeCompetitorId: matches.homeCompetitorId,
          awayCompetitorId: matches.awayCompetitorId,
          tournamentId: tournaments.id,
          riskTier: tournaments.riskTier,
          sportId: sports.id,
          sportName: sports.name,
          outcomeName: marketOutcomes.name,
        })
        .from(tickets)
        .innerJoin(users, eq(users.id, tickets.userId))
        .innerJoin(ticketSelections, eq(ticketSelections.ticketId, tickets.id))
        .innerJoin(markets, eq(markets.id, ticketSelections.marketId))
        .innerJoin(matches, eq(matches.id, markets.matchId))
        .innerJoin(tournaments, eq(tournaments.id, matches.tournamentId))
        .innerJoin(categories, eq(categories.id, tournaments.categoryId))
        .innerJoin(sports, eq(sports.id, categories.sportId))
        .leftJoin(
          marketOutcomes,
          and(
            eq(marketOutcomes.marketId, ticketSelections.marketId),
            eq(marketOutcomes.outcomeId, ticketSelections.outcomeId),
          ),
        )
        .where(
          and(
            eq(tickets.id, id),
            eq(users.ticketsPublic, true),
            sql`${users.nickname} IS NOT NULL`,
          ),
        )
        .limit(2);

      if (!orig) throw new NotFoundError();
      if (orig.numLegs > 1) {
        throw new BadRequestError("combo_unsupported", "combo_unsupported");
      }
      // "Won" predicate matches the feed: settled or cashed_out
      // with payout > stake. Voided / lost / accepted all reject
      // — Apply Same Play is a "do this winning play again"
      // affordance, not a generic copy.
      const status = orig.status;
      const payout = orig.actualPayoutMicro ?? 0n;
      const isWin =
        (status === "settled" || status === "cashed_out") &&
        BigInt(payout) > BigInt(orig.stakeMicro);
      if (!isWin) {
        throw new BadRequestError("not_a_win", "not_a_win");
      }

      const currency = orig.currency.trim() as Currency;
      const origOdds = parseFloat(orig.oddsAtPlacement);
      const pickedRole = inferRole(origOdds);
      const pickedSide = inferPickedSide(
        orig.outcomeName,
        orig.homeTeam,
        orig.awayTeam,
      );

      const originator: SamePlayOriginator = {
        ticketId: orig.ticketId,
        currency,
        stakeMicro: orig.stakeMicro.toString(),
        originalOdds: orig.oddsAtPlacement,
        play: {
          providerMarketId: orig.providerMarketId,
          outcomeId: orig.outcomeId,
          outcomeLabel: orig.outcomeName ?? orig.outcomeId,
          marketLabel: `Market #${orig.providerMarketId}`,
        },
        teams: {
          home: orig.homeTeam,
          away: orig.awayTeam,
          homeCompetitorId: orig.homeCompetitorId,
          awayCompetitorId: orig.awayCompetitorId,
          pickedSide,
          pickedRole,
        },
        sportId: orig.sportId,
        sportName: orig.sportName,
        leagueTier: orig.riskTier,
      };

      // Candidate pull. Same sport, future kickoff, has the same
      // provider_market_id market with the same outcome_id quoted
      // at fetch time. Excludes the originator's own match (it's
      // already settled). Caps at 30 so the FE always has enough
      // raw candidates to absorb suspensions without dropping the
      // whole list.
      //
      // Ordering: closest kickoff first. The scorer reorders by
      // score on the FE; this is just a cheap default that gives
      // sensible behaviour if scoring fails open.
      const candidateRows = await app.db.execute<Record<string, unknown>>(sql`
SELECT
  m.id                                                               AS "matchId",
  mk.id                                                              AS "marketId",
  m.home_team                                                        AS "homeTeam",
  m.away_team                                                        AS "awayTeam",
  m.home_competitor_id                                               AS "homeCompetitorId",
  m.away_competitor_id                                               AS "awayCompetitorId",
  m.scheduled_at                                                     AS "scheduledAt",
  EXTRACT(EPOCH FROM (m.scheduled_at - now())) / 3600.0               AS "hoursToKickoff",
  (mk.status <> 1)                                                   AS suspended,
  mo.published_odds                                                  AS "currentOdds",
  tn.risk_tier                                                       AS "leagueTier",
  tn.name                                                            AS "tournamentName",
  s.slug                                                             AS "sportSlug"
  FROM matches m
  JOIN tournaments tn ON tn.id = m.tournament_id
  JOIN categories c   ON c.id = tn.category_id
  JOIN sports s       ON s.id = c.sport_id
  JOIN markets mk     ON mk.match_id = m.id
                     AND mk.provider_market_id = ${orig.providerMarketId}
  JOIN market_outcomes mo
                      ON mo.market_id = mk.id
                     AND mo.outcome_id = ${orig.outcomeId}
                     AND mo.active = true
                     AND mo.published_odds IS NOT NULL
 WHERE s.id = ${orig.sportId}
   AND m.id <> ${orig.matchId}
   AND m.status = 'not_started'
   AND m.scheduled_at > now()
 ORDER BY m.scheduled_at ASC
 LIMIT 30
`);

      const candidates: SamePlayCandidate[] = candidateRows.map((r) => ({
        matchId: String(r.matchId),
        marketId: String(r.marketId),
        homeTeam: String(r.homeTeam),
        awayTeam: String(r.awayTeam),
        homeCompetitorId:
          r.homeCompetitorId === null || r.homeCompetitorId === undefined
            ? null
            : Number(r.homeCompetitorId),
        awayCompetitorId:
          r.awayCompetitorId === null || r.awayCompetitorId === undefined
            ? null
            : Number(r.awayCompetitorId),
        scheduledAt:
          r.scheduledAt instanceof Date
            ? r.scheduledAt.toISOString()
            : new Date(r.scheduledAt as string).toISOString(),
        hoursToKickoff: Number(r.hoursToKickoff ?? 0),
        suspended: Boolean(r.suspended),
        currentOdds: String(r.currentOdds),
        role: inferRole(parseFloat(String(r.currentOdds))),
        leagueTier:
          r.leagueTier === null || r.leagueTier === undefined
            ? null
            : Number(r.leagueTier),
        tournamentName: String(r.tournamentName),
        sportSlug: String(r.sportSlug),
      }));

      return { originator, candidates };
    },
  );

  // ─── Self view ───────────────────────────────────────────────────────────

  app.get("/community/me", async (request): Promise<CommunityMe> => {
    const u = request.requireAuth();
    const me = await loadCommunityMe(app, u.id);
    if (!me) throw new NotFoundError();
    return me;
  });

  // ─── Visibility toggle ───────────────────────────────────────────────────

  app.patch(
    "/community/me/visibility",
    { config: writeRateLimit },
    async (request): Promise<CommunityMe> => {
      const u = request.requireAuth();
      const body: CommunityVisibilityRequest = visibilityBody.parse(
        request.body,
      );
      const [updated] = await app.db
        .update(users)
        .set({ ticketsPublic: body.ticketsPublic, updatedAt: new Date() })
        .where(eq(users.id, u.id))
        .returning({ id: users.id });
      if (!updated) throw new NotFoundError();
      // Re-read with the avatar JOIN so the response shape stays
      // self-contained (matches /community/me). The follow-up SELECT
      // is bounded to one user and keyed on PK — cheap.
      const me = await loadCommunityMe(app, u.id);
      if (!me) throw new NotFoundError();
      return me;
    },
  );

  // ─── Nickname / bio ──────────────────────────────────────────────────────
  //
  // Both fields are optional; at least one must be present. Nickname
  // collisions surface as 409 nickname_taken (citext UNIQUE on the
  // column). The DB-side CHECK is the second line of defence — zod
  // rejects malformed input first.
  app.patch(
    "/community/me/profile",
    { config: writeRateLimit },
    async (request): Promise<CommunityMe> => {
      const u = request.requireAuth();
      const body: CommunityProfileRequest = profileBody.parse(request.body);

      if (body.nickname === undefined && body.bio === undefined) {
        throw new BadRequestError("no_changes", "no_changes");
      }

      const patch: Partial<typeof users.$inferInsert> = { updatedAt: new Date() };
      if (body.nickname !== undefined) patch.nickname = body.nickname;
      if (body.bio !== undefined) patch.bio = body.bio;

      try {
        const [updated] = await app.db
          .update(users)
          .set(patch)
          .where(eq(users.id, u.id))
          .returning({ id: users.id });
        if (!updated) throw new NotFoundError();
        const me = await loadCommunityMe(app, u.id);
        if (!me) throw new NotFoundError();
        return me;
      } catch (err) {
        // 23505 = unique_violation. The nickname column is the only
        // unique on this UPDATE path — citext makes the comparison
        // case-insensitive so "Alex" and "alex" collide as expected.
        if (isUniqueViolation(err)) {
          throw new ConflictError("nickname_taken", "nickname_taken");
        }
        throw err;
      }
    },
  );
}

// ─── Helpers ───────────────────────────────────────────────────────────────

interface ProfileStatsRow extends Record<string, unknown> {
  settled: number;
  wins: number;
  totalStake: string | bigint;
  totalPayout: string | bigint;
}

interface ProfileStats {
  settledTickets: number;
  wins: number;
  winRatePct: number;
  roiPct: number;
}

// ROI numerator counts cashed-out and won tickets as positive returns;
// voided tickets break even (payout = stake refund). Win rate counts
// settled tickets where payout > stake — same intuition the leaderboard
// will use in 10.3.
async function loadProfileStats(
  db: FastifyInstance["db"],
  userId: string,
  currency: Currency,
): Promise<ProfileStats> {
  const rows = await db.execute<ProfileStatsRow>(sql`
    SELECT
      COUNT(*)::int                                         AS settled,
      COUNT(*) FILTER (
        WHERE status::text IN ('settled', 'cashed_out')
          AND payout_micro > stake_micro
      )::int                                                AS wins,
      COALESCE(SUM(stake_micro), 0)::bigint                 AS total_stake,
      COALESCE(SUM(payout_micro), 0)::bigint                AS total_payout
      FROM community_tickets
     WHERE user_id = ${userId}
       AND currency = ${currency}
       AND status::text IN (${FEED_STATUSES})
  `);

  const row = rows[0];
  if (!row || row.settled === 0) {
    return { settledTickets: 0, wins: 0, winRatePct: 0, roiPct: 0 };
  }

  const totalStake = BigInt(row.totalStake);
  const totalPayout = BigInt(row.totalPayout);
  const winRatePct = Math.round((row.wins / row.settled) * 100);
  // ROI = (payout - stake) / stake. If totalStake==0 (impossible per
  // the CHECK constraint, but defensive) we surface 0 rather than NaN.
  const roiPct =
    totalStake === 0n
      ? 0
      : Number(((totalPayout - totalStake) * 10000n) / totalStake) / 100;

  return {
    settledTickets: row.settled,
    wins: row.wins,
    winRatePct,
    roiPct: Math.round(roiPct),
  };
}

interface FeedRow {
  ticketId: string;
  nickname: string | null;
  bio: string | null;
  currency: string;
  status: string;
  betType: string;
  stakeMicro: bigint;
  payoutMicro: bigint;
  totalOdds: string;
  numLegs: number;
  sportIds: number[];
  // Always present in projection-backed paths; defaulted to 0 by the
  // recent loader (which reads the live tickets table where there is
  // no inspiration counter). The shape stays uniform so every caller
  // hits the same toFeedSummary path.
  inspirationCount: number;
  // Avatar fields come from a LEFT JOIN onto avatar_templates via
  // users.avatar_template_id. NULL on every column when the user
  // hasn't equipped one — toFeedSummary resolves to a NULL avatarUrl
  // which the UI maps to its monogram fallback.
  avatarSlug: string | null;
  avatarImagePath: string | null;
  at: Date;
}

function toFeedSummary(r: FeedRow): CommunityTicketSummary {
  // The where-clause on every endpoint already filters out null
  // nicknames — this assertion documents the invariant for type
  // narrowing. If the constraint ever loosens, the runtime guard below
  // surfaces it as a 500 rather than a silent stringified `null`.
  if (r.nickname === null) {
    throw new Error("toFeedSummary: nickname unexpectedly null");
  }
  // CHAR(4) columns come back space-padded from postgres ("OZ  ").
  // Trim at the API boundary, matching the wallet + bets convention.
  const currency = r.currency.trim() as Currency;
  // Profit derivation matches the Best Wins query plan and the UI's
  // hero-card focal value. For accepted tickets payoutMicro carries
  // the *potential* payout (frozen at placement), so this surfaces
  // the in-flight "to win" number on the Recent tab too.
  const profitMicro = r.payoutMicro - r.stakeMicro;
  // isBigWin trips only on real wins: a void or loss never qualifies
  // even if profitMicro is positive on a fluke (it can't be, but the
  // status guard makes the invariant explicit). Threshold lookup
  // falls back to USDC for any unknown currency — safe default since
  // the per-currency floor is product-tunable, not security-critical.
  const isWin = r.status === "settled" || r.status === "cashed_out";
  const floor =
    currency in BIG_WIN_PROFIT_MICRO
      ? BIG_WIN_PROFIT_MICRO[currency]
      : BIG_WIN_PROFIT_MICRO.USDC;
  const isBigWin =
    isWin && r.payoutMicro > r.stakeMicro && profitMicro >= floor;
  return {
    ticketId: r.ticketId,
    nickname: r.nickname,
    bio: r.bio,
    currency,
    status: r.status as CommunityTicketSummary["status"],
    betType: r.betType as CommunityTicketSummary["betType"],
    stakeMicro: r.stakeMicro.toString(),
    payoutMicro: r.payoutMicro.toString(),
    profitMicro: profitMicro.toString(),
    totalOdds: r.totalOdds,
    numLegs: r.numLegs,
    sportIds: r.sportIds,
    inspirationCount: r.inspirationCount,
    avatarUrl: resolveOptionalAvatarUrl(
      r.avatarSlug
        ? { slug: r.avatarSlug, imagePath: r.avatarImagePath }
        : null,
    ),
    isBigWin,
    at: r.at.toISOString(),
  };
}

// ─── Feed loaders ──────────────────────────────────────────────────────────

interface FeedLoaderArgs {
  currency: Currency | null;
  sport: number | undefined;
  page: number;
  pageSize: number;
}

interface BestWinsLoaderArgs extends FeedLoaderArgs {
  sort: "recent" | "copied" | "stakes" | "live";
  bigWinsOnly: boolean;
}

// Recent tab — accepted tickets on still-bettable matches. Reads the
// live `tickets` table directly because the community_tickets
// projection only carries settled rows. The query mirrors the
// projection-write SQL (services/api/src/modules/community/
// projection.ts) so cards on the Recent tab look identical to ones
// the same user will land on after settle.
async function loadRecentFeed(
  app: FastifyInstance,
  q: FeedLoaderArgs,
): Promise<CommunityFeedResponse> {
  // Query parameters are inlined via Drizzle's sql template — currency
  // and sport are validated by the route's zod schema; the user-id /
  // status / match-status sets are literals so injection isn't a
  // concern even on the raw SQL path.
  const currencyClause = q.currency
    ? sql`AND t.currency = ${q.currency}`
    : sql``;
  const sportClause =
    q.sport !== undefined
      ? sql`AND ${q.sport}::int = ANY(legs.sport_ids)`
      : sql``;

  const rows = await app.db.execute<Record<string, unknown>>(sql`
WITH legs AS (
  SELECT
    t.id           AS ticket_id,
    t.user_id      AS user_id,
    t.currency     AS currency,
    t.status       AS status,
    t.bet_type     AS bet_type,
    t.stake_micro  AS stake_micro,
    t.potential_payout_micro AS payout_micro,
    t.placed_at    AS at,
    COUNT(*)::int                                                AS num_legs,
    COALESCE(
      ARRAY_AGG(DISTINCT c.sport_id) FILTER (WHERE c.sport_id IS NOT NULL),
      '{}'::int[]
    )                                                            AS sport_ids,
    EXP(SUM(LN(ts.odds_at_placement::float8)))::numeric(10, 4)   AS total_odds,
    -- Defining "still bettable" as "at least one leg is on a market
    -- that's currently active (status=1) on a match that hasn't gone
    -- terminal". Mirrors the storefront's hasActiveMarket predicate
    -- (see CLAUDE.md "Catalog API"). If every leg has settled / been
    -- voided, the ticket isn't actionable anymore — drop it from the
    -- Recent feed.
    BOOL_OR(mk.status = 1 AND mt.status IN ('not_started', 'live')) AS bettable
    FROM tickets t
    JOIN ticket_selections ts ON ts.ticket_id = t.id
    JOIN markets mk           ON mk.id = ts.market_id
    JOIN matches mt           ON mt.id = mk.match_id
    JOIN tournaments tn       ON tn.id = mt.tournament_id
    JOIN categories c         ON c.id = tn.category_id
   WHERE t.status = 'accepted'
     AND t.placed_at >= ${RECENT_WINDOW}
   GROUP BY t.id
)
SELECT
  legs.ticket_id            AS "ticketId",
  u.nickname                AS nickname,
  u.bio                     AS bio,
  legs.currency             AS currency,
  legs.status::text         AS status,
  legs.bet_type::text       AS "betType",
  legs.stake_micro          AS "stakeMicro",
  legs.payout_micro         AS "payoutMicro",
  legs.total_odds           AS "totalOdds",
  legs.num_legs             AS "numLegs",
  legs.sport_ids            AS "sportIds",
  -- Recent feed reads the live tickets table; inspiration_count
  -- only exists on the settled projection. Project a literal so
  -- the row shape matches FeedRow / toFeedSummary uniformly.
  0::int                    AS "inspirationCount",
  -- LEFT JOIN onto avatar_templates via users.avatar_template_id.
  -- Both columns are NULL when the user has no equipped avatar;
  -- toFeedSummary maps that to a NULL avatarUrl which the UI uses
  -- as the signal to render a monogram.
  av.slug                   AS "avatarSlug",
  av.image_path             AS "avatarImagePath",
  legs.at                   AS at
  FROM legs
  JOIN users u ON u.id = legs.user_id
  LEFT JOIN avatar_templates av ON av.id = u.avatar_template_id
 WHERE u.tickets_public = true
   AND u.nickname IS NOT NULL
   AND legs.bettable = true
   ${currencyClause}
   ${sportClause}
 ORDER BY legs.at DESC
 LIMIT ${q.pageSize + 1}
 OFFSET ${(q.page - 1) * q.pageSize}
`);

  const all = rows.map((r) => normaliseFeedRow(r));
  const hasMore = all.length > q.pageSize;
  const page = all.slice(0, q.pageSize).map(toFeedSummary);
  return {
    tickets: page,
    page: q.page,
    pageSize: q.pageSize,
    hasMore,
  };
}

// Best Wins tab — settled, won tickets from the projection. "Won" =
// payout_micro > stake_micro (excludes voided + cashed_out where the
// payout was below stake). Cashed_out wins are surfaced because the
// user did profit on them; cashed_out losses (offer < stake) are
// dropped by the same predicate.
//
// `bigWinsOnly` adds a profit-floor predicate keyed by currency.
// When set without an explicit currency, the floor applies per-row
// using BIG_WIN_PROFIT_MICRO[r.currency] — encoded inline as a CASE
// so the planner can still use the existing indexes.
async function loadBestWinsFeed(
  app: FastifyInstance,
  q: BestWinsLoaderArgs,
): Promise<CommunityFeedResponse> {
  const filters = [
    eq(users.ticketsPublic, true),
    sql`${users.nickname} IS NOT NULL`,
    sql`${communityTickets.status}::text IN ('settled', 'cashed_out')`,
    sql`${communityTickets.payoutMicro} > ${communityTickets.stakeMicro}`,
    sql`${communityTickets.settledAt} >= ${BEST_WINS_WINDOW}`,
  ];
  if (q.currency) filters.push(eq(communityTickets.currency, q.currency));
  if (q.sport !== undefined) {
    filters.push(sql`${communityTickets.sportIds} @> ARRAY[${q.sport}]::int[]`);
  }
  if (q.bigWinsOnly) {
    filters.push(bigWinFilter(q.currency));
  }

  // ORDER BY mapping. Tied breaks always fall back to settled_at DESC
  // so cards within a tied bucket render newest-first.
  //   recent  → settled_at DESC
  //   copied  → inspiration_count DESC, settled_at DESC
  //   stakes  → profit DESC, settled_at DESC
  //   live    → Phase A fallback to recent (see feedQuery comment)
  const profit = sql`${communityTickets.payoutMicro} - ${communityTickets.stakeMicro}`;
  const orderBy = (() => {
    switch (q.sort) {
      case "copied":
        return [desc(communityTickets.inspirationCount), desc(communityTickets.settledAt)];
      case "stakes":
        return [sql`${profit} DESC`, desc(communityTickets.settledAt)];
      case "live":
      case "recent":
      default:
        return [desc(communityTickets.settledAt)];
    }
  })();

  const rows = await app.db
    .select({
      ticketId: communityTickets.ticketId,
      nickname: users.nickname,
      bio: users.bio,
      currency: communityTickets.currency,
      status: communityTickets.status,
      betType: communityTickets.betType,
      stakeMicro: communityTickets.stakeMicro,
      payoutMicro: communityTickets.payoutMicro,
      totalOdds: communityTickets.totalOdds,
      numLegs: communityTickets.numLegs,
      sportIds: communityTickets.sportIds,
      inspirationCount: communityTickets.inspirationCount,
      avatarSlug: avatarTemplates.slug,
      avatarImagePath: avatarTemplates.imagePath,
      at: communityTickets.settledAt,
    })
    .from(communityTickets)
    .innerJoin(users, eq(users.id, communityTickets.userId))
    .leftJoin(avatarTemplates, eq(avatarTemplates.id, users.avatarTemplateId))
    .where(and(...filters))
    .orderBy(...orderBy)
    .limit(q.pageSize + 1)
    .offset((q.page - 1) * q.pageSize);

  const hasMore = rows.length > q.pageSize;
  const page = rows.slice(0, q.pageSize).map(toFeedSummary);
  return {
    tickets: page,
    page: q.page,
    pageSize: q.pageSize,
    hasMore,
  };
}

// Builds the WHERE clause that restricts Best Wins to rows whose
// profit clears the per-currency Big Win floor.
//
// Two shapes:
//   • caller specified a currency → flat `profit >= floor` predicate;
//     the planner can short-circuit with a literal bigint.
//   • currency is null (cross-currency feed) → per-row CASE that
//     looks up the floor by the row's own currency. Slightly less
//     plan-friendly but correct without a JOIN onto a config table.
function bigWinFilter(currency: Currency | null): SQL {
  const profit = sql`${communityTickets.payoutMicro} - ${communityTickets.stakeMicro}`;
  if (currency) {
    return sql`${profit} >= ${BIG_WIN_PROFIT_MICRO[currency]}`;
  }
  // postgres-js binds bigint literals correctly via Drizzle's sql tag.
  return sql`${profit} >= CASE
    WHEN ${communityTickets.currency} = 'USDC' THEN ${BIG_WIN_PROFIT_MICRO.USDC}
    WHEN ${communityTickets.currency} = 'OZ'   THEN ${BIG_WIN_PROFIT_MICRO.OZ}
    ELSE ${BIG_WIN_PROFIT_MICRO.USDC}
  END`;
}

// Coerce a raw postgres-js row (numerics as strings, bigints as
// strings, timestamps as Date) into the shape toFeedSummary consumes.
// Used only by the Recent loader, which goes through `db.execute()`
// and skips Drizzle's type narrowing.
function normaliseFeedRow(r: Record<string, unknown>): FeedRow {
  return {
    ticketId: r.ticketId as string,
    nickname: (r.nickname as string | null) ?? null,
    bio: (r.bio as string | null) ?? null,
    currency: r.currency as string,
    status: r.status as string,
    betType: r.betType as string,
    stakeMicro:
      typeof r.stakeMicro === "bigint"
        ? r.stakeMicro
        : BigInt(r.stakeMicro as string | number),
    payoutMicro:
      typeof r.payoutMicro === "bigint"
        ? r.payoutMicro
        : BigInt(r.payoutMicro as string | number),
    totalOdds: r.totalOdds as string,
    numLegs: Number(r.numLegs),
    sportIds: Array.isArray(r.sportIds) ? (r.sportIds as number[]) : [],
    inspirationCount: Number(r.inspirationCount ?? 0),
    avatarSlug: (r.avatarSlug as string | null) ?? null,
    avatarImagePath: (r.avatarImagePath as string | null) ?? null,
    at: r.at instanceof Date ? r.at : new Date(r.at as string),
  };
}

// Loads the user's achievement unlock list joined to the catalog.
// Sorted by the catalog's display order so the profile renders the
// same badge ordering across users; ties broken by unlock recency.
async function loadAchievements(
  db: FastifyInstance["db"],
  userId: string,
): Promise<CommunityAchievement[]> {
  const rows = await db
    .select({
      id: achievementDefinitions.id,
      title: achievementDefinitions.title,
      description: achievementDefinitions.description,
      icon: achievementDefinitions.icon,
      sortOrder: achievementDefinitions.sortOrder,
      unlockedAt: userAchievements.unlockedAt,
    })
    .from(userAchievements)
    .innerJoin(
      achievementDefinitions,
      eq(achievementDefinitions.id, userAchievements.achievementId),
    )
    .where(eq(userAchievements.userId, userId))
    .orderBy(
      asc(achievementDefinitions.sortOrder),
      desc(userAchievements.unlockedAt),
    );

  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    description: r.description,
    icon: r.icon,
    unlockedAt: r.unlockedAt.toISOString(),
  }));
}

// Loads a CommunityMe view for `userId`, joining the equipped avatar
// template so the response carries both the raw FK (for the picker UI
// to highlight the active row) and the resolved URL (for the topbar
// chrome). The follow-up SELECT after every PATCH lives here too —
// .returning() can't LEFT JOIN, and a second roundtrip on a PK lookup
// is functionally free.
async function loadCommunityMe(
  app: FastifyInstance,
  userId: string,
): Promise<CommunityMe | null> {
  const [row] = await app.db
    .select({
      ticketsPublic: users.ticketsPublic,
      nickname: users.nickname,
      bio: users.bio,
      avatarTemplateId: users.avatarTemplateId,
      avatarSlug: avatarTemplates.slug,
      avatarImagePath: avatarTemplates.imagePath,
    })
    .from(users)
    .leftJoin(avatarTemplates, eq(avatarTemplates.id, users.avatarTemplateId))
    .where(eq(users.id, userId))
    .limit(1);
  if (!row) return null;
  return {
    ticketsPublic: row.ticketsPublic,
    nickname: row.nickname,
    bio: row.bio,
    avatarTemplateId: row.avatarTemplateId,
    avatarUrl: resolveOptionalAvatarUrl(
      row.avatarSlug
        ? { slug: row.avatarSlug, imagePath: row.avatarImagePath }
        : null,
    ),
  };
}

// Coarse role inference from a moneyline-style price. Mirrors the
// scorer's `inferRole` so the originator's role and each candidate's
// role come out of the same heuristic. < 1.8 → favorite; > 2.4 →
// underdog; in between → even. NaN / non-finite falls back to "even"
// so a missing price never kicks the whole candidate out of the list.
function inferRole(odds: number): SamePlayRole {
  if (!Number.isFinite(odds)) return "even";
  if (odds < 1.8) return "favorite";
  if (odds > 2.4) return "underdog";
  return "even";
}

// Best-effort match between an outcome name and the home/away team.
// Oddin sometimes labels moneyline outcomes "1"/"2"/"X" (no team
// name in the outcome at all), so a null result is the common case
// and not a bug. The scorer reads pickedSide=null as "no role
// inference possible from the side", and the role-match reason
// keeps firing off the price-derived role only.
function inferPickedSide(
  outcomeName: string | null,
  homeTeam: string,
  awayTeam: string,
): "home" | "away" | null {
  if (!outcomeName) return null;
  const lower = outcomeName.toLowerCase();
  if (lower.includes(homeTeam.toLowerCase())) return "home";
  if (lower.includes(awayTeam.toLowerCase())) return "away";
  return null;
}

function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code: unknown }).code === "23505"
  );
}
