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
| AMQP port | **5672** (AMQPS / TLS — counterintuitive: Oddin runs TLS on the plain-AMQP port; `5671` is closed at the ELB) |
| Virtual host | `/oddinfeed/{customer_id}` — note the leading slash is part of the vhost NAME (URL-encode to `%2Foddinfeed%2F{id}`); get `customer_id` from `GET /v1/users/whoami` (the legacy `/users/whoami` returns 404) |
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

> **Vhost URL trap.** Go's `net/url.URL.Path` is the *decoded* path —
> writing `url.PathEscape("/oddinfeed/142")` into `Path` gets re-escaped on
> serialization, turning `%2F` into `%252F` and producing
> `Exception (403) "no access to this vhost"`. We hand-assemble the dial
> URL with `fmt.Sprintf` in `services/{feed-ingester,settlement}/internal/amqp/consumer.go`.

## Routing keys (topic-8 format)

Oddin uses an 8-section dot-separated routing key:

```
{priority}.{pre}.{live}.{message_type}.{sport}.{urn}.{event_id}.{node_id}
```

- `priority`: `hi` / `lo` / `-`
- `pre`: `pre` / `-`
- `live`: `live` / `-`
- `message_type`: `odds_change`, `bet_settlement`, `bet_cancel`, `fixture_change`,
  `match_status_change`, `bet_stop`, `alive`, `snapshot_complete`,
  `rollback_bet_settlement`, `rollback_bet_cancel`
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
void bets placed within the window. `void_reason_id` (1 = not played,
4 = suspended, 5 = other) for audit.

Per Oddin docs §2.4.4, the time-window combinations have specific
semantics — implemented in `services/settlement/internal/settler/settler.go`:

| Window | Bets voided | Market status |
| --- | --- | --- |
| neither | all bets on the market | → `-4` (cancelled) |
| `start_time` only | bets placed AT/AFTER `start_time` | → `-4` |
| `end_time` only | bets placed AT/BEFORE `end_time` | unchanged (active) |
| both | bets placed within `[start_time, end_time]` | unchanged (active) |

If a `bet_cancel` arrives for a market that's **already settled**, there
will be no preceding `rollback_bet_settlement`. Per the docs the cancel
must be applied as if a rollback had already happened. Our worker
implements this in `applyMarketCancel` → `reverseSettledForCancel`:
reverse each settled ticket inside the window first (compensating
`adjustment` ledger row), then void the selections, then re-settle as
void to refund the stake.

### `rollback_bet_settlement` / `rollback_bet_cancel`

Reverse a prior settle or cancel. Our settlement worker inserts a
compensating `settlements` row and reverses the ledger entries, resetting
`tickets.status='accepted'` and `ticket_selections.result=NULL`. Each
ticket's compensating `adjustment` ledger row uses the same `ref_id` as
the `bet_payout` it's reversing (see "Ledger generation suffix" below).

### `match_status_change`

Announces a transition in the match's lifecycle status. Sparsely emitted
in practice — many matches end without one ever arriving — so we treat it
as a fast path on top of the periodic REST drain rather than the
authoritative source.

- `event_id` — `od:match:1234`
- `product` — `1` or `2`
- `timestamp` — ms
- `status` — numeric code per Sportradar UOF (Oddin's
  `GET /v1/descriptions/en/match_status`); see
  `oddinxml.MapMatchStatusCode`:

| Code | Meaning | Mapped to |
| --- | --- | --- |
| 0 | NotStarted | `not_started` |
| 1 | Live | `live` |
| 2 | Suspended | `suspended` |
| 3 | Ended (awaiting confirm) | `closed` |
| 4 | Closed | `closed` |
| 5 | Cancelled | `cancelled` |
| 6 | Delayed | `live` (still expected to play) |
| 7 | Interrupted | `suspended` |
| 8 | Postponed | `not_started` (rescheduled) |
| 9 | Abandoned | `cancelled` |

Unknown codes leave `matches.status` untouched. The hourly
`runPhantomDrainTicker` (see CLAUDE.md "Recovery flow") catches any match
that ended without a `match_status_change` message.

### `alive`

Every 10s. Carries `subscribed="0"` when the producer is down. Triggers
in our handler (`handler.handleAlive`):

1. `subscribed=0` → trigger recovery for that producer (via
   `POST /v1/{product}/recovery/initiate_request`).
2. Consecutive timestamps drift by more than 5s (target interval is 10s)
   → trigger recovery for that producer (`AliveState.observe`).

### `snapshot_complete`

Returned after a snapshot recovery REST call. Marks end of the catch-up.
Update `amqp_state.after_ts` to the `timestamp` in this message.

## REST endpoints we use

