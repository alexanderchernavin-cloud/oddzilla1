-- Custom events: operator-authored offer that comes from no feed.
--
-- The whole design decision here is that a custom event is an ORDINARY
-- row in `matches` / `markets` / `market_outcomes`, not a parallel
-- universe. That is what makes the bet slip, RiskZilla, bet-delay,
-- cashout, ZillaBoost, community tickets and settlement work on it with
-- no changes: they all read those three tables and none of them care
-- which provider filled them. A separate "custom bets" table would have
-- meant reimplementing the entire betting stack for a handful of rows.
--
-- Three things follow from that and are load-bearing:
--
--   * URNs are prefixed `cu:` (`cu:match:<id>`), so the provider-scoped
--     catalog flushes (CLAUDE.md invariant 10) leave custom rows alone.
--     Oddin's flush matches `od:match:%` and Fonbet's `fb:match:%`; a
--     custom event is invisible to both, which is exactly right — an
--     Oddin outage must not suspend an operator's own book.
--
--   * `provider_market_id` is a single shared constant (2 000 000, above
--     Fonbet's 1 000 000 base). That column is a market TYPE everywhere
--     else — riskzilla_market_factors keys a risk multiplier off it,
--     fe_market_display_order orders tabs by it — so one id per market
--     would make all of that per-market and unusable. Two custom markets
--     on the same event are told apart by their `custom` specifier, which
--     is what the (match, provider_market_id, specifiers_hash) identity
--     needs.
--
--   * Settlement goes out on the existing `settlement.external` Redis
--     stream, the same provider-neutral path fonbet-ingester uses, so
--     custom payouts run through the same apply-once settler as everyone
--     else's. No Go changes.
--
-- lock_timeout because ADD COLUMN takes ACCESS EXCLUSIVE on `markets`,
-- which both ingesters write to continuously, and a concurrent pg_dump
-- holds AccessShareLock on every table for minutes. Aborting the deploy
-- cleanly beats queueing the catalog behind this statement.

SET LOCAL lock_timeout = '5s';

-- Operator-authored market name. Feed markets get theirs from
-- `market_descriptions` keyed by (provider_market_id, variant, language);
-- custom markets share ONE provider_market_id, so that table cannot name
-- them individually. Nullable, and NULL means "resolve the normal way",
-- so every existing row keeps its behaviour.
ALTER TABLE markets ADD COLUMN IF NOT EXISTS custom_name TEXT;

-- Per-market operator settings.
--
-- A side table rather than more columns on `markets`: only the name is
-- needed on the storefront read path, and everything below is touched
-- exclusively by the backoffice and the liability sweeper. `markets` is
-- one of the largest and hottest tables in the database and does not need
-- five columns that are NULL on every row a feed ever wrote.
CREATE TABLE IF NOT EXISTS custom_market_config (
  market_id BIGINT PRIMARY KEY REFERENCES markets(id) ON DELETE CASCADE,
  -- Book margin, in basis points. 500 = a 5% overround, i.e. the prices
  -- are set so that sum(1/odds) = 1.05.
  overround_bp INTEGER NOT NULL DEFAULT 500,
  -- Liability trading. When on, the priced probabilities are pulled
  -- toward the share of exposure each outcome currently carries, which
  -- shortens the side holding the money and lengthens the others. See
  -- packages/types/src/custom-events.ts for the arithmetic and why that
  -- direction is the profit-maximising one.
  liability_trading BOOLEAN NOT NULL DEFAULT FALSE,
  -- How far to move toward the money: 0 = ignore bets, 10000 = price
  -- purely off them.
  liability_strength_bp INTEGER NOT NULL DEFAULT 3000,
  -- Hard cap on how far one outcome may travel from the operator's own
  -- probability, so a single large bet cannot walk a price off a cliff.
  liability_max_shift_bp INTEGER NOT NULL DEFAULT 1500,
  liability_priced_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT custom_market_overround_range
    CHECK (overround_bp BETWEEN 0 AND 5000),
  CONSTRAINT custom_market_strength_range
    CHECK (liability_strength_bp BETWEEN 0 AND 10000),
  CONSTRAINT custom_market_max_shift_range
    CHECK (liability_max_shift_bp BETWEEN 0 AND 10000)
);

-- The operator's own probability per outcome, kept apart from
-- `market_outcomes.probability`.
--
-- That separation is what makes liability trading reversible: the traded
-- probability is written to market_outcomes (where cashout, ZillaTips and
-- the storefront read it), while this row stays the anchor the next
-- repricing blends from. Without it, each repricing would compound on the
-- last one and the operator's view would be lost after the first bet.
CREATE TABLE IF NOT EXISTS custom_outcome_config (
  market_id BIGINT NOT NULL REFERENCES markets(id) ON DELETE CASCADE,
  outcome_id TEXT NOT NULL,
  base_probability NUMERIC(8,7) NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (market_id, outcome_id),
  CONSTRAINT custom_outcome_probability_range
    CHECK (base_probability > 0 AND base_probability < 1)
);

-- Sweeper hot path: "every market with liability trading on". Partial, so
-- the index holds only the handful of rows that qualify.
CREATE INDEX IF NOT EXISTS custom_market_liability_idx
  ON custom_market_config (market_id)
  WHERE liability_trading;

-- ---------------------------------------------------------------------
-- Seed the starting structure the operator asked for.
--
-- Idempotent throughout: this is a starting point, not a fixed shape.
-- Categories and tournaments under the Custom sport are managed from the
-- backoffice, so a later rename must survive a re-run of this file.
--
-- `kind = 'traditional'` puts Custom on the storefront's Sports tab.
-- The enum is ('esport','traditional') and adding a third value would
-- need its own migration file (Postgres forbids referencing a new enum
-- value in the transaction that adds it) plus a third tab in the sidebar
-- — neither earns its keep for a bucket the operator fills by hand.
INSERT INTO sports (provider, provider_urn, slug, name, kind, active)
VALUES ('custom', 'cu:sport:1', 'custom', 'Custom', 'traditional', TRUE)
ON CONFLICT (slug) DO NOTHING;

INSERT INTO categories (sport_id, provider_urn, slug, name, is_dummy, active)
SELECT s.id, 'cu:category:1', 'limburg-barbara', 'Limburg Barbara', FALSE, TRUE
  FROM sports s
 WHERE s.slug = 'custom'
ON CONFLICT (sport_id, slug) DO NOTHING;

-- risk_tier is left NULL deliberately. RiskZilla resolves an untiered
-- tournament to UNTIERED_RISK_TIER (10), the STRICTEST row in the
-- settings table — so a custom event opens under-traded rather than
-- over-exposed, and an operator raises it consciously on
-- /admin/tournaments. The custom-events page surfaces the current tier
-- for exactly this reason: the tight default is otherwise indistinguishable
-- from a broken stake limit.
INSERT INTO tournaments (category_id, provider_urn, slug, name, active)
SELECT c.id, 'cu:tournament:1', 'simakov', 'Simakov', TRUE
  FROM categories c
  JOIN sports s ON s.id = c.sport_id
 WHERE s.slug = 'custom' AND c.slug = 'limburg-barbara'
ON CONFLICT (provider_urn) DO NOTHING;
