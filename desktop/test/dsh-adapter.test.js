'use strict';
/**
 * Tests for the DSH Desktop adapter primitives (protocol-v1 §9, plus the local
 * DSH HTTP API):
 *   - the browser-session cookie, minted exactly the way `dsh-client-connection`
 *     mints it, with the secret read from the local credential store;
 *   - the loopback backend discovery (netstat + tasklist), because the port and
 *     the PID change on every restart;
 *   - the client-request envelope DSH's own web client sends;
 *   - the session mappings: list, read, send and stop on the same sessionId.
 *
 * Everything here runs against a local HTTP server that verifies the cookie
 * signature itself, so a green run means the minted cookie is really accepted -
 * not that one module agreed with another copy of itself.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

const {
  cookieName,
  mintCookie,
  readBrowserSecret,
  parseNetstatListeners,
  parseTasklistNames,
  candidatePorts,
  DshClient,
  DshAdapter,
  discoverBackend,
  argFieldName,
  argPayload,
  DSH_PREFIX,
  workspaceCatalogPath,
  parseWorkspaceCatalog,
  readWorkspaceCatalog,
  normalizeWorkspacePath,
  activeQuestionBatches,
  mapPendingQuestions,
  currentModelOf,
  scanToolCalls,
  scanPtcQuestionCalls,
  ptcQuestionSubCallIds,
  isLiveCallChain,
  sameQuestionForm,
  correlateLegacyQuestionCall,
  correlatePtcQuestionCall,
  correlateHeldQuestionCall,
  recordedQuestionAnswers,
  scanApprovalAudit,
  correlateApprovalAudit,
  recordedOutcomeOf,
  PENDING_LIMITS,
  WORKSPACE_CATALOG_MAX_BYTES,
} = require('../src/adapters/dsh');
const { NATIVE_APPROVAL_OUTCOME } = require('../src/dsh-events');

const AUTHORITY = '127.0.0.1:19387';
const SECRET_BYTES = Buffer.from('0123456789abcdef0123456789abcdef', 'utf8'); // 32 bytes, fixed for tests
const SECRET_TEXT = SECRET_BYTES.toString('base64url');

function base64url(value) {
  return Buffer.from(value).toString('base64').replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '');
}

test('the cookie name is dsh-auth- plus the base64url of sha256(authority)', () => {
  const expected = `dsh-auth-${base64url(crypto.createHash('sha256').update(AUTHORITY).digest())}`;
  assert.equal(cookieName(AUTHORITY), expected);
  assert.equal(DSH_PREFIX, 'dsh-auth-');
});

test('the cookie value is v1.<base64url(json)>.<base64url(hmac-sha256)>, verified independently', () => {
  const now = 1770000000000;
  const ttlMs = 30 * 24 * 60 * 60 * 1000;
  const cookie = mintCookie({ secret: SECRET_BYTES, authority: AUTHORITY, now, ttlMs });

  // Recompute the whole thing from the format the DSH source documents.
  const payload = { version: 1, authority: AUTHORITY, issuedAt: now, expiresAt: now + ttlMs };
  const body = base64url(Buffer.from(JSON.stringify(payload), 'utf8'));
  const expectedSignature = base64url(crypto.createHmac('sha256', SECRET_BYTES).update(body).digest());
  assert.equal(cookie.value, `v1.${body}.${expectedSignature}`);
  assert.equal(cookie.name, cookieName(AUTHORITY));
  assert.equal(cookie.expiresAt, now + ttlMs);

  // A wrong secret must not verify, or the signature means nothing.
  const forged = base64url(crypto.createHmac('sha256', Buffer.alloc(32, 7)).update(body).digest());
  assert.notEqual(forged, expectedSignature);
});

test('the stored secret is read from the local credential record and never returned as text', () => {
  const yaml = [
    'version: 1',
    'records:',
    '  "client-connection/browser-session":',
    '    kind: grant',
    '    payload:',
    '      version: 1',
    `      secret: "${SECRET_TEXT}"`,
    '  "llm/deepseek":',
    '    kind: apiKey',
    '    payload:',
    '      secret: "must-not-be-used"',
    '',
  ].join('\n');
  const file = path.join(os.tmpdir(), `dsh-credentials-test-${crypto.randomUUID()}.yaml`);
  fs.writeFileSync(file, yaml, 'utf8');
  try {
    const secret = readBrowserSecret(file);
    assert.ok(Buffer.isBuffer(secret));
    assert.equal(secret.length, 32);
    assert.deepEqual(secret, SECRET_BYTES);
    assert.ok(!String(secret).includes(SECRET_TEXT.slice(0, 8)), 'the secret never comes back as text');
  } finally {
    fs.unlinkSync(file);
  }
});

test('a credential file without the browser-session record is a clear failure', () => {
  const file = path.join(os.tmpdir(), `dsh-credentials-empty-${crypto.randomUUID()}.yaml`);
  fs.writeFileSync(file, 'records:\n  "llm/deepseek":\n    kind: apiKey\n', 'utf8');
  try {
    assert.throws(() => readBrowserSecret(file), /browser-session/);
  } finally {
    fs.unlinkSync(file);
  }
});

test('netstat output is parsed into loopback listeners with their owning pid', () => {
  const sample = [
    '  TCP    0.0.0.0:135            0.0.0.0:0              LISTENING       1336',
    '  TCP    127.0.0.1:19387        0.0.0.0:0              LISTENING       46376',
    '  TCP    127.0.0.1:19387        127.0.0.1:51088        ESTABLISHED     46376',
    '  TCP    127.0.0.1:49156        127.0.0.1:19387        TIME_WAIT       0',
    '  TCP    [::1]:8080             [::]:0                 LISTENING       999',
    '  UDP    127.0.0.1:1900         *:*                                    4242',
  ].join('\r\n');
  const listeners = parseNetstatListeners(sample);
  assert.deepEqual(listeners, [
    { localAddress: '127.0.0.1', localPort: 19387, pid: 46376 },
    { localAddress: '::1', localPort: 8080, pid: 999 },
  ]);
});

test('tasklist csv maps a pid to its image name, case-insensitively', () => {
  const csv = '"DeepSeek Harness.exe","46376","Console","1","325,320 K"\r\n';
  const names = parseTasklistNames(csv);
  assert.equal(names.get(46376), 'DeepSeek Harness.exe');
});

test('candidate ports come from the config, then the environment, then a scan', () => {
  assert.deepEqual(candidatePorts({ configuredPort: 1234, envPort: '5678', scanned: [999, 1234], known: [4321] }), [
    1234, 5678, 4321, 999,
  ]);
  assert.deepEqual(candidatePorts({ scanned: [19387, 18989], known: [19387] }), [19387, 18989]);
  assert.deepEqual(candidatePorts({}), []);
});

test('a real HTTP backend is discovered by probing, and the cookie is really accepted', async (t) => {
  const calls = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      calls.push({ url: req.url, headers: req.headers, body });
      const raw = req.headers.cookie ?? '';
      const [name, value] = raw.split('=');
      const verified = name === cookieName(req.headers.host) && verifyCookie(value, SECRET_BYTES);
      if (!verified) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end('{"ok":false}');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ result: { ok: true, value: { items: [] } } }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const found = await discoverBackend({ ports: [port], secret: SECRET_BYTES, known: [] });
  assert.equal(found.port, port);
  assert.equal(found.baseUrl, `http://127.0.0.1:${port}`);
  const listCall = calls.find((call) => call.url === '/api/session/list');
  assert.ok(listCall, 'discovery proves itself with a real session/list call');
  assert.equal(listCall.headers.origin, `http://127.0.0.1:${port}`, 'the exact loopback origin is sent');
  assert.ok(listCall.headers.cookie.startsWith(`${cookieName(`127.0.0.1:${port}`)}=v1.`));
});

test('discovery gives up cleanly when no candidate answers like a DSH backend', async () => {
  // `known: []` keeps this test hermetic: on a machine where the real backend is
  // running, the saved port hint would otherwise be probed and found.
  const found = await discoverBackend({ ports: [1], known: [], secret: SECRET_BYTES, timeoutMs: 400 });
  assert.equal(found, null);
});

test('the client-request envelope is exactly the shape DSH expects', async (t) => {
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      seen.push({ url: req.url, body: JSON.parse(body || '{}') });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ result: { ok: true, value: { items: [] } } }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const client = new DshClient({ baseUrl: `http://127.0.0.1:${port}`, secret: SECRET_BYTES });
  await client.call('session/list', {});
  assert.equal(seen[0].url, '/api/session/list');
  assert.equal(seen[0].body.type, 'client-request');
  assert.match(seen[0].body.rpcId, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  assert.equal(seen[0].body.method, 'session/list');
  assert.deepEqual(seen[0].body.payload.args._request, {});
});

test('the first argument field follows the remote signature name', () => {
  // The shipped catalogue writes `list(_request: SessionListRequest, ...)` and
  // `(request: ...)` for every other method; the gateway enforces it.
  assert.equal(argFieldName('session/list'), '_request');
  assert.equal(argFieldName('session/page'), 'request');
  assert.equal(argFieldName('session/prompt'), 'request');
  assert.equal(argFieldName('session/cancel'), 'request');
  assert.equal(argFieldName('subagents/prompt'), 'request');
});

test('session/page addresses a subagent session through its parent', async (t) => {
  // Observed against the live backend: asking with `{kind:'session'}` for a
  // session that belongs to another session is refused with
  // "subagent Sessions require their durable parent address".
  const adapter = await startAdapter(t, {
    'session/list': () => ({
      ok: true,
      value: {
        items: [
          { sessionId: 'child-1', title: 'child', updatedAt: 1770000000000, running: false, parentSessionId: 'parent-1' },
          { sessionId: 'top-1', title: 'top', updatedAt: 1770000001000, running: false },
        ],
      },
    }),
    'session/page': () => ({ ok: true, value: { messages: [] } }),
  });
  await adapter.readSession('child-1');
  const childAddress = adapter.calls.filter((call) => call.method === 'session/page').at(-1).request.address;
  assert.deepEqual(childAddress, {
    kind: 'subagent',
    parentSessionId: 'parent-1',
    childSessionId: 'child-1',
    mode: 'unknown',
  });

  await adapter.readSession('top-1');
  const topAddress = adapter.calls.filter((call) => call.method === 'session/page').at(-1).request.address;
  assert.deepEqual(topAddress, { kind: 'session', sessionId: 'top-1' });
});

test('session/page really sends args.request, which is what the gateway demands', async (t) => {
  const adapter = await startAdapter(t, {
    'session/list': () => ({ ok: true, value: { items: [{ sessionId: 's-1', title: 'T', updatedAt: 1770000000000, running: false }] } }),
    'session/page': () => ({ ok: true, value: { messages: [] } }),
  });
  await adapter.readSession('s-1');
  const pageCall = adapter.calls.find((call) => call.method === 'session/page');
  assert.equal(pageCall.argField, 'request');
  const listCall = adapter.calls.find((call) => call.method === 'session/list');
  assert.equal(listCall.argField, '_request');
});

test('the page cut is a real log seq, never -1 (which reads nothing)', async (t) => {
  // Verified in the shipped controller: `throughSeq:-1` becomes an inclusive cut
  // of 0, so the page comes back empty. The list's own projections carry a real
  // seq, and that is what the page must be asked for.
  const adapter = await startAdapter(t, {
    'session/list': () => ({
      ok: true,
      value: {
        items: [
          {
            agentAvailable: true,
            sessionId: 's-1',
            updatedAt: 1770000000000,
            running: true,
            blank: false,
            projections: { kind: 'sequenced', asOfSeq: 4812, values: { title: 'Bridge work' } },
          },
        ],
      },
    }),
    'session/projections': () => ({ ok: true, value: { asOfSeq: 4812 } }),
    'session/page': () => ({
      ok: true,
      value: {
        records: [{ type: 'event', event: { type: 'user/message', seq: 4812, time: 1770000000000, data: { message: { role: 'user', content: [{ type: 'text', text: 'hello' }] } } } }],
        hasMore: false,
      },
    }),
  });
  const session = await adapter.readSession('s-1');
  const pageCall = adapter.calls.find((call) => call.method === 'session/page');
  assert.equal(pageCall.request.throughSeq, 4812, 'the cut is the log position the list reported');
  assert.equal(session.messages.length, 1);
  assert.equal(session.messages[0].id, '4812');
});

test('without a seq from the list, the adapter asks session/projections for one', async (t) => {
  const adapter = await startAdapter(t, {
    'session/list': () => ({
      ok: true,
      value: { items: [{ agentAvailable: true, sessionId: 's-2', updatedAt: 1770000000000, running: false, blank: false }] },
    }),
    'session/projections': () => ({ ok: true, value: { asOfSeq: 99, values: { title: 'Later' } } }),
    'session/page': () => ({ ok: true, value: { records: [], hasMore: false } }),
  });
  await adapter.readSession('s-2');
  const projectionsCall = adapter.calls.find((call) => call.method === 'session/projections');
  assert.ok(projectionsCall, 'the cut is fetched with the official projections call');
  assert.deepEqual(projectionsCall.request, { sessionId: 's-2' });
  const pageCall = adapter.calls.find((call) => call.method === 'session/page');
  assert.equal(pageCall.request.throughSeq, 99);
});

test('every read takes a fresh log cut, so a reply that arrives later is visible', async (t) => {
  // The phone polls `session.read` every 2 seconds. If the cut were cached from
  // the first list call, every later read would return the same old tail and the
  // answer to the user's message would never show up.
  let cut = 10;
  let pages = 0;
  const adapter = await startAdapter(
    t,
    {
      'session/list': () => ({
        ok: true,
        value: {
          items: [
            {
              agentAvailable: true,
              sessionId: 's-live',
              updatedAt: 1770000000000,
              running: true,
              blank: false,
              projections: { kind: 'sequenced', asOfSeq: cut, values: { title: 'Live' } },
            },
          ],
        },
      }),
      'session/projections': () => ({ ok: true, value: { asOfSeq: cut, values: { title: 'Live' } } }),
      'session/page': () => {
        pages += 1;
        return {
          ok: true,
          value: {
            records: [
              { type: 'event', event: { type: 'user/message', seq: 1, time: 1770000000000, data: { message: { role: 'user', content: [{ type: 'text', text: 'question' }] } } } },
              ...(cut > 10
                ? [
                    {
                      type: 'event',
                      event: {
                        type: 'assistant/message',
                        seq: cut,
                        time: 1770000002000,
                        data: { message: { role: 'assistant', content: [{ type: 'text', text: 'the answer' }] } },
                      },
                    },
                  ]
                : []),
            ],
            hasMore: false,
          },
        };
      },
    },
    { summaryTtlMs: 0 },
  );

  const first = await adapter.readSession('s-live');
  assert.equal(first.messages.length, 1);
  assert.equal(first.messages[0].text, 'question');

  // A new assistant message lands in the log while the phone is polling.
  cut = 11;
  const second = await adapter.readSession('s-live');
  assert.equal(second.messages.length, 2, 'the new reply is visible on the next read');
  assert.equal(second.messages[1].role, 'assistant');
  assert.equal(second.messages[1].text, 'the answer');
  assert.equal(second.messages[1].id, '11');
  const cuts = adapter.calls.filter((call) => call.method === 'session/page').map((call) => call.request.throughSeq);
  assert.deepEqual(cuts, [10, 11], 'each read asked for the cut that was current at that moment');
  assert.equal(pages, 2);
});

test('a session/page answer normalizes into contract sessions', async (t) => {
  const adapter = await startAdapter(t, {
    'session/list': () => ({
      ok: true,
      value: {
        items: [
          // The title really lives under projections.values.title; the shape below
          // is copied from the live backend's session/list answer.
          {
            agentAvailable: true,
            sessionId: 's-1',
            updatedAt: 1770000000000,
            running: true,
            blank: false,
            cwd: 'D:\\w',
            projections: { kind: 'cached', asOfSeq: 12, values: { title: 'Bridge work' } },
          },
          {
            agentAvailable: false,
            sessionId: 's-2',
            updatedAt: 1760000000000,
            running: false,
            blank: false,
            projections: { kind: 'cached', asOfSeq: 3, values: { title: null } },
          },
        ],
      },
    }),
  });
  const sessions = await adapter.listSessions();
  assert.equal(sessions.length, 2);
  assert.deepEqual(sessions[0], {
    id: 's-1',
    tool: 'dsh',
    title: 'Bridge work',
    status: 'working',
    updatedAt: '2026-02-02T02:40:00Z',
    cwd: 'D:\\w',
  });
  assert.equal(sessions[1].status, 'idle');
  assert.equal(sessions[1].cwd, null);
  assert.equal(sessions[1].title.length > 0, true, 'an empty title gets a safe fallback, never an empty string');
});

test('injected runtime context and skill catalog are filtered by their native source kind', async (t) => {
  // Real shapes from the live backend (docs/evidence/injection-shapes-20261008.log):
  //   a person -> data.source = {"kind":"user","rpcId":...,"clientTimeZone":...}
  //   injected -> data.source = {"kind":"runtime-context","form":"snapshot",...}
  //               data.source = {"kind":"skill-catalog","form":"catalog",...}
  // The filter uses that field only, never the text: a user who pastes similar
  // words must not lose their own message.
  const adapter = await startAdapter(t, {
    'session/list': () => ({
      ok: true,
      value: {
        items: [
          {
            agentAvailable: true,
            sessionId: 's-inj',
            updatedAt: 1770000000000,
            running: false,
            blank: false,
            projections: { kind: 'sequenced', asOfSeq: 4, values: { title: 'Injection' } },
          },
        ],
      },
    }),
    'session/page': () => ({
      ok: true,
      value: {
        records: [
          {
            type: 'event',
            event: {
              type: 'user/message',
              seq: 1,
              time: 1770000000000,
              data: { role: 'user', id: 'm1', source: { kind: 'user', rpcId: 'r-1' }, content: [{ type: 'text', text: 'hello from the person' }] },
            },
          },
          {
            type: 'event',
            event: {
              type: 'user/message',
              seq: 2,
              time: 1770000001000,
              data: {
                role: 'user',
                id: 'm2',
                source: { kind: 'runtime-context', form: 'snapshot', sections: [] },
                content: [{ type: 'text', text: 'Current runtime context' }],
              },
            },
          },
          {
            type: 'event',
            event: {
              type: 'user/message',
              seq: 3,
              time: 1770000002000,
              data: {
                role: 'user',
                id: 'm3',
                source: { kind: 'skill-catalog', form: 'catalog', entries: [] },
                content: [{ type: 'text', text: 'available_skills' }],
              },
            },
          },
          // No native marker at all: never guess, keep it.
          {
            type: 'event',
            event: {
              type: 'user/message',
              seq: 4,
              time: 1770000003000,
              data: { role: 'user', id: 'm4', content: [{ type: 'text', text: 'an older build sent no source kind' }] },
            },
          },
        ],
        hasMore: false,
      },
    }),
  });
  const session = await adapter.readSession('s-inj');
  assert.deepEqual(session.messages.map((message) => message.id), ['1', '4']);
  assert.equal(session.messages[0].text, 'hello from the person');
  assert.equal(session.messages[1].text, 'an older build sent no source kind');
});

test('session/page is read-only and maps events to roles with stable ids', async (t) => {
  const adapter = await startAdapter(t, {
    'session/list': () => ({
      ok: true,
      value: {
        items: [
          {
            agentAvailable: true,
            sessionId: 's-1',
            updatedAt: 1770000000000,
            running: true,
            blank: false,
            cwd: 'D:\\w',
            projections: { kind: 'cached', asOfSeq: 9, values: { title: 'Bridge work' } },
          },
        ],
      },
    }),
    // The real answer is `{records: [{type:'event', event:{type, seq, time, data}}], hasMore}`,
    // and the real event types are slash names whose payload is `data.message`
    // with `content` parts. Reasoning parts are not chat and must not become text.
    'session/page': () => ({
      ok: true,
      value: {
        records: [
          {
            type: 'event',
            event: {
              type: 'user/message',
              seq: 1,
              time: 1770000000000,
              data: { message: { role: 'user', content: [{ type: 'text', text: 'hello there' }], source: 'human', id: 'm1' } },
            },
          },
          {
            type: 'event',
            event: {
              type: 'assistant/message',
              seq: 2,
              time: 1770000001000,
              data: {
                message: {
                  role: 'assistant',
                  content: [{ type: 'reasoning', text: 'thinking quietly' }, { type: 'text', text: 'on it' }],
                  id: 'm2',
                },
              },
            },
          },
          {
            type: 'event',
            event: {
              type: 'tool/call',
              seq: 3,
              time: 1770000002000,
              data: { message: { role: 'tool', content: [{ type: 'text', text: 'run: node --test' }], id: 'm3' } },
            },
          },
          // Internal bookkeeping: it must never appear as a message.
          { type: 'event', event: { type: 'step/end', seq: 4, time: 1770000003000, data: { step: 'x' } } },
        ],
        hasMore: false,
      },
    }),
  });
  const session = await adapter.readSession('s-1');
  assert.equal(session.tool, 'dsh');
  assert.equal(session.status, 'working');
  assert.equal(session.messages.length, 3);
  assert.deepEqual(session.messages.map((message) => message.role), ['user', 'assistant', 'tool']);
  assert.deepEqual(session.messages.map((message) => message.id), ['1', '2', '3']);
  assert.equal(session.messages[0].text, 'hello there');
  assert.equal(session.messages[1].text, 'on it', 'the reasoning part is not mixed into the answer');
  assert.equal(session.messages[2].text, 'run: node --test');
  for (const message of session.messages) {
    assert.ok(!/^\[.*\]$/.test(message.text.trim()), `no placeholder text: ${message.text}`);
  }
  assert.equal(session.canStop, true, 'DSH really can cancel a running turn');
  assert.equal(session.activeTurnId, 's-1');
  const pageCall = adapter.calls.find((call) => call.method === 'session/page');
  assert.equal(pageCall.request.address.kind, 'session');
  assert.equal(pageCall.request.address.sessionId, 's-1');
  assert.ok(Number.isInteger(pageCall.request.throughSeq) && pageCall.request.throughSeq >= 0, 'a real log cut, never -1');
  assert.equal(pageCall.request.maxMessages, 200);
  assert.equal(pageCall.verified, true, 'the cookie the adapter minted was accepted');
});

test('sending goes to the same sessionId through session/prompt, and opens nothing new', async (t) => {
  const seen = [];
  const adapter = await startAdapter(t, {
    'session/prompt': (request) => {
      seen.push(request);
      return { ok: true, value: { accepted: true } };
    },
  });
  const result = await adapter.sendMessage('s-1', 'carry on');
  assert.deepEqual(result, { accepted: true, sessionId: 's-1' });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].sessionId, 's-1');
  assert.equal(seen[0].mode, 'queue');
  assert.deepEqual(seen[0].content, [{ type: 'text', text: 'carry on' }]);
  assert.match(seen[0].requestId, /^[0-9a-f-]{36}$/);
  assert.equal(typeof seen[0].clientTimeZone, 'string');
});

test('a send is attempted exactly once, never retried', async (t) => {
  let attempts = 0;
  const adapter = await startAdapter(t, {
    'session/prompt': () => {
      attempts += 1;
      return { ok: false, error: { code: 'rpc/timeout', message: 'no answer' } };
    },
  });
  await assert.rejects(() => adapter.sendMessage('s-1', 'x'));
  assert.equal(attempts, 1, 'a retry would post the message twice');
});

test('stopping uses session/cancel on the very same sessionId', async (t) => {
  const seen = [];
  const adapter = await startAdapter(t, {
    'session/cancel': (request) => {
      seen.push(request);
      return { ok: true, value: { accepted: true } };
    },
  });
  const result = await adapter.stopSession('s-1');
  assert.deepEqual(result, { accepted: true, sessionId: 's-1' });
  assert.deepEqual(seen, [{ sessionId: 's-1' }]);
});

test('a subagent session is sent through the official subagents/prompt path', async (t) => {
  const seen = [];
  const adapter = await startAdapter(t, {
    'subagents/prompt': (request) => {
      seen.push(request);
      return { ok: true, value: { accepted: true } };
    },
  });
  await adapter.sendMessage('child-1', 'hi', { parentSessionId: 'parent-1' });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].parentSessionId, 'parent-1');
  assert.equal(seen[0].childSessionId, 'child-1');
  assert.equal(seen[0].mode, 'continuable');
  assert.equal(seen[0].delivery, 'queue');
});

test('an rpc failure becomes a BridgeError with the backend code, sanitized', async (t) => {
  const adapter = await startAdapter(t, {
    'session/list': () => ({
      ok: true,
      value: { items: [{ sessionId: 's-9', title: 'gone soon', updatedAt: 1770000000000, running: false, projections: { asOfSeq: 7, values: { title: 'gone soon' } } }] },
    }),
    'session/page': () => ({ ok: false, error: { code: 'session/not-found', message: 'no session s-9 at C:\\Users\\Hi\\.dsh' } }),
  });
  const err = await adapter.readSession('s-9').catch((e) => e);
  assert.equal(err.code, 'session_not_found');
  assert.ok(!err.message.includes('C:\\Users'), err.message);
});

test('the adapter never logs or reports the browser secret', async (t) => {
  const adapter = await startAdapter(t, { 'session/list': () => ({ ok: true, value: { items: [] } }) });
  const rendered = JSON.stringify(adapter.describe()) + adapter.describe().toString();
  assert.ok(!rendered.includes(SECRET_TEXT), 'the credential never leaves the process');
  assert.equal(adapter.describe().secret, undefined);
});

/**
 * The real `%USERPROFILE%\.dsh\storages\workspace.json` shape, read-only on this
 * machine (6 entries): `{unit, global, tables:{workspaces:{[workspaceId]:{path,
 * title, sessionIds, createdAt, updatedAt}}}}`. The titles and ids in the
 * fixture are stand-ins of the same form; the mapping must not depend on any
 * particular value, and no test may ever touch the real file.
 */
