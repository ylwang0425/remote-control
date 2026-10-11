'use strict';
/**
 * Codex Desktop adapter: take over the chats in the Codex Desktop app that is
 * already open.
 *
 * Why a named pipe: on Windows the codex daemon is Unix-only, so starting a new
 * CLI or a new app-server would not be "the app the user is looking at". The
 * running app does expose a real channel though - the app-tools pipe
 * `\\.\pipe\codex-browser-use-<uuid>` - whose transport is a 4-byte
 * little-endian length prefix plus JSON-RPC 2.0, and whose `tools/list` names the
 * `codex_app` tools that operate on the app's own threads.
 *
 * Verified read-only against the live pipe on this machine (see
 * `docs/evidence/codex-probe-20261008.log`): 11 pipes found by scanning, 53
 * `codex_app` tools advertised, `list_threads` returning real threads and
 * `read_thread` returning turns and items. The tool answer arrives as JSON inside
 * a JSON string (`contentItems[0].text`), so every answer is parsed twice.
 *
 * What is deliberately absent: any stop path. The live catalog has no
 * interrupt/cancel/stop tool, so `stopSession` answers `not_capable` instead of
 * pretending, and the capability goes out as false.
 */

const fs = require('node:fs');
const net = require('node:net');
const crypto = require('node:crypto');

const { FrameDecoder, encodeFrame } = require('../framing');
const { BridgeError, safeMessage } = require('../errors');
const { toRfc3339 } = require('../protocol');
const { resolveCodexContext } = require('../codex-context');

/** server.mjs `MAX_FRAME_BYTES`: the app-tools pipe allows 8 MiB frames. */
const PIPE_MAX_FRAME_BYTES = 8 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 15000;
const PIPE_NAME_PREFIX = 'codex-browser-use-';
const CODEX_NAMESPACE = 'codex_app';

/** Tools this adapter needs, and what each one buys. */
const TOOL_LIST_THREADS = 'list_threads';
const TOOL_READ_THREAD = 'read_thread';
const TOOL_SEND_MESSAGE = 'send_message_to_thread';
const TOOL_LIST_PROJECTS = 'list_projects';

/** Never sent: a fork or a cloud target is not "a new chat in this app". */
const FORBIDDEN_TOOLS = new Set(['fork_thread', 'create_side_thread', 'handoff_thread']);

/**
 * The one entry point allowed to call `create_thread`.
 *
 * `create_thread` used to be on the forbidden list, because an earlier round of
 * this job only asked to take over chats that already existed. The user has since
 * asked for a "new chat" button, and `create_thread` **is** the desktop app's own
 * way to make one: it lands in the running Codex Desktop, not in a CLI or an
 * app-server started on the side. It is called from `session.create` only.
 */
const CREATE_THREAD_TOOL = 'create_thread';

/**
 * Parse the model catalog out of the live `create_thread.model` description.
 *
 * The schema does not use an `enum`; the real, host-specific model ids and their
 * reasoning efforts are written into the field's description text, like:
 *   `gpt-6.1-sol (Latest workhorse model for coding and everyday work.;
 *    supported reasoning efforts: low, medium, high, xhigh, max, ultra)`
 * Reading them from there is the only honest source: a hard-coded list would be
 * wrong the moment the host supports a different set.
 * @param {string} description
 * @returns {{id: string, label: string, reasoningEfforts: string[]}[]}
 */
function parseModelCatalog(description) {
  if (typeof description !== 'string' || description.length === 0) return [];
  const models = [];
  const pattern = /([A-Za-z0-9._-]+)\s*\(([^()]*?)\)/g;
  let match = pattern.exec(description);
  while (match !== null) {
    const id = match[1];
    const detail = match[2];
    const efforts = /supported reasoning efforts:\s*([^)]+)/i.exec(detail);
    const label = detail.split(';')[0].trim();
    models.push({
      id,
      label: label.length > 0 ? label : id,
      reasoningEfforts:
        efforts === null
          ? []
          : efforts[1]
              .split(',')
              .map((effort) => effort.trim())
              .filter((effort) => effort.length > 0),
    });
    match = pattern.exec(description);
  }
  return models;
}

/**
 * The model catalog one tool's own schema documents.
 *
 * Both `create_thread` and `send_message_to_thread` write the host's real model
 * ids and their reasoning efforts into their `model` property description
 * (read-only 2026-10-09, `docs/evidence/send-model-schema-20261009.log`). Nothing
 * is hard-coded: the shape of the answer decides which models exist, so a host
 * with a different set is never told it has models it does not have.
 * @param {object|undefined} tool
 * @returns {{id: string, label: string, reasoningEfforts: string[]}[]}
 */
function catalogOfTool(tool) {
  return parseModelCatalog(tool?.inputSchema?.properties?.model?.description ?? '');
}

/** The reasoning efforts a tool's schema itself allows, from its `thinking` enum. */
function thinkingEffortsOf(tool) {
  const values = tool?.inputSchema?.properties?.thinking?.enum;
  return Array.isArray(values) ? values.map(String) : [];
}

/** Thread and turn statuses the live app really uses, mapped to §4.3 values. */
const WORKING_STATUSES = new Set(['active', 'working', 'inProgress', 'running', 'busy']);
const IDLE_STATUSES = new Set(['idle', 'notLoaded', 'ready', 'completed', 'complete', 'done']);
const STOPPED_STATUSES = new Set(['stopped', 'cancelled', 'canceled', 'interrupted', 'aborted']);
const ERROR_STATUSES = new Set(['error', 'failed', 'failure']);

/** `list_threads` refuses large limits; 10 is what the live pipe accepted. */
const LIST_THREADS_LIMIT = 10;

/**
 * Thread kinds that live on this computer, and can therefore be continued.
 *
 * The live pipe reports `kind: 'codex'` for an ordinary local thread (with
 * `hostId: 'local'` and a real `cwd`), and `'worktree'`/`'local'` are the other
 * kinds observed in the same catalog.
 */
