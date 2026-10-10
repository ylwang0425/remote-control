package protocol

import "testing"

// TestOriginExactMatch covers protocol-v1 §5.3: the only allowed string is one
// exact origin. Comparison trims surrounding whitespace and lowercases the
// whole string, and is byte-equal after that — no suffix matching, no port
// forgiveness, no scheme forgiveness.
func TestOriginExactMatch(t *testing.T) {
	allowed := []string{"https://101.43.98.18"}

	accepted := []string{
		"https://101.43.98.18",
		"  https://101.43.98.18  ",
		"HTTPS://101.43.98.18",
	}
	for _, o := range accepted {
		if !OriginAllowed(o, allowed) {
			t.Errorf("OriginAllowed(%q) = false, want true", o)
		}
	}

	rejected := []string{
		"",
		"null",
		"http://101.43.98.18",
		"https://101.43.98.18:443",
		"https://101.43.98.18/",
		"https://101.43.98.18.evil.example",
		"https://101.43.98.18:8443",
		"https://101.43.98.180",
		"https://evil.example",
		"https://101.43.98.18 https://evil.example",
	}
	for _, o := range rejected {
		if OriginAllowed(o, allowed) {
			t.Errorf("OriginAllowed(%q) = true, want false", o)
		}
	}

	if OriginAllowed("https://101.43.98.18", nil) {
		t.Error("OriginAllowed with no configured origin = true, want false (no default allow)")
	}
	if OriginAllowed("  ", allowed) {
		t.Error("OriginAllowed(blank) = true, want false")
	}
}
