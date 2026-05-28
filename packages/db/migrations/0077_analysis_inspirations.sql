-- 0077_analysis_inspirations.sql
--
-- Per-viewer dedup ledger for analyses inspirations. Mirror of
-- community_ticket_inspirations (migration 0045) but keyed on the
-- analysis instead of the settled-ticket projection.
--
-- Why a separate table:
--   community_ticket_inspirations FKs into community_tickets, which
--   only exists post-settlement. Pre-match copies — including every
--   copy via the Analyses surface — have no projection row, so the
--   existing dedup misses them. The analyses inspiration counter
--   needs its own dedup so its threshold semantics (≥10 → reward
--   eligibility per the Reward formula V1 spec) are inflatable-proof.
--
-- Why one row per (analysis, viewer):
--   Same convention as community_ticket_inspirations — a viewer
--   contributes at most +1 to any given analysis's inspiration_count.
--   Repeat clicks from the same viewer no-op via ON CONFLICT.
--
-- Writer:
--   services/api/.../community/routes.ts — extends the existing
--   /community/copy/:communityTicketId handler. When the copied
--   ticket has an attached analysis, the same transaction also INSERTs
--   here, bumps analyses.inspirationCount, and (on the +10 crossing)
--   credits the author's Oz balance via creditOz.

BEGIN;

CREATE TABLE analysis_inspirations (
    analysis_id  UUID    NOT NULL REFERENCES analyses(id) ON DELETE CASCADE,
    viewer_id    UUID    NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    inspired_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (analysis_id, viewer_id)
);

-- "Which analyses did this viewer inspire?" — future profile surface.
-- Cheap; the table is sparse compared to analyses.
CREATE INDEX analysis_inspirations_viewer_idx
    ON analysis_inspirations (viewer_id, inspired_at DESC);

COMMIT;
