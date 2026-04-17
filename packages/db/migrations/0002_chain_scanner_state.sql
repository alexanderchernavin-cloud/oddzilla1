-- Block-scanner cursor for wallet-watcher. One row per (chain) so each
-- chain makes independent progress. Separate from amqp_state even though
-- the shape is similar — semantics and lifecycle are different.

CREATE TABLE chain_scanner_state (
    chain              chain_network  PRIMARY KEY,
    last_block_number  BIGINT         NOT NULL DEFAULT 0,
    updated_at         TIMESTAMPTZ    NOT NULL DEFAULT NOW()
);
