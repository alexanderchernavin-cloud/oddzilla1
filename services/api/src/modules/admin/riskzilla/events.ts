// /admin/riskzilla/events — paged feed powering Betticker + Bets.
//
// Two data sources, branched on currency:
//
//   - USDC: reads `riskzilla_event_log`. The engine writes both
//     accepted + rejected decisions here, with per-bucket meta.
//     For accepted events with a ticket_id, we additionally pull
//     per-leg market + outcome metadata via ticket_selections so
//     the Bets view can render market / selection columns.
//
//   - OZ:   reads `tickets`. The engine bypasses OZ entirely
//     (`engine.ts` — RISKZILLA_CURRENCY = "USDC"), so event_log is
//     empty for OZ. Sourcing from tickets makes the admin view
//     useful for monitoring demo / perf-test placement volume —
//     decisions are synthetically "accepted" since the rejected
//     code path doesn't create a ticket row.
//
// The two queries return the same EventRowDto shape so the
// betticker + bets clients render either uniformly. Pagination is
// page-based (OFFSET/LIMIT) with a parallel COUNT(*) so the
// frontend can render `1–100 of N` and Prev/Next controls.

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { sql } from "drizzle-orm";
import { SUPPORTED_CURRENCIES } from "@oddzilla/types/currencies";

// Derives the visible "Status" cell. The Riskzilla decision column is
// recorded once at placement (`accepted` / `rejected_*`) and never
// changes — so a ticket placed last week still reads "accepted" in
// the admin table even when it long since settled to won / lost /
// void / cashed_out. Operators want the column to reflect the current
// lifecycle state. This expression overlays `tickets.status` (and
// `actual_payout_micro` for win/lose/partial classification) on top
// of the placement decision:
//
//   tickets.status = 'cashed_out'    → cashed_out
//   tickets.status = 'voided'        → void
//   tickets.status = 'settled' & payout >= stake → won
//   tickets.status = 'settled' & payout > 0      → partial
//   tickets.status = 'settled' & payout = 0      → lost
//   tickets.status = 'pending_delay'             → pending_delay
//   otherwise (no ticket / still accepted / rejected_*) → el.decision
//
// Filtering (`q.decision`, `q.status`) still keys on
// `el.decision::riskzilla_decision` so the rejection filters keep
// working — the derived value only affects the column the UI renders.
// Aliased `t` is the `LEFT JOIN tickets ON t.id = el.ticket_id` in
// the USDC path, or the `tickets t` row directly in the OZ path.
const decisionFromTicketSql = sql`
  CASE
    WHEN t.id IS NULL THEN el.decision::text
    WHEN t.status = 'cashed_out' THEN 'cashed_out'
    WHEN t.status = 'voided' THEN 'void'
    WHEN t.status = 'settled' AND COALESCE(t.actual_payout_micro, 0) >= t.stake_micro THEN 'won'
    WHEN t.status = 'settled' AND COALESCE(t.actual_payout_micro, 0) > 0 THEN 'partial'
    WHEN t.status = 'settled' THEN 'lost'
    WHEN t.status = 'pending_delay' THEN 'pending_delay'
    ELSE el.decision::text
  END
`;

// Same logic for the OZ branch, where the ticket row IS the source —
// no event-log fallback. Defaults to a literal 'accepted' for the
// open / not-yet-settled ticket states.
const decisionFromTicketOzSql = sql`
  CASE
    WHEN t.status = 'cashed_out' THEN 'cashed_out'
    WHEN t.status = 'voided' THEN 'void'
    WHEN t.status = 'settled' AND COALESCE(t.actual_payout_micro, 0) >= t.stake_micro THEN 'won'
    WHEN t.status = 'settled' AND COALESCE(t.actual_payout_micro, 0) > 0 THEN 'partial'
    WHEN t.status = 'settled' THEN 'lost'
    WHEN t.status = 'pending_delay' THEN 'pending_delay'
    ELSE 'accepted'
  END
`;

const currencySchema = z
  .string()
  .transform((s) => s.toUpperCase())
  .pipe(z.enum(SUPPORTED_CURRENCIES));

// Whitelist of sortable columns. The keys are stable strings the
// frontend sends; each path (event_log / tickets) maps them to its
// own column expression.
const SORT_KEYS = [
  "createdAt",
  "stake",
  "potentialPayout",
  "decision",
  "riskTier",
] as const;
type SortKey = (typeof SORT_KEYS)[number];

