package server

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"

	"github.com/ai-remote/relay/internal/protocol"
)

// ---- R1: health and the loopback-only claim -------------------------------

// TestHealthReportsBridgeOnline covers §7.1 and R1: the endpoint needs no
// Origin and no cookie, and bridgeOnline only turns true once a bridge has
// completed its hello.
func TestHealthReportsBridgeOnline(t *testing.T) {
	e := newEnv(t)

	resp := e.request("GET", "/health", "", "", "", "")
	body := readBody(t, resp)
	if resp.StatusCode != 200 {
		t.Fatalf("status = %d, want 200", resp.StatusCode)
	}
	if got := jsonField(t, body, "ok"); got != "true" {
		t.Fatalf("ok = %s, want true", got)
	}
	if got := jsonField(t, body, "bridgeOnline"); got != "false" {
		t.Fatalf("bridgeOnline = %s, want false before any bridge connects", got)
	}
	if strings.Contains(body, "101.43") || strings.Contains(body, "version") {
		t.Fatalf("/health leaked more than ok and bridgeOnline: %s", body)
	}

	e.helloBridge(protocol.Capabilities{Tools: []string{"codex"}})
	resp = e.request("GET", "/health", "", "", "", "")
	body = readBody(t, resp)
	if got := jsonField(t, body, "bridgeOnline"); got != "true" {
		t.Fatalf("bridgeOnline = %s after a bridge hello, want true", got)
	}
}

// ---- R3/R6: the real pairing flow -----------------------------------------

// TestPairCreateAndPairFlow covers R6 and §8.4.4/§8.4.5: the desktop supplies
// the id and the relay echoes it byte for byte, the code is canonical, expires
// exactly 300 seconds later, and the url embeds it.
func TestPairCreateAndPairFlow(t *testing.T) {
	e := newEnv(t)
	c := e.helloBridge(protocol.Capabilities{Tools: []string{"codex"}})

	const requestID = "3f2504e0-4f89-41d3-9a0c-0305e82c3301"
	before := time.Now()
	c.send(map[string]any{"type": "pair.create", "id": requestID})
	created := c.read()

	if created.Type != protocol.FramePairCreated {
		t.Fatalf("type = %q, want pair.created", created.Type)
	}
	if created.ID != requestID {
		t.Fatalf("id = %q, want the desktop's own id %q echoed back", created.ID, requestID)
	}
	symbols, ok := protocol.NormalizePairCode(created.Code)
	if !ok || len(symbols) != 24 {
		t.Fatalf("code = %q, want 24 canonical Crockford symbols", created.Code)
	}
	if created.Code != protocol.CanonicalPairCode(symbols) {
		t.Fatalf("code = %q, want the grouped canonical form", created.Code)
	}
	expires := at(t, created.ExpiresAt)
	if d := expires.Sub(before); d < 295*time.Second || d > 305*time.Second {
		t.Fatalf("expiresAt is %v away, want 300s", d)
	}
	wantURL := e.cfg.PublicOrigin + "/#pair=" + created.Code
	if created.URL != wantURL {
		t.Fatalf("url = %q, want %q", created.URL, wantURL)
	}

	resp := e.request("POST", "/api/pair", testOrigin, "application/json", "",
		fmt.Sprintf(`{"code":%q,"deviceName":"Pixel 8"}`, created.Code))
	body := readBody(t, resp)
	if resp.StatusCode != 200 {
		t.Fatalf("status = %d, want 200 (body %s)", resp.StatusCode, body)
	}
	if got := jsonField(t, body, "ok"); got != "true" {
		t.Fatalf("ok = %s, want true", got)
	}

	raw := resp.Header.Get("Set-Cookie")
	for _, want := range []string{"rc_session=", "Path=/", "Max-Age=2592000", "HttpOnly", "Secure", "SameSite=Strict"} {
		if !strings.Contains(raw, want) {
			t.Fatalf("Set-Cookie = %q, missing %q", raw, want)
		}
	}
	if strings.Contains(raw, "Domain=") {
		t.Fatalf("Set-Cookie = %q, must not set Domain", raw)
	}
	if strings.Contains(resp.Header.Get("Cache-Control"), "") && resp.Header.Get("Cache-Control") != "no-store" {
		t.Fatalf("Cache-Control = %q, want no-store", resp.Header.Get("Cache-Control"))
	}
	if resp.Header.Get("X-Content-Type-Options") != "nosniff" {
		t.Fatalf("X-Content-Type-Options = %q, want nosniff", resp.Header.Get("X-Content-Type-Options"))
	}

	// §8.4.6: the desktop learns that its code was used.
	used := c.read()
	if used.Type != protocol.FramePairUsed {
		t.Fatalf("frame = %q, want pair.used", used.Type)
	}
	if used.CodeID != requestID {
		t.Fatalf("codeId = %q, want the pair.create id %q", used.CodeID, requestID)
	}
	if used.DeviceName != "Pixel 8" {
		t.Fatalf("deviceName = %q, want Pixel 8", used.DeviceName)
	}
	if strings.Contains(string(mustJSON(t, used)), "rc_session") {
		t.Fatal("pair.used carried session material")
	}
}

// TestPairCodeIsSingleUse covers R3 and §7.2 rule 1: the second use of a code
// is refused, and the first session still works.
func TestPairCodeIsSingleUse(t *testing.T) {
	e := newEnv(t)
	c := e.helloBridge(protocol.Capabilities{Tools: []string{"codex"}})
	c.send(map[string]any{"type": "pair.create", "id": "3f2504e0-4f89-41d3-9a0c-0305e82c3301"})
	created := c.read()

	payload := fmt.Sprintf(`{"code":%q,"deviceName":"Pixel 8"}`, created.Code)
	first := e.request("POST", "/api/pair", testOrigin, "application/json", "", payload)
	if first.StatusCode != 200 {
		t.Fatalf("first use status = %d, want 200", first.StatusCode)
	}
	cookie := sessionCookie(t, first)

	second := e.request("POST", "/api/pair", testOrigin, "application/json", "", payload)
	decodeFailure(t, second, 401, protocol.CodeInvalidCredentials)

	// The winning session still authenticates: with a bridge online the call is
	// forwarded, so it is not a 401. That is the only claim being made here.
	resp := e.request("POST", "/api/rpc", testOrigin, "application/json", "rc_session="+cookie, `{"method":"sessions.list"}`)
	if resp.StatusCode == 401 {
		t.Fatalf("the session issued for a good pair was rejected (body %s)", readBody(t, resp))
	}
	readBody(t, resp)
}

