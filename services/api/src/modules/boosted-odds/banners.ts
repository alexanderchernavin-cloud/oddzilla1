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
  ZillaBoostSportBanner,
  ZillaBoostTournamentBanner,
} from "@oddzilla/types";
import { isQuotableOutcomeOdds } from "@oddzilla/types";
import {
  loadSelectionBoostedMarketIds,
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
    // Shared predicate — parity with the match-page compute + the
    // placement validator is what keeps the ±0.01 tolerance honest.
    .filter((r) => isQuotableOutcomeOdds(r.publishedOdds));
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

// Market + outcome display labels via the same description templates
// the storefront catalog resolves (English). Shared by the match
// banner's main-market fallback and the market-scope cards.
async function buildMarketLabels(
  app: FastifyInstance,
  args: {
    providerMarketId: number;
    specifiersJson: unknown;
    homeTeam: string;
    awayTeam: string;
  },
): Promise<{
  marketLabel: string;
  labelFor: (outcomeId: string, rawName: string) => string;
}> {
  const specs = (args.specifiersJson ?? {}) as Record<string, string>;
  const variant = typeof specs.variant === "string" ? specs.variant : "";
  const teams = { homeTeam: args.homeTeam, awayTeam: args.awayTeam };
  const [descRows, outcomeDescRows] = await Promise.all([
    app.db
      .select({
        variant: marketDescriptions.variant,
        nameTemplate: marketDescriptions.nameTemplate,
      })
      .from(marketDescriptions)
      .where(
        and(
          eq(marketDescriptions.providerMarketId, args.providerMarketId),
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
          eq(outcomeDescriptions.providerMarketId, args.providerMarketId),
          eq(outcomeDescriptions.language, "en"),
        ),
      ),
  ]);
  const template =
    descRows.find((d) => d.variant === variant)?.nameTemplate ??
    descRows.find((d) => d.variant === "")?.nameTemplate ??
    `Market #${args.providerMarketId}`;
  const marketLabel = substituteTemplate(template, specs, teams);
  const labelFor = (outcomeId: string, rawName: string): string => {
    if (rawName) return rawName;
    const tpl =
      outcomeDescRows.find((d) => d.variant === variant && d.outcomeId === outcomeId)
        ?.nameTemplate ??
      outcomeDescRows.find((d) => d.variant === "" && d.outcomeId === outcomeId)
        ?.nameTemplate ??
      null;
    if (tpl) {
      const rendered = renderOutcomeLabel(tpl, specs, args.homeTeam, args.awayTeam);
      if (rendered) return rendered;
    }
    return outcomeId === "1"
      ? args.homeTeam
      : outcomeId === "2"
        ? args.awayTeam
        : outcomeId === "3"
          ? "Draw"
          : outcomeId;
  };
  return { marketLabel, labelFor };
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

    // ── sport scope → home banner + sidebar icon ────────────────────
    // A sport-wide boost gets a banner of its own, shaped like the
    // tournament one and carrying no odds (it covers every market of
    // every match under the sport, so there is no single price to
    // quote). The bolt icon in the sidebar rides the same array.
    const sportRules = rules.filter((r) => r.scope === "sport");
    if (sportRules.length > 0) {
      const rows = await app.db
        .select({
          id: sports.id,
          slug: sports.slug,
          name: sports.name,
          logoUrl: sports.logoUrl,
          brandColor: sports.brandColor,
          matchCount: sql<number>`(
            SELECT count(*)::int FROM matches m
             JOIN tournaments t ON t.id = m.tournament_id
             JOIN categories c ON c.id = t.category_id
             WHERE c.sport_id = ${sports.id}
               AND m.status IN ('not_started','live')
               AND EXISTS (SELECT 1 FROM markets mk WHERE mk.match_id = m.id AND mk.status = 1)
          )`,
        })
        .from(sports)
        .where(
          and(
            inArray(sports.id, sportRules.map((r) => r.sportId!)),
            eq(sports.active, true),
          ),
        );
      const bySport = new Map(sportRules.map((r) => [r.sportId!, r]));
      // Not gated on matchCount — same as the tournament banner, which
      // renders with its count whatever that count is. Silently dropping
      // a banner the operator explicitly asked for is what made this
      // look broken in the first place.
      out.sports = rows.flatMap((s): ZillaBoostSportBanner[] => {
        const rule = bySport.get(s.id);
        if (!rule) return [];
        return [
          {
            ruleId: rule.id,
            boostPct: Number(rule.boostPct),
            endsAt: rule.endsAt?.toISOString() ?? null,
            sportId: s.id,
            slug: s.slug,
            name: s.name,
            logoUrl: s.logoUrl,
            brandColor: s.brandColor,
            matchCount: s.matchCount,
          },
        ];
      });
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

      // Main-market candidates per match. Preference order mirrors what
      // a bettor calls the main market right now: match winner (1) when
      // still active, else the CURRENT map winner (4, highest map
      // number among active), else the first remaining active market.
      // Deep-live matches often have 1 and 4 settled away entirely —
      // the banner still shows something bettable.
      const candidateRows = await app.db
        .select({
          id: markets.id,
          matchId: markets.matchId,
          providerMarketId: markets.providerMarketId,
          specifiersJson: markets.specifiersJson,
        })
        .from(markets)
        .where(and(inArray(markets.matchId, ids), eq(markets.status, 1)))
        .orderBy(markets.matchId, markets.providerMarketId, markets.id);
      const candidatesByMatch = new Map<string, typeof candidateRows>();
      for (const c of candidateRows) {
        const key = c.matchId.toString();
        const list = candidatesByMatch.get(key);
        if (list) list.push(c);
        else candidatesByMatch.set(key, [c]);
      }
      // Markets whose pricing is owned by selection rules — a
      // match-wide banner rule is suppressed on those, so the candidate
      // probe below has to skip them and quote the next market instead.
      const selectionOwned = await loadSelectionBoostedMarketIds(
        app.db,
        candidateRows.map((c) => c.id),
        riskScore,
      );
      const mapNumber = (specifiersJson: unknown): number => {
        const specs = (specifiersJson ?? {}) as Record<string, string>;
        const n = Number.parseInt(specs.map ?? "", 10);
        return Number.isFinite(n) ? n : 0;
      };
      const rankCandidates = (list: typeof candidateRows) =>
        [...list].sort((a, b) => {
          const pref = (c: (typeof list)[number]) =>
            c.providerMarketId === 1 ? 0 : c.providerMarketId === 4 ? 1 : 2;
          if (pref(a) !== pref(b)) return pref(a) - pref(b);
          if (a.providerMarketId === 4 && b.providerMarketId === 4) {
            // Current map = highest active map number.
            return mapNumber(b.specifiersJson) - mapNumber(a.specifiersJson);
          }
          if (a.providerMarketId !== b.providerMarketId) {
            return a.providerMarketId - b.providerMarketId;
          }
          return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
        });

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
          outcomeId: null,
          boostPct: Number(r.boostPct),
          endsAt: r.endsAt,
          minRiskScore: null,
        };
        let marketId: string | null = null;
        let marketLabel: string | null = null;
        let teamShaped = false;
        let outcomes: ZillaBoostBannerOutcome[] = [];
        const candidates = rankCandidates(
          candidatesByMatch.get(m.id.toString()) ?? [],
        );
        // Bounded probe: the first few candidates cover every realistic
        // shape; a match where none of them price has nothing bettable
        // worth a banner odds column.
        for (const cand of candidates.slice(0, 6)) {
          if (selectionOwned.has(cand.id.toString())) continue;
          const priced = await loadPricedOutcomes(app, cand.id);
          const quote = quoteBoostedMarket(rule, priced);
          if (!quote) continue;
          teamShaped =
            cand.providerMarketId === 1 || cand.providerMarketId === 4;
          const labels = await buildMarketLabels(app, {
            providerMarketId: cand.providerMarketId,
            specifiersJson: cand.specifiersJson,
            homeTeam: m.homeTeam,
            awayTeam: m.awayTeam,
          });
          marketId = cand.id.toString();
          marketLabel = labels.marketLabel;
          outcomes = quote.map((q) => ({
            outcomeId: q.outcomeId,
            originalOdds: q.originalOdds,
            boostedOdds: q.boostedOdds,
            label: teamShaped
              ? q.outcomeId === "1"
                ? m.homeTeam
                : q.outcomeId === "2"
                  ? m.awayTeam
                  : q.outcomeId === "3"
                    ? "Draw"
                    : labels.labelFor(
                        q.outcomeId,
                        priced.find((p) => p.outcomeId === q.outcomeId)?.rawName ?? "",
                      )
              : labels.labelFor(
                  q.outcomeId,
                  priced.find((p) => p.outcomeId === q.outcomeId)?.rawName ?? "",
                ),
          }));
          break;
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
          marketLabel,
          teamShaped,
          outcomes,
        } satisfies ZillaBoostMatchBanner);
      }
    }

    // ── market scope → ZillaFlash-style cards ───────────────────────
    // Outcome-scope rules have no banner surface of their own: the card
    // shape is "this whole market is boosted", which a single-cell rule
    // isn't. A market-scope banner is likewise skipped when the market
    // carries selection rules, since those own its pricing and the
    // banner's quote would 400 at placement.
    const marketRules = rules.filter((r) => r.scope === "market");
    const marketSelectionOwned = await loadSelectionBoostedMarketIds(
      app.db,
      marketRules.map((r) => r.marketId!),
      riskScore,
    );
    for (const r of marketRules) {
      if (marketSelectionOwned.has(r.marketId!.toString())) continue;
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
        outcomeId: null,
        boostPct: Number(r.boostPct),
        endsAt: r.endsAt,
        minRiskScore: null,
      };
      const priced = await loadPricedOutcomes(app, row.id);
      const quote = quoteBoostedMarket(rule, priced);
      if (!quote) continue;

      const labels = await buildMarketLabels(app, {
        providerMarketId: row.providerMarketId,
        specifiersJson: row.specifiersJson,
        homeTeam: row.homeTeam,
        awayTeam: row.awayTeam,
      });

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
        marketLabel: labels.marketLabel,
        outcomes: quote.map((q) => ({
          outcomeId: q.outcomeId,
          originalOdds: q.originalOdds,
          boostedOdds: q.boostedOdds,
          label: labels.labelFor(
            q.outcomeId,
            priced.find((p) => p.outcomeId === q.outcomeId)?.rawName ?? "",
          ),
        })),
      } satisfies ZillaBoostMarketBanner);
    }

    return out;
  });
}
