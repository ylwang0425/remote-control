// Package relayqa_test holds the independent QA cases for task T-relay.
//
// Traceability: every case here traces to a DoD item of
// docs/tasks/T-relay.md (R1-R19) and to a numbered case of the round's plan.
// The contract they are written against is
// docs/design/api/protocol-v1.md (v3), which the engineers may not change.
//
// These cases are deliberately black box: they build the real
// cmd/ai-remote-relay binary, start it with a real generated config, and talk
// to it over real HTTP and a real WebSocket. They never import the server
// package, so they cannot re-test what the engineer's unit tests already test
// in process: they test the artifact that ships.
//
// Layout note: the relay's qa folder must expose exactly one
// `qa/<task-id>/<case>/run.sh` at depth 3 for qa/run-all.sh to find it, so the
// cases are Go test functions selected by the runner scripts beside this file.
package relayqa_test

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/coder/websocket"
)

// ---------------------------------------------------------------------------
// flags: the runners pass -relay.bin and -relay.root, so no path is guessed.
// ---------------------------------------------------------------------------

// These are pointers on purpose. A package-level `var relayBin = flagString(...)`
// that returned a value would freeze the value read *before* flag.Parse ran, so
// the parsed value would land in a local that no longer exists and every case
// would run with an empty path. The pointer is the flag's own storage.
var (
	relayBin  = flag.String("relay.bin", "", "path to a built ai-remote-relay binary")
	relayRoot = flag.String("relay.root", "", "repository root (holds docs/, relay/, mobile/)")
)

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

// testOrigin is the one Origin the contract allows (§5.3).
const testOrigin = "https://101.43.98.18"

// FreePort asks the OS for a free loopback port. Releasing it and re-binding is
// racy in principle; on a machine where this whole suite runs sequentially it is
// the portable choice, and a lost race shows up as a loud startup failure.
func freePort(t *testing.T) int {
	t.Helper()
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("freePort: %v", err)
	}
	port := l.Addr().(*net.TCPAddr).Port
	if err := l.Close(); err != nil {
		t.Fatalf("freePort close: %v", err)
	}
	return port
}

type relayInstance struct {
	T       *testing.T
	URL     string
	Config  string
	Dir     string
	DBPath  string
	LogFile string
	Token   string
	Port    int
}

// InstanceOpts configures one throwaway relay process.
type InstanceOpts struct {
	ListenAddr   string // empty = 127.0.0.1 on a free port
	WebDir       string // empty = an empty directory (R19 item 4)
	WebDirGiven  bool   // true when WebDir was set on purpose, even to ""
	DownloadsDir string
	Token        string
	Init         bool
}

// requireHarness is the one guard every case goes through. A missing or wrong
// -relay.bin must be a red light, never a quiet pass: an empty path would make
// exec.Command start nothing, and "the command did not run" must not look like
// "the behaviour is correct".
func requireHarness(t *testing.T) {
	t.Helper()
	if *relayBin == "" {
		t.Fatalf("qa harness misconfigured: -relay.bin is empty. Run this case through\n" +
			"    bash qa/T-relay/run.sh\n" +
			"or hand it a binary, e.g.\n" +
			"    go test -count=1 -run '^TestCase04PairFlow$' -args '-relay.bin=<path to relay exe>' '-relay.root=<repo root>'")
	}
	if *relayRoot == "" {
		t.Fatalf("qa harness misconfigured: -relay.root is empty (needed for mobile/dist and relay/web)")
	}
	if info, err := os.Stat(*relayRoot); err != nil || !info.IsDir() {
		t.Fatalf("qa harness misconfigured: -relay.root %q is not a directory (%v)", *relayRoot, err)
	}
	info, err := os.Stat(*relayBin)
	if err != nil {
		t.Fatalf("qa harness misconfigured: -relay.bin %q does not exist: %v", *relayBin, err)
	}
	if info.IsDir() {
		t.Fatalf("qa harness misconfigured: -relay.bin %q is a directory", *relayBin)
	}
	if info.Size() == 0 {
		t.Fatalf("qa harness misconfigured: -relay.bin %q is empty", *relayBin)
	}
}

