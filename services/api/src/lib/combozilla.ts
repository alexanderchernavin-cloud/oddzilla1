// ComboZilla eligibility — the ONE place that decides which prematch
// matches may feed the lobby's prebuilt 3-fold carousel.
//
// Two consumers, one policy:
//
//   GET /catalog/combozilla-pool   (modules/catalog/routes.ts) — the
//     storefront's candidate pool. The web builder assembles combos out of
//     exactly this list and does no eligibility work of its own.
//   /admin/combozilla-config        (modules/admin/combozilla-config.ts)
//     — the backoffice preview, which counts the same population grouped
//     by sport and tournament so an operator can see what a change does
//     before the lobby does.
//
// Policy (migration 20260906T015446_combozilla_config):
//
//   1. Operator rules, most specific first: a TOURNAMENT rule beats a
//      CATEGORY rule beats a SPORT rule. 'allow' admits the scope
//      REGARDLESS of risk tier (anything already eligible needs no rule,
//      so that is the only meaning "manually add" can have); 'block'
//      excludes it regardless of tier.
//   2. No rule: the tournament's risk tier decides — in
//      `eligible_risk_tiers` → in; NULL → `allow_untiered`; else out.
//
// On top of that the pool applies the same predicates every storefront
// list applies (lib/catalog-predicates.ts): prematch only, a bettable
// market, no hidden test tournament, no list-excluded category. A card
// must never recommend a match the list below it does not show.
//
// Untiered defaults to OUT because a NULL tier is not "unknown, probably
// fine": RiskZilla prices it at the STRICTEST tier (UNTIERED_RISK_TIER),
// and a carousel card is a recommendation. ZillaAGI tiers new rows within
// half an hour, so the gap is transient anyway.

import { and, asc, eq, inArray, isNull, sql, type SQL } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import type { FastifyInstance } from "fastify";
import {
  categories,
  combozillaConfig,
  combozillaScopeRules,
  matches,
  sports,
  tournaments,
  type CombozillaConfig,
  type CombozillaScopeRule,
} from "@oddzilla/db";
import {
  hasActiveMarket,
  notHiddenCategory,
  notHiddenTournament,
} from "./catalog-predicates.js";

type Db = FastifyInstance["db"];

export const COMBOZILLA_SINGLETON_ID = "default";

/** Redis key of the anonymous pool response; the admin routes bust it. */
export const COMBOZILLA_POOL_CACHE_KEY = "catalog:combozilla-pool:v1";

/**
 * Per-sport cap on pool rows. The builder enumerates triples inside one
 * sport and caps its own candidate list at 30 per tier, so 40 covers it
 * with room for legs the boost floor drops. Capping PER SPORT rather than
 * overall is what keeps a dense sport (football on the Fonbet line, with
 * hundreds of prematch fixtures) from filling the whole pool and leaving
 * every other sport with nothing to build from.
 */
export const COMBOZILLA_POOL_PER_SPORT = 40;

/** Overall cap on pool rows. Eight full sports' worth. */
export const COMBOZILLA_POOL_LIMIT = 320;

// ── Config + rules ───────────────────────────────────────────────────────

export async function loadComboZillaConfig(db: Db): Promise<CombozillaConfig> {
  const [row] = await db
    .select()
    .from(combozillaConfig)
    .where(eq(combozillaConfig.id, COMBOZILLA_SINGLETON_ID))
    .limit(1);
  if (row) return row;
  // The migration seeds the row; INSERT defensively for a fresh or test
  // database. The singleton CHECK means this can never make a second row.
  const [inserted] = await db
    .insert(combozillaConfig)
    .values({ id: COMBOZILLA_SINGLETON_ID })
    .onConflictDoNothing()
    .returning();
  if (inserted) return inserted;
  const [refetched] = await db
    .select()
    .from(combozillaConfig)
    .where(eq(combozillaConfig.id, COMBOZILLA_SINGLETON_ID))
    .limit(1);
  if (!refetched) throw new Error("combozilla_config row missing after insert");
  return refetched;
}

export async function loadComboZillaRules(db: Db): Promise<CombozillaScopeRule[]> {
  return db
    .select()
    .from(combozillaScopeRules)
    .orderBy(asc(combozillaScopeRules.scope), asc(combozillaScopeRules.id));
}

/** The rule set split the way the CASE expression consumes it. */
export interface ComboZillaRulePartition {
  allowSports: number[];
  blockSports: number[];
  allowCategories: number[];
  blockCategories: number[];
  allowTournaments: number[];
  blockTournaments: number[];
}

