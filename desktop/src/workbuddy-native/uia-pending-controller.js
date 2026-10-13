'use strict';

const crypto = require('node:crypto');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const {
  isCallId, isSessionId, isUuidV4,
  MAX_PENDING_BATCHES, MAX_PENDING_QUESTIONS, MAX_PENDING_OPTIONS,
  MAX_QUESTION_TEXT, MAX_QUESTION_HEADER, MAX_QUESTION_DETAIL,
  MAX_OPTION_LABEL, MAX_OPTION_DESCRIPTION, MAX_ANSWER_CUSTOM,
  MAX_PENDING_APPROVALS, MAX_APPROVAL_REASON, APPROVAL_DECISIONS,
} = require('../protocol');

const MAX_TTL_MS = 120_000;
const DEFAULT_TTL_MS = 20_000;
const MAX_ACTIVE_ALIASES = 512;
const MAX_UIA_FORMS = 8;
const MAX_UIA_CONTROLS = 128;
const MAX_APPROVAL_COMMAND = 4000;
const MAX_APPROVAL_CONTEXT_PATH = 1024;
const HASH = /^[a-f0-9]{16}$/u;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const TRUNCATION_MARKER = /\[(?:native\s+)?(?:truncated|cut off)\]/iu;
const CREDENTIAL_TEXT = /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\bBearer\s+[A-Za-z0-9._~+/-]{12,}|\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b|\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|password|passwd|secret|credential)\b\s*[:=]\s*["']?[^\s"'\x60,;]{4,}|(?:^|\s)--?(?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|password|passwd|secret|authorization)(?:\s+|=)[^\s]{4,}/iu;
const COMMAND_TOOLS = new Set(['bash', 'powershell', 'run_command', 'execute_command']);
const QUESTION_TOOLS = new Set(['askuserquestion', 'ask_user_question']);
const QUESTION_NAVIGATION_LABELS = new Set([
  'previous question', 'next question', 'send', '上一题', '下一题', '发送',
]);
const OTHER_ANSWER_PLACEHOLDERS = new Set([
  'other (type your answer)', '其他（输入你的答案）', '其他 (输入你的答案)',
]);
const UNSUPPORTED_APPROVAL_LABELS = new Set(['always', 'always allow', 'allow once', 'allow for this session', 'approve', 'approve session']);
const OTHER_COMMAND_DECISION_LABELS = new Set(UNSUPPORTED_APPROVAL_LABELS);
const COMMAND_RUN_LABELS = new Set(['run', '运行', '執行']);
const COMMAND_REJECT_LABELS = new Set(['reject', '拒绝', '拒絕']);
const ERROR_MESSAGES = Object.freeze({
  invalid_params: 'invalid pending native decision',
  stale_request: 'pending native item is stale or no longer available',
  bridge_error: 'pending native item cannot be projected safely',
});

class WorkBuddyUiaPendingControllerError extends Error {
  constructor(code) {
    super(ERROR_MESSAGES[code] || ERROR_MESSAGES.bridge_error);
    this.name = 'WorkBuddyUiaPendingControllerError';
    this.code = Object.hasOwn(ERROR_MESSAGES, code) ? code : 'bridge_error';
  }
}

function fail(code) {
  throw new WorkBuddyUiaPendingControllerError(code);
}

function isPlainRecord(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function closedRecord(value, allowed, required, code = 'invalid_params') {
  if (!isPlainRecord(value) || Object.getOwnPropertySymbols(value).length !== 0) fail(code);
  const names = Object.getOwnPropertyNames(value);
  if (names.some((name) => !allowed.includes(name)) || required.some((name) => !names.includes(name))) fail(code);
  const copy = {};
  for (const name of names) {
    const descriptor = Object.getOwnPropertyDescriptor(value, name);
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) fail(code);
    copy[name] = descriptor.value;
  }
  return copy;
}

function cloneBoundedJson(value, depth = 0, seen = new Set()) {
  if (depth > 16) fail('bridge_error');
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail('bridge_error');
    return value;
  }
  if (typeof value !== 'object' || seen.has(value) || Object.getOwnPropertySymbols(value).length !== 0) fail('bridge_error');
  seen.add(value);
  if (Array.isArray(value)) {
    if (value.length > 5000) fail('bridge_error');
    const names = Object.getOwnPropertyNames(value);
    if (names.length !== value.length + 1 || names.at(-1) !== 'length') fail('bridge_error');
    const copy = [];
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor || !Object.hasOwn(descriptor, 'value') || !descriptor.enumerable) fail('bridge_error');
      copy.push(cloneBoundedJson(descriptor.value, depth + 1, seen));
    }
    seen.delete(value);
    return copy;
  }
  if (!isPlainRecord(value)) fail('bridge_error');
  const names = Object.getOwnPropertyNames(value);
  if (names.length > 2048) fail('bridge_error');
  const copy = {};
  for (const name of names) {
    const descriptor = Object.getOwnPropertyDescriptor(value, name);
    if (!descriptor || !Object.hasOwn(descriptor, 'value') || !descriptor.enumerable) fail('bridge_error');
    copy[name] = cloneBoundedJson(descriptor.value, depth + 1, seen);
  }
  seen.delete(value);
  return copy;
}

function stableJson(value) {
  if (Array.isArray(value)) return '[' + value.map(stableJson).join(',') + ']';
  if (value && typeof value === 'object') {
    return '{' + Object.keys(value).sort().map((key) => JSON.stringify(key) + ':' + stableJson(value[key])).join(',') + '}';
  }
  return JSON.stringify(value);
}