// TestPairCodeThatNeverExisted covers §7.2: an unknown code is a 404, and a code
// that fails the alphabet is 401 — the two are deliberately different.
func TestPairCodeThatNeverExisted(t *testing.T) {
	e := newEnv(t)
	resp := e.request("POST", "/api/pair", testOrigin, "application/json", "",
		`{"code":"ZZZZ-ZZZZ-ZZZZ-ZZZZ-ZZZZ-ZZZZ","deviceName":"Pixel 8"}`)
	decodeFailure(t, resp, 404, protocol.CodeNotFound)

	resp = e.request("POST", "/api/pair", testOrigin, "application/json", "",
		`{"code":"nope!","deviceName":"Pixel 8"}`)
	decodeFailure(t, resp, 401, protocol.CodeInvalidCredentials)
}

// ---- R4 / contract §13 server test 1: input hardening ----------------------

// TestInputHardening covers the contract's own server contract test 1: a
// missing Origin, a lookalike Origin, a wrong scheme and a wrong Content-Type
// are each refused with the exact code, and no response ever carries an
// Access-Control-Allow-Origin header. That absence is what proves CORS is off.
func TestInputHardening(t *testing.T) {
	e := newEnv(t)
	cookie := "rc_session=" + strings.Repeat("a", 43)

	cases := []struct {
		name        string
		origin      string
		contentType string
		wantStatus  int
		wantCode    protocol.Code
	}{
		{"no origin", "", "application/json", 403, protocol.CodeOriginForbidden},
		{"lookalike origin", "https://101.43.98.18.evil.example", "application/json", 403, protocol.CodeOriginForbidden},
		{"wrong scheme", "http://101.43.98.18", "application/json", 403, protocol.CodeOriginForbidden},
		{"explicit port", "https://101.43.98.18:443", "application/json", 403, protocol.CodeOriginForbidden},
		{"trailing slash", "https://101.43.98.18/", "application/json", 403, protocol.CodeOriginForbidden},
		{"null origin", "null", "application/json", 403, protocol.CodeOriginForbidden},
		{"wrong content type", testOrigin, "text/plain", 415, protocol.CodeUnsupportedMediaType},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			resp := e.request("POST", "/api/rpc", tc.origin, tc.contentType, cookie, `{"method":"sessions.list"}`)
			for _, h := range []string{"Access-Control-Allow-Origin", "Access-Control-Allow-Credentials"} {
				if v := resp.Header.Get(h); v != "" {
					t.Fatalf("%s = %q, must never be set", h, v)
				}
			}
			decodeFailure(t, resp, tc.wantStatus, tc.wantCode)
		})
	}

	// A well-formed request with a valid Origin must get past the Origin gate:
	// it is refused later, at authentication, which is a different gate.
	resp := e.request("POST", "/api/rpc", testOrigin, "application/json", cookie, `{"method":"sessions.list"}`)
	decodeFailure(t, resp, 401, protocol.CodeUnauthenticated)
}

// TestBodyLimitIsEnforced covers §5.4: an oversized body is refused before it
// is read, per endpoint budget.
func TestBodyLimitIsEnforced(t *testing.T) {
	e := newEnv(t)
	big := `{"method":"sessions.list","pad":"` + strings.Repeat("a", 20000) + `"}`
	resp := e.request("POST", "/api/rpc", testOrigin, "application/json", "rc_session="+strings.Repeat("a", 43), big)
	decodeFailure(t, resp, 413, protocol.CodePayloadTooLarge)

	// A body just over the pair budget is also refused.
	resp = e.request("POST", "/api/pair", testOrigin, "application/json", "",
		`{"code":"x","deviceName":"`+strings.Repeat("b", 5000)+`"}`)
	decodeFailure(t, resp, 413, protocol.CodePayloadTooLarge)
}

// TestInvalidJSONAndUnknownPath covers §6.2 and §5.5: malformed JSON and an
// unknown path never fall back to a static file or a debug page.
func TestInvalidJSONAndUnknownPath(t *testing.T) {
	e := newEnv(t)
	resp := e.request("POST", "/api/pair", testOrigin, "application/json", "", `{not json`)
	decodeFailure(t, resp, 400, protocol.CodeInvalidJSON)

	resp = e.request("GET", "/api/does-not-exist", testOrigin, "", "", "")
	decodeFailure(t, resp, 404, protocol.CodeNotFound)

	resp = e.request("GET", "/nope", testOrigin, "", "", "")
	decodeFailure(t, resp, 404, protocol.CodeNotFound)
}

// ---- Auth: R11 and the cookie lifecycle ------------------------------------

// TestRPCRequiresASession covers §7.3: no cookie, a malformed cookie and an
// unknown cookie are all the same unauthenticated answer.
func TestRPCRequiresASession(t *testing.T) {
	e := newEnv(t)
	for _, cookie := range []string{"", "rc_session=", "rc_session=short", "rc_session=" + strings.Repeat("z", 43), "other=1"} {
		resp := e.request("POST", "/api/rpc", testOrigin, "application/json", cookie, `{"method":"sessions.list"}`)
		decodeFailure(t, resp, 401, protocol.CodeUnauthenticated)
	}
}

// TestLogoutInvalidatesOwnSession covers R11 and §7.4: logout is immediate, and
// the clearing cookie carries the same attributes as the issuing one.
func TestLogoutInvalidatesOwnSession(t *testing.T) {
	e := newEnv(t)
	c := e.helloBridge(protocol.Capabilities{Tools: []string{"codex"}})
	cookie := e.pairOnce(c)

	resp := e.request("POST", "/api/logout", testOrigin, "application/json", "rc_session="+cookie, `{}`)
	body := readBody(t, resp)
	if resp.StatusCode != 200 {
		t.Fatalf("logout status = %d, want 200 (body %s)", resp.StatusCode, body)
	}
	if got := jsonField(t, body, "ok"); got != "true" {
		t.Fatalf("logout ok = %s, want true", got)
	}
	raw := resp.Header.Get("Set-Cookie")
	for _, want := range []string{"rc_session=", "Max-Age=0", "HttpOnly", "Secure", "SameSite=Strict"} {
		if !strings.Contains(raw, want) {
			t.Fatalf("clearing Set-Cookie = %q, missing %q", raw, want)
		}
	}

	after := e.request("POST", "/api/rpc", testOrigin, "application/json", "rc_session="+cookie, `{"method":"sessions.list"}`)
	decodeFailure(t, after, 401, protocol.CodeUnauthenticated)
}

