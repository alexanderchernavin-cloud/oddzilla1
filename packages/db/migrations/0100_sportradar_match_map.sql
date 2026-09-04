-- Sportradar match mapping.
--
-- Oddzilla already owns a match id for every fixture from every feed:
-- matches.id (bigserial), with matches.provider_urn carrying the source
-- id as 'od:match:<n>' (Oddin, esports) or 'fb:match:<n>' (Fonbet,
-- traditional sports). That covers two of the three id spaces the
-- storefront needs. The third — Sportradar — has no feed of its own
-- here: neither Oddin's fixture endpoint nor Fonbet's line carries an
-- SR id (measured 2026-09-04 across a full 13 667-event Fonbet
-- snapshot: no external-id field of any kind), and Sportradar's own
-- gismo feed answers `403 Unauthorized feed` to anything that is not on
-- a licensed origin.
--
-- So the SR id is the only one that has to be STORED rather than
-- derived, and the only one that can be WRONG. This table holds it,
-- along with the provenance needed to judge it:
--
--   * one row per match (match_id PK) — a match has at most one SR fixture
--   * status: 'confirmed' renders on the storefront, 'candidate' waits in
--     the admin queue, 'rejected' is a tombstone that keeps the matcher
--     from re-proposing a pair a human already turned down
--   * confidence + evidence: what the matcher saw, so a reviewer can
--     judge a pair without re-deriving it
--
-- sr_sport_id is stored, not looked up, because the Live Match Tracker
-- takes it as a separate widget prop and Sportradar's sport taxonomy is
-- theirs, not ours (their 12 is rugby, ours is called `rugby`; their 137
-- is esoccer). Denormalising it here means the storefront never has to
-- carry a translation table, and a hand-mapped oddity (a sport we file
-- under one slug that SR files under another) is expressible per row.

-- Adding the FK below takes a brief SHARE ROW EXCLUSIVE on `matches`,
-- which both feed ingesters write to continuously. The new table is
-- empty so there is nothing to validate and the lock is momentary — but
-- if it cannot be taken promptly, failing the deploy is far better than
-- queueing every feed write behind it (the failure mode migration 0023
-- was added to fix).
SET LOCAL lock_timeout = '5s';

CREATE TYPE sportradar_map_status AS ENUM ('candidate', 'confirmed', 'rejected');
CREATE TYPE sportradar_map_source AS ENUM ('admin', 'auto');

CREATE TABLE match_sportradar_ids (
  match_id     BIGINT PRIMARY KEY REFERENCES matches (id) ON DELETE CASCADE,
  sr_match_id  BIGINT NOT NULL,
  -- Sportradar sport id (1 soccer, 2 basketball, 5 tennis, ...). Required
  -- by the LMT widget alongside the match id.
  sr_sport_id  SMALLINT NOT NULL,
  status       sportradar_map_status NOT NULL DEFAULT 'candidate',
  source       sportradar_map_source NOT NULL,
  -- 0..1 for auto-matched rows; NULL when a human typed the id in.
  confidence   NUMERIC(4, 3),
  -- What the matcher matched against: the SR fixture's own names and
  -- kickoff, the per-component scores, and any runner-up candidates. Kept
  -- so a reviewer can judge the pair from the row alone.
  evidence     JSONB,
  reviewed_by_user_id UUID REFERENCES users (id) ON DELETE SET NULL,
  reviewed_at  TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT match_sportradar_confidence_range
    CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
  -- A recorded reviewer must carry the time they decided. Deliberately
  -- one-directional rather than a strict biconditional: reviewed_by is
  -- ON DELETE SET NULL, so deleting a departed admin nulls that column
  -- while reviewed_at stays — "reviewed at T by someone since removed"
  -- is a legitimate state, and a biconditional here would instead make
  -- deleting that admin fail with a check violation.
  CONSTRAINT match_sportradar_review_pairing
    CHECK (reviewed_by_user_id IS NULL OR reviewed_at IS NOT NULL)
);

-- One live mapping per SR fixture. Rejected rows are excluded so the
-- tombstone for a bad pair never blocks the correct match from claiming
-- the same SR id.
CREATE UNIQUE INDEX match_sportradar_srid_uniq
  ON match_sportradar_ids (sr_match_id)
  WHERE status <> 'rejected';

-- Admin review queue: "candidates, worst first" is the working order.
CREATE INDEX match_sportradar_status_idx
  ON match_sportradar_ids (status, confidence);

-- The unified view: every id space this platform knows for a match, in
-- one shape. Oddin and Fonbet ids are DERIVED from provider_urn rather
-- than copied into a table — they are already unique-indexed there and a
-- copy could only ever drift. Only Sportradar has a physical row,
-- because only Sportradar has no feed to re-derive it from.
--
-- Both live prefixes are exactly 9 characters ('od:match:', 'fb:match:'),
-- so `substring(... FROM 10)` is the numeric provider id. Verified
-- against production 2026-09-04: 138 913 od:match rows, 5 268 fb:match.
--
-- Rows whose URN is `od:tournament:%` (587 on the same date) are
-- DELIBERATELY excluded. Those are the auto-mapper's placeholders for
-- tournament outrights, which live in `matches` but are not fixtures:
-- they have no kickoff, no opponents, and no Sportradar counterpart. If
-- outrights ever become first-class, they want their own provider label
-- here rather than being folded in as matches.
CREATE VIEW match_external_ids AS
  SELECT m.id                             AS match_id,
         'oddin'                          AS provider,
         substring(m.provider_urn FROM 10) AS external_id,
         'confirmed'                      AS status,
         NULL::NUMERIC(4, 3)              AS confidence
    FROM matches m
   WHERE m.provider_urn LIKE 'od:match:%'
  UNION ALL
  SELECT m.id,
         'fonbet',
         substring(m.provider_urn FROM 10),
         'confirmed',
         NULL::NUMERIC(4, 3)
    FROM matches m
   WHERE m.provider_urn LIKE 'fb:match:%'
  UNION ALL
  SELECT s.match_id,
         'sportradar',
         s.sr_match_id::TEXT,
         s.status::TEXT,
         s.confidence
    FROM match_sportradar_ids s;

COMMENT ON VIEW match_external_ids IS
  'Every external id known for a match, one row per (match, provider). Oddin/Fonbet derived from matches.provider_urn; Sportradar from match_sportradar_ids.';
