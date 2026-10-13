'use strict';

/**
 * Bounded, read-only preflight for the explicit Codex FullControl launcher.
 * The bridge must not send its initial hello until both a real app-tools pipe
 * and a matching, authenticated proxy descriptor are ready.
 */

const { discoverCodexPipes, CodexPipeClient } = require('../src/adapters/codex');
const { CodexNativeControlClient, CodexNativeControlRegistry } = require('../src/codex-native-control');

const REQUIRED_APP_TOOLS = new Set(['list_threads', 'read_thread']);
const MAX_PIPE_PROBES = 64;

async function probeReady(options = {}) {
  const listPipes = options.listPipes ?? discoverCodexPipes;
  const Client = options.Client ?? CodexPipeClient;
  const Registry = options.Registry ?? CodexNativeControlRegistry;
  const registryDir = options.registryDir;
  const runId = options.runId;
  if (typeof registryDir !== 'string' || registryDir.length === 0 || typeof runId !== 'string' || runId.length === 0) return false;
  const now = options.now ?? Date.now;
  const deadlineAt = Number.isFinite(options.deadlineAt) ? options.deadlineAt : Number.POSITIVE_INFINITY;

  let appToolsReady = false;
  const candidates = listPipes().slice(0, MAX_PIPE_PROBES);
  for (const name of candidates) {
    const remainingMs = deadlineAt - now();
    if (remainingMs <= 0) return false;
    const probeTimeoutMs = Math.max(1, Math.min(options.probeTimeoutMs ?? 500, remainingMs));
    const client = new Client({ pipePath: `\\\\.\\pipe\\${name}`, timeoutMs: probeTimeoutMs });
    try {
      const tools = await client.listTools({ threadStartKind: 'all' }, { timeoutMs: probeTimeoutMs });
      const names = new Set(tools.filter((tool) => tool?.namespace === 'codex_app').map((tool) => tool.name));
      if ([...REQUIRED_APP_TOOLS].some((tool) => names.has(tool))) {
        appToolsReady = true;
        break;
      }
    } catch {
      // Half-started and unrelated Codex pipes are expected during app startup.
    } finally {
      client.close();
    }
  }
  if (!appToolsReady) return false;
  const remainingMs = deadlineAt - now();
  if (remainingMs <= 0) return false;

  let registry;
  try {
    const connectTimeoutMs = Math.max(1, Math.min(options.connectTimeoutMs ?? 200, Math.floor(remainingMs / 3)));
    const nativeTimeoutMs = Math.max(1, Math.min(options.nativeTimeoutMs ?? 600, remainingMs - connectTimeoutMs));
    const NativeClient = options.NativeClient ?? CodexNativeControlClient;
    const clientFactory = options.clientFactory ?? (typeof NativeClient === 'function'
      ? (descriptor) => new NativeClient({
        ...descriptor,
        timeoutMs: nativeTimeoutMs,
        confirmTimeoutMs: nativeTimeoutMs,
        connectTimeoutMs,
      })
      : undefined);
    registry = new Registry({ registryDir, runId, ...(clientFactory ? { clientFactory } : {}) });
    const ready = await registry.refresh();
    return now() < deadlineAt && registry.ready === true && ready.length > 0;
  } catch {
    return false;
  } finally {
    await registry?.close();
  }
}

async function waitUntilReady(options = {}) {
  const timeoutMs = options.timeoutMs ?? 60000;
  const intervalMs = options.intervalMs ?? 500;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 180000 ||
      !Number.isInteger(intervalMs) || intervalMs < 100 || intervalMs > 5000) return false;
  const now = options.now ?? Date.now;
  const deadline = now() + timeoutMs;
  do {
    if (now() >= deadline) return false;
    if (await probeReady({ ...options, now, deadlineAt: deadline })) return true;
    const remainingMs = deadline - now();
    if (remainingMs <= 0) return false;
    await (options.sleep ?? ((duration) => new Promise((resolve) => setTimeout(resolve, duration))))(Math.min(intervalMs, remainingMs));
  } while (now() < deadline);
  return false;
}

async function main(env = process.env) {
  const timeoutMs = Number(env.AI_REMOTE_CODEX_READY_TIMEOUT_MS ?? '60000');
  const ready = await waitUntilReady({
    registryDir: env.CODEX_NATIVE_CONTROL_DIR,
    runId: env.CODEX_NATIVE_RUN_ID,
    timeoutMs,
  });
  process.exitCode = ready ? 0 : 1;
}

if (require.main === module) {
  main().catch(() => { process.exitCode = 1; });
}

module.exports = { REQUIRED_APP_TOOLS, MAX_PIPE_PROBES, probeReady, waitUntilReady };
