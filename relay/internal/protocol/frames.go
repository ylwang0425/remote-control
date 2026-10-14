package protocol

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"strings"
	"unicode"
	"unicode/utf8"
)

// FrameType is the value of a frame's `type` field (contract §8.3).
type FrameType string

const (
	FrameHello       FrameType = "hello"
	FrameHelloOK     FrameType = "hello.ok"
	FramePing        FrameType = "ping"
	FramePong        FrameType = "pong"
	FramePairCreate  FrameType = "pair.create"
	FramePairCreated FrameType = "pair.created"
	FramePairUsed    FrameType = "pair.used"
	FrameRequest     FrameType = "request"
	FrameResponse    FrameType = "response"
)

// Capabilities is the bridge's declaration from §9.5. A key that is absent
// reads as false — there is no default-allow.
//
// Optional per-method and per-tool fields are additive: a desktop that does not
// send a key is not declaring that capability, and an older relay ignores keys
// it does not know. The wire version stays 1 for exactly that reason.
//
// Per-tool keys remain separate declarations. Codex, DSH and WorkBuddy can
// have different model, stop, question and approval routes. Collapsing them
// would make the relay — or, worse, the phone — infer which operation is
// really available, and an inferred capability is how a button appears that
// cannot work.
//
// These fields describe the desktop's OWN declaration. Nothing here is ever
// derived by the relay from the tool name, from a session, or from a version
// number: an absent key is false, and a false key means the phone must show the
// real pending state plus an instruction to act at the computer, never a
// button.
type Capabilities struct {
	SessionsList  bool `json:"sessions.list"`
	SessionRead   bool `json:"session.read"`
	SessionSend   bool `json:"session.send"`
	SessionStop   bool `json:"session.stop"`
	ModelsList    bool `json:"models.list"`
	SessionCreate bool `json:"session.create"`
	// Optional per-tool overrides distinguish a readable local archive from a
	// tool that can continue a conversation. Nil preserves legacy clients; an
	// explicit false must survive hello, storage and the admin roster.
	SendCodex     *bool    `json:"session.send:codex,omitempty"`
	SendWorkBuddy *bool    `json:"session.send:workbuddy,omitempty"`
	StopCodex     bool     `json:"stop:codex"`
	StopDSH       bool     `json:"stop:dsh"`
	StopWorkBuddy *bool    `json:"stop:workbuddy,omitempty"`
	Tools         []string `json:"tools"`

	// A per-message model can be carried through the selected tool's send path.
	SendModelCodex         bool  `json:"session.send:model:codex"`
	SendModelDSH           bool  `json:"session.send:model:dsh"`
	SendModelWorkBuddy     *bool `json:"session.send:model:workbuddy,omitempty"`
	ModelsListWorkBuddy    *bool `json:"models.list:workbuddy,omitempty"`
	SessionCreateWorkBuddy *bool `json:"session.create:workbuddy,omitempty"`
	BackgroundWorkBuddy    *bool `json:"workbuddy.background,omitempty"`
	// session.answer can answer a real pending question on the named tool.
	AnswerCodex     bool  `json:"session.answer:codex"`
	AnswerDSH       bool  `json:"session.answer:dsh"`
	AnswerWorkBuddy *bool `json:"session.answer:workbuddy,omitempty"`
	// session.approve can answer a genuine native permission request on the
	// named tool.
	ApproveCodex     bool  `json:"session.approve:codex"`
	ApproveDSH       bool  `json:"session.approve:dsh"`
	ApproveWorkBuddy *bool `json:"session.approve:workbuddy,omitempty"`

	// ToolStatus preserves explicit discovery results for installed providers
	// that are temporarily unavailable. Missing entries use membership in Tools.
	ToolStatus map[string]ToolStatus `json:"toolStatus,omitempty"`
}

type ToolStatus struct {
	Available bool   `json:"available"`
	Reason    string `json:"reason,omitempty"`
}

