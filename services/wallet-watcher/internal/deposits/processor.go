// Deposit processor.
//
// Responsibility split with the chain scanners:
//   • Scanner:   chain head → INSERT new deposits (status='seen').
//   • Processor: walk pending deposits → tick confirmations → credit.
//
// Confirmations come from `(currentHead - depositBlock) + 1`. Once that
// hits the per-chain threshold, the deposit is credited atomically:
//   UPDATE deposits SET status='credited', credited_at=NOW()
//   UPDATE wallets  SET balance_micro += amount
//   INSERT wallet_ledger (deposit, ref_id=deposit.id) — unique partial
//                       index on (type, ref_type, ref_id) is the
//                       last-resort double-credit guard.

package deposits

import (
	"context"
	"sync/atomic"

	"github.com/rs/zerolog"

	"github.com/oddzilla/wallet-watcher/internal/store"
)

// HeadProvider is what we need from a chain to tick confirmations.
type HeadProvider interface {
	HeadBlock(ctx context.Context) (int64, error)
	Confirmations() int
}

type Processor struct {
	st  *store.Store
	log zerolog.Logger

	credited int64
}

func New(st *store.Store, log zerolog.Logger) *Processor {
	return &Processor{
		st:  st,
		log: log.With().Str("component", "deposits").Logger(),
	}
}

func (p *Processor) Stats() int64 {
	return atomic.LoadInt64(&p.credited)
}

// TickChain processes pending deposits for a single chain.
func (p *Processor) TickChain(ctx context.Context, chain store.Chain, head HeadProvider) error {
	currentHead, err := head.HeadBlock(ctx)
	if err != nil {
		return err
	}
	threshold := head.Confirmations()

	pending, err := p.st.ListPending(ctx, chain, 200)
	if err != nil {
		return err
	}
	for _, d := range pending {
		// Skip rows the scanner inserted with no block number (shouldn't
		// happen for ETH; can happen briefly for TRC20 if event API
		// elides it — we'll re-evaluate on the next tick).
		if d.BlockNumber == 0 {
			continue
		}

		confirmations := int(currentHead - d.BlockNumber + 1)
		if confirmations < 0 {
			confirmations = 0
		}

		if confirmations < threshold {
			if confirmations != d.Confirmations {
				if err := p.st.UpdateConfirmations(ctx, d.ID, confirmations); err != nil {
					p.log.Warn().Err(err).Str("deposit", d.ID).Msg("update confirmations failed")
				}
			}
			continue
		}

		// Reached threshold. Credit + mark.
		if err := p.st.Credit(ctx, d); err != nil {
			p.log.Error().Err(err).Str("deposit", d.ID).Msg("credit failed")
			continue
		}
		atomic.AddInt64(&p.credited, 1)
		p.log.Info().
			Str("deposit", d.ID).
			Str("user", d.UserID).
			Str("chain", chain.String()).
			Str("tx", d.TxHash).
			Int64("amount_micro", d.AmountMicro).
			Msg("deposit credited")
	}
	return nil
}
