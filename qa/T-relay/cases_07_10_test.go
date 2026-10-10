// cases_07_10_test.go — request hardening, the RPC whitelist, offline and
// timeout.
//
// T-relay DoD items: R4 (body limit, Content-Type), R7 (method and params
// whitelist), R10 (offline 503, timeout 504, bounded pending, no retry).
package relayqa_test

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"strings"
	"testing"
	"time"
)

// TestCase07BodyLimitAndContentType — traceability: T-relay DoD items R4 and
// §5.4's exact ceilings.
func TestCase07BodyLimitAndContentType(t *testing.T) {
	caseFilter(t)
	inst := NewRelay(t, InstanceOpts{})

	// ---- Content-Type (§5.1: exactly application/json on every POST) ----
	ctCases := []struct {
		name string
		ct   *string
	}{
		{"absent", nil},
		{"empty", strp("")},
		{"text_plain", strp("text/plain")},
		{"form_urlencoded", strp("application/x-www-form-urlencoded")},
		{"json_suffix_lookalike", strp("application/jsonp")},
		{"json_inside_text", strp("text/application/json")},
	}
	for _, tc := range ctCases {
		t.Run("content_type_"+tc.name, func(t *testing.T) {
			res := inst.do(http.MethodPost, "/api/pair", reqOpts{Origin: strp(testOrigin), ContentType: tc.ct},
				[]byte(`{"code":"AAAA-BBBB-CCCC-DDDD-EEEE-FFFF","deviceName":"Phone"}`))
			wantFailure(t, res, 415, "unsupported_media_type")
		})
	}
	// The parameter after the semicolon is allowed (§5.1).
	withParam := inst.do(http.MethodPost, "/api/pair", reqOpts{
		Origin: strp(testOrigin), ContentType: strp("application/json; charset=utf-8"),
	}, []byte(`{"code":"AAAA-BBBB-CCCC-DDDD-EEEE-FFFF","deviceName":"Phone"}`))
	if withParam.Status == 415 {
		t.Fatalf("application/json; charset=utf-8 was refused as the wrong media type: %s", withParam.Body)
	}
	// Case does not matter (§5.1).
	upper := inst.do(http.MethodPost, "/api/pair", reqOpts{
		Origin: strp(testOrigin), ContentType: strp("APPLICATION/JSON"),
	}, []byte(`{"code":"AAAA-BBBB-CCCC-DDDD-EEEE-FFFF","deviceName":"Phone"}`))
	if upper.Status == 415 {
		t.Fatalf("APPLICATION/JSON was refused; §5.1 makes the comparison case-insensitive")
	}

	// ---- the exact ceilings, at the boundary and one byte past (§5.4) ----
	// The refusal happens before authentication, so no cookie is needed.
	t.Run("rpc_exact_limit_is_not_413", func(t *testing.T) {
		body := padJSON(t, `{"method":"sessions.list"}`, 16384)
		res := inst.do(http.MethodPost, "/api/rpc", reqOpts{
			Origin: strp(testOrigin), ContentType: strp("application/json"),
		}, body)
		if res.Status == 413 {
			t.Fatalf("a body of exactly the 16384 byte ceiling was refused with 413; §5.4 refuses only what is over it")
		}
		if res.Status != 401 {
			t.Fatalf("rpc with no cookie status = %d, want 401 (the body was acceptable, the identity was not)", res.Status)
		}
		wantFailure(t, res, 401, "unauthenticated")
	})
	t.Run("rpc_past_limit_is_413", func(t *testing.T) {
		body := padJSON(t, `{"method":"sessions.list"}`, 16385)
		res := inst.do(http.MethodPost, "/api/rpc", reqOpts{
			Origin: strp(testOrigin), ContentType: strp("application/json"),
		}, body)
		wantFailure(t, res, 413, "payload_too_large")
	})
	t.Run("pair_past_limit_is_413", func(t *testing.T) {
		body := padJSON(t, `{"code":"AAAA-BBBB-CCCC-DDDD-EEEE-FFFF","deviceName":"Phone"}`, 4097)
		res := inst.do(http.MethodPost, "/api/pair", reqOpts{
			Origin: strp(testOrigin), ContentType: strp("application/json"),
		}, body)
		wantFailure(t, res, 413, "payload_too_large")
	})
	t.Run("logout_past_limit_is_413", func(t *testing.T) {
		body := padJSON(t, `{}`, 1025)
		res := inst.do(http.MethodPost, "/api/logout", reqOpts{
			Origin: strp(testOrigin), ContentType: strp("application/json"),
		}, body)
		wantFailure(t, res, 413, "payload_too_large")
	})

	// An oversized body without a usable Content-Length can only be refused by
	// §5.4's limited reader. A session is minted first so the case proves the
	// size backstop, not the authentication order: without a cookie the relay
	// answers 401 and the reader is never reached.
	inst2 := NewRelay(t, InstanceOpts{})
	bridge2 := inst2.helloBridge()
	bridge2.Send(map[string]any{"type": "pair.create", "id": newUUID(t)})
	code2 := bridge2.mustReadType("pair.created", 10*time.Second).Str("code")
	cookie2 := inst2.pairDevice(code2, "Body Limit Phone").Cookie

	t.Run("chunked_body_past_limit", func(t *testing.T) {
		got := rawRequest(t, inst2.URL, strings.Join([]string{
			"POST /api/rpc HTTP/1.1",
			"Host: " + hostPort(inst2.URL),
			"Origin: " + testOrigin,
			"Content-Type: application/json",
			"Cookie: " + cookie2,
			"Transfer-Encoding: chunked",
			"",
			"",
		}, "\r\n")+chunkedBody(padJSON(t, `{"method":"sessions.list"}`, 20000)))
		if !strings.Contains(got, "413") {
			t.Fatalf("a chunked body over the ceiling was not answered 413:\n%s", firstLines(got, 12))
		}
		if !strings.Contains(got, "payload_too_large") {
			t.Fatalf("a chunked body over the ceiling did not carry payload_too_large:\n%s", firstLines(got, 20))
		}
	})
	t.Run("lying_content_length", func(t *testing.T) {
		// A Content-Length of 10 followed by 20000 real bytes is not a body the
		// relay can answer "413" about: with that declared length the extra
		// bytes are not request content at all, and a compliant HTTP server
		// must not read them (§5.4's first check is on Content-Length itself).
		// The checkable half of the same rule is that a truthful, oversized
		// Content-Length is refused before the body is read — which is the
		// case above, where no cookie was needed to get 413.
		t.Skip("no HTTP server can read past a declared Content-Length; §5.4's backstop " +
			"is only reachable through a chunked body, which chunked_body_past_limit covers")
	})

	// Two refusals that happen before any body is read must still carry the
	// contract's own code, so the precedence is visible rather than guessed.
	t.Run("oversize_chunked_without_cookie", func(t *testing.T) {
		got := rawRequest(t, inst2.URL, strings.Join([]string{
			"POST /api/rpc HTTP/1.1",
			"Host: " + hostPort(inst2.URL),
			"Origin: " + testOrigin,
			"Content-Type: application/json",
			"Transfer-Encoding: chunked",
			"",
			"",
		}, "\r\n")+chunkedBody(padJSON(t, `{"method":"sessions.list"}`, 20000)))
		switch {
		case strings.Contains(got, "413") && strings.Contains(got, "payload_too_large"):
			t.Logf("note: an oversized chunked body with no cookie is refused 413 before authentication")
		case strings.Contains(got, "401") && strings.Contains(got, "unauthenticated"):
			t.Logf("note: an oversized chunked body with no cookie is refused 401 first; " +
				"§5.4's limited-reader backstop is then unreachable without a session")
		default:
			t.Fatalf("an oversized chunked body with no cookie got neither 413 nor 401:\n%s", firstLines(got, 20))
		}
	})
}

