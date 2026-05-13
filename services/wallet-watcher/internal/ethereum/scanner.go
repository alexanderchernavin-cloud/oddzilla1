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
	"sync"

	"github.com/rs/zerolog"

	"github.com/oddzilla/wallet-watcher/internal/deposits"
	"github.com/oddzilla/wallet-watcher/internal/store"
)

// tokenInfo is the cached eth_call result for an ERC20 token contract.
// Failed=true means we already tried symbol()+decimals() and at least
// one failed unrecoverably — don't keep hammering the RPC.
type tokenInfo struct {
	Symbol        string
	Decimals      int
	DecimalsKnown bool
	Failed        bool
}

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

	tokenCacheMu sync.Mutex
	tokenCache   map[string]tokenInfo
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
		tokenCache:             make(map[string]tokenInfo),
	}
}

func (v *Verifier) HeadBlock(ctx context.Context) (int64, error) {
	return v.client.BlockNumber(ctx)
}

func (v *Verifier) Confirmations() int { return v.confirmations }

// Inspect implements deposits.Verifier — used by the paste-hash flow.
//
// Two passes over the receipt's logs:
//
//  1. Legitimate USDC match: contract == configured USDC, recipient ==
//     receive address, positive amount that fits int64. Returns Match=true.
//
//  2. Wrong-token detection: ANY ERC20 Transfer to the receive address
//     from a contract OTHER than USDC. Surfaces the contract + raw
//     amount so the processor can stamp the intent with diagnostic
//     cols (failure_reason='wrong_token'). Returns Match=false +
//     WrongToken=true.
//
// If neither pass matches (tx hit the address via some other event /
// no Transfer at all), returns Found=true Match=false — the processor
// rejects with the generic "no_usdc_transfer_to_receive_address" reason.
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

	// Second pass: Transfer to receive address from a different ERC20
	// contract. The user clearly tried to deposit; they just sent the
	// wrong coin.
	for _, lg := range r.Logs {
		if strings.EqualFold(lg.Address, v.contract) {
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
		return deposits.InspectResult{
			Found:               true,
			Match:               false,
			WrongToken:          true,
			WrongTokenContract:  strings.ToLower(lg.Address),
			WrongTokenAmountRaw: amount.String(),
			From:                from,
			To:                  to,
		}, nil
	}

	return deposits.InspectResult{Found: true, Match: false}, nil
}

func (v *Verifier) BlockHashAt(ctx context.Context, blockNumber int64) (string, error) {
	return v.client.BlockHashAt(ctx, blockNumber)
}

// DiscoverIncoming runs both scans over the same block range:
//
//  1. USDC contract → recipient = receive address. Linked-wallet match
//     turns each Transfer into a `confirming` deposit_intent so the
//     user doesn't have to paste the tx hash.
//
//  2. ANY contract → recipient = receive address, contract != USDC.
//     These are wrong-token deposits — somebody sent USDT / DAI / random
//     ERC20 to our USDC-only address. Each gets a row in
//     unattributed_deposits (unless a deposit_intent already covers
//     the same tx) so the admin sees an alert and can refund manually.
//     Token symbol + decimals are best-effort eth_call enrichment;
//     unknown values are persisted as NULL and the UI degrades gracefully.
//
// Both scans share the cursor: it only advances after both succeed, so
// a transient failure in either re-runs the same range next tick
// (idempotent — the INSERTs are unique-key guarded).
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

	// ─── Scan 1: USDC contract → linked-wallet attribution ────────────
	usdcLogs, err := v.client.GetTransfersTo(ctx, v.contract, v.receiveAddress, fromBlock, toBlock)
	if err != nil {
		return err
	}
	attributed := 0
	for _, lg := range usdcLogs {
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

	// ─── Scan 2: any contract → receive address (wrong-token alerts) ──
	allLogs, err := v.client.GetAllTransfersTo(ctx, v.receiveAddress, fromBlock, toBlock)
	if err != nil {
		return err
	}
	wrongToken := 0
	for _, lg := range allLogs {
		if strings.EqualFold(lg.Contract, v.contract) {
			continue // legitimate USDC; handled by scan 1
		}
		if lg.Amount == nil || lg.Amount.Sign() <= 0 {
			continue
		}
		// Skip if a deposit_intent already represents this tx (user
		// pasted the hash and the inspect-path will tag it wrong_token).
		exists, err := v.st.HasDepositIntentFor(ctx, string(store.ChainERC20), lg.TxHash)
		if err != nil {
			v.log.Warn().Err(err).Str("tx", lg.TxHash).Msg("has intent check")
			continue
		}
		if exists {
			continue
		}
		info := v.tokenInfo(ctx, lg.Contract)
		if err := v.st.InsertUnattributedDeposit(ctx, store.UnattributedDeposit{
			Network:            string(store.ChainERC20),
			TxHash:             lg.TxHash,
			LogIndex:           lg.LogIndex,
			BlockNumber:        lg.BlockNumber,
			BlockHash:          lg.BlockHash,
			From:               lg.From,
			To:                 lg.To,
			TokenContract:      lg.Contract,
			TokenSymbol:        info.Symbol,
			TokenDecimals:      info.Decimals,
			TokenDecimalsKnown: info.DecimalsKnown,
			AmountRaw:          lg.Amount.String(),
		}); err != nil {
			v.log.Warn().Err(err).Str("tx", lg.TxHash).Msg("insert unattributed deposit")
			continue
		}
		wrongToken++
	}

	if err := v.st.BumpCursor(ctx, store.ChainERC20, toBlock); err != nil {
		return err
	}

	if len(usdcLogs) > 0 || len(allLogs) > 0 {
		v.log.Info().
			Int64("from", fromBlock).
			Int64("to", toBlock).
			Int("usdc_transfers", len(usdcLogs)).
			Int("attributed", attributed).
			Int("all_transfers", len(allLogs)).
			Int("wrong_token", wrongToken).
			Msg("discovery scan complete")
	}
	return nil
}

// tokenInfo returns cached symbol/decimals for an ERC20 contract,
// fetching once via eth_call on cache miss. A failure on either call
// is sticky (Failed=true) so the next scan over the same block range
// doesn't repeat the RPC for the same broken contract.
func (v *Verifier) tokenInfo(ctx context.Context, contract string) tokenInfo {
	key := strings.ToLower(contract)
	v.tokenCacheMu.Lock()
	if info, ok := v.tokenCache[key]; ok {
		v.tokenCacheMu.Unlock()
		return info
	}
	v.tokenCacheMu.Unlock()

	sym, errSym := v.client.TokenSymbol(ctx, key)
	dec, errDec := v.client.TokenDecimals(ctx, key)

	info := tokenInfo{}
	if errSym == nil {
		info.Symbol = sym
	}
	if errDec == nil {
		info.Decimals = dec
		info.DecimalsKnown = true
	}
	if errSym != nil && errDec != nil {
		info.Failed = true
		v.log.Warn().
			Err(errSym).
			AnErr("decimals_err", errDec).
			Str("contract", key).
			Msg("token metadata enrichment failed")
	}
	v.tokenCacheMu.Lock()
	v.tokenCache[key] = info
	v.tokenCacheMu.Unlock()
	return info
}
