-- 0024_deposit_reorg_safety.sql
--
-- Capture the on-chain block_hash at insert time so the deposit
-- processor can verify the canonical chain still contains the same
-- block before crediting. Without this, a chain reorg that drops a
-- previously-seen tx still produces a credit (the threshold is met
-- via plain block-height arithmetic), letting an attacker fund a
-- withdrawal from an orphaned deposit.
--
-- Nullable on purpose: existing pre-migration rows have no hash; the
-- processor treats NULL as "verify by lookup" via the deposit's
-- block_number.

ALTER TABLE deposits
    ADD COLUMN block_hash TEXT;
