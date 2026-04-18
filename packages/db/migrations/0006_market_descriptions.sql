-- Market + outcome descriptions from Oddin's /v1/descriptions/{lang}/markets
-- endpoint. Provides human-readable name templates so the UI can show
-- "Match winner" instead of "Market #1" and "home"/"away"/"draw" instead
-- of outcome ids. Name templates use {specifier} placeholders that the
-- API substitutes at render time using the market's specifiers_json.
--
-- Variant is part of the primary key because Oddin keys descriptions by
-- (market_id, variant). E.g. market 1 has variants "way:two" and
-- "way:three" for 2-way vs 3-way match winner. Empty string means no
-- variant, which is the common case.
--
-- Refreshed periodically by feed-ingester (every few hours). Idempotent
-- upserts; stale rows are acceptable because market ids + outcome ids
-- are stable — only human-facing labels evolve.

CREATE TABLE IF NOT EXISTS market_descriptions (
  provider_market_id INTEGER NOT NULL,
  variant            TEXT    NOT NULL DEFAULT '',
  name_template      TEXT    NOT NULL,
  specifiers_json    JSONB   NOT NULL DEFAULT '[]'::jsonb,
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (provider_market_id, variant)
);

CREATE TABLE IF NOT EXISTS outcome_descriptions (
  provider_market_id INTEGER NOT NULL,
  variant            TEXT    NOT NULL DEFAULT '',
  outcome_id         TEXT    NOT NULL,
  name_template      TEXT    NOT NULL,
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (provider_market_id, variant, outcome_id)
);

-- Lookup pattern: "given a market row, find the description". We join on
-- (provider_market_id, variant). The markets table doesn't yet carry a
-- variant column — it's derived from specifiers (e.g. best_of:3). The
-- join is done in application code, so no additional index is needed
-- beyond the primary key.
