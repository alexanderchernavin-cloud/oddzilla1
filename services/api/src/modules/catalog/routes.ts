// /catalog endpoints. Read-only; serves the SSR catalog pages, the
// match-details panel, the top-bar global search, and the sidebar
// tournament sub-tree. Public (no auth required).
//
// Routes:
//   GET  /catalog/sports                          active sports
//   GET  /catalog/sports/:slug                    sport + matches (?tournament=N filter)
//   GET  /catalog/sports/:slug/tournaments        tournaments under a sport + live counts
//   GET  /catalog/matches                         cross-sport list (live | upcoming)
//   GET  /catalog/matches/:id                     match + tournament/sport + markets
//   GET  /catalog/search                          global search (sports/tournaments/teams/matches)
//   GET  /catalog/live-counts                     live match counts per sport

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { and, desc, eq, ilike, inArray, notInArray, or, sql } from "drizzle-orm";
import {
  sports,
  categories,
  tournaments,
  competitors,
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
  tournament: z.coerce.number().int().positive().optional(),
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

// Has-active-market guard. Every list/count endpoint runs this so we
// skip matches with zero active markets — there's nothing to bet on,
// the card would render empty. Intentionally lenient: a real live
// match can have its match-winner briefly suspended (mid-round, post-
// goal in football) while secondary markets stay open, and we still
// want the row visible. Phantom-live matches are corrected at the
// source by the phantom_drain sweeper (REST fixture refetch updates
// matches.status to closed/ended), not by filtering them out here.
const hasActiveMarket = sql`EXISTS (
  SELECT 1 FROM markets mk
   WHERE mk.match_id = ${matches.id}
     AND mk.status = 1
)`;

// Tournaments whose name matches one of these strings are hidden from
// every list/count endpoint. Oddin's integration broker exposes test
// tournaments (e.g. "Integration testing" with bot teams "Integration
// testing 1/2") that are useful for protocol verification but never
// belong on the storefront. Match by exact name — these strings are
// stable Oddin constants. The `/catalog/matches/:id` detail route
// intentionally does not filter by this list: hidden tournaments are
// unreachable through the UI anyway, and a deep link should still
// resolve so admin/debug tooling keeps working.
const HIDDEN_TOURNAMENT_NAMES = ["Integration testing"];
const notHiddenTournament = notInArray(tournaments.name, HIDDEN_TOURNAMENT_NAMES);

// Inline match-winner odds for the list cards are restricted to two-way
// markets (`variant='way:two'`). Sports like eFootball expose market 1
// only as a three-way 1X2 (home/draw/away across outcomes 1/2/3). The
// list card has just two columns labelled "1"/"2" — there's no slot for
// the draw — so showing the 1.85/2.70 of a 1X2 looks like a fake 1/2
// price (and depending on PG row ordering can even pair the draw odds
// into the away column). Three-way matches still appear in listings via
// `hasActiveMarket`; they just render without inline buttons and the
// user clicks through to see the full 1X2 on the match page.
const isTwoWayMatchWinner = sql`(${markets.specifiersJson}->>'variant') = 'way:two'`;

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
          // Skip matches with zero active markets — nothing to bet on.
          hasActiveMarket,
          notHiddenTournament,
          q.tournament ? eq(tournaments.id, q.tournament) : undefined,
        ),
      )
      .orderBy(desc(matches.status), matches.scheduledAt)
      .limit(q.limit);

    // Enrich each row with match-winner odds (provider_market_id=1) so the
    // list cards can render prices without an extra round trip per match.
    const matchIds = rows.map((r) => r.matchId);
    const oddsByMatch = new Map<
      string,
      {
        homeMarketId: string;
        homeOutcomeId: string;
        homePrice: string | null;
        homeProbability: string | null;
        awayMarketId: string;
        awayOutcomeId: string;
        awayPrice: string | null;
        awayProbability: string | null;
      }
    >();
    if (matchIds.length > 0) {
      const oddsRows = await app.db
        .select({
          matchId: markets.matchId,
          marketId: markets.id,
          outcomeId: marketOutcomes.outcomeId,
          outcomeName: marketOutcomes.name,
          publishedOdds: marketOutcomes.publishedOdds,
          probability: marketOutcomes.probability,
          active: marketOutcomes.active,
        })
        .from(markets)
        .innerJoin(marketOutcomes, eq(marketOutcomes.marketId, markets.id))
        .where(
          and(
            inArray(markets.matchId, matchIds),
            eq(markets.providerMarketId, 1),
            eq(markets.status, 1),
            isTwoWayMatchWinner,
          ),
        );

      // Pair each match's outcomes by Oddin's canonical outcome_id ("1"
      // = home, "2" = away). The market_outcomes.name column is empty
      // for sport=esports (Oddin sends names only for player-resolved
      // outcomes), so falling back to array index is non-deterministic
      // — PG returns rows in undefined order without ORDER BY.
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
        const home = outs.find((o) => o.outcomeId === "1");
        const away = outs.find((o) => o.outcomeId === "2");
        if (!home || !away) continue;
        oddsByMatch.set(key, {
          homeMarketId: home.marketId.toString(),
          homeOutcomeId: home.outcomeId,
          homePrice: home.active ? home.publishedOdds : null,
          // Probability is metadata — keep it independent of `active`. The
          // bet slip uses it for tiple/tippot preview; a suspended price
          // shouldn't blank the pricing context.
          homeProbability: home.probability ?? null,
          awayMarketId: away.marketId.toString(),
          awayOutcomeId: away.outcomeId,
          awayPrice: away.active ? away.publishedOdds : null,
          awayProbability: away.probability ?? null,
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
                home: {
                  outcomeId: o.homeOutcomeId,
                  price: formatOdds(o.homePrice),
                  probability: o.homeProbability,
                },
                away: {
                  outcomeId: o.awayOutcomeId,
                  price: formatOdds(o.awayPrice),
                  probability: o.awayProbability,
                },
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

    // Phantom-live trip wire. Oddin's integration broker sometimes leaves
    // a match flagged `live` for hours (or, in extreme cases, years) after
    // the real fixture is over — usually because we missed a
    // match_status_change during a recovery gap. If a match still says
    // `live` more than 6 h after its scheduled start, ask the feed
    // ingester to re-fetch the fixture from REST. Feed-ingester dedupes
    // per-URN so repeated detail-page hits don't hammer Oddin.
    if (
      match.status === "live" &&
      match.providerUrn &&
      match.scheduledAt &&
      Date.now() - match.scheduledAt.getTime() > 6 * 60 * 60 * 1000
    ) {
      const urn = match.providerUrn;
      void app.db
        .execute(sql`SELECT pg_notify('fixture_refresh', ${urn})`)
        .catch((err) => {
          app.log.warn(
            { err, urn },
            "fixture_refresh notify failed",
          );
        });
    }

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
        probability: marketOutcomes.probability,
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
        probability: string | null;
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
          probability: r.probability ?? null,
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
          hasActiveMarket,
          notHiddenTournament,
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
      {
        homeMarketId: string;
        homeOutcomeId: string;
        homePrice: string | null;
        homeProbability: string | null;
        awayMarketId: string;
        awayOutcomeId: string;
        awayPrice: string | null;
        awayProbability: string | null;
      }
    >();
    if (matchIds.length > 0) {
      const oddsRows = await app.db
        .select({
          matchId: markets.matchId,
          marketId: markets.id,
          outcomeId: marketOutcomes.outcomeId,
          outcomeName: marketOutcomes.name,
          publishedOdds: marketOutcomes.publishedOdds,
          probability: marketOutcomes.probability,
          active: marketOutcomes.active,
        })
        .from(markets)
        .innerJoin(marketOutcomes, eq(marketOutcomes.marketId, markets.id))
        .where(
          and(
            inArray(markets.matchId, matchIds),
            eq(markets.providerMarketId, 1),
            eq(markets.status, 1),
            isTwoWayMatchWinner,
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
        const home = outs.find((o) => o.outcomeId === "1");
        const away = outs.find((o) => o.outcomeId === "2");
        if (!home || !away) continue;
        oddsByMatch.set(key, {
          homeMarketId: home.marketId.toString(),
          homeOutcomeId: home.outcomeId,
          homePrice: home.active ? home.publishedOdds : null,
          homeProbability: home.probability ?? null,
          awayMarketId: away.marketId.toString(),
          awayOutcomeId: away.outcomeId,
          awayPrice: away.active ? away.publishedOdds : null,
          awayProbability: away.probability ?? null,
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
                home: {
                  outcomeId: o.homeOutcomeId,
                  price: formatOdds(o.homePrice),
                  probability: o.homeProbability,
                },
                away: {
                  outcomeId: o.awayOutcomeId,
                  price: formatOdds(o.awayPrice),
                  probability: o.awayProbability,
                },
              }
            : null,
        };
      }),
    };
  });

  // ── Tournaments under a sport (for sidebar expansion) ──────────────
  // Returns active tournaments under the sport with at least one
  // live/upcoming match that still has active markets — empty
  // tournaments (every match closed/cancelled or phantom-stale) are
  // filtered out so the sidebar never lists a tournament that produces
  // an empty page when clicked. `matchCount` uses the same phantom
  // filter as /catalog/sports/:slug. Sort: risk_tier desc (higher-tier
  // tournaments at the top, NULLs last so unbackfilled rows don't
  // crowd out the ones we know about), then matches-with-action first,
  // then alphabetical.
  app.get("/catalog/sports/:slug/tournaments", async (request) => {
    const params = z.object({ slug: z.string().min(1).max(32) }).parse(request.params);
    const [sport] = await app.db
      .select()
      .from(sports)
      .where(and(eq(sports.slug, params.slug), eq(sports.active, true)))
      .limit(1);
    if (!sport) throw new NotFoundError("sport_not_found", "sport_not_found");

    const matchCountExpr = sql<string>`COUNT(DISTINCT ${matches.id}) FILTER (
      WHERE ${matches.status} IN ('not_started','live')
        AND ${hasActiveMarket}
    )::text`;
    const rows = await app.db
      .select({
        id: tournaments.id,
        name: tournaments.name,
        riskTier: tournaments.riskTier,
        matchCount: matchCountExpr,
      })
      .from(tournaments)
      .innerJoin(categories, eq(categories.id, tournaments.categoryId))
      .leftJoin(matches, eq(matches.tournamentId, tournaments.id))
      .where(
        and(
          eq(categories.sportId, sport.id),
          eq(tournaments.active, true),
          notHiddenTournament,
        ),
      )
      .groupBy(tournaments.id, tournaments.name, tournaments.riskTier)
      .having(sql`${matchCountExpr}::int > 0`);

    const tournamentsOut = rows
      .map((r) => ({
        id: r.id,
        name: r.name,
        riskTier: r.riskTier,
        matchCount: Number(r.matchCount),
      }))
      .sort((a, b) => {
        const at = a.riskTier ?? -Infinity;
        const bt = b.riskTier ?? -Infinity;
        if (at !== bt) return bt - at;
        if (a.matchCount !== b.matchCount) return b.matchCount - a.matchCount;
        return a.name.localeCompare(b.name);
      });

    return {
      sport: { id: sport.id, slug: sport.slug, name: sport.name },
      tournaments: tournamentsOut,
    };
  });

  // ── Global search across sports, tournaments, teams, and matches ───
  // Case-insensitive substring match. Each facet is capped at `limit`
  // rows (default 6). Only active rows are returned, and matches are
  // restricted to not_started/live with at least one active market so
  // clicking through lands on a page where the user can place a bet.
  app.get("/catalog/search", async (request) => {
    const q = z
      .object({
        q: z.string().trim().min(1).max(64),
        limit: z.coerce.number().int().min(1).max(20).default(6),
      })
      .parse(request.query);

    // Escape ILIKE wildcards so a user typing "50%" doesn't match
    // everything. pg's default escape is "\", reinforced with ESCAPE '\'.
    const escaped = q.q.replace(/[\\%_]/g, (c) => `\\${c}`);
    const needle = `%${escaped}%`;

    const [sportRows, tournamentRows, teamRows, matchRows] = await Promise.all([
      app.db
        .select({ slug: sports.slug, name: sports.name, kind: sports.kind })
        .from(sports)
        .where(
          and(
            eq(sports.active, true),
            or(ilike(sports.name, needle), ilike(sports.slug, needle)),
          ),
        )
        .orderBy(sports.name)
        .limit(q.limit),

      app.db
        .select({
          id: tournaments.id,
          name: tournaments.name,
          sportSlug: sports.slug,
          sportName: sports.name,
        })
        .from(tournaments)
        .innerJoin(categories, eq(categories.id, tournaments.categoryId))
        .innerJoin(sports, eq(sports.id, categories.sportId))
        .where(
          and(
            eq(tournaments.active, true),
            eq(sports.active, true),
            ilike(tournaments.name, needle),
            notHiddenTournament,
            // Empty tournaments (every match closed/phantom-stale) are
            // hidden so search results never lead to a zero-match page.
            sql`EXISTS (
              SELECT 1 FROM ${matches} mm
               WHERE mm.tournament_id = ${tournaments.id}
                 AND mm.status IN ('not_started','live')
                 AND EXISTS (
                   SELECT 1 FROM markets mk
                    WHERE mk.match_id = mm.id
                      AND mk.status = 1
                 )
            )`,
          ),
        )
        .orderBy(tournaments.name)
        .limit(q.limit),

      app.db
        .select({
          id: competitors.id,
          name: competitors.name,
          abbreviation: competitors.abbreviation,
          sportSlug: sports.slug,
          sportName: sports.name,
        })
        .from(competitors)
        .innerJoin(sports, eq(sports.id, competitors.sportId))
        .where(
          and(
            eq(competitors.active, true),
            eq(sports.active, true),
            or(
              ilike(competitors.name, needle),
              ilike(competitors.abbreviation, needle),
            ),
          ),
        )
        .orderBy(competitors.name)
        .limit(q.limit),

      app.db
        .select({
          id: matches.id,
          homeTeam: matches.homeTeam,
          awayTeam: matches.awayTeam,
          scheduledAt: matches.scheduledAt,
          status: matches.status,
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
            eq(sports.active, true),
            inArray(matches.status, ["not_started", "live"]),
            or(
              ilike(matches.homeTeam, needle),
              ilike(matches.awayTeam, needle),
            ),
            hasActiveMarket,
            notHiddenTournament,
          ),
        )
        .orderBy(desc(matches.status), matches.scheduledAt)
        .limit(q.limit),
    ]);

    return {
      query: q.q,
      sports: sportRows,
      tournaments: tournamentRows.map((t) => ({
        id: t.id,
        name: t.name,
        sport: { slug: t.sportSlug, name: t.sportName },
      })),
      teams: teamRows.map((t) => ({
        id: t.id,
        name: t.name,
        abbreviation: t.abbreviation,
        sport: { slug: t.sportSlug, name: t.sportName },
      })),
      matches: matchRows.map((m) => ({
        id: m.id.toString(),
        homeTeam: m.homeTeam,
        awayTeam: m.awayTeam,
        scheduledAt: m.scheduledAt?.toISOString() ?? null,
        status: m.status,
        tournament: { id: m.tournamentId, name: m.tournamentName },
        sport: { slug: m.sportSlug, name: m.sportName },
      })),
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
      .leftJoin(
        tournaments,
        and(
          eq(tournaments.categoryId, categories.id),
          notHiddenTournament,
        ),
      )
      .leftJoin(
        matches,
        and(
          eq(matches.tournamentId, tournaments.id),
          eq(matches.status, "live"),
          hasActiveMarket,
        ),
      )
      .where(eq(sports.active, true))
      .groupBy(sports.slug);
    const counts: Record<string, number> = {};
    for (const r of rows) counts[r.slug] = Number(r.count);
    return counts;
  });
}
