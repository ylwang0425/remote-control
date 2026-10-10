'use strict';
/**
 * A dependency-free WebSocket client over `node:net` / `node:tls`.
 *
 * The project ships without an Electron and without adding packages, and Node
 * has no built-in WebSocket *client* that takes custom handshake headers, so the
 * few RFC 6455 pieces the bridge needs live here: the HTTP upgrade with our own
 * `Authorization` header (and, per protocol-v1 §8.1, no `Origin`), client-side
 * masking, text frames, ping/pong, and the close handshake.
 *
 * The client is deliberately small: text frames only, one socket, no extensions,
 * no compression, no reconnection (the bridge owns that policy).
 */

const crypto = require('node:crypto');
const net = require('node:net');
const tls = require('node:tls');
const { EventEmitter } = require('node:events');

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_FRAME_BYTES = 262144;
const DEFAULT_HANDSHAKE_TIMEOUT_MS = 15000;

const OPCODE = { CONTINUATION: 0x0, TEXT: 0x1, BINARY: 0x2, CLOSE: 0x8, PING: 0x9, PONG: 0xa };

class WebSocketError extends Error {
  constructor(code, message, extra = {}) {
    super(message);
    this.name = 'WebSocketError';
    this.code = code;
    Object.assign(this, extra);
  }
}

/**
 * @typedef {object} WebSocketClientOptions
 * @property {Record<string,string>} [headers] extra handshake headers (Authorization)
 * @property {number} [maxFrameBytes]
 * @property {number} [handshakeTimeoutMs]
 */

class WebSocketClient extends EventEmitter {
  /** @param {string} url `ws://` or `wss://` @param {WebSocketClientOptions} [options] */
  constructor(url, options = {}) {
    super();
    this.url = url;
    this.options = options;
    this.headers = options.headers ?? {};
    this.maxFrameBytes = options.maxFrameBytes ?? MAX_FRAME_BYTES;
    this.handshakeTimeoutMs = options.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS;
    this.socket = null;
    this.state = 'idle';
    this.buffer = Buffer.alloc(0);
    this.fragments = [];
    this.fragmentOpcode = null;
    this.closeSent = false;
  }

  /**
   * Open the socket and complete the handshake.
   * @returns {Promise<void>} resolves on HTTP 101, rejects with a WebSocketError
   */
  connect() {
    const parsed = new URL(this.url);
    if (parsed.protocol !== 'ws:' && parsed.protocol !== 'wss:') {
      return Promise.reject(new WebSocketError('bad_url', `unsupported scheme ${parsed.protocol}`));
    }
    const secure = parsed.protocol === 'wss:';
    const port = parsed.port ? Number(parsed.port) : secure ? 443 : 80;
    const key = crypto.randomBytes(16).toString('base64');
    this.state = 'connecting';
    this.buffer = Buffer.alloc(0);
    this.fragments = [];
    this.fragmentOpcode = null;
    this.fragmentBytes = 0;
    this.closeSent = false;

    return new Promise((resolve, reject) => {
      let settled = false;
      const fail = (error) => {
        if (settled) return;
        settled = true;
        this.state = 'closed';
        clearTimeout(timer);
        this.socket?.destroy();
        reject(error);
      };
      const timer = setTimeout(
        () => fail(new WebSocketError('handshake_timeout', 'the handshake did not finish in time')),
        this.handshakeTimeoutMs,
      );
      if (typeof timer.unref === 'function') timer.unref();

      const onConnect = () => {
        this.socket.write(buildHandshake(parsed, key, this.headers));
        const onData = (chunk) => {
          this.buffer = Buffer.concat([this.buffer, chunk]);
          const headerEnd = this.buffer.indexOf('\r\n\r\n');
          if (headerEnd === -1) {
            if (this.buffer.length > 65536) {
              fail(new WebSocketError('handshake_failed', 'handshake response headers were too large'));
            }
            return;
          }
          const rawHeaders = this.buffer.subarray(0, headerEnd).toString('latin1');
          const rest = this.buffer.subarray(headerEnd + 4);
          this.buffer = Buffer.alloc(0);
          this.socket.off('data', onData);
          const lines = rawHeaders.split('\r\n');
          const status = Number((lines[0].match(/^HTTP\/1\.1 (\d{3})/) ?? [])[1] ?? 0);
          const responseHeaders = {};
          for (const line of lines.slice(1)) {
            const index = line.indexOf(':');
            if (index > 0) {
              responseHeaders[line.slice(0, index).trim().toLowerCase()] = line.slice(index + 1).trim();
            }
          }
          if (status !== 101) {
            fail(
              new WebSocketError('handshake_failed', `the server answered HTTP ${status}`, {
                statusCode: status,
                body: rest.toString('utf8'),
                responseHeaders,
              }),
            );
            return;
          }
          const expected = crypto.createHash('sha1').update(key + GUID).digest('base64');
          if (responseHeaders['sec-websocket-accept'] !== expected) {
            fail(new WebSocketError('bad_accept', 'Sec-WebSocket-Accept did not match the handshake key'));
            return;
          }
          settled = true;
          clearTimeout(timer);
          this.state = 'open';
          this.socket.on('data', (data) => this.onData(data));
          this.socket.on('close', () => this.onSocketClosed());
          this.socket.on('error', (error) => this.emitError(new WebSocketError('socket_error', error.message)));
          if (rest.length > 0) {
            this.onData(rest);
          }
          this.emit('open');
          resolve();
        };
        this.socket.on('data', onData);
      };

      const onError = (error) => {
        fail(new WebSocketError('connect_failed', error.message));
      };

      this.socket = secure
        ? tls.connect({ host: parsed.hostname, port, servername: parsed.hostname, rejectUnauthorized: true })
        : net.connect({ host: parsed.hostname, port });
      this.socket.once('error', onError);
      this.socket.once(secure ? 'secureConnect' : 'connect', () => {
        this.socket.off('error', onError);
        this.socket.on('error', () => {});
        onConnect();
      });
    });
  }

