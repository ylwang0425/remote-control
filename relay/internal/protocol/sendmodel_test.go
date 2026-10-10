package protocol

import (
	"encoding/json"
	"testing"
)

// CRD 0008 §5: session.send gains three optional params — model, provider and
// reasoningEffort — and nothing else moves. The relay validates the shape and
// the combinations only; which provider owns which model is the computer's
// question, so no catalogue knowledge belongs in this package.
//
// The three tests below are the relay's whole share of that extension.

// TestSessionSendAcceptsModelFields is the additive half of R25. The whitelist
// grows by exactly three fields, and the request that existed before it must
// keep working byte for byte: an old phone sends tool, sessionId and text and
// expects pure forwarding, not a new requirement.
func TestSessionSendAcceptsModelFields(t *testing.T) {
	legacy := `{"tool":"codex","sessionId":"s1","text":"继续"}`
	if code, ok := ValidateParams("session.send", json.RawMessage(legacy)); !ok {
		t.Fatalf("the pre-existing three-field request was refused with %s; "+
			"R25 requires old clients to keep working", code)
	}

	accepted := []struct {
		name   string
		params string
	}{
		// All three omitted is the legacy request again, spelled out.
		{"all three omitted", `{"tool":"codex","sessionId":"s1","text":"hi"}`},
		// The three new fields, one at a time. A DSH model choice carries its
		// provider with it, because one model id can exist under several DSH
		// providers and a model without a provider is an ambiguous route.
		{"model only", `{"tool":"codex","sessionId":"s1","text":"hi","model":"gpt-5-codex"}`},
		{"model and provider", `{"tool":"dsh","sessionId":"s1","text":"hi","model":"deepseek-chat","provider":"deepseek"}`},
		{"model and reasoningEffort with a provider", `{"tool":"dsh","sessionId":"s1","text":"hi","model":"deepseek-reasoner","provider":"deepseek","reasoningEffort":"high"}`},
		{"all three", `{"tool":"dsh","sessionId":"s1","text":"hi","model":"deepseek-reasoner","provider":"azure-openai/us-east-1","reasoningEffort":"high"}`},
	}
	for _, tc := range accepted {
		if code, ok := ValidateParams("session.send", json.RawMessage(tc.params)); !ok {
			t.Errorf("%s: ValidateParams(session.send, %s) = %s, want accepted", tc.name, tc.params, code)
		}
	}

	// A field outside the whitelist is invalid_params however harmless it looks,
	// and the model fields do not open a door for anything else.
	rejected := []struct {
		name   string
		params string
	}{
		{"thinking is not a field", `{"tool":"codex","sessionId":"s1","text":"hi","thinking":"high"}`},
		{"timeoutMs is not a field", `{"tool":"codex","sessionId":"s1","text":"hi","timeoutMs":1000}`},
		{"cwd is not a send field", `{"tool":"codex","sessionId":"s1","text":"hi","cwd":"D:\\w"}`},
		{"projectId is not a send field", `{"tool":"codex","sessionId":"s1","text":"hi","projectId":"p1"}`},
		{"requestId is not a send field", `{"tool":"codex","sessionId":"s1","text":"hi","requestId":"3f2504e0-4f89-41d3-9a0c-0305e82c3301"}`},
		{"a shell door is not a field", `{"tool":"codex","sessionId":"s1","text":"hi","command":"rm -rf /"}`},
		{"a caller bypass is not a field", `{"tool":"codex","sessionId":"s1","text":"hi","callerSource":"relay"}`},
	}
	for _, tc := range rejected {
		code, ok := ValidateParams("session.send", json.RawMessage(tc.params))
		if ok {
			t.Errorf("%s: %s was accepted, want invalid_params", tc.name, tc.params)
			continue
		}
		if code != CodeInvalidParams {
			t.Errorf("%s: = %s, want invalid_params", tc.name, code)
		}
	}
}

