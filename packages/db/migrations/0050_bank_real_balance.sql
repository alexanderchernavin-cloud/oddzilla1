-- Bank now reflects the operator's real crypto-account cash position:
--   seed
--   + Σ credited_deposits
--   − Σ confirmed_withdrawals   (only amount_micro; the fee stays with us)
--   + Σ admin_manual_adjustments
--
-- Previously bank_limit_micro was a manually-set ceiling that ALSO
-- moved on every bet settlement (bet_loss grew it, bet_payout shrank
-- it). Bet outcomes don't move crypto though — they only redistribute
-- between bettors' DB wallet rows and the operator's profit pool — so
-- folding them into the bank conflated two different things.
--
-- This migration:
--   1. Backfills historical deposit_credit and withdrawal_debit rows
--      into riskzilla_bank_ledger so the bank-page audit trail covers
--      pre-migration activity.
--   2. Recomputes riskzilla_bank_state.bank_limit_micro by stripping
--      the bet-outcome noise from the running counter and layering
--      the backfilled deposits/withdrawals on top.
--
-- The bet_loss / bet_payout / bet_refund / manual_adjust(ticket-reverse)
-- ledger rows are LEFT in the table as historical audit. Going forward,
-- settlement no longer writes those types (see
-- services/settlement/internal/store/store.go).

-- ── 1. Write a synthetic 'seed' baseline row FIRST ─────────────────────
-- The historical riskzilla_bank_state singleton was bootstrapped with
-- the column default (100,000 USDC per migration 0037) but no 'seed'
-- ledger row was ever written for it. Every later delta (admin
-- manual_adjust, bet_loss, bet_payout) was recorded against that
-- implicit baseline. For the new sum-the-ledger recompute formula to
-- produce the right number, we materialise that implicit baseline as
-- a real 'seed' row. By construction:
--   baseline = current_bank_limit_micro − Σ(all existing ledger deltas)
-- so SUM(ledger) post-insert == current_bank_limit_micro.
--
-- This MUST run before the deposit_credit / withdrawal_debit backfill
-- in step 2-4 so the SUM(existing) snapshot only includes pre-migration
-- ledger rows; otherwise the seed would absorb the backfilled deltas
-- and produce a baseline that's `current − new_deposits + new_withdrawals`
-- short of the true historical column default. Idempotent via the
-- unique partial index on (type, ref_type, ref_id).
INSERT INTO riskzilla_bank_ledger (delta_micro, type, ref_type, ref_id, memo, created_at)
SELECT
  (bs.bank_limit_micro - COALESCE(led.total_delta, 0))::bigint,
  'seed'::riskzilla_bank_ledger_type,
  'migration',
  '0050_baseline',
  'synthetic baseline (column default + historical state at migration time)',
  bs.updated_at
  FROM riskzilla_bank_state bs
  LEFT JOIN LATERAL (
    SELECT COALESCE(SUM(delta_micro), 0)::bigint AS total_delta
      FROM riskzilla_bank_ledger
  ) led ON TRUE
 WHERE bs.id = 'default'
ON CONFLICT (type, ref_type, ref_id) WHERE ref_id IS NOT NULL DO NOTHING;

-- ── 2. Backfill credited deposits from deposit_intents (post-0032 flow) ──
INSERT INTO riskzilla_bank_ledger (delta_micro, type, ref_type, ref_id, memo, created_at)
SELECT
  di.amount_micro,
  'deposit_credit'::riskzilla_bank_ledger_type,
  'deposit_intent',
  di.id::text,
  'backfilled from deposit_intents (0050)',
  COALESCE(di.credited_at, di.submitted_at)
FROM deposit_intents di
WHERE di.status = 'credited'
  AND di.amount_micro IS NOT NULL
  AND di.amount_micro > 0
ON CONFLICT (type, ref_type, ref_id) WHERE ref_id IS NOT NULL DO NOTHING;

