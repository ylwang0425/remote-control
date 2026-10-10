package server

import (
	"bufio"
	"fmt"
	"net"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/ai-remote/relay/internal/protocol"
)

// TestMethodMatchIsExact covers security finding F4. The method check used to be
// a substring test, so "P", "PO", "OS" and "ST" all satisfied a "POST"
// allowance: the 405 never fired and the Content-Type requirement — which hangs
// off r.Method == POST — was skipped with it.
func TestMethodMatchIsExact(t *testing.T) {
	e := newEnv(t)
	for _, method := range []string{"P", "PO", "OS", "ST", "S", "T"} {
		req, err := http.NewRequest(method, e.srv.URL+"/api/rpc", strings.NewReader(`{"method":"sessions.list"}`))
		if err != nil {
			// Go refuses some of these outright; that is also a refusal.
			continue
		}
		req.Header.Set("Origin", testOrigin)
		// Deliberately no Content-Type: a real POST would be rejected 415 here.
		resp, err := e.srv.Client().Do(req)
		if err != nil {
			continue // the transport refused the method, which is fine too
		}
		body := readBody(t, resp)
		if resp.StatusCode == 200 || resp.StatusCode == 401 || resp.StatusCode == 503 {
			t.Fatalf("method %q was treated as a POST and reached the handler: %d %s", method, resp.StatusCode, body)
		}
		if resp.StatusCode != 405 {
			t.Fatalf("method %q status = %d, want 405 (body %s)", method, resp.StatusCode, body)
		}
		if allow := resp.Header.Get("Allow"); allow != "POST" {
			t.Fatalf("method %q Allow = %q, want POST", method, allow)
		}
	}
}

// TestChunkedBodyOverLimitIs413 covers security finding F8. A body sent with
// Transfer-Encoding: chunked carries no Content-Length, so the header check in
// guard cannot see it; the limited reader catches it and must answer 413
// payload_too_large, exactly as §5.4 requires, not 400.
//
// /api/pair is used because it needs no session: on /api/rpc the authentication
// check runs first and would answer 401 before the body is ever parsed, which is
// correct but would not exercise this path.
func TestChunkedBodyOverLimitIs413(t *testing.T) {
	e := newEnv(t)

	conn, err := net.Dial("tcp", strings.TrimPrefix(e.srv.URL, "http://"))
	if err != nil {
		t.Fatalf("Dial returned error: %v", err)
	}
	defer conn.Close()

	// A syntactically valid JSON body that simply runs past the 4096 ceiling for
	// /api/pair, so the limited reader is what stops it — not a syntax error.
	payload := `{"code":"` + strings.Repeat("a", 8000) + `"}`
	request := "POST /api/pair HTTP/1.1\r\n" +
		"Host: " + strings.TrimPrefix(e.srv.URL, "http://") + "\r\n" +
		"Origin: " + testOrigin + "\r\n" +
		"Content-Type: application/json\r\n" +
		"Transfer-Encoding: chunked\r\n" +
		"Connection: close\r\n\r\n" +
		fmt.Sprintf("%x\r\n", len(payload)) + payload + "\r\n0\r\n\r\n"
	if _, err := conn.Write([]byte(request)); err != nil {
		t.Fatalf("write request: %v", err)
	}

	statusLine, err := bufio.NewReader(conn).ReadString('\n')
	if err != nil {
		t.Fatalf("read status line: %v", err)
	}
	if !strings.Contains(statusLine, "413") {
		t.Fatalf("status line = %q, want 413 for a body over the endpoint ceiling", strings.TrimSpace(statusLine))
	}
}

// TestBridgeHandshakeIsRateLimitedBeforeAnyWrite covers security finding F1,
// which was blocking.
//
// /bridge needs no credential, and every refusal below the limiter used to write
// an audit row — a real SQLite write. Looping this endpoint could therefore
// drive unbounded persistent writes on a 2-core box, with the contract's §6.3
// rate limits not applying at all. The limiter and the concurrency cap must run
// before anything can be recorded, so a flood is refused without touching disk.
func TestBridgeHandshakeIsRateLimitedBeforeAnyWrite(t *testing.T) {
	e := newEnv(t)

	before, err := e.st.AuditCount()
	if err != nil {
		t.Fatalf("AuditCount returned error: %v", err)
	}

	// The bridge bucket is 60 handshakes per minute per address; go well past it.
	limited := 0
	for i := 0; i < 90; i++ {
		resp := e.request("GET", "/bridge", "", "", "", "")
		readBody(t, resp)
		if resp.StatusCode == 429 {
			limited++
		}
	}
	if limited == 0 {
		t.Fatal("90 refused /bridge handshakes were never rate limited")
	}

	after, err := e.st.AuditCount()
	if err != nil {
		t.Fatalf("AuditCount returned error: %v", err)
	}
	// Only the handshakes that got past the limiter may have been audited, so the
	// row count must be bounded by the quota — not by the number of attempts.
	if after-before > 60 {
		t.Fatalf("%d audit rows were written for 90 refused handshakes; the limiter must run before the write",
			after-before)
	}
}

