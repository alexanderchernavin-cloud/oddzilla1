// /community/* endpoints (Phase 10.1 + 10.2).
//
// Public reads:
//   GET    /community/feed?currency=&sport=&page=&pageSize=
//   GET    /community/users/:nickname/profile?currency=USDT|OZ
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
import { and, eq, sql, desc, asc } from "drizzle-orm";
import {
  users,
  communityTickets,
  ticketSelections,
  markets,
  marketOutcomes,
  matches,
  tournaments,
  categories,
  sports,
  achievementDefinitions,
  userAchievements,
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
} from "@oddzilla/types";
import { isCurrency, DEFAULT_CURRENCY } from "@oddzilla/types";
import {
  BadRequestError,
  ConflictError,
  NotFoundError,
} from "../../lib/errors.js";

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

// Feed query. Defaults match the storefront: 20 cards a page, USDT
// (the locked-leaderboards currency under D4) gets the default tab,
// "all sports" when sport is omitted. `sort=best` switches to the
// Phase 10.3 Best Wins ranking — score-then-recency, restricted to a
// 7-day rolling window so old rows can't dominate the leaderboard
// (the stored score is time-invariant by design; the recency cutoff
// is applied at query time).
const feedQuery = z.object({
  currency: z.string().optional(),
  sport: z.coerce.number().int().positive().optional(),
  sort: z.enum(["recent", "best"]).default("recent"),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(50).default(20),
});

// Best Wins window. Long enough to catch a slow Sunday afternoon;
// short enough that ancient blowout wins don't squat the top of the
// feed indefinitely. See docs/COMMUNITY_PLAN.md §scoring.
const BEST_WINS_WINDOW = sql`now() - interval '7 days'`;

const userTicketsQuery = z.object({
  currency: z.string().optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(50).default(20),
});

// Statuses that surface on the community feed. `voided` carries a
// stake-refund payout, which is still public proof of how a ticket
// resolved; keeping it lets the feed show all settled outcomes rather
// than only winners. Phase 10.3 may filter further on the client side.
const FEED_STATUSES = sql`('settled', 'cashed_out', 'voided')`;

export default async function communityRoutes(app: FastifyInstance) {
  // ─── Feed ────────────────────────────────────────────────────────────────
  //
  // Anonymous, recent-first. Joins `community_tickets` to `users` to
  // surface the nickname / bio per card. Filters out users with
  // `tickets_public = false` and users without a nickname (no public
  // surface to link to).
  app.get("/community/feed", { config: readRateLimit }, async (request): Promise<CommunityFeedResponse> => {
    const q = feedQuery.parse(request.query);
    const currency: Currency | null =
      q.currency && isCurrency(q.currency) ? q.currency : null;

    const filters = [
      eq(users.ticketsPublic, true),
      sql`${users.nickname} IS NOT NULL`,
      sql`${communityTickets.status}::text IN ('settled', 'cashed_out', 'voided')`,
    ];
    if (currency) filters.push(eq(communityTickets.currency, currency));
    if (q.sport !== undefined) {
      filters.push(sql`${communityTickets.sportIds} @> ARRAY[${q.sport}]::int[]`);
    }
    // Best Wins narrows to a recent window. The stored score is
    // time-invariant by design (recency = applied here, not stored),
    // so without this cutoff a one-time monster ROI from a year ago
    // would squat #1 forever.
    if (q.sort === "best") {
      filters.push(sql`${communityTickets.settledAt} >= ${BEST_WINS_WINDOW}`);
    }

    const orderBy =
      q.sort === "best"
        ? [desc(communityTickets.score), desc(communityTickets.settledAt)]
        : [desc(communityTickets.settledAt)];

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
        settledAt: communityTickets.settledAt,
      })
      .from(communityTickets)
      .innerJoin(users, eq(users.id, communityTickets.userId))
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
      })
      .from(users)
      .where(eq(users.nickname, nickname))
      .limit(1);

    if (!u || !u.nickname || !u.ticketsPublic) throw new NotFoundError();

    const [stats, achievements] = await Promise.all([
      loadProfileStats(app.db, u.id, currency),
      loadAchievements(app.db, u.id),
    ]);

    const profile: CommunityProfile = {
      nickname: u.nickname,
      bio: u.bio,
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
  // — non-public users 404. Default currency is USDT to match the
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
          settledAt: communityTickets.settledAt,
        })
        .from(communityTickets)
        .innerJoin(users, eq(users.id, communityTickets.userId))
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

  // ─── Self view ───────────────────────────────────────────────────────────

  app.get("/community/me", async (request): Promise<CommunityMe> => {
    const u = request.requireAuth();
    const [me] = await app.db
      .select({
        ticketsPublic: users.ticketsPublic,
        nickname: users.nickname,
        bio: users.bio,
      })
      .from(users)
      .where(eq(users.id, u.id))
      .limit(1);
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
        .returning({
          ticketsPublic: users.ticketsPublic,
          nickname: users.nickname,
          bio: users.bio,
        });
      if (!updated) throw new NotFoundError();
      return updated;
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
          .returning({
            ticketsPublic: users.ticketsPublic,
            nickname: users.nickname,
            bio: users.bio,
          });
        if (!updated) throw new NotFoundError();
        return updated;
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
  settledAt: Date;
}

function toFeedSummary(r: FeedRow): CommunityTicketSummary {
  // The where-clause on every endpoint already filters out null
  // nicknames — this assertion documents the invariant for type
  // narrowing. If the constraint ever loosens, the runtime guard below
  // surfaces it as a 500 rather than a silent stringified `null`.
  if (r.nickname === null) {
    throw new Error("toFeedSummary: nickname unexpectedly null");
  }
  return {
    ticketId: r.ticketId,
    nickname: r.nickname,
    bio: r.bio,
    // CHAR(4) columns come back space-padded from postgres ("OZ  ").
    // Trim at the API boundary, matching the wallet + bets convention.
    currency: r.currency.trim() as Currency,
    status: r.status as CommunityTicketSummary["status"],
    betType: r.betType as CommunityTicketSummary["betType"],
    stakeMicro: r.stakeMicro.toString(),
    payoutMicro: r.payoutMicro.toString(),
    totalOdds: r.totalOdds,
    numLegs: r.numLegs,
    sportIds: r.sportIds,
    settledAt: r.settledAt.toISOString(),
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

function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code: unknown }).code === "23505"
  );
}
