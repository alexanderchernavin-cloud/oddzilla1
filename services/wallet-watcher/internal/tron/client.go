// Minimal TronGrid REST client. Two endpoints:
//   GET /walletsolidity/getnowblock              — latest confirmed block
//   GET /v1/contracts/{contract}/events          — Transfer events on a contract
//
// Tron addresses come over the API in a mix of formats. Our DB stores
// the Base58Check (T-prefixed) form. When events return hex, we convert.

package tron

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math/big"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

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

func (c *Client) get(ctx context.Context, path string, query url.Values, out any) error {
	u := c.url + path
	if query != nil {
		u += "?" + query.Encode()
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u, nil)
	if err != nil {
		return err
	}
	req.Header.Set("Accept", "application/json")
	req.Header.Set("User-Agent", "oddzilla-wallet-watcher/0.1")
	resp, err := c.http.Do(req)
	if err != nil {
		return fmt.Errorf("tron GET %s: %w", path, err)
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return err
	}
	if resp.StatusCode != 200 {
		return fmt.Errorf("tron GET %s: http %d: %s", path, resp.StatusCode, string(body))
	}
	if out != nil {
		if err := json.Unmarshal(body, out); err != nil {
			return fmt.Errorf("tron GET %s: parse: %w", path, err)
		}
	}
	return nil
}

// LatestBlock returns the latest confirmed block height.
func (c *Client) LatestBlock(ctx context.Context) (int64, error) {
	var resp struct {
		BlockHeader struct {
			RawData struct {
				Number int64 `json:"number"`
			} `json:"raw_data"`
		} `json:"block_header"`
	}
	if err := c.get(ctx, "/walletsolidity/getnowblock", nil, &resp); err != nil {
		return 0, err
	}
	if resp.BlockHeader.RawData.Number == 0 {
		return 0, errors.New("tron: empty block_header in response")
	}
	return resp.BlockHeader.RawData.Number, nil
}

// Event is a decoded TRC20 Transfer event relevant to us.
type Event struct {
	BlockNumber int64
	BlockTime   int64
	TxID        string
	EventIndex  int    // position of this event within the tx
	From        string // T-prefixed Base58Check
	To          string
	Value       *big.Int
}

type rawEvent struct {
	BlockNumber     int64                  `json:"block_number"`
	BlockTimestamp  int64                  `json:"block_timestamp"`
	TransactionID   string                 `json:"transaction_id"`
	EventName       string                 `json:"event_name"`
	EventIndex      int                    `json:"event_index"`
	ContractAddress string                 `json:"contract_address"`
	Result          map[string]interface{} `json:"result"`
}

type rawEventResp struct {
	Data []rawEvent `json:"data"`
	Meta struct {
		At      int64 `json:"at"`
		PageSize int  `json:"page_size"`
	} `json:"meta"`
}

// GetUSDTTransferEvents queries the contract events API for Transfer
// events between the two block timestamps (ms). TronGrid's events API
// is timestamp-based, not block-based — we map blocks to timestamps in
// the scanner.
func (c *Client) GetUSDTTransferEvents(ctx context.Context, contract string, minBlock, maxBlock int64, limit int) ([]Event, error) {
	q := url.Values{}
	q.Set("event_name", "Transfer")
	q.Set("only_confirmed", "true")
	q.Set("limit", strconv.Itoa(limit))
	q.Set("min_block_timestamp", strconv.FormatInt(minBlock, 10))
	q.Set("max_block_timestamp", strconv.FormatInt(maxBlock, 10))
	q.Set("order_by", "block_timestamp,asc")

	var resp rawEventResp
	path := "/v1/contracts/" + url.PathEscape(contract) + "/events"
	if err := c.get(ctx, path, q, &resp); err != nil {
		return nil, err
	}

	out := make([]Event, 0, len(resp.Data))
	// Per-tx event counter as a fallback when TronGrid omits event_index
	// (older API versions / partial responses). We still need a unique
	// (tx, index) pair per event so multiple Transfer events in one tx
	// don't collide on (network, tx_hash, log_index) at insert time.
	perTxFallback := make(map[string]int)
	for _, ev := range resp.Data {
		if ev.EventName != "Transfer" {
			continue
		}
		from, _ := stringField(ev.Result, "from")
		to, _ := stringField(ev.Result, "to")
		valueStr, _ := stringField(ev.Result, "value")
		if from == "" || to == "" || valueStr == "" {
			continue
		}
		v := new(big.Int)
		if _, ok := v.SetString(valueStr, 10); !ok {
			continue
		}
		fromNorm, ok1 := normalizeTronAddressOK(from)
		toNorm, ok2 := normalizeTronAddressOK(to)
		// A normalisation miss means the address shape is something we
		// don't understand. Surfacing this as an error stops the scanner
		// before it advances the cursor, so a deposit cannot be silently
		// dropped on the floor.
		if !ok1 || !ok2 {
			return nil, fmt.Errorf("unrecognised tron address from=%q to=%q (tx %s)", from, to, ev.TransactionID)
		}
		idx := ev.EventIndex
		if idx <= 0 {
			idx = perTxFallback[ev.TransactionID]
			perTxFallback[ev.TransactionID] = idx + 1
		}
		out = append(out, Event{
			BlockNumber: ev.BlockNumber,
			BlockTime:   ev.BlockTimestamp,
			TxID:        ev.TransactionID,
			EventIndex:  idx,
			From:        fromNorm,
			To:          toNorm,
			Value:       v,
		})
	}
	return out, nil
}

