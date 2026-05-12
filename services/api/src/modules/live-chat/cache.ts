// Redis hot-path helpers for live match chat.
//
// Keys:
//   chat:msgs:{matchId}     LIST — last MESSAGE_CACHE_SIZE messages,
//                                  newest-first (LPUSH + LTRIM). Each
//                                  entry is the JSON-encoded wire-format
//                                  LiveChatMessage so reads are
//                                  zero-transform.
//   chat:picks:{matchId}    HASH — keys 'home' | 'draw' | 'away' with
//                                  integer vote counters maintained by
//                                  HINCRBY. The authoritative store is
//                                  live_chat_picks in Postgres; this is
//                                  a denormalised counter to avoid
//                                  scanning the table on every viewer
//                                  join. Rebuilt from the DB on cache
//                                  miss.
//   chat:viewers:{matchId}  STRING — current viewer count as written by
//                                  ws-gateway whenever chatMatchRefs
//                                  changes. Read-only on this side.
//   chat:rl:msg:{userId}    STRING — fixed-window rate-limit counter
//                                  for message posts.
//   chat:rl:rxn:{userId}    STRING — same for reaction bursts.
//
// Channel:
//   chat:match:{matchId}   PUB/SUB — every LiveChatBroadcastFrame goes
//                                    on this channel; ws-gateway fans
//                                    out to subscribed clients.

import type { Redis } from "ioredis";
import type {
  LiveChatBroadcastFrame,
  LiveChatCrowdPicks,
  LiveChatMessage,
  PickOutcome,
} from "@oddzilla/types";

// 50 is what Notion UC02 (Send a chat message) calls out as the
// in-room history size on entry. Larger caches inflate Redis memory
// per active room (50 × ~200B = ~10 KiB per room); smaller starves
// late joiners.
export const MESSAGE_CACHE_SIZE = 50;

// Per-user fixed-window caps. Mirror the Notion "feels live" target
// without enabling chat spam.
export const MESSAGE_RATE_LIMIT = { count: 10, windowSeconds: 30 };
export const REACTION_RATE_LIMIT = { count: 6, windowSeconds: 10 };

const msgsKey = (matchId: string) => `chat:msgs:${matchId}`;
const picksKey = (matchId: string) => `chat:picks:${matchId}`;
const viewersKey = (matchId: string) => `chat:viewers:${matchId}`;
const channel = (matchId: string) => `chat:match:${matchId}`;
const msgRateKey = (userId: string) =>
  `chat:rl:msg:${userId}:${Math.floor(
    Date.now() / 1000 / MESSAGE_RATE_LIMIT.windowSeconds,
  )}`;
const reactionRateKey = (userId: string) =>
  `chat:rl:rxn:${userId}:${Math.floor(
    Date.now() / 1000 / REACTION_RATE_LIMIT.windowSeconds,
  )}`;

// Returns true if the caller is within the limit and may proceed.
// Uses fixed-window (vs sliding) because the window grain is short
// enough that the edge-bursting artefact is bounded — a user can at
// worst send 2N events at a window boundary, which the UI naturally
// throttles anyway.
export async function consumeMessageQuota(
  redis: Redis,
  userId: string,
): Promise<boolean> {
  const key = msgRateKey(userId);
  const count = await redis.incr(key);
  if (count === 1) {
    await redis.expire(key, MESSAGE_RATE_LIMIT.windowSeconds);
  }
  return count <= MESSAGE_RATE_LIMIT.count;
}

export async function consumeReactionQuota(
  redis: Redis,
  userId: string,
): Promise<boolean> {
  const key = reactionRateKey(userId);
  const count = await redis.incr(key);
  if (count === 1) {
    await redis.expire(key, REACTION_RATE_LIMIT.windowSeconds);
  }
  return count <= REACTION_RATE_LIMIT.count;
}

export async function appendMessageToCache(
  redis: Redis,
  matchId: string,
  message: LiveChatMessage,
): Promise<void> {
  const key = msgsKey(matchId);
  // Multi-exec keeps the list bounded atomically. Without LTRIM
  // co-located, a sustained burst could push the cache past its cap
  // before the next trim.
  await redis
    .multi()
    .lpush(key, JSON.stringify(message))
    .ltrim(key, 0, MESSAGE_CACHE_SIZE - 1)
    // Drop the cache for empty rooms an hour after the last message.
    // The DB stays authoritative; a cold-start room rebuilds from
    // there on demand.
    .expire(key, 3600)
    .exec();
}

