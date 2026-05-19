// Per-bettor promo visibility — cascade resolver + helpers.
//
// Two promo kinds (zillaflash, combi_boost) share one DB table with a
// promo_kind discriminator. The resolver returns a per-kind cascade so
// the catalog / placement code can ask `isVisible(kind, ids)` per leg.
//
// Resolution per (user, promo_kind):
//   match > tournament > sport > global
// First explicit row wins. Without any row the bettor sees the standard
// behaviour (visible=true). This is the opt-out model — most bettors
// have zero rows; operators tag specific users via the admin UI.
//
// Combi-boost across multiple legs: caller decides the aggregation. The
// /bets placement uses "AND" — if ANY leg resolves to hidden, no boost
// on the whole ticket. The catalog list endpoint uses the global-only
// resolution because it can't know which combos the bettor will build.

import { eq } from "drizzle-orm";
import type { DbClient } from "@oddzilla/db";
import { bettorPromoVisibilityConfig } from "@oddzilla/db";

export type PromoKind = "zillaflash" | "combi_boost";

type TxHandle = Parameters<Parameters<DbClient["transaction"]>[0]>[0];

// Per-(user, promo_kind) resolved snapshot. `empty=true` means the
// resolver has nothing to do — every lookup returns true and the
// caller skips work.
export interface PromoVisibilityCascade {
  // null = no global row on this user. `true`/`false` is a real row
  // that pins the default visibility for this promo for this bettor
  // across every sport / tournament / match unless a more specific row
  // overrides.
  globalVisible: boolean | null;
  bySport: Map<number, boolean>;
  byTournament: Map<number, boolean>;
  byMatch: Map<string, boolean>; // matchId as string (bigint)
  empty: boolean;
}

export interface BettorPromoCascades {
  zillaflash: PromoVisibilityCascade;
  combi_boost: PromoVisibilityCascade;
  empty: boolean; // true when BOTH cascades are empty — caller skips entirely
}

function emptyCascade(): PromoVisibilityCascade {
  return {
    globalVisible: null,
    bySport: new Map(),
    byTournament: new Map(),
    byMatch: new Map(),
    empty: true,
  };
}

export const EMPTY_CASCADES: BettorPromoCascades = Object.freeze({
  zillaflash: emptyCascade(),
  combi_boost: emptyCascade(),
  empty: true,
}) as BettorPromoCascades;

// One round-trip pulls every row for a user across both promo kinds.
// Partitioned into per-kind maps in memory. Expected row count is tiny
// (most users have 0; tagged VIPs / sharps maybe 2-6).
export async function loadPromoVisibilityCascades(
  db: DbClient | TxHandle,
  userId: string,
): Promise<BettorPromoCascades> {
  const rows = await db
    .select({
      promoKind: bettorPromoVisibilityConfig.promoKind,
      scope: bettorPromoVisibilityConfig.scope,
      sportId: bettorPromoVisibilityConfig.sportId,
      tournamentId: bettorPromoVisibilityConfig.tournamentId,
      matchId: bettorPromoVisibilityConfig.matchId,
      visible: bettorPromoVisibilityConfig.visible,
    })
    .from(bettorPromoVisibilityConfig)
    .where(eq(bettorPromoVisibilityConfig.userId, userId));

  if (rows.length === 0) return EMPTY_CASCADES;

  const zillaflash = emptyCascade();
  zillaflash.empty = true;
  const combi_boost = emptyCascade();
  combi_boost.empty = true;
  const buckets: Record<PromoKind, PromoVisibilityCascade> = {
    zillaflash,
    combi_boost,
  };

  for (const r of rows) {
    const cascade = buckets[r.promoKind];
    if (!cascade) continue;
    cascade.empty = false;
    switch (r.scope) {
      case "global":
        cascade.globalVisible = r.visible;
        break;
      case "sport":
        if (r.sportId !== null) cascade.bySport.set(r.sportId, r.visible);
        break;
      case "tournament":
        if (r.tournamentId !== null)
          cascade.byTournament.set(r.tournamentId, r.visible);
        break;
      case "match":
        if (r.matchId !== null)
          cascade.byMatch.set(r.matchId.toString(), r.visible);
        break;
    }
  }

  return {
    zillaflash,
    combi_boost,
    empty: zillaflash.empty && combi_boost.empty,
  };
}

// Resolve effective visibility for one (kind, match, tournament, sport)
// triple. Returns `true` when no rule applies (default-visible model).
//
// Pass IDs as null when unknown (e.g. the catalog endpoint asking
// "globally, can this user see combi-boost at all?" with all-null ids
// → returns `globalVisible ?? true`).
export function resolveVisible(
  cascades: BettorPromoCascades,
  kind: PromoKind,
  ids: {
    matchId?: bigint | string | null;
    tournamentId?: number | null;
    sportId?: number | null;
  } = {},
): boolean {
  if (cascades.empty) return true;
  const cascade = cascades[kind];
  if (cascade.empty) return true;
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
  return cascade.globalVisible ?? true;
}
