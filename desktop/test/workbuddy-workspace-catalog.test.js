'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { readNativeWorkspacePaths } = require('../src/workbuddy-native/workspace-catalog');

function fixture(t, ownerColumn = '') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-workspaces-'));
  const scoped = path.join(root, 'storage', 'device', 'scoped');
  const bucket = path.join(scoped, 'c7389fe09fa872c0');
  fs.mkdirSync(bucket, { recursive: true });
  const db = new DatabaseSync(path.join(root, 'workbuddy.db'));
  db.exec(`CREATE TABLE workspaces (path TEXT, last_opened_at INTEGER${ownerColumn ? `, ${ownerColumn} TEXT` : ''})`);
  t.after(() => {
    db.close();
    const relative = path.relative(os.tmpdir(), root);
    assert.ok(relative.startsWith('wb-workspaces-') && path.dirname(relative) === '.');
    fs.rmSync(root, { recursive: true, force: true });
  });
  const write = value => fs.writeFileSync(path.join(bucket, 'newTaskWorkspace.json'), JSON.stringify(value));
  const read = () => readNativeWorkspacePaths({ configDir: root, db, accountId: 'current-owner' });
  return { root, db, bucket, scoped, write, read };
}

test('a selected desktop workspace without any chat is included before the recent workspace table', t => {
  const f = fixture(t); const selected = path.join(f.root, 'lifebot'); const recent = path.join(f.root, 'date-project');
  f.write({ '__home__:current-owner:anonymous': { cwd: selected, lastLocalWorkspace: selected } });
  f.db.prepare('INSERT INTO workspaces VALUES (?, ?)').run(recent, 1);
  assert.deepEqual(f.read(), [selected, selected, recent]);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS count FROM workspaces').get().count, 1);
});

test('home metadata from another account and unrelated fields cannot supply project paths', t => {
  const f = fixture(t); const foreign = path.join(f.root, 'foreign-project');
  f.write({ '__home__:another-owner:anonymous': { cwd: foreign }, '__home__:current-owner:organization': { cwd: foreign },
    unrelated: { cwd: foreign }, '__home__:current-owner:anonymous': { cwd: 'relative/path', lastLocalWorkspace: foreign + '\0' } });
  assert.deepEqual(f.read(), []);
});

test('account-bound native workspace schemas filter the current owner', t => {
  const f = fixture(t, 'user_id'); const own = path.join(f.root, 'own-project');
  f.db.prepare('INSERT INTO workspaces VALUES (?, ?, ?)').run(own, 1, 'current-owner');
  f.db.prepare('INSERT INTO workspaces VALUES (?, ?, ?)').run(path.join(f.root, 'foreign'), 2, 'another-owner');
  assert.deepEqual(f.read(), [own]);
});

test('corrupt or oversized home metadata cannot hide valid recent workspaces', t => {
  const f = fixture(t); const recent = path.join(f.root, 'recent-project');
  f.db.prepare('INSERT INTO workspaces VALUES (?, ?)').run(recent, 1);
  fs.writeFileSync(path.join(f.bucket, 'newTaskWorkspace.json'), '{broken');
  assert.deepEqual(f.read(), [recent]);
  fs.writeFileSync(path.join(f.bucket, 'newTaskWorkspace.json'), 'x'.repeat(256 * 1024 + 1));
  assert.deepEqual(f.read(), [recent]);
});
