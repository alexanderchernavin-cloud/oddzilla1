// GET /catalog/zillaboost-banners — ZillaBoost promo banners for the
// storefront home page (migration 0086). One payload carries every
// banner-enabled, non-expired rule the viewer is allowed to see
// (Min Risk Score gate, anonymous = default 1.000), shaped per scope:
//
//   sport      -> sidebar boost icon (slug list)
//   tournament -> ZillaBoost banner linking to the tournament's matches
//   match      -> scoreless match card with original + boosted
//                 match-winner prices
//   market     -> ZillaFlash-style offer card (market label + every
//                 outcome at original/boosted)
//
// Boosted prices here are computed server-side per poll — banners are
// a lobby surface without per-outcome WS state; the click-through goes
// to the slip (server re-validates at placement) or the match page
// (realtime client pricing). Cache-Control: no-store (varies per
// viewer).

import type { FastifyInstance } from "fastify";
import { and, eq, gt, inArray, isNull, or, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import {
  boostedOddsConfig,
  categories,
  competitors,
  marketDescriptions,
  marketOutcomes,
  markets,
  matches,
  outcomeDescriptions,
  sports,
  tournaments,
} from "@oddzilla/db";
import type {
  ZillaBoostBannerOutcome,
  ZillaBoostBannersResponse,
  ZillaBoostMarketBanner,
  ZillaBoostMatchBanner,
  ZillaBoostTournamentBanner,
} from "@oddzilla/types";
import {
  loadViewerRiskScore,
  quoteBoostedMarket,
  type BoostRule,
} from "../../lib/boosted-odds.js";
import {
  renderOutcomeLabel,
  substituteTemplate,
} from "../../lib/market-naming.js";

const homeCompetitor = alias(competitors, "home_competitor");
const awayCompetitor = alias(competitors, "away_competitor");

const EMPTY = (): ZillaBoostBannersResponse => ({
  sports: [],
  tournaments: [],
  matches: [],
  markets: [],
  serverNow: new Date().toISOString(),
});

// Priced + active outcome set of one market, in banner display order
// (1 / draw / 2 first, then everything else by odds ascending).
async function loadPricedOutcomes(
  app: FastifyInstance,
  marketId: bigint,
): Promise<Array<{ outcomeId: string; rawName: string; publishedOdds: number }>> {
  const rows = await app.db
    .select({
      outcomeId: marketOutcomes.outcomeId,
      name: marketOutcomes.name,
      publishedOdds: marketOutcomes.publishedOdds,
      active: marketOutcomes.active,
    })
    .from(marketOutcomes)
    .where(eq(marketOutcomes.marketId, marketId));
  const priced = rows
    .filter((r) => r.active && r.publishedOdds !== null)
    .map((r) => ({
      outcomeId: r.outcomeId,
      rawName: r.name,
      publishedOdds: Number(r.publishedOdds),
    }))
    .filter((r) => Number.isFinite(r.publishedOdds) && r.publishedOdds > 1);
  const weight = (id: string): number => {
    const n = Number.parseInt(id, 10);
    if (!Number.isFinite(n) || String(n) !== id) return 1000;
    return n === 3 ? 1.5 : n;
  };
  priced.sort(
    (a, b) => weight(a.outcomeId) - weight(b.outcomeId) || a.publishedOdds - b.publishedOdds,
  );
  return priced;
}

export default async function zillaboostBannersRoutes(app: FastifyInstance) {
  app.get("/catalog/zillaboost-banners", async (request, reply) => {
    reply.header("cache-control", "no-store");

    const ruleRows = await app.db
      .select()
      .from(boostedOddsConfig)
      .where(
        and(
          eq(boostedOddsConfig.banner, true),
          or(
            isNull(boostedOddsConfig.endsAt),
            gt(boostedOddsConfig.endsAt, sql`now()`),
          ),
        ),
      )
      .limit(50);
    if (ruleRows.length === 0) return EMPTY();

    const riskScore = await loadViewerRiskScore(app.db, request.user?.id);
    const rules = ruleRows.filter(
      (r) => r.minRiskScore === null || riskScore >= Number(r.minRiskScore),
    );
    if (rules.length === 0) return EMPTY();

    const out = EMPTY();

    // ── sport scope → sidebar icons ─────────────────────────────────
    const sportRules = rules.filter((r) => r.scope === "sport");
    if (sportRules.length > 0) {
      const rows = await app.db
        .select({ id: sports.id, slug: sports.slug })
        .from(sports)
        .where(
          and(
            inArray(sports.id, sportRules.map((r) => r.sportId!)),
            eq(sports.active, true),
          ),
        );
      const bySport = new Map(sportRules.map((r) => [r.sportId!, r]));
      out.sports = rows.map((s) => ({
        sportId: s.id,
        slug: s.slug,
        boostPct: Number(bySport.get(s.id)!.boostPct),
      }));
    }

    // ── tournament scope → tournament banners ───────────────────────
    const tournamentRules = rules.filter((r) => r.scope === "tournament");
    if (tournamentRules.length > 0) {
      const ids = tournamentRules.map((r) => r.tournamentId!);
      const rows = await app.db
        .select({
          id: tournaments.id,
          name: tournaments.name,
          logoUrl: tournaments.logoUrl,
          brandColor: tournaments.brandColor,
          sportSlug: sports.slug,
          matchCount: sql<number>`(
            SELECT count(*)::int FROM matches m
             WHERE m.tournament_id = ${tournaments.id}
               AND m.status IN ('not_started','live')
               AND EXISTS (SELECT 1 FROM markets mk WHERE mk.match_id = m.id AND mk.status = 1)
          )`,
        })
        .from(tournaments)
        .innerJoin(categories, eq(categories.id, tournaments.categoryId))
        .innerJoin(sports, eq(sports.id, categories.sportId))
        .where(inArray(tournaments.id, ids));
      const byId = new Map(rows.map((r) => [r.id, r]));
      out.tournaments = tournamentRules.flatMap((r): ZillaBoostTournamentBanner[] => {
        const t = byId.get(r.tournamentId!);
        if (!t) return [];
        return [
          {
            ruleId: r.id,
            boostPct: Number(r.boostPct),
            endsAt: r.endsAt?.toISOString() ?? null,
            tournamentId: t.id,
            name: t.name,
            sportSlug: t.sportSlug,
            logoUrl: t.logoUrl,
            brandColor: t.brandColor,
            matchCount: t.matchCount,
          },
        ];
      });
    }

    // ── match scope → scoreless match cards ─────────────────────────
    const matchRules = rules.filter((r) => r.scope === "match");
    if (matchRules.length > 0) {
      const ids = matchRules.map((r) => r.matchId!);
      const rows = await app.db
        .select({
          id: matches.id,
          homeTeam: matches.homeTeam,
          awayTeam: matches.awayTeam,
          homeLogoUrl: homeCompetitor.logoUrl,
          awayLogoUrl: awayCompetitor.logoUrl,
          scheduledAt: matches.scheduledAt,
          status: matches.status,
          bestOf: matches.bestOf,
          tournamentName: tournaments.name,
          sportSlug: sports.slug,
        })
        .from(matches)
        .innerJoin(tournaments, eq(tournaments.id, matches.tournamentId))
        .innerJoin(categories, eq(categories.id, tournaments.categoryId))
        .innerJoin(sports, eq(sports.id, categories.sportId))
        .leftJoin(homeCompetitor, eq(homeCompetitor.id, matches.homeCompetitorId))
        .leftJoin(awayCompetitor, eq(awayCompetitor.id, matches.awayCompetitorId))
        .where(
          and(
            inArray(matches.id, ids),
            inArray(matches.status, ["not_started", "live"]),
          ),
        );
      const byId = new Map(rows.map((r) => [r.id.toString(), r]));

      // Match-winner market per match (provider id 1, active). One
      // query for all banner matches; ties broken by lowest market id.
      const winnerRows = await app.db
        .select({
          id: markets.id,
          matchId: markets.matchId,
        })
        .from(markets)
        .where(
          and(
            inArray(markets.matchId, ids),
            eq(markets.providerMarketId, 1),
            eq(markets.status, 1),
          ),
        )
        .orderBy(markets.matchId, markets.id);
      const winnerByMatch = new Map<string, bigint>();
      for (const w of winnerRows) {
        const key = w.matchId.toString();
        if (!winnerByMatch.has(key)) winnerByMatch.set(key, w.id);
      }

      for (const r of matchRules) {
        const m = byId.get(r.matchId!.toString());
        if (!m) continue;
        const rule: BoostRule = {
          id: r.id,
          scope: "match",
          sportId: null,
          tournamentId: null,
          matchId: r.matchId,
          competitorId: null,
          marketId: null,
          boostPct: Number(r.boostPct),
          endsAt: r.endsAt,
          minRiskScore: null,
        };
        let marketId: string | null = null;
        let outcomes: ZillaBoostBannerOutcome[] = [];
        const winnerId = winnerByMatch.get(m.id.toString());
        if (winnerId) {
          const priced = await loadPricedOutcomes(app, winnerId);
          const quote = quoteBoostedMarket(rule, priced);
          if (quote) {
            marketId = winnerId.toString();
            outcomes = quote.map((q) => {
              const label =
                q.outcomeId === "1"
                  ? m.homeTeam
                  : q.outcomeId === "2"
                    ? m.awayTeam
                    : q.outcomeId === "3"
                      ? "Draw"
                      : (priced.find((p) => p.outcomeId === q.outcomeId)?.rawName ??
                        q.outcomeId);
              return { ...q, label };
            });
          }
        }
        out.matches.push({
          ruleId: r.id,
          boostPct: Number(r.boostPct),
          endsAt: r.endsAt?.toISOString() ?? null,
          matchId: m.id.toString(),
          homeTeam: m.homeTeam,
          awayTeam: m.awayTeam,
          homeLogoUrl: m.homeLogoUrl,
          awayLogoUrl: m.awayLogoUrl,
          sportSlug: m.sportSlug,
          status: m.status,
          scheduledAt: m.scheduledAt?.toISOString() ?? null,
          tournamentName: m.tournamentName,
          bestOf: m.bestOf,
          marketId,
          outcomes,
        } satisfies ZillaBoostMatchBanner);
      }
    }

    // ── market scope → ZillaFlash-style cards ───────────────────────
    const marketRules = rules.filter((r) => r.scope === "market");
    for (const r of marketRules) {
      const [row] = await app.db
        .select({
          id: markets.id,
          providerMarketId: markets.providerMarketId,
          specifiersJson: markets.specifiersJson,
          status: markets.status,
          matchId: matches.id,
          homeTeam: matches.homeTeam,
          awayTeam: matches.awayTeam,
          matchStatus: matches.status,
          sportSlug: sports.slug,
        })
        .from(markets)
        .innerJoin(matches, eq(matches.id, markets.matchId))
        .innerJoin(tournaments, eq(tournaments.id, matches.tournamentId))
        .innerJoin(categories, eq(categories.id, tournaments.categoryId))
        .innerJoin(sports, eq(sports.id, categories.sportId))
        .where(eq(markets.id, r.marketId!))
        .limit(1);
      if (
        !row ||
        row.status !== 1 ||
        (row.matchStatus !== "not_started" && row.matchStatus !== "live")
      ) {
        continue;
      }

      const rule: BoostRule = {
        id: r.id,
        scope: "market",
        sportId: null,
        tournamentId: null,
        matchId: null,
        competitorId: null,
        marketId: r.marketId,
        boostPct: Number(r.boostPct),
        endsAt: r.endsAt,
        minRiskScore: null,
      };
      const priced = await loadPricedOutcomes(app, row.id);
      const quote = quoteBoostedMarket(rule, priced);
      if (!quote) continue;

      // Market + outcome labels through the same description templates
      // the storefront catalog resolves (English).
      const specs = (row.specifiersJson ?? {}) as Record<string, string>;
      const variant = typeof specs.variant === "string" ? specs.variant : "";
      const teams = { homeTeam: row.homeTeam, awayTeam: row.awayTeam };
      const [descRows, outcomeDescRows] = await Promise.all([
        app.db
          .select({
            variant: marketDescriptions.variant,
            nameTemplate: marketDescriptions.nameTemplate,
          })
          .from(marketDescriptions)
          .where(
            and(
              eq(marketDescriptions.providerMarketId, row.providerMarketId),
              eq(marketDescriptions.language, "en"),
            ),
          ),
        app.db
          .select({
            variant: outcomeDescriptions.variant,
            outcomeId: outcomeDescriptions.outcomeId,
            nameTemplate: outcomeDescriptions.nameTemplate,
          })
          .from(outcomeDescriptions)
          .where(
            and(
              eq(outcomeDescriptions.providerMarketId, row.providerMarketId),
              eq(outcomeDescriptions.language, "en"),
            ),
          ),
      ]);
      const template =
        descRows.find((d) => d.variant === variant)?.nameTemplate ??
        descRows.find((d) => d.variant === "")?.nameTemplate ??
        `Market #${row.providerMarketId}`;
      const marketLabel = substituteTemplate(template, specs, teams);
      const outcomeTemplate = (outcomeId: string): string | null =>
        outcomeDescRows.find((d) => d.variant === variant && d.outcomeId === outcomeId)
          ?.nameTemplate ??
        outcomeDescRows.find((d) => d.variant === "" && d.outcomeId === outcomeId)
          ?.nameTemplate ??
        null;

      out.markets.push({
        ruleId: r.id,
        boostPct: Number(r.boostPct),
        endsAt: r.endsAt?.toISOString() ?? null,
        matchId: row.matchId.toString(),
        homeTeam: row.homeTeam,
        awayTeam: row.awayTeam,
        sportSlug: row.sportSlug,
        status: row.matchStatus,
        marketId: row.id.toString(),
        marketLabel,
        outcomes: quote.map((q) => {
          const raw = priced.find((p) => p.outcomeId === q.outcomeId);
          let label = raw?.rawName ?? "";
          if (!label) {
            const tpl = outcomeTemplate(q.outcomeId);
            if (tpl) {
              label = renderOutcomeLabel(tpl, specs, row.homeTeam, row.awayTeam);
            }
          }
          if (!label) {
            label =
              q.outcomeId === "1"
                ? row.homeTeam
                : q.outcomeId === "2"
                  ? row.awayTeam
                  : q.outcomeId === "3"
                    ? "Draw"
                    : q.outcomeId;
          }
          return { ...q, label };
        }),
      } satisfies ZillaBoostMarketBanner);
    }

    return out;
  });
}
