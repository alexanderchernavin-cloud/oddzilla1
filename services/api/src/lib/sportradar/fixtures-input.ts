// Parsing an operator-supplied batch of Sportradar fixtures.
//
// The matcher needs `SportradarFixture[]`. Where those come from is
// deliberately not the matcher's problem — and today it cannot be an
// automatic pull, because Sportradar's own feed answers `403 Unauthorized
// feed` to anything that is not on a licensed origin. So the operator
// supplies the batch, and this module turns whatever they had to hand
// into the matcher's input.
//
// Three shapes are accepted, all of them things a person can actually
// obtain and paste:
//
//   1. Sportradar's own schedule JSON (`{"sport_events": [...]}`), so the
//      day a licensed API key exists the raw response works unmodified.
//   2. A bare JSON array in this codebase's own SportradarFixture shape.
//   3. Delimited lines — tab, semicolon, pipe or comma:
//        <sr match id> <kickoff> <home> <away> [competition]
//      which is what a copy-paste out of a spreadsheet or a widget page
//      looks like.
//
// The sport is supplied once for the whole batch rather than per row: an
// operator works one sport at a time, and asking per row invites a
// mismatch between the sport id and the fixtures under it.

import type { SportradarFixture } from "@oddzilla/types/sportradar";

export interface ParsedFixtures {
  fixtures: SportradarFixture[];
  /** One entry per input line that could not be read, with the reason. */
  errors: Array<{ line: number; reason: string; raw: string }>;
}

/** `sr:match:72221238` and `72221238` both mean the same fixture. */
function parseSrMatchId(raw: string): number | null {
  const trimmed = raw.trim().replace(/^sr:match:/iu, "");
  if (!/^\d{1,15}$/u.test(trimmed)) return null;
  const n = Number(trimmed);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

function parseKickoff(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  // A bare "2026-09-06 13:00" is unambiguous to a human and ambiguous to
  // Date, which reads it as local time. Normalise to UTC explicitly so a
  // paste means the same thing on the operator's laptop and on the box.
  const naive = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})(:\d{2})?$/u.exec(trimmed);
  const candidate = naive
    ? `${naive[1]}T${naive[2]}${naive[3] ?? ":00"}Z`
    : trimmed;
  const ms = Date.parse(candidate);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

function pickDelimiter(line: string): string {
  for (const sep of ["\t", ";", "|"]) {
    if (line.includes(sep)) return sep;
  }
  return ",";
}

/** Sportradar schedule JSON → our shape. Ignores anything it cannot read. */
function fromSportradarSchedule(
  events: unknown[],
  srSportId: number,
): SportradarFixture[] {
  const out: SportradarFixture[] = [];
  for (const raw of events) {
    if (typeof raw !== "object" || raw === null) continue;
    const ev = raw as Record<string, unknown>;
    const srMatchId = parseSrMatchId(String(ev.id ?? ""));
    const startsAt = parseKickoff(String(ev.start_time ?? ev.scheduled ?? ""));
    const competitors = Array.isArray(ev.competitors) ? ev.competitors : [];
    const named = competitors
      .filter((c): c is Record<string, unknown> => typeof c === "object" && c !== null)
      .map((c) => ({
        name: typeof c.name === "string" ? c.name : "",
        qualifier: typeof c.qualifier === "string" ? c.qualifier : "",
      }));
    const home = named.find((c) => c.qualifier === "home")?.name ?? named[0]?.name ?? "";
    const away = named.find((c) => c.qualifier === "away")?.name ?? named[1]?.name ?? "";
    if (srMatchId === null || startsAt === null || !home || !away) continue;

    const context = ev.sport_event_context;
    let tournament: string | undefined;
    if (typeof context === "object" && context !== null) {
      const competition = (context as Record<string, unknown>).competition;
      if (typeof competition === "object" && competition !== null) {
        const name = (competition as Record<string, unknown>).name;
        if (typeof name === "string") tournament = name;
      }
    }

    out.push({
      srMatchId,
      srSportId,
      startsAt,
      homeTeam: home,
      awayTeam: away,
      ...(tournament ? { tournament } : {}),
    });
  }
  return out;
}