const WORKSPACE_CATALOG = {
  unit: 'json',
  global: { version: 3 },
  tables: {
    workspaces: {
      'ws-0000000000000001': {
        path: 'D:\\workspace\\codex-workspace\\remote-control',
        title: 'remote-control',
        sessionIds: ['s-1'],
        createdAt: 1770000000000,
        updatedAt: 1770000001000,
      },
      'ws-0000000000000002': {
        path: 'D:\\workspace\\codex-workspace\\ai-connect',
        title: 'ai-connect',
        sessionIds: [],
        createdAt: 1770000000000,
        updatedAt: 1770000000000,
      },
      // No title: the name falls back to the last path segment.
      'ws-0000000000000003': {
        path: 'D:\\workspace\\inception-plan-1',
        title: '',
        sessionIds: [],
        createdAt: 1770000000000,
        updatedAt: 1770000000000,
      },
      'ws-0000000000000004': { path: 'D:\\workspace\\agent-learn', title: null, sessionIds: [] },
      'ws-0000000000000005': { path: 'D:\\workspace\\lifebot\\', title: '   ', sessionIds: [] },
      'ws-0000000000000006': { path: 'C:\\work\\trailing-slash', title: 'Sixth', sessionIds: [] },
    },
  },
};

/** Write a throwaway fixture; the real catalog file is never read or written. */
function writeFixture(name, contents) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-workspace-test-'));
  const file = path.join(dir, name);
  fs.writeFileSync(file, contents, 'utf8');
  return file;
}

test('the real workspace catalog shape maps to projects: id, title and path', () => {
  const parsed = parseWorkspaceCatalog(WORKSPACE_CATALOG);
  assert.equal(parsed.reason, null);
  assert.equal(parsed.skipped, 0);
  assert.deepEqual(
    parsed.projects.map((project) => project.name),
    ['remote-control', 'ai-connect', 'inception-plan-1', 'agent-learn', 'lifebot', 'Sixth'],
  );
  assert.deepEqual(parsed.projects[0], {
    id: 'ws-0000000000000001',
    name: 'remote-control',
    cwd: 'D:\\workspace\\codex-workspace\\remote-control',
  });
  assert.equal(parsed.projects[2].name, 'inception-plan-1', 'an empty title falls back to the last path segment');
  assert.equal(parsed.projects[3].name, 'agent-learn', 'a null title falls back to the last path segment');
  assert.equal(parsed.projects[4].name, 'lifebot', 'a blank title falls back to the last non-empty segment, even with a trailing separator');
  assert.equal(parsed.projects[5].cwd, 'C:\\work\\trailing-slash', 'the path is carried through unchanged');
});

test('a catalog whose shape is not the real one is refused, never guessed at', () => {
  for (const broken of [null, 42, 'text', [], {}, { tables: {} }, { tables: { workspaces: [] } }, { tables: { workspaces: 'nope' } }]) {
    const parsed = parseWorkspaceCatalog(broken);
    assert.deepEqual(parsed.projects, [], `no project may be invented from ${JSON.stringify(broken)}`);
    assert.equal(typeof parsed.reason, 'string');
    assert.ok(parsed.reason.length > 0);
    assert.ok(!/[A-Za-z]:\\/.test(parsed.reason), 'a reason never carries a local path');
  }
  // A workspace entry that carries no path cannot become a project, and saying so
  // is honest; inventing a cwd would not be.
  const partial = parseWorkspaceCatalog({ tables: { workspaces: { 'ws-1': { title: 'No path' }, 'ws-2': { path: 'D:\\ok', title: 'Ok' }, 'ws-3': null } } });
  assert.deepEqual(partial.projects, [{ id: 'ws-2', name: 'Ok', cwd: 'D:\\ok' }]);
  assert.equal(partial.skipped, 2);
});

test('the catalog is read from DSH_HOME, and an explicit path wins over it', () => {
  assert.equal(workspaceCatalogPath({ env: {}, homeDir: 'C:\\Users\\someone' }), 'C:\\Users\\someone\\.dsh\\storages\\workspace.json');
  assert.equal(workspaceCatalogPath({ env: { DSH_HOME: 'D:\\dsh-home' }, homeDir: 'C:\\Users\\someone' }), 'D:\\dsh-home\\storages\\workspace.json');
  assert.equal(workspaceCatalogPath({ configuredPath: 'E:\\mine\\ws.json', env: { DSH_HOME: 'D:\\dsh-home' } }), 'E:\\mine\\ws.json');
});

test('a real fixture file is read into projects, and the real file is never touched', async () => {
  const file = writeFixture('workspace.json', JSON.stringify(WORKSPACE_CATALOG));
  try {
    const read = await readWorkspaceCatalog({ path: file });
    assert.equal(read.source, 'workspace.json');
    assert.equal(read.reason, null);
    assert.equal(read.projects.length, 6);
    assert.equal(read.projects[1].cwd, 'D:\\workspace\\codex-workspace\\ai-connect');
  } finally {
    fs.rmSync(path.dirname(file), { recursive: true, force: true });
  }
});

test('a missing, unreadable, corrupt or oversized catalog is an empty list with a reason', async () => {
  const missing = await readWorkspaceCatalog({ path: path.join(os.tmpdir(), `dsh-workspace-missing-${crypto.randomUUID()}`, 'workspace.json') });
  assert.deepEqual(missing.projects, []);
  assert.equal(typeof missing.reason, 'string');

  const corruptFile = writeFixture('workspace.json', '{ this is not json');
  const wrongShapeFile = writeFixture('workspace.json', JSON.stringify({ tables: { workspaces: [] } }));
  const oversizedFile = writeFixture('workspace.json', 'x'.repeat(WORKSPACE_CATALOG_MAX_BYTES + 1));
  try {
    for (const file of [corruptFile, wrongShapeFile, oversizedFile]) {
      const read = await readWorkspaceCatalog({ path: file });
      assert.deepEqual(read.projects, [], `${file} must not yield a project`);
      assert.equal(typeof read.reason, 'string');
      assert.ok(!read.reason.includes(file), 'the reason is a safe sentence, not a local path');
    }
  } finally {
    for (const file of [corruptFile, wrongShapeFile, oversizedFile]) fs.rmSync(path.dirname(file), { recursive: true, force: true });
  }

  // A valid catalog that simply holds no workspace is not a failure: no reason.
  const emptyFile = writeFixture('workspace.json', JSON.stringify({ unit: 'json', tables: { workspaces: {} } }));
  try {
    const empty = await readWorkspaceCatalog({ path: emptyFile });
    assert.deepEqual(empty.projects, []);
    assert.equal(empty.reason, null, 'an empty catalog is empty, not broken');
  } finally {
    fs.rmSync(path.dirname(emptyFile), { recursive: true, force: true });
  }
});

test('a catalog read that never finishes is bounded by its deadline', async () => {
  const started = Date.now();
  const read = await readWorkspaceCatalog({
    path: 'E:\\never-read',
    timeoutMs: 50,
    stat: async () => ({ isFile: () => true, size: 10 }),
    readFile: () => new Promise(() => {}),
  });
  assert.deepEqual(read.projects, []);
  assert.equal(typeof read.reason, 'string');
  assert.ok(Date.now() - started < 5000, 'the deadline ends the read instead of hanging for ever');
});

