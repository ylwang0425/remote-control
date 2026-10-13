'use strict';
/**
 * The two desktop-side contract tests of protocol-v1 §13, plus the connection
 * behaviour they depend on.
 *
 * The peer is a real WebSocket server playing the relay, so these tests prove the
 * handshake, the frames and the answer shapes crossed a real socket - the only
 * thing mocked is "the relay's own bookkeeping".
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const os = require('node:os');
const path = require('node:path');

const { BridgeClient } = require('../src/bridge');
const { createDispatcher } = require('../src/index');
const { WebSocketClient } = require('../src/ws');
const { startWsServer } = require('./helpers/ws-server');
const { buildCapabilities, fitSessionReadResult } = require('../src/protocol');
const { BridgeError } = require('../src/errors');

const TOKEN = 'test-bridge-token-0123456789';
const CLIENT_NAME = 'DESKTOP-TEST';

/** The relay's half of the link, as far as these tests need it. */
class FakeRelay {
  constructor(options = {}) {
    this.received = [];
    this.connections = [];
    this.answerHelloOk = options.answerHelloOk !== false;
    this.acceptedTokens = new Set(options.acceptedTokens ?? [TOKEN]);
    this.helloOkOverrides = options.helloOkOverrides ?? {};
    this.onFrame = options.onFrame ?? null;
    this.server = null;
  }

  async start() {
    this.server = await startWsServer({
      onUpgrade: (req) => {
        const authorization = req.headers.authorization ?? '';
        if (!this.acceptedTokens.has(authorization.slice('Bearer '.length)) || !authorization.startsWith('Bearer ')) {
          this.lastReject = { statusCode: 401, body: '{"ok":false,"error":{"code":"unauthenticated"}}' };
          return { accept: false, statusCode: 401, body: this.lastReject.body };
        }
        if (req.headers.origin !== undefined) {
          this.lastReject = { statusCode: 403, body: '{"ok":false,"error":{"code":"origin_forbidden"}}' };
          return { accept: false, statusCode: 403, body: this.lastReject.body };
        }
        return { accept: true };
      },
      onConnection: (peer) => {
        this.connections.push(peer);
        peer.on('message', (text) => {
          let frame;
          try {
            frame = JSON.parse(text);
          } catch {
            frame = { type: '<unparseable>' };
          }
          this.received.push(frame);
          if (frame.type === 'hello' && this.answerHelloOk) {
            peer.sendText(JSON.stringify(this.helloOk()));
          }
          if (this.onFrame) this.onFrame(peer, frame, this);
        });
      },
    });
    return this;
  }

  helloOk() {
    return {
      type: 'hello.ok',
      version: 1,
      serverTime: '2026-10-08T03:58:07Z',
      heartbeatIntervalMs: 20000,
      idleTimeoutMs: 60000,
      requestTimeoutMs: 30000,
      maxPending: 16,
      ...this.helloOkOverrides,
    };
  }

  /** The last connection's peer, i.e. the one the bridge is using. */
  get peer() {
    return this.connections[this.connections.length - 1];
  }

  sendRequest(frame) {
    this.peer.sendText(JSON.stringify(frame));
  }

  /** Wait for a response frame with this id. */
  async responseFor(id, timeoutMs = 3000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const found = this.received.find((frame) => frame.type === 'response' && frame.id === id);
      if (found !== undefined) return found;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    return null;
  }

  get url() {
    return this.server.url;
  }

  close() {
    return this.server.close();
  }
}

function makeCapabilities() {
  return buildCapabilities(['codex', 'dsh'], { stopCodex: false, stopDsh: true });
}

