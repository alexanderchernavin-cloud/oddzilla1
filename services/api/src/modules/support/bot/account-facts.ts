// Read-only context handed to the Gemma assistant.
//
// buildAccountFacts: the asking bettor's own account (wallet, tickets with
// per-leg results, deposits, withdrawals) so it can answer account-specific
// questions WITHOUT inventing anything. Strictly read-only, scoped to the
// bettor, and omits all secrets/PII (addresses, tx hashes, IPs, hashes,
// admin-approver ids, bet_meta).
//
// The schedule ("when does X play", "what's live") is fetched on demand by
// the worker via the read-only find_matches tool, so it is NOT pre-bundled
// into the /pending payload.

import type { FastifyInstance } from "fastify";
import { desc, eq, sql } from "drizzle-orm";
import { fromMicroMoney } from "@oddzilla/types";
import type {
  SupportAccountDepositFact,
  SupportAccountFacts,
  SupportAccountTicketFact,
  SupportAccountWalletFact,
  SupportAccountWithdrawalFact,
} from "@oddzilla/types";
import { depositIntents, wallets, withdrawals } from "@oddzilla/db";
import { BetsService } from "../../bets/service.js";

const TICKET_LIMIT = 10;
const DEPOSIT_LIMIT = 5;
const WITHDRAWAL_LIMIT = 5;

function iso(d: Date | null | undefined): string | null {
  return d ? d.toISOString() : null;
}

// char(4) currency columns come back space-padded ("OZ  "); trim for display.
function cur(c: string): string {
  return c.trim();
}

export async function buildAccountFacts(
  app: FastifyInstance,
  userId: string,
): Promise<SupportAccountFacts> {
  // Reuse the same hydration the bet-history page uses so each leg carries a
  // human market name, the picked outcome, odds, won/lost result, and match.
  const bets = new BetsService(app.db, app.redis);
  const [walletRows, ticketSummaries, depositRows, withdrawalRows] =
    await Promise.all([
      app.db
        .select({
          currency: wallets.currency,
          balanceMicro: wallets.balanceMicro,
          lockedMicro: wallets.lockedMicro,
        })
        .from(wallets)
        .where(eq(wallets.userId, userId)),
      bets.listForUser(userId, TICKET_LIMIT),
      app.db
        .select({
          status: depositIntents.status,
          amountMicro: depositIntents.amountMicro,
          confirmations: depositIntents.confirmations,
          failureReason: depositIntents.failureReason,
          submittedAt: depositIntents.submittedAt,
        })
        .from(depositIntents)
        .where(eq(depositIntents.userId, userId))
        .orderBy(desc(depositIntents.submittedAt))
        .limit(DEPOSIT_LIMIT),
      app.db
        .select({
          status: withdrawals.status,
          amountMicro: withdrawals.amountMicro,
          feeMicro: withdrawals.feeMicro,
          failureReason: withdrawals.failureReason,
          requestedAt: withdrawals.requestedAt,
        })
        .from(withdrawals)
        .where(eq(withdrawals.userId, userId))
        .orderBy(desc(withdrawals.requestedAt))
        .limit(WITHDRAWAL_LIMIT),
    ]);

  const walletFacts: SupportAccountWalletFact[] = walletRows.map((w) => ({
    currency: cur(w.currency),
    available: fromMicroMoney(w.balanceMicro - w.lockedMicro, { decimals: 2 }),
    locked: fromMicroMoney(w.lockedMicro, { decimals: 2 }),
  }));

  const ticketFacts: SupportAccountTicketFact[] = ticketSummaries.map((t) => ({
    id: t.id,
    status: t.status,
    betType: t.betType,
    currency: cur(t.currency),
    stake: fromMicroMoney(BigInt(t.stakeMicro), { decimals: 2 }),
    potentialPayout: fromMicroMoney(BigInt(t.potentialPayoutMicro), {
      decimals: 2,
    }),
    actualPayout:
      t.actualPayoutMicro == null
        ? null
        : fromMicroMoney(BigInt(t.actualPayoutMicro), { decimals: 2 }),
    placedAt: t.placedAt,
    settledAt: t.settledAt,
    legs: t.selections.map((s) => ({
      market:
        s.market?.marketName ||
        (s.market ? `Market #${s.market.providerMarketId}` : "Unknown market"),
      pick: s.market?.outcomeName || s.outcomeId,
      odds: s.oddsAtPlacement,
      result: s.result ?? "pending",
      match: s.market ? `${s.market.homeTeam} vs ${s.market.awayTeam}` : "",
      sport: s.market?.sportSlug ?? "",
      matchStatus: s.market?.matchStatus ?? "",
    })),
  }));

  const depositFacts: SupportAccountDepositFact[] = depositRows.map((d) => ({
    status: d.status,
    amount:
      d.amountMicro == null
        ? null
        : fromMicroMoney(d.amountMicro, { decimals: 2 }),
    confirmations: d.confirmations,
    failureReason: d.failureReason ?? null,
    submittedAt: iso(d.submittedAt),
  }));

  const withdrawalFacts: SupportAccountWithdrawalFact[] = withdrawalRows.map(
    (w) => ({
      status: w.status,
      amount: fromMicroMoney(w.amountMicro, { decimals: 2 }),
      fee: fromMicroMoney(w.feeMicro, { decimals: 2 }),
      failureReason: w.failureReason ?? null,
      requestedAt: iso(w.requestedAt),
    }),
  );

  return {
    wallets: walletFacts,
    tickets: ticketFacts,
    deposits: depositFacts,
    withdrawals: withdrawalFacts,
  };
}

