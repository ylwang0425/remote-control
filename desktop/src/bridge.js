'use strict';
/**
 * The bridge: this desktop's half of the relay link (protocol-v1 §8, §10).
 *
 * It owns everything the contract pins on this side:
 * - one outbound WebSocket to `wss://<relay>/bridge` with
 *   `Authorization: Bearer <bridgeToken>` and **no** `Origin` header (§8.1);
 * - `hello` first, then heartbeats on the interval `hello.ok` hands back (§8.4.2,
 *   §10.5), and never a frame type outside the §8.3 table;
 * - one answer per `request`, with the relay's id echoed byte for byte, and a
 *   duplicate request id executed at most once - that is what stops a repeated
 *   `session.send` from posting twice (§8.4.7, §10.2);
 * - exponential reconnect with the contract's schedule, reset by `hello.ok`, and
 *   a slow path after HTTP 401 so a wrong token cannot become a login storm
 *   (§10.4);
 * - `pair.create` with an id minted here, answered by `pair.created` (CRD 0003).
 *
 * Nothing here retries a send. A request that fails is answered with a failure;
 * the phone decides whether the user tries again.
 */

const { WebSocketClient } = require('./ws');
const { Backoff } = require('./backoff');
const { PendingRegistry, MAX_PENDING } = require('./pending');
const { BridgeError, errorResponse, mapError, safeMessage } = require('./errors');
const { parseFrame, parseRequest, buildHello, buildPairCreate, buildPing, buildPong, buildResponse, newId, envelopeBytes, fitSessionReadResult, RESPONSE_BYTE_BUDGET, MAX_RESPONSE_BYTES } = require('./protocol');

const HELLO_TIMEOUT_MS = 10000;
const PAIR_TIMEOUT_MS = 20000;
const ANSWERED_IDS_LIMIT = 256;

class BridgeClient {
  /**
   * @param {object} options
   * @param {string} options.url relay WebSocket URL
   * @param {string} options.token bridge token (never logged)
   * @param {string} options.clientName
   * @param {object} options.capabilities
   * @param {(request: {method: string, params: object}) => Promise<object>} options.dispatch
   * @param {object} [options.backoff] policy override, for tests
   * @param {object} [options.socketFactory] socket override, for tests
   */
  constructor(options) {
    this.url = options.url;
    this.token = options.token;
    this.clientName = options.clientName;
    this.clientId = options.clientId ?? null;
    this.ownerName = options.ownerName ?? null;
    this.capabilities = options.capabilities;
    this.dispatch = options.dispatch;
    this.backoff = options.backoff ?? new Backoff();
    this.socketFactory = options.socketFactory ?? ((url, socketOptions) => new WebSocketClient(url, socketOptions));
    this.helloTimeoutMs = options.helloTimeoutMs ?? HELLO_TIMEOUT_MS;
    this.pairTimeoutMs = options.pairTimeoutMs ?? PAIR_TIMEOUT_MS;
    this.socket = null;
    this.state = 'idle';
    this.authRejected = false;
    this.negotiated = null;
    this.lastFrameAt = 0;
    this.heartbeatTimer = null;
    this.reconnectTimer = null;
    this.helloTimer = null;
    this.pending = new PendingRegistry({ maxPending: options.maxPending ?? MAX_PENDING });
    this.answeredIds = new Set();
    this.pairWaiters = new Map();
    this.listeners = new Map();
    this.stopped = false;
    this.connectResolvers = [];
    /**
     * The transport ceiling for one frame, and it must exist as a real number:
     * the answer path compares against it, and while it was missing (undefined)
     * every comparison came out false, so an oversized `session.read` went out
     * anyway and the relay refused the frame. Both ends use the same cap,
     * protocol-v1 §8.2.
     */
    this.maxFrameBytes = options.maxFrameBytes ?? MAX_RESPONSE_BYTES;
  }

  get connected() {
    return this.state === 'ready';
  }

  on(event, handler) {
    const list = this.listeners.get(event) ?? [];
    list.push(handler);
    this.listeners.set(event, list);
    return this;
  }

  emit(event, payload) {
    for (const handler of this.listeners.get(event) ?? []) {
      try {
        handler(payload);
      } catch {
        // A failing listener must not break the link.
      }
    }
  }

  /** Connect once and return; reconnection continues in the background. */
  async start() {
    this.stopped = false;
    await this.connectOnce();
    return this;
  }