/**
 * Parse an operator-pasted batch. `srSportId` applies to every fixture in
 * the batch; rows carrying their own sport id keep it.
 */
export function parseFixturesInput(
  text: string,
  srSportId: number,
): ParsedFixtures {
  const body = text.trim();
  if (!body) return { fixtures: [], errors: [] };

  if (body.startsWith("{") || body.startsWith("[")) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch (err) {
      return {
        fixtures: [],
        errors: [
          {
            line: 1,
            reason: `not valid JSON: ${(err as Error).message}`,
            raw: body.slice(0, 120),
          },
        ],
      };
    }

    const events =
      Array.isArray(parsed)
        ? parsed
        : Array.isArray((parsed as Record<string, unknown>).sport_events)
          ? ((parsed as Record<string, unknown>).sport_events as unknown[])
          : Array.isArray((parsed as Record<string, unknown>).fixtures)
            ? ((parsed as Record<string, unknown>).fixtures as unknown[])
            : null;
    if (events === null) {
      return {
        fixtures: [],
        errors: [
          {
            line: 1,
            reason: "JSON has no `sport_events` or `fixtures` array",
            raw: body.slice(0, 120),
          },
        ],
      };
    }
    // Both accepted JSON shapes flow through the same reader: our own
    // shape uses `srMatchId`/`homeTeam`, Sportradar's uses
    // `id`/`competitors`, and each field lookup falls back to the other.
    const normalised = events.map((raw) => {
      if (typeof raw !== "object" || raw === null) return raw;
      const ev = raw as Record<string, unknown>;
      if (ev.srMatchId === undefined) return raw;
      return {
        id: ev.srMatchId,
        start_time: ev.startsAt,
        competitors: [
          { name: ev.homeTeam, qualifier: "home" },
          { name: ev.awayTeam, qualifier: "away" },
        ],
        sport_event_context: ev.tournament
          ? { competition: { name: ev.tournament } }
          : undefined,
      };
    });
    return { fixtures: fromSportradarSchedule(normalised, srSportId), errors: [] };
  }

  const fixtures: SportradarFixture[] = [];
  const errors: ParsedFixtures["errors"] = [];
  const lines = body.split(/\r?\n/u);

  lines.forEach((raw, index) => {
    const line = raw.trim();
    if (!line || line.startsWith("#")) return;

    const parts = line.split(pickDelimiter(line)).map((p) => p.trim());
    if (parts.length < 4) {
      errors.push({
        line: index + 1,
        reason: "expected at least 4 fields: id, kickoff, home, away",
        raw: line.slice(0, 120),
      });
      return;
    }

    const srMatchId = parseSrMatchId(parts[0]!);
    if (srMatchId === null) {
      // A header row is the overwhelmingly likely cause of a
      // non-numeric first field on line 1 — skip it, don't report it.
      if (index === 0) return;
      errors.push({
        line: index + 1,
        reason: `"${parts[0]}" is not a Sportradar match id`,
        raw: line.slice(0, 120),
      });
      return;
    }

    const startsAt = parseKickoff(parts[1]!);
    if (startsAt === null) {
      errors.push({
        line: index + 1,
        reason: `"${parts[1]}" is not a readable kickoff time`,
        raw: line.slice(0, 120),
      });
      return;
    }

    const homeTeam = parts[2]!;
    const awayTeam = parts[3]!;
    if (!homeTeam || !awayTeam) {
      errors.push({
        line: index + 1,
        reason: "home or away team is empty",
        raw: line.slice(0, 120),
      });
      return;
    }

    const tournament = parts[4]?.trim();
    fixtures.push({
      srMatchId,
      srSportId,
      startsAt,
      homeTeam,
      awayTeam,
      ...(tournament ? { tournament } : {}),
    });
  });

  return { fixtures, errors };
}
