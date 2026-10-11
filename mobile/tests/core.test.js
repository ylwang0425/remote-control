// Unit tests for the pure logic of the mobile web UI (mobile/web/js/core.js).
//
// These tests need no browser, no network and no mock backend: they only call
// pure functions. Everything here is REAL logic under test (not mocked).
//
// Run with:  D:\env\node.exe --test mobile/tests/core.test.js
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const CORE_PATH = path.join(__dirname, '..', 'web', 'js', 'core.js');
const core = require(CORE_PATH);

// The example pairing code used all over docs/design/api/protocol-v1.md (4.6).
const SAMPLE = 'K7QP-3MZD-9XTB-2RCV-6HNF-0JWS';

test('normalizePairCode removes separators, upper-cases and applies Crockford aliases', () => {
  assert.equal(core.normalizePairCode(SAMPLE), 'K7QP3MZD9XTB2RCV6HNF0JWS');
  // lower case + spaces are tolerated on input (protocol-v1 7.2 allows 20-64 chars)
  assert.equal(core.normalizePairCode(' k7qp 3mzd-9xtb-2rcv-6hnf-0jws '), 'K7QP3MZD9XTB2RCV6HNF0JWS');
  // Crockford aliases: O -> 0, I/L -> 1, U -> V
  assert.equal(core.normalizePairCode('OILU-OILU-OILU-OILU-OILU-OILU'), '011V011V011V011V011V011V');
});

test('isValidPairCode accepts the canonical code and rejects malformed ones', () => {
  // The contract's own worked example: 6 groups of 4 = 24 chars after normalization.
  assert.equal(core.isValidPairCode(SAMPLE), true);
  assert.equal(core.isValidPairCode('K7QP3MZD9XTB2RCV6HNF0JWS'), true);
  // anything that is not 24 characters is rejected
  assert.equal(core.isValidPairCode('K7QP-3MZD-9XTB-2RCV-6HNF'), false); // 20
  assert.equal(core.isValidPairCode('K7QP-3MZD-9XTB-2RCV-6HN'), false); // 19
  assert.equal(core.isValidPairCode('K7QP-3MZD-9XTB-2RCV-6HNF-0JWSX'), false); // 25
  // empty
  assert.equal(core.isValidPairCode(''), false);
  assert.equal(core.isValidPairCode(null), false);
  assert.equal(core.isValidPairCode(undefined), false);
  // I / L / O / U are NOT rejected as input: protocol-v1 4.6 makes them
  // Crockford *aliases* (I,L -> 1 ; O -> 0 ; U -> V), so this normalizes to
  // twenty "1" digits and is a legal code.
  assert.equal(core.isValidPairCode('IIII-IIII-IIII-IIII-IIII-IIII'), true);
  // A character that is genuinely outside the alphabet after normalization
  // must be rejected.
  assert.equal(core.isValidPairCode('K7QP-3MZD-9XTB-2RCV-6HNF-0JW*'), false);
  assert.equal(core.isValidPairCode('K7QP-3MZD-9XTB-2RCV-6HNF-0JW0!'), false);
});

test('parsePairFragment reads #pair=... and reports absence otherwise', () => {
  const hit = core.parsePairFragment('#pair=' + SAMPLE);
  assert.equal(hit.present, true);
  assert.equal(hit.raw, SAMPLE);
  assert.equal(hit.code, 'K7QP3MZD9XTB2RCV6HNF0JWS');
  assert.equal(hit.valid, true);

  // percent-encoded fragment is decoded
  const encoded = core.parsePairFragment('#pair=' + encodeURIComponent(SAMPLE));
  assert.equal(encoded.raw, SAMPLE);
  assert.equal(encoded.valid, true);

  // absent
  assert.deepEqual(core.parsePairFragment(''), { present: false, raw: '', code: '', valid: false });
  assert.deepEqual(core.parsePairFragment('#'), { present: false, raw: '', code: '', valid: false });
  assert.deepEqual(core.parsePairFragment('#other=1'), { present: false, raw: '', code: '', valid: false });
  assert.deepEqual(core.parsePairFragment('#pair='), { present: false, raw: '', code: '', valid: false });

  // extra parameters in the fragment are kept out of the code
  const withExtra = core.parsePairFragment('#pair=' + SAMPLE + '&deviceName=Pixel');
  assert.equal(withExtra.present, true);
  assert.equal(withExtra.code, 'K7QP3MZD9XTB2RCV6HNF0JWS');

  // garbage after pair= must not be silently accepted
  const bad = core.parsePairFragment('#pair=xxxx');
  assert.equal(bad.present, true);
  assert.equal(bad.valid, false);
});

