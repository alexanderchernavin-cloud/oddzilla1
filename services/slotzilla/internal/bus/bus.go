// Redis adapter. Three surfaces, all caches or best-effort fan-out —
// never state (production Redis is allkeys-lru; the game's state lives in
// Postgres):
//
//   - PUBLISH odds:match:<id>   the public slotzilla_state frame, which
//     ws-gateway fans out to every browser subscribed to the match, plus
//     SET slotzilla:state:<id> (EX 120) so the api can serve GET state
//     without recomputing the windows.
//   - PUBLISH user:<id>         the per-bettor slotzilla_spin frame.
//   - HSET slotzilla:feed:status the backoffice health card.

package bus

import (
	"context"
	"fmt"
	"strconv"
	"time"

	"github.com/redis/go-redis/v9"
)

const (
	// StatusKey is the Redis hash /admin/slotzilla/status reads.
	StatusKey = "slotzilla:feed:status"
	statusTTL = 120 * time.Second

	stateKeyPrefix = "slotzilla:state:"
	stateTTL       = 120 * time.Second
)

type Bus struct {
	rdb *redis.Client
}

func New(rdb *redis.Client) *Bus {
	return &Bus{rdb: rdb}
}

// Ping is the health probe.
func (b *Bus) Ping(ctx context.Context) error {
	return b.rdb.Ping(ctx).Err()
}

// StateKey is the key the api reads for a match's current state.
func StateKey(matchID int64) string {
	return stateKeyPrefix + strconv.FormatInt(matchID, 10)
}

// PublishState fans the state frame out on the match channel and caches
// it for the api, in one round trip.
func (b *Bus) PublishState(ctx context.Context, matchID int64, payload []byte) error {
	pipe := b.rdb.TxPipeline()
	pipe.Publish(ctx, "odds:match:"+strconv.FormatInt(matchID, 10), payload)
	pipe.Set(ctx, StateKey(matchID), payload, stateTTL)
	if _, err := pipe.Exec(ctx); err != nil {
		return fmt.Errorf("publish state %d: %w", matchID, err)
	}
	return nil
}

// PublishSpin sends a spin frame to one bettor's sockets.
func (b *Bus) PublishSpin(ctx context.Context, userID string, payload []byte) error {
	if err := b.rdb.Publish(ctx, "user:"+userID, payload).Err(); err != nil {
		return fmt.Errorf("publish spin to %s: %w", userID, err)
	}
	return nil
}

// WriteStatus HSETs the status fields and refreshes the TTL in one
// transaction, so a dead service reads as offline rather than frozen.
func (b *Bus) WriteStatus(ctx context.Context, fields map[string]any) error {
	pipe := b.rdb.TxPipeline()
	pipe.HSet(ctx, StatusKey, fields)
	pipe.Expire(ctx, StatusKey, statusTTL)
	if _, err := pipe.Exec(ctx); err != nil {
		return fmt.Errorf("status hset: %w", err)
	}
	return nil
}
