'use strict';

/**
 * Analyze an already parsed, bounded WorkBuddy JSONL history. This module is
 * evidence for matching a native UIA card/form; it never claims that an item is
 * live, actionable, or a current pending request.
 */

const path = require('node:path');
const {
  isCallId,
  isSessionId,
  MAX_PENDING_QUESTIONS,
  MAX_PENDING_OPTIONS,
  MAX_QUESTION_TEXT,
  MAX_QUESTION_HEADER,
  MAX_QUESTION_DETAIL,
  MAX_OPTION_LABEL,
  MAX_OPTION_DESCRIPTION,
} = require('../protocol');

const MAX_HISTORY_RECORDS = 5000;
const MAX_HISTORY_BYTES = 4 * 1024 * 1024;
const MAX_RECORD_BYTES = 512 * 1024;
const MAX_APPROVAL_COMMAND = 4000;
const MAX_JSON_DEPTH = 24;
const MAX_OBJECT_FIELDS = 1024;
const MAX_JSON_ARRAY_LENGTH = 5000;

const QUESTION_TOOLS = new Set(['askuserquestion', 'ask_user_question']);
const COMMAND_TOOLS = new Set(['bash', 'powershell', 'run_command', 'execute_command']);
const COMMAND_BREAKING_CONTROLS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u;
const CREDENTIAL_TEXT = /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\bBearer\s+[A-Za-z0-9._~+/-]{12,}|\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b|\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|password|passwd|secret|credential)\b\s*[:=]\s*["']?[^\s"'`,;]{4,}|(?:^|\s)--?(?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|password|passwd|secret|authorization)(?:\s+|=)[^\s]{4,}/iu;
const SENSITIVE_KEY = /(?:api[_-]?key|access[_-]?token|refresh[_-]?token|\btoken\b|authorization|password|passwd|secret|credential)/iu;

function addIssue(issues, issue) {
  if (!issues.includes(issue)) issues.push(issue);
}

function isPlainRecord(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  try {
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  } catch {
    return false;
  }
}

/** Copy only JSON data, rejecting accessors, cycles, class instances, and excess structure. */
function cloneBoundedJson(value, state, depth = 0) {
  if (depth > MAX_JSON_DEPTH) throw new Error('depth');
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('number');
    return value;
  }
  if (typeof value !== 'object') throw new Error('type');
  if (state.seen.has(value)) throw new Error('cycle');
  state.seen.add(value);

  let symbols;
  try { symbols = Object.getOwnPropertySymbols(value); } catch { throw new Error('object'); }
  if (symbols.length !== 0) throw new Error('symbol');

  if (Array.isArray(value)) {
    if (value.length > MAX_JSON_ARRAY_LENGTH) throw new Error('array');
    let names;
    try { names = Object.getOwnPropertyNames(value); } catch { throw new Error('array'); }
    if (names.length !== value.length + 1 || names.at(-1) !== 'length') throw new Error('array');
    const copy = [];
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor || !Object.hasOwn(descriptor, 'value') || !descriptor.enumerable) throw new Error('array');
      copy.push(cloneBoundedJson(descriptor.value, state, depth + 1));
    }
    return copy;
  }

  if (!isPlainRecord(value)) throw new Error('prototype');
  let names;
  try { names = Object.getOwnPropertyNames(value); } catch { throw new Error('object'); }
  if (names.length > MAX_OBJECT_FIELDS) throw new Error('fields');
  const copy = Object.create(null);
  for (const name of names) {
    const descriptor = Object.getOwnPropertyDescriptor(value, name);
    if (!descriptor || !Object.hasOwn(descriptor, 'value') || !descriptor.enumerable) throw new Error('property');
    copy[name] = cloneBoundedJson(descriptor.value, state, depth + 1);
  }
  return copy;
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function own(object, key) {
  return Object.hasOwn(object, key);
}

