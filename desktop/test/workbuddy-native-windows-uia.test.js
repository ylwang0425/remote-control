'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { BridgeError } = require('../src/errors');
const {
  PROTOCOL,
  HELPER_PATH,
  validateSelector,
  validateInspection,
  validateSemanticSnapshot,
  validateSemanticAction,
  validateNewTaskPageProof,
  validateConversationIdentitySnapshot,
  validateNativeConversationNavigation,
  validateNativeModelCatalog,
  validateMainWindowDiscovery,
  validateUiaComStatus,
  validateDotNetUiaStatus,
  createWindowsUiaInspector,
} = require('../src/workbuddy-native/windows-uia');

function sampleInspection() {
  const msaaStatus = {
    objectId: 4294967292, accessible: true, childCount: 1, rootRole: 16, hresult: 0, ia2Hresult: -2147467262,
    ia2Stage: 'query-interface', ia2Accessible: false, stage: 'complete',
    rootType: 'System.__ComObject', traversalNodes: 1, traversalTruncated: false, elapsedMs: 10, childError: '',
    trace: [{ depth: 0, childId: 0, role: 16, childCount: 1, objectType: 'System.__ComObject' }],
  };
  return {
    protocol: PROTOCOL,
    operation: 'inspect',
    readOnly: true,
    inputDesktopKind: 'default',
    inputDesktopAccessible: true,
    helperProcessContext: { processId: 900, windowsSessionId: 1, is64BitOperatingSystem: true, is64BitProcess: true,
      isWow64Process: false, integrityLevel: 'medium', integrityRid: 8192, queryHresult: 0, errorStage: '' },
    targetProcessContexts: [{ processId: 36728, windowsSessionId: 1, is64BitOperatingSystem: true, is64BitProcess: true,
      isWow64Process: false, integrityLevel: 'medium', integrityRid: 8192, queryHresult: 0, errorStage: '' }],
    actionCapabilities: { send: false, create: false, stop: false, answer: false, approve: false },
    windows: [{
      handle: '2623190', ownerHandle: null, processId: 36728, processName: 'WorkBuddy',
      executableName: 'WorkBuddy.exe', visible: true, enabled: true, minimized: false,
      isForeground: true, foregroundHandle: '2623190', windowsSessionId: 1, mainWindow: true,
      rendererAccessibilityFlag: false, uiaProviderFlag: false,
      titleCategory: 'workbuddy', titleMatchesApp: true, windowClass: 'Chrome_WidgetWin_1',
      rect: { x: 0, y: 0, width: 1200, height: 800 }, uiaError: null,
      childWindows: [{ handle: '1001', processId: 36728, visible: true, enabled: true, className: 'Intermediate D3D Window', parentHandle: '2623190', sourceWindowHandle: '2623190', rect: { x: 1, y: 1, width: 10, height: 10 } }],
      childWindowsTruncated: false,
      rendererMsaaProbes: [{ handle: '1002', sourceWindowHandle: '2623190', parentHandle: '1001', processId: 36728, className: 'Chrome_RenderWidgetHostHWND', client: msaaStatus, assistiveObject: null, controls: [] }],
      rendererUiaProbes: [{
        handle: '1002', sourceWindowHandle: '2623190', parentHandle: '1001', processId: 36728, className: 'Chrome_RenderWidgetHostHWND',
        visible: false, enabled: true, probed: false, skipReason: 'renderer-not-visible-enabled', dotNet: null, com: null,
      }],
      msaa: { client: msaaStatus, assistive: null },
      uiaCom: {
        status: { comActivated: true, activationHresult: 0, elementFromHandleHresult: 0, rawWalkerHresult: 0,
          rootControlTypeId: 50033, uiaWindowRootRetrieved: true, providerDescriptionQueryHresult: 0,
          providerDescriptionClass: 'windows-uia-proxy', providerClassQueryCount: 28,
          providerClassHistogram: ['windows-uia-proxy:28'], legacyIAccessiblePatternQueryHresult: -2147467262,
          legacyIAccessiblePatternAvailable: false, legacyIAccessiblePatternNodes: 0,
          traversedNodes: 28, traversalTruncated: false, elapsedMs: 1119,
          typeHistogram: ['50033:9', '50032:19'], errorType: null, errorStage: '' },
        controls: [],
      },
      uiaStructureSubscription: { attempted: true, registered: true, removed: true, scope: 'subtree', hresult: 0, errorType: null },
      controls: [{ depth: 2, index: 0, controlType: 'ControlType.ListItem', automationId: '',
        className: '', enabled: true, offscreen: false, selected: true, focusable: true,
        rect: { x: 10, y: 10, width: 200, height: 30 }, selectedItemLabel: 'Current task',
        safeActionLabel: '', accessibleName: 'Current task', runtimeIdHash: '0123456789abcdef',
        draftState: 'unavailable', draftFingerprint: '', patterns: ['selectionItem'] }],
    }],
  };
}

function sampleNewTaskPageProof(overrides = {}) {
  const pathHashes = ['1000000000000001', '1000000000000002', '1000000000000003', '1000000000000004', '1000000000000005'];
  const runtimeHashes = ['2000000000000001', '2000000000000002', '2000000000000003', '2000000000000004', '2000000000000005'];
  const composerAncestors = [
    { depth: 1, controlTypeId: 50030, accessibleName: '', automationId: 'RootWebArea', className: '', ariaRole: 'document',
      pathHash: pathHashes[0], runtimeIdHash: runtimeHashes[0], regionHash: '1122334455667788' },
    { depth: 2, controlTypeId: 50033, accessibleName: '', automationId: '', className: 'wb-home-page', ariaRole: 'pane',
      pathHash: pathHashes[1], runtimeIdHash: runtimeHashes[1], regionHash: '' },
    { depth: 3, controlTypeId: 50033, accessibleName: '', automationId: '', className: 'wb-home-composer cb-font-size-capped', ariaRole: 'pane',
      pathHash: pathHashes[2], runtimeIdHash: runtimeHashes[2], regionHash: '' },
    { depth: 4, controlTypeId: 50033, accessibleName: '', automationId: '', className: 'wb-home-route__input-wrap', ariaRole: 'pane',
      pathHash: pathHashes[3], runtimeIdHash: runtimeHashes[3], regionHash: '' },
    { depth: 5, controlTypeId: 50004, accessibleName: '', automationId: '', className: '_editable_1198_1', ariaRole: 'textbox',
      pathHash: pathHashes[4], runtimeIdHash: runtimeHashes[4], regionHash: '' },
  ];
  return {
    snapshotComplete: true, verified: true, selectedNewTaskTabCount: 1, selectedConversationTabMatches: 0,
    conversationHeaderMatches: 0, visibleWelcomeMarkerMatches: 0, composerDocumentWelcomeMarkerMatches: 0,
    homePageAncestorMatches: 1, homeComposerAncestorMatches: 1, homeRouteInputAncestorMatches: 1,
    composerDocumentRegionHash: '1122334455667788', composerDocumentTextSampleCount: 0,
    composerDocumentTextSamples: [], composerAncestorCount: composerAncestors.length, composerAncestors,
    ...overrides,
  };
}

test('UIA helper selector is bounded and requires the actual WorkBuddy executable path', () => {
  assert.deepEqual(validateSelector({ expectedExePath: 'D:\\tools\\WorkBuddy\\WorkBuddy.exe', maxControls: 16 }),
    { expectedExePath: 'D:\\tools\\WorkBuddy\\WorkBuddy.exe', maxControls: 16 });
  for (const expectedExePath of ['relative\\WorkBuddy.exe', 'C:\\app\\Other.exe', '..\\WorkBuddy.exe']) {
    assert.throws(() => validateSelector({ expectedExePath }), (error) => error instanceof BridgeError && error.code === 'invalid_params');
  }
  assert.throws(() => validateSelector({ maxControls: 257 }), (error) => error.code === 'invalid_params');
  assert.deepEqual(validateSelector({ expectedExePath: 'D:\\tools\\WorkBuddy\\WorkBuddy.exe', expectedProcessId: 36728, expectedHandle: '2623190' }),
    { expectedExePath: 'D:\\tools\\WorkBuddy\\WorkBuddy.exe', maxControls: 160, expectedProcessId: 36728, expectedHandle: '2623190' });
  assert.throws(() => validateSelector({ expectedProcessId: 36728 }), (error) => error.code === 'invalid_params');
});

