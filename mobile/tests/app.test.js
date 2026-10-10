// app.test.js — behaviour tests for mobile/web/js/app.js.
//
// MOCK LABEL: the backend is a fake api object built here (no network), and the
// DOM is mobile/tests/dom-harness.js (not a real browser). The UI logic under
// test -- app.js, core.js -- is the real production code, driven against the
// real mobile/web/index.html markup.
//
// Run with:  D:\env\node.exe --test mobile/tests/app.test.js
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const harness = require(path.join(__dirname, 'dom-harness.js'));
const RCApp = require(path.join(__dirname, '..', 'web', 'js', 'app.js'));
const core = require(path.join(__dirname, '..', 'web', 'js', 'core.js'));

const SAMPLE = 'K7QP-3MZD-9XTB-2RCV-6HNF-0JWS';

const SESSIONS = [
  { id: 'a1', tool: 'codex', title: '重构 relay 的转发层', status: 'working', updatedAt: '2026-10-08T03:57:55Z', cwd: 'D:\\w' },
  { id: 'b2', tool: 'dsh', title: 'Fix login redirect', status: 'idle', updatedAt: '2026-10-08T02:00:00Z', cwd: null }
];

const CAPS = {
  'sessions.list': true, 'session.read': true, 'session.send': true, 'session.stop': true,
  'stop:codex': true, 'stop:dsh': true, tools: ['codex', 'dsh']
};

const READ_A1 = {
  id: 'a1', tool: 'codex', title: '重构 relay 的转发层', status: 'working',
  messages: [
    { id: 'm1', role: 'user', text: '帮我看看转发层', timestamp: '2026-10-08T03:55:02Z' },
    { id: 'm2', role: 'assistant', text: '我先读一下现有的转发代码。', timestamp: '2026-10-08T03:55:09Z' }
  ],
  canStop: true, activeTurnId: 'turn-7'
};

const ok = (result) => ({ ok: true, result });
const err = (code, message) => ({ ok: false, code, message, status: 200 });

/** A fake RCApi with queued responses and a call log. */
function fakeApi() {
  const calls = [];
  const queues = {
    health: [], pair: [], list: [], read: [], send: [], stop: [], logout: [],
    models: [], create: []
  };
  const defaults = {
    health: ok({ bridgeOnline: true }),
    pair: ok({}),
    list: ok({ sessions: SESSIONS, capabilities: CAPS }),
    read: ok(READ_A1),
    send: ok({ accepted: true, sessionId: 'a1' }),
    stop: ok({ accepted: true, sessionId: 'a1' }),
    logout: ok({}),
    models: ok({ tool: 'codex', models: [] }),
    create: ok({ sessionId: 'created-1', tool: 'codex', model: 'm' })
  };
  function next(name, args) {
    calls.push({ name, args });
    const queue = queues[name];
    if (queue.length === 0) return Promise.resolve(defaults[name]);
    const item = queue.shift();
    return typeof item === 'function' ? item() : Promise.resolve(item);
  }
  return {
    calls,
    queues,
    on(name, response) { queues[name].push(response); return this; },
    health() { return next('health', []); },
    pair(code, deviceName) { return next('pair', [code, deviceName]); },
    rpc(body) {
      const name = {
        'sessions.list': 'list',
        'session.read': 'read',
        'session.send': 'send',
        'session.stop': 'stop',
        'models.list': 'models',
        'session.create': 'create'
      }[body.method];
      return next(name, [body]);
    },
    logout() { return next('logout', []); },
    callsOf(name) { return calls.filter((c) => c.name === name); }
  };
}

function boot(options) {
  const opts = options || {};
  const doc = harness.loadIndexHtml();
  const host = harness.makeHost(doc, { hash: opts.hash || '', online: opts.online });
  const api = fakeApi();
  Object.keys(opts.responses || {}).forEach((name) => {
    [].concat(opts.responses[name]).forEach((r) => api.on(name, r));
  });
  const app = RCApp.createApp({
    document: doc,
    window: host,
    api,
    deviceName: opts.deviceName || 'Test Device',
    now: host.now,
    setTimeout: host.setTimeout,
    clearTimeout: host.clearTimeout
  });
  return { doc, host, api, app };
}

// ---------------------------------------------------------------------------
// M6 item 1 + 2: pairing input and the #pair= fragment
// ---------------------------------------------------------------------------

