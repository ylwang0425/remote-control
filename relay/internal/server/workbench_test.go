package server

import (
	"encoding/json"
	"net/http"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/ai-remote/relay/internal/protocol"
)

// The workbench surface proved at the real seam: real HTTP in from the phone, a
// real WebSocket frame out to the desktop, and the answer back.
//
// What these tests are entitled to claim is deliberately narrow, and the
// narrowness is the point:
//
//   - the relay forwards the exact bytes it was given and rewrites nothing;
//   - a malformed, oversized, duplicated or unrepresentable request never
//     reaches the desktop at all;
//   - an approval acknowledgement is a SUBMISSION receipt. The relay never
//     promotes "submitted" to "confirmed", never invents the word "approved",
//     and never treats an HTTP 200 as proof that the person's permission was
//     granted;
//   - nothing is retried: after a refusal or a timeout the desktop sees one
//     frame, not two.
//
// What they must NOT claim is anything about native state. Whether the question
// was really open, whether the approval was really pending, and whether the
// submission really won the race are all the computer's answers, verified
// against real native chats — not something a relay test can assert into
// existence.

const (
	workbenchSessionID  = "0f1c7a2e-9b64-4c5f-8f1a-2d3e4b5c6a70"
	workbenchCallID     = "2c9e1a44-7b3d-4f18-9a2e-6d5c8b1f0a37"
	workbenchApprovalID = "8f14e45f-ceea-467a-9c1c-1f2a3b4c5d6e"
)

// forwarded collects the params the desktop really received, in order.
type forwarded struct {
	method string
	params string
}

// seenFrames is the recorder shared between the bridge-side goroutine that
// appends and the test goroutine that asserts. The two really do run at the same
// time — the test polls while the bridge answers — so the append and the
// snapshot are both taken under the lock rather than left to a plain slice.
type seenFrames struct {
	mu     sync.Mutex
	frames []forwarded
}

func (s *seenFrames) record(f forwarded) {
	s.mu.Lock()
	s.frames = append(s.frames, f)
	s.mu.Unlock()
}

func (s *seenFrames) snapshot() []forwarded {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make([]forwarded, len(s.frames))
	copy(out, s.frames)
	return out
}

// bridgeScript answers every request the desktop is given, and records what it
// saw. Each case returns the raw result object the desktop should send back, or
// answers with a business failure.
type bridgeScript func(t *testing.T, c *wsClient, f *protocol.Frame)

// serveBridge runs one bridge-side loop until the test ends or the connection
// goes away, dispatching each arriving request through script. Exactly one
// goroutine ever reads the connection: coder/websocket forbids concurrent reads,
// so a second reader would be a race rather than a test.
func serveBridge(t *testing.T, c *wsClient, script bridgeScript) *seenFrames {
	t.Helper()
	seen := &seenFrames{}
	go func() {
		for {
			f, ok := c.readRequestQuiet()
			if !ok {
				return
			}
			seen.record(forwarded{method: f.Method, params: string(f.Params)})
			script(t, c, f)
		}
	}()
	return seen
}

// countMethod reports how many frames of a method the desktop really received.
// It is how "no automatic retry" is proved: a single frame, never two.
func countMethod(seen []forwarded, method string) int {
	n := 0
	for _, f := range seen {
		if f.method == method {
			n++
		}
	}
	return n
}

