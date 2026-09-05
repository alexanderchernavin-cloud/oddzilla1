-- 0104_bettor_labels.sql
--
-- Operator labels on bettors. The risk desk tags accounts the way a
-- trading backoffice does — "vip", "sharp", "fraud" — and filters the
-- bettor list by tag. Until now the only place to record that was the
-- free-text users.notes column, which is neither filterable nor
-- consistent across operators.
--
-- Stored as a TEXT[] on users rather than a join table: the vocabulary
-- is a closed operator set (eight values, enforced by the CHECK below),
-- a bettor carries at most a handful, and every reader already has the
-- users row in hand. Adding a value later is a one-line CHECK change
-- plus the matching constant in packages/types/src/bettor-labels.ts.
--
-- Labels are descriptive only — nothing in the placement path reads
-- them. Limits and exposure still hang off users.risk_score,
-- users.global_limit_micro and users.bet_delay_seconds; the profile
-- page edits those next to the labels so the operator sees both.
--
-- GIN index for the `?label=` filter on GET /admin/users. The table is
-- small today, but the filter is a containment query (`labels @> ARRAY[x]`)
-- that a btree cannot serve.

ALTER TABLE users
    ADD COLUMN labels TEXT[] NOT NULL DEFAULT '{}';

ALTER TABLE users
    ADD CONSTRAINT users_labels_allowed
    CHECK (
        labels <@ ARRAY[
            'vip', 'sharp', 'regular', 'fraud',
            'shady', 'suspicious', 'prematch', 'live'
        ]::text[]
        AND COALESCE(array_length(labels, 1), 0) <= 8
    );

CREATE INDEX users_labels_gin_idx
    ON users USING GIN (labels)
    WHERE role = 'user';
