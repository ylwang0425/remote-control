package protocol

import (
	"encoding/json"
	"testing"
)

// TestParseFrameKnownTypes covers §8.3/§8.4: the three frames the relay reads
// from the bridge parse into their fields, and an unknown type is not an error
// — §8.5 says ignore the frame and keep the connection, so a newer desktop
// cannot break an older relay.
func TestParseFrameKnownTypes(t *testing.T) {
	hello, err := ParseFrame([]byte(`{"type":"hello","version":1,"clientName":"DESKTOP-7F3A","capabilities":{"sessions.list":true,"session.read":true,"session.send":true,"session.stop":true,"stop:codex":false,"stop:dsh":true,"tools":["codex","dsh"]}}`))
	if err != nil {
		t.Fatalf("ParseFrame(hello) returned error: %v", err)
	}
	if hello.Type != FrameHello {
		t.Fatalf("hello type = %q, want hello", hello.Type)
	}
	if hello.Version != 1 || hello.ClientName != "DESKTOP-7F3A" {
		t.Fatalf("hello = %+v, want version 1 and clientName DESKTOP-7F3A", hello)
	}
	if hello.Capabilities == nil {
		t.Fatal("hello capabilities is nil")
	}
	// An omitted boolean key must read as false: §9.5 forbids default-allow.
	if hello.Capabilities.StopCodex {
		t.Error("stop:codex = true, want false")
	}
	if !hello.Capabilities.StopDSH {
		t.Error("stop:dsh = false, want true")
	}
	if len(hello.Capabilities.Tools) != 2 {
		t.Errorf("tools = %v, want 2 entries", hello.Capabilities.Tools)
	}

	pairCreate, err := ParseFrame([]byte(`{"type":"pair.create","id":"3f2504e0-4f89-41d3-9a0c-0305e82c3301"}`))
	if err != nil {
		t.Fatalf("ParseFrame(pair.create) returned error: %v", err)
	}
	if pairCreate.Type != FramePairCreate || pairCreate.ID != "3f2504e0-4f89-41d3-9a0c-0305e82c3301" {
		t.Fatalf("pair.create = %+v, want the id echoed", pairCreate)
	}

	resp, err := ParseFrame([]byte(`{"type":"response","id":"9c858901-8a57-4791-81fe-4c455b099bc9","ok":true,"result":{"accepted":true,"sessionId":"s-1"}}`))
	if err != nil {
		t.Fatalf("ParseFrame(response) returned error: %v", err)
	}
	if resp.Type != FrameResponse || resp.OK == nil || !*resp.OK {
		t.Fatalf("response = %+v, want ok true", resp)
	}

	for _, raw := range []string{`{"type":"ping"}`, `{"type":"pong"}`} {
		f, err := ParseFrame([]byte(raw))
		if err != nil {
			t.Fatalf("ParseFrame(%s) returned error: %v", raw, err)
		}
		if f.Type != FramePing && f.Type != FramePong {
			t.Fatalf("ParseFrame(%s) type = %q", raw, f.Type)
		}
	}

	unknown, err := ParseFrame([]byte(`{"type":"something.from.the.future","x":1}`))
	if err != nil {
		t.Fatalf("ParseFrame(unknown type) returned error: %v; §8.5 says ignore, not fail", err)
	}
	if unknown.Type != "something.from.the.future" {
		t.Fatalf("unknown type = %q, want it preserved so the caller can ignore it", unknown.Type)
	}
}

// TestParseFrameRejectsMalformed covers §8.5: a frame that is not JSON, or
// whose top level is not an object, or that carries no string type, is a
// protocol error the caller answers with close code 1002.
func TestParseFrameRejectsMalformed(t *testing.T) {
	bad := []string{
		``,
		`not json`,
		`[1,2,3]`,
		`"a string"`,
		`{"no":"type"}`,
		`{"type":123}`,
		`null`,
	}
	for _, raw := range bad {
		if f, err := ParseFrame([]byte(raw)); err == nil {
			t.Errorf("ParseFrame(%q) = %+v, nil error; want a protocol error", raw, f)
		}
	}
}

// TestValidateHello covers §8.4.1: the first frame must be a hello with
// version 1, a non-blank 1–64 character clientName and a capabilities object.
func TestValidateHello(t *testing.T) {
	good, err := ParseFrame([]byte(`{"type":"hello","version":1,"clientName":"DESKTOP-7F3A","capabilities":{"tools":["codex"]}}`))
	if err != nil {
		t.Fatalf("ParseFrame returned error: %v", err)
	}
	if err := good.ValidateHello(); err != nil {
		t.Fatalf("ValidateHello(valid) returned error: %v", err)
	}

	// §9.5: an empty tools list is accepted and the connection stays up; the
	// relay then trims sessions.list to an empty list.
	emptyTools, _ := ParseFrame([]byte(`{"type":"hello","version":1,"clientName":"DESKTOP","capabilities":{"tools":[]}}`))
	if err := emptyTools.ValidateHello(); err != nil {
		t.Fatalf("ValidateHello(empty tools) returned error: %v; §9.5 accepts it", err)
	}

	bad := []string{
		`{"type":"hello","version":2,"clientName":"DESKTOP","capabilities":{}}`,
		`{"type":"hello","clientName":"DESKTOP","capabilities":{}}`,
		`{"type":"hello","version":1,"clientName":"","capabilities":{}}`,
		`{"type":"hello","version":1,"clientName":"   ","capabilities":{}}`,
		`{"type":"hello","version":1,"capabilities":{}}`,
	}
	for _, raw := range bad {
		f, err := ParseFrame([]byte(raw))
		if err != nil {
			t.Fatalf("ParseFrame(%s) returned error: %v", raw, err)
		}
		if err := f.ValidateHello(); err == nil {
			t.Errorf("ValidateHello(%s) = nil, want an error", raw)
		}
	}

	// clientName longer than 64 characters is refused.
	long := make([]byte, 65)
	for i := range long {
		long[i] = 'a'
	}
	raw, _ := json.Marshal(map[string]any{"type": "hello", "version": 1, "clientName": string(long), "capabilities": map[string]any{}})
	f, err := ParseFrame(raw)
	if err != nil {
		t.Fatalf("ParseFrame(long clientName) returned error: %v", err)
	}
	if err := f.ValidateHello(); err == nil {
		t.Error("ValidateHello(65-character clientName) = nil, want an error")
	}
}
