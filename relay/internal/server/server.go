// Package server is the relay's HTTP and WebSocket surface. It owns routing,
// request hardening, sessions, forwarding and the two download/static route
// families, and it implements docs/design/api/protocol-v1.md.
package server

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"strings"
	"sync"
	"time"
	"unicode"

	"github.com/ai-remote/relay/internal/bridge"
	"github.com/ai-remote/relay/internal/config"
	"github.com/ai-remote/relay/internal/protocol"
	"github.com/ai-remote/relay/internal/store"
)

// sessionCookieName is the one cookie the relay sets (§5.2).
const sessionCookieName = "rc_session"

const adminCookieName = "rc_admin"

// sessionMaxAgeSeconds is §5.2's Max-Age: 30 days.
const sessionMaxAgeSeconds = 2592000

// Options configures a Server.
type Options struct {
	Config *config.Config
	Store  *store.Store
	Hub    *bridge.Hub
	Now    func() time.Time
	Logger *slog.Logger
}

// Server holds the relay's long-lived state.
type Server struct {
	cfg    *config.Config
	st     *store.Store
	hub    *bridge.Hub
	now    func() time.Time
	log    *slog.Logger
	limits *limiters

	adminMu       sync.Mutex
	adminSessions map[string]time.Time
	adminKDFSlots chan struct{}

	pairMu     sync.Mutex
	pairCreate map[*bridge.Conn]*counters
}

// New builds a server.
func New(opts Options) (*Server, error) {
	if opts.Config == nil || opts.Store == nil || opts.Hub == nil {
		return nil, errors.New("server: config, store and hub are required")
	}
	now := opts.Now
	if now == nil {
		now = time.Now
	}
	logger := opts.Logger
	if logger == nil {
		logger = slog.New(slog.NewTextHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelInfo}))
	}
	s := &Server{
		cfg:           opts.Config,
		st:            opts.Store,
		hub:           opts.Hub,
		now:           now,
		log:           logger,
		limits:        newLimiters(),
		pairCreate:    make(map[*bridge.Conn]*counters),
		adminSessions: make(map[string]time.Time),
		adminKDFSlots: make(chan struct{}, 2),
	}
	go s.sweepLoop()
	return s, nil
}

// sweepLoop is §7.2 rule 3's 60 second cleanup, plus the relay's own retention:
// expired pairing codes, the audit table's age and row caps, and the idle
// per-IP rate-limit buckets. It only reclaims; correctness never depends on it.
func (s *Server) sweepLoop() {
	ticker := time.NewTicker(60 * time.Second)
	defer ticker.Stop()
	for range ticker.C {
		now := s.now()
		if _, err := s.st.PurgePairCodes(now); err != nil {
			s.log.Warn("pair code sweep failed")
		}
		if _, err := s.st.PurgeEnrollmentCodes(now); err != nil {
			s.log.Warn("enrollment code sweep failed")
		}
		if _, err := s.st.PurgeAudit(now); err != nil {
			s.log.Warn("audit sweep failed")
		}
		s.limits.sweep(time.Now())
	}
}

// Handler returns the relay's routing table.
func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/health", s.handleHealth)
	mux.HandleFunc("/api/pair", s.handlePair)
	mux.HandleFunc("/api/rpc", s.handleRPC)
	mux.HandleFunc("/api/logout", s.handleLogout)
	mux.HandleFunc("/api/me", s.handleMe)
	mux.HandleFunc("/api/admin/login", s.handleAdminLogin)
	mux.HandleFunc("/api/admin/logout", s.handleAdminLogout)
	mux.HandleFunc("/api/admin/computers", s.handleAdminComputers)
	mux.HandleFunc("/api/admin/enrollment-codes", s.handleAdminEnrollmentCode)
	mux.HandleFunc("/api/admin/rpc", s.handleAdminRPC)
	mux.HandleFunc("/api/desktop/enroll", s.handleDesktopEnroll)
	mux.HandleFunc("/bridge", s.handleBridge)
	mux.HandleFunc("/downloads/", s.handleDownload)
	mux.HandleFunc("/downloads", s.handleDownload)
	mux.HandleFunc("/", s.handleIndex)
	return s.withBaselineHeaders(mux)
}

