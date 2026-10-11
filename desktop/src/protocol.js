'use strict';
/**
 * The wire protocol of the bridge link, protocol-v1 §8 and §9.
 *
 * Everything that crosses the WebSocket goes through this module: the eight
 * frame types, the four methods, the `capabilities` object, and the shape rules
 * for every `result`. Building and validating in one place is what keeps a
 * hand-written frame from reaching the relay with a field the contract does not
 * allow.
 *
 * Rules the contract pins and this module enforces:
 * - `version` is 1, and a `hello` must carry 1-64 non-blank characters as
 *   `clientName`;
 * - `pair.create` ids are minted here (CRD 0003: the desktop generates them);
 * - `request` ids come from the relay and are echoed byte for byte;
 * - an unknown frame `type` is ignored (§12.4), a frame that is not JSON or has
 *   no type is a protocol error (§8.5);
 * - timestamps are RFC3339 UTC (§4.2), `status`/`role`/`tool` keep unknown
 *   values (§4.3-4.5), `session.read` omits `activeTurnId` unless working.
 */

const crypto = require('node:crypto');

const { BridgeError } = require('./errors');

/** protocol-v1 §8.3. */
const FRAME_TYPES = Object.freeze([
  'hello',
  'hello.ok',
  'ping',
  'pong',
  'pair.create',
  'pair.created',
  'pair.used',
  'request',
  'response',
]);

const METHODS = Object.freeze([
  'sessions.list',
  'session.read',
  'session.send',
  'session.stop',
  'session.answer',
  'session.approve',
  'models.list',
  'session.create',
]);

/**
 * Per-method `params` whitelist.
 *
 * CRD 0006 adds `models.list`/`session.create`; the additive wire v1 work adds
 * `session.send`'s three model fields, `session.answer`, and `session.approve`.
 * An unlisted field is refused, so a newer phone cannot smuggle a parameter past
 * an older desktop's validation.
 */
const METHOD_PARAMS = Object.freeze({
  'sessions.list': ['tool'],
  'session.read': ['tool', 'sessionId', 'text'],
  'session.send': ['tool', 'sessionId', 'text', 'model', 'provider', 'reasoningEffort'],
  'session.stop': ['tool', 'sessionId', 'text'],
  'session.answer': ['tool', 'sessionId', 'callId', 'answers'],
  'session.approve': ['tool', 'sessionId', 'approvalId', 'decision'],
  'models.list': ['tool'],
  'session.create': ['tool', 'model', 'provider', 'reasoningEffort', 'cwd', 'projectId', 'text', 'requestId'],
});

/** protocol-v1 §7.3: the text a `session.send` may carry, in Unicode code points. */
const MAX_MESSAGE_TEXT = 16384;

/** protocol-v1 §9.2: one message body is cut to this many characters. */
const MAX_MESSAGE_BODY = 65536;

/** protocol-v1 §9.1: never more than 200 sessions in one answer. */
const MAX_SESSIONS = 200;

/** protocol-v1 §9.2: never more than 200 messages in one answer. */
const MAX_MESSAGES = 200;

const STATUS_VALUES = Object.freeze(['idle', 'working', 'stopped', 'error']);
const ROLE_VALUES = Object.freeze(['user', 'assistant', 'system', 'tool']);
const TOOL_VALUES = Object.freeze(['codex', 'dsh', 'workbuddy']);

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SESSION_ID = /^[A-Za-z0-9._:-]{1,128}$/;
const CLIENT_NAME_LIMIT = 64;
const TITLE_LIMIT = 200;

/** A model id or a provider id is a short token, never a paragraph. */
const MODEL_FIELD_LIMIT = 200;
/** A reasoning-effort id is a short token (`high`, `xhigh`), never a paragraph. */
const EFFORT_FIELD_LIMIT = 64;
/** A tool call id or a question id: one line, bounded, opaque. */
const CALL_ID_LIMIT = 200;

/**
 * How large a pending question form may be before this bridge refuses to present
 * it at all (CRD 0008 §E). These are hard caps, not truncation targets: a form
 * the phone cannot show in full is never shown in part, because a partly-shown
 * form is a form the user could answer without seeing what they were answering.
 */
const MAX_PENDING_BATCHES = 4;
const MAX_PENDING_QUESTIONS = 8;
const MAX_PENDING_OPTIONS = 12;
const MAX_QUESTION_TEXT = 1000;
const MAX_QUESTION_HEADER = 200;
const MAX_QUESTION_DETAIL = 1000;
const MAX_OPTION_LABEL = 200;
const MAX_OPTION_DESCRIPTION = 500;
/** One answer item may carry at most this much typed text. */
const MAX_ANSWER_CUSTOM = 1000;

/** The only two states a pending DSH question batch may report. */
const PENDING_STATES = Object.freeze(['open', 'continued']);

/**
 * How large a pending permission-approval list may be before this bridge refuses
 * to present it at all. Like the question form caps, this is a hard cap and not a
 * truncation target: a list the phone cannot show in full is never shown in part.
 */
const MAX_PENDING_APPROVALS = 8;
/** One approval's native identity: the gateway event id, which really is a v4 UUID. */
const APPROVAL_ID_LIMIT = 128;/** The tool a pending approval names - an identifier, so one short line. */
const MAX_APPROVAL_TOOL_NAME = 128;
/** The tool call a pending approval belongs to, when the native request names one. */
const MAX_APPROVAL_CALL_ID = 128;
/** The native reason sentence; bounded, because it is really displayed. */
const MAX_APPROVAL_REASON = 4000;

/**
 * The only two decisions this bridge may submit for a generic approval.
 *
 * `allowed-once` grants exactly the one action the native request named; there is
 * deliberately no `allowed-always`/`allow-all` member, because neither this
 * bridge nor the phone may change the policy that decides future actions.
 */
const APPROVAL_DECISIONS = Object.freeze(['allow-once', 'reject']);

