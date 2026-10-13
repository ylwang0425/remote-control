'use strict';
/**
 * Tests for the Codex Desktop adapter.
 *
 * The peer is a real Windows named pipe served by `helpers/codex-pipe-server.js`,
 * so these tests prove the adapter speaks the app-tools wire protocol
 * (4-byte length prefix + JSON-RPC, with the tool answer JSON inside a JSON
 * string) over a real pipe. The fixtures mirror the shapes the live pipe really
 * returns, which were recorded read-only into `docs/evidence/` (counts and field
 * names only, never message text).
 *
 * What is mocked here, and only here: the Codex app itself. The framing, the
 * socket, the double JSON parse and every mapping decision are real.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { PipeServer, inner, CODEX_APP_TOOLS, LIST_PROJECTS_TOOL, SEND_WITH_MODEL_TOOL } = require('./helpers/codex-pipe-server');
const {
  discoverCodexPipes,
  pickPipe,
  CodexPipeClient,
  CodexAdapter,
  mapThreadStatus,
  itemsToMessages,
  localProjects,
  PIPE_MAX_FRAME_BYTES,
  READ_TURN_LIMIT,
  MAX_OUTPUT_CHARS_PER_ITEM,
} = require('../src/adapters/codex');

/**
 * The live `list_projects` answer, in the shape this host really returns
 * (`{schemaVersion:2, projects:[{projectId, projectKind, label, path, hostId,
 * isGitRepository}]}`). The five labels are the ones the live answer carries and
 * the ids are synthetic stand-ins of the same form - no real id is written into
 * `src/`, and the mapping must not depend on any particular value.
 */
const LIST_PROJECTS = {
  schemaVersion: 2,
  projects: [
    {
      projectId: 'c49702d7-0af5-4eba-bef8-a74582276dd3',
      projectKind: 'local',
      label: 'remote-control',
      path: 'D:\\workspace\\codex-workspace\\remote-control',
      hostId: 'local',
      isGitRepository: true,
    },
    {
      projectId: '9c1d2e3f-4a5b-4c6d-8e7f-0a1b2c3d4e5f',
      projectKind: 'local',
      label: 'ai-connect',
      path: 'D:\\workspace\\codex-workspace\\ai-connect',
      hostId: 'local',
      isGitRepository: true,
    },
    {
      projectId: '1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d',
      projectKind: 'local',
      label: 'inception-plan-1',
      path: 'D:\\workspace\\inception-plan-1',
      hostId: 'local',
      isGitRepository: false,
    },
    {
      projectId: '2b3c4d5e-6f70-4a8b-9cad-1e2f3a4b5c6d',
      projectKind: 'local',
      label: 'agent-learn',
      path: 'D:\\workspace\\agent-learn',
      hostId: 'local',
      isGitRepository: true,
    },
    {
      projectId: '3c4d5e6f-7081-4a9b-8dae-2f3a4b5c6d7e',
      projectKind: 'local',
      label: 'lifebot',
      path: 'D:\\workspace\\lifebot',
      hostId: 'local',
      isGitRepository: false,
    },
    // Not this computer, so never offered for a new chat.
    {
      projectId: '4d5e6f70-8192-4aab-9cbf-3a4b5c6d7e8f',
      projectKind: 'cloud',
      label: 'A ChatGPT cloud project',
      path: null,
      hostId: 'chatgpt',
      isGitRepository: false,
    },
    {
      projectId: '5e6f7081-92a3-4abc-8dc0-4b5c6d7e8f90',
      projectKind: 'local',
      label: 'A project on another machine',
      path: '\\\\other-pc\\share\\work',
      hostId: 'other-host',
      isGitRepository: false,
    },
  ],
};

/** A `list_threads` answer shaped exactly like the live one. */
const LIST_THREADS = {
  schemaVersion: 1,
  threads: [
    {
      id: '01a1193c-1111-7b40-8f81-269595d36edf',
      kind: 'codex',
      projectId: 'p-1',
      hostId: 'local',
      status: 'active',
      cwd: 'D:\\workspace\\codex-workspace\\remote-control',
      updatedAt: '2026-10-08T05:12:00.000Z',
      title: 'Wire the bridge',
      summary: 'summary text',
      isUnread: false,
    },
    {
      id: '01a1193c-2222-7b40-8f81-269595d36edf',
      kind: 'codex',
      projectId: 'p-1',
      hostId: 'local',
      status: 'idle',
      cwd: null,
      updatedAt: '2026-10-08T04:00:00.000Z',
      title: 'Older thread',
      summary: '',
      isUnread: false,
    },
  ],
  pinnedThreads: [],
  sections: [],
};

/** A `read_thread` answer shaped exactly like the live one (one in-progress turn). */
const READ_THREAD = {
  schemaVersion: 1,
  thread: {
    id: '01a1197c-37b6-7b40-8f81-269595d36edf',
    kind: 'codex',
    hostId: 'local',
    title: 'Live thread',
    preview: 'preview',
    status: 'active',
    cwd: 'D:\\workspace',
    createdAt: '2026-10-08T04:00:00.000Z',
    updatedAt: '2026-10-08T05:12:00.000Z',
  },
  page: { order: 'newest', limit: 100, nextCursor: null, hasMore: false },
  turns: [
    {
      id: 'turn-1',
      status: 'inProgress',
      error: null,
      startedAt: '2026-10-08T05:00:00.000Z',
      completedAt: null,
      durationMs: 1000,
      items: [
        { type: 'userMessage', id: 'it-1', content: 'please continue' },
        { type: 'agentMessage', id: 'it-2', text: 'working on it', phase: 'final' },
        { type: 'reasoning', id: 'it-3', summary: 'thinking about the design' },
        { type: 'commandExecution', id: 'it-4', command: 'node --test', cwd: 'D:\\w', status: 'completed', exitCode: 0, durationMs: 42 },
        { type: 'mcpToolCall', id: 'it-5', server: 'codex_app', tool: 'list_threads', arguments: {}, status: 'completed', durationMs: 5 },
        { type: 'fileChange', id: 'it-6', status: 'applied', changes: [{ path: 'src/a.js' }] },
        { type: 'webSearch', id: 'it-7', query: 'rfc 6455', action: 'search' },
      ],
    },
  ],
};

/**
 * The live shape of a prompt sent from the phone, read-only from this host.
 *
 * A phone-created or phone-sent prompt does **not** arrive as a `userMessage`:
 * it lands in the thread as a real native `functionCallOutput` item whose text
 * is a `<codex_delegation>` wrapper around the prompt. `source_thread_id` names
 * the session that delegated the work, never anything the user typed. The prompt
 * literals below are synthetic stand-ins of the same form as the recorded ones -
 * no real user text is copied into the repository.
 */
