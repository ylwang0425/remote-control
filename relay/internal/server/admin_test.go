package server

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/ai-remote/relay/internal/adminauth"
	"github.com/ai-remote/relay/internal/config"
	"github.com/ai-remote/relay/internal/protocol"
	"github.com/ai-remote/relay/internal/store"
)

const (
	testAdminUsername = "relay-admin"
	testAdminPassword = "correct horse battery staple"
)

func newAdminEnv(t *testing.T) *env {
	t.Helper()
	e := newEnv(t)
	salt := []byte("relay-admin-test-salt-32-bytes!!")
	hash, err := adminauth.Derive([]byte(testAdminPassword), salt, adminauth.Iterations)
	if err != nil {
		t.Fatal(err)
	}
	e.cfg.Admin = &config.Admin{
		Username: testAdminUsername, PasswordSalt: base64.StdEncoding.EncodeToString(salt),
		PasswordHash: base64.StdEncoding.EncodeToString(hash),
	}
	return e
}

func TestAdminLoginKDFConcurrencyGateRejectsWithoutQueueing(t *testing.T) {
	e := newAdminEnv(t)
	e.s.adminKDFSlots <- struct{}{}
	e.s.adminKDFSlots <- struct{}{}
	defer func() {
		<-e.s.adminKDFSlots
		<-e.s.adminKDFSlots
	}()

	resp, _ := adminLogin(e, testAdminUsername, testAdminPassword)
	decodeFailure(t, resp, http.StatusTooManyRequests, protocol.CodeRateLimited)
}

func TestReadOnlyEndpointsAcceptStrictEmptyJSONPOSTWithExactOrigin(t *testing.T) {
	e := newAdminEnv(t)
	login, adminToken := adminLogin(e, testAdminUsername, testAdminPassword)
	if login.StatusCode != http.StatusOK || adminToken == "" {
		t.Fatalf("admin login status/token = %d/%t", login.StatusCode, adminToken != "")
	}
	adminCookie := adminCookieName + "=" + adminToken
	endpoints := []struct {
		path   string
		cookie string
	}{
		{path: "/api/me", cookie: adminCookie},
		{path: "/api/admin/computers", cookie: adminCookie},
	}
	for _, endpoint := range endpoints {
		t.Run(endpoint.path, func(t *testing.T) {
			ok := e.request(http.MethodPost, endpoint.path, testOrigin, "application/json", endpoint.cookie, `{}`)
			if ok.StatusCode != http.StatusOK {
				t.Fatalf("POST {} status = %d, body %s", ok.StatusCode, readBody(t, ok))
			}
			_ = readBody(t, ok)

			wrongOrigin := e.request(http.MethodPost, endpoint.path, "https://wrong.example", "application/json", endpoint.cookie, `{}`)
			decodeFailure(t, wrongOrigin, http.StatusForbidden, protocol.CodeOriginForbidden)

			for _, body := range []string{`{"extra":true}`, `{} {}`} {
				bad := e.request(http.MethodPost, endpoint.path, testOrigin, "application/json", endpoint.cookie, body)
				decodeFailure(t, bad, http.StatusBadRequest, protocol.CodeInvalidJSON)
			}

			missingBody := e.request(http.MethodPost, endpoint.path, testOrigin, "application/json", endpoint.cookie, "")
			decodeFailure(t, missingBody, http.StatusBadRequest, protocol.CodeInvalidJSON)

			wrongType := e.request(http.MethodPost, endpoint.path, testOrigin, "text/plain", endpoint.cookie, `{}`)
			decodeFailure(t, wrongType, http.StatusUnsupportedMediaType, protocol.CodeUnsupportedMediaType)

			large := e.request(http.MethodPost, endpoint.path, testOrigin, "application/json", endpoint.cookie, strings.Repeat(" ", 1025))
			decodeFailure(t, large, http.StatusRequestEntityTooLarge, protocol.CodePayloadTooLarge)
		})
	}

	// Existing GET clients still need the same configured Origin, and an
	// Origin-less GET remains forbidden.
	getOK := e.request(http.MethodGet, "/api/me", testOrigin, "", adminCookie, "")
	if getOK.StatusCode != http.StatusOK {
		t.Fatalf("GET /api/me status = %d, body %s", getOK.StatusCode, readBody(t, getOK))
	}
	_ = readBody(t, getOK)
	getNoOrigin := e.request(http.MethodGet, "/api/me", "", "", adminCookie, "")
	decodeFailure(t, getNoOrigin, http.StatusForbidden, protocol.CodeOriginForbidden)
}

