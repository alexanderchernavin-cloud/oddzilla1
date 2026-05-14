// ZillaFacts — statistical streak cards that sit between the stream and
// the markets-tabs on the match-detail page. Where ZillaTips surfaces
// any (market, outcome) whose last-5 flat-stake ROI clears +20%,
// ZillaFacts only surfaces hard, consecutive streaks: a team has won
// (or hit Over / Yes / etc.) its last N matches in a row on the same
// (provider_market_id, specifiers_hash) signature, for N ≥
// ZILLAFACT_MIN_STREAK. The downstream tier glow scales with both
// streak length AND current odds, so a 6-streak at 2.50 ranks as
// "fire" while a 5-streak at 1.05 stays subtle.
//
// Same outcome-coverage as ZillaTips (positional 1/2, symmetric Over/
// Under / Yes/No / Odd-Even, and {side}-specifier markets) — handicap
// and correct-score markets are excluded until we have proper specifier
// mirroring across home/away role flips.

export type ZillaFactResult =
  | "won"
  | "lost"
  | "void"
  | "half_won"
  | "half_lost";

export type ZillaFactRole = "home" | "away";

// One historical leg in the streak. Always materialised in newest-first
// order so the rendered chip row reads as "today ← N matches back".
// `result` and `prematchOdds` are nullable for safety (legacy matches
// from before migration 0047 have no prematch snapshot); the streak
// walker treats a null result as a break, so they don't silently
// inflate streak length.
export interface ZillaFactLeg {
  histMatchId: string;
  teamRoleHist: ZillaFactRole;
  opponentLabel: string;
  opponentLogoUrl: string | null;
  opponentBrandColor: string | null;
  prematchOdds: string | null;
  result: ZillaFactResult | null;
  equivOutcomeId: string;
  liveStartedAt: string;
  scheduledAt: string | null;
}

export interface ZillaFact {
  // The (market, outcome) on the CURRENT match this fact attaches to.
  // The storefront uses these to deep-link the corresponding outcome
  // button when the user taps "show me this market" on the card.
  marketId: string;
  outcomeId: string;

  // Team-of-interest pinned to the current match. For positional
  // outcomes ("1"/"2") this is the home or away team respectively;
  // for symmetric outcomes (over/under, yes/no) the fact is computed
  // per-team and the response carries one fact per qualifying team.
  teamId: number;
  teamName: string;
  teamRole: ZillaFactRole;
  teamLogoUrl: string | null;
  teamBrandColor: string | null;

  // Pre-rendered display strings — server resolves both the market
  // name template and the outcome label using the same renderer the
  // catalog endpoint uses, so the card doesn't have to look anything
  // up against the live LiveMarkets state.
  marketName: string;
  outcomeLabel: string;

  // Server-composed sentence stating the fact in plain English —
  // "Aurora Gaming have won their last 5 matches" / "Total kills went
  // under 45.5 in Aurora Gaming's last 5 matches" / "After winning
  // Map 1, Aurora Gaming have won the match in their last 5 starts".
  // The frontend renders this verbatim instead of trying to compose
  // text from market + outcome — keeps the live-conditioned and
  // prematch-streak phrasings consistent and skip the client of
  // template-resolution branches.
  factText: string;

  // Win count among qualifying past trials. For streak-shape facts
  // (the historical default) this is the consecutive-from-newest
  // count of matches/maps that landed the same directional outcome;
  // streak === sampleSize by construction. For rate-shape facts
  // (live conditional patterns that gate on an in-match predicate)
  // this is the number of WINS over a denominator of qualifying
  // trials; sampleSize is the denominator and streak <= sampleSize.
  // Always >= ZILLAFACT_MIN_STREAK by construction.
  streak: number;

  // Denominator for the win count. Equals `streak` for streak-shape
  // facts. For rate-shape facts (in-match conditional with an 80%+
  // hit-rate floor) this is the number of past trials where the
  // predicate matched, including the losses; e.g. streak=8 with
  // sampleSize=10 reads as "8 of last 10 …".
  sampleSize: number;