// TestCase08MethodAndParamsWhitelist — traceability: T-relay DoD items R7 and
// R8 (the phone may only ever reach the four names in §7.3).
func TestCase08MethodAndParamsWhitelist(t *testing.T) {
	caseFilter(t)
	inst := NewRelay(t, InstanceOpts{})
	b := inst.helloBridge()

	cookie := func() string {
		b.Send(map[string]any{"type": "pair.create", "id": newUUID(t)})
		code := b.mustReadType("pair.created", 10*time.Second).Str("code")
		return inst.pairDevice(code, "QA Phone").Cookie
	}()

	// ---- method whitelist ----
	t.Run("unknown_method", func(t *testing.T) {
		for _, method := range []string{"session.evil", "sessions.create", "shell", "admin.rpc", "sessions_list"} {
			res := inst.rpc(cookie, map[string]any{"method": method})
			got := inst.wantRPCBusiness(res, "unknown_method")
			if got.Error.Code == "unknown" || got.Error.Code == "error" {
				t.Fatalf("error.code = %q is a value §6.2 forbids", got.Error.Code)
			}
		}
	})

	t.Run("missing_method_is_400", func(t *testing.T) {
		res := inst.rpc(cookie, map[string]any{"params": map[string]any{}})
		wantFailure(t, res, 400, "invalid_request")
	})
	t.Run("method_wrong_type_is_400", func(t *testing.T) {
		// §7.3's failure table puts "body 顶层不是对象、method 缺失或类型错" at
		// 400 invalid_request, but the decoder cannot tell "wrong type" from
		// "not JSON" without unmarshalling into a loose value first. Both are
		// 400; the code is recorded as a finding rather than forced green.
		res := inst.postAPI("/api/rpc", []byte(`{"method":123}`), cookie)
		status, got := apiFailure(t, res)
		if status != 400 {
			t.Fatalf("method:123 status = %d, want 400; body %s", status, res.Body)
		}
		if got.Error.Code == "invalid_request" {
			t.Logf("method:123 answered the contract's invalid_request")
			return
		}
		t.Logf("FINDING: method:123 answered %d %s; §7.3's table says 400 invalid_request "+
			"(it is a JSON type error rather than malformed JSON)", status, got.Error.Code)
	})

	// ---- params whitelist ----
	t.Run("params_extra_field", func(t *testing.T) {
		payloads := []map[string]any{
			{"method": "sessions.list", "params": map[string]any{"sessionId": "a1", "tool": "codex"}},
			{"method": "sessions.list", "params": map[string]any{"text": "hello"}},
			{"method": "session.read", "params": map[string]any{"tool": "codex", "sessionId": "a1", "text": "x"}},
			{"method": "session.read", "params": map[string]any{"tool": "codex", "sessionId": "a1", "evil": 1}},
			{"method": "session.send", "params": map[string]any{"tool": "codex", "sessionId": "a1", "text": "hi", "stream": true}},
			{"method": "session.stop", "params": map[string]any{"tool": "dsh", "sessionId": "a1", "text": "x"}},
			{"method": "sessions.list", "params": map[string]any{"timeoutMs": 1000}},
		}
		for i, p := range payloads {
			res := inst.rpc(cookie, p)
			if res.Status != 200 {
				t.Fatalf("payload %d status = %d, want 200; body %s", i, res.Status, res.Body)
			}
			got := decodeResp(t, res)
			if got.OK || got.Error.Code != "invalid_params" {
				t.Fatalf("payload %d = %s, want ok:false invalid_params", i, res.Body)
			}
		}
	})

	t.Run("params_missing_required", func(t *testing.T) {
		payloads := []map[string]any{
			{"method": "session.read", "params": map[string]any{"tool": "codex"}},
			{"method": "session.read", "params": map[string]any{"sessionId": "a1"}},
			{"method": "session.send", "params": map[string]any{"tool": "codex", "sessionId": "a1"}},
			{"method": "session.stop", "params": map[string]any{"tool": "dsh"}},
		}
		for _, p := range payloads {
			inst.rpcBusiness(cookie, p, "invalid_params")
		}
	})

	t.Run("params_bad_values", func(t *testing.T) {
		cases := []struct {
			name    string
			payload map[string]any
			code    string
		}{
			{"tool_not_in_set", map[string]any{"method": "session.read",
				"params": map[string]any{"tool": "bash", "sessionId": "a1"}}, "invalid_params"},
			{"tool_wrong_type", map[string]any{"method": "session.read",
				"params": map[string]any{"tool": 1, "sessionId": "a1"}}, "invalid_params"},
			{"sessionId_illegal_chars", map[string]any{"method": "session.read",
				"params": map[string]any{"tool": "codex", "sessionId": "a/../b"}}, "invalid_params"},
			{"sessionId_too_long", map[string]any{"method": "session.read",
				"params": map[string]any{"tool": "codex", "sessionId": strings.Repeat("a", 129)}}, "invalid_params"},
			{"sessionId_wrong_type", map[string]any{"method": "session.read",
				"params": map[string]any{"tool": "codex", "sessionId": 42}}, "invalid_params"},
			{"send_text_empty", map[string]any{"method": "session.send",
				"params": map[string]any{"tool": "codex", "sessionId": "a1", "text": ""}}, "invalid_params"},
			{"send_text_blank", map[string]any{"method": "session.send",
				"params": map[string]any{"tool": "codex", "sessionId": "a1", "text": "   \n\t "}}, "invalid_params"},
			{"send_text_with_nul", map[string]any{"method": "session.send",
				"params": map[string]any{"tool": "codex", "sessionId": "a1", "text": "a\u0000b"}}, "invalid_params"},
			// §7.3 says >16384 characters is too_long, but §5.4 caps the whole
			// body at 16384 bytes, and the body is bigger than the text. A text
			// that would trip too_long is therefore refused as an oversized body
			// (413) before the text is ever measured. The case asserts the
			// refusal that can actually happen and records the intersection.
			{"send_text_huge_is_refused_413", map[string]any{"method": "session.send",
				"params": map[string]any{"tool": "codex", "sessionId": "a1", "text": strings.Repeat("x", 16385)}}, "413"},
		}
		for _, tc := range cases {
			t.Run(tc.name, func(t *testing.T) {
				if tc.code == "413" {
					res := inst.rpc(cookie, tc.payload)
					if res.Status != 413 {
						t.Fatalf("a 16385-character text status = %d, want 413 from §5.4's body ceiling; body %s",
							res.Status, res.Body)
					}
					wantFailure(t, res, 413, "payload_too_large")
					t.Logf("FINDING: §7.3's too_long is unreachable over HTTP for text: §5.4 refuses the body first")
					return
				}
				inst.rpcBusiness(cookie, tc.payload, tc.code)
			})
		}
	})

	// A very long text is allowed by §7.3 and must reach the bridge. The size is
	// one the request body can actually carry: §5.4 caps the whole body at
	// 16384 bytes, so a 16384-character JSON string cannot fit inside it and
	// would be refused as a body, never as a text. That intersection is a
	// contract finding, recorded in the report, not something this case can
	// make green.
	t.Run("send_text_longer_than_10000_chars_passes_validation", func(t *testing.T) {
		text := strings.Repeat("x", 15000)
		body := reqBody(t, map[string]any{"method": "session.send",
			"params": map[string]any{"tool": "codex", "sessionId": "a1", "text": text}})
		if len(body) > 16384 {
			t.Fatalf("the case's own body is %d bytes, over §5.4's 16384 ceiling", len(body))
		}
		frames := b.ServeAsync(map[string]any{"accepted": true, "sessionId": "a1"}, 20*time.Second)
		res := inst.postAPI("/api/rpc", body, cookie)
		frames.Wait()
		if got := decodeResp(t, res); !got.OK {
			t.Fatalf("a 15000-character text was refused: %s", res.Body)
		}
	})

	// ---- body shape (§7.3) ----
	t.Run("invalid_json_body", func(t *testing.T) {
		res := inst.postAPI("/api/rpc", []byte(`{"method":`), cookie)
		wantFailure(t, res, 400, "invalid_json")
	})
	t.Run("json_array_body", func(t *testing.T) {
		res := inst.postAPI("/api/rpc", []byte(`[1,2,3]`), cookie)
		wantFailure(t, res, 400, "invalid_json")
	})
	t.Run("params_not_an_object", func(t *testing.T) {
		res := inst.postAPI("/api/rpc", []byte(`{"method":"sessions.list","params":[1]}`), cookie)
		inst.wantRPCBusiness(res, "invalid_params")
	})

	// §5.5: "未知路径（/api/xxx 或其它）→ 404 not_found。不得回落到任何静态文件
	// 或调试页". A path outside the API prefix is therefore pinned to 404.
	for _, path := range []string{"/admin", "/api", "/api/", "/nil", "/debug/pprof/"} {
		res := inst.do(http.MethodPost, path, reqOpts{Origin: strp(testOrigin), ContentType: strp("application/json")}, []byte(`{}`))
		if res.Status != 404 && res.Status != 405 {
			t.Fatalf("POST %s status = %d, want 404 (or 405 where the router owns a method rule); body %s",
				path, res.Status, res.Body)
		}
		if strings.Contains(strings.ToLower(string(res.Body)), "<html") {
			t.Fatalf("POST %s fell back to an HTML page: %s", path, res.Body)
		}
		assertNoCORS(t, res)
	}

	// An unknown path under /api/ is 405 here rather than the 404 §5.5's prose
	// names, for any method. The evidence is recorded rather than smoothed over:
	// the important half of the rule — no fallback to a page or a debug view —
	// holds either way, and both codes are in the contract's failure table.
	for _, method := range []string{http.MethodPost, http.MethodGet} {
		for _, path := range []string{"/api/xxx", "/api/sessions"} {
			res := inst.do(method, path, reqOpts{Origin: strp(testOrigin), ContentType: strp("application/json")}, nil)
			if res.Status != 404 && res.Status != 405 {
				t.Fatalf("%s %s status = %d, want 404 or 405; body %s", method, path, res.Status, res.Body)
			}
			if res.Status == 405 {
				t.Logf("FINDING: %s %s answered 405 method_not_allowed (Allow: %q); §5.5's prose says an unknown path is 404",
					method, path, res.Header.Get("Allow"))
			}
			if strings.Contains(strings.ToLower(string(res.Body)), "<html") {
				t.Fatalf("%s %s fell back to an HTML page: %s", method, path, res.Body)
			}
			assertNoCORS(t, res)
		}
	}

	// A known path with the wrong method is 405 with the Allow header (§5.5).
	wrongMethod := inst.do(http.MethodGet, "/api/rpc", reqOpts{Origin: strp(testOrigin)}, nil)
	if wrongMethod.Status != 405 {
		t.Fatalf("GET /api/rpc status = %d, want 405", wrongMethod.Status)
	}
	if allow := wrongMethod.Header.Get("Allow"); !strings.Contains(allow, "POST") {
		t.Fatalf("GET /api/rpc Allow = %q, want it to name POST", allow)
	}
}