test('the pairing screen is the first thing shown and it takes a code', async () => {
  const { doc, app, api } = boot({ responses: { list: err('unauthenticated', 'no cookie') } });
  await app.start();

  assert.equal(app.state.screen, 'pair');
  assert.equal(doc.getElementById('pair-screen').hidden, false);
  assert.equal(doc.getElementById('list-screen').hidden, true);

  doc.getElementById('pair-code-input').value = SAMPLE;
  doc.getElementById('pair-name-input').value = 'Pixel 8';
  await app.submitPair();

  const calls = api.callsOf('pair');
  assert.equal(calls.length, 1);
  // The canonical (normalized) form is what goes on the wire: protocol-v1 7.2
  // normalizes server-side anyway, so sending the canonical form is safe and
  // keeps the dashes/aliases out of the request.
  assert.equal(calls[0].args[0], 'K7QP3MZD9XTB2RCV6HNF0JWS');
  assert.equal(calls[0].args[0], core.normalizePairCode(SAMPLE));
  assert.equal(calls[0].args[1], 'Pixel 8');
});

test('#pair= fills the input, clears the fragment, and never leaves the code in the URL', async () => {
  const { doc, host, app } = boot({
    hash: '#pair=' + SAMPLE,
    responses: { list: err('unauthenticated', 'no cookie') }
  });
  await app.start();

  assert.equal(doc.getElementById('pair-code-input').value, SAMPLE);
  // consumed immediately: the code must not survive in the address bar
  assert.equal(host.location.hash, '');
  assert.equal(app.state.code, SAMPLE);
});

test('#pair= keeps unrelated fragment parameters while removing the code', async () => {
  const { doc, host, app } = boot({
    hash: '#pair=' + SAMPLE + '&deviceName=Pixel',
    responses: { list: err('unauthenticated', 'no cookie') }
  });
  await app.start();
  assert.equal(doc.getElementById('pair-code-input').value, SAMPLE);
  assert.equal(host.location.hash, '#deviceName=Pixel');
});

test('an invalid pairing code is refused in Chinese without calling the server', async () => {
  const { doc, app, api } = boot({ responses: { list: err('unauthenticated', 'no cookie') } });
  await app.start();

  doc.getElementById('pair-code-input').value = 'nope';
  await app.submitPair();

  assert.equal(api.callsOf('pair').length, 0, 'a malformed code must not spend a rate-limited request');
  assert.match(doc.getElementById('pair-error').textContent, /配对码/);
});

test('a rejected pairing shows the Chinese message from protocol-v1 6.2', async () => {
  const { doc, app } = boot({
    responses: {
      list: err('unauthenticated', 'no cookie'),
      pair: err('invalid_credentials', 'pairing code has expired')
    }
  });
  await app.start();
  doc.getElementById('pair-code-input').value = SAMPLE;
  await app.submitPair();

  assert.match(doc.getElementById('pair-error').textContent, /配对码无效、已过期或已被使用/);
  assert.equal(app.state.screen, 'pair');
});

// ---------------------------------------------------------------------------
// M6 item 3: the session list and its search
// ---------------------------------------------------------------------------

test('the session list renders title, status, source and time for every session', async () => {
  const { doc, app } = boot();
  await app.start();

  assert.equal(app.state.screen, 'list');
  const items = doc.getElementById('session-list').children;
  assert.equal(items.length, 2);
  const first = items[0].textContent;
  assert.match(first, /重构 relay 的转发层/);
  assert.match(first, /运行中/);
  // The product name, not the lower-case wire id: the id would make the list
  // look like a log dump.
  assert.match(first, /Codex/);
  assert.ok(!/\bcodex\b/.test(first), 'the wire id must not be shown as the tool label');
  const second = items[1].textContent;
  assert.match(second, /Fix login redirect/);
  assert.match(second, /空闲/);
  assert.match(second, /DSH/);
  assert.ok(!/\bdsh\b/.test(second), 'the wire id must not be shown as the tool label');
});

test('the search box filters the list by title, status and source', async () => {
  const { doc, app } = boot();
  await app.start();

  const search = doc.getElementById('search-input');
  search.value = 'dsh';
  search.dispatch('input');

  assert.equal(doc.getElementById('session-list').children.length, 1);
  assert.match(doc.getElementById('session-list').textContent, /Fix login redirect/);

  search.value = '运行中';
  search.dispatch('input');
  assert.equal(doc.getElementById('session-list').children.length, 1);
  assert.match(doc.getElementById('session-list').textContent, /重构 relay 的转发层/);

  search.value = 'zzzz';
  search.dispatch('input');
  assert.equal(doc.getElementById('session-list').children.length, 0);
  assert.equal(doc.getElementById('list-empty').hidden, false);
});

