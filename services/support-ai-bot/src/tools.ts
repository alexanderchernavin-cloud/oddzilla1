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
];

const FETCH_TIMEOUT_MS = 15_000;

interface SearchResponse {
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

async function getJson(url: string): Promise<unknown> {
  const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`http_${res.status}`);
  return (await res.json()) as unknown;
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
      const matches = (body.matches ?? []).slice(0, 15).map((m) => ({
        id: m.id,
        match: `${m.homeTeam} vs ${m.awayTeam}`,
        sport: m.sport?.slug ?? "",
        tournament: m.tournament?.name ?? "",
        scheduledAt: m.scheduledAt,
        status: m.status,
      }));
      const teams = (body.teams ?? []).slice(0, 10).map((t) => ({
        id: t.id,
        name: t.name,
        sport: t.sport?.slug ?? "",
      }));
      return JSON.stringify({ teams, matches });
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
  } catch (err) {
    return JSON.stringify({ error: `tool_failed: ${(err as Error).message}` });
  }

  return JSON.stringify({ error: `unknown_tool: ${name}` });
}
