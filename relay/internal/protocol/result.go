package protocol

import (
	"bytes"
	"encoding/json"
	"strings"
	"time"
	"unicode"
)

// The wire shapes of §9. The relay decodes a bridge result into these only to
// check that the required fields are present and well typed; it forwards the
// original bytes, so a field this build has never heard of survives (§12.4).

type sessionSummary struct {
	ID        *string `json:"id"`
	Tool      *string `json:"tool"`
	Title     *string `json:"title"`
	Status    *string `json:"status"`
	UpdatedAt *string `json:"updatedAt"`
	// RawMessage, not *RawMessage: a pointer is nil for an explicit `null`,
	// which would make "absent" and "null" indistinguishable. §9.1 requires
	// the key to be present and allows it to be null.
	Cwd json.RawMessage `json:"cwd"`

	// NeedsInput is the desktop's honest answer to "is this session waiting on
	// the user right now", and it is the ONLY thing the phone's badge may read.
	// It is derived natively — from a live pending question or a live pending
	// permission request — and it is deliberately optional: a desktop that
	// cannot tell omits it, and an omitted value is not "false", it is
	// "unknown", so the phone shows no badge rather than a wrong one.
	//
	// For the same reason this is a RawMessage and not a *bool: a pointer would
	// make `null` and "omitted" the same thing, and `null` here is a protocol
	// error (§9.2's rule for a field that must be omitted rather than nulled).
	// The relay does not infer it, does not default it and does not rewrite it.
	NeedsInput json.RawMessage `json:"needsInput"`
}

type sessionsListResult struct {
	Sessions     *[]sessionSummary `json:"sessions"`
	Capabilities json.RawMessage   `json:"capabilities"`
}

type messageItem struct {
	ID        *string `json:"id"`
	Role      *string `json:"role"`
	Text      *string `json:"text"`
	Timestamp *string `json:"timestamp"`
}

type sessionReadResult struct {
	ID       *string        `json:"id"`
	Tool     *string        `json:"tool"`
	Title    *string        `json:"title"`
	Status   *string        `json:"status"`
	Messages *[]messageItem `json:"messages"`
	CanStop  *bool          `json:"canStop"`
	// Optional. Absent means the key was omitted; `null` is a protocol error
	// because §9.2 says the field must be omitted rather than nulled.
	ActiveTurnID json.RawMessage `json:"activeTurnId"`

	// HistoryTruncated is CRD 0007's additive flag: the desktop says out loud
	// that it shortened the history to fit the frame budget, so the phone can
	// tell "that is all there is" apart from "that is all that fitted".
	//
	// Optional, and omitted is legal — an older desktop does not send it. It is
	// a RawMessage rather than a *bool on purpose: a pointer is nil for an
	// explicit JSON null, which would make "omitted" and "nulled" the same
	// thing. The relay does not infer the flag, does not default it and does not
	// rewrite it; it passes it through exactly as received, the same principle
	// capabilities follow.
	HistoryTruncated json.RawMessage `json:"historyTruncated"`

	// CurrentModel is CRD 0008's additive report of the model the desktop's own
	// session is really set to: {model, provider?, reasoningEffort?}, taken from
	// native state.
	//
	// Optional, and omitted is the honest value — a desktop that cannot read its
	// own selection, and every older desktop, simply does not send it. The relay
	// does not default it, does not infer it and does not rewrite it; a raw
	// member keeps "omitted" and "present" apart so the first stays legal while
	// the second has to be well shaped.
	CurrentModel json.RawMessage `json:"currentModel"`

	// PendingQuestions is the desktop's projection of the questions its session
	// is genuinely blocked on right now — a real live form, not a suggestion.
	//
	// Optional, and omitted is the honest value for a session with nothing
	// pending and for every desktop that cannot read its native pending state.
	// `[]` and an absent key therefore mean different things and both are legal:
	// absent says "I have no projection to offer", `[]` says "I looked, and
	// there is nothing pending".
	//
	// The relay checks the projection's bounds and passes it through otherwise
	// untouched. It never synthesises a question, never fills in an option list
	// and never invents a default selection: the answer UI is built from
	// exactly what the desktop sent, and a form the desktop could not represent
	// within these bounds is refused rather than shown incomplete.
	PendingQuestions json.RawMessage `json:"pendingQuestions"`

	// PendingApprovals is the desktop's projection of the genuine native
	// permission requests that are waiting on a person right now.
	//
	// It is a SEPARATE projection from pendingQuestions on purpose. A security
	// permission approval and an AI's ordinary clarifying question are
	// different native events with different transports, different outcomes and
	// very different consequences; rendering one as the other is how a phone
	// ends up telling someone they answered a permission prompt when they
	// merely chose a chat option. Omitted, `[]` and present mean exactly what
	// they mean for pendingQuestions.
	PendingApprovals json.RawMessage `json:"pendingApprovals"`
}

