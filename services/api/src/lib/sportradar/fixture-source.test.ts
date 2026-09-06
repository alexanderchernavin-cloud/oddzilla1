// Unit tests for the Sportradar statistics-feed reader.
//
// Run with: tsx --test src/lib/sportradar/fixture-source.test.ts

import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import {
  SportradarFetchError,
  createStatsFixtureSource,
  parseSportMatches,
  toFixture,
} from "./fixture-source.js";

// Shape copied from a real sport_matches/1/2026-09-06 response.
function gismoMatch(over: Record<string, unknown> = {}) {
  return {
    _doc: "match",
    _doctype: "soccer",
    _id: 72221238,
    _sid: 1,
    _dt: { _doc: "time", time: "13:00", date: "06/09/26", tz: "UTC", uts: 1788699600 },
    teams: {
      home: { _doc: "team", _id: 4867, name: "Everton", mediumname: "Everton FC" },
      away: { _doc: "team", _id: 4862, name: "Manchester United", mediumname: "Manchester United" },
    },
    coverage: { lmtsupport: 4 },
    ...over,
  };
}

function body(matches: unknown[], tournament = "Premier League") {
  // The feed nests matches inside a sport → category → tournament tree
  // whose exact shape varies by sport.
  return {
    queryUrl: "sport_matches/1/2026-09-06",
    doc: [
      {
        event: "sport_matches",
        data: {
          sport: {
            _doc: "sport",
            _id: 1,
            name: "Soccer",
            realcategories: [
              {
                _doc: "realcategory",
                _id: 1,
                name: "England",
                tournaments: [{ _doc: "tournament", _id: 17, name: tournament, matches }],
              },
            ],
          },
        },
      },
    ],
  };
}

describe("toFixture", () => {
  it("reads the fields the matcher needs", () => {
    assert.deepEqual(toFixture(gismoMatch()), {
      srMatchId: 72221238,
      srSportId: 1,
      startsAt: "2026-09-06T13:00:00.000Z",
      homeTeam: "Everton",
      awayTeam: "Manchester United",
      // The longer form rides along only where it differs: Manchester
      // United's does not, so no `awayTeamAlt`.
      homeTeamAlt: "Everton FC",
    });
  });

  it("carries the longer name form because the short one can be a city", () => {
    // Shape copied from sport_matches/1/2026-09-06: Sportradar's short
    // name for FC Twente is its city, and Fonbet's is "Twente".
    const m = gismoMatch({
      teams: {
        home: { _doc: "team", name: "Groningen", mediumname: "FC Groningen" },
        away: { _doc: "team", name: "Enschede", mediumname: "FC Twente Enschede" },
      },
    });
    const f = toFixture(m);
    assert.equal(f?.awayTeam, "Enschede");
    assert.equal(f?.awayTeamAlt, "FC Twente Enschede");
    assert.equal(f?.homeTeamAlt, "FC Groningen");
  });

  it("falls back to mediumname when name is absent", () => {
    const m = gismoMatch({
      teams: {
        home: { mediumname: "Everton FC" },
        away: { name: "Manchester United" },
      },
    });
    const f = toFixture(m);
    assert.equal(f?.homeTeam, "Everton FC");
    // Same string twice is not an alternative.
    assert.equal(f?.homeTeamAlt, undefined);
  });

  it("drops a to-be-announced kickoff", () => {
    // The timestamp on those is a placeholder; pairing on it is pairing
    // on noise.
    assert.equal(toFixture(gismoMatch({ tobeannounced: true })), null);
  });

  it("drops a removed fixture", () => {
    assert.equal(toFixture(gismoMatch({ removed: true })), null);
  });

  it("drops records missing an id, a kickoff or a team", () => {
    assert.equal(toFixture(gismoMatch({ _id: undefined })), null);
    assert.equal(toFixture(gismoMatch({ _dt: {} })), null);
    assert.equal(toFixture(gismoMatch({ teams: { home: {}, away: { name: "B" } } })), null);
  });
});

describe("parseSportMatches", () => {
  it("finds matches wherever the tree puts them", () => {
    const fixtures = parseSportMatches(body([gismoMatch()]));
    assert.equal(fixtures.length, 1);
    assert.equal(fixtures[0]!.srMatchId, 72221238);
  });

  it("carries the enclosing tournament name onto the fixture", () => {
    // The only place this feed says a fixture is women's or youth: the
    // team is "Chelsea" whether it plays in the Premier League or in
    // "Super League, Women", so the matcher needs the competition.
    const [fixture] = parseSportMatches(body([gismoMatch()], "Super League, Women"));
    assert.equal(fixture?.tournament, "Super League, Women");
    // Nothing is invented when the tree has no named tournament.
    const bare = parseSportMatches({
      doc: [{ event: "sport_matches", data: { matches: [gismoMatch()] } }],
    });
    assert.equal(bare[0]?.tournament, undefined);
  });

  it("de-duplicates a match listed under more than one node", () => {
    // The matcher assumes each fixture appears once; the tree does not
    // guarantee it.
    const fixtures = parseSportMatches(body([gismoMatch(), gismoMatch()]));
    assert.equal(fixtures.length, 1);
  });

  it("surfaces a feed-level exception as an error", () => {
    const errBody = {
      doc: [
        {
          event: "exception",
          data: { message: "Ups! Something went wrong", code: 0 },
        },
      ],
    };
    assert.throws(() => parseSportMatches(errBody), SportradarFetchError);
  });

  it("returns nothing for an empty or malformed body", () => {
    assert.deepEqual(parseSportMatches({}), []);
    assert.deepEqual(parseSportMatches({ doc: [] }), []);
    assert.deepEqual(parseSportMatches(null), []);
  });
});

describe("createStatsFixtureSource", () => {
  it("rejects a malformed date before making a request", async () => {
    let called = false;
    const source = createStatsFixtureSource({
      fetchImpl: (async () => {
        called = true;
        return new Response("{}");
      }) as unknown as typeof fetch,
    });
    await assert.rejects(() => source.fetchDay(1, "06/09/2026"), SportradarFetchError);
    assert.equal(called, false);
  });

  it("builds the documented URL and parses the response", async () => {
    let seen = "";
    const source = createStatsFixtureSource({
      baseUrl: "https://example.test/gismo",
      fetchImpl: (async (url: string) => {
        seen = url;
        return new Response(JSON.stringify(body([gismoMatch()])), {
          headers: { "content-type": "application/json" },
        });
      }) as unknown as typeof fetch,
    });
    const fixtures = await source.fetchDay(1, "2026-09-06");
    assert.equal(seen, "https://example.test/gismo/sport_matches/1/2026-09-06");
    assert.equal(fixtures.length, 1);
  });

  it("turns a non-200 into a typed error carrying the status", async () => {
    const source = createStatsFixtureSource({
      fetchImpl: (async () => new Response("nope", { status: 503 })) as unknown as typeof fetch,
    });
    await assert.rejects(
      () => source.fetchDay(1, "2026-09-06"),
      (err: unknown) =>
        err instanceof SportradarFetchError && err.status === 503,
    );
  });
});