// TestRevokeRequiresBridgeToken covers §7.4 as CRD 0003 settled it: a valid
// cookie without a legitimate Bearer is 403 forbidden, not 401 — the caller is
// authenticated but not permitted.
func TestRevokeRequiresBridgeToken(t *testing.T) {
	e := newEnv(t)
	c := e.helloBridge(protocol.Capabilities{Tools: []string{"codex"}})
	victim := e.pairOnce(c)

	target := fmt.Sprintf(`{"targetSessionId":%q}`, victim)
	resp := e.request("POST", "/api/logout", testOrigin, "application/json", "rc_session="+victim, target)
	decodeFailure(t, resp, 403, protocol.CodeForbidden)

	// A wrong bearer is equally forbidden and equally harmless.
	req, _ := http.NewRequest("POST", e.srv.URL+"/api/logout", strings.NewReader(target))
	req.Header.Set("Origin", testOrigin)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Cookie", "rc_session="+victim)
	req.Header.Set("Authorization", "Bearer not-the-token")
	got, err := e.srv.Client().Do(req)
	if err != nil {
		t.Fatalf("do: %v", err)
	}
	decodeFailure(t, got, 403, protocol.CodeForbidden)

	// The victim still works: a refused revoke must not have side effects.
	still := e.request("POST", "/api/rpc", testOrigin, "application/json", "rc_session="+victim, `{"method":"sessions.list"}`)
	if still.StatusCode == 401 {
		t.Fatalf("a refused revoke invalidated the session (body %s)", readBody(t, still))
	}
}

// TestBridgeAuthorisedRevoke covers §7.4's second use: with a legitimate
// Bearer the named session dies at once.
func TestBridgeAuthorisedRevoke(t *testing.T) {
	e := newEnv(t)
	c := e.helloBridge(protocol.Capabilities{Tools: []string{"codex"}})
	victim := e.pairOnce(c)
	revoker := e.pairOnce(c)

	req, _ := http.NewRequest("POST", e.srv.URL+"/api/logout", strings.NewReader(fmt.Sprintf(`{"targetSessionId":%q}`, victim)))
	req.Header.Set("Origin", testOrigin)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Cookie", "rc_session="+revoker)
	req.Header.Set("Authorization", "Bearer "+e.token)
	resp, err := e.srv.Client().Do(req)
	if err != nil {
		t.Fatalf("do: %v", err)
	}
	if resp.StatusCode != 200 {
		t.Fatalf("revoke status = %d, want 200 (body %s)", resp.StatusCode, readBody(t, resp))
	}
	readBody(t, resp)

	dead := e.request("POST", "/api/rpc", testOrigin, "application/json", "rc_session="+victim, `{"method":"sessions.list"}`)
	decodeFailure(t, dead, 401, protocol.CodeUnauthenticated)

	alive := e.request("POST", "/api/rpc", testOrigin, "application/json", "rc_session="+revoker, `{"method":"sessions.list"}`)
	if alive.StatusCode == 401 {
		t.Fatalf("revoking another device killed the caller's own session (body %s)", readBody(t, alive))
	}
}

// ---- R7/R8/R9/R10: forwarding ---------------------------------------------

// TestRPCUnknownMethodAndInvalidParams covers §7.3: a method outside the
// whitelist and a params field outside the whitelist are business errors on
// HTTP 200, so the phone has one branch point.
func TestRPCUnknownMethodAndInvalidParams(t *testing.T) {
	e := newEnv(t)
	c := e.helloBridge(protocol.Capabilities{Tools: []string{"codex"}})
	cookie := e.pairOnce(c)

	cases := []struct {
		body string
		code protocol.Code
	}{
		// A method that still does not exist. This used to name "session.create",
		// which CRD 0006 promoted into the whitelist; the assertion moved to
		// names that are genuinely absent.
		{`{"method":"session.delete"}`, protocol.CodeUnknownMethod},
		{`{"method":"session.create.many","params":{"tool":"codex"}}`, protocol.CodeUnknownMethod},
		{`{"method":"shell.exec","params":{"cmd":"id"}}`, protocol.CodeUnknownMethod},
		{`{"method":"session.send","params":{"tool":"codex","sessionId":"s1","text":"x","timeoutMs":1}}`, protocol.CodeInvalidParams},
		{`{"method":"session.read","params":{"tool":"claude","sessionId":"s1"}}`, protocol.CodeInvalidParams},
		{`{"method":"sessions.list","params":{"sessionId":"s1"}}`, protocol.CodeInvalidParams},
	}
	for _, tc := range cases {
		resp := e.request("POST", "/api/rpc", testOrigin, "application/json", "rc_session="+cookie, tc.body)
		decodeFailure(t, resp, 200, tc.code)
	}

	// A missing method is a bad request, not an unknown method (§7.3).
	resp := e.request("POST", "/api/rpc", testOrigin, "application/json", "rc_session="+cookie, `{}`)
	decodeFailure(t, resp, 400, protocol.CodeInvalidRequest)
}

// TestRPCOfflineIs503 covers R10 step 12: with no desktop connected the phone
// gets 503 bridge_offline and a Retry-After, never a hang.
func TestRPCOfflineIs503(t *testing.T) {
	e := newEnv(t)
	c := e.helloBridge(protocol.Capabilities{Tools: []string{"codex"}})
	cookie := e.pairOnce(c)
	_ = c.conn.CloseNow()

	deadline := time.Now().Add(2 * time.Second)
	for {
		resp := e.request("POST", "/api/rpc", testOrigin, "application/json", "rc_session="+cookie, `{"method":"sessions.list"}`)
		if resp.StatusCode == 503 {
			if resp.Header.Get("Retry-After") != "1" {
				t.Fatalf("Retry-After = %q, want 1", resp.Header.Get("Retry-After"))
			}
			decodeFailure(t, resp, 503, protocol.CodeBridgeOffline)
			return
		}
		readBody(t, resp)
		if time.Now().After(deadline) {
			t.Fatal("the relay kept claiming the desktop was online after the socket closed")
		}
		time.Sleep(20 * time.Millisecond)
	}
}

