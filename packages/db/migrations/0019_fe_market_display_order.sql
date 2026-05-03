-- 0019_fe_market_display_order.sql
--
-- Per-sport ordering of market types on the storefront match page. Default
-- order is provider_market_id ascending; this table lets admins promote a
-- given market type (provider_market_id) above its peers within one sport
-- without affecting the others.
--
-- Smaller display_order = higher priority (renders nearer the top). Markets
-- with no row here fall back to provider_market_id ascending — same
-- behaviour the page had before this table existed.

CREATE TABLE fe_market_display_order (
  id                  SERIAL PRIMARY KEY,
  sport_id            INTEGER NOT NULL REFERENCES sports(id) ON DELETE CASCADE,
  provider_market_id  INTEGER NOT NULL,
  display_order       INTEGER NOT NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by          UUID REFERENCES users(id),
  UNIQUE (sport_id, provider_market_id)
);

CREATE INDEX fe_market_display_order_sport_idx
  ON fe_market_display_order (sport_id, display_order);
