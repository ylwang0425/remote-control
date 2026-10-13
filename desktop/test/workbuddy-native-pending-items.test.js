'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  WorkBuddyPendingItems,
  WorkBuddyPendingItemsError,
} = require('../src/workbuddy-native/pending-items');

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function makeClock(start = 1_000_000) {
  let value = start;
  return {
    now: () => value,
    advance: (milliseconds) => { value += milliseconds; },
    set: (next) => { value = next; },
  };
}

function makeItem(clock, overrides = {}) {
  const observedAt = clock.now();
  return {
    kind: 'question',
    nativeId: 'native-request-001',
    conversationId: 'conversation-001',
    turnId: 'turn-001',
    itemId: 'item-001',
    actionId: 'question-001',
    formSignature: 'form-signature-a',
    runtimeIdHash: 'runtime-hash-a',
    observedAt,
    expiresAt: observedAt + 10_000,
    ...overrides,
  };
}

function resolutionFor(item, overrides = {}) {
  return {
    kind: item.kind,
    conversationId: item.conversationId,
    turnId: item.turnId,
    itemId: item.itemId,
    actionId: item.actionId,
    formSignature: item.formSignature,
    runtimeIdHash: item.runtimeIdHash,
    ...overrides,
  };
}

function expectCode(action, code) {
  assert.throws(action, (error) => error instanceof WorkBuddyPendingItemsError && error.code === code);
}

test('repeated polls of one live native form keep one opaque handle and refresh its bounded record', () => {
  const clock = makeClock();
  const pending = new WorkBuddyPendingItems({ now: clock.now });
  const first = makeItem(clock);
  const handle = pending.capture(first);
  assert.match(handle, UUID_V4);

  clock.advance(100);
  const refreshed = makeItem(clock, { expiresAt: clock.now() + 8_000 });
  assert.equal(pending.capture(refreshed), handle);

  const resolved = pending.resolve(handle, resolutionFor(refreshed));
  assert.deepEqual(resolved, refreshed);
  assert.equal(Object.isFrozen(resolved), true);
  assert.equal(Object.isFrozen(first), false);
});

test('resolve checks kind and every supplied context field without consuming a mismatched alias', () => {
  const clock = makeClock();
  const pending = new WorkBuddyPendingItems({ now: clock.now });
  const item = makeItem(clock, { nativeId: 'secret-native-identity' });
  const handle = pending.capture(item);
  const valid = resolutionFor(item);
  const changes = [
    { kind: 'approval' },
    { conversationId: 'other-conversation' },
    { turnId: 'other-turn' },
    { itemId: 'other-item' },
    { actionId: 'other-action' },
    { formSignature: 'redrawn-form' },
    { runtimeIdHash: 'redrawn-runtime' },
  ];

  for (const change of changes) {
    expectCode(() => pending.resolve(handle, { ...valid, ...change }), 'stale_request');
  }
  const resolved = pending.resolve(handle, valid);
  assert.equal(resolved.nativeId, 'secret-native-identity');
  assert.doesNotMatch(new WorkBuddyPendingItemsError('stale_request').message, /secret-native-identity/);
});

test('redrawing an unconsumed form invalidates the old handle and returns a new stable handle', () => {
  const clock = makeClock();
  const pending = new WorkBuddyPendingItems({ now: clock.now });
  const original = makeItem(clock);
  const oldHandle = pending.capture(original);
  const redrawn = makeItem(clock, { formSignature: 'form-signature-b', runtimeIdHash: 'runtime-hash-b' });
  const newHandle = pending.capture(redrawn);

  assert.notEqual(newHandle, oldHandle);
  expectCode(() => pending.resolve(oldHandle, resolutionFor(original)), 'stale_request');
  assert.equal(pending.capture(redrawn), newHandle);
  assert.deepEqual(pending.resolve(newHandle, resolutionFor(redrawn)), redrawn);
});

