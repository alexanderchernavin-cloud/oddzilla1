-- 0022_match_tv_channels.sql
--
-- Stream embeds for the storefront match-detail page. Oddin's
-- /v1/sports/{lang}/sport_events/{matchURN}/fixture endpoint returns a
-- <tv_channels> block with one or more <tv_channel name=".." language=".."
-- stream_url=".."/> entries. The stream_url is most often a Twitch or
-- YouTube channel/video URL. We persist the whole list verbatim so the
-- API can hand it to the frontend, which knows how to recognise the
-- platform and render an embed.
--
-- JSONB shape (array, may be empty):
--   [
--     {"name":"Twitch EN","language":"en","streamUrl":"https://www.twitch.tv/esl_csgo"},
--     {"name":"YouTube RU","language":"ru","streamUrl":"https://www.youtube.com/watch?v=abc123"}
--   ]
--
-- The column is nullable. NULL means the resolver hasn't seen a fixture
-- response for this match yet (or Oddin returned an empty/missing
-- tv_channels block). An empty array means we explicitly know there are
-- no broadcasters listed, which is functionally identical to NULL for
-- the storefront and saves the frontend an extra branch.
--
-- No index is needed: lookups are always by matches.id (PK).

ALTER TABLE matches
    ADD COLUMN tv_channels JSONB;
