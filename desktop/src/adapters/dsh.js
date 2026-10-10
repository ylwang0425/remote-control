'use strict';
/**
 * DSH Desktop adapter: drive the sessions of the DSH backend that is already
 * running on this machine, through its own HTTP API.
 *
 * How it works, and why:
 * - **Discovery, never a hard-coded port.** The backend is a `DeepSeek Harness`
 *   process listening on loopback; the port and the PID change on every restart,
 *   so candidates come from the config, the environment, a saved hint, and a
 *   `netstat -ano` + `tasklist` scan of loopback listeners. A candidate is
 *   accepted only when `session/list` really answers.
 * - **The local user's own authorisation, used locally only.** DSH authenticates
 *   its web client with a signed cookie: name `dsh-auth-<base64url(sha256(
 *   authority))>`, value `v1.<base64url(payload)>.<base64url(hmacSha256(secret,
 *   body))>`. The secret is read from the local credential store
 *   (`~/.dsh/.credentials.yaml`, record `client-connection/browser-session`),
 *   stays in this process, and is never printed, logged, written to a report or
 *   sent anywhere but the exact loopback origin. Nothing here talks to the relay
 *   about credentials: the relay only ever sees session-shaped results.
 * - **The same session continues.** `session/list` -> `session/page` for the
 *   history, `session/prompt` for a message, `session/cancel` to stop. Every
 *   call carries the session id the user already has; nothing creates a session.
 *   A subagent session (a child of another session) goes through the official
 *   `subagents/prompt` path, because `session/prompt` answers `session/agent-busy`
 *   for one.
 * - **Send once.** A failed or timed-out send is never repeated: a second
 *   `session/prompt` would post the message twice.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');

const { BridgeError, safeMessage } = require('../errors');
const { toRfc3339, isSessionId, MAX_MESSAGES } = require('../protocol');
const {
  DshEventStream,
  REMOTE_STREAM_MUX_PATH,
  EVENT_RESULT_ENDPOINT,
  NATIVE_APPROVAL_OUTCOME,
  EVENT_LIMITS,
  boundedIdentifier,
  sanitizeNativeText,
  containsAnswerBatch,
} = require('../dsh-events');

/** Cookie prefix, `dsh-client-connection/lib/index.js` line 227. */
const DSH_PREFIX = 'dsh-auth-';
const COOKIE_VERSION = 'v1';
const SECRET_BYTES = 32;
const DAY_MS = 24 * 60 * 60 * 1000;
/** The server's own default cookie lifetime (`cookieMaxAgeDays` default 30). */
const COOKIE_TTL_MS = 30 * DAY_MS;
const CREDENTIALS_RECORD = 'client-connection/browser-session';
const DISCOVERY_TIMEOUT_MS = 1500;
const RPC_TIMEOUT_MS = 15000;
const DEFAULT_CLIENT_TIME_ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';

function base64Url(value) {
  return Buffer.from(value).toString('base64').replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '');
}

function base64UrlDecode(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]*$/.test(value) || value.length % 4 === 1) return undefined;
  const padding = '='.repeat((4 - (value.length % 4)) % 4);
  return Buffer.from(value.replaceAll('-', '+').replaceAll('_', '/') + padding, 'base64');
}

/** `dsh-auth-` + base64url(sha256(authority)); `authority` is `host[:port]`. */
function cookieName(authority) {
  return DSH_PREFIX + base64Url(crypto.createHash('sha256').update(authority).digest());
}

/**
 * Mint the same cookie DSH's own web client gets from the server.
 * @param {{secret: Buffer, authority: string, now?: number, ttlMs?: number}} input
 * @returns {{name: string, value: string, expiresAt: number}}
 */
function mintCookie({ secret, authority, now = Date.now(), ttlMs = COOKIE_TTL_MS }) {
  if (!Buffer.isBuffer(secret) || secret.length !== SECRET_BYTES) {
    throw new Error('the browser-session secret must be exactly 32 bytes');
  }
  const payload = { version: 1, authority, issuedAt: now, expiresAt: now + ttlMs };
  const body = base64Url(Buffer.from(JSON.stringify(payload), 'utf8'));
  const signature = base64Url(crypto.createHmac('sha256', secret).update(body).digest());
  return { name: cookieName(authority), value: `${COOKIE_VERSION}.${body}.${signature}`, expiresAt: payload.expiresAt };
}

/**
 * Read the browser-session secret out of the local credential store.
 *
 * This is a narrow scan for exactly one record, not a YAML implementation: DSH's
 * credential file is written by DSH, and all this needs is the `secret:` line
 * that follows the browser-session record key.
 * @param {string} [credentialsPath]
 * @returns {Buffer} 32 raw bytes
 */
function readBrowserSecret(credentialsPath = path.join(os.homedir(), '.dsh', '.credentials.yaml')) {
  const text = fs.readFileSync(credentialsPath, 'utf8');
  const keyIndex = text.indexOf(CREDENTIALS_RECORD);
  if (keyIndex === -1) {
    throw new Error(`the credential store has no "${CREDENTIALS_RECORD}" record`);
  }
  const match = /^\s*secret:\s*"?([A-Za-z0-9_-]+)"?\s*$/m.exec(text.slice(keyIndex));
  if (match === null) {
    throw new Error(`the "${CREDENTIALS_RECORD}" record has no secret`);
  }
  const decoded = base64UrlDecode(match[1]);
  if (decoded === undefined || decoded.length !== SECRET_BYTES) {
    throw new Error(`the "${CREDENTIALS_RECORD}" record has an invalid secret`);
  }
  return decoded;
}

/**
 * Parse `netstat -ano` output into loopback TCP listeners.
 * @param {string} text
 * @returns {{localAddress: string, localPort: number, pid: number}[]}
 */
function parseNetstatListeners(text) {
  const listeners = [];
  for (const line of String(text).split(/\r?\n/)) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 5 || parts[0] !== 'TCP' || parts[3] !== 'LISTENING') continue;
    const match = /^(.*):(\d+)$/.exec(parts[1]);
    if (match === null) continue;
    const localAddress = match[1].replace(/^\[|\]$/g, '');
    if (localAddress !== '127.0.0.1' && localAddress !== '::1') continue;
    const pid = Number(parts[4]);
    if (!Number.isInteger(pid)) continue;
    listeners.push({ localAddress, localPort: Number(match[2]), pid });
  }
  return listeners;
}

/** `tasklist /FO CSV` -> pid -> image name. */
function parseTasklistNames(csv) {
  const names = new Map();
  for (const line of String(csv).split(/\r?\n/)) {
    const match = /^"([^"]*)","(\d+)"/.exec(line.trim());
    if (match === null) continue;
    names.set(Number(match[2]), match[1]);
  }
  return names;
}

/** Ports to probe, in the order they should be trusted. */
function candidatePorts({ configuredPort, envPort, known = [], scanned = [] } = {}) {
  const ordered = [];
  const push = (value) => {
    const port = Number(value);
    if (Number.isInteger(port) && port > 0 && port <= 65535 && !ordered.includes(port)) ordered.push(port);
  };
  push(configuredPort);
  push(envPort);
  for (const port of known) push(port);
  for (const port of scanned) push(port);
  return ordered;
}

function execFileText(file, args, timeoutMs = 4000) {
  return new Promise((resolve) => {
    execFile(file, args, { timeout: timeoutMs, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => {
      resolve(error ? '' : String(stdout ?? ''));
    });
  });
}

/** Loopback ports owned by a process whose image looks like DSH. */
async function scanDshPorts({ exec = execFileText } = {}) {
  if (process.platform !== 'win32') return [];
  const [netstat, tasklist] = await Promise.all([exec('netstat', ['-ano']), exec('tasklist', ['/FO', 'CSV', '/NH'])]);
  const names = parseTasklistNames(tasklist);
  return parseNetstatListeners(netstat)
    .filter((listener) => /deepseek harness/i.test(names.get(listener.pid) ?? ''))
    .map((listener) => listener.localPort);
}

/**
 * Find the running DSH backend.
 *
 * A candidate counts as found only when `session/list` answers, so a port that
 * merely happens to be open is not mistaken for the backend.
 * @param {{ports?: number[], configuredPort?: number, envPort?: string, secret?: Buffer, known?: number[], credentialsPath?: string, timeoutMs?: number}} [options]
 */
async function discoverBackend(options = {}) {
  const secret = options.secret ?? readBrowserSecret(options.credentialsPath);
  const envPort = options.envPort ?? process.env.DSH_BACKEND_PORT ?? process.env.DSH_PORT ?? null;
  const known = options.known ?? readPortHint();
  const scanned = options.ports ?? (await scanDshPorts());
  const ports = candidatePorts({ configuredPort: options.configuredPort, envPort, known, scanned });
  for (const port of ports) {
    const baseUrl = `http://127.0.0.1:${port}`;
    const client = new DshClient({ baseUrl, secret, timeoutMs: options.timeoutMs ?? DISCOVERY_TIMEOUT_MS });
    try {
      const value = await client.call('session/list', {});
      if (value !== null && typeof value === 'object') {
        return { port, baseUrl, secret, listValue: value };
      }
    } catch {
      // Not the backend (or not answering yet): try the next candidate.
    }
  }
  return null;
}

/**
 * The last port that really worked, kept as a hint.
 *
 * It lives in this application's own data directory, not in the DSH profile: the
 * task's rule is that the user profile is read-only for this bridge, and a hint
 * file is ours to keep, not DSH's to carry.
 */
function portHintPath() {
  const base = process.env.LOCALAPPDATA ?? path.join(os.homedir(), '.cache');
  return path.join(base, 'ai-remote', 'port.json');
}

function readPortHint() {
  try {
    const parsed = JSON.parse(fs.readFileSync(portHintPath(), 'utf8'));
    return typeof parsed.port === 'number' ? [parsed.port] : [];
  } catch {
    return [];
  }
}

function writePortHint(port) {
  try {
    const file = portHintPath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ port, at: new Date().toISOString() }), { mode: 0o600 });
  } catch {
    // A missing hint only costs one scan next start.
  }
}

/**
 * The DSH project catalog, read-only, from the file DSH itself keeps.
 *
 * `workspace/list` does not exist on this backend (it answers with something
 * that is not JSON), so the authoritative catalog of **registered** workspaces is
 * the durable storage file DSH writes:
 *
 *   %USERPROFILE%\.dsh\storages\workspace.json
 *   {unit, global, tables:{workspaces:{[workspaceId]:{path, title, sessionIds,
 *    createdAt, updatedAt}}}}
 *
 * This file belongs to DSH. It is opened read-only and never written, migrated or
 * repaired; the bridge only ever reads the one bounded slice below. When it is
 * missing, unreadable, corrupt or unlike the shape above, the honest answer is an
 * **empty** project list plus a safe `reason` - never a made-up entry, and never
 * an error that would look like a broken desktop.
 */

/** This many bytes is the whole file; anything larger is refused unread. */
const WORKSPACE_CATALOG_MAX_BYTES = 4 * 1024 * 1024;
/** A local file read of a few hundred kilobytes is milliseconds; this is a stop. */
const WORKSPACE_CATALOG_TIMEOUT_MS = 1500;

/** `DSH_HOME` decides the profile directory; `~/.dsh` is the default. */
function dshProfileDir(env = process.env, homeDir = os.homedir()) {
  const configured = env.DSH_HOME;
  return typeof configured === 'string' && configured.length > 0 ? configured : path.join(homeDir, '.dsh');
}

/**
 * Where the registered-workspace catalog lives.
 *
 * Precedence: an explicitly configured path, then `DSH_HOME`, then `~/.dsh`.
 * @param {{configuredPath?: string|null, env?: Record<string, string|undefined>, homeDir?: string}} [options]
 */
function workspaceCatalogPath({ configuredPath = null, env = process.env, homeDir = os.homedir() } = {}) {
  if (typeof configuredPath === 'string' && configuredPath.length > 0) return configuredPath;
  return path.join(dshProfileDir(env, homeDir), 'storages', 'workspace.json');
}

/** Compare two directories without depending on case or separator style. */
function normalizeWorkspacePath(value) {
  if (typeof value !== 'string' || value.length === 0) return null;
  return value.replaceAll('/', '\\').replace(/\\+$/, '').toLowerCase();
}

/** The last segment of a path, for a workspace that carries no title. */
function lastPathSegment(value) {
  if (typeof value !== 'string') return '';
  const parts = value.split(/[\\/]/).filter((part) => part.length > 0);
  return parts.length === 0 ? '' : parts[parts.length - 1];
}

/**
 * Validate the real catalog shape and map it to `{id, name, cwd}`.
 *
 * `id` is the workspace key, `name` is the title (falling back to the last path
 * segment, then to the id), `cwd` is the path. An entry with no usable path is
 * counted in `skipped` rather than turned into a project whose cwd was invented.
 * @param {unknown} value the parsed file
 * @returns {{projects: object[], skipped: number, reason: string|null}}
 */
function parseWorkspaceCatalog(value) {
  const broken = (reason) => ({ projects: [], skipped: 0, reason });
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return broken('the DSH workspace catalog is not the shape this bridge understands');
  }
  const tables = value.tables;
  if (tables === null || typeof tables !== 'object' || Array.isArray(tables)) {
    return broken('the DSH workspace catalog has no table of workspaces');
  }
  const workspaces = tables.workspaces;
  if (workspaces === null || typeof workspaces !== 'object' || Array.isArray(workspaces)) {
    return broken('the DSH workspace catalog has no table of workspaces');
  }
  const projects = [];
  let skipped = 0;
  for (const [workspaceId, entry] of Object.entries(workspaces)) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      skipped += 1;
      continue;
    }
    const id = String(workspaceId ?? '');
    const cwd = typeof entry.path === 'string' && entry.path.length > 0 ? entry.path : null;
    if (id.length === 0 || cwd === null) {
      skipped += 1;
      continue;
    }
    const title = typeof entry.title === 'string' ? entry.title.trim() : '';
    const name = title.length > 0 ? title : lastPathSegment(cwd) || id;
    projects.push({ id, name, cwd });
  }
  return { projects, skipped, reason: null };
}