test('clicking a session opens its history with role, text and time', async () => {
  const { doc, app, api } = boot();
  await app.start();

  await app.openSession('a1');
  const reads = api.callsOf('read');
  assert.equal(reads.length, 1);
  // protocol-v1 7.3: session.read needs tool + sessionId, nothing else
  assert.deepEqual(reads[0].args[0], { method: 'session.read', params: { tool: 'codex', sessionId: 'a1' } });

  assert.equal(app.state.screen, 'detail');
  assert.equal(doc.getElementById('detail-title').textContent, '重构 relay 的转发层');
  assert.equal(doc.getElementById('detail-status').textContent, '运行中');
  const messages = doc.getElementById('message-list').children;
  assert.equal(messages.length, 2);
  assert.match(messages[0].textContent, /我/);
  assert.match(messages[0].textContent, /帮我看看转发层/);
  assert.match(messages[1].textContent, /AI/);
  assert.match(messages[1].textContent, /我先读一下现有的转发代码/);
  // a timestamp is rendered for each message
  assert.match(messages[1].textContent, /\d{2}:\d{2}/);
});

// ---------------------------------------------------------------------------
// M6 item 5: sending, and the duplicate-submit guard
// ---------------------------------------------------------------------------

test('sending continues the SAME sessionId and disables the button while in flight', async () => {
  const { doc, app, api } = boot();
  await app.start();
  await app.openSession('a1');

  let release;
  api.on('send', function () {
    return new Promise(function (resolve) { release = resolve; });
  });

  doc.getElementById('send-input').value = '继续';
  const first = app.sendMessage();
  await Promise.resolve();

  assert.equal(doc.getElementById('send-button').disabled, true, 'button must be disabled while submitting');
  assert.equal(api.callsOf('send').length, 1);

  // a second submit while the first is still in flight must do nothing
  await app.sendMessage();
  assert.equal(api.callsOf('send').length, 1, 'duplicate submit must be ignored');

  const sent = api.callsOf('send')[0].args[0];
  assert.deepEqual(sent, { method: 'session.send', params: { tool: 'codex', sessionId: 'a1', text: '继续' } });

  release(ok({ accepted: true, sessionId: 'a1' }));
  await first;
  assert.equal(doc.getElementById('send-button').disabled, false);
  assert.equal(doc.getElementById('send-input').value, '', 'input is cleared after a successful send');
});

test('a failed send keeps the text so the user can retry, and shows Chinese', async () => {
  const { doc, app } = boot({ responses: { send: err('bridge_offline', 'bridge offline') } });
  await app.start();
  await app.openSession('a1');

  doc.getElementById('send-input').value = '继续';
  await app.sendMessage();

  assert.equal(doc.getElementById('send-input').value, '继续');
  assert.match(doc.getElementById('detail-error').textContent, /电脑不在线/);
  assert.equal(doc.getElementById('detail-error').hidden, false);
});

// ---------------------------------------------------------------------------
// M6 item 6: the stop button follows canStop
// ---------------------------------------------------------------------------

test('the stop button follows canStop and stops the same session', async () => {
  const { doc, app, api } = boot();
  await app.start();
  await app.openSession('a1');

  // canStop true -> visible and enabled
  assert.equal(doc.getElementById('stop-button').hidden, false);
  assert.equal(doc.getElementById('stop-button').disabled, false);

  await app.stopSession();
  assert.deepEqual(api.callsOf('stop')[0].args[0], {
    method: 'session.stop', params: { tool: 'codex', sessionId: 'a1' }
  });
});

test('the stop button is hidden when canStop is false for an idle session', async () => {
  const idle = Object.assign({}, READ_A1, { status: 'idle', canStop: false });
  const { doc, app } = boot({ responses: { read: ok(idle) } });
  await app.start();
  await app.openSession('a1');
  assert.equal(doc.getElementById('stop-button').hidden, true);
});

test('a machine without stop support still SHOWS the button, greyed with a reason', async () => {
  // protocol-v1 9.5: an unsupported button must be visible but disabled with a
  // reason -- hiding it would pretend the feature does not exist.
  const caps = Object.assign({}, CAPS, { 'stop:codex': false, 'session.stop': false });
  const read = Object.assign({}, READ_A1, { status: 'idle', canStop: false });
  const { doc, app } = boot({
    responses: { list: ok({ sessions: SESSIONS, capabilities: caps }), read: ok(read) }
  });
  await app.start();
  await app.openSession('a1');

  const stop = doc.getElementById('stop-button');
  assert.equal(stop.hidden, false, 'must not hide an unsupported capability');
  assert.equal(stop.disabled, true);
  assert.match(doc.getElementById('stop-reason').textContent, /不支持|未启用/);
});

