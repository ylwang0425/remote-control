package server

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/ai-remote/relay/internal/protocol"
)

// The CRD 0008 additions, proved at the real seam: real HTTP in from the phone,
// a real WebSocket frame out to the desktop, and the answer back. The protocol
// package checks the rules; this file checks that the bytes actually travel —
// model, provider and reasoningEffort reach the desktop unchanged, an older
// phone's three-field call still does, and capabilities still passes through
// exactly as the desktop sent it.

// TestRPCSessionSendModelFieldsReachTheDesktop covers R25 end to end: the three
// new fields are forwarded untouched, and the legacy call is unchanged.
func TestRPCSessionSendModelFieldsReachTheDesktop(t *testing.T) {
	e := newEnv(t)
	c := e.helloBridge(protocol.Capabilities{
		SessionRead: true, SessionSend: true, Tools: []string{"codex", "dsh"},
	})
	cookie := e.pairOnce(c)

	forwarded := make(chan string, 4)
	go func() {
		for {
			f, ok := c.readRequestQuiet()
			if !ok {
				return
			}
			switch f.Method {
			case "session.send":
				forwarded <- string(f.Params)
				c.answer(f.ID, map[string]any{"accepted": true, "sessionId": "s1"})
			case "session.read":
				c.answer(f.ID, map[string]any{
					"id": "s1", "tool": "codex", "title": "t", "status": "idle",
					"messages": []any{}, "canStop": false,
				})
			}
		}
	}()

	// The pre-existing request, byte for byte as an older phone sends it.
	legacy := `{"method":"session.send","params":{"tool":"codex","sessionId":"s1","text":"继续"}}`
	resp := e.request("POST", "/api/rpc", testOrigin, "application/json", "rc_session="+cookie, legacy)
	body := readBody(t, resp)
	if resp.StatusCode != 200 || jsonField(t, body, "ok") != "true" {
		t.Fatalf("the legacy three-field send failed: status %d body %s", resp.StatusCode, body)
	}
	if got := <-forwarded; got != `{"tool":"codex","sessionId":"s1","text":"继续"}` {
		t.Fatalf("legacy params changed in transit: %s", got)
	}
	// §9.3's result shape must not have grown: the model choice is input, not an
	// acknowledgement.
	if got := strings.TrimSpace(body); !strings.Contains(got, `"result":{"accepted":true,"sessionId":"s1"}`) {
		t.Errorf("session.send result shape changed: %s", got)
	}

	// The new request: all three fields, with a provider name carrying the
	// punctuation real ones use.
	extended := `{"method":"session.send","params":{"tool":"dsh","sessionId":"s1","text":"继续",` +
		`"model":"deepseek-reasoner","provider":"azure-openai/us-east-1","reasoningEffort":"high"}}`
	resp = e.request("POST", "/api/rpc", testOrigin, "application/json", "rc_session="+cookie, extended)
	body = readBody(t, resp)
	if resp.StatusCode != 200 || jsonField(t, body, "ok") != "true" {
		t.Fatalf("the extended send failed: status %d body %s", resp.StatusCode, body)
	}
	got := <-forwarded
	for _, want := range []string{`"model":"deepseek-reasoner"`, `"provider":"azure-openai/us-east-1"`, `"reasoningEffort":"high"`} {
		if !strings.Contains(got, want) {
			t.Errorf("the desktop did not receive %s (got %s)", want, got)
		}
	}
	// The result still carries no model fields of its own.
	if strings.Contains(body, "currentModel") || strings.Contains(body, "reasoningEffort") {
		t.Errorf("session.send's result grew a model field: %s", body)
	}

	// A routing field with no model is refused at HTTP 200 with invalid_params,
	// and the desktop never sees the call at all.
	bad := `{"method":"session.send","params":{"tool":"dsh","sessionId":"s1","text":"继续","provider":"deepseek"}}`
	decodeFailure(t, e.request("POST", "/api/rpc", testOrigin, "application/json", "rc_session="+cookie, bad),
		200, protocol.CodeInvalidParams)
	select {
	case leaked := <-forwarded:
		t.Fatalf("a refused send still reached the desktop: %s", leaked)
	default:
	}
}

