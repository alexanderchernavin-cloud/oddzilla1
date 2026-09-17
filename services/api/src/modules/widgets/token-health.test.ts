import { test } from "node:test";
import assert from "node:assert/strict";

import {
  credentialsFor,
  dataApiUrl,
  decideSlot,
  probeDataApi,
  probeToken,
  probeUrl,
  probeWidgetHost,
  verdictFor,
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

interface Capture {
  headers?: Record<string, string>;
  url?: string;
  method?: string;
  body?: string;
}

function fakeFetch(status: number, capture?: Capture): FetchLike {
  return async (url, init) => {
    if (capture) {
      capture.headers = init.headers;
      capture.url = url;
      capture.method = init.method;
      capture.body = init.body;
    }
    return { status };
  };
}

// One status per call, in order — the combined probe makes two.
function seqFetch(statuses: number[]): FetchLike {
  let i = 0;
  return async () => ({ status: statuses[i++] ?? 599 });
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

test("probeDataApi: POSTs the widget data API with the token as X-Api-Key; 200 ok, 401/403 refused, else unknown", async () => {
  const cap: Capture = {};
  assert.equal((await probeDataApi("integration", "tok", fakeFetch(200, cap))).verdict, "ok");
  assert.equal(cap.url, dataApiUrl("integration"));
  assert.equal(cap.url, "https://external-production.oddin.gg/integration/disir/query");
  assert.equal(cap.method, "POST");
  assert.equal(cap.headers?.["x-api-key"], "tok");
  assert.match(cap.body ?? "", /__typename/);
  assert.equal((await probeDataApi("main", "tok", fakeFetch(401))).verdict, "refused");
  assert.equal((await probeDataApi("main", "tok", fakeFetch(403))).verdict, "refused");
  assert.equal((await probeDataApi("main", "tok", fakeFetch(500))).verdict, "unknown");
  assert.equal(dataApiUrl("main"), "https://external-production.oddin.gg/main/disir/query");
});

test("probeToken: the host serving the page does not make a token healthy — the data API must accept it too", async () => {
  // 2026-09-17 on production: page 200, data API 401 — the widget loads
  // and then fails. That is a refusal.
  const r = await probeToken("integration", "t", "https://oddzilla.cc", seqFetch([200, 401]));
  assert.equal(r.verdict, "refused");
  assert.equal(r.status, 401);
  assert.match(r.detail ?? "", /page 200, data 401/);
  assert.equal((await probeToken("integration", "t", "https://oddzilla.cc", seqFetch([200, 200]))).verdict, "ok");
  // A host refusal decides on its own; the data API is not asked.
  assert.equal((await probeToken("integration", "t", "https://oddzilla.cc", seqFetch([403]))).verdict, "refused");
  // An unwell host or API says nothing about the token.
  assert.equal((await probeToken("integration", "t", "https://oddzilla.cc", seqFetch([200, 502]))).verdict, "unknown");
  assert.equal((await probeToken("integration", "t", "https://oddzilla.cc", seqFetch([502, 200]))).verdict, "unknown");
  // ...unless the API refuses outright, which is definitive whatever the host did.
  assert.equal((await probeToken("integration", "t", "https://oddzilla.cc", seqFetch([502, 401]))).verdict, "refused");
});

test("verdictFor: no record is unknown, otherwise the slot's own verdict", () => {
  assert.equal(verdictFor(null, "primary"), "unknown");
  assert.equal(verdictFor({ primary: "refused", backup: null, at: 1 }, "primary"), "refused");
  assert.equal(verdictFor({ primary: "refused", backup: null, at: 1 }, "backup"), "unknown");
  assert.equal(verdictFor({ primary: "refused", backup: "ok", at: 1 }, "backup"), "ok");
  assert.equal(verdictFor({ primary: "ok", backup: "refused", at: 1 }, "primary"), "ok");
});
