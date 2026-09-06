// Unit tests for the ComboZilla eligibility policy (migration
// 20260906T015446_combozilla_config).
//
// Run with: tsx --test src/lib/combozilla.test.ts
//
// The predicate is SQL, so the tests render it through the Postgres
// dialect and pin the ORDER of the CASE branches — that order IS the
// cascade (tournament > category > sport > tier default), and a
// reordering would silently change which rule wins.

import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { PgDialect } from "drizzle-orm/pg-core";
import { drizzle } from "drizzle-orm/postgres-js";
import { buildPoolQuery, comboZillaEligibility, partitionRules } from "./combozilla.js";

// Same casing the real connection uses (packages/db/src/index.ts), so the
// rendered column names are the ones Postgres will see.
const dialect = new PgDialect({ casing: "snake_case" });
const render = (cfg: { eligibleRiskTiers: number[]; allowUntiered: boolean }, rules: Parameters<typeof partitionRules>[0]) =>
  dialect.sqlToQuery(comboZillaEligibility(cfg, partitionRules(rules)));

const rule = (
  scope: "sport" | "category" | "tournament",
  mode: "allow" | "block",
  id: number,
) => ({
  scope,
  mode,
  sportId: scope === "sport" ? id : null,
  categoryId: scope === "category" ? id : null,
  tournamentId: scope === "tournament" ? id : null,
});

describe("partitionRules", () => {
  it("groups rows by scope and mode", () => {
    const p = partitionRules([
      rule("sport", "allow", 1),
      rule("sport", "block", 2),
      rule("category", "allow", 10),
      rule("category", "block", 11),
      rule("tournament", "allow", 100),
      rule("tournament", "block", 101),
    ]);
    assert.deepEqual(p, {
      allowSports: [1],
      blockSports: [2],
      allowCategories: [10],
      blockCategories: [11],
      allowTournaments: [100],
      blockTournaments: [101],
    });
  });

  it("skips a row whose ref column is NULL for its own scope", () => {
    const p = partitionRules([
      { scope: "sport", mode: "allow", sportId: null, categoryId: 5, tournamentId: null },
    ]);
    assert.deepEqual(p.allowSports, []);
    assert.deepEqual(p.allowCategories, []);
  });
});

describe("comboZillaEligibility", () => {
  it("with no rules, only the tier default decides", () => {
    const q = render({ eligibleRiskTiers: [1, 2, 3], allowUntiered: false }, []);
    assert.match(q.sql, /^\(CASE WHEN "tournaments"\."risk_tier" is null THEN FALSE WHEN "tournaments"\."risk_tier" in \(\$1, \$2, \$3\) THEN TRUE ELSE FALSE END\)$/);
    assert.deepEqual(q.params, [1, 2, 3]);
  });

  it("an empty tier set admits nothing by tier", () => {
    const q = render({ eligibleRiskTiers: [], allowUntiered: false }, []);
    assert.equal(q.sql, '(CASE WHEN "tournaments"."risk_tier" is null THEN FALSE ELSE FALSE END)');
    assert.deepEqual(q.params, []);
  });

  it("allow_untiered flips the NULL branch", () => {
    const q = render({ eligibleRiskTiers: [1], allowUntiered: true }, []);
    assert.match(q.sql, /"risk_tier" is null THEN TRUE/);
  });

  it("rules precede the tier default, most specific first, allow before block", () => {
    const q = render({ eligibleRiskTiers: [1, 2, 3], allowUntiered: false }, [
      rule("sport", "block", 7),
      rule("sport", "allow", 8),
      rule("category", "block", 70),
      rule("category", "allow", 80),
      rule("tournament", "block", 700),
      rule("tournament", "allow", 800),
    ]);
    const order = [
      '"tournaments"."id" in ($1) THEN TRUE',
      '"tournaments"."id" in ($2) THEN FALSE',
      '"categories"."id" in ($3) THEN TRUE',
      '"categories"."id" in ($4) THEN FALSE',
      '"sports"."id" in ($5) THEN TRUE',
      '"sports"."id" in ($6) THEN FALSE',
      '"tournaments"."risk_tier" is null THEN FALSE',
      '"tournaments"."risk_tier" in ($7, $8, $9) THEN TRUE',
    ];
    let cursor = -1;
    for (const fragment of order) {
      const at = q.sql.indexOf(fragment);
      assert.ok(at > cursor, `expected "${fragment}" after the previous branch in:\n${q.sql}`);
      cursor = at;
    }
    assert.deepEqual(q.params, [800, 700, 80, 70, 8, 7, 1, 2, 3]);
  });

  it("a rule branch is omitted entirely when its id list is empty", () => {
    const q = render({ eligibleRiskTiers: [1], allowUntiered: false }, [
      rule("tournament", "block", 5),
    ]);
    assert.ok(!q.sql.includes('"categories"."id"'));
    assert.ok(!q.sql.includes('"sports"."id"'));
    assert.ok(q.sql.includes('"tournaments"."id" in ($1) THEN FALSE'));
  });
});

// The whole statement, not one clause.
//
// The eligibility tests above render the CASE alone, and that is exactly
// why they missed the bug that took this endpoint down on 2026-09-06: the
// CTE joins four tables that each have an `id`, drizzle emitted them
// unaliased, and Postgres rejected the outer select with `column reference
// "id" is ambiguous`. Building a query needs no connection — only
// executing it does — so a dummy client is enough to render one.
describe("buildPoolQuery", () => {
  const db = drizzle({} as never);
  // Rendered through `dialect` (which carries the real connection's
  // snake_case casing), NOT the query's own `.toSQL()`: a connectionless
  // drizzle instance does not inherit that casing and renders every column
  // as its camelCase TS name — `"matches"."homeTeam"`, not a column that
  // exists. Asserting on that render would prove nothing about the
  // statement Postgres actually receives.
  const renderPool = () =>
    dialect.sqlToQuery(
      buildPoolQuery(
        db as never,
        { eligibleRiskTiers: [1, 2, 3], allowUntiered: false },
        [],
      ).getSQL(),
    ).sql;

  it("renders DB column names, not camelCase TS property names", () => {
    const sql = renderPool();
    assert.ok(sql.includes('"matches"."home_team"'), sql.slice(0, 200));
    assert.ok(!sql.includes("homeTeam"), "casing was not applied");
  });

  it("gives every CTE column a unique alias", () => {
    const sql = renderPool();
    const cte = sql.slice(sql.indexOf("as ("), sql.indexOf(" from "));
    const aliases = [...cte.matchAll(/ as "([^"]+)"/g)].map((m) => m[1] ?? "");
    assert.ok(aliases.length >= 12, `expected the full select list, got ${aliases.length}`);
    assert.equal(
      aliases.length,
      new Set(aliases).size,
      `duplicate CTE aliases: ${aliases.join(", ")}`,
    );
  });

  it("selects no bare ambiguous column from the CTE", () => {
    const sql = renderPool();
    const outer = sql.slice(sql.lastIndexOf("select "));
    // Postgres rejects a bare `"id"` here when several joined tables expose
    // one, so every projected name must carry the cz_ prefix.
    for (const name of [...outer.matchAll(/"([a-z_]+)"/g)].map((m) => m[1] ?? "")) {
      if (name === "combozilla_ranked") continue;
      assert.ok(
        name.startsWith("cz_"),
        `outer select projects un-prefixed column "${name}" — CTE aliases must be unique`,
      );
    }
  });
});