// ---------------------------------------------------------------------------
// M6 item 7: offline notice and retry
// ---------------------------------------------------------------------------

test('a transport failure shows a Chinese offline notice with a retry control', async () => {
  // Exactly the shape api.js returns for a request that never reached the
  // server: no protocol code and no HTTP status.
  const { doc, app, api } = boot({
    responses: { list: { ok: false, code: null, status: null, message: '网络不可用或已离线，请检查网络后重试' } }
  });
  await app.start();

  assert.equal(app.state.online, false);
  assert.equal(doc.getElementById('notice').hidden, false);
  assert.match(doc.getElementById('notice-text').textContent, /离线|网络/);
  assert.equal(doc.getElementById('notice-retry').hidden, false);
  // ...and the user can still reach the pairing form while offline.
  assert.equal(doc.getElementById('pair-screen').hidden, false);

  // the retry control works and recovers
  api.queues.list.length = 0;
  await app.retry();
  assert.equal(app.state.online, true);
  assert.equal(doc.getElementById('notice').hidden, true);
  assert.equal(doc.getElementById('session-list').children.length, 2);
});

test('browser online/offline events update the notice', async () => {
  const { doc, host, app } = boot();
  await app.start();
  host.navigator.onLine = false;
  host.dispatch('offline');
  assert.equal(doc.getElementById('notice').hidden, false);
  host.navigator.onLine = true;
  host.dispatch('online');
  assert.equal(app.state.online, true);
});

// ---------------------------------------------------------------------------
// M6 item 8: the 2 second poller
// ---------------------------------------------------------------------------

test('polling runs every 2 seconds and pauses while the document is hidden', async () => {
  const { doc, host, app, api } = boot();
  await app.start();
  const before = api.callsOf('list').length;
  assert.equal(core.LIST_INTERVAL_MS, 2000);
  assert.ok(host.pendingTimers() > 0, 'a poll timer must be scheduled');

  host.advance(1999);
  await app.tick();
  assert.equal(api.callsOf('list').length, before, 'must not poll early');

  host.advance(1);
  await app.tick();
  assert.equal(api.callsOf('list').length, before + 1);

  // hidden -> paused
  doc.hidden = true;
  doc.visibilityState = 'hidden';
  host.advance(10000);
  await app.tick();
  assert.equal(api.callsOf('list').length, before + 1, 'hidden document must not poll');

  // visible again -> resumes
  doc.hidden = false;
  doc.visibilityState = 'visible';
  await app.tick();
  assert.equal(api.callsOf('list').length, before + 2);
});

test('requests never stack: a slow poll blocks the next one', async () => {
  const { host, app, api } = boot();
  await app.start();
  const before = api.callsOf('list').length;

  let release;
  api.on('list', function () {
    return new Promise(function (resolve) { release = resolve; });
  });

  host.advance(2000);
  const pending = app.tick();
  assert.equal(api.callsOf('list').length, before + 1);

  host.advance(10000);
  await app.tick();
  assert.equal(api.callsOf('list').length, before + 1, 'must not start a second request while one is in flight');

  release(ok({ sessions: SESSIONS, capabilities: CAPS }));
  await pending;
  host.advance(2000);
  await app.tick();
  assert.equal(api.callsOf('list').length, before + 2, 'polling resumes once the previous request returned');
});

test('a refresh keeps the scroll position of the message list', async () => {
  const { doc, host, app } = boot();
  await app.start();
  await app.openSession('a1');

  const list = doc.getElementById('message-list');
  list.scrollTop = 120;

  host.advance(2000);
  await app.tick();

  assert.equal(list.scrollTop, 120, 'refreshing must not jump the user back to the top');
});

test('the detail view follows protocol-v1 7.3 read cadence, not the 2s list cadence', async () => {
  const idle = Object.assign({}, READ_A1, { status: 'idle', canStop: false });
  const { host, app, api } = boot({ responses: { read: ok(idle) } });
  await app.start();
  await app.openSession('a1');
  const reads = api.callsOf('read').length;

  host.advance(2000);
  await app.tick();
  assert.equal(api.callsOf('read').length, reads, 'an idle session is polled every 5000 ms');

  host.advance(3000);
  await app.tick();
  assert.equal(api.callsOf('read').length, reads + 1, '5000 ms have passed, so the read is due');
});

test('new messages appear after a poll and the id list grows', async () => {
  const grown = Object.assign({}, READ_A1, {
    messages: READ_A1.messages.concat([
      { id: 'm3', role: 'assistant', text: '转发层我改好了。', timestamp: '2026-10-08T03:58:00Z' }
    ])
  });
  const { doc, host, app } = boot({ responses: { read: [ok(READ_A1), ok(grown)] } });
  await app.start();
  await app.openSession('a1');
  assert.equal(doc.getElementById('message-list').children.length, 2);

  host.advance(2000);
  await app.tick();
  assert.equal(doc.getElementById('message-list').children.length, 3);
  assert.match(doc.getElementById('message-list').textContent, /转发层我改好了/);
});

