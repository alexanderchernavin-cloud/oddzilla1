// Unit tests for the tournament-logo guards.
//
// pickCandidate is the only thing standing between a Wikidata search
// result and a crest on the storefront, and every case below is a real
// failure observed while probing production names — not an invented one.
//
// Run with: tsx --test src/lib/tournament-logos/wikidata.test.ts

import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import {
  commonsFileUrl,
  normaliseLabel,
  pickCandidate,
  sportQids,
  type WikidataCandidate,
} from "./wikidata.js";
import { parseCanonicalNames, parsePairVerdicts, renderBatch, renderPair } from "./resolver.js";

function cand(over: Partial<WikidataCandidate> = {}): WikidataCandidate {
  return {
    qid: "Q1",
    label: "Premier League",
    description: "English men's association football league",
    logoFile: "Pl-logo-light.svg",
    sportQids: ["Q2736"],
    instanceOf: ["Q623109"], // sports league
    ...over,
  };
}

describe("domain guard (the two production mis-matches)", () => {
  it("REFUSES a scripting language for an esports tournament", () => {
    // Shipped and reverted: "TCL 2026 Spring" matched Q5288, Tcl the
    // scripting language. Exact label, real logo, no sport claim, and
    // nothing else objected. Claims below are the ones Wikidata
    // actually returns for Q5288.
    const tcl = cand({
      qid: "Q5288",
      label: "Tcl",
      logoFile: "Tcl.svg",
      sportQids: [],
      instanceOf: ["Q187432", "Q28922885", "Q899523", "Q12772052", "Q1993334"],
    });
    assert.equal(pickCandidate([tcl], { canonicalName: "Tcl", sportSlug: "lol" }), null);
  });

  it("REFUSES a snooker event for a League of Legends tournament", () => {
    // Shipped and reverted: "EMEA Masters" resolved through its alias to
    // Q22336953, the European Masters SNOOKER tournament (P641 = Q11015).
    // The sport gate never fired because SPORT_QIDS had no esports entry.
    const snooker = cand({
      qid: "Q22336953",
      label: "European Masters",
      logoFile: "European Masters.png",
      sportQids: ["Q11015"], // snooker
      instanceOf: ["Q18608583"], // recurring sporting event
    });
    assert.equal(
      pickCandidate([snooker], { canonicalName: "European Masters", sportSlug: "lol" }),
      null,
    );
  });

  it("still accepts the real esports competitions it found", () => {
    // Every one of these is a genuine match from the same sweep, with
    // the claims Wikidata returns. They must survive the new guard.
    const real: Array<[string, Partial<WikidataCandidate>]> = [
      ["League of Legends Champions Korea", { sportQids: ["Q300920", "Q223341"], instanceOf: ["Q623109", "Q48004378"] }],
      ["League of Legends Championship Pacific", { sportQids: ["Q223341"], instanceOf: ["Q63349452"] }],
      ["League Championship Series", { sportQids: ["Q300920"], instanceOf: ["Q623109"] }],
      ["Intel Extreme Masters", { sportQids: ["Q300920"], instanceOf: ["Q133250"] }],
      ["Call of Duty League", { sportQids: [], instanceOf: ["Q63349452"] }],
      ["Esports World Cup", { sportQids: ["Q300920"], instanceOf: ["Q18608583", "Q48004378"] }],
    ];
    for (const [name, over] of real) {
      const m = pickCandidate([cand({ label: name, logoFile: "x.svg", ...over })], {
        canonicalName: name,
        sportSlug: "lol",
      });
      assert.ok(m, `${name} should still resolve`);
    }
  });

  it("REFUSES a non-competition even for a traditional sport", () => {
    const notAComp = cand({
      label: "Serie A",
      sportQids: [],
      instanceOf: ["Q7725634"], // literary work
    });
    assert.equal(
      pickCandidate([notAComp], { canonicalName: "Serie A", sportSlug: "football" }),
      null,
    );
  });
});

describe("normaliseLabel", () => {
  it("ignores case, accents and punctuation", () => {
    assert.equal(normaliseLabel("Campeonato Brasileiro Série A"), "campeonato brasileiro serie a");
    assert.equal(normaliseLabel("La-Liga!"), "la liga");
    assert.equal(normaliseLabel("  Serie  A  "), "serie a");
  });

  it("keeps distinct competitions distinct", () => {
    assert.notEqual(normaliseLabel("EuroLeague Women"), normaliseLabel("EuroLeague"));
    assert.notEqual(normaliseLabel("Naisten Liiga"), normaliseLabel("Liiga"));
  });
});

