package bridge

import (
	"context"
	"encoding/json"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/ai-remote/relay/internal/protocol"
)

// fakeSender stands in for the WebSocket connection. What is mocked here is
// only the *transport*: the hub's dispatch, its pending table, its budgets and
// its timeouts are the real code under test. The one real-socket end-to-end
// test lives in internal/server.
type fakeSender struct {
	mu     sync.Mutex
	frames [][]byte
	onSend func(frame *protocol.Frame)
	fail   error
}

func (f *fakeSender) send(_ context.Context, b []byte) error {
	f.mu.Lock()
	f.frames = append(f.frames, append([]byte(nil), b...))
	hook := f.onSend
	fail := f.fail
	f.mu.Unlock()
	if hook != nil {
		var frame protocol.Frame
		if err := json.Unmarshal(b, &frame); err == nil {
			hook(&frame)
		}
	}
	return fail
}

func (f *fakeSender) count() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return len(f.frames)
}

func (f *fakeSender) last() *protocol.Frame {
	f.mu.Lock()
	defer f.mu.Unlock()
	if len(f.frames) == 0 {
		return nil
	}
	var frame protocol.Frame
	_ = json.Unmarshal(f.frames[len(f.frames)-1], &frame)
	return &frame
}

func helloHub(t *testing.T, h *Hub) (*fakeSender, *Conn) {
	t.Helper()
	fs := &fakeSender{}
	c := h.Register(fs.send)
	h.Hello(c, "DESKTOP-7F3A", protocol.Capabilities{
		SessionsList: true, SessionRead: true, SessionSend: true, SessionStop: true,
		StopDSH: true, Tools: []string{"codex", "dsh"},
	})
	return fs, c
}

// TestBridgeOnlineNeedsAHello covers §7.1: a connection that has not completed
// its hello is not online, so /health cannot claim the desktop is there.
func TestBridgeOnlineNeedsAHello(t *testing.T) {
	h := NewHub()
	if h.BridgeOnline() {
		t.Fatal("BridgeOnline() = true with no connections at all")
	}

	fs := &fakeSender{}
	c := h.Register(fs.send)
	if h.BridgeOnline() {
		t.Fatal("BridgeOnline() = true before hello")
	}
	h.Hello(c, "DESKTOP", protocol.Capabilities{Tools: []string{"codex"}})
	if !h.BridgeOnline() {
		t.Fatal("BridgeOnline() = false after a valid hello")
	}
	h.Unregister(c)
	if h.BridgeOnline() {
		t.Fatal("BridgeOnline() = true after the only connection was unregistered")
	}
}

// TestCallWhenOffline covers §10.1 and step 12: no bridge means the phone gets
// bridge_offline, not a hang.
func TestCallWhenOffline(t *testing.T) {
	h := NewHub()
	reply := h.Call(context.Background(), "sessions.list", json.RawMessage(`{}`), time.Second)
	if reply.Code != protocol.CodeBridgeOffline {
		t.Fatalf("Call with no bridge = %+v, want bridge_offline", reply)
	}
}

