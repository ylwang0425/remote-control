'use strict';
/**
 * A real Windows named-pipe server speaking the Codex app-tools wire protocol,
 * for tests: 4-byte little-endian length prefix + JSON-RPC 2.0.
 *
 * It carries its own tiny codec (not `src/framing.js`) so a passing adapter test
 * proves that real bytes crossed a real pipe, instead of proving that two copies
 * of one implementation agree.
 */

const net = require('node:net');
const crypto = require('node:crypto');

function encode(value) {
  const payload = Buffer.from(JSON.stringify(value), 'utf8');
  const frame = Buffer.alloc(4 + payload.length);
  frame.writeUInt32LE(payload.length, 0);
  payload.copy(frame, 4);
  return frame;
}

class PipeServer {
  /**
   * @param {object} options
   * @param {object[]} [options.tools] what `tools/list` advertises
   * @param {Record<string, (args: object, params: object) => object>} [options.handlers]
   *        per-tool `tools/call` handlers returning `{success, contentItems}`
   */
  constructor(options = {}) {
    this.tools = options.tools ?? [];
    this.handlers = options.handlers ?? {};
    this.calls = [];
    this.pipePath = `\\\\.\\pipe\\codex-pipe-test-${crypto.randomUUID()}`;
    this.sockets = new Set();
    this.server = net.createServer((socket) => this.onConnection(socket));
  }

  listen() {
    return new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(this.pipePath, () => resolve(this));
    });
  }

  close() {
    return new Promise((resolve) => {
      for (const socket of this.sockets) socket.destroy();
      this.server.close(() => resolve());
    });
  }

  onConnection(socket) {
    this.sockets.add(socket);
    socket.on('error', () => {});
    socket.on('close', () => this.sockets.delete(socket));
    let buffer = Buffer.alloc(0);
    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 4) {
        const length = buffer.readUInt32LE(0);
        if (buffer.length < length + 4) break;
        const payload = buffer.subarray(4, length + 4);
        buffer = buffer.subarray(length + 4);
        let message;
        try {
          message = JSON.parse(payload.toString('utf8'));
        } catch {
          socket.destroy();
          return;
        }
        this.dispatch(socket, message);
      }
    });
  }

  dispatch(socket, message) {
    this.calls.push({ method: message.method, params: message.params });
    if (message.method === 'tools/list') {
      socket.write(encode({ id: message.id, jsonrpc: '2.0', result: { tools: this.tools } }));
      return;
    }
    if (message.method === 'tools/call') {
      const params = message.params ?? {};
      const handler = this.handlers[params.tool];
      if (handler === undefined) {
        socket.write(
          encode({
            id: message.id,
            jsonrpc: '2.0',
            result: { success: false, contentItems: [{ type: 'inputText', text: `unknown tool ${params.tool}` }] },
          }),
        );
        return;
      }
      const result = handler(params.arguments ?? {}, params, socket);
      if (result === null || result === undefined) {
        // The handler simulated a dying pipe: nothing is written back.
        return;
      }
      socket.write(encode({ id: message.id, jsonrpc: '2.0', result }));
      return;
    }
    socket.write(encode({ id: message.id, jsonrpc: '2.0', error: { code: -32601, message: 'method not found' } }));
  }
}

/** Wrap a value the way a real tool answer does: JSON inside a JSON string. */
function inner(value) {
  return { success: true, contentItems: [{ type: 'inputText', text: JSON.stringify(value) }] };
}

/** The subset of the live `codex_app` catalog this adapter cares about. */
const CODEX_APP_TOOLS = [
  { name: 'list_threads', namespace: 'codex_app', description: 'List threads', inputSchema: { type: 'object', properties: { limit: { type: 'number' } } } },
  { name: 'read_thread', namespace: 'codex_app', description: 'Read a thread', inputSchema: { type: 'object', properties: { threadId: { type: 'string' } } } },
  { name: 'send_message_to_thread', namespace: 'codex_app', description: 'Send a message', inputSchema: { type: 'object', properties: { threadId: { type: 'string' }, prompt: { type: 'string' } } } },
  { name: 'create_thread', namespace: 'codex_app', description: 'Create a thread', inputSchema: { type: 'object', properties: {} } },
];

/**
 * The live `list_projects` tool, kept out of {@link CODEX_APP_TOOLS} so the
 * tests that assert the exact catalog they open with stay unchanged.
 */
const LIST_PROJECTS_TOOL = { name: 'list_projects', namespace: 'codex_app', description: 'List projects', inputSchema: { type: 'object', properties: {} } };

/**
 * The real model/thinking part of `send_message_to_thread`'s schema.
 *
 * Copied from the live pipe read-only on 2026-10-09
 * (`docs/evidence/send-model-schema-20261009.log`): the send tool carries its own
 * `model` (ids and reasoning efforts in the description) and `thinking`
 * properties, so "can this tool send with a model" is a fact of that schema and
 * not something to assume from `create_thread`.
 */
const SEND_MODEL_DESCRIPTION =
  'Optional model override. Models and supported reasoning efforts on the calling host: gpt-6.1-sol (Latest workhorse model for coding and everyday work.; supported reasoning efforts: low, medium, high, xhigh, max, ultra), gpt-6-luna (Fast and affordable model for easier tasks.; supported reasoning efforts: low, medium, high, xhigh, max).';

const SEND_WITH_MODEL_TOOL = {
  name: 'send_message_to_thread',
  namespace: 'codex_app',
  description: 'Send a message',
  inputSchema: {
    type: 'object',
    properties: {
      threadId: { type: 'string' },
      prompt: { type: 'string' },
      model: { type: 'string', description: SEND_MODEL_DESCRIPTION },
      thinking: { type: 'string', enum: ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'] },
    },
  },
};

module.exports = {
  PipeServer,
  inner,
  encode,
  CODEX_APP_TOOLS,
  LIST_PROJECTS_TOOL,
  SEND_MODEL_DESCRIPTION,
  SEND_WITH_MODEL_TOOL,
};
