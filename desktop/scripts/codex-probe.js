'use strict';
/**
 * Read-only probe for the Codex Desktop app-tools named pipe.
 *
 * It discovers the live pipe, lists the tools the pipe advertises, and then runs
 * `list_threads` / `read_thread` **read-only**, printing counts, field names and
 * id prefixes. It never prints message text: this tool exists so a human can see
 * that the takeover path is real without user content ending up in a log, a
 * report or a ZIP.
 *
 * Usage:
 *   node scripts/codex-probe.js                  # discover, list tools, count threads
 *   node scripts/codex-probe.js --read <id>      # also read one thread (counts only)
 *   node scripts/codex-probe.js --pipe \\.\pipe\codex-browser-use-...
 */

const net = require('node:net');
const fs = require('node:fs');
const crypto = require('node:crypto');

const { FrameDecoder, encodeFrame, DEFAULT_MAX_FRAME_BYTES } = require('../src/framing');

/** The Codex app-tools pipe allows 8 MiB frames (server.mjs MAX_FRAME_BYTES). */
const PIPE_MAX_FRAME_BYTES = 8 * 1024 * 1024;

function listPipeNames() {
  if (process.platform !== 'win32') {
    return [];
  }
  return fs.readdirSync('\\\\.\\pipe\\');
}

function discoverPipes(pipes = listPipeNames()) {
  return pipes.filter((name) => name.startsWith('codex-browser-use-')).sort();
}

/**
 * One JSON-RPC request over a length-prefixed pipe.
 * @returns {Promise<unknown>} the `result` field
 */
function callPipe(pipePath, method, params, { timeoutMs = 15000, id = 1 } = {}) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(pipePath);
    const decoder = new FrameDecoder({ maxBytes: PIPE_MAX_FRAME_BYTES });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`${method} timed out after ${timeoutMs} ms`));
    }, timeoutMs);
    const finish = (fn, value) => {
      clearTimeout(timer);
      socket.destroy();
      fn(value);
    };
    socket.once('error', (error) => finish(reject, error));
    socket.once('connect', () => {
      socket.write(encodeFrame({ id, jsonrpc: '2.0', method, params }, { maxBytes: PIPE_MAX_FRAME_BYTES }));
    });
    socket.on('data', (chunk) => {
      let messages;
      try {
        messages = decoder.push(chunk);
      } catch (error) {
        finish(reject, error);
        return;
      }
      for (const message of messages) {
        if (message.id !== id) continue;
        if (message.error) {
          finish(reject, new Error(`${method} failed: ${message.error.message}`));
        } else {
          finish(resolve, message.result);
        }
      }
    });
  });
}

function toolCallParams({ namespace, tool, args, threadId }) {
  return {
    arguments: args,
    callerSource: 'codex',
    callId: crypto.randomUUID(),
    namespace,
    threadId,
    tool,
    turnId: crypto.randomUUID(),
  };
}

/** The inner `contentItems[0].text` is a JSON string: parse it a second time. */
function parseInnerResult(result) {
  if (result === null || typeof result !== 'object') {
    throw new Error('tools/call returned no object');
  }
  const items = Array.isArray(result.contentItems) ? result.contentItems : [];
  const textItem = items.find((item) => item && item.type === 'inputText');
  if (textItem === undefined) {
    return { value: null, itemTypes: items.map((item) => item && item.type) };
  }
  try {
    return { value: JSON.parse(textItem.text), itemTypes: items.map((item) => item && item.type) };
  } catch {
    // A failed tool call answers with a plain sentence, not with JSON.
    return { value: null, text: String(textItem.text).slice(0, 120), itemTypes: items.map((item) => item && item.type) };
  }
}

/** `list_threads` accepts only a small `limit`; find what really works. */
async function probeListThreads(pipePath, contextThreadId) {
  const attempts = [{ limit: 10 }, { limit: 50 }, { limit: 100 }, {}];
  for (const args of attempts) {
    const response = await callPipe(
      pipePath,
      'tools/call',
      toolCallParams({ namespace: 'codex_app', tool: 'list_threads', args, threadId: contextThreadId }),
    );
    const inner = parseInnerResult(response);
    const threads = Array.isArray(inner.value?.threads) ? inner.value.threads : [];
    console.log(
      `tools/call list_threads args=${JSON.stringify(args)} -> success=${response.success} threads=${threads.length}` +
        (inner.text !== undefined ? ` text=${inner.text}` : ''),
    );
    if (response.success && threads.length > 0) {
      return { args, threads, inner };
    }
  }
  return { args: null, threads: [], inner: { value: null } };
}

function describe(value, depth = 0) {
  if (Array.isArray(value)) {
    return `array(${value.length})`;
  }
  if (value === null) return 'null';
  if (typeof value === 'object') {
    return `object{${Object.keys(value).join(',')}}`;
  }
  return typeof value;
}

