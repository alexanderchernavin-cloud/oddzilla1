-- 0075_livesupport_chat.sql
--
-- Live support chat between bettors and the backoffice.
--
-- Two tables:
--
--   support_threads   One conversation between a single bettor and the
--                     ops team. Only one row may be 'open' per bettor —
--                     enforced by the partial unique index. Closing a
--                     thread frees the slot so a future issue starts a
--                     fresh conversation; historical threads stay around
--                     for audit. unread_user / unread_admin are
--                     denormalised counters so the floating widget badge
--                     and the admin sidebar badge are O(1) reads.
--
--   support_messages  Append-only message log. sender_kind discriminates
--                     bettor / operator / system rows; sender_user_id
--                     points at whichever user posted (NULL for system).
--
-- No new currency / sport / match coupling — support chat is a global
-- conversation, not tied to a specific bet or match. If a follow-up
-- needs that linkage the bettor can paste the ticket id into the body.

CREATE TYPE support_message_sender AS ENUM ('user', 'admin', 'system');

CREATE TABLE support_threads (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         UUID NOT NULL
                    REFERENCES users(id) ON DELETE CASCADE,
    status          TEXT NOT NULL DEFAULT 'open'
                    CHECK (status IN ('open', 'closed')),
    -- Subject is bettor-set on the first message — they pick a short
    -- one-liner (defaults to the first message body trimmed). Operator
    -- can edit later via the admin route. 200 chars matches the email
    -- thread cap and gives breathing room past the typical "Can't
    -- withdraw" tweet-length intro.
    subject         TEXT,
    -- Denormalised unread counters. user-side = messages the bettor
    -- hasn't acknowledged via /support/me/mark-read (i.e. messages
    -- posted by admin/system since the last read). admin-side mirrors:
    -- messages posted by the bettor since any operator marked the
    -- thread read. Maintained inside the same tx as the message insert
    -- and the corresponding mark-read updates so the counters can't
    -- drift away from the message log.
    unread_user     INTEGER NOT NULL DEFAULT 0
                    CHECK (unread_user >= 0),
    unread_admin    INTEGER NOT NULL DEFAULT 0
                    CHECK (unread_admin >= 0),
    last_message_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    -- Operator who took ownership. NULL = unassigned (any operator can
    -- reply). Currently informational; the admin UI surfaces it on the
    -- thread list but no permission gate hangs off it. Setting via
    -- POST /admin/support/threads/:id/assign is a follow-up.
    assigned_admin_id UUID
                    REFERENCES users(id) ON DELETE SET NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    closed_at       TIMESTAMPTZ,
    closed_by_user_id UUID
                    REFERENCES users(id) ON DELETE SET NULL,

    CONSTRAINT support_threads_subject_length
        CHECK (subject IS NULL OR char_length(subject) BETWEEN 1 AND 200),
    CONSTRAINT support_threads_closed_consistency
        CHECK ((status = 'closed') = (closed_at IS NOT NULL))
);

-- One open thread per bettor — opening a new one while the previous
-- is still open is an application-layer no-op (the user-side route
-- just re-uses the open row). Closed rows are unbounded.
CREATE UNIQUE INDEX support_threads_one_open_per_user
    ON support_threads (user_id)
    WHERE status = 'open';

-- Admin inbox list — recent-activity ordering across the whole open
-- set. The partial WHERE filters to open by default; the admin UI
-- toggles between open / closed / all.
CREATE INDEX support_threads_open_recent_idx
    ON support_threads (last_message_at DESC, id DESC)
    WHERE status = 'open';

CREATE INDEX support_threads_user_recent_idx
    ON support_threads (user_id, last_message_at DESC);

-- Sidebar badge: COUNT(*) over open threads with at least one
-- bettor-side message the operator hasn't seen. Partial index keeps
-- the scan tiny even when the closed-thread archive grows.
CREATE INDEX support_threads_unread_admin_idx
    ON support_threads (last_message_at DESC)
    WHERE status = 'open' AND unread_admin > 0;

CREATE TABLE support_messages (
    id              BIGSERIAL PRIMARY KEY,
    thread_id       UUID NOT NULL
                    REFERENCES support_threads(id) ON DELETE CASCADE,
    sender_kind     support_message_sender NOT NULL,
    -- Whichever user (bettor or operator) posted this row. NULL only
    -- for sender_kind='system' (e.g. "Thread closed by support"). The
    -- application caps bettor body length at 2000 chars; system /
    -- admin can go up to 4000 since copy-pasted links + canned
    -- responses run longer.
    sender_user_id  UUID
                    REFERENCES users(id) ON DELETE SET NULL,
    body            TEXT NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT support_messages_body_length
        CHECK (char_length(body) BETWEEN 1 AND 4000),
    CONSTRAINT support_messages_user_required
        CHECK (sender_kind = 'system' OR sender_user_id IS NOT NULL)
);

-- Per-thread chronological fetch — the thread-detail endpoint pages
-- through the last N rows ordered by id (ties on created_at).
CREATE INDEX support_messages_thread_id_idx
    ON support_messages (thread_id, id DESC);

-- Sender-history view across threads (operator audit: "what has admin
-- X posted across every thread"). Partial — system rows have no
-- author and never need this lookup.
CREATE INDEX support_messages_sender_idx
    ON support_messages (sender_user_id, created_at DESC)
    WHERE sender_user_id IS NOT NULL;
