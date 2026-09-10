# SlotZilla — the 15-second live-basketball slot

Design record, measurements and operating notes for SlotZilla, Oddzilla's
answer to Betby's SlotBasketball (Betby SlotBets, launched 2026-09-08;
their demo tile is called "PlayTracker"). Everything numeric in here was
measured on 2026-09-09 and is the provenance of the defaults in
`packages/db/migrations/20260909T211312_slotzilla.sql`.

## What it is

A bettor presses **Spin** on a live basketball match. The spin covers
**15 seconds of match clock**, split into three 5-second windows. Each
window becomes a reel showing the highest-value play Sportradar's scouts
logged inside it:

| Symbol | Event | Rank |
| --- | --- | --- |
| `P3` | 3-pointer scored (`goal`, `points` 3) | highest |
| `P2` | 2-pointer scored (`goal`, `points` 2) | |
| `FT` | free throw scored (`goal`, `points` 1) | |
| `MISS` | shot missed (`attempt_missed`) | |
| `FOUL` | foul (`foul`) | |
| `NONE` | nothing in the window | lowest |

Two reels on one symbol pay the `any2:<symbol>` line, three pay
`all3:<symbol>`; three different symbols pay nothing. Rebounds, turnovers,
steals, timeouts and clock events make no symbol in v1.

The match is the random number generator. There is no RNG anywhere in the
game, and a settled spin can be replayed from the stored events
(`sr_live_events`) with Sportradar's own event ids.

## Rules

- **Spin-anchored rounds on a 5-second grid.** A spin's first window opens at
  the first 5-second mark of the match clock at least `lead_seconds` (10)
  after the clock reading the service holds: a spin at 38:25 opens at 38:35,
  one at 38:27 at 38:40. Operator's rule (2026-09-09): Betby labels reels
  38:33–38:37, ours read 38:35–38:39, and because every window is on the
  same grid its symbol is derived once per match and shared by every spin
  that covers it.
- **No spins while the clock is stopped.** Timeouts, period breaks, reviews
  and free throws stop the clock; the panel shows "Waiting for live play"
  and auto-play waits with it. A round already open keeps counting when the
  clock resumes.
- **Settlement on the scout's clock.** Every event carries `seconds`, the
  cumulative match-clock reading when the scout logged it. Windows are
  ranges of that number, never of arrival time, so a late-arriving event
  still lands in the window it belongs to.
