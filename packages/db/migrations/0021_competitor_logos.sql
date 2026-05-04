-- 0021_competitor_logos.sql
--
-- Per-competitor branding so the storefront can render team logos next to
-- names on match cards and the match-detail header. Two columns are added
-- to `competitors`:
--
--   logo_url     URL pointing at the team's logo image. Plain TEXT so the
--                admin can paste any HTTPS URL (Liquipedia, team's own CDN,
--                a hosted file). Nullable — when absent the UI falls back
--                to the existing initials TeamMark.
--
--   brand_color  Optional hex string ("#RRGGBB"). Reserved for future tinted
--                accents (e.g. coloured outline around a logo); not yet
--                consumed by the frontend.
--
-- No index is needed: lookups are always by competitor.id (FK from matches)
-- or sport_id+slug, both already covered. The columns are pure metadata.

ALTER TABLE competitors
    ADD COLUMN logo_url    TEXT,
    ADD COLUMN brand_color TEXT;

-- Sanity-check that brand_color is a 7-char hex string ("#RRGGBB") when
-- supplied. NULL is allowed and remains the default. The check is
-- deliberately permissive on the URL side (TEXT, no constraint) — admins
-- may switch CDN protocols (data: URIs for local previews, /logos/* for
-- self-hosted assets) without a schema change.
ALTER TABLE competitors
    ADD CONSTRAINT competitors_brand_color_format
    CHECK (brand_color IS NULL OR brand_color ~ '^#[0-9A-Fa-f]{6}$');