test('UIA inspection accepts metadata only and never advertises control capabilities', () => {
  const inspection = sampleInspection();
  assert.equal(validateInspection(inspection), inspection);
  const forgedCapability = sampleInspection();
  forgedCapability.actionCapabilities.approve = true;
  assert.throws(() => validateInspection(forgedCapability), (error) => error.code === 'bridge_error');
  const malformedHandle = sampleInspection();
  malformedHandle.windows[0].handle = 2623190;
  assert.throws(() => validateInspection(malformedHandle), (error) => error.code === 'bridge_error');
  const malformedChildren = sampleInspection();
  malformedChildren.windows[0].rendererMsaaProbes[0].controls = Array(257).fill(malformedChildren.windows[0].controls[0]);
  assert.throws(() => validateInspection(malformedChildren), (error) => error.code === 'bridge_error');
  const malformedMsaaTrace = sampleInspection();
  malformedMsaaTrace.windows[0].msaa.client.trace = Array(33).fill(malformedMsaaTrace.windows[0].msaa.client.trace[0]);
  assert.throws(() => validateInspection(malformedMsaaTrace), (error) => error.code === 'bridge_error');
  const malformedComCount = sampleInspection();
  malformedComCount.windows[0].uiaCom.status.traversedNodes = 5001;
  assert.throws(() => validateInspection(malformedComCount), (error) => error.code === 'bridge_error');
  const malformedHistogram = sampleInspection();
  malformedHistogram.windows[0].uiaCom.status.typeHistogram = ['button:secret'];
  assert.throws(() => validateInspection(malformedHistogram), (error) => error.code === 'bridge_error');
  const malformedRect = sampleInspection();
  malformedRect.windows[0].controls[0].rect.width = -1;
  assert.throws(() => validateInspection(malformedRect), (error) => error.code === 'bridge_error');
  const hiddenRendererRead = sampleInspection();
  hiddenRendererRead.windows[0].rendererUiaProbes[0].probed = true;
  hiddenRendererRead.windows[0].rendererUiaProbes[0].dotNet = { rootRetrieved: true, hresult: 0, rootControlTypeId: 50033,
    traversedNodes: 1, traversalTruncated: false, elapsedMs: 10, typeHistogram: ['50033:1'], errorType: null };
  hiddenRendererRead.windows[0].rendererUiaProbes[0].com = hiddenRendererRead.windows[0].uiaCom.status;
  assert.throws(() => validateInspection(hiddenRendererRead), (error) => error.code === 'bridge_error');
});

test('standard COM UIA status requires bounded HRESULT, traversal, and type-only diagnostics', () => {
  const status = sampleInspection().windows[0].uiaCom.status;
  assert.equal(validateUiaComStatus(status), true);
  assert.equal(validateUiaComStatus({ ...status, typeHistogram: ['50000:999999'] }), false);
  assert.equal(validateUiaComStatus({ ...status, errorStage: 'C:\\private\\text' }), false);
  assert.equal(validateUiaComStatus({ ...status, providerDescriptionClass: 'D:\\private\\provider.dll' }), false);
  assert.equal(validateUiaComStatus({ ...status, providerClassHistogram: ['raw provider text'] }), false);
});

test('semantic snapshots require an exact same-process target and validated UIA metadata', () => {
  const inspection = sampleInspection();
  const snapshot = {
    protocol: PROTOCOL,
    operation: 'semantic-snapshot',
    readOnly: true,
    activation: null,
    inputDesktopKind: 'default',
    target: { processId: 36728, handle: '2623190', windowsSessionId: 1, visible: true, enabled: true,
      minimized: false, isForeground: true, foregroundHandle: '2623190', mainWindow: true },
    processContext: { helper: inspection.helperProcessContext, target: inspection.targetProcessContexts[0],
      sameWindowsSession: true, sameBitness: true, sameIntegrityLevel: true },
    uiaCom: inspection.windows[0].uiaCom.status,
    newTaskPageProof: sampleNewTaskPageProof(),
    controls: [{ controlType: 'ControlType.ComboBox', safeActionLabel: 'model-selector', selectedItemLabel: '',
      accessibleName: 'Select model: Kimi-K3', enabled: true, selected: false, offscreen: false, focusable: true,
      runtimeIdHash: '0123456789abcdef', structuralPathHash: 'fedcba9876543210', regionHash: '0123456789abcdef',
      passwordProtected: false, rect: { x: 10, y: 20, width: 140, height: 40 }, draftState: 'unavailable',
      draftFingerprint: '', patterns: ['value', 'expandCollapse'] }],
  };
  assert.equal(validateSemanticSnapshot(snapshot, { expectedProcessId: 36728, expectedHandle: '2623190' }), snapshot);
  assert.throws(() => validateSemanticSnapshot({ ...snapshot, newTaskPageProof: { ...snapshot.newTaskPageProof,
    verified: true, conversationHeaderMatches: 1 } }, { expectedProcessId: 36728, expectedHandle: '2623190' }),
  (error) => error.code === 'bridge_error');
  assert.throws(() => validateSemanticSnapshot({ ...snapshot, target: { ...snapshot.target, handle: '10360974' } },
    { expectedProcessId: 36728, expectedHandle: '2623190' }), (error) => error.code === 'bridge_error');
  assert.throws(() => validateSemanticSnapshot({ ...snapshot, activation: { outcome: 'confirmed', reason: null },
    target: { ...snapshot.target, isForeground: false } }, { expectedProcessId: 36728, expectedHandle: '2623190' }),
  (error) => error.code === 'bridge_error');
});

test('semantic snapshot passes only bounded known titles and requires the matching private blank-page proof', async () => {
  const inspection = sampleInspection();
  const response = {
    protocol: PROTOCOL, operation: 'semantic-snapshot', readOnly: true, activation: null, inputDesktopKind: 'default',
    target: { processId: 36728, handle: '2623190', windowsSessionId: 1, visible: true, enabled: true,
      minimized: false, isForeground: false, foregroundHandle: '1000', mainWindow: true },
    processContext: { helper: inspection.helperProcessContext, target: inspection.targetProcessContexts[0],
      sameWindowsSession: true, sameBitness: true, sameIntegrityLevel: true },
    uiaCom: inspection.windows[0].uiaCom.status, controls: [],
    newTaskPageProof: sampleNewTaskPageProof({ verified: false, selectedConversationTabMatches: 1 }),
  };
  let request;
  const client = createWindowsUiaInspector({ platform: 'win32', helperPath: HELPER_PATH,
    execFileImpl: async (_bin, args) => {
      request = JSON.parse(args.at(-1));
      return { stdout: JSON.stringify(response) };
    } });
  const titles = ['Native work chat'];
  const result = await client.semanticSnapshot({ expectedExePath: 'D:\\tools\\WorkBuddy\\WorkBuddy.exe',
    expectedProcessId: 36728, expectedHandle: '2623190', knownConversationTitles: titles });
  assert.deepEqual(request.knownConversationTitles, titles);
  assert.equal(result.newTaskPageProof.verified, false);
  await assert.rejects(client.semanticSnapshot({ expectedExePath: 'D:\\tools\\WorkBuddy\\WorkBuddy.exe',
    expectedProcessId: 36728, expectedHandle: '2623190', knownConversationTitles: ['Bearer abc'] }),
  (error) => error.code === 'invalid_params');
});

test('activate-semantic forwards bounded conversation titles and returns the proof from the same restored snapshot', async () => {
  const inspection = sampleInspection();
  const response = {
    protocol: PROTOCOL, operation: 'semantic-snapshot', readOnly: false,
    activation: { outcome: 'submitted', reason: 'foreground-not-confirmed' }, inputDesktopKind: 'default',
    target: { processId: 36728, handle: '2623190', windowsSessionId: 1, visible: true, enabled: true,
      minimized: false, isForeground: false, foregroundHandle: '1000', mainWindow: true },
    processContext: { helper: inspection.helperProcessContext, target: inspection.targetProcessContexts[0],
      sameWindowsSession: true, sameBitness: true, sameIntegrityLevel: true },
    uiaCom: inspection.windows[0].uiaCom.status, controls: [],
    newTaskPageProof: sampleNewTaskPageProof(),
  };
  let request;
  const client = createWindowsUiaInspector({ platform: 'win32', helperPath: HELPER_PATH,
    execFileImpl: async (_bin, args) => {
      request = JSON.parse(args.at(-1));
      return { stdout: JSON.stringify(response) };
    } });
  const titles = ['Native work chat'];
  const result = await client.activateSemanticSnapshot({ expectedExePath: 'D:\\tools\\WorkBuddy\\WorkBuddy.exe',
    expectedProcessId: 36728, expectedHandle: '2623190', knownConversationTitles: titles });
  assert.equal(request.operation, 'activate-semantic');
  assert.deepEqual(request.knownConversationTitles, titles);
  assert.equal(result.target.minimized, false);
  assert.equal(result.target.isForeground, false);
  assert.equal(result.newTaskPageProof.verified, true);
});

