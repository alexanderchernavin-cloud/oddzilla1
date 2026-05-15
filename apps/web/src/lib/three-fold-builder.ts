// ComboZilla builder. Picks four ready-to-bet 3-fold parlays from the
// upcoming pool, one per "tier" tag. Per-leg / per-combo gates:
//
//   safe        legs in [boostMin, 2.0)  →  combined [boostMin³, 5.00)
//   challenging legs >= boostMin         →  combined [5.00, 10.00)
//   risky       legs >  max(boostMin,1.8)→  combined [10.00, 20.00)
//   ultimate    legs >  max(boostMin,2.0)→  combined [20.00, 100.00)
//
// `boostMin` is the live Combi Boost minimum-odds gate
// (`/catalog/combi-boost-config.minOdds`, default 1.5). Every leg in
// every ComboZilla combo MUST clear this floor — otherwise the card
// would be selling a discount the engine won't honour, since the
// Combi Boost only applies to legs above the configured minOdds.
//
// Other hard constraints:
//   - Every leg must come from a Tier 1-3 match (tournament.risk_tier
//     in {1,2,3}); unranked / higher-tier matches are dropped first.
//   - All three legs of any one combo must share the same sport.
//
// Surviving legs join the tier's candidate pool; we enumerate up to
// C(POOL_CAP, 3) triples per sport and keep the combo whose combined
// product is closest to the band target. Pure & deterministic: same
// (matches, marketLabel, boostMinOdds) → same output. Runs server-
// side from the home page render.

import type { SlipSelection } from "@oddzilla/types";
import { COMBI_BOOST_MIN_ODDS } from "@oddzilla/types/combi-boost";

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
  tournament?: { riskTier?: number | null };
}

export interface ThreeFoldLeg extends SlipSelection {
  pickedSide: "home" | "away";
}

export interface ThreeFoldSuggestion {
  legs: ThreeFoldLeg[];
  combinedOdds: string;
  /** Sport slug shared by all three legs. Same-sport is a hard requirement. */
  sportSlug: string;
  /** Display name for the shared sport. */
  sportName: string;
}

export type TierKey = "safe" | "challenging" | "risky" | "ultimate";

export const TIER_ORDER: readonly TierKey[] = [
  "safe",
  "challenging",
  "risky",
  "ultimate",
] as const;

export type ThreeFoldSuggestions = Partial<Record<TierKey, ThreeFoldSuggestion>>;

interface TierBand {
  lo: number;
  hi: number;
  target: number;
  legAllowed: (oddsNum: number) => boolean;
}

function buildTierBands(boostMin: number): Record<TierKey, TierBand> {
  // boostMin = 1.5 by default → minProduct = 3.375. Safe sits in the
  // [3.4, 5.0) band so it still feels like a "favourites combo" given
  // that floor; the remaining tiers shift up to make room.
  const minProduct = boostMin ** 3;
  return {
    safe: {
      lo: Math.max(3.0, minProduct),
      hi: 5.0,
      target: 4.0,
      legAllowed: (o) => o >= boostMin && o < 2.0,
    },
    challenging: {
      lo: 5.0,
      hi: 10.0,
      target: 7.0,
      legAllowed: (o) => o >= boostMin,
    },
    risky: {
      lo: 10.0,
      hi: 20.0,
      target: 14.0,
      legAllowed: (o) => o > Math.max(boostMin, 1.8),
    },
    ultimate: {
      lo: 20.0,
      hi: 100.0,
      target: 30.0,
      legAllowed: (o) => o > Math.max(boostMin, 2.0),
    },
  };
}

// Cap the per-tier candidate pool. C(30,3) × 2-side picks = 32 480 ops
// per tier × per sport — still trivial across 4 tiers × ~6 active sports.
const POOL_CAP = 30;

// ComboZilla only surfaces flagship tournaments. Anything outside the
// 1-3 risk-tier band (4-10 or NULL) is dropped before tier selection.
const ELIGIBLE_RISK_TIERS = new Set<number>([1, 2, 3]);

function isTier1to3(m: MatchInput): boolean {
  const t = m.tournament?.riskTier ?? null;
  return t !== null && ELIGIBLE_RISK_TIERS.has(t);
}

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
  sportSlug: string;
  sportName: string;
}

function pickForTierInSport(
  matchesForSport: MatchInput[],
  band: TierBand,
  marketLabel: string,
  sportSlug: string,
  sportName: string,
): PickedTriple | null {
  const qualifying = qualifyForTier(matchesForSport, band, marketLabel);
  if (qualifying.length < 3) return null;

  const targetPerLeg = Math.cbrt(
    Number.isFinite(band.target) ? band.target : band.lo + 5,
  );

  const ranked = [...qualifying].sort((a, b) => {
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
                  sportSlug,
                  sportName,
                };
              }
            }
          }
        }
      }
    }
  }
  return best;
}

interface SportBucket {
  slug: string;
  name: string;
  matches: MatchInput[];
}

function groupBySport(matches: MatchInput[]): SportBucket[] {
  const map = new Map<string, SportBucket>();
  for (const m of matches) {
    const slug = m.sport.slug;
    const existing = map.get(slug);
    if (existing) existing.matches.push(m);
    else map.set(slug, { slug, name: m.sport.name, matches: [m] });
  }
  // Larger sport pools first — they give us better odds-density per
  // tier and so a higher chance of every tier landing within band.
  return [...map.values()].sort((a, b) => b.matches.length - a.matches.length);
}

export function buildThreeFoldSuggestions(
  matches: MatchInput[],
  marketLabel: string,
  // Live Combi Boost minimum-odds gate. Pass the value from
  // /catalog/combi-boost-config when the admin has tuned it; falls
  // back to the static default (1.5) so unit tests + early bootstrap
  // still produce output.
  boostMinOdds: number = COMBI_BOOST_MIN_ODDS,
): ThreeFoldSuggestions {
  const eligible = dedupeMatches(matches).filter(isTier1to3);
  if (eligible.length < 3) return {};

  const bands = buildTierBands(boostMinOdds);
  const sports = groupBySport(eligible);
  const out: ThreeFoldSuggestions = {};
  const usedMatchIds = new Set<string>();

  // Per-tier loop, per-sport inner loop. The first sport whose pool can
  // satisfy this tier wins it. Used match IDs are tracked across tiers
  // so the four cards don't reuse the same fixture; if a sport can't
  // provide three disjoint matches we fall through to its full pool.
  for (const tier of TIER_ORDER) {
    let picked: PickedTriple | null = null;
    for (const sport of sports) {
      // First pass: disjoint pool (no match already used by another tier).
      const disjoint = sport.matches.filter((m) => !usedMatchIds.has(m.id));
      picked = pickForTierInSport(
        disjoint,
        bands[tier],
        marketLabel,
        sport.slug,
        sport.name,
      );
      if (picked) break;
      // Fall back to the full sport pool, allowing reuse rather than
      // dropping the card. Same-sport invariant still holds.
      picked = pickForTierInSport(
        sport.matches,
        bands[tier],
        marketLabel,
        sport.slug,
        sport.name,
      );
      if (picked) break;
    }
    if (!picked) continue;
    out[tier] = {
      legs: picked.legs,
      combinedOdds: formatCombinedOdds(picked.product),
      sportSlug: picked.sportSlug,
      sportName: picked.sportName,
    };
    for (const leg of picked.legs) usedMatchIds.add(leg.matchId);
  }

  return out;
}
