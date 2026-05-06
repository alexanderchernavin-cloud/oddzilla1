// Run with: node generate_vectors.mjs
// Calls the existing TS hdwallet.ts derivation and prints a JSON
// table of (mnemonic, userIndex, eth, tron) tuples that the Go
// parity test in derive_test.go pins against. Re-run if either side
// changes derivation logic.
//
// Note: this is dev tooling, not part of the runtime. It imports
// from the api workspace; run from inside `services/api`:
//   cd services/api && node ../signer/internal/derive/generate_vectors.mjs

import {
  deriveEthereumAddress,
  deriveTronAddress,
} from "../../../api/src/lib/hdwallet.js";

// 12-word BIP39 phrase chosen from the official BIP39 test vectors.
// Public, never used on real chains. Anchors the parity test.
const MNEMONIC =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

const out = [];
for (const idx of [0, 1, 2, 7, 1234, 0x7fff_ffff]) {
  out.push({
    userIndex: idx,
    eth: deriveEthereumAddress(MNEMONIC, idx),
    tron: deriveTronAddress(MNEMONIC, idx),
  });
}
console.log(JSON.stringify({ mnemonic: MNEMONIC, vectors: out }, null, 2));
