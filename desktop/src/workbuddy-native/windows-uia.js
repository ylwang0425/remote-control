'use strict';

const path = require('node:path');
const { promisify } = require('node:util');
const { execFile } = require('node:child_process');
const { spawn } = require('node:child_process');
const { BridgeError } = require('../errors');
const { isSessionId } = require('../protocol');

const PROTOCOL = 'workbuddy-native-uia-v1';
const HELPER_PATH = path.join(__dirname, 'windows-uia.ps1');
const DEFAULT_TIMEOUT_MS = 15000;
const MAX_OUTPUT_BYTES = 1024 * 1024;
const PROVIDER_CLASSES = new Set(['empty', 'chromium-provider', 'windows-uia-proxy', 'windows-msaa-proxy', 'win32-provider', 'other-provider']);
const PROCESS_INTEGRITY_LEVELS = new Set(['untrusted', 'low', 'medium', 'medium-plus', 'high', 'system', 'protected']);
const PROCESS_QUERY_STAGES = new Set(['', 'open-process', 'query-bitness', 'open-token', 'read-integrity-size', 'read-integrity', 'query-context']);

function safeIdentityText(value, maxLength) {
  return typeof value === 'string' && value.trim() === value && value.length >= 1 && value.length <= maxLength &&
    !/[\u0000-\u001f\u007f]/u.test(value) &&
    !/\b(?:Bearer\s+\S+|(?:api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|password|passwd|secret)\s*[:=]\s*\S+|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})/iu.test(value);
}

function validateSelector(options = {}) {
  if (options.expectedExePath !== undefined && (typeof options.expectedExePath !== 'string' ||
      !path.win32.isAbsolute(options.expectedExePath) || path.win32.basename(options.expectedExePath).toLowerCase() !== 'workbuddy.exe')) {
    throw new BridgeError('invalid_params', 'WorkBuddy UIA requires an absolute WorkBuddy.exe selector');
  }
  const maxControls = options.maxControls ?? 160;
  if (!Number.isInteger(maxControls) || maxControls < 1 || maxControls > 256) {
    throw new BridgeError('invalid_params', 'WorkBuddy UIA control bound must be between 1 and 256');
  }
  const hasProcessId = options.expectedProcessId !== undefined;
  const hasHandle = options.expectedHandle !== undefined;
  if (hasProcessId !== hasHandle || (hasProcessId && (!Number.isInteger(options.expectedProcessId) || options.expectedProcessId < 1 ||
      typeof options.expectedHandle !== 'string' || !/^\d{1,20}$/.test(options.expectedHandle)))) {
    throw new BridgeError('invalid_params', 'WorkBuddy inspection identity requires both an exact process id and main window handle');
  }
  const selector = { expectedExePath: options.expectedExePath ?? '', maxControls };
  if (hasProcessId) {
    selector.expectedProcessId = options.expectedProcessId;
    selector.expectedHandle = options.expectedHandle;
  }
  return selector;
}

function validateInspection(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.protocol !== PROTOCOL ||
      value.operation !== 'inspect' || value.readOnly !== true || !Array.isArray(value.windows) ||
      !['default', 'secure', 'other', 'unavailable'].includes(value.inputDesktopKind) ||
      typeof value.inputDesktopAccessible !== 'boolean' ||
      (value.activation !== undefined && value.activation !== null && (typeof value.activation !== 'object' ||
        !['confirmed', 'submitted', 'blocked'].includes(value.activation.outcome) ||
        !(value.activation.reason === null || ['input-desktop-not-default', 'exact-main-window-mismatch',
          'window-disappeared', 'restore-not-confirmed', 'foreground-not-confirmed'].includes(value.activation.reason)))) ||
      value.actionCapabilities?.send !== false || value.actionCapabilities?.create !== false ||
      value.actionCapabilities?.stop !== false || value.actionCapabilities?.answer !== false ||
      value.actionCapabilities?.approve !== false || !validateProcessContext(value.helperProcessContext) ||
      !Array.isArray(value.targetProcessContexts) || value.targetProcessContexts.length > 16 ||
      !value.targetProcessContexts.every(validateProcessContext)) {
    throw new BridgeError('bridge_error', 'WorkBuddy UIA helper returned an invalid read-only inspection');
  }
  for (const window of value.windows) {
    if (!window || typeof window !== 'object' || typeof window.handle !== 'string' ||
        typeof window.processId !== 'number' || typeof window.visible !== 'boolean' ||
        typeof window.enabled !== 'boolean' || !Array.isArray(window.controls) ||
        typeof window.minimized !== 'boolean' || typeof window.isForeground !== 'boolean' ||
        !(window.foregroundHandle === null || typeof window.foregroundHandle === 'string') ||
        typeof window.windowsSessionId !== 'number' || typeof window.mainWindow !== 'boolean' ||
        !(window.rendererAccessibilityFlag === null || typeof window.rendererAccessibilityFlag === 'boolean') ||
        !(window.uiaProviderFlag === null || typeof window.uiaProviderFlag === 'boolean') ||
        typeof window.titleCategory !== 'string' || typeof window.titleMatchesApp !== 'boolean' ||
        typeof window.windowClass !== 'string' || !window.rect || typeof window.rect.x !== 'number' ||
        typeof window.rect.y !== 'number' || typeof window.rect.width !== 'number' || typeof window.rect.height !== 'number' ||
        !Array.isArray(window.childWindows) || window.childWindows.length > 256 || typeof window.childWindowsTruncated !== 'boolean' ||
        !Array.isArray(window.rendererMsaaProbes) || window.rendererMsaaProbes.length > 16 ||
        !Array.isArray(window.rendererUiaProbes) || window.rendererUiaProbes.length > 16 ||
        !validateStructureSubscription(window.uiaStructureSubscription) ||
        !(window.msaa === null || (window.msaa && typeof window.msaa === 'object' &&
          validateMsaaStatus(window.msaa.client) &&
          (window.msaa.assistive === null || validateMsaaStatus(window.msaa.assistive)))) ||
        !(window.uiaCom === null || (window.uiaCom && typeof window.uiaCom === 'object' &&
          (window.uiaCom.status === null || validateUiaComStatus(window.uiaCom.status)) &&
          Array.isArray(window.uiaCom.controls) && window.uiaCom.controls.length <= 256 &&
          (window.uiaCom.errorType === undefined || typeof window.uiaCom.errorType === 'string')))) {
      throw new BridgeError('bridge_error', 'WorkBuddy UIA helper returned invalid window metadata');
    }
    for (const child of window.childWindows) {
      if (!child || typeof child !== 'object' || typeof child.handle !== 'string' || !/^\d{1,20}$/.test(child.handle) ||
          typeof child.processId !== 'number' || !Number.isInteger(child.processId) || child.processId < 0 ||
          typeof child.parentHandle !== 'string' || !/^\d{1,20}$/.test(child.parentHandle) ||
          typeof child.sourceWindowHandle !== 'string' || !/^\d{1,20}$/.test(child.sourceWindowHandle) ||
          typeof child.visible !== 'boolean' || typeof child.enabled !== 'boolean' || typeof child.className !== 'string' || child.className.length > 256 ||
          !child.rect || typeof child.rect.x !== 'number' || typeof child.rect.y !== 'number' ||
          typeof child.rect.width !== 'number' || typeof child.rect.height !== 'number') {
        throw new BridgeError('bridge_error', 'WorkBuddy UIA helper returned invalid child-window metadata');
      }
    }
    for (const probe of window.rendererMsaaProbes) {
      if (!probe || typeof probe !== 'object' || typeof probe.handle !== 'string' || !/^\d{1,20}$/.test(probe.handle) ||
          typeof probe.sourceWindowHandle !== 'string' || !/^\d{1,20}$/.test(probe.sourceWindowHandle) ||
          typeof probe.parentHandle !== 'string' || !/^\d{1,20}$/.test(probe.parentHandle) ||
          typeof probe.processId !== 'number' || typeof probe.className !== 'string' || !validateMsaaStatus(probe.client) ||
          !(probe.assistiveObject === null || validateMsaaStatus(probe.assistiveObject)) || !Array.isArray(probe.controls) || probe.controls.length > 256) {
        throw new BridgeError('bridge_error', 'WorkBuddy UIA helper returned invalid renderer MSAA metadata');
      }
      for (const control of probe.controls) validateControl(control);
    }
    for (const probe of window.rendererUiaProbes) {
      if (!probe || typeof probe !== 'object' || typeof probe.handle !== 'string' || !/^\d{1,20}$/.test(probe.handle) ||
          typeof probe.sourceWindowHandle !== 'string' || !/^\d{1,20}$/.test(probe.sourceWindowHandle) ||
          typeof probe.processId !== 'number' || !Number.isInteger(probe.processId) || probe.processId < 0 ||
          typeof probe.className !== 'string' || probe.className.length > 256 || typeof probe.visible !== 'boolean' ||
          typeof probe.enabled !== 'boolean' || typeof probe.probed !== 'boolean' ||
          !(probe.skipReason === null || ['renderer-not-visible-enabled', 'probe-budget-exhausted'].includes(probe.skipReason)) ||
          !(probe.dotNet === null || validateDotNetUiaStatus(probe.dotNet)) ||
          !(probe.com === null || validateUiaComStatus(probe.com)) ||
          (probe.probed && (!probe.visible || !probe.enabled || probe.skipReason !== null || !probe.dotNet || !probe.com)) ||
          (!probe.probed && probe.skipReason === null)) {
        throw new BridgeError('bridge_error', 'WorkBuddy UIA helper returned invalid renderer UIA metadata');
      }
    }
    if (window.controls.length > 256) throw new BridgeError('bridge_error', 'WorkBuddy UIA helper exceeded its control bound');
    for (const control of window.controls) validateControl(control);
  }
  return value;
}

