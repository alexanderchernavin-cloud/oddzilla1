// Package currency maps deposit networks to the wallet currency they
// credit. Today only ERC20→USDC is wired; if a future network (e.g.
// TRC20-USDT) is added to the deposit_intents.network enum but not to
// this map, NetworkToCurrency fails fast instead of silently crediting
// USDC.
//
// Mirrors packages/types/src/networks.ts on the TS side — keep both in
// sync when a new on-chain network is supported.
package currency

import "fmt"

var networkCurrency = map[string]string{
	"ERC20": "USDC",
}

// NetworkToCurrency returns the wallet currency credited by deposits on
// the given network. Returns a non-nil error for unknown networks;
// callers MUST surface that error and never fall back to a default.
func NetworkToCurrency(network string) (string, error) {
	c, ok := networkCurrency[network]
	if !ok {
		return "", fmt.Errorf("unsupported deposit network: %q", network)
	}
	return c, nil
}
