package server

import (
	"fmt"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/ai-remote/relay/internal/protocol"
	"github.com/ai-remote/relay/internal/store"
)

func fleetRequest(e *env, path, bearer, cookie, body string) *http.Response {
	e.t.Helper()
	req, err := http.NewRequest(http.MethodPost, e.srv.URL+path, strings.NewReader(body))
	if err != nil {
		e.t.Fatal(err)
	}
	req.Header.Set("Origin", testOrigin)
	req.Header.Set("Content-Type", "application/json")
	if bearer != "" {
		req.Header.Set("Authorization", "Bearer "+bearer)
	}
	if cookie != "" {
		req.Header.Set("Cookie", cookie)
	}
	resp, err := e.srv.Client().Do(req)
	if err != nil {
		e.t.Fatal(err)
	}
	return resp
}

func fleetPeer(e *env, id, owner string) (string, *wsClient) {
	e.t.Helper()
	token, err := store.NewToken()
	if err != nil {
		e.t.Fatal(err)
	}
	hash := store.HashToken("invitation-" + id)
	if err := e.st.InsertEnrollmentCode(hash, e.s.now(), e.s.now().Add(time.Minute)); err != nil {
		e.t.Fatal(err)
	}
	if outcome, err := e.st.EnrollComputer(hash, id, owner, "PC-"+owner, store.HashToken(token), e.s.now()); err != nil || outcome != store.EnrollmentOK {
		e.t.Fatalf("enroll = %v %v", outcome, err)
	}
	c, _, err := e.dial("Bearer "+token, "")
	if err != nil {
		e.t.Fatal(err)
	}
	e.t.Cleanup(func() { _ = c.conn.CloseNow() })
	c.send(map[string]any{"type": "hello", "version": 1, "clientId": id, "clientName": "PC-" + owner, "ownerName": owner, "capabilities": map[string]any{"tools": []string{"dsh"}, "sessions.list": true, "session.send": true}})
	if f := c.read(); f.Type != protocol.FrameHelloOK {
		e.t.Fatalf("hello = %s", f.Type)
	}
	return token, c
}

func TestFleetRequiresExplicitEnableAndRegisteredIdentity(t *testing.T) {
	e := newEnv(t)
	decodeFailure(t, fleetRequest(e, "/api/fleet/computers", e.token, "", `{}`), 403, protocol.CodeForbidden)
	e.cfg.SharedTools = true
	// A valid but unpinned bootstrap token is not a registered identity.
	decodeFailure(t, fleetRequest(e, "/api/fleet/computers", e.token, "", `{}`), 401, protocol.CodeUnauthenticated)
	e.helloBridge(protocol.Capabilities{Tools: []string{"codex"}})
	decodeFailure(t, fleetRequest(e, "/api/fleet/computers", "invalid", "", `{}`), 401, protocol.CodeUnauthenticated)
	decodeFailure(t, fleetRequest(e, "/api/fleet/computers", "", "", `{}`), 401, protocol.CodeUnauthenticated)
	resp := fleetRequest(e, "/api/fleet/computers", e.token, "", `{}`)
	if raw := readBody(t, resp); resp.StatusCode != 200 || !strings.Contains(raw, `"computers":[`) {
		t.Fatalf("roster = %d %s", resp.StatusCode, raw)
	}
	decodeFailure(t, e.request("POST", "/api/fleet/computers", "https://evil.example", "application/json", "", `{}`), 403, protocol.CodeOriginForbidden)
}