// TestRPCForwardingRoundTrip covers R8, R9 and §11 steps 6-10: every one of the
// four methods is forwarded with its own id and the real result comes back
// unchanged. The desktop side is a stub for session execution — the forwarding,
// the id table and the shape checks are the relay's real code.
func TestRPCForwardingRoundTrip(t *testing.T) {
	e := newEnv(t)
	c := e.helloBridge(protocol.Capabilities{
		SessionsList: true, SessionRead: true, SessionSend: true, SessionStop: true,
		StopDSH: true, Tools: []string{"codex", "dsh"},
	})
	cookie := e.pairOnce(c)

	go func() {
		for {
			f, ok := c.readRequestQuiet()
			if !ok {
				return
			}
			switch f.Method {
			case "sessions.list":
				c.answer(f.ID, map[string]any{
					"sessions": []any{map[string]any{
						"id": "s1", "tool": "codex", "title": "t", "status": "working",
						"updatedAt": "2026-10-08T03:57:55Z", "cwd": `D:\workspace`,
					}, map[string]any{
						"id": "s2", "tool": "dsh", "title": "u", "status": "idle",
						"updatedAt": "2026-10-08T03:57:00Z", "cwd": nil,
					}},
					"capabilities": map[string]any{"sessions.list": true, "tools": []string{"codex", "dsh"}},
				})
			case "session.read":
				c.answer(f.ID, map[string]any{
					"id": "s1", "tool": "codex", "title": "t", "status": "working",
					"messages": []any{map[string]any{"id": "m-0001", "role": "user", "text": "hi", "timestamp": "2026-10-08T03:55:02Z"}},
					"canStop":  true, "activeTurnId": "turn-7",
				})
			case "session.send":
				c.answer(f.ID, map[string]any{"accepted": true, "sessionId": "s1"})
			case "session.stop":
				c.answer(f.ID, map[string]any{"accepted": true, "sessionId": "s2"})
			}
		}
	}()

	calls := []struct {
		body   string
		check  []string
		expect map[string]string
	}{
		{`{"method":"sessions.list"}`, nil, map[string]string{"ok": "true"}},
		{`{"method":"session.read","params":{"tool":"codex","sessionId":"s1"}}`, nil, map[string]string{"ok": "true"}},
		{`{"method":"session.send","params":{"tool":"codex","sessionId":"s1","text":"继续"}}`, nil, map[string]string{"ok": "true"}},
		{`{"method":"session.stop","params":{"tool":"dsh","sessionId":"s2"}}`, nil, map[string]string{"ok": "true"}},
	}
	for _, tc := range calls {
		resp := e.request("POST", "/api/rpc", testOrigin, "application/json", "rc_session="+cookie, tc.body)
		body := readBody(t, resp)
		if resp.StatusCode != 200 {
			t.Fatalf("%s status = %d, want 200 (body %s)", tc.body, resp.StatusCode, body)
		}
		if got := jsonField(t, body, "ok"); got != "true" {
			t.Fatalf("%s ok = %s, want true (body %s)", tc.body, got, body)
		}
		if !strings.Contains(body, `"result"`) {
			t.Fatalf("%s has no result: %s", tc.body, body)
		}
	}

	// §9.3: accepted is true and the sessionId matches the request.
	body := readBody(t, e.request("POST", "/api/rpc", testOrigin, "application/json", "rc_session="+cookie,
		`{"method":"session.send","params":{"tool":"codex","sessionId":"s1","text":"继续"}}`))
	if got := jsonField(t, body, "result", "sessionId"); got != "s1" {
		t.Fatalf("session.send result.sessionId = %s, want s1", got)
	}
	if got := jsonField(t, body, "result", "accepted"); got != "true" {
		t.Fatalf("session.send result.accepted = %s, want true", got)
	}
}

// TestRPCNewMethodsRoundTrip covers CRD 0006 end to end through real HTTP and a
// real WebSocket: models.list and session.create are forwarded, their results
// are validated, and the phone gets them back unchanged.
func TestRPCNewMethodsRoundTrip(t *testing.T) {
	e := newEnv(t)
	c := e.helloBridge(protocol.Capabilities{
		ModelsList: true, SessionCreate: true, Tools: []string{"codex", "dsh"},
	})
	cookie := e.pairOnce(c)

	go func() {
		for {
			f, ok := c.readRequestQuiet()
			if !ok {
				return
			}
			switch f.Method {
			case "models.list":
				c.answer(f.ID, map[string]any{
					"tool": "codex",
					"models": []any{
						map[string]any{"id": "gpt-5-codex", "label": "GPT-5 Codex", "isDefault": true},
						map[string]any{"id": "gpt-5", "label": "GPT-5"},
					},
					"projects": []any{map[string]any{
						"id": "p1", "name": "remote-control",
						"cwd": `D:\workspace\codex-workspace\remote-control`,
					}},
				})
			case "session.create":
				c.answer(f.ID, map[string]any{
					"sessionId": "0f1c7a2e-9b64-4c5f-8f1a-2d3e4b5c6a70",
					"tool":      "codex", "title": "new", "model": "gpt-5-codex",
				})
			}
		}
	}()

	resp := e.request("POST", "/api/rpc", testOrigin, "application/json", "rc_session="+cookie,
		`{"method":"models.list","params":{"tool":"codex"}}`)
	body := readBody(t, resp)
	if resp.StatusCode != 200 {
		t.Fatalf("models.list status = %d, want 200 (body %s)", resp.StatusCode, body)
	}
	if got := jsonField(t, body, "ok"); got != "true" {
		t.Fatalf("models.list ok = %s (body %s)", got, body)
	}
	if got := jsonField(t, body, "result", "tool"); got != "codex" {
		t.Fatalf("result.tool = %s, want codex", got)
	}
	if !strings.Contains(body, "gpt-5-codex") {
		t.Fatalf("the model catalogue did not survive the round trip: %s", body)
	}

	resp = e.request("POST", "/api/rpc", testOrigin, "application/json", "rc_session="+cookie,
		`{"method":"session.create","params":{"tool":"codex","model":"gpt-5-codex","requestId":"3f2504e0-4f89-41d3-9a0c-0305e82c3301"}}`)
	body = readBody(t, resp)
	if resp.StatusCode != 200 {
		t.Fatalf("session.create status = %d, want 200 (body %s)", resp.StatusCode, body)
	}
	if got := jsonField(t, body, "result", "sessionId"); got != "0f1c7a2e-9b64-4c5f-8f1a-2d3e4b5c6a70" {
		t.Fatalf("result.sessionId = %s", got)
	}
	if !strings.Contains(body, "gpt-5-codex") {
		t.Fatalf("the chosen model did not survive: %s", body)
	}
}

// TestRPCNewMethodParamsAreRejected covers the whitelist and the create rules at
// the HTTP layer, on HTTP 200 like the other business failures.
func TestRPCNewMethodParamsAreRejected(t *testing.T) {
	e := newEnv(t)
	c := e.helloBridge(protocol.Capabilities{ModelsList: true, SessionCreate: true, Tools: []string{"codex", "dsh"}})
	cookie := e.pairOnce(c)

	cases := []struct {
		body string
		code protocol.Code
	}{
		{`{"method":"models.list","params":{}}`, protocol.CodeInvalidParams},
		{`{"method":"models.list","params":{"tool":"claude"}}`, protocol.CodeInvalidParams},
		{`{"method":"models.list","params":{"tool":"codex","x":1}}`, protocol.CodeInvalidParams},
		{`{"method":"session.create","params":{"tool":"codex","model":"m"}}`, protocol.CodeInvalidParams},
		{`{"method":"session.create","params":{"tool":"dsh","model":"m","requestId":"3f2504e0-4f89-41d3-9a0c-0305e82c3301"}}`, protocol.CodeInvalidParams},
		{`{"method":"session.create","params":{"tool":"codex","model":"m","provider":"openai","requestId":"3f2504e0-4f89-41d3-9a0c-0305e82c3301"}}`, protocol.CodeInvalidParams},
		{`{"method":"session.create","params":{"tool":"codex","model":"m","requestId":"nope"}}`, protocol.CodeInvalidParams},
	}
	for _, tc := range cases {
		resp := e.request("POST", "/api/rpc", testOrigin, "application/json", "rc_session="+cookie, tc.body)
		body := readBody(t, resp)
		t.Logf("request %s\n  -> HTTP %d %s", tc.body, resp.StatusCode, strings.TrimSpace(body))
		if resp.StatusCode != 200 {
			t.Fatalf("status = %d, want 200 (body %s)", resp.StatusCode, body)
		}
		var got struct {
			OK    bool `json:"ok"`
			Error struct {
				Code string `json:"code"`
			} `json:"error"`
		}
		if err := json.Unmarshal([]byte(body), &got); err != nil {
			t.Fatalf("body is not json: %s", body)
		}
		if got.OK || got.Error.Code != string(tc.code) {
			t.Fatalf("error.code = %q ok=%v, want %q", got.Error.Code, got.OK, tc.code)
		}
	}
}

