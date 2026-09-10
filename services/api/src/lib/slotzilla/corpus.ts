// SlotZilla calibration corpus — pulling finished basketball games'
// play-by-play from Sportradar's open statistics host into
// `sr_live_events` so the calibrator has rounds to measure.
//
// Same host, same fetch discipline as lib/sportradar/fixture-source.ts:
// `stats.fn.sportradar.com` answers ordinary server-to-server requests
// with no token, but it wants a browser-shaped User-Agent (a bare
// client 403s), and an error is an HTTP 200 whose `doc[0].event` is
// "exception". Two endpoints:
//
//   sport_matches/<srSportId>/<YYYY-MM-DD>   a sport's whole day, with
//                                             `status.name` / `ended_uts`
//   match_timeline/<srMatchId>               every event of one match
//
// Corpus rows carry `match_id NULL` — an archived game has no fixture of
// ours — and are keyed on Sportradar's own event id, so re-fetching a
// match is a no-op at the row level. The live engine (services/slotzilla)
// writes the same table for the games it runs; those rows count in the
// corpus too.

import { sql } from "drizzle-orm";
import { srLiveEvents, type DbClient } from "@oddzilla/db";
import {
  isSlotSymbol,
  symbolForEvent,
  type SlotSymbol,
  type SlotTeam,
} from "@oddzilla/types/slotzilla";
import { DEFAULT_STATS_BASE, SportradarFetchError } from "../sportradar/fixture-source.js";
import type { CorpusEvent } from "./calibrator.js";

// Re-exported so callers of this module need not know where the
// constant lives.
export { DEFAULT_STATS_BASE };

const BROWSER_UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36";

// ── Parsed shapes ───────────────────────────────────────────────────────

/** The match header of a timeline document. */
export interface TimelineMatch {
  srMatchId: string;
  srSportId: number | null;
  homeTeam: string | null;
  awayTeam: string | null;
  /** Cumulative match-clock seconds as last read, null before tip-off. */
  playedSeconds: number | null;
  running: boolean;
  started: boolean;
  ended: boolean;
  period: number | null;
  coverageLevel: number | null;
  result: { home: number | null; away: number | null };
}

/** One clock-bearing event, ready for an `sr_live_events` row. */
export interface TimelineEvent {
  srEventId: string;
  srMatchId: string;
  type: string;
  name: string | null;
  symbol: Exclude<SlotSymbol, "NONE"> | null;
  team: SlotTeam | null;
  points: number | null;
  seconds: number;
  uts: number;
  updatedUts: number;
  disabled: boolean;
  period: number | null;
  playerId: string | null;
  playerName: string | null;
  raw: Record<string, unknown>;
}

export interface ParsedTimeline {
  /** Unix seconds the document was built (`_dob`). */
  dob: number | null;
  match: TimelineMatch;
  events: TimelineEvent[];
}

/** A match on a sport's day list, as the corpus fetcher judges it. */
export interface DayMatch {
  srMatchId: string;
  srSportId: number | null;
  startsAtUts: number | null;
  ended: boolean;
}

// ── Envelope ────────────────────────────────────────────────────────────

/**
 * The first document of a gismo envelope, or a thrown
 * SportradarFetchError when the feed answered with an exception.
 */
export function unwrapEnvelope(body: unknown): Record<string, unknown> {
  const doc = (body as { doc?: unknown[] } | null)?.doc;
  if (!Array.isArray(doc) || doc.length === 0) {
    throw new SportradarFetchError("sportradar feed returned an empty envelope");
  }
  const first = doc[0] as Record<string, unknown>;
  if (first.event === "exception") {
    const data = first.data as { message?: string } | undefined;
    throw new SportradarFetchError(
      `sportradar feed returned an exception: ${(data?.message ?? "unknown").trim()}`,
    );
  }
  return first;
}

function asInt(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return Math.trunc(v);
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    return Number.isFinite(n) ? Math.trunc(n) : null;
  }
  return null;
}

function asIdString(v: unknown): string | null {
  if (typeof v === "number" && Number.isSafeInteger(v)) return String(v);
  if (typeof v === "string" && /^\d+$/u.test(v)) return v;
  return null;
}

function asTeam(v: unknown): SlotTeam | null {
  return v === "home" || v === "away" ? v : null;
}

function readCoverageLevel(match: Record<string, unknown>): number | null {
  const live = (match.coverage as { live?: { level?: { value?: unknown } } } | undefined)?.live;
  return asInt(live?.level?.value);
}