// withBaselineHeaders adds the response headers §5.2 requires on every reply and
// makes sure no CORS header can ever be produced (§3.3).
func (s *Server) withBaselineHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("Referrer-Policy", "no-referrer")
		if strings.HasPrefix(r.URL.Path, "/api/") {
			w.Header().Set("Cache-Control", "no-store")
			w.Header().Set("Vary", "Origin, Cookie")
		}

		// A traversal attempt must be a 404, not the mux's own 301/307
		// canonicalisation redirect. Go's ServeMux cleans the path before any
		// handler runs, so a request for /downloads/../relay.json would turn
		// into a redirect to /relay.json — a different route entirely. This
		// check runs on the raw request line, before that cleaning happens, and
		// is what lets §7.5 answer every traversal with one flat 404.
		if rawPathTraverses(r) {
			s.fail(w, protocol.CodeNotFound)
			return
		}
		next.ServeHTTP(w, r)
	})
}

// rawPathTraverses reports whether the raw request target contains a parent
// segment, decoded once so an encoded attempt is caught the same way.
func rawPathTraverses(r *http.Request) bool {
	raw := r.RequestURI
	if raw == "" {
		return false
	}
	decoded, err := decodePercentOnce(raw)
	if err != nil {
		return true // undecodable escapes are never served
	}
	for _, segment := range strings.FieldsFunc(decoded, func(c rune) bool { return c == '/' || c == '\\' }) {
		if segment == ".." {
			return true
		}
	}
	return strings.ContainsRune(decoded, 0)
}

// ---- small response helpers ------------------------------------------------

func (s *Server) writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	if err := json.NewEncoder(w).Encode(body); err != nil {
		s.log.Warn("write response failed")
	}
}

// fail answers with the one failure shape of §6.1 and the status its code pins.
func (s *Server) fail(w http.ResponseWriter, code protocol.Code) {
	s.writeJSON(w, code.HTTPStatus(), protocol.Failure(code))
}

// failWith answers with a specific safe message, still carrying a known code.
func (s *Server) failWith(w http.ResponseWriter, code protocol.Code, message string) {
	s.writeJSON(w, code.HTTPStatus(), protocol.FailureWith(code, message))
}

// methodNotAllowed answers 405 with the Allow header §5.5 requires.
func (s *Server) methodNotAllowed(w http.ResponseWriter, allow string) {
	w.Header().Set("Allow", allow)
	s.fail(w, protocol.CodeMethodNotAllowed)
}

// ---- request hardening -----------------------------------------------------

// clientIP implements §5.1's X-Forwarded-For trust rule: the header is believed
// only when the peer is loopback, because that is where Caddy sits.
func clientIP(r *http.Request) string {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		host = r.RemoteAddr
	}
	peer := net.ParseIP(host)
	if peer != nil && peer.IsLoopback() {
		if fwd := r.Header.Get("X-Forwarded-For"); fwd != "" {
			first, _, _ := strings.Cut(fwd, ",")
			if candidate := strings.TrimSpace(first); net.ParseIP(candidate) != nil {
				return candidate
			}
		}
	}
	return host
}