/** Reject a promise that takes longer than `timeoutMs`. */
function withDeadline(promise, timeoutMs) {
  let timer = null;
  const deadline = new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(new Error('the DSH workspace catalog took too long to read')), timeoutMs);
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

/**
 * Read the registered-workspace catalog, bounded in size and in time.
 *
 * @param {{path?: string, configuredPath?: string|null, env?: Record<string, string|undefined>, homeDir?: string, maxBytes?: number, timeoutMs?: number, stat?: Function, readFile?: Function}} [options]
 * @returns {Promise<{projects: object[], skipped: number, reason: string|null, source: string}>}
 */
async function readWorkspaceCatalog(options = {}) {
  const file = options.path ?? workspaceCatalogPath(options);
  const maxBytes = options.maxBytes ?? WORKSPACE_CATALOG_MAX_BYTES;
  const timeoutMs = options.timeoutMs ?? WORKSPACE_CATALOG_TIMEOUT_MS;
  const stat = options.stat ?? fs.promises.stat;
  const readFile = options.readFile ?? fs.promises.readFile;
  const refuse = (reason) => ({ projects: [], skipped: 0, reason, source: 'workspace.json' });
  try {
    const info = await stat(file);
    if (typeof info.isFile === 'function' && !info.isFile()) {
      return refuse('the DSH workspace catalog is not a readable file');
    }
    if (info.size > maxBytes) {
      return refuse('the DSH workspace catalog is larger than this bridge reads');
    }
    const text = await withDeadline(readFile(file, 'utf8'), timeoutMs);
    // The file can grow between the size check and the read; measure again.
    if (Buffer.byteLength(text, 'utf8') > maxBytes) {
      return refuse('the DSH workspace catalog is larger than this bridge reads');
    }
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      return refuse('the DSH workspace catalog is not JSON');
    }
    return { ...parseWorkspaceCatalog(parsed), source: 'workspace.json' };
  } catch (error) {
    const code = error !== null && typeof error === 'object' ? String(error.code ?? '') : '';
    if (code === 'ENOENT') {
      return refuse('this computer has no DSH workspace catalog');
    }
    if (code === 'EACCES' || code === 'EPERM') {
      return refuse('the DSH workspace catalog cannot be read here');
    }
    // A deadline or an unexpected failure: the fixed wording, never raw text.
    return refuse('the DSH workspace catalog could not be read');
  }
}

/**
 * `reasoning` on a catalog model is a list of levels, or objects carrying an
 * `id`/`effort`, or a single string. Normalise all three, and remember which one
 * the backend marks as the default when it says so.
 * @param {unknown} reasoning
 */
function reasoningEffortsOf(reasoning) {
  const list = [];
  let defaultEffort = null;
  const push = (value, isDefault) => {
    if (typeof value !== 'string' || value.length === 0) return;
    if (!list.includes(value)) list.push(value);
    if (isDefault) defaultEffort = value;
  };
  if (typeof reasoning === 'string') {
    push(reasoning, false);
  } else if (Array.isArray(reasoning)) {
    for (const item of reasoning) {
      if (typeof item === 'string') push(item, false);
      else if (item !== null && typeof item === 'object') {
        push(item.id ?? item.effort ?? item.name ?? item.value, item.default === true || item.isDefault === true);
      }
    }
  } else if (reasoning !== null && typeof reasoning === 'object') {
    push(reasoning.default ?? reasoning.id ?? reasoning.effort, true);
    for (const key of Object.keys(reasoning)) {
      if (key === 'default' || key === 'id' || key === 'effort') continue;
      if (Array.isArray(reasoning[key])) {
        for (const item of reasoning[key]) push(typeof item === 'string' ? item : item?.id ?? item?.effort, false);
      }
    }
  }
  return { list, defaultEffort };
}

/**
 * The pending-question form this bridge presents (CRD 0008 §E).
 *
 * A form that does not fit is refused, never trimmed: the phone must never let
 * somebody answer a question whose options were partly dropped, because that
 * would be a choice the native form did not offer. The native `userQuestions`
 * projection is the only source - no choice is ever synthesised.
 */
const PENDING_LIMITS = Object.freeze({
  batches: 4,
  questions: 8,
  options: 12,
  questionText: 1000,
  header: 200,
  detail: 1000,
  optionLabel: 200,
  optionDescription: 500,
});

/** Why a question form could not be presented; one sentence, safe to show. */
const TOO_LARGE_TO_SHOW = 'a question is waiting here in a form this phone cannot show in full; answer it on the computer';

/** A native sentence that must fit the bound, or the whole read is refused. */
function boundedNativeText(value, limit) {
  const text = sanitizeNativeText(value);
  if ([...text].length > limit) {
    throw new BridgeError('bridge_error', TOO_LARGE_TO_SHOW);
  }
  return text;
}

/** One optional native sentence: absent or empty means "not carried". */
function boundedOptionalNativeText(value, limit) {
  if (typeof value !== 'string') return undefined;
  const text = boundedNativeText(value, limit);
  return text.length === 0 ? undefined : text;
}

/**
 * The active batches of a native `userQuestions` projection value.
 *
 * Two shapes are accepted because the same data is reached two ways: the wire
 * view is `{active, settled}` (`lib/types/projection.js`), while the internal
 * state nests it as `{questions:{active, settled}}` (see `stateOf(...)
 * .questions.active` in the same package). Both are the native field - neither
 * invents a question.
 */
function activeQuestionBatches(value) {
  if (value === null || typeof value !== 'object') return [];
  if (Array.isArray(value.active)) return value.active;
  const nested = value.questions;
  if (nested !== null && typeof nested === 'object' && Array.isArray(nested.active)) return nested.active;
  return [];
}

/** One native question -> the bounded wire shape (never a synthetic choice). */
function mapPendingQuestion(question) {
  const id = typeof question?.id === 'string' ? question.id.trim() : '';
  if (id.length === 0) throw new BridgeError('bridge_error', TOO_LARGE_TO_SHOW);
  const entry = { id, question: boundedNativeText(question?.question, PENDING_LIMITS.questionText) };
  const header = boundedOptionalNativeText(question?.header, PENDING_LIMITS.header);
  if (header !== undefined) entry.header = header;
  const detail = boundedOptionalNativeText(question?.detail, PENDING_LIMITS.detail);
  if (detail !== undefined) entry.detail = detail;
  if (Array.isArray(question?.options)) {
    if (question.options.length > PENDING_LIMITS.options) {
      throw new BridgeError('bridge_error', TOO_LARGE_TO_SHOW);
    }
    const options = [];
    for (const option of question.options) {
      const label = boundedNativeText(option?.label, PENDING_LIMITS.optionLabel);
      // An option the phone cannot name is not an option: refusing the whole
      // form is the only honest answer, because dropping it would shrink the
      // set of choices the native form really offered.
      if (label.length === 0) throw new BridgeError('bridge_error', TOO_LARGE_TO_SHOW);
      const mapped = { label };
      const description = boundedOptionalNativeText(option?.description, PENDING_LIMITS.optionDescription);
      if (description !== undefined) mapped.description = description;
      options.push(mapped);
    }
    if (options.length > 0) entry.options = options;
  }
  if (question?.multiSelect === true) entry.multiSelect = true;
  return entry;
}

/**
 * The real pending questions of one session, or `undefined` when none wait.
 *
 * A batch or a question that exceeds what the phone can present, or a state this
 * build does not know, refuses the whole read with a clear reason: presenting a
 * partial form would let somebody answer a question they cannot fully see.
 */
function mapPendingQuestions(value) {
  const active = activeQuestionBatches(value);
  if (active.length === 0) return undefined;
  if (active.length > PENDING_LIMITS.batches) {
    throw new BridgeError('bridge_error', TOO_LARGE_TO_SHOW);
  }
  return active.map((batch) => {
    const state = String(batch?.state ?? '');
    if (state !== 'open' && state !== 'continued') {
      throw new BridgeError('bridge_error', 'a question is waiting here in a state this bridge does not understand; answer it on the computer');
    }
    const callId = typeof batch?.callId === 'string' ? batch.callId.trim() : '';
    if (callId.length === 0) throw new BridgeError('bridge_error', TOO_LARGE_TO_SHOW);
    const questions = Array.isArray(batch?.questions) ? batch.questions : [];
    if (questions.length === 0 || questions.length > PENDING_LIMITS.questions) {
      throw new BridgeError('bridge_error', TOO_LARGE_TO_SHOW);
    }
    return { callId, state, questions: questions.map(mapPendingQuestion) };
  });
}

/**
 * The `ask_user_question` calls one session page carries, in log order.
 *
 * The native session log records the call and its result as a pair:
 * `tool/call` carries `{turn, step, callId, name, arguments}` and `tool/result`
 * carries `{turn, step, message}`, where `message.toolCallId` is the same call id
 * (`dsh-agent-loop/lib/index.js`, `appendToolCall` / `appendToolResult`, which
 * also links the result to its call with `sourceEventSeqs`). A call with no
 * recorded result is therefore a call that is **still running** - which is
 * exactly the window an `ask_user_question` waterfall exists in.
 *
 * A call the model made through PTC (`run_code`) is **not** a `tool/call` at all:
 * native records it as the pair `tool/ptc-dispatch-start` / `tool/ptc-dispatch`,
 * with `{rootCallId, parentCallId, subCallId, name, arguments}`
 * (verified against `dsh-tools/lib/index.js` lines 1354-1360 and 1331-1340, and
 * against a real session log). Those subcalls are deliberately **not** mixed into
 * the list below: their `turn`/`step` are absent, so letting them into the same
 * newest-call ordering would corrupt it for the top-level calls this list is
 * about. They are read by {@link scanPtcQuestionCalls} instead.
 * @param {unknown} records `session/page` records
 * @returns {{seq: number|null, turn: number|null, callId: string, name: string, arguments: string|null}[]}
 */
function scanToolCalls(records) {
  const calls = [];
  const results = new Map();
  for (const record of Array.isArray(records) ? records : []) {
    const event = record?.event ?? record;
    if (event === null || typeof event !== 'object') continue;
    const data = event.data ?? {};
    if (event.type === 'tool/result') {
      const callId = boundedIdentifier(data.message?.toolCallId ?? data.toolCallId, EVENT_LIMITS.callId);
      if (callId !== null) results.set(callId, true);
      continue;
    }
    if (event.type !== 'tool/call') continue;
    const callId = boundedIdentifier(data.callId, EVENT_LIMITS.callId);
    const name = boundedIdentifier(data.name, EVENT_LIMITS.toolName);
    if (callId === null || name === null) continue;
    const argumentsText = typeof data.arguments === 'string' ? data.arguments : null;
    calls.push({
      seq: Number.isInteger(event.seq) ? event.seq : null,
      turn: Number.isInteger(data.turn) ? data.turn : null,
      callId,
      name,
      arguments: argumentsText !== null && argumentsText.length <= EVENT_LIMITS.reason * 32 ? argumentsText : null,
    });
  }
  return calls.filter((call) => !results.has(call.callId));
}

/** The bounded `subCallId` of one native PTC record, or `null` when it has none. */
function ptcSubCallIdOf(data) {
  return boundedIdentifier(data.subCallId, EVENT_LIMITS.callId);
}

/**
 * Every `ask_user_question` subcall one session page shows as PTC activity.
 *
 * The pair `tool/ptc-dispatch-start` (appended **before** the subcall executes) and
 * `tool/ptc-dispatch` (appended **after** it settles) is the whole record. A start
 * is therefore an unresolved call - exactly the window an `ask_user_question`
 * waterfall exists in - and its own persisted `subCallId`, `parentCallId` and
 * `rootCallId` are the real identity and the real relation, not a correlation this
 * bridge has to invent.
 * @param {unknown} records `session/page` records
 * @param {Set<string>} [allowedNames] the tool names worth carrying; all names when omitted
 * @returns {{seq: number|null, subCallId: string, parentCallId: string|null, rootCallId: string|null, name: string, arguments: unknown, isError: boolean|null}[]}
 */
function scanPtcQuestionCalls(records, allowedNames = null) {
  const starts = new Map();
  const completions = new Map();
  for (const record of Array.isArray(records) ? records : []) {
    const event = record?.event ?? record;
    if (event === null || typeof event !== 'object') continue;
    const data = event.data;
    if (data === null || typeof data !== 'object' || Array.isArray(data)) continue;
    if (event.type === 'tool/ptc-dispatch') {
      const subCallId = ptcSubCallIdOf(data);
      if (subCallId !== null) completions.set(subCallId, data.isError === true);
      continue;
    }
    if (event.type !== 'tool/ptc-dispatch-start') continue;
    const subCallId = ptcSubCallIdOf(data);
    const name = boundedIdentifier(data.name, EVENT_LIMITS.toolName);
    if (subCallId === null || name === null) continue;
    if (allowedNames !== null && !allowedNames.has(name)) continue;
    starts.set(subCallId, {
      seq: Number.isInteger(event.seq) ? event.seq : null,
      subCallId,
      parentCallId: boundedIdentifier(data.parentCallId, EVENT_LIMITS.callId),
      rootCallId: boundedIdentifier(data.rootCallId, EVENT_LIMITS.callId),
      name,
      arguments: data.arguments,
    });
  }
  // The completeness is read from the whole page, never from the order the two
  // records happen to appear in: a settle is a start's result wherever it sits.
  for (const call of starts.values()) {
    call.isError = completions.has(call.subCallId) ? completions.get(call.subCallId) : null;
  }
  return [...starts.values()];
}