/** A dispatch stand-in that records every call, like a session table would. */
function makeDispatch(options = {}) {
  const calls = [];
  const sessions = options.sessions ?? [
    { id: 'thread-1', tool: 'codex', title: 'A thread', status: 'working', updatedAt: '2026-10-08T05:12:00Z', cwd: null },
  ];
  return {
    calls,
    sessions,
    async dispatch({ method, params }) {
      calls.push({ method, params });
      if (method === 'sessions.list') {
        return { sessions: sessions.map((session) => ({ ...session })), capabilities: makeCapabilities() };
      }
      if (method === 'session.read') {
        if (options.failRead) throw new BridgeError('session_not_found', 'that session is gone');
        return {
          id: params.sessionId,
          tool: params.tool,
          title: 'A thread',
          status: 'working',
          messages: [
            { id: 'm-1', role: 'user', text: 'one', timestamp: '2026-10-08T05:00:00Z' },
            { id: 'm-2', role: 'assistant', text: 'two', timestamp: '2026-10-08T05:00:01Z' },
          ],
          canStop: false,
          activeTurnId: 'turn-1',
        };
      }
      if (method === 'session.send') {
        // A send must not create anything: the session table keeps its length.
        return { accepted: true, sessionId: params.sessionId };
      }
      if (method === 'session.stop') {
        throw new BridgeError('not_capable', 'this Codex session cannot be stopped through the app-tools pipe');
      }
      throw new BridgeError('unknown_method', 'method is not allowed');
    },
  };
}

async function connectedBridge(t, options = {}) {
  const relay = await new FakeRelay(options.relay).start();
  t.after(() => relay.close());
  const dispatch = makeDispatch(options.dispatch);
  const bridge = new BridgeClient({
    url: relay.url,
    token: TOKEN,
    clientName: CLIENT_NAME,
    capabilities: makeCapabilities(),
    dispatch: dispatch.dispatch,
    backoff: { next: () => 10, reset: () => {}, reject: () => 10 },
    ...options.bridge,
  });
  t.after(() => bridge.stop());
  await bridge.start();
  await bridge.waitUntilConnected(2000);
  return { relay, bridge, dispatch };
}

test('contract 1: the connection carries Bearer and no Origin, and the first frame is a valid hello', async (t) => {
  const { relay, bridge } = await connectedBridge(t);
  const [request] = relay.server.requests;
  assert.equal(request.headers.authorization, `Bearer ${TOKEN}`);
  assert.equal(request.headers.origin, undefined);
  assert.equal(relay.received[0].type, 'hello', 'the first frame is the hello');
  const hello = relay.received[0];
  assert.equal(hello.version, 1);
  assert.equal(hello.clientName, CLIENT_NAME);
  assert.ok(Array.isArray(hello.capabilities.tools) && hello.capabilities.tools.length >= 1);
  assert.equal(new Set(hello.capabilities.tools).size, hello.capabilities.tools.length);
  assert.equal(bridge.connected, true);
  const allowed = ['hello', 'pair.create', 'ping', 'pong', 'response'];
  for (const frame of relay.received) {
    assert.ok(allowed.includes(frame.type), `the bridge never sends ${frame.type}`);
  }
});

test('saving a computer name refreshes identity on the authenticated bridge without replacing its session', async (t) => {
  const clientId = '98c9e96b-5d91-4a04-8d89-e2bdd29e30a5';
  const { relay, bridge } = await connectedBridge(t, {
    bridge: { clientId, ownerName: 'Before' },
  });
  assert.equal(relay.received[0].clientId, clientId);
  assert.equal(relay.received[0].ownerName, 'Before');
  const connectionsBefore = relay.connections.length;

  assert.equal(bridge.updateIdentity({ clientId, ownerName: 'admin', clientName: CLIENT_NAME }), true);
  const deadline = Date.now() + 1000;
  while (Date.now() < deadline && relay.received.filter((frame) => frame.type === 'hello').length < 2) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  const hellos = relay.received.filter((frame) => frame.type === 'hello');
  assert.equal(hellos.length, 2);
  assert.equal(hellos[1].clientId, clientId, 'the UUID remains stable');
  assert.equal(hellos[1].ownerName, 'admin');
  assert.equal(relay.connections.length, connectionsBefore, 'a label edit does not replace or restart the authenticated connection');
});

