'use strict';
/**
 * The DSH **native event stream**: the one authentic transport a permission
 * approval (and an `open` question) can be decided through.
 *
 * Why this exists at all
 * ---------------------
 * `approval/request` is not a unary Remote method. Inside DSH it is a Cordis
 * *waterfall*: `dsh-user-approval` publishes it, every composed answerer may
 * return an outcome string (`allowed-once | rejected | cancelled | unavailable`),
 * and the first answerer to settle it wins. The installed app's own UI answers it
 * as a Remote **event listener** (`dsh-client-ui-approval/lib/client.js`:
 * `ctx.remote.$on("approval/request", …)`), and Remote events travel on the
 * Gateway's WebSocket mux - not on `/api/<endpoint>`.
 *
 * The transport, read from the installed source
 * ---------------------------------------------
 * `dsh-api-gateway/lib/types/stream-protocol.js` and `lib/index.js`:
 *   - WebSocket route      `/api/remote.mux`            (`REMOTE_STREAM_MUX_PATH`)
 *   - open one logical stream:
 *       `{type:'open', streamId:<uuid>, endpoint:'$events', payload:{args:{}}}`
 *   - the first item is      `{type:'ready', clientId, host}`
 *   - a pending waterfall is
 *       `{type:'waterfall', event, eventId, agentId, request}`
 *   - a settlement is        `{type:'cancel', eventId}`
 *   - the stream ends with   `{type:'end', streamId}` or
 *       `{type:'error', streamId, error:{code,message,details}}`
 *   - an answer rides the unary RPC `$events/result` (`claimsEndpoint` returns
 *     true for it) whose `payload.args` is exactly
 *       `{clientId, eventId, outcome:{kind:'result', value} | {kind:'next'}}`
 *     A `{kind:'next'}` outcome is the wire spelling of calling the waterfall's
 *     `next()`: it delegates instead of deciding.
 *
 * Rules this module holds to
 * --------------------------
 * - **Never decide something nobody asked for.** An unrelated or unrepresentable
 *   waterfall is delegated with `{kind:'next'}` at once; it is never held, never
 *   auto-answered, and never turned into an approval.
 * - **A submission is not a victory.** The gateway answers `ok` for a result whose
 *   `clientId`/`eventId` no longer match a live delivery too (another client
 *   answered first), so this module reports *submission* and nothing more. Proof
 *   is read from native state elsewhere (`dsh.js`), never inferred from HTTP 200.
 * - **Nothing survives its stream.** `end`, `error`, a socket close, a close by
 *   us, or a fresh `ready` clears every map, because an `eventId` from a dead
 *   generation can never be answered again. Reconnecting gets fresh events only.
 * - **Bounded, always.** At most a handful of approvals and question waits are
 *   ever held; anything larger is delegated so the phone never shows a form it
 *   cannot show in full.
 * - Unrelated waterfall events are delegated; broadcast (`emit`) events carry no
 *   reply and are ignored.
 *
 * The module is transport-only: the cookie, the loopback origin and the unary
 * RPC both come in from `dsh.js`, so no credential logic and no second HTTP stack
 * live here, and there is no cycle between the two files.
 */

const { EventEmitter } = require('node:events');
const crypto = require('node:crypto');

const { BridgeError } = require('./errors');
const { WebSocketClient } = require('./ws');

/** `REMOTE_STREAM_MUX_PATH` in the installed gateway. */
const REMOTE_STREAM_MUX_PATH = '/api/remote.mux';
/** `REMOTE_EVENT_STREAM_ENDPOINT`, the Gateway-internal logical stream. */
const EVENT_STREAM_ENDPOINT = '$events';
/** `REMOTE_EVENT_RESULT_ENDPOINT`, the unary RPC one outcome travels on. */
const EVENT_RESULT_ENDPOINT = '$events/result';

/** The two forwarded events this bridge understands. */
const APPROVAL_EVENT = 'approval/request';
const QUESTIONS_EVENT = 'user-questions/request';

/**
 * Hard caps on what may be held and presented. A request that does not fit is
 * delegated rather than trimmed: a half-shown approval is not an approval, and a
 * half-shown question is a question somebody could answer without seeing it.
 */
