/*!
 * core.js — pure logic for the AI Remote mobile web UI.
 *
 * No DOM, no network, no globals beyond one namespace. Loaded in the browser as
 * a plain <script> (no build step) and required directly by the Node unit tests
 * in mobile/tests/.
 *
 * Protocol: docs/design/api/protocol-v1.md (frozen contract, engineer may not
 * edit it). Field names, method names and error codes are kept verbatim.
 */
(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module && module.exports) {
    module.exports = api;
  }
  if (root) {
    root.RCCore = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // Crockford Base32 alphabet, per protocol-v1 4.6: 0-9 and A-Z minus I, L, O, U.
  var PAIR_ALPHABET_RE = /^[0-9A-HJKMNP-TV-Z]+$/;

  // A normalized pairing code is EXACTLY this many Crockford characters.
  //
  // protocol-v1 4.6 used to contradict itself: the regex and the worked example
  // are 6 groups of 4 = 24 chars (29 with the 5 dashes), while the prose said
  // "20 chars / 100 bit". Reported as Q-01 and settled by CRD 0004
  // (docs/decisions/crd/0004-pair-code-length-correction.md): the length is 24
  // and the prose was the typo. The contract is not mine to edit; this constant
  // is the client's lock on that ruling. Do not widen it to a range again --
  // an earlier revision accepted {20, 24} as a stopgap and that is now wrong.
  var PAIR_CODE_LENGTH = 24;

  /**
   * Normalize a user-supplied pairing code.
   *
   * protocol-v1 4.6: drop the "-" separators, upper-case, then apply the
   * Crockford alias rules (O -> 0, I/L -> 1, U -> V). Whitespace is tolerated
   * too, because 7.2 allows the caller to send an un-normalized 20-64 char
   * value and people paste codes with spaces in them.
   */
  function normalizePairCode(raw) {
    if (raw === null || raw === undefined) {
      return '';
    }
    return String(raw)
      .replace(/[\s-]/g, '')
      .toUpperCase()
      .replace(/O/g, '0')
      .replace(/[IL]/g, '1')
      .replace(/U/g, 'V');
  }

  /** True when the value normalizes to exactly PAIR_CODE_LENGTH Crockford chars. */
  function isValidPairCode(raw) {
    var normalized = normalizePairCode(raw);
    return normalized.length === PAIR_CODE_LENGTH && PAIR_ALPHABET_RE.test(normalized);
  }

  /**
   * Read "#pair=<code>" out of a URL fragment.
   *
   * An empty value ("#pair=") counts as absent: there is nothing to fill in and
   * a bogus "code is invalid" error would be worse than silence.
   */
  function parsePairFragment(hash) {
    var absent = { present: false, raw: '', code: '', valid: false };
    var text = hash === null || hash === undefined ? '' : String(hash);
    if (text.charAt(0) === '#') {
      text = text.slice(1);
    }
    if (text === '') {
      return absent;
    }
    var parts = text.split('&');
    for (var i = 0; i < parts.length; i++) {
      var eq = parts[i].indexOf('=');
      var key = eq === -1 ? parts[i] : parts[i].slice(0, eq);
      if (key !== 'pair') {
        continue;
      }
      var value = eq === -1 ? '' : parts[i].slice(eq + 1);
      value = safeDecode(value);
      if (value === '') {
        return absent;
      }
      return {
        present: true,
        raw: value,
        code: normalizePairCode(value),
        valid: isValidPairCode(value)
      };
    }
    return absent;
  }

  /**
   * Return the fragment with the "pair" parameter removed, so the code is not
   * left sitting in the address bar / history / a shared screenshot.
   */
  function stripPairFragment(hash) {
    var text = hash === null || hash === undefined ? '' : String(hash);
    if (text.charAt(0) === '#') {
      text = text.slice(1);
    }
    if (text === '') {
      return '';
    }
    var kept = text.split('&').filter(function (part) {
      var eq = part.indexOf('=');
      return (eq === -1 ? part : part.slice(0, eq)) !== 'pair';
    });
    return kept.length === 0 ? '' : '#' + kept.join('&');
  }

  function safeDecode(value) {
    try {
      return decodeURIComponent(value);
    } catch (err) {
      return value;
    }
  }

  // --- status / role labels (protocol-v1 4.3, 4.4) -------------------------

  var STATUS_LABELS = { idle: '空闲', working: '运行中', stopped: '已停止', error: '错误' };
  var STATUS_TONES = { idle: 'idle', working: 'working', stopped: 'stopped', error: 'error' };
  var ROLE_LABELS = { user: '我', assistant: 'AI', system: '系统', tool: '工具' };

  function own(obj, key) {
    return Object.prototype.hasOwnProperty.call(obj, key);
  }

  /**
   * 4.3: exactly four statuses. An unknown value is displayed with the "error"
   * styling but must not disable any button.
   */
  function statusLabel(status) {
    var key = typeof status === 'string' ? status : '';
    return own(STATUS_LABELS, key) ? STATUS_LABELS[key] : '未知状态';
  }

  function statusTone(status) {
    var key = typeof status === 'string' ? status : '';
    return own(STATUS_TONES, key) ? STATUS_TONES[key] : 'error';
  }

  /** 4.4: unknown role is shown as "system"; the message is never dropped. */
  function roleLabel(role) {
    var key = typeof role === 'string' ? role : '';
    return own(ROLE_LABELS, key) ? ROLE_LABELS[key] : '系统';
  }

  // --- tool display names --------------------------------------------------
  //
  // The wire uses the desktop's own lower-case ids (`codex`, `dsh`). The screen
  // shows the product name a person recognises. The ID is never rewritten --
  // every RPC keeps sending exactly what the desktop reported -- and a tool the
  // phone does not know keeps its own id instead of being mislabelled.
  var TOOL_LABELS = { codex: 'Codex', dsh: 'DSH', workbuddy: 'WorkBuddy' };

  function toolLabel(tool) {
    var key = str(tool);
    return own(TOOL_LABELS, key) ? TOOL_LABELS[key] : key;
  }

  // --- time (protocol-v1 4.2) ----------------------------------------------

  /**
   * 4.2 pins the wire format to RFC3339 UTC ending in "Z", at second or
   * millisecond precision ("must accept both"). A value without the Z is not
   * accepted: guessing a timezone would display the wrong time.
   */
  function parseTimestamp(value) {
    if (typeof value !== 'string') {
      return NaN;
    }
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/.test(value)) {
      return NaN;
    }
    return Date.parse(value);
  }

  function formatRelativeTime(iso, nowMs) {
    var parsed = parseTimestamp(iso);
    if (isNaN(parsed)) {
      return '';
    }
    var now = typeof nowMs === 'number' ? nowMs : Date.now();
    var diff = now - parsed;
    if (diff < 0) {
      diff = 0; // clock skew: never show a negative age
    }
    var seconds = Math.floor(diff / 1000);
    if (seconds < 60) {
      return '刚刚';
    }
    var minutes = Math.floor(seconds / 60);
    if (minutes < 60) {
      return minutes + ' 分钟前';
    }
    var hours = Math.floor(minutes / 60);
    if (hours < 24) {
      return hours + ' 小时前';
    }
    var days = Math.floor(hours / 24);
    if (days < 7) {
      return days + ' 天前';
    }
    return iso.slice(0, 10);
  }

  function pad2(value) {
    return value < 10 ? '0' + value : String(value);
  }

  /** Local HH:MM for a message timestamp (protocol-v1 4.2: display is client-side). */
  function formatClock(iso) {
    var parsed = parseTimestamp(iso);
    if (isNaN(parsed)) {
      return '';
    }
    var date = new Date(parsed);
    return pad2(date.getHours()) + ':' + pad2(date.getMinutes());
  }

  // --- search --------------------------------------------------------------

  function searchHaystack(session) {
    if (!session || typeof session !== 'object') {
      return '';
    }
    // The tool id AND its display name are indexed, because the chip the user
    // sees says "Codex"/"DSH" -- searching for what is on screen must work.
    return [
      session.title, session.tool, toolLabel(session.tool), session.status,
      statusLabel(session.status), session.cwd, session.projectName, session.id
    ]
      .map(function (value) {
        return value === null || value === undefined ? '' : String(value);
      })
      .join(' ')
      .toLowerCase();
  }

  /** Filter the session list by free text over title / tool / status. Pure. */
  function filterSessions(sessions, query) {
    if (!Array.isArray(sessions)) {
      return [];
    }
    var needle = query === null || query === undefined ? '' : String(query).trim().toLowerCase();
    if (needle === '') {
      return sessions.slice();
    }
    return sessions.filter(function (session) {
      return searchHaystack(session).indexOf(needle) !== -1;
    });
  }

  // --- errors (protocol-v1 6.2) --------------------------------------------

  var ERROR_MESSAGES = {
    invalid_json: '请求内容不是合法 JSON',
    invalid_request: '请求内容不合法',
    unauthenticated: '登录已失效，请重新配对',
    invalid_credentials: '配对码无效、已过期或已被使用',
    forbidden: '没有权限执行该操作',
    origin_forbidden: '请求来源被拒绝（Origin 不匹配）',
    not_found: '接口或资源不存在',
    method_not_allowed: '请求方法不被支持',
    payload_too_large: '请求内容过大',
    unsupported_media_type: '请求格式不受支持',
    rate_limited: '请求过于频繁，请稍后重试',
    internal: '服务器内部错误',
    bridge_offline: '电脑不在线，请确认电脑端已连接',
    bridge_busy: '电脑端正忙，请稍后重试',
    bridge_timeout: '电脑没有及时回应',
    bridge_bad_response: '电脑返回的数据无法识别',
    target_offline: '目标电脑当前不可用，请刷新电脑列表后重试',
    identity_conflict: '配对身份与当前登录身份冲突，请先退出后重试',
    unknown_method: '客户端请求有误（方法不被支持）',
    invalid_params: '客户端请求有误（参数不合法）',
    session_not_found: '会话不存在或不可见，请刷新列表',
    session_gone: '会话已经结束，请刷新列表',
    not_capable: '该会话不支持这个操作',
    too_long: '消息太长，请缩短后重试',
    bridge_error: '电脑端执行失败',
    // Added with the new-session feature (CRD 0006): HTTP 200 business errors,
    // same column as unknown_method.
    tool_unavailable: '该工具当前不可用（桌面端未打开或未连接）',
    model_not_available: '所选模型不可用，请重新选择',
    session_create_failed: '创建会话失败，请稍后重试'
  };

  /**
   * Chinese text for a protocol error code.
   *
   * protocol-v1 12.4: an unrecognised code is displayed the way `bridge_error`
   * is — show the server's own (safe) message — so `fallback` is used instead.
   */
  function errorMessage(code, fallback) {
    var key = typeof code === 'string' ? code : '';
    if (own(ERROR_MESSAGES, key)) {
      return ERROR_MESSAGES[key];
    }
    var text = typeof fallback === 'string' ? fallback.trim() : '';
    return text === '' ? '发生未知错误' : text;
  }

  /**
   * True only when the user must be sent back to the pairing screen.
   *
   * protocol-v1 6.2 (v2): 401 `unauthenticated` means "no valid identity".
   * 403 `forbidden` means "identity is fine, permission is not", and 403
   * `origin_forbidden` is a client bug -- neither may discard a live session.
   */
  function isAuthFailure(code) {
    return code === 'unauthenticated';
  }

  // --- request bodies (protocol-v1 7.3) ------------------------------------
  //
  // 7.3 whitelists params per method and says an extra field is
  // `invalid_params`, so these builders emit exactly the allowed keys.

  function listBody() {
    return { method: 'sessions.list', params: {} };
  }

  function readBody(tool, sessionId) {
    return { method: 'session.read', params: { tool: tool, sessionId: sessionId } };
  }

  function sendBody(tool, sessionId, text) {
    return { method: 'session.send', params: { tool: tool, sessionId: sessionId, text: text } };
  }

  function stopBody(tool, sessionId) {
    return { method: 'session.stop', params: { tool: tool, sessionId: sessionId } };
  }

  // --- stop gate (protocol-v1 9.2 / 9.5) -----------------------------------

  /** Only an explicit boolean `true` allows stopping. */
  function canStopOf(readResult) {
    return !!(readResult && readResult.canStop === true);
  }

  // --- change detection and polling (protocol-v1 7.3) ----------------------

  function messageIdSet(list) {
    var set = {};
    if (Array.isArray(list)) {
      list.forEach(function (message) {
        if (message && message.id !== undefined && message.id !== null) {
          set[String(message.id)] = true;
        }
      });
    }
    return set;
  }

  /** True when the set of message ids differs (order-only changes are not changes). */
  function messagesChanged(previous, next) {
    var before = messageIdSet(previous);
    var after = messageIdSet(next);
    var beforeKeys = Object.keys(before);
    if (beforeKeys.length !== Object.keys(after).length) {
      return true;
    }
    for (var i = 0; i < beforeKeys.length; i++) {
      if (!own(after, beforeKeys[i])) {
        return true;
      }
    }
    return false;
  }

  // The task row pins the list refresh at 2 seconds; 7.3 pins session.read at
  // ">= 2000 ms", advising 2000 while working and 5000 otherwise.
  var LIST_INTERVAL_MS = 2000;

  function readIntervalFor(status) {
    return status === 'working' ? 2000 : 5000;
  }

  /**
   * Decide what the single poll timer should do on this tick.
   *
   * Returns 'none' | 'list' | 'read'. 'none' also means "do not stack": a
   * request that has not come back yet blocks the next one.
   */
  function nextPollAction(state) {
    var s = state || {};
    if (!s.authed || s.hidden || s.inflight) {
      return 'none';
    }
    var now = Number(s.nowMs) || 0;
    if (s.view === 'detail' && s.sessionId) {
      var lastRead = Number(s.lastReadMs) || 0;
      return now - lastRead >= readIntervalFor(s.sessionStatus) ? 'read' : 'none';
    }
    var lastList = Number(s.lastListMs) || 0;
    return now - lastList >= LIST_INTERVAL_MS ? 'list' : 'none';
  }

  // -------------------------------------------------------------------------
  // New session: models.list + session.create
  //
  // Wire shapes per the coordinator's ruling (CRD 0006 records them; the
  // contract is being raised to v4). Fields are exactly:
  //   models.list    params {tool}
  //                  result {tool, models:[{id,label,provider?,isDefault?,
  //                          reasoningEfforts?,defaultReasoningEffort?}],
  //                          projects?:[{id,name,cwd}], reason?}
  //   session.create params {tool,model,provider?,reasoningEffort?,cwd?,
  //                          projectId?,text?,requestId}
  //                  result {sessionId,tool,title?,model,provider?,reasoningEffort?}
  // -------------------------------------------------------------------------

  /**
   * A fresh UUID v4 for one creation attempt.
   *
   * This is the de-duplication token: if a create times out we keep the SAME
   * id when the user retries, so a creation that actually landed on the desktop
   * is recognised instead of being repeated. We never retry on our own.
   */
  function newRequestId() {
    var bytes = new Uint8Array(16);
    if (typeof crypto !== 'undefined' && crypto && typeof crypto.getRandomValues === 'function') {
      crypto.getRandomValues(bytes);
    } else {
      for (var i = 0; i < 16; i++) {
        bytes[i] = Math.floor(Math.random() * 256);
      }
    }
    bytes[6] = (bytes[6] & 0x0f) | 0x40; // version 4
    bytes[8] = (bytes[8] & 0x3f) | 0x80; // variant 10
    var hex = [];
    for (var j = 0; j < 16; j++) {
      hex.push((bytes[j] + 0x100).toString(16).slice(1));
    }
    return hex.slice(0, 4).join('') + '-' + hex.slice(4, 6).join('') + '-' +
      hex.slice(6, 8).join('') + '-' + hex.slice(8, 10).join('') + '-' +
      hex.slice(10, 16).join('');
  }

  function modelsListBody(tool) {
    return { method: 'models.list', params: { tool: tool } };
  }

  /**
   * Build a session.create body.
   *
   * Optional string fields are OMITTED when absent or blank: the params
   * whitelist rejects unknown fields, and sending "" is not the same as
   * sending nothing.
   */
  function sessionCreateBody(input) {
    var source = input || {};
    var params = { tool: source.tool, model: source.model };
    ['provider', 'reasoningEffort', 'cwd', 'projectId', 'text', 'requestId'].forEach(function (key) {
      var value = source[key];
      if (typeof value === 'string' && value.trim() !== '') {
        params[key] = value;
      }
    });
    return { method: 'session.create', params: params };
  }

  /** Normalize a models.list result into selectable options. Never invents any. */
  function modelOptions(catalog) {
    var list = catalog && Array.isArray(catalog.models) ? catalog.models : [];
    var options = [];
    list.forEach(function (entry) {
      if (!entry || typeof entry !== 'object') {
        return;
      }
      if (typeof entry.id !== 'string' || entry.id === '') {
        return;
      }
      var option = {
        id: entry.id,
        label: typeof entry.label === 'string' && entry.label !== '' ? entry.label : entry.id,
        // Provider must survive: the same model id under two providers is two
        // different things. Codex simply has none.
        provider: typeof entry.provider === 'string' ? entry.provider : '',
        isDefault: entry.isDefault === true,
        reasoningEfforts: Array.isArray(entry.reasoningEfforts)
          ? entry.reasoningEfforts.filter(function (effort) {
            return typeof effort === 'string' && effort !== '';
          })
          : [],
        defaultReasoningEffort: typeof entry.defaultReasoningEffort === 'string'
          ? entry.defaultReasoningEffort : ''
      };
      // A stable identity for the <option> value. The id alone is NOT unique
      // (DSH reports one id under several providers), and a duplicate value
      // makes the browser resolve the select to the first match -- which
      // created the session on the wrong provider.
      option.key = modelOptionKey(option);
      option.text = modelOptionLabel(option);
      options.push(option);
    });
    return options;
  }

  /**
   * A unique identity for one selectable model entry.
   *
   * The separator is U+0000 because it cannot occur in a provider or model id.
   * It must NOT be "/": real provider ids contain slashes, for example
   * `azure-openai/us-east-1`.
   */
  function modelOptionKey(option) {
    if (!option || typeof option.id !== 'string') {
      return '';
    }
    var provider = typeof option.provider === 'string' ? option.provider : '';
    return provider + '\u0000' + option.id;
  }

  /** Map a key back to exactly the entry it came from. Null when unknown. */
  function modelOptionByKey(options, key) {
    if (!Array.isArray(options) || key === null || key === undefined || key === '') {
      return null;
    }
    for (var i = 0; i < options.length; i++) {
      var candidate = options[i];
      var candidateKey = typeof candidate.key === 'string' && candidate.key !== ''
        ? candidate.key : modelOptionKey(candidate);
      if (candidateKey === key) {
        return candidate;
      }
    }
    return null;
  }

  /**
   * What the user reads in the picker.
   *
   * The MODEL ID comes first and is the primary text. Codex's own label is a
   * vague English sentence ("Fast and affordable model for easier tasks.") that
   * hides the real model id, and the phone's rows truncate: with the sentence in
   * front, the truncation ate exactly the part that names the model. The label
   * is kept after the id as secondary help, never in place of it.
   *
   * The provider is shown as well, because one id can live under several
   * providers and they are not interchangeable. Repeated parts are collapsed.
   */
  function modelOptionLabel(option) {
    if (!option) {
      return '';
    }
    var parts = [];
    if (typeof option.id === 'string' && option.id !== '') {
      parts.push(option.id);
    }
    if (typeof option.label === 'string' && option.label !== '' && option.label !== option.id) {
      parts.push(option.label);
    }
    if (typeof option.provider === 'string' && option.provider !== '') {
      parts.push(option.provider);
    }
    var seen = {};
    return parts.filter(function (part) {
      if (seen[part]) {
        return false;
      }
      seen[part] = true;
      return true;
    }).join(' · ');
  }

  /**
   * The native description for an entry, when it is not the model's name.
   *
   * This is help text (a tooltip / secondary line), never the primary label and
   * never a replacement for the id. '' when the desktop gave no description or
   * when the description would just repeat the id.
   */
  function modelOptionDescription(option) {
    if (!option || typeof option.label !== 'string' || option.label === '') {
      return '';
    }
    if (typeof option.id === 'string' && option.label === option.id) {
      return '';
    }
    return option.label;
  }

  /**
   * The entry the catalog marked as default, else the first.
   *
   * We only ever pick from what the desktop actually reported -- a native
   * default has to be confirmed by the catalog, never assumed.
   */
  function defaultModelOption(options) {
    if (!Array.isArray(options) || options.length === 0) {
      return null;
    }
    for (var i = 0; i < options.length; i++) {
      if (options[i] && options[i].isDefault) {
        return options[i];
      }
    }
    return options[0];
  }

  /** Turn a chosen option into the create-params fragment it stands for. */
  function modelSelection(option, reasoningEffort) {
    if (!option || typeof option.id !== 'string') {
      return {};
    }
    var selection = { model: option.id };
    if (typeof option.provider === 'string' && option.provider !== '') {
      selection.provider = option.provider;
    }
    if (typeof reasoningEffort === 'string' && reasoningEffort !== '') {
      selection.reasoningEffort = reasoningEffort;
    }
    return selection;
  }

  function projectOptions(catalog) {
    var list = catalog && Array.isArray(catalog.projects) ? catalog.projects : [];
    return list.filter(function (entry) {
      return entry && typeof entry === 'object' && typeof entry.id === 'string' && entry.id !== '';
    }).map(function (entry) {
      var cwd = typeof entry.cwd === 'string' ? entry.cwd : '';
      var option = {
        id: entry.id,
        name: typeof entry.name === 'string' && entry.name !== '' ? entry.name : entry.id,
        cwd: cwd
      };
      // The navigation identity is the DIRECTORY, canonicalised. The desktop's
      // own project id stays in `id` (that is what a create must send), but two
      // entries that differ only by separator / trailing separator / letter case
      // are the same directory and must not be offered twice.
      var key = canonicalPath(cwd);
      option.key = key === '' ? 'id:' + entry.id : 'c:' + key;
      // Every id this entry can be matched by, e.g. a project filter the user
      // saved on an earlier visit that only carried the raw directory.
      option.matchIds = projectPathKeys(option);
      return option;
    });
  }

  /** The desktop's own safe explanation for an empty catalog, if it gave one. */
  function catalogReason(catalog) {
    return catalog && typeof catalog.reason === 'string' ? catalog.reason : '';
  }

  /**
   * Can the user actually choose a model?
   *
   * 'unsupported' -- the machine never declared the capability (protocol-v1 9.5
   *                  treats a missing key as false).
   * 'unavailable' -- the capability is there but the tool returned no models.
   * 'ready'       -- there is at least one real model to choose.
   *
   * Anything but 'ready' must be shown as an explicit "不可用", never as an
   * empty dropdown that looks like a choice with nothing in it.
   */
  function catalogState(input) {
    var source = input || {};
    var capabilities = source.capabilities || {};
    var tool = source.tool;
    var perToolKey = 'models.list:' + tool;
    var supported;
    if (own(capabilities, perToolKey)) {
      supported = capabilities[perToolKey] === true;
    } else {
      supported = capabilities['models.list'] === true;
    }
    if (!supported) {
      return 'unsupported';
    }
    return modelOptions(source.catalog).length > 0 ? 'ready' : 'unavailable';
  }

  // -------------------------------------------------------------------------
  // Activity folding (tool / system runs) and markdown link policy
  // -------------------------------------------------------------------------

  /** Roles that fold into a collapsed activity block. */
  function isActivityRole(role) {
    var key = typeof role === 'string' ? role : '';
    // protocol-v1 4.4: an unknown role is displayed as "system", so it folds too.
    return key !== 'user' && key !== 'assistant';
  }

  /**
   * Split a message list into renderable blocks.
   *
   * Adjacent tool/system messages become ONE activity block (collapsed by
   * default in the UI); user/assistant turns stay ordinary messages and are
   * never folded. Order is preserved and nothing is dropped.
   */
  function groupMessages(messages) {
    if (!Array.isArray(messages)) {
      return [];
    }
    var blocks = [];
    var run = null;
    messages.forEach(function (message) {
      if (!message || typeof message !== 'object') {
        return;
      }
      if (isActivityRole(message.role)) {
        if (!run) {
          run = { type: 'activity', items: [], count: 0 };
          blocks.push(run);
        }
        run.items.push(message);
        run.count = run.items.length;
        return;
      }
      run = null;
      blocks.push({ type: 'message', message: message });
    });
    return blocks;
  }

  /** A short Chinese label for a collapsed activity block. */
  function activitySummary(items) {
    if (!Array.isArray(items) || items.length === 0) {
      return '';
    }
    var tools = 0;
    var systems = 0;
    items.forEach(function (message) {
      if (message && typeof message.role === 'string' && message.role === 'tool') {
        tools += 1;
      } else {
        systems += 1;
      }
    });
    var parts = [];
    if (tools > 0) {
      parts.push('工具调用 ' + tools);
    }
    if (systems > 0) {
      parts.push('系统消息 ' + systems);
    }
    return parts.join(' · ');
  }

  /**
   * Is this href safe to put on an anchor?
   *
   * Only http/https/mailto and in-page anchors. Everything else -- notably
   * `javascript:`, `data:` and `file:` -- is refused. Control characters and
   * spaces are stripped FIRST, because browsers strip them before resolving a
   * scheme: without that step `java\tscript:` would slip through the check and
   * still execute.
   */
  function isSafeHref(url) {
    if (typeof url !== 'string') {
      return false;
    }
    var cleaned = url.replace(/[\u0000-\u0020\u007f]/g, '');
    if (cleaned === '') {
      return false;
    }
    if (cleaned.charAt(0) === '#') {
      return true;
    }
    var lower = cleaned.toLowerCase();
    return lower.indexOf('https://') === 0 ||
      lower.indexOf('http://') === 0 ||
      lower.indexOf('mailto:') === 0;
  }

  /**
   * Should the "this is not the whole history" note be shown?
   *
   * CRD 0007: `historyTruncated` is OPTIONAL and an older desktop side does not
   * send it at all, so only an explicit boolean `true` shows anything.
   * Truncation is not a fault: nothing is styled as an error and nothing is
   * disabled because of it.
   */
  function historyTruncatedNotice(readResult) {
    return !!(readResult && readResult.historyTruncated === true)
      ? '已显示最近记录，部分较早或过长的输出未加载'
      : '';
  }

  // -------------------------------------------------------------------------
  // Workbench list shaping: tabs, tool filter, project filter, pins
  //
  // Every value here comes from the desktop's own sessions.list result. Nothing
  // is invented: a session without a project simply has none, and a tool name
  // the phone does not recognise still gets its own filter chip so it can never
  // be filtered into invisibility.
  // -------------------------------------------------------------------------

  var TAB_LABELS = { chats: '会话', tasks: '任务', settings: '设置' };

  var TASK_STATUSES = { working: true, error: true };

  function str(value) {
    return value === null || value === undefined ? '' : String(value);
  }

  /** Is this session something the user has to act on right now? */
  function sessionNeedsInput(session) {
    return !!(session && session.needsInput === true);
  }

  /** 任务 tab: genuinely working, genuinely failed, or genuinely waiting on us. */
  function isTaskSession(session) {
    if (!session || typeof session !== 'object') {
      return false;
    }
    if (sessionNeedsInput(session)) {
      return true;
    }
    return own(TASK_STATUSES, str(session.status));
  }

  /**
   * Filter for one tab. `tab` is 'chats' | 'tasks' | 'settings'; anything else
   * is treated as 'chats'. Pure: the input array is never mutated.
   */
  function tabSessions(sessions, tab) {
    if (!Array.isArray(sessions)) {
      return [];
    }
    if (tab === 'tasks') {
      return sessions.filter(isTaskSession);
    }
    return sessions.slice();
  }

  /**
   * The tool chips to offer: 'all' first, then every tool the list really
   * mentions. A tool the phone does not know about still becomes a chip.
   */
  function toolChips(sessions) {
    var seen = {};
    var chips = [{ id: 'all', label: '全部' }];
    if (Array.isArray(sessions)) {
      sessions.forEach(function (session) {
        var tool = session && typeof session.tool === 'string' ? session.tool : '';
        if (tool === '' || seen[tool]) {
          return;
        }
        seen[tool] = true;
        chips.push({ id: tool, label: toolLabel(tool) });
      });
    }
    return chips;
  }

  function filterByTool(sessions, tool) {
    if (!Array.isArray(sessions)) {
      return [];
    }
    if (tool === 'all' || tool === '' || tool === null || tool === undefined) {
      return sessions.slice();
    }
    return sessions.filter(function (session) {
      return !!session && session.tool === tool;
    });
  }

  /** The project a session reports, or null. Never guessed from the title. */
  function sessionProject(session) {
    if (!session || typeof session !== 'object') {
      return null;
    }
    if (typeof session.projectId === 'string' && session.projectId !== '') {
      return {
        id: session.projectId,
        name: typeof session.projectName === 'string' && session.projectName !== ''
          ? session.projectName
          : session.projectId,
        cwd: typeof session.cwd === 'string' ? session.cwd : ''
      };
    }
    // A session that only reports a directory still has a project cue: the
    // directory itself, canonicalised so a path that differs only by separator
    // or trailing slash is ONE cue instead of two.
    if (typeof session.cwd === 'string' && canonicalPath(session.cwd) !== '') {
      var cwd = canonicalPath(session.cwd);
      return { id: cwd, name: '', cwd: cwd };
    }
    return null;
  }

  /**
   * Every identity a stored project filter refers to.
   *
   * A filter value is one specific thing to the user -- "this directory" -- but
   * it can be written as the desktop's project id, as a raw Windows path, or as
   * the canonical path that path normalises to. The set is built from the
   * navigation options the sheet shows, so a filter picked there always selects
   * the sessions it was picked for.
   */
  function projectMatchSet(options, projectId) {
    var wanted = str(projectId);
    var keys = {};
    if (wanted === '') {
      return keys;
    }
    keys[wanted] = true;
    var path = canonicalPath(wanted);
    if (path !== '') {
      keys[path] = true;
    }
    (Array.isArray(options) ? options : []).forEach(function (option) {
      if (!option || !projectOptionMatches(option, wanted)) {
        return;
      }
      var ids = option.matchIds && typeof option.matchIds === 'object' ? option.matchIds : {};
      Object.keys(ids).forEach(function (id) {
        keys[id] = true;
      });
      var optionPath = canonicalPath(option.cwd);
      if (optionPath !== '') {
        keys[optionPath] = true;
      }
      var id = str(option.id);
      if (id !== '') {
        keys[id] = true;
      }
    });
    return keys;
  }

  /**
   * Filter by project. `options` is optional and is the navigation-option list
   * (see mergeProjectOptions) when the caller has a live catalog: it is what lets
   * a filter expressed as one tool's project id select the sessions that only
   * report the directory.
   */
  function filterByProject(sessions, projectId, options) {
    if (!Array.isArray(sessions)) {
      return [];
    }
    if (projectId === '' || projectId === null || projectId === undefined) {
      return sessions.slice();
    }
    var keys = projectMatchSet(options, projectId);
    return sessions.filter(function (session) {
      var project = sessionProject(session);
      if (!project) {
        return false;
      }
      // Exact id first, then the canonical directory: a filter saved before
      // paths were canonicalised still selects the same sessions.
      if (project.id === projectId) {
        return true;
      }
      if (own(keys, project.id)) {
        return true;
      }
      var path = canonicalPath(project.cwd);
      return path !== '' && own(keys, path);
    });
  }

  /** Every project the current list really mentions, for the filter sheet. */
  function listProjects(sessions) {
    var seen = {};
    var projects = [];
    if (!Array.isArray(sessions)) {
      return projects;
    }
    sessions.forEach(function (session) {
      var project = sessionProject(session);
      if (!project || seen[project.id]) {
        return;
      }
      seen[project.id] = true;
      projects.push(project);
    });
    return projects;
  }

  function normaliseProjectName(name) {
    return str(name).replace(/[\\/]+$/, '').split(/[\\/]/).pop();
  }

  /** What to show for a project: its name, else the tail of its path. */
  function projectLabel(project) {
    if (!project) {
      return '';
    }
    if (typeof project.name === 'string' && project.name !== '') {
      return project.name;
    }
    return normaliseProjectName(project.cwd) || project.id;
  }

  // --- directory identity --------------------------------------------------
  //
  // The same directory arrives spelled several ways: the desktop's catalog says
  // `D:\workspace\app`, a session reports `d:/workspace/app/`, a hand-typed cwd
  // adds another backslash. All three are one directory. `canonicalPath` is the
  // equality key: one separator, no trailing separator, and lower case.
  //
  // Lower-casing is deliberate even on a case-sensitive POSIX box: Windows is
  // the only host this workbench is driven from, and folding case there is what
  // makes `D:\Work\App` and `d:\work\app` one entry instead of two. Nothing is
  // ever SENT from this key -- it is a comparison token only.

  /** A comparison key for a directory path. '' for a missing/blank path. */
  function canonicalPath(value) {
    // Surrounding whitespace is trimmed but INNER spaces are preserved:
    // "C:\Program Files" is one directory, not two.
    var text = str(value).replace(/^\s+|\s+$/g, '');
    if (text === '') {
      return '';
    }
    var normalised = text.replace(/\\/g, '/');
    while (normalised.length > 1 && normalised.charAt(normalised.length - 1) === '/') {
      normalised = normalised.slice(0, -1);
    }
    return normalised.toLowerCase();
  }

  /**
   * Every identity a project option can legitimately be filtered by.
   *
   * The desktop's own project id, plus the canonical directory. A stored project
   * filter from an earlier visit may carry either one, so both are accepted --
   * but only real values: an empty cwd contributes nothing.
   */
  function projectPathKeys(project) {
    var keys = {};
    if (!project) {
      return keys;
    }
    var id = str(project.id);
    if (id !== '') {
      keys[id] = true;
    }
    var path = canonicalPath(project.cwd);
    if (path !== '') {
      keys[path] = true;
    }
    return keys;
  }

  /**
   * The navigation options for the project sheet: real projects only, one entry
   * per real directory.
   *
   * `catalogProjects` come from the live models.list of ONE tool (its ids are
   * that tool's own). `sessionProjects` are the projects the current session
   * list reports, so a project that already has chats is still selectable.
   *
   * Deduplication rule, and the reason it is written down: an entry anchored on
   * the desktop's catalog is authoritative -- it carries a project id that a
   * create can actually send. A session-reported entry for the SAME directory
   * (same canonical path, whatever separators or project id it carried) is
   * folded into it rather than added next to it. That is what removes the
   * duplicated "same path, other slash" rows. An entry whose path is genuinely
   * absent from the catalog keeps its own place.
   *
   * Pure: the inputs are only read.
   */
  function mergeProjectOptions(catalogProjects, sessionProjects) {
    var catalogList = Array.isArray(catalogProjects) ? catalogProjects : [];
    var sessionList = Array.isArray(sessionProjects) ? sessionProjects : [];
    var out = [];
    var byKey = {};
    var catalogByKey = {};

    catalogList.forEach(function (project) {
      if (!project || str(project.id) === '') {
        return;
      }
      var key = str(project.key) !== '' ? project.key : 'id:' + str(project.id);
      if (own(byKey, key)) {
        // A second catalog entry for the SAME directory (the other tool names
        // it differently) is not a second option: fold its tool cue in. Two
        // entries with the same project id are likewise one project.
        mergeInto(byKey[key], project);
        return;
      }
      var entry = {
        key: key,
        id: str(project.id),
        name: typeof project.name === 'string' ? project.name : '',
        cwd: str(project.cwd),
        toolIds: {},
        matchIds: Object.assign({}, projectPathKeys(project)),
        fromCatalog: true
      };
      addToolId(entry, project.tool);
      byKey[key] = entry;
      catalogByKey[key] = entry;
      out.push(entry);
    });

    sessionList.forEach(function (project) {
      if (!project) {
        return;
      }
      var cwd = str(project.cwd);
      var path = canonicalPath(cwd);
      // A session entry for a directory the catalog already offered says
      // nothing new: fold its tool cue in and move on.
      if (path !== '' && own(catalogByKey, 'c:' + path)) {
        mergeInto(catalogByKey['c:' + path], project);
        return;
      }
      var id = str(project.id);
      if (id === '' && path === '') {
        return;
      }
      var key = path !== '' ? 'c:' + path : 'id:' + id;
      if (!own(byKey, key)) {
        byKey[key] = {
          key: key,
          // The desktop's own id when the session reported one, else the raw
          // directory: that is exactly what `filterByProject` compares against.
          id: id !== '' ? id : cwd,
          name: typeof project.name === 'string' ? project.name : '',
          cwd: cwd,
          toolIds: {},
          matchIds: Object.assign({}, projectPathKeys({ id: id, cwd: cwd })),
          fromCatalog: false
        };
        out.push(byKey[key]);
      }
      mergeInto(byKey[key], project);
    });

    return out;
  }

  /** Record that this project genuinely belongs to `tool`. Never guessed. */
  function addToolId(entry, tool) {
    var key = str(tool);
    if (key !== '' && !own(entry.toolIds, key)) {
      entry.toolIds[key] = entry.id;
    }
  }

  /** Fold a session-reported project into an existing navigation option. */
  function mergeInto(entry, project) {
    addToolId(entry, project.tool);
    var keys = projectPathKeys(project);
    Object.keys(keys).forEach(function (key) {
      entry.matchIds[key] = true;
    });
    if (entry.name === '' && typeof project.name === 'string' && project.name !== '') {
      entry.name = project.name;
    }
    if (entry.cwd === '' && str(project.cwd) !== '') {
      entry.cwd = str(project.cwd);
    }
  }

  /**
   * The tools a navigation option really maps to, in a stable order.
   * `preferred` (the tool the sheet is being shown for) sorts first.
   */
  function projectToolIds(entry, preferred) {
    if (!entry || !entry.toolIds || typeof entry.toolIds !== 'object') {
      return [];
    }
    var ids = Object.keys(entry.toolIds);
    var head = [];
    var tail = [];
    ids.forEach(function (id) {
      if (id === preferred) head.push(id);
      else tail.push(id);
    });
    return head.concat(tail);
  }

  /** True when this option is the one currently filtered on. */
  function projectOptionMatches(entry, projectId) {
    if (!entry) {
      return false;
    }
    var wanted = str(projectId);
    if (wanted === '') {
      return false;
    }
    if (own(entry.matchIds || {}, wanted)) {
      return true;
    }
    return str(entry.id) === wanted || canonicalPath(entry.cwd) === canonicalPath(wanted);
  }

  /**
   * Pins first, then the desktop's own order. `pinned` is a plain map so the
   * caller owns persistence (see prefs.js). Stable: equal ranks keep their
   * relative order.
   */
  function withPinsFirst(sessions, pinned) {
    if (!Array.isArray(sessions)) {
      return [];
    }
    var marks = pinned && typeof pinned === 'object' ? pinned : {};
    var head = [];
    var tail = [];
    sessions.forEach(function (session) {
      var id = session && session.id !== undefined && session.id !== null ? String(session.id) : '';
      if (id !== '' && marks[id] === true) {
        head.push(session);
      } else {
        tail.push(session);
      }
    });
    return head.concat(tail);
  }

  /** Toggle a pin in a copy of the map. Returns {pinned, next} — pure. */
  function togglePin(pinned, id) {
    var next = {};
    var marks = pinned && typeof pinned === 'object' ? pinned : {};
    Object.keys(marks).forEach(function (key) {
      if (marks[key] === true) {
        next[key] = true;
      }
    });
    var key = str(id);
    if (key === '') {
      return { pinned: false, next: next };
    }
    if (next[key] === true) {
      delete next[key];
      return { pinned: false, next: next };
    }
    next[key] = true;
    return { pinned: true, next: next };
  }

  function countTasks(sessions) {
    var counts = { needsInput: 0, working: 0, error: 0 };
    if (!Array.isArray(sessions)) {
      return counts;
    }
    sessions.forEach(function (session) {
      if (!session || typeof session !== 'object') {
        return;
      }
      if (sessionNeedsInput(session)) {
        counts.needsInput += 1;
      }
      if (session.status === 'working') {
        counts.working += 1;
      }
      if (session.status === 'error') {
        counts.error += 1;
      }
    });
    return counts;
  }

  function taskSummary(sessions) {
    var counts = countTasks(sessions);
    var parts = [];
    if (counts.needsInput > 0) {
      parts.push('待你确认 ' + counts.needsInput);
    }
    if (counts.working > 0) {
      parts.push('运行中 ' + counts.working);
    }
    if (counts.error > 0) {
      parts.push('出错 ' + counts.error);
    }
    return parts.join(' · ');
  }

  function tabLabel(tab) {
    return own(TAB_LABELS, str(tab)) ? TAB_LABELS[tab] : TAB_LABELS.chats;
  }

  // -------------------------------------------------------------------------
  // Pending questions and permission approvals
  //
  // Two hard rules govern everything below:
  //
  //   1. Nothing is synthesised. A label, an option, a reason or a tool name
  //      that the desktop did not report does not reach the screen.
  //   2. If a native form is LARGER than the agreed representation bounds, it is
  //      refused as a whole rather than shown with parts missing -- an
  //      incomplete form would submit an answer the user never chose.
  // -------------------------------------------------------------------------

  var Q_LIMITS = {
    batches: 4,        // pending question batches per session
    questions: 8,      // questions inside one batch
    options: 12,       // options inside one question
    question: 1000,    // characters
    header: 200,
    option: 500,
    reason: 4000,      // permission reason
    toolName: 128,
    approvals: 8,      // pending permission approvals per session
    id: 128
  };

  /**
   * One-line, control-character-free display text, clipped to `max` CHARACTERS.
   *
   * The clip counts code points, not UTF-16 units, so an emoji or any other
   * surrogate pair is never cut in half -- the relay's own bound counts runes
   * and the phone must not disagree about what "fits".
   */
  function clampText(value, max) {
    var text = str(value).replace(/[\u0000-\u0008\u000b-\u001f\u007f]+/g, ' ');
    text = text.replace(/\s+/g, ' ').trim();
    var points = Array.from(text);
    if (points.length > max) {
      return points.slice(0, max).join('');
    }
    return text;
  }

  /** Identity strings (callId, question id, option label) keep their exact value. */
  function idText(value, max) {
    return clampText(value, max);
  }

  function selectionValues(entry, key) {
    var bag = entry && typeof entry === 'object' ? entry : null;
    var list = bag && Array.isArray(bag[key]) ? bag[key] : [];
    return list.filter(function (value) {
      return typeof value === 'string' && value !== '';
    });
  }

  function optionOf(raw) {
    if (!raw || typeof raw !== 'object' || typeof raw.label !== 'string' || raw.label === '') {
      return null;
    }
    var option = { label: idText(raw.label, Q_LIMITS.option) };
    if (typeof raw.description === 'string' && raw.description !== '') {
      option.description = clampText(raw.description, Q_LIMITS.option);
    }
    return option;
  }

  function questionOf(raw) {
    if (!raw || typeof raw !== 'object') {
      return null;
    }
    var id = idText(raw.id, Q_LIMITS.id);
    if (id === '') {
      return null;
    }
    var question = {
      id: id,
      question: clampText(raw.question, Q_LIMITS.question),
      multiSelect: raw.multiSelect === true,
      options: []
    };
    if (typeof raw.header === 'string' && raw.header !== '') {
      question.header = clampText(raw.header, Q_LIMITS.header);
    }
    if (typeof raw.detail === 'string' && raw.detail !== '') {
      question.detail = clampText(raw.detail, Q_LIMITS.question);
    }
    var options = Array.isArray(raw.options) ? raw.options : [];
    for (var i = 0; i < options.length; i++) {
      var option = optionOf(options[i]);
      if (option) {
        question.options.push(option);
      }
    }
    return question;
  }

  function questionBatchOf(raw) {
    if (!raw || typeof raw !== 'object') {
      return null;
    }
    var callId = idText(raw.callId, Q_LIMITS.id);
    if (callId === '') {
      return null;
    }
    var batch = {
      callId: callId,
      state: raw.state === 'continued' ? 'continued' : 'open',
      questions: []
    };
    var questions = Array.isArray(raw.questions) ? raw.questions : [];
    for (var i = 0; i < questions.length; i++) {
      var question = questionOf(questions[i]);
      if (question) {
        batch.questions.push(question);
      }
    }
    if (batch.questions.length === 0) {
      return null;
    }
    return batch;
  }

  /**
   * What the read result says about pending questions.
   *
   * 'none'        -- the desktop reported NO pending question. This answer does
   *                  not depend on the answer capability: a tool that cannot be
   *                  answered from the phone, and which is not asking anything
   *                  either, has nothing to show. Deriving a waiting state from
   *                  a missing capability invented a panel that said "the AI is
   *                  waiting for you" while the machine was waiting for nothing.
   * 'unsupported' -- there IS a genuine native form, but this tool has no answer
   *                  capability, so it can only be shown as information.
   * 'oversized'   -- there is a form that is too large to render safely.
   * 'ready'       -- there is a form the phone can actually answer.
   *
   * No question content is ever invented: everything but 'none' requires real
   * native data.
   */
  function pendingQuestionsState(input) {
    var source = input || {};
    var capabilities = source.capabilities || {};
    var tool = source.tool;
    var raw = source.read && Array.isArray(source.read.pendingQuestions)
      ? source.read.pendingQuestions : [];
    // Absence of a question is the primary fact, and it is independent of what
    // this tool is able to do.
    if (raw.length === 0) {
      return 'none';
    }
    var key = 'session.answer:' + tool;
    var supported = own(capabilities, key)
      ? capabilities[key] === true
      : capabilities['session.answer'] === true;
    if (!supported) {
      return 'unsupported';
    }
    if (raw.length > Q_LIMITS.batches) {
      return 'oversized';
    }
    var batches = [];
    for (var i = 0; i < raw.length; i++) {
      var entry = raw[i];
      if (!entry || typeof entry !== 'object') {
        return 'oversized';
      }
      var questions = Array.isArray(entry.questions) ? entry.questions : [];
      if (questions.length > Q_LIMITS.questions) {
        return 'oversized';
      }
      for (var q = 0; q < questions.length; q++) {
        var options = questions[q] && Array.isArray(questions[q].options) ? questions[q].options : [];
        if (options.length > Q_LIMITS.options) {
          return 'oversized';
        }
      }
      var batch = questionBatchOf(entry);
      if (!batch) {
        return 'oversized';
      }
      batches.push(batch);
    }
    return batches.length > 0 ? 'ready' : 'none';
  }

  function pendingQuestionsOf(input) {
    if (pendingQuestionsState(input) !== 'ready') {
      return [];
    }
    var raw = input.read.pendingQuestions;
    var batches = [];
    for (var i = 0; i < raw.length; i++) {
      var batch = questionBatchOf(raw[i]);
      if (batch) {
        batches.push(batch);
      }
    }
    return batches;
  }

  var QUESTIONS_OVERSIZED_TEXT = '电脑上有待回答的问题，但内容超出手机能安全展示的范围。请在电脑上回答。';

  function pendingApprovalsOf(input) {
    var source = input || {};
    var capabilities = source.capabilities || {};
    var tool = source.tool;
    var key = 'session.approve:' + tool;
    var supported = own(capabilities, key)
      ? capabilities[key] === true
      : capabilities['session.approve'] === true;
    if (!supported) {
      return [];
    }
    var raw = source.read && Array.isArray(source.read.pendingApprovals)
      ? source.read.pendingApprovals : [];
    if (raw.length === 0 || raw.length > Q_LIMITS.approvals) {
      return [];
    }
    var out = [];
    for (var i = 0; i < raw.length; i++) {
      var entry = raw[i];
      if (!entry || typeof entry !== 'object') {
        continue;
      }
      var id = idText(entry.id, Q_LIMITS.id);
      if (id === '') {
        continue;
      }
      var approval = { id: id, toolName: clampText(entry.toolName, Q_LIMITS.toolName) };
      if (typeof entry.callId === 'string' && entry.callId !== '') {
        approval.callId = idText(entry.callId, Q_LIMITS.id);
      }
      if (typeof entry.reason === 'string' && entry.reason !== '') {
        approval.reason = clampText(entry.reason, Q_LIMITS.reason);
      }
      out.push(approval);
    }
    return out;
  }

  /** True when this read result genuinely leaves something for the user to do. */
  function readNeedsInput(input) {
    return pendingQuestionsState(input) === 'ready' || pendingApprovalsOf(input).length > 0;
  }

  var APPROVAL_DECISIONS = { 'allow-once': '仅允许本次', reject: '拒绝' };

  function approvalDecisionLabel(decision) {
    var key = str(decision);
    return own(APPROVAL_DECISIONS, key) ? APPROVAL_DECISIONS[key] : '';
  }

  // -------------------------------------------------------------------------
  // Composer and native-action bodies
  // -------------------------------------------------------------------------

  /**
   * The model override for the NEXT message only.
   *
   * 'inherit' is the phone default and means "say nothing": the desktop keeps
   * using whatever the session already uses. A chosen entry carries its own
   * provider, because the same model id under two providers is two models. DSH
   * refuses a model without a provider and Codex forbids one entirely, so a
   * Codex choice never grows a provider field.
   */
  function sendModelOverride(request) {
    var source = request || {};
    if (source.mode !== 'select') {
      return {};
    }
    var option = source.option;
    if (!option || typeof option.id !== 'string' || option.id === '') {
      return {};
    }
    var out = { model: option.id };
    if (source.tool !== 'codex' && typeof option.provider === 'string' && option.provider !== '') {
      out.provider = option.provider;
    }
    if (typeof source.reasoningEffort === 'string' && source.reasoningEffort !== '') {
      out.reasoningEffort = source.reasoningEffort;
    }
    return out;
  }

  /**
   * session.send body. With no selection (`mode !== 'select'`) this is
   * byte-for-byte the old three-field body, so an older desktop keeps working
   * and an older phone keeps its behaviour.
   */
  function sessionSendBody(input) {
    var source = input || {};
    if (source.mode !== 'select') {
      return sendBody(source.tool, source.sessionId, source.text);
    }
    return {
      method: 'session.send',
      params: Object.assign({
        tool: source.tool,
        sessionId: source.sessionId
      }, sendModelOverride(source), { text: source.text })
    };
  }

  /** session.answer body: answers for exactly one live callId. */
  function sessionAnswerBody(input) {
    var source = input || {};
    var list = Array.isArray(source.answers) ? source.answers : [];
    var answers = [];
    list.forEach(function (entry) {
      if (!entry || typeof entry !== 'object') {
        return;
      }
      var id = str(entry.id);
      if (id === '') {
        return;
      }
      var answer = { id: id, selected: selectionValues(entry, 'selected') };
      if (typeof entry.custom === 'string' && entry.custom !== '') {
        answer.custom = entry.custom;
      }
      answers.push(answer);
    });
    return {
      method: 'session.answer',
      params: {
        tool: source.tool,
        sessionId: source.sessionId,
        callId: source.callId,
        answers: answers
      }
    };
  }

  /** session.approve body: one exact native approval, one explicit decision. */
  function sessionApproveBody(input) {
    var source = input || {};
    return {
      method: 'session.approve',
      params: {
        tool: source.tool,
        sessionId: source.sessionId,
        approvalId: source.approvalId,
        decision: source.decision
      }
    };
  }

  /**
   * Which option labels an answer is allowed to carry, checked against the
   * FRESH form before anything is submitted. Returns the safe batch, or null
   * when the user's choice no longer matches the questions on screen.
   */
  function validateAnswers(batches, callId, answerInput) {
    var wanted = null;
    (Array.isArray(batches) ? batches : []).forEach(function (batch) {
      if (batch && batch.callId === callId) {
        wanted = batch;
      }
    });
    if (!wanted) {
      return null;
    }
    var submitted = Array.isArray(answerInput) ? answerInput : [];
    var out = [];
    for (var i = 0; i < wanted.questions.length; i++) {
      var question = wanted.questions[i];
      var entry = null;
      for (var j = 0; j < submitted.length; j++) {
        if (submitted[j] && str(submitted[j].id) === question.id) {
          entry = submitted[j];
        }
      }
      var selected = entry ? selectionValues(entry, 'selected') : [];
      var labels = question.options.map(function (option) { return option.label; });
      var kept = [];
      for (var s = 0; s < selected.length; s++) {
        if (labels.indexOf(selected[s]) !== -1 && kept.indexOf(selected[s]) === -1) {
          kept.push(selected[s]);
        }
      }
      var custom = entry && typeof entry.custom === 'string' ? entry.custom : '';
      if (labels.length === 0) {
        // A free-form question: there is nothing to tick, so only text can be
        // the answer. Anything else would fail the relay's "an answer needs an
        // option or custom text" rule after the user thought they had answered.
        if (custom.trim() === '' || kept.length > 0) {
          return null;
        }
      } else if (question.multiSelect) {
        // Multi-select: any number of real options, and/or free text.
        if (kept.length === 0 && custom.trim() === '') {
          return null;
        }
      } else {
        // Single-select: exactly one answer, and it must be a real option XOR
        // custom text -- never both, which is not a choice the user could make.
        if (kept.length > 1) {
          return null;
        }
        if (kept.length === 1 && custom.trim() !== '') {
          return null;
        }
        if (kept.length === 0 && custom.trim() === '') {
          return null;
        }
      }
      var answer = { id: question.id, selected: kept };
      if (custom !== '') {
        answer.custom = custom;
      }
      out.push(answer);
    }
    return out.length > 0 ? out : null;
  }

  // -------------------------------------------------------------------------
  // Native current model (session.read.currentModel)
  //
  // This is what the DESKTOP reports about the session right now. A value the
  // phone remembers from the picker is a preference, not proof of a native
  // state, and the two are never mixed.
  // -------------------------------------------------------------------------

  function currentModelOf(readResult) {
    var raw = readResult && readResult.currentModel;
    if (!raw || typeof raw !== 'object' || typeof raw.model !== 'string') {
      return null;
    }
    var model = clampText(raw.model, Q_LIMITS.toolName);
    if (model === '') {
      return null;
    }
    var out = { model: model };
    if (typeof raw.provider === 'string') {
      var provider = clampText(raw.provider, Q_LIMITS.toolName);
      if (provider !== '') {
        out.provider = provider;
      }
    }
    if (typeof raw.reasoningEffort === 'string') {
      var effort = clampText(raw.reasoningEffort, Q_LIMITS.header);
      if (effort !== '') {
        out.reasoningEffort = effort;
      }
    }
    return out;
  }

  /** Short Chinese description of the native current model, or ''. */
  function currentModelLabel(current) {
    if (!current) {
      return '';
    }
    var parts = [current.model];
    if (current.provider) {
      parts.push(current.provider);
    }
    if (current.reasoningEffort) {
      parts.push(current.reasoningEffort);
    }
    var seen = {};
    return parts.filter(function (part) {
      if (seen[part]) {
        return false;
      }
      seen[part] = true;
      return true;
    }).join(' · ');
  }

  /**
   * The value the picker shows when nothing was chosen: "沿用当前模型", with the
   * native model appended only when the desktop actually reported one.
   */
  function inheritModelLabel(current) {
    var label = currentModelLabel(current);
    return label === '' ? '沿用当前模型' : '沿用当前模型（现在：' + label + '）';
  }

  return {
    normalizePairCode: normalizePairCode,
    isValidPairCode: isValidPairCode,
    PAIR_CODE_LENGTH: PAIR_CODE_LENGTH,
    parsePairFragment: parsePairFragment,
    stripPairFragment: stripPairFragment,
    statusLabel: statusLabel,
    statusTone: statusTone,
    roleLabel: roleLabel,
    TOOL_LABELS: TOOL_LABELS,
    toolLabel: toolLabel,
    formatRelativeTime: formatRelativeTime,
    formatClock: formatClock,
    filterSessions: filterSessions,
    errorMessage: errorMessage,
    isAuthFailure: isAuthFailure,
    listBody: listBody,
    readBody: readBody,
    sendBody: sendBody,
    stopBody: stopBody,
    canStopOf: canStopOf,
    messagesChanged: messagesChanged,
    readIntervalFor: readIntervalFor,
    nextPollAction: nextPollAction,
    LIST_INTERVAL_MS: LIST_INTERVAL_MS,
    newRequestId: newRequestId,
    modelsListBody: modelsListBody,
    sessionCreateBody: sessionCreateBody,
    modelOptions: modelOptions,
    modelOptionKey: modelOptionKey,
    modelOptionByKey: modelOptionByKey,
    modelOptionLabel: modelOptionLabel,
    modelOptionDescription: modelOptionDescription,
    defaultModelOption: defaultModelOption,
    modelSelection: modelSelection,
    projectOptions: projectOptions,
    catalogReason: catalogReason,
    catalogState: catalogState,
    groupMessages: groupMessages,
    activitySummary: activitySummary,
    isSafeHref: isSafeHref,
    historyTruncatedNotice: historyTruncatedNotice,
    // workbench list shaping
    TAB_LABELS: TAB_LABELS,
    tabLabel: tabLabel,
    tabSessions: tabSessions,
    isTaskSession: isTaskSession,
    sessionNeedsInput: sessionNeedsInput,
    toolChips: toolChips,
    filterByTool: filterByTool,
    filterByProject: filterByProject,
    projectMatchSet: projectMatchSet,
    sessionProject: sessionProject,
    listProjects: listProjects,
    projectLabel: projectLabel,
    // directory identity and the project sheet's navigation options
    canonicalPath: canonicalPath,
    projectPathKeys: projectPathKeys,
    mergeProjectOptions: mergeProjectOptions,
    projectToolIds: projectToolIds,
    projectOptionMatches: projectOptionMatches,
    withPinsFirst: withPinsFirst,
    togglePin: togglePin,
    countTasks: countTasks,
    taskSummary: taskSummary,
    // pending questions and permission approvals
    Q_LIMITS: Q_LIMITS,
    QUESTIONS_OVERSIZED_TEXT: QUESTIONS_OVERSIZED_TEXT,
    clampText: clampText,
    pendingQuestionsState: pendingQuestionsState,
    pendingQuestionsOf: pendingQuestionsOf,
    pendingApprovalsOf: pendingApprovalsOf,
    readNeedsInput: readNeedsInput,
    approvalDecisionLabel: approvalDecisionLabel,
    validateAnswers: validateAnswers,
    // bodies
    sessionSendBody: sessionSendBody,
    sendModelOverride: sendModelOverride,
    sessionAnswerBody: sessionAnswerBody,
    sessionApproveBody: sessionApproveBody,
    // native current model
    currentModelOf: currentModelOf,
    currentModelLabel: currentModelLabel,
    inheritModelLabel: inheritModelLabel
  };
});