function parseArguments(value) {
  if (isPlainRecord(value)) return value;
  if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > MAX_RECORD_BYTES) return null;
  try {
    const parsed = JSON.parse(value);
    return isPlainRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function nativeCallId(record) {
  if (own(record, 'callId')) return isCallId(record.callId) ? record.callId : null;
  return isCallId(record.id) ? record.id : null;
}

function safeToolName(value) {
  return typeof value === 'string' && value.trim() === value && value.length > 0 && value.length <= 128 &&
    !/[\u0000-\u001f\u007f]/u.test(value) ? value : null;
}

function containsCredential(value, key = '') {
  if (SENSITIVE_KEY.test(key)) {
    if (value === true || value === false || value === null || value === undefined || value === '') return false;
    return true;
  }
  if (typeof value === 'string') return CREDENTIAL_TEXT.test(value);
  if (Array.isArray(value)) return value.some((entry) => containsCredential(entry));
  if (isPlainRecord(value)) return Object.entries(value).some(([name, entry]) => containsCredential(entry, name));
  return false;
}

function hasTruncationMarker(value) {
  if (Array.isArray(value)) return value.some(hasTruncationMarker);
  if (!isPlainRecord(value)) return false;
  if (value._compactTruncated === true || value.compactTruncated === true || value.truncated === true) return true;
  return Object.values(value).some(hasTruncationMarker);
}

function exactWindowsAbsolutePath(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 4096 || value.trim() !== value ||
      /[\u0000-\u001f\u007f/]/u.test(value) || /^\\\\[?.]\\/u.test(value) || !path.win32.isAbsolute(value)) return false;
  const hasDriveRoot = /^[A-Za-z]:\\/u.test(value);
  const hasUncRoot = /^\\\\[^\\/]+\\[^\\/]+(?:\\|$)/u.test(value);
  if (!hasDriveRoot && !hasUncRoot) return false;
  const pieces = value.replace(/^[A-Za-z]:\\/u, '').replace(/^\\\\[^\\/]+\\[^\\/]+(?:\\|$)/u, '').split('\\');
  return !pieces.some((piece) => piece === '.' || piece === '..');
}

function normalizedWindowsPath(value) {
  return path.win32.normalize(value).replace(/[\\/]$/u, '').toLocaleLowerCase('en-US');
}

function resolveCommandCwd(commandRecord, args, sessionCwd) {
  if (!exactWindowsAbsolutePath(sessionCwd)) return null;
  const sources = [];
  sources.push(sessionCwd);
  if (own(commandRecord, 'cwd')) sources.push(commandRecord.cwd);
  if (own(args, 'cwd')) sources.push(args.cwd);
  if (!sources.every(exactWindowsAbsolutePath)) return null;
  const normalized = new Set(sources.map(normalizedWindowsPath));
  if (normalized.size !== 1) return null;
  return sessionCwd;
}

function normalizeQuestions(source) {
  if (!Array.isArray(source) || source.length === 0 || source.length > MAX_PENDING_QUESTIONS) return null;
  const seenIds = new Set();
  const questions = [];
  for (const input of source) {
    if (!isPlainRecord(input)) return null;
    const allowed = new Set(['id', 'question', 'header', 'detail', 'options', 'multiSelect', 'allowCustom', 'isOther', 'isSecret']);
    if (Object.keys(input).some((key) => !allowed.has(key))) return null;
    if (input.isSecret === true || (input.isSecret !== undefined && typeof input.isSecret !== 'boolean')) return null;
    if (input.isOther !== undefined && typeof input.isOther !== 'boolean') return null;
    // WorkBuddy 5.7.7's renderer assigns a display/answer key when the source
    // question has no id. Keep that native id optional here; a bridge-side
    // alias, if needed, belongs to the live UIA adapter and is not source data.
    const hasNativeId = own(input, 'id');
    if ((hasNativeId && (!isCallId(input.id) || seenIds.has(input.id))) ||
        typeof input.question !== 'string' || input.question.trim() === '' ||
        [...input.question].length > MAX_QUESTION_TEXT) return null;
    if (hasNativeId) seenIds.add(input.id);
    const question = { question: input.question };
    if (hasNativeId) question.id = input.id;

    for (const [key, limit] of [['header', MAX_QUESTION_HEADER], ['detail', MAX_QUESTION_DETAIL]]) {
      if (input[key] !== undefined && input[key] !== null) {
        if (typeof input[key] !== 'string' || [...input[key]].length > limit) return null;
        if (input[key].length > 0) question[key] = input[key];
      }
    }

    if (input.options !== undefined && input.options !== null) {
      if (!Array.isArray(input.options) || input.options.length === 0 || input.options.length > MAX_PENDING_OPTIONS) return null;
      const seenLabels = new Set();
      question.options = [];
      for (const option of input.options) {
        if (!isPlainRecord(option) || Object.keys(option).some((key) => !['label', 'description'].includes(key)) ||
            typeof option.label !== 'string' || option.label.trim() === '' || [...option.label].length > MAX_OPTION_LABEL ||
            seenLabels.has(option.label)) return null;
        seenLabels.add(option.label);
        const safeOption = { label: option.label };
        if (option.description !== undefined && option.description !== null) {
          if (typeof option.description !== 'string' || [...option.description].length > MAX_OPTION_DESCRIPTION) return null;
          if (option.description.length > 0) safeOption.description = option.description;
        }
        question.options.push(safeOption);
      }
    }

    for (const key of ['multiSelect', 'allowCustom']) {
      if (input[key] !== undefined) {
        if (typeof input[key] !== 'boolean') return null;
        if (input[key] || key === 'allowCustom') question[key] = input[key];
      }
    }
    if (input.isOther === true && input.allowCustom === false) return null;
    if (input.isOther === true) question.allowCustom = true;
    questions.push(question);
  }
  return questions;
}

