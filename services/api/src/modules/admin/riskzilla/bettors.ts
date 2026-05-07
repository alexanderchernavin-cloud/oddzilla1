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
        WHERE t.currency = 'USDC'
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

    const stats = (await app.db.execute(sql`
      SELECT
        COUNT(*)::int                                            AS tickets_count,
        COUNT(*) FILTER (WHERE t.status = 'settled' AND t.actual_payout_micro > t.stake_micro)::int
                                                                 AS won_count,
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
        MAX(t.placed_at)                                         AS last_bet_at
      FROM tickets t
      WHERE t.user_id = ${params.id}::uuid AND t.currency = 'USDC'
    `)) as unknown as Array<{
      tickets_count: number;
      won_count: number;
      open_count: number;
      staked_micro: string;
      payout_micro: string;
      open_max_loss_micro: string;
      last_bet_at: Date | string | null;
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
    return {
      id: u.id,
      email: u.email,
      nickname: u.nickname,
      status: u.status,
      riskScore: u.riskScore,
      createdAt: u.createdAt.toISOString(),
      lastLoginAt: u.lastLoginAt?.toISOString() ?? null,
      stats: {
        ticketsCount: Number(s?.tickets_count ?? 0),
        wonCount: Number(s?.won_count ?? 0),
        openCount: Number(s?.open_count ?? 0),
        stakedMicro: s?.staked_micro ?? "0",
        payoutMicro: s?.payout_micro ?? "0",
        openMaxLossMicro: s?.open_max_loss_micro ?? "0",
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