/** What a submitted approval may report: the transport took it, or native proved it. */
const APPROVAL_STATES = Object.freeze(['submitted', 'confirmed']);

class ProtocolError extends Error {
  /** @param {string} code protocol-v1 §6.2 code @param {string} message */
  constructor(code, message) {
    super(message);
    this.name = 'ProtocolError';
    this.code = code;
  }
}

function protocolError(code, message) {
  return new ProtocolError(code, message);
}

function isUuidV4(value) {
  return typeof value === 'string' && UUID_V4.test(value);
}

function isSessionId(value) {
  return typeof value === 'string' && SESSION_ID.test(value);
}

/** A short single-line token: non-blank, bounded, no control characters. */
function assertShortToken(value, name, limit) {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > limit || /[\r\n\t\u0000]/.test(value)) {
    throw protocolError('invalid_params', `${name} must be 1-${limit} non-blank characters on one line`);
  }
}

/** A tool call id or a question id: opaque, one line, bounded - never guessed at. */
function isCallId(value) {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= CALL_ID_LIMIT &&
    value.trim() === value &&
    !/[\r\n\t\u0000]/.test(value)
  );
}

/** One bounded string in a pending question; the bound counts code points. */
function boundedQuestionText(value, name, limit) {
  if (typeof value !== 'string') {
    throw protocolError('bridge_error', `${name} must be a string`);
  }
  if ([...value].length > limit) {
    throw protocolError('bridge_error', `${name} is longer than this bridge will present`);
  }
  return value;
}

/** One optional bounded string: absent or empty means "not carried". */
function optionalQuestionText(value, name, limit) {
  if (value === undefined || value === null) return undefined;
  const text = boundedQuestionText(value, name, limit);
  return text.length === 0 ? undefined : text;
}

/** Validate and normalise one pending question (the DSH userQuestions vocabulary). */
function buildPendingQuestion(value) {
  const bad = (message) => protocolError('bridge_error', message);
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw bad('a pending question must be an object');
  for (const key of Object.keys(value)) {
    if (!['id', 'question', 'header', 'detail', 'options', 'multiSelect'].includes(key)) {
      throw bad('a pending question carries a field the contract does not allow');
    }
  }
  if (!isCallId(value.id)) throw bad('a pending question needs a bounded single-line id');
  const question = { id: value.id, question: boundedQuestionText(value.question, 'a question', MAX_QUESTION_TEXT) };
  const header = optionalQuestionText(value.header, 'a question header', MAX_QUESTION_HEADER);
  if (header !== undefined) question.header = header;
  const detail = optionalQuestionText(value.detail, 'a question detail', MAX_QUESTION_DETAIL);
  if (detail !== undefined) question.detail = detail;
  if (value.options !== undefined && value.options !== null) {
    if (!Array.isArray(value.options) || value.options.length === 0) throw bad('a question options field must be a non-empty array');
    if (value.options.length > MAX_PENDING_OPTIONS) throw bad('a question offers more options than this bridge will present');
    question.options = value.options.map((option) => {
      if (option === null || typeof option !== 'object' || Array.isArray(option)) throw bad('a question option must be an object');
      for (const key of Object.keys(option)) {
        if (key !== 'label' && key !== 'description') throw bad('a question option carries a field the contract does not allow');
      }
      const label = boundedQuestionText(option.label, 'an option label', MAX_OPTION_LABEL);
      if (label.length === 0) throw bad('an option needs a label');
      const entry = { label };
      const description = optionalQuestionText(option.description, 'an option description', MAX_OPTION_DESCRIPTION);
      if (description !== undefined) entry.description = description;
      return entry;
    });
  }
  if (value.multiSelect !== undefined) {
    if (typeof value.multiSelect !== 'boolean') throw bad('multiSelect must be a boolean');
    if (value.multiSelect === true) question.multiSelect = true;
  }
  return question;
}

/** Validate and normalise the pending-question batches of one `session.read`. */
function buildPendingQuestions(value) {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) throw protocolError('bridge_error', 'pendingQuestions must be an array');
  // Nothing waiting means the field is absent, not an empty list: this result is
  // polled every couple of seconds, and an empty array every time would be noise
  // the phone has to read for no reason.
  if (value.length === 0) return undefined;
  if (value.length > MAX_PENDING_BATCHES) {
    throw protocolError('bridge_error', 'more pending questions are waiting than this bridge will present');
  }
  return value.map((batch) => {
    const bad = (message) => protocolError('bridge_error', message);
    if (batch === null || typeof batch !== 'object' || Array.isArray(batch)) throw bad('a pending question batch must be an object');
    for (const key of Object.keys(batch)) {
      if (!['callId', 'state', 'questions'].includes(key)) throw bad('a pending question batch carries a field the contract does not allow');
    }
    if (!isCallId(batch.callId)) throw bad('a pending question batch needs a bounded single-line callId');
    if (!PENDING_STATES.includes(batch.state)) throw bad('a pending question batch has a state this bridge does not know');
    if (!Array.isArray(batch.questions) || batch.questions.length === 0) throw bad('a pending question batch must carry at least one question');
    if (batch.questions.length > MAX_PENDING_QUESTIONS) throw bad('a pending question batch carries more questions than this bridge will present');
    return { callId: batch.callId, state: batch.state, questions: batch.questions.map(buildPendingQuestion) };
  });
}

/**
 * A native approval identity: the Gateway's own `eventId`.
 *
 * The installed gateway mints it with `randomUUID()` (`startRemoteEvent` in
 * `dsh-api-gateway/lib/index.js`), so it is a v4 UUID and nothing else. The check
 * is exact rather than "a bounded token" on purpose: the relay validates the same
 * field as a UUID, and this bridge must never be able to emit a projection its own
 * relay would reject. A value that is not one is refused here, where the reason is
 * still visible, instead of surfacing later as a broken answer on the phone.
 */
function isApprovalId(value) {
  return isUuidV4(value);
}

