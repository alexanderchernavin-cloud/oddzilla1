// End-to-end integration tests for the live-chat module. Exercises the
// real Postgres + Redis side effects of Phase B (cache helpers) and
// Phase C (match-state watcher) so the wire contract is verified, not
// just type-checked.
//
// Gated on env vars to keep CI from spinning up infra. Run locally:
//
//   docker run --rm -d --name pg -p 5433:5432 \
//     -e POSTGRES_USER=oddzilla -e POSTGRES_PASSWORD=oddzilla \
//     -e POSTGRES_DB=oddzilla postgres:16-alpine
//   docker run --rm -d --name rd -p 6380:6379 redis:7-alpine
//   DATABASE_URL='postgres://oddzilla:oddzilla@localhost:5433/oddzilla?sslmode=disable' \
//     pnpm db:migrate
//   LIVE_CHAT_TEST_DATABASE_URL='postgres://oddzilla:oddzilla@localhost:5433/oddzilla?sslmode=disable' \
//   LIVE_CHAT_TEST_REDIS_URL='redis://localhost:6380' \
//     node --test --import tsx src/modules/live-chat/integration.test.ts

import { after, before, describe, it } from "node:test";
import { strict as assert } from "node:assert";
import Fastify, { type FastifyInstance } from "fastify";
import { Redis } from "ioredis";
import dbPlugin from "../../plugins/db.js";
import redisPlugin from "../../plugins/redis.js";
import {
  appendMessageToCache,
  incrementPickCounter,
  readCrowdPicks,
  readMessageCache,
  readViewerCount,
  warmMessageCache,
} from "./cache.js";
import { startMatchWatcher, type MatchWatcherHandle } from "./match-watcher.js";
import liveChatRoutes, { loadBetPin } from "./routes.js";
import type { LiveChatMessage } from "@oddzilla/types";

const DATABASE_URL = process.env.LIVE_CHAT_TEST_DATABASE_URL;
const REDIS_URL = process.env.LIVE_CHAT_TEST_REDIS_URL;

