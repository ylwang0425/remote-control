'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  loadConfig,
  normalizeWorkBuddyExecutablePath,
  redactedConfig,
  saveConfig,
} = require('../src/config');

test('WorkBuddy UIA is default-off and only an absolute WorkBuddy.exe path is accepted', () => {
  const file = path.join(os.tmpdir(), `ai-remote-workbuddy-config-${require('node:crypto').randomUUID()}.json`);
  try {
    fs.writeFileSync(file, JSON.stringify({ workbuddy: { configDir: 'C:\\Users\\Local\\.workbuddy' } }), 'utf8');
    const defaults = loadConfig({ path: file, env: {} });
    assert.deepEqual(defaults.workbuddy.uiAutomation, {
      enabled: false,
      executablePath: null,
      configurationValid: true,
    });

    const exePath = 'C:\\Program Files\\WorkBuddy\\WorkBuddy.exe';
    fs.writeFileSync(file, JSON.stringify({ workbuddy: { uiAutomation: { enabled: true, executablePath: exePath } } }), 'utf8');
    const enabled = loadConfig({ path: file, env: {} });
    assert.deepEqual(enabled.workbuddy.uiAutomation, {
      enabled: true,
      executablePath: exePath,
      configurationValid: true,
    });
    assert.equal(normalizeWorkBuddyExecutablePath(exePath), exePath);
    for (const invalid of ['WorkBuddy.exe', 'C:\\Apps\\Other.exe', 'C:\\Apps\\WorkBuddy.exe\n', 'https://host/WorkBuddy.exe']) {
      assert.throws(() => normalizeWorkBuddyExecutablePath(invalid), /absolute WorkBuddy\.exe/);
    }

    fs.writeFileSync(file, JSON.stringify({ workbuddy: { uiAutomation: { enabled: true, executablePath: 'C:\\Apps\\Other.exe' } } }), 'utf8');
    const invalidSavedConfig = loadConfig({ path: file, env: {} });
    assert.equal(invalidSavedConfig.workbuddy.uiAutomation.enabled, false, 'invalid saved executable paths disable the opt-in');
    assert.equal(invalidSavedConfig.workbuddy.uiAutomation.executablePath, null);
    assert.equal(invalidSavedConfig.workbuddy.uiAutomation.configurationValid, false);
  } finally {
    try { fs.unlinkSync(file); } catch { /* fixture cleanup */ }
  }
});

test('WorkBuddy UIA redaction hides the executable and config directory', () => {
  const exePath = 'C:\\Program Files\\WorkBuddy\\WorkBuddy.exe';
  const configDir = 'C:\\Users\\Local\\.workbuddy';
  const config = {
    bridgeToken: null,
    codex: { pipePath: null, contextThreadId: null, nativeControl: { enabled: false } },
    workbuddy: { configDir, uiAutomation: { enabled: true, executablePath: exePath, configurationValid: true } },
  };
  const rendered = JSON.stringify(redactedConfig(config));
  assert.ok(!rendered.includes(exePath));
  assert.ok(!rendered.includes(configDir));
  assert.deepEqual(redactedConfig(config).workbuddy.uiAutomation, {
    enabled: true,
    executablePathConfigured: true,
    configurationValid: true,
  });
});

test('saving WorkBuddy UIA settings preserves configDir and other nested values', () => {
  const file = path.join(os.tmpdir(), `ai-remote-workbuddy-config-${require('node:crypto').randomUUID()}.json`);
  const exePath = 'C:\\Program Files\\WorkBuddy\\WorkBuddy.exe';
  try {
    fs.writeFileSync(file, JSON.stringify({
      workbuddy: { configDir: 'C:\\Users\\Local\\.workbuddy', unrelated: { keep: true } },
      ownerName: 'Local user',
    }), 'utf8');
    const saved = saveConfig(file, { workbuddy: { uiAutomation: { enabled: true, executablePath: exePath } } });
    assert.equal(saved.ownerName, 'Local user');
    assert.equal(saved.workbuddy.configDir, 'C:\\Users\\Local\\.workbuddy');
    assert.deepEqual(saved.workbuddy.unrelated, { keep: true });
    assert.deepEqual(saved.workbuddy.uiAutomation, { enabled: true, executablePath: exePath });
  } finally {
    try { fs.unlinkSync(file); } catch { /* fixture cleanup */ }
  }
});
