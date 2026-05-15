-- ZillaFlash rotation config. Singleton row keyed by id='default' so
-- the engine can hot-reload TTL changes without an api restart.
--
-- The engine reads this row periodically (cached for the rotation
-- tick) and uses the values to size new offer windows; live offers
-- currently warm at 15 s and prematch at 30 s (halved from the
-- original hardcoded 60 s after a product call). Bounds are
-- conservative — prematch must still feel like a window the bettor
-- can act inside, and live must be short enough that the boost is
-- a real micro-moment.

CREATE TABLE zillaflash_config (
  id TEXT PRIMARY KEY DEFAULT 'default'
    CHECK (id = 'default'),
  -- Master switch. When false the engine skips refilling slots and
  -- the storefront polls return an empty payload. Storefront row +
  -- match-page chip both render nothing.
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  -- Per-offer time window (seconds). Lower bound 5 s keeps a UI
  -- countdown legible at our 250 ms tick rate; upper bound 600 s
  -- (10 min) guards against an admin typo that would freeze a slot
  -- for ages and starve the rotation.
  prematch_ttl_seconds INTEGER NOT NULL DEFAULT 30
    CHECK (prematch_ttl_seconds BETWEEN 5 AND 600),
  live_ttl_seconds INTEGER NOT NULL DEFAULT 15
    CHECK (live_ttl_seconds BETWEEN 5 AND 600),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by UUID REFERENCES users(id)
);

INSERT INTO zillaflash_config DEFAULT VALUES;
