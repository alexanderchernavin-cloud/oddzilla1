-- 0024_community_profiles.sql
--
-- Community-side user fields (Phase 10.1).
--
-- Four nullable / safely-defaulted columns are added to `users` so the
-- community surface (public profiles, feed, copy-to-bet) can ship
-- without a backfill pass:
--
--   tickets_public  Whether this user's settled tickets appear in the
--                   community feed and on their public profile.
--                   Defaults TRUE per Decision D1 in
--                   docs/COMMUNITY_PLAN.md — maximises feed density on
--                   day one. One-click opt-out lives at
--                   /account/community.
--
--   nickname        Public handle used in the URL `/u/[nickname]` and
--                   on every feed card. citext makes it
--                   case-insensitive-unique without a separate lower()
--                   index. NULL until the user picks one. The format
--                   constraint mirrors the zod check at the API layer
--                   so a bypassed handler can't insert a malformed
--                   value.
--
--   bio             Short free-text description rendered on the public
--                   profile. NULL by default. The 280-char DB-side cap
--                   mirrors the zod cap at the API layer.
--
--   is_ai           Internal flag for AI seed accounts that drive feed
--                   density during the early ramp (Phase 10.4). Never
--                   serialised by any API endpoint per Decision D2 —
--                   transparency-on-request only. Defaults FALSE for
--                   every existing and new real signup.
--
-- All four columns are non-rewriting on existing rows (NOT NULL with a
-- DEFAULT, or fully nullable), so the migration takes only a brief
-- AccessExclusive lock for the catalog updates and is safe under live
-- traffic.

ALTER TABLE users ADD COLUMN tickets_public BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE users ADD COLUMN nickname citext UNIQUE;
ALTER TABLE users ADD COLUMN bio TEXT;
ALTER TABLE users ADD COLUMN is_ai BOOLEAN NOT NULL DEFAULT FALSE;

-- Nickname format: 3-20 chars, [A-Za-z0-9_]. Re-validated at the API
-- (zod), but the DB-level check stops bypasses cold.
ALTER TABLE users
    ADD CONSTRAINT users_nickname_format
    CHECK (nickname IS NULL OR nickname ~ '^[A-Za-z0-9_]{3,20}$');

-- Bio length cap mirrors the zod cap at the API layer.
ALTER TABLE users
    ADD CONSTRAINT users_bio_length
    CHECK (bio IS NULL OR length(bio) <= 280);