// guard runs the checks every /api/* request must survive, in a fixed order.
//
// The method check is an exact comparison, never a substring one: with
// `strings.Contains(allow, r.Method)` a request whose method is "P" or "OS"
// would satisfy a "POST" allowance, skip the 405 and slip past the
// Content-Type requirement that hangs off r.Method == POST.
func (s *Server) guard(w http.ResponseWriter, r *http.Request, allow []string, maxBody int64) bool {
	methodOK := false
	for _, m := range allow {
		if r.Method == m {
			methodOK = true
			break
		}
	}
	if !methodOK {
		s.methodNotAllowed(w, strings.Join(allow, ", "))
		return false
	}
	if !protocol.OriginAllowed(r.Header.Get("Origin"), s.cfg.AllowedOrigins) {
		s.fail(w, protocol.CodeOriginForbidden)
		return false
	}
	if r.Method == http.MethodPost {
		if ct := r.Header.Get("Content-Type"); !isJSONContentType(ct) {
			s.fail(w, protocol.CodeUnsupportedMediaType)
			return false
		}
	}
	if r.ContentLength > maxBody {
		s.fail(w, protocol.CodePayloadTooLarge)
		return false
	}
	// Per-IP concurrency, the same ceiling /bridge uses. Without this the only
	// limit on /api/* is the relay-wide 500 requests/second (§6.3).
	ip := clientIP(r)
	if !s.limits.enter(ip) {
		w.Header().Set("Retry-After", "5")
		s.fail(w, protocol.CodeRateLimited)
		return false
	}
	go func() {
		// The counter is released when the handler finishes writing. There is no
		// hook for that, so it is tied to the request context instead, which
		// net/http cancels once the response is complete.
		<-r.Context().Done()
		s.limits.leave(ip)
	}()
	return true
}

func isJSONContentType(ct string) bool {
	base, _, _ := strings.Cut(ct, ";")
	return strings.EqualFold(strings.TrimSpace(base), "application/json")
}

// readJSONBody decodes a JSON object with the endpoint's size ceiling applied
// twice: once from Content-Length in guard, once from a limited reader here,
// because a Content-Length header can lie (§5.4). It reports the code the
// caller must answer with: 413 when the body really is too large, 400 when the
// JSON is simply malformed.
func readJSONBody(w http.ResponseWriter, r *http.Request, maxBody int64, dst any) protocol.Code {
	limited := http.MaxBytesReader(w, r.Body, maxBody)
	if err := json.NewDecoder(limited).Decode(dst); err != nil {
		var tooLarge *http.MaxBytesError
		if errors.As(err, &tooLarge) {
			return protocol.CodePayloadTooLarge
		}
		return protocol.CodeInvalidJSON
	}
	return ""
}

// readEmptyJSONObject accepts exactly one JSON object with no members. It is
// used by read-only POST routes that need a browser-generated Origin while
// keeping the request body contract closed and bounded.
func readEmptyJSONObject(w http.ResponseWriter, r *http.Request, maxBody int64) protocol.Code {
	raw, err := io.ReadAll(http.MaxBytesReader(w, r.Body, maxBody))
	if err != nil {
		var tooLarge *http.MaxBytesError
		if errors.As(err, &tooLarge) {
			return protocol.CodePayloadTooLarge
		}
		return protocol.CodeInvalidJSON
	}
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(raw, &fields); err != nil || fields == nil || len(fields) != 0 {
		return protocol.CodeInvalidJSON
	}
	return ""
}

// ---- sessions --------------------------------------------------------------

// sessionFromRequest resolves the rc_session cookie to a live device.
func (s *Server) sessionFromRequest(r *http.Request) (*store.Device, string, bool) {
	cookie, err := r.Cookie(sessionCookieName)
	if err != nil || cookie.Value == "" {
		return nil, "", false
	}
	if !validSessionToken(cookie.Value) {
		return nil, "", false
	}
	hash := store.HashToken(cookie.Value)
	dev, err := s.st.DeviceByTokenHash(hash, s.now())
	if err != nil || dev == nil {
		return nil, "", false
	}
	return dev, hash, true
}

// validSessionToken checks §4.1's rc_session shape: 43 base64url characters.
func validSessionToken(v string) bool {
	if len(v) != 43 {
		return false
	}
	for _, r := range v {
		switch {
		case r >= 'A' && r <= 'Z', r >= 'a' && r <= 'z', r >= '0' && r <= '9', r == '-', r == '_':
		default:
			return false
		}
	}
	return true
}