const DELEGATION_TOOL = {
  name: 'send_message_to_thread',
  namespace: 'codex_app',
  description: 'Send a message',
  inputSchema: { type: 'object', properties: { threadId: { type: 'string' }, prompt: { type: 'string' } } },
};

/** One native wrapper exactly as the app writes it (leading newline after the tag). */
function delegationWrapper(sourceThreadId, input) {
  return `<codex_delegation>\n  <source_thread_id>${sourceThreadId}</source_thread_id>\n  <input>${input}</input>\n</codex_delegation>`;
}

/**
 * A `read_thread` answer shaped exactly like the live one for a thread the phone
 * has driven: `page.order` is `newest_first`, and each phone prompt is a
 * `functionCallOutput` item that exists **only** because `includeOutputs` was
 * asked for. The first entry is an ordinary native user message, which must keep
 * working exactly as before.
 */
const DELEGATION_READ_THREAD = {
  schemaVersion: 1,
  thread: {
    id: '01a120cb-8e36-7860-ac06-d913537ced33',
    kind: 'codex',
    hostId: 'local',
    title: 'Phone-driven thread',
    preview: '',
    status: { type: 'idle' },
    cwd: 'D:\\workspace\\codex-workspace\\remote-control',
    createdAt: 1791551573,
    updatedAt: 1791552124,
  },
  page: { order: 'newest_first', limit: 3, nextCursor: null, hasMore: false },
  turns: [
    {
      id: 'turn-newest',
      status: 'completed',
      startedAt: 1791552100,
      completedAt: 1791552124,
      items: [
        {
          type: 'functionCallOutput',
          id: 'item-third',
          name: 'send_message_to_thread',
          namespace: 'codex_app',
          output: { text: delegationWrapper('01a1197c-37b6-7b40-8f81-269595d36edf', 'third prompt'), truncated: false },
        },
        { type: 'agentMessage', id: 'item-third-reply', text: 'third answer', phase: 'final' },
      ],
    },
    {
      id: 'turn-middle',
      status: 'completed',
      startedAt: 1791552000,
      completedAt: 1791552010,
      items: [
        {
          type: 'functionCallOutput',
          id: 'item-second',
          name: 'create_thread',
          namespace: 'codex_app',
          output: { text: delegationWrapper('01a1197c-37b6-7b40-8f81-269595d36edf', 'second prompt'), truncated: false },
        },
        { type: 'agentMessage', id: 'item-second-reply', text: 'second answer', phase: 'final' },
      ],
    },
    {
      id: 'turn-oldest',
      status: 'completed',
      startedAt: 1791551500,
      completedAt: 1791551520,
      items: [
        { type: 'userMessage', id: 'item-first', content: 'first prompt' },
        { type: 'agentMessage', id: 'item-first-reply', text: 'first answer', phase: 'final' },
      ],
    },
  ],
};

async function startPipe(options = {}) {
  const tools = options.tools ?? CODEX_APP_TOOLS;
  const handlers = {
    list_threads: () => inner(options.listThreads ?? LIST_THREADS),
    read_thread: (args) => inner(typeof options.readThread === 'function' ? options.readThread(args) : (options.readThread ?? READ_THREAD)),
    send_message_to_thread: (args) => inner({ accepted: true, threadId: args.threadId }),
    create_thread: () => inner({ threadId: 'a-brand-new-thread' }),
    list_projects: () => inner(options.listProjects ?? { schemaVersion: 2, projects: [] }),
    ...options.handlers,
  };
  const server = new PipeServer({ tools, handlers });
  await server.listen();
  return server;
}

test('discovery finds codex-browser-use pipes and does not need the env variable', () => {
  const pipes = [
    'codex-ipc',
    'codex-browser-use-1bcdeebe-173b-40c2-87b9-bed8883d8976',
    'codex-browser-use-02dc1ce2-8a7d-4b33-86b8-be81546c81a1',
    'OpenAI.CodexSandbox.OpenAI.Codex_2p2nqsd0c76g0',
    'something-else',
  ];
  assert.deepEqual(discoverCodexPipes(pipes), [
    'codex-browser-use-02dc1ce2-8a7d-4b33-86b8-be81546c81a1',
    'codex-browser-use-1bcdeebe-173b-40c2-87b9-bed8883d8976',
  ]);
  assert.deepEqual(discoverCodexPipes([]), []);
});

test('pipe choice prefers the configured path, then the env variable, then discovery', () => {
  const discovered = ['codex-browser-use-aaa', 'codex-browser-use-bbb'];
  assert.equal(
    pickPipe({ configuredPath: '\\\\.\\pipe\\mine', envPath: '\\\\.\\pipe\\env-one', discovered }),
    '\\\\.\\pipe\\mine',
  );
  assert.equal(pickPipe({ envPath: '\\\\.\\pipe\\env-one', discovered }), '\\\\.\\pipe\\env-one');
  assert.equal(pickPipe({ discovered }), '\\\\.\\pipe\\codex-browser-use-aaa');
  assert.equal(pickPipe({ discovered: [] }), null);
});

test('the pipe frame limit is the 8 MiB the app-tools server really uses', () => {
  assert.equal(PIPE_MAX_FRAME_BYTES, 8 * 1024 * 1024);
});

test('a real named pipe answers tools/list, and the adapter reads the catalog', async (t) => {
  const server = await startPipe();
  t.after(() => server.close());
  const client = new CodexPipeClient({ pipePath: server.pipePath });
  t.after(() => client.close());
  const tools = await client.listTools({ threadStartKind: 'all' });
  assert.equal(tools.length, 4);
  assert.deepEqual(tools.map((tool) => tool.name), [
    'list_threads',
    'read_thread',
    'send_message_to_thread',
    'create_thread',
  ]);
  const listCall = server.calls.find((call) => call.method === 'tools/list');
  assert.equal(listCall.params.threadStartKind, 'all');
  assert.equal(listCall.params.toolsNamespace, undefined);
});

test('tools/call answers come back as JSON inside a JSON string, parsed twice', async (t) => {
  const server = await startPipe();
  t.after(() => server.close());
  const client = new CodexPipeClient({ pipePath: server.pipePath });
  t.after(() => client.close());
  const value = await client.callTool({ namespace: 'codex_app', tool: 'list_threads', arguments: { limit: 10 }, threadId: 'ctx-1' });
  assert.equal(typeof value, 'object');
  assert.equal(value.threads.length, 2, 'the inner text was parsed a second time');
  const call = server.calls.find((entry) => entry.method === 'tools/call');
  assert.equal(call.params.namespace, 'codex_app');
  assert.equal(call.params.tool, 'list_threads');
  assert.equal(call.params.callerSource, 'codex');
  assert.equal(call.params.threadId, 'ctx-1');
  assert.match(call.params.callId, /^[0-9a-f-]{36}$/);
  assert.match(call.params.turnId, /^[0-9a-f-]{36}$/);
});

