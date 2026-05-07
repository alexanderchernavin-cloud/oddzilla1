-- 0037_riskzilla.sql
--
-- RiskZilla — internal Risk Management Service. Enforces per-match
-- liability caps, min stake, max payout and per-bettor bet factor at
-- placement time, tracks operator bankroll across the lifetime of every
-- ticket, and records every accept / reject decision for the live
-- Betticker + historical Bets viewer in the admin panel.
--
-- Modelled on the Oddin Trading Service (HumanDocs/Oddin.gg Trading
-- Service documentation.docx §7.2.1.1.2.1.1) and Sportradar MTS reject
-- codes (STAKE_TOO_LOW / STAKE_TOO_HIGH / MAX_PAYOUT_BREACHED /
-- EVENT_LIABILITY_BREACHED / BETTOR_LIABILITY_BREACHED). We do not
-- integrate either — this is the internal equivalent.
--
-- All money columns are BIGINT _micro (CLAUDE.md invariant 1). Limits
-- and ledger entries are USDC-only — OZ is the demo currency, has no
-- real-money exposure, and is filtered out at the engine boundary.

-- ── 1. Per-bettor risk score ───────────────────────────────────────────
-- RS ∈ [0.01, 10]. Multiplier on the bettor's effective slice of match
-- liability. 1 = neutral; 0.01 = pariah; 10 = sharp / VIP. Frontend
-- exposes this in the bettor profile editor.
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS risk_score numeric(4, 3) NOT NULL DEFAULT 1.000;

ALTER TABLE users
  ADD CONSTRAINT users_risk_score_range
  CHECK (risk_score >= 0.01 AND risk_score <= 10);

-- ── 2. Per-tier defaults ───────────────────────────────────────────────
-- Tier 0 = global fallback (used when the tournament's risk_tier is NULL
-- or set to a value with no row here). Tiers 1..6 mirror Oddin's
-- tournaments.risk_tier. Inserts here are seeded; admins overwrite via
-- PUT and never insert new tier values from the UI (they'd be unused
-- since Oddin only emits 1..6).
CREATE TABLE IF NOT EXISTS riskzilla_settings (
  tier                  smallint    PRIMARY KEY,
  match_liability_micro bigint      NOT NULL,
  min_bet_micro         bigint      NOT NULL,
  max_payout_micro      bigint      NOT NULL,
  -- Fraction of match liability one user can take (default 0.1 = 10%).
  -- Stored at NUMERIC(5,4) so 0.0001..1.0000 inclusive is representable.
  bet_factor            numeric(5, 4) NOT NULL DEFAULT 0.1000,
  updated_by            uuid        REFERENCES users(id) ON DELETE SET NULL,
  updated_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT riskzilla_settings_tier_range
    CHECK (tier >= 0 AND tier <= 32),
  CONSTRAINT riskzilla_settings_match_liability_pos
    CHECK (match_liability_micro > 0),
  CONSTRAINT riskzilla_settings_min_bet_pos
    CHECK (min_bet_micro > 0),
  CONSTRAINT riskzilla_settings_max_payout_pos
    CHECK (max_payout_micro > 0),
  CONSTRAINT riskzilla_settings_bet_factor_range
    CHECK (bet_factor > 0 AND bet_factor <= 1.0000)
);

-- Defaults: 0.1 USDC min bet, 1000 USDC max payout, 10% bet factor,
-- match-liability ladder per tier so featured (1-2) are higher than long
-- tail. Operators tune via /admin/riskzilla/settings.
INSERT INTO riskzilla_settings (tier, match_liability_micro, min_bet_micro, max_payout_micro, bet_factor)
VALUES
  (0,   5000000000,    100000, 1000000000, 0.1000),  -- global fallback: 5,000 USDC liability
  (1,  50000000000,    100000, 5000000000, 0.1000),  -- 50,000 USDC, 5,000 max payout
  (2,  25000000000,    100000, 2500000000, 0.1000),  -- 25,000 USDC, 2,500 max payout
  (3,  10000000000,    100000, 1000000000, 0.1000),  -- 10,000 USDC
  (4,   5000000000,    100000, 1000000000, 0.1000),
  (5,   2500000000,    100000,  500000000, 0.1000),
  (6,   1000000000,    100000,  500000000, 0.1000)
ON CONFLICT (tier) DO NOTHING;

-- ── 3. Per-market multiplier ───────────────────────────────────────────
-- factor ∈ [0.000, 1.000]. Down-only — never amplifies liability. Keyed
-- by Oddin's provider_market_id (NOT our internal markets.id) so a row
-- here applies to every market of that type across every match. 1.000 is
-- the implicit default for unconfigured market types (no row).
CREATE TABLE IF NOT EXISTS riskzilla_market_factors (
  provider_market_id integer    PRIMARY KEY,
  factor             numeric(4, 3) NOT NULL DEFAULT 1.000,
  label              text       NOT NULL,
  notes              text,
  updated_by         uuid       REFERENCES users(id) ON DELETE SET NULL,
  updated_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT riskzilla_market_factors_factor_range
    CHECK (factor >= 0.000 AND factor <= 1.000)
);

