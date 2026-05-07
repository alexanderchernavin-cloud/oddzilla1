-- Per-sport branding columns. Mirrors the team-side logo_url + brand_color
-- shape on competitors so the admin UI can use the same URL-paste pattern.
--
-- Both columns are nullable. When logo_url is NULL the storefront falls
-- back to the bundled SVG at apps/web/public/sports/<slug>.svg, then to
-- the inline FallbackGlyph for slugs we don't have art for. brand_color
-- is reserved for future tinted accents (chip backgrounds, hovers).

ALTER TABLE sports
  ADD COLUMN IF NOT EXISTS logo_url    text,
  ADD COLUMN IF NOT EXISTS brand_color text;

-- Conservative length cap on logo_url so a misbehaving paste can't
-- balloon the column. Matches the trim/refine zod rule on the API side.
ALTER TABLE sports
  DROP CONSTRAINT IF EXISTS sports_logo_url_length;
ALTER TABLE sports
  ADD CONSTRAINT sports_logo_url_length
  CHECK (logo_url IS NULL OR length(logo_url) <= 2048);

ALTER TABLE sports
  DROP CONSTRAINT IF EXISTS sports_brand_color_format;
ALTER TABLE sports
  ADD CONSTRAINT sports_brand_color_format
  CHECK (brand_color IS NULL OR brand_color ~ '^#[0-9A-Fa-f]{6}$');
