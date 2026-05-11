// k6 — POST /bets load test for the 250-bettor max-load scenario.
//
// Two market-selection patterns:
//   concentrated  — every bet goes to the SAME match / market / outcome
//                   (real-world "popular team" pattern: every bettor backs
//                   the favourite in the match-winner market).
//   spread        — each bet picks a random (market, outcome, odds) tuple
//                   from a 1000-entry pre-fetched pool.
//
// Two execution shapes (k6 scenarios — see the scenarios block):
//   burst      — 100 bets in 1 s, one bet per VU, 100 distinct users.
//   sustained  — 12.5 bets/s for 2 min (~1500 bets), spread across 100 VUs.
//                Each VU = one user; round-robin via __VU - 1 cookie index.
//
// Pick one via SCENARIO env var. Example:
//   k6 run -e SCENARIO=concentrated_burst \
//          -e BASE_URL=https://oddzilla.cc tests/load/place-bets.js
//
// Required env:
//   SCENARIO=<concentrated_burst|concentrated_sustained|spread_burst|spread_sustained>
//   BASE_URL=https://oddzilla.cc
//   COOKIES_PATH=./loadtest-cookies.json   (default)
//   POOL_PATH=./spread-pool.json           (default)
//
// Authentication: pre-baked oddzilla_access cookies + Origin header so the
// CSRF gate (Origin must match CORS_ORIGINS) passes.

import http from "k6/http";
import { check } from "k6";
import { Counter, Trend } from "k6/metrics";
import { randomItem } from "https://jslib.k6.io/k6-utils/1.4.0/index.js";

const BASE = __ENV.BASE_URL || "https://oddzilla.cc";
const SCENARIO = __ENV.SCENARIO || "concentrated_burst";
const COOKIES_PATH = __ENV.COOKIES_PATH || "./loadtest-cookies.json";
const POOL_PATH = __ENV.POOL_PATH || "./spread-pool.json";

// Pinned target for the concentrated scenario: B8 vs BetBoom (live CS2),
// match-winner market 48190822, outcome "1" (home), current odds 1.75.
// These values come from the recon SQL the operator ran before the test.
// The api re-validates odds drift at placement so a small movement is fine;
// a big move puts that one selection on odds_drift_exceeded for the rest
// of the run, which itself is informative.
const HOT_MARKET_ID = __ENV.HOT_MARKET_ID || "48190822";
const HOT_OUTCOME_ID = __ENV.HOT_OUTCOME_ID || "1";
const HOT_ODDS = __ENV.HOT_ODDS || "1.75";

const STAKE_MICRO = __ENV.STAKE_MICRO || "1000000"; // 1.0 OZ per bet
const CURRENCY = "OZ";

const cookies = JSON.parse(open(COOKIES_PATH));
const pool = JSON.parse(open(POOL_PATH));
if (!Array.isArray(cookies) || cookies.length === 0) {
  throw new Error("no cookies loaded from " + COOKIES_PATH);
}
if (!Array.isArray(pool) || pool.length === 0) {
  throw new Error("no pool entries from " + POOL_PATH);
}

const rejects = new Counter("placement_rejects");
const accepts = new Counter("placement_accepts");
const fivexx = new Counter("placement_5xx");
const latency = new Trend("placement_latency_ms", true);

function buildSelections() {
  if (SCENARIO.startsWith("concentrated_")) {
    return [{ marketId: HOT_MARKET_ID, outcomeId: HOT_OUTCOME_ID, odds: HOT_ODDS }];
  }
  const item = randomItem(pool);
  return [{ marketId: item.marketId, outcomeId: item.outcomeId, odds: item.odds }];
}

function uuidv4() {
  // RFC 4122 v4
  const bytes = new Uint8Array(16);
  for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const h = [];
  for (let i = 0; i < 16; i++) h.push(bytes[i].toString(16).padStart(2, "0"));
  return `${h.slice(0,4).join("")}-${h.slice(4,6).join("")}-${h.slice(6,8).join("")}-${h.slice(8,10).join("")}-${h.slice(10,16).join("")}`;
}

