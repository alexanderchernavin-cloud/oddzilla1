// Builds four "suggested 3-fold" parlays for the lobby promo cards by
// scanning the live + upcoming match pool. Each tier has both a per-leg
// odds constraint and a combined-odds band:
//
//   safe        legs <  1.50  →  combined [2.00, 3.00)
//   challenging legs >= 1.50  →  combined [3.00, 5.00)
//   risky       legs >  1.80  →  combined [5.00, 10.00)
//   ultimate    legs >  2.00  →  combined [10.00, 100.00)
//
// The per-leg constraint is enforced first: legs that don't qualify are
// dropped from the tier's candidate pool entirely. Then we enumerate
// combinations of three distinct matches and try each match's qualifying
// side(s) until we land in the band — preferring the combo whose product
// is closest to the band's target.
//
// Pure & deterministic: same input → same output. Runs server-side from
// the home page render; no API call.

import type { SlipSelection } from "@oddzilla/types";

interface MatchInput {
  id: string;
  homeTeam: string;
  awayTeam: string;
  matchWinner: {
    marketId: string;
    home: { outcomeId: string; price: string | null; probability?: string | null };
    away: { outcomeId: string; price: string | null; probability?: string | null };
  } | null;
  sport: { slug: string; name: string };
}

export interface ThreeFoldLeg extends SlipSelection {
  pickedSide: "home" | "away";
}

export interface ThreeFoldSuggestion {
  legs: ThreeFoldLeg[];
  combinedOdds: string;
}

export type TierKey = "safe" | "challenging" | "risky" | "ultimate";

export type ThreeFoldSuggestions = Partial<Record<TierKey, ThreeFoldSuggestion>>;

interface TierBand {
  lo: number;
  hi: number;
  target: number;
  legAllowed: (oddsNum: number) => boolean;
}

const TIER_BANDS: Record<TierKey, TierBand> = {
  safe: {
    lo: 2.0,
    hi: 3.0,
    target: 2.5,
    legAllowed: (o) => o > 1.0 && o < 1.5,
  },
  challenging: {
    lo: 3.0,
    hi: 5.0,
    target: 4.0,
    legAllowed: (o) => o >= 1.5,
  },
  risky: {
    lo: 5.0,
    hi: 10.0,
    target: 7.0,
    legAllowed: (o) => o > 1.8,
  },
  ultimate: {
    lo: 10.0,
    hi: 100.0,
    target: 15.0,
    legAllowed: (o) => o > 2.0,
  },
};

// Cap the per-tier candidate pool. C(30,3) × 2-side picks = 32 480 ops
// per tier — still trivial across 4 tiers per request.
const POOL_CAP = 30;

function buildLeg(
  match: MatchInput,
  side: "home" | "away",
  marketLabel: string,
): ThreeFoldLeg | null {
  if (!match.matchWinner) return null;
  const o = match.matchWinner[side];
  if (!o.price) return null;
  const oddsNum = Number.parseFloat(o.price);
  if (!Number.isFinite(oddsNum) || oddsNum <= 1.0) return null;
  return {
    matchId: match.id,
    marketId: match.matchWinner.marketId,
    outcomeId: o.outcomeId,
    odds: o.price,
    probability: o.probability ?? undefined,
    homeTeam: match.homeTeam,
    awayTeam: match.awayTeam,
    marketLabel,
    outcomeLabel: side === "home" ? match.homeTeam : match.awayTeam,
    sportSlug: match.sport.slug,
    pickedSide: side,
  };
}

interface QualSide {
  selection: ThreeFoldLeg;
  oddsNum: number;
}

interface QualMatch {
  matchId: string;
  sides: QualSide[];
}

function dedupeMatches(matches: MatchInput[]): MatchInput[] {
  const seen = new Set<string>();
  const out: MatchInput[] = [];
  for (const m of matches) {
    if (seen.has(m.id)) continue;
    seen.add(m.id);
    out.push(m);
  }
  return out;
}

