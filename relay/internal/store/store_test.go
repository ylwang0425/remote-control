package store

import (
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

func openTestStore(t *testing.T) *Store {
	t.Helper()
	st, err := Open(filepath.Join(t.TempDir(), "relay.db"))
	if err != nil {
		t.Fatalf("Open returned error: %v", err)
	}
	t.Cleanup(func() { _ = st.Close() })
	return st
}

// TestPairCodeSingleUseIsAtomic covers protocol-v1 §7.2 rule 1: the code is
// consumed by a compare-and-set, so of two concurrent requests with the same
// code exactly one wins and the other is told it was already used. Anything
// weaker would hand out two sessions for one code.
func TestPairCodeSingleUseIsAtomic(t *testing.T) {
	st := openTestStore(t)
	now := time.Now()
	const hash = "hash-of-one-pairing-code"
	if err := st.InsertPairCode(hash, "code-1", now, now.Add(300*time.Second)); err != nil {
		t.Fatalf("InsertPairCode returned error: %v", err)
	}

	const racers = 24
	var wg sync.WaitGroup
	results := make([]Outcome, racers)
	for i := 0; i < racers; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			outcome, _, err := st.ConsumePairCode(hash, time.Now())
			if err != nil {
				t.Errorf("ConsumePairCode returned error: %v", err)
				return
			}
			results[i] = outcome
		}(i)
	}
	wg.Wait()

	wins := 0
	for _, r := range results {
		switch r {
		case PairCodeOK:
			wins++
		case PairCodeAlreadyUsed, PairCodeNotFound:
			// Both are the honest answer for a loser; nothing else is.
		default:
			t.Fatalf("loser got outcome %v, want already-used or not-found", r)
		}
	}
	if wins != 1 {
		t.Fatalf("%d racers won the same pairing code, want exactly 1", wins)
	}
}

// TestPairCodeExpiresAfter300Seconds covers §7.2 rule 2 and R3's "5 分钟过期".
func TestPairCodeExpiresAfter300Seconds(t *testing.T) {
	st := openTestStore(t)
	now := time.Now()
	const hash = "hash-expiring"
	if err := st.InsertPairCode(hash, "code-2", now, now.Add(300*time.Second)); err != nil {
		t.Fatalf("InsertPairCode returned error: %v", err)
	}

	if outcome, _, err := st.ConsumePairCode(hash, now.Add(299*time.Second)); err != nil || outcome != PairCodeOK {
		t.Fatalf("at +299s outcome = %v (err %v), want PairCodeOK", outcome, err)
	}

	const fresh = "hash-expiring-2"
	if err := st.InsertPairCode(fresh, "code-3", now, now.Add(300*time.Second)); err != nil {
		t.Fatalf("InsertPairCode returned error: %v", err)
	}
	if outcome, _, err := st.ConsumePairCode(fresh, now.Add(301*time.Second)); err != nil || outcome != PairCodeExpired {
		t.Fatalf("at +301s outcome = %v (err %v), want PairCodeExpired", outcome, err)
	}
}

// TestPairCodeDiesAfterFiveFailures covers §7.2 rule 4.
func TestPairCodeDiesAfterFiveFailures(t *testing.T) {
	st := openTestStore(t)
	now := time.Now()
	const hash = "hash-attempts"
	if err := st.InsertPairCode(hash, "code-4", now, now.Add(300*time.Second)); err != nil {
		t.Fatalf("InsertPairCode returned error: %v", err)
	}
	for i := 0; i < 5; i++ {
		if err := st.RecordPairCodeFailure(hash); err != nil {
			t.Fatalf("RecordPairCodeFailure returned error: %v", err)
		}
	}
	outcome, _, err := st.ConsumePairCode(hash, time.Now())
	if err != nil {
		t.Fatalf("ConsumePairCode returned error: %v", err)
	}
	if outcome != PairCodeTooManyAttempts {
		t.Fatalf("outcome = %v, want PairCodeTooManyAttempts", outcome)
	}
}

// TestPurgeRemovesExpiredAndConsumed covers §7.2 rule 3: the 60 second sweep
// only saves memory, so it must never delete a code that is still usable.
func TestPurgeRemovesExpiredAndConsumed(t *testing.T) {
	st := openTestStore(t)
	now := time.Now()
	if err := st.InsertPairCode("live", "code-live", now, now.Add(300*time.Second)); err != nil {
		t.Fatalf("InsertPairCode returned error: %v", err)
	}
	if err := st.InsertPairCode("dead", "code-dead", now, now.Add(-time.Second)); err != nil {
		t.Fatalf("InsertPairCode returned error: %v", err)
	}
	if err := st.InsertPairCode("spent", "code-spent", now, now.Add(300*time.Second)); err != nil {
		t.Fatalf("InsertPairCode returned error: %v", err)
	}
	// Consumed 400 seconds ago: past the 300 second retention, so the sweep may
	// drop it. A code consumed a moment ago must survive its retention window.
	if outcome, _, err := st.ConsumePairCode("spent", now.Add(-400*time.Second)); err != nil || outcome != PairCodeOK {
		t.Fatalf("setup consume failed: %v %v", outcome, err)
	}

	n, err := st.PurgePairCodes(now)
	if err != nil {
		t.Fatalf("PurgePairCodes returned error: %v", err)
	}
	if n < 2 {
		t.Fatalf("PurgePairCodes removed %d rows, want at least the expired and the long-consumed ones", n)
	}
	if outcome, _, err := st.ConsumePairCode("live", now); err != nil || outcome != PairCodeOK {
		t.Fatalf("purge deleted a live code: outcome %v err %v", outcome, err)
	}
}

