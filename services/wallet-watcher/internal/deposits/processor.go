// Deposit processor — intent-driven (post-migration 0032).
//
// Loop: pull deposit_intents in {pending, confirming}, ask the verifier
// to look up the tx receipt, validate the Transfer event, count
// confirmations, and credit when the threshold is met. Reject when
// the on-chain truth says the user-submitted hash isn't valid.

package deposits

import (
	"context"
	"strings"
	"sync/atomic"

	"github.com/rs/zerolog"

	"github.com/oddzilla/wallet-watcher/internal/store"
)

// Verifier is what the processor needs from a chain client. The
// concrete impl lives in internal/ethereum.
type Verifier interface {
	HeadBlock(ctx context.Context) (int64, error)
	Confirmations() int
	// Inspect resolves the user-submitted tx hash on the canonical
	// chain. Possible outcomes encoded in InspectResult:
	//   • Found = false  → tx not yet on-chain (or fake hash)
	//   • Reverted = true → tx mined but reverted
	//   • Match = false  → tx exists but no matching Transfer to our
	//                       receive address from the configured contract
	//   • Match = true   → BlockNumber/BlockHash/LogIndex/From/Amount set
	Inspect(ctx context.Context, txHash string) (InspectResult, error)
	// BlockHashAt returns the canonical block hash at `blockNumber`,
	// used to detect reorgs between first sighting and credit.
	BlockHashAt(ctx context.Context, blockNumber int64) (string, error)
	// DiscoverIncoming polls fresh Transfer logs to the receive
	// address since the last cursor and inserts pre-attributed
	// `confirming` intents for senders on the linked-wallet
	// whitelist. No-op if no new blocks have arrived.
	DiscoverIncoming(ctx context.Context) error
}

// InspectResult is the verdict on one tx receipt.
//
// WrongToken is the "tx exists, hit our receive address, but the
// Transfer came from a non-USDC contract" verdict — the user sent the
// wrong coin. Surface the contract + raw amount so the admin can
// recognise what arrived (decimals aren't known here; admin UI looks
// them up). When set, Match is also false; the processor takes a
// dedicated rejection path that stamps the intent's diagnostic cols.
type InspectResult struct {
	Found       bool
	Reverted    bool
	Match       bool
	BlockNumber int64
	BlockHash   string
	LogIndex    int
	From        string
	To          string
	AmountMicro int64

	WrongToken          bool
	WrongTokenContract  string // 0x-lowercase
	WrongTokenAmountRaw string // decimal-string uint256
}

type Processor struct {
	st   *store.Store
	vfy  Verifier
	log  zerolog.Logger
	done int64
}

func New(st *store.Store, vfy Verifier, log zerolog.Logger) *Processor {
	return &Processor{
		st:  st,
		vfy: vfy,
		log: log.With().Str("component", "deposits").Logger(),
	}
}

func (p *Processor) Stats() int64 { return atomic.LoadInt64(&p.done) }

// Tick runs one full pass:
//
//  1. Discover new Transfers to the receive address from registered
//     wallets and insert pre-attributed `confirming` intents.
//  2. Walk pending+confirming intents — count confirmations, reorg-
//     verify at threshold, credit atomically.
//
// Step 1 is best-effort — discovery failure logs and proceeds to
// step 2 so a transient eth_getLogs hiccup doesn't stall pending
// credits.
func (p *Processor) Tick(ctx context.Context) error {
	if err := p.vfy.DiscoverIncoming(ctx); err != nil {
		p.log.Warn().Err(err).Msg("discovery tick failed (continuing to processor)")
	}

	head, err := p.vfy.HeadBlock(ctx)
	if err != nil {
		return err
	}
	threshold := p.vfy.Confirmations()

	intents, err := p.st.ListPendingIntents(ctx, 200)
	if err != nil {
		return err
	}

	for _, it := range intents {
		p.handleOne(ctx, it, head, threshold)
	}
	return nil
}

