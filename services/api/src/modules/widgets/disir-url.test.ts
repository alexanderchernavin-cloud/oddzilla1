import { test } from "node:test";
import assert from "node:assert/strict";

import {
  DISIR_SPORTS,
  DISIR_SPORT_PARAMS,
  buildMatchWidgetUrl,
  buildScoreboardWidgetUrl,
  buildTournamentWidgetUrl,
  encodeDisirId,
  inspectIssuedUrl,
  parseLearnedSegment,
  parseSportParams,
  reasonAllowsLocalFallback,
  staticSegment,
  staticSportParams,
} from "./disir-url.js";

// Every expected string below is a URL the REST actually issued on
// 2026-09-16, with the brand token replaced by a placeholder and the
// cache-buster fixed. The builder has to reproduce them byte for byte:
// an off-by-one in key order or encoding is a URL the widget host may
// still accept today and silently stop accepting tomorrow.
const TOKEN = "00000000-0000-4000-8000-000000000000";

test("match widget: byte-identical to the URL api-disir issued for a CS2 match", () => {
  const url = buildMatchWidgetUrl({
    env: "integration",
    brandToken: TOKEN,
    sport: DISIR_SPORT_PARAMS.cs2!,
    matchUrn: "od:match:3204741",
    homeTeamUrn: "od:competitor:22610",
    awayTeamUrn: "od:competitor:550",
    tournamentUrn: "od:tournament:14894",
    theme: "dark",
    t: 710791072,
  });
  assert.equal(
    url,
    "https://disir.integration.oddin.gg/csgo/match?availableData=tournament&availableData=teams&availableData=players" +
      "&awayTeamId=dGVhbS9vZDpjb21wZXRpdG9yOjU1MA%3D%3D" +
      `&brandToken=${TOKEN}&darkMode=true` +
      "&homeTeamId=dGVhbS9vZDpjb21wZXRpdG9yOjIyNjEw" +
      "&id=bWF0Y2gvb2Q6bWF0Y2g6MzIwNDc0MQ%3D%3D" +
      "&lang=en&layout=default&t=710791072&theme=dark&timeframe=THREE_MONTHS" +
      "&tournamentId=dG91cm5hbWVudC9vZDp0b3VybmFtZW50OjE0ODk0&type=teams",
  );
});

test("match widget: eSim shape with allowClose, as Bifrost's own front end receives it", () => {
  // Captured from Bifrost's `matchStatistics` query on the MaxBet page —
  // same URL grammar, different sport constants, plus allowClose=true.
  const url = buildMatchWidgetUrl({
    env: "main",
    brandToken: TOKEN,
    sport: DISIR_SPORT_PARAMS.efootball!,
    matchUrn: "od:match:3207884",
    homeTeamUrn: "od:competitor:8407",
    awayTeamUrn: "od:competitor:3518",
    tournamentUrn: "od:tournament:14836",
    theme: "dark",
    allowClose: true,
    t: 4271573016,
  });
  assert.equal(
    url,
    "https://disir.oddin.gg/rush_soccer/match?allowClose=true&availableData=stats&availableData=ranking" +
      "&awayTeamId=dGVhbS9vZDpjb21wZXRpdG9yOjM1MTg%3D" +
      `&brandToken=${TOKEN}&darkMode=true` +
      "&homeTeamId=dGVhbS9vZDpjb21wZXRpdG9yOjg0MDc%3D" +
      "&id=bWF0Y2gvb2Q6bWF0Y2g6MzIwNzg4NA%3D%3D" +
      "&lang=en&layout=default&t=4271573016&theme=dark&timeframe=TWO_MONTHS" +
      "&tournamentId=dG91cm5hbWVudC9vZDp0b3VybmFtZW50OjE0ODM2&type=stats",
  );
});

test("tournament widget: byte-identical to the issued URL", () => {
  const url = buildTournamentWidgetUrl({
    env: "main",
    brandToken: TOKEN,
    segment: "csgo",
    tournamentUrn: "od:tournament:14894",
    theme: "dark",
    t: 2837816524,
  });
  assert.equal(
    url,
    `https://disir.oddin.gg/csgo/tournament?availableData=tournament&brandToken=${TOKEN}&darkMode=true` +
      "&id=dG91cm5hbWVudC9vZDp0b3VybmFtZW50OjE0ODk0&lang=en&layout=default&t=2837816524&theme=dark",
  );
});