test('a JSON-RPC error from the pipe rejects the call with the pipe message', async (t) => {
  const server = await startPipe();
  t.after(() => server.close());
  const client = new CodexPipeClient({ pipePath: server.pipePath });
  t.after(() => client.close());
  await assert.rejects(() => client.request('nope/nope', {}), /method not found/);
});

test('a connection to a missing pipe fails fast instead of hanging', async () => {
  const client = new CodexPipeClient({ pipePath: '\\\\.\\pipe\\codex-pipe-does-not-exist-1234', timeoutMs: 3000 });
  await assert.rejects(() => client.listTools(), /ENOENT|not found|connect/i);
});

test('thread status maps onto the four contract statuses', () => {
  assert.equal(mapThreadStatus('active'), 'working');
  assert.equal(mapThreadStatus('inProgress'), 'working');
  assert.equal(mapThreadStatus('idle'), 'idle');
  assert.equal(mapThreadStatus('notLoaded'), 'idle');
  assert.equal(mapThreadStatus('stopped'), 'stopped');
  assert.equal(mapThreadStatus('error'), 'error');
  assert.equal(mapThreadStatus('something-new'), 'idle');
});

test('items map to the four contract roles with stable ids', () => {
  const messages = itemsToMessages(READ_THREAD.turns);
  assert.equal(messages.length, 7);
  assert.deepEqual(messages.map((message) => message.role), [
    'user',
    'assistant',
    'assistant',
    'tool',
    'tool',
    'tool',
    'tool',
  ]);
  assert.deepEqual(messages.map((message) => message.id), ['it-1', 'it-2', 'it-3', 'it-4', 'it-5', 'it-6', 'it-7']);
  assert.equal(messages[0].text, 'please continue');
  assert.equal(messages[1].text, 'working on it');
  assert.equal(messages[3].text, 'node --test (exit 0)');
  assert.equal(messages[6].text, 'rfc 6455');
  for (const message of messages) {
    assert.match(message.timestamp, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/);
  }
});

test('a projectless or unknown-kind thread is kept, only cloud is dropped', async (t) => {
  // The old filter used an allow list of kinds, so a thread whose kind was not on
  // it - a brand-new projectless chat, for instance - disappeared from the list
  // even though the app could read it. Only an explicit cloud/ChatGPT marker may
  // drop a thread now.
  const server = await startPipe({
    listThreads: {
      schemaVersion: 1,
      threads: [
        { id: '01a11a8c-9512-79c3-ae04-a47584282b0b', kind: 'projectless', hostId: 'local', status: 'idle', cwd: 'D:\\w', updatedAt: '2026-10-08T05:00:00.000Z', title: 'New projectless chat' },
        { id: '01a11a8c-9ccd-7c21-8a56-823d7b5e4f71', hostId: 'local', status: 'idle', cwd: null, updatedAt: '2026-10-08T05:01:00.000Z', title: 'No kind at all' },
        { id: 'cloud-1', kind: 'cloud', source: 'chatgpt', hostId: 'remote', status: 'idle', cwd: null, updatedAt: '2026-10-08T05:02:00.000Z', title: 'Cloud chat' },
      ],
      pinnedThreads: [],
    },
  });
  t.after(() => server.close());
  const adapter = await CodexAdapter.open({ pipePath: server.pipePath, contextThreadId: 'ctx-1' });
  t.after(() => adapter.close());
  const sessions = await adapter.listSessions();
  assert.deepEqual(sessions.map((session) => session.id).sort(), [
    '01a11a8c-9512-79c3-ae04-a47584282b0b',
    '01a11a8c-9ccd-7c21-8a56-823d7b5e4f71',
  ]);
  assert.equal(sessions.some((session) => session.id === 'cloud-1'), false, 'a cloud thread is still never offered');
});

test('a created thread the native list forgot is merged back with real metadata', async (t) => {
  // Read-only observation on this machine: a thread `read_thread` answers for is
  // absent from `list_threads`. The recorded creation id must still be findable
  // after a phone reload, with the app's own title and status.
  const missingId = '01a11a8c-9512-79c3-ae04-a47584282b0b';
  const server = await startPipe({
    listThreads: { schemaVersion: 1, threads: [], pinnedThreads: [] },
    readThread: {
      schemaVersion: 1,
      thread: { id: missingId, kind: 'codex', hostId: 'local', title: 'Created from the phone', preview: '', status: { type: 'idle' }, cwd: 'D:\\w', createdAt: '2026-10-08T05:00:00.000Z', updatedAt: '2026-10-08T05:10:00.000Z' },
      page: { order: 'newest', limit: 100, nextCursor: null, hasMore: false },
      turns: [],
    },
  });
  t.after(() => server.close());
  const adapter = await CodexAdapter.open({ pipePath: server.pipePath, contextThreadId: 'ctx-1' });
  t.after(() => adapter.close());

  const withoutMerge = await adapter.listSessions();
  assert.deepEqual(withoutMerge, [], 'without the recorded id the native list really shows nothing');

  const merged = await adapter.listSessions({ extraIds: [missingId] });
  assert.equal(merged.length, 1);
  assert.equal(merged[0].id, missingId);
  assert.equal(merged[0].title, 'Created from the phone');
  assert.equal(merged[0].status, 'idle', 'the object status {type:idle} maps to the contract value');
  assert.equal(merged[0].cwd, 'D:\\w');
});

test('the merge is bounded and never invents a thread', async (t) => {
  const ids = Array.from({ length: 9 }, (_, index) => `01a11a8c-0000-7000-8000-00000000000${index}`);
  const server = await startPipe({
    listThreads: { schemaVersion: 1, threads: [], pinnedThreads: [] },
    readThread: (args) => ({
      schemaVersion: 1,
      thread: { id: args.threadId, kind: 'codex', hostId: 'local', title: `Thread ${String(args.threadId).slice(-2)}`, status: { type: 'idle' }, cwd: 'D:\\w', updatedAt: '2026-10-08T05:10:00.000Z' },
      turns: [],
    }),
  });
  t.after(() => server.close());
  const adapter = await CodexAdapter.open({ pipePath: server.pipePath, contextThreadId: 'ctx-1' });
  t.after(() => adapter.close());
  const merged = await adapter.listSessions({ extraIds: ids, extraLimit: 3 });
  assert.equal(merged.length, 3, 'at most extraLimit reads happen');
  assert.equal(merged.every((session) => ids.includes(session.id)), true);

  const unreadable = await adapter.listSessions({ extraIds: ['01a11a8c-ffff-7000-8000-000000000000'] });
  void unreadable;
});