/**
 * One pending permission approval (additive wire v1, requirement F).
 *
 * The shape is the native gateway's own: `id` is the real `eventId` of the
 * `approval/request` waterfall, `toolName` is what native said it will run,
 * `callId` and `reason` travel only when native carried them. Nothing here
 * invents a pending approval, and nothing here decides one.
 */
function buildPendingApproval(value) {
  const bad = (message) => protocolError('bridge_error', message);
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw bad('a pending approval must be an object');
  for (const key of Object.keys(value)) {
    if (!['id', 'toolName', 'callId', 'reason'].includes(key)) {
      throw bad('a pending approval carries a field the contract does not allow');
    }
  }
  if (!isApprovalId(value.id)) throw bad('a pending approval needs the native request id (a UUID)');
  if (typeof value.toolName !== 'string' || value.toolName.trim().length === 0 || value.toolName.length > MAX_APPROVAL_TOOL_NAME || /[\r\n\t\u0000]/.test(value.toolName)) {
    throw bad('a pending approval needs the bounded tool name it is waiting for');
  }
  const entry = { id: value.id, toolName: value.toolName };
  if (value.callId !== undefined && value.callId !== null) {
    if (typeof value.callId !== 'string' || value.callId.length === 0 || value.callId.length > MAX_APPROVAL_CALL_ID || /[\r\n\t\u0000]/.test(value.callId)) {
      throw bad('a pending approval callId must be a bounded single-line id');
    }
    entry.callId = value.callId;
  }
  if (value.reason !== undefined && value.reason !== null) {
    const reason = boundedQuestionText(value.reason, 'an approval reason', MAX_APPROVAL_REASON);
    if (reason.includes('\u0000')) throw bad('an approval reason carries a NUL character');
    if (reason.length > 0) entry.reason = reason;
  }
  return entry;
}

/** Validate and normalise the whole pending-approval list of one `session.read`. */
function buildPendingApprovals(value) {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) throw protocolError('bridge_error', 'pendingApprovals must be an array');
  // Nothing waiting means the field is absent, exactly like pendingQuestions: a
  // polled read should not carry an empty array every couple of seconds.
  if (value.length === 0) return undefined;
  if (value.length > MAX_PENDING_APPROVALS) {
    throw protocolError('bridge_error', 'more approvals are waiting than this bridge will present');
  }
  const seen = new Set();
  return value.map((approval) => {
    const entry = buildPendingApproval(approval);
    if (seen.has(entry.id)) throw protocolError('bridge_error', 'a pending approval list names the same request twice');
    seen.add(entry.id);
    return entry;
  });
}

/** `currentModel` travels only when the host really reported one, and only its three fields. */
function buildCurrentModel(value) {
  if (value === undefined || value === null) return undefined;
  const bad = (message) => protocolError('bridge_error', message);
  if (typeof value !== 'object' || Array.isArray(value)) throw bad('currentModel must be an object');
  for (const key of Object.keys(value)) {
    if (!['model', 'provider', 'reasoningEffort'].includes(key)) throw bad('currentModel carries a field the contract does not allow');
  }
  if (typeof value.model !== 'string' || value.model.trim().length === 0) throw bad('currentModel needs a model id');
  const entry = { model: value.model };
  for (const key of ['provider', 'reasoningEffort']) {
    const field = value[key];
    if (field === undefined || field === null) continue;
    if (typeof field !== 'string' || field.trim().length === 0) throw bad(`currentModel.${key} must be a non-empty string`);
    entry[key] = field;
  }
  return entry;
}

/**
 * One `session.answer` batch: a tool call id and one answer per question
 * (CRD 0008 §D). This checks the SHAPE only - whether that call is really
 * waiting for an answer is decided against fresh native state by the adapter,
 * never from the phone's word.
 */
function assertAnswerBatch(answers, callId) {
  if (!isCallId(callId)) throw protocolError('invalid_params', 'params.callId must be a bounded single-line id');
  if (!Array.isArray(answers) || answers.length === 0) {
    throw protocolError('invalid_params', 'params.answers must be a non-empty array');
  }
  if (answers.length > MAX_PENDING_QUESTIONS) {
    throw protocolError('invalid_params', 'params.answers carries more answers than this bridge will send');
  }
  const seen = new Set();
  for (const answer of answers) {
    if (answer === null || typeof answer !== 'object' || Array.isArray(answer)) {
      throw protocolError('invalid_params', 'every answer must be an object');
    }
    for (const key of Object.keys(answer)) {
      if (!['id', 'selected', 'custom'].includes(key)) throw protocolError('invalid_params', 'an answer carries a field the contract does not allow');
    }
    if (!isCallId(answer.id)) throw protocolError('invalid_params', 'every answer needs a bounded single-line question id');
    if (seen.has(answer.id)) throw protocolError('invalid_params', 'every question may be answered only once');
    seen.add(answer.id);
    if (!Array.isArray(answer.selected) || answer.selected.length > MAX_PENDING_OPTIONS) {
      throw protocolError('invalid_params', 'an answers selected labels must be an array of at most 12 labels');
    }
    for (const label of answer.selected) {
      assertShortToken(label, 'an answer label', MAX_OPTION_LABEL);
    }
    if (answer.custom !== undefined) {
      if (typeof answer.custom !== 'string' || answer.custom.trim().length === 0 || [...answer.custom].length > MAX_ANSWER_CUSTOM) {
        throw protocolError('invalid_params', `a typed answer must be 1-${MAX_ANSWER_CUSTOM} non-blank characters`);
      }
    }
  }
}

/** RFC3339 UTC (§4.2); milliseconds only when they are not zero. */
function toRfc3339(date) {
  const iso = date.toISOString();
  return iso.endsWith('.000Z') ? `${iso.slice(0, -5)}Z` : iso;
}

function nowRfc3339() {
  return toRfc3339(new Date());
}

function newId() {
  return crypto.randomUUID({ disableEntropyCache: true });
}

