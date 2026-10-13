'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const packer = fs.readFileSync(path.join(ROOT, 'scripts', 'pack.mjs'), 'utf8');
const runtimeList = packer.match(/const SOURCE_RUNTIME_FILES = Object\.freeze\(\[([\s\S]*?)\]\);/);
assert.ok(runtimeList, 'the packer must use an explicit runtime allowlist');
const runtimeNames = [...runtimeList[1].matchAll(/'([^']+)'/g)].map(match => match[1]);
const runtime = new Set(runtimeNames);

test('the release runtime graph is complete without private tooling or research sources', () => {
  assert.equal(runtimeNames.length, runtime.size, 'runtime entries must be unique');
  for (const name of runtimeNames) {
    assert.doesNotMatch(name, /(?:^|\/)(?:\.private|\.native-src|test|tests|node_modules|dist)(?:\/|$)/);
    const source = fs.readFileSync(path.join(ROOT, name), 'utf8');
    for (const match of source.matchAll(/\brequire\(['"](\.[^'"\r\n]+)['"]\)/g)) {
      let imported = path.posix.normalize(path.posix.join(path.posix.dirname(name), match[1]));
      if (!path.posix.extname(imported)) imported += '.js';
      assert.ok(imported === 'package.json' || runtime.has(imported), `${name} imports missing release entry ${imported}`);
    }
  }
});

test('every WorkBuddy runtime layer is explicitly packaged', () => {
  for (const name of ['history-state.js', 'pending-items.js', 'uia-pending-controller.js', 'pending-service.js', 'windows-uia.js', 'writer.js']) {
    const entry = `src/workbuddy-native/${name}`;
    assert.ok(runtime.has(entry), `${entry} is required by native control`);
    assert.ok(fs.statSync(path.join(ROOT, entry)).isFile());
  }
});

test('all C# sources compiled by the shipped UIA helper are present in the release', () => {
  const helper = fs.readFileSync(path.join(ROOT, 'src', 'workbuddy-native', 'windows-uia.ps1'), 'utf8');
  for (const name of ['windows-uia-com.cs', 'windows-uia-pending.cs', 'model-popup.cs', 'pending-actions.cs', 'native-input.cs']) {
    const entry = `src/workbuddy-native/${name}`;
    assert.ok(fs.statSync(path.join(ROOT, entry)).isFile());
    assert.ok(helper.includes(`'${name}'`), `${name} must be loaded by the helper`);
    assert.ok(packer.includes(`name: '${entry}'`), `${name} must be copied to the release`);
  }
});
