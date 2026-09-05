// Unit tests for the pure parts of the ZillaAGI risk-tier reviewer.
//
// These two functions are the whole safety story, so they get the
// attention rather than the prompt:
//
//   parseTierVerdicts — everything the model is allowed to change about
//   production flows through it. A reply it cannot read must assign
//   NOTHING, because NULL prices at the strictest tier and any guess
//   would loosen the book.
//
//   clampTier — the operator's rule ("a Handball World Cup cannot be
//   tier 1") enforced in code rather than hoped for in a paragraph.
//
// Run with: tsx --test src/lib/zagi/risk-tier.test.ts

import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import {
  DEFAULT_TIER_CEILING,
  SIMULATED_MIN_TIER,
  ceilingForSport,
  clampTier,
  looksSimulated,
  normaliseSportSlug,
  parseTierVerdicts,
  renderBatch,
  type RiskTierItem,
} from "./risk-tier.js";

function item(over: Partial<RiskTierItem> = {}): RiskTierItem {
  return {
    tournamentId: 1,
    sportSlug: "football",
    categoryName: "England",
    name: "England. Premier League",
    matchCount: 380,
    ...over,
  };
}

describe("normaliseSportSlug", () => {
  it("strips the Fonbet collision suffix", () => {
    assert.equal(normaliseSportSlug("chess-fb-1437"), "chess");
    assert.equal(normaliseSportSlug("table-tennis"), "table-tennis");
  });

  it("does not strip a legitimate trailing number", () => {
    assert.equal(normaliseSportSlug("basketball-3x3"), "basketball-3x3");
  });
});

describe("ceilingForSport", () => {
  it("gives the four global sports tier 1", () => {
    for (const s of ["football", "basketball", "tennis", "american-football"]) {
      assert.equal(ceilingForSport(s), 1, s);
    }
  });

  it("keeps mid-size sports off tier 1", () => {
    assert.equal(ceilingForSport("handball"), 2);
    assert.equal(ceilingForSport("volleyball"), 2);
    assert.equal(ceilingForSport("darts"), 3);
  });

  it("falls back cautiously for an unlisted sport", () => {
    assert.equal(ceilingForSport("underwater-hockey"), DEFAULT_TIER_CEILING);
    assert.equal(ceilingForSport("fb-1439"), DEFAULT_TIER_CEILING);
  });

  it("resolves a suffixed slug through to the real sport", () => {
    assert.equal(ceilingForSport("chess-fb-1437"), 3);
  });
});

describe("looksSimulated", () => {
  it("catches the video-game brands the feed files under real sports", () => {
    assert.ok(looksSimulated("FC 26. ESportsBattle. La Liga. 2x4 min."));
    assert.ok(looksSimulated("FC 24. EsportsBattle. Volta Bundesliga. 2x3 min."));
    assert.ok(looksSimulated("NBA 2K26. H2H. LIGA-3. East-1. Khabarovsk 4x4"));
    assert.ok(looksSimulated("NHL 26. Regular season"));
  });

  it("catches a Cyrillic clock marker inside an English catalogue", () => {
    // The feed mixes "х" (U+0445) into otherwise-Latin names.
    assert.ok(looksSimulated("FC 24. H2H Volta. 2х3 min."));
    assert.ok(looksSimulated("Some League. 2х4 min."));
  });

  it("reads the category as well as the name", () => {
    assert.ok(looksSimulated("La Liga. Round 3", "FC 26"));
  });

  it("does not flag real competitions that share vocabulary", () => {
    assert.ok(!looksSimulated("Liga Pro. Men", "Table Tennis"));
    assert.ok(!looksSimulated("England. Premier League", "England"));
    assert.ok(!looksSimulated("Champions League. Group stage", "Champions League"));
    // A real esports title, not a simulation of a real sport.
    assert.ok(!looksSimulated("ESL Pro League Season 21", "Auto-mapped"));
  });

  it("is empty-safe", () => {
    assert.ok(!looksSimulated(null, undefined, ""));
  });
});