func TestFleetEveryRegisteredUserCanCallEveryPeerWithoutAdmin(t *testing.T) {
	e := newEnv(t)
	e.cfg.SharedTools = true
	bootstrap := e.helloBridge(protocol.Capabilities{Tools: []string{"codex"}})
	bootstrapSeen := serveBridge(t, bootstrap, func(_ *testing.T, c *wsClient, f *protocol.Frame) {
		c.answer(f.ID, map[string]any{"sessions": []any{}, "capabilities": map[string]any{}})
	})
	id, _ := e.st.BootstrapClientID()
	peerID := "0f1c7a2e-9b64-4c5f-8f1a-2d3e4b5c6a70"
	peerToken, peer := fleetPeer(e, peerID, "Peer")
	peerSeen := serveBridge(t, peer, func(_ *testing.T, c *wsClient, f *protocol.Frame) {
		if f.Method == "session.send" {
			c.answer(f.ID, map[string]any{"accepted": true, "sessionId": "peer-chat"})
			return
		}
		c.answer(f.ID, map[string]any{"sessions": []any{}, "capabilities": map[string]any{}})
	})
	phoneToken, _ := store.NewToken()
	if _, err := e.st.CreateDeviceForClient(store.HashToken(phoneToken), "Phone", id, e.s.now()); err != nil {
		t.Fatal(err)
	}
	cookie := "rc_session=" + phoneToken
	for _, auth := range []struct{ token, cookie string }{{e.token, ""}, {"", cookie}} {
		body := fmt.Sprintf(`{"clientId":%q,"method":"session.send","params":{"tool":"dsh","sessionId":"peer-chat","text":"PRIVATE_QUESTION"}}`, peerID)
		resp := fleetRequest(e, "/api/fleet/rpc", auth.token, auth.cookie, body)
		if raw := readBody(t, resp); resp.StatusCode != 200 || !strings.Contains(raw, `"accepted":true`) {
			t.Fatalf("shared call = %d %s", resp.StatusCode, raw)
		}
	}
	resp := fleetRequest(e, "/api/fleet/rpc", peerToken, "", fmt.Sprintf(`{"clientId":%q,"method":"sessions.list","params":{}}`, id))
	if raw := readBody(t, resp); resp.StatusCode != 200 || !strings.Contains(raw, `"ok":true`) {
		t.Fatalf("reverse call = %d %s", resp.StatusCode, raw)
	}
	if countMethod(waitForMethod(t, peerSeen, "session.send", 2), "session.send") != 2 || countMethod(bootstrapSeen.snapshot(), "session.send") != 0 {
		t.Fatal("crossed or lost target routing")
	}
	roster := readBody(t, fleetRequest(e, "/api/fleet/computers", peerToken, "", `{}`))
	if !strings.Contains(roster, peerID) || !strings.Contains(roster, id) || !strings.Contains(roster, `"ownerName":"Peer"`) {
		t.Fatal("registered peer did not see all computers")
	}
	for _, secret := range []string{peerToken, e.token, store.HashToken(peerToken), "TokenHash"} {
		if strings.Contains(roster, secret) {
			t.Fatal("roster exposed credential")
		}
	}
	decodeFailure(t, fleetRequest(e, "/api/fleet/computers", "bad", cookie, `{}`), 401, protocol.CodeUnauthenticated)
	decodeFailure(t, e.request("POST", "/api/admin/computers", testOrigin, "application/json", cookie, `{}`), 403, protocol.CodeForbidden)
	decodeFailure(t, e.request("POST", "/api/rpc", testOrigin, "application/json", cookie, fmt.Sprintf(`{"clientId":%q,"method":"sessions.list"}`, peerID)), 403, protocol.CodeForbidden)
	dump := e.st.RawDumpForTest(t)
	if !strings.Contains(dump, "fleet.rpc") || !strings.Contains(dump, "desktop:"+id) || !strings.Contains(dump, "target="+peerID+" method=session.send outcome=success") {
		t.Fatal("missing attributed audit")
	}
	if strings.Contains(dump, "PRIVATE_QUESTION") || strings.Contains(dump, peerToken) {
		t.Fatal("audit stored private payload")
	}
	if _, err := e.st.RevokeByTokenHash(store.HashToken(phoneToken)); err != nil {
		t.Fatal(err)
	}
	decodeFailure(t, fleetRequest(e, "/api/fleet/computers", "", cookie, `{}`), 401, protocol.CodeUnauthenticated)
}

