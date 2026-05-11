// /admin/riskzilla/events — paged feed powering Betticker + Bets.
//
// Two data sources, branched on currency:
//
//   - USDC: reads `riskzilla_event_log`. The engine writes both
//     accepted + rejected decisions here, with per-bucket meta.
//
//   - OZ:   reads `tickets`. The engine bypasses OZ entirely
//     (`engine.ts` — RISKZILLA_CURRENCY = "USDC"), so event_log is
//     empty for OZ. Sourcing from tickets makes the admin view
//     useful for monitoring demo / perf-test placement volume —
//     decisions are synthetically "accepted" since the rejected
//     code path doesn't create a ticket row.
//
// The two queries return the same EventRowDto shape so the
// betticker + bets clients render either uniformly.

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
  // Pagination cursor `${epochMs}_${id}`. USDC ids are bigint, OZ
  // ids are uuid — both serialise to strings, so the regex stays
  // permissive (digits + dashes/letters after the underscore).
  before: z
    .string()
    .regex(/^\d+_[A-Za-z0-9-]+$/)
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

interface RawRow {
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
}

function rawToDto(r: RawRow): EventRowDto {
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
}

type ListQuery = z.infer<typeof listQuery>;

async function queryEventLog(
  app: FastifyInstance,
  q: ListQuery,
): Promise<EventRowDto[]> {
  const conditions: ReturnType<typeof sql>[] = [];
  if (q.decision) conditions.push(sql`el.decision = ${q.decision}::riskzilla_decision`);
  if (q.status === "accepted") conditions.push(sql`el.decision = 'accepted'::riskzilla_decision`);
  if (q.status === "rejected") conditions.push(sql`el.decision <> 'accepted'::riskzilla_decision`);
  if (q.userId) conditions.push(sql`el.user_id = ${q.userId}::uuid`);
  if (q.sportId !== undefined) conditions.push(sql`el.sport_id = ${q.sportId}`);
  if (q.matchId !== undefined)
    conditions.push(sql`el.match_id = ${q.matchId.toString()}::bigint`);
  if (q.riskTier !== undefined) conditions.push(sql`el.risk_tier = ${q.riskTier}`);
  if (q.currency) conditions.push(sql`el.currency = ${q.currency}`);
  if (q.fromTs) conditions.push(sql`el.created_at >= ${q.fromTs.toISOString()}::timestamptz`);
  if (q.toTs) conditions.push(sql`el.created_at <= ${q.toTs.toISOString()}::timestamptz`);
  if (q.minStakeMicro) conditions.push(sql`el.stake_micro >= ${q.minStakeMicro}::bigint`);
  if (q.maxStakeMicro) conditions.push(sql`el.stake_micro <= ${q.maxStakeMicro}::bigint`);
  if (q.before) {
    const [tsMs, idStr] = q.before.split("_");
    const ts = new Date(Number(tsMs)).toISOString();
    conditions.push(
      sql`(el.created_at, el.id) < (${ts}::timestamptz, ${idStr}::bigint)`,
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
  `)) as unknown as RawRow[];

  return rows.map(rawToDto);
}

// OZ data path: reads `tickets`. Engine writes nothing for OZ, so we
// synthesise a Betticker row from the ticket itself. Filtering for
// rejection statuses returns empty (an OZ ticket cannot be rejected
// — rejection happens before INSERT, and the engine bypass means even
// risk-level rejection doesn't apply).
async function queryTicketsForOz(
  app: FastifyInstance,
  q: ListQuery,
): Promise<EventRowDto[]> {
  // Rejection filters never match — OZ tickets are all accepted.
  if (
    q.status === "rejected" ||
    (q.decision && q.decision !== "accepted")
  ) {
    return [];
  }

  const conditions: ReturnType<typeof sql>[] = [sql`t.currency = 'OZ'`];
  if (q.userId) conditions.push(sql`t.user_id = ${q.userId}::uuid`);
  if (q.fromTs)
    conditions.push(sql`t.placed_at >= ${q.fromTs.toISOString()}::timestamptz`);
  if (q.toTs) conditions.push(sql`t.placed_at <= ${q.toTs.toISOString()}::timestamptz`);
  if (q.minStakeMicro) conditions.push(sql`t.stake_micro >= ${q.minStakeMicro}::bigint`);
  if (q.maxStakeMicro) conditions.push(sql`t.stake_micro <= ${q.maxStakeMicro}::bigint`);
  // sport/match/tier filters operate on the first-leg join — pushed
  // into the outer SELECT (they reference s/tn aliases). Encoding
  // them here so the planner sees them up-front would mean dragging
  // the LATERAL join into every row's predicate; this is clearer.

  if (q.before) {
    const [tsMs, idStr] = q.before.split("_");
    const ts = new Date(Number(tsMs)).toISOString();
    conditions.push(
      sql`(t.placed_at, t.id) < (${ts}::timestamptz, ${idStr}::uuid)`,
    );
  }

  const innerWhere = sql`WHERE ${conditions.reduce((acc, c, i) =>
    i === 0 ? c : sql`${acc} AND ${c}`,
  )}`;

  // Filters that depend on the first-leg's joined tournament / sport
  // / match live in the outer HAVING-style WHERE below. They're
  // applied AFTER the LATERAL pulls the first leg.
  const postJoinConditions: ReturnType<typeof sql>[] = [];
  if (q.sportId !== undefined) postJoinConditions.push(sql`s.id = ${q.sportId}`);
  if (q.matchId !== undefined)
    postJoinConditions.push(sql`m.id = ${q.matchId.toString()}::bigint`);
  if (q.riskTier !== undefined)
    postJoinConditions.push(sql`tn.risk_tier = ${q.riskTier}`);
  const postWhere =
    postJoinConditions.length === 0
      ? sql``
      : sql`WHERE ${postJoinConditions.reduce((acc, c, i) =>
          i === 0 ? c : sql`${acc} AND ${c}`,
        )}`;

  const rows = (await app.db.execute(sql`
    SELECT
      t.id::text                                    AS id,
      EXTRACT(epoch FROM t.placed_at) * 1000        AS cursor_ms,
      t.id::text                                    AS ticket_id,
      t.user_id::text                               AS user_id,
      u.email                                       AS user_email,
      u.nickname                                    AS user_nickname,
      'accepted'::text                              AS decision,
      NULL::text                                    AS reason_message,
      t.currency                                    AS currency,
      t.stake_micro::text                           AS stake_micro,
      t.potential_payout_micro::text                AS potential_payout_micro,
      m.id::text                                    AS match_id,
      CASE WHEN m.id IS NOT NULL
           THEN m.home_team || ' vs ' || m.away_team
           ELSE NULL END                            AS match_label,
      s.id                                          AS sport_id,
      s.slug                                        AS sport_slug,
      tn.id                                         AS tournament_id,
      tn.name                                       AS tournament_name,
      tn.risk_tier                                  AS risk_tier,
      COALESCE(u.risk_score::text, '1.000')         AS rs_at_decision,
      '0'                                           AS bank_at_decision_micro,
      jsonb_build_object(
        'reason', 'non_riskzilla_currency',
        'ticketStatus', t.status::text,
        'betType', t.bet_type::text,
        'legs', (SELECT COUNT(*)::int FROM ticket_selections ts WHERE ts.ticket_id = t.id)
      )                                             AS decision_meta,
      t.placed_at                                   AS created_at
    FROM (
      SELECT t.* FROM tickets t
      ${innerWhere}
      ORDER BY t.placed_at DESC, t.id DESC
      LIMIT ${q.limit * 2}
    ) t
    LEFT JOIN users u ON u.id = t.user_id
    LEFT JOIN LATERAL (
      SELECT ts.market_id
        FROM ticket_selections ts
       WHERE ts.ticket_id = t.id
       ORDER BY ts.id ASC
       LIMIT 1
    ) first_leg ON true
    LEFT JOIN markets    mk ON mk.id = first_leg.market_id
    LEFT JOIN matches    m  ON m.id  = mk.match_id
    LEFT JOIN tournaments tn ON tn.id = m.tournament_id
    LEFT JOIN categories c  ON c.id = tn.category_id
    LEFT JOIN sports     s  ON s.id = c.sport_id
    ${postWhere}
    ORDER BY t.placed_at DESC, t.id DESC
    LIMIT ${q.limit}
  `)) as unknown as RawRow[];

  return rows.map(rawToDto);
}

export default async function riskzillaEventsRoutes(app: FastifyInstance) {
  app.get("/admin/riskzilla/events", async (request) => {
    request.requireRole("admin");
    const q = listQuery.parse(request.query);

    const entries =
      q.currency === "OZ"
        ? await queryTicketsForOz(app, q)
        : await queryEventLog(app, q);

    return { entries };
  });
}
