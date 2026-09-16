import { test } from "node:test";
import assert from "node:assert/strict";

import {
  credentialsFor,
  decideSlot,
  probeUrl,
  probeWidgetHost,
  type FetchLike,
  type TokenConfig,
} from "./token-health.js";

const cfg: TokenConfig = {
  primary: { brandToken: "primary-token-000", env: "integration" },
  backup: { brandToken: "backup-token-000", env: "main" },
};

test("decideSlot: no backup configured always means primary", () => {
  assert.equal(decideSlot("primary", false, "refused", null), "primary");
  assert.equal(decideSlot("backup", false, "refused", null), "primary");
});

test("decideSlot: a healthy primary wins, even when currently on the backup", () => {
  assert.equal(decideSlot("backup", true, "ok", null), "primary");
  assert.equal(decideSlot("primary", true, "ok", "ok"), "primary");
});

test("decideSlot: refused primary moves to a backup that was seen working", () => {
  assert.equal(decideSlot("primary", true, "refused", "ok"), "backup");
});

test("decideSlot: refused primary with an unproven backup stays put", () => {
  assert.equal(decideSlot("primary", true, "refused", "refused"), "primary");
  assert.equal(decideSlot("primary", true, "refused", "unknown"), "primary");
  assert.equal(decideSlot("primary", true, "refused", null), "primary");
  assert.equal(decideSlot("backup", true, "refused", "unknown"), "backup");
});

test("decideSlot: an unwell host (unknown) never moves the slot", () => {
  assert.equal(decideSlot("primary", true, "unknown", null), "primary");
  assert.equal(decideSlot("backup", true, "unknown", null), "backup");
});

test("credentialsFor: backup slot without a backup configured falls back to primary", () => {
  assert.deepEqual(credentialsFor(cfg, "backup"), {
    slot: "backup",
    brandToken: "backup-token-000",
    env: "main",
  });
  assert.deepEqual(credentialsFor({ ...cfg, backup: null }, "backup"), {
    slot: "primary",
    brandToken: "primary-token-000",
    env: "integration",
  });
});

test("probeUrl targets the right host with a fresh cache-buster and the token", () => {
  const a = new URL(probeUrl("integration", "tok-a"));
  const b = new URL(probeUrl("main", "tok-a"));
  assert.equal(a.host, "disir.integration.oddin.gg");
  assert.equal(b.host, "disir.oddin.gg");
  assert.equal(a.pathname, "/csgo/tournament");
  assert.equal(a.searchParams.get("brandToken"), "tok-a");
  assert.notEqual(a.searchParams.get("t"), b.searchParams.get("t"));
});

function fakeFetch(status: number, capture?: { headers?: Record<string, string>; url?: string }): FetchLike {
  return async (url, init) => {
    if (capture) {
      capture.headers = init.headers;
      capture.url = url;
    }
    return { status };
  };
}

test("probeWidgetHost: 200 is ok, 403 and 401 are refused, anything else is unknown", async () => {
  assert.equal((await probeWidgetHost("integration", "t", "https://oddzilla.cc", fakeFetch(200))).verdict, "ok");
  assert.equal((await probeWidgetHost("integration", "t", "https://oddzilla.cc", fakeFetch(403))).verdict, "refused");
  assert.equal((await probeWidgetHost("integration", "t", "https://oddzilla.cc", fakeFetch(401))).verdict, "refused");
  assert.equal((await probeWidgetHost("integration", "t", "https://oddzilla.cc", fakeFetch(502))).verdict, "unknown");
  assert.equal((await probeWidgetHost("integration", "t", "https://oddzilla.cc", fakeFetch(302))).verdict, "unknown");
});

test("probeWidgetHost: a thrown fetch is unknown, never refused", async () => {
  const boom: FetchLike = async () => {
    throw new Error("ECONNRESET");
  };
  const r = await probeWidgetHost("integration", "t", "https://oddzilla.cc", boom);
  assert.equal(r.verdict, "unknown");
  assert.equal(r.status, null);
  assert.match(r.detail ?? "", /ECONNRESET/);
});

test("probeWidgetHost sends the referer, the encoding and the iframe fetch metadata the host keys on", async () => {
  const cap: { headers?: Record<string, string>; url?: string } = {};
  await probeWidgetHost("integration", "t", "https://oddzilla.cc/", fakeFetch(200, cap));
  assert.equal(cap.headers?.referer, "https://oddzilla.cc/");
  assert.match(cap.headers?.["accept-encoding"] ?? "", /gzip/);
  assert.equal(cap.headers?.["sec-fetch-dest"], "iframe");
  assert.match(cap.url ?? "", /^https:\/\/disir\.integration\.oddin\.gg\/csgo\/tournament\?/);
});
