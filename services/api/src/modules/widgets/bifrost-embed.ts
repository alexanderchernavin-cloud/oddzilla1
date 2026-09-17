// Bifrost as the last-resort widget surface.
//
// When our own Disir brand token is refused by the widget host, nothing
// that carries our token can render — not an issued URL, not a locally
// built one, not a second token unless Oddin has registered our domain
// on it (token-health.ts). What still renders on oddzilla.cc, measured
// 2026-09-16, is Oddin's own white-label front end, Bifrost: it loads in
// an iframe with MaxBet's Bifrost key (its API calls carry Bifrost's own
// origin, so the embedding page is not checked), and the Disir widgets
// Bifrost opens from inside that frame render because the widget host
// then sees `Referer: bifrost.oddin.gg`, which is registered for MaxBet's
// Disir token. Oddin authorised that key for us on 2026-09-03 for the
// backup feed, and suggested it for the widgets on 2026-09-16.
//
// What we embed is Bifrost's NON-BETTING match page: the header with
// both teams and the per-map score, then the Team / Players / Tournament
// statistics widget inline, with a Stream tab and a Live stats tab — and
// no markets, no bet slip, no "My bets". That mode is not reachable from
// the URL: `nonBetting` is validated as a real boolean by the app's zod
// config schema, and a query parameter is always a string. It IS
// reachable over the loader's own channel — the app listens for a
// postMessage `{type:"CONFIG", data:{...}}` (read off Bifrost's bundle,
// v1.28.0), applies `nonBetting`, and if `data.route` carries a route
// link it navigates there. One message with both lands on the
// non-betting match page; the storefront keeps the frame hidden until
// the app reports the route change so the betting page never shows.
//
// Route links are base64 JSON, a discriminated union on `route`:
// `{"route":"/match","matchId":"<base64 of match/od:match:N>"}` is the
// one we use. Same id grammar as Disir's own (disir-url.ts).
//
// Pure: no Fastify, no DB. Tested in bifrost-embed.test.ts.

import { encodeDisirId } from "./disir-url.js";

export const BIFROST_EMBED_ORIGIN = "https://bifrost.oddin.gg";

export interface BifrostEmbedInput {
  apiKey: string;
  matchUrn: string;
  // The storefront page that embeds the frame; Bifrost uses it to build
  // its own outbound links and as the `customDomain` it trusts messages from.
  refererUrl: string;
  storefrontHost: string;
  language?: string;
  theme?: "dark" | "light" | "auto";
  // Fixed only by tests; a per-load value keeps Bifrost's own cache honest.
  q?: number;
}

export interface BifrostEmbed {
  url: string;
  // JSON to postMessage to the frame after it reports LOADED. Built here
  // so the grammar lives in one place.
  configMessage: string;
  // Origin the storefront must filter postMessages on.
  origin: string;
}

export function bifrostRouteLink(matchUrn: string): string {
  return Buffer.from(
    JSON.stringify({ route: "/match", matchId: encodeDisirId("match", matchUrn) }),
    "utf8",
  ).toString("base64");
}

export function buildBifrostEmbed(input: BifrostEmbedInput): BifrostEmbed {
  const route = bifrostRouteLink(input.matchUrn);
  const qs = new URLSearchParams();
  qs.set("route", route);
  qs.set("referer", input.refererUrl);
  qs.set("lang", input.language ?? "en");
  qs.set("currency", "USD");
  // `token` is the bettor's session for placing bets through Bifrost;
  // empty on purpose — this frame is read-only by construction.
  qs.set("token", "");
  qs.set("brandToken", input.apiKey);
  qs.set("customDomain", input.storefrontHost);
  qs.set("theme", input.theme === "light" ? "light" : "dark");
  qs.set("q", String(input.q ?? Date.now()));
  return {
    url: `${BIFROST_EMBED_ORIGIN}/?${qs.toString()}`,
    configMessage: JSON.stringify({ type: "CONFIG", data: { nonBetting: true, route } }),
    origin: BIFROST_EMBED_ORIGIN,
  };
}
