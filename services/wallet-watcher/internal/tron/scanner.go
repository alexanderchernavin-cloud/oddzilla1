package tron

import (
	"context"
	"fmt"
	"time"

	"github.com/rs/zerolog"

	"github.com/oddzilla/wallet-watcher/internal/store"
)

// Scanner polls TronGrid for USDT Transfer events and inserts matching
// deposits. Tron's events API is timestamp-keyed, so we maintain a
// cursor in milliseconds (block_timestamp). The chain_scanner_state
// table stores it in `last_block_number` — the column is generic; we
// use it for whatever monotonic position the chain exposes.

type Scanner struct {
	client        *Client
	st            *store.Store
	contract      string
	maxRangeMs    int64 // window per tick in ms
	confirmations int
	startBlock    int64 // optional: ms timestamp to bootstrap from
	log           zerolog.Logger
}

func NewScanner(client *Client, st *store.Store, contract string, maxRangeBlocks, confirmations int, startBlock int64, log zerolog.Logger) *Scanner {
	// Tron blocks are 3s. Convert "max range in blocks" to a ms window
	// budget. Caller passed e.g. 50 → ~150 s window per tick.
	rangeMs := int64(maxRangeBlocks) * 3000
	if rangeMs <= 0 {
		rangeMs = 60_000
	}
	return &Scanner{
		client:        client,
		st:            st,
		contract:      contract,
		maxRangeMs:    rangeMs,
		confirmations: confirmations,
		startBlock:    startBlock,
		log:           log.With().Str("chain", "TRC20").Logger(),
	}
}

// Tick scans one window of events. The chain_scanner_state cursor here
// is `last_block_timestamp` in ms; on first run we bootstrap to "now"
// minus a small buffer so we don't replay all of TRC20 USDT history.
func (s *Scanner) Tick(ctx context.Context) error {
	cursor, err := s.st.LastBlock(ctx, store.ChainTRC20)
	if err != nil {
		return err
	}
	now := time.Now().UnixMilli()
	if cursor == 0 {
		// Bootstrap: start from configured timestamp (treat startBlock as
		// ms) or "now - 10 min".
		if s.startBlock > 0 {
			cursor = s.startBlock
		} else {
			cursor = now - 10*60*1000
		}
		if err := s.st.BumpCursor(ctx, store.ChainTRC20, cursor); err != nil {
			return err
		}
		s.log.Info().Int64("cursor_ms", cursor).Msg("bootstrapped scanner cursor")
	}

	// Don't query into the future. Leave a 30s settle window so events
	// have time to be confirmed before we count them.
	maxTs := now - 30_000
	if cursor >= maxTs {
		return nil
	}
	toTs := cursor + s.maxRangeMs
	if toTs > maxTs {
		toTs = maxTs
	}

	events, err := s.client.GetUSDTTransferEvents(ctx, s.contract, cursor+1, toTs, 200)
	if err != nil {
		return fmt.Errorf("get transfer events %d..%d: %w", cursor+1, toTs, err)
	}

	if len(events) > 0 {
		s.log.Debug().Int("events", len(events)).Int64("from_ms", cursor+1).Int64("to_ms", toTs).Msg("transfer events scanned")
	}

	inserted := 0
	maxBlock := int64(0)
	for _, ev := range events {
		userID, owner, err := s.st.AddressOwner(ctx, store.ChainTRC20, ev.To)
		if err != nil {
			s.log.Warn().Err(err).Msg("address owner lookup")
			continue
		}
		if !owner {
			continue
		}
		if ev.Value == nil || !ev.Value.IsInt64() {
			s.log.Warn().Str("tx", ev.TxID).Msg("amount overflow; skipping")
			continue
		}
		amount := ev.Value.Int64()
		if amount <= 0 {
			continue
		}
		_, fresh, err := s.st.InsertSeen(ctx, store.DepositInsert{
			UserID:      userID,
			Chain:       store.ChainTRC20,
			TxHash:      ev.TxID,
			LogIndex:    0, // TRC20 events don't have a per-tx log index in the same way
			ToAddress:   ev.To,
			AmountMicro: amount,
			BlockNumber: ev.BlockNumber,
			SeenAt:      time.UnixMilli(ev.BlockTime).UTC(),
		})
		if err != nil {
			s.log.Warn().Err(err).Str("tx", ev.TxID).Msg("insert deposit")
			continue
		}
		if fresh {
			inserted++
		}
		if ev.BlockNumber > maxBlock {
			maxBlock = ev.BlockNumber
		}
	}

	if err := s.st.BumpCursor(ctx, store.ChainTRC20, toTs); err != nil {
		return err
	}

	if inserted > 0 {
		s.log.Info().Int("new_deposits", inserted).Int64("max_block", maxBlock).Msg("deposits observed")
	}
	return nil
}

// HeadBlock returns the latest confirmed block height.
func (s *Scanner) HeadBlock(ctx context.Context) (int64, error) {
	return s.client.LatestBlock(ctx)
}

func (s *Scanner) Confirmations() int { return s.confirmations }
