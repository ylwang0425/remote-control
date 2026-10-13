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
const { parseRequest } = require('../src/protocol');

/** One recorded call set, kept beside the adapter the dispatcher sees. */
function fakeAdapter(overrides = {}) {
  const calls = { send: [], answer: [], read: [], approve: [], models: [], create: [] };
  const adapter = {
    calls,
    availableTools: () => ['list_threads', 'read_thread'],
    describe: () => ({ baseUrl: 'http://127.0.0.1:1', port: 1, pid: 2, sessions: 0, hasLocalCredential: true }),
    canStop: () => true,
    canSend: () => true,
    canSendWithModel: () => true,
    canAnswer: () => true,
    canApprove: () => true,
    listSessions: async () => [],
    listModels: async () => {
      calls.models.push(true);
      return { models: [], projects: [] };
    },
    createSession: async (input) => {
      calls.create.push(input);
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

function makeDispatcher(codexAdapter, dshAdapter, workbuddyAdapter = null, configOverrides = {}) {
  const config = {
    createLogPath: path.join(os.tmpdir(), `ai-remote-dispatch-${crypto.randomUUID()}`, 'creates.json'),
    codex: { pipePath: null, contextThreadId: 'ctx-test' },
    dsh: { port: null },
    workbuddy: { configDir: 'C:\\Users\\Local\\.workbuddy', uiAutomation: { enabled: false, executablePath: null }, ...configOverrides.workbuddy },
  };
  return createDispatcher(config, () => {}, {
    codex: async () => codexAdapter,
    dsh: async () => dshAdapter,
    workbuddy: async () => {
      if (workbuddyAdapter !== null) return workbuddyAdapter;
      throw new Error('未找到可读取的 WorkBuddy 本地会话存储');
    },
  });
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

test('Codex native control is passed only with explicit opt-in and the exact per-run registry', async () => {
  const controlRunId = crypto.randomUUID();
  const controlRegistry = path.resolve(os.tmpdir(), `ai-remote-codex-native-${controlRunId}`);
  let openOptions;
  const codexAdapter = fakeAdapter();
  const dshAdapter = fakeAdapter();
  const dispatcher = createDispatcher({
    createLogPath: path.join(os.tmpdir(), `ai-remote-dispatch-${crypto.randomUUID()}`, 'creates.json'),
    codex: {
      pipePath: null,
      contextThreadId: 'ctx-test',
      nativeControl: { enabled: true, registryDir: controlRegistry, runId: controlRunId },
    },
    dsh: { port: null },
  }, () => {}, {
    codex: async (options) => { openOptions = options; return codexAdapter; },
    dsh: async () => dshAdapter,
    workbuddy: async () => { throw new Error('not configured'); },
  });
  try {
    await dispatcher.dispatch({ method: 'sessions.list', params: {} });
    assert.deepEqual(openOptions.nativeControl, { registryDir: controlRegistry, runId: controlRunId });
    assert.ok(!JSON.stringify(dispatcher.describe()).includes(controlRunId), 'local status never leaks the run identity');
  } finally {
    dispatcher.close();
  }
});

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

test('an explicit false per-tool send capability blocks dispatch even when another tool can send', async () => {
  const codexAdapter = fakeAdapter({ canSend: () => false });
  const dshAdapter = fakeAdapter();
  const dispatcher = makeDispatcher(codexAdapter, dshAdapter);
  try {
    const listed = await dispatcher.dispatch({ method: 'sessions.list', params: {} });
    assert.equal(listed.capabilities['session.send'], true, 'the generic capability remains true for DSH');
    assert.equal(listed.capabilities['session.send:codex'], false, 'Codex reports only its measured adapter ability');

    const error = await dispatcher
      .dispatch({ method: 'session.send', params: { tool: 'codex', sessionId: 't-1', text: 'hi' } })
      .catch((value) => value);
    assert.equal(error.code, 'not_capable');
    assert.equal(codexAdapter.calls.send.length, 0, 'a false bit never reaches the adapter');
    assert.equal(dshAdapter.calls.send.length, 0, 'the same message is never redirected to another tool');
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
    assert.deepEqual(result, { accepted: true, sessionId: 's-1', callId: 'call-9', state: 'confirmed' });
    assert.deepEqual(dshAdapter.calls.answer, [{ sessionId: 's-1', callId: 'call-9', answers }]);
  } finally {
    dispatcher.close();
  }
});

test('non-DSH answer acknowledgements stay submitted unless the adapter proves this exact answer', async () => {
  const answers = [{ id: 'q-1', selected: ['yes'] }];
  for (const nativeState of [undefined, 'submitted', 'confirmed']) {
    const codexAdapter = fakeAdapter({
      answerQuestion: async (sessionId, callId, outgoing) => {
        codexAdapter.calls.answer.push({ sessionId, callId, answers: outgoing });
        return { accepted: true, sessionId, callId, state: nativeState };
      },
    });
    const dispatcher = makeDispatcher(codexAdapter, fakeAdapter());
    try {
      const result = await dispatcher.dispatch({
        method: 'session.answer',
        params: { tool: 'codex', sessionId: 't-1', callId: 'native-call', answers },
      });
      assert.equal(result.state, nativeState === undefined ? 'submitted' : nativeState);
      assert.equal(codexAdapter.calls.answer.length, 1);
    } finally {
      dispatcher.close();
    }
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

test('WorkBuddy session.read prefers the deadline-aware live read and preserves the legacy read seam elsewhere', async () => {
  const questionId = crypto.randomUUID();
  const approvalId = crypto.randomUUID();
  const pendingQuestions = [{
    callId: questionId,
    state: 'open',
    questions: [{ id: 'bridge-q-0', question: 'Choose?', options: [{ label: 'A' }, { label: 'B' }] }],
  }];
  const pendingApprovals = [{
    id: approvalId,
    toolName: 'Bash',
    reason: 'Run a command',
    context: { kind: 'command', command: 'echo safe', cwd: 'C:\\work' },
  }];
  const hooks = Object.freeze({
    checkActive() { checks += 1; },
    remainingBudgetMs: () => 12000,
  });
  let checks = 0;
  let liveReadArgs;
  let workbuddyLegacyReads = 0;
  let codexLiveReads = 0;
  const workbuddyAdapter = fakeAdapter({
    canStop: () => true,
    stopSession: undefined,
    readSession: async (sessionId) => {
      workbuddyLegacyReads += 1;
      return { id: sessionId, tool: 'workbuddy', title: 'Legacy', status: 'idle', messages: [] };
    },
    readSessionLive: async (sessionId, passedHooks) => {
      liveReadArgs = { sessionId, hooks: passedHooks };
      passedHooks.checkActive();
      return {
        id: sessionId,
        tool: 'workbuddy',
        title: 'Live WorkBuddy session',
        status: 'working',
        activeTurnId: 'turn-live',
        messages: [],
        canStop: true,
        pendingQuestions,
        pendingApprovals,
      };
    },
  });
  const codexAdapter = fakeAdapter({
    readSessionLive: async () => {
      codexLiveReads += 1;
      throw new Error('non-WorkBuddy adapters must retain readSession');
    },
  });
  const dispatcher = makeDispatcher(codexAdapter, fakeAdapter(), workbuddyAdapter);
  try {
    const workbuddy = await dispatcher.dispatch({
      method: 'session.read',
      params: { tool: 'workbuddy', sessionId: 'wb-existing' },
      internal: { workbuddyHooks: hooks },
    });
    assert.equal(liveReadArgs.sessionId, 'wb-existing');
    assert.equal(liveReadArgs.hooks, hooks);
    assert.ok(checks >= 3, 'the queued request, live read, and adapter read all check the same deadline hook');
    assert.equal(workbuddyLegacyReads, 0, 'a live-capable adapter must not fall back after its live read');
    assert.equal(workbuddy.canStop, false, 'session stop is still gated by the adapter method and broad capability');
    assert.deepEqual(workbuddy.pendingQuestions, pendingQuestions);
    assert.deepEqual(workbuddy.pendingApprovals, pendingApprovals);
    assert.equal(JSON.stringify(workbuddy).includes('remainingBudgetMs'), false);
    assert.equal(JSON.stringify(workbuddy).includes('nativeCallId'), false);

    const parsedWireRead = parseRequest({
      id: crypto.randomUUID(),
      method: 'session.read',
      params: { tool: 'workbuddy', sessionId: 'wb-existing' },
      internal: { workbuddyHooks: hooks },
    });
    assert.deepEqual(parsedWireRead.params, { tool: 'workbuddy', sessionId: 'wb-existing' });
    assert.equal(Object.hasOwn(parsedWireRead, 'internal'), false, 'wire input cannot supply adapter-only hooks');

    const legacy = await dispatcher.dispatch({
      method: 'session.read',
      params: { tool: 'codex', sessionId: 'thread-existing' },
      internal: { workbuddyHooks: hooks },
    });
    assert.equal(legacy.id, 'thread-existing');
    assert.equal(codexLiveReads, 0);
    assert.deepEqual(codexAdapter.calls.read, ['thread-existing']);

    const fakeWireRequest = {
      id: crypto.randomUUID(),
      method: 'session.read',
      params: { tool: 'workbuddy', sessionId: 'wb-existing', pendingQuestions },
    };
    assert.throws(() => parseRequest(fakeWireRequest), (error) => error.code === 'invalid_params');
  } finally {
    await dispatcher.close();
  }
});

test('WorkBuddy session.read falls back to the legacy read method and checks its internal deadline hooks', async () => {
  let checks = 0;
  const hooks = {
    checkActive() { checks += 1; },
    remainingBudgetMs: () => 9000,
  };
  const workbuddyAdapter = fakeAdapter({
    readSession: async (sessionId) => {
      workbuddyAdapter.calls.read.push(sessionId);
      return { id: sessionId, tool: 'workbuddy', title: 'Legacy WorkBuddy session', status: 'idle', messages: [] };
    },
  });
  const dispatcher = makeDispatcher(fakeAdapter(), fakeAdapter(), workbuddyAdapter);
  try {
    const result = await dispatcher.dispatch({
      method: 'session.read',
      params: { tool: 'workbuddy', sessionId: 'wb-legacy' },
      internal: { workbuddyHooks: hooks },
    });
    assert.equal(result.id, 'wb-legacy');
    assert.deepEqual(workbuddyAdapter.calls.read, ['wb-legacy']);
    assert.ok(checks >= 3, 'the queue, dispatcher, and completed read all check the same deadline hook');
  } finally {
    await dispatcher.close();
  }
});

test('WorkBuddy stop, answer, and approval capabilities require their adapter methods as well as true flags', async () => {
  const workbuddyAdapter = fakeAdapter({
    canStop: () => true,
    stopSession: undefined,
    canAnswer: () => true,
    answerQuestion: undefined,
    canApprove: () => true,
    approveRequest: undefined,
  });
  const dispatcher = makeDispatcher(fakeAdapter(), fakeAdapter(), workbuddyAdapter);
  try {
    const listed = await dispatcher.dispatch({ method: 'sessions.list', params: { tool: 'workbuddy' } });
    assert.equal(listed.capabilities['stop:workbuddy'], false);
    assert.equal(listed.capabilities['session.answer:workbuddy'], false);
    assert.equal(listed.capabilities['session.approve:workbuddy'], false);
  } finally {
    await dispatcher.close();
  }
});

test('session.read never promotes an explicit per-session canStop false from the tool capability', async () => {
  const codexAdapter = fakeAdapter({
    canStop: () => true,
    readSession: async (sessionId) => ({
      id: sessionId, tool: 'codex', title: 'Ambiguous owner', status: 'working', messages: [], canStop: false, activeTurnId: 'turn-ambiguous',
    }),
  });
  const dispatcher = makeDispatcher(codexAdapter, fakeAdapter());
  try {
    const result = await dispatcher.dispatch({ method: 'session.read', params: { tool: 'codex', sessionId: 'thread-1' } });
    assert.equal(result.canStop, false, 'the adapter’s exact session state takes precedence over its broad tool flag');
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
    assert.match(listed.capabilities.toolStatus.workbuddy.reason, /未找到可读取/);
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
    assert.deepEqual(sessions.sessions, []);
    assert.equal(sessions.capabilities.toolStatus.workbuddy.available, false);
    const approval = await dispatcher.dispatch({
      method: 'session.approve',
      params: { tool: 'workbuddy', sessionId: 'wb-1', approvalId: '11111111-2222-4333-8444-555555555555', decision: 'allow-once' },
    }).catch((error) => error);
    assert.equal(answer.code, 'tool_unavailable', 'an unavailable WorkBuddy adapter is not replaced by another tool');
    assert.equal(approval.code, 'tool_unavailable');
    assert.deepEqual(codexAdapter.calls.answer, []);
    assert.deepEqual(dshAdapter.calls.answer, []);
    assert.deepEqual(codexAdapter.calls.approve, []);
    assert.deepEqual(dshAdapter.calls.approve, []);
  } finally {
    dispatcher.close();
  }
});

test('WorkBuddy opt-in reaches only its adapter and stays absent from local status details', async () => {
  const executablePath = 'C:\\Program Files\\WorkBuddy\\WorkBuddy.exe';
  let openOptions;
  const workbuddyAdapter = fakeAdapter({
    canSend: () => false,
    canStop: () => false,
    canAnswer: () => false,
    canApprove: () => false,
    describe: () => ({
      uiAutomation: {
        enabled: true,
        requiresDefaultInputDesktop: true,
        requiresForegroundTarget: true,
        lastSnapshot: {
          observedAt: '2026-10-11T10:00:00.000Z',
          desktopKind: 'default',
          targetMatched: true,
          isForeground: false,
          nativeDebugBody: 'must-not-reach-status',
        },
      },
      nativeDebugBody: 'also-must-not-reach-status',
    }),
  });
  const dispatcher = createDispatcher({
    createLogPath: path.join(os.tmpdir(), `ai-remote-dispatch-${crypto.randomUUID()}`, 'creates.json'),
    codex: { pipePath: null },
    dsh: { port: null },
    workbuddy: { configDir: 'C:\\Users\\Local\\.workbuddy', uiAutomation: { enabled: true, executablePath, configurationValid: true } },
  }, () => {}, {
    codex: async () => fakeAdapter(),
    dsh: async () => fakeAdapter(),
    workbuddy: async (options) => { openOptions = options; return workbuddyAdapter; },
  });
  try {
    await dispatcher.dispatch({ method: 'sessions.list', params: {} });
    assert.deepEqual(openOptions, {
      configDir: 'C:\\Users\\Local\\.workbuddy',
      uiAutomation: { enabled: true, executablePath },
    });
    const status = dispatcher.describe().workbuddy;
    assert.equal(status.readOnly, true);
    assert.equal(status.uiAutomation.enabled, true);
    assert.equal(status.uiAutomation.needsUnlockedDesktop, true);
    assert.equal(status.uiAutomation.requiresForegroundTarget, true);
    assert.deepEqual(status.uiAutomation.lastObserved, {
      observedAt: '2026-10-11T10:00:00.000Z',
      desktopKind: 'default',
      targetMatched: true,
      isForeground: false,
    });
    assert.ok(!JSON.stringify(status).includes(executablePath), 'local status never returns the configured executable path');
    assert.ok(!JSON.stringify(status).includes('nativeDebugBody'));
    assert.ok(!JSON.stringify(status).includes('must-not-reach-status'));
  } finally {
    dispatcher.close();
  }
});

test('WorkBuddy measured false flags reject exact-tool calls and never fall through to DSH', async () => {
  const dshAdapter = fakeAdapter();
  const workbuddyAdapter = fakeAdapter({
    canModelsList: () => false,
    canCreate: () => false,
    canSend: () => false,
    canStop: () => false,
    canSendWithModel: () => false,
    canAnswer: () => false,
    canApprove: () => false,
  });
  const dispatcher = makeDispatcher(fakeAdapter(), dshAdapter, workbuddyAdapter);
  try {
    const listed = await dispatcher.dispatch({ method: 'sessions.list', params: {} });
    assert.equal(listed.capabilities['models.list:workbuddy'], false);
    assert.equal(listed.capabilities['session.create:workbuddy'], false);
    assert.equal(listed.capabilities['session.send:workbuddy'], false);
    assert.equal(listed.capabilities['stop:workbuddy'], false);
    assert.equal(listed.capabilities['session.answer:workbuddy'], false);
    assert.equal(listed.capabilities['session.approve:workbuddy'], false);

    const requests = [
      { method: 'models.list', params: { tool: 'workbuddy' } },
      { method: 'session.create', params: { tool: 'workbuddy', model: 'same-as-dsh', requestId: crypto.randomUUID() } },
      { method: 'session.send', params: { tool: 'workbuddy', sessionId: 'wb-1', text: 'do not redirect' } },
      { method: 'session.stop', params: { tool: 'workbuddy', sessionId: 'wb-1' } },
      { method: 'session.answer', params: { tool: 'workbuddy', sessionId: 'wb-1', callId: 'q-1', answers: [{ id: 'q', selected: ['yes'] }] } },
      { method: 'session.approve', params: { tool: 'workbuddy', sessionId: 'wb-1', approvalId: '11111111-2222-4333-8444-555555555555', decision: 'allow-once' } },
    ];
    for (const request of requests) {
      const error = await dispatcher.dispatch(request).catch((value) => value);
      assert.equal(error.code, 'not_capable', request.method);
    }
    assert.deepEqual(workbuddyAdapter.calls.models, [], 'no model method runs when its capability is false');
    assert.deepEqual(workbuddyAdapter.calls.create, [], 'no native session is created when its capability is false');
    assert.deepEqual(workbuddyAdapter.calls.send, []);
    assert.deepEqual(workbuddyAdapter.calls.answer, []);
    assert.deepEqual(workbuddyAdapter.calls.approve, []);
    assert.deepEqual(dshAdapter.calls.models, [], 'the other catalog is not consulted');
    assert.deepEqual(dshAdapter.calls.create, [], 'the other creator is not consulted');
    assert.deepEqual(dshAdapter.calls.send, [], 'messages do not change tools');
    assert.deepEqual(dshAdapter.calls.answer, []);
    assert.deepEqual(dshAdapter.calls.approve, []);
  } finally {
    dispatcher.close();
  }
});

test('exact WorkBuddy actions and reads do not open the Codex or DSH adapters for capability discovery', async () => {
  let unrelatedOpens = 0;
  const workbuddyAdapter = fakeAdapter({
    canModelsList: () => false,
    canCreate: () => false,
    canSend: () => false,
    canStop: () => false,
    canSendWithModel: () => false,
    canAnswer: () => false,
    canApprove: () => false,
    readSession: async (sessionId) => ({ id: sessionId, tool: 'workbuddy', title: 'WB', status: 'idle', messages: [] }),
  });
  const dispatcher = createDispatcher({
    createLogPath: path.join(os.tmpdir(), `ai-remote-dispatch-${crypto.randomUUID()}`, 'creates.json'),
    codex: { pipePath: null, contextThreadId: null },
    dsh: { port: null },
    workbuddy: { configDir: 'C:\\Users\\Local\\.workbuddy', uiAutomation: { enabled: false } },
  }, () => {}, {
    codex: async () => { unrelatedOpens += 1; throw new Error('Codex must not be opened for a WorkBuddy request'); },
    dsh: async () => { unrelatedOpens += 1; throw new Error('DSH must not be opened for a WorkBuddy request'); },
    workbuddy: async () => workbuddyAdapter,
  });
  try {
    for (const request of [
      { method: 'models.list', params: { tool: 'workbuddy' } },
      { method: 'session.create', params: { tool: 'workbuddy', model: 'not-available', requestId: crypto.randomUUID() } },
      { method: 'session.send', params: { tool: 'workbuddy', sessionId: 'wb-existing', text: 'no submission' } },
      { method: 'session.stop', params: { tool: 'workbuddy', sessionId: 'wb-existing' } },
      { method: 'session.answer', params: { tool: 'workbuddy', sessionId: 'wb-existing', callId: 'question', answers: [{ id: 'q', selected: ['a'] }] } },
      { method: 'session.approve', params: { tool: 'workbuddy', sessionId: 'wb-existing', approvalId: crypto.randomUUID(), decision: 'reject' } },
    ]) {
      const error = await dispatcher.dispatch(request).catch((value) => value);
      assert.equal(error.code, 'not_capable', request.method);
    }
    const read = await dispatcher.dispatch({ method: 'session.read', params: { tool: 'workbuddy', sessionId: 'wb-existing' } });
    assert.equal(read.id, 'wb-existing');
    assert.equal(unrelatedOpens, 0);
    assert.deepEqual(workbuddyAdapter.calls.models, []);
    assert.deepEqual(workbuddyAdapter.calls.create, []);
    assert.deepEqual(workbuddyAdapter.calls.send, []);
    assert.deepEqual(workbuddyAdapter.calls.answer, []);
    assert.deepEqual(workbuddyAdapter.calls.approve, []);
  } finally {
    await dispatcher.close();
  }
});

test('enabled WorkBuddy model and create methods run on WorkBuddy only when both flags are measured', async () => {
  const dshAdapter = fakeAdapter();
  const workbuddyAdapter = fakeAdapter({
    canModelsList: () => true,
    canCreate: () => true,
    canSend: () => false,
    canStop: () => false,
    canAnswer: () => false,
    canApprove: () => false,
    listModels: async () => {
      workbuddyAdapter.calls.models.push(true);
      return { models: [{ id: 'same-as-dsh', name: 'WorkBuddy model' }], projects: [] };
    },
    createSession: async (input) => {
      workbuddyAdapter.calls.create.push(input);
      return { sessionId: 'wb-native-new', title: 'Native WorkBuddy conversation' };
    },
  });
  const dispatcher = makeDispatcher(fakeAdapter(), dshAdapter, workbuddyAdapter);
  try {
    const listed = await dispatcher.dispatch({ method: 'models.list', params: { tool: 'workbuddy' } });
    assert.deepEqual(listed.models, [{ id: 'same-as-dsh', label: 'same-as-dsh' }]);
    assert.equal(listed.tool, 'workbuddy');

    const created = await dispatcher.dispatch({
      method: 'session.create',
      params: { tool: 'workbuddy', model: 'same-as-dsh', requestId: crypto.randomUUID(), text: 'first message' },
    });
    assert.equal(created.tool, 'workbuddy');
    assert.equal(created.sessionId, 'wb-native-new');
    assert.equal(workbuddyAdapter.calls.models.length, 2, 'creation validates against this adapter’s fresh native catalog');
    assert.equal(workbuddyAdapter.calls.create.length, 1);
    assert.equal(workbuddyAdapter.calls.create[0].model, 'same-as-dsh');
    assert.deepEqual(dshAdapter.calls.models, []);
    assert.deepEqual(dshAdapter.calls.create, []);
  } finally {
    dispatcher.close();
  }
});

test('WorkBuddy refresh waits for an accepted send and old adapter close before replacement', async () => {
  const sendEntered = deferred();
  const finishSend = deferred();
  const closeStarted = deferred();
  const finishClose = deferred();
  const oldAdapter = fakeAdapter({
    canSend: () => true,
    sendMessage: async (sessionId, text) => {
      oldAdapter.calls.send.push({ sessionId, text });
      sendEntered.resolve();
      await finishSend.promise;
      return { accepted: true, sessionId };
    },
    close: async () => {
      oldAdapter.closeCalls = (oldAdapter.closeCalls ?? 0) + 1;
      closeStarted.resolve();
      await finishClose.promise;
    },
  });
  const newAdapter = fakeAdapter({
    canSend: () => false,
    canStop: () => false,
    canAnswer: () => false,
    canApprove: () => false,
    close: () => {},
  });
  const config = {
    createLogPath: path.join(os.tmpdir(), `ai-remote-dispatch-${crypto.randomUUID()}`, 'creates.json'),
    codex: { pipePath: null, contextThreadId: 'ctx-test' },
    dsh: { port: null },
    workbuddy: { configDir: 'C:\\Users\\Local\\.workbuddy', uiAutomation: { enabled: false, executablePath: null } },
  };
  let openCount = 0;
  const dispatcher = createDispatcher(config, () => {}, {
    codex: async () => fakeAdapter(),
    dsh: async () => fakeAdapter(),
    workbuddy: async () => (++openCount === 1 ? oldAdapter : newAdapter),
  });
  let sendPromise;
  let refreshPromise;
  try {
    sendPromise = dispatcher.dispatch({
      method: 'session.send',
      params: { tool: 'workbuddy', sessionId: 'wb-existing-id', text: 'exactly once' },
    });
    await sendEntered.promise;

    config.workbuddy.uiAutomation = { enabled: true, executablePath: 'C:\\Apps\\WorkBuddy.exe' };
    refreshPromise = dispatcher.refreshWorkBuddy();
    await Promise.resolve();
    assert.equal(oldAdapter.closeCalls ?? 0, 0, 'refresh waits behind the in-flight native action');
    assert.equal(openCount, 1, 'refresh does not create a second adapter during the send');

    finishSend.resolve();
    const submitted = await sendPromise;
    assert.deepEqual(submitted, { accepted: true, sessionId: 'wb-existing-id' });
    await closeStarted.promise;
    assert.equal(openCount, 1, 'the replacement is not opened before old close resolves');

    finishClose.resolve();
    const capabilities = await refreshPromise;
    assert.equal(openCount, 2);
    assert.equal(capabilities.toolStatus.workbuddy.available, true);
    assert.equal(oldAdapter.calls.send.length, 1, 'the in-flight action is never replayed');
    assert.equal(oldAdapter.closeCalls, 1);
  } finally {
    finishSend.resolve();
    finishClose.resolve();
    await Promise.allSettled([sendPromise, refreshPromise].filter(Boolean));
    await dispatcher.close();
  }
});

test('a WorkBuddy action that expires in the lifecycle queue never reaches the adapter', async () => {
  const sendEntered = deferred();
  const finishSend = deferred();
  const workbuddyAdapter = fakeAdapter({
    canSend: () => true,
    sendMessage: async (sessionId, text, options, hooks) => {
      workbuddyAdapter.calls.send.push({ sessionId, text, options, hooks });
      if (text === 'hold the writer') {
        sendEntered.resolve();
        await finishSend.promise;
      }
      return { accepted: true, sessionId };
    },
  });
  const dispatcher = makeDispatcher(fakeAdapter(), fakeAdapter(), workbuddyAdapter);
  let first;
  let second;
  let active = true;
  try {
    first = dispatcher.dispatch({
      method: 'session.send',
      params: { tool: 'workbuddy', sessionId: 'wb-existing-id', text: 'hold the writer' },
    });
    await sendEntered.promise;

    const expired = Object.assign(new Error('the request deadline expired'), { code: 'bridge_timeout' });
    const hooks = {
      checkActive() { if (!active) throw expired; },
      remainingBudgetMs: () => active ? 10 : 0,
    };
    const queuedRequest = {
      method: 'session.send',
      params: { tool: 'workbuddy', sessionId: 'wb-existing-id', text: 'must stay queued' },
      internal: { workbuddyHooks: hooks },
    };
    second = dispatcher.dispatch(queuedRequest).catch((error) => error);
    await new Promise((resolve) => setImmediate(resolve));
    active = false; // stand in for the bridge's monotonic deadline expiring
    finishSend.resolve();

    assert.deepEqual(await first, { accepted: true, sessionId: 'wb-existing-id' });
    assert.equal((await second).code, 'bridge_timeout');
    assert.equal(workbuddyAdapter.calls.send.length, 1, 'the queued request never starts a native adapter action');
    assert.deepEqual(queuedRequest.params, { tool: 'workbuddy', sessionId: 'wb-existing-id', text: 'must stay queued' });
    assert.equal(workbuddyAdapter.calls.send[0].hooks, undefined, 'non-hooked work stays on its existing call contract');
  } finally {
    active = false;
    finishSend.resolve();
    await Promise.allSettled([first, second].filter(Boolean));
    await dispatcher.close();
  }
});

test('graceful dispatcher close rejects new work and drains the accepted WorkBuddy action before close', async () => {
  const sendEntered = deferred();
  const finishSend = deferred();
  const closeStarted = deferred();
  const finishClose = deferred();
  const workbuddyAdapter = fakeAdapter({
    canSend: () => true,
    sendMessage: async (sessionId, text) => {
      workbuddyAdapter.calls.send.push({ sessionId, text });
      sendEntered.resolve();
      await finishSend.promise;
      return { accepted: true, sessionId };
    },
    close: async () => {
      workbuddyAdapter.closeCalls = (workbuddyAdapter.closeCalls ?? 0) + 1;
      closeStarted.resolve();
      await finishClose.promise;
    },
  });
  const dispatcher = makeDispatcher(fakeAdapter(), fakeAdapter(), workbuddyAdapter);
  let action;
  let closing;
  try {
    action = dispatcher.dispatch({
      method: 'session.send',
      params: { tool: 'workbuddy', sessionId: 'wb-existing-id', text: 'finish before close' },
    });
    await sendEntered.promise;
    dispatcher.stopAccepting();
    closing = dispatcher.close();

    const rejected = await dispatcher.dispatch({
      method: 'session.send',
      params: { tool: 'workbuddy', sessionId: 'wb-existing-id', text: 'must not begin' },
    }).catch((error) => error);
    assert.equal(rejected.code, 'bridge_error');
    assert.equal(workbuddyAdapter.closeCalls ?? 0, 0, 'close is queued behind the active action');

    finishSend.resolve();
    assert.deepEqual(await action, { accepted: true, sessionId: 'wb-existing-id' });
    await closeStarted.promise;
    assert.equal(workbuddyAdapter.closeCalls, 1);
    finishClose.resolve();
    await closing;
    assert.equal(workbuddyAdapter.closeCalls, 1);
  } finally {
    finishSend.resolve();
    finishClose.resolve();
    await Promise.allSettled([action, closing].filter(Boolean));
  }
});

test('concurrent WorkBuddy session reads share one lazy adapter open', async () => {
  const opening = deferred();
  const adapter = fakeAdapter();
  const config = {
    createLogPath: path.join(os.tmpdir(), `ai-remote-dispatch-${crypto.randomUUID()}`, 'creates.json'),
    codex: { pipePath: null, contextThreadId: 'ctx-test' },
    dsh: { port: null },
    workbuddy: { configDir: 'C:\\Users\\Local\\.workbuddy', uiAutomation: { enabled: false, executablePath: null } },
  };
  let openCount = 0;
  const dispatcher = createDispatcher(config, () => {}, {
    codex: async () => fakeAdapter(),
    dsh: async () => fakeAdapter(),
    workbuddy: async () => {
      openCount += 1;
      await opening.promise;
      return adapter;
    },
  });
  const first = dispatcher.dispatch({ method: 'sessions.list', params: { tool: 'workbuddy' } });
  const second = dispatcher.dispatch({ method: 'sessions.list', params: { tool: 'workbuddy' } });
  try {
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(openCount, 1);
    opening.resolve();
    const results = await Promise.all([first, second]);
    assert.equal(results[0].sessions.length, 0);
    assert.equal(results[1].sessions.length, 0);
    assert.equal(openCount, 1);
  } finally {
    opening.resolve();
    await Promise.allSettled([first, second]);
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
    workbuddy: async () => { throw new Error('WorkBuddy not installed in this fixture'); },
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
