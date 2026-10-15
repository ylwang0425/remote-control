package server

import (
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/ai-remote/relay/internal/protocol"
	"github.com/ai-remote/relay/internal/store"
)

// requireFleet authenticates a registered identity, never a caller-supplied
// name. A supplied Authorization header must succeed on its own; it cannot
// silently fall back to a browser cookie. The bootstrap token is accepted only
// after its first bridge hello has durably pinned it to a registered computer.
func (s *Server) requireFleet(w http.ResponseWriter, r *http.Request) (string, bool) {
	if !s.cfg.SharedTools {
		s.failWith(w, protocol.CodeForbidden, "shared AI tools are disabled on this server")
		return "", false
	}
	if values, supplied := r.Header["Authorization"]; supplied {
		if len(values) != 1 || !strings.HasPrefix(values[0], "Bearer ") {
			s.fail(w, protocol.CodeUnauthenticated)
			return "", false
		}
		token := strings.TrimPrefix(values[0], "Bearer ")
		if !validSessionToken(token) {
			s.fail(w, protocol.CodeUnauthenticated)
			return "", false
		}
		computer, err := s.st.DesktopByTokenHash(store.HashToken(token))
		if err != nil || computer == nil {
			s.fail(w, protocol.CodeUnauthenticated)
			return "", false
		}
		return "desktop:" + computer.ClientID, true
	}
	device, _, ok := s.sessionFromRequest(r)
	if ok {
		computer, err := s.st.DesktopByClientID(device.ClientID)
		if err == nil && computer != nil {
			return "device:" + device.ID + ":" + device.ClientID, true
		}
	}
	s.fail(w, protocol.CodeUnauthenticated)
	return "", false
}

func (s *Server) fleetGuard(w http.ResponseWriter, r *http.Request, maxBody int64) bool {
	if !s.guard(w, r, []string{http.MethodPost}, maxBody) {
		return false
	}
	// Inventory and RPC share a bounded bucket, including failed auth requests.
	if !s.limits.allow("fleet", clientIP(r)) {
		w.Header().Set("Retry-After", "5")
		s.fail(w, protocol.CodeRateLimited)
		return false
	}
	return true
}

func (s *Server) handleFleetComputers(w http.ResponseWriter, r *http.Request) {
	if !s.fleetGuard(w, r, 1024) {
		return
	}
	if _, ok := s.requireFleet(w, r); !ok {
		return
	}
	if code := readEmptyJSONObject(w, r, 1024); code != "" {
		s.fail(w, code)
		return
	}
	computers, err := s.computerViews()
	if err != nil {
		s.fail(w, protocol.CodeInternal)
		return
	}
	s.writeJSON(w, http.StatusOK, map[string]any{"ok": true, "result": map[string]any{"computers": computers}})
}

func (s *Server) handleFleetRPC(w http.ResponseWriter, r *http.Request) {
	if !s.fleetGuard(w, r, 16384) {
		return
	}
	actor, ok := s.requireFleet(w, r)
	if !ok {
		return
	}
	if !s.limits.allowGlobalRPC() {
		w.Header().Set("Retry-After", "1")
		s.fail(w, protocol.CodeBridgeBusy)
		return
	}
	var body adminRPCRequest
	if code := readJSONBody(w, r, 16384, &body); code != "" {
		s.fail(w, code)
		return
	}
	if !protocol.IsCanonicalUUID(body.ClientID) || body.Method == "" {
		s.fail(w, protocol.CodeInvalidRequest)
		return
	}
	if code, valid := protocol.ValidateParams(body.Method, body.Params); !valid {
		s.auditFleetRPC(actor, body.ClientID, body.Method, string(code))
		s.writeJSON(w, http.StatusOK, protocol.Failure(code))
		return
	}
	timeout := time.Duration(protocol.ClampTimeoutMs(body.TimeoutMs, protocol.DefaultTimeoutMs(body.Method))) * time.Millisecond
	reply := s.hub.CallComputer(r.Context(), body.ClientID, body.Method, body.Params, timeout)
	outcome := "success"
	if reply.Code != "" {
		outcome = string(reply.Code)
	} else if reply.Err != nil {
		outcome = string(reply.Err.Code)
	}
	s.auditFleetRPC(actor, body.ClientID, body.Method, outcome)
	s.answerRPC(w, reply)
}

func (s *Server) auditFleetRPC(actor, target, method, outcome string) {
	// Inputs here are server identities, a canonical UUID and closed enums.
	// Questions, messages, native approval contents and credentials stay local.
	_ = s.st.Audit("fleet.rpc", actor, fmt.Sprintf("target=%s method=%s outcome=%s", target, safeAuditMethod(method), safeAuditOutcome(outcome)), s.now())
}
