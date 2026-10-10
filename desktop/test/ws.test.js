'use strict';
/**
 * Tests for the dependency-free WebSocket client (protocol-v1 §8.1, §8.2).
 *
 * The peer in these tests is the independent server implementation in
 * `helpers/ws-server.js`, so a green run means a real RFC 6455 handshake and real
 * frames crossed a real TCP socket - not that a module agreed with itself.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { WebSocketClient, WebSocketError } = require('../src/ws');
const { startWsServer, encodeServerFrame } = require('./helpers/ws-server');

function once(emitter, event) {
  return new Promise((resolve) => emitter.once(event, (...args) => resolve(args)));
}

/** Start a server, connect a client to it, hand back both ends of the socket. */
async function connectedPair(t, options = {}) {
  let peer;
  const server = await startWsServer({
    ...options,
    onConnection: (p, req) => {
      peer = p;
      if (options.onConnection) options.onConnection(p, req);
    },
  });
  const client = new WebSocketClient(server.url, options.clientOptions);
  t.after(async () => {
    client.destroy();
    await server.close();
  });
  await client.connect();
  if (peer === undefined) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return { server, client, peer };
}

test('the handshake carries Authorization, no Origin, and the required upgrade headers', async (t) => {
  const server = await startWsServer();
  t.after(() => server.close());
  const client = new WebSocketClient(server.url, { headers: { Authorization: 'Bearer test-token' } });
  t.after(() => client.destroy());
  await client.connect();
  const [request] = server.requests;
  assert.equal(request.headers.authorization, 'Bearer test-token');
  assert.equal(request.headers.origin, undefined, 'protocol-v1 §8.1 forbids an Origin header');
  assert.equal(request.headers.upgrade, 'websocket');
  assert.equal(request.headers.connection, 'Upgrade');
  assert.equal(request.headers['sec-websocket-version'], '13');
  assert.ok(/^[A-Za-z0-9+/]{22}==$/.test(request.headers['sec-websocket-key']));
  assert.equal(request.url, '/bridge');
});

test('the handshake never puts the token in the URL query', async (t) => {
  const server = await startWsServer();
  t.after(() => server.close());
  const client = new WebSocketClient(server.url, { headers: { Authorization: 'Bearer super-secret' } });
  t.after(() => client.destroy());
  await client.connect();
  const [request] = server.requests;
  assert.ok(!request.url.includes('super-secret'), request.url);
  assert.ok(!request.url.includes('?'), request.url);
});

test('a text frame round-trips in both directions, including multi-byte text', async (t) => {
  const { client, peer } = await connectedPair(t);
  const received = once(peer, 'message');
  client.send('{"type":"hello","version":1}');
  assert.deepEqual(await received, ['{"type":"hello","version":1}']);

  const inbound = once(client, 'message');
  peer.sendText('{"type":"ping"}');
  assert.deepEqual(await inbound, ['{"type":"ping"}']);

  const unicode = once(peer, 'message');
  client.send('中文消息 🚀');
  assert.deepEqual(await unicode, ['中文消息 🚀']);
});

test('every client frame is masked, as RFC 6455 requires of a client', async (t) => {
  const { client, peer } = await connectedPair(t);
  const frame = once(peer, 'frame');
  client.send('{"type":"ping"}');
  const [received] = await frame;
  assert.equal(received.opcode, 0x1);
  assert.equal(peer.protocolError, undefined, 'the server rejects unmasked client frames');
});

test('a frame split across TCP chunks is reassembled', async (t) => {
  const { client, peer } = await connectedPair(t);
  const inbound = once(client, 'message');
  const frame = encodeServerFrame(0x1, Buffer.from('{"type":"hello.ok"}'));
  peer.sendRaw(frame.subarray(0, 3));
  await new Promise((resolve) => setTimeout(resolve, 20));
  peer.sendRaw(frame.subarray(3));
  assert.deepEqual(await inbound, ['{"type":"hello.ok"}']);
});

