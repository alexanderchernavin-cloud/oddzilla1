// Per-bettor odds adjustment — cascade resolver + apply helpers.
//
// Design follows migration 0068_bettor_odds_adjustment.sql:
//
//   - One row per (user, scope, ref). Cascade order at the read site is
//     match > tournament > sport > global; first non-NULL override wins.
//   - The persisted bp delta multiplies the published odds. Positive bp
//     → bettor sees higher odds (operator gives up margin); negative bp
//     → bettor sees lower odds (operator widens margin).
//   - Two clamps after the multiply:
//       low  = 1.01      (matches the odds-publisher floor — no useless
//                         "stake-back-only" quotes)
//       high = 1/probability  (fair odds; the floor the user asked for
//                              — operator can't accidentally give the
//                              bettor +EV money). Skipped silently when
//                              the outcome has no probability column
//                              (legacy markets without it).
//
// Storage convention: the catalog response keeps publishedOdds in the
// same 2-decimal floor-truncated form formatOdds() already produces, so
// downstream code (slip, drift checks, charts) stays unchanged.

import { eq } from "drizzle-orm";
import type { DbClient } from "@oddzilla/db";
import { bettorOddsAdjustmentConfig } from "@oddzilla/db";

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

// Apply the bp delta to a raw decimal-odds string and floor-truncate to
// 2 decimals. Mirrors formatOdds() / odds-publisher's representation so
// downstream consumers (slip drift, charts, audit log) see the same
// shape they always did.
//
// `probability` is the outcome's published probability ([0, 1] decimal
// string) when known — used for the fair-odds ceiling. Pass null when
// the column is empty (legacy / OBB markets); the clamp degrades
// gracefully.
//
// Floor at 1.01 (matches odds-publisher MinPublishedCents). The DB-level
// CHECK on adjustment_bp range keeps the multiplier bounded so the math
// stays in float64 territory.
export function applyBettorAdjustment(
  rawOdds: string | null,
  probability: string | null | undefined,
  bp: number,
): string | null {
  if (rawOdds == null) return null;
  if (bp === 0) return formatOddsFloor2(rawOdds);
  const raw = Number.parseFloat(rawOdds);
  if (!Number.isFinite(raw) || raw <= 0) return formatOddsFloor2(rawOdds);

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

  // Floor at the same MinPublishedCents the odds-publisher enforces.
  if (adjusted < 1.01) adjusted = 1.01;

  // Floor-truncate to 2 decimals (Math.floor matches the publisher's
  // big.Float Int() conversion — toward zero, equivalent to floor for
  // non-negative values).
  const cents = Math.floor(adjusted * 100 + 1e-9);
  return `${Math.floor(cents / 100)}.${(cents % 100).toString().padStart(2, "0")}`;
}

// Standalone formatter for the bp=0 / out-of-range short-circuit so the
// catalog responses always emit 2-decimal odds regardless of whether an
// adjustment fires.
function formatOddsFloor2(s: string): string {
  const n = Number.parseFloat(s);
  if (!Number.isFinite(n)) return s;
  return (Math.floor(n * 100 + 1e-9) / 100).toFixed(2);
}
