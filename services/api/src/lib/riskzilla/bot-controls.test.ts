// Run with: tsx --test src/lib/riskzilla/bot-controls.test.ts

import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { velocityCapFor, DEFAULT_BOT_CONTROLS } from "./bot-controls.js";

describe("velocityCapFor", () => {
  it("returns the base cap at the default risk score", () => {
    assert.equal(velocityCapFor(12, 1), 12);
    assert.equal(velocityCapFor(10, 1.0), 10);
  });

  it("scales linearly with risk score", () => {
    assert.equal(velocityCapFor(12, 0.5), 6);
    assert.equal(velocityCapFor(12, 2), 24);
    assert.equal(velocityCapFor(10, 10), 100);
  });

  it("never drops below one placement per minute", () => {
    assert.equal(velocityCapFor(12, 0.01), 1);
    assert.equal(velocityCapFor(1, 0.3), 1);
  });

  it("treats a bad risk score as the default", () => {
    assert.equal(velocityCapFor(12, Number.NaN), 12);
    assert.equal(velocityCapFor(12, 0), 12);
    assert.equal(velocityCapFor(12, -3), 12);
  });

  it("defaults mirror the migration column defaults", () => {
    assert.equal(DEFAULT_BOT_CONTROLS.intentRequired, true);
    assert.equal(DEFAULT_BOT_CONTROLS.intentTtlSeconds, 120);
    assert.equal(DEFAULT_BOT_CONTROLS.minHumanMs, 600);
    assert.equal(DEFAULT_BOT_CONTROLS.maxBetsPerMinute, 12);
    assert.equal(DEFAULT_BOT_CONTROLS.maxMatchesPerMinute, 10);
    assert.equal(DEFAULT_BOT_CONTROLS.behaviourAlertThreshold, 0.7);
    assert.equal(DEFAULT_BOT_CONTROLS.behaviourMinSessions, 2);
  });
});
