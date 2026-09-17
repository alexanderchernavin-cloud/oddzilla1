import { test } from "node:test";
import assert from "node:assert/strict";

import { BIFROST_EMBED_ORIGIN, bifrostRouteLink, buildBifrostEmbed } from "./bifrost-embed.js";

test("route link is base64 JSON of {route:/match, matchId: base64(match/<urn>)}", () => {
  const link = bifrostRouteLink("od:match:3183228");
  const decoded = JSON.parse(Buffer.from(link, "base64").toString("utf8")) as {
    route: string;
    matchId: string;
  };
  assert.equal(decoded.route, "/match");
  assert.equal(Buffer.from(decoded.matchId, "base64").toString("utf8"), "match/od:match:3183228");
});

test("embed URL carries the key, the route, the referer and the theme in Bifrost's own grammar", () => {
  const e = buildBifrostEmbed({
    apiKey: "00000000-0000-4000-8000-000000000000",
    matchUrn: "od:match:3183228",
    refererUrl: "https://oddzilla.cc/match/1315935",
    storefrontHost: "oddzilla.cc",
    language: "en",
    theme: "light",
    q: 42,
  });
  const u = new URL(e.url);
  assert.equal(u.origin, BIFROST_EMBED_ORIGIN);
  assert.equal(u.pathname, "/");
  assert.equal(u.searchParams.get("brandToken"), "00000000-0000-4000-8000-000000000000");
  assert.equal(u.searchParams.get("route"), bifrostRouteLink("od:match:3183228"));
  assert.equal(u.searchParams.get("referer"), "https://oddzilla.cc/match/1315935");
  assert.equal(u.searchParams.get("customDomain"), "oddzilla.cc");
  assert.equal(u.searchParams.get("theme"), "light");
  assert.equal(u.searchParams.get("token"), "");
  assert.equal(u.searchParams.get("q"), "42");
  assert.equal(e.origin, BIFROST_EMBED_ORIGIN);
});

test("auto and dark themes both map to dark; language defaults to en", () => {
  const dark = new URL(
    buildBifrostEmbed({ apiKey: "k", matchUrn: "od:match:1", refererUrl: "r", storefrontHost: "h", theme: "auto" }).url,
  );
  assert.equal(dark.searchParams.get("theme"), "dark");
  assert.equal(dark.searchParams.get("lang"), "en");
});

test("the config message switches to non-betting mode AND navigates to the match in one go", () => {
  const e = buildBifrostEmbed({
    apiKey: "k",
    matchUrn: "od:match:3183228",
    refererUrl: "r",
    storefrontHost: "h",
  });
  const msg = JSON.parse(e.configMessage) as { type: string; data: { nonBetting: boolean; route: string } };
  assert.equal(msg.type, "CONFIG");
  assert.equal(msg.data.nonBetting, true);
  assert.equal(msg.data.route, bifrostRouteLink("od:match:3183228"));
});
