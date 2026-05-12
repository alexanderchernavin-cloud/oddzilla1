// Match-state watcher — subscribes to `odds:match:*` for live-score
// frames published by services/feed-ingester (Go) and emits chat system
// messages for the deltas described by Notion Epic 3 (Live Match
// State).
//
// Detection (Oddin spec §2.4.1.2 status codes {0,1,4,5}):
//   - Goal:       liveScore.home or liveScore.away increased vs prev
//   - Full time:  liveScore.status crossed from <4 to 4
//   - Cancelled:  liveScore.status crossed to 5
//   - Half time:  SKIPPED in V1 — Oddin does not surface a documented
//                 half-time status code; the storefront scoreboard
//                 derives it from sport-specific period metadata, but
//                 lifting that into a chat signal requires per-sport
//                 plumbing. Listed as a follow-up alongside kickoff.
//
// Multi-process safety: when api scales beyond a single container the
// watcher would emit duplicate system messages per delta. A Redis
// SET NX advisory lock keyed by (matchId, score-version) deduplicates
// — first writer wins, runners-up silently no-op. Single-process
// today, ready for tomorrow.
//
// Skipped work: frames for matches with no chat viewers (chat:viewers
// key absent or zero) are dropped before the DB write. Score deltas
// for empty rooms are noise — the room will rebuild on the next
// snapshot read from the matches table anyway.

import type { FastifyInstance } from "fastify";
import { Redis } from "ioredis";
import { eq } from "drizzle-orm";
import { liveChatMessages, matches } from "@oddzilla/db";
import type {
  LiveChatMatchSnapshot,
  LiveChatSystemMessage,
  SystemMessageKind,
  WsLiveScore,
  WsLiveScorePayload,
} from "@oddzilla/types";
import { appendMessageToCache, publishFrame } from "./cache.js";

const ODDS_CHANNEL_PATTERN = "odds:match:*";
const ODDS_CHANNEL_PREFIX = "odds:match:";
const STATE_KEY_PREFIX = "chat:watcher:state:";
const STATE_TTL_SECONDS = 6 * 3600; // 6h
const VIEWERS_KEY_PREFIX = "chat:viewers:";
// Drop the dedup lock after a window long enough that any sane
// multi-process race resolves, short enough that a legitimate
// follow-up emission (extremely rare — e.g. an outcome cancellation
// that triggers a re-score) isn't suppressed forever.
const DEDUP_LOCK_TTL_SECONDS = 10;

// Oddin §2.4.1.2 status codes we recognise. Anything else is treated
// as "no transition" — same defensive posture as feed-ingester's
// MapMatchStatusCode (an undocumented code must not be allowed to
// flip a match to terminal state).
const ODDIN_NOT_STARTED = 0;
const ODDIN_LIVE = 1;
const ODDIN_CLOSED = 4;
const ODDIN_CANCELLED = 5;

export interface WatcherMatchState {
  home: number;
  away: number;
  status: number | null;
}

export type WatcherSystemEvent =
  | {
      kind: "goal";
      side: "home" | "away";
      homeScore: number;
      awayScore: number;
    }
  | {
      kind: "full_time";
      homeScore: number;
      awayScore: number;
    }
  | { kind: "match_cancelled" };

// Parse a raw pub/sub payload off `odds:match:{id}`. Returns null when
// the frame is not a live-score envelope (odds frames, malformed JSON,
// etc.) so callers can early-exit cheaply.
export function parseLiveScoreFrame(raw: string): WsLiveScore | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (
    !parsed ||
    typeof parsed !== "object" ||
    (parsed as { type?: unknown }).type !== "score"
  ) {
    return null;
  }
  const obj = parsed as Record<string, unknown>;
  if (typeof obj.matchId !== "string") return null;
  if (!obj.liveScore || typeof obj.liveScore !== "object") return null;
  return {
    type: "score",
    matchId: obj.matchId,
    liveScore: obj.liveScore as WsLiveScorePayload,
  };
}

// Normalise the wire payload to the {home, away, status} shape the
// detector compares. NULL slots stay null so a missing field can't be
// confused with a literal zero.
export function snapshotFromLiveScore(
  payload: WsLiveScorePayload,
): WatcherMatchState {
  const home = numberOrZero(payload.home);
  const away = numberOrZero(payload.away);
  const status =
    typeof payload.status === "number" && Number.isFinite(payload.status)
      ? payload.status
      : null;
  return { home, away, status };
}

