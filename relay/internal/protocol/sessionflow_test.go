package protocol

import (
	"encoding/json"
	"strings"
	"testing"
)

// The params half of session.answer and session.approve. Everything the relay
// checks here is shape, bound or cardinality: which question is genuinely open
// and which approval is genuinely pending is the computer's question, because
// the live map of open callIds and pending event ids exists only there. What
// the relay must not do is forward a malformed, oversized, duplicated or
// unrepresentable form and let it fail half-way through a native mutation.

const (
	testCallID     = "call-7f3a-11ef"
	testApprovalID = "8f14e45f-ceea-467a-9c1c-1f2a3b4c5d6e"
	testSessionID  = "0f1c7a2e-9b64-4c5f-8f1a-2d3e4b5c6a70"
)

// TestSessionAnswerParams covers the answer call's whitelist, its required
// fields and the two shape rules that make a batch meaningful.
func TestSessionAnswerParams(t *testing.T) {
	accepted := []struct {
		name   string
		params string
	}{
		{"single select",
			`{"tool":"dsh","sessionId":"s1","callId":"call-1","answers":[{"id":"q1","selected":["用到一半"]}]}`},
		{"multi select",
			`{"tool":"dsh","sessionId":"s1","callId":"call-1","answers":[{"id":"q1","selected":["a","b","c"]}]}`},
		{"free text only",
			`{"tool":"dsh","sessionId":"s1","callId":"call-1","answers":[{"id":"q1","selected":[],"custom":"再快一点"}]}`},
		{"option plus free text",
			`{"tool":"dsh","sessionId":"s1","callId":"call-1","answers":[{"id":"q1","selected":["其他"],"custom":"第三条路"}]}`},
		// A whole batch of questions, at the batch cap.
		{"eight questions",
			`{"tool":"dsh","sessionId":"s1","callId":"call-1","answers":[` +
				`{"id":"q1","selected":["a"]},{"id":"q2","selected":["a"]},{"id":"q3","selected":["a"]},` +
				`{"id":"q4","selected":["a"]},{"id":"q5","selected":["a"]},{"id":"q6","selected":["a"]},` +
				`{"id":"q7","selected":["a"]},{"id":"q8","selected":["a"]}]}`},
		// A UUID-shaped callId, because a native DSH callId is a UUID.
		{"uuid callId",
			`{"tool":"dsh","sessionId":"s1","callId":"` + testApprovalID + `","answers":[{"id":"q1","selected":["a"]}]}`},
		// Twelve options is the per-question cap.
		{"twelve selected",
			`{"tool":"dsh","sessionId":"s1","callId":"call-1","answers":[{"id":"q1","selected":[` +
				`"a","b","c","d","e","f","g","h","i","j","k","l"]}]}`},
	}
	for _, tc := range accepted {
		if code, ok := ValidateParams("session.answer", json.RawMessage(tc.params)); !ok {
			t.Errorf("%s: ValidateParams(session.answer, %s) = %s, want accepted", tc.name, tc.params, code)
		}
	}

	rejected := []struct {
		name   string
		params string
		want   Code
	}{
		{"no tool", `{"sessionId":"s1","callId":"c","answers":[{"id":"q1","selected":["a"]}]}`, CodeInvalidParams},
		{"unknown tool", `{"tool":"claude","sessionId":"s1","callId":"c","answers":[{"id":"q1","selected":["a"]}]}`, CodeInvalidParams},
		{"no sessionId", `{"tool":"dsh","callId":"c","answers":[{"id":"q1","selected":["a"]}]}`, CodeInvalidParams},
		{"bad sessionId shape", `{"tool":"dsh","sessionId":"has space","callId":"c","answers":[{"id":"q1","selected":["a"]}]}`, CodeInvalidParams},
		{"no callId", `{"tool":"dsh","sessionId":"s1","answers":[{"id":"q1","selected":["a"]}]}`, CodeInvalidParams},
		{"blank callId", `{"tool":"dsh","sessionId":"s1","callId":"   ","answers":[{"id":"q1","selected":["a"]}]}`, CodeInvalidParams},
		{"no answers", `{"tool":"dsh","sessionId":"s1","callId":"c"}`, CodeInvalidParams},
		{"answers is null", `{"tool":"dsh","sessionId":"s1","callId":"c","answers":null}`, CodeInvalidParams},
		{"answers is not an array", `{"tool":"dsh","sessionId":"s1","callId":"c","answers":{}}`, CodeInvalidParams},
		{"answers is a string", `{"tool":"dsh","sessionId":"s1","callId":"c","answers":"q1"}`, CodeInvalidParams},
		{"empty answers", `{"tool":"dsh","sessionId":"s1","callId":"c","answers":[]}`, CodeInvalidParams},
		// One question, one answer: a duplicate id would either answer the same
		// question twice or silently drop one of the two.
		{"duplicate question ids",
			`{"tool":"dsh","sessionId":"s1","callId":"c","answers":[{"id":"q1","selected":["a"]},{"id":"q1","selected":["b"]}]}`,
			CodeInvalidParams},
		{"nine answers", `{"tool":"dsh","sessionId":"s1","callId":"c","answers":[` +
			`{"id":"q1","selected":["a"]},{"id":"q2","selected":["a"]},{"id":"q3","selected":["a"]},` +
			`{"id":"q4","selected":["a"]},{"id":"q5","selected":["a"]},{"id":"q6","selected":["a"]},` +
			`{"id":"q7","selected":["a"]},{"id":"q8","selected":["a"]},{"id":"q9","selected":["a"]}]}`,
			CodeInvalidParams},
		{"answer has no id", `{"tool":"dsh","sessionId":"s1","callId":"c","answers":[{"selected":["a"]}]}`, CodeInvalidParams},
		{"answer id is blank", `{"tool":"dsh","sessionId":"s1","callId":"c","answers":[{"id":"","selected":["a"]}]}`, CodeInvalidParams},
		{"answer has no selected", `{"tool":"dsh","sessionId":"s1","callId":"c","answers":[{"id":"q1"}]}`, CodeInvalidParams},
		{"selected is null", `{"tool":"dsh","sessionId":"s1","callId":"c","answers":[{"id":"q1","selected":null}]}`, CodeInvalidParams},
		{"selected is not an array", `{"tool":"dsh","sessionId":"s1","callId":"c","answers":[{"id":"q1","selected":"a"}]}`, CodeInvalidParams},
		// Neither an option nor free text is not an answer; forwarding it would
		// commit an empty field over a live turn.
		{"selected empty and no custom", `{"tool":"dsh","sessionId":"s1","callId":"c","answers":[{"id":"q1","selected":[]}]}`, CodeInvalidParams},
		{"duplicate selected labels", `{"tool":"dsh","sessionId":"s1","callId":"c","answers":[{"id":"q1","selected":["a","a"]}]}`, CodeInvalidParams},
		{"thirteen selected", `{"tool":"dsh","sessionId":"s1","callId":"c","answers":[{"id":"q1","selected":[` +
			`"a","b","c","d","e","f","g","h","i","j","k","l","m"]}]}`, CodeInvalidParams},
		{"blank selected label", `{"tool":"dsh","sessionId":"s1","callId":"c","answers":[{"id":"q1","selected":["  "]}]}`, CodeInvalidParams},
		{"custom is not a string", `{"tool":"dsh","sessionId":"s1","callId":"c","answers":[{"id":"q1","selected":["a"],"custom":7}]}`, CodeInvalidParams},
		{"custom is blank", `{"tool":"dsh","sessionId":"s1","callId":"c","answers":[{"id":"q1","selected":[],"custom":"   "}]}`, CodeInvalidParams},
		{"custom with a newline", `{"tool":"dsh","sessionId":"s1","callId":"c","answers":[{"id":"q1","selected":["a"],"custom":"a\nb"}]}`, CodeInvalidParams},
		{"selected label with a control character", `{"tool":"dsh","sessionId":"s1","callId":"c","answers":[{"id":"q1","selected":["a\u0007b"]}]}`, CodeInvalidParams},
		// The doors that must not exist on this method.
		{"unknown field", `{"tool":"dsh","sessionId":"s1","callId":"c","answers":[{"id":"q1","selected":["a"]}],"approve":true}`, CodeInvalidParams},
		{"native rpc escape hatch", `{"tool":"dsh","sessionId":"s1","callId":"c","answers":[{"id":"q1","selected":["a"]}],"method":"session/kill"}`, CodeInvalidParams},
		{"shell escape hatch", `{"tool":"dsh","sessionId":"s1","callId":"c","answers":[{"id":"q1","selected":["a"]}],"command":"rm -rf /"}`, CodeInvalidParams},
		{"timeoutMs in params", `{"tool":"dsh","sessionId":"s1","callId":"c","answers":[{"id":"q1","selected":["a"]}],"timeoutMs":1}`, CodeInvalidParams},
	}
	for _, tc := range rejected {
		code, ok := ValidateParams("session.answer", json.RawMessage(tc.params))
		if ok {
			t.Errorf("%s: %s was accepted, want %s", tc.name, tc.params, tc.want)
			continue
		}
		if code != tc.want {
			t.Errorf("%s: = %s, want %s", tc.name, code, tc.want)
		}
	}

	// An over-long free-text answer is its own code, not invalid_params.
	tooLong := `{"tool":"dsh","sessionId":"s1","callId":"c","answers":[{"id":"q1","selected":[],"custom":"` +
		strings.Repeat("a", maxCustomAnswerRunes+1) + `"}]}`
	if code, ok := ValidateParams("session.answer", json.RawMessage(tooLong)); ok || code != CodeInvalidParams {
		t.Errorf("an over-long custom answer = %s ok=%v, want invalid_params", code, ok)
	}
	// The boundary itself is allowed.
	edge := `{"tool":"dsh","sessionId":"s1","callId":"c","answers":[{"id":"q1","selected":[],"custom":"` +
		strings.Repeat("a", maxCustomAnswerRunes) + `"}]}`
	if code, ok := ValidateParams("session.answer", json.RawMessage(edge)); !ok {
		t.Errorf("a %d-character custom answer = %s, want accepted", maxCustomAnswerRunes, code)
	}
}

