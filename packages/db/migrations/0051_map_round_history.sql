-- 0051_map_round_history — per-map round-by-round history capture.
--
-- The final `live_score.periods[i]` JSON stored on `matches` only
-- carries the FINAL per-map score (homeWonRounds / awayWonRounds at
-- map end). To support "team won the first 2 rounds of the map" or
-- "team was up 6-3 at the side switch" style conditional facts on
-- live matches, we need the sequence of round outcomes, not just the
-- final tally.
--
-- One row per (match, map). `round_winners` is a compact string of
-- single-char winners in chronological order: 'H' = home won the
-- round, 'A' = away won. Length === total rounds played so far.
-- For a finished CS2 map, this is up to 30 chars (16-13 typical).
-- The string is updated incrementally by feed-ingester on every
-- odds_change that carries an updated <sport_event_status>.
--
-- `home_won_total` / `away_won_total` track the SUM that's been
-- written into `round_winners` so the upsert can compute the delta
-- atomically with a single statement — see the catalog.go upsert.
--
-- Forward-only by construction: the upsert WHERE-guards reject any
-- update that would shrink the totals (recovery replays can re-send
-- earlier states, which we must ignore). The string only grows;
-- a partial-replay never rewrites history.
--
-- ROWS-PER-MAP semantics: the row is created on the FIRST observed
-- (home, away) state for that (match, map). Most maps will be seen
-- from (0, 0), giving an exact sequence. Late joiners (we connected
-- mid-map) approximate by appending all H's then all A's based on
-- the initial totals — the prefix counts are then approximate but
-- the totals are exact. The conditional-fact code that consumes
-- `round_winners[0:n]` accepts the approximation; over time, as
-- more matches are observed from round 0 onward, the data quality
-- improves uniformly.
--
-- No backfill: pre-migration matches don't appear in this table.
-- Conditional patterns that consult `round_winners` silently skip
-- those matches in their predicate-matching set. The streak threshold
-- of 5 means a team needs at least 5 post-migration matches with
-- qualifying round-history before round-prefix facts surface.

CREATE TABLE map_round_history (
  match_id          BIGINT      NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  map_number        SMALLINT    NOT NULL,
  round_winners     TEXT        NOT NULL DEFAULT '',
  home_won_total    SMALLINT    NOT NULL DEFAULT 0,
  away_won_total    SMALLINT    NOT NULL DEFAULT 0,
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (match_id, map_number),
  -- Cheap structural invariants — round_winners length must match
  -- the sum of home/away wins, and only the allowed chars appear.
  CONSTRAINT map_round_history_length_consistent
    CHECK (length(round_winners) = home_won_total + away_won_total),
  CONSTRAINT map_round_history_chars_allowed
    CHECK (round_winners ~ '^[HA]*$')
);

-- Lookup index for "fetch all map rows for a set of matches" — the
-- API's conditional-fact pass pulls round histories for the team's
-- last N closed matches in one query and walks them in TS.
CREATE INDEX map_round_history_match_idx
  ON map_round_history (match_id);
