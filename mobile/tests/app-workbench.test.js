// app-workbench.test.js — functional tests for the mobile AI workbench UI.
//
// MOCK LABEL: the backend is a fake api object built here (no network) and the
// DOM is mobile/tests/dom-harness.js (not a real browser). The code under test
// — web/js/app.js, core.js, prefs.js, ui.js — is the real shipping code, driven
// against the real web/index.html markup. The real-browser run is separate and
// is recorded in mobile/BUILD_REPORT.md.
//
// What these tests are for: the workbench tabs and filters, the "next message
// model" picker, the two pending panels (questions and permission approvals)
// including their exactly-once and race behaviour, drafts and reading position
// across polls, and the honest handling of a tool that cannot do something.
//
// Run with:  D:\env\node.exe --test mobile/tests/app-workbench.test.js
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const harness = require(path.join(__dirname, 'dom-harness.js'));
const RCApp = require(path.join(__dirname, '..', 'web', 'js', 'app.js'));
const core = require(path.join(__dirname, '..', 'web', 'js', 'core.js'));

const ok = (result) => ({ ok: true, result });
const err = (code, message) => ({ ok: false, code, message, status: 200 });

function memoryStorage(initial) {
  const map = new Map(Object.entries(initial || {}));
  return {
    getItem(key) { return map.has(key) ? map.get(key) : null; },
    setItem(key, value) { map.set(key, String(value)); },
    removeItem(key) { map.delete(key); },
    dump() { return Object.fromEntries(map); }
  };
}

const SESSIONS = [
  { id: 'a1', tool: 'codex', title: '重构 relay 的转发层', status: 'working', updatedAt: '2026-10-08T03:57:55Z', cwd: 'D:\\w\\remote-control' },
  { id: 'b2', tool: 'dsh', title: 'Fix login redirect', status: 'idle', updatedAt: '2026-10-08T02:00:00Z', cwd: null },
  { id: 'c3', tool: 'dsh', title: '等确认的任务', status: 'idle', updatedAt: '2026-10-08T01:00:00Z', cwd: null, needsInput: true }
];

const CAPS = {
  'sessions.list': true, 'session.read': true, 'session.send': true, 'session.stop': true,
  'stop:codex': true, 'stop:dsh': true,
  'models.list': true, 'session.create': true,
  'models.list:codex': true, 'models.list:dsh': true,
  'session.create:codex': true, 'session.create:dsh': true,
  'session.answer:dsh': true, 'session.approve:dsh': true,
  'session.answer:codex': false, 'session.approve:codex': false,
  tools: ['codex', 'dsh']
};

const DSH_CATALOG = {
  tool: 'dsh',
  models: [
    { id: 'deepseek-flash', label: 'deepseek-official', provider: 'deepseek-official', isDefault: true,
      reasoningEfforts: ['low', 'high'], defaultReasoningEffort: 'high' },
    { id: 'deepseek-flash', label: 'deepseek-account', provider: 'deepseek-account' }
  ],
  projects: [
    { id: 'p1', name: 'remote-control', cwd: 'D:\\workspace\\codex-workspace\\remote-control' },
    { id: 'p2', name: 'other-app', cwd: 'D:\\work\\other-app' }
  ]
};

const APPROVAL_ID = '3f1a6f4e-2b0c-4d5e-8a91-0c2b7d6e5f40';

const DSH_READ = {
  id: 'b2', tool: 'dsh', title: 'Fix login redirect', status: 'idle',
  messages: [
    { id: 'n1', role: 'user', text: '帮我改一下登录跳转', timestamp: '2026-10-08T02:00:01Z' },
    { id: 'n2', role: 'assistant', text: '好的，我先读代码。', timestamp: '2026-10-08T02:00:03Z' }
  ],
  canStop: false,
  currentModel: { model: 'deepseek-flash', provider: 'deepseek-official', reasoningEffort: 'high' },
  pendingQuestions: [{
    callId: 'call-42',
    state: 'open',
    questions: [
      {
        id: 'q1', question: '要重试吗？', header: '构建失败',
        options: [{ label: '重试', description: '再跑一次' }, { label: '跳过' }]
      },
      {
        id: 'q2', question: '选哪些文件？', multiSelect: true,
        options: [{ label: 'a.js' }, { label: 'b.js' }]
      }
    ]
  }],
  pendingApprovals: [
    { id: APPROVAL_ID, toolName: 'shell', callId: 'call-43', reason: '想运行 npm test' }
  ]
};

/** A fake RCApi with queued responses, a call log and per-method defaults. */
function fakeApi(overrides) {
  const calls = [];
  const queues = {
    health: [], pair: [], list: [], read: [], send: [], stop: [], logout: [],
    models: [], create: [], answer: [], approve: [], me: [], adminLogin: [],
    adminLogout: [], adminComputers: [], adminRpc: [], adminEnrollmentCodes: []
  };
  const defaults = Object.assign({
    health: ok({ bridgeOnline: true }),
    pair: ok({}),
    list: ok({ sessions: SESSIONS, capabilities: CAPS }),
    read: ok(DSH_READ),
    send: ok({ accepted: true, sessionId: 'b2' }),
    stop: ok({ accepted: true, sessionId: 'b2' }),
    logout: ok({}),
    models: ok(DSH_CATALOG),
    create: ok({ sessionId: 'created-1', tool: 'dsh', model: 'deepseek-flash' }),
    answer: ok({ accepted: true, sessionId: 'b2', callId: 'call-42' }),
    approve: ok({ accepted: true, sessionId: 'b2', approvalId: APPROVAL_ID, state: 'submitted' }),
    me: err('unauthenticated', 'unauthenticated'),
    adminLogin: ok({ role: 'admin' }),
    adminLogout: ok({}),
    adminComputers: ok({ computers: [] }),
    adminRpc: function (request) {
      const body = request.body;
      if (body.method === 'sessions.list') return ok({ sessions: SESSIONS, capabilities: CAPS });
      if (body.method === 'session.read') return readFor(body.params.sessionId);
      if (body.method === 'models.list') return ok(DSH_CATALOG);
      if (body.method === 'session.answer') return ok({ accepted: true, sessionId: body.params.sessionId, callId: body.params.callId });
      if (body.method === 'session.approve') return ok({ accepted: true, sessionId: body.params.sessionId, approvalId: body.params.approvalId, state: 'submitted' });
      if (body.method === 'session.send') return ok({ accepted: true, sessionId: body.params.sessionId });
      if (body.method === 'session.stop') return ok({ accepted: true, sessionId: body.params.sessionId });
      return err('not_capable', 'not capable');
    },
    adminEnrollmentCodes: ok({ code: 'TEST-ENROLLMENT-CODE', expiresAt: '2026-10-11T12:00:00Z' })
  }, overrides || {});
  function next(name, args) {
    calls.push({ name, args });
    // A function is a live handler: it receives the call's first argument (the
    // request params for rpc, or e.g. the sessionId for read). A plain value is
    // a canned body. Both shapes are supported on the default AND queue paths.
    const respond = (item) => {
      const first = Array.isArray(args) ? args[0] : args;
      return Promise.resolve(typeof item === 'function' ? item(first) : item);
    };
    const queue = queues[name];
    if (queue.length === 0) {
      return respond(defaults[name]);
    }
    return respond(queue.shift());
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
        'session.create': 'create',
        'session.answer': 'answer',
        'session.approve': 'approve'
      }[body.method];
      return next(name || ('unknown:' + body.method), [body]);
    },
    logout() { return next('logout', []); },
    me() { return next('me', []); },
    adminLogin(username, password) { return next('adminLogin', [{ username, password }]); },
    adminLogout() { return next('adminLogout', []); },
    adminComputers() { return next('adminComputers', []); },
    adminRpc(clientId, body) { return next('adminRpc', [{ clientId, body }]); },
    adminEnrollmentCodes() { return next('adminEnrollmentCodes', []); },
    callsOf(name) { return calls.filter((c) => c.name === name); }
  };
}

function boot(options) {
  const opts = options || {};
  const doc = harness.loadIndexHtml();
  const host = harness.makeHost(doc, { hash: opts.hash || '', online: opts.online });
  const api = fakeApi(opts.defaults);
  Object.keys(opts.responses || {}).forEach((name) => {
    [].concat(opts.responses[name]).forEach((r) => api.on(name, r));
  });
  // A FUNCTION default is a live handler, not a canned body: it receives the
  // request params, which is what lets one handler answer differently per tool
  // (two catalogs) instead of returning the same body for every call. The queue
  // path in fakeApi already did this; defaults did not.
  const storage = opts.storage === undefined ? memoryStorage() : opts.storage;
  const app = RCApp.createApp({
    document: doc,
    window: host,
    api,
    storage,
    deviceName: opts.deviceName || 'Test Device',
    now: host.now,
    setTimeout: host.setTimeout,
    clearTimeout: host.clearTimeout
  });
  return { doc, host, api, app, storage };
}

const rows = (doc) => doc.getElementById('session-list').children;
const text = (doc, id) => doc.getElementById(id).textContent;

/** Let the app's own async work (a catalog fetch chain) finish. */
const settle = () => new Promise((resolve) => setImmediate(resolve));

/**
 * A default session.read that answers for the session that was ASKED about.
 * A single canned answer for every session is how a test accidentally checks
 * the wrong session's behaviour.
 */
const readFor = (id) => ok(Object.assign(
  {},
  id === 'b2' ? DSH_READ : {},
  {
    id: id,
    tool: id === 'a1' ? 'codex' : 'dsh',
    title: id === 'a1' ? '重构 relay 的转发层' : (id === 'b2' ? 'Fix login redirect' : '等确认的任务'),
    status: 'idle',
    messages: DSH_READ.messages,
    canStop: false
  }
));

/** Find, by data attribute, one node anywhere under the real index.html. */
function byAttr(doc, attr, value) {
  const found = harness.queryAll(doc.body, (el) => el.getAttribute && el.getAttribute(attr) === value);
  return found;
}

function chipByLabel(doc, id, label) {
  return doc.getElementById(id).children.filter((node) => node.textContent === label)[0] || null;
}

async function enterAdmin(options) {
  const instance = boot(options);
  await instance.app.start();
  await instance.app.logout();
  instance.doc.getElementById('pair-admin-login-toggle').dispatch('click');
  instance.doc.getElementById('admin-username-input').value = 'operator';
  instance.doc.getElementById('admin-password-input').value = 'admin-test-secret';
  instance.doc.getElementById('admin-login-submit').dispatch('click');
  await settle();
  return instance;
}

function adminRpcFixture(targets, onCall) {
  return function (request) {
    if (onCall) onCall(request);
    const target = targets[request.clientId];
    if (!target || target.online === false) return err('target_offline', '电脑不在线或不存在');
    const body = request.body;
    if (body.method === 'sessions.list') {
      return ok({ sessions: target.sessions || [], capabilities: target.capabilities || CAPS });
    }
    if (body.method === 'session.read') {
      const read = target.reads && target.reads[body.params.sessionId] || target.read;
      return read ? ok(read) : err('session_not_found', 'not found');
    }
    if (body.method === 'models.list') {
      const catalog = target.catalogs && target.catalogs[body.params.tool] || target.catalog;
      return catalog ? ok(catalog) : err('not_capable', 'this tool does not support listing models');
    }
    if (body.method === 'session.create') {
      return ok(target.createResult || { sessionId: 'created-workbuddy', tool: body.params.tool, title: 'Created session' });
    }
    if (body.method === 'session.answer') return ok({ accepted: true, sessionId: body.params.sessionId, callId: body.params.callId });
    if (body.method === 'session.approve') return ok({ accepted: true, sessionId: body.params.sessionId, approvalId: body.params.approvalId, state: 'submitted' });
    if (body.method === 'session.send') return ok({ accepted: true, sessionId: body.params.sessionId });
    if (body.method === 'session.stop') return ok({ accepted: true, sessionId: body.params.sessionId });
    return err('not_capable', 'not capable');
  };
}