async function main() {
  const argv = process.argv.slice(2);
  const pipeArg = argv.includes('--pipe') ? argv[argv.indexOf('--pipe') + 1] : null;
  const readArg = argv.includes('--read') ? argv[argv.indexOf('--read') + 1] : null;
  const threadId = readArg ?? process.env.CODEX_THREAD_ID ?? process.env.CODEX_SESSION_ID ?? null;

  const discovered = discoverPipes();
  const envPipe = process.env.CODEX_APP_TOOLS_PIPE_PATH ?? null;
  console.log(`discovered codex pipes: ${discovered.length}`);
  for (const name of discovered) {
    console.log(`  \\\\.\\pipe\\${name}${envPipe === `\\\\.\\pipe\\${name}` ? '  <- CODEX_APP_TOOLS_PIPE_PATH' : ''}`);
  }
  const pipePath = pipeArg ?? envPipe ?? (discovered.length > 0 ? `\\\\.\\pipe\\${discovered[0]}` : null);
  if (pipePath === null) {
    console.error('no codex app-tools pipe found');
    process.exit(2);
  }
  console.log(`using pipe: ${pipePath}`);

  const toolsResult = await callPipe(pipePath, 'tools/list', { threadStartKind: 'all' });
  const tools = Array.isArray(toolsResult?.tools) ? toolsResult.tools : [];
  console.log(`tools/list -> ${tools.length} tools`);
  for (const tool of tools) {
    console.log(`  namespace=${tool.namespace} tool=${tool.name} params=${describe(tool.inputSchema?.properties ?? {})}`);
  }

  const codexTools = tools.filter((tool) => tool.namespace === 'codex_app');
  if (codexTools.length === 0) {
    console.error('the pipe advertises no codex_app tools');
    process.exit(3);
  }

  const listed = await probeListThreads(pipePath, threadId);
  const threadArray = listed.threads;
  console.log(`  accepted args: ${JSON.stringify(listed.args)}`);
  console.log(`  inner shape: ${describe(listed.inner.value)}`);
  console.log(`  threads counted: ${threadArray.length}`);
  if (threadArray.length > 0) {
    const first = threadArray[0];
    console.log(`  first thread fields: ${Object.keys(first).join(',')}`);
    const id = first.id ?? first.threadId ?? first.thread_id;
    console.log(`  first thread id prefix: ${String(id).slice(0, 8)}…`);
    const statuses = new Map();
    for (const thread of threadArray) {
      const status = String(thread.status ?? 'unknown');
      statuses.set(status, (statuses.get(status) ?? 0) + 1);
    }
    console.log(`  thread statuses: ${[...statuses].map(([s, n]) => `${s}=${n}`).join(' ')}`);
  }

  if (threadId !== null && argv.includes('--read')) {
    const readThread = await callPipe(
      pipePath,
      'tools/call',
      toolCallParams({ namespace: 'codex_app', tool: 'read_thread', args: { threadId }, threadId }),
    );
    console.log(`tools/call read_thread -> success=${readThread.success}`);
    const read = parseInnerResult(readThread);
    console.log(`  inner shape: ${describe(read.value)}`);
    const thread = read.value?.thread ?? null;
    if (thread !== null) {
      console.log(`  thread fields: ${Object.keys(thread).join(',')}`);
      console.log(`  thread id prefix: ${String(thread.id ?? threadId).slice(0, 8)}…`);
      console.log(`  thread title present: ${typeof thread.title === 'string' && thread.title.length > 0}`);
    }
    console.log(`  page: ${describe(read.value?.page)}`);
    const turns = Array.isArray(read.value?.turns) ? read.value.turns : [];
    console.log(`  turns counted: ${turns.length}`);
    if (turns.length > 0) {
      console.log(`  first turn fields: ${Object.keys(turns[0]).join(',')}`);
      const itemTypes = new Map();
      let items = 0;
      for (const turn of turns) {
        const candidates = Array.isArray(turn.items) ? turn.items : Array.isArray(turn.messages) ? turn.messages : [];
        for (const item of candidates) {
          items += 1;
          const kind = String(item.type ?? item.role ?? 'unknown');
          itemTypes.set(kind, (itemTypes.get(kind) ?? 0) + 1);
        }
      }
      console.log(`  items counted: ${items} by type: ${[...itemTypes].map(([t, n]) => `${t}=${n}`).join(' ')}`);
      const keysByType = new Map();
      for (const turn of turns) {
        const candidates = Array.isArray(turn.items) ? turn.items : [];
        for (const item of candidates) {
          const kind = String(item.type ?? 'unknown');
          if (!keysByType.has(kind)) {
            keysByType.set(kind, Object.keys(item).join(','));
          }
        }
      }
      for (const [kind, keys] of keysByType) {
        console.log(`  item fields ${kind}: ${keys}`);
      }
      console.log(`  turn statuses: ${[...new Set(turns.map((turn) => String(turn.status)))].join(',')}`);
    }
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`probe failed: ${error.message}`);
    process.exit(1);
  });
}

module.exports = { listPipeNames, discoverPipes, callPipe, toolCallParams, parseInnerResult, PIPE_MAX_FRAME_BYTES };