/**
 * The distinct `subCallId`s of one page whose logged name is `ask_user_question`.
 *
 * The name is taken from the record, never from the boundary of a `run_code`
 * program: a subcall of any other tool is not a question.
 * @param {unknown} records `session/page` records
 * @returns {string[]}
 */
function ptcQuestionSubCallIds(records) {
  return scanPtcQuestionCalls(records, new Set(['ask_user_question'])).map((call) => call.subCallId);
}

/**
 * The newest unresolved call of a page, whatever tool it belongs to.
 *
 * The tool name is deliberately **not** filtered here: a live legacy waterfall
 * belongs to the newest still-running call, so a newer call of another tool means
 * the request this bridge holds is not the newest one and cannot be told apart -
 * which the caller refuses. Filtering by name first would silently skip past that
 * newer call and answer an older one instead.
 */
function newestOpenToolCall(open) {
  let newest = null;
  for (const call of open) {
    if (newest === null || isLaterToolCall(call, newest)) newest = call;
  }
  return newest;
}

/** Whether one tool call comes after another in the session log. */
function isLaterToolCall(call, other) {
  if (call.turn !== null && other.turn !== null) {
    if (call.turn !== other.turn) return call.turn > other.turn;
    return (call.seq ?? -1) > (other.seq ?? -1);
  }
  return (call.seq ?? -1) > (other.seq ?? -1);
}

/** One bounded native sentence, or `null` when it is missing or too long to hold. */
function optionalNativeString(value, limit) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') return undefined;
  const text = sanitizeNativeText(value);
  return [...text].length > limit ? undefined : text;
}

/** One native sentence that must fit the bound, or `null` when it does not. */
function boundedNativeField(value, limit) {
  if (typeof value !== 'string') return null;
  const text = sanitizeNativeText(value);
  return [...text].length > limit ? null : text;
}

/** One option as both the logged arguments and the service request spell it. */
function comparableOption(value, limits) {
  const label = boundedNativeField(value?.label, limits.optionLabel);
  if (label === null) return undefined;
  const description = optionalNativeString(value?.description, limits.optionDescription);
  if (description === undefined) return undefined;
  return { label, description };
}

/** One question as both the logged arguments and the service request spell it. */
function comparableQuestion(value, limits) {
  const id = boundedIdentifier(value?.id, limits.callId);
  const question = boundedNativeField(value?.question, limits.questionText);
  if (id === null || question === null) return undefined;
  const header = optionalNativeString(value?.header, limits.header);
  if (header === undefined) return undefined;
  const entry = { id, question, header };
  if (value?.options !== undefined && value?.options !== null) {
    if (!Array.isArray(value.options) || value.options.length > limits.options) return undefined;
    const options = [];
    for (const option of value.options) {
      const mapped = comparableOption(option, limits);
      if (mapped === undefined) return undefined;
      options.push(mapped);
    }
    entry.options = options;
  }
  return entry;
}

/** Whether two comparable questions are the same native question, field for field. */
function sameComparableQuestion(left, right) {
  if (left.id !== right.id || left.question !== right.question) return false;
  if (left.header !== right.header) return false;
  const leftOptions = left.options ?? null;
  const rightOptions = right.options ?? null;
  if (leftOptions === null || rightOptions === null) return leftOptions === rightOptions;
  if (leftOptions.length !== rightOptions.length) return false;
  return leftOptions.every(
    (option, index) =>
      option.label === rightOptions[index].label &&
      (option.description ?? null) === (rightOptions[index].description ?? null),
  );
}

/**
 * Whether the form a legacy waterfall carried is exactly the form this tool call asked.
 *
 * Both sides are the same native data reached two ways: the waterfall carries the
 * service vocabulary (`multiSelect`, `options[].label/description`), while the
 * logged arguments carry the tool schema's (`multi_select`) and are read back
 * through `questionSchema`'s own transform (`dsh-user-questions/lib/index.js`). A
 * question carrying a field the tool map drops - `detail`, say - is therefore not
 * this call's form, and is refused rather than approximated.
 *
 * The logged side is spelled two ways by native itself, so both are accepted:
 * a top-level `tool/call` stores `arguments` as a **JSON string**, while a PTC
 * `tool/ptc-dispatch-start` stores the same detached JSON value as an **object**
 * (`dsh-tools/lib/index.js`, `jsonNormalizeArgs`, whose `logged` value is what
 * both records carry). Anything else - a primitive, an array, unparseable text -
 * is not a readable form and cannot be matched.
 * @param {string|object} loggedArguments the logged arguments, in either native spelling
 * @param {object[]} questions the questions the waterfall carried
 */
function sameQuestionForm(loggedArguments, questions) {
  if (!Array.isArray(questions) || questions.length === 0) return false;
  let parsed = loggedArguments;
  if (typeof parsed === 'string') {
    try {
      parsed = JSON.parse(parsed);
    } catch {
      return false;
    }
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return false;
  if (!Array.isArray(parsed.questions) || parsed.questions.length !== questions.length) return false;
  for (let index = 0; index < questions.length; index += 1) {
    const asked = comparableQuestion(parsed.questions[index], EVENT_LIMITS);
    const carried = comparableQuestion(questions[index], EVENT_LIMITS);
    if (asked === undefined || carried === undefined) return false;
    if (Boolean(parsed.questions[index]?.multi_select) !== Boolean(questions[index]?.multiSelect)) return false;
    for (const key of Object.keys(parsed.questions[index] ?? {})) {
      if (!['id', 'question', 'header', 'options', 'multi_select'].includes(key)) return false;
    }
    if (!sameComparableQuestion(asked, carried)) return false;
  }
  return true;
}

/**
 * Correlate one legacy blocking question request with the exact tool call it belongs to.
 *
 * A legacy request carries no call id at all, so the only way to answer it under
 * the identity the phone must use is to find the live `ask_user_question` call
 * whose own logged arguments are exactly the questions the request carried, in a
 * call that has no recorded result yet.
 *
 * Fail-closed, and bounded to the current open turn: the search widens to the
 * whole page only when the log carries no turn markers at all. The **newest**
 * unresolved `ask_user_question` call is the only call a live waterfall can
 * belong to, and it must match the carried form exactly - so two identical open
 * calls, a newer different call, or an unreadable arguments payload all return
 * `null` rather than attach one call's answer to another's questions.
 *
 * @param {unknown} records the same page the questions are presented from
 * @param {object[]} questions the questions the legacy request carried
 * @returns {{callId: string, turn: number|null}|null}
 */
function correlateLegacyQuestionCall(records, questions) {
  const open = scanToolCalls(records);
  if (open.length === 0) return null;
  const turns = open.map((call) => call.turn);
  const scoped = turns.every((turn) => turn !== null) ? open.filter((call) => call.turn === Math.max(...turns)) : open;
  const newest = newestOpenToolCall(scoped);
  // Only an `ask_user_question` call asks a question, and only this one can be the
  // call the held waterfall belongs to.
  if (newest === null || newest.name !== 'ask_user_question') return null;
  if (!sameQuestionForm(newest.arguments, questions)) return null;
  return { callId: newest.callId, turn: newest.turn };
}

/**
 * The subcalls of one page that really are questions PTC asked, in log order.
 *
 * The name comes from each record's own `name`; nothing is read out of the
 * `run_code` program, and no gateway id or alias is worked back into a call id.
 * @param {unknown} records `session/page` records
 */
function ptcQuestionCalls(records) {
  return scanPtcQuestionCalls(records, new Set(['ask_user_question']));
}

/**
 * Whether one call - and every ancestor it depends on - is still open in this log.
 *
 * A call is open exactly when the log really shows it running: a top-level call
 * with no `tool/result`, a PTC subcall with no `tool/ptc-dispatch`. The chain is
 * walked through the persisted relation itself: a PTC subcall names its parent,
 * and the parent of a top-level call is nothing. Every link must be **present and
 * open** - an id that appears only as a parent, with neither a `tool/call` nor a
 * `tool/ptc-dispatch-start` of its own on this page, is not a call this bridge can
 * prove live, so the whole chain fails closed. So does a chain that already ended
 * (a result, a completion, a failed or cancelled run), a start that carries no
 * relation at all, a root that is not on the chain, and a relation that loops.
 * @param {unknown} records `session/page` records
 * @param {string} callId the call whose liveness must be shown
 */
function isLiveCallChain(records, callId) {
  const results = new Set();
  const calls = new Set();
  const starts = new Map();
  for (const record of Array.isArray(records) ? records : []) {
    const event = record?.event ?? record;
    if (event === null || typeof event !== 'object') continue;
    const data = event.data;
    if (data === null || typeof data !== 'object' || Array.isArray(data)) continue;
    if (event.type === 'tool/result') {
      const id = boundedIdentifier(data.message?.toolCallId ?? data.toolCallId, EVENT_LIMITS.callId);
      if (id !== null) results.add(id);
      continue;
    }
    if (event.type === 'tool/ptc-dispatch') {
      const id = ptcSubCallIdOf(data);
      if (id !== null) results.add(id);
      continue;
    }
    if (event.type === 'tool/call') {
      const id = boundedIdentifier(data.callId, EVENT_LIMITS.callId);
      if (id !== null) calls.add(id);
      continue;
    }
    if (event.type === 'tool/ptc-dispatch-start') {
      const id = ptcSubCallIdOf(data);
      if (id !== null && !starts.has(id)) starts.set(id, data);
    }
  }
  const seen = new Set();
  let current = callId;
  // The live top-level call the PTC chain hangs from, if it has one. It is the
  // only place a recorded `rootCallId` may legitimately point.
  let topLevel = null;
  while (true) {
    if (results.has(current) || seen.has(current)) return false;
    seen.add(current);
    const start = starts.get(current);
    if (start === undefined) {
      // `current` must really be an open top-level call of this page, not merely
      // an id somebody named.
      if (!calls.has(current)) return false;
      topLevel = current;
      break;
    }
    const parent = boundedIdentifier(start.parentCallId, EVENT_LIMITS.callId);
    if (parent === null) return false;
    current = parent;
  }
  // Every link of the chain must name the same root, and that root must be the
  // open top-level call this chain really hangs from: a `rootCallId` pointing at
  // any other call - another run_code, an id this page never shows - is not this
  // subcall's live run.
  for (const id of seen) {
    const start = starts.get(id);
    if (start !== undefined && boundedIdentifier(start.rootCallId, EVENT_LIMITS.callId) !== topLevel) return false;
  }
  return true;
}

/**
 * The PTC question call of one page with this exact `subCallId`, or `null`.
 *
 * This is how a settlement is routed to the right record shape: an id that native
 * recorded as a PTC subcall is settled by its `tool/ptc-dispatch`, an id it
 * recorded as a top-level call by its `tool/result`. Nothing is guessed from the
 * id's spelling - `:ptc:` is only ever a name native itself wrote in the record.
 * @param {unknown} records `session/page` records
 * @param {string} callId the subcall id to find
 */
function findPtcQuestionCall(records, callId) {
  for (const call of ptcQuestionCalls(records)) {
    if (call.subCallId === callId) return call;
  }
  return null;
}

/**
 * The exact live PTC subcall one held question belongs to, or `null`.
 *
 * A subcall answers this only when all of it is real:
 *   - its logged `name` is `ask_user_question` and its `subCallId` is addressable;
 *   - its logged `arguments` are exactly the form the request carried;
 *   - it has no `tool/ptc-dispatch` yet, and neither it nor any ancestor has ended,
 *     failed or been cancelled;
 *   - and it is the **only** *live* subcall carrying that form in the page. Two
 *     identical concurrent live subcalls cannot be told apart, so neither is used -
 *     the honest answer is that this bridge cannot say which call is waiting.
 *
 * The form match and the liveness are decided **together, per candidate**, before
 * anything is counted: a subcall that already settled - answered, or aborted the
 * way a native timeout/cancel leaves `ASK_ABORTED` behind - is not a call a held
 * waterfall can belong to, however exactly its form matches. Counting every
 * matching subcall of the whole page first would let the previous turn's settled
 * copies pile up as phantom ambiguity, so an ordinary repeat of the same form
 * would be refused forever. Only the live candidates compete for uniqueness.
 * @param {unknown} records `session/page` records
 * @param {object[]} questions the questions the legacy request carried
 * @returns {{callId: string, turn: null}|null}
 */
function correlatePtcQuestionCall(records, questions) {
  const matches = new Set();
  for (const call of ptcQuestionCalls(records)) {
    if (!sameQuestionForm(call.arguments, questions)) continue;
    // A completion of this very subcall is its end, whatever it says; and the
    // whole parent/root chain has to be open. A settled history entry is skipped,
    // never counted as a rival.
    if (call.isError !== null) continue;
    if (!isLiveCallChain(records, call.subCallId)) continue;
    matches.add(call.subCallId);
  }
  if (matches.size !== 1) return null;
  const [callId] = matches;
  return { callId, turn: null };
}

/**
 * Correlate one held legacy question request with the exact call it belongs to.
 *
 * Two genuine shapes exist, and both are native's own record of the call:
 *   - a **top-level** `ask_user_question` tool call, matched by
 *     {@link correlateLegacyQuestionCall} against the newest open call;
 *   - a **PTC** subcall (`run_code` -> `tools.ask_user_question(...)`), matched by
 *     {@link correlatePtcQuestionCall} through its own `subCallId` and live
 *     parent/root relation.
 *
 * When the page shows exactly one matching PTC subcall, that subcall is what the
 * held waterfall belongs to, and its real `subCallId` is the identity the phone
 * must answer under. Otherwise the top-level rule applies unchanged, so every
 * path this bridge already had keeps its exact behaviour.
 * @param {unknown} records the same page the questions are presented from
 * @param {object[]} questions the questions the legacy request carried
 * @returns {{callId: string, turn: number|null}|null}
 */
function correlateHeldQuestionCall(records, questions) {
  return correlateLegacyQuestionCall(records, questions) ?? correlatePtcQuestionCall(records, questions);
}

/**
 * The answer batch a recorded `ask_user_question` result carries, or `null`.
 *
 * Only a result that really belongs to this call counts, and native records that
 * result in the shape the call was made in:
 *   - a top-level call's `tool/result`, whose `message.toolCallId` (which native
 *     requires to equal `message.source.callId`) must be the call this bridge
 *     answered, must not be an error, and whose rendered value must be a real
 *     answer batch;
 *   - a PTC subcall's `tool/ptc-dispatch`, whose `subCallId` must be the call this
 *     bridge answered, under the same `parentCallId`/`rootCallId` the start
 *     carried, with `isError` false and no `error`, and whose `content` must be a
 *     real answer batch.
 * A PTC start with no completion, or a completion that belongs to another
 * subcall, another parent or the root of another `run_code`, proves nothing.
 * @param {unknown} records `session/page` records
 * @param {string} callId the answered call
 */
function recordedQuestionAnswers(records, callId) {
  const ptc = findPtcQuestionCall(records, callId);
  if (ptc !== null) {
    for (const record of Array.isArray(records) ? records : []) {
      const event = record?.event ?? record;
      if (event === null || typeof event !== 'object' || event.type !== 'tool/ptc-dispatch') continue;
      const data = event.data;
      if (data === null || typeof data !== 'object' || Array.isArray(data)) continue;
      if (ptcSubCallIdOf(data) !== callId) continue;
      if (data.isError === true || data.error !== undefined) return null;
      if (boundedIdentifier(data.parentCallId, EVENT_LIMITS.callId) !== ptc.parentCallId) return null;
      if (boundedIdentifier(data.rootCallId, EVENT_LIMITS.callId) !== ptc.rootCallId) return null;
      return containsAnswerBatch(data.content);
    }
    return null;
  }
  for (const record of Array.isArray(records) ? records : []) {
    const event = record?.event ?? record;
    if (event === null || typeof event !== 'object' || event.type !== 'tool/result') continue;
    const message = event.data?.message;
    if (message === null || typeof message !== 'object') continue;
    if (boundedIdentifier(message.toolCallId, EVENT_LIMITS.callId) !== callId) continue;
    if (event.data.error !== undefined || message.isError === true) return null;
    return containsAnswerBatch(message.content);
  }
  return null;
}

/**
 * The model the backend itself reports for a session (CRD 0008 §C).
 *
 * The `modelSelection` projection's wire view is `{lastUsed, next}` with
 * `next = pending ?? lastUsed` (verified in
 * `dsh-api-session-controller/lib/types/model-selection-projection.js`), so
 * `next` and then `lastUsed` is exactly "what the next message will use". A
 * chosen-but-not-yet-used preference is not proof of the model that ran, which
 * is why nothing else is read and nothing is guessed.
 */
function currentModelOf(selection) {
  if (selection === null || typeof selection !== 'object') return undefined;
  const candidate = selection.next ?? selection.lastUsed ?? null;
  if (candidate === null || typeof candidate !== 'object') return undefined;
  const model = typeof candidate.model === 'string' ? candidate.model.trim() : '';
  if (model.length === 0) return undefined;
  const entry = { model };
  const provider = typeof candidate.provider === 'string' ? candidate.provider.trim() : '';
  if (provider.length > 0) entry.provider = provider;
  const effort = typeof candidate.reasoningEffort === 'string' ? candidate.reasoningEffort.trim() : '';
  if (effort.length > 0) entry.reasoningEffort = effort;
  return entry;
}

/** DSH error code -> a contract code the desktop may send (§8.4.8). */
function mapRpcError(error) {
  const code = String(error?.code ?? '');
  if (code.endsWith('not-found')) return 'session_not_found';
  return 'bridge_error';
}

/**
 * The name of the first argument on the wire, per method.
 *
 * DSH's typert gateway checks the arg field against the remote signature's
 * parameter name, and the shipped catalogue (`typert.remote-client.d.ts`) writes
 * `list(_request: SessionListRequest, signal?)` for the list method and
 * `(request: ...)` for most others. Two cases are different in practice, both
 * observed on this machine:
 *   - sending `_request` to `session/page` is rejected with
 *     `missing "request"; unexpected "_request"`;
 *   - `session/modelCatalog` takes no parameter at all, and any field - including
 *     `request` - is rejected with `unexpected "request"`, so its `args` must be
 *     empty.
 * @returns {string|null} null means "send `args: {}`"
 */
const ARG_FIELD_BY_METHOD = {
  'session/list': '_request',
  'session/modelCatalog': null,
};

/**
 * Methods whose wire `args` ARE the descriptor's own named parameters, with no
 * single `request` wrapper.
 *
 * Verified in the installed gateway (`dsh-api-gateway/lib/index.js`,
 * `assertExactArguments` and `resolveReceiverContext`): `payload.args` must name
 * every wire parameter of the descriptor and nothing else. The
 * `userQuestions/answer` descriptor's parameters are `agentId` (an `agent`
 * lookup, whose wire type is a SessionId), `callId` and `answer` - so wrapping
 * them in `request` is refused with `unexpected "request"` and omitting
 * `agentId` with `missing "agentId"`.
 *
 * `$events/result` is the same shape for the same reason: it is a Gateway-owned
 * RPC whose whole payload is one Remote-event outcome (`parseRemoteEventResult`
 * demands exactly `clientId`, `eventId`, `outcome`), and it is claimed by the
 * Gateway (`claimsEndpoint` returns true before any descriptor is consulted).
 */
const RAW_ARG_METHODS = new Set(['userQuestions/answer', EVENT_RESULT_ENDPOINT]);

function argFieldName(method) {
  return Object.prototype.hasOwnProperty.call(ARG_FIELD_BY_METHOD, method) ? ARG_FIELD_BY_METHOD[method] : 'request';
}

/** The `payload.args` object one method call really sends. */
function argPayload(method, request) {
  if (RAW_ARG_METHODS.has(method)) return request ?? {};
  const field = argFieldName(method);
  return field === null ? {} : { [field]: request ?? {} };
}

/**
 * The `SessionAddress` for one session.
 *
 * A session that belongs to another session (a subagent session) must be
 * addressed through its parent, and the schema requires a `mode`:
 * `{kind:'subagent', parentSessionId, childSessionId, mode}`. The list answer
 * does not always say which mode, and `'unknown'` is one of the three legal
 * values, so that is what is sent when nothing better is known.
 * @param {string} sessionId
 * @param {{parentSessionId?: string|null, mode?: string|null}} [summary]
 */
function buildPageAddress(sessionId, summary = {}) {
  const parentSessionId = summary?.parentSessionId ?? null;
  if (typeof parentSessionId === 'string' && parentSessionId.length > 0) {
    const mode = summary?.mode;
    return {
      kind: 'subagent',
      parentSessionId,
      childSessionId: sessionId,
      mode: mode === 'one-shot' || mode === 'continuable' ? mode : 'unknown',
    };
  }
  return { kind: 'session', sessionId };
}

/** `updatedAt` may be milliseconds, seconds or an RFC3339 string. */
function toDshTimestamp(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return toRfc3339(new Date(value > 1e12 ? value : value * 1000));
  }
  if (typeof value === 'string' && value.length > 0) {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) return toRfc3339(parsed);
  }
  return toRfc3339(new Date());
}

