-- Oddzilla initial schema. Source of truth for both TS (via Drizzle) and Go (via sqlc).
-- Money is BIGINT micro_usdt (1 USDT = 1,000,000 micro). Never NUMERIC for money.

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS citext;

-- ─────────────────────────────────────────────────────────────────────────────
-- Enums
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TYPE user_status        AS ENUM ('active', 'blocked', 'pending_kyc');
CREATE TYPE user_role          AS ENUM ('user', 'admin', 'support');
CREATE TYPE kyc_status         AS ENUM ('none', 'pending', 'approved', 'rejected');
CREATE TYPE wallet_tx_type     AS ENUM ('deposit', 'withdrawal', 'bet_stake', 'bet_payout', 'bet_refund', 'adjustment');
CREATE TYPE chain_network      AS ENUM ('TRC20', 'ERC20');
CREATE TYPE deposit_status     AS ENUM ('seen', 'confirming', 'credited', 'orphaned');
CREATE TYPE withdrawal_status  AS ENUM ('requested', 'approved', 'submitted', 'confirmed', 'failed', 'cancelled');
CREATE TYPE sport_kind         AS ENUM ('esport', 'traditional');
CREATE TYPE match_status       AS ENUM ('not_started', 'live', 'closed', 'cancelled', 'suspended');
CREATE TYPE outcome_result     AS ENUM ('won', 'lost', 'void', 'half_won', 'half_lost');
CREATE TYPE ticket_status      AS ENUM ('pending_delay', 'accepted', 'rejected', 'settled', 'voided', 'cashed_out');
CREATE TYPE bet_type           AS ENUM ('single', 'combo', 'system');
CREATE TYPE settlement_type    AS ENUM ('settle', 'cancel', 'rollback_settle', 'rollback_cancel');
CREATE TYPE odds_scope         AS ENUM ('global', 'sport', 'tournament', 'market_type');
CREATE TYPE mapping_status     AS ENUM ('pending', 'approved', 'rejected');

-- ─────────────────────────────────────────────────────────────────────────────
-- Users & sessions
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE users (
    id                  UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
    email               CITEXT       NOT NULL UNIQUE,
    password_hash       TEXT         NOT NULL,
    status              user_status  NOT NULL DEFAULT 'active',
    role                user_role    NOT NULL DEFAULT 'user',
    kyc_status          kyc_status   NOT NULL DEFAULT 'none',
    country_code        CHAR(2),
    global_limit_micro  BIGINT       NOT NULL DEFAULT 0 CHECK (global_limit_micro >= 0),
    bet_delay_seconds   SMALLINT     NOT NULL DEFAULT 0 CHECK (bet_delay_seconds >= 0 AND bet_delay_seconds <= 300),
    display_name        TEXT,
    created_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    last_login_at       TIMESTAMPTZ
);
CREATE INDEX users_status_idx ON users(status);
CREATE INDEX users_role_idx   ON users(role) WHERE role <> 'user';

CREATE TABLE sessions (
    id                  UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id             UUID         NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    refresh_token_hash  BYTEA        NOT NULL,
    device_id           TEXT,
    user_agent          TEXT,
    ip_inet             INET,
    created_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    last_used_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    expires_at          TIMESTAMPTZ  NOT NULL,
    revoked_at          TIMESTAMPTZ
);
CREATE UNIQUE INDEX sessions_refresh_idx ON sessions(refresh_token_hash);
CREATE INDEX sessions_user_active_idx ON sessions(user_id) WHERE revoked_at IS NULL;

-- ─────────────────────────────────────────────────────────────────────────────
-- Wallet: balances + append-only ledger + deposits/withdrawals
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE wallets (
    user_id        UUID         PRIMARY KEY REFERENCES users(id) ON DELETE RESTRICT,
    currency       CHAR(4)      NOT NULL DEFAULT 'USDT',
    balance_micro  BIGINT       NOT NULL DEFAULT 0 CHECK (balance_micro >= 0),
    locked_micro   BIGINT       NOT NULL DEFAULT 0 CHECK (locked_micro  >= 0),
    updated_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    CHECK (balance_micro >= locked_micro)
);

