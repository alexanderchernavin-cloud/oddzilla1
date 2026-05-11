// /admin/riskzilla/events — paged feed over riskzilla_event_log.
// Powers two distinct admin pages:
//
//   - Betticker (`/admin/riskzilla/betticker`) — newest-first stream
//     with filter pills (decision, sport, currency, user). The page
//     polls every 3s and merges new rows into the existing list.
//
//   - Bet history (`/admin/riskzilla/bets`) — same data with paging,
//     date-range filter, and CSV export.
//
// One endpoint serves both — the page chooses limit + filters.

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { sql } from "drizzle-orm";
import { SUPPORTED_CURRENCIES } from "@oddzilla/types/currencies";

// Case-insensitive zod enum that matches one of the supported wallet
// currencies. Length-based min/max validators would reject "OZ"
// (2 chars), so we match by membership instead.
const currencySchema = z
  .string()
  .transform((s) => s.toUpperCase())
  .pipe(z.enum(SUPPORTED_CURRENCIES));

const listQuery = z.object({
  limit: z.coerce.number().int().min(1).max(500).default(100),
  // Pagination: cursor on (created_at, id) to be stable under inserts.
  // Frontend passes back the last-row's `cursor` field as `before`.
  before: z
    .string()
    .regex(/^\d+_\d+$/)
    .optional(),
  decision: z
    .enum([
      "accepted",
      "rejected_min_stake",
      "rejected_max_payout",
      "rejected_match_liability",
      "rejected_bet_factor",
      "rejected_bank_limit",
      "rejected_user_blocked",
      "rejected_market_factor",
    ])
    .optional(),
  // accepted | rejected | all  — convenience pill on the betticker UI
  status: z.enum(["accepted", "rejected", "all"]).optional(),
  userId: z.string().uuid().optional(),
  sportId: z.coerce.number().int().optional(),
  matchId: z.coerce.bigint().optional(),
  riskTier: z.coerce.number().int().min(0).max(32).optional(),
  // Currency filter — case-insensitive, must match one of the
  // supported wallet currencies (USDC | OZ). Preflighting at the
  // schema layer keeps a typo from running a silent full-table scan.
  currency: currencySchema.optional(),
  fromTs: z.coerce.date().optional(),
  toTs: z.coerce.date().optional(),
  // Stake range — both fields are bigint-shaped strings of micros so
  // we don't lose precision on large payouts. Either bound is
  // independently optional; passing only one acts as a half-open range.
  minStakeMicro: z.string().regex(/^\d+$/).optional(),
  maxStakeMicro: z.string().regex(/^\d+$/).optional(),
});

interface EventRowDto {
  id: string;
  cursor: string;
  ticketId: string | null;
  userId: string;
  userEmail: string | null;
  userNickname: string | null;
  decision: string;
  reasonMessage: string | null;
  currency: string;
  stakeMicro: string;
  potentialPayoutMicro: string;
  matchId: string | null;
  matchLabel: string | null;
  sportId: number | null;
  sportSlug: string | null;
  tournamentId: number | null;
  tournamentName: string | null;
  riskTier: number | null;
  rsAtDecision: string;
  bankAtDecisionMicro: string;
  decisionMeta: unknown;
  createdAt: string;
}

