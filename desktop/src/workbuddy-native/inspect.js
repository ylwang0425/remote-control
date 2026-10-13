'use strict';

const { BridgeError } = require('../errors');
const { createWindowsUiaInspector } = require('./windows-uia');

function parseArgs(argv) {
  const values = {};
  let readOnly = false;
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    if (key === '--read-only') {
      if (readOnly) throw new BridgeError('invalid_params', 'Do not repeat --read-only');
      readOnly = true;
      continue;
    }
    if (!['--exe', '--pid', '--handle'].includes(key) || values[key]) {
      throw new BridgeError('invalid_params', 'Use --exe <WorkBuddy.exe> --pid <process id> --handle <main window handle> [--read-only]');
    }
    const value = argv[++i];
    if (typeof value !== 'string' || value.startsWith('--')) {
      throw new BridgeError('invalid_params', 'A required WorkBuddy UIA selector is missing');
    }
    values[key] = value;
  }
  if (!values['--exe'] || !values['--pid'] || !values['--handle'] || !/^\d{1,10}$/.test(values['--pid']) ||
      !/^\d{1,20}$/.test(values['--handle'])) {
    throw new BridgeError('invalid_params', 'Use --exe <WorkBuddy.exe> --pid <process id> --handle <main window handle> [--read-only]');
  }
  return { expectedExePath: values['--exe'], expectedProcessId: Number(values['--pid']), expectedHandle: values['--handle'], readOnly };
}

function summarizeStatus(status) {
  if (!status) return null;
  return {
    accessible: status.accessible,
    hresult: status.hresult,
    ia2Hresult: status.ia2Hresult,
    ia2Stage: status.ia2Stage,
    ia2Accessible: status.ia2Accessible,
    stage: status.stage,
    rootRole: status.rootRole,
    traversalNodes: status.traversalNodes,
    traversalTruncated: status.traversalTruncated,
  };
}

function histogram(controls = []) {
  const counts = new Map();
  for (const control of controls) {
    if (typeof control.controlType === 'string') counts.set(control.controlType, (counts.get(control.controlType) ?? 0) + 1);
  }
  return [...counts.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([controlType, count]) => ({ controlType, count }));
}