function validateControl(control) {
  if (!control || typeof control !== 'object' || typeof control.controlType !== 'string' ||
      typeof control.enabled !== 'boolean' || typeof control.selected !== 'boolean' ||
      typeof control.selectedItemLabel !== 'string' || typeof control.safeActionLabel !== 'string' ||
      typeof control.accessibleName !== 'string' || typeof control.runtimeIdHash !== 'string' ||
      (control.runtimeIdHash !== '' && !/^[a-f0-9]{16}$/.test(control.runtimeIdHash)) ||
      (control.structuralPathHash !== undefined && !/^[a-f0-9]{16}$/.test(control.structuralPathHash)) ||
      !['unavailable', 'empty', 'non-empty'].includes(control.draftState) ||
      typeof control.draftFingerprint !== 'string' || !/^(?:|[a-f0-9]{16})$/.test(control.draftFingerprint) ||
      !Array.isArray(control.patterns) || control.patterns.some((pattern) => typeof pattern !== 'string') ||
      (control.expandCollapseState !== undefined && ![-1, 0, 1].includes(control.expandCollapseState)) ||
      (control.regionHash !== undefined && !/^[a-f0-9]{16}$/.test(control.regionHash)) ||
      (control.passwordProtected !== undefined && typeof control.passwordProtected !== 'boolean') ||
      (control.rect !== undefined && control.rect !== null && !validateControlRect(control.rect)) ||
      (control.sourceWindowHandle !== undefined && (typeof control.sourceWindowHandle !== 'string' || !/^\d{1,20}$/.test(control.sourceWindowHandle)))) {
    throw new BridgeError('bridge_error', 'WorkBuddy UIA helper returned invalid control metadata');
  }
  return true;
}

function validateControlRect(rect) {
  return Boolean(rect && typeof rect === 'object' &&
    ['x', 'y', 'width', 'height'].every((key) => Number.isInteger(rect[key]) && Math.abs(rect[key]) <= 100000) &&
    rect.width >= 0 && rect.height >= 0);
}

function validateProcessContext(context) {
  return Boolean(context && typeof context === 'object' && Number.isInteger(context.processId) && context.processId > 0 &&
    Number.isInteger(context.windowsSessionId) && context.windowsSessionId >= 0 && typeof context.is64BitOperatingSystem === 'boolean' &&
    (context.is64BitProcess === null || typeof context.is64BitProcess === 'boolean') &&
    (context.isWow64Process === null || typeof context.isWow64Process === 'boolean') &&
    (context.integrityLevel === null || PROCESS_INTEGRITY_LEVELS.has(context.integrityLevel)) &&
    (context.integrityRid === null || (Number.isInteger(context.integrityRid) && context.integrityRid >= 0 && context.integrityRid <= 0x7fffffff)) &&
    Number.isInteger(context.queryHresult) && PROCESS_QUERY_STAGES.has(context.errorStage));
}

function validateStructureSubscription(value) {
  return Boolean(value && typeof value === 'object' && typeof value.attempted === 'boolean' &&
    typeof value.registered === 'boolean' && typeof value.removed === 'boolean' &&
    ['subtree', 'not-selected'].includes(value.scope) && Number.isInteger(value.hresult) &&
    (value.errorType === null || (typeof value.errorType === 'string' && /^[A-Za-z][A-Za-z0-9.]{0,80}$/.test(value.errorType))) &&
    (!value.registered || (value.attempted && value.scope === 'subtree')) &&
    (!value.removed || value.registered));
}

function validateMsaaStatus(status) {
  if (!status || typeof status !== 'object' || typeof status.objectId !== 'number' ||
      typeof status.accessible !== 'boolean' || !Number.isInteger(status.childCount) || status.childCount < 0 ||
      typeof status.rootRole !== 'number' || typeof status.hresult !== 'number' ||
      !(status.ia2Hresult === null || typeof status.ia2Hresult === 'number') ||
      !['not-attempted', 'query-interface'].includes(status.ia2Stage) || typeof status.ia2Accessible !== 'boolean' ||
      !['acquire-accessible', 'read-root-properties', 'walk-accessible-tree', 'complete'].includes(status.stage) ||
      typeof status.rootType !== 'string' || status.rootType.length > 128 ||
      !Number.isInteger(status.traversalNodes) || status.traversalNodes < 0 || status.traversalNodes > 2000 ||
      typeof status.traversalTruncated !== 'boolean' || !Number.isInteger(status.elapsedMs) || status.elapsedMs < 0 || status.elapsedMs > 10000 ||
      typeof status.childError !== 'string' || !Array.isArray(status.trace) || status.trace.length > 32) {
    return false;
  }
  return status.trace.every((item) => item && typeof item === 'object' && Number.isInteger(item.depth) && item.depth >= 0 && item.depth <= 32 &&
    Number.isInteger(item.childId) && item.childId >= 0 && typeof item.role === 'number' &&
    Number.isInteger(item.childCount) && item.childCount >= 0 && typeof item.objectType === 'string' && item.objectType.length <= 128);
}

function validateUiaComStatus(status) {
  if (!status || typeof status !== 'object' || typeof status.comActivated !== 'boolean' ||
      typeof status.activationHresult !== 'number' || typeof status.elementFromHandleHresult !== 'number' ||
      typeof status.rawWalkerHresult !== 'number' || typeof status.rootControlTypeId !== 'number' ||
      typeof status.uiaWindowRootRetrieved !== 'boolean' || typeof status.providerDescriptionQueryHresult !== 'number' ||
      !PROVIDER_CLASSES.has(status.providerDescriptionClass) || !Number.isInteger(status.providerClassQueryCount) ||
      status.providerClassQueryCount < 0 || !Number.isInteger(status.legacyIAccessiblePatternQueryHresult) ||
      typeof status.legacyIAccessiblePatternAvailable !== 'boolean' || !Number.isInteger(status.legacyIAccessiblePatternNodes) ||
      status.legacyIAccessiblePatternNodes < 0 || !Array.isArray(status.providerClassHistogram) || status.providerClassHistogram.length > 16 ||
      status.providerClassHistogram.some((value) => typeof value !== 'string' || !/^(?:empty|chromium-provider|windows-uia-proxy|windows-msaa-proxy|win32-provider|other-provider):\d{1,5}$/.test(value)) ||
      !Number.isInteger(status.traversedNodes) || status.traversedNodes < 0 || status.traversedNodes > 5000 ||
      typeof status.traversalTruncated !== 'boolean' || !Number.isInteger(status.elapsedMs) || status.elapsedMs < 0 ||
      status.elapsedMs > 10000 || !(status.errorType === null || (typeof status.errorType === 'string' && /^[A-Za-z][A-Za-z0-9.]{0,80}$/.test(status.errorType))) ||
      !(status.errorStage === '' || ['activate-com', 'element-from-handle', 'raw-view-walker'].includes(status.errorStage)) || !Array.isArray(status.typeHistogram) ||
      status.typeHistogram.length > 128 || status.typeHistogram.some((value) => typeof value !== 'string' || !/^\d{1,6}:\d{1,5}$/.test(value))) {
    return false;
  }
  if (status.composerBindingAttempted !== undefined && (typeof status.composerBindingAttempted !== 'boolean' ||
      typeof status.composerBindingSucceeded !== 'boolean' ||
      !['composerEditCandidates', 'composerModelCandidates', 'composerSendCandidates'].every((key) => Number.isInteger(status[key]) && status[key] >= 0 && status[key] <= 256) ||
      !Number.isInteger(status.composerGroupDepth) || status.composerGroupDepth < -1 || status.composerGroupDepth > 32 ||
      !Number.isInteger(status.composerGroupTypeId) || status.composerGroupTypeId < 0 || status.composerGroupTypeId > 50100)) return false;
  return true;
}

function validateSemanticSnapshot(value, selector, { requireReadOnly = true } = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.protocol !== PROTOCOL ||
      value.operation !== 'semantic-snapshot' || value.readOnly !== requireReadOnly || !['default', 'secure', 'other', 'unavailable'].includes(value.inputDesktopKind) ||
      !value.target || typeof value.target !== 'object' || value.target.handle !== selector.expectedHandle ||
      value.target.processId !== selector.expectedProcessId || value.target.mainWindow !== true ||
      !['visible', 'enabled', 'minimized', 'isForeground'].every((key) => typeof value.target[key] === 'boolean') ||
      !(value.target.foregroundHandle === null || (typeof value.target.foregroundHandle === 'string' && /^\d{1,20}$/.test(value.target.foregroundHandle))) ||
      !value.processContext || typeof value.processContext !== 'object' ||
      !['sameWindowsSession', 'sameBitness', 'sameIntegrityLevel'].every((key) => typeof value.processContext[key] === 'boolean') ||
      !validateProcessContext(value.processContext.helper) || !validateProcessContext(value.processContext.target) ||
      value.processContext.helper.processId <= 0 || value.processContext.target.processId !== selector.expectedProcessId ||
      !validateUiaComStatus(value.uiaCom) || !Array.isArray(value.controls) || value.controls.length > 256 ||
      (value.newTaskPageProof !== undefined && value.newTaskPageProof !== null && !validateNewTaskPageProof(value.newTaskPageProof)) ||
      (value.activation !== null && (!value.activation || !['confirmed', 'submitted', 'blocked'].includes(value.activation.outcome) ||
        !(value.activation.reason === null || ['input-desktop-not-default', 'exact-main-window-mismatch', 'window-disappeared', 'restore-not-confirmed', 'foreground-not-confirmed'].includes(value.activation.reason))))) {
    throw new BridgeError('bridge_error', 'WorkBuddy semantic UI Automation snapshot is invalid');
  }
  for (const control of value.controls) validateControl(control);
  if (value.activation?.outcome === 'confirmed' && (value.inputDesktopKind !== 'default' || !value.target.visible ||
      !value.target.enabled || value.target.minimized || !value.target.isForeground || value.target.foregroundHandle !== value.target.handle)) {
    throw new BridgeError('bridge_error', 'WorkBuddy semantic snapshot confirmed an unverified foreground window');
  }
  return value;
}