function derivedFormFingerprint(candidate, form, identityProof) {
  // This digest describes sampled UIA form and matched history context. It is
  // not a native turn, item, or function-call identity.
  return crypto.createHash('sha256').update(stableJson({ candidate, form, identityProof }), 'utf8').digest('hex');
}

/**
 * Stable digest for the exact bounded history-analysis snapshot passed to the
 * pending-form wrapper. This binds the producer and controller to one local
 * analysis value; it is not native identity evidence or a substitute for the
 * UIA candidate/header proof.
 */
function fingerprintHistoryAnalysis(historyAnalysis) {
  const snapshot = cloneBoundedJson(historyAnalysis);
  return crypto.createHash('sha256').update(stableJson(snapshot), 'utf8').digest('hex');
}

function isGeneration(value) {
  if (Number.isSafeInteger(value) && value >= 0) return true;
  return typeof value === 'string' && value.length > 0 && value.length <= 128 &&
    value.trim() === value && !/[\u0000-\u001f\u007f]/u.test(value);
}

function safeText(value, maxLength, allowMultiline = true) {
  const unsafe = allowMultiline ? /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u : /[\u0000-\u001f\u007f]/u;
  return typeof value === 'string' && value.length > 0 && value.length <= maxLength && value.trim() === value && !unsafe.test(value);
}

function normalizeVisible(value) {
  return value.replace(/\r\n?/gu, '\n').split('\n').map((line) => line.trim()).filter(Boolean).join('\n');
}

function containsSensitiveOrTruncated(value) {
  return typeof value !== 'string' || CREDENTIAL_TEXT.test(value) || TRUNCATION_MARKER.test(value);
}

function hasPhrase(visibleText, phrase) {
  return normalizeVisible(phrase).length > 0 && normalizeVisible(visibleText).includes(normalizeVisible(phrase));
}

function sameMultiset(left, right) {
  if (left.length !== right.length) return false;
  const counts = new Map();
  for (const value of left) counts.set(value, (counts.get(value) || 0) + 1);
  for (const value of right) {
    const count = counts.get(value);
    if (count === undefined) return false;
    if (count === 1) counts.delete(value);
    else counts.set(value, count - 1);
  }
  return counts.size === 0;
}

function multisetContains(needles, haystack) {
  const counts = new Map();
  for (const value of haystack) counts.set(value, (counts.get(value) || 0) + 1);
  for (const value of needles) {
    const count = counts.get(value);
    if (count === undefined) return false;
    if (count === 1) counts.delete(value);
    else counts.set(value, count - 1);
  }
  return true;
}

function exactWindowsPath(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_APPROVAL_CONTEXT_PATH ||
      value.trim() !== value || /[\u0000-\u001f\u007f/]/u.test(value) || /^\\\\[?.]\\/.test(value) ||
      !path.win32.isAbsolute(value)) return false;
  const hasDriveRoot = /^[A-Za-z]:\\/u.test(value);
  const hasUncRoot = /^\\\\[^\\/]+\\[^\\/]+(?:\\|$)/u.test(value);
  if (!hasDriveRoot && !hasUncRoot) return false;
  const pieces = value.replace(/^[A-Za-z]:\\/u, '').replace(/^\\\\[^\\/]+\\[^\\/]+(?:\\|$)/u, '').split('\\');
  return !pieces.some((piece) => piece === '.' || piece === '..');
}

function isActionControl(control) {
  return control.controlType === 'ControlType.Button' || control.controlType === 'ControlType.ListItem' ||
    control.controlType === 'ControlType.Edit';
}

