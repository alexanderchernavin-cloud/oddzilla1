// Tiny Redis "fetch-aside" helper for read-heavy hot paths.
//
// Pattern: look up the JSON value under `key`; on miss, run `loader()`,
// JSON-encode the result, store with EX TTL, return the value.
//
// Errors from Redis (connection blip, key parse failure) degrade to a
// cold loader call — the cache is an optimisation, never the source of
// truth.
//
// Stampede protection: on a cold key, concurrent callers share ONE
// loader run via an in-process inflight map (the api runs as a single
// process — see docker-compose.yml, only web has replicas — so
// in-process singleflight IS global singleflight). This matters for the
// expensive cached loaders (zillafacts / zillatips multi-hundred-line
// CTEs): when a popular live match's key expires, every concurrent
// match-page render across the 3 SSR replicas lands here at once;
// without dedup each ran the monster query.
//
// Loader failures are NOT cached: every waiter sees the rejection, the
// inflight slot clears, and the next caller retries cold.
//
// Mirrors the widgets/routes.ts redis idiom (app.redis.get → .catch →
// fallback, app.redis.set with "EX" arg) so a future linter rule can
// flag direct redis.get/set in route handlers in favour of this helper.

import type { Redis } from "ioredis";

const inflight = new Map<string, Promise<unknown>>();

// Envelope written by `cachedSwr`. `f` is the epoch-ms instant the value
// stops being fresh; the Redis key itself lives until fresh + stale.
// Shape-checked on read so a value written by plain `cached()` under the
// same key (an older deploy, a hand-set key) reads as a miss rather than
// as a fresh envelope with an undefined timestamp.
interface SwrEnvelope<T> {
  v: T;
  f: number;
}

function parseEnvelope<T>(raw: string): SwrEnvelope<T> | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      "v" in parsed &&
      typeof (parsed as { f?: unknown }).f === "number"
    ) {
      return parsed as SwrEnvelope<T>;
    }
  } catch {
    // Corrupt entry — treat as a miss; the loader's set overwrites it.
  }
  return null;
}

export async function cached<T>(
  redis: Redis,
  key: string,
  ttlSeconds: number,
  loader: () => Promise<T>,
): Promise<T> {
  const raw = await redis.get(key).catch(() => null);
  if (raw !== null) {
    try {
      return JSON.parse(raw) as T;
    } catch {
      // Fall through to loader — a corrupt cache entry overwrites on set.
    }
  }
  const existing = inflight.get(key);
  if (existing) return existing as Promise<T>;
  const run = (async () => {
    const value = await loader();
    await redis
      .set(key, JSON.stringify(value), "EX", ttlSeconds)
      .catch(() => null);
    return value;
  })();
  inflight.set(key, run);
  // Detached handler so a rejection with zero joined waiters doesn't
  // surface as an unhandledRejection; joined waiters still see the real
  // rejection through their own `await`.
  run.catch(() => undefined);
  try {
    return await run;
  } finally {
    inflight.delete(key);
  }
}

// Stale-while-revalidate variant, for loaders whose cold run is slow
// enough that a user WAITS for it.
//
// `cached()` above has one failure mode that only shows up on a quiet
// site: a short TTL plus low traffic means almost every request is the
// unlucky one that pays the cold load. The sidebar's tournament tree is
// the case that forced this — its 10 s TTL was picked to keep live
// counts fresh, and on football (~1 900 matches, 291 tournaments) the
// loader takes ~1.3 s against ~85 ms warm, so the sidebar expand a
// bettor actually clicks was usually the cold one.
//
// So: inside `freshSeconds` behave exactly like `cached()`. Past it, up
// to `staleSeconds` later, return the stale value IMMEDIATELY and kick
// the loader off in the background — the next caller gets fresh data
// and nobody waits. Only a fully-expired (or DEL'd) key blocks.
//
// The value stays under ONE key, so the admin cache-bust paths that
// `DEL` it still work: a deleted key is a cold miss, not a stale hit.
//
// Not the default for every caller because staleness is a product
// decision, not a performance one — a caller opts in by naming the
// window it can tolerate.
export async function cachedSwr<T>(
  redis: Redis,
  key: string,
  freshSeconds: number,
  staleSeconds: number,
  loader: () => Promise<T>,
): Promise<T> {
  const raw = await redis.get(key).catch(() => null);
  const envelope = raw === null ? null : parseEnvelope<T>(raw);

  const refresh = () => {
    const existing = inflight.get(key);
    if (existing) return existing as Promise<T>;
    const run = (async () => {
      const value = await loader();
      await redis
        .set(
          key,
          JSON.stringify({ v: value, f: Date.now() + freshSeconds * 1000 }),
          "EX",
          freshSeconds + staleSeconds,
        )
        .catch(() => null);
      return value;
    })();
    inflight.set(key, run);
    run.catch(() => undefined).finally(() => inflight.delete(key));
    return run;
  };

  if (envelope) {
    // Stale but usable: serve it now, refresh behind the response. The
    // detached rejection handler is what keeps a failing loader from
    // taking down a request that already has an answer to give.
    if (Date.now() >= envelope.f) refresh().catch(() => undefined);
    return envelope.v;
  }
  return refresh();
}
