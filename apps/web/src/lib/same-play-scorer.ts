// Apply Same Play scorer.
//
// Pure, deterministic function that ranks an upcoming-match candidate
// against the originator of a winning bet. Implements the table in
// the "Big wins section" PRD (Notion 31364f04f9b48103a1bce000da4baadc):
//
//   Base                                            50
//   Same market + selection            "Same market"        +25
//   Different market                   "Different market"   −30
//   Same team in this fixture          "Same team"          +15
//   Same league tier                   "Same tier (X)"      +10
//   Tier gap ≥ 2                       "Lower tier league"   −5
//   Picked-side role match             "Both …"             +8
//   Picked-side role mismatch          "Different role"     −8
//   Odds within 12%                    "Odds within N%"     +12
//   Odds delta ≥ 25%                   "Odds up/down N%"    −15
//   Kickoff ≤ 2 h                      "Starts soon"         −4
//   Market suspended                   "Market suspended"   −50
//
//   Cross-sport candidates           filtered out
//   Literal mode without team match  filtered out
//
// The score is clamped to [0, 100] and rounded. It is a *sort key*,
// not a number we ask users to trust on its own — the chips and
// score-breakdown popover do the explaining.
//
// V1 caveats:
//   • The candidate query restricts to same provider_market_id +
//     outcome_id matches, so the "Different market" branch can't
//     fire. Kept in the type union for completeness; never returned
//     by this scorer.
//   • leagueTier may be null on either side until tournaments are
//     backfilled; both same-tier and tier-gap reasons skip in that
//     case rather than guessing.

import type {
  SamePlayCandidate,
  SamePlayOriginator,
  SamePlayRole,
} from "@oddzilla/types";

export type ApplySamePlayMode = "literal" | "analogical";

// Reason chip kind. The set is closed — the UI maps each kind to a
// short label and a long-form explanation in one place. Keep this
// list in sync with the PRD's reason table.
export type SamePlayReasonKind =
  | "same_market"
  | "different_market"
  | "same_team"
  | "same_tier"
  | "tier_gap"
  | "role_match"
  | "role_mismatch"
  | "odds_close"
  | "odds_drift"
  | "kickoff_soon"
  | "suspended";

export type SamePlayReasonSentiment = "positive" | "negative" | "neutral";

export interface SamePlayReason {
  kind: SamePlayReasonKind;
  sentiment: SamePlayReasonSentiment;
  // Numeric context the UI splices into the chip / popover copy.
  // E.g. odds_close.percent = 7 → "Odds within 7%". Optional —
  // chips like "Same market" carry no payload.
  payload?: {
    percent?: number;
    tier?: number;
    role?: SamePlayRole;
    direction?: "up" | "down";
  };
}

export interface SamePlayScoreResult {
  // Sort key, [0, 100]. Filtered candidates return null upstream.
  score: number;
  // Order matches the PRD's "stable ordering" rule: market → team →
  // tier → role → odds → kickoff → suspended.
  reasons: SamePlayReason[];
}

// Thresholds. Surface as constants so the test suite and the
// score-breakdown popover read from the same source of truth.
export const SAME_PLAY_THRESHOLDS = {
  baseScore: 50,
  oddsCloseFraction: 0.12, // |Δ| ≤ 12% → +12
  oddsDriftFraction: 0.25, // |Δ| ≥ 25% → −15
  kickoffImminentHours: 2,
  tierGapForPenalty: 2,
} as const;

