# Bifrost backup feed

Backup path for odds, scores, fixtures and settlements when Oddin's AMQP
feed or REST meta API is down. Sourced from **Bifrost**, Oddin's own
white-label esports front end — the iframe behind `maxbet.rs/en/esport`.
Oddin asked for this on 2026-09-03 and authorised Oddzilla to use MaxBet's
brand key (Bifrost client 101, "MaxBet RS").

Service: [`services/bifrost-feed`](../services/bifrost-feed/). Consumers:
`feed-ingester` and `settlement` through the `oddin.backup` Redis stream.
Fixture fallback: `feed-ingester/internal/bifrost`. Risk tier: manual
assignment on `/admin/tournaments` (migration `0094`).

## 1. What Bifrost is, and what it exposes

`https://www.maxbet.rs/en/esport` is MaxBet's Angular shell with one
`#bifrost` div. `https://bifrost.oddin.gg/script.js` injects an iframe
pointing at `https://bifrost.oddin.gg/?brandToken=<key>&lang=en&...`; the
iframe is a Next.js app (v1.28.0 at the time of writing) using Apollo
GraphQL. MaxBet holds no esports data of its own.

| Item | Value |
| --- | --- |
| Queries / mutations | `POST https://api-bifrost.oddin.gg/main/bifrost/query` |
| Subscriptions | `wss://api-bifrost.oddin.gg/main/bifrost/query?apiKey=<key>&t=<ms>`, subprotocol `graphql-transport-ws` |
| Auth | `X-Api-Key: <brand key>` (also in `connection_init` payload). `Origin` must be a host the key is registered for (`https://bifrost.oddin.gg` works). |
| Other headers the front end sends | `X-Locale` (drives names), `x-sbi` (any UUID; a browser-session marker), `X-Display-Resolution` |
| Introspection | disabled (`__schema` answers "internal error"; an unknown field is HTTP 422) |
| Schema source | the front end's own bundle. All 66 operations with fragments: [`docs/fixtures/bifrost-operations.graphql`](./fixtures/bifrost-operations.graphql) |
| Handshake | `connection_ack` echoes `client: {id: 101, name: "MaxBet RS", has_bifrost: true, has_obb: true, has_disir: true}` |
| Oddzilla's Disir brand token | rejected with 401 `permission denied` — Bifrost is a separate entitlement |

### Ids are Oddin URNs

Every id is base64 of a slash-joined path whose second segment is an Oddin URN:

```
match/od:match:3139010
market/od:match:3139010/2/2-handicap=-1.5
outcome/od:match:3139010/2/2-handicap=-1.5/1
market/od:match:3139010/6|variant=way:two|map=2/6-map=2|variant=way:two|way=two
team/od:competitor:1655   tournament/od:tournament:14611   sport/od:sport:2
```

The market path is `<group key>/<market_id>-<specifiers>`; the specifiers
are already in Oddin's `k=v|k=v` form with keys sorted, i.e. the canonical
form [`packages/types/src/specifiers.ts`](../packages/types/src/specifiers.ts)
hashes. A Bifrost outcome therefore maps onto a `market_outcomes` row with
no lookup table (`bifrost.ParseOutcomeID`).

### Operations the backup uses

| Operation | Role |
| --- | --- |
| `allMatch(first, after, sportType: ESPORTS, historic, sort: DATE, dateFrom, dateTo)` | list the active offer (154 matches on 2026-09-03) or the results list (about two months deep on this brand); dates must be full RFC 3339 |
| `match(id, historic)` | full detail: every market group, market, outcome; teams, tournament, sport, streams, score |
| `onUpdateMatchLive(matchId, withInit: true)` | same detail on every change, init snapshot first; works for NOT_STARTED, STARTED and CLOSED |
| `onMatchStateChanged` | one global stream: new fixtures, kick-offs, closes, start-time and stream changes |

Verified load: 50 subscriptions on one socket returned 50 snapshots plus
631 deltas (about 1 MB) in 35 s; a full match fetch is 150–275 ms and up
to 184 markets; 154 subscriptions on one socket ran clean in the dry run.

### Enumerations observed