// NewRelay runs `ai-remote-relay --init` and then starts the server with the
// generated config, exactly as an operator would.
func NewRelay(t *testing.T, opts InstanceOpts) *relayInstance {
	t.Helper()
	requireHarness(t)
	bin := *relayBin
	dir := t.TempDir()
	dir = filepath.Clean(dir)

	port := 0
	listen := opts.ListenAddr
	if listen == "" {
		port = freePort(t)
		listen = fmt.Sprintf("127.0.0.1:%d", port)
	}

	cfgPath := filepath.Join(dir, "relay.json")
	runCmd(t, dir, bin, "--init", "--config", cfgPath)

	raw, err := os.ReadFile(cfgPath)
	if err != nil {
		t.Fatalf("read generated config: %v", err)
	}
	var cfg map[string]any
	if err := json.Unmarshal(raw, &cfg); err != nil {
		t.Fatalf("generated config is not JSON: %v", err)
	}
	cfg["listenAddr"] = listen
	webDir := filepath.Join(dir, "web")
	if opts.WebDirGiven {
		webDir = opts.WebDir
	} else if _, err := os.Stat(webDir); err != nil {
		if err := os.MkdirAll(webDir, 0o755); err != nil {
			t.Fatalf("mkdir web: %v", err)
		}
	}
	cfg["webDir"] = webDir
	if opts.DownloadsDir != "" {
		cfg["downloadsDir"] = opts.DownloadsDir
	}
	token, _ := cfg["bridgeToken"].(string)
	if opts.Token != "" {
		cfg["bridgeToken"] = opts.Token
		token = opts.Token
	}
	patch, err := json.MarshalIndent(cfg, "", "  ")
	if err != nil {
		t.Fatalf("marshal config: %v", err)
	}
	if err := os.WriteFile(cfgPath, append(patch, '\n'), 0o600); err != nil {
		t.Fatalf("write config: %v", err)
	}

	cmd := exec.Command(bin, "--config", cfgPath)
	cmd.Dir = dir
	var out syncBuffer
	cmd.Stdout = &out
	cmd.Stderr = &out
	if err := cmd.Start(); err != nil {
		t.Fatalf("start relay: %v", err)
	}
	exited := make(chan error, 1)
	go func() { exited <- cmd.Wait() }()
	t.Cleanup(func() {
		if cmd.Process != nil {
			_ = cmd.Process.Kill()
		}
		select {
		case <-exited:
		case <-time.After(10 * time.Second):
		}
	})

	inst := &relayInstance{
		T:       t,
		URL:     "http://" + listen,
		Config:  cfgPath,
		Dir:     dir,
		Token:   token,
		Port:    port,
		LogFile: stringField(cfg, "logFile"),
		DBPath:  stringField(cfg, "dbPath"),
	}

	deadline := time.Now().Add(30 * time.Second)
	client := &http.Client{Timeout: 2 * time.Second}
	for {
		resp, err := client.Get(inst.URL + "/health")
		if err == nil {
			_ = resp.Body.Close()
			break
		}
		select {
		case werr := <-exited:
			t.Fatalf("relay exited before it was ready: %v\noutput:\n%s", werr, out.String())
		default:
		}
		if time.Now().After(deadline) {
			t.Fatalf("relay did not answer /health within 30s on %s\noutput:\n%s", listen, out.String())
		}
		time.Sleep(50 * time.Millisecond)
	}
	return inst
}

type syncBuffer struct {
	mu  sync.Mutex
	buf bytes.Buffer
}

func (b *syncBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.Write(p)
}

func (b *syncBuffer) String() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.String()
}

func stringField(m map[string]any, key string) string {
	s, _ := m[key].(string)
	return s
}

func runCmd(t *testing.T, dir, bin string, args ...string) string {
	t.Helper()
	cmd := exec.Command(bin, args...)
	cmd.Dir = dir
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("%s %s failed: %v\n%s", bin, strings.Join(args, " "), err, out)
	}
	return string(out)
}

// runCmdOut runs a command and returns output plus the exit code instead of
// failing, for the cases that check a refusal.
func runCmdOut(dir, bin string, args ...string) (string, int) {
	cmd := exec.Command(bin, args...)
	cmd.Dir = dir
	out, err := cmd.CombinedOutput()
	if err == nil {
		return string(out), 0
	}
	var ee *exec.ExitError
	if errors.As(err, &ee) {
		return string(out), ee.ExitCode()
	}
	return string(out) + "\n" + err.Error(), -1
}

// ---- HTTP ------------------------------------------------------------------

type httpResult struct {
	Status int
	Header http.Header
	Body   []byte
}

