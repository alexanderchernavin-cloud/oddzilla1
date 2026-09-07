// Builds the bet-slip selection for one inline match-winner cell on a
// list surface.
//
// Extracted because TWO layouts now render that cell — the Default
// layout's card (match-row.tsx) and the Pro layout's table row
// (match-table.tsx) — and one field on it is load-bearing in a way a
// second hand-written copy would eventually get wrong:
// `customBoostRuleId`. Without it POST /bets falls back to the raw
// published price, and since a typical ZillaBoost sits INSIDE the 5%
// drift tolerance the bet is silently accepted at the lower raw price
// rather than rejected. A layout that forgot it would quote one number
// and charge another, with nothing failing anywhere.
//
// The input type is declared structurally rather than imported from
// match-row.tsx: that module is "use client" and imports this one back,
// so a type import here would close a cycle for no benefit. `ListMatch`
// satisfies this shape by construction.

import type { SlipSelection } from "@oddzilla/types";

export type MatchWinnerSide = "home" | "away" | "draw";

interface Outcome {
  outcomeId: string;
  price: string | null;
  probability?: string | null;
  boost?: { ruleId: string } | null;
}

export interface MatchWinnerInput {
  id: string;
  homeTeam: string;
  awayTeam: string;
  matchWinner: {
    marketId: string;
    home: Outcome;
    away: Outcome;
    draw?: Outcome | null;
  } | null;
}

/**
 * Returns the slip selection for `side`, or null when there is nothing
 * bettable there (no market, no outcome, or a suspended price). Callers
 * treat null as "the cell is locked" and do nothing.
 */
export function matchWinnerSelection(
  match: MatchWinnerInput,
  side: MatchWinnerSide,
  sportSlug: string,
  labels: { marketLabel: string; drawLabel: string },
): SlipSelection | null {
  const mw = match.matchWinner;
  if (!mw) return null;
  const o = side === "draw" ? mw.draw ?? null : mw[side];
  if (!o || !o.price) return null;
  const outcomeLabel =
    side === "home"
      ? match.homeTeam
      : side === "away"
        ? match.awayTeam
        : labels.drawLabel;
  return {
    matchId: match.id,
    marketId: mw.marketId,
    outcomeId: o.outcomeId,
    odds: o.price,
    probability: o.probability ?? undefined,
    homeTeam: match.homeTeam,
    awayTeam: match.awayTeam,
    marketLabel: labels.marketLabel,
    outcomeLabel,
    sportSlug,
    // Stamped true because the null-price guard above already rejected
    // the suspended case: the merge in MatchListTabs nulls the price
    // when a tick reports active=false or the market leaves status 1,
    // so reaching here means the outcome was bettable at click time.
    // The slip rail re-derives `active` from later ticks.
    active: true,
    customBoostRuleId: o.boost?.ruleId,
  };
}