const EVENT_LIMITS = Object.freeze({
  approvals: 8,
  questionWaits: 4,
  questions: 8,
  options: 12,
  toolName: 128,
  callId: 128,
  reason: 4000,
  questionText: 1000,
  header: 200,
  detail: 1000,
  optionLabel: 200,
  optionDescription: 500,
});

/** A sentence for the phone when native is waiting in a form it cannot show. */
const TOO_LARGE_TO_DECIDE = 'a permission request is waiting here in a form this phone cannot show in full; decide it on the computer';

/**
 * The wire decision -> the **native** waterfall outcome.
 *
 * These spell differently on purpose, and getting it wrong is not cosmetic:
 * `dsh-user-approval` normalizes any return value outside its own vocabulary
 * `['allowed-once','rejected','cancelled','unavailable']` to `'unavailable'`
 * (`lib/types/index.js`, `request()`), and only `allowed-once` grants anything.
 * A bridge that submitted the phone's own word - `allow-once` - would therefore
 * grant nothing at all while looking like it had. The wire contract keeps the
 * phone-facing spelling; this map is the one place the native spelling exists.
 */
const NATIVE_APPROVAL_OUTCOME = Object.freeze({
  'allow-once': 'allowed-once',
  reject: 'rejected',
});

const DEFAULT_MAX_FRAME_BYTES = 1024 * 1024;
const DEFAULT_RECONNECT_MS = 2000;
const MAX_RECONNECT_MS = 30000;

/** A native sentence with control characters removed; Unicode is preserved. */
function sanitizeNativeText(value) {
  if (typeof value !== 'string') return '';
  return value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');
}

/** One bounded native sentence, or `null` when native sent something else. */
function boundedNativeText(value, limit) {
  if (typeof value !== 'string') return null;
  const text = sanitizeNativeText(value);
  if ([...text].length > limit) return null;
  return text;
}

/** One bounded optional native sentence: absent or empty means "not carried". */
function boundedOptionalNativeText(value, limit) {
  if (value === undefined || value === null) return undefined;
  const text = boundedNativeText(value, limit);
  if (text === null) return null;
  return text.length === 0 ? undefined : text;
}

/** A short native identifier on one line, or `null` when it cannot be trusted. */
function boundedIdentifier(value, limit) {
  if (typeof value !== 'string' || value.length === 0 || value.length > limit) return null;
  if (/[\r\n\t\u0000]/.test(value)) return null;
  return value;
}

/**
 * A native gateway event id.
 *
 * The gateway mints these with `randomUUID()` (`startRemoteEvent`), and the wire
 * contract states the same shape, so a value that is not a v4 UUID is not
 * addressable here: it is dropped rather than held, and it can never reach a
 * projection the relay would reject. A session id or a tool call id is a
 * different, non-UUID vocabulary and keeps {@link boundedIdentifier}.
 */
const EVENT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function isEventId(value) {
  return typeof value === 'string' && EVENT_ID_PATTERN.test(value);
}

/**
 * Whether one native question form can be shown in full.
 *
 * The questions themselves are presented from the session projection (one source
 * of truth); this only decides whether the waterfall that carries the *answer
 * channel* is one this bridge is willing to hold. It uses the same caps as the
 * projection mapping, so a form the phone cannot show can never become answerable
 * here either.
 */
function representableQuestions(value) {
  if (!Array.isArray(value) || value.length === 0 || value.length > EVENT_LIMITS.questions) return false;
  for (const question of value) {
    if (question === null || typeof question !== 'object' || Array.isArray(question)) return false;
    const id = boundedIdentifier(question.id, EVENT_LIMITS.callId);
    if (id === null) return false;
    if (boundedNativeText(question.question, EVENT_LIMITS.questionText) === null) return false;
    if (boundedOptionalNativeText(question.header, EVENT_LIMITS.header) === null) return false;
    if (boundedOptionalNativeText(question.detail, EVENT_LIMITS.detail) === null) return false;
    if (question.options !== undefined && question.options !== null) {
      if (!Array.isArray(question.options) || question.options.length === 0 || question.options.length > EVENT_LIMITS.options) return false;
      for (const option of question.options) {
        if (option === null || typeof option !== 'object' || Array.isArray(option)) return false;
        const label = boundedNativeText(option.label, EVENT_LIMITS.optionLabel);
        if (label === null || label.length === 0) return false;
        if (boundedOptionalNativeText(option.description, EVENT_LIMITS.optionDescription) === null) return false;
      }
    }
  }
  return true;
}

