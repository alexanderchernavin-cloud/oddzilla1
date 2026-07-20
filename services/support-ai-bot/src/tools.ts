// Read-only tools the assistant can call to fetch live platform data on demand.
// They hit Oddzilla's existing PUBLIC catalog endpoints (no secret needed) and
// return compact JSON. There are deliberately NO mutating tools — the bot can
// look anything up but can never change anything.

import type { BotConfig } from "./config.js";
import type { ToolSpec } from "./lmstudio.js";

export const TOOLS: ToolSpec[] = [
  {
    type: "function",
    function: {
      name: "find_matches",
      description:
        "Search Oddzilla for matches, teams, or tournaments by name (a team like 'Team Spirit', a tournament, or a sport). Returns matching upcoming and live matches with start times (UTC), status, tournament and sport, plus their match ids. Use this for schedule questions ('when does X play', 'what's on'), or to get a match id before looking up its odds.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "a team, tournament, or sport name",
          },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "match_markets",
      description:
        "Get the current betting markets and odds for one match by its numeric match id (obtained from find_matches). Use for odds / market questions ('what are the odds for X', 'what can I bet on for this match').",
      parameters: {
        type: "object",
        properties: {
          matchId: { type: "string", description: "numeric match id" },
        },
        required: ["matchId"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "team_results",
      description:
        "Get a team's recent FINISHED matches and whether they won or lost each. Use for history / form questions ('when did X last win or lose', 'X's recent results', recent head-to-head). Takes a team name.",
      parameters: {
        type: "object",
        properties: {
          team: { type: "string", description: "a team name" },
          sport: {
            type: "string",
            description:
              "optional game/sport slug (e.g. cs2, lol, valorant, dota2, rocketleague) — include it once you know which game the question is about, since one team name can be a different team in different games",
          },
        },
        required: ["team"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "web_search",
      description:
        "Look up general factual / background / historical information from the public web (Wikipedia) that is NOT in Oddzilla's own data — e.g. who won a past tournament, a Major's champion or results, background on a team / player / event, how a game or format works, definitions. Returns the top matching articles with a short extract and a source URL. Use this for facts Oddzilla's own tools (find_matches / match_markets / team_results) cannot provide. Do NOT use it for this bettor's account, Oddzilla schedule / odds, or to give betting tips.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description:
              "a CONCISE KEYWORD query naming the subject — the event/team/person plus any year or qualifier — NOT a full question. Good: 'IEM Cologne Major 2026', 'Team Spirit Dota 2'. Bad: 'who won the IEM Cologne 2026?'.",
          },
        },
        required: ["query"],
      },
    },
  },
];

const FETCH_TIMEOUT_MS = 15_000;

interface SearchResponse {
  sports?: Array<{ slug: string; name: string }>;
  teams?: Array<{ id: number; name: string; sport?: { slug?: string } }>;
  matches?: Array<{
    id: string;
    homeTeam: string;
    awayTeam: string;
    sport?: { slug?: string };
    tournament?: { name?: string };
    scheduledAt: string;
    status: string;
  }>;
}

interface SportMatchesResponse {
  matches?: Array<{
    id: string;
    homeTeam: string;
    awayTeam: string;
    tournament?: { name?: string };
    scheduledAt: string;
    status: string;
  }>;
}

interface MatchResponse {
  match?: {
    homeTeam?: string;
    awayTeam?: string;
    sport?: { slug?: string };
    status?: string;
    scheduledAt?: string;
  };
  markets?: Array<{
    name?: string;
    providerMarketId?: number;
    status?: number;
    outcomes?: Array<{ name?: string; publishedOdds?: string; active?: boolean }>;
  }>;
}

interface TeamResultsResponse {
  team: string | null;
  sport: string | null;
  results: Array<{
    playedAt: string;
    opponent: string;
    sport: string;
    tournament: string;
    result: string;
  }>;
}

async function getJson(
  url: string,
  headers?: Record<string, string>,
): Promise<unknown> {
  const res = await fetch(url, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    headers,
  });
  if (!res.ok) throw new Error(`http_${res.status}`);
  return (await res.json()) as unknown;
}

// Wikipedia identifies API clients by User-Agent; send a descriptive one.
const WEB_SEARCH_UA = "OddzillaSupportBot/1.0 (+https://oddzilla.cc)";

interface WikiResponse {
  query?: {
    pages?: Record<
      string,
      { pageid?: number; index?: number; title: string; extract?: string }
    >;
  };
}

