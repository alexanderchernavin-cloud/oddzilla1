-- 0045_live_chat.sql
--
-- Live match chat — Notion spec
-- (notion.so/Live-match-chat-32e64f04f9b480d48b13d808dbce2366).
--
-- Two tables:
--
--   live_chat_messages  Append-only log of user and system messages.
--                       Reactions are ephemeral broadcasts (Redis
--                       pub/sub) and are NOT stored here. The hot path
--                       reads/writes Redis (last-50 cached in
--                       chat:msgs:{matchId} as a capped list); durable
--                       history backfills from this table on cache
--                       miss and is what admin moderation reads.
--
--   live_chat_picks     One pick per (match_id, user_id) — the
--                       crowd-picks reveal-on-vote UX (Notion Epic 4)
--                       is server-enforced: picks_revealed is only
--                       sent after this row exists for the caller. The
--                       composite PK prevents double-voting at the DB
--                       layer; aggregate counters cache in Redis
--                       (chat:picks:{matchId} hash) so viewer joins
--                       don't scan this table.
--
-- Match identity reuses the existing matches table — there is no
-- live_chat_rooms table. A "room" is just a match_id. Match score /
-- clock / status updates flow through the existing odds-publisher
-- pipeline (odds:match:{id}) and are not duplicated here; a small
-- watcher in services/api detects score deltas and emits goal /
-- half_time / full_time rows into live_chat_messages with kind='system'.
--
-- No new currency column: chat is currency-agnostic. The BetPin
-- (Notion Epic 5) reads from the existing tickets table at render
-- time; the chat tables don't denormalise bet state.

-- Kind discriminator for messages. Future extension (e.g. 'admin',
-- 'moderation') goes here. 'system' rows carry a non-null
-- system_kind + payload jsonb; 'user' rows always carry user_id.
CREATE TYPE live_chat_message_kind AS ENUM ('user', 'system');

CREATE TABLE live_chat_messages (
    id              BIGSERIAL PRIMARY KEY,
    match_id        BIGINT NOT NULL
                    REFERENCES matches(id) ON DELETE CASCADE,
    kind            live_chat_message_kind NOT NULL,
    -- Nullable for system messages. For user messages the API enforces
    -- NOT NULL; the DB-side check below also catches bypasses.
    user_id         UUID
                    REFERENCES users(id) ON DELETE SET NULL,
    -- 320-char ceiling: API caps user input at 160 (Notion UC02);
    -- system messages (e.g. "Goal — Arsenal 2-1 Chelsea (74')")
    -- need a little headroom for team-name expansion. No emoji
    -- characters anywhere (CLAUDE.md invariant 8) — system messages
    -- use plain ASCII prefixes.
    text            TEXT NOT NULL,
    -- Only set when kind='system'. Free-text rather than an enum so
    -- new event types (red card, var, penalty) ship without a
    -- migration. The known set is documented in
    -- packages/types/src/live-chat.ts.
    system_kind     TEXT,
    -- Snapshot of match state at emit time for system messages:
    --   { "score": { "home": 2, "away": 1 }, "clock": "74'",
    --     "status": "live" }
    -- NULL for user messages.
    payload         JSONB,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT live_chat_messages_text_length
        CHECK (length(text) BETWEEN 1 AND 320),
    CONSTRAINT live_chat_messages_user_required
        CHECK (kind <> 'user' OR user_id IS NOT NULL),
    CONSTRAINT live_chat_messages_system_kind_required
        CHECK (kind <> 'system' OR system_kind IS NOT NULL)
);

-- Feed pagination: (match_id, created_at DESC) lets the API stream
-- the last N rows per room without a full scan. id is bigserial so
-- ties on created_at break deterministically.
CREATE INDEX live_chat_messages_match_created_idx
    ON live_chat_messages (match_id, created_at DESC, id DESC);

-- Moderator history view: who-posted-what across all rooms.
CREATE INDEX live_chat_messages_user_idx
    ON live_chat_messages (user_id)
    WHERE user_id IS NOT NULL;

CREATE TABLE live_chat_picks (
    match_id    BIGINT NOT NULL
                REFERENCES matches(id) ON DELETE CASCADE,
    user_id     UUID NOT NULL
                REFERENCES users(id) ON DELETE CASCADE,
    -- 'home' | 'draw' | 'away'. Free-text + CHECK rather than an enum
    -- so a future "no_draw" sport (Valorant best-of) can extend
    -- without a schema migration; the API still constrains the input.
    pick        TEXT NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    PRIMARY KEY (match_id, user_id),
    CONSTRAINT live_chat_picks_value
        CHECK (pick IN ('home', 'draw', 'away'))
);

-- Aggregate counters for crowd-picks reveal — (match_id, pick) lets
-- the watcher count votes per outcome without a Sort.
CREATE INDEX live_chat_picks_match_pick_idx
    ON live_chat_picks (match_id, pick);