| Field | Values |
| --- | --- |
| match `state` | `NOT_STARTED`, `STARTED`, `CLOSED`. **No cancelled value**: a cancelled event so far appears as `CLOSED` with every market removed (od:match:3120374, 2026-08-26). |
| market `state` | `OPEN`, `SUSPENDED`, `CLOSED` |
| outcome `status` | `OPEN`, `SUSPENDED`, `INACTIVE` (pulled before settlement, never resolved), `WON`, `LOST`, `HALF_WON`, `HALF_LOST`, `VOIDED` (in the bundle; not yet seen live) |
| `simpleScore.periodType` | `MAP`, `HALF`, `QUARTER`, `INNING` |

Settled markets stay on the historic match for at least 14 days (checked
at 1, 3, 5, 7, 10, 14 days). Odds matched our feed exactly on a prematch
comparison (1.95 / 1.78 both sides). No probabilities, no risk tier.

## 2. Architecture

```
                 ┌──────────────── standby unless the primary is silent ────────────────┐
Bifrost ──wss──► bifrost-feed ──► translate (Oddin XML) ──► Redis stream `oddin.backup` ─┤
                     ▲                                                                   ├─► feed-ingester  odds_change, fixture_change
                     │ gate reads                                                        └─► settlement     bet_settlement
feed-ingester ──SET──► Redis `feed:primary:last_msg_unix`   (every AMQP delivery, ≤1/s)

feed-ingester automap: REST fixture ──fails──► Bifrost `match` query ──► same oddinxml.FixtureResponse
```

**Why re-synthesise Oddin XML instead of writing tables.** feed-ingester
and settlement already enforce every invariant that matters (specifier
canonicalisation, sticky terminal market status, apply-once settlement,
the full-outcome-set diff, live-score capture, round history). Feeding
them byte-compatible `odds_change` / `bet_settlement` documents means the
backup inherits all of it and the money path has exactly one
implementation. The consumers cannot tell which transport a message came
from except by the routing key `bifrost.backup` in logs and
`feed_messages`.

**Gate and the operator switch.** Two inputs, both in Redis. The
backoffice switch `feed:source` (`PUT /admin/feed/source`, the **Feed
source** control on `/admin/feed`, audit-logged) selects `auto` (default),
`prod` (backup never publishes) or `backup` (backup forced); when unset,
the env default `BIFROST_MODE` applies (`auto` / `active` / `off`). In
auto, the gate publishes only when feed-ingester's liveness stamp
`feed:primary:last_msg_unix` is older than `BIFROST_TAKEOVER_AFTER_SECONDS`
(45 s; the alive watchdog suspends the catalogue at 20 s, so the backup
always arrives after the suspend, never racing it) and stands down the
instant the stamp is fresh. Both sides are asymmetric on purpose: slow to
take over, immediate to yield.

**Forced backup is a real source switch.** feed-ingester polls the same
key: on `→ backup` it keeps the AMQP connection (so the transport still
stamps liveness and the alive watchdog does not re-suspend what the backup
re-activates) but acks every delivery without applying it, suspends the
active catalogue once, and acknowledges with `feed:source:flushed_unix`.
bifrost-feed activates only after that acknowledgement (15 s ceiling for a
feed-ingester that is itself down), so its full re-emit lands on the clean
slate and the flush can never wipe it. On `backup →` feed-ingester runs
the same flush + 24 h replay an AMQP reconnect does and then resumes
applying AMQP. Settlement is deliberately outside the switch: it consumes
both sources always, because apply-once makes that safe and cancel /
rollback messages exist only on AMQP. A restart while forced to backup
adopts the key without a flush.

**Activation.** Every cached snapshot is re-emitted, so the suspended
catalogue re-activates in one pass instead of waiting for each match's
next natural update, and a 24 h results sweep settles whatever our DB
still holds open. While active, every resync (5 min) re-emits again and
sweeps 3 h of results, with the 24 h pass every sixth resync — this bounds
how long anything that suspends the catalogue underneath the backup (the
alive watchdog firing during a forced window, an operator recovery) stays
dark.

### Translation

