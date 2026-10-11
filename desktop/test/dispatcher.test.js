'use strict';
/**
 * Tests for the dispatcher in `src/index.js` (protocol-v1 §9 result shapes plus
 * the CRD 0008 additive fields).
 *
 * `createDispatcher` takes injectable adapter factories, so these tests exercise
 * the whole dispatch path - request shape, routing, adapter call, and protocol
 * result - with fake adapters. No named pipe is opened and no DSH backend is
 * touched: what is proven here is the seam between the wire and the adapter.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const os = require('node:os');
const path = require('node:path');

const { createDispatcher } = require('../src/index');

/** One recorded call set, kept beside the adapter the dispatcher sees. */
function fakeAdapter(overrides = {}) {
  const calls = { send: [], answer: [], read: [], approve: [] };
  const adapter = {
    calls,
    availableTools: () => ['list_threads', 'read_thread'],
    describe: () => ({ baseUrl: 'http://127.0.0.1:1', port: 1, pid: 2, sessions: 0, hasLocalCredential: true }),
    canStop: () => true,
    canSendWithModel: () => true,
    canAnswer: () => true,
    canApprove: () => true,
    listSessions: async () => [],
    listModels: async () => ({ models: [], projects: [] }),
    createSession: async () => {
      throw new Error('not used in these tests');
    },
    readSession: async (sessionId) => {
      calls.read.push(sessionId);
      return { id: sessionId, tool: 'dsh', title: 'T', status: 'idle', messages: [], canStop: false };
    },
    sendMessage: async (sessionId, text, options) => {
      calls.send.push({ sessionId, text, options });
      return { accepted: true, sessionId };
    },
    answerQuestion: async (sessionId, callId, answers) => {
      calls.answer.push({ sessionId, callId, answers });
      return { accepted: true, sessionId, callId };
    },
    approveRequest: async (sessionId, approvalId, decision) => {
      calls.approve.push({ sessionId, approvalId, decision });
      return { accepted: true, sessionId, approvalId, state: 'submitted' };
    },
    stopSession: async (sessionId) => ({ accepted: true, sessionId }),
    close: () => {},
    ...overrides,
  };
  return adapter;
}

function makeDispatcher(codexAdapter, dshAdapter) {
  const config = {
    createLogPath: path.join(os.tmpdir(), `ai-remote-dispatch-${crypto.randomUUID()}`, 'creates.json'),
    codex: { pipePath: null, contextThreadId: 'ctx-test' },
    dsh: { port: null },
  };
  return createDispatcher(config, () => {}, {
    codex: async () => codexAdapter,
    dsh: async () => dshAdapter,
  });
}

test('session.send forwards the next-message model to the right adapter, unchanged', async () => {
  const codexAdapter = fakeAdapter();
  const dshAdapter = fakeAdapter();
  const dispatcher = makeDispatcher(codexAdapter, dshAdapter);
  try {
    const result = await dispatcher.dispatch({
      method: 'session.send',
      params: { tool: 'dsh', sessionId: 's-1', text: 'carry on', model: 'deepseek-flash', provider: 'deepseek-account', reasoningEffort: 'high' },
    });
    assert.deepEqual(result, { accepted: true, sessionId: 's-1' });
    assert.deepEqual(dshAdapter.calls.send, [
      { sessionId: 's-1', text: 'carry on', options: { model: 'deepseek-flash', provider: 'deepseek-account', reasoningEffort: 'high' } },
    ]);
    assert.equal(codexAdapter.calls.send.length, 0, 'the other source is never used');
  } finally {
    dispatcher.close();
  }
});

test('a plain session.send is still the old request, with every optional field absent', async () => {
  const dshAdapter = fakeAdapter();
  const dispatcher = makeDispatcher(fakeAdapter(), dshAdapter);
  try {
    await dispatcher.dispatch({ method: 'session.send', params: { tool: 'dsh', sessionId: 's-1', text: 'hi' } });
    assert.deepEqual(dshAdapter.calls.send, [
      { sessionId: 's-1', text: 'hi', options: { model: undefined, provider: undefined, reasoningEffort: undefined } },
    ]);
  } finally {
    dispatcher.close();
  }
});