function contentToText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => (typeof part === 'string' ? part : typeof part?.text === 'string' ? part.text : ''))
      .filter((text) => text.length > 0)
      .join('\n');
  }
  if (content !== null && typeof content === 'object' && typeof content.text === 'string') return content.text;
  return '';
}

const ROLE_MAP = {
  user: 'user',
  assistant: 'assistant',
  agent: 'assistant',
  system: 'system',
  tool: 'tool',
  toolResult: 'tool',
  reasoning: 'assistant',
};

/**
 * Session-log event type -> contract role (§4.4).
 *
 * The live backend names events with slashes: `user/message`, `assistant/message`,
 * `tool/call`, `tool/result`, and a stream of internal bookkeeping such as
 * `step/end` or reasoning blocks. Only the chat-bearing kinds are mapped; the
 * rest are skipped, because a placeholder line pretending to be a message is
 * worse than an honest omission.
 */
const EVENT_ROLE = {
  'user/message': 'user',
  'user/prompt': 'user',
  'assistant/message': 'assistant',
  'tool/call': 'tool',
  'tool/result': 'tool',
};

/** Part types that carry words the user wrote or read. Reasoning is not one. */
const TEXT_PART_TYPES = new Set(['text', 'input-text', 'inputText', 'output-text']);

/**
 * The visible text of a message: its `text` parts, and nothing else.
 *
 * A reasoning part is the model thinking to itself, not a message; mixing it into
 * the transcript would put words in the assistant's mouth. A `tool-call` part is
 * not text either.
 * @param {unknown} content
 */
function partsToText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const pieces = [];
  for (const part of content) {
    if (typeof part === 'string' && part.length > 0) {
      pieces.push(part);
      continue;
    }
    if (part === null || typeof part !== 'object') continue;
    if (typeof part.type !== 'string' || !TEXT_PART_TYPES.has(part.type)) continue;
    if (typeof part.text === 'string' && part.text.length > 0) pieces.push(part.text);
  }
  return pieces.join('\n');
}

/**
 * The text of one event, or an empty string when it carries no words.
 *
 * `data.message` is where the real payload lives: `{role, content, source, id}`.
 */
function eventText(event) {
  const data = event?.data ?? {};
  const message = data.message ?? data;
  if (typeof message === 'string') return message;
  const direct = partsToText(message?.content);
  if (direct.length > 0) return direct;
  if (typeof message?.text === 'string' && message.text.length > 0) return message.text;
  return '';
}

/** The role a chat-bearing event belongs to, or null when it is not chat. */
function eventRole(type, event) {
  if (EVENT_ROLE[type] !== undefined) return EVENT_ROLE[type];
  // An event type this build does not know may still say who wrote it.
  const role = String(event?.data?.message?.role ?? '').toLowerCase();
  if (role === 'user') return 'user';
  if (role === 'assistant') return 'assistant';
  return null;
}

/**
 * Source kinds that mean "the backend wrote this, a person did not".
 *
 * The live backend marks provenance natively: a message a human typed carries
 * `data.source = {kind:'user', rpcId, clientTimeZone}`, while the runtime context
 * and the skill catalog injected into the very same log carry
 * `{kind:'runtime-context', form:'snapshot', …}` and
 * `{kind:'skill-catalog', form:'catalog', …}` (see
 * `docs/evidence/injection-shapes-20261008.log`). Filtering on that field is
 * exact; filtering on the text would silently eat a user's own message the day
 * they paste something that looks similar.
 */
const INJECTED_SOURCE_KINDS = new Set(['runtime-context', 'skill-catalog', 'system-prompt', 'hook', 'synthetic', 'injected']);

/** The native provenance marker of one event, or null when it carries none. */
function sourceKindOf(event) {
  const source = event?.data?.source ?? event?.data?.message?.source ?? null;
  return typeof source?.kind === 'string' ? source.kind : null;
}

/**
 * Whether an event was injected by the backend rather than written by a person.
 *
 * No marker at all is **not** treated as injected: unknown provenance must never
 * cost the user a message they really sent.
 */
function isInjectedEvent(event) {
  const kind = sourceKindOf(event);
  return kind !== null && INJECTED_SOURCE_KINDS.has(kind);
}

/**
 * session/page `records` -> contract messages (§9.2), oldest first.
 *
 * Message ids are the session log's own `seq`, so the same message keeps the
 * same id across reads and the phone can de-duplicate. Events that carry no text
 * are skipped rather than turned into placeholders.
 * @param {object[]} records
 */
function recordsToMessages(records) {
  const messages = [];
  for (const record of Array.isArray(records) ? records : []) {
    const event = record?.event ?? record;
    if (event === null || typeof event !== 'object') continue;
    if (isInjectedEvent(event)) continue;
    const type = String(event.type ?? record?.type ?? '');
    const role = eventRole(type, event);
    if (role === null) continue;
    const text = eventText(event);
    if (text.length === 0) continue;
    const seq = event.seq ?? record?.seq;
    messages.push({
      id: seq === undefined || seq === null ? `seq-${messages.length}` : String(seq),
      role,
      text,
      timestamp: toDshTimestamp(event.time ?? event.timestamp ?? null),
    });
  }
  return messages;
}

