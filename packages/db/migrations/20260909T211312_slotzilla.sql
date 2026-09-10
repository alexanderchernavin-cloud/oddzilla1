-- SlotZilla — the 15-second live-basketball slot game.
--
-- A spin covers 15 seconds of match clock split into three 5-second
-- windows; each window becomes a reel showing the highest-value event
-- Sportradar's scouts logged inside it (3PT > 2PT > FT > MISS > FOUL >
-- NONE); two or three reels on one symbol pay from a paytable. Rounds
-- anchor at the bettor's spin on a fixed 5-second grid of the match
-- clock, so a window's symbol is derived once and shared by every spin
-- that covers it. Design and the measurements behind every default:
-- docs/SLOTZILLA.md.
--
-- Four tables:
--
--   sr_live_events       Sportradar's play-by-play, one row per event,
--                        keyed on THEIR event id. The audit trail behind
--                        every settled spin and the calibration corpus.
--                        match_id is nullable because archived corpus
--                        games have no fixture of ours.
--
--   slotzilla_config     singleton (id = 'default'): master switch, the
--                        currencies allowed, and every number the
--                        operator asked to control — the return target,
--                        stake bounds, max payout per spin, per-match
--                        liability cap, the lead and grace seconds.
--
--   slotzilla_paytables  named paytables; `lines` is a jsonb map of
--                        line key -> multiplier in HUNDREDTHS (50 = x0.5,
--                        3500 = x35), integers so payouts are exact bigint
--                        arithmetic. Exactly one is active.
--
--   slotzilla_games      one row per fixture the game runs on (a
--                        confirmed basketball row of match_sportradar_ids),
--                        with the clock as last read, the coverage level
--                        that gates player mode, and the running stake /
--                        payout totals the return monitor reads.
--
--   slotzilla_spins      a spin is a bet AND a round in one row: stake,
--                        the first window's clock second (a multiple of
--                        5), the three reels frozen at settlement, the
--                        line, the multiplier and the payout. Money in
--                        BIGINT _micro scoped by currency (invariant 1).
--
-- The enum values it writes to wallet_ledger are in the file before this
-- one (20260909T211311). The FKs on matches / users take a brief SHARE
-- ROW EXCLUSIVE on tables both ingesters write to continuously, so fail
-- the deploy cleanly rather than queue the catalog behind it (0100,
-- 0106, 0110 carry the same).

SET LOCAL lock_timeout = '5s';

-- ── Sportradar play-by-play ─────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS sr_live_events (
  sr_event_id   bigint      PRIMARY KEY,
  sr_match_id   bigint      NOT NULL,
  match_id      bigint      REFERENCES matches(id) ON DELETE SET NULL,
  type          text        NOT NULL,
  -- Derived ONCE at insert by the rule both the engine and the calibrator
  -- share (docs/fixtures/slotzilla-rules.json); NULL for an event that
  -- makes no symbol (rebounds, turnovers, clock events).
  symbol        text,
  team          text,
  points        smallint,
  -- Cumulative match-clock second the scout logged the event at. The
  -- windows are ranges of THIS, never of arrival time.
  seconds       integer     NOT NULL,
  uts           bigint      NOT NULL,
  updated_uts   bigint      NOT NULL,
  disabled      boolean     NOT NULL DEFAULT false,
  period        smallint,
  player_id     bigint,
  player_name   text,
  raw           jsonb       NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT sr_live_events_symbol_check
    CHECK (symbol IS NULL OR symbol IN ('P3', 'P2', 'FT', 'MISS', 'FOUL')),
  CONSTRAINT sr_live_events_team_check
    CHECK (team IS NULL OR team IN ('home', 'away'))
);

CREATE INDEX IF NOT EXISTS sr_live_events_match_seconds_idx
  ON sr_live_events (sr_match_id, seconds);
CREATE INDEX IF NOT EXISTS sr_live_events_created_idx
  ON sr_live_events (created_at);

