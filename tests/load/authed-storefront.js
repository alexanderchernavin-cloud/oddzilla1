// k6 — authenticated storefront browsing.
//
// Same shape as anonymous-storefront.js plus:
//   - Pre-baked cookies from tests/load/loadtest-cookies.json (one per
//     user; see packages/db/src/bake-loadtest-cookies.ts). Each VU
//     gets one user via `__VU - 1`.
//   - Adds /bets and /account/wallet hits because those are the routes
//     a logged-in user touches that an anonymous visitor doesn't.
//   - Forces a unique x-request-id per iteration so the operator can
//     correlate a slow request back to the exact VU + iteration if
//     needed.
//
// Why pre-baked cookies: POST /auth/login is rate-limited 5/min/IP,
// which kills any test driving real logins from a single source. The
// bake script mints sessions directly in the DB + signs JWTs with the
// JWT_SECRET — running it requires prod-box access exactly once before
// the test. The cookies are valid for 2h by default, plenty for any
// realistic ramp + hold window.
//
//   # Smoke (50 VUs for 30 s)
//   k6 run -e BASE_URL=https://oddzilla.cc \
//     --vus 50 --duration 30s \
//     tests/load/authed-storefront.js
//
//   # Full ramp (default stages — peaks at 5000 VUs)
//   k6 run -e BASE_URL=https://oddzilla.cc \
//     tests/load/authed-storefront.js

import http from "k6/http";
import { check, group, sleep, fail } from "k6";
import { randomItem } from "https://jslib.k6.io/k6-utils/1.4.0/index.js";

const BASE = __ENV.BASE_URL || "https://oddzilla.cc";
const PEAK_VUS = Number(__ENV.PEAK_VUS || 5000);
const RAMP_S = Number(__ENV.RAMP_S || 180);
const HOLD_S = Number(__ENV.HOLD_S || 180);
const RAMP_DOWN_S = Number(__ENV.RAMP_DOWN_S || 60);
const COOKIES_PATH = __ENV.COOKIES_PATH || "tests/load/loadtest-cookies.json";

// Loaded once at parse time (init context), reused across all VUs.
// k6's `open()` reads a file from the host running the test.
const COOKIES = JSON.parse(open(COOKIES_PATH));
if (!Array.isArray(COOKIES) || COOKIES.length === 0) {
  throw new Error(`empty/invalid cookies file at ${COOKIES_PATH}`);
}

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
    http_req_failed: ["rate<0.02"],
    http_req_duration: ["p(95)<3000"],
    "http_req_duration{name:homepage}": ["p(95)<3000"],
    "http_req_duration{name:sport}": ["p(95)<3000"],
    "http_req_duration{name:match}": ["p(95)<3000"],
    "http_req_duration{name:bets}": ["p(95)<3000"],
    "http_req_duration{name:wallet_api}": ["p(95)<1500"],
    "http_req_duration{name:me_api}": ["p(95)<1500"],
  },
};

export function setup() {
  const r = http.get(`${BASE}/api/catalog/sports/cs2`);
  if (r.status !== 200) fail(`prefetch /api/catalog/sports/cs2 returned ${r.status}`);
  const body = JSON.parse(r.body);
  const matches = (body.matches || []).map((m) => String(m.id));
  if (matches.length === 0) fail("no cs2 matches returned");
  return { matches, sports: ["cs2", "dota2", "lol", "valorant"] };
}

function cookieFor(vu) {
  // __VU starts at 1. Distribute round-robin so the cookie set can be
  // smaller than the VU count if needed (each user just gets reused).
  return COOKIES[(vu - 1) % COOKIES.length];
}

function buildHeaders(c, iter) {
  // Refresh cookie carried for the silent-refresh path; access is the
  // working credential. x-request-id is per-iteration unique so a
  // server log can be tied back to exactly one VU + iteration.
  return {
    Cookie: `oddzilla_access=${c.access}; oddzilla_refresh=${c.refresh}`,
    "x-request-id": `loadtest-vu${__VU}-it${iter}`,
  };
}

export default function (data) {
  const c = cookieFor(__VU);
  const headers = buildHeaders(c, __ITER);

  group("me", () => {
    const r = http.get(`${BASE}/api/auth/me`, { headers, tags: { name: "me_api" } });
    check(r, { "me 200": (x) => x.status === 200 });
  });

  group("homepage", () => {
    const r = http.get(BASE + "/", { headers, tags: { name: "homepage" } });
    check(r, { "homepage 2xx": (x) => x.status >= 200 && x.status < 300 });
  });
  sleep(1 + Math.random() * 2);

  const sport = randomItem(data.sports);
  group("sport page", () => {
    const r = http.get(`${BASE}/sport/${sport}`, { headers, tags: { name: "sport" } });
    check(r, { "sport 2xx": (x) => x.status >= 200 && x.status < 300 });
  });
  sleep(2 + Math.random() * 3);

  const matchId = randomItem(data.matches);
  group("match detail", () => {
    const r = http.get(`${BASE}/match/${matchId}`, { headers, tags: { name: "match" } });
    check(r, { "match 2xx": (x) => x.status >= 200 && x.status < 300 });
  });
  sleep(8 + Math.random() * 6);

  group("bets page", () => {
    const r = http.get(`${BASE}/bets`, { headers, tags: { name: "bets" } });
    check(r, { "bets 2xx": (x) => x.status >= 200 && x.status < 300 });
  });
  sleep(1);

  group("wallet api", () => {
    const r = http.get(`${BASE}/api/wallet`, { headers, tags: { name: "wallet_api" } });
    check(r, { "wallet 200": (x) => x.status === 200 });
  });
  sleep(2 + Math.random() * 4);
}