// TestCallHappyPathAndIDSeparation covers §10.1 and 4.1: each request gets its
// own id, and the matching response is the only one that completes it.
func TestCallHappyPathAndIDSeparation(t *testing.T) {
	h := NewHub()
	fs, c := helloHub(t, h)

	ids := make(chan string, 2)
	fs.onSend = func(frame *protocol.Frame) {
		if frame.Type != protocol.FrameRequest {
			return
		}
		ids <- frame.ID
		go func(id string) {
			payload, _ := json.Marshal(map[string]any{
				"type": "response", "id": id, "ok": true,
				"result": map[string]any{"sessions": []any{}, "capabilities": map[string]any{}},
			})
			h.DeliverFrom(c, id, payload)
		}(frame.ID)
	}

	reply := h.Call(context.Background(), "sessions.list", json.RawMessage(`{}`), 2*time.Second)
	if reply.Code != "" || reply.Err != nil {
		t.Fatalf("Call = %+v, want a successful result", reply)
	}
	if len(reply.Result) == 0 {
		t.Fatal("Call returned an empty result")
	}

	// A second call must use a different id, and an answer to an unknown id
	// must be dropped without disturbing anything (§10.2).
	fs.onSend = nil
	done := make(chan Reply, 1)
	go func() { done <- h.Call(context.Background(), "sessions.list", json.RawMessage(`{}`), 2*time.Second) }()
	time.Sleep(50 * time.Millisecond)
	stale, _ := json.Marshal(map[string]any{"type": "response", "id": "00000000-0000-4000-8000-000000000000", "ok": true, "result": map[string]any{}})
	h.DeliverFrom(c, "00000000-0000-4000-8000-000000000000", stale)
	select {
	case r := <-done:
		if r.Code != protocol.CodeBridgeTimeout {
			t.Fatalf("a stale response completed a live call: %+v", r)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("call never completed")
	}
}

// TestCallTimeoutDoesNotResend covers R10 and §10.2: on timeout the phone gets
// bridge_timeout, the pending slot is freed, and the relay never sends a second
// request — a resend would duplicate a session.send.
func TestCallTimeoutDoesNotResend(t *testing.T) {
	h := NewHub()
	fs, _ := helloHub(t, h)

	reply := h.Call(context.Background(), "session.send", json.RawMessage(`{"tool":"codex","sessionId":"s1","text":"hi"}`), 150*time.Millisecond)
	if reply.Code != protocol.CodeBridgeTimeout {
		t.Fatalf("Call with no answer = %+v, want bridge_timeout", reply)
	}
	time.Sleep(200 * time.Millisecond)
	if got := fs.count(); got != 1 {
		t.Fatalf("the bridge received %d request frames, want exactly 1 (no retry)", got)
	}
	if h.PendingCount() != 0 {
		t.Fatalf("PendingCount() = %d after a timeout, want 0 (the slot must be reclaimed)", h.PendingCount())
	}
}

// TestDisconnectFailsEveryPendingCall covers §10.2: when the desktop drops, all
// of its in-flight calls end at once rather than waiting out their budgets.
func TestDisconnectFailsEveryPendingCall(t *testing.T) {
	h := NewHub()
	_, c := helloHub(t, h)

	done := make(chan Reply, 3)
	for i := 0; i < 3; i++ {
		go func() {
			done <- h.Call(context.Background(), "session.read", json.RawMessage(`{"tool":"codex","sessionId":"s1"}`), 5*time.Second)
		}()
	}
	time.Sleep(100 * time.Millisecond)
	h.Unregister(c)

	for i := 0; i < 3; i++ {
		select {
		case r := <-done:
			if r.Code != protocol.CodeBridgeBadResponse {
				t.Fatalf("call after disconnect = %+v, want bridge_bad_response", r)
			}
			if r.Err == nil || r.Err.Message != "bridge disconnected" {
				t.Fatalf("disconnect message = %+v, want \"bridge disconnected\"", r.Err)
			}
		case <-time.After(2 * time.Second):
			t.Fatal("a pending call was not failed on disconnect")
		}
	}
	if h.PendingCount() != 0 {
		t.Fatalf("PendingCount() = %d after disconnect, want 0", h.PendingCount())
	}
}

// TestPendingIsBounded covers §10.2 and invariant 8: the global cap refuses new
// work with bridge_busy instead of growing without limit.
func TestPendingIsBounded(t *testing.T) {
	h := NewHub()
	h.SetLimits(2, 3) // per connection 2, global 3
	helloHub(t, h)
	fs2 := &fakeSender{}
	c2 := h.Register(fs2.send)
	h.Hello(c2, "SECOND", protocol.Capabilities{Tools: []string{"codex"}})

	// Fill the first connection to its per-connection cap.
	hold := make(chan Reply, 8)
	for i := 0; i < 2; i++ {
		go func() { hold <- h.Call(context.Background(), "sessions.list", json.RawMessage(`{}`), 5*time.Second) }()
	}
	time.Sleep(100 * time.Millisecond)

	// Its own cap is reached, so the next call must go to the other connection
	// rather than pile up here (§10.3 step 2).
	go func() { hold <- h.Call(context.Background(), "sessions.list", json.RawMessage(`{}`), 5*time.Second) }()
	time.Sleep(100 * time.Millisecond)

	// The global cap is now reached, so this one must be refused outright.
	reply := h.Call(context.Background(), "sessions.list", json.RawMessage(`{}`), 5*time.Second)
	if reply.Code != protocol.CodeBridgeBusy {
		t.Fatalf("Call at the global cap = %+v, want bridge_busy", reply)
	}
	if h.PendingCount() > 3 {
		t.Fatalf("PendingCount() = %d, want it bounded by the global cap 3", h.PendingCount())
	}
}

// TestResponseIsValidatedBeforeItReachesThePhone covers §8.4.8: a bridge cannot
// smuggle a relay-only error code through, and a result that does not match the
// method's shape becomes bridge_bad_response rather than reaching the phone.
func TestResponseIsValidatedBeforeItReachesThePhone(t *testing.T) {
	cases := []struct {
		name     string
		response string
		wantCode protocol.Code
	}{
		{
			name:     "error code the bridge may not use",
			response: `{"type":"response","id":"%s","ok":false,"error":{"code":"unauthenticated","message":"nope"}}`,
			wantCode: protocol.CodeBridgeBadResponse,
		},
		{
			name:     "result of the wrong shape",
			response: `{"type":"response","id":"%s","ok":true,"result":{"accepted":true}}`,
			wantCode: protocol.CodeBridgeBadResponse,
		},
		{
			name:     "ok false with a safe code passes through",
			response: `{"type":"response","id":"%s","ok":false,"error":{"code":"session_not_found","message":"session not found"}}`,
			wantCode: "",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			h := NewHub()
			fs, c := helloHub(t, h)
			fs.onSend = func(frame *protocol.Frame) {
				if frame.Type != protocol.FrameRequest {
					return
				}
				payload := []byte(replaceID(tc.response, frame.ID))
				h.DeliverFrom(c, frame.ID, payload)
			}
			reply := h.Call(context.Background(), "session.send", json.RawMessage(`{"tool":"codex","sessionId":"s1","text":"hi"}`), 2*time.Second)
			if tc.wantCode == "" {
				if reply.Err == nil || reply.Err.Code != protocol.CodeSessionNotFound {
					t.Fatalf("reply = %+v, want the bridge's session_not_found passed through", reply)
				}
				return
			}
			if reply.Code != tc.wantCode {
				t.Fatalf("reply = %+v, want code %s", reply, tc.wantCode)
			}
		})
	}
}

