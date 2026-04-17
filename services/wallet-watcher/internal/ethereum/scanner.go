package ethereum

import (
	"context"
	"fmt"
	"time"

	"github.com/rs/zerolog"

	"github.com/oddzilla/wallet-watcher/internal/store"
)

// Scanner polls Ethereum for USDT Transfer logs and inserts matching
// deposits. Processing pending (confirmation progress + credit) lives
// in the deposits package so Tron + ETH share that loop.

type Scanner struct {
	client        *Client
	st            *store.Store
	contract      string
	maxRange      int
	confirmations int
	startBlock    int64
	log           zerolog.Logger
}

func NewScanner(client *Client, st *store.Store, contract string, maxRange, confirmations int, startBlock int64, log zerolog.Logger) *Scanner {
	return &Scanner{
		client:        client,
		st:            st,
		contract:      contract,
		maxRange:      maxRange,
		confirmations: confirmations,
		startBlock:    startBlock,
		log:           log.With().Str("chain", "ERC20").Logger(),
	}
}

// Tick scans one range worth of blocks. Returns the new cursor position.
// Called by the outer loop on every poll interval.
func (s *Scanner) Tick(ctx context.Context) error {
	latest, err := s.client.BlockNumber(ctx)
	if err != nil {
		return fmt.Errorf("block number: %w", err)
	}

	cursor, err := s.st.LastBlock(ctx, store.ChainERC20)
	if err != nil {
		return err
	}
	if cursor == 0 {
		// First-run bootstrap: use configured StartBlock or start at
		// head-minus-buffer so we don't try to replay Ethereum history.
		if s.startBlock > 0 {
			cursor = s.startBlock - 1
		} else {
			cursor = latest - 1
			if cursor < 0 {
				cursor = 0
			}
		}
		if err := s.st.BumpCursor(ctx, store.ChainERC20, cursor); err != nil {
			return err
		}
		s.log.Info().Int64("cursor", cursor).Msg("bootstrapped scanner cursor")
	}

	// Don't query beyond the safe block. We want confirmations to tick
	// naturally through the deposit-status transitions rather than
	// racing the scanner against reorgs.
	head := latest
	if head-cursor < 1 {
		return nil // caught up
	}

	toBlock := cursor + int64(s.maxRange)
	if toBlock > head {
		toBlock = head
	}
	fromBlock := cursor + 1

	logs, err := s.client.GetUSDTLogs(ctx, s.contract, fromBlock, toBlock)
	if err != nil {
		return fmt.Errorf("getLogs %d..%d: %w", fromBlock, toBlock, err)
	}

	if len(logs) > 0 {
		s.log.Debug().
			Int64("from", fromBlock).
			Int64("to", toBlock).
			Int("logs", len(logs)).
			Msg("transfer logs scanned")
	}

	inserted := 0
	for _, lg := range logs {
		userID, owner, err := s.st.AddressOwner(ctx, store.ChainERC20, lg.To)
		if err != nil {
			s.log.Warn().Err(err).Msg("address owner lookup")
			continue
		}
		if !owner {
			continue
		}
		// USDT has 6 decimals — the raw amount is already micro-USDT.
		if lg.Amount == nil || !lg.Amount.IsInt64() {
			s.log.Warn().Str("tx", lg.TxHash).Msg("amount overflow; skipping")
			continue
		}
		amount := lg.Amount.Int64()
		if amount <= 0 {
			continue
		}
		_, fresh, err := s.st.InsertSeen(ctx, store.DepositInsert{
			UserID:      userID,
			Chain:       store.ChainERC20,
			TxHash:      lg.TxHash,
			LogIndex:    lg.LogIndex,
			ToAddress:   lg.To,
			AmountMicro: amount,
			BlockNumber: lg.BlockNumber,
			SeenAt:      time.Now().UTC(),
		})
		if err != nil {
			s.log.Warn().Err(err).Str("tx", lg.TxHash).Msg("insert deposit")
			continue
		}
		if fresh {
			inserted++
		}
	}

	if err := s.st.BumpCursor(ctx, store.ChainERC20, toBlock); err != nil {
		return err
	}

	if inserted > 0 {
		s.log.Info().
			Int64("from", fromBlock).
			Int64("to", toBlock).
			Int("new_deposits", inserted).
			Msg("deposits observed")
	}
	return nil
}

// HeadBlock exposes the latest chain head for the deposit processor
// (it needs it to compute current confirmations).
func (s *Scanner) HeadBlock(ctx context.Context) (int64, error) {
	return s.client.BlockNumber(ctx)
}

// Confirmations returns the confirmation threshold this scanner uses.
func (s *Scanner) Confirmations() int { return s.confirmations }