type acceptedResult struct {
	Accepted  *bool   `json:"accepted"`
	SessionID *string `json:"sessionId"`
}

// The answer and approval acknowledgements.
//
// `accepted:true` here means "the desktop took responsibility for this
// submission". For an approval it is deliberately weaker than "access was
// granted": the desktop can hand the outcome to a gateway that another client
// may have already answered, so the relay treats it as a submission receipt and
// nothing more. A phone must re-read native state to learn what really
// happened, and the relay never turns this shape into an "approved" claim.

type answerAcceptedResult struct {
	Accepted  *bool   `json:"accepted"`
	SessionID *string `json:"sessionId"`
	CallID    *string `json:"callId"`
	// State is optional for older desktops. When present, it distinguishes
	// transport submission from native proof of this exact answer.
	State json.RawMessage `json:"state"`
}

type approveAcceptedResult struct {
	Accepted   *bool   `json:"accepted"`
	SessionID  *string `json:"sessionId"`
	ApprovalID *string `json:"approvalId"`
	// State is the desktop's own account of how far the submission got:
	// "submitted" is transport-level only, "confirmed" requires a real native
	// audit of the outcome. Anything else is a shape error — the relay does not
	// accept a third value and does not default one, because "unknown" must not
	// be displayable as either.
	State *string `json:"state"`
}

const (
	approvalStateSubmitted = "submitted"
	approvalStateConfirmed = "confirmed"
)

// The pendingQuestions projection, decoded only to be bounded and type-checked.

type questionOption struct {
	Label       *string `json:"label"`
	Description *string `json:"description"`
}

type pendingQuestion struct {
	ID          *string           `json:"id"`
	Question    *string           `json:"question"`
	Header      *string           `json:"header"`
	Detail      *string           `json:"detail"`
	Options     *[]questionOption `json:"options"`
	MultiSelect *bool             `json:"multiSelect"`
	AllowCustom json.RawMessage   `json:"allowCustom"`
}

type pendingQuestionBatch struct {
	CallID    *string            `json:"callId"`
	State     *string            `json:"state"`
	Questions *[]pendingQuestion `json:"questions"`
}

// The pendingApprovals projection.

type pendingApproval struct {
	ID       *string         `json:"id"`
	ToolName *string         `json:"toolName"`
	CallID   *string         `json:"callId"`
	Reason   *string         `json:"reason"`
	Context  json.RawMessage `json:"context"`
}

type approvalContext struct {
	Kind        *string         `json:"kind"`
	Command     *string         `json:"command"`
	Cwd         *string         `json:"cwd"`
	NetworkHost *string         `json:"networkHost"`
	Protocol    *string         `json:"protocol"`
	NetworkPort json.RawMessage `json:"networkPort"`
	Summary     *string         `json:"summary"`
	GrantRoot   *string         `json:"grantRoot"`
}

// The two shapes CRD 0006 adds.

type modelEntry struct {
	ID                     *string  `json:"id"`
	Label                  *string  `json:"label"`
	Provider               *string  `json:"provider"`
	IsDefault              *bool    `json:"isDefault"`
	ReasoningEfforts       []string `json:"reasoningEfforts"`
	DefaultReasoningEffort *string  `json:"defaultReasoningEffort"`
}

type projectEntry struct {
	ID   *string `json:"id"`
	Name *string `json:"name"`
	Cwd  *string `json:"cwd"`
}

type modelsListResult struct {
	Tool     *string         `json:"tool"`
	Models   *[]modelEntry   `json:"models"`
	Projects *[]projectEntry `json:"projects"`

	// Reason is the optional safe text a desktop sends when the tool is not
	// running. That case is a SUCCESS with an empty list, never an error —
	// §9.5's "paired but empty" precedent. `models: []` is what makes it
	// distinguishable from a real catalogue.
	Reason *string `json:"reason"`
}

