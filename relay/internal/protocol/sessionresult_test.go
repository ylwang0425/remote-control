package protocol

import (
	"encoding/json"
	"strings"
	"testing"
)

// The result half of the workbench surface: needsInput on a session summary,
// the two pending projections on session.read, and the acknowledgements the two
// new methods produce.
//
// Every rule below exists so the phone cannot be handed something it would have
// to guess about. An absent projection means "no projection to offer"; `[]`
// means "I looked and there is nothing pending"; and a projection that does not
// fit the representable bounds is refused outright rather than trimmed into a
// form the user would answer without having seen all of it.

const readHead = `{"id":"s1","tool":"dsh","title":"t","status":"working","messages":[],"canStop":false`

// TestSessionsListNeedsInput covers the badge field: optional, boolean, never
// inferred, never defaulted.
func TestSessionsListNeedsInput(t *testing.T) {
	base := `"id":"s1","tool":"dsh","title":"t","status":"working","updatedAt":"2026-10-08T03:57:55Z","cwd":null`

	accepted := []struct {
		name   string
		result string
	}{
		{"omitted (older desktop)", `{"sessions":[{` + base + `}],"capabilities":{}}`},
		{"true", `{"sessions":[{` + base + `,"needsInput":true}],"capabilities":{}}`},
		{"false", `{"sessions":[{` + base + `,"needsInput":false}],"capabilities":{}}`},
		{"an unknown sibling is passed through", `{"sessions":[{` + base + `,"needsInput":true,"futureField":1}],"capabilities":{}}`},
		{"empty list", `{"sessions":[],"capabilities":{}}`},
	}
	for _, tc := range accepted {
		if code, ok := ValidateResult("sessions.list", json.RawMessage(tc.result)); !ok {
			t.Errorf("%s: ValidateResult(sessions.list, %s) = %s, want accepted", tc.name, tc.result, code)
		}
	}

	// `null` is not a boolean. Accepting it would turn "the desktop cannot
	// tell" into "nothing is pending", which is the one reading that silently
	// hides a question that is waiting for the user.
	rejected := []string{
		`{"sessions":[{` + base + `,"needsInput":null}],"capabilities":{}}`,
		`{"sessions":[{` + base + `,"needsInput":"true"}],"capabilities":{}}`,
		`{"sessions":[{` + base + `,"needsInput":1}],"capabilities":{}}`,
		`{"sessions":[{` + base + `,"needsInput":{}}],"capabilities":{}}`,
	}
	for _, result := range rejected {
		code, ok := ValidateResult("sessions.list", json.RawMessage(result))
		if ok {
			t.Errorf("%s was accepted, want bridge_bad_response", result)
			continue
		}
		if code != CodeBridgeBadResponse {
			t.Errorf("ValidateResult(sessions.list, %s) = %s, want bridge_bad_response", result, code)
		}
	}
}