const LOCAL_THREAD_KINDS = new Set(['codex', 'local', 'worktree', 'workspace']);
/** Sources that are not this app's local threads. */
const REMOTE_SOURCES = new Set(['chatgpt', 'cloud', 'remote', 'hosted']);

function threadArray(value) {
  return Array.isArray(value) ? value : [];
}

/**
 * Whether one `list_threads` entry is a thread this computer really owns.
 *
 * The rule is deliberately an **explicit rejection list**, not an allow list:
 * only a thread the app itself marks as cloud/ChatGPT is dropped, and everything
 * else - including a **projectless** chat, an unknown `kind`, a worktree, or a
 * thread whose `cwd` is null - is kept. An allow list here would silently hide
 * exactly the chats a user just created, which is what happened when a
 * brand-new projectless chat came back with a kind the list did not know.
 * @param {object} thread
 */
function isLocalCodexThread(thread) {
  if (thread === null || typeof thread !== 'object') return false;
  const source = String(thread.source ?? '').toLowerCase();
  if (REMOTE_SOURCES.has(source)) return false;
  const kind = String(thread.kind ?? '').toLowerCase();
  if (REMOTE_SOURCES.has(kind)) return false;
  const hostId = String(thread.hostId ?? '').toLowerCase();
  if (hostId !== '' && hostId !== 'local') return false;
  return true;
}

function listPipeNames() {
  if (process.platform !== 'win32') {
    return [];
  }
  try {
    return fs.readdirSync('\\\\.\\pipe\\');
  } catch {
    return [];
  }
}

/** @param {string[]} pipes raw pipe names (no `\\.\pipe\` prefix) */
function discoverCodexPipes(pipes = listPipeNames()) {
  return pipes.filter((name) => name.startsWith(PIPE_NAME_PREFIX)).sort();
}

/**
 * Which pipe to use: an explicitly configured one first, then the environment
 * variable a Codex-launched child process inherits, then the discovered list.
 * The configured path always wins, so a user can pin the app they mean.
 *
 * Note: the production path does not call this any more - `openCodexAdapter`
 * probes every candidate with a real `tools/list` instead of trusting the first
 * name - but the ordering rule is kept here because it is what tools and tests
 * use to reason about preference.
 * @param {{configuredPath?: string|null, envPath?: string|null, discovered: string[]}} input
 * @returns {string|null}
 */
function pickPipe({ configuredPath = null, envPath = null, discovered = [] } = {}) {
  if (configuredPath !== null && configuredPath !== '') return configuredPath;
  if (envPath !== null && envPath !== '') return envPath;
  if (discovered.length > 0) return `\\\\.\\pipe\\${discovered[0]}`;
  return null;
}

/** `active`/`inProgress`/... -> the four statuses protocol-v1 §4.3 allows.
 *  The live pipe reports a plain string in `list_threads` and an object such as
 *  `{type:'idle'}` in `read_thread`, so both shapes are accepted. */
function mapThreadStatus(status) {
  const raw = status !== null && typeof status === 'object' ? status.type ?? status.status ?? status.kind : status;
  const value = String(raw ?? '');
  if (WORKING_STATUSES.has(value)) return 'working';
  if (STOPPED_STATUSES.has(value)) return 'stopped';
  if (ERROR_STATUSES.has(value)) return 'error';
  if (IDLE_STATUSES.has(value)) return 'idle';
  return 'idle';
}

/**
 * Whatever the app hands us -> RFC3339 UTC (§4.2).
 *
 * The app-server reports timestamps as **seconds** since the epoch
 * (`1791436406`), while other fields in the same answer are milliseconds. A bare
 * number is therefore read as seconds unless it is too large to be one: treating
 * a seconds value as milliseconds puts every Codex thread in 1970 and, because
 * `sessions.list` sorts newest first and caps at 200, would push every Codex
 * thread out of the list entirely.
 */
function toTimestamp(value, fallback = new Date()) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    const milliseconds = value > 1e12 ? value : value * 1000;
    const parsed = new Date(milliseconds);
    return toRfc3339(Number.isNaN(parsed.getTime()) ? fallback : parsed);
  }
  if (typeof value === 'string' && value.length > 0) {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) {
      return toRfc3339(parsed);
    }
    // A numeric string is the same problem in a different costume.
    const asNumber = Number(value);
    if (Number.isFinite(asNumber) && value.trim() !== '') {
      return toRfc3339(new Date(asNumber > 1e12 ? asNumber : asNumber * 1000));
    }
  }
  return toRfc3339(fallback);
}

/** The `content` of a user message may be a string or a list of parts. */
function contentToText(content) {
  if (typeof content === 'string') {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .map((part) => (typeof part === 'string' ? part : typeof part?.text === 'string' ? part.text : ''))
      .filter((text) => text.length > 0)
      .join('\n');
  }
  if (content !== null && typeof content === 'object' && typeof content.text === 'string') {
    return content.text;
  }
  return '';
}

function changePaths(changes) {
  if (!Array.isArray(changes)) return [];
  return changes.map((change) => String(change?.path ?? change?.file ?? '?')).filter((path) => path.length > 0);
}

/**
 * One turn item -> the text the phone shows. Tool items become a short, honest
 * line (what ran, and how it ended) rather than a dump of raw arguments: the
 * arguments can carry secrets that have no business in a transcript.
 */
function itemToText(item) {
  switch (item.type) {
    case 'userMessage':
      return contentToText(item.content);
    case 'agentMessage':
      return String(item.text ?? '');
    case 'reasoning':
      return String(item.summary ?? '');
    case 'commandExecution': {
      const exit = item.exitCode === undefined || item.exitCode === null ? '' : ` (exit ${item.exitCode})`;
      return `${String(item.command ?? '')}${exit}`;
    }
    case 'mcpToolCall':
      return `${String(item.server ?? '')}.${String(item.tool ?? '')} (${String(item.status ?? 'unknown')})`;
    case 'fileChange':
      return `${String(item.status ?? 'changed')}: ${changePaths(item.changes).join(', ')}`;
    case 'webSearch':
      return String(item.query ?? '');
    case 'functionCallOutput': {
      // A tool call's own output. A known delegation wrapper never reaches here
      // (it was promoted to the user's message); anything else stays folded to
      // what ran and whether its output was complete - the raw text could be
      // arbitrary, and it is not a user's words.
      const truncated = item.output !== null && typeof item.output === 'object' && item.output.truncated === true;
      const name = String(item.name ?? 'tool');
      return `${name} output${truncated ? ' (truncated)' : ''}`;
    }
    default:
      return `[${String(item.type ?? 'item')}]`;
  }
}