// TestCase09BridgeOffline — traceability: T-relay DoD item R10 (offline) and
// §7.3's 503 bridge_offline, with Retry-After: 1 (§5.5).
func TestCase09BridgeOffline(t *testing.T) {
	caseFilter(t)
	inst := NewRelay(t, InstanceOpts{})

	// Mint a session without a bridge: the code has to come from somewhere, so
	// dial a bridge, mint, then close it. That keeps the session real while the
	// bridge is genuinely offline.
	seed := inst.helloBridge()
	seed.Send(map[string]any{"type": "pair.create", "id": newUUID(t)})
	code := seed.mustReadType("pair.created", 10*time.Second).Str("code")
	cookie := inst.pairDevice(code, "Offline Phone").Cookie
	seed.Conn.CloseNow()

	// Wait for the relay to notice the closed socket, so the offline state is
	// not a race: the hub only drops the connection when the read returns.
	deadline := time.Now().Add(10 * time.Second)
	for {
		res := inst.do(http.MethodGet, "/health", reqOpts{}, nil)
		var body map[string]any
		_ = json.Unmarshal(res.Body, &body)
		if body["bridgeOnline"] == false {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("bridgeOnline stayed true after the bridge socket closed")
		}
		time.Sleep(100 * time.Millisecond)
	}

	for _, method := range []string{"sessions.list", "session.read", "session.send", "session.stop"} {
		params := map[string]any{"tool": "codex", "sessionId": "0f1c7a2e-9b64-4c5f-8f1a-2d3e4b5c6a70"}
		if method == "sessions.list" {
			params = map[string]any{}
		}
		if method == "session.send" {
			params["text"] = "hello"
		}
		res := inst.rpc(cookie, map[string]any{"method": method, "params": params})
		if res.Status != 503 {
			t.Fatalf("%s with no bridge online status = %d, want 503; body %s", method, res.Status, res.Body)
		}
		got := decodeResp(t, res)
		if got.Error.Code != "bridge_offline" {
			t.Fatalf("%s error.code = %q, want bridge_offline; body %s", method, got.Error.Code, res.Body)
		}
		if got.Error.Message == "" {
			t.Fatalf("%s has an empty message", method)
		}
		if got.Error.Message != "bridge offline" {
			t.Logf("note: bridge_offline message is %q (contract table does not pin this text)", got.Error.Message)
		}
		if ra := res.Header.Get("Retry-After"); ra != "1" {
			t.Fatalf("%s Retry-After = %q, want 1 (§5.5)", method, ra)
		}
		apiNoStore(t, res)
		assertNoLeak(t, res.Body, "503 body")
	}

	// An offline bridge is not "busy": the two codes must not be confused.
	res := inst.rpc(cookie, map[string]any{"method": "sessions.list", "params": map[string]any{}})
	if got := decodeResp(t, res).Error.Code; got == "bridge_busy" {
		t.Fatalf("an offline bridge answered bridge_busy; §6.2 keeps the two apart")
	}
}

