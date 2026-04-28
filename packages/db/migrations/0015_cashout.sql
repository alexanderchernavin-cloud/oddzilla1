-- 0014_cashout.sql
--
-- Cashout feature: lets a punter sell back an open ticket before it settles.
--
-- The math (chapter 2.1.1 of Sportradar's Cashout doc, mirrored in
-- /Cashout/Cashout_Function_201119.pdf): the fair "ticket value at time t" is
--
--     stake * ticketOdds * P(ticket wins now)
--
-- For combos, P(ticket wins now) is the product of each leg's current
-- probability. Settled-won legs collapse to p=1 (drop out); settled-lost legs
-- collapse the whole offer to 0; void legs drop out and the leg's odds are
-- normalized out of ticketOdds. Inactive (suspended) markets make cashout
-- unavailable for that ticket.
--
-- Oddin's odds_change carries `probabilities="0.368"` per outcome (verified
-- on the integration broker 2026-04-28). We start persisting it here.
--
-- Schema additions:
--   1. probability columns on market_outcomes / odds_history (live + audit)
--   2. probability_at_placement on ticket_selections (so we know baseline)
--   3. wallet_tx_type += 'cashout' for the ledger row
--   4. cashout_config — cascade global → sport → tournament → market_type
--      (mirrors odds_config). Carries enabled flag, prematch full-stake
--      window, optional deduction ladder for chapter-2.1.2 cashout.
--   5. cashouts — quote/accept records; one accepted row per ticket.

BEGIN;

-- 1. Probability columns -----------------------------------------------------

ALTER TABLE market_outcomes
    ADD COLUMN probability NUMERIC(8, 7);

ALTER TABLE odds_history
    ADD COLUMN probability NUMERIC(8, 7);

ALTER TABLE ticket_selections
    ADD COLUMN probability_at_placement NUMERIC(8, 7);

-- 2. Extend wallet_tx_type with the cashout credit -------------------------

ALTER TYPE wallet_tx_type ADD VALUE IF NOT EXISTS 'cashout';

-- 3. cashout_config -----------------------------------------------------------

CREATE TABLE cashout_config (
    id                              SERIAL       PRIMARY KEY,
    scope                           odds_scope   NOT NULL,
    scope_ref_id                    TEXT,
    enabled                         BOOLEAN      NOT NULL DEFAULT TRUE,
    -- Within this many seconds of placement, while the match has not yet
    -- started, return full stake as the cashout offer (the
    -- "cancel-as-cashout" cooling-off window).
    prematch_full_payback_seconds   INTEGER      NOT NULL DEFAULT 0
        CHECK (prematch_full_payback_seconds >= 0
           AND prematch_full_payback_seconds <= 86400),
    -- Optional deduction ladder for chapter 2.1.2 of the Sportradar doc.
    -- JSON array of { factor: number, deduction: number } sorted by factor
    -- ascending. NULL or [] = pure simple cashout (chapter 2.1.1).
    deduction_ladder_json           JSONB,
    -- Below this absolute offer in micro_usdt, we return "unavailable"
    -- rather than offering a tiny cashout.
    min_offer_micro                 BIGINT       NOT NULL DEFAULT 0
        CHECK (min_offer_micro >= 0),
    -- "Significant change" gate (Sportradar §2.1.1 second paragraph): only
    -- offer cashout when |currentValue / stake - 1| >= bp/10000. Defaults
    -- to 0 (always offer once available).
    min_value_change_bp             INTEGER      NOT NULL DEFAULT 0
        CHECK (min_value_change_bp >= 0 AND min_value_change_bp <= 10000),
    updated_by                      UUID         REFERENCES users(id),
    updated_at                      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    UNIQUE (scope, scope_ref_id)
);

-- Same NULL trick as odds_config 0010: protect against duplicate globals.
CREATE UNIQUE INDEX cashout_config_global_unique
    ON cashout_config (scope)
    WHERE scope = 'global';

INSERT INTO cashout_config
    (scope, scope_ref_id, enabled, prematch_full_payback_seconds,
     deduction_ladder_json, min_offer_micro, min_value_change_bp)
VALUES
    ('global', NULL, TRUE, 600, NULL, 100000, 0);
-- Defaults: enabled, 600s (10 min) prematch full-stake window, no
-- deduction ladder, offer floor 0.10 USDT (100,000 micro), no
-- significant-change gate.

-- 4. cashouts ----------------------------------------------------------------

CREATE TYPE cashout_status AS ENUM (
    'offered', 'accepted', 'declined', 'expired', 'errored', 'unavailable'
);

CREATE TABLE cashouts (
    id                          UUID            PRIMARY KEY DEFAULT gen_random_uuid(),
    ticket_id                   UUID            NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
    user_id                     UUID            NOT NULL REFERENCES users(id),
    status                      cashout_status  NOT NULL DEFAULT 'offered',
    offered_micro               BIGINT          NOT NULL CHECK (offered_micro >= 0),
    payout_micro                BIGINT          CHECK (payout_micro IS NULL OR payout_micro >= 0),
    -- Snapshot of the inputs the offer was computed from. Useful for
    -- audit and customer-support disputes.
    ticket_odds_snapshot        NUMERIC(20, 4)  NOT NULL,
    probability_snapshot        NUMERIC(20, 18) NOT NULL,
    deduction_factor_snapshot   NUMERIC(8, 4),
    reason                      TEXT,
    requested_at                TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
    expires_at                  TIMESTAMPTZ     NOT NULL,
    accepted_at                 TIMESTAMPTZ,
    executed_at                 TIMESTAMPTZ
);
CREATE INDEX cashouts_ticket_idx ON cashouts (ticket_id, requested_at DESC);
CREATE INDEX cashouts_user_idx   ON cashouts (user_id, requested_at DESC);
-- One accepted cashout per ticket. Other statuses can repeat (offer history).
CREATE UNIQUE INDEX cashouts_ticket_accepted_unique
    ON cashouts (ticket_id)
    WHERE status = 'accepted';

COMMIT;