// ---------------------------------------------------------------------------
// Workbench tabs
// ---------------------------------------------------------------------------

test('the workbench opens on 会话 and the tab bar is the only switcher', async () => {
  const { doc, app } = boot();
  await app.start();

  assert.equal(app.state.screen, 'list');
  assert.equal(app.state.tab, 'chats');
  assert.equal(doc.getElementById('tabbar').hidden, false);
  assert.equal(rows(doc).length, 3);
  assert.equal(doc.getElementById('tab-chats').getAttribute('class'), 'tab tab-active');

  // 任务 keeps the working and the waiting sessions, and summarises them from
  // the desktop's own statuses -- not from a local guess.
  await app.selectTab('tasks');
  assert.equal(app.state.tab, 'tasks');
  assert.equal(app.state.screen, 'list', '任务 is a view of the same list, not a new screen');
  assert.deepEqual(rows(doc).map((row) => row.getAttribute('data-id')), ['a1', 'c3']);
  assert.match(text(doc, 'task-summary'), /待你确认 1 · 运行中 1/);
  assert.equal(doc.getElementById('tab-tasks').getAttribute('class'), 'tab tab-active');

  // 设置 is a separate panel but still inside the workbench chrome.
  await app.selectTab('settings');
  assert.equal(app.state.screen, 'settings');
  assert.equal(doc.getElementById('settings-screen').hidden, false);
  assert.equal(doc.getElementById('list-screen').hidden, true);

  await app.selectTab('chats');
  assert.equal(app.state.screen, 'list');
  assert.equal(doc.getElementById('list-screen').hidden, false);
  assert.equal(doc.getElementById('settings-screen').hidden, true);
});

test('the pending badge counts real needsInput, working and error sessions', async () => {
  const { doc, app } = boot();
  await app.start();
  assert.equal(doc.getElementById('tab-tasks-badge').textContent, '2');
  assert.equal(doc.getElementById('tab-tasks-badge').hidden, false);

  const clean = boot({
    responses: { list: ok({ sessions: [{ id: 'z', tool: 'dsh', title: '闲', status: 'idle' }], capabilities: CAPS }) }
  });
  await clean.app.start();
  assert.equal(clean.doc.getElementById('tab-tasks-badge').hidden, true);
});

test('the tool filter switches between Codex, DSH and everything', async () => {
  const { doc, app } = boot();
  await app.start();

  const chips = doc.getElementById('tool-filter').children.map((c) => c.textContent);
  assert.deepEqual(chips, ['全部', 'Codex', 'DSH']);

  chipByLabel(doc, 'tool-filter', 'DSH').dispatch('click');
  assert.equal(app.state.toolFilter, 'dsh');
  assert.deepEqual(rows(doc).map((r) => r.getAttribute('data-id')), ['b2', 'c3']);
  assert.equal(chipByLabel(doc, 'tool-filter', 'DSH').getAttribute('class'), 'chip chip-active');

  chipByLabel(doc, 'tool-filter', 'Codex').dispatch('click');
  assert.deepEqual(rows(doc).map((r) => r.getAttribute('data-id')), ['a1']);

  // The filter survives a poll and a tab switch: it belongs to the view.
  await app.refreshList();
  assert.deepEqual(rows(doc).map((r) => r.getAttribute('data-id')), ['a1']);

  chipByLabel(doc, 'tool-filter', '全部').dispatch('click');
  assert.equal(rows(doc).length, 3);
});

test('the project sheet offers only real projects and filters exactly', async () => {
  const { doc, app } = boot();
  await app.start();

  doc.getElementById('project-filter-button').dispatch('click');
  await settle();
  assert.equal(doc.getElementById('project-sheet').hidden, false);
  assert.equal(doc.getElementById('sheet-backdrop').hidden, false);
  const sheetRows = doc.getElementById('project-sheet-list').children;
  // "全部项目" plus the two catalog projects plus the directory this session
  // really reports (a1's cwd) -- and nothing invented.
  assert.equal(sheetRows.length, 4);
  const projectIds = byAttr(doc, 'data-project-id', 'p1');
  assert.equal(projectIds.length, 1);
  assert.match(doc.getElementById('project-sheet-list').textContent, /remote-control/);
  assert.match(doc.getElementById('project-sheet-list').textContent, /other-app/);
  // The projects really came from a live models.list, not from a constant.
  assert.ok(app.state.sessionCatalog && app.state.sessionCatalog.catalog, 'the sheet needed a live catalog');

  // Searching narrows it by name or path, for long Windows paths too.
  doc.getElementById('project-search-input').value = 'other';
  doc.getElementById('project-search-input').dispatch('input');
  assert.equal(doc.getElementById('project-sheet-list').children.length, 2);
  doc.getElementById('project-search-input').value = 'codex-workspace';
  doc.getElementById('project-search-input').dispatch('input');
  assert.equal(doc.getElementById('project-sheet-list').children.length, 2);
  doc.getElementById('project-search-input').value = 'zzz';
  doc.getElementById('project-search-input').dispatch('input');
  assert.equal(doc.getElementById('project-sheet-empty').hidden, false);

  app.setProjectFilter('p1');
  assert.equal(doc.getElementById('project-sheet').hidden, true, 'picking a project closes the sheet');
  assert.deepEqual(rows(doc).map((r) => r.getAttribute('data-id')), []);
  assert.match(text(doc, 'project-filter-button'), /项目：remote-control/);
  assert.match(text(doc, 'list-empty'), /没有匹配的会话/);
});

test('a filter that matches nothing explains itself, and can be cleared', async () => {
  const { doc, app } = boot();
  await app.start();

  doc.getElementById('search-input').value = 'zzzz';
  doc.getElementById('search-input').dispatch('input');
  assert.equal(rows(doc).length, 0);
  assert.equal(doc.getElementById('list-empty').hidden, false);
  assert.match(text(doc, 'list-empty'), /没有匹配的会话/);
  assert.equal(doc.getElementById('filter-clear-button').hidden, false);

  doc.getElementById('filter-clear-button').dispatch('click');
  assert.equal(rows(doc).length, 3);
  assert.equal(doc.getElementById('filter-clear-button').hidden, true);
  assert.equal(doc.getElementById('search-input').value, '');
});

test('the 任务 tab says so when nothing is running', async () => {
  const { doc, app } = boot({
    responses: { list: ok({ sessions: [{ id: 'z', tool: 'dsh', title: '闲', status: 'idle' }], capabilities: CAPS }) }
  });
  await app.start();
  await app.selectTab('tasks');
  assert.equal(rows(doc).length, 0);
  assert.equal(doc.getElementById('list-empty').hidden, false);
  assert.match(text(doc, 'list-empty'), /没有运行中或待确认的会话/);
  assert.equal(doc.getElementById('task-summary').hidden, true);
});

// ---------------------------------------------------------------------------
// Pins and remembered preferences
// ---------------------------------------------------------------------------

test('pinning is local, moves the session up, and is remembered', async () => {
  const storage = memoryStorage();
  const { doc, app } = boot({ storage });
  await app.start();
  assert.deepEqual(rows(doc).map((r) => r.getAttribute('data-id')), ['a1', 'b2', 'c3']);

  const pin = byAttr(doc, 'data-pin-for', 'c3')[0];
  assert.ok(pin, 'each row carries its own pin control');
  pin.dispatch('click');
  // The row is rebuilt with the pin first, so re-read the node each time.
  assert.deepEqual(rows(doc).map((r) => r.getAttribute('data-id')), ['c3', 'a1', 'b2']);
  assert.equal(byAttr(doc, 'data-pin-for', 'c3')[0].getAttribute('class'), 'pin-button pin-on');

  // A poll must not lose it, and it is on disk for the next visit.
  await app.refreshList();
  assert.deepEqual(rows(doc).map((r) => r.getAttribute('data-id')), ['c3', 'a1', 'b2']);
  assert.deepEqual(JSON.parse(storage.getItem('rc.workbench.v1')).pins, { c3: true });

  await app.selectTab('settings');
  assert.match(text(doc, 'pins-summary'), /已置顶 1 个会话/);
  doc.getElementById('pins-clear-button').dispatch('click');
  assert.deepEqual(rows(doc).map((r) => r.getAttribute('data-id')), ['a1', 'b2', 'c3']);

  // Clicking the pin again unpins it, and clicking once more pins it back.
  await app.selectTab('chats');
  assert.deepEqual(app.prefs.get().pins, {});
  assert.equal(byAttr(doc, 'data-pin-for', 'a1')[0].getAttribute('class'), 'pin-button');
  byAttr(doc, 'data-pin-for', 'a1')[0].dispatch('click');
  assert.deepEqual(app.prefs.get().pins, { a1: true });
  assert.equal(byAttr(doc, 'data-pin-for', 'a1')[0].getAttribute('class'), 'pin-button pin-on');
  byAttr(doc, 'data-pin-for', 'a1')[0].dispatch('click');
  assert.deepEqual(app.prefs.get().pins, {});
  assert.equal(byAttr(doc, 'data-pin-for', 'a1')[0].getAttribute('class'), 'pin-button');
  byAttr(doc, 'data-pin-for', 'a1')[0].dispatch('click');
  assert.equal(byAttr(doc, 'data-pin-for', 'a1')[0].getAttribute('class'), 'pin-button pin-on');

  // A fresh boot from the same storage puts the pinned session first.
  const again = boot({ storage });
  await again.app.start();
  assert.deepEqual(rows(again.doc).map((r) => r.getAttribute('data-id')), ['a1', 'b2', 'c3']);
});

test('the theme is a remembered local choice and never a protocol field', async () => {
  const storage = memoryStorage();
  const { doc, app } = boot({ storage });
  await app.start();
  assert.equal(doc.documentElement.getAttribute('data-theme'), null);

  await app.selectTab('settings');
  chipByLabel(doc, 'theme-choices', '深色').dispatch('click');
  assert.equal(doc.documentElement.getAttribute('data-theme'), 'dark');
  assert.equal(JSON.parse(storage.getItem('rc.workbench.v1')).theme, 'dark');

  chipByLabel(doc, 'theme-choices', '浅色').dispatch('click');
  assert.equal(doc.documentElement.getAttribute('data-theme'), 'light');
  chipByLabel(doc, 'theme-choices', '跟随系统').dispatch('click');
  assert.equal(doc.documentElement.getAttribute('data-theme'), null);
});

test('the tab, tool and project filters come back on the next visit', async () => {
  const storage = memoryStorage();
  const first = boot({ storage });
  await first.app.start();
  await first.app.selectTab('tasks');
  first.app.setToolFilter('dsh');
  first.app.setProjectFilter('p1');
  await first.app.selectTab('settings');

  const saved = JSON.parse(storage.getItem('rc.workbench.v1'));
  assert.deepEqual(saved, { theme: 'auto', tab: 'settings', tool: 'dsh', projectId: 'p1', pins: {} });

  // A fresh boot from the same storage restores the visible filters.
  const second = boot({ storage });
  await second.app.start();
  assert.equal(second.app.state.toolFilter, 'dsh');
  assert.equal(second.app.state.projectFilter, 'p1');
  assert.equal(second.app.state.tab, 'settings');
  assert.equal(second.doc.getElementById('settings-screen').hidden, false);
  assert.deepEqual(rows(second.doc).map((r) => r.getAttribute('data-id')), []);
  // The project's readable name is back too: it is remembered from the catalog
  // the first visit fetched, not re-invented from the id.
  assert.match(text(second.doc, 'project-filter-button'), /项目：p1/);

  // The search box is deliberately NOT remembered: a remembered search is how
  // a list looks mysteriously empty after a restart.
  assert.equal(second.app.state.query, '');
});

// ---------------------------------------------------------------------------
// "下条消息模型": the next-message model picker in the composer
// ---------------------------------------------------------------------------