func adminLogin(e *env, username, password string) (*http.Response, string) {
	e.t.Helper()
	body, _ := json.Marshal(map[string]string{"username": username, "password": password})
	resp := e.request(http.MethodPost, "/api/admin/login", testOrigin, "application/json", "", string(body))
	cookie := ""
	for _, c := range resp.Cookies() {
		if c.Name == adminCookieName {
			cookie = c.Value
		}
	}
	return resp, cookie
}

func TestAdminLoginExpiryLogoutAndIndependentRoleCookie(t *testing.T) {
	e := newAdminEnv(t)
	bad, _ := adminLogin(e, testAdminUsername, "wrong password")
	decodeFailure(t, bad, http.StatusUnauthorized, protocol.CodeInvalidCredentials)

	resp, adminToken := adminLogin(e, testAdminUsername, testAdminPassword)
	if resp.StatusCode != http.StatusOK || adminToken == "" {
		t.Fatalf("admin login status/token = %d/%t", resp.StatusCode, adminToken != "")
	}
	adminCookie := adminCookieName + "=" + adminToken
	me := e.request(http.MethodGet, "/api/me", testOrigin, "", adminCookie, "")
	if got := jsonField(t, readBody(t, me), "result", "role"); got != "admin" {
		t.Fatalf("/api/me role = %q, want admin", got)
	}

	// A syntactically valid phone cookie does not become admin merely because
	// an admin cookie was previously issued to the same browser.
	phoneToken, err := store.NewToken()
	if err != nil {
		t.Fatal(err)
	}
	if _, err := e.st.CreateDeviceForClient(store.HashToken(phoneToken), "Phone", "", e.s.now()); err != nil {
		t.Fatal(err)
	}
	phone := e.request(http.MethodGet, "/api/admin/computers", testOrigin, "", "rc_session="+phoneToken, "")
	decodeFailure(t, phone, http.StatusForbidden, protocol.CodeForbidden)

	// Move only this in-memory session expiry into the past; the eight-hour
	// expiry path is the same as a real elapsed deadline without sleeping.
	e.s.adminMu.Lock()
	e.s.adminSessions[store.HashToken(adminToken)] = e.s.now().Add(-time.Second)
	e.s.adminMu.Unlock()
	expired := e.request(http.MethodGet, "/api/me", testOrigin, "", adminCookie, "")
	decodeFailure(t, expired, http.StatusUnauthorized, protocol.CodeUnauthenticated)

	resp, adminToken = adminLogin(e, testAdminUsername, testAdminPassword)
	if resp.StatusCode != http.StatusOK || adminToken == "" {
		t.Fatalf("second admin login status/token = %d/%t", resp.StatusCode, adminToken != "")
	}
	logout := e.request(http.MethodPost, "/api/admin/logout", testOrigin, "application/json", adminCookieName+"="+adminToken, "")
	if logout.StatusCode != http.StatusOK {
		t.Fatalf("admin logout status = %d, body %s", logout.StatusCode, readBody(t, logout))
	}
	after := e.request(http.MethodGet, "/api/me", testOrigin, "", adminCookieName+"="+adminToken, "")
	decodeFailure(t, after, http.StatusUnauthorized, protocol.CodeUnauthenticated)
}

func TestAdminLoginRateLimitRunsBeforeRepeatedKDFAttempts(t *testing.T) {
	e := newAdminEnv(t)
	for i := 0; i < 5; i++ {
		resp, _ := adminLogin(e, testAdminUsername, "wrong password")
		if resp.StatusCode != http.StatusUnauthorized {
			t.Fatalf("bad login %d status = %d, want 401", i+1, resp.StatusCode)
		}
		_ = readBody(t, resp)
	}
	limited, _ := adminLogin(e, testAdminUsername, "wrong password")
	decodeFailure(t, limited, http.StatusTooManyRequests, protocol.CodeRateLimited)
}

