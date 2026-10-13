'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { BridgeError } = require('../src/errors');
const { parseArgs, projectSnapshot, inspectWorkBuddySnapshot, safeCliError } = require('../src/workbuddy-native/inspect');

const selector = { expectedExePath: 'D:\\tools\\WorkBuddy\\WorkBuddy.exe', expectedProcessId: 36728, expectedHandle: '2623190' };

function fixture() {
  return {
    outcome: 'confirmed',
    reason: null,
    inspection: {
      activation: { outcome: 'confirmed', reason: null },
      inputDesktopKind: 'default',
      windows: [
        {
          handle: '2623190', processId: 36728, mainWindow: true, executableName: 'WorkBuddy.exe',
          visible: true, enabled: true, minimized: false, isForeground: true, foregroundHandle: '2623190',
          rendererAccessibilityFlag: true, uiaProviderFlag: true,
          uiaCom: { status: { comActivated: true, elementFromHandleHresult: 0, rawWalkerHresult: 0,
            rootControlTypeId: 50033, uiaWindowRootRetrieved: true, providerDescriptionQueryHresult: 0,
            providerDescriptionClass: 'chromium-provider', providerClassHistogram: ['chromium-provider:500'],
            legacyIAccessiblePatternQueryHresult: -2147467262, legacyIAccessiblePatternAvailable: false,
            legacyIAccessiblePatternNodes: 0, traversedNodes: 500, traversalTruncated: false, elapsedMs: 50,
            typeHistogram: ['50033:9', '50032:12', '50024:1'] } },
          childWindows: [{ handle: '7001', parentHandle: '2623190', sourceWindowHandle: '2623190', processId: 36728,
            className: 'Intermediate D3D Window', visible: true, enabled: true }],
          controls: [
            { controlType: 'ControlType.Button', safeActionLabel: 'new-chat', accessibleName: '开始新的对话', enabled: true, selected: false, patterns: ['invoke'] },
            { controlType: 'ControlType.ComboBox', safeActionLabel: 'model-selector', accessibleName: 'Select model: Deepseek-V4.1-Flash', enabled: true, selected: false, rect: { x: 400, y: 500, width: 140, height: 40 }, patterns: ['expandCollapse', 'selection'] },
            { controlType: 'ControlType.Edit', safeActionLabel: 'composer', accessibleName: '今天帮你做些什么？', enabled: true, selected: false, draftState: 'empty', draftFingerprint: '', patterns: ['value', 'text'] },
            { controlType: 'ControlType.Button', safeActionLabel: 'send', accessibleName: '发送', enabled: false, selected: false, patterns: ['invoke'] },
            { controlType: 'ControlType.Document', safeActionLabel: '', accessibleName: 'SENSITIVE_TRANSCRIPT_SHOULD_NOT_APPEAR', enabled: true, selected: false, patterns: [] },
            { controlType: 'ControlType.Text', safeActionLabel: '', accessibleName: 'UNRELATED_ACCOUNT_TEXT_SHOULD_NOT_APPEAR', enabled: true, selected: false, patterns: [] },
          ],
        },
        {
          handle: '10360974', processId: 36728, mainWindow: false, executableName: 'WorkBuddy.exe',
          visible: false, enabled: true, minimized: false, isForeground: false, foregroundHandle: '2623190',
          rendererAccessibilityFlag: null, uiaProviderFlag: null, controls: [
            { controlType: 'ControlType.Text', safeActionLabel: 'new-chat', accessibleName: 'wrong-window', enabled: true, selected: false, patterns: [] },
          ],
        },
      ],
      helperProcessContext: { processId: 70000, windowsSessionId: 1, is64BitOperatingSystem: true, is64BitProcess: true,
        isWow64Process: false, integrityLevel: 'medium', integrityRid: 8192, queryHresult: 0, errorStage: '' },
      targetProcessContexts: [{ processId: 36728, windowsSessionId: 1, is64BitOperatingSystem: true, is64BitProcess: true,
        isWow64Process: false, integrityLevel: 'medium', integrityRid: 8192, queryHresult: 0, errorStage: '' }],
    },
  };
}

