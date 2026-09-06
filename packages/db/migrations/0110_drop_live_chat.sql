-- 0110_drop_live_chat
--
-- Removes the live match-room chat (migration 0045). The feature is being
-- taken out whole — API module, WS fan-out dimension, rail "Chat" tab and
-- the storefront room component all go in the same change — and will be
-- rebuilt later from a fresh design rather than resumed from this model.
--
-- This DELETES every chat message and every crowd pick. That is the
-- operator's call, made deliberately: the re-do is expected to carry a
-- different schema, so keeping the rows would preserve data nothing will
-- ever read while leaving two tables and an enum sitting in the catalog
-- looking live. Nothing else in the system reads them — no ticket,
-- settlement, ledger or audit row references live_chat_messages or
-- live_chat_picks, and the ephemeral half of the feature (reactions,
-- viewer counts, the last-50 message cache) only ever lived in Redis and
-- expires on its own.
--
-- Order matters: both tables carry FKs into matches and users, so they
-- drop before anything else is touched. DROP TABLE takes ACCESS EXCLUSIVE
-- on the table AND on each table it references, because removing the FK
-- means removing the trigger on the referenced side — and `matches` is
-- written continuously by both ingesters. Hence the lock_timeout: if the
-- catalog is mid-write (or a pg_dump is holding AccessShareLock on every
-- table, which the pre-deploy backup and the 03:00 cron both do for
-- minutes at a time) this migration aborts the deploy cleanly instead of
-- queueing every feed write behind itself. Retry once the writer clears.
--
-- IF EXISTS throughout so a database that never ran 0045 — a fresh local
-- checkout created after this lands, say — applies it as a no-op rather
-- than failing the whole migration run.

SET LOCAL lock_timeout = '5s';

DROP TABLE IF EXISTS live_chat_picks;
DROP TABLE IF EXISTS live_chat_messages;

-- The enum is only reachable from live_chat_messages.kind, so it is
-- unreferenced by the time we get here.
DROP TYPE IF EXISTS live_chat_message_kind;
