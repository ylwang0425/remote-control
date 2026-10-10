// cases_04_06_test.go — the pairing flow, pairing-code rules and Origin.
//
// T-relay DoD items: R3 (pair), R6 (pair handshake, id echoed), R5 (bridge
// auth), R4 (Origin hardening), plus CRD 0004's 24-Crockford-character code.
package relayqa_test

import (
	"net/http"
	"regexp"
	"strings"
	"testing"
	"time"
)

// pairCodeCanonical is §4.6's normative shape: 6 groups of 4, 29 characters.
var pairCodeCanonical = regexp.MustCompile(`^[0-9A-HJKMNP-TV-Z]{4}(-[0-9A-HJKMNP-TV-Z]{4}){5}$`)

// pairCodeSymbolsOnly is the alphabet without the separators.
var pairCodeSymbolsOnly = regexp.MustCompile(`^[0-9A-HJKMNP-TV-Z]{24}$`)

type timelineEntry struct {
	at    time.Duration
	kind  string
	raw   string
	httpS int
}

// TestCase04PairFlow — traceability: T-relay DoD items R3, R6 and R5.
// It proves the whole happy path: a real bridge, a real code, a real cookie.
func TestCase04PairFlow(t *testing.T) {
	caseFilter(t)
	inst := NewRelay(t, InstanceOpts{})

	notes := &notesLog{}
	b := inst.dialNotes()
	b.Send(map[string]any{
		"type": "hello", "version": 1, "clientName": "QA-DESKTOP",
		"capabilities": map[string]any{
			"sessions.list": true, "session.read": true,
			"session.send": true, "session.stop": true,
			"stop:codex": false, "stop:dsh": true, "tools": []string{"codex", "dsh"},
		},
	})
	helloOK := b.MustReadType("hello.ok", 10*time.Second)
	// §8.4.2 pins every one of these values.
	if got, ok := helloOK.Num("version"); !ok || int(got) != 1 {
		t.Fatalf("hello.ok version = %v, want 1", got)
	}
	rfc3339UTC(t, helloOK.Str("serverTime"), "hello.ok serverTime")
	for field, want := range map[string]int{
		"heartbeatIntervalMs": 20000,
		"idleTimeoutMs":       60000,
		"requestTimeoutMs":    30000,
		"maxPending":          16,
	} {
		got, ok := helloOK.Num(field)
		if !ok {
			t.Fatalf("hello.ok is missing %s: %s", field, helloOK.Raw)
		}
		if int(got) != want {
			t.Fatalf("hello.ok %s = %d, want %d (contract §8.4.2)", field, int(got), want)
		}
	}

	// (R6) the desktop mints the id; the relay echoes it byte for byte.
	desktopID := "3f2504e0-4f89-41d3-9a0c-0305e82c3301"
	var timeline []timelineEntry
	start := time.Now()
	stamp := func(kind, raw string) {
		timeline = append(timeline, timelineEntry{at: time.Since(start), kind: kind, raw: raw})
	}

	b.Send(map[string]any{"type": "pair.create", "id": desktopID})
	stamp("→ pair.create sent", `{"type":"pair.create","id":"`+desktopID+`"}`)
	created, ok := b.ReadTypeNow("pair.created", 10*time.Second)
	if !ok {
		t.Fatalf("%s", "no pair.created within 10s of pair.create.\nTimeline:"+renderTimeline(timeline))
	}
	stamp("← pair.created", string(created.Raw))
	if got := created.Str("id"); got != desktopID {
		t.Fatalf("pair.created id = %q, want the desktop's own id %q (CRD 0003 removed the 'or')", got, desktopID)
	}
	for _, key := range []string{"type", "id", "code", "expiresAt", "url"} {
		if !created.Has(key) {
			t.Fatalf("pair.created is missing %q: %s", key, created.Raw)
		}
	}

	// (R3, CRD 0004) the code is the canonical 24-Crockford-character form.
	code := created.Str("code")
	if len(code) != 29 {
		t.Fatalf("code = %q is %d characters, want 29 (24 symbols + 5 hyphens)", code, len(code))
	}
	if !pairCodeCanonical.MatchString(code) {
		t.Fatalf("code = %q does not match §4.6's regex", code)
	}
	if !pairCodeSymbolsOnly.MatchString(strings.ReplaceAll(code, "-", "")) {
		t.Fatalf("code = %q has symbols outside Crockford Base32", code)
	}
	if strings.Count(code, "-") != 5 {
		t.Fatalf("code = %q has %d hyphens, want 5", code, strings.Count(code, "-"))
	}

	// (R6) expiresAt is exactly five minutes after the mint.
	expires := rfc3339UTC(t, created.Str("expiresAt"), "pair.created expiresAt")
	now := time.Now().UTC()
	if expires.Sub(now) < 4*time.Minute+30*time.Second || expires.Sub(now) > 5*time.Minute+60*time.Second {
		t.Fatalf("expiresAt is %s away from now, want ~300s", expires.Sub(now))
	}

	// (R6) url is the fixed shape, with the code carried verbatim.
	wantURL := testOrigin + "/#pair=" + code
	if got := created.Str("url"); got != wantURL {
		t.Fatalf("pair.created url = %q, want %q", got, wantURL)
	}

	// (R3) the phone consumes the code and gets its cookie.
	paired := inst.pairDevice(code, "Pixel 8")
	stamp("POST /api/pair", "deviceName=Pixel 8 (code omitted: it is a credential)")
	timeline[len(timeline)-1].httpS = paired.Res.Status
	gotBody := decodeResp(t, paired.Res)
	if !gotBody.OK {
		t.Fatalf("POST /api/pair body = %s, want ok:true", paired.Res.Body)
	}
	if paired.Res.Status != 200 {
		t.Fatalf("POST /api/pair status = %d, want 200", paired.Res.Status)
	}
	raw, value := cookieFromResponse(t, paired.Res)

	// The very next thing the relay owes this desktop is pair.used (§8.4.6), and
	// it must arrive before any request frame, because no phone call is in flight.
	used, arrived := b.ReadTypeNow("pair.used", 10*time.Second)
	if arrived {
		stamp("← pair.used", string(used.Raw))
	} else {
		stamp("(pair.used never arrived)", "(nothing)")
	}
	if !arrived {
		t.Fatalf("%s", "no pair.used frame arrived after a successful POST /api/pair (200).\n"+
			"Timeline on the bridge connection:\n"+renderTimeline(timeline)+"\n"+
			"Contract §8.4.6 requires relay → desktop pair.used on consume. T-relay DoD R6.")
	}
	if got := used.Str("codeId"); got != desktopID {
		t.Fatalf("pair.used codeId = %q, want the pair.create id %q", got, desktopID)
	}
	if got := used.Str("deviceName"); got != "Pixel 8" {
		t.Fatalf("pair.used deviceName = %q, want %q", got, "Pixel 8")
	}
	rfc3339UTC(t, used.Str("at"), "pair.used at")
	for _, key := range used.Keys() {
		switch key {
		case "type", "codeId", "deviceName", "at":
		default:
			t.Fatalf("pair.used carries an extra field %q: %s", key, used.Raw)
		}
	}

	// The cookie attributes, and never the cookie value.
	if len(value) != 43 {
		t.Fatalf("rc_session is %d characters, want 43 (§4.1)", len(value))
	}
	for _, attr := range []string{"Path=/", "Max-Age=2592000", "HttpOnly", "Secure", "SameSite=Strict"} {
		if !hasCookieAttr(raw, attr) {
			t.Fatalf("Set-Cookie is missing %q; attributes seen: %v", attr, cookieAttributes(raw))
		}
	}
	if strings.Contains(strings.ToLower(raw), "domain=") {
		t.Fatalf("Set-Cookie sets Domain; §5.2 forbids it. attributes seen: %v", cookieAttributes(raw))
	}
	if strings.Contains(raw, "Expires=") {
		t.Fatalf("Set-Cookie sets both Max-Age and Expires; §5.2 wants Max-Age only")
	}
	t.Logf("Set-Cookie attributes: %s", cookieAttributes(raw))

	// The session token itself must not be echoed in the JSON body (§3.9).
	if strings.Contains(string(paired.Res.Body), value) {
		t.Fatalf("the pair response body repeats the session token: %s", paired.Res.Body)
	}
	apiNoStore(t, paired.Res)

	// (R3) the cookie really authenticates: sessions.list reaches the bridge.
	// The reader starts first because the relay only writes the request frame
	// once the phone's call is in flight (see bridge.ServeAsync).
	frames := b.ServeAsync(map[string]any{
		"sessions": []any{},
		"capabilities": map[string]any{
			"sessions.list": true, "session.read": true,
			"session.send": true, "session.stop": true,
			"stop:codex": false, "stop:dsh": true,
			"tools": []string{"codex", "dsh"},
		},
	}, 20*time.Second)
	inst.rpcOK(paired.Cookie, map[string]any{"method": "sessions.list"})
	requestFrame := frames.Wait()
	if got := requestFrame.Str("method"); got != "sessions.list" {
		t.Fatalf("request method = %q, want sessions.list", got)
	}
	uuidV4(t, requestFrame.Str("id"), "request id")
	if got, ok := requestFrame.Num("timeoutMs"); !ok || int(got) != 15000 {
		t.Fatalf("request timeoutMs = %v, want 15000 for sessions.list (§7.3)", got)
	}
	if got := string(requestFrame.Obj["params"]); got != "{}" {
		t.Fatalf("request params = %s, want {}", got)
	}

	// Nothing in the bridge traffic may carry the code, the cookie or the token.
	all := notes.snapshot()
	if notesContain(all, code) {
		t.Fatalf("%s", "the pairing code appears in bridge traffic; §8.4.6 says pair.used must not carry it")
	}
	if notesContain(all, value) {
		t.Fatalf("%s", "the rc_session token appears in bridge traffic")
	}
	if notesContain(all, inst.Token) {
		t.Fatalf("%s", "the bridgeToken appears in bridge traffic")
	}
}