/**
 * Build the capability object (§9.5). Missing keys mean false, `tools` is never
 * empty and never holds a duplicate.
 *
 * `stop:*` keeps its historic rule (`true` whenever the tool is present unless
 * the caller says false). The CRD 0008 bits do not: each one needs an explicit
 * `true` from the capability options, because "we did not measure it" must never
 * turn into a control the phone can tap and watch fail.
 * @param {string[]} tools the session sources this desktop really has
 * @param {{stopCodex?: boolean, stopDsh?: boolean, modelsList?: boolean,
 *   sessionCreate?: boolean, sendModelCodex?: boolean, sendModelDsh?: boolean,
 *   answerCodex?: boolean, answerDsh?: boolean, approveCodex?: boolean,
 *   approveDsh?: boolean}} [options]
 */
function normalizeToolStatus(value) {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw protocolError('invalid_params', 'toolStatus must be an object');
  }
  const status = {};
  for (const [tool, detail] of Object.entries(value)) {
    if (!TOOL_VALUES.includes(tool)) throw protocolError('invalid_params', `unknown toolStatus entry: ${tool}`);
    if (detail === null || typeof detail !== 'object' || Array.isArray(detail)) {
      throw protocolError('invalid_params', `toolStatus.${tool} must be an object`);
    }
    for (const key of Object.keys(detail)) {
      if (key !== 'available' && key !== 'reason') {
        throw protocolError('invalid_params', `toolStatus.${tool} has an unsupported field`);
      }
    }
    if (typeof detail.available !== 'boolean') {
      throw protocolError('invalid_params', `toolStatus.${tool}.available must be a boolean`);
    }
    const entry = { available: detail.available };
    if (detail.reason !== undefined) {
      if (typeof detail.reason !== 'string' || [...detail.reason].length > 500 || /\p{Cc}/u.test(detail.reason)) {
        throw protocolError('invalid_params', `toolStatus.${tool}.reason must be at most 500 printable characters`);
      }
      if (detail.reason.length > 0) entry.reason = detail.reason;
    }
    status[tool] = entry;
  }
  return status;
}

function buildCapabilities(tools, options = {}) {
  // An empty array is legal and means "connected, but this computer has no
  // session source right now". The contract's answer to that is an empty `tools`
  // and false capability bits - never a default-on, which is exactly how a phone
  // ends up showing a button whose call must fail (§9.5).
  if (!Array.isArray(tools)) {
    throw protocolError('invalid_params', 'capabilities need a tools array');
  }
  const seen = new Set();
  for (const tool of tools) {
    if (!TOOL_VALUES.includes(tool)) {
      throw protocolError('invalid_params', `unknown tool in capabilities: ${String(tool)}`);
    }
    if (seen.has(tool)) {
      throw protocolError('invalid_params', `duplicate tool in capabilities: ${tool}`);
    }
    seen.add(tool);
  }
  const has = (tool) => seen.has(tool);
  const any = seen.size > 0;
  // An unmeasured bit is false, never true by default (§9.5): the phone may
  // only show a control the desktop can really carry out.
  const flag = (optionKey, tool) => has(tool) && options[optionKey] === true;
  const capabilities = {
    'sessions.list': any,
    'session.read': any,
    'session.send': any,
    'session.stop': any,
    'stop:codex': has('codex') ? options.stopCodex !== false : false,
    'stop:dsh': has('dsh') ? options.stopDsh !== false : false,
    'stop:workbuddy': has('workbuddy') ? options.stopWorkbuddy === true : false,
    // CRD 0006: optional additions, false unless this desktop really has a
    // session source and really implements them.
    'models.list': any && options.modelsList === true,
    'session.create': any && options.sessionCreate === true,
    // CRD 0008: per-tool, because one tool can carry the model override and the
    // other cannot. Absent/false means "no model picker for this tool", while a
    // plain send without a model keeps working exactly as before.
    'session.send:model:codex': flag('sendModelCodex', 'codex'),
    'session.send:model:dsh': flag('sendModelDsh', 'dsh'),
    'session.send:model:workbuddy': flag('sendModelWorkbuddy', 'workbuddy'),
    // CRD 0008: whether this desktop can hand a real answer back to a native
    // question. False is honest for a tool with no answer path at all.
    'session.answer:codex': flag('answerCodex', 'codex'),
    'session.answer:dsh': flag('answerDsh', 'dsh'),
    'session.answer:workbuddy': flag('answerWorkbuddy', 'workbuddy'),
    // Requirement F: whether a generic native permission approval can be decided
    // from here. DSH really forwards `approval/request` over its event stream, so
    // this is a genuine ability; Codex's app-tools pipe has no such surface at
    // all, so its bit is false rather than a button that must fail.
    'session.approve:codex': flag('approveCodex', 'codex'),
    'session.approve:dsh': flag('approveDsh', 'dsh'),
    'session.approve:workbuddy': flag('approveWorkbuddy', 'workbuddy'),
    tools: [...tools],
  };
  const toolStatus = normalizeToolStatus(options.toolStatus);
  if (toolStatus !== undefined) capabilities.toolStatus = toolStatus;
  return capabilities;
}

/** @param {{clientName: string, clientId?: string, ownerName?: string, capabilities: object}} input */
function buildHello({ clientName, clientId, ownerName, capabilities }) {
  if (typeof clientName !== 'string' || clientName.trim().length === 0 || clientName.length > CLIENT_NAME_LIMIT || /\p{Cc}/u.test(clientName)) {
    throw protocolError('invalid_params', 'clientName must be 1-64 non-blank characters');
  }
  if (capabilities === null || typeof capabilities !== 'object') {
    throw protocolError('invalid_params', 'capabilities must be an object');
  }
  const frame = { type: 'hello', version: 1, clientName: clientName.trim(), capabilities };
  if (clientId !== undefined && clientId !== null) {
    if (!isUuidV4(clientId) || clientId !== clientId.toLowerCase()) {
      throw protocolError('invalid_params', 'clientId must be a canonical UUID v4');
    }
    frame.clientId = clientId;
  }
  if (ownerName !== undefined && ownerName !== null) {
    const chars = typeof ownerName === 'string' ? [...ownerName].length : 0;
    if (typeof ownerName !== 'string' || ownerName.trim() !== ownerName || chars < 1 || chars > 64 || /\p{Cc}/u.test(ownerName)) {
      throw protocolError('invalid_params', 'ownerName must be a trimmed 1-64 character printable label');
    }
    frame.ownerName = ownerName;
  }
  return frame;
}