CREATE TABLE wallet_ledger (
    id           BIGSERIAL       PRIMARY KEY,
    user_id      UUID            NOT NULL REFERENCES users(id),
    delta_micro  BIGINT          NOT NULL,
    type         wallet_tx_type  NOT NULL,
    ref_type     TEXT,
    ref_id       TEXT,
    tx_hash      TEXT,
    memo         TEXT,
    created_at   TIMESTAMPTZ     NOT NULL DEFAULT NOW()
);
CREATE INDEX wallet_ledger_user_idx ON wallet_ledger(user_id, created_at DESC);
CREATE INDEX wallet_ledger_ref_idx  ON wallet_ledger(ref_type, ref_id);
-- Apply-once: same (type, ref_type, ref_id) can only credit/debit once.
CREATE UNIQUE INDEX wallet_ledger_unique_ref
    ON wallet_ledger(type, ref_type, ref_id)
    WHERE ref_id IS NOT NULL;

CREATE TABLE deposit_addresses (
    id               UUID           PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id          UUID           NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    network          chain_network  NOT NULL,
    address          TEXT           NOT NULL,
    derivation_path  TEXT,
    created_at       TIMESTAMPTZ    NOT NULL DEFAULT NOW(),
    UNIQUE (network, address),
    UNIQUE (user_id, network)
);

CREATE TABLE deposits (
    id             UUID            PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id        UUID            NOT NULL REFERENCES users(id),
    network        chain_network   NOT NULL,
    tx_hash        TEXT            NOT NULL,
    log_index      INTEGER         NOT NULL DEFAULT 0,
    to_address     TEXT            NOT NULL,
    amount_micro   BIGINT          NOT NULL CHECK (amount_micro > 0),
    confirmations  INTEGER         NOT NULL DEFAULT 0,
    status         deposit_status  NOT NULL DEFAULT 'seen',
    block_number   BIGINT,
    seen_at        TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
    credited_at    TIMESTAMPTZ,
    UNIQUE (network, tx_hash, log_index)
);
CREATE INDEX deposits_user_idx   ON deposits(user_id, seen_at DESC);
CREATE INDEX deposits_status_idx ON deposits(status) WHERE status <> 'credited';

CREATE TABLE withdrawals (
    id              UUID               PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         UUID               NOT NULL REFERENCES users(id),
    network         chain_network      NOT NULL,
    to_address      TEXT               NOT NULL,
    amount_micro    BIGINT             NOT NULL CHECK (amount_micro > 0),
    fee_micro       BIGINT             NOT NULL DEFAULT 0 CHECK (fee_micro >= 0),
    status          withdrawal_status  NOT NULL DEFAULT 'requested',
    tx_hash         TEXT,
    requested_at    TIMESTAMPTZ        NOT NULL DEFAULT NOW(),
    approved_at     TIMESTAMPTZ,
    submitted_at    TIMESTAMPTZ,
    confirmed_at    TIMESTAMPTZ,
    failure_reason  TEXT
);
CREATE INDEX withdrawals_user_idx    ON withdrawals(user_id, requested_at DESC);
CREATE INDEX withdrawals_status_idx  ON withdrawals(status)
    WHERE status IN ('requested', 'approved', 'submitted');

-- ─────────────────────────────────────────────────────────────────────────────
-- Catalog: Sport > Category > Tournament > Match
-- Oddin esports go Sport→Tournament directly; we auto-create a dummy Category
-- per sport so the four-level hierarchy is always complete.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE sports (
    id            SERIAL       PRIMARY KEY,
    provider      TEXT         NOT NULL DEFAULT 'oddin',
    provider_urn  TEXT         NOT NULL,
    slug          TEXT         NOT NULL UNIQUE,
    name          TEXT         NOT NULL,
    kind          sport_kind   NOT NULL DEFAULT 'esport',
    active        BOOLEAN      NOT NULL DEFAULT TRUE,
    created_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    UNIQUE (provider, provider_urn)
);

CREATE TABLE categories (
    id            SERIAL   PRIMARY KEY,
    sport_id      INTEGER  NOT NULL REFERENCES sports(id) ON DELETE CASCADE,
    provider_urn  TEXT,
    slug          TEXT     NOT NULL,
    name          TEXT     NOT NULL,
    is_dummy      BOOLEAN  NOT NULL DEFAULT FALSE,
    active        BOOLEAN  NOT NULL DEFAULT TRUE,
    UNIQUE (sport_id, slug),
    UNIQUE (sport_id, provider_urn)
);
CREATE INDEX categories_sport_idx ON categories(sport_id);

