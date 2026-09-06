// Unit tests for the LLM adjudicator's pure parts.
//
// The parsing tests matter more than the prompt ones: everything this
// module is allowed to do to production data flows through
// parseVerdicts, and a reply it cannot read must decide NOTHING rather
// than default to anything.
//
// Run with: tsx --test src/lib/sportradar/adjudicator.test.ts

import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import {
  createAdjudicator,
  parseVerdicts,
  renderBatch,
  type AdjudicationItem,
} from "./adjudicator.js";

function item(over: Partial<AdjudicationItem> = {}): AdjudicationItem {
  return {
    matchId: "1182129",
    sportSlug: "football",
    tournamentName: "England. Premier League",
    homeTeam: "Ipswich Town",
    awayTeam: "Liverpool",
    srHomeTeam: "Ipswich",
    srAwayTeam: "Liverpool",
    kickoffDeltaMinutes: 0,
    ...over,
  };
}

describe("renderBatch", () => {
  it("numbers items from zero and shows both providers", () => {
    const text = renderBatch([item(), item({ homeTeam: "Hellas Verona", srHomeTeam: "Verona" })]);
    assert.match(text, /^0\. sport=football kickoff_diff=0min/u);
    assert.match(text, /ours:\s+Ipswich Town\s+vs\s+Liverpool\s+\[England\. Premier League\]/u);
    assert.match(text, /sportradar:\s+Ipswich\s+vs\s+Liverpool/u);
    assert.match(text, /\n1\. sport=football/u);
  });

  it("shows Sportradar's competition when the fixture carried one", () => {
    // Sportradar marks women's / youth on the competition, not the team,
    // so without it the model reads "Chelsea vs Aston Villa" as the
    // men's fixture.
    const text = renderBatch([
      item({ homeTeam: "Chelsea (w)", awayTeam: "Aston Villa (w)", srHomeTeam: "Chelsea", srAwayTeam: "Aston Villa", srTournament: "Super League, Women" }),
    ]);
    assert.match(text, /sportradar:\s+Chelsea\s+vs\s+Aston Villa\s+\[Super League, Women\]/u);
    // And nothing dangling when it did not.
    assert.match(renderBatch([item()]), /sportradar:\s+Ipswich\s+vs\s+Liverpool$/mu);
  });

  it("renders a null kickoff delta as zero rather than 'null'", () => {
    assert.match(renderBatch([item({ kickoffDeltaMinutes: null })]), /kickoff_diff=0min/u);
  });

  it("shows Sportradar's longer name form beside the short one", () => {
    // The short form can be a city. Shown "Enschede (FC Twente Enschede)"
    // the model sees the club; shown "Enschede" alone it has to know
    // Dutch football geography.
    const text = renderBatch([
      item({
        homeTeam: "Groningen",
        awayTeam: "Twente",
        srHomeTeam: "Groningen",
        srHomeTeamAlt: "FC Groningen",
        srAwayTeam: "Enschede",
        srAwayTeamAlt: "FC Twente Enschede",
      }),
    ]);
    assert.match(
      text,
      /sportradar:\s+Groningen \(FC Groningen\)\s+vs\s+Enschede \(FC Twente Enschede\)/u,
    );
    // An identical longer form is not repeated.
    assert.match(
      renderBatch([item({ srHomeTeamAlt: "Ipswich" })]),
      /sportradar:\s+Ipswich\s+vs\s+Liverpool$/mu,
    );
  });
});

