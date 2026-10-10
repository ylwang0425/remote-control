'use strict';
/**
 * Error model for the desktop bridge, protocol-v1 §6.2 and §8.4.8.
 *
 * The contract allows only a fixed set of codes on a `response` frame from this
 * side, and it requires `error.message` to be a short, safe, human sentence:
 * no stack, no absolute path, no token, no cookie, no pairing code, no upstream
 * error text. Everything that leaves this process goes through `safeMessage`,
 * so a native exception can never be JSON-ified into the wire by accident.
 */

/** Codes the desktop is allowed to put on a `response` frame (protocol-v1 §8.4.8). */
const CLIENT_ERROR_CODES = Object.freeze([
  'session_not_found',
  'session_gone',
  'not_capable',
  'too_long',
  'bridge_error',
  'invalid_params',
  'unknown_method',
  // CRD 0006: the two new methods bring three codes of their own.
  'tool_unavailable',
  'model_not_available',
  'session_create_failed',
]);

const CLIENT_ERROR_CODE_SET = new Set(CLIENT_ERROR_CODES);

/**
 * Every code in protocol-v1 §6.2 with its HTTP status, including the CRD 0003
 * addition `forbidden` (403 = authenticated but not allowed). Kept here so the
 * local UI can tell "you are not allowed" apart from "you are not signed in":
 * a 403 must never be treated as a lost pairing.
 */
const RELAY_ERROR_CODES = Object.freeze({
  invalid_json: { http: 400 },
  invalid_request: { http: 400 },
  unauthenticated: { http: 401 },
  invalid_credentials: { http: 401 },
  origin_forbidden: { http: 403 },
  forbidden: { http: 403 },
  not_found: { http: 404 },
  method_not_allowed: { http: 405 },
  payload_too_large: { http: 413 },
  unsupported_media_type: { http: 415 },
  rate_limited: { http: 429 },
  internal: { http: 500 },
  bridge_offline: { http: 503 },
  bridge_busy: { http: 503 },
  bridge_timeout: { http: 504 },
  bridge_bad_response: { http: 502 },
  unknown_method: { http: 200 },
  invalid_params: { http: 200 },
  session_not_found: { http: 200 },
  session_gone: { http: 200 },
  not_capable: { http: 200 },
  too_long: { http: 200 },
  bridge_error: { http: 200 },
  tool_unavailable: { http: 200 },
  model_not_available: { http: 200 },
  session_create_failed: { http: 200 },
});

/** Fixed, safe sentences. Used whenever the native text cannot be trusted. */
const FALLBACK_MESSAGES = Object.freeze({
  session_not_found: 'session not found',
  session_gone: 'session is no longer available',
  not_capable: 'this session cannot do that',
  too_long: 'text is too long',
  bridge_error: 'the desktop could not complete the request',
  invalid_params: 'invalid params',
  unknown_method: 'method is not allowed',
  tool_unavailable: 'that session source is not connected',
  model_not_available: 'that model is not available on this computer',
  session_create_failed: 'the desktop could not create that session',
});

const MAX_MESSAGE_LENGTH = 120;

/**
 * Anything this long and token-shaped gets redacted before it travels. The
 * threshold is 24, not 32: a pairing code is 29 characters (20 Crockford
 * characters plus 5 dashes), so a 32 threshold would let one through.
 */
const SECRET_LIKE = /[A-Za-z0-9_-]{24,}/g;

class BridgeError extends Error {
  /**
   * @param {string} code one of {@link CLIENT_ERROR_CODES}
   * @param {string} [message] safe text; the code's fallback when omitted
   */
  constructor(code, message) {
    if (!CLIENT_ERROR_CODE_SET.has(code)) {
      throw new Error(`unknown bridge error code: ${String(code)}`);
    }
    super(safeMessage(message, code));
    this.name = 'BridgeError';
    this.code = code;
  }
}

/**
 * Reduce any value to one safe, short line.
 * @param {unknown} value an Error, a string or anything else
 * @param {keyof typeof FALLBACK_MESSAGES} [fallbackCode] fallback sentence
 * @returns {string} at most 120 characters, one line, no path, no secret
 */
function safeMessage(value, fallbackCode = 'bridge_error') {
  const fallback = FALLBACK_MESSAGES[fallbackCode] ?? FALLBACK_MESSAGES.bridge_error;
  let text;
  if (typeof value === 'string') {
    text = value;
  } else if (value instanceof Error) {
    text = String(value.message ?? '');
  } else if (value === undefined || value === null) {
    text = '';
  } else {
    text = String(value);
  }
  let cleaned = text
    .replace(/[\r\n\t]+/g, ' ')
    // Absolute paths, both Windows and POSIX, are replaced rather than truncated:
    // a half-path is still a leak of the local layout.
    .replace(/[A-Za-z]:\\[^\s'"]*/g, '<path>')
    .replace(/\/(?:[^\s'"/]+\/)+[^\s'"]*/g, '<path>')
    .replace(SECRET_LIKE, '<redacted>')
    .replace(/\s+/g, ' ')
    .trim();
  if (cleaned.length > MAX_MESSAGE_LENGTH) {
    cleaned = `${cleaned.slice(0, MAX_MESSAGE_LENGTH - 1).trimEnd()}…`;
  }
  return cleaned.length === 0 ? fallback : cleaned;
}

/**
 * Turn any thrown value into a contract-shaped `{code, message}` pair.
 *
 * A `BridgeError` carries text we wrote ourselves, so it travels. Anything else
 * is a native failure: its text is upstream raw text (errno, command line,
 * socket addresses), which protocol-v1 §8.4.8 forbids on the wire, so the code's
 * own fixed sentence is sent instead. The native text stays local, for the log.
 *
 * @param {unknown} error
 * @param {keyof typeof FALLBACK_MESSAGES} [fallbackCode]
 */
function mapError(error, fallbackCode = 'bridge_error') {
  if (error instanceof BridgeError) {
    return { code: error.code, message: error.message };
  }
  return { code: fallbackCode, message: FALLBACK_MESSAGES[fallbackCode] ?? FALLBACK_MESSAGES.bridge_error };
}

/**
 * Build a failure `response` frame (protocol-v1 §8.4.8).
 * @param {string} id the request id, echoed byte for byte
 * @param {string} code a code from {@link CLIENT_ERROR_CODES}
 * @param {unknown} [detail] native error or text, sanitised before it travels
 */
function errorResponse(id, code, detail) {
  if (!CLIENT_ERROR_CODE_SET.has(code)) {
    throw new Error(`unknown bridge error code: ${String(code)}`);
  }
  return {
    type: 'response',
    id,
    ok: false,
    error: { code, message: safeMessage(detail, code) },
  };
}

module.exports = {
  BridgeError,
  CLIENT_ERROR_CODES,
  RELAY_ERROR_CODES,
  FALLBACK_MESSAGES,
  MAX_MESSAGE_LENGTH,
  safeMessage,
  mapError,
  errorResponse,
};
