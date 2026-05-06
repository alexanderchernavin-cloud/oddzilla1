// BIP39 → BIP32 → BIP44 derivation.
//
// We expose three primitives:
//   • Root (one per mnemonic, cached): the BIP32 root extended key.
//   • Path-based child key derivation, returning an *btcec.PrivateKey.
//   • Chain-specific address encoding from a derived public key.
//
// The address-encoding output MUST stay byte-identical to the existing
// TS implementation in services/api/src/lib/hdwallet.ts. The parity
// test in derive_test.go pins this with a known mnemonic + a fixed set
// of indices.

package derive

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"math/big"
	"strconv"
	"strings"

	"github.com/btcsuite/btcd/btcec/v2"
	"github.com/tyler-smith/go-bip32"
	"github.com/tyler-smith/go-bip39"
	"golang.org/x/crypto/sha3"
)

// Root is a parsed BIP32 master key, derived once from the mnemonic.
type Root struct {
	master *bip32.Key
}

// NewRoot parses the mnemonic and computes the BIP32 master key.
// Empty passphrase per BIP39 default — same as the TS reference.
func NewRoot(mnemonic string) (*Root, error) {
	if !bip39.IsMnemonicValid(mnemonic) {
		return nil, errors.New("invalid BIP39 mnemonic")
	}
	seed := bip39.NewSeed(mnemonic, "")
	master, err := bip32.NewMasterKey(seed)
	if err != nil {
		return nil, fmt.Errorf("master key: %w", err)
	}
	return &Root{master: master}, nil
}

// PrivateKeyAt walks the root down a BIP32 path and returns the leaf
// private key as a btcec key (so the sign module can use it directly).
//
// Accepted path forms: "m/44'/60'/0'/0/N" (apostrophe = hardened) or
// the no-prefix variant "44'/60'/0'/0/N". Each apostrophe-marked segment
// adds the BIP32 hardened offset (0x80000000) to the index.
func (r *Root) PrivateKeyAt(path string) (*btcec.PrivateKey, error) {
	segs, err := parsePath(path)
	if err != nil {
		return nil, err
	}
	cur := r.master
	for _, seg := range segs {
		next, err := cur.NewChildKey(seg)
		if err != nil {
			return nil, fmt.Errorf("derive %x: %w", seg, err)
		}
		cur = next
	}
	priv, _ := btcec.PrivKeyFromBytes(cur.Key)
	return priv, nil
}

// EthereumAddress derives the address at `userIndex` under
// m/44'/60'/0'/0 and returns it EIP-55 checksummed.
func (r *Root) EthereumAddress(userIndex uint32) (string, error) {
	priv, err := r.PrivateKeyAt(fmt.Sprintf("m/44'/60'/0'/0/%d", userIndex))
	if err != nil {
		return "", err
	}
	return ethAddressFromPriv(priv), nil
}

// EthereumAddressFromPriv exposes the same encoding for use by the
// signer's HTTP handler when it wants to cross-check a sign call
// against the caller's expected from-address.
func EthereumAddressFromPriv(priv *btcec.PrivateKey) string {
	return ethAddressFromPriv(priv)
}

// TronAddress derives the address at `userIndex` under m/44'/195'/0'/0
// and returns the Base58Check T-prefixed form.
func (r *Root) TronAddress(userIndex uint32) (string, error) {
	priv, err := r.PrivateKeyAt(fmt.Sprintf("m/44'/195'/0'/0/%d", userIndex))
	if err != nil {
		return "", err
	}
	return tronAddressFromPriv(priv), nil
}

// PathFor returns the BIP44 path for a user index on a given network.
// Mirrors derivationPath() in the TS reference.
func PathFor(network string, userIndex uint32) (string, error) {
	switch network {
	case "ERC20":
		return fmt.Sprintf("m/44'/60'/0'/0/%d", userIndex), nil
	case "TRC20":
		return fmt.Sprintf("m/44'/195'/0'/0/%d", userIndex), nil
	default:
		return "", fmt.Errorf("unknown network %q", network)
	}
}

// ─── Internals ────────────────────────────────────────────────────────────

func parsePath(p string) ([]uint32, error) {
	p = strings.TrimSpace(p)
	if p == "" {
		return nil, errors.New("empty path")
	}
	if strings.HasPrefix(p, "m/") {
		p = p[2:]
	} else if p == "m" {
		return nil, nil
	}
	parts := strings.Split(p, "/")
	out := make([]uint32, 0, len(parts))
	for _, part := range parts {
		if part == "" {
			return nil, fmt.Errorf("empty segment in path")
		}
		hardened := strings.HasSuffix(part, "'") || strings.HasSuffix(part, "h")
		numStr := strings.TrimRight(part, "'h")
		n, err := strconv.ParseUint(numStr, 10, 32)
		if err != nil {
			return nil, fmt.Errorf("bad segment %q: %w", part, err)
		}
		idx := uint32(n)
		if hardened {
			idx += 0x80000000
		}
		out = append(out, idx)
	}
	return out, nil
}

func ethAddressFromPriv(priv *btcec.PrivateKey) string {
	uncompressed := priv.PubKey().SerializeUncompressed() // 65 bytes, leading 0x04
	hash := keccak256(uncompressed[1:])
	addr20 := hash[12:]
	return "0x" + eip55Checksum(addr20)
}

func tronAddressFromPriv(priv *btcec.PrivateKey) string {
	uncompressed := priv.PubKey().SerializeUncompressed()
	hash := keccak256(uncompressed[1:])
	body := append([]byte{0x41}, hash[12:]...)
	return base58check(body)
}

func keccak256(data []byte) []byte {
	h := sha3.NewLegacyKeccak256()
	h.Write(data)
	return h.Sum(nil)
}

func eip55Checksum(addr []byte) string {
	lower := hex.EncodeToString(addr)
	hash := keccak256([]byte(lower))
	out := make([]byte, len(lower))
	for i := 0; i < len(lower); i++ {
		c := lower[i]
		if c >= '0' && c <= '9' {
			out[i] = c
			continue
		}
		// Hex letter — uppercase if the high or low nibble of the
		// keccak256(lowercase address) at this position is >= 8.
		nibble := hash[i/2]
		if i%2 == 0 {
			nibble >>= 4
		} else {
			nibble &= 0x0f
		}
		if nibble >= 8 {
			out[i] = c - 32 // tolower→toupper for ASCII a-f
		} else {
			out[i] = c
		}
	}
	return string(out)
}

func sha256d(b []byte) []byte {
	h1 := sha256.Sum256(b)
	h2 := sha256.Sum256(h1[:])
	return h2[:]
}

func base58check(payload []byte) string {
	checksum := sha256d(payload)[:4]
	full := append(append([]byte{}, payload...), checksum...)
	return base58Encode(full)
}

const base58Alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"

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
	for i, j := 0, len(out)-1; i < j; i, j = i+1, j-1 {
		out[i], out[j] = out[j], out[i]
	}
	return string(out)
}