test("scoreboard widget: byte-identical, including the empty layout key", () => {
  const url = buildScoreboardWidgetUrl({
    env: "main",
    brandToken: TOKEN,
    segment: "dota2",
    matchUrn: "od:match:3195873",
    theme: "dark",
    t: 521590887,
  });
  assert.equal(
    url,
    `https://disir.oddin.gg/dota2/scoreboard?brandToken=${TOKEN}&darkMode=true` +
      "&id=bWF0Y2gvb2Q6bWF0Y2g6MzE5NTg3Mw%3D%3D&lang=en&layout=&t=521590887&theme=dark",
  );
});

test("theme, language, tab and timeframe overrides land where the REST puts them", () => {
  const url = new URL(
    buildMatchWidgetUrl({
      env: "integration",
      brandToken: TOKEN,
      sport: DISIR_SPORT_PARAMS.lol!,
      matchUrn: "od:match:1",
      homeTeamUrn: "od:competitor:2",
      awayTeamUrn: "od:competitor:3",
      tournamentUrn: "od:tournament:4",
      theme: "light",
      language: "es",
      tab: "players",
      timeframe: "ONE_MONTH",
      t: 1,
    }),
  );
  assert.equal(url.host, "disir.integration.oddin.gg");
  assert.equal(url.pathname, "/lol/match");
  assert.equal(url.searchParams.get("darkMode"), "false");
  assert.equal(url.searchParams.get("theme"), "light");
  assert.equal(url.searchParams.get("lang"), "es");
  assert.equal(url.searchParams.get("type"), "players");
  assert.equal(url.searchParams.get("timeframe"), "ONE_MONTH");
  assert.equal(url.searchParams.has("allowClose"), false);
});

test("auto theme maps to the REST's dark default", () => {
  const url = new URL(
    buildScoreboardWidgetUrl({
      env: "integration",
      brandToken: TOKEN,
      segment: "csgo",
      matchUrn: "od:match:1",
      theme: "auto",
      t: 1,
    }),
  );
  assert.equal(url.searchParams.get("darkMode"), "true");
  assert.equal(url.searchParams.get("theme"), "dark");
});

test("cache-buster is a uint32 when not fixed", () => {
  const url = new URL(
    buildScoreboardWidgetUrl({
      env: "integration",
      brandToken: TOKEN,
      segment: "csgo",
      matchUrn: "od:match:1",
    }),
  );
  const t = Number(url.searchParams.get("t"));
  assert.ok(Number.isInteger(t) && t >= 0 && t < 2 ** 32, `t=${t}`);
});

test("ids are plain base64 of kind/urn, matching Bifrost's id grammar", () => {
  assert.equal(
    Buffer.from(encodeDisirId("match", "od:match:3204741"), "base64").toString(),
    "match/od:match:3204741",
  );
  assert.equal(
    Buffer.from(encodeDisirId("team", "od:competitor:550"), "base64").toString(),
    "team/od:competitor:550",
  );
});

test("inspectIssuedUrl learns the sport constants from a clean match issue", () => {
  const facts = inspectIssuedUrl(
    "https://disir.integration.oddin.gg/rush_basketball/match?availableData=stats&availableData=ranking" +
      `&awayTeamId=x&brandToken=${TOKEN}&darkMode=true&homeTeamId=y&id=z&lang=en&layout=default` +
      "&t=1&theme=dark&timeframe=TWO_MONTHS&tournamentId=w&type=stats",
    { requestHadTab: false, requestHadTimeframe: false },
  );
  assert.deepEqual(facts, {
    kind: "match",
    segment: "rush_basketball",
    sport: {
      segment: "rush_basketball",
      availableData: ["stats", "ranking"],
      timeframe: "TWO_MONTHS",
      type: "stats",
    },
  });
});

test("inspectIssuedUrl refuses to learn defaults from a request that overrode them", () => {
  const url =
    "https://disir.integration.oddin.gg/csgo/match?availableData=tournament&availableData=teams" +
    "&availableData=players&timeframe=ONE_MONTH&type=players";
  const withTab = inspectIssuedUrl(url, { requestHadTab: true, requestHadTimeframe: false });
  const withTimeframe = inspectIssuedUrl(url, { requestHadTab: false, requestHadTimeframe: true });
  assert.equal(withTab?.sport, null);
  assert.equal(withTab?.segment, "csgo");
  assert.equal(withTimeframe?.sport, null);
});

test("inspectIssuedUrl reports the segment for scoreboard and tournament issues", () => {
  const sb = inspectIssuedUrl("https://disir.oddin.gg/dota2/scoreboard?id=x&t=1", {
    requestHadTab: false,
    requestHadTimeframe: false,
  });
  assert.deepEqual(sb, { kind: "scoreboard", segment: "dota2", sport: null });
  assert.equal(inspectIssuedUrl("https://disir.oddin.gg/dota2/other?id=x", { requestHadTab: false, requestHadTimeframe: false }), null);
  assert.equal(inspectIssuedUrl("not a url", { requestHadTab: false, requestHadTimeframe: false }), null);
  assert.equal(inspectIssuedUrl("https://disir.oddin.gg/", { requestHadTab: false, requestHadTimeframe: false }), null);
});

