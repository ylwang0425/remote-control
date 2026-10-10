'use strict';
/**
 * Tests for the error model (protocol-v1 §6.2 and §8.4.8).
 *
 * Two jobs: only contract error codes may travel, and every message that leaves
 * the machine must be a short human sentence - no stack, no absolute path, no
 * token, no cookie, no pairing code.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  BridgeError,
  CLIENT_ERROR_CODES,
  RELAY_ERROR_CODES,
  FALLBACK_MESSAGES,
  safeMessage,
  mapError,
  errorResponse,
} = require('../src/errors');

test('only the codes the contract lets the desktop send are accepted', () => {
  assert.deepEqual(CLIENT_ERROR_CODES, [
    'session_not_found',
    'session_gone',
    'not_capable',
    'too_long',
    'bridge_error',
    'invalid_params',
    'unknown_method',
    // CRD 0006
    'tool_unavailable',
    'model_not_available',
    'session_create_failed',
  ]);
  for (const code of CLIENT_ERROR_CODES) {
    assert.equal(new BridgeError(code, 'x').code, code);
  }
  assert.throws(() => new BridgeError('unauthenticated', 'nope'), /unknown bridge error code/);
  assert.throws(() => new BridgeError('made_up', 'nope'), /unknown bridge error code/);
});

test('the relay error table carries the CRD 0003 addition `forbidden` at 403', () => {
  assert.ok(RELAY_ERROR_CODES.forbidden, 'forbidden exists');
  assert.equal(RELAY_ERROR_CODES.forbidden.http, 403);
  assert.equal(RELAY_ERROR_CODES.unauthenticated.http, 401);
  assert.equal(RELAY_ERROR_CODES.bridge_timeout.http, 504);
});

test('every client code has a fixed fallback message', () => {
  for (const code of CLIENT_ERROR_CODES) {
    assert.equal(typeof FALLBACK_MESSAGES[code], 'string');
    assert.ok(FALLBACK_MESSAGES[code].length > 0);
    assert.ok(FALLBACK_MESSAGES[code].length <= 120);
  }
});

test('a raw exception never leaks its stack or its paths', () => {
  const err = new Error('ENOENT: no such file or directory, open \'C:\\Users\\Hi\\.codex\\secret.json\'');
  err.stack = 'Error: boom\n    at Foo (C:\\workspace\\desktop\\src\\index.js:10:5)';
  const message = safeMessage(err);
  assert.ok(!message.includes('\\'), message);
  assert.ok(!message.includes('at Foo'), message);
  assert.ok(!message.includes('.codex'), message);
  assert.ok(message.length <= 120, `${message.length} chars`);
});

test('a message is collapsed to one line and cut to 120 characters', () => {
  const message = safeMessage(new Error(`first line\nsecond line\n${'x'.repeat(400)}`));
  assert.ok(!message.includes('\n'), message);
  assert.ok(message.length <= 120, `${message.length} chars`);
});

test('anything that looks like a secret is redacted', () => {
  const token = 'A'.repeat(43);
  const message = safeMessage(new Error(`bridge token ${token} rejected`));
  assert.ok(!message.includes(token), message);
  assert.ok(message.includes('<redacted>'), message);
});

test('an empty or non-Error value falls back to the code-specific sentence', () => {
  assert.equal(safeMessage(new Error(''), 'not_capable'), FALLBACK_MESSAGES.not_capable);
  assert.equal(safeMessage(undefined, 'session_gone'), FALLBACK_MESSAGES.session_gone);
  assert.equal(safeMessage(new Error('   ')), FALLBACK_MESSAGES.bridge_error);
});

test('mapError turns any native failure into a contract-shaped error', () => {
  // A native errno string is upstream raw text (protocol-v1 §8.4.8), so it is
  // replaced by our own fixed sentence, not forwarded.
  const mapped = mapError(new Error('connect ECONNREFUSED 127.0.0.1:18989'));
  assert.equal(mapped.code, 'bridge_error');
  assert.equal(mapped.message, FALLBACK_MESSAGES.bridge_error);
  assert.ok(!mapped.message.includes('18989'), mapped.message);
  assert.ok(!mapped.message.includes('ECONNREFUSED'), mapped.message);
  const already = mapError(new BridgeError('not_capable', 'this session cannot be stopped'));
  assert.equal(already.code, 'not_capable');
  assert.equal(already.message, 'this session cannot be stopped');
});

test('errorResponse keeps the request id byte for byte', () => {
  const id = '9c858901-8a57-4791-81fe-4c455b099bc9';
  const frame = errorResponse(id, 'not_capable');
  assert.deepEqual(frame, {
    type: 'response',
    id: '9c858901-8a57-4791-81fe-4c455b099bc9',
    ok: false,
    error: { code: 'not_capable', message: FALLBACK_MESSAGES.not_capable },
  });
});

test('errorResponse refuses a code the desktop is not allowed to send', () => {
  assert.throws(() => errorResponse('id-1', 'rate_limited'), /unknown bridge error code/);
});