function readStatusName(match: Record<string, unknown>): string | null {
  const status = match.status;
  if (typeof status === "object" && status !== null) {
    const name = (status as { name?: unknown }).name;
    return typeof name === "string" ? name : null;
  }
  return null;
}

function isEndedMatch(match: Record<string, unknown>): boolean {
  if (readStatusName(match) === "Ended") return true;
  const timeinfo = match.timeinfo as { ended?: unknown } | undefined;
  if (timeinfo && timeinfo.ended && timeinfo.ended !== "0") return true;
  const endedUts = match.ended_uts;
  return typeof endedUts === "number" && endedUts > 0;
}

// ── match_timeline ──────────────────────────────────────────────────────

/** Parse a `match_timeline` (or `match_timelinedelta`) response body. */
export function parseTimeline(body: unknown): ParsedTimeline {
  const first = unwrapEnvelope(body);
  const data = (first.data ?? {}) as { match?: unknown; events?: unknown };
  const match = (data.match ?? {}) as Record<string, unknown>;
  const srMatchId = asIdString(match._id);
  if (!srMatchId) throw new SportradarFetchError("timeline document carries no match id");

  const timeinfo = (match.timeinfo ?? {}) as Record<string, unknown>;
  const teams = (match.teams ?? {}) as {
    home?: { name?: unknown };
    away?: { name?: unknown };
  };
  const result = (match.result ?? {}) as { home?: unknown; away?: unknown };

  const header: TimelineMatch = {
    srMatchId,
    srSportId: asInt(match._sid),
    homeTeam: typeof teams.home?.name === "string" ? teams.home.name : null,
    awayTeam: typeof teams.away?.name === "string" ? teams.away.name : null,
    playedSeconds: asInt(timeinfo.played),
    running: timeinfo.running === true,
    started: Boolean(timeinfo.started) && timeinfo.started !== "0",
    ended: isEndedMatch(match),
    period: asInt(match.p),
    coverageLevel: readCoverageLevel(match),
    result: { home: asInt(result.home), away: asInt(result.away) },
  };

  const events: TimelineEvent[] = [];
  const rawEvents = Array.isArray(data.events) ? data.events : [];
  for (const rawEvent of rawEvents) {
    const parsed = parseEvent(rawEvent, srMatchId);
    if (parsed) events.push(parsed);
  }
  return { dob: asInt(first._dob), match: header, events };
}

/**
 * One timeline event, or null when it carries no clock reading
 * (`seconds < 0`: period starts, clock stops, possession changes) or
 * no usable id. Non-clock events cannot fall inside a window and are
 * not stored.
 */
export function parseEvent(raw: unknown, srMatchId: string): TimelineEvent | null {
  if (typeof raw !== "object" || raw === null) return null;
  const e = raw as Record<string, unknown>;
  const srEventId = asIdString(e._id);
  const seconds = asInt(e.seconds);
  if (!srEventId || seconds === null || seconds < 0) return null;
  const type = typeof e.type === "string" ? e.type : null;
  if (!type) return null;
  const uts = asInt(e.uts) ?? 0;
  const updatedUts = asInt(e.updated_uts) ?? uts;
  const points = asInt(e.points);
  const player = e.player as { _id?: unknown; name?: unknown } | null | undefined;
  const scorer = e.scorer as { _id?: unknown; name?: unknown } | null | undefined;
  const who = scorer && typeof scorer === "object" ? scorer : player;
  return {
    srEventId,
    srMatchId,
    type,
    name: typeof e.name === "string" ? e.name : null,
    symbol: symbolForEvent({ type, points }),
    team: asTeam(e.team),
    points,
    seconds,
    uts,
    updatedUts,
    disabled: e.disabled === 1 || e.disabled === true || e.disabled === "1",
    period: asInt(e.period),
    playerId: who ? asIdString(who._id) : null,
    playerName: who && typeof who.name === "string" ? who.name : null,
    raw: e,
  };
}

// ── sport_matches ───────────────────────────────────────────────────────

/**
 * The matches of a `sport_matches` day, with whether each has ended.
 * Walks the sport -> category -> tournament tree for `_doc === "match"`
 * like the fixture source does, since the shape varies by sport.
 */
