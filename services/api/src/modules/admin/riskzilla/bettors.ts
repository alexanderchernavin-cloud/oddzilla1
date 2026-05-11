// /admin/riskzilla/bettors — list bettors with risk-relevant stats and
// edit per-bettor risk_score (RS).

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { eq, sql } from "drizzle-orm";
import { users, adminAuditLog } from "@oddzilla/db";
import { BadRequestError, NotFoundError } from "../../../lib/errors.js";

const listQuery = z.object({
  q: z.string().min(1).max(200).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
  // Sort knobs — most-risky first by default. The dashboard surfaces
  // negative-PnL whales here.
  sort: z.enum(["risk_score", "pnl", "stake", "win_rate", "recent"]).default("recent"),
  // Stats aggregation currency. USDC = real-money view; OZ = demo view.
  currency: z
    .string()
    .min(3)
    .max(4)
    .transform((s) => s.toUpperCase())
    .default("USDC"),
});

const profileQuery = z.object({
  currency: z
    .string()
    .min(3)
    .max(4)
    .transform((s) => s.toUpperCase())
    .default("USDC"),
});

interface BettorRow {
  id: string;
  email: string;
  nickname: string | null;
  status: string;
  riskScore: string;
  ticketsCount: number;
  wonCount: number;
  pnlMicro: string;
  stakedMicro: string;
  payoutMicro: string;
  winRate: number;
  lastBetAt: string | null;
}

