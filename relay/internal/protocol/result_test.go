package protocol

import (
	"encoding/json"
	"testing"
)

// TestValidateResultShapes covers §9: the relay checks that every required
// field of the method's result is present and well typed, and passes extra
// fields through untouched — §12.4 forbids rejecting a newer desktop that adds
// a field.
func TestValidateResultShapes(t *testing.T) {
	good := []struct {
		method string
		result string
	}{
		{"sessions.list", `{"sessions":[{"id":"s1","tool":"codex","title":"t","status":"working","updatedAt":"2026-10-08T03:57:55Z","cwd":"D:\\w"}],"capabilities":{"tools":["codex"]}}`},
		{"sessions.list", `{"sessions":[],"capabilities":{}}`},
		{"sessions.list", `{"sessions":[{"id":"s1","tool":"dsh","title":"t","status":"idle","updatedAt":"2026-10-08T03:57:55Z","cwd":null}],"capabilities":{}}`},
		{"session.read", `{"id":"s1","tool":"codex","title":"t","status":"working","messages":[],"canStop":false}`},
		{"session.read", `{"id":"s1","tool":"codex","title":"t","status":"working","messages":[{"id":"m1","role":"user","text":"hi","timestamp":"2026-10-08T03:55:02Z"}],"canStop":true,"activeTurnId":"turn-7"}`},
		{"session.read", `{"id":"s1","tool":"codex","title":"t","status":"idle","messages":[],"canStop":false,"futureField":1}`},
		{"session.send", `{"accepted":true,"sessionId":"s1"}`},
		{"session.stop", `{"accepted":true,"sessionId":"s1"}`},
	}
	for _, tc := range good {
		if !json.Valid([]byte(tc.result)) {
			t.Fatalf("test fixture is not valid json: %s", tc.result)
		}
		if code, ok := ValidateResult(tc.method, json.RawMessage(tc.result)); !ok {
			t.Errorf("ValidateResult(%s, %s) = %s, want accepted", tc.method, tc.result, code)
		}
	}

	bad := []struct {
		method string
		result string
	}{
		{"sessions.list", `{}`},
		{"sessions.list", `{"capabilities":{}}`},
		{"sessions.list", `{"sessions":"x","capabilities":{}}`},
		{"sessions.list", `{"sessions":[{"id":"s1","tool":"codex","title":"t","status":"working","updatedAt":"2026-10-08T03:57:55Z"}],"capabilities":{}}`},
		{"sessions.list", `{"sessions":[{"id":"s1","tool":"codex","title":"t","status":"working","updatedAt":"2026-10-08T03:57:55Z","cwd":7}],"capabilities":{}}`},
		{"sessions.list", `{"sessions":[{"id":"s1","tool":"codex","title":"t","status":"working","updatedAt":"yesterday","cwd":null}],"capabilities":{}}`},
		{"sessions.list", `{"sessions":[{"id":"s1","tool":"codex","title":"","status":"working","updatedAt":"2026-10-08T03:57:55Z","cwd":null}],"capabilities":{}}`},
		{"session.read", `{"id":"s1","tool":"codex","title":"t","status":"working","messages":[]}`},
		{"session.read", `{"id":"s1","tool":"codex","title":"t","status":"working","messages":[{"id":"m1","role":"user","text":"hi"}],"canStop":false}`},
		{"session.read", `{"id":"s1","tool":"codex","title":"t","status":"working","messages":[],"canStop":"yes"}`},
		{"session.read", `{"id":"s1","tool":"codex","title":"t","status":"working","messages":[],"canStop":false,"activeTurnId":null}`},
		{"session.send", `{"accepted":true}`},
		{"session.send", `{"accepted":false,"sessionId":"s1"}`},
		{"session.stop", `{"accepted":true,"sessionId":""}`},
		{"session.send", `[]`},
		{"session.send", `not json`},
	}
	for _, tc := range bad {
		if code, ok := ValidateResult(tc.method, []byte(tc.result)); ok {
			t.Errorf("ValidateResult(%s, %s) accepted, want bridge_bad_response", tc.method, tc.result)
			continue
		} else if code != CodeBridgeBadResponse {
			t.Errorf("ValidateResult(%s, %s) = %s, want bridge_bad_response", tc.method, tc.result, code)
		}
	}
}