/** One DSH history message -> a contract message (§9.2). */
function toMessages(items) {
  const messages = [];
  for (const item of Array.isArray(items) ? items : []) {
    const role = ROLE_MAP[String(item?.role ?? item?.author ?? 'system')] ?? 'system';
    const id = String(item?.id ?? item?.messageId ?? item?.seq ?? `m-${messages.length}`);
    messages.push({
      id,
      role,
      text: contentToText(item?.content ?? item?.text ?? item?.message ?? ''),
      timestamp: toDshTimestamp(item?.createdAt ?? item?.timestamp ?? item?.at ?? null),
    });
  }
  return messages;
}

/**
 * The local DSH HTTP client: one `client-request` per call, exact loopback
 * origin, cookie minted per request, no retries.
 */
class DshClient {
  /** @param {{baseUrl: string, secret: Buffer, timeoutMs?: number}} options */
  constructor(options) {
    this.baseUrl = options.baseUrl.replace(/\/$/, '');
    this.secret = options.secret;
    this.authority = new URL(this.baseUrl).host;
    this.timeoutMs = options.timeoutMs ?? RPC_TIMEOUT_MS;
  }

  get cookieName() {
    return cookieName(this.authority);
  }

  /** The exact loopback WebSocket route the Gateway's event mux listens on. */
  get streamUrl() {
    const secure = this.baseUrl.startsWith('https://');
    return `${secure ? 'wss' : 'ws'}://${this.authority}${REMOTE_STREAM_MUX_PATH}`;
  }

  /**
   * The handshake headers the local server's own fence and cookie check expect.
   *
   * Exactly the pair the unary calls above use: the exact loopback `Origin`, and
   * a freshly minted browser-session cookie. The secret never leaves this process
   * and is never put in a URL.
   */
  eventHeaders() {
    const cookie = mintCookie({ secret: this.secret, authority: this.authority });
    return { Origin: this.baseUrl, Cookie: `${cookie.name}=${cookie.value}` };
  }

  /**
   * One `$events/result`: the outcome of one forwarded Remote event.
   *
   * `args` is the whole payload (`{clientId, eventId, outcome}`) - see
   * {@link RAW_ARG_METHODS}. The server's `ok` acknowledges the transport only:
   * it answers `ok` even when the request was already decided by another client,
   * so nothing here may be read as "the permission was granted".
   */
  async postEventResult(args) {
    return this.call(EVENT_RESULT_ENDPOINT, args);
  }

  /**
   * One DSH RPC.
   * @param {string} method e.g. `session/list`
   * @param {object} request the method's request object
   * @returns {Promise<object>} `result.value`
   */
  async call(method, request) {
    const cookie = mintCookie({ secret: this.secret, authority: this.authority });
    const body = JSON.stringify({
      type: 'client-request',
      rpcId: crypto.randomUUID(),
      method,
      payload: { args: argPayload(method, request) },
    });
    const url = new URL(`${this.baseUrl}/api/${method}`);
    const response = await new Promise((resolve, reject) => {
      const req = http.request(
        {
          protocol: url.protocol,
          hostname: url.hostname,
          port: url.port,
          path: url.pathname,
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(body),
            // The exact loopback origin the local server expects, nothing else.
            Origin: this.baseUrl,
            Cookie: `${cookie.name}=${cookie.value}`,
          },
          timeout: this.timeoutMs,
        },
        (res) => {
          let text = '';
          res.setEncoding('utf8');
          res.on('data', (chunk) => (text += chunk));
          res.on('end', () => resolve({ status: res.statusCode, text }));
        },
      );
      req.on('timeout', () => {
        req.destroy(new Error('timed out'));
      });
      req.on('error', reject);
      req.end(body);
    });
    if (response.status === 401) {
      throw new BridgeError('bridge_error', 'the DSH backend refused this local session');
    }
    let parsed;
    try {
      parsed = JSON.parse(response.text);
    } catch {
      throw new BridgeError('bridge_error', 'the DSH backend answered with something that is not JSON');
    }
    const result = parsed?.result ?? parsed;
    if (result === null || typeof result !== 'object') {
      throw new BridgeError('bridge_error', 'the DSH backend answered with an empty result');
    }
    if (result.ok === false) {
      throw new BridgeError(mapRpcError(result.error), safeMessage(result.error?.message ?? '', 'bridge_error'));
    }
    return result.value ?? result;
  }
}

/** The DSH Desktop side of the bridge. */
class DshAdapter {
  /**
   * @param {{client: DshClient, backend?: object, summaryTtlMs?: number,
   *   workspaceCatalogPath?: string|null, events?: object|null, settleDelayMs?: number}} options
   */
  constructor(options) {
    this.client = options.client;
    this.backend = options.backend ?? { baseUrl: options.client.baseUrl };
    this.summaries = new Map();
    /**
     * The native event stream (`approval/request` and `user-questions/request`).
     *
     * It is optional on purpose: an adapter used for a read-only task without one
     * still lists, reads and sends exactly as before - it simply has no pending
     * approvals and no way to answer an `open` question, and says so instead of
     * pretending. The live bridge always wires one up in {@link DshAdapter.open}.
     *
     * `false` is `open`'s explicit "no stream for this task" spelling, and it means
     * exactly the same thing here as `null`: **no stream**, never a stream-shaped
     * falsy value. Normalizing at the door is what keeps every reader - the list,
     * the read, the approval and the answer paths - on one honest "there is no
     * stream" branch, instead of reaching into `false` and failing with a TypeError.
     */
    this.events = options.events === false ? null : options.events ?? null;
    /**
     * Where the registered-workspace catalog is read from. `null` means the
     * `DSH_HOME` / `~/.dsh` default (see `workspaceCatalogPath`); an explicit
     * path is what a user with a relocated profile configures.
     */
    this.workspaceCatalogPath = options.workspaceCatalogPath ?? null;
    /**
     * How long a list summary may be trusted for `running`/`title`.
     *
     * The phone polls `session.read` every 2 seconds, and the session's own log
     * cut is always fetched fresh; this only bounds how often the (much heavier)
     * session list is asked again for the running state, so a reply that arrives
     * later is not lost behind a cached "idle".
     */
    this.summaryTtlMs = options.summaryTtlMs ?? 2000;
    /**
     * How long to keep re-reading native state after a submission before giving up
     * on *proving* it landed. This never changes what was submitted - it only
     * decides whether the answer may say `confirmed` instead of `submitted`.
     */
    this.settleDelayMs = options.settleDelayMs ?? 200;
    this.settleAttempts = options.settleAttempts ?? 3;
    /**
     * The approvals being decided right now, keyed by session + native request id.
     *
     * Reading the native audit before submitting takes a real round trip, so two
     * concurrent taps for the same request would both get past the "is it still
     * live" check and both submit. This is the lock that makes exactly one of them
     * reach native; the other is refused, never deferred.
     */
    this.approvalsInFlight = new Set();
  }

  /**
   * Open the adapter against the backend that is already running.
   *
   * `events: false` is the explicit "a read-only task, no stream" request: the
   * adapter is built without one and no `$events` stream is opened at all, so an
   * open/read/list on that adapter is inert with respect to native events. Any
   * other value (a stream instance, or nothing) keeps the default live behaviour.
   *
   * `secret` is the same override {@link discoverBackend} documents: when it is
   * absent the local browser-session credential is read from this computer's own
   * store, which is what the live bridge always does.
   * @param {{configuredPort?: number, credentialsPath?: string, secret?: Buffer, events?: object|false}} [options]
   */
  static async open(options = {}) {
    const found = await discoverBackend(options);
    if (found === null) {
      throw new BridgeError('bridge_error', 'no DSH backend answered on loopback');
    }
    writePortHint(found.port);
    const client = new DshClient({ baseUrl: found.baseUrl, secret: found.secret });
    const adapter = new DshAdapter({
      client,
      backend: { port: found.port, baseUrl: found.baseUrl },
      workspaceCatalogPath: options.workspaceCatalogPath ?? null,
      events: options.events === false ? null : options.events ?? null,
    });
    // `events: false` is the explicit "a read-only task, no stream" request; by
    // default the live bridge carries one.
    if (options.events !== false) {
      // A best-effort background stream: it may not be what makes the bridge fail
      // to start, and everything it carries is absent-and-honest while it is down.
      adapter.startEventStream();
    }
    return adapter;
  }

  /**
   * Start the native event stream, if this adapter has one.
   *
   * The stream is what makes `session.approve:dsh` real and what gives an `open`
   * question an answer path at all. It connects on its own and reconnects with
   * backoff; nothing waits for it, and a stream that never comes up costs the
   * bridge nothing but those two abilities.
   */
  startEventStream() {
    if (this.events === null) {
      if (typeof this.client?.postEventResult !== 'function' || typeof this.client?.streamUrl !== 'string') {
        return null;
      }
      this.events = new DshEventStream({
        wsUrl: this.client.streamUrl,
        headers: () => this.client.eventHeaders(),
        sendResult: (args) => this.client.postEventResult(args),
      });
    }
    this.events.start();
    return this.events;
  }

  /** Never includes the secret; safe to log and to show in the local UI. */
  describe() {
    return {
      baseUrl: this.backend.baseUrl,
      port: this.backend.port ?? null,
      pid: this.backend.pid ?? null,
      sessions: this.summaries.size,
      hasLocalCredential: true,
      // Real numbers only: whether the native event stream is up, and how much
      // genuine native state it is holding right now.
      events: this.events === null ? null : this.events.describe(),
    };
  }

  /** DSH exposes `session/cancel`, so stopping a running turn is real here. */
  canStop() {
    return true;
  }

  /**
   * DSH really offers `session/selectModel`, so a next-message model is real
   * here.
   *
   * One honest caveat, from the native source rather than from this bridge: that
   * call does not only set the next message's model. It also persists the
   * selection as the agent's default in the background
   * (`dsh-api-session-controller/lib/index.js` -> `selectModel(request)`, which
   * awaits `agentDefaultModel.saveSelection(selected)`), so a model chosen for
   * one message also becomes the default later sessions start from. Nothing here
   * hides that or tries to undo it - the app's own behaviour is what the user
   * gets.
   */
  canSendWithModel() {
    return true;
  }

  /**
   * DSH answers a native question two ways, and both are real.
   *
   * A `continued` question goes back through the scoped unary
   * `userQuestions/answer`. A question that is still `open` - the tool call is
   * inside its wait right now - has no unary path at all (the shipped
   * `dsh-user-questions` README: "while the tool call is open, the only answer
   * path is that request"); it is decided by answering the forwarded
   * `user-questions/request` waterfall, which this adapter holds through its
   * native event stream. When no such waterfall is held, the honest answer is that
   * it cannot be answered from here, so the capability stays true while an
   * unanswerable `open` question is refused with a pointer to the computer.
   */
  canAnswer() {
    return true;
  }

  /**
   * Whether a genuine native permission approval can be decided from here.
   *
   * DSH forwards `approval/request` as a Remote waterfall over its own event mux,
   * and the outcome is a single one-shot grant (`allowed-once`) or a rejection.
   * That is a real ability, not a guess: the installed `dsh-api-remotes` allowlist
   * plus the Gateway's `$events/result` RPC are the transport. Nothing here can
   * change a policy, and nothing is ever approved automatically.
   */
  canApprove() {
    return true;
  }

  /** The pending approvals native really has waiting for one session. */
  pendingApprovalsOf(sessionId) {
    if (this.events === null) return [];
    return this.events.approvalsFor(sessionId);
  }

  /**
   * The real model catalog of this machine, plus the real registered projects.
   *
   * `session/modelCatalog` takes **no** request parameter (`args: {}`), and the
   * answer carries `{default, routableProviders, groups, failures}`. A model id
   * is only half the identity here - `deepseek-flash` exists under three
   * providers on this machine - so `provider` is kept on every entry and the
   * default is marked on the exact pair the backend named.
   *
   * The projects come from the durable workspace catalog (read-only). A catalog
   * that cannot be read costs the projects, never the models: the answer is an
   * empty `projects` plus a safe `reason` telling the truth about it.
   * @returns {Promise<{models: object[], defaultEntry: object|null, projects: object[], reason: string|null}>}
   */
  async listModels(options = {}) {
    const catalog = await this.client.call('session/modelCatalog', {});
    const groups = Array.isArray(catalog?.groups) ? catalog.groups : [];
    const fallback = catalog?.default ?? null;
    const models = [];
    for (const group of groups) {
      const provider = String(group?.id ?? '');
      for (const model of Array.isArray(group?.models) ? group.models : []) {
        const id = String(model?.id ?? '');
        if (id.length === 0 || provider.length === 0) continue;
        const efforts = reasoningEffortsOf(model?.reasoning);
        const entry = {
          id,
          label: String(model?.name ?? id),
          provider,
          reasoningEfforts: efforts.list,
        };
        if (efforts.defaultEffort !== null) entry.defaultReasoningEffort = efforts.defaultEffort;
        if (fallback !== null && String(fallback.provider) === provider && String(fallback.model) === id) {
          entry.isDefault = true;
          if (typeof fallback.reasoningEffort === 'string') entry.defaultReasoningEffort = fallback.reasoningEffort;
        }
        models.push(entry);
      }
    }
    const workspaces = await readWorkspaceCatalog({ configuredPath: this.workspaceCatalogPath });
    return { models, defaultEntry: fallback, projects: workspaces.projects, reason: workspaces.reason };
  }