function validateNewTaskPageProof(proof) {
  const integerFields = ['selectedNewTaskTabCount', 'selectedConversationTabMatches', 'conversationHeaderMatches',
    'visibleWelcomeMarkerMatches', 'composerDocumentWelcomeMarkerMatches', 'homePageAncestorMatches',
    'homeComposerAncestorMatches', 'homeRouteInputAncestorMatches'];
  const hasDocumentTextSamples = Object.prototype.hasOwnProperty.call(proof ?? {}, 'composerDocumentTextSamples') ||
    Object.prototype.hasOwnProperty.call(proof ?? {}, 'composerDocumentTextSampleCount');
  const hasComposerAncestors = Object.prototype.hasOwnProperty.call(proof ?? {}, 'composerAncestors') ||
    Object.prototype.hasOwnProperty.call(proof ?? {}, 'composerAncestorCount');
  const credentialText = /(?:Bearer\s+(?!\[REDACTED\])\S+|(?:api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|password|passwd|secret)\s*[:=]\s*(?!\[REDACTED\])\S+)/iu;
  const classTokenCount = (token) => Array.isArray(proof?.composerAncestors)
    ? proof.composerAncestors.filter((node) => typeof node?.className === 'string' &&
      node.className.split(/[\t ]+/u).includes(token)).length : 0;
  if (!proof || typeof proof !== 'object' || Array.isArray(proof) || typeof proof.snapshotComplete !== 'boolean' ||
      typeof proof.verified !== 'boolean' || !integerFields.every((key) => Number.isInteger(proof[key]) && proof[key] >= 0 && proof[key] <= 5000) ||
      ['homePageAncestorMatches', 'homeComposerAncestorMatches', 'homeRouteInputAncestorMatches']
        .some((key) => proof[key] > 8) ||
      !(proof.composerDocumentRegionHash === '' || /^[a-f0-9]{16}$/.test(proof.composerDocumentRegionHash)) ||
      (hasDocumentTextSamples && (!Number.isInteger(proof.composerDocumentTextSampleCount) || proof.composerDocumentTextSampleCount < 0 ||
        proof.composerDocumentTextSampleCount > 8 || !Array.isArray(proof.composerDocumentTextSamples) ||
        proof.composerDocumentTextSamples.length !== proof.composerDocumentTextSampleCount ||
        proof.composerDocumentTextSamples.some((text) => typeof text !== 'string' || text.length > 240 ||
          /[\r\n\p{Cc}]/u.test(text) || credentialText.test(text)))) ||
      (hasComposerAncestors && (!Number.isInteger(proof.composerAncestorCount) || proof.composerAncestorCount < 0 ||
        proof.composerAncestorCount > 8 || !Array.isArray(proof.composerAncestors) ||
        proof.composerAncestors.length !== proof.composerAncestorCount || proof.composerAncestors.some((node) =>
          !node || typeof node !== 'object' || Array.isArray(node) ||
          !Number.isInteger(node.depth) || node.depth < 1 || node.depth > 256 ||
          !Number.isInteger(node.controlTypeId) || node.controlTypeId < 0 || node.controlTypeId > 100000 ||
          !['accessibleName', 'automationId', 'className', 'ariaRole'].every((key) => typeof node[key] === 'string' &&
            node[key].length <= (key === 'ariaRole' ? 80 : 256) && !/[\r\n\p{Cc}]/u.test(node[key]) && !credentialText.test(node[key])) ||
          typeof node.pathHash !== 'string' || !/^[a-f0-9]{16}$/.test(node.pathHash) ||
          !(node.runtimeIdHash === '' || /^[a-f0-9]{16}$/.test(node.runtimeIdHash)) ||
          !(node.regionHash === '' || /^[a-f0-9]{16}$/.test(node.regionHash))))) ||
      (proof.verified && (!proof.snapshotComplete || proof.selectedNewTaskTabCount !== 1 || proof.selectedConversationTabMatches !== 0 ||
        proof.conversationHeaderMatches !== 0 || proof.composerDocumentRegionHash.length !== 16 || !hasComposerAncestors ||
        proof.composerAncestorCount < 4 || proof.composerAncestorCount > 8 || proof.homePageAncestorMatches !== 1 ||
        proof.homeComposerAncestorMatches !== 1 || proof.homeRouteInputAncestorMatches !== 1 ||
        classTokenCount('wb-home-page') !== 1 || classTokenCount('wb-home-composer') !== 1 ||
        classTokenCount('wb-home-route__input-wrap') !== 1 || proof.composerAncestors[0].controlTypeId !== 50030 ||
        proof.composerAncestors[0].ariaRole !== 'document' ||
        proof.composerAncestors.at(-1).controlTypeId !== 50004 || proof.composerAncestors.at(-1).ariaRole !== 'textbox'))) return false;
  return true;
}

const ACTIONS_BY_LABEL = Object.freeze({
  'set-value': new Set(['composer']),
  invoke: new Set(['send-label', 'stop-label', 'answer-label', 'allow-once-label', 'reject-label']),
  expand: new Set(['model-selector', 'workspace-selector']),
  collapse: new Set(['model-selector', 'workspace-selector']),
  select: new Set(['model-option', 'workspace-option', 'new-task-tab']),
});

const IDENTITY_ACTION_LABELS = new Set(['composer', 'send-label', 'stop-label', 'answer-label', 'allow-once-label', 'reject-label', 'model-option', 'workspace-option']);

function validateSemanticAction(value, selector, { requiresConversationIdentity = false, requireNewTaskIntent = false,
  requireNewTaskNavigation = false } = {}) {
  const navigationSources = new Set(['', 'empty-composer', 'skills', 'projects']);
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.protocol !== PROTOCOL ||
      value.operation !== 'semantic-action' || value.readOnly !== false || value.inputDesktopKind !== 'default' ||
      !value.target || value.target.processId !== selector.expectedProcessId || value.target.handle !== selector.expectedHandle ||
      value.target.mainWindow !== true || value.target.visible !== true || value.target.enabled !== true ||
      value.target.minimized !== false || typeof value.target.isForeground !== 'boolean' ||
      !(value.target.foregroundHandle === null || (typeof value.target.foregroundHandle === 'string' && /^\d{1,20}$/.test(value.target.foregroundHandle))) ||
      typeof value.targetContextVerified !== 'boolean' ||
      !value.processContext || !validateProcessContext(value.processContext.helper) || !validateProcessContext(value.processContext.target) ||
      value.processContext.target.processId !== selector.expectedProcessId || !value.processContext.sameWindowsSession ||
      !value.processContext.sameBitness || !value.processContext.sameIntegrityLevel || !validateUiaComStatus(value.uiaCom) ||
      !Array.isArray(value.controls) || value.controls.length > 256 || !value.actionResult ||
      typeof value.actionResult.attempted !== 'boolean' || typeof value.actionResult.submitted !== 'boolean' ||
      typeof value.actionResult.conversationIdentityVerified !== 'boolean' || typeof value.actionResult.targetContextVerified !== 'boolean' ||
      typeof value.actionResult.newTaskIntentVerified !== 'boolean' || typeof value.actionResult.foregroundVerified !== 'boolean' ||
      (value.actionResult.newTaskNavigationSource !== undefined && !navigationSources.has(value.actionResult.newTaskNavigationSource)) ||
      !Number.isInteger(value.actionResult.hresult) || !['validate', 'fresh-tree', 'unique-runtime-target', 'target-state',
        'conversation-identity', 'foreground-precondition', 'target-context-precondition', 'helper-budget-expired',
        'new-task-intent-precondition', 'draft-precondition', 'invoke-pattern', 'expand-collapse-pattern', 'selection-pattern', 'state-precondition',
        'pattern-call', 'submitted'].includes(value.actionResult.stage) ||
      !Number.isInteger(value.actionResult.matchingControls) || value.actionResult.matchingControls < 0 || value.actionResult.matchingControls > 256 ||
      (value.actionResult.submitted && (!value.actionResult.attempted || value.actionResult.matchingControls !== 1 ||
        value.actionResult.hresult < 0 || value.actionResult.stage !== 'submitted' || !value.targetContextVerified ||
        !value.actionResult.targetContextVerified ||
        (requiresConversationIdentity && !value.actionResult.conversationIdentityVerified) ||
        (requireNewTaskIntent && !value.actionResult.newTaskIntentVerified) ||
        (requireNewTaskNavigation && !navigationSources.has(value.actionResult.newTaskNavigationSource) ||
          requireNewTaskNavigation && value.actionResult.newTaskNavigationSource === '')))) {
    throw new BridgeError('bridge_error', 'WorkBuddy UI Automation action returned an invalid receipt');
  }
  for (const control of value.controls) validateControl(control);
  return value;
}