type reqOpts struct {
	Origin      *string
	ContentType *string
	Cookie      string
	Bearer      string
	Method      string
}

// do sends one request. The origin pointer distinguishes "absent" from "empty".
func (r *relayInstance) do(method, path string, opts reqOpts, body []byte) httpResult {
	r.T.Helper()
	return doURL(r.T, method, r.URL+path, opts, body)
}

func doURL(t *testing.T, method, url string, opts reqOpts, body []byte) httpResult {
	t.Helper()
	var reader io.Reader
	if body != nil {
		reader = bytes.NewReader(body)
	}
	if opts.Method != "" {
		method = opts.Method
	}
	req, err := http.NewRequest(method, url, reader)
	if err != nil {
		t.Fatalf("NewRequest %s %s: %v", method, url, err)
	}
	if opts.Origin != nil {
		req.Header.Set("Origin", *opts.Origin)
	}
	if opts.ContentType != nil {
		req.Header.Set("Content-Type", *opts.ContentType)
	}
	if opts.Cookie != "" {
		req.Header.Set("Cookie", opts.Cookie)
	}
	if opts.Bearer != "" {
		req.Header.Set("Authorization", "Bearer "+opts.Bearer)
	}
	// Redirects are never followed: a QA case needs to see the first answer the
	// relay gives, and Go would otherwise turn a redirect on a POST into a GET.
	client := &http.Client{
		Timeout:       20 * time.Second,
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
	}
	resp, err := client.Do(req)
	if err != nil {
		t.Fatalf("%s %s: %v", method, url, err)
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatalf("read body: %v", err)
	}
	return httpResult{Status: resp.StatusCode, Header: resp.Header, Body: raw}
}

func strp(s string) *string { return &s }

// getJSON is the common shape for an authenticated /api call in the tests.
func (r *relayInstance) postAPI(path string, body []byte, cookie string) httpResult {
	r.T.Helper()
	return r.do(http.MethodPost, path, reqOpts{
		Origin:      strp(testOrigin),
		ContentType: strp("application/json"),
		Cookie:      cookie,
	}, body)
}

// reqBody builds a JSON object body and fails the test if it cannot.
func reqBody(t *testing.T, v any) []byte {
	t.Helper()
	raw, err := json.Marshal(v)
	if err != nil {
		t.Fatalf("marshal request: %v", err)
	}
	return raw
}

// ---- response decoding -----------------------------------------------------

type errBody struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

type respBody struct {
	OK    bool    `json:"ok"`
	Error errBody `json:"error"`
}

func decodeResp(t *testing.T, res httpResult) respBody {
	t.Helper()
	var out respBody
	if err := json.Unmarshal(res.Body, &out); err != nil {
		t.Fatalf("body is not JSON (%d): %s", res.Status, res.Body)
	}
	return out
}

// wantFailure asserts the §6.1 failure shape, the status and the exact code.
func wantFailure(t *testing.T, res httpResult, wantStatus int, wantCode string) {
	t.Helper()
	got := decodeResp(t, res)
	if res.Status != wantStatus {
		t.Fatalf("status = %d, want %d; body %s", res.Status, wantStatus, res.Body)
	}
	if got.OK {
		t.Fatalf("failure body carries ok:true: %s", res.Body)
	}
	if got.Error.Code != wantCode {
		t.Fatalf("error.code = %q, want %q; body %s", got.Error.Code, wantCode, res.Body)
	}
	if got.Error.Message == "" {
		t.Fatalf("error.message is empty: %s", res.Body)
	}
	if len([]rune(got.Error.Message)) > 120 {
		t.Fatalf("error.message is longer than 120 characters: %q", got.Error.Message)
	}
	// R4: no response may advertise CORS, and no failure may leak internals.
	assertNoCORS(t, res)
	assertNoLeak(t, res.Body, "error body")
}

// apiFailure is wantFailure for callers that have not already failed.
func apiFailure(t *testing.T, res httpResult) (int, respBody) {
	t.Helper()
	var out respBody
	if err := json.Unmarshal(res.Body, &out); err != nil {
		t.Fatalf("body is not JSON (%d): %s", res.Status, res.Body)
	}
	return res.Status, out
}

