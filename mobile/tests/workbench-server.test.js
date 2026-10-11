// workbench-server.test.js — the REAL api.js against a REAL local HTTP server.
//
// MOCK LABEL: the relay is mobile/tests/mock-server.js (a real Node HTTP server,
// but a stand-in for the Go relay and the desktop bridge). Everything the phone
// actually ships — web/js/api.js, and the request bodies this suite builds — is
// the real code, over real sockets, real cookies and real JSON.
//
// This is the "same static bytes with clearly labelled mock data" run in Node:
// the workbench's additive RPCs (session.answer, session.approve) and its
// additive projections (currentModel, pendingQuestions, pendingApprovals,
// needsInput) are driven end to end, including the relay's own validation rules
// (params whitelist, Origin, cookie, body bounds).
//
// It is deliberately NOT a browser test: the exact-width iframe run against the
// same bytes lives with root, and the native desktop path is never touched here.
//
// Run with:  D:\env\node.exe --test mobile/tests/workbench-server.test.js
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const { createMockServer, ALLOWED_ORIGIN, CAPABILITIES } = require(path.join(__dirname, 'mock-server.js'));
const RCApi = require(path.join(__dirname, '..', 'web', 'js', 'api.js'));
const core = require(path.join(__dirname, '..', 'web', 'js', 'core.js'));

const SAMPLE = 'K7QP3MZD9XTB2RCV6HNF0JWS';
const APPROVAL_ID = '3f1a6f4e-2b0c-4d5e-8a91-0c2b7d6e5f40';

const QUESTIONS = [{
  callId: 'call-42',
  state: 'open',
  questions: [
    { id: 'q1', question: '要重试吗？', header: '构建失败', options: [{ label: '重试' }, { label: '跳过' }] },
    { id: 'q2', question: '选哪些文件？', multiSelect: true, options: [{ label: 'a.js' }, { label: 'b.js' }] }
  ]
}];

const APPROVALS = [{ id: APPROVAL_ID, toolName: 'shell', callId: 'call-43', reason: '想运行 npm test' }];

const WORKBENCH_CAPS = Object.assign({}, CAPABILITIES, {
  'models.list': true,
  'session.create': true,
  'session.answer:dsh': true,
  'session.approve:dsh': true,
  'session.answer:codex': false,
  'session.approve:codex': false
});

const CATALOG = {
  tool: 'dsh',
  models: [
    { id: 'deepseek-flash', label: 'flash', provider: 'deepseek-official', isDefault: true,
      reasoningEfforts: ['low', 'high'], defaultReasoningEffort: 'high' }
  ],
  projects: [{ id: 'p1', name: 'remote-control', cwd: 'D:\\workspace\\codex-workspace\\remote-control' }]
};

/**
 * Boot the mock relay, pair a device, and return a live api client.
 *
 * Two things a browser does for free have to be done explicitly here, because
 * this is Node:
 *   - Origin: a real browser sends it on a same-origin POST, and the mock
 *     enforces protocol-v1 5.3 exactly.
 *   - the rc_session cookie: a browser's cookie jar stores the pair response's
 *     Set-Cookie and replays it. This is the smallest jar that does the same.
 */
async function startSession(options) {
  const mock = createMockServer(options);
  const base = await mock.listen();
  const jar = { cookie: '' };
  const locatingFetch = (input, init) => {
    const requestInit = Object.assign({}, init || {});
    const headers = Object.assign({}, requestInit.headers, { Origin: ALLOWED_ORIGIN });
    if (jar.cookie) headers.Cookie = jar.cookie;
    requestInit.headers = headers;
    return fetch(base + String(input), requestInit).then((response) => {
      const setCookie = response.headers.getSetCookie ? response.headers.getSetCookie() : [];
      setCookie.forEach((value) => {
        const match = /^(rc_session=[A-Za-z0-9_-]{43})/.exec(value);
        const adminMatch = /^(rc_admin=[A-Za-z0-9_-]{43})/.exec(value);
        if (match) jar.cookie = [jar.cookie.split('; ').filter((item) => !item.startsWith('rc_session=')).join('; '), match[1]].filter(Boolean).join('; ');
        if (adminMatch) jar.cookie = [jar.cookie.split('; ').filter((item) => !item.startsWith('rc_admin=')).join('; '), adminMatch[1]].filter(Boolean).join('; ');
        if (/^rc_admin=;/.test(value)) jar.cookie = jar.cookie.split('; ').filter((item) => !item.startsWith('rc_admin=')).join('; ');
      });
      return response;
    });
  };
  const api = RCApi.createApi({ fetch: locatingFetch, timeoutMs: 5000 });
  const paired = await api.pair(SAMPLE, 'Test Phone');
  assert.equal(paired.ok, true, 'pairing must succeed so the cookie exists');
  assert.ok(jar.cookie, 'the pair response must set the session cookie');
  return { mock, base, api };
}