const listQuery = z.object({
  limit: z.coerce.number().int().min(1).max(500).default(100),
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  sortBy: z.enum(SORT_KEYS).default("createdAt"),
  sortDir: z.enum(["asc", "desc"]).default("desc"),
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
  currency: currencySchema.optional(),
  fromTs: z.coerce.date().optional(),
  toTs: z.coerce.date().optional(),
  minStakeMicro: z.string().regex(/^\d+$/).optional(),
  maxStakeMicro: z.string().regex(/^\d+$/).optional(),
});

interface EventSelectionDto {
  marketId: string;
  providerMarketId: number;
  marketName: string;
  outcomeId: string;
  outcomeName: string | null;
  oddsAtPlacement: string;
  matchId: string | null;
  matchLabel: string | null;
  result: string | null;
}

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
  // Per-leg selection list. Empty for rejected events without a
  // ticket_id (no ticket row to JOIN to).
  selections: EventSelectionDto[];
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
  selections: EventSelectionDto[] | null;
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
    selections: Array.isArray(r.selections) ? r.selections : [],
    createdAt:
      r.created_at instanceof Date
        ? r.created_at.toISOString()
        : String(r.created_at),
  };
}

type ListQuery = z.infer<typeof listQuery>;

interface PathResult {
  entries: EventRowDto[];
  total: number;
}

// ── USDC: riskzilla_event_log ──────────────────────────────────────────

const EVENT_LOG_SORT: Record<SortKey, ReturnType<typeof sql>> = {
  createdAt: sql`el.created_at`,
  stake: sql`el.stake_micro`,
  potentialPayout: sql`el.potential_payout_micro`,
  decision: sql`el.decision`,
  riskTier: sql`el.risk_tier`,
};

async function queryEventLog(
  app: FastifyInstance,
  q: ListQuery,
): Promise<PathResult> {
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

  const where =
    conditions.length === 0
      ? sql``
      : sql`WHERE ${conditions.reduce((acc, c, i) =>
          i === 0 ? c : sql`${acc} AND ${c}`,
        )}`;

  const sortColumn = EVENT_LOG_SORT[q.sortBy];
  const sortClause =
    q.sortDir === "asc"
      ? sql`${sortColumn} ASC NULLS LAST, el.id ASC`
      : sql`${sortColumn} DESC NULLS LAST, el.id DESC`;
  const offset = (q.page - 1) * q.limit;

  const totalPromise = app.db.execute(sql`
    SELECT COUNT(*)::bigint AS total
      FROM riskzilla_event_log el
      ${where}
  `) as unknown as Promise<Array<{ total: string }>>;

  const rowsPromise = app.db.execute(sql`
    SELECT
      el.id::text                                   AS id,
      EXTRACT(epoch FROM el.created_at) * 1000      AS cursor_ms,
      el.ticket_id::text                            AS ticket_id,
      el.user_id::text                              AS user_id,
      u.email                                       AS user_email,
      u.nickname                                    AS user_nickname,
      -- See decisionFromTicketSql above: collapses placement decision
      -- and post-settlement lifecycle into one cell so old tickets stop
      -- reading ACCEPTED after they actually settled.
      ${decisionFromTicketSql}                      AS decision,
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
      COALESCE(sel.selections, '[]'::jsonb)         AS selections,
      el.created_at                                 AS created_at
    FROM riskzilla_event_log el
    LEFT JOIN users       u  ON u.id = el.user_id
    LEFT JOIN tickets     t  ON t.id = el.ticket_id
    LEFT JOIN matches     m  ON m.id = el.match_id
    LEFT JOIN sports      s  ON s.id = el.sport_id
    LEFT JOIN tournaments tn ON tn.id = el.tournament_id
    LEFT JOIN LATERAL (
      SELECT jsonb_agg(
        jsonb_build_object(
          'marketId',         lmk.id::text,
          'providerMarketId', lmk.provider_market_id,
          'marketName',       COALESCE(
            (SELECT md.name_template
               FROM market_descriptions md
              WHERE md.provider_market_id = lmk.provider_market_id
              ORDER BY (md.variant = '') DESC, md.variant
              LIMIT 1),
            'Market #' || lmk.provider_market_id
          ),
          'outcomeId',         ts.outcome_id,
          'outcomeName',       mo.name,
          'oddsAtPlacement',   ts.odds_at_placement::text,
          'matchId',           lmk.match_id::text,
          'matchLabel',        CASE WHEN lm.id IS NOT NULL
                                     THEN lm.home_team || ' vs ' || lm.away_team
                                     ELSE NULL END,
          'result',            ts.result::text
        )
        ORDER BY ts.id ASC
      ) AS selections
      FROM ticket_selections ts
      JOIN markets        lmk ON lmk.id = ts.market_id
      LEFT JOIN matches   lm  ON lm.id  = lmk.match_id
      LEFT JOIN market_outcomes mo ON mo.market_id = ts.market_id AND mo.outcome_id = ts.outcome_id
      WHERE el.ticket_id IS NOT NULL AND ts.ticket_id = el.ticket_id
    ) sel ON true
    ${where}
    ORDER BY ${sortClause}
    LIMIT ${q.limit}
    OFFSET ${offset}
  `) as unknown as Promise<RawRow[]>;

  const [rows, totalRows] = await Promise.all([rowsPromise, totalPromise]);
  return {
    entries: rows.map(rawToDto),
    total: Number(totalRows[0]?.total ?? 0),
  };
}

