'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { CodexAdapter } = require('../src/adapters/codex');

const THREAD = 'thread-adapter-fixture';
const APP_TOOLS = [{ namespace: 'codex_app', name: 'read_thread' }];

function fixtureAdapter({ status = 'idle', turns = [], snapshots = [] } = {}) {
  const calls = [];
  const client = {
    async callTool(request) {
      calls.push(request);
      return { thread: { id: THREAD, title: 'Native fixture', status }, turns, page: { order: 'oldestFirst' } };
    },
    close() {},
  };
  const nativeControlRegistry = {
    ready: true,
    async snapshots(threadId) {
      assert.equal(threadId, THREAD);
      return snapshots.map((entry) => ({
        client: entry.client ?? { async interrupt() { return { state: 'submitted' }; } },
        ...entry,
      }));
    },
    async close() {},
  };
  return { adapter: new CodexAdapter({ client, contextThreadId: THREAD, tools: APP_TOOLS, nativeControlRegistry }), calls };
}

test('readSession prefers the exact app-server active turn over stale app-tools summary ids', async () => {
  const { adapter } = fixtureAdapter({
    status: 'idle',
    turns: [{ id: 'stale-summary-turn', status: 'working', items: [] }],
    snapshots: [{
      instanceId: 'desktop-child-1',
      snapshot: { observed: true, activeTurnId: 'native-live-turn', requests: [] },
    }],
  });
  const session = await adapter.readSession(THREAD);
  assert.equal(session.status, 'working');
  assert.equal(session.activeTurnId, 'native-live-turn');
  assert.equal(session.canStop, true);
});

test('readSession refuses to claim a stop owner when two native children own the same thread', async () => {
  const { adapter } = fixtureAdapter({
    status: 'working',
    turns: [{ id: 'summary-turn', status: 'working', items: [] }],
    snapshots: [
      { instanceId: 'child-a', snapshot: { observed: true, activeTurnId: 'turn-a', requests: [] } },
      { instanceId: 'child-b', snapshot: { observed: true, activeTurnId: 'turn-b', requests: [] } },
    ],
  });
  const session = await adapter.readSession(THREAD);
  assert.equal(session.canStop, false);
  assert.equal(session.activeTurnId, 'summary-turn', 'the read result keeps app-tools state while disabling ambiguous control');
  await assert.rejects(adapter.stopSession(THREAD), /more than one Codex app-server child/);
});

test('an idle subscribed child does not make a second child with a live turn ambiguous', async () => {
  const { adapter } = fixtureAdapter({
    status: 'idle',
    snapshots: [
      { instanceId: 'reader-child', snapshot: { observed: true, activeTurnId: null, requests: [] } },
      { instanceId: 'owner-child', snapshot: { observed: true, activeTurnId: 'owned-turn', requests: [] } },
    ],
  });
  const session = await adapter.readSession(THREAD);
  assert.equal(session.activeTurnId, 'owned-turn');
  assert.equal(session.canStop, true);
  const stopped = await adapter.stopSession(THREAD);
  assert.deepEqual(stopped, { state: 'submitted' });
});

test('readSession exposes native custom-answer permission and exact native approval callback id', async () => {
  const questionId = 'e54bd2c0-3f38-438e-b0f3-cf3d78c42a9d';
  const approvalId = '5160b2ab-6f71-40f5-bd84-393a8542e2ca';
  const question = { id: questionId, kind: 'question', itemId: 'question-item', questions: [{ id: 'q', question: 'Choose', allowCustom: false }] };
  const approval = { id: approvalId, kind: 'command-approval', itemId: 'command-item', callId: 'native-approval-id', toolName: 'commandExecution', command: 'npm test', cwd: 'D:\\repo', reason: 'Run requested test', context: { kind: 'command', command: 'npm test', cwd: 'D:\\repo' } };
  const { adapter } = fixtureAdapter({ snapshots: [{ instanceId: 'child', snapshot: { observed: true, activeTurnId: null, requests: [question, approval] } }] });
  const session = await adapter.readSession(THREAD);
  assert.equal(session.pendingQuestions[0].questions[0].allowCustom, false);
  assert.equal(session.pendingApprovals[0].callId, 'native-approval-id');
});

test('answer and approval requests route once through the unique native owner and retain honest submission state', async () => {
  const questionId = '5ed87a80-cf72-4834-8542-65956db1eae9';
  const approvalId = '869f7103-7e75-4ad6-ae64-ea6fb64c2a0b';
  const question = { id: questionId, kind: 'question', itemId: 'question-item', questions: [{ id: 'q', question: 'Choose', allowCustom: true }] };
  const approval = { id: approvalId, kind: 'command-approval', itemId: 'command-item', toolName: 'commandExecution', command: 'npm test', cwd: 'D:\\repo', reason: 'Run requested test', context: { kind: 'command', command: 'npm test', cwd: 'D:\\repo' } };
  const responses = [];
  const ownerClient = { async respond(value) { responses.push(value); return { state: 'submitted' }; } };
  const { adapter } = fixtureAdapter({ snapshots: [{ instanceId: 'owner', client: ownerClient, snapshot: { observed: true, activeTurnId: 'live-turn', requests: [question, approval] } }] });
  const answer = await adapter.answerQuestion(THREAD, questionId, [{ id: 'q', selected: [], custom: 'My answer' }]);
  assert.equal(answer.state, 'submitted');
  const approved = await adapter.approveRequest(THREAD, approvalId, 'allow-once');
  assert.equal(approved.state, 'submitted');
  assert.equal(responses.length, 2);
  assert.deepEqual(responses[1].answer, { decision: 'accept' });
  await assert.rejects(adapter.approveRequest(THREAD, approvalId, 'allow-for-session'), /allow-once or reject/);
});