test('a local capability refresh sends a repeated hello without changing this client identity or connection', async (t) => {
  const clientId = '98c9e96b-5d91-4a04-8d89-e2bdd29e30a5';
  const { relay, bridge } = await connectedBridge(t, {
    bridge: { clientId, ownerName: 'Local user' },
  });
  const originalCapabilities = bridge.capabilities;
  const connectionCount = relay.connections.length;
  const updated = buildCapabilities(['codex', 'dsh', 'workbuddy'], {
    modelsList: true,
    sessionCreate: true,
    sendWorkbuddy: false,
    modelsListWorkbuddy: false,
    sessionCreateWorkbuddy: false,
    stopWorkbuddy: false,
  });

  assert.equal(bridge.updateCapabilities(updated), true);
  assert.equal(bridge.capabilities, updated);
  assert.notEqual(bridge.capabilities, originalCapabilities);
  const deadline = Date.now() + 1000;
  while (Date.now() < deadline && relay.received.filter((frame) => frame.type === 'hello').length < 2) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  const hellos = relay.received.filter((frame) => frame.type === 'hello');
  assert.equal(hellos.length, 2);
  assert.equal(hellos[1].clientId, clientId);
  assert.equal(hellos[1].ownerName, 'Local user');
  assert.equal(hellos[1].clientName, CLIENT_NAME);
  assert.equal(hellos[1].capabilities['session.send:workbuddy'], false);
  assert.equal(relay.connections.length, connectionCount, 'capability refresh does not reconnect or change transport identity');
});

test('enrollment replaces only the bridge credentials and reconnects with the new identity', async (t) => {
  const nextToken = 'enrolled-token-0123456789';
  const clientId = '98c9e96b-5d91-4a04-8d89-e2bdd29e30a5';
  const { relay, bridge } = await connectedBridge(t, {
    relay: { acceptedTokens: [TOKEN, nextToken] },
    bridge: { clientId, ownerName: 'Before' },
  });
  const connectionsBefore = relay.connections.length;

  bridge.updateConnection({
    url: relay.url,
    token: nextToken,
    clientId,
    ownerName: 'Kitchen PC',
    clientName: CLIENT_NAME,
  });
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline && relay.connections.length === connectionsBefore) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  while (Date.now() < deadline && !bridge.connected) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }

  assert.equal(relay.connections.length, connectionsBefore + 1, 'only the bridge transport is replaced');
  const lastRequest = relay.server.requests[relay.server.requests.length - 1];
  assert.equal(lastRequest.headers.authorization, `Bearer ${nextToken}`);
  const lastHello = relay.received.filter((frame) => frame.type === 'hello').at(-1);
  assert.equal(lastHello.clientId, clientId);
  assert.equal(lastHello.ownerName, 'Kitchen PC');
  assert.equal(bridge.connected, true);
});

test('contract 1: with no hello.ok the bridge keeps trying instead of hanging for ever', async (t) => {
  const relay = await new FakeRelay({ answerHelloOk: false }).start();
  t.after(() => relay.close());
  const bridge = new BridgeClient({
    url: relay.url,
    token: TOKEN,
    clientName: CLIENT_NAME,
    capabilities: makeCapabilities(),
    dispatch: makeDispatch().dispatch,
    backoff: { next: () => 5, reset: () => {}, reject: () => 5 },
    helloTimeoutMs: 60,
  });
  t.after(() => bridge.stop());
  await bridge.start();
  await new Promise((resolve) => setTimeout(resolve, 250));
  assert.equal(bridge.connected, false);
  const hellos = relay.received.filter((frame) => frame.type === 'hello').length;
  assert.ok(hellos >= 2, `the hello is re-sent after a timeout (saw ${hellos})`);
});

