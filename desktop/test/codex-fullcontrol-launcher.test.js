'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const launcher = fs.readFileSync(path.join(ROOT, 'scripts', 'Start-FullControl.ps1'), 'utf8');
const packer = fs.readFileSync(path.join(ROOT, 'scripts', 'pack.mjs'), 'utf8');
const workBuddyReadme = fs.readFileSync(path.join(ROOT, 'plugins', 'workbuddy-native', 'README.md'), 'utf8');

test('FullControl launch requires the exact packaged OpenAI.Codex identity and App manifest entry', () => {
  assert.match(launcher, /WindowsApps/);
  assert.ok(launcher.includes('OpenAI\\.Codex_'));
  assert.match(launcher, /GetAttribute\('Name'\) -cne 'OpenAI\.Codex'/);
  assert.match(launcher, /GetAttribute\('Id'\) -ceq 'App'/);
  assert.match(launcher, /GetAttribute\('EntryPoint'\) -ceq 'Windows\.FullTrustApplication'/);
  assert.match(launcher, /app\\ChatGPT\.exe/);
  assert.match(launcher, /Get-CodexPackageRoot/);
  assert.match(launcher, /Get-AuthenticodeSignature/);
  assert.match(launcher, /OpenAI OpCo, LLC/);
  assert.doesNotMatch(launcher, /Start-Process\s+-FilePath\s+['"](?:ChatGPT|Codex)\.exe['"]/i);
});

test('the opt-in starts Codex with per-run proxy settings, waits for both native and app-tools, then starts the hidden bridge', () => {
  const startDesktop = launcher.indexOf('$DesktopProcess = Start-Process -FilePath $desktopPath');
  const readiness = launcher.indexOf('Wait-ForCodexNativeReady $nodePath $readinessScript $StartupTimeoutSeconds');
  const startBridge = launcher.indexOf('$BridgeProcess = Start-Process -FilePath $nodePath');
  assert.ok(startDesktop >= 0 && readiness > startDesktop && startBridge > readiness);
  assert.match(launcher, /AI_REMOTE_CODEX_NATIVE_CONTROL = '1'/);
  assert.match(launcher, /CODEX_NATIVE_CONTROL_DIR = \$RegistryDir/);
  assert.match(launcher, /CODEX_NATIVE_RUN_ID = \$runId/);
  assert.match(launcher, /CODEX_NATIVE_NODE_PATH = \$nodePath/);
  assert.match(launcher, /CODEX_NATIVE_REAL_CLI_PATH = \$cliPath/);
  assert.match(launcher, /-WindowStyle Hidden/);
  assert.match(launcher, /finally\s*\{[\s\S]*?SetEnvironmentVariable\(\$name, \$OriginalEnvironment\[\$name\], 'Process'\)/);
});

test('Codex exit requests shutdown only for the launched bridge and waits before registry cleanup', () => {
  const startDesktop = launcher.indexOf('$DesktopProcess = Start-Process -FilePath $desktopPath');
  const assignStopToken = launcher.indexOf('$env:AI_REMOTE_BRIDGE_STOP_TOKEN = $stopToken');
  const startBridge = launcher.indexOf('$BridgeProcess = Start-Process -FilePath $nodePath');
  const detectDesktopExit = launcher.indexOf('if ($DesktopProcess.HasExited -and -not $BridgeProcess.HasExited');
  const requestStop = launcher.indexOf('Stop-OwnBridge $BridgeProcess $RegistryDir $runId $stopToken', detectDesktopExit);
  assert.ok(assignStopToken > startDesktop && startBridge > assignStopToken, 'the stop credential is not inherited by Codex Desktop');
  assert.ok(detectDesktopExit >= 0 && requestStop > detectDesktopExit);
  assert.match(launcher, /AI_REMOTE_BRIDGE_STOP_TOKEN/);
  assert.match(launcher, /bridge-stop-\$RunId\.request/);
  assert.match(launcher, /WaitForExit\(120000\)/, 'graceful shutdown gives accepted UI actions time to drain and remains bounded');
  assert.match(launcher, /in-flight native operation outcome is unknown/);
  assert.match(launcher, /if \(-not \$bridgeStop\.Graceful\).*in-flight native operation outcome is unknown/s);
  assert.match(launcher, /New-BridgeStopOutcome/);
  assert.match(launcher, /Graceful = \[bool\]\$graceful/);
  assert.match(launcher, /if \(\$BridgeProcess\.ExitCode -ne 0\).*did not shut down cleanly/s);
  assert.match(launcher, /Stop-Process -InputObject \$Process/, 'timeout fallback targets the exact launched process object');
  assert.doesNotMatch(launcher, /Stop-Process[^\r\n]*\$DesktopProcess/);
  assert.match(launcher, /if \(-not \$bridgeStopped -or -not \$desktopStopped\)/);
});

test('per-run proxy/native child descriptors are drained before cleanup and retained on timeout or inspection failure', () => {
  const boundedDrain = launcher.indexOf("Wait-ForCodexNativeChildren $RegistryDir $runId 120");
  const normalCleanupMessage = launcher.indexOf('All per-run Codex proxy/native child descriptors have exited');
  const finallyCleanupGuard = launcher.indexOf('if (-not $nativeProxyExitVerified)');
  const removal = launcher.indexOf('Remove-Item -LiteralPath $registryFull -Recurse -Force');
  assert.ok(boundedDrain >= 0 && normalCleanupMessage > boundedDrain);
  assert.ok(finallyCleanupGuard >= 0 && removal > finallyCleanupGuard);
  assert.match(launcher, /if \(-not \$nativeProxyExitCheckCompleted\)[\s\S]*?Wait-ForCodexNativeChildren \$RegistryDir \$runId 120/);
  assert.match(launcher, /descriptor remains after the bounded wait[\s\S]*?private registry will be retained/);
  assert.match(launcher, /descriptor state could not be verified\. The private registry was retained/);
  assert.match(launcher, /Wait-ForCodexNativeChildren\(\[string\] \$Directory, \[string\] \$RunId, \[int\] \$Seconds\)/);
  assert.match(launcher, /codex-native-\$RunId-\*\.json/);
  assert.match(launcher, /Test-NoReparsePoint \$descriptor\.FullName/);
});

test('nonzero exit and forced timeout are not reported as graceful shutdown', { skip: process.platform !== 'win32' }, () => {
  const fixture = path.join(__dirname, 'codex-fullcontrol-stop-fixtures.ps1');
  const result = execFileSync('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', fixture, path.join(ROOT, 'scripts', 'Start-FullControl.ps1'),
  ], { cwd: ROOT, encoding: 'utf8', timeout: 15000, windowsHide: true });
  assert.match(result, /PowerShell bridge stop and native-child drain fixtures: passed/);
});

test('bridge preflight and readiness use the effective config port instead of a hardcoded default', () => {
  assert.match(launcher, /function Resolve-BridgeUiPort\(\)/);
  assert.match(launcher, /AI_REMOTE_UI_PORT/);
  assert.match(launcher, /AI_REMOTE_CONFIG/);
  assert.match(launcher, /\.dsh\\ai-remote-desktop\.json/);
  assert.match(launcher, /Join-Path \$PackageRoot \$configPath/);
  assert.match(launcher, /\$BridgePort = Resolve-BridgeUiPort/);
  assert.match(launcher, /function Test-LocalBridgePort\(\[int\] \$Port/);
  assert.match(launcher, /BeginConnect\('127\.0\.0\.1', \$Port/);
  assert.match(launcher, /Test-LocalBridgePort -Port \$BridgePort/);
  assert.match(launcher, /Wait-ForLocalBridge \$BridgeProcess \$StartupTimeoutSeconds \$BridgePort/);
  assert.doesNotMatch(launcher, /BeginConnect\('127\.0\.0\.1', 18989/);
});

test('private registry ACL is protected and cleanup is limited to this UUID run directory after both processes exit', () => {
  assert.match(launcher, /SetAccessRuleProtection\(\$true, \$false\)/);
  assert.match(launcher, /S-1-5-18/);
  assert.match(launcher, /S-1-5-32-544/);
  assert.match(launcher, /AreAccessRulesProtected/);
  assert.match(launcher, /-not \$bridgeStopped -or -not \$desktopStopped/);
  assert.match(launcher, /GetDirectoryName\(\$registryFull\) -ieq \[IO\.Path\]::GetFullPath\(\$RegistryParent\)/);
  assert.match(launcher, /Remove-Item -LiteralPath \$registryFull -Recurse -Force/);
  assert.doesNotMatch(launcher, /Stop-Process\s+-Id\s+\$DesktopProcess\.Id/);
});

test('Windows package allowlist includes the native launchers and excludes diagnostic/private sources', () => {
  for (const entry of ['FULL_CONTROL_LAUNCHER_NAME', 'FULL_CONTROL_SCRIPT_NAME', 'codex-native/codex-native-proxy.exe', 'scripts/codex-fullcontrol-ready.js']) {
    assert.ok(packer.includes(entry));
  }
  const runtimeList = packer.match(/const SOURCE_RUNTIME_FILES = Object\.freeze\(\[([\s\S]*?)\]\);/);
  assert.ok(runtimeList);
  const runtimeNames = [...runtimeList[1].matchAll(/'([^']+)'/g)].map(match => match[1]);
  for (const name of ['src/workbuddy-native/pending-service.js', 'src/workbuddy-native/pending-items.js', 'src/workbuddy-native/writer.js', 'src/workbuddy-native/windows-uia.js']) {
    assert.ok(runtimeNames.includes(name));
    assert.ok(fs.statSync(path.join(ROOT, name)).isFile());
  }
  for (const name of ['windows-uia.ps1', 'windows-uia-com.cs', 'windows-uia-pending.cs', 'pending-actions.cs', 'model-popup.cs', 'native-input.cs']) {
    const entry = `src/workbuddy-native/${name}`;
    assert.ok(packer.includes(`name: '${entry}'`));
    assert.ok(fs.statSync(path.join(ROOT, entry)).isFile());
  }
  assert.doesNotMatch(runtimeNames.join('\n'), /(?:^|\/)(?:test|tests|private|\.private|\.native-src|\.native-asar|native-asar)(?:\/|$)|\.asar(?:$|\/)/i);
  assert.ok(!runtimeNames.includes('src/workbuddy-native/inspect.js'));
  assert.match(packer, /FORBIDDEN_PACKAGE_ENTRY/);
  assert.match(packer, /collectRuntimeFiles\(\)/);
});

test('WorkBuddy package documentation separates verified native writes from the remaining acceptance limits', () => {
  assert.match(packer, /WorkBuddy 5\.7\.7 已通过原生新建、续聊、下条消息选模型、单题与两题回答、停止任务的公网验收/);
  assert.match(packer, /真实审批点击尚未实测/);
  assert.match(packer, /未经支持的 projectId\/cwd 会在写入消息前被拒绝/);
  assert.match(workBuddyReadme, /19 actual native options/);
  assert.match(workBuddyReadme, /did not verify real approval clicks/);
  assert.match(workBuddyReadme, /does not expose a verified workspace picker/);
  assert.match(workBuddyReadme, /source-only developer inspector/i);
  assert.match(workBuddyReadme, /intentionally excluded from the Windows package/);
  assert.match(workBuddyReadme, /Start-WorkBuddy-UIA\.cmd/);
  assert.match(workBuddyReadme, /Start-WorkBuddy-Standard\.cmd/);
  assert.doesNotMatch(workBuddyReadme, /operations remain disabled|complete model catalog has not been read/i);
});
