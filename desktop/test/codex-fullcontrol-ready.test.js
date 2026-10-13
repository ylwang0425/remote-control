'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { MAX_PIPE_PROBES, probeReady, waitUntilReady } = require('../scripts/codex-fullcontrol-ready');

const REGISTRY = 'C:\\Users\\test\\AppData\\Local\\AI-Remote\\codex-native-runs\\run';
const RUN_ID = '11111111-2222-4333-8444-555555555555';

function makeDependencies({ appTools = true, nativeReady = true } = {}) {
  const seen = { pipePaths: [], registry: null, clientClosed: 0, registryClosed: 0, refreshes: 0 };
  class Client {
    constructor(options) { seen.pipePaths.push(options.pipePath); }
    async listTools() {
      return appTools
        ? [{ namespace: 'codex_app', name: 'list_threads' }]
        : [{ namespace: 'codex_app', name: 'create_thread' }];
    }
    close() { seen.clientClosed += 1; }
  }
  class Registry {
    constructor(options) { seen.registry = options; this.ready = false; }
    async refresh() {
      seen.refreshes += 1;
      this.ready = nativeReady;
      return nativeReady ? [{ instanceId: 'owner' }] : [];
    }
    async close() { seen.registryClosed += 1; }
  }
  return { seen, Client, Registry };
}

test('Codex readiness requires a real app-tools pipe and authenticated descriptor for this exact run', async () => {
  const deps = makeDependencies();
  const ready = await probeReady({
    registryDir: REGISTRY, runId: RUN_ID, listPipes: () => ['codex-browser-use-live'],
    Client: deps.Client, Registry: deps.Registry,
  });
  assert.equal(ready, true);
  assert.deepEqual(deps.seen.pipePaths, ['\\\\.\\pipe\\codex-browser-use-live']);
  assert.equal(deps.seen.registry.registryDir, REGISTRY);
  assert.equal(deps.seen.registry.runId, RUN_ID);
  assert.equal(deps.seen.refreshes, 1);
  assert.equal(deps.seen.clientClosed, 1);
  assert.equal(deps.seen.registryClosed, 1);
  assert.equal(typeof deps.seen.registry.clientFactory, 'function');
});

test('a native descriptor without a usable Codex app-tools pipe does not start the bridge', async () => {
  const deps = makeDependencies({ appTools: false });
  const ready = await probeReady({
    registryDir: REGISTRY, runId: RUN_ID, listPipes: () => ['unrelated-pipe'],
    Client: deps.Client, Registry: deps.Registry,
  });
  assert.equal(ready, false);
  assert.equal(deps.seen.refreshes, 0);
  assert.equal(deps.seen.registryClosed, 0);
  assert.equal(deps.seen.clientClosed, 1);
});

test('a matching app-tools pipe does not suffice if the run-specific native control is not ready', async () => {
  const deps = makeDependencies({ nativeReady: false });
  const ready = await probeReady({
    registryDir: REGISTRY, runId: RUN_ID, listPipes: () => ['codex-browser-use-live'],
    Client: deps.Client, Registry: deps.Registry,
  });
  assert.equal(ready, false);
  assert.equal(deps.seen.refreshes, 1);
  assert.equal(deps.seen.registryClosed, 1);
});

test('startup probing stops at its bounded deadline without accepting an incomplete endpoint', async () => {
  let now = 0;
  let probes = 0;
  let sleeps = 0;
  const ready = await waitUntilReady({
    registryDir: REGISTRY, runId: RUN_ID, timeoutMs: 1000, intervalMs: 500,
    now: () => now,
    sleep: async (duration) => { now += duration; sleeps += 1; },
    listPipes: () => { probes += 1; return []; },
  });
  assert.equal(ready, false);
  assert.equal(probes, 2);
  assert.equal(sleeps, 2);
});

test('readiness probing caps pipe discovery and keeps endpoint timeouts inside the remaining deadline', async () => {
  let now = 100;
  const deps = makeDependencies();
  const probes = [];
  const nativeOptions = [];
  class TimedNativeClient { constructor(options) { nativeOptions.push(options); } }
  const ready = await probeReady({
    registryDir: REGISTRY, runId: RUN_ID, deadlineAt: 250, now: () => now,
    probeTimeoutMs: 500,
    listPipes: () => Array.from({ length: MAX_PIPE_PROBES + 5 }, (_, index) => `codex-browser-use-${index}`),
    Client: class extends deps.Client {
      constructor(options) { super(options); probes.push(options); }
      async listTools(...args) { now += 1; return super.listTools(...args); }
    },
    Registry: class extends deps.Registry {
      async refresh() { now += 1; return super.refresh(); }
    },
    NativeClient: TimedNativeClient,
  });
  assert.equal(ready, true);
  assert.equal(probes.length, 1);
  assert.equal(probes[0].timeoutMs, 150);
  deps.seen.registry.clientFactory({});
  assert.equal(nativeOptions.length, 1);
  assert.ok(nativeOptions[0].connectTimeoutMs + nativeOptions[0].timeoutMs <= 150);
});