function buildPairCreate() {
  return { type: 'pair.create', id: newId() };
}

function buildPing() {
  return { type: 'ping' };
}

function buildPong() {
  return { type: 'pong' };
}

/**
 * Parse an inbound frame.
 * @param {string} text
 * @returns {{known: boolean, frame: object}} `known:false` means "ignore this frame"
 */
function parseFrame(text) {
  let frame;
  try {
    frame = JSON.parse(text);
  } catch {
    throw protocolError('protocol_error', 'frame is not valid JSON');
  }
  if (frame === null || typeof frame !== 'object' || Array.isArray(frame)) {
    throw protocolError('protocol_error', 'frame is not a JSON object');
  }
  if (typeof frame.type !== 'string' || frame.type.length === 0) {
    throw protocolError('protocol_error', 'frame has no string type');
  }
  return { known: FRAME_TYPES.includes(frame.type), frame };
}

/**
 * Validate an inbound `request` frame down to the fields the contract allows.
 * @returns {{id: string, method: string, params: object, timeoutMs: number}}
 */
function parseRequest(frame) {
  if (!isUuidV4(frame.id)) {
    throw protocolError('invalid_params', 'request id must be a lower-case UUID v4');
  }
  if (typeof frame.method !== 'string' || !METHODS.includes(frame.method)) {
    throw protocolError('unknown_method', 'method is not allowed');
  }
  const params = frame.params === undefined || frame.params === null ? {} : frame.params;
  if (typeof params !== 'object' || Array.isArray(params)) {
    throw protocolError('invalid_params', 'params must be an object');
  }
  const allowed = METHOD_PARAMS[frame.method] ?? ['tool', 'sessionId', 'text'];
  for (const key of Object.keys(params)) {
    if (!allowed.includes(key)) {
      throw protocolError('invalid_params', 'params contain an unknown field');
    }
  }
  let timeoutMs = 30000;
  if (frame.timeoutMs !== undefined) {
    if (!Number.isInteger(frame.timeoutMs) || frame.timeoutMs <= 0 || frame.timeoutMs > 60000) {
      throw protocolError('invalid_params', 'timeoutMs must be an integer between 1 and 60000');
    }
    timeoutMs = frame.timeoutMs;
  }
  if (frame.method === 'models.list' || frame.method === 'session.create') {
    if (!TOOL_VALUES.includes(params.tool)) {
      throw protocolError('invalid_params', 'params.tool must be "codex" or "dsh"');
    }
    if (frame.method === 'models.list') {
      return { id: frame.id, method: frame.method, params: { tool: params.tool }, timeoutMs };
    }
    // session.create (CRD 0006, canonical field list).
    if (typeof params.model !== 'string' || params.model.trim().length === 0) {
      throw protocolError('invalid_params', 'params.model is required');
    }
    if (!isUuidV4(params.requestId)) {
      throw protocolError('invalid_params', 'params.requestId must be a lower-case UUID v4');
    }
    // The provider is not decoration: the same model id really exists under more
    // than one DSH provider, and without it the route is undecidable. It is
    // therefore required for DSH and must not appear for Codex.
    if (params.tool === 'dsh') {
      if (typeof params.provider !== 'string' || params.provider.trim().length === 0) {
        throw protocolError('invalid_params', 'params.provider is required for DSH');
      }
    } else if (params.provider !== undefined) {
      throw protocolError('invalid_params', 'params.provider must not be sent for Codex');
    }
    if (params.reasoningEffort !== undefined && (typeof params.reasoningEffort !== 'string' || params.reasoningEffort.trim().length === 0)) {
      throw protocolError('invalid_params', 'params.reasoningEffort must be a non-empty string');
    }
    for (const key of ['cwd', 'projectId']) {
      if (params[key] !== undefined && (typeof params[key] !== 'string' || params[key].trim().length === 0)) {
        throw protocolError('invalid_params', `params.${key} must be a non-empty string`);
      }
    }
    if (params.text !== undefined) {
      if (typeof params.text !== 'string') {
        throw protocolError('invalid_params', 'params.text must be a string');
      }
      const points = [...params.text].length;
      if (points > MAX_MESSAGE_TEXT) {
        throw protocolError('too_long', 'params.text is too long');
      }
      if (points === 0 || params.text.trim().length === 0 || params.text.includes('\u0000')) {
        throw protocolError('invalid_params', 'params.text must not be empty or contain NUL');
      }
    }
    return { id: frame.id, method: frame.method, params: { ...params }, timeoutMs };
  }
  if (frame.method !== 'sessions.list') {
    if (!TOOL_VALUES.includes(params.tool)) {
      throw protocolError('invalid_params', 'params.tool must be "codex" or "dsh"');
    }
    if (!isSessionId(params.sessionId)) {
      throw protocolError('invalid_params', 'params.sessionId is not a valid session id');
    }
  } else if (params.tool !== undefined && !TOOL_VALUES.includes(params.tool)) {
    throw protocolError('invalid_params', 'params.tool must be "codex" or "dsh"');
  }
  if (frame.method === 'session.send') {
    if (typeof params.text !== 'string') {
      throw protocolError('invalid_params', 'params.text must be a string');
    }
    const points = [...params.text].length;
    if (points > MAX_MESSAGE_TEXT) {
      throw protocolError('too_long', 'params.text is too long');
    }
    if (points === 0 || params.text.trim().length === 0 || params.text.includes('\u0000')) {
      throw protocolError('invalid_params', 'params.text must not be empty or contain NUL');
    }
    // CRD 0008 §2: an optional model for the **next** message. Omitting all three
    // is the old request, byte for byte, and nothing below runs at all.
    const wantsModel = params.model !== undefined;
    if (!wantsModel) {
      if (params.provider !== undefined || params.reasoningEffort !== undefined) {
        throw protocolError('invalid_params', 'params.provider and params.reasoningEffort need params.model');
      }
    } else {
      assertShortToken(params.model, 'params.model', MODEL_FIELD_LIMIT);
      if (params.tool === 'dsh') {
        if (params.provider === undefined) {
          throw protocolError('invalid_params', 'params.provider is required when a DSH send carries a model');
        }
        assertShortToken(params.provider, 'params.provider', MODEL_FIELD_LIMIT);
      } else if (params.provider !== undefined) {
        throw protocolError('invalid_params', 'params.provider must not be sent for Codex');
      }
      if (params.reasoningEffort !== undefined) {
        assertShortToken(params.reasoningEffort, 'params.reasoningEffort', EFFORT_FIELD_LIMIT);
      }
    }
  }
  // CRD 0008 §D: an answer batch names one question per item, exactly once.
  // The ids are checked for shape here; whether they are really waiting is the
  // adapter's fresh check against native state, never this side's belief.
  if (frame.method === 'session.answer') {
    assertAnswerBatch(params.answers, params.callId);
  }
  // Requirement F: one pending approval, one decision. The shape is checked here;
  // whether that request is still live is decided by the adapter against the
  // exact native event stream, never from the phone's word.
  if (frame.method === 'session.approve') {
    if (!isApprovalId(params.approvalId)) {
      throw protocolError('invalid_params', 'params.approvalId must be the native request id');
    }
    if (!APPROVAL_DECISIONS.includes(params.decision)) {
      throw protocolError('invalid_params', 'params.decision must be "allow-once" or "reject"');
    }
  }
  if (frame.method !== 'session.send' && frame.method !== 'session.create' && params.text !== undefined) {
    throw protocolError('invalid_params', 'params.text is not allowed for this method');
  }
  return { id: frame.id, method: frame.method, params: { ...params }, timeoutMs };
}