test('stripPairFragment removes pair= and keeps the rest', () => {
  assert.equal(core.stripPairFragment('#pair=' + SAMPLE), '');
  assert.equal(core.stripPairFragment('#pair=' + SAMPLE + '&a=1'), '#a=1');
  assert.equal(core.stripPairFragment('#other=1'), '#other=1');
  assert.equal(core.stripPairFragment('#a=1&pair=x'), '#a=1');
  assert.equal(core.stripPairFragment(''), '');
});

// ---------------------------------------------------------------------------
// Round B: session list, search, status/role labels, time, errors, polling.
// ---------------------------------------------------------------------------

const SESSIONS = [
  { id: 'a1', tool: 'codex', title: '重构 relay 的转发层', status: 'working', updatedAt: '2026-10-08T03:57:55Z', cwd: 'D:\\w' },
  { id: 'b2', tool: 'dsh', title: 'Fix login redirect', status: 'idle', updatedAt: '2026-10-08T02:00:00Z', cwd: null },
  { id: 'c3', tool: 'codex', title: '写单元测试', status: 'error', updatedAt: '2026-10-07T22:00:00Z', cwd: '/tmp' }
];

test('CRD 0004 lock: a normalized pairing code is exactly 24 Crockford characters', () => {
  assert.equal(core.PAIR_CODE_LENGTH, 24, 'CRD 0004 settled the 20-vs-24 contradiction at 24');
  // 23 and 25 must be refused, exactly one below and one above the locked length
  assert.equal(core.isValidPairCode('K7QP-3MZD-9XTB-2RCV-6HNF-0JW'), false); // 23
  assert.equal(core.isValidPairCode('K7QP-3MZD-9XTB-2RCV-6HNF-0JWSX'), false); // 25
  assert.equal(core.isValidPairCode('K7QP-3MZD-9XTB-2RCV-6HNF-0JWS'), true); // 24
  // normalization still applies before the length is measured
  assert.equal(core.isValidPairCode('k7qp 3mzd-9xtb-2rcv-6hnf-0jws'), true);
  assert.equal(core.normalizePairCode('K7QP-3MZD-9XTB-2RCV-6HNF-OJWS'), 'K7QP3MZD9XTB2RCV6HNF0JWS', 'O -> 0');
  assert.equal(core.normalizePairCode('K7QP-3MZD-9XTB-2RCU-6HNF-0JWS'), 'K7QP3MZD9XTB2RCV6HNF0JWS', 'U -> V');
  assert.equal(core.normalizePairCode('K7QP-3MZD-9XTB-2RCI-6HNF-0JWS'), 'K7QP3MZD9XTB2RC16HNF0JWS', 'I -> 1');
  assert.equal(core.normalizePairCode('K7QP-3MZD-9XTB-2RCL-6HNF-0JWS'), 'K7QP3MZD9XTB2RC16HNF0JWS', 'L -> 1');
  // and it must still land on the pure Crockford alphabet after normalization
  assert.equal(core.isValidPairCode('K7QP-3MZD-9XTB-2RCV-6HNF-0JW*'), false);
});

test('statusLabel and statusTone map the four contract statuses to Chinese', () => {
  assert.equal(core.statusLabel('idle'), '空闲');
  assert.equal(core.statusLabel('working'), '运行中');
  assert.equal(core.statusLabel('stopped'), '已停止');
  assert.equal(core.statusLabel('error'), '错误');
  // protocol-v1 4.3: an unknown status is shown with the "error" styling but
  // must NOT disable anything.
  assert.equal(core.statusLabel('weird'), '未知状态');
  assert.equal(core.statusTone('weird'), 'error');
  assert.equal(core.statusTone('working'), 'working');
});

