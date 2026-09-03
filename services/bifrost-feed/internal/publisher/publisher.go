// Redis Stream publisher. `oddin.backup` is the internal bus between this
// service and the two consumers (feed-ingester, settlement), each reading
// through its own consumer group. Redis Streams are the sanctioned
// internal bus (CLAUDE.md invariant 7): they do not drop on a slow
// consumer the way pub/sub does, and a consumer restart resumes from its
// group cursor.

package publisher

import (
	"context"
	"fmt"
	"sync/atomic"
	"time"

	"github.com/redis/go-redis/v9"
	"github.com/rs/zerolog"
)

const (
	// StreamName is shared with services/feed-ingester and
	// services/settlement (their internal/backupstream packages).
	StreamName = "oddin.backup"
	// MaxLenApprox bounds Redis memory. A full-catalogue re-snapshot is
	// ~1 entry per match (a few hundred); live traffic is a few entries
	// per second. 50k is many minutes of headroom for a stalled consumer.
	MaxLenApprox = 50_000
	// StatusKey is the hash the admin backoffice reads for the
	// "Backup feed" card. Refreshed every few seconds with a TTL so a
	// dead service reads as offline rather than frozen.
	StatusKey     = "bifrost:feed:status"
	statusTTL     = 120 * time.Second
	SourceBifrost = "bifrost"
)

// Publisher is what the runner writes through; the dry-run mode swaps in
// a logger so the translator can be exercised against live Bifrost data
// without Redis or Postgres.
type Publisher interface {
	Publish(ctx context.Context, kind, eventURN string, body []byte) error
	WriteStatus(ctx context.Context, fields map[string]any) error
}

type Redis struct {
	rdb       *redis.Client
	published atomic.Int64
	log       zerolog.Logger
}

func NewRedis(rdb *redis.Client, log zerolog.Logger) *Redis {
	return &Redis{rdb: rdb, log: log.With().Str("component", "publisher").Logger()}
}

// Publish appends one Oddin-shaped XML document to the stream.
func (p *Redis) Publish(ctx context.Context, kind, eventURN string, body []byte) error {
	if err := p.rdb.XAdd(ctx, &redis.XAddArgs{
		Stream: StreamName,
		MaxLen: MaxLenApprox,
		Approx: true,
		Values: map[string]any{
			"kind":      kind,
			"event_urn": eventURN,
			"source":    SourceBifrost,
			"ts":        time.Now().UnixMilli(),
			"body":      body,
		},
	}).Err(); err != nil {
		return fmt.Errorf("xadd %s: %w", StreamName, err)
	}
	p.published.Add(1)
	return nil
}

// Published is the lifetime count for health / status.
func (p *Redis) Published() int64 { return p.published.Load() }

// WriteStatus refreshes the admin-visible status hash.
func (p *Redis) WriteStatus(ctx context.Context, fields map[string]any) error {
	pipe := p.rdb.TxPipeline()
	pipe.HSet(ctx, StatusKey, fields)
	pipe.Expire(ctx, StatusKey, statusTTL)
	if _, err := pipe.Exec(ctx); err != nil {
		return fmt.Errorf("status hset: %w", err)
	}
	return nil
}

// DryRun logs instead of publishing. Used by `bifrost-feed -dry-run`.
type DryRun struct {
	log       zerolog.Logger
	published atomic.Int64
}

func NewDryRun(log zerolog.Logger) *DryRun {
	return &DryRun{log: log.With().Str("component", "publisher-dryrun").Logger()}
}

func (p *DryRun) Publish(_ context.Context, kind, eventURN string, body []byte) error {
	p.published.Add(1)
	preview := string(body)
	if len(preview) > 600 {
		preview = preview[:600] + "..."
	}
	p.log.Info().Str("kind", kind).Str("event", eventURN).Int("bytes", len(body)).Str("xml", preview).Msg("would publish")
	return nil
}

func (p *DryRun) Published() int64 { return p.published.Load() }

func (p *DryRun) WriteStatus(_ context.Context, _ map[string]any) error { return nil }