-- ── Operator settings ───────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS slotzilla_config (
  id                        text        PRIMARY KEY DEFAULT 'default',
  enabled                   boolean     NOT NULL DEFAULT false,
  -- Currencies spins may be placed in. OZ only until the soak is done;
  -- USDC is switched on here, not in code.
  currencies                text[]      NOT NULL DEFAULT '{OZ}'::text[],
  -- Return to player the calibrator fits the paytable to, in basis
  -- points (9700 = 97%). Operator's number, 2026-09-09.
  rtp_target_bp             integer     NOT NULL DEFAULT 9700,
  -- A spin's first window opens at the first 5-second mark at least this
  -- many match-clock seconds after the reading we hold (feed lag is 5-7 s).
  lead_seconds              integer     NOT NULL DEFAULT 10,
  -- A spin settles once the clock is this far past its last window...
  clock_past_seconds        integer     NOT NULL DEFAULT 5,
  -- ...and this many wall-clock seconds have passed since the last event
  -- inside it, to absorb scout corrections.
  grace_seconds             integer     NOT NULL DEFAULT 10,
  -- A feed silent for this long voids every open spin on the game.
  feed_dark_void_seconds    integer     NOT NULL DEFAULT 180,
  -- Stake bounds and caps, in micro units; OZ mirrors the USDC numbers.
  min_stake_micro           bigint      NOT NULL DEFAULT 100000,
  max_stake_micro           bigint      NOT NULL DEFAULT 50000000,
  max_payout_micro          bigint      NOT NULL DEFAULT 500000000,
  match_liability_cap_micro bigint      NOT NULL DEFAULT 5000000000,
  -- The return monitor alarms when a game's realised return exceeds the
  -- target by this margin (basis points) over at least min_spins spins.
  return_alarm_margin_bp    integer     NOT NULL DEFAULT 1000,
  return_alarm_min_spins    integer     NOT NULL DEFAULT 200,
  autoplay_enabled          boolean     NOT NULL DEFAULT true,
  updated_by                uuid        REFERENCES users(id) ON DELETE SET NULL,
  updated_at                timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT slotzilla_config_singleton CHECK (id = 'default'),
  CONSTRAINT slotzilla_config_rtp_range CHECK (rtp_target_bp BETWEEN 5000 AND 9900),
  CONSTRAINT slotzilla_config_lead_range CHECK (lead_seconds BETWEEN 5 AND 60),
  CONSTRAINT slotzilla_config_grace_range CHECK (grace_seconds BETWEEN 0 AND 120),
  CONSTRAINT slotzilla_config_clock_past_range CHECK (clock_past_seconds BETWEEN 0 AND 60),
  CONSTRAINT slotzilla_config_dark_range CHECK (feed_dark_void_seconds BETWEEN 30 AND 3600),
  CONSTRAINT slotzilla_config_stake_order CHECK (
    min_stake_micro > 0 AND max_stake_micro >= min_stake_micro
  ),
  CONSTRAINT slotzilla_config_caps_positive CHECK (
    max_payout_micro > 0 AND match_liability_cap_micro > 0
  ),
  CONSTRAINT slotzilla_config_currencies_check CHECK (
    currencies <@ ARRAY['USDC', 'OZ']::text[]
  )
);

INSERT INTO slotzilla_config (id) VALUES ('default')
  ON CONFLICT (id) DO NOTHING;

-- ── Paytables ───────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS slotzilla_paytables (
  id             bigserial   PRIMARY KEY,
  name           text        NOT NULL,
  -- line key ('any2:P2', 'all3:NONE', ...) -> multiplier in hundredths.
  lines          jsonb       NOT NULL,
  -- What the calibrator measured this table returning, and against what.
  fitted_rtp_bp  integer,
  corpus_note    text,
  active         boolean     NOT NULL DEFAULT false,
  updated_by     uuid        REFERENCES users(id) ON DELETE SET NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT slotzilla_paytables_name_check CHECK (length(name) BETWEEN 1 AND 80)
);

-- Exactly one active paytable.
CREATE UNIQUE INDEX IF NOT EXISTS slotzilla_paytables_active_uniq
  ON slotzilla_paytables ((true))
  WHERE active;

-- The indicative v1 table from docs/SLOTZILLA.md: Betby's grid shape,
-- NONE at x0.5 / x1, play rows scaled to 97% on the measured rounds,
-- unobserved All-3 lines at Betby's ratios. Seeded active so a fresh
-- database can run the game; the calibrator replaces it.
INSERT INTO slotzilla_paytables (name, lines, fitted_rtp_bp, corpus_note, active)
SELECT
  'v1 indicative (docs/SLOTZILLA.md)',
  '{"any2:P3":3500,"all3:P3":50000,"any2:P2":1800,"all3:P2":20000,"any2:FT":2200,"all3:FT":25000,"any2:MISS":900,"all3:MISS":5500,"any2:FOUL":500,"all3:FOUL":1800,"any2:NONE":50,"all3:NONE":100}'::jsonb,
  9650,
  '4 games, 2012 spin-anchored rounds, 2026-09-09; All-3 play lines unobserved',
  true
WHERE NOT EXISTS (SELECT 1 FROM slotzilla_paytables);