const ITEM_ROLES = {
  userMessage: 'user',
  agentMessage: 'assistant',
  reasoning: 'assistant',
  commandExecution: 'tool',
  mcpToolCall: 'tool',
  fileChange: 'tool',
  webSearch: 'tool',
  plan: 'system',
  error: 'system',
  system: 'system',
};

/**
 * How many recent turns one `read_thread` asks for.
 *
 * The native default is a single turn (`turnLimit` omitted -> 1 on this host),
 * which is why a phone conversation lost every earlier message the moment the
 * next answer arrived. The count is explicit and bounded, and 10 is also the
 * **hard native maximum**: the live schema rejects anything larger with
 * "turnLimit: Too big: expected number to be <=10" (read-only verified against
 * the app-tools pipe), so a bigger number would break every read instead of
 * showing more. The phone shows at most `MAX_MESSAGES` messages anyway.
 */
const READ_TURN_LIMIT = 10;

/**
 * The output cap one `read_thread` asks for, in characters per item.
 *
 * `includeOutputs` is what makes a phone-created prompt readable at all - the
 * prompt travels as a `functionCallOutput` item's text and is absent without it
 * - so the text is bounded here and truncated answers are refused below rather
 * than shown as if they were whole.
 */
const MAX_OUTPUT_CHARS_PER_ITEM = 3000;

/**
 * The native namespace and tool names whose `functionCallOutput` really carries
 * a prompt a person typed.
 *
 * On this host a chat started from the phone lands in Codex as a *tool call*:
 * the native item is `{type:'functionCallOutput', namespace:'codex_app',
 * name:'create_thread', output:{text:'<codex_delegation>...'}}`. Without this
 * promotion the item became an opaque `[functionCallOutput]` system group and
 * the user's own words never reached the phone. The match is deliberately exact
 * on all three fields: an unknown tool that happens to return text is tool
 * output, not a user message.
 */
const DELEGATION_NAMESPACE = 'codex_app';
const DELEGATION_TOOLS = new Set([CREATE_THREAD_TOOL, TOOL_SEND_MESSAGE]);
const DELEGATION_OPEN_TAG = '<codex_delegation>';
const DELEGATION_CLOSE_TAG = '</codex_delegation>';

/** Whether a turn list is oldest-first, from the page order the app reports. */
function isOldestFirstOrder(pageOrder) {
  if (typeof pageOrder !== 'string' || pageOrder.length === 0) {
    // No page metadata: the legacy fixtures (and older hosts) sent turns
    // oldest-first, so nothing is reordered unless the app says otherwise.
    return true;
  }
  const value = pageOrder.toLowerCase();
  if (value.includes('newest')) return false;
  return true;
}

/** The text of one `functionCallOutput` item, or null when it carries none. */
function functionCallOutputText(item) {
  const output = item?.output;
  if (typeof output === 'string') return output;
  if (output !== null && typeof output === 'object' && typeof output.text === 'string') {
    return output.text;
  }
  return null;
}

/**
 * The prompt a known delegation call carries, or null when this item is not one.
 *
 * The wrapper's text is XML-like and the prompt inside it may contain anything -
 * markdown, literal angle tags, even a nested closing tag - so the boundary is
 * the **whole wrapper**: the payload is everything between an opening tag at the
 * very start and a closing tag at the very end. Nothing is parsed out of the
 * middle, so no prompt is ever cut short at an inner `</input>`, and no
 * `source_thread_id` - which names the session that *asked* for the delegation,
 * not anything the user typed - is ever put into a message.
 *
 * A truncated output is refused: the app itself says the text is incomplete, so
 * promoting it would show a half prompt as if the user had sent it.
 * @param {object} item
 * @returns {string|null}
 */
function delegationPrompt(item) {
  if (item?.type !== 'functionCallOutput') return null;
  if (String(item?.namespace ?? '') !== DELEGATION_NAMESPACE) return null;
  if (!DELEGATION_TOOLS.has(String(item?.name ?? ''))) return null;
  if (item?.output !== null && typeof item?.output === 'object' && item.output.truncated === true) {
    return null;
  }
  const text = functionCallOutputText(item);
  if (text === null) return null;
  const body = text.trim();
  if (!body.startsWith(DELEGATION_OPEN_TAG) || !body.endsWith(DELEGATION_CLOSE_TAG)) return null;
  const inner = body.slice(DELEGATION_OPEN_TAG.length, body.length - DELEGATION_CLOSE_TAG.length);
  const open = inner.indexOf('<input>');
  const close = inner.lastIndexOf('</input>');
  if (open === -1 || close === -1 || close < open) return null;
  const input = inner.slice(open + '<input>'.length, close);
  return input.trim().length === 0 ? null : input;
}

/**
 * Whether an item's rendered text says nothing at all.
 *
 * `read_thread` really does hand back items with no words in them, seen on the
 * live pipe: a `reasoning` item whose `summary` is `''`, and an `agentMessage`
 * placeholder that is still in progress and carries no `text` yet. Rendered
 * as-is they became visible transcript bubbles holding only the app's own
 * "AI" label and a timestamp, and - because `sessions.read` keeps only the
 * newest 200 messages - they also spent the frame budget that real messages
 * need. A message with no characters of its own is therefore not a message.
 *
 * Only text that is entirely empty once trimmed is dropped; anything holding a
 * character (a single symbol, an emoji, a space inside a sentence) is kept
 * exactly as it was rendered.
 * @param {unknown} text
 */
function isBlankText(text) {
  return String(text).trim().length === 0;
}