  get open() {
    return this.state === 'open';
  }

  /**
   * Send one text frame.
   * @returns {boolean} false when the socket is not open, or the frame is too big
   */
  send(text) {
    if (!this.open || this.socket === null) {
      return false;
    }
    const payload = Buffer.from(text, 'utf8');
    if (payload.length > this.maxFrameBytes) {
      const error = new WebSocketError('frame_too_large', `frame of ${payload.length} bytes exceeds the limit`);
      error.code = 'frame_too_large';
      throw error;
    }
    this.socket.write(encodeClientFrame(OPCODE.TEXT, payload));
    return true;
  }

  /** Send a ping (the bridge heartbeats with these). */
  ping(payload = Buffer.alloc(0)) {
    if (!this.open || this.socket === null) return false;
    this.socket.write(encodeClientFrame(OPCODE.PING, payload));
    return true;
  }

  /** Send a close frame and end the socket. */
  close(code = 1000, reason = '') {
    if (this.socket === null || this.closeSent) {
      return;
    }
    this.closeSent = true;
    if (this.state === 'open') {
      const body = Buffer.alloc(2 + Buffer.byteLength(reason));
      body.writeUInt16BE(code, 0);
      body.write(reason, 2);
      this.socket.write(encodeClientFrame(OPCODE.CLOSE, body));
    }
    this.state = 'closing';
    this.socket.end();
  }

  /** Tear the socket down without a close frame (tests and hard failures). */
  destroy() {
    this.state = 'closed';
    this.socket?.destroy();
  }