type sessionCreateResult struct {
	SessionID       *string `json:"sessionId"`
	Tool            *string `json:"tool"`
	Title           *string `json:"title"`
	Model           *string `json:"model"`
	Provider        *string `json:"provider"`
	ReasoningEffort *string `json:"reasoningEffort"`
}

// ValidateResult checks a bridge result against the method's shape (§9). On
// failure the caller answers the phone with bridge_bad_response.
func ValidateResult(method string, result json.RawMessage) (Code, bool) {
	if _, ok := ValidateParams(method, json.RawMessage(`{}`)); !ok && !isKnownMethod(method) {
		return CodeBridgeBadResponse, false
	}
	if len(result) == 0 || !json.Valid(result) {
		return CodeBridgeBadResponse, false
	}
	switch method {
	case "sessions.list":
		var r sessionsListResult
		if err := json.Unmarshal(result, &r); err != nil {
			return CodeBridgeBadResponse, false
		}
		if r.Sessions == nil || len(r.Capabilities) == 0 {
			return CodeBridgeBadResponse, false
		}
		for _, s := range *r.Sessions {
			if s.ID == nil || !SessionIDPattern.MatchString(*s.ID) {
				return CodeBridgeBadResponse, false
			}
			if s.Tool == nil || !IsSupportedTool(*s.Tool) {
				return CodeBridgeBadResponse, false
			}
			if s.Title == nil || *s.Title == "" || len([]rune(*s.Title)) > 200 || containsNewline(*s.Title) {
				return CodeBridgeBadResponse, false
			}
			if !statusIsUsable(s.Status) {
				return CodeBridgeBadResponse, false
			}
			if s.UpdatedAt == nil || !isRFC3339(*s.UpdatedAt) {
				return CodeBridgeBadResponse, false
			}
			// cwd is required but may be an explicit null (§9.1).
			if len(s.Cwd) == 0 {
				return CodeBridgeBadResponse, false
			}
			if !isJSONNull(s.Cwd) {
				var cwd string
				if err := json.Unmarshal(s.Cwd, &cwd); err != nil {
					return CodeBridgeBadResponse, false
				}
			}
			// needsInput is optional, but a present one must be a real boolean:
			// `null` is not one, and accepting it would turn "the desktop
			// cannot tell" into "nothing is pending" — the one reading that
			// silently hides a question waiting for the user.
			if len(s.NeedsInput) > 0 && !isGenuineBool(s.NeedsInput) {
				return CodeBridgeBadResponse, false
			}
		}
		return "", true

	case "session.read":
		var r sessionReadResult
		if err := json.Unmarshal(result, &r); err != nil {
			return CodeBridgeBadResponse, false
		}
		if r.ID == nil || !SessionIDPattern.MatchString(*r.ID) {
			return CodeBridgeBadResponse, false
		}
		if r.Tool == nil || !IsSupportedTool(*r.Tool) {
			return CodeBridgeBadResponse, false
		}
		if r.Title == nil || *r.Title == "" || len([]rune(*r.Title)) > 200 || containsNewline(*r.Title) {
			return CodeBridgeBadResponse, false
		}
		if !statusIsUsable(r.Status) {
			return CodeBridgeBadResponse, false
		}
		if r.Messages == nil {
			return CodeBridgeBadResponse, false
		}
		if r.CanStop == nil {
			return CodeBridgeBadResponse, false
		}
		for _, m := range *r.Messages {
			if m.ID == nil || *m.ID == "" || len(*m.ID) > 128 {
				return CodeBridgeBadResponse, false
			}
			if !roleIsUsable(m.Role) {
				return CodeBridgeBadResponse, false
			}
			if m.Text == nil || len([]rune(*m.Text)) > 65536 {
				return CodeBridgeBadResponse, false
			}
			if m.Timestamp == nil || !isRFC3339(*m.Timestamp) {
				return CodeBridgeBadResponse, false
			}
		}
		// activeTurnId is optional, but when present it must be a string — §9.2
		// forbids `null` in its place.
		if len(r.ActiveTurnID) > 0 {
			if isJSONNull(r.ActiveTurnID) {
				return CodeBridgeBadResponse, false
			}
			var turn string
			if err := json.Unmarshal(r.ActiveTurnID, &turn); err != nil {
				return CodeBridgeBadResponse, false
			}
			if turn == "" || len(turn) > 128 {
				return CodeBridgeBadResponse, false
			}
		}
		// historyTruncated is optional too, but a present value must be a real
		// boolean: `null` is not one, and accepting it would silently turn
		// "unknown" into "known to be false" for the phone.
		if len(r.HistoryTruncated) > 0 {
			if isJSONNull(r.HistoryTruncated) {
				return CodeBridgeBadResponse, false
			}
			var truncated bool
			if err := json.Unmarshal(r.HistoryTruncated, &truncated); err != nil {
				return CodeBridgeBadResponse, false
			}
		}
		// currentModel is optional too, but a present one must be the object
		// CRD 0008 describes, with a real model string inside it: a null is not
		// one, and forwarding a half-filled object would tell the phone that the
		// session has a model when nobody ever read one.
		if len(r.CurrentModel) > 0 {
			if isJSONNull(r.CurrentModel) {
				return CodeBridgeBadResponse, false
			}
			var currentModel map[string]json.RawMessage
			if err := json.Unmarshal(r.CurrentModel, &currentModel); err != nil {
				return CodeBridgeBadResponse, false
			}
			model, ok := stringFieldValue(currentModel, "model")
			if !ok || !printableField(model, maxModelRunes) {
				return CodeBridgeBadResponse, false
			}
			// provider and reasoningEffort are optional; when present they are
			// strings, and `null` is not one — §9.2's rule for activeTurnId.
			for _, optional := range []struct {
				field string
				max   int
			}{
				{"provider", maxProviderRunes},
				{"reasoningEffort", maxEffortRunes},
			} {
				if _, present := currentModel[optional.field]; !present {
					continue
				}
				value, ok := stringFieldValue(currentModel, optional.field)
				if !ok || !printableField(value, optional.max) {
					return CodeBridgeBadResponse, false
				}
			}
		}
		// pendingQuestions and pendingApprovals are optional projections of
		// genuine native pending state. When present they must be representable
		// in full: an oversized or malformed form is refused so the phone never
		// renders a truncated question that the user would then "answer"
		// without ever having seen all of it.
		if len(r.PendingQuestions) > 0 {
			if !validPendingQuestions(r.PendingQuestions) {
				return CodeBridgeBadResponse, false
			}
		}
		if len(r.PendingApprovals) > 0 {
			if !validPendingApprovals(r.PendingApprovals, *r.Tool) {
				return CodeBridgeBadResponse, false
			}
		}
		return "", true

	case "session.send", "session.stop":
		var r acceptedResult
		if err := json.Unmarshal(result, &r); err != nil {
			return CodeBridgeBadResponse, false
		}
		// §9.3/§9.4: accepted is fixed true; failure is expressed with ok:false.
		if r.Accepted == nil || !*r.Accepted {
			return CodeBridgeBadResponse, false
		}
		if r.SessionID == nil || !SessionIDPattern.MatchString(*r.SessionID) {
			return CodeBridgeBadResponse, false
		}
		return "", true

	case "session.answer":
		var r answerAcceptedResult
		if err := json.Unmarshal(result, &r); err != nil {
			return CodeBridgeBadResponse, false
		}
		if r.Accepted == nil || !*r.Accepted {
			return CodeBridgeBadResponse, false
		}
		if r.SessionID == nil || !SessionIDPattern.MatchString(*r.SessionID) {
			return CodeBridgeBadResponse, false
		}
		// The acknowledgement must name the exact question batch it belongs to.
		// A result that echoed a different callId — or none — would leave the
		// phone unable to tell whether its own answer was the one accepted.
		if r.CallID == nil || !printableField(*r.CallID, maxCallIDRunes) {
			return CodeBridgeBadResponse, false
		}
		if len(r.State) > 0 {
			if isJSONNull(r.State) {
				return CodeBridgeBadResponse, false
			}
			var state string
			if err := json.Unmarshal(r.State, &state); err != nil {
				return CodeBridgeBadResponse, false
			}
			if state != approvalStateSubmitted && state != approvalStateConfirmed {
				return CodeBridgeBadResponse, false
			}
		}
		return "", true

	case "session.approve":
		var r approveAcceptedResult
		if err := json.Unmarshal(result, &r); err != nil {
			return CodeBridgeBadResponse, false
		}
		if r.Accepted == nil || !*r.Accepted {
			return CodeBridgeBadResponse, false
		}
		if r.SessionID == nil || !SessionIDPattern.MatchString(*r.SessionID) {
			return CodeBridgeBadResponse, false
		}
		if r.ApprovalID == nil || !IsUUIDv4(*r.ApprovalID) {
			return CodeBridgeBadResponse, false
		}
		// Only the two states the contract defines. In particular "confirmed"
		// is the desktop claiming it read a real native audit of the outcome;
		// the relay does not accept a third value and does not promote
		// "submitted" to "confirmed" anywhere, at any layer.
		if r.State == nil {
			return CodeBridgeBadResponse, false
		}
		switch *r.State {
		case approvalStateSubmitted, approvalStateConfirmed:
		default:
			return CodeBridgeBadResponse, false
		}
		return "", true

	case "models.list":
		var r modelsListResult
		if err := json.Unmarshal(result, &r); err != nil {
			return CodeBridgeBadResponse, false
		}
		if r.Tool == nil || !IsSupportedTool(*r.Tool) {
			return CodeBridgeBadResponse, false
		}
		if r.Models == nil {
			return CodeBridgeBadResponse, false
		}
		for _, m := range *r.Models {
			// id and label are the only required members; provider, isDefault,
			// reasoningEfforts and defaultReasoningEffort are optional and are
			// therefore only checked for type when present.
			if m.ID == nil || !printableField(*m.ID, maxModelRunes) {
				return CodeBridgeBadResponse, false
			}
			if m.Label == nil || !printableField(*m.Label, 200) {
				return CodeBridgeBadResponse, false
			}
			if m.Provider != nil && !printableField(*m.Provider, maxProviderRunes) {
				return CodeBridgeBadResponse, false
			}
			if m.DefaultReasoningEffort != nil && !printableField(*m.DefaultReasoningEffort, maxEffortRunes) {
				return CodeBridgeBadResponse, false
			}
			for _, effort := range m.ReasoningEfforts {
				if !printableField(effort, maxEffortRunes) {
					return CodeBridgeBadResponse, false
				}
			}
		}
		if r.Projects != nil {
			for _, p := range *r.Projects {
				if p.ID == nil || !printableField(*p.ID, maxProjectIDRunes) {
					return CodeBridgeBadResponse, false
				}
				if p.Name == nil || !printableField(*p.Name, 200) {
					return CodeBridgeBadResponse, false
				}
				// A Windows absolute path is a legitimate cwd.
				if p.Cwd == nil || !printableField(*p.Cwd, maxCwdRunes) {
					return CodeBridgeBadResponse, false
				}
			}
		}
		if r.Reason != nil && !printableField(*r.Reason, 200) {
			return CodeBridgeBadResponse, false
		}
		return "", true

	case "session.create":
		var r sessionCreateResult
		if err := json.Unmarshal(result, &r); err != nil {
			return CodeBridgeBadResponse, false
		}
		// A create either produced a session or it did not: there is no
		// `accepted` acknowledgement here, and a result without a sessionId is
		// not a success.
		if r.SessionID == nil || !SessionIDPattern.MatchString(*r.SessionID) {
			return CodeBridgeBadResponse, false
		}
		if r.Tool == nil || !IsSupportedTool(*r.Tool) {
			return CodeBridgeBadResponse, false
		}
		if r.Model == nil || !printableField(*r.Model, maxModelRunes) {
			return CodeBridgeBadResponse, false
		}
		if r.Title != nil && !printableField(*r.Title, 200) {
			return CodeBridgeBadResponse, false
		}
		if r.Provider != nil && !printableField(*r.Provider, maxProviderRunes) {
			return CodeBridgeBadResponse, false
		}
		if r.ReasoningEffort != nil && !printableField(*r.ReasoningEffort, maxEffortRunes) {
			return CodeBridgeBadResponse, false
		}
		return "", true
	}
	return CodeBridgeBadResponse, false
}

