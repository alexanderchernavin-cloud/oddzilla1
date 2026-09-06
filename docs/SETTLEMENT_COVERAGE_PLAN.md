# Settlement coverage: why markets stay open, and the plan to reach 0%

Written 2026-09-06 from a production measurement of the matches that
**started on 2026-09-05 (UTC)**; revised the same day with the operator's
decisions and with what shipped. Operator requirement that this document
serves:

> A match that is not finished, is in play, or finished recently is not a
> problem. A match that finished **more than one hour ago** must be fully
> settled. Target: 0% unsettled markets on such matches, with no manual
> settlement.

"Unsettled" throughout means `markets.status NOT IN (-3, -4)` — the market
never reached a terminal state — on a match whose `status = 'closed'`
(or `cancelled`). Only two things ever write a terminal market status:
Oddin's `bet_settlement` / `bet_cancel` (via `services/settlement`, from
AMQP or the Bifrost backup stream) and Fonbet's results grader
(`services/fonbet-ingester internal/settle`, over the `settlement.external`
stream). A market neither of them covers stays open forever.

## 0. Operator decisions (2026-09-06)

These override the first draft of the plan and are the constraints every
step below is built on.

1. **A played market is never voided automatically.** If we do not know
   its result, it stays open until a grader learns the shape or an
   operator decides — a refund is a wrong settlement for whoever held the
   winning side. No auto-void sweeper, in any phase.
2. **A market on a map / period that was never played IS voided** — that
   is Oddin's own rule and the only defensible result.
3. **Voiding by hand is a button, not a process**: an audit-logged operator
   action on `/admin/unsettled`, per market and per match.
4. **Shapes no grader can settle are not offered.** Admin-managed
   denylist; the open markets already created under a rule stay visible
   on a sub-page in case the grading is written later.
5. **The Fonbet grader is English-only.** The Russian vocabulary from the
   `fonbet.kz` era is gone, not maintained.
6. **Temporary rules for the sports the grader refused** (australian
   football, bandy, beach soccer, padel, MMA, boxing, darts) are the
   industry-standard conventions for the few shapes Fonbet quotes on them.
7. **Bifrost's own settlement data is used wherever it exists.** Checked
   2026-09-06 (section 2.1): `match(historic: true)` carries only the
   markets still in Bifrost's CLOSED view — the 438 it returned for a
   BO5 were exactly our 419 already-settled markets plus 19 lines we never
   held; all 264 open ones were absent. The front-end operations catalogue
   has no other settlement query, so dropped lines are inferred from their
   settled siblings instead (section 3, phase 1c).

## 1. Measurement (2026-09-05 starts, closed more than 1 h before the query)

| provider | matches | markets | unsettled | share | matches affected |
| --- | --- | --- | --- | --- | --- |
| Fonbet | 5 359 | 357 945 | **13 884** | 3.88% | 3 678 (69%) |
| Oddin | 1 075 | 98 861 | **5 682** | 5.75% | 615 (57%) |
| **total** | **6 434** | **456 806** | **19 566** | **4.28%** | **4 293 (66.7%)** |

Two things outside that table:

- **383 Fonbet fixtures that started on 2026-09-05 are still
  `not_started`** (1 495 open markets, all `status = 0`). 94 of them carry
  settled markets, i.e. the match was played and graded but the match row
  never left `not_started`. These are invisible to `/admin/unsettled`,
  which filters on `closed` / `cancelled`. See cause F9.
- **Zero open tickets** sit on any of these markets. The exposure today is
  hygiene and trust, not money.

The pipeline itself was healthy at measurement time: consumer-group lag 0
on `settlement.external`, `oddin.backup` and `odds.raw`; bifrost-feed
`active`; the Fonbet grader enabled (`settle_enabled=1`) and passing every
2 minutes. Every cause below is structural, not an outage.

Per start day, closed matches only (share of markets unsettled):

| day | Oddin | Fonbet |
| --- | --- | --- |
| 08-30 | 0.1% | — |
| 08-31 | 0.2% | — |
| 09-01 | 0.0% | — |
| 09-02 | 0.1% | — |
| 09-03 | 0.3% | — |
| 09-04 | **4.5%** | 19.2% (feed switched on mid-day) |
| 09-05 | **5.8%** | 4.0% |