describe("clampTier", () => {
  it("lets a genuine tier-1 competition through untouched", () => {
    const r = clampTier({
      proposed: 1,
      sportSlug: "football",
      tournamentName: "World Cup. Final stage",
    });
    assert.equal(r.tier, 1);
    assert.equal(r.clampedFrom, null);
    assert.equal(r.bound, null);
  });

  it("enforces the operator's rule: a handball world title is not tier 1", () => {
    const r = clampTier({
      proposed: 1,
      sportSlug: "handball",
      tournamentName: "World Championship. Final stage",
    });
    assert.equal(r.tier, 2);
    assert.equal(r.clampedFrom, 1);
    assert.equal(r.bound, "sport");
  });

  it("never loosens a tier the model set stricter than the ceiling", () => {
    const r = clampTier({
      proposed: 8,
      sportSlug: "football",
      tournamentName: "Bosnia and Herzegovina. League 2",
    });
    assert.equal(r.tier, 8);
    assert.equal(r.clampedFrom, null);
  });

  it("floors simulated fixtures filed under a real sport", () => {
    const r = clampTier({
      proposed: 1,
      sportSlug: "football",
      tournamentName: "FC 26. ESportsBattle. La Liga. 2x4 min.",
      categoryName: "FC 26",
    });
    assert.equal(r.tier, SIMULATED_MIN_TIER);
    assert.equal(r.clampedFrom, 1);
    assert.equal(r.bound, "simulated");
  });

  it("floors Oddin's bot sports whatever the tournament is called", () => {
    const r = clampTier({
      proposed: 2,
      sportSlug: "efootballbots",
      tournamentName: "Some Cup",
    });
    assert.equal(r.tier, SIMULATED_MIN_TIER);
    assert.equal(r.bound, "bots");
  });

  it("keeps a simulated fixture the model already rated T10 at T10", () => {
    const r = clampTier({
      proposed: 10,
      sportSlug: "basketball",
      tournamentName: "NBA 2K26. H2H. LIGA-3",
    });
    assert.equal(r.tier, 10);
    assert.equal(r.clampedFrom, null);
  });

  it("holds an unlisted sport to the cautious default", () => {
    const r = clampTier({ proposed: 1, sportSlug: "lacrosse", tournamentName: "World Cup" });
    assert.equal(r.tier, DEFAULT_TIER_CEILING);
    assert.equal(r.bound, "sport");
  });

  it("keeps the result inside the scale even for absurd input", () => {
    assert.equal(clampTier({ proposed: 99, sportSlug: "football" }).tier, 10);
    assert.equal(clampTier({ proposed: -5, sportSlug: "football" }).tier, 1);
  });
});

describe("parseTierVerdicts", () => {
  it("reads a clean reply", () => {
    const out = parseTierVerdicts(
      '[{"i":0,"tier":3,"why":"top flight"},{"i":1,"tier":7,"why":"regional"}]',
      2,
    );
    assert.equal(out.size, 2);
    assert.equal(out.get(0)?.tier, 3);
    assert.equal(out.get(1)?.why, "regional");
  });

  it("survives a code fence and surrounding prose", () => {
    const out = parseTierVerdicts(
      'Sure! Here you go:\n```json\n[{"i":0,"tier":5,"why":"mid"}]\n```\nHope that helps.',
      1,
    );
    assert.equal(out.get(0)?.tier, 5);
  });

  it("decides nothing when the reply is unreadable", () => {
    // Every one of these must leave the row at NULL, which is the
    // strictest possible position.
    assert.equal(parseTierVerdicts("", 3).size, 0);
    assert.equal(parseTierVerdicts("I could not decide.", 3).size, 0);
    assert.equal(parseTierVerdicts("[{broken", 3).size, 0);
    assert.equal(parseTierVerdicts('{"i":0,"tier":3}', 3).size, 0);
    assert.equal(parseTierVerdicts("[]", 3).size, 0);
  });

  it("drops entries pointing outside the batch", () => {
    const out = parseTierVerdicts('[{"i":0,"tier":3},{"i":9,"tier":1},{"i":-1,"tier":1}]', 2);
    assert.equal(out.size, 1);
    assert.ok(out.has(0));
  });

  it("refuses a tier that is not an integer inside the scale", () => {
    const out = parseTierVerdicts(
      '[{"i":0,"tier":"3"},{"i":1,"tier":2.5},{"i":2,"tier":0},{"i":3,"tier":11},{"i":4,"tier":null}]',
      5,
    );
    assert.equal(out.size, 0);
  });

  it("caps a long justification", () => {
    const out = parseTierVerdicts(
      JSON.stringify([{ i: 0, tier: 4, why: "x".repeat(900) }]),
      1,
    );
    assert.equal(out.get(0)?.why.length, 200);
  });

  it("tolerates a missing why", () => {
    const out = parseTierVerdicts('[{"i":0,"tier":6}]', 1);
    assert.equal(out.get(0)?.tier, 6);
    assert.equal(out.get(0)?.why, "");
  });
});

describe("renderBatch", () => {
  it("numbers items from zero and carries the fields the model needs", () => {
    const text = renderBatch([
      item(),
      item({ tournamentId: 2, sportSlug: "handball", categoryName: "Germany", name: "Germany. Women. Bundesliga 2", matchCount: 7 }),
    ]);
    assert.match(text, /^0\. sport=football category=England matches=380$/mu);
    assert.match(text, /^ {3}name: England\. Premier League$/mu);
    assert.match(text, /^1\. sport=handball category=Germany matches=7$/mu);
  });

  it("is empty for an empty batch", () => {
    assert.equal(renderBatch([]), "");
  });
});
