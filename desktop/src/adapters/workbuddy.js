'use strict';

/**
 * Read WorkBuddy's existing local conversation archive.
 *
 * The native app keeps searchable session metadata in workbuddy.db and the
 * canonical transcript in projects/<native cwd key>/<session id>.jsonl. The
 * bridge opens the database explicitly read-only and never uses WorkBuddy's
 * account/runtime owner-bucket fallback. This adapter has no write, model,
 * question, approval, or stop operation.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { TextDecoder } = require('node:util');

const { BridgeError } = require('../errors');
const { isSessionId, MAX_MESSAGES, toRfc3339 } = require('../protocol');

const MAX_LIST = 200;
const MAX_HISTORY_BYTES = 4 * 1024 * 1024;
const MAX_LINE_BYTES = 512 * 1024;
const MAX_HISTORY_RECORDS = 5000;
const MAX_TEXT_CHARS = 65536;
const WORKBUDDY_DB_UNAVAILABLE = '无法只读打开 WorkBuddy 本地历史数据库；请确认此 Windows 用户已安装并运行过 WorkBuddy。';
const HISTORY_UNAVAILABLE = '此 WorkBuddy 会话的本地历史记录暂不可用。';

const REQUIRED_SESSION_COLUMNS = ['id', 'cwd', 'title', 'custom_title', 'created_at', 'updated_at', 'last_activity_at', 'deleted_at', 'transport'];
const SAFE_MESSAGE_ID = /^[A-Za-z0-9._:-]{1,128}$/;
const SAFE_SESSION_FILE_ID = /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,127}$/;

function sessionTitle(row) {
  const value = typeof row.custom_title === 'string' && row.custom_title.trim()
    ? row.custom_title : typeof row.title === 'string' && row.title.trim() ? row.title : row.id;
  return redactSensitiveText(value).replace(/[\r\n\p{Cc}]/gu, ' ').trim().slice(0, 200) || row.id;
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
  constructor({ db, configDir, columns }) {
    this.db = db;
    this.configDir = configDir;
    this.columns = new Set(columns);
    this.listStatement = db.prepare(`SELECT id, cwd, title, custom_title, created_at, updated_at, last_activity_at, deleted_at, transport FROM sessions WHERE transport = 'local' AND deleted_at IS NULL ORDER BY COALESCE(last_activity_at, updated_at, created_at) DESC LIMIT ?`);
    this.readStatement = db.prepare(`SELECT id, cwd, title, custom_title, created_at, updated_at, last_activity_at, deleted_at, transport FROM sessions WHERE id = ? AND transport = 'local' AND deleted_at IS NULL LIMIT 1`);
  }

  static open(options = {}) {
    const configDir = typeof options.configDir === 'string' && options.configDir.trim() ? options.configDir : nativeConfigDir();
    const databasePath = path.join(configDir, 'workbuddy.db');
    try {
      const stat = fs.lstatSync(databasePath);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('not a regular database');
      const { DatabaseSync } = require('node:sqlite');
      const db = new DatabaseSync(databasePath, { readOnly: true });
      try {
        const columns = db.prepare('PRAGMA table_info("sessions")').all().map((row) => row.name);
        if (!REQUIRED_SESSION_COLUMNS.every((column) => columns.includes(column))) throw new Error('unsupported WorkBuddy history schema');
        return new WorkBuddyAdapter({ db, configDir, columns });
      } catch (error) {
        db.close();
        throw error;
      }
    } catch {
      throw new Error(WORKBUDDY_DB_UNAVAILABLE);
    }
  }

  availableTools() { return ['local-history-read']; }
  canStop() { return false; }
  canSendWithModel() { return false; }
  canAnswer() { return false; }
  canApprove() { return false; }
  close() { this.db.close(); }

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

  readSession(sessionId) {
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
    return {
      id: row.id,
      tool: 'workbuddy',
      title: sessionTitle(row),
      status: 'unknown',
      messages,
      canStop: false,
      historyTruncated,
    };
  }
}

module.exports = {
  WorkBuddyAdapter,
  nativeConfigDir,
  nativeWorkspaceKey,
  historyPath,
  redactSensitiveText,
  WORKBUDDY_DB_UNAVAILABLE,
  HISTORY_UNAVAILABLE,
  MAX_HISTORY_BYTES,
  MAX_LINE_BYTES,
  replayRecords,
};