// TestSessionApproveParams covers the approval call: a real UUID, a closed
// decision set, and no door to a policy change.
func TestSessionApproveParams(t *testing.T) {
	accepted := []string{
		`{"tool":"dsh","sessionId":"s1","approvalId":"` + testApprovalID + `","decision":"allow-once"}`,
		`{"tool":"dsh","sessionId":"s1","approvalId":"` + testApprovalID + `","decision":"reject"}`,
	}
	for _, params := range accepted {
		if code, ok := ValidateParams("session.approve", json.RawMessage(params)); !ok {
			t.Errorf("ValidateParams(session.approve, %s) = %s, want accepted", params, code)
		}
	}

	rejected := []struct {
		name   string
		params string
	}{
		{"no tool", `{"sessionId":"s1","approvalId":"` + testApprovalID + `","decision":"reject"}`},
		{"unknown tool", `{"tool":"claude","sessionId":"s1","approvalId":"` + testApprovalID + `","decision":"reject"}`},
		{"no sessionId", `{"tool":"dsh","approvalId":"` + testApprovalID + `","decision":"reject"}`},
		{"no approvalId", `{"tool":"dsh","sessionId":"s1","decision":"reject"}`},
		{"approvalId is not a uuid", `{"tool":"dsh","sessionId":"s1","approvalId":"approval-1","decision":"reject"}`},
		{"approvalId is blank", `{"tool":"dsh","sessionId":"s1","approvalId":"","decision":"reject"}`},
		{"approvalId is not a string", `{"tool":"dsh","sessionId":"s1","approvalId":7,"decision":"reject"}`},
		{"no decision", `{"tool":"dsh","sessionId":"s1","approvalId":"` + testApprovalID + `"}`},
		{"decision is not a string", `{"tool":"dsh","sessionId":"s1","approvalId":"` + testApprovalID + `","decision":true}`},
		{"decision is blank", `{"tool":"dsh","sessionId":"s1","approvalId":"` + testApprovalID + `","decision":""}`},
		// There is no allow-always. A decision that would outlive the one
		// request it answers is a policy change, and an unrecognised decision
		// must never be rounded to the one that grants access.
		{"allow-always", `{"tool":"dsh","sessionId":"s1","approvalId":"` + testApprovalID + `","decision":"allow-always"}`},
		{"allow", `{"tool":"dsh","sessionId":"s1","approvalId":"` + testApprovalID + `","decision":"allow"}`},
		{"always", `{"tool":"dsh","sessionId":"s1","approvalId":"` + testApprovalID + `","decision":"always"}`},
		{"approved", `{"tool":"dsh","sessionId":"s1","approvalId":"` + testApprovalID + `","decision":"approved"}`},
		{"uppercase decision", `{"tool":"dsh","sessionId":"s1","approvalId":"` + testApprovalID + `","decision":"REJECT"}`},
		{"dsh reject decision", `{"tool":"dsh","sessionId":"s1","approvalId":"` + testApprovalID + `","decision":"rejected"}`},
		// The doors that must not exist on this method either.
		{"outcome object", `{"tool":"dsh","sessionId":"s1","approvalId":"` + testApprovalID + `","decision":"reject","outcome":{"kind":"result","value":"allowed-once"}}`},
		{"clientId passthrough", `{"tool":"dsh","sessionId":"s1","approvalId":"` + testApprovalID + `","decision":"reject","clientId":"abc"}`},
		{"eventId passthrough", `{"tool":"dsh","sessionId":"s1","approvalId":"` + testApprovalID + `","decision":"reject","eventId":"abc"}`},
		{"rpc method passthrough", `{"tool":"dsh","sessionId":"s1","approvalId":"` + testApprovalID + `","decision":"reject","method":"$events/result"}`},
		{"policy change", `{"tool":"dsh","sessionId":"s1","approvalId":"` + testApprovalID + `","decision":"reject","policy":"allow-all"}`},
		{"command passthrough", `{"tool":"dsh","sessionId":"s1","approvalId":"` + testApprovalID + `","decision":"reject","command":"whoami"}`},
	}
	for _, tc := range rejected {
		code, ok := ValidateParams("session.approve", json.RawMessage(tc.params))
		if ok {
			t.Errorf("%s: %s was accepted, want invalid_params", tc.name, tc.params)
			continue
		}
		if code != CodeInvalidParams {
			t.Errorf("%s: = %s, want invalid_params", tc.name, code)
		}
	}
}

