// Unit tests for the stale-while-revalidate cache helper.
//
// The property that matters is "a stale key never makes a caller wait":
// that is the whole reason the sidebar's tournament tree moved onto it,
// and it is invisible in normal operation — a regression just shows up
// as the storefront feeling slow again. The other two worth pinning are
// that a DEL still forces a cold load (the admin cache-bust paths depend
// on it) and that a failing background refresh cannot reject a request
// that already has an answer.
//
// Run with: tsx --test src/lib/cache.test.ts

import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import type { Redis } from "ioredis";
import { cachedSwr } from "./cache.js";

// Minimal in-memory stand-in for the two commands the helper uses.
//
// Real wall-clock, not an injected one: the helper stamps freshness with
// its own `Date.now()`, so a clock the test controls would move Redis
// expiry without moving the thing under test — which is exactly the way
// the first version of this file passed while proving nothing. The
// windows below are therefore in MILLISECONDS (fractional seconds), and
// the tests wait them out for real.
function fakeRedis() {
  const store = new Map<string, { value: string; expiresAt: number }>();
  const redis = {
    async get(key: string) {
      const entry = store.get(key);
      if (!entry) return null;
      if (Date.now() >= entry.expiresAt) {
        store.delete(key);
        return null;
      }
      return entry.value;
    },
    async set(key: string, value: string, _ex: "EX", ttlSeconds: number) {
      store.set(key, {
        value,
        expiresAt: Date.now() + ttlSeconds * 1000,
      });
      return "OK";
    },
  };
  return { redis: redis as unknown as Redis, store };
}

// Fresh/stale windows small enough to wait out. FRESH is generous
// relative to the sleeps so a loaded CI box can't make a "still fresh"
// assertion flake into a stale one.
const FRESH = 0.05; // 50 ms
const STALE = 0.05; // 50 ms

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Lets a test observe the background refresh, which `await` on the call
// itself does NOT wait for — that's the point of the call.
function settle() {
  return sleep(0);
}

describe("cachedSwr", () => {
  it("runs the loader on a cold key and returns its value", async () => {
    const { redis } = fakeRedis();
    let calls = 0;
    const out = await cachedSwr(redis, "k", FRESH, STALE, async () => {
      calls += 1;
      return { n: 1 };
    });
    assert.deepEqual(out, { n: 1 });
    assert.equal(calls, 1);
  });

  it("serves from cache without calling the loader while fresh", async () => {
    const { redis } = fakeRedis();
    let calls = 0;
    const loader = async () => {
      calls += 1;
      return calls;
    };
    assert.equal(await cachedSwr(redis, "k", 60, 600, loader), 1);
    assert.equal(await cachedSwr(redis, "k", 60, 600, loader), 1);
    assert.equal(calls, 1);
  });

  it("returns the STALE value immediately and refreshes behind it", async () => {
    const { redis } = fakeRedis();
    let calls = 0;
    const loader = async () => {
      calls += 1;
      return calls;
    };

    assert.equal(await cachedSwr(redis, "k", FRESH, 600, loader), 1);
    await sleep(FRESH * 1000 + 20); // past fresh, well inside stale

    // The caller gets the old value with no loader run on its own path —
    // this is the assertion the sidebar's responsiveness rests on.
    assert.equal(await cachedSwr(redis, "k", FRESH, 600, loader), 1);

    await settle();
    assert.equal(calls, 2, "background refresh should have run");

    // And the refresh is what the next caller sees.
    assert.equal(await cachedSwr(redis, "k", FRESH, 600, loader), 2);
    assert.equal(calls, 2);
  });

  it("blocks on a cold load once the stale window has passed", async () => {
    const { redis } = fakeRedis();
    let calls = 0;
    const loader = async () => {
      calls += 1;
      return calls;
    };

    assert.equal(await cachedSwr(redis, "k", FRESH, STALE, loader), 1);
    await sleep((FRESH + STALE) * 1000 + 20);
    assert.equal(await cachedSwr(redis, "k", FRESH, STALE, loader), 2);
    assert.equal(calls, 2);
  });

  it("treats a deleted key as cold, so admin cache-busts still work", async () => {
    const { redis, store } = fakeRedis();
    let calls = 0;
    const loader = async () => {
      calls += 1;
      return calls;
    };
    assert.equal(await cachedSwr(redis, "k", 60, 600, loader), 1);
    store.delete("k");
    assert.equal(await cachedSwr(redis, "k", 60, 600, loader), 2);
  });

  it("collapses concurrent cold callers into one loader run", async () => {
    const { redis } = fakeRedis();
    let calls = 0;
    const loader = async () => {
      calls += 1;
      await settle();
      return calls;
    };
    const [a, b, c] = await Promise.all([
      cachedSwr(redis, "k", 60, 600, loader),
      cachedSwr(redis, "k", 60, 600, loader),
      cachedSwr(redis, "k", 60, 600, loader),
    ]);
    assert.equal(calls, 1);
    assert.deepEqual([a, b, c], [1, 1, 1]);
  });

  it("does not reject a stale hit when the background refresh fails", async () => {
    const { redis } = fakeRedis();
    let calls = 0;
    const loader = async () => {
      calls += 1;
      if (calls > 1) throw new Error("upstream down");
      return "first";
    };

    assert.equal(await cachedSwr(redis, "k", FRESH, 600, loader), "first");
    await sleep(FRESH * 1000 + 20);
    // Serving stale is the correct answer here: we HAVE a usable value,
    // and the failure belongs in the log, not in the bettor's sidebar.
    assert.equal(await cachedSwr(redis, "k", FRESH, 600, loader), "first");
    await settle();
    // The failure is not cached, so the next stale read tries again.
    assert.equal(await cachedSwr(redis, "k", FRESH, 600, loader), "first");
    assert.equal(calls, 3);
  });

  it("reads a value written by plain cached() as a miss, not a fresh hit", async () => {
    // Envelope shape-check: the same key may hold a bare payload from an
    // older deploy. Treating that as an envelope would read `f` as
    // undefined and compare NaN, which is never >= — a permanently
    // "fresh" entry that the loader could never replace.
    const { redis, store } = fakeRedis();
    store.set("k", {
      value: JSON.stringify({ tournaments: [] }),
      expiresAt: Date.now() + 60_000,
    });
    let calls = 0;
    const out = await cachedSwr(redis, "k", 60, 600, async () => {
      calls += 1;
      return { tournaments: ["fresh"] };
    });
    assert.equal(calls, 1);
    assert.deepEqual(out, { tournaments: ["fresh"] });
  });
});
