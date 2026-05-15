-- 0056_user_sport_order.sql
--
-- Per-bettor sidebar sport ordering. First entry in a planned set of
-- storefront chrome customisations.
--
-- NULL  → user has never customised; render the default order
--         (TOP_SPORT_SLUGS pinned + alphabetical fallback in
--         apps/web/src/lib/sport-order.ts).
-- [...] → user-saved slug order. Sports not present in the array (e.g.
--         a sport added by an admin after the user last reordered) are
--         appended in default order on the client so they remain
--         discoverable.
--
-- Defensive cap of 100 elements: there are ~40 active sports today;
-- nothing legitimate should ever push past that, and the limit stops a
-- buggy client (or hostile request) from inflating the row.
--
-- Slug format is validated at the API layer (zod) — matches what
-- /catalog/sports surfaces. We deliberately don't enforce slug shape
-- in SQL so that sports can be renamed without invalidating saved
-- preferences row-side.

BEGIN;

ALTER TABLE users
    ADD COLUMN sport_order TEXT[];

ALTER TABLE users
    ADD CONSTRAINT users_sport_order_len
    CHECK (sport_order IS NULL OR array_length(sport_order, 1) <= 100);

COMMIT;