// One scenario file used by all four runs; pick via SCENARIO env. k6 only
// executes scenarios whose `exec` matches an exported function name, so
// we name them and gate via `executor: { ... }` per case below.
const scenarios = {
  concentrated_burst: {
    executor: "constant-arrival-rate",
    exec: "placeBet",
    rate: 100,
    timeUnit: "1s",
    duration: "1s",
    preAllocatedVUs: 100,
    maxVUs: 100,
    tags: { scenario: "concentrated_burst" },
  },
  concentrated_sustained: {
    executor: "constant-arrival-rate",
    exec: "placeBet",
    rate: 12,
    timeUnit: "1s",
    duration: "2m",
    preAllocatedVUs: 100,
    maxVUs: 100,
    tags: { scenario: "concentrated_sustained" },
  },
  spread_burst: {
    executor: "constant-arrival-rate",
    exec: "placeBet",
    rate: 100,
    timeUnit: "1s",
    duration: "1s",
    preAllocatedVUs: 100,
    maxVUs: 100,
    tags: { scenario: "spread_burst" },
  },
  spread_sustained: {
    executor: "constant-arrival-rate",
    exec: "placeBet",
    rate: 12,
    timeUnit: "1s",
    duration: "2m",
    preAllocatedVUs: 100,
    maxVUs: 100,
    tags: { scenario: "spread_sustained" },
  },
};

const chosen = scenarios[SCENARIO];
if (!chosen) {
  throw new Error("unknown SCENARIO: " + SCENARIO + " (expected one of " + Object.keys(scenarios).join(", ") + ")");
}

export const options = {
  scenarios: { [SCENARIO]: chosen },
  // No global thresholds — let the report show natural latency.
  // We still want a non-zero failure budget so the run does not abort
  // on a couple of 4xx feed-related rejections.
};

export function placeBet() {
  // __VU is 1-based. Wrap modulo cookies.length so over-allocated VUs reuse.
  const cookie = cookies[(__VU - 1) % cookies.length];
  const body = JSON.stringify({
    stakeMicro: STAKE_MICRO,
    currency: CURRENCY,
    idempotencyKey: uuidv4(),
    selections: buildSelections(),
  });
  const headers = {
    "content-type": "application/json",
    "origin": "https://oddzilla.cc",
    "cookie": "oddzilla_access=" + cookie.access,
  };
  const t0 = Date.now();
  const res = http.post(`${BASE}/api/bets`, body, { headers, tags: { name: "place_bet" } });
  latency.add(Date.now() - t0);

  if (res.status === 200 || res.status === 201) {
    accepts.add(1);
  } else if (res.status >= 500) {
    fivexx.add(1);
    rejects.add(1);
  } else {
    rejects.add(1);
  }

  check(res, {
    "status is 200/201": (r) => r.status === 200 || r.status === 201,
    "response has ticket id": (r) => {
      try {
        const j = JSON.parse(r.body);
        return j && j.ticket && j.ticket.id;
      } catch (_e) {
        return false;
      }
    },
  });
}

export function handleSummary(data) {
  // Compact text summary to stdout. Full json goes to stderr if requested.
  const lat = (data.metrics.placement_latency_ms && data.metrics.placement_latency_ms.values) || {};
  const acc = (data.metrics.placement_accepts && data.metrics.placement_accepts.values && data.metrics.placement_accepts.values.count) || 0;
  const rej = (data.metrics.placement_rejects && data.metrics.placement_rejects.values && data.metrics.placement_rejects.values.count) || 0;
  const fix = (data.metrics.placement_5xx && data.metrics.placement_5xx.values && data.metrics.placement_5xx.values.count) || 0;
  const reqs = (data.metrics.http_reqs && data.metrics.http_reqs.values && data.metrics.http_reqs.values.count) || 0;
  const failures = (data.metrics.http_req_failed && data.metrics.http_req_failed.values && data.metrics.http_req_failed.values.rate) || 0;
  const summary = [
    "",
    "=== " + SCENARIO + " ===",
    `requests:        ${reqs}`,
    `accepts (2xx):   ${acc}`,
    `rejects (non2xx):${rej}  (of which 5xx: ${fix})`,
    `http_req_failed: ${(failures * 100).toFixed(2)} %`,
    `latency p50:     ${(lat["p(50)"] || 0).toFixed(0)} ms`,
    `latency p95:     ${(lat["p(95)"] || 0).toFixed(0)} ms`,
    `latency p99:     ${(lat["p(99)"] || 0).toFixed(0)} ms`,
    `latency max:     ${(lat.max || 0).toFixed(0)} ms`,
    `latency avg:     ${(lat.avg || 0).toFixed(0)} ms`,
    "",
  ].join("\n");
  return {
    "stdout": summary,
  };
}