func TestEnrollmentAdminRPCTargetingWorkBuddyAndMetadataOnlyAudit(t *testing.T) {
	e := newAdminEnv(t)
	adminResponse, adminToken := adminLogin(e, testAdminUsername, testAdminPassword)
	if adminResponse.StatusCode != http.StatusOK || adminToken == "" {
		t.Fatalf("admin login failed: status %d", adminResponse.StatusCode)
	}
	adminCookie := adminCookieName + "=" + adminToken

	bootstrap := e.helloBridge(protocol.Capabilities{Tools: []string{"codex"}})
	bootstrapSeen := serveBridge(t, bootstrap, func(_ *testing.T, c *wsClient, f *protocol.Frame) {
		c.answer(f.ID, map[string]any{"accepted": true})
	})

	userToken, err := store.NewToken()
	if err != nil {
		t.Fatal(err)
	}
	bootstrapID, err := e.st.BootstrapClientID()
	if err != nil || bootstrapID == "" {
		t.Fatalf("read bootstrap id = %q, %v", bootstrapID, err)
	}
	if _, err := e.st.CreateDeviceForClient(store.HashToken(userToken), "Phone", bootstrapID, e.s.now()); err != nil {
		t.Fatal(err)
	}
	me := e.request(http.MethodGet, "/api/me", testOrigin, "", "rc_session="+userToken, "")
	meBody := readBody(t, me)
	if got := jsonField(t, meBody, "result", "role"); got != "user" {
		t.Fatalf("phone /api/me role = %q", got)
	}
	if got := jsonField(t, meBody, "result", "clientId"); got != bootstrapID {
		t.Fatalf("phone /api/me clientId = %q, want %q", got, bootstrapID)
	}
	foreign := "3f2504e0-4f89-41d3-9a0c-0305e82c3301"
	foreignRPC := e.request(http.MethodPost, "/api/rpc", testOrigin, "application/json", "rc_session="+userToken,
		fmt.Sprintf(`{"clientId":%q,"method":"sessions.list"}`, foreign))
	decodeFailure(t, foreignRPC, http.StatusForbidden, protocol.CodeForbidden)
	userAdmin := e.request(http.MethodGet, "/api/admin/computers", testOrigin, "", "rc_session="+userToken, "")
	decodeFailure(t, userAdmin, http.StatusForbidden, protocol.CodeForbidden)
	adminMe := e.request(http.MethodGet, "/api/me", testOrigin, "", "rc_session="+userToken+"; "+adminCookie, "")
	if got := jsonField(t, readBody(t, adminMe), "result", "role"); got != "admin" {
		t.Fatalf("admin precedence role = %q, want admin", got)
	}

	codes := e.request(http.MethodPost, "/api/admin/enrollment-codes", testOrigin, "application/json", adminCookie, `{}`)
	var codeResponse struct {
		OK     bool `json:"ok"`
		Result struct {
			Code      string `json:"code"`
			ExpiresAt string `json:"expiresAt"`
		} `json:"result"`
	}
	if err := json.NewDecoder(codes.Body).Decode(&codeResponse); err != nil {
		t.Fatal(err)
	}
	codes.Body.Close()
	if codes.StatusCode != http.StatusOK || !codeResponse.OK || len(codeResponse.Result.Code) != 24 {
		t.Fatalf("enrollment code response = %+v, status %d", codeResponse, codes.StatusCode)
	}
	clientID := "0f1c7a2e-9b64-4c5f-8f1a-2d3e4b5c6a70"
	enrollBody := fmt.Sprintf(`{"code":%q,"clientId":%q,"ownerName":"Work Laptop","clientName":"WORK-LAPTOP"}`, codeResponse.Result.Code, clientID)
	browserEnroll := e.request(http.MethodPost, "/api/desktop/enroll", testOrigin, "application/json", "", enrollBody)
	decodeFailure(t, browserEnroll, http.StatusForbidden, protocol.CodeOriginForbidden)
	enrolled := e.request(http.MethodPost, "/api/desktop/enroll", "", "application/json", "", enrollBody)
	var enrollment struct {
		OK     bool `json:"ok"`
		Result struct {
			ClientID    string `json:"clientId"`
			BridgeToken string `json:"bridgeToken"`
		} `json:"result"`
	}
	if err := json.NewDecoder(enrolled.Body).Decode(&enrollment); err != nil {
		t.Fatal(err)
	}
	enrolled.Body.Close()
	if enrolled.StatusCode != http.StatusOK || !enrollment.OK || enrollment.Result.ClientID != clientID || enrollment.Result.BridgeToken == "" {
		t.Fatalf("native enrollment = %+v, status %d", enrollment, enrolled.StatusCode)
	}
	usedAgain := e.request(http.MethodPost, "/api/desktop/enroll", "", "application/json", "",
		fmt.Sprintf(`{"code":%q,"clientId":%q,"ownerName":"Second","clientName":"SECOND"}`, codeResponse.Result.Code, foreign))
	decodeFailure(t, usedAgain, http.StatusUnauthorized, protocol.CodeInvalidCredentials)

	enrolledBridge, _, err := e.dial("Bearer "+enrollment.Result.BridgeToken, "")
	if err != nil {
		t.Fatalf("dial enrolled bridge: %v", err)
	}
	t.Cleanup(func() { _ = enrolledBridge.conn.CloseNow() })
	enrolledBridge.send(map[string]any{
		"type": "hello", "version": 1, "clientId": clientID, "ownerName": "Work Laptop",
		"clientName": "WORK-LAPTOP",
		"capabilities": map[string]any{
			"tools":      []string{"codex"},
			"toolStatus": map[string]any{"workbuddy": map[string]any{"available": false, "reason": "native adapter unavailable"}},
		},
	})
	if f := enrolledBridge.read(); f.Type != protocol.FrameHelloOK {
		t.Fatalf("enrolled bridge hello got %q", f.Type)
	}

	enrolledSeen := serveBridge(t, enrolledBridge, func(_ *testing.T, c *wsClient, f *protocol.Frame) {
		c.answer(f.ID, map[string]any{"accepted": true, "sessionId": "shared-session"})
	})
	rpcBody := fmt.Sprintf(`{"clientId":%q,"method":"session.send","params":{"tool":"workbuddy","sessionId":"shared-session","text":"UNIQUE_CHAT_SENTINEL"}}`, clientID)
	rpc := e.request(http.MethodPost, "/api/admin/rpc", testOrigin, "application/json", adminCookie, rpcBody)
	rpcBodyText := readBody(t, rpc)
	if rpc.StatusCode != http.StatusOK || !strings.Contains(rpcBodyText, `"ok":true`) {
		t.Fatalf("admin RPC status/body = %d %s", rpc.StatusCode, rpcBodyText)
	}
	if got := countMethod(waitForMethod(t, enrolledSeen, "session.send", 1), "session.send"); got != 1 {
		t.Fatalf("enrolled desktop received %d session.send calls", got)
	}
	if got := countMethod(bootstrapSeen.snapshot(), "session.send"); got != 0 {
		t.Fatalf("bootstrap desktop received %d foreign session.send calls", got)
	}

	computers := e.request(http.MethodGet, "/api/admin/computers", testOrigin, "", adminCookie, "")
	var roster struct {
		Result struct {
			Computers []struct {
				ClientID string `json:"clientId"`
				Online   bool   `json:"online"`
				Tools    []struct {
					ID        string `json:"id"`
					Available bool   `json:"available"`
					Reason    string `json:"reason"`
				} `json:"tools"`
			} `json:"computers"`
		} `json:"result"`
	}
	if err := json.NewDecoder(computers.Body).Decode(&roster); err != nil {
		t.Fatal(err)
	}
	computers.Body.Close()
	var laptop *struct {
		ClientID string `json:"clientId"`
		Online   bool   `json:"online"`
		Tools    []struct {
			ID        string `json:"id"`
			Available bool   `json:"available"`
			Reason    string `json:"reason"`
		} `json:"tools"`
	}
	for i := range roster.Result.Computers {
		if roster.Result.Computers[i].ClientID == clientID {
			laptop = &roster.Result.Computers[i]
		}
	}
	if laptop == nil || !laptop.Online {
		t.Fatalf("admin roster did not show the enrolled laptop online: %+v", roster.Result.Computers)
	}
	workbuddyFound := false
	for _, tool := range laptop.Tools {
		if tool.ID == "workbuddy" {
			workbuddyFound = true
			if tool.Available || tool.Reason != "native adapter unavailable" {
				t.Fatalf("WorkBuddy status = %+v; want explicit unavailable reason", tool)
			}
		}
	}
	if !workbuddyFound {
		t.Fatal("admin roster omitted WorkBuddy status")
	}

	dump := e.st.RawDumpForTest(t)
	for _, secret := range []string{testAdminPassword, codeResponse.Result.Code, enrollment.Result.BridgeToken, "UNIQUE_CHAT_SENTINEL"} {
		if strings.Contains(dump, secret) {
			t.Fatalf("database contains plaintext secret or chat text %q", secret)
		}
	}
	if !strings.Contains(dump, "admin.rpc") || !strings.Contains(dump, "target="+clientID+" method=session.send outcome=success") {
		t.Fatal("admin RPC metadata audit was not persisted")
	}
}

