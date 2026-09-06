# Bifrost backup feed

> **Forced Backup means feed-ingester does not talk to Oddin's broker at
> all.** Since 2026-09-04 the AMQP consumer is gated by
> `amqp.Consumer.Paused` (wired to `feedSourceIsBackup`, re-checked every
> 2 s), so a forced Backup stops dialling instead of holding a connection
> whose deliveries are discarded. It logs the pause once, not once per
> retry. Switching back to `prod`/`auto` resumes the dial within a couple
> of seconds; `runSourceSwitch` still owns that switch-back's flush and
> replay request, and hands off to the reconnect's `OnConnect` through the
> `switchBackRecoveryDone` CAS so the pair is issued exactly once rather
> than twice.
>
> `services/settlement` keeps its own AMQP consumer running regardless —
> that is deliberate (dual-source always; apply-once makes it safe, and
> `bet_cancel` / `rollback_*` exist only on AMQP), so it will keep
> retrying and logging while Oddin's credentials are bad.

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

### One specifier value is not the AMQP feed's: `handicap`

**Bifrost states a handicap from the opposite side to Oddin's AMQP feed, so
`bifrost.NormalizeSpecifiers` flips its sign at parse time** — a Bifrost
`handicap=-1.5` becomes the `handicap=1.5` the AMQP feed would have sent.
`parseMarketSegment` is the only place a market key is built, so the
correction covers `odds_change` and `bet_settlement` in one step, and the
storefront needs nothing: it renders the line straight from the specifier
(home as-is, away negated), which is correct once the key is.

Measured on production 2026-09-04, before the fix: every backup-fed market
keyed `handicap=-1.5` priced the HOME outcome *shorter* than that same
team's moneyline. CS2 match 1163395 (Falcons vs G2) carried a 1.55
moneyline with "-1.5" at 1.15 and "+1.5" at 2.70 — and a -1.5 line can
never be shorter than the moneyline, so 1.15 was the +1.5 price wearing
the wrong label. Correct score agreed to two decimals: P(2:0) = 0.42
against the 2.70 cell, 1 - P(0:2) = 0.88 against the 1.15 one.

It is systematic, not per-market. Of the same-match ±1.5 pairs across all
nine handicap-bearing market ids (2, 11, 66, 88, 95, 96, 125, 132, 136 —
match scope and per-map), **100% inverted on the backup feed against 100%
standard on AMQP**, flipping on the day the source was switched:

```
2026-08-15 .. 09-02   standard: all   inverted: 0     (AMQP)
2026-09-03            standard: 24    inverted: 15    (switch at 16:02 UTC)
2026-09-04            standard: 0     inverted: 49    (backup)
```

Oddin's own AMQP feed shipped this same inversion from launch until
**2026-06-02** (April 626/626 inverted, May 2160/2160, clean from June 2),
so Bifrost appears to be serving the pre-fix convention. Worth raising
with Oddin — the durable fix is on their side.

**Why this had to be corrected at key level and not in the label.** Market
identity is `(match, provider_market_id, specifiers_hash)` and settlement
is dual-source by design, so an inverted key is not cosmetic: Oddin's
`bet_settlement` keeps arriving during a backup window and lands on the
row the backup feed priced. Of the 26 backup-era margin-1 (2:1 / 1:2)
±1.5 pairs settled before the fix, 19 were graded on the AMQP convention,
4 on Bifrost's, and 3 contradicted each other — i.e. a bettor taking
"-1.5" at 1.15 would mostly have been graded as a genuine -1.5. Only one
ticket (OZ demo, no handicap leg) was placed in that window, so no money
moved.

`handicap` is the only specifier key that ever carries a negative value
(checked against every live market row), so no other key needs this.

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