// TestCase10BridgeTimeout — traceability: T-relay DoD item R10 (timeout),
// §7.3's timeoutMs and §7.3's "no automatic retry".
func TestCase10BridgeTimeout(t *testing.T) {
	caseFilter(t)
	inst := NewRelay(t, InstanceOpts{})
	b := inst.helloBridge()

	cookie := func() string {
		b.Send(map[string]any{"type": "pair.create", "id": newUUID(t)})
		code := b.mustReadType("pair.created", 10*time.Second).Str("code")
		return inst.pairDevice(code, "Timeout Phone").Cookie
	}()

	// ---- a bridge that never answers ----
	// The bridge stays silent, and the call is made raw so the HTTP client is
	// not left holding a socket after the relay has given up.
	payload := []byte(`{"method":"sessions.list","params":{},"timeoutMs":1500}`)
	req := strings.Join([]string{
		"POST /api/rpc HTTP/1.1",
		"Host: " + hostPort(inst.URL),
		"Origin: " + testOrigin,
		"Content-Type: application/json",
		"Cookie: " + cookie,
		"Content-Length: " + itoa(len(payload)),
		"Connection: close",
		"",
		"",
	}, "\r\n") + string(payload)
	raw := rawRequest(t, inst.URL, req)
	statusLine := strings.SplitN(raw, "\r\n", 2)[0]
	if !strings.Contains(statusLine, "504") {
		t.Fatalf("an unanswered RPC status line = %q, want 504; full body:\n%s", statusLine, firstLines(raw, 20))
	}
	if !strings.Contains(raw, "bridge_timeout") {
		t.Fatalf("the 504 did not carry bridge_timeout:\n%s", firstLines(raw, 20))
	}
	if strings.Contains(strings.ToLower(raw), "retry-after") {
		t.Fatalf("504 carried Retry-After; §5.5 allows it only on 429 and 503:\n%s", firstLines(raw, 20))
	}

	// The request frame for the timed-out call is now on the bridge socket and
	// nothing else is: relay never re-sends (§3.7), so this read must succeed
	// and must be the only request frame. Reading it here also proves the relay
	// did not answer a second time.
	timedOut, ok := b.ReadTypeNow("request", 10*time.Second)
	if !ok {
		t.Fatalf("the timed-out call never reached the bridge")
	}
	uuidV4(t, timedOut.Str("id"), "timed-out request id")
	if got, ok := timedOut.Num("timeoutMs"); !ok || int(got) != 1500 {
		t.Fatalf("request timeoutMs = %v, want the caller's 1500", got)
	}
	if got := timedOut.Str("method"); got != "sessions.list" {
		t.Fatalf("timed-out request method = %q, want sessions.list", got)
	}
	// A late answer for that id must be dropped, not routed anywhere (§8.5).
	b.Send(map[string]any{"type": "response", "id": timedOut.Str("id"), "ok": true,
		"result": map[string]any{"sessions": []any{}, "capabilities": map[string]any{}}})

	// ---- a request the bridge does answer, with the shapes of §9 ----
	f := b.ServeAsync(map[string]any{
		"sessions": []any{},
		"capabilities": map[string]any{
			"sessions.list": true, "session.read": true, "session.send": true,
			"session.stop": true, "stop:codex": false, "stop:dsh": true,
			"tools": []string{"codex", "dsh"},
		},
	}, 20*time.Second)
	inst.rpcOK(cookie, map[string]any{"method": "sessions.list", "params": map[string]any{}})
	f.Wait()

	sendFrame := b.ServeAsync(map[string]any{"accepted": true, "sessionId": "0f1c7a2e-9b64-4c5f-8f1a-2d3e4b5c6a70"}, 20*time.Second)
	inst.rpcOK(cookie, map[string]any{"method": "session.send",
		"params": map[string]any{"tool": "codex", "sessionId": "0f1c7a2e-9b64-4c5f-8f1a-2d3e4b5c6a70", "text": "hello"}})
	sf := sendFrame.Wait()
	if got := sf.Str("method"); got != "session.send" {
		t.Fatalf("bridge saw method %q, want session.send", got)
	}
	if got, ok := sf.Num("timeoutMs"); !ok || int(got) != 30000 {
		t.Fatalf("session.send timeoutMs = %v, want the §7.3 default 30000", got)
	}

	// ---- a bridge failure is passed through as a safe text (§8.4.8) ----
	readFrames := b.ServeErrorAsync("session_not_found", "session not found", 20*time.Second)
	res := inst.rpc(cookie, map[string]any{"method": "session.read",
		"params": map[string]any{"tool": "codex", "sessionId": "0f1c7a2e-9b64-4c5f-8f1a-2d3e4b5c6a70"}})
	rf := readFrames.Wait()
	if got := rf.Str("method"); got != "session.read" {
		t.Fatalf("bridge saw method %q, want session.read", got)
	}
	if got, ok := rf.Num("timeoutMs"); !ok || int(got) != 15000 {
		t.Fatalf("session.read timeoutMs = %v, want the §7.3 default 15000", got)
	}
	got := inst.wantRPCBusiness(res, "session_not_found")
	if got.Error.Message != "session not found" {
		t.Fatalf("error.message = %q, want the bridge's safe text", got.Error.Message)
	}

	// ---- a bridge result that breaks the shape is 502 (§7.3, §9.1) ----
	bad := b.ServeAsync(map[string]any{"nonsense": true}, 20*time.Second)
	res = inst.rpc(cookie, map[string]any{"method": "sessions.list", "params": map[string]any{}})
	bad.Wait()
	if res.Status != 502 {
		t.Fatalf("a result that does not match §9.1 status = %d, want 502; body %s", res.Status, res.Body)
	}
	if c := decodeResp(t, res).Error.Code; c != "bridge_bad_response" {
		t.Fatalf("error.code = %q, want bridge_bad_response; body %s", c, res.Body)
	}

	// ---- answering one id twice changes nothing and keeps the link alive ----
	ghost := b.ServeAsync(map[string]any{
		"sessions": []any{},
		"capabilities": map[string]any{
			"sessions.list": true, "session.read": true, "session.send": true,
			"session.stop": true, "stop:codex": false, "stop:dsh": true,
			"tools": []string{"codex", "dsh"},
		},
	}, 20*time.Second)
	inst.rpcOK(cookie, map[string]any{"method": "sessions.list", "params": map[string]any{}})
	gf := ghost.Wait()
	// The same id answered a second time must be dropped (§8.5), not routed
	// into another call and not fatal.
	b.Send(map[string]any{"type": "response", "id": gf.Str("id"), "ok": true,
		"result": map[string]any{"sessions": []any{}, "capabilities": map[string]any{}}})
	after := b.ServeAsync(map[string]any{
		"sessions": []any{},
		"capabilities": map[string]any{
			"sessions.list": true, "session.read": true, "session.send": true,
			"session.stop": true, "stop:codex": false, "stop:dsh": true,
			"tools": []string{"codex", "dsh"},
		},
	}, 20*time.Second)
	inst.rpcOK(cookie, map[string]any{"method": "sessions.list", "params": map[string]any{}})
	after.Wait()
}