test('the DSH models.list carries the registered projects beside the models', async (t) => {
  const file = writeFixture('workspace.json', JSON.stringify(WORKSPACE_CATALOG));
  t.after(() => fs.rmSync(path.dirname(file), { recursive: true, force: true }));
  const adapter = await startAdapter(
    t,
    {
      'session/modelCatalog': () => ({
        ok: true,
        value: { default: { provider: 'deepseek-account', model: 'deepseek-flash' }, groups: [{ id: 'deepseek-account', models: [{ id: 'deepseek-flash', name: 'Flash' }] }] },
      }),
    },
    { workspaceCatalogPath: file },
  );
  const listed = await adapter.listModels();
  assert.equal(listed.models.length, 1);
  assert.equal(listed.projects.length, 6, 'the registered DSH workspaces reach models.list');
  assert.equal(listed.projects[3].name, 'agent-learn');
  assert.equal(listed.reason, null);
});

test('an unreadable DSH catalog leaves the models intact and reports a reason', async (t) => {
  const adapter = await startAdapter(
    t,
    {
      'session/modelCatalog': () => ({ ok: true, value: { groups: [{ id: 'p', models: [{ id: 'm', name: 'M' }] }] } }),
    },
    { workspaceCatalogPath: path.join(os.tmpdir(), `dsh-workspace-gone-${crypto.randomUUID()}`, 'workspace.json') },
  );
  const listed = await adapter.listModels();
  assert.equal(listed.models.length, 1, 'a missing project catalog must not cost the model catalog');
  assert.deepEqual(listed.projects, []);
  assert.equal(typeof listed.reason, 'string');
});

/** Verify a minted cookie the way the DSH server does. */
function verifyCookie(value, secret) {
  const parts = String(value ?? '').split('.');
  if (parts.length !== 3 || parts[0] !== 'v1') return false;
  const expected = crypto.createHmac('sha256', secret).update(parts[1]).digest();
  const actual = Buffer.from(parts[2].replaceAll('-', '+').replaceAll('_', '/'), 'base64');
  if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) return false;
  const payload = JSON.parse(Buffer.from(parts[1].replaceAll('-', '+').replaceAll('_', '/'), 'base64').toString('utf8'));
  return payload.version === 1 && payload.expiresAt > Date.now();
}

/**
 * Start a fake DSH backend that verifies the cookie and answers the methods the
 * test registered. Only the DSH server is mocked; the adapter, the HTTP request,
 * the cookie and every mapping decision are real.
 */
async function startAdapter(t, handlers, adapterOptions = {}) {
  // Every read asks session/projections for the current log cut, so a fixture that
  // does not care about the exact position still needs an answer for it.
  handlers = { 'session/projections': () => ({ ok: true, value: { asOfSeq: 1 } }), ...handlers };
  const calls = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      const parsed = body ? JSON.parse(body) : {};
      const [name, value] = String(req.headers.cookie ?? '').split('=');
      const args = parsed.payload?.args ?? {};
      const request = args.request ?? args._request;
      const verified = name === cookieName(req.headers.host) && verifyCookie(value, SECRET_BYTES);
      calls.push({ method: parsed.method, request, args, argField: 'request' in args ? 'request' : '_request', verified });
      const handler = handlers[parsed.method];
      if (!verified) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end('{"error":{"code":"unauthenticated"}}');
        return;
      }
      if (handler === undefined) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ result: { ok: false, error: { code: 'method/unknown', message: 'nope' } } }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ result: handler(request ?? {}) }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const adapter = new DshAdapter({
    client: new DshClient({ baseUrl: `http://127.0.0.1:${port}`, secret: SECRET_BYTES }),
    backend: { port, pid: 1234, baseUrl: `http://127.0.0.1:${port}` },
    ...adapterOptions,
  });
  adapter.calls = calls;
  return adapter;
}






/**
 * The native fixtures one waiting question needs: the session is listed, its
 * projections carry the batch, and the page is empty. Nothing here is invented -
 * the batch shape is `dsh-user-questions/lib/types/projection.js`.
 */
const CONTINUED_BATCH = {
  callId: 'call-9',
  state: 'continued',
  questions: [
    { id: 'q-1', question: 'Which one?', header: 'Choice', detail: 'Pick one', options: [{ label: 'One', description: 'the first' }, { label: 'Two' }] },
    { id: 'q-2', question: 'Anything to add?', multiSelect: true, options: [{ label: 'Yes' }, { label: 'No' }] },
  ],
};

function questionFixtures(active, extra = {}) {
  return {
    'session/list': () => ({
      ok: true,
      value: {
        items: [
          {
            agentAvailable: true,
            sessionId: 's-q',
            updatedAt: 1770000000000,
            running: false,
            blank: false,
            projections: { kind: 'sequenced', asOfSeq: 5, values: { title: 'Waiting' } },
          },
        ],
      },
    }),
    'session/projections': () => ({ ok: true, value: { asOfSeq: 5, values: { userQuestions: { active, settled: [] } } } }),
    'session/page': () => ({ ok: true, value: { records: [], hasMore: false } }),
    ...extra,
  };
}

test('the direct-args helper sends the descriptor parameters, never a request wrapper', () => {
  assert.deepEqual(argPayload('session/page', { sessionId: 's-1' }), { request: { sessionId: 's-1' } });
  assert.deepEqual(argPayload('session/list', {}), { _request: {} });
  assert.deepEqual(argPayload('session/modelCatalog', {}), {});
  const args = { agentId: 's-1', callId: 'c-1', answer: { answers: [] } };
  assert.deepEqual(argPayload('userQuestions/answer', args), args);
});

test('a pending batch is read from real native state, with both accepted view shapes', () => {
  assert.equal(activeQuestionBatches({ active: [CONTINUED_BATCH], settled: [] }).length, 1);
  assert.equal(activeQuestionBatches({ questions: { active: [CONTINUED_BATCH] } }).length, 1, 'the internal state shape reads the same field');
  assert.deepEqual(activeQuestionBatches(null), []);
  const mapped = mapPendingQuestions({ active: [CONTINUED_BATCH] });
  assert.deepEqual(mapped[0].callId, 'call-9');
  assert.equal(mapped[0].state, 'continued');
  assert.deepEqual(mapped[0].questions[1].options, [{ label: 'Yes' }, { label: 'No' }]);
  assert.equal(mapped[0].questions[1].multiSelect, true);
  assert.equal(mapPendingQuestions({ active: [] }), undefined, 'nothing waiting means no field at all');
});

test('currentModel is the native next selection, never a chosen-but-unused guess', () => {
  assert.deepEqual(
    currentModelOf({ lastUsed: { provider: 'p', model: 'old' }, next: { provider: 'p', model: 'new', reasoningEffort: 'high' } }),
    { model: 'new', provider: 'p', reasoningEffort: 'high' },
  );
  assert.deepEqual(currentModelOf({ lastUsed: { provider: 'p', model: 'used' }, next: null }), { model: 'used', provider: 'p' });
  assert.equal(currentModelOf({ lastUsed: null, next: null }), undefined);
  assert.equal(currentModelOf(null), undefined);
});

test('session.read carries the native current model and the native pending questions', async (t) => {
  const adapter = await startAdapter(t, {
    'session/list': () => ({
      ok: true,
      value: {
        items: [
          {
            agentAvailable: true,
            sessionId: 's-q',
            updatedAt: 1770000000000,
            running: false,
            blank: false,
            projections: { kind: 'sequenced', asOfSeq: 5, values: { title: 'Waiting' } },
          },
        ],
      },
    }),
    'session/projections': () => ({
      ok: true,
      value: {
        asOfSeq: 5,
        values: {
          modelSelection: { lastUsed: { provider: 'deepseek-account', model: 'deepseek-v4-pro' }, next: { provider: 'deepseek-account', model: 'deepseek-flash', reasoningEffort: 'high' } },
          userQuestions: { active: [CONTINUED_BATCH], settled: [] },
        },
      },
    }),
    'session/page': () => ({ ok: true, value: { records: [], hasMore: false } }),
  });
  const session = await adapter.readSession('s-q');
  assert.deepEqual(session.currentModel, { model: 'deepseek-flash', provider: 'deepseek-account', reasoningEffort: 'high' });
  assert.equal(session.pendingQuestions.length, 1);
  assert.equal(session.pendingQuestions[0].questions[0].header, 'Choice');
});

test('a question form too large for the phone refuses the whole read, never a trimmed form', async (t) => {
  const oversized = {
    ...CONTINUED_BATCH,
    questions: [{ id: 'q-1', question: 'x', options: Array.from({ length: PENDING_LIMITS.options + 1 }, (_, i) => ({ label: `l-${i}` })) }],
  };
  const adapter = await startAdapter(t, questionFixtures([oversized]));
  const err = await adapter.readSession('s-q').catch((error) => error);
  assert.equal(err.code, 'bridge_error');
  assert.match(err.message, /cannot show in full|too large/i);

  const longText = { ...CONTINUED_BATCH, questions: [{ id: 'q-1', question: 'x'.repeat(PENDING_LIMITS.questionText + 1) }] };
  const second = await startAdapter(t, questionFixtures([longText]));
  const longErr = await second.readSession('s-q').catch((error) => error);
  assert.equal(longErr.code, 'bridge_error');

  const unknownState = { ...CONTINUED_BATCH, state: 'pending' };
  const third = await startAdapter(t, questionFixtures([unknownState]));
  const stateErr = await third.readSession('s-q').catch((error) => error);
  assert.equal(stateErr.code, 'bridge_error');
});

test('sessions.list derives needsInput from real native pending state only', async (t) => {
  const waiting = await startAdapter(t, {
    'session/list': () => ({
      ok: true,
      value: {
        items: [
          { sessionId: 's-q', title: 'Waiting', updatedAt: 1770000000000, running: false, projections: { asOfSeq: 5, values: { title: 'Waiting', userQuestions: { active: [CONTINUED_BATCH], settled: [] } } } },
          { sessionId: 's-quiet', title: 'Quiet', updatedAt: 1770000000001, running: false, projections: { asOfSeq: 6, values: { title: 'Quiet', userQuestions: { active: [], settled: [] } } } },
        ],
      },
    }),
  });
  const sessions = await waiting.listSessions();
  assert.equal(sessions.find((session) => session.id === 's-q').needsInput, true);
  assert.equal(sessions.find((session) => session.id === 's-quiet').needsInput, undefined, 'an empty projection is not evidence of a question');
});

test('answering a continued question uses the direct userQuestions/answer transport', async (t) => {
  const adapter = await startAdapter(
    t,
    questionFixtures([CONTINUED_BATCH], {
      'userQuestions/answer': () => ({ ok: true, value: true }),
    }),
  );
  const result = await adapter.answerQuestion('s-q', 'call-9', [
    { id: 'q-1', selected: ['One'] },
    { id: 'q-2', selected: ['Yes', 'No'], custom: 'both, somehow' },
  ]);
  assert.deepEqual(result, { accepted: true, sessionId: 's-q', callId: 'call-9' });
  const call = adapter.calls.find((entry) => entry.method === 'userQuestions/answer');
  assert.ok(call, 'the answer really crossed the wire');
  assert.deepEqual(call.args, {
    agentId: 's-q',
    callId: 'call-9',
    answer: {
      answers: [
        { id: 'q-1', selected: ['One'] },
        { id: 'q-2', selected: ['Yes', 'No'], custom: 'both, somehow' },
      ],
    },
  });
  assert.equal('request' in call.args, false, 'the descriptor is a direct invocation: no request wrapper');
  // The fake backend's own `request` view is empty for this method - which is
  // exactly the point: the args above are the only thing that carried the answer.
  assert.equal('request' in call.args || '_request' in call.args, false);
});

test('an answer is refused unless the call is really waiting, continued, and native says yes', async (t) => {
  // A stale callId: nothing is sent to the backend at all.
  const stale = await startAdapter(t, questionFixtures([CONTINUED_BATCH], { 'userQuestions/answer': () => ({ ok: true, value: true }) }));
  const staleErr = await stale.answerQuestion('s-q', 'call-gone', [{ id: 'q-1', selected: [] }]).catch((error) => error);
  assert.equal(staleErr.code, 'session_not_found');
  assert.equal(stale.calls.some((entry) => entry.method === 'userQuestions/answer'), false, 'a stale call never reaches the backend');

  // An open question can only be answered inside the app.
  const open = await startAdapter(t, questionFixtures([{ ...CONTINUED_BATCH, state: 'open' }], { 'userQuestions/answer': () => ({ ok: true, value: true }) }));
  const openErr = await open.answerQuestion('s-q', 'call-9', [{ id: 'q-1', selected: ['One'] }, { id: 'q-2', selected: [] }]).catch((error) => error);
  assert.equal(openErr.code, 'not_capable');
  assert.equal(open.calls.some((entry) => entry.method === 'userQuestions/answer'), false);

  // A label the native form never offered, and a batch that does not name every
  // question exactly once.
  const adapter = await startAdapter(t, questionFixtures([CONTINUED_BATCH], { 'userQuestions/answer': () => ({ ok: true, value: true }) }));
  const badLabel = await adapter.answerQuestion('s-q', 'call-9', [{ id: 'q-1', selected: ['Three'] }, { id: 'q-2', selected: [] }]).catch((error) => error);
  assert.equal(badLabel.code, 'invalid_params');
  const shortBatch = await adapter.answerQuestion('s-q', 'call-9', [{ id: 'q-1', selected: ['One'] }]).catch((error) => error);
  assert.equal(shortBatch.code, 'invalid_params');
  const unknownId = await adapter.answerQuestion('s-q', 'call-9', [{ id: 'q-1', selected: ['One'] }, { id: 'q-9', selected: [] }]).catch((error) => error);
  assert.equal(unknownId.code, 'invalid_params');
  const tooManySelections = await adapter.answerQuestion('s-q', 'call-9', [{ id: 'q-1', selected: ['One', 'Two'] }, { id: 'q-2', selected: [] }]).catch((error) => error);
  assert.equal(tooManySelections.code, 'invalid_params', 'a single-select question takes one label');
  assert.equal(adapter.calls.some((entry) => entry.method === 'userQuestions/answer'), false, 'no refused answer is ever sent');

  // The native boolean is the only acceptance signal.
  const refused = await startAdapter(t, questionFixtures([CONTINUED_BATCH], { 'userQuestions/answer': () => ({ ok: true, value: false }) }));
  const refusedErr = await refused.answerQuestion('s-q', 'call-9', [{ id: 'q-1', selected: ['One'] }, { id: 'q-2', selected: [] }]).catch((error) => error);
  assert.equal(refusedErr.code, 'bridge_error');
  assert.equal(refused.calls.filter((entry) => entry.method === 'userQuestions/answer').length, 1, 'a false is never retried');
});

test('a subagent question is refused before anything is sent', async (t) => {
  const adapter = await startAdapter(t, {
    'session/list': () => ({
      ok: true,
      value: { items: [{ sessionId: 'child-1', parentSessionId: 'parent-1', title: 'child', updatedAt: 1770000000000, running: false }] },
    }),
  });
  const err = await adapter.answerQuestion('child-1', 'call-9', [{ id: 'q-1', selected: [] }]).catch((error) => error);
  assert.equal(err.code, 'not_capable');
  assert.equal(adapter.calls.some((entry) => entry.method === 'userQuestions/answer'), false);
});

test('a selected DSH project is validated live and sent as workspaceId only', async (t) => {
  const file = writeFixture('workspace.json', JSON.stringify(WORKSPACE_CATALOG));
  t.after(() => fs.rmSync(path.dirname(file), { recursive: true, force: true }));
  const created = [];
  const adapter = await startAdapter(
    t,
    {
      'session/create': (request) => {
        created.push(request);
        return { ok: true, value: { sessionId: 's-new' } };
      },
      'session/selectModel': () => ({ ok: true, value: { selected: {} } }),
      'session/prompt': () => ({ ok: true, value: { accepted: true } }),
    },
    { workspaceCatalogPath: file },
  );

  // projectId + the directory it really is: one field crosses, and it is the id.
  const outcome = await adapter.createSession({
    model: 'm',
    provider: 'p',
    projectId: 'ws-0000000000000002',
    cwd: 'D:\\workspace\\codex-workspace\\ai-connect',
  });
  assert.equal(outcome.sessionId, 's-new');
  assert.deepEqual(created[0], { workspaceId: 'ws-0000000000000002' });
  assert.equal('cwd' in created[0], false, 'the native create rejects workspaceId and cwd together, so only one is ever sent');

  // projectId alone.
  await adapter.createSession({ model: 'm', provider: 'p', projectId: 'ws-0000000000000003' });
  assert.deepEqual(created[1], { workspaceId: 'ws-0000000000000003' });

  // cwd alone, naming a registered workspace: the id is preferred, once.
  await adapter.createSession({ model: 'm', provider: 'p', cwd: 'D:\\workspace\\lifebot\\' });
  assert.deepEqual(created[2], { workspaceId: 'ws-0000000000000005' });

  // cwd alone, not registered: the directory itself, still the only field.
  await adapter.createSession({ model: 'm', provider: 'p', cwd: 'E:\\unregistered\\place' });
  assert.deepEqual(created[3], { cwd: 'E:\\unregistered\\place' });

  // No project and no directory at all: the old empty request, unchanged.
  await adapter.createSession({ model: 'm', provider: 'p' });
  assert.deepEqual(created[4], {});
  assert.equal(created.length, 5, 'nothing was created twice');
});

