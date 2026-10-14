'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { randomUUID } = require('node:crypto');
const { WorkBuddyBackground } = require('../src/workbuddy-native/background');
const ID = '2044490a-c920-43cc-868f-1e470bb3f567';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-background-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const cwd = path.join(root, 'project'); fs.mkdirSync(cwd);
  let owner = 'same-owner'; const writes = []; const clients = []; const messages = new Map([[ID, []]]);
  const native = { id: ID, cwd, user_id: 'same-owner', title: 'Native fixture', status: 'completed', model: 'fixture-model' };
  class FakeClient extends EventEmitter {
    constructor(options) { super(); this.options = options; this.status = 'idle'; this.closed = false; this.permissions = new Map(); this.currentModel = 'fixture-model'; this.turnId = randomUUID(); }
    async initialize() { return { accountMatches: true, models: [{ id: 'fixture-model', label: 'Fixture', isDefault: true }] }; }
    async send(text) { this.status = 'working'; this.turnId = randomUUID(); const array = messages.get(this.options.sessionId) || []; array.push({ role: 'user', text }); messages.set(this.options.sessionId, array); }
    close() { this.closed = true; }
    decide(handle, response) { if (!this.permissions.has(handle) || this.closed || this.status !== 'working') { const e = new Error('gone'); e.code = 'not_capable'; throw e; } writes.push(response); this.permissions.delete(handle); return { state: 'submitted' }; }
    async stop() { this.stopped = true; }
    complete() { this.status = 'idle'; this.terminal = { is_error: false }; this.permissions.clear(); this.emit('terminal', this.terminal); }
  }
  const adapter = { configDir: root, redactCliTitle: (value, limit = 180) => String(value).replace(/Bearer \S+/g, 'Bearer [REDACTED]').slice(0, limit),
    db: { prepare(sql) { assert.match(sql, /^SELECT /); return { all: () => [native], get: id => id === ID ? native : null }; } },
    readSession(id) { if (!messages.has(id)) throw new Error('not persisted'); return { id, tool: 'workbuddy', title: 'Fixture', status: 'unknown', canStop: false, messages: messages.get(id) }; } };
  const background = new WorkBuddyBackground({ adapter, indexFile: path.join(root, 'own-index.json'), identity: () => owner,
    credentials: () => ({ userId: owner, token: 'fixture-secret-not-shared' }), clientFactory: options => { const client = new FakeClient(options); clients.push(client); return client; } });
  t.after(() => background.close());
  return { background, native, cwd, root, clients, writes, adapter, changeOwner: value => { owner = value; } };
}

test('existing projects and authenticated model IDs are used; arbitrary cwd is refused before creating a process', async t => {
  const f = fixture(t); const catalog = await f.background.listModels();
  assert.equal(catalog.projects[0].cwd, f.cwd);
  const count = f.clients.length;
  await assert.rejects(f.background.create({ model: 'fixture-model', text: 'new', cwd: f.root }, {}, {}), { code: 'invalid_params' });
  assert.equal(f.clients.length, count);
  const created = await f.background.create({ model: 'fixture-model', text: 'new', projectId: catalog.projects[0].id }, {}, {});
  assert.equal(created.partial, false);
  assert.equal(f.background.row(created.sessionId).cwd, f.cwd);
  assert.equal(f.native.id, ID); // Native metadata was only read.
});

test('a different desktop owner or a native running turn cannot be resumed', async t => {
  const f = fixture(t); f.changeOwner('other-owner');
  await assert.rejects(f.background.send(ID, 'no write', {}, {}), { code: 'session_not_found' });
  assert.equal(f.clients.length, 0);
  f.changeOwner('same-owner'); f.native.status = 'working';
  await assert.rejects(f.background.send(ID, 'no write', {}, {}), /already running/);
  assert.equal(f.clients.length, 0);
});

test('a desktop-selected workspace with no session can be selected for a new background chat', async t => {
  const f = fixture(t); const cwd = path.join(f.root, 'lifebot'); fs.mkdirSync(cwd);
  const metadata = path.join(f.root, 'storage', 'device', 'scoped', 'c7389fe09fa872c0');
  fs.mkdirSync(metadata, { recursive: true });
  fs.writeFileSync(path.join(metadata, 'newTaskWorkspace.json'), JSON.stringify({ '__home__:same-owner:anonymous': { cwd } }));
  const catalog = await f.background.listModels();
  const project = catalog.projects.find(item => item.cwd === cwd);
  assert.ok(project);
  const created = await f.background.create({ model: 'fixture-model', text: 'test', projectId: project.id }, {}, {});
  assert.equal(f.background.row(created.sessionId).cwd, cwd);
  assert.equal(f.clients.at(-1).options.cwd, cwd);
});