describe("pickCandidate", () => {
  it("accepts an exact label match in the right sport", () => {
    const m = pickCandidate([cand()], { canonicalName: "Premier League", sportSlug: "football" });
    assert.ok(m);
    assert.equal(m.qid, "Q1");
    assert.equal(m.logoFile, "Pl-logo-light.svg");
  });

  it("REFUSES the women's competition when the men's was asked for", () => {
    // Observed for real: the men's EuroLeague entity carries no logo, so
    // a sport-only filter falls through to EuroLeague Women, which does.
    const m = pickCandidate(
      [
        cand({ qid: "Q185982", label: "EuroLeague", logoFile: null, sportQids: ["Q5372"] }),
        cand({
          qid: "Q521068",
          label: "EuroLeague Women",
          logoFile: "EuroLeagueWomen.png",
          sportQids: ["Q5372"],
        }),
      ],
      { canonicalName: "EuroLeague", sportSlug: "basketball" },
    );
    assert.equal(m, null);
  });

  it("REFUSES a same-name competition in another sport", () => {
    // "Eredivisie" top-hits the Dutch ice hockey league.
    const m = pickCandidate(
      [cand({ qid: "Q2164956", label: "Eredivisie", logoFile: "x.svg", sportQids: ["Q41466"] })],
      { canonicalName: "Eredivisie", sportSlug: "football" },
    );
    assert.equal(m, null);
  });

  it("takes the right entity when both are present", () => {
    const m = pickCandidate(
      [
        cand({ qid: "Q2164956", label: "Eredivisie", logoFile: "hockey.svg", sportQids: ["Q41466"] }),
        cand({ qid: "Q167541", label: "Eredivisie", logoFile: "football.svg", sportQids: ["Q2736"] }),
      ],
      { canonicalName: "Eredivisie", sportSlug: "football" },
    );
    assert.equal(m?.qid, "Q167541");
  });

  it("tolerates an entity with no sport claim", () => {
    // Plenty of competition items simply omit P641; refusing those would
    // throw away most of the usable coverage.
    const m = pickCandidate([cand({ sportQids: [] })], {
      canonicalName: "Premier League",
      sportSlug: "football",
    });
    assert.ok(m);
  });

  it("skips candidates with no logo", () => {
    const m = pickCandidate([cand({ logoFile: null })], {
      canonicalName: "Premier League",
      sportSlug: "football",
    });
    assert.equal(m, null);
  });

  it("is empty-safe", () => {
    assert.equal(pickCandidate([], { canonicalName: "x", sportSlug: "football" }), null);
    assert.equal(pickCandidate([cand()], { canonicalName: "", sportSlug: "football" }), null);
  });

  it("still requires esports evidence for an esports slug with no QID list", () => {
    // This test previously asserted the OPPOSITE — that an unknown sport
    // waved the gate through. That permissiveness is what let a snooker
    // event onto a League of Legends tournament, so it is inverted now:
    // an esports slug needs an esports competition type or an esports
    // sport claim, and an unrelated sport is not it.
    assert.deepEqual(sportQids("geoguessr"), []);
    const unrelated = cand({
      label: "Some Series",
      sportQids: ["Q999"],
      instanceOf: ["Q18608583"],
    });
    assert.equal(
      pickCandidate([unrelated], { canonicalName: "Some Series", sportSlug: "geoguessr" }),
      null,
    );
    // With real esports evidence it resolves.
    const esports = cand({ label: "Some Series", sportQids: [], instanceOf: ["Q63349452"] });
    assert.ok(
      pickCandidate([esports], { canonicalName: "Some Series", sportSlug: "geoguessr" }),
    );
  });
});

describe("commonsFileUrl", () => {
  it("encodes spaces and punctuation", () => {
    assert.equal(
      commonsFileUrl("Serie A.svg"),
      "https://commons.wikimedia.org/wiki/Special:FilePath/Serie%20A.svg",
    );
  });
});