test('the composer picker defaults to 沿用当前模型 and reports the native model', async () => {
  const { doc, app } = boot();
  await app.start();
  await app.openSession('b2');
  await settle();

  // No model was ever chosen: the chip states the desktop's OWN current model.
  assert.match(text(doc, 'model-chip-button'), /沿用当前模型/);
  assert.match(text(doc, 'model-chip-button'), /deepseek-flash/);
  assert.match(text(doc, 'model-chip-button'), /deepseek-official/);
  assert.equal(doc.getElementById('model-reset-button').hidden, true);

  doc.getElementById('model-chip-button').dispatch('click');
  assert.equal(doc.getElementById('model-picker').hidden, false);
  // The picker's own rows come from a live models.list, and the inherit row is
  // first -- there is no invented entry.
  const pickerRows = doc.getElementById('model-picker-list').children;
  assert.equal(pickerRows.length, 3);
  assert.match(pickerRows[0].textContent, /沿用当前模型/);
  assert.match(pickerRows[1].textContent, /deepseek-flash/);
  assert.match(pickerRows[2].textContent, /deepseek-account/);
  assert.match(text(doc, 'model-picker-note'), /电脑现在报告这个会话使用/);
});

test('a long native model description never buries the model id in the picker', async () => {
  // Real Codex catalog shape: `label` is an English sentence, not a name. The
  // row is truncated on a phone, so the id has to come first.
  const CODEX_CATALOG = {
    tool: 'codex',
    models: [
      { id: 'gpt-5-codex-mini', label: 'Fast and affordable model for easier tasks.', isDefault: true },
      { id: 'gpt-5-codex', label: 'Latest workhorse for hard problems.' }
    ]
  };
  const { doc, app } = boot({ responses: { models: ok(CODEX_CATALOG) } });
  await app.start();
  await app.openSession('b2');
  await settle();
  doc.getElementById('model-chip-button').dispatch('click');

  const pickerRows = doc.getElementById('model-picker-list').children;
  assert.equal(pickerRows.length, 3, 'the inherit row plus the two reported models');

  const first = pickerRows[1];
  const label = first.children.filter((node) => node.getAttribute('class') === 'picker-row-label')[0];
  assert.ok(label.textContent.startsWith('gpt-5-codex-mini'),
    'the model id must be the primary text: ' + label.textContent);
  assert.match(label.textContent, /Fast and affordable/,
    'the native description stays available after the id');
  // The description is secondary help, carried as a tooltip, never a substitute
  // for the id.
  const help = first.children.filter((node) => node.getAttribute('class') === 'picker-row-desc')[0];
  assert.equal(help.textContent, 'Fast and affordable model for easier tasks.');
  assert.equal(first.getAttribute('title'), 'Fast and affordable model for easier tasks.');
  assert.equal(help.getAttribute('title'), 'Fast and affordable model for easier tasks.');

  // A chosen model shows its id on the chip, not the sentence.
  const secondKey = core.modelOptionKey(core.modelOptions(CODEX_CATALOG)[1]);
  byAttr(doc, 'data-model-key', secondKey)[0].dispatch('click');
  assert.ok(text(doc, 'model-chip-button').startsWith('gpt-5-codex'),
    'the chip names the model: ' + text(doc, 'model-chip-button'));
});

test('a normal send keeps the old body; a chosen model carries provider and effort', async () => {
  const { doc, app, api } = boot();
  await app.start();
  await app.openSession('b2');
  await settle();
  doc.getElementById('model-chip-button').dispatch('click');

  // Send with nothing chosen: exactly the three fields an older desktop knows.
  doc.getElementById('send-input').value = '继续';
  await app.sendMessage();
  assert.deepEqual(api.callsOf('send')[0].args[0], {
    method: 'session.send',
    params: { tool: 'dsh', sessionId: 'b2', text: '继续' }
  });

  // Choose the SECOND provider of the same model id, and an effort.
  const secondKey = core.modelOptionKey(core.modelOptions(DSH_CATALOG)[1]);
  byAttr(doc, 'data-model-key', secondKey)[0].dispatch('click');
  assert.match(text(doc, 'model-chip-button'), /deepseek-account/);
  assert.equal(doc.getElementById('model-reset-button').hidden, false);

  doc.getElementById('send-input').value = '换模型再来';
  await app.sendMessage();
  assert.deepEqual(api.callsOf('send')[1].args[0], {
    method: 'session.send',
    params: {
      tool: 'dsh', sessionId: 'b2',
      model: 'deepseek-flash', provider: 'deepseek-account',
      text: '换模型再来'
    }
  });

  // Back to 沿用当前模型: the plain body again. A preference is not sticky on the
  // wire, and the picker never turns it into a session-level change.
  doc.getElementById('model-reset-button').dispatch('click');
  assert.equal(doc.getElementById('model-reset-button').hidden, true);
  assert.match(text(doc, 'model-chip-button'), /沿用当前模型/);
  doc.getElementById('send-input').value = '还是原来的';
  await app.sendMessage();
  assert.deepEqual(api.callsOf('send')[2].args[0], {
    method: 'session.send',
    params: { tool: 'dsh', sessionId: 'b2', text: '还是原来的' }
  });
});

test('the effort selector only offers what the chosen model really supports', async () => {
  const { doc, app, api } = boot();
  await app.start();
  await app.openSession('b2');
  await settle();
  doc.getElementById('model-chip-button').dispatch('click');

  // Nothing chosen: the row is INFORMATION about the session's own effort, and
  // no effort can be attached to an inherit send.
  assert.equal(doc.getElementById('model-picker-effort').hidden, false);
  assert.deepEqual(
    doc.getElementById('model-picker-effort-select').children.map((o) => o.getAttribute('value')),
    ['high']
  );
  doc.getElementById('send-input').value = '沿用';
  await app.sendMessage();
  assert.deepEqual(api.callsOf('send')[0].args[0].params,
    { tool: 'dsh', sessionId: 'b2', text: '沿用' });

  // Choose the model that declares low/high: now an effort really is a choice,
  // and the model's own default is preselected.
  const firstKey = core.modelOptionKey(core.modelOptions(DSH_CATALOG)[0]);
  byAttr(doc, 'data-model-key', firstKey)[0].dispatch('click');
  assert.equal(doc.getElementById('model-picker-effort').hidden, false);
  assert.deepEqual(
    doc.getElementById('model-picker-effort-select').children.map((o) => o.getAttribute('value')),
    ['low', 'high']
  );
  assert.equal(doc.getElementById('model-picker-effort-select').value, 'high');

  doc.getElementById('model-picker-effort-select').value = 'low';
  doc.getElementById('model-picker-effort-select').dispatch('change');
  doc.getElementById('send-input').value = '低强度';
  await app.sendMessage();
  assert.deepEqual(api.callsOf('send')[1].args[0].params, {
    tool: 'dsh', sessionId: 'b2',
    model: 'deepseek-flash', provider: 'deepseek-official', reasoningEffort: 'low',
    text: '低强度'
  });

  // A model that declares no efforts hides the row rather than offering an
  // effort the desktop never confirmed.
  const secondKey = core.modelOptionKey(core.modelOptions(DSH_CATALOG)[1]);
  const secondRow = byAttr(doc, 'data-model-key', secondKey)[0];
  assert.ok(secondRow, 'the second provider of the same model id must be selectable');
  assert.equal(secondRow.getAttribute('class'), 'picker-row');
  secondRow.dispatch('click');
  assert.equal(doc.getElementById('model-picker-effort').hidden, true);
  assert.equal(doc.getElementById('model-reset-button').hidden, false);

  // Back to 沿用: the row is information again, and the send is the plain body.
  doc.getElementById('model-reset-button').dispatch('click');
  assert.deepEqual(
    doc.getElementById('model-picker-effort-select').children.map((o) => o.getAttribute('value')),
    ['high']
  );
  doc.getElementById('send-input').value = '再次沿用';
  await app.sendMessage();
  assert.deepEqual(api.callsOf('send')[2].args[0].params,
    { tool: 'dsh', sessionId: 'b2', text: '再次沿用' });
});

test('a tool without models keeps the composer honest instead of inventing one', async () => {
  const { doc, app } = boot({ defaults: { models: err('not_capable', 'no models') } });
  await app.start();
  await app.openSession('b2');
  await settle();
  doc.getElementById('model-chip-button').dispatch('click');
  assert.match(doc.getElementById('model-picker-list').textContent, /该会话不支持这个操作|没有报告可用模型/);
  // The chip still tells the truth about the native current model.
  assert.match(text(doc, 'model-chip-button'), /deepseek-flash/);
  // The plain send path still works.
  doc.getElementById('send-input').value = '继续';
  await app.sendMessage();
});

test('Codex reports no current model, so the phone claims none', async () => {
  const codexRead = { id: 'a1', tool: 'codex', title: '重构 relay 的转发层', status: 'working', messages: [], canStop: true };
  const { doc, app } = boot({ responses: { read: ok(codexRead) } });
  await app.start();
  await app.openSession('a1');
  await settle();
  assert.equal(text(doc, 'model-chip-button'), '沿用当前模型');
  doc.getElementById('model-chip-button').dispatch('click');
  assert.match(text(doc, 'model-picker-note'), /没有报告这个会话当前使用的模型/);
});

// ---------------------------------------------------------------------------
// Pending questions
// ---------------------------------------------------------------------------

function pickOption(doc, label) {
  const buttons = byAttr(doc, 'data-option-label', label);
  assert.ok(buttons.length > 0, 'expected an option labelled ' + label);
  buttons[0].dispatch('click');
}

function submitQuestions(doc, callId) {
  const button = byAttr(doc, 'data-answer-call', callId)[0];
  assert.ok(button, 'expected a submit control for ' + callId);
  button.dispatch('click');
}

test('pending questions render the desktop labels, cardinality and custom field', async () => {
  const { doc, app } = boot();
  await app.start();
  await app.openSession('b2');

  const panel = doc.getElementById('questions-panel');
  assert.equal(panel.hidden, false);
  assert.match(panel.textContent, /AI 在等你回答/);
  assert.match(panel.textContent, /构建失败/);
  assert.match(panel.textContent, /要重试吗？/);
  assert.match(panel.textContent, /重试/);
  assert.match(panel.textContent, /再跑一次/);
  assert.match(panel.textContent, /选哪些文件？/);
  // A question with no answer yet cannot be submitted as-is: the control is
  // there, and pressing it says what is missing rather than sending junk.
  const cards = byAttr(doc, 'data-call-id', 'call-42');
  assert.equal(cards.length, 1);
  submitQuestions(doc, 'call-42');
  await Promise.resolve();
  assert.match(doc.getElementById('questions-list').textContent, /请为每个问题选择答案/);
});

test('a single-select question replaces its choice; a multi-select accumulates', async () => {
  const { doc, app, api } = boot();
  await app.start();
  await app.openSession('b2');

  pickOption(doc, '重试');
  pickOption(doc, '跳过');
  // Single-select: the second choice replaces the first.
  assert.equal(byAttr(doc, 'data-option-label', '重试')[0].getAttribute('class'), 'option');
  assert.equal(byAttr(doc, 'data-option-label', '跳过')[0].getAttribute('class'), 'option option-active');

  pickOption(doc, 'a.js');
  pickOption(doc, 'b.js');
  assert.equal(byAttr(doc, 'data-option-label', 'a.js')[0].getAttribute('class'), 'option option-active');
  assert.equal(byAttr(doc, 'data-option-label', 'b.js')[0].getAttribute('class'), 'option option-active');

  submitQuestions(doc, 'call-42');
  await new Promise((resolve) => setImmediate(resolve));

  const answers = api.callsOf('answer');
  assert.equal(answers.length, 1);
  assert.deepEqual(answers[0].args[0], {
    method: 'session.answer',
    params: {
      tool: 'dsh', sessionId: 'b2', callId: 'call-42',
      answers: [
        { id: 'q1', selected: ['跳过'] },
        { id: 'q2', selected: ['a.js', 'b.js'] }
      ]
    }
  });
  // 'submitted' is what the transport said, and the card stays until the
  // desktop's own state settles.
  assert.match(doc.getElementById('questions-list').textContent, /已提交/);
  assert.equal(byAttr(doc, 'data-answer-call', 'call-42')[0].disabled, true);
});