// TestDeviceTokenIsStoredOnlyAsHash covers §3.10 and R13: the disk holds a hash
// and never the value that grants access.
func TestDeviceTokenIsStoredOnlyAsHash(t *testing.T) {
	st := openTestStore(t)
	now := time.Now()
	const rawToken = "THIS-IS-THE-PLAINTEXT-SESSION-TOKEN-VALUE"
	hash := HashToken(rawToken)

	id, err := st.CreateDevice(hash, "Pixel 8", now)
	if err != nil {
		t.Fatalf("CreateDevice returned error: %v", err)
	}
	if id == "" {
		t.Fatal("CreateDevice returned an empty device id")
	}

	dev, err := st.DeviceByTokenHash(hash, now)
	if err != nil {
		t.Fatalf("DeviceByTokenHash returned error: %v", err)
	}
	if dev == nil || dev.ID != id || dev.Name != "Pixel 8" {
		t.Fatalf("DeviceByTokenHash = %+v, want the row just written", dev)
	}

	if _, err := st.DeviceByTokenHash(HashToken("some other token"), now); err != nil {
		t.Fatalf("DeviceByTokenHash(unknown) returned error: %v", err)
	} else if dev, _ := st.DeviceByTokenHash(HashToken("some other token"), now); dev != nil {
		t.Fatal("DeviceByTokenHash found a device for an unknown token")
	}

	// The raw token must appear nowhere in the file.
	if strings.Contains(st.rawDumpForTest(t), rawToken) {
		t.Fatal("the plaintext session token is present in the database file")
	}
	if !strings.Contains(st.rawDumpForTest(t), HashToken(rawToken)) {
		t.Fatal("the token hash is missing from the database file")
	}
}

// TestRevokeDeletesTheHashImmediately covers §7.4: revoking is deleting the
// hash, and every later lookup must fail.
func TestRevokeDeletesTheHashImmediately(t *testing.T) {
	st := openTestStore(t)
	now := time.Now()
	hash := HashToken("token-to-revoke")
	if _, err := st.CreateDevice(hash, "Pixel 8", now); err != nil {
		t.Fatalf("CreateDevice returned error: %v", err)
	}

	removed, err := st.RevokeByTokenHash(hash)
	if err != nil {
		t.Fatalf("RevokeByTokenHash returned error: %v", err)
	}
	if !removed {
		t.Fatal("RevokeByTokenHash reported nothing removed for an existing device")
	}
	dev, err := st.DeviceByTokenHash(hash, now)
	if err != nil {
		t.Fatalf("DeviceByTokenHash after revoke returned error: %v", err)
	}
	if dev != nil {
		t.Fatal("a revoked session still resolves; revoke must be immediate")
	}
	// Idempotent: revoking again is not an error, it just removes nothing.
	removed, err = st.RevokeByTokenHash(hash)
	if err != nil || removed {
		t.Fatalf("second RevokeByTokenHash = %v, %v; want false, nil", removed, err)
	}
}

// TestDeviceExpiresAfterThirtyDays covers §7.4: expiry and revocation are
// indistinguishable to the client, both simply stop resolving.
func TestDeviceExpiresAfterThirtyDays(t *testing.T) {
	st := openTestStore(t)
	now := time.Now()
	hash := HashToken("token-that-ages")
	if _, err := st.CreateDevice(hash, "Pixel 8", now); err != nil {
		t.Fatalf("CreateDevice returned error: %v", err)
	}
	dev, err := st.DeviceByTokenHash(hash, now.Add(29*24*time.Hour))
	if err != nil || dev == nil {
		t.Fatalf("at +29d device = %+v err %v, want a live device", dev, err)
	}
	dev, err = st.DeviceByTokenHash(hash, now.Add(31*24*time.Hour))
	if err != nil {
		t.Fatalf("at +31d DeviceByTokenHash returned error: %v", err)
	}
	if dev != nil {
		t.Fatal("a 30-day-old session still resolves")
	}
}

// TestSchemaHoldsNoChatText covers R13 and §3.4: persistence is limited to
// token hashes, pairing-code hashes and audit metadata. There is no table that
// could hold a message body, and no column named like one.
func TestSchemaHoldsNoChatText(t *testing.T) {
	st := openTestStore(t)
	got := st.TablesForTest(t)
	want := map[string]bool{"devices": true, "pair_codes": true, "audit": true, "schema_meta": true}
	for _, name := range got {
		if !want[name] {
			t.Errorf("unexpected table %q: persistence must hold only token hashes and audit metadata", name)
		}
	}
	if len(got) != len(want) {
		t.Errorf("tables = %v, want exactly %v", got, keysOf(want))
	}

	forbidden := []string{"text", "message", "body", "content", "transcript", "history", "chat", "token"}
	for _, col := range st.ColumnsForTest(t) {
		lower := strings.ToLower(col)
		for _, bad := range forbidden {
			if lower == bad {
				t.Errorf("column %q looks like stored chat or a stored secret; only hashes are allowed", col)
			}
		}
	}
}

func keysOf(m map[string]bool) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	return out
}