// statusIsUsable and roleIsUsable check that the value is present and not
// empty, and nothing else.
//
// §4.3 puts it plainly: "when an unknown value appears the relay does not
// rewrite it and does not guess — it passes it through". §4.4 says the same for
// role, and §12.4's fourth rule repeats it for both. So an enum check here would
// be a bug, and a serious one: the desktop would only have to gain one new
// status value for every session.read to start failing with
// bridge_bad_response — in a product whose whole job is to follow a desktop
// application that keeps evolving.
//
// The client is the one that decides what an unfamiliar value looks like: §4.3
// and §4.4 tell it to render the unknown value with the `error` / `system`
// styling without disabling anything.
//
// `tool`, by contrast, IS a closed set (§4.5), and stays checked.
func statusIsUsable(s *string) bool { return s != nil && *s != "" }

func roleIsUsable(s *string) bool { return s != nil && *s != "" }

func containsNewline(s string) bool {
	for _, r := range s {
		if r == '\n' || r == '\r' {
			return true
		}
	}
	return false
}

func isRFC3339(s string) bool {
	if _, err := time.Parse(time.RFC3339, s); err == nil {
		return true
	}
	_, err := time.Parse(time.RFC3339Nano, s)
	return err == nil
}

// isJSONNull reports whether a raw value is the JSON literal null.
func isJSONNull(raw json.RawMessage) bool {
	return string(bytes.TrimSpace(raw)) == "null"
}