function validateForm(form) {
  if (!isPlainRecord(form)) return false;
  const allowed = [
    'kind', 'complete', 'desktopGuide', 'conversationRegionHash', 'scopePathHash', 'visibleText', 'commandText', 'controls',
    'pageIndex', 'pageCount', 'questionIndexSource', 'selectedCount', 'selectedCountSource',
  ];
  if (Object.keys(form).some((key) => !allowed.includes(key)) ||
      (form.kind !== 'question' && form.kind !== 'command') || form.complete !== true || form.desktopGuide !== false ||
      !HASH.test(form.conversationRegionHash) || !HASH.test(form.scopePathHash) ||
      !safeText(form.visibleText, 8192) || containsSensitiveOrTruncated(form.visibleText) ||
      !Array.isArray(form.controls) || form.controls.length === 0 || form.controls.length > MAX_UIA_CONTROLS) return false;
  if (form.kind === 'command') {
    if (['pageIndex', 'pageCount', 'questionIndexSource', 'selectedCount', 'selectedCountSource']
      .some((key) => Object.hasOwn(form, key))) return false;
    if (!safeText(form.commandText, MAX_APPROVAL_COMMAND) || containsSensitiveOrTruncated(form.commandText)) return false;
  } else {
    if (form.commandText !== null && form.commandText !== undefined && form.commandText !== '' ||
        !['native-progress', 'unavailable'].includes(form.questionIndexSource) ||
        !['native-visible-count', 'unavailable'].includes(form.selectedCountSource)) return false;
    if (form.questionIndexSource === 'native-progress') {
      if (!Number.isSafeInteger(form.pageIndex) || form.pageIndex < 1 ||
          !Number.isSafeInteger(form.pageCount) || form.pageCount < 1 || form.pageCount > MAX_PENDING_QUESTIONS ||
          form.pageIndex > form.pageCount) return false;
    } else if (form.pageIndex !== null || form.pageCount !== null) return false;
    if (form.selectedCountSource === 'native-visible-count') {
      if (!Number.isSafeInteger(form.selectedCount) || form.selectedCount < 0 || form.selectedCount > MAX_PENDING_OPTIONS) return false;
    } else if (form.selectedCount !== null) return false;
  }

  const runtimeIds = new Set();
  for (const control of form.controls) {
    if (!isPlainRecord(control) || Object.keys(control).some((key) => ![
      'controlType', 'accessibleName', 'enabled', 'patterns', 'pathHash', 'runtimeIdHash', 'regionHash', 'passwordProtected',
    ].includes(key))) return false;
    if (typeof control.controlType !== 'string' || control.controlType.length === 0 || control.controlType.length > 64 ||
        typeof control.enabled !== 'boolean' || control.passwordProtected !== false || !HASH.test(control.pathHash) ||
        control.regionHash !== form.conversationRegionHash || !Array.isArray(control.patterns) || control.patterns.length > 6 ||
        control.patterns.some((pattern) => !['invoke', 'selectionItem', 'toggle', 'value', 'text', 'expandCollapse'].includes(pattern))) return false;
    if (control.accessibleName !== null && control.accessibleName !== undefined &&
        (!safeText(control.accessibleName, 256) || containsSensitiveOrTruncated(control.accessibleName))) return false;
    if (isActionControl(control)) {
      if (!HASH.test(control.runtimeIdHash) || runtimeIds.has(control.runtimeIdHash) ||
          typeof control.accessibleName !== 'string' || control.accessibleName.length === 0) return false;
      runtimeIds.add(control.runtimeIdHash);
    } else if (control.runtimeIdHash !== null && control.runtimeIdHash !== undefined &&
        control.runtimeIdHash !== '' && !HASH.test(control.runtimeIdHash)) return false;
  }
  return runtimeIds.size > 0;
}

function safeQuestionProjection(source, index, usedIds) {
  if (!isPlainRecord(source)) return null;
  const allowed = ['id', 'question', 'header', 'detail', 'options', 'multiSelect', 'allowCustom'];
  if (Object.keys(source).some((key) => !allowed.includes(key)) ||
      !safeText(source.question, MAX_QUESTION_TEXT) || containsSensitiveOrTruncated(source.question)) return null;
  const id = source.id === undefined ? 'bridge-q-' + index : source.id;
  if (!isCallId(id) || usedIds.has(id)) return null;
  usedIds.add(id);
  const question = { id, question: source.question };
  for (const [field, limit] of [['header', MAX_QUESTION_HEADER], ['detail', MAX_QUESTION_DETAIL]]) {
    if (source[field] !== undefined && source[field] !== null) {
      if (typeof source[field] !== 'string' || [...source[field]].length > limit || containsSensitiveOrTruncated(source[field])) return null;
      if (source[field].length > 0) question[field] = source[field];
    }
  }
  if (source.options !== undefined && source.options !== null) {
    if (!Array.isArray(source.options) || source.options.length === 0 || source.options.length > MAX_PENDING_OPTIONS) return null;
    const labels = new Set();
    question.options = [];
    for (const option of source.options) {
      if (!isPlainRecord(option) || Object.keys(option).some((key) => !['label', 'description'].includes(key)) ||
          !safeText(option.label, MAX_OPTION_LABEL) || containsSensitiveOrTruncated(option.label) || labels.has(option.label)) return null;
      labels.add(option.label);
      const projected = { label: option.label };
      if (option.description !== undefined && option.description !== null) {
        if (typeof option.description !== 'string' || [...option.description].length > MAX_OPTION_DESCRIPTION ||
            containsSensitiveOrTruncated(option.description)) return null;
        if (option.description.length > 0) projected.description = option.description;
      }
      question.options.push(projected);
    }
  }
  for (const flag of ['multiSelect', 'allowCustom']) {
    if (source[flag] !== undefined) {
      if (typeof source[flag] !== 'boolean') return null;
      if (source[flag] || flag === 'allowCustom') question[flag] = source[flag];
    }
  }
  return question;
}

function makeQuestionCandidate(candidate) {
  if (candidate.complete !== true || !Array.isArray(candidate.questions) ||
      candidate.questions.length === 0 || candidate.questions.length > MAX_PENDING_QUESTIONS) return null;
  const usedIds = new Set();
  const questions = candidate.questions.map((question, index) => safeQuestionProjection(question, index, usedIds));
  if (questions.some((question) => question === null)) return null;
  const projectedQuestionIndexById = new Map();
  candidate.questions.forEach((source, index) => {
    // Phone-facing bridge question ids map only to ordered source indexes. The
    // helper receives indexes and exact source metadata, never a fabricated
    // native question id.
    projectedQuestionIndexById.set(questions[index].id, index);
  });
  return { questions, projectedQuestionIndexById };
}

