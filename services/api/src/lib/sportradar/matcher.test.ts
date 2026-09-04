// Unit tests for the Sportradar fixture matcher.
//
// Run with: tsx --test src/lib/sportradar/matcher.test.ts

import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import type { SportradarFixture } from "@oddzilla/types/sportradar";
import {
  normaliseTeamName,
  proposeMappings,
  scorePair,
  teamSimilarity,
  type OddzillaFixture,
} from "./matcher.js";

const KICKOFF = "2026-09-06T13:00:00.000Z";

function ours(over: Partial<OddzillaFixture> = {}): OddzillaFixture {
  return {
    matchId: "1183756",
    srSportId: 1,
    scheduledAt: KICKOFF,
    homeTeam: "Everton",
    awayTeam: "Manchester United",
    ...over,
  };
}

function theirs(over: Partial<SportradarFixture> = {}): SportradarFixture {
  return {
    srMatchId: 72221238,
    srSportId: 1,
    startsAt: KICKOFF,
    homeTeam: "Everton FC",
    awayTeam: "Manchester Utd",
    ...over,
  };
}

describe("normaliseTeamName", () => {
  it("strips diacritics, punctuation and club designators", () => {
    assert.deepEqual(normaliseTeamName("Málaga CF").tokens, ["malaga"]);
    assert.deepEqual(normaliseTeamName("Beşiktaş JK").tokens, ["besiktas", "jk"]);
    assert.deepEqual(normaliseTeamName("FC Bayern München").tokens, ["bayern", "munchen"]);
    assert.deepEqual(normaliseTeamName("Brighton & Hove Albion").tokens, [
      "brighton",
      "hove",
      "albion",
    ]);
  });

  it("keeps digits, which distinguish real clubs", () => {
    assert.deepEqual(normaliseTeamName("Schalke 04").tokens, ["schalke", "04"]);
  });

  it("splits squad qualifiers out of the token list", () => {
    const youth = normaliseTeamName("Lokomotiv Moscow (youth)");
    assert.deepEqual(youth.tokens, ["lokomotiv", "moscow"]);
    assert.equal(youth.age, "youth");

    const women = normaliseTeamName("Barcelona W");
    assert.deepEqual(women.tokens, ["barcelona"]);
    assert.equal(women.gender, "w");
  });

  it("never returns an empty token list", () => {
    // A name made entirely of designators keeps them rather than
    // normalising to nothing, which would match everything.
    assert.ok(normaliseTeamName("FC").tokens.length > 0);
  });
});

describe("teamSimilarity", () => {
  it("scores abbreviations via prefix equality", () => {
    assert.equal(teamSimilarity("Manchester United", "Man Utd"), 1);
    assert.equal(teamSimilarity("Everton", "Everton FC"), 1);
  });

  it("separates clubs that share a first word", () => {
    assert.ok(teamSimilarity("Real Madrid", "Real Sociedad") < 0.6);
    assert.ok(teamSimilarity("Manchester United", "Manchester City") < 0.6);
  });

  it("treats a partial name as partial, not certain", () => {
    const s = teamSimilarity("Bayern", "Bayern Munich");
    assert.ok(s > 0.5 && s < 1, `expected a middling score, got ${s}`);
  });

  it("refuses a women's team against the men's team of the same name", () => {
    assert.equal(teamSimilarity("Barcelona", "Barcelona W"), 0);
    assert.equal(teamSimilarity("Chelsea FC Women", "Chelsea FC"), 0);
  });

  it("refuses a youth or reserve side against the senior side", () => {
    assert.equal(teamSimilarity("Lokomotiv Moscow", "Lokomotiv Moscow (youth)"), 0);
    assert.equal(teamSimilarity("Ajax", "Ajax II"), 0);
    assert.equal(teamSimilarity("Real Madrid", "Real Madrid U19"), 0);
  });

  it("still pairs two youth sides that use different vocabularies", () => {
    // Fonbet says "(youth)", Sportradar says "U21" — same squad, and a
    // mismatch BETWEEN qualifiers is only a weak signal, not a veto.
    assert.ok(teamSimilarity("Rodina (youth)", "Rodina U21") > 0.9);
  });
});