test('semantic action receipts require exact target context while preserving truthful foreground observation', () => {
  const inspection = sampleInspection();
  const value = {
    protocol: PROTOCOL, operation: 'semantic-action', readOnly: false, inputDesktopKind: 'default',
    target: { processId: 36728, handle: '2623190', windowsSessionId: 1, visible: true, enabled: true,
      minimized: false, isForeground: true, foregroundHandle: '2623190', mainWindow: true },
    processContext: { helper: inspection.helperProcessContext, target: inspection.targetProcessContexts[0],
      sameWindowsSession: true, sameBitness: true, sameIntegrityLevel: true },
    uiaCom: inspection.windows[0].uiaCom.status,
    targetContextVerified: true,
    actionResult: { attempted: true, submitted: true, conversationIdentityVerified: true, newTaskIntentVerified: false, targetContextVerified: true, foregroundVerified: false,
      hresult: 0, stage: 'submitted', matchingControls: 1 },
    controls: [],
  };
  const selector = { expectedProcessId: 36728, expectedHandle: '2623190' };
  assert.equal(validateSemanticAction(value, selector), value);
  const background = { ...value, target: { ...value.target, isForeground: false, foregroundHandle: '1000' } };
  assert.equal(validateSemanticAction(background, selector), background);
  assert.throws(() => validateSemanticAction({ ...value, targetContextVerified: false }, selector),
    (error) => error.code === 'bridge_error');
  assert.throws(() => validateSemanticAction({ ...value, actionResult: { ...value.actionResult, matchingControls: 0 } }, selector),
    (error) => error.code === 'bridge_error');
});

test('native window discovery returns only exact-main-window metadata and rejects duplicate-shaped fields', async () => {
  const windows = [{ processId: 36728, handle: '2623190', visible: true, enabled: true, minimized: false,
    isForeground: true, foregroundHandle: '2623190', mainWindow: true }];
  const value = { protocol: PROTOCOL, operation: 'discover-main-windows', readOnly: true,
    inputDesktopKind: 'default', windows };
  assert.equal(validateMainWindowDiscovery(value), value);
  assert.throws(() => validateMainWindowDiscovery({ ...value, windows: [{ ...windows[0], mainWindow: false }] }),
    (error) => error.code === 'bridge_error');
  let invocation;
  const client = createWindowsUiaInspector({ platform: 'win32', execFileImpl: async (_bin, args) => {
    invocation = JSON.parse(args.at(-1));
    return { stdout: JSON.stringify(value) };
  } });
  assert.deepEqual(await client.discoverMainWindows({ expectedExePath: 'D:\\tools\\WorkBuddy\\WorkBuddy.exe' }), value);
  assert.deepEqual(invocation, { protocol: PROTOCOL, operation: 'discover-main-windows',
    expectedExePath: 'D:\\tools\\WorkBuddy\\WorkBuddy.exe', maxControls: 1 });
});

test('native identity validation supports duplicate labels only when one bounded history candidate matches', () => {
  const value = {
    protocol: PROTOCOL, operation: 'semantic-identity', readOnly: false, inputDesktopKind: 'default',
    targetContextVerified: true,
    activation: { outcome: 'confirmed', reason: null },
    target: { processId: 36728, handle: '2623190', mainWindow: true, visible: true, enabled: true,
      minimized: false, isForeground: true, foregroundHandle: '2623190' },
    processContext: { sameWindowsSession: true, sameBitness: true, sameIntegrityLevel: true },
    identityProof: { conversationRowMatches: 2, conversationHeaderMatches: 1, candidateCount: 2, matchedCandidateIndex: 1 },
  };
  const selector = { expectedProcessId: 36728, expectedHandle: '2623190' };
  assert.equal(validateConversationIdentitySnapshot(value, selector, 2), value);
  assert.throws(() => validateConversationIdentitySnapshot({ ...value, identityProof: { ...value.identityProof, matchedCandidateIndex: -1 } }, selector, 2),
    (error) => error.code === 'not_capable');
  assert.throws(() => validateConversationIdentitySnapshot({ ...value, identityProof: { ...value.identityProof, conversationHeaderMatches: 2 } }, selector, 2),
    (error) => error.code === 'not_capable');
});

test('native model catalog is one bounded helper request with confirmed draft-preserving expand and collapse receipts', async () => {
  const inspection = sampleInspection();
  const response = {
    protocol: PROTOCOL, operation: 'native-model-catalog', readOnly: false, outcome: 'confirmed', reason: null,
    targetContextVerified: true,
    inputDesktopKind: 'default',
    target: { processId: 36728, handle: '2623190', mainWindow: true, visible: true, enabled: true,
      minimized: false, isForeground: false, foregroundHandle: '1000' },
    processContext: { helper: inspection.helperProcessContext, target: inspection.targetProcessContexts[0],
      sameWindowsSession: true, sameBitness: true, sameIntegrityLevel: true },
    catalog: { currentModel: 'Kimi-K3', models: ['Kimi-K3', 'Deepseek-V4.1-Flash'],
      initialDraftFingerprint: 'e3b0c44298fc1c14', finalDraftFingerprint: 'e3b0c44298fc1c14',
      composerVerified: true, targetContextVerified: true, initiallyExpanded: false, finallyExpanded: false,
      modelMenu: { association: 'unique-new-popup-selected-current-model', newVisiblePopupRootCount: 1,
        selectedCurrentModelCount: 1, controls: [
          { depthWithinPopup: 0, controlType: 'ControlType.List', controlTypeId: 50008, accessibleName: 'Models',
            enabled: true, offscreen: false, selected: false, passwordProtected: false, patterns: [],
            pathHash: 'aaaaaaaaaaaaaaaa', runtimeIdHash: 'bbbbbbbbbbbbbbbb', regionHash: 'cccccccccccccccc' },
          { depthWithinPopup: 1, controlType: 'ControlType.ListItem', controlTypeId: 50007, accessibleName: 'Kimi-K3',
            enabled: true, offscreen: false, selected: true, passwordProtected: false, patterns: ['selectionItem'],
            pathHash: 'dddddddddddddddd', runtimeIdHash: 'eeeeeeeeeeeeeeee', regionHash: 'cccccccccccccccc' },
        ] },
      patternReceipts: [
        { operation: 'expand', attempted: true, submitted: true, targetContextVerified: true, foregroundVerified: false, hresult: 0, stage: 'submitted', matchingControls: 1 },
        { operation: 'collapse', attempted: true, submitted: true, targetContextVerified: true, foregroundVerified: false, hresult: 0, stage: 'submitted', matchingControls: 1 },
      ] },
  };
  let starts = 0;
  let request;
  const client = createWindowsUiaInspector({ platform: 'win32', helperPath: HELPER_PATH, timeoutMs: 1000,
    spawnImpl: (_command, args) => {
      starts += 1;
      assert.deepEqual(args, ['-NoProfile', '-NonInteractive', '-STA', '-ExecutionPolicy', 'Bypass', '-File', HELPER_PATH]);
      const child = new EventEmitter();
      child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough(); child.kill = () => true;
      const chunks = [];
      child.stdin.on('data', (chunk) => chunks.push(chunk));
      child.stdin.on('end', () => {
        request = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        queueMicrotask(() => { child.stdout.end(JSON.stringify(response), 'utf8'); child.emit('close', 0); });
      });
      return child;
    } });
  const result = await client.readNativeModelCatalog({ expectedExePath: 'D:\\tools\\WorkBuddy\\WorkBuddy.exe' });
  assert.equal(starts, 1);
  assert.equal(request.operation, 'native-model-catalog');
  assert.deepEqual(request, { protocol: PROTOCOL, operation: 'native-model-catalog',
    expectedExePath: 'D:\\tools\\WorkBuddy\\WorkBuddy.exe', maxControls: 1, helperBudgetMs: 1000 });
  assert.equal(result.catalog.models.length, 2);
  assert.deepEqual(result.catalog.patternReceipts.map((receipt) => receipt.operation), ['expand', 'collapse']);
  assert.throws(() => validateNativeModelCatalog({ ...response, catalog: { ...response.catalog,
    finalDraftFingerprint: '0000000000000000' } }, { expectedExePath: 'D:\\tools\\WorkBuddy\\WorkBuddy.exe' }),
  (error) => error.code === 'bridge_error');
  assert.throws(() => validateNativeModelCatalog({ ...response, catalog: { ...response.catalog,
    patternReceipts: response.catalog.patternReceipts.map((receipt) => ({ ...receipt, operation: 'select' })) } },
  { expectedExePath: 'D:\\tools\\WorkBuddy\\WorkBuddy.exe' }), (error) => error.code === 'bridge_error');
  assert.throws(() => validateNativeModelCatalog({ ...response, catalog: { ...response.catalog,
    modelMenu: { ...response.catalog.modelMenu, controls: [{ ...response.catalog.modelMenu.controls[1],
      accessibleName: 'password=unsafe-value' }] } } }, { expectedExePath: 'D:\\tools\\WorkBuddy\\WorkBuddy.exe' }),
  (error) => error.code === 'bridge_error');
  assert.match(fs.readFileSync(path.join(__dirname, '../src/workbuddy-native/windows-uia.ps1'), 'utf8'), /ReadNativeModelCatalog\(\$targetHwnd, \$targetPid\)/);
});

