// Minimal Ethereum JSON-RPC client for wallet-watcher. We only call two
// methods: `eth_blockNumber` and `eth_getLogs`. Keeping it stdlib-only
// avoids the weight of the full go-ethereum dependency for a
// read-only scanner.

package ethereum

import (
	"bytes"
	"context"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"math/big"
	"net/http"
	"strings"
	"time"
)

// Transfer event sig: keccak256("Transfer(address,address,uint256)")
const TransferTopic = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef"

type Client struct {
	url  string
	http *http.Client
}

func NewClient(rpcURL string) *Client {
	return &Client{
		url: rpcURL,
		http: &http.Client{
			Timeout: 20 * time.Second,
		},
	}
}

type rpcReq struct {
	JSONRPC string `json:"jsonrpc"`
	ID      int    `json:"id"`
	Method  string `json:"method"`
	Params  any    `json:"params"`
}

type rpcResp[T any] struct {
	Result T `json:"result"`
	Error  *struct {
		Code    int    `json:"code"`
		Message string `json:"message"`
	} `json:"error"`
}

func (c *Client) call(ctx context.Context, method string, params any, out any) error {
	body, err := json.Marshal(rpcReq{JSONRPC: "2.0", ID: 1, Method: method, Params: params})
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.url, bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("User-Agent", "oddzilla-wallet-watcher/0.1")

	resp, err := c.http.Do(req)
	if err != nil {
		return fmt.Errorf("rpc %s: %w", method, err)
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(resp.Body)
	if err != nil {
		return err
	}
	if resp.StatusCode != 200 {
		return fmt.Errorf("rpc %s: http %d: %s", method, resp.StatusCode, string(raw))
	}

	// Unmarshal into a generic shape so we can surface the JSON-RPC
	// error field explicitly.
	var env struct {
		Result json.RawMessage `json:"result"`
		Error  *struct {
			Code    int    `json:"code"`
			Message string `json:"message"`
		} `json:"error"`
	}
	if err := json.Unmarshal(raw, &env); err != nil {
		return fmt.Errorf("rpc %s: parse: %w", method, err)
	}
	if env.Error != nil {
		return fmt.Errorf("rpc %s: %s (code %d)", method, env.Error.Message, env.Error.Code)
	}
	if out != nil {
		if err := json.Unmarshal(env.Result, out); err != nil {
			return fmt.Errorf("rpc %s: parse result: %w", method, err)
		}
	}
	return nil
}

// BlockNumber returns the latest head block.
func (c *Client) BlockNumber(ctx context.Context) (int64, error) {
	var hexStr string
	if err := c.call(ctx, "eth_blockNumber", []any{}, &hexStr); err != nil {
		return 0, err
	}
	return parseHexInt(hexStr)
}

// Log is a decoded Transfer event relevant to us.
type Log struct {
	TxHash      string
	LogIndex    int
	BlockNumber int64
	BlockHash   string // 0x-prefixed, lowercase
	From        string // 0x-prefixed, lowercase
	To          string // 0x-prefixed, lowercase
	Amount      *big.Int
}

type rawLog struct {
	Address     string   `json:"address"`
	Topics      []string `json:"topics"`
	Data        string   `json:"data"`
	BlockNumber string   `json:"blockNumber"`
	BlockHash   string   `json:"blockHash"`
	TxHash      string   `json:"transactionHash"`
	LogIndex    string   `json:"logIndex"`
	Removed     bool     `json:"removed"`
}

// GetUSDTLogs returns every Transfer log for the given USDT contract in
// block range [fromBlock, toBlock] (inclusive).
//
// Each row is double-checked against the contract address to defend
// against a malicious or buggy RPC endpoint returning logs from arbitrary
// contracts. A log with a missing 0x-prefixed Data is also rejected
// rather than silently parsed as zero — that pattern would advance the
// scanner cursor past a real Transfer with no credit.
func (c *Client) GetUSDTLogs(ctx context.Context, contract string, fromBlock, toBlock int64) ([]Log, error) {
	contractLower := strings.ToLower(contract)
	params := []any{
		map[string]any{
			"address":   contract,
			"topics":    []any{TransferTopic},
			"fromBlock": fmt.Sprintf("0x%x", fromBlock),
			"toBlock":   fmt.Sprintf("0x%x", toBlock),
		},
	}
	var raws []rawLog
	if err := c.call(ctx, "eth_getLogs", params, &raws); err != nil {
		return nil, err
	}
	out := make([]Log, 0, len(raws))
	for _, r := range raws {
		if r.Removed {
			continue
		}
		if len(r.Topics) < 3 {
			continue
		}
		// Defence against an RPC endpoint that ignores the address filter.
		if strings.ToLower(r.Address) != contractLower {
			return nil, fmt.Errorf("rpc returned log for wrong contract %q (expected %q)", r.Address, contractLower)
		}
		blockNumber, err := parseHexInt(r.BlockNumber)
		if err != nil {
			return nil, fmt.Errorf("decode blockNumber: %w", err)
		}
		logIndex, err := parseHexInt(r.LogIndex)
		if err != nil {
			return nil, fmt.Errorf("decode logIndex: %w", err)
		}
		// A Transfer log carries a 32-byte uint256 in `data`. Modern RPCs
		// always return the 0x prefix; treating the missing-prefix case as
		// "amount=0" (the previous behaviour) silently drops the row but
		// still advances the cursor — losing the deposit. Reject the
		// whole batch instead so the cursor stays put and the next tick
		// can retry.
		if !strings.HasPrefix(r.Data, "0x") {
			return nil, fmt.Errorf("log data missing 0x prefix: %q", r.Data)
		}
		amount := new(big.Int)
		if _, ok := amount.SetString(strings.TrimPrefix(r.Data, "0x"), 16); !ok {
			return nil, fmt.Errorf("decode log data: %q", r.Data)
		}
		from, to := topicToAddress(r.Topics[1]), topicToAddress(r.Topics[2])
		out = append(out, Log{
			TxHash:      strings.ToLower(r.TxHash),
			LogIndex:    int(logIndex),
			BlockNumber: blockNumber,
			BlockHash:   strings.ToLower(r.BlockHash),
			From:        from,
			To:          to,
			Amount:      amount,
		})
	}
	return out, nil
}

// BlockHashAt returns the canonical block hash for `blockNumber`. Used by
// the deposit processor to detect reorgs before crediting: if the stored
// block_hash differs from the current canonical chain's block_hash at
// the same height, the deposit's tx is no longer on-chain.
func (c *Client) BlockHashAt(ctx context.Context, blockNumber int64) (string, error) {
	var resp struct {
		Hash string `json:"hash"`
	}
	params := []any{fmt.Sprintf("0x%x", blockNumber), false}
	if err := c.call(ctx, "eth_getBlockByNumber", params, &resp); err != nil {
		return "", err
	}
	return strings.ToLower(resp.Hash), nil
}

// topicToAddress extracts a 0x-lowercase address from a 32-byte topic.
// Last 20 bytes = address.
func topicToAddress(topic string) string {
	hexPart := strings.TrimPrefix(topic, "0x")
	if len(hexPart) < 40 {
		return ""
	}
	return "0x" + strings.ToLower(hexPart[len(hexPart)-40:])
}

func parseHexInt(s string) (int64, error) {
	s = strings.TrimPrefix(s, "0x")
	if s == "" {
		return 0, nil
	}
	n := new(big.Int)
	if _, ok := n.SetString(s, 16); !ok {
		return 0, fmt.Errorf("invalid hex int: %q", s)
	}
	if !n.IsInt64() {
		return 0, fmt.Errorf("hex int overflow: %q", s)
	}
	return n.Int64(), nil
}

// Guard: keep hex import used even if bigint branch changes later.
var _ = hex.EncodeToString
