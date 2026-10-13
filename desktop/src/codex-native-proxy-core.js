'use strict';

/**
 * State machine for a transparent Codex Desktop app-server stdio proxy.
 *
 * It stores only live control metadata (never message/history payloads). Every
 * remote decision must resolve to one native JSON-RPC request with the exact
 * thread/turn/item tuple. The Desktop UI and the bridge race through this same
 * state machine, so at most one response can reach the child process.
 */

const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');

const NATIVE_REQUEST_METHODS = new Map([
  ['item/tool/requestUserInput', 'question'],
  ['item/commandExecution/requestApproval', 'command-approval'],
  ['item/fileChange/requestApproval', 'file-change-approval'],
]);
const DEFAULT_INTERRUPT_CONFIRM_MS = 3500;
const MAX_PENDING_NATIVE_REQUESTS = 64;
const MAX_NATIVE_ID_LENGTH = 256;
const MAX_QUESTION_COUNT = 12;
const MAX_QUESTION_OPTIONS = 12;
const MAX_QUESTION_TEXT = 1000;
const MAX_OPTION_TEXT = 256;
const MAX_CUSTOM_ANSWER = 1000;
const MAX_COMMAND_TEXT = 4000;
const MAX_CWD_TEXT = 1024;
const MAX_REASON_TEXT = 3000;
const MAX_FILE_CHANGE_SUMMARY = 4000;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const RETIRED_RPC_LIMIT = 512;

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validNativeRpcId(value) {
  return (typeof value === 'string' && value.length > 0 && value.length <= MAX_NATIVE_ID_LENGTH) ||
    (typeof value === 'number' && Number.isSafeInteger(value));
}

function nativeIdKey(value) {
  return `${typeof value}:${JSON.stringify(value)}`;
}

function boundedText(value, max) {
  return typeof value === 'string' && value.trim().length > 0 && [...value].length <= max &&
    !/[\u0000-\u001f\u007f]/u.test(value);
}

function boundedMultilineText(value, max) {
  return typeof value === 'string' && value.trim().length > 0 && [...value].length <= max &&
    !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value);
}

function safeNativeQuestion(question) {
  if (!isRecord(question) || !boundedText(question.id, 200) || !boundedMultilineText(question.question, MAX_QUESTION_TEXT)) return null;
  if (Object.keys(question).some((key) => !['id', 'header', 'detail', 'question', 'isOther', 'isSecret', 'options', 'multiSelect'].includes(key))) return null;
  if (question.isSecret === true) return null;
  if (question.isSecret !== undefined && typeof question.isSecret !== 'boolean') return null;
  if (question.isOther !== undefined && typeof question.isOther !== 'boolean') return null;
  const result = { id: question.id, question: question.question };
  for (const key of ['header', 'detail']) {
    if (question[key] !== undefined) {
      if (typeof question[key] !== 'string' || [...question[key]].length > (key === 'header' ? 80 : 500) ||
          /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(question[key])) return null;
      if (question[key].trim().length === 0) continue;
      result[key] = question[key];
    }
  }
  if (question.options !== undefined && question.options !== null) {
    if (!Array.isArray(question.options) || question.options.length > MAX_QUESTION_OPTIONS) return null;
    const options = [];
    for (const option of question.options) {
      if (!isRecord(option) || Object.keys(option).some((key) => !['label', 'description'].includes(key)) ||
          typeof option.label !== 'string' || [...option.label].length > MAX_OPTION_TEXT ||
          /[\u0000-\u001f\u007f]/u.test(option.label)) return null;
      if (option.label.trim().length === 0) return null;
      const entry = { label: option.label };
      if (option.description !== undefined) {
        if (typeof option.description !== 'string' || [...option.description].length > 500 ||
            /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(option.description)) return null;
        if (option.description.trim().length > 0) entry.description = option.description;
      }
      options.push(entry);
    }
    if (options.length > 0) result.options = options;
  }
  if (question.multiSelect === true) result.multiSelect = true;
  result.nativeAllowOther = question.isOther === true;
  return result;
}

function looksCredentialBearing(value) {
  return /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|passwd|secret|authorization)\s*[:=]\s*["']?[A-Za-z0-9_./+=-]{8,}/iu.test(value) ||
    /\bBearer\s+[A-Za-z0-9._~+/-]{12,}/iu.test(value);
}

function normalizeReason(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  if (!boundedMultilineText(value, MAX_REASON_TEXT) || looksCredentialBearing(value)) return null;
  return value;
}

function commandActionSummary(actions) {
  if (actions === undefined || actions === null) return [];
  if (!Array.isArray(actions) || actions.length > 64) return null;
  const lines = [];
  for (const action of actions) {
    if (!isRecord(action) || typeof action.type !== 'string') return null;
    let line;
    if (action.type === 'read' && Object.keys(action).every((key) => ['type', 'command', 'name', 'path'].includes(key)) &&
        boundedText(action.command, MAX_COMMAND_TEXT) && boundedText(action.name, 256) && boundedText(action.path, MAX_CWD_TEXT)) {
      line = `Read ${action.name} at ${action.path}: ${action.command}`;
    } else if (action.type === 'listFiles' && Object.keys(action).every((key) => ['type', 'command', 'path'].includes(key)) &&
        boundedText(action.command, MAX_COMMAND_TEXT) && (action.path === null || boundedText(action.path, MAX_CWD_TEXT))) {
      line = `List files${action.path === null ? '' : ` at ${action.path}`}: ${action.command}`;
    } else if (action.type === 'search' && Object.keys(action).every((key) => ['type', 'command', 'query', 'path'].includes(key)) &&
        boundedText(action.command, MAX_COMMAND_TEXT) && (action.query === null || boundedMultilineText(action.query, MAX_COMMAND_TEXT)) &&
        (action.path === null || boundedText(action.path, MAX_CWD_TEXT))) {
      line = `Search${action.query === null ? '' : ` for ${action.query}`}${action.path === null ? '' : ` at ${action.path}`}: ${action.command}`;
    } else if (action.type === 'unknown' && Object.keys(action).every((key) => ['type', 'command'].includes(key)) && boundedText(action.command, MAX_COMMAND_TEXT)) {
      line = `Unclassified command action: ${action.command}`;
    } else return null;
    if (looksCredentialBearing(line)) return null;
    lines.push(`- ${line}`);
  }
  return lines;
}