function assertTitle(title) {
  if (typeof title !== 'string' || title.length === 0 || title.length > TITLE_LIMIT || /[\r\n]/.test(title)) {
    throw protocolError('bridge_error', 'a session title must be 1-200 characters on one line');
  }
}

function assertTool(tool) {
  if (!TOOL_VALUES.includes(tool)) {
    throw protocolError('bridge_error', `unknown tool ${String(tool)}`);
  }
}

function normalizeCwd(cwd) {
  return typeof cwd === 'string' && cwd.length > 0 ? cwd : null;
}

/** §9.1: newest first, ties broken by id, at most 200. */
function buildSessionsListResult({ sessions, capabilities }) {
  if (!Array.isArray(sessions)) {
    throw protocolError('bridge_error', 'sessions must be an array');
  }
  const normalized = sessions.map((session) => {
    if (!isSessionId(session.id)) {
      throw protocolError('bridge_error', 'a session id is not a valid session id');
    }
    assertTool(session.tool);
    assertTitle(session.title);
    const entry = {
      id: session.id,
      tool: session.tool,
      title: session.title,
      status: session.status,
      updatedAt: session.updatedAt,
      cwd: normalizeCwd(session.cwd),
    };
    // CRD 0008 §E: only ever `true`, and only from real native pending state.
    // Absent means "this bridge saw no evidence", never "nothing is waiting".
    if (session.needsInput === true) entry.needsInput = true;
    return entry;
  });
  normalized.sort((a, b) => (a.updatedAt === b.updatedAt ? (a.id < b.id ? -1 : a.id > b.id ? 1 : 0) : a.updatedAt < b.updatedAt ? 1 : -1));
  return { sessions: normalized.slice(0, MAX_SESSIONS), capabilities };
}

function truncateMessageText(text) {
  const points = [...text];
  if (points.length <= MAX_MESSAGE_BODY) {
    return text;
  }
  return `${points.slice(0, MAX_MESSAGE_BODY - 1).join('')}…`;
}

/** Keep the newest MAX_MESSAGES messages, in ascending time order (§9.2). */
function selectMessages(messages) {
  if (!Array.isArray(messages)) {
    throw protocolError('bridge_error', 'messages must be an array');
  }
  const tail = messages.slice(-MAX_MESSAGES);
  return tail.map((message) => {
    if (typeof message.id !== 'string' || message.id.length === 0 || message.id.length > 128) {
      throw protocolError('bridge_error', 'a message id must be 1-128 characters');
    }
    if (!ROLE_VALUES.includes(message.role)) {
      throw protocolError('bridge_error', `unknown message role ${String(message.role)}`);
    }
    return {
      id: message.id,
      role: message.role,
      text: truncateMessageText(String(message.text ?? '')),
      timestamp: message.timestamp,
    };
  });
}

