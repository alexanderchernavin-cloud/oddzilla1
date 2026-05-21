-- 0072_user_hidden_sports.sql
--
-- Per-bettor hidden-sports preference. Companion to 0056_user_sport_order:
-- where sport_order REORDERS the sidebar, hidden_sports REMOVES sports
-- the bettor doesn't want to see anywhere on the storefront.
--
-- NULL  → user has never hidden anything; render the full set.
-- {}    → degenerate but legal; same effect as NULL.
-- {…}   → slugs the bettor has hidden. Filtered out of the sidebar's
--         sport list, match-list pages (lobby / /live / /upcoming),
--         live-counts the sidebar shows, ZillaFlash offers, and the
--         lobby's CombiBoost ("Combozilla") three-fold suggestions.
--         The sidebar's edit mode still renders them at the bottom of
--         the list so the bettor can unhide them.
--
-- Same 100-element defensive cap as sport_order. There are ~40 active
-- sports today; nothing legitimate pushes past that, and the limit
-- stops a buggy client (or hostile request) from inflating the row.
--
-- Slug format is validated at the API layer (zod). We deliberately
-- don't enforce slug shape in SQL so sports can be renamed without
-- invalidating saved preferences row-side.

BEGIN;

ALTER TABLE users
    ADD COLUMN hidden_sports TEXT[];

ALTER TABLE users
    ADD CONSTRAINT users_hidden_sports_len
    CHECK (hidden_sports IS NULL OR array_length(hidden_sports, 1) <= 100);

COMMIT;
