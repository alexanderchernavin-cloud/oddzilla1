// /admin/unsettled endpoints. Admin-only, read-only.
//
// "Unsettled" here means the match is OVER and the book never went
// terminal: `matches.status IN ('closed','cancelled')` while
// `markets.status NOT IN (-3, -4)`. Nothing in the product settles those
// on its own — Oddin's `bet_settlement` and Fonbet's results grader are
// the only two writers of a terminal market status, so a market that
// neither covered stays open indefinitely, and any ticket on it stays
// `accepted` with the stake already debited.
//
// Why this page exists: the operator's requirement is NO manual
// settlement, so the first thing needed is visibility into everything
// that would require one. Two questions, two tabs:
//
//   GET /admin/unsettled/summary            counts by provider and sport
//   GET /admin/unsettled/matches           finished matches with open markets
//   GET /admin/unsettled/matches/:id/markets   the markets of one such match
//   GET /admin/unsettled/tickets           tickets that cannot resolve
//
// Markets are grouped by match rather than listed flat: the population is
// tens of thousands of market rows across a few hundred matches (33 597
// across 580 matches when this shipped), and a flat list of ladder lines
// is unreadable where the match is the unit an operator actually acts on.
// The per-match drill-down carries the individual rows.
//
// Deliberately read-only. Every remedy — settling by hand, voiding,
// re-running a grader, cancelling — is a money-moving decision with its
// own audit trail, and none of them belong behind a monitoring list.

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { sql } from "drizzle-orm";

// Matches whose book should be closed. `cancelled` is included because a
// cancelled match's markets should have gone to -4 and equally may not
// have. The window keeps the scan bounded; 30 days is well past both the
// Oddin 24 h recovery replay and Fonbet's 7-day grading lookback, so
// anything still here is genuinely stuck rather than in flight.
const finishedMatch = sql`m.status IN ('closed', 'cancelled')`;
const openMarket = sql`mk.status NOT IN (-3, -4)`;
// Tickets whose stake is committed and whose outcome is still undecided.
const openTicket = sql`tk.status IN ('accepted', 'pending_delay')`;

const providerCase = sql`
  CASE
    WHEN m.provider_urn LIKE 'fb:%' THEN 'fonbet'
    WHEN m.provider_urn LIKE 'od:%' THEN 'oddin'
    ELSE 'other'
  END`;

const listQuery = z.object({
  days: z.coerce.number().int().min(1).max(365).default(30),
  provider: z.enum(["all", "oddin", "fonbet", "other"]).default("all"),
  sport: z.string().min(1).max(64).optional(),
  // Only rows that actually have money riding on them. Off by default so
  // the page answers "what is stuck" before "what is stuck and costly".
  // NOT z.coerce.boolean(): every non-empty query string coerces to true
  // there, so `withTickets=false` would silently filter the list.
  withTickets: z
    .enum(["true", "false", "1", "0"])
    .default("false")
    .transform((v) => v === "true" || v === "1"),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).max(100_000).default(0),
});

function iso(v: Date | string | null): string | null {
  if (v === null) return null;
  return v instanceof Date ? v.toISOString() : String(v);
}