func (p *Processor) handleOne(ctx context.Context, it store.PendingIntent, head int64, threshold int) {
	res, err := p.vfy.Inspect(ctx, it.TxHash)
	if err != nil {
		// Transient RPC error — leave pending, retry next tick.
		p.log.Warn().Err(err).Str("intent", it.ID).Msg("inspect failed")
		return
	}

	if !res.Found {
		// Tx not on-chain yet. Could be still in mempool, could be a
		// typo / fake hash. Leave pending; an admin can reject manually
		// after enough time has passed.
		return
	}

	if res.Reverted {
		if err := p.st.RejectIntent(ctx, it.ID, "tx_reverted"); err != nil {
			p.log.Warn().Err(err).Str("intent", it.ID).Msg("reject (tx_reverted) failed; will retry next tick")
			return
		}
		p.log.Info().Str("intent", it.ID).Str("tx", it.TxHash).Msg("intent rejected: tx_reverted")
		return
	}

	if !res.Match {
		if res.WrongToken {
			if err := p.st.RejectIntentWrongToken(ctx, it.ID, res.WrongTokenContract, res.WrongTokenAmountRaw, res.From); err != nil {
				p.log.Warn().Err(err).Str("intent", it.ID).Msg("reject (wrong_token) failed; will retry next tick")
				return
			}
			p.log.Info().
				Str("intent", it.ID).
				Str("tx", it.TxHash).
				Str("token", res.WrongTokenContract).
				Str("amount_raw", res.WrongTokenAmountRaw).
				Msg("intent rejected: wrong_token")
			return
		}
		if err := p.st.RejectIntent(ctx, it.ID, "no_usdc_transfer_to_receive_address"); err != nil {
			p.log.Warn().Err(err).Str("intent", it.ID).Msg("reject (no_match) failed; will retry next tick")
			return
		}
		p.log.Info().
			Str("intent", it.ID).
			Str("tx", it.TxHash).
			Msg("intent rejected: no matching Transfer")
		return
	}

	confirmations := int(head - res.BlockNumber + 1)
	if confirmations < 0 {
		confirmations = 0
	}

	// First time we resolve this intent, persist the Transfer details.
	if it.Status == "pending" || it.BlockNumber == 0 {
		if err := p.st.MarkConfirming(ctx, it.ID, store.IntentReceipt{
			BlockNumber: res.BlockNumber,
			BlockHash:   res.BlockHash,
			LogIndex:    res.LogIndex,
			FromAddress: res.From,
			ToAddress:   res.To,
			AmountMicro: res.AmountMicro,
		}, confirmations); err != nil {
			p.log.Warn().Err(err).Str("intent", it.ID).Msg("mark confirming failed")
			return
		}
		// Reflect into local copy for downstream credit step.
		it.BlockNumber = res.BlockNumber
		it.BlockHash = res.BlockHash
		it.LogIndex = res.LogIndex
		it.FromAddress = res.From
		it.ToAddress = res.To
		it.AmountMicro = res.AmountMicro
		it.Status = "confirming"
	}

	if confirmations < threshold {
		if confirmations != it.Confirmations {
			if err := p.st.UpdateIntentConfirmations(ctx, it.ID, confirmations); err != nil {
				p.log.Warn().Err(err).Str("intent", it.ID).Msg("update confirmations failed; will retry next tick")
			}
		}
		return
	}

	// Reached threshold. Verify the block_hash is still on the canonical
	// chain — a reorg between sighting and now would otherwise credit
	// an orphaned tx.
	canonical, err := p.vfy.BlockHashAt(ctx, res.BlockNumber)
	if err != nil {
		p.log.Warn().Err(err).Str("intent", it.ID).Msg("reorg verify failed; will retry")
		return
	}
	if canonical == "" || !strings.EqualFold(canonical, res.BlockHash) {
		// Canonical chain doesn't carry this block any more. Leave the
		// intent in confirming; the verifier will re-inspect next tick
		// and either find the tx at a new block (re-included) or never
		// see it again. Operators can reject manually if it stays.
		p.log.Warn().
			Str("intent", it.ID).
			Str("recorded_hash", res.BlockHash).
			Str("canonical_hash", canonical).
			Int64("block", res.BlockNumber).
			Msg("reorg suspected; holding intent")
		return
	}

	if err := p.st.CreditIntent(ctx, it); err != nil {
		p.log.Error().Err(err).Str("intent", it.ID).Msg("credit failed")
		return
	}
	atomic.AddInt64(&p.done, 1)
	p.log.Info().
		Str("intent", it.ID).
		Str("user", it.UserID).
		Str("tx", it.TxHash).
		Int64("amount_micro", it.AmountMicro).
		Msg("deposit credited")
}
