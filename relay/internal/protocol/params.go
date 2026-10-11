package protocol

import (
	"encoding/json"
	"regexp"
	"strings"
	"unicode/utf8"
)

// Methods is the closed set of methods the phone may call. The first four are
// §7.3's original set and their meaning is unchanged; the middle two are CRD
// 0006's extension; the last two — session.answer and session.approve — are the
// mobile workbench's answer/approval surface.
//
// There is still no method that runs a shell. "Create a session" means "ask the
// desktop application to make one in its own window", and the relay has no way
// to express anything else: no command field, no callerSource escape hatch, and
// the params whitelist below is closed.
//
// session.answer and session.approve are deliberately NOT a generic door onto
// the desktop's native RPC surface: each names one operation, takes only the
// fields that operation needs, and the desktop is free to answer not_capable.
// A tool name, a callId or a question string never selects native code — the
// desktop looks the request up in its own live table.
var Methods = []string{
	"sessions.list", "session.read", "session.send", "session.stop",
	"models.list", "session.create", "session.answer", "session.approve",
}

// Field ceilings for the extension's opaque fields. They are generous on
// purpose: the relay does not own any of these namespaces, so the only job here
// is to keep a value bounded and free of control characters. A provider name, a
// Windows path and a native project id must all survive untouched.
const (
	maxModelRunes     = 200
	maxProviderRunes  = 128
	maxEffortRunes    = 64
	maxCwdRunes       = 1024
	maxProjectIDRunes = 256
	// maxCallIDRunes bounds the native identifiers the answer and approval
	// calls name: a batch id, a question id inside a batch, and an approval's
	// optional callId. Same ceiling as sessionId, because both are the same
	// kind of opaque native id and neither belongs to the relay.
	maxCallIDRunes = 128
)

// MaxTextRunes is the §7.3 limit for params.text, counted in Unicode code points.
const MaxTextRunes = 16384

// SessionIDPattern is §4.1's sessionId shape.
var SessionIDPattern = regexp.MustCompile(`^[A-Za-z0-9._:-]{1,128}$`)

func isKnownMethod(method string) bool {
	for _, m := range Methods {
		if m == method {
			return true
		}
	}
	return false
}

// methodFields is the per-method params whitelist. One extra field is
// invalid_params — that is the whole point of a whitelist — even though extra
// fields in results and frames are ignored (§12.4 applies there, not here).
//
// session.send's last three are CRD 0008's addition and are all optional: a
// request that omits them is the pre-existing call and behaves the same way.
//
// session.answer and session.approve name exactly one operation each. There is
// no generic passthrough field here — no "method", no "rpc", no "command" — for
// the same reason session.create has no shell field: an escape hatch would hand
// the phone the desktop's whole native surface through a whitelist that claims
// to be closed.
var methodFields = map[string][]string{
	"sessions.list":   {"tool"},
	"session.read":    {"tool", "sessionId"},
	"session.send":    {"tool", "sessionId", "text", "model", "provider", "reasoningEffort"},
	"session.stop":    {"tool", "sessionId"},
	"models.list":     {"tool"},
	"session.create":  {"tool", "model", "provider", "reasoningEffort", "cwd", "projectId", "text", "requestId"},
	"session.answer":  {"tool", "sessionId", "callId", "answers"},
	"session.approve": {"tool", "sessionId", "approvalId", "decision"},
}

// ValidateParams checks a request's params against the per-method whitelist and
// reports the stable code to answer with when it does not fit.
func ValidateParams(method string, params json.RawMessage) (Code, bool) {
	if !isKnownMethod(method) {
		return CodeUnknownMethod, false
	}
	if len(params) == 0 {
		params = json.RawMessage(`{}`)
	}
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(params, &fields); err != nil {
		return CodeInvalidParams, false
	}

	allowed := make(map[string]bool, len(methodFields[method]))
	for _, name := range methodFields[method] {
		allowed[name] = true
	}
	for name := range fields {
		if !allowed[name] {
			return CodeInvalidParams, false
		}
	}

	tool, hasTool, ok := stringField(fields, "tool")
	if !ok {
		return CodeInvalidParams, false
	}
	if hasTool && !IsSupportedTool(tool) {
		return CodeInvalidParams, false
	}

	switch method {
	case "sessions.list":
		// tool optional; sessionId and text must be absent (already enforced).
		return "", true

	case "models.list":
		// tool required.
		if !hasTool {
			return CodeInvalidParams, false
		}
		return "", true

	case "session.read", "session.stop", "session.send":
		if !hasTool {
			return CodeInvalidParams, false
		}
		sessionID, ok := requiredString(fields, "sessionId", maxSessionIDRunes)
		if !ok || !SessionIDPattern.MatchString(sessionID) {
			return CodeInvalidParams, false
		}
		if method == "session.send" {
			return validateSend(fields, tool)
		}
		return "", true

	case "session.answer", "session.approve":
		if !hasTool {
			return CodeInvalidParams, false
		}
		sessionID, ok := requiredString(fields, "sessionId", maxSessionIDRunes)
		if !ok || !SessionIDPattern.MatchString(sessionID) {
			return CodeInvalidParams, false
		}
		if method == "session.answer" {
			return validateAnswer(fields)
		}
		return validateApprove(fields)

	case "session.create":
		return validateSessionCreate(fields, tool)
	}
	return CodeInvalidParams, false
}

