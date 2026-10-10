'use strict';
/**
 * Tests for the create log: the guarantees that stop a second chat from being
 * created for one request id.
 *
 * These are the cases root asked for, not getter mirrors:
 *   - two concurrent creates for one key run the native call exactly once;
 *   - a `pending` entry left by a dead process never calls native again;
 *   - an unreadable or corrupt log blocks creation instead of failing open;
 *   - a log that cannot be written blocks creation too (native calls = 0);
 *   - a key beyond the kept results can never create again (tombstone).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const { CreateLog, CreateLogUnavailableError, fingerprintOf, STATE_PENDING } = require('../src/creates');

function tempPath(name) {
  return path.join(os.tmpdir(), `ai-remote-creates-${name}-${crypto.randomUUID()}.json`);
}

function fingerprint(model = 'm-1') {
  return fingerprintOf({ tool: 'dsh', model, provider: 'p-1' });
}

test('two concurrent creates for one request id run the native call exactly once', async () => {
  const file = tempPath('concurrent');
  const log = new CreateLog({ path: file });
  let native = 0;
  const worker = async (onCreated) => {
    native += 1;
    await new Promise((resolve) => setTimeout(resolve, 20));
    onCreated({ sessionId: 'session-1' });
    return { sessionId: 'session-1', tool: 'dsh', model: 'm-1' };
  };
  try {
    const [a, b] = await Promise.all([log.run('req-1', fingerprint(), worker), log.run('req-1', fingerprint(), worker)]);
    assert.equal(native, 1, 'the second caller joined the first instead of creating again');
    assert.equal(a.result.sessionId, 'session-1');
    assert.equal(b.result.sessionId, 'session-1');
    assert.equal([a.deduplicated, b.deduplicated].filter(Boolean).length, 1, 'exactly one of them was a create');
  } finally {
    fs.unlinkSync(file);
  }
});

test('a session recorded once is never created again, even after a restart', async () => {
  const file = tempPath('restart');
  try {
    const first = new CreateLog({ path: file });
    await first.run('req-2', fingerprint(), async (onCreated) => {
      onCreated({ sessionId: 'session-2' });
      return { sessionId: 'session-2', tool: 'dsh', model: 'm-1' };
    });

    // A new process reads the same file.
    const second = new CreateLog({ path: file });
    let native = 0;
    const outcome = await second.run('req-2', fingerprint(), async () => {
      native += 1;
      return { sessionId: 'session-3', tool: 'dsh', model: 'm-1' };
    });
    assert.equal(native, 0, 'the native call is never repeated for a known key');
    assert.equal(outcome.result.sessionId, 'session-2');
    assert.equal(outcome.deduplicated, true);
  } finally {
    fs.unlinkSync(file);
  }
});

test('a pending key from a dead process never creates again and is reported as unknown', async () => {
  const file = tempPath('pending');
  try {
    fs.writeFileSync(
      file,
      JSON.stringify({ creates: [{ requestId: 'req-3', fingerprint: fingerprint(), state: STATE_PENDING, at: new Date().toISOString() }] }),
    );
    const log = new CreateLog({ path: file });
    let native = 0;
    const error = await log
      .run('req-3', fingerprint(), async () => {
        native += 1;
        return { sessionId: 'session-x' };
      })
      .catch((err) => err);
    assert.equal(native, 0, 'nothing is created behind a key whose outcome is unknown');
    assert.equal(error.code, 'session_create_failed');
    // The refusal must point at the existing session list and must never suggest
    // trying again with a fresh id: that would be exactly the blind recreation
    // this file exists to prevent.
    assert.match(error.message, /may already have created|do not create it again/i);
    assert.ok(!/new request id/i.test(error.message), error.message);
  } finally {
    fs.unlinkSync(file);
  }
});

test('an unreadable create log blocks creation instead of failing open', () => {
  const file = tempPath('corrupt');
  try {
    fs.writeFileSync(file, '{ this is not json');
    assert.throws(() => new CreateLog({ path: file }), (err) => err instanceof CreateLogUnavailableError);
  } finally {
    fs.unlinkSync(file);
  }
});

test('a log whose directory cannot be written blocks the native call', async () => {
  // A path that cannot be created on Windows: a file used as a directory.
  const blocker = tempPath('blocker');
  fs.writeFileSync(blocker, 'not a directory');
  const log = new CreateLog({ path: path.join(blocker, 'creates.json') });
  let native = 0;
  const error = await log
    .run('req-4', fingerprint(), async () => {
      native += 1;
      return { sessionId: 'session-4' };
    })
    .catch((err) => err);
  assert.equal(native, 0, 'no session is created when the reservation cannot be written');
  assert.equal(error instanceof CreateLogUnavailableError, true);
  fs.unlinkSync(blocker);
});

test('the same request id with a different request is refused', async () => {
  const file = tempPath('mismatch');
  try {
    const log = new CreateLog({ path: file });
    await log.run('req-5', fingerprint('m-1'), async (onCreated) => {
      onCreated({ sessionId: 'session-5' });
      return { sessionId: 'session-5', tool: 'dsh', model: 'm-1' };
    });
    const error = await log.run('req-5', fingerprint('m-2'), async () => ({ sessionId: 'other' })).catch((err) => err);
    assert.equal(error.code, 'invalid_params');
  } finally {
    fs.unlinkSync(file);
  }
});

test('a key whose result body was dropped still cannot create again', async () => {
  const file = tempPath('tombstone');
  try {
    const creates = [];
    for (let index = 0; index < 260; index += 1) {
      creates.push({
        requestId: `old-${index}`,
        fingerprint: fingerprint(),
        state: 'done',
        sessionId: `session-${index}`,
        // only the newest 200 keep a result body
        result: index >= 60 ? { sessionId: `session-${index}`, tool: 'dsh', model: 'm-1' } : undefined,
        at: new Date().toISOString(),
      });
    }
    fs.writeFileSync(file, JSON.stringify({ creates }));
    const log = new CreateLog({ path: file });
    let native = 0;
    const error = await log
      .run('old-0', fingerprint(), async () => {
        native += 1;
        return { sessionId: 'session-new' };
      })
      .catch((err) => err);
    assert.equal(native, 0, 'an old request id must never create a second chat');
    assert.equal(error.code, 'session_create_failed');
  } finally {
    fs.unlinkSync(file);
  }
});
