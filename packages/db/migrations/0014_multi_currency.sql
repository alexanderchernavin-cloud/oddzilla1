-- Multi-currency support. Adds the demo "OZ" currency alongside USDT for
-- testing bet calculation, the bet slip, and settlement without touching
-- real money. Each user gets one wallet row per currency.
--
--   • wallets: composite PK (user_id, currency) — was (user_id) only
--   • wallet_ledger: add currency column
--   • tickets: add currency column
--
-- Withdrawals/deposits stay USDT-only at the schema level (no on-chain
-- movement is possible for OZ); the deposit/withdrawal credit paths in
-- wallet-watcher and admin/withdrawals.ts now scope their wallet updates
-- to currency='USDT' explicitly.
--
-- Backfill is straightforward: every existing row is USDT.

BEGIN;

-- ── wallets: composite PK ────────────────────────────────────────────────
ALTER TABLE wallets DROP CONSTRAINT wallets_pkey;
ALTER TABLE wallets ADD CONSTRAINT wallets_pkey PRIMARY KEY (user_id, currency);

-- ── wallet_ledger: currency column ───────────────────────────────────────
ALTER TABLE wallet_ledger
  ADD COLUMN currency CHAR(4) NOT NULL DEFAULT 'USDT';

-- Existing rows already default to USDT; lock that in but keep the default
-- so callers that omit currency don't break (they'll all be USDT-era code
-- anyway during the rollout).

-- ── tickets: currency column ─────────────────────────────────────────────
ALTER TABLE tickets
  ADD COLUMN currency CHAR(4) NOT NULL DEFAULT 'USDT';

-- ── New unique partial index on wallet_ledger ────────────────────────────
-- The existing (type, ref_type, ref_id) WHERE ref_id IS NOT NULL still
-- holds — currency is not part of the apply-once key because a single
-- ticket / deposit / withdrawal is always denominated in one currency, so
-- the (type, ref_type, ref_id) tuple is already unique across currencies.

COMMIT;
