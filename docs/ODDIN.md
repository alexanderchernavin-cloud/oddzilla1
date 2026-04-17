# Oddin.gg integration

Practical cheat sheet for integrating with Oddin on the **protocol level**
(raw AMQP + REST, no SDK). Source docs live at `D:\AI\newrok\Oddin\` (Odds
Feed API documentation + Market Specification). This file captures the
decisions we've already made for our stack.

## Connection parameters

| Thing | Value |
| --- | --- |
| AMQP host (integration) | `mq.integration.oddin.gg` |
| AMQP host (production) | `mq.oddin.gg` |
| AMQP port | 5671 (AMQPS / TLS) |
| Virtual host | `/oddinfeed/{customer_id}` — get `customer_id` from `GET /users/whoami` |
| AMQP user | the Oddin access token |
| AMQP password | empty string |
| Exchange | `oddinfeed` (topic) |
| Queue | server-named, exclusive, non-durable, auto-delete |
| Binding key | `#` (all) or a narrowed topic-8 pattern |
| REST base (integration) | `https://api-mq.integration.oddin.gg` |
| REST base (production) | `https://api-mq.oddin.gg` |
| REST auth header | `x-access-token: <token>` |
| Concurrent AMQP conns allowed | 10 |

Messages are XML, not JSON. Timestamps are milliseconds since epoch.

## Routing keys (topic-8 format)

Oddin uses an 8-section dot-separated routing key:

```
{priority}.{pre}.{live}.{message_type}.{sport}.{urn}.{event_id}.{node_id}
```

- `priority`: `hi` / `lo` / `-`
- `pre`: `pre` / `-`
- `live`: `live` / `-`
- `message_type`: `odds_change`, `bet_settlement`, `bet_cancel`, `fixture_change`,
  `bet_stop`, `alive`, `snapshot_complete`, `rollback_bet_settlement`,
  `rollback_bet_cancel`
- `sport`: numeric Oddin sport id
- `urn`: `od:match` / `od:tournament` / `-`
- `event_id`: the numeric id part of the URN, or `-`
- `node_id`: `-` or specific node id

Useful patterns:

| Pattern | Matches |
| --- | --- |
| `#` | everything |
| `*.*.live.#` | all live messages |
| `*.*.*.odds_change.#` | all odds updates |
| `*.*.*.bet_settlement.#` | all settlements |
| `-.-.-.#` | system messages (`alive`, `snapshot_complete`) |

## Message types we care about

### `odds_change`

High frequency (up to 200 msg/s/match during live). One or more markets with
their outcomes and odds. Key fields:

- `event_id` — `od:match:1234`
- `product` — `1` (pre-match) or `2` (live)
- `timestamp` — ms
- `market[] id="4" specifiers="map=1" status="1"` — market uniqueness is
  `(id, specifiers)`. We canonicalize specifiers (sorted `k=v|k=v`, sha256)
  to store in `markets.specifiers_hash`.
- `outcome[] id="1" odds="1.85" active="1"` — outcome id, decimal odds,
  active flag.

Market status codes:
- `1` — active, accepting bets
- `0` — inactive (hide, no bets)
- `-1` — suspended (no bets, up to 60s then error)
- `-2` — handed over (pre-match → live transition)
- `-3` — settled (only in `bet_settlement`)
- `-4` — cancelled (only in `bet_cancel`)

### `bet_settlement`

Indicates market(s) resolved. Carries outcome results for payout.

- `outcome.result` — `"1"` won / `"0"` lost
- `outcome.void_factor` — `"0.5"` half-won/lost (Asian handicap) / `"1.0"`
  full void

Settlement is per-(event, market, specifiers). May arrive as one message per
market or one message with many markets — our worker handles both the same
way via the `settlements` apply-once dedupe.

### `bet_cancel`

Void a market. Optional `start_time` / `end_time` (ms) windows selectively
void bets placed within the window. Absent window = void all bets.
`void_reason_id` (1 = not played, 4 = suspended, 5 = other) for audit.

### `rollback_bet_settlement` / `rollback_bet_cancel`

Reverse a prior settle or cancel. Our settlement worker inserts a
compensating `settlements` row and reverses the ledger entries, resetting
`tickets.status='accepted'` and `ticket_selections.result=NULL`.

### `alive`

Every 30s-ish. Monitor to detect producer down. Missing alives → trigger
recovery (snapshot REST call from `amqp_state.after_ts`).

### `snapshot_complete`

Returned after a snapshot recovery REST call. Marks end of the catch-up.
Update `amqp_state.after_ts` to the `timestamp` in this message.

## REST endpoints we use

| Purpose | Method + path |
| --- | --- |
| customer id / vhost | `GET /users/whoami` |
| sports tree | `GET /v1/descriptions/en/sports` |
| tournaments for a sport | `GET /v1/descriptions/en/tournaments/{sport_id}` |
| schedule for tournament | `GET /v1/descriptions/en/tournaments/{tournament_id}/schedule` |
| fixtures (paginated) | `GET /v1/descriptions/en/fixtures?offset=N&limit=200` |
| single match | `GET /v1/descriptions/en/fixtures/{fixture_id}` |
| **recovery snapshot** | `GET /v1/descriptions/en/fixtures/{fixture_id}/odds/{product_id}/{after_ts}` |
| market descriptions | `GET /v1/descriptions/en/markets` |
| match status codes | `GET /v1/descriptions/en/match_status` |
| producers | `GET /v1/descriptions/producers` |

