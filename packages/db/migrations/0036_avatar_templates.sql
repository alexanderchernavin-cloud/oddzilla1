-- 0036_avatar_templates.sql
--
-- Avatar Templates V1 (PRD: Avatar Templates & Image Pipeline).
--
-- Two storage modes coexist on the same table:
--   • Static seed templates — image_path points at a file under
--     apps/web/public/avatars/. Next.js serves these directly with
--     <Image>, including responsive WebP variants. The seed rows
--     below populate kaiju-01 through kaiju-12.
--   • Admin uploads — image_data carries the raw bytes plus
--     image_mime. The API serves them at GET /community/avatars/
--     :slug/image so the bytes never have to leave Postgres or
--     coordinate with a docker volume between api + web. Bigger
--     than CDN-backed object storage but trivially deployable; a
--     V2 epic moves both modes onto S3 + a transform layer.
--
-- The CHECK constraint enforces "exactly one source" — a row that
-- has both an image_path and image_data is incoherent. The
-- application layer never writes both, but the constraint locks the
-- invariant in.
--
-- users.avatar_template_id is the equipped template (nullable). A
-- template that gets soft-deleted (status=hidden) keeps existing
-- equips intact; the API just stops listing it as selectable. ON
-- DELETE SET NULL on the FK protects the user row if a template is
-- ever hard-deleted.

BEGIN;

CREATE TABLE avatar_templates (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    -- Stable url-safe identifier. The image-serve route keys off
    -- this, and admins refer to templates by slug in URLs.
    slug        TEXT NOT NULL UNIQUE,
    -- Human display name. Surfaces in admin lists and the user
    -- picker. Operator-editable post-upload via PATCH.
    name        TEXT NOT NULL,
    -- Loose grouping for the picker UI. Free text rather than an
    -- enum so future packs (sport, esports, abstract, …) slot in
    -- without a migration. Seed pack uses 'creature'.
    category    TEXT NOT NULL,
    -- Mirrors the PRD cosmetics framework. Free text again so a
    -- 'mythic' tier can be added without renaming the enum.
    rarity      TEXT NOT NULL DEFAULT 'common',
    -- 'active' = listed in /community/avatars (selectable).
    -- 'hidden' = soft-deleted; existing equips keep working but no
    -- new user can pick it. The admin grid shows both.
    status      TEXT NOT NULL DEFAULT 'active',
    sort_order  INTEGER NOT NULL DEFAULT 0,
    -- Static path under apps/web/public/. Mutually exclusive with
    -- image_data via the CHECK below.
    image_path  TEXT,
    image_data  BYTEA,
    image_mime  TEXT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- Admin who uploaded. NULL for seed rows. ON DELETE SET NULL
    -- so retiring an admin doesn't cascade into a template purge.
    created_by  UUID REFERENCES users(id) ON DELETE SET NULL,
    CONSTRAINT avatar_templates_one_source CHECK (
        (image_path IS NOT NULL AND image_data IS NULL)
        OR (image_path IS NULL AND image_data IS NOT NULL AND image_mime IS NOT NULL)
    ),
    CONSTRAINT avatar_templates_status_chk CHECK (status IN ('active', 'hidden')),
    CONSTRAINT avatar_templates_rarity_chk CHECK (rarity IN ('common', 'rare', 'epic', 'legendary'))
);

-- Picker query: status='active' ORDER BY sort_order, name. The
-- (status, sort_order) prefix serves it without a sort step.
CREATE INDEX avatar_templates_active_order_idx
    ON avatar_templates (status, sort_order, name)
    WHERE status = 'active';

-- Equipped-avatar lookup. Nullable, ON DELETE SET NULL so a
-- template purge doesn't break the user. The vast majority of users
-- start NULL (default fallback shown in the UI), so a B-tree on the
-- column is wasted unless we filter — partial index on the non-null
-- side keeps it tight.
ALTER TABLE users
    ADD COLUMN avatar_template_id UUID REFERENCES avatar_templates(id) ON DELETE SET NULL;

CREATE INDEX users_avatar_template_idx
    ON users (avatar_template_id)
    WHERE avatar_template_id IS NOT NULL;

-- ─── Seed: 12 kaiju (PRD pack #1) ───────────────────────────────────────────
--
-- Static rows pointing at apps/web/public/avatars/kaiju-NN.png. Names are
-- generic for V0 — admins rename via PATCH /admin/avatars/:id once the
-- upload UI lands. Rarity is 'epic' across the pack; the kaiju are visually
-- distinctive enough to warrant the tier, and operators can downgrade
-- specific entries later. Category 'creature' keeps the door open for
-- future non-creature kaiju (mech, cosmic) without an enum migration.
INSERT INTO avatar_templates (slug, name, category, rarity, image_path, sort_order) VALUES
    ('kaiju-01', 'Kaiju 01', 'creature', 'epic', '/avatars/kaiju-01.png',  1),
    ('kaiju-02', 'Kaiju 02', 'creature', 'epic', '/avatars/kaiju-02.png',  2),
    ('kaiju-03', 'Kaiju 03', 'creature', 'epic', '/avatars/kaiju-03.png',  3),
    ('kaiju-04', 'Kaiju 04', 'creature', 'epic', '/avatars/kaiju-04.png',  4),
    ('kaiju-05', 'Kaiju 05', 'creature', 'epic', '/avatars/kaiju-05.png',  5),
    ('kaiju-06', 'Kaiju 06', 'creature', 'epic', '/avatars/kaiju-06.png',  6),
    ('kaiju-07', 'Kaiju 07', 'creature', 'epic', '/avatars/kaiju-07.png',  7),
    ('kaiju-08', 'Kaiju 08', 'creature', 'epic', '/avatars/kaiju-08.png',  8),
    ('kaiju-09', 'Kaiju 09', 'creature', 'epic', '/avatars/kaiju-09.png',  9),
    ('kaiju-10', 'Kaiju 10', 'creature', 'epic', '/avatars/kaiju-10.png', 10),
    ('kaiju-11', 'Kaiju 11', 'creature', 'epic', '/avatars/kaiju-11.png', 11),
    ('kaiju-12', 'Kaiju 12', 'creature', 'epic', '/avatars/kaiju-12.png', 12);

COMMIT;
