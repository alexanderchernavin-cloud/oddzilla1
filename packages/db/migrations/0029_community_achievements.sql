-- 0029_community_achievements.sql
--
-- Phase 10.4 starter achievements.
--
-- Two tables:
--
--   achievement_definitions
--     Stable, human-curated catalog of badges. Loaded by hand here and
--     edited via direct DB ops if the product team renames or retires
--     one — there's no admin CRUD planned in V1. `id` is a stable text
--     slug so any future migration can reference it without depending
--     on a numeric surrogate. `icon` is a lucide-icon slug, mirroring
--     the existing storefront convention (see I.* in
--     apps/web/src/components/ui/icons.tsx).
--
--   user_achievements
--     Unlock log. Composite PK `(user_id, achievement_id)` is the
--     idempotency story — `INSERT ... ON CONFLICT DO NOTHING` makes
--     unlock evaluation safe to run on every settlement write,
--     including replays and re-settle generations. Cascade delete
--     follows the user; achievement definitions never delete in
--     practice but a cascade prevents an orphan if one ever does.
--
-- Unlock evaluation runs co-located with the projection write hook
-- (services/settlement/internal/store/store.go ::
-- WriteCommunityProjection on Go, services/api/src/modules/community/
-- projection.ts on TS) — see EvaluateAchievements / writeAchievements
-- there. The starter set is intentionally currency-agnostic; ROI- and
-- payout-magnitude badges that need currency segregation belong to a
-- later iteration once the leaderboard surface is more mature.

CREATE TABLE achievement_definitions (
    id          TEXT PRIMARY KEY,
    title       TEXT NOT NULL,
    description TEXT NOT NULL,
    -- Lucide icon slug (e.g. "Trophy", "Flame"). The web client picks
    -- a fallback when the slug isn't in apps/web/src/components/ui/icons.tsx.
    icon        TEXT NOT NULL,
    -- Sort order for the profile display. Lower = shown first.
    sort_order  INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE user_achievements (
    user_id        UUID    NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    achievement_id TEXT    NOT NULL REFERENCES achievement_definitions(id),
    unlocked_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (user_id, achievement_id)
);

CREATE INDEX user_achievements_user_idx
    ON user_achievements (user_id, unlocked_at DESC);

-- ─── Starter badges (5) ────────────────────────────────────────────────
--
-- Predicates evaluated against community_tickets aggregates per user.
-- All currency-agnostic — multiplicative or count thresholds, never
-- absolute payout amounts.

INSERT INTO achievement_definitions (id, title, description, icon, sort_order) VALUES
    ('first_win',
     'First Win',
     'Win your first ticket.',
     'Trophy',
     10),
    ('combo_5',
     'Five-Leg Combo',
     'Win a 5-leg or longer combo.',
     'Star',
     20),
    ('odds_20',
     '20x Win',
     'Win a ticket at 20.00 or higher total odds.',
     'Arrow',
     30),
    ('payout_100x',
     'Century Payout',
     'Win a single ticket paying 100x or more on stake.',
     'Bell',
     40),
    ('streak_10',
     'Ten Wins',
     'Win ten or more tickets across all currencies.',
     'Trophy',
     50)
ON CONFLICT (id) DO NOTHING;
