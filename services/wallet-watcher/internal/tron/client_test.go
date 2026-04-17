package tron

import "testing"

func TestNormalizeTronAddress(t *testing.T) {
	cases := []struct {
		in   string
		want string
	}{
		// Pre-known reference: hex 0x4118...x → T-prefixed Base58.
		// USDT contract address: TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t
		// Hex form: 41a614f803b6fd780986a42c78ec9c7f77e6ded13c
		{"41a614f803b6fd780986a42c78ec9c7f77e6ded13c", "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t"},
		{"0x41a614f803b6fd780986a42c78ec9c7f77e6ded13c", "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t"},
		// Already Base58
		{"TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t", "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t"},
		// Padded hex (Solidity ABI-style 32-byte left-padded address)
		{"000000000000000000000000a614f803b6fd780986a42c78ec9c7f77e6ded13c", "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t"},
	}
	for _, tc := range cases {
		got := normalizeTronAddress(tc.in)
		if got != tc.want {
			t.Fatalf("normalize(%q) = %q, want %q", tc.in, got, tc.want)
		}
	}
}