function withCommandActionContext(reason, params) {
  const lines = commandActionSummary(params.commandActions);
  if (lines === null) return null;
  if (lines.length === 0) return reason;
  const result = `${reason}\nNative command action preview:\n${lines.join('\n')}`;
  return [...result].length <= MAX_REASON_TEXT && !looksCredentialBearing(result) ? result : null;
}

function safeNetworkApproval(params) {
  const network = params.networkApprovalContext;
  if (!isRecord(network) || Object.keys(network).some((key) => !['host', 'protocol', 'port'].includes(key)) ||
      !boundedText(network.host, 253) || /[\s\/@?#]/u.test(network.host) ||
      !['http', 'https', 'socks5Tcp', 'socks5Udp'].includes(network.protocol)) return null;
  const decisions = decisionsForApproval(params);
  if (decisions === null || !decisions.includes('accept') || !decisions.includes('decline')) return null;
  const result = { networkHost: network.host, protocol: network.protocol, availableDecisions: ['accept', 'decline'], toolName: 'commandExecution' };
  const port = network.port ?? params.networkPort;
  if (port !== undefined && port !== null) {
    if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
    result.networkPort = port;
  }
  let reason = normalizeReason(params.reason, 'Codex requests permission for this network connection.');
  if (reason === null) return null;
  if ((params.command !== undefined && params.command !== null) || (params.cwd !== undefined && params.cwd !== null)) {
    if (!boundedMultilineText(params.command, MAX_COMMAND_TEXT) || !boundedText(params.cwd, MAX_CWD_TEXT) || looksCredentialBearing(params.command)) return null;
    reason = `${reason}\nRequested command: ${params.command}\nWorking directory: ${params.cwd}`;
  }
  reason = withCommandActionContext(reason, params);
  if (reason === null || !boundedMultilineText(reason, MAX_REASON_TEXT)) return null;
  result.reason = reason;
  return result;
}

function hasAdditionalPermissionGrant(params) {
  const value = params.additionalPermissions;
  if (value === undefined || value === null) return false;
  if (!isRecord(value)) return true;
  if (Object.keys(value).some((key) => !['fileSystem', 'network'].includes(key))) return true;
  const filesystem = value.fileSystem;
  const network = value.network;
  if (filesystem !== undefined && filesystem !== null) {
    if (!isRecord(filesystem)) return true;
    if (Object.keys(filesystem).some((key) => !['read', 'write', 'entries', 'globScanMaxDepth'].includes(key))) return true;
    if (filesystem.globScanMaxDepth !== undefined) return true;
    if (['read', 'write', 'entries'].some((key) => Array.isArray(filesystem[key]) && filesystem[key].length > 0)) return true;
    if (['read', 'write', 'entries'].some((key) => filesystem[key] !== undefined && filesystem[key] !== null && !Array.isArray(filesystem[key]))) return true;
  }
  if (network !== undefined && network !== null) {
    if (!isRecord(network) || Object.keys(network).some((key) => key !== 'enabled')) return true;
    if (network.enabled !== undefined && network.enabled !== null && network.enabled !== false) return true;
  }
  return false;
}

const COMMAND_APPROVAL_FIELDS = new Set([
  'kind', 'threadId', 'turnId', 'itemId', 'startedAtMs', 'reason',
  'networkApprovalContext', 'networkPort', 'command', 'cwd', 'availableDecisions',
  'additionalPermissions', 'proposedExecpolicyAmendment', 'proposedNetworkPolicyAmendments',
  'approvalId', 'environmentId', 'commandActions',
]);

function decisionsForApproval(params) {
  if (params.availableDecisions === undefined || params.availableDecisions === null) return ['accept', 'decline'];
  if (!Array.isArray(params.availableDecisions)) return null;
  for (const value of params.availableDecisions) {
    if (typeof value === 'string') {
      if (!['accept', 'acceptForSession', 'decline', 'cancel'].includes(value)) return null;
      continue;
    }
    if (!isRecord(value) || Object.keys(value).length !== 1) return null;
    if (Object.hasOwn(value, 'acceptWithExecpolicyAmendment')) {
      const proposal = value.acceptWithExecpolicyAmendment;
      if (!isRecord(proposal) || Object.keys(proposal).length !== 1 || !Array.isArray(proposal.execpolicy_amendment) ||
          proposal.execpolicy_amendment.some((item) => typeof item !== 'string')) return null;
    } else if (Object.hasOwn(value, 'applyNetworkPolicyAmendment')) {
      const proposal = value.applyNetworkPolicyAmendment;
      const amendment = proposal?.network_policy_amendment;
      if (!isRecord(proposal) || Object.keys(proposal).length !== 1 || !isRecord(amendment) ||
          Object.keys(amendment).some((key) => !['host', 'action'].includes(key)) ||
          typeof amendment.host !== 'string' || !['allow', 'deny'].includes(amendment.action)) return null;
    } else return null;
  }
  return params.availableDecisions.filter((value) => typeof value === 'string');
}

function safeCommandApproval(params) {
  if (params.kind !== undefined && params.kind !== 'command') return null;
  if (Object.keys(params).some((key) => !COMMAND_APPROVAL_FIELDS.has(key))) return null;
  if (hasAdditionalPermissionGrant(params)) return null;
  if (params.environmentId !== undefined && params.environmentId !== null) return null;
  // The amendment proposals are separate persistent decisions. This surface
  // only offers the native one-time `accept` or `decline` outcomes.
  if (params.networkApprovalContext !== undefined && params.networkApprovalContext !== null) {
    return safeNetworkApproval(params);
  }
  const command = params.command;
  const cwd = params.cwd;
  const decisions = decisionsForApproval(params);
  if (!boundedMultilineText(command, MAX_COMMAND_TEXT) || !boundedText(cwd, MAX_CWD_TEXT) ||
      looksCredentialBearing(command) || decisions === null || !decisions.includes('accept') || !decisions.includes('decline')) return null;
  const baseReason = normalizeReason(params.reason, 'Codex requests permission to run this command.');
  const reason = baseReason === null ? null : withCommandActionContext(baseReason, params);
  if (reason === null || !boundedMultilineText(reason, MAX_REASON_TEXT)) return null;
  return { command, cwd, reason, availableDecisions: ['accept', 'decline'], toolName: 'commandExecution' };
}

function filePatchCacheKey(threadId, turnId, itemId) {
  return JSON.stringify([threadId, turnId, itemId]);
}

function safeFilePatchSummary(changes) {
  if (!Array.isArray(changes) || changes.length === 0 || changes.length > 64) return null;
  const rows = [];
  for (const change of changes) {
    if (!isRecord(change) || Object.keys(change).some((key) => !['path', 'kind', 'diff'].includes(key)) ||
        !boundedText(change.path, MAX_CWD_TEXT) || !isRecord(change.kind) || !boundedMultilineText(change.diff, MAX_FILE_CHANGE_SUMMARY)) return null;
    const patchKind = change.kind.type;
    if (patchKind === 'add' || patchKind === 'delete') {
      if (Object.keys(change.kind).length !== 1) return null;
    } else if (patchKind === 'update') {
      if (Object.keys(change.kind).some((key) => !['type', 'move_path'].includes(key)) ||
          !Object.hasOwn(change.kind, 'move_path') ||
          (change.kind.move_path !== null && !boundedText(change.kind.move_path, MAX_CWD_TEXT))) return null;
    } else return null;
    if (looksCredentialBearing(change.diff)) return null;
    const move = patchKind === 'update' && change.kind.move_path !== null ? ` (moved from ${change.kind.move_path})` : '';
    rows.push(`--- ${patchKind}: ${change.path}${move}\n${change.diff}`);
  }
  const summary = rows.join('\n');
  return boundedMultilineText(summary, MAX_FILE_CHANGE_SUMMARY) ? summary : null;
}

function safeFileChangeApproval(params, patchSummary) {
  const allowed = new Set(['threadId', 'turnId', 'itemId', 'startedAtMs', 'reason', 'grantRoot']);
  if (Object.keys(params).some((key) => !allowed.has(key))) return null;
  if (!boundedMultilineText(patchSummary, MAX_FILE_CHANGE_SUMMARY) || hasAdditionalPermissionGrant(params)) return null;
  const grantRoot = params.grantRoot === undefined || params.grantRoot === null
    ? 'No additional write root requested.'
    : boundedText(params.grantRoot, MAX_CWD_TEXT) ? params.grantRoot : null;
  if (grantRoot === null) return null;
  const reason = normalizeReason(params.reason, 'Codex requests permission to apply these file changes.');
  if (reason === null) return null;
  return { summary: patchSummary, grantRoot, reason, availableDecisions: ['accept', 'decline'], toolName: 'fileChange' };
}

function nativeRequestFromMessage(message, options = {}) {
  if (!isRecord(message) || typeof message.method !== 'string' || !Object.prototype.hasOwnProperty.call(message, 'id') || !validNativeRpcId(message.id)) return null;
  const kind = NATIVE_REQUEST_METHODS.get(message.method);
  if (!kind || !isRecord(message.params)) return null;
  const { threadId, turnId, itemId } = message.params;
  if (!boundedText(threadId, 256) || !boundedText(turnId, 256) || !boundedText(itemId, 256)) return null;
  if (kind === 'question') {
    const source = message.params.questions;
    if (!Array.isArray(source) || source.length === 0 || source.length > MAX_QUESTION_COUNT) return null;
    const questions = source.map(safeNativeQuestion);
    if (questions.some((question) => question === null) || new Set(questions.map((question) => question.id)).size !== questions.length) return null;
    return { kind, method: message.method, nativeId: message.id, nativeKey: nativeIdKey(message.id), threadId, turnId, itemId, nativeParams: message.params, questions };
  }
  const approval = kind === 'file-change-approval'
    ? safeFileChangeApproval(message.params, options.patchSummary)
    : safeCommandApproval(message.params);
  if (approval === null) return null;
  const publicKind = kind === 'file-change-approval'
    ? 'file-change-approval'
    : approval.networkHost !== undefined ? 'network-approval' : 'command-approval';
    return {
      kind: publicKind,
      method: message.method,
      nativeId: message.id,
      nativeKey: nativeIdKey(message.id),
      threadId,
      turnId,
      itemId,
      ...(typeof message.params.approvalId === 'string' && message.params.approvalId.length > 0 ? { callId: message.params.approvalId } : {}),
      ...(kind === 'file-change-approval' ? { nativeParams: message.params } : {}),
      ...approval,
    };
}

function rpcMessageId(message) {
  if (!isRecord(message) || !Object.prototype.hasOwnProperty.call(message, 'id') || !validNativeRpcId(message.id)) return null;
  return message.id;
}

/** UTF-8 JSON-lines splitter that retains the original bytes for transparent forwarding. */
class JsonlTap {
  constructor({ maxLineBytes = 64 * 1024 * 1024, onLine, onError = () => {} }) {
    this.maxLineBytes = maxLineBytes;
    this.onLine = onLine;
    this.onError = onError;
    this.pending = Buffer.alloc(0);
    this.disabled = false;
  }

  push(chunk) {
    if (this.disabled) return [chunk];
    this.pending = this.pending.length === 0 ? chunk : Buffer.concat([this.pending, chunk]);
    const output = [];
    let newline;
    while ((newline = this.pending.indexOf(0x0a)) !== -1) {
      const line = this.pending.subarray(0, newline + 1);
      this.pending = this.pending.subarray(newline + 1);
      if (line.length > this.maxLineBytes) {
        this.disable(new Error('Codex app-server JSON line exceeds proxy safety limit'));
        output.push(line);
        if (this.pending.length > 0) {
          output.push(this.pending);
          this.pending = Buffer.alloc(0);
        }
        return output;
      }
      let message = null;
      try {
        message = JSON.parse(line.toString('utf8').replace(/[\r\n]+$/u, ''));
      } catch {
        // Invalid/non-JSON data still passes byte-for-byte; the native endpoints
        // remain responsible for deciding whether the line is valid JSON-RPC.
      }
      const forwarded = this.inspect(message, line);
      if (forwarded !== false) output.push(line);
    }
    if (this.pending.length > this.maxLineBytes) {
      const pending = this.pending;
      this.pending = Buffer.alloc(0);
      this.disable(new Error('Codex app-server JSON line exceeds proxy safety limit'));
      output.push(pending);
    }
    return output;
  }

  flush() {
    const line = this.pending;
    this.pending = Buffer.alloc(0);
    if (line.length === 0) return [];
    if (this.disabled || line.length > this.maxLineBytes) {
      if (line.length > this.maxLineBytes) this.disable(new Error('Codex app-server JSON line exceeds proxy safety limit'));
      return [line];
    }
    let message = null;
    try {
      message = JSON.parse(line.toString('utf8'));
    } catch {
      // Keep incomplete/non-JSON trailing bytes transparent on close.
    }
    return this.inspect(message, line) === false ? [] : [line];
  }

  inspect(message, line) {
    try { return this.onLine(message, line); } catch (error) {
      this.disable(error);
      return true;
    }
  }

  disable(error) {
    if (this.disabled) return;
    this.disabled = true;
    try { this.onError(error); } catch { /* Instrumentation cannot break the native stream. */ }
  }
}

class CodexNativeProxyCore extends EventEmitter {
  /** @param {{writeToNative:(line:string)=>Promise<void>|void, interruptConfirmMs?:number, now?:()=>number}} options */
  constructor(options) {
    super();
    if (typeof options?.writeToNative !== 'function') throw new TypeError('writeToNative is required');
    this.writeToNative = options.writeToNative;
    this.interruptConfirmMs = options.interruptConfirmMs ?? DEFAULT_INTERRUPT_CONFIRM_MS;
    this.now = options.now ?? Date.now;
    this.requests = new Map();
    this.nativeToBridge = new Map();
    this.tombstones = new Map();
    this.internalRpc = new Map();
    this.retiredInternalRpc = new Map();
    this.activeTurns = new Map();
    this.completedTurns = new Map();
    this.observedThreads = new Set();
    this.desktopOwnerRequests = new Map();
    this.filePatchCache = new Map();
    this.waitingFileRequests = new Map();
    this.interruptingTurns = new Set();
    this.closed = false;
    this.rpcPrefix = `codex-native-${crypto.randomUUID()}-`;
    this.rpcCounter = 1;
  }

  /**
   * Inspect one real child stdout JSON-RPC message. Returns true when it is an
   * internal proxy response that must not be shown to the Desktop app.
   */
  onNativeMessage(message) {
    if (!isRecord(message)) return false;
    const id = rpcMessageId(message);
    if (id !== null) {
      const key = nativeIdKey(id);
      if (this.retiredInternalRpc.delete(key)) return true;
      const internal = this.internalRpc.get(key);
      if (internal !== undefined) {
        this.internalRpc.delete(key);
        clearTimeout(internal.timer);
        if (message.error !== undefined) internal.reject(new Error('native app-server control request failed'));
        else internal.resolve(message.result);
        return true;
      }
    }

    if (typeof message.method !== 'string') return false;
    this.recordObservedThread(message.params?.threadId);
    if (message.method === 'turn/started') this.recordTurnStarted(message.params);
    if (message.method === 'turn/completed') this.recordTurnCompleted(message.params);
    if (message.method === 'serverRequest/resolved') this.resolveNativeRequest(message.params);
    if (message.method === 'item/fileChange/patchUpdated') this.recordFilePatch(message.params);
    if (message.method === 'item/completed') this.recordItemCompleted(message.params);
    if (['thread/closed', 'thread/archived', 'thread/removed', 'thread/deleted'].includes(message.method)) this.invalidateThread(message.params?.threadId);

    const kind = NATIVE_REQUEST_METHODS.get(message.method);
    if (kind !== undefined && !this.prepareNativeRequestGeneration(message)) return false;
    if (kind === 'file-change-approval') this.recordFileChangeRequest(message);
    else {
      const request = nativeRequestFromMessage(message);
      if (request !== null) this.recordNativeRequest(request);
    }
    return false;
  }

  prepareNativeRequestGeneration(message) {
    if (!validNativeRpcId(message.id)) return true;
    const key = nativeIdKey(message.id);
    const alias = this.nativeToBridge.get(key);
    const prior = alias === undefined ? null : this.requests.get(alias);
    const waiting = this.waitingFileRequests.get(key);
    const priorMessage = waiting?.message;
    const sameIdentity = (candidate) => {
      if (candidate === null || candidate === undefined || candidate.method !== message.method) return false;
      const params = candidate.nativeParams ?? candidate.params;
      return params?.threadId === message.params?.threadId && params?.turnId === message.params?.turnId &&
        params?.itemId === message.params?.itemId && JSON.stringify(params) === JSON.stringify(message.params);
    };
    if (sameIdentity(prior) || sameIdentity(priorMessage)) return false;
    if (prior !== null && prior !== undefined) this.removeLiveRequest(prior, 'superseded');
    this.waitingFileRequests.delete(key);
    this.tombstones.delete(key);
    return true;
  }

  /** Returns false only for a duplicate Desktop answer after the bridge won. */
  onDesktopMessage(message) {
    if (!isRecord(message)) return true;
    if (typeof message.method === 'string') {
      this.recordDesktopOwnershipRequest(message);
      return true;
    }
    const id = rpcMessageId(message);
    if (id === null) return true;
    const key = nativeIdKey(id);
    this.recordDesktopOwnershipResponse(key, message);
    const alias = this.nativeToBridge.get(key);
    if (alias === undefined) return !this.tombstones.has(key);
    const entry = this.requests.get(alias);
    if (entry === undefined) {
      this.nativeToBridge.delete(key);
      return true;
    }
    if (entry.state === 'remote-writing' || entry.state === 'remote-submitted') {
      return false;
    }
    if (entry.state === 'pending') this.removeLiveRequest(entry, 'desktop-submitted');
    return true;
  }

  recordObservedThread(threadId) {
    if (typeof threadId !== 'string' || threadId.length === 0 || threadId.length > 256) return;
    this.observedThreads.add(threadId);
    if (this.observedThreads.size > 2048) this.observedThreads.delete(this.observedThreads.values().next().value);
  }

  recordDesktopOwnershipRequest(message) {
    if (!['thread/resume', 'thread/start', 'thread/subscribe', 'thread/ensureStarted'].includes(message.method) || !isRecord(message.params)) return;
    const id = rpcMessageId(message);
    if (id === null) return;
    const threadId = message.params.threadId;
    if (typeof threadId === 'string' && threadId.length > 0) this.recordObservedThread(threadId);
    this.desktopOwnerRequests.set(nativeIdKey(id), { method: message.method, requestedThreadId: threadId });
    while (this.desktopOwnerRequests.size > 256) this.desktopOwnerRequests.delete(this.desktopOwnerRequests.keys().next().value);
  }

  recordDesktopOwnershipResponse(key, message) {
    const request = this.desktopOwnerRequests.get(key);
    if (request === undefined) return;
    this.desktopOwnerRequests.delete(key);
    if (message.error !== undefined) return;
    const result = message.result;
    const threadId = request.requestedThreadId ?? result?.thread?.id ?? result?.id ?? result?.threadId;
    this.recordObservedThread(threadId);
  }

  recordFileChangeRequest(message) {
    if (!isRecord(message.params) || !Object.prototype.hasOwnProperty.call(message, 'id') || !validNativeRpcId(message.id)) return;
    const { threadId, turnId, itemId } = message.params;
    if (!boundedText(threadId, 256) || !boundedText(turnId, 256) || !boundedText(itemId, 256)) return;
    this.recordObservedThread(threadId);
    const raw = { message, nativeKey: nativeIdKey(message.id), threadId, turnId, itemId };
    const key = filePatchCacheKey(threadId, turnId, itemId);
    this.waitingFileRequests.set(raw.nativeKey, raw);
    const patchSummary = this.filePatchCache.get(key);
    if (patchSummary !== undefined) this.promoteFileChangeRequest(raw, patchSummary);
    while (this.waitingFileRequests.size > MAX_PENDING_NATIVE_REQUESTS) {
      this.waitingFileRequests.delete(this.waitingFileRequests.keys().next().value);
    }
  }

  promoteFileChangeRequest(raw, patchSummary) {
    const request = nativeRequestFromMessage(raw.message, { patchSummary });
    if (request === null) return false;
    this.waitingFileRequests.delete(raw.nativeKey);
    this.recordNativeRequest(request);
    return true;
  }

  recordFilePatch(params) {
    if (!isRecord(params) || !boundedText(params.threadId, 256) || !boundedText(params.turnId, 256) || !boundedText(params.itemId, 256)) return;
    const key = filePatchCacheKey(params.threadId, params.turnId, params.itemId);
    const summary = safeFilePatchSummary(params.changes);
    if (summary === null) {
      this.filePatchCache.delete(key);
    } else {
      this.filePatchCache.set(key, summary);
      while (this.filePatchCache.size > 256) this.filePatchCache.delete(this.filePatchCache.keys().next().value);
    }
    for (const [nativeKey, raw] of [...this.waitingFileRequests]) {
      if (raw.threadId !== params.threadId || raw.turnId !== params.turnId || raw.itemId !== params.itemId) continue;
      if (summary === null) continue;
      this.promoteFileChangeRequest(raw, summary);
    }
    const entry = [...this.requests.values()].find((candidate) => candidate.kind === 'file-change-approval' &&
      candidate.threadId === params.threadId && candidate.turnId === params.turnId && candidate.itemId === params.itemId);
    if (summary === null) {
      if (entry !== undefined) this.removeLiveRequest(entry, 'context-unavailable');
      return;
    }
    // The patch is authorization context. If it changes while a decision is
    // pending, retire the old handle and publish a new alias for the new exact
    // diff. A stale phone submission can never approve the changed contents.
    if (summary !== null) {
      if (entry !== null && entry !== undefined && entry.kind === 'file-change-approval' && entry.summary !== summary) {
        this.removeLiveRequest(entry, 'context-changed');
        const updated = nativeRequestFromMessage({ jsonrpc: '2.0', id: entry.nativeId, method: entry.method, params: entry.nativeParams }, { patchSummary: summary });
        if (updated !== null) this.recordNativeRequest(updated);
      }
    }
  }

  recordItemCompleted(params) {
    const itemId = params?.item?.id ?? params?.itemId;
    const threadId = params?.threadId;
    const turnId = params?.turnId;
    if (typeof threadId !== 'string' || typeof itemId !== 'string') return;
    this.invalidateRequests((entry) => entry.threadId === threadId && entry.itemId === itemId && (turnId === undefined || entry.turnId === turnId), 'item-completed');
    for (const [nativeKey, raw] of this.waitingFileRequests) {
      if (raw.threadId === threadId && raw.itemId === itemId && (turnId === undefined || raw.turnId === turnId)) this.waitingFileRequests.delete(nativeKey);
    }
    if (typeof turnId === 'string') this.filePatchCache.delete(filePatchCacheKey(threadId, turnId, itemId));
  }

  invalidateRequests(predicate, disposition) {
    for (const entry of [...this.requests.values()]) if (predicate(entry)) this.removeLiveRequest(entry, disposition);
  }

  invalidateThread(threadId) {
    if (typeof threadId !== 'string' || threadId.length === 0) return;
    this.invalidateRequests((entry) => entry.threadId === threadId, 'thread-closed');
    for (const [nativeKey, raw] of this.waitingFileRequests) if (raw.threadId === threadId) this.waitingFileRequests.delete(nativeKey);
    for (const key of [...this.filePatchCache.keys()]) {
      try { if (JSON.parse(key)[0] === threadId) this.filePatchCache.delete(key); } catch { /* internal key only */ }
    }
    this.activeTurns.delete(threadId);
    this.observedThreads.delete(threadId);
  }

  recordNativeRequest(request) {
    this.recordObservedThread(request.threadId);
    const completed = this.completedTurns.get(`${request.threadId}\u0000${request.turnId}`);
    if (completed !== undefined || this.closed) return;
    // Native IDs can be reused after a request resolves. The new request owns
    // that typed ID from this point onward; its prior response tombstone must
    // not suppress the new generation.
    this.tombstones.delete(request.nativeKey);
    const priorAlias = this.nativeToBridge.get(request.nativeKey);
    const prior = priorAlias === undefined ? null : this.requests.get(priorAlias);
    if (prior !== null && prior !== undefined) {
      const same = prior.threadId === request.threadId && prior.turnId === request.turnId && prior.itemId === request.itemId && prior.method === request.method;
      if (same) return;
      this.removeLiveRequest(prior, 'superseded');
    }
    if (this.requests.size >= MAX_PENDING_NATIVE_REQUESTS || this.closed) return;
    const entry = { ...request, bridgeRequestId: crypto.randomUUID(), state: 'pending', createdAt: this.now() };
    this.requests.set(entry.bridgeRequestId, entry);
    this.nativeToBridge.set(entry.nativeKey, entry.bridgeRequestId);
    this.emit('request', this.publicRequest(entry));
  }

  publicRequest(entry) {
    const common = {
      id: entry.bridgeRequestId,
      kind: entry.kind,
      threadId: entry.threadId,
      turnId: entry.turnId,
      itemId: entry.itemId,
    };
    if (entry.kind === 'question') return {
      ...common,
      questions: entry.questions.map(({ nativeAllowOther, ...question }) => ({
        ...question,
        allowCustom: nativeAllowOther,
        options: question.options?.map((option) => ({ ...option })),
      })),
    };
    const approval = {
      ...common,
      toolName: entry.toolName,
      callId: entry.callId ?? entry.itemId,
      reason: entry.reason,
      availableDecisions: [...entry.availableDecisions],
    };
    if (entry.kind === 'command-approval') {
      approval.context = { kind: 'command', command: entry.command, cwd: entry.cwd };
    } else if (entry.kind === 'network-approval') {
      approval.context = { kind: 'network', networkHost: entry.networkHost, protocol: entry.protocol };
      if (entry.networkPort !== undefined) approval.context.networkPort = entry.networkPort;
    } else {
      approval.context = { kind: 'file-change', summary: entry.summary, grantRoot: entry.grantRoot };
    }
    return approval;
  }

  snapshot(threadId) {
    if (this.closed) return { threadId, observed: false, activeTurnId: null, requests: [] };
    const activeTurnId = this.activeTurns.get(threadId) ?? null;
    const requests = [];
    for (const entry of this.requests.values()) {
      if (entry.threadId === threadId && entry.state === 'pending') requests.push(this.publicRequest(entry));
    }
    return { threadId, observed: this.observedThreads.has(threadId), activeTurnId, requests };
  }

  removeLiveRequest(entry, disposition) {
    this.requests.delete(entry.bridgeRequestId);
    if (this.nativeToBridge.get(entry.nativeKey) === entry.bridgeRequestId) this.nativeToBridge.delete(entry.nativeKey);
    entry.state = disposition;
    this.tombstones.set(entry.nativeKey, { disposition, threadId: entry.threadId, at: this.now() });
    this.trimTombstones();
    this.emit('request-resolved', { id: entry.bridgeRequestId, threadId: entry.threadId, disposition });
  }

  trimTombstones() {
    const oldest = this.now() - 10 * 60 * 1000;
    for (const [key, value] of this.tombstones) if (value.at < oldest) this.tombstones.delete(key);
    while (this.tombstones.size > 4096) this.tombstones.delete(this.tombstones.keys().next().value);
  }

  resolveNativeRequest(params) {
    if (!isRecord(params) || !validNativeRpcId(params.requestId) || typeof params.threadId !== 'string') return;
    const key = nativeIdKey(params.requestId);
    const waiting = this.waitingFileRequests.get(key);
    if (waiting !== undefined && waiting.threadId === params.threadId) this.waitingFileRequests.delete(key);
    const alias = this.nativeToBridge.get(key);
    if (alias === undefined) return;
    const entry = this.requests.get(alias);
    if (entry === undefined || entry.threadId !== params.threadId) return;
    this.removeLiveRequest(entry, 'native-resolved');
  }

  recordTurnStarted(params) {
    const turn = params?.turn;
    const threadId = params?.threadId;
    if (typeof threadId !== 'string' || typeof turn?.id !== 'string' || turn.id.length === 0) return;
    if (this.completedTurns.has(`${threadId}\u0000${turn.id}`)) return;
    this.activeTurns.set(threadId, turn.id);
  }

  recordTurnCompleted(params) {
    const threadId = params?.threadId;
    const turn = params?.turn;
    if (typeof threadId !== 'string' || typeof turn?.id !== 'string' || turn.id.length === 0 || typeof turn.status !== 'string') return;
    const key = `${threadId}\u0000${turn.id}`;
    const outcome = { threadId, turnId: turn.id, status: turn.status, at: this.now() };
    this.completedTurns.set(key, outcome);
    while (this.completedTurns.size > 256) this.completedTurns.delete(this.completedTurns.keys().next().value);
    if (this.activeTurns.get(threadId) === turn.id) this.activeTurns.delete(threadId);
    this.invalidateRequests((entry) => entry.threadId === threadId && entry.turnId === turn.id, 'turn-completed');
    for (const [nativeKey, raw] of this.waitingFileRequests) {
      if (raw.threadId === threadId && raw.turnId === turn.id) this.waitingFileRequests.delete(nativeKey);
    }
    for (const patchKey of [...this.filePatchCache.keys()]) {
      try {
        const tuple = JSON.parse(patchKey);
        if (tuple[0] === threadId && tuple[1] === turn.id) this.filePatchCache.delete(patchKey);
      } catch { /* internal key only */ }
    }
    this.emit('turn-completed', outcome);
  }

  /**
   * Atomic, one-shot answer or explicit command-approval decision. The response
   * is sent to the existing child process as a server-request response.
   */
  async respond({ bridgeRequestId, threadId, itemId, answer }) {
    if (this.closed) throw new ProxyControlError('stale_request', 'Codex native connection is closed');
    if (typeof bridgeRequestId !== 'string' || !UUID_V4.test(bridgeRequestId)) throw new ProxyControlError('invalid_params', 'bridge request id is invalid');
    const entry = this.requests.get(bridgeRequestId);
    if (entry === undefined || entry.state !== 'pending' || entry.threadId !== threadId || entry.itemId !== itemId) {
      throw new ProxyControlError('stale_request', 'the native request is no longer waiting');
    }
    const nativeResult = entry.kind === 'question'
      ? this.buildQuestionResult(entry, answer)
      : this.buildApprovalResult(entry, answer);
    entry.state = 'remote-writing';
    try {
      await this.writeToNative(`${JSON.stringify({ jsonrpc: '2.0', id: entry.nativeId, result: nativeResult })}\n`);
      this.removeLiveRequest(entry, 'remote-submitted');
      return { state: 'submitted' };
    } catch {
      // Once the bytes may have reached the native stream, a second decision is
      // unsafe. The request is invalidated and the caller is told to re-read.
      this.removeLiveRequest(entry, 'remote-submitted');
      throw new ProxyControlError('bridge_error', 'Codex could not confirm the response submission; re-read the session');
    }
  }

  buildQuestionResult(entry, answer) {
    if (!isRecord(answer) || Object.keys(answer).some((key) => key !== 'answers') || !Array.isArray(answer.answers)) {
      throw new ProxyControlError('invalid_params', 'a question answer batch is required');
    }
    if (answer.answers.length !== entry.questions.length) throw new ProxyControlError('invalid_params', 'answer each native question exactly once');
    const byId = new Map(entry.questions.map((question) => [question.id, question]));
    const seen = new Set();
    const answers = Object.create(null);
    for (const selectedAnswer of answer.answers) {
      if (!isRecord(selectedAnswer) || Object.keys(selectedAnswer).some((key) => !['id', 'selected', 'custom'].includes(key))) {
        throw new ProxyControlError('invalid_params', 'a question answer has an unsupported field');
      }
      const question = byId.get(selectedAnswer.id);
      if (question === undefined || seen.has(selectedAnswer.id) || !Array.isArray(selectedAnswer.selected)) {
        throw new ProxyControlError('invalid_params', 'answer ids must match the native form exactly');
      }
      seen.add(selectedAnswer.id);
      if (selectedAnswer.selected.length > MAX_QUESTION_OPTIONS || selectedAnswer.selected.some((label) => typeof label !== 'string')) {
        throw new ProxyControlError('invalid_params', 'selected answers are invalid');
      }
      const offered = new Set((question.options ?? []).map((option) => option.label));
      if (selectedAnswer.selected.some((label) => !offered.has(label)) ||
          (question.multiSelect !== true && selectedAnswer.selected.length > 1)) {
        throw new ProxyControlError('invalid_params', 'an answer selected a choice the native form did not offer');
      }
      const custom = selectedAnswer.custom;
      if (custom !== undefined && (!boundedMultilineText(custom, MAX_CUSTOM_ANSWER) || question.nativeAllowOther !== true)) {
        throw new ProxyControlError('invalid_params', 'typed text was not offered by this native question');
      }
      if (question.multiSelect === true) {
        if (selectedAnswer.selected.length === 0 && custom === undefined) {
          throw new ProxyControlError('invalid_params', 'a multi-select question needs at least one answer');
        }
      } else if (selectedAnswer.selected.length + (custom === undefined ? 0 : 1) !== 1) {
        throw new ProxyControlError('invalid_params', 'a single-select question needs exactly one answer');
      }
      const values = custom === undefined ? [...selectedAnswer.selected] : [...selectedAnswer.selected, custom];
      answers[selectedAnswer.id] = { answers: values };
    }
    return { answers };
  }

  buildApprovalResult(entry, answer) {
    if (!isRecord(answer) || Object.keys(answer).length !== 1 || typeof answer.decision !== 'string') {
      throw new ProxyControlError('invalid_params', 'one explicit native decision is required');
    }
    if (!['accept', 'decline'].includes(answer.decision) || !entry.availableDecisions.includes(answer.decision)) {
      throw new ProxyControlError('not_capable', 'this native request does not offer that one-time decision');
    }
    // `acceptForSession` is deliberately never reachable from the bridge.
    return { decision: answer.decision };
  }

  nextInternalRpcId() {
    return `${this.rpcPrefix}${this.rpcCounter++}`;
  }

  callNative(method, params, timeoutMs = 10000) {
    if (this.closed) return Promise.reject(new ProxyControlError('stale_request', 'Codex native connection is closed'));
    if (method !== 'turn/interrupt' || !isRecord(params) || Object.keys(params).some((key) => !['threadId', 'turnId'].includes(key)) ||
        !boundedText(params.threadId, 256) || !boundedText(params.turnId, 256)) {
      return Promise.reject(new ProxyControlError('not_capable', 'Codex native control only allows an exact turn interrupt'));
    }
    const id = this.nextInternalRpcId();
    const key = nativeIdKey(id);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.internalRpc.delete(key);
        this.retireInternalRpc(key);
        reject(new ProxyControlError('bridge_error', 'Codex app-server control request timed out'));
      }, timeoutMs);
      this.internalRpc.set(key, { resolve, reject, timer });
      Promise.resolve(this.writeToNative(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)).catch(() => {
        const pending = this.internalRpc.get(key);
        if (pending === undefined) return;
        this.internalRpc.delete(key);
        this.retireInternalRpc(key);
        clearTimeout(pending.timer);
        pending.reject(new ProxyControlError('bridge_error', 'Codex app-server control request could not be written'));
      });
    });
  }

  async interrupt(threadId, turnId) {
    if (this.closed || this.activeTurns.get(threadId) !== turnId) throw new ProxyControlError('stale_request', 'that Codex turn is no longer running');
    const key = `${threadId}\u0000${turnId}`;
    if (this.interruptingTurns.has(key)) throw new ProxyControlError('request_in_progress', 'an interrupt for this Codex turn was already submitted');
    this.interruptingTurns.add(key);
    try {
      const response = await this.callNative('turn/interrupt', { threadId, turnId });
      if (!isRecord(response)) throw new ProxyControlError('bridge_error', 'Codex did not acknowledge the interrupt request');
      const existing = this.completedTurns.get(key);
      if (existing?.status === 'interrupted') return { state: 'confirmed' };
    const completion = await new Promise((resolve) => {
      let done = false;
      const listener = (outcome) => {
        if (outcome.threadId !== threadId || outcome.turnId !== turnId || done) return;
        done = true;
        clearTimeout(timer);
        this.off('turn-completed', listener);
        resolve(outcome);
      };
      const timer = setTimeout(() => {
        if (done) return;
        done = true;
        this.off('turn-completed', listener);
        resolve(null);
      }, this.interruptConfirmMs);
      this.on('turn-completed', listener);
      const raced = this.completedTurns.get(key);
      if (raced !== undefined) listener(raced);
    });
      return { state: completion?.status === 'interrupted' ? 'confirmed' : 'submitted' };
    } finally {
      this.interruptingTurns.delete(key);
    }
  }

  retireInternalRpc(key) {
    this.retiredInternalRpc.set(key, this.now() + 60000);
    for (const [retiredKey, expiresAt] of this.retiredInternalRpc) if (expiresAt < this.now()) this.retiredInternalRpc.delete(retiredKey);
    while (this.retiredInternalRpc.size > RETIRED_RPC_LIMIT) this.retiredInternalRpc.delete(this.retiredInternalRpc.keys().next().value);
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    for (const pending of this.internalRpc.values()) {
      clearTimeout(pending.timer);
      pending.reject(new ProxyControlError('stale_request', 'Codex native connection closed'));
    }
    this.internalRpc.clear();
    for (const entry of this.requests.values()) entry.state = 'connection-lost';
    this.requests.clear();
    this.nativeToBridge.clear();
    this.activeTurns.clear();
    this.observedThreads.clear();
    this.desktopOwnerRequests.clear();
    this.filePatchCache.clear();
    this.waitingFileRequests.clear();
    this.retiredInternalRpc.clear();
    this.interruptingTurns.clear();
    this.emit('closed');
  }
}

class ProxyControlError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ProxyControlError';
    this.code = code;
  }
}

module.exports = {
  NATIVE_REQUEST_METHODS,
  DEFAULT_INTERRUPT_CONFIRM_MS,
  nativeIdKey,
  validNativeRpcId,
  nativeRequestFromMessage,
  JsonlTap,
  CodexNativeProxyCore,
  ProxyControlError,
};