// TestEmptyToolsTrimsSessionsList covers §9.5: a desktop that declares no
// session source stays connected, and its list is reported as empty instead of
// forwarding whatever it sent.
func TestEmptyToolsTrimsSessionsList(t *testing.T) {
	h := NewHub()
	fs := &fakeSender{}
	c := h.Register(fs.send)
	h.Hello(c, "EMPTY", protocol.Capabilities{})

	fs.onSend = func(frame *protocol.Frame) {
		if frame.Type != protocol.FrameRequest {
			return
		}
		payload, _ := json.Marshal(map[string]any{
			"type": "response", "id": frame.ID, "ok": true,
			"result": map[string]any{
				"sessions":     []any{map[string]any{"id": "s1", "tool": "codex", "title": "t", "status": "idle", "updatedAt": "2026-10-08T03:57:55Z", "cwd": nil}},
				"capabilities": map[string]any{},
			},
		})
		h.DeliverFrom(c, frame.ID, payload)
	}

	reply := h.Call(context.Background(), "sessions.list", json.RawMessage(`{}`), 2*time.Second)
	if reply.Code != "" || reply.Err != nil {
		t.Fatalf("Call = %+v, want success", reply)
	}
	var out struct {
		Sessions []json.RawMessage `json:"sessions"`
	}
	if err := json.Unmarshal(reply.Result, &out); err != nil {
		t.Fatalf("result is not json: %v", err)
	}
	if len(out.Sessions) != 0 {
		t.Fatalf("sessions = %d entries, want 0 for a bridge that declared no tools", len(out.Sessions))
	}
}

// TestPickPrefersTheLeastBusyConnection covers §10.3.
func TestPickPrefersTheLeastBusyConnection(t *testing.T) {
	h := NewHub()
	fsA, cA := helloHub(t, h)
	fsB := &fakeSender{}
	cB := h.Register(fsB.send)
	h.Hello(cB, "B", protocol.Capabilities{Tools: []string{"codex"}})

	// Occupy connection A; the next dispatch must choose B.
	done := make(chan struct{})
	go func() {
		h.Call(context.Background(), "sessions.list", json.RawMessage(`{}`), 2*time.Second)
		close(done)
	}()
	time.Sleep(100 * time.Millisecond)

	picked, ok := h.Pick()
	if !ok {
		t.Fatal("Pick() found no connection")
	}
	if picked != cB {
		t.Fatal("Pick() chose a connection with pending work over an idle one")
	}
	_ = fsA
	_ = cA
	<-done
}

