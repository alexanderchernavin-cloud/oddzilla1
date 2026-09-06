-- 20260906T103343_settlement_operator_tools
--
-- Two small tables behind the settlement-coverage work of 2026-09-06
-- (docs/SETTLEMENT_COVERAGE_PLAN.md).
--
-- (a) fonbet_market_denylist — catalogue tables and sub-event label
--     prefixes the Fonbet ingester must NOT turn into markets. Measured on
--     the matches that started on 2026-09-05: 36% of the Fonbet markets
--     still open after the match had closed were shapes no grader can ever
--     settle from the data we have — "winner of point N in a set"
--     (table 1007800), "winner of game N in a set" (1004500 / 1004551),
--     player props and event specials — and we kept offering them. A
--     market that cannot be settled must not be in the offer. Admin-managed
--     (/admin/unsettled/denylist), read by fonbet-ingester every minute;
--     the open markets already created under a rule stay visible on that
--     page in case the operator later decides to write the grading for one
--     of them.
--
-- (b) fonbet_settlement_misses — the pending matches the results grader
--     could not find in Fonbet's results feed, with the rows it DID see for
--     the same competition. Until this the grader logged only a count
--     (`no_result: 797` over a week) and nothing said which fixture, or
--     what the results document called it. One row per match, upserted on
--     every pass it stays missing and deleted the pass it is found.
--
-- lock_timeout: both FKs take a brief SHARE ROW EXCLUSIVE on `matches` /
-- `users`; `matches` is written continuously by both ingesters, and a
-- running pg_dump holds an AccessShareLock on everything for minutes.
-- Failing the deploy beats queueing the catalogue behind it (same reason
-- 0100 and 0106 carry this).
SET LOCAL lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS fonbet_market_denylist (
  id                 SERIAL PRIMARY KEY,
  kind               TEXT NOT NULL CHECK (kind IN ('table', 'label_prefix')),
  -- kind = 'table': the full provider_market_id (1_000_000 + catalogue table number).
  provider_market_id INTEGER,
  -- kind = 'label_prefix': case-insensitive prefix of the sub-event label
  -- ("Player specials", "Special bets"), matched against the label the
  -- mapper attaches to a variant market.
  label_prefix       TEXT,
  reason             TEXT NOT NULL DEFAULT '',
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  CONSTRAINT fonbet_market_denylist_shape CHECK (
    (kind = 'table' AND provider_market_id IS NOT NULL AND label_prefix IS NULL)
    OR (kind = 'label_prefix' AND label_prefix IS NOT NULL AND provider_market_id IS NULL)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS fonbet_market_denylist_table_uniq
  ON fonbet_market_denylist (provider_market_id) WHERE kind = 'table';
CREATE UNIQUE INDEX IF NOT EXISTS fonbet_market_denylist_label_uniq
  ON fonbet_market_denylist (lower(label_prefix)) WHERE kind = 'label_prefix';

-- The shapes measured on 2026-09-05. Idempotent: a re-run or a hand-added
-- duplicate hits the partial unique indexes and is skipped.
INSERT INTO fonbet_market_denylist (kind, provider_market_id, reason) VALUES
  ('table', 1007800, 'Winner of point N in a set: needs point-by-point data the results feed does not carry (table tennis, volleyball, badminton)'),
  ('table', 1004500, 'Winner of game N in a set: needs per-game data the results feed does not carry (tennis)'),
  ('table', 1004551, 'Winner of game N in a set: needs per-game data the results feed does not carry (tennis)')
ON CONFLICT DO NOTHING;
INSERT INTO fonbet_market_denylist (kind, label_prefix, reason) VALUES
  ('label_prefix', 'Player specials', 'Player props: the results feed carries no per-player statistics'),
  ('label_prefix', 'Special bets', 'Event specials with no results-feed row')
ON CONFLICT DO NOTHING;

CREATE TABLE IF NOT EXISTS fonbet_settlement_misses (
  match_id      BIGINT PRIMARY KEY REFERENCES matches(id) ON DELETE CASCADE,
  provider_urn  TEXT NOT NULL,
  home_team     TEXT NOT NULL,
  away_team     TEXT NOT NULL,
  scheduled_at  TIMESTAMPTZ,
  -- Fonbet segment (competition) id the fixture is filed under on the line.
  segment_id    INTEGER NOT NULL,
  -- What the results document DID list for that competition on the day:
  -- [{name, startTime, score, status}], at most 20, so the operator can
  -- see the spelling or ordering the two feeds disagree on.
  candidates    JSONB NOT NULL DEFAULT '[]'::jsonb,
  open_markets  INTEGER NOT NULL DEFAULT 0,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  attempts      INTEGER NOT NULL DEFAULT 1
);

CREATE INDEX IF NOT EXISTS fonbet_settlement_misses_last_seen_idx
  ON fonbet_settlement_misses (last_seen_at DESC);