test('custom text answers a question, is kept across polls, and is submitted once', async () => {
  const { doc, app, api } = boot();
  await app.start();
  await app.openSession('b2');

  const custom = byAttr(doc, 'data-custom-for', 'q1')[0];
  custom.value = '先看看日志再决定';
  custom.dispatch('input');
  pickOption(doc, 'a.js');

  // A poll must not lose the half-typed answer.
  await app.refreshDetail();
  assert.equal(byAttr(doc, 'data-custom-for', 'q1')[0].value, '先看看日志再决定');
  assert.equal(byAttr(doc, 'data-option-label', 'a.js')[0].getAttribute('class'), 'option option-active');

  // Choosing an option after typing text is a contradiction for a single-select
  // question, so the batch is refused with an explanation and NOT submitted.
  pickOption(doc, '重试');
  submitQuestions(doc, 'call-42');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(api.callsOf('answer').length, 0, 'an ambiguous single-select form must not be submitted');
  assert.match(doc.getElementById('questions-list').textContent, /单选只能选一个/);

  // Back to text only: now it goes out, exactly once.
  pickOption(doc, '重试');
  submitQuestions(doc, 'call-42');
  await new Promise((resolve) => setImmediate(resolve));
  const answers = api.callsOf('answer');
  assert.equal(answers.length, 1);
  assert.deepEqual(answers[0].args[0].params.answers, [
    { id: 'q1', selected: [], custom: '先看看日志再决定' },
    { id: 'q2', selected: ['a.js'] }
  ]);

  // Pressing the control again cannot submit a second time.
  submitQuestions(doc, 'call-42');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(api.callsOf('answer').length, 1);
});

test('a stale or refused answer is reported honestly and the choice is kept', async () => {
  const { doc, app, api } = boot({ defaults: { answer: err('not_capable', 'this question is no longer active') } });
  await app.start();
  await app.openSession('b2');

  pickOption(doc, '重试');
  pickOption(doc, 'a.js');
  submitQuestions(doc, 'call-42');
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(api.callsOf('answer').length, 1);
  assert.match(doc.getElementById('questions-list').textContent, /该会话不支持这个操作/);
  // The card is still there and re-answerable, because nothing settled.
  assert.equal(byAttr(doc, 'data-answer-call', 'call-42')[0].disabled, false);
  assert.equal(byAttr(doc, 'data-option-label', '重试')[0].getAttribute('class'), 'option option-active');
});

test('a question for the session the user LEFT is never attributed to the new one', async () => {
  const otherRead = Object.assign({}, DSH_READ, {
    id: 'c3', title: '等确认的任务',
    pendingQuestions: [{
      callId: 'call-99', state: 'open',
      questions: [{ id: 'z1', question: '另一个会话的问题？', options: [{ label: '是' }, { label: '否' }] }]
    }],
    pendingApprovals: []
  });
  const { doc, app, api } = boot({ responses: { read: [ok(otherRead)] } });
  await app.start();
  await app.openSession('c3');
  assert.equal(byAttr(doc, 'data-call-id', 'call-99').length, 1);

  // Back to the list: the old session's answerable form must not stay reachable
  // behind the list view.
  doc.getElementById('detail-back').dispatch('click');
  assert.equal(app.state.screen, 'list');
  assert.deepEqual(byAttr(doc, 'data-call-id', 'call-99'), []);

  // A background refresh while no session is open must not bring it back.
  await app.tick();
  assert.deepEqual(byAttr(doc, 'data-call-id', 'call-99'), []);
  assert.deepEqual(api.callsOf('answer'), []);
});

test('a Codex session surfaces a real question without a fake answer button', async () => {
  const codexRead = {
    id: 'a1', tool: 'codex', title: '重构 relay 的转发层', status: 'working',
    messages: [], canStop: true,
    // The desktop reported a real question, but Codex has no native answer tool.
    pendingQuestions: DSH_READ.pendingQuestions
  };
  const { doc, app } = boot({ responses: { read: ok(codexRead) } });
  await app.start();
  await app.openSession('a1');

  const panel = doc.getElementById('questions-panel');
  assert.equal(panel.hidden, false);
  assert.match(panel.textContent, /要重试吗？/, 'the real question is shown, not hidden');
  assert.match(text(doc, 'questions-unsupported'), /请在电脑上回答/);
  assert.equal(byAttr(doc, 'data-answer-call', 'call-42').length, 0, 'no answer button may be invented');
  // The card is titled for a human, not with the opaque native call id.
  assert.doesNotMatch(panel.textContent, /问题 call-42/);
  assert.match(panel.textContent, /构建失败/, 'the native question header names the card');
});

test('a Codex session with NO pending question never invents a waiting panel', async () => {
  // The reported bug: Codex has no `session.answer` capability, and the phone
  // turned that missing capability into "AI 在等你回答" even though the session
  // was asking nothing. A missing capability is not a pending question.
  const readWithEmptyList = () => ({
    id: 'a1', tool: 'codex', title: '重构 relay 的转发层', status: 'working',
    messages: [], canStop: true,
    pendingQuestions: [], pendingApprovals: []
  });
  const { doc, app, api } = boot({
    responses: {
      read: [
        // A genuine question first, so the transition back to "nothing" is the
        // thing under test rather than a panel that was never painted.
        ok(Object.assign(readWithEmptyList(), { pendingQuestions: DSH_READ.pendingQuestions })),
        // Then the desktop reports an EMPTY list...
        ok(readWithEmptyList()),
        // ...and then omits the field entirely, as a tool without the feature does.
        ok(Object.assign(readWithEmptyList(), { pendingQuestions: undefined }))
      ]
    }
  });
  await app.start();
  await app.openSession('a1');

  const panel = doc.getElementById('questions-panel');
  assert.equal(panel.hidden, false, 'precondition: the real question was shown');
  assert.match(panel.textContent, /要重试吗？/);

  await app.refreshDetail();
  assert.equal(app.state.capabilities['session.answer:codex'], false, 'precondition: codex cannot answer');
  assert.equal(panel.hidden, true, 'an empty pendingQuestions list must hide the whole panel');
  assert.equal(doc.getElementById('questions-unsupported').hidden, true,
    'no unsupported notice without a genuine pending form');
  assert.equal(doc.getElementById('questions-list').children.length, 0);
  assert.deepEqual(byAttr(doc, 'data-call-id', 'call-42'), []);
  assert.deepEqual(api.callsOf('answer'), []);

  // The omitted-field shape behaves identically.
  await app.refreshDetail();
  assert.equal(panel.hidden, true, 'an absent pendingQuestions field must hide the panel too');
  assert.equal(doc.getElementById('questions-unsupported').hidden, true);
  assert.equal(doc.getElementById('questions-list').children.length, 0);
});

test('text typed into the answer field is submitted even if no input event fired', async () => {
  // Autofill and IME commits can land in the control without an `input` event,
  // and a poll re-creates the controls. The value must still travel, so the
  // payload is read back from the live DOM at submit time.
  const { doc, app, api } = boot();
  await app.start();
  await app.openSession('b2');

  pickOption(doc, 'a.js');
  // Set LAST, after the last re-render, and deliberately without an input event.
  byAttr(doc, 'data-custom-for', 'q1')[0].value = '走这条路';
  submitQuestions(doc, 'call-42');
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(api.callsOf('answer').length, 1);
  assert.deepEqual(api.callsOf('answer')[0].args[0].params.answers, [
    { id: 'q1', selected: [], custom: '走这条路' },
    { id: 'q2', selected: ['a.js'] }
  ]);
});

test('an oversized native form is refused instead of shown incomplete', async () => {  const huge = {
    callId: 'call-huge', state: 'open',
    questions: Array.from({ length: 9 }, (_, i) => ({ id: 'q' + i, question: '问题' + i }))
  };
  const { doc, app } = boot({
    responses: { read: ok(Object.assign({}, DSH_READ, { pendingQuestions: [huge], pendingApprovals: [] })) }
  });
  await app.start();
  await app.openSession('b2');
  assert.match(doc.getElementById('questions-list').textContent, /超出手机能安全展示的范围/);
  assert.equal(byAttr(doc, 'data-answer-call', 'call-huge').length, 0);
});

// ---------------------------------------------------------------------------
// Pending permission approvals
// ---------------------------------------------------------------------------

function clickApproval(doc, label) {
  const buttons = harness.queryAll(doc.getElementById('approvals-list'),
    (el) => el.tagName === 'BUTTON' && el.textContent === label);
  assert.ok(buttons.length > 0, 'expected an approval button labelled ' + label);
  buttons[0].dispatch('click');
}

test('the approval panel shows the real tool and reason, and submits exactly once', async () => {
  const { doc, app, api } = boot();
  await app.start();
  await app.openSession('b2');

  const panel = doc.getElementById('approvals-panel');
  assert.equal(panel.hidden, false);
  assert.match(panel.textContent, /电脑请求权限/);
  assert.match(panel.textContent, /shell/);
  assert.match(panel.textContent, /想运行 npm test/);
  assert.match(panel.textContent, /只对这一次请求生效/);
  // There is no allow-always and no blanket grant anywhere in the panel.
  assert.ok(!/始终允许|全部允许|always/.test(panel.textContent));

  clickApproval(doc, '仅允许本次');
  await new Promise((resolve) => setImmediate(resolve));

  const calls = api.callsOf('approve');
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].args[0], {
    method: 'session.approve',
    params: { tool: 'dsh', sessionId: 'b2', approvalId: APPROVAL_ID, decision: 'allow-once' }
  });
  // 'submitted' is transport submission, not a won race: the card says 已提交,
  // waits, and its buttons are disabled so nothing is submitted twice.
  assert.match(doc.getElementById('approvals-list').textContent, /已提交，等待电脑确认/);
  clickApproval(doc, '拒绝');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(api.callsOf('approve').length, 1);
});

test('拒绝 submits the rejection for that one request', async () => {
  const { doc, app, api } = boot();
  await app.start();
  await app.openSession('b2');
  clickApproval(doc, '拒绝');
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(api.callsOf('approve')[0].args[0].params,
    { tool: 'dsh', sessionId: 'b2', approvalId: APPROVAL_ID, decision: 'reject' });
});

test('a stale approval is refused safely and stays actionable', async () => {
  const { doc, app, api } = boot({ defaults: { approve: err('not_capable', 'this approval is no longer active') } });
  await app.start();
  await app.openSession('b2');
  clickApproval(doc, '仅允许本次');
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(api.callsOf('approve').length, 1);
  assert.match(doc.getElementById('approvals-list').textContent, /该会话不支持这个操作/);
  // Not settled natively, so the request is still offered -- and pressing it
  // again is a fresh explicit decision, not an automatic retry.
  clickApproval(doc, '拒绝');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(api.callsOf('approve').length, 2);
});

test('the card disappears only when the desktop stops reporting the request', async () => {
  const settled = Object.assign({}, DSH_READ, { pendingApprovals: [], pendingQuestions: [] });
  const { doc, app } = boot({ responses: { read: [ok(DSH_READ), ok(settled)] } });
  await app.start();
  await app.openSession('b2');
  assert.equal(doc.getElementById('approvals-panel').hidden, false);

  clickApproval(doc, '仅允许本次');
  await new Promise((resolve) => setImmediate(resolve));
  // The submit re-reads native state; that read reports the request gone, so
  // the card goes with it -- and only because of that.
  assert.equal(doc.getElementById('approvals-panel').hidden, true);
  assert.deepEqual(byAttr(doc, 'data-approval-id', APPROVAL_ID), []);
});