test('contract 2: a request is answered once, with the same id and a §9.2 result', async (t) => {
  const { relay, dispatch } = await connectedBridge(t);
  const id = '2b3c4d5e-6f7a-4b8c-9d0e-1f2a3b4c5d6e';
  relay.sendRequest({
    type: 'request',
    id,
    method: 'session.read',
    params: { tool: 'codex', sessionId: 'thread-1' },
    timeoutMs: 5000,
  });
  const response = await relay.responseFor(id);
  assert.ok(response, 'the bridge answered');
  assert.equal(response.id, id, 'the id is echoed byte for byte');
  assert.equal(response.ok, true);
  const result = response.result;
  assert.equal(result.id, 'thread-1');
  assert.equal(result.tool, 'codex');
  assert.equal(typeof result.title, 'string');
  assert.ok(['idle', 'working', 'stopped', 'error'].includes(result.status));
  assert.equal(typeof result.canStop, 'boolean');
  assert.equal(result.canStop, false, 'no stop capability means the button is grey');
  assert.ok(Array.isArray(result.messages));
  assert.deepEqual(
    result.messages.map((message) => message.id),
    ['m-1', 'm-2'],
  );
  assert.equal(result.activeTurnId, 'turn-1');
  assert.equal(dispatch.calls.filter((call) => call.method === 'session.read').length, 1);
});

test('contract 2: the same request id is never executed twice', async (t) => {
  const { relay, dispatch } = await connectedBridge(t);
  const id = '3c4d5e6f-7a8b-4c9d-8e1f-2a3b4c5d6e7f';
  const frame = { type: 'request', id, method: 'sessions.list', params: {}, timeoutMs: 5000 };
  relay.sendRequest(frame);
  await relay.responseFor(id);
  relay.sendRequest(frame);
  await new Promise((resolve) => setTimeout(resolve, 80));
  const answers = relay.received.filter((entry) => entry.type === 'response' && entry.id === id);
  assert.equal(answers.length, 1, 'a duplicate request gets no second execution and no second answer');
  assert.equal(dispatch.calls.filter((call) => call.method === 'sessions.list').length, 1);
});

test('contract 2: send reaches the same session and creates nothing', async (t) => {
  const { relay, dispatch } = await connectedBridge(t);
  const before = dispatch.sessions.length;
  const id = '4d5e6f7a-8b9c-4d0e-9f2a-3b4c5d6e7f80';
  relay.sendRequest({
    type: 'request',
    id,
    method: 'session.send',
    params: { tool: 'codex', sessionId: 'thread-1', text: '继续' },
    timeoutMs: 5000,
  });
  const response = await relay.responseFor(id);
  assert.deepEqual(response.result, { accepted: true, sessionId: 'thread-1' });
  assert.equal(dispatch.sessions.length, before, 'no new session appeared');
  assert.equal(dispatch.calls.filter((call) => call.method === 'session.send').length, 1);
});