// validateSend applies session.send's rules: §7.3's original text rule first,
// then CRD 0008's three optional model fields.
func validateSend(fields map[string]json.RawMessage, tool string) (Code, bool) {
	if code, ok := validateSendText(fields); !ok {
		return code, false
	}
	return validateSendModel(fields, tool)
}

// validateSendModel checks CRD 0008's additive fields: model, provider and
// reasoningEffort, all optional.
//
// It validates shape and combinations, and does NOTHING else. Which provider
// really owns which model, and which effort levels a model really offers, is
// the computer's answer — the catalogue lives there and changes without the
// relay hearing about it — so hardcoding any of it here would be the relay
// inventing knowledge it does not have. The namespaces are opaque: a provider
// name may contain `/`, `-`, `_`, `.` or `:`.
//
// Two rules are structural, and both exist to stop a request landing somewhere
// the user did not choose:
//
//  1. A routing field with no model to route is a client bug. Letting it
//     through would leave the desktop to guess which model the user meant, and a
//     silently ignored routing field is exactly how a message lands on the wrong
//     model.
//  2. The provider half is per tool. DSH's catalogue can hold one model id under
//     several providers, so a DSH model choice without a provider is ambiguous
//     and is refused. Codex has exactly one route, so a provider there is a
//     client bug rather than a preference, and is refused rather than dropped.
//     Refusing is the safer half of that choice: a silently dropped provider is
//     how a Codex message would quietly go to the default provider instead.
func validateSendModel(fields map[string]json.RawMessage, tool string) (Code, bool) {
	present := map[string]bool{}
	for _, name := range []struct {
		field string
		max   int
	}{
		{"model", maxModelRunes},
		{"provider", maxProviderRunes},
		{"reasoningEffort", maxEffortRunes},
	} {
		// stringField reports present-but-not-a-string as a failure, so a null,
		// a number or a boolean here is invalid_params rather than a field the
		// relay quietly drops.
		value, has, ok := stringField(fields, name.field)
		if !ok {
			return CodeInvalidParams, false
		}
		if !has {
			continue
		}
		if !printableField(value, name.max) {
			return CodeInvalidParams, false
		}
		present[name.field] = true
	}

	if !present["model"] {
		if present["provider"] || present["reasoningEffort"] {
			return CodeInvalidParams, false
		}
		// No model chosen at all is the pre-existing call: it means "keep
		// using whatever this session already uses".
		return "", true
	}
	switch tool {
	case "dsh":
		if !present["provider"] {
			return CodeInvalidParams, false
		}
	case "codex":
		if present["provider"] {
			return CodeInvalidParams, false
		}
	case "workbuddy":
		if present["provider"] {
			return CodeInvalidParams, false
		}
	}
	return "", true
}

// validateSendText keeps the original §7.3 rule for session.send: present,
// non-blank, at most MaxTextRunes code points, no NUL.
func validateSendText(fields map[string]json.RawMessage) (Code, bool) {
	text, ok := stringFieldValue(fields, "text")
	if !ok {
		return CodeInvalidParams, false
	}
	if utf8.RuneCountInString(text) > MaxTextRunes {
		return CodeTooLong, false
	}
	if strings.ContainsRune(text, 0) || strings.TrimSpace(text) == "" {
		return CodeInvalidParams, false
	}
	return "", true
}