func renderTimeline(entries []timelineEntry) string {
	var sb strings.Builder
	for _, e := range entries {
		sb.WriteString("\n  t+" + e.at.Round(time.Millisecond).String() + "  " + e.kind)
		if e.httpS != 0 {
			sb.WriteString("  → HTTP " + itoa(e.httpS))
		}
		if e.raw != "" {
			sb.WriteString("\n        " + e.raw)
		}
	}
	return sb.String()
}

func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	var digits []byte
	for n > 0 {
		digits = append([]byte{byte('0' + n%10)}, digits...)
		n /= 10
	}
	return string(digits)
}

// TestCase05PairCodeNormalizationAndSingleUse — traceability: T-relay DoD
// item R3 (normalization, one-shot, expiry, the 404-vs-401 rows of §7.2).
func TestCase05PairCodeNormalizationAndSingleUse(t *testing.T) {
	caseFilter(t)
	inst := NewRelay(t, InstanceOpts{})
	b := inst.helloBridge()

	mint := func() string {
		b.Send(map[string]any{"type": "pair.create", "id": newUUID(t)})
		return b.mustReadType("pair.created", 10*time.Second).Str("code")
	}
	postCode := func(code, device string) httpResult {
		return inst.do(http.MethodPost, "/api/pair", reqOpts{
			Origin: strp(testOrigin), ContentType: strp("application/json"),
		}, reqBody(t, map[string]any{"code": code, "deviceName": device}))
	}

	// ---- one code, one cookie (§7.2 rule 1) ----
	// §6.3 allows only 5 POST /api/pair per minute per IP, so this case spends
	// its requests deliberately: the one-shot proof and the unknown-code row use
	// this instance's budget, and the cheaper rows below get their own instance.
	code := mint()
	first := inst.pairDevice(code, "First Phone")
	second := postCode(code, "Second Phone")
	wantFailure(t, second, 401, "invalid_credentials")
	if strings.Contains(string(second.Body), first.RawValue) {
		t.Fatalf("%s", "the refusal repeats the first device's token")
	}
	// And the first session still works: a rejected second use changes nothing.
	alive := inst.rpc(first.Cookie, map[string]any{"method": "sessions.evil"})
	if alive.Status != 200 {
		t.Fatalf("the first device's session did not survive a rejected second pairing: %d %s",
			alive.Status, alive.Body)
	}

	// ---- a well-formed code that was never minted is 404 (§7.2's table) ----
	// I/O/U are Crockford aliases, so this string normalizes to 24 valid symbols
	// and lands on the "code does not exist" row, not the "code is not valid" one.
	unknown := "IIII-OOOO-UUUU-LLLL-IIII-OOOO"
	wantFailure(t, postCode(unknown, "Nobody"), 404, "not_found")

	// ---- normalization and the not-valid rows, on a fresh budget ----
	instN := freshInstance(t, InstanceOpts{})
	bN := instN.helloBridge()
	mintN := func() string {
		bN.Send(map[string]any{"type": "pair.create", "id": newUUID(t)})
		return bN.mustReadType("pair.created", 10*time.Second).Str("code")
	}
	postN := func(code, device string) httpResult {
		return instN.do(http.MethodPost, "/api/pair", reqOpts{
			Origin: strp(testOrigin), ContentType: strp("application/json"),
		}, reqBody(t, map[string]any{"code": code, "deviceName": device}))
	}

	// §4.6 normalization: no hyphens, lower case, aliases folded.
	code2 := mintN()
	aliased := strings.ToLower(strings.ReplaceAll(code2, "-", ""))
	aliased = strings.NewReplacer("0", "O", "1", "I", "v", "u").Replace(aliased)
	res := postN(aliased, "Alias Phone")
	if res.Status != 200 {
		t.Fatalf("an alias-spelled code was refused: status %d body %s (minted %q, sent %q)",
			res.Status, res.Body, code2, aliased)
	}
	if !decodeResp(t, res).OK {
		t.Fatalf("alias pairing body = %s, want ok:true", res.Body)
	}

	// The space-separated form is accepted too.
	code3 := mintN()
	spaced := strings.Join(strings.Split(code3, "-"), " ")
	if got := postN(spaced, "Spaced Phone"); got.Status != 200 {
		t.Fatalf("a space-separated code was refused: %d %s", got.Status, got.Body)
	}

	// ---- a code outside the alphabet after normalization is refused ----
	for _, bad := range []string{"ABCD", "-----", "12345"} {
		res := postN(bad, "Nobody")
		if res.Status != 401 && res.Status != 404 {
			t.Fatalf("code %q status = %d, want 401 or 404; body %s", bad, res.Status, res.Body)
		}
		if strings.Contains(string(res.Body), `"internal"`) {
			t.Fatalf("code %q produced an internal error: %s", bad, res.Body)
		}
	}

	// ---- two codes are never the same code ----
	// §6.3 allows only 5 POST /api/pair per minute per IP, so the mint-and-use
	// part of this case has spent the budget. A second relay in the same case
	// gets fresh in-memory buckets, which is exactly what an operator's restart
	// does, and this case measures uniqueness, not the limiter.
	inst2 := freshInstance(t, InstanceOpts{})
	b2 := inst2.helloBridge()
	seen := map[string]bool{}
	for i := 0; i < 8; i++ {
		b2.Send(map[string]any{"type": "pair.create", "id": newUUID(t)})
		c := b2.mustReadType("pair.created", 10*time.Second).Str("code")
		if seen[c] {
			t.Fatalf("pair.create minted the same code twice: %q", c)
		}
		seen[c] = true
	}
	if len(seen) != 8 {
		t.Fatalf("only %d distinct codes from 8 mints", len(seen))
	}
}

