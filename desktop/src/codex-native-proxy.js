'use strict';

/**
 * Transparent stdio supervisor for the Codex Desktop-owned app-server process.
 * It is only reached when Desktop is explicitly launched with
 * `CODEX_CLI_PATH=codex-native-proxy`. The real bundled CLI is a same-child
 * process with the original argv, cwd and inherited authentication environment.
 * No conversation payloads are logged or persisted.
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { FrameDecoder, encodeFrame } = require('./framing');
const {
  CodexNativeProxyCore,
  JsonlTap,
  ProxyControlError,
} = require('./codex-native-proxy-core');
const {
  CODEX_NATIVE_CONTROL_PROTOCOL,
  CONTROL_BACKEND,
  CONTROL_MAX_FRAME_BYTES,
  descriptorFilename,
} = require('./codex-native-control');

const MAX_PENDING_CONTROL_FRAMES = 32;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PROXY_ENV_KEYS = new Set([
  'AI_REMOTE_CODEX_NATIVE_CONTROL',
  'CODEX_NATIVE_CONTROL_DIR',
  'CODEX_NATIVE_RUN_ID',
  'CODEX_NATIVE_REAL_CLI_PATH',
  'CODEX_NATIVE_NODE_PATH',
  'CODEX_NATIVE_PROXY_EXE_PATH',
  'CODEX_NATIVE_PROXY_SCRIPT',
]);

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function exactKeys(value, allowed) {
  return isRecord(value) && Object.keys(value).every((key) => allowed.has(key));
}

function validLoopbackAddress(value) {
  return value === '127.0.0.1' || value === '::ffff:127.0.0.1' || value === '::1';
}

function validRegistryDirectory(registryDir) {
  if (typeof registryDir !== 'string' || !path.isAbsolute(registryDir)) return false;
  try {
    const root = path.parse(path.resolve(registryDir)).root;
    const relative = path.relative(root, path.resolve(registryDir));
    let current = root;
    for (const segment of relative.split(path.sep).filter(Boolean)) {
      current = path.join(current, segment);
      const info = fs.lstatSync(current);
      if (isReparsePoint(info)) return false;
    }
    const info = fs.lstatSync(registryDir);
    return info.isDirectory() && !isReparsePoint(info);
  } catch {
    return false;
  }
}

function isReparsePoint(info) {
  return info.isSymbolicLink() || (Number.isInteger(info.attributes) && (info.attributes & 0x400) !== 0);
}

function validControlArgs({ registryDir, runId, realCliPath, proxyExePath }) {
  if (!UUID_V4.test(runId ?? '') || !validRegistryDirectory(registryDir)) return false;
  if (typeof realCliPath !== 'string' || !path.isAbsolute(realCliPath)) return false;
  try {
    if (!fs.lstatSync(realCliPath).isFile()) return false;
    const real = fs.realpathSync.native(realCliPath).toLowerCase();
    const proxy = typeof proxyExePath === 'string' ? fs.realpathSync.native(proxyExePath).toLowerCase() : '';
    return real !== proxy;
  } catch {
    return false;
  }
}

/** Only Codex Desktop's real JSON-RPC child gets a control endpoint. Desktop
 * also uses CODEX_CLI_PATH for version/help/generator probes; those invocations
 * must remain a transparent executable-name override, not look like an owned
 * app-server session to the bridge. */
