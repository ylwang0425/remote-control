'use strict';
/**
 * A minimal server-side WebSocket implementation for tests.
 *
 * It is written independently of `src/ws.js` (its own frame codec, its own
 * handshake check) so that a test using it is a real check of the client and not
 * a mirror of it. It implements exactly what the tests need: the HTTP upgrade,
 * text/ping/pong/close frames, fragmentation on write, and unmasked server
 * frames with masked client frames, as RFC 6455 requires.
 */

const crypto = require('node:crypto');
const http = require('node:http');
const { EventEmitter } = require('node:events');

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

function acceptKey(key) {
  return crypto.createHash('sha1').update(key + GUID).digest('base64');
}

/** Encode one server-to-client frame (never masked). */
function encodeServerFrame(opcode, payload = Buffer.alloc(0), { fin = true } = {}) {
  const length = payload.length;
  let header;
  if (length < 126) {
    header = Buffer.alloc(2);
    header[1] = length;
  } else if (length < 65536) {
    header = Buffer.alloc(4);
    header[1] = 126;
    header.writeUInt16BE(length, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(length), 2);
  }
  header[0] = (fin ? 0x80 : 0x00) | opcode;
  return Buffer.concat([header, payload]);
}

/** Incremental server-side frame reader. Client frames must be masked. */
class ServerFrameReader {
  constructor({ onFrame, onProtocolError }) {
    this.buffer = Buffer.alloc(0);
    this.onFrame = onFrame;
    this.onProtocolError = onProtocolError;
    this.fragments = [];
    this.fragmentOpcode = null;
  }

  push(chunk) {
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
      if (!masked) {
        this.onProtocolError('client frame was not masked');
        return;
      }
      if (this.buffer.length < offset + 4 + length) return;
      const maskKey = this.buffer.subarray(offset, offset + 4);
      const payload = Buffer.from(this.buffer.subarray(offset + 4, offset + 4 + length));
      for (let i = 0; i < payload.length; i += 1) {
        payload[i] ^= maskKey[i % 4];
      }
      this.buffer = this.buffer.subarray(offset + 4 + length);
      this.handleFrame({ fin, opcode, payload });
    }
  }

  handleFrame({ fin, opcode, payload }) {
    if (opcode === 0x0 || opcode === 0x1 || opcode === 0x2) {
      if (opcode !== 0x0) {
        this.fragmentOpcode = opcode;
      }
      this.fragments.push(payload);
      if (fin) {
        const full = Buffer.concat(this.fragments);
        const kind = this.fragmentOpcode;
        this.fragments = [];
        this.fragmentOpcode = null;
        this.onFrame({ opcode: kind, payload: full });
      }
      return;
    }
    this.onFrame({ opcode, payload });
  }
}

/**
 * Start a WebSocket test server.
 *
 * @param {object} options
 * @param {(req: http.IncomingMessage) => ({accept: boolean, headers?: object, statusCode?: number, body?: string, delayBeforeReplyMs?: number, rawReply?: string})} [options.onUpgrade]
 * @param {(peer: object, req: http.IncomingMessage) => void} [options.onConnection]
 * @returns {Promise<{port: number, url: string, path: string, connections: object[], requests: object[], close: () => Promise<void>}>}
 */
