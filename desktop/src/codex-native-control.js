'use strict';

/**
 * Authenticated loopback client for the opt-in Codex Desktop stdio proxy.
 *
 * The named-pipe app-tools connection remains the source of history, sends,
 * models and project-backed creation. This second channel is only available when
 * the user has explicitly launched Desktop through the proxy. Every control
 * frame carries a PC-only token, and the peer advertises its protocol/backend
 * before any control capability is enabled.
 */

const net = require('node:net');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { FrameDecoder, encodeFrame } = require('./framing');
const { BridgeError, safeMessage } = require('./errors');

const CODEX_NATIVE_CONTROL_PROTOCOL = 1;
const DEFAULT_CONTROL_TIMEOUT_MS = 5000;
const DEFAULT_CONFIRM_TIMEOUT_MS = 5000;
const DEFAULT_CONNECT_TIMEOUT_MS = 1500;
const MAX_REGISTRY_ENTRIES = 32;
const MAX_REGISTRY_NAMES = 512;
const MAX_DESCRIPTOR_BYTES = 4096;
const CONTROL_MAX_FRAME_BYTES = 2 * 1024 * 1024;
const CONTROL_BACKEND = 'codex-desktop-app-server-stdio';
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function validControlOptions(options) {
  return options !== null && typeof options === 'object' &&
    options.host === '127.0.0.1' && Number.isInteger(options.port) && options.port >= 1 && options.port <= 65535 &&
    typeof options.token === 'string' && Buffer.byteLength(options.token, 'utf8') >= 32;
}

function validControlInfo(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    value.protocol === CODEX_NATIVE_CONTROL_PROTOCOL &&
    value.backend === CONTROL_BACKEND &&
    value.capabilities !== null && typeof value.capabilities === 'object' && !Array.isArray(value.capabilities) &&
    value.capabilities.stop === true && value.capabilities.answer === true && value.capabilities.approve === true;
}

function validRegistryConfig(options) {
  return options !== null && typeof options === 'object' &&
    typeof options.registryDir === 'string' && path.isAbsolute(options.registryDir) &&
    typeof options.runId === 'string' && UUID_V4.test(options.runId);
}

function descriptorFilename(runId, instanceId) {
  return `codex-native-${runId}-${instanceId}.json`;
}

function isReparsePoint(info) {
  return info.isSymbolicLink() || (Number.isInteger(info.attributes) && (info.attributes & 0x400) !== 0);
}

function validRegistryDirectory(registryDir) {
  if (typeof registryDir !== 'string' || !path.isAbsolute(registryDir)) return false;
  try {
    const resolved = path.resolve(registryDir);
    const root = path.parse(resolved).root;
    let current = root;
    for (const segment of path.relative(root, resolved).split(path.sep).filter(Boolean)) {
      current = path.join(current, segment);
      if (isReparsePoint(fs.lstatSync(current))) return false;
    }
    const info = fs.lstatSync(resolved);
    return info.isDirectory() && !isReparsePoint(info);
  } catch {
    return false;
  }
}

function readDescriptor(registryDir, filename, runId) {
  const match = /^codex-native-([0-9a-f-]{36})-([0-9a-f-]{36})\.json$/iu.exec(filename);
  if (match === null || match[1].toLowerCase() !== runId.toLowerCase() || !UUID_V4.test(match[2])) return null;
  const filePath = path.join(registryDir, filename);
  try {
    const info = fs.lstatSync(filePath);
    if (!info.isFile() || isReparsePoint(info) || info.size > MAX_DESCRIPTOR_BYTES) return null;
    const value = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    const allowed = new Set(['protocol', 'backend', 'runId', 'instanceId', 'host', 'port', 'token', 'proxyPid', 'nativePid']);
    if (value === null || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some((key) => !allowed.has(key)) ||
        value.protocol !== CODEX_NATIVE_CONTROL_PROTOCOL || value.backend !== CONTROL_BACKEND ||
        value.runId !== runId || value.instanceId !== match[2] || value.host !== '127.0.0.1' ||
        !Number.isInteger(value.port) || value.port < 1 || value.port > 65535 ||
        typeof value.token !== 'string' || Buffer.byteLength(value.token, 'utf8') < 32 ||
        !Number.isInteger(value.proxyPid) || value.proxyPid < 1 || !Number.isInteger(value.nativePid) || value.nativePid < 1) return null;
    return { ...value, filePath };
  } catch {
    return null;
  }
}