function validateConversationIdentitySnapshot(value, selector, anchorCount) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.protocol !== PROTOCOL ||
      value.operation !== 'semantic-identity' || value.readOnly !== false || value.inputDesktopKind !== 'default' ||
      !value.target || value.target.processId !== selector.expectedProcessId || value.target.handle !== selector.expectedHandle ||
      value.target.mainWindow !== true || value.target.visible !== true || value.target.enabled !== true ||
      value.target.minimized !== false || typeof value.target.isForeground !== 'boolean' ||
      !(value.target.foregroundHandle === null || (typeof value.target.foregroundHandle === 'string' && /^\d{1,20}$/.test(value.target.foregroundHandle))) ||
      value.targetContextVerified !== true ||
      !value.processContext || value.processContext.sameWindowsSession !== true || value.processContext.sameBitness !== true ||
      value.processContext.sameIntegrityLevel !== true || !value.activation || value.activation.outcome !== 'confirmed' ||
      value.activation.reason !== null || !value.identityProof ||
      !Number.isInteger(value.identityProof.conversationRowMatches) || value.identityProof.conversationRowMatches < 0 || value.identityProof.conversationRowMatches > 256 ||
      !Number.isInteger(value.identityProof.conversationHeaderMatches) || value.identityProof.conversationHeaderMatches < 0 || value.identityProof.conversationHeaderMatches > 256 ||
      !Number.isInteger(value.identityProof.candidateCount) || value.identityProof.candidateCount !== anchorCount ||
      !Number.isInteger(value.identityProof.matchedCandidateIndex) || value.identityProof.matchedCandidateIndex < -1 ||
      value.identityProof.matchedCandidateIndex >= anchorCount) {
    throw new BridgeError('bridge_error', 'WorkBuddy native conversation identity response is invalid');
  }
  if (value.identityProof.conversationHeaderMatches !== 1 ||
      value.identityProof.matchedCandidateIndex < 0) {
    throw new BridgeError('not_capable', 'WorkBuddy native conversation identity is ambiguous or unavailable');
  }
  return value;
}

function validateNativeConversationNavigation(value, selector, anchorCount, expectedCandidateIndex) {
  const target = value?.target;
  const identity = value?.identityProof;
  const context = value?.processContext;
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.protocol !== PROTOCOL ||
      value.operation !== 'navigate-conversation' || value.readOnly !== false || value.inputDesktopKind !== 'default' ||
      !['confirmed', 'submitted', 'blocked'].includes(value.outcome) ||
      !(value.reason === null || ['native-page-not-confirmed', 'identity-mismatch'].includes(value.reason)) ||
      typeof value.routeSubmitted !== 'boolean' || value.targetContextVerified !== true ||
      !target || target.processId !== selector.expectedProcessId || target.handle !== selector.expectedHandle ||
      target.mainWindow !== true || target.visible !== true || target.enabled !== true || target.minimized !== false ||
      typeof target.isForeground !== 'boolean' ||
      !(target.foregroundHandle === null || (typeof target.foregroundHandle === 'string' && /^\d{1,20}$/.test(target.foregroundHandle))) ||
      !context || context.sameWindowsSession !== true || context.sameBitness !== true || context.sameIntegrityLevel !== true ||
      !identity || !Number.isInteger(identity.conversationRowMatches) || identity.conversationRowMatches < 0 || identity.conversationRowMatches > 256 ||
      !Number.isInteger(identity.conversationHeaderMatches) || identity.conversationHeaderMatches < 0 || identity.conversationHeaderMatches > 256 ||
      identity.candidateCount !== anchorCount || identity.matchedCandidateIndex !== expectedCandidateIndex) {
    throw new BridgeError('bridge_error', 'WorkBuddy native conversation route returned an invalid receipt');
  }
  if (value.outcome === 'confirmed' && (value.reason !== null ||
      identity.conversationHeaderMatches !== 1 || identity.matchedCandidateIndex < 0)) {
    throw new BridgeError('bridge_error', 'WorkBuddy native conversation route could not confirm its exact destination');
  }
  if (value.outcome === 'submitted' && (!value.routeSubmitted || value.reason !== 'native-page-not-confirmed')) {
    throw new BridgeError('bridge_error', 'WorkBuddy native conversation route returned an invalid submitted receipt');
  }
  if (value.outcome === 'blocked' && (value.routeSubmitted || value.reason !== 'identity-mismatch')) {
    throw new BridgeError('bridge_error', 'WorkBuddy native conversation route returned an invalid blocked receipt');
  }
  return value;
}

function validateNativeModelCatalog(value, selector) {
  const target = value?.target;
  const context = value?.processContext;
  const catalog = value?.catalog;
  const safeModels = Array.isArray(catalog?.models) && catalog.models.length <= 100 &&
    catalog.models.every((model) => safeIdentityText(model, 180));
  const safeCurrentModel = typeof catalog?.currentModel === 'string' &&
    (catalog.currentModel === '' || safeIdentityText(catalog.currentModel, 180));
  const safeDraftFingerprint = (fingerprint) => typeof fingerprint === 'string' &&
    (fingerprint === '' || /^[a-f0-9]{16}$/.test(fingerprint));
  const receipts = catalog?.patternReceipts;
  const validReceipts = Array.isArray(receipts) && receipts.length <= 2 &&
    receipts.every((receipt) => receipt && typeof receipt === 'object' &&
      ['expand', 'collapse'].includes(receipt.operation) && typeof receipt.attempted === 'boolean' &&
      typeof receipt.submitted === 'boolean' && typeof receipt.targetContextVerified === 'boolean' &&
      typeof receipt.foregroundVerified === 'boolean' &&
      Number.isInteger(receipt.hresult) && Number.isInteger(receipt.matchingControls) && receipt.matchingControls >= 0 &&
      receipt.matchingControls <= 256 && typeof receipt.stage === 'string');
  const modelMenu = catalog?.modelMenu;
  const allowedMenuAssociations = new Set([
    'unavailable', 'no-new-visible-native-list', 'ambiguous-new-visible-native-lists',
    'unique-new-popup-selected-current-model', 'unique-new-popup-without-selected-current-model-proof',
    'unique-associated-visible-popup-selected-current-model',
    'popup-subtree-exceeds-diagnostic-bound',
  ]);
  const safeMenuDiagnostic = modelMenu && typeof modelMenu === 'object' && !Array.isArray(modelMenu) &&
    allowedMenuAssociations.has(modelMenu.association) &&
    Number.isInteger(modelMenu.newVisiblePopupRootCount) && modelMenu.newVisiblePopupRootCount >= 0 &&
    modelMenu.newVisiblePopupRootCount <= 32 &&
    Number.isInteger(modelMenu.selectedCurrentModelCount) && modelMenu.selectedCurrentModelCount >= 0 &&
    modelMenu.selectedCurrentModelCount <= 128 && Array.isArray(modelMenu.controls) && modelMenu.controls.length <= 128 &&
    modelMenu.controls.every((control) => control && typeof control === 'object' && !Array.isArray(control) &&
      Number.isInteger(control.depthWithinPopup) && control.depthWithinPopup >= 0 && control.depthWithinPopup <= 8 &&
      typeof control.controlType === 'string' && /^ControlType\.[A-Za-z]+$/.test(control.controlType) &&
      Number.isInteger(control.controlTypeId) && control.controlTypeId >= 0 && control.controlTypeId <= 65535 &&
      typeof control.accessibleName === 'string' && (control.accessibleName === '' || safeIdentityText(control.accessibleName, 180)) &&
      typeof control.enabled === 'boolean' && typeof control.offscreen === 'boolean' &&
      typeof control.selected === 'boolean' && typeof control.passwordProtected === 'boolean' &&
      Array.isArray(control.patterns) && control.patterns.length <= 5 &&
      control.patterns.every((pattern) => ['invoke', 'value', 'expandCollapse', 'selectionItem', 'toggle'].includes(pattern)) &&
      new Set(control.patterns).size === control.patterns.length &&
      /^[a-f0-9]{16}$/.test(control.pathHash) &&
      (control.runtimeIdHash === '' || /^[a-f0-9]{16}$/.test(control.runtimeIdHash)) &&
      /^[a-f0-9]{16}$/.test(control.regionHash) &&
      (!control.passwordProtected || (control.accessibleName === '' && control.patterns.length === 0)));
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.protocol !== PROTOCOL ||
      value.operation !== 'native-model-catalog' || value.readOnly !== false ||
      !['confirmed', 'submitted', 'blocked'].includes(value.outcome) ||
      !(value.outcome === 'confirmed' ? (value.reason === null || value.reason === '') :
        (typeof value.reason === 'string' && /^[a-z0-9-]{1,80}$/.test(value.reason))) ||
      value.inputDesktopKind !== 'default' || typeof value.targetContextVerified !== 'boolean' || !target || !Number.isInteger(target.processId) || target.processId < 1 ||
      typeof target.handle !== 'string' || !/^\d{1,20}$/.test(target.handle) ||
      (selector.expectedProcessId !== undefined && target.processId !== selector.expectedProcessId) ||
      (selector.expectedHandle !== undefined && target.handle !== selector.expectedHandle) || typeof target.mainWindow !== 'boolean' ||
      typeof target.visible !== 'boolean' || typeof target.enabled !== 'boolean' || typeof target.minimized !== 'boolean' || typeof target.isForeground !== 'boolean' ||
      !(target.foregroundHandle === null || (typeof target.foregroundHandle === 'string' && /^\d{1,20}$/.test(target.foregroundHandle))) || !context ||
      !validateProcessContext(context.helper) || !validateProcessContext(context.target) ||
      context.target.processId !== target.processId || context.sameWindowsSession !== true ||
      context.sameBitness !== true || context.sameIntegrityLevel !== true || !catalog ||
      !safeCurrentModel || !safeModels || !safeDraftFingerprint(catalog.initialDraftFingerprint) || !safeDraftFingerprint(catalog.finalDraftFingerprint) ||
      typeof catalog.composerVerified !== 'boolean' || typeof catalog.targetContextVerified !== 'boolean' ||
      catalog.targetContextVerified !== value.targetContextVerified ||
      typeof catalog.initiallyExpanded !== 'boolean' ||
      typeof catalog.finallyExpanded !== 'boolean' || !validReceipts || !safeMenuDiagnostic) {
    throw new BridgeError('bridge_error', 'WorkBuddy native model catalog returned an invalid receipt');
  }
  if (value.outcome === 'confirmed' && (target.mainWindow !== true || target.visible !== true || target.enabled !== true || target.minimized !== false ||
      !value.targetContextVerified || !catalog.targetContextVerified || !catalog.composerVerified ||
      !/^[a-f0-9]{16}$/.test(catalog.initialDraftFingerprint) || !/^[a-f0-9]{16}$/.test(catalog.finalDraftFingerprint) ||
      !safeIdentityText(catalog.currentModel, 180))) {
    throw new BridgeError('bridge_error', 'WorkBuddy native model catalog could not confirm its exact target and composer');
  }
  if (value.outcome === 'blocked') {
    // A failed catalog read may still be a safe result after the helper opened
    // and closed the native list, but only when both transitions were accepted
    // and the fresh final tree proves the original selector and draft state.
    if (receipts.length > 0) {
      const restoredReadOnlyExpansion = !catalog.initiallyExpanded && !catalog.finallyExpanded &&
        value.targetContextVerified && catalog.targetContextVerified && catalog.composerVerified &&
        /^[a-f0-9]{16}$/.test(catalog.initialDraftFingerprint) &&
        catalog.finalDraftFingerprint === catalog.initialDraftFingerprint &&
        receipts.length === 2 && receipts[0].operation === 'expand' && receipts[1].operation === 'collapse' &&
        receipts.every((receipt) => receipt.attempted && receipt.submitted && receipt.targetContextVerified &&
          receipt.hresult >= 0 && receipt.stage === 'submitted' && receipt.matchingControls === 1);
      if (!restoredReadOnlyExpansion) {
        throw new BridgeError('bridge_error', 'WorkBuddy blocked model catalog could not prove a restored native UI state');
      }
    }
    return value;
  }
  if (value.outcome === 'submitted' && !receipts.some((receipt) => receipt.attempted || receipt.submitted)) {
    throw new BridgeError('bridge_error', 'WorkBuddy submitted model catalog has no native pattern receipt');
  }
  if (value.outcome === 'confirmed') {
    const uniqueModels = new Set(catalog.models);
    const expectedReceiptOps = catalog.initiallyExpanded ? [] : ['expand', 'collapse'];
    if (!catalog.composerVerified || catalog.models.length === 0 || uniqueModels.size !== catalog.models.length ||
        !uniqueModels.has(catalog.currentModel) || catalog.finalDraftFingerprint !== catalog.initialDraftFingerprint ||
        catalog.finallyExpanded !== catalog.initiallyExpanded || receipts.length !== expectedReceiptOps.length ||
        !value.targetContextVerified || !catalog.targetContextVerified ||
        receipts.some((receipt, index) => receipt.operation !== expectedReceiptOps[index] || !receipt.attempted ||
          !receipt.submitted || !receipt.targetContextVerified || receipt.hresult < 0 || receipt.stage !== 'submitted' ||
          receipt.matchingControls !== 1)) {
      throw new BridgeError('bridge_error', 'WorkBuddy native model catalog could not confirm a read-only, draft-preserving result');
    }
  }
  return value;
}