| Bifrost | Oddin XML |
| --- | --- |
| match `NOT_STARTED` / `STARTED` / `CLOSED` | `<sport_event_status status="0 / 1 / 4">`; `product` 1 for NOT_STARTED, else 2 |
| market `OPEN` / `SUSPENDED` | `<market status="1 / -1">` |
| market `CLOSED` | omitted from `odds_change`; candidate for `bet_settlement` |
| outcome `OPEN` | `active="1"` with `odds` |
| outcome `SUSPENDED` / `INACTIVE` / terminal | `active="0"` (last price kept where present) |
| `WON` / `LOST` | `result="1" / "0"` |
| `HALF_WON` / `HALF_LOST` | `result="1" / "0"` with `void_factor="0.5"` |
| `VOIDED` | `result="0" void_factor="1"` (full refund via `mapOutcomeResult` → `void`) |
| `probabilities` | `1/odds` normalised by the market's overround (two-way 1.95 / 1.78 → 0.4775 / 0.5225; Oddin's own feed carried 0.48 / 0.52) |
| `simpleScore.periods` | `<period_scores>`; per-sport family fills `home_won_rounds` (CS2, CS2 Duels, Valorant, Rainbow Six, Crossfire), `home_kills` (Dota 2, Dota 2 Duels, LoL, King of Glory, MLBB, Arena of Valor, Wild Rift, Deadlock) or `home_goals` (eFootball, FIFA); other sports carry `home_score` only. The live period (`activePeriodIdx`, STARTED only) gets `match_status_code="6"` and fills `<scoreboard>`. |
| `datePlannedStart` change | `<fixture_change change_type="2" start_time=…>`; feed-ingester re-fetches the fixture (REST, then Bifrost) |

Pure functions in
[`services/bifrost-feed/internal/translate`](../services/bifrost-feed/internal/translate/),
unit-tested by decoding the output with copies of the consumer-side structs.

### Settlement is a comparison, not a log

A `bet_settlement` is emitted for a market when **Bifrost shows it CLOSED
with every offered outcome terminal** *and* **our Postgres still has it at a
non-terminal status** (`dbstate.OpenMarkets`, one indexed query per match).
No in-memory "already sent" set is authoritative; a per-activation cache
only avoids re-querying a busy live match. Consequences:

- Restart, reconnect, missed frame: the next snapshot re-derives the same
  answer.
- The primary settled it first: our DB shows `-3`, nothing is emitted.
- The primary comes back and replays the same settlement: the settlement
  service's `InsertIfNew` dedups on the canonical payload hash; even when
  the hash differs (Oddin's specifier string order, extra INACTIVE
  outcomes), the outcome cascade and per-ticket settle are idempotent
  (`WHERE result IS NULL`, `status='accepted'` gates), so a second row is
  harmless.
- Every `BIFROST_RESYNC_INTERVAL_SECONDS` the runner sweeps the last three
  hours of Bifrost results and settles anything our DB still holds open,
  and every sixth resync (plus every activation) widens that to 24 h: the
  path that heals a market which closed while both feeds, or the whole
  stack, were down. Only matches our DB holds open are fetched in full, so
  the wide pass costs list pages, not detail fetches.

`certainty` is 1 while the match is STARTED, 2 once CLOSED.

### Fixture metadata without the REST meta API

`automap.Resolver.fetchFixtureAny` tries REST and, on any failure, asks
Bifrost's `match` query and reshapes it into the same
`oddinxml.FixtureResponse` (sport, tournament, competitors with URNs,
start time, state, streams). Team icons seed `competitor_profiles` when
the REST profile is unavailable. The sport abbreviation Oddin's REST
carries is approximated by the name without spaces (so the bot-sport
blocklist still matches `eFootballBots`).

## 3. Recovery interplay with the primary

Bifrost has no cursor and no replay; every connect is a full snapshot, so
it needs no recovery of its own. The interesting moment is the hand-back:

1. AMQP reconnects → feed-ingester's `OnConnect` runs the unconditional
   flush (suspend everything) and asks Oddin for a 24 h replay.
2. The first delivery stamps the liveness key → the gate stands down within
   two seconds. A few seconds of overlap can exist between the flush and
   the first replayed message; the backup's prices in that window are the
   same Oddin prices, and the replay overwrites them.
3. Oddin's replay re-activates markets and re-sends settlements; dedup as
   above. `BumpAfterTs` from backup-sourced `odds_change` is irrelevant
   because the flush rewinds the cursor to the full 24 h window anyway.