test('roleLabel maps the four contract roles to Chinese', () => {
  assert.equal(core.roleLabel('user'), '我');
  assert.equal(core.roleLabel('assistant'), 'AI');
  assert.equal(core.roleLabel('system'), '系统');
  assert.equal(core.roleLabel('tool'), '工具');
  // protocol-v1 4.4: unknown role is displayed as "system", never dropped.
  assert.equal(core.roleLabel('nope'), '系统');
});

test('formatRelativeTime accepts both RFC3339 precisions from protocol-v1 4.2', () => {
  const now = Date.parse('2026-10-08T04:00:00Z');
  assert.equal(core.formatRelativeTime('2026-10-08T03:59:30Z', now), '刚刚');
  assert.equal(core.formatRelativeTime('2026-10-08T03:58:00Z', now), '2 分钟前');
  assert.equal(core.formatRelativeTime('2026-10-08T01:00:00Z', now), '3 小时前');
  assert.equal(core.formatRelativeTime('2026-10-06T04:00:00Z', now), '2 天前');
  // millisecond precision must parse too
  assert.equal(core.formatRelativeTime('2026-10-08T03:57:00.412Z', now), '2 分钟前');
  // a timestamp with no trailing Z is not RFC3339-UTC from protocol-v1 4.2
  assert.equal(core.formatRelativeTime('2026-10-08T03:58:00', now), '');
  // unparseable / missing -> empty string, never "Invalid Date"
  assert.equal(core.formatRelativeTime('', now), '');
  assert.equal(core.formatRelativeTime(null, now), '');
  assert.equal(core.formatRelativeTime('not-a-date', now), '');
});

test('formatClock renders a local HH:MM for a message timestamp', () => {
  const iso = '2026-10-08T03:58:07Z';
  const d = new Date(iso);
  const expected =
    String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
  assert.equal(core.formatClock(iso), expected);
  assert.equal(core.formatClock(''), '');
  assert.equal(core.formatClock('nope'), '');
});

test('filterSessions searches title, tool and status without mutating input', () => {
  const before = JSON.stringify(SESSIONS);
  assert.equal(core.filterSessions(SESSIONS, '').length, 3);
  assert.equal(core.filterSessions(SESSIONS, null).length, 3);
  assert.equal(core.filterSessions(SESSIONS, undefined).length, 3);

  assert.deepEqual(core.filterSessions(SESSIONS, 'relay').map(s => s.id), ['a1']);
  assert.deepEqual(core.filterSessions(SESSIONS, 'RELAY').map(s => s.id), ['a1']);
  assert.deepEqual(core.filterSessions(SESSIONS, '单元').map(s => s.id), ['c3']);
  assert.deepEqual(core.filterSessions(SESSIONS, 'dsh').map(s => s.id), ['b2']);
  assert.deepEqual(core.filterSessions(SESSIONS, 'codex').map(s => s.id), ['a1', 'c3']);
  // search by status works in both the raw protocol value and the Chinese label
  assert.deepEqual(core.filterSessions(SESSIONS, 'working').map(s => s.id), ['a1']);
  assert.deepEqual(core.filterSessions(SESSIONS, '运行中').map(s => s.id), ['a1']);
  assert.deepEqual(core.filterSessions(SESSIONS, '已停止').map(s => s.id), []);
  assert.deepEqual(core.filterSessions(SESSIONS, 'zzz').map(s => s.id), []);
  // whitespace-only query is treated as "no filter"
  assert.equal(core.filterSessions(SESSIONS, '   ').length, 3);

  assert.equal(JSON.stringify(SESSIONS), before, 'filterSessions must not mutate its input');
  // and it must tolerate a missing/non-array list
  assert.deepEqual(core.filterSessions(null, 'x'), []);
});