func TestCallComputerRoutesOverlappingSessionIDsByIdentity(t *testing.T) {
	h := NewHub()
	clientA := "0f1c7a2e-9b64-4c5f-8f1a-2d3e4b5c6a70"
	clientB := "3f2504e0-4f89-41d3-9a0c-0305e82c3301"
	makeDesktop := func(id, title string) (*fakeSender, *Conn) {
		fs := &fakeSender{}
		conn := h.Register(fs.send)
		h.HelloIdentity(conn, id, title, "DESKTOP", protocol.Capabilities{Tools: []string{"codex"}})
		fs.onSend = func(frame *protocol.Frame) {
			if frame.Type != protocol.FrameRequest {
				return
			}
			response, _ := json.Marshal(map[string]any{
				"type": "response", "id": frame.ID, "ok": true,
				"result": map[string]any{
					"id": "shared-session", "tool": "codex", "title": title,
					"status": "working", "messages": []any{}, "canStop": false,
				},
			})
			h.DeliverFrom(conn, frame.ID, response)
		}
		return fs, conn
	}
	_, connA := makeDesktop(clientA, "Computer A")
	_, connB := makeDesktop(clientB, "Computer B")
	defer h.Unregister(connA)
	defer h.Unregister(connB)

	params := json.RawMessage(`{"tool":"codex","sessionId":"shared-session"}`)
	for _, tc := range []struct {
		clientID string
		want     string
	}{{clientA, "Computer A"}, {clientB, "Computer B"}} {
		reply := h.CallComputer(context.Background(), tc.clientID, "session.read", params, time.Second)
		if reply.Code != "" || reply.Err != nil {
			t.Fatalf("CallComputer(%s) = %+v", tc.clientID, reply)
		}
		var result struct {
			Title string `json:"title"`
		}
		if err := json.Unmarshal(reply.Result, &result); err != nil {
			t.Fatal(err)
		}
		if result.Title != tc.want {
			t.Fatalf("CallComputer(%s) reached %q, want %q", tc.clientID, result.Title, tc.want)
		}
	}
}

func TestResponseFromWrongComputerCannotCompletePendingCall(t *testing.T) {
	h := NewHub()
	clientA := "0f1c7a2e-9b64-4c5f-8f1a-2d3e4b5c6a70"
	clientB := "3f2504e0-4f89-41d3-9a0c-0305e82c3301"
	fsA, connA := helloHub(t, h)
	h.HelloIdentity(connA, clientA, "A", "DESKTOP-A", protocol.Capabilities{Tools: []string{"codex"}})
	fsB := &fakeSender{}
	connB := h.Register(fsB.send)
	h.HelloIdentity(connB, clientB, "B", "DESKTOP-B", protocol.Capabilities{Tools: []string{"codex"}})
	defer h.Unregister(connA)
	defer h.Unregister(connB)

	resultCh := make(chan Reply, 1)
	go func() {
		resultCh <- h.CallComputer(context.Background(), clientA, "session.read", json.RawMessage(`{"tool":"codex","sessionId":"s1"}`), 2*time.Second)
	}()
	time.Sleep(40 * time.Millisecond)
	request := fsA.last()
	if request == nil || request.Type != protocol.FrameRequest {
		t.Fatal("target computer A did not receive the request")
	}
	forged, _ := json.Marshal(map[string]any{
		"type": "response", "id": request.ID, "ok": true,
		"result": map[string]any{"id": "s1", "tool": "codex", "title": "forged", "status": "working", "messages": []any{}, "canStop": false},
	})
	if h.DeliverFrom(connB, request.ID, forged) {
		t.Fatal("response from computer B was accepted for computer A's pending request")
	}
	if h.PendingCount() != 1 {
		t.Fatal("forged response removed the pending call")
	}
	valid, _ := json.Marshal(map[string]any{
		"type": "response", "id": request.ID, "ok": true,
		"result": map[string]any{"id": "s1", "tool": "codex", "title": "real", "status": "working", "messages": []any{}, "canStop": false},
	})
	if !h.DeliverFrom(connA, request.ID, valid) {
		t.Fatal("response from the originating computer was dropped")
	}
	select {
	case reply := <-resultCh:
		if reply.Code != "" || !strings.Contains(string(reply.Result), `"title":"real"`) {
			t.Fatalf("call returned the wrong response: %+v", reply)
		}
	case <-time.After(time.Second):
		t.Fatal("originating response did not complete the pending call")
	}
}

func replaceID(template, id string) string {
	out := make([]byte, 0, len(template)+len(id))
	for i := 0; i < len(template); i++ {
		if template[i] == '%' && i+1 < len(template) && template[i+1] == 's' {
			out = append(out, id...)
			i++
			continue
		}
		out = append(out, template[i])
	}
	return string(out)
}