test('an unknown or contradicted DSH project is refused before any session exists', async (t) => {
  const file = writeFixture('workspace.json', JSON.stringify(WORKSPACE_CATALOG));
  t.after(() => fs.rmSync(path.dirname(file), { recursive: true, force: true }));
  const created = [];
  const adapter = await startAdapter(
    t,
    {
      'session/create': (request) => {
        created.push(request);
        return { ok: true, value: { sessionId: 's-new' } };
      },
    },
    { workspaceCatalogPath: file },
  );

  const unknown = await adapter.createSession({ model: 'm', provider: 'p', projectId: 'ws-not-registered' }).catch((error) => error);
  assert.equal(unknown.code, 'session_create_failed');
  const contradicted = await adapter
    .createSession({ model: 'm', provider: 'p', projectId: 'ws-0000000000000002', cwd: 'D:\\workspace\\codex-workspace\\remote-control' })
    .catch((error) => error);
  assert.equal(contradicted.code, 'session_create_failed');
  assert.equal(created.length, 0, 'an unvalidated project never reaches native create');
});

test('a send with a model selects it first, prompts once, and never retries', async (t) => {
  const adapter = await startAdapter(t, {
    'session/list': () => ({
      ok: true,
      value: { items: [{ sessionId: 's-1', title: 'T', updatedAt: 1770000000000, running: false, projections: { asOfSeq: 3, values: { title: 'T' } } }] },
    }),
    'session/modelCatalog': () => ({
      ok: true,
      value: { groups: [{ id: 'deepseek-account', models: [{ id: 'deepseek-flash', name: 'Flash', reasoning: ['low', 'high'] }] }] },
    }),
    'session/selectModel': (request) => ({ ok: true, value: { selected: request } }),
    'session/prompt': () => ({ ok: true, value: { accepted: true } }),
  });
  const result = await adapter.sendMessage('s-1', 'carry on', { model: 'deepseek-flash', provider: 'deepseek-account', reasoningEffort: 'high' });
  assert.deepEqual(result, { accepted: true, sessionId: 's-1' });
  const order = adapter.calls.filter((call) => call.method.startsWith('session/')).map((call) => call.method);
  assert.deepEqual(order, ['session/list', 'session/modelCatalog', 'session/selectModel', 'session/prompt']);
  const select = adapter.calls.find((call) => call.method === 'session/selectModel');
  assert.deepEqual(select.request, { sessionId: 's-1', provider: 'deepseek-account', model: 'deepseek-flash', reasoningEffort: 'high' });
  const prompt = adapter.calls.find((call) => call.method === 'session/prompt');
  assert.deepEqual(prompt.request.content, [{ type: 'text', text: 'carry on' }]);
  assert.equal(adapter.calls.filter((call) => call.method === 'session/prompt').length, 1, 'one send, never a retry');
});

test('a plain send keeps the old behaviour: no catalogue, no selection, one prompt', async (t) => {
  const adapter = await startAdapter(t, {
    'session/prompt': () => ({ ok: true, value: { accepted: true } }),
  });
  const result = await adapter.sendMessage('s-1', 'carry on');
  assert.deepEqual(result, { accepted: true, sessionId: 's-1' });
  assert.equal(adapter.calls.some((call) => call.method === 'session/modelCatalog'), false);
  assert.equal(adapter.calls.some((call) => call.method === 'session/selectModel'), false);
  assert.equal(adapter.calls.filter((call) => call.method === 'session/prompt').length, 1);
});

test('a model that cannot be selected stops the send: no prompt is ever posted', async (t) => {
  const notListed = await startAdapter(t, {
    'session/list': () => ({
      ok: true,
      value: { items: [{ sessionId: 's-1', title: 'T', updatedAt: 1770000000000, running: false, projections: { asOfSeq: 3, values: { title: 'T' } } }] },
    }),
    'session/modelCatalog': () => ({ ok: true, value: { groups: [{ id: 'deepseek-account', models: [{ id: 'deepseek-flash', name: 'Flash' }] }] } }),
    'session/selectModel': () => ({ ok: true, value: {} }),
    'session/prompt': () => ({ ok: true, value: { accepted: true } }),
  });
  // The provider identity is what identifies a model here, so a wrong provider
  // is refused exactly like an unknown model.
  const wrongProvider = await notListed.sendMessage('s-1', 'x', { model: 'deepseek-flash', provider: 'somebody-else' }).catch((error) => error);
  assert.equal(wrongProvider.code, 'model_not_available');
  const wrongModel = await notListed.sendMessage('s-1', 'x', { model: 'deepseek-nowhere', provider: 'deepseek-account' }).catch((error) => error);
  assert.equal(wrongModel.code, 'model_not_available');
  const wrongEffort = await notListed
    .sendMessage('s-1', 'x', { model: 'deepseek-flash', provider: 'deepseek-account', reasoningEffort: 'ultra' })
    .catch((error) => error);
  assert.equal(wrongEffort.code, 'invalid_params');
  assert.equal(notListed.calls.some((call) => call.method === 'session/prompt'), false, 'nothing was posted with a model nobody could check');

  // The native selection itself failing is the same rule: no prompt.
  const selectionFails = await startAdapter(t, {
    'session/list': () => ({
      ok: true,
      value: { items: [{ sessionId: 's-1', title: 'T', updatedAt: 1770000000000, running: false, projections: { asOfSeq: 3, values: { title: 'T' } } }] },
    }),
    'session/modelCatalog': () => ({ ok: true, value: { groups: [{ id: 'p', models: [{ id: 'm', name: 'M' }] }] } }),
    'session/selectModel': () => ({ ok: false, error: { code: 'session/not-found', message: 'no session' } }),
    'session/prompt': () => ({ ok: true, value: { accepted: true } }),
  });
  const failed = await selectionFails.sendMessage('s-1', 'x', { model: 'm', provider: 'p' }).catch((error) => error);
  assert.equal(failed.code, 'session_not_found');
  assert.equal(selectionFails.calls.some((call) => call.method === 'session/prompt'), false, 'a failed selection means NO prompt');
});

test('a model override is refused for a subagent or a working session, before anything is sent', async (t) => {
  const child = await startAdapter(t, {
    'session/list': () => ({
      ok: true,
      value: { items: [{ sessionId: 'child-1', parentSessionId: 'parent-1', title: 'child', updatedAt: 1770000000000, running: false }] },
    }),
    'session/modelCatalog': () => ({ ok: true, value: { groups: [] } }),
  });
  const childErr = await child.sendMessage('child-1', 'x', { model: 'm', provider: 'p' }).catch((error) => error);
  assert.equal(childErr.code, 'not_capable');
  assert.equal(child.calls.some((call) => call.method === 'session/modelCatalog'), false);

  const busy = await startAdapter(t, {
    'session/list': () => ({
      ok: true,
      value: { items: [{ sessionId: 's-1', title: 'T', updatedAt: 1770000000000, running: true, projections: { asOfSeq: 3, values: { title: 'T' } } }] },
    }),
    'session/prompt': () => ({ ok: true, value: { accepted: true } }),
  });
  const busyErr = await busy.sendMessage('s-1', 'x', { model: 'm', provider: 'p' }).catch((error) => error);
  assert.equal(busyErr.code, 'bridge_error');
  assert.match(busyErr.message, /working/i);
  assert.equal(busy.calls.some((call) => call.method === 'session/prompt'), false, 'a working session is never interrupted or retried');
});

const APPROVAL_ID = '11111111-2222-4333-8444-555555555555';
const OTHER_APPROVAL_ID = '99999999-8888-4777-8666-555555555555';
const THIRD_APPROVAL_ID = '77777777-6666-4555-8444-333333333333';
/**
 * The native `ApprovalRequestId`s, which are **not** the ids on the wire.
 *
 * `dsh-user-approval` mints its own `randomUUID()` for the `approval/asked` +
 * `approval/decided` pair (installed `lib/index.js`, `request()`), the request it
 * forwards carries no id at all, and the id the phone sees is the **Gateway's**
 * event id for that forwarded waterfall. A fixture that reuses one value for all
 * three could not tell a real correlation from a comparison of two unrelated ids,
 * so every fixture here keeps them distinct.
 */
const NATIVE_AUDIT_ID = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';
const OTHER_SAME_TOOL_AUDIT_ID = '0f1e2d3c-4b5a-4968-8776-5a4b3c2d1e0f';
const STALE_AUDIT_ID = '1a2b3c4d-5e6f-4a7b-8c8d-9e0f1a2b3c4e';
/** One native approval request, exactly as `dsh-user-approval` raises it. */
const APPROVAL = { id: APPROVAL_ID, toolName: 'run_command', callId: 'call-7', reason: 'needs to run one command' };

/**
 * A stand-in for the native event stream: the adapter's own dependency, with the
 * same surface the real stream has, so the adapter's routing - not a socket - is
 * what these tests exercise.
 */
function fakeEvents(overrides = {}) {
  const calls = { approvals: [], answers: [], closed: 0 };
  const events = {
    calls,
    approvals: [APPROVAL],
    waits: new Set(['call-9']),
    /** The held legacy question of one session, if any; empty means none. */
    legacyWaits: [],
    start: () => events,
    close: () => {
      calls.closed += 1;
    },
    describe: () => ({ connected: true, approvals: events.approvals.length, questionWaits: events.waits.size + events.legacyWaits.length }),
    approvalsFor: (sessionId) => (sessionId === 's-q' ? events.approvals : []),
    hasQuestionWait: (sessionId, callId) => sessionId === 's-q' && events.waits.has(callId),
    hasLegacyQuestion: (sessionId) => sessionId === 's-q' && events.legacyWaits.length > 0,
    unresolvedLegacyQuestionWaitsFor: (sessionId) => (sessionId === 's-q' ? events.legacyWaits : []),
    answerableQuestionCalls: (sessionId) => new Set(sessionId === 's-q' ? [...events.waits] : []),
    submitApproval: async (input) => {
      calls.approvals.push(input);
      // The real stream drops its local card before its RPC
      // (`DshEventStream.submitApproval`), so one request is decided only once.
      events.approvals = events.approvals.filter((approval) => approval.id !== input.approvalId);
      return { accepted: true, state: 'submitted' };
    },
    submitQuestionAnswer: async (input) => {
      calls.answers.push(input);
      return { accepted: true };
    },
    ...overrides,
  };
  return events;
}

test('session.read carries the real pending approvals of that session, and nothing when none wait', async (t) => {
  const events = fakeEvents();
  const adapter = await startAdapter(t, questionFixtures([CONTINUED_BATCH]), { events });
  const session = await adapter.readSession('s-q');
  assert.deepEqual(session.pendingApprovals, [APPROVAL]);

  // Another session has none: the field is simply absent.
  const quiet = await startAdapter(t, {
    'session/list': () => ({
      ok: true,
      value: { items: [{ sessionId: 's-other', title: 'Other', updatedAt: 1770000000000, running: false, projections: { asOfSeq: 5, values: { title: 'Other' } } }] },
    }),
    'session/page': () => ({ ok: true, value: { records: [], hasMore: false } }),
  }, { events });
  assert.equal((await quiet.readSession('s-other')).pendingApprovals, undefined);

  // Without a stream there is no approval surface at all - and no invention.
  const streamless = await startAdapter(t, questionFixtures([CONTINUED_BATCH]));
  assert.equal((await streamless.readSession('s-q')).pendingApprovals, undefined);
  assert.equal(streamless.canApprove(), true, 'the ability is real even before the stream is up');
  assert.deepEqual(streamless.pendingApprovalsOf('s-q'), []);
});

test('needsInput is the union of real pending questions and real pending approvals', async (t) => {
  const events = fakeEvents({ approvals: [APPROVAL] });
  const adapter = await startAdapter(t, {
    'session/list': () => ({
      ok: true,
      value: {
        items: [
          { sessionId: 's-q', title: 'Approval only', updatedAt: 1770000000000, running: false, projections: { asOfSeq: 5, values: { title: 'Approval only', userQuestions: { active: [], settled: [] } } } },
          { sessionId: 's-quiet', title: 'Quiet', updatedAt: 1770000000001, running: false, projections: { asOfSeq: 6, values: { title: 'Quiet', userQuestions: { active: [], settled: [] } } } },
        ],
      },
    }),
  }, { events });
  const sessions = await adapter.listSessions();
  assert.equal(sessions.find((session) => session.id === 's-q').needsInput, true, 'an approval really waiting is real pending state');
  assert.equal(sessions.find((session) => session.id === 's-quiet').needsInput, undefined, 'no question and no approval is not evidence');
});

test('approving submits exactly once and reports submitted, never confirmed, without native proof', async (t) => {
  const events = fakeEvents();
  const adapter = await startAdapter(t, {
    'session/list': () => ({
      ok: true,
      value: { items: [{ sessionId: 's-q', title: 'T', updatedAt: 1770000000000, running: false, projections: { asOfSeq: 5, values: { title: 'T' } } }] },
    }),
    // The session log carries no decision yet: the transport acknowledged, and
    // that is all this bridge may claim.
    'session/page': () => ({ ok: true, value: { records: [], hasMore: false } }),
  }, { events, settleDelayMs: 1, settleAttempts: 2 });

  const result = await adapter.approveRequest('s-q', APPROVAL_ID, 'allow-once');
  assert.deepEqual(result, { accepted: true, sessionId: 's-q', approvalId: APPROVAL_ID, state: 'submitted' });
  assert.deepEqual(events.calls.approvals, [{ sessionId: 's-q', approvalId: APPROVAL_ID, decision: 'allow-once' }]);
});

test('an approval is confirmed only through the native audit pair, and never through the gateway id', async (t) => {
  /**
   * A session whose open approval is recorded under `auditId`, with the decision
   * appended only once this bridge has submitted - which is what native really
   * does (`request()` appends `approval/decided` after its waterfall settles).
   */
  const decided = (outcome, auditId = NATIVE_AUDIT_ID) => {
    const asked = { seq: 7, event: { type: 'approval/asked', seq: 7, time: 1770000000000, data: { id: auditId, toolName: 'run_command', callId: 'call-7', reason: 'needs to run one command' } } };
    const events = fakeEvents();
    const handlers = {
      'session/list': () => ({
        ok: true,
        value: { items: [{ sessionId: 's-q', title: 'T', updatedAt: 1770000000000, running: false, projections: { asOfSeq: 9, values: { title: 'T' } } }] },
      }),
      'session/projections': () => ({ ok: true, value: { asOfSeq: 9, values: {} } }),
      'session/page': () => ({
        ok: true,
        value: {
          records:
            events.calls.approvals.length === 0
              ? [asked]
              : [
                  asked,
                  { seq: 8, event: { type: 'assistant/message', seq: 8, time: 1770000000000, data: { message: { role: 'assistant', content: [{ type: 'text', text: 'working on it' }] } } } },
                  { seq: 9, event: { type: 'approval/decided', seq: 9, time: 1770000000000, data: { id: auditId, outcome } } },
                ],
        },
      }),
    };
    return { handlers, events };
  };

  const matchingFixture = decided('allowed-once');
  const matching = await startAdapter(t, matchingFixture.handlers, { events: matchingFixture.events, settleDelayMs: 1 });
  assert.deepEqual(await matching.approveRequest('s-q', APPROVAL_ID, 'allow-once'), {
    accepted: true,
    sessionId: 's-q',
    approvalId: APPROVAL_ID,
    state: 'confirmed',
  });
  // The proof was read by the **native** id: the same decision recorded under the
  // id the wire uses is invisible to it, and the native id never travels the wire.
  const pages = matching.calls.filter((call) => call.method === 'session/page');
  assert.equal(pages.length, 2, 'one audit read before the submission and one confirmation read after it');
  assert.ok(pages.every((call) => call.request.throughSeq === 9));
  assert.equal(
    matching.events.calls.approvals.filter((call) => call.approvalId === NATIVE_AUDIT_ID).length,
    0,
    'the native audit id is never submitted as if it were the gateway event id',
  );

  // Another client won the race with the opposite decision: that is not this
  // bridge's decision, and it must not be reported as one. The ask was still open
  // when it was correlated, so this is exactly the mismatch the audit has to tell.
  const racedFixture = decided('rejected');
  const raced = await startAdapter(t, racedFixture.handlers, { events: racedFixture.events, settleDelayMs: 1 });
  const racedErr = await raced.approveRequest('s-q', APPROVAL_ID, 'allow-once').catch((error) => error);
  assert.equal(racedErr.code, 'bridge_error');
  assert.match(racedErr.message, /another client/i);

  // A decision this bridge cannot read is not proof of anything either: the
  // record for another request must never confirm this one.
  const unrelatedFixture = decided('allowed-once');
  const unrelated = await startAdapter(t, unrelatedFixture.handlers, { events: unrelatedFixture.events, settleDelayMs: 1 });
  const otherId = await unrelated.approveRequest('s-q', OTHER_APPROVAL_ID, 'allow-once').catch((error) => error);
  assert.equal(otherId.code, 'session_not_found', 'an id nothing is waiting for never reaches the stream');
  assert.deepEqual(unrelated.events?.calls?.approvals ?? [], []);
});