**Gate and the operator switch.** Two inputs. The backoffice switch is
the singleton Postgres row `feed_control` (migration 0095; `PUT
/admin/feed/source`, the **Feed source** control on `/admin/feed`,
audit-logged) and selects `auto` (default), `prod` (backup never
publishes) or `backup` (backup forced); when never set, the env default
`BIFROST_MODE` applies (`auto` / `active` / `off`). **It is in Postgres,
not Redis, after an incident on day one:** the first cut kept it in Redis
keys, production Redis is `maxmemory 256mb` + `allkeys-lru`, and this
service's own `oddin.backup` stream (MAXLEN 50 000 entries of up to 150 KB
each) filled Redis to its ceiling within an hour of forced Backup;
`allkeys-lru` then evicted the five `feed:source*` keys and the stream
itself, bifrost-feed read an empty switch and fell back to Auto, and
feed-ingester ran the switch-back flush + Oddin replay — the operator's
forced Backup was silently undone. The stream is now trimmed by time
(`XADD … MINID`, 60 s) so it cannot grow past tens of MB, and operator
state never touches Redis. In auto, the primary counts as alive while
EITHER of feed-ingester's two Redis stamps is fresh: `feed:primary:last_msg_unix` (every AMQP delivery, at
most once a second) or `feed:primary:connected_unix` (every 2 s with a
15 s TTL while the AMQP connection is open, deleted on disconnect). The
gate publishes only once both have been stale past
`BIFROST_TAKEOVER_AFTER_SECONDS` (45 s; the alive watchdog suspends the
catalogue at 20 s, so the backup always arrives after the suspend, never
racing it) and stands down the instant one is fresh. Both sides are
asymmetric on purpose: slow to take over, immediate to yield.

The connection stamp is there because deliveries alone gave a false
positive on the very first production restart (2026-09-03): feed-ingester's
OnConnect flush of ~10k markets took 76 s and Oddin's replay took another
80 s to start flowing, so the connection was open but delivery-free for
over two minutes; the backup took over at 46 s, re-fed 152 snapshots and
stood down 33 s later when data arrived — harmless (identical odds, no
settlements) but wrong. Every outage the backup exists for (token
revoked, broker unreachable, network partition) drops the connection and
therefore stops the stamp; a producer-side Oddin outage with the broker
still up does not, and for that case the alive watchdog still suspends the
catalogue and the operator can force **Backup Oddin** if Bifrost is still
serving.

**Manual positions never auto-revert** (operator decision 2026-09-03).
Only `auto` moves on its own. `backup` and `prod` stay where the operator
put them across restarts and deploys, and a forced `backup` keeps
publishing regardless of AMQP — including when Bifrost itself is down, in
which case the catalogue stays dark until the switch is moved. The
recovery weak spot in section 3 (REST down during an AMQP reconnect) is
accepted as-is: when Oddin's REST is down their broker is down too, and
the operator answer is the switch.

**Forced backup is a real source switch.** feed-ingester polls the same
row: on `→ backup` it keeps the AMQP connection (so the transport still
stamps liveness and the alive watchdog does not re-suspend what the backup
re-activates) but acks every delivery without applying it, suspends the
active catalogue once, and acknowledges with `feed_control.flushed_at`.
bifrost-feed activates only after that acknowledgement (15 s ceiling for a
feed-ingester that is itself down), so its full re-emit lands on the clean
slate and the flush can never wipe it; because the flush of a 10k-market
catalogue takes longer than the ceiling (76 s measured), the runner also
re-emits whenever a flush acknowledgement lands after it has started
publishing. On `backup →` feed-ingester runs
the same flush + 24 h replay an AMQP reconnect does and then resumes
applying AMQP. Settlement is deliberately outside the switch: it consumes
both sources always, because apply-once makes that safe and cancel /
rollback messages exist only on AMQP. A restart while forced to backup
adopts the key without a flush.

