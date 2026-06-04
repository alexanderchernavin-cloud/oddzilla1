-- 0080_support_ai_bot.sql
--
-- Gemma-powered autonomous support assistant wired into the live-support
-- chat. An operator-PC worker (services/support-ai-bot) runs the local
-- model via LM Studio and posts replies through /webhooks/support-ai/:secret.
--
--   support_messages.via_ai      Marks a reply authored by the assistant.
--                                Kept as sender_kind='admin' + a dedicated
--                                AI support user so the storefront widget
--                                renders it as a normal support reply; the
--                                admin UI badges it via this flag. No enum
--                                change (avoids touching every sender_kind
--                                switch in the web app).
--
--   support_threads.ai_handling  The bot only picks up threads where this
--                                is true. A human "Take over" (or the bot
--                                escalating) flips it false so the assistant
--                                never re-enters a human-owned conversation
--                                until "Resume AI".
--   support_threads.ai_paused_at When ai_handling was last turned off.
--
-- A dedicated AI support user (fixed UUID) is the reply author. role='support'
-- so its messages resolve a friendly display name; is_ai=true keeps it out of
-- PnL/KPIs (same treatment as seeded AI bettors). The password hash is a
-- non-argon2 sentinel — verifyPassword() returns false on a malformed hash
-- (try/catch in packages/auth/src/password.ts), so the account can never be
-- logged into even though it shares the admin email namespace (migration 0065).

ALTER TABLE support_messages
    ADD COLUMN IF NOT EXISTS via_ai BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE support_threads
    ADD COLUMN IF NOT EXISTS ai_handling  BOOLEAN NOT NULL DEFAULT TRUE,
    ADD COLUMN IF NOT EXISTS ai_paused_at TIMESTAMPTZ;

-- Bot work queue: open threads the assistant still owns that have an
-- unanswered bettor message. Mirrors support_threads_unread_admin_idx but
-- adds the ai_handling gate so GET /webhooks/support-ai/:secret/pending is a
-- tiny partial scan.
CREATE INDEX IF NOT EXISTS support_threads_ai_pending_idx
    ON support_threads (last_message_at DESC)
    WHERE status = 'open' AND ai_handling = TRUE AND unread_admin > 0;

-- Seed the assistant identity. Fixed UUID so application code (AI_SUPPORT_USER_ID
-- in @oddzilla/types) can attribute replies without a lookup. Idempotent.
INSERT INTO users (id, email, password_hash, status, role, display_name, is_ai)
VALUES (
    '00000000-0000-4000-8000-0000000a1b07',
    'assistant@oddzilla.cc',
    '!ai-assistant-no-login',
    'active',
    'support',
    'Oddzilla Assistant',
    TRUE
)
ON CONFLICT (id) DO NOTHING;
