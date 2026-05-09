# services/ws-gateway

Browser WebSocket fanout. TS / `ws` + `ioredis` on Node 22.

**Phase 1:** accepts WS on `/ws` and emits a hello message.
**Phase 4 (current):** JWT verified during HTTP upgrade (`oddzilla_access`
cookie) — authenticated clients additionally subscribe to a private
`user:{userId}` Redis channel for ticket frames. Anonymous clients
(missing or invalid cookie) are accepted and receive only the public
`odds:match:{id}` fan-out, which is the same data SSR already serves
to logged-out visitors. Per-client subscription table; Redis pub/sub
refcounted fanout; 5 msg/s/client token bucket (capacity 5, refill
200 ms); subscription cap 100 matches per client; healthz reports
connected clients + subscription count.

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
- Rate cap (5 msg/s/client) protects the box from runaway fanout.
- Never trust message payloads from clients — JSON-schema validate.