The Oddin step on 09-04 is the day the AMQP credentials died (cause O0).

## 2. Causes

### 2.1 Oddin — 5 682 markets, one root cause

**O0 (root).** Oddin's AMQP credentials have returned
`403 username or password not allowed` since 2026-09-04 (2 604 reconnect
warnings in the 24 h before this measurement). Settlement therefore comes
only from the Bifrost backup stream, and
[`SettleCandidates`](../services/bifrost-feed/internal/translate/translate.go)
voices **only the markets Bifrost itself still lists as CLOSED with
terminal outcomes**. Anything Bifrost has dropped from its view produces no
signal at all. Every sub-class below is a consequence.

| id | sub-class | markets | what it is |
| --- | --- | --- | --- |
| O1 | Match-level ladder lines Oddin replaced during the match (team totals 85/86, asian handicap 96/132, total goals 71/77, handicap 66/88, kill lines) | ~3 300 (58%) | the line moved, the old row left Bifrost's offer and is absent from its CLOSED view. Under AMQP Oddin settles every line it ever offered |
| O2 | Markets of maps that were never played (BO3 ended 2-0, BO5 ended 3-0) | ~2 230 (39%) on 78 matches | under AMQP these arrive as `bet_cancel` (void). Example: Vitality vs G2, BO5 3-0 — maps 4 and 5, 228 markets, all `-1` |
| O3 | Dropped lines on maps that were played | ~170 (3%) | same as O1, one level down |

Two facts established while checking Bifrost's data (section 0, item 7):

- 97% of the open ladder lines (3 247 of 3 340, unplayed maps excluded)
  have at least one **settled sibling** in the same family — same market
  type, same other specifiers, different line — which fixes their result
  exactly (a total and a handicap are monotonic in the line).
- 1 594 of the open Oddin handicap rows on 09-04/05 matches were created
  BEFORE the 2026-09-04 14:39 UTC deploy of the Bifrost handicap-sign fix
  and therefore carry the pre-fix key; no post-fix settlement can ever
  match them. The sibling inference settles those too, from the correctly
  keyed siblings on the same match.

1 199 of these still sit at `status = 1` on a closed match. Not bettable —
[`bets/service.ts`](../services/api/src/modules/bets/service.ts) rejects any
leg whose match is not `not_started` / `live` — but dirty.

### 2.2 Fonbet — 13 884 markets

The grader's own counters over its 7-day lookback at measurement time:
`unsupported market shape` 14 444, `no score` 5 107, `ambiguous half label`
446, `two-way tied` 2, and 797 matches `no_result`. Decomposed against the
catalogue tables (counts taken minutes apart, so they sum to within a few
rows of the total):

| id | sub-class | markets | share | resolution |
| --- | --- | --- | --- | --- |
| F1 | **Sport has no entry in [`sportRules`](../services/fonbet-ingester/internal/settle/rules.go)** — aussie-rules 1 773, bandy 329, mma 217, padel 201, darts 184, beach-soccer 180, motorsport 73, cricket 51, billiards 31, cycling 19, boxing 18, `fb-1439` 101 | 3 177 | 23% | rules shipped for the seven the operator named (2c) |
| F2 | **Both teams to score** (table 1002800, match + halves) — nameless table, no `Grade` branch for its shape | 3 774 | 27% | shipped (2a) |
| F3 | **Winner of point N in set K** (table 1007800; table tennis, volleyball, beach volleyball, badminton) — needs point-by-point data the feed does not carry | ~4 000 | 29% | **denylisted** (3a); existing rows stay open, listed on the denylist page |
| F4 | **Winner of game N in set K** (tables 1004500 / 1004551, tennis) — needs per-game data | 924 | 7% | **denylisted** (3a) |
| F5 | **Statistic sub-events** — rugby `tries` 250, ice hockey `2nd period shots on goal` 107, football `hit the woodwork` 103 (spelling gap between line and results), baseball `5 innings` 90, hockey `overtime` 30, substitutions, corners, player specials, "Special bets" | 1 423 | 10% | player specials + "Special bets" denylisted; the rest is phase 2d |
| F6 | **Two-way "To win the match"** (table 1000491 + `overtime:` / `extra time:` variants), mostly ice hockey — `IsMatchWinner` requires `IsMain` and Fonbet flags only the 1X2 table | 295 | 2% | shipped (2b) |
| F7 | **`no_result`** — the match is not in the results feed under a name the matcher accepts. Across the 7-day window the misses table showed the real class: **606 fixtures created while the line was Russian, whose Cyrillic team names the English results feed can never spell** (33 630 open markets), plus 251 Latin-named fixtures, 199 of them with no results row at their kick-off at all (postponed / absent) | ~210 on 09-05 | 1.5% | visible (2e); Cyrillic-only fallback on the (competition, start time) key when unambiguous on both sides — resolves 290 fixtures / 19 398 markets, every sampled pair correct; the matcher stays conservative for everything else |
| F8 | **Unsafe tables** (odd/even, correct score, OT, penalties, series) — refused by `tableUnsafe` on purpose | 33 | 0.2% | operator button |
| F9 | **Lifecycle.** A prematch event that vanishes from the line has its markets set to `0` and is dropped from memory ([`ingest.go`](../services/fonbet-ingester/internal/ingest/ingest.go)); the match row is never touched. The grader tries `not_started` matches older than 3 h, but for 289 of the 383 the results feed has no finished row (postponed / withdrawn) | 383 fixtures / 1 495 | — | lifecycle sweep closes the fully-terminal ones (4b); the rest surface in Unmatched results and are the operator's call — **never voided automatically, because odds were offered** |

