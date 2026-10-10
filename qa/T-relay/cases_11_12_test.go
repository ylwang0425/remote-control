// cases_11_12_test.go — logout/revocation and the APK download whitelist.
//
// T-relay DoD items: R11 (logout and revoke; CRD 0003's 403 forbidden path)
// and R12 with R19 item 1 (only APKs, never a fallback into the site).
package relayqa_test

import (
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// TestCase11LogoutAndRevocation — traceability: T-relay DoD item R11 and §7.4,
// including CRD 0003's addition of 403 forbidden.
func TestCase11LogoutAndRevocation(t *testing.T) {
	caseFilter(t)
	inst := NewRelay(t, InstanceOpts{})
	b := inst.helloBridge()

	mint := func(name string) pairResult {
		b.Send(map[string]any{"type": "pair.create", "id": newUUID(t)})
		created := b.mustReadType("pair.created", 10*time.Second)
		return inst.pairDevice(created.Str("code"), name)
	}

	// ---- logging out kills the caller's own cookie (§7.4) ----
	first := mint("First Phone")
	res := inst.do(http.MethodPost, "/api/logout", reqOpts{
		Origin: strp(testOrigin), ContentType: strp("application/json"), Cookie: first.Cookie,
	}, nil) // no body at all is allowed
	if res.Status != 200 {
		t.Fatalf("POST /api/logout status = %d, want 200; body %s", res.Status, res.Body)
	}
	if got := decodeResp(t, res); !got.OK {
		t.Fatalf("logout body = %s, want ok:true", res.Body)
	}
	raw, _ := cookieFromResponse(t, res)
	for _, attr := range []string{"Path=/", "Max-Age=0", "HttpOnly", "Secure", "SameSite=Strict"} {
		if !hasCookieAttr(raw, attr) {
			t.Fatalf("logout Set-Cookie is missing %q; attributes seen: %s", attr, cookieAttributes(raw))
		}
	}
	if !strings.HasPrefix(raw, "rc_session=;") && !strings.HasPrefix(raw, "rc_session= ;") {
		t.Fatalf("logout Set-Cookie does not clear rc_session; attributes seen: %s", cookieAttributes(raw))
	}
	apiNoStore(t, res)

	// The old cookie is dead immediately for every authenticated endpoint.
	after := inst.rpc(first.Cookie, map[string]any{"method": "sessions.list", "params": map[string]any{}})
	wantFailure(t, after, 401, "unauthenticated")
	afterLogout := inst.do(http.MethodPost, "/api/logout", reqOpts{
		Origin: strp(testOrigin), ContentType: strp("application/json"), Cookie: first.Cookie,
	}, nil)
	wantFailure(t, afterLogout, 401, "unauthenticated")

	// A structurally invalid cookie is also 401, and never a 500.
	for _, bad := range []string{"rc_session=", "rc_session=nope", "rc_session=" + strings.Repeat("A", 42), "rc_session=" + strings.Repeat("A", 44)} {
		res := inst.rpc(bad, map[string]any{"method": "sessions.list", "params": map[string]any{}})
		wantFailure(t, res, 401, "unauthenticated")
	}

	// ---- CRD 0003: revoking a device needs a bridge bearer ----
	holder := mint("Holder Phone")
	victim := mint("Victim Phone")

	// A valid cookie, a target id, and no Authorization must be 403 forbidden,
	// not 401 and not a success.
	noBearer := inst.do(http.MethodPost, "/api/logout", reqOpts{
		Origin: strp(testOrigin), ContentType: strp("application/json"), Cookie: holder.Cookie,
	}, reqBody(t, map[string]any{"targetSessionId": victim.RawValue}))
	wantFailure(t, noBearer, 403, "forbidden")

	// The victim must still be alive: a refused revoke changes nothing. The
	// proof is an RPC-layer refusal (unknown_method), which needs no bridge
	// round trip, so this case cannot be confused with a timeout.
	stillAlive := inst.rpc(victim.Cookie, map[string]any{"method": "sessions.evil"})
	if stillAlive.Status != 200 {
		t.Fatalf("a refused revoke already changed the target's session: status %d body %s", stillAlive.Status, stillAlive.Body)
	}
	if got := decodeResp(t, stillAlive).Error.Code; got != "unknown_method" {
		t.Fatalf("the victim's session no longer authenticates: %s", stillAlive.Body)
	}

	// A wrong bearer is refused the same way.
	wrong := inst.do(http.MethodPost, "/api/logout", reqOpts{
		Origin: strp(testOrigin), ContentType: strp("application/json"),
		Cookie: holder.Cookie, Bearer: strings.Repeat("A", 43),
	}, reqBody(t, map[string]any{"targetSessionId": victim.RawValue}))
	wantFailure(t, wrong, 403, "forbidden")

	// A malformed target id is 400, before the permission check matters (§7.4).
	short := inst.do(http.MethodPost, "/api/logout", reqOpts{
		Origin: strp(testOrigin), ContentType: strp("application/json"), Cookie: holder.Cookie,
	}, reqBody(t, map[string]any{"targetSessionId": "too-short"}))
	wantFailure(t, short, 400, "invalid_request")

	// ---- the legitimate path: a bridge bearer may revoke, idempotently ----
	// The bridge must also see the revoke through its own traffic being
	// refused afterwards; there is nothing to notify it of in the contract.
	ok := inst.do(http.MethodPost, "/api/logout", reqOpts{
		Origin: strp(testOrigin), ContentType: strp("application/json"),
		Cookie: holder.Cookie, Bearer: inst.Token,
	}, reqBody(t, map[string]any{"targetSessionId": victim.RawValue}))
	if ok.Status != 200 {
		t.Fatalf("bridge-authorised revoke status = %d, want 200; body %s", ok.Status, ok.Body)
	}
	if got := decodeResp(t, ok); !got.OK {
		t.Fatalf("bridge-authorised revoke body = %s, want ok:true", ok.Body)
	}
	// Revoking someone else must not clear the caller's own cookie.
	if len(ok.Header.Values("Set-Cookie")) != 0 {
		t.Fatalf("revoking another device answered Set-Cookie %v; §7.4 only clears the cookie when the target is the caller",
			ok.Header.Values("Set-Cookie"))
	}
	dead := inst.rpc(victim.Cookie, map[string]any{"method": "sessions.evil"})
	wantFailure(t, dead, 401, "unauthenticated")
	// The caller is untouched: a request that is refused for its method proves
	// the session still resolves, without waiting on the bridge.
	aliveForHolder := inst.rpc(holder.Cookie, map[string]any{"method": "sessions.evil"})
	if aliveForHolder.Status != 200 {
		t.Fatalf("revoking another device changed the caller's session state: status %d body %s", aliveForHolder.Status, aliveForHolder.Body)
	}
	if got := decodeResp(t, aliveForHolder).Error.Code; got != "unknown_method" {
		t.Fatalf("holder's session no longer authenticates: %s", aliveForHolder.Body)
	}

	// Idempotent: revoking the same dead device again is still ok:true (§7.4).
	again := inst.do(http.MethodPost, "/api/logout", reqOpts{
		Origin: strp(testOrigin), ContentType: strp("application/json"),
		Cookie: holder.Cookie, Bearer: inst.Token,
	}, reqBody(t, map[string]any{"targetSessionId": victim.RawValue}))
	if again.Status != 200 {
		t.Fatalf("a second revoke of the same device status = %d, want 200 (§7.4 says it is idempotent); body %s", again.Status, again.Body)
	}
	decodeResp(t, again)

	// Revoking yourself through the same path clears your cookie too.
	self := inst.do(http.MethodPost, "/api/logout", reqOpts{
		Origin: strp(testOrigin), ContentType: strp("application/json"),
		Cookie: holder.Cookie, Bearer: inst.Token,
	}, reqBody(t, map[string]any{"targetSessionId": holder.RawValue}))
	if self.Status != 200 {
		t.Fatalf("self-revoke through the bridge path status = %d, want 200; body %s", self.Status, self.Body)
	}
	if raw, _ := cookieFromResponse(t, self); !strings.Contains(raw, "Max-Age=0") {
		t.Fatalf("self-revoke Set-Cookie does not clear the cookie; attributes seen: %s", cookieAttributes(raw))
	}
}

// TestCase12DownloadsWhitelist — traceability: T-relay DoD items R12 and R19
// item 1.
func TestCase12DownloadsWhitelist(t *testing.T) {
	caseFilter(t)

	downloads := t.TempDir()
	apkName := "AI-Remote-Android.apk"
	realAPK := repoPath(t, "mobile", "dist", apkName)
	apkBytes := mustReadFile(t, realAPK)
	if err := os.WriteFile(filepath.Join(downloads, apkName), apkBytes, 0o644); err != nil {
		t.Fatal(err)
	}
	// Files that must never be served, even though they sit in the same folder.
	for name, content := range map[string]string{
		"relay.json":   `{"bridgeToken":"should-never-be-served"}`,
		"relay.db":     "SQLite format 3\x00",
		"notes.txt":    "private notes",
		"key.pem":      "-----BEGIN PRIVATE KEY-----",
		"config.yaml":  "secret: yes",
		"app.log":      "log line",
		"evil.apk.exe": "MZ",
		"app.apk.bak":  "backup",
	} {
		if err := os.WriteFile(filepath.Join(downloads, name), []byte(content), 0o600); err != nil {
			t.Fatal(err)
		}
	}

	inst := NewRelay(t, InstanceOpts{DownloadsDir: downloads})

	get := func(path string) httpResult {
		return inst.do(http.MethodGet, path, reqOpts{Origin: strp(testOrigin)}, nil)
	}

	// ---- (1) the whitelisted APK is served, byte for byte ----
	res := get("/downloads/" + apkName)
	if res.Status != 200 {
		t.Fatalf("GET /downloads/%s status = %d, want 200; body %s", apkName, res.Status, res.Body)
	}
	if got := res.Header.Get("Content-Type"); got != "application/vnd.android.package-archive" {
		t.Fatalf("APK Content-Type = %q, want application/vnd.android.package-archive", got)
	}
	if got := res.Header.Get("Content-Disposition"); got != `attachment; filename="`+apkName+`"` {
		t.Fatalf("APK Content-Disposition = %q", got)
	}
	if got := res.Header.Get("Cache-Control"); got != "no-store" {
		t.Fatalf("APK Cache-Control = %q, want no-store", got)
	}
	if got := res.Header.Get("X-Content-Type-Options"); got != "nosniff" {
		t.Fatalf("APK X-Content-Type-Options = %q, want nosniff", got)
	}
	if got := res.Header.Get("Content-Length"); got == "" {
		t.Fatalf("APK response carried no Content-Length")
	}
	if !bytesEqual(res.Body, apkBytes) {
		t.Fatalf("the served APK differs from mobile/dist/%s (%d bytes served, %d on disk)", apkName, len(res.Body), len(apkBytes))
	}
	assertNoCORS(t, res)

	// HEAD is allowed and carries the same headers with no body (§7.5).
	head := inst.do(http.MethodHead, "/downloads/"+apkName, reqOpts{Origin: strp(testOrigin)}, nil)
	if head.Status != 200 {
		t.Fatalf("HEAD /downloads/%s status = %d, want 200", apkName, head.Status)
	}
	if len(head.Body) != 0 {
		t.Fatalf("HEAD returned a body of %d bytes", len(head.Body))
	}

	// ---- (2) everything that is not a whitelisted APK is the same 404 ----
	refused := []string{
		"/downloads/",
		"/downloads",
		"/downloads/relay.json",
		"/downloads/relay.db",
		"/downloads/notes.txt",
		"/downloads/key.pem",
		"/downloads/config.yaml",
		"/downloads/app.log",
		"/downloads/evil.apk.exe",
		"/downloads/app.apk.bak",
		"/downloads/.apk",
		"/downloads/-bad.apk",
		"/downloads/a%20b.apk",
		// traversal, literal and encoded
		"/downloads/../relay.json",
		"/downloads/..%2frelay.json",
		"/downloads/%2e%2e%2frelay.json",
		"/downloads/%2e%2e%5crelay.json",
		"/downloads/..%5crelay.json",
		"/downloads/....//relay.json",
		"/downloads/%2e%2e/%2e%2e/relay/web/index.html",
		"/downloads/sub/dir/app.apk",
		"/downloads/%2fetc%2fpasswd.apk",
		// a leading directory that would escape if it were followed
		"/downloads/c:%5crelay.json",
		// a name that is an HTTP-hostile character set
		"/downloads/apk%00.apk",
	}
	for _, path := range refused {
		got := get(path)
		if got.Status == 200 {
			t.Fatalf("GET %s returned 200; §7.5 allows only a whitelisted .apk", path)
		}
		// The router answers a path with a doubled separator by cleaning it
		// (307), which neither serves the file nor reaches the handler. Both
		// are refusals; a 404 is the contract's shape, so it is asserted where
		// it applies and the redirect is recorded where it does not.
		if got.Status == 307 || got.Status == 301 {
			t.Logf("note: GET %s is answered %d by the router's path cleaning before the handler; nothing was served",
				path, got.Status)
			continue
		}
		if got.Status != 404 {
			t.Fatalf("GET %s status = %d, want 404 (every refusal is the same answer)", path, got.Status)
		}
		wantNotFound(t, got)
		if strings.Contains(strings.ToLower(string(got.Body)), "index.html") ||
			strings.Contains(strings.ToLower(string(got.Body)), "<html") {
			t.Fatalf("GET %s fell back to the static site: %s", path, got.Body)
		}
		if got.Body != nil && strings.Contains(string(got.Body), "bridgeToken") {
			t.Fatalf("GET %s leaked a config value: %s", path, got.Body)
		}
	}

	// ---- (3) a symlink out of the whitelist is refused (rule 7) ----
	outside := filepath.Join(t.TempDir(), "outside.apk")
	if err := os.WriteFile(outside, []byte("PK\x03\x04 outside"), 0o600); err != nil {
		t.Fatal(err)
	}
	linkPath := filepath.Join(downloads, "sneaky.apk")
	if err := os.Symlink(outside, linkPath); err != nil {
		t.Logf("SKIP(symlink escape): this host would not create a symlink (%v); "+
			"the check runs on CentOS where symlinks are ordinary", err)
	} else {
		got := get("/downloads/sneaky.apk")
		if got.Status != 404 {
			t.Fatalf("a symlink pointing outside the whitelist status = %d, want 404", got.Status)
		}
	}

	// ---- (4) method whitelist (§7.5: GET and HEAD only) ----
	for _, method := range []string{http.MethodPost, http.MethodPut, http.MethodDelete} {
		got := inst.do(method, "/downloads/"+apkName, reqOpts{Origin: strp(testOrigin), ContentType: strp("application/json")}, []byte(`{}`))
		if got.Status != 405 {
			t.Fatalf("%s /downloads/%s status = %d, want 405", method, apkName, got.Status)
		}
		if allow := got.Header.Get("Allow"); !strings.Contains(allow, "GET") || !strings.Contains(allow, "HEAD") {
			t.Fatalf("%s /downloads Allow = %q, want it to name GET and HEAD", method, allow)
		}
	}

	// ---- (5) the route families never fall back into each other ----
	// A missing APK must not become the web page, and /downloads must not
	// become a directory listing.
	missing := get("/downloads/absent.apk")
	if missing.Status != 404 {
		t.Fatalf("a missing whitelisted APK status = %d, want 404", missing.Status)
	}
	if body := string(missing.Body); strings.Contains(strings.ToLower(body), "<!doctype") ||
		strings.Contains(strings.ToLower(body), "<html") ||
		strings.Contains(strings.ToLower(body), "directory") {
		t.Fatalf("a missing APK answered with a page: %s", body)
	}
	// The site still works, so the 404s above are not "everything is 404".
	inst2 := NewRelay(t, InstanceOpts{
		DownloadsDir: downloads,
		WebDirGiven:  true, WebDir: repoPath(t, "relay", "web"),
	})
	site := inst2.do(http.MethodGet, "/", reqOpts{}, nil)
	if site.Status != 200 {
		t.Fatalf("GET / status = %d while /downloads is whitelisted; the two routes must not interfere", site.Status)
	}
	// A traversal attempt belongs to neither route: it is refused or redirected
	// out of /downloads, and it must not be answered with the site's bytes.
	siteDownload := inst2.do(http.MethodGet, "/downloads/../index.html", reqOpts{Origin: strp(testOrigin)}, nil)
	if siteDownload.Status == 200 {
		t.Fatalf("GET /downloads/../index.html returned 200 (body %d bytes); traversal must never reach the site root",
			len(siteDownload.Body))
	}
	if strings.Contains(strings.ToLower(string(siteDownload.Body)), "<!doctype") {
		t.Fatalf("GET /downloads/../index.html answered with the site page: %s", firstLines(string(siteDownload.Body), 3))
	}
	api := inst2.do(http.MethodGet, "/downloads/relay.json", reqOpts{Origin: strp(testOrigin)}, nil)
	if api.Status != 404 {
		t.Fatalf("GET /downloads/relay.json status = %d, want 404", api.Status)
	}

	// (5+6) a traversal attempt must not reach the site, and every refusal must
	// be the same sentence so this endpoint cannot be used as a filesystem
	// probe. A bare "%" is not a valid URL target for Go's client, so it goes
	// over a raw socket, which is also closer to what an attacker sends.
	traversal := get("/downloads/../relay.json")
	plain := get("/downloads/relay.json")
	if traversal.Status != 404 || plain.Status != 404 {
		t.Fatalf("refusal statuses = %d (traversal) and %d (plain), want 404 for both", traversal.Status, plain.Status)
	}
	a := strings.TrimSpace(string(traversal.Body))
	b := strings.TrimSpace(string(plain.Body))
	if a != b {
		t.Fatalf("the refusals differ, which makes this endpoint a probe:\n  traversal: %s\n  plain 404: %s", a, b)
	}

	rawBad := rawRequest(t, inst.URL, strings.Join([]string{
		"GET /downloads/% HTTP/1.1",
		"Host: " + hostPort(inst.URL),
		"Origin: " + testOrigin,
		"Connection: close",
		"",
		"",
	}, "\r\n"))
	rawStatus := strings.SplitN(rawBad, "\r\n", 2)[0]
	if !strings.Contains(rawStatus, "404") && !strings.Contains(rawStatus, "400") {
		t.Fatalf("a bare %% in the download path status line = %q, want 404 (or 400 from HTTP framing)", rawStatus)
	}
	if strings.Contains(rawStatus, "400") {
		t.Logf("note: a bare %% never reaches the handler; the HTTP layer rejects the malformed target with %q first", rawStatus)
	}

	// A traversal that reaches the handler must not be answered with the site.
	siteBytes := mustReadFile(t, repoPath(t, "relay", "web", "index.html"))
	if strings.Contains(string(traversal.Body), string(siteBytes[:40])) {
		t.Fatalf("a traversal refusal carries the site's bytes: %s", traversal.Body)
	}
	if strings.Contains(a, downloads) || strings.Contains(a, "\\") || strings.Contains(strings.ToLower(a), "symlink") {
		t.Fatalf("the refusal body hints at the filesystem: %s", a)
	}
	var parsed struct {
		Error struct {
			Message string `json:"message"`
		} `json:"error"`
	}
	if err := json.Unmarshal(plain.Body, &parsed); err != nil {
		t.Fatalf("refusal is not JSON: %s", plain.Body)
	}
	if parsed.Error.Message != "not found" {
		t.Fatalf("refusal message = %q, want the fixed text \"not found\"", parsed.Error.Message)
	}

	// Rate limiting is real on this endpoint (30 per minute, §6.3): it must
	// answer 429 with Retry-After rather than pretending the file vanished. A
	// fresh instance is used because this case already spent buckets above.
	limiterDir := t.TempDir()
	if err := os.WriteFile(filepath.Join(limiterDir, apkName), apkBytes, 0o644); err != nil {
		t.Fatal(err)
	}
	limiter := NewRelay(t, InstanceOpts{DownloadsDir: limiterDir})
	deadline := time.Now().Add(30 * time.Second)
	saw429 := false
	for i := 0; i < 40 && time.Now().Before(deadline); i++ {
		got := limiter.do(http.MethodGet, "/downloads/"+apkName, reqOpts{Origin: strp(testOrigin)}, nil)
		if got.Status == 429 {
			saw429 = true
			if ra := got.Header.Get("Retry-After"); ra == "" {
				t.Fatalf("429 without a Retry-After header")
			}
			break
		}
	}
	if !saw429 {
		t.Fatalf("40 downloads in a row were never rate limited; §6.3 sets 30 per minute on /downloads/*")
	}
}
