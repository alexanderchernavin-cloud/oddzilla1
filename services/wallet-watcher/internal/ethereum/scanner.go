// Verifier — adapts the JSON-RPC client to the deposits.Verifier
// interface. Resolves a user-submitted tx hash, picks the matching
// USDC Transfer to the configured receive address, and reports the
// result so the processor can decide credit / reject / hold.

package ethereum

import (
	"context"
	"strings"

	"github.com/rs/zerolog"

	"github.com/oddzilla/wallet-watcher/internal/deposits"
)

type Verifier struct {
	client         *Client
	contract       string // lowercase
	receiveAddress string // lowercase
	confirmations  int
	log            zerolog.Logger
}

func NewVerifier(client *Client, contract, receiveAddress string, confirmations int, log zerolog.Logger) *Verifier {
	return &Verifier{
		client:         client,
		contract:       strings.ToLower(contract),
		receiveAddress: strings.ToLower(receiveAddress),
		confirmations:  confirmations,
		log:            log.With().Str("chain", "ERC20").Logger(),
	}
}

func (v *Verifier) HeadBlock(ctx context.Context) (int64, error) {
	return v.client.BlockNumber(ctx)
}

func (v *Verifier) Confirmations() int { return v.confirmations }

// Inspect implements deposits.Verifier.
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

	// Pick the first Transfer log that:
	//   - originates from our USDC contract
	//   - has `to` equal to the configured receive address
	//   - has a positive amount
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
		// USDC has 6 decimals — the raw amount is already in micro.
		if !amount.IsInt64() {
			// Astronomical transfer — surface a reject; this would
			// otherwise overflow our BIGINT column.
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
