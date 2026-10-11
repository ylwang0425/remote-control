'use strict';

/**
 * Read-only fallback discovery for the Codex app-tools calling context.
 *
 * Codex app-tools requires a real local thread id in each invocation. A bridge
 * launched from Explorer does not inherit the Codex launcher environment, so
 * when no explicit context is configured we inspect only the local thread
 * metadata index. We never read thread titles, previews, message bodies, or
 * rollout files, and we open the database with SQLite's read-only flag.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const CONTEXT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CONTEXT_UNAVAILABLE = '未找到可用的本机 Codex 对话上下文。请先打开一条本机对话，或在配置中设置 codex.contextThreadId。';

function validContextId(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 256 &&
    value.trim() === value && !/\p{Cc}/u.test(value);
}

function stateDatabasePaths(options = {}) {
  if (typeof options.databasePath === 'string' && options.databasePath.length > 0) {
    return [options.databasePath];
  }
  const env = options.env ?? process.env;
  const home = typeof env.CODEX_HOME === 'string' && env.CODEX_HOME.trim().length > 0
    ? path.resolve(env.CODEX_HOME)
    : path.join(options.home ?? os.homedir(), '.codex');
  let files;
  try {
    files = fs.readdirSync(home, { withFileTypes: true })
      .filter((entry) => entry.isFile() && /^state_\d+\.sqlite$/i.test(entry.name))
      .sort((left, right) => {
        const leftVersion = Number(/state_(\d+)\.sqlite/i.exec(left.name)?.[1] ?? 0);
        const rightVersion = Number(/state_(\d+)\.sqlite/i.exec(right.name)?.[1] ?? 0);
        return rightVersion - leftVersion;
      });
  } catch {
    return [];
  }
  return files.map((entry) => path.join(home, entry.name));
}

function unavailable(reason = CONTEXT_UNAVAILABLE) {
  return { contextThreadId: null, reason };
}

/** Return a validated id and a safe explanation without returning native rows. */
function discoverCodexContext(options = {}) {
  let DatabaseSync;
  try {
    ({ DatabaseSync } = require('node:sqlite'));
  } catch {
    return unavailable('当前 Node 不支持只读 Codex 索引发现。请使用 Node 22.13 或更新版本，或设置 codex.contextThreadId。');
  }

  const [databasePath] = stateDatabasePaths(options);
  if (databasePath === undefined) return unavailable();

  let db;
  try {
    db = new DatabaseSync(databasePath, { readOnly: true });
    const columns = new Set(db.prepare('PRAGMA table_info(threads)').all().map((column) => column.name));
    const required = ['id', 'source', 'thread_source', 'originator', 'archived', 'agent_role', 'agent_path'];
    if (required.some((column) => !columns.has(column))) {
      return unavailable('无法安全识别此版本的 Codex 本机索引。请在桌面配置中设置 codex.contextThreadId。');
    }
    const updatedColumn = ['updated_at_ms', 'updated_at', 'created_at_ms', 'created_at'].find((column) => columns.has(column));
    if (updatedColumn === undefined) {
      return unavailable('Codex 本机索引缺少可用的会话时间字段。请在桌面配置中设置 codex.contextThreadId。');
    }

    // `vscode` + `Codex Desktop` + `user` are the local desktop-owned records
    // observed in state_5.sqlite. This exact source filter excludes cloud,
    // remote, CLI, and structured subagent records; archive and agent markers
    // provide additional explicit rejection. No title or conversation content
    // is selected.
    const rows = db.prepare(`
      SELECT id
      FROM threads
      WHERE lower(source) = 'vscode'
        AND lower(thread_source) = 'user'
        AND lower(originator) = 'codex desktop'
        AND archived = 0
        AND agent_role IS NULL
        AND agent_path IS NULL
      ORDER BY ${updatedColumn} DESC
      LIMIT 64
    `).all();
    const match = rows.find((row) => typeof row.id === 'string' && CONTEXT_ID.test(row.id));
    return match === undefined ? unavailable() : { contextThreadId: match.id, reason: null };
  } catch {
    return unavailable();
  } finally {
    try { db?.close(); } catch { /* a read-only handle may already be closed */ }
  }
}

/** Explicit configuration/environment always wins over metadata discovery. */
function resolveCodexContext(options = {}) {
  const env = options.env ?? process.env;
  for (const value of [options.configured, env.CODEX_THREAD_ID, env.CODEX_SESSION_ID]) {
    if (validContextId(value)) return { contextThreadId: value, source: 'explicit', reason: null };
  }
  const discovered = (options.discover ?? discoverCodexContext)(options.discoveryOptions ?? {});
  if (discovered !== null && typeof discovered === 'object' && validContextId(discovered.contextThreadId)) {
    return { ...discovered, source: 'local-metadata' };
  }
  return unavailable(discovered?.reason ?? CONTEXT_UNAVAILABLE);
}

module.exports = {
  CONTEXT_UNAVAILABLE,
  discoverCodexContext,
  resolveCodexContext,
  stateDatabasePaths,
  validContextId,
};
