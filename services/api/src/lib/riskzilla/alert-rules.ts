// Alert center rule catalogue (migration 0105).
//
// Each rule is one INSERT ... SELECT the sweeper runs against Postgres:
// the SELECT lists candidate conditions (whale stake, bettor beating
// the book, accounts sharing an IP, ...) and the INSERT lands them in
// risk_alerts, deduplicated by `dedupe_key`. A key that is still
// unresolved bumps `occurrences` / `last_seen_at`; a key that was
// resolved never fires again, so rules whose condition persists (a
// sharp bettor stays sharp) bucket their key by time and re-raise at
// most once per bucket.
//
// These are B2C sportsbook rules — the subject is a bettor, a ticket, a
// deposit or the operator's bank, never a B2B client account. Money
// thresholds are USDC only; OZ is the demo currency and never alerts.
//
// Params live in risk_alert_rules.params (jsonb) and are edited at
// /admin/alerts. `readParams` fills any missing key from the defaults
// below so a partially edited row still evaluates.

import { sql, type SQL } from "drizzle-orm";

export const ALERT_SEVERITIES = ["critical", "serious", "warning"] as const;
export type AlertSeverity = (typeof ALERT_SEVERITIES)[number];

export type AlertParams = Record<string, number>;

export interface AlertRuleDef {
  kind: string;
  label: string;
  // One sentence the rules editor shows the operator.
  description: string;
  defaultSeverity: AlertSeverity;
  defaultParams: AlertParams;
  // Human labels + bounds for each param the editor renders.
  paramMeta: Record<string, { label: string; min: number; max: number; unit?: string }>;
  // Candidate SELECT. Must emit exactly these columns:
  //   title, body, dedupe_key, subject_user_id, ticket_id, match_id,
  //   currency, amount_micro, payload
  // and at most one row per dedupe_key.
  select: (p: AlertParams) => SQL;
}

// to_char money helper: micro -> "1,234.50"
const money = (col: SQL) => sql`to_char(${col} / 1000000.0, 'FM999,999,999,990.00')`;

// USDC threshold in whole units -> micro, as a bigint literal.
const usdcMicro = (units: number) => sql`${Math.round(units * 1_000_000).toString()}::bigint`;

// Untyped bind parameters cannot take part in `||` or jsonb_build_object,
// so every scalar that ends up inside SQL text is cast explicitly.
const intervalOf = (n: number, unit: "minutes" | "hours" | "days") =>
  sql`(${Math.round(n).toString()}::text || ' ${sql.raw(unit)}')::interval`;
const txt = (v: string | number) => sql`${String(v)}::text`;
const int = (v: number) => sql`${Math.round(v)}::int`;

