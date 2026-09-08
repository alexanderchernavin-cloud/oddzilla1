import { test } from "node:test";
import assert from "node:assert/strict";

import {
  BET_ASSIST_MARKETS_BY_SPORT,
  BET_ASSIST_SPORT_IDS,
  betAssistCoversSport,
  betAssistMappedPairs,
  resolveBetAssistMarket,
} from "./bet-assist.js";
import { parseMarketKind } from "./market-kind.js";

// The failure this pins: Bet Assist answers a market key it does not know
// for the sport with an EMPTY panel, not an error. So a typo in the map
// ships as a button that opens onto nothing, and nothing in the runtime
// would say so.
test("every mapped market exists in that sport's Bet Assist vocabulary", () => {
  for (const { srSportId, key, market } of betAssistMappedPairs()) {
    const vocabulary = BET_ASSIST_MARKETS_BY_SPORT[srSportId];
    assert.ok(vocabulary, `sport ${srSportId} has no market list`);
    assert.ok(
      vocabulary.includes(market),
      `${key} -> ${market} is not a Bet Assist market for sport ${srSportId}`,
    );
  }
});

test("mapped sports and the vocabulary table agree with the sport list", () => {
  for (const sportId of BET_ASSIST_SPORT_IDS) {
    assert.ok(
      BET_ASSIST_MARKETS_BY_SPORT[sportId],
      `sport ${sportId} claims coverage but has no market list`,
    );
  }
  for (const key of Object.keys(BET_ASSIST_MARKETS_BY_SPORT)) {
    assert.ok(
      BET_ASSIST_SPORT_IDS.includes(Number(key)),
      `sport ${key} has a market list but is not in the coverage list`,
    );
  }
});

test("whole-match and sub-event markets resolve per sport", () => {
  // Fonbet 1000305 is "Total" everywhere; Sportradar names it per sport.
  assert.equal(
    resolveBetAssistMarket({ srSportId: 1, providerMarketId: 1000305 }),
    "totalOverUnder",
  );
  assert.equal(
    resolveBetAssistMarket({ srSportId: 2, providerMarketId: 1000305 }),
    "totalPoints",
  );
  assert.equal(
    resolveBetAssistMarket({ srSportId: 3, providerMarketId: 1000305 }),
    "totalRuns",
  );
  assert.equal(
    resolveBetAssistMarket({ srSportId: 5, providerMarketId: 1000305 }),
    "totalGames",
  );
  // The sub-event variant selects a different key on the same market id.
  assert.equal(
    resolveBetAssistMarket({
      srSportId: 1,
      providerMarketId: 1000120,
      variant: "fb:100201",
    }),
    "1stHalfWin",
  );
  assert.equal(
    resolveBetAssistMarket({
      srSportId: 4,
      providerMarketId: 1000120,
      variant: "fb:100102",
    }),
    "moneyline2ndPeriod",
  );
});

test("an unmapped market or uncovered sport resolves to null", () => {
  // Bet Assist has no soccer handicap, and Fonbet's 1000304 is exactly
  // that — the control must not render on it.
  assert.equal(
    resolveBetAssistMarket({ srSportId: 1, providerMarketId: 1000304 }),
    null,
  );
  // A variant we do not map (corners match result) falls through rather
  // than borrowing the whole-match key.
  assert.equal(
    resolveBetAssistMarket({
      srSportId: 1,
      providerMarketId: 1000120,
      variant: "fb:400100",
    }),
    null,
  );
  // Sports Bet Assist does not cover at all — table tennis, darts, and
  // every esport.
  assert.equal(betAssistCoversSport(20), false);
  assert.equal(betAssistCoversSport(137), false);
  assert.equal(
    resolveBetAssistMarket({ srSportId: 20, providerMarketId: 1000120 }),
    null,
  );
});

test("an empty variant means the whole match", () => {
  assert.equal(
    resolveBetAssistMarket({
      srSportId: 6,
      providerMarketId: 1000120,
      variant: "",
    }),
    "3Way",
  );
  assert.equal(
    resolveBetAssistMarket({
      srSportId: 6,
      providerMarketId: 1000120,
      variant: null,
    }),
    "3Way",
  );
});

test("every mapped key is a well-formed market kind", () => {
  // The map was 119 hand-written `<pmid>@<variant>` literals before the
  // market-kind migration; they were rewritten programmatically for
  // exactly that reason. This is the guard that a future hand-edit cannot
  // introduce a key nothing will ever match — an unparseable key is
  // silently dead, since a miss just renders no Bet Assist button.
  for (const { srSportId, key } of betAssistMappedPairs()) {
    assert.notEqual(parseMarketKind(key), null, `sport ${srSportId} key ${key}`);
  }
});

test("resolves a Fonbet sub-event to its own Sportradar market", () => {
  // Soccer table 120 is the match result, and its half copies share the id.
  const soccer = 1;
  assert.equal(
    resolveBetAssistMarket({ srSportId: soccer, providerMarketId: 1_000_120, variant: "" }),
    "3Way",
  );
  assert.equal(
    resolveBetAssistMarket({
      srSportId: soccer,
      providerMarketId: 1_000_120,
      variant: "fb:100201",
    }),
    "1stHalfWin",
  );
  assert.equal(
    resolveBetAssistMarket({
      srSportId: soccer,
      providerMarketId: 1_000_120,
      variant: "fb:100202",
    }),
    "2ndHalfWin",
  );
  // The double-chance split is its own type.
  assert.equal(
    resolveBetAssistMarket({ srSportId: soccer, providerMarketId: 1_900_120, variant: "" }),
    "doubleChance",
  );
  // A sub-event with no Sportradar counterpart renders no button.
  assert.equal(
    resolveBetAssistMarket({
      srSportId: soccer,
      providerMarketId: 1_000_120,
      variant: "fb:400300",
    }),
    null,
  );
});