test('a model is refused when the adapter cannot carry one, and never reaches it', async () => {
  const codexAdapter = fakeAdapter({ canSendWithModel: () => false, canAnswer: () => false });
  const dispatcher = makeDispatcher(codexAdapter, fakeAdapter());
  try {
    const err = await dispatcher
      .dispatch({ method: 'session.send', params: { tool: 'codex', sessionId: 't-1', text: 'hi', model: 'gpt-6-sol' } })
      .catch((error) => error);
    assert.equal(err.code, 'not_capable');
    assert.equal(codexAdapter.calls.send.length, 0, 'an unverifiable model is never sent by the dispatcher either');
    // A plain send from the same adapter still works.
    const plain = await dispatcher.dispatch({ method: 'session.send', params: { tool: 'codex', sessionId: 't-1', text: 'hi' } });
    assert.deepEqual(plain, { accepted: true, sessionId: 't-1' });
    assert.equal(codexAdapter.calls.send.length, 1);
  } finally {
    dispatcher.close();
  }
});

test('session.answer reaches the adapter that can answer, and echoes the call id', async () => {
  const dshAdapter = fakeAdapter();
  const dispatcher = makeDispatcher(fakeAdapter({ canAnswer: () => false }), dshAdapter);
  try {
    const answers = [{ id: 'q-1', selected: ['One'] }, { id: 'q-2', selected: [], custom: 'note' }];
    const result = await dispatcher.dispatch({ method: 'session.answer', params: { tool: 'dsh', sessionId: 's-1', callId: 'call-9', answers } });
    assert.deepEqual(result, { accepted: true, sessionId: 's-1', callId: 'call-9' });
    assert.deepEqual(dshAdapter.calls.answer, [{ sessionId: 's-1', callId: 'call-9', answers }]);
  } finally {
    dispatcher.close();
  }
});

test('session.answer for a tool with no answer path is not_capable, and sends nothing', async () => {
  const codexAdapter = fakeAdapter({ canAnswer: () => false });
  const dispatcher = makeDispatcher(codexAdapter, fakeAdapter());
  try {
    const err = await dispatcher
      .dispatch({ method: 'session.answer', params: { tool: 'codex', sessionId: 't-1', callId: 'call-9', answers: [{ id: 'q-1', selected: [] }] } })
      .catch((error) => error);
    assert.equal(err.code, 'not_capable');
    assert.equal(codexAdapter.calls.answer.length, 0);
  } finally {
    dispatcher.close();
  }
});

test('session.read passes the adapter native model and questions into the wire result', async () => {
  const dshAdapter = fakeAdapter({
    readSession: async (sessionId) => ({
      id: sessionId,
      tool: 'dsh',
      title: 'T',
      status: 'idle',
      messages: [],
      canStop: false,
      currentModel: { model: 'deepseek-flash', provider: 'deepseek-account', reasoningEffort: 'high' },
      pendingQuestions: [{ callId: 'call-9', state: 'continued', questions: [{ id: 'q-1', question: 'Which?' }] }],
      pendingApprovals: [{ id: '11111111-2222-4333-8444-555555555555', toolName: 'run_command' }],
    }),
  });
  const dispatcher = makeDispatcher(fakeAdapter(), dshAdapter);
  try {
    const result = await dispatcher.dispatch({ method: 'session.read', params: { tool: 'dsh', sessionId: 's-1' } });
    assert.deepEqual(result.currentModel, { model: 'deepseek-flash', provider: 'deepseek-account', reasoningEffort: 'high' });
    assert.deepEqual(result.pendingQuestions, [{ callId: 'call-9', state: 'continued', questions: [{ id: 'q-1', question: 'Which?' }] }]);
    assert.deepEqual(result.pendingApprovals, [{ id: '11111111-2222-4333-8444-555555555555', toolName: 'run_command' }]);

    // An adapter that read nothing native reports none of the three fields.
    const bare = makeDispatcher(fakeAdapter(), fakeAdapter());
    try {
      const plain = await bare.dispatch({ method: 'session.read', params: { tool: 'dsh', sessionId: 's-1' } });
      assert.equal(plain.currentModel, undefined);
      assert.equal(plain.pendingQuestions, undefined);
      assert.equal(plain.pendingApprovals, undefined);
    } finally {
      bare.close();
    }
  } finally {
    dispatcher.close();
  }
});