/**
 * The DSH event stream, over one WebSocket to the local backend.
 *
 * @param {{wsUrl: string, headers: () => Record<string,string>,
 *   sendResult: (args: object) => Promise<unknown>,
 *   WebSocketImpl?: typeof WebSocketClient, maxFrameBytes?: number,
 *   reconnectMs?: number, timeoutMs?: number, now?: () => number}} options
 */
class DshEventStream extends EventEmitter {
  constructor(options) {
    super();
    this.wsUrl = options.wsUrl;
    this.headers = options.headers;
    this.sendResult = options.sendResult;
    this.WebSocketImpl = options.WebSocketImpl ?? WebSocketClient;
    this.maxFrameBytes = options.maxFrameBytes ?? DEFAULT_MAX_FRAME_BYTES;
    this.reconnectMs = options.reconnectMs ?? DEFAULT_RECONNECT_MS;
    /** Bumped when a stream generation ends, so a late answer fails closed. */

    this.streamId = null;
    this.clientId = null;
    this.epoch = 0;
    /** Bumped on every teardown, so an in-flight submission from a dead stream fails closed. */
    this.generation = 0;
    this.ws = null;
    this.stopped = true;
    this.timer = null;
    this.delayMs = this.reconnectMs;
    this.lastError = null;
    /** id -> {id, toolName, callId?, reason?, agentId, epoch} */
    this.approvals = new Map();
    /**
     * The live answer channel of a question, by question identity.
     *
     * key `${agentId}\u0000${callId}` for a **timed** wait, whose request carries
     * `wait.callId`; key `${agentId}\u0000${LEGACY_QUESTION}` for a **legacy**
     * blocking request, which carries no `wait` at all and whose real tool call id
     * is only knowable from the session log (see {@link
     * DshEventStream.unresolvedLegacyQuestionWaitsFor}).
     * value -> {eventId, agentId, callId|null, epoch, questions, legacy}
     */
    this.questionWaits = new Map();
    /** eventIds currently being submitted, so one tap can never submit twice. */
    this.inflight = new Set();
  }

  get connected() {
    return this.clientId !== null && this.ws !== null && this.ws.open === true;
  }

  /** Begin connecting and keep the stream up. Never rejects; failures are events. */
  start() {
    if (!this.stopped) return;
    this.stopped = false;
    void this.connect();
  }

  /** Whether the socket is up, how many generations have run, and what waits now. */
  describe() {
    return {
      url: this.wsUrl,
      connected: this.connected,
      clientId: this.clientId === null ? null : 'set',
      epoch: this.epoch,
      approvals: this.approvals.size,
      questionWaits: this.questionWaits.size,
      lastError: this.lastError,
    };
  }

  /** The pending approvals of one session, newest first, bounded and sanitized. */
  approvalsFor(sessionId) {
    const out = [];
    for (const entry of this.approvals.values()) {
      if (entry.agentId !== sessionId) continue;
      const approval = { id: entry.id, toolName: entry.toolName };
      if (entry.callId !== undefined) approval.callId = entry.callId;
      if (entry.reason !== undefined) approval.reason = entry.reason;
      out.push(approval);
    }
    return out;
  }

  /** The question call ids of one session that really have a live answer channel. */
  answerableQuestionCalls(sessionId) {
    const ids = new Set();
    for (const entry of this.questionWaits.values()) {
      if (entry.agentId === sessionId && entry.callId !== null) ids.add(entry.callId);
    }
    return ids;
  }

  /** Whether one exact open question can be answered through the live stream. */
  hasQuestionWait(sessionId, callId) {
    const entry = this.questionWaits.get(questionKey(sessionId, callId));
    return entry !== undefined && entry.epoch === this.epoch;
  }

  /**
   * Whether this session has a real legacy blocking question channel held right now.
   *
   * `dsh-tool-ask-user`'s default `legacy` mode calls `ctx.userQuestions.ask()` with
   * no `wait`, and the forwarded waterfall request carries only `questions`,
   * `agent` and `signal` - never a call id (`dsh-user-questions/lib/index.js`,
   * `ask`). The call id of such a request exists solely in the session log, on the
   * `tool/call` event of the `ask_user_question` call it belongs to, so until that
   * correlation is made the channel is held without an addressable call id.
   */
  hasLegacyQuestion(sessionId) {
    return this.unresolvedLegacyQuestionWaitsFor(sessionId).length > 0;
  }