test('one live writer per project, even when two different conversation IDs are requested', async t => {
  const f = fixture(t); const catalog = await f.background.listModels();
  const input = { model: 'fixture-model', text: 'first', projectId: catalog.projects[0].id };
  const first = await f.background.create(input, {}, {});
  await assert.rejects(f.background.create({ ...input, text: 'second' }, {}, {}), /already running/);
  const live = f.background.entries.get(first.sessionId).client;
  live.complete();
  const second = await f.background.create({ ...input, text: 'second' }, {}, {});
  assert.notEqual(second.sessionId, first.sessionId);
});

test('question options, typed answers and stale handles are validated against the real pending request', async t => {
  const f = fixture(t); await f.background.send(ID, 'ask', {}, {});
  const entry = f.background.entries.get(ID); const handle = randomUUID();
  const request = { tool_name: 'AskUserQuestion', input: { questions: [{ question: 'Which animal?', header: 'Animal', options: [{ label: 'Cat' }, { label: 'Dog' }], multiSelect: false }] } };
  entry.client.permissions.set(handle, { request, turnId: entry.client.turnId });
  entry.client.emit('permission', { handle, request });
  const snapshot = f.background.snapshot(ID, f.adapter.readSession(ID));
  assert.equal(snapshot.pendingQuestions[0].callId, handle); assert.equal(snapshot.canStop, true);
  assert.throws(() => f.background.answer(ID, handle, [{ id: 'q-0', selected: ['Bird'] }]), { code: 'invalid_params' });
  assert.equal(f.writes.length, 0);
  const result = f.background.answer(ID, handle, [{ id: 'q-0', selected: [], custom: 'Bird' }]);
  assert.equal(result.state, 'submitted'); assert.equal(f.writes[0].updatedInput.answers['Which animal?'], 'Bird');
  assert.throws(() => f.background.answer(ID, handle, [{ id: 'q-0', selected: ['Cat'] }]), { code: 'not_capable' });
});

test('permission cards carry complete commands; explicit once and rejection do not change future policy', async t => {
  const f = fixture(t); await f.background.send(ID, 'permission fixture', {}, {});
  const entry = f.background.entries.get(ID);
  for (const decision of ['allow-once', 'reject']) {
    const handle = randomUUID(); const request = { tool_name: 'PowerShell', tool_use_id: 'one-call', input: { command: 'Write-Output harmless-fixture' }, permission_suggestions: [{ mode: 'bypassPermissions' }] };
    entry.client.permissions.set(handle, { request }); entry.client.emit('permission', { handle, request });
    const card = f.background.snapshot(ID, f.adapter.readSession(ID)).pendingApprovals[0];
    assert.equal(card.context.command, request.input.command); assert.equal(card.context.cwd, f.cwd);
    f.background.approve(ID, handle, decision);
    assert.equal(f.writes.at(-1).allowed, decision === 'allow-once');
    if (decision === 'allow-once') assert.deepEqual(f.writes.at(-1).updatedInput, request.input);
    assert.equal(Object.hasOwn(f.writes.at(-1), 'permission_suggestions'), false);
  }
});

test('unsupported or credential-bearing requests are denied and never displayed as truncated authorization', async t => {
  const f = fixture(t); await f.background.send(ID, 'permission fixture', {}, {}); const entry = f.background.entries.get(ID);
  for (const request of [{ tool_name: 'UnknownAuthority', input: {} }, { tool_name: 'Bash', input: { command: 'echo Bearer fixture-token' } }]) {
    const handle = randomUUID(); entry.client.permissions.set(handle, { request }); entry.client.emit('permission', { handle, request });
    assert.equal(f.writes.at(-1).allowed, false); assert.equal(entry.pending.has(handle), false);
  }
});

test('cancellation before sending retires the owned process and releases its project lock', async t => {
  const f = fixture(t); await f.background.listModels(); let checks = 0;
  const hooks = { checkActive() { checks++; if (checks >= 3) throw new Error('request canceled'); } };
  await assert.rejects(f.background.send(ID, 'not sent', {}, hooks), /request canceled/);
  assert.equal(f.background.busyCwds.size, 0);
  assert.equal(f.adapter.readSession(ID).messages.length, 0);
});
