# services/ws-gateway

Browser WebSocket fanout. TS / `ws` + `ioredis` on Node 22.

**Phase 1:** accepts WS on `/ws` and emits a hello message.
**Phase 4 (current):** JWT verified during HTTP upgrade (`oddzilla_access`
cookie) — authenticated clients additionally subscribe to a private
`user:{userId}` Redis channel for ticket frames. Anonymous clients
(missing or invalid cookie) are accepted and receive only the public
`odds:match:{id}` fan-out, which is the same data SSR already serves
to logged-out visitors. Per-client subscription table; Redis pub/sub
refcounted fanout; subscription cap 100 matches per client; healthz
reports connected clients, subscription counts, heap usage and
outbound-buffer stats.

Outbound odds fanout is **not** rate-limited (the old 5 msg/s token
bucket was removed in `c005882` — dropping price ticks is not
acceptable in a sportsbook). It is bounded by memory instead: see
`WS_MAX_BUFFERED_BYTES` under Invariants.

## Run

```bash
pnpm --filter @oddzilla/ws-gateway dev
```

`:3002` inside Compose. Caddy proxies `/ws*` → this service.

## Protocol (phase 4 target)

Client → server:
```json
{"type":"subscribe","matchIds":["42","43"]}
{"type":"unsubscribe","matchIds":["42"]}
```

Server → client:
```json
{"type":"odds","matchId":"42","marketId":"101","providerMarketId":4,
 "specifiers":{"map":"1"},"status":1,
 "outcomes":[{"outcomeId":"1","odds":"1.85","active":true}],
 "ts":1700000000000}

{"type":"match_status","matchId":"42","status":"live"}
{"type":"ticket","ticketId":"...","status":"accepted"}
```

Source of truth on reconnect is Postgres (`market_outcomes.published_odds`),
not replay from WS.

## Invariants

- Auth is best-effort on upgrade. Anonymous clients are allowed for the
  public odds fan-out only; the `user:{id}` Redis subscription is gated
  on a valid JWT, so a logged-out browser can never receive another
  user's ticket frames.
- **A socket's identity is fixed at upgrade time.** The cookie is read
  once and never re-read, so a socket opened while logged out stays
  anonymous for its whole life and never joins `user:{id}`. The
  storefront reconciles this and reconnects on a mismatch
  (`apps/web/src/lib/ws-session-sync.tsx`); any UI waiting on a
  `user:{id}` frame needs a transport-independent fallback too, since a
  reconnect lands anonymous whenever the access cookie has expired.
- **Outbound buffering is capped, not rated.** `ws.send()` queues
  in-process when a consumer stops draining, so one wedged socket can
  accumulate the entire feed in this process's heap — growth tracks feed
  volume, not client count. Every fan-out send goes through
  `sendToClient()`, which terminates a socket past
  `WS_MAX_BUFFERED_BYTES` (default 1 MiB). Terminating is safe because
  Postgres is the source of truth on reconnect; silently skipping frames
  would leave that client quoting a stale price with no signal. Four
  OOM kills on 2026-09-03 came from the unbounded version.
- Never trust message payloads from clients — JSON-schema validate.
