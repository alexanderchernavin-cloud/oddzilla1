-- 0040_competitor_logo_upload.sql
--
-- Mirror of 0039_sport_logo_upload.sql for the team-side editor at
-- /admin/competitors. Same shape, same CHECK constraints, same
-- byte-serve mechanism — keeps the two upload paths interchangeable
-- on the API + UI sides.
--
-- Storage rules (enforced by the CHECK below):
--   • Both columns NULL    → no upload; logo_url either points at an
--                            external URL (e.g. Oddin's CDN copy via
--                            resolve-logos) or is NULL → storefront
--                            falls back to the TeamMark initials chip.
--   • Both columns NOT NULL → upload present; upload endpoint also
--                             writes logo_url='/api/competitors/<id>/
--                             logo?v=<unix-ms>' so existing list/
--                             match endpoints surface the URL with
--                             zero code changes and re-uploads bust
--                             the browser cache via the ?v param.

ALTER TABLE competitors
  ADD COLUMN IF NOT EXISTS logo_data BYTEA,
  ADD COLUMN IF NOT EXISTS logo_mime TEXT;

ALTER TABLE competitors
  DROP CONSTRAINT IF EXISTS competitors_logo_data_pair;
ALTER TABLE competitors
  ADD CONSTRAINT competitors_logo_data_pair
  CHECK (
    (logo_data IS NULL AND logo_mime IS NULL)
    OR (logo_data IS NOT NULL AND logo_mime IS NOT NULL)
  );

ALTER TABLE competitors
  DROP CONSTRAINT IF EXISTS competitors_logo_mime_allowed;
ALTER TABLE competitors
  ADD CONSTRAINT competitors_logo_mime_allowed
  CHECK (
    logo_mime IS NULL
    OR logo_mime IN ('image/svg+xml', 'image/png', 'image/jpeg', 'image/webp')
  );