**Backup means Bifrost only, for the feed** (operator decision
2026-09-03). While the switch is on `backup`, no Oddin feed REST endpoint
is called from feed-ingester or settlement: the resolver's REST gate
(`Resolver.WithRESTGate`) sends fixture lookups straight to Bifrost and
skips tournament-info and competitor-profile fetches; the market
descriptions refresh, the competitor backfill and every recovery request
(`handler.Deps.RestAllowed`, settlement's OnConnect) are skipped; an AMQP
reconnect neither flushes nor replays. Labels come from Bifrost instead:
the translator puts the market group name on `<market name=…>` (an
attribute Oddin never sends; feed-ingester seeds `market_descriptions`
from it with `INSERT … DO NOTHING`) and the selection name on
`<outcome name=…>` (a real Oddin attribute; lands on
`market_outcomes.name`, and player URNs also seed `player_profiles`). The
storefront's label chain now falls back to that per-instance name for
competitor and player outcomes before the raw URN. The alive watchdog
switches to guarding bifrost-feed's status heartbeat and socket flag, so a
dead backup still suspends the catalogue after the same threshold.
Switching back re-enables REST, runs the flush + 24 h replay, and
immediately refreshes descriptions and competitor profiles so the skipped
metadata catches up; REST's `ON CONFLICT DO UPDATE` overwrites every seed.
Disir widgets, the Havik video player and OBB are api-side against other
Oddin hosts and are untouched.

**Activation.** Every cached snapshot is re-emitted, so the suspended
catalogue re-activates in one pass instead of waiting for each match's
next natural update, and a 72 h results sweep settles whatever our DB
still holds open (24 h until 2026-09-06 — see "Recovery interplay" for
why it widened). While active, every resync (5 min) re-emits again and
sweeps 3 h of results, with the 72 h pass every sixth resync — this bounds
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
| `handicap=-1.5` | `handicap=1.5` — sign flipped onto the AMQP convention at parse time (see "One specifier value is not the AMQP feed's") |

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
  and every sixth resync (plus every activation) widens that to 72 h: the
  path that heals a market which closed while both feeds, or the whole
  stack, were down. Only matches our DB holds open are fetched in full, so
  the wide pass costs list pages, not detail fetches. The wide window was
  24 h until 2026-09-06: the unplayed-map cancels ride this pass too, and a
  day was too short to reach the fixtures that had closed before the cancel
  path existed — 940 markets on the 09-05 matches were still waiting for a
  snapshot the 24 h window would never fetch again.

`certainty` is 1 while the match is STARTED, 2 once CLOSED.

### Fixture metadata without the REST meta API

`automap.Resolver.fetchFixtureAny` tries REST and, on any failure, asks
Bifrost's `match` query and reshapes it into the same
`oddinxml.FixtureResponse` (sport, tournament, competitors with URNs,
start time, state, streams). Team icons seed `competitor_profiles` when
the REST profile is unavailable. The sport abbreviation Oddin's REST
carries is approximated by the name without spaces (so the bot-sport
blocklist still matches `eFootballBots`).

### A failover empties the offer first

Switching into Backup, and now booting straight into Backup, both run
`store.FlushAndSuspendActiveCatalog` before the backup publishes anything:
every active market goes to `status=-1`, every outcome's odds are nulled,
and every `live` match goes to `status='suspended'`. The offer is empty
until Bifrost's re-emit rebuilds it, and whatever Bifrost does not carry
stays gone.

The match half matters as much as the market half. Suspending markets
alone left matches asserting `live` with nothing able to walk the claim
back, because the incoming source only re-asserts what it carries and a
match neither source carries has no route to a terminal status.

The boot case is a failover too. The AMQP reconnect path deliberately
skips its flush while Backup is forced, so without an explicit boot flush
a restart keeps whatever the previous process left behind and only the
slice Bifrost happens to carry gets refreshed. feed-ingester acknowledges
either flush by stamping `feed_control.flushed_at`; bifrost-feed waits for
`flushed_at >= switched_at` (15 s ceiling) before its re-emit, so the full
snapshot lands on a clean slate rather than racing the flush.

### The historic view is the only one with settled markets

Once a match finishes, Bifrost answers `match(id, historic: false)` with a
real object — right id, `state: CLOSED` — and an **empty `marketGroups`**.
Every settled market is reachable only through `historic: true`. Measured
on 2026-09-03 against three finished CS2 matches:

| Match | `historic: false` | `historic: true` |
| --- | --- | --- |
| od:match:3136677 | 0 markets | 532 CLOSED, outcomes WON / LOST |
| od:match:3136678 | 0 markets | 607 CLOSED, outcomes WON / LOST |
| od:match:3136680 | 0 markets | 552 CLOSED, outcomes WON / LOST |

`Client.FetchMatch` asks for both and returns whichever answer actually
carries markets, keeping the market-less one only as a last resort for
callers that just want lifecycle state. Returning the first non-nil result
instead — which it did until 2026-09-03 — handed the results sweep a
market-less snapshot every time. `SettleCandidates` found nothing, the
sweep logged `matches_settled: 0` on every pass while its fetch list grew
without bound (31 to 73 in 80 minutes), and the affected matches sat at
`live` in the catalogue with no prices on the storefront.

### Closing a match that has left the offer

Nothing else closes it. A finished match drops off the live offer, so its
`onUpdateMatchLive` subscription goes quiet, and `onMatchStateChanged`
only records the transition locally. The settlement path closes a match
indirectly through settlement's `MarkMatchClosedIfAllMarketsTerminal`,
which needs *every* market row we hold to reach a terminal status — so a
single market Bifrost no longer lists strands the match forever.

So `translate.OddsChange` emits a **lifecycle-only** `odds_change` for a
CLOSED match with no quotable markets: `<sport_event_status status="4"/>`
and no `<odds>` block. A live match whose book is momentarily all-closed
still returns nothing, since that is an ordinary between-rounds
suspension. The results sweep publishes the same message for every closed
match it fetches. On the consumer side `feed-ingester.applyLifecycleOnly`
acts on it: terminal codes only, and only for a match already in the
catalogue, so a market-less message can never auto-create a fixture. The
status guard is forward-only, which makes replays no-ops.

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
| **`bet_cancel` is synthesised for ONE case only — maps a CLOSED series never reached — and `rollback_*` not at all.** Bifrost has no cancel state or rollback event; a cancelled event appears as CLOSED with markets removed, and a rollback would appear as a terminal status reverting to OPEN. | **Unplayed maps: shipped 2026-09-06** (`translate.UnplayedMapCancels`, runner `emitUnplayedMapCancels`). On a CLOSED match every open market of ours whose `map` specifier is beyond the last map the snapshot proves was played is voided through a windowless `bet_cancel` — Oddin's own rule for an unplayed map, so there is no settlement risk; measured 2026-09-06, 2 231 of the 5 737 open Oddin markets on the 09-05 fixtures were this shape (a BO5 that ended 3-0 kept 228 markets open on maps 4 and 5). **Dropped ladder lines** on played maps and at match level are NOT voided — a played market has a real result; `services/settlement` infers them from settled siblings (`settler.ReconcileLadderLines`, docs/SETTLEMENT_COVERAGE_PLAN.md). **Whole-event cancellation and rollbacks remain deferred** (operator, 2026-09-03; needs Oddin to confirm the representation): a market Oddin cancels during a backup window stays open on our side, visible on `/admin/unsettled`, and the operator Void button there is the fallback. |
| Probabilities are derived from odds. | Accepted: margin-normalised implied probability, chosen by the operator. Cashout and the fair-odds clamp see values within ~0.01 of Oddin's on two-way books. |
| Tournament risk tier is not on Bifrost. | Accepted: manual assignment on `/admin/tournaments` with a lock (migration 0094) so the REST refresh never overwrites it. |
| Markets MaxBet hides from its Bifrost are not fed. | Accepted: such markets simply stay suspended from the watchdog flush, which is the safe direction. |
| `matches.status` for a CLOSED match with zero markets is not moved by the backup. | The settlement service's all-markets-terminal close covers the settled case; the "cancelled look-alike" falls under the first row. |
| Payload hash of a backup settlement can differ from Oddin's. | Harmless double `settlements` row; every downstream write is idempotent. |
| Bifrost states `handicap` from the opposite side to the AMQP feed. | **Corrected on our side** (`bifrost.NormalizeSpecifiers`, 2026-09-04) so both sources key the same market row. Still open upstream: Oddin fixed this on AMQP on 2026-06-02 and Bifrost did not follow, so if they ever align, this flip has to come back out — pin the direction with the moneyline check above before changing it. |

## 4b. What the operator sees it called

In the backoffice the Backup position on `/admin/feed` is branded
**CommZilla**, a.k.a. **Communism Mode** — everything gets redistributed
from a single central source. It is display copy only. The stored
`feed_control.source` value is still `backup`, the env var is still
`BIFROST_MODE`, and the service is still `services/bifrost-feed`, so
nothing in the switch, the gate or the runbook below changes name.

## 5. Runbook

**Enable.** Put the key in `.env` on the box (`sed -i` a single key,
never `cat .env`), keep `BIFROST_MODE=auto`, `make deploy`. The deploy
that first introduced the service did not create its container (the
service map is read from the pre-deploy checkout; see docs/OPERATIONS.md
step 4), so on that one occasion `make build SVC=bifrost-feed && make
recreate SVC=bifrost-feed` followed. Check:

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
72 h results sweep settles what the DB still holds open and voids the maps
a finished series never reached. Whole-event cancels and rollbacks still
depend on the AMQP replay window.

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