func TestFleetOfflineAndInvalidCallsNeverFallback(t *testing.T) {
	e := newEnv(t)
	e.cfg.SharedTools = true
	bootstrap := e.helloBridge(protocol.Capabilities{Tools: []string{"codex"}})
	seen := serveBridge(t, bootstrap, func(_ *testing.T, c *wsClient, f *protocol.Frame) {
		c.answer(f.ID, map[string]any{"sessions": []any{}})
	})
	foreign := "0f1c7a2e-9b64-4c5f-8f1a-2d3e4b5c6a70"
	resp := fleetRequest(e, "/api/fleet/rpc", e.token, "", fmt.Sprintf(`{"clientId":%q,"method":"sessions.list","params":{}}`, foreign))
	decodeFailure(t, resp, 503, protocol.CodeTargetOffline)
	bad := fleetRequest(e, "/api/fleet/rpc", e.token, "", fmt.Sprintf(`{"clientId":%q,"method":"shell.run","params":{"command":"x"}}`, foreign))
	decodeFailure(t, bad, 200, protocol.CodeUnknownMethod)
	if len(seen.snapshot()) != 0 {
		t.Fatal("offline/invalid task was routed to an unrelated computer")
	}
	decodeFailure(t, fleetRequest(e, "/api/fleet/computers", e.token, "", `{"extra":1}`), 400, protocol.CodeInvalidJSON)
}

func TestFleetAllNativeControlsReachTheSelectedPeerUnchanged(t *testing.T) {
	e := newEnv(t)
	e.cfg.SharedTools = true
	e.helloBridge(protocol.Capabilities{Tools: []string{"codex"}})
	id := "0f1c7a2e-9b64-4c5f-8f1a-2d3e4b5c6a70"
	_, peer := fleetPeer(e, id, "Peer")
	seen := serveBridge(t, peer, func(_ *testing.T, c *wsClient, f *protocol.Frame) {
		// A native refusal remains a refusal, while proving the entire closed
		// method surface is available to the authenticated non-admin caller.
		c.answerError(f.ID, "not_capable", "native action not available")
	})
	for _, tc := range []struct{ method, params string }{
		{"sessions.list", `{"tool":"workbuddy"}`},
		{"models.list", `{"tool":"workbuddy"}`},
		{"session.read", `{"tool":"workbuddy","sessionId":"native-chat"}`},
		{"session.send", `{"tool":"workbuddy","sessionId":"native-chat","text":"test"}`},
		{"session.create", `{"tool":"workbuddy","model":"catalog-model","projectId":"catalog-project","text":"test","requestId":"2c9e1a44-7b3d-4f18-9a2e-6d5c8b1f0a37"}`},
		{"session.stop", `{"tool":"workbuddy","sessionId":"native-chat"}`},
		{"session.answer", `{"tool":"workbuddy","sessionId":"native-chat","callId":"native-call","answers":[{"id":"question","selected":[],"custom":"user answer"}]}`},
		{"session.approve", `{"tool":"workbuddy","sessionId":"native-chat","approvalId":"2c9e1a44-7b3d-4f18-9a2e-6d5c8b1f0a37","decision":"allow-once"}`},
		{"session.approve", `{"tool":"workbuddy","sessionId":"native-chat","approvalId":"2c9e1a44-7b3d-4f18-9a2e-6d5c8b1f0a37","decision":"reject"}`},
	} {
		resp := fleetRequest(e, "/api/fleet/rpc", e.token, "", fmt.Sprintf(`{"clientId":%q,"method":%q,"params":%s}`, id, tc.method, tc.params))
		decodeFailure(t, resp, 200, protocol.CodeNotCapable)
		frames := waitForMethod(t, seen, tc.method, countMethod(seen.snapshot(), tc.method))
		if got := frames[len(frames)-1]; got.method != tc.method || got.params != tc.params {
			t.Fatalf("changed native request: %+v", got)
		}
	}
}
