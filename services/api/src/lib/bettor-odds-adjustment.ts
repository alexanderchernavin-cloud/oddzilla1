// Per-bettor odds adjustment — cascade resolver + apply helpers.
//
// Design follows migration 0070_bettor_odds_adjustment.sql:
//
//   - One row per (user, scope, ref). Cascade order at the read site is
//     match > tournament > sport > global; first non-NULL override wins.
//   - The persisted bp delta multiplies the published odds. Positive bp
//     → bettor sees higher odds (operator gives up margin); negative bp
//     → bettor sees lower odds (operator widens margin).
//   - Two clamps after the multiply:
//       high = 1/probability  (fair odds; operator can't accidentally
//                              give the bettor +EV money). Skipped
//                              silently when the outcome has no
//                              probability column (legacy markets).
//       low  = ADJUSTED_ODDS_FLOOR (decimal 1.001 — a negative bp can
//                              mathematically push raw 1.02 below 1.0,
//                              which is nonsense as a bettor-facing
//                              price. The floor keeps the displayed
//                              odds in the "you still win something on
//                              a win" range.)
//
// Storage convention: the catalog response renders publishedOdds at up
// to 4dp with trailing zeros trimmed down to a 2dp minimum — same shape
// formatOdds() produces, so downstream code (slip, drift checks, charts)
// receives byte-identical strings.

import { eq } from "drizzle-orm";
import type { DbClient } from "@oddzilla/db";
import { bettorOddsAdjustmentConfig } from "@oddzilla/db";
import { quoteOnLadder } from "@oddzilla/types/odds";

// Lowest decimal price an adjusted outcome may show to a bettor. A
// negative bp on near-1.0 raw odds can mathematically dip below 1.0
// (e.g. 1.02 × 0.97 ≈ 0.99), which would mean a winning ticket pays
// less than the stake. The bet-delay Go mirror and the ws-gateway TS
// mirror must use the same constant so drift comparison + live ticks
// match the catalog response byte-for-byte.
export const ADJUSTED_ODDS_FLOOR = 1.001;

// The placement transaction needs to call this helper inside its tx so
// admin writes mid-placement don't change the cascade between the lock
// and the validation. Mirror the bets module's DbClient | TxHandle
// pattern.
type TxHandle = Parameters<Parameters<DbClient["transaction"]>[0]>[0];

export interface BettorAdjustmentCascade {
  // null = no global row on this user. 0 is a *real* row that an admin
  // pinned at exactly zero (e.g. to make a per-sport boost the only
  // visible behaviour); we keep it distinct because it short-circuits
  // the cascade for non-overridden sports.
  globalBp: number | null;
  bySport: Map<number, number>;
  byTournament: Map<number, number>;
  byMatch: Map<string, number>; // matchId stringified to dodge bigint Map quirks
  empty: boolean;
}

export const EMPTY_CASCADE: BettorAdjustmentCascade = Object.freeze({
  globalBp: null,
  bySport: new Map(),
  byTournament: new Map(),
  byMatch: new Map(),
  empty: true,
}) as BettorAdjustmentCascade;

// Load every override row for one user in a single round-trip. Hot path
// — every authed /catalog/* request runs this once. The expected row
// count per user is small (typically 0-4), well within the partial
// unique indexes' coverage.
export async function loadBettorAdjustmentCascade(
  db: DbClient | TxHandle,
  userId: string,
): Promise<BettorAdjustmentCascade> {
  const rows = await db
    .select({
      scope: bettorOddsAdjustmentConfig.scope,
      sportId: bettorOddsAdjustmentConfig.sportId,
      tournamentId: bettorOddsAdjustmentConfig.tournamentId,
      matchId: bettorOddsAdjustmentConfig.matchId,
      adjustmentBp: bettorOddsAdjustmentConfig.adjustmentBp,
    })
    .from(bettorOddsAdjustmentConfig)
    .where(eq(bettorOddsAdjustmentConfig.userId, userId));

  if (rows.length === 0) return EMPTY_CASCADE;

  const cascade: BettorAdjustmentCascade = {
    globalBp: null,
    bySport: new Map(),
    byTournament: new Map(),
    byMatch: new Map(),
    empty: false,
  };
  for (const r of rows) {
    switch (r.scope) {
      case "global":
        cascade.globalBp = r.adjustmentBp;
        break;
      case "sport":
        if (r.sportId !== null) cascade.bySport.set(r.sportId, r.adjustmentBp);
        break;
      case "tournament":
        if (r.tournamentId !== null)
          cascade.byTournament.set(r.tournamentId, r.adjustmentBp);
        break;
      case "match":
        if (r.matchId !== null)
          cascade.byMatch.set(r.matchId.toString(), r.adjustmentBp);
        break;
    }
  }
  return cascade;
}

