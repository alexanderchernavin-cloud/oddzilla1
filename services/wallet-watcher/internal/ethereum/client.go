// Minimal Ethereum JSON-RPC client for wallet-watcher. Post-0032 the
// service no longer scans block ranges — it resolves user-submitted tx
// hashes one at a time via eth_getTransactionReceipt. Three RPC calls
// suffice:
//   - eth_blockNumber       (head, for confirmation math)
//   - eth_getTransactionReceipt (status + logs for a known tx)
//   - eth_getBlockByNumber  (canonical block hash → reorg detection)

package ethereum

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"math/big"
	"net/http"
	"strings"
	"time"
)

// keccak256("Transfer(address,address,uint256)")
const TransferTopic = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef"

type Client struct {
	url  string
	http *http.Client
}

func NewClient(rpcURL string) *Client {
	return &Client{
		url:  rpcURL,
		http: &http.Client{Timeout: 20 * time.Second},
	}
}

func (c *Client) call(ctx context.Context, method string, params any, out any) error {
	body, err := json.Marshal(map[string]any{
		"jsonrpc": "2.0", "id": 1, "method": method, "params": params,
	})
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.url, bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("User-Agent", "oddzilla-wallet-watcher/0.2")

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
		// `null` is a valid result for "tx not found yet" on
		// eth_getTransactionReceipt — don't try to decode into a struct.
		if string(env.Result) == "null" {
			return nil
		}
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

// Receipt is the parsed shape of eth_getTransactionReceipt for the
// fields we care about.
type Receipt struct {
	Found       bool
	Status      string // "0x1" success, "0x0" reverted
	BlockNumber int64
	BlockHash   string
	Logs        []ReceiptLog
}

type ReceiptLog struct {
	Address  string
	Topics   []string
	Data     string
	LogIndex int
}

type rawReceipt struct {
	Status      string   `json:"status"`
	BlockNumber string   `json:"blockNumber"`
	BlockHash   string   `json:"blockHash"`
	Logs        []rawLog `json:"logs"`
}

type rawLog struct {
	Address     string   `json:"address"`
	Topics      []string `json:"topics"`
	Data        string   `json:"data"`
	LogIndex    string   `json:"logIndex"`
	Removed     bool     `json:"removed"`
	BlockNumber string   `json:"blockNumber"` // populated by eth_getLogs; absent on receipt logs
	BlockHash   string   `json:"blockHash"`
	TxHash      string   `json:"transactionHash"`
}

// TransactionReceipt resolves a tx hash. Returns Found=false (no error)
// when the node has no receipt yet. Caller must distinguish between
// "tx in mempool / fake hash" (Found=false) and "tx mined but reverted"
// (Found=true, Status="0x0").
func (c *Client) TransactionReceipt(ctx context.Context, txHash string) (Receipt, error) {
	var raw *rawReceipt
	if err := c.call(ctx, "eth_getTransactionReceipt", []any{txHash}, &raw); err != nil {
		return Receipt{}, err
	}
	if raw == nil {
		return Receipt{Found: false}, nil
	}
	bn, err := parseHexInt(raw.BlockNumber)
	if err != nil {
		return Receipt{}, fmt.Errorf("decode receipt blockNumber: %w", err)
	}
	logs := make([]ReceiptLog, 0, len(raw.Logs))
	for _, lg := range raw.Logs {
		if lg.Removed {
			continue
		}
		idx, err := parseHexInt(lg.LogIndex)
		if err != nil {
			return Receipt{}, fmt.Errorf("decode logIndex: %w", err)
		}
		logs = append(logs, ReceiptLog{
			Address:  strings.ToLower(lg.Address),
			Topics:   lg.Topics,
			Data:     lg.Data,
			LogIndex: int(idx),
		})
	}
	return Receipt{
		Found:       true,
		Status:      raw.Status,
		BlockNumber: bn,
		BlockHash:   strings.ToLower(raw.BlockHash),
		Logs:        logs,
	}, nil
}

// BlockHashAt returns the canonical block hash for `blockNumber`.
// Used to detect reorgs before crediting.
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

// TransferLog is one decoded Transfer event matching the discovery
// filter (USDC contract, recipient = receive address).
type TransferLog struct {
	TxHash      string
	LogIndex    int
	BlockNumber int64
	BlockHash   string
	From        string // 0x-lowercase
	To          string // 0x-lowercase (always equals receive address)
	Amount      *big.Int
}

// GetTransfersTo fetches all USDC `Transfer` logs whose `to` topic
// equals `receiveAddress`, in inclusive block range [fromBlock, toBlock].
// The recipient filter is applied server-side via topics[2] — Alchemy
// only returns matching logs, no client-side filtering bandwidth waste.
func (c *Client) GetTransfersTo(ctx context.Context, contract, receiveAddress string, fromBlock, toBlock int64) ([]TransferLog, error) {
	contractLower := strings.ToLower(contract)
	toTopic := padAddressTopic(receiveAddress)
	params := []any{
		map[string]any{
			"address":   contract,
			"topics":    []any{TransferTopic, nil, toTopic},
			"fromBlock": fmt.Sprintf("0x%x", fromBlock),
			"toBlock":   fmt.Sprintf("0x%x", toBlock),
		},
	}
	var raws []rawLog
	if err := c.call(ctx, "eth_getLogs", params, &raws); err != nil {
		return nil, err
	}
	out := make([]TransferLog, 0, len(raws))
	for _, r := range raws {
		if r.Removed {
			continue
		}
		if len(r.Topics) < 3 {
			continue
		}
		// Defence-in-depth: if the RPC ignored the address filter,
		// fail the batch rather than ingest cross-contract logs.
		if !strings.EqualFold(r.Address, contractLower) {
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
		if !strings.HasPrefix(r.Data, "0x") {
			return nil, fmt.Errorf("log data missing 0x prefix: %q", r.Data)
		}
		amount := new(big.Int)
		if _, ok := amount.SetString(strings.TrimPrefix(r.Data, "0x"), 16); !ok {
			return nil, fmt.Errorf("decode log data: %q", r.Data)
		}
		out = append(out, TransferLog{
			TxHash:      strings.ToLower(r.TxHash),
			LogIndex:    int(logIndex),
			BlockNumber: blockNumber,
			BlockHash:   strings.ToLower(r.BlockHash),
			From:        topicToAddress(r.Topics[1]),
			To:          topicToAddress(r.Topics[2]),
			Amount:      amount,
		})
	}
	return out, nil
}

// padAddressTopic encodes a 20-byte address as a 32-byte topic by
// left-padding with zeros — the form Ethereum uses for indexed
// `address` fields in event topics.
func padAddressTopic(addr string) string {
	hex := strings.TrimPrefix(strings.ToLower(addr), "0x")
	return "0x" + strings.Repeat("0", 64-len(hex)) + hex
}

// ParseTransferLog decodes a Transfer event log into (from, to, amount).
// Returns ok=false on any structural problem.
func ParseTransferLog(lg ReceiptLog) (from, to string, amount *big.Int, ok bool) {
	if len(lg.Topics) < 3 {
		return "", "", nil, false
	}
	if !strings.EqualFold(lg.Topics[0], TransferTopic) {
		return "", "", nil, false
	}
	if !strings.HasPrefix(lg.Data, "0x") {
		return "", "", nil, false
	}
	a := new(big.Int)
	if _, set := a.SetString(strings.TrimPrefix(lg.Data, "0x"), 16); !set {
		return "", "", nil, false
	}
	return topicToAddress(lg.Topics[1]), topicToAddress(lg.Topics[2]), a, true
}

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