func TestAdminRPCTargetOfflineNeverFallsBackToAnotherOnlineComputer(t *testing.T) {
	e := newAdminEnv(t)
	_, adminToken := adminLogin(e, testAdminUsername, testAdminPassword)
	if adminToken == "" {
		t.Fatal("admin login returned no session")
	}
	active := e.helloBridge(protocol.Capabilities{Tools: []string{"codex"}})
	seen := serveBridge(t, active, func(_ *testing.T, c *wsClient, f *protocol.Frame) {
		c.answer(f.ID, map[string]any{"sessions": []any{}, "capabilities": map[string]any{"tools": []string{"codex"}}})
	})
	code := "ABCDEFGHJKMNPQRSTVWXYZ012"
	codeHash := store.HashToken(code)
	now := e.s.now()
	if err := e.st.InsertEnrollmentCode(codeHash, now, now.Add(10*time.Minute)); err != nil {
		t.Fatal(err)
	}
	target := "3f2504e0-4f89-41d3-9a0c-0305e82c3301"
	if outcome, err := e.st.EnrollComputer(codeHash, target, "Offline laptop", "OFFLINE-LAPTOP", store.HashToken("offline-token"), now); err != nil || outcome != store.EnrollmentOK {
		t.Fatalf("enroll offline target = %v %v", outcome, err)
	}
	request := fmt.Sprintf(`{"clientId":%q,"method":"sessions.list"}`, target)
	resp := e.request(http.MethodPost, "/api/admin/rpc", testOrigin, "application/json", adminCookieName+"="+adminToken, request)
	decodeFailure(t, resp, http.StatusServiceUnavailable, protocol.CodeTargetOffline)
	if len(seen.snapshot()) != 0 {
		t.Fatalf("offline-target RPC was sent to the other computer: %+v", seen.snapshot())
	}
}