test('listSessions normalizes the real list_threads shape', async (t) => {
  const server = await startPipe();
  t.after(() => server.close());
  const adapter = await CodexAdapter.open({ pipePath: server.pipePath, contextThreadId: 'ctx-1' });
  t.after(() => adapter.close());
  const sessions = await adapter.listSessions();
  assert.equal(sessions.length, 2);
  assert.deepEqual(sessions[0], {
    id: '01a1193c-1111-7b40-8f81-269595d36edf',
    tool: 'codex',
    title: 'Wire the bridge',
    status: 'working',
    // protocol-v1 §4.2 output form: seconds precision when the milliseconds are zero.
    updatedAt: '2026-10-08T05:12:00Z',
    cwd: 'D:\\workspace\\codex-workspace\\remote-control',
  });
  assert.equal(sessions[1].status, 'idle');
  assert.equal(sessions[1].cwd, null, 'a thread with no cwd reports an explicit null, never a missing field');
});

test('readSession reports roles, canStop=false and the active turn', async (t) => {
  const server = await startPipe();
  t.after(() => server.close());
  const adapter = await CodexAdapter.open({ pipePath: server.pipePath, contextThreadId: 'ctx-1' });
  t.after(() => adapter.close());
  const session = await adapter.readSession('01a1197c-37b6-7b40-8f81-269595d36edf');
  assert.equal(session.tool, 'codex');
  assert.equal(session.title, 'Live thread');
  assert.equal(session.status, 'working');
  assert.equal(session.messages.length, 7);
  assert.equal(session.activeTurnId, 'turn-1');
  assert.equal(session.canStop, false, 'no stop capability is advertised, so the button must be grey');
});

test('sendMessage goes to the same thread through send_message_to_thread, and never creates one', async (t) => {
  const server = await startPipe();
  t.after(() => server.close());
  const adapter = await CodexAdapter.open({ pipePath: server.pipePath, contextThreadId: 'ctx-1' });
  t.after(() => adapter.close());
  const result = await adapter.sendMessage('01a1197c-37b6-7b40-8f81-269595d36edf', 'continue please');
  assert.deepEqual(result, { accepted: true, sessionId: '01a1197c-37b6-7b40-8f81-269595d36edf' });
  const call = server.calls.find((entry) => entry.method === 'tools/call');
  assert.equal(call.params.tool, 'send_message_to_thread');
  assert.equal(call.params.arguments.threadId, '01a1197c-37b6-7b40-8f81-269595d36edf');
  assert.equal(call.params.arguments.prompt, 'continue please');
  assert.equal(
    server.calls.some((entry) => entry.params?.tool === 'create_thread'),
    false,
    'a new session would be a fake takeover',
  );
});

test('sendMessage is attempted once: no retry inside the adapter', async (t) => {
  let attempts = 0;
  const server = await startPipe({
    handlers: {
      // Simulate the pipe dying mid-call: the socket is destroyed, nothing is answered.
      send_message_to_thread: (args, params, socket) => {
        attempts += 1;
        socket.destroy();
        return null;
      },
    },
  });
  t.after(() => server.close());
  const adapter = await CodexAdapter.open({ pipePath: server.pipePath, contextThreadId: 'ctx-1' });
  t.after(() => adapter.close());
  await assert.rejects(() => adapter.sendMessage('01a1197c-37b6-7b40-8f81-269595d36edf', 'hello'));
  assert.equal(attempts, 1, 'a retry here would post the message twice');
});

test('stopSession refuses with not_capable while no stop interface exists', async (t) => {
  const server = await startPipe();
  t.after(() => server.close());
  const adapter = await CodexAdapter.open({ pipePath: server.pipePath, contextThreadId: 'ctx-1' });
  t.after(() => adapter.close());
  const err = await adapter.stopSession('01a1197c-37b6-7b40-8f81-269595d36edf').catch((e) => e);
  assert.equal(err.code, 'not_capable');
  assert.match(err.message, /requires.*Desktop.*opt-in/i);
  assert.equal(
    server.calls.some((entry) => entry.params?.tool === 'stop' || entry.params?.tool === 'interrupt'),
    false,
    'no stop attempt is sent to the pipe',
  );
});

test('the adapter reports which codex_app tools it really found', async (t) => {
  const server = await startPipe({ tools: CODEX_APP_TOOLS.filter((tool) => tool.name !== 'send_message_to_thread') });
  t.after(() => server.close());
  const adapter = await CodexAdapter.open({ pipePath: server.pipePath, contextThreadId: 'ctx-1' });
  t.after(() => adapter.close());
  assert.deepEqual(adapter.availableTools().sort(), ['create_thread', 'list_threads', 'read_thread']);
  assert.equal(adapter.canSend(), false, 'without send_message_to_thread, sending is not claimed');
  const err = await adapter.sendMessage('01a1197c-37b6-7b40-8f81-269595d36edf', 'x').catch((e) => e);
  assert.equal(err.code, 'not_capable');
});

test('a failed tools/call surfaces as a bridge_error with safe text', async (t) => {
  const server = await startPipe({
    handlers: {
      read_thread: () => ({ success: false, contentItems: [{ type: 'inputText', text: 'thread not found: C:\\Users\\Hi\\.codex\\sessions' }] }),
    },
  });
  t.after(() => server.close());
  const adapter = await CodexAdapter.open({ pipePath: server.pipePath, contextThreadId: 'ctx-1' });
  t.after(() => adapter.close());
  const err = await adapter.readSession('01a1197c-37b6-7b40-8f81-269595d36edf').catch((e) => e);
  assert.equal(err.code, 'bridge_error');
  assert.ok(!err.message.includes('C:\\Users'), err.message);
});

test('the real list_projects shape maps every local project, and rejects what is not local', () => {
  // The bug this pins: `localProjects()` read only `id/name/kind/cwd`, so the
  // real answer - which uses `projectId/label/projectKind/path/hostId` - came
  // back as an empty list and every real project was silently dropped.
  const projects = localProjects(LIST_PROJECTS);
  assert.deepEqual(
    projects.map((project) => project.name),
    ['remote-control', 'ai-connect', 'inception-plan-1', 'agent-learn', 'lifebot'],
    'all five local projects survive, in the order the app sent them',
  );
  assert.deepEqual(projects[0], {
    id: 'c49702d7-0af5-4eba-bef8-a74582276dd3',
    name: 'remote-control',
    cwd: 'D:\\workspace\\codex-workspace\\remote-control',
  });
  assert.equal(projects[4].cwd, 'D:\\workspace\\lifebot');
  assert.equal(
    projects.some((project) => project.id === '4d5e6f70-8192-4aab-9cbf-3a4b5c6d7e8f'),
    false,
    'a ChatGPT cloud project is never offered',
  );
  assert.equal(
    projects.some((project) => project.id === '5e6f7081-92a3-4abc-8dc0-4b5c6d7e8f90'),
    false,
    'a project that lives on another host is never offered',
  );
});