// wantNotFound is the §7.5 shape: every download refusal is the same 404.
func wantNotFound(t *testing.T, res httpResult) {
	t.Helper()
	if res.Status != 404 {
		t.Fatalf("status = %d, want 404; body %s", res.Status, res.Body)
	}
	got := decodeResp(t, res)
	if got.OK {
		t.Fatalf("404 body carries ok:true: %s", res.Body)
	}
	if got.Error.Code != "not_found" {
		t.Fatalf("error.code = %q, want not_found; body %s", got.Error.Code, res.Body)
	}
}

// assertNoCORS is §3.3 and §5.2: the header must never appear, on anything.
func assertNoCORS(t *testing.T, res httpResult) {
	t.Helper()
	for name, values := range res.Header {
		if strings.EqualFold(name, "Access-Control-Allow-Origin") ||
			strings.EqualFold(name, "Access-Control-Allow-Credentials") ||
			strings.EqualFold(name, "Access-Control-Allow-Methods") ||
			strings.EqualFold(name, "Access-Control-Allow-Headers") {
			t.Fatalf("CORS header %s: %v must never be sent", name, values)
		}
	}
}

// assertNoLeak is §6.1 and §3.9: no stack, no path, no SQL, no credential.
func assertNoLeak(t *testing.T, body []byte, what string) {
	t.Helper()
	low := strings.ToLower(string(body))
	for _, needle := range []string{
		".go:", "goroutine ", "sqlite", "select *", "stack", "runtime error",
		"c:\\", "d:\\", "/var/lib/", "/opt/ai-remote", "token=", "password",
	} {
		if strings.Contains(low, strings.ToLower(needle)) {
			t.Fatalf("%s leaks %q: %s", what, needle, body)
		}
	}
}

// cookieFromResponse returns the raw Set-Cookie line for rc_session.
func cookieFromResponse(t *testing.T, res httpResult) (raw string, value string) {
	t.Helper()
	for _, line := range res.Header.Values("Set-Cookie") {
		if strings.HasPrefix(strings.ToLower(strings.TrimSpace(line)), "rc_session=") {
			raw = strings.TrimSpace(line)
			rest := line[len("rc_session="):]
			if i := strings.IndexByte(rest, ';'); i >= 0 {
				value = rest[:i]
			} else {
				value = rest
			}
			return raw, value
		}
	}
	t.Fatalf("response carried no rc_session Set-Cookie; headers %v; body %s", res.Header, res.Body)
	return "", ""
}

// hasCookieAttr reports whether a Set-Cookie line carries one flag.
func hasCookieAttr(raw, attr string) bool {
	for _, part := range strings.Split(raw, ";") {
		if strings.EqualFold(strings.TrimSpace(part), attr) {
			return true
		}
	}
	return false
}

// cookieAttributes returns a Set-Cookie line's attributes with the cookie value
// removed. The value is a live credential, so it must never reach a log or a
// report — only its attributes are evidence.
func cookieAttributes(raw string) string {
	parts := strings.Split(raw, ";")
	if len(parts) == 0 {
		return "(empty)"
	}
	out := []string{"rc_session=<redacted>"}
	for _, part := range parts[1:] {
		out = append(out, strings.TrimSpace(part))
	}
	return strings.Join(out, "; ")
}

// ---- the bridge (a real desktop, over a real WebSocket) --------------------

type bridge struct {
	T     *testing.T
	Conn  *websocket.Conn
	Notes *notesLog
}

// notesLog records the raw text of every frame the QA desktop received, so a
// case can prove a secret never travelled over the bridge.
type notesLog struct {
	mu   sync.Mutex
	text []string
}

func (n *notesLog) add(raw string) {
	n.mu.Lock()
	defer n.mu.Unlock()
	n.text = append(n.text, raw)
}

func (n *notesLog) snapshot() []string {
	n.mu.Lock()
	defer n.mu.Unlock()
	return append([]string(nil), n.text...)
}

// dialRaw opens /bridge and keeps the rejection status, which the refusal cases
// need. websocket.Dial closes the body on failure, so the status is read first.
//
// The dial context deliberately outlives this function. coder/websocket ties the
// connection to the context it was dialled with, so the usual
// `defer cancel()` would close a perfectly healthy bridge a few seconds into a
// case and every later frame would fail with "use of closed network connection".
// The deadline is dropped with context.WithoutCancel and the socket is closed by
// the caller's t.Cleanup instead.
func dialRaw(t *testing.T, wsURL string, headers http.Header) (*websocket.Conn, *http.Response, error) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	conn, resp, err := websocket.Dial(context.WithoutCancel(ctx), wsURL, &websocket.DialOptions{HTTPHeader: headers})
	cancel()
	if conn != nil {
		conn.SetReadLimit(1 << 20)
	}
	return conn, resp, err
}