test('a stale or unknown approval is refused before the stream is ever asked', async (t) => {
  const events = fakeEvents();
  const adapter = await startAdapter(t, {
    'session/list': () => ({
      ok: true,
      value: { items: [{ sessionId: 's-q', title: 'T', updatedAt: 1770000000000, running: false, projections: { asOfSeq: 5, values: { title: 'T' } } }] },
    }),
  }, { events });

  const unknown = await adapter.approveRequest('s-q', 'not-waiting', 'allow-once').catch((error) => error);
  assert.equal(unknown.code, 'session_not_found');
  const wrongSession = await adapter.approveRequest('s-other', APPROVAL_ID, 'allow-once').catch((error) => error);
  assert.equal(wrongSession.code, 'session_not_found');
  assert.deepEqual(events.calls.approvals, [], 'nothing was submitted for a request that is not waiting');

  // With no native stream at all there is no approval surface here: not_capable,
  // never a fake success.
  const streamless = await startAdapter(t, questionFixtures([CONTINUED_BATCH]));
  const noStream = await streamless.approveRequest('s-q', APPROVAL_ID, 'allow-once').catch((error) => error);
  assert.equal(noStream.code, 'not_capable');
});

test('a native approval is correlated by its own audit fields while the gateway id stays the wire id', async (t) => {
  const outcome = NATIVE_APPROVAL_OUTCOME['allow-once'];
  const audit = (records) => ({
    'session/list': () => ({
      ok: true,
      value: { items: [{ sessionId: 's-q', title: 'T', updatedAt: 1770000000000, running: false, projections: { asOfSeq: 40, values: { title: 'T' } } }] },
    }),
    'session/projections': () => ({ ok: true, value: { asOfSeq: 40, values: {} } }),
    'session/page': () => ({ ok: true, value: { records } }),
  });
  const asked = (id, data) => ({ seq: 41, event: { type: 'approval/asked', seq: 41, time: 1770000000000, data: { id, ...data } } });
  const decided = (id, value) => ({ seq: 42, event: { type: 'approval/decided', seq: 42, time: 1770000000000, data: { id, outcome: value } } });
  const own = asked(NATIVE_AUDIT_ID, { toolName: 'run_command', callId: 'call-7', reason: 'needs to run one command' });

  // 1. Our ask is recorded under a native id, and native appends the decision only
  //    after the submission: the outcome is this bridge's, read under the native
  //    id, and the gateway id it was called with played no part in it.
  let pageReads = 0;
  const events = fakeEvents();
  const confirmed = await startAdapter(
    t,
    {
      ...audit([]),
      'session/page': () => {
        pageReads += 1;
        // The decision is appended by native *because* this bridge submitted; a
        // fixture that showed it earlier would prove nothing about the correlation.
        const submittedHere = events.calls.approvals.length > 0;
        return { ok: true, value: { records: submittedHere ? [own, decided(NATIVE_AUDIT_ID, outcome)] : [own] } };
      },
    },
    { events, settleDelayMs: 1 },
  );
  assert.deepEqual(await confirmed.approveRequest('s-q', APPROVAL_ID, 'allow-once'), {
    accepted: true,
    sessionId: 's-q',
    approvalId: APPROVAL_ID,
    state: 'confirmed',
  });
  assert.ok(pageReads >= 2, 'the outcome was read again after the submission');
  assert.deepEqual(confirmed.events.calls.approvals, [{ sessionId: 's-q', approvalId: APPROVAL_ID, decision: 'allow-once' }]);

  // 2. The same shape whose audit entry carries the *gateway* id is not this
  //    bridge's request either: a native id it cannot see is a correlation it
  //    cannot make, so the answer stays submitted instead of asserting anything.
  const gatewayIdInAudit = await startAdapter(
    t,
    audit([asked(APPROVAL_ID, { toolName: 'run_command', callId: 'call-7', reason: 'needs to run one command' })]),
    { events: fakeEvents(), settleDelayMs: 1, settleAttempts: 2 },
  );
  assert.deepEqual(await gatewayIdInAudit.approveRequest('s-q', APPROVAL_ID, 'allow-once'), {
    accepted: true,
    sessionId: 's-q',
    approvalId: APPROVAL_ID,
    state: 'submitted',
  });
  assert.equal(gatewayIdInAudit.events.calls.approvals.length, 1);
});

test('two concurrent approvals of the same tool are told apart by their own call ids', async (t) => {
  const outcome = NATIVE_APPROVAL_OUTCOME['allow-once'];
  const asked = (id, callId) => ({ seq: 41, event: { type: 'approval/asked', seq: 41, time: 1770000000000, data: { id, toolName: 'run_command', callId, reason: 'needs to run one command' } } });
  const decided = (id, value) => ({ seq: 42, event: { type: 'approval/decided', seq: 42, time: 1770000000000, data: { id, outcome: value } } });
  /**
   * One run: `before` is the log an open approval has, `after` the log the same
   * approval has once it has been decided - native appends the decision, so the
   * fixture may only show it after the submission.
   */
  const run = async (t, before, after, options = {}) => {
    const events = fakeEvents();
    const adapter = await startAdapter(
      t,
      {
        'session/list': () => ({
          ok: true,
          value: { items: [{ sessionId: 's-q', title: 'T', updatedAt: 1770000000000, running: false, projections: { asOfSeq: 42, values: { title: 'T' } } }] },
        }),
        'session/projections': () => ({ ok: true, value: { asOfSeq: 42, values: {} } }),
        'session/page': () => ({ ok: true, value: { records: events.calls.approvals.length > 0 ? after : before } }),
      },
      { events, settleDelayMs: 1, settleAttempts: 2, ...options },
    );
    const result = await adapter.approveRequest('s-q', APPROVAL_ID, 'allow-once');
    return { result, events };
  };

  // Another call of the same tool was decided the other way: it is a different
  // request and proves nothing about ours.
  const stale = await run(
    t,
    [asked(OTHER_SAME_TOOL_AUDIT_ID, 'call-6'), decided(OTHER_SAME_TOOL_AUDIT_ID, outcome)],
    [asked(OTHER_SAME_TOOL_AUDIT_ID, 'call-6'), decided(OTHER_SAME_TOOL_AUDIT_ID, outcome)],
  );
  assert.equal(stale.result.state, 'submitted');
  assert.equal(stale.events.calls.approvals.length, 1);

  // Our own call is open next to that one: the decision is read for our id.
  const ours = await run(
    t,
    [asked(OTHER_SAME_TOOL_AUDIT_ID, 'call-8'), asked(NATIVE_AUDIT_ID, 'call-7')],
    [asked(OTHER_SAME_TOOL_AUDIT_ID, 'call-8'), asked(NATIVE_AUDIT_ID, 'call-7'), decided(NATIVE_AUDIT_ID, outcome)],
  );
  assert.equal(ours.result.state, 'confirmed');
  assert.equal(ours.events.calls.approvals.length, 1);

  // A decided neighbour under the same tool and a *different* native id is not
  // this request's outcome, and must not be read as one.
  const neighbour = await run(
    t,
    [asked(STALE_AUDIT_ID, 'call-6'), decided(STALE_AUDIT_ID, 'rejected'), asked(NATIVE_AUDIT_ID, 'call-7')],
    [asked(STALE_AUDIT_ID, 'call-6'), decided(STALE_AUDIT_ID, 'rejected'), asked(NATIVE_AUDIT_ID, 'call-7'), decided(NATIVE_AUDIT_ID, outcome)],
  );
  assert.equal(neighbour.result.state, 'confirmed');

  // Two open asks fit the live request equally well, and neither is decided: the
  // correlation is ambiguous, so nothing is inferred from either of them.
  const ambiguous = await run(
    t,
    [asked(OTHER_SAME_TOOL_AUDIT_ID, 'call-7'), asked(NATIVE_AUDIT_ID, 'call-7')],
    [asked(OTHER_SAME_TOOL_AUDIT_ID, 'call-7'), decided(OTHER_SAME_TOOL_AUDIT_ID, 'rejected'), asked(NATIVE_AUDIT_ID, 'call-7'), decided(NATIVE_AUDIT_ID, outcome)],
  );
  assert.deepEqual(ambiguous.result, {
    accepted: true,
    sessionId: 's-q',
    approvalId: APPROVAL_ID,
    state: 'submitted',
  });
  assert.equal(ambiguous.events.calls.approvals.length, 1, 'an ambiguous correlation is still submitted exactly once');

  // A different call of the same tool is still waiting and ours is not in the log
  // at all: the honest answer is the transport's own, and no other ask is used.
  const unknown = await run(t, [asked(OTHER_SAME_TOOL_AUDIT_ID, 'call-8')], [asked(OTHER_SAME_TOOL_AUDIT_ID, 'call-8')]);
  assert.equal(unknown.result.state, 'submitted');
});

test('one live approval is decided once: the same decision is never submitted twice', async (t) => {
  const events = fakeEvents();
  events.submitApproval = async (input) => {
    // The real stream records the submission and drops the local card *before* its
    // RPC (`DshEventStream.submitApproval`), so once a decision has gone out this
    // exact request is no longer waiting: this stand-in does the same.
    events.calls.approvals.push(input);
    events.approvals = events.approvals.filter((approval) => approval.id !== input.approvalId);
    return { accepted: true, state: 'submitted' };
  };
  const adapter = await startAdapter(
    t,
    {
      'session/list': () => ({
        ok: true,
        value: { items: [{ sessionId: 's-q', title: 'T', updatedAt: 1770000000000, running: false, projections: { asOfSeq: 5, values: { title: 'T' } } }] },
      }),
      'session/page': () => ({ ok: true, value: { records: [] } }),
    },
    { events, settleDelayMs: 1, settleAttempts: 2 },
  );

  const first = await adapter.approveRequest('s-q', APPROVAL_ID, 'allow-once');
  assert.deepEqual(first, { accepted: true, sessionId: 's-q', approvalId: APPROVAL_ID, state: 'submitted' });

  // The same id again is refused before the stream is ever asked, and the audit
  // round trip that precedes a submission changes none of that: no second
  // `$events/result` is ever sent for one approval.
  const again = await adapter.approveRequest('s-q', APPROVAL_ID, 'allow-once').catch((error) => error);
  assert.equal(again.code, 'session_not_found');
  assert.deepEqual(events.calls.approvals, [{ sessionId: 's-q', approvalId: APPROVAL_ID, decision: 'allow-once' }]);

  // The other decision for the very same request is refused the same way.
  const otherWay = await adapter.approveRequest('s-q', APPROVAL_ID, 'reject').catch((error) => error);
  assert.equal(otherWay.code, 'session_not_found');
  assert.equal(events.calls.approvals.length, 1, 'one approval is submitted once, never twice');
});

test('the audit scan and correlation helpers are exact-field, and refuse an ambiguous match', () => {
  const record = (type, seq, data) => ({ seq, event: { type, seq, time: 1770000000000, data } });
  const asks = scanApprovalAudit([
    record('approval/asked', 41, { id: STALE_AUDIT_ID, toolName: 'run_command', callId: 'call-6', reason: 'older ask' }),
    record('approval/decided', 42, { id: STALE_AUDIT_ID, outcome: 'rejected' }),
    record('approval/asked', 43, { id: NATIVE_AUDIT_ID, toolName: 'run_command', callId: 'call-7', reason: 'needs to run one command' }),
    record('approval/asked', 44, { id: '', toolName: 'run_command' }),
    record('assistant/message', 45, { message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }] } }),
  ]);
  assert.equal(asks.length, 2, 'only asks with a usable native id are read, and no message is');
  assert.equal(asks[0].decision, 'rejected', 'a decision is folded onto its own native id');
  assert.equal(asks[1].decision, null, 'a request with no decision is still open');

  const live = { toolName: 'run_command', callId: 'call-7', reason: 'needs to run one command' };
  assert.deepEqual(correlateApprovalAudit(asks, live), { auditId: NATIVE_AUDIT_ID, decision: null });
  assert.equal(recordedOutcomeOf(asks, NATIVE_AUDIT_ID), null, 'the open ask has no recorded outcome yet');
  assert.equal(recordedOutcomeOf(asks, STALE_AUDIT_ID), 'rejected', 'the decided ask keeps its own outcome');

  // A live request with no call id may only take an ask that carries none either.
  assert.equal(correlateApprovalAudit(asks, { toolName: 'run_command' }), null, 'a call-scoped ask cannot answer a call-less request');
  assert.deepEqual(correlateApprovalAudit(asks, { toolName: 'run_command', callId: 'call-6' }), null, 'a decided ask is not a live one');
  assert.equal(correlateApprovalAudit(asks, { toolName: 'other_tool', callId: 'call-7' }), null, 'the tool name must agree');
  assert.equal(
    correlateApprovalAudit(asks, { toolName: 'run_command', callId: 'call-7', reason: 'a different reason' }),
    null,
    'a different reason belongs to a different request',
  );

  const ambiguous = scanApprovalAudit([
    record('approval/asked', 41, { id: NATIVE_AUDIT_ID, toolName: 'run_command', callId: 'call-7' }),
    record('approval/asked', 42, { id: OTHER_SAME_TOOL_AUDIT_ID, toolName: 'run_command', callId: 'call-7' }),
  ]);
  assert.equal(correlateApprovalAudit(ambiguous, { toolName: 'run_command', callId: 'call-7' }), null, 'two equal candidates are never one guess');

  const noCallId = scanApprovalAudit([record('approval/asked', 41, { id: NATIVE_AUDIT_ID, toolName: 'run_command' })]);
  assert.deepEqual(
    correlateApprovalAudit(noCallId, { toolName: 'run_command' }),
    { auditId: NATIVE_AUDIT_ID, decision: null },
    'the single open ask of an ask without a call id is still exact',
  );
});