  /**
   * Create a session and put the chosen model on it.
   *
   * DSH's `session/create` has no model field at all, so the order is fixed:
   * `session/create` → `session/selectModel` (provider + model + reasoningEffort)
   * → the optional first prompt. If a later step fails the created session id is
   * still reported: the user must be able to open the session that now exists
   * instead of tapping "new chat" again and getting a second one.
   * @param {{model: string, provider: string, reasoningEffort?: string, cwd?: string, text?: string}} input
   * @param {{onCreated?: (created: {sessionId: string}) => void}} [hooks]
   */
  async createSession(input, hooks = {}) {
    const request = await this.createRequestOf(input);
    const created = await this.client.call('session/create', request);
    const sessionId = String(created?.sessionId ?? created?.id ?? '');
    if (sessionId.length === 0) {
      throw new BridgeError('session_create_failed', 'the DSH backend did not return a session id');
    }
    const outcome = { sessionId, title: typeof created?.title === 'string' ? created.title : undefined };
    // Persist the id the moment it exists, before anything else can fail.
    if (typeof hooks.onCreated === 'function') {
      hooks.onCreated({ sessionId });
    }
    try {
      await this.client.call('session/selectModel', {
        sessionId,
        provider: input.provider,
        model: input.model,
        ...(typeof input.reasoningEffort === 'string' && input.reasoningEffort.length > 0
          ? { reasoningEffort: input.reasoningEffort }
          : {}),
      });
    } catch (error) {
      return { ...outcome, partial: true, incomplete: 'the model could not be selected', cause: error };
    }
    if (typeof input.text === 'string' && input.text.length > 0) {
      try {
        await this.client.call('session/prompt', {
          requestId: crypto.randomUUID(),
          sessionId,
          mode: 'queue',
          content: [{ type: 'text', text: input.text }],
          clientTimeZone: DEFAULT_CLIENT_TIME_ZONE,
        });
      } catch (error) {
        return { ...outcome, partial: true, incomplete: 'the first message could not be sent', cause: error };
      }
    }
    return outcome;
  }

  /**
   * Decide what `session/create` may be asked for (CRD 0008 §A).
   *
   * A selected `projectId` is really a DSH workspace id, and it is checked
   * against the live registered-workspace catalog before anything is created: an
   * id this computer does not know is refused, never sent, and the catalog is
   * only ever read. When the request names both a project and a directory the
   * two must agree - a cwd that contradicts the chosen project would open the
   * chat somewhere the user did not choose.
   *
   * **Exactly one of the two fields is ever sent.** The native
   * `session/create` rejects a request that carries both `workspaceId` and
   * `cwd`, even when they name the same directory, with `gateway/bad-request`
   * before it creates anything (primary source:
   * `dsh-api-session-controller/lib/index.js`, `async create(request)`). So a
   * validated project becomes `workspaceId` and the directory is dropped from
   * the call, and when only a directory is given a registered workspace with
   * that path is preferred - the one case where a directory and a workspace can
   * both be true - so nothing extra is asked for and the same folder does not
   * collect a second workspace entry.
   * @param {{projectId?: string, cwd?: string}} input
   * @returns {Promise<{workspaceId?: string, cwd?: string}>}
   */
  async createRequestOf(input) {
    const projectId = typeof input.projectId === 'string' && input.projectId.length > 0 ? input.projectId : null;
    const cwd = typeof input.cwd === 'string' && input.cwd.length > 0 ? input.cwd : null;
    if (projectId === null && cwd === null) return {};
    const catalog = await readWorkspaceCatalog({ configuredPath: this.workspaceCatalogPath });
    if (projectId !== null) {
      const known = catalog.projects.find((project) => project.id === projectId);
      if (known === undefined) {
        throw new BridgeError('session_create_failed', 'that project is not one of the DSH workspaces registered on this computer');
      }
      if (cwd !== null && normalizeWorkspacePath(cwd) !== normalizeWorkspacePath(known.cwd)) {
        throw new BridgeError('session_create_failed', 'that directory is not the project this chat was asked to open in');
      }
      return { workspaceId: known.id };
    }
    const matched = catalog.projects.find((project) => normalizeWorkspacePath(project.cwd) === normalizeWorkspacePath(cwd));
    return matched === undefined ? { cwd } : { workspaceId: matched.id };
  }

  /**
   * Put one model selection on a session, after checking it against the catalog
   * the backend reports right now (CRD 0008 §B).
   *
   * `session/create` has no model field, so this is a separate native call - and
   * it happens BEFORE the prompt. A selection that fails must leave nothing
   * sent: a message posted with the wrong model is worse than a message the user
   * has to send again, and there is no hidden retry either way.
   *
   * It is deliberately NOT undone on a later failure: the native call also saves
   * the selection as this agent's default for later sessions, and a bridge that
   * tried to restore the previous value would be writing user-facing state it
   * was never asked to write.
   */
  async selectModel(sessionId, { model, provider, reasoningEffort }) {
    if (typeof provider !== 'string' || provider.length === 0) {
      throw new BridgeError('invalid_params', 'a DSH model needs its provider');
    }
    const catalog = await this.client.call('session/modelCatalog', {});
    const groups = Array.isArray(catalog?.groups) ? catalog.groups : [];
    const group = groups.find((candidate) => String(candidate?.id ?? '') === provider);
    if (group === undefined) {
      throw new BridgeError('model_not_available', 'that model is not offered by that provider on this computer');
    }
    const entry = (Array.isArray(group.models) ? group.models : []).find((candidate) => String(candidate?.id ?? '') === model);
    if (entry === undefined) {
      throw new BridgeError('model_not_available', 'that model is not offered by that provider on this computer');
    }
    const request = { sessionId, provider, model };
    if (typeof reasoningEffort === 'string' && reasoningEffort.length > 0) {
      // Fail closed when the fresh catalogue declares no effort for this model:
      // an effort nobody could check must not be forwarded, because a wrong one
      // is a native selection the user did not ask for. The phone cannot send
      // this combination anyway - `models.list` only offers efforts a model
      // really declares - so this only ever refuses a hand-made request.
      const efforts = reasoningEffortsOf(entry.reasoning).list;
      if (!efforts.includes(reasoningEffort)) {
        throw new BridgeError('invalid_params', 'that reasoning effort is not offered for this model');
      }
      request.reasoningEffort = reasoningEffort;
    }
    await this.client.call('session/selectModel', request);
  }

  /** The model selection the backend really persisted for a session. */
  async modelSelectionOf(sessionId) {
    const projections = await this.client.call('session/projections', { sessionId });
    const selection = projections?.values?.modelSelection ?? projections?.modelSelection ?? null;
    return selection;
  }

  /** §9.1 for the DSH sessions. */
  async listSessions() {
    const value = await this.client.call('session/list', {});
    const items = Array.isArray(value?.items) ? value.items : [];
    this.summaries = new Map();
    const sessions = [];
    for (const item of items) {
      const id = String(item?.sessionId ?? item?.id ?? '');
      if (!isSessionId(id)) continue;
      // The title lives under projections.values.title in the real answer; the
      // flat `title` field is accepted too, so a shape change does not blank it.
      const projected = item?.projections?.values ?? {};
      const title = String(item?.title ?? projected.title ?? '').trim();
      const asOfSeq = Number.isInteger(item?.projections?.asOfSeq) ? item.projections.asOfSeq : null;
      // CRD 0008 §E + requirement F: the badge comes from real native pending
      // state only - a question the backend really has waiting, one the native
      // event stream is really holding the answer channel of (a legacy blocking
      // request, which the projection never tracks), or an approval the native
      // event stream really delivered for this exact session. The field is present
      // only when something really waits; absent means "this bridge saw no
      // evidence", never "nothing is waiting".
      const needsInput =
        activeQuestionBatches(projected.userQuestions).length > 0 ||
        this.pendingApprovalsOf(id).length > 0 ||
        this.events?.hasLegacyQuestion?.(id) === true;
      const summary = {
        parentSessionId: typeof item?.parentSessionId === 'string' ? item.parentSessionId : null,
        mode: typeof item?.mode === 'string' ? item.mode : null,
        running: item?.running === true,
        agentAvailable: item?.agentAvailable === true,
        asOfSeq,
        fetchedAt: Date.now(),
        needsInput,
        title: title.length > 0 ? title : `DSH session ${id.slice(0, 8)}`,
      };
      this.summaries.set(id, summary);
      const session = {
        id,
        tool: 'dsh',
        title: summary.title,
        status: summary.running ? 'working' : 'idle',
        updatedAt: toDshTimestamp(item?.updatedAt),
        cwd: typeof item?.cwd === 'string' && item.cwd.length > 0 ? item.cwd : null,
      };
      if (needsInput) session.needsInput = true;
      sessions.push(session);
    }
    return sessions;
  }

  /**
   * The log cut a page must be asked for, always freshly.
   *
   * `throughSeq` is an inclusive cut over the session log, and the server's own
   * controller turns `-1` into a cut of zero - a page with no records at all. So
   * the cut has to be a real seq that is current *now*: taking it once and caching
   * it would pin every later read to the log position of the first call, and a
   * reply that arrived afterwards would never be visible to the phone.
   * @param {string} sessionId
   * @returns {Promise<number>}
   */
  async projectionsOf(sessionId) {
    return this.client.call('session/projections', { sessionId });
  }

  async logCut(sessionId, projections) {
    const value = projections ?? (await this.projectionsOf(sessionId));
    if (Number.isInteger(value?.asOfSeq)) {
      return value.asOfSeq;
    }
    throw new BridgeError('bridge_error', 'the DSH backend did not report a session log position');
  }

  /**
   * Refresh `running`/`title` when the cached summary has gone stale.
   *
   * The list is much heavier than one session's projections, so it is asked at
   * most once per `summaryTtlMs`; the failing case this avoids is a session that
   * reads as `idle` for ever because nothing ever asked again.
   */
  async freshSummary(sessionId) {
    const cached = this.summaries.get(sessionId);
    const now = Date.now();
    if (cached !== undefined && now - cached.fetchedAt < this.summaryTtlMs) {
      return cached;
    }
    await this.listSessions();
    const refreshed = this.summaries.get(sessionId);
    if (refreshed === undefined) {
      throw new BridgeError('session_not_found', 'that DSH session does not exist');
    }
    return refreshed;
  }

  /** §9.2, read-only: `session/page` never changes the session. */
  async readSession(sessionId) {
    if (!isSessionId(sessionId)) {
      throw new BridgeError('invalid_params', 'a session id is required');
    }
    const summary = await this.freshSummary(sessionId);
    // One projections call carries both the fresh log cut and the native
    // projections this read reports: the model the backend really selected and
    // the questions it really has waiting.
    const projections = await this.projectionsOf(sessionId);
    const value = await this.client.call('session/page', {
      address: buildPageAddress(sessionId, summary),
      throughSeq: await this.logCut(sessionId, projections),
      maxMessages: MAX_MESSAGES,
    });
    const status = summary.running ? 'working' : 'idle';
    const result = {
      id: sessionId,
      tool: 'dsh',
      title: summary.title,
      status,
      messages: recordsToMessages(value?.records),
      canStop: status === 'working' && this.canStop(),
    };
    if (status === 'working') {
      result.activeTurnId = sessionId;
    }
    const currentModel = currentModelOf(projections?.values?.modelSelection);
    if (currentModel !== undefined) {
      result.currentModel = currentModel;
    }
    const pendingQuestions = mapPendingQuestions(projections?.values?.userQuestions);
    if (pendingQuestions !== undefined) {
      result.pendingQuestions = pendingQuestions;
    }
    // A legacy blocking question has no projection entry at all (the tool calls
    // `ask`, and the `userQuestions` fold only ever tracks timed calls), so it
    // reaches the phone only from the page this read already carries. It appears
    // under the **real** tool call id, correlated from that call's own logged
    // questions; when that correlation is not exact the question is not shown, so
    // the phone is never offered a form it could answer for the wrong call.
    const legacyBatches = this.legacyQuestionBatches(sessionId, value?.records, PENDING_LIMITS.batches - (pendingQuestions?.length ?? 0));
    if (legacyBatches.length > 0) {
      result.pendingQuestions = [...(pendingQuestions ?? []), ...legacyBatches];
    }
    // Requirement F: a permission approval only ever exists on the native event
    // stream, so this is the one place the phone can learn about one. It is
    // bounded and sanitized, and its absence means "nothing is waiting here".
    const pendingApprovals = this.pendingApprovalsOf(sessionId);
    if (pendingApprovals.length > 0) {
      result.pendingApprovals = pendingApprovals;
    }
    return result;
  }

  /**
   * §9.3: hand the text to the input of the session the user already has.
   * Exactly one call; never a new session, never a replay of history.
   */
  async sendMessage(sessionId, text, options = {}) {
    if (!isSessionId(sessionId)) {
      throw new BridgeError('invalid_params', 'a session id is required');
    }
    let summary = this.summaries.get(sessionId) ?? null;
    const wantsModel = typeof options.model === 'string' && options.model.length > 0;
    if (wantsModel) {
      // Choosing a model changes native state, so this side checks fresh native
      // facts first and never guesses (CRD 0008 §B): only a live root session
      // that is not working can have its model changed, and a refusal here means
      // NO prompt is sent at all.
      summary = await this.freshSummary(sessionId);
      if (summary.parentSessionId !== null) {
        throw new BridgeError('not_capable', 'the model of a subagent session cannot be changed from here');
      }
      if (summary.running === true) {
        throw new BridgeError('bridge_error', 'this session is working; its model can be changed once it is idle');
      }
      await this.selectModel(sessionId, options);
    }
    const parentSessionId = options.parentSessionId ?? summary?.parentSessionId ?? null;
    const content = [{ type: 'text', text }];
    if (parentSessionId !== null) {
      // The official path for a session that belongs to another session: a plain
      // session/prompt would answer `session/agent-busy`.
      await this.client.call('subagents/prompt', {
        requestId: crypto.randomUUID(),
        parentSessionId,
        childSessionId: sessionId,
        mode: 'continuable',
        delivery: options.delivery ?? 'queue',
        content,
        clientTimeZone: DEFAULT_CLIENT_TIME_ZONE,
      });
    } else {
      await this.client.call('session/prompt', {
        requestId: crypto.randomUUID(),
        sessionId,
        mode: 'queue',
        content,
        clientTimeZone: DEFAULT_CLIENT_TIME_ZONE,
      });
    }
    return { accepted: true, sessionId };
  }

