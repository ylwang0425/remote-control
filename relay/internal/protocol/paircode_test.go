package protocol

import (
	"regexp"
	"strings"
	"testing"
)

// canonicalPairCode is the exact form protocol-v1 §4.6 pins.
var canonicalPairCode = regexp.MustCompile(`^[0-9A-HJKMNP-TV-Z]{4}(-[0-9A-HJKMNP-TV-Z]{4}){5}$`)

// TestNewPairCodeCanonicalForm covers §4.6: 24 Crockford Base32 characters in
// six groups of four, drawn from a cryptographic source, never a timestamp,
// a counter or a session id. (CRD 0004 settled the 24 the regex and the worked
// example both show, over the prose that said 20.)
func TestNewPairCodeCanonicalForm(t *testing.T) {
	seen := make(map[string]bool)
	for i := 0; i < 200; i++ {
		code, err := NewPairCode()
		if err != nil {
			t.Fatalf("NewPairCode returned error: %v", err)
		}
		if !canonicalPairCode.MatchString(code) {
			t.Fatalf("NewPairCode() = %q, want the canonical grouped form", code)
		}
		if len(code) != 29 {
			t.Fatalf("NewPairCode() has length %d, want 29 (24 symbols + 5 hyphens)", len(code))
		}
		if seen[code] {
			t.Fatalf("NewPairCode() repeated %q within 200 draws", code)
		}
		seen[code] = true
	}
}

// TestNormalizePairCode covers §4.6's input rules: drop every hyphen, uppercase,
// and apply the Crockford aliases O->0, I/L->1, U->V. Anything left that is not
// exactly 24 characters of the alphabet is not a pairing code at all.
func TestNormalizePairCode(t *testing.T) {
	ok := []struct {
		in   string
		want string
	}{
		{"K7QP-3MZD-9XTB-2RCV-6HNF-0JWS", "K7QP3MZD9XTB2RCV6HNF0JWS"},
		{"k7qp-3mzd-9xtb-2rcv-6hnf-0jws", "K7QP3MZD9XTB2RCV6HNF0JWS"},
		{"K7QP 3MZD 9XTB 2RCV 6HNF 0JWS", "K7QP3MZD9XTB2RCV6HNF0JWS"},
		{"K7QP3MZD9XTB2RCV6HNF0JWS", "K7QP3MZD9XTB2RCV6HNF0JWS"},
		{"OOOO-OOOO-OOOO-OOOO-OOOO-OOOO", strings.Repeat("0", 24)},
		{"IIII-LLLL-IIII-LLLL-IIII-LLLL", strings.Repeat("1", 24)},
		{"UUUU-UUUU-UUUU-UUUU-UUUU-UUUU", strings.Repeat("V", 24)},
	}
	for _, tc := range ok {
		got, valid := NormalizePairCode(tc.in)
		if !valid {
			t.Errorf("NormalizePairCode(%q) reported invalid, want valid", tc.in)
			continue
		}
		if got != tc.want {
			t.Errorf("NormalizePairCode(%q) = %q, want %q", tc.in, got, tc.want)
		}
	}

	bad := []string{
		"",
		"K7QP-3MZD-9XTB-2RCV-6HNF-0JW",   // 19 characters
		"K7QP-3MZD-9XTB-2RCV-6HNF-0JWSX", // 21 characters
		"K7QP-3MZD-9XTB-2RCV-6HNF-0JW!",  // character outside the alphabet
		"K7QP-3MZD-9XTB-2RCV-6HNF-0JW\u0000",
	}
	for _, in := range bad {
		if got, valid := NormalizePairCode(in); valid {
			t.Errorf("NormalizePairCode(%q) = %q, valid; want invalid", in, got)
		}
	}
}