- **Corrections re-derive a reel until the spin settles.** A spin settles
  once the clock is `clock_past_seconds` (5) past its last window and
  `grace_seconds` (10) of wall time have passed since the last event inside
  it. After that the result stands; a later correction feeds the return
  monitor, not a claw-back. (Betby's tutorial states the same rule.)
- **Void, never guess.** Feed dark for `feed_dark_void_seconds` (180), match
  abandoned, or the fixture removed: every open spin is refunded
  (`slot_refund`) and the game row records why.
- **One open spin per bettor per match** (partial unique index). Auto-play
  is a client loop over the single-spin call with a visible stop and a
  session spend total; the server holds no standing instruction to spend.

## Why match clock, not wall clock

On wall-clock 5-second windows across four full games, **86.7% of windows
were empty** and a three-of-a-kind on any scoring symbol appeared once in
1,959 rounds. Basketball stops more than it plays. On match-clock windows
the same games look like a game:

| Symbol | Share of 5-second match-clock windows |
| --- | --- |
| NONE | 68.8% |
| MISS | 11.9% |
| P2 | 10.5% |
| FT | 3.2% |
| FOUL | 2.9% |
| P3 | 2.6% |

(2,015 windows; NBA Cleveland v New York and Dallas v Phoenix at coverage
Level 2, FIBA Italy v Australia at Level 3, VTB Zenit v Lokomotiv Kuban at
Level 5. Per game the shares move by a few points, not by kind.)

## Line frequencies and the paytable

Measured on 2,012 spin-anchored rounds (every window start is a possible
first window, so rounds slide by one window):

| Line | Share of rounds |
| --- | --- |
| any2:NONE | 61.6% |
| all3:NONE | 22.5% |
| no line (three different) | 12.4% |
| any2:MISS | 2.58% (1 in 39) |
| any2:P2 | 0.20% (1 in 503) |
| any2:FT | 0.20% |
| any2:FOUL | 0.20% |
| any2:P3 | 0.15% (1 in 671) |
| all3:MISS | 0.10% (2 seen) |
| all3 on a scoring symbol | 0 seen |

**Consecutive baskets are rarer than chance.** Independence on the
per-window shares predicts three 2-pointers once in 860 rounds; the sample
has none in 2,012. After a made basket the other side inbounds and works
the shot clock, so a score in one window suppresses a score in the next.
The rare lines therefore cannot be priced from per-window frequencies, and
a four-game sample only bounds them. That is what the corpus and the
calibrator are for (see Operating notes).

### Betby's paytable, scored on real feeds

Their grid (read off the demo on 2026-09-09; five symbols, free throws
folded away): 3 points ×20 / ×500, 2 points ×10 / ×200, miss ×5 / ×30,
foul ×3 / ×10, **none ×0.5 / ×1**. On our measured rounds it returns
**79.5%** with free throws counted as nothing and **83.3%** with them
counted as 2-pointers, and the two NONE rows carry two thirds of that
(without them: 21.5%).

### Why empty reels pay

A reel is NONE far more often than not, so two or three NONE reels happen
in **84 spins in 100**. Betby pays half the stake back on two and the whole
stake on three. Without that a bettor loses everything on 84 spins in 100
and waits for the rare lines, which is either a hopeless game or one whose
rare lines pay four times more and whose ordinary experience is a long
losing streak. Paying on NONE is a slot design device: it shortens losing
streaks and keeps the visible return steady while the play lines carry the
excitement. **SlotZilla keeps NONE at ×0.5 / ×1 and never lets it go
higher** — three empty reels must not profit — and reaches the operator's
return target by scaling the play rows.

### The v1 indicative table (seeded active)

| Symbol | Any 2 | All 3 |
| --- | --- | --- |
| P3 | ×35 | ×500 |
| P2 | ×18 | ×200 |
| FT | ×22 | ×250 |
| MISS | ×9 | ×55 |
| FOUL | ×5 | ×18 |
| NONE | ×0.5 | ×1 |

Return on the measured rounds from observed lines ≈ 96%; the unobserved
All-3 play lines add at most a few points under the payout cap. The
calibrator replaces every number once the corpus exists.

Multipliers are stored in **hundredths** (`50` = ×0.5, `3500` = ×35),
integers, so a payout is exact bigint arithmetic on the micro stake:
`payout = floor(stake × x100 / 100)`.

## Data

Sportradar's statistics host, `stats.fn.sportradar.com` (the same open host
the Sportradar mapping sweeper reads; rights covered under the Sportradar
deal, confirmed by the operator 2026-09-09). Per live game:

- `match_timelinedelta/<srMatchId>` every 3 s (`_maxage` 3 s): the last
  handful of events plus the match object with `timeinfo.played` (cumulative
  clock seconds), `timeinfo.running`, `coverage.live.level.value`.
- `match_timeline/<srMatchId>` on start and every 60 s to catch corrections
  (`updated_uts`, `disabled`).

Measured: events arrive 5–7 s behind wall clock; scout corrections up to
18 s after the event; the full timeline caches for 20 s and is only for
reconciliation. Clock state comes from the match object on every poll, not
from clock events, because Level 2 (NBA) feeds carry no `timerunning`
events.

**Per-player detail is Level 2 only.** On NBA games every `goal` carries
`scorer` and `assists` (121 of 121 on Cleveland v New York) and turnovers /
steals / blocks carry `player`; FIBA (Level 3) and VTB (Level 5) events are
team-only. `slotzilla_games.coverage_level` is read per match and gates
player mode; it is never assumed per league.

The embedded Sportradar widgets (tracker, Head to Head, Live Table, Bet
Assist) are cross-origin iframes and post nothing to our page — the feed
above, read server-side by `services/slotzilla`, is the only source.

## Timing and fairness

