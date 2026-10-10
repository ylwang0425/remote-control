package store

import (
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"errors"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	_ "modernc.org/sqlite"
)

// Outcome is the result of trying to consume a pairing code.
type Outcome int

const (
	PairCodeOK Outcome = iota
	PairCodeNotFound
	PairCodeExpired
	PairCodeAlreadyUsed
	PairCodeTooManyAttempts
)

// maxPairCodeFailures is §7.2 rule 4: five wrong tries retire the code.
const maxPairCodeFailures = 5

// deviceTTL is §7.4: a paired session lives 30 days, matching Max-Age.
const deviceTTL = 30 * 24 * time.Hour

// consumedCodeRetention is §7.2 rule 3: a spent code is kept 300 seconds so a
// late retry can still be told "already used" rather than "not found".
const consumedCodeRetention = 300 * time.Second

// Device is a paired phone session. Only the token's hash is ever stored.
type Device struct {
	ID        string
	Name      string
	TokenHash string
	CreatedAt time.Time
	LastSeen  time.Time
}

// Store is the relay's SQLite persistence. It holds token hashes, pairing-code
// hashes and audit metadata and nothing else — no message body ever reaches it
// (§3.4, R13).
type Store struct {
	db *sql.DB
}

// schema is deliberately small and closed. Adding a column that could hold a
// message body would break §3.4, and TestSchemaHoldsNoChatText guards that.
const schema = `
CREATE TABLE IF NOT EXISTS schema_meta (
	key   TEXT PRIMARY KEY,
	value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS devices (
	id          TEXT PRIMARY KEY,
	name        TEXT NOT NULL,
	token_hash  TEXT NOT NULL,
	created_at  INTEGER NOT NULL,
	expires_at  INTEGER NOT NULL,
	last_seen_at INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX IF NOT EXISTS devices_token_hash_idx ON devices (token_hash);
CREATE TABLE IF NOT EXISTS pair_codes (
	code_hash  TEXT PRIMARY KEY,
	code_id    TEXT NOT NULL,
	created_at INTEGER NOT NULL,
	expires_at INTEGER NOT NULL,
	used_at    INTEGER,
	attempts   INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS pair_codes_expires_idx ON pair_codes (expires_at);
CREATE TABLE IF NOT EXISTS audit (
	id        INTEGER PRIMARY KEY AUTOINCREMENT,
	at        INTEGER NOT NULL,
	kind      TEXT NOT NULL,
	actor     TEXT NOT NULL DEFAULT '',
	detail    TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS audit_at_idx ON audit (at);
`

// Open opens the database, applies the schema and tightens file permissions.
func Open(path string) (*Store, error) {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return nil, fmt.Errorf("create data dir: %w", err)
	}
	dsn := "file:" + url.PathEscape(filepath.ToSlash(path)) +
		"?_pragma=busy_timeout(5000)&_pragma=journal_mode(WAL)&_pragma=synchronous(NORMAL)" +
		"&_pragma=foreign_keys(1)"
	db, err := sql.Open("sqlite", dsn)
	if err != nil {
		return nil, fmt.Errorf("open sqlite: %w", err)
	}
	// modernc.org/sqlite is safe for concurrent use, but keeping one writer
	// avoids lock churn on a 2-core box.
	db.SetMaxOpenConns(8)
	if _, err := db.Exec(schema); err != nil {
		_ = db.Close()
		return nil, fmt.Errorf("apply schema: %w", err)
	}
	if err := os.Chmod(path, 0o600); err != nil && !errors.Is(err, os.ErrPermission) {
		return nil, fmt.Errorf("chmod db: %w", err)
	}
	return &Store{db: db}, nil
}

// Close releases the database.
func (s *Store) Close() error {
	if s == nil || s.db == nil {
		return nil
	}
	return s.db.Close()
}

// HashToken returns the SHA-256 hex digest that is the at-rest form of a token.
// No salt: the value is 256 bits of cryptographic randomness, so a salt adds
// nothing and would only need managing (§7.2 rule 5).
func HashToken(token string) string {
	sum := sha256.Sum256([]byte(token))
	return hex.EncodeToString(sum[:])
}

// NewToken returns a fresh 32-byte base64url session token.
func NewToken() (string, error) {
	buf := make([]byte, 32)
	if _, err := rand.Read(buf); err != nil {
		return "", fmt.Errorf("read random bytes: %w", err)
	}
	return base64URL(buf), nil
}