test("parseSportParams accepts a learned record and rejects junk", () => {
  const good = parseSportParams(
    JSON.stringify({ segment: "csgo", availableData: ["teams"], timeframe: "THREE_MONTHS", type: "teams" }),
  );
  assert.deepEqual(good, { segment: "csgo", availableData: ["teams"], timeframe: "THREE_MONTHS", type: "teams" });
  assert.equal(parseSportParams(null), null);
  assert.equal(parseSportParams("garbage"), null);
  assert.equal(parseSportParams(JSON.stringify({ segment: "csgo" })), null);
  assert.equal(parseSportParams(JSON.stringify({ segment: "../evil", availableData: ["x"], timeframe: "a", type: "b" })), null);
  assert.equal(parseSportParams(JSON.stringify({ segment: "csgo", availableData: [], timeframe: "a", type: "b" })), null);
});

test("only issuer-down failures may fall back; a 404 or our own bad params never do", () => {
  assert.equal(reasonAllowsLocalFallback("network"), true);
  assert.equal(reasonAllowsLocalFallback("timeout"), true);
  assert.equal(reasonAllowsLocalFallback("unauthorized"), true);
  assert.equal(reasonAllowsLocalFallback("upstream_error"), true);
  assert.equal(reasonAllowsLocalFallback("malformed"), true);
  assert.equal(reasonAllowsLocalFallback("missing_url"), true);
  assert.equal(reasonAllowsLocalFallback("not_found"), false);
  assert.equal(reasonAllowsLocalFallback("invalid_params"), false);
});

test("the static sport table covers exactly the esports the REST issues widgets for", () => {
  // Every sport with any widget has a segment ...
  assert.deepEqual(Object.keys(DISIR_SPORTS).sort(), [
    "cs2",
    "dota2",
    "ebasketball",
    "ecricket",
    "efootball",
    "lol",
    "valorant",
  ]);
  for (const e of Object.values(DISIR_SPORTS)) assert.match(e.segment, /^[a-z0-9_]+$/);
  // ... and the prematch view drops the live-only one.
  assert.deepEqual(Object.keys(DISIR_SPORT_PARAMS).sort(), [
    "cs2",
    "dota2",
    "ebasketball",
    "efootball",
    "lol",
    "valorant",
  ]);
  for (const p of Object.values(DISIR_SPORT_PARAMS)) {
    assert.match(p.segment, /^[a-z0-9_]+$/);
    assert.ok(p.availableData.length > 0);
  }
});

test("ecricket has a live scoreboard segment and no prematch widget", () => {
  // Measured 2026-09-16: /live/integration/scoreboard/od:match:3205940
  // issued https://disir.oddin.gg/rush_cricket/scoreboard?..., while the
  // prematch endpoint answers 404 for every ecricket match.
  assert.equal(staticSegment("ecricket"), "rush_cricket");
  assert.equal(staticSportParams("ecricket"), null);
  assert.equal(staticSegment("cs2"), "csgo");
  assert.equal(staticSportParams("cs2")?.segment, "csgo");
  assert.equal(staticSegment("rocketleague"), null);
  assert.equal(staticSportParams("rocketleague"), null);
});

test("live scoreboard for a live-only sport builds from the segment alone", () => {
  const url = buildScoreboardWidgetUrl({
    env: "integration",
    brandToken: TOKEN,
    segment: staticSegment("ecricket")!,
    matchUrn: "od:match:3205940",
    theme: "dark",
    t: 3439491905,
  });
  assert.equal(
    url,
    `https://disir.integration.oddin.gg/rush_cricket/scoreboard?brandToken=${TOKEN}&darkMode=true` +
      "&id=bWF0Y2gvb2Q6bWF0Y2g6MzIwNTk0MA%3D%3D&lang=en&layout=&t=3439491905&theme=dark",
  );
});

test("parseLearnedSegment accepts a path segment and nothing else", () => {
  assert.equal(parseLearnedSegment("rush_cricket"), "rush_cricket");
  assert.equal(parseLearnedSegment(null), null);
  assert.equal(parseLearnedSegment(""), null);
  assert.equal(parseLearnedSegment("../x"), null);
  assert.equal(parseLearnedSegment("csgo/match"), null);
});