// TestRPCNewMethodBridgeErrorsPassThrough covers CRD 0006's three new codes:
// they reach the phone on HTTP 200 with the desktop's own safe text, and
// tool_unavailable is not flattened into not_capable.
func TestRPCNewMethodBridgeErrorsPassThrough(t *testing.T) {
	cases := []struct {
		code    string
		message string
	}{
		{"tool_unavailable", "that session source is not available"},
		{"model_not_available", "that model is not available"},
		{"session_create_failed", "the session could not be created"},
	}
	for _, tc := range cases {
		t.Run(tc.code, func(t *testing.T) {
			e := newEnv(t)
			c := e.helloBridge(protocol.Capabilities{SessionCreate: true, Tools: []string{"dsh"}})
			cookie := e.pairOnce(c)

			go func() {
				f, ok := c.readRequestQuiet()
				if !ok {
					return
				}
				c.answerError(f.ID, tc.code, tc.message)
			}()

			resp := e.request("POST", "/api/rpc", testOrigin, "application/json", "rc_session="+cookie,
				`{"method":"session.create","params":{"tool":"dsh","model":"m","provider":"deepseek","requestId":"3f2504e0-4f89-41d3-9a0c-0305e82c3301"}}`)
			decodeFailure(t, resp, 200, protocol.Code(tc.code))
		})
	}

	// The distinction is real: not_capable still travels as itself.
	e := newEnv(t)
	c := e.helloBridge(protocol.Capabilities{Tools: []string{"codex"}})
	cookie := e.pairOnce(c)
	go func() {
		f, ok := c.readRequestQuiet()
		if !ok {
			return
		}
		c.answerError(f.ID, "not_capable", "session cannot be stopped")
	}()
	resp := e.request("POST", "/api/rpc", testOrigin, "application/json", "rc_session="+cookie,
		`{"method":"session.stop","params":{"tool":"codex","sessionId":"s1"}}`)
	decodeFailure(t, resp, 200, protocol.CodeNotCapable)
}

