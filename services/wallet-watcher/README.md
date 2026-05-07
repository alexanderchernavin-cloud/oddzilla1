# services/wallet-watcher

Verifies user-claimed Ethereum USDC deposits and credits wallets on
confirmation. Go 1.23.

## How it works (post migration 0032)

The service no longer scans block ranges. Users send USDC to a single
shared receive address (configured via `DEPOSIT_RECEIVE_ADDRESS`) and
post their tx hash through `POST /wallet/deposits/intent`. That writes
a `deposit_intents` row in `pending` state.

Every poll tick the watcher:

1. Pulls intents in `{pending, confirming}`.
2. Calls `eth_getTransactionReceipt` for each.
3. Inspects the receipt for a `Transfer(from, to, amount)` log emitted
   by the configured USDC contract whose `to` matches the receive
   address. No matching log → reject the intent. Reverted tx → reject.
4. Counts confirmations against the chain head.
5. At threshold, re-checks the canonical block hash to detect a reorg
   between sighting and credit.
6. Credits atomically: `UPDATE deposit_intents SET status='credited'`,
   `UPDATE wallets SET balance_micro += amount` (currency='USDC'),
   `INSERT wallet_ledger (type='deposit', ref_type='deposit_intent',
   ref_id=intent.id)`. The wallet_ledger unique partial index on
   `(type, ref_type, ref_id)` is the last-resort double-credit guard.

Idle behaviour: if `ETH_RPC_URL` or `DEPOSIT_RECEIVE_ADDRESS` is empty
the loop is skipped and `/healthz` reports `ethereum.enabled = false`.

## Sub-packages

- `internal/ethereum` — JSON-RPC client (`eth_blockNumber`,
  `eth_getTransactionReceipt`, `eth_getBlockByNumber`) + a `Verifier`
  that adapts the client to the deposits package contract.
- `internal/deposits` — intent processor (resolves, validates, counts
  confirmations, credits).
- `internal/store` — pgx queries against `deposit_intents` (list
  pending, mark confirming, update confs, credit, reject).
- `internal/config` — env parsing.

## Chain

| Chain | USDC contract | Confirmations |
| --- | --- | --- |
| ERC20 | `0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48` | 12 |

Override the contract via `ETH_USDC_CONTRACT` for testnets.

## Withdrawal flow (manual)

Withdrawals are admin-driven end-to-end. The user opens a request via
`POST /wallet/withdrawals`; an admin approves, broadcasts USDC from an
external wallet, and pastes the tx hash via `mark-submitted`. A
different admin marks confirmed (4-eyes). wallet-watcher does **not**
participate in withdrawal lifecycle.

## Chain reorgs

If a recorded `block_hash` no longer matches the canonical chain at
its `block_number` when threshold confirmations are reached, the
intent stays in `confirming` and is re-evaluated on the next tick. If
the chain settles without re-including the tx, an admin can reject
the intent manually via `/admin/deposits/:id/reject`.