// TestSessionReadPendingQuestions covers the genuine question projection: its
// bounds, the fields that must carry information, and the native transport
// names that must never ride along inside it.
func TestSessionReadPendingQuestions(t *testing.T) {
	batch := func(state, questions string) string {
		return `,"pendingQuestions":[{"callId":"call-1","state":"` + state + `","questions":[` + questions + `]}]`
	}
	oneQuestion := `{"id":"q1","question":"用哪个模型?","header":"模型","options":[{"label":"沿用当前模型","description":"发完这条再说"},{"label":"换一个"}],"multiSelect":false,"allowCustom":false}`

	accepted := []struct {
		name   string
		result string
	}{
		{"omitted", readHead + `}`},
		{"empty projection", readHead + `,"pendingQuestions":[]}`},
		{"open question with options", readHead + batch("open", oneQuestion) + `}`},
		{"continued question", readHead + batch("continued", oneQuestion) + `}`},
		{"question with no options (free text)", readHead +
			batch("open", `{"id":"q1","question":"还有什么要补充的?"}`) + `}`},
		{"an unknown member is passed through", readHead +
			batch("open", `{"id":"q1","question":"q?","futureField":1}`) + `}`},
		{"four batches is the cap", readHead +
			`,"pendingQuestions":[{"callId":"c1","state":"open","questions":[{"id":"q1","question":"q?"}]},` +
			`{"callId":"c2","state":"open","questions":[{"id":"q1","question":"q?"}]},` +
			`{"callId":"c3","state":"open","questions":[{"id":"q1","question":"q?"}]},` +
			`{"callId":"c4","state":"open","questions":[{"id":"q1","question":"q?"}]}]}`},
	}
	for _, tc := range accepted {
		if code, ok := ValidateResult("session.read", json.RawMessage(tc.result)); !ok {
			t.Errorf("%s: ValidateResult(session.read, ...) = %s, want accepted", tc.name, code)
		}
	}

	rejected := []struct {
		name   string
		result string
	}{
		{"projection is null", readHead + `,"pendingQuestions":null}`},
		{"projection is not an array", readHead + `,"pendingQuestions":{}}`},
		{"projection is a string", readHead + `,"pendingQuestions":"q?"}`},
		{"batch has no callId", readHead + `,"pendingQuestions":[{"state":"open","questions":[{"id":"q1","question":"q?"}]}]}`},
		{"batch has no state", readHead + `,"pendingQuestions":[{"callId":"c1","questions":[{"id":"q1","question":"q?"}]}]}`},
		// A state the relay does not understand is not answerable, so it is not
		// handed to a person as something to answer.
		{"unknown state", readHead + `,"pendingQuestions":[{"callId":"c1","state":"maybe","questions":[{"id":"q1","question":"q?"}]}]}`},
		{"allowCustom is not boolean", readHead + `,"pendingQuestions":[{"callId":"c1","state":"open","questions":[{"id":"q1","question":"q?","allowCustom":"false"}]}]}`},
		{"allowCustom is not nullable", readHead + `,"pendingQuestions":[{"callId":"c1","state":"open","questions":[{"id":"q1","question":"q?","allowCustom":null}]}]}`},
		{"batch has no questions", readHead + `,"pendingQuestions":[{"callId":"c1","state":"open"}]}`},
		{"empty question list", readHead + batch("open", ``) + `}`},
		{"question has no id", readHead + batch("open", `{"question":"q?"}`) + `}`},
		{"blank question id", readHead + batch("open", `{"id":"","question":"q?"}`) + `}`},
		// A blank question would render as an empty row the user is asked to
		// answer; it is refused instead.
		{"question has no text", readHead + batch("open", `{"id":"q1"}`) + `}`},
		{"blank question text", readHead + batch("open", `{"id":"q1","question":"   "}`) + `}`},
		{"question text is not a string", readHead + batch("open", `{"id":"q1","question":7}`) + `}`},
		{"a label-less option", readHead + batch("open", `{"id":"q1","question":"q?","options":[{"description":"d"}]}`) + `}`},
		{"a blank option label", readHead + batch("open", `{"id":"q1","question":"q?","options":[{"label":"  "}]}`) + `}`},
		{"thirteen options", readHead + batch("open", `{"id":"q1","question":"q?","options":[`+
			`{"label":"a"},{"label":"b"},{"label":"c"},{"label":"d"},{"label":"e"},{"label":"f"},{"label":"g"},`+
			`{"label":"h"},{"label":"i"},{"label":"j"},{"label":"k"},{"label":"l"},{"label":"m"}]}`) + `}`},
		{"nine questions in one batch", readHead + batch("open",
			`{"id":"q1","question":"q?"},{"id":"q2","question":"q?"},{"id":"q3","question":"q?"},`+
				`{"id":"q4","question":"q?"},{"id":"q5","question":"q?"},{"id":"q6","question":"q?"},`+
				`{"id":"q7","question":"q?"},{"id":"q8","question":"q?"},{"id":"q9","question":"q?"}`) + `}`},
		{"five batches is over the cap", readHead +
			`,"pendingQuestions":[{"callId":"c1","state":"open","questions":[{"id":"q1","question":"q?"}]},` +
			`{"callId":"c2","state":"open","questions":[{"id":"q1","question":"q?"}]},` +
			`{"callId":"c3","state":"open","questions":[{"id":"q1","question":"q?"}]},` +
			`{"callId":"c4","state":"open","questions":[{"id":"q1","question":"q?"}]},` +
			`{"callId":"c5","state":"open","questions":[{"id":"q1","question":"q?"}]}]}`},
		// Native transport internals must not ride along inside the projection.
		{"clientId smuggled in", readHead + batch("open", `{"id":"q1","question":"q?","clientId":"abc"}`) + `}`},
		{"a nested connectionId", readHead +
			`,"pendingQuestions":[{"callId":"c1","state":"open","clientId":"abc","questions":[{"id":"q1","question":"q?"}]}]}`},
		{"a token in options", readHead +
			batch("open", `{"id":"q1","question":"q?","options":[{"label":"a","token":"secret"}]}`) + `}`},
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

	// The bounds are the contract's, and the boundary value is legal.
	if !boundedRunes("x", maxQuestionRunes) {
		t.Error("a one-character question should be representable")
	}
	tooLongQuestion := readHead + batch("open", `{"id":"q1","question":"`+strings.Repeat("啊", maxQuestionRunes)+`"}`) + `}`
	if code, ok := ValidateResult("session.read", json.RawMessage(tooLongQuestion)); !ok {
		t.Errorf("a %d-rune question = %s, want accepted (it is exactly the cap)", maxQuestionRunes, code)
	}
	overLongQuestion := readHead + batch("open", `{"id":"q1","question":"`+strings.Repeat("啊", maxQuestionRunes+1)+`"}`) + `}`
	if code, ok := ValidateResult("session.read", json.RawMessage(overLongQuestion)); ok {
		t.Errorf("a %d-rune question was accepted, want bridge_bad_response", maxQuestionRunes+1)
	} else if code != CodeBridgeBadResponse {
		t.Errorf("over-long question = %s, want bridge_bad_response", code)
	}
}

// TestSessionReadPendingApprovals covers the permission projection: a real
// gateway event id, a real tool name, and the native names that must not leak.
func TestSessionReadPendingApprovals(t *testing.T) {
	one := `{"id":"` + testApprovalID + `","toolName":"shell.exec","callId":"call-1","reason":"运行 npm test"}`

	accepted := []struct {
		name   string
		result string
	}{
		{"omitted", readHead + `}`},
		{"empty projection", readHead + `,"pendingApprovals":[]}`},
		{"one approval", readHead + `,"pendingApprovals":[` + one + `]}`},
		{"id and toolName only", readHead + `,"pendingApprovals":[{"id":"` + testApprovalID + `","toolName":"shell.exec"}]}`},
		{"an unknown member is passed through", readHead +
			`,"pendingApprovals":[{"id":"` + testApprovalID + `","toolName":"shell.exec","futureField":1}]}`},
		{"eight approvals is the cap", readHead + `,"pendingApprovals":[` + approvalList(8) + `]}`},
	}
	for _, tc := range accepted {
		if code, ok := ValidateResult("session.read", json.RawMessage(tc.result)); !ok {
			t.Errorf("%s: ValidateResult(session.read, ...) = %s, want accepted", tc.name, code)
		}
	}

	rejected := []struct {
		name   string
		result string
	}{
		{"projection is null", readHead + `,"pendingApprovals":null}`},
		{"projection is not an array", readHead + `,"pendingApprovals":{}}`},
		// The id is the only value the approve call may name, so it must be a
		// real event id shape and not a nickname.
		{"id is not a uuid", readHead + `,"pendingApprovals":[{"id":"approval-1","toolName":"shell.exec"}]}`},
		{"id is missing", readHead + `,"pendingApprovals":[{"toolName":"shell.exec"}]}`},
		{"id is blank", readHead + `,"pendingApprovals":[{"id":"","toolName":"shell.exec"}]}`},
		// A request whose tool name cannot be shown must not become a button.
		{"toolName is missing", readHead + `,"pendingApprovals":[{"id":"` + testApprovalID + `"}]}`},
		{"toolName is blank", readHead + `,"pendingApprovals":[{"id":"` + testApprovalID + `","toolName":"   "}]}`},
		{"toolName is not a string", readHead + `,"pendingApprovals":[{"id":"` + testApprovalID + `","toolName":7}]}`},
		{"nine approvals is over the cap", readHead + `,"pendingApprovals":[` + approvalList(9) + `]}`},
		// Native transport internals must not leak either.
		{"clientId smuggled in", readHead +
			`,"pendingApprovals":[{"id":"` + testApprovalID + `","toolName":"shell.exec","clientId":"abc"}]}`},
		{"a host path smuggled in", readHead +
			`,"pendingApprovals":[{"id":"` + testApprovalID + `","toolName":"shell.exec","home":"C:\\\\Users\\\\Hi"}]}`},
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

func TestSessionReadNativeApprovalContext(t *testing.T) {
	for _, tool := range []string{"codex", "workbuddy"} {
		head := strings.Replace(readHead, `"tool":"dsh"`, `"tool":"`+tool+`"`, 1)
		accepted := []string{
			head + `,"pendingApprovals":[{"id":"` + testApprovalID + `","toolName":"commandExecution","reason":"Request execution.\nReview the full command.","context":{"kind":"command","command":"npm test\nnode scripts/check.js","cwd":"D:\\project"}}]}`,
			head + `,"pendingApprovals":[{"id":"` + testApprovalID + `","toolName":"networkRequest","reason":"Connect to the service.","context":{"kind":"network","networkHost":"api.example.com","protocol":"https","networkPort":443}}]}`,
			head + `,"pendingApprovals":[{"id":"` + testApprovalID + `","toolName":"fileChange","reason":"Review the requested file changes.","context":{"kind":"file-change","summary":"Modify a file.\nCreate another file.","grantRoot":"D:\\project"}}]}`,
		}
		for _, result := range accepted {
			if code, ok := ValidateResult("session.read", json.RawMessage(result)); !ok {
				t.Errorf("%s native approval context was refused: %s", tool, code)
			}
		}

		command := `{"id":"` + testApprovalID + `","toolName":"commandExecution","reason":"Run this command.","context":{"kind":"command","command":"npm test","cwd":"D:\\project"}}`
		network := `{"id":"` + testApprovalID + `","toolName":"networkRequest","reason":"Connect to the service.","context":{"kind":"network","networkHost":"api.example.com","protocol":"https"}}`
		rejectedProjections := []string{
			`{"id":"` + testApprovalID + `","toolName":"commandExecution","reason":"Run this command."}`,
			strings.Replace(command, `"reason":"Run this command."`, `"reason":""`, 1),
			strings.Replace(command, `"reason":"Run this command."`, `"reason":"   "`, 1),
			strings.Replace(command, `"kind":"command"`, `"kind":"workspace-write"`, 1),
			strings.Replace(command, `"cwd":"D:\\project"`, `"cwd":"D:\\project","unshownScope":"workspace"`, 1),
			strings.Replace(command, `"command":"npm test"`, `"command":"`+strings.Repeat("x", maxApprovalCommandRunes+1)+`"`, 1),
			strings.Replace(command, `"command":"npm test"`, `"command":"npm test\u0001"`, 1),
			strings.Replace(network, `"protocol":"https"`, `"protocol":"https","networkPort":0`, 1),
			strings.Replace(network, `"protocol":"https"`, `"protocol":"https","networkPort":65536`, 1),
			strings.Replace(network, `"protocol":"https"`, `"protocol":"https","networkPort":443.5`, 1),
			strings.Replace(network, `"protocol":"https"`, `"protocol":"https","networkPort":null`, 1),
		}
		for _, approval := range rejectedProjections {
			result := head + `,"pendingApprovals":[` + approval + `]}`
			if code, ok := ValidateResult("session.read", json.RawMessage(result)); ok || code != CodeBridgeBadResponse {
				t.Errorf("%s incomplete/unknown approval %s = %s, accepted=%v; want bridge_bad_response", tool, approval, code, ok)
			}
		}
	}
}

// approvalList builds n synthetic-but-well-formed approvals for the cardinality
// boundary. The ids are real UUID shapes; nothing here is a claim about a live
// request.
func approvalList(n int) string {
	parts := make([]string, 0, n)
	for i := 0; i < n; i++ {
		parts = append(parts, `{"id":"8f14e45f-ceea-467a-9c1c-1f2a3b4c5d`+
			string(rune('0'+i/10))+string(rune('0'+i%10))+`","toolName":"shell.exec"}`)
	}
	return strings.Join(parts, ",")
}

// TestSessionAnswerResultShape covers the answer acknowledgement: accepted,
// the session and the exact batch it belongs to.
func TestSessionAnswerResultShape(t *testing.T) {
	accepted := []string{
		`{"accepted":true,"sessionId":"s1","callId":"call-1"}`,
		`{"accepted":true,"sessionId":"` + testSessionID + `","callId":"` + testApprovalID + `"}`,
		`{"accepted":true,"sessionId":"s1","callId":"call-1","state":"submitted"}`,
		`{"accepted":true,"sessionId":"s1","callId":"call-1","state":"confirmed"}`,
		`{"accepted":true,"sessionId":"s1","callId":"call-1","futureField":1}`,
	}
	for _, result := range accepted {
		if code, ok := ValidateResult("session.answer", json.RawMessage(result)); !ok {
			t.Errorf("ValidateResult(session.answer, %s) = %s, want accepted", result, code)
		}
	}

	// An acknowledgement that does not name the batch it answered, or that
	// claims a soft acceptance, is not usable.
	rejected := []string{
		`{}`,
		`{"accepted":false,"sessionId":"s1","callId":"call-1"}`,
		`{"accepted":true,"sessionId":"s1"}`,
		`{"accepted":true,"callId":"call-1"}`,
		`{"accepted":true,"sessionId":"s1","callId":""}`,
		`{"accepted":true,"sessionId":"s1","callId":null}`,
		`{"accepted":true,"sessionId":"s1","callId":"call-1","state":"resolved"}`,
		`{"accepted":true,"sessionId":"s1","callId":"call-1","state":null}`,
		`{"accepted":true,"sessionId":"has space","callId":"call-1"}`,
		`{"sessionId":"s1","callId":"call-1"}`,
		`[]`,
		`not json`,
	}
	for _, result := range rejected {
		code, ok := ValidateResult("session.answer", json.RawMessage(result))
		if ok {
			t.Errorf("%s was accepted, want bridge_bad_response", result)
			continue
		}
		if code != CodeBridgeBadResponse {
			t.Errorf("ValidateResult(session.answer, %s) = %s, want bridge_bad_response", result, code)
		}
	}
}

// TestSessionApproveResultShape covers the approval acknowledgement, including
// the two states and the one that must never be invented.
func TestSessionApproveResultShape(t *testing.T) {
	submitted := `{"accepted":true,"sessionId":"s1","approvalId":"` + testApprovalID + `","state":"submitted"}`
	confirmed := `{"accepted":true,"sessionId":"s1","approvalId":"` + testApprovalID + `","state":"confirmed"}`

	for _, result := range []string{
		submitted,
		confirmed,
		`{"accepted":true,"sessionId":"s1","approvalId":"` + testApprovalID + `","state":"submitted","futureField":1}`,
	} {
		if code, ok := ValidateResult("session.approve", json.RawMessage(result)); !ok {
			t.Errorf("ValidateResult(session.approve, %s) = %s, want accepted", result, code)
		}
	}

	// The two states mean different things and neither may be defaulted or
	// rounded into the other. A third value is a shape error, not something to
	// display as "done".
	rejected := []string{
		`{}`,
		`{"accepted":true,"sessionId":"s1","approvalId":"` + testApprovalID + `"}`,
		`{"accepted":true,"sessionId":"s1","approvalId":"` + testApprovalID + `","state":"allowed"}`,
		`{"accepted":true,"sessionId":"s1","approvalId":"` + testApprovalID + `","state":"approved"}`,
		`{"accepted":true,"sessionId":"s1","approvalId":"` + testApprovalID + `","state":"granted"}`,
		`{"accepted":true,"sessionId":"s1","approvalId":"` + testApprovalID + `","state":""}`,
		`{"accepted":true,"sessionId":"s1","approvalId":"` + testApprovalID + `","state":null}`,
		`{"accepted":false,"sessionId":"s1","approvalId":"` + testApprovalID + `","state":"submitted"}`,
		`{"accepted":true,"sessionId":"s1","state":"submitted"}`,
		`{"accepted":true,"sessionId":"s1","approvalId":"not-a-uuid","state":"submitted"}`,
		`{"accepted":true,"approvalId":"` + testApprovalID + `","state":"submitted"}`,
		`{"accepted":true,"sessionId":"s1","approvalId":"` + testApprovalID + `","state":"confirmed","ok":true}` + "\x00",
	}
	for _, result := range rejected {
		code, ok := ValidateResult("session.approve", json.RawMessage(result))
		if ok {
			t.Errorf("%s was accepted, want bridge_bad_response", result)
			continue
		}
		if code != CodeBridgeBadResponse {
			t.Errorf("ValidateResult(session.approve, %s) = %s, want bridge_bad_response", result, code)
		}
	}
}

// TestCapabilitiesGainedTheWorkbenchKeys covers the hello extension: six new
// keys, all additive, absent meaning false, and no key inferred from a tool
// name or a version.
func TestCapabilitiesGainedTheWorkbenchKeys(t *testing.T) {
	var old Capabilities
	if err := json.Unmarshal([]byte(`{"sessions.list":true,"session.send":true,"tools":["codex","dsh"]}`), &old); err != nil {
		t.Fatalf("Unmarshal of an old-style capabilities object failed: %v", err)
	}
	if old.SendModelCodex || old.SendModelDSH || old.AnswerCodex || old.AnswerDSH || old.ApproveCodex || old.ApproveDSH {
		t.Fatal("an absent capability key must read as false; nothing may be inferred")
	}

	var full Capabilities
	const body = `{"session.send:model:codex":true,"session.send:model:dsh":true,` +
		`"session.answer:codex":false,"session.answer:dsh":true,` +
		`"session.approve:codex":false,"session.approve:dsh":true,"tools":["codex","dsh"]}`
	if err := json.Unmarshal([]byte(body), &full); err != nil {
		t.Fatalf("Unmarshal returned error: %v", err)
	}
	if !full.SendModelCodex || !full.SendModelDSH {
		t.Error("the two send:model keys did not decode")
	}
	if full.AnswerCodex || !full.AnswerDSH {
		t.Errorf("the answer keys decoded wrong: codex=%v dsh=%v", full.AnswerCodex, full.AnswerDSH)
	}
	if full.ApproveCodex || !full.ApproveDSH {
		t.Errorf("the approve keys decoded wrong: codex=%v dsh=%v", full.ApproveCodex, full.ApproveDSH)
	}

	// A false key is a real declaration and must survive a round trip, because
	// the phone renders a disabled state from it rather than a button.
	encoded, err := json.Marshal(full)
	if err != nil {
		t.Fatalf("Marshal returned error: %v", err)
	}
	var again Capabilities
	if err := json.Unmarshal(encoded, &again); err != nil {
		t.Fatalf("re-Unmarshal returned error: %v", err)
	}
	if again.SendModelCodex != full.SendModelCodex || again.SendModelDSH != full.SendModelDSH ||
		again.AnswerCodex != full.AnswerCodex || again.AnswerDSH != full.AnswerDSH ||
		again.ApproveCodex != full.ApproveCodex || again.ApproveDSH != full.ApproveDSH {
		t.Errorf("capabilities changed across a round trip:\n got %+v\nwant %+v", again, full)
	}

	// An older desktop's hello still validates: the wire version stays 1.
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

// TestNewErrorCodesAreBusinessFailures pins where the three new codes sit: on
// HTTP 200 as business failures, and reportable by a bridge. They are how a
// stale click is told apart from a protocol break, so they must be usable in a
// response frame.
func TestNewErrorCodesAreBusinessFailures(t *testing.T) {
	for _, code := range []Code{CodeAnswerNotOpen, CodeApprovalUnknown, CodeProjectConflict} {
		if code.HTTPStatus() != 200 {
			t.Errorf("%s.HTTPStatus() = %d, want 200", code, code.HTTPStatus())
		}
		if !code.BridgeReportable() {
			t.Errorf("%s is not bridge-reportable; a stale click could then only be a 502", code)
		}
		if code.CanonicalMessage() == "" || code.CanonicalMessage() == CodeInternal.CanonicalMessage() {
			t.Errorf("%s has no canonical message of its own", code)
		}
	}
	// The non-capable code still carries its historical message: an older
	// client branches on the code, and changing the text would be noise.
	if CodeNotCapable.CanonicalMessage() != "session cannot be stopped" {
		t.Errorf("CodeNotCapable's message changed: %q", CodeNotCapable.CanonicalMessage())
	}
}

// TestUUIDShapeIsVersionAgnostic pins the deliberate looseness of the relay's
// approval id check, and names the divergence from the desktop side.
//
// The id is minted by the desktop's own gateway, and the relay has never seen
// that gateway's contract. The desktop's own validator
// (desktop/src/protocol.js, UUID_V4) requires a lower-case v4 specifically; the
// relay accepts any canonical UUID version, because the relay cannot mint or
// prove a version and refusing a genuine event id would be a false refusal of a
// request the desktop could have honoured. The desktop's check is the stricter
// one, so this looseness cannot admit anything the desktop would have taken.
// The reverse direction — a gateway that mints a non-v4 event id — would be
// refused by the desktop, and that is a desktop-side assumption to verify
// against the real gateway rather than something the relay may paper over.
func TestUUIDShapeIsVersionAgnostic(t *testing.T) {
	accepted := []string{
		"8f14e45f-ceea-467a-9c1c-1f2a3b4c5d6e",
		"3f2504e0-4f89-41d3-9a0c-0305e82c3301",
		// Not a v4. The relay accepts it on purpose: see the comment above.
		"018f2b3c-4d5e-7f60-8a9b-0c1d2e3f4a5b",
		"8F14E45F-CEEA-467A-9C1C-1F2A3B4C5D6E",
	}
	for _, id := range accepted {
		if !IsUUID(id) {
			t.Errorf("IsUUID(%q) = false, want true", id)
		}
	}
	rejected := []string{
		"", "not-a-uuid", "8f14e45fceea467a9c1c1f2a3b4c5d6e",
		"8f14e45f-ceea-467a-9c1c-1f2a3b4c5d6",
		"8f14e45f-ceea-467a-9c1c-1f2a3b4c5d6e-",
		"8f14e45f-ceea-467a-9c1c-1f2a3b4c5d6g",
		"8f14e45f-ceea-467a-9c1c-1f2a3b4c5d6e ",
	}
	for _, id := range rejected {
		if IsUUID(id) {
			t.Errorf("IsUUID(%q) = true, want false", id)
		}
	}
}

// TestSanitizeDisplayTextKeepsUnicodeAndDropsControls pins the relay's text
// handling for the projections: control characters go, length is bounded, and
// everything else — including CJK — survives untouched.
func TestSanitizeDisplayTextKeepsUnicodeAndDropsControls(t *testing.T) {
	if got := sanitizeDisplayText("用哪个模型?\n\t", 100); got != "用哪个模型?" {
		t.Errorf("sanitizeDisplayText dropped or mangled Unicode: %q", got)
	}
	if got := sanitizeDisplayText("a\x00b\x07c", 100); got != "abc" {
		t.Errorf("control characters survived: %q", got)
	}
	if got := sanitizeDisplayText(strings.Repeat("啊", 10), 4); len([]rune(got)) != 4 {
		t.Errorf("bounding did not apply: %q", got)
	}
	if got := sanitizeDisplayText("   ", 10); got != "" {
		t.Errorf("a blank string should sanitise to empty, got %q", got)
	}
	if boundedRunes("   ", 10) {
		t.Error("boundedRunes accepted a blank string; the phone would render an empty row")
	}
}
