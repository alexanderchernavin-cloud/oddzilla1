// /admin/boosted-odds — Custom Boosted Odds management (migration 0085;
// 'outcome' scope added in 0087-0088).
//
// The backoffice renders the same sport → tournament → match → market →
// selection hierarchy the storefront shows (plus a Teams branch per
// sport) and lets an operator attach a boost rule to any node: boost %
// (Netwinstable key delta, same math as ZillaFlash), optional end time,
// optional Min Risk Score (bettors below the threshold see standard
// prices).
//
// One rule per (scope, ref) — PUT upserts, DELETE removes. Every
// mutation writes admin_audit_log.

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { and, asc, desc, eq, ilike, inArray, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import {
  adminAuditLog,
  boostedOddsConfig,
  categories,
  competitorProfiles,
  competitors,
  marketDescriptions,
  marketOutcomes,
  markets,
  matches,
  outcomeDescriptions,
  playerProfiles,
  sports,
  tournaments,
  zillaboostBannerImageJobs,
} from "@oddzilla/db";
import { BadRequestError, NotFoundError } from "../../lib/errors.js";
import { BANNER_GEN_ONLINE_KEY } from "../boosted-odds/banner-gen.js";
import {
  renderOutcomeLabel,
  substituteTemplate,
  type OutcomeProfiles,
} from "../../lib/market-naming.js";

interface RuleDto {
  id: string;
  scope: "sport" | "tournament" | "match" | "competitor" | "market" | "outcome";
  /** scope='outcome' only — the boosted cell within the rule's market. */
  outcomeId: string | null;
  boostPct: number;
  /** Scheduled activation (migration 0092); null = live immediately. */
  startsAt: string | null;
  endsAt: string | null;
  minRiskScore: number | null;
  /** scope='competitor' only: 'all' | 'team_only' (migration 0093). */
  competitorMarkets: "all" | "team_only";
  banner: boolean;
  /** AI-generated banner graphic requested (migration 0089). */
  graphicsBanner: boolean;
  updatedAt: string;
}

function toRuleDto(r: typeof boostedOddsConfig.$inferSelect): RuleDto {
  return {
    id: r.id,
    scope: r.scope,
    outcomeId: r.outcomeId,
    boostPct: Number(r.boostPct),
    startsAt: r.startsAt?.toISOString() ?? null,
    endsAt: r.endsAt?.toISOString() ?? null,
    minRiskScore: r.minRiskScore !== null ? Number(r.minRiskScore) : null,
    competitorMarkets: r.competitorMarkets === "team_only" ? "team_only" : "all",
    banner: r.banner,
    graphicsBanner: r.graphicsBanner,
    updatedAt: r.updatedAt.toISOString(),
  };
}

const scopeSchema = z.enum([
  "sport",
  "tournament",
  "match",
  "competitor",
  "market",
  "outcome",
]);

const putBody = z
  .object({
    scope: scopeSchema,
    // sport/tournament/competitor ids are integers; match/market are
    // bigints — accept a digit string and coerce per scope below. For
    // outcome scope this is the MARKET id; `outcomeId` names the cell.
    refId: z.string().regex(/^\d+$/),
    outcomeId: z.string().trim().min(1).max(64).optional(),
    boostPct: z.number().gt(0).max(50),
    // Scheduled activation (migration 0092). Null/absent = live now.
    // Unlike endsAt this is NOT rejected for being in the past — a start
    // time that has already passed just means "live", which is a
    // harmless way to express "start immediately".
    startsAt: z.string().datetime({ offset: true }).nullable().optional(),
    endsAt: z.string().datetime({ offset: true }).nullable().optional(),
    minRiskScore: z.number().min(0.01).max(10).nullable().optional(),
    // scope='competitor' only (migration 0093). 'all' = every market of
    // the team's matches (original behaviour); 'team_only' = just the
    // team's own outcome in team-shaped markets. Accepted and stored for
    // other scopes but ignored, same as outcomeId/banner.
    competitorMarkets: z.enum(["all", "team_only"]).optional(),
    // Promo banner on the storefront home page (migration 0086). No
    // banner surface for competitor or outcome scope — accepted,
    // stored, unused.
    banner: z.boolean().optional(),
    // AI-generated graphic for the banner (migration 0089). Turning it
    // on (or re-ticking after a failure) enqueues a generation job for
    // the operator-PC worker; the image lands asynchronously and the
    // banner upgrades in place on the storefront's next poll.
    graphicsBanner: z.boolean().optional(),
  })
  .refine((b) => (b.scope === "outcome") === (b.outcomeId !== undefined), {
    message: "outcomeId is required for outcome scope and forbidden otherwise",
    path: ["outcomeId"],
  });

function scopeColumn(scope: z.infer<typeof scopeSchema>) {
  switch (scope) {
    case "sport":
      return boostedOddsConfig.sportId;
    case "tournament":
      return boostedOddsConfig.tournamentId;
    case "match":
      return boostedOddsConfig.matchId;
    case "competitor":
      return boostedOddsConfig.competitorId;
    case "market":
    case "outcome":
      return boostedOddsConfig.marketId;
  }
}

const homeCompetitor = alias(competitors, "home_competitor");
const awayCompetitor = alias(competitors, "away_competitor");

/** Per-rule fair-odds clamp status for the active-rules overview. */
export interface RuleClampStatus {
  /** Live, priced markets the rule covers that were evaluated. */
  marketsChecked: number;
  /** Markets where the requested boost is cut short by the fair book. */
  clampedCount: number;
  /** Markets with no headroom at all — the boost does nothing there. */
  swallowedCount: number;
  /** Largest boost the tightest covered market can actually deliver, pp. */
  worstEffectivePct: number | null;
}

/**
 * Which covered markets can't deliver the requested boost.
 *
 * Computed in SQL rather than by pricing every market in TS, because the
 * whole clamp reduces to the book key: boostMarketKey targets
 * `key - pct/100` and floors it at 1.0 (never give the player a fair-or-
 * better book), and `bookKey` is just SUM(1/odds). So:
 *
 *   clamped  <=>  key < 1.0 + pct/100      (target floored)
 *   swallowed <=> key <= 1.0               (no headroom at all)
 *   best deliverable pct on a clamped market = (key - 1.0) * 100
 *
 * Exact, not an estimate. Outcome-scope rules are excluded: their
 * binding limit is usually SELECTION_BOOST_MAX_PROB_SHARE (half the
 * cell's own probability), so reporting only the fair-book check would
 * be a misleading signal.
 */
async function loadClampStatus(
  app: FastifyInstance,
): Promise<Map<string, RuleClampStatus>> {
  const rows = (await app.db.execute(sql`
    WITH keys AS (
      SELECT mo.market_id,
             SUM(1.0 / mo.published_odds) AS k
        FROM market_outcomes mo
        JOIN markets mk ON mk.id = mo.market_id
       WHERE mk.status = 1
         AND mo.active
         AND mo.published_odds IS NOT NULL
         AND mo.published_odds > 0
       GROUP BY mo.market_id
      HAVING COUNT(*) >= 2
    ),
    mkt AS (
      SELECT mk.id AS market_id,
             mk.match_id,
             m.home_competitor_id,
             m.away_competitor_id,
             t.id AS tournament_id,
             c.sport_id
        FROM markets mk
        JOIN matches m     ON m.id = mk.match_id
        JOIN tournaments t ON t.id = m.tournament_id
        JOIN categories c  ON c.id = t.category_id
       WHERE mk.status = 1
         AND m.status IN ('not_started', 'live')
    )
    SELECT r.id::text                                              AS rule_id,
           COUNT(*)::int                                           AS markets_checked,
           COUNT(*) FILTER (WHERE k.k < 1.0 + r.boost_pct / 100.0)::int AS clamped_count,
           COUNT(*) FILTER (WHERE k.k <= 1.0)::int                 AS swallowed_count,
           MIN(k.k)                                                AS min_key
      FROM boosted_odds_config r
      JOIN mkt ON (
           (r.scope = 'sport'      AND mkt.sport_id       = r.sport_id)
        OR (r.scope = 'tournament' AND mkt.tournament_id  = r.tournament_id)
        OR (r.scope = 'match'      AND mkt.match_id       = r.match_id)
        OR (r.scope = 'competitor' AND (mkt.home_competitor_id = r.competitor_id
                                     OR mkt.away_competitor_id = r.competitor_id))
        OR (r.scope = 'market'     AND mkt.market_id      = r.market_id)
      )
      JOIN keys k ON k.market_id = mkt.market_id
     WHERE r.scope <> 'outcome'
     GROUP BY r.id, r.boost_pct
  `)) as unknown as Array<{
    rule_id: string;
    markets_checked: number;
    clamped_count: number;
    swallowed_count: number;
    min_key: string | number | null;
  }>;

  const out = new Map<string, RuleClampStatus>();
  for (const r of rows) {
    const minKey = r.min_key === null ? null : Number(r.min_key);
    out.set(r.rule_id, {
      marketsChecked: r.markets_checked,
      clampedCount: r.clamped_count,
      swallowedCount: r.swallowed_count,
      worstEffectivePct:
        minKey === null ? null : Math.max(0, (minKey - 1) * 100),
    });
  }
  return out;
}

export default async function adminBoostedOddsRoutes(app: FastifyInstance) {
  // ── Active rules overview ──────────────────────────────────────────
  // Flat list of every rule with a human label per scope — powers the
  // summary table above the tree.
  app.get("/admin/boosted-odds/rules", async (request) => {
    request.requireRole("admin");
    const rows = await app.db
      .select()
      .from(boostedOddsConfig)
      .orderBy(desc(boostedOddsConfig.updatedAt));

    // Batch label lookups per scope.
    const sportIds = rows.filter((r) => r.scope === "sport").map((r) => r.sportId!);
    const tournamentIds = rows
      .filter((r) => r.scope === "tournament")
      .map((r) => r.tournamentId!);
    const matchIds = rows.filter((r) => r.scope === "match").map((r) => r.matchId!);
    const competitorIds = rows
      .filter((r) => r.scope === "competitor")
      .map((r) => r.competitorId!);
    // Market and outcome rules share the market_id column, so one
    // lookup covers both label sets.
    const marketIds = rows
      .filter((r) => r.scope === "market" || r.scope === "outcome")
      .map((r) => r.marketId!);

    const [sportRows, tournamentRows, matchRows, competitorRows, marketRows] =
      await Promise.all([
        sportIds.length
          ? app.db
              .select({ id: sports.id, name: sports.name })
              .from(sports)
              .where(inArray(sports.id, sportIds))
          : [],
        tournamentIds.length
          ? app.db
              .select({
                id: tournaments.id,
                name: tournaments.name,
                // Surfaced in the overview so the operator can see what
                // tier an existing tournament boost sits on — tier
                // drives RiskZilla's per-tier match liability cap.
                riskTier: tournaments.riskTier,
              })
              .from(tournaments)
              .where(inArray(tournaments.id, tournamentIds))
          : [],
        matchIds.length
          ? app.db
              .select({
                id: matches.id,
                homeTeam: matches.homeTeam,
                awayTeam: matches.awayTeam,
              })
              .from(matches)
              .where(inArray(matches.id, matchIds))
          : [],
        competitorIds.length
          ? app.db
              .select({ id: competitors.id, name: competitors.name })
              .from(competitors)
              .where(inArray(competitors.id, competitorIds))
          : [],
        marketIds.length
          ? app.db
              .select({
                id: markets.id,
                providerMarketId: markets.providerMarketId,
                homeTeam: matches.homeTeam,
                awayTeam: matches.awayTeam,
              })
              .from(markets)
              .innerJoin(matches, eq(matches.id, markets.matchId))
              .where(inArray(markets.id, marketIds))
          : [],
      ]);
    const sportName = new Map(sportRows.map((r) => [r.id, r.name]));
    const tournamentName = new Map(tournamentRows.map((r) => [r.id, r.name]));
    const tournamentTier = new Map(tournamentRows.map((r) => [r.id, r.riskTier]));
    const matchName = new Map(
      matchRows.map((r) => [r.id.toString(), `${r.homeTeam} vs ${r.awayTeam}`]),
    );
    const competitorName = new Map(competitorRows.map((r) => [r.id, r.name]));
    const marketName = new Map(
      marketRows.map((r) => [
        r.id.toString(),
        `Market #${r.providerMarketId} — ${r.homeTeam} vs ${r.awayTeam}`,
      ]),
    );
    // Selection rules name the cell too. market_outcomes.name is
    // Oddin's raw label (often the team name); fall back to the
    // conventional numeric ids so a rule is never labelled with a bare
    // "1" the operator has to decode.
    const outcomeRules = rows.filter((r) => r.scope === "outcome");
    const outcomeNameRows = outcomeRules.length
      ? await app.db
          .select({
            marketId: marketOutcomes.marketId,
            outcomeId: marketOutcomes.outcomeId,
            name: marketOutcomes.name,
            homeTeam: matches.homeTeam,
            awayTeam: matches.awayTeam,
          })
          .from(marketOutcomes)
          .innerJoin(markets, eq(markets.id, marketOutcomes.marketId))
          .innerJoin(matches, eq(matches.id, markets.matchId))
          .where(
            inArray(
              marketOutcomes.marketId,
              outcomeRules.map((r) => r.marketId!),
            ),
          )
      : [];
    const outcomeName = new Map(
      outcomeNameRows.map((r) => [
        `${r.marketId.toString()}:${r.outcomeId}`,
        r.name ||
          (r.outcomeId === "1"
            ? r.homeTeam
            : r.outcomeId === "2"
              ? r.awayTeam
              : r.outcomeId === "3"
                ? "Draw"
                : r.outcomeId),
      ]),
    );
    const selectionLabel = (r: (typeof rows)[number]): string => {
      const key = `${r.marketId!.toString()}:${r.outcomeId}`;
      const cell = outcomeName.get(key) ?? r.outcomeId ?? "?";
      const market =
        marketName.get(r.marketId!.toString()) ?? `Market row #${r.marketId}`;
      return `${cell} · ${market}`;
    };

    // Graphics-banner job state for the overview chips (pending /
    // ready / failed). Deliberately does NOT select image_data — only
    // the byte-serve route pulls the BYTEA.
    const graphicsRuleIds = rows
      .filter((r) => r.graphicsBanner)
      .map((r) => r.id);
    const jobRows = graphicsRuleIds.length
      ? await app.db
          .select({
            ruleId: zillaboostBannerImageJobs.ruleId,
            status: zillaboostBannerImageJobs.status,
            attempts: zillaboostBannerImageJobs.attempts,
            lastError: zillaboostBannerImageJobs.lastError,
            lastPrompt: zillaboostBannerImageJobs.lastPrompt,
            lastRenderMeta: zillaboostBannerImageJobs.lastRenderMeta,
            generatedAt: zillaboostBannerImageJobs.generatedAt,
          })
          .from(zillaboostBannerImageJobs)
          .where(inArray(zillaboostBannerImageJobs.ruleId, graphicsRuleIds))
      : [];
    const jobByRule = new Map(jobRows.map((j) => [j.ruleId, j]));

    // Image-worker liveness (heartbeat key, TTL 90 s) + queue totals for
    // the status strip above the rules table. Best-effort: a Redis blip
    // just reads as offline.
    const clampByRule = await loadClampStatus(app);

    let workerLastSeen: string | null = null;
    try {
      workerLastSeen = await app.redis.get(BANNER_GEN_ONLINE_KEY);
    } catch {
      workerLastSeen = null;
    }
    const queueTotals = { pending: 0, done: 0, failed: 0 };
    const totalRows = await app.db
      .select({
        status: zillaboostBannerImageJobs.status,
        n: sql<number>`count(*)::int`,
      })
      .from(zillaboostBannerImageJobs)
      .groupBy(zillaboostBannerImageJobs.status);
    for (const r of totalRows) {
      if (r.status === "pending") queueTotals.pending = r.n;
      else if (r.status === "done") queueTotals.done = r.n;
      else if (r.status === "failed") queueTotals.failed = r.n;
    }

    return {
      imageWorker: {
        online: workerLastSeen !== null,
        lastSeen: workerLastSeen,
        queue: queueTotals,
      },
      rules: rows.map((r) => ({
        ...toRuleDto(r),
        // Fair-odds clamp: null when the rule covers nothing priced
        // right now (or is outcome-scope, which this check skips).
        clamp: clampByRule.get(r.id) ?? null,
        graphics: (() => {
          if (!r.graphicsBanner) return null;
          const j = jobByRule.get(r.id);
          // Flag on but no job row: legacy rule from before 0089 or a
          // manual DB edit — render as pending-shaped "queued" anyway.
          if (!j)
            return {
              status: "pending" as const,
              attempts: 0,
              lastError: null,
              lastPrompt: null,
              lastRenderMeta: null,
              generatedAt: null,
            };
          return {
            status: j.status as "pending" | "done" | "failed",
            attempts: j.attempts,
            lastError: j.lastError,
            lastPrompt: j.lastPrompt,
            lastRenderMeta:
              (j.lastRenderMeta as Record<string, unknown> | null) ?? null,
            generatedAt: j.generatedAt?.toISOString() ?? null,
          };
        })(),
        refId:
          r.scope === "sport"
            ? String(r.sportId)
            : r.scope === "tournament"
              ? String(r.tournamentId)
              : r.scope === "match"
                ? r.matchId!.toString()
                : r.scope === "competitor"
                  ? String(r.competitorId)
                  : r.marketId!.toString(),
        label:
          r.scope === "sport"
            ? (sportName.get(r.sportId!) ?? `Sport #${r.sportId}`)
            : r.scope === "tournament"
              ? (tournamentName.get(r.tournamentId!) ?? `Tournament #${r.tournamentId}`)
              : r.scope === "match"
                ? (matchName.get(r.matchId!.toString()) ?? `Match #${r.matchId}`)
                : r.scope === "competitor"
                  ? (competitorName.get(r.competitorId!) ?? `Team #${r.competitorId}`)
                  : r.scope === "outcome"
                    ? selectionLabel(r)
                    : (marketName.get(r.marketId!.toString()) ??
                      `Market row #${r.marketId}`),
        // Only meaningful for tournament-scope rules — the overview
        // renders a tier badge beside the name so the operator can see
        // the liability tier an existing boost sits on. Undefined for
        // every other scope; the client renders nothing then.
        riskTier:
          r.scope === "tournament"
            ? (tournamentTier.get(r.tournamentId!) ?? null)
            : undefined,
      })),
    };
  });

  // ── Sports rail ────────────────────────────────────────────────────
  // Mirrors the storefront sidebar: every active sport with live +
  // upcoming counts of matches that actually have something to bet on
  // (>= 1 active market) — the client orders them with the same
  // TOP-pinned comparator the storefront uses.
  app.get("/admin/boosted-odds/sports", async (request) => {
    request.requireRole("admin");
    const [rows, countRows] = await Promise.all([
      app.db
        .select({
          id: sports.id,
          slug: sports.slug,
          name: sports.name,
          ruleRow: boostedOddsConfig,
        })
        .from(sports)
        .leftJoin(
          boostedOddsConfig,
          and(
            eq(boostedOddsConfig.scope, "sport"),
            eq(boostedOddsConfig.sportId, sports.id),
          ),
        )
        .where(eq(sports.active, true))
        .orderBy(asc(sports.name)),
      app.db
        .select({
          sportId: categories.sportId,
          status: matches.status,
          n: sql<number>`count(*)::int`,
        })
        .from(matches)
        .innerJoin(tournaments, eq(tournaments.id, matches.tournamentId))
        .innerJoin(categories, eq(categories.id, tournaments.categoryId))
        .where(
          and(
            inArray(matches.status, ["not_started", "live"]),
            sql`EXISTS (SELECT 1 FROM markets mk WHERE mk.match_id = ${matches.id} AND mk.status = 1)`,
          ),
        )
        .groupBy(categories.sportId, matches.status),
    ]);
    const counts = new Map<number, { live: number; upcoming: number }>();
    for (const c of countRows) {
      const cur = counts.get(c.sportId) ?? { live: 0, upcoming: 0 };
      if (c.status === "live") cur.live += c.n;
      else cur.upcoming += c.n;
      counts.set(c.sportId, cur);
    }
    return {
      entries: rows.map((r) => ({
        id: r.id,
        slug: r.slug,
        name: r.name,
        liveCount: counts.get(r.id)?.live ?? 0,
        upcomingCount: counts.get(r.id)?.upcoming ?? 0,
        rule: r.ruleRow ? toRuleDto(r.ruleRow) : null,
      })),
    };
  });

  // ── Sport board: the storefront-shaped match list ──────────────────
  // Everything the right pane needs in one round-trip: the bettable
  // matches of a sport (>= 1 active market, live first then by
  // scheduled time — the storefront sport-page ordering) with team
  // logos + tournament labels, plus the tournaments that actually have
  // matches (for the boost-a-tournament chip strip). Rules for match +
  // tournament scopes ride along.
  app.get("/admin/boosted-odds/sports/:sportId/board", async (request) => {
    request.requireRole("admin");
    const { sportId } = z
      .object({ sportId: z.coerce.number().int().positive() })
      .parse(request.params);

    const tournamentRule = alias(boostedOddsConfig, "tournament_rule");
    const rows = await app.db
      .select({
        id: matches.id,
        homeTeam: matches.homeTeam,
        awayTeam: matches.awayTeam,
        homeLogoUrl: homeCompetitor.logoUrl,
        awayLogoUrl: awayCompetitor.logoUrl,
        scheduledAt: matches.scheduledAt,
        status: matches.status,
        tournamentId: tournaments.id,
        tournamentName: tournaments.name,
        riskTier: tournaments.riskTier,
        matchRule: boostedOddsConfig,
        tournamentRuleRow: tournamentRule,
      })
      .from(matches)
      .innerJoin(tournaments, eq(tournaments.id, matches.tournamentId))
      .innerJoin(categories, eq(categories.id, tournaments.categoryId))
      .leftJoin(homeCompetitor, eq(homeCompetitor.id, matches.homeCompetitorId))
      .leftJoin(awayCompetitor, eq(awayCompetitor.id, matches.awayCompetitorId))
      .leftJoin(
        boostedOddsConfig,
        and(
          eq(boostedOddsConfig.scope, "match"),
          eq(boostedOddsConfig.matchId, matches.id),
        ),
      )
      .leftJoin(
        tournamentRule,
        and(
          eq(tournamentRule.scope, "tournament"),
          eq(tournamentRule.tournamentId, tournaments.id),
        ),
      )
      .where(
        and(
          eq(categories.sportId, sportId),
          inArray(matches.status, ["not_started", "live"]),
          sql`EXISTS (SELECT 1 FROM markets mk WHERE mk.match_id = ${matches.id} AND mk.status = 1)`,
        ),
      )
      .orderBy(
        sql`CASE WHEN ${matches.status} = 'live' THEN 0 ELSE 1 END`,
        asc(matches.scheduledAt),
      )
      .limit(500);

    const tournamentsOut = new Map<
      number,
      {
        id: number;
        name: string;
        riskTier: number | null;
        rule: RuleDto | null;
        matchCount: number;
      }
    >();
    for (const r of rows) {
      const t = tournamentsOut.get(r.tournamentId);
      if (t) t.matchCount += 1;
      else
        tournamentsOut.set(r.tournamentId, {
          id: r.tournamentId,
          name: r.tournamentName,
          riskTier: r.riskTier,
          rule: r.tournamentRuleRow ? toRuleDto(r.tournamentRuleRow) : null,
          matchCount: 1,
        });
    }

    return {
      tournaments: Array.from(tournamentsOut.values()),
      matches: rows.map((r) => ({
        id: r.id.toString(),
        homeTeam: r.homeTeam,
        awayTeam: r.awayTeam,
        homeLogoUrl: r.homeLogoUrl,
        awayLogoUrl: r.awayLogoUrl,
        scheduledAt: r.scheduledAt?.toISOString() ?? null,
        status: r.status,
        tournamentId: r.tournamentId,
        tournamentName: r.tournamentName,
        riskTier: r.riskTier,
        rule: r.matchRule ? toRuleDto(r.matchRule) : null,
      })),
    };
  });

  // ── Tree: teams under a sport ──────────────────────────────────────
  app.get("/admin/boosted-odds/sports/:sportId/teams", async (request) => {
    request.requireRole("admin");
    const { sportId } = z
      .object({ sportId: z.coerce.number().int().positive() })
      .parse(request.params);
    const { q } = z
      .object({ q: z.string().trim().max(80).optional() })
      .parse(request.query);
    const conds = [eq(competitors.sportId, sportId)];
    if (q && q.length > 0) {
      conds.push(ilike(competitors.name, `%${q.replaceAll("%", "\\%")}%`));
    }
    const rows = await app.db
      .select({
        id: competitors.id,
        name: competitors.name,
        abbreviation: competitors.abbreviation,
        ruleRow: boostedOddsConfig,
      })
      .from(competitors)
      .leftJoin(
        boostedOddsConfig,
        and(
          eq(boostedOddsConfig.scope, "competitor"),
          eq(boostedOddsConfig.competitorId, competitors.id),
        ),
      )
      .where(and(...conds))
      // Teams with a rule sort first so existing boosts are visible
      // without paging through the whole roster.
      .orderBy(sql`${boostedOddsConfig.id} IS NULL`, asc(competitors.name))
      .limit(300);
    return {
      entries: rows.map((r) => ({
        id: r.id,
        name: r.name,
        abbreviation: r.abbreviation,
        rule: r.ruleRow ? toRuleDto(r.ruleRow) : null,
      })),
    };
  });

  // ── Tree: markets under a match ────────────────────────────────────
  // Labels resolve through the same market_descriptions templates the
  // storefront uses (English, teams substituted, URN specifier values
  // resolved through the profile tables) so the operator sees "Map 2
  // winner", not "Market #4".
  app.get("/admin/boosted-odds/matches/:matchId/markets", async (request) => {
    request.requireRole("admin");
    const { matchId } = z
      .object({ matchId: z.coerce.bigint() })
      .parse(request.params);

    const [match] = await app.db
      .select({
        id: matches.id,
        homeTeam: matches.homeTeam,
        awayTeam: matches.awayTeam,
      })
      .from(matches)
      .where(eq(matches.id, matchId))
      .limit(1);
    if (!match) throw new NotFoundError("match_not_found", "match_not_found");

    const marketRows = await app.db
      .select({
        id: markets.id,
        providerMarketId: markets.providerMarketId,
        specifiersJson: markets.specifiersJson,
        status: markets.status,
        ruleRow: boostedOddsConfig,
        // How many of this market's selections carry their own boost.
        // Surfaced on the collapsed row so an operator can see which
        // markets are priced per-cell without expanding each one.
        selectionRuleCount: sql<number>`(
          SELECT count(*)::int FROM boosted_odds_config sel
           WHERE sel.scope = 'outcome' AND sel.market_id = ${markets.id}
        )`,
      })
      .from(markets)
      .leftJoin(
        boostedOddsConfig,
        and(
          eq(boostedOddsConfig.scope, "market"),
          eq(boostedOddsConfig.marketId, markets.id),
        ),
      )
      .where(and(eq(markets.matchId, matchId), eq(markets.status, 1)))
      .orderBy(asc(markets.providerMarketId), asc(markets.id));

    const providerIds = Array.from(
      new Set(marketRows.map((m) => m.providerMarketId)),
    );
    const descRows = providerIds.length
      ? await app.db
          .select({
            providerMarketId: marketDescriptions.providerMarketId,
            variant: marketDescriptions.variant,
            nameTemplate: marketDescriptions.nameTemplate,
          })
          .from(marketDescriptions)
          .where(
            and(
              inArray(marketDescriptions.providerMarketId, providerIds),
              eq(marketDescriptions.language, "en"),
            ),
          )
      : [];
    const descMap = new Map<string, string>();
    for (const d of descRows) {
      descMap.set(`${d.providerMarketId}:${d.variant}`, d.nameTemplate);
    }

    // Player / competitor URNs inside specifier values ({entity} slots).
    const competitorUrns = new Set<string>();
    const playerUrns = new Set<string>();
    for (const m of marketRows) {
      const specs = (m.specifiersJson ?? {}) as Record<string, string>;
      for (const v of Object.values(specs)) {
        if (typeof v !== "string") continue;
        if (v.startsWith("od:competitor:")) competitorUrns.add(v);
        else if (v.startsWith("od:player:")) playerUrns.add(v);
      }
    }
    const [competitorProfileRows, playerProfileRows] = await Promise.all([
      competitorUrns.size
        ? app.db
            .select({ urn: competitorProfiles.urn, name: competitorProfiles.name })
            .from(competitorProfiles)
            .where(inArray(competitorProfiles.urn, Array.from(competitorUrns)))
        : [],
      playerUrns.size
        ? app.db
            .select({ urn: playerProfiles.urn, name: playerProfiles.name })
            .from(playerProfiles)
            .where(inArray(playerProfiles.urn, Array.from(playerUrns)))
        : [],
    ]);
    const profiles: OutcomeProfiles = {
      competitors: new Map(competitorProfileRows.map((r) => [r.urn, r.name])),
      players: new Map(playerProfileRows.map((r) => [r.urn, r.name])),
    };
    const teams = { homeTeam: match.homeTeam, awayTeam: match.awayTeam };

    return {
      match: {
        id: match.id.toString(),
        homeTeam: match.homeTeam,
        awayTeam: match.awayTeam,
      },
      entries: marketRows.map((m) => {
        const specs = (m.specifiersJson ?? {}) as Record<string, string>;
        const variant = typeof specs.variant === "string" ? specs.variant : "";
        const template =
          descMap.get(`${m.providerMarketId}:${variant}`) ??
          descMap.get(`${m.providerMarketId}:`) ??
          `Market #${m.providerMarketId}`;
        return {
          id: m.id.toString(),
          providerMarketId: m.providerMarketId,
          label: substituteTemplate(template, specs, teams, profiles),
          rule: m.ruleRow ? toRuleDto(m.ruleRow) : null,
          selectionRuleCount: m.selectionRuleCount,
        };
      }),
    };
  });

  // ── Tree: selections (outcomes) under a market ─────────────────────
  // Backs the per-market expand row in the board: the market's live
  // selections with the price the bettor currently sees, so an operator
  // can boost one side of a market without moving the other.
  //
  // Inactive / unpriced outcomes are returned too (flagged), not hidden
  // — Oddin drops individual outcomes inactive for a few seconds mid-
  // round, and a row vanishing under the cursor is worse than a row
  // marked unavailable. A rule may be attached either way; it simply
  // doesn't price until the outcome comes back.
  app.get("/admin/boosted-odds/markets/:marketId/selections", async (request) => {
    request.requireRole("admin");
    const { marketId } = z
      .object({ marketId: z.coerce.bigint() })
      .parse(request.params);

    const [market] = await app.db
      .select({
        id: markets.id,
        providerMarketId: markets.providerMarketId,
        specifiersJson: markets.specifiersJson,
        status: markets.status,
        homeTeam: matches.homeTeam,
        awayTeam: matches.awayTeam,
        marketRule: boostedOddsConfig,
      })
      .from(markets)
      .innerJoin(matches, eq(matches.id, markets.matchId))
      .leftJoin(
        boostedOddsConfig,
        and(
          eq(boostedOddsConfig.scope, "market"),
          eq(boostedOddsConfig.marketId, markets.id),
        ),
      )
      .where(eq(markets.id, marketId))
      .limit(1);
    if (!market) throw new NotFoundError("market_not_found", "market_not_found");

    const specs = (market.specifiersJson ?? {}) as Record<string, string>;
    const variant = typeof specs.variant === "string" ? specs.variant : "";

    const [outcomeRows, descRows] = await Promise.all([
      app.db
        .select({
          outcomeId: marketOutcomes.outcomeId,
          name: marketOutcomes.name,
          publishedOdds: marketOutcomes.publishedOdds,
          active: marketOutcomes.active,
          ruleRow: boostedOddsConfig,
        })
        .from(marketOutcomes)
        .leftJoin(
          boostedOddsConfig,
          and(
            eq(boostedOddsConfig.scope, "outcome"),
            eq(boostedOddsConfig.marketId, marketOutcomes.marketId),
            eq(boostedOddsConfig.outcomeId, marketOutcomes.outcomeId),
          ),
        )
        .where(eq(marketOutcomes.marketId, marketId))
        .orderBy(asc(marketOutcomes.outcomeId)),
      app.db
        .select({
          variant: outcomeDescriptions.variant,
          outcomeId: outcomeDescriptions.outcomeId,
          nameTemplate: outcomeDescriptions.nameTemplate,
        })
        .from(outcomeDescriptions)
        .where(
          and(
            eq(outcomeDescriptions.providerMarketId, market.providerMarketId),
            eq(outcomeDescriptions.language, "en"),
          ),
        ),
    ]);

    // Same label resolution the storefront catalog uses: Oddin's raw
    // name when it has one, else the outcome_descriptions template with
    // specifiers + teams substituted, else the conventional numeric ids.
    const labelFor = (outcomeId: string, rawName: string): string => {
      if (rawName) return rawName;
      const tpl =
        descRows.find((d) => d.variant === variant && d.outcomeId === outcomeId)
          ?.nameTemplate ??
        descRows.find((d) => d.variant === "" && d.outcomeId === outcomeId)
          ?.nameTemplate ??
        null;
      if (tpl) {
        const rendered = renderOutcomeLabel(
          tpl,
          specs,
          market.homeTeam,
          market.awayTeam,
        );
        if (rendered) return rendered;
      }
      return outcomeId === "1"
        ? market.homeTeam
        : outcomeId === "2"
          ? market.awayTeam
          : outcomeId === "3"
            ? "Draw"
            : outcomeId;
    };

    // Numeric ids first in feed order (1 / draw / 2), then URN-keyed
    // outcomes — the order the storefront renders the cells in.
    const weight = (id: string): number => {
      const n = Number.parseInt(id, 10);
      if (!Number.isFinite(n) || String(n) !== id) return 1000;
      return n === 3 ? 1.5 : n;
    };
    const entries = outcomeRows
      .map((o) => ({
        outcomeId: o.outcomeId,
        label: labelFor(o.outcomeId, o.name),
        publishedOdds: o.publishedOdds,
        active: o.active,
        rule: o.ruleRow ? toRuleDto(o.ruleRow) : null,
      }))
      .sort((a, b) => weight(a.outcomeId) - weight(b.outcomeId));

    return {
      market: {
        id: market.id.toString(),
        status: market.status,
        homeTeam: market.homeTeam,
        awayTeam: market.awayTeam,
        /** True when a market-scope rule also exists — selections win. */
        hasMarketRule: market.marketRule !== null,
      },
      entries,
    };
  });

  // ── Upsert a rule ──────────────────────────────────────────────────
  app.put("/admin/boosted-odds/rules", async (request) => {
    const admin = request.requireRole("admin");
    const body = putBody.parse(request.body);
    const startsAt = body.startsAt ? new Date(body.startsAt) : null;
    const endsAt = body.endsAt ? new Date(body.endsAt) : null;
    if (endsAt && endsAt.getTime() <= Date.now()) {
      throw new BadRequestError("ends_at_in_past", "ends_at_in_past");
    }
    // Mirrors the boosted_odds_window_order CHECK — caught here for a
    // clean 400 instead of a constraint-violation 500.
    if (startsAt && endsAt && startsAt.getTime() >= endsAt.getTime()) {
      throw new BadRequestError("window_inverted", "window_inverted");
    }

    // Verify the referenced entity exists — clearer 404 than an FK 500.
    const refIdInt = Number.parseInt(body.refId, 10);
    const refIdBig = BigInt(body.refId);
    const exists = async (): Promise<boolean> => {
      switch (body.scope) {
        case "sport": {
          const [r] = await app.db
            .select({ id: sports.id })
            .from(sports)
            .where(eq(sports.id, refIdInt))
            .limit(1);
          return !!r;
        }
        case "tournament": {
          const [r] = await app.db
            .select({ id: tournaments.id })
            .from(tournaments)
            .where(eq(tournaments.id, refIdInt))
            .limit(1);
          return !!r;
        }
        case "match": {
          const [r] = await app.db
            .select({ id: matches.id })
            .from(matches)
            .where(eq(matches.id, refIdBig))
            .limit(1);
          return !!r;
        }
        case "competitor": {
          const [r] = await app.db
            .select({ id: competitors.id })
            .from(competitors)
            .where(eq(competitors.id, refIdInt))
            .limit(1);
          return !!r;
        }
        case "market": {
          const [r] = await app.db
            .select({ id: markets.id })
            .from(markets)
            .where(eq(markets.id, refIdBig))
            .limit(1);
          return !!r;
        }
        case "outcome": {
          // Stands in for the FK migration 0088 deliberately omits (it
          // would lock market_outcomes against the live feed).
          const [r] = await app.db
            .select({ outcomeId: marketOutcomes.outcomeId })
            .from(marketOutcomes)
            .where(
              and(
                eq(marketOutcomes.marketId, refIdBig),
                eq(marketOutcomes.outcomeId, body.outcomeId!),
              ),
            )
            .limit(1);
          return !!r;
        }
      }
    };
    if (!(await exists())) {
      throw new NotFoundError("ref_not_found", "ref_not_found");
    }

    const col = scopeColumn(body.scope);
    const refValue: number | bigint =
      body.scope === "match" || body.scope === "market" || body.scope === "outcome"
        ? refIdBig
        : refIdInt;
    // Outcome rules are keyed by (market_id, outcome_id), so the
    // uniqueness probe needs both halves — market_id alone would match
    // a sibling selection's rule and overwrite it.
    const refMatch =
      body.scope === "outcome"
        ? and(
            eq(col, refValue as never),
            eq(boostedOddsConfig.outcomeId, body.outcomeId!),
          )
        : eq(col, refValue as never);

    const result = await app.db.transaction(async (tx) => {
      const [before] = await tx
        .select()
        .from(boostedOddsConfig)
        .where(and(eq(boostedOddsConfig.scope, body.scope), refMatch))
        .limit(1);
      const values = {
        boostPct: body.boostPct.toFixed(2),
        competitorMarkets: body.competitorMarkets ?? "all",
        startsAt,
        endsAt,
        minRiskScore:
          body.minRiskScore != null ? body.minRiskScore.toFixed(3) : null,
        // No banner surface for a single selection (the card shape is
        // "this whole market is boosted"), so the flag is forced off
        // rather than stored and silently ignored.
        banner: body.scope === "outcome" ? false : (body.banner ?? false),
        // A graphic only exists ON a banner, so it follows the same
        // scope restriction and implies banner=true is sensible — but
        // it is stored independently so unticking the graphic doesn't
        // tear down the plain banner.
        graphicsBanner:
          body.scope === "outcome" ? false : (body.graphicsBanner ?? false),
        updatedBy: admin.id,
        updatedAt: new Date(),
      };
      const [row] = before
        ? await tx
            .update(boostedOddsConfig)
            .set(values)
            .where(eq(boostedOddsConfig.id, before.id))
            .returning()
        : await tx
            .insert(boostedOddsConfig)
            .values({
              scope: body.scope,
              sportId: body.scope === "sport" ? refIdInt : null,
              tournamentId: body.scope === "tournament" ? refIdInt : null,
              matchId: body.scope === "match" ? refIdBig : null,
              competitorId: body.scope === "competitor" ? refIdInt : null,
              marketId:
                body.scope === "market" || body.scope === "outcome"
                  ? refIdBig
                  : null,
              outcomeId: body.scope === "outcome" ? body.outcomeId! : null,
              ...values,
            })
            .returning();
      if (!row) throw new Error("boosted odds upsert returned no row");
      await tx.insert(adminAuditLog).values({
        actorUserId: admin.id,
        action: before ? "boosted_odds.rule_update" : "boosted_odds.rule_create",
        targetType: "boosted_odds_config",
        targetId:
          body.scope === "outcome"
            ? `${body.scope}:${body.refId}:${body.outcomeId}`
            : `${body.scope}:${body.refId}`,
        beforeJson: before
          ? (toRuleDto(before) as unknown as Record<string, unknown>)
          : null,
        afterJson: toRuleDto(row) as unknown as Record<string, unknown>,
        ipInet: request.ip ?? null,
      });

      // Enqueue image generation when the option turns ON (create with
      // it ticked, or off -> on edit). One job row per rule: re-enqueue
      // resets the SAME row to pending with attempts zeroed — that is
      // also the operator's "regenerate / retry a failed one" gesture
      // (untick, save, re-tick). The previous image stays on the row
      // until the replacement lands, so the storefront banner never
      // blanks mid-regenerate. The worker drains the queue whenever the
      // operator PC is on; while it's off, rows just wait here.
      if (values.graphicsBanner && !before?.graphicsBanner) {
        await tx
          .insert(zillaboostBannerImageJobs)
          .values({ ruleId: row.id })
          .onConflictDoUpdate({
            target: zillaboostBannerImageJobs.ruleId,
            set: {
              status: "pending",
              attempts: 0,
              lastError: null,
              leasedUntil: null,
              nextAttemptAt: new Date(),
              updatedAt: new Date(),
            },
          });
      }
      return row;
    });

    return { rule: toRuleDto(result) };
  });

  // ── Delete a rule ──────────────────────────────────────────────────
  app.delete("/admin/boosted-odds/rules/:id", async (request) => {
    const admin = request.requireRole("admin");
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    await app.db.transaction(async (tx) => {
      const [before] = await tx
        .select()
        .from(boostedOddsConfig)
        .where(eq(boostedOddsConfig.id, id))
        .limit(1);
      if (!before) throw new NotFoundError("rule_not_found", "rule_not_found");
      await tx.delete(boostedOddsConfig).where(eq(boostedOddsConfig.id, id));
      await tx.insert(adminAuditLog).values({
        actorUserId: admin.id,
        action: "boosted_odds.rule_delete",
        targetType: "boosted_odds_config",
        targetId: id,
        beforeJson: toRuleDto(before) as unknown as Record<string, unknown>,
        afterJson: null,
        ipInet: request.ip ?? null,
      });
    });
    return { ok: true };
  });
}
