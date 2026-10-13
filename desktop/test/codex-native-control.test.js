'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const {
  CODEX_NATIVE_CONTROL_PROTOCOL,
  CONTROL_BACKEND,
  CodexNativeControlClient,
  CodexNativeControlRegistry,
  descriptorFilename,
  validRegistryDirectory,
} = require('../src/codex-native-control');
const { createControlServer, dispatchControl } = require('../src/codex-native-proxy');
const { FrameDecoder, encodeFrame } = require('../src/framing');

const RUN_ID = '74a818c2-7315-4dfb-b25c-4d408778fd0c';

function tempDirectory() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'codex-native-control-'));
}

function fixtureDescriptor(registryDir, overrides = {}) {
  const value = {
    protocol: CODEX_NATIVE_CONTROL_PROTOCOL,
    backend: CONTROL_BACKEND,
    runId: RUN_ID,
    instanceId: overrides.instanceId ?? crypto.randomUUID(),
    host: '127.0.0.1',
    port: overrides.port ?? 49152,
    token: overrides.token ?? crypto.randomBytes(32).toString('base64url'),
    proxyPid: process.pid,
    nativePid: process.pid,
    ...overrides,
  };
  fs.writeFileSync(path.join(registryDir, descriptorFilename(RUN_ID, value.instanceId)), JSON.stringify(value), { mode: 0o600 });
  return value;
}

async function startServer(onMessage) {
  const sockets = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    const decoder = new FrameDecoder({ maxBytes: 2 * 1024 * 1024 });
    socket.on('data', (chunk) => {
      for (const message of decoder.push(chunk)) onMessage(message, socket);
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen({ host: '127.0.0.1', port: 0, exclusive: true }, resolve);
  });
  return {
    server,
    port: server.address().port,
    sockets,
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

function send(socket, message) {
  socket.write(encodeFrame(message, { maxBytes: 2 * 1024 * 1024 }));
}

function respond(socket, request, result) {
  send(socket, { jsonrpc: '2.0', id: request.id, result });
}

test('registry discovery is bounded, exact-run scoped, and rejects reparse paths', (t) => {
  const registryDir = tempDirectory();
  t.after(() => fs.rmSync(registryDir, { recursive: true, force: true }));
  assert.equal(validRegistryDirectory(registryDir), true);

  const registry = new CodexNativeControlRegistry({ registryDir, runId: RUN_ID, clientFactory: () => { throw new Error('must not create a client'); } });
  for (let index = 0; index < 33; index++) fixtureDescriptor(registryDir, { instanceId: crypto.randomUUID() });
  assert.deepEqual(registry.readDescriptors(), [], 'more than 32 matching endpoint descriptors fails closed');

  for (const name of fs.readdirSync(registryDir)) fs.unlinkSync(path.join(registryDir, name));
  fixtureDescriptor(registryDir, { runId: RUN_ID, instanceId: crypto.randomUUID() });
  const wrongRun = '74a818c2-7315-4dfb-b25c-4d408778fd0d';
  const descriptor = fixtureDescriptor(registryDir, { runId: wrongRun, instanceId: crypto.randomUUID() });
  assert.equal(registry.readDescriptors().length, 1);
  assert.equal(registry.readDescriptors()[0].instanceId !== descriptor.instanceId, true);
  assert.deepEqual(new CodexNativeControlRegistry({ registryDir: path.join(registryDir, 'missing'), runId: RUN_ID }).readDescriptors(), []);
  void registry.close();
});

test('registry quarantines an endpoint that completes the handshake with the wrong backend until descriptor identity changes', async (t) => {
  const registryDir = tempDirectory();
  t.after(() => fs.rmSync(registryDir, { recursive: true, force: true }));
  const badServer = await startServer((message, socket) => {
    respond(socket, message, { protocol: 1, backend: 'other-backend', capabilities: { stop: true, answer: true, approve: true } });
  });
  t.after(() => badServer.close());
  const instanceId = crypto.randomUUID();
  const bad = fixtureDescriptor(registryDir, { instanceId, port: badServer.port });
  let factories = 0;
  const registry = new CodexNativeControlRegistry({ registryDir, runId: RUN_ID, clientFactory: (descriptor) => {
    factories += 1;
    return new CodexNativeControlClient({ ...descriptor, timeoutMs: 100, connectTimeoutMs: 100 });
  } });
  t.after(() => registry.close());
  assert.deepEqual(await registry.refresh(), []);
  assert.deepEqual(await registry.refresh(), []);
  assert.equal(factories, 1, 'the closed bad-handshake client is discarded and not retried on every poll');

  const goodServer = await startServer((message, socket) => {
    respond(socket, message, {
      protocol: 1,
      backend: CONTROL_BACKEND,
      capabilities: { stop: true, answer: true, approve: true },
    });
  });
  t.after(() => goodServer.close());
  const good = { ...bad, port: goodServer.port, token: crypto.randomBytes(32).toString('base64url') };
  fs.writeFileSync(path.join(registryDir, descriptorFilename(RUN_ID, instanceId)), JSON.stringify(good), { mode: 0o600 });
  const ready = await registry.refresh();
  assert.equal(ready.length, 1, 'a new descriptor identity is allowed to handshake');
  assert.equal(factories, 2);
});

test('client handshake is bounded when a loopback peer accepts but never responds', async (t) => {
  const server = await startServer(() => {});
  t.after(() => server.close());
  const client = new CodexNativeControlClient({ host: '127.0.0.1', port: server.port, token: crypto.randomBytes(32).toString('base64url'), timeoutMs: 25, connectTimeoutMs: 100 });
  t.after(() => client.close());
  const started = Date.now();
  await assert.rejects(client.initialize(), /timed out/);
  assert.ok(Date.now() - started < 1000, 'initialization cannot hang indefinitely on a stale or wrong peer');
});

test('persistent control socket accepts 150 sequential snapshots without a lifetime request cap', async (t) => {
  const registryDir = tempDirectory();
  t.after(() => fs.rmSync(registryDir, { recursive: true, force: true }));
  const core = {
    snapshot(threadId) { return { threadId, observed: true, activeTurnId: null, requests: [] }; },
    async interrupt() { return { state: 'submitted' }; },
    async respond() { return { state: 'submitted' }; },
  };
  const server = createControlServer({ core, registryDir, runId: RUN_ID, nativePid: process.pid });
  await server.listen();
  t.after(() => server.close());
  const descriptor = server.server.address();
  const client = new CodexNativeControlClient({ host: '127.0.0.1', port: descriptor.port, token: server.token, timeoutMs: 1000 });
  t.after(() => client.close());
  await client.initialize();
  for (let index = 0; index < 150; index++) {
    const snapshot = await client.snapshot('thread-long-poll');
    assert.equal(snapshot.observed, true);
  }
});

test('authenticated control dispatch rejects wrong token and unknown methods without invoking the core', () => {
  let calls = 0;
  const core = { snapshot() { calls++; return { observed: false, requests: [] }; } };
  const token = crypto.randomBytes(32).toString('base64url');
  assert.throws(() => dispatchControl(core, token, {
    jsonrpc: '2.0', id: 1, method: 'codex-native/snapshot', params: { token: 'wrong', threadId: 'thread' },
  }), (error) => error.code === 'unauthorized');
  assert.throws(() => dispatchControl(core, token, {
    jsonrpc: '2.0', id: 2, method: 'native/anything', params: { token },
  }), (error) => error.code === 'not_capable');
  assert.equal(calls, 0);
});
