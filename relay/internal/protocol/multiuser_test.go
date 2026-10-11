package protocol

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestWorkBuddyIsAnExplicitToolIDForParamsAndResults(t *testing.T) {
	validParams := []struct {
		method string
		params string
	}{
		{"sessions.list", `{"tool":"workbuddy"}`},
		{"session.read", `{"tool":"workbuddy","sessionId":"shared-session"}`},
		{"session.send", `{"tool":"workbuddy","sessionId":"shared-session","text":"hello"}`},
	}
	for _, tc := range validParams {
		if code, ok := ValidateParams(tc.method, json.RawMessage(tc.params)); !ok {
			t.Errorf("ValidateParams(%s, %s) = %s, false", tc.method, tc.params, code)
		}
	}

	const result = `{"sessions":[{"id":"shared-session","tool":"workbuddy","title":"WorkBuddy chat","status":"idle","updatedAt":"2026-10-11T08:00:00Z","cwd":null}],"capabilities":{"tools":["workbuddy"]}}`
	if code, ok := ValidateResult("sessions.list", json.RawMessage(result)); !ok {
		t.Fatalf("ValidateResult accepted params but rejected a WorkBuddy result: %s", code)
	}
}

func TestHelloValidatesStableIdentityAndExplicitToolStatus(t *testing.T) {
	good, err := ParseFrame([]byte(`{"type":"hello","version":1,"clientId":"0f1c7a2e-9b64-4c5f-8f1a-2d3e4b5c6a70","ownerName":"Laptop","clientName":"DESKTOP-7F3A","capabilities":{"tools":["codex"],"toolStatus":{"workbuddy":{"available":false,"reason":"adapter unavailable"}}}}`))
	if err != nil {
		t.Fatal(err)
	}
	if err := good.ValidateHello(); err != nil {
		t.Fatalf("valid hello rejected: %v", err)
	}
	if status := good.Capabilities.ToolStatus["workbuddy"]; status.Available || status.Reason != "adapter unavailable" {
		t.Fatalf("toolStatus = %+v, want explicit unavailable status", status)
	}

	bad := []string{
		`{"type":"hello","version":1,"clientId":"NOT-A-UUID","clientName":"DESKTOP","capabilities":{}}`,
		`{"type":"hello","version":1,"ownerName":"   ","clientName":"DESKTOP","capabilities":{}}`,
		`{"type":"hello","version":1,"ownerName":"Laptop\u0085Name","clientName":"DESKTOP","capabilities":{}}`,
		`{"type":"hello","version":1,"clientName":"bad.name","capabilities":{}}`,
		`{"type":"hello","version":1,"clientName":"DESKTOP","capabilities":{"toolStatus":{"other":{"available":false}}}}`,
		`{"type":"hello","version":1,"clientName":"DESKTOP","capabilities":{"toolStatus":{"dsh":{"available":false,"reason":"` + strings.Repeat("x", 501) + `"}}}}`,
	}
	for _, raw := range bad {
		frame, err := ParseFrame([]byte(raw))
		if err != nil {
			t.Fatalf("ParseFrame should allow unknown/invalid semantic value through: %v", err)
		}
		if err := frame.ValidateHello(); err == nil {
			t.Errorf("ValidateHello accepted %s", raw)
		}
	}
}

func TestHelloPreservesExplicitWorkBuddyReadOnlySendingCapability(t *testing.T) {
	frame, err := ParseFrame([]byte(`{"type":"hello","version":1,"clientName":"DESKTOP","capabilities":{"tools":["workbuddy"],"session.read":true,"session.send":true,"session.send:workbuddy":false}}`))
	if err != nil || frame.ValidateHello() != nil {
		t.Fatalf("valid read-only WorkBuddy hello was rejected: %v", err)
	}
	if frame.Capabilities.SendWorkBuddy == nil || *frame.Capabilities.SendWorkBuddy {
		t.Fatal("explicit false was lost, enabling the legacy generic send capability")
	}
	encoded, err := json.Marshal(frame.Capabilities)
	if err != nil || !strings.Contains(string(encoded), `"session.send:workbuddy":false`) {
		t.Fatalf("read-only capability was not preserved: %s, %v", encoded, err)
	}
	legacy, err := ParseFrame([]byte(`{"type":"hello","version":1,"clientName":"DESKTOP","capabilities":{"tools":["codex"]}}`))
	if err != nil || legacy.Capabilities.SendWorkBuddy != nil {
		t.Fatalf("legacy absence should stay absent: %v", err)
	}
}
