package server

import (
	"net/http"
	"strings"
	"unicode"

	"github.com/ai-remote/relay/internal/protocol"
	"github.com/ai-remote/relay/internal/store"
)

type desktopEnrollRequest struct {
	Code       string `json:"code"`
	ClientID   string `json:"clientId"`
	OwnerName  string `json:"ownerName"`
	ClientName string `json:"clientName"`
}

// handleDesktopEnroll is the native-only enrollment endpoint. A missing Origin
// is allowed for the native client; any browser Origin is refused, including
// this site's otherwise trusted origin.
func (s *Server) handleDesktopEnroll(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		s.methodNotAllowed(w, "POST")
		return
	}
	if r.Header.Get("Origin") != "" {
		s.fail(w, protocol.CodeOriginForbidden)
		return
	}
	if !isJSONContentType(r.Header.Get("Content-Type")) {
		s.fail(w, protocol.CodeUnsupportedMediaType)
		return
	}
	if r.ContentLength > 4096 {
		s.fail(w, protocol.CodePayloadTooLarge)
		return
	}
	ip := clientIP(r)
	if !s.limits.allow("enrollment", ip) {
		w.Header().Set("Retry-After", "60")
		s.fail(w, protocol.CodeRateLimited)
		return
	}
	if !s.limits.enter(ip) {
		w.Header().Set("Retry-After", "5")
		s.fail(w, protocol.CodeRateLimited)
		return
	}
	defer s.limits.leave(ip)

	var body desktopEnrollRequest
	if code := readJSONBody(w, r, 4096, &body); code != "" {
		s.fail(w, code)
		return
	}
	ownerName := strings.TrimSpace(body.OwnerName)
	if !protocol.IsCanonicalUUID(body.ClientID) || !printableName(ownerName, 64) || body.ClientName != "" && !protocol.IsHostnameLabel(body.ClientName) {
		s.fail(w, protocol.CodeInvalidRequest)
		return
	}
	code, ok := protocol.NormalizePairCode(body.Code)
	if !ok || len(code) != 24 {
		s.fail(w, protocol.CodeInvalidCredentials)
		return
	}
	bridgeToken, err := store.NewToken()
	if err != nil {
		s.fail(w, protocol.CodeInternal)
		return
	}
	now := s.now()
	outcome, actor, err := s.st.EnrollComputerWithActor(store.HashToken(code), body.ClientID, ownerName, body.ClientName, store.HashToken(bridgeToken), now)
	if err != nil {
		if err == store.ErrIdentityConflict {
			s.fail(w, protocol.CodeIdentityConflict)
			return
		}
		s.fail(w, protocol.CodeInternal)
		return
	}
	if outcome != store.EnrollmentOK {
		s.fail(w, protocol.CodeInvalidCredentials)
		return
	}
	if actor == "" {
		actor = "enrollment_code"
	}
	_ = s.st.Audit("admin.enrollment.complete", actor, "target="+body.ClientID+" outcome=success", now)
	s.writeJSON(w, http.StatusOK, map[string]any{"ok": true, "result": map[string]any{
		"clientId": body.ClientID, "bridgeToken": bridgeToken,
	}})
}

func printableName(value string, max int) bool {
	if value == "" || len([]rune(value)) > max {
		return false
	}
	for _, r := range value {
		if unicode.IsControl(r) {
			return false
		}
	}
	return true
}
