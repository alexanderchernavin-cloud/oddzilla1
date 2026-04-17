-- The news scraper was cancelled; drop the table that was reserved for it.
-- Idempotent: safe against fresh DBs and any environment that already ran
-- 0000_init.

DROP INDEX IF EXISTS news_games_idx;
DROP INDEX IF EXISTS news_published_idx;
DROP TABLE IF EXISTS news_articles;
