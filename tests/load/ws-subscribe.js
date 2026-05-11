// k6 — long-lived WebSocket subscriptions to ws-gateway.
//
// What this tests: how many concurrent WS clients ws-gateway holds
// while odds frames are being pushed (5 msg/s/client cap per CLAUDE.md
// invariants). Each VU connects, subscribes to a handful of matches,
// and holds the socket open for HOLD_S seconds. Combined with one of
// the storefront tests running in parallel, this matches the real
// shape of traffic: every user reads SSR pages AND keeps a WS open.
//
// Run from a separate terminal in parallel with anonymous- /
// authed-storefront.js, or run alone.
//
//   # Hold 5000 WS connections for 5 minutes
//   k6 run -e WS_URL=wss://oddzilla.cc/ws -e PEAK_VUS=5000 \
//     -e HOLD_S=300 tests/load/ws-subscribe.js
//
// Cookies: anonymous WS is supported (ws-gateway accepts unauthed
// upgrades, see services/ws-gateway/src/server.ts). To test authed
// WS (user:{id} channel + ticket frames), set COOKIES_PATH and the
// script will attach the access cookie per VU.

import ws from "k6/ws";
import http from "k6/http";
import { check, fail } from "k6";
import { randomItem } from "https://jslib.k6.io/k6-utils/1.4.0/index.js";

const BASE = __ENV.BASE_URL || "https://oddzilla.cc";
const WS_URL = __ENV.WS_URL || "wss://oddzilla.cc/ws";
const PEAK_VUS = Number(__ENV.PEAK_VUS || 5000);
const RAMP_S = Number(__ENV.RAMP_S || 120);
const HOLD_S = Number(__ENV.HOLD_S || 300);
const SUBSCRIPTIONS_PER_VU = Number(__ENV.SUBSCRIPTIONS_PER_VU || 5);
const COOKIES_PATH = __ENV.COOKIES_PATH;

const COOKIES = COOKIES_PATH ? JSON.parse(open(COOKIES_PATH)) : null;

export const options = {
  scenarios: {
    ws_hold: {
      executor: "ramping-vus",
      startVUs: 0,
      stages: [
        { duration: `${RAMP_S}s`, target: PEAK_VUS },
        { duration: `${HOLD_S}s`, target: PEAK_VUS },
        { duration: "30s", target: 0 },
      ],
      gracefulRampDown: "15s",
    },
  },
  // ws_connecting is the duration of the initial upgrade. ws_msgs_received
  // counts every frame from the server (mostly odds:match:{id} pushes).
  thresholds: {
    ws_connecting: ["p(95)<2000"],
    ws_session_duration: [`p(95)>${(HOLD_S - 5) * 1000}`],
  },
};

export function setup() {
  const r = http.get(`${BASE}/api/catalog/sports/cs2`, { responseType: "text" });
  if (r.status !== 200) fail(`prefetch returned ${r.status}`);
  const body = JSON.parse(r.body);
  const matches = (body.matches || []).map((m) => String(m.id));
  if (matches.length < SUBSCRIPTIONS_PER_VU) {
    fail(`only ${matches.length} matches available; need ${SUBSCRIPTIONS_PER_VU}`);
  }
  return { matches };
}

function pickMatches(all, n) {
  const out = [];
  const seen = new Set();
  while (out.length < n) {
    const m = randomItem(all);
    if (seen.has(m)) continue;
    seen.add(m);
    out.push(m);
  }
  return out;
}

export default function (data) {
  const params = { tags: { name: "ws_subscribe" } };
  if (COOKIES) {
    const c = COOKIES[(__VU - 1) % COOKIES.length];
    params.headers = {
      Cookie: `oddzilla_access=${c.access}; oddzilla_refresh=${c.refresh}`,
    };
  }

  const matchIds = pickMatches(data.matches, SUBSCRIPTIONS_PER_VU);

  const res = ws.connect(WS_URL, params, function (socket) {
    socket.on("open", () => {
      socket.send(JSON.stringify({ type: "subscribe", matchIds }));
    });

    // Periodic ping so the gateway sees the connection as alive even
    // if no odds frame lands for a while.
    socket.setInterval(() => socket.send(JSON.stringify({ type: "ping" })), 30_000);

    // Hold for the requested duration. setTimeout returns control to k6
    // once it fires, ws.connect resolves and the iteration ends.
    socket.setTimeout(() => socket.close(), HOLD_S * 1000);

    socket.on("error", (e) => {
      // Best-effort — log only. Disconnect under load is real signal,
      // not a test failure on its own.
      // eslint-disable-next-line no-console
      console.warn(`ws error vu=${__VU}: ${e?.error?.()}`);
    });
  });

  check(res, { "ws status 101": (r) => r && r.status === 101 });
}