4. Rollbacks or corrections Oddin issued *during* the outage arrive with
   the replay and apply normally (the settlement service reverses and
   re-applies). Rollbacks that happened **and were superseded** inside the
   outage window, with the primary never coming back to replay them, are
   the one class this design cannot see (section 4).

The watchdog stays in its "suspended once" state while the backup is
active; it does not re-suspend until AMQP data resumes and goes silent
again.

## 4. Known gaps (deliberate, tracked)

| Gap | Status |
| --- | --- |
| **`bet_cancel` and `rollback_*` are not synthesised.** Bifrost has no cancel state or rollback event; a cancelled event appears as CLOSED with markets removed, and a rollback would appear as a terminal status reverting to OPEN. | **Deferred by the operator on 2026-09-03; to be solved later.** Needs Oddin to confirm the intended representation. Until then a market Oddin cancels during a backup window stays open on our side; the stranded-ticket reconciler and admin manual void are the fallbacks. |
| Probabilities are derived from odds. | Accepted: margin-normalised implied probability, chosen by the operator. Cashout and the fair-odds clamp see values within ~0.01 of Oddin's on two-way books. |
| Tournament risk tier is not on Bifrost. | Accepted: manual assignment on `/admin/tournaments` with a lock (migration 0094) so the REST refresh never overwrites it. |
| Markets MaxBet hides from its Bifrost are not fed. | Accepted: such markets simply stay suspended from the watchdog flush, which is the safe direction. |
| `matches.status` for a CLOSED match with zero markets is not moved by the backup. | The settlement service's all-markets-terminal close covers the settled case; the "cancelled look-alike" falls under the first row. |
| Payload hash of a backup settlement can differ from Oddin's. | Harmless double `settlements` row; every downstream write is idempotent. |

## 5. Runbook

**Enable.** Put the key in `.env` on the box (`sed -i` a single key,
never `cat .env`), keep `BIFROST_MODE=auto`, `make deploy`. Check:

```bash
curl -s http://127.0.0.1:8086/healthz | jq .gate,.feed.connected,.feed.trackedMatches
```

and the **Backup feed (Bifrost)** card on `/admin/feed`: primary alive,
backup standby, socket connected as "MaxBet RS", tracked ≈ the active offer.

**Force a failover** (drill or planned Oddin outage): click **Backup
Oddin** in the Feed source control on `/admin/feed` and confirm. The card
shows `arming` while feed-ingester flushes, then ACTIVE (forced by
switch); `oddsChangesPublished` climbs. Click **Auto** afterwards;
feed-ingester replays from Oddin. No restart.

**Disable in a hurry:** click **Prod Oddin only** (backup never publishes),
or `BACKUP_STREAM_ENABLED=false` on feed-ingester and settlement to stop
consuming without touching the producer.

**Long outage of the whole stack (hours):** nothing manual. Oddin's 24 h
replay rebuilds both consumers on reconnect; if the backup is active, its
24 h results sweep settles what the DB still holds open. Only cancels and
rollbacks depend on the AMQP replay window.

**Verify a takeover happened:** feed-ingester logs `feed silent past
threshold` (watchdog), then bifrost-feed logs `backup ACTIVE` and
`re-emitting every cached match snapshot`; `feed_messages` rows for the
window carry routing key `bifrost.backup`.

**Eyeball the translation without infrastructure:**

```bash
cd services/bifrost-feed && BIFROST_API_KEY=... go run ./cmd/bifrost-feed -dry-run -dry-run-seconds 90
```

Dry run on 2026-09-03: 154 matches subscribed, 749 frames in 75 s, 312
`odds_change`, 2 `bet_settlement` (9 markets), no errors.

**Key revoked:** bifrost-feed logs `Bifrost rejected the api key` and
retries every 60 s; the card shows the socket disconnected. The catalogue
stays suspended, which is the safe state.

## 6. Research tooling

The catalogue of operations was pulled from the front end's JavaScript
bundle (`_next/static/chunks/*.js`), where every document is a template
literal; introspection is disabled. The standalone probes used for the
2026-09-03 assessment (a Python GraphQL runner and two graphql-ws
subscription scripts) lived in a scratchpad and were superseded by the
service's own `-dry-run` mode, which exercises the exact production code
path.
