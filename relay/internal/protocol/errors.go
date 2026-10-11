// Package protocol holds the wire contract of docs/design/api/protocol-v1.md.
// It carries no HTTP or storage behaviour: only the shapes, the stable machine
// codes and the validation rules both sides of the boundary must agree on.
package protocol

// Version is the only protocol version this relay speaks (contract §12.2).
const Version = 1

// Code is a stable machine-readable error code (contract §6.2). Clients branch
// on Code and never on a message.
type Code string

const (
	CodeInvalidJSON          Code = "invalid_json"
	CodeInvalidRequest       Code = "invalid_request"
	CodeUnauthenticated      Code = "unauthenticated"
	CodeInvalidCredentials   Code = "invalid_credentials"
	CodeOriginForbidden      Code = "origin_forbidden"
	CodeForbidden            Code = "forbidden"
	CodeNotFound             Code = "not_found"
	CodeMethodNotAllowed     Code = "method_not_allowed"
	CodePayloadTooLarge      Code = "payload_too_large"
	CodeUnsupportedMediaType Code = "unsupported_media_type"
	CodeRateLimited          Code = "rate_limited"
	CodeInternal             Code = "internal"
	CodeBridgeOffline        Code = "bridge_offline"
	CodeTargetOffline        Code = "target_offline"
	CodeIdentityConflict     Code = "identity_conflict"
	CodeBridgeBusy           Code = "bridge_busy"
	CodeBridgeTimeout        Code = "bridge_timeout"
	CodeBridgeBadResponse    Code = "bridge_bad_response"
	CodeUnknownMethod        Code = "unknown_method"
	CodeInvalidParams        Code = "invalid_params"
	CodeSessionNotFound      Code = "session_not_found"
	CodeSessionGone          Code = "session_gone"
	CodeNotCapable           Code = "not_capable"
	CodeTooLong              Code = "too_long"
	CodeBridgeError          Code = "bridge_error"

	// CRD 0006 additions: the three business failures the extension's two
	// methods can produce. They sit beside unknown_method at HTTP 200.
	//
	// tool_unavailable is deliberately NOT not_capable. not_capable means "this
	// session has no such ability"; tool_unavailable means "that session source
	// is not running right now". Collapsing them would tell the user to give up
	// on a tool that is merely closed, which is exactly the "don't pretend"
	// distinction §9.5 exists for.
	CodeToolUnavailable     Code = "tool_unavailable"
	CodeModelNotAvailable   Code = "model_not_available"
	CodeSessionCreateFailed Code = "session_create_failed"

	// The answer/approval surface's three business failures. They exist so a
	// stale click can be told apart from a protocol break: all three mean "the
	// request was well formed but no longer describes anything the desktop can
	// act on", which is exactly the case a phone must handle by re-reading
	// native state rather than by retrying blindly.
	//
	// They are NOT a success path and must never be rounded into one. Nothing
	// in the relay may treat an approval as granted because a call returned 200
	// (§6.1: the transport acknowledging a submission is all a 200 means).
	CodeAnswerNotOpen   Code = "answer_not_open"
	CodeApprovalUnknown Code = "approval_unknown"
	CodeProjectConflict Code = "project_conflict"
)

// ErrorBody is the only failure shape in the contract (§6.1).
type ErrorBody struct {
	Code    Code   `json:"code"`
	Message string `json:"message"`
}

// Failure is the whole body of any failed response, HTTP layer or RPC layer.
type Failure_ struct {
	OK    bool      `json:"ok"`
	Error ErrorBody `json:"error"`
}

// Failure builds a failure body with the code's canonical message.
func Failure(code Code) Failure_ {
	return Failure_{OK: false, Error: ErrorBody{Code: code, Message: code.CanonicalMessage()}}
}

// FailureWith builds a failure body whose message was sanitised at the boundary.
func FailureWith(code Code, message string) Failure_ {
	return Failure_{OK: false, Error: ErrorBody{Code: code, Message: message}}
}

