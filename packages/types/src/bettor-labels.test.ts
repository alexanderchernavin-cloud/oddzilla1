import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  BETTOR_LABELS,
  RISK_FACTOR_MAX,
  RISK_FACTOR_MIN,
  isBettorLabel,
  riskFactorToPercent,
} from "./bettor-labels.js";

const here = dirname(fileURLToPath(import.meta.url));

test("label vocabulary matches the users_labels_allowed CHECK in migration 20260906T230247", () => {
  const sql = readFileSync(
    join(here, "..", "..", "db", "migrations", "20260906T230247_bettor_labels.sql"),
    "utf8",
  );
  const m = sql.match(/labels <@ ARRAY\[([\s\S]*?)\]::text\[\]/);
  assert.ok(m, "CHECK not found");
  const inCheck = [...m![1]!.matchAll(/'([a-z]+)'/g)].map((x) => x[1]).sort();
  assert.deepEqual(inCheck, [...BETTOR_LABELS].sort());
});

test("isBettorLabel accepts the vocabulary only", () => {
  for (const l of BETTOR_LABELS) assert.equal(isBettorLabel(l), true);
  assert.equal(isBettorLabel("VIP"), false);
  assert.equal(isBettorLabel(""), false);
  assert.equal(isBettorLabel(null), false);
});

test("risk factor percent: 1 = 100%, 0.1 = 10%, 10 = 1000%", () => {
  assert.equal(riskFactorToPercent(1), 100);
  assert.equal(riskFactorToPercent(RISK_FACTOR_MIN), 10);
  assert.equal(riskFactorToPercent(RISK_FACTOR_MAX), 1000);
  assert.equal(riskFactorToPercent(0.35), 35);
  assert.equal(riskFactorToPercent(1.234), 123.4);
});