// isGenuineBool reports whether a present raw value is a real JSON boolean, so
// `null` and `"true"` are both refused rather than coerced.
func isGenuineBool(raw json.RawMessage) bool {
	if len(raw) == 0 || isJSONNull(raw) {
		return false
	}
	var b bool
	return json.Unmarshal(raw, &b) == nil
}

// staleKeys are the keys the relay must never accept inside a projection
// object. They are the native-state names that a desktop could most easily leak
// by serialising a raw native object instead of its own narrow projection, and
// every one of them describes internal machinery the phone has no business
// receiving — a connection identity, a client identity, a host path, a raw
// request body, or a token.
//
// The set is stored lower-cased and lookups are lower-cased too, so `clientId`
// and `clientid` are both caught: the JS side of this product writes camelCase
// while the wire often carries snake_case, and a case-sensitive denylist would
// catch exactly one of the two.
//
// This is a denylist of *names*, checked recursively, and it is a belt to the
// braces of the projection's own field allowlist: an object carrying an unknown
// field is passed through untouched (that is the additive rule everywhere
// else), so the one thing that must not pass through is a field that would leak
// native transport internals into a phone.
var staleKeys = map[string]bool{
	"clientid":      true,
	"connectionid":  true,
	"host":          true,
	"home":          true,
	"token":         true,
	"secret":        true,
	"cookie":        true,
	"authorization": true,
	"request":       true,
	"raw":           true,
	"args":          true,
	"envelope":      true,
}