type RuleLike = Pick<
  CombozillaScopeRule,
  "scope" | "mode" | "sportId" | "categoryId" | "tournamentId"
>;

/**
 * Group rules by (scope, mode). Pure. A row whose ref column is NULL for
 * its own scope is skipped rather than thrown on — the CHECK constraint
 * makes that impossible for a stored row, and a defensive skip keeps a
 * hand-built test fixture from taking the lobby down.
 */
export function partitionRules(rules: readonly RuleLike[]): ComboZillaRulePartition {
  const p: ComboZillaRulePartition = {
    allowSports: [],
    blockSports: [],
    allowCategories: [],
    blockCategories: [],
    allowTournaments: [],
    blockTournaments: [],
  };
  for (const r of rules) {
    const allow = r.mode === "allow";
    if (r.scope === "sport" && r.sportId != null) {
      (allow ? p.allowSports : p.blockSports).push(r.sportId);
    } else if (r.scope === "category" && r.categoryId != null) {
      (allow ? p.allowCategories : p.blockCategories).push(r.categoryId);
    } else if (r.scope === "tournament" && r.tournamentId != null) {
      (allow ? p.allowTournaments : p.blockTournaments).push(r.tournamentId);
    }
  }
  return p;
}

/**
 * The eligibility predicate, as SQL over the `matches → tournaments →
 * categories → sports` join every list endpoint already makes. One CASE,
 * most specific WHEN first, so the first branch that matches is the one
 * that decides — which is exactly the cascade in the module comment.
 */
export function comboZillaEligibility(
  cfg: Pick<CombozillaConfig, "eligibleRiskTiers" | "allowUntiered">,
  rules: ComboZillaRulePartition,
): SQL {
  const TRUE = sql.raw("TRUE");
  const FALSE = sql.raw("FALSE");
  const branches: SQL[] = [];
  const when = (col: AnyPgColumn, ids: number[], verdict: SQL) => {
    if (ids.length === 0) return;
    branches.push(sql`WHEN ${inArray(col, ids)} THEN ${verdict}`);
  };
  when(tournaments.id, rules.allowTournaments, TRUE);
  when(tournaments.id, rules.blockTournaments, FALSE);
  when(categories.id, rules.allowCategories, TRUE);
  when(categories.id, rules.blockCategories, FALSE);
  when(sports.id, rules.allowSports, TRUE);
  when(sports.id, rules.blockSports, FALSE);
  branches.push(
    sql`WHEN ${isNull(tournaments.riskTier)} THEN ${cfg.allowUntiered ? TRUE : FALSE}`,
  );
  if (cfg.eligibleRiskTiers.length > 0) {
    branches.push(
      sql`WHEN ${inArray(tournaments.riskTier, cfg.eligibleRiskTiers)} THEN ${TRUE}`,
    );
  }
  return sql`(CASE ${sql.join(branches, sql` `)} ELSE ${FALSE} END)`;
}

// ── Pool ─────────────────────────────────────────────────────────────────

export interface ComboZillaPoolRow {
  matchId: bigint;
  homeTeam: string;
  awayTeam: string;
  scheduledAt: Date | null;
  status: string;
  sportId: number;
  sportSlug: string;
  sportName: string;
  categoryId: number;
  categoryName: string;
  tournamentId: number;
  tournamentName: string;
  riskTier: number | null;
}

/**
 * The prematch offer under the current policy: the WHERE every storefront
 * list uses, plus the eligibility CASE.
 */
function poolWhere(
  cfg: Pick<CombozillaConfig, "eligibleRiskTiers" | "allowUntiered">,
  rules: ComboZillaRulePartition,
): SQL | undefined {
  return and(
    eq(matches.status, "not_started"),
    eq(sports.active, true),
    hasActiveMarket,
    notHiddenTournament,
    notHiddenCategory,
    comboZillaEligibility(cfg, rules),
  );
}

/**
 * Candidate matches for the builder. Within each sport the flagship
 * tournaments come first (lower tier), then kickoff order, so when the
 * per-sport cap bites it drops the least prominent matches — the same
 * rule the match lists sort by.
 */