test('a race where another client answered first does not become a false success', async () => {
  // The desktop accepts the submission (ok:true) but keeps reporting the
  // request, which is what a lost race looks like from here.
  const stillPending = Object.assign({}, DSH_READ);
  const { doc, app } = boot({ responses: { read: [ok(DSH_READ), ok(stillPending), ok(stillPending)] } });
  await app.start();
  await app.openSession('b2');
  clickApproval(doc, '仅允许本次');
  await new Promise((resolve) => setImmediate(resolve));

  const panel = doc.getElementById('approvals-panel');
  assert.equal(panel.hidden, false, 'a pending request stays visible');
  assert.match(panel.textContent, /已提交，等待电脑确认/, 'the receipt never claims the permission was granted');
  assert.ok(!/已允许|授权成功/.test(panel.textContent));
});

test('a Codex session never grows an approval button', async () => {
  const codexRead = {
    id: 'a1', tool: 'codex', title: '重构 relay 的转发层', status: 'working',
    messages: [], canStop: true,
    pendingApprovals: DSH_READ.pendingApprovals
  };
  const { doc, app, api } = boot({ responses: { read: ok(codexRead) } });
  await app.start();
  await app.openSession('a1');
  assert.equal(doc.getElementById('approvals-panel').hidden, true);
  assert.deepEqual(api.callsOf('approve'), []);
});

// ---------------------------------------------------------------------------
// Drafts, reading position and late responses
// ---------------------------------------------------------------------------

test('the composer draft survives a poll and belongs to its own session', async () => {
  const { doc, app } = boot({ defaults: { read: (body) => readFor(body.params.sessionId) } });
  await app.start();
  await app.openSession('b2');

  const input = doc.getElementById('send-input');
  input.value = '正在写一半的消息';
  input.dispatch('input');
  await app.refreshDetail();
  assert.equal(doc.getElementById('send-input').value, '正在写一半的消息');

  // Switching away and coming back restores each session's OWN draft: text
  // typed for one session must never be sitting in another one's composer.
  await app.openSession('a1');
  await app.refreshDetail();
  assert.equal(doc.getElementById('send-input').value, '', 'the other session has no draft');

  const secondInput = doc.getElementById('send-input');
  secondInput.value = '另一条草稿';
  secondInput.dispatch('input');
  await app.refreshDetail();
  assert.equal(doc.getElementById('send-input').value, '另一条草稿');

  await app.openSession('b2');
  await app.refreshDetail();
  assert.equal(doc.getElementById('send-input').value, '正在写一半的消息');
});

test('the reading position is kept while new messages arrive', async () => {
  const grown = Object.assign({}, DSH_READ, {
    messages: DSH_READ.messages.concat([
      { id: 'n3', role: 'assistant', text: '刚刚又跑完一步', timestamp: '2026-10-08T02:01:00Z' }
    ])
  });
  const { doc, app } = boot({ responses: { read: [ok(DSH_READ), ok(grown)] } });
  await app.start();
  await app.openSession('b2');

  const list = doc.getElementById('message-list');
  assert.equal(list.children.length, 2);
  list.scrollTop = 180;
  await app.refreshDetail();
  assert.equal(list.children.length, 3, 'the new message is rendered');
  assert.equal(list.scrollTop, 180, 'the reader was not jerked back to the top');
});

test('a late read for another session never lands in the open one', async () => {
  const otherRead = Object.assign({}, DSH_READ, {
    id: 'c3', title: '等确认的任务',
    pendingQuestions: [], pendingApprovals: []
  });
  const { doc, host, app, api } = boot();
  await app.start();
  // openSession('b2') consumes the DSH_READ fixture, complete with its pending
  // question and approval; the queue below then owns the only deferred read.
  await app.openSession('b2');
  assert.match(text(doc, 'questions-list'), /要重试吗？/);
  assert.equal(app.state.current.id, 'b2');

  // A background read for b2 is in flight when the user opens c3.
  let release = null;
  api.queues.read.length = 0;
  api.on('read', () => new Promise((resolve) => { release = resolve; }));
  api.on('read', ok(otherRead));
  host.advance(5000);
  const pending = app.tick();
  assert.ok(release, 'the b2 read must be in flight');

  await app.openSession('c3');
  assert.equal(app.state.current.id, 'c3');
  release(readFor('b2'));
  await pending;

  assert.equal(app.state.current.id, 'c3');
  assert.equal(text(doc, 'detail-title'), '等确认的任务');
  assert.equal(doc.getElementById('questions-panel').hidden, true,
    'the other session\'s question must not appear in this one');
  // And a send still goes to the session on screen.
  doc.getElementById('send-input').value = '继续';
  await app.sendMessage();
  assert.equal(api.callsOf('send')[0].args[0].params.sessionId, 'c3');
});

test('leaving a session keeps its expanded activity, its draft and its filters', async () => {
  const withActivity = Object.assign({}, DSH_READ, {
    messages: DSH_READ.messages.concat([
      { id: 't1', role: 'tool', text: 'ran npm test', timestamp: '2026-10-08T02:00:05Z' }
    ]),
    pendingQuestions: [], pendingApprovals: []
  });
  const { doc, app } = boot({ responses: { read: [ok(withActivity), ok(withActivity), ok(withActivity)] } });
  await app.start();

  doc.getElementById('search-input').value = 'login';
  doc.getElementById('search-input').dispatch('input');
  await app.openSession('b2');

  const details = harness.queryAll(doc.getElementById('message-list'), (el) => el.tagName === 'DETAILS');
  assert.equal(details.length, 1);
  details[0].open = true;
  details[0].dispatch('toggle');
  doc.getElementById('send-input').value = '草稿';
  doc.getElementById('send-input').dispatch('input');

  doc.getElementById('detail-back').dispatch('click');
  assert.equal(app.state.screen, 'list');
  assert.equal(doc.getElementById('search-input').value, 'login', 'the filter is still there');

  await app.openSession('b2');
  assert.equal(doc.getElementById('send-input').value, '草稿', 'the draft came back');
  const reopened = harness.queryAll(doc.getElementById('message-list'), (el) => el.tagName === 'DETAILS');
  assert.equal(reopened[0].open, true, 'the expanded activity block is still expanded');
});

test('two polls in a row do not duplicate the pending panels', async () => {
  const { doc, app } = boot();
  await app.start();
  await app.openSession('b2');
  await app.refreshDetail();
  await app.refreshDetail();
  assert.equal(byAttr(doc, 'data-call-id', 'call-42').length, 1);
  assert.equal(byAttr(doc, 'data-approval-id', APPROVAL_ID).length, 1);
});

// ---------------------------------------------------------------------------
// The workbench shell: the new-chat action and where 退出登录 lives
// ---------------------------------------------------------------------------

test('the new-chat action is a compact header control, and the list has no footer buttons', async () => {
  const { doc, app } = boot();
  await app.start();
  assert.equal(app.state.screen, 'list');

  const entry = doc.getElementById('new-session-button');
  assert.ok(entry, 'a new-chat action must exist');
  // It lives in the app bar, NOT under the list: the old full-width footer
  // button was eating the bottom of the chat list.
  const appbar = doc.getElementById('appbar');
  assert.ok(harness.queryAll(appbar, (node) => node === entry).length === 1,
    'the new-chat action belongs to the header');
  assert.equal(entry.getAttribute('aria-label'), '新建会话',
    'a compact glyph needs an accessible name');
  // The class the stylesheet gives the 44px target; it must not be a `wide`
  // full-width button any more.
  assert.match(entry.getAttribute('class') || '', /icon-action/);
  assert.ok(!/\bwide\b/.test(entry.getAttribute('class') || ''));

  // Nothing in the list screen is a full-width footer button.
  const listButtons = harness.queryAll(doc.getElementById('list-screen'),
    (node) => node.tagName === 'BUTTON' && /\bwide\b/.test(node.getAttribute('class') || ''));
  assert.deepEqual(listButtons, [], 'the chat list must not end in footer buttons');

  entry.dispatch('click');
  assert.equal(app.state.screen, 'new');
  assert.equal(doc.getElementById('new-screen').hidden, false);
  assert.equal(doc.getElementById('list-screen').hidden, true);
});

test('退出登录 keeps its id, lives in 设置 only, and still signs the device out', async () => {
  const { doc, app, api } = boot();
  await app.start();

  const logout = doc.getElementById('logout-button');
  assert.ok(logout, 'the logout control must keep the id it always had');
  const settings = doc.getElementById('settings-screen');
  assert.ok(harness.queryAll(settings, (node) => node === logout).length === 1,
    'the logout control belongs to 设置');
  const listScreen = doc.getElementById('list-screen');
  assert.ok(harness.queryAll(listScreen, (node) => node === logout).length === 0,
    'the chat list must not carry a logout button');
  // There is exactly ONE sign-out control: no duplicate under 设置.
  const allLogout = harness.queryAll(doc.body,
    (node) => node.getAttribute && node.getAttribute('id') === 'logout-button');
  assert.equal(allLogout.length, 1);
  assert.equal(doc.getElementById('settings-logout-button'), null,
    'the duplicate settings-only control is gone');

  // Navigating to 设置 and pressing it really logs out.
  await app.selectTab('settings');
  assert.equal(app.state.screen, 'settings');
  doc.getElementById('logout-button').dispatch('click');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(api.callsOf('logout').length, 1);
  assert.equal(app.state.authed, false);
  assert.equal(app.state.screen, 'pair');
});

// ---------------------------------------------------------------------------
// The project sheet: one option per real directory, with honest tool cues
// ---------------------------------------------------------------------------

/** A catalog per tool, from a live models.list, with real project ids. */
function toolCatalog(tool, projects) {
  return ok({
    tool,
    models: [{ id: 'm-' + tool, label: 'm-' + tool, isDefault: true, provider: tool + '-p' }],
    projects
  });
}

test('the project sheet folds the same directory written two ways into one option', async () => {
  // Codex calls the directory `p1`; DSH calls the SAME directory `dsh-1`; a
  // recent session reports it with a trailing slash instead.
  const sameDir = { codex: 'D:\\workspace\\remote-control', dsh: 'd:/workspace/remote-control/' };
  const { doc, app } = boot({
    defaults: {
      models: (body) => toolCatalog(body.params.tool,
        body.params.tool === 'codex'
          ? [{ id: 'p1', name: 'remote-control', cwd: sameDir.codex }]
          : [{ id: 'dsh-1', name: 'remote-control', cwd: sameDir.dsh }])
    },
    responses: {
      // The session's OWN read, so the open session really is the Codex one.
      read: [readFor('a1')],
      list: ok({
        sessions: [
          { id: 'a1', tool: 'codex', title: '重构 relay 的转发层', status: 'working', updatedAt: '2026-10-08T03:57:55Z', cwd: 'D:\\workspace\\remote-control\\' },
          { id: 'b2', tool: 'dsh', title: 'Fix login redirect', status: 'idle', updatedAt: '2026-10-08T02:00:00Z', cwd: null }
        ],
        capabilities: CAPS
      })
    }
  });
  await app.start();

  // The Codex session's own read gives the sheet its Codex catalog; opening the
  // sheet also asks for the other tool's catalog, because an honest tool cue
  // needs every tool's own list.
  await app.openSession('a1');
  await settle();
  assert.equal(app.state.current.tool, 'codex');
  await app.selectTab('chats');
  await app.openProjectSheet();
  // Both catalogs really landed: that is what the cue below is asserting.
  assert.deepEqual(Object.keys(app.state.sessionCatalogs['user:paired']).sort(), ['codex', 'dsh']);

  const rows = doc.getElementById('project-sheet-list').children;
  const names = rows.map((row) => row.textContent);
  // 全部项目 + ONE directory. The session's `D:\workspace\remote-control\` is
  // the same directory as the catalog's, so it is not a second row.
  assert.equal(rows.length, 2, 'one directory is one option: ' + names.join(' | '));
  assert.match(names[1], /remote-control/);
  // The cue is honest: both tools really reported this directory.
  const cues = harness.queryAll(rows[1], (node) => node.getAttribute
    && /\btool-cue\b/.test(node.getAttribute('class') || ''));
  assert.deepEqual(cues.map((node) => node.getAttribute('data-tool')).sort(), ['codex', 'dsh']);
  assert.deepEqual(cues.map((node) => node.textContent).sort(), ['Codex', 'DSH']);
  // The filter still selects exactly the sessions in that directory.
  const button = harness.queryAll(rows[1], (node) => node.tagName === 'BUTTON')[0];
  button.dispatch('click');
  assert.equal(doc.getElementById('project-sheet').hidden, true, 'picking a project closes the sheet');
  assert.equal(app.state.projectFilter, 'p1');
  assert.deepEqual(rowsNow(doc), ['a1']);
});

