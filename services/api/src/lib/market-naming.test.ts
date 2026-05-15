// Unit tests for market-name + outcome-name template rendering.
//
// Run with: tsx --test src/lib/market-naming.test.ts

import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import {
  substituteTemplate,
  renderOutcomeLabel,
  deriveScope,
  outcomeSortWeight,
  isCompetitorUrn,
  isPlayerUrn,
  type OutcomeProfiles,
} from "./market-naming.js";

describe("substituteTemplate", () => {
  it("substitutes plain placeholders", () => {
    const out = substituteTemplate("Total kills {threshold} - map {map}", {
      threshold: "45.5",
      map: "2",
    });
    assert.equal(out, "Total kills 45.5 - map 2");
  });

  it("leaves missing placeholder tokens intact", () => {
    const out = substituteTemplate("Total kills {threshold}", {});
    assert.equal(out, "Total kills {threshold}");
  });

  it("resolves {side} to home/away team name when teams are passed", () => {
    const out = substituteTemplate(
      "Team {side} total kills {threshold}",
      { side: "home", threshold: "45.5" },
      { homeTeam: "Astralis", awayTeam: "Vitality" },
    );
    assert.equal(out, "Team Astralis total kills 45.5");
  });

  it("resolves od:player:N specifier values via the players map", () => {
    const profiles: OutcomeProfiles = {
      players: new Map([["od:player:1319", "Myrwn"]]),
    };
    const out = substituteTemplate(
      "{entity} Total kills {threshold} - map {map}",
      { entity: "od:player:1319", threshold: "45.5", map: "2" },
      undefined,
      profiles,
    );
    assert.equal(out, "Myrwn Total kills 45.5 - map 2");
  });

  it("resolves od:competitor:N specifier values via the competitors map", () => {
    const profiles: OutcomeProfiles = {
      competitors: new Map([["od:competitor:12528", "Movistar KOI"]]),
    };
    const out = substituteTemplate(
      "{entity} Total headshot kills {threshold} - map {map}",
      { entity: "od:competitor:12528", threshold: "10.5", map: "1" },
      undefined,
      profiles,
    );
    assert.equal(out, "Movistar KOI Total headshot kills 10.5 - map 1");
  });

  it("keeps the raw URN when no profile lookup is available", () => {
    // Visibly wrong is better than silently dropped — an operator
    // staring at "od:player:1319 Total kills - map 2" can grep the
    // logs for that URN, but a blank label is invisible.
    const profiles: OutcomeProfiles = { players: new Map() };
    const out = substituteTemplate(
      "{entity} Total kills {threshold} - map {map}",
      { entity: "od:player:9999", threshold: "20.5", map: "1" },
      undefined,
      profiles,
    );
    assert.equal(out, "od:player:9999 Total kills 20.5 - map 1");
  });

  it("does not rewrite non-URN values even when profiles is supplied", () => {
    const profiles: OutcomeProfiles = {
      players: new Map([["od:player:1", "ShouldNotMatchThreshold"]]),
    };
    const out = substituteTemplate(
      "Total kills {threshold} - map {map}",
      { threshold: "1", map: "stays-verbatim" },
      undefined,
      profiles,
    );
    assert.equal(out, "Total kills 1 - map stays-verbatim");
  });
});

describe("renderOutcomeLabel", () => {
  it("renders 'home' as home team name", () => {
    const out = renderOutcomeLabel("home", {}, "Astralis", "Vitality");
    assert.equal(out, "Astralis");
  });

  it("renders 'draw' as 'Draw'", () => {
    const out = renderOutcomeLabel("draw", {}, "Astralis", "Vitality");
    assert.equal(out, "Draw");
  });

  it("forwards profiles to substituteTemplate", () => {
    const profiles: OutcomeProfiles = {
      players: new Map([["od:player:1319", "Myrwn"]]),
    };
    const out = renderOutcomeLabel(
      "{entity} kills",
      { entity: "od:player:1319" },
      "Astralis",
      "Vitality",
      profiles,
    );
    assert.equal(out, "Myrwn kills");
  });

  it("resolves a bare URN template directly via profiles", () => {
    // When outcome_descriptions has no row, callers fall back to
    // outcomeId as the template. Player-prop outcomes ARE URNs, so
    // renderOutcomeLabel must resolve them via profiles before any
    // {placeholder} substitution would no-op on them.
    const profiles: OutcomeProfiles = {
      players: new Map([["od:player:1319", "Myrwn"]]),
    };
    const out = renderOutcomeLabel(
      "od:player:1319",
      {},
      "Astralis",
      "Vitality",
      profiles,
    );
    assert.equal(out, "Myrwn");
  });
});

describe("isCompetitorUrn / isPlayerUrn predicates", () => {
  it("classifies URN-prefixed strings", () => {
    assert.equal(isCompetitorUrn("od:competitor:42"), true);
    assert.equal(isPlayerUrn("od:player:1319"), true);
    assert.equal(isCompetitorUrn("od:player:1319"), false);
    assert.equal(isPlayerUrn("od:competitor:42"), false);
    assert.equal(isCompetitorUrn("home"), false);
    assert.equal(isPlayerUrn("1"), false);
  });
});

describe("deriveScope", () => {
  it("returns Match for specifiers without map", () => {
    const s = deriveScope({ threshold: "1.5" });
    assert.deepEqual(s, { id: "match", label: "Match", order: 0 });
  });

  it("returns Map N for specifiers with map", () => {
    const s = deriveScope({ map: "2" });
    assert.deepEqual(s, { id: "map_2", label: "Map 2", order: 2 });
  });
});

describe("outcomeSortWeight", () => {
  it("puts draw (id=3) between home (1) and away (2)", () => {
    const home = outcomeSortWeight("1");
    const draw = outcomeSortWeight("3");
    const away = outcomeSortWeight("2");
    assert.ok(home != null && draw != null && away != null);
    assert.ok(home < draw && draw < away);
  });

  it("returns null for non-numeric outcome ids", () => {
    assert.equal(outcomeSortWeight("od:player:1"), null);
    assert.equal(outcomeSortWeight("over"), null);
  });
});
