-- 0032_usdc_payments.sql
--
-- Switch the on-chain currency from USDT to USDC and replace the
-- per-user HD-derived deposit address with a single shared receive
-- address whose deposits are attributed to users by an explicit
-- tx-hash claim (deposit_intents).
--
-- Why now: the API was previously running an HD-wallet flow per user
-- with TRC20 + ERC20 USDT support. That added two chains, one signer
-- container, and ~70 lines of derivation/lookup glue for what at MVP
-- is a low-volume manual operation. The new model is single shared
-- ERC20 address (operator-managed), USDC only, and the user pastes
-- their tx hash after sending so we can credit the right wallet.
-- Withdrawals stay manual, admin-driven.
--
-- Effects:
--   1. Currency rename USDT → USDC across wallets/wallet_ledger/tickets
--      rows + their column DEFAULTs. The CHAR(4) width fits both codes.
--   2. Drops deposit_addresses (no per-user HD). The deposits table is
--      kept for historical audit; no new rows are written to it.
--   3. New deposit_intents table is the working surface: user posts a
--      tx hash, wallet-watcher fetches the receipt, validates the
--      USDC Transfer to the shared address, counts confirmations,
--      and credits the wallet atomically.
--
-- Compatibility:
--   - chain_network enum still carries TRC20 + ERC20 values; the app
--     no longer writes TRC20 anywhere. Removing an enum value would
--     require renaming the type, so we leave it dormant.
--   - The legacy deposits table stays; the wallet-watcher no longer
--     inserts into it. Existing rows (if any) remain visible.

BEGIN;

-- 1. Currency rename: USDT → USDC -------------------------------------
UPDATE wallets        SET currency = 'USDC' WHERE currency = 'USDT';
UPDATE wallet_ledger  SET currency = 'USDC' WHERE currency = 'USDT';
UPDATE tickets        SET currency = 'USDC' WHERE currency = 'USDT';

ALTER TABLE wallets       ALTER COLUMN currency SET DEFAULT 'USDC';
ALTER TABLE wallet_ledger ALTER COLUMN currency SET DEFAULT 'USDC';
ALTER TABLE tickets       ALTER COLUMN currency SET DEFAULT 'USDC';

-- 2. Drop the legacy per-user deposit address table ------------------
-- Per-user HD addresses were the previous attribution channel. With a
-- single shared receive address, this table has no role.
DROP TABLE IF EXISTS deposit_addresses;

-- 3. New deposit_intents table ---------------------------------------
CREATE TYPE deposit_intent_status AS ENUM (
  'pending',     -- user submitted; watcher hasn't confirmed yet
  'confirming',  -- on-chain receipt found; counting confirmations
  'credited',    -- credited to wallet
  'rejected'     -- watcher couldn't validate (wrong contract / recipient / amount)
);

CREATE TABLE deposit_intents (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  network         chain_network NOT NULL DEFAULT 'ERC20',
  tx_hash         TEXT NOT NULL,
  to_address      TEXT,
  from_address    TEXT,
  amount_micro    BIGINT,
  block_number    BIGINT,
  block_hash      TEXT,
  log_index       INTEGER,
  confirmations   INTEGER NOT NULL DEFAULT 0,
  status          deposit_intent_status NOT NULL DEFAULT 'pending',
  failure_reason  TEXT,
  submitted_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  credited_at     TIMESTAMPTZ,
  rejected_at     TIMESTAMPTZ,
  CONSTRAINT deposit_intents_tx_unique UNIQUE (network, tx_hash),
  CONSTRAINT deposit_intents_amount_pos CHECK (amount_micro IS NULL OR amount_micro > 0)
);

-- Per-user history list (most recent first).
CREATE INDEX deposit_intents_user_idx
  ON deposit_intents(user_id, submitted_at DESC);

-- The wallet-watcher polls only intents that aren't done yet. Partial
-- index keeps it tiny.
CREATE INDEX deposit_intents_pending_idx
  ON deposit_intents(status)
 WHERE status IN ('pending', 'confirming');

-- 4. Park the chain_scanner_state row for TRC20 ----------------------
-- The scanner cursor was per-chain; with no TRC20 path the row is
-- inert. Drop it so health output doesn't surface a stale "tron" entry.
DELETE FROM chain_scanner_state WHERE chain = 'TRC20';

COMMIT;