test('errorMessage maps protocol-v1 6.2 codes to Chinese text', () => {
  assert.equal(core.errorMessage('unauthenticated'), '登录已失效，请重新配对');
  assert.equal(core.errorMessage('invalid_credentials'), '配对码无效、已过期或已被使用');
  assert.equal(core.errorMessage('origin_forbidden'), '请求来源被拒绝（Origin 不匹配）');
  // protocol-v1 v2 (CRD 0003) added `forbidden` / HTTP 403: authenticated but
  // not allowed. It is NOT "you are logged out".
  assert.equal(core.errorMessage('forbidden'), '没有权限执行该操作');
  assert.equal(core.errorMessage('rate_limited'), '请求过于频繁，请稍后重试');
  assert.equal(core.errorMessage('bridge_offline'), '电脑不在线，请确认电脑端已连接');
  assert.equal(core.errorMessage('bridge_busy'), '电脑端正忙，请稍后重试');
  assert.equal(core.errorMessage('bridge_timeout'), '电脑没有及时回应');
  assert.equal(core.errorMessage('bridge_bad_response'), '电脑返回的数据无法识别');
  assert.equal(core.errorMessage('target_offline'), '目标电脑当前不可用，请刷新电脑列表后重试');
  assert.equal(core.errorMessage('identity_conflict'), '配对身份与当前登录身份冲突，请先退出后重试');
  assert.equal(core.errorMessage('not_capable'), '该会话不支持这个操作');
  assert.equal(core.errorMessage('session_not_found'), '会话不存在或不可见，请刷新列表');
  assert.equal(core.errorMessage('session_gone'), '会话已经结束，请刷新列表');
  assert.equal(core.errorMessage('too_long'), '消息太长，请缩短后重试');
  assert.equal(core.errorMessage('internal'), '服务器内部错误');
  assert.equal(core.errorMessage('unknown_method'), '客户端请求有误（方法不被支持）');
  // protocol-v1 12.4: an unknown error.code is displayed like bridge_error,
  // i.e. fall back to the server's own safe message.
  assert.equal(core.errorMessage('brand_new_code', 'server said this'), 'server said this');
  assert.equal(core.errorMessage('brand_new_code', ''), '发生未知错误');
});

test('isAuthFailure sends the user back to pairing for 401 only, never for 403', () => {
  // protocol-v1 6.2 v2: 401 = no valid identity -> pairing screen.
  assert.equal(core.isAuthFailure('unauthenticated'), true);
  // 403 forbidden = identity is fine, permission is not. Falling back to the
  // pairing screen here would throw away a perfectly good session.
  assert.equal(core.isAuthFailure('forbidden'), false);
  // origin_forbidden is a 403 too, but it is a client bug, not a permission one.
  assert.equal(core.isAuthFailure('origin_forbidden'), false);
  assert.equal(core.isAuthFailure('bridge_offline'), false);
  assert.equal(core.isAuthFailure(null), false);
  assert.equal(core.isAuthFailure(undefined), false);
});

test('rpc bodies carry exactly the whitelisted fields of protocol-v1 7.3', () => {
  // Any extra field is "invalid_params", so assert deep equality, not presence.
  assert.deepEqual(core.listBody(), { method: 'sessions.list', params: {} });
  assert.deepEqual(core.readBody('codex', 'a1'), {
    method: 'session.read',
    params: { tool: 'codex', sessionId: 'a1' }
  });
  assert.deepEqual(core.sendBody('dsh', 'b2', '继续'), {
    method: 'session.send',
    params: { tool: 'dsh', sessionId: 'b2', text: '继续' }
  });
  assert.deepEqual(core.stopBody('codex', 'a1'), {
    method: 'session.stop',
    params: { tool: 'codex', sessionId: 'a1' }
  });
});

test('canStopOf only trusts canStop === true (protocol-v1 9.2 / 9.5)', () => {
  assert.equal(core.canStopOf({ canStop: true }), true);
  assert.equal(core.canStopOf({ canStop: false }), false);
  // a missing or non-boolean canStop must NOT be read as "allowed"
  assert.equal(core.canStopOf({}), false);
  assert.equal(core.canStopOf({ canStop: 'true' }), false);
  assert.equal(core.canStopOf(null), false);
});