export async function loadComboZillaPoolRows(
  db: Db,
  cfg: Pick<CombozillaConfig, "eligibleRiskTiers" | "allowUntiered">,
  rules: readonly RuleLike[],
  opts: { perSport?: number; limit?: number } = {},
): Promise<ComboZillaPoolRow[]> {
  const perSport = opts.perSport ?? COMBOZILLA_POOL_PER_SPORT;
  const limit = opts.limit ?? COMBOZILLA_POOL_LIMIT;
  const partition = partitionRules(rules);

  const ranked = db.$with("combozilla_ranked").as(
    db
      .select({
        matchId: matches.id,
        homeTeam: matches.homeTeam,
        awayTeam: matches.awayTeam,
        scheduledAt: matches.scheduledAt,
        status: matches.status,
        sportId: sports.id,
        sportSlug: sports.slug,
        sportName: sports.name,
        categoryId: categories.id,
        categoryName: categories.name,
        tournamentId: tournaments.id,
        tournamentName: tournaments.name,
        riskTier: tournaments.riskTier,
        rn: sql<number>`ROW_NUMBER() OVER (
          PARTITION BY ${sports.id}
          ORDER BY COALESCE(${tournaments.riskTier}, 99) ASC,
                   ${matches.scheduledAt} ASC NULLS LAST,
                   ${matches.id} ASC
        )`.as("rn"),
      })
      .from(matches)
      .innerJoin(tournaments, eq(tournaments.id, matches.tournamentId))
      .innerJoin(categories, eq(categories.id, tournaments.categoryId))
      .innerJoin(sports, eq(sports.id, categories.sportId))
      .where(poolWhere(cfg, partition)),
  );

  const rows = await db
    .with(ranked)
    .select({
      matchId: ranked.matchId,
      homeTeam: ranked.homeTeam,
      awayTeam: ranked.awayTeam,
      scheduledAt: ranked.scheduledAt,
      status: ranked.status,
      sportId: ranked.sportId,
      sportSlug: ranked.sportSlug,
      sportName: ranked.sportName,
      categoryId: ranked.categoryId,
      categoryName: ranked.categoryName,
      tournamentId: ranked.tournamentId,
      tournamentName: ranked.tournamentName,
      riskTier: ranked.riskTier,
    })
    .from(ranked)
    .where(sql`${ranked.rn} <= ${perSport}`)
    .orderBy(asc(ranked.sportId), asc(ranked.rn))
    .limit(limit);

  return rows.map((r) => ({
    ...r,
    // A CTE hands timestamptz back through the column's own decoder, but
    // pin the type at the boundary so a driver change cannot leak a
    // string into `toISOString()` downstream.
    scheduledAt: r.scheduledAt == null ? null : new Date(r.scheduledAt),
  }));
}

// ── Backoffice preview ───────────────────────────────────────────────────

export interface ComboZillaPreviewGroup {
  sportId: number;
  sportSlug: string;
  sportName: string;
  categoryName: string | null;
  tournamentId: number;
  tournamentName: string;
  riskTier: number | null;
  matchCount: number;
}

/**
 * Everything the policy admits right now, counted per tournament — the
 * UNCAPPED population, so the operator sees the real size of what they
 * just allowed rather than the pool's per-sport slice of it.
 */
export async function loadComboZillaPreview(
  db: Db,
  cfg: Pick<CombozillaConfig, "eligibleRiskTiers" | "allowUntiered">,
  rules: readonly RuleLike[],
): Promise<ComboZillaPreviewGroup[]> {
  const partition = partitionRules(rules);
  const rows = await db
    .select({
      sportId: sports.id,
      sportSlug: sports.slug,
      sportName: sports.name,
      // Oddin's auto-mapper files every esports tournament under one
      // synthetic dummy category; the storefront renders no header for
      // it, so the preview shows none either.
      categoryName: sql<string | null>`CASE WHEN ${categories.isDummy} THEN NULL ELSE ${categories.name} END`,
      tournamentId: tournaments.id,
      tournamentName: tournaments.name,
      riskTier: tournaments.riskTier,
      matchCount: sql<string>`COUNT(*)::text`,
    })
    .from(matches)
    .innerJoin(tournaments, eq(tournaments.id, matches.tournamentId))
    .innerJoin(categories, eq(categories.id, tournaments.categoryId))
    .innerJoin(sports, eq(sports.id, categories.sportId))
    .where(poolWhere(cfg, partition))
    .groupBy(
      sports.id,
      sports.slug,
      sports.name,
      categories.isDummy,
      categories.name,
      tournaments.id,
      tournaments.name,
      tournaments.riskTier,
    )
    .orderBy(
      asc(sports.name),
      sql`COALESCE(${tournaments.riskTier}, 99) ASC`,
      sql`COUNT(*) DESC`,
      asc(tournaments.name),
    );
  return rows.map((r) => ({ ...r, matchCount: Number(r.matchCount) }));
}
