-- 0106_tournament_risk_tier_source
--
-- Records WHO decided a tournament's risk tier, so the backoffice can tell
-- an unreviewed row apart from a reviewed one.
--
-- Until now `tournaments.risk_tier` had exactly two provenances and only
-- one bit to express them: risk_tier_locked (migration 0094) meant "an
-- operator typed this", and everything else was lumped together as "auto"
-- — including the 1 231 rows that carry NO tier at all because nothing
-- ever assigned one. Those are not automatic, they are unreviewed, and an
-- operator reading the list had no way to see which of the untiered rows
-- had been looked at.
--
-- ZillaAGI (the in-house LLM at llm.oddin.gg) now reviews them. Its
-- verdicts need to be distinguishable from both of the existing states:
-- from `manual`, because a machine judgement is weaker evidence than an
-- operator's and should be re-openable in bulk; and from `auto`, because
-- `auto` is precisely the set still waiting to be reviewed.
--
-- Why this is a loosening, and therefore conservative by construction:
-- RiskZilla prices a NULL risk_tier at UNTIERED_RISK_TIER = 10, the
-- STRICTEST row in riskzilla_settings (50 USDC match liability against
-- tier 1's 50 000). So every tier this assigns RAISES the book's exposure
-- on that competition. That is the whole reason the reviewer clamps each
-- verdict to a per-sport ceiling in code rather than trusting the model to
-- respect one, and the reason a verdict it cannot parse leaves the row
-- untouched at NULL rather than defaulting to anything.
--
-- Columns are nullable / defaulted, so every existing row keeps today's
-- behaviour byte-for-byte until something writes to them.

-- ADD COLUMN with a default is metadata-only on PG11+, so this is fast --
-- but it still takes ACCESS EXCLUSIVE on a table both ingesters write to.
-- Failing the deploy beats queueing every catalog write behind it. Same
-- reasoning as 0100.
SET LOCAL lock_timeout = '5s';

ALTER TABLE tournaments
  -- 'auto'   — feed-assigned or never reviewed (the pre-existing state)
  -- 'manual' — an operator typed it in the backoffice; risk_tier_locked
  -- 'zagi'   — ZillaAGI reviewed it
  ADD COLUMN IF NOT EXISTS risk_tier_source TEXT NOT NULL DEFAULT 'auto',
  -- The reviewer's one-line justification, shown on hover in the admin
  -- list. Capped because it is model output rendered into a page.
  ADD COLUMN IF NOT EXISTS risk_tier_note TEXT,
  -- Stamped when a verdict actually lands. Doubles as the "already
  -- reviewed" marker for the sweeper's selector.
  ADD COLUMN IF NOT EXISTS risk_tier_reviewed_at TIMESTAMPTZ,
  -- Bounded retry. A row the model declines to judge (or that its reply
  -- omitted) stays NULL and is retried on later sweeps; without a counter
  -- an unjudgeable row would be re-sent to the model forever. Same shape
  -- as push_notifications_outbox.attempts.
  ADD COLUMN IF NOT EXISTS risk_tier_attempts SMALLINT NOT NULL DEFAULT 0;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'tournaments_risk_tier_source_check'
  ) THEN
    ALTER TABLE tournaments
      ADD CONSTRAINT tournaments_risk_tier_source_check
      CHECK (risk_tier_source IN ('auto', 'manual', 'zagi'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'tournaments_risk_tier_note_len'
  ) THEN
    ALTER TABLE tournaments
      ADD CONSTRAINT tournaments_risk_tier_note_len
      CHECK (risk_tier_note IS NULL OR length(risk_tier_note) <= 500);
  END IF;
END
$$;

-- Existing hand-assigned rows are 'manual' by definition. There are none
-- on production today (risk_tier_locked is false everywhere), but the
-- backfill has to be correct rather than merely unnecessary — this
-- migration runs at deploy time, not authoring time.
UPDATE tournaments
   SET risk_tier_source = 'manual'
 WHERE risk_tier_locked
   AND risk_tier_source = 'auto';

COMMENT ON COLUMN tournaments.risk_tier_source IS
  'Who decided risk_tier: auto (feed-assigned or never reviewed), manual (operator, implies risk_tier_locked), zagi (ZillaAGI review).';
COMMENT ON COLUMN tournaments.risk_tier_note IS
  'ZillaAGI''s one-line justification for the assigned tier. Model output — render as text, never as markup.';
COMMENT ON COLUMN tournaments.risk_tier_reviewed_at IS
  'When a ZillaAGI verdict last landed on this row.';
COMMENT ON COLUMN tournaments.risk_tier_attempts IS
  'ZillaAGI review attempts. Bounds retry on rows the model will not judge.';

-- No index. tournaments is under 2 000 rows; the sweeper's selector scans
-- it in well under a millisecond, and an index here would cost every feed
-- write to serve a scan that is already free. Same reasoning as 0103.