  onData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (this.buffer.length >= 2) {
      const first = this.buffer[0];
      const second = this.buffer[1];
      const fin = (first & 0x80) !== 0;
      const opcode = first & 0x0f;
      const masked = (second & 0x80) !== 0;
      let length = second & 0x7f;
      let offset = 2;
      if (length === 126) {
        if (this.buffer.length < 4) return;
        length = this.buffer.readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        if (this.buffer.length < 10) return;
        length = Number(this.buffer.readBigUInt64BE(2));
        offset = 10;
      }
      if (length > this.maxFrameBytes) {
        this.emitError(new WebSocketError('frame_too_large', `the server sent a ${length} byte frame`));
        this.close(1009, 'message too big');
        return;
      }
      if (this.buffer.length < offset + (masked ? 4 : 0) + length) {
        return;
      }
      if (masked) {
        this.emitError(new WebSocketError('protocol_error', 'server frames must not be masked'));
        this.destroy();
        return;
      }
      const payload = this.buffer.subarray(offset, offset + length);
      this.buffer = this.buffer.subarray(offset + length);
      this.handleFrame(fin, opcode, payload);
      if (this.state === 'closed') {
        return;
      }
    }
  }

  handleFrame(fin, opcode, payload) {
    if (opcode === OPCODE.CONTINUATION || opcode === OPCODE.TEXT || opcode === OPCODE.BINARY) {
      if (opcode !== OPCODE.CONTINUATION) {
        this.fragmentOpcode = opcode;
      }
      this.fragments.push(Buffer.from(payload));
      this.fragmentBytes += payload.length;
      // Each fragment is checked against the limit, but a stream of small
      // fragments could still grow without bound, so the whole message counts
      // too. A relay that does that is hostile or broken; either way the link
      // goes away with the contract's 1009.
      if (this.fragmentBytes > this.maxFrameBytes) {
        this.emitError(new WebSocketError('frame_too_large', 'the fragmented message exceeded the frame limit'));
        this.close(1009, 'message too big');
        return;
      }
      if (!fin) {
        return;
      }
      const full = Buffer.concat(this.fragments);
      const kind = this.fragmentOpcode;
      this.fragments = [];
      this.fragmentBytes = 0;
      this.fragmentOpcode = null;
      if (kind === OPCODE.BINARY) {
        this.emitError(new WebSocketError('protocol_error', 'binary frames are not allowed on this link'));
        this.close(1003, 'unsupported data');
        return;
      }
      if (full.length === 0) {
        this.emitError(new WebSocketError('protocol_error', 'empty text frames are not allowed on this link'));
        this.close(1002, 'protocol error');
        return;
      }
      this.emit('message', full.toString('utf8'));
      return;
    }
    if (opcode === OPCODE.PING) {
      if (this.open && this.socket !== null) {
        this.socket.write(encodeClientFrame(OPCODE.PONG, payload));
      }
      this.emit('ping', payload);
      return;
    }
    if (opcode === OPCODE.PONG) {
      this.emit('pong', payload);
      return;
    }
    if (opcode === OPCODE.CLOSE) {
      const code = payload.length >= 2 ? payload.readUInt16BE(0) : 1005;
      const reason = payload.length > 2 ? payload.subarray(2).toString('utf8') : '';
      if (!this.closeSent && this.socket !== null) {
        this.closeSent = true;
        this.socket.write(encodeClientFrame(OPCODE.CLOSE, payload.subarray(0, Math.min(2, payload.length))));
      }
      this.state = 'closed';
      this.socket?.end();
      this.emit('close', code, reason, true);
      return;
    }
    this.emitError(new WebSocketError('protocol_error', `unknown opcode ${opcode}`));
    this.destroy();
  }

  onSocketClosed() {
    const wasOpen = this.state === 'open' || this.state === 'closing';
    this.state = 'closed';
    if (wasOpen) {
      this.emit('close', this.closeSent ? 1000 : 1006, this.closeSent ? '' : 'connection lost', false);
    }
  }

  /** 'error' has no listener in the bridge's happy path, so never throw on emit. */
  emitError(error) {
    if (this.listenerCount('error') > 0) {
      this.emit('error', error);
    } else {
      this.emit('clientError', error);
    }
  }
}

/** Build the HTTP upgrade request. Deliberately no `Origin` header. */
function buildHandshake(parsed, key, headers) {
  const host = parsed.port ? `${parsed.hostname}:${parsed.port}` : parsed.hostname;
  const path = `${parsed.pathname}${parsed.search}` || '/';
  const lines = [
    `GET ${path} HTTP/1.1`,
    `Host: ${host}`,
    'Upgrade: websocket',
    'Connection: Upgrade',
    `Sec-WebSocket-Key: ${key}`,
    'Sec-WebSocket-Version: 13',
  ];
  for (const [name, value] of Object.entries(headers)) {
    lines.push(`${name}: ${value}`);
  }
  return `${lines.join('\r\n')}\r\n\r\n`;
}

/** Encode one masked client frame. */
function encodeClientFrame(opcode, payload) {
  const length = payload.length;
  let header;
  if (length < 126) {
    header = Buffer.alloc(2);
    header[1] = 0x80 | length;
  } else if (length < 65536) {
    header = Buffer.alloc(4);
    header[1] = 0x80 | 126;
    header.writeUInt16BE(length, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 0x80 | 127;
    header.writeBigUInt64BE(BigInt(length), 2);
  }
  header[0] = 0x80 | opcode;
  const maskKey = crypto.randomBytes(4);
  const masked = Buffer.from(payload);
  for (let i = 0; i < masked.length; i += 1) {
    masked[i] ^= maskKey[i % 4];
  }
  return Buffer.concat([header, maskKey, masked]);
}

module.exports = { WebSocketClient, WebSocketError, encodeClientFrame, buildHandshake, MAX_FRAME_BYTES };