/**
 * One framed JSON-RPC connection to the explicitly enabled loopback proxy.
 * Authentication is added by this class to every method call, including reads.
 */
class CodexNativeControlClient {
  /** @param {{host:'127.0.0.1',port:number,token:string,timeoutMs?:number,confirmTimeoutMs?:number}} options */
  constructor(options) {
    if (!validControlOptions(options)) {
      throw new TypeError('Codex native control requires loopback host, port and a 32-byte local token');
    }
    this.host = options.host;
    this.port = options.port;
    this.token = options.token;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_CONTROL_TIMEOUT_MS;
    this.confirmTimeoutMs = options.confirmTimeoutMs ?? DEFAULT_CONFIRM_TIMEOUT_MS;
    this.connectTimeoutMs = options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
    if (![this.timeoutMs, this.confirmTimeoutMs, this.connectTimeoutMs].every((value) => Number.isFinite(value) && value > 0 && value <= 120000)) {
      throw new TypeError('Codex native control timeouts must be between 1 and 120000 milliseconds');
    }
    this.socket = null;
    this.decoder = new FrameDecoder({ maxBytes: CONTROL_MAX_FRAME_BYTES });
    this.nextId = 1;
    this.pending = new Map();
    this.info = null;
    this.closed = false;
    this.connecting = null;
  }

  async connect() {
    if (this.closed) throw new BridgeError('bridge_error', 'Codex native control is closed');
    if (this.info !== null && this.socket !== null && !this.socket.destroyed) return this.info;
    if (this.connecting !== null) return this.connecting;
    this.connecting = this.openSocketAndHandshake();
    try {
      return await this.connecting;
    } finally {
      this.connecting = null;
    }
  }

  async openSocketAndHandshake() {
    await this.openSocket();
    const info = await this.rawRequest('codex-native/initialize', { protocol: CODEX_NATIVE_CONTROL_PROTOCOL });
    if (!validControlInfo(info)) {
      this.close();
      throw new BridgeError('not_capable', 'the Codex control endpoint is not a supported desktop stdio proxy');
    }
    this.info = info;
    return info;
  }

  async openSocket() {
    if (this.socket !== null && !this.socket.destroyed) return;
    if (this.closed) throw new BridgeError('bridge_error', 'Codex native control is closed');
    await new Promise((resolve, reject) => {
      const socket = net.createConnection({ host: this.host, port: this.port });
      let settled = false;
      const timer = setTimeout(() => {
        finish(new BridgeError('bridge_error', 'Codex native control connection timed out'));
        socket.on('error', () => {});
        socket.destroy();
      }, this.connectTimeoutMs);
      const finish = (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket.off('connect', onConnect);
        socket.off('error', onError);
        if (error) reject(error);
        else resolve();
      };
      const onError = (error) => {
        socket.destroy();
        finish(new BridgeError('bridge_error', `Codex native control is not reachable (${error.code ?? 'error'})`));
      };
      const onConnect = () => {
        if (settled) return;
        finish();
        socket.on('error', () => this.failAll(new BridgeError('bridge_error', 'Codex native control failed')));
        socket.on('close', () => {
          this.info = null;
          this.failAll(new BridgeError('bridge_error', 'Codex native control closed'));
        });
        socket.on('data', (chunk) => this.onData(chunk));
        this.socket = socket;
        this.decoder.reset();
      };
      socket.once('error', onError);
      socket.once('connect', onConnect);
    });
  }