/**
 * Flatten turns and items into protocol messages, oldest first. Ids come from
 * the app's own item ids, so the same message keeps the same id across reads and
 * the phone can de-duplicate.
 *
 * Three native facts are handled here, all observed on the live pipe:
 * - the page carries `order: 'newest_first'`, so the turn list arrives backwards
 *   relative to a transcript and is re-ordered before anything is emitted;
 * - a prompt a person typed through this bridge arrives as a known
 *   `functionCallOutput` wrapper, which is promoted to a real `user` message
 *   (see {@link delegationPrompt}). Anything else stays what it is: tool output
 *   folded to a short line, never a fabricated user message;
 * - an item whose rendered text is entirely empty - an empty reasoning summary,
 *   an in-progress `agentMessage` placeholder - is skipped rather than emitted
 *   as a blank bubble (see {@link isBlankText}). Every message that does have
 *   text keeps its native id, its role, and its place in the order.
 * @param {object[]} turns
 * @param {{pageOrder?: string|null}} [options]
 */
function itemsToMessages(turns, options = {}) {
  const list = Array.isArray(turns) ? [...turns] : [];
  if (!isOldestFirstOrder(options.pageOrder)) {
    list.reverse();
  }
  const messages = [];
  for (const turn of list) {
    const at = toTimestamp(turn?.startedAt ?? turn?.completedAt ?? null);
    for (const item of Array.isArray(turn?.items) ? turn.items : []) {
      const id = String(item?.id ?? `${turn?.id ?? 'turn'}-${messages.length}`);
      const userText = delegationPrompt(item);
      if (userText !== null) {
        messages.push({ id, role: 'user', text: userText, timestamp: at });
        continue;
      }
      const role = ITEM_ROLES[item?.type] ?? 'system';
      const text = itemToText(item ?? {});
      // A blank item is not a message: no bubble, and no 200-message budget.
      if (isBlankText(text)) continue;
      messages.push({
        id,
        role,
        text,
        timestamp: at,
      });
    }
  }
  return messages;
}

/**
 * A JSON-RPC client for one Codex app-tools pipe. One request in flight per id,
 * one socket, no retries: a retry would post a message twice.
 */
class CodexPipeClient {
  /** @param {{pipePath: string, timeoutMs?: number, maxFrameBytes?: number}} options */
  constructor(options) {
    this.pipePath = options.pipePath;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxFrameBytes = options.maxFrameBytes ?? PIPE_MAX_FRAME_BYTES;
    this.socket = null;
    this.nextId = 1;
    this.pending = new Map();
    this.decoder = new FrameDecoder({ maxBytes: this.maxFrameBytes });
  }

  connect() {
    if (this.socket !== null && !this.socket.destroyed) {
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      const socket = net.createConnection(this.pipePath);
      const onError = (error) => {
        socket.destroy();
        reject(new BridgeError('bridge_error', `codex pipe is not reachable (${error.code ?? 'error'})`));
      };
      socket.once('error', onError);
      socket.once('connect', () => {
        socket.off('error', onError);
        socket.on('error', () => this.failAll(new BridgeError('bridge_error', 'codex pipe failed')));
        this.socket = socket;
        this.decoder.reset();
        socket.on('data', (chunk) => this.onData(chunk));
        socket.on('close', () => this.failAll(new BridgeError('bridge_error', 'codex pipe closed')));
        resolve();
      });
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
      const entry = this.pending.get(message.id);
      if (entry === undefined) continue;
      this.pending.delete(message.id);
      clearTimeout(entry.timer);
      if (message.error !== undefined) {
        // Keep the app's own reason, sanitised and length-capped: a bare "failed"
        // would make a broken pipe impossible to diagnose.
        entry.reject(new BridgeError('bridge_error', `codex ${entry.method} failed: ${safeMessage(message.error.message)}`));
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

  /**
   * One JSON-RPC request. Sends exactly once, even when the answer never comes.
   * @param {string} method
   * @param {object} [params]
   * @param {{timeoutMs?: number}} [options] per-call deadline override (probing)
   */
  async request(method, params, options = {}) {
    await this.connect();
    const id = this.nextId;
    this.nextId += 1;
    const socket = this.socket;
    if (socket === null) {
      throw new BridgeError('bridge_error', 'codex pipe is not connected');
    }
    const timeoutMs = options.timeoutMs ?? this.timeoutMs;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new BridgeError('bridge_error', `codex ${method} timed out`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer, method });
      socket.write(encodeFrame({ id, jsonrpc: '2.0', method, params }, { maxBytes: this.maxFrameBytes }));
    });
  }

  /**
   * @param {{threadStartKind?: string}} [options]
   * @param {{timeoutMs?: number}} [requestOptions]
   * @returns {Promise<object[]>} the advertised tools
   */
  async listTools(options = {}, requestOptions = {}) {
    const result = await this.request('tools/list', { threadStartKind: options.threadStartKind ?? 'all' }, requestOptions);
    const tools = Array.isArray(result?.tools) ? result.tools : [];
    return tools.map((tool) => ({
      name: String(tool.name ?? ''),
      namespace: String(tool.namespace ?? ''),
      description: typeof tool.description === 'string' ? tool.description : '',
      inputSchema: tool.inputSchema ?? null,
    }));
  }

  /**
   * Call one app tool and parse the answer twice: the real payload is JSON
   * inside `contentItems[0].text`.
   * @returns {Promise<object>} the inner value
   */
  async callTool({ namespace, tool, arguments: args = {}, threadId, callId, turnId }) {
    if (FORBIDDEN_TOOLS.has(tool)) {
      throw new BridgeError('bridge_error', 'this bridge never opens a new Codex thread');
    }
    const result = await this.request('tools/call', {
      arguments: args,
      callerSource: 'codex',
      callId: callId ?? crypto.randomUUID(),
      namespace,
      threadId,
      tool,
      turnId: turnId ?? crypto.randomUUID(),
    });
    if (result === null || typeof result !== 'object') {
      throw new BridgeError('bridge_error', 'codex returned no answer');
    }
    const items = Array.isArray(result.contentItems) ? result.contentItems : [];
    const textItem = items.find((item) => item?.type === 'inputText');
    if (textItem === undefined) {
      throw new BridgeError('bridge_error', 'codex returned no text item');
    }
    if (result.success !== true) {
      // The failure sentence is the app's own text; keep it short and safe.
      throw new BridgeError('bridge_error', safeMessage(String(textItem.text ?? '').slice(0, 120)));
    }
    try {
      return JSON.parse(textItem.text);
    } catch {
      throw new BridgeError('bridge_error', 'codex returned an answer that is not JSON');
    }
  }

