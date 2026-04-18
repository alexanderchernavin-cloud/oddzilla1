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
  marketDescriptions,
  outcomeDescriptions,
  competitorProfiles,
  playerProfiles,
} from "@oddzilla/db";
import { NotFoundError } from "../../lib/errors.js";

// substituteTemplate replaces {specifier} placeholders in an Oddin name
// template with the supplied specifier values. Unknown placeholders are
// kept verbatim so broken descriptions degrade visibly rather than
// silently. E.g.:
//   "Match handicap {handicap}" + {handicap: "-1.5"} -> "Match handicap -1.5"
//   "First half winner {way}way - map {map}" + {way: "two", map: "1"}
//     -> "First half winner twoway - map 1"
// Trims double spaces and trailing hyphens left over when a specifier is
// empty (occurs for optional variant specifiers in Oddin's catalog).
function substituteTemplate(template: string, specs: Record<string, string>): string {
  const out = template.replace(/\{([a-z0-9_]+)\}/gi, (_, key: string) => {
    const v = specs[key];
    return v == null ? `{${key}}` : v;
  });
  return out.replace(/\s{2,}/g, " ").replace(/\s-\s$/, "").trim();
}

// renderOutcomeLabel translates an outcome-template placeholder to the
// user-facing label. "home"/"away" resolve to team names, "draw" to
// "Draw", literal values (scores, "under"/"over", numeric outcomes) pass
// through. Specifier substitution is applied for templates like
// "{side} wins at least one map" where side ∈ {home, away}.
function renderOutcomeLabel(
  template: string,
  specs: Record<string, string>,
  homeTeam: string,
  awayTeam: string,
): string {
  const sub = substituteTemplate(template, specs);
  const lower = sub.trim().toLowerCase();
  if (lower === "home") return homeTeam;
  if (lower === "away") return awayTeam;
  if (lower === "draw") return "Draw";
  if (lower === "under") return "Under";
  if (lower === "over") return "Over";
  // "home / draw", "home / away" — resolve each token, keep separator.
  if (/^(home|away|draw)(\s*[/&,]\s*(home|away|draw))+$/i.test(lower)) {
    return lower
      .split(/\s*([/&,])\s*/)
      .map((t) =>
        t === "home" ? homeTeam : t === "away" ? awayTeam : t === "draw" ? "Draw" : t,
      )
      .join(" ");
  }
  return sub;
}

// deriveScope reads a market's specifiers and returns a short tag used
// by the UI to group markets into sections. "match" is the default;
// "map_N" appears when the market is scoped to a specific map (either
// via a `map` specifier or, for some markets, a `period` specifier).
function deriveScope(specs: Record<string, string>): { id: string; label: string; order: number } {
  if (specs.map) {
    const n = Number.parseInt(specs.map, 10);
    if (Number.isFinite(n) && n > 0) {
      return { id: `map_${n}`, label: `Map ${n}`, order: n };
    }
  }
  return { id: "match", label: "Match", order: 0 };
}

// Oddin specifier names that act as "lines" — i.e. each value produces
// a separate market row on the feed, but users see them as one market
// with many thresholds to choose from (Totals, Handicaps, …).
const LINE_SPECIFIERS = ["threshold", "handicap"] as const;
type LineSpec = (typeof LINE_SPECIFIERS)[number];

// lineInfo returns the line-specifier present on the market (if any)
// plus a grouping key that collapses markets that differ only in their
// line value. Markets with no line specifier get lineKey=null and the
// client renders them as a single card.
function lineInfo(
  providerMarketId: number,
  variant: string,
  specs: Record<string, string>,
): { lineKey: string | null; lineSpec: LineSpec | null; lineValue: string | null } {
  for (const key of LINE_SPECIFIERS) {
    const v = specs[key];
    if (v == null || v === "") continue;
    // Collapse key = (market, variant, all other specifiers sorted). The
    // `variant` inner specifier is already part of Oddin's canonical
    // specifier set, so we just drop the line specifier before hashing.
    const rest = Object.entries(specs)
      .filter(([k]) => k !== key)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, val]) => `${k}=${val}`)
      .join("|");
    return {
      lineKey: `${providerMarketId}|${variant}|${rest}|line=${key}`,
      lineSpec: key,
      lineValue: v,
    };
  }
  return { lineKey: null, lineSpec: null, lineValue: null };
}