describe("scorePair", () => {
  it("pairs the same fixture across two providers", () => {
    const scored = scorePair(ours(), theirs());
    assert.ok(scored);
    assert.equal(scored.sidesSwapped, false);
    assert.ok(scored.score > 0.95, `score was ${scored.score}`);
  });

  it("rejects a different sport outright", () => {
    assert.equal(scorePair(ours(), theirs({ srSportId: 2 })), null);
  });

  it("rejects a kickoff outside the gate however good the names", () => {
    const late = theirs({ startsAt: "2026-09-06T15:00:00.000Z" });
    assert.equal(scorePair(ours(), late), null);
  });

  it("rejects a match with no kickoff time", () => {
    assert.equal(scorePair(ours({ scheduledAt: null }), theirs()), null);
  });

  it("detects and penalises a home/away swap", () => {
    const swapped = theirs({ homeTeam: "Manchester Utd", awayTeam: "Everton FC" });
    const scored = scorePair(ours(), swapped);
    assert.ok(scored);
    assert.equal(scored.sidesSwapped, true);
    assert.ok(scored.score < 1);
  });

  it("rejects a pair where only one team agrees", () => {
    // "Manchester United" against "Newcastle United" shares a word and
    // scores exactly 0.5 — the near-miss MIN_TEAM_SCORE exists to reject.
    assert.equal(teamSimilarity("Manchester United", "Newcastle United"), 0.5);
    assert.equal(scorePair(ours(), theirs({ awayTeam: "Newcastle United" })), null);
  });
});

describe("proposeMappings", () => {
  it("auto-confirms an unambiguous, well-matched pair", () => {
    const [p] = proposeMappings([ours()], [theirs()]);
    assert.ok(p);
    assert.equal(p.srMatchId, 72221238);
    assert.equal(p.autoConfirm, true);
    assert.equal(p.evidence.srHomeTeam, "Everton FC");
  });

  it("holds back a pair whose runner-up is nearly as good", () => {
    // Two reserve fixtures kicking off together with near-identical
    // names: exactly the case where the higher score is a coin flip.
    const ourMatch = ours({ homeTeam: "Palmeiras U20", awayTeam: "Santos U20" });
    const candidates: SportradarFixture[] = [
      { srMatchId: 1, srSportId: 1, startsAt: KICKOFF, homeTeam: "Palmeiras U20", awayTeam: "Santos U20" },
      { srMatchId: 2, srSportId: 1, startsAt: KICKOFF, homeTeam: "Palmeiras U20", awayTeam: "Santos U23" },
    ];
    const [p] = proposeMappings([ourMatch], candidates);
    assert.ok(p);
    assert.equal(p.autoConfirm, false, "near-tie must go to review");
    assert.ok(p.evidence.alternatives && p.evidence.alternatives.length > 0);
  });

  it("never assigns one Sportradar fixture to two of our matches", () => {
    const a = ours({ matchId: "1", homeTeam: "Everton", awayTeam: "Manchester United" });
    const b = ours({ matchId: "2", homeTeam: "Everton", awayTeam: "Manchester United" });
    const proposals = proposeMappings([a, b], [theirs()]);
    assert.equal(proposals.length, 1);
  });

  it("produces nothing when no fixture clears the gates", () => {
    assert.deepEqual(proposeMappings([ours()], [theirs({ srSportId: 5 })]), []);
  });

  it("is deterministic across input orderings", () => {
    const matches = [
      ours({ matchId: "1", homeTeam: "Arsenal", awayTeam: "Chelsea" }),
      ours({ matchId: "2", homeTeam: "Liverpool", awayTeam: "Everton" }),
    ];
    const fixtures: SportradarFixture[] = [
      { srMatchId: 10, srSportId: 1, startsAt: KICKOFF, homeTeam: "Arsenal FC", awayTeam: "Chelsea FC" },
      { srMatchId: 11, srSportId: 1, startsAt: KICKOFF, homeTeam: "Liverpool FC", awayTeam: "Everton FC" },
    ];
    const forward = proposeMappings(matches, fixtures);
    const reversed = proposeMappings([...matches].reverse(), [...fixtures].reverse());
    const key = (ps: ReturnType<typeof proposeMappings>) =>
      ps.map((p) => `${p.matchId}:${p.srMatchId}`).sort().join(",");
    assert.equal(key(forward), key(reversed));
    assert.equal(key(forward), "1:10,2:11");
  });
});
