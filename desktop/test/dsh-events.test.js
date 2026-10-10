'use strict';
/**
 * Tests for the native DSH event stream (`src/dsh-events.js`).
 *
 * These run against a real local HTTP server that speaks the Gateway's actual
 * wire shapes: the `/api/remote.mux` WebSocket upgrade (with the loopback
 * `Origin`/cookie headers), the `{type:'open', endpoint:'$events'}` request, the
 * `ready`/`waterfall`/`cancel`/`end`/`error` items, and the unary
 * `$events/result` RPC. The server side is built from the independent frame codec
 * in `test/helpers/ws-server.js`, so a green run means the product's own client
 * really parsed those frames - not that one module agreed with a copy of itself.
 *
 * Nothing here touches a real backend: the port, the sessions and the approvals
 * are fixtures, and no native state is ever mutated.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const http = require('node:http');

const {
  DshEventStream,
  EVENT_LIMITS,
  questionKey,
} = require('../src/dsh-events');
const { DshClient, cookieName } = require('../src/adapters/dsh');
const { encodeServerFrame, ServerFrameReader, acceptKey } = require('./helpers/ws-server');

const SECRET_BYTES = Buffer.from('0123456789abcdef0123456789abcdef', 'utf8');

const SESSION_ID = '5f0d3a52-1c4b-4e6f-9a7b-8c9d0e1f2a3b';
const APPROVAL_ID = '11111111-2222-4333-8444-555555555555';
const OTHER_APPROVAL_ID = '99999999-8888-4777-8666-555555555555';
const CALL_ID = 'call-7';

/**
 * A gateway-shaped event id. The real ones come from `randomUUID()` in the
 * installed gateway, and the wire contract says UUID, so a fixture that used a
 * readable placeholder would be testing a shape native never sends.
 */
function eventIdOf(index) {
  return `${String(index).padStart(8, '0')}-1111-4111-8111-111111111111`;
}

/** One native approval request, exactly as `dsh-user-approval` raises it. */
function approvalFrame({ eventId = APPROVAL_ID, agentId = SESSION_ID, request = { toolName: 'run_command', callId: CALL_ID, reason: 'needs to run one command' } } = {}) {
  return { type: 'waterfall', event: 'approval/request', eventId, agentId, request };
}

/** One native open-question request, exactly as `dsh-user-questions` raises it. */
function questionFrame({ eventId = OTHER_APPROVAL_ID, agentId = SESSION_ID, callId = CALL_ID } = {}) {
  return {
    type: 'waterfall',
    event: 'user-questions/request',
    eventId,
    agentId,
    request: {
      questions: [
        { id: 'q-1', question: 'Which one?', header: 'Choice', options: [{ label: 'One' }, { label: 'Two' }] },
        { id: 'q-2', question: 'Anything else?', multiSelect: true, options: [{ label: 'Yes' }, { label: 'No' }] },
      ],
      wait: { callId, timed: true },
    },
  };
}

/**
 * A fake native backend: one HTTP server for the unary RPCs and one WebSocket
 * route for the event mux, over the same loopback port the product uses.
 */
