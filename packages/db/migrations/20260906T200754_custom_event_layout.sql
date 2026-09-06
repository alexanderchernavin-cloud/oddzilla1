-- How a custom event presents itself, and when it stops taking bets.
--
-- Custom events have to cover two shapes at once, which is what this
-- table is for.
--
-- **Layout.** Every list card in this product is a MATCH-UP: two sides
-- stacked, a score between them, an odds button on each row. That is
-- right for a fixture and wrong for the thing operators actually reach
-- for custom events to do — a question with answers. "Dima and Nastya to
-- unite again" has no home and away side, so the card rendered "Will
-- unite again" versus "Will not unite again" as if they were teams, and
-- the real market sat one click away behind them. `layout = 'markets'`
-- drops the match-up and renders the event's markets on the card itself.
--
-- **Closing date.** A fixture is defined by its kickoff; an outright is
-- defined by the date it stops taking bets, which can be months later.
-- `ends_at` is that instant. Two things read it, and the first is easy to
-- miss: `hasActiveMarket` drops any `not_started` match whose kickoff is
-- more than six hours old, because for a FEED match that is broken data
-- — so without a carve-out an outright would vanish from the storefront
-- the same afternoon it opened. The second is the sweeper, which
-- suspends the markets once the window closes. Suspend, not settle: the
-- book shuts while the result is still unknown, and the operator settles
-- when it is. NULL means no automatic close.
--
-- Stored per event rather than per tournament because both are
-- properties of the QUESTION, not of where it is filed: an operator will
-- want a head-to-head and a season-long outright under one tournament.
--
-- A side table for the same reason `custom_market_config` is one: this is
-- touched by the backoffice and by one catalog read, and `matches` is a
-- large table written continuously by both feed ingesters that does not
-- need columns NULL on every row either of them has ever written.
--
-- TEXT with a CHECK rather than an enum: a third presentation is a
-- plausible thing to want, and a Postgres enum cannot gain a value in the
-- same transaction that references it — the two-file dance migrations
-- 0087 and 0101 had to do.

SET LOCAL lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS custom_event_config (
  match_id   BIGINT PRIMARY KEY REFERENCES matches(id) ON DELETE CASCADE,
  layout     TEXT NOT NULL DEFAULT 'matchup',
  -- When betting closes. NULL = stays open until an operator says
  -- otherwise, which is how a plain fixture behaves.
  ends_at    TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT custom_event_layout_valid CHECK (layout IN ('matchup', 'markets'))
);

-- The catalog read asks "which of these match ids present as markets".
-- Partial, so the index carries only the rows that answer yes and a
-- storefront page holding no such event pays nothing.
CREATE INDEX IF NOT EXISTS custom_event_config_markets_idx
  ON custom_event_config (match_id)
  WHERE layout = 'markets';

-- The sweeper's question: which events have run past their closing date
-- and still need their markets shut.
CREATE INDEX IF NOT EXISTS custom_event_config_ends_idx
  ON custom_event_config (ends_at)
  WHERE ends_at IS NOT NULL;
