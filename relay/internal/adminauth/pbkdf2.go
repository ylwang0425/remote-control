// Package adminauth contains the relay's password verifier derivation used by
// local credential bootstrap and admin login.
package adminauth

import (
	"crypto/pbkdf2"
	"crypto/sha256"
	"errors"
)

// Iterations is deliberately fixed so a config cannot lower the login work
// factor. 310,000 SHA-256 HMAC rounds is above the requested 210,000 minimum.
const Iterations = 310_000

// Derive returns one 32-byte PBKDF2-HMAC-SHA256 block using Go's standard
// implementation. Invalid iteration counts are rejected by crypto/pbkdf2.
func Derive(password, salt []byte, iterations int) ([]byte, error) {
	if iterations < 1 {
		return nil, errors.New("PBKDF2 iteration count must be positive")
	}
	return pbkdf2.Key(sha256.New, string(password), salt, iterations, sha256.Size)
}