function readOptions(input) {
  if (!isPlainRecord(input)) return null;
  try {
    const symbols = Object.getOwnPropertySymbols(input);
    const names = Object.getOwnPropertyNames(input);
    if (symbols.length !== 0 || names.some((key) => !['sessionId', 'cwd', 'historyTruncated'].includes(key))) return null;
    const result = Object.create(null);
    for (const name of names) {
      const descriptor = Object.getOwnPropertyDescriptor(input, name);
      if (!descriptor || !Object.hasOwn(descriptor, 'value') || !descriptor.enumerable) return null;
      result[name] = descriptor.value;
    }
    return result;
  } catch {
    return null;
  }
}

function analyzeNativeHistory(records, inputOptions = {}) {
  const options = readOptions(inputOptions);
  const sessionId = options && isSessionId(options.sessionId) ? options.sessionId : null;
  const issues = [];
  let historyComplete = options !== null && options.historyTruncated === false;
  if (!options) addIssue(issues, 'invalid_options');
  else if (options.historyTruncated !== false) addIssue(issues, options.historyTruncated === true ? 'truncated_history' : 'history_completeness_unknown');
  if (sessionId === null) {
    historyComplete = false;
    addIssue(issues, 'invalid_session');
  }
  if (!Array.isArray(records) || records.length > MAX_HISTORY_RECORDS) {
    historyComplete = false;
    addIssue(issues, 'invalid_or_oversize_records');
  }

  const safeRecords = [];
  let totalBytes = 0;
  if (Array.isArray(records) && records.length <= MAX_HISTORY_RECORDS) {
    for (const record of records) {
      try {
        if (!isPlainRecord(record)) throw new Error('record');
        const safe = cloneBoundedJson(record, { seen: new Set() });
        const encoded = JSON.stringify(safe);
        const bytes = Buffer.byteLength(encoded, 'utf8');
        if (bytes > MAX_RECORD_BYTES) throw new Error('record_bytes');
        totalBytes += bytes;
        if (totalBytes > MAX_HISTORY_BYTES) throw new Error('total_bytes');
        if (hasTruncationMarker(safe)) {
          historyComplete = false;
          addIssue(issues, 'truncated_record');
        }
        safeRecords.push(safe);
      } catch {
        historyComplete = false;
        addIssue(issues, 'malformed_record');
      }
    }
  }
  if (totalBytes > MAX_HISTORY_BYTES) {
    historyComplete = false;
    addIssue(issues, 'oversize_history');
  }
  if (safeRecords.length !== records?.length) historyComplete = false;

  const callsById = new Map();
  const callIdsByRecordId = new Map();
  const firstCallAt = new Map();
  const resultAt = new Map();
  for (let index = 0; index < safeRecords.length; index += 1) {
    const record = safeRecords[index];
    if (record.type === 'function_call') {
      const callId = nativeCallId(record);
      const toolName = safeToolName(record.name);
      if (!callId || !toolName) {
        historyComplete = false;
        addIssue(issues, 'malformed_call_identity');
        continue;
      }
      const argsFingerprint = stableJson(record.arguments);
      const recordId = isCallId(record.id) ? record.id : undefined;
      const existing = callsById.get(callId);
      let duplicateRecordIdentity = false;
      if (recordId !== undefined) {
        const previousCallId = callIdsByRecordId.get(recordId);
        if (previousCallId !== undefined && previousCallId !== callId) {
          duplicateRecordIdentity = true;
          const previous = callsById.get(previousCallId);
          if (previous) previous.conflicted = true;
          if (existing) existing.conflicted = true;
          addIssue(issues, 'duplicate_record_identity');
        } else {
          callIdsByRecordId.set(recordId, callId);
        }
      }
      if (!existing) {
        callsById.set(callId, {
          callId,
          toolName,
          recordId,
          record,
          argsFingerprint,
          conflicted: duplicateRecordIdentity,
        });
        firstCallAt.set(callId, index);
      } else if (existing.toolName !== toolName || existing.argsFingerprint !== argsFingerprint) {
        existing.conflicted = true;
        addIssue(issues, 'conflicting_call_identity');
      }
    } else if (record.type === 'function_call_result') {
      const callId = nativeCallId(record);
      if (!callId) {
        historyComplete = false;
        addIssue(issues, 'malformed_result_identity');
      } else if (!resultAt.has(callId)) {
        resultAt.set(callId, index);
      }
    }
  }

  const result = {
    sessionId,
    complete: historyComplete,
    unresolvedCalls: [],
    commandCandidates: [],
    questionCandidates: [],
    issues,
  };
  if (!historyComplete) return result;

  for (const [callId, call] of callsById) {
    if (resultAt.has(callId) && resultAt.get(callId) > firstCallAt.get(callId)) continue;
    result.unresolvedCalls.push({
      callId,
      toolName: call.conflicted ? null : call.toolName,
      ...(call.recordId !== undefined ? { recordId: call.recordId } : {}),
      ...(call.conflicted ? { ambiguous: true } : {}),
    });
    if (call.conflicted) continue;

    const toolKey = call.toolName.toLocaleLowerCase('en-US');
    const args = parseArguments(call.record.arguments);
    if (QUESTION_TOOLS.has(toolKey)) {
      const candidate = { callId, toolName: call.toolName, complete: false };
      if (call.recordId !== undefined) candidate.recordId = call.recordId;
      const rawQuestions = args?.questions;
      const questions = normalizeQuestions(rawQuestions);
      if (args && !containsCredential(args) && questions) {
        candidate.complete = true;
        candidate.questions = questions;
      } else {
        candidate.metadata = {
          ...(Array.isArray(rawQuestions) ? { questionCount: rawQuestions.length } : {}),
        };
      }
      result.questionCandidates.push(candidate);
      continue;
    }

    if (COMMAND_TOOLS.has(toolKey)) {
      const candidate = { callId, toolName: call.toolName, complete: false };
      if (call.recordId !== undefined) candidate.recordId = call.recordId;
      const command = args?.command;
      const commandIsSafe = typeof command === 'string' && command.trim().length > 0 && [...command].length <= MAX_APPROVAL_COMMAND &&
        !COMMAND_BREAKING_CONTROLS.test(command) && !containsCredential(args);
      if (commandIsSafe) {
        const cwd = resolveCommandCwd(call.record, args, options.cwd);
        if (cwd !== null) {
          candidate.complete = true;
          candidate.scopeContext = { kind: 'command', command, cwd };
        } else {
          candidate.metadata = { commandText: command };
        }
      } else {
        candidate.metadata = {};
      }
      result.commandCandidates.push(candidate);
    }
  }
  return result;
}

module.exports = { analyzeNativeHistory };
