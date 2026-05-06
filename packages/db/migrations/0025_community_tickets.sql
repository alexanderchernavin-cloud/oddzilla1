-- 0025_community_tickets.sql
--
-- Read-projection of settled tickets for the Community feed (Phase 10.2).
--
-- Why a projection rather than reading `tickets` directly:
--
--   * Feed queries need to filter by sport (one click on a sport pill in
--     the UI). `tickets` doesn't carry sport_id at all — the path is
--     `tickets → ticket_selections → markets → matches → tournaments →
--     categories → sports`. Joining all of that on every feed scroll
--     would dominate the read. Denormalising sport_ids into the
--     projection turns a 6-way join into an index lookup.
--   * Feed queries also filter by currency. `tickets.currency` is
--     already there; mirroring it on the projection lets the feed query
--     hit a single composite index without joining `tickets`.
--   * The community surface only ever wants tickets that publicly
--     resolved (`settled`, `cashed_out`). Most rows in `tickets` are
--     neither — `accepted` (open) and `pending_delay` outnumber settled
--     by a wide margin in steady state. A separate table avoids
--     scanning every accepted ticket on every feed request.
--   * Phase 10.3 adds a precomputed `score` column for the Best Wins
--     sort. Storing the score on `tickets` itself would couple the bet
--     pipeline to the community ranking model.
--
-- Authoritative writer: services/settlement (Go). Inside the
-- `SettleTicket` / `ReverseSettledTicket` transaction the same tx that
-- flips `tickets.status='settled'` upserts this row, so the projection
-- is consistent with the source of truth without an eventual-write
-- worker. Cashout (services/api, TS) writes the projection inline in
-- the same Drizzle tx that flips `tickets.status='cashed_out'`. The
-- admin backfill endpoint (`POST /admin/community/backfill`) recovers
-- any miss; it shares the same upsert.
--
-- Apply-once: `UNIQUE (ticket_id)` with `ON CONFLICT DO UPDATE` makes
-- the projection write idempotent under settlement replay; a re-settle
-- after rollback updates the same row in place across generations.

CREATE TABLE community_tickets (
    id              BIGSERIAL    PRIMARY KEY,
    ticket_id       UUID         NOT NULL UNIQUE
                    REFERENCES tickets(id) ON DELETE CASCADE,
    user_id         UUID         NOT NULL
                    REFERENCES users(id) ON DELETE CASCADE,
    currency        CHAR(4)      NOT NULL,
    status          ticket_status NOT NULL,
    bet_type        bet_type      NOT NULL,
    stake_micro     BIGINT       NOT NULL,
    payout_micro    BIGINT       NOT NULL DEFAULT 0,
    total_odds      NUMERIC(10, 4) NOT NULL,
    num_legs        INTEGER      NOT NULL,
    sport_ids       INTEGER[]    NOT NULL DEFAULT '{}',
    settled_at      TIMESTAMPTZ  NOT NULL,
    -- Phase 10.3 fills this in. Default 0 keeps the column NOT NULL
    -- without a backfill on the 10.2 deploy.
    score           DOUBLE PRECISION NOT NULL DEFAULT 0,
    created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),

    CONSTRAINT community_tickets_stake_pos     CHECK (stake_micro > 0),
    CONSTRAINT community_tickets_payout_nonneg CHECK (payout_micro >= 0),
    CONSTRAINT community_tickets_num_legs_pos  CHECK (num_legs > 0)
);

-- Recent-feed scan. Composite ordering supports the default sort and
-- both the (sport, recent) and (currency, recent) filters via the
-- partial indexes below.
CREATE INDEX community_tickets_settled_idx
    ON community_tickets (settled_at DESC);

-- Phase 10.3 Best Wins sort. Score-then-recency tiebreak.
CREATE INDEX community_tickets_score_settled_idx
    ON community_tickets (score DESC, settled_at DESC);

-- Per-user tickets endpoint and per-currency profile stats aggregation.
CREATE INDEX community_tickets_user_settled_idx
    ON community_tickets (user_id, settled_at DESC);

-- Currency filter on the feed.
CREATE INDEX community_tickets_currency_settled_idx
    ON community_tickets (currency, settled_at DESC);

-- Sport filter on the feed. GIN over the array column lets
-- `sport_ids @> ARRAY[$1]` use the index.
CREATE INDEX community_tickets_sport_idx
    ON community_tickets USING GIN (sport_ids);