// Filter-then-score entry point. Returns null when the candidate
// fails a hard filter (cross-sport, or Literal mode with no team
// match). Returning null over a sentinel score keeps the caller's
// "drop from list" path obvious.
export function scoreCandidate(
  originator: SamePlayOriginator,
  candidate: SamePlayCandidate,
  mode: ApplySamePlayMode,
): SamePlayScoreResult | null {
  // Cross-sport candidates are dropped at the SQL layer; this is the
  // belt-and-braces check. Compares slug-to-slug because the originator
  // carries `sportId` and the candidate carries `sportSlug` — neither
  // identifies the sport on its own without a lookup, but the BE
  // populates them from the same row, so this assertion holds whenever
  // the BE is healthy. Skipping the check entirely would let a
  // misconfigured response slip through silently.
  // (No-op in V1 — kept here for the hard-filter shape.)

  const sameTeam = candidateSharesTeam(originator, candidate);
  if (mode === "literal" && !sameTeam) return null;

  const reasons: SamePlayReason[] = [];
  let score = SAME_PLAY_THRESHOLDS.baseScore;

  // 1. Market identity. V1 BE only emits same-market candidates, so
  // this always fires. Left as a branch for forward compatibility
  // when "different market" candidates eventually ship.
  reasons.push({ kind: "same_market", sentiment: "positive" });
  score += 25;

  // 2. Team overlap. Skipped entirely when there's no overlap —
  // absence isn't a penalty (Analogical mode is meant to find the
  // structurally similar match, which usually means *different*
  // teams).
  if (sameTeam) {
    reasons.push({ kind: "same_team", sentiment: "positive" });
    score += 15;
  }

  // 3. League tier proximity. Both null → skip (don't assume).
  if (originator.leagueTier !== null && candidate.leagueTier !== null) {
    const gap = Math.abs(originator.leagueTier - candidate.leagueTier);
    if (gap === 0) {
      reasons.push({
        kind: "same_tier",
        sentiment: "positive",
        payload: { tier: originator.leagueTier },
      });
      score += 10;
    } else if (gap >= SAME_PLAY_THRESHOLDS.tierGapForPenalty) {
      reasons.push({ kind: "tier_gap", sentiment: "neutral" });
      score -= 5;
    }
  }

  // 4. Role match. Always fires — every priced selection has a
  // derived role (favorite / underdog / even), so the comparison
  // is well-defined. Tint is positive on match, negative on
  // mismatch; "even vs even" counts as match.
  if (originator.teams.pickedRole === candidate.role) {
    reasons.push({
      kind: "role_match",
      sentiment: "positive",
      payload: { role: candidate.role },
    });
    score += 8;
  } else {
    reasons.push({ kind: "role_mismatch", sentiment: "negative" });
    score -= 8;
  }

  // 5. Odds proximity. Computed as |new − orig| / orig so the
  // threshold reads the same regardless of which side of the
  // original we landed on. Drift sign goes into the chip payload
  // so the UI can render an arrow.
  const origOdds = parseFloat(originator.originalOdds);
  const candOdds = parseFloat(candidate.currentOdds);
  if (origOdds > 0 && candOdds > 0) {
    const delta = (candOdds - origOdds) / origOdds;
    const absDelta = Math.abs(delta);
    if (absDelta <= SAME_PLAY_THRESHOLDS.oddsCloseFraction) {
      reasons.push({
        kind: "odds_close",
        sentiment: "positive",
        payload: { percent: Math.round(absDelta * 100) },
      });
      score += 12;
    } else if (absDelta >= SAME_PLAY_THRESHOLDS.oddsDriftFraction) {
      reasons.push({
        kind: "odds_drift",
        sentiment: "negative",
        payload: {
          percent: Math.round(absDelta * 100),
          direction: delta >= 0 ? "up" : "down",
        },
      });
      score -= 15;
    }
  }

  // 6. Kickoff imminence. Neutral sentiment in the PRD because the
  // user's reading of "starts soon" is a heads-up, not a downgrade
  // — but the score still drops a touch since same-play hesitation
  // around imminent kickoff is real (price moves, odds drift, etc).
  if (candidate.hoursToKickoff <= SAME_PLAY_THRESHOLDS.kickoffImminentHours) {
    reasons.push({ kind: "kickoff_soon", sentiment: "neutral" });
    score -= 4;
  }

  // 7. Suspended market. Heaviest penalty by design — a suspended
  // market is uncopyable until it reopens. The Copy CTA is also
  // disabled by the row-state machine; this just sinks the row to
  // the bottom of the list.
  if (candidate.suspended) {
    reasons.push({ kind: "suspended", sentiment: "negative" });
    score -= 50;
  }

  return {
    score: Math.round(Math.max(0, Math.min(100, score))),
    reasons,
  };
}

// Convenience wrapper: filter to scored candidates and sort.
// Maintains a stable secondary sort by hoursToKickoff so equal-score
// candidates render closest-to-kickoff first — the user's bias for
// "the next one" beats arbitrary database order.
export function rankCandidates(
  originator: SamePlayOriginator,
  candidates: SamePlayCandidate[],
  mode: ApplySamePlayMode,
): Array<{ candidate: SamePlayCandidate; result: SamePlayScoreResult }> {
  const scored: Array<{
    candidate: SamePlayCandidate;
    result: SamePlayScoreResult;
  }> = [];
  for (const c of candidates) {
    const result = scoreCandidate(originator, c, mode);
    if (result === null) continue;
    scored.push({ candidate: c, result });
  }
  scored.sort((a, b) => {
    if (b.result.score !== a.result.score) {
      return b.result.score - a.result.score;
    }
    return a.candidate.hoursToKickoff - b.candidate.hoursToKickoff;
  });
  return scored;
}