test('session.approve reaches the adapter, echoes both identities and never upgrades the state', async () => {
  const dshAdapter = fakeAdapter();
  const dispatcher = makeDispatcher(fakeAdapter({ canApprove: () => false }), dshAdapter);
  const approvalId = '11111111-2222-4333-8444-555555555555';
  try {
    const result = await dispatcher.dispatch({ method: 'session.approve', params: { tool: 'dsh', sessionId: 's-1', approvalId, decision: 'allow-once' } });
    // `submitted` is what the transport proved; the dispatcher never turns it into
    // anything stronger on its own.
    assert.deepEqual(result, { accepted: true, sessionId: 's-1', approvalId, state: 'submitted' });
    assert.deepEqual(dshAdapter.calls.approve, [{ sessionId: 's-1', approvalId, decision: 'allow-once' }]);

    // `confirmed` travels only when the adapter itself proved it from native state.
    const confirmed = makeDispatcher(fakeAdapter(), fakeAdapter({
      approveRequest: async (sessionId, id, decision) => {
        void decision;
        return { accepted: true, sessionId, approvalId: id, state: 'confirmed' };
      },
    }));
    try {
      const proven = await confirmed.dispatch({ method: 'session.approve', params: { tool: 'dsh', sessionId: 's-1', approvalId, decision: 'reject' } });
      assert.equal(proven.state, 'confirmed');
    } finally {
      confirmed.close();
    }
  } finally {
    dispatcher.close();
  }
});

test('approving on a tool with no approval surface is not_capable, and sends nothing', async () => {
  const codexAdapter = fakeAdapter({ canApprove: () => false });
  const dispatcher = makeDispatcher(codexAdapter, fakeAdapter());
  const approvalId = '11111111-2222-4333-8444-555555555555';
  try {
    const err = await dispatcher
      .dispatch({ method: 'session.approve', params: { tool: 'codex', sessionId: 't-1', approvalId, decision: 'allow-once' } })
      .catch((error) => error);
    assert.equal(err.code, 'not_capable');
    assert.equal(codexAdapter.calls.approve.length, 0);

    // A stand-in that claims the bit but cannot carry the call refuses too.
    const lying = makeDispatcher(fakeAdapter({ canApprove: () => true, approveRequest: undefined }), fakeAdapter());
    try {
      const lyingErr = await lying
        .dispatch({ method: 'session.approve', params: { tool: 'codex', sessionId: 't-1', approvalId, decision: 'allow-once' } })
        .catch((error) => error);
      assert.equal(lyingErr.code, 'not_capable');
    } finally {
      lying.close();
    }
  } finally {
    dispatcher.close();
  }
});

test('the capability bits and needsInput come from the adapters themselves', async () => {
  const codexAdapter = fakeAdapter({ canSendWithModel: () => false, canAnswer: () => false, canApprove: () => false });
  const dshAdapter = fakeAdapter({
    listSessions: async () => [
      { id: 's-q', tool: 'dsh', title: 'Waiting', status: 'idle', updatedAt: '2026-10-08T03:00:00Z', cwd: null, needsInput: true },
    ],
  });
  const dispatcher = makeDispatcher(codexAdapter, dshAdapter);
  try {
    const listed = await dispatcher.dispatch({ method: 'sessions.list', params: {} });
    assert.equal(listed.capabilities['session.send:model:dsh'], true);
    assert.equal(listed.capabilities['session.answer:dsh'], true);
    assert.equal(listed.capabilities['session.send:model:codex'], false, 'a tool whose schema documents no catalogue must not claim the bit');
    assert.equal(listed.capabilities['session.answer:codex'], false);
    // Requirement F: the approval bit is per tool and comes from the adapter.
    assert.equal(listed.capabilities['session.approve:dsh'], true);
    assert.equal(listed.capabilities['session.approve:codex'], false, 'a channel with no approval surface must not claim the bit');
    assert.equal(listed.sessions.find((session) => session.id === 's-q').needsInput, true);
  } finally {
    dispatcher.close();
  }
});

