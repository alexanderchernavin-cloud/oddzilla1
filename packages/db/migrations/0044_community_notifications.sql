-- 0044_community_notifications.sql
--
-- Phase 12 — Community notifications & privacy (PRD: Notifications &
-- Privacy + V1: Notification Preferences).
--
-- Two tables land together because they're the read/write halves of
-- the same surface:
--
--   • user_preferences — per-user toggles. Read on every notification
--     emit (gate before write) and rendered in the You-tab settings
--     accordion. One row per user, lazily inserted on first PATCH.
--
--   • user_notifications — the actual notification log. Bell + panel
--     read here; emit helpers across the API write here. Toasts
--     (deferred to V2) will read the same rows.
--
-- Why one ENUM rather than a table of types:
--   • Type names are baked into icon/copy logic on the web client and
--     the emit-site call sites. Promoting them out of the schema would
--     buy nothing and make the gate-on-pref query lose its index.
--   • New types arrive with new features (e.g. follows lights up
--     `new_follower`). Adding an enum value is a single ALTER TYPE,
--     no row migrations. We list every PRD type up-front so the FE
--     renderer never sees an unknown type.
--
-- Why `read_at TIMESTAMPTZ` over a `read BOOLEAN`:
--   • Same storage cost (8 bytes) but encodes "when" for free. Future
--     "show me what arrived since I last opened the panel" queries
--     don't need a migration.
--
-- Why an explicit `group_key TEXT` column (not derived at read):
--   • The PRD batches similar events ("3 people copied your bet") into
--     a single panel item. Doing this at write-time as an UPSERT on
--     (user, type, group_key) is O(1); doing it at read-time forces a
--     GROUP BY across the user's full history on every panel open.
--   • NULL group_key opts out of batching. Gamification toasts (level
--     up, achievement) carry NULL because each is a distinct event the
--     user shouldn't see collapsed.
--
-- Why no FK from notifications to source rows (analysis_id, ticket_id):
--   • Notifications outlive their sources. If an analysis is later
--     banned or a ticket voided, the notification record is still a
--     truthful "X happened on date Y" — we don't want a CASCADE to
--     erase it. The deep_link column is plain TEXT and the renderer
--     handles 404s gracefully.

BEGIN;

-- 1. Notification type enum. Listed in panel-display order across the
-- three categories (social / competition / gamification). Bet
-- settlement intentionally absent — sportsbook surfaces own that
-- channel, not Community (PRD: Background → Scope note).
CREATE TYPE notification_type AS ENUM (
    -- Social events
    'pick_copied',
    'bet_inspired',
    'new_follower',
    'analysis_shared',
    -- Competition updates
    'leaderboard_move',
    'competition_deadline',
    -- Community editorial
    'community_digest',
    -- Gamification rewards (also drive celebratory toasts in V2)
    'challenge_completed',
    'achievement_unlocked',
    'level_up',
    'loot_acquired'
);