  /**
   * Every held legacy blocking question channel of one session.
   *
   * Each entry's `callId` is `null` until the caller correlates the request with
   * the exact open `ask_user_question` tool call and passes that id back to
   * {@link DshEventStream.submitQuestionAnswer}.
   * @returns {{eventId: string, agentId: string, callId: null, epoch: number, questions: object[], legacy: true}[]}
   */
  unresolvedLegacyQuestionWaitsFor(sessionId) {
    const out = [];
    for (const entry of this.questionWaits.values()) {
      if (entry.legacy === true && entry.agentId === sessionId && entry.epoch === this.epoch) out.push(entry);
    }
    return out;
  }

  async connect() {
    if (this.stopped || this.ws !== null) return;
    const url = this.wsUrl;
    const socket = new this.WebSocketImpl(url, { headers: this.headers(), maxFrameBytes: this.maxFrameBytes });
    this.ws = socket;
    this.streamId = crypto.randomUUID();
    /**
     * A socket that is no longer the current one must not be able to tear down or
     * feed the connection that replaced it: a destroyed socket still emits
     * `close`/`error` asynchronously, and acting on those would wipe the maps of a
     * live generation.
     */
    const isCurrent = () => this.ws === socket;
    let opened = false;
    socket.on('open', () => {
      if (!isCurrent()) return;
      // A background convenience socket must never be what keeps the process
      // alive: one-shot scripts and local checks open the adapter and then leave.
      socket.socket?.unref?.();
      opened = true;
      this.delayMs = this.reconnectMs;
      try {
        socket.send(JSON.stringify({ type: 'open', streamId: this.streamId, endpoint: EVENT_STREAM_ENDPOINT, payload: { args: {} } }));
      } catch (error) {
        if (isCurrent()) this.teardown(safeReason(error, 'the DSH event stream could not be opened'));
      }
    });
    socket.on('message', (text) => {
      if (isCurrent()) this.onMessage(text);
    });
    socket.on('close', (code, reason) => {
      if (!isCurrent()) return;
      this.teardown(opened ? `the DSH event stream closed (${code}${reason ? `: ${reason}` : ''})` : 'the DSH event stream did not open');
    });
    socket.on('error', (error) => {
      if (!isCurrent()) return;
      const detail = safeReason(error, 'the DSH event stream failed');
      this.teardown(detail);
      socket.destroy?.();
    });
    try {
      await socket.connect();
    } catch (error) {
      if (isCurrent()) this.teardown(safeReason(error, 'the DSH event stream did not connect'));
    }
  }

  /** One server frame. Never lets a malformed frame kill the process. */
  onMessage(text) {
    let frame;
    try {
      frame = JSON.parse(String(text));
    } catch {
      return;
    }
    if (frame === null || typeof frame !== 'object') return;
    if (frame.type === 'item') {
      this.onItem(frame.value);
      return;
    }
    if (frame.type === 'end') {
      this.teardown('the DSH event stream ended');
      return;
    }
    if (frame.type === 'error') {
      this.teardown(safeReason(frame.error?.message, 'the DSH event stream failed'));
    }
    // Anything else is a frame this build does not know: ignored, never guessed at.
  }

  onItem(value) {
    if (value === null || typeof value !== 'object') return;
    if (value.type === 'ready') {
      const clientId = typeof value.clientId === 'string' && value.clientId.length > 0 ? value.clientId : null;
      if (clientId === null) return;
      // A fresh ready is a fresh generation: nothing addressed to the previous one
      // may be answered any more.
      this.clearMaps();
      this.clientId = clientId;
      this.epoch += 1;
      this.generation += 1;
      this.lastError = null;
      this.emit('ready', { clientId, host: value.host ?? null });
      return;
    }
    if (value.type === 'waterfall') {
      this.onWaterfall(value);
      return;
    }
    if (value.type === 'cancel') {
      if (typeof value.eventId === 'string') this.dropEvent(value.eventId);
      return;
    }
    // `emit` (broadcast, no reply expected) and unknown item kinds: ignored.
  }