async function startWsServer(options = {}) {
  const requests = [];
  const connections = [];
  const server = http.createServer((req, res) => {
    res.writeHead(404);
    res.end('not a websocket endpoint');
  });

  server.on('upgrade', (req, socket, head) => {
    requests.push({ url: req.url, headers: req.headers });
    const decision = options.onUpgrade ? options.onUpgrade(req) : { accept: true };
    if (!decision.accept) {
      const status = decision.statusCode ?? 401;
      const body = decision.body ?? '';
      socket.write(
        `HTTP/1.1 ${status} ${status === 401 ? 'Unauthorized' : status === 403 ? 'Forbidden' : 'Error'}\r\n` +
          'Content-Type: application/json\r\n' +
          `Content-Length: ${Buffer.byteLength(body)}\r\n` +
          'Connection: close\r\n\r\n' +
          body,
      );
      socket.destroy();
      return;
    }
    const key = req.headers['sec-websocket-key'];
    const reply = () => {
      const headers = [
        'HTTP/1.1 101 Switching Protocols',
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Sec-WebSocket-Accept: ${decision.badAccept ? acceptKey('wrong-key') : acceptKey(key)}`,
      ];
      for (const [name, value] of Object.entries(decision.headers ?? {})) {
        headers.push(`${name}: ${value}`);
      }
      socket.write(`${headers.join('\r\n')}\r\n\r\n`);
      const peer = createPeer(socket);
      connections.push(peer);
      if (head && head.length > 0) {
        peer.reader.push(head);
      }
      if (options.onConnection) {
        options.onConnection(peer, req);
      }
    };
    if (decision.delayBeforeReplyMs) {
      setTimeout(reply, decision.delayBeforeReplyMs);
    } else {
      reply();
    }
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  return {
    port,
    path: '/bridge',
    url: `ws://127.0.0.1:${port}/bridge`,
    connections,
    requests,
    close: () =>
      new Promise((resolve) => {
        for (const peer of connections) {
          peer.socket.destroy();
        }
        server.close(() => resolve());
      }),
  };
}

function createPeer(socket) {
  const peer = new EventEmitter();
  peer.socket = socket;
  peer.closed = false;
  peer.receivedClose = false;
  peer.frames = [];
  peer.sendText = (text) => {
    peer.frames.push({ opcode: 0x1, text });
    socket.write(encodeServerFrame(0x1, Buffer.from(text, 'utf8')));
  };
  peer.sendBinary = (bytes) => {
    socket.write(encodeServerFrame(0x2, Buffer.from(bytes)));
  };
  peer.sendPing = (payload = Buffer.alloc(0)) => {
    socket.write(encodeServerFrame(0x9, payload));
  };
  peer.sendClose = (code = 1000, reason = '') => {
    const body = Buffer.alloc(2 + Buffer.byteLength(reason));
    body.writeUInt16BE(code, 0);
    body.write(reason, 2);
    socket.write(encodeServerFrame(0x8, body));
  };
  peer.sendRaw = (bytes) => {
    socket.write(bytes);
  };

  peer.reader = new ServerFrameReader({
    onFrame: ({ opcode, payload }) => {
      if (opcode === 0x1) {
        peer.emit('message', payload.toString('utf8'));
      } else if (opcode === 0x2) {
        peer.emit('message', payload);
      } else if (opcode === 0x8) {
        const code = payload.length >= 2 ? payload.readUInt16BE(0) : null;
        const reason = payload.length > 2 ? payload.subarray(2).toString('utf8') : '';
        peer.receivedClose = true;
        peer.closeCode = code;
        peer.closeReason = reason;
        // Echo the close, as a compliant endpoint does, unless we started it.
        if (!peer.closeSent) {
          peer.closeSent = true;
          socket.write(encodeServerFrame(0x8, payload.subarray(0, Math.min(2, payload.length))));
        }
        peer.emit('client-close', code, reason);
      } else if (opcode === 0x9) {
        socket.write(encodeServerFrame(0xa, payload));
      } else if (opcode === 0xa) {
        peer.emit('pong', payload);
      }
      peer.emit('frame', { opcode, payload });
    },
    onProtocolError: (message) => {
      peer.protocolError = message;
      socket.destroy();
    },
  });

  socket.on('data', (chunk) => peer.reader.push(chunk));
  socket.on('error', () => {});
  socket.on('close', () => {
    peer.closed = true;
    peer.emit('close', peer.closeCode ?? null, peer.closeReason ?? '');
  });
  return peer;
}

module.exports = { startWsServer, encodeServerFrame, ServerFrameReader, acceptKey };
