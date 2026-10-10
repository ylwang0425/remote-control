package protocol

import (
	"encoding/json"
	"strings"
	"testing"
)

// The two methods added by the extension contract. Everything else in the
// package must keep working: the old four stay exactly as they were, and the
// wire version stays 1 so an older desktop is not shut out.

// TestMethodsIncludeTheNewTwo covers the whitelist: eight names, the original
// four unchanged and in place, and the answer/approval pair appended.
func TestMethodsIncludeTheNewTwo(t *testing.T) {
	want := []string{
		"sessions.list", "session.read", "session.send", "session.stop",
		"models.list", "session.create", "session.answer", "session.approve",
	}
	if len(Methods) != len(want) {
		t.Fatalf("Methods = %v, want exactly %v", Methods, want)
	}
	for i, name := range want {
		if Methods[i] != name {
			t.Fatalf("Methods[%d] = %q, want %q", i, Methods[i], name)
		}
	}
}

// TestModelsListParams covers §7.3-style tightening for models.list: tool is
// required and nothing else is allowed.
func TestModelsListParams(t *testing.T) {
	accepted := []string{
		`{"tool":"codex"}`,
		`{"tool":"dsh"}`,
	}
	for _, params := range accepted {
		if code, ok := ValidateParams("models.list", json.RawMessage(params)); !ok {
			t.Errorf("ValidateParams(models.list, %s) = %s, want accepted", params, code)
		}
	}

	rejected := []struct {
		params string
		want   Code
	}{
		{`{}`, CodeInvalidParams},                // tool is required here
		{`{"tool":"claude"}`, CodeInvalidParams}, // not a session source
		{`{"tool":""}`, CodeInvalidParams},
		{`{"tool":"codex","model":"x"}`, CodeInvalidParams}, // field outside the whitelist
		{`{"tool":"codex","sessionId":"s1"}`, CodeInvalidParams},
		{`[]`, CodeInvalidParams},
		{`"codex"`, CodeInvalidParams},
	}
	for _, tc := range rejected {
		if code, ok := ValidateParams("models.list", json.RawMessage(tc.params)); ok {
			t.Errorf("ValidateParams(models.list, %s) accepted, want %s", tc.params, tc.want)
		} else if code != tc.want {
			t.Errorf("ValidateParams(models.list, %s) = %s, want %s", tc.params, code, tc.want)
		}
	}
}

// TestSessionCreateParams covers the new create call's whitelist, its required
// fields and the DSH provider rule.
func TestSessionCreateParams(t *testing.T) {
	valid := []string{
		// codex: provider is optional.
		`{"tool":"codex","model":"gpt-5-codex","requestId":"3f2504e0-4f89-41d3-9a0c-0305e82c3301"}`,
		// dsh: provider is required.
		`{"tool":"dsh","model":"deepseek-chat","provider":"deepseek","requestId":"3f2504e0-4f89-41d3-9a0c-0305e82c3301"}`,
		// every optional field at once, with a Windows cwd and a native projectId.
		`{"tool":"dsh","model":"deepseek-reasoner","provider":"deepseek","reasoningEffort":"high","cwd":"D:\\workspace\\codex-workspace\\remote-control","projectId":"proj_01H9-XYZ:abc","text":"继续","requestId":"3f2504e0-4f89-41d3-9a0c-0305e82c3301"}`,
		// a provider name with the punctuation real providers use.
		`{"tool":"dsh","model":"m","provider":"azure-openai/us-east-1","requestId":"3f2504e0-4f89-41d3-9a0c-0305e82c3301"}`,
	}
	for _, params := range valid {
		if code, ok := ValidateParams("session.create", json.RawMessage(params)); !ok {
			t.Errorf("ValidateParams(session.create, %s) = %s, want accepted", params, code)
		}
	}

	rejected := []struct {
		name   string
		params string
		want   Code
	}{
		{"no tool", `{"model":"m","requestId":"3f2504e0-4f89-41d3-9a0c-0305e82c3301"}`, CodeInvalidParams},
		{"no model", `{"tool":"codex","requestId":"3f2504e0-4f89-41d3-9a0c-0305e82c3301"}`, CodeInvalidParams},
		{"dsh without provider", `{"tool":"dsh","model":"m","requestId":"3f2504e0-4f89-41d3-9a0c-0305e82c3301"}`, CodeInvalidParams},
		{"no requestId", `{"tool":"codex","model":"m"}`, CodeInvalidParams},
		{"provider on codex", `{"tool":"codex","model":"m","provider":"openai","requestId":"3f2504e0-4f89-41d3-9a0c-0305e82c3301"}`, CodeInvalidParams},
		{"requestId is not a v4 uuid", `{"tool":"codex","model":"m","requestId":"not-a-uuid"}`, CodeInvalidParams},
		{"requestId is an upper-case uuid", `{"tool":"codex","model":"m","requestId":"3F2504E0-4F89-41D3-9A0C-0305E82C3301"}`, CodeInvalidParams},
		{"unknown field", `{"tool":"codex","model":"m","requestId":"3f2504e0-4f89-41d3-9a0c-0305e82c3301","sudo":true}`, CodeInvalidParams},
		{"unknown tool", `{"tool":"claude","model":"m","requestId":"3f2504e0-4f89-41d3-9a0c-0305e82c3301"}`, CodeInvalidParams},
		{"empty model", `{"tool":"codex","model":"","requestId":"3f2504e0-4f89-41d3-9a0c-0305e82c3301"}`, CodeInvalidParams},
		{"NUL in cwd", `{"tool":"codex","model":"m","cwd":"D:\\a\u0000b","requestId":"3f2504e0-4f89-41d3-9a0c-0305e82c3301"}`, CodeInvalidParams},
		{"newline in provider", `{"tool":"dsh","model":"m","provider":"a\nb","requestId":"3f2504e0-4f89-41d3-9a0c-0305e82c3301"}`, CodeInvalidParams},
		{"empty requestId", `{"tool":"codex","model":"m","requestId":""}`, CodeInvalidParams},
		{"params is an array", `[]`, CodeInvalidParams},
	}
	for _, tc := range rejected {
		if code, ok := ValidateParams("session.create", json.RawMessage(tc.params)); ok {
			t.Errorf("%s: accepted, want %s", tc.name, tc.want)
		} else if code != tc.want {
			t.Errorf("%s: = %s, want %s", tc.name, code, tc.want)
		}
	}

	// The text ceiling is the same 16384 as session.send, with its own code.
	tooLong := `{"tool":"codex","model":"m","requestId":"3f2504e0-4f89-41d3-9a0c-0305e82c3301","text":"` +
		strings.Repeat("a", MaxTextRunes+1) + `"}`
	if code, ok := ValidateParams("session.create", json.RawMessage(tooLong)); ok || code != CodeTooLong {
		t.Errorf("over-long create text = %s ok=%v, want too_long", code, ok)
	}
}

