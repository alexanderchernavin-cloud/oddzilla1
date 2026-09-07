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

  it("orders Fonbet's h1/h2 line sides like Oddin's 1/2", () => {
    // Both columns of a handicap ladder now render a TEAM NAME, so the
    // undefined row order they used to fall back to would put the away
    // side in the column a bettor reads as home.
    assert.equal(outcomeSortWeight("h1"), 1);
    assert.equal(outcomeSortWeight("h2"), 2);
  });

  it("returns null for non-numeric outcome ids", () => {
    assert.equal(outcomeSortWeight("od:player:1"), null);
    assert.equal(outcomeSortWeight("over"), null);
  });
});

// Team-numbered market captions. Every string below is a real label from
// the live catalogue (2026-09-05); the negatives are the near misses that
// share the shape but say nothing about a team.
describe("team-numbered market names", () => {
  const teams = { homeTeam: "Swansea", awayTeam: "Wrexham" };

  it("names the home side for a Fonbet team-1 table", () => {
    assert.equal(
      substituteTemplate("Team 1 totals {threshold}", { threshold: "1.5" }, teams),
      "Swansea totals 1.5",
    );
  });

  it("names the away side for the team-2 twin", () => {
    assert.equal(
      substituteTemplate("Team 2 totals {threshold}", { threshold: "1.5" }, teams),
      "Wrexham totals 1.5",
    );
  });

  it("handles the other table wording for the same market", () => {
    assert.equal(
      substituteTemplate("Team Totals-1 {threshold}", { threshold: "20.5" }, teams),
      "Swansea totals 20.5",
    );
    assert.equal(
      substituteTemplate("Team Totals-2 {threshold}", { threshold: "20.5" }, teams),
      "Wrexham totals 20.5",
    );
  });

  it("keeps the sub-event prefix, which is the tab the market sits on", () => {
    assert.equal(
      substituteTemplate(
        "1st half corners: Team 1 totals {threshold}",
        { threshold: "3.5" },
        teams,
      ),
      "1st half corners: Swansea totals 3.5",
    );
  });

  it("names the team in Russian too", () => {
    assert.equal(
      substituteTemplate("Инд. тоталы-1 {threshold}", { threshold: "1.5" }, teams, undefined, "ru"),
      "Инд. тотал Swansea 1.5",
    );
    assert.equal(
      substituteTemplate("Победа 2", {}, teams, undefined, "ru"),
      "Победа Wrexham",
    );
  });

  it("covers the win tables and the leaked %1 / %2 placeholder", () => {
    assert.equal(substituteTemplate("1 to win", {}, teams), "Swansea to win");
    assert.equal(substituteTemplate("2 to win", {}, teams), "Wrexham to win");
    assert.equal(
      substituteTemplate("%2 Total round in 1st half {threshold}", { threshold: "12.5" }, teams),
      "Wrexham Total round in 1st half 12.5",
    );
  });

  it("leaves captions that merely contain a digit alone", () => {
    for (const label of [
      "1x2",
      "Score after 2 goals scored",
      "Score after 2 maps",
      "Score after 2 sets",
      "score in the series after 2 matches",
      "Счет после 2-х забитых голов",
      "Total {threshold}",
    ]) {
      assert.equal(substituteTemplate(label, { threshold: "2.5" }, teams), label.replace("{threshold}", "2.5"));
    }
  });

  it("keeps the generic caption when the caller has no match", () => {
    // The admin feed log and the backoffice market pickers render markets
    // with no fixture in hand — there is no team to name there.
    assert.equal(
      substituteTemplate("Team 1 totals {threshold}", { threshold: "1.5" }),
      "Team 1 totals 1.5",
    );
  });
});

describe("team numbers in outcome labels", () => {
  it("leaves them alone — the market header above already names the team", () => {
    // Fonbet writes some outcome captions mid-sentence ("individual total
    // of shots for team 2"); swapping the number for a name in there reads
    // as broken grammar rather than as a clarification, and the market
    // name above the cell has already said which team it is. Measured
    // across all 25 096 outcome templates on the live catalogue: this is
    // the only shape the market-name rules would otherwise have caught.
    assert.equal(
      renderOutcomeLabel(
        "Фрейм {threshold}: инд. тотал-2 ударов Больше",
        { threshold: "2.5" },
        "Swansea",
        "Wrexham",
        undefined,
        "ru",
      ),
      "Фрейм 2.5: инд. тотал-2 ударов Больше",
    );
  });

  it("still resolves the home / away outcome templates", () => {
    assert.equal(renderOutcomeLabel("home", {}, "Swansea", "Wrexham"), "Swansea");
    assert.equal(renderOutcomeLabel("away", {}, "Swansea", "Wrexham"), "Wrexham");
  });
});