// TestSessionCreateNeverResends covers CRD 0006's iron rules 4 and 5: a create
// is never retried. A silent retry would make a second session appear on the
// desktop, and the user would have no way to know which one the phone means.
func TestSessionCreateNeverResends(t *testing.T) {
	e := newEnv(t)
	c := e.helloBridge(protocol.Capabilities{SessionCreate: true, Tools: []string{"codex"}})
	cookie := e.pairOnce(c)

	seen := make(chan *protocol.Frame, 8)
	go func() {
		for {
			f, ok := c.readRequestQuiet()
			if !ok {
				return
			}
			seen <- f
		}
	}()

	resp := e.request("POST", "/api/rpc", testOrigin, "application/json", "rc_session="+cookie,
		`{"method":"session.create","params":{"tool":"codex","model":"gpt-5-codex","requestId":"3f2504e0-4f89-41d3-9a0c-0305e82c3301"},"timeoutMs":1000}`)
	decodeFailure(t, resp, 504, protocol.CodeBridgeTimeout)

	select {
	case first := <-seen:
		if first.Method != "session.create" {
			t.Fatalf("first request was %q, want session.create", first.Method)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("no session.create reached the desktop")
	}
	select {
	case second := <-seen:
		t.Fatalf("a second request (%s) was sent; a create must never be retried", second.Method)
	case <-time.After(700 * time.Millisecond):
	}
	if e.hub.PendingCount() != 0 {
		t.Fatalf("PendingCount() = %d after the timeout, want 0", e.hub.PendingCount())
	}
}

// TestSessionReadHistoryTruncatedPassesThrough covers CRD 0007 at the HTTP
// layer: the optional flag reaches the phone untouched when present, and its
// absence is still a successful read.
func TestSessionReadHistoryTruncatedPassesThrough(t *testing.T) {
	e := newEnv(t)
	c := e.helloBridge(protocol.Capabilities{SessionRead: true, Tools: []string{"codex"}})
	cookie := e.pairOnce(c)

	go func() {
		for {
			f, ok := c.readRequestQuiet()
			if !ok {
				return
			}
			if f.Method != "session.read" {
				continue
			}
			c.answer(f.ID, map[string]any{
				"id": "s1", "tool": "codex", "title": "t", "status": "idle",
				"messages": []any{}, "canStop": false, "historyTruncated": true,
			})
		}
	}()

	resp := e.request("POST", "/api/rpc", testOrigin, "application/json", "rc_session="+cookie,
		`{"method":"session.read","params":{"tool":"codex","sessionId":"s1"}}`)
	body := readBody(t, resp)
	if resp.StatusCode != 200 {
		t.Fatalf("status = %d, want 200 (body %s)", resp.StatusCode, body)
	}
	if got := jsonField(t, body, "result", "historyTruncated"); got != "true" {
		t.Fatalf("historyTruncated = %s, want true passed through", got)
	}
}

// TestRPCForwardsBridgeBusinessError covers §8.4.8: a safe business failure from
// the desktop reaches the phone with its own code and message.
func TestRPCForwardsBridgeBusinessError(t *testing.T) {
	e := newEnv(t)
	c := e.helloBridge(protocol.Capabilities{Tools: []string{"codex"}})
	cookie := e.pairOnce(c)

	go func() {
		f := c.readRequest()
		c.answerError(f.ID, "session_not_found", "session not found")
	}()

	resp := e.request("POST", "/api/rpc", testOrigin, "application/json", "rc_session="+cookie,
		`{"method":"session.read","params":{"tool":"codex","sessionId":"missing"}}`)
	decodeFailure(t, resp, 200, protocol.CodeSessionNotFound)
}

// TestRPCTimeoutDoesNotResend covers R10 and §10.2: the phone gets 504, the
// pending slot is freed, and the desktop never sees a second request.
func TestRPCTimeoutDoesNotResend(t *testing.T) {
	e := newEnv(t)
	c := e.helloBridge(protocol.Capabilities{Tools: []string{"codex"}})
	cookie := e.pairOnce(c)

	seen := make(chan *protocol.Frame, 8)
	go func() {
		for {
			f, ok := c.readRequestQuiet()
			if !ok {
				return
			}
			seen <- f
		}
	}()

	start := time.Now()
	resp := e.request("POST", "/api/rpc", testOrigin, "application/json", "rc_session="+cookie,
		`{"method":"session.send","params":{"tool":"codex","sessionId":"s1","text":"hi"},"timeoutMs":1000}`)
	decodeFailure(t, resp, 504, protocol.CodeBridgeTimeout)
	if elapsed := time.Since(start); elapsed > 5*time.Second {
		t.Fatalf("the timeout took %v, want about a second", elapsed)
	}

	select {
	case <-seen:
	case <-time.After(2 * time.Second):
		t.Fatal("no request reached the desktop")
	}
	select {
	case second := <-seen:
		t.Fatalf("the desktop received a second request (%s); a resend would duplicate the message", second.Method)
	case <-time.After(700 * time.Millisecond):
	}
	if e.hub.PendingCount() != 0 {
		t.Fatalf("PendingCount() = %d after a timeout, want 0", e.hub.PendingCount())
	}
}

// TestRPCDisconnectDuringWaitIs502 covers §10.2: a desktop that drops mid-call
// fails the call at once with a safe message.
func TestRPCDisconnectDuringWaitIs502(t *testing.T) {
	e := newEnv(t)
	c := e.helloBridge(protocol.Capabilities{Tools: []string{"codex"}})
	cookie := e.pairOnce(c)

	got := make(chan *http.Response, 1)
	go func() {
		got <- e.request("POST", "/api/rpc", testOrigin, "application/json", "rc_session="+cookie,
			`{"method":"session.send","params":{"tool":"codex","sessionId":"s1","text":"hi"},"timeoutMs":10000}`)
	}()
	if _, ok := c.readRequestQuiet(); !ok {
		t.Fatal("no request reached the desktop before the disconnect")
	}
	_ = c.conn.CloseNow()

	select {
	case resp := <-got:
		decodeFailure(t, resp, 502, protocol.CodeBridgeBadResponse)
	case <-time.After(5 * time.Second):
		t.Fatal("a call waiting on a dropped desktop never completed")
	}
}

// TestRPCRejectsBadBridgeResult covers §8.4.8: a result that does not match the
// method's shape becomes 502 rather than reaching the phone.
func TestRPCRejectsBadBridgeResult(t *testing.T) {
	e := newEnv(t)
	c := e.helloBridge(protocol.Capabilities{Tools: []string{"codex"}})
	cookie := e.pairOnce(c)

	go func() {
		f := c.readRequest()
		c.answer(f.ID, map[string]any{"accepted": true}) // session.send needs sessionId
	}()

	resp := e.request("POST", "/api/rpc", testOrigin, "application/json", "rc_session="+cookie,
		`{"method":"session.send","params":{"tool":"codex","sessionId":"s1","text":"hi"}}`)
	decodeFailure(t, resp, 502, protocol.CodeBridgeBadResponse)
}

// TestBridgeOnlineGateForPending covers R10's bounded pending: once the global
// cap is reached the phone is told to retry rather than queued.
func TestBridgeOnlineGateForPending(t *testing.T) {
	e := newEnv(t)
	e.hub.SetLimits(1, 1)
	c := e.helloBridge(protocol.Capabilities{Tools: []string{"codex"}})
	cookie := e.pairOnce(c)

	// Occupy the single slot with a call that will never be answered.
	go func() {
		resp := e.request("POST", "/api/rpc", testOrigin, "application/json", "rc_session="+cookie,
			`{"method":"session.read","params":{"tool":"codex","sessionId":"s1"},"timeoutMs":10000}`)
		readBody(t, resp)
	}()
	if _, ok := c.readRequestQuiet(); !ok {
		t.Fatal("no request reached the desktop")
	}

	resp := e.request("POST", "/api/rpc", testOrigin, "application/json", "rc_session="+cookie,
		`{"method":"sessions.list"}`)
	if resp.Header.Get("Retry-After") != "1" {
		t.Fatalf("Retry-After = %q, want 1", resp.Header.Get("Retry-After"))
	}
	decodeFailure(t, resp, 503, protocol.CodeBridgeBusy)
}

// ---- R5: /bridge authentication -------------------------------------------

// TestBridgeRequiresBearerToken covers §8.1 and R5: no token, a wrong token and
// a bearer-less header are all refused with 401 and the contract's body shape.
func TestBridgeRequiresBearerToken(t *testing.T) {
	e := newEnv(t)
	cases := []struct{ name, header string }{
		{"no header", ""},
		{"not a bearer", "Token " + e.token},
		{"empty bearer", "Bearer "},
		{"wrong token", "Bearer " + strings.Repeat("z", 43)},
		{"cookie is not a bridge credential", "Basic " + e.token},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			client, resp, err := e.dial(tc.header, "")
			if client != nil {
				_ = client.conn.CloseNow()
			}
			_ = err
			if resp == nil {
				t.Fatal("no HTTP response: the upgrade should be refused, not attempted")
			}
			if resp.StatusCode != 401 {
				t.Fatalf("status = %d, want 401", resp.StatusCode)
			}
			decodeFailure(t, resp, 401, protocol.CodeUnauthenticated)
		})
	}
}

// TestBridgeRejectsBrowserOrigin covers §8.1 and R5: a browser Origin can never
// open the bridge, whatever it says.
func TestBridgeRejectsBrowserOrigin(t *testing.T) {
	e := newEnv(t)
	for _, origin := range []string{testOrigin, "https://evil.example", "null"} {
		client, resp, err := e.dial("Bearer "+e.token, origin)
		if client != nil {
			_ = client.conn.CloseNow()
		}
		_ = err
		if resp == nil {
			t.Fatalf("origin %q got no HTTP response", origin)
		}
		if resp.StatusCode != 403 {
			t.Fatalf("origin %q status = %d, want 403", origin, resp.StatusCode)
		}
		decodeFailure(t, resp, 403, protocol.CodeOriginForbidden)
	}
}

// TestBridgeFirstFrameMustBeHello covers §8.4.1 and §8.5: any frame before a
// valid hello closes the connection with 1008, and a bad version does too.
func TestBridgeFirstFrameMustBeHello(t *testing.T) {
	e := newEnv(t)

	t.Run("request before hello", func(t *testing.T) {
		c := e.mustDialBridge()
		c.send(map[string]any{"type": "pair.create", "id": "3f2504e0-4f89-41d3-9a0c-0305e82c3301"})
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		_, _, err := c.conn.Read(ctx)
		if err == nil {
			t.Fatal("the relay accepted a frame before hello")
		}
		if websocket.CloseStatus(err) != websocket.StatusPolicyViolation {
			t.Fatalf("close status = %v, want 1008", websocket.CloseStatus(err))
		}
	})

	t.Run("wrong version", func(t *testing.T) {
		c := e.mustDialBridge()
		c.send(map[string]any{"type": "hello", "version": 2, "clientName": "OLD", "capabilities": map[string]any{}})
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		_, _, err := c.conn.Read(ctx)
		if err == nil {
			t.Fatal("the relay accepted hello version 2")
		}
		if websocket.CloseStatus(err) != websocket.StatusPolicyViolation {
			t.Fatalf("close status = %v, want 1008", websocket.CloseStatus(err))
		}
	})
}