function questionContextMatches(candidate, form) {
  const normalized = makeQuestionCandidate(candidate);
  if (!normalized) return null;
  let pageIndex;
  let pageCount;
  let questionIndexSource;
  if (form.questionIndexSource === 'native-progress') {
    pageIndex = form.pageIndex;
    pageCount = form.pageCount;
    questionIndexSource = 'native-progress';
    if (pageCount !== normalized.questions.length) return null;
  } else {
    if (normalized.questions.length !== 1) return null;
    pageIndex = 1;
    pageCount = 1;
    questionIndexSource = 'single-question-derived';
  }
  const currentIndex = pageIndex - 1;
  const currentQuestion = normalized.questions[currentIndex];
  if (!currentQuestion) return null;
  if (form.selectedCountSource === 'native-visible-count' && currentQuestion.options !== undefined &&
      form.selectedCount > currentQuestion.options.length) return null;
  const expectedVisible = [];
  const expectedOptionNames = (currentQuestion.options || []).map((option) => option.label);
  expectedVisible.push(currentQuestion.question);
  if (currentQuestion.header) expectedVisible.push(currentQuestion.header);
  if (currentQuestion.detail) expectedVisible.push(currentQuestion.detail);
  for (const option of currentQuestion.options || []) {
    expectedVisible.push(option.label);
    if (option.description) expectedVisible.push(option.description);
  }
  const visibleLines = normalizeVisible(form.visibleText).split('\n').filter(Boolean);
  const expectedProgress = `${pageIndex}/${pageCount}`;
  const progressPattern = /^[1-9][0-9]{0,2}\/[1-9][0-9]{0,2}$/u;
  const visibleProgress = visibleLines.filter((line) => progressPattern.test(line));
  if (questionIndexSource === 'native-progress' &&
      (visibleProgress.length !== 1 || visibleProgress[0] !== expectedProgress)) return null;
  if (questionIndexSource === 'single-question-derived' && visibleProgress.length > 0) return null;
  const selectedCountPattern = form.selectedCountSource === 'native-visible-count'
    ? new RegExp(`^(?:已选择\\s*${form.selectedCount}\\s*个|${form.selectedCount}\\s+selected)$`, 'iu')
    : null;
  const visibleSelectedCounts = visibleLines.filter((line) =>
    /^(?:已选择\s*[0-9]{1,3}\s*个|[0-9]{1,3}\s+selected)$/u.test(line));
  if (selectedCountPattern && (visibleSelectedCounts.length !== 1 || !selectedCountPattern.test(visibleSelectedCounts[0]))) return null;
  if (!selectedCountPattern && visibleSelectedCounts.length > 0) return null;
  const ignorableVisible = new Set(QUESTION_NAVIGATION_LABELS);
  if (questionIndexSource === 'native-progress') ignorableVisible.add(expectedProgress);
  if (selectedCountPattern) ignorableVisible.add(visibleSelectedCounts[0].toLocaleLowerCase('en-US'));
  const filteredVisible = visibleLines.filter((line) => !ignorableVisible.has(line.toLocaleLowerCase('en-US')));
  const requiredVisible = [currentQuestion.question, ...expectedOptionNames];
  if (!multisetContains(requiredVisible, filteredVisible) || !multisetContains(filteredVisible, expectedVisible)) return null;
  const optionControls = form.controls.filter((control) =>
    (control.controlType === 'ControlType.Button' || control.controlType === 'ControlType.ListItem') &&
    !QUESTION_NAVIGATION_LABELS.has(control.accessibleName?.toLocaleLowerCase('en-US')));
  const optionNames = optionControls.map((control) => {
    const matches = expectedOptionNames.filter((label,index) => control.accessibleName === label || control.accessibleName === `${index+1} ${label}`);
    return matches.length === 1 ? matches[0] : null;
  });
  if (!sameMultiset(optionNames, expectedOptionNames)) return null;
  const otherEdits = form.controls.filter((control) => control.controlType === 'ControlType.Edit');
  if (otherEdits.length > 1) return null;
  if (otherEdits.length === 1) {
    const edit = otherEdits[0];
    if (!OTHER_ANSWER_PLACEHOLDERS.has(edit.accessibleName?.toLocaleLowerCase('en-US')) ||
        !edit.enabled || !edit.patterns.includes('value') || currentQuestion.allowCustom === false) return null;
    currentQuestion.allowCustom = true;
  } else if (currentQuestion.allowCustom !== false) {
    // The local call metadata may permit custom text, but only a live bounded
    // Other editor on this exact page is enough to project it for this page.
    delete currentQuestion.allowCustom;
  }
  const advanceLabels = form.controls.filter((control) =>
    (control.controlType === 'ControlType.Button' || control.controlType === 'ControlType.ListItem') &&
    ['next question', 'send', '下一题', '发送'].includes(control.accessibleName?.toLocaleLowerCase('en-US')));
  if (advanceLabels.length > 1 || advanceLabels.some((control) =>
    !control.patterns.some((pattern) => ['invoke', 'selectionItem', 'toggle'].includes(pattern)))) return null;
  return { normalized, pageIndex, pageCount, questionIndexSource };
}

function commandDecisionControls(form) {
  const labeled = form.controls.filter((control) =>
    (control.controlType === 'ControlType.Button' || control.controlType === 'ControlType.ListItem') &&
    typeof control.accessibleName === 'string');
  if (labeled.some((control) => UNSUPPORTED_APPROVAL_LABELS.has(control.accessibleName.toLocaleLowerCase('en-US')))) return null;
  if (labeled.some((control) => OTHER_COMMAND_DECISION_LABELS.has(control.accessibleName.toLocaleLowerCase('en-US')))) return null;
  const actions = new Map();
  for (const [action, labels] of [['allow-once', COMMAND_RUN_LABELS], ['reject', COMMAND_REJECT_LABELS]]) {
    const matches = labeled.filter((control) => labels.has(control.accessibleName.toLocaleLowerCase('en-US')) &&
      control.enabled === true && control.patterns.some((pattern) => ['invoke', 'selectionItem', 'toggle'].includes(pattern)));
    if (matches.length !== 1) return null;
    actions.set(action, matches[0]);
  }
  // Skip is part of the native card, but is never a phone decision target.
  return actions;
}

