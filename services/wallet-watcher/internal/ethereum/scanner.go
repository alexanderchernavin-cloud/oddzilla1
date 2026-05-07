// Verifier — adapts the JSON-RPC client to the deposits.Verifier
// interface. Two responsibilities:
//
//  1. Resolve a user-submitted tx hash, pick the matching USDC
//     Transfer to the configured receive address, and report the
//     result so the processor can decide credit / reject / hold.
//     This is the paste-hash flow's verification step.
//
//  2. Discover new Transfers TO the receive address whose `from` is
//     a registered user wallet — auto-creates a `confirming` intent
//     so the user doesn't have to paste the tx hash. The processor
//     then ticks confirmations on those rows like any other intent.

package ethereum

import (
	"context"
	"strings"

	"github.com/rs/zerolog"

	"github.com/oddzilla/wallet-watcher/internal/deposits"
	"github.com/oddzilla/wallet-watcher/internal/store"
)

type Verifier struct {
	client                 *Client
	st                     *store.Store
	contract               string // lowercase
	receiveAddress         string // lowercase
	confirmations          int
	discoveryMaxBlockRange int
	discoveryStartBlock    int64
	discoveryStartLookback int64
	log                    zerolog.Logger
}

func NewVerifier(
	client *Client,
	st *store.Store,
	contract, receiveAddress string,
	confirmations int,
	discoveryMaxBlockRange int,
	discoveryStartBlock, discoveryStartLookback int64,
	log zerolog.Logger,
) *Verifier {
	return &Verifier{
		client:                 client,
		st:                     st,
		contract:               strings.ToLower(contract),
		receiveAddress:         strings.ToLower(receiveAddress),
		confirmations:          confirmations,
		discoveryMaxBlockRange: discoveryMaxBlockRange,
		discoveryStartBlock:    discoveryStartBlock,
		discoveryStartLookback: discoveryStartLookback,
		log:                    log.With().Str("chain", "ERC20").Logger(),
	}
}

func (v *Verifier) HeadBlock(ctx context.Context) (int64, error) {
	return v.client.BlockNumber(ctx)
}

func (v *Verifier) Confirmations() int { return v.confirmations }

// Inspect implements deposits.Verifier — used by the paste-hash flow.
func (v *Verifier) Inspect(ctx context.Context, txHash string) (deposits.InspectResult, error) {
	r, err := v.client.TransactionReceipt(ctx, txHash)
	if err != nil {
		return deposits.InspectResult{}, err
	}
	if !r.Found {
		return deposits.InspectResult{Found: false}, nil
	}
	if r.Status == "0x0" {
		return deposits.InspectResult{Found: true, Reverted: true}, nil
	}

	for _, lg := range r.Logs {
		if lg.Address != v.contract {
			continue
		}
		from, to, amount, ok := ParseTransferLog(lg)
		if !ok {
			continue
		}
		if !strings.EqualFold(to, v.receiveAddress) {
			continue
		}
		if amount.Sign() <= 0 {
			continue
		}
		if !amount.IsInt64() {
			return deposits.InspectResult{Found: true, Match: false}, nil
		}
		return deposits.InspectResult{
			Found:       true,
			Match:       true,
			BlockNumber: r.BlockNumber,
			BlockHash:   r.BlockHash,
			LogIndex:    lg.LogIndex,
			From:        from,
			To:          to,
			AmountMicro: amount.Int64(),
		}, nil
	}
	return deposits.InspectResult{Found: true, Match: false}, nil
}

func (v *Verifier) BlockHashAt(ctx context.Context, blockNumber int64) (string, error) {
	return v.client.BlockHashAt(ctx, blockNumber)
}

// DiscoverIncoming polls eth_getLogs for new Transfers to the receive
// address since the last cursor, attributes them to users via the
// linked-wallet table, and inserts attributed rows as `confirming`
// intents. The processor's main loop then counts confirmations on
// those rows like any other intent.
//
// Bounded by discoveryMaxBlockRange per call so a long absence
// doesn't translate to an unbounded eth_getLogs request that the
// provider rejects.
func (v *Verifier) DiscoverIncoming(ctx context.Context) error {
	head, err := v.client.BlockNumber(ctx)
	if err != nil {
		return err
	}
	cursor, err := v.st.LastBlock(ctx, store.ChainERC20)
	if err != nil {
		return err
	}
	if cursor == 0 {
		// Bootstrap: pick a recent starting block so we don't try to
		// scan years of history. Operator can also pin via
		// ETH_DISCOVERY_START_BLOCK.
		if v.discoveryStartBlock > 0 {
			cursor = v.discoveryStartBlock - 1
		} else {
			cursor = head - v.discoveryStartLookback
			if cursor < 0 {
				cursor = 0
			}
		}
		if err := v.st.BumpCursor(ctx, store.ChainERC20, cursor); err != nil {
			return err
		}
		v.log.Info().Int64("cursor", cursor).Msg("bootstrapped discovery cursor")
	}

	if head <= cursor {
		return nil // caught up
	}

	fromBlock := cursor + 1
	toBlock := cursor + int64(v.discoveryMaxBlockRange)
	if toBlock > head {
		toBlock = head
	}

	logs, err := v.client.GetTransfersTo(ctx, v.contract, v.receiveAddress, fromBlock, toBlock)
	if err != nil {
		return err
	}

	attributed := 0
	for _, lg := range logs {
		if lg.Amount == nil || lg.Amount.Sign() <= 0 || !lg.Amount.IsInt64() {
			continue
		}
		userID, ok, err := v.st.LookupUserByWalletAddress(ctx, store.ChainERC20, lg.From)
		if err != nil {
			v.log.Warn().Err(err).Msg("lookup wallet address")
			continue
		}
		if !ok {
			// Sender not whitelisted — leave the deposit unattributed.
			// User can still paste the tx hash to claim it manually.
			continue
		}
		if err := v.st.InsertDiscoveredIntent(ctx, store.DiscoveredIntent{
			UserID:      userID,
			Network:     string(store.ChainERC20),
			TxHash:      lg.TxHash,
			From:        lg.From,
			To:          lg.To,
			AmountMicro: lg.Amount.Int64(),
			BlockNumber: lg.BlockNumber,
			BlockHash:   lg.BlockHash,
			LogIndex:    lg.LogIndex,
		}); err != nil {
			v.log.Warn().Err(err).Str("tx", lg.TxHash).Msg("insert discovered intent")
			continue
		}
		attributed++
	}

	if err := v.st.BumpCursor(ctx, store.ChainERC20, toBlock); err != nil {
		return err
	}

	if len(logs) > 0 || attributed > 0 {
		v.log.Info().
			Int64("from", fromBlock).
			Int64("to", toBlock).
			Int("transfers", len(logs)).
			Int("attributed", attributed).
			Msg("discovery scan complete")
	}
	return nil
}