test('sessions.list and session.read carry the workbench projections over real HTTP', async () => {
  const session = await startSession({
    capabilities: WORKBENCH_CAPS,
    sessions: [
      { id: 'b2', tool: 'dsh', title: 'Fix login redirect', status: 'idle',
        updatedAt: '2026-10-08T02:00:00Z', cwd: null, needsInput: true }
    ],
    currentModel: { model: 'deepseek-flash', provider: 'deepseek-official', reasoningEffort: 'high' },
    pendingQuestions: QUESTIONS,
    pendingApprovals: APPROVALS
  });
  try {
    const list = await session.api.rpc(core.listBody());
    assert.equal(list.ok, true);
    assert.equal(list.result.sessions[0].needsInput, true);
    assert.equal(list.result.capabilities['session.answer:dsh'], true);

    const read = await session.api.rpc(core.readBody('dsh', 'b2'));
    assert.equal(read.ok, true);
    assert.deepEqual(core.currentModelOf(read.result), {
      model: 'deepseek-flash', provider: 'deepseek-official', reasoningEffort: 'high'
    });
    const batches = core.pendingQuestionsOf({
      capabilities: read.result.capabilities || WORKBENCH_CAPS,
      tool: 'dsh', read: read.result
    });
    assert.equal(batches.length, 1);
    assert.equal(batches[0].callId, 'call-42');
    assert.deepEqual(batches[0].questions[0].options.map((o) => o.label), ['重试', '跳过']);
    assert.equal(core.pendingApprovalsOf({
      capabilities: WORKBENCH_CAPS, tool: 'dsh', read: read.result
    })[0].id, APPROVAL_ID);
    assert.equal(core.readNeedsInput({ capabilities: WORKBENCH_CAPS, tool: 'dsh', read: read.result }), true);
  } finally {
    await session.mock.close();
  }
});

test('admin login, identity, roster, exact targeting, offline failure and logout stay separate from pairing', async () => {
  const session = await startSession({
    computers: [
      { clientId: 'same-name-a', ownerName: 'Alex', clientName: 'Work PC', online: true,
        lastSeen: '2026-10-11T09:00:00Z', tools: [{ id: 'workbuddy', available: false, reason: '聊天 API 尚未连接' }],
        sessions: [{ id: 'same-session', tool: 'workbuddy', title: 'A session', status: 'idle' }],
        capabilities: { 'sessions.list': true, tools: ['workbuddy'] } },
      { clientId: 'same-name-b', ownerName: 'Alex', clientName: 'Work PC', online: false,
        lastSeen: '2026-10-10T09:00:00Z', tools: [{ id: 'codex', available: true }], sessions: [] }
    ]
  });
  try {
    const before = await session.api.me();
    assert.equal(before.ok, true);
    assert.equal(before.result.role, 'user');
    assert.equal(before.result.clientId, 'client-user-1');

    const login = await session.api.adminLogin('admin', 'mock-admin-password');
    assert.equal(login.ok, true);
    const admin = await session.api.me();
    assert.deepEqual(admin.result, { role: 'admin' });
    const roster = await session.api.adminComputers();
    assert.equal(roster.ok, true);
    assert.deepEqual(roster.result.computers.map((computer) => computer.clientId), ['same-name-a', 'same-name-b']);
    assert.equal(roster.result.computers[0].tools[0].id, 'workbuddy');
    assert.equal(roster.result.computers[0].tools[0].available, false);

    const listed = await session.api.adminRpc('same-name-a', { method: 'sessions.list', params: {} });
    assert.equal(listed.ok, true);
    assert.equal(listed.result.sessions[0].id, 'same-session');
    const offline = await session.api.adminRpc('same-name-b', { method: 'sessions.list', params: {} });
    assert.equal(offline.ok, false);
    assert.equal(offline.status, 503);
    assert.equal(offline.code, 'target_offline');
    const unknown = await session.api.adminRpc('missing-client', { method: 'sessions.list', params: {} });
    assert.equal(unknown.ok, false);
    assert.equal(unknown.status, 503);
    assert.equal(unknown.code, 'target_offline');
    assert.deepEqual(session.mock.state.adminRpcCalls.map((call) => call.clientId), ['same-name-a', 'same-name-b']);

    const code = await session.api.adminEnrollmentCodes();
    assert.equal(code.result.code, 'MOCK-ENROLLMENT-CODE');
    const loggedOut = await session.api.adminLogout();
    assert.equal(loggedOut.ok, true);
    const ordinary = await session.api.me();
    assert.equal(ordinary.result.role, 'user', 'the paired session survives independent admin logout');
    const browserReadRequests = session.mock.state.log.filter((entry) =>
      entry.path === '/api/me' || entry.path === '/api/admin/computers');
    assert.ok(browserReadRequests.length >= 4);
    assert.ok(browserReadRequests.every((entry) => entry.method === 'POST' && entry.origin === ALLOWED_ORIGIN),
      'identity and roster browser reads use Origin-guarded same-origin POSTs');
    assert.ok(session.mock.state.log.some((entry) => entry.path === '/api/admin/logout'));
    assert.equal(JSON.stringify(session.mock.state.log).includes('mock-admin-password'), false);
  } finally {
    await session.mock.close();
  }
});

