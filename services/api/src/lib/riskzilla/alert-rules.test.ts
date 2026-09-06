// Alert rule catalogue invariants. The rules are SQL strings evaluated
// by the sweeper, so the things TypeScript cannot check are pinned here:
// every kind is unique and seeded by the migration, every rule renders
// with its defaults, and param clamping behaves.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { ALERT_RULES, ALERT_RULE_BY_KIND, readParams } from "./alert-rules.js";

const here = dirname(fileURLToPath(import.meta.url));
const migration = readFileSync(
  join(here, "..", "..", "..", "..", "..", "packages", "db", "migrations", "20260906T230248_risk_alerts.sql"),
  "utf8",
);

test("rule kinds are unique and match the migration seed", () => {
  const kinds = ALERT_RULES.map((r) => r.kind);
  assert.equal(new Set(kinds).size, kinds.length, "duplicate kind");
  const seeded = [...migration.matchAll(/^\s*\('([a-z_]+)',\s+'(critical|serious|warning)'/gm)].map(
    (m) => ({ kind: m[1]!, severity: m[2]! }),
  );
  assert.deepEqual(
    seeded.map((s) => s.kind).sort(),
    [...kinds].sort(),
    "migration seed and ALERT_RULES disagree",
  );
  for (const s of seeded) {
    assert.equal(
      ALERT_RULE_BY_KIND[s.kind]!.defaultSeverity,
      s.severity,
      `${s.kind}: default severity differs from the seed`,
    );
  }
});

test("every rule renders with its default params and emits the contract columns", () => {
  for (const def of ALERT_RULES) {
    const chunk = def.select(readParams(def, undefined));
    // Drizzle SQL objects expose their pieces via queryChunks; join the
    // string parts so the column contract can be asserted textually.
    const text = chunk.queryChunks
      .map((c) => (typeof c === "object" && c !== null && "value" in c ? String((c as { value: unknown }).value) : ""))
      .join(" ");
    for (const col of [
      "AS title",
      "AS body",
      "AS dedupe_key",
      "AS subject_user_id",
      "AS ticket_id",
      "AS match_id",
      "AS currency",
      "AS amount_micro",
      "AS payload",
    ]) {
      assert.ok(text.includes(col), `${def.kind}: missing ${col}`);
    }
  }
});

test("readParams fills defaults, clamps to bounds and drops unknown keys", () => {
  const def = ALERT_RULE_BY_KIND.big_stake!;
  assert.deepEqual(readParams(def, undefined), def.defaultParams);
  assert.deepEqual(readParams(def, { thresholdUsdc: 50 }), { thresholdUsdc: 50, windowHours: 24 });
  assert.equal(readParams(def, { thresholdUsdc: 0 }).thresholdUsdc, 1);
  assert.equal(readParams(def, { windowHours: 10_000 }).windowHours, 720);
  assert.equal(readParams(def, { thresholdUsdc: "300" }).thresholdUsdc, 300);
  assert.equal(readParams(def, { thresholdUsdc: "abc" }).thresholdUsdc, 500);
  assert.equal("bogus" in readParams(def, { bogus: 1 }), false);
});

test("seeded default params match the catalogue defaults", () => {
  for (const def of ALERT_RULES) {
    const m = migration.match(new RegExp(`\\('${def.kind}',\\s+'\\w+',\\s+'(\\{[^']*\\})'`));
    assert.ok(m, `${def.kind}: no seed row`);
    assert.deepEqual(JSON.parse(m![1]!), def.defaultParams, `${def.kind}: seed params differ`);
  }
});
