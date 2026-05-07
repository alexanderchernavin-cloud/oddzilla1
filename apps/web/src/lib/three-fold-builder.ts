// Builds three "suggested 3-fold" parlays for the lobby promo cards by
// scanning the live + upcoming match pool and picking three match-winner
// legs whose combined decimal odds land in each tier band:
//   safe        [2.00, 3.00)
//   challenging [3.00, 5.00)
//   ultimate    [5.00, ∞)
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

export type TierKey = "safe" | "challenging" | "ultimate";

export type ThreeFoldSuggestions = Partial<Record<TierKey, ThreeFoldSuggestion>>;

const TIER_BANDS: Record<TierKey, { lo: number; hi: number; target: number }> = {
  safe: { lo: 2.0, hi: 3.0, target: 2.5 },
  challenging: { lo: 3.0, hi: 5.0, target: 4.0 },
  ultimate: { lo: 5.0, hi: Infinity, target: 7.5 },
};

// Cap pool to the matches with the lowest favorite-odds. C(30,3)=4060,
// C(40,3)=9880 — both trivial. Bigger caps just dilute the suggestions
// with low-quality matches that nobody would pick.
const POOL_CAP = 30;

interface CandidateMatch {
  matchId: string;
  fav: { selection: ThreeFoldLeg; oddsNum: number };
  dog: { selection: ThreeFoldLeg; oddsNum: number };
}

function buildLeg(match: MatchInput, side: "home" | "away"): ThreeFoldLeg | null {
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
    marketLabel: "Match winner",
    outcomeLabel: side === "home" ? match.homeTeam : match.awayTeam,
    sportSlug: match.sport.slug,
    pickedSide: side,
  };
}

function buildCandidates(matches: MatchInput[]): CandidateMatch[] {
  const out: CandidateMatch[] = [];
  const seen = new Set<string>();
  for (const m of matches) {
    if (seen.has(m.id)) continue;
    seen.add(m.id);
    const home = buildLeg(m, "home");
    const away = buildLeg(m, "away");
    if (!home || !away) continue;
    const homeNum = Number.parseFloat(home.odds);
    const awayNum = Number.parseFloat(away.odds);
    const homeIsFav = homeNum <= awayNum;
    out.push({
      matchId: m.id,
      fav: {
        selection: homeIsFav ? home : away,
        oddsNum: homeIsFav ? homeNum : awayNum,
      },
      dog: {
        selection: homeIsFav ? away : home,
        oddsNum: homeIsFav ? awayNum : homeNum,
      },
    });
  }
  out.sort((a, b) => {
    const d = a.fav.oddsNum - b.fav.oddsNum;
    if (d !== 0) return d;
    return a.matchId.localeCompare(b.matchId);
  });
  return out.slice(0, POOL_CAP);
}

function formatCombinedOdds(n: number): string {
  return (Math.floor(n * 100) / 100).toFixed(2);
}

// 4 plausible leg-mixes per combo: all favorites, two favorites + one
// underdog, etc. Skipping a few rarer mixes (e.g. fav-dog-fav) is fine
// because we permute the combo position itself via i<j<k iteration.
const LEG_MIXES: Array<readonly [0 | 1, 0 | 1, 0 | 1]> = [
  [0, 0, 0],
  [0, 0, 1],
  [0, 1, 1],
  [1, 1, 1],
];

interface PickedTriple {
  legs: ThreeFoldLeg[];
  product: number;
}

function pickForTier(
  candidates: CandidateMatch[],
  band: { lo: number; hi: number; target: number },
  excludeMatchIds: ReadonlySet<string>,
): PickedTriple | null {
  // Try disjoint pool first; fall back to allowing reuse if no combo
  // lands in band. With ≥ 9 candidates we usually fill all 3 tiers
  // disjointly; sparse data may force reuse rather than dropping a card.
  const pools: CandidateMatch[][] = [
    candidates.filter((c) => !excludeMatchIds.has(c.matchId)),
    candidates,
  ];
  for (const pool of pools) {
    if (pool.length < 3) continue;
    let best: PickedTriple | null = null;
    let bestDelta = Infinity;
    for (let i = 0; i < pool.length; i++) {
      for (let j = i + 1; j < pool.length; j++) {
        for (let k = j + 1; k < pool.length; k++) {
          const a = pool[i]!;
          const b = pool[j]!;
          const c = pool[k]!;
          for (const mix of LEG_MIXES) {
            const aSide = mix[0] === 0 ? a.fav : a.dog;
            const bSide = mix[1] === 0 ? b.fav : b.dog;
            const cSide = mix[2] === 0 ? c.fav : c.dog;
            const product = aSide.oddsNum * bSide.oddsNum * cSide.oddsNum;
            if (product < band.lo || product >= band.hi) continue;
            const delta = Math.abs(product - band.target);
            if (delta < bestDelta) {
              bestDelta = delta;
              best = {
                legs: [aSide.selection, bSide.selection, cSide.selection],
                product,
              };
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
): ThreeFoldSuggestions {
  const candidates = buildCandidates(matches);
  if (candidates.length < 3) return {};

  const used = new Set<string>();
  const out: ThreeFoldSuggestions = {};

  for (const tier of ["safe", "challenging", "ultimate"] as const) {
    const picked = pickForTier(candidates, TIER_BANDS[tier], used);
    if (!picked) continue;
    out[tier] = {
      legs: picked.legs,
      combinedOdds: formatCombinedOdds(picked.product),
    };
    for (const leg of picked.legs) used.add(leg.matchId);
  }

  return out;
}
