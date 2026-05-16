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