describe("parseCanonicalNames", () => {
  it("reads names and explicit nulls", () => {
    const out = parseCanonicalNames('[{"i":0,"name":"La Liga"},{"i":1,"name":null}]', 2);
    assert.equal(out.get(0)?.name, "La Liga");
    assert.equal(out.get(1)?.name, null);
    assert.equal(out.size, 2);
  });

  it("keeps up to two usable aliases and drops the rest", () => {
    const out = parseCanonicalNames(
      '[{"i":0,"name":"LCK","aliases":["League of Legends Champions Korea","LCK","","a","LoL Champions Korea","Korea League"]}]',
      1,
    );
    // The duplicate of the canonical name and the single-character entry
    // go; the cap keeps the per-row request count bounded, because every
    // alias costs another rate-limited page lookup.
    assert.deepEqual(out.get(0)?.aliases, [
      "League of Legends Champions Korea",
      "LoL Champions Korea",
    ]);
  });

  it("tolerates a missing or malformed alias list", () => {
    assert.deepEqual(parseCanonicalNames('[{"i":0,"name":"LEC"}]', 1).get(0)?.aliases, []);
    assert.deepEqual(
      parseCanonicalNames('[{"i":0,"name":"LEC","aliases":"nope"}]', 1).get(0)?.aliases,
      [],
    );
  });

  it("distinguishes a declined row from an absent one", () => {
    // null means "no logo exists"; absent means the model said nothing
    // and the row must be left completely alone.
    const out = parseCanonicalNames('[{"i":1,"name":null}]', 3);
    assert.equal(out.has(0), false);
    assert.equal(out.get(1)?.name, null);
  });

  it("drops junk without taking anything else down", () => {
    const out = parseCanonicalNames(
      '[{"i":0,"name":"Serie A"},{"i":1,"name":123},{"i":9,"name":"x"},{"i":2,"name":"   "}]',
      3,
    );
    assert.equal(out.size, 1);
    assert.equal(out.get(0)?.name, "Serie A");
  });

  it("decides nothing on an unreadable reply", () => {
    assert.equal(parseCanonicalNames("", 2).size, 0);
    assert.equal(parseCanonicalNames("sorry, no", 2).size, 0);
    assert.equal(parseCanonicalNames("[{broken", 2).size, 0);
  });
});

describe("parsePairVerdicts", () => {
  it("reads the three verdicts", () => {
    const out = parsePairVerdicts(
      '[{"i":0,"verdict":"same"},{"i":1,"verdict":"different"},{"i":2,"verdict":"unsure"}]',
      3,
    );
    assert.equal(out.get(0), "same");
    assert.equal(out.get(1), "different");
    assert.equal(out.get(2), "unsure");
  });

  it("yields nothing on an unreadable reply, which the caller treats as unsure", () => {
    // The caller defaults a missing entry to "unsure" and writes
    // nothing, so an unparseable adjudication can never approve a logo.
    assert.equal(parsePairVerdicts("", 1).size, 0);
    assert.equal(parsePairVerdicts("I think so?", 1).size, 0);
    assert.equal(parsePairVerdicts('[{"i":0,"verdict":"yes"}]', 1).size, 0);
    assert.equal(parsePairVerdicts('[{"i":5,"verdict":"same"}]', 1).size, 0);
  });
});

describe("renderPair", () => {
  it("shows the feed name against the entry, with sport and category", () => {
    const text = renderPair(
      { name: "TCL 2026 Spring", sportSlug: "lol", categoryName: "Auto-mapped" },
      "Tcl",
      "scripting language",
    );
    assert.match(text, /sport=lol category=Auto-mapped/u);
    assert.match(text, /feed: {2}TCL 2026 Spring/u);
    assert.match(text, /entry: Tcl — scripting language/u);
  });

  it("omits the dash when the entry has no description", () => {
    const text = renderPair(
      { name: "X", sportSlug: "cs2", categoryName: "c" },
      "Some Series",
      "",
    );
    assert.match(text, /entry: Some Series$/mu);
  });
});

describe("renderBatch", () => {
  it("carries sport and category so the model can disambiguate", () => {
    const text = renderBatch([
      { tournamentId: 1, name: "Spain. Primera Division", categoryName: "Spain", sportSlug: "football" },
    ]);
    assert.match(text, /^0\. sport=football category=Spain$/mu);
    assert.match(text, /name: Spain\. Primera Division/u);
  });
});
