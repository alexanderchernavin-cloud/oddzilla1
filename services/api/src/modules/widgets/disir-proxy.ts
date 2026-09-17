// Whitelisting-independent Disir widget proxy (2026-09-17, Oddin-sanctioned).
//
// The other two widget fallbacks each leave a gap:
//   - the local URL builder (disir-url.ts) covers api-disir being down,
//     but the URL it builds carries OUR brand token, so it dies the same
//     way the issued URL does when that token is refused;
//   - a backup brand token (token-health.ts) needs Oddin to have
//     registered our domain on it, so it dies when the widget host's
//     per-token DOMAIN REGISTRY is the thing that is down or missing us.
//
// This proxy has neither dependency. Measured on production 2026-09-17:
//   - the widget's app-shell DOCUMENT (disir[.integration].oddin.gg/<seg>/
//     <kind>?...) is referer-gated: 200 with `Referer: bifrost.oddin.gg`,
//     403 with ours;
//   - its static assets (`/<buildid>/_next/...`, `/<buildid>/static/...`)
//     are NOT referer-gated: 200 from any or no referer;
//   - its data API (external-production.oddin.gg/{env}/disir/query, WSS
//     and HTTP) answers `Access-Control-Allow-Origin: *` and accepts
//     MaxBet's Disir token from any origin.
//
// So we serve the whole widget from OUR origin as a same-origin mirror:
// the api fetches the document AND every asset from Oddin server-side,
// presenting a Referer Oddin authorised us to present (DISIR_PROXY_REFERER
// = bifrost.oddin.gg) plus MaxBet's Disir token in the document URL, and
// rewrites the document's build-prefixed asset refs to point back at our
// asset-proxy route. The browser then loads assets from our origin (which
// is why a same-origin MIRROR and not just an absolute-URL rewrite: the
// widget is a turbopack app whose runtime `fetch()`es its dynamic chunks,
// and a cross-origin chunk fetch fails with no CORS — measured, the app
// hangs on the loading skeleton). Only the data API stays cross-origin,
// and that one is open-CORS so the browser calls it directly.
//
// Oddin confirmed this is a supported integration path on 2026-09-17
// (relayed by the operator), same standing as the URL-building contract
// they confirmed on 2026-09-16 — not a reverse-engineered hack a widget
// change may silently break.
//
// Pure/fetch helpers here; the Fastify wiring and byte cache are in
// routes.ts. Tested in disir-proxy.test.ts.

import { disirWidgetHost, type DisirEnv } from "./disir-url.js";

// The document is a Next.js SSR shell (Disir widget app, buildId v1.12.0):
// every asset is root-relative under a 32-hex build prefix, and
// __NEXT_DATA__.assetPrefix carries that same prefix for runtime chunk
// loads. One targeted rewrite covers head <link>/<script> refs AND the
// JSON assetPrefix, because all three are the byte sequence `"/<hex>`.
const BUILD_PREFIX_RE = /\/([0-9a-f]{32})\//;

const PROXY_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36";

const FETCH_TIMEOUT_MS = 8000;

export interface DocumentFetchResult {
  status: number;
  html: string | null;
}

export interface AssetFetchResult {
  status: number;
  contentType: string;
  body: Uint8Array | null;
}

export type FetchLike = (
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    signal: AbortSignal;
    redirect: "manual";
  },
) => Promise<{
  status: number;
  headers: { get(name: string): string | null };
  text: () => Promise<string>;
  arrayBuffer: () => Promise<ArrayBuffer>;
}>;

function requestHeaders(referer: string, dest: "iframe" | "script"): Record<string, string> {
  return {
    "user-agent": PROXY_USER_AGENT,
    accept:
      dest === "iframe"
        ? "text/html,application/xhtml+xml,*/*;q=0.8"
        : "*/*",
    "accept-encoding": "gzip, deflate, br",
    referer: `${referer.replace(/\/$/, "")}/`,
    "sec-fetch-dest": dest,
    "sec-fetch-mode": dest === "iframe" ? "navigate" : "no-cors",
    "sec-fetch-site": "cross-site",
  };
}