export function parseSportDay(body: unknown, nowUts = Math.floor(Date.now() / 1000)): DayMatch[] {
  const first = unwrapEnvelope(body);
  const found: Record<string, unknown>[] = [];
  collectMatches(first.data, found);
  const out: DayMatch[] = [];
  const seen = new Set<string>();
  for (const m of found) {
    const srMatchId = asIdString(m._id);
    if (!srMatchId || seen.has(srMatchId)) continue;
    seen.add(srMatchId);
    const startsAtUts = asInt((m._dt as { uts?: unknown } | undefined)?.uts);
    const result = (m.result ?? {}) as { home?: unknown; away?: unknown };
    const hasResult = asInt(result.home) !== null && asInt(result.away) !== null;
    // Ended by Sportradar's own word, or kicked off in the past with a
    // final score on the row — the day list sometimes lags the status.
    const ended =
      isEndedMatch(m) || (startsAtUts !== null && startsAtUts < nowUts - 3 * 3600 && hasResult);
    out.push({ srMatchId, srSportId: asInt(m._sid), startsAtUts, ended });
  }
  return out;
}

function collectMatches(node: unknown, out: Record<string, unknown>[], depth = 0): void {
  if (depth > 12) return;
  if (Array.isArray(node)) {
    for (const child of node) collectMatches(child, out, depth + 1);
    return;
  }
  if (typeof node !== "object" || node === null) return;
  const obj = node as Record<string, unknown>;
  if (obj._doc === "match") {
    out.push(obj);
    return;
  }
  for (const child of Object.values(obj)) collectMatches(child, out, depth + 1);
}

// ── Fetching ────────────────────────────────────────────────────────────

export interface CorpusClientOptions {
  baseUrl?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export interface CorpusClient {
  fetchDay(srSportId: number, date: string): Promise<DayMatch[]>;
  fetchTimeline(srMatchId: string): Promise<ParsedTimeline>;
}

export function createCorpusClient(opts: CorpusClientOptions = {}): CorpusClient {
  const baseUrl = (opts.baseUrl ?? DEFAULT_STATS_BASE).replace(/\/+$/u, "");
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const doFetch = opts.fetchImpl ?? fetch;

  async function getJson(path: string): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await doFetch(`${baseUrl}/${path}`, {
        signal: controller.signal,
        headers: { "user-agent": BROWSER_UA, accept: "application/json,text/plain,*/*" },
      });
      if (!res.ok) {
        throw new SportradarFetchError(`sportradar ${path} returned HTTP ${res.status}`, res.status);
      }
      return await res.json();
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    async fetchDay(srSportId, date) {
      if (!/^\d{4}-\d{2}-\d{2}$/u.test(date)) {
        throw new SportradarFetchError(`date must be YYYY-MM-DD, got "${date}"`);
      }
      return parseSportDay(await getJson(`sport_matches/${srSportId}/${date}`));
    },
    async fetchTimeline(srMatchId) {
      if (!/^\d+$/u.test(srMatchId)) {
        throw new SportradarFetchError(`match id must be numeric, got "${srMatchId}"`);
      }
      return parseTimeline(await getJson(`match_timeline/${srMatchId}`));
    },
  };
}

// ── Corpus fetch (the admin route and the script share this) ────────────

export interface CorpusFetchParams {
  /** Inclusive UTC day range, YYYY-MM-DD. */
  from: string;
  to: string;
  srSportId?: number;
  maxMatches?: number;
}

export interface CorpusFetchResult {
  matchesSeen: number;
  matchesFetched: number;
  eventsInserted: number;
  skipped: number;
}

export interface CorpusLogger {
  info(obj: Record<string, unknown>, msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
}

const MAX_DAYS = 62;
const INSERT_CHUNK = 500;

/** Every UTC day from `from` to `to` inclusive. */
export function dayRange(from: string, to: string): string[] {
  const start = Date.parse(`${from}T00:00:00Z`);
  const end = Date.parse(`${to}T00:00:00Z`);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) {
    throw new RangeError(`invalid day range ${from}..${to}`);
  }
  const days: string[] = [];
  for (let t = start; t <= end && days.length < MAX_DAYS; t += 86_400_000) {
    days.push(new Date(t).toISOString().slice(0, 10));
  }
  return days;
}

/** Map a parsed event onto an `sr_live_events` insert row. */
export function toEventRow(e: TimelineEvent, matchId: bigint | null = null) {
  return {
    srEventId: BigInt(e.srEventId),
    srMatchId: BigInt(e.srMatchId),
    matchId,
    type: e.type,
    symbol: e.symbol,
    team: e.team,
    points: e.points,
    seconds: e.seconds,
    uts: BigInt(e.uts),
    updatedUts: BigInt(e.updatedUts),
    disabled: e.disabled,
    period: e.period,
    playerId: e.playerId === null ? null : BigInt(e.playerId),
    playerName: e.playerName,
    raw: e.raw,
  };
}

/**
 * Insert a timeline's events with `match_id NULL`, skipping ids already
 * stored. Returns how many rows landed.
 */
