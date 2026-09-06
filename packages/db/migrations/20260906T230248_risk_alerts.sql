-- 20260906T230248_risk_alerts.sql
--
-- (Authored as 0105_risk_alerts.sql; renamed before merge for the reason
-- given in 20260906T230247_bettor_labels.sql. The timestamp is one
-- second later so the two still apply in their authored order.)
--
-- Alert center for the risk desk. Until now the backoffice had alerts
-- only as scattered signals: deposit wrong-token / unattributed rows
-- carry their own acknowledged_at, the behaviour sweeper flips a
-- boolean on bettor_behaviour_scores, and everything else (a whale
-- stake, a bettor beating the book for a month, five accounts on one
-- IP, a withdrawal nobody looked at) had to be noticed by eye on the
-- betticker. This migration adds one queue every signal lands in, with
-- the lifecycle of a support ticket: open -> acknowledged -> resolved,
-- an assignee, and a comment trail.
--
-- The rules are evaluated by services/api (lib/riskzilla/alert-sweeper)
-- once a minute, off the placement hot path. They are B2C sportsbook
-- rules — about bettors, tickets, deposits and the operator's own
-- bankroll — not the B2B client / ROI alerts of a trading backoffice.
--
--   risk_alert_rules   one row per rule kind: enabled, severity, params
--                      (thresholds, windows) as jsonb. Seeded below with
--                      defaults the desk can tune at /admin/alerts.
--   risk_alerts        the queue. dedupe_key keeps a recurring condition
--                      as ONE row while it is unresolved (the sweeper
--                      bumps occurrences / last_seen_at instead of
--                      inserting twice); the partial unique index is the
--                      ON CONFLICT target. A resolved key never re-fires
--                      — recurring rules bucket their key by time so a
--                      condition that persists across days re-alerts at
--                      most once per bucket.
--   risk_alert_events  append-only trail per alert: created, acknowledged,
--                      assigned, comment, resolved, reopened.
--
-- Alerts are advisory. Nothing in the placement path reads this table.

-- risk_alerts carries FKs to users, tickets and matches, and validating a
-- new FK takes SHARE ROW EXCLUSIVE on the REFERENCED table. `matches` is
-- written continuously by both ingesters, so without this the deploy can
-- park the whole catalog behind itself. Same reason 0100 and 0106 carry it.
SET LOCAL lock_timeout = '5s';

CREATE TYPE risk_alert_severity AS ENUM ('critical', 'serious', 'warning');
CREATE TYPE risk_alert_status   AS ENUM ('open', 'acknowledged', 'resolved');

CREATE TABLE risk_alert_rules (
    kind        TEXT PRIMARY KEY,
    enabled     BOOLEAN NOT NULL DEFAULT TRUE,
    severity    risk_alert_severity NOT NULL,
    params      JSONB NOT NULL DEFAULT '{}'::jsonb,
    updated_by  UUID REFERENCES users(id) ON DELETE SET NULL,
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT risk_alert_rules_kind_format CHECK (kind ~ '^[a-z_]{3,40}$')
);

CREATE TABLE risk_alerts (
    id               BIGSERIAL PRIMARY KEY,
    kind             TEXT NOT NULL REFERENCES risk_alert_rules(kind) ON DELETE RESTRICT,
    severity         risk_alert_severity NOT NULL,
    status           risk_alert_status NOT NULL DEFAULT 'open',
    title            TEXT NOT NULL,
    body             TEXT,
    dedupe_key       TEXT NOT NULL,
    subject_user_id  UUID REFERENCES users(id) ON DELETE SET NULL,
    ticket_id        UUID REFERENCES tickets(id) ON DELETE SET NULL,
    match_id         BIGINT REFERENCES matches(id) ON DELETE SET NULL,
    currency         CHAR(4),
    amount_micro     BIGINT,
    payload          JSONB NOT NULL DEFAULT '{}'::jsonb,
    assigned_to      UUID REFERENCES users(id) ON DELETE SET NULL,
    acknowledged_at  TIMESTAMPTZ,
    acknowledged_by  UUID REFERENCES users(id) ON DELETE SET NULL,
    resolved_at      TIMESTAMPTZ,
    resolved_by      UUID REFERENCES users(id) ON DELETE SET NULL,
    resolution       TEXT,
    occurrences      INTEGER NOT NULL DEFAULT 1,
    first_seen_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_seen_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT risk_alerts_title_length CHECK (char_length(title) BETWEEN 1 AND 200),
    CONSTRAINT risk_alerts_body_length CHECK (body IS NULL OR char_length(body) <= 2000),
    CONSTRAINT risk_alerts_resolution_length
        CHECK (resolution IS NULL OR char_length(resolution) <= 2000),
    CONSTRAINT risk_alerts_dedupe_length CHECK (char_length(dedupe_key) BETWEEN 3 AND 200),
    CONSTRAINT risk_alerts_occurrences_pos CHECK (occurrences >= 1),
    CONSTRAINT risk_alerts_resolved_consistency
        CHECK ((status = 'resolved') = (resolved_at IS NOT NULL))
);