test('PowerShell model and New Task proof DTOs preserve confirmed and fail-closed shapes', { skip: process.platform !== 'win32' }, () => {
  const fixturePath = path.join(__dirname, 'workbuddy-native-model-catalog-fixture.ps1');
  const comSourcePath = path.join(__dirname, '../src/workbuddy-native/windows-uia-com.cs');
  const pendingSourcePath = path.join(__dirname, '../src/workbuddy-native/windows-uia-pending.cs');
  const stdout = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', fixturePath, '-ComSourcePath', comSourcePath, '-PendingSourcePath', pendingSourcePath],
  { encoding: 'utf8', windowsHide: true, timeout: 15000 });
  const fixture = JSON.parse(stdout.trim());
  assert.equal(fixture.draftFingerprints.empty, 'e3b0c44298fc1c14');
  assert.equal(fixture.draftFingerprints.chinesePlaceholderSendDisabled, fixture.draftFingerprints.empty);
  assert.equal(fixture.draftFingerprints.compactChinesePlaceholderSendDisabled, fixture.draftFingerprints.empty);
  assert.equal(fixture.draftFingerprints.englishPlaceholderSendDisabled, fixture.draftFingerprints.empty);
  assert.notEqual(fixture.draftFingerprints.chinesePlaceholderSendEnabled, fixture.draftFingerprints.empty);
  assert.notEqual(fixture.draftFingerprints.userText, fixture.draftFingerprints.empty);
  assert.equal(validateNewTaskPageProof(fixture.newTaskPageProofs.positive), true);
  assert.equal(validateNewTaskPageProof(fixture.newTaskPageProofs.selectedConversation), true);
  assert.equal(fixture.newTaskPageProofs.positive.verified, true);
  assert.equal(fixture.newTaskPageProofs.positive.visibleWelcomeMarkerMatches, 0);
  assert.equal(fixture.newTaskPageProofs.positive.composerDocumentWelcomeMarkerMatches, 0);
  assert.deepEqual(fixture.newTaskPageProofs.positive.composerDocumentTextSamples, []);
  assert.equal(fixture.newTaskPageProofs.positive.composerDocumentTextSampleCount, 0);
  assert.equal(fixture.newTaskPageProofs.positive.composerAncestors.length, 5);
  assert.equal(fixture.newTaskPageProofs.positive.composerAncestorCount, 5);
  assert.equal(fixture.newTaskPageProofs.positive.homePageAncestorMatches, 1);
  assert.equal(fixture.newTaskPageProofs.positive.homeComposerAncestorMatches, 1);
  assert.equal(fixture.newTaskPageProofs.positive.homeRouteInputAncestorMatches, 1);
  assert.equal(fixture.nonChatNavigation.skills, 'skills');
  assert.equal(fixture.nonChatNavigation.selectedSubsection, 'skills');
  assert.equal(fixture.nonChatNavigation.projects, 'projects');
  assert.equal(fixture.nonChatNavigation.unknown, '');
  assert.equal(fixture.nonChatNavigation.mixed, '');
  assert.equal(fixture.nonChatNavigation.noSelection, '');
  assert.equal(validateNewTaskPageProof({ ...fixture.newTaskPageProofs.positive,
    composerDocumentTextSampleCount: 1, composerDocumentTextSamples: ['API_KEY=unsafe-value'] }), false);
  assert.equal(validateNewTaskPageProof({ ...fixture.newTaskPageProofs.positive, composerAncestorCount: 1,
    composerAncestors: [{ depth: 2, controlTypeId: 50033, accessibleName: '', automationId: 'access_token=unsafe',
      className: 'div', ariaRole: '', pathHash: '1122334455667788', runtimeIdHash: 'aabbccddeeff0011', regionHash: '' }] }), false);
  for (const name of ['selectedConversation', 'matchingHeader', 'missingHomeClass', 'truncated']) {
    assert.equal(fixture.newTaskPageProofs[name].verified, false);
    assert.equal(validateNewTaskPageProof(fixture.newTaskPageProofs[name]), true);
  }
  assert.equal(validateNativeModelCatalog(fixture.confirmed, { expectedExePath: 'D:\\tools\\WorkBuddy\\WorkBuddy.exe' }).outcome, 'confirmed');
  assert.equal(validateNativeModelCatalog(fixture.blocked, { expectedExePath: 'D:\\tools\\WorkBuddy\\WorkBuddy.exe' }).outcome, 'blocked');
  assert.equal(validateNativeModelCatalog(fixture.restoredBlocked, { expectedExePath: 'D:\\tools\\WorkBuddy\\WorkBuddy.exe' }).outcome, 'blocked');
  assert.throws(() => validateNativeModelCatalog({ ...fixture.restoredBlocked, catalog: {
    ...fixture.restoredBlocked.catalog, finalDraftFingerprint: '0000000000000000',
  } }, { expectedExePath: 'D:\\tools\\WorkBuddy\\WorkBuddy.exe' }), (error) => error.code === 'bridge_error');
  assert.equal(fixture.confirmed.catalog.targetContextVerified, true);
  assert.equal(fixture.blocked.catalog.targetContextVerified, true);
  assert.equal(fixture.restoredBlocked.catalog.targetContextVerified, true);
  const productionPs = fs.readFileSync(path.join(__dirname, '../src/workbuddy-native/windows-uia.ps1'), 'utf8');
  assert.match(productionPs, /\[Console\]::InputEncoding = \$utf8Input/);
  assert.match(productionPs, /catalog=@\{ currentModel=\[string\]\$catalog\.currentModel; models=@\(\$catalog\.models\)\s+targetContextVerified=\[bool\]\$catalog\.targetContextVerified/s);
  assert.match(productionPs, /Add-Type -Path @\([\s\S]*windows-uia-com\.cs[\s\S]*windows-uia-pending\.cs[\s\S]*\)/);
});

