-- 0078_community_experts.sql
--
-- Persisted "Expert" designation per (user, sport). Replaces the
-- visual rank-≤5 placeholder on the Top Authors leaderboard with a
-- real join.
--
-- V1 mode is manual: admins nominate via POST /admin/community/experts
-- (and revoke via DELETE). The Reward formula V1 spec calls for a
-- monthly auto-recalc (top-5 per sport, max 2 sports per analyst);
-- that cron job lands in a follow-up PR once we have observable
-- leaderboard data to validate the ranking algorithm against. Until
-- then, ops manages the table by hand.
--
-- Why time-bound (`valid_until`):
--   The spec promises a monthly recalc. Storing a fixed expiry means
--   stale Expert chips clear themselves without a cron job — the
--   leaderboard's `valid_until > now()` filter handles it. When the
--   recalc cron lands, it simply REINSERTs rows with a fresh
--   valid_until and lets old rows expire.
--
-- Why composite PK (user_id, sport_id), not surrogate id:
--   The spec caps an analyst at 2 Expert sports. Composite PK + a
--   future CHECK on `(SELECT count(*) FROM community_experts ce2
--   WHERE ce2.user_id = NEW.user_id)` enforces that. For V1 we leave
--   the cap to the admin endpoint's pre-insert check — the cron will
--   tighten it later.

BEGIN;

CREATE TABLE community_experts (
    user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    sport_id      INTEGER NOT NULL REFERENCES sports(id) ON DELETE CASCADE,
    nominated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- Default 30 days from nomination — matches the spec's monthly
    -- recalc cadence. Admin endpoint accepts an override for ad-hoc
    -- promotions (e.g. event sponsorship windows).
    valid_until   TIMESTAMPTZ NOT NULL,
    -- Admin who nominated this Expert. NULL when the future recalc
    -- cron creates the row.
    nominated_by  UUID REFERENCES users(id) ON DELETE SET NULL,
    PRIMARY KEY (user_id, sport_id)
);

-- Hot read on the leaderboard: "is this user an active Expert in this
-- sport?". Plain b-tree (no partial predicate — Postgres rejects
-- now() in index predicates because it's volatile); the leaderboard's
-- query filters by `valid_until > now()` at read time and the
-- composite is tight enough to keep the scan cheap as expired rows
-- accumulate.
CREATE INDEX community_experts_user_sport_idx
    ON community_experts (user_id, sport_id, valid_until);

-- Sport-scoped enumeration (admin UI lists current Experts per sport).
CREATE INDEX community_experts_sport_idx
    ON community_experts (sport_id, valid_until DESC);

COMMIT;
