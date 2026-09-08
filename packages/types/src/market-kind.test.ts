import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CUSTOM_PMID,
  FONBET_DOUBLE_CHANCE_PMID_BASE,
  FONBET_PMID_BASE,
  formatMarketKind,
  marketKindOf,
  parseMarketKind,
  marketKindPartsOf,
  PROVIDER_MARKET_TYPE_ID_BASE,
  variantKindChain,
} from "./market-kind.js";

test("Oddin: the id IS the type", () => {
  assert.equal(marketKindOf(1), "od:1");
  assert.equal(marketKindOf(4), "od:4");
  assert.equal(marketKindOf(2), "od:2");
  // Oddin's own `variant` (way:two, mr:12) is part of a market's identity,
  // not a sub-event, so od:1 is the match winner whichever one it carries.
  assert.equal(marketKindOf(1, "way:two"), "od:1");
});

test("Fonbet: the id is the TABLE, the sub-event comes off the variant", () => {
  // The three markets whose collision started all of this: same table 120.
  assert.equal(marketKindOf(FONBET_PMID_BASE + 120), "fb:120");
  assert.equal(marketKindOf(FONBET_PMID_BASE + 120, "fb:100201"), "fb:120@100201");
  assert.equal(marketKindOf(FONBET_PMID_BASE + 120, "fb:400100"), "fb:120@400100");
  // ...and they are now three distinct keys.
  const kinds = new Set([
    marketKindOf(FONBET_PMID_BASE + 120),
    marketKindOf(FONBET_PMID_BASE + 120, "fb:100201"),
    marketKindOf(FONBET_PMID_BASE + 120, "fb:100202"),
    marketKindOf(FONBET_PMID_BASE + 120, "fb:400100"),
  ]);
  assert.equal(kinds.size, 4);
});

test("nested sub-events keep their whole chain", () => {
  assert.equal(
    marketKindOf(FONBET_PMID_BASE + 120, "fb:400100/10100201"),
    "fb:120@400100/10100201",
  );
});

test("a per-player variant's id is a PARAMETER, not part of the type", () => {
  // 1 202 of the 1 264 distinct variants carry one. Folding it in would
  // give every player their own market type.
  assert.equal(marketKindOf(FONBET_PMID_BASE + 700, "fb:100201:12345"), "fb:700@100201");
  assert.equal(
    marketKindOf(FONBET_PMID_BASE + 700, "fb:100201:12345"),
    marketKindOf(FONBET_PMID_BASE + 700, "fb:100201:99999"),
  );
  assert.equal(variantKindChain("fb:100201:12345"), "100201");
  assert.equal(variantKindChain("fb:400100/10100201"), "400100/10100201");
  assert.equal(variantKindChain(""), "");
  assert.equal(variantKindChain(null), "");
});

test("the double-chance split is a type, marked not renumbered", () => {
  assert.equal(marketKindOf(FONBET_DOUBLE_CHANCE_PMID_BASE + 120), "fb:120#dc");
  assert.equal(
    marketKindOf(FONBET_DOUBLE_CHANCE_PMID_BASE + 120, "fb:100201"),
    "fb:120@100201#dc",
  );
  // Distinct from the plain table it was split off.
  assert.notEqual(
    marketKindOf(FONBET_DOUBLE_CHANCE_PMID_BASE + 120),
    marketKindOf(FONBET_PMID_BASE + 120),
  );
});

test("custom markets share one kind, as they share one id", () => {
  assert.equal(marketKindOf(CUSTOM_PMID), "cu");
  assert.equal(marketKindOf(CUSTOM_PMID, "fb:100201"), "cu");
});

test("round-trips through parse", () => {
  for (const kind of [
    "od:1",
    "od:4",
    "fb:120",
    "fb:120@100201",
    "fb:120@400100/10100201",
    "fb:120#dc",
    "fb:120@100201#dc",
    "cu",
  ]) {
    const parts = parseMarketKind(kind);
    assert.notEqual(parts, null, kind);
    assert.equal(formatMarketKind(parts!), kind);
  }
});

test("rejects malformed kinds rather than guessing", () => {
  for (const bad of ["", "xx:1", "fb:", "fb:abc", "od:1@100201", "od:1#dc", "fb:120@"]) {
    assert.equal(parseMarketKind(bad), null, bad);
  }
});

test("a registry-allocated id is opaque and says so", () => {
  // Our own ids (migration 20260908T115542) carry no table number, so
  // decoding must refuse rather than compute 3000005 - 1000000 = 2000005
  // and hand back a market type that does not exist.
  assert.equal(marketKindOf(PROVIDER_MARKET_TYPE_ID_BASE), null);
  assert.equal(marketKindOf(PROVIDER_MARKET_TYPE_ID_BASE + 1059, "fb:100201"), null);
  assert.equal(marketKindPartsOf(PROVIDER_MARKET_TYPE_ID_BASE + 5), null);
  // The legacy bands still decode, so historical rows keep working.
  assert.equal(marketKindOf(FONBET_PMID_BASE + 120), "fb:120");
});