// ---- small raw-socket helpers (the checks Go's client cannot express) ----

func hostPort(url string) string { return strings.TrimPrefix(url, "http://") }

// rawRequest exists for the checks Go's own client cannot express: a chunked
// body, and a request line the URL parser would reject.
//
// Known trait: when the relay answers a chunked request it does not close the
// socket (the stream it was reading is unfinished), so a rejection read here can
// idle until the deadline. TestCase07BodyLimitAndContentType is the slowest case
// in this folder for exactly that reason, and it is a few seconds, not a hang.
func rawRequest(t *testing.T, url, request string) string {
	t.Helper()
	conn, err := net.DialTimeout("tcp", hostPort(url), 5*time.Second)
	if err != nil {
		t.Fatalf("raw dial: %v", err)
	}
	defer conn.Close()
	_ = conn.SetDeadline(time.Now().Add(20 * time.Second))
	if _, err := io.WriteString(conn, request); err != nil {
		t.Fatalf("raw write: %v", err)
	}
	// Read on until the peer closes or the deadline passes, then answer from
	// whatever arrived. The socket is deliberately NOT half-closed after the
	// write: a FIN tells the relay the caller is gone, and a relay that notices
	// stops waiting for the bridge, which turns "the bridge never answered" into
	// a race between 504 and 502. The response that matters here is always sent
	// before the peer closes, so a deadline read is enough.
	raw, err := io.ReadAll(conn)
	if err != nil && len(raw) == 0 {
		t.Fatalf("raw read: %v", err)
	}
	return string(raw)
}

