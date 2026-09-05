-- 0107_zagi_tier_safety_and_outright
--
-- Applies two operator decisions to the tiers ZillaAGI has already
-- assigned. Both only ever TIGHTEN — they raise the tier number, which
-- lowers the liability the book will carry.
--
--   +1 always. A ZAGI verdict is not reviewed by a person before it takes
--   effect, so it is not taken at face value: if the model believes a
--   competition is tier 2, we underwrite it at tier 3. One consequence is
--   worth stating plainly — ZAGI can no longer produce a T1 at all. The
--   loosest tier in the book, 50 000 USDC on a single match, is now
--   reachable only by an operator typing it.
--
--   +3 more for OUTRIGHT markets. An outright resolves over a whole
--   season or phase rather than one fixture: the book holds the position
--   for months, cannot trade out of it match by match, and prices it off
--   standings that move underneath it. Same competition, materially worse
--   risk. On the live line these were sitting at the SAME tier as the
--   match markets — "England. Premier League. Season 26/27" at T1.
--
-- The outright predicate mirrors OUTRIGHT_PATTERNS in
-- services/api/src/lib/zagi/risk-tier.ts and was measured against the
-- live catalogue before being written, not guessed. Two near-misses are
-- deliberately excluded:
--
--   * bare "head-to-head" — in this feed that phrase is dominated by
--     SINGLE-event markets ("Vuelta a Espana. Stage 13. Head-to-head",
--     "Formula-1. Grand Prix. Italy. Race. Head-to-head"). 12 of the 31
--     head-to-head rows are that shape and must not be stepped.
--   * "champion" — it matches "Scotland. Championship" and "Gaelic
--     football. Galway Championship", which are the names of ordinary
--     leagues, not outright markets.
--
-- Scope is `risk_tier_source = 'zagi'` only. An operator's tier is a
-- human decision and is left exactly as it is; a feed-assigned tier is
-- Oddin's own assessment and likewise untouched.
--
-- The note marker is load-bearing, not decoration: it is how this
-- statement tells a row that already carries the margin from one written
-- before the margin existed, so a row can never be stepped twice.

SET LOCAL lock_timeout = '5s';

WITH adjusted AS (
  SELECT t.id,
         (t.name || ' ' || COALESCE(c.name, '')) ~* (
           'season[[:space:]]+[0-9]{2}[[:space:]]*/[[:space:]]*[0-9]{2}'
           || '|in[[:space:]]+(the[[:space:]]+)?tournament'
           || '|outrights?'
           || '|(league|group)[[:space:]]+phase.*head-to-head'
         ) AS is_outright
    FROM tournaments t
    LEFT JOIN categories c ON c.id = t.category_id
   WHERE t.risk_tier_source = 'zagi'
     AND t.risk_tier IS NOT NULL
     AND (
       t.risk_tier_note IS NULL
       OR position('+1 ZAGI safety margin' IN t.risk_tier_note) = 0
     )
)
UPDATE tournaments t
   SET risk_tier = LEAST(
         10,
         t.risk_tier + 1 + CASE WHEN adjusted.is_outright THEN 3 ELSE 0 END
       ),
       risk_tier_note = left(
         COALESCE(t.risk_tier_note, '')
           || ' [+1 ZAGI safety margin'
           || CASE WHEN adjusted.is_outright THEN ', +3 outright' ELSE '' END
           || ' (migration 0107) -> T'
           || LEAST(10, t.risk_tier + 1 + CASE WHEN adjusted.is_outright THEN 3 ELSE 0 END)::text
           || ']',
         500
       )
  FROM adjusted
 WHERE adjusted.id = t.id;

COMMENT ON COLUMN tournaments.risk_tier_note IS
  'ZillaAGI''s justification plus what was done to its number (safety margin, outright step, sport ceiling). Model output — render as text, never as markup.';
