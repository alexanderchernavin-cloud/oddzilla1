-- 0045_community_ticket_inspirations.sql
--
-- Audit SEC-H2 — per-viewer dedup for /community/copy.
--
-- Background: community_tickets.inspiration_count (migration 0033) is
-- a sort key on the Best Wins "Most Copied" surface. It was bumped on
-- every /community/copy POST under the route's 30/min/IP rate limit,
-- with no per-viewer dedup and no auth gate. A cheap IP-rotation
-- campaign could pin any target ticket to the top of the Most Copied
-- feed; the same call path also fired `pick_copied` notifications,
-- enabling notification-panel spam.
--
-- This table is the dedup primitive. The route now:
--   1. requireAuth() — anonymous copy is meaningless because the
--      resulting bet placement is gated downstream anyway.
--   2. INSERT … ON CONFLICT DO NOTHING into this table inside the
--      same transaction as the counter bump, so the +1 fires exactly
--      once per (ticket, viewer) lifetime.
--   3. Emits `pick_copied` only on a fresh insert.
--
-- Schema choices:
--   • PRIMARY KEY (community_ticket_id, viewer_user_id) — the natural
--     dedup key. ON CONFLICT keys directly off the PK so no separate
--     UNIQUE index is needed.
--   • inspired_at TIMESTAMPTZ DEFAULT now() — encodes "when" for
--     future analytics ("which copies converted into a bet placement")
--     at the same storage cost as a row-without-timestamp.
--   • Both FKs CASCADE on delete: the table is a denormalised audit
--     of an event between a ticket and a viewer; if either party
--     disappears the row carries no signal.
--   • Secondary index on (viewer_user_id, inspired_at DESC) supports
--     a future "tickets I've copied" surface (PRD Phase 13 history)
--     without needing a backfill. It's cheap — the table is sparse
--     compared to community_tickets itself (one row per copy event).
--
-- Why a separate table rather than a column on community_tickets:
--   • Dedup is per-(ticket, viewer), not per-ticket. A counter column
--     can't express that without a JOIN onto a tracking table anyway.
--   • Keeps the hot Best Wins read path (community_tickets table) lean.
--   • Lets the future "tickets I copied" history surface read this
--     table directly with no projection rebuild.

BEGIN;

CREATE TABLE community_ticket_inspirations (
    community_ticket_id  UUID        NOT NULL,
    viewer_user_id       UUID        NOT NULL,
    inspired_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (community_ticket_id, viewer_user_id),
    CONSTRAINT community_ticket_inspirations_community_ticket_fk
        FOREIGN KEY (community_ticket_id)
        REFERENCES community_tickets (ticket_id)
        ON DELETE CASCADE,
    CONSTRAINT community_ticket_inspirations_viewer_fk
        FOREIGN KEY (viewer_user_id)
        REFERENCES users (id)
        ON DELETE CASCADE
);

CREATE INDEX community_ticket_inspirations_viewer_idx
    ON community_ticket_inspirations (viewer_user_id, inspired_at DESC);

-- Audit SEC-L2 — counter overflow on INT4.
--
-- inspiration_count (community_tickets, analyses) and thumbs_up_count
-- (analyses) are unbounded denormalised counters bumped at API write
-- time. INT4's 2^31 ceiling is in principle reachable over a long
-- enough horizon (a single viral analysis hitting it would silently
-- corrupt the sort key). BIGINT raises the ceiling to 2^63 — well
-- past any realistic surface — at one extra word per row, which is
-- negligible compared to the row footprint of community_tickets /
-- analyses. ALTER … TYPE on an INTEGER → BIGINT rewrite is metadata-
-- only on Postgres ≥ 12 when the column has no expression indexes
-- that depend on the type; the inspiration_count indexes are plain
-- DESC sorts so the planner rebuilds them without a table rewrite.
ALTER TABLE community_tickets
    ALTER COLUMN inspiration_count TYPE BIGINT;

ALTER TABLE analyses
    ALTER COLUMN inspiration_count TYPE BIGINT;

ALTER TABLE analyses
    ALTER COLUMN thumbs_up_count TYPE BIGINT;

COMMIT;