// HTTPStatus returns the status the contract table pins for this code (§6.2).
// An unknown code never escapes as a success: it falls back to 500.
func (c Code) HTTPStatus() int {
	switch c {
	case CodeInvalidJSON, CodeInvalidRequest:
		return 400
	case CodeUnauthenticated, CodeInvalidCredentials:
		return 401
	case CodeOriginForbidden, CodeForbidden:
		return 403
	case CodeNotFound:
		return 404
	case CodeIdentityConflict:
		return 409
	case CodeMethodNotAllowed:
		return 405
	case CodePayloadTooLarge:
		return 413
	case CodeUnsupportedMediaType:
		return 415
	case CodeRateLimited:
		return 429
	case CodeInternal:
		return 500
	case CodeBridgeBadResponse:
		return 502
	case CodeBridgeOffline, CodeTargetOffline, CodeBridgeBusy:
		return 503
	case CodeBridgeTimeout:
		return 504
	case CodeUnknownMethod, CodeInvalidParams, CodeSessionNotFound,
		CodeSessionGone, CodeNotCapable, CodeTooLong, CodeBridgeError,
		CodeToolUnavailable, CodeModelNotAvailable, CodeSessionCreateFailed,
		CodeAnswerNotOpen, CodeApprovalUnknown, CodeProjectConflict:
		// RPC business failures travel on HTTP 200; the client branches on ok
		// and error.code alone (§6.1).
		return 200
	default:
		return 500
	}
}

// CanonicalMessage returns the client-facing message for this code. Messages
// are short, English and carry no stack, path, SQL, token, code or cookie
// (§6.1); the client must branch on the code, never on this text.
func (c Code) CanonicalMessage() string {
	switch c {
	case CodeInvalidJSON:
		return "invalid json body"
	case CodeInvalidRequest:
		return "invalid request body"
	case CodeUnauthenticated:
		return "session is not valid"
	case CodeInvalidCredentials:
		return "pairing code is not valid"
	case CodeOriginForbidden:
		return "origin not allowed"
	case CodeForbidden:
		return "not allowed"
	case CodeNotFound:
		return "not found"
	case CodeMethodNotAllowed:
		return "method not allowed"
	case CodePayloadTooLarge:
		return "request body too large"
	case CodeUnsupportedMediaType:
		return "content type must be application/json"
	case CodeRateLimited:
		return "too many requests"
	case CodeInternal:
		return "internal error"
	case CodeBridgeOffline:
		return "desktop is offline"
	case CodeTargetOffline:
		return "target computer is offline"
	case CodeIdentityConflict:
		return "computer identity is already bound"
	case CodeBridgeBusy:
		return "desktop is busy"
	case CodeBridgeTimeout:
		return "desktop did not answer in time"
	case CodeBridgeBadResponse:
		return "desktop sent an unusable response"
	case CodeUnknownMethod:
		return "method is not allowed"
	case CodeInvalidParams:
		return "invalid params"
	case CodeSessionNotFound:
		return "session not found"
	case CodeSessionGone:
		return "session is gone"
	case CodeNotCapable:
		return "session cannot be stopped"
	case CodeTooLong:
		return "text is too long"
	case CodeBridgeError:
		return "desktop reported an error"
	case CodeToolUnavailable:
		return "that session source is not available"
	case CodeModelNotAvailable:
		return "that model is not available"
	case CodeSessionCreateFailed:
		return "the session could not be created"
	case CodeAnswerNotOpen:
		return "that question is no longer open"
	case CodeApprovalUnknown:
		return "that approval request is no longer pending"
	case CodeProjectConflict:
		return "the project and directory do not match"
	default:
		return "internal error"
	}
}

// BridgeReportable reports whether a bridge may legitimately choose this code in
// a response frame. Any other code in a response is a protocol error and the
// relay answers the phone with bridge_bad_response (§8.4.8).
func (c Code) BridgeReportable() bool {
	switch c {
	case CodeSessionNotFound, CodeSessionGone, CodeNotCapable,
		CodeTooLong, CodeBridgeError, CodeInvalidParams, CodeUnknownMethod,
		CodeToolUnavailable, CodeModelNotAvailable, CodeSessionCreateFailed,
		CodeAnswerNotOpen, CodeApprovalUnknown, CodeProjectConflict:
		return true
	default:
		return false
	}
}
