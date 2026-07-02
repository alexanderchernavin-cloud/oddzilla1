-- 0085_settlements_payload_retention
--
-- settlements.payload_json becomes nullable so the nightly retention cron
-- (infra/hetzner/backup/settlements_retention.sh, installed as
-- oddzilla-settlements-retention) can strip audit payloads older than
-- SETTLEMENTS_STRIP_DAYS while keeping the apply-once dedup key
-- (event_urn, market_id, specifiers_hash, type, payload_hash) intact.
--
-- Context (2026-07-02): settlements was 9.8 GB / 12.05M rows and unbounded.
-- payload_json accounted for 4.3 GB of the 6.2 GB heap (avg 371 B/row, all
-- inline, zero TOAST). The payload is write-only in code — InsertIfNew()
-- stores it, nothing ever SELECTs it; its only use is manual debugging with
-- Oddin support, which the 45-day strip window comfortably covers
-- (feed_messages, the raw-XML debug surface, keeps only 7 days).
--
-- The settlement service still always writes a payload on insert; NULL only
-- ever appears via the retention cron. Catalog-only change, no rewrite.

ALTER TABLE settlements ALTER COLUMN payload_json DROP NOT NULL;
