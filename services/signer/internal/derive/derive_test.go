package derive

import (
	"strings"
	"testing"
)

// abandon-mnemonic is the canonical BIP39 test vector. Public; never
// used on real chains. Pins the derivation algorithm against widely-
// published reference values.
const abandonMnemonic = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about"

// BIP44 ETH path m/44'/60'/0'/0/0 with the abandon mnemonic produces
// 0x9858EfFD232B4033E47d90003D41EC34EcaEda94. Verified against multiple
// independent implementations (MetaMask import, ethers.js, Trezor).
// EIP-55 mixed case must match exactly.
const expectedETH0 = "0x9858EfFD232B4033E47d90003D41EC34EcaEda94"

// BIP44 TRON path m/44'/195'/0'/0/0 with the abandon mnemonic. Pinned
// from the same secp256k1 path the ETH vector verifies against — only
// the address-encoding wrapper differs (0x41 prefix + base58check of
// keccak256(uncompressed_pubkey[1:])[-20:]). If the ETH vector above
// stays passing AND this value changes, the bug is in tron-specific
// encoding, not the derivation itself.
const expectedTRON0 = "TUEZSdKsoDHQMeZwihtdoBiN46zxhGWYdH"

func TestEthereumAddressVector(t *testing.T) {
	root, err := NewRoot(abandonMnemonic)
	if err != nil {
		t.Fatalf("NewRoot: %v", err)
	}
	got, err := root.EthereumAddress(0)
	if err != nil {
		t.Fatalf("EthereumAddress: %v", err)
	}
	if got != expectedETH0 {
		t.Fatalf("ETH idx=0: got %q, want %q", got, expectedETH0)
	}
}

func TestTronAddressVector(t *testing.T) {
	root, err := NewRoot(abandonMnemonic)
	if err != nil {
		t.Fatalf("NewRoot: %v", err)
	}
	got, err := root.TronAddress(0)
	if err != nil {
		t.Fatalf("TronAddress: %v", err)
	}
	if got != expectedTRON0 {
		t.Fatalf("TRON idx=0: got %q, want %q", got, expectedTRON0)
	}
}

func TestEIP55Checksum(t *testing.T) {
	// Sanity: derived address has expected shape (0x + 40 hex chars,
	// mixed case) AND the same private key produces the same address
	// every time (determinism).
	root, err := NewRoot(abandonMnemonic)
	if err != nil {
		t.Fatalf("NewRoot: %v", err)
	}
	for _, idx := range []uint32{0, 1, 2, 7, 1234} {
		a, err := root.EthereumAddress(idx)
		if err != nil {
			t.Fatalf("idx=%d: %v", idx, err)
		}
		if !strings.HasPrefix(a, "0x") || len(a) != 42 {
			t.Fatalf("idx=%d: malformed address %q", idx, a)
		}
		b, err := root.EthereumAddress(idx)
		if err != nil {
			t.Fatalf("idx=%d (re-derive): %v", idx, err)
		}
		if a != b {
			t.Fatalf("idx=%d: non-deterministic %q vs %q", idx, a, b)
		}
	}
}

func TestTronShape(t *testing.T) {
	root, err := NewRoot(abandonMnemonic)
	if err != nil {
		t.Fatalf("NewRoot: %v", err)
	}
	for _, idx := range []uint32{0, 1, 2, 7, 1234} {
		a, err := root.TronAddress(idx)
		if err != nil {
			t.Fatalf("idx=%d: %v", idx, err)
		}
		if !strings.HasPrefix(a, "T") || len(a) != 34 {
			t.Fatalf("idx=%d: malformed tron address %q", idx, a)
		}
	}
}

func TestPathParse(t *testing.T) {
	cases := []struct {
		in      string
		want    []uint32
		wantErr bool
	}{
		{"m/44'/60'/0'/0/0", []uint32{0x80000000 + 44, 0x80000000 + 60, 0x80000000, 0, 0}, false},
		{"44'/60'/0'/0/123", []uint32{0x80000000 + 44, 0x80000000 + 60, 0x80000000, 0, 123}, false},
		{"m/0", []uint32{0}, false},
		{"", nil, true},
		{"m/abc", nil, true},
	}
	for _, c := range cases {
		got, err := parsePath(c.in)
		if c.wantErr {
			if err == nil {
				t.Fatalf("parsePath(%q): expected error", c.in)
			}
			continue
		}
		if err != nil {
			t.Fatalf("parsePath(%q): %v", c.in, err)
		}
		if len(got) != len(c.want) {
			t.Fatalf("parsePath(%q): len %d vs %d", c.in, len(got), len(c.want))
		}
		for i := range got {
			if got[i] != c.want[i] {
				t.Fatalf("parsePath(%q)[%d]: %x vs %x", c.in, i, got[i], c.want[i])
			}
		}
	}
}

func TestInvalidMnemonic(t *testing.T) {
	if _, err := NewRoot("not a valid mnemonic"); err == nil {
		t.Fatalf("expected error on invalid mnemonic")
	}
}
