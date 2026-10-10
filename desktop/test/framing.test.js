'use strict';
/**
 * Tests for the 4-byte little-endian length-prefixed JSON codec.
 *
 * This is the transport the Codex app-tools named pipe speaks
 * (`<uint32 LE length><utf8 JSON>`), and the relay WebSocket frame limit is
 * expressed in bytes as well, so the codec is shared.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { encodeFrame, FrameDecoder, FramingError, DEFAULT_MAX_FRAME_BYTES } = require('../src/framing');

test('encodeFrame writes a 4-byte little-endian length prefix', () => {
  const frame = encodeFrame({ id: 1, jsonrpc: '2.0', method: 'tools/list' });
  const payload = JSON.stringify({ id: 1, jsonrpc: '2.0', method: 'tools/list' });
  assert.equal(frame.readUInt32LE(0), Buffer.byteLength(payload, 'utf8'));
  assert.equal(frame.length, 4 + Buffer.byteLength(payload, 'utf8'));
  assert.equal(frame.subarray(4).toString('utf8'), payload);
});

test('encodeFrame measures the length in bytes, not characters', () => {
  const frame = encodeFrame({ text: '中文消息' });
  const payload = Buffer.from(JSON.stringify({ text: '中文消息' }), 'utf8');
  assert.equal(frame.readUInt32LE(0), payload.length);
  assert.ok(payload.length > JSON.stringify({ text: '中文消息' }).length);
  assert.equal(frame.subarray(4).toString('utf8'), payload.toString('utf8'));
});

test('encodeFrame refuses a payload larger than the frame limit', () => {
  assert.throws(
    () => encodeFrame({ blob: 'x'.repeat(64) }, { maxBytes: 32 }),
    (err) => err instanceof FramingError && err.code === 'frame_too_large',
  );
});

test('FrameDecoder decodes two frames arriving in one chunk', () => {
  const decoder = new FrameDecoder();
  const a = encodeFrame({ id: 1 });
  const b = encodeFrame({ id: 2 });
  const messages = decoder.push(Buffer.concat([a, b]));
  assert.deepEqual(messages, [{ id: 1 }, { id: 2 }]);
});

test('FrameDecoder reassembles a frame split across chunks', () => {
  const decoder = new FrameDecoder();
  const frame = encodeFrame({ id: 7, result: { contentItems: [] } });
  const head = frame.subarray(0, 3);
  const mid = frame.subarray(3, 6);
  const tail = frame.subarray(6);
  assert.deepEqual(decoder.push(head), []);
  assert.deepEqual(decoder.push(mid), []);
  assert.deepEqual(decoder.push(tail), [{ id: 7, result: { contentItems: [] } }]);
});

test('FrameDecoder reports a frame whose length prefix exceeds the limit', () => {
  const decoder = new FrameDecoder({ maxBytes: 8 });
  const bogus = Buffer.alloc(4);
  bogus.writeUInt32LE(9, 0);
  assert.throws(() => decoder.push(bogus), (err) => err instanceof FramingError && err.code === 'frame_too_large');
});

test('FrameDecoder reports a frame that is not a JSON object', () => {
  const decoder = new FrameDecoder();
  const frame = encodeFrame('not-an-object');
  assert.throws(
    () => decoder.push(frame),
    (err) => err instanceof FramingError && err.code === 'frame_not_json',
  );
});

test('FrameDecoder drops half of a frame after a reset', () => {
  const decoder = new FrameDecoder();
  const frame = encodeFrame({ id: 3 });
  decoder.push(frame.subarray(0, 5));
  decoder.reset();
  assert.deepEqual(decoder.push(frame), [{ id: 3 }]);
});

test('the default frame limit is 256 KiB, the relay WebSocket limit', () => {
  assert.equal(DEFAULT_MAX_FRAME_BYTES, 262144);
});
