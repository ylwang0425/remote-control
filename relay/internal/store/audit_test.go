package store

import (
	"testing"
	"time"
)

// TestAuditIsBoundedByRowCount covers security finding F1's second half: the
// audit table is written on paths an unauthenticated caller can reach, so it
// cannot be allowed to grow forever.
func TestAuditIsBoundedByRowCount(t *testing.T) {
	restore := auditMaxRows
	auditMaxRows = 10
	t.Cleanup(func() { auditMaxRows = restore })

	st := openTestStore(t)
	now := time.Now()
	for i := 0; i < 40; i++ {
		if err := st.Audit("bridge.reject", "", "invalid bridge token", now.Add(time.Duration(i)*time.Second)); err != nil {
			t.Fatalf("Audit returned error: %v", err)
		}
	}
	before, err := st.AuditCount()
	if err != nil {
		t.Fatalf("AuditCount returned error: %v", err)
	}
	if before != 40 {
		t.Fatalf("AuditCount() = %d, want the 40 rows just written", before)
	}

	removed, err := st.PurgeAudit(now.Add(time.Minute))
	if err != nil {
		t.Fatalf("PurgeAudit returned error: %v", err)
	}
	if removed != 30 {
		t.Fatalf("PurgeAudit removed %d rows, want 30 to reach the cap of 10", removed)
	}
	after, err := st.AuditCount()
	if err != nil {
		t.Fatalf("AuditCount returned error: %v", err)
	}
	if after > auditMaxRows {
		t.Fatalf("AuditCount() = %d after the purge, want at most %d", after, auditMaxRows)
	}
}

// TestAuditIsBoundedByAge covers F1's retention window, and — just as important
// — that a sweep under the cap and inside the window deletes nothing.
func TestAuditIsBoundedByAge(t *testing.T) {
	st := openTestStore(t)
	now := time.Now()

	if err := st.Audit("bridge.reject", "", "old", now.Add(-60*24*time.Hour)); err != nil {
		t.Fatalf("Audit returned error: %v", err)
	}
	if err := st.Audit("bridge.reject", "", "recent", now); err != nil {
		t.Fatalf("Audit returned error: %v", err)
	}

	removed, err := st.PurgeAudit(now)
	if err != nil {
		t.Fatalf("PurgeAudit returned error: %v", err)
	}
	if removed != 1 {
		t.Fatalf("PurgeAudit removed %d rows, want exactly the 60-day-old one", removed)
	}
	count, err := st.AuditCount()
	if err != nil {
		t.Fatalf("AuditCount returned error: %v", err)
	}
	if count != 1 {
		t.Fatalf("AuditCount() = %d, want the recent row kept", count)
	}
}