function isAppServerStdioInvocation(args) {
  if (!Array.isArray(args) || args.some((argument) => typeof argument !== 'string')) return false;
  const commandIndex = args.indexOf('app-server');
  if (commandIndex < 0) return false;
  const tail = args.slice(commandIndex + 1);
  if (tail.some((argument) => argument === '--help' || argument === '-h')) return false;
  const listeners = [];
  let explicitStdio = false;
  const valueOptions = new Set([
    '-c', '--config', '--enable', '--disable', '--code-mode-host', '--listen',
    '--ws-auth', '--ws-token-file', '--ws-token-sha256', '--ws-shared-secret-file',
    '--ws-issuer', '--ws-audience', '--ws-max-clock-skew-seconds',
  ]);
  const booleanOptions = new Set(['--stdio', '--strict-config', '--analytics-default-enabled']);
  for (let index = 0; index < tail.length; index += 1) {
    const argument = tail[index];
    if (valueOptions.has(argument)) {
      if (index + 1 >= tail.length) return false;
      const value = tail[index + 1];
      if (argument === '--listen') listeners.push(value);
      if (argument === '-c' || argument === '--config' || argument === '--enable' || argument === '--disable') {
        if (value.trim().length === 0) return false;
      } else if (argument === '--code-mode-host') {
        if (!/^wss?:\/\//u.test(value)) return false;
      } else if (argument.startsWith('--ws-') && value.trim().length === 0) return false;
      index += 1;
    } else if (argument.startsWith('--listen=')) {
      listeners.push(argument.slice('--listen='.length));
    } else if (argument === '--stdio') {
      explicitStdio = true;
    } else if (booleanOptions.has(argument)) {
      // Recognized app-server flags that do not affect the JSONL transport.
    } else if (argument.startsWith('-')) {
      // Unknown version-specific options fail closed for control registration.
      return false;
    } else {
      // `daemon`, `proxy`, `generate-ts`, `generate-json-schema`, `help`, and
      // any future positional subcommand are not the Desktop server process.
      return false;
    }
  }
  if (listeners.length > 1 || (explicitStdio && listeners.length > 0)) return false;
  if (explicitStdio) return true;
  if (listeners.length === 1) return ['stdio', 'stdio://'].includes(listeners[0]);
  // Installed Codex CLI and Desktop currently default app-server to stdio://.
  return listeners.length === 0;
}

function timingSafeTokenMatch(expected, supplied) {
  if (typeof supplied !== 'string') return false;
  const left = Buffer.from(expected, 'utf8');
  const right = Buffer.from(supplied, 'utf8');
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function rpcError(id, code, message) {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message, data: { code: String(code) } } };
}

function rpcSuccess(id, result) {
  return { jsonrpc: '2.0', id, result };
}

/** Authenticated method allow-list. No native method name comes from the peer. */
function dispatchControl(core, token, message) {
  if (!isRecord(message) || message.jsonrpc !== '2.0' || !Object.prototype.hasOwnProperty.call(message, 'id') ||
      !(typeof message.id === 'string' || Number.isSafeInteger(message.id)) || !isRecord(message.params)) {
    throw new ProxyControlError('invalid_params', 'invalid control frame');
  }
  const { token: suppliedToken, ...params } = message.params;
  if (!timingSafeTokenMatch(token, suppliedToken)) throw new ProxyControlError('unauthorized', 'local control authentication failed');
  switch (message.method) {
    case 'codex-native/initialize': {
      if (!exactKeys(params, new Set(['protocol'])) || params.protocol !== CODEX_NATIVE_CONTROL_PROTOCOL) {
        throw new ProxyControlError('invalid_params', 'unsupported control protocol');
      }
      return {
        protocol: CODEX_NATIVE_CONTROL_PROTOCOL,
        backend: CONTROL_BACKEND,
        capabilities: { stop: true, answer: true, approve: true },
      };
    }
    case 'codex-native/snapshot': {
      if (!exactKeys(params, new Set(['threadId'])) || typeof params.threadId !== 'string' || params.threadId.length === 0) {
        throw new ProxyControlError('invalid_params', 'a native thread id is required');
      }
      return core.snapshot(params.threadId);
    }
    case 'codex-native/interrupt': {
      if (!exactKeys(params, new Set(['threadId', 'turnId'])) || typeof params.threadId !== 'string' || typeof params.turnId !== 'string') {
        throw new ProxyControlError('invalid_params', 'an exact native thread and turn are required');
      }
      return core.interrupt(params.threadId, params.turnId);
    }
    case 'codex-native/respond': {
      if (!exactKeys(params, new Set(['bridgeRequestId', 'threadId', 'itemId', 'answer'])) ||
          typeof params.bridgeRequestId !== 'string' || typeof params.threadId !== 'string' || typeof params.itemId !== 'string') {
        throw new ProxyControlError('invalid_params', 'an exact native request is required');
      }
      return core.respond(params);
    }
    default:
      throw new ProxyControlError('not_capable', 'control method is not allowed');
  }
}

