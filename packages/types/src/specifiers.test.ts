// Golden-fixture test. The same docs/fixtures/specifiers.json is also
// verified by services/feed-ingester/internal/oddinxml/specifiers_test.go.
// If this test drifts from the Go test, settlement fails silently.

import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import assert from "node:assert/strict";
import { canonical, hash, parse, type Specifiers } from "./specifiers.js";

interface FixtureCase {
  name: string;
  raw: string;
  specifiers: Specifiers;
  canonical: string;
  sha256Hex: string;
}

async function loadFixture(): Promise<FixtureCase[]> {
  const here = dirname(fileURLToPath(import.meta.url));
  // src → packages/types → packages → repo root
  const repoRoot = join(here, "..", "..", "..");
  const path = join(repoRoot, "docs", "fixtures", "specifiers.json");
  return JSON.parse(await readFile(path, "utf8")) as FixtureCase[];
}

test("specifiers golden fixture", async (t) => {
  const cases = await loadFixture();
  for (const c of cases) {
    await t.test(c.name, () => {
      const parsed = parse(c.raw);
      assert.deepEqual(parsed, c.specifiers, `parse(${JSON.stringify(c.raw)})`);

      const got = canonical(c.specifiers);
      assert.equal(got, c.canonical, "canonical");

      const hex = createHash("sha256")
        .update(canonical(c.specifiers))
        .digest("hex");
      assert.equal(hex, c.sha256Hex, "sha256 of canonical");

      const buf = hash(c.specifiers);
      assert.equal(buf.toString("hex"), c.sha256Hex, "hash() buffer");
    });
  }
});