func base64URL(b []byte) string {
	const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"
	var sb strings.Builder
	for i := 0; i < len(b); i += 3 {
		var chunk [3]byte
		n := copy(chunk[:], b[i:])
		sb.WriteByte(alphabet[chunk[0]>>2])
		sb.WriteByte(alphabet[(chunk[0]&0x03)<<4|chunk[1]>>4])
		if n > 1 {
			sb.WriteByte(alphabet[(chunk[1]&0x0f)<<2|chunk[2]>>6])
		}
		if n > 2 {
			sb.WriteByte(alphabet[chunk[2]&0x3f])
		}
	}
	return sb.String()
}

// NewDeviceID returns a lower-case UUID v4, the shape §4.1 pins for deviceId.
func NewDeviceID() (string, error) {
	buf := make([]byte, 16)
	if _, err := rand.Read(buf); err != nil {
		return "", fmt.Errorf("read random bytes: %w", err)
	}
	buf[6] = (buf[6] & 0x0f) | 0x40
	buf[8] = (buf[8] & 0x3f) | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", buf[0:4], buf[4:6], buf[6:8], buf[8:10], buf[10:16]), nil
}

// InsertPairCode records a freshly minted pairing code. Only its hash is stored.
func (s *Store) InsertPairCode(codeHash, codeID string, createdAt, expiresAt time.Time) error {
	_, err := s.db.Exec(
		`INSERT INTO pair_codes (code_hash, code_id, created_at, expires_at, attempts) VALUES (?, ?, ?, ?, 0)`,
		codeHash, codeID, createdAt.UnixNano(), expiresAt.UnixNano())
	if err != nil {
		return fmt.Errorf("insert pair code: %w", err)
	}
	return nil
}

// ConsumePairCode performs §7.2's single-use transition. The compare-and-set is
// a single UPDATE guarded by `used_at IS NULL`, so of any number of concurrent
// callers exactly one observes a changed row and wins. The pre-read exists only
// to tell the losers why they lost.
func (s *Store) ConsumePairCode(codeHash string, now time.Time) (Outcome, string, error) {
	var codeID string
	var expiresAt, usedAt sql.NullInt64
	var attempts int
	err := s.db.QueryRow(
		`SELECT code_id, expires_at, used_at, attempts FROM pair_codes WHERE code_hash = ?`,
		codeHash).Scan(&codeID, &expiresAt, &usedAt, &attempts)
	if errors.Is(err, sql.ErrNoRows) {
		return PairCodeNotFound, "", nil
	}
	if err != nil {
		return PairCodeNotFound, "", fmt.Errorf("read pair code: %w", err)
	}
	if outcome, done := classifyPairCode(expiresAt.Int64, usedAt, attempts, now); done {
		return outcome, codeID, nil
	}

	res, err := s.db.Exec(
		`UPDATE pair_codes SET used_at = ? WHERE code_hash = ? AND used_at IS NULL AND expires_at > ?`,
		now.UnixNano(), codeHash, now.UnixNano())
	if err != nil {
		return PairCodeNotFound, "", fmt.Errorf("consume pair code: %w", err)
	}
	affected, err := res.RowsAffected()
	if err != nil {
		return PairCodeNotFound, "", fmt.Errorf("consume pair code rows: %w", err)
	}
	if affected == 1 {
		return PairCodeOK, codeID, nil
	}

	// Lost the race; re-read so the loser gets the honest reason.
	err = s.db.QueryRow(
		`SELECT expires_at, used_at, attempts FROM pair_codes WHERE code_hash = ?`,
		codeHash).Scan(&expiresAt, &usedAt, &attempts)
	if errors.Is(err, sql.ErrNoRows) {
		return PairCodeNotFound, codeID, nil
	}
	if err != nil {
		return PairCodeNotFound, "", fmt.Errorf("re-read pair code: %w", err)
	}
	if outcome, done := classifyPairCode(expiresAt.Int64, usedAt, attempts, now); done {
		return outcome, codeID, nil
	}
	return PairCodeAlreadyUsed, codeID, nil
}

func classifyPairCode(expiresAtUnixNano int64, usedAt sql.NullInt64, attempts int, now time.Time) (Outcome, bool) {
	if usedAt.Valid {
		return PairCodeAlreadyUsed, true
	}
	if attempts >= maxPairCodeFailures {
		return PairCodeTooManyAttempts, true
	}
	if now.UnixNano() > expiresAtUnixNano {
		return PairCodeExpired, true
	}
	return PairCodeOK, false
}