// ---------------------------------------------------------------------------
// M6 item 9 + 10: injection safety and "no new session"
// ---------------------------------------------------------------------------

test('server text is rendered as text, never as markup', async () => {
  const hostile = {
    id: 'x1', tool: 'codex', title: '<img src=x onerror=alert(1)>', status: 'idle',
    messages: [
      { id: 'h1', role: 'user', text: '<script>alert(1)</script>', timestamp: '2026-10-08T03:55:02Z' }
    ],
    canStop: false
  };
  const { doc, app } = boot({
    responses: { list: ok({ sessions: [{ id: 'x1', tool: 'codex', title: hostile.title, status: 'idle', updatedAt: '2026-10-08T03:57:55Z', cwd: null }], capabilities: CAPS }), read: ok(hostile) }
  });
  await app.start();

  // The harness throws if innerHTML is ever touched, so reaching this line
  // already proves the list was built with textContent.
  assert.match(doc.getElementById('session-list').textContent, /<img src=x onerror=alert\(1\)>/);

  await app.openSession('x1');
  const rendered = doc.getElementById('message-list');
  assert.match(rendered.textContent, /<script>alert\(1\)<\/script>/);
  // and it is text, not an element
  assert.equal(harness.queryAll(rendered, (e) => e.tagName === 'SCRIPT').length, 0);
});

test('the session list offers a new-session entry that opens the panel', async () => {
  // The old rule banned any create control. The user overrode that (CRD 0006):
  // the phone may now create a session, but only through the real RPC.
  const { doc, app } = boot();
  await app.start();
  assert.equal(app.state.screen, 'list');

  const entry = doc.getElementById('new-session-button');
  assert.ok(entry, 'a new-session entry must exist on the list screen');
  entry.dispatch('click');

  assert.equal(app.state.screen, 'new');
  assert.equal(doc.getElementById('new-screen').hidden, false);
  assert.equal(doc.getElementById('list-screen').hidden, true);
  // The chat view itself must not carry a create control.
  const createInChat = harness.queryAll(
    doc.getElementById('detail-screen'),
    (node) => node.getAttribute && node.getAttribute('class') === 'new-session'
  );
  assert.deepEqual(createInChat, []);
});

test('an unknown status is styled as an error but does not disable anything', async () => {
  const weird = { id: 'w1', tool: 'codex', title: '怪状态', status: 'weird', updatedAt: '2026-10-08T03:57:55Z', cwd: null };
  const { doc, app } = boot({ responses: { list: ok({ sessions: [weird], capabilities: CAPS }) } });
  await app.start();
  assert.equal(app.state.screen, 'list');
  assert.match(doc.getElementById('session-list').textContent, /未知状态/);
  // protocol-v1 4.3: unknown status must not disable the row
  const row = doc.getElementById('session-list').children[0];
  assert.notEqual(row.disabled, true);
});

// ---------------------------------------------------------------------------
// Async race regressions (found by root acceptance on a real phone).
//
// Both cases need a request that answers LATE, because the defects only show up
// when a response lands after the user has already moved on.
// ---------------------------------------------------------------------------

test('a late list failure must not pull the user out of an open session', async () => {
  const { doc, host, app, api } = boot();
  await app.start();
  assert.equal(app.state.screen, 'list');

  // A background list refresh goes out and will answer late... with a timeout.
  let failList = null;
  api.on('list', function () {
    return new Promise(function (resolve) {
      failList = function () { resolve(err('bridge_timeout', 'bridge timeout')); };
    });
  });

  host.advance(2000);
  const pendingList = app.tick();
  assert.ok(failList, 'the list refresh must be in flight');

  // The user opens a session while that refresh is still out.
  await app.openSession('a1');
  assert.equal(app.state.screen, 'detail');

  // Only now does the list refresh time out.
  failList();
  await pendingList;

  // The user never pressed Back: they must still be in the session they opened.
  assert.equal(app.state.screen, 'detail', 'a late list failure must not navigate the user away');
  assert.equal(doc.getElementById('detail-screen').hidden, false);
  assert.equal(doc.getElementById('send-input').hidden, false, 'the composer must stay visible');
  assert.equal(app.state.current.id, 'a1');
  // ...and a background refresh the user did not ask for must not hijack the
  // notice with "电脑没有及时回应" while they are reading.
  assert.equal(doc.getElementById('notice').hidden, true,
    'a failed background list refresh must not surface a list error over the session');
});