  /** Wait until `hello.ok` has been accepted (used by tests and the CLI). */
  waitUntilConnected(timeoutMs = 5000) {
    if (this.connected) return Promise.resolve(true);
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), timeoutMs);
      this.connectResolvers.push(() => {
        clearTimeout(timer);
        resolve(true);
      });
    });
  }

  async stop() {
    this.stopped = true;
    clearTimeout(this.reconnectTimer);
    clearInterval(this.heartbeatTimer);
    clearTimeout(this.helloTimer);
    this.pending.failAll(new BridgeError('bridge_error', 'the bridge stopped'));
    for (const waiter of this.pairWaiters.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(new BridgeError('bridge_error', 'the bridge stopped'));
    }
    this.pairWaiters.clear();
    this.socket?.destroy();
    this.socket = null;
    this.state = 'stopped';
  }

  /** One connection attempt. Reconnection is scheduled from the close handler. */
  connectOnce() {
    if (this.stopped) return Promise.resolve();
    this.state = 'connecting';
    const socket = this.socketFactory(this.url, {
      headers: { Authorization: `Bearer ${this.token}` },
      handshakeTimeoutMs: this.helloTimeoutMs,
    });
    this.socket = socket;
    socket.on('open', () => {
      this.lastFrameAt = Date.now();
      this.state = 'handshaking';
      this.sendFrame(this.helloFrame());
      clearTimeout(this.helloTimer);
      this.helloTimer = setTimeout(() => {
        // No hello.ok: drop the socket and let the normal reconnect path retry.
        this.emit('hello.timeout', {});
        socket.destroy();
        this.scheduleReconnect();
      }, this.helloTimeoutMs);
    });
    socket.on('message', (text) => this.onFrame(text));
    socket.on('ping', () => {
      /* the ws client already answered with a pong */
    });
    socket.on('pong', () => {
      this.lastFrameAt = Date.now();
    });
    socket.on('error', (error) => this.emit('error', error));
    socket.on('close', (code) => {
      // `updateConnection` and `stop` may retire a socket while another socket
      // is already active. A late close from the retired connection must never
      // clear the new socket or schedule a duplicate reconnect.
      if (this.socket !== socket) return;
      clearTimeout(this.helloTimer);
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
      const wasReady = this.connected;
      this.state = 'closed';
      this.socket = null;
      // The code here is ours to choose and travels no further than this process:
      // protocol-v1 §8.4.8 allows the desktop to SEND only seven codes, so an
      // internal "the link dropped" is `bridge_error`, never `bridge_bad_response`
      // (which is the relay's own 502 for the phone).
      this.pending.failAll(new BridgeError('bridge_error', 'the relay connection was lost'));
      if (wasReady) this.emit('close', { code });
      if (!this.stopped) this.scheduleReconnect();
    });
    // Start the handshake. A refusal (401/403) is a configuration answer, not a
    // network blip: it takes the slow path so a wrong token cannot turn into a
    // login storm (protocol-v1 §10.4).
    Promise.resolve()
      .then(() => socket.connect())
      .catch((error) => {
        clearTimeout(this.helloTimer);
        this.state = 'closed';
        if (this.socket === socket) this.socket = null;
        if (error?.statusCode === 401 || error?.statusCode === 403) {
          this.authRejected = true;
          this.emit('auth.rejected', { statusCode: error.statusCode });
        } else {
          this.emit('connect.failed', { code: error?.code ?? 'connect_failed' });
        }
        if (!this.stopped) this.scheduleReconnect();
      });
    return Promise.resolve();
  }

  scheduleReconnect() {
    if (this.stopped || this.reconnectTimer !== null) return;
    const delay = this.authRejected ? this.backoff.reject() : this.backoff.next();
    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      try {
        await this.connectOnce();
      } catch (error) {
        this.emit('error', error);
        this.scheduleReconnect();
      }
    }, delay);
    this.emit('reconnect.scheduled', { delay, authRejected: this.authRejected });
  }

  sendFrame(frame) {
    if (this.socket === null || !this.socket.open) return false;
    try {
      return this.socket.send(JSON.stringify(frame));
    } catch (error) {
      this.emit('error', error);
      return false;
    }
  }

  helloFrame() {
    return buildHello({
      clientName: this.clientName,
      clientId: this.clientId,
      ownerName: this.ownerName,
      capabilities: this.capabilities,
    });
  }

  /** Update the computer label on the authenticated connection. The relay accepts a repeated hello. */
  updateIdentity({ clientId = this.clientId, ownerName = this.ownerName, clientName = this.clientName } = {}) {
    const frame = buildHello({ clientId, ownerName, clientName, capabilities: this.capabilities });
    this.clientId = clientId;
    this.ownerName = ownerName;
    this.clientName = clientName;
    if (this.connected) return this.sendFrame(frame);
    return false; // the next handshake carries the current identity
  }

  /** Replace relay credentials and reconnect only this bridge transport. */
  updateConnection({ url = this.url, token = this.token, clientId = this.clientId, ownerName = this.ownerName, clientName = this.clientName } = {}) {
    if (typeof url !== 'string' || url.length === 0 || typeof token !== 'string' || token.length === 0) {
      throw new TypeError('the relay URL and credential are required');
    }
    // Validate all hello fields before changing the active connection settings.
    buildHello({ clientId, ownerName, clientName, capabilities: this.capabilities });
    this.url = url;
    this.token = token;
    this.clientId = clientId;
    this.ownerName = ownerName;
    this.clientName = clientName;
    this.authRejected = false;
    this.backoff.reset();
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    if (this.socket !== null) {
      const previous = this.socket;
      this.socket = null;
      this.state = 'reconnecting';
      previous.destroy();
    }
    if (!this.stopped) {
      void this.connectOnce();
    }
  }

  onFrame(text) {
    this.lastFrameAt = Date.now();
    let parsed;
    try {
      parsed = parseFrame(text);
    } catch (error) {
      // A frame that is not JSON, or has no type, is a protocol error; the relay
      // owns closing the connection for it (§8.5).
      this.emit('protocol.error', error);
      return;
    }
    const { known, frame } = parsed;
    if (!known) {
      this.emit('frame.ignored', frame);
      return;
    }
    switch (frame.type) {
      case 'hello.ok':
        this.onHelloOk(frame);
        return;
      case 'ping':
        this.sendFrame(buildPong());
        return;
      case 'pong':
        return;
      case 'pair.created':
        this.onPairCreated(frame);
        return;
      case 'pair.used':
        this.emit('pair.used', { codeId: frame.codeId, deviceName: frame.deviceName, at: frame.at });
        return;
      case 'request':
        this.onRequest(frame);
        return;
      default:
        // `response` and anything else arriving here is not something this side
        // waits for: ignore it rather than inventing behaviour.
        this.emit('frame.ignored', frame);
    }
  }

  onHelloOk(frame) {
    if (frame.version !== 1) {
      this.emit('protocol.error', new Error(`the relay speaks version ${frame.version}`));
      this.socket?.close(1008, 'version mismatch');
      return;
    }
    clearTimeout(this.helloTimer);
    this.authRejected = false;
    this.backoff.reset();
    this.negotiated = {
      heartbeatIntervalMs: Number(frame.heartbeatIntervalMs) || 20000,
      idleTimeoutMs: Number(frame.idleTimeoutMs) || 60000,
      requestTimeoutMs: Number(frame.requestTimeoutMs) || 30000,
      maxPending: Number(frame.maxPending) || MAX_PENDING,
    };
    this.state = 'ready';
    this.startHeartbeat();
    for (const resolve of this.connectResolvers.splice(0)) resolve();
    this.emit('ready', this.negotiated);
  }

  /** Heartbeat on the interval the relay gave us, never on a local constant. */
  startHeartbeat() {
    clearInterval(this.heartbeatTimer);
    const interval = this.negotiated?.heartbeatIntervalMs ?? 20000;
    this.heartbeatTimer = setInterval(() => {
      if (!this.connected) return;
      this.sendFrame(buildPing());
    }, interval);
    if (typeof this.heartbeatTimer.unref === 'function') this.heartbeatTimer.unref();
  }

  onPairCreated(frame) {
    const waiter = this.pairWaiters.get(frame.id);
    if (waiter === undefined) return;
    clearTimeout(waiter.timer);
    this.pairWaiters.delete(frame.id);
    waiter.resolve({ id: frame.id, code: frame.code, expiresAt: frame.expiresAt, url: frame.url });
  }

  /**
   * Ask the relay for a pairing code. The id is minted here (CRD 0003) and the
   * answer is matched on it, so two codes can never be confused.
   */
  async createPairCode(timeoutMs = this.pairTimeoutMs) {
    if (!this.connected) {
      throw new BridgeError('bridge_error', 'the relay link is not up');
    }
    const frame = buildPairCreate();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pairWaiters.delete(frame.id);
        reject(new BridgeError('bridge_error', 'the relay did not answer pair.create'));
      }, timeoutMs);
      this.pairWaiters.set(frame.id, { resolve, reject, timer });
      if (!this.sendFrame(frame)) {
        clearTimeout(timer);
        this.pairWaiters.delete(frame.id);
        reject(new BridgeError('bridge_error', 'the relay link closed before pair.create was sent'));
      }
    });
  }

  async onRequest(frame) {
    const id = typeof frame.id === 'string' ? frame.id : null;
    if (id === null) {
      this.emit('protocol.error', new Error('request without an id'));
      return;
    }
    // The same request id is never executed twice: a retried `session.send` on
    // the wire would otherwise post a second message (§8.4.7, §10.2).
    if (this.answeredIds.has(id) || this.pending.has(id)) {
      this.emit('request.duplicate', { id });
      return;
    }
    let request;
    try {
      request = parseRequest(frame);
    } catch (error) {
      this.answer(id, error);
      return;
    }
    const promise = this.pending.add(id, { method: request.method, timeoutMs: request.timeoutMs });
    if (promise === null) {
      this.answer(id, new BridgeError('bridge_error', 'too many requests are already in flight'));
      return;
    }
    this.emit('request.received', request);
    // The registry owns the deadline: if it fires, this id is gone and the late
    // answer below is dropped instead of being sent out of time.
    promise.catch((error) => this.emit('request.timeout', { id, code: error.code }));
    void this.executeRequest(id, request);
  }

  /**
   * Run the dispatch for one request and answer it exactly once.
   *
   * `session.send` reaches here once per request id and is never repeated: no
   * retry lives on this path, because a duplicate message is worse than a
   * failure the user can see.
   */
  async executeRequest(id, request) {
    let result;
    try {
      result = await this.dispatch({ method: request.method, params: request.params });
    } catch (error) {
      if (!this.pending.has(id)) {
        return; // already timed out: the relay would discard this answer anyway
      }
      this.answer(id, error);
      return;
    }
    if (!this.pending.has(id)) {
      return;
    }
    this.answer(id, null, result);
  }

  /** Send the one answer for an id, then remember the id forever (bounded). */
  answer(id, error, result) {
    let frame = error === null ? buildResponse(id, result) : errorResponse(id, mapError(error).code, mapError(error).message);
    // Trim whenever the whole envelope passes the *working* budget, not only the
    // hard cap. The phone's "the desktop did not answer" came from a frame of
    // about 321 kB: it was under no comparison at all while `maxFrameBytes` was
    // undefined, and it is the budget - not the cap - that keeps a long history
    // inside one frame with room to spare.
    const budget = Math.min(RESPONSE_BYTE_BUDGET, this.maxFrameBytes - 2048);
    if (envelopeBytes(frame) > budget) {
      if (error === null && result !== null && typeof result === 'object' && Array.isArray(result.messages)) {
        const fitted = fitSessionReadResult(result, { budget, id });
        frame = buildResponse(id, fitted.result);
        this.emit('answer.trimmed', { id, bytes: fitted.bytes, dropped: fitted.droppedMessages, truncated: fitted.truncated });
      }
      // Anything still over the hard cap cannot be sent at all; a short failure
      // frame is the one useful thing left to say.
      if (envelopeBytes(frame) > this.maxFrameBytes) {
        frame = errorResponse(id, 'bridge_error', 'the answer was too large to send');
      }
    }
    this.answeredIds.add(id);
    if (this.answeredIds.size > ANSWERED_IDS_LIMIT) {
      const oldest = this.answeredIds.values().next().value;
      this.answeredIds.delete(oldest);
    }
    this.pending.settle(id, result);
    const sent = this.sendFrame(frame);
    if (!sent) {
      this.emit('answer.dropped', { id, bytes: envelopeBytes(frame) });
      // Never go silent: a short failure frame is better than a timeout on the
      // phone, and it is the only information the caller can still act on.
      this.sendFrame(errorResponse(id, 'bridge_error', 'the answer could not be sent'));
    }
    return frame;
  }

  /**
   * Run one dispatch for an id, with the deadline the relay gave. Used by the
   * dispatcher and by tests; keeps the pending registry honest.
   */
  async execute(id, request) {
    try {
      const result = await this.dispatch(request);
      this.pending.settle(id, result);
      return result;
    } catch (error) {
      this.pending.fail(id, error);
      throw error;
    }
  }

  /** A short, safe description for the local UI. Never includes the token. */
  describe() {
    return {
      relayUrl: this.url,
      clientName: this.clientName,
      clientId: this.clientId,
      ownerName: this.ownerName,
      connected: this.connected,
      state: this.state,
      authRejected: this.authRejected,
      capabilities: this.capabilities,
      pending: this.pending.size,
      negotiated: this.negotiated,
      lastFrameAt: this.lastFrameAt === 0 ? null : new Date(this.lastFrameAt).toISOString(),
    };
  }
}

module.exports = { BridgeClient, safeMessage, newId };