// RecordPairCodeFailure counts one failed attempt against a code (§7.2 rule 4).
func (s *Store) RecordPairCodeFailure(codeHash string) error {
	_, err := s.db.Exec(
		`UPDATE pair_codes SET attempts = attempts + 1 WHERE code_hash = ? AND used_at IS NULL`,
		codeHash)
	if err != nil {
		return fmt.Errorf("record pair code failure: %w", err)
	}
	return nil
}

// PurgePairCodes drops expired codes and codes consumed longer ago than the
// retention window. Correctness never depends on it (§7.2 rule 3).
func (s *Store) PurgePairCodes(now time.Time) (int, error) {
	res, err := s.db.Exec(
		`DELETE FROM pair_codes WHERE expires_at <= ? OR (used_at IS NOT NULL AND used_at <= ?)`,
		now.UnixNano(), now.Add(-consumedCodeRetention).UnixNano())
	if err != nil {
		return 0, fmt.Errorf("purge pair codes: %w", err)
	}
	n, err := res.RowsAffected()
	if err != nil {
		return 0, fmt.Errorf("purge pair codes rows: %w", err)
	}
	return int(n), nil
}

// CreateDevice stores a newly paired session. The caller passes the hash; the
// plaintext never reaches this layer.
func (s *Store) CreateDevice(tokenHash, name string, now time.Time) (string, error) {
	id, err := NewDeviceID()
	if err != nil {
		return "", err
	}
	_, err = s.db.Exec(
		`INSERT INTO devices (id, name, token_hash, created_at, expires_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?)`,
		id, name, tokenHash, now.UnixNano(), now.Add(deviceTTL).UnixNano(), now.UnixNano())
	if err != nil {
		return "", fmt.Errorf("insert device: %w", err)
	}
	return id, nil
}

// DeviceByTokenHash resolves a cookie value's hash to a live device, or nil
// when the session is unknown, revoked or past its 30 days (§7.4: expiry and
// revocation are indistinguishable to the client).
func (s *Store) DeviceByTokenHash(tokenHash string, now time.Time) (*Device, error) {
	var dev Device
	var createdAt, expiresAt, lastSeen int64
	err := s.db.QueryRow(
		`SELECT id, name, token_hash, created_at, expires_at, last_seen_at FROM devices WHERE token_hash = ?`,
		tokenHash).Scan(&dev.ID, &dev.Name, &dev.TokenHash, &createdAt, &expiresAt, &lastSeen)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("read device: %w", err)
	}
	if now.UnixNano() > expiresAt {
		return nil, nil
	}
	dev.CreatedAt = time.Unix(0, createdAt).UTC()
	dev.LastSeen = time.Unix(0, lastSeen).UTC()
	return &dev, nil
}

// TouchDevice records activity, used for the audit trail only.
func (s *Store) TouchDevice(deviceID string, now time.Time) error {
	_, err := s.db.Exec(`UPDATE devices SET last_seen_at = ? WHERE id = ?`, now.UnixNano(), deviceID)
	if err != nil {
		return fmt.Errorf("touch device: %w", err)
	}
	return nil
}

// RevokeByTokenHash deletes the hash, which is what makes revocation immediate.
func (s *Store) RevokeByTokenHash(tokenHash string) (bool, error) {
	res, err := s.db.Exec(`DELETE FROM devices WHERE token_hash = ?`, tokenHash)
	if err != nil {
		return false, fmt.Errorf("revoke device: %w", err)
	}
	n, err := res.RowsAffected()
	if err != nil {
		return false, fmt.Errorf("revoke device rows: %w", err)
	}
	return n > 0, nil
}

// Audit appends one metadata record. Callers must pass only opaque identifiers
// and stable result codes — never a token, a pairing code or message text.
func (s *Store) Audit(kind, actor, detail string, at time.Time) error {
	_, err := s.db.Exec(
		`INSERT INTO audit (at, kind, actor, detail) VALUES (?, ?, ?, ?)`,
		at.UnixNano(), kind, actor, detail)
	if err != nil {
		return fmt.Errorf("append audit: %w", err)
	}
	return nil
}