test('consumed native identities cannot be revived by polling or a redrawn form, but a new identity can', () => {
  const clock = makeClock();
  const pending = new WorkBuddyPendingItems({ now: clock.now });
  const item = makeItem(clock);
  const handle = pending.capture(item);
  pending.resolve(handle, resolutionFor(item));

  expectCode(() => pending.resolve(handle, resolutionFor(item)), 'stale_request');
  for (const changedForm of [
    makeItem(clock, { formSignature: 'new-form', runtimeIdHash: 'runtime-hash-a' }),
    makeItem(clock, { formSignature: 'form-signature-a', runtimeIdHash: 'new-runtime' }),
  ]) {
    expectCode(() => pending.capture(changedForm), 'stale_request');
  }

  const newNativeIdentity = makeItem(clock, { nativeId: 'native-request-002', itemId: 'item-002' });
  assert.match(pending.capture(newNativeIdentity), UUID_V4);
});

test('two concurrent resolutions consume the alias exactly once', async () => {
  const clock = makeClock();
  const pending = new WorkBuddyPendingItems({ now: clock.now });
  const item = makeItem(clock, { kind: 'approval' });
  const handle = pending.capture(item);
  const resolution = resolutionFor(item);
  const results = await Promise.allSettled([
    Promise.resolve().then(() => pending.resolve(handle, resolution)),
    Promise.resolve().then(() => pending.resolve(handle, resolution)),
  ]);

  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(results.filter((result) => result.status === 'rejected').length, 1);
  const rejected = results.find((result) => result.status === 'rejected');
  assert.equal(rejected.reason.code, 'stale_request');
});

test('identity keys safely handle delimiter and prototype-looking identifiers', () => {
  const clock = makeClock();
  const pending = new WorkBuddyPendingItems({ now: clock.now });
  const first = makeItem(clock, { nativeId: 'native|delimiter', conversationId: 'session' });
  const second = makeItem(clock, { nativeId: 'native', conversationId: 'delimiter|session' });
  const prototypeName = makeItem(clock, { nativeId: 'toString', conversationId: '__proto__' });
  const firstHandle = pending.capture(first);
  const secondHandle = pending.capture(second);
  const prototypeHandle = pending.capture(prototypeName);

  assert.notEqual(firstHandle, secondHandle);
  assert.equal(pending.resolve(firstHandle, resolutionFor(first)).nativeId, first.nativeId);
  assert.equal(pending.resolve(secondHandle, resolutionFor(second)).nativeId, second.nativeId);
  assert.equal(pending.resolve(prototypeHandle, resolutionFor(prototypeName)).nativeId, prototypeName.nativeId);
});

test('stale, expired and overlong forms are rejected without exposing their identifiers', () => {
  const clock = makeClock();
  const pending = new WorkBuddyPendingItems({ now: clock.now, maxAgeMs: 1_000, maxTtlMs: 3_000 });
  const expiredAtCapture = makeItem(clock, { expiresAt: clock.now() });
  expectCode(() => pending.capture(expiredAtCapture), 'stale_request');
  expectCode(() => pending.capture(makeItem(clock, { expiresAt: clock.now() + 3_001 })), 'stale_request');
  expectCode(() => pending.capture(makeItem(clock, { formSignature: 'x'.repeat(513) })), 'invalid_params');

  const item = makeItem(clock, { expiresAt: clock.now() + 2_000 });
  const handle = pending.capture(item);
  clock.advance(1_001);
  expectCode(() => pending.resolve(handle, resolutionFor(item)), 'stale_request');
  expectCode(() => pending.resolve(handle, resolutionFor(item)), 'stale_request');
});

