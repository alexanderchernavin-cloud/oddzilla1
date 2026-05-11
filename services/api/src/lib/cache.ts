// Tiny Redis "fetch-aside" helper for read-heavy hot paths.
//
// Pattern: look up the JSON value under `key`; on miss, run `loader()`,
// JSON-encode the result, store with EX TTL, return the value.
//
// Errors from Redis (connection blip, key parse failure) degrade to a
// cold loader call — the cache is an optimisation, never the source of
// truth.
//
// Stampede caveat: on a cold key, N concurrent callers all run `loader`
// once each. At the TTLs we use here (5-60s) for catalog reads, a brief
// duplicate compute is cheap relative to the saved load. If a future
// hot path needs singleflight semantics, swap this for a Redis SET NX +
// short backoff implementation.
//
// Mirrors the widgets/routes.ts redis idiom (app.redis.get → .catch →
// fallback, app.redis.set with "EX" arg) so a future linter rule can
// flag direct redis.get/set in route handlers in favour of this helper.

import type { Redis } from "ioredis";

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
  const value = await loader();
  await redis
    .set(key, JSON.stringify(value), "EX", ttlSeconds)
    .catch(() => null);
  return value;
}
