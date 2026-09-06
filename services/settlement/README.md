# services/settlement

Provider-neutral input: besides Oddin AMQP, the service consumes the Redis
stream `settlement.external` (`internal/extstream`, env
`SETTLEMENT_EXTERNAL_STREAM`). Producers grade markets themselves and send
`{type, event_urn, provider_market_id, specifiers, ts, outcomes}`; the
consumer builds an `oddinxml.Market` and calls
`Settler.ApplyExternalSettlement` / `ApplyExternalCancel`, so apply-once,
sticky statuses, ticket grading and payouts are shared. Today's producer is
`services/fonbet-ingester` (see `docs/FONBET.md`). The consumer follows
CLAUDE.md invariant 7: it recreates its group inline on `NOGROUP` (Redis is
allkeys-lru; an evicted stream key takes the group with it) and creates the
group from `0`, not `$`, so a recreate — or a boot that races the producer's
first XADD — replays entries still on the stream instead of skipping them.
Pending entries are reclaimed with a paginated XAUTOCLAIM cursor.

AMQP consumer for Oddin settlement messages. Applies payouts to tickets.
Go 1.23 / `amqp091-go` + `encoding/xml` + `pgx/v5`.

**Phase 1:** health stub on `:8083`.
**Phase 6 (current):** full settlement worker. Apply-once on the
5-tuple `(event_urn, market_id, specifiers_hash, type, payload_hash)`.
Second line of defense: `wallet_ledger` unique partial index on
`(type, ref_type, ref_id)` makes every credit un-double-payable even on
bypass.

Sub-packages (`internal/`):
- `oddinxml` — duplicated from feed-ingester so this service has zero
  cross-service Go deps
- `amqp` — duplicated consumer with reconnect
- `store` — settlements INSERT-if-new, market/outcome/selection updates,
  ticket FOR UPDATE SKIP LOCKED, wallet + ledger mutations, rollback
  reversal helpers
- `settler` — dispatcher + per-message-type handlers + payout math
  (`EffectiveFactor`, `SinglePayout`, `LedgerTypeFor`)
- `config` — env parsing with graceful idle when Oddin creds absent

## Messages handled

- `bet_settlement` — pays winners, refunds voids.
- `bet_cancel` — refunds, optionally bounded by `start_time`/`end_time`.
- `rollback_bet_settlement` / `rollback_bet_cancel` — undoes a prior
  message with compensating writes.

## Apply-once protocol

All writes for one XML message happen in one Postgres transaction:

```sql
INSERT INTO settlements (event_urn, market_id, specifiers_hash, type,
                         payload_hash, payload_json)
VALUES ($1, $2, $3, $4, $5, $6::jsonb)
ON CONFLICT (event_urn, market_id, specifiers_hash, type, payload_hash)
DO NOTHING
RETURNING id;
```

If no row returned → replay → ack AMQP, exit.

Retention: the nightly `oddzilla-settlements-retention` cron deletes
settle/cancel rows after 45 days (rollback rows kept forever; markets with
open tickets skipped) — identical-payload replays only arrive via AMQP
redelivery or the 24 h-clamped recovery window, and the money paths above
are independently idempotent. Ticket history itself (`tickets` /
`wallet_ledger` / `market_outcomes.result`) is never deleted. See
`docs/OPERATIONS.md` → "settlements retention".

Else:
1. `UPDATE market_outcomes SET result=..., void_factor=...`
2. `UPDATE ticket_selections ... WHERE market_id=$1 AND result IS NULL`
3. For tickets whose selections are all resolved:
   - compute `actual_payout_micro = Π(odds × void_factor) × stake`,
   - `UPDATE tickets SET status='settled', actual_payout_micro=...`
   - `UPDATE wallets SET balance_micro = balance_micro - stake + payout,
      locked_micro = locked_micro - stake`,
   - `INSERT INTO wallet_ledger (type='bet_payout', ref_type='ticket',
      ref_id=ticket.id, delta_micro=payout)` — the unique partial index
      prevents double-payment even if steps 1–3 were bypassed.

See [`../../docs/ARCHITECTURE.md#settlement`](../../docs/ARCHITECTURE.md#settlement).

## Rollbacks

Chunk through affected tickets in groups of ≤ 100 per transaction to keep
lock contention bounded. Each chunk:
- reverse `wallet_ledger` via a `bet_refund` row,
- reset `tickets.status='accepted'`, `ticket_selections.result=NULL`,
- write an `admin_audit_log` row with the rollback reason.

## Run

```bash
go run ./cmd/settlement
```

## Backup input (Bifrost)

`internal/backupstream` consumes the `oddin.backup` Redis stream written
by `services/bifrost-feed` (consumer group `settlement`, routing key
`bifrost.backup`). Entries are Oddin-shaped `bet_settlement` documents
synthesised from Bifrost's terminal outcome statuses while the AMQP feed
is silent; they go through the same `Settler.Handle`, so the apply-once
insert, the outcome cascade and the per-ticket payout path are identical.
A backup settlement's payload hash can differ from the one Oddin later
replays (specifier string order, INACTIVE outcomes omitted), which yields
a second `settlements` row and no other effect: every downstream write is
idempotent. The one `bet_cancel` bifrost-feed synthesises — markets on
maps a CLOSED series never reached — arrives on the same stream and goes
through `handleBetCancel` like Oddin's own. Whole-event cancels and
rollbacks are not synthesised (deferred; see
[`docs/BIFROST_BACKUP_FEED.md`](../../docs/BIFROST_BACKUP_FEED.md)).
`BACKUP_STREAM_ENABLED=false` detaches the consumer.

## Reconcile sweeps

Every `SETTLEMENT_RECONCILE_INTERVAL_SECONDS` (300) the sweeper in
`cmd/settlement/main.go` runs three DB-only passes, each a no-op on a
healthy day (docs/SETTLEMENT_COVERAGE_PLAN.md):

- `ReconcileStranded` — legs whose result was never written on a terminal
  market are healed from `market_outcomes`, and tickets now fully resolved
  are settled.
- `ReconcileLadderLines` (`internal/settler/ladder.go`) — a total or
  handicap line left open on a closed Oddin match is settled when a
  settled sibling of the same family **strictly implies** its result
  ("over 25.5 won" ⇒ "over 24.5 won"; home −1.5 won ⇒ home −0.5 won; a push
  pins the number exactly). Quarter lines, half-won siblings, disagreeing
  siblings and any outcome set other than 4/5 (totals) or 1/2 (handicaps)
  are refused and left untouched. Exists because the Bifrost backup only
  settles the lines still in its CLOSED view and drops every line it
  replaced during the match. The settlements audit row records the sibling
  (`extended_specifiers: inferred_from=…`). Nothing here voids anything.
- `ReconcileMatchLifecycle` (`internal/settler/lifecycle.go`) — a match
  past its start by 3 h whose row still says not_started / live /
  suspended and whose every market is terminal is flipped to `closed` and
  the transition voiced.

Operator voids from `/admin/unsettled` arrive over `settlement.external`
as `cancel` messages (`provider=admin`) and take the external path like a
Fonbet grader cancel.