// dialBridge connects with the bridge bearer and no Origin, as §8.1 requires.
func (r *relayInstance) dialBridge() *bridge {
	r.T.Helper()
	return r.dialBridgeNotes(nil)
}

// dialNotes dials a bridge that records every frame it receives, so a case can
// prove a secret never travelled over the bridge.
func (r *relayInstance) dialNotes() *bridge {
	r.T.Helper()
	return r.dialBridgeNotes(&notesLog{})
}

func (r *relayInstance) dialBridgeNotes(notes *notesLog) *bridge {
	r.T.Helper()
	h := http.Header{}
	h.Set("Authorization", "Bearer "+r.Token)
	conn, resp, err := dialRaw(r.T, "ws"+strings.TrimPrefix(r.URL, "http")+"/bridge", h)
	if err != nil {
		status := 0
		if resp != nil {
			status = resp.StatusCode
		}
		r.T.Fatalf("dial /bridge: %v (status %d)", err, status)
	}
	r.T.Cleanup(func() { _ = conn.CloseNow() })
	return &bridge{T: r.T, Conn: conn, Notes: notes}
}

// helloBridge dials and completes the §8.4.1 handshake.
func (r *relayInstance) helloBridge() *bridge {
	r.T.Helper()
	b := r.dialBridge()
	b.Send(map[string]any{
		"type": "hello", "version": 1, "clientName": "QA-DESKTOP",
		"capabilities": map[string]any{
			"sessions.list": true, "session.read": true,
			"session.send": true, "session.stop": true,
			"stop:codex": false, "stop:dsh": true, "tools": []string{"codex", "dsh"},
		},
	})
	f := b.Read()
	if f.Str("type") != "hello.ok" {
		r.T.Fatalf("after hello got frame %s, want hello.ok", f.Raw)
	}
	return b
}

