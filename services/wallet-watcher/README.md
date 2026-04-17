# services/wallet-watcher

Watches Tron and Ethereum USDT deposits, credits wallets on confirmation.
Go 1.23.

**Phase 1:** health stub on `:8085`.
**Phase 7 (current):** real chain watchers — Tron via TronGrid REST,
Ethereum via stdlib JSON-RPC. Per-chain scanner + shared confirmation
processor. Gracefully idles when neither RPC URL is configured.

Sub-packages (`internal/`):
- `ethereum` — minimal JSON-RPC client (`eth_blockNumber` + `eth_getLogs`)
  + scanner that filters USDT Transfer logs
- `tron` — TronGrid REST client + scanner; address normalizer accepts
  Base58, hex-with-41-prefix, and 32-byte zero-padded forms
- `deposits` — shared confirmation tick + atomic credit (deposit row →
  wallet balance → wallet_ledger), all replay-safe via the unique
  partial index
- `store` — pgx queries for cursor + deposit lifecycle
- `config` — env parsing with per-chain enable flags

**Not yet:** on-chain withdrawal submission (admin manually broadcasts
+ records tx hash for MVP). Withdrawal confirmation auto-detection from
the existing scanner is a follow-up.

## Chains

Both from day 1:

| Chain | Library | USDT contract | Confirmations |
| --- | --- | --- | --- |
| TRC20 | `github.com/fbsobreira/gotron-sdk` | `TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t` | 19 |
| ERC20 | `github.com/ethereum/go-ethereum` | `0xdAC17F958D2ee523a2206206994597C13D831ec7` | 12 |

## Deposit flow

1. Subscribe/scan for USDT `Transfer(from, to, value)` events to any address
   in `deposit_addresses`.
2. `INSERT INTO deposits (network, tx_hash, log_index, to_address,
   amount_micro, confirmations=0, status='seen', block_number)` with
   unique key `(network, tx_hash, log_index)` dedupe.
3. Each tick increment `confirmations`. At threshold, one transaction:
   - `UPDATE deposits SET status='credited', credited_at=NOW()`
   - `UPDATE wallets SET balance_micro = balance_micro + amount_micro`
   - `INSERT INTO wallet_ledger (user_id, delta_micro=amount, type='deposit',
      ref_type='deposit', ref_id=deposits.id, tx_hash=...)` — the unique
      partial index on `wallet_ledger(type, ref_type, ref_id)` makes this
      idempotent even across crashes.

## Withdrawal flow (Phase 7 manual approval)

1. User `POST /wallet/withdrawals` → `withdrawals` row, `status='requested'`.
2. Admin approves → `status='approved'`.
3. Signer service (separate container, Phase 7 exit criterion) signs and
   submits a tx → `status='submitted'`, `tx_hash=...`.
4. Watcher confirms → `status='confirmed'`, debit `wallets` + write a
   ledger `withdrawal` row (`ref_id=withdrawals.id`).

## Chain reorgs

- If a previously-seen deposit's block is reorged out,
  `status='orphaned'` and we don't credit. If we already credited at a
  shallower confirmation than configured (shouldn't), that's an incident
  and requires an `adjustment` ledger entry with audit log.

## Invariants

- Never credit without the required confirmations.
- Address → user mapping is derived from `deposit_addresses`; we don't
  guess.
- HD master mnemonic is in `.env` for MVP; moves to a dedicated signer
  container before public launch.
