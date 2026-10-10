// cases_01_03_test.go — CLI init, /health and the static site.
//
// T-relay DoD items: R1 (listen + /health), R2 (--init), R19 item 2 and 4
// (site on / and /assets/*, a missing web directory is a plain 404).
package relayqa_test

import (
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

// TestCase01Init — traceability: T-relay DoD item R2.
// It proves --init generates a high-entropy bridgeToken, refuses to overwrite
// an existing private config, and never prints the token.
func TestCase01Init(t *testing.T) {
	caseFilter(t)
	requireHarness(t)
	dir := t.TempDir()
	bin := *relayBin
	cfg := filepath.Join(dir, "relay.json")

	// ---- first --init ------------------------------------------------
	first := runCmd(t, dir, bin, "--init", "--config", cfg)
	if !strings.Contains(first, cfg) {
		t.Fatalf("--init did not report the config path it wrote:\n%s", first)
	}
	if _, err := os.Stat(cfg); err != nil {
		t.Fatalf("--init left no config file: %v", err)
	}
	raw1 := mustReadFile(t, cfg)
	var c1 map[string]any
	if err := json.Unmarshal(raw1, &c1); err != nil {
		t.Fatalf("generated config is not JSON: %v", err)
	}
	token1, _ := c1["bridgeToken"].(string)
	if token1 == "" {
		t.Fatalf("generated config has no bridgeToken")
	}

	// ---- the token is high entropy (§4.1: >= 32 random bytes base64url) ----
	if len(token1) < 43 {
		t.Fatalf("bridgeToken is %d characters, want >= 43 (32 random bytes)", len(token1))
	}
	if len(token1) > 86 {
		t.Fatalf("bridgeToken is %d characters, above the regex maximum of 86", len(token1))
	}
	for _, r := range token1 {
		ok := (r >= 'A' && r <= 'Z') || (r >= 'a' && r <= 'z') ||
			(r >= '0' && r <= '9') || r == '-' || r == '_'
		if !ok {
			t.Fatalf("bridgeToken has a character outside base64url: %q", r)
		}
	}
	if decoded, err := base64.RawURLEncoding.DecodeString(token1); err != nil {
		t.Fatalf("bridgeToken is not valid base64url: %v", err)
	} else if len(decoded) < 32 {
		t.Fatalf("bridgeToken decodes to %d bytes, want >= 32", len(decoded))
	}
	if strings.Contains(strings.ToLower(token1), "change-me") ||
		strings.Contains(strings.ToLower(token1), "default") ||
		strings.Contains(strings.ToLower(token1), "example") {
		t.Fatalf("bridgeToken looks like a placeholder: %q", token1)
	}

	// ---- the rest of the generated config (R2, and §3 loopback-only) ----
	if got, _ := c1["listenAddr"].(string); got != "127.0.0.1:8080" {
		t.Fatalf("listenAddr = %q, want the loopback default 127.0.0.1:8080", got)
	}
	if got, _ := c1["publicOrigin"].(string); got != testOrigin {
		t.Fatalf("publicOrigin = %q, want %q", got, testOrigin)
	}
	origins, _ := c1["allowedOrigins"].([]any)
	if len(origins) != 1 || origins[0] != testOrigin {
		t.Fatalf("allowedOrigins = %v, want exactly [%q]", origins, testOrigin)
	}
	if strings.Contains(string(raw1), "*") {
		t.Fatalf("generated config contains a wildcard:\n%s", raw1)
	}
	// No bootstrap endpoint and no default password exists anywhere (§3.2).
	for _, needle := range []string{"password", "bootstrap", "adminToken", "secret"} {
		if strings.Contains(strings.ToLower(string(raw1)), strings.ToLower(needle)) {
			t.Fatalf("generated config carries a %q field; §3.2 has no default credential", needle)
		}
	}

	// ---- the token is never printed (R14) ----------------------------
	// The check is on the whole fixed output: the credential itself is the one
	// thing --init must not put into a terminal or a journal. Note that saying
	// the *words* "bridgeToken is a credential" is fine and expected; what must
	// never appear is the value.
	if strings.Contains(first, token1) {
		t.Fatalf("--init printed the bridgeToken; a credential must stay in the 0600 file:\n%s", first)
	}
	for _, line := range strings.Split(first, "\n") {
		if strings.Contains(line, "bridgeToken") && !strings.Contains(line, "characters") &&
			!strings.Contains(line, "credential") && !strings.Contains(line, "sed") {
			t.Fatalf("a --init line mentions bridgeToken and looks like it may carry it: %q", line)
		}
	}
	t.Logf("--init output:\n%s", first)

	// ---- file mode (R2: 0600) ----------------------------------------
	if runtime.GOOS == "windows" {
		t.Logf("SKIP(POSIX mode): host is windows; Go does not map 0600 onto an NTFS permission here. " +
			"The generated file was requested with mode 0600, which is what a CentOS deployment gets.")
	} else if info, err := os.Stat(cfg); err != nil {
		t.Fatalf("stat config: %v", err)
	} else if perm := info.Mode().Perm(); perm != 0o600 {
		t.Fatalf("config mode = %o, want 600", perm)
	}

	// ---- second --init must refuse ------------------------------------
	out2, code2 := runCmdOut(dir, bin, "--init", "--config", cfg)
	if code2 == 0 {
		t.Fatalf("a second --init exited 0; R2 requires it to refuse:\n%s", out2)
	}
	if !strings.Contains(strings.ToLower(out2), "refus") {
		t.Fatalf("a second --init did not say it refused:\n%s", out2)
	}
	raw2 := mustReadFile(t, cfg)
	if string(raw2) != string(raw1) {
		t.Fatalf("a second --init rewrote the private config")
	}
	hashBefore := fileSHA256(raw1)
	if hashBefore == "" {
		t.Fatal("hash helper failed")
	}
	if strings.Contains(out2, token1) {
		t.Fatalf("the refusal printed the existing bridgeToken:\n%s", out2)
	}
	var still map[string]any
	if err := json.Unmarshal(raw2, &still); err != nil {
		t.Fatalf("config no longer parses: %v", err)
	}
	if still["bridgeToken"] != token1 {
		t.Fatalf("bridgeToken changed after a refused --init")
	}

	// ---- --force is explicit and does replace -------------------------
	out3, code3 := runCmdOut(dir, bin, "--init", "--force", "--config", cfg)
	if code3 != 0 {
		t.Fatalf("--init --force exited %d:\n%s", code3, out3)
	}
	var c3 map[string]any
	if err := json.Unmarshal(mustReadFile(t, cfg), &c3); err != nil {
		t.Fatalf("config after --force is not JSON: %v", err)
	}
	if token3, _ := c3["bridgeToken"].(string); token3 == token1 {
		t.Fatalf("--force regenerated the config but kept the same bridgeToken")
	}
	_ = hex.EncodeToString(raw1)
}

// fileSHA256 is a tiny fingerprint used to prove a file was not rewritten.
func fileSHA256(raw []byte) string {
	sum := sha256.Sum256(raw)
	return hex.EncodeToString(sum[:])
}

// TestCase02HealthAndLoopback — traceability: T-relay DoD item R1.
// It proves /health has the exact contract shape and that the process listens
// on loopback only.
func TestCase02HealthAndLoopback(t *testing.T) {
	caseFilter(t)
	inst := NewRelay(t, InstanceOpts{})

	// (E) the contract shape, with no bridge connected yet.
	res := inst.do(http.MethodGet, "/health", reqOpts{}, nil)
	if res.Status != 200 {
		t.Fatalf("GET /health status = %d, want 200; body %s", res.Status, res.Body)
	}
	if ct := res.Header.Get("Content-Type"); !strings.HasPrefix(ct, "application/json") {
		t.Fatalf("GET /health Content-Type = %q, want application/json", ct)
	}
	var body map[string]any
	if err := json.Unmarshal(res.Body, &body); err != nil {
		t.Fatalf("GET /health body is not JSON: %s", res.Body)
	}
	if len(body) != 2 {
		t.Fatalf("GET /health body has %d fields (%v); §7.1 allows only ok and bridgeOnline", len(body), body)
	}
	if body["ok"] != true {
		t.Fatalf("GET /health ok = %v, want true", body["ok"])
	}
	if online, ok := body["bridgeOnline"].(bool); !ok || online {
		t.Fatalf("GET /health bridgeOnline = %v, want false with no bridge", body["bridgeOnline"])
	}
	assertNoCORS(t, res)
	if got := res.Header.Get("X-Content-Type-Options"); got != "nosniff" {
		t.Fatalf("X-Content-Type-Options = %q, want nosniff", got)
	}

	// (E) /health does not check Origin (§7.1).
	withOrigin := inst.do(http.MethodGet, "/health", reqOpts{Origin: strp("https://evil.example")}, nil)
	if withOrigin.Status != 200 {
		t.Fatalf("GET /health with a foreign Origin = %d, want 200 (no Origin check on /health)", withOrigin.Status)
	}

	// (E) bridgeOnline flips true only after a hello.
	inst.dialBridge() // authenticated but no hello yet
	before := inst.do(http.MethodGet, "/health", reqOpts{}, nil)
	var pre map[string]any
	_ = json.Unmarshal(before.Body, &pre)
	if pre["bridgeOnline"] != false {
		t.Fatalf("bridgeOnline = %v before any hello; §7.1 counts only helloed connections", pre["bridgeOnline"])
	}
	inst.helloBridge()
	after := inst.do(http.MethodGet, "/health", reqOpts{}, nil)
	var post map[string]any
	_ = json.Unmarshal(after.Body, &post)
	if post["bridgeOnline"] != true {
		t.Fatalf("bridgeOnline = %v after a hello, want true", post["bridgeOnline"])
	}

	// (F) methods other than GET/HEAD are 405 with an Allow header (§5.5).
	post404 := inst.do(http.MethodPost, "/health", reqOpts{ContentType: strp("application/json")}, []byte(`{}`))
	if post404.Status != 405 {
		t.Fatalf("POST /health status = %d, want 405", post404.Status)
	}
	if allow := post404.Header.Get("Allow"); !strings.Contains(allow, "GET") {
		t.Fatalf("POST /health Allow = %q, want it to name GET", allow)
	}

	// (B)(C)(D) loopback only.
	assertListenIsLoopbackOnly(t, inst.Port)
}

// assertListenIsLoopbackOnly is R1's "must not listen on 0.0.0.0" made checkable.
func assertListenIsLoopbackOnly(t *testing.T, port int) {
	t.Helper()
	// The relay bound 127.0.0.1:port. A bind on 0.0.0.0:port would make this
	// bind fail, which is the proof that it is not listening on every address.
	probe, err := net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", port))
	if err == nil {
		_ = probe.Close()
		t.Fatalf("could still bind 127.0.0.1:%d: the relay is not actually holding that address", port)
	}

	// A connection to a real, non-loopback local address on the same port must
	// not be accepted, while the loopback one is.
	nonLoopback := nonLoopbackIPv4(t)
	if nonLoopback == "" {
		t.Logf("SKIP(non-loopback reachability): this host has no non-loopback IPv4 address to dial")
	} else {
		addr := net.JoinHostPort(nonLoopback, fmt.Sprint(port))
		conn, err := net.DialTimeout("tcp", addr, 2*time.Second)
		if err == nil {
			_ = conn.Close()
			t.Fatalf("relay answered on %s: it is listening beyond loopback (R1 forbids 0.0.0.0)", addr)
		}
	}

	// Reaching the relay through localhost must keep working, so the check
	// above is not "the port is dead".
	conn, err := net.DialTimeout("tcp", net.JoinHostPort("127.0.0.1", fmt.Sprint(port)), 2*time.Second)
	if err != nil {
		t.Fatalf("cannot dial 127.0.0.1:%d on the relay: %v", port, err)
	}
	_ = conn.Close()
}

func nonLoopbackIPv4(t *testing.T) string {
	t.Helper()
	addrs, err := net.InterfaceAddrs()
	if err != nil {
		return ""
	}
	for _, a := range addrs {
		ipnet, ok := a.(*net.IPNet)
		if !ok {
			continue
		}
		ip := ipnet.IP.To4()
		if ip == nil || ip.IsLoopback() {
			continue
		}
		return ip.String()
	}
	return ""
}

// TestCase03StaticSite — traceability: T-relay DoD item R19 items 2 and 4, and
// R12's "the two route families never fall back into each other".
func TestCase03StaticSite(t *testing.T) {
	caseFilter(t)
	inst := NewRelay(t, InstanceOpts{WebDirGiven: true, WebDir: repoPath(t, "relay", "web")})

	// (14) GET / serves the real relay/web/index.html, byte for byte.
	indexPath := repoPath(t, "relay", "web", "index.html")
	want := mustReadFile(t, indexPath)
	res := inst.do(http.MethodGet, "/", reqOpts{}, nil)
	if res.Status != 200 {
		t.Fatalf("GET / status = %d, want 200; body %s", res.Status, res.Body)
	}
	if !strings.HasPrefix(res.Header.Get("Content-Type"), "text/html") {
		t.Fatalf("GET / Content-Type = %q, want text/html", res.Header.Get("Content-Type"))
	}
	if len(res.Body) != len(want) {
		t.Fatalf("GET / returned %d bytes, relay/web/index.html is %d bytes", len(res.Body), len(want))
	}
	if string(res.Body) != string(want) {
		t.Fatalf("GET / body does not match relay/web/index.html")
	}
	assertNoCORS(t, res)

	// (R19 item 2) the assets beside it, with their own content types.
	for _, spec := range []struct{ path, ctype, file string }{
		{"/css/app.css", "text/css", "css/app.css"},
		{"/js/app.js", "javascript", "js/app.js"},
	} {
		got := inst.do(http.MethodGet, spec.path, reqOpts{}, nil)
		if got.Status != 200 {
			t.Fatalf("GET %s status = %d, want 200", spec.path, got.Status)
		}
		if ct := got.Header.Get("Content-Type"); !strings.Contains(ct, spec.ctype) {
			t.Fatalf("GET %s Content-Type = %q, want it to contain %q", spec.path, ct, spec.ctype)
		}
		fileBytes := mustReadFile(t, repoPath(t, "relay", "web", filepath.FromSlash(spec.file)))
		if string(got.Body) != string(fileBytes) {
			t.Fatalf("GET %s does not match the file on disk", spec.path)
		}
	}

	// An unknown path is a plain 404 and never a fallback. `/downloads/...` is
	// deliberately absent from this list: §7.5 puts a mandatory Origin check on
	// that endpoint, so its own refusals belong to TestCase12DownloadsWhitelist.
	for _, path := range []string{"/does-not-exist", "/assets/nope.js"} {
		got := inst.do(http.MethodGet, path, reqOpts{}, nil)
		if got.Status != 404 {
			t.Fatalf("GET %s status = %d, want 404", path, got.Status)
		}
	}

	// A file that exists in the web tree but is not a web asset is refused:
	// a database or a config must never be downloadable.
	tmpWeb := t.TempDir()
	if err := os.WriteFile(filepath.Join(tmpWeb, "relay.json"), []byte(`{"bridgeToken":"x"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(tmpWeb, "index.html"), []byte("<html>qa</html>"), 0o600); err != nil {
		t.Fatal(err)
	}
	inst2 := NewRelay(t, InstanceOpts{WebDirGiven: true, WebDir: tmpWeb})
	for _, path := range []string{"/relay.json", "/Relay.json", "/%72elay.json"} {
		got := inst2.do(http.MethodGet, path, reqOpts{}, nil)
		if got.Status != 404 {
			t.Fatalf("GET %s status = %d, want 404 (only web assets may be served)", path, got.Status)
		}
	}

	// (R19 item 4) a missing web directory is an ordinary 404, never a crash,
	// and the process is still alive afterwards.
	inst3 := NewRelay(t, InstanceOpts{WebDirGiven: true, WebDir: filepath.Join(t.TempDir(), "absent-web")})
	for _, path := range []string{"/", "/index.html", "/css/app.css"} {
		got := inst3.do(http.MethodGet, path, reqOpts{}, nil)
		if got.Status != 404 {
			t.Fatalf("GET %s with no web directory status = %d, want 404", path, got.Status)
		}
		wantNotFound(t, got)
	}
	alive := inst3.do(http.MethodGet, "/health", reqOpts{}, nil)
	if alive.Status != 200 {
		t.Fatalf("relay died or degraded after serving from a missing web dir: /health = %d", alive.Status)
	}
}
