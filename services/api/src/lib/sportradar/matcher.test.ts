// Unit tests for the Sportradar fixture matcher.
//
// Run with: tsx --test src/lib/sportradar/matcher.test.ts

import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import type { SportradarFixture } from "@oddzilla/types/sportradar";
import {
  MIN_TEAM_SCORE,
  normaliseTeamName,
  proposeMappings,
  qualifiersFromCompetition,
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

  it("matches an initial against the full first name", () => {
    // Individual sports: Fonbet writes "Hoshko N", Sportradar writes
    // "Hoshko, Nazar". Without this every tennis / table-tennis / darts
    // fixture scores 0.5 and falls under the floor.
    assert.equal(teamSimilarity("Hoshko N", "Hoshko, Nazar"), 1);
    assert.equal(teamSimilarity("Orlowski P", "Orlowski, Petr"), 1);
    // Doubles pairs too.
    assert.equal(
      teamSimilarity("Krawietz K / Puetz T", "Krawietz, Kevin / Puetz, Tim"),
      1,
    );
  });

  it("drops the hockey / handball club designator like the football ones", () => {
    // "HC Dynamo" against "Dynamo Moscow" is two-vs-two sharing one word
    // with the designator kept (0.5, under the floor) and a real partial
    // without it. Measured on the KHL day 2026-09-05.
    assert.ok(teamSimilarity("Dynamo Moscow", "HC Dynamo") >= 0.6);
    assert.equal(teamSimilarity("HC Leipzig (w)", "Leipzig W"), 1);
  });

  it("does not let an initial match an unrelated surname", () => {
    assert.ok(teamSimilarity("Hoshko N", "Dedek, Jiri") < 0.6);
  });

  it("reads B, C and W as initials in an individual sport, not as squad markers", () => {
    // Production 2026-09-05: "Samrej K vs Tseng C H" sat unmapped beside
    // "Samrej, Kasidit vs Tseng, Chun Hsin" because the C was taken for a
    // reserve-squad marker and vetoed the pair. Same for every player
    // whose initial is B (reserves) or W (women's side).
    const individual = { individual: true };
    assert.equal(teamSimilarity("Tseng C H", "Tseng, Chun Hsin", individual), 1);
    assert.equal(teamSimilarity("Wang W", "Wang, Wei", individual), 1);
    assert.equal(teamSimilarity("Stevens B", "Stevens, Bernard", individual), 1);
    // Doubles, where Sportradar itself writes initials.
    assert.equal(
      teamSimilarity("Harrison C / Skupski N", "Harrison C / Skupski N", individual),
      1,
    );
    // Club semantics stay the default: the same letters on a club name
    // are still the qualifiers the veto exists for.
    assert.equal(teamSimilarity("Tseng C H", "Tseng, Chun Hsin"), 0);
    assert.equal(teamSimilarity("Atletico Madrid C", "Atletico Madrid", individual), 0.8);
    assert.equal(teamSimilarity("Atletico Madrid C", "Atletico Madrid"), 0);
  });

  it("still pairs two youth sides that use different vocabularies", () => {
    // Fonbet says "(youth)", Sportradar says "U21" — same squad, and a
    // mismatch BETWEEN qualifiers is only a weak signal, not a veto.
    assert.ok(teamSimilarity("Rodina (youth)", "Rodina U21") > 0.9);
  });
});

