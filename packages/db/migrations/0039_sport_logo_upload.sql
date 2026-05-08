-- 0039_sport_logo_upload.sql
--
-- Admin-uploaded sport icons. Mirrors the avatar_templates upload mode:
-- the bytes live in BYTEA on the same row as the metadata so we don't
-- have to coordinate a docker volume between the api + web containers.
-- The byte-serve route (/sports/:slug/logo) returns image_data with the
-- recorded image_mime and a long immutable cache header, same shape
-- /community/avatars/:slug/image uses.
--
-- Storage rules (enforced by the CHECK below):
--   • Both columns NULL    → no upload; logo_url either points at an
--                            external URL or is NULL → storefront falls
--                            back to /public/sports/<slug>.svg → glyph.
--   • Both columns NOT NULL → upload present; upload endpoint also
--                             writes logo_url='/api/sports/<slug>/logo
--                             ?v=<unix-ms>' so the storefront's
--                             existing logo_url-based <img src> picks
--                             it up and a re-upload busts the browser
--                             cache via the ?v param.
--
-- Allowed mime set is locked here so a future code path that
-- side-loads a row can't quietly enable an arbitrary content type;
-- the API zod schema is the first line, this CHECK is defence in
-- depth.

ALTER TABLE sports
  ADD COLUMN IF NOT EXISTS logo_data BYTEA,
  ADD COLUMN IF NOT EXISTS logo_mime TEXT;

ALTER TABLE sports
  DROP CONSTRAINT IF EXISTS sports_logo_data_pair;
ALTER TABLE sports
  ADD CONSTRAINT sports_logo_data_pair
  CHECK (
    (logo_data IS NULL AND logo_mime IS NULL)
    OR (logo_data IS NOT NULL AND logo_mime IS NOT NULL)
  );

ALTER TABLE sports
  DROP CONSTRAINT IF EXISTS sports_logo_mime_allowed;
ALTER TABLE sports
  ADD CONSTRAINT sports_logo_mime_allowed
  CHECK (
    logo_mime IS NULL
    OR logo_mime IN ('image/svg+xml', 'image/png', 'image/jpeg', 'image/webp')
  );