// GET the widget document with the authorised Referer. `redirect: manual`
// so an unexpected redirect surfaces as a non-200 rather than being
// followed to some other host.
export async function fetchWidgetDocument(
  url: string,
  referer: string,
  fetchImpl: FetchLike = fetch as unknown as FetchLike,
): Promise<DocumentFetchResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetchImpl(url, {
      method: "GET",
      headers: requestHeaders(referer, "iframe"),
      signal: controller.signal,
      redirect: "manual",
    });
    if (res.status !== 200) return { status: res.status, html: null };
    return { status: 200, html: await res.text() };
  } catch {
    return { status: 0, html: null };
  } finally {
    clearTimeout(timer);
  }
}

// GET one static asset with the authorised Referer. Assets are not
// referer-gated, but presenting it keeps the request shaped like the
// document's and costs nothing.
export async function fetchWidgetAsset(
  url: string,
  referer: string,
  fetchImpl: FetchLike = fetch as unknown as FetchLike,
): Promise<AssetFetchResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetchImpl(url, {
      method: "GET",
      headers: requestHeaders(referer, "script"),
      signal: controller.signal,
      redirect: "manual",
    });
    const contentType = res.headers.get("content-type") ?? "application/octet-stream";
    if (res.status !== 200) return { status: res.status, contentType, body: null };
    return { status: 200, contentType, body: new Uint8Array(await res.arrayBuffer()) };
  } catch {
    return { status: 0, contentType: "application/octet-stream", body: null };
  } finally {
    clearTimeout(timer);
  }
}

// Rewrite the document so its assets load from our origin: the
// build-prefixed refs and the runtime assetPrefix become `<assetBase>/
// <buildid>/…`, which routes to our asset-proxy. `/favicon.ico` and the
// `preconnect href="/"` are left root-relative on purpose — they 404
// harmlessly inside the iframe or are inert.
//
// Returns { html, upstreamPrefixPath } where upstreamPrefixPath is the
// `/<buildid>` the asset route strips back off, or null when the document
// carries no build prefix (an error page or redirect body — not the shell
// we expect, and it must not be served).
export function rewriteWidgetDocument(
  html: string,
  assetBase: string,
): { html: string; buildId: string } | null {
  const m = BUILD_PREFIX_RE.exec(html);
  const buildId = m?.[1];
  if (!buildId) return null;
  const base = assetBase.replace(/\/$/, "");
  const rewritten = html.split(`"/${buildId}`).join(`"${base}/${buildId}`);
  return { html: rewritten, buildId };
}

// The upstream URL for one proxied asset path. `rest` is everything the
// asset route captured after the env segment, e.g.
// `<buildid>/_next/static/chunks/x.js`. Guarded against traversal /
// host-swap by the caller.
export function assetUpstreamUrl(env: DisirEnv, rest: string): string {
  return `${disirWidgetHost(env)}/${rest}`;
}

// CSP for the proxied document. Assets are same-origin now, so scripts
// and styles are 'self'; the widget still reaches its data API + live
// socket cross-origin (open-CORS) and draws crests from assorted CDNs.
// Only WE may frame it.
export function proxyContentSecurityPolicy(): string {
  const data = "https://external-production.oddin.gg";
  const ws = "wss://external-production.oddin.gg";
  return [
    "default-src 'none'",
    // turbopack's inline bootstrap needs 'unsafe-inline'; its runtime
    // needs 'unsafe-eval'. Chunks are same-origin ('self').
    "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: https:",
    "font-src 'self' data:",
    // 'self' covers turbopack's same-origin dynamic chunk fetch; the
    // named hosts are the data API + live socket.
    `connect-src 'self' ${data} ${ws}`,
    "frame-ancestors 'self'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join("; ");
}