  // Current outcome's published odds on the live match. Null when the
  // outcome is currently suspended (status=0) or odds haven't been
  // published yet — the card still renders the streak but shows
  // "Suspended" instead of an odds value.
  currentOdds: string | null;

  // Composite quality score = streak × ln(currentOdds), or just the
  // streak itself when currentOdds is null. Used both for sort
  // (descending) and the visual tier ladder below. A 9-streak at 1.50
  // (~3.65) ranks above a 5-streak at 2.00 (~3.47) ranks above a
  // 5-streak at 1.10 (~0.48).
  score: number;

  // The streak's matches, newest-first. Length === streak. Every leg
  // here has result IN ('won', 'half_won') — losses, voids, and unrated
  // matches break the streak so they don't appear in `legs`.
  legs: ZillaFactLeg[];
}

export interface ZillaFactsResponse {
  matchId: string;
  facts: ZillaFact[];
}

// Minimum consecutive matches for a streak to surface as a fact. The
// user spec calls out "at least 5 matches but the more the better" —
// 5 is the floor, the score-based tier ladder rewards longer runs.
export const ZILLAFACT_MIN_STREAK = 5;

// How far back the SQL looks per team. 30 matches × 365-day window
// bounds the per-team scan; the streak walker stops at the first
// break anyway, so this is just the cap on how long a streak can be
// reported.
export const ZILLAFACT_LOOKBACK_LEGS = 30;
export const ZILLAFACT_LOOKBACK_DAYS = 365;

// Hard cap on how many cards the storefront renders. Past this, the
// band feels cluttered rather than informational. The server also
// respects the cap so cached responses don't carry redundant entries.
export const ZILLAFACT_MAX_CARDS = 6;

// Minimum live odds for a fact to surface. Anything tighter than 1.10
// is uninteresting as a tip: the bookmaker price already says the
// outcome is near-certain, and even a long streak doesn't add
// information. Filtered hard regardless of streak length.
export const ZILLAFACT_MIN_ODDS = 1.10;

// Minimum composite score for a fact to surface. streak × ln(odds) ≥
// 1.0 means roughly: 11 in a row at 1.10 / 6 at 1.20 / 5 at 1.23 /
// 5 at 1.50 (score 2.0). Filters the "high streak at near-certain
// odds" trap — a 7-streak at 1.04 (score 0.275) reads like a
// confident fact but the odds say it's the default outcome anyway.
export const ZILLAFACT_MIN_SCORE = 1.0;

// Visual tier ladder, by composite score. Same shape as ZillaTips'
// (base → glow → fire). Examples:
//   • 5 wins at 1.10 odds → score 0.48 → base
//   • 5 wins at 2.00 odds → score 3.47 → fire
//   • 9 wins at 1.50 odds → score 3.65 → fire
//   • 6 wins at 1.20 odds → score 1.09 → base
//   • 7 wins at 1.40 odds → score 2.35 → glow
export const ZILLAFACT_TIER_GLOW = 1.5;
export const ZILLAFACT_TIER_FIRE = 3.0;

export type ZillaFactTier = "base" | "glow" | "fire";

export function zillaFactTier(score: number): ZillaFactTier {
  if (score >= ZILLAFACT_TIER_FIRE) return "fire";
  if (score >= ZILLAFACT_TIER_GLOW) return "glow";
  return "base";
}

// Pure helper for the score formula. Centralised so the API and the
// storefront agree on the number (the API ships it, but the UI may
// recompute when filtering / sorting client-side).
export function zillaFactScore(streak: number, odds: number | null): number {
  if (odds == null || !Number.isFinite(odds) || odds <= 1) {
    // Streak with no usable odds: rank below any streak with odds, but
    // above zero so the fact still has a sortable score.
    return streak * 0.05;
  }
  return streak * Math.log(odds);
}