// ── OZ: tickets ─────────────────────────────────────────────────────────

const TICKETS_SORT: Record<SortKey, ReturnType<typeof sql>> = {
  createdAt: sql`t.placed_at`,
  stake: sql`t.stake_micro`,
  potentialPayout: sql`t.potential_payout_micro`,
  // The "decision" column for OZ tickets is synthesised — every OZ
  // ticket is "accepted". Sort by ticket status to give the column
  // something stable to do (settled / accepted / voided ordering).
  decision: sql`t.status`,
  riskTier: sql`(
    SELECT tn.risk_tier
      FROM ticket_selections ts
      JOIN markets mk ON mk.id = ts.market_id
      JOIN matches m  ON m.id  = mk.match_id
      JOIN tournaments tn ON tn.id = m.tournament_id
     WHERE ts.ticket_id = t.id
     ORDER BY ts.id ASC
     LIMIT 1
  )`,
};

async function queryTicketsForOz(
  app: FastifyInstance,
  q: ListQuery,
): Promise<PathResult> {
  // Rejection filters never match — OZ tickets are all accepted.
  if (q.status === "rejected" || (q.decision && q.decision !== "accepted")) {
    return { entries: [], total: 0 };
  }

  const conditions: ReturnType<typeof sql>[] = [sql`t.currency = 'OZ'`];
  if (q.userId) conditions.push(sql`t.user_id = ${q.userId}::uuid`);
  if (q.fromTs)
    conditions.push(sql`t.placed_at >= ${q.fromTs.toISOString()}::timestamptz`);
  if (q.toTs) conditions.push(sql`t.placed_at <= ${q.toTs.toISOString()}::timestamptz`);
  if (q.minStakeMicro) conditions.push(sql`t.stake_micro >= ${q.minStakeMicro}::bigint`);
  if (q.maxStakeMicro) conditions.push(sql`t.stake_micro <= ${q.maxStakeMicro}::bigint`);
  // Sport / match / tier filters land in the inner WHERE via EXISTS so
  // COUNT(*) and LIMIT/OFFSET both see the same row set, and "any leg
  // matches" is the right semantic for multi-leg combos.
  if (q.sportId !== undefined) {
    conditions.push(sql`EXISTS (
      SELECT 1
        FROM ticket_selections ts
        JOIN markets    smk ON smk.id = ts.market_id
        JOIN matches    sm  ON sm.id  = smk.match_id
        JOIN tournaments stn ON stn.id = sm.tournament_id
        JOIN categories sc  ON sc.id = stn.category_id
       WHERE ts.ticket_id = t.id AND sc.sport_id = ${q.sportId}
    )`);
  }
  if (q.matchId !== undefined) {
    conditions.push(sql`EXISTS (
      SELECT 1
        FROM ticket_selections ts
        JOIN markets mmk ON mmk.id = ts.market_id
       WHERE ts.ticket_id = t.id AND mmk.match_id = ${q.matchId.toString()}::bigint
    )`);
  }
  if (q.riskTier !== undefined) {
    conditions.push(sql`EXISTS (
      SELECT 1
        FROM ticket_selections ts
        JOIN markets    rmk ON rmk.id = ts.market_id
        JOIN matches    rm  ON rm.id  = rmk.match_id
        JOIN tournaments rtn ON rtn.id = rm.tournament_id
       WHERE ts.ticket_id = t.id AND rtn.risk_tier = ${q.riskTier}
    )`);
  }

  const innerWhere = sql`WHERE ${conditions.reduce((acc, c, i) =>
    i === 0 ? c : sql`${acc} AND ${c}`,
  )}`;

  const sortColumn = TICKETS_SORT[q.sortBy];
  const sortClause =
    q.sortDir === "asc"
      ? sql`${sortColumn} ASC NULLS LAST, t.id ASC`
      : sql`${sortColumn} DESC NULLS LAST, t.id DESC`;
  const offset = (q.page - 1) * q.limit;

  const totalPromise = app.db.execute(sql`
    SELECT COUNT(*)::bigint AS total
      FROM tickets t
      ${innerWhere}
  `) as unknown as Promise<Array<{ total: string }>>;

  const rowsPromise = app.db.execute(sql`
    WITH filtered AS (
      SELECT t.* FROM tickets t
      ${innerWhere}
      ORDER BY ${sortClause}
      LIMIT ${q.limit}
      OFFSET ${offset}
    )
    SELECT
      t.id::text                                    AS id,
      EXTRACT(epoch FROM t.placed_at) * 1000        AS cursor_ms,
      t.id::text                                    AS ticket_id,
      t.user_id::text                               AS user_id,
      u.email                                       AS user_email,
      u.nickname                                    AS user_nickname,
      ${decisionFromTicketOzSql}                    AS decision,
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
      COALESCE(sel.selections, '[]'::jsonb)         AS selections,
      t.placed_at                                   AS created_at
    FROM filtered t
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
    LEFT JOIN LATERAL (
      SELECT jsonb_agg(
        jsonb_build_object(
          'marketId',         lmk.id::text,
          'providerMarketId', lmk.provider_market_id,
          'marketName',       COALESCE(
            (SELECT md.name_template
               FROM market_descriptions md
              WHERE md.provider_market_id = lmk.provider_market_id
              ORDER BY (md.variant = '') DESC, md.variant
              LIMIT 1),
            'Market #' || lmk.provider_market_id
          ),
          'outcomeId',         ts.outcome_id,
          'outcomeName',       mo.name,
          'oddsAtPlacement',   ts.odds_at_placement::text,
          'matchId',           lmk.match_id::text,
          'matchLabel',        CASE WHEN lm.id IS NOT NULL
                                     THEN lm.home_team || ' vs ' || lm.away_team
                                     ELSE NULL END,
          'result',            ts.result::text
        )
        ORDER BY ts.id ASC
      ) AS selections
      FROM ticket_selections ts
      JOIN markets        lmk ON lmk.id = ts.market_id
      LEFT JOIN matches   lm  ON lm.id  = lmk.match_id
      LEFT JOIN market_outcomes mo ON mo.market_id = ts.market_id AND mo.outcome_id = ts.outcome_id
      WHERE ts.ticket_id = t.id
    ) sel ON true
    ORDER BY ${sortClause}
  `) as unknown as Promise<RawRow[]>;

  const [rows, totalRows] = await Promise.all([rowsPromise, totalPromise]);
  return {
    entries: rows.map(rawToDto),
    total: Number(totalRows[0]?.total ?? 0),
  };
}

export default async function riskzillaEventsRoutes(app: FastifyInstance) {
  app.get("/admin/riskzilla/events", async (request) => {
    request.requireRole("admin");
    const q = listQuery.parse(request.query);

    const result =
      q.currency === "OZ"
        ? await queryTicketsForOz(app, q)
        : await queryEventLog(app, q);

    const totalPages = Math.max(1, Math.ceil(result.total / q.limit));
    return {
      entries: result.entries,
      total: result.total,
      page: q.page,
      pageSize: q.limit,
      totalPages,
      sortBy: q.sortBy,
      sortDir: q.sortDir,
    };
  });
}
