// /admin/stats endpoints. Read-only KPIs + PnL breakdowns for the admin
// dashboard. No writes here; audit log is unaffected.
//
// Sign convention (operator POV):
//   bet_stake ledger rows have delta_micro < 0 from the user perspective
//     → operator_gross_stake = SUM(-delta_micro) on bet_stake rows
//   bet_payout and bet_refund rows have delta_micro > 0 from the user
//     perspective → operator_payout = SUM(delta_micro) on those rows
//   operator PnL = gross_stake - payout - refund
//
// All amounts serialize as decimal strings to preserve bigint precision.

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { sql } from "drizzle-orm";

const pnlQuery = z.object({
  days: z.coerce.number().int().min(1).max(90).default(14),
});

const bigWinsQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(10),
  days: z.coerce.number().int().min(1).max(90).default(30),
});

interface KpiRow {
  stakeMicro: string;
  payoutMicro: string;
  refundMicro: string;
  openTickets: number;
  activeUsers: number;
}

interface PnlRow {
  day: string;
  sportSlug: string;
  sportName: string;
  stakeMicro: string;
  payoutMicro: string;
  refundMicro: string;
  pnlMicro: string;
  ticketCount: number;
}

interface BigWinRow {
  ticketId: string;
  userId: string;
  userEmail: string;
  stakeMicro: string;
  payoutMicro: string;
  settledAt: string;
  sportSlug: string | null;
  match: string | null;
}

