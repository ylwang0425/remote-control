package protocol

import (
	"encoding/json"
	"regexp"
	"strings"
)

// This file owns the params half of the mobile workbench's two operational
// methods: session.answer (answer the question a real AI turn is blocked on)
// and session.approve (answer a genuine native permission approval request).
//
// Three things shape every rule below.
//
// First, both methods are a bounded, named door onto one native operation each.
// Neither is a generic RPC: a caller cannot name a native method, cannot pass a
// free-form argument bag, and cannot reach anything the desktop did not
// declare. That is why the whitelist in params.go has no passthrough field.
//
// Second, the payloads are user-visible text and identifiers that came from
// somewhere the relay does not control — an AI turn's question text, an option
// label, a tool name. They are therefore bounded and must be free of control
// characters, exactly like every other field the relay forwards. What the relay
// cannot do is tell a genuine option label from an invented one; only the
// desktop holds the live question, so only the desktop can check that the
// labels it is handed are the ones it asked about. The relay's job is to make
// sure nothing is malformed, oversized, duplicated or unrepresentable before
// the desktop ever sees it, so a refusal happens here rather than half-way
// through a native form.
//
// Third, an answer batch is all-or-nothing. A partial batch is worse than no
// batch: it would answer some questions of a live turn and leave the rest
// hanging, which is a half-authorized form. So every question in the batch is
// validated before any of them is forwarded, and the desktop is told the exact
// sessionId and callId the batch belongs to.

// Field ceilings for the answer/approval surface. They are the contract's
// representable bounds: a payload inside them can be displayed and answered in
// full, and one outside them is refused honestly instead of being trimmed into
// an incomplete form.
//
// maxCallIDRunes lives with the other single-field ceilings in params.go,
// because both methods use it: it is the ceiling for a native batch id, for a
// question id inside a batch, and for an approval's optional callId.
const (
	// maxQuestionsPerBatch and maxOptionsPerQuestion mirror the pendingQuestions
	// projection's own caps, so a question the phone can see is always a
	// question it can answer.
	maxQuestionsPerBatch   = 8
	maxOptionsPerQuestion  = 12
	maxQuestionRunes       = 1000
	maxQuestionHeaderRunes = 200
	maxOptionLabelRunes    = 500
	maxOptionDetailRunes   = 1000
	maxCustomAnswerRunes   = 1000
	maxApprovalToolRunes   = 128
	maxApprovalReasonRunes = 4000
	// maxAnswerBatchRunes bounds the whole answers array as well as each
	// member: eight questions with an option list each must still fit the
	// request body the phone is allowed to send.
	maxAnswerBatchRunes = 16384
)

// uuidPattern is any canonical UUID, version-agnostic on purpose. §4.1 pins a
// v4 shape for the ids the RELAY mints; an approvalId, by contrast, is minted
// by the desktop's own gateway and is only ever looked up there. Forcing v4
// here would reject a genuine event id from a host that mints a different
// version, which is a false refusal of a request the desktop could have
// honoured.
var uuidPattern = regexp.MustCompile(`^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$`)

// IsUUID reports whether s has the canonical UUID shape.
func IsUUID(s string) bool { return uuidPattern.MatchString(s) }

// ApprovalDecision is the closed set of decisions session.approve may carry.
// There is deliberately no allow-always: a decision that would outlive the one
// request it answers is a policy change, and the relay has no business
// expressing one.
type ApprovalDecision string

const (
	DecisionAllowOnce ApprovalDecision = "allow-once"
	DecisionReject    ApprovalDecision = "reject"
)

