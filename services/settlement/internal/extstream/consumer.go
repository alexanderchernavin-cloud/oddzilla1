// Redis Streams consumer for provider-neutral settlement messages.
//
// Producers (today: services/fonbet-ingester) XADD one entry per market to
// `settlement.external` with these fields:
//
//	type               "settle" | "cancel"
//	provider           free-form tag for logs ("fonbet")
//	event_urn          matches.provider_urn ("fb:match:123")
//	provider_market_id markets.provider_market_id
//	specifiers         canonical "k=v|k=v" (sorted keys), "" for none
//	ts                 source timestamp, ms since epoch
//	outcomes           JSON array [{"id":"1","result":"1","void_factor":""}, ...]
//	                   result uses the Oddin wire encoding ("1" won, "0" lost),
//	                   void_factor "1" = void, "0.5" = half — mapOutcomeResult
//	                   is the single translator. Sorted by id.
//	start_ms / end_ms  optional cancel window (cancel only)
//
// Each entry is applied through Settler.ApplyExternalSettlement / Cancel and
// XACKed on success. Failures leave the entry pending; a claim loop
// re-delivers entries idle for longer than claimIdle so a transient DB
// error is retried instead of dropped. Apply-once inside the settler makes
// re-delivery safe.

package extstream

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"strconv"
	"time"

	"github.com/redis/go-redis/v9"
	"github.com/rs/zerolog"

	"github.com/oddzilla/settlement/internal/oddinxml"
	"github.com/oddzilla/settlement/internal/settler"
)

const (
	DefaultStream = "settlement.external"
	Group         = "settlement"
	batchSize     = 64
	blockPeriod   = 2 * time.Second
	claimIdle     = 60 * time.Second
	claimEvery    = 30 * time.Second
)

type outcomeJSON struct {
	ID         string `json:"id"`
	Result     string `json:"result"`
	VoidFactor string `json:"void_factor"`
}

type Consumer struct {
	rdb      *redis.Client
	stt      *settler.Settler
	stream   string
	consumer string
	log      zerolog.Logger
}

func New(rdb *redis.Client, stt *settler.Settler, stream string, log zerolog.Logger) *Consumer {
	if stream == "" {
		stream = DefaultStream
	}
	host, _ := os.Hostname()
	if host == "" {
		host = "settlement"
	}
	return &Consumer{rdb: rdb, stt: stt, stream: stream, consumer: host, log: log.With().Str("component", "extstream").Logger()}
}

// Run blocks until ctx is cancelled.
func (c *Consumer) Run(ctx context.Context) error {
	if err := c.rdb.XGroupCreateMkStream(ctx, c.stream, Group, "$").Err(); err != nil && !isBusyGroup(err) {
		return fmt.Errorf("create group: %w", err)
	}
	go c.claimLoop(ctx)
	c.log.Info().Str("stream", c.stream).Str("group", Group).Msg("external settlement consumer running")
	for {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		res, err := c.rdb.XReadGroup(ctx, &redis.XReadGroupArgs{
			Group: Group, Consumer: c.consumer, Streams: []string{c.stream, ">"}, Count: batchSize, Block: blockPeriod,
		}).Result()
		if err != nil {
			if errors.Is(err, redis.Nil) || errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
				continue
			}
			c.log.Warn().Err(err).Msg("XReadGroup error; backing off")
			select {
			case <-ctx.Done():
				return ctx.Err()
			case <-time.After(2 * time.Second):
			}
			continue
		}
		for _, stream := range res {
			c.handleMessages(ctx, stream.Messages)
		}
	}
}

func (c *Consumer) handleMessages(ctx context.Context, msgs []redis.XMessage) {
	for _, m := range msgs {
		if err := c.apply(ctx, m); err != nil {
			c.log.Warn().Err(err).Str("id", m.ID).Msg("external settlement failed; left pending for retry")
			continue
		}
		if err := c.rdb.XAck(ctx, c.stream, Group, m.ID).Err(); err != nil {
			c.log.Warn().Err(err).Str("id", m.ID).Msg("XAck failed")
		}
	}
}

// apply decodes one entry and routes it. Malformed entries are logged and
// treated as done (acked by the caller) — retrying cannot fix them.
func (c *Consumer) apply(ctx context.Context, m redis.XMessage) error {
	str := func(k string) string {
		if v, ok := m.Values[k].(string); ok {
			return v
		}
		return ""
	}
	kind := str("type")
	eventURN := str("event_urn")
	pmid, err := strconv.Atoi(str("provider_market_id"))
	if err != nil || eventURN == "" {
		c.log.Error().Interface("values", m.Values).Msg("malformed external settlement entry; dropping")
		return nil
	}
	ts, _ := strconv.ParseInt(str("ts"), 10, 64)
	if ts == 0 {
		ts = time.Now().UnixMilli()
	}
	market := oddinxml.Market{ID: pmid, Specifiers: str("specifiers")}
	if raw := str("outcomes"); raw != "" {
		var outs []outcomeJSON
		if err := json.Unmarshal([]byte(raw), &outs); err != nil {
			c.log.Error().Err(err).Str("id", m.ID).Msg("malformed outcomes JSON; dropping")
			return nil
		}
		for _, o := range outs {
			market.Outcomes = append(market.Outcomes, oddinxml.Outcome{ID: o.ID, Result: o.Result, VoidFactor: o.VoidFactor})
		}
	}
	switch kind {
	case "settle":
		if len(market.Outcomes) == 0 {
			c.log.Error().Str("id", m.ID).Msg("settle without outcomes; dropping")
			return nil
		}
		return c.stt.ApplyExternalSettlement(ctx, eventURN, ts, market)
	case "cancel":
		if v, err := strconv.ParseInt(str("start_ms"), 10, 64); err == nil && v > 0 {
			market.StartTime = &v
		}
		if v, err := strconv.ParseInt(str("end_ms"), 10, 64); err == nil && v > 0 {
			market.EndTime = &v
		}
		return c.stt.ApplyExternalCancel(ctx, eventURN, ts, market)
	default:
		c.log.Error().Str("type", kind).Str("id", m.ID).Msg("unknown external settlement type; dropping")
		return nil
	}
}

// claimLoop re-delivers entries another (or a crashed) consumer left
// pending for longer than claimIdle.
func (c *Consumer) claimLoop(ctx context.Context) {
	t := time.NewTicker(claimEvery)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			msgs, _, err := c.rdb.XAutoClaim(ctx, &redis.XAutoClaimArgs{
				Stream: c.stream, Group: Group, Consumer: c.consumer, MinIdle: claimIdle, Start: "0-0", Count: batchSize,
			}).Result()
			if err != nil {
				if !errors.Is(err, redis.Nil) {
					c.log.Debug().Err(err).Msg("XAutoClaim")
				}
				continue
			}
			if len(msgs) > 0 {
				c.log.Info().Int("count", len(msgs)).Msg("reclaimed pending external settlements")
				c.handleMessages(ctx, msgs)
			}
		}
	}
}

func isBusyGroup(err error) bool {
	return err != nil && len(err.Error()) >= 9 && err.Error()[:9] == "BUSYGROUP"
}