CREATE TABLE tournaments (
    id            SERIAL       PRIMARY KEY,
    category_id   INTEGER      NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
    provider_urn  TEXT         NOT NULL UNIQUE,
    slug          TEXT         NOT NULL,
    name          TEXT         NOT NULL,
    start_at      TIMESTAMPTZ,
    end_at        TIMESTAMPTZ,
    active        BOOLEAN      NOT NULL DEFAULT TRUE,
    created_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);
CREATE INDEX tournaments_category_idx ON tournaments(category_id);
CREATE INDEX tournaments_active_idx   ON tournaments(active, start_at);

CREATE TABLE matches (
    id                 BIGSERIAL     PRIMARY KEY,
    tournament_id      INTEGER       NOT NULL REFERENCES tournaments(id),
    provider_urn       TEXT          NOT NULL UNIQUE,
    home_team          TEXT          NOT NULL,
    away_team          TEXT          NOT NULL,
    home_team_urn      TEXT,
    away_team_urn      TEXT,
    scheduled_at       TIMESTAMPTZ,
    status             match_status  NOT NULL DEFAULT 'not_started',
    oddin_status_code  SMALLINT,
    best_of            SMALLINT,
    live_score         JSONB,
    created_at         TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    updated_at         TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);
CREATE INDEX matches_tournament_idx     ON matches(tournament_id);
CREATE INDEX matches_status_sched_idx   ON matches(status, scheduled_at);
CREATE INDEX matches_live_idx           ON matches(status) WHERE status = 'live';

-- ─────────────────────────────────────────────────────────────────────────────
-- Markets & odds
-- `specifiers_hash` is sha256 of canonical k=v|k=v, sorted.
-- Both feed-ingester and settlement worker use the same canonicalization.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE markets (
    id                  BIGSERIAL    PRIMARY KEY,
    match_id            BIGINT       NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
    provider_market_id  INTEGER      NOT NULL,
    specifiers_json     JSONB        NOT NULL DEFAULT '{}'::jsonb,
    specifiers_hash     BYTEA        NOT NULL,
    status              SMALLINT     NOT NULL DEFAULT 0,
    last_oddin_ts       BIGINT       NOT NULL DEFAULT 0,
    created_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    UNIQUE (match_id, provider_market_id, specifiers_hash)
);
CREATE INDEX markets_match_status_idx ON markets(match_id, status);

CREATE TABLE market_outcomes (
    market_id       BIGINT          NOT NULL REFERENCES markets(id) ON DELETE CASCADE,
    outcome_id      TEXT            NOT NULL,
    name            TEXT            NOT NULL,
    raw_odds        NUMERIC(10, 4),
    published_odds  NUMERIC(10, 4),
    active          BOOLEAN         NOT NULL DEFAULT TRUE,
    result          outcome_result,
    void_factor     NUMERIC(4, 3),
    last_oddin_ts   BIGINT          NOT NULL DEFAULT 0,
    updated_at      TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
    PRIMARY KEY (market_id, outcome_id)
);

-- Append-only. Partitioned daily in 0001.
CREATE TABLE odds_history (
    id              BIGSERIAL,
    market_id       BIGINT          NOT NULL,
    outcome_id      TEXT            NOT NULL,
    raw_odds        NUMERIC(10, 4),
    published_odds  NUMERIC(10, 4),
    ts              TIMESTAMPTZ     NOT NULL,
    PRIMARY KEY (id, ts)
) PARTITION BY RANGE (ts);

CREATE INDEX odds_history_market_ts_idx ON odds_history (market_id, ts DESC);

CREATE TABLE odds_config (
    id                 SERIAL        PRIMARY KEY,
    scope              odds_scope    NOT NULL,
    scope_ref_id       TEXT,
    payback_margin_bp  INTEGER       NOT NULL CHECK (payback_margin_bp BETWEEN 0 AND 5000),
    updated_by         UUID          REFERENCES users(id),
    updated_at         TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    UNIQUE (scope, scope_ref_id)
);

