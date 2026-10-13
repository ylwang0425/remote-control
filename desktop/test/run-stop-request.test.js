'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  createRunStopRequestWatcher,
  readRunStopRequestConfig,
} = require('../src/run-stop-request');

const RUN_ID = '11111111-2222-4333-8444-555555555555';

function waitFor(predicate, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const check = () => {
      if (predicate()) return resolve();
      if (Date.now() >= deadline) return reject(new Error('timed out waiting for the stop request'));
      setTimeout(check, 5);
    };
    check();
  });
}

test('the one-shot stop watcher is inactive without explicit native-control opt-in', () => {
  let stopCount = 0;
  const watcher = createRunStopRequestWatcher(null, () => { stopCount += 1; });
  assert.equal(watcher.active, false);
  watcher.close();
  assert.equal(stopCount, 0);
});

test('native-control stop watcher requires a private per-run UUID and random token', () => {
  assert.throws(() => readRunStopRequestConfig({
    enabled: true,
    registryDir: path.resolve(os.tmpdir(), 'registry'),
    runId: RUN_ID,
  }, {}), /private per-run bridge stop request credential/);
  assert.equal(readRunStopRequestConfig({ enabled: false }, {}), null);
});

test('only the exact authenticated run request invokes graceful shutdown once', async () => {
  const registryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-remote-stop-request-'));
  const runId = crypto.randomUUID();
  const token = crypto.randomBytes(32).toString('base64url');
  const config = readRunStopRequestConfig({ enabled: true, registryDir, runId }, { AI_REMOTE_BRIDGE_STOP_TOKEN: token });
  const called = [];
  const watcher = createRunStopRequestWatcher(config, () => {
    called.push(true);
  }, { intervalMs: 50 });
  try {
    fs.writeFileSync(config.requestPath, `${runId}\nwrong-token\n`, { encoding: 'utf8' });
    await new Promise((resolve) => setTimeout(resolve, 75));
    assert.equal(called.length, 0, 'a same-user file with the wrong token cannot stop this bridge');

    fs.writeFileSync(config.requestPath, `${runId}\n${token}\n`, { encoding: 'utf8' });
    await waitFor(() => called.length === 1);
    fs.writeFileSync(config.requestPath, `${runId}\n${token}\n`, { encoding: 'utf8' });
    await new Promise((resolve) => setTimeout(resolve, 75));
    assert.equal(called.length, 1, 'the stop credential is one-shot');
  } finally {
    watcher.close();
    fs.rmSync(registryDir, { recursive: true, force: true });
  }
});