test('an open question is answered through the live waterfall, and only native settled state makes it accepted', async (t) => {
  const openBatch = { ...CONTINUED_BATCH, state: 'open' };
  const answers = [
    { id: 'q-1', selected: ['One'] },
    { id: 'q-2', selected: ['Yes', 'No'], custom: 'both, somehow' },
  ];
  const settledValue = {
    asOfSeq: 6,
    values: { userQuestions: { active: [], settled: [{ callId: 'call-9', answers }] } },
  };

  // 1. Native really settled it with exactly this batch: accepted.
  let reads = 0;
  const accepted = await startAdapter(
    t,
    {
      ...questionFixtures([openBatch]),
      'session/projections': () => {
        reads += 1;
        // The first read answers the ownership check (still open); the later ones
        // are the confirmation reads.
        return reads === 1 ? { ok: true, value: { asOfSeq: 5, values: { userQuestions: { active: [openBatch], settled: [] } } } } : { ok: true, value: settledValue };
      },
    },
    { events: fakeEvents(), settleDelayMs: 1 },
  );
  const result = await accepted.answerQuestion('s-q', 'call-9', answers);
  assert.deepEqual(result, { accepted: true, sessionId: 's-q', callId: 'call-9' });
  assert.deepEqual(accepted.events.calls.answers, [{ sessionId: 's-q', callId: 'call-9', answers }]);
  assert.equal(accepted.calls.some((call) => call.method === 'userQuestions/answer'), false, 'an open question never takes the unary path');

  // 2. Native settled the same call with a different answer: somebody else
  //    answered it. That is reported, not swallowed as a success.
  const elsewhere = await startAdapter(
    t,
    {
      ...questionFixtures([openBatch]),
      'session/projections': () => ({
        ok: true,
        value: { asOfSeq: 6, values: { userQuestions: { active: [], settled: [{ callId: 'call-9', answers: [{ id: 'q-1', selected: ['Two'] }, { id: 'q-2', selected: [] }] }] } } },
      }),
    },
    { events: fakeEvents(), settleDelayMs: 1 },
  );
  // The ownership check needs the call to be waiting, so serve the first read as
  // still-open and the confirmation reads as the other answer.
  let otherReads = 0;
  elsewhere.projectionsOf = async () => {
    otherReads += 1;
    return otherReads === 1
      ? { asOfSeq: 5, values: { userQuestions: { active: [openBatch], settled: [] } } }
      : { asOfSeq: 6, values: { userQuestions: { active: [], settled: [{ callId: 'call-9', answers: [{ id: 'q-1', selected: ['Two'] }, { id: 'q-2', selected: [] }] }] } } };
  };
  const elsewhereErr = await elsewhere.answerQuestion('s-q', 'call-9', answers).catch((error) => error);
  assert.equal(elsewhereErr.code, 'bridge_error');
  assert.match(elsewhereErr.message, /already answered/i);
  assert.equal(elsewhere.events.calls.answers.length, 1, 'the submission happened once and was never retried');

  // 3. Nothing settled at all inside the bounded window: an honest failure, never
  //    a "the transport said ok so it must be answered".
  const unproven = await startAdapter(t, questionFixtures([openBatch]), { events: fakeEvents(), settleDelayMs: 1, settleAttempts: 2 });
  const unprovenErr = await unproven.answerQuestion('s-q', 'call-9', answers).catch((error) => error);
  assert.equal(unprovenErr.code, 'bridge_error');
  assert.match(unprovenErr.message, /re-read/i);
  assert.equal(unproven.events.calls.answers.length, 1);

  // 4. An open question with no live waterfall has no answer channel from here.
  const noWait = await startAdapter(t, questionFixtures([openBatch]), { events: fakeEvents({ waits: new Set() }), settleDelayMs: 1 });
  const noWaitErr = await noWait.answerQuestion('s-q', 'call-9', answers).catch((error) => error);
  assert.equal(noWaitErr.code, 'not_capable');
  assert.equal(noWait.events.calls.answers.length, 0, 'nothing is submitted without a live native channel');
});

test('a continued question still goes through the unary path, unchanged', async (t) => {
  const events = fakeEvents();
  const adapter = await startAdapter(
    t,
    questionFixtures([CONTINUED_BATCH], { 'userQuestions/answer': () => ({ ok: true, value: true }) }),
    { events, settleDelayMs: 1 },
  );
  const result = await adapter.answerQuestion('s-q', 'call-9', [
    { id: 'q-1', selected: ['One'] },
    { id: 'q-2', selected: [] },
  ]);
  assert.deepEqual(result, { accepted: true, sessionId: 's-q', callId: 'call-9' });
  assert.equal(adapter.calls.filter((call) => call.method === 'userQuestions/answer').length, 1);
  assert.equal(events.calls.answers.length, 0, 'a continued question never uses the event stream');
});

test('closing the adapter closes the native event stream with it', async (t) => {
  const events = fakeEvents();
  const adapter = await startAdapter(t, questionFixtures([CONTINUED_BATCH]), { events });
  adapter.close();
  assert.equal(events.calls.closed, 1);
  assert.equal(adapter.events, null);
  assert.deepEqual(adapter.pendingApprovalsOf('s-q'), [], 'a closed adapter holds nothing');
});

/**
 * The shipped `ask_user_question` default is `mode: 'legacy'`
 * (`dsh-tool-ask-user/lib/index.js`, `Config`), and the blocking tool calls
 * `ctx.userQuestions.ask()` with no `wait` at all. The `userQuestions` fold only
 * ever tracks calls made under the timed schema, so such a call appears in **no**
 * projection: the phone can only learn of it from the session log, under the real
 * `tool/call` id.
 */
const LEGACY_CALL_ID = 'call_A1b2C3d4E5f6';
const LEGACY_QUESTIONS = [
  { id: 'q-1', question: 'Which one?', header: 'Choice', options: [{ label: 'One' }, { label: 'Two' }] },
  { id: 'q-2', question: 'Anything else?', multi_select: true, options: [{ label: 'Yes' }, { label: 'No' }] },
];
/** The same questions as the service forwards them: `multiSelect`, no `detail`. */
const LEGACY_CARRIED = [
  { id: 'q-1', question: 'Which one?', header: 'Choice', options: [{ label: 'One' }, { label: 'Two' }] },
  { id: 'q-2', question: 'Anything else?', multiSelect: true, options: [{ label: 'Yes' }, { label: 'No' }] },
];
const LEGACY_ANSWERS = [
  { id: 'q-1', selected: ['Two'] },
  { id: 'q-2', selected: ['Yes', 'No'], custom: 'both, somehow' },
];

/** One logged `tool/call`, exactly as `dsh-agent-loop` appends it. */
function toolCallRecord({ seq, turn = 3, callId = LEGACY_CALL_ID, name = 'ask_user_question', questions = LEGACY_QUESTIONS }) {
  return {
    seq,
    event: {
      type: 'tool/call',
      seq,
      time: 1770000000000,
      data: { turn, step: 1, callId, name, arguments: JSON.stringify({ questions }) },
    },
  };
}

const LEGACY_ANSWERED_BATCH = { id: 'q-1', selected: ['Two'] };

/** The logged `tool/result` of one `ask_user_question` call. */
function toolResultRecord({ seq, callId = LEGACY_CALL_ID, value, isError = false }) {
  return {
    seq,
    event: {
      type: 'tool/result',
      seq,
      time: 1770000001000,
      data: {
        turn: 3,
        step: 1,
        message: {
          id: `result-${callId}`,
          role: 'tool',
          toolCallId: callId,
          isError,
          source: { kind: 'tool', callId },
          content: [{ type: 'text', text: JSON.stringify(value) }],
        },
      },
    },
  };
}

/** A session whose log holds exactly the given records, and nothing else. */
function legacyFixtures(records) {
  return {
    'session/list': () => ({
      ok: true,
      value: {
        items: [
          {
            agentAvailable: true,
            sessionId: 's-q',
            updatedAt: 1770000000000,
            running: true,
            blank: false,
            projections: { kind: 'sequenced', asOfSeq: 5, values: { title: 'Blocked' } },
          },
        ],
      },
    }),
    'session/projections': () => ({ ok: true, value: { asOfSeq: 5, values: { userQuestions: { active: [], settled: [] } } } }),
    'session/page': () => ({ ok: true, value: { records: [...records], hasMore: false } }),
  };
}

/** A legacy channel held by the stream, with the questions the request carried. */
function legacyHold(questions = LEGACY_CARRIED) {
  return { eventId: OTHER_APPROVAL_ID, agentId: 's-q', callId: null, epoch: 1, questions, legacy: true };
}

test('the exact call id of a legacy question is its own logged tool call, never invented', () => {
  const page = [
    toolCallRecord({ seq: 10 }),
    toolCallRecord({ seq: 12, callId: 'call_other', questions: [{ id: 'q-9', question: 'A different question?' }] }),
  ];
  const open = scanToolCalls(page);
  assert.deepEqual(open.map((call) => call.callId), [LEGACY_CALL_ID, 'call_other']);
  assert.equal(open[0].turn, 3);
  assert.equal(open[0].name, 'ask_user_question');

  // The newest unresolved call is the one a live waterfall can belong to, so the
  // request must match *that* form - and only that one.
  assert.deepEqual(
    correlateLegacyQuestionCall(page, [{ id: 'q-9', question: 'A different question?' }]),
    { callId: 'call_other', turn: 3 },
    'the newest open call, whose own logged form the request carries',
  );
  assert.equal(correlateLegacyQuestionCall(page, LEGACY_CARRIED), null, 'an older call is not the one a live request belongs to');
  // A form nothing asked is never answered: the honest answer is "no correlation".
  assert.equal(correlateLegacyQuestionCall(page, [{ id: 'q-1', question: 'Never asked.' }]), null);

  // A call with a recorded result is over, so it can never be the live one.
  const answered = [toolCallRecord({ seq: 10 }), toolResultRecord({ seq: 11, value: { answers: [LEGACY_ANSWERED_BATCH] } })];
  assert.deepEqual(scanToolCalls(answered), []);
  assert.equal(correlateLegacyQuestionCall(answered, LEGACY_CARRIED), null, 'a finished call is not an answer channel');

  // Only `ask_user_question` is a question: the newest open call being another
  // tool means this bridge cannot say which call the request belongs to.
  const otherTool = [toolCallRecord({ seq: 10 }), toolCallRecord({ seq: 12, callId: 'call_bash', name: 'run_command', questions: LEGACY_QUESTIONS })];
  assert.equal(correlateLegacyQuestionCall(otherTool, LEGACY_CARRIED), null);

  // Without turn markers the search widens to the page, and the newest call still
  // has to match: a newer different call makes the request uncorrelatable.
  const noTurn = [
    { seq: 10, event: { type: 'tool/call', seq: 10, time: 1, data: { callId: LEGACY_CALL_ID, name: 'ask_user_question', arguments: JSON.stringify({ questions: LEGACY_QUESTIONS }) } } },
    { seq: 12, event: { type: 'tool/call', seq: 12, time: 2, data: { callId: 'call_later', name: 'ask_user_question', arguments: JSON.stringify({ questions: [{ id: 'q-7', question: 'Later.' }] }) } } },
  ];
  assert.equal(correlateLegacyQuestionCall(noTurn, LEGACY_CARRIED), null, 'a newer different form is not this request either');
  assert.deepEqual(correlateLegacyQuestionCall([noTurn[0]], LEGACY_CARRIED), { callId: LEGACY_CALL_ID, turn: null });
});

test('a legacy question form must match the logged arguments field for field', () => {
  const argumentsOf = (questions) => JSON.stringify({ questions });
  assert.equal(sameQuestionForm(argumentsOf(LEGACY_QUESTIONS), LEGACY_CARRIED), true);
  // A dropped option description, a different label, an extra answer mode: each
  // one means this is not the form the call asked, so it is not this call.
  assert.equal(
    sameQuestionForm(argumentsOf([{ id: 'q-1', question: 'Which one?', options: [{ label: 'One', description: 'the first' }] }]), [
      { id: 'q-1', question: 'Which one?', options: [{ label: 'One' }] },
    ]),
    false,
  );
  assert.equal(
    sameQuestionForm(argumentsOf([{ id: 'q-1', question: 'Which one?', options: [{ label: 'One' }] }]), [{ id: 'q-1', question: 'Which one?', options: [{ label: 'Two' }] }]),
    false,
  );
  assert.equal(sameQuestionForm(argumentsOf([{ id: 'q-1', question: 'Which one?', multi_select: true }]), [{ id: 'q-1', question: 'Which one?' }]), false);
  // A field the service drops (`detail`) cannot be compared, so the form is not
  // provably the same one - and is refused rather than approximated.
  assert.equal(sameQuestionForm(argumentsOf([{ id: 'q-1', question: 'x', detail: 'the plan' }]), [{ id: 'q-1', question: 'x' }]), false);
  assert.equal(sameQuestionForm('not json', LEGACY_CARRIED), false);
  assert.equal(sameQuestionForm(JSON.stringify({ questions: [] }), LEGACY_CARRIED), false);
});

test('the proof a legacy answer landed is the tool result under this exact call id', () => {
  const value = { answers: [{ id: 'q-1', selected: ['Two'] }, { id: 'q-2', selected: [], custom: 'ok' }] };
  assert.deepEqual(recordedQuestionAnswers([toolResultRecord({ seq: 11, value })], LEGACY_CALL_ID), value.answers);
  // A result of another call, however good it looks, is not this call's result.
  assert.equal(recordedQuestionAnswers([toolResultRecord({ seq: 11, callId: 'call_other', value })], LEGACY_CALL_ID), null);
  // The timed pending payload is not an answer batch.
  assert.equal(recordedQuestionAnswers([toolResultRecord({ seq: 11, value: { pending: true, callId: LEGACY_CALL_ID, message: 'no answer yet' } })], LEGACY_CALL_ID), null);
  // A failed call recorded no answers, even when its text parses.
  assert.equal(recordedQuestionAnswers([toolResultRecord({ seq: 11, value, isError: true })], LEGACY_CALL_ID), null);
  const failedWithError = toolResultRecord({ seq: 11, value });
  failedWithError.event.data.error = { name: 'UserQuestionError', code: 'ASK_ABORTED' };
  assert.equal(recordedQuestionAnswers([failedWithError], LEGACY_CALL_ID), null);
  // Text that is not an answer batch at all proves nothing.
  const garbage = toolResultRecord({ seq: 11, value });
  garbage.event.data.message.content = [{ type: 'text', text: 'not json' }];
  assert.equal(recordedQuestionAnswers([garbage], LEGACY_CALL_ID), null);
  const wrongShape = toolResultRecord({ seq: 11, value: { answers: [{ id: 'q-1', selected: 'Two' }] } });
  assert.equal(recordedQuestionAnswers([wrongShape], LEGACY_CALL_ID), null, 'one item per question, each with an array of labels');
  assert.equal(recordedQuestionAnswers([], LEGACY_CALL_ID), null);
});

/**
 * The PTC shape, taken from a real session log on this machine.
 *
 * A model that calls `ask_user_question` from inside `run_code` produces no
 * `tool/call` for the question at all: native appends `tool/ptc-dispatch-start`
 * **before** the subcall executes and `tool/ptc-dispatch` **after** it settles
 * (`dsh-tools/lib/index.js` lines 1354-1360 / 1331-1340). Both records carry the
 * real `subCallId`, the real `parentCallId`/`rootCallId`, the tool `name` and the
 * detached JSON `arguments` - as an **object**, never as a string. The fixtures
 * below reproduce that shape exactly, including the `:ptc:1` id native mints.
 *
 * Verified against `~/.dsh/sessions/.../session-f4bc8bc9-43f3-4970-b122-5da476775b6f`.
 */
const PTC_ROOT_CALL_ID = 'call_00_ET_x7c322EvhA3bKIDHSEOk4342';
const PTC_SUB_CALL_ID = `${PTC_ROOT_CALL_ID}:ptc:1`;
const PTC_QUESTIONS = [
  { id: 'phone_theme', header: '界面风格', question: '请选择手机工作台的界面风格', options: [{ label: '简洁浅色' }, { label: '自动深色' }] },
];
/** The same form as the service forwards it: `multiSelect`, no `detail`. */
const PTC_CARRIED = [{ id: 'phone_theme', header: '界面风格', question: '请选择手机工作台的界面风格', options: [{ label: '简洁浅色' }, { label: '自动深色' }] }];
const PTC_ANSWERS = [{ id: 'phone_theme', selected: ['自动深色'] }];

/** The `run_code` call whose PTC dispatch asked the question. */
function ptcRootCallRecord({ seq = 20, callId = PTC_ROOT_CALL_ID } = {}) {
  return {
    seq,
    event: {
      type: 'tool/call',
      seq,
      time: 1791552623361,
      data: { turn: 1, step: 1, callId, name: 'run_code', arguments: JSON.stringify({ code: 'await tools.ask_user_question({ questions })', description: 'Ask the user' }) },
    },
  };
}

/** `tool/ptc-dispatch-start`: appended before the subcall executes. */
function ptcStartRecord({ seq = 21, subCallId = PTC_SUB_CALL_ID, parentCallId = PTC_ROOT_CALL_ID, rootCallId = PTC_ROOT_CALL_ID, name = 'ask_user_question', questions = PTC_QUESTIONS } = {}) {
  return {
    seq,
    event: {
      type: 'tool/ptc-dispatch-start',
      seq,
      time: 1791552623801,
      data: { rootCallId, parentCallId, subCallId, name, arguments: { questions } },
    },
  };
}

/** `tool/ptc-dispatch`: appended after the subcall settles, with its result. */
function ptcCompletionRecord({ seq = 22, subCallId = PTC_SUB_CALL_ID, parentCallId = PTC_ROOT_CALL_ID, rootCallId = PTC_ROOT_CALL_ID, name = 'ask_user_question', value, isError = false } = {}) {
  const data = {
    rootCallId,
    parentCallId,
    subCallId,
    name,
    arguments: { questions: PTC_QUESTIONS },
    isError,
  };
  if (isError) data.error = { name: 'UserQuestionError', code: 'ASK_ABORTED' };
  data.content = value === undefined ? [{ type: 'text', text: 'Error: ask_user_question was aborted before the user answered' }] : [{ type: 'text', text: JSON.stringify(value) }];
  return { seq, event: { type: 'tool/ptc-dispatch', seq, time: 1791552743474, data } };
}

