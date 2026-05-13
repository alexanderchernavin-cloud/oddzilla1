-- 0048_wrong_token_deposits.sql
--
-- Surface "user sent the wrong coin to our USDC receive address" as
-- an explicit admin signal instead of swallowing it into a generic
-- rejection. Two complementary slices, both keyed off ERC20 today:
--
--   1. deposit_intents picks up four columns so a rejected intent
--      can carry the diagnostic: which token contract showed up,
--      how much (raw uint256, since the unknown token's decimals
--      may not be 6), and an acknowledge stamp for the admin alert.
--      We mark these rows via failure_reason = 'wrong_token' so the
--      existing rejected-status filter still works AND the new
--      Wrong Token tab can sub-filter without a schema enum change.
--
--   2. unattributed_deposits is a fresh table that records EVERY
--      ERC20 Transfer to the receive address whose contract isn't
--      our USDC contract. wallet-watcher fills it from a second,
--      contract-unfiltered eth_getLogs scan that runs alongside
--      the USDC discovery scan, so we catch the "sent and didn't
--      paste a hash" case too. Keyed by (network, tx_hash,
--      log_index) so the same multi-Transfer tx doesn't collide.
--
-- Both surfaces are unacked-by-default; partial indexes let the
-- admin shell pull the count for the badge in one tiny scan.

BEGIN;

-- 1. Wrong-token enrichment on intents -------------------------------
ALTER TABLE deposit_intents
  ADD COLUMN detected_token_contract   TEXT,
  ADD COLUMN detected_token_amount_raw NUMERIC(78, 0),
  ADD COLUMN acknowledged_at           TIMESTAMPTZ,
  ADD COLUMN acknowledged_by_user_id   UUID REFERENCES users(id) ON DELETE SET NULL;

CREATE INDEX deposit_intents_wrong_token_unack_idx
  ON deposit_intents (submitted_at DESC)
 WHERE failure_reason = 'wrong_token' AND acknowledged_at IS NULL;

-- 2. Unattributed deposits -------------------------------------------
CREATE TABLE unattributed_deposits (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  network                 chain_network NOT NULL DEFAULT 'ERC20',
  tx_hash                 TEXT NOT NULL,
  log_index               INTEGER NOT NULL,
  block_number            BIGINT NOT NULL,
  block_hash              TEXT NOT NULL,
  from_address            TEXT NOT NULL,
  to_address              TEXT NOT NULL,
  token_contract          TEXT NOT NULL,
  token_symbol            TEXT,
  token_decimals          SMALLINT,
  amount_raw              NUMERIC(78, 0) NOT NULL,
  detected_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  acknowledged_at         TIMESTAMPTZ,
  acknowledged_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  note                    TEXT,
  CONSTRAINT unattributed_deposits_unique
    UNIQUE (network, tx_hash, log_index),
  CONSTRAINT unattributed_deposits_amount_pos
    CHECK (amount_raw > 0),
  CONSTRAINT unattributed_deposits_decimals_range
    CHECK (token_decimals IS NULL OR (token_decimals >= 0 AND token_decimals <= 36))
);

CREATE INDEX unattributed_deposits_unack_idx
  ON unattributed_deposits (detected_at DESC)
 WHERE acknowledged_at IS NULL;

COMMIT;