func (s *Server) setSessionCookie(w http.ResponseWriter, token string) {
	http.SetCookie(w, &http.Cookie{
		Name:     sessionCookieName,
		Value:    token,
		Path:     "/",
		MaxAge:   sessionMaxAgeSeconds,
		HttpOnly: true,
		Secure:   !s.cfg.AllowInsecureCookie,
		SameSite: http.SameSiteStrictMode,
	})
}

func (s *Server) clearSessionCookie(w http.ResponseWriter) {
	http.SetCookie(w, &http.Cookie{
		Name:     sessionCookieName,
		Value:    "",
		Path:     "/",
		MaxAge:   -1,
		HttpOnly: true,
		Secure:   !s.cfg.AllowInsecureCookie,
		SameSite: http.SameSiteStrictMode,
	})
}

// ---- GET /health -----------------------------------------------------------

func (s *Server) handleHealth(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		s.methodNotAllowed(w, "GET, HEAD")
		return
	}
	if !s.limits.allow("health", clientIP(r)) {
		w.Header().Set("Retry-After", "5")
		s.fail(w, protocol.CodeRateLimited)
		return
	}
	// §7.1: this endpoint leaks nothing but liveness.
	s.writeJSON(w, http.StatusOK, map[string]any{
		"ok":           true,
		"bridgeOnline": s.hub.BridgeOnline(),
	})
}

// ---- POST /api/pair --------------------------------------------------------

type pairRequest struct {
	Code       string `json:"code"`
	DeviceName string `json:"deviceName"`
}

