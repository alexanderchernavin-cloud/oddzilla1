-- 0076_oz_ledger.sql
--
-- Oz loyalty-point ledger. First piece of the analyst-rewards
-- pipeline (Publisher rewards philosophy → Reward formula V1 mapping;
-- corwyn/prototypes/analyst-journey models the surface).
--
-- V1 is earn-only, loyalty-points-only. No spend flow, no wagering
-- credit, no cash equivalence. CHECK (delta > 0) enforces that at the
-- DB level; the constraint is intentional and will be relaxed in the
-- migration that introduces the first redemption path. Until then, an
-- attempted negative-delta INSERT is a bug, not a missing feature.
--
-- Two tables:
--
--   oz_ledger
--     Append-only event log. One row per Oz credit. `idempotency_key`
--     UNIQUE is load-bearing: every triggering write path
--     (admin endpoint, future engagement-floor hook, future settlement
--     hook) constructs a deterministic key and relies on this index
--     to make double-credit on retry a no-op. Without this, a
--     settlement webhook retry would re-credit the same analysis on
--     every replay — and the leaderboard reads from this table, so a
--     double-credit is publicly visible, not just an accounting
--     artefact.
--
--   oz_balance_user
--     Materialised current balance. One row per user, lazily inserted
--     on first credit. The ledger is the source of truth; this table
--     is a denormalised projection updated by the same service code
--     that writes the ledger row, in the same transaction. SUM-on-
--     read over the ledger is O(events-per-user); a PK lookup here is
--     O(1).
--
-- Why no DB trigger maintaining the balance:
--   Same convention as community_tickets / community_author_stats —
--   projection writes live in TypeScript where reviewers actually
--   look (see services/api/src/modules/community/projection.ts). A
--   trigger would hide the increment from code review and make the
--   observability story harder (we want a log line per credit, not a
--   silent row mutation).
--
-- Why a single ledger, not one table per reason:
--   The reward catalog is open-ended (analysis engagement floor,
--   inspiration milestone, settlement bonus, future ZillaPass task
--   payouts, manual adjustments). One table + a `reason` discriminator
--   keeps the read path uniform: "show my Oz history" is a single
--   ORDER BY created_at DESC, not a UNION across N tables.

BEGIN;

CREATE TABLE oz_ledger (
    id              BIGSERIAL PRIMARY KEY,
    user_id         UUID    NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    -- Positive integer. CHECK enforces earn-only at the schema level
    -- until the redemption migration relaxes it. Storing as BIGINT
    -- (not INT) for parity with community_tickets.inspiration_count
    -- — same audit-SEC-L2 overflow rationale.
    delta           BIGINT  NOT NULL CHECK (delta > 0),
    -- Open-ended discriminator. Kept TEXT (not an ENUM) so the reward
    -- catalog can grow without a migration; the writer constructs the
    -- string. Conventional values:
    --   'admin_credit'                  — manual admin mint
    --   'analysis_engagement_floor'     — ≥10 inspirations on an analysis
    --   'analysis_inspirations_milestone' — 500-inspiration bonus
    --   'analysis_win_bonus'            — analysis outcome = 'won'
    reason          TEXT    NOT NULL,
    -- Type and id of the entity that triggered the credit, when one
    -- exists. NULL on admin credits keyed only by nonce.
    --   ('analysis', analyses.id)
    --   ('admin',    nonce — used to make idempotency_key unique)
    source_kind     TEXT,
    source_id       TEXT,
    -- Deterministic dedup key. Every writer constructs this from the
    -- (reason, source) pair so retries are no-ops. Format suggestions:
    --   'analysis_engagement_floor:<analysis_uuid>'
    --   'analysis_win_bonus:<analysis_uuid>'
    --   'admin_credit:<admin_uuid>:<nonce>'
    idempotency_key TEXT    NOT NULL UNIQUE,
    -- For admin credits: which admin minted this. NULL on system
    -- credits (engagement-floor / win-bonus hooks).
    created_by      UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- "Show my Oz history" reads from this index. Also covers the
-- leaderboard's 30d-accrued aggregate via the (user_id, created_at)
-- prefix and the partial planner stats it implies for recent-events
-- queries.
CREATE INDEX oz_ledger_user_created_idx
    ON oz_ledger (user_id, created_at DESC);

-- Leaderboard scan: SUM(delta) WHERE created_at >= now() - 30d
-- GROUP BY user_id. Index on created_at supports the time window
-- predicate; the planner can then bitmap-and with the user_id index
-- above for the per-user aggregation.
CREATE INDEX oz_ledger_created_at_idx
    ON oz_ledger (created_at DESC);

CREATE TABLE oz_balance_user (
    user_id     UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    balance     BIGINT NOT NULL DEFAULT 0 CHECK (balance >= 0),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMIT;
