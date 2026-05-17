-- 0060_zillapass.sql
--
-- ZillaPass — quest / battle-pass scaffold. The first PR delivers the
-- schema, admin CRUD, and read-only user surfaces. Task progress is
-- not yet incremented automatically by any service: once the product
-- team finalises the predicate vocabulary (e.g. "bets_placed",
-- "wins_in_a_row", ...) the increment hooks land in a follow-up.
-- Today the rows render but their `current_count` stays at 0.
--
-- Three tables:
--
--   zillapass_tasks
--     Admin-curated task catalog. `slug` is the stable identifier so
--     progress rows survive title edits. `predicate_key` carries the
--     hook the (future) progress writer reads — kept TEXT and open-
--     ended so the catalog of predicates can grow without a migration.
--     `period` resets progress on a daily / weekly / season cadence.
--     `reward_kind` + `reward_payload` are nullable for now; the
--     unlock pipeline lands with the predicate hooks.
--
--   zillapass_user_progress
--     Per-user, per-period progress on each task. Composite PK
--     `(user_id, task_id, period_start)` so a daily task with the same
--     slug has one row per day. `period_start` is normalised by the
--     writer (today for daily, monday-of-week for weekly, season
--     anchor for season). `completed_at` is set to the first NOW() the
--     `current_count` reaches `target_count` and never moves after.
--
--   zillapass_user_state
--     One row per user. Carries level + xp + active-day streak. xp
--     drives level via a curve the API computes (no table needed for
--     V1). `last_active_date` is the date the streak was last
--     extended; the streak resets to 1 when the writer sees a gap > 1.

BEGIN;

CREATE TYPE zillapass_period AS ENUM ('daily', 'weekly', 'season');

CREATE TABLE zillapass_tasks (
    id              SERIAL PRIMARY KEY,
    slug            TEXT NOT NULL UNIQUE,
    title           TEXT NOT NULL,
    description     TEXT,
    target_count    INTEGER NOT NULL CHECK (target_count > 0),
    -- Hook key consumed by future progress writers. Today the value
    -- is decorative — nothing increments progress automatically yet.
    predicate_key   TEXT NOT NULL,
    period          zillapass_period NOT NULL DEFAULT 'daily',
    -- Reward shape: kind + payload. Both nullable until the unlock
    -- pipeline lands. Example kinds: 'feature_unlock', 'xp', 'oz'.
    reward_kind     TEXT,
    reward_payload  JSONB,
    active          BOOLEAN NOT NULL DEFAULT TRUE,
    sort_order      INTEGER NOT NULL DEFAULT 0,
    created_by      UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Hot query: list every active task ordered for display.
CREATE INDEX zillapass_tasks_active_sort_idx
    ON zillapass_tasks (active, sort_order, id);

CREATE TABLE zillapass_user_progress (
    user_id         UUID    NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    task_id         INTEGER NOT NULL REFERENCES zillapass_tasks(id) ON DELETE CASCADE,
    period_start    DATE    NOT NULL,
    current_count   INTEGER NOT NULL DEFAULT 0 CHECK (current_count >= 0),
    completed_at    TIMESTAMPTZ,
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (user_id, task_id, period_start)
);

-- Per-user fetch for the current period (the only read shape today).
CREATE INDEX zillapass_user_progress_user_period_idx
    ON zillapass_user_progress (user_id, period_start DESC);

CREATE TABLE zillapass_user_state (
    user_id              UUID    PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    level                INTEGER NOT NULL DEFAULT 1 CHECK (level >= 1),
    xp                   INTEGER NOT NULL DEFAULT 0 CHECK (xp >= 0),
    active_streak_days   INTEGER NOT NULL DEFAULT 0 CHECK (active_streak_days >= 0),
    last_active_date     DATE,
    updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMIT;
