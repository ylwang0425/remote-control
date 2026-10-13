'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const PACKAGE_DIR = path.join(__dirname, '..', 'plugins', 'workbuddy-native');

test('UIA launcher is opt-in, process-scoped, and refuses a running target without terminating it', () => {
  const launcher = fs.readFileSync(path.join(PACKAGE_DIR, 'Start-WorkBuddy.ps1'), 'utf8');
  assert.match(launcher, /ValidateSet\('uia', 'standard'\)/);
  assert.match(launcher, /--force-renderer-accessibility=complete/);
  assert.match(launcher, /--enable-features=UiaProvider/);
  assert.match(launcher, /A WorkBuddy process for this install is already running/);
  assert.match(launcher, /Start-Process -FilePath \$resolvedPath -PassThru/);
  assert.doesNotMatch(launcher, /Stop-Process|taskkill|TerminateProcess|DebugActiveProcess|remote-debugging-port/i);
  assert.doesNotMatch(launcher, /Add-MpPreference|Set-ExecutionPolicy|Set-ItemProperty/);
});

test('rollback starts the selected install without Chromium UIA flags', () => {
  const launcher = fs.readFileSync(path.join(PACKAGE_DIR, 'Start-WorkBuddy.ps1'), 'utf8');
  const standard = launcher.split("} else {")[1];
  assert.ok(standard);
  assert.match(standard, /Start-Process -FilePath \$resolvedPath -PassThru/);
  assert.doesNotMatch(standard, /--force-renderer-accessibility|--enable-features=UiaProvider/);
  const wrapper = fs.readFileSync(path.join(PACKAGE_DIR, 'Start-WorkBuddy-Standard.cmd'), 'utf8');
  assert.match(wrapper, /-Mode standard/);
});

test('launcher resolves an explicit or unambiguous executable and refuses guessed multiple installs', () => {
  const launcher = fs.readFileSync(path.join(PACKAGE_DIR, 'Start-WorkBuddy.ps1'), 'utf8');
  assert.match(launcher, /WORKBUDDY_EXE_PATH/);
  assert.match(launcher, /-ExecutablePath/);
  assert.match(launcher, /Multiple WorkBuddy installations were found/);
  assert.match(launcher, /Get-CimInstance -ClassName Win32_Process/);
  assert.match(launcher, /\.ExecutablePath/);
  assert.match(launcher, /OrdinalIgnoreCase/);
  assert.match(fs.readFileSync(path.join(PACKAGE_DIR, 'Start-WorkBuddy-UIA.cmd'), 'utf8'), /-Mode uia/);
});

test('read-only snapshot CLI requires an exact executable, PID, and HWND', () => {
  const cli = fs.readFileSync(path.join(__dirname, '..', 'src', 'workbuddy-native', 'inspect.js'), 'utf8');
  assert.match(cli, /--exe/);
  assert.match(cli, /--pid/);
  assert.match(cli, /--handle/);
  assert.match(cli, /activateAndInspectMainWindow/);
  assert.doesNotMatch(cli, /process\.kill|Stop-Process|child_process.*exec|SendKeys|WriteValuePattern/i);
});
