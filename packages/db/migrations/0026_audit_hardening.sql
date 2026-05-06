-- 0023_audit_hardening.sql
--
-- Pre-launch security hardening (audit + withdrawals):
--   1. 4-eyes withdrawal flow — track per-stage actor IDs and require the
--      confirmer to differ from the approver. Stops a single compromised
--      admin token from draining wallets.
--   2. Per-network unique index on (network, tx_hash) so a duplicate hash
--      is rejected at DB layer, complementing the per-route format regex.
--   3. Tamper-evident audit log via SHA-256 hash chain. Each row's hash
--      links to the previous row's hash. Tampering with any historical
--      row breaks the chain at every later row, so post-fact deletion or
--      mutation is detectable. The chain is computed by a BEFORE INSERT
--      trigger that takes a transactional advisory lock to serialise
--      concurrent inserts and walk a deterministic order.

-- 4-eyes per-stage actor on withdrawals.
ALTER TABLE withdrawals
    ADD COLUMN approved_by_user_id  UUID REFERENCES users(id),
    ADD COLUMN submitted_by_user_id UUID REFERENCES users(id),
    ADD COLUMN confirmed_by_user_id UUID REFERENCES users(id);

ALTER TABLE withdrawals
    ADD CONSTRAINT withdrawals_distinct_approver_confirmer
    CHECK (
        confirmed_by_user_id IS NULL
        OR approved_by_user_id IS NULL
        OR confirmed_by_user_id <> approved_by_user_id
    );

-- One withdrawal per on-chain tx hash. Settles a class of admin-error
-- and replay attacks where a confirmed tx hash gets pasted onto a second
-- pending withdrawal. Partial because tx_hash is NULL until submission.
CREATE UNIQUE INDEX withdrawals_tx_hash_unique
    ON withdrawals (network, tx_hash)
    WHERE tx_hash IS NOT NULL;

-- Tamper-evident audit chain.
ALTER TABLE admin_audit_log
    ADD COLUMN prev_hash BYTEA,
    ADD COLUMN row_hash  BYTEA;

CREATE OR REPLACE FUNCTION admin_audit_log_chain()
RETURNS TRIGGER AS $$
DECLARE
    last_hash BYTEA;
    payload   TEXT;
BEGIN
    -- Hold a transaction-scoped advisory lock so concurrent inserts
    -- serialise on the chain. The hashtext value is an arbitrary integer
    -- key shared across all writers.
    PERFORM pg_advisory_xact_lock(hashtext('admin_audit_log_chain'));

    SELECT row_hash INTO last_hash
        FROM admin_audit_log
        ORDER BY id DESC
        LIMIT 1;

    -- Canonical payload — keep this string deterministic across versions.
    -- jsonb::text gives Postgres' canonical JSON form (sorted keys), so
    -- semantically identical values produce identical bytes.
    payload :=
        COALESCE(NEW.actor_user_id::text, '')   || '|' ||
        NEW.action                              || '|' ||
        COALESCE(NEW.target_type, '')           || '|' ||
        COALESCE(NEW.target_id, '')             || '|' ||
        COALESCE(NEW.before_json::text, '')     || '|' ||
        COALESCE(NEW.after_json::text, '')      || '|' ||
        COALESCE(NEW.ip_inet::text, '')         || '|' ||
        NEW.created_at::text;

    NEW.prev_hash := last_hash;
    NEW.row_hash  := digest(COALESCE(last_hash, ''::bytea) || payload::bytea, 'sha256');
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER admin_audit_log_chain_trg
    BEFORE INSERT ON admin_audit_log
    FOR EACH ROW EXECUTE FUNCTION admin_audit_log_chain();

-- Backfill existing rows so they sit on a valid chain. Without this
-- the verifier (admin_audit_chain_check below) would flag every
-- pre-migration row as tampered. We walk in id-order, populating
-- prev_hash from the prior row and row_hash from the canonical payload.
DO $$
DECLARE
    r          admin_audit_log%ROWTYPE;
    last_hash  BYTEA := NULL;
    payload    TEXT;
    new_hash   BYTEA;
BEGIN
    FOR r IN SELECT * FROM admin_audit_log ORDER BY id ASC LOOP
        payload :=
            COALESCE(r.actor_user_id::text, '')   || '|' ||
            r.action                              || '|' ||
            COALESCE(r.target_type, '')           || '|' ||
            COALESCE(r.target_id, '')             || '|' ||
            COALESCE(r.before_json::text, '')     || '|' ||
            COALESCE(r.after_json::text, '')      || '|' ||
            COALESCE(r.ip_inet::text, '')         || '|' ||
            r.created_at::text;
        new_hash := digest(COALESCE(last_hash, ''::bytea) || payload::bytea, 'sha256');
        UPDATE admin_audit_log
            SET prev_hash = last_hash, row_hash = new_hash
            WHERE id = r.id;
        last_hash := new_hash;
    END LOOP;
END;
$$;

-- Verifier — admins / oncall can SELECT * FROM admin_audit_chain_check()
-- to detect any divergence between the stored row_hash and a recomputed
-- one. Any row with ok = false has been tampered with after insert (or
-- the chain has a structural break at that ID).
CREATE OR REPLACE FUNCTION admin_audit_chain_check()
RETURNS TABLE (id BIGINT, ok BOOLEAN) AS $$
DECLARE
    r           admin_audit_log%ROWTYPE;
    last_hash   BYTEA := NULL;
    payload     TEXT;
    expected    BYTEA;
BEGIN
    FOR r IN SELECT * FROM admin_audit_log ORDER BY id ASC LOOP
        payload :=
            COALESCE(r.actor_user_id::text, '')   || '|' ||
            r.action                              || '|' ||
            COALESCE(r.target_type, '')           || '|' ||
            COALESCE(r.target_id, '')             || '|' ||
            COALESCE(r.before_json::text, '')     || '|' ||
            COALESCE(r.after_json::text, '')      || '|' ||
            COALESCE(r.ip_inet::text, '')         || '|' ||
            r.created_at::text;
        expected := digest(COALESCE(last_hash, ''::bytea) || payload::bytea, 'sha256');
        id := r.id;
        ok := (r.prev_hash IS NOT DISTINCT FROM last_hash) AND (r.row_hash = expected);
        RETURN NEXT;
        last_hash := r.row_hash;
    END LOOP;
END;
$$ LANGUAGE plpgsql;