// sanitizedText reports whether a required display string is usable: present,
// non-blank after sanitising, and within its ceiling. The phone displays these
// strings verbatim, so an empty question or an empty option label is refused
// rather than rendered as a blank choice.
func sanitizedText(s *string, maxRunes int) bool {
	if s == nil {
		return false
	}
	return boundedRunes(*s, maxRunes)
}

// optionalSanitizedText checks a field that may be absent. Present means a
// string that sanitises to something non-blank and fits; absent is fine.
func optionalSanitizedText(s *string, maxRunes int) bool {
	if s == nil {
		return true
	}
	return boundedRunes(*s, maxRunes)
}

// containsStaleKeys walks a decoded projection object looking for the native
// transport names above, at any depth.
func containsStaleKeys(value any) bool {
	switch v := value.(type) {
	case map[string]any:
		for key, child := range v {
			if staleKeys[strings.ToLower(key)] {
				return true
			}
			if containsStaleKeys(child) {
				return true
			}
		}
	case []any:
		for _, child := range v {
			if containsStaleKeys(child) {
				return true
			}
		}
	}
	return false
}

// validPendingQuestions bounds the desktop's pendingQuestions projection.
//
// The rules are the contract's representable bounds: at most four batches, at
// most eight questions per batch, at most twelve options per question, and
// bounded strings. A form that does not fit is refused — honestly, with
// bridge_bad_response — rather than trimmed into a form the user cannot see all
// of. Every question must carry a non-empty id and question text, because those
// are what the answer call must name, and every option must carry a non-empty
// label, because that label is what the answer call must send back.
//
// state is checked, not defaulted: an "open" or "continued" question is live,
// and anything else is a shape the relay does not understand well enough to
// hand to a person as answerable.
func validPendingQuestions(raw json.RawMessage) bool {
	if isJSONNull(raw) || len(raw) > maxProjectionBytes {
		return false
	}
	var probe any
	if err := json.Unmarshal([]byte(raw), &probe); err != nil {
		return false
	}
	if containsStaleKeys(probe) {
		return false
	}
	var batches []pendingQuestionBatch
	if err := json.Unmarshal([]byte(raw), &batches); err != nil {
		return false
	}
	if len(batches) > maxPendingQuestionBatches {
		return false
	}
	for _, batch := range batches {
		if batch.CallID == nil || !printableField(*batch.CallID, maxCallIDRunes) {
			return false
		}
		if batch.State == nil || !questionStateKnown(*batch.State) {
			return false
		}
		if batch.Questions == nil {
			return false
		}
		if len(*batch.Questions) == 0 || len(*batch.Questions) > maxQuestionsPerBatch {
			return false
		}
		for _, question := range *batch.Questions {
			if question.ID == nil || !printableField(*question.ID, maxCallIDRunes) {
				return false
			}
			if !sanitizedText(question.Question, maxQuestionRunes) {
				return false
			}
			if !optionalSanitizedText(question.Header, maxQuestionHeaderRunes) {
				return false
			}
			if !optionalSanitizedText(question.Detail, maxOptionDetailRunes) {
				return false
			}
			if len(question.AllowCustom) > 0 {
				if isJSONNull(question.AllowCustom) {
					return false
				}
				var allowCustom bool
				if err := json.Unmarshal(question.AllowCustom, &allowCustom); err != nil {
					return false
				}
			}
			if question.Options != nil {
				if len(*question.Options) > maxOptionsPerQuestion {
					return false
				}
				for _, option := range *question.Options {
					if !sanitizedText(option.Label, maxOptionLabelRunes) {
						return false
					}
					if !optionalSanitizedText(option.Description, maxOptionDetailRunes) {
						return false
					}
				}
			}
		}
	}
	return true
}

