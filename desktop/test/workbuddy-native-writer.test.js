'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { WorkBuddyNativeWriter } = require('../src/workbuddy-native/writer');

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

test('native writer serializes UI actions in arrival order', async () => {
  const writer = new WorkBuddyNativeWriter();
  const gate = deferred();
  const order = [];
  const first = writer.run(async () => { order.push('first:start'); await gate.promise; order.push('first:end'); return 1; });
  const second = writer.run(async () => { order.push('second'); return 2; });
  await Promise.resolve();
  assert.deepEqual(order, ['first:start']);
  gate.resolve();
  assert.deepEqual(await Promise.all([first, second]), [1, 2]);
  assert.deepEqual(order, ['first:start', 'first:end', 'second']);
  assert.equal(writer.inFlight, 0);
});

test('close retires queued work, drains only the current action, and never retries it', async () => {
  const writer = new WorkBuddyNativeWriter();
  const gate = deferred();
  let calls = 0;
  const first = writer.run(async () => { calls += 1; await gate.promise; return 'submitted'; });
  await Promise.resolve();
  const queued = writer.run(async () => { calls += 1; return 'must-not-run'; });
  const queuedOutcome = queued.then(() => null, (error) => error);
  const closing = writer.close();
  await assert.rejects(writer.run(async () => { calls += 1; }), (error) => error.code === 'not_capable');
  let drained = false;
  void closing.then(() => { drained = true; });
  await Promise.resolve();
  assert.equal(drained, false);
  gate.resolve();
  assert.equal(await first, 'submitted');
  assert.equal((await queuedOutcome).code, 'not_capable');
  await closing;
  assert.equal(drained, true);
  assert.equal(calls, 1);
  assert.equal(writer.inFlight, 0);
});

test('an ambiguous native action rejection is surfaced once with no automatic replay', async () => {
  const writer = new WorkBuddyNativeWriter();
  let calls = 0;
  const failure = new Error('timeout after UIA call');
  await assert.rejects(writer.run(async () => { calls += 1; throw failure; }), failure);
  assert.equal(calls, 1);
  assert.equal(await writer.run(async () => { calls += 1; return 'fresh follow-up'; }), 'fresh follow-up');
  assert.equal(calls, 2);
  await writer.close();
});
