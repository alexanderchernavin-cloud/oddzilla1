-- 0089_zillaboost_graphics_banner.sql
--
-- AI-generated graphics for ZillaBoost promo banners. The admin popup
-- gains a "Generate graphics banner" option; ticking it enqueues a job
-- that an OPERATOR-PC worker (services/zillaboost-banner-gen — NOT in
-- the docker stack) picks up over outbound HTTPS, researches the boosted
-- entities (Wikipedia), writes an image prompt via a local LLM
-- (LM Studio), renders it on a local image model, and uploads the result.
--
-- Pull model on purpose: the production box NEVER dials the operator's
-- LAN. While the PC is off, jobs simply accumulate as status='pending'
-- rows; when it comes back the worker drains the queue. The operator's
-- "retry hourly when the PC is unreachable" requirement is therefore
-- server-side free — reachability retry only exists inside the worker,
-- for its LOCAL image backend.
--
-- Image bytes live HERE, not on boosted_odds_config: the pricing paths
-- (loadBoostRulesForMatch / loadBoostRulesForMatches) do full-row
-- selects of the rules table on hot catalog requests, and a BYTEA
-- column there would ride along on every one of them.
--
-- One row per rule (rule_id PK): re-generating resets the SAME row to
-- pending, and the previous image stays in place until the replacement
-- lands — the storefront banner never blanks mid-regenerate.

BEGIN;

ALTER TABLE boosted_odds_config
  ADD COLUMN graphics_banner boolean NOT NULL DEFAULT false;

CREATE TABLE zillaboost_banner_image_jobs (
  rule_id         uuid PRIMARY KEY
                  REFERENCES boosted_odds_config(id) ON DELETE CASCADE,
  status          text NOT NULL DEFAULT 'pending',
  attempts        integer NOT NULL DEFAULT 0,
  last_error      text,
  -- Claim lease: a job handed to the worker stays invisible to further
  -- /pending polls until the lease expires, so a crashed worker's job
  -- returns to the queue on its own.
  leased_until    timestamptz,
  -- Generation-failure backoff (the worker reported a real error): the
  -- job stays pending but is not offered again before this instant.
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  image_data      bytea,
  image_mime      text,
  generated_at    timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT zillaboost_banner_image_jobs_status
    CHECK (status IN ('pending', 'done', 'failed')),
  -- Bytes and mime travel together, mime from the browser-safe set.
  CONSTRAINT zillaboost_banner_image_jobs_mime CHECK (
    (image_data IS NULL AND image_mime IS NULL)
    OR (image_data IS NOT NULL
        AND image_mime IN ('image/png', 'image/jpeg', 'image/webp'))
  )
);

CREATE INDEX zillaboost_banner_image_jobs_pending_idx
  ON zillaboost_banner_image_jobs (next_attempt_at)
  WHERE status = 'pending';

COMMIT;