  onData(chunk) {
    let messages;
    try {
      messages = this.decoder.push(chunk);
    } catch (error) {
      this.failAll(new BridgeError('bridge_error', safeMessage(error, 'bridge_error')));
      this.close();
      return;
    }
    for (const message of messages) {
      if (!Object.prototype.hasOwnProperty.call(message, 'id')) continue;
      const entry = this.pending.get(message.id);
      if (entry === undefined) continue;
      this.pending.delete(message.id);
      clearTimeout(entry.timer);
      if (message.error !== undefined) {
        const code = message.error?.data?.code === 'stale_request' ? 'session_not_found' : 'bridge_error';
        entry.reject(new BridgeError(code, `Codex native ${entry.method} failed: ${safeMessage(message.error.message)}`));
      } else {
        entry.resolve(message.result);
      }
    }
  }

  failAll(error) {
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    this.pending.clear();
  }

  async rawRequest(method, params = {}, options = {}) {
    await this.openSocket();
    const id = this.nextId++;
    const socket = this.socket;
    if (socket === null || socket.destroyed) throw new BridgeError('bridge_error', 'Codex native control is not connected');
    const timeoutMs = options.timeoutMs ?? this.timeoutMs;
    const frame = { jsonrpc: '2.0', id, method, params: { ...params, token: this.token } };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new BridgeError('bridge_error', `Codex native ${method} timed out`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer, method });
      try {
        socket.write(encodeFrame(frame, { maxBytes: CONTROL_MAX_FRAME_BYTES }));
      } catch (error) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(new BridgeError('bridge_error', safeMessage(error, 'bridge_error')));
      }
    });
  }

  async request(method, params = {}, options = {}) {
    await this.connect();
    return this.rawRequest(method, params, options);
  }

  async initialize() {
    return this.connect();
  }

  async snapshot(threadId) {
    if (typeof threadId !== 'string' || threadId.length === 0) {
      throw new BridgeError('invalid_params', 'a live Codex thread is required');
    }
    const value = await this.request('codex-native/snapshot', { threadId });
    if (value === null || typeof value !== 'object' || !Array.isArray(value.requests) || typeof value.observed !== 'boolean') {
      throw new BridgeError('bridge_error', 'Codex native control returned an invalid request snapshot');
    }
    return value;
  }

  async interrupt(threadId, turnId) {
    if (typeof threadId !== 'string' || threadId.length === 0 || typeof turnId !== 'string' || turnId.length === 0) {
      throw new BridgeError('invalid_params', 'a live Codex thread and turn are required to stop');
    }
    const value = await this.request('codex-native/interrupt', { threadId, turnId }, { timeoutMs: this.confirmTimeoutMs + this.timeoutMs });
    if (value?.state !== 'confirmed' && value?.state !== 'submitted') {
      throw new BridgeError('bridge_error', 'Codex did not report an interrupt outcome');
    }
    return value;
  }

  async respond({ bridgeRequestId, threadId, itemId, answer }) {
    if (typeof bridgeRequestId !== 'string' || typeof threadId !== 'string' || threadId.length === 0 || typeof itemId !== 'string' || itemId.length === 0) {
      throw new BridgeError('invalid_params', 'a live Codex request is required to submit this response');
    }
    const value = await this.request('codex-native/respond', { bridgeRequestId, threadId, itemId, answer }, { timeoutMs: this.confirmTimeoutMs + this.timeoutMs });
    if (value?.state !== 'confirmed' && value?.state !== 'submitted') {
      throw new BridgeError('bridge_error', 'Codex did not report a response outcome');
    }
    return value;
  }

  close() {
    this.closed = true;
    this.failAll(new BridgeError('bridge_error', 'Codex native control closed by us'));
    this.socket?.destroy();
    this.socket = null;
    this.info = null;
  }
}

/**
 * Discovers one authenticated control endpoint per real Desktop app-server
 * child. A thread action is routed to the endpoint whose native event stream
 * proved ownership; callers must refuse ambiguous matches.
 */