-- 2. Per-user preferences. The row is created lazily on first write;
-- callers reading prefs treat a missing row as "all defaults" rather
-- than failing. That keeps the existing user base migration-free —
-- no backfill needed today, defaults apply until the user touches
-- the You-tab toggles.
--
-- pref_competition_updates is the one context-aware default: PRD
-- says "ON for competitions you've joined, OFF otherwise." We store
-- the literal flag plus a `_set` companion that records whether the
-- user toggled it explicitly. The competition-join handler flips the
-- flag to TRUE only when `_set` is FALSE (auto-enable respects the
-- user's prior manual choice). Same pattern shipped in the V1 PRD's
-- `competitionUpdates_manuallySet`.
CREATE TABLE user_preferences (
    user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    -- Notification category toggles.
    pref_picks_copied                BOOLEAN NOT NULL DEFAULT TRUE,
    pref_new_followers               BOOLEAN NOT NULL DEFAULT TRUE,
    pref_competition_updates         BOOLEAN NOT NULL DEFAULT FALSE,
    pref_competition_updates_set     BOOLEAN NOT NULL DEFAULT FALSE,
    pref_community_highlights        BOOLEAN NOT NULL DEFAULT FALSE,
    pref_achievements_rewards        BOOLEAN NOT NULL DEFAULT TRUE,
    -- Privacy toggles. `share_publicly` is intentionally NOT mirrored
    -- here; it's the existing `users.ticketsPublic` column read/written
    -- through the same /community/me/preferences endpoint. Keeping one
    -- writer prevents drift between the betslip toggle and this
    -- accordion. The other two are V1 save-only — the public-profile
    -- and search surfaces will start consulting them in V2 (PRD: V2
    -- enforcement).
    privacy_show_win_loss_record     BOOLEAN NOT NULL DEFAULT TRUE,
    privacy_allow_profile_discovery  BOOLEAN NOT NULL DEFAULT TRUE,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 3. Notifications log. One row per emitted event (or per group when
-- batching collapses). `actor_id` is nullable because some types
-- (community_digest, level_up, loot_acquired) have no actor.
CREATE TABLE user_notifications (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    -- Recipient. CASCADE on user delete — no point keeping orphaned
    -- notifications.
    user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    type        notification_type NOT NULL,
    -- Who caused it (NULL for system-emitted types). SET NULL on
    -- actor delete so the notification still renders as "Someone
    -- copied your bet" rather than disappearing.
    actor_id    UUID REFERENCES users(id) ON DELETE SET NULL,
    -- Free-form payload the FE renderer reads. Schema is per-type and
    -- documented in packages/types/src/community.ts. Storing the
    -- snapshot here (rather than joining live) means deleting a match
    -- or banning an analysis doesn't retroactively erase the
    -- notification text the user already saw.
    payload     JSONB NOT NULL DEFAULT '{}'::jsonb,
    -- Optional deep-link path the panel navigates to on click. Plain
    -- TEXT — no FK, no validation. The renderer handles 404s.
    deep_link   TEXT,
    -- Group key for "N people copied your bet" batching. NULL = no
    -- batching. The emit helper UPSERTs on (user_id, type, group_key)
    -- within a dedup window; see the index below.
    group_key   TEXT,
    -- For grouped rows, count of distinct actors collapsed into this
    -- item. 1 for ungrouped or freshly-seeded grouped rows; bumped
    -- on each subsequent collapse. The renderer reads this to switch
    -- copy from "X copied your bet" to "N people copied your bet".
    group_count INTEGER NOT NULL DEFAULT 1,
    read_at     TIMESTAMPTZ,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK (group_count >= 1)
);

-- Hot read 1: panel opens, fetch most-recent N for me. Covers both
-- the "all" and "unread-first" sort modes — newest-first is the only
-- ordering V1 supports.
CREATE INDEX user_notifications_user_created_idx
    ON user_notifications (user_id, created_at DESC);

-- Hot read 2: bell badge count(*) WHERE read_at IS NULL for me.
-- Partial index keeps the count fast even after years of read
-- notifications accumulate.
CREATE INDEX user_notifications_user_unread_idx
    ON user_notifications (user_id)
    WHERE read_at IS NULL;

-- Hot write: emit-site lookup of an existing groupable notification
-- within the dedup window. Composite index supports the "find most
-- recent (user, type, group_key)" query in one B-tree probe.
CREATE INDEX user_notifications_group_idx
    ON user_notifications (user_id, type, group_key, created_at DESC)
    WHERE group_key IS NOT NULL;

-- ─── Trigger sites still to wire ────────────────────────────────────────────
--
-- The TS API emits pick_copied (apply-same-play / copy), analysis_shared
-- (analyses inspire), and a one-shot competition_deadline at join time.
-- Three more trigger sites belong to non-TS services and land in
-- follow-ups:
--
--   • leaderboard_move — services/settlement (Go) writes this when a
--     prediction settles and the participant's points or rank changes.
--     Insert directly into user_notifications via the same DB
--     connection it already uses to update competition_participants.
--
--   • achievement_unlocked / level_up / loot_acquired — settlement also
--     owns the unlock evaluator (per the userAchievements PK + ON
--     CONFLICT DO NOTHING comment in 0029_community_achievements.sql).
--     Settlement can INSERT a notification row in the same tx as the
--     userAchievements row.
--
--   • competition_deadline reminders (T-2h, T-24h cron) — a separate
--     periodic worker. The migration is forward-compatible: today's
--     join-time emit and tomorrow's cron emits share the same row
--     shape, payload schema, and pref column.
--
-- All three follow-ups respect the same pref-gating rules as the TS
-- emits — they should call SELECT pref_* FROM user_preferences before
-- inserting (or use a CTE to skip the insert in one round-trip). See
-- services/api/src/modules/community/notifications.ts for the exact
-- pref→type mapping.

COMMIT;