// auditMaxRows bounds the audit table. Audit rows are written on paths that cost
// an unauthenticated caller nothing — a refused /bridge handshake writes one —
// so without a cap they are an unbounded disk write on a 2-core 2-GB box.
//
// It is a variable only so a test can lower it instead of inserting five
// thousand rows; nothing in the product writes to it.
var auditMaxRows = 5000

// defaultAuditRetention is how long an audit row is kept even when the table is
// below its row cap.
const defaultAuditRetention = 30 * 24 * time.Hour

// AuditCount reports how many audit rows exist.
func (s *Store) AuditCount() (int, error) {
	var n int
	if err := s.db.QueryRow(`SELECT COUNT(*) FROM audit`).Scan(&n); err != nil {
		return 0, fmt.Errorf("count audit: %w", err)
	}
	return n, nil
}

// PurgeAudit drops rows older than the retention window, then trims the table
// to its row cap keeping the newest rows. It returns how many rows it removed.
func (s *Store) PurgeAudit(now time.Time) (int, error) {
	removed := 0

	res, err := s.db.Exec(`DELETE FROM audit WHERE at < ?`, now.Add(-defaultAuditRetention).UnixNano())
	if err != nil {
		return removed, fmt.Errorf("purge audit by age: %w", err)
	}
	if n, err := res.RowsAffected(); err == nil {
		removed += int(n)
	}

	res, err = s.db.Exec(
		`DELETE FROM audit WHERE id NOT IN (SELECT id FROM audit ORDER BY id DESC LIMIT ?)`,
		auditMaxRows)
	if err != nil {
		return removed, fmt.Errorf("purge audit by size: %w", err)
	}
	if n, err := res.RowsAffected(); err == nil {
		removed += int(n)
	}
	return removed, nil
}

// TablesForTest lists user tables, for the R13 schema assertion.
func (s *Store) TablesForTest(t *testing.T) []string {
	t.Helper()
	rows, err := s.db.Query(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`)
	if err != nil {
		t.Fatalf("list tables: %v", err)
	}
	defer rows.Close()
	var out []string
	for rows.Next() {
		var name string
		if err := rows.Scan(&name); err != nil {
			t.Fatalf("scan table name: %v", err)
		}
		out = append(out, name)
	}
	return out
}

// ColumnsForTest lists every column across user tables, for the R13 assertion.
func (s *Store) ColumnsForTest(t *testing.T) []string {
	t.Helper()
	rows, err := s.db.Query(`SELECT name FROM pragma_table_info((SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name))`)
	if err != nil {
		// pragma_table_info takes one table at a time; fall back to a loop.
		var out []string
		for _, table := range s.TablesForTest(t) {
			cols, err := s.db.Query(`SELECT name FROM pragma_table_info(?)`, table)
			if err != nil {
				t.Fatalf("list columns of %s: %v", table, err)
			}
			for cols.Next() {
				var name string
				if err := cols.Scan(&name); err != nil {
					t.Fatalf("scan column name: %v", err)
				}
				out = append(out, name)
			}
			cols.Close()
		}
		return out
	}
	defer rows.Close()
	var out []string
	for rows.Next() {
		var name string
		if err := rows.Scan(&name); err != nil {
			t.Fatalf("scan column name: %v", err)
		}
		out = append(out, name)
	}
	return out
}

// rawDumpForTest returns every text-ish value in the database, so a test can
// prove a plaintext secret is absent from the whole file.
func (s *Store) rawDumpForTest(t *testing.T) string {
	t.Helper()
	var sb strings.Builder
	for _, table := range s.TablesForTest(t) {
		rows, err := s.db.Query(`SELECT * FROM ` + table)
		if err != nil {
			t.Fatalf("dump %s: %v", table, err)
		}
		cols, err := rows.Columns()
		if err != nil {
			t.Fatalf("columns of %s: %v", table, err)
		}
		for rows.Next() {
			values := make([]any, len(cols))
			ptrs := make([]any, len(cols))
			for i := range values {
				ptrs[i] = &values[i]
			}
			if err := rows.Scan(ptrs...); err != nil {
				t.Fatalf("scan %s: %v", table, err)
			}
			for _, v := range values {
				switch tv := v.(type) {
				case string:
					sb.WriteString(tv)
				case []byte:
					sb.Write(tv)
				}
				sb.WriteByte(0)
			}
		}
		rows.Close()
	}
	return sb.String()
}