function writeControlFrame(socket, message) {
  if (socket.destroyed) return;
  try {
    socket.write(encodeFrame(message, { maxBytes: CONTROL_MAX_FRAME_BYTES }));
  } catch {
    socket.destroy();
  }
}

function createControlServer({ core, registryDir, runId, nativePid, instanceId = crypto.randomUUID(), token = crypto.randomBytes(32).toString('base64url') }) {
  if (!validRegistryDirectory(registryDir) || !UUID_V4.test(runId ?? '')) throw new Error('Codex native control registry directory or run id is invalid');
  if (!UUID_V4.test(instanceId) || Buffer.byteLength(token, 'utf8') < 32) throw new Error('Codex native control identity is invalid');
  const server = net.createServer((socket) => {
    if (!validLoopbackAddress(socket.remoteAddress)) {
      socket.destroy();
      return;
    }
    socket.setNoDelay(true);
    socket.setTimeout(30000, () => socket.destroy());
    const decoder = new FrameDecoder({ maxBytes: CONTROL_MAX_FRAME_BYTES });
    let pendingFrames = 0;
    let chain = Promise.resolve();
    socket.on('data', (chunk) => {
      let messages;
      try { messages = decoder.push(chunk); } catch { socket.destroy(); return; }
      for (const message of messages) {
        pendingFrames += 1;
        if (pendingFrames > MAX_PENDING_CONTROL_FRAMES) { socket.destroy(); return; }
        chain = chain.then(async () => {
          const id = message?.id;
          try {
            const result = await dispatchControl(core, token, message);
            writeControlFrame(socket, rpcSuccess(id, result));
          } catch (error) {
            const code = error instanceof ProxyControlError ? error.code : 'bridge_error';
            const status = code === 'unauthorized' ? -32001 : -32000;
            writeControlFrame(socket, rpcError(id, status, code === 'unauthorized' ? 'unauthorized' : error instanceof ProxyControlError ? error.message : 'control request failed'));
            if (code === 'unauthorized') setImmediate(() => socket.destroy());
          }
        }).finally(() => { pendingFrames -= 1; });
      }
    });
    socket.on('error', () => {});
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  const sockets = new Set();
  server.maxConnections = 32;

  let descriptorPath = null;
  let descriptor = null;
  let stopping = null;
  const disable = () => {
    if (stopping !== null) return stopping;
    for (const socket of sockets) socket.destroy();
    stopping = new Promise((resolve) => {
      if (!server.listening) return resolve();
      server.close(resolve);
    });
    return stopping;
  };
  return {
    server,
    token,
    instanceId,
    async listen() {
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen({ host: '127.0.0.1', port: 0, exclusive: true }, resolve);
      });
      const address = server.address();
      if (address === null || typeof address === 'string' || address.address !== '127.0.0.1') throw new Error('Codex native control did not bind to IPv4 loopback');
      descriptor = {
        protocol: CODEX_NATIVE_CONTROL_PROTOCOL,
        backend: CONTROL_BACKEND,
        runId,
        instanceId,
        host: '127.0.0.1',
        port: address.port,
        token,
        proxyPid: process.pid,
        nativePid,
      };
      descriptorPath = path.join(registryDir, descriptorFilename(runId, instanceId));
      const temporary = `${descriptorPath}.${crypto.randomUUID()}.tmp`;
      fs.writeFileSync(temporary, JSON.stringify(descriptor), { flag: 'wx', mode: 0o600 });
      fs.renameSync(temporary, descriptorPath);
      return { ...descriptor, token: undefined };
    },
    // Degradation revokes the control channel, but must keep the descriptor as
    // a liveness record until the same native child actually exits. The host
    // uses the descriptor/PID pair to drain this run without guessing from a
    // missed process poll.
    disable,
    async close() {
      await disable();
      if (descriptorPath !== null) {
        try {
          const current = JSON.parse(fs.readFileSync(descriptorPath, 'utf8'));
          if (current.runId === runId && current.instanceId === instanceId && current.proxyPid === process.pid) fs.unlinkSync(descriptorPath);
        } catch { /* It may already have been removed by cleanup. */ }
      }
    },
  };
}