// TestCase06OriginExactMatch — traceability: T-relay DoD item R4 and §5.3,
// plus the /downloads/* rule as changed by the field fix (G1).
func TestCase06OriginExactMatch(t *testing.T) {
	caseFilter(t)
	inst := NewRelay(t, InstanceOpts{})

	cases := []struct {
		name   string
		origin *string
		ok     bool
	}{
		{"exact", strp(testOrigin), true},
		{"exact_with_surrounding_space", strp("  " + testOrigin + "  "), true},
		{"exact_uppercase_scheme_and_host", strp("HTTPS://101.43.98.18"), true},
		{"absent", nil, false},
		{"empty", strp(""), false},
		{"null_literal", strp("null"), false},
		{"http_scheme", strp("http://101.43.98.18"), false},
		{"explicit_default_port", strp("https://101.43.98.18:443"), false},
		{"trailing_slash", strp("https://101.43.98.18/"), false},
		{"suffix_host", strp("https://101.43.98.18.evil.example"), false},
		{"other_port", strp("https://101.43.98.18:8443"), false},
		{"subdomain", strp("https://relay.101.43.98.18"), false},
		{"other_host", strp("https://101.43.98.19"), false},
		{"wildcard", strp("*"), false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			res := inst.do(http.MethodPost, "/api/pair", reqOpts{
				Origin: tc.origin, ContentType: strp("application/json"),
			}, reqBody(t, map[string]any{"code": "AAAA-BBBB-CCCC-DDDD-EEEE-FFFF", "deviceName": "Phone"}))

			if tc.ok {
				if res.Status == 403 {
					t.Fatalf("a legitimate Origin was refused with 403: %s", res.Body)
				}
				assertNoCORS(t, res)
				return
			}
			wantFailure(t, res, 403, "origin_forbidden")
			if got := decodeResp(t, res).Error.Message; got != "origin not allowed" {
				t.Fatalf("error.message = %q, want the fixed text %q", got, "origin not allowed")
			}
			if cc := res.Header.Get("Cache-Control"); cc != "no-store" {
				t.Fatalf("a 403 on /api/pair has Cache-Control %q, want no-store", cc)
			}
		})
	}

	// The same exact-match rule applies to /downloads/*: a missing Origin is
	// allowed there (the G1 field fix), a wrong one is still refused.
	noOrigin := inst.do(http.MethodGet, "/downloads/app.apk", reqOpts{}, nil)
	if noOrigin.Status == 403 {
		t.Fatalf("GET /downloads/... with no Origin was refused 403; the field rule allows a missing Origin there")
	}
	if noOrigin.Status != 404 {
		t.Fatalf("GET /downloads/... with no Origin status = %d, want 404 for an absent file", noOrigin.Status)
	}
	wantNotFound(t, noOrigin)

	wrongOrigin := inst.do(http.MethodGet, "/downloads/app.apk",
		reqOpts{Origin: strp("https://101.43.98.18.evil.example")}, nil)
	wantFailure(t, wrongOrigin, 403, "origin_forbidden")
	assertNoCORS(t, wrongOrigin)

	// /api/* is not relaxed: no Origin is still 403 there.
	apiNoOrigin := inst.do(http.MethodPost, "/api/pair", reqOpts{ContentType: strp("application/json")},
		reqBody(t, map[string]any{"code": "AAAA-BBBB-CCCC-DDDD-EEEE-FFFF", "deviceName": "Phone"}))
	wantFailure(t, apiNoOrigin, 403, "origin_forbidden")

	// A bad Origin wins over a bad Content-Type, and either way no CORS header
	// appears on the refusal.
	badBoth := inst.do(http.MethodPost, "/api/pair",
		reqOpts{Origin: strp("https://evil.example"), ContentType: strp("text/plain")}, []byte("x"))
	if badBoth.Status != 403 && badBoth.Status != 415 {
		t.Fatalf("bad Origin + bad Content-Type status = %d, want 403 or 415", badBoth.Status)
	}
	assertNoCORS(t, badBoth)
}