export const ALERT_RULES: AlertRuleDef[] = [
  {
    kind: "big_stake",
    label: "Large stake",
    description: "A single USDC ticket staked at or above the threshold.",
    defaultSeverity: "warning",
    defaultParams: { thresholdUsdc: 500, windowHours: 24 },
    paramMeta: {
      thresholdUsdc: { label: "Stake at least", min: 1, max: 10_000_000, unit: "USDC" },
      windowHours: { label: "Look back", min: 1, max: 720, unit: "hours" },
    },
    select: (p) => sql`
      SELECT
        'Large stake ' || ${money(sql`t.stake_micro`)} || ' USDC'             AS title,
        COALESCE(u.nickname, u.email) || ' placed a ' || t.bet_type::text ||
          ' for ' || ${money(sql`t.stake_micro`)} || ' USDC (potential ' ||
          ${money(sql`t.potential_payout_micro`)} || ')'                     AS body,
        'big_stake:' || t.id::text                                           AS dedupe_key,
        t.user_id                                                            AS subject_user_id,
        t.id                                                                 AS ticket_id,
        NULL::bigint                                                         AS match_id,
        'USDC'                                                               AS currency,
        t.stake_micro                                                        AS amount_micro,
        jsonb_build_object('betType', t.bet_type::text,
                           'potentialPayoutMicro', t.potential_payout_micro::text,
                           'status', t.status::text)                         AS payload
      FROM tickets t
      JOIN users u ON u.id = t.user_id
      WHERE t.currency = 'USDC'
        AND t.status <> 'rejected'
        AND t.stake_micro >= ${usdcMicro(p.thresholdUsdc!)}
        AND t.placed_at >= NOW() - ${intervalOf(p.windowHours!, "hours")}
    `,
  },
  {
    kind: "big_payout",
    label: "Large payout",
    description: "A settled USDC ticket paid out at or above the threshold.",
    defaultSeverity: "serious",
    defaultParams: { thresholdUsdc: 2000, windowHours: 24 },
    paramMeta: {
      thresholdUsdc: { label: "Payout at least", min: 1, max: 10_000_000, unit: "USDC" },
      windowHours: { label: "Look back", min: 1, max: 720, unit: "hours" },
    },
    select: (p) => sql`
      SELECT
        'Large payout ' || ${money(sql`t.actual_payout_micro`)} || ' USDC'    AS title,
        COALESCE(u.nickname, u.email) || ' won ' ||
          ${money(sql`t.actual_payout_micro`)} || ' USDC on a ' ||
          ${money(sql`t.stake_micro`)} || ' USDC ' || t.bet_type::text        AS body,
        'big_payout:' || t.id::text                                          AS dedupe_key,
        t.user_id AS subject_user_id, t.id AS ticket_id, NULL::bigint AS match_id,
        'USDC' AS currency, t.actual_payout_micro AS amount_micro,
        jsonb_build_object('stakeMicro', t.stake_micro::text,
                           'betType', t.bet_type::text,
                           'settledAt', t.settled_at)                        AS payload
      FROM tickets t
      JOIN users u ON u.id = t.user_id
      WHERE t.currency = 'USDC'
        AND t.status IN ('settled', 'cashed_out')
        AND COALESCE(t.actual_payout_micro, 0) >= ${usdcMicro(p.thresholdUsdc!)}
        AND COALESCE(t.settled_at, t.placed_at) >= NOW() - ${intervalOf(p.windowHours!, "hours")}
    `,
  },
  {
    kind: "high_exposure_ticket",
    label: "High open exposure",
    description: "An open USDC ticket whose potential payout is at or above the threshold.",
    defaultSeverity: "serious",
    defaultParams: { thresholdUsdc: 5000 },
    paramMeta: {
      thresholdUsdc: { label: "Potential payout at least", min: 1, max: 10_000_000, unit: "USDC" },
    },
    select: (p) => sql`
      SELECT
        'Open exposure ' || ${money(sql`t.potential_payout_micro`)} || ' USDC' AS title,
        COALESCE(u.nickname, u.email) || ' has an open ' || t.bet_type::text ||
          ' paying ' || ${money(sql`t.potential_payout_micro`)} ||
          ' USDC on a ' || ${money(sql`t.stake_micro`)} || ' USDC stake'      AS body,
        'exposure:' || t.id::text                                            AS dedupe_key,
        t.user_id AS subject_user_id, t.id AS ticket_id, NULL::bigint AS match_id,
        'USDC' AS currency, t.potential_payout_micro AS amount_micro,
        jsonb_build_object('stakeMicro', t.stake_micro::text,
                           'betType', t.bet_type::text)                      AS payload
      FROM tickets t
      JOIN users u ON u.id = t.user_id
      WHERE t.currency = 'USDC'
        AND t.status IN ('accepted', 'pending_delay')
        AND t.potential_payout_micro >= ${usdcMicro(p.thresholdUsdc!)}
    `,
  },
  {
    kind: "sharp_bettor",
    label: "Sharp bettor",
    description:
      "A bettor with enough settled USDC tickets in the window whose company hold is at or below the limit (the book is losing to them).",
    defaultSeverity: "serious",
    defaultParams: { minSettled: 30, maxHoldPct: -15, windowDays: 30 },
    paramMeta: {
      minSettled: { label: "Settled tickets at least", min: 1, max: 100_000 },
      maxHoldPct: { label: "Company hold at or below", min: -100, max: 100, unit: "%" },
      windowDays: { label: "Window", min: 1, max: 365, unit: "days" },
    },
    select: (p) => sql`
      SELECT
        'Sharp bettor: hold ' || round(a.hold_pct, 1)::text || '% over ' ||
          a.n::text || ' tickets'                                            AS title,
        COALESCE(u.nickname, u.email) || ' turned over ' ||
          ${money(sql`a.staked`)} || ' USDC in ' || ${txt(Math.round(p.windowDays!))} ||
          ' days; company PnL ' || ${money(sql`a.pnl`)} || ' USDC'           AS body,
        'sharp_bettor:' || a.user_id::text || ':' || to_char(NOW(), 'IYYY-IW') AS dedupe_key,
        a.user_id AS subject_user_id, NULL::uuid AS ticket_id, NULL::bigint AS match_id,
        'USDC' AS currency, a.pnl AS amount_micro,
        jsonb_build_object('settled', a.n, 'stakedMicro', a.staked::text,
                           'pnlMicro', a.pnl::text, 'holdPct', round(a.hold_pct, 2),
                           'windowDays', ${int(p.windowDays!)})       AS payload
      FROM (
        SELECT t.user_id,
               COUNT(*)::int                                                AS n,
               SUM(t.stake_micro)::bigint                                   AS staked,
               SUM(t.stake_micro - COALESCE(t.actual_payout_micro, 0))::bigint AS pnl,
               100.0 * SUM(t.stake_micro - COALESCE(t.actual_payout_micro, 0))
                 / NULLIF(SUM(t.stake_micro), 0)                            AS hold_pct
          FROM tickets t
         WHERE t.currency = 'USDC'
           AND t.status IN ('settled', 'cashed_out')
           AND COALESCE(t.settled_at, t.placed_at) >= NOW() - ${intervalOf(p.windowDays!, "days")}
         GROUP BY t.user_id
      ) a
      JOIN users u ON u.id = a.user_id AND u.is_ai = false
      WHERE a.n >= ${int(p.minSettled!)}
        AND a.hold_pct <= ${p.maxHoldPct!}::numeric
    `,
  },
  {
    kind: "velocity_burst",
    label: "Velocity burst",
    description: "One account placed at least N tickets inside a single minute.",
    defaultSeverity: "warning",
    defaultParams: { maxPerMinute: 10, windowMinutes: 15 },
    paramMeta: {
      maxPerMinute: { label: "Tickets per minute at least", min: 2, max: 1000 },
      windowMinutes: { label: "Look back", min: 1, max: 1440, unit: "minutes" },
    },
    select: (p) => sql`
      SELECT
        v.n::text || ' tickets in one minute'                                AS title,
        COALESCE(u.nickname, u.email) || ' placed ' || v.n::text ||
          ' tickets at ' || to_char(v.minute, 'HH24:MI') || ' UTC'           AS body,
        'velocity:' || v.user_id::text || ':' || to_char(v.minute, 'YYYYMMDDHH24MI') AS dedupe_key,
        v.user_id AS subject_user_id, NULL::uuid AS ticket_id, NULL::bigint AS match_id,
        NULL::text AS currency, NULL::bigint AS amount_micro,
        jsonb_build_object('tickets', v.n, 'minute', v.minute)               AS payload
      FROM (
        SELECT t.user_id, date_trunc('minute', t.placed_at) AS minute, COUNT(*)::int AS n
          FROM tickets t
         WHERE t.placed_at >= NOW() - ${intervalOf(p.windowMinutes!, "minutes")}
         GROUP BY t.user_id, date_trunc('minute', t.placed_at)
        HAVING COUNT(*) >= ${int(p.maxPerMinute!)}
      ) v
      JOIN users u ON u.id = v.user_id
    `,
  },
  {
    kind: "rejection_streak",
    label: "Rejection streak",
    description:
      "One account collected at least N rejected placements (RiskZilla gates or bet-delay kills) inside the window — typical limit probing.",
    defaultSeverity: "warning",
    defaultParams: { minRejected: 5, windowMinutes: 10 },
    paramMeta: {
      minRejected: { label: "Rejections at least", min: 2, max: 1000 },
      windowMinutes: { label: "Window", min: 1, max: 1440, unit: "minutes" },
    },
    select: (p) => sql`
      SELECT
        r.n::text || ' rejected placements in ' || ${txt(Math.round(p.windowMinutes!))} || ' min' AS title,
        COALESCE(u.nickname, u.email) || ' was rejected ' || r.n::text ||
          ' times; reasons: ' || r.reasons                                   AS body,
        'rejections:' || r.user_id::text || ':' || to_char(date_trunc('hour', NOW()), 'YYYYMMDDHH24') AS dedupe_key,
        r.user_id AS subject_user_id, NULL::uuid AS ticket_id, NULL::bigint AS match_id,
        NULL::text AS currency, NULL::bigint AS amount_micro,
        jsonb_build_object('rejected', r.n, 'reasons', r.reasons)            AS payload
      FROM (
        SELECT x.user_id, COUNT(*)::int AS n,
               string_agg(DISTINCT x.reason, ', ') AS reasons
          FROM (
            SELECT el.user_id, el.decision::text AS reason
              FROM riskzilla_event_log el
             WHERE el.decision <> 'accepted'
               AND el.created_at >= NOW() - ${intervalOf(p.windowMinutes!, "minutes")}
            UNION ALL
            SELECT t.user_id, COALESCE(t.reject_reason, 'rejected')
              FROM tickets t
             WHERE t.status = 'rejected'
               AND t.placed_at >= NOW() - ${intervalOf(p.windowMinutes!, "minutes")}
          ) x
         GROUP BY x.user_id
        HAVING COUNT(*) >= ${int(p.minRejected!)}
      ) r
      JOIN users u ON u.id = r.user_id
    `,
  },
  {
    kind: "bot_behaviour",
    label: "Automation suspected",
    description:
      "The behaviour sweeper raised an automation alert on the bettor and nobody has acknowledged it yet.",
    defaultSeverity: "serious",
    defaultParams: {},
    paramMeta: {},
    select: () => sql`
      SELECT
        'Automation suspected: score ' || COALESCE(round(bbs.score * 100)::text, '—') || '%' AS title,
        COALESCE(u.nickname, u.email) || ' scored ' ||
          COALESCE(round(bbs.score * 100)::text, '—') || '% across ' ||
          bbs.sessions_scored::text || ' sessions'                           AS body,
        'bot:' || bbs.user_id::text || ':' ||
          COALESCE(to_char(bbs.alert_since, 'YYYYMMDDHH24MISS'), 'na')      AS dedupe_key,
        bbs.user_id AS subject_user_id, NULL::uuid AS ticket_id, NULL::bigint AS match_id,
        NULL::text AS currency, NULL::bigint AS amount_micro,
        jsonb_build_object('score', bbs.score, 'maxSessionScore', bbs.max_session_score,
                           'sessionsScored', bbs.sessions_scored,
                           'alertSince', bbs.alert_since)                    AS payload
      FROM bettor_behaviour_scores bbs
      JOIN users u ON u.id = bbs.user_id
      WHERE bbs.alert = TRUE AND bbs.acknowledged_at IS NULL
    `,
  },
  {
    kind: "multi_account_ip",
    label: "Accounts sharing an IP",
    description: "At least N distinct bettor accounts logged in from the same IP inside the window.",
    defaultSeverity: "serious",
    defaultParams: { minAccounts: 3, windowHours: 24 },
    paramMeta: {
      minAccounts: { label: "Distinct accounts at least", min: 2, max: 1000 },
      windowHours: { label: "Window", min: 1, max: 720, unit: "hours" },
    },
    select: (p) => sql`
      SELECT
        g.n::text || ' accounts on ' || g.ip                                 AS title,
        'Bettors sharing ' || g.ip || ' in the last ' ||
          ${txt(Math.round(p.windowHours!))} || ' h: ' || g.emails       AS body,
        'multi_ip:' || g.ip || ':' || to_char(NOW(), 'YYYYMMDD')             AS dedupe_key,
        NULL::uuid AS subject_user_id, NULL::uuid AS ticket_id, NULL::bigint AS match_id,
        NULL::text AS currency, NULL::bigint AS amount_micro,
        jsonb_build_object('ip', g.ip, 'accounts', g.n, 'userIds', g.user_ids) AS payload
      FROM (
        SELECT host(s.ip_inet)                          AS ip,
               COUNT(DISTINCT s.user_id)::int           AS n,
               array_agg(DISTINCT s.user_id::text)      AS user_ids,
               string_agg(DISTINCT COALESCE(u.nickname, u.email), ', ') AS emails
          FROM sessions s
          JOIN users u ON u.id = s.user_id AND u.role = 'user' AND u.is_ai = false
         WHERE s.ip_inet IS NOT NULL
           AND s.created_at >= NOW() - ${intervalOf(p.windowHours!, "hours")}
         GROUP BY host(s.ip_inet)
        HAVING COUNT(DISTINCT s.user_id) >= ${int(p.minAccounts!)}
      ) g
    `,
  },
  {
    kind: "flagged_bettor_activity",
    label: "Flagged bettor placed bets",
    description: "A bettor labelled fraud, suspicious or shady placed tickets inside the window.",
    defaultSeverity: "warning",
    defaultParams: { windowHours: 24 },
    paramMeta: { windowHours: { label: "Look back", min: 1, max: 720, unit: "hours" } },
    select: (p) => sql`
      SELECT
        'Flagged bettor active: ' || f.n::text || ' tickets'                 AS title,
        COALESCE(u.nickname, u.email) || ' (' || array_to_string(u.labels, ', ') ||
          ') placed ' || f.n::text || ' tickets, ' || ${money(sql`f.staked`)} || ' ' || f.currency AS body,
        'flagged:' || f.user_id::text || ':' || f.currency || ':' || to_char(NOW(), 'YYYYMMDD') AS dedupe_key,
        f.user_id AS subject_user_id, NULL::uuid AS ticket_id, NULL::bigint AS match_id,
        f.currency AS currency, f.staked AS amount_micro,
        jsonb_build_object('tickets', f.n, 'labels', to_jsonb(u.labels))   AS payload
      FROM (
        SELECT t.user_id, trim(t.currency) AS currency, COUNT(*)::int AS n,
               SUM(t.stake_micro)::bigint AS staked
          FROM tickets t
         WHERE t.placed_at >= NOW() - ${intervalOf(p.windowHours!, "hours")}
           AND t.status <> 'rejected'
         GROUP BY t.user_id, trim(t.currency)
      ) f
      JOIN users u ON u.id = f.user_id
      WHERE u.labels && ARRAY['fraud', 'suspicious', 'shady']::text[]
    `,
  },
  {
    kind: "deposit_wrong_token",
    label: "Deposit with wrong token",
    description: "A deposit intent failed because a non-USDC token arrived and nobody acknowledged it on the Deposits page.",
    defaultSeverity: "critical",
    defaultParams: {},
    paramMeta: {},
    select: () => sql`
      SELECT
        'Wrong-token deposit'                                                AS title,
        COALESCE(u.nickname, u.email) || ' sent ' ||
          COALESCE(di.detected_token_contract, 'an unknown token') ||
          ' in tx ' || left(di.tx_hash, 14) || '…'                           AS body,
        'deposit_wrong_token:' || di.id::text                               AS dedupe_key,
        di.user_id AS subject_user_id, NULL::uuid AS ticket_id, NULL::bigint AS match_id,
        NULL::text AS currency, NULL::bigint AS amount_micro,
        jsonb_build_object('intentId', di.id, 'txHash', di.tx_hash,
                           'tokenContract', di.detected_token_contract,
                           'amountRaw', di.detected_token_amount_raw::text)  AS payload
      FROM deposit_intents di
      LEFT JOIN users u ON u.id = di.user_id
      WHERE di.failure_reason = 'wrong_token' AND di.acknowledged_at IS NULL
    `,
  },
  {
    kind: "deposit_unattributed",
    label: "Unattributed deposit",
    description: "A transfer reached the receive address from a wallet no bettor has linked; it needs manual review.",
    defaultSeverity: "critical",
    defaultParams: {},
    paramMeta: {},
    select: () => sql`
      SELECT
        'Unattributed deposit ' || COALESCE(ud.token_symbol, '')            AS title,
        'From ' || left(ud.from_address, 12) || '… tx ' || left(ud.tx_hash, 14) ||
          '… on ' || ud.network::text                                        AS body,
        'deposit_unattributed:' || ud.id::text                              AS dedupe_key,
        NULL::uuid AS subject_user_id, NULL::uuid AS ticket_id, NULL::bigint AS match_id,
        NULL::text AS currency, NULL::bigint AS amount_micro,
        jsonb_build_object('id', ud.id, 'txHash', ud.tx_hash, 'from', ud.from_address,
                           'token', ud.token_symbol, 'amountRaw', ud.amount_raw::text) AS payload
      FROM unattributed_deposits ud
      WHERE ud.acknowledged_at IS NULL
    `,
  },
  {
    kind: "withdrawal_stale",
    label: "Withdrawal waiting too long",
    description: "A withdrawal has sat in requested or approved for longer than the limit.",
    defaultSeverity: "warning",
    defaultParams: { maxHours: 12 },
    paramMeta: { maxHours: { label: "Waiting longer than", min: 1, max: 720, unit: "hours" } },
    select: (p) => sql`
      SELECT
        'Withdrawal ' || w.status::text || ' for ' ||
          floor(EXTRACT(epoch FROM NOW() - w.requested_at) / 3600)::text || ' h' AS title,
        COALESCE(u.nickname, u.email) || ' requested ' || ${money(sql`w.amount_micro`)} ||
          ' USDC on ' || to_char(w.requested_at, 'YYYY-MM-DD HH24:MI') || ' UTC' AS body,
        'withdrawal_stale:' || w.id::text                                   AS dedupe_key,
        w.user_id AS subject_user_id, NULL::uuid AS ticket_id, NULL::bigint AS match_id,
        'USDC' AS currency, w.amount_micro AS amount_micro,
        jsonb_build_object('withdrawalId', w.id, 'status', w.status::text,
                           'requestedAt', w.requested_at)                    AS payload
      FROM withdrawals w
      JOIN users u ON u.id = w.user_id
      WHERE w.status IN ('requested', 'approved')
        AND w.requested_at < NOW() - ${intervalOf(p.maxHours!, "hours")}
    `,
  },
  {
    kind: "bank_exposure",
    label: "Bank utilisation",
    description: "Open liability has reached the given share of the RiskZilla bank limit.",
    defaultSeverity: "critical",
    defaultParams: { minUtilizationPct: 80 },
    paramMeta: { minUtilizationPct: { label: "Utilisation at least", min: 1, max: 100, unit: "%" } },
    select: (p) => sql`
      SELECT
        'Bank ' || round(100.0 * b.open_liability_micro / NULLIF(b.bank_limit_micro, 0))::text ||
          '% utilised'                                                       AS title,
        'Open liability ' || ${money(sql`b.open_liability_micro`)} || ' of ' ||
          ${money(sql`b.bank_limit_micro`)} || ' USDC bank limit'            AS body,
        'bank_exposure:' || to_char(NOW(), 'YYYYMMDDHH24')                    AS dedupe_key,
        NULL::uuid AS subject_user_id, NULL::uuid AS ticket_id, NULL::bigint AS match_id,
        'USDC' AS currency, b.open_liability_micro AS amount_micro,
        jsonb_build_object('bankLimitMicro', b.bank_limit_micro::text,
                           'openLiabilityMicro', b.open_liability_micro::text) AS payload
      FROM riskzilla_bank_state b
      WHERE b.bank_limit_micro > 0
        AND 100.0 * b.open_liability_micro / b.bank_limit_micro >= ${p.minUtilizationPct!}::numeric
    `,
  },
  {
    kind: "unsettled_overdue",
    label: "Match closed, tickets unsettled",
    description: "A match has been closed for longer than the limit while accepted tickets on it are still open.",
    defaultSeverity: "warning",
    defaultParams: { maxHours: 6 },
    paramMeta: { maxHours: { label: "Closed longer than", min: 1, max: 720, unit: "hours" } },
    select: (p) => sql`
      SELECT
        m.n::text || ' unsettled tickets on ' || m.label                     AS title,
        m.label || ' closed (scheduled ' || to_char(m.scheduled_at, 'YYYY-MM-DD HH24:MI') ||
          ' UTC) with ' || ${money(sql`m.exposure`)} || ' potential payout open' AS body,
        'unsettled:' || m.match_id::text                                     AS dedupe_key,
        NULL::uuid AS subject_user_id, NULL::uuid AS ticket_id, m.match_id AS match_id,
        NULL::text AS currency, m.exposure AS amount_micro,
        jsonb_build_object('tickets', m.n, 'matchId', m.match_id::text)     AS payload
      FROM (
        SELECT mt.id AS match_id,
               mt.home_team || ' vs ' || mt.away_team AS label,
               mt.scheduled_at,
               COUNT(DISTINCT t.id)::int AS n,
               SUM(t.potential_payout_micro)::bigint AS exposure
          FROM matches mt
          JOIN markets mk ON mk.match_id = mt.id
          JOIN ticket_selections ts ON ts.market_id = mk.id
          JOIN tickets t ON t.id = ts.ticket_id
         WHERE mt.status = 'closed'
           AND mt.scheduled_at IS NOT NULL
           AND mt.scheduled_at < NOW() - ${intervalOf(p.maxHours!, "hours")}
           AND t.status = 'accepted'
         GROUP BY mt.id, mt.home_team, mt.away_team, mt.scheduled_at
      ) m
    `,
  },
];

export const ALERT_RULE_BY_KIND: Record<string, AlertRuleDef> = Object.fromEntries(
  ALERT_RULES.map((r) => [r.kind, r]),
);

export function readParams(def: AlertRuleDef, stored: unknown): AlertParams {
  const out: AlertParams = { ...def.defaultParams };
  if (stored && typeof stored === "object") {
    for (const [k, v] of Object.entries(stored as Record<string, unknown>)) {
      const meta = def.paramMeta[k];
      const n = typeof v === "number" ? v : Number(v);
      if (!meta || !Number.isFinite(n)) continue;
      out[k] = Math.min(meta.max, Math.max(meta.min, n));
    }
  }
  return out;
}
