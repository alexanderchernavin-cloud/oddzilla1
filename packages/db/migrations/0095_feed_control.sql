-- 0095_feed_control
--
-- Durable home for the operator's feed source switch (Auto / Prod Oddin
-- only / Backup Oddin) and its handshake fields.
--
-- The first cut (2026-09-03) kept the switch in plain Redis keys. The
-- production Redis runs `maxmemory 256mb` + `maxmemory-policy allkeys-lru`,
-- i.e. it is a cache that may evict ANY key, and on the very first day the
-- five feed:source* keys disappeared together while the operator had forced
-- Backup: bifrost-feed read an empty switch and fell back to Auto,
-- feed-ingester ran the switch-back flush + Oddin replay, and the operator's
-- decision was silently undone. Operator state must not live in a cache.
--
-- Singleton row (id = 1). Written by the api (PUT /admin/feed/source,
-- audit-logged), read every 2 s by feed-ingester and bifrost-feed, and
-- acknowledged by feed-ingester (flushed_at after the catalogue flush that
-- precedes a forced Backup; applied_source / applied_at whenever it adopts a
-- position). The liveness stamps and the bifrost-feed status hash stay in
-- Redis: they are refreshed every few seconds and losing one costs a tick.

CREATE TABLE IF NOT EXISTS feed_control (
  id             SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  source         TEXT NOT NULL DEFAULT 'auto' CHECK (source IN ('auto', 'prod', 'backup')),
  switched_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  switched_by    UUID REFERENCES users(id) ON DELETE SET NULL,
  -- feed-ingester stamps this after suspending the catalogue on a switch
  -- INTO backup; bifrost-feed waits for flushed_at >= switched_at (or 15 s)
  -- before re-emitting so the flush can never land on top of its data.
  flushed_at     TIMESTAMPTZ,
  -- what feed-ingester last adopted, for the backoffice card.
  applied_source TEXT CHECK (applied_source IS NULL OR applied_source IN ('auto', 'prod', 'backup')),
  applied_at     TIMESTAMPTZ,
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO feed_control (id, source) VALUES (1, 'auto')
ON CONFLICT (id) DO NOTHING;

COMMENT ON TABLE feed_control IS
  'Singleton: operator feed source switch (auto/prod/backup) with the feed-ingester flush + applied acknowledgements. Replaced the Redis feed:source* keys, which allkeys-lru could evict.';
