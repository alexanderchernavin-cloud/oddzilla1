# services/settlement

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
- `sweeper` — periodic stale-ticket sweeper (default 30 min). Notifies
  `fixture_refresh` for matches with stuck `accepted` tickets in the
  5h–48h window, and voids+refunds stale legs after 48h.
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

## Stale-ticket sweeper

A background goroutine in the settlement service handles tickets that
get left in `accepted` long after their match should have ended —
typically because Oddin's broker never emitted the `bet_settlement`,
the message landed for a market we don't have, or our consumer was
offline through the recovery window.

Runs on its own ticker (default 30 min, env
`SETTLEMENT_STALE_SWEEP_INTERVAL`). Two phases per tick:

1. **Recovery (5h ≤ age < 48h after `matches.scheduled_at`).** For each
   match URN with stuck `accepted` tickets, fire
   `pg_notify('fixture_refresh', urn)`. The feed-ingester listener
   re-fetches the fixture from Oddin REST and updates `matches.status`.
   Per-URN cooldown (5 min) inside that listener makes spamming safe.
2. **Void (age ≥ 48h).** For each ticket with at least one stale
   unresolved selection, void only the stale leg(s) (`result=void,
   void_factor=1`) and re-run the settler's `MaybeSettleTicketTx`.
   Singles refund the stake; combos with one stale leg + one
   future-match leg keep the ticket open until the future leg
   resolves. Each void writes an `admin_audit_log` row and a
   Redis-fanned ticket frame for the user's open session.

Thresholds tunable via `SETTLEMENT_STALE_RECOVERY_AGE_HOURS` (default
5) and `SETTLEMENT_STALE_VOID_AGE_HOURS` (default 48).

## Run

```bash
go run ./cmd/settlement
```