| Purpose | Method + path | Used in |
| --- | --- | --- |
| customer id / vhost | `GET /v1/users/whoami` | bootstrap to discover `bookmaker_id` for the AMQP vhost path |
| sport-event fixture (sport + tournament + competitors) | `GET /v1/sports/en/sport_events/{matchURN}/fixture` | auto-mapping resolver on first sight of an unknown match URN; fixture_change re-fetch on NEW/DATE_TIME/FORMAT/COVERAGE |
| sports list | `GET /v1/sports/en/sports` | resolver helper |
| **recovery initiate** | `POST /v1/{product}/recovery/initiate_request?after={ms}&request_id={n}&node_id={n}` | feed-ingester on every (re)connect for both pre + live; also on `alive subscribed=0` and on alive-timestamp drift > 5s |
| recovery snapshot (per fixture) | `GET /v1/descriptions/en/fixtures/{fixture_id}/odds/{product_id}/{after_ts}` | not currently used — the broader `initiate_request` endpoint above handles our recovery flow |
| sports tree (legacy) | `GET /v1/descriptions/en/sports` | available; not currently called |
| tournaments per sport | `GET /v1/sports/en/sports/{id}/tournaments` | available; not currently called |
| tournament info | `GET /v1/sports/en/tournaments/{id}/info` | available; not currently called |
| fixtures (paginated) | `GET /v1/descriptions/en/fixtures?offset=N&limit=200` | available; not currently called |
| market descriptions | `GET /v1/descriptions/en/markets` | available; not currently called |
| match status codes | `GET /v1/descriptions/en/match_status` | available; not currently called |
| producers | `GET /v1/descriptions/producers` | available; not currently called |

Rate limits: 25k req/min overall. Recovery endpoints have stricter tiers
based on how far back `after_ts` is (see Oddin docs § 3.18).

> **Path quirk.** The whoami endpoint at `/users/whoami` (no `/v1/`) used
> to work and is referenced in older Oddin docs; the current integration
> environment returns 404 there. Always use `/v1/users/whoami`.

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

Implemented in `services/feed-ingester/internal/handler/handler.go`
(`TriggerRecovery`, `triggerRecoveryForProduct`) and wired in
`services/feed-ingester/cmd/feed-ingester/main.go` `runAMQP`'s OnConnect
hook. Triggers:

- Every AMQP (re)connect (both producers).
- `alive subscribed=0` (per-producer).
- `alive` consecutive-timestamp drift > 5s (per-producer).

Each trigger does:

1. `ReadAfterTs(producer:N)` — read the cursor from `amqp_state`.
2. `POST /v1/{product}/recovery/initiate_request?after={ms}&request_id={rand}&node_id={ODDIN_NODE_ID}`
   — Oddin replays since the cursor over AMQP.
3. Replays arrive over AMQP and end with `snapshot_complete`, which our
   existing handler bumps the cursor on.

Rate limits per Oddin docs § 3.18: recoveries < 30 min are lenient
(20/10min, 60/hr); > 1 day are strict (2/30min, 4/2hr). Our recovery
fires at most once per (re)connect or alive-anomaly, so we comfortably
stay under both tiers.

## Auto-mapping

When an unknown match URN arrives on the feed, `automap.Resolver`
(`services/feed-ingester/internal/automap/resolver.go`):

1. Calls `GET /v1/sports/en/sport_events/{matchURN}/fixture` to fetch the
   full hierarchy in one shot.
2. Upserts `sport` (keyed by `provider_urn` like `od:sport:19`), an "auto"
   `category` under that sport, the `tournament`, then the `match` — so
   the `tournament_id` FK is always satisfied before the matches insert.
3. Inserts a `mapping_review_queue` row for everything created so admins
   can rename / re-categorize later.

Failures (404 on the fixture endpoint, network errors) fall back to a
per-sport "Unknown tournament" placeholder under the configured
fallback sport's auto category. The most common 404 source is outright
markets — the routing key carries `od:tournament:N` and the `/sport_events/`
endpoint only handles match URNs. Outright support is post-MVP.

`Resolver.RefreshFromFixture(matchURN)` is the same flow but only
applies updates to existing matches; called from the fixture_change
handler on change_types NEW (1), DATE_TIME (2), FORMAT (4), and
COVERAGE (5).

## Ledger generation suffix (re-settle support)

When Oddin sends `settle → rollback → re-settle (different result)`,
each settle credits the wallet but the ledger insert was being silently
dropped by the `(type, ref_type, ref_id)` partial-unique index. We now
suffix `ref_id` with `:N` (generation number) on the second and later
settles for the same ticket — see `nextPayoutRefID` and
`LatestUnreversedPayoutRefID` in `services/settlement/internal/store/store.go`.

So a ticket that goes through three settle/rollback cycles ends up with:

```
type='bet_stake'    ref_id='T'    delta=-stake
type='bet_payout'   ref_id='T'    delta=+P1
type='adjustment'   ref_id='T'    delta=-P1     (rollback 1)
type='bet_payout'   ref_id='T:2'  delta=+P2
type='adjustment'   ref_id='T:2'  delta=-P2     (rollback 2)
type='bet_payout'   ref_id='T:3'  delta=+P3     (final settle)
```

Sum across the ticket: `P3 - stake` — exactly the user's net change.

## Handover sweeper

Markets stuck at `status=-2` (handed over from pre-match to live) for
more than 60s get demoted to `status=-1` (suspended) by a 15-second
ticker in `feed-ingester` (`runHandoverSweeper`). Per Oddin docs §1.4,
"if you do not receive live odds within a reasonable time after
receiving the handed over state, consider this as an error and suspend
all markets". Anchor: `markets.last_oddin_ts`.

## Gotchas

- **Handover limbo.** When a match goes pre-match → live, the pre-match
  producer sends `status=-2`. If live odds don't arrive within 60s, our
  sweeper flips to `-1` (suspended). Don't leave UI showing `-2`.
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
