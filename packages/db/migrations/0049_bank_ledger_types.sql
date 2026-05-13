-- New riskzilla_bank_ledger types so the bank can track the operator's
-- real crypto-account cash position (seed + credited deposits −
-- confirmed withdrawals + admin adjustments) instead of a running
-- counter that's also moved by every bet outcome.
--
-- Bet wins/losses don't move crypto — they only redistribute between
-- bettors' DB wallet rows and the operator's profit pool. The
-- companion migration 0050 stops settlement from writing bet_loss /
-- bet_payout / bet_refund rows against the bank, backfills historical
-- deposit / withdrawal events, and recomputes the singleton
-- bank_limit_micro.
--
-- PG 12+ allows ALTER TYPE ADD VALUE inside a transaction, but the new
-- enum value cannot be USED in the same transaction. That's why this
-- migration only adds the values; 0050 inserts ledger rows with them.

ALTER TYPE riskzilla_bank_ledger_type ADD VALUE IF NOT EXISTS 'deposit_credit';
ALTER TYPE riskzilla_bank_ledger_type ADD VALUE IF NOT EXISTS 'withdrawal_debit';
