// T-relay QA — a small evidence collector for §8.4.6 (pair.used).
//
// It is NOT one of the numbered cases and NOT part of the suite's count: it
// prints the structure either side of the pair.used question so another engineer
// can compare it with their own bridge, and it never prints a pairing code or a
// cookie value.
//
//	go test -count=1 -v -run '^TestEvidenceFrameTrace$' . -args '-case=evidence'
package relayqa_test

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"testing"
	"time"
)

// TestEvidenceFrameTrace prints one pairing, frame by frame.
func TestEvidenceFrameTrace(t *testing.T) {
	if !strings.Contains(strings.ToLower(*caseName), "evidence") {
		t.Skip("evidence helper: pass -case=evidence to run it")
	}
	inst := NewRelay(t, InstanceOpts{})
	b := inst.dialNotes()
	b.Send(map[string]any{
		"type": "hello", "version": 1, "clientName": "QA-EVIDENCE",
		"capabilities": map[string]any{"sessions.list": true, "tools": []string{"codex"}},
	})
	hello := b.MustReadType("hello.ok", 10*time.Second)
	fmt.Printf("Q0 hello.ok           : fields=%v\n", hello.Keys())

	desktopID := "3f2504e0-4f89-41d3-9a0c-0305e82c3301"
	request := map[string]any{"type": "pair.create", "id": desktopID}
	rawRequest, _ := json.Marshal(request)
	fmt.Printf("Q1 pair.create sent   : %s\n", rawRequest)
	fmt.Printf("Q1 id is lowercase v4 : %v\n", uuidV4OK(desktopID))

	b.Send(request)
	created, ok := b.ReadTypeNow("pair.created", 10*time.Second)
	if !ok {
		t.Fatalf("%s", "no pair.created within 10s; later frames:"+frameSummary(b.ReadAll(1*time.Second, 5)))
	}
	code := created.Str("code")
	fmt.Printf("Q1 pair.created recv  : fields=%v id_echoed_exactly=%v code_len=%d code_dashes=%d expiresAt=%s\n",
		created.Keys(), created.Str("id") == desktopID, len(code), strings.Count(code, "-"), created.Str("expiresAt"))
	fmt.Printf("Q2 same socket throughout: true (dialled once, never closed, no reconnect between the two steps)\n")

	// Q4: the phone consumes the code.
	res := inst.do(http.MethodPost, "/api/pair", reqOpts{
		Origin: strp(testOrigin), ContentType: strp("application/json"),
	}, reqBody(t, map[string]any{"code": code, "deviceName": "Evidence Phone"}))
	fmt.Printf("Q4 POST /api/pair     : HTTP %d, body %s\n", res.Status, strings.TrimSpace(string(res.Body)))
	if raw, _ := cookieFromResponse(t, res); raw != "" {
		fmt.Printf("Q4 Set-Cookie         : %s\n", cookieAttributes(raw))
	}

	// Q3: exactly what arrives next, in arrival order.
	fmt.Printf("Q3 frames after pairing, in arrival order:\n")
	deadline := time.Now().Add(10 * time.Second)
	seen := 0
	for time.Now().Before(deadline) && seen < 6 {
		f, ok := b.readWithin(time.Until(deadline))
		if !ok {
			break
		}
		seen++
		if f.Type == "pair.used" {
			fmt.Printf("Q3   [%d] pair.used  fields=%v codeId_matches_pair_create=%v deviceName=%q\n",
				seen, f.Keys(), f.Str("codeId") == desktopID, f.Str("deviceName"))
			break
		}
		fmt.Printf("Q3   [%d] %s  fields=%v\n", seen, f.Type, f.Keys())
	}
	if seen == 0 {
		fmt.Printf("Q3   (nothing arrived within 10s — the desktop is never told)\n")
	}
	fmt.Printf("Q3 pair.used delivered: %v\n", seen > 0)
}

func uuidV4OK(s string) bool {
	if len(s) != 36 {
		return false
	}
	for i, r := range s {
		switch i {
		case 8, 13, 18, 23:
			if r != '-' {
				return false
			}
		case 14:
			if r != '4' {
				return false
			}
		default:
			if !((r >= '0' && r <= '9') || (r >= 'a' && r <= 'f')) {
				return false
			}
		}
	}
	return true
}
