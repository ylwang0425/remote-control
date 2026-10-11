package store

import (
	"database/sql"
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

func TestLegacySchemaMigrationBindsOnlyToPinnedBootstrapAndSurvivesRestart(t *testing.T) {
	path := filepath.Join(t.TempDir(), "relay.db")
	legacy, err := sql.Open("sqlite", "file:"+filepath.ToSlash(path))
	if err != nil {
		t.Fatalf("open legacy db: %v", err)
	}
	now := time.Now()
	legacyDDL := []string{
		`CREATE TABLE devices (id TEXT PRIMARY KEY, name TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL DEFAULT 0)`,
		`CREATE TABLE pair_codes (code_hash TEXT PRIMARY KEY, code_id TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, used_at INTEGER, attempts INTEGER NOT NULL DEFAULT 0)`,
	}
	for _, statement := range legacyDDL {
		if _, err := legacy.Exec(statement); err != nil {
			t.Fatalf("create legacy table: %v", err)
		}
	}
	phoneTokenHash := HashToken("legacy-phone-token-for-migration")
	if _, err := legacy.Exec(`INSERT INTO devices (id,name,token_hash,created_at,expires_at,last_seen_at) VALUES ('phone-1','Legacy Phone',?,?,?,0)`, phoneTokenHash, now.UnixNano(), now.Add(deviceTTL).UnixNano()); err != nil {
		t.Fatalf("insert legacy device: %v", err)
	}
	legacyCodeHash := HashToken("legacy-unconsumed-pair-code")
	if _, err := legacy.Exec(`INSERT INTO pair_codes (code_hash,code_id,created_at,expires_at,attempts) VALUES (?,'pair-1',?,?,0)`, legacyCodeHash, now.UnixNano(), now.Add(5*time.Minute).UnixNano()); err != nil {
		t.Fatalf("insert legacy pair code: %v", err)
	}
	if err := legacy.Close(); err != nil {
		t.Fatal(err)
	}

	st, err := Open(path)
	if err != nil {
		t.Fatalf("Open migrated db: %v", err)
	}
	bootstrapID, err := st.PinBootstrapComputer("", "Owner", "DESKTOP-OLD", HashToken("bootstrap-token"), []byte(`{"tools":["codex"]}`), now)
	if err != nil {
		t.Fatalf("pin bootstrap identity: %v", err)
	}
	device, err := st.DeviceByTokenHash(phoneTokenHash, now)
	if err != nil || device == nil || device.ClientID != bootstrapID {
		t.Fatalf("legacy device = %+v, err=%v; want bootstrap binding %s", device, err, bootstrapID)
	}
	outcome, _, pairClientID, err := st.ConsumePairCodeBound(legacyCodeHash, now)
	if err != nil || outcome != PairCodeOK || pairClientID != bootstrapID {
		t.Fatalf("legacy pair code binding = %q, %v, %v; want %q", pairClientID, outcome, err, bootstrapID)
	}
	if err := st.Close(); err != nil {
		t.Fatal(err)
	}

	reopened, err := Open(path)
	if err != nil {
		t.Fatalf("reopen migrated db: %v", err)
	}
	defer reopened.Close()
	if got, err := reopened.BootstrapClientID(); err != nil || got != bootstrapID {
		t.Fatalf("bootstrap identity after restart = %q, %v; want %q", got, err, bootstrapID)
	}
	device, err = reopened.DeviceByTokenHash(phoneTokenHash, now)
	if err != nil || device == nil || device.ClientID != bootstrapID {
		t.Fatalf("phone binding after restart = %+v, err=%v", device, err)
	}
	if _, err := reopened.PinBootstrapComputer("3f2504e0-4f89-41d3-9a0c-0305e82c3301", "Attacker", "OTHER", HashToken("bootstrap-token"), nil, now); err != ErrIdentityConflict {
		t.Fatalf("a second bootstrap identity returned %v; want ErrIdentityConflict", err)
	}
}

func TestEnrollmentCodeIsOneUseAndSecretsAreOnlyHashed(t *testing.T) {
	st := openTestStore(t)
	now := time.Now()
	code := "ABCDEFGHJKMNPQRSTVWXYZ012"
	codeHash := HashToken(code)
	bridgeToken := "per-computer-secret-token"
	clientID := "0f1c7a2e-9b64-4c5f-8f1a-2d3e4b5c6a70"
	if err := st.InsertEnrollmentCode(codeHash, now, now.Add(10*time.Minute)); err != nil {
		t.Fatal(err)
	}
	outcome, err := st.EnrollComputer(codeHash, clientID, "Laptop", "DESKTOP-ONE", HashToken(bridgeToken), now)
	if err != nil || outcome != EnrollmentOK {
		t.Fatalf("first enrollment = %v, %v", outcome, err)
	}
	outcome, err = st.EnrollComputer(codeHash, "3f2504e0-4f89-41d3-9a0c-0305e82c3301", "Other", "DESKTOP-TWO", HashToken("another-token"), now)
	if err != nil || outcome != EnrollmentAlreadyUsed {
		t.Fatalf("second enrollment = %v, %v; want EnrollmentAlreadyUsed", outcome, err)
	}
	computer, err := st.DesktopByTokenHash(HashToken(bridgeToken))
	if err != nil || computer == nil || computer.ClientID != clientID {
		t.Fatalf("token lookup = %+v, %v", computer, err)
	}
	dump := st.rawDumpForTest(t)
	for _, secret := range []string{code, bridgeToken} {
		if strings.Contains(dump, secret) {
			t.Fatalf("plaintext enrollment secret %q is in the database", secret)
		}
	}
	if !strings.Contains(dump, codeHash) || !strings.Contains(dump, HashToken(bridgeToken)) {
		t.Fatal("database is missing a stored SHA-256 token/code hash")
	}
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

// TestSchemaHoldsNoChatText covers the persistence boundary: persistence is
// limited to token hashes, pair/enrollment-code hashes, computer metadata,
// capabilities declarations and audit metadata. No table can hold a message.
func TestSchemaHoldsNoChatText(t *testing.T) {
	st := openTestStore(t)
	got := st.TablesForTest(t)
	want := map[string]bool{
		"devices": true, "pair_codes": true, "audit": true, "schema_meta": true,
		"desktop_clients": true, "enrollment_codes": true,
	}
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