// Resolve the effective adjustment bp for a single match. Cheap (4
// hash-map probes worst case) and tolerant of null IDs — when the
// caller doesn't know the sport/tournament (e.g. on a legacy market
// not joined to either), we just skip those tiers and fall through.
//
// Returns 0 when no row applies — the caller treats that as a no-op.
export function resolveBettorAdjustmentBp(
  cascade: BettorAdjustmentCascade,
  ids: {
    matchId?: bigint | string | null;
    tournamentId?: number | null;
    sportId?: number | null;
  },
): number {
  if (cascade.empty) return 0;
  if (ids.matchId != null) {
    const key =
      typeof ids.matchId === "bigint" ? ids.matchId.toString() : String(ids.matchId);
    const hit = cascade.byMatch.get(key);
    if (hit !== undefined) return hit;
  }
  if (ids.tournamentId != null) {
    const hit = cascade.byTournament.get(ids.tournamentId);
    if (hit !== undefined) return hit;
  }
  if (ids.sportId != null) {
    const hit = cascade.bySport.get(ids.sportId);
    if (hit !== undefined) return hit;
  }
  return cascade.globalBp ?? 0;
}

// Apply the bp delta to a raw decimal-odds string and render at up to
// 4dp with trailing zeros trimmed to a 2dp minimum. Mirrors formatOdds()
// and odds-publisher's representation so downstream consumers (slip
// drift, charts, audit log) see byte-identical strings.
//
// `probability` is the outcome's published probability ([0, 1] decimal
// string) when known — used for the fair-odds ceiling. Pass null when
// the column is empty (legacy / OBB markets); the clamp degrades
// gracefully.
//
// Adjusted odds are clamped to [ADJUSTED_ODDS_FLOOR, 1/probability]. The
// DB-level CHECK on adjustment_bp keeps the multiplier in (-90%, +90%)
// so the float math stays well within float64 territory; the low floor
// catches the geometric case where a small negative bp on near-1.0 raw
// odds dips below 1.0.
export function applyBettorAdjustment(
  rawOdds: string | null,
  probability: string | null | undefined,
  bp: number,
): string | null {
  if (rawOdds == null) return null;
  const raw = Number.parseFloat(rawOdds);
  if (!Number.isFinite(raw) || raw <= 0) {
    // Best-effort passthrough for unparseable inputs.
    return formatOddsTrim(rawOdds);
  }
  if (bp === 0) return formatOddsTrimNum(raw);

  let adjusted = raw * (1 + bp / 10000);

  // Fair-odds ceiling — the "can't go below zero margin" guarantee the
  // operator asked for. If probability is missing or out of range we
  // skip silently rather than reject the row.
  if (probability != null) {
    const p = Number.parseFloat(probability);
    if (Number.isFinite(p) && p > 0 && p < 1) {
      const fair = 1 / p;
      if (adjusted > fair) adjusted = fair;
    }
  }

  if (adjusted < ADJUSTED_ODDS_FLOOR) adjusted = ADJUSTED_ODDS_FLOOR;

  return formatOddsTrimNum(adjusted);
}

// Render a decimal-odds string at up to 4dp with trailing zeros trimmed
// to a 2dp minimum. Shared shape with catalog/routes.ts formatOdds and
// the Go formatPublishedOdds — every layer in the pipeline produces the
// same string for the same numeric value.
function formatOddsTrim(s: string): string {
  const n = Number.parseFloat(s);
  if (!Number.isFinite(n)) return s;
  return formatOddsTrimNum(n);
}

// Floor-truncate to 4dp with an epsilon nudge to absorb float64
// round-down artefacts (1.0034 stored as 1.00339999...e). Matches the
// publisher's big.Float scaled-to-Int convention byte-for-byte. The
// 1e-6 epsilon is in the *10000 scaled domain — 1e-10 in raw odds, far
// below NUMERIC(10,4) resolution.
function formatOddsTrimNum(n: number): string {
  if (!Number.isFinite(n)) return String(n);
  // Negative odds make no sense; bail before the ladder, which reports a
  // non-positive price as 0 and would otherwise render it as "0.00".
  if (n < 0) return n.toFixed(2);
  // Ladder first. The adjustment multiplies a laddered published price by
  // (1 + bp/10000), which lands off the rungs again, so this is the step
  // that keeps an adjusted price the same SHAPE of number as an
  // unadjusted one — and, because this is the drift reference the
  // bet-delay worker compares against, keeps display and drift in step.
  const units = Math.floor(quoteOnLadder(n) * 10000 + 1e-6);
  if (units < 0) {
    // Negative odds make no sense; fall back to a tolerable representation.
    return n.toFixed(2);
  }
  const intP = Math.floor(units / 10000);
  const frac = units % 10000;
  const padded = `${intP}.${frac.toString().padStart(4, "0")}`;
  return padded.replace(/(\.\d{2})(\d*?)0+$/, "$1$2");
}