test('PowerShell 5.1 preserves optional null strings across the C# semantic-action boundary', { skip: process.platform !== 'win32' }, () => {
  const fixturePath = path.join(__dirname, 'workbuddy-native-nullstring-binding-fixture.ps1');
  const productionPs = fs.readFileSync(path.join(__dirname, '../src/workbuddy-native/windows-uia.ps1'), 'utf8');
  const stdout = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', fixturePath], { encoding: 'utf8', windowsHide: true, timeout: 10000 });
  const fixture = JSON.parse(stdout.trim());

  // An ordinary PS $null becomes an empty string for a C# string parameter,
  // which incorrectly fails both no-identity branches in the production guard.
  assert.equal(fixture.ordinaryNull, 'empty');
  assert.equal(fixture.emptyCandidatesNavigationStage, 'validate');
  assert.equal(fixture.emptyCandidatesNewTaskIntentStage, 'validate');
  // The sentinel binds as true CLR null and reaches the fresh-tree stage for
  // navigation and first-message intent without weakening identity checks.
  assert.equal(fixture.clrNullIdentity, 'null');
  assert.equal(fixture.clrNullPayload, 'null');
  assert.equal(fixture.clrNullExpectedControlName, 'null');
  assert.equal(fixture.clrNullNavigationStage, 'fresh-tree');
  assert.equal(fixture.clrNullNewTaskIntentStage, 'fresh-tree');

  assert.match(productionPs, /\$payloadForCom\s*=\s*\$payload[\s\S]*?if \(\$null -eq \$payloadForCom\) \{ \$payloadForCom = \$nullString \}/);
  assert.match(productionPs, /\$identityTitleForCom\s*=\s*\$identityTitle[\s\S]*?if \(\$null -eq \$identityTitleForCom\) \{ \$identityTitleForCom = \$nullString \}/);
  assert.match(productionPs, /\$expectedControlNameForCom\s*=\s*\$nullString/);
  assert.match(productionPs, /ExecuteSemanticAction\([\s\S]*?\$payloadForCom, \$identityTitleForCom, \$anchorCandidates, \$expectedCandidateIndex,[\s\S]*?\$expectedControlNameForCom/);
});

test('native UIA helpers receive a relative remaining budget and check activity before launch', async () => {
  let request;
  let starts = 0;
  let activeChecks = 0;
  const inspection = sampleInspection();
  const response = {
    protocol: PROTOCOL, operation: 'native-model-catalog', readOnly: false, outcome: 'confirmed', reason: null,
    targetContextVerified: true, inputDesktopKind: 'default',
    target: { processId: 36728, handle: '2623190', mainWindow: true, visible: true, enabled: true,
      minimized: false, isForeground: false, foregroundHandle: '1000' },
    processContext: { helper: inspection.helperProcessContext, target: inspection.targetProcessContexts[0],
      sameWindowsSession: true, sameBitness: true, sameIntegrityLevel: true },
    catalog: { currentModel: 'Kimi-K3', models: ['Kimi-K3'], targetContextVerified: true,
      initialDraftFingerprint: 'e3b0c44298fc1c14', finalDraftFingerprint: 'e3b0c44298fc1c14',
      composerVerified: true, initiallyExpanded: false, finallyExpanded: false,
      modelMenu: { association: 'unique-new-popup-selected-current-model', newVisiblePopupRootCount: 1,
        selectedCurrentModelCount: 1, controls: [
          { depthWithinPopup: 0, controlType: 'ControlType.List', controlTypeId: 50008, accessibleName: 'Models',
            enabled: true, offscreen: false, selected: false, passwordProtected: false, patterns: [],
            pathHash: 'aaaaaaaaaaaaaaaa', runtimeIdHash: 'bbbbbbbbbbbbbbbb', regionHash: 'cccccccccccccccc' },
          { depthWithinPopup: 1, controlType: 'ControlType.ListItem', controlTypeId: 50007, accessibleName: 'Kimi-K3',
            enabled: true, offscreen: false, selected: true, passwordProtected: false, patterns: ['selectionItem'],
            pathHash: 'dddddddddddddddd', runtimeIdHash: 'eeeeeeeeeeeeeeee', regionHash: 'cccccccccccccccc' },
        ] },
      patternReceipts: [
        { operation: 'expand', attempted: true, submitted: true, targetContextVerified: true, foregroundVerified: false,
          hresult: 0, stage: 'submitted', matchingControls: 1 },
        { operation: 'collapse', attempted: true, submitted: true, targetContextVerified: true, foregroundVerified: false,
          hresult: 0, stage: 'submitted', matchingControls: 1 },
      ] },
  };
  const client = createWindowsUiaInspector({ platform: 'win32', helperPath: HELPER_PATH, timeoutMs: 15000,
    spawnImpl: (_command, _args, _options) => {
      starts += 1;
      const child = new EventEmitter();
      child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough(); child.kill = () => true;
      const chunks = [];
      child.stdin.on('data', (chunk) => chunks.push(chunk));
      child.stdin.on('end', () => {
        request = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        queueMicrotask(() => { child.stdout.end(JSON.stringify(response), 'utf8'); child.emit('close', 0); });
      });
      return child;
    } });
  await client.readNativeModelCatalog({ expectedExePath: 'D:\\tools\\WorkBuddy\\WorkBuddy.exe' }, {
    checkActive() { activeChecks += 1; },
    remainingBudgetMs() { return 4200; },
  });
  assert.equal(starts, 1);
  assert.equal(activeChecks, 1);
  assert.equal(request.helperBudgetMs, 4200);
  assert.equal(Object.hasOwn(request, 'deadline'), false);
  assert.equal(Object.hasOwn(request, 'deadlineAt'), false);

  await assert.rejects(client.readNativeModelCatalog({ expectedExePath: 'D:\\tools\\WorkBuddy\\WorkBuddy.exe' }, {
    checkActive() { throw Object.assign(new Error('expired'), { code: 'bridge_timeout' }); },
    remainingBudgetMs() { return 0; },
  }), (error) => error.code === 'bridge_timeout');
  assert.equal(starts, 1);
});

test('native helper failure diagnostics keep only fixed stage, exception type, exit code and bounded stderr metadata', async () => {
  let diagnostic;
  const client = createWindowsUiaInspector({ platform: 'win32', helperPath: HELPER_PATH, timeoutMs: 1000,
    onHelperDiagnostic(value) { diagnostic = value; },
    spawnImpl: () => {
      const child = new EventEmitter();
      child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough(); child.kill = () => true;
      child.stdin.on('finish', () => queueMicrotask(() => {
        child.stdout.end(JSON.stringify({ protocol: PROTOCOL, error: 'inspection_failed', stage: 'compile-uia-com-probe', failureType: 'CompilationException' }));
        child.stderr.write('CompilationException: raw provider label and payload must never be retained');
        child.stderr.end();
        child.emit('close', 2);
      }));
      return child;
    } });
  await assert.rejects(client.readNativeModelCatalog({ expectedExePath: 'D:\\tools\\WorkBuddy\\WorkBuddy.exe' }),
    (error) => error.code === 'bridge_error');
  assert.deepEqual(diagnostic, { exitCode: 2, stage: 'compile-uia-com-probe', failureType: 'CompilationException',
    stderrFailureType: 'CompilationException', stderrBytes: 75 });
  assert.equal(Object.hasOwn(diagnostic, 'stderr'), false);
  assert.equal(Object.hasOwn(diagnostic, 'message'), false);
});

test('renderer UIA statistics reject unbounded, text-bearing, or malformed diagnostics', () => {
  const status = { rootRetrieved: true, hresult: 0, rootControlTypeId: 50033, traversedNodes: 28,
    traversalTruncated: false, elapsedMs: 300, typeHistogram: ['50033:9', '50032:19'], errorType: null };
  assert.equal(validateDotNetUiaStatus(status), true);
  assert.equal(validateDotNetUiaStatus({ ...status, typeHistogram: ['Pane:secret'] }), false);
  assert.equal(validateDotNetUiaStatus({ ...status, traversedNodes: 2001 }), false);
});

test('native COM helper binds the standard CUIAutomation8 client and Raw View tree walker', () => {
  const comSource = fs.readFileSync(path.join(path.dirname(HELPER_PATH), 'windows-uia-com.cs'), 'utf8');
  const psSource = fs.readFileSync(HELPER_PATH, 'utf8');
  assert.match(comSource, /E22AD333-B25F-460C-83D0-0581107395C9/i);
  assert.match(comSource, /30CBE57D-D9D0-452A-AB13-7AC5AC4825EE/i);
  assert.match(comSource, /get_RawViewWalker/);
  assert.match(comSource, /4042C624-389C-4AFC-A630-9DF854A541FC/i);
  assert.match(comSource, /GetRuntimeId\(out IntPtr runtimeId\)/);
  assert.match(comSource, /SafeArrayGetElement\(array, ref elementIndex, out value\)/);
  assert.match(psSource, /runtimeIdHash=\$nativeControl\.runtimeIdHash; structuralPathHash=\$nativeControl\.pathHash/);
  assert.match(psSource, /runtimeIdHash=''; structuralPathHash=\$pathHash/);
  const walkerStart = comSource.indexOf('internal interface WorkBuddyIUIAutomationTreeWalker');
  const walkerEnd = comSource.indexOf('\n}', walkerStart);
  const walker = comSource.slice(walkerStart, walkerEnd);
  const methods = ['GetParentElement(', 'GetFirstChildElement(', 'GetLastChildElement(', 'GetNextSiblingElement(',
    'GetPreviousSiblingElement(', 'NormalizeElement(', 'GetParentElementBuildCache(', 'GetFirstChildElementBuildCache(',
    'GetLastChildElementBuildCache(', 'GetNextSiblingElementBuildCache(', 'GetPreviousSiblingElementBuildCache(',
    'NormalizeElementBuildCache(', 'get_Condition('];
  for (let index = 1; index < methods.length; index++) assert.ok(walker.indexOf(methods[index - 1]) < walker.indexOf(methods[index]));
  const interfaceSource = (name) => {
    const start = comSource.indexOf(`internal interface ${name}`);
    assert.ok(start >= 0, `${name} interface exists`);
    const end = comSource.indexOf('\n}', start);
    return comSource.slice(start, end);
  };
  const automation = interfaceSource('WorkBuddyIUIAutomation');
  assert.match(automation, /CompareElements\(IntPtr first, IntPtr second, \[MarshalAs\(UnmanagedType\.Bool\)\] out bool same\)/);
  assert.match(automation, /CompareRuntimeIds\(IntPtr first, IntPtr second, \[MarshalAs\(UnmanagedType\.Bool\)\] out bool same\)/);
  const element = interfaceSource('WorkBuddyIUIAutomationElement');
  assert.match(element, /GetCurrentPropertyValueEx\(int propertyId, \[MarshalAs\(UnmanagedType\.Bool\)\] bool ignoreDefault/);
  assert.match(element, /GetCachedPropertyValueEx\(int propertyId, \[MarshalAs\(UnmanagedType\.Bool\)\] bool ignoreDefault/);
  const valuePattern = interfaceSource('WorkBuddyIUIAutomationValuePattern');
  assert.match(comSource, /Guid\("A94CD8B1-0844-4CD6-9D2D-640537AB39E9"\)[\s\S]*?WorkBuddyIUIAutomationValuePattern/);
  for (const method of ['SetValue(', 'get_CurrentValue(', 'get_CurrentIsReadOnly(', 'get_CachedValue(', 'get_CachedIsReadOnly(']) {
    assert.ok(valuePattern.includes(method), `ValuePattern includes SDK slot ${method}`);
  }
  const valueMethods = ['SetValue(', 'get_CurrentValue(', 'get_CurrentIsReadOnly(', 'get_CachedValue(', 'get_CachedIsReadOnly('];
  for (let index = 1; index < valueMethods.length; index++) assert.ok(valuePattern.indexOf(valueMethods[index - 1]) < valuePattern.indexOf(valueMethods[index]));
  assert.match(valuePattern, /get_CurrentIsReadOnly\(\[MarshalAs\(UnmanagedType\.Bool\)\] out bool readOnly\)/);
  assert.match(valuePattern, /get_CachedIsReadOnly\(\[MarshalAs\(UnmanagedType\.Bool\)\] out bool readOnly\)/);
  const expandPattern = interfaceSource('WorkBuddyIUIAutomationExpandCollapsePattern');
  const expandMethods = ['Expand(', 'Collapse(', 'get_CurrentExpandCollapseState(', 'get_CachedExpandCollapseState('];
  for (let index = 1; index < expandMethods.length; index++) assert.ok(expandPattern.indexOf(expandMethods[index - 1]) < expandPattern.indexOf(expandMethods[index]));
  const selectionPattern = interfaceSource('WorkBuddyIUIAutomationSelectionItemPattern');
  const selectionMethods = ['Select(', 'AddToSelection(', 'RemoveFromSelection(', 'get_CurrentIsSelected(', 'get_CurrentSelectionContainer(', 'get_CachedIsSelected(', 'get_CachedSelectionContainer('];
  for (let index = 1; index < selectionMethods.length; index++) assert.ok(selectionPattern.indexOf(selectionMethods[index - 1]) < selectionPattern.indexOf(selectionMethods[index]));
  assert.match(selectionPattern, /get_CurrentIsSelected\(\[MarshalAs\(UnmanagedType\.Bool\)\] out bool selected\)/);
  assert.match(selectionPattern, /get_CachedIsSelected\(\[MarshalAs\(UnmanagedType\.Bool\)\] out bool selected\)/);
  assert.match(psSource, /\$allowContext = \(\$isExactTarget -and \$window\.visible -and \$window\.enabled\)/);
  assert.match(psSource, /Foreground remains a hard/);
  assert.match(psSource, /AddStructureChangedEventHandler/);
  assert.doesNotMatch(psSource, /\[uint32\]1\).*assistive|assistive-technology OBJID/i);
  assert.match(psSource, /windows-uia-com\.cs/);
  const rectStart = comSource.indexOf('object rectValue = Property(node.Element, BoundingRectanglePropertyId);');
  const rectEnd = comSource.indexOf('return new ControlSummary', rectStart);
  const uiARect = comSource.slice(rectStart, rectEnd);
  assert.match(uiARect, /GetValue\(2\).*width|width.*GetValue\(2\)/s);
  assert.match(uiARect, /GetValue\(3\).*height|height.*GetValue\(3\)/s);
  assert.doesNotMatch(uiARect, /GetValue\(2\)[^;]*-[^;]*GetValue\(0\)|GetValue\(3\)[^;]*-[^;]*GetValue\(1\)/s);
  assert.match(comSource, /CommonAncestorPath\(summarizedNodes\[editIndexes\[0\]\]\.Path/);
  assert.match(comSource, /groupDepth >= 3 && groupTypeKnown && \(groupTypeId == 50033 \|\| groupTypeId == 50026\)/);
  assert.match(comSource, /ReadBoundComposerDraft\(edit, summarizedNodes\[editIndexes\[0\]\], !send\.enabled\)/);
  assert.match(comSource, /public static partial class WorkBuddyWindowsUiaComProbe/);
  assert.match(comSource, /internal Node\[\] AllNodeReferences \{ get; set; \}/);
  assert.match(comSource, /result\.AllNodeReferences = status\.traversalTruncated \? new Node\[0\] : traversedNodeRefs\.ToArray\(\)/);
  assert.match(comSource, /summary\.passwordProtected\) return/);
  assert.match(comSource, /ExecuteSemanticAction\(/);
  assert.match(comSource, /control\.runtimeIdHash == runtimeIdHash && control\.regionHash == regionHash/);
  assert.match(comSource, /GetCurrentPattern\(patternId, out pattern\)/);
  assert.match(comSource, /ValuePatternId/);
  assert.match(comSource, /InvokePatternId/);
  assert.match(comSource, /ExpandCollapsePatternId/);
  assert.match(comSource, /SelectionItemPatternId/);
  assert.match(comSource, /target\.draftState != "empty" \|\| target\.draftFingerprint != expectedDraftFingerprint/);
});

test('UIA client invokes only the read-only inspect operation and validates its response', async () => {
  let invocation;
  const client = createWindowsUiaInspector({ platform: 'win32', helperPath: HELPER_PATH, execFileImpl: async (...args) => {
    invocation = args;
    return { stdout: JSON.stringify(sampleInspection()) };
  } });
  const result = await client.inspect({ expectedExePath: 'D:\\tools\\WorkBuddy\\WorkBuddy.exe', maxControls: 40 });
  assert.equal(result.windows[0].handle, '2623190');
  assert.equal(invocation[0], 'powershell.exe');
  const request = JSON.parse(invocation[1].at(-1));
  assert.deepEqual(request, { protocol: PROTOCOL, operation: 'inspect', expectedExePath: 'D:\\tools\\WorkBuddy\\WorkBuddy.exe', maxControls: 40 });
  assert.deepEqual(invocation[1].slice(0, 5), ['-NoProfile', '-NonInteractive', '-STA', '-ExecutionPolicy', 'Bypass']);
});

test('UIA client fails closed for unsupported platforms, timeout and malformed helper output', async () => {
  await assert.rejects(createWindowsUiaInspector({ platform: 'linux' }).inspect(), (error) => error.code === 'not_capable');
  await assert.rejects(createWindowsUiaInspector({ platform: 'win32', execFileImpl: async () => { throw Object.assign(new Error(), { killed: true }); } }).inspect(), /timed out/);
  await assert.rejects(createWindowsUiaInspector({ platform: 'win32', execFileImpl: async () => ({ stdout: '{bad' }) }).inspect(), /invalid JSON/);
});

test('activation is bound to exact executable, PID and main HWND and needs fresh foreground confirmation', async () => {
  const calls = [];
  const responses = [
    sampleInspection(),
    { protocol: PROTOCOL, operation: 'activate-window', outcome: 'confirmed', reason: null },
    sampleInspection(),
  ];
  const client = createWindowsUiaInspector({ platform: 'win32', execFileImpl: async (_bin, args) => {
    calls.push(JSON.parse(args.at(-1)));
    return { stdout: JSON.stringify(responses.shift()) };
  } });
  const result = await client.activateMainWindow({ expectedExePath: 'D:\\tools\\WorkBuddy\\WorkBuddy.exe', expectedProcessId: 36728, expectedHandle: '2623190' });
  assert.equal(result.outcome, 'confirmed');
  assert.deepEqual(calls.map((call) => call.operation), ['inspect', 'activate-window', 'inspect']);
  assert.deepEqual({ pid: calls[1].expectedProcessId, handle: calls[1].expectedHandle, exe: calls[1].expectedExePath }, {
    pid: 36728, handle: '2623190', exe: 'D:\\tools\\WorkBuddy\\WorkBuddy.exe',
  });
});

test('combined activation and inspection use one fresh helper process so focus can be verified with the tree', async () => {
  const calls = [];
  const response = sampleInspection();
  response.activation = { outcome: 'confirmed', reason: null };
  const client = createWindowsUiaInspector({ platform: 'win32', execFileImpl: async (_bin, args) => {
    calls.push(JSON.parse(args.at(-1)));
    return { stdout: JSON.stringify(response) };
  } });
  const result = await client.activateAndInspectMainWindow({ expectedExePath: 'D:\\tools\\WorkBuddy\\WorkBuddy.exe', expectedProcessId: 36728, expectedHandle: '2623190' });
  assert.equal(result.outcome, 'confirmed');
  assert.equal(result.inspection.windows[0].handle, '2623190');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].operation, 'activate-inspect');
});

test('semantic actions use a bounded stdin pipe and reject path-only or mismatched targets', async () => {
  const inspection = sampleInspection();
  const response = {
    protocol: PROTOCOL, operation: 'semantic-action', readOnly: false, inputDesktopKind: 'default',
    target: { processId: 36728, handle: '2623190', windowsSessionId: 1, visible: true, enabled: true,
      minimized: false, isForeground: true, foregroundHandle: '2623190', mainWindow: true },
    processContext: { helper: inspection.helperProcessContext, target: inspection.targetProcessContexts[0],
      sameWindowsSession: true, sameBitness: true, sameIntegrityLevel: true },
    uiaCom: inspection.windows[0].uiaCom.status,
    targetContextVerified: true,
    actionResult: { attempted: true, submitted: true, conversationIdentityVerified: true, newTaskIntentVerified: false, targetContextVerified: true, foregroundVerified: false,
      hresult: 0, stage: 'submitted', matchingControls: 1 },
    controls: [{ controlType: 'ControlType.Button', enabled: true, selected: false, selectedItemLabel: '',
      safeActionLabel: '', accessibleName: '模型选择成功', runtimeIdHash: '0123456789abcdef',
      draftState: 'unavailable', draftFingerprint: '', patterns: [] }],
  };
  let invocation;
  let stdinRequest;
  const client = createWindowsUiaInspector({ platform: 'win32', helperPath: HELPER_PATH, timeoutMs: 1000,
    spawnImpl: (command, args, options) => {
      invocation = { command, args, options };
      const child = new EventEmitter();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.stdin = new PassThrough();
      child.kill = () => true;
      const chunks = [];
      child.stdin.on('data', (chunk) => chunks.push(chunk));
      child.stdin.on('end', () => {
        stdinRequest = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        queueMicrotask(() => {
          // A multibyte character deliberately straddles stdout chunks. The
          // helper must decode bytes only after reassembly, not decode each
          // chunk independently.
          const encoded = Buffer.from(JSON.stringify(response), 'utf8');
          const marker = encoded.indexOf(Buffer.from('模', 'utf8'));
          assert.ok(marker > 0);
          child.stdout.write(encoded.subarray(0, marker + 1));
          child.stdout.write(encoded.subarray(marker + 1));
          // Fill stderr beyond a typical pipe buffer. It must be drained but
          // neither retained nor included in the response/error.
          child.stderr.end(Buffer.alloc(128 * 1024, 0x78));
          child.stdout.end();
          child.emit('close', 0);
        });
      });
      return child;
    } });
  const text = 'synthetic private QA message';
  const identity = { identityTitle: 'QA native chat', anchorCandidates: [['hello from the test']], expectedCandidateIndex: 0 };
  const result = await client.executeSemanticAction({ expectedExePath: 'D:\\tools\\WorkBuddy\\WorkBuddy.exe',
    expectedProcessId: 36728, expectedHandle: '2623190', action: 'set-value', safeActionLabel: 'composer',
    runtimeIdHash: '0123456789abcdef', regionHash: 'fedcba9876543210', expectedDraftFingerprint: 'e3b0c44298fc1c14', payload: text,
    ...identity });
  assert.equal(result.actionResult.submitted, true);
  assert.equal(result.controls[0].accessibleName, '模型选择成功');
  assert.equal(invocation.command, 'powershell.exe');
  assert.deepEqual(invocation.args, ['-NoProfile', '-NonInteractive', '-STA', '-ExecutionPolicy', 'Bypass', '-File', HELPER_PATH]);
  assert.equal(invocation.args.some((argument) => String(argument).includes(text)), false);
  assert.equal(stdinRequest.payload, text);
  assert.equal(stdinRequest.runtimeIdHash, '0123456789abcdef');
  assert.deepEqual(stdinRequest.anchorCandidates, identity.anchorCandidates);
  assert.equal(stdinRequest.identityTitle, identity.identityTitle);
  assert.equal(stdinRequest.expectedCandidateIndex, 0);
  assert.equal(stdinRequest.helperBudgetMs, 1000);
  assert.equal(invocation.options.windowsHide, true);
  const background = { ...response, target: { ...response.target, isForeground: false, foregroundHandle: '1000' } };
  assert.equal(validateSemanticAction(background, { expectedProcessId: 36728, expectedHandle: '2623190' }), background);
  await assert.rejects(client.executeSemanticAction({ expectedExePath: 'D:\\tools\\WorkBuddy\\WorkBuddy.exe',
    expectedProcessId: 36728, expectedHandle: '2623190', action: 'invoke', safeActionLabel: 'send-label',
    structuralPathHash: '0123456789abcdef', regionHash: 'fedcba9876543210', expectedDraftFingerprint: '0123456789abcdef' }),
  (error) => error.code === 'invalid_params');
});

test('new-task tab selection is a supported SelectionItem action without conversation identity or composer payload', async () => {
  const inspection = sampleInspection();
  const response = {
    protocol: PROTOCOL, operation: 'semantic-action', readOnly: false, inputDesktopKind: 'default',
    target: { processId: 36728, handle: '2623190', windowsSessionId: 1, visible: true, enabled: true,
      minimized: false, isForeground: true, foregroundHandle: '2623190', mainWindow: true },
    processContext: { helper: inspection.helperProcessContext, target: inspection.targetProcessContexts[0],
      sameWindowsSession: true, sameBitness: true, sameIntegrityLevel: true },
    uiaCom: inspection.windows[0].uiaCom.status,
    targetContextVerified: true,
    actionResult: { attempted: true, submitted: true, conversationIdentityVerified: false, newTaskIntentVerified: false,
      newTaskNavigationSource: 'empty-composer', targetContextVerified: true, foregroundVerified: false,
      hresult: 0, stage: 'submitted', matchingControls: 1 },
    controls: [{ controlType: 'ControlType.TabItem', enabled: true, selected: true, selectedItemLabel: '新建任务',
      safeActionLabel: 'new-task-tab', accessibleName: '新建任务', runtimeIdHash: '0123456789abcdef',
      structuralPathHash: 'fedcba9876543210', regionHash: '0011223344556677', passwordProtected: false,
      draftState: 'unavailable', draftFingerprint: '', patterns: ['selectionItem'] }],
  };
  let request;
  const client = createWindowsUiaInspector({ platform: 'win32', helperPath: HELPER_PATH, timeoutMs: 1000,
    spawnImpl: (command, args, options) => {
      const child = new EventEmitter();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.stdin = new PassThrough();
      child.kill = () => true;
      const chunks = [];
      child.stdin.on('data', (chunk) => chunks.push(chunk));
      child.stdin.on('end', () => {
        request = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        queueMicrotask(() => {
          child.stdout.end(JSON.stringify(response));
          child.emit('close', 0);
        });
      });
      assert.equal(command, 'powershell.exe');
      assert.equal(options.windowsHide, true);
      assert.deepEqual(args.slice(0, 5), ['-NoProfile', '-NonInteractive', '-STA', '-ExecutionPolicy', 'Bypass']);
      return child;
    } });
  const result = await client.executeSemanticAction({ expectedExePath: 'D:\\tools\\WorkBuddy\\WorkBuddy.exe',
    expectedProcessId: 36728, expectedHandle: '2623190', action: 'select', safeActionLabel: 'new-task-tab',
    runtimeIdHash: '0123456789abcdef', regionHash: '0011223344556677' });
  assert.equal(result.actionResult.submitted, true);
  assert.equal(request.action, 'select');
  assert.equal(request.safeActionLabel, 'new-task-tab');
  assert.deepEqual(request.anchorCandidates, []);
  assert.equal(request.payload, undefined);
});

test('new-chat Value and Send actions carry a private fresh-page intent proof instead of a fabricated session identity', async () => {
  const inspection = sampleInspection();
  const response = {
    protocol: PROTOCOL, operation: 'semantic-action', readOnly: false, inputDesktopKind: 'default',
    target: { processId: 36728, handle: '2623190', windowsSessionId: 1, visible: true, enabled: true,
      minimized: false, isForeground: false, foregroundHandle: '1000', mainWindow: true },
    processContext: { helper: inspection.helperProcessContext, target: inspection.targetProcessContexts[0],
      sameWindowsSession: true, sameBitness: true, sameIntegrityLevel: true },
    uiaCom: inspection.windows[0].uiaCom.status,
    targetContextVerified: true,
    actionResult: { attempted: true, submitted: true, conversationIdentityVerified: false, newTaskIntentVerified: true,
      targetContextVerified: true, foregroundVerified: false, hresult: 0, stage: 'submitted', matchingControls: 1 },
    controls: [],
  };
  let request;
  const client = createWindowsUiaInspector({ platform: 'win32', helperPath: HELPER_PATH, timeoutMs: 1000,
    spawnImpl: (_command, _args, _options) => {
      const child = new EventEmitter();
      child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough(); child.kill = () => true;
      const chunks = [];
      child.stdin.on('data', (chunk) => chunks.push(chunk));
      child.stdin.on('end', () => {
        request = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        queueMicrotask(() => { child.stdout.end(JSON.stringify(response)); child.emit('close', 0); });
      });
      return child;
    } });
  const text = '只回复 WORKBUDDY-PARITY-OK';
  const titles = ['existing native chat'];
  const result = await client.executeSemanticAction({ expectedExePath: 'D:\\tools\\WorkBuddy\\WorkBuddy.exe',
    expectedProcessId: 36728, expectedHandle: '2623190', action: 'set-value', safeActionLabel: 'composer',
    runtimeIdHash: '0123456789abcdef', regionHash: 'fedcba9876543210', expectedDraftFingerprint: 'e3b0c44298fc1c14',
    payload: text, requireNewTaskIntent: true, knownConversationTitles: titles });
  assert.equal(result.actionResult.newTaskIntentVerified, true);
  assert.equal(request.requireNewTaskIntent, true);
  assert.deepEqual(request.knownConversationTitles, titles);
  assert.equal(request.identityTitle, null);
  assert.deepEqual(request.anchorCandidates, []);
  assert.equal(request.payload, text);
  assert.equal(request.helperBudgetMs, 1000);
  assert.equal(Object.hasOwn(result, 'knownConversationTitles'), false);
});

test('public WorkBuddy URI routing accepts only a verified exact native history destination', async () => {
  const sessionId = '11111111-2222-4333-8444-555555555555';
  const response = {
    protocol: PROTOCOL, operation: 'navigate-conversation', readOnly: false, inputDesktopKind: 'default',
    outcome: 'confirmed', reason: null, routeSubmitted: true, targetContextVerified: true,
    target: { processId: 36728, handle: '2623190', mainWindow: true, visible: true, enabled: true,
      minimized: false, isForeground: false, foregroundHandle: '1000' },
    processContext: { sameWindowsSession: true, sameBitness: true, sameIntegrityLevel: true },
    identityProof: { conversationRowMatches: 0, conversationHeaderMatches: 1, candidateCount: 1, matchedCandidateIndex: 0 },
  };
  let request;
  const client = createWindowsUiaInspector({ platform: 'win32', helperPath: HELPER_PATH, timeoutMs: 1000,
    spawnImpl: (_command, _args, _options) => {
      const child = new EventEmitter();
      child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough(); child.kill = () => true;
      const chunks = [];
      child.stdin.on('data', (chunk) => chunks.push(chunk));
      child.stdin.on('end', () => {
        request = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        queueMicrotask(() => { child.stdout.end(JSON.stringify(response)); child.emit('close', 0); });
      });
      return child;
    } });
  const route = await client.navigateConversation({ expectedExePath: 'D:\\tools\\WorkBuddy\\WorkBuddy.exe',
    expectedProcessId: 36728, expectedHandle: '2623190', sessionId, identityTitle: 'Native session',
    anchorCandidates: [['first exact user message']], expectedCandidateIndex: 0 });
  assert.equal(route.outcome, 'confirmed');
  assert.equal(route.target.isForeground, false);
  assert.equal(request.operation, 'navigate-conversation');
  assert.equal(request.sessionId, sessionId);
  assert.equal(request.expectedCandidateIndex, 0);
  assert.equal(request.helperBudgetMs, 1000);
  assert.throws(() => validateNativeConversationNavigation({ ...response, targetContextVerified: false },
    { expectedProcessId: 36728, expectedHandle: '2623190' }, 1, 0), (error) => error.code === 'bridge_error');
});

test('semantic action timeout returns a fixed unknown-outcome error and never retries', async () => {
  let starts = 0;
  let killed = 0;
  const client = createWindowsUiaInspector({ platform: 'win32', helperPath: HELPER_PATH, timeoutMs: 5,
    spawnImpl: () => {
      starts += 1;
      const child = new EventEmitter();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.stdin = new PassThrough();
      child.kill = () => { killed += 1; return true; };
      child.stdin.resume();
      return child;
    } });
  await assert.rejects(client.executeSemanticAction({ expectedExePath: 'D:\\tools\\WorkBuddy\\WorkBuddy.exe',
    expectedProcessId: 36728, expectedHandle: '2623190', action: 'set-value', safeActionLabel: 'composer',
    runtimeIdHash: '0123456789abcdef', regionHash: 'fedcba9876543210',
    expectedDraftFingerprint: 'e3b0c44298fc1c14', payload: '敏感的测试内容', identityTitle: 'QA native chat',
    anchorCandidates: [['hello from the test']], expectedCandidateIndex: 0 }),
  (error) => error.code === 'bridge_error' && /outcome is unknown; refresh the native chat/.test(error.message) &&
    !error.message.includes('敏感的测试内容'));
  assert.equal(starts, 1);
  assert.equal(killed, 1);
});

test('activation blocks when another HWND is selected or input desktop is locked', async () => {
  const wrongWindow = sampleInspection();
  wrongWindow.windows[0].handle = '10360974';
  const wrongClient = createWindowsUiaInspector({ platform: 'win32', execFileImpl: async () => ({ stdout: JSON.stringify(wrongWindow) }) });
  assert.deepEqual(await wrongClient.activateMainWindow({ expectedExePath: 'D:\\tools\\WorkBuddy\\WorkBuddy.exe', expectedProcessId: 36728, expectedHandle: '2623190' }), {
    outcome: 'blocked', reason: 'exact-main-window-mismatch',
  });
  const locked = sampleInspection();
  locked.inputDesktopKind = 'secure';
  locked.inputDesktopAccessible = false;
  const lockedClient = createWindowsUiaInspector({ platform: 'win32', execFileImpl: async () => ({ stdout: JSON.stringify(locked) }) });
  assert.deepEqual(await lockedClient.activateMainWindow({ expectedExePath: 'D:\\tools\\WorkBuddy\\WorkBuddy.exe', expectedProcessId: 36728, expectedHandle: '2623190' }), {
    outcome: 'blocked', reason: 'input-desktop-not-default',
  });
});
