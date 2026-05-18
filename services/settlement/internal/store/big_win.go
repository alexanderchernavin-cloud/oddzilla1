package store

import (
	"context"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"
)

// BigWinFloorMicro returns the profit floor (in micro units) above which
// a winning ticket triggers the global Big Win fan-out notification.
// Currency-keyed for the same reason the storefront's
// BIG_WIN_PROFIT_MICRO map is (USDC ≈ EUR/USD value, OZ is a demo
// currency with a different scale story).
//
// Canonical source: services/api/src/modules/community/routes.ts. The
// Go side intentionally duplicates the constants rather than reading a
// shared config — both because settlement runs inside the same DB tx
// as the wallet update (a config-table round-trip here would extend
// the tx) and because the values rarely change. Migration 0067's
// preamble documents the lockstep rule with the TS source.
//
// V1 floors match the storefront feed floor: a win that clears the
// feed gate ALSO triggers the notification. As stake medians grow,
// PRD §"Volume reality check" anticipates retuning the notification
// floor 2-3× above the feed floor so the panel stays a "wow" surface.
// Returns 0 (i.e. always-qualifies) for unknown currencies — defensive
// posture; a fresh currency added on the storefront side without a
// corresponding update here should over-notify, not under-notify.
func BigWinFloorMicro(currency string) int64 {
	switch currency {
	case "USDC":
		return 50_000_000 // 50 USDC — matches BIG_WIN_PROFIT_MICRO.USDC
	case "OZ":
		return 25_000_000 // 25 OZ — matches BIG_WIN_PROFIT_MICRO.OZ
	default:
		return 0
	}
}

// BigWinFanoutArgs is the static slice of the per-row payload that
// EnqueueBigWinFanout marshals once per fan-out (one notification
// row per recipient gets the same JSON). bettorNickname is looked
// up from `users` server-side, so it doesn't appear here — keeping
// the Go-side struct tied to fields settler.go already knows.
type BigWinFanoutArgs struct {
	BettorUserID      string
	TicketID          string
	Currency          string
	StakeMicro        string
	ActualPayoutMicro string
}

// EnqueueBigWinFanout writes one user_notifications row per recipient
// for a single winning ticket that cleared the Big Win profit floor.
//
// Recipients are every authenticated, non-AI user EXCEPT the bettor
// themselves who:
//
//   • have pref_community_highlights ON (or default-true when the row
//     is missing — mirrors DEFAULT_PREFS in the TS emit helper); AND
//   • have not received a `big_win_landed` notification in the last
//     1 hour (per-viewer cool-down so a streak doesn't fire N times
//     in succession on the same panel).
//
// Bettor visibility gate: if the bettor's nickname is NULL or their
// tickets_public flag is FALSE, no fan-out runs. Their win wouldn't
// appear in the Big Wins feed under the same visibility rule, so
// surfacing them by name in a notification panel would leak a hidden
// profile. The check is a single roundtrip before the fan-out INSERT;
// a NULL/private bettor returns nil cleanly without inserting.
//
// One INSERT … SELECT … FROM users so a 1000-user fan-out is one
// query, not 1000. Hits user_notifications_group_idx for the cool-down
// NOT EXISTS probe — no new index needed.
//
// Best-effort: caller (settler.go) logs and continues on error per the
// same posture as EnqueueBetWonBellNotification. Apply-once for
// settlement replay piggybacks on the cool-down window — a re-settle
// inside an hour is a no-op; past an hour we'd over-notify, same
// trade-off the rest of the emit stack accepts.
func EnqueueBigWinFanout(ctx context.Context, tx pgx.Tx, args BigWinFanoutArgs) error {
	// 1. Bettor visibility gate.
	var nickname *string
	var ticketsPublic bool
	err := tx.QueryRow(ctx, `
SELECT nickname, tickets_public
  FROM users
 WHERE id = $1::uuid`, args.BettorUserID).Scan(&nickname, &ticketsPublic)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil // bettor missing — silently skip (shouldn't happen)
		}
		return fmt.Errorf("big_win_fanout: bettor lookup: %w", err)
	}
	if nickname == nil || *nickname == "" || !ticketsPublic {
		return nil // hidden bettor — no fan-out, mirrors feed visibility
	}

	// 2. Fan-out INSERT. Payload is built server-side via
	// jsonb_build_object so the bettor's nickname can be embedded
	// without round-tripping through Go.
	groupKey := fmt.Sprintf("big_win_landed:%s", args.TicketID)
	_, err = tx.Exec(ctx, `
INSERT INTO user_notifications (user_id, type, payload, group_key, deep_link)
SELECT
    u.id,
    'big_win_landed',
    jsonb_build_object(
        'ticketId',          $2::text,
        'actorNickname',    $3::text,
        'currency',          $4::text,
        'stakeMicro',        $5::text,
        'actualPayoutMicro', $6::text
    ),
    $7,
    '/community?tab=bigWins'
  FROM users u
  LEFT JOIN user_preferences p ON p.user_id = u.id
 WHERE u.id <> $1::uuid
   AND u.is_ai = FALSE
   AND COALESCE(p.pref_community_highlights, TRUE) = TRUE
   AND NOT EXISTS (
     SELECT 1 FROM user_notifications n
      WHERE n.user_id = u.id
        AND n.type = 'big_win_landed'
        AND n.created_at > now() - INTERVAL '1 hour'
   )`,
		args.BettorUserID,
		args.TicketID,
		*nickname,
		args.Currency,
		args.StakeMicro,
		args.ActualPayoutMicro,
		groupKey,
	)
	if err != nil {
		return fmt.Errorf("insert big_win fanout: %w", err)
	}
	return nil
}