// stripLinePlaceholder removes the `{threshold}` / `{handicap}` token
// from a name template so the card header reads as a generic market
// name ("Total kills - map 1") while each row carries the line value.
function stripLinePlaceholder(template: string, lineSpec: LineSpec): string {
  const pattern = new RegExp(`\\{${lineSpec}\\}`, "g");
  return template.replace(pattern, "").replace(/\s{2,}/g, " ").trim();
}

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
      .where(
        and(
          eq(categories.sportId, sport.id),
          matchStatusCondition,
          // Drop phantom matches that have no active markets — they
          // leak into the sport page as "LIVE" with no odds otherwise.
          sql`EXISTS (SELECT 1 FROM markets mk WHERE mk.match_id = ${matches.id} AND mk.status = 1)`,
        ),
      )
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

    // Only active markets (status=1). Join against market_descriptions
    // so each row carries a human-readable name template, then expand
    // {specifier} placeholders at render time using the row's own
    // specifiers_json. Fall back to "Market #N" when a description is
    // missing (Oddin added a new market type, cache stale, etc.) so the
    // UI degrades visibly instead of silently.
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
      .where(and(eq(markets.matchId, params.id), eq(markets.status, 1)))
      .orderBy(markets.providerMarketId);

    // Collect URN-style outcome ids (od:competitor:N / od:player:N) so
    // we can join against our profile cache and substitute human names
    // on the way out. Outcomes without a matching profile fall through
    // to their existing `name` / `outcomeId`.
    const competitorUrns = new Set<string>();
    const playerUrns = new Set<string>();
    for (const r of rows) {
      const id = r.outcomeId;
      if (!id) continue;
      if (id.startsWith("od:competitor:")) competitorUrns.add(id);
      else if (id.startsWith("od:player:")) playerUrns.add(id);
    }
    const competitorNameMap = new Map<string, string>();
    const playerNameMap = new Map<string, string>();
    if (competitorUrns.size > 0) {
      const cps = await app.db
        .select({ urn: competitorProfiles.urn, name: competitorProfiles.name })
        .from(competitorProfiles)
        .where(inArray(competitorProfiles.urn, Array.from(competitorUrns)));
      for (const c of cps) competitorNameMap.set(c.urn, c.name);
    }
    if (playerUrns.size > 0) {
      const pps = await app.db
        .select({ urn: playerProfiles.urn, name: playerProfiles.name })
        .from(playerProfiles)
        .where(inArray(playerProfiles.urn, Array.from(playerUrns)));
      for (const p of pps) playerNameMap.set(p.urn, p.name);
    }

    const distinctMarketIds = Array.from(new Set(rows.map((r) => r.providerMarketId)));
    const marketDescs = distinctMarketIds.length
      ? await app.db
          .select({
            providerMarketId: marketDescriptions.providerMarketId,
            variant: marketDescriptions.variant,
            nameTemplate: marketDescriptions.nameTemplate,
          })
          .from(marketDescriptions)
          .where(inArray(marketDescriptions.providerMarketId, distinctMarketIds))
      : [];
    const outcomeDescs = distinctMarketIds.length
      ? await app.db
          .select({
            providerMarketId: outcomeDescriptions.providerMarketId,
            variant: outcomeDescriptions.variant,
            outcomeId: outcomeDescriptions.outcomeId,
            nameTemplate: outcomeDescriptions.nameTemplate,
          })
          .from(outcomeDescriptions)
          .where(inArray(outcomeDescriptions.providerMarketId, distinctMarketIds))
      : [];

    const descKey = (mid: number, variant: string) => `${mid}:${variant ?? ""}`;
    const marketDescMap = new Map<string, string>();
    for (const d of marketDescs) marketDescMap.set(descKey(d.providerMarketId, d.variant), d.nameTemplate);
    const outcomeDescMap = new Map<string, string>();
    for (const d of outcomeDescs) {
      outcomeDescMap.set(`${d.providerMarketId}:${d.variant ?? ""}:${d.outcomeId}`, d.nameTemplate);
    }

    type MarketRow = {
      id: string;
      providerMarketId: number;
      specifiers: Record<string, string>;
      variant: string;
      name: string;
      baseName: string;
      scope: { id: string; label: string; order: number };
      status: number;
      lastOddinTs: string;
      lineKey: string | null;
      lineSpec: LineSpec | null;
      lineValue: string | null;
      outcomes: Array<{
        outcomeId: string;
        name: string;
        rawName: string;
        publishedOdds: string | null;
        active: boolean;
      }>;
    };
    const marketMap = new Map<string, MarketRow>();

    for (const r of rows) {
      const key = r.marketId.toString();
      let m = marketMap.get(key);
      if (!m) {
        const specs = (r.specifiersJson ?? {}) as Record<string, string>;
        const variant = specs.variant ?? "";
        const template =
          marketDescMap.get(descKey(r.providerMarketId, variant)) ??
          marketDescMap.get(descKey(r.providerMarketId, "")) ??
          `Market #${r.providerMarketId}`;
        const line = lineInfo(r.providerMarketId, variant, specs);
        const baseTemplate = line.lineSpec
          ? stripLinePlaceholder(template, line.lineSpec)
          : template;
        m = {
          id: key,
          providerMarketId: r.providerMarketId,
          specifiers: specs,
          variant,
          name: substituteTemplate(template, specs),
          baseName: substituteTemplate(baseTemplate, specs),
          scope: deriveScope(specs),
          status: r.status,
          lastOddinTs: r.lastOddinTs.toString(),
          lineKey: line.lineKey,
          lineSpec: line.lineSpec,
          lineValue: line.lineValue,
          outcomes: [],
        };
        marketMap.set(key, m);
      }
      if (r.outcomeId) {
        const outcomeTemplate =
          outcomeDescMap.get(`${r.providerMarketId}:${m.variant}:${r.outcomeId}`) ??
          outcomeDescMap.get(`${r.providerMarketId}::${r.outcomeId}`) ??
          r.outcomeName ??
          r.outcomeId;
        // Player/competitor outcomes come off the feed as bare URNs —
        // prefer the cached profile name, fall back to whatever the
        // template resolved (which for team/player outcomes is usually
        // the same URN again). Non-URN outcome ids use the template.
        let resolvedName: string;
        if (r.outcomeId.startsWith("od:competitor:")) {
          resolvedName = competitorNameMap.get(r.outcomeId) ?? r.outcomeId;
        } else if (r.outcomeId.startsWith("od:player:")) {
          resolvedName = playerNameMap.get(r.outcomeId) ?? r.outcomeId;
        } else {
          resolvedName = renderOutcomeLabel(
            outcomeTemplate,
            m.specifiers,
            match.homeTeam,
            match.awayTeam,
          );
        }
        m.outcomes.push({
          outcomeId: r.outcomeId,
          name: resolvedName,
          rawName: r.outcomeName ?? "",
          publishedOdds: formatOdds(r.publishedOdds),
          active: r.active ?? false,
        });
      }
    }

    // Group markets by scope (Match / Map 1 / Map 2 / …). Within a group
    // sort by provider_market_id so a given scope's markets arrive in a
    // stable order on the client.
    const marketList = Array.from(marketMap.values());
    const scopeMap = new Map<string, { id: string; label: string; order: number; markets: MarketRow[] }>();
    for (const m of marketList) {
      const g = scopeMap.get(m.scope.id) ?? { ...m.scope, markets: [] as MarketRow[] };
      g.markets.push(m);
      scopeMap.set(m.scope.id, g);
    }
    const groups = Array.from(scopeMap.values()).sort((a, b) => a.order - b.order);
    for (const g of groups) {
      g.markets.sort((a, b) => a.providerMarketId - b.providerMarketId);
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
      markets: marketList,
      marketGroups: groups,
    };
  });

  // ── Cross-sport match list (powers /live + /upcoming pages) ───────
  // status=live → currently-live matches across every allowed sport
  // status=upcoming → not-started matches sorted by scheduled_at
  //
  // Filters out matches with zero active markets. Oddin's integration
  // broker leaves some matches stuck at status='live' for hours with
  // no corresponding odds flow — those shouldn't appear in the live
  // list because the user can't place a bet on them anyway.
  app.get("/catalog/matches", async (request) => {
    const q = z
      .object({
        status: z.enum(["live", "upcoming"]).default("live"),
        limit: z.coerce.number().int().min(1).max(200).default(80),
      })
      .parse(request.query);

    const cond =
      q.status === "live"
        ? eq(matches.status, "live")
        : eq(matches.status, "not_started");

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
        sportSlug: sports.slug,
        sportName: sports.name,
      })
      .from(matches)
      .innerJoin(tournaments, eq(tournaments.id, matches.tournamentId))
      .innerJoin(categories, eq(categories.id, tournaments.categoryId))
      .innerJoin(sports, eq(sports.id, categories.sportId))
      .where(
        and(
          cond,
          eq(sports.active, true),
          // Exclude phantoms: matches whose `status` is live/not_started
          // but whose markets table has no active (status=1) rows.
          sql`EXISTS (SELECT 1 FROM markets mk WHERE mk.match_id = ${matches.id} AND mk.status = 1)`,
        ),
      )
      .orderBy(
        q.status === "live" ? desc(matches.id) : matches.scheduledAt,
      )
      .limit(q.limit);

    // Reuse the match-winner odds enrichment from /catalog/sports/:slug.
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
          tournament: { id: r.tournamentId, name: r.tournamentName },
          sport: { slug: r.sportSlug, name: r.sportName },
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

  // ── Counts across sports (for homepage live badges) ────────────────
  // Counts only matches with at least one active market — a bare
  // status='live' match with no odds flow is not useful for a badge.
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
        and(
          eq(matches.tournamentId, tournaments.id),
          eq(matches.status, "live"),
          sql`EXISTS (SELECT 1 FROM markets mk WHERE mk.match_id = ${matches.id} AND mk.status = 1)`,
        ),
      )
      .where(eq(sports.active, true))
      .groupBy(sports.slug);
    const counts: Record<string, number> = {};
    for (const r of rows) counts[r.slug] = Number(r.count);
    return counts;
  });
}