-- ON CONFLICT target for the sweeper: one live row per condition.
CREATE UNIQUE INDEX risk_alerts_dedupe_active
    ON risk_alerts (dedupe_key)
    WHERE status <> 'resolved';

-- Every row by key, so "was this ever raised and resolved" is an index
-- probe (the sweeper's NOT EXISTS gate).
CREATE INDEX risk_alerts_dedupe_idx ON risk_alerts (dedupe_key);

-- Queue view: active alerts, worst first, newest activity first.
CREATE INDEX risk_alerts_queue_idx
    ON risk_alerts (severity, last_seen_at DESC)
    WHERE status <> 'resolved';

CREATE INDEX risk_alerts_status_idx ON risk_alerts (status, last_seen_at DESC);

-- Bettor card: "alerts about this account".
CREATE INDEX risk_alerts_subject_idx
    ON risk_alerts (subject_user_id, created_at DESC)
    WHERE subject_user_id IS NOT NULL;

CREATE INDEX risk_alerts_assignee_idx
    ON risk_alerts (assigned_to)
    WHERE assigned_to IS NOT NULL AND status <> 'resolved';

CREATE TABLE risk_alert_events (
    id             BIGSERIAL PRIMARY KEY,
    alert_id       BIGINT NOT NULL REFERENCES risk_alerts(id) ON DELETE CASCADE,
    kind           TEXT NOT NULL
                   CHECK (kind IN ('created', 'acknowledged', 'assigned', 'comment',
                                   'resolved', 'reopened', 'escalated')),
    actor_user_id  UUID REFERENCES users(id) ON DELETE SET NULL,
    note           TEXT,
    meta           JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT risk_alert_events_note_length CHECK (note IS NULL OR char_length(note) <= 2000)
);

CREATE INDEX risk_alert_events_alert_idx ON risk_alert_events (alert_id, id);

-- Default rule set. Thresholds are USDC (real money); the demo OZ
-- currency never raises money alerts. Params are read by
-- services/api/src/lib/riskzilla/alert-rules.ts — keep the keys in sync.
INSERT INTO risk_alert_rules (kind, severity, params) VALUES
  ('big_stake',               'warning',  '{"thresholdUsdc": 500,  "windowHours": 24}'),
  ('big_payout',              'serious',  '{"thresholdUsdc": 2000, "windowHours": 24}'),
  ('high_exposure_ticket',    'serious',  '{"thresholdUsdc": 5000}'),
  ('sharp_bettor',            'serious',  '{"minSettled": 30, "maxHoldPct": -15, "windowDays": 30}'),
  ('velocity_burst',          'warning',  '{"maxPerMinute": 10, "windowMinutes": 15}'),
  ('rejection_streak',        'warning',  '{"minRejected": 5, "windowMinutes": 10}'),
  ('bot_behaviour',           'serious',  '{}'),
  ('multi_account_ip',        'serious',  '{"minAccounts": 3, "windowHours": 24}'),
  ('flagged_bettor_activity', 'warning',  '{"windowHours": 24}'),
  ('deposit_wrong_token',     'critical', '{}'),
  ('deposit_unattributed',    'critical', '{}'),
  ('withdrawal_stale',        'warning',  '{"maxHours": 12}'),
  ('bank_exposure',           'critical', '{"minUtilizationPct": 80}'),
  ('unsettled_overdue',       'warning',  '{"maxHours": 6}');