func stringField(m map[string]interface{}, key string) (string, bool) {
	v, ok := m[key]
	if !ok || v == nil {
		return "", false
	}
	switch x := v.(type) {
	case string:
		return x, true
	case float64:
		return strconv.FormatFloat(x, 'f', -1, 64), true
	}
	return "", false
}

// normalizeTronAddressOK converts whatever shape TronGrid returns into
// the Base58Check ("T...") form we store in deposit_addresses. Returns
// (address, true) on success or (raw, false) if the input doesn't match
// any known Tron address shape — callers MUST treat (_, false) as a
// hard error rather than silently using `raw`.
//
// Accepts:
//   • Already Base58: "T..." (33 chars after the prefix).
//   • Hex with 0x41 prefix: "41xxx..." (42 hex chars).
//   • Hex with 0x00..0x20 padding: 64 hex chars → strip the leading
//     zero-padding, prepend 0x41, Base58Check.
func normalizeTronAddressOK(raw string) (string, bool) {
	if strings.HasPrefix(raw, "T") && len(raw) == 34 {
		return raw, true
	}
	s := strings.TrimPrefix(raw, "0x")
	if len(s) == 42 && strings.HasPrefix(s, "41") {
		bytes, err := hex.DecodeString(s)
		if err != nil {
			return raw, false
		}
		return base58check(bytes), true
	}
	if len(s) == 64 {
		short := s[24:]
		bytes, err := hex.DecodeString("41" + short)
		if err != nil {
			return raw, false
		}
		return base58check(bytes), true
	}
	return raw, false
}

// normalizeTronAddress is retained as a thin wrapper for tests / external
// callers that don't care about the failure path.
func normalizeTronAddress(raw string) string {
	out, _ := normalizeTronAddressOK(raw)
	return out
}

func base58check(payload []byte) string {
	checksum := dsha256(payload)[:4]
	full := append(append([]byte{}, payload...), checksum...)
	return base58Encode(full)
}

func dsha256(b []byte) []byte {
	h1 := sha256.Sum256(b)
	h2 := sha256.Sum256(h1[:])
	return h2[:]
}

const base58Alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"

// base58Encode is the standard Bitcoin Base58 encoding.
func base58Encode(input []byte) string {
	if len(input) == 0 {
		return ""
	}
	zeros := 0
	for zeros < len(input) && input[zeros] == 0 {
		zeros++
	}
	x := new(big.Int).SetBytes(input)
	base := big.NewInt(58)
	mod := new(big.Int)
	out := make([]byte, 0, len(input)*138/100+1)
	for x.Sign() > 0 {
		x.DivMod(x, base, mod)
		out = append(out, base58Alphabet[mod.Int64()])
	}
	for i := 0; i < zeros; i++ {
		out = append(out, base58Alphabet[0])
	}
	// Reverse.
	for i, j := 0, len(out)-1; i < j; i, j = i+1, j-1 {
		out[i], out[j] = out[j], out[i]
	}
	return string(out)
}