test('the legacy id/name/kind/cwd project shape still maps, and a remote kind is still rejected', () => {
  const legacy = {
    projects: [
      { id: 'proj_01H9-XYZ:abc', name: 'Legacy local', kind: 'local', cwd: 'D:\\legacy\\app' },
      { id: 'legacy-2', title: 'Legacy titled', kind: 'project', path: 'D:\\legacy\\two' },
      { id: 'legacy-remote', name: 'Remote', kind: 'remote', cwd: '\\\\host\\share' },
      { id: 'legacy-cloud', name: 'Cloud', kind: 'cloud', cwd: null },
    ],
  };
  assert.deepEqual(localProjects(legacy), [
    { id: 'proj_01H9-XYZ:abc', name: 'Legacy local', cwd: 'D:\\legacy\\app' },
    { id: 'legacy-2', name: 'Legacy titled', cwd: 'D:\\legacy\\two' },
  ]);
  assert.deepEqual(localProjects({ projects: [] }), []);
  assert.deepEqual(localProjects(null), []);
});

test('an entry with no usable id or path is dropped instead of invented', () => {
  const projects = localProjects({
    projects: [
      { projectId: '', projectKind: 'local', label: 'no id', path: 'D:\\a', hostId: 'local' },
      { projectId: 'has-id', projectKind: 'local', label: '', path: null, hostId: 'local' },
      null,
      'not an object',
    ],
  });
  assert.deepEqual(projects, [{ id: 'has-id', name: 'has-id', cwd: null }], 'no id, no entry; a missing label falls back to the id, never to an empty name');
});

test('listModels carries the real projects over a real pipe, so models.list stops dropping them', async (t) => {
  const server = await startPipe({ tools: [...CODEX_APP_TOOLS, LIST_PROJECTS_TOOL], listProjects: LIST_PROJECTS });
  t.after(() => server.close());
  const adapter = await CodexAdapter.open({ pipePath: server.pipePath, contextThreadId: 'ctx-1' });
  t.after(() => adapter.close());
  const listed = await adapter.listModels();
  assert.equal(listed.projects.length, 5, 'the five local projects reach models.list instead of an empty array');
  assert.equal(listed.projects[1].name, 'ai-connect');
  assert.equal(listed.projects[0].cwd, 'D:\\workspace\\codex-workspace\\remote-control');
  const call = server.calls.find((entry) => entry.params?.tool === 'list_projects');
  assert.ok(call, 'the projects came from the app itself, not from a constant');
});

test('a chosen project is validated live, and a contradicting directory is refused before creating', async (t) => {
  const server = await startPipe({ tools: [...CODEX_APP_TOOLS, LIST_PROJECTS_TOOL], listProjects: LIST_PROJECTS });
  t.after(() => server.close());
  const adapter = await CodexAdapter.open({ pipePath: server.pipePath, contextThreadId: 'ctx-1' });
  t.after(() => adapter.close());
  const projectId = 'c49702d7-0af5-4eba-bef8-a74582276dd3';

  // projectId + the directory it really is: one target, and no contradiction.
  const agreed = await adapter.resolveTarget({ projectId, cwd: 'D:\\workspace\\codex-workspace\\remote-control\\' });
  assert.deepEqual(agreed, { type: 'project', projectId, environment: { type: 'local' } });

  // projectId + a different directory: refused, never silently opened elsewhere.
  const contradicted = await adapter.resolveTarget({ projectId, cwd: 'D:\\workspace\\lifebot' }).catch((error) => error);
  assert.equal(contradicted.code, 'session_create_failed');
  assert.match(contradicted.message, /not the project/i);

  // A project the app never listed, and ids that name a cloud project, are refused too.
  const unknown = await adapter.resolveTarget({ projectId: 'not-a-project' }).catch((error) => error);
  assert.equal(unknown.code, 'session_create_failed');
  const cloud = await adapter.resolveTarget({ projectId: '4d5e6f70-8192-4aab-9cbf-3a4b5c6d7e8f' }).catch((error) => error);
  assert.equal(cloud.code, 'session_create_failed');

  // No contradiction was ever turned into a created thread.
  assert.equal(server.calls.some((entry) => entry.params?.tool === 'create_thread'), false);
});




/** The live catalog the send tool documents, plus the tools the adapter needs. */
const SEND_MODEL_TOOLS = [...CODEX_APP_TOOLS.filter((tool) => tool.name !== 'send_message_to_thread'), SEND_WITH_MODEL_TOOL];

test('canSendWithModel is a fact of the send schema, never an assumption', async (t) => {
  const withCatalog = await startPipe({ tools: SEND_MODEL_TOOLS });
  t.after(() => withCatalog.close());
  const canSend = await CodexAdapter.open({ pipePath: withCatalog.pipePath, contextThreadId: 'ctx-1' });
  t.after(() => canSend.close());
  assert.equal(canSend.canSendWithModel(), true);
  const listed = await canSend.listModels();
  assert.deepEqual(listed.models.map((model) => model.id), ['gpt-6.1-sol', 'gpt-6-luna']);
  assert.equal(listed.catalogSource, 'send_message_to_thread.inputSchema.properties.model.description');

  // The plain fixture's send tool documents no model at all: no picker, and a
  // plain send still works.
  const withoutCatalog = await startPipe();
  t.after(() => withoutCatalog.close());
  const cannotSend = await CodexAdapter.open({ pipePath: withoutCatalog.pipePath, contextThreadId: 'ctx-1' });
  t.after(() => cannotSend.close());
  assert.equal(cannotSend.canSendWithModel(), false);
  const plain = await cannotSend.sendMessage('01a1197c-37b6-7b40-8f81-269595d36edf', 'hello');
  assert.deepEqual(plain, { accepted: true, sessionId: '01a1197c-37b6-7b40-8f81-269595d36edf' });
  const err = await cannotSend.sendMessage('01a1197c-37b6-7b40-8f81-269595d36edf', 'hello', { model: 'gpt-6-sol' }).catch((error) => error);
  assert.equal(err.code, 'not_capable');
  assert.equal(
    withoutCatalog.calls.filter((entry) => entry.method === 'tools/call').length,
    1,
    'only the plain send was sent: an unverifiable model never reaches the app',
  );
});

