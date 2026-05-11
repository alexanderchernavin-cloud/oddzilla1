// replay-settle is a one-shot CLI for replaying a stored bet_settlement /
// bet_cancel / rollback_* message from the feed_messages audit log back
// through the settler. Built for operational recovery when an unacked
// AMQP message is lost due to a worker restart (auto-delete queue
// destroys un-acked deliveries when the consumer disconnects).
//
// Usage:
//   replay-settle -message-id 12345
//   replay-settle -match-id 627077 -kind bet_settlement -market 1
//
// With -match-id+-kind+-market, replays the MOST RECENT matching
// feed_messages row whose payload contains <market id="..."  for that
// market. With -message-id, replays that exact row.
//
// Dispatch goes through settler.Handle exactly like a live AMQP delivery,
// so the existing apply-once contract (settlements unique key + ledger
// unique partial index + per-ticket SKIP LOCKED + status filter) makes
// the operation safe to re-run.

package main

import (
	"context"
	"flag"
	"fmt"
	"os"
	"os/signal"
	"strings"
	"syscall"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/redis/go-redis/v9"
	"github.com/rs/zerolog"

	"github.com/oddzilla/settlement/internal/config"
	"github.com/oddzilla/settlement/internal/settler"
	"github.com/oddzilla/settlement/internal/store"
)

func main() {
	var (
		messageID = flag.Int64("message-id", 0, "Exact feed_messages.id to replay (takes precedence)")
		matchID   = flag.Int64("match-id", 0, "Filter by match_id (used with -kind / -market)")
		kind      = flag.String("kind", "bet_settlement", "Message kind (bet_settlement / bet_cancel / rollback_bet_settlement / rollback_bet_cancel)")
		market    = flag.Int("market", 0, "provider_market_id to find in the payload (e.g. 1 for match-winner)")
	)
	flag.Parse()

	logger := zerolog.New(os.Stderr).With().Str("service", "replay-settle").Timestamp().Logger()

	if *messageID == 0 && *matchID == 0 {
		logger.Fatal().Msg("provide -message-id OR -match-id (+ -kind / -market)")
	}

	cfg, err := config.Load()
	if err != nil {
		logger.Fatal().Err(err).Msg("config")
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)
	go func() { <-sigCh; cancel() }()

	pool, err := pgxpool.New(ctx, cfg.DatabaseURL)
	if err != nil {
		logger.Fatal().Err(err).Msg("postgres pool")
	}
	defer pool.Close()
	if err := pool.Ping(ctx); err != nil {
		logger.Fatal().Err(err).Msg("postgres ping")
	}

	ropts, err := redis.ParseURL(cfg.RedisURL)
	if err != nil {
		logger.Fatal().Err(err).Msg("redis url")
	}
	rdb := redis.NewClient(ropts)
	defer rdb.Close()
	if err := rdb.Ping(ctx).Err(); err != nil {
		logger.Fatal().Err(err).Msg("redis ping")
	}

	st := store.New(pool)
	stt := settler.New(st, rdb, cfg.RollbackBatchSize, cfg.WorkerCount, logger)

	type row struct {
		ID         int64
		RoutingKey string
		Kind       string
		PayloadXML string
		MatchID    *int64
	}
	var r row

	if *messageID > 0 {
		err = pool.QueryRow(ctx, `
			SELECT id, routing_key, kind, payload_xml, match_id
			  FROM feed_messages
			 WHERE id = $1
			 LIMIT 1`, *messageID).Scan(&r.ID, &r.RoutingKey, &r.Kind, &r.PayloadXML, &r.MatchID)
	} else {
		// Build a LIKE filter on the market id in the payload XML. Match
		// against `<market id="N" ` to avoid catching outcome id="N".
		marketFilter := "%"
		if *market > 0 {
			marketFilter = fmt.Sprintf(`%%<market id="%d" %%`, *market)
		}
		err = pool.QueryRow(ctx, `
			SELECT id, routing_key, kind, payload_xml, match_id
			  FROM feed_messages
			 WHERE match_id = $1
			   AND kind = $2
			   AND payload_xml LIKE $3
			 ORDER BY received_at DESC
			 LIMIT 1`, *matchID, *kind, marketFilter).Scan(&r.ID, &r.RoutingKey, &r.Kind, &r.PayloadXML, &r.MatchID)
	}
	if err != nil {
		logger.Fatal().Err(err).Msg("lookup feed_message")
	}

	logger.Info().
		Int64("id", r.ID).
		Str("kind", r.Kind).
		Str("routing_key", r.RoutingKey).
		Int("payload_len", len(r.PayloadXML)).
		Msg("replaying feed_message via settler.Handle")

	// Trim leading whitespace/UTF-8 BOM in case the payload was stored
	// from a different decoder. PeekKind tolerates it but be explicit.
	body := []byte(strings.TrimSpace(r.PayloadXML))
	if err := stt.Handle(ctx, r.RoutingKey, body); err != nil {
		logger.Fatal().Err(err).Msg("handle returned error")
	}

	settled, cancelled, rolledBack, skipped, errs := stt.Stats()
	logger.Info().
		Int64("settled", settled).
		Int64("cancelled", cancelled).
		Int64("rolledBack", rolledBack).
		Int64("skipped", skipped).
		Int64("errors", errs).
		Msg("replay complete")
}