function rowsNow(doc) {
  return doc.getElementById('session-list').children.map((row) => row.getAttribute('data-id'));
}

test('a new session is created against the CHOSEN tool own project id', async () => {
  const codexId = 'codex-project-77';
  const dshId = 'dsh-project-88';
  const { doc, app, api } = boot({
    defaults: {
      models: (body) => toolCatalog(body.params.tool,
        body.params.tool === 'codex'
          ? [{ id: codexId, name: 'shared-app', cwd: 'D:\\workspace\\shared' }]
          : [{ id: dshId, name: 'shared-app', cwd: 'd:/workspace/shared/' }]),
      create: ok({ sessionId: 'made-1', tool: 'codex', model: 'm-codex' })
    },
    responses: {
      list: ok({
        sessions: [
          { id: 'a1', tool: 'codex', title: '重构 relay 的转发层', status: 'working', updatedAt: '2026-10-08T03:57:55Z', cwd: 'D:\\workspace\\shared' }
        ],
        capabilities: CAPS
      })
    }
  });
  await app.start();

  // Open the panel prefilled with the codex-flavoured project filter.
  app.setProjectFilter('D:\\workspace\\shared');
  await app.openNewSession({ projectId: 'D:\\workspace\\shared' });

  // Codex is the tool: the select must offer Codex's OWN id for that directory.
  assert.equal(app.newState.tool, 'codex');
  const values = doc.getElementById('project-select').children.map((o) => o.getAttribute('value'));
  assert.deepEqual(values, ['', codexId], 'only this tool\'s real projects may be offered');
  assert.equal(doc.getElementById('project-select').value, codexId,
    'the chosen directory is resolved to the tool\'s own project id');

  doc.getElementById('new-text').value = '开始吧';
  await app.submitNewSession();
  await settle();
  const created = api.callsOf('create')[0].args[0];
  assert.equal(created.params.tool, 'codex');
  assert.equal(created.params.projectId, codexId, 'the id must be the chosen tool\'s, never the other tool\'s');
  assert.ok(created.params.projectId !== dshId);
  assert.equal(created.params.cwd, undefined, 'a real project id never travels with a free cwd');
});

test('switching tool re-resolves the directory against that tool live catalog', async () => {
  const codexId = 'codex-project-77';
  const dshId = 'dsh-project-88';
  const { doc, app, api } = boot({
    defaults: {
      models: (body) => toolCatalog(body.params.tool,
        body.params.tool === 'codex'
          ? [{ id: codexId, name: 'shared-app', cwd: 'D:\\workspace\\shared' }]
          : [{ id: dshId, name: 'shared-app', cwd: 'd:/workspace/shared/' }]),
      create: ok({ sessionId: 'made-2', tool: 'dsh', model: 'm-dsh' })
    }
  });
  await app.start();
  await app.openNewSession({ projectId: 'D:\\workspace\\shared' });
  assert.equal(doc.getElementById('project-select').value, codexId);

  // Switch to DSH: the SAME directory now has to come out as DSH's own id.
  const dshChoice = byAttr(doc, 'data-tool', 'dsh')
    .filter((node) => node.tagName === 'BUTTON')[0];
  assert.ok(dshChoice, 'the DSH tool choice must exist');
  dshChoice.dispatch('click');
  await settle();
  assert.equal(app.newState.tool, 'dsh');
  assert.equal(doc.getElementById('project-select').value, '',
    'the prefill belonged to the other tool, so it is not carried over by id');
  const values = doc.getElementById('project-select').children.map((o) => o.getAttribute('value'));
  assert.deepEqual(values, ['', dshId]);

  // Choosing that directory again resolves it to THIS tool's id, and that is
  // what a create sends.
  doc.getElementById('project-select').value = dshId;
  doc.getElementById('project-select').dispatch('change');
  doc.getElementById('new-text').value = '开始吧';
  await app.submitNewSession();
  await settle();
  const created = api.callsOf('create')[0].args[0];
  assert.equal(created.params.tool, 'dsh');
  assert.equal(created.params.projectId, dshId);
  assert.ok(created.params.projectId !== codexId, 'another tool\'s id must never be reused');
});

test('a project the chosen tool does not have is refused, not silently substituted', async () => {
  const codexId = 'codex-project-77';
  const { doc, app, api } = boot({
    defaults: {
      models: (body) => toolCatalog(body.params.tool,
        body.params.tool === 'codex'
          ? [{ id: codexId, name: 'only-here', cwd: 'D:\\workspace\\only-here' }]
          : [{ id: 'dsh-other', name: 'somewhere-else', cwd: 'D:\\work\\elsewhere' }]),
      create: ok({ sessionId: 'made-3', tool: 'dsh', model: 'm-dsh' })
    }
  });
  await app.start();
  await app.openNewSession();

  // Choose a directory only Codex knows, then switch to DSH: the selection is
  // dropped (the id no longer exists for this tool) and nothing is created on
  // Codex's project by accident.
  doc.getElementById('project-select').value = codexId;
  doc.getElementById('project-select').dispatch('change');
  const dshChoice = byAttr(doc, 'data-tool', 'dsh').filter((node) => node.tagName === 'BUTTON')[0];
  doc.getElementById('new-text').value = 'hi';
  // Force the stale value back into the control the way a hand-edited DOM would.
  dshChoice.dispatch('click');
  await settle();
  assert.equal(doc.getElementById('project-select').value, '',
    'a directory this tool does not have must not stay selected');
  assert.equal(app.newState.projectId, '');

  // And if a stale id somehow reaches submit, no create goes out.
  doc.getElementById('project-select').value = 'codex-project-77';
  await app.submitNewSession();
  await settle();
  assert.deepEqual(api.callsOf('create'), [], 'a project id from another tool must never be submitted');
  // The refusal names the tool the user is actually creating on.
  assert.match(doc.getElementById('new-error').textContent, /不在 DSH 的项目列表里/);
});

// ---------------------------------------------------------------------------
// The 2-second poll must not churn the controls the user is working in
// ---------------------------------------------------------------------------

/** A read result with the pending panels, parameterised so a poll can vary it. */
function readWithPending(overrides) {
  return Object.assign({}, DSH_READ, overrides || {});
}

test('an identical poll keeps the real question controls, the draft and the caret', async () => {
  const { doc, app } = boot();
  await app.start();
  await app.openSession('b2');

  const submitBefore = byAttr(doc, 'data-answer-call', 'call-42')[0];
  const optionBefore = byAttr(doc, 'data-option-label', '重试')[0];
  const customBefore = byAttr(doc, 'data-custom-for', 'q1')[0];
  assert.ok(submitBefore && optionBefore && customBefore);

  // The user is typing in the free-text answer, with the caret in the middle.
  customBefore.value = '先看看日志';
  customBefore.dispatch('input');
  customBefore.focus();
  customBefore.setSelectionRange(3, 3);
  pickOption(doc, '重试');

  for (let i = 0; i < 3; i++) {
    await app.refreshDetail();
  }

  // The very same nodes: nothing was rebuilt, so nothing could lose focus.
  assert.equal(byAttr(doc, 'data-answer-call', 'call-42')[0], submitBefore,
    'an unchanged poll must not rebuild the submit control');
  assert.equal(byAttr(doc, 'data-option-label', '重试')[0], optionBefore,
    'an unchanged poll must not rebuild the options');
  assert.equal(byAttr(doc, 'data-custom-for', 'q1')[0], customBefore,
    'an unchanged poll must not rebuild the answer field');
  assert.equal(doc.activeElement, customBefore, 'focus stays where the user left it');
  assert.equal(customBefore.selectionStart, 3, 'the caret stays where the user left it');
  assert.equal(customBefore.selectionEnd, 3);
  assert.equal(customBefore.value, '先看看日志', 'the half-typed answer survives every poll');
  assert.equal(byAttr(doc, 'data-option-label', '重试')[0].getAttribute('class'),
    'option option-active', 'the chosen option is still pressed');
  // The draft is still the draft: submitting sends exactly what is on screen.
  submitQuestions(doc, 'call-42');
  await new Promise((resolve) => setImmediate(resolve));
  // 重试 (single-select) plus custom text is a contradiction, so this is the
  // honest refusal -- and it proves the poll did not lose either half.
  assert.match(doc.getElementById('questions-list').textContent, /单选只能选一个/);
});

test('a changed native form rebuilds for real, and a form that is gone takes its controls away', async () => {
  const changed = readWithPending({
    pendingQuestions: [{
      callId: 'call-42',
      state: 'open',
      questions: [
        // The same question id with a DIFFERENT option set: a genuinely
        // different native form, which must not be answered with the old labels.
        { id: 'q1', question: '要重试吗？', options: [{ label: '稍后再说' }] },
        { id: 'q2', question: '选哪些文件？', multiSelect: true, options: [{ label: 'a.js' }] }
      ]
    }],
    pendingApprovals: []
  });
  const settled = readWithPending({ pendingQuestions: [], pendingApprovals: [] });
  const { doc, app, api } = boot({ responses: { read: [ok(DSH_READ), ok(changed), ok(settled)] } });
  await app.start();
  await app.openSession('b2');

  pickOption(doc, '重试');
  const customBefore = byAttr(doc, 'data-custom-for', 'q1')[0];
  customBefore.value = '保留我';
  customBefore.dispatch('input');

  // Poll 1: the native form changed, so the card is rebuilt with the REAL
  // options -- the vanished label is gone and cannot be submitted.
  await app.refreshDetail();
  assert.deepEqual(byAttr(doc, 'data-option-label', '重试'), []);
  assert.equal(byAttr(doc, 'data-option-label', '稍后再说').length, 1);
  assert.equal(byAttr(doc, 'data-option-label', 'b.js').length, 0);
  assert.equal(byAttr(doc, 'data-custom-for', 'q1')[0].value, '保留我',
    'the draft the user typed is still there');
  assert.equal(byAttr(doc, 'data-option-label', '稍后再说')[0].getAttribute('class'), 'option',
    'a label the user never chose is not selected by the rebuild');

  // Poll 2: the desktop stopped reporting the batch. Its controls must be GONE,
  // not hidden behind the list where a later tap could still reach them.
  await app.refreshDetail();
  assert.equal(doc.getElementById('questions-panel').hidden, true);
  assert.deepEqual(byAttr(doc, 'data-call-id', 'call-42'), []);
  assert.deepEqual(byAttr(doc, 'data-answer-call', 'call-42'), []);
  assert.deepEqual(api.callsOf('answer'), [], 'nothing was auto-submitted by a poll');
});

test('a stale answer for a batch the desktop has dropped cannot reach the wire', async () => {
  const settled = readWithPending({ pendingQuestions: [], pendingApprovals: [] });
  const { doc, app, api } = boot({ responses: { read: [ok(DSH_READ), ok(settled)] } });
  await app.start();
  await app.openSession('b2');

  // Hold a reference to the submit control the way an in-flight tap would, then
  // let a poll remove the batch underneath it.
  const stale = byAttr(doc, 'data-answer-call', 'call-42')[0];
  pickOption(doc, '重试');
  await app.refreshDetail();
  assert.deepEqual(byAttr(doc, 'data-answer-call', 'call-42'), []);

  // Pressing the now-detached control is validated against the batch list, not
  // against the node, so nothing is submitted.
  stale.dispatch('click');
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(api.callsOf('answer'), []);
});

