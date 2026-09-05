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
  OUTRIGHT_TIER_STEPS,
  SAFETY_MARGIN_STEPS,
  SIMULATED_MIN_TIER,
  ceilingForSport,
  looksOutright,
  looksSimulated,
  normaliseSportSlug,
  parseTierVerdicts,
  renderBatch,
  resolveTier,
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

  it("does not flag a UFC numbered card as an EA FC simulation", () => {
    // Near-miss found while verifying production: an unanchored
    // "fc ?[0-9]{2}" matches "FC 33" inside "UFC 331", which would floor
    // real UFC title fights at T9. The \b in the pattern is what stops
    // it, and it is one careless edit away from being lost.
    assert.ok(
      !looksSimulated("MMA. UFC 331. Los Angeles. Title Bout. Welterweight. 5 rounds"),
    );
    assert.ok(!looksSimulated("MMA. UFC 333. Yas Island. Abu Dhabi. Title Bout"));
    // The genuine article still has to match.
    assert.ok(looksSimulated("FC 26. ESportsBattle. La Liga"));
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

describe("looksOutright", () => {
  it("catches competition-wide markets", () => {
    assert.ok(looksOutright("England. Premier League. Season 26/27"));
    assert.ok(looksOutright("Italy. Serie A. Head-to-head in the tournament"));
    assert.ok(looksOutright("Russia. Premier League. Head-to-head in tournament"));
    assert.ok(looksOutright("Spain. Primera Division. Head-to-head after 10 rounds in tournament"));
    assert.ok(looksOutright("Champions League UEFA. League phase. Head-to-head"));
    assert.ok(looksOutright("Some League. Outright winner"));
  });

  it("leaves SINGLE-event head-to-heads alone", () => {
    // These are ordinary one-off fixtures, not season-long positions —
    // 12 of the 31 head-to-head rows on production are this shape.
    assert.ok(!looksOutright("Vuelta a Espana. Stage 13. Head-to-head"));
    assert.ok(!looksOutright("Formula-1. Grand Prix. Italy. Race. Head-to-head"));
    assert.ok(!looksOutright("Tour of Britain. 5 Stage. Head-to-head"));
    assert.ok(!looksOutright("GP Industria & Artigianato. Head-to-head"));
  });

  it("does not mistake a league called Championship for an outright", () => {
    assert.ok(!looksOutright("Scotland. Championship"));
    assert.ok(!looksOutright("Gaelic football. Galway Championship"));
    assert.ok(!looksOutright("CIS LAN Championship #6"));
  });
});

describe("resolveTier", () => {
  it("adds the safety margin to every verdict, so ZAGI can never assign T1", () => {
    const r = resolveTier({
      proposed: 1,
      sportSlug: "football",
      tournamentName: "World Cup. Final stage",
    });
    assert.equal(r.tier, 1 + SAFETY_MARGIN_STEPS);
    assert.equal(r.proposed, 1);
    assert.equal(r.safetyStep, SAFETY_MARGIN_STEPS);
    assert.equal(r.outrightStep, 0);
    assert.equal(r.floorBound, null);
  });

  it("steps a season outright down three further tiers", () => {
    const r = resolveTier({
      proposed: 2,
      sportSlug: "football",
      tournamentName: "Italy. Serie A. Season 26/27",
    });
    assert.equal(r.tier, 2 + SAFETY_MARGIN_STEPS + OUTRIGHT_TIER_STEPS);
    assert.equal(r.outrightStep, OUTRIGHT_TIER_STEPS);
  });

  it("does not step a per-stage head-to-head as an outright", () => {
    const r = resolveTier({
      proposed: 3,
      sportSlug: "cycling",
      tournamentName: "Vuelta a Espana. Stage 13. Head-to-head",
    });
    assert.equal(r.tier, 3 + SAFETY_MARGIN_STEPS);
    assert.equal(r.outrightStep, 0);
  });

  it("enforces the operator's rule: a handball world title is not tier 1", () => {
    // The margin alone would give T2; the sport ceiling is also 2, so the
    // margin is what binds and the floor reports as not having acted.
    const r = resolveTier({
      proposed: 1,
      sportSlug: "handball",
      tournamentName: "World Championship. Final stage",
    });
    assert.equal(r.tier, 2);
    assert.ok(r.tier >= ceilingForSport("handball"));
  });

  it("reports the floor only when it tightens beyond the steps", () => {
    // Unlisted sport, ceiling 4. Proposed 1 + margin = 2, so the ceiling
    // does the remaining work and must say so.
    const r = resolveTier({ proposed: 1, sportSlug: "lacrosse", tournamentName: "World Cup" });
    assert.equal(r.tier, DEFAULT_TIER_CEILING);
    assert.equal(r.floorBound, "sport");
  });

  it("never loosens a tier the model set stricter than every bound", () => {
    const r = resolveTier({
      proposed: 8,
      sportSlug: "football",
      tournamentName: "Bosnia and Herzegovina. League 2",
    });
    assert.equal(r.tier, 8 + SAFETY_MARGIN_STEPS);
    assert.equal(r.floorBound, null);
  });

  it("floors simulated fixtures filed under a real sport", () => {
    const r = resolveTier({
      proposed: 1,
      sportSlug: "football",
      tournamentName: "FC 26. ESportsBattle. La Liga. 2x4 min.",
      categoryName: "FC 26",
    });
    assert.equal(r.tier, SIMULATED_MIN_TIER);
    assert.equal(r.floorBound, "simulated");
  });

  it("floors Oddin's bot sports whatever the tournament is called", () => {
    const r = resolveTier({
      proposed: 2,
      sportSlug: "efootballbots",
      tournamentName: "Some Cup",
    });
    assert.equal(r.tier, SIMULATED_MIN_TIER);
    assert.equal(r.floorBound, "bots");
  });

  it("keeps the result inside the scale even for absurd input", () => {
    assert.equal(resolveTier({ proposed: 99, sportSlug: "football" }).tier, 10);
    // -5 + margin is still below the scale; the floor is 1, and football's
    // ceiling is 1, so it lands at the ceiling.
    assert.equal(resolveTier({ proposed: -5, sportSlug: "football" }).tier, 1);
  });

  it("cannot exceed T10 even when every step stacks", () => {
    const r = resolveTier({
      proposed: 9,
      sportSlug: "football",
      tournamentName: "England. Premier League. Season 26/27",
    });
    assert.equal(r.tier, 10);
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
