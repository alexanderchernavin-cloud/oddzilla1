// ECDSA-secp256k1 signing of a 32-byte message hash.
//
// We deliberately do NOT take a tx body. The caller (the API in the
// withdrawal flow) builds the chain-specific encoding (RLP for ETH,
// protobuf raw_data for Tron), hashes it, and asks us to sign the
// hash. That keeps the signer chain-agnostic and stops it from
// becoming a code surface that has to track every EIP / Tron-protocol
// upgrade.
//
// Output shape: 65-byte compact signature `r||s||v` where v is the
// 0/1 recovery id. ETH callers add 27 (legacy) or chain_id*2+35+v
// (EIP-155); Tron callers use it as-is.

package sign

import (
	"errors"

	"github.com/btcsuite/btcd/btcec/v2"
	btcecdsa "github.com/btcsuite/btcd/btcec/v2/ecdsa"
)

// Hash signs a 32-byte hash with priv and returns the 65-byte
// `r || s || v` form. v is the 0/1 recovery id.
func Hash(priv *btcec.PrivateKey, hash32 []byte) ([]byte, error) {
	if len(hash32) != 32 {
		return nil, errors.New("hash must be exactly 32 bytes")
	}
	// SignCompact returns 65 bytes: [recoveryByte][r:32][s:32]. The
	// recoveryByte uses btcec's encoding (27 + recId, optionally + 4 if
	// the pubkey was compressed). We re-pack as r || s || v with v
	// reduced to {0,1} so the caller's chain-encoder doesn't have to
	// know btcec's history.
	compact := btcecdsa.SignCompact(priv, hash32, false)
	if len(compact) != 65 {
		return nil, errors.New("compact signature length mismatch")
	}
	recID := compact[0] - 27
	if recID >= 4 {
		recID -= 4 // strip the "compressed" flag if present
	}
	if recID > 1 {
		return nil, errors.New("invalid recovery id")
	}
	out := make([]byte, 65)
	copy(out[0:32], compact[1:33])  // r
	copy(out[32:64], compact[33:65]) // s
	out[64] = recID
	return out, nil
}