/** §9.2. `activeTurnId` is present only while the session is working. */
function buildSessionReadResult({ id, tool, title, status, messages, canStop, activeTurnId, currentModel, pendingQuestions, pendingApprovals }) {
  if (!isSessionId(id)) {
    throw protocolError('bridge_error', 'the session id is not a valid session id');
  }
  assertTool(tool);
  assertTitle(title);
  if (typeof canStop !== 'boolean') {
    throw protocolError('bridge_error', 'canStop must be a boolean');
  }
  if (status === 'working' && (typeof activeTurnId !== 'string' || activeTurnId.length === 0)) {
    throw protocolError('bridge_error', 'a working session must report an activeTurnId');
  }
  const result = { id, tool, title, status, messages: selectMessages(messages), canStop };
  if (status === 'working') {
    result.activeTurnId = activeTurnId;
  }
  // CRD 0008 §C: the model the host itself reports for this session. Codex has
  // no such native field, so this is simply absent there - never guessed at.
  const model = buildCurrentModel(currentModel);
  if (model !== undefined) {
    result.currentModel = model;
  }
  // CRD 0008 §E: real pending questions, bounded. A batch that does not fit is
  // refused here rather than trimmed - a half-shown question form is not a form.
  const pending = buildPendingQuestions(pendingQuestions);
  if (pending !== undefined) {
    result.pendingQuestions = pending;
  }
  // Requirement F: real pending permission approvals, bounded, from the native
  // event stream only. A list that does not fit is refused here rather than
  // trimmed - a half-shown approval is not an approval.
  const approvals = buildPendingApprovals(pendingApprovals);
  if (approvals !== undefined) {
    result.pendingApprovals = approvals;
  }
  return result;
}

function buildSessionSendResult(sessionId) {
  if (!isSessionId(sessionId)) {
    throw protocolError('bridge_error', 'the session id is not a valid session id');
  }
  return { accepted: true, sessionId };
}

function buildSessionStopResult(sessionId) {
  return buildSessionSendResult(sessionId);
}

/**
 * `session.answer` (CRD 0008 §D): the same echoed identity, plus the call the
 * answer belongs to - so the phone can never mistake one answered question for
 * another.
 */
function buildSessionAnswerResult(sessionId, callId) {
  if (!isSessionId(sessionId)) {
    throw protocolError('bridge_error', 'the session id is not a valid session id');
  }
  if (!isCallId(callId)) {
    throw protocolError('bridge_error', 'the call id is not a valid tool call id');
  }
  return { accepted: true, sessionId, callId };
}

/**
 * `session.approve` (requirement F): the echoed identity plus what really
 * happened.
 *
 * `state` is the honest distinction the phone depends on:
 * - `submitted` - the native transport acknowledged the submission. That is
 *   **not** proof that this answer won: another client may have answered the same
 *   request first, and the gateway still acknowledges. The UI must say 已提交 and
 *   re-read native state.
 * - `confirmed` - the native audit shows this exact request was decided with the
 *   outcome this bridge sent.
 */
function buildSessionApproveResult({ sessionId, approvalId, state }) {
  if (!isSessionId(sessionId)) {
    throw protocolError('bridge_error', 'the session id is not a valid session id');
  }
  if (!isApprovalId(approvalId)) {
    throw protocolError('bridge_error', 'the approval id is not a valid approval id');
  }
  if (!APPROVAL_STATES.includes(state)) {
    throw protocolError('bridge_error', 'an approval result must say whether it was submitted or confirmed');
  }
  return { accepted: true, sessionId, approvalId, state };
}

/** §8.4.8: a success frame, and the only place a `result` is attached. */
function buildResponse(id, result) {
  return { type: 'response', id, ok: true, result };
}

/**
 * The relay's frame limit stays exactly where protocol-v1 §8.2 put it. It is a
 * safety cap, not a target: a `session.read` answer that reaches it would make
 * `send` throw on this side, the relay would wait out its timeout, and the phone
 * would say "the desktop did not answer in time". So results are budgeted below
 * the cap instead of the cap being raised.
 */
const MAX_RESPONSE_BYTES = 262144;

/** CRD 0007: budget for the **whole** envelope, measured in UTF-8 bytes. */
const RESPONSE_BYTE_BUDGET = 240 * 1024;

/** A human-visible marker, so nobody mistakes a cut message for a whole one. */
const TRUNCATION_MARK = '… [truncated]';