## 3. Plan and status

Target invariant: **on a match closed more than 1 h ago, every market is
terminal (`-3` or `-4`).** Two mechanisms reach it — *grade* everything that
can be graded, and *void* only what was provably never played — plus stop
offering what nothing can grade. Ordered by markets recovered per unit of
work.

### Phase 0 — see the problem

- **Shipped 2026-09-06:** `/admin/unsettled` gained an **Unmatched
  results** tab (the Fonbet fixtures the grader cannot find, with what the
  results document listed for the same competition —
  `fonbet_settlement_misses`, migration
  `20260906T103343_settlement_operator_tools`), the **Market denylist**
  sub-page, and the operator **Void** buttons (per market, per match).
- **Open:** denominator + percentage, a start-date filter, a "closed more
  than N hours ago" filter (default 1), a per-day trend, and a persisted
  per-market grader verdict so the page shows *why* each market is open
  and the grader stops re-grading the same ~20 000 markets every 2
  minutes. Dashboard KPI: share of non-terminal markets on matches closed
  > 1 h, per provider; alert above 0.5%.

### Phase 1 — Oddin (−5 682, 29% of the total)

- **1a. Get the AMQP credentials restored by Oddin.** Operational, no code.
  This alone returns Oddin to the 0.0–0.3% of 09-01..09-03, and the 24 h
  recovery replay on reconnect (`handler.recoveryWindowCap`) settles
  everything younger than a day retroactively. **Open — Oddin's side.**
- **1b. Unplayed maps → `bet_cancel`. Shipped 2026-09-06.**
  [`translate.UnplayedMapCancels`](../services/bifrost-feed/internal/translate/cancel.go):
  on a CLOSED match, every open market of ours whose `map` specifier is
  beyond the last map the snapshot proves was played (highest map on any
  listed market, or the number of scored periods) is voided through a
  `bet_cancel` with no window. Runs on the live path and on the historic
  results sweep; an empty CLOSED frame proves nothing and emits nothing.
  Stats `cancellations` / `cancelled_markets` on `/admin/feed`.