function qualifyForTier(matches: MatchInput[], band: TierBand, marketLabel: string): QualMatch[] {
  const out: QualMatch[] = [];
  for (const m of matches) {
    const sides: QualSide[] = [];
    for (const side of ["home", "away"] as const) {
      const leg = buildLeg(m, side, marketLabel);
      if (!leg) continue;
      const oddsNum = Number.parseFloat(leg.odds);
      if (!Number.isFinite(oddsNum)) continue;
      if (!band.legAllowed(oddsNum)) continue;
      sides.push({ selection: leg, oddsNum });
    }
    if (sides.length > 0) out.push({ matchId: m.id, sides });
  }
  return out;
}

function formatCombinedOdds(n: number): string {
  return (Math.floor(n * 100) / 100).toFixed(2);
}

interface PickedTriple {
  legs: ThreeFoldLeg[];
  product: number;
}

function pickForTier(
  matches: MatchInput[],
  band: TierBand,
  excludeMatchIds: ReadonlySet<string>,
  marketLabel: string,
): PickedTriple | null {
  const qualifying = qualifyForTier(matches, band, marketLabel);

  // Try disjoint pool first; fall back to allowing reuse only if no
  // combo lands in band. With dense data we usually fill all 4 tiers
  // disjointly; sparse data may force reuse rather than dropping a card.
  const pools: QualMatch[][] = [
    qualifying.filter((q) => !excludeMatchIds.has(q.matchId)),
    qualifying,
  ];

  // Each leg's "ideal odds" is the cube root of the band target — sorting
  // matches by how close their best qualifying side is to that ideal
  // surfaces the combos most likely to land near target first.
  const targetPerLeg = Math.cbrt(
    Number.isFinite(band.target) ? band.target : band.lo + 5,
  );

  for (const pool of pools) {
    if (pool.length < 3) continue;

    const ranked = [...pool].sort((a, b) => {
      const da = Math.min(...a.sides.map((s) => Math.abs(s.oddsNum - targetPerLeg)));
      const db = Math.min(...b.sides.map((s) => Math.abs(s.oddsNum - targetPerLeg)));
      if (da !== db) return da - db;
      return a.matchId.localeCompare(b.matchId);
    });
    const capped = ranked.slice(0, POOL_CAP);

    let best: PickedTriple | null = null;
    let bestDelta = Infinity;
    for (let i = 0; i < capped.length; i++) {
      const a = capped[i]!;
      for (let j = i + 1; j < capped.length; j++) {
        const b = capped[j]!;
        for (let k = j + 1; k < capped.length; k++) {
          const c = capped[k]!;
          for (const sa of a.sides) {
            for (const sb of b.sides) {
              for (const sc of c.sides) {
                const product = sa.oddsNum * sb.oddsNum * sc.oddsNum;
                if (product < band.lo || product >= band.hi) continue;
                const delta = Math.abs(product - band.target);
                if (delta < bestDelta) {
                  bestDelta = delta;
                  best = {
                    legs: [sa.selection, sb.selection, sc.selection],
                    product,
                  };
                }
              }
            }
          }
        }
      }
    }
    if (best) return best;
  }
  return null;
}

export function buildThreeFoldSuggestions(
  matches: MatchInput[],
  marketLabel: string,
): ThreeFoldSuggestions {
  const deduped = dedupeMatches(matches);
  if (deduped.length < 3) return {};

  const used = new Set<string>();
  const out: ThreeFoldSuggestions = {};

  for (const tier of ["safe", "challenging", "risky", "ultimate"] as const) {
    const picked = pickForTier(deduped, TIER_BANDS[tier], used, marketLabel);
    if (!picked) continue;
    out[tier] = {
      legs: picked.legs,
      combinedOdds: formatCombinedOdds(picked.product),
    };
    for (const leg of picked.legs) used.add(leg.matchId);
  }

  return out;
}