export default async function adminDashboardRoutes(app: FastifyInstance) {
  // Top-line KPI cards for the dashboard header.
  app.get("/admin/stats/kpis", async (request) => {
    request.requireRole("admin");

    const ledgerRows = (await app.db.execute(sql`
      SELECT
        COALESCE(SUM(CASE WHEN type = 'bet_stake'  THEN -delta_micro ELSE 0 END), 0)::text AS stake_micro,
        COALESCE(SUM(CASE WHEN type = 'bet_payout' THEN  delta_micro ELSE 0 END), 0)::text AS payout_micro,
        COALESCE(SUM(CASE WHEN type = 'bet_refund' THEN  delta_micro ELSE 0 END), 0)::text AS refund_micro
      FROM wallet_ledger
      WHERE created_at >= date_trunc('day', now() AT TIME ZONE 'UTC')
    `)) as unknown as Array<{ stake_micro: string; payout_micro: string; refund_micro: string }>;
    const l = ledgerRows[0];

    const openTicketRows = (await app.db.execute(sql`
      SELECT COUNT(*)::int AS n FROM tickets
      WHERE status IN ('accepted', 'pending_delay')
    `)) as unknown as Array<{ n: number }>;
    const activeUserRows = (await app.db.execute(sql`
      SELECT COUNT(DISTINCT user_id)::int AS n FROM tickets
      WHERE placed_at >= now() - INTERVAL '7 days'
    `)) as unknown as Array<{ n: number }>;

    const payload: KpiRow = {
      stakeMicro: l?.stake_micro ?? "0",
      payoutMicro: l?.payout_micro ?? "0",
      refundMicro: l?.refund_micro ?? "0",
      openTickets: Number(openTicketRows[0]?.n ?? 0),
      activeUsers: Number(activeUserRows[0]?.n ?? 0),
    };
    return payload;
  });

  // PnL by day x sport for the dashboard chart/table. One row per
  // (utc_day, sport). Singles-only in this MVP so each ticket has exactly
  // one selection; for combos we'd need to pro-rate across sports.
  app.get("/admin/stats/pnl-by-day", async (request) => {
    request.requireRole("admin");
    const q = pnlQuery.parse(request.query);

    const result = (await app.db.execute(sql`
      SELECT
        to_char(date_trunc('day', wl.created_at AT TIME ZONE 'UTC'), 'YYYY-MM-DD') AS day,
        s.slug AS sport_slug,
        s.name AS sport_name,
        COALESCE(SUM(CASE WHEN wl.type = 'bet_stake'  THEN -wl.delta_micro ELSE 0 END), 0)::text AS stake_micro,
        COALESCE(SUM(CASE WHEN wl.type = 'bet_payout' THEN  wl.delta_micro ELSE 0 END), 0)::text AS payout_micro,
        COALESCE(SUM(CASE WHEN wl.type = 'bet_refund' THEN  wl.delta_micro ELSE 0 END), 0)::text AS refund_micro,
        COUNT(DISTINCT t.id)::int AS ticket_count
      FROM wallet_ledger wl
      JOIN tickets t             ON wl.ref_type = 'ticket' AND wl.ref_id = t.id::text
      JOIN ticket_selections ts  ON ts.ticket_id = t.id
      JOIN markets m             ON m.id = ts.market_id
      JOIN matches ma            ON ma.id = m.match_id
      JOIN tournaments tu        ON tu.id = ma.tournament_id
      JOIN categories c          ON c.id = tu.category_id
      JOIN sports s              ON s.id = c.sport_id
      WHERE wl.created_at >= now() - (${q.days}::int || ' days')::interval
        AND wl.type IN ('bet_stake', 'bet_payout', 'bet_refund')
      GROUP BY day, s.slug, s.name
      ORDER BY day DESC, s.slug
    `)) as unknown as Array<{
      day: string;
      sport_slug: string;
      sport_name: string;
      stake_micro: string;
      payout_micro: string;
      refund_micro: string;
      ticket_count: number;
    }>;

    const rows: PnlRow[] = result.map((r) => {
      const stake = BigInt(r.stake_micro);
      const payout = BigInt(r.payout_micro);
      const refund = BigInt(r.refund_micro);
      return {
        day: r.day,
        sportSlug: r.sport_slug,
        sportName: r.sport_name,
        stakeMicro: stake.toString(),
        payoutMicro: payout.toString(),
        refundMicro: refund.toString(),
        pnlMicro: (stake - payout - refund).toString(),
        ticketCount: Number(r.ticket_count),
      };
    });

    return { rows };
  });

  // Recent large payouts (losing trades from operator POV). Useful for
  // risk review and marketing copy.
  app.get("/admin/stats/big-wins", async (request) => {
    request.requireRole("admin");
    const q = bigWinsQuery.parse(request.query);

    const result = (await app.db.execute(sql`
      SELECT
        t.id::text AS ticket_id,
        t.user_id::text AS user_id,
        u.email AS user_email,
        t.stake_micro::text AS stake_micro,
        t.actual_payout_micro::text AS payout_micro,
        t.settled_at AS settled_at,
        s.slug AS sport_slug,
        ma.home_team || ' vs ' || ma.away_team AS match_label
      FROM tickets t
      JOIN users u              ON u.id = t.user_id
      JOIN ticket_selections ts ON ts.ticket_id = t.id
      JOIN markets m            ON m.id = ts.market_id
      JOIN matches ma           ON ma.id = m.match_id
      JOIN tournaments tu       ON tu.id = ma.tournament_id
      JOIN categories c         ON c.id = tu.category_id
      JOIN sports s             ON s.id = c.sport_id
      WHERE t.status = 'settled'
        AND t.actual_payout_micro IS NOT NULL
        AND t.actual_payout_micro > t.stake_micro
        AND t.settled_at >= now() - (${q.days}::int || ' days')::interval
      ORDER BY t.actual_payout_micro DESC
      LIMIT ${q.limit}
    `)) as unknown as Array<{
      ticket_id: string;
      user_id: string;
      user_email: string;
      stake_micro: string;
      payout_micro: string;
      settled_at: Date | string;
      sport_slug: string | null;
      match_label: string | null;
    }>;

    const rows: BigWinRow[] = result.map((r) => ({
      ticketId: r.ticket_id,
      userId: r.user_id,
      userEmail: r.user_email,
      stakeMicro: r.stake_micro,
      payoutMicro: r.payout_micro,
      settledAt:
        r.settled_at instanceof Date ? r.settled_at.toISOString() : String(r.settled_at),
      sportSlug: r.sport_slug,
      match: r.match_label,
    }));
    return { rows };
  });
}
