// Per-bettor odds adjustment for the ws-gateway hot path.
//
// Mirrors services/api/src/lib/bettor-odds-adjustment.ts byte-for-byte:
// same cascade resolution (match > tournament > sport > global), same
// multiply-and-clamp math, same 2-decimal floor truncation. The slip
// captures its price from the catalog response (which already applies
// the cascade server-side); if a live tick arrived here without the
// same transform, the displayed odds on the rail would diverge from
// the captured price.
//
// Performance contract:
//   - Hot path: every odds frame multiplies by 1 + bp/10000 and clamps.
//     For bettors with NO active rule (the vast majority), bp resolves
//     to 0 and the caller skips re-serialisation entirely.
//   - Cold path: cascade load is one query per (authed) connection.
//     Cache persists for the lifetime of the connection or until an
//     admin mutation invalidates it via Redis pub/sub.

import type postgres from "postgres";

export interface BettorAdjustmentCascade {
  globalBp: number | null;
  bySport: Map<number, number>;
  byTournament: Map<number, number>;
  byMatch: Map<string, number>;
  empty: boolean;
}

export const EMPTY_CASCADE: BettorAdjustmentCascade = Object.freeze({
  globalBp: null,
  bySport: new Map(),
  byTournament: new Map(),
  byMatch: new Map(),
  empty: true,
}) as BettorAdjustmentCascade;

export async function loadCascade(
  sql: postgres.Sql,
  userId: string,
): Promise<BettorAdjustmentCascade> {
  const rows = await sql<
    Array<{
      scope: string;
      sport_id: number | null;
      tournament_id: number | null;
      match_id: string | null; // bigint serialised as string
      adjustment_bp: number;
    }>
  >`
    SELECT scope::text, sport_id, tournament_id, match_id::text, adjustment_bp
      FROM bettor_odds_adjustment_config
     WHERE user_id = ${userId}
  `;
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
        cascade.globalBp = r.adjustment_bp;
        break;
      case "sport":
        if (r.sport_id !== null) cascade.bySport.set(r.sport_id, r.adjustment_bp);
        break;
      case "tournament":
        if (r.tournament_id !== null)
          cascade.byTournament.set(r.tournament_id, r.adjustment_bp);
        break;
      case "match":
        if (r.match_id !== null) cascade.byMatch.set(r.match_id, r.adjustment_bp);
        break;
    }
  }
  return cascade;
}

// Cascade resolution. Cheap (4 probes worst case). Returns 0 when no
// rule applies — the caller treats that as "send the original payload".
export function resolveBp(
  cascade: BettorAdjustmentCascade,
  matchId: string,
  tournamentId: number,
  sportId: number,
): number {
  if (cascade.empty) return 0;
  const m = cascade.byMatch.get(matchId);
  if (m !== undefined) return m;
  const t = cascade.byTournament.get(tournamentId);
  if (t !== undefined) return t;
  const s = cascade.bySport.get(sportId);
  if (s !== undefined) return s;
  return cascade.globalBp ?? 0;
}

// applyAdjustment: same math as the API lib. floor(adjusted * 100) / 100,
// clamped to [1.01, 1/probability].
//
// `probability` is the published probability as a decimal string. When
// null/unparseable (legacy markets without one) the fair-odds ceiling
// is skipped — degrades gracefully.
export function applyAdjustment(
  rawOdds: string,
  probability: string | null,
  bp: number,
): string {
  if (bp === 0) return rawOdds;
  const raw = Number.parseFloat(rawOdds);
  if (!Number.isFinite(raw) || raw <= 0) return rawOdds;

  let adjusted = raw * (1 + bp / 10000);
  if (probability != null && probability !== "") {
    const p = Number.parseFloat(probability);
    if (Number.isFinite(p) && p > 0 && p < 1) {
      const fair = 1 / p;
      if (adjusted > fair) adjusted = fair;
    }
  }
  if (adjusted < 1.01) adjusted = 1.01;

  const cents = Math.floor(adjusted * 100 + 1e-9);
  return `${Math.floor(cents / 100)}.${(cents % 100).toString().padStart(2, "0")}`;
}
