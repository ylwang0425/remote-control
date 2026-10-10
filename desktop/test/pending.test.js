'use strict';
/**
 * Tests for the bounded pending-request registry (protocol-v1 §10.2):
 * at most 16 in flight per bridge connection, one answer per id, a hard
 * timeout, and no automatic retry of anything that timed out.
 *
 * `add(id, options)` returns a promise, or `null` when the connection is full.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { PendingRegistry, MAX_PENDING } = require('../src/pending');

test('the per-connection pending limit is 16', () => {
  assert.equal(MAX_PENDING, 16);
});

test('the 17th concurrent request is refused instead of queued', () => {
  const pending = new PendingRegistry();
  const accepted = [];
  for (let i = 0; i < MAX_PENDING; i += 1) {
    const promise = pending.add(`id-${i}`, { method: 'session.read', timeoutMs: 5000 });
    assert.ok(promise, `request ${i} is accepted`);
    accepted.push(promise.catch(() => {}));
  }
  assert.equal(pending.add('id-16', { method: 'session.read', timeoutMs: 5000 }), null);
  assert.equal(pending.size, MAX_PENDING);
  pending.failAll(Object.assign(new Error('done'), { code: 'bridge_bad_response' }));
  assert.equal(pending.size, 0);
  return Promise.all(accepted);
});

test('an id may only be answered once', async () => {
  const pending = new PendingRegistry();
  const promise = pending.add('id-1', { method: 'session.read', timeoutMs: 5000 });
  assert.equal(pending.settle('id-1', { ok: true }), true);
  assert.equal(pending.settle('id-1', { ok: true }), false);
  assert.equal(pending.size, 0);
  assert.deepEqual(await promise, { ok: true });
});

test('an unknown id settles to nothing, it does not throw (protocol-v1 §10.2)', () => {
  const pending = new PendingRegistry();
  assert.equal(pending.settle('never-seen', { ok: true }), false);
  assert.equal(pending.fail('never-seen', new Error('nope')), false);
});

test('a request times out exactly once, and the late answer is dropped', async () => {
  const pending = new PendingRegistry();
  const promise = pending.add('id-2', { method: 'session.send', timeoutMs: 20 });
  const failure = await promise.catch((err) => err);
  assert.equal(failure.code, 'bridge_timeout');
  assert.equal(pending.size, 0);
  // The relay answered after the deadline: the frame is discarded.
  assert.equal(pending.settle('id-2', { ok: true }), false);
});

test('a reconnect failure closes every pending request', async () => {
  const pending = new PendingRegistry();
  const a = pending.add('id-a', { method: 'session.read', timeoutMs: 5000 });
  const b = pending.add('id-b', { method: 'sessions.list', timeoutMs: 5000 });
  const err = Object.assign(new Error('bridge disconnected'), { code: 'bridge_bad_response' });
  pending.failAll(err);
  assert.equal((await a.catch((e) => e)).code, 'bridge_bad_response');
  assert.equal((await b.catch((e) => e)).code, 'bridge_bad_response');
  assert.equal(pending.size, 0);
});

test('timers do not keep the process alive after the request settles', async () => {
  const pending = new PendingRegistry();
  const promise = pending.add('id-3', { method: 'session.read', timeoutMs: 10000 });
  assert.equal(pending.activeTimers, 1);
  pending.settle('id-3', { ok: true, result: {} });
  assert.deepEqual(await promise, { ok: true, result: {} });
  assert.equal(pending.activeTimers, 0);
});

test('the registry never retries: a timed-out id is gone for good', async () => {
  const pending = new PendingRegistry();
  const promise = pending.add('id-4', { method: 'session.read', timeoutMs: 10 });
  await promise.catch(() => {});
  assert.equal(pending.has('id-4'), false);
  assert.equal(pending.settle('id-4', { ok: true }), false);
});