  onWaterfall(frame) {
    // A waterfall this bridge cannot even address (no gateway-shaped event id, or
    // no owning agent) is dropped without a reply: there is nothing to correlate
    // an answer to, and inventing one would be worse than silence.
    const eventId = isEventId(frame.eventId) ? frame.eventId : null;
    const agentId = boundedIdentifier(frame.agentId, 128);
    if (eventId === null || agentId === null || this.clientId === null) return;
    const request = frame.request !== null && typeof frame.request === 'object' && !Array.isArray(frame.request) ? frame.request : null;
    if (frame.event === APPROVAL_EVENT) {
      this.holdApproval({ eventId, agentId, request });
      return;
    }
    if (frame.event === QUESTIONS_EVENT) {
      this.holdQuestionWait({ eventId, agentId, request });
      return;
    }
    // An event this bridge does not decide: hand it back at once so nothing waits
    // on us. This is the whole reason `next` exists.
    this.delegate(eventId);
  }

  /**
   * Keep one real approval until it is decided, a stream ends, or native cancels
   * it. Anything unrepresentable is delegated instead of shown in part.
   */
  holdApproval({ eventId, agentId, request }) {
    if (request === null) {
      this.delegate(eventId);
      return;
    }
    const toolName = boundedNativeText(request.toolName, EVENT_LIMITS.toolName);
    const callId = boundedOptionalNativeText(request.callId, EVENT_LIMITS.callId);
    const reason = boundedOptionalNativeText(request.reason, EVENT_LIMITS.reason);
    if (toolName === null || toolName.trim().length === 0 || callId === null || reason === null) {
      this.delegate(eventId);
      return;
    }
    if (this.approvals.size >= EVENT_LIMITS.approvals) {
      this.delegate(eventId);
      return;
    }
    const entry = { id: eventId, toolName: toolName.trim(), agentId, epoch: this.epoch };
    if (callId !== undefined) entry.callId = callId;
    if (reason !== undefined) entry.reason = reason;
    this.approvals.set(eventId, entry);
    this.emit('change', { kind: 'approval', added: eventId });
  }

  /**
   * Keep the answer channel of one native question form.
   *
   * Native asks two ways, and both are real:
   *   - **timed** (`wait.timed === true` + `wait.callId`, set by `askTimed`): the
   *     request itself names its tool call, so the channel is addressable at once.
   *   - **legacy blocking** (`mode: 'legacy'`, the shipped default): the request
   *     carries no `wait` at all, because the blocking tool calls
   *     `ctx.userQuestions.ask()` and the service forwards only `questions`,
   *     `agent` and `signal`. The real call id lives on the `tool/call` event in
   *     the session log, so the channel is held **unresolved** until a caller
   *     correlates it with that exact open `ask_user_question` call.
   *
   * Both are held only when the whole form fits what the phone can show; anything
   * longer or stranger is delegated at once, because a half-shown question is a
   * question somebody could answer without seeing it.
   *
   * At most one unresolved legacy channel is kept per session: the blocking tool
   * waits for its answer before it can be called again, so a second one could not
   * be told apart from the first, and holding two identical forms would make the
   * answer ambiguous. The older one is handed back to the next answerer instead.
   */
  holdQuestionWait({ eventId, agentId, request }) {
    if (request === null) {
      this.delegate(eventId);
      return;
    }
    const timedCallId = boundedIdentifier(request.wait?.callId, EVENT_LIMITS.callId);
    const timed = request.wait?.timed === true && timedCallId !== null;
    const legacy = !timed && request.wait === undefined;
    if (!timed && !legacy) {
      // A `wait` this build does not understand (a blocking call that named a
      // callId but is not timed): delegated, exactly as before.
      this.delegate(eventId);
      return;
    }
    if (!representableQuestions(request.questions)) {
      this.delegate(eventId);
      return;
    }
    const key = timed ? questionKey(agentId, timedCallId) : legacyQuestionKey(agentId);
    const displaced = this.questionWaits.get(key);
    if (displaced === undefined && this.questionWaits.size >= EVENT_LIMITS.questionWaits) {
      this.delegate(eventId);
      return;
    }
    this.questionWaits.set(key, {
      eventId,
      agentId,
      callId: timed ? timedCallId : null,
      epoch: this.epoch,
      questions: request.questions,
      legacy: !timed,
    });
    // A second identical legacy form cannot be told apart from the first: the one
    // this bridge no longer holds goes back to the next answerer at once.
    if (displaced !== undefined) this.delegate(displaced.eventId);
    this.emit('change', { kind: 'question', added: timed ? timedCallId : null, sessionId: agentId });
  }

