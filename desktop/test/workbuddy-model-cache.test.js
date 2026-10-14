'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { WorkBuddyAdapter, cachedProductModelCatalog } = require('../src/adapters/workbuddy');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'workbuddy-model-cache-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const cache = path.join(root, 'cache');
  fs.mkdirSync(cache);
  const file = path.join(cache, 'acc-product-config-v3.json');
  const product = {
    productName: 'WorkBuddy', dataFolderName: '.workbuddy',
    authentication: { id: 'workbuddy-desktop', token: 'private-fixture-value' },
    agents: [{ name: 'cli', models: ['quick', 'actual-model', 'alias'] }],
    models: [{ id: 'quick', name: '快速', isDefault: true },
      { id: 'actual-model', name: 'Native Model' }, { id: 'alias', name: 'Native Model' },
      { id: 'unlisted', name: 'Unavailable Model' }],
  };
  const write = () => fs.writeFileSync(file, JSON.stringify(product));
  write();
  return { root, file, product, write };
}

test('local model cache uses the configured CLI subset and merges aliases without inventing the current selection', t => {
  const f = fixture(t);
  const listed = cachedProductModelCatalog(f.root);
  assert.deepEqual(listed.models, [
    { id: '快速', label: '快速', isDefault: false },
    { id: 'Native Model', label: 'Native Model', isDefault: false },
  ]);
  assert.equal(listed.currentModel, null);
  assert.deepEqual(listed.projects, []);
  assert.match(listed.catalogSource, /local product cache/);
  assert.ok(Number.isFinite(Date.parse(listed.observedAt)));
  assert.ok(!JSON.stringify(listed).includes('private-fixture-value'));
});

test('models.list with a fresh local cache never discovers, restores or changes a native window', async t => {
  const f = fixture(t);
  const adapter = new WorkBuddyAdapter({
    db: { prepare: () => ({ all: () => [], get: () => null }), close() {} },
    configDir: f.root, columns: [],
    uiAutomation: { enabled: true, executablePath: 'D:\\tools\\WorkBuddy\\WorkBuddy.exe' },
  });
  adapter.discoverNativeWindow = () => { throw new Error('Native UI must not be called'); };
  let checked = 0;
  const listed = await adapter.listModels({ checkActive: () => { checked++; } });
  assert.equal(listed.models.length, 2);
  assert.ok(checked >= 2);
  await adapter.close();
  await assert.rejects(adapter.listModels(), /closed/);
});

test('cache rejects other products, ambiguous agents, unresolved references and unsafe model names', t => {
  const f = fixture(t);
  const original = JSON.stringify(f.product);
  for (const mutate of [
    p => { p.productName = 'CodeBuddy'; },
    p => { p.authentication.id = 'external'; },
    p => { p.agents.push({ name: 'cli', models: ['quick'] }); },
    p => { p.agents[0].models.push('missing-native-id'); },
    p => { p.agents[0].models.push('quick'); },
    p => { p.models.push({ id: 'quick', name: 'Duplicate' }); },
    p => { p.models[0].name = 'access_token=private-value'; },
    p => { p.models[0].name = 'Malformed\nModel'; },
  ]) {
    const changed = JSON.parse(original);
    mutate(changed);
    fs.writeFileSync(f.file, JSON.stringify(changed));
    assert.equal(cachedProductModelCatalog(f.root), null);
  }
});

test('cache age, bounded file reads and malformed UTF-8 never yield selectable models', t => {
  const f = fixture(t);
  const stat = fs.statSync(f.file);
  assert.equal(cachedProductModelCatalog(f.root, stat.mtimeMs + 86400001), null);
  assert.equal(cachedProductModelCatalog(f.root, stat.mtimeMs - 300001), null);
  fs.writeFileSync(f.file, Buffer.alloc(1024 * 1024 + 1, 32));
  assert.equal(cachedProductModelCatalog(f.root), null);
  fs.writeFileSync(f.file, Buffer.from([0xc0, 0xaf]));
  assert.equal(cachedProductModelCatalog(f.root), null);
  fs.writeFileSync(f.file, '{"productName":');
  assert.equal(cachedProductModelCatalog(f.root), null);
  fs.unlinkSync(f.file);
  assert.equal(cachedProductModelCatalog(f.root), null);
});

test('a missing cache never triggers a native window operation during background model listing', async t => {
  const f = fixture(t);
  fs.unlinkSync(f.file);
  const adapter = new WorkBuddyAdapter({
    db: { prepare: () => ({ all: () => [], get: () => null }), close() {} },
    configDir: f.root, columns: [],
    uiAutomation: { enabled: true, executablePath: 'D:\\tools\\WorkBuddy\\WorkBuddy.exe' },
  });
  adapter.discoverNativeWindow = () => { throw new Error('Must not even discover a native window'); };
  adapter.freshNativeSnapshot = () => { throw new Error('Must not restore a window'); };
  await assert.rejects(adapter.listModels(), /background model reads will not operate/);
  await adapter.close();
});