test('messagesChanged compares message id sets, not order (protocol-v1 7.3)', () => {
  const a = [{ id: 'm1' }, { id: 'm2' }];
  assert.equal(core.messagesChanged(a, [{ id: 'm1' }, { id: 'm2' }]), false);
  assert.equal(core.messagesChanged(a, [{ id: 'm2' }, { id: 'm1' }]), false, 'order-only change is not a change');
  assert.equal(core.messagesChanged(a, [{ id: 'm1' }, { id: 'm2' }, { id: 'm3' }]), true);
  assert.equal(core.messagesChanged(a, [{ id: 'm1' }]), true);
  assert.equal(core.messagesChanged([], []), false);
  assert.equal(core.messagesChanged(null, []), false);
  assert.equal(core.messagesChanged([], [{ id: 'm1' }]), true);
});

test('readIntervalFor follows protocol-v1 7.3 (2000 working, 5000 otherwise)', () => {
  assert.equal(core.LIST_INTERVAL_MS, 2000, 'the task row pins list polling at 2 seconds');
  assert.equal(core.readIntervalFor('working'), 2000);
  assert.equal(core.readIntervalFor('idle'), 5000);
  assert.equal(core.readIntervalFor('stopped'), 5000);
  assert.equal(core.readIntervalFor('error'), 5000);
});

test('nextPollAction pauses when hidden, never stacks, and respects the interval', () => {
  const base = {
    authed: true, hidden: false, inflight: false,
    view: 'list', sessionId: null, sessionStatus: 'idle',
    nowMs: 100000, lastListMs: 97000, lastReadMs: 0
  };
  // list due (3000ms since last list, interval 2000)
  assert.equal(core.nextPollAction(base), 'list');
  // not due yet
  assert.equal(core.nextPollAction(Object.assign({}, base, { lastListMs: 99000 })), 'none');
  // document.hidden pauses everything
  assert.equal(core.nextPollAction(Object.assign({}, base, { hidden: true })), 'none');
  // an in-flight request is never stacked on
  assert.equal(core.nextPollAction(Object.assign({}, base, { inflight: true })), 'none');
  // not authenticated yet -> no polling
  assert.equal(core.nextPollAction(Object.assign({}, base, { authed: false })), 'none');

  // detail view polls session.read, not the list
  const detail = Object.assign({}, base, { view: 'detail', sessionId: 'a1', sessionStatus: 'working', lastReadMs: 97000 });
  assert.equal(core.nextPollAction(detail), 'read');
  // a non-working session is polled on the slower interval
  assert.equal(core.nextPollAction(Object.assign({}, detail, { sessionStatus: 'idle' })), 'none');
  assert.equal(core.nextPollAction(Object.assign({}, detail, { sessionStatus: 'idle', lastReadMs: 94000 })), 'read');
});

// ---------------------------------------------------------------------------
// Round C: the two methods added for "new session".
//
// FINAL shapes as ruled by the coordinator (wire version stays 1, additive):
//   models.list    params {tool}
//                  result {tool, models:[{id,label,provider?,isDefault?,
//                          reasoningEfforts?:string[],defaultReasoningEffort?}],
//                          projects?:[{id,name,cwd}]}
//   session.create params {tool,model,provider?(DSH requires it),reasoningEffort?,
//                          cwd?,projectId?,text?,requestId:UUIDv4}
//                  result {sessionId,tool,title?,model,provider?,reasoningEffort?}
// ---------------------------------------------------------------------------

test('models.list and session.create carry exactly the whitelisted fields', () => {
  assert.deepEqual(core.modelsListBody('codex'), { method: 'models.list', params: { tool: 'codex' } });
  assert.deepEqual(core.modelsListBody('dsh'), { method: 'models.list', params: { tool: 'dsh' } });

  // `model` is required; optional fields are OMITTED, never sent as undefined/null.
  assert.deepEqual(
    core.sessionCreateBody({ tool: 'codex', model: 'gpt-5-codex', requestId: 'r1' }),
    { method: 'session.create', params: { tool: 'codex', model: 'gpt-5-codex', requestId: 'r1' } }
  );

  const full = core.sessionCreateBody({
    tool: 'dsh', model: 'qwen3', provider: 'ollama', reasoningEffort: 'high',
    cwd: '/w', projectId: 'p1', text: '你好', requestId: 'r2'
  });
  assert.deepEqual(full, {
    method: 'session.create',
    params: {
      tool: 'dsh', model: 'qwen3', provider: 'ollama', reasoningEffort: 'high',
      cwd: '/w', projectId: 'p1', text: '你好', requestId: 'r2'
    }
  });

  // blank optionals are dropped rather than sent as empty strings
  assert.deepEqual(
    core.sessionCreateBody({ tool: 'codex', model: 'm', cwd: '', text: '   ', provider: '', requestId: 'r3' }),
    { method: 'session.create', params: { tool: 'codex', model: 'm', requestId: 'r3' } }
  );
});

