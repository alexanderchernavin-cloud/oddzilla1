// Unit tests for the operator-paste fixture parser.
//
// Run with: tsx --test src/lib/sportradar/fixtures-input.test.ts

import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { parseFixturesInput } from "./fixtures-input.js";

describe("parseFixturesInput — Sportradar schedule JSON", () => {
  it("reads the shape a licensed schedule endpoint returns", () => {
    const body = JSON.stringify({
      sport_events: [
        {
          id: "sr:match:72221238",
          start_time: "2026-09-06T13:00:00+00:00",
          sport_event_context: { competition: { name: "Premier League" } },
          competitors: [
            { name: "Manchester United", qualifier: "away" },
            { name: "Everton", qualifier: "home" },
          ],
        },
      ],
    });
    const { fixtures, errors } = parseFixturesInput(body, 1);
    assert.deepEqual(errors, []);
    assert.equal(fixtures.length, 1);
    assert.deepEqual(fixtures[0], {
      srMatchId: 72221238,
      srSportId: 1,
      startsAt: "2026-09-06T13:00:00.000Z",
      homeTeam: "Everton",
      awayTeam: "Manchester United",
      tournament: "Premier League",
    });
  });

  it("reads a bare array in our own shape", () => {
    const body = JSON.stringify([
      {
        srMatchId: 5,
        startsAt: "2026-09-06T13:00:00Z",
        homeTeam: "A",
        awayTeam: "B",
      },
    ]);
    const { fixtures } = parseFixturesInput(body, 2);
    assert.equal(fixtures.length, 1);
    assert.equal(fixtures[0]!.srSportId, 2);
  });

  it("reports unreadable JSON instead of throwing", () => {
    const { fixtures, errors } = parseFixturesInput("{ not json", 1);
    assert.equal(fixtures.length, 0);
    assert.equal(errors.length, 1);
    assert.match(errors[0]!.reason, /not valid JSON/u);
  });

  it("rejects JSON without a recognised array", () => {
    const { errors } = parseFixturesInput(JSON.stringify({ nope: 1 }), 1);
    assert.equal(errors.length, 1);
    assert.match(errors[0]!.reason, /sport_events/u);
  });
});

describe("parseFixturesInput — delimited lines", () => {
  it("reads tab-separated rows and skips a header", () => {
    const body = [
      "id\tkickoff\thome\taway\tcompetition",
      "72221238\t2026-09-06T13:00:00Z\tEverton\tManchester United\tPremier League",
      "72221239\t2026-09-06T15:30:00Z\tArsenal\tChelsea",
    ].join("\n");
    const { fixtures, errors } = parseFixturesInput(body, 1);
    assert.deepEqual(errors, []);
    assert.equal(fixtures.length, 2);
    assert.equal(fixtures[0]!.tournament, "Premier League");
    assert.equal(fixtures[1]!.tournament, undefined);
  });

  it("accepts sr:match: prefixed ids and comma or pipe delimiters", () => {
    const { fixtures } = parseFixturesInput(
      "sr:match:1, 2026-09-06T13:00:00Z, Ajax, PSV\n2|2026-09-06T13:00:00Z|Feyenoord|Utrecht",
      1,
    );
    assert.equal(fixtures.length, 2);
    assert.equal(fixtures[0]!.srMatchId, 1);
    assert.equal(fixtures[1]!.homeTeam, "Feyenoord");
  });

  it("reads a naive local-looking timestamp as UTC", () => {
    // "2026-09-06 13:00" must mean the same instant wherever it is
    // pasted — Date would otherwise read it in the server's zone.
    const { fixtures } = parseFixturesInput("1\t2026-09-06 13:00\tA\tB", 1);
    assert.equal(fixtures[0]!.startsAt, "2026-09-06T13:00:00.000Z");
  });

  it("reports bad rows by line number and keeps the good ones", () => {
    const body = [
      "1\t2026-09-06T13:00:00Z\tEverton\tManchester United",
      "not-an-id\t2026-09-06T13:00:00Z\tA\tB",
      "3\tnot-a-date\tA\tB",
      "4\t2026-09-06T13:00:00Z",
    ].join("\n");
    const { fixtures, errors } = parseFixturesInput(body, 1);
    assert.equal(fixtures.length, 1);
    assert.deepEqual(
      errors.map((e) => e.line),
      [2, 3, 4],
    );
  });

  it("ignores blank lines and comments", () => {
    const { fixtures, errors } = parseFixturesInput(
      "\n# a note\n1\t2026-09-06T13:00:00Z\tA\tB\n\n",
      1,
    );
    assert.equal(fixtures.length, 1);
    assert.deepEqual(errors, []);
  });

  it("returns nothing for empty input", () => {
    assert.deepEqual(parseFixturesInput("   ", 1), { fixtures: [], errors: [] });
  });
});
