package protocol

import (
	"encoding/json"
	"testing"
)

// TestErrorCodesMatchContractTable covers protocol-v1 §6.2: every stable
// machine code carries the HTTP status the table pins, and the client branches
// on code, never on message.
func TestErrorCodesMatchContractTable(t *testing.T) {
	want := map[Code]int{
		CodeInvalidJSON:          400,
		CodeInvalidRequest:       400,
		CodeUnauthenticated:      401,
		CodeInvalidCredentials:   401,
		CodeOriginForbidden:      403,
		CodeForbidden:            403, // CRD 0003 addition; no existing code changed
		CodeNotFound:             404,
		CodeMethodNotAllowed:     405,
		CodePayloadTooLarge:      413,
		CodeUnsupportedMediaType: 415,
		CodeRateLimited:          429,
		CodeInternal:             500,
		CodeBridgeOffline:        503,
		CodeBridgeBusy:           503,
		CodeBridgeTimeout:        504,
		CodeBridgeBadResponse:    502,
		CodeUnknownMethod:        200,
		CodeInvalidParams:        200,
		CodeSessionNotFound:      200,
		CodeSessionGone:          200,
		CodeNotCapable:           200,
		CodeTooLong:              200,
		CodeBridgeError:          200,
	}

	for code, wantStatus := range want {
		if got := code.HTTPStatus(); got != wantStatus {
			t.Errorf("%s.HTTPStatus() = %d, want %d", code, got, wantStatus)
		}
		if msg := code.CanonicalMessage(); msg == "" {
			t.Errorf("%s.CanonicalMessage() is empty", code)
		}
		if len(code.CanonicalMessage()) > 120 {
			t.Errorf("%s canonical message is %d chars, want <= 120", code, len(code.CanonicalMessage()))
		}
	}

	// §6.2 forbids information-free codes, and the table is closed.
	for _, banned := range []Code{"unknown", "error", "failed", ""} {
		if _, ok := want[banned]; ok {
			t.Errorf("code %q must not be part of the contract table", banned)
		}
		if banned != "" && banned.HTTPStatus() != 500 {
			t.Errorf("unknown code %q must fall back to 500 internal, got %d", banned, banned.HTTPStatus())
		}
	}
}

// TestErrorBodyShape covers §6.1: one failure shape for HTTP errors and RPC
// business errors alike, never mixed with ok:true.
func TestErrorBodyShape(t *testing.T) {
	raw, err := json.Marshal(Failure(CodeBridgeOffline))
	if err != nil {
		t.Fatalf("Marshal returned error: %v", err)
	}
	var got struct {
		OK    bool `json:"ok"`
		Error struct {
			Code    string `json:"code"`
			Message string `json:"message"`
		} `json:"error"`
	}
	if err := json.Unmarshal(raw, &got); err != nil {
		t.Fatalf("Unmarshal(%s) returned error: %v", raw, err)
	}
	if got.OK {
		t.Fatalf("failure body has ok=true: %s", raw)
	}
	if got.Error.Code != "bridge_offline" {
		t.Fatalf("error.code = %q, want bridge_offline", got.Error.Code)
	}
	if got.Error.Message == "" {
		t.Fatal("error.message is empty")
	}

	// No business field may sit beside ok:false.
	var asMap map[string]json.RawMessage
	if err := json.Unmarshal(raw, &asMap); err != nil {
		t.Fatalf("Unmarshal returned error: %v", err)
	}
	if len(asMap) != 2 {
		t.Fatalf("failure body has keys %v, want exactly ok and error", keys(asMap))
	}
	if _, found := asMap["ok"]; !found {
		t.Fatal("failure body has no ok key")
	}
	if _, found := asMap["error"]; !found {
		t.Fatal("failure body has no error key")
	}
}

func keys(m map[string]json.RawMessage) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	return out
}