Our view of the match is 5–7 s old, and a bettor courtside knows what just
happened before we do. The defence is the lead: the first window opens at
least 10 clock-seconds after the reading we hold, so a bettor with a live
edge is still betting on play at least 3 s in the future, and the next 15
seconds of basketball are not predictable from the last 3. Betby uses about
8 s for the same reason. RiskZilla's velocity caps apply to spins in every
currency.

## Money and risk

- Stakes are LOCKED at placement (`wallets.locked_micro`), with a
  `wallet_ledger` row `slot_stake` (`ref_type = 'slotzilla_spin'`,
  `ref_id = spin uuid`). Settlement releases the lock and moves the balance
  by `payout − stake`, writing `slot_payout` when the payout is positive;
  a void writes `slot_refund`. The existing partial unique index on
  `(type, ref_type, ref_id)` makes any replay a no-op (invariant 4).
- `exposure_micro` on the spin is `stake × top multiplier`, capped by
  `max_payout_micro`. For USDC the api adds it to
  `riskzilla_bank_state.open_liability_micro` on accept and the settler
  releases it on settle and on void — USDC-gated in both directions, the
  rule the re-price delta bug taught. **The bank recompute
  (`/admin/riskzilla/bank/recompute`) must also sum open USDC spins**; until
  it does, run it only while no USDC spin is open.
- The per-match cap (`match_liability_cap_micro`) is checked at intake
  against the sum of open exposure on the game.
- The return monitor is `slotzilla_games.*_stake_micro / *_payout_micro`
  per currency; the backoffice flags a game whose realised return exceeds
  `rtp_target_bp + return_alarm_margin_bp` over at least
  `return_alarm_min_spins` spins. Pause stops new spins and lets open ones
  settle; Void refunds them.
- OZ plays the full game and is how the soak runs. USDC is switched on in
  `slotzilla_config.currencies`, not in code.

## Operating notes

- **Corpus and calibration.** `POST /admin/slotzilla/corpus/fetch` (or
  `pnpm --filter @oddzilla/api slotzilla:corpus -- --from --to`) archives
  finished basketball timelines into `sr_live_events` with `match_id NULL`.
  `POST /admin/slotzilla/paytables/fit` derives per-match window symbols
  with the shared rule, slides every 15-second round, aggregates line
  frequencies and scales the play rows to `rtp_target_bp`, holding the NONE
  rows. Target 200+ games per coverage level before trusting the All-3 play
  lines; the payout cap bounds a mis-priced rare line until then.
- **Return target is a backoffice setting** (`rtp_target_bp`, 97% at
  launch), as are the stake bounds, the payout cap and the per-match cap.
- **Player mode** (Level 2) is presentation in v1: the scorer's name rides
  on the reel. A priced scorer side-bet, team lines and Betby's Pause Bonus
  (×1.2 after 30 s of stoppage inside the round) are paytable additions on
  the same engine, deferred until the base return has a month of history.

## Coverage

On 2026-09-09 production held 62 bookable basketball fixtures of which 14
carried a confirmed Sportradar mapping (12 upcoming, 2 of 10 live), and
Sportradar's day feed listed 7 basketball matches. The game runs on marquee
fixtures — accepted by the operator — and the NBA (Level 2, from late
October 2026) is the content it is built for.

## Where things live

| Concern | Path |
| --- | --- |
| Rules (TS, pure, unit-tested) | `packages/types/src/slotzilla.ts` (`@oddzilla/types/slotzilla`) |
| Golden fixture both implementations read | `docs/fixtures/slotzilla-rules.json` |
| Rules (Go port) | `services/slotzilla/internal/rules` |
| Feed poller, spin engine, settler | `services/slotzilla` |
| Spin intake, game state, admin, calibrator, corpus | `services/api/src/modules/slotzilla/`, `services/api/src/modules/admin/slotzilla.ts`, `services/api/src/lib/slotzilla/` |
| Storefront panel | `apps/web/src/components/match/slotzilla-panel.tsx`, hook `apps/web/src/lib/use-slotzilla.ts` |
| Backoffice | `apps/web/src/app/admin/slotzilla/` |
| Schema | `packages/db/src/schema/slotzilla.ts`, migrations `20260909T211311` + `20260909T211312` |
