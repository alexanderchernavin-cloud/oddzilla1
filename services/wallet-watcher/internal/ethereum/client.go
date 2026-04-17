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
	From        string // 0x-prefixed, lowercase
	To          string // 0x-prefixed, lowercase
	Amount      *big.Int
}

type rawLog struct {
	Address     string   `json:"address"`
	Topics      []string `json:"topics"`
	Data        string   `json:"data"`
	BlockNumber string   `json:"blockNumber"`
	TxHash      string   `json:"transactionHash"`
	LogIndex    string   `json:"logIndex"`
	Removed     bool     `json:"removed"`
}

// GetUSDTLogs returns every Transfer log for the given USDT contract in
// block range [fromBlock, toBlock] (inclusive).
func (c *Client) GetUSDTLogs(ctx context.Context, contract string, fromBlock, toBlock int64) ([]Log, error) {
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
		blockNumber, err := parseHexInt(r.BlockNumber)
		if err != nil {
			continue
		}
		logIndex, err := parseHexInt(r.LogIndex)
		if err != nil {
			continue
		}
		from, to := topicToAddress(r.Topics[1]), topicToAddress(r.Topics[2])
		amount := new(big.Int)
		if strings.HasPrefix(r.Data, "0x") {
			if _, ok := amount.SetString(strings.TrimPrefix(r.Data, "0x"), 16); !ok {
				continue
			}
		}
		out = append(out, Log{
			TxHash:      strings.ToLower(r.TxHash),
			LogIndex:    int(logIndex),
			BlockNumber: blockNumber,
			From:        from,
			To:          to,
			Amount:      amount,
		})
	}
	return out, nil
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
