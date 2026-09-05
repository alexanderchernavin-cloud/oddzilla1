// Pulling Sportradar's fixture list.
//
// Sportradar runs two feed hosts and they behave very differently:
//
//   lmt.fn.sportradar.com    — the Live Match Tracker's own data feed.
//                              Licensed per embedding ORIGIN and answers
//                              `403 Unauthorized feed` to anything else,
//                              including a plain server-to-server request
//                              with no Origin header at all. This is why
//                              the tracker is embedded through Sportradar's
//                              hosted standalone page rather than the
//                              widget loader.
//
//   stats.fn.sportradar.com  — the statistics feed. Answers ordinary
//                              server-to-server requests with no token and
//                              no Origin (verified 2026-09-04 across all
//                              17 sports we carry that LMT covers).
//
// The second one carries exactly what the matcher needs, so the mapping
// can be built automatically rather than pasted by hand.
//
//   GET <base>/gismo/sport_matches/<srSportId>/<YYYY-MM-DD>
//
// returns that sport's whole day. Per match: `_id` (the Sportradar match
// id the tracker takes), `_sid` (sport), `_dt.uts` (kickoff, UTC unix),
// `teams.home.name` / `teams.away.name`, and `coverage.lmtsupport`.
//
// NOTE FOR WHOEVER OWNS THE SPORTRADAR RELATIONSHIP: this host is open,
// not bypassed — no credential or licence check is being defeated, and
// Oddzilla is a paying Sportradar customer using it to obtain the ids for
// the widget it bought. Even so, it is worth getting the same written
// confirmation that covers the standalone-page embed. If Sportradar would
// rather we pull from a licensed API once the Client ID exists, only this
// file changes: everything downstream consumes `SportradarFixture`.

import type { SportradarFixture } from "@oddzilla/types/sportradar";

export const DEFAULT_STATS_BASE = "https://stats.fn.sportradar.com/betradar/en/Etc:UTC/gismo";

/** A source of Sportradar fixtures. Implementations differ; callers do not. */
export interface SportradarFixtureSource {
  /** Fixtures for one sport on one UTC day (`YYYY-MM-DD`). */
  fetchDay(srSportId: number, date: string): Promise<SportradarFixture[]>;
}

export class SportradarFetchError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "SportradarFetchError";
  }
}

interface GismoMatch {
  _doc?: string;
  _id?: number;
  _sid?: number;
  _dt?: { uts?: number };
  teams?: {
    home?: { name?: string; mediumname?: string };
    away?: { name?: string; mediumname?: string };
  };
  coverage?: { lmtsupport?: number };
  tobeannounced?: boolean;
  cancelled?: boolean;
  removed?: boolean;
}

/** A match together with the competition the tree filed it under. */
interface CollectedMatch {
  raw: GismoMatch;
  tournament?: string;
}

/**
 * The gismo payload nests matches inside a sport → realcategory →
 * tournament tree whose exact shape varies by sport, so rather than
 * encode that shape we walk for `_doc === "match"`. That is stable
 * across every sport tested and survives them re-arranging the tree.
 *
 * The nearest enclosing `tournament` node's name rides along, because
 * it is the ONLY place this feed says a fixture is women's or youth —
 * the team object is "Chelsea" whether it plays in the Premier League
 * or in "Super League, Women", and the matcher's qualifier veto needs
 * to know which.
 */
function collectMatches(
  node: unknown,
  out: CollectedMatch[],
  depth = 0,
  tournament?: string,
): void {
  // Cheap recursion guard: the real payloads are ~6 levels deep.
  if (depth > 12) return;
  if (Array.isArray(node)) {
    for (const child of node) collectMatches(child, out, depth + 1, tournament);
    return;
  }
  if (typeof node !== "object" || node === null) return;
  const obj = node as Record<string, unknown>;
  if (obj._doc === "match") {
    out.push({ raw: obj as GismoMatch, ...(tournament ? { tournament } : {}) });
    return;
  }
  const here =
    obj._doc === "tournament" && typeof obj.name === "string" && obj.name.trim()
      ? obj.name.trim()
      : tournament;
  for (const child of Object.values(obj)) collectMatches(child, out, depth + 1, here);
}

/** Turn one gismo match into a fixture, or null when it is unusable. */
export function toFixture(
  raw: GismoMatch,
  context: { tournament?: string } = {},
): SportradarFixture | null {
  const srMatchId = raw._id;
  const srSportId = raw._sid;
  const uts = raw._dt?.uts;
  // `name` is the short form Sportradar uses everywhere else ("Everton");
  // `mediumname` is the longer one ("Everton FC"). Prefer `name`, which
  // is what the operator-facing surfaces show.
  const homeTeam = raw.teams?.home?.name ?? raw.teams?.home?.mediumname;
  const awayTeam = raw.teams?.away?.name ?? raw.teams?.away?.mediumname;

  if (
    typeof srMatchId !== "number" ||
    typeof srSportId !== "number" ||
    typeof uts !== "number" ||
    !homeTeam ||
    !awayTeam
  ) {
    return null;
  }
  // A to-be-announced kickoff is a placeholder time; pairing on it would
  // be pairing on noise. Removed fixtures are gone from their side.
  if (raw.tobeannounced === true || raw.removed === true) return null;

  return {
    srMatchId,
    srSportId,
    startsAt: new Date(uts * 1000).toISOString(),
    homeTeam,
    awayTeam,
    ...(context.tournament ? { tournament: context.tournament } : {}),
  };
}

/** Parse a `sport_matches` response body into fixtures. */
export function parseSportMatches(body: unknown): SportradarFixture[] {
  const doc = (body as { doc?: unknown[] } | null)?.doc;
  if (!Array.isArray(doc) || doc.length === 0) return [];
  const first = doc[0] as Record<string, unknown>;
  if (first.event === "exception") {
    const data = first.data as { message?: string } | undefined;
    throw new SportradarFetchError(
      `sportradar feed returned an exception: ${(data?.message ?? "unknown").trim()}`,
    );
  }
  const found: CollectedMatch[] = [];
  collectMatches(first.data, found);
  const fixtures: SportradarFixture[] = [];
  const seen = new Set<number>();
  for (const { raw, tournament } of found) {
    const fixture = toFixture(raw, { tournament });
    // The tree can list the same match under more than one node; the
    // matcher assumes each fixture appears once.
    if (fixture && !seen.has(fixture.srMatchId)) {
      seen.add(fixture.srMatchId);
      fixtures.push(fixture);
    }
  }
  return fixtures;
}

export function createStatsFixtureSource(opts?: {
  baseUrl?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}): SportradarFixtureSource {
  const baseUrl = (opts?.baseUrl ?? DEFAULT_STATS_BASE).replace(/\/+$/u, "");
  const timeoutMs = opts?.timeoutMs ?? 30_000;
  const doFetch = opts?.fetchImpl ?? fetch;

  return {
    async fetchDay(srSportId, date) {
      if (!/^\d{4}-\d{2}-\d{2}$/u.test(date)) {
        throw new SportradarFetchError(`date must be YYYY-MM-DD, got "${date}"`);
      }
      const url = `${baseUrl}/sport_matches/${srSportId}/${date}`;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const res = await doFetch(url, {
          signal: controller.signal,
          headers: {
            // The feed 403s a bare client; it wants a browser-shaped UA.
            "user-agent":
              "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
            accept: "application/json,text/plain,*/*",
          },
        });
        if (!res.ok) {
          throw new SportradarFetchError(
            `sportradar fixtures ${srSportId}/${date} returned HTTP ${res.status}`,
            res.status,
          );
        }
        return parseSportMatches(await res.json());
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
