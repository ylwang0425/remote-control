package server

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"

	"github.com/ai-remote/relay/internal/bridge"
	"github.com/ai-remote/relay/internal/config"
	"github.com/ai-remote/relay/internal/protocol"
	"github.com/ai-remote/relay/internal/store"
)

const testOrigin = "https://101.43.98.18"

type env struct {
	t        *testing.T
	srv      *httptest.Server
	s        *Server
	hub      *bridge.Hub
	st       *store.Store
	cfg      *config.Config
	token    string
	download string
}

func newEnv(t *testing.T) *env {
	t.Helper()
	dir := t.TempDir()
	downloads := filepath.Join(dir, "downloads")
	if err := os.MkdirAll(downloads, 0o755); err != nil {
		t.Fatalf("MkdirAll: %v", err)
	}
	if err := os.WriteFile(filepath.Join(downloads, "app-release.apk"), []byte("PK\x03\x04 fake apk"), 0o644); err != nil {
		t.Fatalf("WriteFile: %v", err)
	}
	if err := os.WriteFile(filepath.Join(downloads, "secrets.json"), []byte(`{"token":"x"}`), 0o600); err != nil {
		t.Fatalf("WriteFile: %v", err)
	}

	st, err := store.Open(filepath.Join(dir, "relay.db"))
	if err != nil {
		t.Fatalf("store.Open: %v", err)
	}
	t.Cleanup(func() { _ = st.Close() })

	token, err := config.NewBridgeToken()
	if err != nil {
		t.Fatalf("NewBridgeToken: %v", err)
	}
	cfg := config.Default()
	cfg.BridgeToken = token
	cfg.DBPath = filepath.Join(dir, "relay.db")
	cfg.DownloadsDir = downloads
	cfg.WebDir = filepath.Join(dir, "web") // deliberately absent: R19 item 4

	hub := bridge.NewHub()
	s, err := New(Options{Config: cfg, Store: st, Hub: hub})
	if err != nil {
		t.Fatalf("server.New: %v", err)
	}
	ts := httptest.NewServer(s.Handler())
	t.Cleanup(ts.Close)

	return &env{t: t, srv: ts, s: s, hub: hub, st: st, cfg: cfg, token: token, download: downloads}
}

// wsClient is a real coder/websocket client speaking the bridge protocol.
type wsClient struct {
	t    *testing.T
	conn *websocket.Conn
}