export default async function riskzillaBettorsRoutes(app: FastifyInstance) {
  app.get("/admin/riskzilla/bettors", async (request) => {
    request.requireRole("admin");
    const q = listQuery.parse(request.query);

    // PnL is operator POV: stake collected − payout. Aggregated from
    // wallet_ledger (USDC only) so the math matches the existing
    // /admin/stats dashboard. Excludes is_ai seed bettors per the
    // existing PnL convention.
    const orderClause = (() => {
      switch (q.sort) {
        case "risk_score":
          return sql`u.risk_score DESC, COALESCE(stats.pnl_micro, 0) DESC`;
        case "pnl":
          return sql`COALESCE(stats.pnl_micro, 0) ASC`; // most negative (operator loses) first
        case "stake":
          return sql`COALESCE(stats.staked_micro, 0) DESC`;
        case "win_rate":
          return sql`(CASE WHEN COALESCE(stats.tickets_count, 0) > 0
                           THEN stats.won_count::float / stats.tickets_count
                           ELSE 0 END) DESC`;
        case "recent":
        default:
          return sql`COALESCE(stats.last_bet_at, u.created_at) DESC`;
      }
    })();

    const search = q.q ? `%${q.q.replace(/[%_]/g, "")}%` : null;

    const rows = (await app.db.execute(sql`
      WITH stats AS (
        SELECT
          t.user_id                                               AS user_id,
          COUNT(*)::int                                           AS tickets_count,
          COUNT(*) FILTER (
            WHERE t.status = 'settled'
              AND t.actual_payout_micro > t.stake_micro
          )::int                                                  AS won_count,
          COALESCE(SUM(
            CASE WHEN t.status = 'settled'
                   THEN t.stake_micro - COALESCE(t.actual_payout_micro, 0)
                 ELSE 0 END
          ), 0)::bigint::text                                     AS pnl_micro,
          COALESCE(SUM(t.stake_micro), 0)::bigint::text           AS staked_micro,
          COALESCE(SUM(COALESCE(t.actual_payout_micro, 0)), 0)::bigint::text
                                                                  AS payout_micro,
          MAX(t.placed_at)                                        AS last_bet_at
        FROM tickets t
        WHERE t.currency = ${q.currency}
        GROUP BY t.user_id
      )
      SELECT
        u.id::text                                                AS id,
        u.email                                                   AS email,
        u.nickname                                                AS nickname,
        u.status::text                                            AS status,
        u.risk_score::text                                        AS risk_score,
        COALESCE(stats.tickets_count, 0)                          AS tickets_count,
        COALESCE(stats.won_count, 0)                              AS won_count,
        COALESCE(stats.pnl_micro, '0')                            AS pnl_micro,
        COALESCE(stats.staked_micro, '0')                         AS staked_micro,
        COALESCE(stats.payout_micro, '0')                         AS payout_micro,
        stats.last_bet_at                                         AS last_bet_at
        FROM users u
        LEFT JOIN stats ON stats.user_id = u.id
       WHERE u.role = 'user'
         AND u.is_ai = false
         ${search ? sql`AND (u.email ILIKE ${search} OR u.nickname ILIKE ${search})` : sql``}
       ORDER BY ${orderClause}
       LIMIT ${q.limit}
       OFFSET ${q.offset}
    `)) as unknown as Array<{
      id: string;
      email: string;
      nickname: string | null;
      status: string;
      risk_score: string;
      tickets_count: number;
      won_count: number;
      pnl_micro: string;
      staked_micro: string;
      payout_micro: string;
      last_bet_at: Date | string | null;
    }>;

    const entries: BettorRow[] = rows.map((r) => ({
      id: r.id,
      email: r.email,
      nickname: r.nickname,
      status: r.status,
      riskScore: r.risk_score,
      ticketsCount: Number(r.tickets_count),
      wonCount: Number(r.won_count),
      pnlMicro: r.pnl_micro,
      stakedMicro: r.staked_micro,
      payoutMicro: r.payout_micro,
      winRate:
        Number(r.tickets_count) > 0
          ? Number(r.won_count) / Number(r.tickets_count)
          : 0,
      lastBetAt:
        r.last_bet_at == null
          ? null
          : r.last_bet_at instanceof Date
            ? r.last_bet_at.toISOString()
            : String(r.last_bet_at),
    }));

    return { entries };
  });

  // Single-bettor profile with the same stats + RS-history breadcrumb.
  app.get("/admin/riskzilla/bettors/:id", async (request) => {
    request.requireRole("admin");
    const params = z.object({ id: z.string().uuid() }).parse(request.params);
    const currency = profileQuery.parse(request.query).currency;

    const [u] = await app.db
      .select({
        id: users.id,
        email: users.email,
        nickname: users.nickname,
        status: users.status,
        riskScore: users.riskScore,
        createdAt: users.createdAt,
        lastLoginAt: users.lastLoginAt,
      })
      .from(users)
      .where(eq(users.id, params.id))
      .limit(1);
    if (!u) throw new NotFoundError("user_not_found", "user_not_found");

    // Wallets — both currencies. The page surfaces USDC prominently
    // (real money) and OZ as a secondary chip.
    const walletRows = (await app.db.execute(sql`
      SELECT currency, balance_micro::text AS balance_micro,
             locked_micro::text AS locked_micro
        FROM wallets
       WHERE user_id = ${params.id}::uuid
       ORDER BY currency
    `)) as unknown as Array<{
      currency: string;
      balance_micro: string;
      locked_micro: string;
    }>;

    // Top-level USDC stats. PnL is operator POV: stake collected −
    // payout paid out. Refunds are netted out (they don't move the
    // bank but they do move the user's balance back).
    const stats = (await app.db.execute(sql`
      SELECT
        COUNT(*)::int                                            AS tickets_count,
        COUNT(*) FILTER (WHERE t.status = 'settled' AND t.actual_payout_micro > t.stake_micro)::int
                                                                 AS won_count,
        COUNT(*) FILTER (WHERE t.status = 'settled' AND COALESCE(t.actual_payout_micro, 0) = 0)::int
                                                                 AS lost_count,
        COUNT(*) FILTER (WHERE t.status IN ('accepted', 'pending_delay'))::int
                                                                 AS open_count,
        COALESCE(SUM(t.stake_micro), 0)::bigint::text            AS staked_micro,
        COALESCE(SUM(COALESCE(t.actual_payout_micro, 0)), 0)::bigint::text
                                                                 AS payout_micro,
        COALESCE(SUM(
          CASE WHEN t.status IN ('accepted', 'pending_delay')
                 THEN t.potential_payout_micro - t.stake_micro
               ELSE 0 END
        ), 0)::bigint::text                                      AS open_max_loss_micro,
        COALESCE(SUM(
          CASE WHEN t.status IN ('accepted', 'pending_delay')
                 THEN t.potential_payout_micro
               ELSE 0 END
        ), 0)::bigint::text                                      AS open_potential_payout_micro,
        MAX(t.placed_at)                                         AS last_bet_at
      FROM tickets t
      WHERE t.user_id = ${params.id}::uuid AND t.currency = ${currency}
    `)) as unknown as Array<{
      tickets_count: number;
      won_count: number;
      lost_count: number;
      open_count: number;
      staked_micro: string;
      payout_micro: string;
      open_max_loss_micro: string;
      open_potential_payout_micro: string;
      last_bet_at: Date | string | null;
    }>;

    // Live vs prematch split. A leg is "live at placement" when
    // tickets.placed_at >= matches.scheduled_at (match had started).
    // A combo is classified as "live" if ANY leg was live at placement
    // — same convention sportsbook UIs use ("contains in-play"). We
    // join via a CTE so each ticket is counted once.
    const phaseRows = (await app.db.execute(sql`
      WITH ticket_classification AS (
        SELECT
          t.id          AS ticket_id,
          t.status      AS status,
          t.stake_micro AS stake_micro,
          COALESCE(t.actual_payout_micro, 0) AS payout_micro,
          t.potential_payout_micro AS potential_payout_micro,
          BOOL_OR(m.scheduled_at IS NOT NULL AND t.placed_at >= m.scheduled_at)
                       AS is_live
          FROM tickets t
          JOIN ticket_selections ts ON ts.ticket_id = t.id
          JOIN markets mk            ON mk.id = ts.market_id
          JOIN matches m             ON m.id = mk.match_id
         WHERE t.user_id = ${params.id}::uuid AND t.currency = ${currency}
         GROUP BY t.id
      )
      SELECT
        CASE WHEN is_live THEN 'live' ELSE 'prematch' END AS phase,
        COUNT(*)::int                                                       AS tickets_count,
        COALESCE(SUM(stake_micro), 0)::bigint::text                         AS staked_micro,
        COALESCE(SUM(payout_micro), 0)::bigint::text                        AS payout_micro,
        COUNT(*) FILTER (WHERE status = 'settled' AND payout_micro > stake_micro)::int
                                                                            AS won_count
      FROM ticket_classification
      GROUP BY phase
    `)) as unknown as Array<{
      phase: "live" | "prematch";
      tickets_count: number;
      staked_micro: string;
      payout_micro: string;
      won_count: number;
    }>;

    // PnL by sport. Combo legs are pro-rated by leg count (same
    // convention /admin/stats/pnl-by-day uses) so a 3-leg combo
    // touching 2 sports doesn't double-count its stake.
    const sportRows = (await app.db.execute(sql`
      WITH ticket_sport_weights AS (
        SELECT
          t.id         AS ticket_id,
          t.status     AS status,
          t.stake_micro AS stake_micro,
          COALESCE(t.actual_payout_micro, 0) AS payout_micro,
          s.id         AS sport_id,
          s.slug       AS sport_slug,
          s.name       AS sport_name,
          COUNT(*)::numeric / SUM(COUNT(*)) OVER (PARTITION BY t.id) AS weight
          FROM tickets t
          JOIN ticket_selections ts ON ts.ticket_id = t.id
          JOIN markets mk            ON mk.id = ts.market_id
          JOIN matches m             ON m.id = mk.match_id
          JOIN tournaments tn        ON tn.id = m.tournament_id
          JOIN categories c          ON c.id = tn.category_id
          JOIN sports s              ON s.id = c.sport_id
         WHERE t.user_id = ${params.id}::uuid AND t.currency = ${currency}
         GROUP BY t.id, s.id, s.slug, s.name
      )
      SELECT
        sport_slug,
        sport_name,
        COUNT(DISTINCT ticket_id)::int                                                  AS ticket_count,
        COALESCE(ROUND(SUM(stake_micro * weight)), 0)::bigint::text                     AS staked_micro,
        COALESCE(ROUND(SUM(payout_micro * weight)), 0)::bigint::text                    AS payout_micro,
        COUNT(*) FILTER (WHERE status = 'settled' AND payout_micro > stake_micro)::int  AS won_count
      FROM ticket_sport_weights
      GROUP BY sport_slug, sport_name
      ORDER BY SUM(stake_micro * weight) DESC
      LIMIT 20
    `)) as unknown as Array<{
      sport_slug: string;
      sport_name: string;
      ticket_count: number;
      staked_micro: string;
      payout_micro: string;
      won_count: number;
    }>;

    // Top-5 by stake size (regardless of outcome).
    const biggestStakes = (await app.db.execute(sql`
      SELECT
        t.id::text                                AS ticket_id,
        t.status::text                            AS status,
        t.bet_type::text                          AS bet_type,
        t.stake_micro::text                       AS stake_micro,
        t.potential_payout_micro::text            AS potential_payout_micro,
        COALESCE(t.actual_payout_micro, 0)::text  AS actual_payout_micro,
        t.placed_at                               AS placed_at,
        t.settled_at                              AS settled_at
      FROM tickets t
      WHERE t.user_id = ${params.id}::uuid AND t.currency = ${currency}
      ORDER BY t.stake_micro DESC
      LIMIT 5
    `)) as unknown as Array<{
      ticket_id: string;
      status: string;
      bet_type: string;
      stake_micro: string;
      potential_payout_micro: string;
      actual_payout_micro: string;
      placed_at: Date | string;
      settled_at: Date | string | null;
    }>;

    // Top-5 by win size (settled tickets where payout > stake), ranked
    // by the bettor's net profit on that ticket.
    const biggestWins = (await app.db.execute(sql`
      SELECT
        t.id::text                                AS ticket_id,
        t.bet_type::text                          AS bet_type,
        t.stake_micro::text                       AS stake_micro,
        t.actual_payout_micro::text               AS actual_payout_micro,
        (t.actual_payout_micro - t.stake_micro)::text AS net_micro,
        t.settled_at                              AS settled_at
      FROM tickets t
      WHERE t.user_id = ${params.id}::uuid
        AND t.currency = 'USDC'
        AND t.status = 'settled'
        AND t.actual_payout_micro IS NOT NULL
        AND t.actual_payout_micro > t.stake_micro
      ORDER BY (t.actual_payout_micro - t.stake_micro) DESC
      LIMIT 5
    `)) as unknown as Array<{
      ticket_id: string;
      bet_type: string;
      stake_micro: string;
      actual_payout_micro: string;
      net_micro: string;
      settled_at: Date | string | null;
    }>;

    // Recent decisions involving this user. Powers the bettor profile
    // page's "Recent risk decisions" panel — useful when investigating
    // why a sharp gets cold-rejected.
    const decisions = (await app.db.execute(sql`
      SELECT id::text, decision::text, reason_message, stake_micro::text,
             potential_payout_micro::text, created_at
        FROM riskzilla_event_log
       WHERE user_id = ${params.id}::uuid
       ORDER BY created_at DESC
       LIMIT 25
    `)) as unknown as Array<{
      id: string;
      decision: string;
      reason_message: string | null;
      stake_micro: string;
      potential_payout_micro: string;
      created_at: Date | string;
    }>;

    const s = stats[0];
    const stakedMicro = BigInt(s?.staked_micro ?? "0");
    const payoutMicro = BigInt(s?.payout_micro ?? "0");
    const operatorPnlMicro = stakedMicro - payoutMicro;

    const phaseByName = new Map(phaseRows.map((r) => [r.phase, r]));
    const phaseEntry = (name: "live" | "prematch") => {
      const r = phaseByName.get(name);
      const stake = BigInt(r?.staked_micro ?? "0");
      const payout = BigInt(r?.payout_micro ?? "0");
      return {
        ticketsCount: Number(r?.tickets_count ?? 0),
        wonCount: Number(r?.won_count ?? 0),
        stakedMicro: stake.toString(),
        payoutMicro: payout.toString(),
        operatorPnlMicro: (stake - payout).toString(),
      };
    };

    return {
      currency,
      id: u.id,
      email: u.email,
      nickname: u.nickname,
      status: u.status,
      riskScore: u.riskScore,
      createdAt: u.createdAt.toISOString(),
      lastLoginAt: u.lastLoginAt?.toISOString() ?? null,
      wallets: walletRows.map((w) => ({
        currency: w.currency.trim(),
        balanceMicro: w.balance_micro,
        lockedMicro: w.locked_micro,
      })),
      stats: {
        ticketsCount: Number(s?.tickets_count ?? 0),
        wonCount: Number(s?.won_count ?? 0),
        lostCount: Number(s?.lost_count ?? 0),
        openCount: Number(s?.open_count ?? 0),
        stakedMicro: stakedMicro.toString(),
        payoutMicro: payoutMicro.toString(),
        operatorPnlMicro: operatorPnlMicro.toString(),
        openMaxLossMicro: s?.open_max_loss_micro ?? "0",
        openPotentialPayoutMicro: s?.open_potential_payout_micro ?? "0",
        winRate:
          Number(s?.tickets_count ?? 0) > 0
            ? Number(s?.won_count ?? 0) / Number(s?.tickets_count ?? 0)
            : 0,
        lastBetAt:
          s?.last_bet_at == null
            ? null
            : s?.last_bet_at instanceof Date
              ? s.last_bet_at.toISOString()
              : String(s.last_bet_at),
      },
      pnlByPhase: {
        live: phaseEntry("live"),
        prematch: phaseEntry("prematch"),
      },
      pnlBySport: sportRows.map((r) => {
        const stake = BigInt(r.staked_micro);
        const payout = BigInt(r.payout_micro);
        return {
          sportSlug: r.sport_slug,
          sportName: r.sport_name,
          ticketCount: Number(r.ticket_count),
          wonCount: Number(r.won_count),
          stakedMicro: stake.toString(),
          payoutMicro: payout.toString(),
          operatorPnlMicro: (stake - payout).toString(),
        };
      }),
      biggestStakes: biggestStakes.map((r) => ({
        ticketId: r.ticket_id,
        status: r.status,
        betType: r.bet_type,
        stakeMicro: r.stake_micro,
        potentialPayoutMicro: r.potential_payout_micro,
        actualPayoutMicro: r.actual_payout_micro,
        placedAt:
          r.placed_at instanceof Date
            ? r.placed_at.toISOString()
            : String(r.placed_at),
        settledAt:
          r.settled_at == null
            ? null
            : r.settled_at instanceof Date
              ? r.settled_at.toISOString()
              : String(r.settled_at),
      })),
      biggestWins: biggestWins.map((r) => ({
        ticketId: r.ticket_id,
        betType: r.bet_type,
        stakeMicro: r.stake_micro,
        payoutMicro: r.actual_payout_micro,
        netMicro: r.net_micro,
        settledAt:
          r.settled_at == null
            ? null
            : r.settled_at instanceof Date
              ? r.settled_at.toISOString()
              : String(r.settled_at),
      })),
      decisions: decisions.map((d) => ({
        id: d.id,
        decision: d.decision,
        reasonMessage: d.reason_message,
        stakeMicro: d.stake_micro,
        potentialPayoutMicro: d.potential_payout_micro,
        createdAt:
          d.created_at instanceof Date
            ? d.created_at.toISOString()
            : String(d.created_at),
      })),
    };
  });

  app.patch("/admin/riskzilla/bettors/:id/risk-score", async (request) => {
    const admin = request.requireRole("admin");
    const params = z.object({ id: z.string().uuid() }).parse(request.params);
    const body = z
      .object({
        riskScore: z.string().regex(/^\d+(?:\.\d{1,3})?$/),
      })
      .parse(request.body);

    const rs = Number(body.riskScore);
    if (!(rs >= 0.01 && rs <= 10)) {
      throw new BadRequestError("risk_score_out_of_range", "risk_score_out_of_range");
    }
    if (admin.id === params.id) {
      // Mirrors the admin-self-edit guard on /admin/users — preventing
      // the operator from quietly tuning their own knobs.
      throw new BadRequestError("cannot_edit_self", "cannot_edit_self");
    }

    const [before] = await app.db
      .select()
      .from(users)
      .where(eq(users.id, params.id))
      .limit(1);
    if (!before) throw new NotFoundError("user_not_found", "user_not_found");

    const result = await app.db.transaction(async (tx) => {
      const [updated] = await tx
        .update(users)
        .set({ riskScore: rs.toFixed(3), updatedAt: new Date() })
        .where(eq(users.id, params.id))
        .returning();
      if (!updated) throw new Error("users update returned no row");
      await tx.insert(adminAuditLog).values({
        actorUserId: admin.id,
        action: "riskzilla.bettor.risk_score_update",
        targetType: "user",
        targetId: params.id,
        beforeJson: { riskScore: before.riskScore },
        afterJson: { riskScore: updated.riskScore },
        ipInet: request.ip ?? null,
      });
      return updated;
    });

    return { id: result.id, riskScore: result.riskScore };
  });
}