export default async function adminUnsettledRoutes(app: FastifyInstance) {
  // Counts for the header strip. Kept separate from the list so the list
  // can paginate without losing the totals.
  app.get("/admin/unsettled/summary", async (request) => {
    request.requireRole("admin");
    const { days } = listQuery.parse(request.query ?? {});

    const totals = (await app.db.execute(sql`
      SELECT
        ${providerCase}                                   AS provider,
        COUNT(DISTINCT m.id)::int                         AS matches,
        COUNT(mk.id)::int                                 AS markets
      FROM matches m
      JOIN markets mk ON mk.match_id = m.id AND ${openMarket}
      WHERE ${finishedMatch}
        AND m.scheduled_at > NOW() - (${days} || ' days')::interval
      GROUP BY 1
      ORDER BY 3 DESC
    `)) as unknown as Array<{ provider: string; matches: number; markets: number }>;

    // Ticket exposure is the number that decides urgency, so it is counted
    // over ALL open tickets that cannot resolve, not just recent ones.
    const tickets = (await app.db.execute(sql`
      SELECT
        tk.currency                                       AS currency,
        COUNT(*)::int                                     AS tickets,
        COALESCE(SUM(tk.stake_micro), 0)::text            AS stake_micro,
        COALESCE(SUM(tk.potential_payout_micro), 0)::text AS potential_payout_micro
      FROM tickets tk
      WHERE ${openTicket}
        AND EXISTS (
          SELECT 1
            FROM ticket_selections ts
            JOIN markets mk ON mk.id = ts.market_id
            JOIN matches m  ON m.id = mk.match_id
           WHERE ts.ticket_id = tk.id
             AND ${finishedMatch}
             AND ${openMarket}
        )
      GROUP BY 1
      ORDER BY 2 DESC
    `)) as unknown as Array<{
      currency: string;
      tickets: number;
      stake_micro: string;
      potential_payout_micro: string;
    }>;

    const bySport = (await app.db.execute(sql`
      SELECT
        s.slug                                            AS sport_slug,
        s.name                                            AS sport_name,
        ${providerCase}                                   AS provider,
        COUNT(DISTINCT m.id)::int                         AS matches,
        COUNT(mk.id)::int                                 AS markets
      FROM matches m
      JOIN tournaments t ON t.id = m.tournament_id
      JOIN categories c  ON c.id = t.category_id
      JOIN sports s      ON s.id = c.sport_id
      JOIN markets mk    ON mk.match_id = m.id AND ${openMarket}
      WHERE ${finishedMatch}
        AND m.scheduled_at > NOW() - (${days} || ' days')::interval
      GROUP BY 1, 2, 3
      ORDER BY 5 DESC
      LIMIT 40
    `)) as unknown as Array<{
      sport_slug: string;
      sport_name: string;
      provider: string;
      matches: number;
      markets: number;
    }>;

    return {
      windowDays: days,
      byProvider: totals.map((r) => ({
        provider: r.provider,
        matches: r.matches,
        markets: r.markets,
      })),
      bySport: bySport.map((r) => ({
        sportSlug: r.sport_slug,
        sportName: r.sport_name,
        provider: r.provider,
        matches: r.matches,
        markets: r.markets,
      })),
      ticketExposure: tickets.map((r) => ({
        currency: r.currency.trim(),
        tickets: r.tickets,
        stakeMicro: r.stake_micro,
        potentialPayoutMicro: r.potential_payout_micro,
      })),
    };
  });

  // Finished matches that still carry a non-terminal market, one row per
  // match with its sport / tournament context and how much is riding on it.
  app.get("/admin/unsettled/matches", async (request) => {
    request.requireRole("admin");
    const q = listQuery.parse(request.query ?? {});

    const rows = (await app.db.execute(sql`
      SELECT
        m.id::text                                        AS match_id,
        m.provider_urn                                    AS provider_urn,
        m.home_team                                       AS home_team,
        m.away_team                                       AS away_team,
        m.status::text                                    AS match_status,
        m.scheduled_at                                    AS scheduled_at,
        s.slug                                            AS sport_slug,
        s.name                                            AS sport_name,
        t.name                                            AS tournament_name,
        c.name                                            AS category_name,
        ${providerCase}                                   AS provider,
        COUNT(mk.id)::int                                 AS unsettled_markets,
        COUNT(mk.id) FILTER (WHERE mk.status = 1)::int    AS active_markets,
        tix.tickets                                       AS open_tickets,
        tix.stake_micro                                   AS open_stake_micro
      FROM matches m
      JOIN tournaments t ON t.id = m.tournament_id
      JOIN categories c  ON c.id = t.category_id
      JOIN sports s      ON s.id = c.sport_id
      JOIN markets mk    ON mk.match_id = m.id AND ${openMarket}
      LEFT JOIN LATERAL (
        SELECT COUNT(DISTINCT tk.id)::int          AS tickets,
               COALESCE(SUM(tk.stake_micro), 0)::text AS stake_micro
          FROM ticket_selections ts
          JOIN markets mk2 ON mk2.id = ts.market_id AND mk2.match_id = m.id
          JOIN tickets tk  ON tk.id = ts.ticket_id
         WHERE ${openTicket}
      ) tix ON TRUE
      WHERE ${finishedMatch}
        AND m.scheduled_at > NOW() - (${q.days} || ' days')::interval
        AND (${q.provider === "all"} OR ${providerCase} = ${q.provider})
        AND (${q.sport === undefined} OR s.slug = ${q.sport ?? ""})
      GROUP BY m.id, m.provider_urn, m.home_team, m.away_team, m.status,
               m.scheduled_at, s.slug, s.name, t.name, c.name,
               tix.tickets, tix.stake_micro
      HAVING (${!q.withTickets} OR COALESCE(tix.tickets, 0) > 0)
      ORDER BY COALESCE(tix.tickets, 0) DESC, m.scheduled_at DESC
      LIMIT ${q.limit} OFFSET ${q.offset}
    `)) as unknown as Array<{
      match_id: string;
      provider_urn: string | null;
      home_team: string;
      away_team: string;
      match_status: string;
      scheduled_at: Date | string;
      sport_slug: string;
      sport_name: string;
      tournament_name: string;
      category_name: string;
      provider: string;
      unsettled_markets: number;
      active_markets: number;
      open_tickets: number | null;
      open_stake_micro: string | null;
    }>;

    return {
      matches: rows.map((r) => ({
        matchId: r.match_id,
        providerUrn: r.provider_urn,
        provider: r.provider,
        homeTeam: r.home_team,
        awayTeam: r.away_team,
        matchStatus: r.match_status,
        scheduledAt: iso(r.scheduled_at)!,
        sportSlug: r.sport_slug,
        sportName: r.sport_name,
        tournamentName: r.tournament_name,
        categoryName: r.category_name,
        unsettledMarkets: r.unsettled_markets,
        activeMarkets: r.active_markets,
        openTickets: r.open_tickets ?? 0,
        openStakeMicro: r.open_stake_micro ?? "0",
      })),
      limit: q.limit,
      offset: q.offset,
    };
  });

  // The individual market rows for one finished match.
  app.get("/admin/unsettled/matches/:matchId/markets", async (request) => {
    request.requireRole("admin");
    const params = z
      .object({ matchId: z.coerce.number().int().positive() })
      .parse(request.params);

    const rows = (await app.db.execute(sql`
      SELECT
        mk.id::text                                       AS market_id,
        mk.provider_market_id                             AS provider_market_id,
        mk.status                                         AS market_status,
        mk.specifiers_json::text                          AS specifiers_json,
        md.name_template                                   AS market_name,
        COUNT(mo.outcome_id)::int                          AS outcomes,
        COUNT(mo.outcome_id) FILTER (
          WHERE mo.result IS NOT NULL
        )::int                                             AS outcomes_with_result,
        tix.tickets                                        AS open_tickets
      FROM markets mk
      LEFT JOIN market_outcomes mo ON mo.market_id = mk.id
      LEFT JOIN LATERAL (
        -- market_descriptions is keyed (provider_market_id, variant,
        -- language); prefer the row for this market's own variant and
        -- fall back to any English row so a label still renders.
        SELECT d.name_template
          FROM market_descriptions d
         WHERE d.provider_market_id = mk.provider_market_id
           AND d.language = 'en'
         ORDER BY (d.variant = COALESCE(mk.specifiers_json->>'variant', '')) DESC,
                  d.variant
         LIMIT 1
      ) md ON TRUE
      LEFT JOIN LATERAL (
        SELECT COUNT(DISTINCT tk.id)::int AS tickets
          FROM ticket_selections ts
          JOIN tickets tk ON tk.id = ts.ticket_id
         WHERE ts.market_id = mk.id AND ${openTicket}
      ) tix ON TRUE
      WHERE mk.match_id = ${params.matchId}
        AND ${openMarket}
      GROUP BY mk.id, mk.provider_market_id, mk.status, mk.specifiers_json,
               md.name_template, tix.tickets
      ORDER BY tix.tickets DESC NULLS LAST, mk.provider_market_id, mk.id
      LIMIT 500
    `)) as unknown as Array<{
      market_id: string;
      provider_market_id: number;
      market_status: number;
      specifiers_json: string | null;
      market_name: string | null;
      outcomes: number;
      outcomes_with_result: number;
      open_tickets: number | null;
    }>;

    return {
      markets: rows.map((r) => ({
        marketId: r.market_id,
        providerMarketId: r.provider_market_id,
        marketStatus: r.market_status,
        specifiers: r.specifiers_json,
        marketName: r.market_name,
        outcomes: r.outcomes,
        outcomesWithResult: r.outcomes_with_result,
        openTickets: r.open_tickets ?? 0,
      })),
    };
  });

  // Tickets whose stake is committed and which cannot resolve, because at
  // least one leg sits on a finished match with a non-terminal market.
  //
  // `allLegsResolved` separates two very different situations that look
  // identical in a status column: a ticket waiting on a market that never
  // settled, versus a ticket whose every leg already has a result but
  // which was never paid — the stranded case settlement's own
  // ReconcileStranded sweep exists to heal. The second is a bug on our
  // side and should clear itself; the first will not.
  app.get("/admin/unsettled/tickets", async (request) => {
    request.requireRole("admin");
    const q = listQuery.parse(request.query ?? {});

    const rows = (await app.db.execute(sql`
      SELECT
        tk.id::text                                       AS ticket_id,
        tk.status::text                                   AS ticket_status,
        tk.bet_type::text                                 AS bet_type,
        tk.currency                                       AS currency,
        tk.stake_micro::text                              AS stake_micro,
        tk.potential_payout_micro::text                   AS potential_payout_micro,
        tk.placed_at                                      AS placed_at,
        u.email::text                                     AS user_email,
        u.nickname::text                                  AS user_nickname,
        u.id::text                                        AS user_id,
        legs.total                                        AS legs,
        legs.unresolved                                   AS legs_unresolved,
        legs.stuck                                        AS legs_stuck,
        legs.last_finished_at                             AS last_finished_at
      FROM tickets tk
      JOIN users u ON u.id = tk.user_id
      JOIN LATERAL (
        SELECT
          COUNT(*)::int                                              AS total,
          COUNT(*) FILTER (WHERE ts.result IS NULL)::int              AS unresolved,
          COUNT(*) FILTER (
            WHERE m.status IN ('closed','cancelled')
              AND mk.status NOT IN (-3,-4)
          )::int                                                      AS stuck,
          MAX(m.scheduled_at) FILTER (
            WHERE m.status IN ('closed','cancelled')
          )                                                           AS last_finished_at
          FROM ticket_selections ts
          JOIN markets mk ON mk.id = ts.market_id
          JOIN matches m  ON m.id = mk.match_id
         WHERE ts.ticket_id = tk.id
      ) legs ON TRUE
      WHERE ${openTicket}
        AND legs.stuck > 0
        AND tk.placed_at > NOW() - (${q.days} || ' days')::interval
      ORDER BY tk.placed_at DESC
      LIMIT ${q.limit} OFFSET ${q.offset}
    `)) as unknown as Array<{
      ticket_id: string;
      ticket_status: string;
      bet_type: string;
      currency: string;
      stake_micro: string;
      potential_payout_micro: string;
      placed_at: Date | string;
      user_email: string;
      user_nickname: string | null;
      user_id: string;
      legs: number;
      legs_unresolved: number;
      legs_stuck: number;
      last_finished_at: Date | string | null;
    }>;

    return {
      tickets: rows.map((r) => ({
        ticketId: r.ticket_id,
        ticketStatus: r.ticket_status,
        betType: r.bet_type,
        currency: r.currency.trim(),
        stakeMicro: r.stake_micro,
        potentialPayoutMicro: r.potential_payout_micro,
        placedAt: iso(r.placed_at)!,
        userId: r.user_id,
        userEmail: r.user_email,
        userNickname: r.user_nickname,
        legs: r.legs,
        legsUnresolved: r.legs_unresolved,
        legsStuck: r.legs_stuck,
        allLegsResolved: r.legs_unresolved === 0,
        lastFinishedAt: iso(r.last_finished_at),
      })),
      limit: q.limit,
      offset: q.offset,
    };
  });
}
