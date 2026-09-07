// ZillaTips / ZillaFacts visibility — the ONE place the cascade is
// resolved (migration 20260907T093356_insight_widget_rules).
//
// Both widgets answer the same question per match: "may I draw on this
// market, in this tournament, in this category, in this sport?" The rules
// live in one table keyed by `widget`, and this module turns them into an
// answer.
//
// Resolution is most-specific-wins: market > tournament > category >
// sport > global. `global` is seeded for both widgets, so `resolve` always
// has something to return and the fallback is a row an operator can see.
// If even that is missing (someone deleted it), we fail CLOSED — a widget
// nobody configured should not appear, and an empty payload is the shape
// both storefront hooks already treat as "nothing to show".
//
// Why a load-then-resolve pair rather than a SQL predicate: a match page
// asks about MANY markets at once, and the whole table is a handful of
// rows. One query per request, then pure in-memory probes — and the pure
// half is unit-tested without a database.

import { sql } from "drizzle-orm";
import type { DbClient } from "@oddzilla/db";
import { INSIGHT_WIDGETS, type InsightWidget } from "@oddzilla/db";

export { INSIGHT_WIDGETS };
export type { InsightWidget };

/** One widget's rules, indexed for the cascade probes. */
export interface InsightCascade {
  global: boolean | null;
  bySport: Map<number, boolean>;
  byCategory: Map<number, boolean>;
  byTournament: Map<number, boolean>;
  byMarket: Map<number, boolean>;
}

export interface InsightCascades {
  zillatips: InsightCascade;
  zillafacts: InsightCascade;
}

function emptyCascade(): InsightCascade {
  return {
    global: null,
    bySport: new Map(),
    byCategory: new Map(),
    byTournament: new Map(),
    byMarket: new Map(),
  };
}

interface RuleRow {
  widget: string;
  scope: string;
  sport_id: number | null;
  category_id: number | null;
  tournament_id: number | null;
  provider_market_id: number | null;
  enabled: boolean;
}

/**
 * Load every rule for both widgets in one query and index it.
 *
 * Both widgets in one read on purpose: a match page that renders both
 * would otherwise make two round trips for a table this size.
 */
export async function loadInsightCascades(db: DbClient): Promise<InsightCascades> {
  const rows = (await db.execute(sql`
    SELECT widget, scope, sport_id, category_id, tournament_id,
           provider_market_id, enabled
      FROM insight_widget_rules
  `)) as unknown as RuleRow[];

  const cascades: InsightCascades = {
    zillatips: emptyCascade(),
    zillafacts: emptyCascade(),
  };
  for (const r of rows) {
    const c = cascades[r.widget as InsightWidget];
    // A widget name the code does not know is ignored rather than thrown
    // on: the CHECK constraint keeps the column honest, and a future
    // third widget must not break the two that exist.
    if (!c) continue;
    switch (r.scope) {
      case "global":
        c.global = r.enabled;
        break;
      case "sport":
        if (r.sport_id !== null) c.bySport.set(r.sport_id, r.enabled);
        break;
      case "category":
        if (r.category_id !== null) c.byCategory.set(r.category_id, r.enabled);
        break;
      case "tournament":
        if (r.tournament_id !== null) c.byTournament.set(r.tournament_id, r.enabled);
        break;
      case "market":
        if (r.provider_market_id !== null) c.byMarket.set(r.provider_market_id, r.enabled);
        break;
    }
  }
  return cascades;
}

/** What a widget needs to know about the thing it is about to draw on. */
export interface InsightContext {
  sportId: number | null;
  categoryId: number | null;
  tournamentId: number | null;
  /** Omitted when asking "is this widget on at all for this match?". */
  providerMarketId?: number | null;
}

/**
 * Most-specific-wins. Returns false when no rule matches at all, which
 * only happens if the seeded global row was deleted — see the header on
 * failing closed.
 */
export function resolveInsightEnabled(
  cascade: InsightCascade,
  ctx: InsightContext,
): boolean {
  if (ctx.providerMarketId != null) {
    const m = cascade.byMarket.get(ctx.providerMarketId);
    if (m !== undefined) return m;
  }
  if (ctx.tournamentId != null) {
    const t = cascade.byTournament.get(ctx.tournamentId);
    if (t !== undefined) return t;
  }
  if (ctx.categoryId != null) {
    const c = cascade.byCategory.get(ctx.categoryId);
    if (c !== undefined) return c;
  }
  if (ctx.sportId != null) {
    const s = cascade.bySport.get(ctx.sportId);
    if (s !== undefined) return s;
  }
  return cascade.global ?? false;
}

/**
 * The catalogue position of one match, for the match-level probe.
 *
 * Returns nulls for a match id that does not resolve, which `resolve`
 * then answers from the global row — the same as a match in a sport with
 * no rules, which is the right reading.
 */
export async function loadInsightMatchContext(
  db: DbClient,
  matchId: bigint,
): Promise<InsightContext> {
  const rows = (await db.execute(sql`
    SELECT s.id AS sport_id, c.id AS category_id, t.id AS tournament_id
      FROM matches m
      JOIN tournaments t ON t.id = m.tournament_id
      JOIN categories c  ON c.id = t.category_id
      JOIN sports s      ON s.id = c.sport_id
     WHERE m.id = ${matchId.toString()}::bigint
     LIMIT 1
  `)) as unknown as Array<{
    sport_id: number | null;
    category_id: number | null;
    tournament_id: number | null;
  }>;
  const r = rows[0];
  return {
    sportId: r?.sport_id ?? null,
    categoryId: r?.category_id ?? null,
    tournamentId: r?.tournament_id ?? null,
  };
}

/**
 * Map our internal market ids to their market TYPE, for applying market
 * rules to a result set.
 *
 * Called only when the widget actually has market rules — the common case
 * is none, and then the caller skips this round trip entirely.
 */
export async function loadProviderMarketIds(
  db: DbClient,
  marketIds: readonly string[],
): Promise<Map<string, number>> {
  if (marketIds.length === 0) return new Map();
  const rows = (await db.execute(sql`
    SELECT id::text AS id, provider_market_id
      FROM markets
     WHERE id = ANY(${sql`ARRAY[${sql.join(
       marketIds.map((id) => sql`${id}::bigint`),
       sql`, `,
     )}]`})
  `)) as unknown as Array<{ id: string; provider_market_id: number }>;
  return new Map(rows.map((r) => [r.id, r.provider_market_id]));
}

/**
 * True when a widget is off EVERYWHERE — global disabled and not a single
 * rule turns it back on for any scope.
 *
 * The admin pages use this for the red "currently disabled" banner, and
 * the match routes use it to skip their historical scan entirely: there is
 * no point resolving per market when nothing can come back enabled.
 */
export function isFullyDisabled(cascade: InsightCascade): boolean {
  if (cascade.global === true) return false;
  for (const on of [
    ...cascade.bySport.values(),
    ...cascade.byCategory.values(),
    ...cascade.byTournament.values(),
    ...cascade.byMarket.values(),
  ]) {
    if (on) return false;
  }
  return true;
}