// Returns the cached messages in chronological (oldest-first) order
// for direct delivery to the client. Empty array if the cache is
// cold; the caller is responsible for rebuilding from Postgres on
// miss.
export async function readMessageCache(
  redis: Redis,
  matchId: string,
): Promise<LiveChatMessage[]> {
  const raw = await redis.lrange(msgsKey(matchId), 0, MESSAGE_CACHE_SIZE - 1);
  if (raw.length === 0) return [];
  // LRANGE returns newest-first because we LPUSH. Reverse for the UI,
  // which renders oldest-at-top.
  const messages: LiveChatMessage[] = [];
  for (let i = raw.length - 1; i >= 0; i--) {
    const entry = raw[i];
    if (!entry) continue;
    try {
      messages.push(JSON.parse(entry) as LiveChatMessage);
    } catch {
      // Skip malformed cache entries — defensive, should never
      // happen since we control writes.
    }
  }
  return messages;
}

// Warm the cache from a freshly-read DB snapshot. Idempotent: if the
// cache already has entries this is a no-op (we don't want to clobber
// real-time writes). Returns the rows that were already cached, if
// any, so callers can fall back to fresh data without two reads.
export async function warmMessageCache(
  redis: Redis,
  matchId: string,
  messages: LiveChatMessage[],
): Promise<void> {
  if (messages.length === 0) return;
  const key = msgsKey(matchId);
  const len = await redis.llen(key);
  if (len > 0) return;
  // RPUSH because the DB read is already chronological (oldest-first)
  // and the cache stores newest-first.
  const pipeline = redis.multi();
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (!m) continue;
    pipeline.lpush(key, JSON.stringify(m));
  }
  pipeline.ltrim(key, 0, MESSAGE_CACHE_SIZE - 1);
  pipeline.expire(key, 3600);
  await pipeline.exec();
}

// Increments the counter for one outcome. Returns the post-increment
// crowd picks snapshot in one round-trip.
export async function incrementPickCounter(
  redis: Redis,
  matchId: string,
  pick: PickOutcome,
): Promise<LiveChatCrowdPicks> {
  const key = picksKey(matchId);
  const res = await redis
    .multi()
    .hincrby(key, pick, 1)
    .expire(key, 86400)
    .hmget(key, "home", "draw", "away")
    .exec();
  // res is [[err, count], [err, exp], [err, [home, draw, away]]]
  const last = res?.[2]?.[1] as (string | null)[] | undefined;
  return toCrowdPicks(last?.[0] ?? null, last?.[1] ?? null, last?.[2] ?? null);
}

// Read counters; null result fields fall through to 0. Caller is
// expected to repopulate the cache from the DB if every counter is
// null AND the room has votes (rare cold-start case).
export async function readCrowdPicks(
  redis: Redis,
  matchId: string,
): Promise<LiveChatCrowdPicks> {
  const arr = await redis.hmget(picksKey(matchId), "home", "draw", "away");
  return toCrowdPicks(arr[0] ?? null, arr[1] ?? null, arr[2] ?? null);
}

export async function warmPicksCache(
  redis: Redis,
  matchId: string,
  counts: { home: number; draw: number; away: number },
): Promise<void> {
  const key = picksKey(matchId);
  const exists = await redis.exists(key);
  if (exists === 1) return;
  await redis
    .multi()
    .hset(key, {
      home: counts.home.toString(),
      draw: counts.draw.toString(),
      away: counts.away.toString(),
    })
    .expire(key, 86400)
    .exec();
}

export async function readViewerCount(
  redis: Redis,
  matchId: string,
): Promise<number> {
  const raw = await redis.get(viewersKey(matchId));
  if (raw === null) return 0;
  const n = Number(raw);
  return Number.isFinite(n) ? n : 0;
}

export async function publishFrame(
  redis: Redis,
  frame: LiveChatBroadcastFrame,
): Promise<void> {
  await redis.publish(channel(frame.matchId), JSON.stringify(frame));
}

function toCrowdPicks(
  home: string | null,
  draw: string | null,
  away: string | null,
): LiveChatCrowdPicks {
  const h = Number(home ?? 0);
  const d = Number(draw ?? 0);
  const a = Number(away ?? 0);
  return {
    home: Number.isFinite(h) ? h : 0,
    draw: Number.isFinite(d) ? d : 0,
    away: Number.isFinite(a) ? a : 0,
    totalVotes:
      (Number.isFinite(h) ? h : 0) +
      (Number.isFinite(d) ? d : 0) +
      (Number.isFinite(a) ? a : 0),
  };
}