// TestSecurityChecksDoNotBlockLegitimateValues is the point of the previous
// test made explicit: the fields the extension adds are opaque to the relay. A
// provider name, a Windows path and a native project id must survive untouched,
// because the relay does not own any of those namespaces and guessing at them
// would break the desktop.
func TestSecurityChecksDoNotBlockLegitimateValues(t *testing.T) {
	cases := []string{
		`{"tool":"dsh","model":"deepseek-reasoner","provider":"deepseek","cwd":"D:\\workspace\\codex-workspace\\remote-control","projectId":"0f1c7a2e-9b64-4c5f-8f1a-2d3e4b5c6a70","requestId":"3f2504e0-4f89-41d3-9a0c-0305e82c3301"}`,
		`{"tool":"dsh","model":"m","provider":"openai","cwd":"C:\\Users\\Hi\\.codex","projectId":"p-1","requestId":"3f2504e0-4f89-41d3-9a0c-0305e82c3301"}`,
		`{"tool":"dsh","model":"m","provider":"anthropic","cwd":"/home/user/project","projectId":"native:project:42","requestId":"3f2504e0-4f89-41d3-9a0c-0305e82c3301"}`,
		`{"tool":"dsh","model":"m","provider":"bedrock","cwd":"\\\\server\\share\\project","projectId":"P_1.2-3","requestId":"3f2504e0-4f89-41d3-9a0c-0305e82c3301"}`,
	}
	for _, params := range cases {
		if code, ok := ValidateParams("session.create", json.RawMessage(params)); !ok {
			t.Errorf("a legitimate create was refused (%s): %s", code, params)
		}
	}
}

// TestDefaultTimeoutForNewMethods pins the budgets for the two new calls.
func TestDefaultTimeoutForNewMethods(t *testing.T) {
	cases := map[string]int{
		"models.list":    15000,
		"session.create": 30000,
	}
	for method, want := range cases {
		if got := DefaultTimeoutMs(method); got != want {
			t.Errorf("DefaultTimeoutMs(%s) = %d, want %d", method, got, want)
		}
	}
	// The four original budgets must not have moved.
	original := map[string]int{"sessions.list": 15000, "session.read": 15000, "session.send": 30000, "session.stop": 30000}
	for method, want := range original {
		if got := DefaultTimeoutMs(method); got != want {
			t.Errorf("DefaultTimeoutMs(%s) changed to %d, want the original %d", method, got, want)
		}
	}
}

