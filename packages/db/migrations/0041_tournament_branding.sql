-- 0041_tournament_branding.sql
--
-- Tournament branding columns. Mirrors the sports + competitors shape:
-- a logo_url for external paste / byte-serve URL, brand_color reserved
-- for tinted accents, plus the BYTEA + MIME pair for admin uploads.
--
-- Storefront integration: the sidebar tournament sub-tree and the
-- tournament chip on the match-detail header render the logo when set
-- and fall back to the bundled sport SVG otherwise. The /admin/
-- tournaments editor manages all four columns.
--
-- Storage rules (enforced by the CHECK below):
--   • Both columns NULL    → no upload; logo_url either points at an
--                            external URL or is NULL → storefront
--                            falls back to the sport SVG.
--   • Both columns NOT NULL → upload present; upload endpoint also
--                             writes logo_url='/api/tournaments/<id>/
--                             logo?v=<unix-ms>' so existing list
--                             endpoints surface the URL with zero
--                             code changes.

ALTER TABLE tournaments
  ADD COLUMN IF NOT EXISTS logo_url    TEXT,
  ADD COLUMN IF NOT EXISTS brand_color TEXT,
  ADD COLUMN IF NOT EXISTS logo_data   BYTEA,
  ADD COLUMN IF NOT EXISTS logo_mime   TEXT;

ALTER TABLE tournaments
  DROP CONSTRAINT IF EXISTS tournaments_logo_url_length;
ALTER TABLE tournaments
  ADD CONSTRAINT tournaments_logo_url_length
  CHECK (logo_url IS NULL OR length(logo_url) <= 2048);

ALTER TABLE tournaments
  DROP CONSTRAINT IF EXISTS tournaments_brand_color_format;
ALTER TABLE tournaments
  ADD CONSTRAINT tournaments_brand_color_format
  CHECK (brand_color IS NULL OR brand_color ~ '^#[0-9A-Fa-f]{6}$');

ALTER TABLE tournaments
  DROP CONSTRAINT IF EXISTS tournaments_logo_data_pair;
ALTER TABLE tournaments
  ADD CONSTRAINT tournaments_logo_data_pair
  CHECK (
    (logo_data IS NULL AND logo_mime IS NULL)
    OR (logo_data IS NOT NULL AND logo_mime IS NOT NULL)
  );

ALTER TABLE tournaments
  DROP CONSTRAINT IF EXISTS tournaments_logo_mime_allowed;
ALTER TABLE tournaments
  ADD CONSTRAINT tournaments_logo_mime_allowed
  CHECK (
    logo_mime IS NULL
    OR logo_mime IN ('image/svg+xml', 'image/png', 'image/jpeg', 'image/webp')
  );
