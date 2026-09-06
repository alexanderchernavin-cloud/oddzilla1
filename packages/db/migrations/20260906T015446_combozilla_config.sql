-- ComboZilla becomes configurable in the backoffice.
--
-- ComboZilla is the lobby's "Prebuilt combos" carousel: four 3-fold
-- parlays (Safe / Challenging / Risky / Ultimate) assembled from the
-- prematch offer. Until this migration the whole selection policy was
-- hard-coded in apps/web/src/lib/three-fold-builder.ts:
--
--   - only matches whose tournament carries risk_tier 1..3 qualified;
--   - only cs2 / dota2 / lol could hold more than one card at a time;
--   - there was no way to put a sport, category or tournament IN or keep
--     one OUT other than changing those constants and deploying.
--
-- The tier band mattered more once ZillaAGI tiered the traditional line
-- (migration 0106): its standing +1 safety margin means a machine
-- verdict can never produce a T1, and most football sits at T4-T6, so
-- the whole Fonbet offer was invisible to ComboZilla by construction.
--
-- Two tables:
--
--   combozilla_config       singleton (id = 'default'): master switch,
--                           the set of eligible risk tiers, whether an
--                           untiered tournament qualifies, and the
--                           sports allowed to hold more than one card.
--                           Defaults reproduce today's behaviour exactly.
--
--   combozilla_scope_rules  operator overrides at sport / category /
--                           tournament scope, each 'allow' or 'block'.
--                           Resolution is most-specific-wins:
--                           tournament > category > sport > tier default.
--                           'allow' puts the scope in REGARDLESS of tier
--                           (that is what "manually add" has to mean —
--                           anything already eligible needs no rule);
--                           'block' keeps it out regardless of tier.
--
-- Same shape as riskzilla_live_delay_config: one typed FK column per
-- scope tier so ON DELETE CASCADE cleans up for free, a CHECK pinning the
-- scope to exactly one populated ref, and a partial unique index per
-- scope so the cascade lookup is "at most one row per (scope, ref)".
-- `scope` and `mode` are CHECK'd TEXT rather than enums — a new value is
-- then one ALTER, not the two-file add-value dance (migrations 0087 /
-- 0101 / 0106 all chose the same).
--
-- The FKs take a brief SHARE ROW EXCLUSIVE on sports / categories /
-- tournaments, all of which the ingesters write to continuously, so
-- fail the deploy cleanly rather than queue the catalog behind it (same
-- reasoning as 0100 / 0106 / 0110).

SET LOCAL lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS combozilla_config (
  id                     text        PRIMARY KEY DEFAULT 'default',
  enabled                boolean     NOT NULL DEFAULT true,
  -- Risk tiers whose tournaments qualify by default. 1..10 mirror
  -- tournaments.risk_tier. Empty = nothing qualifies by tier alone, so
  -- only 'allow' rules feed the carousel.
  eligible_risk_tiers    smallint[]  NOT NULL DEFAULT '{1,2,3}'::smallint[],
  -- Whether a tournament with NO risk tier (not yet reviewed by ZillaAGI,
  -- never tiered by the feed) qualifies. Off by default: RiskZilla prices
  -- an untiered tournament at the strictest tier, and a carousel card is
  -- a recommendation.
  allow_untiered         boolean     NOT NULL DEFAULT false,
  -- Sports that may hold more than one of the four cards at once. Every
  -- other sport is capped at one card per render so the densest pool
  -- (efootball, or football on the Fonbet line) cannot sweep the whole
  -- carousel. Slugs, like users.hidden_sports — a sport is addressed by
  -- slug everywhere on the storefront.
  multi_card_sport_slugs text[]      NOT NULL DEFAULT '{cs2,dota2,lol}'::text[],
  updated_by             uuid        REFERENCES users(id) ON DELETE SET NULL,
  updated_at             timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT combozilla_config_singleton CHECK (id = 'default'),
  CONSTRAINT combozilla_config_tiers_range CHECK (
    eligible_risk_tiers <@ ARRAY[1,2,3,4,5,6,7,8,9,10]::smallint[]
  ),
  CONSTRAINT combozilla_config_multi_card_cap CHECK (
    cardinality(multi_card_sport_slugs) <= 100
  )
);

INSERT INTO combozilla_config (id) VALUES ('default')
  ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS combozilla_scope_rules (
  id             bigserial   PRIMARY KEY,
  scope          text        NOT NULL,
  sport_id       integer     REFERENCES sports(id)      ON DELETE CASCADE,
  category_id    integer     REFERENCES categories(id)  ON DELETE CASCADE,
  tournament_id  integer     REFERENCES tournaments(id) ON DELETE CASCADE,
  mode           text        NOT NULL,
  updated_by     uuid        REFERENCES users(id)       ON DELETE SET NULL,
  updated_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT combozilla_scope_rules_scope_check
    CHECK (scope IN ('sport', 'category', 'tournament')),
  CONSTRAINT combozilla_scope_rules_mode_check
    CHECK (mode IN ('allow', 'block')),
  CONSTRAINT combozilla_scope_rules_scope_consistency CHECK (
    (scope = 'sport'
       AND sport_id IS NOT NULL AND category_id IS NULL AND tournament_id IS NULL) OR
    (scope = 'category'
       AND sport_id IS NULL AND category_id IS NOT NULL AND tournament_id IS NULL) OR
    (scope = 'tournament'
       AND sport_id IS NULL AND category_id IS NULL AND tournament_id IS NOT NULL)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS combozilla_scope_rules_sport_uniq
  ON combozilla_scope_rules (sport_id)
  WHERE scope = 'sport';
CREATE UNIQUE INDEX IF NOT EXISTS combozilla_scope_rules_category_uniq
  ON combozilla_scope_rules (category_id)
  WHERE scope = 'category';
CREATE UNIQUE INDEX IF NOT EXISTS combozilla_scope_rules_tournament_uniq
  ON combozilla_scope_rules (tournament_id)
  WHERE scope = 'tournament';