test('a fragmented text message is reassembled from continuation frames', async (t) => {
  const { client, peer } = await connectedPair(t);
  const inbound = once(client, 'message');
  peer.sendRaw(encodeServerFrame(0x1, Buffer.from('{"type":'), { fin: false }));
  peer.sendRaw(encodeServerFrame(0x0, Buffer.from('"hello.ok"}'), { fin: true }));
  assert.deepEqual(await inbound, ['{"type":"hello.ok"}']);
});

test('a server ping is answered with a pong carrying the same payload', async (t) => {
  const { peer } = await connectedPair(t);
  const pong = once(peer, 'pong');
  peer.sendPing(Buffer.from('hb'));
  const [payload] = await pong;
  assert.equal(payload.toString('utf8'), 'hb');
});

test('the close handshake surfaces code and reason, and echoes the close', async (t) => {
  const { client, peer } = await connectedPair(t);
  const clientSawClose = once(client, 'close');
  const serverSawEcho = once(peer, 'client-close');
  peer.sendClose(1001, 'going away');
  const [code, reason] = await clientSawClose;
  assert.equal(code, 1001);
  assert.equal(reason, 'going away');
  const [echoCode] = await serverSawEcho;
  assert.equal(echoCode, 1001, 'the client echoed the close code');
});

test('an HTTP 401 answer fails the handshake and reports the status code', async (t) => {
  const server = await startWsServer({
    onUpgrade: () => ({
      accept: false,
      statusCode: 401,
      body: '{"ok":false,"error":{"code":"unauthenticated","message":"invalid bridge token"}}',
    }),
  });
  t.after(() => server.close());
  const client = new WebSocketClient(server.url);
  t.after(() => client.destroy());
  const err = await client.connect().catch((e) => e);
  assert.ok(err instanceof WebSocketError);
  assert.equal(err.code, 'handshake_failed');
  assert.equal(err.statusCode, 401);
  assert.ok(err.body.includes('unauthenticated'));
});

test('a mismatched Sec-WebSocket-Accept is refused', async (t) => {
  const server = await startWsServer({ onUpgrade: () => ({ accept: true, badAccept: true }) });
  t.after(() => server.close());
  const client = new WebSocketClient(server.url);
  t.after(() => client.destroy());
  const err = await client.connect().catch((e) => e);
  assert.equal(err.code, 'bad_accept');
  await server.close();
});

test('a binary frame is a protocol error (protocol-v1 §8.2)', async (t) => {
  const { client, peer } = await connectedPair(t);
  const errored = once(client, 'error');
  peer.sendBinary(Buffer.from([1, 2, 3]));
  const [err] = await errored;
  assert.equal(err.code, 'protocol_error');
});

test('a frame larger than 256 KiB is refused with code frame_too_large', async (t) => {
  const { client, peer } = await connectedPair(t);
  const errored = once(client, 'error');
  peer.sendRaw(encodeBigHeader(300000));
  const [err] = await errored;
  assert.equal(err.code, 'frame_too_large');
});

test('the client refuses to send a frame larger than the limit', async (t) => {
  const { client } = await connectedPair(t);
  assert.throws(() => client.send('x'.repeat(262145)), (err) => err.code === 'frame_too_large');
});

test('sending on a closed client is refused instead of buffered forever', async (t) => {
  const { client } = await connectedPair(t);
  client.close();
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(client.send('{"type":"ping"}'), false);
});

test('a refused TCP connection reports a connect failure, not a hang', async (t) => {
  // Port 1 on loopback is not listening; the client must fail fast and cleanly.
  const client = new WebSocketClient('ws://127.0.0.1:1/bridge', { handshakeTimeoutMs: 2000 });
  t.after(() => client.destroy());
  const err = await client.connect().catch((e) => e);
  assert.equal(err.code, 'connect_failed');
});

function encodeBigHeader(length) {
  const header = Buffer.alloc(10);
  header[0] = 0x81;
  header[1] = 127;
  header.writeBigUInt64BE(BigInt(length), 2);
  return header;
}