// TestValidateResultModelsList covers the new result shape.
func TestValidateResultModelsList(t *testing.T) {
	good := []string{
		`{"tool":"codex","models":[]}`,
		`{"tool":"codex","models":[{"id":"gpt-5-codex","label":"GPT-5 Codex"}]}`,
		`{"tool":"dsh","models":[{"id":"deepseek-chat","label":"DeepSeek Chat","provider":"deepseek","isDefault":true,"reasoningEfforts":["low","medium","high"],"defaultReasoningEffort":"medium"}],"projects":[{"id":"p1","name":"remote-control","cwd":"D:\\workspace\\codex-workspace\\remote-control"}]}`,
		`{"tool":"codex","models":[{"id":"m","label":"M","futureField":1}],"projects":[]}`,
	}
	for _, result := range good {
		if code, ok := ValidateResult("models.list", json.RawMessage(result)); !ok {
			t.Errorf("ValidateResult(models.list, %s) = %s, want accepted", result, code)
		}
	}

	bad := []string{
		`{}`,
		`{"tool":"codex"}`,
		`{"models":[]}`,
		`{"tool":"codex","models":"none"}`,
		`{"tool":"codex","models":[{"label":"no id"}]}`,
		`{"tool":"codex","models":[{"id":"m"}]}`,
		`{"tool":"codex","models":[{"id":"","label":"M"}]}`,
		`{"tool":"codex","models":[{"id":"m","label":""}]}`,
		`{"tool":"claude","models":[]}`,
		`{"tool":"codex","models":[],"projects":"none"}`,
		`{"tool":"codex","models":[],"projects":[{"id":"p1","name":"n"}]}`,
		`not json`,
	}
	for _, result := range bad {
		if code, ok := ValidateResult("models.list", json.RawMessage(result)); ok {
			t.Errorf("ValidateResult(models.list, %s) accepted, want bridge_bad_response", result)
		} else if code != CodeBridgeBadResponse {
			t.Errorf("ValidateResult(models.list, %s) = %s, want bridge_bad_response", result, code)
		}
	}
}

// TestValidateResultSessionCreate covers the create result shape: a sessionId,
// never an `accepted` acknowledgement, because a create either produced a
// session or it did not.
func TestValidateResultSessionCreate(t *testing.T) {
	good := []string{
		`{"sessionId":"0f1c7a2e-9b64-4c5f-8f1a-2d3e4b5c6a70","tool":"codex","model":"gpt-5-codex"}`,
		`{"sessionId":"s1","tool":"dsh","title":"t","model":"deepseek-chat","provider":"deepseek","reasoningEffort":"high"}`,
		`{"sessionId":"s1","tool":"codex","model":"m","futureField":true}`,
	}
	for _, result := range good {
		if code, ok := ValidateResult("session.create", json.RawMessage(result)); !ok {
			t.Errorf("ValidateResult(session.create, %s) = %s, want accepted", result, code)
		}
	}

	bad := []string{
		`{}`,
		`{"tool":"codex","model":"m"}`,
		`{"sessionId":"s1","model":"m"}`,
		`{"sessionId":"s1","tool":"codex"}`,
		`{"sessionId":"","tool":"codex","model":"m"}`,
		`{"sessionId":"s1","tool":"codex","model":""}`,
		`{"accepted":true,"sessionId":"s1"}`,
		`{"sessionId":"has space","tool":"codex","model":"m"}`,
		`[]`,
	}
	for _, result := range bad {
		if code, ok := ValidateResult("session.create", json.RawMessage(result)); ok {
			t.Errorf("ValidateResult(session.create, %s) accepted, want bridge_bad_response", result)
		} else if code != CodeBridgeBadResponse {
			t.Errorf("ValidateResult(session.create, %s) = %s, want bridge_bad_response", result, code)
		}
	}
}

// TestCapabilitiesGainedTwoOptionalKeys covers the hello extension: two new
// booleans, additive, absent meaning false. An older desktop that does not send
// them must still be accepted.
func TestCapabilitiesGainedTwoOptionalKeys(t *testing.T) {
	var caps Capabilities
	if err := json.Unmarshal([]byte(`{"sessions.list":true,"tools":["codex"]}`), &caps); err != nil {
		t.Fatalf("Unmarshal of an old-style capabilities object failed: %v", err)
	}
	if caps.ModelsList || caps.SessionCreate {
		t.Fatal("an absent capability key must read as false")
	}

	var full Capabilities
	if err := json.Unmarshal([]byte(`{"models.list":true,"session.create":true,"tools":["codex","dsh"]}`), &full); err != nil {
		t.Fatalf("Unmarshal returned error: %v", err)
	}
	if !full.ModelsList || !full.SessionCreate {
		t.Fatal("the two new capability keys did not decode")
	}

	// An older desktop's hello still validates: version stays 1.
	frame, err := ParseFrame([]byte(`{"type":"hello","version":1,"clientName":"OLD","capabilities":{"sessions.list":true,"tools":["codex"]}}`))
	if err != nil {
		t.Fatalf("ParseFrame returned error: %v", err)
	}
	if err := frame.ValidateHello(); err != nil {
		t.Fatalf("an older desktop's hello was refused: %v", err)
	}
	if Version != 1 {
		t.Fatalf("Version = %d; the wire version must stay 1 for older clients", Version)
	}
}