/** The `tool/result` of the `run_code` call itself, which ends its subcalls' window. */
function ptcRootResultRecord({ seq = 23, callId = PTC_ROOT_CALL_ID, isError = false } = {}) {
  const message = {
    id: `result-${callId}`,
    role: 'tool',
    toolCallId: callId,
    isError,
    source: { kind: 'tool', callId },
    content: [{ type: 'text', text: 'run_code completed with no output' }],
  };
  const data = { turn: 1, step: 1, message };
  if (isError) data.error = { code: 'CODE_RUN_FAILED' };
  return { seq, event: { type: 'tool/result', seq, time: 1791552743600, data } };
}

test('a question PTC dispatched inside run_code is a real call, under its own subCallId', () => {
  const page = [ptcRootCallRecord(), ptcStartRecord()];
  // The page-level scan still sees only the top-level `tool/call`: a PTC subcall has
  // no `turn`/`step`, so it must not be mixed into that newest-call ordering.
  assert.deepEqual(scanToolCalls(page).map((call) => call.callId), [PTC_ROOT_CALL_ID]);
  assert.deepEqual(ptcQuestionSubCallIds(page), [PTC_SUB_CALL_ID]);

  const [dispatched] = scanPtcQuestionCalls(page);
  assert.equal(dispatched.name, 'ask_user_question');
  assert.equal(dispatched.subCallId, PTC_SUB_CALL_ID);
  assert.equal(dispatched.parentCallId, PTC_ROOT_CALL_ID);
  assert.equal(dispatched.rootCallId, PTC_ROOT_CALL_ID);
  assert.deepEqual(dispatched.arguments, { questions: PTC_QUESTIONS });
  assert.equal(dispatched.isError, null, 'a start with no completion is an unresolved call');
  assert.equal(isLiveCallChain(page, PTC_SUB_CALL_ID), true, 'its run_code parent is still open');
  assert.deepEqual(correlatePtcQuestionCall(page, PTC_CARRIED), { callId: PTC_SUB_CALL_ID, turn: null });
  assert.deepEqual(correlateHeldQuestionCall(page, PTC_CARRIED), { callId: PTC_SUB_CALL_ID, turn: null });

  // The completion is the same subcall's result, and it closes the window.
  const settled = [ptcRootCallRecord(), ptcStartRecord(), ptcCompletionRecord({ value: { answers: PTC_ANSWERS } })];
  assert.equal(scanPtcQuestionCalls(settled)[0].isError, false);
  assert.equal(isLiveCallChain(settled, PTC_SUB_CALL_ID), false, 'a subcall with a completion is over');
  assert.equal(correlatePtcQuestionCall(settled, PTC_CARRIED), null);

  // Native records the same form two ways: PTC writes the arguments object, a
  // top-level `tool/call` writes the identical JSON as a string. Both read the same.
  assert.equal(sameQuestionForm({ questions: PTC_QUESTIONS }, PTC_CARRIED), true);
  assert.equal(sameQuestionForm(JSON.stringify({ questions: PTC_QUESTIONS }), PTC_CARRIED), true);
  // Anything that is not a readable form is not a match, and never a guess.
  assert.equal(sameQuestionForm('not json', PTC_CARRIED), false);
  assert.equal(sameQuestionForm(null, PTC_CARRIED), false);
  assert.equal(sameQuestionForm(42, PTC_CARRIED), false);
  assert.equal(sameQuestionForm([{ questions: PTC_QUESTIONS }], PTC_CARRIED), false);
  assert.equal(sameQuestionForm({ questions: [] }, PTC_CARRIED), false);
  assert.equal(sameQuestionForm({ questions: PTC_QUESTIONS }, []), false);
});

test('a PTC question that is not exactly this live subcall is never correlated', () => {
  // A different subCallId of the same parent is a different call - and the form
  // match is against each record's own arguments, not against an id.
  const otherSubCall = [ptcRootCallRecord(), ptcStartRecord({ subCallId: `${PTC_ROOT_CALL_ID}:ptc:2`, questions: [{ id: 'q-9', question: 'A different question?' }] })];
  assert.equal(correlatePtcQuestionCall(otherSubCall, PTC_CARRIED), null);

  // The parent's own result record ends the window: the subcall can no longer be
  // the call a live waterfall waits in - whatever that result says.
  const parentFinished = [ptcRootCallRecord(), ptcStartRecord(), ptcRootResultRecord()];
  assert.equal(isLiveCallChain(parentFinished, PTC_SUB_CALL_ID), false);
  assert.equal(correlatePtcQuestionCall(parentFinished, PTC_CARRIED), null);
  const parentFailed = [ptcRootCallRecord(), ptcStartRecord(), ptcRootResultRecord({ isError: true })];
  assert.equal(correlatePtcQuestionCall(parentFailed, PTC_CARRIED), null, 'a failed or cancelled run_code is not a live call');

  // A subcall of another tool is not a question, however its arguments look.
  const otherTool = [ptcRootCallRecord(), ptcStartRecord({ name: 'run_command' })];
  assert.deepEqual(scanPtcQuestionCalls(otherTool, new Set(['ask_user_question'])), []);
  assert.equal(correlatePtcQuestionCall(otherTool, PTC_CARRIED), null);

  // A subcall whose parent is not on the page cannot be proven live: fail closed.
  const orphan = [ptcStartRecord()];
  assert.equal(isLiveCallChain(orphan, PTC_SUB_CALL_ID), false);
  assert.equal(correlatePtcQuestionCall(orphan, PTC_CARRIED), null);

  // Two identical concurrent subcalls carrying this form cannot be told apart, so
  // neither is used - the phone is never offered a form it could answer wrongly.
  const ambiguous = [ptcRootCallRecord(), ptcStartRecord(), ptcStartRecord({ seq: 23, subCallId: `${PTC_ROOT_CALL_ID}:ptc:2` })];
  assert.equal(correlatePtcQuestionCall(ambiguous, PTC_CARRIED), null);
  assert.equal(isLiveCallChain(ambiguous, PTC_SUB_CALL_ID), true, 'both really are live; "live" is not the same as "unambiguous"');
});

test('a settled earlier ask of the same form never makes the current one ambiguous', () => {
  // The real session that produced the disappearing card
  // (`session-779f2aed-dbf8-4aa2-b0b1-2bdf5556c891`): one form asked twice, both
  // tries aborted by a native timeout/cancel, then the same form asked again and
  // still live. Every settled copy is skipped, so the live one is the answer.
  const firstRoot = `${PTC_ROOT_CALL_ID}_first`;
  const secondRoot = `${PTC_ROOT_CALL_ID}_second`;
  const firstSub = `${firstRoot}:ptc:1`;
  const secondSub = `${secondRoot}:ptc:1`;
  const repeated = [
    ptcRootCallRecord({ seq: 21, callId: firstRoot }),
    ptcStartRecord({ seq: 22, subCallId: firstSub, parentCallId: firstRoot, rootCallId: firstRoot }),
    // `ASK_ABORTED`: the completion native leaves behind when the phone never
    // answered in time.
    ptcCompletionRecord({ seq: 23, subCallId: firstSub, parentCallId: firstRoot, rootCallId: firstRoot, isError: true }),
    ptcRootResultRecord({ seq: 24, callId: firstRoot, isError: true }),
    ptcRootCallRecord({ seq: 29, callId: secondRoot }),
    ptcStartRecord({ seq: 30, subCallId: secondSub, parentCallId: secondRoot, rootCallId: secondRoot }),
    ptcCompletionRecord({ seq: 31, subCallId: secondSub, parentCallId: secondRoot, rootCallId: secondRoot, isError: true }),
    ptcRootResultRecord({ seq: 32, callId: secondRoot, isError: true }),
  ];
  // All three copies carry exactly the form the request carries - the settled ones
  // included, which is the whole point.
  assert.deepEqual(ptcQuestionSubCallIds(repeated), [firstSub, secondSub]);
  assert.equal(repeated.every((record) => record.event.type !== 'tool/ptc-dispatch-start' || sameQuestionForm(record.event.data.arguments, PTC_CARRIED)), true);

  // With only the settled history on the page there is no live call to answer for.
  assert.equal(correlatePtcQuestionCall(repeated, PTC_CARRIED), null);

  // The current turn re-asks the identical form: its own live subcall is the exact
  // identity, and the two dead copies are not rivals.
  const resumption = [...repeated, ptcRootCallRecord({ seq: 42, callId: PTC_ROOT_CALL_ID }), ptcStartRecord({ seq: 43 })];
  // The defect this locks down: counting every form-matching subcall of the page
  // first makes the two settled copies phantom rivals, so the answer was `null` -
  // the card vanished even though this exact form was live again.
  assert.deepEqual(correlatePtcQuestionCall(resumption, PTC_CARRIED), { callId: PTC_SUB_CALL_ID, turn: null });
  assert.deepEqual(correlateHeldQuestionCall(resumption, PTC_CARRIED), { callId: PTC_SUB_CALL_ID, turn: null });
});

test('the real aborted-and-repeated phone session correlates to its live subcall', () => {
  // The genuine ids of `~/.dsh/sessions/--D-workspace-codex-workspace-remote-control--/
  // session-779f2aed-dbf8-4aa2-b0b1-2bdf5556c891`, whose held waterfall produced no
  // card: two `run_code` asks of one form, each aborted (`ASK_ABORTED`, then the
  // parent's `run_code` result), and a third ask of the identical form still live.
  const aborted = ['call_00_FijkDYcsoPd0fX97ekCj2154', 'call_00_YKpqpQKmsiF3trdxCuYD6908'];
  const live = 'call_00_UPv7CIff6m9QJgbtoaYf2989';
  const records = [];
  let seq = 21;
  for (const parent of aborted) {
    const subCallId = `${parent}:ptc:1`;
    records.push(
      ptcRootCallRecord({ seq, callId: parent }),
      ptcStartRecord({ seq: seq + 1, subCallId, parentCallId: parent, rootCallId: parent }),
      ptcCompletionRecord({ seq: seq + 2, subCallId, parentCallId: parent, rootCallId: parent, isError: true }),
      ptcRootResultRecord({ seq: seq + 3, callId: parent, isError: true }),
    );
    seq += 8;
  }
  records.push(
    ptcRootCallRecord({ seq, callId: live }),
    ptcStartRecord({ seq: seq + 1, subCallId: `${live}:ptc:1`, parentCallId: live, rootCallId: live }),
  );
  assert.deepEqual(correlatePtcQuestionCall(records, PTC_CARRIED), { callId: `${live}:ptc:1`, turn: null });
  assert.deepEqual(correlateHeldQuestionCall(records, PTC_CARRIED), { callId: `${live}:ptc:1`, turn: null });
});

test('two live subcalls carrying the same form stay ambiguous', () => {  // Ambiguity is about live calls only, and it is not weakened by the history
  // filter: two concurrent live subcalls with this exact form still refuse.
  const otherRoot = `${PTC_ROOT_CALL_ID}_other`;
  const bothLive = [
    ptcRootCallRecord({ seq: 20 }),
    ptcStartRecord({ seq: 21 }),
    ptcRootCallRecord({ seq: 22, callId: otherRoot }),
    ptcStartRecord({ seq: 23, subCallId: `${otherRoot}:ptc:1`, parentCallId: otherRoot, rootCallId: otherRoot }),
  ];
  assert.equal(isLiveCallChain(bothLive, PTC_SUB_CALL_ID), true);
  assert.equal(isLiveCallChain(bothLive, `${otherRoot}:ptc:1`), true);
  assert.equal(correlatePtcQuestionCall(bothLive, PTC_CARRIED), null);

  // Removing one live chain leaves exactly one live match, which is answerable.
  const oneLive = bothLive.filter((record) => (record.event.data.callId ?? record.event.data.subCallId) !== otherRoot && record.event.data.subCallId !== `${otherRoot}:ptc:1`);
  assert.deepEqual(correlatePtcQuestionCall(oneLive, PTC_CARRIED), { callId: PTC_SUB_CALL_ID, turn: null });
});

test('the proof a PTC-dispatched answer landed is its own completion record', () => {
  const answered = { answers: PTC_ANSWERS };
  const settled = [ptcRootCallRecord(), ptcStartRecord(), ptcCompletionRecord({ value: answered })];
  assert.deepEqual(recordedQuestionAnswers(settled, PTC_SUB_CALL_ID), PTC_ANSWERS);

  // A different native answer is not this bridge's answer.
  assert.equal(
    JSON.stringify(recordedQuestionAnswers(settled, PTC_SUB_CALL_ID)) === JSON.stringify([{ id: 'phone_theme', selected: ['简洁浅色'] }]),
    false,
  );
  // The real failing record (`isError: true`, `ASK_ABORTED`) records no answer.
  const aborted = [ptcRootCallRecord(), ptcStartRecord(), ptcCompletionRecord({ isError: true })];
  assert.equal(recordedQuestionAnswers(aborted, PTC_SUB_CALL_ID), null);
  // A completion that belongs to another subcall, another parent, or the root of
  // another run_code is not this call's result.
  assert.equal(recordedQuestionAnswers([ptcStartRecord(), ptcCompletionRecord({ subCallId: `${PTC_ROOT_CALL_ID}:ptc:2`, value: answered })], PTC_SUB_CALL_ID), null);
  assert.equal(recordedQuestionAnswers([ptcStartRecord(), ptcCompletionRecord({ parentCallId: 'call_other_root', value: answered })], PTC_SUB_CALL_ID), null);
  assert.equal(recordedQuestionAnswers([ptcStartRecord(), ptcCompletionRecord({ rootCallId: 'call_other_root', value: answered })], PTC_SUB_CALL_ID), null);
  // A start with no completion yet proves nothing, and neither does an id native
  // never recorded as a PTC subcall.
  assert.equal(recordedQuestionAnswers([ptcStartRecord()], PTC_SUB_CALL_ID), null);
  assert.equal(recordedQuestionAnswers([ptcRootCallRecord()], PTC_ROOT_CALL_ID), null);
  assert.equal(recordedQuestionAnswers([], PTC_SUB_CALL_ID), null);
  // The completion's content has to be a real answer batch.
  const noBatch = [ptcStartRecord(), ptcCompletionRecord({ value: { pending: true, callId: PTC_SUB_CALL_ID } })];
  assert.equal(recordedQuestionAnswers(noBatch, PTC_SUB_CALL_ID), null);
});

test('a question PTC dispatched reaches the phone under the real subCallId, and is answered through it', async (t) => {
  const records = [ptcRootCallRecord(), ptcStartRecord()];
  const events = fakeEvents({ legacyWaits: [legacyHold(PTC_CARRIED)] });
  const adapter = await startAdapter(t, legacyFixtures(records), { events });

  // This is the exact case that produced no card: the projection is empty, the
  // newest open call is `run_code`, and the question is still real - it is the PTC
  // start's own `subCallId`.
  const before = await adapter.readSession('s-q');
  assert.deepEqual(before.pendingQuestions, [
    {
      callId: PTC_SUB_CALL_ID,
      state: 'open',
      questions: [{ id: 'phone_theme', header: '界面风格', question: '请选择手机工作台的界面风格', options: [{ label: '简洁浅色' }, { label: '自动深色' }] }],
    },
  ]);
  assert.equal((await adapter.listSessions())[0].needsInput, true, 'the held channel is real pending state');

  // The answer travels under that very subCallId, and the matching completion -
  // the `tool/ptc-dispatch` of the same subcall, `isError: false`, carrying this
  // exact batch - is what proves it landed.
  events.submitQuestionAnswer = async (input) => {
    events.calls.answers.push(input);
    records.push(ptcCompletionRecord({ seq: 22, value: { answers: PTC_ANSWERS } }));
    records.push(ptcRootResultRecord({ seq: 23 }));
    return { accepted: true };
  };
  const answered = await adapter.answerQuestion('s-q', PTC_SUB_CALL_ID, PTC_ANSWERS);
  assert.deepEqual(answered, { accepted: true, sessionId: 's-q', callId: PTC_SUB_CALL_ID });
  assert.deepEqual(events.calls.answers, [{ sessionId: 's-q', callId: PTC_SUB_CALL_ID, answers: PTC_ANSWERS }]);
  assert.equal(adapter.calls.some((call) => call.method === 'userQuestions/answer'), false, 'a PTC subcall has no unary path');

  // The subcall is settled now, so the form is gone from the phone.
  assert.equal((await adapter.readSession('s-q')).pendingQuestions, undefined);
});