// TestBridgeRateLimitResponseShape checks the refusal is the contract's shape,
// not an empty 429.
func TestBridgeRateLimitResponseShape(t *testing.T) {
	e := newEnv(t)
	var last *http.Response
	for i := 0; i < 90; i++ {
		resp := e.request("GET", "/bridge", "", "", "", "")
		readBody(t, resp)
		if resp.StatusCode == 429 {
			last = resp
			break
		}
	}
	if last == nil {
		t.Skip("no 429 reached within 90 attempts")
	}
	if retry := last.Header.Get("Retry-After"); retry != "5" {
		t.Fatalf("Retry-After = %q, want 5", retry)
	}
}

// TestPerIPConcurrencyIsCapped covers security finding F3's missing half: the
// counters existed but were only ever touched by /bridge, so /api/* had no
// per-IP ceiling at all and relied on the relay-wide limit alone.
func TestPerIPConcurrencyIsCapped(t *testing.T) {
	e := newEnv(t)
	const ip = "203.0.113.7"
	for i := 0; i < maxInFlightPerIP; i++ {
		if !e.s.limits.enter(ip) {
			t.Fatalf("the per-IP cap refused request %d of %d", i+1, maxInFlightPerIP)
		}
	}
	if e.s.limits.enter(ip) {
		t.Fatalf("the per-IP cap allowed request %d, want it capped at %d", maxInFlightPerIP+1, maxInFlightPerIP)
	}
	// A different address is unaffected.
	if !e.s.limits.enter("203.0.113.8") {
		t.Fatal("one noisy address exhausted the cap for another")
	}
}

// TestGuardAppliesThePerIPCap proves the cap is actually wired into the /api/*
// path, not merely available: with the requesting address already at the cap,
// the next request must be refused 429 before any handler runs.
func TestGuardAppliesThePerIPCap(t *testing.T) {
	e := newEnv(t)
	// httptest requests arrive from loopback, which is the address guard sees.
	for i := 0; i < maxInFlightPerIP; i++ {
		if !e.s.limits.enter("127.0.0.1") {
			t.Fatalf("setup: refused request %d", i+1)
		}
	}
	t.Cleanup(func() {
		for i := 0; i < maxInFlightPerIP; i++ {
			e.s.limits.leave("127.0.0.1")
		}
	})

	resp := e.request("POST", "/api/rpc", testOrigin, "application/json", "rc_session="+strings.Repeat("a", 43),
		`{"method":"sessions.list"}`)
	if resp.Header.Get("Retry-After") != "5" {
		t.Fatalf("Retry-After = %q, want 5", resp.Header.Get("Retry-After"))
	}
	decodeFailure(t, resp, 429, protocol.CodeRateLimited)
}

// TestLimiterBucketsAreEvicted covers security finding F3's other half: both
// per-IP maps used to grow for the life of the process, one entry per source
// address that ever made a single request.
func TestLimiterBucketsAreEvicted(t *testing.T) {
	l := newLimiters()
	for i := 0; i < 200; i++ {
		l.allow("rpc", "198.51.100."+string(rune('a'+i%26))+string(rune('a'+i/26)))
	}
	if got := len(l.byIP); got == 0 {
		t.Fatal("no buckets were recorded, so the eviction test proves nothing")
	}
	// Age every bucket past the TTL and sweep.
	l.mu.Lock()
	for _, per := range l.byIP {
		for _, c := range per {
			c.window = c.window.Add(-2 * bucketTTL)
		}
	}
	for _, c := range l.hourly {
		c.window = c.window.Add(-2 * bucketTTL)
	}
	l.mu.Unlock()

	if dropped := l.sweep(time.Now()); dropped == 0 {
		t.Fatal("sweep dropped nothing; the maps are unbounded")
	}
	if got := len(l.byIP); got != 0 {
		t.Fatalf("byIP still holds %d entries after a sweep past the TTL", got)
	}
	if got := len(l.hourly); got != 0 {
		t.Fatalf("hourly still holds %d entries after a sweep past the TTL", got)
	}
}

// TestSweepKeepsLiveBuckets guards the other direction: eviction must not reset
// a quota that is still inside its window, or the rate limit would be trivial
// to evade.
func TestSweepKeepsLiveBuckets(t *testing.T) {
	l := newLimiters()
	if !l.allow("pair", "198.51.100.9") {
		t.Fatal("first pair request was refused")
	}
	l.sweep(time.Now())
	if got := len(l.byIP); got != 1 {
		t.Fatalf("a live bucket was evicted: byIP holds %d entries, want 1", got)
	}
}

var _ = protocol.CodeRateLimited