// TestAnswerAndApproveTimeouts pins the per-method budgets: both are mutations,
// so both get the 30 s that session.send and session.create already have.
func TestAnswerAndApproveTimeouts(t *testing.T) {
	for _, method := range []string{"session.answer", "session.approve"} {
		if got := DefaultTimeoutMs(method); got != 30000 {
			t.Errorf("DefaultTimeoutMs(%s) = %d, want 30000", method, got)
		}
	}
	// The five other budgets must not have moved.
	unchanged := map[string]int{
		"sessions.list": 15000, "session.read": 15000, "models.list": 15000,
		"session.send": 30000, "session.stop": 30000, "session.create": 30000,
	}
	for method, want := range unchanged {
		if got := DefaultTimeoutMs(method); got != want {
			t.Errorf("DefaultTimeoutMs(%s) changed to %d, want %d", method, got, want)
		}
	}
}

// TestAnswerParamsSurviveForwarding is the relay's whole share of the answer
// path at the protocol layer: the batch reaches the desktop byte for byte,
// Unicode and all. The relay has no live question of its own — only the
// computer does — so the only correct behaviour is to pass the labels through
// untouched and let the desktop refuse a label it never asked about.
func TestAnswerParamsSurviveForwarding(t *testing.T) {
	params := json.RawMessage(`{"tool":"dsh","sessionId":"s1","callId":"call-1",` +
		`"answers":[{"id":"q1","selected":["沿用当前模型","换一个"],"custom":"下条消息模型"}]}`)
	frame := &Frame{Type: FrameRequest, Method: "session.answer", Params: params}

	encoded, err := json.Marshal(frame)
	if err != nil {
		t.Fatalf("marshal frame: %v", err)
	}
	parsed, err := ParseFrame(encoded)
	if err != nil {
		t.Fatalf("parse frame: %v", err)
	}
	if string(parsed.Params) != string(params) {
		t.Fatalf("params changed in transit:\n got %s\nwant %s", parsed.Params, params)
	}
	// The Unicode labels and the custom text must still be exactly the ones
	// that were sent, not escaped-and-mangled or NFC-folded.
	var decoded struct {
		Answers []struct {
			Selected []string `json:"selected"`
			Custom   string   `json:"custom"`
		} `json:"answers"`
	}
	if err := json.Unmarshal(parsed.Params, &decoded); err != nil {
		t.Fatalf("params did not decode: %v", err)
	}
	if len(decoded.Answers) != 1 || len(decoded.Answers[0].Selected) != 2 {
		t.Fatalf("the batch did not survive: %v", decoded.Answers)
	}
	if decoded.Answers[0].Selected[0] != "沿用当前模型" || decoded.Answers[0].Custom != "下条消息模型" {
		t.Errorf("Unicode text was rewritten in transit: %v", decoded.Answers[0])
	}
}

// TestApprovalDecisionSetIsClosedAtTheTypeLevel pins the two decisions the
// transport understands, so a later edit cannot quietly widen the set.
func TestApprovalDecisionSetIsClosedAtTheTypeLevel(t *testing.T) {
	if DecisionAllowOnce != "allow-once" || DecisionReject != "reject" {
		t.Fatalf("the decision vocabulary changed: %q / %q", DecisionAllowOnce, DecisionReject)
	}
}