// TestRPCSessionReadCurrentModelAndCapabilitiesPassthrough covers R26 and R27 at
// the seam: currentModel travels straight through when the desktop sends it,
// stays absent when it does not, and the capabilities object is passed on
// exactly as received — not merged, not inferred, and with no new bit.
func TestRPCSessionReadCurrentModelAndCapabilitiesPassthrough(t *testing.T) {
	e := newEnv(t)
	c := e.helloBridge(protocol.Capabilities{
		SessionRead: true, Tools: []string{"codex", "dsh"},
	})
	cookie := e.pairOnce(c)

	// An old-style capabilities object, verbatim, and one reply that carries
	// currentModel. Neither the relay nor this test builds either one.
	const capabilities = `{"session.read":true,"sessions.list":true,"future.capability":true,"tools":["codex","dsh"]}`

	replies := []string{
		`{"id":"s1","tool":"codex","title":"t","status":"idle","messages":[],"canStop":false,` +
			`"currentModel":{"model":"deepseek-reasoner","provider":"azure-openai/us-east-1","reasoningEffort":"high"},` +
			`"historyTruncated":true,"capabilities":` + capabilities + `}`,
		`{"id":"s1","tool":"codex","title":"t","status":"idle","messages":[],"canStop":false,` +
			`"historyTruncated":false,"capabilities":` + capabilities + `}`,
	}
	go func() {
		for _, result := range replies {
			f, ok := c.readRequestQuiet()
			if !ok {
				return
			}
			c.send(map[string]any{
				"type": "response", "id": f.ID, "ok": true,
				"result": json.RawMessage(result),
			})
		}
	}()

	call := func() map[string]any {
		t.Helper()
		resp := e.request("POST", "/api/rpc", testOrigin, "application/json", "rc_session="+cookie,
			`{"method":"session.read","params":{"tool":"codex","sessionId":"s1"}}`)
		body := readBody(t, resp)
		if resp.StatusCode != 200 {
			t.Fatalf("session.read status = %d, want 200 (body %s)", resp.StatusCode, body)
		}
		var decoded struct {
			OK     bool           `json:"ok"`
			Result map[string]any `json:"result"`
		}
		if err := json.Unmarshal([]byte(body), &decoded); err != nil {
			t.Fatalf("body is not json: %s", body)
		}
		if !decoded.OK {
			t.Fatalf("session.read failed: %s", body)
		}
		return decoded.Result
	}

	first := call()
	model, ok := first["currentModel"].(map[string]any)
	if !ok {
		t.Fatalf("currentModel did not survive the round trip: %v", first["currentModel"])
	}
	if model["model"] != "deepseek-reasoner" || model["provider"] != "azure-openai/us-east-1" || model["reasoningEffort"] != "high" {
		t.Errorf("currentModel was rewritten in transit: %v", model)
	}
	if first["historyTruncated"] != true {
		t.Errorf("historyTruncated changed: %v", first["historyTruncated"])
	}
	caps, ok := first["capabilities"].(map[string]any)
	if !ok {
		t.Fatalf("capabilities did not survive: %v", first["capabilities"])
	}
	if caps["future.capability"] != true || caps["session.read"] != true {
		t.Errorf("capabilities were merged or filtered: %v", caps)
	}
	if len(caps) != 4 {
		t.Errorf("capabilities gained or lost a key: %v", caps)
	}

	// The desktop that sends no currentModel gets no invented one.
	second := call()
	if got, present := second["currentModel"]; present {
		t.Errorf("the relay fabricated a currentModel: %v", got)
	}
	if second["historyTruncated"] != false {
		t.Errorf("historyTruncated:false did not survive: %v", second["historyTruncated"])
	}
}
