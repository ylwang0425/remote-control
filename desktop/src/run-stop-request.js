'use strict';

/**
 * Private one-shot stop request used by an opt-in launcher to stop only the
 * bridge process it started. The UUID-bound request file lives inside the
 * launcher's user-private per-run registry and is authenticated with a random
 * in-memory token. No HTTP endpoint, relay method or global process lookup is
 * added.
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const RUN_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const STOP_TOKEN = /^[A-Za-z0-9_-]{43}$/;
const MAX_REQUEST_BYTES = 128;

function readRunStopRequestConfig(nativeControl, env = process.env) {
  if (nativeControl?.enabled !== true) return null;
  const registryDir = nativeControl.registryDir;
  const runId = nativeControl.runId;
  const token = env.AI_REMOTE_BRIDGE_STOP_TOKEN;
  if (typeof registryDir !== 'string' || !path.isAbsolute(registryDir) ||
      typeof runId !== 'string' || !RUN_ID.test(runId) ||
      typeof token !== 'string' || !STOP_TOKEN.test(token)) {
    throw new Error('the explicit FullControl launch is missing its private per-run bridge stop request credential');
  }
  const directory = path.resolve(registryDir);
  return {
    registryDir: directory,
    runId,
    token,
    requestPath: path.join(directory, `bridge-stop-${runId}.request`),
  };
}

function createRunStopRequestWatcher(config, onStop, options = {}) {
  if (config === null) return { active: false, close() {} };
  if (typeof onStop !== 'function') throw new TypeError('stop callback is required');
  const intervalMs = options.intervalMs ?? 250;
  if (!Number.isInteger(intervalMs) || intervalMs < 50 || intervalMs > 5000) {
    throw new TypeError('stop request polling interval is out of range');
  }

  let closed = false;
  let fired = false;
  const expected = Buffer.from(`${config.runId}\n${config.token}\n`, 'utf8');

  const poll = () => {
    if (closed || fired) return;
    let fd;
    try {
      const directoryStat = fs.lstatSync(config.registryDir);
      if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) return;
      const initialStat = fs.lstatSync(config.requestPath);
      if (!initialStat.isFile() || initialStat.isSymbolicLink() || initialStat.size > MAX_REQUEST_BYTES) return;
      fd = fs.openSync(config.requestPath, 'r');
      const stat = fs.fstatSync(fd);
      if (!stat.isFile() || stat.size > MAX_REQUEST_BYTES) return;
      const actual = Buffer.alloc(stat.size);
      const count = fs.readSync(fd, actual, 0, actual.length, 0);
      if (count !== expected.length) return;
      const boundedActual = actual.subarray(0, count);
      if (!crypto.timingSafeEqual(boundedActual, expected)) return;
      fs.closeSync(fd);
      fd = undefined;
      fs.unlinkSync(config.requestPath);
      fired = true;
      clearInterval(timer);
      Promise.resolve().then(onStop).catch(() => {});
    } catch {
      // Missing, malformed, replaced, or inaccessible requests are ignored.
    } finally {
      if (fd !== undefined) {
        try { fs.closeSync(fd); } catch { /* already closed */ }
      }
    }
  };

  const timer = setInterval(poll, intervalMs);
  timer.unref?.();
  poll();
  return {
    active: true,
    close() {
      if (closed) return;
      closed = true;
      clearInterval(timer);
    },
  };
}

module.exports = { RUN_ID, STOP_TOKEN, readRunStopRequestConfig, createRunStopRequestWatcher };
