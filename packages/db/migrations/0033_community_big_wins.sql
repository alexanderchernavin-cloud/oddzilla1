-- 0033_community_big_wins.sql
--
-- Renumbered from 0032 in a follow-up PR after #166 collided with
-- #167's USDC migration on the same idx. The journal entry that
-- ships with this rename is the canonical reference; the original
-- 0032 number was reused by USDC and never applied with this body.
--
-- Big Wins tab (PRD: Big-wins-section).
--
-- The Best Wins surface ships in three escalating tiers. Tier 1 (this
-- migration + the route changes) lays the data plumbing for the
-- visual half: a per-card "inspiration" counter — how many times this
-- ticket has been used as the source of a copy-to-bet — so the feed
-- can offer a "Most Copied" sort option alongside Most Recent and
-- High Stakes.
--
-- Why a denormalised counter and not an audit table?
--   The PRD treats inspirations as a coarse social-proof signal,
--   not a billable event. A counter lets the Most Copied sort use
--   the existing (score DESC, settled_at DESC) plan with one new
--   index, no JOIN, no aggregate. If we later need attribution
--   (which viewer copied what, dedupe by viewer cookie), an audit
--   table can be added without rewriting this column.
--
-- Inflation risk:
--   POST /community/copy/:id is anonymous and rate-limited at 30/min/IP.
--   That caps inflation at ~one extra inspiration every two seconds
--   per attacker, bounded by the 7-day Best Wins window. The PRD's
--   own commentary ("Most Copied" is a sort key, not a number we ask
--   the user to trust) is consistent with that ceiling — we trade
--   precision for read-path simplicity. Audit-table follow-up tracked
--   in the Phase B Apply-Same-Play epic.
--
-- Threshold (€500 / equivalent) is enforced in application code, not
-- in SQL: it varies per currency and may diverge per operator (PRD
-- Open Question #8). Keeping it out of the schema means we never
-- migrate when product retunes the floor.

BEGIN;

-- 1. Counter column. Default 0 backfills every existing row in one
--    pass; NOT NULL is safe because the default applies on insert too,
--    so the projection writer in services/api/src/modules/community/
--    projection.ts and its Go counterpart in
--    services/settlement/internal/store/store.go don't need to mention
--    inspiration_count when they upsert.
ALTER TABLE community_tickets
    ADD COLUMN inspiration_count INTEGER NOT NULL DEFAULT 0;

-- 2. Index serving the "Most Copied" sort. Mirrors the
--    (score DESC, settled_at DESC) shape of community_tickets_score_
--    settled_idx so the planner can pick whichever ordering the query
--    asks for without re-sorting the 7-day Best Wins window.
CREATE INDEX community_tickets_inspirations_idx
    ON community_tickets (inspiration_count DESC, settled_at DESC);

COMMIT;