  close() {
    this.failAll(new BridgeError('bridge_error', 'codex pipe closed by us'));
    this.socket?.destroy();
    this.socket = null;
  }
}

/**
 * Open the adapter on the app the user already has running.
 *
 * More than one `codex-browser-use-` pipe is usually alive, and they are not
 * equal: an idle or half-started one answers `tools/list` with
 * "No handler registered for method: tools/list". Picking the alphabetically
 * first would therefore fail on a machine where the right pipe is a different
 * one, so every candidate is probed with a real `tools/list` until one answers
 * with the tools this adapter needs. The environment variable is only ever a
 * preference, never a requirement.
 *
 * @param {{pipePath?: string, contextThreadId?: string, timeoutMs?: number, candidates?: string[], contextDiscovery?: object}} options
 */
async function openCodexAdapter(options) {
  const configured = options.pipePath ?? null;
  const envPath = process.env.CODEX_APP_TOOLS_PIPE_PATH ?? null;
  const discovered = options.candidates ?? discoverCodexPipes().map((name) => `\\\\.\\pipe\\${name}`);
  const candidates = [];
  for (const candidate of [configured, envPath, ...discovered]) {
    if (typeof candidate === 'string' && candidate.length > 0 && !candidates.includes(candidate)) {
      candidates.push(candidate);
    }
  }
  const context = resolveCodexContext({
    configured: options.contextThreadId,
    env: options.contextEnv ?? process.env,
    discoveryOptions: options.contextDiscovery,
  });
  const contextThreadId = context.contextThreadId;
  if (contextThreadId === null) {
    throw new BridgeError('bridge_error', context.reason);
  }
  const failures = [];
  // Probing is a preference test, not a real call: a pipe that is idle or half
  // started never answers at all, so waiting the full call timeout on each of the
  // (typically ten) candidates would take minutes before the right one is tried.
  const probeTimeoutMs = options.probeTimeoutMs ?? 3000;
  for (const pipePath of candidates) {
    const client = new CodexPipeClient({ pipePath, timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS });
    try {
      const tools = await client.listTools({ threadStartKind: 'all' }, { timeoutMs: probeTimeoutMs });
      const names = new Set(tools.filter((tool) => tool.namespace === CODEX_NAMESPACE).map((tool) => tool.name));
      if (!names.has(TOOL_LIST_THREADS) && !names.has(TOOL_READ_THREAD)) {
        failures.push(`${pipePath}: ${names.size} codex_app tools, none usable`);
        client.close();
        continue;
      }
      return new CodexAdapter({ client, contextThreadId, tools, pipePath, probes: failures });
    } catch (error) {
      failures.push(`${pipePath}: ${safeMessage(error)}`);
      client.close();
    }
  }
  const detail = failures.length === 0 ? 'no pipe was found' : failures.join('; ');
  throw new BridgeError('bridge_error', `no usable Codex app-tools pipe (${detail})`.slice(0, 120));
}

/** Compare two directories without depending on case or separator style. */
function normalizePath(value) {
  if (typeof value !== 'string' || value.length === 0) return null;
  return value.replaceAll('/', '\\').replace(/\\+$/, '').toLowerCase();
}

/**
 * Project kinds that are not a project on this computer.
 *
 * The real `list_projects` answer names the kind `projectKind` and marks the
 * host in `hostId`; a cloud/ChatGPT project carries `projectKind: 'cloud'` and
 * `hostId: 'chatgpt'`. Both markers are checked, because either one alone would
 * let a remote project through on a host that fills in only one of them. A
 * `worktree` is refused too: it is a checkout of a project, not something a
 * "new chat" should silently land in.
 */
const REMOTE_PROJECT_KINDS = new Set(['chatgpt', 'cloud', 'remote', 'hosted', 'worktree']);
/** Markers that mean "not this computer", for the legacy `kind`/`source` fields. */
const REMOTE_HOST_IDS = new Set(['chatgpt', 'cloud', 'remote', 'hosted']);

/**
 * The project catalog of the running app, as `{id, name, cwd}`.
 *
 * Two shapes really exist and both must work:
 * - the **live** one (verified read-only 2026-10-09):
 *   `{schemaVersion:2, projects:[{projectId, projectKind:'local', label, path,
 *   hostId:'local', isGitRepository}]}`;
 * - the **legacy** one: `{id, name, kind, cwd}`.
 *
 * Reading only one of them was a real, silent bug: the live answer came back as
 * an **empty** project list because `projectId`/`label`/`path` were not read at
 * all. Nothing here is hard-coded - no project id, no project name.
 * @param {unknown} value the `list_projects` inner value
 * @returns {{id: string, name: string, cwd: string|null}[]}
 */
function localProjects(value) {
  const items = Array.isArray(value?.projects) ? value.projects : Array.isArray(value) ? value : [];
  const projects = [];
  for (const project of items) {
    if (project === null || typeof project !== 'object') continue;
    const id = String(project.projectId ?? project.id ?? '');
    if (id.length === 0) continue;
    // Only a project the app itself calls local: a cloud/ChatGPT project, a
    // project on another host, or a worktree is not what a new chat should land in.
    const kind = String(project.projectKind ?? project.kind ?? project.type ?? project.location ?? '').toLowerCase();
    if (REMOTE_PROJECT_KINDS.has(kind)) continue;
    const hostId = String(project.hostId ?? '').toLowerCase();
    if (hostId !== '' && hostId !== 'local') continue;
    if (REMOTE_HOST_IDS.has(hostId)) continue;
    const cwd = typeof project.path === 'string' && project.path.length > 0 ? project.path : typeof project.cwd === 'string' && project.cwd.length > 0 ? project.cwd : null;
    const name = String(project.label ?? project.name ?? project.title ?? '').trim();
    projects.push({ id, name: name.length > 0 ? name : id, cwd });
  }
  return projects;
}

