-- 0033_user_wallet_addresses.sql
--
-- Per-user from-address whitelist for the single shared receive
-- address introduced in 0032. The wallet-watcher polls Alchemy for
-- USDC `Transfer` logs to the receive address and looks up `from`
-- here to attribute the deposit to a user — no tx-hash paste
-- required when the sender is whitelisted.
--
-- Address is stored lowercase-normalised so the unique index works
-- without case-folding at query time. The CHECK rejects anything that
-- doesn't match the ERC20 shape; address is normalised at the API
-- before insert.
--
-- ON DELETE CASCADE on user_id: if a user is deleted, drop their
-- linked addresses too. The (network, address) UNIQUE prevents two
-- users claiming the same wallet — first writer wins.

BEGIN;

CREATE TABLE user_wallet_addresses (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  network     chain_network NOT NULL DEFAULT 'ERC20',
  address     TEXT NOT NULL,
  label       TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT user_wallet_addresses_addr_unique UNIQUE (network, address),
  CONSTRAINT user_wallet_addresses_addr_format CHECK (address ~ '^0x[0-9a-f]{40}$')
);

CREATE INDEX user_wallet_addresses_user_idx ON user_wallet_addresses(user_id, created_at DESC);

COMMIT;