test('a PTC question is accepted only when its own completion carries this exact batch', async (t) => {
  // Another client answered the same subcall first: this bridge must say so.
  const raced = [ptcRootCallRecord(), ptcStartRecord()];
  const racedEvents = fakeEvents({ legacyWaits: [legacyHold(PTC_CARRIED)] });
  racedEvents.submitQuestionAnswer = async (input) => {
    racedEvents.calls.answers.push(input);
    raced.push(ptcCompletionRecord({ seq: 22, value: { answers: [{ id: 'phone_theme', selected: ['简洁浅色'] }] } }));
    return { accepted: true };
  };
  const racedAdapter = await startAdapter(t, legacyFixtures(raced), { events: racedEvents, settleDelayMs: 1, settleAttempts: 2 });
  const racedErr = await racedAdapter.answerQuestion('s-q', PTC_SUB_CALL_ID, PTC_ANSWERS).catch((error) => error);
  assert.equal(racedErr.code, 'bridge_error');
  assert.match(racedErr.message, /already answered/i);
  assert.equal(racedEvents.calls.answers.length, 1, 'the submission happened once and was never retried');

  // The real failing completion (the `ASK_ABORTED` record from the session log)
  // proves nothing, and neither does a completion of a different subcall.
  const aborted = [ptcRootCallRecord(), ptcStartRecord()];
  const abortedEvents = fakeEvents({ legacyWaits: [legacyHold(PTC_CARRIED)] });
  abortedEvents.submitQuestionAnswer = async (input) => {
    abortedEvents.calls.answers.push(input);
    aborted.push(ptcCompletionRecord({ seq: 22, isError: true }));
    return { accepted: true };
  };
  const abortedAdapter = await startAdapter(t, legacyFixtures(aborted), { events: abortedEvents, settleDelayMs: 1, settleAttempts: 1 });
  const abortedErr = await abortedAdapter.answerQuestion('s-q', PTC_SUB_CALL_ID, PTC_ANSWERS).catch((error) => error);
  assert.equal(abortedErr.code, 'bridge_error');
  assert.match(abortedErr.message, /re-read/i);
  assert.equal(abortedEvents.calls.answers.length, 1);

  // A completion under another subCallId answers a different call, never this one.
  const otherSub = [ptcRootCallRecord(), ptcStartRecord()];
  const otherSubEvents = fakeEvents({ legacyWaits: [legacyHold(PTC_CARRIED)] });
  otherSubEvents.submitQuestionAnswer = async (input) => {
    otherSubEvents.calls.answers.push(input);
    otherSub.push(ptcCompletionRecord({ seq: 22, subCallId: `${PTC_ROOT_CALL_ID}:ptc:2`, value: { answers: PTC_ANSWERS } }));
    return { accepted: true };
  };
  const otherSubAdapter = await startAdapter(t, legacyFixtures(otherSub), { events: otherSubEvents, settleDelayMs: 1, settleAttempts: 1 });
  const otherSubErr = await otherSubAdapter.answerQuestion('s-q', PTC_SUB_CALL_ID, PTC_ANSWERS).catch((error) => error);
  assert.equal(otherSubErr.code, 'bridge_error');
  assert.match(otherSubErr.message, /re-read/i);
});

test('a PTC question no longer live is never shown and never answerable', async (t) => {
  // The run_code call already answered: its subcall window is over.
  const finished = fakeEvents({ legacyWaits: [legacyHold(PTC_CARRIED)] });
  const finishedAdapter = await startAdapter(
    t,
    legacyFixtures([ptcRootCallRecord(), ptcStartRecord(), ptcRootResultRecord()]),
    { events: finished, settleDelayMs: 1, settleAttempts: 1 },
  );
  assert.equal((await finishedAdapter.readSession('s-q')).pendingQuestions, undefined, 'an ended parent is not a live question');
  const finishedErr = await finishedAdapter.answerQuestion('s-q', PTC_SUB_CALL_ID, PTC_ANSWERS).catch((error) => error);
  assert.equal(finishedErr.code, 'session_not_found');
  assert.equal(finished.calls.answers.length, 0, 'nothing is submitted without a live call');

  // Two identical concurrent subcalls carrying this form: ambiguous, so the phone
  // is offered neither of them.
  const ambiguous = fakeEvents({ legacyWaits: [legacyHold(PTC_CARRIED)] });
  const ambiguousAdapter = await startAdapter(
    t,
    legacyFixtures([ptcRootCallRecord(), ptcStartRecord(), ptcStartRecord({ seq: 23, subCallId: `${PTC_ROOT_CALL_ID}:ptc:2` })]),
    { events: ambiguous, settleDelayMs: 1, settleAttempts: 1 },
  );
  assert.equal((await ambiguousAdapter.readSession('s-q')).pendingQuestions, undefined);
  const ambiguousErr = await ambiguousAdapter.answerQuestion('s-q', PTC_SUB_CALL_ID, PTC_ANSWERS).catch((error) => error);
  assert.equal(ambiguousErr.code, 'session_not_found');
  assert.equal(ambiguous.calls.answers.length, 0);

  // The stream lost the channel (a reconnect, an end, another answerer): the
  // question is simply not answerable from here.
  const lost = fakeEvents({ legacyWaits: [] });
  const lostAdapter = await startAdapter(t, legacyFixtures([ptcRootCallRecord(), ptcStartRecord()]), { events: lost, settleDelayMs: 1, settleAttempts: 1 });
  const lostErr = await lostAdapter.answerQuestion('s-q', PTC_SUB_CALL_ID, PTC_ANSWERS).catch((error) => error);
  assert.equal(lostErr.code, 'session_not_found');
  assert.equal(lost.calls.answers.length, 0);
});

test('DshAdapter.open({events:false}) is a real read-only open: no stream, list and read still work', async (t) => {
  // The port hint is this application's own file; point it at a scratch directory
  // so opening an adapter here cannot rewrite the one a live bridge uses.
  const previousLocalAppData = process.env.LOCALAPPDATA;
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-open-'));
  process.env.LOCALAPPDATA = scratch;
  t.after(() => {
    if (previousLocalAppData === undefined) delete process.env.LOCALAPPDATA;
    else process.env.LOCALAPPDATA = previousLocalAppData;
  });

  /** The same backend the other tests use, with `session/list` answering. */
  const upgrades = [];
  const methods = [];
  function startBackend() {
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', () => {
        const parsed = body ? JSON.parse(body) : {};
        const [name, value] = String(req.headers.cookie ?? '').split('=');
        const handler = parsed.method === 'session/list'
          ? () => ({ items: [{ sessionId: 's-1', title: 'Read only', updatedAt: 1770000000000, running: false, projections: { asOfSeq: 3, values: { title: 'Read only' } } }] })
          : parsed.method === 'session/projections'
            ? () => ({ asOfSeq: 3, values: {} })
            : parsed.method === 'session/page'
              ? () => ({ records: [], hasMore: false })
              : null;
        if (handler === null || name !== cookieName(req.headers.host) || !verifyCookie(value, SECRET_BYTES)) {
          res.writeHead(handler === null ? 200 : 401, { 'Content-Type': 'application/json' });
          res.end(handler === null ? JSON.stringify({ result: { ok: false, error: { code: 'method/unknown', message: 'nope' } } }) : '{"error":{"code":"unauthenticated"}}');
          return;
        }
        methods.push(parsed.method);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ result: { ok: true, value: handler() } }));
      });
    });
    server.on('upgrade', (request, socket) => {
      upgrades.push(true);
      socket.destroy();
    });
    return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
  }
  const server = await startBackend();
  t.after(() => new Promise((resolve) => server.close(resolve)));

  // `secret` is the documented discovery override, so this open needs no real
  // credential store; `ports: []` stops the netstat/tasklist scan.
  const adapter = await DshAdapter.open({ configuredPort: server.address().port, ports: [], secret: SECRET_BYTES, events: false });
  assert.equal(adapter.events, null, 'false means no stream, not a stream-shaped falsy value');
  assert.equal(upgrades.length, 0, 'no event connection was opened');
  assert.equal(adapter.describe().events, null);
  assert.deepEqual(adapter.pendingApprovalsOf('s-1'), [], 'a read-only adapter holds no approvals');
  const listed = await adapter.listSessions();
  assert.equal(listed.length, 1);
  assert.equal(listed[0].title, 'Read only');
  const read = await adapter.readSession('s-1');
  assert.equal(read.id, 's-1');
  assert.equal(read.pendingQuestions, undefined);
  assert.equal(read.pendingApprovals, undefined);
  // Nothing beyond session/list and session/page was needed, and no submission of
  // any kind reached the backend.
  assert.equal(methods.length > 0, true, 'the read-only adapter really talked to the backend');
  assert.equal(methods.every((method) => ['session/list', 'session/projections', 'session/page'].includes(method)), true);
});

test('a legacy open question reaches session.read under its real call id, and is answered through it', async (t) => {
  const records = [toolCallRecord({ seq: 10 })];
  const events = fakeEvents({ legacyWaits: [legacyHold()] });
  const adapter = await startAdapter(t, legacyFixtures(records), { events });
  // The whole point: the projection has no batch at all, and the question still
  // arrives - because the log itself names the call.
  const before = await adapter.readSession('s-q');
  assert.deepEqual(before.pendingQuestions, [
    {
      callId: LEGACY_CALL_ID,
      state: 'open',
      questions: [
        { id: 'q-1', question: 'Which one?', header: 'Choice', options: [{ label: 'One' }, { label: 'Two' }] },
        { id: 'q-2', question: 'Anything else?', options: [{ label: 'Yes' }, { label: 'No' }], multiSelect: true },
      ],
    },
  ]);

  // Native answers the tool call it was really asked, under this exact call id.
  events.submitQuestionAnswer = async (input) => {
    events.calls.answers.push(input);
    records.push(toolResultRecord({ seq: 11, value: { answers: LEGACY_ANSWERS } }));
    return { accepted: true };
  };
  const answered = await adapter.answerQuestion('s-q', LEGACY_CALL_ID, LEGACY_ANSWERS);
  assert.deepEqual(answered, { accepted: true, sessionId: 's-q', callId: LEGACY_CALL_ID });
  assert.deepEqual(events.calls.answers, [{ sessionId: 's-q', callId: LEGACY_CALL_ID, answers: LEGACY_ANSWERS }]);
  assert.equal(adapter.calls.some((call) => call.method === 'userQuestions/answer'), false, 'a legacy call has no unary path');

  // The answered call is gone from the log, so the question is gone too.
  const after = await adapter.readSession('s-q');
  assert.equal(after.pendingQuestions, undefined);
});

test('a legacy answer is accepted only when the tool result carries this exact batch', async (t) => {
  // Another client answered the same call first, with other answers: native
  // settled it, and this bridge must say so instead of claiming its own answer won.
  const otherAnswers = [{ id: 'q-1', selected: ['One'] }, { id: 'q-2', selected: [] }];
  const raced = [toolCallRecord({ seq: 10 })];
  const racedEvents = fakeEvents({ legacyWaits: [legacyHold()] });
  racedEvents.submitQuestionAnswer = async (input) => {
    racedEvents.calls.answers.push(input);
    raced.push(toolResultRecord({ seq: 11, value: { answers: otherAnswers } }));
    return { accepted: true };
  };
  const racedAdapter = await startAdapter(t, legacyFixtures(raced), { events: racedEvents, settleDelayMs: 1, settleAttempts: 2 });
  const racedErr = await racedAdapter.answerQuestion('s-q', LEGACY_CALL_ID, LEGACY_ANSWERS).catch((error) => error);
  assert.equal(racedErr.code, 'bridge_error');
  assert.match(racedErr.message, /already answered/i);
  assert.equal(racedEvents.calls.answers.length, 1, 'the submission happened once and was never retried');

  // No result is ever recorded: an honest failure the phone resolves by re-reading,
  // never an "HTTP 200 means answered".
  const silent = fakeEvents({ legacyWaits: [legacyHold()] });
  const silentAdapter = await startAdapter(t, legacyFixtures([toolCallRecord({ seq: 10 })]), { events: silent, settleDelayMs: 1, settleAttempts: 2 });
  const silentErr = await silentAdapter.answerQuestion('s-q', LEGACY_CALL_ID, LEGACY_ANSWERS).catch((error) => error);
  assert.equal(silentErr.code, 'bridge_error');
  assert.match(silentErr.message, /re-read/i);
  assert.equal(silent.calls.answers.length, 1);
});

test('a legacy question stays unanswerable when the log does not single its call out', async (t) => {
  // The newest unresolved call asked something else: nothing may be answered.
  const mismatched = fakeEvents({ legacyWaits: [legacyHold()] });
  const mismatchedAdapter = await startAdapter(
    t,
    legacyFixtures([toolCallRecord({ seq: 10, callId: 'call_other', questions: [{ id: 'q-9', question: 'A different question?' }] })]),
    { events: mismatched, settleDelayMs: 1, settleAttempts: 1 },
  );
  assert.equal((await mismatchedAdapter.readSession('s-q')).pendingQuestions, undefined, 'no correlation means no form on the phone');
  const mismatchedErr = await mismatchedAdapter.answerQuestion('s-q', 'call_other', LEGACY_ANSWERS).catch((error) => error);
  assert.equal(mismatchedErr.code, 'session_not_found');
  assert.equal(mismatched.calls.answers.length, 0, 'nothing is submitted without an exact correlation');

  // The call is over already: it has a result, so it can never be the live one.
  const finished = fakeEvents({ legacyWaits: [legacyHold()] });
  const finishedAdapter = await startAdapter(
    t,
    legacyFixtures([toolCallRecord({ seq: 10 }), toolResultRecord({ seq: 11, value: { answers: [LEGACY_ANSWERED_BATCH] } })]),
    { events: finished, settleDelayMs: 1, settleAttempts: 1 },
  );
  assert.equal((await finishedAdapter.readSession('s-q')).pendingQuestions, undefined);
  assert.equal(finished.calls.answers.length, 0);

  // The stream lost the channel (a reconnect, an end, or another answerer): the
  // question is simply not answerable from here, and nothing is guessed at.
  const lost = fakeEvents({ legacyWaits: [] });
  const lostAdapter = await startAdapter(t, legacyFixtures([toolCallRecord({ seq: 10 })]), { events: lost, settleDelayMs: 1, settleAttempts: 1 });
  const lostErr = await lostAdapter.answerQuestion('s-q', LEGACY_CALL_ID, LEGACY_ANSWERS).catch((error) => error);
  assert.equal(lostErr.code, 'session_not_found');
  assert.equal(lost.calls.answers.length, 0);
});

test('a legacy session really waiting shows as needsInput while its channel is held', async (t) => {
  const held = fakeEvents({ legacyWaits: [legacyHold()] });
  const waiting = await startAdapter(t, legacyFixtures([toolCallRecord({ seq: 10 })]), { events: held });
  const sessions = await waiting.listSessions();
  assert.equal(sessions[0].needsInput, true, 'a held legacy channel is real pending state');

  const quiet = await startAdapter(t, {
    'session/list': () => ({
      ok: true,
      value: { items: [{ sessionId: 's-q', title: 'Idle', updatedAt: 1770000000000, running: false, projections: { asOfSeq: 5, values: { title: 'Idle', userQuestions: { active: [], settled: [] } } } }] },
    }),
  });
  assert.equal((await quiet.listSessions())[0].needsInput, undefined, 'no held channel is no evidence');
});

test('two taps on one approval yield exactly one native submission', async (t) => {
  const events = fakeEvents();
  let releasePage;
  const pageGate = new Promise((resolve) => {
    releasePage = resolve;
  });
  const adapter = await startAdapter(
    t,
    {
      'session/list': () => ({
        ok: true,
        value: { items: [{ sessionId: 's-q', title: 'T', updatedAt: 1770000000000, running: false, projections: { asOfSeq: 5, values: { title: 'T' } } }] },
      }),
      'session/page': async () => {
        await pageGate;
        return { ok: true, value: { records: [] } };
      },
    },
    { events, settleDelayMs: 1, settleAttempts: 1 },
  );

  // Both taps start before either submission: the first is held inside the audit
  // read that precedes it, which is exactly the window two taps could both pass.
  const first = adapter.approveRequest('s-q', APPROVAL_ID, 'allow-once');
  const second = await adapter.approveRequest('s-q', APPROVAL_ID, 'allow-once').catch((error) => error);
  assert.equal(second.code, 'bridge_error');
  assert.match(second.message, /already being submitted/i);
  assert.deepEqual(events.calls.approvals, [], 'the second tap never reached the stream');
  releasePage();
  assert.deepEqual(await first, { accepted: true, sessionId: 's-q', approvalId: APPROVAL_ID, state: 'submitted' });
  assert.deepEqual(events.calls.approvals, [{ sessionId: 's-q', approvalId: APPROVAL_ID, decision: 'allow-once' }]);

  // The lock is released in `finally`: a later decision for the same request is
  // not refused because of a submission that is long over.
  const later = await adapter.approveRequest('s-q', APPROVAL_ID, 'reject').catch((error) => error);
  assert.equal(later.code, 'session_not_found', 'the request itself is what is gone, not the lock');
});