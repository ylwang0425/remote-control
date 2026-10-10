'use strict';
/**
 * Tests for the protocol-v1 frame layer (§8 frame table, §9 result shapes,
 * §9.5 capabilities, §4.1-4.5 id/status/role/tool rules).
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const protocol = require('../src/protocol');

const {
  FRAME_TYPES,
  buildHello,
  buildPairCreate,
  parseFrame,
  parseRequest,
  buildSessionsListResult,
  buildSessionReadResult,
  buildSessionSendResult,
  buildSessionStopResult,
  buildSessionAnswerResult,
  buildSessionApproveResult,
  buildModelsListResult,
  buildCapabilities,
  canStop,
  isSessionId,
  isUuidV4,
  toRfc3339,
  truncateMessageText,
  STATUS_VALUES,
  MAX_MESSAGE_TEXT,
  MAX_MESSAGE_BODY,
  METHODS,
  MAX_PENDING_BATCHES,
  MAX_PENDING_QUESTIONS,
  MAX_PENDING_OPTIONS,
  MAX_QUESTION_TEXT,
  MAX_ANSWER_CUSTOM,
  MAX_PENDING_APPROVALS,
  MAX_APPROVAL_REASON,
  MAX_APPROVAL_TOOL_NAME,
  APPROVAL_ID_LIMIT,
} = protocol;

test('the frame table is exactly the eight types the contract names', () => {
  assert.deepEqual(FRAME_TYPES, [
    'hello',
    'hello.ok',
    'ping',
    'pong',
    'pair.create',
    'pair.created',
    'pair.used',
    'request',
    'response',
  ]);
});

test('hello carries version 1, the client name and the capability object', () => {
  const frame = buildHello({ clientName: 'DESKTOP-7F3A', capabilities: buildCapabilities(['codex', 'dsh'], { stopCodex: false }) });
  assert.equal(frame.type, 'hello');
  assert.equal(frame.version, 1);
  assert.equal(frame.clientName, 'DESKTOP-7F3A');
  assert.deepEqual(frame.capabilities, {
    'sessions.list': true,
    'session.read': true,
    'session.send': true,
    'session.stop': true,
    'stop:codex': false,
    'stop:dsh': true,
    'models.list': false,
    'session.create': false,
    'session.send:model:codex': false,
    'session.send:model:dsh': false,
    'session.answer:codex': false,
    'session.answer:dsh': false,
    'session.approve:codex': false,
    'session.approve:dsh': false,
    tools: ['codex', 'dsh'],
  });
});

test('a hello with an empty client name is refused rather than sent', () => {
  assert.throws(() => buildHello({ clientName: '   ', capabilities: buildCapabilities(['codex']) }), /clientName/);
  assert.throws(() => buildHello({ clientName: 'x'.repeat(65), capabilities: buildCapabilities(['codex']) }), /clientName/);
});

test('capabilities never claim a tool twice, and never claim nothing', () => {
  // An empty tool list is legal and means "connected, but nothing to offer"
  // (protocol-v1 §9.5): every capability bit stays false, no default-on.
  const nothing = buildCapabilities([]);
  assert.deepEqual(nothing.tools, []);
  assert.equal(nothing['sessions.list'], false);
  assert.equal(nothing['session.send'], false);
  assert.equal(nothing['stop:dsh'], false);
  assert.throws(() => buildCapabilities(['codex', 'codex']), /duplicate tool/);
  assert.throws(() => buildCapabilities(['gemini']), /unknown tool/);
  const only = buildCapabilities(['codex']);
  assert.deepEqual(only.tools, ['codex']);
  assert.equal(only['stop:codex'], true);
  assert.equal(only['stop:dsh'], false);
});

test('pair.create mints a UUID v4 on this side, as CRD 0003 pins', () => {
  const frame = buildPairCreate();
  assert.equal(frame.type, 'pair.create');
  assert.ok(isUuidV4(frame.id), frame.id);
  assert.notEqual(buildPairCreate().id, frame.id, 'ids are not reused');
});

test('an unknown frame type is ignored, not an error (protocol-v1 §12.4)', () => {
  const parsed = parseFrame('{"type":"something.new","payload":1}');
  assert.equal(parsed.known, false);
  assert.equal(parsed.frame.type, 'something.new');
  assert.equal(parsed.frame.payload, 1);
});

test('a frame that is not JSON, or has no type, is a protocol error', () => {
  assert.throws(() => parseFrame('not json'), (err) => err.code === 'protocol_error');
  assert.throws(() => parseFrame('{"noType":true}'), (err) => err.code === 'protocol_error');
  assert.throws(() => parseFrame('[1,2,3]'), (err) => err.code === 'protocol_error');
});

test('a well-formed request is accepted and its fields are exactly the contract fields', () => {
  const request = parseRequest({
    type: 'request',
    id: '9c858901-8a57-4791-81fe-4c455b099bc9',
    method: 'session.read',
    params: { tool: 'codex', sessionId: 'thread-1' },
    timeoutMs: 15000,
  });
  assert.deepEqual(request, {
    id: '9c858901-8a57-4791-81fe-4c455b099bc9',
    method: 'session.read',
    params: { tool: 'codex', sessionId: 'thread-1' },
    timeoutMs: 15000,
  });
});

test('a request with an unknown method, bad id or bad params is refused', () => {
  const base = { type: 'request', id: '9c858901-8a57-4791-81fe-4c455b099bc9', params: {}, timeoutMs: 1000 };
  assert.throws(() => parseRequest({ ...base, method: 'session.duplicate' }), (e) => e.code === 'unknown_method');
  assert.throws(() => parseRequest({ ...base, id: 'not-a-uuid', method: 'sessions.list' }), (e) => e.code === 'invalid_params');
  assert.throws(
    () => parseRequest({ ...base, method: 'session.read', params: { tool: 'codex' } }),
    (e) => e.code === 'invalid_params',
  );
  assert.throws(
    () => parseRequest({ ...base, method: 'session.send', params: { tool: 'codex', sessionId: 's', text: '   ' } }),
    (e) => e.code === 'invalid_params',
  );
  assert.throws(
    () =>
      parseRequest({
        type: 'request',
        id: base.id,
        method: 'session.send',
        params: { tool: 'codex', sessionId: 's', text: 'x'.repeat(MAX_MESSAGE_TEXT + 1) },
        timeoutMs: 1000,
      }),
    (e) => e.code === 'too_long',
  );
});

test('session.send may carry a next-message model, and the combinations are pinned', () => {
  const base = { type: 'request', id: '9c858901-8a57-4791-81fe-4c455b099bc9', method: 'session.send', timeoutMs: 1000 };
  const send = (params) => parseRequest({ ...base, params: { tool: 'dsh', sessionId: 'session-1', text: 'hello', ...params } });

  // CRD 0008 §2: the whitelist grows by exactly these three optional fields.
  assert.deepEqual(send({}).params, { tool: 'dsh', sessionId: 'session-1', text: 'hello' });
  assert.deepEqual(send({ model: 'deepseek-flash', provider: 'deepseek-account', reasoningEffort: 'high' }).params, {
    tool: 'dsh',
    sessionId: 'session-1',
    text: 'hello',
    model: 'deepseek-flash',
    provider: 'deepseek-account',
    reasoningEffort: 'high',
  });

  // DSH needs the provider: the same model id lives under several providers.
  assert.throws(() => send({ model: 'deepseek-flash' }), (e) => e.code === 'invalid_params');
  // Codex must not carry one.
  assert.throws(
    () => parseRequest({ ...base, params: { tool: 'codex', sessionId: 'thread-1', text: 'hi', model: 'gpt-6-sol', provider: 'openai' } }),
    (e) => e.code === 'invalid_params',
  );
  // Neither of the two may travel without a model.
  assert.throws(() => send({ provider: 'deepseek-account' }), (e) => e.code === 'invalid_params');
  assert.throws(() => send({ reasoningEffort: 'high' }), (e) => e.code === 'invalid_params');
  // Shape rules, the same ones every other string field obeys.
  assert.throws(() => send({ model: '   ' }), (e) => e.code === 'invalid_params');
  assert.throws(() => send({ model: 'm', provider: '  ' }), (e) => e.code === 'invalid_params');
  assert.throws(() => send({ model: 'm', provider: 'p', reasoningEffort: '' }), (e) => e.code === 'invalid_params');
  assert.throws(() => send({ model: 'm', provider: 'p', reasoningEffort: 'high', temperature: 1 }), (e) => e.code === 'invalid_params');
  assert.throws(
    () => parseRequest({ ...base, params: { tool: 'codex', sessionId: 'thread-1', text: 'hi', projectId: 'p-1' } }),
    (e) => e.code === 'invalid_params',
    'the session.create-only fields stay out of session.send',
  );
});

test('session.read and session.stop still refuse the model fields', () => {
  const base = { type: 'request', id: '9c858901-8a57-4791-81fe-4c455b099bc9', timeoutMs: 1000 };
  for (const method of ['session.read', 'session.stop', 'sessions.list', 'models.list']) {
    assert.throws(
      () => parseRequest({ ...base, method, params: { tool: 'codex', sessionId: 'thread-1', model: 'gpt-6-sol' } }),
      (e) => e.code === 'invalid_params',
      `${method} must not accept a model`,
    );
  }
});

test('the models.list result may carry a reason, and does not invent one', () => {
  const withReason = buildModelsListResult({ tool: 'dsh', models: [], projects: [], reason: 'this computer has no DSH workspace catalog' });
  assert.deepEqual(withReason, { tool: 'dsh', models: [], reason: 'this computer has no DSH workspace catalog' });
  const withoutReason = buildModelsListResult({ tool: 'dsh', models: [{ id: 'm', label: 'M', provider: 'p' }], projects: [{ id: 'ws-1', name: 'One', cwd: 'D:\\one' }] });
  assert.deepEqual(withoutReason, {
    tool: 'dsh',
    models: [{ id: 'm', label: 'M', provider: 'p' }],
    projects: [{ id: 'ws-1', name: 'One', cwd: 'D:\\one' }],
  });
  assert.equal(withoutReason.reason, undefined, 'a healthy catalog carries no reason field at all');
});

test('session.read carries currentModel only when the host really reported one', () => {
  const base = {
    id: '0f1c7a2e-9b64-4c5f-8f1a-2d3e4b5c6a70',
    tool: 'dsh',
    title: 'Bridge work',
    status: 'idle',
    messages: [],
    canStop: false,
  };
  assert.deepEqual(buildSessionReadResult({ ...base, currentModel: { model: 'deepseek-flash', provider: 'deepseek-account', reasoningEffort: 'high' } }).currentModel, {
    model: 'deepseek-flash',
    provider: 'deepseek-account',
    reasoningEffort: 'high',
  });
  assert.equal(buildSessionReadResult(base).currentModel, undefined, 'nothing is manufactured when the host said nothing');
  assert.deepEqual(buildSessionReadResult({ ...base, currentModel: { model: 'deepseek-v4-pro' } }).currentModel, { model: 'deepseek-v4-pro' });
  assert.throws(() => buildSessionReadResult({ ...base, currentModel: { model: '' } }), (e) => e.code === 'bridge_error');
  assert.throws(
    () => buildSessionReadResult({ ...base, currentModel: { model: 'm', selectedBy: 'user' } }),
    (e) => e.code === 'bridge_error',
    'only the three contract fields may travel',
  );
});

test('the capability object carries the two honest send-model bits', () => {
  const withBoth = buildCapabilities(['codex', 'dsh'], { stopCodex: false, stopDsh: true, sendModelCodex: true, sendModelDsh: true });
  assert.equal(withBoth['session.send:model:codex'], true);
  assert.equal(withBoth['session.send:model:dsh'], true);
  const withoutCodex = buildCapabilities(['codex', 'dsh'], { stopCodex: false, stopDsh: true, sendModelCodex: false, sendModelDsh: true });
  assert.equal(withoutCodex['session.send:model:codex'], false, 'a tool that cannot send with a model must not claim it');
  assert.equal(withoutCodex['session.send:model:dsh'], true);
  const absent = buildCapabilities(['codex'], { stopCodex: false });
  assert.equal(absent['session.send:model:codex'], false, 'unmeasured is false, never true by default');
  assert.equal(absent['session.send:model:dsh'], false, 'a tool this desktop does not have cannot claim the bit');
  const none = buildCapabilities([]);
  assert.equal(none['session.send:model:codex'], false);
  assert.equal(none['session.send:model:dsh'], false);
});

test('sessionId and uuid validation follow the contract regexes', () => {
  assert.ok(isSessionId('01a1197c-37b6-7b40-8f81-269595d36edf'));
  assert.ok(isSessionId('a.b_c:d-e'));
  assert.ok(!isSessionId('has space'));
  assert.ok(!isSessionId(''));
  assert.ok(!isSessionId('x'.repeat(129)));
  assert.ok(!isSessionId('slash/inside'));
  assert.ok(isUuidV4('3f2504e0-4f89-41d3-9a0c-0305e82c3301'));
  assert.ok(!isUuidV4('3f2504e0-4f89-11d3-9a0c-0305e82c3301'));
});

test('timestamps are RFC3339 UTC with a Z, never a local offset', () => {
  const stamp = toRfc3339(new Date('2026-10-08T03:58:07.412Z'));
  assert.equal(stamp, '2026-10-08T03:58:07.412Z');
  assert.ok(!stamp.includes('+'));
  assert.equal(toRfc3339(new Date('2026-10-08T03:58:07.000Z')), '2026-10-08T03:58:07Z');
});

test('sessions.list sorts newest first, caps at 200, and carries the capabilities', () => {
  const capabilities = buildCapabilities(['codex', 'dsh']);
  const sessions = [
    { id: 'a', tool: 'codex', title: 'older', status: 'idle', updatedAt: '2026-10-08T03:00:00Z', cwd: null },
    { id: 'b', tool: 'dsh', title: 'newer', status: 'working', updatedAt: '2026-10-08T04:00:00Z', cwd: 'D:\\w' },
  ];
  const result = buildSessionsListResult({ sessions, capabilities });
  assert.deepEqual(result.sessions.map((s) => s.id), ['b', 'a']);
  assert.deepEqual(result.capabilities, capabilities);

  const many = Array.from({ length: 250 }, (_, i) => ({
    id: `id-${i}`,
    tool: 'codex',
    title: `t${i}`,
    status: 'idle',
    updatedAt: `2026-10-08T03:${String(i % 60).padStart(2, '0')}:00Z`,
    cwd: null,
  }));
  assert.equal(buildSessionsListResult({ sessions: many, capabilities }).sessions.length, 200);
});

test('a session in the list must not carry an empty title or a missing cwd field', () => {
  const capabilities = buildCapabilities(['codex']);
  assert.throws(
    () => buildSessionsListResult({ sessions: [{ id: 'a', tool: 'codex', title: '', status: 'idle', updatedAt: '2026-10-08T03:00:00Z', cwd: null }], capabilities }),
    /title/,
  );
  const result = buildSessionsListResult({
    sessions: [{ id: 'a', tool: 'codex', title: 'ok', status: 'idle', updatedAt: '2026-10-08T03:00:00Z', cwd: undefined }],
    capabilities,
  });
  assert.equal('cwd' in result.sessions[0], true, 'cwd is explicit null, never omitted');
  assert.equal(result.sessions[0].cwd, null);
});

test('session.read carries canStop, and gives activeTurnId only while working', () => {
  const messages = [
    { id: 'm-1', role: 'user', text: 'hi', timestamp: '2026-10-08T03:55:02Z' },
    { id: 'm-2', role: 'assistant', text: 'hello', timestamp: '2026-10-08T03:55:09Z' },
  ];
  const working = buildSessionReadResult({
    id: 'thread-1',
    tool: 'codex',
    title: 'a thread',
    status: 'working',
    messages,
    canStop: true,
    activeTurnId: 'turn-7',
  });
  assert.equal(working.canStop, true);
  assert.equal(working.activeTurnId, 'turn-7');

  const idle = buildSessionReadResult({
    id: 'thread-1',
    tool: 'codex',
    title: 'a thread',
    status: 'idle',
    messages,
    canStop: false,
  });
  assert.equal('activeTurnId' in idle, false, 'activeTurnId is omitted, not null, when not working');
});

test('canStop needs both a working session and the tool stop capability', () => {
  const capabilities = buildCapabilities(['codex', 'dsh']);
  assert.equal(canStop({ status: 'working', tool: 'dsh', capabilities }), true);
  assert.equal(canStop({ status: 'idle', tool: 'dsh', capabilities }), false);
  const noCodexStop = buildCapabilities(['codex'], { stopCodex: false });
  assert.equal(canStop({ status: 'working', tool: 'codex', capabilities: noCodexStop }), false);
});

test('sessions.list and session.read refuse a result the contract does not allow', () => {
  assert.throws(() => buildSessionReadResult({ id: 'a', tool: 'codex', title: 't', status: 'working', messages: [], canStop: true }), /activeTurnId/);
  assert.throws(() => buildSessionReadResult({ id: 'a', tool: 'gemini', title: 't', status: 'idle', messages: [], canStop: false }), /tool/);
  assert.throws(() => buildSessionReadResult({ id: 'a', tool: 'codex', title: 't', status: 'idle', messages: [{ id: 'm', role: 'nope', text: '', timestamp: 'x' }], canStop: false }), /role/);
  assert.ok(STATUS_VALUES.includes('working'));
});

test('send and stop results are exactly accepted plus the echoed sessionId', () => {
  assert.deepEqual(buildSessionSendResult('thread-9'), { accepted: true, sessionId: 'thread-9' });
  assert.deepEqual(buildSessionStopResult('thread-9'), { accepted: true, sessionId: 'thread-9' });
});

test('a single message longer than 65536 characters is truncated with an ellipsis', () => {
  const long = 'x'.repeat(70000);
  const text = truncateMessageText(long);
  assert.equal([...text].length, MAX_MESSAGE_BODY, 'protocol-v1 §9.2 caps one message body at 65536');
  assert.ok(text.endsWith('…'));
  assert.equal(truncateMessageText('short'), 'short');
});

test('an unknown status value travels unchanged instead of being rewritten', () => {
  const result = buildSessionsListResult({
    sessions: [{ id: 'a', tool: 'codex', title: 't', status: 'quietly-broken', updatedAt: '2026-10-08T03:00:00Z', cwd: null }],
    capabilities: buildCapabilities(['codex']),
  });
  assert.equal(result.sessions[0].status, 'quietly-broken');
});



test('session.answer is a real method, and its params whitelist is exactly those four', () => {
  assert.ok(METHODS.includes('session.answer'));
  const base = { type: 'request', id: '9c858901-8a57-4791-81fe-4c455b099bc9', method: 'session.answer', timeoutMs: 1000 };
  const answers = [{ id: 'q-1', selected: ['Yes'] }];
  assert.deepEqual(parseRequest({ ...base, params: { tool: 'dsh', sessionId: 'session-1', callId: 'call-1', answers } }).params, {
    tool: 'dsh',
    sessionId: 'session-1',
    callId: 'call-1',
    answers,
  });
  // Only these four: a text field here would be a second, unchecked message path.
  assert.throws(() => parseRequest({ ...base, params: { tool: 'dsh', sessionId: 'session-1', callId: 'call-1', answers, text: 'hi' } }), (e) => e.code === 'invalid_params');
  assert.throws(() => parseRequest({ ...base, params: { tool: 'dsh', sessionId: 'session-1', callId: 'call-1' } }), (e) => e.code === 'invalid_params');
  assert.throws(() => parseRequest({ ...base, params: { tool: 'dsh', sessionId: 'session-1', answers } }), (e) => e.code === 'invalid_params');
  assert.throws(() => parseRequest({ ...base, params: { tool: 'dsh', sessionId: 'session-1', callId: '   ', answers } }), (e) => e.code === 'invalid_params');
});

test('one answer per question, exactly once, and only bounded fields', () => {
  const base = { type: 'request', id: '9c858901-8a57-4791-81fe-4c455b099bc9', method: 'session.answer', timeoutMs: 1000 };
  const send = (answers, callId = 'call-1') => parseRequest({ ...base, params: { tool: 'dsh', sessionId: 's-1', callId, answers } });

  // A skipped item is legal and keeps the batch shape (selected: []).
  assert.deepEqual(send([{ id: 'q-1', selected: [] }, { id: 'q-2', selected: ['a', 'b'], custom: 'and more' }]).params.answers, [
    { id: 'q-1', selected: [] },
    { id: 'q-2', selected: ['a', 'b'], custom: 'and more' },
  ]);
  assert.throws(() => send([]), (e) => e.code === 'invalid_params', 'an empty batch answers nothing');
  assert.throws(() => send([{ id: 'q-1', selected: ['a'] }, { id: 'q-1', selected: ['b'] }]), (e) => e.code === 'invalid_params', 'a question is answered once');
  assert.throws(() => send([{ id: '', selected: [] }]), (e) => e.code === 'invalid_params');
  assert.throws(() => send([{ id: 'q-1', selected: ['a'], verified: true }]), (e) => e.code === 'invalid_params');
  assert.throws(() => send([{ id: 'q-1', selected: 'a' }]), (e) => e.code === 'invalid_params');
  assert.throws(() => send([{ id: 'q-1', selected: [''] }]), (e) => e.code === 'invalid_params');
  assert.throws(() => send([{ id: 'q-1', selected: [], custom: '   ' }]), (e) => e.code === 'invalid_params');
  assert.throws(() => send([{ id: 'q-1', selected: [], custom: 'x'.repeat(MAX_ANSWER_CUSTOM + 1) }]), (e) => e.code === 'invalid_params');
  assert.throws(
    () => send(Array.from({ length: MAX_PENDING_QUESTIONS + 1 }, (_, i) => ({ id: `q-${i}`, selected: [] }))),
    (e) => e.code === 'invalid_params',
    'a batch can never exceed the number of questions a pending form may carry',
  );
  assert.throws(
    () => send([{ id: 'q-1', selected: Array.from({ length: MAX_PENDING_OPTIONS + 1 }, (_, i) => `l-${i}`) }]),
    (e) => e.code === 'invalid_params',
  );
  // A tool that has no answer path still gets a shape-checked request, so the
  // desktop can answer not_capable instead of a confusing invalid_params.
  assert.equal(parseRequest({ ...base, params: { tool: 'codex', sessionId: 't-1', callId: 'call-1', answers: [{ id: 'q-1', selected: [] }] } }).params.tool, 'codex');
});

test('the answer result echoes both identities, and refuses a bad one', () => {
  assert.deepEqual(buildSessionAnswerResult('session-1', 'call-1'), { accepted: true, sessionId: 'session-1', callId: 'call-1' });
  assert.throws(() => buildSessionAnswerResult('bad id', 'call-1'), (e) => e.code === 'bridge_error');
  assert.throws(() => buildSessionAnswerResult('session-1', ''), (e) => e.code === 'bridge_error');
});

const PENDING_BATCH = {
  callId: 'call-1',
  state: 'continued',
  questions: [
    {
      id: 'q-1',
      question: 'Which one?',
      header: 'Choice',
      detail: 'Two options',
      options: [{ label: 'One', description: 'the first' }, { label: 'Two' }],
      multiSelect: true,
    },
  ],
};

const READ_BASE = { id: '0f1c7a2e-9b64-4c5f-8f1a-2d3e4b5c6a70', tool: 'dsh', title: 'T', status: 'idle', messages: [], canStop: false };

test('a pending question travels whole, with its real state and choices', () => {
  const result = buildSessionReadResult({ ...READ_BASE, pendingQuestions: [PENDING_BATCH] });
  assert.deepEqual(result.pendingQuestions, [PENDING_BATCH]);
  // No batch means no field at all: "nothing was read" is never "nothing waits".
  assert.equal(buildSessionReadResult({ ...READ_BASE }).pendingQuestions, undefined);
  assert.equal(buildSessionReadResult({ ...READ_BASE, pendingQuestions: [] }).pendingQuestions, undefined);
});

test('a question form this bridge cannot present in full is refused, never trimmed', () => {
  const tooManyBatches = Array.from({ length: MAX_PENDING_BATCHES + 1 }, (_, i) => ({ ...PENDING_BATCH, callId: `call-${i}` }));
  const tooManyQuestions = { ...PENDING_BATCH, questions: Array.from({ length: MAX_PENDING_QUESTIONS + 1 }, (_, i) => ({ id: `q-${i}`, question: 'x' })) };
  const tooManyOptions = {
    ...PENDING_BATCH,
    questions: [{ id: 'q-1', question: 'x', options: Array.from({ length: MAX_PENDING_OPTIONS + 1 }, (_, i) => ({ label: `l-${i}` })) }],
  };
  const tooLongText = { ...PENDING_BATCH, questions: [{ id: 'q-1', question: 'x'.repeat(MAX_QUESTION_TEXT + 1) }] };
  const unknownState = { ...PENDING_BATCH, state: 'pending' };
  const noQuestions = { ...PENDING_BATCH, questions: [] };
  const extraField = { ...PENDING_BATCH, verified: true };
  for (const pendingQuestions of [[tooManyBatches], [tooManyQuestions], [tooManyOptions], [tooLongText], [unknownState], [noQuestions], [extraField]]) {
    assert.throws(
      () => buildSessionReadResult({ ...READ_BASE, pendingQuestions }),
      (e) => e.code === 'bridge_error',
      `refused instead of shown in part: ${JSON.stringify(pendingQuestions).slice(0, 60)}`,
    );
  }
  assert.throws(() => buildSessionReadResult({ ...READ_BASE, pendingQuestions: 'nope' }), (e) => e.code === 'bridge_error');
});

test('a list entry carries needsInput only when real native pending state said so', () => {
  const capabilities = buildCapabilities(['dsh']);
  const sessions = [
    { id: 'a', tool: 'dsh', title: 'waiting', status: 'idle', updatedAt: '2026-10-08T03:00:00Z', cwd: null, needsInput: true },
    { id: 'b', tool: 'dsh', title: 'quiet', status: 'idle', updatedAt: '2026-10-08T02:00:00Z', cwd: null, needsInput: false },
    { id: 'c', tool: 'dsh', title: 'unknown', status: 'idle', updatedAt: '2026-10-08T01:00:00Z', cwd: null },
  ];
  const result = buildSessionsListResult({ sessions, capabilities });
  assert.equal(result.sessions.find((session) => session.id === 'a').needsInput, true);
  assert.equal(result.sessions.find((session) => session.id === 'b').needsInput, undefined, 'false is not evidence of a question');
  assert.equal(result.sessions.find((session) => session.id === 'c').needsInput, undefined, 'unmeasured stays absent');
});

const APPROVAL = { id: '6b1f2c34-5d6e-4f70-8a91-b2c3d4e5f607', toolName: 'run_command', callId: 'call-7', reason: 'needs to run one command' };

test('session.approve is a real method whose params are exactly four fields', () => {
  assert.ok(METHODS.includes('session.approve'));
  const base = { type: 'request', id: '9c858901-8a57-4791-81fe-4c455b099bc9', method: 'session.approve', timeoutMs: 1000 };
  const params = { tool: 'dsh', sessionId: 'session-1', approvalId: APPROVAL.id, decision: 'allow-once' };
  assert.deepEqual(parseRequest({ ...base, params }).params, params);
  assert.equal(parseRequest({ ...base, params: { ...params, decision: 'reject' } }).params.decision, 'reject');
  // An unknown field, a missing field, a blank id and a decision nobody may make
  // are all refused: there is no "allow always" and no arbitrary extra field.
  assert.throws(() => parseRequest({ ...base, params: { ...params, scope: 'always' } }), (e) => e.code === 'invalid_params');
  assert.throws(() => parseRequest({ ...base, params: { tool: 'dsh', sessionId: 'session-1', decision: 'allow-once' } }), (e) => e.code === 'invalid_params');
  assert.throws(() => parseRequest({ ...base, params: { tool: 'dsh', sessionId: 'session-1', approvalId: '  ', decision: 'allow-once' } }), (e) => e.code === 'invalid_params');
  assert.throws(() => parseRequest({ ...base, params: { ...params, decision: 'allowed-once' } }), (e) => e.code === 'invalid_params');
  assert.throws(() => parseRequest({ ...base, params: { ...params, decision: 'allow-always' } }), (e) => e.code === 'invalid_params');
  assert.throws(() => parseRequest({ ...base, params: { tool: 'dsh', sessionId: 'session-1', approvalId: APPROVAL.id, decision: 'allow-once', text: 'also send this' } }), (e) => e.code === 'invalid_params');
  assert.throws(() => parseRequest({ ...base, params: { tool: 'gemini', sessionId: 'session-1', approvalId: APPROVAL.id, decision: 'allow-once' } }), (e) => e.code === 'invalid_params');
  // The relay validates this field as a UUID, and the real value is the gateway's
  // own `randomUUID()`, so a value that is not one is refused here - where the
  // reason is visible - instead of becoming a rejected answer on the phone.
  assert.throws(() => parseRequest({ ...base, params: { ...params, approvalId: 'ev-1' } }), (e) => e.code === 'invalid_params');
  assert.throws(() => parseRequest({ ...base, params: { ...params, approvalId: `${'x'.repeat(APPROVAL_ID_LIMIT)}y` } }), (e) => e.code === 'invalid_params');
});

test('the approve result says whether it was submitted or confirmed, and nothing more', () => {
  assert.deepEqual(buildSessionApproveResult({ sessionId: 'session-1', approvalId: APPROVAL.id, state: 'submitted' }), {
    accepted: true,
    sessionId: 'session-1',
    approvalId: APPROVAL.id,
    state: 'submitted',
  });
  assert.equal(buildSessionApproveResult({ sessionId: 'session-1', approvalId: APPROVAL.id, state: 'confirmed' }).state, 'confirmed');
  // A result may not claim a decision, a policy change or an unknown state.
  assert.throws(() => buildSessionApproveResult({ sessionId: 'session-1', approvalId: APPROVAL.id, state: 'granted' }), (e) => e.code === 'bridge_error');
  assert.throws(() => buildSessionApproveResult({ sessionId: 'bad id', approvalId: APPROVAL.id, state: 'submitted' }), (e) => e.code === 'bridge_error');
  assert.throws(() => buildSessionApproveResult({ sessionId: 'session-1', approvalId: '', state: 'submitted' }), (e) => e.code === 'bridge_error');
});

test('a pending approval travels whole, and a list this bridge cannot show is refused', () => {
  const result = buildSessionReadResult({ ...READ_BASE, pendingApprovals: [APPROVAL] });
  assert.deepEqual(result.pendingApprovals, [APPROVAL]);
  // An approval with only what native really carried is the normal case.
  const minimal = { id: APPROVAL.id, toolName: 'run_command' };
  assert.deepEqual(buildSessionReadResult({ ...READ_BASE, pendingApprovals: [minimal] }).pendingApprovals, [minimal]);
  // Nothing waiting means no field at all.
  assert.equal(buildSessionReadResult({ ...READ_BASE }).pendingApprovals, undefined);
  assert.equal(buildSessionReadResult({ ...READ_BASE, pendingApprovals: [] }).pendingApprovals, undefined);

  const tooMany = Array.from({ length: MAX_PENDING_APPROVALS + 1 }, (_, i) => ({ ...APPROVAL, id: `approval-${i}` }));
  const tooLongReason = { ...APPROVAL, reason: 'x'.repeat(MAX_APPROVAL_REASON + 1) };
  const blankTool = { ...APPROVAL, toolName: '   ' };
  const tooLongTool = { ...APPROVAL, toolName: 'x'.repeat(MAX_APPROVAL_TOOL_NAME + 1) };
  const multiLineTool = { ...APPROVAL, toolName: 'run\ncommand' };
  const extraField = { ...APPROVAL, editable: true };
  const duplicate = [APPROVAL, { ...APPROVAL }];
  for (const pendingApprovals of [tooMany, [tooLongReason], [blankTool], [tooLongTool], [multiLineTool], [extraField], duplicate]) {
    assert.throws(
      () => buildSessionReadResult({ ...READ_BASE, pendingApprovals }),
      (e) => e.code === 'bridge_error',
      `refused instead of shown in part: ${JSON.stringify(pendingApprovals).slice(0, 60)}`,
    );
  }
  assert.throws(() => buildSessionReadResult({ ...READ_BASE, pendingApprovals: 'nope' }), (e) => e.code === 'bridge_error');
});

test('the approve capabilities are per tool and are never on by default', () => {
  const both = buildCapabilities(['codex', 'dsh'], { approveDsh: true });
  assert.equal(both['session.approve:dsh'], true);
  assert.equal(both['session.approve:codex'], false, 'a channel with no approval surface must not claim the bit');
  const codexOnly = buildCapabilities(['codex'], { approveCodex: true });
  assert.equal(codexOnly['session.approve:codex'], true);
  assert.equal(codexOnly['session.approve:dsh'], false, 'a tool this desktop does not have cannot claim the bit');
  const unmeasured = buildCapabilities(['dsh']);
  assert.equal(unmeasured['session.approve:dsh'], false, 'unmeasured is false, never true by default');
  assert.equal(buildCapabilities([])['session.approve:dsh'], false);
  assert.equal(buildCapabilities(['dsh'], { approveDsh: false })['session.approve:dsh'], false);
});