/** The Codex Desktop side of the bridge, on top of one pipe connection. */
class CodexAdapter {
  /** @param {{client: CodexPipeClient, contextThreadId: string, tools: object[], pipePath?: string, probes?: string[]}} options */
  constructor({ client, contextThreadId, tools, pipePath = client.pipePath, probes = [] }) {
    this.client = client;
    this.contextThreadId = contextThreadId;
    this.tools = tools;
    this.pipePath = pipePath;
    this.probes = probes;
    this.toolNames = new Set(tools.filter((tool) => tool.namespace === CODEX_NAMESPACE).map((tool) => tool.name));
  }

  /**
   * Open the adapter on the app the user already has running.
   * @param {{pipePath?: string, contextThreadId?: string}} options
   */
  static async open(options) {
    return openCodexAdapter(options);
  }

  /** The `codex_app` tool names this pipe really advertises. */
  availableTools() {
    return [...this.toolNames];
  }

  has(tool) {
    return this.toolNames.has(tool);
  }

  canList() {
    return this.has(TOOL_LIST_THREADS);
  }

  listProjects() {
    return this.has(TOOL_LIST_PROJECTS);
  }

  /** `create_thread` is the desktop app's own "new chat"; only `session.create` may use it. */
  canCreate() {
    return this.has(CREATE_THREAD_TOOL);
  }

  canRead() {
    return this.has(TOOL_READ_THREAD);
  }

  canSend() {
    return this.has(TOOL_SEND_MESSAGE);
  }

  /** The tool whose own schema documents what one send may carry. */
  sendTool() {
    return this.tools.find((tool) => tool.name === TOOL_SEND_MESSAGE);
  }

  /**
   * Whether a model may really be chosen for the next message (CRD 0008 §B).
   *
   * This is the send tool's own schema and nothing else: `send_message_to_thread`
   * is where a per-message override travels, so a catalog read from
   * `create_thread` would let the phone choose a model the send path cannot
   * validate. A tool whose schema documents no readable catalog therefore gets
   * no picker - while a plain send without a model keeps working unchanged.
   */
  canSendWithModel() {
    return this.canSend() && catalogOfTool(this.sendTool()).length > 0;
  }

  /**
   * There is no answer path on this channel: the live catalog has no tool that
   * hands a structured answer batch back to a native question call, and
   * `send_message_to_thread` would send words without naming the callId. So
   * `session.answer:codex` is reported false and the call refuses, instead of
   * typing something that only looks like an answer.
   */
  canAnswer() {
    return false;
  }

  /**
   * There is no stop interface on this channel today: the live catalog has no
   * interrupt/cancel/stop tool, so stopping stays unavailable. The `app.asar`
   * search for a real IPC stop path was **not** performed (see
   * `DELIVERY_REPORT.md`, item 5 of the unverified list); `stop:codex` is
   * reported false because the app-tools catalog has no such tool.
   */
  canStop() {
    return false;
  }

  capabilityFlags() {
    return { list: this.canList(), read: this.canRead(), send: this.canSend(), stop: this.canStop() };
  }

  async call(tool, args) {
    if (!this.has(tool)) {
      throw new BridgeError('not_capable', `the Codex app does not offer ${tool}`);
    }
    return this.client.callTool({
      namespace: CODEX_NAMESPACE,
      tool,
      arguments: args,
      threadId: this.contextThreadId,
    });
  }

  /**
   * The real model catalog of this host, plus the real local projects.
   *
   * Models come from the live `create_thread` schema description (see
   * `parseModelCatalog`); projects come from `list_projects` and only entries the
   * app itself marks as local are offered - a worktree or a cloud project is not
   * something this bridge creates.
   */
  async listModels() {
    // Prefer the schema a per-message model override really travels in; fall
    // back to `create_thread` so the "new chat" picker still works on a host
    // whose send tool documents no catalog. `catalogSource` names whichever was
    // read, so nothing about this is implicit.
    const sendTool = this.sendTool();
    const createTool = this.tools.find((tool) => tool.name === CREATE_THREAD_TOOL);
    const source = catalogOfTool(sendTool).length > 0 ? sendTool : createTool;
    const models = catalogOfTool(source);
    let projects = [];
    if (this.has(TOOL_LIST_PROJECTS)) {
      try {
        const value = await this.call(TOOL_LIST_PROJECTS, {});
        projects = localProjects(value);
      } catch {
        projects = [];
      }
    }
    return {
      models,
      projects,
      catalogSource: source === undefined ? 'none' : `${source.name}.inputSchema.properties.model.description`,
    };
  }

  /**
   * Create a real thread in the running Codex Desktop app.
   *
   * Rules this follows, all of them from what the live schema really accepts:
   * - `target` is **required**. Only a **local** project is ever chosen: a
   *   worktree or a cloud target is not what a "new chat" button means, and a
   *   project id the app did not list is refused instead of guessed.
   * - `cwd` has no field of its own. It is resolved against the live
   *   `list_projects` answer; when nothing matches, this fails loudly rather than
   *   quietly creating a projectless chat somewhere else.
   * - `prompt` is required by the schema. An empty first message is sent as an
   *   empty string (the schema sets no minimum length); if the app rejects that,
   *   the caller is told that a Codex chat needs a first message. No sentence is
   *   ever invented on the user's behalf.
   * @param {{model: string, reasoningEffort?: string, title?: string, text?: string, projectId?: string, cwd?: string}} input
   * @param {{onCreated?: (created: {sessionId: string}) => void}} [hooks]
   */
  async createSession(input, hooks = {}) {
    if (!this.has(CREATE_THREAD_TOOL)) {
      throw new BridgeError('tool_unavailable', 'the Codex app does not offer create_thread');
    }
    const target = await this.resolveTarget(input);
    const args = {
      target,
      prompt: typeof input.text === 'string' && input.text.length > 0 ? input.text : '',
    };
    if (typeof input.title === 'string' && input.title.trim().length > 0) {
      args.title = input.title.trim().slice(0, 120);
    }
    if (typeof input.model === 'string' && input.model.length > 0) {
      args.model = input.model;
    }
    // `reasoningEffort` is the phone's word; `thinking` is this tool's word.
    if (typeof input.reasoningEffort === 'string' && input.reasoningEffort.length > 0) {
      args.thinking = input.reasoningEffort;
    }

    let value;
    try {
      value = await this.call(CREATE_THREAD_TOOL, args);
    } catch (error) {
      if (args.prompt === '') {
        throw new BridgeError('session_create_failed', 'a new Codex chat needs a first message on this host');
      }
      throw error;
    }
    const sessionId = String(value?.threadId ?? value?.id ?? '');
    if (sessionId.length === 0) {
      throw new BridgeError('session_create_failed', 'the Codex app did not return a thread id');
    }
    // Hand the id over immediately: whatever happens next, the session exists.
    if (typeof hooks.onCreated === 'function') {
      hooks.onCreated({ sessionId });
    }
    return { sessionId, title: typeof value?.title === 'string' ? value.title : args.title };
  }