export async function executeTool(
  cfg: BotConfig,
  name: string,
  argsJson: string,
): Promise<string> {
  let args: Record<string, unknown> = {};
  try {
    args = JSON.parse(argsJson || "{}") as Record<string, unknown>;
  } catch {
    // leave args empty
  }

  try {
    if (name === "find_matches") {
      const q = String(args.query ?? "").slice(0, 80);
      const body = (await getJson(
        `${cfg.apiBase}/catalog/search?q=${encodeURIComponent(q)}`,
      )) as SearchResponse;
      const sports = (body.sports ?? []).slice(0, 5);
      let matches = (body.matches ?? []).slice(0, 15).map((m) => ({
        id: m.id,
        match: `${m.homeTeam} vs ${m.awayTeam}`,
        sport: m.sport?.slug ?? "",
        tournament: m.tournament?.name ?? "",
        scheduledAt: m.scheduledAt,
        status: m.status,
      }));
      // The search endpoint's match facet only matches TEAM names — a sport
      // query ("cs2", "valorant") hits the sports facet but returns zero
      // matches. When that happens, pull each matched sport's actual
      // upcoming/live schedule so schedule questions get real data.
      if (matches.length === 0 && sports.length > 0) {
        const lists = await Promise.all(
          sports.slice(0, 3).map(async (s) => {
            try {
              const sportBody = (await getJson(
                `${cfg.apiBase}/catalog/sports/${encodeURIComponent(s.slug)}`,
              )) as SportMatchesResponse;
              return (sportBody.matches ?? []).map((m) => ({
                id: m.id,
                match: `${m.homeTeam} vs ${m.awayTeam}`,
                sport: s.slug,
                tournament: m.tournament?.name ?? "",
                scheduledAt: m.scheduledAt,
                status: m.status,
              }));
            } catch {
              return [];
            }
          }),
        );
        matches = lists.flat().slice(0, 15);
      }
      const teams = (body.teams ?? []).slice(0, 10).map((t) => ({
        id: t.id,
        name: t.name,
        sport: t.sport?.slug ?? "",
      }));
      return JSON.stringify({ sports, teams, matches });
    }

    if (name === "match_markets") {
      const id = String(args.matchId ?? "").replace(/[^0-9]/g, "");
      if (!id) return JSON.stringify({ error: "invalid_match_id" });
      const body = (await getJson(
        `${cfg.apiBase}/catalog/matches/${id}`,
      )) as MatchResponse;
      const m = body.match ?? {};
      const markets = (body.markets ?? [])
        .filter((mk) => mk.status === 1)
        .slice(0, 12)
        .map((mk) => ({
          market: mk.name ?? `Market #${mk.providerMarketId ?? "?"}`,
          outcomes: (mk.outcomes ?? [])
            .filter((o) => o.active)
            .slice(0, 8)
            .map((o) => ({ pick: o.name ?? "", odds: o.publishedOdds ?? "" })),
        }));
      return JSON.stringify({
        match: `${m.homeTeam ?? "?"} vs ${m.awayTeam ?? "?"}`,
        sport: m.sport?.slug ?? "",
        status: m.status ?? "",
        scheduledAt: m.scheduledAt ?? "",
        markets,
      });
    }

    if (name === "team_results") {
      const team = String(args.team ?? "").slice(0, 80);
      if (!team) return JSON.stringify({ error: "invalid_team" });
      const sport = String(args.sport ?? "").slice(0, 40);
      let url = `${cfg.apiBase}/webhooks/support-ai/${encodeURIComponent(
        cfg.botToken,
      )}/tools/team-results?q=${encodeURIComponent(team)}&limit=12`;
      if (sport) url += `&sport=${encodeURIComponent(sport)}`;
      const body = (await getJson(url)) as TeamResultsResponse;
      return JSON.stringify(body);
    }

    if (name === "web_search") {
      const raw = String(args.query ?? "").slice(0, 200);
      if (!raw.trim()) return JSON.stringify({ error: "invalid_query" });
      // Wikipedia full-text search ranks keyword queries far better than
      // question phrasings — "who won IEM Cologne 2026?" and even a trailing
      // "winner" bury the actual tournament page (they pull the generic series
      // article + player pages). So reduce the query to its subject: strip a
      // leading question stem, a trailing run of answer-type words
      // (winner/champion/result/…), and the trailing "?".
      const q =
        raw
          .replace(
            /^\s*(who|what|which|when|where|why|whom|whose|how)\b[\s,]*(won|win|wins|is|was|were|are|did|do|does|had|has|have)?\s+/i,
            "",
          )
          .replace(/\?+\s*$/, "")
          .replace(
            /[\s,]*(?:\b(?:won|win|wins|winner|winners|champion|champions|result|results|mvp|outcome)\b[\s,]*)+$/i,
            "",
          )
          .replace(/\s+/g, " ")
          .trim() || raw.trim();
      // One call: search Wikipedia and pull the intro extract of the top hits.
      const url =
        `${cfg.wikipediaApiBase}?action=query&format=json&redirects=1` +
        `&generator=search&gsrsearch=${encodeURIComponent(q)}&gsrlimit=5` +
        `&prop=extracts&exintro=1&explaintext=1&exlimit=5`;
      const body = (await getJson(url, {
        "user-agent": WEB_SEARCH_UA,
        accept: "application/json",
      })) as WikiResponse;
      const results = Object.values(body.query?.pages ?? {})
        .sort((a, b) => (a.index ?? 99) - (b.index ?? 99))
        .map((p) => ({
          title: p.title,
          url: `https://en.wikipedia.org/wiki/${encodeURIComponent(
            p.title.replace(/ /g, "_"),
          )}`,
          extract: (p.extract ?? "").replace(/\s+/g, " ").trim().slice(0, 1500),
        }))
        .filter((p) => p.extract)
        .slice(0, 4);
      return JSON.stringify({ query: q, source: "wikipedia", results });
    }
  } catch (err) {
    return JSON.stringify({ error: `tool_failed: ${(err as Error).message}` });
  }

  return JSON.stringify({ error: `unknown_tool: ${name}` });
}