test('a full answer round-trip: label selection goes out and the mock records it', async () => {
  const session = await startSession({
    capabilities: WORKBENCH_CAPS,
    pendingQuestions: QUESTIONS,
    pendingApprovals: []
  });
  try {
    const read = await session.api.rpc(core.readBody('dsh', 'b2'));
    const input = { capabilities: WORKBENCH_CAPS, tool: 'dsh', read: read.result };
    const batches = core.pendingQuestionsOf(input);

    // The user's choice is validated against the FRESH form before anything is
    // sent, exactly as app.js does it.
    const answers = core.validateAnswers(batches, 'call-42', [
      { id: 'q1', selected: ['跳过'] },
      { id: 'q2', selected: ['a.js', 'b.js'] }
    ]);
    assert.ok(answers, 'a complete, unambiguous answer set must validate');

    const sent = await session.api.rpc(core.sessionAnswerBody({
      tool: 'dsh', sessionId: 'b2', callId: 'call-42', answers: answers
    }));
    assert.equal(sent.ok, true);
    assert.equal(sent.result.accepted, true);
    assert.equal(sent.result.callId, 'call-42');

    const recorded = session.mock.state.answered;
    assert.equal(recorded.length, 1);
    assert.deepEqual(recorded[0].params, {
      tool: 'dsh', sessionId: 'b2', callId: 'call-42',
      answers: [{ id: 'q1', selected: ['跳过'] }, { id: 'q2', selected: ['a.js', 'b.js'] }]
    });
  } finally {
    await session.mock.close();
  }
});

test('a stale or refused answer is an honest error, not a silent success', async () => {
  const session = await startSession({
    capabilities: WORKBENCH_CAPS,
    pendingQuestions: QUESTIONS,
    pendingApprovals: [],
    answerResult: { accepted: false, sessionId: 'b2', callId: 'call-42' }
  });
  try {
    const sent = await session.api.rpc(core.sessionAnswerBody({
      tool: 'dsh', sessionId: 'b2', callId: 'call-42',
      answers: [{ id: 'q1', selected: ['跳过'] }]
    }));
    assert.equal(sent.ok, true, 'the transport succeeded');
    // ...but "accepted" is what the adapter says, and it said no. The UI must
    // never turn a not-accepted result into a success.
    assert.notEqual(sent.result.accepted, true);
  } finally {
    await session.mock.close();
  }
});

