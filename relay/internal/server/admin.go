package server

import (
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"time"

	"github.com/ai-remote/relay/internal/adminauth"
	"github.com/ai-remote/relay/internal/protocol"
	"github.com/ai-remote/relay/internal/store"
)

const (
	adminSessionLifetime  = 8 * time.Hour
	adminCookieMaxAgeSecs = int(adminSessionLifetime / time.Second)
	maxAdminSessions      = 256
)

type adminLoginRequest struct {
	Username string `json:"username"`
	Password string `json:"password"`
}

func (s *Server) handleAdminLogin(w http.ResponseWriter, r *http.Request) {
	if !s.guard(w, r, []string{http.MethodPost}, 8192) {
		return
	}
	// The expensive password KDF is never reached until the per-IP limiter has
	// accepted this attempt.
	if !s.limits.allow("admin_login", clientIP(r)) {
		w.Header().Set("Retry-After", "60")
		s.fail(w, protocol.CodeRateLimited)
		return
	}
	var body adminLoginRequest
	if code := readJSONBody(w, r, 8192, &body); code != "" {
		s.fail(w, code)
		return
	}
	if len(body.Username) > 128 || len(body.Password) > 4096 {
		s.fail(w, protocol.CodeInvalidCredentials)
		return
	}
	configured := s.cfg.Admin
	if configured == nil {
		s.fail(w, protocol.CodeInvalidCredentials)
		return
	}
	salt, saltErr := base64.StdEncoding.DecodeString(configured.PasswordSalt)
	want, hashErr := base64.StdEncoding.DecodeString(configured.PasswordHash)
	if saltErr != nil || hashErr != nil || len(salt) < 16 || len(want) != 32 {
		// Config.Load validates this before serving; this remains safe for a
		// manually constructed Config in tests or an embedding process.
		s.log.Error("admin password verifier is invalid")
		s.fail(w, protocol.CodeInternal)
		return
	}
	// Do not queue unbounded expensive KDF work. A full gate fails immediately
	// after the per-IP quota check above, even when attackers distribute IPs.
	select {
	case s.adminKDFSlots <- struct{}{}:
		defer func() { <-s.adminKDFSlots }()
	default:
		w.Header().Set("Retry-After", "1")
		s.fail(w, protocol.CodeRateLimited)
		return
	}
	derived, deriveErr := adminauth.Derive([]byte(body.Password), salt, adminauth.Iterations)
	if deriveErr != nil {
		s.log.Error("admin password derivation failed")
		s.fail(w, protocol.CodeInternal)
		return
	}
	gotUsername := sha256.Sum256([]byte(body.Username))
	wantUsername := sha256.Sum256([]byte(configured.Username))
	usernameOK := subtle.ConstantTimeCompare(gotUsername[:], wantUsername[:])
	passwordOK := subtle.ConstantTimeCompare(derived, want)
	clear(derived)
	if usernameOK&passwordOK != 1 {
		s.failWith(w, protocol.CodeInvalidCredentials, "invalid username or password")
		return
	}

	token, err := store.NewToken()
	if err != nil {
		s.fail(w, protocol.CodeInternal)
		return
	}
	now := s.now()
	hash := store.HashToken(token)
	s.adminMu.Lock()
	for existing, expires := range s.adminSessions {
		if !now.Before(expires) {
			delete(s.adminSessions, existing)
		}
	}
	if len(s.adminSessions) >= maxAdminSessions {
		s.adminMu.Unlock()
		w.Header().Set("Retry-After", "60")
		s.fail(w, protocol.CodeRateLimited)
		return
	}
	s.adminSessions[hash] = now.Add(adminSessionLifetime)
	s.adminMu.Unlock()
	s.setAdminCookie(w, token)
	s.writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

func (s *Server) setAdminCookie(w http.ResponseWriter, token string) {
	http.SetCookie(w, &http.Cookie{
		Name: adminCookieName, Value: token, Path: "/", MaxAge: adminCookieMaxAgeSecs,
		HttpOnly: true, Secure: !s.cfg.AllowInsecureCookie, SameSite: http.SameSiteStrictMode,
	})
}

func (s *Server) clearAdminCookie(w http.ResponseWriter) {
	http.SetCookie(w, &http.Cookie{
		Name: adminCookieName, Value: "", Path: "/", MaxAge: -1,
		HttpOnly: true, Secure: !s.cfg.AllowInsecureCookie, SameSite: http.SameSiteStrictMode,
	})
}

func (s *Server) adminUsername(r *http.Request) (string, bool) {
	if s.cfg.Admin == nil {
		return "", false
	}
	cookie, err := r.Cookie(adminCookieName)
	if err != nil || !validSessionToken(cookie.Value) {
		return "", false
	}
	hash := store.HashToken(cookie.Value)
	now := s.now()
	s.adminMu.Lock()
	expires, ok := s.adminSessions[hash]
	if ok && !now.Before(expires) {
		delete(s.adminSessions, hash)
		ok = false
	}
	s.adminMu.Unlock()
	if !ok {
		return "", false
	}
	return s.cfg.Admin.Username, true
}

func (s *Server) requireAdmin(w http.ResponseWriter, r *http.Request) (string, bool) {
	if username, ok := s.adminUsername(r); ok {
		return username, true
	}
	if _, _, userOK := s.sessionFromRequest(r); userOK {
		s.fail(w, protocol.CodeForbidden)
	} else {
		s.fail(w, protocol.CodeUnauthenticated)
	}
	return "", false
}

func (s *Server) handleAdminLogout(w http.ResponseWriter, r *http.Request) {
	if !s.guard(w, r, []string{http.MethodPost}, 1024) {
		return
	}
	if !s.limits.allow("admin_logout", clientIP(r)) {
		w.Header().Set("Retry-After", "60")
		s.fail(w, protocol.CodeRateLimited)
		return
	}
	if _, ok := s.requireAdmin(w, r); !ok {
		return
	}
	if cookie, err := r.Cookie(adminCookieName); err == nil && validSessionToken(cookie.Value) {
		s.adminMu.Lock()
		delete(s.adminSessions, store.HashToken(cookie.Value))
		s.adminMu.Unlock()
	}
	s.clearAdminCookie(w)
	s.writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

func (s *Server) handleMe(w http.ResponseWriter, r *http.Request) {
	maxBody := int64(0)
	if r.Method == http.MethodPost {
		maxBody = 1024
	}
	if !s.guard(w, r, []string{http.MethodGet, http.MethodPost}, maxBody) {
		return
	}
	if r.Method == http.MethodPost {
		if code := readEmptyJSONObject(w, r, 1024); code != "" {
			s.fail(w, code)
			return
		}
	}
	// A valid admin identity takes precedence if a browser has both cookies.
	if _, ok := s.adminUsername(r); ok {
		s.writeJSON(w, http.StatusOK, map[string]any{"ok": true, "result": map[string]any{"role": "admin"}})
		return
	}
	dev, _, ok := s.sessionFromRequest(r)
	if !ok {
		s.fail(w, protocol.CodeUnauthenticated)
		return
	}
	computer, err := s.st.DesktopByClientID(dev.ClientID)
	if err != nil {
		s.fail(w, protocol.CodeInternal)
		return
	}
	if computer == nil {
		s.writeJSON(w, http.StatusOK, map[string]any{"ok": true, "result": map[string]any{
			"role": "user", "clientId": dev.ClientID, "ownerName": "", "clientName": "", "online": false,
		}})
		return
	}
	s.writeJSON(w, http.StatusOK, map[string]any{"ok": true, "result": map[string]any{
		"role": "user", "clientId": computer.ClientID, "ownerName": computer.OwnerName,
		"clientName": computer.ClientName, "online": s.hub.ComputerOnline(computer.ClientID),
	}})
}

type computerTool struct {
	ID        string `json:"id"`
	Available bool   `json:"available"`
	Reason    string `json:"reason,omitempty"`
}

type computerView struct {
	ClientID     string         `json:"clientId"`
	OwnerName    string         `json:"ownerName"`
	ClientName   string         `json:"clientName"`
	Online       bool           `json:"online"`
	LastSeen     time.Time      `json:"lastSeen"`
	Capabilities map[string]any `json:"capabilities,omitempty"`
	Tools        []computerTool `json:"tools"`
}

func (s *Server) handleAdminComputers(w http.ResponseWriter, r *http.Request) {
	maxBody := int64(0)
	if r.Method == http.MethodPost {
		maxBody = 1024
	}
	if !s.guard(w, r, []string{http.MethodGet, http.MethodPost}, maxBody) {
		return
	}
	if r.Method == http.MethodPost {
		if code := readEmptyJSONObject(w, r, 1024); code != "" {
			s.fail(w, code)
			return
		}
	}
	if _, ok := s.requireAdmin(w, r); !ok {
		return
	}
	computers, err := s.st.ListComputers()
	if err != nil {
		s.fail(w, protocol.CodeInternal)
		return
	}
	result := make([]computerView, 0, len(computers))
	for _, computer := range computers {
		var caps protocol.Capabilities
		if err := json.Unmarshal(computer.Capabilities, &caps); err != nil {
			caps = protocol.Capabilities{}
		}
		declared := make(map[string]bool, len(caps.Tools))
		for _, id := range caps.Tools {
			declared[id] = true
		}
		tools := make([]computerTool, 0, 3)
		for _, id := range []string{"codex", "dsh", "workbuddy"} {
			tool := computerTool{ID: id, Available: declared[id]}
			if status, explicit := caps.ToolStatus[id]; explicit {
				tool.Available = status.Available
				tool.Reason = status.Reason
			} else if !tool.Available {
				tool.Reason = "not_declared"
			}
			tools = append(tools, tool)
		}
		result = append(result, computerView{
			ClientID: computer.ClientID, OwnerName: computer.OwnerName, ClientName: computer.ClientName,
			Online: s.hub.ComputerOnline(computer.ClientID), LastSeen: computer.LastSeen,
			Capabilities: map[string]any{"tools": caps.Tools, "toolStatus": caps.ToolStatus}, Tools: tools,
		})
	}
	s.writeJSON(w, http.StatusOK, map[string]any{"ok": true, "result": map[string]any{"computers": result}})
}

func (s *Server) handleAdminEnrollmentCode(w http.ResponseWriter, r *http.Request) {
	if !s.guard(w, r, []string{http.MethodPost}, 1024) {
		return
	}
	username, ok := s.requireAdmin(w, r)
	if !ok {
		return
	}
	if !s.limits.allow("admin_enrollment", clientIP(r)) {
		w.Header().Set("Retry-After", "60")
		s.fail(w, protocol.CodeRateLimited)
		return
	}
	var body map[string]json.RawMessage
	if code := readJSONBody(w, r, 1024, &body); code != "" {
		s.fail(w, code)
		return
	}
	if len(body) != 0 {
		s.fail(w, protocol.CodeInvalidRequest)
		return
	}
	rawCode, err := protocol.NewPairCode()
	if err != nil {
		s.fail(w, protocol.CodeInternal)
		return
	}
	code, valid := protocol.NormalizePairCode(rawCode)
	if !valid || len(code) != 24 {
		s.fail(w, protocol.CodeInternal)
		return
	}
	now := s.now()
	expires := now.Add(10 * time.Minute)
	if err := s.st.InsertEnrollmentCodeByActor(store.HashToken(code), username, now, expires); err != nil {
		s.fail(w, protocol.CodeInternal)
		return
	}
	_ = s.st.Audit("admin.enrollment_code.issue", username, "outcome=success", now)
	s.writeJSON(w, http.StatusOK, map[string]any{"ok": true, "result": map[string]any{
		"code": code, "expiresAt": expires.UTC().Format(time.RFC3339),
	}})
}

type adminRPCRequest struct {
	ClientID  string          `json:"clientId"`
	Method    string          `json:"method"`
	Params    json.RawMessage `json:"params"`
	TimeoutMs int             `json:"timeoutMs"`
}

func (s *Server) handleAdminRPC(w http.ResponseWriter, r *http.Request) {
	if !s.guard(w, r, []string{http.MethodPost}, 16384) {
		return
	}
	username, ok := s.requireAdmin(w, r)
	if !ok {
		return
	}
	var body adminRPCRequest
	if code := readJSONBody(w, r, 16384, &body); code != "" {
		s.auditAdminRPC(username, body.ClientID, body.Method, string(code))
		s.fail(w, code)
		return
	}
	if !s.limits.allow("admin_rpc", clientIP(r)) {
		s.auditAdminRPC(username, body.ClientID, safeAuditMethod(body.Method), string(protocol.CodeRateLimited))
		w.Header().Set("Retry-After", "60")
		s.fail(w, protocol.CodeRateLimited)
		return
	}
	if !s.limits.allowGlobalRPC() {
		s.auditAdminRPC(username, body.ClientID, safeAuditMethod(body.Method), string(protocol.CodeBridgeBusy))
		w.Header().Set("Retry-After", "1")
		s.fail(w, protocol.CodeBridgeBusy)
		return
	}
	method := body.Method
	if method == "" {
		s.auditAdminRPC(username, body.ClientID, "invalid", string(protocol.CodeInvalidRequest))
		s.fail(w, protocol.CodeInvalidRequest)
		return
	}
	if !protocol.IsCanonicalUUID(body.ClientID) {
		s.auditAdminRPC(username, "invalid", method, string(protocol.CodeInvalidRequest))
		s.fail(w, protocol.CodeInvalidRequest)
		return
	}
	if code, valid := protocol.ValidateParams(method, body.Params); !valid {
		s.auditAdminRPC(username, body.ClientID, safeAuditMethod(method), string(code))
		s.writeJSON(w, http.StatusOK, protocol.Failure(code))
		return
	}
	timeout := time.Duration(protocol.ClampTimeoutMs(body.TimeoutMs, protocol.DefaultTimeoutMs(method))) * time.Millisecond
	reply := s.hub.CallComputer(r.Context(), body.ClientID, method, body.Params, timeout)
	outcome := "success"
	if reply.Code != "" {
		outcome = string(reply.Code)
	} else if reply.Err != nil {
		outcome = string(reply.Err.Code)
	}
	s.auditAdminRPC(username, body.ClientID, method, outcome)
	s.answerRPC(w, reply)
}

func (s *Server) auditAdminRPC(actor, target, method, outcome string) {
	if !protocol.IsCanonicalUUID(target) {
		target = "invalid"
	}
	_ = s.st.Audit("admin.rpc", actor, fmt.Sprintf("target=%s method=%s outcome=%s", target, safeAuditMethod(method), safeAuditOutcome(outcome)), s.now())
}

func safeAuditMethod(method string) string {
	for _, allowed := range protocol.Methods {
		if method == allowed {
			return method
		}
	}
	return "invalid"
}

func safeAuditOutcome(outcome string) string {
	if outcome == "success" {
		return outcome
	}
	for _, code := range []protocol.Code{
		protocol.CodeInvalidRequest, protocol.CodeInvalidParams, protocol.CodeBridgeOffline,
		protocol.CodeTargetOffline, protocol.CodeBridgeBusy, protocol.CodeBridgeTimeout,
		protocol.CodeBridgeBadResponse, protocol.CodeInternal, protocol.CodeUnknownMethod,
		protocol.CodeSessionNotFound, protocol.CodeSessionGone, protocol.CodeNotCapable,
		protocol.CodeToolUnavailable, protocol.CodeBridgeError, protocol.CodeAnswerNotOpen,
		protocol.CodeApprovalUnknown,
	} {
		if outcome == string(code) {
			return outcome
		}
	}
	return "failed"
}