if (!DATABASE_URL || !REDIS_URL) {
  // node:test has no native skip-suite, so we degrade to a single
  // documenting test. CI without the env vars sees this and stops;
  // a local run with both vars set exercises the real suite below.
  describe("live-chat integration (skipped)", () => {
    it("requires LIVE_CHAT_TEST_DATABASE_URL and LIVE_CHAT_TEST_REDIS_URL", () => {
      assert.ok(true, "set both env vars to run the integration suite");
    });
  });
} else {
  // Fixed IDs so cleanup is precise. Picked from a high range so they
  // don't collide with seed data anyone has loaded into a shared dev DB.
  const FIXTURE = {
    sportId: 90901,
    categoryId: 90901,
    tournamentId: 90901,
    matchId: 909001n,
    userId: "00000000-0000-0000-0000-00000ace0001",
    nickname: "watcher_test_user",
  };
  const MATCH_ID_STR = FIXTURE.matchId.toString();

  let app: FastifyInstance;
  let pub: Redis; // Standalone publisher — pub/sub clients can't issue commands.
  let watcher: MatchWatcherHandle | null = null;

  before(async () => {
    app = Fastify({ logger: false });
    await app.register(dbPlugin, { databaseUrl: DATABASE_URL });
    await app.register(redisPlugin, { redisUrl: REDIS_URL });
    pub = new Redis(REDIS_URL, { lazyConnect: false });

    // Wipe any stale fixture rows from prior runs. Watcher state +
    // cache keys are also flushed so each test starts cold.
    await app.sql.unsafe(
      `DELETE FROM live_chat_messages WHERE match_id = ${MATCH_ID_STR}`,
    );
    await app.sql.unsafe(
      `DELETE FROM live_chat_picks WHERE match_id = ${MATCH_ID_STR}`,
    );
    await app.sql.unsafe(
      `DELETE FROM matches WHERE id = ${MATCH_ID_STR}`,
    );
    await app.sql.unsafe(
      `DELETE FROM tournaments WHERE id = ${FIXTURE.tournamentId}`,
    );
    await app.sql.unsafe(
      `DELETE FROM categories WHERE id = ${FIXTURE.categoryId}`,
    );
    await app.sql.unsafe(
      `DELETE FROM sports WHERE id = ${FIXTURE.sportId}`,
    );
    await app.sql.unsafe(
      `DELETE FROM users WHERE id = '${FIXTURE.userId}'`,
    );

    // Seed fresh fixture chain.
    await app.sql`
      INSERT INTO sports (id, provider, provider_urn, slug, name)
      VALUES (${FIXTURE.sportId}, 'oddin', 'od:sport:lc-test', 'lc-test-sport', 'LC Test Sport')
    `;
    await app.sql`
      INSERT INTO categories (id, provider_urn, sport_id, slug, name)
      VALUES (${FIXTURE.categoryId}, 'od:cat:lc-test', ${FIXTURE.sportId}, 'lc-test-cat', 'LC Test Cat')
    `;
    await app.sql`
      INSERT INTO tournaments (id, provider_urn, category_id, slug, name)
      VALUES (${FIXTURE.tournamentId}, 'od:tour:lc-test', ${FIXTURE.categoryId}, 'lc-test-tour', 'LC Test Tour')
    `;
    await app.sql`
      INSERT INTO matches (id, tournament_id, provider_urn, home_team, away_team, status)
      VALUES (${MATCH_ID_STR}::bigint, ${FIXTURE.tournamentId}, 'od:match:lc-test', 'Arsenal', 'Chelsea', 'live')
    `;
    await app.sql`
      INSERT INTO users (id, email, password_hash, nickname)
      VALUES (${FIXTURE.userId}, 'lc-test@example.com', 'argon2id$dummy', ${FIXTURE.nickname})
    `;

    await flushFixtureKeys(app.redis);
  });

  after(async () => {
    if (watcher) await watcher.close();
    // Tickets reference markets which reference matches — delete in
    // dependency order. ticket_selections cascade from tickets;
    // market_outcomes cascade from markets via the schema.
    await app.sql.unsafe(
      `DELETE FROM tickets WHERE user_id = '${FIXTURE.userId}'`,
    );
    await app.sql.unsafe(
      `DELETE FROM markets WHERE match_id = ${MATCH_ID_STR}`,
    );
    await app.sql.unsafe(
      `DELETE FROM live_chat_messages WHERE match_id = ${MATCH_ID_STR}`,
    );
    await app.sql.unsafe(
      `DELETE FROM live_chat_picks WHERE match_id = ${MATCH_ID_STR}`,
    );
    await app.sql.unsafe(
      `DELETE FROM matches WHERE id = ${MATCH_ID_STR}`,
    );
    await app.sql.unsafe(
      `DELETE FROM tournaments WHERE id = ${FIXTURE.tournamentId}`,
    );
    await app.sql.unsafe(
      `DELETE FROM categories WHERE id = ${FIXTURE.categoryId}`,
    );
    await app.sql.unsafe(
      `DELETE FROM sports WHERE id = ${FIXTURE.sportId}`,
    );
    await app.sql.unsafe(
      `DELETE FROM users WHERE id = '${FIXTURE.userId}'`,
    );
    await flushFixtureKeys(app.redis);
    pub.disconnect();
    await app.close();
  });

  // ───────────────────────────────────────────────────────────────────────────
  // Phase B — cache helpers (Redis hot path)
  // ───────────────────────────────────────────────────────────────────────────

  describe("Phase B: message + pick cache", () => {
    it("appendMessageToCache + readMessageCache round-trip in chronological order", async () => {
      await flushFixtureKeys(app.redis);
      const first = sampleUserMessage("100", "first");
      const second = sampleUserMessage("101", "second");
      await appendMessageToCache(app.redis, MATCH_ID_STR, first);
      await appendMessageToCache(app.redis, MATCH_ID_STR, second);
      const got = await readMessageCache(app.redis, MATCH_ID_STR);
      assert.equal(got.length, 2);
      assert.equal(got[0]?.id, "100", "oldest first");
      assert.equal(got[1]?.id, "101", "newest last");
    });

    it("LTRIMs to MESSAGE_CACHE_SIZE=50", async () => {
      await flushFixtureKeys(app.redis);
      for (let i = 0; i < 60; i++) {
        await appendMessageToCache(
          app.redis,
          MATCH_ID_STR,
          sampleUserMessage(String(i), `msg-${i}`),
        );
      }
      const got = await readMessageCache(app.redis, MATCH_ID_STR);
      assert.equal(got.length, 50, "cap holds at 50");
      // Newest 50 survive: 10..59 (oldest 0..9 dropped by LTRIM).
      assert.equal(got[0]?.id, "10", "oldest surviving");
      assert.equal(got[49]?.id, "59", "newest");
    });

    it("warmMessageCache is a no-op if the cache already has entries", async () => {
      await flushFixtureKeys(app.redis);
      await appendMessageToCache(
        app.redis,
        MATCH_ID_STR,
        sampleUserMessage("200", "hot"),
      );
      // Try to overwrite with a different message — should be ignored.
      await warmMessageCache(app.redis, MATCH_ID_STR, [
        sampleUserMessage("999", "cold"),
      ]);
      const got = await readMessageCache(app.redis, MATCH_ID_STR);
      assert.equal(got.length, 1);
      assert.equal(got[0]?.id, "200", "hot cache preserved");
    });

    it("incrementPickCounter HINCRBYs and totals match", async () => {
      await flushFixtureKeys(app.redis);
      const first = await incrementPickCounter(app.redis, MATCH_ID_STR, "home");
      assert.deepEqual(first, { home: 1, draw: 0, away: 0, totalVotes: 1 });
      await incrementPickCounter(app.redis, MATCH_ID_STR, "home");
      await incrementPickCounter(app.redis, MATCH_ID_STR, "draw");
      const final = await readCrowdPicks(app.redis, MATCH_ID_STR);
      assert.deepEqual(final, { home: 2, draw: 1, away: 0, totalVotes: 3 });
    });

    it("readViewerCount returns 0 when ws-gateway has not set the key", async () => {
      await flushFixtureKeys(app.redis);
      assert.equal(await readViewerCount(app.redis, MATCH_ID_STR), 0);
    });

    it("readViewerCount reads the value ws-gateway writes", async () => {
      await app.redis.set(`chat:viewers:${MATCH_ID_STR}`, "7");
      assert.equal(await readViewerCount(app.redis, MATCH_ID_STR), 7);
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // Phase C — match-state watcher (Postgres INSERT + Redis cache + pub/sub)
  // ───────────────────────────────────────────────────────────────────────────

  describe("Phase C: match-state watcher", () => {
    let receivedFrames: { channel: string; payload: string }[];
    let listener: Redis | null = null;

    before(async () => {
      // Boot the watcher against this Redis. Each test reset wipes
      // state keys so they run independently.
      watcher = await startMatchWatcher(app, { redisUrl: REDIS_URL });

      // Listen for chat:match:{id} broadcasts so we can assert the
      // pub/sub side effect, not just the DB write.
      listener = new Redis(REDIS_URL, { lazyConnect: false });
      receivedFrames = [];
      await listener.subscribe(`chat:match:${MATCH_ID_STR}`);
      listener.on("message", (channel: string, payload: string) => {
        receivedFrames.push({ channel, payload });
      });
    });

    after(async () => {
      if (listener) {
        try {
          await listener.unsubscribe();
        } catch {
          // ignore
        }
        listener.disconnect();
      }
      if (watcher) {
        await watcher.close();
        watcher = null;
      }
    });

    it("ignores frames when the room has zero viewers", async () => {
      await resetWatcherFixtures(app);
      // No chat:viewers:{matchId} key set.
      await publishScore(pub, MATCH_ID_STR, { home: 1, away: 0, status: 1 });
      await sleep(150);

      const rows = await countMessages(app);
      assert.equal(rows, 0, "no DB insert for empty rooms");
    });

    it("seeds state silently on cold start (no system message)", async () => {
      await resetWatcherFixtures(app);
      await app.redis.set(`chat:viewers:${MATCH_ID_STR}`, "1");
      // First frame after watcher start is the seed — no prev state
      // means no events emitted, just state cached.
      await publishScore(pub, MATCH_ID_STR, { home: 2, away: 1, status: 1 });
      await sleep(150);

      assert.equal(await countMessages(app), 0);
      const state = await app.redis.get(`chat:watcher:state:${MATCH_ID_STR}`);
      assert.ok(state, "state cached after cold-start frame");
      const parsed = JSON.parse(state!) as { home: number; away: number };
      assert.equal(parsed.home, 2);
      assert.equal(parsed.away, 1);
    });

    it("emits a goal system message when the score increases", async () => {
      await resetWatcherFixtures(app);
      await app.redis.set(`chat:viewers:${MATCH_ID_STR}`, "1");
      receivedFrames.length = 0;

      // Seed prev state.
      await publishScore(pub, MATCH_ID_STR, { home: 1, away: 0, status: 1 });
      await sleep(150);
      // Goal!
      await publishScore(pub, MATCH_ID_STR, { home: 2, away: 0, status: 1 });
      await sleep(200);

      // DB insert
      const rows = await fetchSystemRows(app);
      assert.equal(rows.length, 1, "one system row inserted");
      assert.equal(rows[0]?.systemKind, "goal");
      assert.match(rows[0]?.text ?? "", /Score - Arsenal 2-0 Chelsea/);

      // pub/sub broadcast — at least the chat_message frame for the
      // goal AND a chat_match_update for the score change.
      const types = receivedFrames
        .map((f) => safeJsonType(f.payload))
        .filter((t): t is string => !!t);
      assert.ok(types.includes("chat_message"), `got types: ${types.join(",")}`);
      assert.ok(types.includes("chat_match_update"));

      // Redis cache contains the message (so the next snapshot read
      // is hot).
      const cached = await readMessageCache(app.redis, MATCH_ID_STR);
      assert.equal(cached.length, 1);
      assert.equal(cached[0]?.kind, "system");
    });

    it("dedup-locks repeated score frames at the same value", async () => {
      await resetWatcherFixtures(app);
      await app.redis.set(`chat:viewers:${MATCH_ID_STR}`, "1");
      receivedFrames.length = 0;

      // Seed at 0-0.
      await publishScore(pub, MATCH_ID_STR, { home: 0, away: 0, status: 1 });
      await sleep(120);
      // First goal frame.
      await publishScore(pub, MATCH_ID_STR, { home: 1, away: 0, status: 1 });
      await sleep(150);
      // Replay of the same goal (e.g. recovery flush, second api
      // process). The dedup lock must keep us at exactly one row.
      await publishScore(pub, MATCH_ID_STR, { home: 1, away: 0, status: 1 });
      await sleep(150);

      const rows = await fetchSystemRows(app);
      assert.equal(rows.length, 1, "dedup lock held");
    });

    it("emits full_time when status transitions to closed", async () => {
      await resetWatcherFixtures(app);
      await app.redis.set(`chat:viewers:${MATCH_ID_STR}`, "1");

      // Seed mid-match.
      await publishScore(pub, MATCH_ID_STR, { home: 2, away: 1, status: 1 });
      await sleep(120);
      // Final whistle: status flips to 4 (closed).
      await publishScore(pub, MATCH_ID_STR, { home: 2, away: 1, status: 4 });
      await sleep(200);

      const kinds = (await fetchSystemRows(app)).map((r) => r.systemKind);
      assert.ok(kinds.includes("full_time"), `got kinds: ${kinds.join(",")}`);
    });

    it("emits both goal AND full_time when the final goal arrives with the final whistle", async () => {
      await resetWatcherFixtures(app);
      await app.redis.set(`chat:viewers:${MATCH_ID_STR}`, "1");

      await publishScore(pub, MATCH_ID_STR, { home: 1, away: 1, status: 1 });
      await sleep(120);
      // Stoppage-time goal AND status transition in the same frame.
      await publishScore(pub, MATCH_ID_STR, { home: 2, away: 1, status: 4 });
      await sleep(250);

      const kinds = (await fetchSystemRows(app)).map((r) => r.systemKind);
      assert.ok(kinds.includes("goal"), `got: ${kinds.join(",")}`);
      assert.ok(kinds.includes("full_time"), `got: ${kinds.join(",")}`);
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // Phase F — loadBetPin: pickedSide derivation through the real SQL JOIN
  // (tickets → ticket_selections → markets → market_outcomes).
  // ───────────────────────────────────────────────────────────────────────────

  describe("Phase F: loadBetPin pickedSide", () => {
    // Stable IDs in the same high range as the rest of the suite. Two
    // distinct markets so we can compare 1x2 vs not-1x2 derivation in
    // the same fixture set.
    const MW_MARKET_ID = 909010n; // provider_market_id = 1 (match winner)
    const TOTALS_MARKET_ID = 909011n; // provider_market_id = 18 (totals — no pickedSide axis)

    before(async () => {
      // FK order: ticket_selections deletes cascade from tickets via
      // onDelete=cascade; markets and outcomes need explicit cleanup
      // since ticket_selections.market_id does NOT cascade.
      await resetBetPinFixtures(app);

      // Two markets: 1x2 + totals. specifiers_hash is a stable
      // unique-per-market byte string; we don't need correct sha256
      // (the watcher / settlement paths are out of scope for this
      // test — only the BetPin JOIN reads these tables).
      await app.sql`
        INSERT INTO markets (id, match_id, provider_market_id, specifiers_hash)
        VALUES
          (${MW_MARKET_ID.toString()}::bigint, ${MATCH_ID_STR}::bigint, 1, '\\x01'::bytea),
          (${TOTALS_MARKET_ID.toString()}::bigint, ${MATCH_ID_STR}::bigint, 18, '\\x02'::bytea)
      `;
      await app.sql`
        INSERT INTO market_outcomes (market_id, outcome_id, name)
        VALUES
          (${MW_MARKET_ID.toString()}::bigint, '1', 'Arsenal'),
          (${MW_MARKET_ID.toString()}::bigint, 'X', 'Draw'),
          (${MW_MARKET_ID.toString()}::bigint, '2', 'Chelsea'),
          (${TOTALS_MARKET_ID.toString()}::bigint, 'over_2.5', 'Over 2.5'),
          (${TOTALS_MARKET_ID.toString()}::bigint, 'under_2.5', 'Under 2.5')
      `;
    });

    after(async () => {
      await resetBetPinFixtures(app);
    });

    it("returns null when the user has no ticket on the match", async () => {
      await resetTickets(app);
      const pin = await loadBetPin(app, MATCH_ID_STR, FIXTURE.userId);
      assert.equal(pin, null);
    });

    it("pickedSide='home' for outcomeId='1' on the match-winner market", async () => {
      await resetTickets(app);
      await insertTicket(app, {
        id: "00000000-0000-0000-0000-00000be700a1",
        marketId: MW_MARKET_ID,
        outcomeId: "1",
        odds: "2.5000",
      });
      const pin = await loadBetPin(app, MATCH_ID_STR, FIXTURE.userId);
      assert.ok(pin, "bet pin should be returned");
      assert.equal(pin.pickedSide, "home");
      assert.equal(pin.outcomeLabel, "Arsenal");
      assert.equal(pin.oddsX10000, 25000);
      assert.equal(pin.status, "pending");
    });

    it("pickedSide='away' for outcomeId='2' on the match-winner market", async () => {
      await resetTickets(app);
      await insertTicket(app, {
        id: "00000000-0000-0000-0000-00000be700a2",
        marketId: MW_MARKET_ID,
        outcomeId: "2",
        odds: "3.0000",
      });
      const pin = await loadBetPin(app, MATCH_ID_STR, FIXTURE.userId);
      assert.equal(pin?.pickedSide, "away");
      assert.equal(pin?.outcomeLabel, "Chelsea");
    });

    it("pickedSide='draw' for outcomeId='X' on the match-winner market", async () => {
      await resetTickets(app);
      await insertTicket(app, {
        id: "00000000-0000-0000-0000-00000be700a3",
        marketId: MW_MARKET_ID,
        outcomeId: "X",
        odds: "3.4000",
      });
      const pin = await loadBetPin(app, MATCH_ID_STR, FIXTURE.userId);
      assert.equal(pin?.pickedSide, "draw");
    });

    it("pickedSide=null for a ticket on a totals market (not a home/away axis)", async () => {
      await resetTickets(app);
      await insertTicket(app, {
        id: "00000000-0000-0000-0000-00000be700a4",
        marketId: TOTALS_MARKET_ID,
        outcomeId: "over_2.5",
        odds: "1.9000",
      });
      const pin = await loadBetPin(app, MATCH_ID_STR, FIXTURE.userId);
      assert.equal(pin?.pickedSide, null);
      // The BetPin still renders, just without a side-aware colour.
      assert.equal(pin?.outcomeLabel, "Over 2.5");
    });

    it("does NOT surface rejected tickets (returns null)", async () => {
      await resetTickets(app);
      await insertTicket(app, {
        id: "00000000-0000-0000-0000-00000be700a5",
        marketId: MW_MARKET_ID,
        outcomeId: "1",
        odds: "2.5000",
        status: "rejected",
      });
      const pin = await loadBetPin(app, MATCH_ID_STR, FIXTURE.userId);
      assert.equal(pin, null);
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // Phase G — GET /live-chat/viewers batch endpoint. Verifies the
  // chat:viewers:{matchId} key the ws-gateway writes is the same one
  // the API reads; the SET → MGET round-trip is exactly the contract
  // the storefront list page depends on.
  // ───────────────────────────────────────────────────────────────────────────

  describe("Phase G: GET /live-chat/viewers", () => {
    let testApp: FastifyInstance;

    before(async () => {
      // Standalone Fastify with just the plumbing the live-chat
      // routes need. We don't register the real auth plugin (would
      // pull in JWT secret config) — stub the request decorations
      // instead. The /viewers endpoint is public so the stubs are
      // never actually invoked during these tests, but the route
      // module references them at registration so the decorations
      // must exist or load fails.
      testApp = Fastify({ logger: false });
      await testApp.register(dbPlugin, { databaseUrl: DATABASE_URL });
      await testApp.register(redisPlugin, { redisUrl: REDIS_URL });
      testApp.decorateRequest("user", undefined);
      // Throwing stubs satisfy the declared decoration signatures
      // (`never` is the bottom type — assignable to AuthedUser). We
      // never invoke these in Phase G tests since /viewers is public;
      // the decorations exist purely so the route module's
      // registration doesn't fail.
      testApp.decorateRequest("requireAuth", function (): never {
        throw Object.assign(new Error("Unauthorized"), {
          statusCode: 401,
          code: "unauthorized",
        });
      });
      testApp.decorateRequest("requireRole", function (): never {
        throw Object.assign(new Error("Forbidden"), {
          statusCode: 403,
          code: "forbidden",
        });
      });
      // Convert thrown ApiError-shaped objects into JSON the test can
      // assert against. Mirror of services/api/src/server.ts handler.
      testApp.setErrorHandler((err, _req, reply) => {
        const apiErr = err as {
          statusCode?: number;
          code?: string;
          message?: string;
        };
        const status = apiErr.statusCode ?? 500;
        reply.code(status).send({
          error: apiErr.code ?? "error",
          message: apiErr.message ?? "error",
        });
      });
      await testApp.register(liveChatRoutes);
    });

    after(async () => {
      await testApp.close();
    });

    it("returns an empty object when matchIds is missing", async () => {
      const res = await testApp.inject({
        method: "GET",
        url: "/live-chat/viewers",
      });
      assert.equal(res.statusCode, 200);
      assert.deepEqual(res.json(), { counts: {} });
    });

    it("returns 0 for matches with no active room", async () => {
      // ws-gateway DELs the key on the N→0 transition so absent ===
      // empty room. Ensure pre-state matches that contract.
      await app.redis.del(
        `chat:viewers:${MATCH_ID_STR}`,
        "chat:viewers:111",
        "chat:viewers:222",
      );
      const res = await testApp.inject({
        method: "GET",
        url: `/live-chat/viewers?matchIds=${MATCH_ID_STR},111,222`,
      });
      assert.equal(res.statusCode, 200);
      const body = res.json() as { counts: Record<string, number> };
      assert.equal(body.counts[MATCH_ID_STR], 0);
      assert.equal(body.counts["111"], 0);
      assert.equal(body.counts["222"], 0);
    });

    it("returns the count ws-gateway wrote to chat:viewers:{matchId}", async () => {
      await app.redis.set(`chat:viewers:${MATCH_ID_STR}`, "7");
      try {
        const res = await testApp.inject({
          method: "GET",
          url: `/live-chat/viewers?matchIds=${MATCH_ID_STR}`,
        });
        const body = res.json() as { counts: Record<string, number> };
        assert.equal(body.counts[MATCH_ID_STR], 7);
      } finally {
        await app.redis.del(`chat:viewers:${MATCH_ID_STR}`);
      }
    });

    it("rejects malformed matchIds with 400", async () => {
      // Defense-in-depth — without this the route would let a
      // ${app.redis.mget('chat:viewers:abc; --')} style payload reach
      // Redis. ioredis quotes the key so it can't escape, but failing
      // fast at the API surface is the right posture.
      const res = await testApp.inject({
        method: "GET",
        url: "/live-chat/viewers?matchIds=abc",
      });
      assert.equal(res.statusCode, 400);
      const body = res.json() as { error: string };
      assert.equal(body.error, "match_id_invalid");
    });

    it("rejects oversized batches", async () => {
      const tooMany = Array.from({ length: 201 }, (_, i) => String(i + 1)).join(
        ",",
      );
      const res = await testApp.inject({
        method: "GET",
        url: `/live-chat/viewers?matchIds=${tooMany}`,
      });
      assert.equal(res.statusCode, 400);
      const body = res.json() as { error: string };
      assert.equal(body.error, "too_many_match_ids");
    });

    it("de-duplicates repeated IDs and trims whitespace", async () => {
      await app.redis.set(`chat:viewers:${MATCH_ID_STR}`, "3");
      try {
        const res = await testApp.inject({
          method: "GET",
          url: `/live-chat/viewers?matchIds=${MATCH_ID_STR}, ${MATCH_ID_STR}, 999`,
        });
        const body = res.json() as { counts: Record<string, number> };
        assert.equal(body.counts[MATCH_ID_STR], 3);
        assert.equal(body.counts["999"], 0);
      } finally {
        await app.redis.del(`chat:viewers:${MATCH_ID_STR}`);
      }
    });
  });

  // ─── helpers ──────────────────────────────────────────────────────────────

  function sampleUserMessage(id: string, text: string): LiveChatMessage {
    return {
      id,
      matchId: MATCH_ID_STR,
      kind: "user",
      userId: FIXTURE.userId,
      nickname: FIXTURE.nickname,
      avatarInitials: "WA",
      text,
      createdAt: new Date().toISOString(),
    };
  }

  async function flushFixtureKeys(redis: Redis): Promise<void> {
    // Limit cleanup to keys touching THIS match so a shared dev
    // Redis doesn't get nuked.
    const id = MATCH_ID_STR;
    const userId = FIXTURE.userId;
    await redis.del(
      `chat:msgs:${id}`,
      `chat:picks:${id}`,
      `chat:viewers:${id}`,
      `chat:watcher:state:${id}`,
      `chat:rl:msg:${userId}`,
      `chat:rl:rxn:${userId}`,
    );
    // Any dedup locks tagged with the match id.
    const lockKeys = await redis.keys(`chat:watcher:lock:${id}:*`);
    if (lockKeys.length > 0) await redis.del(...lockKeys);
    // Rate-limit windows are timestamped — wipe by prefix.
    const rlKeys = await redis.keys(`chat:rl:*:${userId}:*`);
    if (rlKeys.length > 0) await redis.del(...rlKeys);
  }

  async function resetWatcherFixtures(app: FastifyInstance): Promise<void> {
    await flushFixtureKeys(app.redis);
    await app.sql.unsafe(
      `DELETE FROM live_chat_messages WHERE match_id = ${MATCH_ID_STR}`,
    );
  }

  async function countMessages(app: FastifyInstance): Promise<number> {
    const rows = await app.sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM live_chat_messages
      WHERE match_id = ${MATCH_ID_STR}::bigint
    `;
    return Number(rows[0]?.n ?? 0);
  }

  async function fetchSystemRows(app: FastifyInstance): Promise<
    { systemKind: string; text: string }[]
  > {
    const rows = await app.sql<{ system_kind: string; text: string }[]>`
      SELECT system_kind, text
      FROM live_chat_messages
      WHERE match_id = ${MATCH_ID_STR}::bigint AND kind = 'system'
      ORDER BY id ASC
    `;
    return rows.map((r) => ({ systemKind: r.system_kind, text: r.text }));
  }

  function safeJsonType(s: string): string | null {
    try {
      const o = JSON.parse(s) as { type?: unknown };
      return typeof o.type === "string" ? o.type : null;
    } catch {
      return null;
    }
  }

  async function publishScore(
    pub: Redis,
    matchId: string,
    payload: { home: number; away: number; status: number },
  ): Promise<void> {
    await pub.publish(
      `odds:match:${matchId}`,
      JSON.stringify({
        type: "score",
        matchId,
        liveScore: payload,
      }),
    );
  }

  function sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
  }

  // ─── Phase F fixture helpers ──────────────────────────────────────────────

  async function resetTickets(app: FastifyInstance): Promise<void> {
    // ticket_selections cascade from tickets (onDelete: cascade).
    await app.sql`DELETE FROM tickets WHERE user_id = ${FIXTURE.userId}`;
  }

  async function resetBetPinFixtures(app: FastifyInstance): Promise<void> {
    await resetTickets(app);
    // Cascades to market_outcomes via FK onDelete=cascade.
    await app.sql.unsafe(
      `DELETE FROM markets WHERE match_id = ${MATCH_ID_STR}`,
    );
  }

  async function insertTicket(
    app: FastifyInstance,
    opts: {
      id: string;
      marketId: bigint;
      outcomeId: string;
      odds: string;
      status?: "accepted" | "pending_delay" | "rejected" | "settled";
    },
  ): Promise<void> {
    const status = opts.status ?? "accepted";
    // Stake 1 USDC = 1_000_000 micro; payout = stake * odds.
    const stakeMicro = 1_000_000n;
    const payoutMicro =
      (stakeMicro * BigInt(Math.round(Number(opts.odds) * 10_000))) / 10_000n;
    await app.sql`
      INSERT INTO tickets (
        id, user_id, status, bet_type, currency,
        stake_micro, potential_payout_micro, idempotency_key
      )
      VALUES (
        ${opts.id}, ${FIXTURE.userId}, ${status}::ticket_status, 'single',
        'USDC', ${stakeMicro.toString()}, ${payoutMicro.toString()},
        ${"test-idem-" + opts.id}
      )
    `;
    await app.sql`
      INSERT INTO ticket_selections (
        ticket_id, market_id, outcome_id, odds_at_placement
      )
      VALUES (
        ${opts.id}, ${opts.marketId.toString()}::bigint,
        ${opts.outcomeId}, ${opts.odds}
      )
    `;
  }
}