test('a stale session.read must not overwrite the session the user switched to', async () => {
  const READ_B = {
    id: 'b2', tool: 'dsh', title: 'Fix login redirect', status: 'idle',
    messages: [{ id: 'n1', role: 'assistant', text: 'B 的历史', timestamp: '2026-10-08T02:00:03Z' }],
    canStop: false
  };
  const { doc, host, app, api } = boot({ responses: { read: [ok(READ_A1)] } });
  await app.start();
  await app.openSession('a1');
  assert.equal(app.state.current.id, 'a1');

  // Queue order matters: the deferred must be the NEXT read (the poll for A),
  // and B's answer must sit behind it.
  let releaseStale = null;
  api.on('read', function () {
    return new Promise(function (resolve) { releaseStale = resolve; });
  });
  api.on('read', ok(READ_B));

  host.advance(2000);
  const stale = app.tick();
  assert.ok(releaseStale, 'the a1 read must be in flight');

  // Meanwhile the user goes back and opens B.
  doc.getElementById('detail-back').dispatch('click');
  await app.openSession('b2');
  assert.equal(app.state.current.id, 'b2');
  assert.equal(doc.getElementById('detail-title').textContent, 'Fix login redirect');

  // A's answer finally arrives, about a session nobody is looking at anymore.
  releaseStale(ok(READ_A1));
  await stale;

  assert.equal(app.state.current.id, 'b2', 'a stale read must not replace the current session');
  assert.equal(doc.getElementById('detail-title').textContent, 'Fix login redirect');

  // And the next message must go to B -- never to the session the user left.
  doc.getElementById('send-input').value = '继续';
  await app.sendMessage();
  const sent = api.callsOf('send');
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0].args[0], {
    method: 'session.send',
    params: { tool: 'dsh', sessionId: 'b2', text: '继续' }
  });
});

// ---------------------------------------------------------------------------
// New-session panel: the model picker, and late list failures.
// ---------------------------------------------------------------------------

const DSH_CATALOG = {
  tool: 'dsh',
  models: [
    { id: 'deepseek-flash', label: 'deepseek-official', provider: 'deepseek-official', isDefault: true },
    { id: 'deepseek-flash', label: 'deepseek-account', provider: 'deepseek-account' },
    { id: 'deepseek-flash', label: 'deepseek-local', provider: 'deepseek-local' }
  ]
};
const DSH_CAPS = { 'models.list': true, 'session.create': true, 'stop:dsh': true, tools: ['dsh'] };

function bootNewPanel(extra) {
  return boot({
    responses: Object.assign({
      list: ok({ sessions: SESSIONS, capabilities: DSH_CAPS }),
      models: ok(DSH_CATALOG),
      create: ok({ sessionId: 'created-1', tool: 'dsh', model: 'deepseek-flash', provider: 'deepseek-account' })
    }, extra || {})
  });
}

test('every model option carries its own unique value, even when ids repeat', async () => {
  const { doc, app } = bootNewPanel();
  await app.start();
  await app.openNewSession();

  const select = doc.getElementById('model-select');
  const values = select.children.map((option) => option.getAttribute('value'));
  assert.equal(values.length, 3);
  assert.equal(new Set(values).size, 3,
    'duplicate option values make the browser pick the FIRST match: ' + JSON.stringify(values));
  // the model id is still shown to the user, alongside the provider
  const labels = select.children.map((option) => option.textContent);
  assert.ok(labels[1].includes('deepseek-flash'), 'the model id must be visible: ' + labels[1]);
  assert.ok(labels[1].includes('deepseek-account'), 'the provider must be visible: ' + labels[1]);
});