// TestUnknownStatusAndRolePassThrough covers §4.3, §4.4 and §12.4 rule 4: the
// relay neither rewrites nor guesses an unknown enum value, it passes it
// through.
//
// The opposite behaviour is a real trap: the desktop application only has to
// gain one new status value for every session.read to start failing with
// bridge_bad_response, in a product whose whole job is to follow a desktop that
// keeps evolving. `tool` is the one closed set (§4.5) and stays checked.
func TestUnknownStatusAndRolePassThrough(t *testing.T) {
	read := func(status, role string) string {
		return `{"id":"s1","tool":"codex","title":"t","status":"` + status +
			`","messages":[{"id":"m1","role":"` + role + `","text":"hi","timestamp":"2026-10-08T03:55:02Z"}],"canStop":false}`
	}

	for _, status := range []string{"paused", "waiting_for_user", "idle", "working", "stopped", "error"} {
		if code, ok := ValidateResult("session.read", json.RawMessage(read(status, "assistant"))); !ok {
			t.Errorf("status %q was refused with %s; §4.3 says pass it through", status, code)
		}
	}
	for _, role := range []string{"reasoning", "tool_result", "user", "assistant", "system", "tool"} {
		if code, ok := ValidateResult("session.read", json.RawMessage(read("idle", role))); !ok {
			t.Errorf("role %q was refused with %s; §4.4 says pass it through", role, code)
		}
	}

	list := `{"sessions":[{"id":"s1","tool":"codex","title":"t","status":"brand_new_state","updatedAt":"2026-10-08T03:57:55Z","cwd":null}],"capabilities":{}}`
	if code, ok := ValidateResult("sessions.list", json.RawMessage(list)); !ok {
		t.Errorf("an unknown status in sessions.list was refused with %s", code)
	}

	// Present but empty, or absent, is still a shape violation.
	bad := []string{
		`{"id":"s1","tool":"codex","title":"t","messages":[],"canStop":false}`,
		`{"id":"s1","tool":"codex","title":"t","status":"","messages":[],"canStop":false}`,
		`{"id":"s1","tool":"codex","title":"t","status":"idle","messages":[{"id":"m1","text":"hi","timestamp":"2026-10-08T03:55:02Z"}],"canStop":false}`,
		`{"id":"s1","tool":"codex","title":"t","status":"idle","messages":[{"id":"m1","role":"","text":"hi","timestamp":"2026-10-08T03:55:02Z"}],"canStop":false}`,
	}
	for _, result := range bad {
		if code, ok := ValidateResult("session.read", json.RawMessage(result)); ok {
			t.Errorf("ValidateResult(%s) accepted a missing or empty status/role", result)
		} else if code != CodeBridgeBadResponse {
			t.Errorf("ValidateResult(%s) = %s, want bridge_bad_response", result, code)
		}
	}

	// tool stays a closed set (§4.5).
	badTool := `{"id":"s1","tool":"claude","title":"t","status":"idle","messages":[],"canStop":false}`
	if _, ok := ValidateResult("session.read", json.RawMessage(badTool)); ok {
		t.Error("an unknown tool was accepted; §4.5 makes tool a closed set")
	}
}

// TestHistoryTruncatedIsOptionalAndPassedThrough covers CRD 0007: the flag is
// optional, is not inferred and is not defaulted. An older desktop that omits it
// must still be accepted; one that sends the wrong type must not be.
func TestHistoryTruncatedIsOptionalAndPassedThrough(t *testing.T) {
	base := `{"id":"s1","tool":"codex","title":"t","status":"idle","messages":[],"canStop":false`

	if code, ok := ValidateResult("session.read", json.RawMessage(base+`}`)); !ok {
		t.Errorf("omitting historyTruncated was refused with %s; it is optional", code)
	}
	if code, ok := ValidateResult("session.read", json.RawMessage(base+`,"historyTruncated":true}`)); !ok {
		t.Errorf("historyTruncated:true was refused with %s", code)
	}
	if code, ok := ValidateResult("session.read", json.RawMessage(base+`,"historyTruncated":false}`)); !ok {
		t.Errorf("historyTruncated:false was refused with %s", code)
	}
	for _, wrong := range []string{`"yes"`, `1`, `null`, `[]`} {
		result := base + `,"historyTruncated":` + wrong + `}`
		if code, ok := ValidateResult("session.read", json.RawMessage(result)); ok {
			t.Errorf("historyTruncated:%s was accepted, want bridge_bad_response", wrong)
		} else if code != CodeBridgeBadResponse {
			t.Errorf("historyTruncated:%s = %s, want bridge_bad_response", wrong, code)
		}
	}
}

// TestNewBusinessCodesAreDistinct pins CRD 0006's three codes beside
// unknown_method at HTTP 200, and — importantly — that tool_unavailable is not
// not_capable. One means "that source is closed right now", the other means
// "this session has no such ability"; showing the same text for both would tell
// the user to give up on a tool that is merely not running.
func TestNewBusinessCodesAreDistinct(t *testing.T) {
	for _, code := range []Code{CodeToolUnavailable, CodeModelNotAvailable, CodeSessionCreateFailed} {
		if got := code.HTTPStatus(); got != 200 {
			t.Errorf("%s.HTTPStatus() = %d, want 200", code, got)
		}
		if !code.BridgeReportable() {
			t.Errorf("%s is not bridge-reportable", code)
		}
		if code.CanonicalMessage() == "" {
			t.Errorf("%s has no canonical message", code)
		}
	}
	if CodeToolUnavailable.CanonicalMessage() == CodeNotCapable.CanonicalMessage() {
		t.Error("tool_unavailable and not_capable must not read the same to the user")
	}
	if CodeToolUnavailable == CodeNotCapable {
		t.Error("tool_unavailable must not be an alias of not_capable")
	}
	if !CodeNotCapable.BridgeReportable() {
		t.Error("not_capable must remain reportable")
	}
}