// waitForMethod waits until the desktop has been handed at least n frames of a
// method, so the assertions do not race the goroutine that records them.
func waitForMethod(t *testing.T, seen *seenFrames, method string, n int) []forwarded {
	t.Helper()
	for i := 0; i < 200; i++ {
		snapshot := seen.snapshot()
		if countMethod(snapshot, method) >= n {
			return snapshot
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("the desktop never received %d %s frame(s); saw %+v", n, method, seen.snapshot())
	return nil
}

// rpc performs one authenticated RPC call and returns the raw body.
func (e *env) rpc(cookie, body string) (int, string) {
	e.t.Helper()
	resp := e.request("POST", "/api/rpc", testOrigin, "application/json", "rc_session="+cookie, body)
	return resp.StatusCode, readBody(e.t, resp)
}

// rpcResult performs one call and requires ok:true, returning the result object.
func (e *env) rpcResult(cookie, body string) map[string]any {
	e.t.Helper()
	status, raw := e.rpc(cookie, body)
	if status != 200 {
		e.t.Fatalf("rpc status = %d, want 200 (body %s)", status, raw)
	}
	var decoded struct {
		OK     bool           `json:"ok"`
		Result map[string]any `json:"result"`
	}
	if err := json.Unmarshal([]byte(raw), &decoded); err != nil {
		e.t.Fatalf("body is not json: %s", raw)
	}
	if !decoded.OK {
		e.t.Fatalf("rpc failed: %s", raw)
	}
	return decoded.Result
}

// ---- session.send: the model choice rides the existing send ----

// TestRPCSendWithModelReachesTheDesktop covers the send half of the chosen-model
// path end to end: the phone's explicit model selection is forwarded byte for
// byte, the acknowledgement shape does not grow, and a combination the relay
// cannot forward honestly is refused before the desktop ever sees it.
func TestRPCSendWithModelReachesTheDesktop(t *testing.T) {
	e := newEnv(t)
	c := e.helloBridge(protocol.Capabilities{
		SessionSend: true, SendModelCodex: true, SendModelDSH: true, Tools: []string{"codex", "dsh"},
	})
	cookie := e.pairOnce(c)

	// The desktop reads the pending question only when asked; send always
	// accepts exactly once.
	seen := serveBridge(t, c, func(t *testing.T, c *wsClient, f *protocol.Frame) {
		if f.Method == "session.send" {
			c.answer(f.ID, map[string]any{"accepted": true, "sessionId": workbenchSessionID})
		}
	})

	// DSH: the model and its provider, both required to route unambiguously.
	body := `{"method":"session.send","params":{"tool":"dsh","sessionId":"` + workbenchSessionID + `",` +
		`"text":"继续","model":"deepseek-reasoner","provider":"deepseek","reasoningEffort":"high"}}`
	result := e.rpcResult(cookie, body)
	if result["accepted"] != true || result["sessionId"] != workbenchSessionID {
		t.Fatalf("send result = %v, want the unchanged {accepted:true,sessionId}", result)
	}
	// The acknowledgement must not have grown into a model report: the model
	// choice is an input, and a result claiming a model would be the relay
	// telling the phone about native state nobody read.
	for _, forbidden := range []string{"model", "provider", "reasoningEffort", "currentModel"} {
		if _, present := result[forbidden]; present {
			t.Errorf("session.send's result grew a %q field: %v", forbidden, result)
		}
	}

	frames := waitForMethod(t, seen, "session.send", 1)
	got := frames[0].params
	for _, want := range []string{
		`"model":"deepseek-reasoner"`, `"provider":"deepseek"`, `"reasoningEffort":"high"`,
		`"text":"继续"`, `"tool":"dsh"`,
	} {
		if !strings.Contains(got, want) {
			t.Errorf("the desktop did not receive %s (got %s)", want, got)
		}
	}

	// Codex: a bare model, no provider.
	codexBody := `{"method":"session.send","params":{"tool":"codex","sessionId":"` + workbenchSessionID + `",` +
		`"text":"go","model":"gpt-5-codex"}}`
	_ = e.rpcResult(cookie, codexBody)
	frames = waitForMethod(t, seen, "session.send", 2)
	if !strings.Contains(frames[1].params, `"model":"gpt-5-codex"`) {
		t.Errorf("the Codex model did not reach the desktop: %s", frames[1].params)
	}
	if strings.Contains(frames[1].params, "provider") {
		t.Errorf("a provider appeared in a Codex send: %s", frames[1].params)
	}

	// The pre-existing three-field call still travels untouched, and it means
	// "keep using whatever this session already uses".
	legacy := `{"method":"session.send","params":{"tool":"codex","sessionId":"s1","text":"hi"}}`
	_ = e.rpcResult(cookie, legacy)
	frames = waitForMethod(t, seen, "session.send", 3)
	if frames[2].params != `{"tool":"codex","sessionId":"s1","text":"hi"}` {
		t.Errorf("the legacy send changed in transit: %s", frames[2].params)
	}

	// Refused before any frame is written: DSH without a provider, Codex with
	// one, and a model-less routing field.
	before := countMethod(seen.snapshot(), "session.send")
	for _, bad := range []string{
		`{"method":"session.send","params":{"tool":"dsh","sessionId":"s1","text":"hi","model":"deepseek-reasoner"}}`,
		`{"method":"session.send","params":{"tool":"codex","sessionId":"s1","text":"hi","model":"gpt-5-codex","provider":"openai"}}`,
		`{"method":"session.send","params":{"tool":"dsh","sessionId":"s1","text":"hi","provider":"deepseek"}}`,
		`{"method":"session.send","params":{"tool":"dsh","sessionId":"s1","text":"hi","model":"m","provider":"p","thinking":"high"}}`,
	} {
		status, raw := e.rpc(cookie, bad)
		if status != 200 || jsonField(t, raw, "ok") != "false" {
			t.Errorf("a refusable send answered %d %s, want ok:false at 200", status, raw)
			continue
		}
		if jsonField(t, raw, "error", "code") != string(protocol.CodeInvalidParams) {
			t.Errorf("a refusable send answered %s, want invalid_params", raw)
		}
	}
	if after := countMethod(seen.snapshot(), "session.send"); after != before {
		t.Errorf("a refused send still reached the desktop (%d -> %d frames)", before, after)
	}
}

// ---- session.read: the two pending projections ----

// TestRPCSessionReadPendingProjectionsReachThePhone covers the read half: the
// desktop's genuine pending questions and pending approvals are forwarded
// exactly as sent, and the relay adds, infers and rewrites nothing.
func TestRPCSessionReadPendingProjectionsReachThePhone(t *testing.T) {
	e := newEnv(t)
	c := e.helloBridge(protocol.Capabilities{
		SessionRead: true, AnswerDSH: true, ApproveDSH: true, Tools: []string{"dsh"},
	})
	cookie := e.pairOnce(c)

	// One reply with both projections present, and one with neither — the
	// relay must not confuse "nothing pending" with "no projection".
	const pending = `"pendingQuestions":[{"callId":"` + workbenchCallID + `","state":"open","questions":[` +
		`{"id":"q1","question":"用哪个模型?","header":"模型","detail":"这只影响下一条消息",` +
		`"options":[{"label":"沿用当前模型","description":"不动设置"},{"label":"下条消息模型"}],"multiSelect":false}]}],` +
		`"pendingApprovals":[{"id":"` + workbenchApprovalID + `","toolName":"shell.exec","callId":"call-raw-1","reason":"运行 npm test"}]`

	replies := []string{
		`{"id":"` + workbenchSessionID + `","tool":"dsh","title":"t","status":"working","messages":[],"canStop":true,` +
			`"currentModel":{"model":"flash","provider":"deepseek","reasoningEffort":"high"},` + pending + `}`,
		`{"id":"` + workbenchSessionID + `","tool":"dsh","title":"t","status":"idle","messages":[],"canStop":false,` +
			`"pendingQuestions":[],"pendingApprovals":[]}`,
	}
	index := 0
	go func() {
		for {
			f, ok := c.readRequestQuiet()
			if !ok {
				return
			}
			if f.Method == "session.read" && index < len(replies) {
				c.send(map[string]any{"type": "response", "id": f.ID, "ok": true, "result": json.RawMessage(replies[index])})
				index++
			}
		}
	}()

	call := `{"method":"session.read","params":{"tool":"dsh","sessionId":"` + workbenchSessionID + `"}}`

	first := e.rpcResult(cookie, call)
	batches, ok := first["pendingQuestions"].([]any)
	if !ok || len(batches) != 1 {
		t.Fatalf("pendingQuestions did not survive: %v", first["pendingQuestions"])
	}
	batch := batches[0].(map[string]any)
	if batch["callId"] != workbenchCallID || batch["state"] != "open" {
		t.Errorf("the batch identity changed in transit: %v", batch)
	}
	questions := batch["questions"].([]any)
	question := questions[0].(map[string]any)
	if question["id"] != "q1" || question["question"] != "用哪个模型?" {
		t.Errorf("the question text changed in transit: %v", question)
	}
	if question["header"] != "模型" || question["detail"] != "这只影响下一条消息" {
		t.Errorf("the question metadata changed in transit: %v", question)
	}
	options := question["options"].([]any)
	if len(options) != 2 {
		t.Fatalf("the option list changed: %v", options)
	}
	if options[0].(map[string]any)["label"] != "沿用当前模型" ||
		options[0].(map[string]any)["description"] != "不动设置" ||
		options[1].(map[string]any)["label"] != "下条消息模型" {
		t.Errorf("the option labels changed in transit: %v", options)
	}
	approvals, ok := first["pendingApprovals"].([]any)
	if !ok || len(approvals) != 1 {
		t.Fatalf("pendingApprovals did not survive: %v", first["pendingApprovals"])
	}
	approval := approvals[0].(map[string]any)
	if approval["id"] != workbenchApprovalID || approval["toolName"] != "shell.exec" || approval["reason"] != "运行 npm test" {
		t.Errorf("the approval changed in transit: %v", approval)
	}
	model := first["currentModel"].(map[string]any)
	if model["model"] != "flash" || model["reasoningEffort"] != "high" {
		t.Errorf("currentModel changed in transit: %v", model)
	}

	// The second reply: "I looked, and there is nothing pending". The relay
	// must hand that through as empty arrays rather than dropping the keys or
	// inventing a question.
	second := e.rpcResult(cookie, call)
	for _, field := range []string{"pendingQuestions", "pendingApprovals"} {
		list, present := second[field]
		if !present {
			t.Errorf("%s disappeared; an empty projection means something", field)
			continue
		}
		items, ok := list.([]any)
		if !ok || len(items) != 0 {
			t.Errorf("%s = %v, want []", field, list)
		}
	}
	if _, present := second["currentModel"]; present {
		t.Errorf("the relay fabricated a currentModel: %v", second["currentModel"])
	}
}

// TestRPCSessionReadRefusesUnrepresentablePendingForms covers the honest
// failure: a form the relay cannot represent in full is refused with
// bridge_bad_response rather than trimmed into something the user would answer
// without having seen all of it.
func TestRPCSessionReadRefusesUnrepresentablePendingForms(t *testing.T) {
	e := newEnv(t)
	c := e.helloBridge(protocol.Capabilities{SessionRead: true, Tools: []string{"dsh"}})
	cookie := e.pairOnce(c)

	head := `{"id":"` + workbenchSessionID + `","tool":"dsh","title":"t","status":"working","messages":[],"canStop":false`
	overLongQuestion := strings.Repeat("啊", 1001)
	replies := []string{
		// Five live forms is over the batch cap.
		head + `,"pendingQuestions":[` +
			`{"callId":"c1","state":"open","questions":[{"id":"q1","question":"q?"}]},` +
			`{"callId":"c2","state":"open","questions":[{"id":"q1","question":"q?"}]},` +
			`{"callId":"c3","state":"open","questions":[{"id":"q1","question":"q?"}]},` +
			`{"callId":"c4","state":"open","questions":[{"id":"q1","question":"q?"}]},` +
			`{"callId":"c5","state":"open","questions":[{"id":"q1","question":"q?"}]}]}`,
		// A question longer than the representable ceiling.
		head + `,"pendingQuestions":[{"callId":"c1","state":"open","questions":[{"id":"q1","question":"` +
			overLongQuestion + `"}]}]}`,
		// A batch whose state is not one the relay can present as answerable.
		head + `,"pendingQuestions":[{"callId":"c1","state":"maybe","questions":[{"id":"q1","question":"q?"}]}]}`,
		// An approval whose id is not a real event id shape.
		head + `,"pendingApprovals":[{"id":"approval-1","toolName":"shell.exec"}]}`,
		// An approval whose tool name cannot be shown must not become a button.
		head + `,"pendingApprovals":[{"id":"` + workbenchApprovalID + `","toolName":"   "}]}`,
		// A projection carrying native transport internals.
		head + `,"pendingApprovals":[{"id":"` + workbenchApprovalID + `","toolName":"shell.exec","clientId":"abc"}]}`,
		head + `,"pendingQuestions":[{"callId":"c1","state":"open","clientId":"abc","questions":[{"id":"q1","question":"q?"}]}]}`,
		// A nulled projection: "unknown" must not be readable as "nothing".
		head + `,"pendingQuestions":null}`,
	}
	index := 0
	go func() {
		for {
			f, ok := c.readRequestQuiet()
			if !ok {
				return
			}
			if f.Method == "session.read" && index < len(replies) {
				c.send(map[string]any{"type": "response", "id": f.ID, "ok": true, "result": json.RawMessage(replies[index])})
				index++
			}
		}
	}()

	call := `{"method":"session.read","params":{"tool":"dsh","sessionId":"` + workbenchSessionID + `"}}`
	for i := range replies {
		status, raw := e.rpc(cookie, call)
		if status != http.StatusBadGateway {
			t.Errorf("reply %d: status = %d, want 502 (body %s)", i, status, raw)
			continue
		}
		if jsonField(t, raw, "error", "code") != string(protocol.CodeBridgeBadResponse) {
			t.Errorf("reply %d: code = %s, want bridge_bad_response", i, raw)
		}
		// The refusal must not leak the form's contents back to the phone.
		if strings.Contains(raw, "clientId") || strings.Contains(raw, "abc") {
			t.Errorf("reply %d: the refusal echoed projection internals: %s", i, raw)
		}
	}
}

// ---- session.answer ----

// TestRPCSessionAnswerRoundTrip covers the answer call at the seam: the batch
// reaches the desktop byte for byte with the exact sessionId and callId, the
// acknowledgement names that batch, and nothing is retried.
func TestRPCSessionAnswerRoundTrip(t *testing.T) {
	e := newEnv(t)
	c := e.helloBridge(protocol.Capabilities{
		SessionRead: true, AnswerDSH: true, Tools: []string{"dsh"},
	})
	cookie := e.pairOnce(c)

	seen := serveBridge(t, c, func(t *testing.T, c *wsClient, f *protocol.Frame) {
		if f.Method == "session.answer" {
			c.answer(f.ID, map[string]any{
				"accepted": true, "sessionId": workbenchSessionID, "callId": workbenchCallID,
			})
		}
	})

	body := `{"method":"session.answer","params":{"tool":"dsh","sessionId":"` + workbenchSessionID + `",` +
		`"callId":"` + workbenchCallID + `","answers":[{"id":"q1","selected":["下条消息模型"]}]}}`
	result := e.rpcResult(cookie, body)
	if result["accepted"] != true {
		t.Fatalf("answer result = %v, want accepted:true", result)
	}
	if result["sessionId"] != workbenchSessionID || result["callId"] != workbenchCallID {
		t.Errorf("the acknowledgement did not name the batch: %v", result)
	}

	frames := waitForMethod(t, seen, "session.answer", 1)
	got := frames[0].params
	for _, want := range []string{
		`"sessionId":"` + workbenchSessionID + `"`,
		`"callId":"` + workbenchCallID + `"`,
		`"answers":[{"id":"q1","selected":["下条消息模型"]}]`,
	} {
		if !strings.Contains(got, want) {
			t.Errorf("the desktop did not receive %s (got %s)", want, got)
		}
	}
	// Exactly once: an answer must never be submitted twice.
	if n := countMethod(seen.snapshot(), "session.answer"); n != 1 {
		t.Errorf("the desktop received %d answer frames, want exactly 1", n)
	}
	if n := countMethod(seen.snapshot(), "session.send"); n != 0 {
		t.Errorf("answer grew a side effect: %d send frames", n)
	}
}

// TestRPCSessionAnswerMalformedNeverReachesTheDesktop covers the params seam for
// answers: every malformed shape is refused before a frame is written, so a
// half-valid form can never reach a live turn.
func TestRPCSessionAnswerMalformedNeverReachesTheDesktop(t *testing.T) {
	e := newEnv(t)
	c := e.helloBridge(protocol.Capabilities{AnswerDSH: true, Tools: []string{"dsh"}})
	cookie := e.pairOnce(c)
	seen := serveBridge(t, c, func(t *testing.T, c *wsClient, f *protocol.Frame) {
		c.answer(f.ID, map[string]any{"accepted": true, "sessionId": workbenchSessionID, "callId": workbenchCallID})
	})

	base := `{"tool":"dsh","sessionId":"` + workbenchSessionID + `","callId":"` + workbenchCallID + `","answers":`
	bad := []struct {
		name string
		body string
	}{
		{"no callId", `{"method":"session.answer","params":{"tool":"dsh","sessionId":"s1","answers":[{"id":"q1","selected":["a"]}]}}`},
		{"empty batch", `{"method":"session.answer","params":` + base + `[]}}`},
		{"duplicate question ids", `{"method":"session.answer","params":` + base + `[{"id":"q1","selected":["a"]},{"id":"q1","selected":["b"]}]}}`},
		{"duplicate selected labels", `{"method":"session.answer","params":` + base + `[{"id":"q1","selected":["a","a"]}]}}`},
		{"empty answer for one question", `{"method":"session.answer","params":` + base + `[{"id":"q1","selected":[]}]}}`},
		{"blank option label", `{"method":"session.answer","params":` + base + `[{"id":"q1","selected":["  "]}]}}`},
		{"answers is not an array", `{"method":"session.answer","params":` + base + `"q1"}}`},
		{"nine questions", `{"method":"session.answer","params":` + base + `[` +
			`{"id":"q1","selected":["a"]},{"id":"q2","selected":["a"]},{"id":"q3","selected":["a"]},` +
			`{"id":"q4","selected":["a"]},{"id":"q5","selected":["a"]},{"id":"q6","selected":["a"]},` +
			`{"id":"q7","selected":["a"]},{"id":"q8","selected":["a"]},{"id":"q9","selected":["a"]}]}}`},
		{"a generic rpc escape hatch", `{"method":"session.answer","params":{"tool":"dsh","sessionId":"s1","callId":"c","answers":[{"id":"q1","selected":["a"]}],"method":"$events/result"}}`},
		{"a shell door", `{"method":"session.answer","params":{"tool":"dsh","sessionId":"s1","callId":"c","answers":[{"id":"q1","selected":["a"]}],"command":"whoami"}}`},
		{"a timeoutMs inside params", `{"method":"session.answer","params":{"tool":"dsh","sessionId":"s1","callId":"c","answers":[{"id":"q1","selected":["a"]}],"timeoutMs":1}}`},
	}
	for _, tc := range bad {
		status, raw := e.rpc(cookie, tc.body)
		if status != 200 {
			t.Errorf("%s: status = %d, want 200 (body %s)", tc.name, status, raw)
			continue
		}
		if jsonField(t, raw, "ok") != "false" || jsonField(t, raw, "error", "code") != string(protocol.CodeInvalidParams) {
			t.Errorf("%s: %s, want ok:false invalid_params", tc.name, raw)
		}
	}
	// An over-long free-text answer is a distinct, honest code.
	tooLong := `{"method":"session.answer","params":` + base + `[{"id":"q1","selected":[],"custom":"` +
		strings.Repeat("a", 1001) + `"}]}}`
	if _, raw := e.rpc(cookie, tooLong); jsonField(t, raw, "error", "code") != string(protocol.CodeInvalidParams) {
		t.Errorf("an over-long custom answer = %s, want invalid_params", raw)
	}

	if n := countMethod(seen.snapshot(), "session.answer"); n != 0 {
		t.Fatalf("%d malformed answer(s) reached the desktop; none may", n)
	}
}

// TestRPCSessionAnswerStaleCallIsAHonestFailure covers the failed answer: the
// desktop says the question is no longer open, the relay hands that code to the
// phone with a safe message, and nothing is retried or auto-answered.
func TestRPCSessionAnswerStaleCallIsAHonestFailure(t *testing.T) {
	e := newEnv(t)
	c := e.helloBridge(protocol.Capabilities{AnswerDSH: true, Tools: []string{"dsh"}})
	cookie := e.pairOnce(c)

	seen := serveBridge(t, c, func(t *testing.T, c *wsClient, f *protocol.Frame) {
		if f.Method == "session.answer" {
			c.answerError(f.ID, string(protocol.CodeAnswerNotOpen), "that question is no longer open")
		}
	})

	body := `{"method":"session.answer","params":{"tool":"dsh","sessionId":"` + workbenchSessionID + `",` +
		`"callId":"` + workbenchCallID + `","answers":[{"id":"q1","selected":["a"]}]}}`
	status, raw := e.rpc(cookie, body)
	if status != 200 {
		t.Fatalf("a stale answer answered %d, want 200 (body %s)", status, raw)
	}
	if jsonField(t, raw, "ok") != "false" {
		t.Fatalf("a stale answer reported success: %s", raw)
	}
	if jsonField(t, raw, "error", "code") != string(protocol.CodeAnswerNotOpen) {
		t.Errorf("code = %s, want answer_not_open", raw)
	}
	frames := waitForMethod(t, seen, "session.answer", 1)
	if n := countMethod(frames, "session.answer"); n != 1 {
		t.Errorf("the desktop saw %d answer frames; a refusal must not be retried", n)
	}
}

// TestRPCSessionAnswerUnreportableBridgeCodeIsABadResponse covers §8.4.8 for the
// new method: a bridge may only report the codes the contract allows, so a
// bridge that answers with something else becomes bridge_bad_response rather
// than handing the phone a code it cannot branch on. It gets a bridge of its own
// because exactly one goroutine may read a connection.
func TestRPCSessionAnswerUnreportableBridgeCodeIsABadResponse(t *testing.T) {
	e := newEnv(t)
	c := e.helloBridge(protocol.Capabilities{AnswerDSH: true, Tools: []string{"dsh"}})
	cookie := e.pairOnce(c)
	serveBridge(t, c, func(t *testing.T, c *wsClient, f *protocol.Frame) {
		// forbidden is a real code, but not one a bridge may choose in a
		// response frame.
		c.answerError(f.ID, string(protocol.CodeForbidden), "nope")
	})

	body := `{"method":"session.answer","params":{"tool":"dsh","sessionId":"` + workbenchSessionID + `",` +
		`"callId":"` + workbenchCallID + `","answers":[{"id":"q1","selected":["a"]}]}}`
	if _, raw := e.rpc(cookie, body); jsonField(t, raw, "error", "code") != string(protocol.CodeBridgeBadResponse) {
		t.Errorf("an unreportable bridge code = %s, want bridge_bad_response", raw)
	}
}

// ---- session.approve ----

// TestRPCSessionApproveSubmittedIsATransportReceipt is the heart of the approval
// rule: the relay forwards one exact decision, reports it as SUBMITTED, and
// makes no claim that the permission was granted or that the submission won.
func TestRPCSessionApproveSubmittedIsATransportReceipt(t *testing.T) {
	e := newEnv(t)
	c := e.helloBridge(protocol.Capabilities{
		SessionRead: true, ApproveDSH: true, Tools: []string{"dsh"},
	})
	cookie := e.pairOnce(c)

	seen := serveBridge(t, c, func(t *testing.T, c *wsClient, f *protocol.Frame) {
		if f.Method == "session.approve" {
			// The desktop's honest answer: the submission left the building and
			// whether it won the race is not yet known.
			c.answer(f.ID, map[string]any{
				"accepted": true, "sessionId": workbenchSessionID,
				"approvalId": workbenchApprovalID, "state": "submitted",
			})
		}
	})

	body := `{"method":"session.approve","params":{"tool":"dsh","sessionId":"` + workbenchSessionID + `",` +
		`"approvalId":"` + workbenchApprovalID + `","decision":"allow-once"}}`
	result := e.rpcResult(cookie, body)
	if result["accepted"] != true {
		t.Fatalf("approve result = %v, want accepted:true", result)
	}
	if result["state"] != "submitted" {
		t.Fatalf("state = %v, want submitted", result["state"])
	}
	if result["approvalId"] != workbenchApprovalID || result["sessionId"] != workbenchSessionID {
		t.Errorf("the acknowledgement did not name the request: %v", result)
	}
	// The relay must not colour a submission as an outcome. Any of these words
	// in the response would be a claim about native state that nobody made.
	for _, forbidden := range []string{"approved", "granted", "allowed", "allowed-once", "confirmed", "permission"} {
		if strings.Contains(strings.ToLower(string(mustJSON(t, result))), forbidden) {
			t.Errorf("the approval response claims %q: %v", forbidden, result)
		}
	}

	frames := waitForMethod(t, seen, "session.approve", 1)
	got := frames[0].params
	if !strings.Contains(got, `"decision":"allow-once"`) || !strings.Contains(got, `"approvalId":"`+workbenchApprovalID+`"`) {
		t.Errorf("the desktop did not receive the exact decision: %s", got)
	}
	if n := countMethod(seen.snapshot(), "session.approve"); n != 1 {
		t.Errorf("the desktop received %d approve frames, want exactly 1", n)
	}
	// Approving is not sending: no prompt may grow out of it.
	if n := countMethod(seen.snapshot(), "session.send"); n != 0 {
		t.Errorf("approve grew a send side effect: %d frames", n)
	}
}

// TestRPCSessionApproveConfirmedOnlyWhenTheDesktopSaysSo covers the one state
// the relay is allowed to pass through as a real outcome, and the states it
// refuses to invent or accept.
func TestRPCSessionApproveConfirmedOnlyWhenTheDesktopSaysSo(t *testing.T) {
	e := newEnv(t)
	c := e.helloBridge(protocol.Capabilities{ApproveDSH: true, Tools: []string{"dsh"}})
	cookie := e.pairOnce(c)

	serveBridge(t, c, func(t *testing.T, c *wsClient, f *protocol.Frame) {
		switch f.Method {
		case "session.approve":
			c.answer(f.ID, map[string]any{
				"accepted": true, "sessionId": workbenchSessionID,
				"approvalId": workbenchApprovalID, "state": "confirmed",
			})
		case "session.read":
			// The re-read after an approval must show the REAL native state,
			// including whatever is still pending. Here: nothing is.
			c.answer(f.ID, map[string]any{
				"id": workbenchSessionID, "tool": "dsh", "title": "t", "status": "working",
				"messages": []any{}, "canStop": true,
				"pendingAnswers": nil, "pendingApprovals": []any{},
			})
		}
	})

	body := `{"method":"session.approve","params":{"tool":"dsh","sessionId":"` + workbenchSessionID + `",` +
		`"approvalId":"` + workbenchApprovalID + `","decision":"reject"}}`
	result := e.rpcResult(cookie, body)
	if result["state"] != "confirmed" {
		t.Fatalf("state = %v, want confirmed (the desktop claimed a native audit)", result["state"])
	}
	// The phone can now re-read and see the genuine state for itself.
	read := e.rpcResult(cookie, `{"method":"session.read","params":{"tool":"dsh","sessionId":"`+workbenchSessionID+`"}}`)
	approvals, ok := read["pendingApprovals"].([]any)
	if !ok || len(approvals) != 0 {
		t.Errorf("the re-read did not show the real pending state: %v", read["pendingApprovals"])
	}
}

// TestRPCSessionApproveRefusesToFakeAnOutcome covers the two ways an approval
// could be turned into a lie: a decision the transport does not have, and a
// result whose state is not one of the two real states.
func TestRPCSessionApproveRefusesToFakeAnOutcome(t *testing.T) {
	e := newEnv(t)
	c := e.helloBridge(protocol.Capabilities{ApproveDSH: true, Tools: []string{"dsh"}})
	cookie := e.pairOnce(c)
	seen := serveBridge(t, c, func(t *testing.T, c *wsClient, f *protocol.Frame) {
		// A desktop that answers with a state the contract does not define.
		c.answer(f.ID, map[string]any{
			"accepted": true, "sessionId": workbenchSessionID,
			"approvalId": workbenchApprovalID, "state": "allowed",
		})
	})

	base := `{"method":"session.approve","params":{"tool":"dsh","sessionId":"` + workbenchSessionID + `","approvalId":"` + workbenchApprovalID + `","decision":`

	// Decisions that do not exist on this transport, including the two that
	// would be a policy change rather than an answer.
	for _, decision := range []string{`"allow-always"`, `"always"`, `"allow"`, `"approved"`, `"REJECT"`, `"rejected"`, `""`} {
		status, raw := e.rpc(cookie, base+decision+`}}`)
		if status != 200 || jsonField(t, raw, "ok") != "false" {
			t.Errorf("decision %s answered %d %s, want ok:false", decision, status, raw)
			continue
		}
		if jsonField(t, raw, "error", "code") != string(protocol.CodeInvalidParams) {
			t.Errorf("decision %s answered %s, want invalid_params", decision, raw)
		}
	}
	// A non-UUID approvalId is not a request this transport can name.
	for _, id := range []string{`"approval-1"`, `""`, `7`} {
		_, raw := e.rpc(cookie, `{"method":"session.approve","params":{"tool":"dsh","sessionId":"s1","approvalId":`+id+`,"decision":"reject"}}`)
		if jsonField(t, raw, "error", "code") != string(protocol.CodeInvalidParams) {
			t.Errorf("approvalId %s answered %s, want invalid_params", id, raw)
		}
	}
	if n := countMethod(seen.snapshot(), "session.approve"); n != 0 {
		t.Fatalf("%d refusable approval(s) reached the desktop; none may", n)
	}

	// The one well-formed approval reaches the desktop, and its undefined state
	// is refused rather than displayed.
	status, raw := e.rpc(cookie, base+`"reject"}}`)
	if status != http.StatusBadGateway {
		t.Fatalf("an undefined state answered %d, want 502 (body %s)", status, raw)
	}
	if jsonField(t, raw, "error", "code") != string(protocol.CodeBridgeBadResponse) {
		t.Errorf("an undefined approval state = %s, want bridge_bad_response", raw)
	}
	if strings.Contains(raw, `"allowed"`) {
		t.Errorf("the refusal echoed the undefined state: %s", raw)
	}
}

// TestRPCSessionApproveStaleRequestIsAHonestFailure covers the lost race: the
// request is no longer pending, the phone is told so explicitly, and no retry is
// attempted on its behalf.
func TestRPCSessionApproveStaleRequestIsAHonestFailure(t *testing.T) {
	e := newEnv(t)
	c := e.helloBridge(protocol.Capabilities{ApproveDSH: true, Tools: []string{"dsh"}})
	cookie := e.pairOnce(c)
	seen := serveBridge(t, c, func(t *testing.T, c *wsClient, f *protocol.Frame) {
		if f.Method == "session.approve" {
			c.answerError(f.ID, string(protocol.CodeApprovalUnknown), "that approval request is no longer pending")
		}
	})

	body := `{"method":"session.approve","params":{"tool":"dsh","sessionId":"` + workbenchSessionID + `",` +
		`"approvalId":"` + workbenchApprovalID + `","decision":"allow-once"}}`
	status, raw := e.rpc(cookie, body)
	if status != 200 || jsonField(t, raw, "ok") != "false" {
		t.Fatalf("a stale approval answered %d %s, want ok:false at 200", status, raw)
	}
	if jsonField(t, raw, "error", "code") != string(protocol.CodeApprovalUnknown) {
		t.Errorf("code = %s, want approval_unknown", raw)
	}
	if n := countMethod(waitForMethod(t, seen, "session.approve", 1), "session.approve"); n != 1 {
		t.Errorf("the desktop saw %d approve frames; a lost race must not be retried", n)
	}
}

// ---- capabilities and the old surface ----

// TestRPCWorkbenchCapabilitiesPassThroughAndOldSurfaceIsUnchanged pins both
// halves of the compatibility promise at the seam: the six new capability keys
// travel exactly as the desktop declared them, and the pre-existing methods are
// untouched next to the new ones.
func TestRPCWorkbenchCapabilitiesPassThroughAndOldSurfaceIsUnchanged(t *testing.T) {
	e := newEnv(t)
	c := e.helloBridge(protocol.Capabilities{
		SessionRead: true, SessionSend: true, SessionStop: true, AnswerDSH: true, Tools: []string{"codex", "dsh"},
	})
	cookie := e.pairOnce(c)

	// An old-style declaration plus the new keys, verbatim. Neither the relay
	// nor this test builds it.
	const caps = `{"session.read":true,"session.send":true,"session.answer:dsh":true,` +
		`"session.answer:codex":false,"session.approve:dsh":true,"session.send:model:dsh":true,"tools":["codex","dsh"]}`
	needsInputReply := `{"sessions":[{"id":"` + workbenchSessionID + `","tool":"dsh","title":"t","status":"working",` +
		`"updatedAt":"2026-10-08T03:57:55Z","cwd":null,"needsInput":true}],"capabilities":` + caps + `}`
	go func() {
		for {
			f, ok := c.readRequestQuiet()
			if !ok {
				return
			}
			if f.Method == "sessions.list" {
				c.send(map[string]any{"type": "response", "id": f.ID, "ok": true, "result": json.RawMessage(needsInputReply)})
			}
		}
	}()

	result := e.rpcResult(cookie, `{"method":"sessions.list","params":{"tool":"dsh"}}`)
	sessions := result["sessions"].([]any)
	summary := sessions[0].(map[string]any)
	if summary["needsInput"] != true {
		t.Errorf("needsInput did not survive: %v", summary["needsInput"])
	}
	got, ok := result["capabilities"].(map[string]any)
	if !ok {
		t.Fatalf("capabilities did not survive: %v", result["capabilities"])
	}
	if got["session.answer:dsh"] != true || got["session.approve:dsh"] != true || got["session.send:model:dsh"] != true {
		t.Errorf("the new capability keys were dropped or rewritten: %v", got)
	}
	if v, present := got["session.answer:codex"]; !present || v != false {
		t.Errorf("a declared false capability did not survive: %v", got)
	}
	if len(got) != 7 {
		t.Errorf("capabilities gained or lost a key: %v", got)
	}

	// The old methods still work next to the new ones, with their old errors.
	// A bridge that is not answering turns a call into a timeout, not a retry.
	bad := []struct {
		name   string
		body   string
		status int
		code   protocol.Code
	}{
		{"unknown method", `{"method":"session.kill","params":{}}`, 200, protocol.CodeUnknownMethod},
		{"a generic rpc door", `{"method":"native.rpc","params":{"method":"$events/result"}}`, 200, protocol.CodeUnknownMethod},
		{"a shell door", `{"method":"shell.exec","params":{"command":"whoami"}}`, 200, protocol.CodeUnknownMethod},
		{"model without provider on dsh", `{"method":"session.send","params":{"tool":"dsh","sessionId":"s1","text":"hi","model":"m"}}`, 200, protocol.CodeInvalidParams},
		{"an empty events list method", `{"method":"events.list","params":{}}`, 200, protocol.CodeUnknownMethod},
		{"session.stop still passes the whitelist", `{"method":"session.read","params":{"tool":"dsh","sessionId":"s1","events":true}}`, 200, protocol.CodeInvalidParams},
	}
	for _, tc := range bad {
		status, raw := e.rpc(cookie, tc.body)
		if status != tc.status {
			t.Errorf("%s: status = %d, want %d (body %s)", tc.name, status, tc.status, raw)
			continue
		}
		if jsonField(t, raw, "error", "code") != string(tc.code) {
			t.Errorf("%s: answered %s, want %s", tc.name, raw, tc.code)
		}
	}
}