function commandContextMatches(candidate, form, cwd) {
  if (candidate.complete !== true || !isPlainRecord(candidate.scopeContext) ||
      Object.keys(candidate.scopeContext).some((key) => !['kind', 'command', 'cwd'].includes(key)) ||
      candidate.scopeContext.kind !== 'command' || !safeText(candidate.scopeContext.command, MAX_APPROVAL_COMMAND) ||
      containsSensitiveOrTruncated(candidate.scopeContext.command) || !exactWindowsPath(candidate.scopeContext.cwd) ||
      !exactWindowsPath(cwd) || candidate.scopeContext.cwd !== cwd || form.commandText !== candidate.scopeContext.command ||
      !hasPhrase(form.visibleText, candidate.scopeContext.command) || !safeText(form.visibleText, MAX_APPROVAL_REASON) ||
      containsSensitiveOrTruncated(form.visibleText)) return null;
  const actions = commandDecisionControls(form);
  if (!actions) return null;
  return { actions, context: { kind: 'command', command: candidate.scopeContext.command, cwd } };
}

function matchesIdentityProof(pendingForms, analysis, sessionId) {
  const proof = pendingForms.identityProof;
  if (!isPlainRecord(proof) || Object.keys(proof).length !== 6 ||
      Object.keys(proof).some((key) => ![
        'sessionId', 'expectedCandidateIndex', 'candidateCount', 'matchedCandidateIndex',
        'conversationHeaderMatches', 'historyFingerprint',
      ].includes(key))) return false;
  const { expectedCandidateIndex, candidateCount } = proof;
  return proof.sessionId === sessionId && pendingForms.sessionId === sessionId && analysis.sessionId === sessionId &&
    Number.isSafeInteger(candidateCount) && candidateCount >= 1 && candidateCount <= 64 &&
    Number.isSafeInteger(expectedCandidateIndex) && expectedCandidateIndex >= 0 && expectedCandidateIndex < candidateCount &&
    proof.matchedCandidateIndex === expectedCandidateIndex && proof.conversationHeaderMatches === 1 &&
    typeof proof.historyFingerprint === 'string' && /^[a-f0-9]{64}$/u.test(proof.historyFingerprint) &&
    proof.historyFingerprint === fingerprintHistoryAnalysis(analysis);
}

function buildPairs(observation) {
  const analysis = observation.historyAnalysis;
  const pendingForms = observation.pendingForms;
  if (!isPlainRecord(analysis) || analysis.complete !== true || analysis.sessionId !== observation.sessionId ||
      !Array.isArray(analysis.unresolvedCalls) || !Array.isArray(analysis.questionCandidates) || !Array.isArray(analysis.commandCandidates) ||
      !isPlainRecord(pendingForms) || pendingForms.sessionId !== observation.sessionId ||
      pendingForms.snapshotComplete !== true || pendingForms.conversationIdentityVerified !== true ||
      !matchesIdentityProof(pendingForms, analysis, observation.sessionId) ||
      !Array.isArray(pendingForms.forms) || pendingForms.forms.length > MAX_UIA_FORMS) return { valid: false, pairs: [] };
  const forms = pendingForms.forms.filter((form) => isPlainRecord(form));
  if (forms.length !== pendingForms.forms.length) return { valid: false, pairs: [] };
  const validForms = forms.filter(validateForm);
  const unresolved = new Map();
  for (const call of analysis.unresolvedCalls) {
    if (!isPlainRecord(call) || !isCallId(call.callId) || typeof call.toolName !== 'string' ||
        call.ambiguous === true || unresolved.has(call.callId)) return { valid: false, pairs: [] };
    unresolved.set(call.callId, call);
  }
  const candidates = [];
  for (const [kind, records, tools] of [
    ['question', analysis.questionCandidates, QUESTION_TOOLS],
    ['command', analysis.commandCandidates, COMMAND_TOOLS],
  ]) {
    for (const candidate of records) {
      if (!isPlainRecord(candidate) || !isCallId(candidate.callId)) continue;
      const pendingCall = unresolved.get(candidate.callId);
      if (!pendingCall || typeof candidate.toolName !== 'string' || pendingCall.toolName !== candidate.toolName ||
          !tools.has(candidate.toolName.toLocaleLowerCase('en-US'))) continue;
      candidates.push({ kind, candidate, pendingCall });
    }
  }
  const edges = [];
  for (const item of candidates) {
    for (const form of validForms) {
      if (form.kind !== item.kind) continue;
      const detail = item.kind === 'question'
        ? questionContextMatches(item.candidate, form)
        : commandContextMatches(item.candidate, form, observation.cwd);
      if (detail) edges.push({ ...item, form, detail });
    }
  }
  const candidateMatches = new Map();
  const formMatches = new Map();
  for (const edge of edges) {
    candidateMatches.set(edge.candidate.callId, (candidateMatches.get(edge.candidate.callId) || 0) + 1);
    formMatches.set(edge.form, (formMatches.get(edge.form) || 0) + 1);
  }
  const identityProof = cloneBoundedJson(pendingForms.identityProof);
  const pairs = edges.filter((edge) => candidateMatches.get(edge.candidate.callId) === 1 && formMatches.get(edge.form) === 1)
    .map((edge) => ({ ...edge, identityProof, formFingerprint: derivedFormFingerprint(edge.candidate, edge.form, identityProof) }));
  return { valid: true, pairs, guideForms: forms.filter((form) => !pairs.some((pair) => pair.form === form)) };
}