export interface TeamResult {
  playedAt: string;
  opponent: string;
  sport: string;
  tournament: string;
  /** won | lost | void | unknown — from the settled match-winner market. */
  result: string;
}

/** A team's recent FINISHED matches and whether they won or lost each, for
 * history / form questions. Win/loss comes from the settled match-winner
 * market (market_outcomes.result), which is authoritative — live_score is
 * unreliable (some closed matches store 0-0). Read-only, public data. */
export async function buildTeamResults(
  app: FastifyInstance,
  query: string,
  opts: { sport?: string; limit?: number } = {},
): Promise<{ team: string | null; sport: string | null; results: TeamResult[] }> {
  const q = query.trim().slice(0, 80);
  if (!q) return { team: null, sport: null, results: [] };
  const limit = opts.limit ?? 12;
  const sport = opts.sport?.trim().toLowerCase() || null;
  const like = `%${q}%`;
  const prefix = `${q}%`;
  // Same team name = a different team per game (competitors are per-sport
  // rows), so when the caller knows which game the question is about we must
  // scope the team PICK itself — not just the matches. Filtering only the
  // matches let the CTE pick the wrong game's competitor (shortest-name
  // tiebreak) and then return zero rows, so the bot answered "no results"
  // for a team that exists. Once the right competitor is chosen its matches
  // are already all in that sport, so no outer sport filter is needed.
  const teamSportFilter = sport
    ? sql`AND c.sport_id = (SELECT cs.id FROM sports cs WHERE cs.slug = ${sport})`
    : sql``;
  const rows = await app.db.execute<{
    team: string;
    played_at: string;
    opponent: string;
    sport: string;
    tournament: string;
    result: string | null;
  }>(sql`
    WITH t AS (
      SELECT c.id, c.name FROM competitors c
      WHERE c.name ILIKE ${like}
        ${teamSportFilter}
      ORDER BY (lower(c.name) = lower(${q})) DESC,
               (c.name ILIKE ${prefix}) DESC,
               length(c.name) ASC
      LIMIT 1
    )
    SELECT t.name AS team,
           to_char(m.scheduled_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS played_at,
           CASE WHEN m.home_competitor_id = t.id THEN ac.name ELSE hc.name END AS opponent,
           s.slug AS sport,
           tr.name AS tournament,
           (SELECT mo.result
              FROM markets mk
              JOIN market_outcomes mo ON mo.market_id = mk.id
             WHERE mk.match_id = m.id AND mk.provider_market_id = 1
               AND mo.outcome_id = CASE WHEN m.home_competitor_id = t.id THEN '1' ELSE '2' END
             LIMIT 1) AS result
    FROM t
    JOIN matches m
      ON (m.home_competitor_id = t.id OR m.away_competitor_id = t.id)
    JOIN competitors hc ON hc.id = m.home_competitor_id
    JOIN competitors ac ON ac.id = m.away_competitor_id
    JOIN tournaments tr ON tr.id = m.tournament_id
    JOIN categories cat ON cat.id = tr.category_id
    JOIN sports s ON s.id = cat.sport_id
    WHERE m.status = 'closed'
    ORDER BY m.scheduled_at DESC
    LIMIT ${limit}
  `);
  const arr = Array.from(rows);
  return {
    team: arr[0]?.team ?? null,
    sport,
    results: arr.map((r) => ({
      playedAt: r.played_at,
      opponent: r.opponent,
      sport: r.sport,
      tournament: r.tournament,
      result: r.result ?? "unknown",
    })),
  };
}
