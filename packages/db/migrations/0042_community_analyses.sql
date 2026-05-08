-- 0042_community_analyses.sql
--
-- Phase 10.5 — Pre-match analyses (PRD: Analyses).
--
-- An analysis is a pre-match editorial post by a bettor, anchored to a
-- specific match, with the author's own ticket attached as "skin in
-- the game" (Tipsport pattern; see docs/notion: Publisher rewards
-- philosophy). The author writes 100–5000 chars + a ≤100-char perex,
-- attaches one ticket whose legs reference the match, and the post is
-- published until kickoff. Other users 👍 and copy-to-bet; when the
-- attached ticket settles the analysis inherits the outcome.
--
-- V1 stance per the rewards philosophy doc:
--   • Engagement-based, not cash-share. The reward currency is a
--     cosmetic / status ladder built on the data primitives below
--     (inspiration_count, thumbs_up_count, settled outcome). Cash
--     share (Liga Stavok pattern) is deferred but the schema doesn't
--     foreclose it: copy attribution columns on community_tickets
--     give a future cash mechanic everything it needs without a
--     schema migration.
--
-- Why a separate analyses table (not a column on tickets)?
--   • A ticket is a financial primitive with a CHECK constraint and
--     a placement audit trail; an analysis is editorial content with
--     a body that can be edited (within rules), banned, voided, etc.
--     Conflating them would force every editorial change through a
--     financial-grade write path.
--   • One ticket → at most one analysis (the author's), but one
--     analysis can have many copies. Modelling that as
--     analyses(ticket_id) keeps the FK direction natural.
--   • Ranking, search, and feed reads don't need ticket detail —
--     they read inspiration_count / thumbs_up_count / outcome /
--     content. A separate table keeps the hot read path cold-friendly.
--
-- Why outcome on the analysis row, not derived live from the ticket?
--   • Settlement is the hot path for thousands of tickets at once.
--     Joining `tickets` into every analysis read on a settled-ticket-
--     count join across the projection would multiply read cost.
--     Storing the derived outcome at settle time lets the feed query
--     stay (analyses ⨝ users) only.
--   • Cashout-voids-reward (Tipsport convention) is encoded as
--     `cashed_out_void` distinct from `won` so future reward logic
--     can void rewards on cashout without re-reading the source ticket.

BEGIN;

-- 1. Status enum. 'draft' is reserved for a future autosave flow
-- (PRD lists it as optional in V1); the API only ever inserts
-- 'published' rows for now. 'banned' is the moderation outcome.
-- 'voided' covers the case where the match never started (cancelled,
-- postponed past the analysis's relevance window) — we keep the row
-- for audit but exclude it from the feed.
CREATE TYPE analysis_status AS ENUM ('draft', 'published', 'banned', 'voided');

-- 2. Outcome enum. NULL = pending (match hasn't settled yet).
-- Mirrors ticket settlement granularity rather than collapsing
-- cashed_out into 'won' so reward logic can apply the
-- cashout-voids-reward rule.
CREATE TYPE analysis_outcome AS ENUM ('won', 'lost', 'void', 'cashed_out_void');

-- 3. Analyses table.
CREATE TABLE analyses (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    author_id    UUID    NOT NULL REFERENCES users(id),
    match_id     BIGINT  NOT NULL REFERENCES matches(id),
    -- Skin-in-the-game ticket. The API enforces (a) the ticket is
    -- the author's, (b) every leg references this match, (c) the
    -- ticket was placed pre-kickoff with min odds 1.30 (PRD).
    -- ON DELETE RESTRICT because deleting a ticket would silently
    -- orphan an analysis; tickets aren't deleted in normal flows
    -- anyway (status changes to 'voided' instead).
    ticket_id    UUID    NOT NULL REFERENCES tickets(id) ON DELETE RESTRICT,
    perex        TEXT    NOT NULL,                                 -- summary line
    body         TEXT    NOT NULL,                                 -- 100–5000 chars
    status       analysis_status NOT NULL DEFAULT 'published',
    -- Engagement counters. Both bumped at API write time and read
    -- directly from the row — no aggregate queries on the read path.
    -- See the inspiration_count comment in 0033_community_big_wins.sql
    -- for the precision-vs-simplicity trade-off.
    thumbs_up_count   INTEGER NOT NULL DEFAULT 0,
    inspiration_count INTEGER NOT NULL DEFAULT 0,
    -- Outcome derived from ticket settlement; NULL until settled.
    outcome      analysis_outcome,
    settled_at   TIMESTAMPTZ,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    published_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK (char_length(perex) BETWEEN 1 AND 100),
    CHECK (char_length(body)  BETWEEN 100 AND 5000),
    CHECK (thumbs_up_count   >= 0),
    CHECK (inspiration_count >= 0)
);

-- One published analysis per (author, match). Drafts and banned/voided
-- rows don't count — the partial unique index makes that explicit.
-- Without this, a careless double-POST creates two cards on the same
-- match by the same author, which the PRD's per-match feed presents
-- as duplicates.
CREATE UNIQUE INDEX analyses_one_published_per_author_match
    ON analyses (author_id, match_id)
    WHERE status = 'published';

-- Per-match feed (the match-page Analyses section reads this).
-- Filters down to published rows so banned/voided don't pollute the
-- planner stats.
CREATE INDEX analyses_match_published_idx
    ON analyses (match_id, published_at DESC)
    WHERE status = 'published';

-- "Most Inspired" / "Most Reacted" sort on the cross-match feed.
-- Score-style indexes mirror community_tickets_inspirations_idx and
-- community_tickets_score_settled_idx from 0033.
CREATE INDEX analyses_inspirations_idx
    ON analyses (inspiration_count DESC, published_at DESC)
    WHERE status = 'published';

CREATE INDEX analyses_thumbs_idx
    ON analyses (thumbs_up_count DESC, published_at DESC)
    WHERE status = 'published';

-- "Recent" sort + author-profile feed.
CREATE INDEX analyses_published_at_idx
    ON analyses (published_at DESC)
    WHERE status = 'published';

CREATE INDEX analyses_author_published_idx
    ON analyses (author_id, published_at DESC)
    WHERE status = 'published';

-- Settlement hook needs to find every analysis attached to a settling
-- ticket cheaply. ticket_id is unique-ish (one author = one ticket)
-- but not enforced UNIQUE because a ticket might back analyses on
-- different matches in pathological data — keep the join cheap rather
-- than the constraint tight.
CREATE INDEX analyses_ticket_id_idx ON analyses (ticket_id);

-- 4. Reactions. One thumbs-up per (analysis, viewer); the PK enforces
-- idempotency without a UNIQUE constraint. No emoji column —
-- 'thumbs_up' is the only reaction in V1 (PRD Quality rules: "I don't
-- like the dislike button, it's toxic"). Future reactions add an enum
-- and a kind column without changing this PK.
CREATE TABLE analysis_reactions (
    analysis_id  UUID NOT NULL REFERENCES analyses(id) ON DELETE CASCADE,
    user_id      UUID NOT NULL REFERENCES users(id),
    reacted_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (analysis_id, user_id)
);

-- 5. Copy attribution on the community_tickets projection. When a
-- viewer copies an analysis (or a feed card linked to one), the
-- /community/copy handler records who they copied from, so the
-- ranking algorithm can compute "inspired bet turnover" — the sum
-- of stakes copiers placed via this analysis.
--
-- Both columns nullable: organic tickets carry NULL; copies from
-- non-analysis sources (Big Win cards, profile copies) carry only
-- copied_from_publisher_id. The pair (analysis_id, publisher_id) is
-- redundant on copy-from-analysis paths but storing both lets
-- downstream rewards reason about "publisher's analyses" vs
-- "publisher's organic-but-copied tickets" without a JOIN.
ALTER TABLE community_tickets
    ADD COLUMN copied_from_analysis_id  UUID REFERENCES analyses(id),
    ADD COLUMN copied_from_publisher_id UUID REFERENCES users(id);

-- Inspired-turnover read path. A publisher's lifetime inspired
-- turnover = SUM(stake_micro) WHERE copied_from_publisher_id = me.
-- The index supports both that aggregate and the per-analysis
-- variant.
CREATE INDEX community_tickets_copied_from_analysis_idx
    ON community_tickets (copied_from_analysis_id)
    WHERE copied_from_analysis_id IS NOT NULL;

CREATE INDEX community_tickets_copied_from_publisher_idx
    ON community_tickets (copied_from_publisher_id)
    WHERE copied_from_publisher_id IS NOT NULL;

COMMIT;
