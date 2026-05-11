// k6 — anonymous storefront browsing.
//
// Simulates N concurrent visitors who land on the storefront without
// logging in: homepage SSR → sport page SSR → one match detail page →
// dwell on the match. Repeats. No login, no /bets, no /wallet — the
// public surface only.
//
// Why anonymous-first: validates the SSR replica fan-out (web1/web2/web3
// behind Caddy) and the catalog API throughput without coupling it to
// the auth / session-cache / wallet path. Once the SSR ceiling is
// understood, run authed-storefront.js next.
//
// Run from anywhere with network reach to oddzilla.cc.
//
//   # Smoke (50 VUs for 30 s)
//   k6 run -e BASE_URL=https://oddzilla.cc \
//     --vus 50 --duration 30s \
//     tests/load/anonymous-storefront.js
//
//   # Full ramp (default stages — peaks at 5000 VUs)
//   k6 run -e BASE_URL=https://oddzilla.cc \
//     tests/load/anonymous-storefront.js
//
//   # Custom peak VUs (override the ramping-vus stages target)
//   k6 run -e BASE_URL=https://oddzilla.cc -e PEAK_VUS=1000 \
//     tests/load/anonymous-storefront.js

import http from "k6/http";
import { check, group, sleep, fail } from "k6";
import { randomItem } from "https://jslib.k6.io/k6-utils/1.4.0/index.js";

const BASE = __ENV.BASE_URL || "https://oddzilla.cc";
const PEAK_VUS = Number(__ENV.PEAK_VUS || 5000);
const RAMP_S = Number(__ENV.RAMP_S || 180);
const HOLD_S = Number(__ENV.HOLD_S || 180);
const RAMP_DOWN_S = Number(__ENV.RAMP_DOWN_S || 60);

// Three milestone targets so we can read the breaking point off the
// summary even when peak VUs is far above where the system tips.
const stage = (frac, t) => ({ duration: `${Math.round(t)}s`, target: Math.round(PEAK_VUS * frac) });

export const options = {
  discardResponseBodies: true,
  scenarios: {
    storefront: {
      executor: "ramping-vus",
      startVUs: 0,
      stages: [
        stage(0.2, RAMP_S / 3),
        stage(0.6, RAMP_S / 3),
        stage(1.0, RAMP_S / 3),
        { duration: `${HOLD_S}s`, target: PEAK_VUS },
        { duration: `${RAMP_DOWN_S}s`, target: 0 },
      ],
      gracefulRampDown: "30s",
    },
  },
  thresholds: {
    // Generous to start — refine after the first run shows where the
    // realistic p95 sits. >2% errors = consider the run a failure.
    http_req_failed: ["rate<0.02"],
    http_req_duration: ["p(95)<3000"],
    "http_req_duration{name:homepage}": ["p(95)<3000"],
    "http_req_duration{name:sport}": ["p(95)<3000"],
    "http_req_duration{name:match}": ["p(95)<3000"],
    "http_req_duration{name:catalog_api}": ["p(95)<1500"],
  },
};

// Pre-fetch the catalog once so every iteration picks a real match id
// instead of hard-coding stale ones. If the prefetch fails the test
// aborts — there's no point measuring SSR throughput against a 500.
export function setup() {
  // Override the global discardResponseBodies for this one request —
  // we need to parse the catalog JSON to populate the match-id pool.
  const r = http.get(`${BASE}/api/catalog/sports/cs2`, {
    tags: { name: "catalog_api" },
    responseType: "text",
  });
  if (r.status !== 200) {
    fail(`prefetch /api/catalog/sports/cs2 returned ${r.status} — aborting`);
  }
  const body = JSON.parse(r.body);
  const matches = (body.matches || []).map((m) => String(m.id));
  if (matches.length === 0) {
    fail("no cs2 matches returned by catalog — nothing to dwell on");
  }
  return { matches, sports: ["cs2", "dota2", "lol", "valorant"] };
}

export default function (data) {
  group("homepage", () => {
    const r = http.get(BASE + "/", { tags: { name: "homepage" } });
    check(r, { "homepage 2xx": (x) => x.status >= 200 && x.status < 300 });
  });
  sleep(1 + Math.random() * 2);

  const sport = randomItem(data.sports);
  group("sport page", () => {
    const r = http.get(`${BASE}/sport/${sport}`, { tags: { name: "sport" } });
    check(r, { "sport 2xx": (x) => x.status >= 200 && x.status < 300 });
  });
  sleep(2 + Math.random() * 3);

  const matchId = randomItem(data.matches);
  group("match detail", () => {
    const r = http.get(`${BASE}/match/${matchId}`, { tags: { name: "match" } });
    check(r, { "match 2xx": (x) => x.status >= 200 && x.status < 300 });
  });

  // Dwell on the match (a real user reads the odds, considers a bet).
  // 10 ± 5 s simulates realistic scroll-and-think before the next click.
  sleep(8 + Math.random() * 6);
}