// Pure delta detector. Receives the previous snapshot (null on cold
// start) and the current snapshot, returns the events to emit. Order
// matters for rendering (goal-then-full-time looks correct in the
// feed; reversed would be weird).
export function detectSystemEvents(
  prev: WatcherMatchState | null,
  curr: WatcherMatchState,
): WatcherSystemEvent[] {
  const events: WatcherSystemEvent[] = [];
  // Cold start: seed state without emitting anything. We don't want
  // restart-storms to spray "Score" messages for matches already
  // mid-game.
  if (!prev) return events;

  if (curr.home > prev.home) {
    events.push({
      kind: "goal",
      side: "home",
      homeScore: curr.home,
      awayScore: curr.away,
    });
  }
  if (curr.away > prev.away) {
    events.push({
      kind: "goal",
      side: "away",
      homeScore: curr.home,
      awayScore: curr.away,
    });
  }

  // Status transitions. Only fire on the actual crossing, not on
  // every subsequent frame.
  const prevTerminal = prev.status === ODDIN_CLOSED || prev.status === ODDIN_CANCELLED;
  const currClosed = curr.status === ODDIN_CLOSED;
  const currCancelled = curr.status === ODDIN_CANCELLED;

  if (!prevTerminal && currClosed) {
    events.push({
      kind: "full_time",
      homeScore: curr.home,
      awayScore: curr.away,
    });
  }
  if (!prevTerminal && currCancelled) {
    events.push({ kind: "match_cancelled" });
  }
  return events;
}

export interface FormattedSystemMessage {
  systemKind: SystemMessageKind;
  text: string;
  payload: LiveChatMatchSnapshot;
}

export function formatSystemMessage(
  event: WatcherSystemEvent,
  match: { homeTeam: string; awayTeam: string },
  curr: WatcherMatchState,
): FormattedSystemMessage {
  const snapshot: LiveChatMatchSnapshot = {
    score: { home: curr.home, away: curr.away },
    clock: "",
    status: oddinStatusToWire(curr.status),
  };
  if (event.kind === "goal") {
    return {
      systemKind: "goal",
      // No emoji prefix (CLAUDE.md invariant 8). UI renders the icon
      // off systemKind.
      text: `Score - ${match.homeTeam} ${event.homeScore}-${event.awayScore} ${match.awayTeam}`,
      payload: snapshot,
    };
  }
  if (event.kind === "full_time") {
    return {
      systemKind: "full_time",
      text: `Full Time - ${match.homeTeam} ${event.homeScore}-${event.awayScore} ${match.awayTeam}`,
      payload: snapshot,
    };
  }
  return {
    systemKind: "match_cancelled",
    text: `Match cancelled - ${match.homeTeam} vs ${match.awayTeam}`,
    payload: snapshot,
  };
}

// --- subscribe loop ---------------------------------------------------------

export interface MatchWatcherHandle {
  close: () => Promise<void>;
}

export interface MatchWatcherOptions {
  /**
   * Inject a redis subscriber for tests. In production this defaults
   * to a fresh ioredis client built from the same REDIS_URL the rest
   * of the api uses — pub/sub clients can't issue normal commands so
   * we always need a separate connection.
   */
  redisSubscriber?: Redis;
  redisUrl?: string;
}

export async function startMatchWatcher(
  app: FastifyInstance,
  opts: MatchWatcherOptions = {},
): Promise<MatchWatcherHandle> {
  const sub =
    opts.redisSubscriber ??
    new Redis(opts.redisUrl ?? process.env.REDIS_URL ?? "redis://redis:6379", {
      lazyConnect: false,
    });

  await sub.psubscribe(ODDS_CHANNEL_PATTERN);
  app.log.info({ pattern: ODDS_CHANNEL_PATTERN }, "match-watcher subscribed");

  sub.on("pmessage", (_pattern: string, channel: string, raw: string) => {
    void handleFrame(app, channel, raw).catch((err: Error) => {
      app.log.warn({ err: err.message, channel }, "match-watcher frame error");
    });
  });

  return {
    close: async () => {
      try {
        await sub.punsubscribe(ODDS_CHANNEL_PATTERN);
      } catch {
        // Ignore — the disconnect below cleans up regardless.
      }
      // Only disconnect connections we own.
      if (!opts.redisSubscriber) sub.disconnect();
    },
  };
}