test('a Codex send carries the chosen model and thinking, and sends once', async (t) => {
  const server = await startPipe({ tools: SEND_MODEL_TOOLS });
  t.after(() => server.close());
  const adapter = await CodexAdapter.open({ pipePath: server.pipePath, contextThreadId: 'ctx-1' });
  t.after(() => adapter.close());
  const result = await adapter.sendMessage('01a1197c-37b6-7b40-8f81-269595d36edf', 'continue', {
    model: 'gpt-6.1-sol',
    reasoningEffort: 'xhigh',
  });
  assert.deepEqual(result, { accepted: true, sessionId: '01a1197c-37b6-7b40-8f81-269595d36edf' });
  const calls = server.calls.filter((entry) => entry.method === 'tools/call');
  assert.equal(calls.length, 1, 'one send, never a retry');
  assert.deepEqual(calls[0].params.arguments, {
    threadId: '01a1197c-37b6-7b40-8f81-269595d36edf',
    prompt: 'continue',
    model: 'gpt-6.1-sol',
    thinking: 'xhigh',
  });
  assert.equal(server.calls.some((entry) => entry.params?.tool === 'create_thread'), false);
});

test('an unknown Codex model or a wrong effort is refused before anything is sent', async (t) => {
  const server = await startPipe({ tools: SEND_MODEL_TOOLS });
  t.after(() => server.close());
  const adapter = await CodexAdapter.open({ pipePath: server.pipePath, contextThreadId: 'ctx-1' });
  t.after(() => adapter.close());

  const unknown = await adapter.sendMessage('01a1197c-37b6-7b40-8f81-269595d36edf', 'x', { model: 'gpt-9-fictional' }).catch((error) => error);
  assert.equal(unknown.code, 'model_not_available');
  // A weaker per-model list beats the tool's broader enum: luna does not offer
  // `ultra` even though the thinking enum names it.
  const wrongEffort = await adapter
    .sendMessage('01a1197c-37b6-7b40-8f81-269595d36edf', 'x', { model: 'gpt-6-luna', reasoningEffort: 'ultra' })
    .catch((error) => error);
  assert.equal(wrongEffort.code, 'invalid_params');
  // The enum is the fallback when a model declares no effort list of its own.
  const accepted = await adapter.sendMessage('01a1197c-37b6-7b40-8f81-269595d36edf', 'x', { model: 'gpt-6-luna', reasoningEffort: 'low' });
  assert.deepEqual(accepted, { accepted: true, sessionId: '01a1197c-37b6-7b40-8f81-269595d36edf' });
  const calls = server.calls.filter((entry) => entry.method === 'tools/call');
  assert.equal(calls.length, 1, 'only the answerable send reached the app');
  assert.equal(calls[0].params.arguments.thinking, 'low');
});

test('Codex never claims it can answer a native question', async (t) => {
  const server = await startPipe();
  t.after(() => server.close());
  const adapter = await CodexAdapter.open({ pipePath: server.pipePath, contextThreadId: 'ctx-1' });
  t.after(() => adapter.close());
  assert.equal(adapter.canAnswer(), false);
  const err = await adapter.answerQuestion('01a1197c-37b6-7b40-8f81-269595d36edf', 'call-1', [{ id: 'q-1', selected: [] }]).catch((error) => error);
  assert.equal(err.code, 'not_capable');
  assert.equal(server.calls.some((entry) => entry.method === 'tools/call'), false, 'no pretend answer is sent to the app');
});

/** The one `read_thread` call a test made, so the request, not a comment, is checked. */
function readThreadCall(server) {
  return server.calls.find((entry) => entry.params?.tool === 'read_thread');
}

test('readSession asks for bounded recent turns WITH outputs, never the native one-turn default', async (t) => {
  // The live bug: `read_thread` with no `turnLimit` answers with a single turn on
  // this host, so every earlier message vanished from the phone as soon as the
  // next answer arrived - and without `includeOutputs` the phone's own prompt was
  // absent from the native answer altogether.
  const server = await startPipe();
  t.after(() => server.close());
  const adapter = await CodexAdapter.open({ pipePath: server.pipePath, contextThreadId: 'ctx-1' });
  t.after(() => adapter.close());
  await adapter.readSession('01a1197c-37b6-7b40-8f81-269595d36edf');
  const call = readThreadCall(server);
  assert.ok(call, 'the read really reached the pipe');
  assert.equal(call.params.arguments.threadId, '01a1197c-37b6-7b40-8f81-269595d36edf', 'the same thread, never another one');
  assert.equal(call.params.arguments.turnLimit, READ_TURN_LIMIT);
  assert.equal(READ_TURN_LIMIT > 1, true, 'a bound of one would recreate the bug it fixes');
  // The live schema refuses anything above 10 ("turnLimit: Too big"), so asking
  // for more would fail every read rather than show more history.
  assert.equal(READ_TURN_LIMIT <= 10, true, 'the native maximum is 10');
  assert.equal(call.params.arguments.includeOutputs, true);
  assert.equal(call.params.arguments.maxOutputCharsPerItem, MAX_OUTPUT_CHARS_PER_ITEM);
  assert.equal(server.calls.some((entry) => entry.params?.tool === 'create_thread'), false, 'reading is read-only');
});

test('two newest-first turns keep their chronological user+assistant pairs after the next phone prompt', async (t) => {
  // After a phone send the native page is `newest_first`, so the newest exchange
  // arrives first and the oldest last. Emitting that verbatim showed the phone a
  // reversed conversation; every earlier pair must also still be there.
  const server = await startPipe({ readThread: DELEGATION_READ_THREAD });
  t.after(() => server.close());
  const adapter = await CodexAdapter.open({ pipePath: server.pipePath, contextThreadId: 'ctx-1' });
  t.after(() => adapter.close());
  const session = await adapter.readSession('01a120cb-8e36-7860-ac06-d913537ced33');

  assert.deepEqual(session.messages.map((message) => message.role), [
    'user',
    'assistant',
    'user',
    'assistant',
    'user',
    'assistant',
  ]);
  assert.deepEqual(session.messages.map((message) => message.text), [
    'first prompt',
    'first answer',
    'second prompt',
    'second answer',
    'third prompt',
    'third answer',
  ], 'oldest exchange first, every earlier pair retained');
  assert.deepEqual(session.messages.map((message) => message.id), [
    'item-first',
    'item-first-reply',
    'item-second',
    'item-second-reply',
    'item-third',
    'item-third-reply',
  ], 'the native item ids travel unchanged, so the phone can de-duplicate');
  assert.deepEqual(
    session.messages.map((message) => message.timestamp),
    [
      '2026-10-09T13:11:40Z',
      '2026-10-09T13:11:40Z',
      '2026-10-09T13:20:00Z',
      '2026-10-09T13:20:00Z',
      '2026-10-09T13:21:40Z',
      '2026-10-09T13:21:40Z',
    ],
    'the epoch seconds the app reports become RFC3339, and stay stable across reads',
  );
  assert.equal(session.status, 'idle', 'the newest turn (the first one a newest-first page returns) is what reports status');
});

