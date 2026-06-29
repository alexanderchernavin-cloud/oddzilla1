-- 0082_zillabuild.sql
--
-- ZillaBuild — admin-curated pre-built BetBuilder (Oddin OBB) combos
-- surfaced as cards on the PREMATCH match page. Sibling promo to
-- ZillaFlash (rotating boosted singles) and CombiBoost (combo multiplier).
--
--   * zillabuild_config  — singleton feature config: master on/off, the
--                          allowlist of Oddin provider_market_id values to
--                          consider ("which markets"), card shape
--                          (cards per map / map count / legs per card),
--                          a minimum combined-odds floor, and the shared
--                          per-match response cache window.
--   * zillabuild_cards   — persisted card compositions per (match, map,
--                          slot). A card's selection set is chosen ONCE and
--                          kept while its legs stay valid; the combined +
--                          per-leg odds are re-quoted from OBB on every
--                          read and are NEVER stored here, so a card can
--                          never serve stale prices.
--
-- ZillaBuild also joins the per-bettor promo-visibility cascade
-- (migration 0071) as a third promo_kind, so operators can hide it per
-- bettor / sport / tournament / match. The gate is display-only — there
-- is no odds advantage to police at placement (a card just pre-loads the
-- standard BetBuilder slip), so /bets is untouched.

BEGIN;

-- ── 1. Promo-kind enum gains a third member ──────────────────────────
-- Safe inside this transaction on PG12+ because the new value is NOT
-- referenced anywhere in THIS migration (the tables below don't use the
-- enum; only runtime admin inserts do). The "a new enum value cannot be
-- used in the same transaction that created it" rule therefore never
-- fires.
ALTER TYPE bettor_promo_kind ADD VALUE IF NOT EXISTS 'zillabuild';

-- ── 2. Feature config (singleton, id = 'default') ────────────────────
CREATE TABLE zillabuild_config (
  id                            text         PRIMARY KEY DEFAULT 'default',
  enabled                       boolean      NOT NULL DEFAULT true,
  -- Allowlist of Oddin provider_market_id values eligible for ZillaBuild
  -- composition. Empty array = consider EVERY OBB-eligible per-map market.
  eligible_provider_market_ids  integer[]    NOT NULL DEFAULT '{}'::integer[],
  -- Card shape. Spec default = 2 cards on Map 1 + 2 cards on Map 2.
  cards_per_map                 smallint     NOT NULL DEFAULT 2,
  map_count                     smallint     NOT NULL DEFAULT 2,
  -- Legs (selections) per card. Each card is a random 2-4 leg single-map
  -- OBB combo; the actual count per card is random within this range.
  min_legs                      smallint     NOT NULL DEFAULT 2,
  max_legs                      smallint     NOT NULL DEFAULT 4,
  -- Drop trivially-short combos so a card reads as worthwhile.
  min_combined_odds             numeric(6,3) NOT NULL DEFAULT 2.000,
  -- Shared per-match cache window (seconds) for the assembled
  -- composition + odds payload. Bounds OBB SessionCreate calls under
  -- refresh storms while staying effectively "fresh per open".
  cache_ttl_seconds             integer      NOT NULL DEFAULT 20,
  updated_at                    timestamptz  NOT NULL DEFAULT now(),
  updated_by                    uuid         REFERENCES users(id) ON DELETE SET NULL,
  CONSTRAINT zillabuild_config_singleton CHECK (id = 'default'),
  CONSTRAINT zillabuild_config_cards_per_map_range CHECK (cards_per_map BETWEEN 1 AND 4),
  CONSTRAINT zillabuild_config_map_count_range CHECK (map_count BETWEEN 1 AND 5),
  CONSTRAINT zillabuild_config_legs_range
    CHECK (min_legs >= 2 AND max_legs >= min_legs AND max_legs <= 8),
  CONSTRAINT zillabuild_config_min_combined_odds_range
    CHECK (min_combined_odds >= 1.01 AND min_combined_odds <= 1000),
  CONSTRAINT zillabuild_config_cache_ttl_range CHECK (cache_ttl_seconds BETWEEN 5 AND 600)
);

INSERT INTO zillabuild_config (id) VALUES ('default') ON CONFLICT (id) DO NOTHING;

-- ── 3. Persisted card compositions ───────────────────────────────────
CREATE TABLE zillabuild_cards (
  id          bigserial   PRIMARY KEY,
  match_id    bigint      NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  map_number  smallint    NOT NULL,
  slot        smallint    NOT NULL,
  -- [{ "marketId": "<internal bigint>", "outcomeId": "<oddin outcome id>" }, ...]
  -- Minimal identity only. provider_market_id / specifiers / labels /
  -- odds are all derived at read time so the card never holds stale data.
  legs        jsonb       NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT zillabuild_cards_map_number_positive CHECK (map_number >= 1),
  CONSTRAINT zillabuild_cards_slot_nonneg CHECK (slot >= 0)
);

-- One row per (match, map, slot). Doubles as the per-match read index.
CREATE UNIQUE INDEX zillabuild_cards_match_map_slot_uniq
  ON zillabuild_cards (match_id, map_number, slot);

COMMIT;