-- ─────────────────────────────────────────────────────────────────────────────
-- Tickets & selections
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE tickets (
    id                      UUID           PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id                 UUID           NOT NULL REFERENCES users(id),
    status                  ticket_status  NOT NULL DEFAULT 'pending_delay',
    bet_type                bet_type       NOT NULL DEFAULT 'single',
    stake_micro             BIGINT         NOT NULL CHECK (stake_micro > 0),
    potential_payout_micro  BIGINT         NOT NULL CHECK (potential_payout_micro >= 0),
    actual_payout_micro     BIGINT,
    idempotency_key         TEXT           NOT NULL UNIQUE,
    not_before_ts           TIMESTAMPTZ,
    reject_reason           TEXT,
    placed_at               TIMESTAMPTZ    NOT NULL DEFAULT NOW(),
    accepted_at             TIMESTAMPTZ,
    settled_at              TIMESTAMPTZ,
    client_ip               INET,
    user_agent              TEXT
);
CREATE INDEX tickets_user_status_idx      ON tickets(user_id, status, placed_at DESC);
CREATE INDEX tickets_pending_delay_idx    ON tickets(not_before_ts) WHERE status = 'pending_delay';
CREATE INDEX tickets_open_idx             ON tickets(status) WHERE status IN ('accepted', 'pending_delay');

CREATE TABLE ticket_selections (
    id                 BIGSERIAL       PRIMARY KEY,
    ticket_id          UUID            NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
    market_id          BIGINT          NOT NULL REFERENCES markets(id),
    outcome_id         TEXT            NOT NULL,
    odds_at_placement  NUMERIC(10, 4)  NOT NULL,
    result             outcome_result,
    void_factor        NUMERIC(4, 3),
    settled_at         TIMESTAMPTZ,
    UNIQUE (ticket_id, market_id, outcome_id)
);
CREATE INDEX ticket_selections_market_idx ON ticket_selections(market_id) WHERE result IS NULL;

-- ─────────────────────────────────────────────────────────────────────────────
-- Settlement idempotency
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE settlements (
    id              BIGSERIAL         PRIMARY KEY,
    event_urn       TEXT              NOT NULL,
    market_id       BIGINT            NOT NULL REFERENCES markets(id),
    specifiers_hash BYTEA             NOT NULL,
    type            settlement_type   NOT NULL,
    payload_hash    BYTEA             NOT NULL,
    payload_json    JSONB             NOT NULL,
    processed_at    TIMESTAMPTZ       NOT NULL DEFAULT NOW(),
    UNIQUE (event_urn, market_id, specifiers_hash, type, payload_hash)
);
CREATE INDEX settlements_event_idx ON settlements(event_urn, processed_at DESC);

-- ─────────────────────────────────────────────────────────────────────────────
-- Admin + misc
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE mapping_review_queue (
    id                 BIGSERIAL        PRIMARY KEY,
    entity_type        TEXT             NOT NULL,
    provider           TEXT             NOT NULL DEFAULT 'oddin',
    provider_urn       TEXT             NOT NULL,
    raw_payload        JSONB            NOT NULL,
    created_entity_id  TEXT,
    status             mapping_status   NOT NULL DEFAULT 'pending',
    reviewed_by        UUID             REFERENCES users(id),
    reviewed_at        TIMESTAMPTZ,
    created_at         TIMESTAMPTZ      NOT NULL DEFAULT NOW(),
    UNIQUE (provider, provider_urn, entity_type)
);
CREATE INDEX mapping_review_pending_idx ON mapping_review_queue(status, created_at)
    WHERE status = 'pending';

CREATE TABLE admin_audit_log (
    id             BIGSERIAL    PRIMARY KEY,
    actor_user_id  UUID         REFERENCES users(id),
    action         TEXT         NOT NULL,
    target_type    TEXT,
    target_id      TEXT,
    before_json    JSONB,
    after_json     JSONB,
    ip_inet        INET,
    created_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);
CREATE INDEX admin_audit_actor_idx  ON admin_audit_log(actor_user_id, created_at DESC);
CREATE INDEX admin_audit_target_idx ON admin_audit_log(target_type, target_id);

CREATE TABLE news_articles (
    id            BIGSERIAL    PRIMARY KEY,
    source        TEXT         NOT NULL,
    url           TEXT         NOT NULL UNIQUE,
    title         TEXT         NOT NULL,
    summary       TEXT,
    image_url     TEXT,
    games         TEXT[]       NOT NULL DEFAULT '{}',
    published_at  TIMESTAMPTZ,
    fetched_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);
CREATE INDEX news_games_idx     ON news_articles USING GIN (games);
CREATE INDEX news_published_idx ON news_articles(published_at DESC NULLS LAST);

-- Oddin AMQP recovery watermark per producer (1=pre-match, 2=live).
CREATE TABLE amqp_state (
    key         TEXT         PRIMARY KEY,
    after_ts    BIGINT       NOT NULL DEFAULT 0,
    updated_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);