test('a known delegation wrapper renders as the user prompt, without the source thread id', async (t) => {
  const server = await startPipe({ readThread: DELEGATION_READ_THREAD });
  t.after(() => server.close());
  const adapter = await CodexAdapter.open({ pipePath: server.pipePath, contextThreadId: 'ctx-1' });
  t.after(() => adapter.close());
  const session = await adapter.readSession('01a120cb-8e36-7860-ac06-d913537ced33');
  const fromWrapper = session.messages.filter((message) => message.text.includes('prompt') && message.text !== 'first prompt');
  assert.equal(fromWrapper.length, 2, 'both phone prompts were promoted to real user messages');
  for (const message of fromWrapper) {
    assert.equal(message.role, 'user');
    assert.equal(message.text.includes('codex_delegation'), false, 'the wrapper itself is never shown');
    assert.equal(message.text.includes('source_thread_id'), false, 'the delegating session id is not the user\'s words');
    assert.equal(message.text.includes('01a1197c-37b6-7b40-8f81-269595d36edf'), false);
  }
});

test('an input holding literal angle tags and a nested closing tag survives intact', () => {
  // The prompt is whatever a person typed: markdown, XML-like text, even the
  // wrapper's own tags. The boundary is the whole wrapper, so nothing inside it
  // is mistaken for structure and nothing is cut at an inner `</input>`.
  const literal = 'Use <input> as a literal tag, and a nested </input> too.\n\n```xml\n<codex_delegation>nested</codex_delegation>\n```';
  const messages = itemsToMessages(
    [
      {
        id: 'turn-1',
        startedAt: '2026-10-09T05:20:00.000Z',
        items: [
          {
            type: 'functionCallOutput',
            id: 'item-literal',
            name: 'send_message_to_thread',
            namespace: 'codex_app',
            output: { text: delegationWrapper('01a1197c-37b6-7b40-8f81-269595d36edf', literal), truncated: false },
          },
        ],
      },
    ],
    { pageOrder: 'oldest_first' },
  );
  assert.equal(messages.length, 1);
  assert.equal(messages[0].role, 'user');
  assert.equal(messages[0].text, literal, 'the prompt is returned losslessly, tags and all');
});

test('tool output that is not a known delegation is folded, never promoted to the user', () => {
  // Every one of these really occurs: a truncated wrapper (the app itself says
  // the text is incomplete), a wrapper with no input, a wrapper from another
  // namespace, an unrelated tool, and a plain output. None of them is a prompt a
  // person typed, so none may become a user message.
  const wrapper = (input, extra = {}) => ({
    type: 'functionCallOutput',
    id: `item-${input}`,
    name: 'send_message_to_thread',
    namespace: 'codex_app',
    output: { text: delegationWrapper('01a1197c-37b6-7b40-8f81-269595d36edf', input), truncated: false },
    ...extra,
  });
  const messages = itemsToMessages([
    {
      id: 'turn-1',
      startedAt: '2026-10-09T05:20:00.000Z',
      items: [
        {
          ...wrapper('half a prompt'),
          output: { text: delegationWrapper('01a1197c-37b6-7b40-8f81-269595d36edf', 'half a prom'), truncated: true },
        },
        { type: 'functionCallOutput', id: 'item-no-input', name: 'send_message_to_thread', namespace: 'codex_app', output: { text: '<codex_delegation>\n  <source_thread_id>x</source_thread_id>\n</codex_delegation>', truncated: false } },
        { type: 'functionCallOutput', id: 'item-no-wrapper', name: 'send_message_to_thread', namespace: 'codex_app', output: { text: 'just an ordinary tool answer', truncated: false } },
        { ...wrapper('wrong namespace'), namespace: 'other_app' },
        { ...wrapper('unrelated tool'), name: 'read_thread' },
        { type: 'functionCallOutput', id: 'item-unrelated', name: 'run_command', namespace: 'codex_app', output: { text: 'total 0\ndrwxr-xr-x  secret-file.txt', truncated: false } },
        { type: 'commandExecution', id: 'item-command', command: 'node --test', exitCode: 0 },
      ],
    },
  ]);
  assert.equal(messages.some((message) => message.role === 'user'), false, 'an unknown function output is never a user message');
  assert.deepEqual(messages.map((message) => message.role), ['system', 'system', 'system', 'system', 'system', 'system', 'tool']);
  assert.deepEqual(messages.slice(0, 6).map((message) => message.text), [
    'send_message_to_thread output (truncated)',
    'send_message_to_thread output',
    'send_message_to_thread output',
    'send_message_to_thread output',
    'read_thread output',
    'run_command output',
  ], 'raw output text is never shown, and a truncated answer says so');
  assert.equal(messages.some((message) => message.text.includes('secret-file.txt')), false, 'arbitrary tool output stays folded');
});

test('the new output item keeps a stable id and the system role it had', () => {
  // Before this fix an output item fell through to `[functionCallOutput]` with a
  // fabricated id, so the phone could not de-duplicate it across reads. The id
  // and the role are now the native ones.
  const messages = itemsToMessages([
    { id: 'turn-1', startedAt: '2026-10-09T13:20:00.000Z', items: [{ type: 'functionCallOutput', id: 'fco-1', name: 'create_thread', namespace: 'codex_app' }] },
  ]);
  assert.deepEqual(messages, [{ id: 'fco-1', role: 'system', text: 'create_thread output', timestamp: '2026-10-09T13:20:00Z' }]);
});

