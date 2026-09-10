// Unit tests for the SlotZilla corpus parser and fetch loop, against
// trimmed documents saved from stats.fn.sportradar.com on 2026-09-09
// (testdata/*.json).
//
// Run with: tsx --test src/lib/slotzilla/corpus.test.ts

import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { SportradarFetchError } from "../sportradar/fixture-source.js";
import {
  createCorpusClient,
  dayRange,
  parseEvent,
  parseSportDay,
  parseTimeline,
  toEventRow,
} from "./corpus.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (name: string): unknown =>
  JSON.parse(readFileSync(join(here, "testdata", name), "utf8"));

describe("parseTimeline", () => {
  const parsed = parseTimeline(fixture("match_timeline.json"));

  it("reads the match header", () => {
    assert.equal(parsed.match.srMatchId, "71036316");
    assert.equal(parsed.match.srSportId, 2);
    assert.equal(parsed.match.homeTeam, "Italy");
    assert.equal(parsed.match.awayTeam, "Australia");
    assert.equal(parsed.match.playedSeconds, 2100);
    assert.equal(parsed.match.running, true);
    assert.equal(parsed.match.started, true);
    assert.equal(parsed.match.ended, true);
    assert.equal(parsed.match.coverageLevel, 3);
    assert.deepEqual(parsed.match.result, { home: 80, away: 82 });
    assert.equal(parsed.dob, 1788988941);
  });

  it("keeps only clock-bearing events and derives the symbol once", () => {
    // The fixture holds 26 events; period starts and clock stops carry
    // seconds -1 and are dropped.
    assert.ok(parsed.events.length > 0);
    assert.ok(parsed.events.length < 26);
    for (const e of parsed.events) assert.ok(e.seconds >= 0);
    const goal = parsed.events.find((e) => e.srEventId === "2458477790");
    assert.ok(goal);
    assert.equal(goal.type, "goal");
    assert.equal(goal.points, 2);
    assert.equal(goal.symbol, "P2");
    assert.equal(goal.team, "away");
    assert.equal(goal.seconds, 14);
    assert.equal(goal.uts, 1788979558);
    const ft = parsed.events.find((e) => e.srEventId === "2458478538");
    assert.equal(ft?.symbol, "FT");
    const miss = parsed.events.find((e) => e.srEventId === "2458478122");
    assert.equal(miss?.symbol, "MISS");
    const foul = parsed.events.find((e) => e.srEventId === "2458478230");
    assert.equal(foul?.symbol, "FOUL");
    assert.equal(foul?.updatedUts, 1788979589);
    const rebound = parsed.events.find((e) => e.type === "rebound");
    assert.equal(rebound?.symbol, null);
  });

  it("throws the feed's exception message", () => {
    assert.throws(
      () => parseTimeline(fixture("exception.json")),
      (err: unknown) =>
        err instanceof SportradarFetchError && /Match not found/u.test(err.message),
    );
  });
});

describe("parseEvent", () => {
  it("drops events without a clock reading or id", () => {
    assert.equal(parseEvent({ _id: 1, type: "periodstart", seconds: -1 }, "9"), null);
    assert.equal(parseEvent({ type: "goal", seconds: 10 }, "9"), null);
    assert.equal(parseEvent(null, "9"), null);
  });

  it("reads scorer then player, a disabled flag in any spelling, and string seconds", () => {
    const e = parseEvent(
      {
        _id: "77",
        type: "goal",
        points: 3,
        seconds: "125",
        uts: 5,
        team: "home",
        disabled: "1",
        period: 2,
        scorer: { _id: 4242, name: "A. Player" },
      },
      "9",
    );
    assert.ok(e);
    assert.equal(e.symbol, "P3");
    assert.equal(e.seconds, 125);
    assert.equal(e.disabled, true);
    assert.equal(e.playerId, "4242");
    assert.equal(e.playerName, "A. Player");
    assert.equal(e.updatedUts, 5);
    const row = toEventRow(e);
    assert.equal(row.srEventId, 77n);
    assert.equal(row.srMatchId, 9n);
    assert.equal(row.matchId, null);
    assert.equal(row.playerId, 4242n);
  });

  it("never guesses a goal with an unknown point value", () => {
    const e = parseEvent({ _id: 1, type: "goal", seconds: 3, points: null }, "9");
    assert.equal(e?.symbol, null);
  });
});