  /**
   * Answer one waiting native question (CRD 0008 §D, extended for `open`).
   *
   * Everything is re-checked against fresh native state before anything moves:
   * the session must still be listed, it must be a root (native human interaction
   * requires the exact live root agent), the call must still be waiting, every
   * question must be named exactly once, and every selected label must be one the
   * native form really offered.
   *
   * Then the state decides the transport, and both are genuine:
   *   - `continued` -> the scoped unary `userQuestions/answer`, whose boolean is
   *     the acceptance signal (anything but a literal `true` fails);
   *   - `open` -> the forwarded `user-questions/request` waterfall this adapter
   *     holds for that exact session + callId. There is no boolean on that
   *     transport, and the Gateway acknowledges a submission whose request was
   *     already decided elsewhere too - so acceptance is only reported when fresh
   *     native `settled` state really carries this call with these answers.
   *     Without that proof the call fails honestly and nothing is resubmitted.
   */
  async answerQuestion(sessionId, callId, answers) {
    if (!isSessionId(sessionId)) {
      throw new BridgeError('invalid_params', 'a session id is required');
    }
    const summary = await this.freshSummary(sessionId);
    if (summary.parentSessionId !== null) {
      throw new BridgeError('not_capable', 'a subagent question cannot be answered from here; the answer belongs to the session that owns it');
    }
    const projections = await this.projectionsOf(sessionId);
    const batches = mapPendingQuestions(projections?.values?.userQuestions) ?? [];
    const batch = batches.find((candidate) => candidate.callId === callId);
    if (batch !== undefined) {
      const outgoing = validatedAnswerBatch(batch.questions, answers);
      if (batch.state === 'open') {
        return this.answerOpenQuestion(sessionId, callId, outgoing);
      }
      if (batch.state !== 'continued') {
        throw new BridgeError('not_capable', 'that question cannot be answered from here; answer it in the DSH app');
      }
      return this.answerContinuedQuestion(sessionId, callId, outgoing);
    }
    // Not in the projection: the only other real possibility is a legacy blocking
    // request this bridge is holding, which the projection never tracks. It is
    // still re-checked against native state - the live tool call and the form it
    // asked - before anything moves, and it is answered through the same
    // waterfall transport an `open` timed question uses.
    const legacy = await this.correlatedLegacyQuestion(sessionId, callId);
    if (legacy === null) {
      throw new BridgeError('session_not_found', 'that question is not waiting for an answer any more');
    }
    return this.answerOpenQuestion(sessionId, callId, validatedAnswerBatch(legacy.questions, answers), legacy);
  }

  /**
   * The held legacy question of one session, correlated with its real tool call.
   *
   * `null` when this session holds no legacy question, when the call does not
   * exist in the page, or when the correlation is ambiguous - in every one of
   * those cases the honest answer is that this bridge cannot answer that call
   * from here, and the phone is told so instead of being handed a guess.
   * @returns {Promise<{callId: string, turn: number|null, questions: object[]}|null>}
   */
  async correlatedLegacyQuestion(sessionId, callId) {
    if (this.events === null || typeof this.events.hasLegacyQuestion !== 'function' || !this.events.hasLegacyQuestion(sessionId)) {
      return null;
    }
    const records = await this.readPageRecords(sessionId).catch(() => null);
    if (records === null) return null;
    return this.correlateHeldLegacyQuestions(sessionId, records).find((entry) => entry.callId === callId) ?? null;
  }

  /**
   * Every held legacy question of one session that really matches a live tool call.
   *
   * The form the phone shows is the form **the call asked**, taken from the same
   * mapped native questions the projection path uses; the yes/no question of
   * whether that call is the one this request belongs to is
   * {@link correlateHeldQuestionCall}'s, and it answers `null` rather than an
   * approximation.
   * @returns {{callId: string, turn: number|null, questions: object[]}[]}
   */
  correlateHeldLegacyQuestions(sessionId, records) {
    const out = [];
    for (const entry of this.events.unresolvedLegacyQuestionWaitsFor(sessionId)) {
      const correlation = correlateHeldQuestionCall(records, entry.questions);
      if (correlation === null) continue;
      let questions;
      try {
        questions = entry.questions.map(mapPendingQuestion);
      } catch {
        // A form the phone cannot show in full is not presented at all.
        continue;
      }
      out.push({ callId: correlation.callId, turn: correlation.turn, questions });
    }
    return out;
  }

  /**
   * The legacy questions one read should present, as `pendingQuestions` batches.
   *
   * `state` is `'open'`: the tool call is inside its blocking wait right now, which
   * is exactly what `open` means on this wire. The list is never longer than the
   * form limit either - a form that does not fit is not presented in part.
   * @param {string} sessionId
   * @param {unknown} records the records of the page this read already fetched
   * @param {number} [room] how many more batches the presentation still allows
   * @returns {{callId: string, state: 'open', questions: object[]}[]}
   */
  legacyQuestionBatches(sessionId, records, room = PENDING_LIMITS.batches) {
    if (this.events === null || typeof this.events.hasLegacyQuestion !== 'function' || !this.events.hasLegacyQuestion(sessionId)) {
      return [];
    }
    return this.correlateHeldLegacyQuestions(sessionId, records)
      .slice(0, Math.max(0, room))
      .map((entry) => ({
        callId: entry.callId,
        state: 'open',
        questions: entry.questions,
      }));
  }

  /**
   * Answer a `continued` question through the scoped unary RPC.
   *
   * The boolean is the acceptance signal: anything but a literal `true` means the
   * question is no longer waiting, and nothing is ever retried.
   */
  async answerContinuedQuestion(sessionId, callId, outgoing) {
    const accepted = await this.client.call('userQuestions/answer', {
      agentId: sessionId,
      callId,
      answer: { answers: outgoing },
    });
    if (accepted !== true) {
      throw new BridgeError('bridge_error', 'the DSH backend did not accept that answer; the question is no longer waiting');
    }
    return { accepted: true, sessionId, callId };
  }

  /**
   * Answer a question that is still `open`, through its live native waterfall.
   *
   * The submission itself travels on the event stream; acceptance is then read
   * from fresh native state. For a **timed** question that proof is the native
   * `settled` projection entry; for a **legacy blocking** question there is no
   * projection entry at all, so the proof is the tool's own recorded result - a
   * `tool/result` whose `message.toolCallId` is this call and whose rendered value
   * is this exact answer batch (the same reader native's own projection uses, see
   * {@link recordedQuestionAnswers}). Anything else is an honest failure the phone
   * resolves by re-reading, never a "HTTP 200 means answered".
   */
  async answerOpenQuestion(sessionId, callId, outgoing, legacy = null) {
    const held = this.events === null ? false : this.events.hasQuestionWait(sessionId, callId) === true || legacy !== null;
    if (held !== true) {
      throw new BridgeError('not_capable', 'that question is still open in the DSH app; answer it there');
    }
    await this.events.submitQuestionAnswer({ sessionId, callId, answers: outgoing });
    const settled = legacy === null
      ? await this.confirmSettled(sessionId, callId, outgoing)
      : await this.confirmRecordedAnswers(sessionId, callId, outgoing);
    if (settled === 'answered-elsewhere') {
      throw new BridgeError('bridge_error', 'that question was already answered in the DSH app; re-read the session');
    }
    if (settled !== 'answered-here') {
      throw new BridgeError('bridge_error', 'the DSH app did not confirm that answer; re-read the session before trying again');
    }
    return { accepted: true, sessionId, callId };
  }

  /**
   * Re-read the tool's own result until it really carries this answer batch.
   *
   * This is the only proof a legacy blocking question was answered, because the
   * `userQuestions` projection never tracked that call: the `ask_user_question`
   * result is where the answer the agent received is recorded, under the same call
   * id this bridge submitted for.
   * @returns {Promise<'answered-here'|'answered-elsewhere'|null>}
   */
  async confirmRecordedAnswers(sessionId, callId, outgoing) {
    for (let attempt = 0; attempt < this.settleAttempts; attempt += 1) {
      if (attempt > 0) await delay(this.settleDelayMs);
      const records = await this.readPageRecords(sessionId).catch(() => null);
      if (records === null) continue;
      const recorded = recordedQuestionAnswers(records, callId);
      if (recorded === null) continue;
      return answersMatch(recorded, outgoing) ? 'answered-here' : 'answered-elsewhere';
    }
    return null;
  }

  /** One fresh `session/page` read, as the raw records native answered with. */
  async readPageRecords(sessionId, summary = null) {
    const resolved = summary ?? (await this.freshSummary(sessionId));
    const projections = await this.projectionsOf(sessionId);
    const value = await this.client.call('session/page', {
      address: buildPageAddress(sessionId, resolved),
      throughSeq: await this.logCut(sessionId, projections),
      maxMessages: MAX_MESSAGES,
    });
    return Array.isArray(value?.records) ? value.records : [];
  }

  /**
   * Re-read native question state until this call is really settled, or give up.
   *
   * Returns `'answered-here'` only for an exact match of the recorded answers,
   * `'answered-elsewhere'` when native settled the call with something else, and
   * `null` when nothing could be proven inside the bounded window.
   */
  async confirmSettled(sessionId, callId, outgoing) {
    for (let attempt = 0; attempt < this.settleAttempts; attempt += 1) {
      if (attempt > 0) await delay(this.settleDelayMs);
      const projections = await this.projectionsOf(sessionId).catch(() => null);
      const settled = Array.isArray(projections?.values?.userQuestions?.settled) ? projections.values.userQuestions.settled : [];
      const entry = settled.find((candidate) => String(candidate?.callId ?? '') === callId);
      if (entry === undefined) continue;
      return answersMatch(entry.answers, outgoing) ? 'answered-here' : 'answered-elsewhere';
    }
    return null;
  }

  /**
   * Submit one decision for one live native permission approval.
   *
   * The request must be the exact live one the event stream is holding for this
   * session: same `eventId`, same session, same stream generation. Anything
   * unknown, stale, already cancelled or already submitted is refused without
   * sending anything, so a second tap can never decide twice.
   *
   * The returned `state` is deliberately split in two:
   *   - `submitted` - the native transport acknowledged the submission. That is
   *     **not** proof this decision won: another client may have answered first
   *     and the Gateway still answers `ok`, and a correlation this bridge could
   *     not make is never guessed at. The phone shows 已提交 and re-reads.
   *   - `confirmed` - the native audit shows this exact request id decided with
   *     the outcome this bridge sent.
   * A native audit that shows the request was decided *differently* is reported as
   * a failure, because that is what really happened.
   *
   * The native id this proof needs is **not** the id this method is called with.
   * `dsh-user-approval` mints its own `ApprovalRequestId` (`randomUUID()`) for the
   * `approval/asked` + `approval/decided` audit pair, and the request that travels
   * the waterfall carries no id at all (`lib/index.js`, `request()`); the id on
   * the wire (`approvalId`) is the **Gateway's** event id for that forwarded
   * waterfall (`frame.eventId`), a third, unrelated value. So the audit is only
   * reachable by correlating the live approval with the `approval/asked` entry it
   * belongs to - see {@link correlateApprovalAudit} - which happens *before* the
   * submission, while that entry is the only unmatched one of its kind. When that
   * correlation is unknown or ambiguous, nothing is inferred: the answer is
   * `submitted` and no audit is read at all.
   *
   * Exactly one submission per request, even under concurrent taps: reading the
   * audit first is a real round trip, so two taps for the same request would both
   * find it live and both reach native. The per-request lock below closes that
   * window, and it is released in `finally` whatever the outcome - including a
   * refused or failed submission - so a genuine retry after a failure is possible.
   */
  async approveRequest(sessionId, approvalId, decision) {
    if (!isSessionId(sessionId)) {
      throw new BridgeError('invalid_params', 'a session id is required');
    }
    if (this.events === null) {
      throw new BridgeError('not_capable', 'this bridge has no native approval stream right now; decide it on the computer');
    }
    const key = `${sessionId}\u0000${approvalId}`;
    if (this.approvalsInFlight.has(key)) {
      throw new BridgeError('bridge_error', 'that decision is already being submitted');
    }
    this.approvalsInFlight.add(key);
    try {
      const summary = await this.freshSummary(sessionId);
      const live = this.events
        .approvalsFor(sessionId)
        .find((approval) => approval.id === approvalId);
      if (live === undefined) {
        throw new BridgeError('session_not_found', 'that approval is not waiting for a decision any more');
      }
      // Read the native audit while the request is still open: this is the only
      // moment at which the pair `approval/asked` (already appended by native) is
      // unambiguously this live request, and it is the only way to learn the native
      // request id the decision will be recorded under.
      const correlation = await this.correlateApprovalOnce(sessionId, summary, live);
      const submitted = await this.events.submitApproval({ sessionId, approvalId, decision });
      if (correlation === null) {
        // No honest correlation: the transport's `submitted` is all this bridge
        // knows, and no unrelated or old audit entry may stand in for proof.
        return { accepted: true, sessionId, approvalId, state: submitted.state };
      }
      const landed = await this.confirmApproval(sessionId, summary, correlation, decision);
      if (landed !== null && landed !== 'confirmed') {
        throw new BridgeError('bridge_error', landed);
      }
      return { accepted: true, sessionId, approvalId, state: landed === 'confirmed' ? 'confirmed' : submitted.state };
    } finally {
      this.approvalsInFlight.delete(key);
    }
  }

