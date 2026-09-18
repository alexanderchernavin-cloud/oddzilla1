import { test } from "node:test";
import assert from "node:assert/strict";

import {
  assetUpstreamUrl,
  fetchWidgetAsset,
  fetchWidgetDocument,
  proxyContentSecurityPolicy,
  rewriteWidgetDocument,
  type FetchLike,
} from "./disir-proxy.js";

// A faithful slice of the real widget shell (measured on production
// 2026-09-17): head refs, the JSON assetPrefix, favicon and the
// preconnect-to-root that must NOT be rewritten.
const BUILD = "31653536616636382d663762322d3435";
const DOC =
  `<!DOCTYPE html><html class="theme-dark"><head>` +
  `<link rel="stylesheet" href="/${BUILD}/static/theme.dark.css"/>` +
  `<link href="/favicon.ico" rel="icon"/>` +
  `<link rel="preconnect" href="/" crossorigin="anonymous"/>` +
  `<script src="/${BUILD}/_next/static/chunks/985594b27bc977f9.js" defer=""></script>` +
  `</head><body><script id="__NEXT_DATA__" type="application/json">` +
  `{"page":"/csgo/match","buildId":"v1.12.0","assetPrefix":"/${BUILD}","nextExport":true}` +
  `</script></body></html>`;

const ASSET_BASE = "/api/widgets/disir-asset/integration";

test("rewriteWidgetDocument points every build-prefixed ref at the same-origin asset base", () => {
  const out = rewriteWidgetDocument(DOC, ASSET_BASE);
  assert.ok(out);
  assert.equal(out.buildId, BUILD);
  // head asset refs
  assert.match(out.html, new RegExp(`href="${ASSET_BASE}/${BUILD}/static/theme\\.dark\\.css"`));
  assert.match(out.html, new RegExp(`src="${ASSET_BASE}/${BUILD}/_next/static/chunks/`));
  // the runtime assetPrefix turbopack uses for dynamic chunks
  assert.match(out.html, new RegExp(`"assetPrefix":"${ASSET_BASE}/${BUILD}"`));
  // no root-relative build-prefixed ref survives
  assert.ok(!out.html.includes(`"/${BUILD}`));
});

test("rewriteWidgetDocument leaves favicon and preconnect root-relative", () => {
  const out = rewriteWidgetDocument(DOC, ASSET_BASE);
  assert.ok(out);
  assert.match(out.html, /href="\/favicon\.ico"/);
  assert.match(out.html, /rel="preconnect" href="\/"/);
});

test("rewriteWidgetDocument tolerates a trailing slash on the base", () => {
  const out = rewriteWidgetDocument(DOC, ASSET_BASE + "/");
  assert.ok(out);
  assert.match(out.html, new RegExp(`src="${ASSET_BASE}/${BUILD}/_next/`));
  assert.ok(!out.html.includes(`disir-asset/integration//`));
});

test("rewriteWidgetDocument injects a shim that redirects runtime build-prefixed fetch + XHR", () => {
  // The load-bearing case: the widget's i18next backend fetches
  // `/<buildId>/static/locales/{{lng}}/{{ns}}.json` at RUNTIME (the path is
  // hardcoded in a chunk, not in the HTML), so the document rewrite never
  // touches it and it would resolve against our own origin. The injected
  // shim must send it through the asset proxy. Run the shim in a fake env
  // and prove both transports get rewritten.
  const out = rewriteWidgetDocument(DOC, ASSET_BASE);
  assert.ok(out);
  const m = out.html.match(/<script>([\s\S]*?)<\/script>/);
  const shim = m?.[1] ?? "";
  assert.ok(shim, "a shim <script> is injected");

  const locales = `/${BUILD}/static/locales/en/core.json`;
  const expected = `${ASSET_BASE}${locales}`;

  const fetchCalls: string[] = [];
  const fakeWindow: { fetch: (u: unknown) => Promise<void> } = {
    fetch: (u: unknown) => {
      fetchCalls.push(String(u));
      return Promise.resolve();
    },
  };
  const fakeLocation = { origin: "https://oddzilla.cc" };
  const xhrOpens: unknown[][] = [];
  class FakeXHR {
    open(...args: unknown[]) {
      xhrOpens.push(args);
    }
  }

  new Function("window", "location", "XMLHttpRequest", shim)(
    fakeWindow,
    fakeLocation,
    FakeXHR,
  );

  // fetch: root-relative build-prefixed request is redirected...
  void fakeWindow.fetch(locales);
  // ...an absolute same-origin one too...
  void fakeWindow.fetch(`${fakeLocation.origin}${locales}`);
  // ...and the cross-origin data API is left alone.
  const dataApi = "https://external-production.oddin.gg/integration/disir/query";
  void fakeWindow.fetch(dataApi);
  assert.deepEqual(fetchCalls, [expected, expected, dataApi]);

  // XHR open rewrites its url argument in place.
  const xhr = new FakeXHR();
  (xhr as unknown as { open: (m: string, u: string) => void }).open("GET", locales);
  assert.equal(xhrOpens[0]?.[1], expected);
});