// TestBridgePingPong covers §8.4.3 and §10.5.
func TestBridgePingPong(t *testing.T) {
	e := newEnv(t)
	c := e.helloBridge(protocol.Capabilities{Tools: []string{"codex"}})
	c.send(map[string]any{"type": "ping"})
	if f := c.read(); f.Type != protocol.FramePong {
		t.Fatalf("answer to ping = %q, want pong", f.Type)
	}
	// An unknown frame type is ignored, not fatal (§8.5).
	c.send(map[string]any{"type": "something.from.the.future"})
	c.send(map[string]any{"type": "ping"})
	if f := c.read(); f.Type != protocol.FramePong {
		t.Fatalf("after an unknown frame the connection stopped answering: got %q", f.Type)
	}
}

// ---- R12/R19: downloads and the static site --------------------------------

// TestDownloadsWhitelist covers R12, R19 item 1 and §7.5: only .apk files from
// the whitelist root are served, and every refusal is the same 404 so the
// endpoint cannot be used as a filesystem probe.
func TestDownloadsWhitelist(t *testing.T) {
	e := newEnv(t)

	ok := e.request("GET", "/downloads/app-release.apk", testOrigin, "", "", "")
	body := readBody(t, ok)
	if ok.StatusCode != 200 {
		t.Fatalf("apk status = %d, want 200 (body %s)", ok.StatusCode, body)
	}
	if got := ok.Header.Get("Content-Type"); got != "application/vnd.android.package-archive" {
		t.Fatalf("Content-Type = %q, want application/vnd.android.package-archive", got)
	}
	if !strings.Contains(ok.Header.Get("Content-Disposition"), "app-release.apk") {
		t.Fatalf("Content-Disposition = %q", ok.Header.Get("Content-Disposition"))
	}
	if !strings.Contains(body, "fake apk") {
		t.Fatalf("body = %q, want the file contents", body)
	}

	refused := []string{
		"/downloads/secrets.json",
		"/downloads/..%2fsecrets.json",
		"/downloads/%2e%2e%2fsecrets.json",
		"/downloads/../relay.json",
		"/downloads/app-release.apk/../../relay.json",
		"/downloads/",
		"/downloads",
		"/downloads/nothing-here.apk",
		"/downloads/app-release.apk.txt",
	}
	for _, path := range refused {
		resp := e.request("GET", path, testOrigin, "", "", "")
		decodeFailure(t, resp, 404, protocol.CodeNotFound)
	}

	// §7.5: a non-GET/HEAD method is 405 with an Allow header.
	resp := e.request("POST", "/downloads/app-release.apk", testOrigin, "application/json", "", `{}`)
	body = readBody(t, resp)
	if resp.StatusCode != 405 {
		t.Fatalf("POST /downloads status = %d, want 405 (body %s)", resp.StatusCode, body)
	}
	if allow := resp.Header.Get("Allow"); !strings.Contains(allow, "GET") {
		t.Fatalf("Allow = %q, want it to include GET", allow)
	}
}

// TestDownloadsNeedsExactOrigin covers §7.5 for a *present* Origin: a value that
// is not the exact configured one is refused.
func TestDownloadsNeedsExactOrigin(t *testing.T) {
	e := newEnv(t)
	for _, origin := range []string{"https://evil.example", "http://101.43.98.18", "https://101.43.98.18.evil.example", "null"} {
		resp := e.request("GET", "/downloads/app-release.apk", origin, "", "", "")
		decodeFailure(t, resp, 403, protocol.CodeOriginForbidden)
	}
}

// TestDownloadWorksWithoutOrigin covers the field report from the deployed
// server: a browser address-bar download, a phone "save link" and a plain curl
// send NO Origin header at all, so requiring one made the public APK
// undownloadable for exactly the people it exists for.
//
// The APK is a public whitelisted file, so a missing Origin is accepted on
// GET/HEAD. A present but wrong Origin is still refused (previous test), and
// /api/* and /bridge keep the strict rule (TestInputHardening,
// TestBridgeRejectsBrowserOrigin).
func TestDownloadWorksWithoutOrigin(t *testing.T) {
	e := newEnv(t)

	// Real no-Origin GET of a whitelisted APK.
	resp := e.request("GET", "/downloads/app-release.apk", "", "", "", "")
	body := readBody(t, resp)
	if resp.StatusCode != 200 {
		t.Fatalf("GET /downloads/app-release.apk with no Origin = %d, want 200 (body %s)", resp.StatusCode, body)
	}
	if !strings.Contains(body, "fake apk") {
		t.Fatalf("body = %q, want the APK bytes", body)
	}
	if got := resp.Header.Get("Content-Type"); got != "application/vnd.android.package-archive" {
		t.Fatalf("Content-Type = %q, want application/vnd.android.package-archive", got)
	}
	if resp.Header.Get("Access-Control-Allow-Origin") != "" {
		t.Fatal("no-Origin download must not start answering with a CORS header")
	}

	// HEAD works the same way.
	req, err := http.NewRequest("HEAD", e.srv.URL+"/downloads/app-release.apk", nil)
	if err != nil {
		t.Fatalf("NewRequest: %v", err)
	}
	head, err := e.srv.Client().Do(req)
	if err != nil {
		t.Fatalf("HEAD: %v", err)
	}
	readBody(t, head)
	if head.StatusCode != 200 {
		t.Fatalf("HEAD with no Origin = %d, want 200", head.StatusCode)
	}

	// A no-Origin request for something that is NOT on the whitelist is still a
	// flat 404: the looser Origin rule must not have loosened the whitelist.
	for _, path := range []string{
		"/downloads/relay.json",
		"/downloads/secrets.json",
		"/downloads/nothing-here.apk",
		"/downloads/",
	} {
		noOrigin := e.request("GET", path, "", "", "", "")
		decodeFailure(t, noOrigin, 404, protocol.CodeNotFound)
	}

	// And the strict routes stay strict: no Origin there is still 403.
	strict := e.request("POST", "/api/rpc", "", "application/json", "rc_session="+strings.Repeat("a", 43), `{"method":"sessions.list"}`)
	decodeFailure(t, strict, 403, protocol.CodeOriginForbidden)
	bridge := e.request("GET", "/bridge", "", "", "", "")
	decodeFailure(t, bridge, 401, protocol.CodeUnauthenticated) // auth checked before Origin, still refused
}