func (b *bridge) Send(v any) {
	b.T.Helper()
	raw, err := json.Marshal(v)
	if err != nil {
		b.T.Fatalf("marshal frame: %v", err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := b.Conn.Write(ctx, websocket.MessageText, raw); err != nil {
		b.T.Fatalf("write frame: %v", err)
	}
}

// Read returns the next frame and appends its raw text to the note list, which
// is what the "no secrets in the bridge traffic" assertions read.
func (b *bridge) Read() *frame {
	b.T.Helper()
	f, ok := b.readWithin(10 * time.Second)
	if !ok {
		b.T.Fatalf("no frame arrived within 10s")
	}
	return f
}

func (b *bridge) readWithin(d time.Duration) (*frame, bool) {
	ctx, cancel := context.WithTimeout(context.Background(), d)
	defer cancel()
	_, data, err := b.Conn.Read(ctx)
	if err != nil {
		return nil, false
	}
	if b.Notes != nil {
		b.Notes.add(string(data))
	}
	f, err := parseFrame(data)
	if err != nil {
		b.T.Fatalf("frame is not JSON: %s", data)
	}
	return f, true
}

// readType skips frames that are not the one being waited for (the relay's own
// 20 second ping, a leftover pair.used) and answers pings so the connection
// stays alive.
func (b *bridge) readType(want string, within time.Duration) (*frame, bool) {
	deadline := time.Now().Add(within)
	for time.Now().Before(deadline) {
		f, ok := b.readWithin(time.Until(deadline))
		if !ok {
			return nil, false
		}
		switch f.Str("type") {
		case want:
			return f, true
		case "ping":
			b.Send(map[string]any{"type": "pong"})
		}
	}
	return nil, false
}

func (b *bridge) mustReadType(want string, within time.Duration) *frame {
	b.T.Helper()
	f, ok := b.readType(want, within)
	if !ok {
		b.T.Fatalf("no %q frame within %s", want, within)
	}
	return f
}

// pair asks for a pairing code and returns the whole pair.created frame plus
// the id the desktop chose.
func (b *bridge) pair(id string) (*frame, string) {
	b.T.Helper()
	b.Send(map[string]any{"type": "pair.create", "id": id})
	f := b.mustReadType("pair.created", 10*time.Second)
	return f, id
}

// Serve waits for the next request frame and answers it successfully.
//
// It reads on the caller's goroutine on purpose. Two goroutines reading one
// *websocket.Conn race for the same frame, and a frame that lands in the wrong
// reader looks exactly like a product that never sent it.
//
// It must therefore be started BEFORE the HTTP call that triggers the request:
// the relay only writes a request frame once a phone call is waiting for it.
// Use ServeAsync for that, which is the shape every case here needs.
func (b *bridge) Serve(result map[string]any, within time.Duration) *frame {
	b.T.Helper()
	f := b.mustReadType("request", within)
	b.Send(map[string]any{"type": "response", "id": f.Str("id"), "ok": true, "result": result})
	return f
}

// ServeAsync is Serve for a caller that is about to make an HTTP call the
// relay has to answer. The work happens in a goroutine because the relay only
// sends the request frame after the phone's call is in flight; Wait must be
// called before the test ends so a failure is never swallowed.
func (b *bridge) ServeAsync(result map[string]any, within time.Duration) *callWaiter {
	return b.serveAsync(map[string]any{"type": "response", "ok": true, "result": result}, within)
}

// ServeErrorAsync answers the next request with a business failure.
func (b *bridge) ServeErrorAsync(code, message string, within time.Duration) *callWaiter {
	return b.serveAsync(map[string]any{
		"type": "response", "ok": false,
		"error": map[string]any{"code": code, "message": message},
	}, within)
}

type callWaiter struct {
	done  chan struct{}
	frame *frame
	ok    bool
	t     *testing.T
	name  string
}

func (b *bridge) serveAsync(template map[string]any, within time.Duration) *callWaiter {
	w := &callWaiter{done: make(chan struct{}), t: b.T, name: "request"}
	go func() {
		defer close(w.done)
		f, ok := b.readType("request", within)
		if !ok {
			return
		}
		w.frame = f
		w.ok = true
		reply := map[string]any{"id": f.Str("id")}
		for k, v := range template {
			reply[k] = v
		}
		b.Send(reply)
	}()
	return w
}

// Wait blocks until the goroutine finished and fails the case if it never saw
// the request frame.
func (w *callWaiter) Wait() *frame {
	w.t.Helper()
	select {
	case <-w.done:
	case <-time.After(20 * time.Second):
		w.t.Fatalf("the bridge reader goroutine never finished")
	}
	if !w.ok {
		w.t.Fatalf("the relay never sent a request frame to the bridge")
	}
	return w.frame
}

// ReadType exposes the frame-skipping read to the cases.
func (b *bridge) ReadType(want string, within time.Duration) (*frame, bool) {
	b.T.Helper()
	return b.readType(want, within)
}

// ReadTypeNow reads for the wanted frame and returns (nil, false) instead of
// failing, so a case can render what it did see. Unlike ReadType it does not
// treat a missing frame as fatal.
func (b *bridge) ReadTypeNow(want string, within time.Duration) (*frame, bool) {
	return b.readType(want, within)
}

// MustReadType is ReadType with a failure instead of a boolean.
func (b *bridge) MustReadType(want string, within time.Duration) *frame {
	b.T.Helper()
	return b.mustReadType(want, within)
}

// ReadAll drains whatever is already waiting for up to within and returns the
// frames. It is what a "this frame never arrived" failure should print, so the
// next reader sees what did arrive instead of guessing.
func (b *bridge) ReadAll(within time.Duration, limit int) []*frame {
	b.T.Helper()
	var out []*frame
	deadline := time.Now().Add(within)
	for len(out) < limit && time.Now().Before(deadline) {
		f, ok := b.readWithin(time.Until(deadline))
		if !ok {
			break
		}
		out = append(out, f)
	}
	return out
}

func frameSummary(frames []*frame) string {
	if len(frames) == 0 {
		return "(nothing)"
	}
	var sb strings.Builder
	for _, f := range frames {
		raw := string(f.Raw)
		if len(raw) > 200 {
			raw = raw[:200] + "..."
		}
		sb.WriteString("\n  " + raw)
	}
	return sb.String()
}

// ---- frames ----------------------------------------------------------------

type frame struct {
	Raw  json.RawMessage
	Obj  map[string]json.RawMessage
	Type string
}

func parseFrame(raw []byte) (*frame, error) {
	var obj map[string]json.RawMessage
	if err := json.Unmarshal(raw, &obj); err != nil {
		return nil, err
	}
	f := &frame{Raw: raw, Obj: obj}
	if t, ok := obj["type"]; ok {
		var s string
		if err := json.Unmarshal(t, &s); err == nil {
			f.Type = s
		}
	}
	return f, nil
}

func (f *frame) Str(key string) string {
	raw, ok := f.Obj[key]
	if !ok {
		return ""
	}
	var s string
	if err := json.Unmarshal(raw, &s); err != nil {
		return ""
	}
	return s
}

func (f *frame) Num(key string) (float64, bool) {
	raw, ok := f.Obj[key]
	if !ok {
		return 0, false
	}
	var n float64
	if err := json.Unmarshal(raw, &n); err != nil {
		return 0, false
	}
	return n, true
}

func (f *frame) Has(key string) bool { _, ok := f.Obj[key]; return ok }

// Keys returns the top-level field names, so a case can prove a frame carries
// nothing beyond the contract.
func (f *frame) Keys() []string {
	out := make([]string, 0, len(f.Obj))
	for k := range f.Obj {
		out = append(out, k)
	}
	return out
}

// ---- pairing through HTTP --------------------------------------------------

type pairResult struct {
	Res      httpResult
	Cookie   string
	RawValue string
}

// pairDevice is the real flow: prefix the code with the part of it a phone
// would type, post it, and keep the cookie.
func (r *relayInstance) pairDevice(code, deviceName string) pairResult {
	r.T.Helper()
	body := reqBody(r.T, map[string]any{"code": code, "deviceName": deviceName})
	res := r.do(http.MethodPost, "/api/pair", reqOpts{
		Origin:      strp(testOrigin),
		ContentType: strp("application/json"),
	}, body)
	got := decodeResp(r.T, res)
	if res.Status != 200 || !got.OK {
		r.T.Fatalf("pair failed: status %d body %s", res.Status, res.Body)
	}
	_, value := cookieFromResponse(r.T, res)
	return pairResult{Res: res, Cookie: "rc_session=" + value, RawValue: value}
}

// rpc is one POST /api/rpc with a session cookie.
func (r *relayInstance) rpc(cookie string, payload map[string]any) httpResult {
	r.T.Helper()
	return r.postAPI("/api/rpc", reqBody(r.T, payload), cookie)
}

// rpcBusiness asserts the §6.1 "HTTP 200, business failure" shape of §7.3 and
// returns the failure body.
func (r *relayInstance) rpcBusiness(cookie string, payload map[string]any, wantCode string) respBody {
	r.T.Helper()
	res := r.rpc(cookie, payload)
	return r.wantRPCBusiness(res, wantCode)
}

func (r *relayInstance) wantRPCBusiness(res httpResult, wantCode string) respBody {
	r.T.Helper()
	if res.Status != 200 {
		r.T.Fatalf("business failure status = %d, want 200 (§6.1); body %s", res.Status, res.Body)
	}
	got := decodeResp(r.T, res)
	if got.OK {
		r.T.Fatalf("expected a business failure, got ok:true: %s", res.Body)
	}
	if got.Error.Code != wantCode {
		r.T.Fatalf("error.code = %q, want %q; body %s", got.Error.Code, wantCode, res.Body)
	}
	if got.Error.Message == "" {
		r.T.Fatalf("error.message is empty: %s", res.Body)
	}
	apiNoStore(r.T, res)
	return got
}

// rpcOK asserts a 200 / ok:true RPC and returns the raw result object.
func (r *relayInstance) rpcOK(cookie string, payload map[string]any) json.RawMessage {
	r.T.Helper()
	res := r.rpc(cookie, payload)
	got := decodeResp(r.T, res)
	if res.Status != 200 || !got.OK {
		r.T.Fatalf("rpc failed: status %d body %s", res.Status, res.Body)
	}
	var envelope struct {
		Result json.RawMessage `json:"result"`
	}
	if err := json.Unmarshal(res.Body, &envelope); err != nil {
		r.T.Fatalf("rpc body is not JSON: %s", res.Body)
	}
	if len(envelope.Result) == 0 {
		r.T.Fatalf("rpc ok:true carried no result: %s", res.Body)
	}
	return envelope.Result
}

// freshInstance starts another relay in the same case, which resets the
// in-memory rate-limit buckets (§6.3: they are per process). It is what a case
// uses before deliberately spending a whole bucket, so the budget it needs does
// not eat another assertion's.
func freshInstance(t *testing.T, opts InstanceOpts) *relayInstance {
	t.Helper()
	return NewRelay(t, opts)
}

// newUUID returns a random v4 uuid in the shape §4.1 requires, so a case never
// has to force one id onto every request.
func newUUID(t *testing.T) string {
	t.Helper()
	buf := make([]byte, 16)
	if _, err := rand.Read(buf); err != nil {
		t.Fatalf("rand: %v", err)
	}
	buf[6] = (buf[6] & 0x0f) | 0x40
	buf[8] = (buf[8] & 0x3f) | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", buf[0:4], buf[4:6], buf[6:8], buf[8:10], buf[10:16])
}

// ---- misc ------------------------------------------------------------------

// apiNoStore is §5.2 for every /api/* response.
func apiNoStore(t *testing.T, res httpResult) {
	t.Helper()
	if got := res.Header.Get("Content-Type"); !strings.HasPrefix(got, "application/json") {
		t.Fatalf("Content-Type = %q, want application/json; charset=utf-8", got)
	}
	if got := res.Header.Get("Cache-Control"); got != "no-store" {
		t.Fatalf("Cache-Control = %q, want no-store", got)
	}
	if got := res.Header.Get("X-Content-Type-Options"); got != "nosniff" {
		t.Fatalf("X-Content-Type-Options = %q, want nosniff", got)
	}
	if got := res.Header.Get("Referrer-Policy"); got != "no-referrer" {
		t.Fatalf("Referrer-Policy = %q, want no-referrer", got)
	}
	if got := res.Header.Get("Vary"); !strings.Contains(got, "Origin") || !strings.Contains(got, "Cookie") {
		t.Fatalf("Vary = %q, want it to name Origin and Cookie", got)
	}
	assertNoCORS(t, res)
}

// uuidV4 is §4.1's shape for every id on the wire.
func uuidV4(t *testing.T, s, what string) {
	t.Helper()
	if len(s) != 36 {
		t.Fatalf("%s = %q, want 36 characters", what, s)
	}
	for i, r := range s {
		switch i {
		case 8, 13, 18, 23:
			if r != '-' {
				t.Fatalf("%s = %q: position %d is %q, want '-'", what, s, i, r)
			}
		case 14:
			if r != '4' {
				t.Fatalf("%s = %q: position 14 is %q, want '4' (v4)", what, s, r)
			}
		case 19:
			if r != '8' && r != '9' && r != 'a' && r != 'b' {
				t.Fatalf("%s = %q: position 19 is %q, want one of 8/9/a/b", what, s, r)
			}
		default:
			if !((r >= '0' && r <= '9') || (r >= 'a' && r <= 'f')) {
				t.Fatalf("%s = %q: position %d is %q, want lowercase hex", what, s, i, r)
			}
		}
	}
}

// rfc3339UTC is §4.2: Z suffix, never a local offset.
func rfc3339UTC(t *testing.T, s, what string) time.Time {
	t.Helper()
	if !strings.HasSuffix(s, "Z") {
		t.Fatalf("%s = %q, want it to end in Z (UTC)", what, s)
	}
	parsed, err := time.Parse(time.RFC3339, s)
	if err != nil {
		t.Fatalf("%s = %q is not RFC3339: %v", what, s, err)
	}
	return parsed.UTC()
}

// sameSecond reports whether two instants are within one second, the
// granularity §4.2 allows on output.
func sameSecond(a, b time.Time) bool {
	d := a.Sub(b)
	if d < 0 {
		d = -d
	}
	return d <= 1100*time.Millisecond
}

// grepFrame: does any recorded bridge frame contain this text?
func notesContain(notes []string, needle string) bool {
	for _, n := range notes {
		if strings.Contains(n, needle) {
			return true
		}
	}
	return false
}

func repoPath(t *testing.T, parts ...string) string {
	t.Helper()
	return filepath.Join(append([]string{*relayRoot}, parts...)...)
}

func mustReadFile(t *testing.T, path string) []byte {
	t.Helper()
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read %s: %v", path, err)
	}
	return raw
}

func skipUnlessPOSIX(t *testing.T, why string) {
	t.Helper()
	if runtime.GOOS != "windows" {
		return
	}
	t.Skipf("cannot run here: %s (host is windows)", why)
}