function writeChunk(destination, chunk) {
  if (destination.destroyed || destination.writableEnded) return Promise.resolve(false);
  return new Promise((resolve, reject) => {
    let callbackDone = false;
    let drained = true;
    let settled = false;
    const onError = (error) => {
      if (settled) return;
      settled = true;
      destination.off('error', onError);
      reject(error);
    };
    const maybeResolve = () => {
      if (settled || !callbackDone || !drained) return;
      settled = true;
      destination.off('error', onError);
      resolve(true);
    };
    destination.once('error', onError);
    const accepted = destination.write(chunk, (error) => {
      callbackDone = true;
      if (error) return onError(error);
      maybeResolve();
    });
    if (!accepted) {
      drained = false;
      destination.once('drain', () => {
        drained = true;
        maybeResolve();
      });
    }
  });
}

async function pipeTapped(source, destination, tap, onFailure, { endDestination = false } = {}) {
  try {
    for await (const chunk of source) {
      const lines = tap.push(chunk);
      for (const line of lines) {
        if (await writeChunk(destination, line) === false) return;
      }
    }
    for (const line of tap.flush()) await writeChunk(destination, line);
    if (endDestination && !destination.destroyed && !destination.writableEnded) {
      await new Promise((resolve) => {
        const finish = () => { cleanup(); resolve(); };
        const error = () => { cleanup(); resolve(); };
        const cleanup = () => {
          destination.off('finish', finish);
          destination.off('error', error);
        };
        destination.once('finish', finish);
        destination.once('error', error);
        destination.end();
      });
    }
  } catch (error) {
    onFailure(error);
    // If the inspection layer fails, preserve the bytes it still owns. Controls
    // are then disabled; the native app-server stream itself remains transparent.
    const remainder = tap.pending;
    tap.pending = Buffer.alloc(0);
    if (remainder.length > 0) {
      try { await writeChunk(destination, remainder); } catch { /* Child or host has exited. */ }
    }
  }
}

function childEnvironment(source, realCliPath) {
  const result = {};
  for (const [key, value] of Object.entries(source)) {
    if (!PROXY_ENV_KEYS.has(key)) result[key] = value;
  }
  // The proxy has already selected the real executable. This prevents a nested
  // app-server child from resolving the proxy alias recursively.
  result.CODEX_CLI_PATH = realCliPath;
  return result;
}

function waitForChild(child) {
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
}

