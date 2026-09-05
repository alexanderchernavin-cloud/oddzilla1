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
import { parseCanonicalNames, renderBatch } from "./resolver.js";

function cand(over: Partial<WikidataCandidate> = {}): WikidataCandidate {
  return {
    qid: "Q1",
    label: "Premier League",
    description: "English men's association football league",
    logoFile: "Pl-logo-light.svg",
    sportQids: ["Q2736"],
    ...over,
  };
}

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

  it("does not gate on sport for a sport we have no QID for", () => {
    assert.deepEqual(sportQids("geoguessr"), []);
    const m = pickCandidate([cand({ label: "Some Series", sportQids: ["Q999"] })], {
      canonicalName: "Some Series",
      sportSlug: "geoguessr",
    });
    assert.ok(m);
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

describe("renderBatch", () => {
  it("carries sport and category so the model can disambiguate", () => {
    const text = renderBatch([
      { tournamentId: 1, name: "Spain. Primera Division", categoryName: "Spain", sportSlug: "football" },
    ]);
    assert.match(text, /^0\. sport=football category=Spain$/mu);
    assert.match(text, /name: Spain\. Primera Division/u);
  });
});