Rate limits: 25k req/min overall. Recovery endpoints have stricter tiers
based on how far back `after_ts` is (see Oddin docs § 3.18).

## Markets we care about (Phase 1)

| Market | `provider_market_id` | Specifiers | Notes |
| --- | --- | --- | --- |
| Match Winner 2-way | `1` | none (or `variant=way:two`) | Home/away outcome `id="1"`/`"2"` |
| Map Winner 2-way | `4` | `map={1,2,3,...}` | Home/away outcome per map |

Per-game notes:

| Game | Specifier quirks | Score fields in `live_score` |
| --- | --- | --- |
| CS2 | `map=1..3` (BO3 standard). Map ends at 16 rounds. `period_score` updates after each map ends. | `home_won_rounds`, `away_won_rounds` per map |
| Valorant | `map=1..3`. Map ends at 13 rounds. Like CS2. | Same shape |
| Dota 2 | `map=1..5` (BO3 typical). No map-end signal; score updates live. | `home_kills`, `away_kills` |
| LoL | `map=1..5`. Score updates live. | `home_kills`, `away_kills`, `home_destroyed_turrets`, `away_destroyed_turrets` |

## Specifier canonicalization (invariant)

Both `feed-ingester` and `settlement` must produce byte-identical output for
the same specifier input. Algorithm:

1. Collect `{key: value}` pairs from the incoming `specifiers="…"` attribute,
   split on `|` then on first `=`.
2. Sort keys lexicographically.
3. Emit `k1=v1|k2=v2`.
4. sha256 → 32 bytes → store as `BYTEA`.

TS reference: [`packages/types/src/specifiers.ts`](../packages/types/src/specifiers.ts).
Go mirrors (duplicated per the per-service-module rule):
- `services/feed-ingester/internal/oddinxml/specifiers.go`
- `services/settlement/internal/oddinxml/specifiers.go`

All three are tested against the shared fixture
[`docs/fixtures/specifiers.json`](./fixtures/specifiers.json). Run
`pnpm --filter @oddzilla/types test` for the TS side; each Go package
has its own `specifiers_test.go`.

## Recovery protocol

On ingester startup or after an AMQP disconnect:

1. `SELECT after_ts FROM amqp_state WHERE key = '1'` (for pre-match) and
   `'2'` (for live).
2. For each producer, call
   `GET /v1/descriptions/en/fixtures/{fixture_id}/odds/{product_id}/{after_ts}`.
   (In practice we'd iterate over active fixtures; Oddin docs describe the
   exact flow.)
3. Apply all returned odds updates and settlement messages as if they were
   real-time.
4. Wait for the corresponding `snapshot_complete` message on AMQP.
5. Update `amqp_state.after_ts` to the snapshot timestamp.
6. Resume live consumption.

Rate-limit the recovery calls per Oddin's tiers: recoveries < 30 min ago are
lenient (20/10min, 60/hour); > 1 day are strict (2/30min, 4/2hour).

## Gotchas

- **Handover limbo.** When a match goes pre-match → live, the pre-match
  producer sends `status=-2`. If live odds don't arrive within ~60s, treat
  as error and suspend all markets. Don't leave UI showing -2.
- **XML quirks.** Some fields are HTML-entity-encoded (`&quot;`, `&lt;`).
  Decode before comparing. Timestamps are ms, not seconds.
- **Specifier order is arbitrary on the wire.** Always sort before hashing;
  don't compare raw `specifiers=` attributes across messages.
- **Dynamic outcomes (outrights).** Tournament-winner markets use
  `od:dynamic_outcomes:27|v1` style ids; versions bump when the outright
  roster changes. Don't cache outcome lists across versions. (Outrights are
  not in MVP scope; noted here for later.)
- **IP allowlist.** All AMQP and REST traffic is IP-whitelisted. The Hetzner
  box's outbound IP must be registered with Oddin before any call
  succeeds.
- **Token rotation.** Access tokens are valid 1 year; Oddin notifies 1
  month before expiry and issues a new one. Current `.env`-driven
  approach requires manual restart on rotation; auto-rotation is a
  pre-launch improvement.

## What we intentionally do not do

- **Use the Oddin Go SDK.** We re-implement AMQP + REST directly. Reason:
  fewer dependencies, full control over reconnect logic, and the SDK hides
  some of the quirks (recovery sequencing) we want explicit.
- **Deserialize via reflection.** Each message type has a dedicated struct
  with `encoding/xml` tags — faster and catches schema drift early.
- **Trust unknown entities blindly.** Unknown sport/tournament/match/market
  IDs are auto-created **and** queued in `mapping_review_queue` for admin
  review. Nothing goes live to users without an approved mapping row (Phase
  3 will enforce this gate).
