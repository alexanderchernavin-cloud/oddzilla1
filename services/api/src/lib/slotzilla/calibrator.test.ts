// Unit tests for the SlotZilla calibrator's corpus arithmetic.
//
// Run with: tsx --test src/lib/slotzilla/calibrator.test.ts

import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { DEFAULT_PAYTABLE_LINES, expectedReturnBp, LINE_KEYS } from "@oddzilla/types/slotzilla";
import {
  corpusRounds,
  fitCorpus,
  groupByMatch,
  summariseCorpus,
  windowSymbolsForMatch,
  type CorpusEvent,
} from "./calibrator.js";

function ev(
  srMatchId: string,
  seconds: number,
  symbol: CorpusEvent["symbol"],
  over: Partial<CorpusEvent> = {},
): CorpusEvent {
  return { srMatchId, seconds, symbol, disabled: false, team: "home", eventId: null, ...over };
}

describe("windowSymbolsForMatch", () => {
  it("returns one symbol per 5-second window from tip-off to the last reading", () => {
    const symbols = windowSymbolsForMatch([ev("m", 3, "P2"), ev("m", 12, "FOUL")]);
    // Windows 0, 5, 10 — the reading at 12 s closes the third window.
    assert.deepEqual(symbols, ["P2", "NONE", "FOUL"]);
  });

  it("extends to maxSeconds so trailing empty windows count", () => {
    const symbols = windowSymbolsForMatch([ev("m", 3, "P3")], 21);
    assert.deepEqual(symbols, ["P3", "NONE", "NONE", "NONE", "NONE"]);
  });

  it("is empty for a match with no clock readings", () => {
    assert.deepEqual(windowSymbolsForMatch([]), []);
  });

  it("ignores disabled events and events without a symbol", () => {
    const symbols = windowSymbolsForMatch([
      ev("m", 1, "P3", { disabled: true }),
      ev("m", 2, null),
      ev("m", 6, "MISS"),
    ]);
    assert.deepEqual(symbols, ["NONE", "MISS"]);
  });
});

describe("corpusRounds", () => {
  it("slides a 3-window round over each match and never across matches", () => {
    const byMatch = groupByMatch([
      ev("a", 0, "P2"),
      ev("a", 5, "P2"),
      ev("a", 10, "FT"),
      ev("a", 15, "P2"),
      ev("b", 0, "P3"),
      ev("b", 5, "P3"),
      ev("b", 10, "P3"),
    ]);
    const rounds = corpusRounds(byMatch);
    // a has 4 windows -> 2 rounds; b has 3 windows -> 1 round.
    assert.deepEqual(rounds, [
      ["P2", "P2", "FT"],
      ["P2", "FT", "P2"],
      ["P3", "P3", "P3"],
    ]);
  });
});

describe("summariseCorpus", () => {
  it("counts matches, events, rounds and line shares", () => {
    const s = summariseCorpus([
      ev("a", 0, "P2"),
      ev("a", 5, "P2"),
      ev("a", 10, "FT"),
      ev("a", 15, "P2"),
      ev("b", 0, "P3"),
      ev("b", 5, "P3"),
      ev("b", 10, "P3"),
    ]);
    assert.equal(s.matches, 2);
    assert.equal(s.events, 7);
    assert.equal(s.rounds, 3);
    assert.equal(s.byLine["any2:P2"], 2 / 3);
    assert.equal(s.byLine["all3:P3"], 1 / 3);
    assert.equal(s.byLine["any2:FOUL"], 0);
    for (const k of LINE_KEYS) assert.ok(typeof s.byLine[k] === "number");
  });

  it("returns zero shares for an empty corpus", () => {
    const s = summariseCorpus([]);
    assert.equal(s.matches, 0);
    assert.equal(s.rounds, 0);
    for (const k of LINE_KEYS) assert.equal(s.byLine[k], 0);
  });
});

describe("fitCorpus", () => {
  it("scales the play lines to the target and holds the NONE lines", () => {
    // A corpus made of alternating pairs so several lines carry weight.
    const events: CorpusEvent[] = [];
    const pattern: CorpusEvent["symbol"][] = ["P2", "P2", "MISS", "FOUL", "FOUL", null, "FT", "FT", "P3"];
    for (let i = 0; i < 60; i++) events.push(ev("m", i * 5, pattern[i % pattern.length]!));
    const fit = fitCorpus(events, DEFAULT_PAYTABLE_LINES, 9700);
    assert.equal(fit.corpus.matches, 1);
    assert.equal(fit.corpus.rounds, 58);
    assert.equal(fit.lines["any2:NONE"], DEFAULT_PAYTABLE_LINES["any2:NONE"]);
    assert.equal(fit.lines["all3:NONE"], DEFAULT_PAYTABLE_LINES["all3:NONE"]);
    assert.ok(fit.factor > 0);
    // Rounding the scaled lines to integer hundredths leaves the fitted
    // return within a few basis points of the target.
    assert.ok(Math.abs(fit.fittedBp - 9700) < 50, `fitted ${fit.fittedBp}`);
    assert.equal(fit.fittedBp, expectedReturnBp(fit.lines, fit.corpus.byLine));
  });

  it("floors the factor at zero when the fixed lines alone exceed the target", () => {
    // Every round is NONE/NONE/NONE, which pays x1 on the fixed line:
    // the fixed contribution is 100% and a 97% target is unreachable.
    const events: CorpusEvent[] = [ev("m", 0, null, { seconds: 100 })];
    const fit = fitCorpus(events, DEFAULT_PAYTABLE_LINES, 9700);
    assert.equal(fit.factor, 0);
    assert.equal(fit.lines["any2:P3"], 0);
    assert.equal(fit.lines["all3:NONE"], 100);
  });
});