export default async function riskzillaEventsRoutes(app: FastifyInstance) {
  app.get("/admin/riskzilla/events", async (request) => {
    request.requireRole("admin");
    const q = listQuery.parse(request.query);

    // Build dynamic WHERE clause. Drizzle's sql template with
    // conditional appends keeps this readable without a query builder.
    const conditions: ReturnType<typeof sql>[] = [];
    if (q.decision) conditions.push(sql`el.decision = ${q.decision}::riskzilla_decision`);
    if (q.status === "accepted") conditions.push(sql`el.decision = 'accepted'::riskzilla_decision`);
    if (q.status === "rejected") conditions.push(sql`el.decision <> 'accepted'::riskzilla_decision`);
    if (q.userId) conditions.push(sql`el.user_id = ${q.userId}::uuid`);
    if (q.sportId !== undefined) conditions.push(sql`el.sport_id = ${q.sportId}`);
    if (q.matchId !== undefined) conditions.push(sql`el.match_id = ${q.matchId.toString()}::bigint`);
    if (q.riskTier !== undefined) conditions.push(sql`el.risk_tier = ${q.riskTier}`);
    if (q.currency) conditions.push(sql`el.currency = ${q.currency}`);
    if (q.fromTs) conditions.push(sql`el.created_at >= ${q.fromTs.toISOString()}::timestamptz`);
    if (q.toTs) conditions.push(sql`el.created_at <= ${q.toTs.toISOString()}::timestamptz`);
    if (q.minStakeMicro) conditions.push(sql`el.stake_micro >= ${q.minStakeMicro}::bigint`);
    if (q.maxStakeMicro) conditions.push(sql`el.stake_micro <= ${q.maxStakeMicro}::bigint`);
    if (q.before) {
      const [tsMs, idStr] = q.before.split("_");
      const ts = new Date(Number(tsMs)).toISOString();
      const id = idStr;
      conditions.push(
        sql`(el.created_at, el.id) < (${ts}::timestamptz, ${id}::bigint)`,
      );
    }

    const where =
      conditions.length === 0
        ? sql``
        : sql`WHERE ${conditions.reduce((acc, c, i) =>
            i === 0 ? c : sql`${acc} AND ${c}`,
          )}`;

    const rows = (await app.db.execute(sql`
      SELECT
        el.id::text                                   AS id,
        EXTRACT(epoch FROM el.created_at) * 1000      AS cursor_ms,
        el.ticket_id::text                            AS ticket_id,
        el.user_id::text                              AS user_id,
        u.email                                       AS user_email,
        u.nickname                                    AS user_nickname,
        el.decision::text                             AS decision,
        el.reason_message                             AS reason_message,
        el.currency                                   AS currency,
        el.stake_micro::text                          AS stake_micro,
        el.potential_payout_micro::text               AS potential_payout_micro,
        el.match_id::text                             AS match_id,
        CASE WHEN m.id IS NOT NULL
             THEN m.home_team || ' vs ' || m.away_team
             ELSE NULL END                            AS match_label,
        el.sport_id                                   AS sport_id,
        s.slug                                        AS sport_slug,
        el.tournament_id                              AS tournament_id,
        tn.name                                       AS tournament_name,
        el.risk_tier                                  AS risk_tier,
        el.rs_at_decision::text                       AS rs_at_decision,
        el.bank_at_decision_micro::text               AS bank_at_decision_micro,
        el.decision_meta                              AS decision_meta,
        el.created_at                                 AS created_at
      FROM riskzilla_event_log el
      LEFT JOIN users       u  ON u.id = el.user_id
      LEFT JOIN matches     m  ON m.id = el.match_id
      LEFT JOIN sports      s  ON s.id = el.sport_id
      LEFT JOIN tournaments tn ON tn.id = el.tournament_id
      ${where}
      ORDER BY el.created_at DESC, el.id DESC
      LIMIT ${q.limit}
    `)) as unknown as Array<{
      id: string;
      cursor_ms: string | number;
      ticket_id: string | null;
      user_id: string;
      user_email: string | null;
      user_nickname: string | null;
      decision: string;
      reason_message: string | null;
      currency: string;
      stake_micro: string;
      potential_payout_micro: string;
      match_id: string | null;
      match_label: string | null;
      sport_id: number | null;
      sport_slug: string | null;
      tournament_id: number | null;
      tournament_name: string | null;
      risk_tier: number | null;
      rs_at_decision: string;
      bank_at_decision_micro: string;
      decision_meta: unknown;
      created_at: Date | string;
    }>;

    const entries: EventRowDto[] = rows.map((r) => {
      const cursorMs = Math.floor(Number(r.cursor_ms));
      return {
        id: r.id,
        cursor: `${cursorMs}_${r.id}`,
        ticketId: r.ticket_id,
        userId: r.user_id,
        userEmail: r.user_email,
        userNickname: r.user_nickname,
        decision: r.decision,
        reasonMessage: r.reason_message,
        currency: r.currency.trim(),
        stakeMicro: r.stake_micro,
        potentialPayoutMicro: r.potential_payout_micro,
        matchId: r.match_id,
        matchLabel: r.match_label,
        sportId: r.sport_id,
        sportSlug: r.sport_slug,
        tournamentId: r.tournament_id,
        tournamentName: r.tournament_name,
        riskTier: r.risk_tier,
        rsAtDecision: r.rs_at_decision,
        bankAtDecisionMicro: r.bank_at_decision_micro,
        decisionMeta: r.decision_meta,
        createdAt:
          r.created_at instanceof Date
            ? r.created_at.toISOString()
            : String(r.created_at),
      };
    });

    return { entries };
  });
}