function validateMainWindowDiscovery(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.protocol !== PROTOCOL ||
      value.operation !== 'discover-main-windows' || value.readOnly !== true ||
      !['default', 'secure', 'other', 'unavailable'].includes(value.inputDesktopKind) ||
      !Array.isArray(value.windows) || value.windows.length > 32 ||
      !value.windows.every((window) => window && typeof window === 'object' && Number.isInteger(window.processId) && window.processId > 0 &&
        typeof window.handle === 'string' && /^\d{1,20}$/.test(window.handle) && typeof window.visible === 'boolean' &&
        typeof window.enabled === 'boolean' && typeof window.minimized === 'boolean' && typeof window.isForeground === 'boolean' &&
        (window.foregroundHandle === null || (typeof window.foregroundHandle === 'string' && /^\d{1,20}$/.test(window.foregroundHandle))) &&
        window.mainWindow === true)) {
    throw new BridgeError('bridge_error', 'WorkBuddy native window discovery returned invalid metadata');
  }
  return value;
}

function validateDotNetUiaStatus(status) {
  if (!status || typeof status !== 'object' || typeof status.rootRetrieved !== 'boolean' ||
      typeof status.hresult !== 'number' || typeof status.rootControlTypeId !== 'number' ||
      !Number.isInteger(status.traversedNodes) || status.traversedNodes < 0 || status.traversedNodes > 2000 ||
      typeof status.traversalTruncated !== 'boolean' || !Number.isInteger(status.elapsedMs) || status.elapsedMs < 0 ||
      status.elapsedMs > 10000 || !(status.errorType === null || (typeof status.errorType === 'string' && /^[A-Za-z][A-Za-z0-9.]{0,80}$/.test(status.errorType))) ||
      !Array.isArray(status.typeHistogram) || status.typeHistogram.length > 128 ||
      status.typeHistogram.some((value) => typeof value !== 'string' || !/^\d{1,6}:\d{1,5}$/.test(value))) {
    return false;
  }
  return true;
}