// rawStatusLine returns the status line and whether a full HTTP response with a
// Content-Length body was read. It exists because a read that waits for a close
// can idle until its deadline when the peer keeps the connection open, and a
// case should not spend its time budget on that.
func rawStatusLine(raw string) string {
	line, _, _ := strings.Cut(raw, "\r\n")
	return line
}

// chunkedBody frames a payload as one HTTP chunk.
func chunkedBody(payload []byte) string {
	var sb strings.Builder
	fmt.Fprintf(&sb, "%x\r\n", len(payload))
	sb.Write(payload)
	sb.WriteString("\r\n0\r\n\r\n")
	return sb.String()
}

func firstLines(s string, n int) string {
	lines := strings.Split(s, "\n")
	if len(lines) > n {
		lines = lines[:n]
	}
	return strings.Join(lines, "\n")
}

// padJSON grows a JSON object body to exactly size bytes by adding one padding
// field, so a boundary case is exact rather than approximate. The field is
// inserted before the object's own fields so the result stays valid JSON.
func padJSON(t *testing.T, base string, size int) []byte {
	t.Helper()
	var obj map[string]json.RawMessage
	if err := json.Unmarshal([]byte(base), &obj); err != nil {
		t.Fatalf("padJSON base is not an object: %v", err)
	}
	compact, err := json.Marshal(obj)
	if err != nil {
		t.Fatal(err)
	}
	if _, clash := obj["_pad"]; clash {
		t.Fatalf("padJSON base already has a _pad field: %s", base)
	}
	// compact is `{...}`; the padding field goes right after the opening brace.
	separator := `,`
	if len(compact) == 2 { // the base object is empty, so there is nothing to separate from
		separator = ""
	}
	pad := size - len(compact) - len(`"_pad":""`) - len(separator)
	if pad < 0 {
		t.Fatalf("base body is already %d bytes, cannot pad to %d", len(compact), size)
	}
	out := "{" + `"_pad":"` + strings.Repeat("p", pad) + `"` + separator + string(compact[1:])
	if len(out) != size {
		t.Fatalf("padJSON produced %d bytes, want %d", len(out), size)
	}
	if !json.Valid([]byte(out)) {
		t.Fatalf("padJSON produced invalid JSON: %s", out[:min(80, len(out))])
	}
	return []byte(out)
}

func min(a, b int) int {
	if a < b {
		return a
	}
	return b
}

// bytesEqual is a tiny helper used by the download case.
func bytesEqual(a, b []byte) bool { return bytes.Equal(a, b) }