function identityKey(sessionId, kind, callId) {
  return JSON.stringify([sessionId, kind, callId]);
}

function selectionKey(sessionId, epoch) {
  return JSON.stringify([sessionId, epoch]);
}

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function desktopGuideFor(forms) {
  const kinds = new Set();
  for (const form of forms || []) {
    if (form?.kind === 'question' || form?.kind === 'command') kinds.add(form.kind);
  }
  return [...kinds].map((kind) => ({ kind, message: 'Finish this request in WorkBuddy on the desktop.' }));
}

function validateQuestionAnswers(record, answers) {
  if (!Array.isArray(answers) || answers.length !== record.questions.length || answers.length === 0 ||
      answers.length > MAX_PENDING_QUESTIONS) fail('invalid_params');
  const byId = new Map(record.questions.map((question) => [question.id, question]));
  const seen = new Set();
  const mapped = new Array(record.questions.length);
  for (const value of answers) {
    const answer = closedRecord(value, ['id', 'selected', 'custom'], ['id', 'selected']);
    if (!isCallId(answer.id) || seen.has(answer.id) || !byId.has(answer.id) || !Array.isArray(answer.selected) ||
        answer.selected.length > MAX_PENDING_OPTIONS) fail('invalid_params');
    seen.add(answer.id);
    const question = byId.get(answer.id);
    const allowedLabels = new Set((question.options || []).map((option) => option.label));
    const selected = [];
    const selectedSet = new Set();
    for (const label of answer.selected) {
      if (!safeText(label, MAX_OPTION_LABEL, false) || !allowedLabels.has(label) || selectedSet.has(label)) fail('invalid_params');
      selectedSet.add(label);
      selected.push(label);
    }
    if (question.multiSelect !== true && selected.length > 1) fail('invalid_params');
    const custom = answer.custom;
    const customAllowed = question.allowCustom === true;
    if (custom !== undefined && (!customAllowed || !safeText(custom, MAX_ANSWER_CUSTOM))) fail('invalid_params');
    if (custom !== undefined && selected.length > 0) fail('invalid_params');
    if (selected.length === 0 && custom === undefined) fail('invalid_params');
    const questionIndex = record.projectedQuestionIndexById.get(answer.id);
    if (!Number.isSafeInteger(questionIndex) || questionIndex < 0 || questionIndex >= mapped.length) fail('invalid_params');
    mapped[questionIndex] = {
      questionIndex,
      selectedLabels: selected,
      ...(custom !== undefined ? { custom } : {}),
    };
  }
  if (seen.size !== byId.size) fail('invalid_params');
  return mapped;
}

function observationFromInput(input, allowedFields) {
  const source = closedRecord(input, allowedFields, ['sessionId', 'epoch', 'sequence', 'historyAnalysis', 'pendingForms']);
  if (!isSessionId(source.sessionId) || !isGeneration(source.epoch) || !Number.isSafeInteger(source.sequence) || source.sequence < 0 ||
      (source.cwd !== undefined && !exactWindowsPath(source.cwd))) fail('invalid_params');
  source.historyAnalysis = cloneBoundedJson(source.historyAnalysis);
  source.pendingForms = cloneBoundedJson(source.pendingForms);
  return source;
}

/**
 * Only unresolved local function_call candidates with a unique, complete UIA
 * form match become actionable. historyAnalysis must be the direct result of
 * the bounded local history parser. epoch is adapter-owned; sequence advances
 * for each fresh native UIA read. They are not native turn/item IDs. Decisions
 * must use a new UIA read, never a saved projection or cache. pendingForms also
 * carries the same-read identityProof tuple `{ sessionId,
 * expectedCandidateIndex, candidateCount, matchedCandidateIndex,
 * conversationHeaderMatches, historyFingerprint }`; the fingerprint is a
 * snapshot binding only, while the C# header/candidate fields carry native
 * identity evidence. Question forms carry one-based native `pageIndex` /
 * `pageCount` only when the reader sees its N/M progress text; a sole exact
 * history question may instead derive 1/1, labeled as such in the plan.
 */
class WorkBuddyUiaPendingController {
  constructor({ now = () => performance.now(), ttlMs = DEFAULT_TTL_MS, maxEntries = MAX_ACTIVE_ALIASES } = {}) {
    if (typeof now !== 'function' || !Number.isInteger(ttlMs) || ttlMs < 1 || ttlMs > MAX_TTL_MS ||
        !Number.isInteger(maxEntries) || maxEntries < 1 || maxEntries > MAX_ACTIVE_ALIASES) fail('invalid_params');
    this._now = now;
    this._ttlMs = ttlMs;
    this._maxEntries = maxEntries;
    this._entries = new Map();
    this._activeByIdentity = new Map();
    this._consumed = new Set();
    this._selection = null;
    this._lastSequence = -1;
    this._lastDecisionSequence = -1;
    this._retired = false;
    this._lastNow = 0;
  }