// questionStateKnown reports whether a batch state is one the relay can hand to
// a person as answerable.
func questionStateKnown(state string) bool {
	switch state {
	case "open", "continued":
		return true
	default:
		return false
	}
}

// validPendingApprovals bounds the desktop's pendingApprovals projection.
//
// id is the desktop gateway's own live event id and is the only value the
// approve call may name, so its shape is required; the ID itself is never
// validated against a local idea of "pending" — that map lives on the computer.
// toolName is what the person is being asked to permit, so it must be present
// and readable; a request whose tool name cannot be shown must not be turned
// into a button.
func validPendingApprovals(raw json.RawMessage, tool string) bool {
	if isJSONNull(raw) || len(raw) > maxProjectionBytes {
		return false
	}
	var probe any
	if err := json.Unmarshal([]byte(raw), &probe); err != nil {
		return false
	}
	if containsStaleKeys(probe) {
		return false
	}
	var approvals []pendingApproval
	if err := json.Unmarshal([]byte(raw), &approvals); err != nil {
		return false
	}
	if len(approvals) > maxPendingApprovalsSeen {
		return false
	}
	for _, approval := range approvals {
		if approval.ID == nil || !IsUUIDv4(*approval.ID) {
			return false
		}
		if !sanitizedText(approval.ToolName, maxApprovalToolRunes) {
			return false
		}
		if !optionalSanitizedText(approval.CallID, maxCallIDRunes) {
			return false
		}
		if !optionalSanitizedText(approval.Reason, maxApprovalReasonRunes) {
			return false
		}
		if len(approval.Context) > 0 {
			if !validApprovalContext(approval.Context) || !sanitizedApprovalReason(approval.Reason) {
				return false
			}
		} else if tool == "codex" || tool == "workbuddy" {
			// ACP approvals must be complete enough to show the operation and
			// scope before the phone exposes either decision.
			return false
		}
		if (tool == "codex" || tool == "workbuddy") && !sanitizedApprovalReason(approval.Reason) {
			return false
		}
	}
	return true
}

func sanitizedApprovalReason(reason *string) bool {
	if !boundedApprovalDisplayText(reason, maxApprovalReasonRunes, true) {
		return false
	}
	for _, r := range *reason {
		if unicode.IsControl(r) && r != '\n' && r != '\r' && r != '\t' {
			return false
		}
	}
	return true
}

