-- 0083_analytics.sql
--
-- First-party FE analytics — storefront behaviour capture, self-hosted
-- (no third-party analytics vendor sees bettor traffic).
--
--   * analytics_sessions      — one row per browser session. The id is
--                               client-generated (sessionStorage) so a
--                               session spans SSR navigations without a
--                               server round-trip at start; anonymous
--                               sessions link to a user the first time an
--                               authed flush arrives.
--   * analytics_events        — append-only journey log (page_view /
--                               click / heartbeat / session_end). The
--                               client stamps a per-session monotonic
--                               `seq`, so exact click order is
--                               reconstructible and re-delivered batches
--                               (pagehide fires both keepalive fetch AND
--                               sendBeacon in some browsers) are
--                               apply-once via UNIQUE (session_id, seq).
--   * analytics_mouse_batches — sampled mouse trails (~8 Hz while the
--                               pointer moves), stored as compact
--                               [[dtMs, x, y], ...] JSONB per flush with
--                               viewport dims for replay scaling. By far
--                               the heaviest table, so it gets its own
--                               (shorter) retention window.
--
-- `kind` and `section` are intentionally open TEXT (no CHECK / enum):
-- new event kinds and storefront sections should not need a migration —
-- same rationale as zillapass_tasks.predicate_key. The API layer
-- validates against its own allowlist with zod.
--
-- Retention is enforced by an hourly sweep in the api service (Redis
-- NX-lock, same shape as the monitoring sampler): 90 days for
-- sessions + events, 14 days for mouse batches.

BEGIN;

CREATE TABLE analytics_sessions (
  id              uuid        PRIMARY KEY,
  user_id         uuid        REFERENCES users(id) ON DELETE SET NULL,
  started_at      timestamptz NOT NULL,
  last_seen_at    timestamptz NOT NULL,
  entry_path      text,
  exit_path       text,
  referrer        text,
  user_agent      text,
  viewport_w      integer,
  viewport_h      integer,
  -- Denormalised counters bumped per flush so the admin list + KPI
  -- queries never aggregate the events table per session row.
  page_view_count integer     NOT NULL DEFAULT 0,
  click_count     integer     NOT NULL DEFAULT 0,
  event_count     integer     NOT NULL DEFAULT 0,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT analytics_sessions_seen_after_start CHECK (last_seen_at >= started_at)
);

CREATE INDEX analytics_sessions_started_idx
  ON analytics_sessions (started_at DESC);
CREATE INDEX analytics_sessions_user_idx
  ON analytics_sessions (user_id, started_at DESC)
  WHERE user_id IS NOT NULL;
-- Retention sweep scans by last activity.
CREATE INDEX analytics_sessions_last_seen_idx
  ON analytics_sessions (last_seen_at);

CREATE TABLE analytics_events (
  id          bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  session_id  uuid        NOT NULL REFERENCES analytics_sessions(id) ON DELETE CASCADE,
  -- Client-side monotonic counter per session: exact journey order +
  -- apply-once under batch re-delivery.
  seq         integer     NOT NULL,
  kind        text        NOT NULL,
  occurred_at timestamptz NOT NULL,
  path        text,
  section     text,
  payload     jsonb,
  CONSTRAINT analytics_events_session_seq_unique UNIQUE (session_id, seq)
);

CREATE INDEX analytics_events_time_idx ON analytics_events (occurred_at);
CREATE INDEX analytics_events_kind_time_idx ON analytics_events (kind, occurred_at);

CREATE TABLE analytics_mouse_batches (
  id          bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  session_id  uuid        NOT NULL REFERENCES analytics_sessions(id) ON DELETE CASCADE,
  -- Same per-session counter space as analytics_events.seq — one
  -- monotonic stream client-side keeps ordering trivial.
  seq         integer     NOT NULL,
  path        text        NOT NULL,
  started_at  timestamptz NOT NULL,
  duration_ms integer     NOT NULL,
  viewport_w  integer,
  viewport_h  integer,
  point_count integer     NOT NULL,
  -- [[dtMs, x, y], ...] — dt relative to started_at, x/y viewport px.
  points      jsonb       NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT analytics_mouse_batches_session_seq_unique UNIQUE (session_id, seq),
  CONSTRAINT analytics_mouse_batches_point_count_range CHECK (point_count BETWEEN 1 AND 1000)
);

CREATE INDEX analytics_mouse_batches_session_idx
  ON analytics_mouse_batches (session_id, started_at);
-- Retention sweep scans by insert time.
CREATE INDEX analytics_mouse_batches_created_idx
  ON analytics_mouse_batches (created_at);

COMMIT;