async function startNativeProxy(options = {}) {
  const sourceEnv = options.env ?? process.env;
  const registryDir = options.registryDir ?? sourceEnv.CODEX_NATIVE_CONTROL_DIR;
  const runId = options.runId ?? sourceEnv.CODEX_NATIVE_RUN_ID;
  const realCliPath = options.realCliPath ?? sourceEnv.CODEX_NATIVE_REAL_CLI_PATH;
  const proxyExePath = options.proxyExePath ?? sourceEnv.CODEX_NATIVE_PROXY_EXE_PATH ?? process.argv[1];
  if (typeof realCliPath !== 'string' || !path.isAbsolute(realCliPath) || !fs.existsSync(realCliPath)) {
    throw new Error('CODEX_NATIVE_REAL_CLI_PATH must name the installed Codex CLI executable');
  }
  const realPath = fs.realpathSync.native(realCliPath);
  if (typeof proxyExePath === 'string' && fs.existsSync(proxyExePath) && fs.realpathSync.native(proxyExePath).toLowerCase() === realPath.toLowerCase()) {
    throw new Error('the configured native proxy must not point back to itself');
  }
  if (sourceEnv.AI_REMOTE_CODEX_NATIVE_CONTROL !== '1') throw new Error('Codex native control requires its explicit user opt-in');
  if (!validControlArgs({ registryDir, runId, realCliPath: realPath, proxyExePath })) {
    throw new Error('the opted-in Codex native-control registry, run id or executable path is invalid');
  }
  const desktopInput = options.desktopInput ?? process.stdin;
  const desktopOutput = options.desktopOutput ?? process.stdout;
  const desktopError = options.desktopError ?? process.stderr;
  const args = options.args ?? process.argv.slice(2);
  const appServerStdio = isAppServerStdioInvocation(args);
  const child = (options.spawn ?? spawn)(realPath, args, {
    cwd: options.cwd ?? process.cwd(),
    env: childEnvironment(sourceEnv, realPath),
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const childExit = waitForChild(child);
  const nativeId = child.pid;
  let controlServer = null;
  let core = null;
  let controlReady = false;

  const coreWrite = async (line) => {
    if (child.stdin.destroyed || child.stdin.writableEnded) throw new Error('Codex app-server input is closed');
    await writeChunk(child.stdin, Buffer.from(line, 'utf8'));
  };
  core = new CodexNativeProxyCore({ writeToNative: coreWrite });
  if (appServerStdio && Number.isInteger(nativeId) && nativeId > 0) {
    try {
      controlServer = createControlServer({ core, registryDir, runId, nativePid: nativeId });
      await controlServer.listen();
      controlReady = true;
    } catch {
      await controlServer?.close().catch(() => {});
      controlServer = null;
    }
  }

  const degradeControls = () => {
    if (!controlReady) return;
    controlReady = false;
    core.close();
    void controlServer?.disable();
  };
  const tapOptions = Number.isSafeInteger(options.tapMaxLineBytes) && options.tapMaxLineBytes > 0
    ? { maxLineBytes: options.tapMaxLineBytes }
    : {};
  const desktopTap = new JsonlTap({
    ...tapOptions,
    onLine: appServerStdio ? (message) => core.onDesktopMessage(message) : () => true,
    onError: appServerStdio ? degradeControls : () => {},
  });
  // JsonlTap forwards unless its callback returns false. The core uses the
  // opposite semantic: true means an internal app-server response is consumed.
  // Invert here so ordinary notifications and RPC responses remain transparent.
  const nativeTap = new JsonlTap({
    ...tapOptions,
    onLine: appServerStdio ? (message) => !core.onNativeMessage(message) : () => true,
    onError: appServerStdio ? degradeControls : () => {},
  });

  // A JSON-lines host closes stdin to finish the app-server session. Propagate
  // that EOF to the same real child after forwarding the trailing bytes.
  const desktopToNative = pipeTapped(desktopInput, child.stdin, desktopTap, degradeControls, { endDestination: true });
  const nativeToDesktop = pipeTapped(child.stdout, desktopOutput, nativeTap, degradeControls);
  const stderrPipe = new Promise((resolve) => {
    child.stderr.once('error', () => resolve());
    desktopError.once('error', () => resolve());
    child.stderr.pipe(desktopError);
    child.stderr.once('end', resolve);
  });

  const outcome = await childExit;
  // The host owns the child lifecycle; this process only closes its own control
  // endpoint and streams after the real child exits.
  core.close();
  controlReady = false;
  await controlServer?.close().catch(() => {});
  desktopInput.destroy?.();
  if (!child.stdin.destroyed && !child.stdin.writableEnded) child.stdin.end();
  await Promise.allSettled([desktopToNative, nativeToDesktop, stderrPipe]);
  return { code: outcome.code ?? (outcome.signal ? 1 : 0), signal: outcome.signal ?? null };
}

if (require.main === module) {
  startNativeProxy().then(({ code }) => {
    process.exitCode = code;
  }).catch(() => {
    // Never log the environment or arguments: those are owned by the Desktop
    // process and may contain private paths or credentials.
    process.exitCode = 1;
  });
}

module.exports = {
  PROXY_ENV_KEYS,
  validLoopbackAddress,
  validRegistryDirectory,
  validControlArgs,
  timingSafeTokenMatch,
  dispatchControl,
  createControlServer,
  writeChunk,
  pipeTapped,
  childEnvironment,
  isAppServerStdioInvocation,
  startNativeProxy,
};
