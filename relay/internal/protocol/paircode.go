package protocol

import (
	"crypto/rand"
	"fmt"
	"strings"
)

// crockfordAlphabet is Crockford Base32: the digits and the letters minus
// I, L, O and U. 32 symbols carry exactly 5 bits each.
const crockfordAlphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"

// pairCodeSymbols is 24 symbols — 120 bits of entropy, well above the "at least
// 10 characters" the requirement asks for, and far out of reach for guessing
// inside the code's 300 second life. Six groups of four, as §4.6's regex and
// its worked example both show (CRD 0004 settled this over the prose that
// said 20).
const pairCodeSymbols = 24

// pairCodeBytes supplies exactly 120 bits, which the top 120 bits become.
const pairCodeBytes = 15

// NewPairCode returns a fresh pairing code in the canonical grouped form of
// §4.6, e.g. K7QP-3MZD-9XTB-2RCV-6HNF-0JWS. The symbols come only from the
// cryptographic random source: never a clock, a counter, a device name or a
// session id.
func NewPairCode() (string, error) {
	buf := make([]byte, pairCodeBytes)
	if _, err := rand.Read(buf); err != nil {
		return "", fmt.Errorf("read random bytes: %w", err)
	}
	symbols := make([]byte, 0, pairCodeSymbols)
	bit := 0
	for i := 0; i < pairCodeSymbols; i++ {
		var v byte
		for b := 0; b < 5; b++ {
			idx := bit / 8
			shift := uint(7 - bit%8)
			v = v<<1 | (buf[idx]>>shift)&1
			bit++
		}
		symbols = append(symbols, crockfordAlphabet[v])
	}
	return CanonicalPairCode(string(symbols)), nil
}

// CanonicalPairCode groups the symbols as 4-4-4-4-4-4 with hyphens.
func CanonicalPairCode(symbols string) string {
	var b strings.Builder
	for i, r := range symbols {
		if i > 0 && i%4 == 0 {
			b.WriteByte('-')
		}
		b.WriteRune(r)
	}
	return b.String()
}

// NormalizePairCode applies §4.6's input rules: drop the separators, uppercase,
// and fold the Crockford aliases O->0, I/L->1, U->V. The result is valid only
// when it is exactly 24 symbols of the alphabet.
func NormalizePairCode(in string) (string, bool) {
	if len(in) < pairCodeSymbols || len(in) > 64 {
		return "", false
	}
	var b strings.Builder
	b.Grow(pairCodeSymbols)
	for _, r := range in {
		switch {
		case r == '-' || r == ' ':
			continue
		case r >= 'a' && r <= 'z':
			r = r - 'a' + 'A'
		}
		switch r {
		case 'O':
			r = '0'
		case 'I', 'L':
			r = '1'
		case 'U':
			r = 'V'
		}
		if !strings.ContainsRune(crockfordAlphabet, r) {
			return "", false
		}
		b.WriteRune(r)
	}
	out := b.String()
	if len(out) != pairCodeSymbols {
		return "", false
	}
	return out, true
}