func (s *Server) handlePair(w http.ResponseWriter, r *http.Request) {
	if !s.guard(w, r, []string{http.MethodPost}, 4096) {
		return
	}
	if !s.limits.allow("pair", clientIP(r)) {
		w.Header().Set("Retry-After", "60")
		s.fail(w, protocol.CodeRateLimited)
		return
	}

	var body pairRequest
	if code := readJSONBody(w, r, 4096, &body); code != "" {
		s.fail(w, code)
		return
	}
	name := cleanDeviceName(body.DeviceName)
	if body.Code == "" || name == "" {
		s.fail(w, protocol.CodeInvalidRequest)
		return
	}

	normalized, ok := protocol.NormalizePairCode(body.Code)
	if !ok {
		s.failWith(w, protocol.CodeInvalidCredentials, "pairing code is not valid")
		return
	}
	hash := store.HashToken(normalized)
	now := s.now()

	outcome, codeID, clientID, err := s.st.ConsumePairCodeBound(hash, now)
	if err != nil {
		s.log.Error("pair consume failed")
		s.fail(w, protocol.CodeInternal)
		return
	}
	switch outcome {
	case store.PairCodeNotFound:
		s.fail(w, protocol.CodeNotFound)
		return
	case store.PairCodeExpired:
		_ = s.st.RecordPairCodeFailure(hash)
		s.failWith(w, protocol.CodeInvalidCredentials, "pairing code has expired")
		return
	case store.PairCodeAlreadyUsed:
		_ = s.st.RecordPairCodeFailure(hash)
		s.failWith(w, protocol.CodeInvalidCredentials, "pairing code already used")
		return
	case store.PairCodeTooManyAttempts:
		s.failWith(w, protocol.CodeInvalidCredentials, "pairing code is not valid")
		return
	}
	if clientID == "" {
		// New pairing codes are always computer-bound. A legacy unbound code can
		// only work after the bootstrap pin transaction has migrated it.
		s.fail(w, protocol.CodeInvalidCredentials)
		return
	}

	token, err := store.NewToken()
	if err != nil {
		s.log.Error("token generation failed")
		s.fail(w, protocol.CodeInternal)
		return
	}
	if _, err := s.st.CreateDeviceForClient(store.HashToken(token), name, clientID, now); err != nil {
		s.log.Error("device create failed")
		s.fail(w, protocol.CodeInternal)
		return
	}
	s.setSessionCookie(w, token)
	s.notifyPairUsed(clientID, codeID, name, now)
	_ = s.st.Audit("pair.success", "", "device paired", now)
	s.writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// cleanDeviceName applies §7.2's deviceName rules: trimmed, 1–64 characters,
// printable only.
func cleanDeviceName(raw string) string {
	var sb strings.Builder
	for _, r := range raw {
		if unicode.IsControl(r) {
			continue
		}
		sb.WriteRune(r)
	}
	name := strings.TrimSpace(sb.String())
	if name == "" || len([]rune(name)) > 64 {
		return ""
	}
	return name
}

// notifyPairUsed informs only the desktop identity that minted the consumed
// pairing code. If that computer is offline the event is dropped; it must never
// appear on another person's bridge.
func (s *Server) notifyPairUsed(clientID, codeID, deviceName string, at time.Time) {
	_ = s.hub.SendToComputer(clientID, map[string]any{
		"type":       "pair.used",
		"codeId":     codeID,
		"deviceName": deviceName,
		"at":         at.UTC().Format(time.RFC3339),
	})
}

// ---- POST /api/rpc ---------------------------------------------------------

type rpcRequest struct {
	Method         string          `json:"method"`
	Params         json.RawMessage `json:"params"`
	ClientID       string          `json:"clientId,omitempty"`
	TargetClientID string          `json:"targetClientId,omitempty"`
	// TimeoutMs is a top-level field of the request body. It is deliberately
	// not part of params: §7.3's whitelist is closed, and §11 step 14 shows an
	// in-params timeoutMs being refused as invalid_params.
	TimeoutMs int `json:"timeoutMs"`
}

func (s *Server) handleRPC(w http.ResponseWriter, r *http.Request) {
	if !s.guard(w, r, []string{http.MethodPost}, 16384) {
		return
	}
	if !s.limits.allow("rpc", clientIP(r)) {
		w.Header().Set("Retry-After", "5")
		s.fail(w, protocol.CodeRateLimited)
		return
	}
	if !s.limits.allowGlobalRPC() {
		w.Header().Set("Retry-After", "1")
		s.fail(w, protocol.CodeBridgeBusy)
		return
	}
	device, _, ok := s.sessionFromRequest(r)
	if !ok {
		s.fail(w, protocol.CodeUnauthenticated)
		return
	}

	var body rpcRequest
	if code := readJSONBody(w, r, 16384, &body); code != "" {
		s.fail(w, code)
		return
	}
	if body.Method == "" {
		s.fail(w, protocol.CodeInvalidRequest)
		return
	}
	for _, requested := range []string{body.ClientID, body.TargetClientID} {
		if requested != "" && requested != device.ClientID {
			s.fail(w, protocol.CodeForbidden)
			return
		}
	}
	if code, ok := protocol.ValidateParams(body.Method, body.Params); !ok {
		s.writeJSON(w, http.StatusOK, protocol.Failure(code))
		return
	}

	// §7.3: the phone may ask for a different budget, but it is clamped to
	// 1000–60000 ms and a missing value takes the method's default.
	timeout := time.Duration(protocol.ClampTimeoutMs(body.TimeoutMs, protocol.DefaultTimeoutMs(body.Method))) * time.Millisecond
	reply := s.hub.CallComputer(r.Context(), device.ClientID, body.Method, body.Params, timeout)
	s.answerRPC(w, reply)
}

func (s *Server) answerRPC(w http.ResponseWriter, reply bridge.Reply) {
	switch {
	case reply.Code == protocol.CodeBridgeOffline:
		w.Header().Set("Retry-After", "1")
		s.fail(w, protocol.CodeBridgeOffline)
	case reply.Code == protocol.CodeTargetOffline:
		w.Header().Set("Retry-After", "1")
		s.fail(w, protocol.CodeTargetOffline)
	case reply.Code == protocol.CodeBridgeBusy:
		w.Header().Set("Retry-After", "1")
		s.fail(w, protocol.CodeBridgeBusy)
	case reply.Code != "":
		// Timeouts, disconnects and unusable results keep their own codes.
		s.fail(w, reply.Code)
	case reply.Err != nil:
		message := protocol.SanitizeMessage(reply.Err.Message)
		if message == "" {
			message = reply.Err.Code.CanonicalMessage()
		}
		s.writeJSON(w, http.StatusOK, protocol.FailureWith(reply.Err.Code, message))
	default:
		s.writeJSON(w, http.StatusOK, map[string]any{"ok": true, "result": json.RawMessage(reply.Result)})
	}
}

// ---- POST /api/logout ------------------------------------------------------

type logoutRequest struct {
	TargetSessionID string `json:"targetSessionId"`
}

func (s *Server) handleLogout(w http.ResponseWriter, r *http.Request) {
	if !s.guard(w, r, []string{http.MethodPost}, 1024) {
		return
	}
	if !s.limits.allow("logout", clientIP(r)) {
		w.Header().Set("Retry-After", "60")
		s.fail(w, protocol.CodeRateLimited)
		return
	}
	_, ownHash, ok := s.sessionFromRequest(r)
	if !ok {
		s.fail(w, protocol.CodeUnauthenticated)
		return
	}

	// §7.4 allows a completely empty body, so an empty reader is not an error.
	var body logoutRequest
	if r.ContentLength > 0 {
		if code := readJSONBody(w, r, 1024, &body); code != "" {
			s.fail(w, code)
			return
		}
	}
	now := s.now()

	if body.TargetSessionID != "" {
		if !validSessionToken(body.TargetSessionID) {
			s.fail(w, protocol.CodeInvalidRequest)
			return
		}
		// CRD 0003: a valid cookie without a legitimate bridge bearer is
		// authenticated but not permitted — 403, never 401.
		if !s.validBridgeBearer(r) {
			_ = s.st.Audit("logout.forbidden", "", "revoke without bridge token", now)
			s.fail(w, protocol.CodeForbidden)
			return
		}
		targetHash := store.HashToken(body.TargetSessionID)
		// Revoking an already-dead session is a success: the endpoint is
		// idempotent (§7.4).
		_, _ = s.st.RevokeByTokenHash(targetHash)
		if targetHash == ownHash {
			s.clearSessionCookie(w)
		}
		_ = s.st.Audit("logout.revoke", "", "bridge-authorised revoke", now)
		s.writeJSON(w, http.StatusOK, map[string]any{"ok": true})
		return
	}

	_, _ = s.st.RevokeByTokenHash(ownHash)
	s.clearSessionCookie(w)
	_ = s.st.Audit("logout.self", "", "self logout", now)
	s.writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// validBridgeBearer compares the Authorization header to the bridge token in
// constant time, so a caller cannot learn the token byte by byte.
func (s *Server) validBridgeBearer(r *http.Request) bool {
	presented, ok := bearerToken(r)
	if !ok {
		return false
	}
	return constantTimeEqual(presented, s.cfg.BridgeToken)
}

func bearerToken(r *http.Request) (string, bool) {
	header := r.Header.Get("Authorization")
	scheme, value, found := strings.Cut(header, " ")
	if !found || !strings.EqualFold(scheme, "Bearer") {
		return "", false
	}
	value = strings.TrimSpace(value)
	if value == "" {
		return "", false
	}
	return value, true
}

// ---- static site: / and /assets/* -----------------------------------------

// assetExtensions is the positive list of what the site may serve. Anything
// else — a database, a log, a key — is not part of a web page.
var assetExtensions = map[string]bool{
	".html": true, ".js": true, ".mjs": true, ".css": true, ".map": true,
	".png": true, ".jpg": true, ".jpeg": true, ".gif": true, ".svg": true,
	".ico": true, ".webp": true, ".woff": true, ".woff2": true, ".ttf": true,
	".txt": true, ".webmanifest": true,
}

func (s *Server) handleIndex(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		s.methodNotAllowed(w, "GET, HEAD")
		return
	}
	// The site is whatever the configured web directory actually holds: the
	// delivered front end ships index.html plus css/ and js/, so the route
	// resolves any allow-listed file under that root rather than assuming one
	// fixed asset folder. Everything else — an unknown path, a database, a log
	// — is 404 and never a fallback into /downloads (R19 item 1).
	rel, ok := sitePath(r.URL.Path)
	if !ok {
		s.fail(w, protocol.CodeNotFound)
		return
	}
	s.serveSiteFile(w, r, rel)
}

// sitePath maps a request path onto a path inside the web directory.
func sitePath(requestPath string) (string, bool) {
	if requestPath == "/" {
		return "index.html", true
	}
	trimmed := strings.TrimPrefix(requestPath, "/")
	if trimmed == "" {
		return "", false
	}
	return safeRelativePath(trimmed)
}

// serveSiteFile serves one file from the configured web directory, or a clear
// 404 when that directory (or the file) is not there. R19 item 4: a missing
// relay/web is an ordinary absence, never a crash and never a fallback into the
// downloads whitelist.
func (s *Server) serveSiteFile(w http.ResponseWriter, r *http.Request, rel string) {
	if !assetExtensions[strings.ToLower(path.Ext(rel))] {
		s.fail(w, protocol.CodeNotFound)
		return
	}
	root := s.cfg.WebDir
	if root == "" {
		s.fail(w, protocol.CodeNotFound)
		return
	}
	full := path.Join(root, rel)
	if !withinRoot(root, full) {
		s.fail(w, protocol.CodeNotFound)
		return
	}
	if info, err := os.Stat(full); err != nil || info.IsDir() {
		s.fail(w, protocol.CodeNotFound)
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	http.ServeFile(w, r, full)
}

// safeRelativePath accepts one or more ordinary path segments and rejects every
// traversal attempt, encoded or not.
func safeRelativePath(raw string) (string, bool) {
	if raw == "" {
		return "", false
	}
	decoded, err := decodePercentOnce(raw)
	if err != nil {
		return "", false
	}
	decoded = strings.ReplaceAll(decoded, "\\", "/")
	if strings.Contains(decoded, "..") || strings.ContainsRune(decoded, 0) ||
		strings.Contains(decoded, ":") || strings.HasPrefix(decoded, "/") {
		return "", false
	}
	cleaned := path.Clean(decoded)
	if cleaned == "." || strings.HasPrefix(cleaned, "../") || cleaned != decoded {
		return "", false
	}
	return cleaned, true
}

// withinRoot reports whether full resolves to a path inside root. Both are made
// absolute first, so a relative WebDir cannot be confused by the working
// directory.
func withinRoot(root, full string) bool {
	absRoot, err := filepath.Abs(root)
	if err != nil {
		return false
	}
	absFull, err := filepath.Abs(full)
	if err != nil {
		return false
	}
	rel, err := filepath.Rel(absRoot, absFull)
	if err != nil {
		return false
	}
	return rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator))
}

// decodePercentOnce decodes a single layer of percent-encoding, so an encoded
// traversal reaches the same checks a literal one does.
func decodePercentOnce(raw string) (string, error) {
	if !strings.Contains(raw, "%") {
		return raw, nil
	}
	var sb strings.Builder
	for i := 0; i < len(raw); i++ {
		if raw[i] != '%' {
			sb.WriteByte(raw[i])
			continue
		}
		if i+2 >= len(raw) {
			return "", fmt.Errorf("truncated percent escape")
		}
		hi, err := hexVal(raw[i+1])
		if err != nil {
			return "", err
		}
		lo, err := hexVal(raw[i+2])
		if err != nil {
			return "", err
		}
		sb.WriteByte(hi<<4 | lo)
		i += 2
	}
	return sb.String(), nil
}

func hexVal(b byte) (byte, error) {
	switch {
	case b >= '0' && b <= '9':
		return b - '0', nil
	case b >= 'a' && b <= 'f':
		return b - 'a' + 10, nil
	case b >= 'A' && b <= 'F':
		return b - 'A' + 10, nil
	}
	return 0, fmt.Errorf("not a hex digit")
}