/** UTF-8 bytes of a frame envelope, exactly as it would go on the wire. */
function envelopeBytes(value) {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

/** How much of one message body is kept before older messages are dropped. */
const TEXT_CAP_BY_ROLE = { tool: 2048, system: 2048, assistant: 8192, user: 8192 };

function cutText(text, points, mark) {
  const all = [...text];
  if (all.length <= points) return text;
  return `${all.slice(0, Math.max(1, points - mark.length)).join('')}${mark}`;
}

/**
 * Trim a `session.read` result until the whole envelope fits the budget.
 *
 * Order matters and is fixed by CRD 0007: first cut the very long tool outputs
 * (they are the bulk and the least useful to read in full), then drop the oldest
 * messages while keeping the newest ones, and only if a single message is still
 * too big cut that one. Whenever anything was cut, `historyTruncated: true` goes
 * into the result, so the phone can say "not the whole history" instead of
 * pretending.
 *
 * @param {object} result a §9.2 result
 * @param {{budget?: number, id?: string}} [options]
 * @returns {{result: object, truncated: boolean, bytes: number, droppedMessages: number}}
 */
function fitSessionReadResult(result, options = {}) {
  const budget = options.budget ?? RESPONSE_BYTE_BUDGET;
  const id = options.id ?? '00000000-0000-4000-8000-000000000000';
  const measure = (candidate) => envelopeBytes({ type: 'response', id, ok: true, result: candidate });
  const messages = (Array.isArray(result.messages) ? result.messages : []).map((message) => ({ ...message }));
  const between = { ...result, messages };
  let truncated = false;
  let droppedMessages = 0;

  if (measure(between) <= budget) {
    return { result: between, truncated: false, bytes: measure(between), droppedMessages: 0 };
  }

  // 1. Cut the long bodies (tool output first, by role cap).
  for (const message of messages) {
    const cap = TEXT_CAP_BY_ROLE[message.role] ?? 4096;
    if ([...message.text].length > cap) {
      message.text = cutText(message.text, cap, TRUNCATION_MARK);
      truncated = true;
    }
  }

  // 2. Drop the oldest messages, keeping the newest ones.
  while (messages.length > 1 && measure(between) > budget) {
    messages.shift();
    droppedMessages += 1;
    truncated = true;
  }

  // 3. A single message can still be too big; cut it by code points so a
  //    multi-byte emoji is never split into half a character.
  if (measure(between) > budget && messages.length === 1) {
    const only = messages[0];
    let low = 1;
    let high = [...only.text].length;
    let best = cutText(only.text, low, TRUNCATION_MARK);
    while (low <= high) {
      const middle = Math.floor((low + high) / 2);
      only.text = cutText(only.text, middle, TRUNCATION_MARK);
      if (measure(between) <= budget) {
        best = only.text;
        low = middle + 1;
      } else {
        high = middle - 1;
      }
    }
    only.text = cutText(only.text, high > 1 ? high : 1, TRUNCATION_MARK);
    if (high > 1) best = only.text;
    only.text = best;
    truncated = true;
  }

  if (truncated) {
    between.historyTruncated = true;
  }
  return { result: between, truncated, bytes: measure(between), droppedMessages };
}

/**
 * `models.list` (CRD 0006): the models a tool really offers on this computer.
 *
 * `provider` exists only for DSH - the same model id can live under several DSH
 * providers, so dropping it would lose the route. Codex must not carry it.
 * `models` may legitimately be empty: no catalog means an empty array plus a
 * `reason`, never an invented list.
 */
function buildModelsListResult({ tool, models, projects, reason }) {
  if (!TOOL_VALUES.includes(tool)) {
    throw protocolError('bridge_error', `unknown tool ${String(tool)}`);
  }
  const normalized = (Array.isArray(models) ? models : []).map((model) => {
    const entry = { id: String(model.id), label: String(model.label ?? model.id) };
    if (tool === 'dsh') {
      if (typeof model.provider !== 'string' || model.provider.length === 0) {
        throw protocolError('bridge_error', 'a DSH model needs its provider');
      }
      entry.provider = model.provider;
    }
    if (model.isDefault === true) entry.isDefault = true;
    if (Array.isArray(model.reasoningEfforts) && model.reasoningEfforts.length > 0) {
      entry.reasoningEfforts = model.reasoningEfforts.map(String);
    }
    if (typeof model.defaultReasoningEffort === 'string' && model.defaultReasoningEffort.length > 0) {
      entry.defaultReasoningEffort = model.defaultReasoningEffort;
    }
    return entry;
  });
  const result = { tool, models: normalized };
  if (Array.isArray(projects) && projects.length > 0) {
    result.projects = projects.map((project) => ({
      id: String(project.id),
      name: String(project.name ?? project.id),
      cwd: typeof project.cwd === 'string' ? project.cwd : null,
    }));
  }
  // A healthy catalog carries no `reason` field at all; one that really could
  // not be read says so, instead of leaving the phone to guess why it is empty.
  if (typeof reason === 'string' && reason.trim().length > 0) {
    result.reason = reason;
  }
  return result;
}

/**
 * `session.create` (CRD 0006). Once a session really exists, its id is reported
 * even when a later step failed: `partial: true` plus `incomplete` says exactly
 * how far it got, so the phone opens that session instead of creating a second
 * one.
 */
function buildSessionCreateResult({ sessionId, tool, title, model, provider, reasoningEffort, partial, incomplete }) {
  if (!isSessionId(sessionId)) {
    throw protocolError('bridge_error', 'the created session id is not a valid session id');
  }
  const result = { sessionId, tool: String(tool), model: String(model) };
  if (typeof title === 'string' && title.length > 0) result.title = title;
  if (typeof provider === 'string' && provider.length > 0) result.provider = provider;
  if (typeof reasoningEffort === 'string' && reasoningEffort.length > 0) result.reasoningEffort = reasoningEffort;
  if (partial === true) {
    result.partial = true;
    result.incomplete = String(incomplete ?? 'a later step failed');
  }
  return result;
}

/** §9.2: canStop is both "working" and the tool's stop capability. */
function canStop({ status, tool, capabilities }) {
  return status === 'working' && capabilities[`stop:${tool}`] === true;
}

module.exports = {
  FRAME_TYPES,
  METHODS,
  METHOD_PARAMS,
  MAX_RESPONSE_BYTES,
  RESPONSE_BYTE_BUDGET,
  TRUNCATION_MARK,
  envelopeBytes,
  fitSessionReadResult,
  buildModelsListResult,
  buildSessionCreateResult,
  MAX_MESSAGE_TEXT,
  MAX_MESSAGE_BODY,
  MAX_SESSIONS,
  MAX_MESSAGES,
  MODEL_FIELD_LIMIT,
  EFFORT_FIELD_LIMIT,
  CALL_ID_LIMIT,
  MAX_PENDING_BATCHES,
  MAX_PENDING_QUESTIONS,
  MAX_PENDING_OPTIONS,
  MAX_QUESTION_TEXT,
  MAX_QUESTION_HEADER,
  MAX_QUESTION_DETAIL,
  MAX_OPTION_LABEL,
  MAX_OPTION_DESCRIPTION,
  MAX_ANSWER_CUSTOM,
  PENDING_STATES,
  MAX_PENDING_APPROVALS,
  APPROVAL_ID_LIMIT,
  MAX_APPROVAL_TOOL_NAME,
  MAX_APPROVAL_CALL_ID,
  MAX_APPROVAL_REASON,
  APPROVAL_DECISIONS,
  APPROVAL_STATES,
  STATUS_VALUES,
  ROLE_VALUES,
  TOOL_VALUES,
  ProtocolError,
  protocolError,
  isUuidV4,
  isSessionId,
  isCallId,
  isApprovalId,
  buildPendingApprovals,
  toRfc3339,
  nowRfc3339,
  newId,
  buildCapabilities,
  buildHello,
  buildPairCreate,
  buildPing,
  buildPong,
  parseFrame,
  parseRequest,
  buildSessionsListResult,
  buildSessionReadResult,
  buildSessionSendResult,
  buildSessionStopResult,
  buildSessionAnswerResult,
  buildSessionApproveResult,
  buildResponse,
  truncateMessageText,
  canStop,
  BridgeError,
};
