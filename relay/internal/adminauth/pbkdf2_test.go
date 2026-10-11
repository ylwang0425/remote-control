package adminauth

import (
	"encoding/hex"
	"testing"
)

func TestDeriveMatchesPBKDF2HMACSHA256Vector(t *testing.T) {
	derived, err := Derive([]byte("password"), []byte("salt"), 1)
	if err != nil {
		t.Fatal(err)
	}
	got := hex.EncodeToString(derived)
	const want = "120fb6cffcf8b32c43e7225256c4f837a86548c92ccc35480805987cb70be17b"
	if got != want {
		t.Fatalf("Derive() = %s, want %s", got, want)
	}
	if Iterations < 210_000 {
		t.Fatalf("admin KDF iteration count = %d, want at least 210000", Iterations)
	}
}

func TestDeriveRejectsInvalidIterations(t *testing.T) {
	if _, err := Derive([]byte("password"), []byte("salt"), 0); err == nil {
		t.Fatal("Derive accepted an invalid iteration count")
	}
}