describe("parseVerdicts", () => {
  it("reads a clean array", () => {
    const got = parseVerdicts(
      '[{"i":0,"verdict":"same","reason":"abbreviation"},{"i":1,"verdict":"different","reason":"other club"}]',
      2,
    );
    assert.equal(got.get(0)?.verdict, "same");
    assert.equal(got.get(0)?.reason, "abbreviation");
    assert.equal(got.get(1)?.verdict, "different");
  });

  it("tolerates code fences and surrounding prose", () => {
    const got = parseVerdicts(
      'Here you go:\n```json\n[{"i":0,"verdict":"same"}]\n```\nHope that helps.',
      1,
    );
    assert.equal(got.get(0)?.verdict, "same");
  });

  it("decides nothing when the reply is not JSON", () => {
    assert.equal(parseVerdicts("I could not determine these.", 3).size, 0);
    assert.equal(parseVerdicts("", 3).size, 0);
    assert.equal(parseVerdicts("[not json", 3).size, 0);
  });

  it("drops an out-of-range or non-integer index", () => {
    // A verdict must land on the row it names or not at all — an index
    // the batch does not contain could otherwise decide the wrong match.
    const got = parseVerdicts(
      '[{"i":5,"verdict":"same"},{"i":-1,"verdict":"same"},{"i":1.5,"verdict":"same"},{"i":"0","verdict":"same"}]',
      2,
    );
    assert.equal(got.size, 0);
  });

  it("drops a verdict that is not one of the three literals", () => {
    const got = parseVerdicts(
      '[{"i":0,"verdict":"probably"},{"i":1,"verdict":"SAME"},{"i":2,"verdict":true},{"i":3}]',
      4,
    );
    assert.equal(got.size, 0);
  });

  it("keeps the good entries when others are malformed", () => {
    const got = parseVerdicts(
      '[{"i":0,"verdict":"same"},{"i":9,"verdict":"different"},{"i":1,"verdict":"unsure"}]',
      2,
    );
    assert.equal(got.size, 2);
    assert.equal(got.get(0)?.verdict, "same");
    assert.equal(got.get(1)?.verdict, "unsure");
  });

  it("caps a runaway reason instead of storing it whole", () => {
    const got = parseVerdicts(
      JSON.stringify([{ i: 0, verdict: "same", reason: "x".repeat(5000) }]),
      1,
    );
    assert.equal(got.get(0)?.reason.length, 200);
  });

  it("ignores a non-array payload", () => {
    assert.equal(parseVerdicts('{"i":0,"verdict":"same"}', 1).size, 0);
    assert.equal(parseVerdicts("[null, 3, \"same\"]", 1).size, 0);
  });
});

describe("createAdjudicator", () => {
  it("posts to <base>/chat/completions with the model and both messages", async () => {
    let seenUrl = "";
    let seenBody: Record<string, unknown> = {};
    let seenAuth = "";
    const adj = createAdjudicator({
      baseUrl: "https://llm.example.test/v1/",
      apiKey: "k-test",
      model: "test-model",
      fetchImpl: (async (url: string, init: RequestInit) => {
        seenUrl = url;
        seenAuth = (init.headers as Record<string, string>).authorization ?? "";
        seenBody = JSON.parse(init.body as string);
        return new Response(JSON.stringify({ choices: [{ message: { content: '[{"i":0,"verdict":"same"}]' } }] }));
      }) as unknown as typeof fetch,
    });

    const got = await adj.decide([item()]);
    // Trailing slash on the base must not produce a double slash.
    assert.equal(seenUrl, "https://llm.example.test/v1/chat/completions");
    assert.equal(seenAuth, "Bearer k-test");
    assert.equal(seenBody.model, "test-model");
    assert.equal(seenBody.temperature, 0);
    assert.equal((seenBody.messages as unknown[]).length, 2);
    assert.equal(got.get(0)?.verdict, "same");
  });

  it("makes no request for an empty batch", async () => {
    let called = false;
    const adj = createAdjudicator({
      baseUrl: "https://llm.example.test/v1",
      apiKey: "k",
      model: "m",
      fetchImpl: (async () => {
        called = true;
        return new Response("{}");
      }) as unknown as typeof fetch,
    });
    assert.equal((await adj.decide([])).size, 0);
    assert.equal(called, false);
  });

  it("throws on a non-200 so the caller can leave the batch queued", async () => {
    const adj = createAdjudicator({
      baseUrl: "https://llm.example.test/v1",
      apiKey: "k",
      model: "m",
      fetchImpl: (async () => new Response("nope", { status: 502 })) as unknown as typeof fetch,
    });
    await assert.rejects(() => adj.decide([item()]), /HTTP 502/u);
  });

  it("decides nothing when the reply carries no content", async () => {
    const adj = createAdjudicator({
      baseUrl: "https://llm.example.test/v1",
      apiKey: "k",
      model: "m",
      fetchImpl: (async () =>
        new Response(JSON.stringify({ choices: [{ message: {} }] }))) as unknown as typeof fetch,
    });
    assert.equal((await adj.decide([item()])).size, 0);
  });
});
