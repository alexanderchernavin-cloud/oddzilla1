-- 0023_settlements_market_id_idx.sql
--
-- The `settlements` table has a UNIQUE index on
-- (event_urn, market_id, specifiers_hash, type, payload_hash) but no
-- standalone index on market_id. Foreign-key reverse lookups by
-- market_id alone — most prominently the admin recovery flush's
-- `NOT EXISTS (SELECT 1 FROM settlements s WHERE s.market_id = m.id)` —
-- couldn't use that compound index (market_id isn't its leading
-- column), so postgres seq-scanned all 4M+ settlement rows for every
-- market it considered deleting. With ~700k active markets the planner
-- estimated trillions of comparisons and the query never finished
-- inside the request budget; it also held a row-level lock on markets
-- that blocked feed-ingester INSERTs and settlement INSERTs in the
-- meantime.
--
-- A plain btree index on settlements.market_id costs ~80MB of disk and
-- a small per-insert maintenance hit, both negligible. Lookups by
-- market_id drop from O(N) to O(log N).

CREATE INDEX IF NOT EXISTS settlements_market_id_idx
    ON settlements (market_id);
