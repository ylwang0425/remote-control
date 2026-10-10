'use strict';
/**
 * 4-byte little-endian length-prefixed JSON codec.
 *
 * Wire shape: `<uint32 LE payload length><utf8 JSON payload>`, one JSON object
 * per frame. This is the transport of the Codex app-tools named pipe
 * (`\\.\pipe\codex-browser-use-<uuid>`), and it is also reused internally
 * wherever a byte budget matters, so the limit is expressed in bytes.
 *
 * Errors always carry a stable `code`; callers branch on the code, never on the
 * message text.
 */

/** Relay WebSocket frame limit, protocol-v1 §8.2: 262144 bytes (256 KiB). */
const DEFAULT_MAX_FRAME_BYTES = 262144;

class FramingError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'FramingError';
    this.code = code;
  }
}

/**
 * Encode one JSON object as a length-prefixed frame.
 * @param {unknown} value value to serialise; must serialise to a JSON object
 * @param {{maxBytes?: number}} [options]
 * @returns {Buffer}
 */
function encodeFrame(value, options = {}) {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_FRAME_BYTES;
  const payload = Buffer.from(JSON.stringify(value), 'utf8');
  if (payload.length > maxBytes) {
    throw new FramingError('frame_too_large', `frame of ${payload.length} bytes exceeds the ${maxBytes} byte limit`);
  }
  const frame = Buffer.allocUnsafe(4 + payload.length);
  frame.writeUInt32LE(payload.length, 0);
  payload.copy(frame, 4);
  return frame;
}

/**
 * Incremental decoder for length-prefixed JSON frames.
 *
 * Feed arbitrary chunks; get back the JSON objects that are complete. Partial
 * frames stay buffered. A frame larger than `maxBytes` or one that is not a
 * JSON object throws, and `reset()` clears the buffer after a broken stream.
 */
class FrameDecoder {
  /** @param {{maxBytes?: number}} [options] */
  constructor(options = {}) {
    this.maxBytes = options.maxBytes ?? DEFAULT_MAX_FRAME_BYTES;
    this.buffer = Buffer.alloc(0);
  }

  /**
   * @param {Buffer} chunk
   * @returns {object[]} the JSON objects completed by this chunk
   */
  push(chunk) {
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
    const messages = [];
    while (this.buffer.length >= 4) {
      const length = this.buffer.readUInt32LE(0);
      if (length > this.maxBytes) {
        this.reset();
        throw new FramingError('frame_too_large', `frame of ${length} bytes exceeds the ${this.maxBytes} byte limit`);
      }
      if (this.buffer.length < length + 4) {
        break;
      }
      const payload = this.buffer.subarray(4, length + 4);
      this.buffer = this.buffer.subarray(length + 4);
      let parsed;
      try {
        parsed = JSON.parse(payload.toString('utf8'));
      } catch {
        this.reset();
        throw new FramingError('frame_not_json', 'frame payload is not valid JSON');
      }
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        this.reset();
        throw new FramingError('frame_not_json', 'frame payload is not a JSON object');
      }
      messages.push(parsed);
    }
    return messages;
  }

  /** Drop any buffered partial frame (after the stream broke and reconnected). */
  reset() {
    this.buffer = Buffer.alloc(0);
  }
}

module.exports = {
  DEFAULT_MAX_FRAME_BYTES,
  FramingError,
  encodeFrame,
  FrameDecoder,
};