test("rewriteWidgetDocument refuses a document with no build prefix", () => {
  // A 403 / error page or a redirect body carries no 32-hex prefix, so it
  // is not the widget shell and must not be served as one.
  assert.equal(rewriteWidgetDocument("<html><body>Forbidden</body></html>", ASSET_BASE), null);
  assert.equal(rewriteWidgetDocument('<a href="/short/notahex">x</a>', ASSET_BASE), null);
});

test("assetUpstreamUrl targets the right widget host per environment", () => {
  assert.equal(
    assetUpstreamUrl("integration", `${BUILD}/_next/static/chunks/x.js`),
    `https://disir.integration.oddin.gg/${BUILD}/_next/static/chunks/x.js`,
  );
  assert.equal(
    assetUpstreamUrl("main", `${BUILD}/static/theme.dark.css`),
    `https://disir.oddin.gg/${BUILD}/static/theme.dark.css`,
  );
});

test("proxyContentSecurityPolicy keeps scripts same-origin and allows the data API + WSS", () => {
  const csp = proxyContentSecurityPolicy();
  assert.match(csp, /default-src 'none'/);
  assert.match(csp, /script-src 'self' 'unsafe-inline' 'unsafe-eval'/);
  assert.match(csp, /connect-src 'self' https:\/\/external-production\.oddin\.gg wss:\/\/external-production\.oddin\.gg/);
  assert.match(csp, /frame-ancestors 'self'/);
});

function fakeFetch(
  status: number,
  body: string,
  contentType = "text/html",
  capture?: { headers?: Record<string, string>; url?: string; method?: string },
): FetchLike {
  return async (url, init) => {
    if (capture) {
      capture.url = url;
      capture.headers = init.headers;
      capture.method = init.method;
    }
    return {
      status,
      headers: { get: (n: string) => (n.toLowerCase() === "content-type" ? contentType : null) },
      text: async () => body,
      arrayBuffer: async () => new TextEncoder().encode(body).buffer,
    };
  };
}

test("fetchWidgetDocument presents the authorised referer and browser metadata, returns HTML on 200", async () => {
  const cap: { headers?: Record<string, string>; url?: string; method?: string } = {};
  const r = await fetchWidgetDocument(
    "https://disir.integration.oddin.gg/csgo/match?x=1",
    "https://bifrost.oddin.gg",
    fakeFetch(200, DOC, "text/html", cap),
  );
  assert.equal(r.status, 200);
  assert.equal(r.html, DOC);
  assert.equal(cap.method, "GET");
  assert.equal(cap.headers?.referer, "https://bifrost.oddin.gg/");
  assert.match(cap.headers?.["accept-encoding"] ?? "", /gzip/);
  assert.equal(cap.headers?.["sec-fetch-dest"], "iframe");
});

test("fetchWidgetDocument returns null html on a non-200 (refused / redirect / error)", async () => {
  const r = await fetchWidgetDocument("https://x/y", "https://bifrost.oddin.gg", fakeFetch(403, "no"));
  assert.equal(r.status, 403);
  assert.equal(r.html, null);
});

test("fetchWidgetAsset returns bytes + content-type on 200 and null on failure", async () => {
  const ok = await fetchWidgetAsset(
    "https://disir.integration.oddin.gg/x/y.js",
    "https://bifrost.oddin.gg",
    fakeFetch(200, "console.log(1)", "application/javascript"),
  );
  assert.equal(ok.status, 200);
  assert.equal(ok.contentType, "application/javascript");
  assert.equal(new TextDecoder().decode(ok.body ?? new Uint8Array()), "console.log(1)");
  const bad = await fetchWidgetAsset("https://x/y", "https://bifrost.oddin.gg", fakeFetch(404, "no"));
  assert.equal(bad.status, 404);
  assert.equal(bad.body, null);
});

test("fetch helpers report a thrown fetch as failure, never a partial success", async () => {
  const boom: FetchLike = async () => {
    throw new Error("ECONNRESET");
  };
  assert.equal((await fetchWidgetDocument("https://x/y", "https://bifrost.oddin.gg", boom)).html, null);
  assert.equal((await fetchWidgetAsset("https://x/y", "https://bifrost.oddin.gg", boom)).body, null);
});