// validApprovalContext accepts only the complete display shape for one kind of
// native operation. It rejects unknown fields too: an unrendered context value
// could be important to the decision, and silently omitting it would be unsafe.
func validApprovalContext(raw json.RawMessage) bool {
	if isJSONNull(raw) || len(raw) > maxApprovalContextBytes {
		return false
	}
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(raw, &fields); err != nil || fields == nil {
		return false
	}
	var context approvalContext
	if err := json.Unmarshal(raw, &context); err != nil || context.Kind == nil {
		return false
	}
	allowed := map[string]bool{"kind": true}
	switch *context.Kind {
	case "command":
		allowed["command"] = true
		allowed["cwd"] = true
		if !boundedApprovalDisplayText(context.Command, maxApprovalCommandRunes, true) ||
			!boundedApprovalContextText(context.Cwd, maxApprovalContextPathRunes) {
			return false
		}
	case "network":
		allowed["networkHost"] = true
		allowed["protocol"] = true
		allowed["networkPort"] = true
		if !boundedApprovalContextText(context.NetworkHost, maxApprovalNetworkHostRunes) ||
			!validApprovalProtocol(context.Protocol) || !validApprovalNetworkPort(context.NetworkPort) {
			return false
		}
		host := *context.NetworkHost
		if strings.ContainsAny(host, "/@?#") || strings.ContainsAny(host, " \t\r\n") {
			return false
		}
	case "file-change":
		allowed["summary"] = true
		allowed["grantRoot"] = true
		if !boundedApprovalDisplayText(context.Summary, maxApprovalFileSummaryRunes, true) ||
			!boundedApprovalContextText(context.GrantRoot, maxApprovalContextPathRunes) {
			return false
		}
	default:
		return false
	}
	for name := range fields {
		if !allowed[name] {
			return false
		}
	}
	return true
}

func boundedApprovalContextText(value *string, maxRunes int) bool {
	return boundedApprovalDisplayText(value, maxRunes, false)
}

func boundedApprovalDisplayText(value *string, maxRunes int, multiline bool) bool {
	if value == nil || len([]rune(*value)) > maxRunes || strings.TrimSpace(*value) == "" {
		return false
	}
	for _, r := range *value {
		if unicode.IsControl(r) && !(multiline && (r == '\n' || r == '\r' || r == '\t')) {
			return false
		}
	}
	return true
}

func validApprovalProtocol(value *string) bool {
	if !boundedApprovalContextText(value, maxApprovalNetworkProtocolRunes) {
		return false
	}
	for index, r := range *value {
		letter := r >= 'A' && r <= 'Z' || r >= 'a' && r <= 'z'
		if index == 0 {
			if !letter {
				return false
			}
			continue
		}
		if !letter && !(r >= '0' && r <= '9') && r != '+' && r != '.' && r != '-' {
			return false
		}
	}
	return true
}

func validApprovalNetworkPort(raw json.RawMessage) bool {
	if len(raw) == 0 {
		return true
	}
	if isJSONNull(raw) {
		return false
	}
	var port int
	if err := json.Unmarshal(raw, &port); err != nil {
		return false
	}
	return port >= 1 && port <= 65535
}

// maxPendingQuestionBatches bounds the projection: at most four live forms.
const maxPendingQuestionBatches = 4

// maxPendingApprovalsSeen bounds the permission projection: at most eight live
// permission requests. Past that the desktop is expected to fail honestly rather
// than present a partial list, because a partial list of permission requests is
// one that silently omits a request somebody is waiting on.
const maxPendingApprovalsSeen = 8

const (
	maxApprovalCommandRunes         = 4000
	maxApprovalContextPathRunes     = 1024
	maxApprovalNetworkHostRunes     = 253
	maxApprovalNetworkProtocolRunes = 32
	maxApprovalFileSummaryRunes     = 4000
	maxApprovalContextBytes         = 16 * 1024
)

// maxProjectionBytes is a coarse outer bound on each projection. The frame
// ceiling (256 KiB) already caps the whole result; this keeps one projection
// from consuming it all and is generous enough for four full batches of eight
// questions, twelve options and 1000-character text.
const maxProjectionBytes = 96 * 1024
