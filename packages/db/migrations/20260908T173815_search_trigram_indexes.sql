-- Trigram indexes for the top-bar search (`GET /catalog/search`).
--
-- That endpoint is the one public read with no cache and no usable
-- index: it runs `ILIKE '%needle%'` across four facets, and a leading
-- wildcard makes every b-tree on those columns useless, so each facet
-- was a full scan of its table. Measured on production 2026-09-08 with
-- the needle "united" (a realistic one — 246 competitors match it):
--
--     facet         cold      warm    what the plan actually did
--     ----------------------------------------------------------------
--     teams        1497 ms   158 ms   Seq Scan on competitors, 22 267
--                                     rows -> 246, 588 blocks read cold
--     matches       190 ms   331 ms   Index Scan on (status,
--                                     scheduled_at), ILIKE as a FILTER
--                                     discarding 8 997 rows to find 88
--     tournaments    91 ms    60 ms   Seq Scan, 2 240 rows -> 6 (4.5 ms
--                                     of the 60; the rest is its EXISTS)
--
-- ~1.8 s cold for one keystroke of a type-ahead. `pg_trgm` turns each
-- of those filters into a bitmap index scan over the rows that actually
-- match. Re-measured with these indexes in place, in the same
-- rolled-back transaction, so the planner really was choosing them:
--
--     facet         warm before   warm after
--     ------------------------------------------------------------
--     matches           331 ms       11.4 ms   BitmapAnd of the two
--                                              team-name indexes
--     tournaments        60 ms        3.7 ms
--     teams             158 ms      107 ms     see below
--
-- The teams facet keeps most of its cost, and that is expected rather
-- than disappointing: the index removes its 22 267-row scan, but its
-- real expense is the OR join to `matches` fanned out over the 246
-- competitors "united" genuinely matches, each doing a bitmap heap scan
-- that mostly discards rows on the status filter. Closing that would
-- mean widening `matches_home_competitor_idx` / `_away_` to carry
-- `status`, which is two more indexes on the table both ingesters write
-- continuously — a separate decision, deliberately not taken here.
--
-- WHY BOTH COLUMNS OF EACH PAIR. The two facets that search two columns
-- do it with an OR (`name ILIKE n OR abbreviation ILIKE n`), and an OR
-- can only use indexes when BOTH sides have one — otherwise the planner
-- falls back to a scan and the single index buys nothing. Indexing
-- `competitors.name` alone would have left the worst facet exactly as
-- slow as it is today.
--
-- WHAT IS DELIBERATELY NOT INDEXED. `sports` — 69 rows, and its seq
-- scan measured 0.03 ms. An index there would cost writes to serve a
-- scan that is already free, the same reasoning migration 0103 gives
-- for leaving `display_order` unindexed.
--
-- THE LIMIT, STATED PLAINLY. `gin_trgm_ops` can only serve a pattern
-- containing at least one full trigram, so a one- or two-character
-- query still falls back to a scan. That is not a gap worth closing
-- here: those queries match early and the LIMIT 6 stops them fast
-- (2-char needle measured 9.7 ms), and the response cache added
-- alongside this migration covers the case where they repeat, which is
-- exactly what a type-ahead does as somebody types the first letters of
-- a team name.
--
-- LOCKING. `CREATE INDEX` takes SHARE, which blocks writes while it
-- builds, and both ingesters write `matches` continuously. Non-
-- concurrent because the migration runner wraps every file in one
-- transaction (packages/db/src/migrate.ts) and CREATE INDEX
-- CONCURRENTLY cannot run inside one. That is affordable because the
-- builds are small, which was rehearsed on production rather than
-- assumed: on 168 342 matches / 22 267 competitors / 2 240 tournaments
-- the whole file took 1.57 s, the longest single lock was 683 ms on
-- `matches`, and the five indexes come to 24 MB. `lock_timeout` so a
-- pre-deploy or 03:00-cron
-- pg_dump holding AccessShareLock aborts the deploy cleanly instead of
-- queueing the catalog behind this file — the same guard migrations
-- 0100, 0106 and 0110 carry; `statement_timeout` so a build that goes
-- wrong on a much larger future table gives the lock back rather than
-- holding it open.

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Matches: the two team-name columns the fourth facet ORs over.
CREATE INDEX IF NOT EXISTS matches_home_team_trgm_idx
  ON matches USING gin (home_team gin_trgm_ops);
CREATE INDEX IF NOT EXISTS matches_away_team_trgm_idx
  ON matches USING gin (away_team gin_trgm_ops);

-- Competitors: the slowest facet. NULL abbreviations produce no
-- trigrams and are simply absent from the index, so no partial
-- predicate is needed to keep it small.
CREATE INDEX IF NOT EXISTS competitors_name_trgm_idx
  ON competitors USING gin (name gin_trgm_ops);
CREATE INDEX IF NOT EXISTS competitors_abbreviation_trgm_idx
  ON competitors USING gin (abbreviation gin_trgm_ops);

-- Tournaments: worth ~4.5 ms of a 60 ms facet today, which is small.
-- It is here because that is the part of the facet that grows with the
-- catalogue (the rest is a bounded EXISTS), and 2 240 rows written a
-- few times per fixture refresh make the write cost nil.
CREATE INDEX IF NOT EXISTS tournaments_name_trgm_idx
  ON tournaments USING gin (name gin_trgm_ops);