class CodexNativeControlRegistry {
  /** @param {{registryDir:string,runId:string,clientFactory?:(descriptor:object)=>CodexNativeControlClient}} options */
  constructor(options) {
    if (!validRegistryConfig(options)) throw new TypeError('Codex native control registry needs an absolute directory and run UUID');
    this.registryDir = path.resolve(options.registryDir);
    this.runId = options.runId;
    this.clientFactory = options.clientFactory ?? ((descriptor) => new CodexNativeControlClient(descriptor));
    this.clients = new Map();
    this.rejectedDescriptors = new Map();
    this.ready = false;
    this.closed = false;
  }

  readDescriptors() {
    if (this.closed) return [];
    if (!validRegistryDirectory(this.registryDir)) return [];
    let names;
    try { names = fs.readdirSync(this.registryDir); } catch { return []; }
    if (names.length > MAX_REGISTRY_NAMES) return [];
    const candidates = names.filter((name) => name.startsWith(`codex-native-${this.runId}-`) && name.endsWith('.json'));
    if (candidates.length > MAX_REGISTRY_ENTRIES) return [];
    return candidates.map((name) => readDescriptor(this.registryDir, name, this.runId)).filter(Boolean);
  }

  async refresh() {
    if (this.closed) return [];
    const descriptors = this.readDescriptors();
    const descriptorById = new Map(descriptors.map((descriptor) => [descriptor.instanceId, descriptor]));
    for (const [instanceId, entry] of this.clients) {
      const descriptor = descriptorById.get(instanceId);
      if (descriptor === undefined || descriptorFingerprint(descriptor) !== descriptorFingerprint(entry.descriptor)) {
        entry.client.close();
        this.clients.delete(instanceId);
      }
    }
    for (const [instanceId, fingerprint] of this.rejectedDescriptors) {
      const descriptor = descriptorById.get(instanceId);
      if (descriptor === undefined || descriptorFingerprint(descriptor) !== fingerprint) this.rejectedDescriptors.delete(instanceId);
    }
    for (const descriptor of descriptors) {
      if (this.rejectedDescriptors.get(descriptor.instanceId) === descriptorFingerprint(descriptor)) continue;
      if (!this.clients.has(descriptor.instanceId)) this.clients.set(descriptor.instanceId, { descriptor, client: this.clientFactory(descriptor) });
    }
    const ready = [];
    await Promise.all([...this.clients.values()].map(async (entry) => {
      try {
        await entry.client.initialize();
        ready.push(entry);
      } catch {
        if (entry.client.closed) {
          entry.client.close();
          this.clients.delete(entry.descriptor.instanceId);
          this.rejectedDescriptors.set(entry.descriptor.instanceId, descriptorFingerprint(entry.descriptor));
        }
      }
    }));
    this.ready = ready.length > 0;
    return ready;
  }

  async snapshots(threadId) {
    const clients = await this.refresh();
    const results = [];
    await Promise.all(clients.map(async (entry) => {
      try {
        const snapshot = await entry.client.snapshot(threadId);
        results.push({ instanceId: entry.descriptor.instanceId, client: entry.client, snapshot });
      } catch {
        // A child disappearing during a fresh snapshot is not an owner.
      }
    }));
    return results;
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    for (const entry of this.clients.values()) entry.client.close();
    this.clients.clear();
    this.rejectedDescriptors.clear();
    this.ready = false;
  }
}

function descriptorFingerprint(descriptor) {
  return crypto.createHash('sha256')
    .update(`${descriptor.runId}\u0000${descriptor.instanceId}\u0000${descriptor.host}\u0000${descriptor.port}\u0000${descriptor.proxyPid}\u0000${descriptor.nativePid}\u0000${descriptor.token}`)
    .digest('hex');
}

module.exports = {
  CODEX_NATIVE_CONTROL_PROTOCOL,
  CONTROL_BACKEND,
  CONTROL_MAX_FRAME_BYTES,
  CodexNativeControlClient,
  CodexNativeControlRegistry,
  validRegistryConfig,
  descriptorFilename,
  readDescriptor,
  validRegistryDirectory,
  validControlOptions,
  validControlInfo,
};
