// /admin/logs — sports -> tournaments -> matches hierarchy browser,
// per-match odds history (visual) and raw AMQP feed replay. Retention is
// enforced in feed-ingester (7 days since received_at); these endpoints
// only surface matches still within that 7-day window.
//
// Categories are intentionally skipped at the UI level — for esports they
// are auto-generated dummy rows (one per sport) and admins don't navigate
// them. The join still passes through categories because the FK chain
// requires it.
//
// Counts and feed-message lookups join on `event_urn = matches.provider_urn`
// rather than `match_id`. The match_id column is filled at insert time,
// but the very first AMQP messages for a brand-new URN race the auto-
// mapper and end up with match_id = NULL; counting by event_urn captures
// those orphans too. SweepFeedMessages backfills the column lazily.

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
  feedMessages,
} from "@oddzilla/db";
import { NotFoundError } from "../../lib/errors.js";

// A match shows up in the admin logs panel iff it has at least one
// feed_messages row keyed to its provider_urn. The 7-day retention on
// feed_messages is what bounds the view — once a match's messages age
// out, the match disappears from the panel. This keeps the list focused
// on matches that actually carry data instead of every scheduled or
// already-closed fixture in the catalog.
const matchInWindow = sql`EXISTS (
  SELECT 1 FROM ${feedMessages} fm
   WHERE fm.event_urn = ${matches.providerUrn}
)`;

// Correlated subquery that counts feed_messages for a given match using
// event_urn = matches.provider_urn so orphan rows (inserted before the
// match existed) still get tallied.
const messageCountSql = sql<string>`(
  SELECT COUNT(*)::text FROM ${feedMessages}
   WHERE ${feedMessages.eventUrn} = ${matches.providerUrn}
)`;

const HISTORY_DAYS = 7;
const HISTORY_MS = HISTORY_DAYS * 24 * 60 * 60 * 1000;

