-- 0030_audit_round3_indexes.sql
--
-- Round 3 audit follow-ups:
--   1. wallet_ledger composite index including currency. After 0014
--      added `wallet_ledger.currency`, every `/wallet/ledger?currency=X`
--      and dashboard PnL query filters on currency in addition to user_id
--      and time. The existing (user_id, created_at DESC) index has to
--      heap-scan to apply the currency filter; a (user_id, currency,
--      created_at DESC) index serves both shapes. Audit Schema L1.
--   2. tickets composite index including currency. Bet history queries
--      ("my settled USDT tickets") filter on currency too. Audit Schema L3.
--   3. wallet_ledger PnL-aggregation index. /admin/stats/pnl-by-day and
--      KPIs sum bet_stake / bet_payout / bet_refund inside a created_at
--      window; without a partial covering index they full-scan the
--      non-financial ledger rows (signup_bonus, withdrawal_request, etc.).
--      Audit Sec S4.
--   4. CHECK on users.email length. The TS zod cap is 320 chars; the DB
--      had no constraint, so a future bypass-zod insert path could land
--      a multi-MB email. Belt + suspenders. Audit Sec S3.

BEGIN;

-- 1. wallet_ledger (user_id, currency, created_at DESC).
--    CONCURRENTLY can't run inside a transaction; CREATE INDEX IF NOT
--    EXISTS is fine for this dataset (low millions of rows; brief lock).
CREATE INDEX IF NOT EXISTS wallet_ledger_user_currency_ts_idx
    ON wallet_ledger (user_id, currency, created_at DESC);

-- 2. tickets (user_id, currency, status, placed_at DESC).
CREATE INDEX IF NOT EXISTS tickets_user_currency_status_idx
    ON tickets (user_id, currency, status, placed_at DESC);

-- 3. wallet_ledger PnL-aggregation. Partial — only the three financial
--    types — keeps the index small and the dashboard query plan tight.
CREATE INDEX IF NOT EXISTS wallet_ledger_pnl_idx
    ON wallet_ledger (created_at DESC, type, currency)
    WHERE type IN ('bet_stake', 'bet_payout', 'bet_refund');

-- 4. users.email length CHECK. Matches the TS zod cap (320). RFC 5321
--    permits up to 254 in practice; the wider cap accommodates the
--    occasional multi-label addr. Existing rows stay valid.
ALTER TABLE users
    ADD CONSTRAINT users_email_length_chk
    CHECK (char_length(email) BETWEEN 3 AND 320);

COMMIT;