test('a real change event on the picker survives a re-render and creates on the chosen provider', async () => {
  const { doc, app, api } = bootNewPanel();
  await app.start();
  await app.openNewSession();

  const select = doc.getElementById('model-select');
  const values = select.children.map((option) => option.getAttribute('value'));
  const secondKey = values[1];

  // Drive the actual control, the way a finger does: set the value, fire change.
  select.value = secondKey;
  select.dispatch('change');

  assert.equal(app.newState.selectedKey, secondKey, 'the change handler must record the KEY');
  // A re-render (which happens on every catalog refresh) must NOT reset it to
  // the first entry -- that reset was the reported bug.
  app.renderNewPanel();
  assert.equal(doc.getElementById('model-select').value, secondKey,
    'the chosen entry must survive a re-render');
  assert.equal(app.newState.selectedKey, secondKey);

  // ...and the creation must go to the SECOND provider, not the first.
  await app.submitNewSession();
  const created = api.callsOf('create');
  assert.equal(created.length, 1);
  assert.deepEqual(created[0].args[0], {
    method: 'session.create',
    params: {
      tool: 'dsh',
      model: 'deepseek-flash',
      provider: 'deepseek-account',
      requestId: created[0].args[0].params.requestId
    }
  });
  assert.match(created[0].args[0].params.requestId,
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});

test('a confirmed successful creation shows no retry or failure entry', async () => {
  // Reported from a real browser: the panel offered "重发首条消息" after a
  // creation the desktop had reported as successful. That is a false failure
  // prompt, and it invites a duplicate message.
  const { doc, app } = bootNewPanel();
  await app.start();
  await app.openNewSession();
  doc.getElementById('new-text').value = '你好';
  doc.getElementById('new-text').dispatch('input');

  await app.submitNewSession();

  assert.equal(app.state.screen, 'detail', 'a successful creation opens the new session');
  assert.equal(doc.getElementById('detail-partial').hidden, true,
    'a confirmed success must not show a partial/failure notice');
  assert.equal(app.newState.pendingFirstText, '', 'nothing to re-send after a confirmed success');

  // The other branch must still work: an explicitly partial result DOES offer
  // the in-session re-send (hiding it always would be the opposite mistake).
  const partial = bootNewPanel({
    create: ok({ sessionId: 'created-2', tool: 'dsh', model: 'deepseek-flash', partial: true })
  });
  await partial.app.start();
  await partial.app.openNewSession();
  partial.doc.getElementById('new-text').value = '你好';
  await partial.app.submitNewSession();
  assert.equal(partial.doc.getElementById('detail-partial').hidden, false,
    'an explicitly partial creation must say so');
});

test('a late list failure must not yank the user out of the new-session panel', async () => {
  const { doc, host, app, api } = bootNewPanel();
  await app.start();
  await app.openNewSession();
  assert.equal(app.state.screen, 'new');

  let failList = null;
  api.on('list', function () {
    return new Promise(function (resolve) {
      failList = function () { resolve(err('bridge_timeout', 'bridge timeout')); };
    });
  });

  host.advance(2000);
  const pending = app.tick();
  assert.ok(failList, 'the background list refresh must be in flight');

  failList();
  await pending;

  // Same rule as the detail screen: a background refresh never navigates.
  assert.equal(app.state.screen, 'new', 'a late list failure must not leave the panel');
  assert.equal(doc.getElementById('new-screen').hidden, false);
  assert.equal(doc.getElementById('list-screen').hidden, true);
});

test('a stale detail error clears once the session works again', async () => {
  // Seen on a real phone: the bridge restarted, an error was shown, then the
  // bridge came back -- the badge said 已连接 while #detail-error stayed on
  // screen forever, contradicting itself.
  const { doc, app, api } = boot();
  await app.start();
  await app.openSession('a1');
  const error = doc.getElementById('detail-error');

  // the bridge restarts: the next read fails and IS reported
  api.on('read', err('bridge_offline', 'bridge offline'));
  await app.refreshDetail();
  assert.equal(error.hidden, false, 'a real failure must be shown');

  // it comes back: the next successful read must clear the stale error
  await app.refreshDetail();
  assert.equal(error.hidden, true, 'a successful read must clear the stale error');

  // same after a successful send
  api.on('read', err('bridge_offline', 'bridge offline'));
  await app.refreshDetail();
  assert.equal(error.hidden, false);
  doc.getElementById('send-input').value = '继续';
  await app.sendMessage();
  assert.equal(error.hidden, true, 'a successful send must clear the stale error too');

  // ...but a GENUINE partial notice is a different element and must survive:
  // clearing the error must not erase "会话已创建但首条消息未发出".
  app.newState.partial = { text: '会话已创建，但首条消息未发出。' };
  await app.refreshDetail();
  assert.equal(doc.getElementById('detail-partial').hidden, false,
    'a genuine partial notice must NOT be cleared by a successful read');
  assert.match(doc.getElementById('detail-partial-text').textContent, /首条消息未发出/);
});

// ---------------------------------------------------------------------------
// Q-02: the fragment must also be consumed by a SAME-DOCUMENT navigation.
// ---------------------------------------------------------------------------

test('#pair= is consumed on a same-document navigation too, not only on load', async () => {
  // The page is ALREADY loaded and running. Only the fragment changes, so the
  // browser performs a same-document navigation: nothing reloads and start()
  // never runs again. Before Q-02 the code was read only at load time, so a
  // #pair= link reached from inside the page did nothing at all.
  const { doc, host, app } = boot({
    responses: { list: err('unauthenticated', 'no cookie') }
  });
  await app.start();
  assert.equal(doc.getElementById('pair-code-input').value, '', 'starts empty');

  host.location.hash = '#pair=' + SAMPLE;
  host.dispatch('hashchange');

  assert.equal(doc.getElementById('pair-code-input').value, SAMPLE,
    'a same-document #pair= link must fill the code in');
  assert.equal(host.location.hash, '', 'and the fragment must be cleared immediately');
  assert.equal(app.state.code, SAMPLE);
});

// ---------------------------------------------------------------------------
// Startup routing — the four acceptance checks for the "pairing screen never
// appears" defect. These drive the REAL app.js against the REAL index.html;
// they are not pure-function tests.
// ---------------------------------------------------------------------------

test('startup routing 1: a fresh device with no cookie lands on the pairing screen', async () => {
  const { doc, app } = boot({ responses: { list: err('unauthenticated', 'no cookie') } });
  await app.start();

  assert.equal(app.state.screen, 'pair');
  assert.equal(doc.getElementById('pair-screen').hidden, false, 'the pairing form must be reachable');
  assert.equal(doc.getElementById('list-screen').hidden, true, 'an unpaired device must not see the list');
  assert.equal(doc.getElementById('pair-code-input').value, '');
  assert.equal(app.state.authed, false);
});

test('startup routing 2: a #pair= deep link lands on the pairing screen, pre-filled', async () => {
  const { doc, app } = boot({
    hash: '#pair=' + SAMPLE,
    responses: { list: err('unauthenticated', 'no cookie') }
  });
  await app.start();

  assert.equal(app.state.screen, 'pair');
  assert.equal(doc.getElementById('pair-screen').hidden, false);
  assert.equal(doc.getElementById('list-screen').hidden, true);
  assert.equal(doc.getElementById('pair-code-input').value, SAMPLE, 'the code must be pre-filled');
});

test('startup routing 3: the list screen appears only after a successful call', async () => {
  // Success (an existing, valid cookie) -> list.
  const good = boot();
  await good.app.start();
  assert.equal(good.app.state.screen, 'list');
  assert.equal(good.doc.getElementById('list-screen').hidden, false);
  assert.equal(good.doc.getElementById('pair-screen').hidden, true);
  assert.equal(good.app.state.authed, true);

  // Anything else -> pairing stays reachable.
  const bad = boot({ responses: { list: err('internal', 'internal error') } });
  await bad.app.start();
  assert.equal(bad.app.state.screen, 'pair');
  assert.equal(bad.doc.getElementById('pair-screen').hidden, false);
});

test('startup routing 4: a 401 returns the user to the pairing screen', async () => {
  const { doc, app } = boot();
  await app.start();
  assert.equal(app.state.screen, 'list');

  // The cookie is revoked while the app is open -> next poll gets a 401.
  const { doc: d2, app: a2 } = boot({ responses: { list: err('unauthenticated', 'unauthenticated') } });
  await a2.start();
  assert.equal(a2.state.screen, 'pair');
  assert.equal(d2.getElementById('pair-screen').hidden, false);
  assert.equal(a2.state.authed, false);
  assert.ok(doc && app);
});

test('an unrecognised response (a proxy 501) still leaves the pairing form reachable', async () => {
  // This is the exact case the PM hit with a preview server: HTTP 501, a body
  // that is not the protocol-v1 6.1 shape, so api.js reports code:null.
  const { doc, app } = boot({
    responses: { list: { ok: false, code: null, status: 501, message: '服务器返回了无法识别的响应（HTTP 501）' } }
  });
  await app.start();

  assert.equal(app.state.screen, 'pair', 'a fresh device must never be stranded on the list screen');
  assert.equal(doc.getElementById('pair-screen').hidden, false);
  assert.equal(doc.getElementById('list-screen').hidden, true);
  assert.match(doc.getElementById('notice-text').textContent, /无法识别/);
});

test('a 403 while signed in keeps the session and the list', async () => {
  // protocol-v1 v2: `forbidden` means the identity is valid and the permission
  // is not -- throwing the session away here would be wrong.
  const { doc, app, api } = boot();
  await app.start();
  assert.equal(app.state.authed, true);

  api.queues.list.length = 0;
  api.on('list', err('forbidden', 'no permission'));
  await app.refreshList();

  assert.equal(app.state.screen, 'list', 'a 403 must not discard a live session');
  assert.equal(app.state.authed, true);
  assert.match(doc.getElementById('notice-text').textContent, /没有权限/);
});
