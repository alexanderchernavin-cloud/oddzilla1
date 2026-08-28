-- 0090_banner_gen_prompt.sql
--
-- Record the diffusion prompt each banner graphic was rendered from.
--
-- Image quality is iterated by changing the prompt, and until now the
-- prompt existed only in the operator PC's worker log — so "why is this
-- Dota banner full of soldiers" was unanswerable from the backoffice.
-- Storing it makes the admin overview self-diagnosing and lets a later
-- prompt change be evaluated against what the previous one actually
-- asked for.
--
-- Nullable: rows generated before this migration keep NULL, and the
-- upload route treats the field as optional so an older worker build
-- still completes jobs.

BEGIN;

ALTER TABLE zillaboost_banner_image_jobs
  ADD COLUMN last_prompt text;

COMMIT;