test('snapshot CLI parses exact selectors and rejects missing, duplicate, or non-numeric window identity', () => {
  assert.deepEqual(parseArgs(['--exe', selector.expectedExePath, '--pid', '36728', '--handle', '2623190']), { ...selector, readOnly: false });
  assert.equal(parseArgs(['--exe', selector.expectedExePath, '--pid', '36728', '--handle', '2623190', '--read-only']).readOnly, true);
  for (const args of [
    ['--exe', selector.expectedExePath, '--pid', '36728'],
    ['--exe', selector.expectedExePath, '--pid', 'abc', '--handle', '2623190'],
    ['--exe', selector.expectedExePath, '--pid', '36728', '--handle', '2623190', '--pid', '9'],
  ]) {
    assert.throws(() => parseArgs(args), (error) => error instanceof BridgeError && error.code === 'invalid_params');
  }
});

test('semantic snapshot keeps only the exact target and allowlisted controls without transcript/account text', () => {
  const result = projectSnapshot(fixture(), selector);
  assert.equal(result.activation, 'confirmed');
  assert.equal(result.window.handle, selector.expectedHandle);
  assert.equal(result.processContext.sameWindowsSession, true);
  assert.equal(result.processContext.sameBitness, true);
  assert.equal(result.window.uiaCom.uiaWindowRootRetrieved, true);
  assert.equal(result.window.uiaCom.providerDescriptionClass, 'chromium-provider');
  assert.equal(result.window.uiaCom.legacyIAccessiblePatternAvailable, false);
  assert.equal(result.window.childWindows[0].parentHandle, selector.expectedHandle);
  assert.deepEqual(result.actionCapabilities, { send: false, create: false, stop: false, answer: false, approve: false });
  assert.deepEqual(result.window.controls.map((control) => control.safeActionLabel), ['new-chat', 'model-selector', 'composer', 'send']);
  const json = JSON.stringify(result);
  assert.doesNotMatch(json, /SENSITIVE_TRANSCRIPT|UNRELATED_ACCOUNT|10360974|wrong-window/);
  assert.match(json, /Deepseek-V4\.1-Flash/);
  assert.match(json, /"draftState":"empty"/);
  assert.match(json, /"rect":\{"x":400,"y":500,"width":140,"height":40\}/);
  assert.doesNotMatch(json, /"text"\s*:/i);
});

test('snapshot inspector calls one combined activation and inspection against the supplied native identity', async () => {
  let received;
  const value = fixture();
  const inspector = { activateAndInspectMainWindow: async (options) => { received = options; return value; } };
  const result = await inspectWorkBuddySnapshot(selector, inspector);
  assert.deepEqual(received, selector);
  assert.equal(result.window.handle, selector.expectedHandle);
  assert.equal(result.activation, 'confirmed');
});

test('snapshot fails closed when the requested native window is absent or duplicated', () => {
  const absent = fixture();
  absent.inspection.windows = absent.inspection.windows.slice(1);
  assert.equal(projectSnapshot(absent, selector).window, null);

  const ambiguous = fixture();
  ambiguous.inspection.windows.push({ ...ambiguous.inspection.windows[0] });
  assert.throws(() => projectSnapshot(ambiguous, selector), (error) => error instanceof BridgeError && error.code === 'bridge_error');
});

test('CLI exposes only fixed bridge diagnostics, never raw UI Automation exceptions', () => {
  const safe = new BridgeError('bridge_error', 'WorkBuddy UIA operation timed out');
  const privateError = new Error('unexpected control data from another window');
  assert.equal(safeCliError(safe), 'WorkBuddy UIA operation timed out');
  assert.equal(safeCliError(privateError), 'WorkBuddy semantic snapshot could not be verified');
});
