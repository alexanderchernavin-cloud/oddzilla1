package store

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// PushOutboxNotifyChannel is the Postgres NOTIFY channel the api service
// LISTENs on. Settlement fires one NOTIFY per chunk-commit so the worker
// drains the queue immediately instead of waiting for the next sweep tick.
const PushOutboxNotifyChannel = "push_outbox"

// BetWonPushPayload is the structured payload we hand to the api worker.
// The worker renders the title + body from these fields and dispatches
// via Firebase Admin SDK. We keep money fields as bigint micro strings
// for the same reason the WS frames do — JSON numbers lose precision
// past 2^53 and a high-stake combo payout can exceed that.
type BetWonPushPayload struct {
	Kind                string `json:"kind"`
	TicketID            string `json:"ticketId"`
	BetType             string `json:"betType"`
	Currency            string `json:"currency"`
	StakeMicro          string `json:"stakeMicro"`
	ActualPayoutMicro   string `json:"actualPayoutMicro"`
	PotentialPayoutMicro string `json:"potentialPayoutMicro"`
	NumLegs             int    `json:"numLegs"`
}

// EnqueueBetWonPush writes a row into push_notifications_outbox keyed by
// (kind='bet_won', ticket_id) so settlement replay is a no-op.
// Must run inside the same tx as SettleTicket so a rolled-back settle
// can't leave behind a phantom push intent.
//
// Returns nil on duplicate insert (replay) — the unique partial index
// turns it into a no-op which is exactly what we want. We surface real
// errors so the settle path can warn-log them.
func EnqueueBetWonPush(ctx context.Context, tx pgx.Tx, userID string, payload BetWonPushPayload) error {
	body, err := json.Marshal(payload)
	if err != nil {
		return fmt.Errorf("marshal push payload: %w", err)
	}
	_, err = tx.Exec(ctx, `
INSERT INTO push_notifications_outbox (user_id, kind, ticket_id, payload)
VALUES ($1, $2, $3::uuid, $4::jsonb)
ON CONFLICT (kind, ticket_id) WHERE ticket_id IS NOT NULL DO NOTHING`,
		userID, payload.Kind, payload.TicketID, string(body))
	if err != nil {
		return fmt.Errorf("insert push outbox: %w", err)
	}
	return nil
}

// NotifyPushOutbox fires pg_notify('push_outbox') so the api worker
// drains the queue immediately instead of waiting for its 30 s sweep.
// Best-effort: a failed notify just means the worker picks the row up
// on its next periodic sweep. Caller MUST invoke this AFTER the tx that
// wrote the outbox row commits — a NOTIFY inside the tx would race a
// subscriber that immediately reads back and sees no committed row.
func NotifyPushOutbox(ctx context.Context, pool *pgxpool.Pool) error {
	if _, err := pool.Exec(ctx, "NOTIFY "+PushOutboxNotifyChannel); err != nil {
		return fmt.Errorf("notify push outbox: %w", err)
	}
	return nil
}

// EnqueueBetWonBellNotification writes an in-app notification row to
// user_notifications for a winning ticket. Migration 0059 added
// bet_won to the notification_type enum so the bell can surface
// settlements on web, mirroring what the FCM outbox above does for
// mobile push.
//
// Must run inside the same tx as SettleTicket for the same atomicity
// reason as EnqueueBetWonPush — a rolled-back settle must not leave
// a stale bell entry behind.
//
// Pref gating is folded into the INSERT as a CTE rather than a
// separate SELECT to keep this to a single round-trip on the hot
// settle path:
//   * users.is_ai = TRUE → skip (mirrors SEC-C1 in the TS emit helper)
//   * user_preferences.pref_bet_settlements = FALSE → skip
//   * Missing user_preferences row → treated as default TRUE (matches
//     DEFAULT_PREFS in services/api/src/modules/community/notifications.ts)
//
// Apply-once for settlement replay: a 24h soft-dedup window on
// (user_id, type='bet_won', group_key='bet_won:<ticket_id>'). Hits
// the existing user_notifications_group_idx in one B-tree probe.
// Replays inside the window are no-ops; replays past the window
// could insert a duplicate row — same trade-off the rest of the
// emit helper accepts (no hard unique constraint on user_notifications
// by design — see 0044's preamble).
func EnqueueBetWonBellNotification(ctx context.Context, tx pgx.Tx, userID string, payload BetWonPushPayload) error {
	// Strip the `kind` field — it's redundant once the row's `type`
	// column carries the discriminator. The payload shape mirrors
	// BetWonPayload in packages/types/src/community.ts.
	body, err := json.Marshal(map[string]any{
		"ticketId":          payload.TicketID,
		"betType":           payload.BetType,
		"currency":          payload.Currency,
		"stakeMicro":        payload.StakeMicro,
		"actualPayoutMicro": payload.ActualPayoutMicro,
		"numLegs":           payload.NumLegs,
	})
	if err != nil {
		return fmt.Errorf("marshal bet_won bell payload: %w", err)
	}
	groupKey := fmt.Sprintf("bet_won:%s", payload.TicketID)
	_, err = tx.Exec(ctx, `
WITH gate AS (
  SELECT u.is_ai,
         COALESCE(p.pref_bet_settlements, TRUE) AS pref_on
    FROM users u
    LEFT JOIN user_preferences p ON p.user_id = u.id
   WHERE u.id = $1::uuid
)
INSERT INTO user_notifications (user_id, type, payload, group_key, deep_link)
SELECT $1::uuid, 'bet_won', $2::jsonb, $3, '/bets'
  FROM gate
 WHERE gate.is_ai = FALSE
   AND gate.pref_on = TRUE
   AND NOT EXISTS (
     SELECT 1 FROM user_notifications
      WHERE user_id = $1::uuid
        AND type = 'bet_won'
        AND group_key = $3
        AND created_at > now() - INTERVAL '24 hours'
   )`,
		userID, string(body), groupKey)
	if err != nil {
		return fmt.Errorf("insert bet_won notification: %w", err)
	}
	return nil
}
