package protocol

import (
	"encoding/json"
	"strings"
	"testing"
)

// TestValidateParamsWhitelist covers §7.3: the field whitelist tightens per
// method, one extra field is invalid_params, and the four method names are the
// only ones that exist. There is deliberately no create-session method.
func TestValidateParamsWhitelist(t *testing.T) {
	accepted := []struct {
		method string
		params string
	}{
		{"sessions.list", `{}`},
		{"sessions.list", `{"tool":"codex"}`},
		{"session.read", `{"tool":"codex","sessionId":"0f1c7a2e"}`},
		{"session.read", `{"tool":"dsh","sessionId":"a-b_c.d:e"}`},
		{"session.send", `{"tool":"dsh","sessionId":"s1","text":"继续"}`},
		{"session.stop", `{"tool":"codex","sessionId":"s1"}`},
	}
	for _, tc := range accepted {
		if code, ok := ValidateParams(tc.method, json.RawMessage(tc.params)); !ok {
			t.Errorf("ValidateParams(%s, %s) = %s, want accepted", tc.method, tc.params, code)
		}
	}

	rejected := []struct {
		method string
		params string
		want   Code
	}{
		// Whitelist is per method: a field outside it is invalid_params.
		{"sessions.list", `{"sessionId":"s1"}`, CodeInvalidParams},
		{"sessions.list", `{"text":"hi"}`, CodeInvalidParams},
		{"session.read", `{"tool":"codex","sessionId":"s1","text":"hi"}`, CodeInvalidParams},
		{"session.stop", `{"tool":"codex","sessionId":"s1","text":"hi"}`, CodeInvalidParams},
		{"session.send", `{"tool":"codex","sessionId":"s1","text":"hi","timeoutMs":1}`, CodeInvalidParams},
		// Required fields.
		{"session.read", `{"tool":"codex"}`, CodeInvalidParams},
		{"session.send", `{"tool":"codex","sessionId":"s1"}`, CodeInvalidParams},
		{"session.stop", `{"sessionId":"s1"}`, CodeInvalidParams},
		// tool is pinned to codex | dsh.
		{"session.read", `{"tool":"claude","sessionId":"s1"}`, CodeInvalidParams},
		{"session.read", `{"tool":"","sessionId":"s1"}`, CodeInvalidParams},
		// sessionId shape.
		{"session.read", `{"tool":"codex","sessionId":"has space"}`, CodeInvalidParams},
		{"session.read", `{"tool":"codex","sessionId":"a/b"}`, CodeInvalidParams},
		{"session.read", `{"tool":"codex","sessionId":""}`, CodeInvalidParams},
		// text shape.
		{"session.send", `{"tool":"codex","sessionId":"s1","text":""}`, CodeInvalidParams},
		{"session.send", `{"tool":"codex","sessionId":"s1","text":"   "}`, CodeInvalidParams},
		{"session.send", `{"tool":"codex","sessionId":"s1","text":"a\u0000b"}`, CodeInvalidParams},
		// Wrong types.
		{"sessions.list", `{"tool":123}`, CodeInvalidParams},
		{"sessions.list", `[]`, CodeInvalidParams},
		{"sessions.list", `"x"`, CodeInvalidParams},
	}
	for _, tc := range rejected {
		code, ok := ValidateParams(tc.method, json.RawMessage(tc.params))
		if ok {
			t.Errorf("ValidateParams(%s, %s) accepted, want %s", tc.method, tc.params, tc.want)
			continue
		}
		if code != tc.want {
			t.Errorf("ValidateParams(%s, %s) = %s, want %s", tc.method, tc.params, code, tc.want)
		}
	}

	// Over-long text is its own code, not invalid_params.
	long := `{"tool":"codex","sessionId":"s1","text":"` + strings.Repeat("a", 16385) + `"}`
	if code, ok := ValidateParams("session.send", json.RawMessage(long)); ok || code != CodeTooLong {
		t.Errorf("ValidateParams(16385 chars) = %s ok=%v, want too_long", code, ok)
	}
	// The 16384 boundary itself is allowed.
	edge := `{"tool":"codex","sessionId":"s1","text":"` + strings.Repeat("a", 16384) + `"}`
	if code, ok := ValidateParams("session.send", json.RawMessage(edge)); !ok {
		t.Errorf("ValidateParams(16384 chars) = %s, want accepted", code)
	}

	// A method outside the whitelist never reaches params validation.
	//
	// This used to use "session.create", which CRD 0006 promoted into the
	// whitelist — the assertion had to move to a name that is still absent.
	for _, unknown := range []string{"session.delete", "shell.exec", "session.create.many"} {
		if code, ok := ValidateParams(unknown, json.RawMessage(`{}`)); ok || code != CodeUnknownMethod {
			t.Errorf("ValidateParams(%s) = %s ok=%v, want unknown_method", unknown, code, ok)
		}
	}
}

// TestTimeoutBudget covers §7.3: each method has its own default budget, and a
// client-supplied value is clamped to 1000–60000 ms rather than trusted.
func TestTimeoutBudget(t *testing.T) {
	defs := map[string]int{
		"sessions.list": 15000,
		"session.read":  15000,
		"session.send":  30000,
		"session.stop":  30000,
	}
	for method, want := range defs {
		if got := DefaultTimeoutMs(method); got != want {
			t.Errorf("DefaultTimeoutMs(%s) = %d, want %d", method, got, want)
		}
	}

	clamps := []struct{ in, want int }{
		{0, 15000},
		{-5, 15000},
		{1, 1000},
		{999, 1000},
		{1000, 1000},
		{45000, 45000},
		{60000, 60000},
		{60001, 60000},
		{1 << 30, 60000},
	}
	for _, tc := range clamps {
		if got := ClampTimeoutMs(tc.in, 15000); got != tc.want {
			t.Errorf("ClampTimeoutMs(%d) = %d, want %d", tc.in, got, tc.want)
		}
	}
}
