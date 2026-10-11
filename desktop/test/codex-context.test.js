'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const { discoverCodexContext, resolveCodexContext } = require('../src/codex-context');
const { CodexAdapter } = require('../src/adapters/codex');
const { PipeServer, CODEX_APP_TOOLS } = require('./helpers/codex-pipe-server');

function createIndex(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-remote-codex-context-'));
  const file = path.join(directory, 'state_5.sqlite');
  const db = new DatabaseSync(file);
  db.exec(`
    CREATE TABLE threads (
      id TEXT, source TEXT, thread_source TEXT, originator TEXT,
      archived INTEGER, agent_role TEXT, agent_path TEXT,
      updated_at_ms INTEGER, title TEXT, preview TEXT
    )
  `);
  const insert = db.prepare(`
    INSERT INTO threads (id, source, thread_source, originator, archived, agent_role, agent_path, updated_at_ms, title, preview)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  t.after(() => {
    try { db.close(); } catch { /* already closed */ }
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return { db, file, insert };
}

const THREAD_IDS = Object.freeze({
  oldLocal: '00000000-0000-7000-8000-000000000001',
  latestLocal: '00000000-0000-7000-8000-000000000002',
  archived: '00000000-0000-7000-8000-000000000003',
  cloud: '00000000-0000-7000-8000-000000000004',
  cli: '00000000-0000-7000-8000-000000000005',
  subagent: '00000000-0000-7000-8000-000000000006',
  agentCreated: '00000000-0000-7000-8000-000000000007',
  agentMarked: '00000000-0000-7000-8000-000000000008',
});

function row(insert, {
  id,
  source = 'vscode',
  threadSource = 'user',
  originator = 'Codex Desktop',
  archived = 0,
  agentRole = null,
  agentPath = null,
  updatedAt = 1,
}) {
  insert.run(id, source, threadSource, originator, archived, agentRole, agentPath, updatedAt, 'private title', 'private preview');
}

test('read-only metadata discovery selects the newest unarchived local user thread and excludes remote or agent records', (t) => {
  const { db, file, insert } = createIndex(t);
  row(insert, { id: THREAD_IDS.oldLocal, updatedAt: 100 });
  row(insert, { id: THREAD_IDS.latestLocal, updatedAt: 500 });
  row(insert, { id: THREAD_IDS.archived, updatedAt: 1200, archived: 1 });
  row(insert, { id: THREAD_IDS.cloud, updatedAt: 1100, source: 'chatgpt' });
  row(insert, { id: THREAD_IDS.cli, updatedAt: 1000, originator: 'Codex CLI' });
  row(insert, { id: THREAD_IDS.subagent, updatedAt: 900, source: '{"subagent":true}', threadSource: 'subagent', agentPath: './agent' });
  row(insert, { id: THREAD_IDS.agentCreated, updatedAt: 800, threadSource: 'agent_created_thread' });
  row(insert, { id: THREAD_IDS.agentMarked, updatedAt: 700, agentRole: 'worker' });
  row(insert, { id: 'not-a-real-thread-id', updatedAt: 600 });
  db.close();

  const before = fs.statSync(file);
  const result = discoverCodexContext({ databasePath: file });
  const after = fs.statSync(file);
  assert.deepEqual(result, { contextThreadId: THREAD_IDS.latestLocal, reason: null });
  assert.equal(after.size, before.size);
  assert.equal(after.mtimeMs, before.mtimeMs, 'opening the native index must not write to it');
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ['state_5.sqlite'], 'read-only lookup creates no journal or sidecar files');
});

test('no eligible record leaves Codex unavailable with a clear setup direction', (t) => {
  const { db, file, insert } = createIndex(t);
  row(insert, { id: THREAD_IDS.archived, archived: 1 });
  db.close();
  const result = discoverCodexContext({ databasePath: file });
  assert.equal(result.contextThreadId, null);
  assert.match(result.reason, /本机 Codex 对话上下文/);
});

test('explicit configuration and environment context ids take precedence over metadata discovery', () => {
  let discoveryCalls = 0;
  const discover = () => { discoveryCalls += 1; return { contextThreadId: THREAD_IDS.latestLocal, reason: null }; };
  assert.equal(resolveCodexContext({ configured: 'configured-context', env: { CODEX_THREAD_ID: 'env-context' }, discover }).contextThreadId, 'configured-context');
  assert.equal(discoveryCalls, 0);
  assert.equal(resolveCodexContext({ env: { CODEX_THREAD_ID: 'env-context' }, discover }).contextThreadId, 'env-context');
  assert.equal(resolveCodexContext({ env: { CODEX_SESSION_ID: 'session-context' }, discover }).contextThreadId, 'session-context');
  assert.equal(resolveCodexContext({ env: {}, discover }).contextThreadId, THREAD_IDS.latestLocal);
  assert.equal(discoveryCalls, 1);
});

test('the adapter uses the discovered context while only probing the real app-tools catalog', async (t) => {
  const { db, file, insert } = createIndex(t);
  row(insert, { id: THREAD_IDS.latestLocal, updatedAt: 50 });
  db.close();
  const server = new PipeServer({ tools: CODEX_APP_TOOLS });
  await server.listen();
  t.after(() => server.close());

  const adapter = await CodexAdapter.open({
    pipePath: server.pipePath,
    candidates: [server.pipePath],
    contextEnv: {},
    contextDiscovery: { databasePath: file },
  });
  t.after(() => adapter.close());

  assert.equal(adapter.contextThreadId, THREAD_IDS.latestLocal);
  assert.deepEqual(server.calls.map((call) => call.method), ['tools/list']);
});