- **1c. Dropped ladder lines → inference from settled siblings. Shipped
  2026-09-06, reworked the same day.** [`settler.ReconcileLadderLines`](../services/settlement/internal/settler/ladder.go),
  every reconcile tick (`SETTLEMENT_RECONCILE_INTERVAL_SECONDS`, 300 s).
  Every settled sibling of the family is a statement about the one integer
  the family settles on (the total, or the home margin): over 25.5 won ⇒
  26 or more, under 27.5 won ⇒ 27 or less, a push ⇒ exactly 27, a half-won
  quarter line ⇒ one exact value. The intersection is an interval; the
  open line settles when both ends grade it the same way, so whole, half
  and quarter lines all decide, with the real result — pushes and half
  results included — whenever the number is pinned. Disagreeing siblings,
  an interval spanning the line, non-4/5 / non-1/2 outcome sets, and
  markets whose outcomes already carry results (a settle / cancel /
  rollback_cancel desync — 42 markets on 4 matches in the 7-day window,
  the rollback path's problem) are refused and left untouched. **Why the
  rework:** the first production pass with a strict-inequality rule over
  full won / lost siblings decided 2 of 7 313 candidates; 6 643 were
  "undecided" because Oddin ladders almost always carry a quarter line or
  a push that pins the number, which that rule could not read. Provenance
  lands in the settlements audit row (`extended_specifiers:
  inferred_from=threshold=25.5,threshold=26 (value 26)`). No void path.
  **First pass with the interval form (2026-09-06 14:01 UTC): 6 671 of
  7 372 candidates settled**, 0 tickets on any of them; left: 246 families
  whose siblings contradict each other (worth a look — pre-fix handicap
  rows settled through the mirror key are the likely source), 225 race
  markets (1/2 outcomes with a threshold), 208 lines the interval spans,
  22 rollback desyncs.
- **1b′. The results sweep window went 24 h → 72 h** the same day: the
  unplayed-map cancels ride that pass, and 940 markets on 09-05 matches
  that had closed before the cancel path existed were waiting for a
  snapshot the 24 h window would never fetch again.

**Where the 09-05 measurement stands after the day's work** (closed > 1 h,
re-measured 2026-09-06 14:05 UTC): **8 294 of 470 178 markets open —
1.76%, down from 4.28%**; 1 763 matches affected, down from 4 293. Fonbet
6 973 (1.88% — the denylisted shapes already created, statistic rows,
unmatched fixtures), Oddin 1 321 (1.33% — 940 unplayed-map markets
awaiting the widened sweep, 215 undecided ladder lines, 166 non-line
markets Bifrost dropped). Unmatched Fonbet fixtures 855 → 448; fixtures
stuck at not_started 383 → 221.
- **1d. Hygiene.** On CLOSED, any market still at `1` goes to `-1`. Open.

### Phase 2 — Fonbet grader coverage

- **2a. Both teams to score. Shipped** — read off the two factor labels of
  the nameless table 2800, match and per half.
- **2b. Two-way winner without `IsMain`. Shipped** — a one-row, no-line,
  two-outcome table whose factor labels are 1 / 2 is graded as a winner;
  hockey's OT and shootout rows already break the tie.
- **2c. Sport rules. Shipped** for australian football (four quarters,
  "1st half" = quarters 1+2, regular time), bandy (two halves, football
  convention), beach soccer (three periods; shootout row breaks two-way
  ties only), padel (tennis shape), MMA and boxing (fight sports: winner
  is the non-zero side of "<round>:0"; total rounds settle off the
  finishing round when that round decides the line, a finish IN the
  deciding round, a "0:0" and any handicap are refused), darts (headline
  is legs; sections not saying "legs" — set play — are refused). Every
  rule was read off the 09-04 / 09-05 results documents and pinned by
  tests. Motorsport / cycling are head-to-heads and outrights — not
  graded.
- **2d. Statistic sub-events.** Pair every sub-event label against the
  rows one real results document carries, per sport: `tries`, `shots on
  goal` per period, `hit the woodwork` (spelling), `5 innings` (sum of the
  first five inning rows), corners, cards. ~1 400. Labels the feed does not
  carry go to the denylist. **Open.** English only.
- **2e. `no_result` visibility. Shipped** — `fonbet_settlement_misses` +
  the Unmatched results tab. The first hour of data named the dominant
  class — Cyrillic-named legacy fixtures — and the matcher gained one
  narrow fallback for exactly them (F7 above): the (competition, start
  time) key, only when it is unambiguous on both sides. Everything else in
  the matcher stays conservative (order-blind matching inverted every grade
  once).

### Phase 3 — do not offer what cannot be settled