test('contract 2: stop on a session without the capability answers not_capable, never a fake success', async (t) => {
  const { relay } = await connectedBridge(t);
  const id = '5e6f7a8b-9c4d-4e0f-af2a-3b4c5d6e7f80';
  relay.sendRequest({
    type: 'request',
    id,
    method: 'session.stop',
    params: { tool: 'codex', sessionId: 'thread-1' },
    timeoutMs: 5000,
  });
  const response = await relay.responseFor(id);
  assert.equal(response.ok, false);
  assert.equal(response.error.code, 'not_capable');
  assert.ok(!/[A-Za-z]:\\|\//.test(response.error.message), `no path in ${response.error.message}`);
  assert.ok(!response.error.message.includes('at '), 'no stack in the message');
});

test('a timed-out WorkBuddy partial submission is never replayed when the relay repeats its id', async (t) => {
  const relay = await new FakeRelay().start();
  t.after(() => relay.close());
  let dispatchCalls = 0;
  let nativeSubmissions = 0;
  let hooks;
  let finishDispatch;
  const dispatchGate = new Promise((resolve) => { finishDispatch = resolve; });
  let dispatchEntered;
  const entered = new Promise((resolve) => { dispatchEntered = resolve; });
  const bridge = new BridgeClient({
    url: relay.url,
    token: TOKEN,
    clientName: CLIENT_NAME,
    capabilities: makeCapabilities(),
    dispatch: async (request) => {
      dispatchCalls += 1;
      assert.deepEqual(request.params, { tool: 'workbuddy', sessionId: 'wb-1', text: 'one submission' });
      assert.equal(Object.prototype.hasOwnProperty.call(request.params, 'internal'), false);
      hooks = request.internal?.workbuddyHooks;
      assert.equal(typeof hooks?.checkActive, 'function');
      assert.equal(typeof hooks?.remainingBudgetMs, 'function');
      nativeSubmissions += 1; // the native action was already submitted once
      dispatchEntered();
      await dispatchGate;
      hooks.checkActive(); // a post-submit check must fail closed after expiry
      nativeSubmissions += 1;
      return { accepted: true };
    },
    backoff: { next: () => 5, reset: () => {}, reject: () => 5 },
  });
  t.after(() => bridge.stop());
  await bridge.start();
  await bridge.waitUntilConnected(2000);

  const request = {
    type: 'request',
    id: '7a8b9c0d-1e2f-4a5b-8c6d-7e8f9a0b1c2d',
    method: 'session.send',
    params: { tool: 'workbuddy', sessionId: 'wb-1', text: 'one submission' },
    timeoutMs: 100,
  };
  relay.sendRequest(request);
  await entered;
  assert.ok(hooks.remainingBudgetMs() > 0 && hooks.remainingBudgetMs() <= 60000);
  await new Promise((resolve) => setTimeout(resolve, 150));
  finishDispatch();
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(hooks.remainingBudgetMs(), 0);
  assert.equal(bridge.pending.size, 0);
  assert.equal(nativeSubmissions, 1, 'expiry does not resubmit or continue the partial action');
  assert.equal(await relay.responseFor(request.id, 50), null, 'the expired reply is dropped');

  relay.sendRequest(request);
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(dispatchCalls, 1, 'the same expired WorkBuddy id is retired against duplicate replay');
  assert.equal(nativeSubmissions, 1);
});

test('a real deadline expiring in the serialized WorkBuddy queue prevents any adapter submission', async (t) => {
  const relay = await new FakeRelay().start();
  let sendEntered;
  const entered = new Promise((resolve) => { sendEntered = resolve; });
  let finishSend;
  const finish = new Promise((resolve) => { finishSend = resolve; });
  const sendCalls = [];
  const adapter = {
    canStop: () => false,
    canSend: () => true,
    canSendWithModel: () => false,
    canAnswer: () => false,
    canApprove: () => false,
    canModelsList: () => false,
    canCreate: () => false,
    listSessions: async () => [],
    listModels: async () => ({ models: [], projects: [] }),
    sendMessage: async (sessionId, text) => {
      sendCalls.push({ sessionId, text });
      if (text === 'hold the writer') {
        sendEntered();
        await finish;
      }
      return { accepted: true, sessionId };
    },
    close: async () => {},
  };
  const dispatcher = createDispatcher({
    createLogPath: path.join(os.tmpdir(), `ai-remote-bridge-${crypto.randomUUID()}`, 'creates.json'),
    codex: { pipePath: null, contextThreadId: null },
    dsh: { port: null },
    workbuddy: { configDir: 'C:\\Users\\Local\\.workbuddy', uiAutomation: { enabled: false } },
  }, () => {}, {
    codex: async () => { throw new Error('unused'); },
    dsh: async () => { throw new Error('unused'); },
    workbuddy: async () => adapter,
  });
  const bridge = new BridgeClient({
    url: relay.url,
    token: TOKEN,
    clientName: CLIENT_NAME,
    capabilities: makeCapabilities(),
    dispatch: dispatcher.dispatch,
    backoff: { next: () => 5, reset: () => {}, reject: () => 5 },
  });
  t.after(async () => {
    finishSend();
    await bridge.stop();
    await dispatcher.close();
    await relay.close();
  });
  await bridge.start();
  await bridge.waitUntilConnected(2000);

  const blocking = {
    type: 'request', id: '12121212-1234-4234-8234-123456789abc', method: 'session.send',
    params: { tool: 'workbuddy', sessionId: 'wb-1', text: 'hold the writer' }, timeoutMs: 5000,
  };
  const queued = {
    type: 'request', id: '22121212-1234-4234-8234-123456789abc', method: 'session.send',
    params: { tool: 'workbuddy', sessionId: 'wb-1', text: 'must expire in queue' }, timeoutMs: 150,
  };
  relay.sendRequest(blocking);
  await entered;
  relay.sendRequest(queued);
  await new Promise((resolve) => setTimeout(resolve, 220));
  finishSend();

  assert.equal((await relay.responseFor(blocking.id))?.ok, true);
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(sendCalls.length, 1, 'the expired queued request never reaches the WorkBuddy adapter');
  assert.equal(await relay.responseFor(queued.id, 50), null, 'the bridge drops the response after the local deadline');
  relay.sendRequest(queued);
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(sendCalls.length, 1, 'a duplicate of the expired request cannot replay native input');
});

test('an unknown frame type is ignored and the link stays up (protocol-v1 §12.4)', async (t) => {
  const { relay, bridge } = await connectedBridge(t);
  relay.peer.sendText(JSON.stringify({ type: 'future.frame', payload: 1 }));
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(bridge.connected, true);
});

test('a ping from the relay is answered with a pong', async (t) => {
  const { relay } = await connectedBridge(t);
  relay.peer.sendText('{"type":"ping"}');
  let timeout = Date.now() + 1000;
  while (Date.now() < timeout && !relay.received.some((frame) => frame.type === 'pong')) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.ok(relay.received.some((frame) => frame.type === 'pong'));
});

test('pair.create mints the id here, and the code arrives with pair.created', async (t) => {
  const { relay, bridge } = await connectedBridge(t, {
    relay: {
      onFrame: (peer, frame) => {
        if (frame.type === 'pair.create') {
          peer.sendText(
            JSON.stringify({
              type: 'pair.created',
              id: frame.id,
              code: 'K7QP-3MZD-9XTB-2RCV-6HNF-0JWS',
              expiresAt: '2026-10-08T04:03:07Z',
              url: 'https://101.43.98.18/#pair=K7QP-3MZD-9XTB-2RCV-6HNF-0JWS',
            }),
          );
        }
      },
    },
  });
  const created = await bridge.createPairCode(2000);
  assert.equal(created.code, 'K7QP-3MZD-9XTB-2RCV-6HNF-0JWS');
  const sent = relay.received.find((frame) => frame.type === 'pair.create');
  assert.match(sent.id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});

test('an invalid token does not start a reconnect storm', async (t) => {
  const relay = await new FakeRelay().start();
  t.after(() => relay.close());
  const attempts = [];
  const bridge = new BridgeClient({
    url: relay.url,
    token: 'wrong-token',
    clientName: CLIENT_NAME,
    capabilities: makeCapabilities(),
    dispatch: makeDispatch().dispatch,
    backoff: {
      next: () => {
        attempts.push('next');
        return 5;
      },
      reset: () => {},
      reject: () => {
        attempts.push('reject');
        return 20;
      },
    },
  });
  t.after(() => bridge.stop());
  await bridge.start();
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.ok(attempts.includes('reject'), 'a 401 takes the slow path');
  assert.equal(bridge.connected, false);
  assert.equal(bridge.authRejected, true);
});

test('a disconnect answers every in-flight request and reconnects', async (t) => {
  const { relay, bridge } = await connectedBridge(t);
  const firstPeer = relay.peer;
  firstPeer.socket.destroy();
  // Wait for the reconnect itself, not for a moment of downtime: the bridge
  // comes back on the contract's backoff (10 ms in tests) and may already be up.
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline && relay.connections.length < 2) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.ok(relay.connections.length >= 2, 'it reconnected');
  await bridge.waitUntilConnected(3000);
  assert.equal(bridge.connected, true);
  const hellos = relay.received.filter((frame) => frame.type === 'hello').length;
  assert.ok(hellos >= 2, 'it says hello again on the new connection');
});

test('a real oversize session.read answer is trimmed below the budget before it is sent', async (t) => {
  // The live failure this reproduces: 200 messages serialising to ~321 kB, sent
  // anyway because the guard compared against an undefined property, so the relay
  // answered "frame exceeds limit" while the phone waited.
  const sent = [];
  const socket = {
    open: true,
    connect: () => Promise.resolve(),
    send: (text) => {
      sent.push(text);
      return true;
    },
    destroy: () => {},
    on: () => {},
    close: () => {},
  };
  const bridge = new BridgeClient({
    url: 'wss://relay.invalid/bridge',
    token: TOKEN,
    clientName: CLIENT_NAME,
    capabilities: makeCapabilities(),
    dispatch: makeDispatch().dispatch,
    socketFactory: () => socket,
  });
  t.after(() => bridge.stop());
  assert.equal(typeof bridge.maxFrameBytes, 'number', 'the transport cap is a real number, not undefined');
  await bridge.start();

  // About 321 kB of history: long tool bodies plus emoji, three bytes each.
  const messages = [];
  for (let index = 0; index < 200; index += 1) {
    messages.push({
      id: `m-${index}`,
      role: index < 95 ? 'tool' : 'assistant',
      text: index < 95 ? `${'🚀'.repeat(500)}${'x'.repeat(900)}` : 'short line',
      timestamp: '2026-10-08T05:00:00Z',
    });
  }
  const oversize = { id: 'thread-big', tool: 'codex', title: 'A long thread', status: 'idle', messages, canStop: false };
  const before = Buffer.byteLength(JSON.stringify(oversize), 'utf8');
  assert.ok(before > 262144, `the fixture really is oversized (${before} bytes)`);

  const id = '6f7a8b9c-0d4e-4f0a-9b1c-2d3e4f5a6b7c';
  bridge.answer(id, null, oversize);

  assert.equal(sent.length, 1, 'exactly one frame went out - not silence');
  const bytes = Buffer.byteLength(sent[0], 'utf8');
  assert.ok(bytes <= 240 * 1024, `the frame is inside the working budget (${bytes} bytes)`);
  assert.ok(bytes <= 262144, `and inside the transport cap (${bytes} bytes)`);
  const frame = JSON.parse(sent[0]);
  assert.equal(frame.type, 'response');
  assert.equal(frame.id, id);
  assert.equal(frame.ok, true);
  assert.equal(frame.result.historyTruncated, true, 'the phone is told the history was shortened');
  assert.ok(frame.result.messages.length > 0, 'the newest messages survive');
  assert.equal(frame.result.messages[frame.result.messages.length - 1].id, 'm-199');
});

test('the byte budget counts UTF-8 bytes, so emoji cannot slip past it', () => {
  const result = {
    id: 't',
    tool: 'dsh',
    title: 't',
    status: 'idle',
    messages: [{ id: 'm-1', role: 'assistant', text: '🚀'.repeat(100000), timestamp: '2026-10-08T05:00:00Z' }],
    canStop: false,
  };
  const fitted = fitSessionReadResult(result, { budget: 240 * 1024, id: '00000000-0000-4000-8000-000000000000' });
  assert.equal(fitted.truncated, true);
  assert.ok(fitted.bytes <= 240 * 1024, `${fitted.bytes} bytes`);
  const text = fitted.result.messages[0].text;
  assert.ok(!text.includes('\uFFFD'), 'no broken characters');
  assert.ok([...text].slice(0, 10).every((character) => character === '🚀'), 'whole code points only');
});

test('the bridge reports a truthful capability set', async () => {
  const capabilities = makeCapabilities();
  assert.equal(capabilities['stop:codex'], false);
  assert.equal(capabilities['stop:dsh'], true);
});

test('the WebSocket client is the only way out: no token is ever put in a URL', async (t) => {
  const { relay } = await connectedBridge(t);
  const [request] = relay.server.requests;
  assert.ok(!request.url.includes(TOKEN), request.url);
  assert.equal(new WebSocketClient(relay.url).constructor.name, 'WebSocketClient');
});