function projectSnapshot(result, selector) {
  const combined = Boolean(result?.inspection);
  const inspection = combined ? result.inspection : result;
  if (!inspection || !Array.isArray(inspection.windows) || (combined && !inspection.activation)) {
    throw new BridgeError('bridge_error', 'WorkBuddy did not return a fresh UI Automation snapshot');
  }
  const windows = inspection.windows.filter((window) => window.handle === selector.expectedHandle &&
    window.processId === selector.expectedProcessId && window.mainWindow && window.executableName === 'WorkBuddy.exe');
  if (windows.length > 1) throw new BridgeError('bridge_error', 'WorkBuddy main window identity is ambiguous');
  const window = windows[0] ?? null;
  const helperProcessContext = inspection.helperProcessContext;
  const targetProcessContext = (inspection.targetProcessContexts ?? []).find((context) => context.processId === selector.expectedProcessId) ?? null;
  const controls = (window?.controls ?? []).filter((control) => control.safeActionLabel || control.selectedItemLabel ||
    control.safeActionLabel === 'model-selector' ||
    (control.controlType === 'ControlType.Edit' && control.draftState !== 'unavailable'))
    .map((control) => ({
      controlType: control.controlType,
      safeActionLabel: control.safeActionLabel,
      selectedItemLabel: control.selectedItemLabel,
      accessibleName: control.accessibleName,
      enabled: control.enabled,
      selected: control.selected,
      offscreen: control.offscreen ?? false,
      focusable: control.focusable ?? false,
      runtimeIdHash: control.runtimeIdHash ?? '',
      structuralPathHash: control.structuralPathHash ?? '',
      regionHash: control.regionHash ?? '',
      passwordProtected: control.passwordProtected ?? false,
      rect: control.rect ?? null,
      draftState: control.draftState,
      draftFingerprint: control.draftFingerprint,
      patterns: control.patterns,
    }));
  return {
    readOnly: true,
    activation: combined ? result.outcome : 'not-requested',
    activationReason: combined ? result.reason : null,
    inputDesktopKind: inspection.inputDesktopKind,
    processContext: {
      helper: helperProcessContext,
      target: targetProcessContext,
      sameWindowsSession: helperProcessContext && targetProcessContext
        ? helperProcessContext.windowsSessionId === targetProcessContext.windowsSessionId : null,
      sameBitness: helperProcessContext && targetProcessContext && helperProcessContext.is64BitProcess !== null && targetProcessContext.is64BitProcess !== null
        ? helperProcessContext.is64BitProcess === targetProcessContext.is64BitProcess : null,
      sameIntegrityLevel: helperProcessContext && targetProcessContext && helperProcessContext.integrityLevel && targetProcessContext.integrityLevel
        ? helperProcessContext.integrityLevel === targetProcessContext.integrityLevel : null,
    },
    window: window ? {
      handle: window.handle,
      processId: window.processId,
      visible: window.visible,
      enabled: window.enabled,
      minimized: window.minimized,
      isForeground: window.isForeground,
      foregroundHandle: window.foregroundHandle,
      rendererAccessibilityFlag: window.rendererAccessibilityFlag,
      uiaProviderFlag: window.uiaProviderFlag,
      uiaCom: window.uiaCom?.status ? {
        comActivated: window.uiaCom.status.comActivated,
        elementFromHandleHresult: window.uiaCom.status.elementFromHandleHresult,
        rawWalkerHresult: window.uiaCom.status.rawWalkerHresult,
        rootControlTypeId: window.uiaCom.status.rootControlTypeId,
        uiaWindowRootRetrieved: window.uiaCom.status.uiaWindowRootRetrieved,
        providerDescriptionQueryHresult: window.uiaCom.status.providerDescriptionQueryHresult,
        providerDescriptionClass: window.uiaCom.status.providerDescriptionClass,
        providerClassHistogram: window.uiaCom.status.providerClassHistogram,
        legacyIAccessiblePatternQueryHresult: window.uiaCom.status.legacyIAccessiblePatternQueryHresult,
        legacyIAccessiblePatternAvailable: window.uiaCom.status.legacyIAccessiblePatternAvailable,
        legacyIAccessiblePatternNodes: window.uiaCom.status.legacyIAccessiblePatternNodes,
        composerBindingAttempted: window.uiaCom.status.composerBindingAttempted ?? false,
        composerBindingSucceeded: window.uiaCom.status.composerBindingSucceeded ?? false,
        composerEditCandidates: window.uiaCom.status.composerEditCandidates ?? 0,
        composerModelCandidates: window.uiaCom.status.composerModelCandidates ?? 0,
        composerSendCandidates: window.uiaCom.status.composerSendCandidates ?? 0,
        composerGroupDepth: window.uiaCom.status.composerGroupDepth ?? -1,
        composerGroupTypeId: window.uiaCom.status.composerGroupTypeId ?? 0,
        traversedNodes: window.uiaCom.status.traversedNodes,
        traversalTruncated: window.uiaCom.status.traversalTruncated,
        elapsedMs: window.uiaCom.status.elapsedMs,
        typeHistogram: window.uiaCom.status.typeHistogram,
      } : null,
      uiaStructureSubscription: window.uiaStructureSubscription ? {
        attempted: window.uiaStructureSubscription.attempted,
        registered: window.uiaStructureSubscription.registered,
        removed: window.uiaStructureSubscription.removed,
        scope: window.uiaStructureSubscription.scope,
        hresult: window.uiaStructureSubscription.hresult,
        errorType: window.uiaStructureSubscription.errorType,
      } : null,
      controls,
      controlTypeHistogram: histogram(window.controls),
      safeActionLabels: [...new Set(window.controls.map((control) => control.safeActionLabel).filter(Boolean))].sort(),
      childWindows: (window.childWindows ?? []).map((child) => ({
        handle: child.handle,
        parentHandle: child.parentHandle,
        sourceWindowHandle: child.sourceWindowHandle,
        processId: child.processId,
        className: child.className,
        visible: child.visible,
        enabled: child.enabled,
      })),
      msaa: window.msaa ? {
        client: summarizeStatus(window.msaa.client),
        assistive: summarizeStatus(window.msaa.assistive),
      } : null,
      rendererMsaa: (window.rendererMsaaProbes ?? []).map((probe) => ({
        handle: probe.handle,
        parentHandle: probe.parentHandle,
        sourceWindowHandle: probe.sourceWindowHandle,
        className: probe.className,
        accessible: probe.client?.accessible ?? false,
        hresult: probe.client?.hresult ?? null,
        ia2Hresult: probe.client?.ia2Hresult ?? null,
        rootRole: probe.client?.rootRole ?? null,
        traversalNodes: probe.client?.traversalNodes ?? 0,
        traversalTruncated: probe.client?.traversalTruncated ?? false,
        controlTypeHistogram: histogram(probe.controls),
      })),
      rendererUia: (window.rendererUiaProbes ?? []).map((probe) => ({
        handle: probe.handle,
        parentHandle: probe.parentHandle,
        sourceWindowHandle: probe.sourceWindowHandle,
        className: probe.className,
        visible: probe.visible,
        enabled: probe.enabled,
        probed: probe.probed,
        skipReason: probe.skipReason,
        dotNet: probe.dotNet ? {
          rootRetrieved: probe.dotNet.rootRetrieved,
          hresult: probe.dotNet.hresult,
          rootControlTypeId: probe.dotNet.rootControlTypeId,
          traversedNodes: probe.dotNet.traversedNodes,
          traversalTruncated: probe.dotNet.traversalTruncated,
          typeHistogram: probe.dotNet.typeHistogram,
        } : null,
        com: probe.com ? {
          elementFromHandleHresult: probe.com.elementFromHandleHresult,
          rootControlTypeId: probe.com.rootControlTypeId,
          traversedNodes: probe.com.traversedNodes,
          traversalTruncated: probe.com.traversalTruncated,
          typeHistogram: probe.com.typeHistogram,
        } : null,
      })),
    } : null,
    actionCapabilities: { send: false, create: false, stop: false, answer: false, approve: false },
  };
}

async function inspectWorkBuddySnapshot(selector, inspector = createWindowsUiaInspector()) {
  if (selector.readOnly === true) return projectSnapshot(await inspector.inspect(selector), selector);
  return projectSnapshot(await inspector.activateAndInspectMainWindow(selector), selector);
}

async function main(argv = process.argv.slice(2)) {
  const selector = parseArgs(argv);
  const result = await inspectWorkBuddySnapshot(selector);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (result.activation !== 'confirmed' && result.activation !== 'not-requested') process.exitCode = 2;
}

function safeCliError(error) {
  // BridgeError messages in this helper are fixed local diagnostics. Do not
  // forward arbitrary PowerShell/COM text, which could contain window data.
  return error instanceof BridgeError ? error.message : 'WorkBuddy semantic snapshot could not be verified';
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${error?.code ?? 'bridge_error'}: ${safeCliError(error)}\n`);
    process.exitCode = 2;
  });
}

module.exports = { parseArgs, projectSnapshot, inspectWorkBuddySnapshot, safeCliError, histogram };