  /**
   * Correlate one live native approval with its `approval/asked` audit entry.
   *
   * The first read is taken before anything is submitted; a log that lags the
   * append is re-read a bounded number of times, exactly like the settle loop
   * after it. Returns `null` - never a guess - when the audit cannot single the
   * live request out, which is the safe answer for a correlation that is unknown
   * or ambiguous.
   * @returns {Promise<{auditId: string, decision: string|null}|null>}
   */
  async correlateApprovalOnce(sessionId, summary, live) {
    for (let attempt = 0; attempt < this.settleAttempts; attempt += 1) {
      if (attempt > 0) await delay(this.settleDelayMs);
      const scan = await this.readAuditRecords(sessionId, summary).catch(() => null);
      if (scan === null) continue;
      const correlation = correlateApprovalAudit(scan, live);
      if (correlation !== null) return correlation;
    }
    return null;
  }

  /**
   * The audit entries of one session's log: every ask with the decision recorded
   * for the same native request id, or `null` for the ask while it waits.
   *
   * Unlike `tool/call` and `tool/result`, these records carry no `turn` field
   * (`dsh-user-approval/lib/index.js`, `request()`), so a turn boundary cannot
   * narrow this scan. Two concurrent asks of the same shape therefore stay
   * ambiguous, and {@link correlateApprovalAudit} answers `null` for them - the
   * submission is still honest about being only `submitted`.
   * @returns {Promise<{auditId: string, toolName: string, callId: string|null, reason: string|null, decision: string|null}[]>}
   */
  async readAuditRecords(sessionId, summary) {
    const projections = await this.projectionsOf(sessionId);
    const value = await this.client.call('session/page', {
      address: buildPageAddress(sessionId, summary),
      throughSeq: await this.logCut(sessionId, projections),
      maxMessages: MAX_MESSAGES,
    });
    return scanApprovalAudit(value?.records);
  }

  /**
   * Read the recorded outcome of the native request this bridge correlated.
   *
   * `approval/decided` is the durable record `dsh-user-approval` appends with its
   * own request id and the outcome, so it is the only real proof that this exact
   * request was decided - and by which outcome. Reading it by the *native* audit
   * id from the correlation is what makes the proof belong to this decision: the
   * Gateway event id that `approveRequest` was called with appears nowhere in
   * that audit pair.
   *
   * @returns {Promise<'confirmed'|string|null>} `'confirmed'` for this bridge's own
   *   outcome, otherwise a safe sentence saying what really happened, or `null`
   *   when nothing could be proven.
   */
  async confirmApproval(sessionId, summary, correlation, decision) {
    const expected = NATIVE_APPROVAL_OUTCOME[decision];
    // The correlation only ever names an ask whose own decision is not recorded
    // yet, so nothing is known here until native appends one for that exact id:
    // the log is re-read inside the bounded window and nothing else is inferred.
    for (let attempt = 0; attempt < this.settleAttempts; attempt += 1) {
      if (attempt > 0) await delay(this.settleDelayMs);
      const scan = await this.readAuditRecords(sessionId, summary).catch(() => null);
      if (scan === null) continue;
      const outcome = recordedOutcomeOf(scan, correlation.auditId);
      if (outcome === null) continue;
      if (outcome === expected) return 'confirmed';
      return describeDecisionMismatch(outcome);
    }
    return null;
  }

  /** §9.4: `session/cancel` on the same session id. */
  async stopSession(sessionId) {
    if (!isSessionId(sessionId)) {
      throw new BridgeError('invalid_params', 'a session id is required');
    }
    await this.client.call('session/cancel', { sessionId });
    return { accepted: true, sessionId };
  }

  close() {
    // HTTP keeps no long-lived connection here; the event stream, if there is
    // one, must go: an `eventId` from a stream this process no longer owns can
    // never be answered, and nothing may be left half-held.
    try {
      this.events?.close?.();
    } catch {
      // already gone
    }
    this.events = null;
  }
}

/**
 * Wait one bounded moment, so a bounded re-read is not a busy loop.
 *
 * The timer is deliberately **not** unref'd, unlike the event stream's long-lived
 * socket and reconnect timer: this wait is part of an answer the caller is
 * awaiting, and an unref'd timer could let a one-shot process exit before the
 * verification it belongs to finishes.
 */
function delay(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * One answer batch, checked against the native form this call really asked.
 *
 * Every question of the call must be named exactly once, a single-select question
 * takes at most one label, and every selected label must be one the native form
 * offered - so a hand-made request can never invent an answer native never
 * offered. Returns the batch exactly as it will cross the wire.
 * @param {object[]} questions the mapped native questions of one call
 * @param {object[]} answers the phone's answers
 */
function validatedAnswerBatch(questions, answers) {
  if (questions.length !== answers.length) {
    throw new BridgeError('invalid_params', `the answer batch must name each of its ${questions.length} questions exactly once`);
  }
  const byId = new Map(questions.map((question) => [question.id, question]));
  const outgoing = [];
  for (const answer of answers) {
    const question = byId.get(answer.id);
    if (question === undefined) {
      throw new BridgeError('invalid_params', 'that answer names a question this call did not ask');
    }
    const labels = new Set((question.options ?? []).map((option) => option.label));
    const limit = question.multiSelect === true ? labels.size : 1;
    if (answer.selected.length > limit) {
      throw new BridgeError('invalid_params', 'this question takes fewer selected options than that');
    }
    for (const label of answer.selected) {
      if (!labels.has(label)) {
        throw new BridgeError('invalid_params', 'that answer selected an option this question did not offer');
      }
    }
    outgoing.push({
      id: answer.id,
      selected: [...answer.selected],
      ...(answer.custom !== undefined ? { custom: answer.custom } : {}),
    });
  }
  return outgoing;
}

/**
 * What really happened to a decision, in one safe sentence.
 *
 * The native outcome vocabulary is `allowed-once | rejected | cancelled |
 * unavailable` (`dsh-user-approval`). The only good news is this bridge's own
 * outcome; every other value is a real, different fact and is reported as one -
 * never folded into "done", and never as a granted permission.
 */
function describeDecisionMismatch(outcome) {
  if (outcome === 'cancelled') return 'that request was cancelled before the decision arrived; re-read the session';
  if (outcome === 'unavailable') return 'the DSH app did not accept that decision; decide it on the computer';
  return 'another client decided that request first; re-read the session';
}

/**
 * Every approval entry one session log page carries, in the order native wrote it.
 *
 * `dsh-user-approval` appends `approval/asked` when a request is raised - with its
 * own `ApprovalRequestId`, the tool name and the optional `callId`/`reason` - and
 * `approval/decided` with that same id once the waterfall has settled
 * (installed `lib/index.js`, `request()`). An ask with no decision for its id is
 * therefore a request that is *open right now* (native appends the decision in
 * the same turn, and a bare event between turns does not survive a reload).
 *
 * @param {unknown} records `session/page` records
 * @returns {{auditId: string, toolName: string, callId: string|null, reason: string|null, decision: string|null}[]}
 */
function scanApprovalAudit(records) {
  const asks = [];
  const decisions = new Map();
  for (const record of Array.isArray(records) ? records : []) {
    const event = record?.event ?? record;
    if (event === null || typeof event !== 'object') continue;
    const type = String(event.type ?? record?.type ?? '');
    if (type !== 'approval/asked' && type !== 'approval/decided') continue;
    const data = event.data ?? {};
    const auditId = boundedIdentifier(data.id, 128);
    if (auditId === null) continue;
    if (type === 'approval/decided') {
      decisions.set(auditId, typeof data.outcome === 'string' ? data.outcome : '');
      continue;
    }
    asks.push({
      auditId,
      toolName: boundedNativeText(data.toolName, 256) ?? '',
      callId: boundedIdentifier(data.callId, 256) ?? null,
      reason: boundedNativeText(data.reason, 4096) ?? null,
      decision: null,
    });
  }
  for (const ask of asks) {
    const decision = decisions.get(ask.auditId);
    ask.decision = decision === undefined ? null : decision;
  }
  return asks;
}

/**
 * Whether one audit sentence can be the same string the live request carried.
 *
 * The live value comes from the stream, which bounds and sanitizes native text
 * (`EVENT_LIMITS`, `boundedNativeText`); the audit keeps native's own value. A
 * bounded prefix is therefore the exact test: a live value that is not a prefix
 * of the recorded one belongs to a different request, and anything else is the
 * same native sentence seen through that bound.
 */
function auditTextMatches(live, recorded, fallbackLimit) {
  if (live === undefined || live === null) return true;
  if (recorded === null || recorded === undefined) return false;
  const limit = [...live].length > fallbackLimit ? [...live].length : fallbackLimit;
  return live === recorded.slice(0, limit) || live === recorded;
}

/**
 * The one open `approval/asked` entry that belongs to one live native approval.
 *
 * Correlation is exact-field and fail-closed. A candidate must carry the same
 * tool name, and - when the live request carries them - the same `callId` and
 * `reason`; and its own `approval/decided` must not exist yet, because a recorded
 * decision means that ask is over and can never be this live request's future
 * outcome. Exactly one such candidate must remain. With none, or with more than
 * one (two concurrent asks of the same tool shape, say), the correlation is
 * unknown or ambiguous and `null` is returned: a wrong audit id would turn
 * another request's decision into this one's "proof", which is worse than not
 * proving anything at all.
 *
 * @param {ReturnType<typeof scanApprovalAudit>} asks
 * @param {{toolName?: string, callId?: string, reason?: string}} live the live approval entry
 * @returns {{auditId: string, decision: string|null}|null}
 */
function correlateApprovalAudit(asks, live) {
  const toolName = typeof live?.toolName === 'string' ? live.toolName : '';
  if (toolName.length === 0) return null;
  const matching = (Array.isArray(asks) ? asks : []).filter(
    (ask) =>
      ask.decision === null &&
      ask.toolName === toolName &&
      (live.callId === undefined || live.callId === null ? ask.callId === null : ask.callId === live.callId) &&
      auditTextMatches(live.reason, ask.reason, EVENT_LIMITS.reason),
  );
  if (matching.length !== 1) return null;
  return { auditId: matching[0].auditId, decision: matching[0].decision };
}

/** The recorded outcome of one native request id, or `null` when none exists. */
function recordedOutcomeOf(asks, auditId) {
  const ask = (Array.isArray(asks) ? asks : []).find((candidate) => candidate.auditId === auditId);
  return ask === undefined || ask.decision === null ? null : ask.decision;
}

/** Whether the native settled batch is exactly the batch this bridge sent. */function answersMatch(recorded, outgoing) {
  if (!Array.isArray(recorded) || recorded.length !== outgoing.length) return false;
  const byId = new Map(recorded.map((answer) => [String(answer?.id ?? ''), answer]));
  for (const answer of outgoing) {
    const native = byId.get(answer.id);
    if (native === undefined) return false;
    const selected = Array.isArray(native.selected) ? native.selected.map(String) : [];
    if (selected.length !== answer.selected.length) return false;
    const wanted = [...answer.selected].sort();
    const got = [...selected].sort();
    for (let index = 0; index < wanted.length; index += 1) {
      if (wanted[index] !== got[index]) return false;
    }
    const custom = typeof native.custom === 'string' ? native.custom : undefined;
    if (custom !== answer.custom) return false;
  }
  return true;
}

module.exports = {
  DSH_PREFIX,
  COOKIE_TTL_MS,
  CREDENTIALS_RECORD,
  SECRET_BYTES,
  WORKSPACE_CATALOG_MAX_BYTES,
  WORKSPACE_CATALOG_TIMEOUT_MS,
  base64Url,
  base64UrlDecode,
  cookieName,
  mintCookie,
  readBrowserSecret,
  reasoningEffortsOf,
  dshProfileDir,
  workspaceCatalogPath,
  parseWorkspaceCatalog,
  readWorkspaceCatalog,
  normalizeWorkspacePath,
  lastPathSegment,
  parseNetstatListeners,
  parseTasklistNames,
  candidatePorts,
  scanDshPorts,
  discoverBackend,
  readPortHint,
  writePortHint,
  portHintPath,
  toMessages,
  isInjectedEvent,
  sourceKindOf,
  recordsToMessages,
  toDshTimestamp,
  mapRpcError,
  argFieldName,
  argPayload,
  PENDING_LIMITS,
  sanitizeNativeText,
  boundedNativeText,
  validatedAnswerBatch,
  answersMatch,
  scanApprovalAudit,
  correlateApprovalAudit,
  recordedOutcomeOf,
  delay,
  activeQuestionBatches,
  mapPendingQuestions,
  mapPendingQuestion,
  scanToolCalls,
  scanPtcQuestionCalls,
  ptcQuestionSubCallIds,
  isLiveCallChain,
  newestOpenToolCall,
  sameQuestionForm,
  correlateLegacyQuestionCall,
  correlatePtcQuestionCall,
  correlateHeldQuestionCall,
  recordedQuestionAnswers,
  currentModelOf,
  buildPageAddress,
  DshClient,
  DshAdapter,
  DEFAULT_CLIENT_TIME_ZONE,
};