// validateAnswer applies session.answer's rules.
//
// The batch shape is the contract: {answers:[{id,selected:[string],custom?}]}.
// An empty batch is refused — "answer nothing" is not an answer, and forwarding
// it would ask the desktop to commit an empty form over a live turn.
func validateAnswer(fields map[string]json.RawMessage) (Code, bool) {
	if _, ok := requiredString(fields, "callId", maxCallIDRunes); !ok {
		return CodeInvalidParams, false
	}
	raw, present := fields["answers"]
	if !present || len(raw) == 0 || isJSONNull(raw) {
		return CodeInvalidParams, false
	}
	var entries []struct {
		ID       *string   `json:"id"`
		Selected *[]string `json:"selected"`
		Custom   *string   `json:"custom"`
	}
	if err := json.Unmarshal(raw, &entries); err != nil {
		return CodeInvalidParams, false
	}
	if len(entries) == 0 || len(entries) > maxQuestionsPerBatch {
		return CodeInvalidParams, false
	}

	seen := make(map[string]bool, len(entries))
	total := 0
	for _, entry := range entries {
		if entry.ID == nil || !printableField(*entry.ID, maxCallIDRunes) {
			return CodeInvalidParams, false
		}
		if seen[*entry.ID] {
			// One question, one answer. A duplicate id would either answer the
			// same question twice or silently drop one of the two, and the
			// desktop would have no way to tell which the user meant.
			return CodeInvalidParams, false
		}
		seen[*entry.ID] = true

		if entry.Selected == nil {
			return CodeInvalidParams, false
		}
		selected := *entry.Selected
		if len(selected) > maxOptionsPerQuestion {
			return CodeInvalidParams, false
		}
		labels := make(map[string]bool, len(selected))
		for _, label := range selected {
			if !printableField(label, maxOptionLabelRunes) {
				return CodeInvalidParams, false
			}
			if labels[label] {
				// The same label twice is not a multi-select answer; it is a
				// client bug that would send a duplicate into a native form.
				return CodeInvalidParams, false
			}
			labels[label] = true
			total += len([]rune(label))
		}
		if entry.Custom != nil {
			if !printableField(*entry.Custom, maxCustomAnswerRunes) {
				return CodeInvalidParams, false
			}
			total += len([]rune(*entry.Custom))
		}
		if len(selected) == 0 && entry.Custom == nil {
			// Neither an option nor free text: an empty answer for one question
			// of a live form. Refused rather than forwarded.
			return CodeInvalidParams, false
		}
	}
	if total > maxAnswerBatchRunes {
		return CodeTooLong, false
	}
	return "", true
}

// validateApprove applies session.approve's rules.
//
// approvalId is the desktop's own live request identifier. The relay checks its
// shape and never its existence — only the desktop holds the live map of
// pending approvals, and a "does this id exist" answer invented here would be
// the relay pretending to know something it cannot. A stale or cancelled id is
// the desktop's refusal to make, and it makes it explicitly.
func validateApprove(fields map[string]json.RawMessage) (Code, bool) {
	approvalID, ok := requiredString(fields, "approvalId", maxCallIDRunes)
	if !ok || !IsUUID(approvalID) {
		return CodeInvalidParams, false
	}
	decision, ok := requiredString(fields, "decision", maxEffortRunes)
	if !ok {
		return CodeInvalidParams, false
	}
	switch ApprovalDecision(decision) {
	case DecisionAllowOnce, DecisionReject:
		return "", true
	default:
		// allow-always, a policy edit, an empty string and a typo all land
		// here. There is no permissive default: an unrecognised decision must
		// never be rounded to the one that grants access.
		return CodeInvalidParams, false
	}
}

// sanitizeDisplayText is the relay's second line of defence for the text it
// hands the phone from a native projection: control characters are dropped and
// the result is bounded, so a question, an option label or an approval reason
// cannot forge a UI row or a log line. The text is otherwise untouched — no
// translation, no truncation of a string that already fits, and Unicode
// survives.
func sanitizeDisplayText(s string, maxRunes int) string {
	var sb strings.Builder
	for _, r := range s {
		if r < 0x20 || r == 0x7f {
			continue
		}
		sb.WriteRune(r)
	}
	out := strings.TrimSpace(sb.String())
	runes := []rune(out)
	if len(runes) > maxRunes {
		out = string(runes[:maxRunes])
	}
	return out
}

// boundedRunes reports whether s is usable as display text: non-blank after
// sanitising and no longer than maxRunes.
//
// The length is measured on the ORIGINAL string, before sanitising truncates
// it. Measuring afterwards would be a real hole: sanitizeDisplayText caps its
// output, so a post-sanitise check would accept any length at all and the
// representable-bound rule would never fire.
func boundedRunes(s string, maxRunes int) bool {
	if len([]rune(s)) > maxRunes {
		return false
	}
	return sanitizeDisplayText(s, maxRunes) != ""
}

// arrayWithinCap checks an optional array field's cardinality without
// unmarshalling its members. `null` is not an array and is refused, the same
// way §9.2 refuses a nulled activeTurnId.
func arrayWithinCap(raw json.RawMessage, max int) bool {
	if len(raw) == 0 || isJSONNull(raw) {
		return false
	}
	var items []json.RawMessage
	if err := json.Unmarshal(raw, &items); err != nil {
		return false
	}
	return len(items) <= max
}