-- ── Games ───────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS slotzilla_games (
  match_id            bigint      PRIMARY KEY REFERENCES matches(id) ON DELETE CASCADE,
  sr_match_id         bigint      NOT NULL,
  status              text        NOT NULL DEFAULT 'scheduled',
  -- Sportradar's coverage.live.level for the match; 2 = players on events.
  coverage_level      smallint,
  paytable_id         bigint      REFERENCES slotzilla_paytables(id) ON DELETE SET NULL,
  -- The clock as the service last read it.
  clock_seconds       integer,
  clock_running       boolean     NOT NULL DEFAULT false,
  clock_period        smallint,
  clock_read_at       timestamptz,
  feed_lag_ms         integer,
  last_event_at       timestamptz,
  -- Return monitor inputs, per currency.
  spins_count         integer     NOT NULL DEFAULT 0,
  usdc_stake_micro    bigint      NOT NULL DEFAULT 0,
  usdc_payout_micro   bigint      NOT NULL DEFAULT 0,
  oz_stake_micro      bigint      NOT NULL DEFAULT 0,
  oz_payout_micro     bigint      NOT NULL DEFAULT 0,
  -- Operator pause: open spins settle, no new ones are accepted.
  paused_by           uuid        REFERENCES users(id) ON DELETE SET NULL,
  paused_at           timestamptz,
  note                text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT slotzilla_games_status_check
    CHECK (status IN ('scheduled', 'live', 'paused', 'ended', 'voided'))
);

CREATE INDEX IF NOT EXISTS slotzilla_games_status_idx
  ON slotzilla_games (status);

-- ── Spins ───────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS slotzilla_spins (
  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          uuid        NOT NULL REFERENCES users(id),
  match_id         bigint      NOT NULL REFERENCES slotzilla_games(match_id),
  currency         char(4)     NOT NULL,
  stake_micro      bigint      NOT NULL,
  -- stake x top line, bounded by max_payout_micro at placement: what the
  -- per-match cap counts and what RiskZilla's open liability carries for
  -- USDC until settlement releases it.
  exposure_micro   bigint      NOT NULL,
  paytable_id      bigint      NOT NULL REFERENCES slotzilla_paytables(id),
  -- First window's match-clock second; windows are +0, +5, +10.
  window_from      integer     NOT NULL,
  -- Frozen at settlement; NULL while open.
  reels            text[],
  reel_teams       text[],
  reel_event_ids   bigint[],
  line_key         text,
  multiplier_x100  integer,
  payout_micro     bigint      NOT NULL DEFAULT 0,
  status           text        NOT NULL DEFAULT 'open',
  void_reason      text,
  autoplay         boolean     NOT NULL DEFAULT false,
  idempotency_key  text,
  placed_at        timestamptz NOT NULL DEFAULT now(),
  settled_at       timestamptz,
  CONSTRAINT slotzilla_spins_status_check
    CHECK (status IN ('open', 'won', 'lost', 'void')),
  CONSTRAINT slotzilla_spins_stake_positive CHECK (stake_micro > 0),
  CONSTRAINT slotzilla_spins_exposure_nonneg CHECK (exposure_micro >= 0),
  CONSTRAINT slotzilla_spins_payout_nonneg CHECK (payout_micro >= 0),
  CONSTRAINT slotzilla_spins_window_grid CHECK (window_from >= 0 AND window_from % 5 = 0),
  CONSTRAINT slotzilla_spins_reels_shape CHECK (reels IS NULL OR cardinality(reels) = 3),
  CONSTRAINT slotzilla_spins_settled_shape CHECK (
    (status = 'open' AND settled_at IS NULL AND reels IS NULL)
    OR (status IN ('won', 'lost') AND settled_at IS NOT NULL AND reels IS NOT NULL)
    OR (status = 'void' AND settled_at IS NOT NULL)
  )
);

-- One open spin per bettor per match — true under a double-click.
CREATE UNIQUE INDEX IF NOT EXISTS slotzilla_spins_one_open_uniq
  ON slotzilla_spins (user_id, match_id)
  WHERE status = 'open';
-- A network retry of the same placement returns the same spin.
CREATE UNIQUE INDEX IF NOT EXISTS slotzilla_spins_idempotency_uniq
  ON slotzilla_spins (user_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;
-- The settler's work list and the per-match cap's sum.
CREATE INDEX IF NOT EXISTS slotzilla_spins_open_idx
  ON slotzilla_spins (match_id, window_from)
  WHERE status = 'open';
-- Bettor history.
CREATE INDEX IF NOT EXISTS slotzilla_spins_user_idx
  ON slotzilla_spins (user_id, placed_at DESC);