test('an approval decision travels as one exact request and is never auto-retried', async () => {
  const session = await startSession({
    capabilities: WORKBENCH_CAPS,
    pendingApprovals: APPROVALS,
    pendingQuestions: []
  });
  try {
    const read = await session.api.rpc(core.readBody('dsh', 'b2'));
    const approvals = core.pendingApprovalsOf({ capabilities: WORKBENCH_CAPS, tool: 'dsh', read: read.result });
    assert.equal(approvals.length, 1);

    const sent = await session.api.rpc(core.sessionApproveBody({
      tool: 'dsh', sessionId: 'b2', approvalId: approvals[0].id, decision: 'allow-once'
    }));
    assert.equal(sent.ok, true);
    assert.equal(sent.result.accepted, true);
    assert.equal(sent.result.state, 'submitted');

    // Exactly one request: the client never retries on its own.
    assert.equal(session.mock.state.approved.length, 1);
    assert.deepEqual(session.mock.state.approved[0].params, {
      tool: 'dsh', sessionId: 'b2', approvalId: APPROVAL_ID, decision: 'allow-once'
    });
    // and there is no allow-always anywhere in the conversation
    assert.ok(session.mock.state.log.every((entry) => entry.path !== '/api/approve-all'));
  } finally {
    await session.mock.close();
  }
});

test('the mock relay keeps enforcing the wire rules the phone depends on', async () => {
  const session = await startSession({ capabilities: WORKBENCH_CAPS });
  try {
    // An unknown field is refused with invalid_params, not silently dropped.
    const stray = await session.api.rpc({
      method: 'session.send',
      params: { tool: 'dsh', sessionId: 'b2', text: 'hi', projectId: 'p1' }
    });
    assert.equal(stray.ok, false);
    assert.equal(stray.code, 'invalid_params');

    // An unknown method is refused too.
    const unknown = await session.api.rpc({ method: 'session.answerAnything', params: {} });
    assert.equal(unknown.ok, false);
    assert.equal(unknown.code, 'unknown_method');

    // A malformed approval decision never reaches the adapter.
    const badDecision = await session.api.rpc({
      method: 'session.approve',
      params: { tool: 'dsh', sessionId: 'b2', approvalId: APPROVAL_ID, decision: 'allow-always' }
    });
    assert.equal(badDecision.ok, false);
    assert.equal(badDecision.code, 'invalid_params');
    assert.equal(session.mock.state.approved.length, 0);

    // An answer batch needs a callId and an answers array.
    const badAnswer = await session.api.rpc({
      method: 'session.answer',
      params: { tool: 'dsh', sessionId: 'b2', callId: 'call-42', answers: 'nope' }
    });
    assert.equal(badAnswer.ok, false);
    assert.equal(badAnswer.code, 'invalid_params');
  } finally {
    await session.mock.close();
  }
});

test('the page the mock serves is the same static bytes the phone loads', async () => {
  const session = await startSession({ capabilities: WORKBENCH_CAPS });
  try {
    const page = await fetch(session.base + '/');
    assert.equal(page.status, 200);
    const html = await page.text();
    // The workbench panels and the composer controls are in the served markup,
    // served from mobile/web/ itself rather than from a copy.
    ['tab-chats', 'tab-tasks', 'tab-settings', 'questions-panel', 'approvals-panel',
      'model-chip-button', 'project-sheet', 'settings-screen'].forEach((id) => {
      assert.ok(html.indexOf('id="' + id + '"') !== -1, 'the served page must contain #' + id);
    });
  } finally {
    await session.mock.close();
  }
});

test('the mock relay still refuses a missing or wrong Origin over real sockets', async () => {
  const mock = createMockServer({ capabilities: WORKBENCH_CAPS });
  const base = await mock.listen();
  try {
    // No Origin header at all: 403 origin_forbidden, exactly like the relay.
    const bare = await fetch(base + '/api/rpc', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ method: 'sessions.list', params: {} })
    });
    assert.equal(bare.status, 403);
    const body = await bare.json();
    assert.equal(body.error.code, 'origin_forbidden');

    // The documented origin is accepted (and the cookie is still required).
    const wrong = await fetch(base + '/api/rpc', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example' },
      body: JSON.stringify({ method: 'sessions.list', params: {} })
    });
    assert.equal(wrong.status, 403);

    const rightOrigin = await fetch(base + '/api/rpc', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: ALLOWED_ORIGIN },
      body: JSON.stringify({ method: 'sessions.list', params: {} })
    });
    assert.equal(rightOrigin.status, 401, 'the right origin without a cookie is unauthenticated');
  } finally {
    await mock.close();
  }
});
