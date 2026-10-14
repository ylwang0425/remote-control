'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { boundedJson } = require('./credentials');

function safePath(value) {
  return typeof value === 'string' && value.length <= 4096 && path.isAbsolute(value) && !/[\r\n\0]/.test(value);
}

function regularDirectory(parent, name) {
  const directory = path.join(parent, name);
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Workspace metadata directory is not regular');
  return directory;
}

/** Read native workspace metadata only; never infer a workspace from another account's home state. */
function readNativeWorkspacePaths({ configDir, db, accountId }) {
  const paths = [];
  try {
    const root = fs.realpathSync(configDir);
    const storage = regularDirectory(root, 'storage');
    const device = regularDirectory(storage, 'device');
    const scoped = regularDirectory(device, 'scoped');
    const buckets = fs.readdirSync(scoped, { withFileTypes: true });
    if (buckets.length <= 32 && typeof accountId === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(accountId)) {
      for (const bucket of buckets) {
        if (!bucket.isDirectory() || bucket.isSymbolicLink() || !/^[0-9a-f]{16}$/i.test(bucket.name)) continue;
        try {
          const directory = regularDirectory(scoped, bucket.name);
          const data = boundedJson(path.join(directory, 'newTaskWorkspace.json'), 256 * 1024);
          const selected = data?.[`__home__:${accountId}:anonymous`];
          if (!selected || typeof selected !== 'object' || Array.isArray(selected)) continue;
          for (const value of [selected.cwd, selected.lastLocalWorkspace]) if (safePath(value)) paths.push(value);
        } catch { /* A missing or incompatible home record does not replace the native catalog. */ }
      }
    }
  } catch { /* Older distributions may not have device-scoped home storage. */ }

  try {
    const columns = db.prepare('PRAGMA table_info(workspaces)').all().map(row => row.name);
    if (columns.includes('path') && columns.includes('last_opened_at')) {
      // WorkBuddy's two-column table is device-local. If a newer schema binds
      // entries to an account, retain that account boundary as well.
      const owner = columns.includes('user_id') ? 'user_id' : columns.includes('account_id') ? 'account_id' : null;
      const statement = db.prepare(`SELECT path FROM workspaces${owner ? ` WHERE ${owner} = ?` : ''} ORDER BY last_opened_at DESC LIMIT 200`);
      const rows = owner ? statement.all(accountId) : statement.all();
      for (const row of rows) if (safePath(row.path)) paths.push(row.path);
    }
  } catch { /* A missing workspace table still permits home state and session directories. */ }
  return paths;
}

module.exports = { readNativeWorkspacePaths };
