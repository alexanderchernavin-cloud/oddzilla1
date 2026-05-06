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
import { and, eq, sql, desc } from "drizzle-orm";
import { users, communityTickets } from "@oddzilla/db";
import type {
  CommunityProfile,
  CommunityMe,
  CommunityVisibilityRequest,
  CommunityProfileRequest,
  CommunityFeedResponse,
  CommunityUserTicketsResponse,
  CommunityTicketSummary,
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

// Mirrors the DB-side CHECK constraint from migration 0024.
const NICKNAME_RE = /^[A-Za-z0-9_]{3,20}$/;

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
// "all sports" when sport is omitted.
const feedQuery = z.object({
  currency: z.string().optional(),
  sport: z.coerce.number().int().positive().optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(50).default(20),
});

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
  app.get("/community/feed", async (request): Promise<CommunityFeedResponse> => {
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
      .orderBy(desc(communityTickets.settledAt))
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
  }>("/community/users/:nickname/profile", async (request) => {
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

    const stats = await loadProfileStats(app.db, u.id, currency);

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
        badgeCount: 0, // Phase 10.4
      },
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
    currency: r.currency as Currency,
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

function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code: unknown }).code === "23505"
  );
}