  /**
   * Pick the local project this chat belongs to.
   *
   * A named project and a named directory must agree. The wire contract allows a
   * phone to send both, and a pair that contradicts itself would open the chat
   * somewhere the user did not choose - so it is refused **before** anything is
   * created, exactly like the DSH side refuses it (`session/create` there accepts
   * only one of the two fields at all).
   * @param {{projectId?: string, cwd?: string}} input
   * @returns {Promise<object>} a `target` the schema accepts
   */
  async resolveTarget(input) {
    const wantsProject = (typeof input.projectId === 'string' && input.projectId.length > 0) || (typeof input.cwd === 'string' && input.cwd.length > 0);
    if (!wantsProject) {
      return { type: 'projectless' };
    }
    if (!this.has(TOOL_LIST_PROJECTS)) {
      throw new BridgeError('session_create_failed', 'the Codex app cannot list projects, so that project cannot be honoured');
    }
    const projects = localProjects(await this.call(TOOL_LIST_PROJECTS, {}));
    if (projects.length === 0) {
      throw new BridgeError('session_create_failed', 'the Codex app reported no local project to open that chat in');
    }
    if (typeof input.projectId === 'string' && input.projectId.length > 0) {
      const known = projects.find((project) => project.id === input.projectId);
      if (known === undefined) {
        throw new BridgeError('session_create_failed', 'that project is not one of the local projects this app offers');
      }
      if (typeof input.cwd === 'string' && input.cwd.length > 0 && normalizePath(input.cwd) !== normalizePath(known.cwd)) {
        throw new BridgeError('session_create_failed', 'that directory is not the project this chat was asked to open in');
      }
      return { type: 'project', projectId: known.id, environment: { type: 'local' } };
    }
    const wanted = normalizePath(input.cwd);
    const matched = projects.find((project) => normalizePath(project.cwd) === wanted);
    if (matched === undefined) {
      throw new BridgeError('session_create_failed', 'no local project of this app matches that directory');
    }
    return { type: 'project', projectId: matched.id, environment: { type: 'local' } };
  }
  /**
   * One thread's real metadata, read natively through `read_thread`.
   *
   * This is how a chat this bridge created stays findable. Observed read-only on
   * this machine: a thread that `read_thread` answers for is **missing** from a
   * `list_threads{limit:15}` answer, so after a phone reload the created chat
   * could not be reopened. The id recorded at creation time is resolved here and
   * merged back into `sessions.list` with its **real** title, status and cwd — a
   * thread that cannot be read is simply not offered, nothing is invented.
   * @param {string} sessionId
   */
  async readThreadMeta(sessionId) {
    if (!this.canRead()) return null;
    try {
      const value = await this.call(TOOL_READ_THREAD, { threadId: sessionId });
      const thread = value?.thread ?? null;
      if (thread === null || String(thread.id ?? '') !== String(sessionId)) return null;
      return {
        id: sessionId,
        tool: 'codex',
        title: String(thread.title ?? '').trim() || `Codex thread ${String(sessionId).slice(0, 8)}`,
        status: mapThreadStatus(thread.status),
        updatedAt: toTimestamp(thread.updatedAt ?? thread.createdAt ?? null),
        cwd: typeof thread.cwd === 'string' && thread.cwd.length > 0 ? thread.cwd : null,
      };
    } catch {
      return null;
    }
  }

  /**
   * §9.1 sessions for the Codex app's own threads.
   *
   * The answer holds both the ordinary list and the pinned one, and a pinned
   * chat is still a chat the user expects to see: leaving `pinnedThreads` out
   * would quietly hide the conversations they care most about.
   *
   * Only local Codex threads travel: a ChatGPT cloud thread has no local cwd and
   * no thread this bridge could continue, so sending a message into one would be
   * a wrong-session delivery rather than a take-over.
   *
   * @param {{extraIds?: string[], extraLimit?: number}} [options] ids this bridge
   *   created recently. Each one the native list forgot is read natively and
   *   merged, up to `extraLimit` (default 5), so one call stays bounded.
   */
  async listSessions(options = {}) {
    if (!this.canList()) {
      throw new BridgeError('not_capable', 'the Codex app does not offer list_threads');
    }
    const value = await this.call(TOOL_LIST_THREADS, { limit: LIST_THREADS_LIMIT });
    const seen = new Set();
    const sessions = [];
    for (const thread of [...threadArray(value?.threads), ...threadArray(value?.pinnedThreads)]) {
      if (typeof thread?.id !== 'string' || thread.id.length === 0 || seen.has(thread.id)) continue;
      if (!isLocalCodexThread(thread)) continue;
      seen.add(thread.id);
      sessions.push({
        id: thread.id,
        tool: 'codex',
        title: String(thread.title ?? '').trim() || `Codex thread ${thread.id.slice(0, 8)}`,
        status: mapThreadStatus(thread.status),
        updatedAt: toTimestamp(thread.updatedAt),
        cwd: typeof thread.cwd === 'string' && thread.cwd.length > 0 ? thread.cwd : null,
      });
    }

    const extraLimit = options.extraLimit ?? 5;
    const extraIds = (Array.isArray(options.extraIds) ? options.extraIds : [])
      .filter((id) => typeof id === 'string' && id.length > 0 && !seen.has(id))
      .slice(0, extraLimit);
    for (const id of extraIds) {
      const meta = await this.readThreadMeta(id);
      if (meta !== null) {
        sessions.push(meta);
      }
    }
    return sessions;
  }