// validateSessionCreate applies CRD 0006's rules for the extension's create
// call.
//
// provider is a routing field, not a display one: the same model id can exist
// under several DSH providers, so DSH requires it. Codex has exactly one route,
// so a provider there is a client bug and is refused rather than silently
// ignored — a silently dropped routing field is how a request lands on the
// wrong provider.
//
// projectId and cwd are both accepted together, and the relay does NOT compare
// them. It cannot: the genuine project list lives on the computer, so a rule
// here would be guessing at a mapping the relay has never seen. The desktop
// owns that check — it validates the selected projectId against its fresh
// native project list, refuses a cwd that contradicts the cwd of that genuine
// project before anything native is created, and then sends the native create
// request with workspaceId only. The relay's share is to keep both fields
// intact, bounded and free of control characters, which is what it does here.
func validateSessionCreate(fields map[string]json.RawMessage, tool string) (Code, bool) {
	if !IsSupportedTool(tool) {
		return CodeInvalidParams, false
	}
	if _, ok := requiredString(fields, "model", maxModelRunes); !ok {
		return CodeInvalidParams, false
	}
	if _, ok := requiredString(fields, "requestId", 36); !ok {
		return CodeInvalidParams, false
	}
	requestID, _ := stringFieldValue(fields, "requestId")
	if !IsUUIDv4(requestID) {
		return CodeInvalidParams, false
	}

	_, hasProvider, ok := stringField(fields, "provider")
	if !ok {
		return CodeInvalidParams, false
	}
	if hasProvider {
		// The provider NAME is opaque to the relay, but it still has to be a
		// bounded string with no control characters: it travels in a frame and
		// may end up in an error message.
		provider, _ := stringFieldValue(fields, "provider")
		if !printableField(provider, maxProviderRunes) {
			return CodeInvalidParams, false
		}
	}
	switch tool {
	case "dsh":
		if !hasProvider {
			return CodeInvalidParams, false
		}
	case "codex":
		if hasProvider {
			return CodeInvalidParams, false
		}
	case "workbuddy":
		if hasProvider {
			return CodeInvalidParams, false
		}
	}

	for _, optional := range []struct {
		name string
		max  int
	}{
		{"reasoningEffort", maxEffortRunes},
		{"cwd", maxCwdRunes},
		{"projectId", maxProjectIDRunes},
	} {
		if _, present := fields[optional.name]; !present {
			continue
		}
		if _, ok := requiredString(fields, optional.name, optional.max); !ok {
			return CodeInvalidParams, false
		}
	}

	if raw, present := fields["text"]; present {
		var text string
		if err := json.Unmarshal(raw, &text); err != nil {
			return CodeInvalidParams, false
		}
		if utf8.RuneCountInString(text) > MaxTextRunes {
			return CodeTooLong, false
		}
		if strings.ContainsRune(text, 0) {
			return CodeInvalidParams, false
		}
		// A blank first message is allowed: the field is optional, and the
		// desktop treats an absent and an empty one the same way.
	}
	return "", true
}

// IsSupportedTool is the relay's closed tool ID set. WorkBuddy is a native
// session source with the same bounded method/result contract as Codex and DSH.
func IsSupportedTool(tool string) bool {
	return tool == "codex" || tool == "dsh" || tool == "workbuddy"
}

// stringField decodes an optional string field. It reports whether the field was
// present, and false when a present field is not a string.
func stringField(fields map[string]json.RawMessage, name string) (value string, present bool, ok bool) {
	raw, found := fields[name]
	if !found {
		return "", false, true
	}
	var s string
	if err := json.Unmarshal(raw, &s); err != nil {
		return "", true, false
	}
	return s, true, true
}

// stringFieldValue decodes a field that must be present and a string.
func stringFieldValue(fields map[string]json.RawMessage, name string) (string, bool) {
	raw, found := fields[name]
	if !found {
		return "", false
	}
	var s string
	if err := json.Unmarshal(raw, &s); err != nil {
		return "", false
	}
	return s, true
}

// requiredString decodes a field that must be present, a string, non-blank and
// bounded.
func requiredString(fields map[string]json.RawMessage, name string, maxRunes int) (string, bool) {
	s, ok := stringFieldValue(fields, name)
	if !ok {
		return "", false
	}
	if !printableField(s, maxRunes) {
		return "", false
	}
	return s, true
}

// printableField is the extension's only content rule for the fields the relay
// does not own: present, non-blank, bounded, and free of control characters.
//
// It is deliberately permissive. A provider name may contain `.`, `-`, `_`, `/`
// and `:`; a Windows cwd contains `\` and `:`; a native project id may contain
// nearly anything. None of those namespaces belongs to the relay, so guessing at
// their grammar would only break the desktop. What the relay does refuse is a
// value that could forge a log line or a response.
func printableField(s string, maxRunes int) bool {
	if strings.TrimSpace(s) == "" {
		return false
	}
	if utf8.RuneCountInString(s) > maxRunes {
		return false
	}
	for _, r := range s {
		if r < 0x20 || r == 0x7f {
			return false
		}
	}
	return true
}

// maxSessionIDRunes mirrors the sessionId ceiling in SessionIDPattern.
const maxSessionIDRunes = 128

// DefaultTimeoutMs returns the per-method budget. The original four keep the
// §7.3 values exactly; the extension's two follow the same split — a listing
// gets 15 s, a call that makes something happen gets 30 s.
func DefaultTimeoutMs(method string) int {
	switch method {
	case "sessions.list", "session.read", "models.list":
		return 15000
	default:
		return 30000
	}
}

// ClampTimeoutMs applies §7.3: a client-supplied budget is clamped to
// 1000–60000 ms. A missing or nonsensical value takes the method default.
func ClampTimeoutMs(ms, def int) int {
	if ms <= 0 {
		return def
	}
	if ms < 1000 {
		return 1000
	}
	if ms > 60000 {
		return 60000
	}
	return ms
}
