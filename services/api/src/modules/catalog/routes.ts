// /catalog endpoints. Read-only; serves the SSR catalog pages and the
// match-details panel. Public (no auth required).
//
// Routes:
//   GET  /catalog/sports                         active esports + match counts
//   GET  /catalog/sports/:slug                   sport + upcoming/live matches
//   GET  /catalog/matches/:id                    match + tournament/sport + markets

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import {
  sports,
  categories,
  tournaments,
  matches,
  markets,
  marketOutcomes,
} from "@oddzilla/db";
import { NotFoundError } from "../../lib/errors.js";

const matchListQuery = z.object({
  live: z.coerce.boolean().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

// Postgres returns NUMERIC(10,4) as "3.1400" or "3.1429" (pre-2026-04-18
// data, before the publisher started truncating to 2 decimals). Trim to
// the industry-standard 2-decimal display regardless of what's in the row.
function formatOdds(s: string | null | undefined): string | null {
  if (s == null) return null;
  const n = Number.parseFloat(s);
  if (!Number.isFinite(n)) return null;
  return (Math.floor(n * 100) / 100).toFixed(2);
}

export default async function catalogRoutes(app: FastifyInstance) {
  // ── Sports tree ─────────────────────────────────────────────────────
  app.get("/catalog/sports", async () => {
    const rows = await app.db
      .select({
        id: sports.id,
        slug: sports.slug,
        name: sports.name,
        kind: sports.kind,
        active: sports.active,
      })
      .from(sports)
      .where(eq(sports.active, true))
      .orderBy(sports.slug);
    return { sports: rows };
  });

  // ── One sport + its upcoming/live matches ───────────────────────────
  app.get("/catalog/sports/:slug", async (request) => {
    const params = z.object({ slug: z.string().min(1).max(32) }).parse(request.params);
    const q = matchListQuery.parse(request.query);

    const [sport] = await app.db
      .select()
      .from(sports)
      .where(and(eq(sports.slug, params.slug), eq(sports.active, true)))
      .limit(1);
    if (!sport) throw new NotFoundError("sport_not_found", "sport_not_found");

    const matchStatusCondition = q.live
      ? eq(matches.status, "live")
      : inArray(matches.status, ["not_started", "live"]);

    const rows = await app.db
      .select({
        matchId: matches.id,
        providerUrn: matches.providerUrn,
        homeTeam: matches.homeTeam,
        awayTeam: matches.awayTeam,
        scheduledAt: matches.scheduledAt,
        status: matches.status,
        bestOf: matches.bestOf,
        liveScore: matches.liveScore,
        tournamentId: tournaments.id,
        tournamentName: tournaments.name,
      })
      .from(matches)
      .innerJoin(tournaments, eq(tournaments.id, matches.tournamentId))
      .innerJoin(categories, eq(categories.id, tournaments.categoryId))
      .where(and(eq(categories.sportId, sport.id), matchStatusCondition))
      .orderBy(desc(matches.status), matches.scheduledAt)
      .limit(q.limit);

    // Enrich each row with match-winner odds (provider_market_id=1) so the
    // list cards can render prices without an extra round trip per match.
    const matchIds = rows.map((r) => r.matchId);
    const oddsByMatch = new Map<
      string,
      { homeMarketId: string; homeOutcomeId: string; homePrice: string | null;
        awayMarketId: string; awayOutcomeId: string; awayPrice: string | null }
    >();
    if (matchIds.length > 0) {
      const oddsRows = await app.db
        .select({
          matchId: markets.matchId,
          marketId: markets.id,
          outcomeId: marketOutcomes.outcomeId,
          outcomeName: marketOutcomes.name,
          publishedOdds: marketOutcomes.publishedOdds,
          active: marketOutcomes.active,
        })
        .from(markets)
        .innerJoin(marketOutcomes, eq(marketOutcomes.marketId, markets.id))
        .where(
          and(
            inArray(markets.matchId, matchIds),
            eq(markets.providerMarketId, 1),
            eq(markets.status, 1),
          ),
        );

      // Pair each match's outcomes against its home/away team names.
      const byMatch = new Map<string, typeof oddsRows>();
      for (const r of oddsRows) {
        const key = r.matchId.toString();
        const arr = byMatch.get(key) ?? [];
        arr.push(r);
        byMatch.set(key, arr);
      }

      for (const row of rows) {
        const key = row.matchId.toString();
        const outs = byMatch.get(key);
        if (!outs || outs.length === 0) continue;
        const home = outs.find((o) => o.outcomeName === row.homeTeam) ?? outs[0];
        const away = outs.find((o) => o.outcomeName === row.awayTeam) ?? outs[1];
        if (!home || !away) continue;
        oddsByMatch.set(key, {
          homeMarketId: home.marketId.toString(),
          homeOutcomeId: home.outcomeId,
          homePrice: home.active ? home.publishedOdds : null,
          awayMarketId: away.marketId.toString(),
          awayOutcomeId: away.outcomeId,
          awayPrice: away.active ? away.publishedOdds : null,
        });
      }
    }

    return {
      sport: {
        id: sport.id,
        slug: sport.slug,
        name: sport.name,
      },
      matches: rows.map((r) => {
        const o = oddsByMatch.get(r.matchId.toString());
        return {
          id: r.matchId.toString(),
          providerUrn: r.providerUrn,
          homeTeam: r.homeTeam,
          awayTeam: r.awayTeam,
          scheduledAt: r.scheduledAt?.toISOString() ?? null,
          status: r.status,
          bestOf: r.bestOf,
          liveScore: r.liveScore,
          tournament: {
            id: r.tournamentId,
            name: r.tournamentName,
          },
          matchWinner: o
            ? {
                marketId: o.homeMarketId,
                home: { outcomeId: o.homeOutcomeId, price: formatOdds(o.homePrice) },
                away: { outcomeId: o.awayOutcomeId, price: formatOdds(o.awayPrice) },
              }
            : null,
        };
      }),
    };
  });

  // ── One match (+ tournament/sport + active markets + outcomes) ──────
  app.get("/catalog/matches/:id", async (request) => {
    const params = z
      .object({ id: z.coerce.bigint() })
      .parse(request.params);

    const [match] = await app.db
      .select({
        id: matches.id,
        providerUrn: matches.providerUrn,
        homeTeam: matches.homeTeam,
        awayTeam: matches.awayTeam,
        scheduledAt: matches.scheduledAt,
        status: matches.status,
        bestOf: matches.bestOf,
        liveScore: matches.liveScore,
        tournamentId: tournaments.id,
        tournamentName: tournaments.name,
        sportId: sports.id,
        sportSlug: sports.slug,
        sportName: sports.name,
      })
      .from(matches)
      .innerJoin(tournaments, eq(tournaments.id, matches.tournamentId))
      .innerJoin(categories, eq(categories.id, tournaments.categoryId))
      .innerJoin(sports, eq(sports.id, categories.sportId))
      .where(eq(matches.id, params.id))
      .limit(1);
    if (!match) throw new NotFoundError("match_not_found", "match_not_found");

    // Only active markets (status=1), and only the MVP market types
    // (1=match-winner, 4=map-winner). Pre-2026-04-18 data may include
    // dozens of other provider_market_ids that were ingested before the
    // feed-ingester whitelist existed; those would render as "Market #71"
    // with numeric outcome labels. Keep them out of the public response.
    const rows = await app.db
      .select({
        marketId: markets.id,
        providerMarketId: markets.providerMarketId,
        specifiersJson: markets.specifiersJson,
        status: markets.status,
        lastOddinTs: markets.lastOddinTs,
        outcomeId: marketOutcomes.outcomeId,
        outcomeName: marketOutcomes.name,
        publishedOdds: marketOutcomes.publishedOdds,
        active: marketOutcomes.active,
      })
      .from(markets)
      .leftJoin(marketOutcomes, eq(marketOutcomes.marketId, markets.id))
      .where(
        and(
          eq(markets.matchId, params.id),
          eq(markets.status, 1),
          inArray(markets.providerMarketId, [1, 4]),
        ),
      )
      .orderBy(markets.providerMarketId);

    const marketMap = new Map<
      string,
      {
        id: string;
        providerMarketId: number;
        specifiers: Record<string, string>;
        status: number;
        lastOddinTs: string;
        outcomes: Array<{
          outcomeId: string;
          name: string;
          publishedOdds: string | null;
          active: boolean;
        }>;
      }
    >();
    for (const r of rows) {
      const key = r.marketId.toString();
      let m = marketMap.get(key);
      if (!m) {
        m = {
          id: key,
          providerMarketId: r.providerMarketId,
          specifiers: (r.specifiersJson ?? {}) as Record<string, string>,
          status: r.status,
          lastOddinTs: r.lastOddinTs.toString(),
          outcomes: [],
        };
        marketMap.set(key, m);
      }
      if (r.outcomeId) {
        m.outcomes.push({
          outcomeId: r.outcomeId,
          name: r.outcomeName ?? "",
          publishedOdds: formatOdds(r.publishedOdds),
          active: r.active ?? false,
        });
      }
    }

    return {
      match: {
        id: match.id.toString(),
        providerUrn: match.providerUrn,
        homeTeam: match.homeTeam,
        awayTeam: match.awayTeam,
        scheduledAt: match.scheduledAt?.toISOString() ?? null,
        status: match.status,
        bestOf: match.bestOf,
        liveScore: match.liveScore,
        tournament: {
          id: match.tournamentId,
          name: match.tournamentName,
        },
        sport: {
          id: match.sportId,
          slug: match.sportSlug,
          name: match.sportName,
        },
      },
      markets: Array.from(marketMap.values()),
    };
  });

  // ── Counts across sports (for homepage live badges) ────────────────
  app.get("/catalog/live-counts", async () => {
    const rows = await app.db
      .select({
        slug: sports.slug,
        count: sql<string>`COUNT(${matches.id})::text`,
      })
      .from(sports)
      .leftJoin(categories, eq(categories.sportId, sports.id))
      .leftJoin(tournaments, eq(tournaments.categoryId, categories.id))
      .leftJoin(
        matches,
        and(eq(matches.tournamentId, tournaments.id), eq(matches.status, "live")),
      )
      .where(eq(sports.active, true))
      .groupBy(sports.slug);
    const counts: Record<string, number> = {};
    for (const r of rows) counts[r.slug] = Number(r.count);
    return counts;
  });
}