async function handleFrame(
  app: FastifyInstance,
  channel: string,
  raw: string,
): Promise<void> {
  if (!channel.startsWith(ODDS_CHANNEL_PREFIX)) return;
  const matchId = channel.slice(ODDS_CHANNEL_PREFIX.length);
  const frame = parseLiveScoreFrame(raw);
  if (!frame) return;

  // Skip matches with no chat audience. Score deltas for empty rooms
  // are noise — the room rebuilds match state from the matches table
  // on the next snapshot read anyway.
  const viewersRaw = await app.redis.get(VIEWERS_KEY_PREFIX + matchId);
  if (!viewersRaw || Number(viewersRaw) === 0) return;

  const curr = snapshotFromLiveScore(frame.liveScore);
  const prev = await readWatcherState(app.redis, matchId);
  // Always write the current snapshot back, regardless of whether
  // events fired — cold-start frames seed prev for the next call.
  await writeWatcherState(app.redis, matchId, curr);

  const events = detectSystemEvents(prev, curr);
  if (events.length === 0) return;

  // Fetch team names once per emit burst. matches.id is bigint so the
  // BigInt cast is necessary even though matchId is a string at the
  // wire level.
  let matchRow: { homeTeam: string; awayTeam: string } | null = null;
  try {
    const [row] = await app.db
      .select({ homeTeam: matches.homeTeam, awayTeam: matches.awayTeam })
      .from(matches)
      .where(eq(matches.id, BigInt(matchId)))
      .limit(1);
    matchRow = row ?? null;
  } catch (err) {
    app.log.warn(
      { err: (err as Error).message, matchId },
      "match-watcher: match lookup failed; skipping emit",
    );
    return;
  }
  if (!matchRow) return;

  for (const event of events) {
    const lockKey = dedupLockKey(matchId, event, curr);
    const acquired = await app.redis.set(
      lockKey,
      "1",
      "EX",
      DEDUP_LOCK_TTL_SECONDS,
      "NX",
    );
    if (acquired !== "OK") continue;

    const formatted = formatSystemMessage(event, matchRow, curr);
    try {
      await emitSystemMessage(app, matchId, formatted);
    } catch (err) {
      app.log.warn(
        { err: (err as Error).message, matchId, event: event.kind },
        "match-watcher: emit failed",
      );
    }
  }

  // Always publish the new match snapshot so the room header refreshes
  // even when no system message fires (e.g. clock-only updates in a
  // follow-up implementation).
  await publishFrame(app.redis, {
    type: "chat_match_update",
    matchId,
    match: {
      score: { home: curr.home, away: curr.away },
      clock: "",
      status: oddinStatusToWire(curr.status),
    },
  });
}

async function emitSystemMessage(
  app: FastifyInstance,
  matchId: string,
  formatted: FormattedSystemMessage,
): Promise<void> {
  const [row] = await app.db
    .insert(liveChatMessages)
    .values({
      matchId: BigInt(matchId),
      kind: "system",
      text: formatted.text,
      systemKind: formatted.systemKind,
      payload: formatted.payload,
    })
    .returning({
      id: liveChatMessages.id,
      createdAt: liveChatMessages.createdAt,
    });
  if (!row) {
    throw new Error("system_message_insert_failed");
  }

  const message: LiveChatSystemMessage = {
    id: row.id.toString(),
    matchId,
    kind: "system",
    systemKind: formatted.systemKind,
    text: formatted.text,
    payload: formatted.payload,
    createdAt: row.createdAt.toISOString(),
  };

  await appendMessageToCache(app.redis, matchId, message);
  await publishFrame(app.redis, {
    type: "chat_message",
    matchId,
    message,
  });
}

async function readWatcherState(
  redis: Redis,
  matchId: string,
): Promise<WatcherMatchState | null> {
  const raw = await redis.get(STATE_KEY_PREFIX + matchId);
  if (!raw) return null;
  try {
    const obj = JSON.parse(raw) as WatcherMatchState;
    return {
      home: numberOrZero(obj.home),
      away: numberOrZero(obj.away),
      status:
        typeof obj.status === "number" && Number.isFinite(obj.status)
          ? obj.status
          : null,
    };
  } catch {
    return null;
  }
}

async function writeWatcherState(
  redis: Redis,
  matchId: string,
  state: WatcherMatchState,
): Promise<void> {
  await redis.set(
    STATE_KEY_PREFIX + matchId,
    JSON.stringify(state),
    "EX",
    STATE_TTL_SECONDS,
  );
}

function dedupLockKey(
  matchId: string,
  event: WatcherSystemEvent,
  curr: WatcherMatchState,
): string {
  // Versioned by the score that triggered the event so a follow-up
  // delta on the same match acquires a fresh lock. Status events
  // bake the terminal code into the key.
  if (event.kind === "goal") {
    return `chat:watcher:lock:${matchId}:goal:${curr.home}-${curr.away}`;
  }
  if (event.kind === "full_time") {
    return `chat:watcher:lock:${matchId}:full_time`;
  }
  return `chat:watcher:lock:${matchId}:match_cancelled`;
}

function oddinStatusToWire(
  status: number | null,
): LiveChatMatchSnapshot["status"] {
  switch (status) {
    case ODDIN_NOT_STARTED:
      return "not_started";
    case ODDIN_LIVE:
      return "live";
    case ODDIN_CLOSED:
    case ODDIN_CANCELLED:
      return "fulltime";
    default:
      return "not_started";
  }
}

function numberOrZero(v: unknown): number {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v !== "") {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}