export async function insertCorpusEvents(db: DbClient, events: readonly TimelineEvent[]): Promise<number> {
  let inserted = 0;
  for (let i = 0; i < events.length; i += INSERT_CHUNK) {
    const chunk = events.slice(i, i + INSERT_CHUNK).map((e) => toEventRow(e));
    if (chunk.length === 0) continue;
    const rows = await db
      .insert(srLiveEvents)
      .values(chunk)
      .onConflictDoNothing({ target: srLiveEvents.srEventId })
      .returning({ id: srLiveEvents.srEventId });
    inserted += rows.length;
  }
  return inserted;
}

/**
 * The whole stored corpus as the calibrator reads it. Optionally
 * narrowed to the matches whose `slotzilla_games` row carries a given
 * coverage level — archived corpus games have no such row, so a level
 * filter only ever sees games the live engine ran.
 */
export async function loadCorpusEvents(
  db: DbClient,
  opts: { coverageLevel?: number } = {},
): Promise<CorpusEvent[]> {
  const rows = (await db.execute(sql`
    SELECT e.sr_match_id::text AS sr_match_id,
           e.sr_event_id::text AS sr_event_id,
           e.symbol, e.seconds, e.disabled, e.team
      FROM sr_live_events e
     WHERE e.seconds >= 0
       ${
         opts.coverageLevel === undefined
           ? sql``
           : sql`AND e.sr_match_id IN (
                   SELECT g.sr_match_id FROM slotzilla_games g
                    WHERE g.coverage_level = ${opts.coverageLevel}
                 )`
       }
     ORDER BY e.sr_match_id, e.seconds, e.sr_event_id
  `)) as unknown as Array<{
    sr_match_id: string;
    sr_event_id: string;
    symbol: string | null;
    seconds: number | string;
    disabled: boolean;
    team: string | null;
  }>;
  return rows.map((r) => ({
    srMatchId: String(r.sr_match_id),
    eventId: String(r.sr_event_id),
    symbol: isSlotSymbol(r.symbol) ? r.symbol : null,
    seconds: Number(r.seconds),
    disabled: Boolean(r.disabled),
    team: r.team === "home" || r.team === "away" ? r.team : null,
  }));
}

/**
 * List the sport's days, keep the ended matches, and pull the timeline
 * of every one not already in `sr_live_events`, up to `maxMatches`.
 * Paced with a short pause between timeline fetches — the host is open,
 * not ours.
 */
export async function fetchCorpus(
  db: DbClient,
  client: CorpusClient,
  params: CorpusFetchParams,
  log: CorpusLogger,
  pauseMs = 250,
): Promise<CorpusFetchResult> {
  const srSportId = params.srSportId ?? 2;
  const maxMatches = Math.max(1, params.maxMatches ?? 200);
  const days = dayRange(params.from, params.to);

  const candidates = new Map<string, DayMatch>();
  let matchesSeen = 0;
  for (const date of days) {
    let dayMatches: DayMatch[];
    try {
      dayMatches = await client.fetchDay(srSportId, date);
    } catch (err) {
      log.warn({ err, date, srSportId }, "slotzilla corpus: day fetch failed");
      continue;
    }
    for (const m of dayMatches) {
      if (candidates.has(m.srMatchId)) continue;
      matchesSeen += 1;
      if (m.ended) candidates.set(m.srMatchId, m);
    }
  }

  const ids = Array.from(candidates.keys());
  const existing = new Set<string>();
  if (ids.length > 0) {
    const rows = (await db.execute(sql`
      SELECT DISTINCT sr_match_id::text AS id
        FROM sr_live_events
       WHERE sr_match_id = ANY(${ids}::bigint[])
    `)) as unknown as Array<{ id: string }>;
    for (const r of rows) existing.add(String(r.id));
  }

  const todo = ids.filter((id) => !existing.has(id)).slice(0, maxMatches);
  let matchesFetched = 0;
  let eventsInserted = 0;
  for (const id of todo) {
    try {
      const timeline = await client.fetchTimeline(id);
      const n = await insertCorpusEvents(db, timeline.events);
      matchesFetched += 1;
      eventsInserted += n;
    } catch (err) {
      log.warn({ err, srMatchId: id }, "slotzilla corpus: timeline fetch failed");
    }
    if (pauseMs > 0) await new Promise((r) => setTimeout(r, pauseMs));
  }

  const result: CorpusFetchResult = {
    matchesSeen,
    matchesFetched,
    eventsInserted,
    skipped: matchesSeen - matchesFetched,
  };
  log.info({ ...result, days: days.length, srSportId }, "slotzilla corpus: fetch complete");
  return result;
}