  /** Hand one waterfall back to the next answerer. Never throws at the caller. */
  delegate(eventId) {
    void this.postResult({ eventId, outcome: { kind: 'next' } }).catch(() => {});
  }

  /** Forget everything addressed to one settled request. */
  dropEvent(eventId) {
    if (this.approvals.delete(eventId)) this.emit('change', { kind: 'approval', removed: eventId });
    for (const [key, entry] of [...this.questionWaits.entries()]) {
      if (entry.eventId === eventId) {
        this.questionWaits.delete(key);
        this.emit('change', { kind: 'question', removed: entry.callId, sessionId: entry.agentId });
      }
    }
  }

  /**
   * Submit one decision for one live approval, exactly once.
   *
   * Everything must match the live generation: the map entry, its epoch, the
   * stream's own `clientId`, and the socket still being open. A stale, cancelled
   * or already-submitted request is refused with a safe error, and this method
   * deliberately reports only what the transport did.
   * @param {{sessionId: string, approvalId: string, decision: string}} input
   * @returns {Promise<{accepted: true, state: 'submitted'}>}
   */
  async submitApproval({ sessionId, approvalId, decision }) {
    const nativeOutcome = NATIVE_APPROVAL_OUTCOME[decision];
    if (typeof nativeOutcome !== 'string') {
      throw new BridgeError('invalid_params', 'that is not a decision this bridge can submit');
    }
    const entry = this.approvals.get(approvalId);
    if (entry === undefined || entry.agentId !== sessionId || entry.epoch !== this.epoch || !this.connected) {
      throw new BridgeError('session_not_found', 'that approval is not waiting for a decision any more');
    }
    if (this.inflight.has(approvalId)) {
      throw new BridgeError('bridge_error', 'that decision is already being submitted');
    }
    // Drop the local card first: this native request is now decided-or-raced, and
    // a second tap must never submit again.
    this.approvals.delete(approvalId);
    this.inflight.add(approvalId);
    try {
      await this.postResult({ eventId: approvalId, outcome: { kind: 'result', value: nativeOutcome } });
    } finally {
      this.inflight.delete(approvalId);
      this.emit('change', { kind: 'approval', removed: approvalId });
    }
    return { accepted: true, state: 'submitted' };
  }

  /**
   * Submit one answer for one native question form through its live waterfall.
   *
   * The form is looked up by its exact question identity: a **timed** wait by its
   * own `wait.callId`, a **legacy blocking** request by session through the only
   * unresolved legacy channel that session has. A caller that resolved a legacy
   * request with the real tool call id from the session log therefore submits
   * under exactly that id, and the waterfall that receives the answer is the one
   * the `ask_user_question` call is still waiting on.
   *
   * The answers are re-checked against the very form the native request carried,
   * so a batch that names an unknown question, offers a label native never
   * offered, or selects more options than the question takes is refused before
   * anything is sent. The caller keeps the RPC to the phone and proves acceptance
   * from native state; this method reports transport submission only.
   * @param {{sessionId: string, callId: string, answers: object[]}} input
   * @returns {Promise<{accepted: true}>}
   */
  async submitQuestionAnswer({ sessionId, callId, answers }) {
    const key = questionKey(sessionId, callId);
    let entry = this.questionWaits.get(key);
    let entryKey = key;
    if (entry === undefined) {
      const legacy = this.unresolvedLegacyQuestionWaitsFor(sessionId);
      // Two unresolved legacy forms in one session would be ambiguous; the hold
      // rule keeps at most one, and anything else is refused rather than guessed.
      if (legacy.length !== 1) {
        throw new BridgeError('not_capable', 'that question is still open in the DSH app; answer it there');
      }
      entry = legacy[0];
      entryKey = legacyQuestionKey(sessionId);
    }
    if (entry.epoch !== this.epoch || !this.connected) {
      throw new BridgeError('not_capable', 'that question is still open in the DSH app; answer it there');
    }
    assertAnswersAgainst(entry.questions, answers);
    if (this.inflight.has(entry.eventId)) {
      throw new BridgeError('bridge_error', 'that answer is already being submitted');
    }
    this.questionWaits.delete(entryKey);
    this.inflight.add(entry.eventId);
    try {
      await this.postResult({ eventId: entry.eventId, outcome: { kind: 'result', value: { answers: answers.map(copyAnswer) } } });
    } finally {
      this.inflight.delete(entry.eventId);
      this.emit('change', { kind: 'question', removed: callId });
    }
    return { accepted: true };
  }

