// Maps a deposit network to the wallet currency it credits. Today only
// ERC20→USDC is wired; if a future network (e.g. TRC20-USDT) is added
// to the deposit_intents.network enum but not to this map, the credit
// path fails fast (via networkToCurrency returning undefined) instead
// of silently crediting USDC.

import type { Currency } from "./currencies.js";
import type { ChainNetwork } from "./wallet.js";

const NETWORK_CURRENCY: Record<ChainNetwork, Currency> = {
  ERC20: "USDC",
};

// Resolve the wallet currency for a deposit network. Returns undefined
// when the network is unknown — callers MUST treat that as a hard error
// (never default to USDC). Accepts a wider string so DB-typed enum
// values flow through without an extra cast on the caller side.
export function networkToCurrency(network: string): Currency | undefined {
  return NETWORK_CURRENCY[network as ChainNetwork];
}