test('requestId is a fresh UUID v4 every time (protocol-v1 4.1)', () => {
  const a = core.newRequestId();
  const b = core.newRequestId();
  assert.match(a, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.notEqual(a, b, 'two creations must not share a requestId, or they would dedupe into one');
});

test('model options come from the live catalog and keep provider attached', () => {
  const catalog = {
    tool: 'dsh',
    models: [
      { id: 'c1', label: 'GPT-5 Codex', provider: 'openai', isDefault: true },
      { id: 'c2', label: 'Qwen3', provider: 'ollama', reasoningEfforts: ['low', 'high'], defaultReasoningEffort: 'low' }
    ]
  };
  const options = core.modelOptions(catalog);
  assert.equal(options.length, 2);
  assert.equal(options[0].id, 'c1');
  assert.equal(options[0].label, 'GPT-5 Codex');
  assert.equal(options[0].provider, 'openai');
  assert.equal(options[0].isDefault, true);
  assert.deepEqual(options[1].reasoningEfforts, ['low', 'high']);
  assert.equal(options[1].defaultReasoningEffort, 'low');
  assert.equal(options[0].defaultReasoningEffort, '');

  // The same model id under two providers is two different things -- provider
  // must survive, and Codex simply has none.
  const two = core.modelOptions({ models: [
    { id: 'x', label: 'same', provider: 'p1' },
    { id: 'y', label: 'same', provider: 'p2' },
    { id: 'z', label: 'no provider' }
  ] });
  assert.deepEqual(two.map((o) => o.provider), ['p1', 'p2', '']);

  // No catalog, or nothing usable in it: an EMPTY list. Never a made-up model.
  assert.deepEqual(core.modelOptions(null), []);
  assert.deepEqual(core.modelOptions({}), []);
  assert.deepEqual(core.modelOptions({ models: [] }), []);
  assert.deepEqual(core.modelOptions({ models: [{ label: 'no id' }, null, 'junk'] }), []);
});

test('selecting a model keeps id, provider and reasoning effort together', () => {
  const dshOptions = core.modelOptions({ models: [
    { id: 'qwen3', label: 'Qwen3', provider: 'ollama', reasoningEfforts: ['low', 'high'], defaultReasoningEffort: 'high' },
    { id: 'gpt5', label: 'GPT-5', provider: 'openai' }
  ] });
  // the default entry is the one the catalog marked, not simply the first one
  assert.equal(core.defaultModelOption(dshOptions).id, 'qwen3');
  assert.equal(core.defaultModelOption(core.modelOptions({ models: [
    { id: 'a', label: 'A' }, { id: 'b', label: 'B', isDefault: true }
  ] })).id, 'b');
  assert.equal(core.defaultModelOption([]), null);

  // CRD 0006: `model` is the models.list **id**, never the human label.
  const dsh = core.sessionCreateBody(Object.assign(
    { tool: 'dsh', requestId: 'r' }, core.modelSelection(dshOptions[0], 'low')
  ));
  assert.deepEqual(dsh.params, {
    tool: 'dsh', model: 'qwen3', provider: 'ollama', reasoningEffort: 'low', requestId: 'r'
  });

  // Codex has no provider field, so it must not grow one.
  const codexOptions = core.modelOptions({ models: [{ id: 'gpt-5-codex', label: 'GPT-5 Codex' }] });
  const codex = core.sessionCreateBody(Object.assign(
    { tool: 'codex', requestId: 'r' }, core.modelSelection(codexOptions[0], '')
  ));
  assert.deepEqual(codex.params, { tool: 'codex', model: 'gpt-5-codex', requestId: 'r' });
});

test('the same model id under different providers stays distinguishable', () => {
  // Found in a real browser: DSH reports ONE model id under SEVERAL providers
  // (here three). Keying the <option> by the model id alone made every option
  // share a value, so the select resolved to the first match and the session was
  // created on the WRONG provider.
  const catalog = { tool: 'dsh', models: [
    { id: 'deepseek-flash', label: 'deepseek-official', provider: 'deepseek-official', isDefault: true },
    { id: 'deepseek-flash', label: 'deepseek-account', provider: 'deepseek-account' },
    { id: 'deepseek-flash', label: 'deepseek-local', provider: 'deepseek-local' }
  ] };
  const options = core.modelOptions(catalog);
  assert.equal(options.length, 3);

  const keys = options.map(function (option) { return core.modelOptionKey(option); });
  assert.equal(new Set(keys).size, 3, 'every option needs its own unique key');
  keys.forEach(function (key) {
    assert.ok(key.indexOf('deepseek-flash') !== -1, 'the key still names the model: ' + key);
  });

  // Choosing the SECOND entry must carry the SECOND provider -- not the first.
  const chosen = core.modelOptionByKey(options, keys[1]);
  assert.ok(chosen, 'the chosen key must map back to its entry');
  assert.equal(chosen.provider, 'deepseek-account');

  const body = core.sessionCreateBody(Object.assign(
    { tool: 'dsh', requestId: 'r' }, core.modelSelection(chosen, '')
  ));
  assert.deepEqual(body.params, {
    tool: 'dsh', model: 'deepseek-flash', provider: 'deepseek-account', requestId: 'r'
  });

  // and the third one, to prove it is not just "index 1 works"
  const third = core.modelOptionByKey(options, keys[2]);
  assert.equal(third.provider, 'deepseek-local');

  // an unknown key maps to nothing rather than silently falling back to a model
  assert.equal(core.modelOptionByKey(options, 'nope\u0000nope'), null);
  // a duplicate key from a genuinely identical pair is still the same entry
  assert.equal(core.modelOptionKey({ id: 'm', provider: 'p' }), 'p\u0000m');
  assert.equal(core.modelOptionKey({ id: 'm' }), '\u0000m');
  assert.equal(core.modelOptionKey(null), '');
});

test('availability is explicit: never an empty dropdown pretending to be a choice', () => {
  const ready = { tool: 'codex', models: [{ id: 'm1', label: 'M1' }] };
  const empty = { tool: 'codex', models: [], reason: 'codex 应用未启动' };

  // capability says no -> unsupported, whatever the catalog says
  assert.equal(core.catalogState({ capabilities: { 'models.list': false }, tool: 'codex', catalog: ready }), 'unsupported');
  // capability says yes and models arrived -> ready
  assert.equal(core.catalogState({ capabilities: { 'models.list': true }, tool: 'codex', catalog: ready }), 'ready');
  // capability says yes but the tool returned nothing -> unavailable (with reason)
  assert.equal(core.catalogState({ capabilities: { 'models.list': true }, tool: 'codex', catalog: empty }), 'unavailable');
  // capability missing entirely defaults to false (protocol-v1 9.5)
  assert.equal(core.catalogState({ capabilities: {}, tool: 'codex', catalog: ready }), 'unsupported');
  // a per-tool capability key overrides the generic one when present
  assert.equal(core.catalogState({ capabilities: { 'models.list': true, 'models.list:codex': false }, tool: 'codex', catalog: ready }), 'unsupported');

  // the safe text the tool sent is surfaced
  assert.equal(core.catalogReason(empty), 'codex 应用未启动');
  assert.equal(core.catalogReason({ models: [] }), '');
  assert.equal(core.catalogReason(null), '');
});

test('new-session error codes have Chinese text', () => {
  assert.match(core.errorMessage('tool_unavailable'), /不可用/);
  assert.match(core.errorMessage('model_not_available'), /模型/);
  assert.match(core.errorMessage('session_create_failed'), /创建/);
});

test('project options come from the catalog and are optional', () => {
  const projects = core.projectOptions({ projects: [
    { id: 'p1', name: 'remote-control', cwd: 'D:\\w\\remote-control' },
    { id: 'p2', name: 'other', cwd: '/srv/other' }
  ] });
  assert.deepEqual(projects.map((p) => p.id), ['p1', 'p2']);
  assert.equal(projects[0].cwd, 'D:\\w\\remote-control');
  assert.deepEqual(core.projectOptions(null), []);
  assert.deepEqual(core.projectOptions({ projects: [{ name: 'no id' }] }), []);
});

// ---------------------------------------------------------------------------
// Activity folding and markdown link policy
// ---------------------------------------------------------------------------

test('adjacent tool/system messages fold into one activity block', () => {
  const messages = [
    { id: '1', role: 'user', text: 'hi' },
    { id: '2', role: 'assistant', text: 'hello' },
    { id: '3', role: 'tool', text: 'ran ls' },
    { id: '4', role: 'tool', text: 'ran cat' },
    { id: '5', role: 'system', text: 'note' },
    { id: '6', role: 'assistant', text: 'done' }
  ];
  const blocks = core.groupMessages(messages);
  assert.deepEqual(blocks.map((b) => b.type), ['message', 'message', 'activity', 'message']);
  assert.equal(blocks[2].count, 3);
  assert.equal(blocks[2].items.length, 3);
  // the ordinary conversation is never folded away
  assert.equal(blocks[0].message.role, 'user');
  assert.equal(blocks[1].message.role, 'assistant');
  assert.equal(blocks[3].message.role, 'assistant');
});

test('two separate runs of activity stay two blocks', () => {
  const blocks = core.groupMessages([
    { id: '1', role: 'tool', text: 'a' },
    { id: '2', role: 'assistant', text: 'mid' },
    { id: '3', role: 'tool', text: 'b' }
  ]);
  assert.deepEqual(blocks.map((b) => b.type), ['activity', 'message', 'activity']);
});

test('grouping never loses or reorders a message, and tolerates junk', () => {
  const blocks = core.groupMessages([
    { id: '1', role: 'tool', text: 'a' },
    { id: '2', role: 'user', text: 'u' },
    { id: '3', role: 'system', text: 's' }
  ]);
  const flat = [];
  blocks.forEach((b) => {
    if (b.type === 'activity') b.items.forEach((m) => flat.push(m.id));
    else flat.push(b.message.id);
  });
  assert.deepEqual(flat, ['1', '2', '3']);
  assert.deepEqual(core.groupMessages(null), []);
  assert.deepEqual(core.groupMessages([]), []);
  // an unknown role is treated as system, so it folds like activity
  assert.deepEqual(core.groupMessages([{ id: '9', role: 'weird', text: 'x' }]).map((b) => b.type), ['activity']);
});

test('the activity summary counts what is inside', () => {
  assert.match(core.activitySummary([{ role: 'tool' }, { role: 'tool' }]), /2/);
  assert.match(core.activitySummary([{ role: 'system' }]), /1/);
  assert.equal(core.activitySummary([]), '');
});

test('only http/https/mailto/# links survive markdown sanitising', () => {
  assert.equal(core.isSafeHref('https://example.com/x'), true);
  assert.equal(core.isSafeHref('http://example.com'), true);
  assert.equal(core.isSafeHref('mailto:a@b.c'), true);
  assert.equal(core.isSafeHref('#anchor'), true);

  assert.equal(core.isSafeHref('javascript:alert(1)'), false);
  assert.equal(core.isSafeHref('JaVaScRiPt:alert(1)'), false);
  assert.equal(core.isSafeHref('  javascript:alert(1)'), false);
  // browsers strip these before resolving the scheme, so we must too
  assert.equal(core.isSafeHref('java\tscript:alert(1)'), false);
  assert.equal(core.isSafeHref('java\nscript:alert(1)'), false);
  assert.equal(core.isSafeHref('data:text/html,<script>alert(1)</script>'), false);
  assert.equal(core.isSafeHref('vbscript:msgbox(1)'), false);
  assert.equal(core.isSafeHref('file:///etc/passwd'), false);
  assert.equal(core.isSafeHref('blob:https://x/y'), false);
  assert.equal(core.isSafeHref(''), false);
  assert.equal(core.isSafeHref(null), false);
});