  /** §9.2 history of one thread. Read-only: nothing here changes the session. */
  async readSession(sessionId) {
    if (!this.canRead()) {
      throw new BridgeError('not_capable', 'the Codex app does not offer read_thread');
    }
    if (typeof sessionId !== 'string' || sessionId.length === 0) {
      throw new BridgeError('invalid_params', 'a session id is required');
    }
    const value = await this.call(TOOL_READ_THREAD, {
      threadId: sessionId,
      // The native default is one turn, which silently dropped every earlier
      // message the moment the next answer arrived. The count and the per-item
      // output cap are explicit and bounded here.
      turnLimit: READ_TURN_LIMIT,
      includeOutputs: true,
      maxOutputCharsPerItem: MAX_OUTPUT_CHARS_PER_ITEM,
    });
    const thread = value?.thread ?? null;
    const turns = Array.isArray(value?.turns) ? value.turns : [];
    if (thread === null && turns.length === 0) {
      throw new BridgeError('session_not_found', 'that Codex thread does not exist');
    }
    // The page is a window of the N most recent turns, so it is the **first**
    // returned turn - not the last - that reports the newest one, whatever
    // direction the page order runs in.
    const status = mapThreadStatus(thread?.status ?? turns[0]?.status);
    const activeTurn = turns.find((turn) => mapThreadStatus(turn?.status) === 'working');
    const result = {
      id: sessionId,
      tool: 'codex',
      title: String(thread?.title ?? '').trim() || `Codex thread ${sessionId.slice(0, 8)}`,
      status,
      // The page order decides the direction; the turns are emitted oldest-first
      // either way.
      messages: itemsToMessages(turns, { pageOrder: value?.page?.order ?? null }),
      canStop: status === 'working' && this.canStop(),
    };
    if (status === 'working') {
      result.activeTurnId = String(activeTurn?.id ?? turns[0]?.id ?? 'active-turn');
    }
    return result;
  }

  /**
   * §9.3: hand the text to the input of the thread the user already has open.
   * Exactly one call, no retry, and never a new thread.
   */
  async sendMessage(sessionId, text, options = {}) {
    if (!this.canSend()) {
      throw new BridgeError('not_capable', 'the Codex app does not offer send_message_to_thread');
    }
    if (typeof sessionId !== 'string' || sessionId.length === 0) {
      throw new BridgeError('invalid_params', 'a session id is required');
    }
    const args = { threadId: sessionId, prompt: text };
    // CRD 0008 §B: an optional model for the NEXT message, checked against the
    // schema this very pipe advertises now, so a model or an effort this host
    // does not offer can never be sent. Codex has no `provider`; the protocol
    // layer already refuses one. Omitting all of it is the old request, byte for
    // byte - and one send, never a retry.
    if (typeof options.model === 'string' && options.model.length > 0) {
      const sendTool = this.sendTool();
      const models = catalogOfTool(sendTool);
      if (models.length === 0) {
        throw new BridgeError('not_capable', 'this Codex app does not describe a model catalog to send with');
      }
      const match = models.find((model) => model.id === options.model);
      if (match === undefined) {
        throw new BridgeError('model_not_available', 'that model is not one this Codex app offers');
      }
      const effort = options.reasoningEffort;
      if (typeof effort === 'string' && effort.length > 0) {
        // The per-model list in the schema description is the precise statement
        // ("supported reasoning efforts: ..."); the tool's own `thinking` enum is
        // only the field's broader vocabulary, so it is used only when the
        // description declares nothing for that model. Neither is guessed at, and
        // an effort that cannot be checked is refused rather than sent.
        const declared = match.reasoningEfforts ?? [];
        const allowed = declared.length > 0 ? declared : thinkingEffortsOf(sendTool);
        if (allowed.length === 0) {
          throw new BridgeError('not_capable', 'this Codex app does not say which reasoning efforts that model offers');
        }
        if (!allowed.includes(effort)) {
          throw new BridgeError('invalid_params', 'that reasoning effort is not offered for this model');
        }
        // `reasoningEffort` is the phone's word; `thinking` is this tool's word.
        args.thinking = effort;
      }
      args.model = options.model;
    }
    await this.call(TOOL_SEND_MESSAGE, args);
    return { accepted: true, sessionId };
  }

  /** §9.4-adjacent: answering a native question is not possible on this channel. */
  async answerQuestion() {
    throw new BridgeError('not_capable', 'this Codex session cannot answer a native question through the app-tools pipe');
  }

  /** §9.4: no stop interface exists on this channel, so this must not pretend. */
  async stopSession(sessionId) {
    if (!this.canStop()) {
      throw new BridgeError('not_capable', 'this Codex session cannot be stopped through the app-tools pipe');
    }
    return { accepted: true, sessionId };
  }

  close() {
    this.client.close();
  }
}

module.exports = {
  PIPE_MAX_FRAME_BYTES,
  LIST_THREADS_LIMIT,
  CODEX_NAMESPACE,
  CREATE_THREAD_TOOL,
  READ_TURN_LIMIT,
  MAX_OUTPUT_CHARS_PER_ITEM,
  normalizePath,
  listPipeNames,
  discoverCodexPipes,
  pickPipe,
  parseModelCatalog,
  catalogOfTool,
  thinkingEffortsOf,
  localProjects,
  isLocalCodexThread,
  mapThreadStatus,
  itemsToMessages,
  itemToText,
  contentToText,
  toTimestamp,
  CodexPipeClient,
  CodexAdapter,
  FORBIDDEN_TOOLS,
};