// TestPairUsedReachesAReconnectedDesktop covers the QA finding that `pair.used`
// never arrived. The ordinary way to lose it is a desktop that reconnects
// between asking for the code and the phone using it: the frame was addressed to
// a connection that no longer exists.
func TestPairUsedReachesAReconnectedDesktop(t *testing.T) {
	e := newEnv(t)
	caps := protocol.Capabilities{Tools: []string{"codex"}}

	first := e.helloBridge(caps)
	code := e.mintCode(first)

	// The desktop drops and comes back with a new connection before the phone
	// pairs — a restart, a laptop sleep, a flaky link.
	_ = first.conn.CloseNow()
	deadline := time.Now().Add(2 * time.Second)
	for e.hub.BridgeOnline() && time.Now().Before(deadline) {
		time.Sleep(20 * time.Millisecond)
	}

	second := e.helloBridge(caps)

	resp := e.request("POST", "/api/pair", testOrigin, "application/json", "",
		fmt.Sprintf(`{"code":%q,"deviceName":"Pixel 8"}`, code))
	if resp.StatusCode != 200 {
		t.Fatalf("POST /api/pair status = %d, body %s", resp.StatusCode, readBody(t, resp))
	}
	readBody(t, resp)

	// The surviving connection must learn that a pairing happened.
	frame, ok := second.readPairUsedQuiet()
	if !ok {
		t.Fatal("pair.used never reached the reconnected desktop")
	}
	if frame.DeviceName != "Pixel 8" {
		t.Fatalf("deviceName = %q, want Pixel 8", frame.DeviceName)
	}
	if strings.Contains(string(mustJSON(t, frame)), "rc_session") {
		t.Fatal("pair.used carried session material")
	}
}

// TestTraversalIs404NotARedirect covers §7.5's rule that a path traversal is
// answered with the same flat 404 as everything else.
//
// The client here deliberately does NOT follow redirects. Go's ServeMux cleans
// a path before any handler runs, so a traversal used to come back as a 307
// pointing at a completely different route — which then produced a 404 for the
// wrong reason, and would have reached the static route if that path had been
// servable.
func TestTraversalIs404NotARedirect(t *testing.T) {
	e := newEnv(t)
	client := &http.Client{
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
	}
	paths := []string{
		"/downloads/../relay.json",
		"/downloads/..%2frelay.json",
		"/downloads/%2e%2e%2frelay.json",
		"/downloads/../../etc/passwd",
		"/../relay.json",
	}
	for _, path := range paths {
		req, err := http.NewRequest("GET", e.srv.URL+path, nil)
		if err != nil {
			t.Fatalf("NewRequest(%s): %v", path, err)
		}
		req.Header.Set("Origin", testOrigin)
		resp, err := client.Do(req)
		if err != nil {
			t.Fatalf("GET %s: %v", path, err)
		}
		body := readBody(t, resp)
		if resp.StatusCode >= 300 && resp.StatusCode < 400 {
			t.Fatalf("GET %s returned %d with Location %q; a traversal must be a flat 404",
				path, resp.StatusCode, resp.Header.Get("Location"))
		}
		if resp.StatusCode != 404 {
			t.Fatalf("GET %s status = %d, want 404 (body %s)", path, resp.StatusCode, body)
		}
	}
}

// TestStaticSiteMissingWebDir covers R19 item 4: with relay/web absent the site
// routes answer a clear 404 instead of crashing, and they never fall back to
// the downloads whitelist.
func TestStaticSiteMissingWebDir(t *testing.T) {
	e := newEnv(t)
	for _, path := range []string{"/", "/index.html", "/assets/app.js"} {
		resp := e.request("GET", path, "", "", "", "")
		if resp.StatusCode != 404 {
			t.Fatalf("GET %s status = %d, want 404 while relay/web is absent (body %s)",
				path, resp.StatusCode, readBody(t, resp))
		}
	}
	// The two route families never fall back into each other.
	resp := e.request("GET", "/downloads/../index.html", testOrigin, "", "", "")
	decodeFailure(t, resp, 404, protocol.CodeNotFound)
}

// TestStaticSiteServesFilesWhenPresent covers R19 item 2: the site is served
// from the configured web directory at every allow-listed path the delivered
// front end actually uses — index.html, css/ and js/ — and nothing else.
func TestStaticSiteServesFilesWhenPresent(t *testing.T) {
	e := newEnv(t)
	web := e.cfg.WebDir
	for _, dir := range []string{"css", "js", "assets"} {
		if err := os.MkdirAll(filepath.Join(web, dir), 0o755); err != nil {
			t.Fatalf("MkdirAll: %v", err)
		}
	}
	files := map[string]string{
		"index.html":      "<html>relay</html>",
		"css/app.css":     "body{color:red}",
		"js/app.js":       "console.log(1)",
		"js/core.js":      "export const x = 1",
		"assets/logo.png": "PNG",
	}
	for name, body := range files {
		if err := os.WriteFile(filepath.Join(web, filepath.FromSlash(name)), []byte(body), 0o644); err != nil {
			t.Fatalf("WriteFile %s: %v", name, err)
		}
	}
	// Files that sit next to the site but are not part of it.
	for name, body := range map[string]string{
		"relay.db":      "secret",
		"relay.json":    `{"bridgeToken":"x"}`,
		"app.log":       "log",
		"server.key":    "key",
		"notes.txt.bak": "bak",
		".env":          "SECRET=1",
	} {
		if err := os.WriteFile(filepath.Join(web, name), []byte(body), 0o600); err != nil {
			t.Fatalf("WriteFile %s: %v", name, err)
		}
	}

	for name, want := range files {
		resp := e.request("GET", "/"+name, "", "", "", "")
		if name == "index.html" {
			// "/index.html" and "/" are the same document.
			resp = e.request("GET", "/", "", "", "", "")
		}
		body := readBody(t, resp)
		if resp.StatusCode != 200 {
			t.Fatalf("GET /%s status = %d, want 200 (body %s)", name, resp.StatusCode, body)
		}
		if !strings.Contains(body, want) {
			t.Fatalf("GET /%s body = %q, want it to contain %q", name, body, want)
		}
	}

	// A database, a private config or a key next to the site is not the site.
	for _, name := range []string{"relay.db", "relay.json", "app.log", "server.key", "notes.txt.bak", ".env"} {
		resp := e.request("GET", "/"+name, "", "", "", "")
		if resp.StatusCode != 404 {
			t.Fatalf("GET /%s = %d, want 404 (body %s)", name, resp.StatusCode, readBody(t, resp))
		}
	}

	// And the site family never falls back into the downloads whitelist.
	resp := e.request("GET", "/app-release.apk", "", "", "", "")
	if resp.StatusCode != 404 {
		t.Fatalf("GET /app-release.apk = %d, want 404: APKs live under /downloads/", resp.StatusCode)
	}
}

func mustJSON(t *testing.T, v any) []byte {
	t.Helper()
	raw, err := json.Marshal(v)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	return raw
}