  /** One `$events/result` RPC, through the caller's authenticated unary client. */
  async postResult({ eventId, outcome }) {
    const clientId = this.clientId;
    const generation = this.generation;
    if (clientId === null) {
      throw new BridgeError('bridge_error', 'the DSH event stream is not connected');
    }
    let result;
    try {
      result = await this.sendResult({ clientId, eventId, outcome });
    } catch (error) {
      throw new BridgeError('bridge_error', safeReason(error, 'the DSH backend refused that submission'));
    }
    // A transport answer that arrives after the stream this submission belongs to
    // has gone away proves nothing about the request any more.
    if (generation !== this.generation) {
      throw new BridgeError('bridge_error', 'the DSH event stream was replaced before that submission was answered');
    }
    if (result === null || typeof result !== 'object' || result.ok === false) {
      throw new BridgeError('bridge_error', 'the DSH backend refused that submission');
    }
    return result;
  }

  /** A stream generation is over: forget everything it was holding. */
  teardown(reason) {
    const hadState = this.approvals.size > 0 || this.questionWaits.size > 0 || this.clientId !== null;
    this.clearMaps();
    this.clientId = null;
    this.generation += 1;
    this.lastError = typeof reason === 'string' && reason.length > 0 ? reason : null;
    const socket = this.ws;
    this.ws = null;
    try {
      socket?.destroy?.();
    } catch {
      // already gone
    }
    if (hadState) this.emit('change', { kind: 'reset' });
    if (!this.stopped) {
      this.scheduleReconnect();
      this.emit('disconnected', this.lastError);
    }
  }

  scheduleReconnect() {
    if (this.stopped || this.timer !== null) return;
    const delay = this.delayMs;
    this.delayMs = Math.min(this.delayMs * 2, MAX_RECONNECT_MS);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.connect();
    }, delay);
    if (typeof this.timer.unref === 'function') this.timer.unref();
  }

  clearMaps() {
    this.approvals.clear();
    this.questionWaits.clear();
    // A submission still in flight belongs to the generation that is going away:
    // its `eventId` can never be delivered again, so holding it would only make a
    // future request look like it was already being submitted.
    this.inflight.clear();
  }

  /**
   * Stop for good: no reconnect, no held request, no live socket.
   *
   * Public on purpose: the adapter closes it when the bridge shuts down, and a
   * test may use it to prove that nothing survives the stream that carried it.
   */
  close() {
    this.stopped = true;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const socket = this.ws;
    this.ws = null;
    this.clearMaps();
    this.clientId = null;
    this.generation += 1;
    try {
      socket?.close?.(1000, '');
    } catch {
      // already gone
    }
    this.removeAllListeners();
  }
}

/** One session + call identity, in a key a Map can hold. */
function questionKey(sessionId, callId) {
  return `${sessionId}\u0000${callId}`;
}

/**
 * The identity of one session's unresolved legacy blocking question.
 *
 * `\u0001` cannot appear in a call id (`boundedIdentifier` refuses control
 * characters) nor in a session id, so this key can never collide with a real
 * `${sessionId}\u0000${callId}` pair.
 */
const LEGACY_QUESTION = '\u0001';

function legacyQuestionKey(sessionId) {
  return `${sessionId}\u0000${LEGACY_QUESTION}`;
}

/** One answer item, copied down to the three native fields. */
function copyAnswer(answer) {
  const entry = { id: answer.id, selected: [...answer.selected] };
  if (answer.custom !== undefined) entry.custom = answer.custom;
  return entry;
}

