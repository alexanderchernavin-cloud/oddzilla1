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