test('an identical poll does not churn the approval buttons either', async () => {
  const { doc, app } = boot();
  await app.start();
  await app.openSession('b2');

  const allowBefore = harness.queryAll(doc.getElementById('approvals-list'),
    (el) => el.tagName === 'BUTTON' && el.textContent === '仅允许本次')[0];
  const card = byAttr(doc, 'data-approval-id', APPROVAL_ID)[0];
  assert.ok(allowBefore && card);
  allowBefore.focus();

  await app.refreshDetail();
  await app.refreshDetail();

  assert.equal(byAttr(doc, 'data-approval-id', APPROVAL_ID)[0], card,
    'an unchanged poll must not rebuild the approval card');
  const allowAfter = harness.queryAll(doc.getElementById('approvals-list'),
    (el) => el.tagName === 'BUTTON' && el.textContent === '仅允许本次')[0];
  assert.equal(allowAfter, allowBefore, 'the decision buttons keep their identity');
  assert.equal(doc.activeElement, allowBefore, 'focus stays on the button the user was about to press');
  assert.equal(doc.getElementById('approvals-list').textContent.includes('已提交'), false,
    'a poll must never claim a decision was submitted');
});

test('an unchanged poll does not churn the model picker options', async () => {
  const { doc, app } = boot();
  await app.start();
  await app.openSession('b2');
  await settle();
  doc.getElementById('model-chip-button').dispatch('click');

  const inheritRow = byAttr(doc, 'data-model-key', '')[0];
  assert.ok(inheritRow, 'the 沿用当前模型 row must exist');
  inheritRow.focus();
  const before = harness.queryAll(doc.getElementById('model-picker-list'), () => true);

  await app.refreshDetail();
  await app.refreshDetail();

  const after = harness.queryAll(doc.getElementById('model-picker-list'), () => true);
  assert.deepEqual(after, before, 'an unchanged poll must not rebuild the picker rows');
  assert.equal(doc.activeElement, inheritRow, 'focus inside the picker survives the poll');
  assert.equal(doc.getElementById('model-picker').hidden, false,
    'an open picker stays open across a poll');
});

test('admin login shows distinct computer identities, live tool status and explicit enrollment codes', async () => {
  const computers = [
    { clientId: 'pc-a', ownerName: 'Alex', clientName: 'Work PC', online: true,
      lastSeen: '2026-10-11T09:00:00Z', tools: [{ id: 'workbuddy', available: false, reason: '没有可用的现有聊天 API' }] },
    { clientId: 'pc-b', ownerName: 'Alex', clientName: 'Work PC', online: false,
      lastSeen: '2026-10-10T09:00:00Z', tools: [{ id: 'codex', available: true }] }
  ];
  const targets = {
    'pc-a': { sessions: [], capabilities: CAPS },
    'pc-b': { sessions: [], capabilities: CAPS }
  };
  const instance = await enterAdmin({ defaults: {
    adminComputers: ok({ computers }),
    adminRpc: adminRpcFixture(targets)
  } });
  const { doc, app, api } = instance;

  assert.equal(app.state.screen, 'admin-roster');
  assert.equal(doc.getElementById('conn-badge').textContent, '电脑名册已更新',
    'the badge reports roster readiness without implying a computer is selected online');
  const cards = harness.queryAll(doc.getElementById('admin-computer-list'),
    (node) => node.classList.contains('admin-computer-card'));
  assert.equal(cards.length, 2, 'duplicate names remain separate computer cards');
  assert.equal(byAttr(doc, 'data-client-id', 'pc-a').length, 1);
  assert.equal(byAttr(doc, 'data-client-id', 'pc-b')[0].disabled, true,
    'offline computers remain visible but cannot be opened');
  assert.match(doc.getElementById('admin-computer-list').textContent, /WorkBuddy/);
  assert.match(doc.getElementById('admin-computer-list').textContent, /未接入/);
  assert.doesNotMatch(doc.getElementById('admin-computer-list').textContent, /没有可用的现有聊天 API/,
    'technical backend reasons are not repeated in the roster copy');
  const reasonTitle = byAttr(doc, 'title', '没有可用的现有聊天 API');
  assert.equal(reasonTitle.length, 1, 'the raw reason remains available from the WorkBuddy status title');
  const officialLinks = harness.queryAll(doc.getElementById('admin-computer-list'),
    (node) => node.classList.contains('workbuddy-official-link'));
  assert.equal(officialLinks.length, 1);
  assert.equal(officialLinks[0].getAttribute('href'), 'https://www.codebuddy.cn/docs/workbuddyapp/features/Multidevice');
  assert.match(officialLinks[0].textContent, /官方手机端多设备接入说明/);

  chipByLabel(doc, 'admin-tool-filter', 'WorkBuddy').dispatch('click');
  assert.equal(harness.queryAll(doc.getElementById('admin-computer-list'),
    (node) => node.classList.contains('admin-computer-card')).length, 1,
    'the tool filter uses the actual roster tool inventory');
  doc.getElementById('admin-enrollment-button').dispatch('click');
  await settle();
  assert.equal(doc.getElementById('admin-enrollment-result').hidden, false);
  assert.match(doc.getElementById('admin-enrollment-result').textContent, /TEST-ENROLLMENT-CODE/);
  assert.equal(api.callsOf('adminEnrollmentCodes').length, 1,
    'an enrollment code is requested only after the admin button is clicked');

  byAttr(doc, 'data-client-id', 'pc-a')[0].dispatch('click');
  await settle();
  assert.equal(app.state.selectedComputer.clientId, 'pc-a');
  assert.ok(api.callsOf('adminRpc').some((call) => call.args[0].clientId === 'pc-a' && call.args[0].body.method === 'sessions.list'));
  assert.equal(api.callsOf('adminRpc').some((call) => call.args[0].clientId === 'pc-b'), false,
    'the offline target receives no RPC');
});

test('admin login from settings clears the password and never stores credentials', async () => {
  const { doc, app, storage, api } = boot({
    responses: { me: [err('unauthenticated', 'unauthenticated'), ok({ role: 'user', clientId: 'paired-pc', ownerName: 'Pat', clientName: 'Home PC' })] },
    defaults: { adminComputers: ok({ computers: [] }) }
  });
  await app.start();
  await app.selectTab('settings');
  doc.getElementById('settings-admin-login').dispatch('click');
  assert.equal(app.state.screen, 'pair');
  assert.equal(doc.getElementById('admin-login-panel').hidden, false);
  doc.getElementById('admin-username-input').value = 'operator';
  doc.getElementById('admin-password-input').value = 'admin-test-secret';
  doc.getElementById('admin-login-submit').dispatch('click');
  await settle();
  assert.equal(app.state.screen, 'admin-roster');
  assert.equal(doc.getElementById('admin-password-input').value, '');
  assert.equal(Object.values(storage.dump()).join(' ').includes('admin-test-secret'), false);
  assert.equal(Object.values(storage.dump()).join(' ').includes('operator'), false);

  doc.getElementById('admin-logout-button').dispatch('click');
  await settle();
  assert.equal(api.callsOf('adminLogout').length, 1);
  assert.equal(app.state.admin, false);
  assert.equal(app.state.identity.clientId, 'paired-pc');
  assert.equal(app.state.screen, 'settings', 'admin logout returns to the still-paired settings view');
  assert.equal(doc.getElementById('admin-password-input').value, '');
});

test('same session and pending IDs stay isolated by computer; answers and approvals target the selected computer', async () => {
  const capabilities = Object.assign({}, CAPS, {
    'session.answer:dsh': true,
    'session.approve:dsh': true,
    tools: ['dsh']
  });
  function readForTarget(label, choice) {
    return {
      id: 'same-session', tool: 'dsh', title: label, status: 'idle', messages: [], canStop: false,
      pendingQuestions: [{ callId: 'same-call', state: 'open', questions: [{ id: 'same-question', question: label + ' question?', options: [{ label: choice }] }] }],
      pendingApprovals: [{ id: APPROVAL_ID, toolName: 'shell', callId: 'same-approval-call', reason: label + ' permission request' }]
    };
  }
  const targets = {
    'pc-a': { sessions: [{ id: 'same-session', tool: 'dsh', title: 'A list item', status: 'idle' }], capabilities, read: readForTarget('A session', 'A choice'), catalog: DSH_CATALOG },
    'pc-b': { sessions: [{ id: 'same-session', tool: 'dsh', title: 'B list item', status: 'idle' }], capabilities, read: readForTarget('B session', 'B choice'), catalog: DSH_CATALOG }
  };
  const computers = ['pc-a', 'pc-b'].map((clientId) => ({
    clientId, ownerName: clientId, clientName: 'Same name', online: true,
    tools: [{ id: 'dsh', available: true }]
  }));
  const instance = await enterAdmin({ defaults: {
    adminComputers: ok({ computers }),
    adminRpc: adminRpcFixture(targets)
  } });
  const { doc, app, api } = instance;
  byAttr(doc, 'data-client-id', 'pc-a')[0].dispatch('click');
  await settle();
  await app.openSession('same-session');
  doc.getElementById('send-input').value = 'draft from A';
  doc.getElementById('send-input').dispatch('input');
  pickOption(doc, 'A choice');

  doc.getElementById('admin-context-back').dispatch('click');
  await settle();
  byAttr(doc, 'data-client-id', 'pc-b')[0].dispatch('click');
  await settle();
  await app.openSession('same-session');
  assert.equal(doc.getElementById('detail-title').textContent, 'B session');
  assert.equal(doc.getElementById('send-input').value, '', 'A draft is not restored into B');
  assert.match(doc.getElementById('questions-list').textContent, /B session question/);
  assert.doesNotMatch(doc.getElementById('questions-list').textContent, /A session question/);
  assert.equal(byAttr(doc, 'data-option-label', 'B choice')[0].getAttribute('class'), 'option');

  pickOption(doc, 'B choice');
  submitQuestions(doc, 'same-call');
  await settle();
  const answerCalls = api.callsOf('adminRpc').filter((call) => call.args[0].body.method === 'session.answer');
  assert.equal(answerCalls.length, 1);
  assert.equal(answerCalls[0].args[0].clientId, 'pc-b');
  assert.deepEqual(answerCalls[0].args[0].body.params.answers, [{ id: 'same-question', selected: ['B choice'] }]);
  submitQuestions(doc, 'same-call');
  await settle();
  assert.equal(api.callsOf('adminRpc').filter((call) => call.args[0].body.method === 'session.answer').length, 1,
    'one click submits at most one answer for this computer and batch');

  clickApproval(doc, '仅允许本次');
  await settle();
  const approvalCalls = api.callsOf('adminRpc').filter((call) => call.args[0].body.method === 'session.approve');
  assert.equal(approvalCalls.length, 1);
  assert.equal(approvalCalls[0].args[0].clientId, 'pc-b');
  assert.equal(approvalCalls[0].args[0].body.params.approvalId, APPROVAL_ID);
  assert.ok(Object.keys(app.state.drafts).some((key) => key.includes('admin:pc-a')));
  assert.ok(Object.keys(app.state.drafts).some((key) => key.includes('admin:pc-b')));
  assert.ok(Object.keys(app.state.answerDrafts).some((key) => key.includes('admin:pc-a')));
  assert.ok(Object.keys(app.state.answerDrafts).some((key) => key.includes('admin:pc-b')));
});

