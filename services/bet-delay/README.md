# services/bet-delay

Finalizes tickets held in `pending_delay`. Go 1.23 / `pgx/v5` + `go-redis/v9`.

**Phase 1:** health stub on `:8084`.
**Phase 5 (current):** LISTEN + 1 s sweep + FOR UPDATE SKIP LOCKED + odds
drift check; publishes `{type:'ticket', status}` on `user:{id}` on every
promotion/rejection. 8 unit tests on the evaluate() function.

## How it works

When `POST /bets` accepts a ticket from a user with
`users.bet_delay_seconds > 0`, the ticket is inserted with
`status='pending_delay'` and `not_before_ts = now() + delay`. The API fires
`pg_notify('bet_delay', ticket_id)`.

This worker:

1. `LISTEN bet_delay` — wakes immediately on new tickets.
2. **Belt + suspenders:** every 1 s, `SELECT id FROM tickets WHERE
   status='pending_delay' AND not_before_ts <= NOW() LIMIT 100` in case a
   NOTIFY was missed (reconnect window, crash).
3. For each ticket, in one transaction:
   - load `ticket_selections` with `FOR UPDATE`,
   - re-read `market_outcomes.published_odds` for each selection,
   - if any selection's odds drifted > tolerance (default 5%) from
     `odds_at_placement`, or the market is not `status=1` (active), set
     `tickets.status='rejected'`, refund the lock
     (`UPDATE wallets SET locked_micro -= stake_micro`),
     insert `wallet_ledger` refund row (keyed `ref_id=ticket.id`), and
     return,
   - else `UPDATE tickets SET status='accepted', accepted_at=NOW()`.

## Invariants

- Never promote a ticket without the odds/status recheck.
- Refund path is the only legitimate escape from `pending_delay`.
- Tolerance is configurable per admin setting (phase 5).