describe("parseSportDay", () => {
  it("lists every match once with its ended flag", () => {
    const day = parseSportDay(fixture("sport_matches.json"), 1788984495);
    assert.ok(day.length >= 2);
    const ended = day.find((m) => m.srMatchId === "71036226");
    assert.ok(ended);
    assert.equal(ended.ended, true);
    assert.equal(ended.srSportId, 2);
    const upcoming = day.find((m) => m.srMatchId === "71036222");
    assert.ok(upcoming);
    assert.equal(upcoming.ended, false);
    assert.equal(new Set(day.map((m) => m.srMatchId)).size, day.length);
  });

  it("treats a past kickoff with a score as ended when the status lags", () => {
    const body = {
      doc: [
        {
          event: "sport_matches",
          data: {
            sport: {
              _doc: "sport",
              realcategories: [
                {
                  tournaments: [
                    {
                      matches: [
                        {
                          _doc: "match",
                          _id: 5,
                          _sid: 2,
                          _dt: { uts: 1000 },
                          result: { home: 70, away: 60 },
                          status: { name: "Not started" },
                        },
                      ],
                    },
                  ],
                },
              ],
            },
          },
        },
      ],
    };
    const [m] = parseSportDay(body, 1000 + 4 * 3600);
    assert.equal(m?.ended, true);
    const [fresh] = parseSportDay(body, 1000 + 60);
    assert.equal(fresh?.ended, false);
  });
});

describe("dayRange", () => {
  it("expands an inclusive range", () => {
    assert.deepEqual(dayRange("2026-09-07", "2026-09-09"), [
      "2026-09-07",
      "2026-09-08",
      "2026-09-09",
    ]);
  });
  it("refuses an inverted range", () => {
    assert.throws(() => dayRange("2026-09-09", "2026-09-07"), RangeError);
  });
});

describe("createCorpusClient", () => {
  it("sends a browser UA and parses both endpoints", async () => {
    const urls: string[] = [];
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url);
      urls.push(u);
      const ua = (init?.headers as Record<string, string>)["user-agent"] ?? "";
      assert.match(ua, /Mozilla/u);
      const body = u.includes("sport_matches/")
        ? fixture("sport_matches.json")
        : fixture("match_timeline.json");
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;
    const client = createCorpusClient({ baseUrl: "https://example.test/gismo/", fetchImpl });
    const day = await client.fetchDay(2, "2026-09-07");
    assert.ok(day.length > 0);
    const timeline = await client.fetchTimeline("71036316");
    assert.equal(timeline.match.srMatchId, "71036316");
    assert.deepEqual(urls, [
      "https://example.test/gismo/sport_matches/2/2026-09-07",
      "https://example.test/gismo/match_timeline/71036316",
    ]);
  });

  it("surfaces a non-200 as a SportradarFetchError with the status", async () => {
    const fetchImpl = (async () => new Response("nope", { status: 403 })) as unknown as typeof fetch;
    const client = createCorpusClient({ fetchImpl });
    await assert.rejects(
      client.fetchTimeline("1"),
      (err: unknown) => err instanceof SportradarFetchError && err.status === 403,
    );
  });

  it("validates its arguments before touching the network", async () => {
    const client = createCorpusClient({
      fetchImpl: (async () => {
        throw new Error("should not fetch");
      }) as unknown as typeof fetch,
    });
    await assert.rejects(client.fetchDay(2, "07/09/2026"), SportradarFetchError);
    await assert.rejects(client.fetchTimeline("abc"), SportradarFetchError);
  });
});