async function startNativeBackend(t, options = {}) {
  const posts = [];
  const upgrades = [];
  const peers = [];
  const resultAnswer = options.resultAnswer ?? (() => ({ result: { ok: true, value: null } }));

  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      let parsed = {};
      try {
        parsed = body ? JSON.parse(body) : {};
      } catch {
        parsed = {};
      }
      const [name, value] = String(req.headers.cookie ?? '').split('=');
      posts.push({
        method: parsed.method,
        rpcId: parsed.rpcId,
        args: parsed.payload?.args ?? null,
        origin: req.headers.origin,
        host: req.headers.host,
        cookieName: name,
        cookieValue: value,
        cookieMatchesHost: name === cookieName(req.headers.host),
      });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(parsed.method === '$events/result' ? resultAnswer(posts.length) : { result: { ok: true, value: {} } }));
    });
  });

  server.on('upgrade', (req, socket) => {
    upgrades.push({ url: req.url, headers: req.headers });
    if (options.rejectUpgrade === true) {
      socket.write('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n');
      socket.destroy();
      return;
    }
    socket.write(
      `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${acceptKey(req.headers['sec-websocket-key'])}\r\n\r\n`,
    );
    const frames = [];
    const peer = {
      frames,
      sendItem: (value) => socket.write(encodeServerFrame(0x1, Buffer.from(JSON.stringify({ type: 'item', streamId: 'stream-1', value }), 'utf8'))),
      sendEnd: () => socket.write(encodeServerFrame(0x1, Buffer.from(JSON.stringify({ type: 'end', streamId: 'stream-1' }), 'utf8'))),
      sendError: (error) => socket.write(encodeServerFrame(0x1, Buffer.from(JSON.stringify({ type: 'error', streamId: 'stream-1', error }), 'utf8'))),
      sendRaw: (text) => socket.write(encodeServerFrame(0x1, Buffer.from(text, 'utf8'))),
      close: () => socket.destroy(),
      socket,
    };
    const reader = new ServerFrameReader({
      onFrame: ({ opcode, payload }) => {
        if (opcode === 0x1) {
          const text = payload.toString('utf8');
          frames.push(text);
          try {
            peer.onMessage?.(JSON.parse(text));
          } catch {
            peer.onMessage?.(null);
          }
        }
      },
      onProtocolError: () => socket.destroy(),
    });
    socket.on('data', (chunk) => reader.push(chunk));
    socket.on('error', () => {});
    peers.push(peer);
    options.onPeer?.(peer);
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;
  t.after(() => new Promise((resolve) => {
    for (const peer of peers) peer.socket.destroy();
    server.close(() => resolve());
  }));
  return {
    baseUrl,
    port,
    posts,
    upgrades,
    peers,
    url: `ws://127.0.0.1:${port}/api/remote.mux`,
    /** The `{clientId, eventId, outcome}` of every `$events/result` this backend got. */
    results: () => posts.filter((post) => post.method === '$events/result').map((post) => post.args),
  };
}

/** Wait until `check()` is true, bounded; a real socket needs a real moment. */
async function waitFor(check, timeoutMs = 2000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return check();
}

/** A stream wired to the fake backend exactly as the adapter wires it. */
function startStream(backend, overrides = {}) {
  const client = new DshClient({ baseUrl: backend.baseUrl, secret: SECRET_BYTES });
  const stream = new DshEventStream({
    wsUrl: backend.url,
    headers: () => client.eventHeaders(),
    sendResult: (args) => client.postEventResult(args),
    reconnectMs: 60,
    ...overrides,
  });
  return { stream, client };
}

test('the stream opens the real mux route with the loopback origin and cookie', async (t) => {
  const backend = await startNativeBackend(t);
  const { stream } = startStream(backend);
  t.after(() => stream.close());
  stream.start();
  assert.ok(await waitFor(() => backend.peers.length === 1), 'the mux WebSocket was opened');
  assert.ok(await waitFor(() => backend.peers[0].frames.length === 1), 'the open frame was sent');

  const upgrade = backend.upgrades[0];
  assert.equal(upgrade.url, '/api/remote.mux');
  assert.equal(upgrade.headers.origin, backend.baseUrl, 'the exact loopback origin');
  assert.equal(upgrade.headers.cookie?.split('=')[0], cookieName(`127.0.0.1:${backend.port}`));
  const open = JSON.parse(backend.peers[0].frames[0]);
  assert.equal(open.type, 'open');
  assert.equal(open.endpoint, '$events');
  assert.deepEqual(open.payload, { args: {} }, 'the event stream takes an empty args object');
  assert.match(open.streamId, /^[0-9a-f-]{36}$/);

  // `ready` is what proves the Host event source is up, and it carries the
  // clientId every later outcome must name.
  assert.equal(stream.connected, false);
  backend.peers[0].sendItem({ type: 'ready', clientId: 'client-A', host: { home: 'C:\\Users\\x' } });
  assert.ok(await waitFor(() => stream.connected));
  assert.equal(stream.clientId, 'client-A');
  assert.equal(stream.epoch, 1);
  assert.equal(stream.describe().clientId, 'set', 'the clientId itself is never reported as text');
});

test('a real approval is held with its tool, call and reason, and surfaced per session', async (t) => {
  const backend = await startNativeBackend(t);
  const { stream } = startStream(backend);
  t.after(() => stream.close());
  stream.start();
  assert.ok(await waitFor(() => backend.peers.length === 1));
  const peer = backend.peers[0];
  peer.sendItem({ type: 'ready', clientId: 'client-A', host: {} });
  assert.ok(await waitFor(() => stream.connected));

  peer.sendItem(approvalFrame());
  assert.ok(await waitFor(() => stream.approvalsFor(SESSION_ID).length === 1));
  assert.deepEqual(stream.approvalsFor(SESSION_ID), [
    { id: APPROVAL_ID, toolName: 'run_command', callId: CALL_ID, reason: 'needs to run one command' },
  ]);
  assert.deepEqual(stream.approvalsFor('another-session'), [], 'an approval belongs to one session only');
  assert.equal(backend.results().length, 0, 'a held approval is not delegated');
});

test('an unrelated waterfall is delegated at once, never held and never answered', async (t) => {
  const backend = await startNativeBackend(t);
  const { stream } = startStream(backend);
  t.after(() => stream.close());
  stream.start();
  assert.ok(await waitFor(() => backend.peers.length === 1));
  const peer = backend.peers[0];
  peer.sendItem({ type: 'ready', clientId: 'client-A', host: {} });
  assert.ok(await waitFor(() => stream.connected));

  peer.sendItem({ type: 'waterfall', event: 'approval/policy', eventId: eventIdOf(9), agentId: SESSION_ID, request: { policy: 'never' } });
  peer.sendItem({ type: 'emit', event: 'api-session/status', args: [] });
  assert.ok(await waitFor(() => backend.results().length === 1));
  assert.deepEqual(backend.results(), [{ clientId: 'client-A', eventId: eventIdOf(9), outcome: { kind: 'next' } }]);
  assert.equal(stream.approvalsFor(SESSION_ID).length, 0, 'an unknown waterfall never becomes an approval');

  // An event id the gateway could not have minted is not addressable: it is
  // dropped, never delegated with a bogus correlation and never held.
  peer.sendItem({ type: 'waterfall', event: 'approval/request', eventId: 'not-a-uuid', agentId: SESSION_ID, request: { toolName: 'run_command' } });
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(backend.results().length, 1);
  assert.equal(stream.approvalsFor(SESSION_ID).length, 0);
});

test('an approval form that cannot be represented in full is delegated, not trimmed', async (t) => {
  const backend = await startNativeBackend(t);
  const { stream } = startStream(backend);
  t.after(() => stream.close());
  stream.start();
  assert.ok(await waitFor(() => backend.peers.length === 1));
  const peer = backend.peers[0];
  peer.sendItem({ type: 'ready', clientId: 'client-A', host: {} });
  assert.ok(await waitFor(() => stream.connected));

  // A reason longer than the display bound, and an approval with no tool name.
  peer.sendItem(approvalFrame({ eventId: eventIdOf(1), request: { toolName: 'run_command', reason: 'x'.repeat(EVENT_LIMITS.reason + 1) } }));
  peer.sendItem(approvalFrame({ eventId: eventIdOf(2), request: { reason: 'no tool named' } }));
  assert.ok(await waitFor(() => backend.results().length === 2));
  assert.deepEqual(
    backend.results().map((result) => result.eventId).sort(),
    [eventIdOf(1), eventIdOf(2)].sort(),
  );
  assert.equal(stream.approvalsFor(SESSION_ID).length, 0);

  // Beyond the cap, the overflow is delegated too - never a partial list.
  for (let index = 0; index <= EVENT_LIMITS.approvals; index += 1) {
    peer.sendItem(approvalFrame({ eventId: eventIdOf(100 + index) }));
  }
  assert.ok(await waitFor(() => stream.approvalsFor(SESSION_ID).length === EVENT_LIMITS.approvals));
  assert.equal(backend.results().length, 2 + 1, 'exactly the overflow was delegated');
});

test('a decision is submitted once, with the exact clientId, eventId and outcome', async (t) => {
  const backend = await startNativeBackend(t);
  const { stream } = startStream(backend);
  t.after(() => stream.close());
  stream.start();
  assert.ok(await waitFor(() => backend.peers.length === 1));
  const peer = backend.peers[0];
  peer.sendItem({ type: 'ready', clientId: 'client-A', host: {} });
  assert.ok(await waitFor(() => stream.connected));
  peer.sendItem(approvalFrame());
  assert.ok(await waitFor(() => stream.approvalsFor(SESSION_ID).length === 1));

  const outcome = await stream.submitApproval({ sessionId: SESSION_ID, approvalId: APPROVAL_ID, decision: 'allow-once' });
  // The native transport acknowledged the submission - which is all that may be
  // claimed from it: another client may have decided the same request first and
  // the server would still answer ok.
  assert.deepEqual(outcome, { accepted: true, state: 'submitted' });
  // The wire word is `allow-once`; what native must receive is its OWN vocabulary
  // word `allowed-once` - anything else is normalized to `unavailable` by
  // `dsh-user-approval`, i.e. a decision that grants nothing while looking taken.
  assert.deepEqual(backend.results(), [
    { clientId: 'client-A', eventId: APPROVAL_ID, outcome: { kind: 'result', value: 'allowed-once' } },
  ]);
  const post = backend.posts.find((entry) => entry.method === '$events/result');
  assert.equal(post.origin, backend.baseUrl, 'the submission carries the loopback origin too');
  assert.equal(post.cookieMatchesHost, true);

  // The card is gone, so a second tap cannot decide twice.
  assert.deepEqual(stream.approvalsFor(SESSION_ID), []);
  const again = await stream.submitApproval({ sessionId: SESSION_ID, approvalId: APPROVAL_ID, decision: 'reject' }).catch((error) => error);
  assert.equal(again.code, 'session_not_found');
  assert.equal(backend.results().length, 1, 'a second tap never reaches native');
});

test('an unknown, wrong-session or already-cancelled approval is refused without sending', async (t) => {
  const backend = await startNativeBackend(t);
  const { stream } = startStream(backend);
  t.after(() => stream.close());
  stream.start();
  assert.ok(await waitFor(() => backend.peers.length === 1));
  const peer = backend.peers[0];
  peer.sendItem({ type: 'ready', clientId: 'client-A', host: {} });
  assert.ok(await waitFor(() => stream.connected));

  const unknown = await stream.submitApproval({ sessionId: SESSION_ID, approvalId: 'nope', decision: 'allow-once' }).catch((error) => error);
  assert.equal(unknown.code, 'session_not_found');
  assert.equal(backend.results().length, 0);

  peer.sendItem(approvalFrame());
  assert.ok(await waitFor(() => stream.approvalsFor(SESSION_ID).length === 1));
  const wrongSession = await stream.submitApproval({ sessionId: 'another-session', approvalId: APPROVAL_ID, decision: 'allow-once' }).catch((error) => error);
  assert.equal(wrongSession.code, 'session_not_found');
  assert.equal(backend.results().length, 0, 'a request is only ever decided for its own session');

  // Native cancels the request (another answerer won, or the turn ended).
  peer.sendItem({ type: 'cancel', eventId: APPROVAL_ID });
  assert.ok(await waitFor(() => stream.approvalsFor(SESSION_ID).length === 0));
  const cancelled = await stream.submitApproval({ sessionId: SESSION_ID, approvalId: APPROVAL_ID, decision: 'allow-once' }).catch((error) => error);
  assert.equal(cancelled.code, 'session_not_found');
  assert.equal(backend.results().length, 0, 'a cancelled request is never answered from a stale card');
});

test('nothing survives the stream: end, error and close all invalidate every held request', async (t) => {
  const backend = await startNativeBackend(t);
  const { stream } = startStream(backend, { reconnectMs: 5000 });
  t.after(() => stream.close());
  stream.start();
  assert.ok(await waitFor(() => backend.peers.length === 1));

  // A fresh generation of the same build: a new clientId means the old ids are dead.
  backend.peers[0].sendItem({ type: 'ready', clientId: 'client-A', host: {} });
  assert.ok(await waitFor(() => stream.connected));
  backend.peers[0].sendItem(approvalFrame());
  backend.peers[0].sendItem(questionFrame());
  assert.ok(await waitFor(() => stream.approvalsFor(SESSION_ID).length === 1 && stream.hasQuestionWait(SESSION_ID, CALL_ID)));

  backend.peers[0].sendItem({ type: 'ready', clientId: 'client-B', host: {} });
  assert.ok(await waitFor(() => stream.clientId === 'client-B'));
  assert.deepEqual(stream.approvalsFor(SESSION_ID), [], 'a new generation holds nothing of the old one');
  assert.equal(stream.hasQuestionWait(SESSION_ID, CALL_ID), false);

  // `error` and `end` are the same story.
  backend.peers[0].sendItem(approvalFrame());
  assert.ok(await waitFor(() => stream.approvalsFor(SESSION_ID).length === 1));
  backend.peers[0].sendItem({ type: 'ready', clientId: 'client-C', host: {} });
  assert.ok(await waitFor(() => stream.clientId === 'client-C'));
  backend.peers[0].sendItem(approvalFrame());
  assert.ok(await waitFor(() => stream.approvalsFor(SESSION_ID).length === 1));
  backend.peers[0].sendError({ code: 'gateway/cancelled', message: 'gone', details: {} });
  assert.ok(await waitFor(() => stream.connected === false));
  assert.deepEqual(stream.approvalsFor(SESSION_ID), []);
  const afterError = await stream.submitApproval({ sessionId: SESSION_ID, approvalId: APPROVAL_ID, decision: 'allow-once' }).catch((error) => error);
  assert.equal(afterError.code, 'session_not_found');

  // A generation collected before a teardown can never be submitted afterwards.
  const stale = startStream(backend, { reconnectMs: 5000 });
  t.after(() => stale.stream.close());
  stale.stream.start();
  assert.ok(await waitFor(() => backend.peers.length === 2));
  const second = backend.peers[1];
  second.sendItem({ type: 'ready', clientId: 'client-D', host: {} });
  assert.ok(await waitFor(() => stale.stream.connected));
  second.sendItem(approvalFrame());
  assert.ok(await waitFor(() => stale.stream.approvalsFor(SESSION_ID).length === 1));
  const before = backend.results().length;
  stale.stream.close();
  const closed = await stale.stream.submitApproval({ sessionId: SESSION_ID, approvalId: APPROVAL_ID, decision: 'allow-once' }).catch((error) => error);
  assert.equal(closed.code, 'session_not_found');
  assert.equal(backend.results().length, before, 'a closed stream submits nothing');
});

test('an open question is answerable through its live waterfall, and only then', async (t) => {
  const backend = await startNativeBackend(t);
  const { stream } = startStream(backend);
  t.after(() => stream.close());
  stream.start();
  assert.ok(await waitFor(() => backend.peers.length === 1));
  const peer = backend.peers[0];
  peer.sendItem({ type: 'ready', clientId: 'client-A', host: {} });
  assert.ok(await waitFor(() => stream.connected));

  // Before the request arrives, an open question has no answer channel at all.
  const early = await stream.submitQuestionAnswer({ sessionId: SESSION_ID, callId: CALL_ID, answers: [] }).catch((error) => error);
  assert.equal(early.code, 'not_capable');
  assert.equal(backend.results().length, 0);

  peer.sendItem(questionFrame());
  assert.ok(await waitFor(() => stream.hasQuestionWait(SESSION_ID, CALL_ID)));
  assert.deepEqual([...stream.answerableQuestionCalls(SESSION_ID)], [CALL_ID]);

  // The batch is re-checked against the very form the request carried.
  const badId = await stream.submitQuestionAnswer({ sessionId: SESSION_ID, callId: CALL_ID, answers: [{ id: 'q-9', selected: [] }, { id: 'q-2', selected: [] }] }).catch((error) => error);
  assert.equal(badId.code, 'invalid_params');
  const badLabel = await stream.submitQuestionAnswer({ sessionId: SESSION_ID, callId: CALL_ID, answers: [{ id: 'q-1', selected: ['Three'] }, { id: 'q-2', selected: [] }] }).catch((error) => error);
  assert.equal(badLabel.code, 'invalid_params');
  const tooMany = await stream.submitQuestionAnswer({ sessionId: SESSION_ID, callId: CALL_ID, answers: [{ id: 'q-1', selected: ['One', 'Two'] }, { id: 'q-2', selected: [] }] }).catch((error) => error);
  assert.equal(tooMany.code, 'invalid_params');
  const short = await stream.submitQuestionAnswer({ sessionId: SESSION_ID, callId: CALL_ID, answers: [{ id: 'q-1', selected: ['One'] }] }).catch((error) => error);
  assert.equal(short.code, 'invalid_params');
  assert.equal(backend.results().length, 0, 'no refused batch ever reaches native');

  const answers = [
    { id: 'q-1', selected: ['Two'] },
    { id: 'q-2', selected: ['Yes', 'No'], custom: 'both, somehow' },
  ];
  const accepted = await stream.submitQuestionAnswer({ sessionId: SESSION_ID, callId: CALL_ID, answers });
  assert.deepEqual(accepted, { accepted: true });
  assert.deepEqual(backend.results(), [
    {
      clientId: 'client-A',
      eventId: OTHER_APPROVAL_ID,
      outcome: { kind: 'result', value: { answers } },
    },
  ]);
  assert.equal(stream.hasQuestionWait(SESSION_ID, CALL_ID), false, 'one submission closes the channel');
});

test('a question form this bridge cannot show in full is delegated instead of held', async (t) => {
  const backend = await startNativeBackend(t);
  const { stream } = startStream(backend);
  t.after(() => stream.close());
  stream.start();
  assert.ok(await waitFor(() => backend.peers.length === 1));
  const peer = backend.peers[0];
  peer.sendItem({ type: 'ready', clientId: 'client-A', host: {} });
  assert.ok(await waitFor(() => stream.connected));

  const oversized = questionFrame({ eventId: eventIdOf(3) });
  oversized.request.questions = [
    { id: 'q-1', question: 'x', options: Array.from({ length: EVENT_LIMITS.options + 1 }, (_, i) => ({ label: `l-${i}` })) },
  ];
  peer.sendItem(oversized);
  // A blocking call that carries a `wait` this build does not understand - a
  // callId with `timed` absent - is delegated too: only a request the service
  // really raised with `wait.timed` names its own tool call.
  const blocking = questionFrame({ eventId: eventIdOf(5) });
  blocking.request.wait = { callId: CALL_ID };
  peer.sendItem(blocking);
  assert.ok(await waitFor(() => backend.results().length === 2));
  assert.deepEqual(
    backend.results().map((result) => result.eventId).sort(),
    [eventIdOf(3), eventIdOf(5)].sort(),
  );
  assert.equal(stream.answerableQuestionCalls(SESSION_ID).size, 0);
});

test('a legacy blocking request is held unresolved, answered under its real tool call, and never guessed at', async (t) => {
  const backend = await startNativeBackend(t);
  const { stream } = startStream(backend);
  t.after(() => stream.close());
  stream.start();
  assert.ok(await waitFor(() => backend.peers.length === 1));
  const peer = backend.peers[0];
  peer.sendItem({ type: 'ready', clientId: 'client-A', host: {} });
  assert.ok(await waitFor(() => stream.connected));

  /**
   * The shipped default: `tool-ask-user` in `legacy` mode calls
   * `ctx.userQuestions.ask()` with no `wait`, and the service forwards only
   * `questions`, `agent` and `signal` (`dsh-user-questions/lib/index.js`,
   * `ask`). This frame is therefore the real legacy shape.
   */
  const legacy = questionFrame({ eventId: eventIdOf(6) });
  delete legacy.request.wait;
  peer.sendItem(legacy);

  assert.ok(await waitFor(() => stream.hasLegacyQuestion(SESSION_ID)));
  const held = stream.unresolvedLegacyQuestionWaitsFor(SESSION_ID);
  assert.equal(held.length, 1, 'exactly one unresolved legacy channel is held for the session');
  assert.equal(held[0].callId, null, 'the request itself names no call id');
  assert.equal(held[0].eventId, eventIdOf(6));
  assert.deepEqual(held[0].questions, legacy.request.questions, 'the form native carried is kept whole');
  assert.deepEqual(backend.results(), [], 'a held legacy request is not delegated');
  assert.deepEqual([...stream.answerableQuestionCalls(SESSION_ID)], [], 'it has no call id until the session log names one');

  // The caller correlates it with the real `ask_user_question` tool call and
  // submits under that id: the same answers batch native validates against.
  const answers = [{ id: 'q-1', selected: ['Two'] }, { id: 'q-2', selected: [] }];
  const accepted = await stream.submitQuestionAnswer({ sessionId: SESSION_ID, callId: 'call-42', answers });
  assert.deepEqual(accepted, { accepted: true });
  assert.deepEqual(backend.results(), [
    { clientId: 'client-A', eventId: eventIdOf(6), outcome: { kind: 'result', value: { answers } } },
  ]);
  assert.equal(stream.hasLegacyQuestion(SESSION_ID), false, 'one submission closes the channel');

  // A batch that does not fit the form native carried never reaches native, even
  // on the legacy path.
  peer.sendItem(legacy);
  assert.ok(await waitFor(() => stream.hasLegacyQuestion(SESSION_ID)));
  const tooMany = await stream
    .submitQuestionAnswer({ sessionId: SESSION_ID, callId: 'call-42', answers: [{ id: 'q-1', selected: ['One', 'Two'] }, { id: 'q-2', selected: [] }] })
    .catch((error) => error);
  assert.equal(tooMany.code, 'invalid_params');
  assert.equal(backend.results().length, 1, 'no refused batch ever reaches native');
});

test('two legacy forms in one session: the newer is held, the older goes back to the next answerer', async (t) => {
  const backend = await startNativeBackend(t);
  const { stream } = startStream(backend);
  t.after(() => stream.close());
  stream.start();
  assert.ok(await waitFor(() => backend.peers.length === 1));
  const peer = backend.peers[0];
  peer.sendItem({ type: 'ready', clientId: 'client-A', host: {} });
  assert.ok(await waitFor(() => stream.connected));

  const first = questionFrame({ eventId: eventIdOf(7) });
  delete first.request.wait;
  const second = questionFrame({ eventId: eventIdOf(8) });
  delete second.request.wait;

  peer.sendItem(first);
  assert.ok(await waitFor(() => stream.hasLegacyQuestion(SESSION_ID)));
  peer.sendItem(second);
  // Two identical held forms could not be told apart, so only the newer one stays
  // here and the displaced one is handed back - never answered from a guess.
  assert.ok(await waitFor(() => backend.results().length === 1));
  assert.deepEqual(backend.results(), [{ clientId: 'client-A', eventId: eventIdOf(7), outcome: { kind: 'next' } }]);
  const held = stream.unresolvedLegacyQuestionWaitsFor(SESSION_ID);
  assert.equal(held.length, 1);
  assert.equal(held[0].eventId, eventIdOf(8), 'the newer form is the one this bridge can answer');

  const answers = [{ id: 'q-1', selected: ['One'] }, { id: 'q-2', selected: [] }];
  await stream.submitQuestionAnswer({ sessionId: SESSION_ID, callId: 'call-42', answers });
  assert.deepEqual(backend.results().at(-1), {
    clientId: 'client-A',
    eventId: eventIdOf(8),
    outcome: { kind: 'result', value: { answers } },
  });
});

test('one answer is submitted once, even when two taps race the same held form', async (t) => {
  const backend = await startNativeBackend(t);
  const { stream } = startStream(backend);
  t.after(() => stream.close());
  stream.start();
  assert.ok(await waitFor(() => backend.peers.length === 1));
  const peer = backend.peers[0];
  peer.sendItem({ type: 'ready', clientId: 'client-A', host: {} });
  assert.ok(await waitFor(() => stream.connected));

  // One submission is held open at the transport, so the second tap really does
  // arrive while the first is in flight.
  const gate = {};
  const released = new Promise((resolve) => {
    gate.resolve = resolve;
  });
  const realSend = stream.sendResult;
  let sends = 0;
  stream.sendResult = async (args) => {
    sends += 1;
    await released;
    return realSend(args);
  };

  const legacy = questionFrame({ eventId: eventIdOf(9) });
  delete legacy.request.wait;
  peer.sendItem(legacy);
  assert.ok(await waitFor(() => stream.hasLegacyQuestion(SESSION_ID)));

  const answers = [{ id: 'q-1', selected: ['Two'] }, { id: 'q-2', selected: ['Yes'] }];
  let settled = false;
  const first = stream.submitQuestionAnswer({ sessionId: SESSION_ID, callId: 'call-42', answers }).then((value) => {
    settled = true;
    return value;
  });
  const second = await stream.submitQuestionAnswer({ sessionId: SESSION_ID, callId: 'call-42', answers }).catch((error) => error);
  // The second tap finds the channel already taken: refused, with no second
  // native submission, and never deferred until the first one answers for it.
  assert.equal(second.code, 'not_capable');
  assert.equal(settled, false, 'the first submission was still in flight when the second tap arrived');
  gate.resolve();
  assert.deepEqual(await first, { accepted: true });
  assert.equal(sends, 1, 'exactly one native submission went out');
  assert.equal(backend.results().length, 1);
});

test('a submission the backend refuses is an error, never a quiet success', async (t) => {
  const backend = await startNativeBackend(t, {
    resultAnswer: () => ({ result: { ok: false, error: { code: 'gateway/bad-request', message: 'no such event' } } }),
  });
  const { stream } = startStream(backend);
  t.after(() => stream.close());
  stream.start();
  assert.ok(await waitFor(() => backend.peers.length === 1));
  const peer = backend.peers[0];
  peer.sendItem({ type: 'ready', clientId: 'client-A', host: {} });
  assert.ok(await waitFor(() => stream.connected));
  peer.sendItem(approvalFrame());
  assert.ok(await waitFor(() => stream.approvalsFor(SESSION_ID).length === 1));

  const refused = await stream.submitApproval({ sessionId: SESSION_ID, approvalId: APPROVAL_ID, decision: 'reject' }).catch((error) => error);
  assert.equal(refused.code, 'bridge_error');
  assert.equal(stream.approvalsFor(SESSION_ID).length, 0, 'the card does not come back after a transport failure');
});

test('a rejected upgrade or a dead socket leaves the bridge working, with nothing held', async (t) => {
  const backend = await startNativeBackend(t, { rejectUpgrade: true });
  const { stream } = startStream(backend, { reconnectMs: 30 });
  t.after(() => stream.close());
  stream.start();
  assert.ok(await waitFor(() => backend.upgrades.length >= 1));
  assert.equal(stream.connected, false);
  assert.deepEqual(stream.approvalsFor(SESSION_ID), []);
  assert.equal(typeof stream.describe().lastError, 'string');
  // It really keeps trying, with its own backoff, and never throws at the owner.
  assert.ok(await waitFor(() => backend.upgrades.length >= 2, 1500), 'the stream retries on its own');
});

test('a malformed frame is ignored, and a ready without a clientId changes nothing', async (t) => {
  const backend = await startNativeBackend(t);
  const { stream } = startStream(backend);
  t.after(() => stream.close());
  stream.start();
  assert.ok(await waitFor(() => backend.peers.length === 1));
  const peer = backend.peers[0];
  peer.sendItem({ type: 'ready', clientId: 'client-A', host: {} });
  assert.ok(await waitFor(() => stream.connected));
  peer.sendItem(approvalFrame());
  assert.ok(await waitFor(() => stream.approvalsFor(SESSION_ID).length === 1));

  peer.sendRaw('this is not JSON');
  peer.sendRaw(JSON.stringify({ type: 'item', streamId: 'stream-1', value: { type: 'ready' } }));
  peer.sendRaw(JSON.stringify({ type: 'item', streamId: 'stream-1', value: null }));
  peer.sendRaw(JSON.stringify({ type: 'unknown-kind' }));
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(stream.connected, true, 'a frame this build does not know is not fatal');
  assert.equal(stream.approvalsFor(SESSION_ID).length, 1, 'the real approval is still held');
  assert.deepEqual(backend.results(), [], 'nothing was delegated or answered by the noise');
});

test('the stream never keeps the process alive, and closing it is final', async (t) => {
  const backend = await startNativeBackend(t);
  const { stream } = startStream(backend);
  stream.start();
  assert.ok(await waitFor(() => backend.peers.length === 1));
  assert.ok(await waitFor(() => stream.connected === false || stream.connected === true));
  // The socket is unref'd, so an otherwise idle process can exit.
  const socket = stream.ws?.socket;
  if (socket !== null && socket !== undefined) {
    assert.equal(typeof socket.unref, 'function');
  }
  const peerCount = backend.peers.length;
  stream.close();
  assert.equal(stream.stopped, true);
  await new Promise((resolve) => setTimeout(resolve, 120));
  assert.equal(backend.peers.length, peerCount, 'a closed stream does not reconnect');
});

test('one native identity is a session and a call, never a bare callId', () => {
  assert.notEqual(questionKey('s-1', 'c-1'), questionKey('s-2', 'c-1'));
  assert.equal(questionKey('s-1', 'c-1'), questionKey('s-1', 'c-1'));
});
