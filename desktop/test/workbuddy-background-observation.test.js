'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { WorkBuddyAdapter } = require('../src/adapters/workbuddy');

function fixture({ minimized = false, matching = false } = {}) {
  const adapter = new WorkBuddyAdapter({
    db: { prepare: () => ({ all: () => [], get: () => null }), close() {} },
    configDir: 'C:\\fixture', columns: [],
    uiAutomation: { enabled: true, executablePath: 'D:\\tools\\WorkBuddy\\WorkBuddy.exe' },
  });
  const calls = [];
  const target = { processId: 42, handle: '84', minimized };
  const history = { id: 'own-history', tool: 'workbuddy', title: 'Existing chat',
    status: 'unknown', messages: [{ id: 'm1', role: 'user', text: 'Existing message' }], canStop: false };
  adapter.nativeConversationIdentityCandidates = () => ({ title: 'Existing chat', anchorCandidates: [['Existing message']], expectedCandidateIndex: 0 });
  adapter.discoverNativeWindow = async () => target;
  adapter.readSession = () => history;
  adapter.pendingService.read = async (id, hooks) => adapter.readNativePendingContext(id, hooks);
  adapter.freshNativeSnapshot = async () => { calls.push('restore'); return {}; };
  adapter.assertNativeTargetSnapshot = () => {};
  adapter.uiAutomationInspector = {
    async executeNativePendingAction() { throw new Error('This observation fixture must not submit native input'); },
    async readNativePending() { calls.push('peek'); return { pendingForms: { conversationIdentityVerified: matching } }; },
    async navigateConversation() { calls.push('navigate'); matching = true; return { outcome: 'confirmed' }; },
  };
  return { adapter, calls, history };
}

test('phone history reads preserve minimization and return the same archive without UI input', async () => {
  const f = fixture({ minimized: true });
  assert.deepEqual(await f.adapter.readSessionLive('own-history'), f.history);
  assert.deepEqual(f.calls, []);
  await f.adapter.close();
});

test('viewing another chat on the phone never navigates the desktop sidebar', async () => {
  const f = fixture();
  assert.deepEqual(await f.adapter.readSessionLive('own-history'), f.history);
  assert.deepEqual(f.calls, ['peek']);
  await f.adapter.close();
});

test('a matching visible chat can still be observed without restoring or navigating', async () => {
  const f = fixture({ matching: true });
  const observation = await f.adapter.readNativePendingContext('own-history');
  assert.equal(observation.pendingForms.conversationIdentityVerified, true);
  assert.deepEqual(f.calls, ['peek']);
  await f.adapter.close();
});

test('an explicit native action can restore and navigate before rechecking identity', async () => {
  const f = fixture({ minimized: true });
  const observation = await f.adapter.readNativePendingContext('own-history', { allowWindowActivation: true });
  assert.equal(observation.pendingForms.conversationIdentityVerified, true);
  assert.deepEqual(f.calls, ['restore', 'peek', 'navigate', 'peek']);
  await f.adapter.close();
});

test('only explicit answer, approval and Stop mark their observation as an input action', async () => {
  const f = fixture();
  const checked = [];
  const hooks = { checkActive() { checked.push('check'); } };
  const seen = [];
  f.adapter.pendingService.decide = async (sessionId, id, decision, actionHooks) => {
    actionHooks.checkActive(); seen.push({ id, decision, activation: actionHooks.allowWindowActivation });
  };
  f.adapter.pendingService.stop = async (sessionId, actionHooks) => {
    actionHooks.checkActive(); seen.push({ id: 'stop', activation: actionHooks.allowWindowActivation });
  };
  await f.adapter.answerQuestion('own-history', 'question-alias', [], hooks);
  await f.adapter.approveRequest('own-history', 'approval-alias', 'reject', hooks);
  await f.adapter.stopSession('own-history', hooks);
  assert.deepEqual(seen.map(v => v.activation), [true, true, true]);
  assert.deepEqual(seen.map(v => v.id), ['question-alias', 'approval-alias', 'stop']);
  assert.ok(checked.length >= 3);
  await f.adapter.close();
});