// TestSessionSendModelCombinationRules is the other half of R25: the three new
// fields are not free-standing. A routing field with no model to route is a
// client bug, and guessing which model it meant is how a message lands on the
// wrong one — so it is refused rather than repaired.
func TestSessionSendModelCombinationRules(t *testing.T) {
	rejected := []struct {
		name   string
		params string
	}{
		{"provider without model",
			`{"tool":"dsh","sessionId":"s1","text":"hi","provider":"deepseek"}`},
		{"reasoningEffort without model",
			`{"tool":"dsh","sessionId":"s1","text":"hi","reasoningEffort":"high"}`},
		{"provider and reasoningEffort without model",
			`{"tool":"dsh","sessionId":"s1","text":"hi","provider":"deepseek","reasoningEffort":"high"}`},
		// The provider half of the rule is per tool. DSH genuinely has one model
		// id reachable through several providers, so a DSH model choice with no
		// provider is ambiguous and is refused rather than resolved by guess.
		{"dsh model without provider",
			`{"tool":"dsh","sessionId":"s1","text":"hi","model":"deepseek-reasoner"}`},
		{"dsh model and reasoningEffort without provider",
			`{"tool":"dsh","sessionId":"s1","text":"hi","model":"deepseek-reasoner","reasoningEffort":"high"}`},
		// Codex has exactly one route, so a provider there is a client bug. A
		// silently dropped provider is how a Codex message would quietly go to
		// the default provider instead of the one the caller named.
		{"provider on codex",
			`{"tool":"codex","sessionId":"s1","text":"hi","model":"gpt-5-codex","provider":"openai"}`},
		{"provider and effort on codex",
			`{"tool":"codex","sessionId":"s1","text":"hi","model":"gpt-5-codex","provider":"openai","reasoningEffort":"high"}`},
	}
	for _, tc := range rejected {
		code, ok := ValidateParams("session.send", json.RawMessage(tc.params))
		if ok {
			t.Errorf("%s: %s was accepted, want invalid_params", tc.name, tc.params)
			continue
		}
		if code != CodeInvalidParams {
			t.Errorf("%s: = %s, want invalid_params", tc.name, code)
		}
	}

	// With a model present and the provider the tool actually requires, the
	// rule above must be about the missing provider and nothing else.
	accepted := []string{
		`{"tool":"dsh","sessionId":"s1","text":"hi","model":"deepseek-chat","provider":"deepseek"}`,
		`{"tool":"dsh","sessionId":"s1","text":"hi","model":"deepseek-chat","provider":"deepseek","reasoningEffort":"high"}`,
		// Codex keeps working with a bare model, and with an effort and no
		// provider.
		`{"tool":"codex","sessionId":"s1","text":"hi","model":"gpt-5-codex"}`,
		`{"tool":"codex","sessionId":"s1","text":"hi","model":"gpt-5-codex","reasoningEffort":"high"}`,
	}
	for _, params := range accepted {
		if code, ok := ValidateParams("session.send", json.RawMessage(params)); !ok {
			t.Errorf("%s: = %s, want accepted (a model is present)", params, code)
		}
	}
}

// TestSessionSendModelFieldShapes covers the shape rule for the three new
// fields. The relay does not own their namespaces — "which provider really has
// this model" is the computer's question — but it does own the frame they
// travel in, so each one, when present, must be a bounded, printable,
// non-blank string. A wrong type is invalid_params, not a crash and not a
// silently dropped field.
func TestSessionSendModelFieldShapes(t *testing.T) {
	rejected := []struct {
		name   string
		params string
	}{
		{"model is not a string", `{"tool":"codex","sessionId":"s1","text":"hi","model":123}`},
		{"model is null", `{"tool":"codex","sessionId":"s1","text":"hi","model":null}`},
		{"model is blank", `{"tool":"codex","sessionId":"s1","text":"hi","model":"   "}`},
		{"model has a control character", `{"tool":"codex","sessionId":"s1","text":"hi","model":"a\nb"}`},
		{"provider is not a string", `{"tool":"dsh","sessionId":"s1","text":"hi","model":"m","provider":7}`},
		{"provider is null", `{"tool":"dsh","sessionId":"s1","text":"hi","model":"m","provider":null}`},
		{"provider is blank", `{"tool":"dsh","sessionId":"s1","text":"hi","model":"m","provider":""}`},
		{"reasoningEffort is not a string", `{"tool":"dsh","sessionId":"s1","text":"hi","model":"m","reasoningEffort":true}`},
		{"reasoningEffort is null", `{"tool":"dsh","sessionId":"s1","text":"hi","model":"m","reasoningEffort":null}`},
		{"reasoningEffort is blank", `{"tool":"dsh","sessionId":"s1","text":"hi","model":"m","reasoningEffort":"  "}`},
	}
	for _, tc := range rejected {
		code, ok := ValidateParams("session.send", json.RawMessage(tc.params))
		if ok {
			t.Errorf("%s: %s was accepted, want invalid_params", tc.name, tc.params)
			continue
		}
		if code != CodeInvalidParams {
			t.Errorf("%s: = %s, want invalid_params", tc.name, code)
		}
	}

	// The namespaces are opaque: real names must survive untouched, punctuation
	// and all.
	accepted := []string{
		`{"tool":"dsh","sessionId":"s1","text":"hi","model":"deepseek-reasoner","provider":"azure-openai/us-east-1"}`,
		`{"tool":"codex","sessionId":"s1","text":"hi","model":"gpt-5-codex"}`,
		`{"tool":"dsh","sessionId":"s1","text":"hi","model":"m","provider":"bedrock","reasoningEffort":"x-high_1.2"}`,
	}
	for _, params := range accepted {
		if code, ok := ValidateParams("session.send", json.RawMessage(params)); !ok {
			t.Errorf("a legitimate send was refused (%s): %s", code, params)
		}
	}
}