/**
 * Re-check an answer batch against the exact native form the request carried.
 *
 * This is the last line before the wire: it duplicates the adapter's fresh check
 * on purpose, because the frame's own questions are what native will validate the
 * batch against, and a mismatch there would be a wrong answer rather than a
 * refused one.
 */
function assertAnswersAgainst(questions, answers) {
  if (!Array.isArray(questions) || questions.length !== answers.length) {
    throw new BridgeError('invalid_params', 'the answer batch must name each of its questions exactly once');
  }
  const byId = new Map(questions.map((question) => [String(question.id), question]));
  const seen = new Set();
  for (const answer of answers) {
    if (seen.has(answer.id)) throw new BridgeError('invalid_params', 'every question may be answered only once');
    seen.add(answer.id);
    const question = byId.get(answer.id);
    if (question === undefined) throw new BridgeError('invalid_params', 'that answer names a question this call did not ask');
    const labels = new Set((Array.isArray(question.options) ? question.options : []).map((option) => String(option?.label ?? '')));
    const limit = question.multiSelect === true ? labels.size : 1;
    if (answer.selected.length > limit) throw new BridgeError('invalid_params', 'this question takes fewer selected options than that');
    for (const label of answer.selected) {
      if (!labels.has(label)) throw new BridgeError('invalid_params', 'that answer selected an option this question did not offer');
    }
  }
}

/** One short, safe reason sentence; never native raw text, never a secret. */
function safeReason(value, fallback) {
  const text = typeof value === 'string' ? value : value instanceof Error ? String(value.message ?? '') : '';
  const cleaned = text.replace(/[\r\n\t]+/g, ' ').trim();
  return cleaned.length === 0 ? fallback : cleaned.slice(0, 120);
}

/**
 * The answer batch a recorded `ask_user_question` tool result carries, or `null`.
 *
 * This is the proof one answered question is really the native tool's own result,
 * and it is the same reader native's own projection uses: `dsh-tool-ask-user`
 * renders the model-facing value with `JSON.stringify(value)` into a single text
 * block, and `dsh-user-questions` reads it back with `JSON.parse` +
 * `answerBatchSchema` (`lib/index.js`, `answerBatchOf`). The shape accepted here
 * is that schema's: an object whose `answers` is an array of
 * `{id, selected: string[], custom?}`.
 *
 * A pending result - the timed timeout payload - carries `pending: true` and no
 * `answers`, so it can never be read as an answer.
 * @param {unknown} content the recorded message content blocks
 * @returns {{id: string, selected: string[], custom?: string}[]|null}
 */
function containsAnswerBatch(content) {
  if (!Array.isArray(content)) return null;
  const text = content.find((block) => block !== null && typeof block === 'object' && block.type === 'text');
  if (text === undefined || typeof text.text !== 'string') return null;
  let parsed;
  try {
    parsed = JSON.parse(text.text);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  if (!Array.isArray(parsed.answers)) return null;
  const answers = [];
  for (const answer of parsed.answers) {
    if (answer === null || typeof answer !== 'object' || Array.isArray(answer)) return null;
    if (typeof answer.id !== 'string') return null;
    if (!Array.isArray(answer.selected) || answer.selected.some((label) => typeof label !== 'string')) return null;
    if (answer.custom !== undefined && typeof answer.custom !== 'string') return null;
    answers.push({
      id: answer.id,
      selected: [...answer.selected],
      ...(answer.custom === undefined ? {} : { custom: answer.custom }),
    });
  }
  return answers;
}

module.exports = {
  REMOTE_STREAM_MUX_PATH,
  EVENT_STREAM_ENDPOINT,
  EVENT_RESULT_ENDPOINT,
  APPROVAL_EVENT,
  QUESTIONS_EVENT,
  EVENT_LIMITS,
  TOO_LARGE_TO_DECIDE,
  NATIVE_APPROVAL_OUTCOME,
  DEFAULT_MAX_FRAME_BYTES,
  DEFAULT_RECONNECT_MS,
  MAX_RECONNECT_MS,
  sanitizeNativeText,
  boundedNativeText,
  boundedOptionalNativeText,
  boundedIdentifier,
  isEventId,
  representableQuestions,
  assertAnswersAgainst,
  questionKey,
  legacyQuestionKey,
  containsAnswerBatch,
  DshEventStream,
};