-- ── 4. Bankroll state + ledger ─────────────────────────────────────────
-- Single-row bank state. bank_limit_micro is the running operator
-- bankroll: it grows when bettors lose (we keep their stake) and shrinks
-- when bettors win (we pay them out). Manual seed and adjustments are
-- gated to a hard-coded admin email at the API layer.
--
-- open_liability_micro is the cached sum of worst-case-loss across all
-- matches with open tickets, refreshed by the engine on every placement
-- and every settlement. Invariant enforced at placement time:
--   open_liability + this_bet_max_loss ≤ bank_limit
-- A drift between cache and recompute is detectable via the engine's
-- /admin/riskzilla/bank/recompute endpoint.
CREATE TABLE IF NOT EXISTS riskzilla_bank_state (
  id                    text        PRIMARY KEY DEFAULT 'default',
  bank_limit_micro      bigint      NOT NULL DEFAULT 100000000000,  -- 100,000 USDC seed
  open_liability_micro  bigint      NOT NULL DEFAULT 0,
  updated_by            uuid        REFERENCES users(id) ON DELETE SET NULL,
  updated_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT riskzilla_bank_state_singleton CHECK (id = 'default'),
  CONSTRAINT riskzilla_bank_state_limit_nonneg CHECK (bank_limit_micro >= 0),
  CONSTRAINT riskzilla_bank_state_open_nonneg CHECK (open_liability_micro >= 0)
);

INSERT INTO riskzilla_bank_state (id) VALUES ('default')
  ON CONFLICT (id) DO NOTHING;

-- Ledger: append-only audit trail of every change to bank_limit. Bet
-- settlement writes one row per ticket lifecycle terminal event. Manual
-- seed / adjustments by the bank admin write a row here as well, keeping
-- a forensic record of who moved the bankroll and when.
CREATE TYPE riskzilla_bank_ledger_type AS ENUM (
  'seed',           -- initial / one-off operator funding (manual)
  'bet_loss',       -- bettor lost a ticket; stake added to bank
  'bet_payout',     -- bettor won; payout subtracted from bank
  'bet_refund',     -- voided ticket; stake released back to user (no bank impact, recorded for audit)
  'manual_adjust'   -- bank admin tweaks the limit
);

CREATE TABLE IF NOT EXISTS riskzilla_bank_ledger (
  id              bigserial   PRIMARY KEY,
  delta_micro     bigint      NOT NULL,
  type            riskzilla_bank_ledger_type NOT NULL,
  ref_type        text,
  ref_id          text,
  actor_user_id   uuid        REFERENCES users(id),
  memo            text,
  created_at      timestamptz NOT NULL DEFAULT now()
);

-- Idempotency for settlement-driven ledger writes: re-settlements use
-- the `<ticketID>:N` generation suffix as ref_id (same convention
-- wallet_ledger uses) so a replayed bet_settlement message never
-- double-counts.
CREATE UNIQUE INDEX IF NOT EXISTS riskzilla_bank_ledger_ref_unique
  ON riskzilla_bank_ledger (type, ref_type, ref_id)
  WHERE ref_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS riskzilla_bank_ledger_created_idx
  ON riskzilla_bank_ledger (created_at DESC);

-- ── 5. Decision event log ──────────────────────────────────────────────
-- Every placement attempt produces exactly one row here, whether
-- accepted or rejected. Powers two admin pages:
--   - /admin/riskzilla/betticker — live tail with filter pills
--   - /admin/riskzilla/bets       — historical search
--
-- ticket_id is NULL for rejected attempts (no ticket row created).
-- Decision metadata (which limit fired, snapshot of bank balance, RS,
-- per-market liability breakdown) lives in decision_meta jsonb so we
-- can evolve the schema without a migration per metric added.
CREATE TYPE riskzilla_decision AS ENUM (
  'accepted',
  'rejected_min_stake',
  'rejected_max_payout',
  'rejected_match_liability',
  'rejected_bet_factor',
  'rejected_bank_limit',
  'rejected_user_blocked',
  'rejected_market_factor'
);

CREATE TABLE IF NOT EXISTS riskzilla_event_log (
  id                       bigserial   PRIMARY KEY,
  ticket_id                uuid        REFERENCES tickets(id) ON DELETE SET NULL,
  user_id                  uuid        NOT NULL REFERENCES users(id),
  decision                 riskzilla_decision NOT NULL,
  reason_message           text,
  currency                 char(4)     NOT NULL,
  stake_micro              bigint      NOT NULL,
  potential_payout_micro   bigint      NOT NULL,
  match_id                 bigint      REFERENCES matches(id) ON DELETE SET NULL,
  sport_id                 integer     REFERENCES sports(id)  ON DELETE SET NULL,
  tournament_id            integer     REFERENCES tournaments(id) ON DELETE SET NULL,
  risk_tier                smallint,
  rs_at_decision           numeric(4, 3) NOT NULL,
  bank_at_decision_micro   bigint      NOT NULL,
  decision_meta            jsonb       NOT NULL DEFAULT '{}'::jsonb,
  created_at               timestamptz NOT NULL DEFAULT now()
);

-- Betticker queries: live tail filtered by decision/sport/match/tier/user.
CREATE INDEX IF NOT EXISTS riskzilla_event_log_created_idx
  ON riskzilla_event_log (created_at DESC);
CREATE INDEX IF NOT EXISTS riskzilla_event_log_user_idx
  ON riskzilla_event_log (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS riskzilla_event_log_match_idx
  ON riskzilla_event_log (match_id, created_at DESC);
CREATE INDEX IF NOT EXISTS riskzilla_event_log_decision_idx
  ON riskzilla_event_log (decision, created_at DESC);
CREATE INDEX IF NOT EXISTS riskzilla_event_log_ticket_idx
  ON riskzilla_event_log (ticket_id)
  WHERE ticket_id IS NOT NULL;