  observe(input) {
    if (this._retired) fail('stale_request');
    const observation = observationFromInput(input, ['sessionId', 'epoch', 'sequence', 'cwd', 'historyAnalysis', 'pendingForms']);
    const now = this._readNow();
    this._sweep(now);
    const nextSelection = selectionKey(observation.sessionId, observation.epoch);
    if (this._selection !== nextSelection) {
      this._clearEntries();
      this._selection = nextSelection;
      this._lastSequence = -1;
      this._lastDecisionSequence = -1;
    }
    if (observation.sequence <= this._lastSequence) {
      this._invalidateSelection();
      fail('stale_request');
    }
    this._lastSequence = observation.sequence;
    const built = buildPairs(observation);
    if (!built.valid) {
      this._invalidateSelection();
      return { pendingQuestions: [], pendingApprovals: [], desktopGuide: desktopGuideFor(observation.pendingForms?.forms) };
    }
    this._clearResolvedConsumed(observation.sessionId, observation.historyAnalysis.unresolvedCalls);
    const desired = new Set(built.pairs.map((pair) => identityKey(observation.sessionId, pair.kind, pair.candidate.callId)));
    for (const [identity, alias] of this._activeByIdentity) {
      const entry = this._entries.get(alias);
      if (entry?.sessionId === observation.sessionId && !desired.has(identity)) this._remove(alias);
    }
    const pendingQuestions = [];
    const pendingApprovals = [];
    const guides = [];
    for (const pair of built.pairs) {
      const key = identityKey(observation.sessionId, pair.kind, pair.candidate.callId);
      if (this._consumed.has(key)) {
        guides.push(pair.form);
        continue;
      }
      let alias = this._activeByIdentity.get(key);
      let entry = alias ? this._entries.get(alias) : null;
      if (entry && entry.formFingerprint !== pair.formFingerprint) {
        this._remove(alias);
        alias = undefined;
        entry = null;
      }
      // Renew only after this fresh complete observation matched the exact
      // same session, call, identity proof, form, and controls.
      if (entry) entry.expiresAt = now + this._ttlMs;
      if (!entry) {
        if (this._entries.size >= this._maxEntries) {
          guides.push(pair.form);
          continue;
        }
        alias = crypto.randomUUID();
        if (!UUID_V4.test(alias)) fail('bridge_error');
        const projected = pair.kind === 'question' ? pair.detail.normalized : null;
        if (pair.kind === 'question' && !projected) {
          guides.push(pair.form);
          continue;
        }
        entry = {
          alias,
          sessionId: observation.sessionId,
          epoch: observation.epoch,
          identityKey: key,
          kind: pair.kind,
          nativeCallId: pair.candidate.callId,
          toolName: pair.candidate.toolName,
          formFingerprint: pair.formFingerprint,
          form: pair.form,
          projectedQuestionIndexById: projected?.projectedQuestionIndexById,
          questions: projected?.questions,
          commandContext: pair.kind === 'command' ? pair.detail.context : undefined,
          actionControls: pair.kind === 'command' ? pair.detail.actions : undefined,
          sequence: observation.sequence,
          createdAt: now,
          expiresAt: now + this._ttlMs,
        };
        this._entries.set(alias, entry);
        this._activeByIdentity.set(key, alias);
      }
      if (pair.kind === 'question') {
        pendingQuestions.push({ callId: alias, state: 'open', questions: entry.questions.map((question) => cloneBoundedJson(question)) });
      } else {
        pendingApprovals.push({
          id: alias,
          toolName: entry.toolName,
          reason: pair.form.visibleText,
          context: cloneBoundedJson(entry.commandContext),
        });
      }
    }
    if (pendingQuestions.length > MAX_PENDING_BATCHES) {
      for (const batch of pendingQuestions) {
        const entry = this._entries.get(batch.callId);
        if (entry) guides.push(entry.form);
        this._remove(batch.callId);
      }
      pendingQuestions.length = 0;
    }
    if (pendingApprovals.length > MAX_PENDING_APPROVALS) {
      for (const approval of pendingApprovals) {
        const entry = this._entries.get(approval.id);
        if (entry) guides.push(entry.form);
        this._remove(approval.id);
      }
      pendingApprovals.length = 0;
    }
    return deepFreeze({
      pendingQuestions,
      pendingApprovals,
      desktopGuide: desktopGuideFor([...built.guideForms, ...guides]),
    });
  }