test('conversation invalidation closes old known identities and preserves the explicitly current turn', () => {
  const clock = makeClock();
  const pending = new WorkBuddyPendingItems({ now: clock.now });
  const oldTurn = makeItem(clock, { turnId: 'turn-old', itemId: 'item-old', nativeId: 'native-old' });
  const currentTurn = makeItem(clock, { turnId: 'turn-current', itemId: 'item-current', nativeId: 'native-current' });
  const oldHandle = pending.capture(oldTurn);
  const currentHandle = pending.capture(currentTurn);

  pending.invalidateConversation('conversation-001', { exceptTurnId: 'turn-current' });
  expectCode(() => pending.resolve(oldHandle, resolutionFor(oldTurn)), 'stale_request');
  expectCode(() => pending.capture(oldTurn), 'stale_request');
  assert.equal(pending.resolve(currentHandle, resolutionFor(currentTurn)).nativeId, 'native-current');

  const consumed = makeItem(clock, { turnId: 'turn-consumed', itemId: 'item-consumed', nativeId: 'native-consumed' });
  const consumedHandle = pending.capture(consumed);
  pending.resolve(consumedHandle, resolutionFor(consumed));
  pending.invalidateConversation('conversation-001', { exceptTurnId: 'turn-current' });
  expectCode(() => pending.capture(consumed), 'stale_request');
  const newTurn = makeItem(clock, { turnId: 'turn-new', itemId: 'item-new', nativeId: 'native-new' });
  assert.match(pending.capture(newTurn), UUID_V4);
});

test('capacity refuses new identities instead of evicting a live alias or consumed tombstone', () => {
  const clock = makeClock();
  const pending = new WorkBuddyPendingItems({ now: clock.now, maxEntries: 1 });
  const first = makeItem(clock);
  const handle = pending.capture(first);
  expectCode(() => pending.capture(makeItem(clock, { nativeId: 'native-002', itemId: 'item-002' })), 'bridge_error');
  assert.equal(pending.resolve(handle, resolutionFor(first)).nativeId, first.nativeId);

  expectCode(() => pending.capture(makeItem(clock, { nativeId: 'native-002', itemId: 'item-002' })), 'bridge_error');
  expectCode(() => pending.capture(makeItem(clock)), 'stale_request');
});

test('retire clears state and permanently rejects capture or resolution', () => {
  const clock = makeClock();
  const pending = new WorkBuddyPendingItems({ now: clock.now });
  const item = makeItem(clock);
  const handle = pending.capture(item);
  pending.retire();
  pending.retire();

  expectCode(() => pending.resolve(handle, resolutionFor(item)), 'stale_request');
  expectCode(() => pending.capture(makeItem(clock, { nativeId: 'new-native' })), 'stale_request');
});

test('invalid objects, inherited fields, malformed handles and caller clock rollback fail closed', () => {
  const clock = makeClock();
  const pending = new WorkBuddyPendingItems({ now: clock.now });
  const item = makeItem(clock);
  expectCode(() => pending.capture(Object.assign(Object.create({ hidden: 'x' }), item)), 'invalid_params');
  expectCode(() => pending.capture({ ...item, unexpected: 'x' }), 'invalid_params');
  const nonEnumerableExtra = { ...item };
  Object.defineProperty(nonEnumerableExtra, 'hidden', { value: 'x', enumerable: false });
  expectCode(() => pending.capture(nonEnumerableExtra), 'invalid_params');
  const symbolExtra = { ...item, [Symbol('hidden')]: 'x' };
  expectCode(() => pending.capture(symbolExtra), 'invalid_params');
  let getterCalled = false;
  const accessorField = { ...item };
  Object.defineProperty(accessorField, 'actionId', { get() { getterCalled = true; return item.actionId; } });
  expectCode(() => pending.capture(accessorField), 'invalid_params');
  assert.equal(getterCalled, false);
  expectCode(() => pending.invalidateConversation('conversation-001', null), 'invalid_params');
  expectCode(() => pending.invalidateConversation('conversation-001', { exceptTurnId: 'turn-001', extra: true }), 'invalid_params');

  const handle = pending.capture(item);
  expectCode(() => pending.resolve('not-a-handle', resolutionFor(item)), 'stale_request');
  clock.advance(10_001);
  expectCode(() => pending.resolve(handle, { ...resolutionFor(item), now: 0 }), 'stale_request');
});