-- ── 3. Backfill credited rows from legacy `deposits` table (pre-0032) ──
-- The table is dormant (migration 0032 stopped writes) but historical
-- rows still represent real crypto that arrived in the operator's
-- account.
INSERT INTO riskzilla_bank_ledger (delta_micro, type, ref_type, ref_id, memo, created_at)
SELECT
  d.amount_micro,
  'deposit_credit'::riskzilla_bank_ledger_type,
  'deposit',
  d.id::text,
  'backfilled from legacy deposits (0050)',
  COALESCE(d.credited_at, d.seen_at)
FROM deposits d
WHERE d.status = 'credited'
  AND d.amount_micro > 0
ON CONFLICT (type, ref_type, ref_id) WHERE ref_id IS NOT NULL DO NOTHING;

-- ── 4. Backfill confirmed withdrawals ──────────────────────────────────
-- Only the amount_micro leaves the operator's account; the fee stays
-- with us. Delta is negative because crypto flows out.
INSERT INTO riskzilla_bank_ledger (delta_micro, type, ref_type, ref_id, memo, created_at)
SELECT
  -w.amount_micro,
  'withdrawal_debit'::riskzilla_bank_ledger_type,
  'withdrawal',
  w.id::text,
  'backfilled from withdrawals (0050)',
  COALESCE(w.confirmed_at, w.submitted_at, w.approved_at, w.requested_at)
FROM withdrawals w
WHERE w.status = 'confirmed'
  AND w.amount_micro > 0
ON CONFLICT (type, ref_type, ref_id) WHERE ref_id IS NOT NULL DO NOTHING;

-- ── 5. Recompute bank_state.bank_limit_micro ───────────────────────────
-- Algorithm:
--   new = current
--         − Σ(bet_loss + bet_payout + bet_refund deltas)     [strip bet noise]
--         − Σ(manual_adjust where ref_type='ticket' deltas)  [legacy reverse rows]
--         + Σ(deposit_credit deltas)                         [includes backfill]
--         + Σ(withdrawal_debit deltas — already negative)    [includes backfill]
--
-- Edge case: if a big payout previously pushed the counter to 0 via
-- the column CHECK clamp, the recompute can't recover the lost
-- precision — the running counter is the only state we have. Operators
-- can do a manual_adjust afterwards if reconciliation against the
-- physical wallet shows drift. GREATEST(0, …) preserves the CHECK
-- invariant.
--
-- This UPDATE uses bank_state.bank_limit_micro BEFORE the synthetic
-- seed row was added (the seed delta = baseline that was already in
-- the column); the rest of the formula then strips bet noise and adds
-- the backfilled cash-flow rows. Post-update, the recompute formula
-- in /admin/riskzilla/bank/recompute (sum-of-ledger excluding bet
-- rows and ticket-reverse rows) reproduces the same number.
WITH delta_summary AS (
  SELECT
    COALESCE(SUM(CASE WHEN type IN ('bet_loss', 'bet_payout', 'bet_refund')
                      THEN delta_micro ELSE 0 END), 0)::bigint  AS bet_delta,
    COALESCE(SUM(CASE WHEN type = 'manual_adjust' AND ref_type = 'ticket'
                      THEN delta_micro ELSE 0 END), 0)::bigint  AS ticket_reverse_delta,
    COALESCE(SUM(CASE WHEN type = 'deposit_credit'
                      THEN delta_micro ELSE 0 END), 0)::bigint  AS deposit_delta,
    COALESCE(SUM(CASE WHEN type = 'withdrawal_debit'
                      THEN delta_micro ELSE 0 END), 0)::bigint  AS withdrawal_delta
    FROM riskzilla_bank_ledger
)
UPDATE riskzilla_bank_state bs
   SET bank_limit_micro = GREATEST(
         0,
         bs.bank_limit_micro
           - ds.bet_delta
           - ds.ticket_reverse_delta
           + ds.deposit_delta
           + ds.withdrawal_delta
       )::bigint,
       updated_at = NOW()
  FROM delta_summary ds
 WHERE bs.id = 'default';