test('an item whose rendered text is empty becomes no message, and nonempty items are untouched', () => {
  // Read-only from the live pipe: `read_thread` emits reasoning items whose
  // summary is empty and in-progress agentMessage placeholders with no text yet.
  // Each one used to become a transcript bubble holding only the "AI" label and
  // a timestamp. The empty items are dropped; every item that really says
  // something keeps its own text, role, native id and place in the order.
  const messages = itemsToMessages(
    [
      {
        id: 'turn-1',
        startedAt: '2026-10-09T13:20:00.000Z',
        items: [
          { type: 'userMessage', id: 'item-user', content: 'please continue' },
          { type: 'reasoning', id: 'item-reasoning-empty', summary: '' },
          { type: 'agentMessage', id: 'item-agent-empty', text: '' },
          { type: 'agentMessage', id: 'item-agent-whitespace', text: '   \n\t  ' },
          { type: 'reasoning', id: 'item-reasoning-missing' },
          { type: 'agentMessage', id: 'item-agent-real', text: 'working on it' },
          { type: 'reasoning', id: 'item-reasoning-real', summary: 'thinking about the design' },
          { type: 'commandExecution', id: 'item-command', command: 'node --test', exitCode: 0 },
          { type: 'functionCallOutput', id: 'item-tool', name: 'read_thread', namespace: 'codex_app', output: { text: 'output', truncated: false } },
          {
            type: 'functionCallOutput',
            id: 'item-delegation',
            name: 'send_message_to_thread',
            namespace: 'codex_app',
            output: { text: delegationWrapper('01a1197c-37b6-7b40-8f81-269595d36edf', 'a prompt a person typed'), truncated: false },
          },
          { type: 'userMessage', id: 'item-user-blank', content: ' \n ' },
        ],
      },
    ],
    { pageOrder: 'oldest_first' },
  );
  assert.deepEqual(
    messages,
    [
      { id: 'item-user', role: 'user', text: 'please continue', timestamp: '2026-10-09T13:20:00Z' },
      { id: 'item-agent-real', role: 'assistant', text: 'working on it', timestamp: '2026-10-09T13:20:00Z' },
      { id: 'item-reasoning-real', role: 'assistant', text: 'thinking about the design', timestamp: '2026-10-09T13:20:00Z' },
      { id: 'item-command', role: 'tool', text: 'node --test (exit 0)', timestamp: '2026-10-09T13:20:00Z' },
      { id: 'item-tool', role: 'system', text: 'read_thread output', timestamp: '2026-10-09T13:20:00Z' },
      { id: 'item-delegation', role: 'user', text: 'a prompt a person typed', timestamp: '2026-10-09T13:20:00Z' },
    ],
    'the empty placeholders are gone and nothing else moved, changed role, or lost its text',
  );
  assert.equal(messages.some((message) => message.id.startsWith('item-reasoning-empty')), false);
  assert.equal(messages.some((message) => message.text.trim().length === 0), false, 'no blank bubble reaches the phone');
});

test('the blank check is about text, not about a particular alphabet', () => {
  // The predicate must not be a wider "looks empty" heuristic: real words in
  // another script are kept character for character, and only text that is
  // nothing but padding goes away.
  const messages = itemsToMessages([
    {
      id: 'turn-1',
      startedAt: '2026-10-09T13:20:00.000Z',
      items: [
        { type: 'userMessage', id: 'item-cjk', content: '继续' },
        { type: 'reasoning', id: 'item-padded', summary: '   a thought   ' },
        { type: 'agentMessage', id: 'item-crlf', text: '\r\n' },
        { type: 'agentMessage', id: 'item-letter', text: 'x' },
      ],
    },
  ]);
  assert.deepEqual(messages.map((message) => [message.id, message.text]), [
    ['item-cjk', '继续'],
    ['item-padded', '   a thought   '],
    ['item-letter', 'x'],
  ], 'text is kept exactly as rendered, and only all-whitespace items are dropped');
});

test('empty placeholders do not spend the 200-message budget that real messages need', async (t) => {
  // The same live shape at the size that matters: the header of an active Codex
  // chat is mostly empty reasoning/agent placeholders, and protocol-v1 §9.2 keeps
  // only the newest 200 messages of one answer. Counting the blanks spent that
  // window and pushed real messages out of it, so the transcript arrived as a
  // wall of blank "AI" tiles. The mapper itself has no cap - it must not - so the
  // §9.2 window is applied here the way the protocol layer applies it, and the
  // assertion is about what that window then carries.
  const filler = Array.from({ length: 260 }, (_, index) => ({
    type: index % 2 === 0 ? 'reasoning' : 'agentMessage',
    id: `item-empty-${index}`,
    ...(index % 2 === 0 ? { summary: '' } : { text: '   ' }),
  }));
  const server = await startPipe({
    readThread: {
      schemaVersion: 1,
      thread: READ_THREAD.thread,
      page: { order: 'oldest_first', limit: 100, nextCursor: null, hasMore: false },
      turns: [
        {
          id: 'turn-1',
          status: 'inProgress',
          startedAt: '2026-10-09T13:20:00.000Z',
          items: [
            ...filler,
            { type: 'userMessage', id: 'item-user-real', content: 'are you there?' },
            { type: 'agentMessage', id: 'item-agent-real', text: 'yes, still working' },
          ],
        },
      ],
    },
  });
  t.after(() => server.close());
  const adapter = await CodexAdapter.open({ pipePath: server.pipePath, contextThreadId: 'ctx-1' });
  t.after(() => adapter.close());
  const session = await adapter.readSession(READ_THREAD.thread.id);
  assert.deepEqual(session.messages.map((message) => message.role), ['user', 'assistant']);
  assert.deepEqual(
    session.messages.slice(-200).map((message) => message.text),
    ['are you there?', 'yes, still working'],
    'the newest-200 window carries the real messages: 260 blanks would have evicted both',
  );
  assert.equal(session.status, 'working');
  assert.equal(session.activeTurnId, 'turn-1', 'the active turn is still reported while the placeholders are skipped');
});

test('legacy turns with no page order keep the oldest-first order they were written in', async (t) => {
  // The recorded fixtures (and hosts that report no page at all) send turns
  // oldest-first. Reversing those would silently flip every existing transcript,
  // so this fixture is written the way a legacy host writes it: the oldest turn
  // first, with no `page` field at all.
  const legacy = {
    schemaVersion: 1,
    thread: DELEGATION_READ_THREAD.thread,
    turns: [...DELEGATION_READ_THREAD.turns].reverse(),
  };
  const server = await startPipe({ readThread: legacy });
  t.after(() => server.close());
  const adapter = await CodexAdapter.open({ pipePath: server.pipePath, contextThreadId: 'ctx-1' });
  t.after(() => adapter.close());
  const session = await adapter.readSession('01a120cb-8e36-7860-ac06-d913537ced33');
  assert.deepEqual(session.messages.map((message) => message.text), [
    'first prompt',
    'first answer',
    'second prompt',
    'second answer',
    'third prompt',
    'third answer',
  ], 'no page.order means no reordering: the order the host wrote is the order the phone gets');
});

test('readSession still needs no outputs for an ordinary native user message', async (t) => {
  const server = await startPipe({ readThread: DELEGATION_READ_THREAD });
  t.after(() => server.close());
  const adapter = await CodexAdapter.open({ pipePath: server.pipePath, contextThreadId: 'ctx-1' });
  t.after(() => adapter.close());
  const session = await adapter.readSession('01a120cb-8e36-7860-ac06-d913537ced33');
  const native = session.messages.filter((message) => message.id === 'item-first');
  assert.equal(native.length, 1, 'a real userMessage item is neither dropped nor duplicated');
  assert.equal(native[0].role, 'user');
  assert.equal(native[0].text, 'first prompt');
});