// TestSessionSendModelFieldsSurviveForwarding pins the relay's whole job for
// these three fields: it forwards them, and it does not touch them on the way.
// The relay has no catalogue of its own — which provider owns which model is
// the computer's answer — so the only correct behaviour is to pass the names
// through byte for byte and let the desktop refuse a pair it does not know.
func TestSessionSendModelFieldsSurviveForwarding(t *testing.T) {
	params := json.RawMessage(`{"tool":"dsh","sessionId":"s1","text":"hi","model":"deepseek-reasoner","provider":"azure-openai/us-east-1","reasoningEffort":"high"}`)
	frame := &Frame{Type: FrameRequest, Method: "session.send", Params: params}

	encoded, err := json.Marshal(frame)
	if err != nil {
		t.Fatalf("marshal frame: %v", err)
	}
	parsed, err := ParseFrame(encoded)
	if err != nil {
		t.Fatalf("parse frame: %v", err)
	}

	var forwarded map[string]json.RawMessage
	if err := json.Unmarshal(parsed.Params, &forwarded); err != nil {
		t.Fatalf("params did not survive the frame round trip: %v", err)
	}
	for field, want := range map[string]string{
		"model":           `"deepseek-reasoner"`,
		"provider":        `"azure-openai/us-east-1"`,
		"reasoningEffort": `"high"`,
	} {
		if got := string(forwarded[field]); got != want {
			t.Errorf("forwarded %s = %s, want %s", field, got, want)
		}
	}
}

// TestSessionSendResultShapeDidNotGrow pins the other half of R25's
// compatibility promise: the model choice is an input, not an acknowledgement,
// so §9.3's result stays exactly {accepted:true, sessionId}. A phone that has
// never heard of these fields must be able to keep reading the answer.
func TestSessionSendResultShapeDidNotGrow(t *testing.T) {
	legacy := `{"accepted":true,"sessionId":"s1"}`
	if code, ok := ValidateResult("session.send", json.RawMessage(legacy)); !ok {
		t.Fatalf("the pre-existing session.send result was refused with %s", code)
	}

	// A result that claims a model it never sent is not a shape the relay
	// demands or produces; only the three §9.3 fields are required, and the
	// relay's own answer is built from them alone (checked at the seam in
	// internal/server).
	var decoded map[string]json.RawMessage
	if err := json.Unmarshal([]byte(legacy), &decoded); err != nil {
		t.Fatalf("fixture is not json: %v", err)
	}
	if len(decoded) != 2 {
		t.Fatalf("the fixture no longer holds §9.3's two fields: %v", decoded)
	}
}

// TestSessionReadCurrentModelIsOptional covers R26. currentModel is the
// desktop's report of the model its own session is really set to, so it comes
// from native state or not at all: the relay adds no default and invents none.
// Omitting it stays legal for exactly that reason — a desktop that cannot read
// its own selected model, and every older desktop, must keep working.
func TestSessionReadCurrentModelIsOptional(t *testing.T) {
	base := `{"id":"s1","tool":"codex","title":"t","status":"idle","messages":[],"canStop":false`

	accepted := []struct {
		name   string
		result string
	}{
		{"omitted (older desktop)", base + `}`},
		{"model only", base + `,"currentModel":{"model":"deepseek-reasoner"}}`},
		{"model and provider", base + `,"currentModel":{"model":"deepseek-reasoner","provider":"deepseek"}}`},
		{"all three", base + `,"currentModel":{"model":"deepseek-reasoner","provider":"azure-openai/us-east-1","reasoningEffort":"high"}}`},
		{"an unknown extra member is passed through", base + `,"currentModel":{"model":"m","futureField":1}}`},
	}
	for _, tc := range accepted {
		if code, ok := ValidateResult("session.read", json.RawMessage(tc.result)); !ok {
			t.Errorf("%s: ValidateResult(session.read, %s) = %s, want accepted", tc.name, tc.result, code)
		}
	}

	rejected := []struct {
		name   string
		result string
	}{
		{"no model", base + `,"currentModel":{}}`},
		{"model is null", base + `,"currentModel":{"model":null}}`},
		{"model is not a string", base + `,"currentModel":{"model":123}}`},
		{"model is blank", base + `,"currentModel":{"model":"   "}}`},
		{"provider is not a string", base + `,"currentModel":{"model":"m","provider":7}}`},
		{"provider is null", base + `,"currentModel":{"model":"m","provider":null}}`},
		{"reasoningEffort is not a string", base + `,"currentModel":{"model":"m","reasoningEffort":true}}`},
		{"reasoningEffort is null", base + `,"currentModel":{"model":"m","reasoningEffort":null}}`},
		{"currentModel is null", base + `,"currentModel":null}`},
		{"currentModel is not an object", base + `,"currentModel":"m"}`},
		{"currentModel is an array", base + `,"currentModel":[]}`},
	}
	for _, tc := range rejected {
		code, ok := ValidateResult("session.read", json.RawMessage(tc.result))
		if ok {
			t.Errorf("%s: %s was accepted, want bridge_bad_response", tc.name, tc.result)
			continue
		}
		if code != CodeBridgeBadResponse {
			t.Errorf("%s: = %s, want bridge_bad_response", tc.name, code)
		}
	}
}
