package logx

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// TestWriterCapsTheLogFile covers R14's "日志限额已配": the file never grows
// past its cap, and the rotated copies are bounded too. On a 2-core box next to
// the public internet an unbounded log is a slow denial of service against its
// own disk.
func TestWriterCapsTheLogFile(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "relay.log")

	const maxBytes = 512
	const maxFiles = 2
	w, err := New(path, maxBytes, maxFiles)
	if err != nil {
		t.Fatalf("New returned error: %v", err)
	}
	defer w.Close()

	line := []byte(strings.Repeat("x", 100) + "\n")
	for i := 0; i < 40; i++ {
		if _, err := w.Write(line); err != nil {
			t.Fatalf("Write returned error: %v", err)
		}
	}

	info, err := os.Stat(path)
	if err != nil {
		t.Fatalf("Stat returned error: %v", err)
	}
	// One line may push the file just past the cap before rotation happens.
	if info.Size() > maxBytes+int64(len(line)) {
		t.Fatalf("live log is %d bytes, want it capped near %d", info.Size(), maxBytes)
	}

	// Rotated copies exist and are bounded, and no more than maxFiles of them.
	if _, err := os.Stat(path + ".1"); err != nil {
		t.Fatalf("expected a rotated file %s.1: %v", path, err)
	}
	if _, err := os.Stat(path + ".2"); err != nil {
		t.Fatalf("expected a second rotated file %s.2: %v", path, err)
	}
	if _, err := os.Stat(path + ".3"); !os.IsNotExist(err) {
		t.Fatalf("a third rotated file exists; maxFiles=%d must bound them", maxFiles)
	}

	var total int64
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatalf("ReadDir returned error: %v", err)
	}
	for _, e := range entries {
		st, err := e.Info()
		if err != nil {
			t.Fatalf("Info returned error: %v", err)
		}
		total += st.Size()
	}
	if total > (maxBytes+int64(len(line)))*(maxFiles+1) {
		t.Fatalf("all log files total %d bytes, want them bounded by the cap times maxFiles", total)
	}
}

// TestWriterRejectsNonsense covers the guard rails: a zero cap or a negative
// file count would silently mean "no limit".
func TestWriterRejectsNonsense(t *testing.T) {
	dir := t.TempDir()
	if _, err := New(filepath.Join(dir, "a.log"), 0, 1); err == nil {
		t.Fatal("New accepted a zero maxBytes")
	}
	if _, err := New(filepath.Join(dir, "b.log"), 128, -1); err == nil {
		t.Fatal("New accepted a negative maxFiles")
	}
}
