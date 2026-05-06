-- 0025_session_family.sql
--
-- Refresh-token rotation gets two new columns per session:
--   • family_id        — UUID shared across every session that descends
--                        from the same login. Lets us revoke the whole
--                        chain when we detect refresh-token replay.
--   • parent_session_id — the session that minted this one. Lets us
--                        walk a chain forward / backward for forensics.
--
-- The replay-detection algorithm: if a refresh token is presented and
-- the matching session row is ALREADY revoked, the token has been used
-- twice — that's the canonical theft signal. We then revoke every
-- session in the family in one statement.

ALTER TABLE sessions
    ADD COLUMN family_id UUID,
    ADD COLUMN parent_session_id UUID REFERENCES sessions(id) ON DELETE SET NULL;

-- Backfill: every existing session is its own family root.
UPDATE sessions SET family_id = id WHERE family_id IS NULL;

ALTER TABLE sessions
    ALTER COLUMN family_id SET NOT NULL;

CREATE INDEX sessions_family_idx ON sessions (family_id) WHERE revoked_at IS NULL;