// ─── Stake conversion ──────────────────────────────────────────────────────
//
// Three modes (PRD §"Stake conversion"):
//   • same     — copy the originator's stake verbatim. Most honest
//                about "same play"; profit profile shifts with odds.
//   • target   — solve for the stake that matches the original
//                profit at the new odds. Predictable profit, can
//                balloon when odds drop a lot.
//   • suggest  — damped target, clamped to [0.5×, 1.5×] of the
//                originator's stake. Default in V1; matches the
//                "feels like the same play" intuition.

export type ApplySamePlayStakeMode = "same" | "target" | "suggest";

export const SUGGEST_STAKE_CLAMP = { min: 0.5, max: 1.5 } as const;

// All inputs are decimal strings — the wire format. Returns a
// decimal string with 6-micro precision (matching fromMicro).
export function adaptStake(
  originalStakeMicro: string,
  originalOdds: string,
  newOdds: string,
  mode: ApplySamePlayStakeMode,
): string {
  const stake = BigInt(originalStakeMicro);
  if (mode === "same") return stake.toString();

  const orig = parseFloat(originalOdds);
  const next = parseFloat(newOdds);
  // Odds < 1 are nonsensical for decimal pricing; fall through to
  // same-stake rather than dividing by zero or producing a nominal
  // negative. Display layer warns; this layer just returns a safe
  // value.
  if (!Number.isFinite(orig) || !Number.isFinite(next) || orig <= 1 || next <= 1) {
    return stake.toString();
  }

  // Target = stake × (orig − 1) / (next − 1). Multiplied by a
  // 1_000_000-scaled bigint factor to preserve micro precision
  // without floating-point drift on the stake field itself.
  const factor = (orig - 1) / (next - 1);
  if (mode === "target") {
    return scaleMicro(stake, factor);
  }

  // suggest — same as target but clamped to [0.5×, 1.5×].
  const clamped = Math.max(
    SUGGEST_STAKE_CLAMP.min,
    Math.min(SUGGEST_STAKE_CLAMP.max, factor),
  );
  return scaleMicro(stake, clamped);
}

function scaleMicro(stake: bigint, factor: number): string {
  // Round to nearest micro to keep the result on the same grid as
  // the originator stake; truncating biases the user low.
  const SCALE = 1_000_000n;
  const scaled = Math.round(factor * 1_000_000);
  const result = (stake * BigInt(scaled)) / SCALE;
  return result.toString();
}

// ─── Min-odds floor ────────────────────────────────────────────────────────

// Default = floor(0.8 × original_odds, 0.05), clamped at 1.10. The
// 0.05 grid matches how prices are typically quoted; 1.10 is the
// floor below which "best price" loses meaning (most books won't
// quote tighter than that on competitive lines).
export function defaultMinOdds(originalOdds: string): string {
  const orig = parseFloat(originalOdds);
  if (!Number.isFinite(orig) || orig <= 1) return "1.10";
  const floored = Math.floor((orig * 0.8) / 0.05) * 0.05;
  const clamped = Math.max(1.1, floored);
  return clamped.toFixed(2);
}

// ─── Helpers ───────────────────────────────────────────────────────────────

function candidateSharesTeam(
  originator: SamePlayOriginator,
  candidate: SamePlayCandidate,
): boolean {
  const origIds = [
    originator.teams.homeCompetitorId,
    originator.teams.awayCompetitorId,
  ].filter((x): x is number => x !== null);
  const candIds = [candidate.homeCompetitorId, candidate.awayCompetitorId].filter(
    (x): x is number => x !== null,
  );
  for (const id of origIds) {
    if (candIds.includes(id)) return true;
  }
  // Fallback to name matching when competitor IDs are missing on
  // either side. Case-insensitive; Oddin team names are
  // canonicalised but a stray "FC Bayern München" vs "Bayern
  // Munich" still slips through. The ID match above is the
  // production path; this is for the few rows that haven't been
  // mapped yet.
  const names = new Set(
    [
      originator.teams.home,
      originator.teams.away,
      candidate.homeTeam,
      candidate.awayTeam,
    ].map((s) => s.toLowerCase().trim()),
  );
  // If all four normalise distinct, no name overlap. The set's
  // size shrinks below 4 only when at least two names match.
  return names.size < 4;
}

// Coarse role inference from a moneyline-style price. Used by the
// BE to label the originator and each candidate; reused here so
// tests can drive the same heuristic without round-tripping the
// API. Thresholds follow common sportsbook intuition: < 1.8 is the
// favourite, > 2.4 is the underdog, in between is "even".
export function inferRole(odds: string | number): SamePlayRole {
  const n = typeof odds === "string" ? parseFloat(odds) : odds;
  if (!Number.isFinite(n)) return "even";
  if (n < 1.8) return "favorite";
  if (n > 2.4) return "underdog";
  return "even";
}