function createWindowsUiaInspector(options = {}) {
  const platform = options.platform ?? process.platform;
  const powershellPath = options.powershellPath ?? 'powershell.exe';
  const helperPath = options.helperPath ?? HELPER_PATH;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const exec = options.execFileImpl ?? promisify(execFile);
  const spawnProcess = options.spawnImpl ?? spawn;
  const onHelperDiagnostic = typeof options.onHelperDiagnostic === 'function' ? options.onHelperDiagnostic : null;

  function captureFixedHelperDiagnostic(stdoutChunks, exitCode) {
    const diagnostic = { exitCode: Number.isInteger(exitCode) ? exitCode : null,
      stage: 'native-helper-process-exit', failureType: 'Unknown' };
    try {
      const decoded = JSON.parse(Buffer.concat(stdoutChunks).toString('utf8').trim());
      const validStages = new Set(['request', 'load-uia', 'load-accessibility-assembly', 'compile-msaa-probe', 'compile-uia-com-probe',
        'request-read-stdin', 'request-parse-json', 'request-budget', 'request-protocol', 'request-control-bound',
        'enumerate-windows', 'semantic-target-check', 'read-native-model-catalog', 'verify-native-model-catalog-target',
        'validate-semantic-action', 'semantic-action-fresh-observation', 'semantic-action-single-pattern',
        'semantic-action-post-observation', 'validate-native-conversation-route', 'native-navigation-precondition',
        'verify-workbuddy-public-protocol-registration', 'submit-workbuddy-public-conversation-uri',
        'verify-native-conversation-after-route', 'validate-native-conversation-identity', 'read-native-conversation-identity']);
      if (decoded && decoded.error === 'inspection_failed' && validStages.has(decoded.stage) &&
          typeof decoded.failureType === 'string' && /^[A-Za-z][A-Za-z0-9.]{0,80}$/.test(decoded.failureType)) {
        diagnostic.stage = decoded.stage;
        diagnostic.failureType = decoded.failureType;
      }
    } catch { /* return the fixed unknown-stage record */ }
    return diagnostic;
  }

  function helperBudget(hooks) {
    hooks?.checkActive?.();
    const remaining = hooks?.remainingBudgetMs?.();
    if (remaining === undefined) return Math.min(DEFAULT_TIMEOUT_MS, timeoutMs);
    if (!Number.isFinite(remaining) || remaining <= 0) {
      hooks?.checkActive?.();
      throw new BridgeError('bridge_timeout', 'WorkBuddy native control request expired before UI Automation');
    }
    return Math.max(1, Math.min(DEFAULT_TIMEOUT_MS, timeoutMs, Math.floor(remaining)));
  }

  function nativeContext(options, { allowNewTask = false } = {}) {
    const selector = validateSelector(options);
    const hasIdentity = options.identityTitle !== undefined;
    if (!selector.expectedExePath || !Number.isInteger(selector.expectedProcessId) || selector.expectedProcessId < 1 ||
        !/^\d{1,20}$/.test(selector.expectedHandle ?? '') ||
        (hasIdentity ? !safeIdentityText(options.identityTitle, 180) || !Array.isArray(options.anchorCandidates) ||
          options.anchorCandidates.length < 1 || options.anchorCandidates.length > 64 ||
          !options.anchorCandidates.every(a => Array.isArray(a) && a.length <= 3 && a.every(v => safeIdentityText(v, 120))) ||
          !Number.isInteger(options.expectedCandidateIndex) || options.expectedCandidateIndex < 0 || options.expectedCandidateIndex >= options.anchorCandidates.length
          : !allowNewTask || !Array.isArray(options.knownConversationTitles) || options.knownConversationTitles.length > 200 ||
            !options.knownConversationTitles.every(v => safeIdentityText(v, 180)))) {
      throw new BridgeError('invalid_params', 'WorkBuddy requires an exact current native conversation or New Task context');
    }
    return { ...selector, ...(hasIdentity ? { identityTitle: options.identityTitle, anchorCandidates: options.anchorCandidates,
      expectedCandidateIndex: options.expectedCandidateIndex } : { knownConversationTitles: options.knownConversationTitles }) };
  }

  function checkNativeReceiptTarget(decoded, context, operation) {
    if (decoded?.protocol !== PROTOCOL || decoded.operation !== operation ||
        decoded.target?.processId !== context.expectedProcessId || decoded.target?.handle !== context.expectedHandle) {
      throw new BridgeError('bridge_error', 'WorkBuddy returned a receipt for a different native target');
    }
  }

  async function runRequest(operation, requestFields, hooks) {
    if (platform !== 'win32') throw new BridgeError('not_capable', 'WorkBuddy UI Automation inspection is available only on Windows');
    const budgetMs = helperBudget(hooks);
    const request = JSON.stringify({ protocol: PROTOCOL, operation, ...requestFields });
    let result;
    try {
      result = await exec(powershellPath, [
        '-NoProfile', '-NonInteractive', '-STA', '-ExecutionPolicy', 'Bypass',
        '-File', helperPath, '-RequestJson', request,
      ], { windowsHide: true, timeout: budgetMs, maxBuffer: MAX_OUTPUT_BYTES, encoding: 'utf8' });
    } catch (error) {
      const message = error?.killed ? 'WorkBuddy UIA operation timed out' : 'WorkBuddy UIA operation could not run';
      throw new BridgeError('bridge_error', message);
    }
    const stdout = typeof result === 'string' ? result : result?.stdout;
    if (typeof stdout !== 'string' || Buffer.byteLength(stdout, 'utf8') > MAX_OUTPUT_BYTES) {
      throw new BridgeError('bridge_error', 'WorkBuddy UIA helper returned no bounded inspection');
    }
    let decoded;
    try { decoded = JSON.parse(stdout.trim()); } catch {
      throw new BridgeError('bridge_error', 'WorkBuddy UIA helper returned invalid JSON');
    }
    if (decoded?.error) throw new BridgeError('bridge_error', 'WorkBuddy UIA operation failed');
    return decoded;
  }

  async function runStdinRequest(operation, requestFields, hooks) {
    if (platform !== 'win32') throw new BridgeError('not_capable', 'WorkBuddy UI Automation actions are available only on Windows');
    const budgetMs = helperBudget(hooks);
    const request = JSON.stringify({ protocol: PROTOCOL, operation, ...requestFields, helperBudgetMs: budgetMs });
    if (Buffer.byteLength(request, 'utf8') > 128 * 1024) throw new BridgeError('invalid_params', 'WorkBuddy UI Automation action request is too large');
    const args = ['-NoProfile', '-NonInteractive', '-STA', '-ExecutionPolicy', 'Bypass', '-File', helperPath];
    const output = await new Promise((resolve, reject) => {
      let child;
      try { child = spawnProcess(powershellPath, args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }); }
      catch { reject(new BridgeError('bridge_error', 'WorkBuddy UIA helper could not start')); return; }
      const stdoutChunks = [];
      let stderrBytes = 0;
      let stderrFailureType = null;
      let stdoutBytes = 0;
      let settled = false;
      const finish = (error, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) reject(error); else resolve(value);
      };
      const timer = setTimeout(() => {
        try { child.kill(); } catch { /* only the bounded helper is terminated */ }
        finish(new BridgeError('bridge_error', 'WorkBuddy UIA action outcome is unknown; refresh the native chat before another action'));
      }, budgetMs);
      child.stdout?.on('data', (chunk) => {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        stdoutBytes += bytes.length;
        if (stdoutBytes > MAX_OUTPUT_BYTES) {
          try { child.kill(); } catch { /* stop an oversized helper response */ }
          finish(new BridgeError('bridge_error', 'WorkBuddy UIA action outcome is unknown; refresh the native chat before another action'));
          return;
        }
        stdoutChunks.push(bytes);
      });
      // Keep only a byte count and a fixed exception type from diagnostics.
      // Never retain or return raw PowerShell/compiler/provider text.
      child.stderr?.on('data', (chunk) => {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        stderrBytes = Math.min(65536, stderrBytes + bytes.length);
        if (stderrFailureType !== null) return;
        const text = bytes.toString('utf8');
        const match = text.match(/\b([A-Za-z][A-Za-z0-9.]{0,75}Exception)\b/);
        if (match && /^[A-Za-z][A-Za-z0-9.]{0,75}$/.test(match[1])) stderrFailureType = match[1];
      });
      child.on('error', () => finish(new BridgeError('bridge_error', 'WorkBuddy UIA helper could not run')));
      child.on('close', (code) => {
        if (code !== 0) {
          const diagnostic = captureFixedHelperDiagnostic(stdoutChunks, code);
          try { onHelperDiagnostic?.(Object.freeze({ ...diagnostic, stderrFailureType, stderrBytes })); } catch { }
          finish(new BridgeError('bridge_error', 'WorkBuddy UIA action outcome is unknown; refresh the native chat before another action')); return;
        }
        try {
          const stdout = Buffer.concat(stdoutChunks, stdoutBytes).toString('utf8');
          const decoded = JSON.parse(stdout.trim());
          if (decoded?.error) throw new Error('fixed helper error');
          finish(null, decoded);
        } catch {
          finish(new BridgeError('bridge_error', 'WorkBuddy UIA helper returned an invalid action response'));
        }
      });
      child.stdin?.on('error', () => finish(new BridgeError('bridge_error', 'WorkBuddy UIA action outcome is unknown; refresh the native chat before another action')));
      child.stdin?.end(request, 'utf8');
    });
    return output;
  }

  return {
    async inspect(options = {}, hooks) {
      const selector = validateSelector(options);
      const decoded = await runRequest('inspect', selector, hooks);
      return validateInspection(decoded);
    },
    async discoverMainWindows(options = {}, hooks) {
      const selector = validateSelector({ expectedExePath: options.expectedExePath, maxControls: 1 });
      if (!selector.expectedExePath) throw new BridgeError('invalid_params', 'WorkBuddy target discovery requires an exact executable path');
      return validateMainWindowDiscovery(await runRequest('discover-main-windows', selector, hooks));
    },
    async semanticSnapshot(options = {}, hooks) {
      const selector = validateSelector(options);
      if (!selector.expectedExePath || !Number.isInteger(options.expectedProcessId) || options.expectedProcessId < 1 ||
          typeof options.expectedHandle !== 'string' || !/^\d{1,20}$/.test(options.expectedHandle)) {
        throw new BridgeError('invalid_params', 'WorkBuddy semantic snapshot requires exact executable, PID and HWND');
      }
      const knownConversationTitles = options.knownConversationTitles;
      if (knownConversationTitles !== undefined && (!Array.isArray(knownConversationTitles) || knownConversationTitles.length > 200 ||
          !knownConversationTitles.every((title) => safeIdentityText(title, 180)))) {
        throw new BridgeError('invalid_params', 'WorkBuddy new-task proof requires bounded safe conversation titles');
      }
      const value = await runRequest('semantic-snapshot', { ...selector,
        ...(knownConversationTitles !== undefined ? { knownConversationTitles } : {}) }, hooks);
      const validated = validateSemanticSnapshot(value, selector);
      if (knownConversationTitles !== undefined && !validated.newTaskPageProof) {
        throw new BridgeError('bridge_error', 'WorkBuddy helper omitted the requested blank New Task page proof');
      }
      return validated;
    },
    async activateSemanticSnapshot(options = {}, hooks) {
      const selector = validateSelector(options);
      if (!selector.expectedExePath || !Number.isInteger(options.expectedProcessId) || options.expectedProcessId < 1 ||
          typeof options.expectedHandle !== 'string' || !/^\d{1,20}$/.test(options.expectedHandle)) {
        throw new BridgeError('invalid_params', 'WorkBuddy foreground snapshot requires exact executable, PID and HWND');
      }
      const knownConversationTitles = options.knownConversationTitles;
      if (knownConversationTitles !== undefined && (!Array.isArray(knownConversationTitles) || knownConversationTitles.length > 200 ||
          !knownConversationTitles.every((title) => safeIdentityText(title, 180)))) {
        throw new BridgeError('invalid_params', 'WorkBuddy new-task proof requires bounded safe conversation titles');
      }
      const value = await runRequest('activate-semantic', { ...selector,
        ...(knownConversationTitles !== undefined ? { knownConversationTitles } : {}) }, hooks);
      const validated = validateSemanticSnapshot(value, selector, { requireReadOnly: false });
      if (knownConversationTitles !== undefined && !validated.newTaskPageProof) {
        throw new BridgeError('bridge_error', 'WorkBuddy helper omitted the requested blank New Task page proof');
      }
      return validated;
    },
    async navigateNewTask(options = {}, hooks) {
      const selector = validateSelector(options);
      const knownConversationTitles = options.knownConversationTitles;
      if (!selector.expectedExePath || !Number.isInteger(selector.expectedProcessId) || selector.expectedProcessId < 1 ||
          !/^\d{1,20}$/.test(selector.expectedHandle ?? '') || !Array.isArray(knownConversationTitles) ||
          knownConversationTitles.length > 200 || !knownConversationTitles.every((title) => safeIdentityText(title, 180))) {
        throw new BridgeError('invalid_params', 'WorkBuddy New Task navigation requires an exact target and native title guard');
      }
      const decoded = await runStdinRequest('new-task-page', { ...selector, knownConversationTitles }, hooks);
      const snapshot = validateSemanticSnapshot(decoded, selector, { requireReadOnly: false });
      if (!snapshot.newTaskPageProof || typeof snapshot.restoreAttempted !== 'boolean') {
        throw new BridgeError('bridge_error', 'WorkBuddy New Task navigation omitted its native page proof');
      }
      return snapshot;
    },
    async typeNativeComposer(options = {}, hooks) {
      const selector = validateSelector(options);
      const hasIdentity = options.identityTitle !== undefined;
      if (!selector.expectedExePath || !Number.isInteger(selector.expectedProcessId) || selector.expectedProcessId < 1 ||
          !/^\d{1,20}$/.test(selector.expectedHandle ?? '') || typeof options.payload !== 'string' ||
          !options.payload.trim() || options.payload.length > 65536 || !/^[a-f0-9]{16}$/.test(options.expectedDraftFingerprint ?? '') ||
          (hasIdentity ? !safeIdentityText(options.identityTitle, 180) || !Array.isArray(options.anchorCandidates) ||
            options.anchorCandidates.length < 1 || options.anchorCandidates.length > 64 ||
            !options.anchorCandidates.every(a => Array.isArray(a) && a.length <= 3 && a.every(v => safeIdentityText(v, 120))) ||
            !Number.isInteger(options.expectedCandidateIndex) || options.expectedCandidateIndex < 0 || options.expectedCandidateIndex >= options.anchorCandidates.length
            : !Array.isArray(options.knownConversationTitles) || options.knownConversationTitles.length > 200 ||
              !options.knownConversationTitles.every(v => safeIdentityText(v, 180)))) {
        throw new BridgeError('invalid_params', 'WorkBuddy text input requires a fresh exact composer context');
      }
      const decoded = await runStdinRequest('composer-input', { ...selector, payload: options.payload,
        expectedDraftFingerprint: options.expectedDraftFingerprint,
        ...(hasIdentity ? { identityTitle: options.identityTitle, anchorCandidates: options.anchorCandidates,
          expectedCandidateIndex: options.expectedCandidateIndex } : { knownConversationTitles: options.knownConversationTitles }) }, hooks);
      const r = decoded?.inputReceipt;
      if (decoded?.protocol !== PROTOCOL || decoded.operation !== 'composer-input' || decoded.readOnly !== false ||
          decoded.target?.processId !== selector.expectedProcessId || decoded.target?.handle !== selector.expectedHandle || !r ||
          !['attempted', 'submitted', 'draftVerified', 'sendEnabled', 'targetContextVerified', 'foregroundVerified',
            'conversationIdentityVerified', 'newTaskIntentVerified'].every(k => typeof r[k] === 'boolean') ||
          typeof r.stage !== 'string' || r.stage.length > 80 || (r.submitted && (!r.attempted || !r.targetContextVerified || !r.foregroundVerified)) ||
          (r.draftVerified && !/^[a-f0-9]{16}$/.test(r.draftFingerprint ?? ''))) {
        throw new BridgeError('bridge_error', 'WorkBuddy returned an invalid native text input receipt');
      }
      return { ...decoded, actionResult: { attempted: r.attempted, submitted: r.submitted && r.draftVerified && r.sendEnabled } };
    },
    async selectNativeModel(options = {}, hooks) {
      const context = nativeContext(options, { allowNewTask: true });
      if (!safeIdentityText(options.model, 180)) throw new BridgeError('invalid_params', 'invalid WorkBuddy native model');
      const decoded = await runStdinRequest('select-native-model', { ...context, model: options.model }, hooks);
      checkNativeReceiptTarget(decoded, context, 'select-native-model');
      const r = decoded.selectionReceipt;
      if (decoded.readOnly !== false || !r || !['attempted','submitted','verified'].every(k => typeof r[k] === 'boolean') ||
          typeof r.stage !== 'string' || r.stage.length > 80 || !Array.isArray(r.patternReceipts) || r.patternReceipts.length > 3 ||
          r.verified && r.currentModel !== options.model) throw new BridgeError('bridge_error', 'invalid native model selection receipt');
      return r;
    },
    async readNativePending(options = {}, hooks) {
      const context = nativeContext(options);
      const metadata = options.questionMetadata;
      if (metadata !== undefined && (!Array.isArray(metadata) || metadata.length > 8 || JSON.stringify(metadata).length > 128000)) {
        throw new BridgeError('invalid_params', 'invalid local native question metadata');
      }
      const decoded = await runStdinRequest('native-pending', { ...context, ...(metadata !== undefined ? { questionMetadata: metadata } : {}) }, hooks);
      checkNativeReceiptTarget(decoded, context, 'native-pending');
      const p = decoded.identityProof, forms = decoded.pendingForms, stop = decoded.stopState;
      if (decoded.readOnly !== true || !p || !Number.isInteger(p.candidateCount) || p.candidateCount !== context.anchorCandidates.length ||
          !Number.isInteger(p.matchedCandidateIndex) || p.matchedCandidateIndex < -1 || p.matchedCandidateIndex >= p.candidateCount ||
          !Number.isInteger(p.conversationHeaderMatches) || p.conversationHeaderMatches < 0 || !forms ||
          typeof forms.snapshotComplete !== 'boolean' || typeof forms.conversationIdentityVerified !== 'boolean' ||
          !Array.isArray(forms.forms) || forms.forms.length > 8 || !stop || typeof stop.complete !== 'boolean' ||
          typeof stop.conversationIdentityVerified !== 'boolean' || typeof stop.idleObserved !== 'boolean') {
        throw new BridgeError('bridge_error', 'invalid WorkBuddy pending observation');
      }
      // C# DTOs carry nullable question fields for every kind. Omit them on
      // commands before passing the closed form shape to the pending broker.
      forms.forms = forms.forms.map(form => {
        if (form.kind !== 'command') return form;
        const { pageIndex, pageCount, questionIndexSource, selectedCount, selectedCountSource, ...command } = form;
        return command;
      });
      return { identityProof: { expectedCandidateIndex: context.expectedCandidateIndex, candidateCount: p.candidateCount,
        matchedCandidateIndex: p.matchedCandidateIndex, conversationHeaderMatches: p.conversationHeaderMatches }, pendingForms: forms, stopState: stop,
        ...(typeof decoded.currentModel === 'string' && safeIdentityText(decoded.currentModel, 180) ? { currentModel: decoded.currentModel } : {}) };
    },
    async executeNativePendingAction(options = {}, hooks) {
      const context = nativeContext(options);
      const plan = options.nativePlan;
      if (!plan || typeof plan !== 'object' || Array.isArray(plan) || !['question','approval','stop'].includes(plan.kind) ||
          plan.expectedExePath !== context.expectedExePath || Object.keys(plan).some(k => ![
            'kind','expectedExePath','freshFormProof','questions','answers','controls','targetControl','decision','context',
          ].includes(k)) || JSON.stringify(plan).length > 128000) throw new BridgeError('invalid_params', 'invalid native pending action plan');
      const decoded = await runStdinRequest('pending-action', { ...context, nativePlan: plan }, hooks);
      checkNativeReceiptTarget(decoded, context, 'pending-action');
      const r = decoded.actionReceipt;
      if (decoded.readOnly !== false || !r || !['attempted','uiSubmitted','postconditionObserved','postconditionUnknown',
          'uiClosed','idleObserved','targetContextVerified','conversationIdentityVerified','nativeResultConfirmed'].every(k => typeof r[k] === 'boolean') ||
          r.nativeResultConfirmed !== false || typeof r.stage !== 'string' || r.stage.length > 80 ||
          !Array.isArray(r.receipts) || r.receipts.length > 128 || r.uiSubmitted && (!r.attempted || !r.targetContextVerified || !r.conversationIdentityVerified)) {
        throw new BridgeError('bridge_error', 'invalid WorkBuddy pending action receipt');
      }
      return r;
    },
    async executeSemanticAction(options = {}, hooks) {
      const selector = validateSelector(options);
      const action = options.action;
      const safeActionLabel = options.safeActionLabel;
      const payload = options.payload;
      const requireNewTaskIntent = options.requireNewTaskIntent === true;
      const requireNewTaskNavigation = action === 'select' && safeActionLabel === 'new-task-tab';
      const requiresConversationIdentity = IDENTITY_ACTION_LABELS.has(safeActionLabel) && !requireNewTaskIntent;
      const identityTitle = options.identityTitle;
      const anchorCandidates = options.anchorCandidates;
      const expectedCandidateIndex = options.expectedCandidateIndex;
      const knownConversationTitles = options.knownConversationTitles;
      const validKnownConversationTitles = Array.isArray(knownConversationTitles) && knownConversationTitles.length <= 200 &&
        knownConversationTitles.every((title) => safeIdentityText(title, 180));
      const validAnchorCandidates = Array.isArray(anchorCandidates) && anchorCandidates.length >= 1 && anchorCandidates.length <= 64 &&
        anchorCandidates.every((candidate) => Array.isArray(candidate) && candidate.length <= 3 &&
          candidate.every((anchor) => safeIdentityText(anchor, 120) && [...anchor].length >= 2));
      if (!selector.expectedExePath || !Number.isInteger(options.expectedProcessId) || options.expectedProcessId < 1 ||
          typeof options.expectedHandle !== 'string' || !/^\d{1,20}$/.test(options.expectedHandle) ||
          !Object.prototype.hasOwnProperty.call(ACTIONS_BY_LABEL, action) || !ACTIONS_BY_LABEL[action].has(safeActionLabel) ||
          typeof options.runtimeIdHash !== 'string' || !/^[a-f0-9]{16}$/.test(options.runtimeIdHash) ||
          typeof options.regionHash !== 'string' || !/^[a-f0-9]{16}$/.test(options.regionHash) ||
          (action === 'set-value' && (typeof payload !== 'string' || [...payload].length > 65536 ||
            typeof options.expectedDraftFingerprint !== 'string' || !/^[a-f0-9]{16}$/.test(options.expectedDraftFingerprint))) ||
          ((action === 'invoke' && safeActionLabel === 'send-label') &&
            (typeof options.expectedDraftFingerprint !== 'string' || !/^[a-f0-9]{16}$/.test(options.expectedDraftFingerprint))) ||
          (requiresConversationIdentity && (!safeIdentityText(identityTitle, 180) || !validAnchorCandidates ||
            !Number.isInteger(expectedCandidateIndex) || expectedCandidateIndex < 0 || expectedCandidateIndex >= anchorCandidates.length)) ||
          (!requiresConversationIdentity && (identityTitle !== undefined || anchorCandidates !== undefined || expectedCandidateIndex !== undefined)) ||
          (requireNewTaskIntent && !((action === 'set-value' && safeActionLabel === 'composer') ||
            (action === 'invoke' && safeActionLabel === 'send-label'))) ||
          (requireNewTaskIntent && (!Array.isArray(knownConversationTitles) || knownConversationTitles.length > 200 ||
            !knownConversationTitles.every((title) => safeIdentityText(title, 180)))) ||
          (requireNewTaskNavigation && knownConversationTitles !== undefined && !validKnownConversationTitles) ||
          (!requireNewTaskIntent && !requireNewTaskNavigation && knownConversationTitles !== undefined) ||
          (action !== 'set-value' && payload !== undefined)) {
        throw new BridgeError('invalid_params', 'WorkBuddy UI Automation action requires an exact native control identity');
      }
      const decoded = await runStdinRequest('semantic-action', {
        expectedExePath: selector.expectedExePath,
        expectedProcessId: selector.expectedProcessId,
        expectedHandle: selector.expectedHandle,
        maxControls: selector.maxControls,
        action,
        safeActionLabel,
        runtimeIdHash: options.runtimeIdHash,
        regionHash: options.regionHash,
        expectedDraftFingerprint: options.expectedDraftFingerprint ?? '',
        ...(requiresConversationIdentity ? { identityTitle, anchorCandidates, expectedCandidateIndex } :
          { identityTitle: null, anchorCandidates: [], expectedCandidateIndex: -1 }),
        requireNewTaskIntent,
        knownConversationTitles: requireNewTaskIntent || requireNewTaskNavigation ? (knownConversationTitles ?? []) : [],
        ...(action === 'set-value' ? { payload } : {}),
      }, hooks);
      return validateSemanticAction(decoded, selector, { requiresConversationIdentity, requireNewTaskIntent, requireNewTaskNavigation });
    },
    async inspectConversationIdentity(options = {}, hooks) {
      const selector = validateSelector({ expectedExePath: options.expectedExePath, expectedProcessId: options.expectedProcessId,
        expectedHandle: options.expectedHandle, maxControls: 1 });
      const title = options.identityTitle;
      const anchorCandidates = options.anchorCandidates;
      if (!selector.expectedExePath || !safeIdentityText(title, 180) ||
          !Array.isArray(anchorCandidates) || anchorCandidates.length < 1 || anchorCandidates.length > 64 ||
          !anchorCandidates.every((candidate) => Array.isArray(candidate) && candidate.length <= 3 &&
            candidate.every((anchor) => safeIdentityText(anchor, 120) && [...anchor].length >= 2))) {
        throw new BridgeError('invalid_params', 'WorkBuddy conversation identity requires an exact title and bounded native history candidates');
      }
      const decoded = await runStdinRequest('semantic-identity', {
        expectedExePath: selector.expectedExePath,
        expectedProcessId: selector.expectedProcessId,
        expectedHandle: selector.expectedHandle,
        maxControls: selector.maxControls,
        identityTitle: title,
        anchorCandidates,
      }, hooks);
      return validateConversationIdentitySnapshot(decoded, selector, anchorCandidates.length);
    },
    async navigateConversation(options = {}, hooks) {
      const selector = validateSelector({ expectedExePath: options.expectedExePath,
        expectedProcessId: options.expectedProcessId, expectedHandle: options.expectedHandle, maxControls: 1 });
      const identityTitle = options.identityTitle;
      const anchorCandidates = options.anchorCandidates;
      const expectedCandidateIndex = options.expectedCandidateIndex;
      if (!selector.expectedExePath || !isSessionId(options.sessionId) || !safeIdentityText(identityTitle, 180) ||
          !Array.isArray(anchorCandidates) || anchorCandidates.length < 1 || anchorCandidates.length > 64 ||
          !anchorCandidates.every((candidate) => Array.isArray(candidate) && candidate.length <= 3 &&
            candidate.every((anchor) => safeIdentityText(anchor, 120) && [...anchor].length >= 2)) ||
          !Number.isInteger(expectedCandidateIndex) || expectedCandidateIndex < 0 || expectedCandidateIndex >= anchorCandidates.length) {
        throw new BridgeError('invalid_params', 'WorkBuddy native conversation navigation requires a unique live session identity');
      }
      const decoded = await runStdinRequest('navigate-conversation', {
        expectedExePath: selector.expectedExePath,
        expectedProcessId: selector.expectedProcessId,
        expectedHandle: selector.expectedHandle,
        maxControls: selector.maxControls,
        sessionId: options.sessionId,
        identityTitle,
        anchorCandidates,
        expectedCandidateIndex,
      }, hooks);
      return validateNativeConversationNavigation(decoded, selector, anchorCandidates.length, expectedCandidateIndex);
    },
    async readNativeModelCatalog(options = {}, hooks) {
      const selector = validateSelector({ expectedExePath: options.expectedExePath,
        ...(options.expectedProcessId !== undefined ? { expectedProcessId: options.expectedProcessId } : {}),
        ...(options.expectedHandle !== undefined ? { expectedHandle: options.expectedHandle } : {}), maxControls: 1 });
      if (!selector.expectedExePath) {
        throw new BridgeError('invalid_params', 'WorkBuddy native model catalog requires an exact executable path');
      }
      const decoded = await runStdinRequest('native-model-catalog', {
        expectedExePath: selector.expectedExePath,
        expectedProcessId: selector.expectedProcessId,
        expectedHandle: selector.expectedHandle,
        maxControls: 1,
      }, hooks);
      return validateNativeModelCatalog(decoded, selector);
    },
    async activateMainWindow(options = {}, hooks) {
      const selector = validateSelector(options);
      if (!selector.expectedExePath || !Number.isInteger(options.expectedProcessId) || options.expectedProcessId < 1 ||
          typeof options.expectedHandle !== 'string' || !/^\d{1,20}$/.test(options.expectedHandle)) {
        throw new BridgeError('invalid_params', 'WorkBuddy activation requires an exact process id and window handle');
      }
      const before = await this.inspect(selector, hooks);
      const exactBefore = before.windows.filter((window) => window.handle === options.expectedHandle &&
        window.processId === options.expectedProcessId && window.mainWindow && window.executableName === 'WorkBuddy.exe' &&
        window.visible && window.enabled);
      if (before.inputDesktopKind !== 'default' || exactBefore.length !== 1) {
        return { outcome: 'blocked', reason: before.inputDesktopKind !== 'default' ? 'input-desktop-not-default' : 'exact-main-window-mismatch' };
      }
      const submitted = await runRequest('activate-window', {
        expectedExePath: selector.expectedExePath,
        expectedHandle: options.expectedHandle,
        expectedProcessId: options.expectedProcessId,
        maxControls: selector.maxControls,
      }, hooks);
      if (!submitted || submitted.operation !== 'activate-window' || !['confirmed', 'submitted', 'blocked'].includes(submitted.outcome)) {
        throw new BridgeError('bridge_error', 'WorkBuddy activation helper returned an invalid outcome');
      }
      if (submitted.outcome === 'blocked') return submitted;
      const after = await this.inspect(selector, hooks);
      const exactAfter = after.windows.filter((window) => window.handle === options.expectedHandle &&
        window.processId === options.expectedProcessId && window.mainWindow && window.executableName === 'WorkBuddy.exe');
      const confirmed = after.inputDesktopKind === 'default' && exactAfter.length === 1 &&
        exactAfter[0].visible && exactAfter[0].enabled && !exactAfter[0].minimized && exactAfter[0].isForeground;
      return { outcome: confirmed ? 'confirmed' : 'submitted', reason: confirmed ? null : submitted.reason ?? 'fresh-verification-incomplete' };
    },
    async activateAndInspectMainWindow(options = {}, hooks) {
      const selector = validateSelector(options);
      if (!selector.expectedExePath || !Number.isInteger(options.expectedProcessId) || options.expectedProcessId < 1 ||
          typeof options.expectedHandle !== 'string' || !/^\d{1,20}$/.test(options.expectedHandle)) {
        throw new BridgeError('invalid_params', 'WorkBuddy combined activation and inspection requires an exact process id and window handle');
      }
      const inspection = validateInspection(await runRequest('activate-inspect', {
        expectedExePath: selector.expectedExePath,
        expectedProcessId: options.expectedProcessId,
        expectedHandle: options.expectedHandle,
        maxControls: selector.maxControls,
      }, hooks));
      if (!inspection.activation) throw new BridgeError('bridge_error', 'WorkBuddy combined activation did not return a fresh activation result');
      if (inspection.activation.outcome === 'confirmed') {
        const exact = inspection.windows.filter((window) => window.handle === options.expectedHandle &&
          window.processId === options.expectedProcessId && window.mainWindow && window.executableName === 'WorkBuddy.exe');
        if (inspection.inputDesktopKind !== 'default' || exact.length !== 1 || !exact[0].visible || !exact[0].enabled ||
            exact[0].minimized || !exact[0].isForeground || exact[0].foregroundHandle !== exact[0].handle) {
          throw new BridgeError('bridge_error', 'WorkBuddy confirmed activation without a matching final foreground snapshot');
        }
      }
      return { outcome: inspection.activation.outcome, reason: inspection.activation.reason, inspection };
    },
  };
}

module.exports = {
  PROTOCOL,
  HELPER_PATH,
  DEFAULT_TIMEOUT_MS,
  MAX_OUTPUT_BYTES,
  validateSelector,
  validateInspection,
  validateSemanticSnapshot,
  validateSemanticAction,
  validateConversationIdentitySnapshot,
  validateNativeConversationNavigation,
  validateNativeModelCatalog,
  validateMainWindowDiscovery,
  validateUiaComStatus,
  validateDotNetUiaStatus,
  validateNewTaskPageProof,
  validateProcessContext,
  validateStructureSubscription,
  createWindowsUiaInspector,
};