func (e *env) dial(authorization, origin string) (*wsClient, *http.Response, error) {
	e.t.Helper()
	header := http.Header{}
	if authorization != "" {
		header.Set("Authorization", authorization)
	}
	if origin != "" {
		header.Set("Origin", origin)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	url := "ws" + strings.TrimPrefix(e.srv.URL, "http") + "/bridge"
	conn, resp, err := websocket.Dial(ctx, url, &websocket.DialOptions{HTTPHeader: header})
	if err != nil {
		return nil, resp, err
	}
	return &wsClient{t: e.t, conn: conn}, resp, nil
}

func (e *env) mustDialBridge() *wsClient {
	e.t.Helper()
	c, _, err := e.dial("Bearer "+e.token, "")
	if err != nil {
		e.t.Fatalf("dial /bridge: %v", err)
	}
	e.t.Cleanup(func() { _ = c.conn.CloseNow() })
	return c
}

func (e *env) helloBridge(caps protocol.Capabilities) *wsClient {
	e.t.Helper()
	c := e.mustDialBridge()
	c.send(map[string]any{"type": "hello", "version": 1, "clientName": "DESKTOP-TEST", "capabilities": caps})
	f := c.read()
	if f.Type != protocol.FrameHelloOK {
		e.t.Fatalf("after hello got frame %q, want hello.ok", f.Type)
	}
	return c
}

func (c *wsClient) send(v any) {
	c.t.Helper()
	raw, err := json.Marshal(v)
	if err != nil {
		c.t.Fatalf("marshal frame: %v", err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := c.conn.Write(ctx, websocket.MessageText, raw); err != nil {
		c.t.Fatalf("write frame: %v", err)
	}
}

func (c *wsClient) read() *protocol.Frame {
	c.t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_, data, err := c.conn.Read(ctx)
	if err != nil {
		c.t.Fatalf("read frame: %v", err)
	}
	f, err := protocol.ParseFrame(data)
	if err != nil {
		c.t.Fatalf("parse frame %s: %v", data, err)
	}
	return f
}

// readRequest waits for a request frame, skipping the relay's own pings.
func (c *wsClient) readRequest() *protocol.Frame {
	c.t.Helper()
	f, ok := c.readRequestQuiet()
	if !ok {
		c.t.Fatal("no request frame arrived")
	}
	return f
}

// readRequestQuiet is readRequest for helper goroutines: it reports failure
// instead of failing the test, because testing.T.Fatalf may only be called from
// the test's own goroutine.
func (c *wsClient) readRequestQuiet() (*protocol.Frame, bool) {
	for i := 0; i < 40; i++ {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		_, data, err := c.conn.Read(ctx)
		cancel()
		if err != nil {
			return nil, false
		}
		f, err := protocol.ParseFrame(data)
		if err != nil {
			return nil, false
		}
		switch f.Type {
		case protocol.FrameRequest:
			return f, true
		case protocol.FramePing:
			_ = c.conn.Write(context.Background(), websocket.MessageText, []byte(`{"type":"pong"}`))
		}
	}
	return nil, false
}

// readPairCreated skips any frame that is not the answer to pair.create, so a
// leftover pair.used from an earlier pairing cannot be mistaken for it.
func (c *wsClient) readPairCreated() *protocol.Frame {
	c.t.Helper()
	for i := 0; i < 40; i++ {
		f := c.read()
		if f.Type == protocol.FramePairCreated {
			return f
		}
	}
	c.t.Fatal("no pair.created frame arrived")
	return nil
}

// readPairUsedQuiet waits for a pair.used frame for helper goroutines, reporting
// failure instead of failing the test.
func (c *wsClient) readPairUsedQuiet() (*protocol.Frame, bool) {
	for i := 0; i < 40; i++ {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		_, data, err := c.conn.Read(ctx)
		cancel()
		if err != nil {
			return nil, false
		}
		f, err := protocol.ParseFrame(data)
		if err != nil {
			return nil, false
		}
		switch f.Type {
		case protocol.FramePairUsed:
			return f, true
		case protocol.FramePing:
			_ = c.conn.Write(context.Background(), websocket.MessageText, []byte(`{"type":"pong"}`))
		}
	}
	return nil, false
}

func (c *wsClient) answer(id string, result any) {
	c.send(map[string]any{"type": "response", "id": id, "ok": true, "result": result})
}

func (c *wsClient) answerError(id string, code string, message string) {
	c.send(map[string]any{
		"type": "response", "id": id, "ok": false,
		"error": map[string]any{"code": code, "message": message},
	})
}

// request performs one HTTP call against the relay.
func (e *env) request(method, path, origin, contentType, cookie, body string) *http.Response {
	e.t.Helper()
	var reader io.Reader
	if body != "" {
		reader = strings.NewReader(body)
	}
	req, err := http.NewRequest(method, e.srv.URL+path, reader)
	if err != nil {
		e.t.Fatalf("NewRequest: %v", err)
	}
	if origin != "" {
		req.Header.Set("Origin", origin)
	}
	if contentType != "" {
		req.Header.Set("Content-Type", contentType)
	}
	if cookie != "" {
		req.Header.Set("Cookie", cookie)
	}
	resp, err := e.srv.Client().Do(req)
	if err != nil {
		e.t.Fatalf("%s %s: %v", method, path, err)
	}
	return resp
}

func readBody(t *testing.T, resp *http.Response) string {
	t.Helper()
	defer resp.Body.Close()
	b, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatalf("read body: %v", err)
	}
	return string(b)
}

// decodeFailure asserts the §6.1 shape and the exact code.
func decodeFailure(t *testing.T, resp *http.Response, wantStatus int, wantCode protocol.Code) {
	t.Helper()
	body := readBody(t, resp)
	if resp.StatusCode != wantStatus {
		t.Fatalf("status = %d, want %d (body %s)", resp.StatusCode, wantStatus, body)
	}
	var got struct {
		OK    bool `json:"ok"`
		Error struct {
			Code    string `json:"code"`
			Message string `json:"message"`
		} `json:"error"`
	}
	if err := json.Unmarshal([]byte(body), &got); err != nil {
		t.Fatalf("body is not json: %s", body)
	}
	if got.OK {
		t.Fatalf("body has ok:true on a failure: %s", body)
	}
	if got.Error.Code != string(wantCode) {
		t.Fatalf("error.code = %q, want %q (body %s)", got.Error.Code, wantCode, body)
	}
	if got.Error.Message == "" {
		t.Fatalf("error.message is empty: %s", body)
	}
}

// pairOnce drives the real pairing flow and returns the session cookie value.
func (e *env) pairOnce(c *wsClient) string {
	e.t.Helper()
	resp := e.request("POST", "/api/pair", testOrigin, "application/json", "",
		fmt.Sprintf(`{"code":%q,"deviceName":"Pixel 8"}`, e.mintCode(c)))
	if resp.StatusCode != 200 {
		e.t.Fatalf("POST /api/pair status = %d, body %s", resp.StatusCode, readBody(e.t, resp))
	}
	return sessionCookie(e.t, resp)
}

// mintCode asks a bridge for a fresh pairing code.
func (e *env) mintCode(c *wsClient) string {
	e.t.Helper()
	id, err := protocol.NewRequestID()
	if err != nil {
		e.t.Fatalf("NewRequestID: %v", err)
	}
	c.send(map[string]any{"type": "pair.create", "id": id})
	return c.readPairCreated().Code
}

func sessionCookie(t *testing.T, resp *http.Response) string {
	t.Helper()
	for _, c := range resp.Cookies() {
		if c.Name == "rc_session" {
			return c.Value
		}
	}
	t.Fatalf("response carried no rc_session cookie")
	return ""
}

func at(t *testing.T, raw string) time.Time {
	t.Helper()
	parsed, err := time.Parse(time.RFC3339, raw)
	if err != nil {
		t.Fatalf("time %q is not RFC3339: %v", raw, err)
	}
	return parsed
}

func jsonField(t *testing.T, body string, path ...string) string {
	t.Helper()
	var current any
	if err := json.Unmarshal([]byte(body), &current); err != nil {
		t.Fatalf("body is not json: %s", body)
	}
	for _, key := range path {
		obj, ok := current.(map[string]any)
		if !ok {
			t.Fatalf("body %s has no object at %q", body, key)
		}
		current, ok = obj[key]
		if !ok {
			t.Fatalf("body %s has no field %q", body, key)
		}
	}
	switch v := current.(type) {
	case string:
		return v
	case bool:
		if v {
			return "true"
		}
		return "false"
	default:
		raw, _ := json.Marshal(v)
		return string(raw)
	}
}