// Frame carries every field any frame in §8.3 may use. One struct keeps the
// relay free of per-direction types while the JSON tags stay authoritative.
type Frame struct {
	Type FrameType `json:"type"`

	Version      int           `json:"version"`
	ClientID     string        `json:"clientId"`
	OwnerName    string        `json:"ownerName"`
	ClientName   string        `json:"clientName"`
	Capabilities *Capabilities `json:"capabilities"`

	ID         string `json:"id"`
	Code       string `json:"code"`
	ExpiresAt  string `json:"expiresAt"`
	URL        string `json:"url"`
	CodeID     string `json:"codeId"`
	DeviceName string `json:"deviceName"`
	At         string `json:"at"`

	Method    string          `json:"method"`
	Params    json.RawMessage `json:"params"`
	TimeoutMs int             `json:"timeoutMs"`

	OK     *bool           `json:"ok"`
	Result json.RawMessage `json:"result"`
	Error  *ErrorBody      `json:"error"`
}

// ParseFrame decodes one text frame. It fails only for the cases §8.5 calls a
// protocol error: not JSON, not an object, or no string `type`. An unknown
// type parses fine and is the caller's cue to ignore the frame.
func ParseFrame(data []byte) (*Frame, error) {
	trimmed := bytes.TrimSpace(data)
	if len(trimmed) == 0 {
		return nil, errors.New("empty frame")
	}
	if trimmed[0] != '{' {
		return nil, errors.New("frame is not a json object")
	}
	// Decode into a map first so a `type` that is present but not a string is a
	// protocol error rather than a silently empty type.
	var raw map[string]json.RawMessage
	if err := json.Unmarshal(trimmed, &raw); err != nil {
		return nil, fmt.Errorf("frame is not valid json: %w", err)
	}
	rawType, ok := raw["type"]
	if !ok {
		return nil, errors.New("frame has no type field")
	}
	var frameType string
	if err := json.Unmarshal(rawType, &frameType); err != nil || frameType == "" {
		return nil, errors.New("frame type is not a non-empty string")
	}
	var f Frame
	if err := json.Unmarshal(trimmed, &f); err != nil {
		return nil, fmt.Errorf("frame fields are malformed: %w", err)
	}
	return &f, nil
}

// ValidateHello applies §8.4.1. An empty `tools` list is deliberately valid:
// §9.5 wants a machine with no configured session source to look like "paired
// but empty", never like a failed connection.
func (f *Frame) ValidateHello() error {
	if f.Version != Version {
		return fmt.Errorf("hello version %d is not supported (want %d)", f.Version, Version)
	}
	if f.Capabilities == nil {
		return errors.New("hello has no capabilities object")
	}
	if !IsHostnameLabel(f.ClientName) {
		return errors.New("hello clientName is not a hostname label")
	}
	if f.ClientID != "" && !IsCanonicalUUID(f.ClientID) {
		return errors.New("hello clientId is not a canonical UUID")
	}
	if f.OwnerName != "" {
		name := strings.TrimSpace(f.OwnerName)
		if name == "" || utf8.RuneCountInString(name) > 64 {
			return errors.New("hello ownerName is invalid")
		}
		for _, r := range name {
			if unicode.IsControl(r) {
				return errors.New("hello ownerName contains a control character")
			}
		}
	}
	if len(f.Capabilities.ToolStatus) > 3 {
		return errors.New("hello capabilities.toolStatus has too many entries")
	}
	for id, status := range f.Capabilities.ToolStatus {
		if !IsSupportedTool(id) {
			return errors.New("hello capabilities.toolStatus has an unknown tool id")
		}
		if utf8.RuneCountInString(status.Reason) > 500 {
			return errors.New("hello capabilities.toolStatus reason is too long")
		}
		for _, r := range status.Reason {
			if unicode.IsControl(r) {
				return errors.New("hello capabilities.toolStatus reason contains a control character")
			}
		}
	}
	return nil
}

var (
	canonicalUUIDPattern = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)
	hostnameLabelPattern = regexp.MustCompile(`^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$`)
)

// IsCanonicalUUID accepts one lower-case, hyphenated UUID without imposing a
// UUID version. Native desktop identity IDs are generated as v4, while clients
// may already have a stable canonical UUID from another source.
func IsCanonicalUUID(s string) bool { return canonicalUUIDPattern.MatchString(s) }

// IsHostnameLabel accepts one DNS hostname label, not a dotted FQDN.
func IsHostnameLabel(s string) bool { return hostnameLabelPattern.MatchString(s) }