describe("qualifiersFromCompetition", () => {
  it("reads the women's and age markers Sportradar puts on the competition", () => {
    // Every form seen on the live feed 2026-09-05.
    assert.deepEqual(qualifiersFromCompetition("Super League, Women"), { women: true, ageGroup: null });
    assert.deepEqual(qualifiersFromCompetition("National Women's Soccer League"), { women: true, ageGroup: null });
    assert.deepEqual(qualifiersFromCompetition("Primera Division Femenina"), { women: true, ageGroup: null });
    assert.deepEqual(qualifiersFromCompetition("Première Ligue Féminine"), { women: true, ageGroup: null });
    assert.deepEqual(qualifiersFromCompetition("U20 FIFA World Cup, Women, Group A"), { women: true, ageGroup: "u20" });
    assert.deepEqual(qualifiersFromCompetition("Primavera 1"), { women: false, ageGroup: "youth" });
  });

  it("does not mistake a division letter for a reserve squad", () => {
    // "Serie B", "Group B", "Pool B" are divisions; both providers name
    // a reserve side on the TEAM ("Porto B"), so nothing is read here.
    for (const name of ["Serie B", "Brasileiro Serie C, Group B", "Premiership Rugby Cup, Pool B", "Premier League", undefined]) {
      assert.deepEqual(qualifiersFromCompetition(name), { women: false, ageGroup: null }, name);
    }
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

  it("lets the sport id decide whether a single letter is an initial", () => {
    // The real pair from production, verbatim. Tennis is SR sport 5.
    const tennis = scorePair(
      ours({ srSportId: 5, scheduledAt: "2026-09-05T05:30:00Z", homeTeam: "Samrej K", awayTeam: "Tseng C H" }),
      theirs({ srSportId: 5, startsAt: "2026-09-05T05:20:00.000Z", homeTeam: "Samrej, Kasidit", awayTeam: "Tseng, Chun Hsin" }),
    );
    assert.ok(tennis, "the tennis pair must clear the gates");
    assert.equal(tennis.homeScore, 1);
    assert.equal(tennis.awayScore, 1);
    // The same shape in a club sport keeps the veto: a "C" side against
    // the first team is a different team.
    const football = scorePair(
      ours({ homeTeam: "Atletico Madrid C", awayTeam: "Real Avila" }),
      theirs({ homeTeam: "Atletico Madrid", awayTeam: "Real Avila" }),
    );
    assert.equal(football, null);
  });

  it("reads a women's or youth competition onto Sportradar's bare team names", () => {
    // Production 2026-09-05: Fonbet "Chelsea (w) vs Aston Villa (w)" sat
    // unpaired beside Sportradar's "Chelsea vs Aston Villa", whose only
    // marker was the tournament "Super League, Women". Team-to-team that
    // is marker-vs-none, the veto the file header describes.
    const women = scorePair(
      ours({ homeTeam: "Chelsea (w)", awayTeam: "Aston Villa (w)" }),
      theirs({ homeTeam: "Chelsea", awayTeam: "Aston Villa", tournament: "Super League, Women" }),
    );
    assert.ok(women, "the women's pair must clear the gates");
    assert.equal(women.homeScore, 1);
    // The same bare names in the men's competition stay vetoed against
    // our women's fixture, and Sportradar's women's fixture stays vetoed
    // against our men's one — the marker is compared, not dropped.
    assert.equal(
      scorePair(
        ours({ homeTeam: "Chelsea (w)", awayTeam: "Aston Villa (w)" }),
        theirs({ homeTeam: "Chelsea", awayTeam: "Aston Villa", tournament: "Premier League" }),
      ),
      null,
    );
    assert.equal(
      scorePair(
        ours({ homeTeam: "Chelsea", awayTeam: "Aston Villa" }),
        theirs({ homeTeam: "Chelsea", awayTeam: "Aston Villa", tournament: "Super League, Women" }),
      ),
      null,
    );
    // Youth stated on the competition meets youth stated on the team,
    // whichever vocabulary each side uses.
    const youth = scorePair(
      ours({ homeTeam: "Poland U20 (w)", awayTeam: "Argentina U20 (w)" }),
      theirs({ homeTeam: "Poland", awayTeam: "Argentina", tournament: "U20 FIFA World Cup, Women, Group A" }),
    );
    assert.ok(youth);
    assert.equal(youth.homeScore, 1);
    // People are left alone: a tennis draw's "Women" is not a marker on
    // the player, and a bare "w" would read as an initial.
    const tennis = scorePair(
      ours({ srSportId: 5, homeTeam: "Bucsa C", awayTeam: "Gauff C" }),
      theirs({ srSportId: 5, homeTeam: "Bucsa, Cristina", awayTeam: "Gauff, Coco", tournament: "WTA Guadalajara, Women, Singles" }),
    );
    assert.ok(tennis);
    assert.equal(tennis.homeScore, 1);
  });

  it("never confirms a pair where only one team agrees", () => {
    // "Manchester United" against "Newcastle United" shares a word and
    // scores exactly 0.5 — the near-miss MIN_TEAM_SCORE exists to reject.
    assert.equal(teamSimilarity("Manchester United", "Newcastle United"), 0.5);
    // With the clocks agreeing it is a WEAK pair: proposed for review
    // (the other side, Everton, is certain), never as a confirmation.
    const scored = scorePair(ours(), theirs({ awayTeam: "Newcastle United" }));
    assert.ok(scored);
    assert.equal(scored.weak, true);
    const [p] = proposeMappings([ours()], [theirs({ awayTeam: "Newcastle United" })]);
    assert.equal(p?.autoConfirm, false);
    // Twelve minutes apart there is no anchor left and it is nothing.
    assert.equal(
      scorePair(
        ours(),
        theirs({ awayTeam: "Newcastle United", startsAt: "2026-09-06T13:12:00.000Z" }),
      ),
      null,
    );
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

describe("alternate name forms", () => {
  // Real pair from sport_matches/1/2026-09-06: an Eredivisie fixture that
  // was live with no tracker because Sportradar's short name for FC
  // Twente is its city and the matcher only ever saw that one.
  const kickoff = "2026-09-06T10:15:00.000Z";
  const groningenTwente = ours({
    homeTeam: "Groningen",
    awayTeam: "Twente",
    scheduledAt: kickoff,
  });
  const srFixture: SportradarFixture = {
    srMatchId: 72041114,
    srSportId: 1,
    startsAt: kickoff,
    homeTeam: "Groningen",
    homeTeamAlt: "FC Groningen",
    awayTeam: "Enschede",
    awayTeamAlt: "FC Twente Enschede",
    tournament: "Eredivisie",
  };

  it("scores against the longer form when the short one is a city", () => {
    const scored = scorePair(groningenTwente, srFixture);
    assert.ok(scored, "must at least reach the review queue");
    assert.equal(scored.homeScore, 1);
    assert.ok(scored.awayScore >= MIN_TEAM_SCORE, `away scored ${scored.awayScore}`);
    assert.equal(scored.weak, false, "both sides agree, so this is an ordinary pair");
    // And the reviewer (or the model) is shown both forms.
    const [p] = proposeMappings([groningenTwente], [srFixture]);
    assert.equal(p?.evidence.srAwayTeam, "Enschede");
    assert.equal(p?.evidence.srAwayTeamAlt, "FC Twente Enschede");
  });

  it("falls back to a weak pair without the longer form", () => {
    // "Twente" against "Enschede" alone is 0 — the shape that used to be
    // invisible. It now rides the weak path instead.
    const { awayTeamAlt: _dropped, ...shortOnly } = srFixture;
    const scored = scorePair(groningenTwente, shortOnly);
    assert.ok(scored);
    assert.equal(scored.weak, true);
    assert.equal(scored.awayScore, 0);
  });

  it("vetoes the side when EITHER form carries a squad qualifier", () => {
    // The forms name the same squad, so a marker on one is real.
    const womens = theirs({ homeTeam: "Everton", homeTeamAlt: "Everton FC Women" });
    assert.equal(scorePair(ours(), womens), null);
  });
});

describe("weak pairs", () => {
  // Measured pair: Fonbet's "Henan Songshan Longmen" against Sportradar's
  // "Henan" is 2 tokens of 4 (0.5), under the floor, while the away side
  // and the kickoff agree exactly.
  const henan = ours({ homeTeam: "Henan Songshan Longmen", awayTeam: "Chengdu Rongcheng" });
  const srHenan = theirs({ homeTeam: "Henan", awayTeam: "Chengdu Rongcheng" });

  it("proposes a one-sided pair for review, never for auto-confirmation", () => {
    const scored = scorePair(henan, srHenan);
    assert.ok(scored);
    assert.equal(scored.weak, true);
    assert.ok(scored.homeScore < MIN_TEAM_SCORE);
    assert.equal(scored.awayScore, 1);
    const [p] = proposeMappings([henan], [srHenan]);
    assert.ok(p);
    assert.equal(p.autoConfirm, false);
    assert.equal(p.evidence.weak, true);
  });

  it("needs one side to be certain, not merely plausible", () => {
    // "Independiente" against "Independiente Medellin" is 0.67 — a real
    // partial, but not an anchor for a pair whose other side is nothing.
    const scored = scorePair(
      ours({ homeTeam: "Independiente", awayTeam: "Racing Club" }),
      theirs({ homeTeam: "Independiente Medellin", awayTeam: "Junior" }),
    );
    assert.equal(scored, null);
  });

  it("needs the clocks to agree within the auto window", () => {
    const late = theirs({
      homeTeam: "Henan",
      awayTeam: "Chengdu Rongcheng",
      startsAt: "2026-09-06T13:12:00.000Z",
    });
    assert.equal(scorePair(henan, late), null);
    // Whereas a two-sided pair still clears the wider gate at 12 minutes.
    assert.ok(scorePair(ours(), theirs({ startsAt: "2026-09-06T13:12:00.000Z" })));
  });

  it("never crosses a home/away swap", () => {
    // Measured junk: Fonbet's season head-to-head "Barcelona vs Real
    // Madrid" borrowing the kickoff of Valencia vs Barcelona.
    const scored = scorePair(
      ours({ homeTeam: "Barcelona", awayTeam: "Real Madrid" }),
      theirs({ homeTeam: "Valencia", awayTeam: "Barcelona" }),
    );
    assert.equal(scored, null);
  });

  it("still honours the squad veto", () => {
    // Chelsea's men against Chelsea's women is a vetoed side, not a side
    // that scored nothing; the exact kickoff does not rescue it.
    const scored = scorePair(
      ours({ homeTeam: "Chelsea", awayTeam: "Arsenal" }),
      theirs({ homeTeam: "Chelsea", awayTeam: "Aston Villa", tournament: "Super League, Women" }),
    );
    assert.equal(scored, null);
  });

  it("yields a fixture to a strong pair whatever the two scored", () => {
    // The strong pair's clocks are 19 minutes apart and its names are
    // partials, so it scores UNDER the weak pair, which has a perfect
    // anchor and an exact kickoff. The fixture must still go to the
    // strong pair.
    const fixture = theirs({
      srMatchId: 77,
      homeTeam: "Bayern Munich",
      awayTeam: "Borussia Dortmund",
    });
    const strong = ours({
      matchId: "strong",
      homeTeam: "Bayern",
      awayTeam: "Dortmund",
      scheduledAt: "2026-09-06T13:19:00.000Z",
    });
    const weak = ours({ matchId: "weak", homeTeam: "Bayern Munich", awayTeam: "Hoffenheim" });
    const strongScore = scorePair(strong, fixture);
    const weakScore = scorePair(weak, fixture);
    assert.ok(strongScore && !strongScore.weak);
    assert.ok(weakScore && weakScore.weak);
    assert.ok(weakScore.score > strongScore.score, "the test needs the weak pair to out-score");
    const proposals = proposeMappings([weak, strong], [fixture]);
    assert.deepEqual(
      proposals.map((p) => p.matchId),
      ["strong"],
    );
  });

  it("does not re-propose the fixture the adjudicator turned down", () => {
    const rejected = ours({ rejectedSrMatchId: theirs().srMatchId });
    assert.equal(scorePair(rejected, theirs()), null);
    // Any OTHER fixture is still fair game for the same match.
    assert.ok(scorePair(rejected, theirs({ srMatchId: theirs().srMatchId + 1 })));
  });
});