test('a late response from computer A cannot replace computer B detail with the same session ID', async () => {
  let finishA;
  const targets = {
    'pc-a': { sessions: [{ id: 'same-session', tool: 'dsh', title: 'A item', status: 'idle' }], capabilities: CAPS, catalog: DSH_CATALOG },
    'pc-b': { sessions: [{ id: 'same-session', tool: 'dsh', title: 'B item', status: 'idle' }], capabilities: CAPS,
      read: { id: 'same-session', tool: 'dsh', title: 'B current', status: 'idle', messages: [], pendingQuestions: [], pendingApprovals: [] }, catalog: DSH_CATALOG }
  };
  const handler = adminRpcFixture(targets, (request) => {
    if (request.clientId === 'pc-a' && request.body.method === 'session.read') {
      return;
    }
  });
  const instance = await enterAdmin({ defaults: {
    adminComputers: ok({ computers: ['pc-a', 'pc-b'].map((clientId) => ({ clientId, ownerName: clientId, clientName: 'PC', online: true, tools: [{ id: 'dsh', available: true }] })) }),
    adminRpc: function (request) {
      if (request.clientId === 'pc-a' && request.body.method === 'session.read') {
        return new Promise((resolve) => { finishA = resolve; });
      }
      return handler(request);
    }
  } });
  const { doc, app } = instance;
  byAttr(doc, 'data-client-id', 'pc-a')[0].dispatch('click');
  await settle();
  const lateOpen = app.openSession('same-session');
  await Promise.resolve();
  assert.equal(typeof finishA, 'function');
  doc.getElementById('admin-context-back').dispatch('click');
  await settle();
  byAttr(doc, 'data-client-id', 'pc-b')[0].dispatch('click');
  await settle();
  await app.openSession('same-session');
  assert.equal(doc.getElementById('detail-title').textContent, 'B current');

  finishA(ok({ id: 'same-session', tool: 'dsh', title: 'A late response', status: 'idle', messages: [], pendingQuestions: [], pendingApprovals: [] }));
  await lateOpen;
  assert.equal(doc.getElementById('detail-title').textContent, 'B current');
  assert.equal(app.state.current.scopeKey, 'admin:pc-b');
});

test('WorkBuddy appears by its real tool ID and can create only from the selected target catalog', async () => {
  const capabilities = {
    'sessions.list': true,
    'models.list': true,
    'models.list:workbuddy': true,
    'session.create': true,
    'session.create:workbuddy': true,
    tools: ['workbuddy']
  };
  const catalog = { tool: 'workbuddy', models: [{ id: 'wb-model-1', label: 'WorkBuddy model', provider: 'workbuddy-provider' }], projects: [] };
  const targets = { 'workbuddy-pc': { sessions: [], capabilities, catalogs: { workbuddy: catalog }, createResult: { sessionId: 'new-wb', tool: 'workbuddy', title: 'WorkBuddy session' } } };
  const instance = await enterAdmin({ defaults: {
    adminComputers: ok({ computers: [{ clientId: 'workbuddy-pc', ownerName: 'Jo', clientName: 'Laptop', online: true, tools: [{ id: 'workbuddy', available: true }] }] }),
    adminRpc: adminRpcFixture(targets)
  } });
  const { doc, app, api } = instance;
  byAttr(doc, 'data-client-id', 'workbuddy-pc')[0].dispatch('click');
  await settle();
  await app.openNewSession();
  await settle();
  const button = byAttr(doc, 'data-tool', 'workbuddy').filter((node) => node.tagName === 'BUTTON')[0];
  assert.ok(button);
  assert.equal(button.textContent, 'WorkBuddy');
  assert.equal(button.disabled, false);
  assert.match(doc.getElementById('model-select').textContent, /WorkBuddy model/);
  await app.submitNewSession();
  const create = api.callsOf('adminRpc').filter((call) => call.args[0].body.method === 'session.create')[0];
  assert.ok(create);
  assert.equal(create.args[0].clientId, 'workbuddy-pc');
  assert.equal(create.args[0].body.params.tool, 'workbuddy');
  assert.equal(create.args[0].body.params.model, 'wb-model-1');
});

test('an explicitly unavailable WorkBuddy adapter shows the backend reason and sends no model or create request', async () => {
  const capabilities = {
    'sessions.list': true,
    'models.list': true,
    'models.list:workbuddy': true,
    'session.create': true,
    'session.create:workbuddy': true,
    tools: ['workbuddy'],
    toolStatus: { workbuddy: { available: false, reason: 'WorkBuddy host connection is not attached.' } }
  };
  const targets = { 'workbuddy-pc': { sessions: [], capabilities } };
  const instance = await enterAdmin({ defaults: {
    adminComputers: ok({ computers: [{ clientId: 'workbuddy-pc', ownerName: 'Jo', clientName: 'Laptop', online: true,
      tools: [{ id: 'workbuddy', available: false, reason: 'WorkBuddy host connection is not attached.' }] }] }),
    adminRpc: adminRpcFixture(targets)
  } });
  const { doc, app, api } = instance;
  byAttr(doc, 'data-client-id', 'workbuddy-pc')[0].dispatch('click');
  await settle();
  await app.openNewSession();

  const button = byAttr(doc, 'data-tool', 'workbuddy').filter((node) => node.tagName === 'BUTTON')[0];
  assert.ok(button);
  assert.equal(button.textContent, 'WorkBuddy');
  assert.equal(button.disabled, true);
  assert.equal(doc.getElementById('new-availability').hidden, true,
    'the fallback card replaces the technical availability banner');
  const officialHelp = doc.getElementById('workbuddy-official-help');
  assert.equal(officialHelp.hidden, false);
  assert.equal(officialHelp.textContent, 'WorkBuddy 暂未接入此工作台。可在官方手机 App 登录与电脑相同的账号，继续已有聊天。查看 WorkBuddy 官方手机端多设备接入说明');
  assert.equal(officialHelp.getAttribute('title'), 'WorkBuddy host connection is not attached.',
    'the raw backend reason is available once as a title, not repeated in the product copy');
  assert.doesNotMatch(officialHelp.textContent, /原生|接口|伪造|API/);
  assert.equal(doc.getElementById('new-native-controls').hidden, true,
    'unavailable WorkBuddy has no visible model or fake chat creation controls');
  assert.equal(harness.queryAll(officialHelp,
    (node) => node.getAttribute && node.getAttribute('href') === 'https://www.codebuddy.cn/docs/workbuddyapp/features/Multidevice').length, 1);
  const methods = api.callsOf('adminRpc').map((call) => call.args[0].body.method);
  assert.equal(methods.includes('models.list'), false);
  assert.equal(methods.includes('session.create'), false);
});

test('read-only WorkBuddy history stays browsable without send, stop, model, create, answer or approval actions', async () => {
  const capabilities = {
    'sessions.list': true,
    'session.read': true,
    'session.send': true,
    'session.send:workbuddy': false,
    'session.stop': true,
    'stop:workbuddy': false,
    'models.list': true,
    'models.list:workbuddy': false,
    'session.create': true,
    'session.create:workbuddy': false,
    'session.answer': true,
    'session.answer:workbuddy': false,
    'session.approve': true,
    'session.approve:workbuddy': false,
    tools: ['workbuddy']
  };
  const read = {
    id: 'saved-chat', tool: 'workbuddy', title: 'Saved WorkBuddy chat', status: 'working', canStop: true,
    messages: [
      { id: 'wb-user', role: 'user', text: '整理这段历史记录', timestamp: '2026-10-11T08:00:00Z' },
      { id: 'wb-answer', role: 'assistant', text: '已完成 **整理**。', timestamp: '2026-10-11T08:00:03Z' },
      { id: 'wb-tool', role: 'tool', text: '读取本地会话记录', timestamp: '2026-10-11T08:00:02Z' }
    ],
    pendingQuestions: [], pendingApprovals: []
  };
  const computer = {
    clientId: 'workbuddy-readonly-pc', ownerName: 'Jo', clientName: 'Laptop', online: true,
    capabilities,
    tools: [{ id: 'workbuddy', available: true }]
  };
  const targets = {
    [computer.clientId]: {
      sessions: [{ id: read.id, tool: 'workbuddy', title: read.title, status: 'working' }],
      capabilities,
      read
    }
  };
  const instance = await enterAdmin({ defaults: {
    adminComputers: ok({ computers: [computer] }),
    adminRpc: adminRpcFixture(targets)
  } });
  const { doc, app, api } = instance;
  const open = byAttr(doc, 'data-client-id', computer.clientId)[0];
  const card = harness.queryAll(doc.getElementById('admin-computer-list'),
    (node) => node.classList.contains('admin-computer-card'))[0];
  assert.ok(card);
  assert.match(card.textContent, /WorkBuddy只读/, 'the ready adapter is distinguishable from an unavailable app');

  open.dispatch('click');
  await settle();
  assert.equal(app.state.sessions[0].title, 'Saved WorkBuddy chat');
  assert.equal(app.state.sessions[0].tool, 'workbuddy');
  assert.match(byAttr(doc, 'data-id', 'saved-chat')[0].textContent, /只读/,
    'the conversation list marks read-only tools using the selected target capability');
  await app.openSession('saved-chat');
  assert.equal(doc.getElementById('detail-title').textContent, 'Saved WorkBuddy chat');
  assert.match(doc.getElementById('message-list').textContent, /已完成 \*\*整理\*\*/,
    'historical messages use the ordinary readable conversation renderer');
  assert.equal(doc.getElementById('composer').hidden, true);
  assert.equal(doc.getElementById('workbuddy-readonly-note').hidden, false);
  assert.equal(doc.getElementById('workbuddy-readonly-text').textContent,
    '可查看本机会话；续聊和授权操作暂未接入。');
  assert.equal(doc.getElementById('workbuddy-readonly-link').getAttribute('href'),
    'https://www.codebuddy.cn/docs/workbuddyapp/features/Multidevice');
  assert.equal(doc.getElementById('questions-panel').hidden, true,
    'historical message text does not become an AI question form');
  assert.equal(doc.getElementById('approvals-panel').hidden, true,
    'historical message text does not become a permission approval');

  await app.sendMessage('do not send');
  await app.stopSession();
  await app.submitAnswer(app.state.current, { callId: 'fake-call', questions: [] });
  await app.submitApproval(app.state.current,
    { id: 'fake-approval', toolName: 'shell', reason: 'historical text' }, 'allow-once');
  await app.openNewSession();
  await settle();
  assert.equal(doc.getElementById('new-native-controls').hidden, true,
    'read-only WorkBuddy does not display model or creation controls');
  assert.equal(doc.getElementById('workbuddy-official-help').hidden, false);
  assert.equal(doc.getElementById('workbuddy-official-help-text').textContent,
    '可查看本机会话；续聊和授权操作暂未接入。');
  const methods = api.callsOf('adminRpc').map((call) => call.args[0].body.method);
  assert.ok(methods.every((method) => method === 'sessions.list' || method === 'session.read'),
    'the read-only adapter receives no send, stop, model, create, answer or approval RPC');
});

test('a per-tool WorkBuddy send grant overrides a false shared default', async () => {
  const capabilities = {
    'sessions.list': true,
    'session.read': true,
    'session.send': false,
    'session.send:workbuddy': true,
    'models.list': false,
    'session.create': false,
    tools: ['workbuddy']
  };
  const read = {
    id: 'writable-chat', tool: 'workbuddy', title: 'Writable WorkBuddy chat', status: 'idle',
    messages: [], pendingQuestions: [], pendingApprovals: []
  };
  const { doc, app, api } = boot({
    responses: {
      list: ok({ sessions: [{ id: read.id, tool: 'workbuddy', title: read.title, status: 'idle' }], capabilities }),
      read: [ok(read), ok(read)]
    }
  });
  await app.start();
  await app.openSession(read.id);
  assert.equal(doc.getElementById('composer').hidden, false,
    'the explicit per-tool capability enables WorkBuddy writing even when the generic default is false');
  await app.sendMessage('续聊已获支持');
  assert.equal(api.callsOf('send').length, 1);
  assert.deepEqual(api.callsOf('send')[0].args[0], {
    method: 'session.send', params: { tool: 'workbuddy', sessionId: read.id, text: '续聊已获支持' }
  });
});