func TestBootstrapAndEnrolledTokensCannotClaimDifferentIdentity(t *testing.T) {
	e := newEnv(t)
	_ = e.helloBridge(protocol.Capabilities{Tools: []string{"codex"}})
	pinned, err := e.st.BootstrapClientID()
	if err != nil || pinned == "" {
		t.Fatalf("bootstrap pin = %q, %v", pinned, err)
	}
	other := "3f2504e0-4f89-41d3-9a0c-0305e82c3301"
	bootstrapAttacker := e.mustDialBridge()
	bootstrapAttacker.send(map[string]any{
		"type": "hello", "version": 1, "clientId": other, "ownerName": "Attacker",
		"clientName": "OTHER", "capabilities": map[string]any{"tools": []string{"codex"}},
	})
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	_, _, readErr := bootstrapAttacker.conn.Read(ctx)
	cancel()
	if readErr == nil {
		t.Fatal("bootstrap credential established a second computer identity")
	}

	code, err := protocol.NewPairCode()
	if err != nil {
		t.Fatal(err)
	}
	normalized, _ := protocol.NormalizePairCode(code)
	now := e.s.now()
	if err := e.st.InsertEnrollmentCode(store.HashToken(normalized), now, now.Add(10*time.Minute)); err != nil {
		t.Fatal(err)
	}
	enrolledID := "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"
	bridgeToken, err := store.NewToken()
	if err != nil {
		t.Fatal(err)
	}
	if outcome, err := e.st.EnrollComputer(store.HashToken(normalized), enrolledID, "Enrolled", "ENROLLED", store.HashToken(bridgeToken), now); err != nil || outcome != store.EnrollmentOK {
		t.Fatalf("setup enrollment = %v %v", outcome, err)
	}
	enrolledAttacker, _, err := e.dial("Bearer "+bridgeToken, "")
	if err != nil {
		t.Fatalf("dial enrolled bridge: %v", err)
	}
	t.Cleanup(func() { _ = enrolledAttacker.conn.CloseNow() })
	enrolledAttacker.send(map[string]any{
		"type": "hello", "version": 1, "clientId": other, "ownerName": "Attacker",
		"clientName": "OTHER", "capabilities": map[string]any{"tools": []string{"codex"}},
	})
	ctx, cancel = context.WithTimeout(context.Background(), time.Second)
	_, _, readErr = enrolledAttacker.conn.Read(ctx)
	cancel()
	if readErr == nil {
		t.Fatal("per-computer token established a different computer identity")
	}
}
