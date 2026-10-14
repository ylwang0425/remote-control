'use strict';

/**
 * Read WorkBuddy's existing local conversation archive.
 *
 * The native app keeps searchable session metadata in workbuddy.db and the
 * canonical transcript in projects/<native cwd key>/<session id>.jsonl. The
 * bridge opens the database explicitly read-only and never uses WorkBuddy's
 * account/runtime owner-bucket fallback. Standard UI Automation is used for
 * native create/send, stop, question, and approval operations. The installed
 * app's bounded product cache can supply model labels without native input.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { TextDecoder } = require('node:util');

const { BridgeError } = require('../errors');
const { isSessionId, MAX_MESSAGES, toRfc3339 } = require('../protocol');
const { createWindowsUiaInspector } = require('../workbuddy-native/windows-uia');
const { WorkBuddyNativeWriter } = require('../workbuddy-native/writer');
const { WorkBuddyPendingService } = require('../workbuddy-native/pending-service');

const MAX_LIST = 200;
const MAX_HISTORY_BYTES = 4 * 1024 * 1024;
const MAX_LINE_BYTES = 512 * 1024;
const MAX_HISTORY_RECORDS = 5000;
const MAX_TEXT_CHARS = 65536;
const MAX_NATIVE_IDENTITY_CANDIDATES = 64;
const MAX_NATIVE_TASK_TITLES = 200;
const MAX_NATIVE_SESSION_IDS = 20000;
const MAX_PRODUCT_CACHE_BYTES = 1024 * 1024;
const PRODUCT_CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const NATIVE_CREATE_CONFIRM_MS = 8000;
const EMPTY_DRAFT_FINGERPRINT = 'e3b0c44298fc1c14';
const GLOBAL_NON_CHAT_TABS = new Map([
  ['技能', 'skills'], ['专家·技能·连接器', 'skills'], ['skills', 'skills'], ['experts · skills · connectors', 'skills'],
  ['项目', 'projects'], ['projects', 'projects'], ['project', 'projects'],
]);
const WORKBUDDY_DB_UNAVAILABLE = '无法只读打开 WorkBuddy 本地历史数据库；请确认此 Windows 用户已安装并运行过 WorkBuddy。';
const HISTORY_UNAVAILABLE = '此 WorkBuddy 会话的本地历史记录暂不可用。';

const REQUIRED_SESSION_COLUMNS = ['id', 'cwd', 'title', 'custom_title', 'created_at', 'updated_at', 'last_activity_at', 'deleted_at', 'transport'];
const SAFE_MESSAGE_ID = /^[A-Za-z0-9._:-]{1,128}$/;
const SAFE_SESSION_FILE_ID = /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,127}$/;
const SAFE_MODEL_LABEL = /^[^\u0000-\u001f\u007f]{1,180}$/u;

function normalizeModelName(value) {
  if (typeof value !== 'string') return '';
  const text = value.trim();
  const match = /^(?:select\s+model\s*:\s*|选择模型：?\s*)/iu.exec(text);
  return (match ? text.slice(match[0].length) : text).trim();
}

function nativeDraftFingerprint(value) {
  const normalized = String(value).replace(/^\uFEFF/u, '').trim();
  return crypto.createHash('sha256').update(normalized, 'utf8').digest('hex').slice(0, 16);
}

function uniqueModelOptions(controls) {
  const labels = [];
  const seen = new Set();
  for (const control of controls) {
    const label = typeof control?.accessibleName === 'string' ? control.accessibleName.trim() : '';
    if (!SAFE_MODEL_LABEL.test(label) || redactSensitiveText(label) !== label || seen.has(label)) return [];
    seen.add(label);
    labels.push(label);
  }
  return labels;
}

function sessionTitle(row) {
  const value = typeof row.custom_title === 'string' && row.custom_title.trim()
    ? row.custom_title : typeof row.title === 'string' && row.title.trim() ? row.title : row.id;
  return redactSensitiveText(value).replace(/[\r\n\p{Cc}]/gu, ' ').trim().slice(0, 200) || row.id;
}

function nativeIdentityTitle(row) {
  if (!row || typeof row !== 'object') return null;
  const custom = typeof row.custom_title === 'string' ? row.custom_title.trim() : '';
  const ordinary = typeof row.title === 'string' ? row.title.trim() : '';
  const title = custom || ordinary;
  if (!title || title.length > 180 || /[\r\n\p{Cc}]/u.test(title) || redactSensitiveText(title) !== title) return null;
  return title;
}

function nativeHistoryAnchors(session) {
  if (!session || session.historyTruncated === true || !Array.isArray(session.messages)) return null;
  const messages = session.messages.filter((message) => message && ['user', 'assistant'].includes(message.role) &&
    typeof message.text === 'string' && message.text.trim() &&
    // WorkBuddy replaces these native cancellation records with its own stop
    // widget. Their archive text is not a visible chat identity anchor.
    !(message.role === 'assistant' && ['[User Cancelled]', 'Interrupted by user'].includes(message.text.trim())));
  // A complete, truly empty native session is a known non-match when the
  // WorkBuddy UI is already showing another same-title conversation. A missing
  // file/corrupt tail is different: readSession throws or marks it truncated.
  if (messages.length === 0) return [];
  if (!messages.some((message) => message.role === 'user')) return null;
  const anchors = [];
  for (const message of messages.slice(-2)) {
    const raw = message.text.replace(/[\r\n\p{Z}\p{Cc}]+/gu, ' ').trim();
    if (!raw || redactSensitiveText(raw) !== raw) return null;
    const points = [...raw];
    const anchor = points.slice(-100).join('');
    if (anchor.length < 2 || anchor.length > 120 || anchors.includes(anchor)) return null;
    anchors.push(anchor);
  }
  return anchors.length ? anchors : null;
}

function nativeConfigDir(options = {}) {
  const env = options.env ?? process.env;
  const configured = typeof env.WORKBUDDY_CONFIG_DIR === 'string' ? env.WORKBUDDY_CONFIG_DIR.trim() : '';
  return configured || path.join(os.homedir(), '.workbuddy');
}

function nativeWorkspaceKey(cwd) {
  const full = String(cwd).replace(/[\\/:]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
  if (!full || full === '.' || full === '..') return null;
  const bytes = Buffer.from(full, 'utf8');
  if (bytes.length <= 255) return full;

  let prefix = '';
  for (const point of full) {
    if (Buffer.byteLength(prefix + point, 'utf8') > 180) break;
    prefix += point;
  }
  let hash = 5381;
  for (const byte of bytes) hash = ((hash * 33) ^ byte) | 0;
  return `${prefix}-${(hash >>> 0).toString(36)}`;
}

function inside(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function checkedRegularFile(file, root) {
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink()) return null;
    const real = fs.realpathSync(file);
    return inside(root, real) ? real : null;
  } catch {
    return null;
  }
}

function checkedProjectDir(projectsRoot, key) {
  if (typeof key !== 'string' || key.length === 0 || key === '.' || key === '..' || /[\\/\0]/.test(key)) return null;
  const directory = path.join(projectsRoot, key);
  try {
    const stat = fs.lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return null;
    const real = fs.realpathSync(directory);
    return inside(projectsRoot, real) ? real : null;
  } catch {
    return null;
  }
}

function cachedProductModelCatalog(configDir, now = Date.now()) {
  try {
    const root = fs.realpathSync(configDir);
    const cache = checkedProjectDir(root, 'cache');
    if (cache === null) return null;
    const file = checkedRegularFile(path.join(cache, 'acc-product-config-v3.json'), cache);
    if (file === null) return null;
    const descriptor = fs.openSync(file, 'r');
    let stat;
    let bytes;
    try {
      stat = fs.fstatSync(descriptor);
      const age = now - stat.mtimeMs;
      if (!stat.isFile() || stat.size < 2 || stat.size > MAX_PRODUCT_CACHE_BYTES ||
          age < -300000 || age > PRODUCT_CACHE_MAX_AGE_MS) return null;
      const buffer = Buffer.alloc(stat.size + 1);
      let count = 0;
      while (count < buffer.length) {
        const read = fs.readSync(descriptor, buffer, count, buffer.length - count, count);
        if (read === 0) break;
        count += read;
      }
      const after = fs.fstatSync(descriptor);
      if (count !== stat.size || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs) return null;
      bytes = buffer.subarray(0, count);
    } finally { fs.closeSync(descriptor); }
    const product = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    if (product?.productName !== 'WorkBuddy' || product.dataFolderName !== '.workbuddy' ||
        product.authentication?.id !== 'workbuddy-desktop' || !Array.isArray(product.agents) ||
        product.agents.length > 256 || !Array.isArray(product.models) || product.models.length > 256) return null;
    const agents = product.agents.filter(agent => agent?.name === 'cli');
    if (agents.length !== 1 || !Array.isArray(agents[0].models) ||
        agents[0].models.length < 1 || agents[0].models.length > 128) return null;
    const definitions = new Map();
    for (const model of product.models) {
      if (typeof model?.id !== 'string' || !/^[A-Za-z0-9._:/+-]{1,128}$/.test(model.id) ||
          definitions.has(model.id) || typeof model.name !== 'string' || !SAFE_MODEL_LABEL.test(model.name) ||
          model.name.trim() !== model.name || redactSensitiveText(model.name) !== model.name) return null;
      definitions.set(model.id, model);
    }
    const labels = [];
    const nativeIds = new Set();
    const seenLabels = new Set();
    for (const id of agents[0].models) {
      if (typeof id !== 'string' || nativeIds.has(id) || !definitions.has(id)) return null;
      nativeIds.add(id);
      const label = definitions.get(id).name;
      // The desktop picker merges native aliases with the same display name.
      // UIA selects and rechecks this exact display name before each send.
      if (seenLabels.has(label)) continue;
      seenLabels.add(label);
      labels.push(label);
    }
    return {
      models: labels.map(label => ({ id: label, label, isDefault: false })),
      projects: [], currentModel: null,
      catalogSource: 'WorkBuddy local product cache (configured CLI model options; current selection unobserved)',
      observedAt: new Date(stat.mtimeMs).toISOString(),
    };
  } catch { return null; }
}

function timestamp(value) {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    const millis = value < 100000000000 ? value * 1000 : value;
    const date = new Date(millis);
    return Number.isNaN(date.valueOf()) ? null : toRfc3339(date);
  }
  if (typeof value !== 'string' || value.trim() === '') return null;
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? null : toRfc3339(date);
}

function redactSensitiveText(value) {
  return String(value)
    .replace(/\b(Bearer\s+)[A-Za-z0-9._~+/-]+=*/giu, '$1[REDACTED]')
    .replace(/\b(api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|password|passwd|secret)\b(["']?\s*[:=]\s*["']?)[^\s"'`,;]+/giu, '$1$2[REDACTED]')
    .replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/gu, '[REDACTED_TOKEN]');
}

function boundedText(value, role, budget) {
  let text = '';
  if (typeof value === 'string') {
    text = value;
  } else if (Array.isArray(value)) {
    const parts = [];
    if (value.length > 100 && budget) budget.truncated = true;
    for (const item of value.slice(0, 100)) {
      if (item && typeof item === 'object' && !Array.isArray(item) && ['text', 'input_text', 'output_text'].includes(item.type) && typeof item.text === 'string') {
        parts.push(item.text);
      }
    }
    text = parts.join('\n');
  } else if (value && typeof value === 'object' && !Array.isArray(value)) {
    if (typeof value.text === 'string') text = value.text;
    else if (Array.isArray(value.content)) text = boundedText(value.content, role, budget);
  }
  // Native WorkBuddy history projection hides injected reminders and unwraps
  // user_query. Do this before the display budget so large internal context
  // cannot consume or hide the actual user message. Assistant/tool text stays
  // literal; transcript content is never treated as instructions.
  if (role === 'user') {
    text = text.replace(/<system-reminder[^>]*>[\s\S]*?<\/system-reminder>\s*/g, '')
      .replace(/<user_query>([\s\S]*?)<\/user_query>/g, '$1').trim();
  }
  let safe = redactSensitiveText(text);
  const points = [...safe];
  if (points.length > MAX_TEXT_CHARS) {
    if (budget) budget.truncated = true;
    safe = `${points.slice(0, MAX_TEXT_CHARS - 1).join('')}…`;
  }
  return safe;
}

function isInternalRecord(record) {
  const provider = record.providerData && typeof record.providerData === 'object' ? record.providerData : {};
  const named = (value) => typeof value === 'string' && value.length > 0;
  return record.isSubAgent === true || named(record.parentSessionId) || named(record.parentToolCallId) ||
    provider.isCompactInternal === true || typeof provider.compactType === 'string' || provider.isSubAgent === true ||
    provider.isMeta === true || named(provider.parentSessionId) || named(provider.parentToolCallId);
}

function toMessage(record, toolNames, index) {
  if (!record || typeof record !== 'object' || Array.isArray(record) || isInternalRecord(record)) return null;
  const at = timestamp(record.timestamp);
  if (at === null) return null;

  let role;
  let text;
  const budget = { truncated: false };
  let sourceId = record.id;
  if (record.type === 'message' && (record.role === 'user' || record.role === 'assistant')) {
    role = record.role;
    text = boundedText(record.content, role, budget);
    if (!text.trim()) return null;
  } else if (record.type === 'function_call') {
    if (typeof record.callId === 'string') toolNames.set(record.callId, record.name);
    const name = typeof record.name === 'string' ? record.name : 'tool';
    const argKeys = record.arguments && typeof record.arguments === 'object' && !Array.isArray(record.arguments)
      ? Object.keys(record.arguments).slice(0, 12)
      : [];
    const state = typeof record.status === 'string' ? `（${record.status.slice(0, 40)}）` : '';
    role = 'tool';
    text = `工具调用：${name}${argKeys.length ? `；参数：${argKeys.join(', ')}` : ''}${state}`;
    sourceId = record.callId ?? sourceId;
  } else if (record.type === 'function_call_result' || record.type === 'function_call_output') {
    role = 'tool';
    const name = typeof record.callId === 'string' ? toolNames.get(record.callId) : undefined;
    const result = record.output ?? record.content ?? record.providerData?.toolResult;
    const detail = boundedText(result, undefined, budget);
    const state = typeof record.status === 'string' ? `；状态：${record.status.slice(0, 40)}` : '';
    text = `${name ? `${name}：` : '工具结果：'}${detail}${state}`;
    sourceId = record.callId ?? sourceId;
  } else {
    return null;
  }

  if (typeof sourceId !== 'string' || !SAFE_MESSAGE_ID.test(sourceId)) return null;
  text = boundedText(text, undefined, budget);
  const signature = require('node:crypto').createHash('sha256').update(`${record.type}|${role}|${sourceId}|${at}|${text}`).digest('hex');
  return { id: `wb:${signature}`, role, text, timestamp: at, _index: index, _textTruncated: budget.truncated };
}

function replayRecords(records) {
  const metadata = new Set(['custom-title', 'ai-title', 'file-history-snapshot', 'summary', 'topic', 'goal-result', 'goal-progress', 'resend-fork-notice', 'session-meta']);
  const parents = new Set();
  let branched = false;
  for (const record of records) {
    if (record.type === 'resend-fork-notice' || record.providerData?.contentFilterNotice === true) branched = true;
    if (record.type === 'message' && record.role === 'user' && !isInternalRecord(record) && typeof record.parentId === 'string') {
      if (parents.has(record.parentId)) branched = true;
      parents.add(record.parentId);
    }
  }
  if (!branched) return { records, incomplete: false };
  let cursor = records.length - 1;
  while (cursor >= 0 && metadata.has(records[cursor].type) && records[cursor].type !== 'resend-fork-notice') cursor--;
  let target = records[cursor]?.type === 'resend-fork-notice' ? records[cursor].parentId : records[cursor]?.id;
  const selected = [], seen = new Set();
  let incomplete = false;
  while (typeof target === 'string' && target.length && !seen.has(target)) {
    seen.add(target);
    while (cursor >= 0 && records[cursor].id !== target) cursor--;
    if (cursor < 0) { incomplete = true; break; }
    const group = [];
    do { group.unshift(records[cursor--]); } while (cursor >= 0 && records[cursor].id === target);
    selected.unshift(...group.filter(record => !metadata.has(record.type)));
    target = group[0].parentId ?? group[0].logicalParentId;
  }
  if (target && seen.has(target)) incomplete = true;
  return { records: selected, incomplete };
}

function readTail(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const stat = fs.fstatSync(fd);
    const offset = Math.max(0, stat.size - MAX_HISTORY_BYTES);
    const length = Math.min(stat.size, MAX_HISTORY_BYTES);
    const buffer = Buffer.allocUnsafe(length);
    let read = 0;
    while (read < length) {
      const count = fs.readSync(fd, buffer, read, length - read, offset + read);
      if (count === 0) break;
      read += count;
    }
    let bytes = buffer.subarray(0, read);
    let truncated = offset > 0 || read !== length;
    if (offset > 0) {
      const firstNewline = bytes.indexOf(10);
      if (firstNewline < 0) return { lines: [], truncated: true };
      bytes = bytes.subarray(firstNewline + 1);
    }
    if (bytes.length && bytes.at(-1) !== 10) {
      const lastNewline = bytes.lastIndexOf(10);
      let complete = false;
      try { JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(lastNewline + 1))); complete = true; } catch { /* incomplete append */ }
      if (!complete) {
        bytes = lastNewline < 0 ? Buffer.alloc(0) : bytes.subarray(0, lastNewline + 1);
        truncated = true;
      }
    }
    let text;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      throw new BridgeError('bridge_error', HISTORY_UNAVAILABLE);
    }
    const lines = text.split('\n');
    if (lines.at(-1) === '') lines.pop();
    if (lines.length > MAX_HISTORY_RECORDS) {
      lines.splice(0, lines.length - MAX_HISTORY_RECORDS);
      truncated = true;
    }
    return { lines, truncated };
  } finally {
    fs.closeSync(fd);
  }
}

function historyPath(configDir, row) {
  if (typeof row.cwd !== 'string' || row.cwd.length === 0 || row.cwd.length > 4096 || row.cwd.includes('\0') || !path.isAbsolute(row.cwd)) return null;
  if (!SAFE_SESSION_FILE_ID.test(row.id)) return null;
  let root;
  try {
    root = fs.realpathSync(configDir);
  } catch {
    return null;
  }
  const projectsRoot = path.join(root, 'projects');
  try {
    const stat = fs.lstatSync(projectsRoot);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return null;
  } catch {
    return null;
  }

  let canonicalCwd = row.cwd;
  try { canonicalCwd = fs.realpathSync(row.cwd); } catch { /* native resolver tries raw cwd when realpath is unavailable */ }
  const keys = [...new Set([nativeWorkspaceKey(canonicalCwd), nativeWorkspaceKey(row.cwd)].filter(Boolean))];
  for (const key of keys) {
    const projectDir = checkedProjectDir(projectsRoot, key);
    if (projectDir === null) continue;
    const file = checkedRegularFile(path.join(projectDir, `${row.id}.jsonl`), projectDir);
    if (file !== null) return { file, projectsRoot };
  }
  return null;
}

class WorkBuddyAdapter {
  constructor({ db, configDir, columns, uiAutomation = {} }) {
    this.db = db;
    this.configDir = configDir;
    this.columns = new Set(columns);
    this.uiAutomationEnabled = uiAutomation.enabled === true;
    this.workbuddyExecutablePath = uiAutomation.executablePath ?? '';
    this.nativeWriter = new WorkBuddyNativeWriter();
    this.lifecycleOperations = new Set();
    this.uiAutomationInspector = this.uiAutomationEnabled
      ? createWindowsUiaInspector({ timeoutMs: 15000 })
      : null;
    this.lastNativeObservation = null;
    this.pendingService = this.uiAutomationEnabled ? new WorkBuddyPendingService({
      executablePath: this.workbuddyExecutablePath,
      load: (sessionId) => this.readSession(sessionId, { includeSource: true }),
      readContext: (sessionId, hooks, analysis) => this.readNativePendingContext(sessionId, hooks, analysis),
      execute: (sessionId, plan, context, hooks) => this.uiAutomationInspector.executeNativePendingAction({
        expectedExePath: this.workbuddyExecutablePath, expectedProcessId: context.target.processId,
        expectedHandle: context.target.handle, maxControls: 160, identityTitle: context.identity.title,
        anchorCandidates: context.identity.anchorCandidates, expectedCandidateIndex: context.identity.expectedCandidateIndex,
        nativePlan: plan,
      }, hooks),
    }) : null;
    this.closePromise = null;
    this.listStatement = db.prepare(`SELECT id, cwd, title, custom_title, created_at, updated_at, last_activity_at, deleted_at, transport FROM sessions WHERE transport = 'local' AND deleted_at IS NULL ORDER BY COALESCE(last_activity_at, updated_at, created_at) DESC LIMIT ?`);
    this.readStatement = db.prepare(`SELECT id, cwd, title, custom_title, created_at, updated_at, last_activity_at, deleted_at, transport FROM sessions WHERE id = ? AND transport = 'local' AND deleted_at IS NULL LIMIT 1`);
    this.identityTitleCountStatement = db.prepare(`SELECT COUNT(*) AS count FROM sessions WHERE transport = 'local' AND deleted_at IS NULL AND COALESCE(NULLIF(TRIM(custom_title), ''), NULLIF(TRIM(title), ''), id) = ?`);
    this.identityCandidatesStatement = db.prepare(`SELECT id, cwd, title, custom_title, created_at, updated_at, last_activity_at, deleted_at, transport FROM sessions WHERE transport = 'local' AND deleted_at IS NULL AND COALESCE(NULLIF(TRIM(custom_title), ''), NULLIF(TRIM(title), ''), id) = ? ORDER BY COALESCE(last_activity_at, updated_at, created_at) DESC, id LIMIT ?`);
    this.nativeTitleCountStatement = db.prepare(`SELECT COUNT(*) AS count FROM sessions WHERE transport = 'local' AND deleted_at IS NULL`);
    this.nativeTitleRowsStatement = db.prepare(`SELECT id, title, custom_title, cwd, created_at, updated_at, last_activity_at, deleted_at, transport FROM sessions WHERE transport = 'local' AND deleted_at IS NULL ORDER BY COALESCE(last_activity_at, updated_at, created_at) DESC, id LIMIT ?`);
    this.nativeSessionIdsStatement = db.prepare(`SELECT id FROM sessions WHERE transport = 'local' AND deleted_at IS NULL LIMIT ?`);
  }

  static open(options = {}) {
    const configDir = typeof options.configDir === 'string' && options.configDir.trim() ? options.configDir : nativeConfigDir();
    const uiAutomation = options.uiAutomation ?? {};
    if (uiAutomation === null || typeof uiAutomation !== 'object' || Array.isArray(uiAutomation) ||
        (uiAutomation.enabled !== undefined && typeof uiAutomation.enabled !== 'boolean')) {
      throw new Error('WorkBuddy UI Automation configuration is invalid');
    }
    if (uiAutomation.enabled === true && (process.platform !== 'win32' || typeof uiAutomation.executablePath !== 'string' ||
        !path.win32.isAbsolute(uiAutomation.executablePath) || path.win32.basename(uiAutomation.executablePath).toLowerCase() !== 'workbuddy.exe')) {
      throw new Error('WorkBuddy native control requires an enabled Windows configuration with an exact WorkBuddy.exe path');
    }
    const databasePath = path.join(configDir, 'workbuddy.db');
    try {
      const stat = fs.lstatSync(databasePath);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('not a regular database');
      const { DatabaseSync } = require('node:sqlite');
      const db = new DatabaseSync(databasePath, { readOnly: true });
      try {
        const columns = db.prepare('PRAGMA table_info("sessions")').all().map((row) => row.name);
        if (!REQUIRED_SESSION_COLUMNS.every((column) => columns.includes(column))) throw new Error('unsupported WorkBuddy history schema');
        return new WorkBuddyAdapter({ db, configDir, columns, uiAutomation });
      } catch (error) {
        db.close();
        throw error;
      }
    } catch {
      throw new Error(WORKBUDDY_DB_UNAVAILABLE);
    }
  }

  availableTools() { return this.uiAutomationEnabled ? ['local-history-read', 'native-ui-automation'] : ['local-history-read']; }
  canModelsList() { return this.uiAutomationEnabled; }
  canCreate() { return this.uiAutomationEnabled; }
  canSend() { return this.uiAutomationEnabled; }
  canStop() { return this.uiAutomationEnabled && this.pendingService != null && typeof this.uiAutomationInspector?.executeNativePendingAction === 'function'; }
  canSendWithModel() { return this.uiAutomationEnabled && typeof this.uiAutomationInspector?.selectNativeModel === 'function'; }
  canAnswer() { return this.canStop(); }
  canApprove() { return this.canStop(); }
  describe() {
    return {
      uiAutomation: {
        enabled: this.uiAutomationEnabled,
        ready: false,
        needsUnlockedDesktop: true,
        target: this.lastNativeObservation,
        capabilities: {
          modelsList: this.canModelsList(), create: this.canCreate(), send: this.canSend(),
          stop: this.canStop(), sendWithModel: this.canSendWithModel(), answer: this.canAnswer(), approve: this.canApprove(),
        },
      },
    };
  }

  close() {
    if (this.closePromise !== null) return this.closePromise;
    this.pendingService?.retire();
    const drained = this.nativeWriter.close();
    if (this.nativeWriter.inFlight === 0 && this.lifecycleOperations.size === 0) {
      // Preserve the adapter's synchronous close behavior when no native or
      // create lifecycle operation can still touch the read-only DB. Test and
      // fixture cleanup can then remove the database immediately after close.
      this.db.close();
      this.closePromise = drained;
    } else {
      const lifecycle = Promise.all([...this.lifecycleOperations]);
      this.closePromise = Promise.all([drained, lifecycle]).then(() => this.db.close());
    }
    return this.closePromise;
  }

  async discoverNativeWindow(hooks) {
    if (!this.uiAutomationEnabled || this.uiAutomationInspector === null) {
      throw new BridgeError('not_capable', 'WorkBuddy native UI Automation is not enabled');
    }
    hooks?.checkActive?.();
    const discovery = await this.uiAutomationInspector.discoverMainWindows({ expectedExePath: this.workbuddyExecutablePath }, hooks);
    if (discovery.inputDesktopKind !== 'default') {
      throw new BridgeError('not_capable', 'WorkBuddy native UI Automation needs the unlocked default Windows desktop');
    }
    const eligible = discovery.windows.filter((window) => window.visible && window.enabled && window.mainWindow);
    const foreground = eligible.filter((window) => window.isForeground);
    const candidates = foreground.length === 1
      ? foreground
      : eligible;
    if (candidates.length !== 1) {
      throw new BridgeError('not_capable', 'WorkBuddy must have one unambiguous visible main window for native UI Automation');
    }
    const target = candidates[0];
    this.lastNativeObservation = {
      processId: target.processId, handle: target.handle, visible: target.visible, enabled: target.enabled,
      minimized: target.minimized, isForeground: target.isForeground, observedAt: new Date().toISOString(),
    };
    return target;
  }

  async freshNativeSnapshot(target, { activate = false, knownConversationTitles } = {}, hooks) {
    if (!this.uiAutomationEnabled || this.uiAutomationInspector === null || !target) {
      throw new BridgeError('not_capable', 'WorkBuddy native UI Automation target is unavailable');
    }
    const options = {
      expectedExePath: this.workbuddyExecutablePath,
      expectedProcessId: target.processId,
      expectedHandle: target.handle,
      maxControls: 160,
    };
    activate = activate || target.minimized === true;
    hooks?.checkActive?.();
    const snapshot = activate
      ? await this.uiAutomationInspector.activateSemanticSnapshot({ ...options,
        ...(knownConversationTitles !== undefined ? { knownConversationTitles } : {}) }, hooks)
      : await this.uiAutomationInspector.semanticSnapshot({ ...options,
        ...(knownConversationTitles !== undefined ? { knownConversationTitles } : {}) }, hooks);
    this.lastNativeObservation = {
      processId: snapshot.target.processId, handle: snapshot.target.handle, visible: snapshot.target.visible,
      enabled: snapshot.target.enabled, minimized: snapshot.target.minimized, isForeground: snapshot.target.isForeground,
      inputDesktopKind: snapshot.inputDesktopKind, observedAt: new Date().toISOString(),
    };
    return snapshot;
  }

  findUniqueNativeControl(snapshot, safeActionLabel) {
    const controls = snapshot.controls.filter((control) => control.safeActionLabel === safeActionLabel &&
      !control.offscreen && !control.passwordProtected && control.runtimeIdHash !== '' && control.regionHash !== '');
    if (controls.length !== 1) {
      throw new BridgeError('not_capable', 'WorkBuddy did not expose one fresh matching native control');
    }
    return controls[0];
  }

  nativeConversationIdentityCandidates(sessionId) {
    if (typeof sessionId !== 'string' || !SAFE_SESSION_FILE_ID.test(sessionId)) {
      throw new BridgeError('invalid_params', 'invalid WorkBuddy session id');
    }
    const targetRow = this.readStatement.get(sessionId);
    if (!targetRow) throw new BridgeError('session_not_found', 'WorkBuddy local session not found');
    const title = nativeIdentityTitle(targetRow);
    if (!title) throw new BridgeError('not_capable', 'WorkBuddy cannot safely identify a session without a complete native title');
    const count = Number(this.identityTitleCountStatement.get(title)?.count);
    if (!Number.isInteger(count) || count < 1 || count > MAX_NATIVE_IDENTITY_CANDIDATES) {
      throw new BridgeError('not_capable', 'WorkBuddy has too many same-title conversations to bind safely');
    }
    const rows = this.identityCandidatesStatement.all(title, MAX_NATIVE_IDENTITY_CANDIDATES + 1);
    if (!Array.isArray(rows) || rows.length !== count || rows.length > MAX_NATIVE_IDENTITY_CANDIDATES) {
      throw new BridgeError('not_capable', 'WorkBuddy same-title conversation candidates changed during identity lookup');
    }
    const anchorCandidates = [];
    let expectedCandidateIndex = -1;
    for (const row of rows) {
      if (!row || typeof row.id !== 'string' || !SAFE_SESSION_FILE_ID.test(row.id) || row.transport !== 'local' || row.deleted_at !== null ||
          nativeIdentityTitle(row) !== title) {
        throw new BridgeError('not_capable', 'WorkBuddy same-title conversation metadata is incomplete');
      }
      const session = this.readSession(row.id);
      const anchors = nativeHistoryAnchors(session);
      if (!anchors) throw new BridgeError('not_capable', 'WorkBuddy same-title conversation history is incomplete; native binding was refused');
      if (row.id === sessionId) expectedCandidateIndex = anchorCandidates.length;
      anchorCandidates.push(anchors);
    }
    if (expectedCandidateIndex < 0) throw new BridgeError('not_capable', 'WorkBuddy target session disappeared during identity lookup');
    return { title, anchorCandidates, expectedCandidateIndex };
  }

  async verifyNativeConversationIdentity(sessionId, target) {
    if (!this.uiAutomationEnabled || this.uiAutomationInspector === null || !target) {
      throw new BridgeError('not_capable', 'WorkBuddy native UI Automation target is unavailable');
    }
    const expected = this.nativeConversationIdentityCandidates(sessionId);
    const observed = await this.uiAutomationInspector.inspectConversationIdentity({
      expectedExePath: this.workbuddyExecutablePath,
      expectedProcessId: target.processId,
      expectedHandle: target.handle,
      identityTitle: expected.title,
      anchorCandidates: expected.anchorCandidates,
    });
    const proof = observed.identityProof;
    if (!proof || proof.conversationHeaderMatches !== 1 ||
        proof.candidateCount !== expected.anchorCandidates.length || proof.matchedCandidateIndex !== expected.expectedCandidateIndex) {
      throw new BridgeError('not_capable', 'WorkBuddy current native conversation could not be uniquely matched to this local session');
    }
    return expected;
  }

  async newTaskFrame(target, knownConversationTitles, hooks, { requireVerifiedIntent = false } = {}) {
    const snapshot = await this.freshNativeSnapshot(target, { knownConversationTitles }, hooks);
    this.assertNativeTargetSnapshot(snapshot, target);
    const tabs = snapshot.controls.filter((control) => control.safeActionLabel === 'new-task-tab' &&
      control.controlType === 'ControlType.TabItem' && !control.offscreen && !control.passwordProtected &&
      control.runtimeIdHash !== '' && control.regionHash !== '');
    if (tabs.length !== 1) throw new BridgeError('not_capable', 'WorkBuddy does not expose one fresh New Task tab');
    let frame = null;
    if (snapshot.uiaCom.composerBindingSucceeded) {
      frame = this.assertNativeSnapshot(snapshot, target);
      if (frame.composer.draftState !== 'empty' || frame.composer.draftFingerprint !== EMPTY_DRAFT_FINGERPRINT || frame.send.enabled) {
        throw new BridgeError('not_capable', 'WorkBuddy new chat was refused because the native composer is not empty');
      }
    } else if (!this.isVerifiedGlobalNonChatPage(snapshot)) {
      throw new BridgeError('not_capable', 'WorkBuddy cannot verify an empty composer or a Skills/Projects page before New Task navigation');
    }
    if (requireVerifiedIntent && snapshot.newTaskPageProof?.verified !== true) {
      throw new BridgeError('not_capable', 'WorkBuddy could not positively verify the blank New Task page and its native composer region');
    }
    return { snapshot, frame, tab: tabs[0], knownConversationTitles };
  }

  isVerifiedGlobalNonChatPage(snapshot) {
    const status = snapshot?.uiaCom;
    if (!status || status.composerBindingSucceeded !== false || status.composerModelCandidates !== 0 || status.composerSendCandidates !== 0 ||
        snapshot.newTaskPageProof?.snapshotComplete !== true || snapshot.newTaskPageProof.selectedConversationTabMatches !== 0 ||
        snapshot.newTaskPageProof.conversationHeaderMatches !== 0 || !Array.isArray(snapshot.controls)) return false;
    if (snapshot.controls.some((control) => ['composer', 'model-selector', 'send-label'].includes(control.safeActionLabel))) return false;
    const selectedCategories = snapshot.controls.filter((control) => control.controlType === 'ControlType.TabItem' && control.selected)
      .map((control) => typeof control.accessibleName === 'string' ? control.accessibleName.trim().toLowerCase() : '')
      .map((name) => GLOBAL_NON_CHAT_TABS.get(name)).filter(Boolean);
    return selectedCategories.length > 0 && new Set(selectedCategories).size === 1;
  }

  async selectNewTaskPage(target, knownConversationTitles, hooks) {
    if (typeof this.uiAutomationInspector.navigateNewTask === 'function') {
      const snapshot = await this.uiAutomationInspector.navigateNewTask({
        expectedExePath: this.workbuddyExecutablePath, expectedProcessId: target.processId,
        expectedHandle: target.handle, maxControls: 160, knownConversationTitles,
      }, hooks);
      this.assertNativeTargetSnapshot(snapshot, target);
      const frame = this.assertNativeSnapshot(snapshot, target);
      if (snapshot.newTaskPageProof?.verified !== true || frame.composer.draftState !== 'empty' ||
          frame.composer.draftFingerprint !== EMPTY_DRAFT_FINGERPRINT || frame.send.enabled) {
        throw new BridgeError('not_capable', 'WorkBuddy did not verify an empty native New Task page; no message was written');
      }
      return { snapshot, frame, tab: this.findUniqueNativeControl(snapshot, 'new-task-tab'), knownConversationTitles };
    }
    let state = await this.newTaskFrame(target, knownConversationTitles, hooks);
    if (state.tab.selected) {
      if (state.snapshot.newTaskPageProof?.verified !== true) {
        throw new BridgeError('not_capable', 'WorkBuddy could not positively verify the blank New Task page and its native composer region');
      }
    } else {
      const selected = await this.executeNativeControl(target, state.tab, 'select', { knownConversationTitles }, hooks);
      if (!selected.actionResult.submitted) {
        const uncertain = selected.actionResult.attempted;
        throw new BridgeError(uncertain ? 'bridge_error' : 'not_capable', uncertain
          ? 'WorkBuddy New Task selection outcome is unknown; refresh the native window before another action'
          : 'WorkBuddy could not select the exact New Task tab');
      }
      state = await this.newTaskFrame(target, knownConversationTitles, hooks, { requireVerifiedIntent: true });
    }
    if (state.tab.selected !== true) throw new BridgeError('not_capable', 'WorkBuddy New Task tab is not selected');
    return state;
  }

  async submitNativeText(target, composer, text, { identity = null, newTaskTitles = null } = {}, hooks) {
    const expectedDraftFingerprint = EMPTY_DRAFT_FINGERPRINT;
    const setValueExtra = {
      expectedDraftFingerprint,
      payload: text,
      ...(identity ? { identityTitle: identity.title, anchorCandidates: identity.anchorCandidates,
        expectedCandidateIndex: identity.expectedCandidateIndex } :
        { requireNewTaskIntent: true, knownConversationTitles: newTaskTitles }),
    };
    const filled = typeof this.uiAutomationInspector.typeNativeComposer === 'function'
      ? await this.uiAutomationInspector.typeNativeComposer({ expectedExePath: this.workbuddyExecutablePath,
        expectedProcessId: target.processId, expectedHandle: target.handle, maxControls: 160, ...setValueExtra }, hooks)
      : await this.executeNativeControl(target, composer, 'set-value', setValueExtra, hooks);
    if (!filled.actionResult.submitted) {
      const uncertain = filled.actionResult.attempted;
      throw new BridgeError(uncertain ? 'bridge_error' : 'not_capable', uncertain
        ? 'WorkBuddy composer write outcome is unknown; refresh the native chat before another action'
        : 'WorkBuddy editor, model menu, or focus was unavailable; no message was typed');
    }

    hooks?.checkActive?.();
    const after = await this.freshNativeSnapshot(target, {}, hooks);
    const frame = this.assertNativeSnapshot(after, target);
    if (frame.composer.draftState !== 'non-empty' || frame.composer.draftFingerprint !== nativeDraftFingerprint(text) ||
        !frame.send.enabled) {
      throw new BridgeError('bridge_error', 'WorkBuddy native composer did not confirm the exact submitted draft; refresh before another action');
    }
    const sendExtra = {
      expectedDraftFingerprint: frame.composer.draftFingerprint,
      ...(identity ? { identityTitle: identity.title, anchorCandidates: identity.anchorCandidates,
        expectedCandidateIndex: identity.expectedCandidateIndex } :
        { requireNewTaskIntent: true, knownConversationTitles: newTaskTitles }),
    };
    const submitted = await this.executeNativeControl(target, frame.send, 'invoke', sendExtra, hooks);
    return { receipt: submitted, draftFingerprint: frame.composer.draftFingerprint };
  }

  async waitForCreatedNativeSession(previousIds, text, hooks) {
    const deadline = Date.now() + NATIVE_CREATE_CONFIRM_MS;
    for (;;) {
      hooks?.checkActive?.();
      const ids = this.readNativeSessionIds();
      const matching = [];
      for (const id of ids) {
        hooks?.checkActive?.();
        if (previousIds.has(id)) continue;
        let session;
        try { session = this.readSession(id); }
        catch (error) {
          if (error?.code === 'session_gone' || error?.code === 'session_not_found') continue;
          throw error;
        }
        const userMessages = session.messages.filter((message) => message.role === 'user');
        if (!session.historyTruncated && userMessages.length === 1 && userMessages[0].text === text) {
          const row = this.readStatement.get(id);
          if (row && row.transport === 'local' && row.deleted_at === null) matching.push({ id, row });
        }
      }
      if (matching.length === 1) {
        hooks?.checkActive?.();
        const { id, row } = matching[0];
        return { sessionId: id, title: sessionTitle(row) };
      }
      if (matching.length > 1) {
        hooks?.checkActive?.();
        throw new BridgeError('session_create_failed', 'WorkBuddy persisted more than one matching new chat; inspect the session list before retrying');
      }
      const remaining = Math.min(deadline - Date.now(), hooks?.remainingBudgetMs?.() ?? NATIVE_CREATE_CONFIRM_MS);
      if (remaining <= 0) break;
      await new Promise((resolve) => setTimeout(resolve, Math.min(150, remaining)));
    }
    hooks?.checkActive?.();
    throw new BridgeError('session_create_failed', 'WorkBuddy native send may have created a chat, but no exact new UUID and first message could be verified; inspect the session list before retrying');
  }

  async createSession(input, hooks = {}, workbuddyHooks) {
    if (!this.canCreate()) throw new BridgeError('not_capable', 'WorkBuddy native session creation is not enabled');
    if (!input || typeof input !== 'object' || typeof input.text !== 'string' || input.text.trim().length === 0 ||
        [...input.text].length > MAX_TEXT_CHARS || typeof input.model !== 'string' || !SAFE_MODEL_LABEL.test(input.model)) {
      throw new BridgeError('invalid_params', 'a WorkBuddy new chat needs a model and a non-empty first message');
    }
    if ((typeof input.projectId === 'string' && input.projectId.length > 0) ||
        (typeof input.cwd === 'string' && input.cwd.length > 0)) {
      throw new BridgeError('not_capable', 'WorkBuddy has no verified project picker in the current native UI; choose its desktop workspace first');
    }
    if ((typeof input.reasoningEffort === 'string' && input.reasoningEffort.length > 0) ||
        (typeof input.provider === 'string' && input.provider.length > 0)) {
      throw new BridgeError('not_capable', 'WorkBuddy does not expose a verified provider or reasoning-effort selector');
    }
    if (this.nativeWriter.retired) throw new BridgeError('not_capable', 'WorkBuddy native control is closed');
    let resolveLifecycle;
    const lifecycleOperation = new Promise((resolve) => { resolveLifecycle = resolve; });
    this.lifecycleOperations.add(lifecycleOperation);
    try {
    workbuddyHooks?.checkActive?.();
    const preSend = await this.nativeWriter.run(async (nativeHooks) => {
      const knownConversationTitles = this.readNativeTaskTitles();
      const previousIds = this.readNativeSessionIds();
      const target = await this.discoverNativeWindow(nativeHooks);
      const page = await this.selectNewTaskPage(target, knownConversationTitles, nativeHooks);
      if (page.frame.currentModel !== input.model) {
        await this.selectNativeModel(target, input.model, { knownConversationTitles }, nativeHooks);
      }
      const result = await this.submitNativeText(target, page.frame.composer, input.text,
        { newTaskTitles: knownConversationTitles }, nativeHooks);
      if (!result.receipt.actionResult.submitted) {
        if (result.receipt.actionResult.attempted) {
          return { previousIds, sendMayHaveOccurred: true };
        }
        throw new BridgeError('not_capable', 'WorkBuddy did not accept the exact native Send pattern');
      }
      return { previousIds, sendMayHaveOccurred: true };
    }, workbuddyHooks);

    const created = await this.waitForCreatedNativeSession(preSend.previousIds, input.text, workbuddyHooks);
    workbuddyHooks?.checkActive?.();
    if (typeof hooks.onCreated === 'function') hooks.onCreated({ sessionId: created.sessionId });
    workbuddyHooks?.checkActive?.();
    return created;
    } finally {
      resolveLifecycle();
      this.lifecycleOperations.delete(lifecycleOperation);
    }
  }

  async sendMessage(sessionId, text, options = {}, hooks) {
    if (!this.canSend()) throw new BridgeError('not_capable', 'WorkBuddy native sending is not enabled');
    if (typeof sessionId !== 'string' || !SAFE_SESSION_FILE_ID.test(sessionId) || typeof text !== 'string' ||
        text.trim().length === 0 || [...text].length > MAX_TEXT_CHARS) {
      throw new BridgeError('invalid_params', 'a WorkBuddy native message needs a session id and non-empty text');
    }
    if (options.model !== undefined && (typeof options.model !== 'string' || !SAFE_MODEL_LABEL.test(options.model))) {
      throw new BridgeError('invalid_params', 'invalid WorkBuddy model');
    }
    if (typeof options.provider === 'string' && options.provider.length > 0 ||
        typeof options.reasoningEffort === 'string' && options.reasoningEffort.length > 0) {
      throw new BridgeError('not_capable', 'WorkBuddy does not expose a verified provider or reasoning-effort selector');
    }
    return this.nativeWriter.run(async (nativeHooks) => {
      const identity = this.nativeConversationIdentityCandidates(sessionId);
      const target = await this.discoverNativeWindow(nativeHooks);
      const route = await this.uiAutomationInspector.navigateConversation({
        expectedExePath: this.workbuddyExecutablePath,
        expectedProcessId: target.processId,
        expectedHandle: target.handle,
        sessionId,
        identityTitle: identity.title,
        anchorCandidates: identity.anchorCandidates,
        expectedCandidateIndex: identity.expectedCandidateIndex,
      }, nativeHooks);
      if (route.outcome !== 'confirmed') {
        throw new BridgeError(route.outcome === 'submitted' ? 'bridge_error' : 'not_capable',
          route.outcome === 'submitted'
            ? 'WorkBuddy destination page could not be confirmed after native navigation; refresh before another action'
            : 'WorkBuddy could not prove the requested native conversation before navigation');
      }
      const snapshot = await this.freshNativeSnapshot(target, {}, nativeHooks);
      let frame = this.assertNativeSnapshot(snapshot, target);
      if (frame.composer.draftState !== 'empty' || frame.composer.draftFingerprint !== EMPTY_DRAFT_FINGERPRINT || frame.send.enabled) {
        throw new BridgeError('not_capable', 'WorkBuddy send was refused because the verified conversation has a user draft');
      }
      if (options.model && options.model !== frame.currentModel) {
        await this.selectNativeModel(target, options.model, { identity }, nativeHooks);
        frame = this.assertNativeSnapshot(await this.freshNativeSnapshot(target, {}, nativeHooks), target);
      }
      const submitted = await this.submitNativeText(target, frame.composer, text, { identity }, nativeHooks);
      if (!submitted.receipt.actionResult.submitted) {
        throw new BridgeError(submitted.receipt.actionResult.attempted ? 'bridge_error' : 'not_capable',
          submitted.receipt.actionResult.attempted
            ? 'WorkBuddy Send may have been invoked but has no confirmed UIA receipt; refresh the native chat before another action'
            : 'WorkBuddy did not accept the exact native Send pattern');
      }
      return { accepted: true, sessionId };
    }, hooks);
  }

  async selectNativeModel(target, model, { identity, knownConversationTitles }, hooks) {
    if (typeof this.uiAutomationInspector.selectNativeModel !== 'function') throw new BridgeError('model_not_available', 'WorkBuddy native model switching is unavailable');
    const receipt = await this.uiAutomationInspector.selectNativeModel({ expectedExePath: this.workbuddyExecutablePath,
      expectedProcessId: target.processId, expectedHandle: target.handle, maxControls: 160, model,
      ...(identity ? { identityTitle: identity.title, anchorCandidates: identity.anchorCandidates,
        expectedCandidateIndex: identity.expectedCandidateIndex } : { knownConversationTitles }),
    }, hooks);
    if (!receipt.verified) {
      const attempted = receipt.attempted || receipt.patternReceipts.some(r => r.attempted);
      throw new BridgeError(attempted ? 'bridge_error' : 'model_not_available', 'WorkBuddy native model selection could not be confirmed; refresh before another action');
    }
  }

  async readNativePendingContext(sessionId, hooks, analysis) {
    const identity = this.nativeConversationIdentityCandidates(sessionId);
    const target = await this.discoverNativeWindow(hooks);
    const activationAllowed = hooks?.allowWindowActivation === true;
    if (target.minimized === true) {
      if (!activationAllowed) throw new BridgeError('not_capable', 'Background history observation will not restore the WorkBuddy window');
      this.assertNativeTargetSnapshot(await this.freshNativeSnapshot(target, { activate: true }, hooks), target);
    }
    const pendingOptions = { expectedExePath: this.workbuddyExecutablePath,
      expectedProcessId: target.processId, expectedHandle: target.handle, maxControls: 160,
      identityTitle: identity.title, anchorCandidates: identity.anchorCandidates, expectedCandidateIndex: identity.expectedCandidateIndex,
      ...(analysis?.complete === true ? { questionMetadata: analysis.questionCandidates.filter(c=>c.complete===true).map(c=>c.questions) } : {}) };
    let observed = await this.uiAutomationInspector.readNativePending(pendingOptions, hooks);
    if (!observed.pendingForms.conversationIdentityVerified && activationAllowed && typeof this.uiAutomationInspector.navigateConversation === 'function') {
      const route = await this.uiAutomationInspector.navigateConversation({ ...pendingOptions, sessionId }, hooks);
      if (route.outcome !== 'confirmed') throw new BridgeError(route.outcome === 'submitted' ? 'bridge_error' : 'not_capable',
        'WorkBuddy could not verify the requested native conversation; no answer or permission was submitted');
      observed = await this.uiAutomationInspector.readNativePending(pendingOptions, hooks);
    }
    if (!observed.pendingForms.conversationIdentityVerified) {
      throw new BridgeError('not_capable', 'Background history observation will not switch the desktop conversation');
    }
    return { ...observed, target, identity };
  }

  async readSessionLive(sessionId, hooks) {
    if (!this.uiAutomationEnabled || this.pendingService === null) return this.readSession(sessionId);
    return this.nativeWriter.run(async nativeHooks => {
      try { return await this.pendingService.read(sessionId, nativeHooks); }
      catch (error) {
        nativeHooks?.checkActive?.();
        if (['not_capable','bridge_error','stale_request'].includes(error?.code)) return this.readSession(sessionId);
        throw error;
      }
    }, hooks);
  }

  answerQuestion(sessionId, callId, answers, hooks) {
    if (!this.canAnswer()) throw new BridgeError('not_capable', 'WorkBuddy native questions are disabled');
    return this.nativeWriter.run(nativeHooks => this.pendingService.decide(sessionId, callId, { answers },
      { ...nativeHooks, allowWindowActivation: true }), hooks);
  }

  approveRequest(sessionId, approvalId, decision, hooks) {
    if (!this.canApprove()) throw new BridgeError('not_capable', 'WorkBuddy native permissions are disabled');
    return this.nativeWriter.run(nativeHooks => this.pendingService.decide(sessionId, approvalId, { decision },
      { ...nativeHooks, allowWindowActivation: true }), hooks);
  }

  stopSession(sessionId, hooks) {
    if (!this.canStop()) throw new BridgeError('not_capable', 'WorkBuddy native Stop is disabled');
    return this.nativeWriter.run(nativeHooks => this.pendingService.stop(sessionId,
      { ...nativeHooks, allowWindowActivation: true }), hooks);
  }

  async executeNativeControl(target, control, action, extra = {}, hooks) {
    hooks?.checkActive?.();
    const receipt = await this.uiAutomationInspector.executeSemanticAction({
      expectedExePath: this.workbuddyExecutablePath,
      expectedProcessId: target.processId,
      expectedHandle: target.handle,
      action,
      safeActionLabel: control.safeActionLabel,
      runtimeIdHash: control.runtimeIdHash,
      regionHash: control.regionHash,
      ...extra,
    }, hooks);
    return receipt;
  }

  assertNativeSnapshot(snapshot, target) {
    this.assertNativeTargetSnapshot(snapshot, target);
    if (!snapshot.uiaCom.composerBindingSucceeded) {
      throw new BridgeError('not_capable', 'WorkBuddy exact native page and composer context could not be verified');
    }
    const model = this.findUniqueNativeControl(snapshot, 'model-selector');
    const composer = this.findUniqueNativeControl(snapshot, 'composer');
    const send = this.findUniqueNativeControl(snapshot, 'send-label');
    if (model.regionHash !== composer.regionHash || model.regionHash !== send.regionHash ||
        model.controlType !== 'ControlType.ComboBox' || !model.enabled ||
        !composer.enabled || composer.draftState === 'unavailable' || !send.patterns.includes('invoke')) {
      throw new BridgeError('not_capable', 'WorkBuddy did not expose one live, bound native model and composer frame');
    }
    const currentModel = normalizeModelName(model.accessibleName);
    if (!SAFE_MODEL_LABEL.test(currentModel) || redactSensitiveText(currentModel) !== currentModel) {
      throw new BridgeError('not_capable', 'WorkBuddy native current model could not be read safely');
    }
    return { model, composer, send, currentModel };
  }

  assertNativeTargetSnapshot(snapshot, target) {
    if (!snapshot || snapshot.operation !== 'semantic-snapshot' || snapshot.inputDesktopKind !== 'default' ||
        snapshot.target.processId !== target.processId || snapshot.target.handle !== target.handle ||
        snapshot.target.mainWindow !== true || snapshot.target.visible !== true || snapshot.target.enabled !== true ||
        snapshot.target.minimized !== false || !snapshot.processContext.sameWindowsSession ||
        !snapshot.processContext.sameBitness || !snapshot.processContext.sameIntegrityLevel ||
        snapshot.uiaCom.traversalTruncated || snapshot.uiaCom.errorType !== null || snapshot.uiaCom.errorStage !== '') {
      throw new BridgeError('not_capable', 'WorkBuddy exact native target and complete UI Automation tree could not be verified');
    }
    return snapshot;
  }

  readNativeTaskTitles() {
    const before = Number(this.nativeTitleCountStatement.get()?.count);
    if (!Number.isInteger(before) || before < 0 || before > MAX_NATIVE_TASK_TITLES) {
      throw new BridgeError('not_capable', 'WorkBuddy has too many local conversations to prove a new-task page');
    }
    const rows = this.nativeTitleRowsStatement.all(MAX_NATIVE_TASK_TITLES + 1);
    const after = Number(this.nativeTitleCountStatement.get()?.count);
    if (!Array.isArray(rows) || before !== after || rows.length !== before) {
      throw new BridgeError('not_capable', 'WorkBuddy local conversation titles changed during new-task verification');
    }
    const titles = new Set();
    for (const row of rows) {
      if (!row || row.transport !== 'local' || row.deleted_at !== null) {
        throw new BridgeError('not_capable', 'WorkBuddy local conversation metadata is incomplete');
      }
      const title = nativeIdentityTitle(row);
      if (!title) throw new BridgeError('not_capable', 'WorkBuddy has a local conversation without a safe complete title');
      titles.add(title);
    }
    return [...titles];
  }

  readNativeSessionIds() {
    const rows = this.nativeSessionIdsStatement.all(MAX_NATIVE_SESSION_IDS + 1);
    if (!Array.isArray(rows) || rows.length > MAX_NATIVE_SESSION_IDS ||
        rows.some((row) => !row || typeof row.id !== 'string' || !SAFE_SESSION_FILE_ID.test(row.id))) {
      throw new BridgeError('not_capable', 'WorkBuddy local session index is too large or incomplete to confirm a newly created chat');
    }
    return new Set(rows.map((row) => row.id));
  }

  async listModels(hooks) {
    if (!this.canModelsList()) throw new BridgeError('not_capable', 'WorkBuddy native model listing is not enabled');
    return this.nativeWriter.run(async (nativeHooks) => {
      nativeHooks?.checkActive?.();
      const cached = cachedProductModelCatalog(this.configDir);
      nativeHooks?.checkActive?.();
      if (cached !== null) return cached;
      if (nativeHooks?.allowWindowActivation !== true) {
        throw new BridgeError('not_capable', 'WorkBuddy has no fresh local model cache; background model reads will not operate its window');
      }
      const knownConversationTitles = this.readNativeTaskTitles();
      const target = await this.discoverNativeWindow(nativeHooks);
      const initial = await this.freshNativeSnapshot(target, { knownConversationTitles }, nativeHooks);
      this.assertNativeTargetSnapshot(initial, target);
      if (initial.uiaCom.composerBindingSucceeded !== true) {
        await this.selectNewTaskPage(target, knownConversationTitles, nativeHooks);
      }
      nativeHooks?.checkActive?.();
      const catalog = await this.uiAutomationInspector.readNativeModelCatalog({
        expectedExePath: this.workbuddyExecutablePath,
        expectedProcessId: target.processId,
        expectedHandle: target.handle,
      }, nativeHooks);
      nativeHooks?.checkActive?.();
      const catalogCurrentModel = typeof catalog?.catalog?.currentModel === 'string'
        ? normalizeModelName(catalog.catalog.currentModel) : '';
      if (!SAFE_MODEL_LABEL.test(catalogCurrentModel) || redactSensitiveText(catalogCurrentModel) !== catalogCurrentModel ||
          catalog.targetContextVerified !== true || catalog.catalog.targetContextVerified !== true ||
          catalog.catalog.composerVerified !== true || !/^[a-f0-9]{16}$/.test(catalog.catalog.initialDraftFingerprint) ||
          catalog.catalog.finalDraftFingerprint !== catalog.catalog.initialDraftFingerprint) {
        throw new BridgeError(catalog.outcome === 'submitted' ? 'bridge_error' : 'not_capable',
          catalog.outcome === 'submitted'
            ? 'WorkBuddy model catalog read may have changed the native selector; refresh before another action'
            : 'WorkBuddy could not verify the native model selector and unchanged composer');
      }
      const nativeModels = catalog.outcome === 'confirmed' && Array.isArray(catalog.catalog.models)
        ? catalog.catalog.models : [catalogCurrentModel];
      const labels = uniqueModelOptions(nativeModels.map((label) => ({ accessibleName: label })));
      if (labels.length === 0 || !labels.includes(catalogCurrentModel)) {
        throw new BridgeError('not_capable', 'WorkBuddy native model options could not be read safely');
      }
      return {
        models: labels.map((label) => ({ id: label, label, isDefault: label === catalogCurrentModel })),
        projects: [],
        currentModel: catalogCurrentModel,
        catalogSource: catalog.outcome === 'confirmed'
          ? 'WorkBuddy native model options (UIA listbox; project catalog unavailable)'
          : 'WorkBuddy current model only (native UIA catalog unavailable; project catalog unavailable)',
      };
    }, hooks);
  }

  listSessions() {
    const rows = this.listStatement.all(MAX_LIST);
    const result = [];
    for (const row of rows) {
      if (typeof row.id !== 'string' || !SAFE_SESSION_FILE_ID.test(row.id) || typeof row.cwd !== 'string' || !path.isAbsolute(row.cwd)) continue;
      const updatedAt = timestamp(row.last_activity_at) ?? timestamp(row.updated_at) ?? timestamp(row.created_at);
      if (updatedAt === null) continue;
      const title = typeof row.custom_title === 'string' && row.custom_title.trim() !== ''
        ? row.custom_title
        : typeof row.title === 'string' && row.title.trim() !== '' ? row.title : row.id;
      result.push({
        id: row.id,
        tool: 'workbuddy',
        title: sessionTitle(row),
        status: 'unknown',
        updatedAt,
        cwd: row.cwd,
      });
    }
    return result;
  }

  readSession(sessionId, options = {}) {
    if (typeof sessionId !== 'string' || !SAFE_SESSION_FILE_ID.test(sessionId)) throw new BridgeError('invalid_params', 'invalid WorkBuddy session id');
    const row = this.readStatement.get(sessionId);
    if (!row) throw new BridgeError('session_not_found', 'WorkBuddy local session not found');
    const located = historyPath(this.configDir, row);
    if (located === null) throw new BridgeError('session_gone', HISTORY_UNAVAILABLE);

    const { lines, truncated: sourceTruncated } = readTail(located.file);
    const records = [];
    const messages = [];
    const toolNames = new Map();
    let historyTruncated = sourceTruncated;
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      if (Buffer.byteLength(line, 'utf8') > MAX_LINE_BYTES) {
        historyTruncated = true;
        continue;
      }
      let record;
      try { record = JSON.parse(line); } catch { historyTruncated = true; continue; }
      if (record && typeof record === 'object' && !Array.isArray(record)) records.push(record);
    }
    const replay = replayRecords(records);
    historyTruncated ||= replay.incomplete;
    for (let index = 0; index < replay.records.length; index++) {
      const message = toMessage(replay.records[index], toolNames, index);
      if (message !== null) messages.push(message);
    }
    if (messages.length > MAX_MESSAGES) {
      messages.splice(0, messages.length - MAX_MESSAGES);
      historyTruncated = true;
    }
    const occurrences = new Map();
    for (const message of messages) {
      const occurrence = occurrences.get(message.id) ?? 0;
      occurrences.set(message.id, occurrence + 1);
      message.id += `:${occurrence}`;
      historyTruncated ||= message._textTruncated;
      delete message._index;
      delete message._textTruncated;
    }

    const title = typeof row.custom_title === 'string' && row.custom_title.trim() !== ''
      ? row.custom_title
      : typeof row.title === 'string' && row.title.trim() !== '' ? row.title : row.id;
    const session = {
      id: row.id,
      tool: 'workbuddy',
      title: sessionTitle(row),
      status: 'unknown',
      messages,
      canStop: false,
      historyTruncated,
    };
    return options.includeSource === true ? { session, records: replay.records, cwd: row.cwd, historyTruncated } : session;
  }
}

module.exports = {
  cachedProductModelCatalog,
  WorkBuddyAdapter,
  nativeConfigDir,
  nativeWorkspaceKey,
  normalizeModelName,
  uniqueModelOptions,
  nativeIdentityTitle,
  nativeHistoryAnchors,
  MAX_NATIVE_IDENTITY_CANDIDATES,
  historyPath,
  redactSensitiveText,
  WORKBUDDY_DB_UNAVAILABLE,
  HISTORY_UNAVAILABLE,
  MAX_HISTORY_BYTES,
  MAX_LINE_BYTES,
  replayRecords,
};
