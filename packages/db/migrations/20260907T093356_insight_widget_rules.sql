-- 20260907T093356_insight_widget_rules.sql
--
-- Operator control for the two match-page insight widgets, ZillaTips and
-- ZillaFacts.
--
-- Until now neither had ANY admin surface — no page, no sidebar entry, no
-- config route. The only way to turn one off was to edit code, and when
-- the operator asked for them off on 2026-09-07 the stopgap was a pair of
-- env vars (ZILLATIPS_DISABLED / ZILLAFACTS_DISABLED) that needed a
-- container recreate to flip and recorded their state nowhere a person
-- would look. This table replaces them: the switch lives in the database,
-- an operator flips it from /admin/zillatips and /admin/zillafacts, and it
-- takes effect on the next request.
--
-- One table for both widgets rather than two, keyed by `widget` — the same
-- choice bettor_promo_visibility_config makes for its three promo kinds.
-- They are the same shape of decision about the same catalogue, and a
-- second table would mean a second resolver to keep in step.
--
-- Resolution is MOST-SPECIFIC-WINS:
--     market > tournament > category > sport > global
-- with `global` seeded, so there is always an answer and "what happens if
-- nothing matches" is a row an operator can see rather than a constant
-- buried in code.
--
-- `market` sits at the top because the widget renders ON a market, so a
-- rule naming that market is the most direct statement about the thing
-- being drawn. Note it is a market TYPE (`provider_market_id`), not a
-- market row: rows are created and settled per match and would make every
-- rule garbage within a day. A consequence worth knowing at the desk is
-- that a market rule therefore spans every sport that quotes that id —
-- narrow it with the tiers below if that is not what you want.
--
-- Both widgets are seeded DISABLED at global scope, which is where the
-- operator left them on 2026-09-07. Turning one on for a single sport is
-- then one `sport` row, not a global flip.
--
-- Same shape as combozilla_scope_rules / riskzilla_live_delay_config: one
-- typed FK per scope tier so ON DELETE CASCADE cleans up for free, a CHECK
-- pinning the scope to exactly one populated ref, and a partial unique
-- index per (widget, scope, ref). `widget` and `scope` are CHECK'd TEXT
-- rather than enums so a third widget is one ALTER instead of the
-- two-file add-value dance (0087 / 0101 / 0106 all chose the same).
--
-- The FKs take a brief SHARE ROW EXCLUSIVE on sports / categories /
-- tournaments, which both ingesters write to continuously — fail the
-- deploy cleanly rather than queue the catalog behind it (0100 / 0106).
SET LOCAL lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS insight_widget_rules (
  id                  bigserial   PRIMARY KEY,
  widget              text        NOT NULL,
  scope               text        NOT NULL,
  sport_id            integer     REFERENCES sports(id)      ON DELETE CASCADE,
  category_id         integer     REFERENCES categories(id)  ON DELETE CASCADE,
  tournament_id       integer     REFERENCES tournaments(id) ON DELETE CASCADE,
  provider_market_id  integer,
  enabled             boolean     NOT NULL,
  updated_by          uuid        REFERENCES users(id)       ON DELETE SET NULL,
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT insight_widget_rules_widget_check
    CHECK (widget IN ('zillatips', 'zillafacts')),
  CONSTRAINT insight_widget_rules_scope_check
    CHECK (scope IN ('global', 'sport', 'category', 'tournament', 'market')),
  CONSTRAINT insight_widget_rules_scope_consistency CHECK (
    (scope = 'global'
       AND sport_id IS NULL AND category_id IS NULL
       AND tournament_id IS NULL AND provider_market_id IS NULL) OR
    (scope = 'sport'
       AND sport_id IS NOT NULL AND category_id IS NULL
       AND tournament_id IS NULL AND provider_market_id IS NULL) OR
    (scope = 'category'
       AND sport_id IS NULL AND category_id IS NOT NULL
       AND tournament_id IS NULL AND provider_market_id IS NULL) OR
    (scope = 'tournament'
       AND sport_id IS NULL AND category_id IS NULL
       AND tournament_id IS NOT NULL AND provider_market_id IS NULL) OR
    (scope = 'market'
       AND sport_id IS NULL AND category_id IS NULL
       AND tournament_id IS NULL AND provider_market_id IS NOT NULL)
  )
);

-- One live rule per (widget, scope, ref). These are the cascade lookup's
-- targets and the ON CONFLICT targets for the admin upserts.
CREATE UNIQUE INDEX IF NOT EXISTS insight_widget_rules_global_uniq
  ON insight_widget_rules (widget)
  WHERE scope = 'global';
CREATE UNIQUE INDEX IF NOT EXISTS insight_widget_rules_sport_uniq
  ON insight_widget_rules (widget, sport_id)
  WHERE scope = 'sport';
CREATE UNIQUE INDEX IF NOT EXISTS insight_widget_rules_category_uniq
  ON insight_widget_rules (widget, category_id)
  WHERE scope = 'category';
CREATE UNIQUE INDEX IF NOT EXISTS insight_widget_rules_tournament_uniq
  ON insight_widget_rules (widget, tournament_id)
  WHERE scope = 'tournament';
CREATE UNIQUE INDEX IF NOT EXISTS insight_widget_rules_market_uniq
  ON insight_widget_rules (widget, provider_market_id)
  WHERE scope = 'market';

-- The whole table is a handful of rows and every read wants all of one
-- widget's rules at once, so this is the only index the resolver needs.
CREATE INDEX IF NOT EXISTS insight_widget_rules_widget_idx
  ON insight_widget_rules (widget);

-- Seed both widgets OFF, matching where the operator left them.
INSERT INTO insight_widget_rules (widget, scope, enabled)
VALUES ('zillatips', 'global', false),
       ('zillafacts', 'global', false)
ON CONFLICT DO NOTHING;
