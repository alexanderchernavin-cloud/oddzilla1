// /admin/riskzilla/dashboard — KPI cards + headline metrics for the
// RiskZilla landing page. Read-only.

import type { FastifyInstance } from "fastify";
import { sql } from "drizzle-orm";

interface DashboardKpis {
  bankLimitMicro: string;
  openLiabilityMicro: string;
  // Sum of every USDC wallet's balance (including locked stakes —
  // bettors can withdraw their balance on demand once a bet settles or
  // they cancel). Subtracted from bank_limit when computing free
  // capacity so the operator's risk capital is never overstated.
  userBalancesMicro: string;
  freeCapacityMicro: string;
  bankUtilization: number;
  openTicketsCount: number;
  openMaxLossMicro: string;
  todayBankDeltaMicro: string;
  rejections24h: {
    total: number;
    byDecision: Record<string, number>;
  };
  topRiskMatches: Array<{
    matchId: string;
    label: string;
    sportSlug: string | null;
    openTicketsCount: number;
    openMaxLossMicro: string;
  }>;
  bettorRsHistogram: Array<{ bucket: string; count: number }>;
}

export default async function riskzillaDashboardRoutes(app: FastifyInstance) {
  app.get("/admin/riskzilla/dashboard", async (request) => {
    request.requireRole("admin");

    const bankRows = (await app.db.execute(sql`
      SELECT bank_limit_micro::text AS bank_limit_micro,
             open_liability_micro::text AS open_liability_micro
        FROM riskzilla_bank_state
       WHERE id = 'default'
       LIMIT 1
    `)) as unknown as Array<{ bank_limit_micro: string; open_liability_micro: string }>;
    const bankLimit = BigInt(bankRows[0]?.bank_limit_micro ?? "0");
    const openLiability = BigInt(bankRows[0]?.open_liability_micro ?? "0");

    const userBalanceRows = (await app.db.execute(sql`
      SELECT COALESCE(SUM(balance_micro), 0)::text AS total
        FROM wallets
       WHERE currency = 'USDC'
    `)) as unknown as Array<{ total: string }>;
    const userBalances = BigInt(userBalanceRows[0]?.total ?? "0");
    const freeCapacity = bankLimit - userBalances - openLiability;

    const openTicketRows = (await app.db.execute(sql`
      SELECT COUNT(*)::int AS n,
             COALESCE(SUM(potential_payout_micro - stake_micro), 0)::text
                                     AS open_max_loss_micro
        FROM tickets
       WHERE status IN ('accepted', 'pending_delay')
         AND currency = 'USDC'
    `)) as unknown as Array<{ n: number; open_max_loss_micro: string }>;

    const todayBankRows = (await app.db.execute(sql`
      SELECT COALESCE(SUM(delta_micro), 0)::text AS delta_micro
        FROM riskzilla_bank_ledger
       WHERE created_at >= date_trunc('day', now() AT TIME ZONE 'UTC')
    `)) as unknown as Array<{ delta_micro: string }>;

    const rejectionsRows = (await app.db.execute(sql`
      SELECT decision::text AS decision, COUNT(*)::int AS n
        FROM riskzilla_event_log
       WHERE created_at >= now() - INTERVAL '24 hours'
         AND decision <> 'accepted'
       GROUP BY decision
    `)) as unknown as Array<{ decision: string; n: number }>;
    const rejectionsTotal = rejectionsRows.reduce(
      (acc, r) => acc + Number(r.n),
      0,
    );
    const rejectionsByDecision: Record<string, number> = {};
    for (const r of rejectionsRows) rejectionsByDecision[r.decision] = Number(r.n);

    // Top-N matches by current open-max-loss exposure.
    const topRiskRows = (await app.db.execute(sql`
      SELECT
        m.id::text                                   AS match_id,
        m.home_team || ' vs ' || m.away_team         AS label,
        s.slug                                       AS sport_slug,
        COUNT(DISTINCT t.id)::int                    AS open_tickets,
        COALESCE(SUM(DISTINCT t.potential_payout_micro - t.stake_micro), 0)::text
                                                     AS open_max_loss_micro
      FROM tickets t
      JOIN ticket_selections ts ON ts.ticket_id = t.id
      JOIN markets mk           ON mk.id = ts.market_id
      JOIN matches m            ON m.id = mk.match_id
      JOIN tournaments tn       ON tn.id = m.tournament_id
      JOIN categories c         ON c.id = tn.category_id
      JOIN sports s             ON s.id = c.sport_id
      WHERE t.status IN ('accepted', 'pending_delay')
        AND t.currency = 'USDC'
      GROUP BY m.id, label, s.slug
      ORDER BY (m.id) ASC
      LIMIT 10
    `)) as unknown as Array<{
      match_id: string;
      label: string;
      sport_slug: string | null;
      open_tickets: number;
      open_max_loss_micro: string;
    }>;
    // Sort by exposure desc client-side (pg ORDER BY on a derived
    // SUM(DISTINCT) was racy with the GROUP BY composition; sort here).
    topRiskRows.sort(
      (a, b) =>
        Number(BigInt(b.open_max_loss_micro) - BigInt(a.open_max_loss_micro)),
    );

    // RS histogram across the full bettor base. Five buckets matching
    // the VIP damper ladder so the dashboard reads like the engine.
    const histogramRows = (await app.db.execute(sql`
      SELECT bucket, COUNT(*)::int AS n
        FROM (
          SELECT CASE
                   WHEN risk_score < 0.5 THEN '0.01–0.49'
                   WHEN risk_score < 1.0 THEN '0.50–0.99'
                   WHEN risk_score = 1.0 THEN '1.00 (default)'
                   WHEN risk_score <= 3 THEN '1.01–3.00'
                   WHEN risk_score <= 7 THEN '3.01–7.00'
                   ELSE '7.01–10.00'
                 END AS bucket
            FROM users
           WHERE role = 'user' AND is_ai = false
        ) bucketed
       GROUP BY bucket
       ORDER BY bucket
    `)) as unknown as Array<{ bucket: string; n: number }>;

    // Utilisation now reflects total committed capital — what we owe
    // bettors right now (their balance) plus what we may owe them
    // (open potential payouts) — relative to the bank limit.
    const committed = userBalances + openLiability;
    const utilization =
      bankLimit > 0n ? Number((committed * 10000n) / bankLimit) / 10000 : 0;

    const result: DashboardKpis = {
      bankLimitMicro: bankLimit.toString(),
      openLiabilityMicro: openLiability.toString(),
      userBalancesMicro: userBalances.toString(),
      freeCapacityMicro: freeCapacity.toString(),
      bankUtilization: utilization,
      openTicketsCount: Number(openTicketRows[0]?.n ?? 0),
      openMaxLossMicro: openTicketRows[0]?.open_max_loss_micro ?? "0",
      todayBankDeltaMicro: todayBankRows[0]?.delta_micro ?? "0",
      rejections24h: {
        total: rejectionsTotal,
        byDecision: rejectionsByDecision,
      },
      topRiskMatches: topRiskRows.slice(0, 10).map((r) => ({
        matchId: r.match_id,
        label: r.label,
        sportSlug: r.sport_slug,
        openTicketsCount: Number(r.open_tickets),
        openMaxLossMicro: r.open_max_loss_micro,
      })),
      bettorRsHistogram: histogramRows.map((r) => ({
        bucket: r.bucket,
        count: Number(r.n),
      })),
    };
    return result;
  });
}