export default async function adminLogsRoutes(app: FastifyInstance) {
  // ── Sports list ─────────────────────────────────────────────────────
  app.get("/admin/logs/sports", async (request) => {
    request.requireRole("admin");
    const rows = await app.db
      .select({
        id: sports.id,
        slug: sports.slug,
        name: sports.name,
        matchCount: sql<string>`COUNT(DISTINCT ${matches.id})::text`,
      })
      .from(sports)
      .leftJoin(categories, eq(categories.sportId, sports.id))
      .leftJoin(
        tournaments,
        eq(tournaments.categoryId, categories.id),
      )
      .leftJoin(
        matches,
        and(eq(matches.tournamentId, tournaments.id), matchInWindow),
      )
      .where(eq(sports.active, true))
      .groupBy(sports.id, sports.slug, sports.name)
      .orderBy(sports.slug);

    return {
      sports: rows.map((r) => ({
        id: r.id,
        slug: r.slug,
        name: r.name,
        matchCount: Number(r.matchCount),
      })),
    };
  });

  // ── Tournaments under a sport ───────────────────────────────────────
  app.get("/admin/logs/sports/:slug/tournaments", async (request) => {
    request.requireRole("admin");
    const { slug } = z
      .object({ slug: z.string().min(1).max(64) })
      .parse(request.params);

    const [sport] = await app.db
      .select({ id: sports.id, slug: sports.slug, name: sports.name })
      .from(sports)
      .where(and(eq(sports.slug, slug), eq(sports.active, true)))
      .limit(1);
    if (!sport) throw new NotFoundError("sport_not_found", "sport_not_found");

    const rows = await app.db
      .select({
        id: tournaments.id,
        slug: tournaments.slug,
        name: tournaments.name,
        matchCount: sql<string>`COUNT(${matches.id})::text`,
      })
      .from(tournaments)
      .innerJoin(categories, eq(categories.id, tournaments.categoryId))
      .leftJoin(
        matches,
        and(eq(matches.tournamentId, tournaments.id), matchInWindow),
      )
      .where(and(eq(categories.sportId, sport.id), eq(tournaments.active, true)))
      .groupBy(tournaments.id, tournaments.slug, tournaments.name)
      .having(sql`COUNT(${matches.id}) > 0`)
      .orderBy(tournaments.name);

    return {
      sport,
      tournaments: rows.map((r) => ({
        id: r.id,
        slug: r.slug,
        name: r.name,
        matchCount: Number(r.matchCount),
      })),
    };
  });

  // ── Matches under a tournament ──────────────────────────────────────
  app.get("/admin/logs/tournaments/:id/matches", async (request) => {
    request.requireRole("admin");
    const { id } = z
      .object({ id: z.coerce.number().int().positive() })
      .parse(request.params);

    const [tournament] = await app.db
      .select({
        id: tournaments.id,
        name: tournaments.name,
        sportSlug: sports.slug,
        sportName: sports.name,
      })
      .from(tournaments)
      .innerJoin(categories, eq(categories.id, tournaments.categoryId))
      .innerJoin(sports, eq(sports.id, categories.sportId))
      .where(eq(tournaments.id, id))
      .limit(1);
    if (!tournament) throw new NotFoundError("tournament_not_found", "tournament_not_found");

    const rows = await app.db
      .select({
        id: matches.id,
        homeTeam: matches.homeTeam,
        awayTeam: matches.awayTeam,
        scheduledAt: matches.scheduledAt,
        status: matches.status,
        bestOf: matches.bestOf,
        messageCount: messageCountSql,
      })
      .from(matches)
      .where(and(eq(matches.tournamentId, id), matchInWindow))
      .orderBy(desc(matches.scheduledAt));

    return {
      tournament,
      matches: rows.map((r) => ({
        id: r.id.toString(),
        homeTeam: r.homeTeam,
        awayTeam: r.awayTeam,
        scheduledAt: r.scheduledAt?.toISOString() ?? null,
        status: r.status,
        bestOf: r.bestOf,
        messageCount: Number(r.messageCount),
      })),
    };
  });

  // ── Match shell + market list with outcomes & winners ───────────────
  // Outcome `result` ∈ {won, lost, void, half_won, half_lost} comes from
  // settlement; null means the market is unsettled. The chart payload is
  // limited to 24h of inline points to keep the page light — the full
  // 7-day history lives behind the per-market history button.
  app.get("/admin/logs/matches/:id", async (request) => {
    request.requireRole("admin");
    const { id } = z
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
        tournamentId: tournaments.id,
        tournamentName: tournaments.name,
        sportSlug: sports.slug,
        sportName: sports.name,
      })
      .from(matches)
      .innerJoin(tournaments, eq(tournaments.id, matches.tournamentId))
      .innerJoin(categories, eq(categories.id, tournaments.categoryId))
      .innerJoin(sports, eq(sports.id, categories.sportId))
      .where(eq(matches.id, id))
      .limit(1);
    if (!match) throw new NotFoundError("match_not_found", "match_not_found");

    const marketRows = await app.db
      .select({
        id: markets.id,
        providerMarketId: markets.providerMarketId,
        specifiersJson: markets.specifiersJson,
        status: markets.status,
      })
      .from(markets)
      .where(eq(markets.matchId, id))
      .orderBy(markets.providerMarketId, markets.id);

    const marketIds = marketRows.map((m) => m.id);

    const outcomeRows = marketIds.length
      ? await app.db
          .select({
            marketId: marketOutcomes.marketId,
            outcomeId: marketOutcomes.outcomeId,
            name: marketOutcomes.name,
            rawOdds: marketOutcomes.rawOdds,
            publishedOdds: marketOutcomes.publishedOdds,
            result: marketOutcomes.result,
            voidFactor: marketOutcomes.voidFactor,
          })
          .from(marketOutcomes)
          .where(inArray(marketOutcomes.marketId, marketIds))
      : [];

    // Bound the chart payload to 24h to keep this page snappy. The
    // per-market history endpoint serves the full 7-day window when the
    // admin needs the long view.
    //
    // We expand market_ids into an `IN (...)` list with sql.join rather
    // than `ANY(:::bigint[])` because postgres-js renders a JS array
    // inside an `sql\`\`` template as a record `(($1, $2, ...))`, which
    // PG can't cast to bigint[]. The IN form binds each id as its own
    // numeric param and works the same end-to-end.
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const historyRows = marketIds.length
      ? ((await app.db.execute(sql`
          SELECT market_id, outcome_id, raw_odds, published_odds,
                 EXTRACT(EPOCH FROM ts)::bigint * 1000 AS ts_ms
            FROM odds_history
           WHERE market_id IN (${sql.join(
             marketIds.map((id) => sql`${id}`),
             sql`, `,
           )})
             AND ts > ${since.toISOString()}
           ORDER BY ts ASC
        `)) as unknown as Array<{
          market_id: string;
          outcome_id: string;
          raw_odds: string | null;
          published_odds: string | null;
          ts_ms: string;
        }>)
      : [];

    type Point = { tsMs: number; raw: string | null; published: string | null };
    type Series = { outcomeId: string; name: string; points: Point[] };
    type Outcome = {
      outcomeId: string;
      name: string;
      rawOdds: string | null;
      publishedOdds: string | null;
      result: string | null;
      voidFactor: string | null;
    };
    type MarketBlock = {
      id: string;
      providerMarketId: number;
      specifiers: Record<string, string>;
      status: number;
      settled: boolean;
      outcomes: Outcome[];
      series: Series[];
    };

    const byMarket = new Map<string, MarketBlock>();
    for (const m of marketRows) {
      byMarket.set(m.id.toString(), {
        id: m.id.toString(),
        providerMarketId: m.providerMarketId,
        specifiers: (m.specifiersJson ?? {}) as Record<string, string>,
        status: m.status,
        settled: false,
        outcomes: [],
        series: [],
      });
    }
    const outcomeNameByKey = new Map<string, string>();
    for (const o of outcomeRows) {
      const key = `${o.marketId.toString()}::${o.outcomeId}`;
      outcomeNameByKey.set(key, o.name);
      const mb = byMarket.get(o.marketId.toString());
      if (!mb) continue;
      mb.outcomes.push({
        outcomeId: o.outcomeId,
        name: o.name,
        rawOdds: o.rawOdds,
        publishedOdds: o.publishedOdds,
        result: o.result,
        voidFactor: o.voidFactor,
      });
      if (o.result) mb.settled = true;
    }
    for (const h of historyRows) {
      const mb = byMarket.get(h.market_id.toString());
      if (!mb) continue;
      const key = `${h.market_id.toString()}::${h.outcome_id}`;
      let series = mb.series.find((s) => s.outcomeId === h.outcome_id);
      if (!series) {
        series = {
          outcomeId: h.outcome_id,
          name: outcomeNameByKey.get(key) ?? h.outcome_id,
          points: [],
        };
        mb.series.push(series);
      }
      series.points.push({
        tsMs: Number(h.ts_ms),
        raw: h.raw_odds,
        published: h.published_odds,
      });
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
        tournament: { id: match.tournamentId, name: match.tournamentName },
        sport: { slug: match.sportSlug, name: match.sportName },
      },
      markets: Array.from(byMarket.values()),
    };
  });

  // ── Per-market full odds history (7d) ───────────────────────────────
  // Returns a chronological log of every odds_history row for one market
  // along with the market shell + outcomes (so the page can render
  // names/results without a second round-trip).
  app.get("/admin/logs/matches/:id/markets/:marketId/history", async (request) => {
    request.requireRole("admin");
    const { id, marketId } = z
      .object({
        id: z.coerce.bigint(),
        marketId: z.coerce.bigint(),
      })
      .parse(request.params);

    const [market] = await app.db
      .select({
        id: markets.id,
        matchId: markets.matchId,
        providerMarketId: markets.providerMarketId,
        specifiersJson: markets.specifiersJson,
        status: markets.status,
      })
      .from(markets)
      .where(and(eq(markets.id, marketId), eq(markets.matchId, id)))
      .limit(1);
    if (!market) throw new NotFoundError("market_not_found", "market_not_found");

    const outcomes = await app.db
      .select({
        outcomeId: marketOutcomes.outcomeId,
        name: marketOutcomes.name,
        rawOdds: marketOutcomes.rawOdds,
        publishedOdds: marketOutcomes.publishedOdds,
        result: marketOutcomes.result,
        voidFactor: marketOutcomes.voidFactor,
      })
      .from(marketOutcomes)
      .where(eq(marketOutcomes.marketId, market.id));

    const since = new Date(Date.now() - HISTORY_MS);
    const rows = (await app.db.execute(sql`
      SELECT outcome_id, raw_odds, published_odds, probability,
             EXTRACT(EPOCH FROM ts)::bigint * 1000 AS ts_ms
        FROM odds_history
       WHERE market_id = ${market.id}
         AND ts > ${since.toISOString()}
       ORDER BY ts ASC, outcome_id ASC
    `)) as unknown as Array<{
      outcome_id: string;
      raw_odds: string | null;
      published_odds: string | null;
      probability: string | null;
      ts_ms: string;
    }>;

    return {
      market: {
        id: market.id.toString(),
        matchId: market.matchId.toString(),
        providerMarketId: market.providerMarketId,
        specifiers: (market.specifiersJson ?? {}) as Record<string, string>,
        status: market.status,
        outcomes,
      },
      retentionDays: HISTORY_DAYS,
      points: rows.map((r) => ({
        outcomeId: r.outcome_id,
        rawOdds: r.raw_odds,
        publishedOdds: r.published_odds,
        probability: r.probability,
        tsMs: Number(r.ts_ms),
      })),
    };
  });

  // ── Raw feed messages for a match ───────────────────────────────────
  // Filters by event_urn = matches.provider_urn (rather than match_id) so
  // orphan rows from the insert/auto-map race are visible too.
  app.get("/admin/logs/matches/:id/feed", async (request) => {
    request.requireRole("admin");
    const { id } = z
      .object({ id: z.coerce.bigint() })
      .parse(request.params);
    const q = z
      .object({
        limit: z.coerce.number().int().min(1).max(2000).default(500),
        kind: z.string().max(64).optional(),
      })
      .parse(request.query);

    const [match] = await app.db
      .select({ providerUrn: matches.providerUrn })
      .from(matches)
      .where(eq(matches.id, id))
      .limit(1);
    if (!match) throw new NotFoundError("match_not_found", "match_not_found");

    const filters = [eq(feedMessages.eventUrn, match.providerUrn)];
    if (q.kind) filters.push(eq(feedMessages.kind, q.kind));

    const rows = await app.db
      .select({
        id: feedMessages.id,
        kind: feedMessages.kind,
        routingKey: feedMessages.routingKey,
        product: feedMessages.product,
        payloadXml: feedMessages.payloadXml,
        receivedAt: feedMessages.receivedAt,
      })
      .from(feedMessages)
      .where(and(...filters))
      .orderBy(desc(feedMessages.receivedAt))
      .limit(q.limit);

    return {
      messages: rows.map((r) => ({
        id: r.id.toString(),
        kind: r.kind,
        routingKey: r.routingKey,
        product: r.product,
        payloadXml: r.payloadXml,
        receivedAt: r.receivedAt.toISOString(),
      })),
      limit: q.limit,
    };
  });
}