- **3a. Fonbet market denylist. Shipped** — `fonbet_market_denylist`
  (migration `20260906T103343_settlement_operator_tools`), seeded with
  1007800 (point winners), 1004500 / 1004551 (game winners), "Player
  specials" and "Special bets"; managed at
  `/admin/unsettled/denylist`, read by fonbet-ingester every minute, applied
  in the mapper so a denied shape is never created and an existing one is
  deactivated by the ingest diff. The open markets under each rule are
  listed on the page; they are **not** voided.
- **3b. Operator void button. Shipped** — `POST /admin/unsettled/markets/:id/void`
  and `POST /admin/unsettled/matches/:id/void-open` publish the grader's own
  `cancel` message onto `settlement.external`, so the void goes through
  services/settlement's apply-once path. Finished matches only. Audit-logged
  (`settlement.market_void`, `settlement.match_void_open`). **There is no
  automatic void of a played market, by operator decision.**

### Phase 4 — lifecycle

- **4a. Vanished prematch events are never voided.** Odds were offered, so
  the markets must be settled: the grader already retries `not_started`
  fixtures older than 3 h against the results feed on every pass, and the
  ones it cannot find are now on the Unmatched results tab for the
  operator. The only automatic cancel is Fonbet's own `status 4` in the
  results feed. **No further code.**
- **4b. Lifecycle sweep. Shipped** — [`settler.ReconcileMatchLifecycle`](../services/settlement/internal/settler/lifecycle.go):
  a match past its start by 3 h whose row still says not_started / live /
  suspended and whose every market is terminal flips to `closed` and the
  transition is voiced. Covers the 94 fixtures whose book was graded while
  the match row never moved.
- **4c. `/admin/wedged-matches`** lists these alongside the Oddin wedges.
  Open.

### Phase 5 — control

The Phase 0 KPI is the definition of done: share of non-terminal markets
on matches closed > 1 h, per provider, alert > 0.5%. Expected end state:
Oddin 0% with AMQP alive (1b–1c cover the backup-feed case); Fonbet 0% for
every shape the grader knows, with the remainder — denylisted shapes
already created, statistic rows the feed does not carry, fixtures the
results feed does not list — visible on `/admin/unsettled` and settled by
an operator decision, never by a timer.

### Order of what remains

1a (credentials, Oddin's side) → 2d (statistic rows) → Phase 0's
percentage / filters / verdicts → 1d → 4c.

## Appendix — how the numbers were taken

All queries ran against production Postgres inside the container
(`docker exec -i oddzilla-postgres-1 sh -c 'export PGPASSWORD="$POSTGRES_PASSWORD"; exec psql …'`),
with the population defined as

```sql
m.scheduled_at >= '2026-09-05 00:00+00' AND m.scheduled_at < '2026-09-06 00:00+00'
AND m.status = 'closed'
AND m.updated_at < NOW() - INTERVAL '1 hour'   -- updated_at is the close stamp on a closed match
```

Headline table:

```sql
SELECT CASE WHEN m.provider_urn LIKE 'fb:%' THEN 'fonbet' ELSE 'oddin' END AS provider,
       COUNT(DISTINCT m.id) AS matches, COUNT(mk.id) AS markets,
       COUNT(mk.id) FILTER (WHERE mk.status NOT IN (-3,-4)) AS unsettled,
       ROUND(100.0*COUNT(mk.id) FILTER (WHERE mk.status NOT IN (-3,-4))/COUNT(mk.id),2) AS pct,
       COUNT(DISTINCT m.id) FILTER (WHERE mk.status NOT IN (-3,-4)) AS matches_affected
FROM matches m JOIN markets mk ON mk.match_id = m.id
WHERE <population>
GROUP BY ROLLUP(1);
```

Oddin sub-classes: bucket by `mk.specifiers_json ? 'map'` and compare the
map number with `jsonb_array_length(m.live_score->'periods')`. Fonbet
sub-classes: join `market_descriptions` (`language='en'`, `variant` =
`mk.specifiers_json->>'variant'`) and bucket on sport slug, table id, and
the sub-event prefix of `name_template`. Grader refusal counters come from
fonbet-ingester's `settlement pass` log line; stream health from
`XINFO GROUPS` on the three streams and the `bifrost:feed:status` /
`fonbet:feed:status` Redis hashes. The Bifrost check fetched
`match(historic: true)` from inside the bifrost-feed container (the key
never left the box) and compared decoded market ids against our rows.
