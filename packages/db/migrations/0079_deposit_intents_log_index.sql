-- 0079_deposit_intents_log_index
-- A single Ethereum tx can contain MORE THAN ONE ERC20 Transfer to the
-- shared receive address (batched / multi-send). deposit_intents was unique
-- on (network, tx_hash), so wallet-watcher's InsertDiscoveredIntent
-- (ON CONFLICT (network, tx_hash) DO NOTHING) silently DROPPED the second
-- transfer — an uncredited USDC deposit. Widen the key to
-- (network, tx_hash, log_index) so each distinct Transfer is its own intent,
-- while re-discovery of the same (tx, log_index) stays idempotent.
--
-- Post-0032 the user paste-a-tx-hash route is gone; intents are created only
-- by discovery, which always sets log_index, so existing rows have it
-- populated. The UPDATE is a defensive backfill for any legacy NULL.
-- NULLS NOT DISTINCT keeps the degenerate NULL case to one row per tx.
--
-- NOTE: no BEGIN/COMMIT — migrate.ts wraps each file in its own transaction.

UPDATE deposit_intents SET log_index = 0 WHERE log_index IS NULL;

ALTER TABLE deposit_intents DROP CONSTRAINT deposit_intents_tx_unique;

ALTER TABLE deposit_intents
  ADD CONSTRAINT deposit_intents_tx_log_unique
  UNIQUE NULLS NOT DISTINCT (network, tx_hash, log_index);