test('a source that cannot be opened takes its own capabilities down, never the other source', async () => {
  const dshAdapter = fakeAdapter();
  const dispatcher = makeDispatcher(null, dshAdapter);
  try {
    const listed = await dispatcher.dispatch({ method: 'sessions.list', params: {} });
    assert.deepEqual(listed.capabilities.tools, ['dsh']);
    assert.equal(listed.capabilities['session.send:model:dsh'], true);
    assert.equal(listed.capabilities['session.send:model:codex'], false);
    assert.equal(listed.capabilities['session.answer:codex'], false);
    assert.equal(listed.capabilities['session.approve:codex'], false);
    assert.equal(listed.capabilities['session.approve:dsh'], true);
  } finally {
    dispatcher.close();
  }
});

test('WorkBuddy remains visible as unavailable without inventing sessions or decision paths', async () => {
  const codexAdapter = fakeAdapter({ canAnswer: () => false, canApprove: () => false });
  const dshAdapter = fakeAdapter();
  const dispatcher = makeDispatcher(codexAdapter, dshAdapter);
  try {
    const listed = await dispatcher.dispatch({ method: 'sessions.list', params: {} });
    assert.deepEqual(listed.capabilities.tools, ['codex', 'dsh'], 'only opened adapters count as session sources');
    assert.equal(listed.capabilities.toolStatus.workbuddy.available, false);
    assert.match(listed.capabilities.toolStatus.workbuddy.reason, /未接入此桥接器的受信会话控制通道/);
    for (const capability of [
      'stop:workbuddy',
      'session.send:model:workbuddy',
      'session.answer:workbuddy',
      'session.approve:workbuddy',
    ]) {
      assert.equal(listed.capabilities[capability], false, capability);
    }

    const sessions = await dispatcher.dispatch({ method: 'sessions.list', params: { tool: 'workbuddy' } }).catch((error) => error);
    const answer = await dispatcher.dispatch({
      method: 'session.answer',
      params: { tool: 'workbuddy', sessionId: 'wb-1', callId: 'native-call-1', answers: [{ id: 'q-1', selected: ['yes'] }] },
    }).catch((error) => error);
    assert.equal(sessions.code, 'not_capable');
    const approval = await dispatcher.dispatch({
      method: 'session.approve',
      params: { tool: 'workbuddy', sessionId: 'wb-1', approvalId: '11111111-2222-4333-8444-555555555555', decision: 'allow-once' },
    }).catch((error) => error);
    assert.equal(answer.code, 'not_capable');
    assert.equal(approval.code, 'not_capable');
    assert.deepEqual(codexAdapter.calls.answer, []);
    assert.deepEqual(dshAdapter.calls.answer, []);
    assert.deepEqual(codexAdapter.calls.approve, []);
    assert.deepEqual(dshAdapter.calls.approve, []);
  } finally {
    dispatcher.close();
  }
});

test('Codex context discovery failures remain visible as honest unavailable reasons', async () => {
  const config = {
    createLogPath: path.join(os.tmpdir(), `ai-remote-dispatch-${crypto.randomUUID()}`, 'creates.json'),
    codex: { pipePath: null, contextThreadId: null },
    dsh: { port: null },
  };
  const reason = '未找到可用的本机 Codex 对话上下文。请先打开一条本机对话。';
  const dispatcher = createDispatcher(config, () => {}, {
    codex: async () => { throw new Error(reason); },
    dsh: async () => fakeAdapter(),
  });
  try {
    const listed = await dispatcher.dispatch({ method: 'sessions.list', params: {} });
    assert.deepEqual(listed.capabilities.tools, ['dsh']);
    assert.equal(listed.capabilities.toolStatus.codex.available, false);
    assert.equal(listed.capabilities.toolStatus.codex.reason, reason);
    assert.equal(dispatcher.describe().codex.reason, reason);
  } finally {
    dispatcher.close();
  }
});
