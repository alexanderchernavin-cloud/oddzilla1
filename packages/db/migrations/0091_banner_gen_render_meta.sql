-- 0091_banner_gen_render_meta.sql
--
-- Record the render parameters alongside the prompt (0090) so the
-- backoffice can tell a PROMPT problem from a PARAMS problem.
--
-- Concretely: checkpoint (a FLUX vs SD3.5 pick changes everything —
-- FLUX ignores negative prompts and needs cfg 1.0), cfg / steps /
-- sampler, the negative prompt actually applied, the output size, and
-- the seed. The seed is the reproducibility handle: with prompt + seed +
-- params an operator can re-render the exact image by hand in ComfyUI
-- and iterate from there.
--
-- jsonb rather than columns because this is diagnostic detail whose
-- shape follows whatever backend imagegen.ts talks to; nullable, and the
-- upload routes treat it as optional so an older worker build still
-- completes jobs.

BEGIN;

ALTER TABLE zillaboost_banner_image_jobs
  ADD COLUMN last_render_meta jsonb;

COMMIT;