  /**
   * Verify a new native UIA observation, consume its phone alias, and return an
   * immutable one-shot plan. Never retry a returned plan after an unknown
   * native outcome.
   */
  prepareDecision(input) {
    if (this._retired) fail('stale_request');
    const allowedFields = ['alias', 'sessionId', 'epoch', 'sequence', 'cwd', 'historyAnalysis', 'pendingForms', 'answers', 'decision'];
    const source = closedRecord(input, allowedFields, ['alias', 'sessionId', 'epoch', 'sequence', 'historyAnalysis', 'pendingForms']);
    if (!isUuidV4(source.alias) || !isSessionId(source.sessionId) || !isGeneration(source.epoch) ||
        !Number.isSafeInteger(source.sequence) || source.sequence < 0 ||
        (source.cwd !== undefined && !exactWindowsPath(source.cwd))) fail('invalid_params');
    const alias = source.alias;
    const entry = this._entries.get(alias);
    if (!entry) fail('stale_request');
    const now = this._readNow();
    if (now >= entry.expiresAt) {
      this._remove(alias);
      fail('stale_request');
    }
    const stale = source.sessionId !== entry.sessionId || source.epoch !== entry.epoch ||
      source.sequence <= entry.sequence || source.sequence <= this._lastSequence || source.sequence <= this._lastDecisionSequence;
    let observation;
    let built;
    if (!stale) {
      try {
        observation = observationFromInput(source, allowedFields);
        built = buildPairs(observation);
      } catch {
        this._remove(alias);
        fail('stale_request');
      }
    }
    if (stale || !built?.valid) {
      this._remove(alias);
      fail('stale_request');
    }
    const match = built.pairs.find((pair) => pair.kind === entry.kind && pair.candidate.callId === entry.nativeCallId &&
      pair.formFingerprint === entry.formFingerprint);
    if (!match) {
      this._remove(alias);
      fail('stale_request');
    }

    let plan;
    if (entry.kind === 'question') {
      if (source.decision !== undefined || source.answers === undefined) fail('invalid_params');
      plan = {
        kind: 'question',
        sessionId: entry.sessionId,
        // Internal adapter correlation only. The adapter strips this field and
        // all phone aliases before constructing the native helper request.
        nativeCallId: entry.nativeCallId,
        // Exact sanitized local call metadata in source order; ids remain
        // optional and unchanged. UIA-derived page identity stays in proof.
        questions: cloneBoundedJson(match.candidate.questions),
        answers: validateQuestionAnswers(entry, source.answers),
        controls: cloneBoundedJson(match.form.controls),
        freshFormProof: this._freshProof(entry, match, observation.sequence),
      };
    } else {
      if (source.answers !== undefined || !APPROVAL_DECISIONS.includes(source.decision)) fail('invalid_params');
      const control = entry.actionControls.get(source.decision);
      const freshControl = match.form.controls.find((candidate) => candidate.runtimeIdHash === control.runtimeIdHash &&
        candidate.pathHash === control.pathHash && candidate.accessibleName === control.accessibleName && candidate.enabled === true);
      if (!freshControl) {
        this._remove(alias);
        fail('stale_request');
      }
      plan = {
        kind: 'approval',
        sessionId: entry.sessionId,
        nativeCallId: entry.nativeCallId,
        decision: source.decision,
        context: cloneBoundedJson(entry.commandContext),
        targetControl: cloneBoundedJson(freshControl),
        freshFormProof: this._freshProof(entry, match, observation.sequence),
      };
    }
    this._remove(alias);
    this._consumed.add(entry.identityKey);
    this._lastDecisionSequence = observation.sequence;
    return deepFreeze(plan);
  }

  invalidateSession(sessionId) {
    if (!isSessionId(sessionId)) fail('invalid_params');
    for (const [alias, entry] of this._entries) {
      if (entry.sessionId === sessionId) this._remove(alias);
    }
  }

  retire() {
    if (this._retired) return;
    this._retired = true;
    this._entries.clear();
    this._activeByIdentity.clear();
    this._consumed.clear();
    this._selection = null;
    this._lastSequence = -1;
    this._lastDecisionSequence = -1;
  }

  _freshProof(entry, match, sequence) {
    const proof = {
      sessionId: entry.sessionId,
      epoch: entry.epoch,
      sequence,
      expectedCandidateIndex: match.identityProof.expectedCandidateIndex,
      candidateCount: match.identityProof.candidateCount,
      matchedCandidateIndex: match.identityProof.matchedCandidateIndex,
      conversationHeaderMatches: match.identityProof.conversationHeaderMatches,
      historyFingerprint: match.identityProof.historyFingerprint,
      conversationRegionHash: match.form.conversationRegionHash,
      scopePathHash: match.form.scopePathHash,
      runtimeIdHashes: match.form.controls.filter(isActionControl).map((control) => control.runtimeIdHash),
      // This is a derived form fingerprint, not a native turn or item identity.
      formFingerprint: match.formFingerprint,
    };
    if (entry.kind === 'question') {
      proof.pageIndex = match.detail.pageIndex;
      proof.pageCount = match.detail.pageCount;
      proof.selectedCount = match.form.selectedCount;
      proof.selectedCountSource = match.form.selectedCountSource;
      proof.questionIndexSource = match.detail.questionIndexSource;
    }
    return proof;
  }

  _clearResolvedConsumed(sessionId, unresolvedCalls) {
    const unresolvedIds = new Set(unresolvedCalls.map((call) => call.callId));
    for (const identity of this._consumed) {
      const [knownSessionId, , callId] = JSON.parse(identity);
      if (knownSessionId === sessionId && !unresolvedIds.has(callId)) this._consumed.delete(identity);
    }
  }

  _clearEntries() {
    this._entries.clear();
    this._activeByIdentity.clear();
  }

  _invalidateSelection() {
    for (const [alias, entry] of this._entries) {
      if (selectionKey(entry.sessionId, entry.epoch) === this._selection) this._remove(alias);
    }
  }

  _remove(alias) {
    const entry = this._entries.get(alias);
    if (!entry) return;
    this._entries.delete(alias);
    if (this._activeByIdentity.get(entry.identityKey) === alias) this._activeByIdentity.delete(entry.identityKey);
  }

  _sweep(now) {
    for (const [alias, entry] of this._entries) {
      if (now >= entry.expiresAt) this._remove(alias);
    }
  }

  _readNow() {
    const current = this._now();
    if (typeof current !== 'number' || !Number.isFinite(current) || current < 0) fail('bridge_error');
    this._lastNow = Math.max(this._lastNow, current);
    return this._lastNow;
  }
}

module.exports = {
  WorkBuddyUiaPendingController,
  WorkBuddyUiaPendingControllerError,
  fingerprintHistoryAnalysis,
};
