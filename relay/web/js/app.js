/*!
 * app.js — the mobile AI workbench. Binds the markup in index.html to the
 * protocol.
 *
 * Rules this file exists to keep (task row + workbench requirements):
 *   - every piece of desktop text is written with textContent; innerHTML is
 *     never touched anywhere in mobile/web/ (mobile/tests/source-guards.test.js
 *     enforces it, and the test DOM throws if it is ever assigned)
 *   - one poll timer, 2s, paused while document.hidden, never stacked
 *   - the message list keeps its scroll position across a refresh
 *   - canStop and capabilities decide the stop button; the phone never uses a
 *     local constant to decide what the computer can do (protocol-v1 9.5)
 *   - the phone never invents a tool, a project, a model, a question, an option
 *     or an approval. Everything on screen comes from a live desktop response.
 *   - a mutation is submitted at most once per explicit human tap; no automatic
 *     retry, no automatic send, no automatic answer, no blanket approval.
 *
 * Protocol: docs/design/api/protocol-v1.md. Pure logic lives in core.js so it
 * can be unit tested without a DOM; local UI preferences live in prefs.js.
 */
(function (root, factory) {
  'use strict';
  var api = factory(root);
  if (typeof module === 'object' && module && module.exports) {
    module.exports = api;
  }
  if (root) {
    root.RCApp = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  'use strict';

  var core = root && root.RCCore ? root.RCCore : require('./core.js');
  var prefsModule = root && root.RCPrefs ? root.RCPrefs : require('./prefs.js');
  var ui = root && root.RCUi ? root.RCUi : require('./ui.js');

  var DEFAULT_DEVICE_NAME = '手机';
  var STOP_UNSUPPORTED_TEXT = '电脑端未启用这个会话的停止功能';
  var QUESTION_UNSUPPORTED_TEXT = '这个会话不支持在手机上回答，请在电脑上回答。';
  var APPROVAL_SENT_TEXT = '已提交，等待电脑确认…';
  var ANSWER_SENT_TEXT = '已提交，等待电脑处理…';
  var APP_VERSION_TEXT = 'AI 工作台 · 手机端界面';

  function createApp(env) {
    var document = env.document;
    var host = env.window;
    var apiClient = env.api;
    var now = env.now || function () { return Date.now(); };
    var setTimer = env.setTimeout || setTimeout;
    var clearTimer = env.clearTimeout || clearTimeout;
    var deviceName = env.deviceName || DEFAULT_DEVICE_NAME;
    var storage = env.storage || null;

    var prefs = prefsModule.createPrefs(storage);

    var el = {
      appbar: byId('appbar'),
      appbarTitle: byId('appbar-title'),
      adminContext: byId('admin-context'),
      adminContextName: byId('admin-context-name'),
      adminContextBack: byId('admin-context-back'),
      tabbar: byId('tabbar'),
      tabChats: byId('tab-chats'),
      tabTasks: byId('tab-tasks'),
      tabTasksBadge: byId('tab-tasks-badge'),
      tabSettings: byId('tab-settings'),
      loading: byId('loading-screen'),
      pair: byId('pair-screen'),
      pairUserForm: byId('pair-user-form'),
      list: byId('list-screen'),
      detail: byId('detail-screen'),
      settings: byId('settings-screen'),
      pairCode: byId('pair-code-input'),
      pairName: byId('pair-name-input'),
      pairSubmit: byId('pair-submit'),
      pairError: byId('pair-error'),
      pairAdminLoginToggle: byId('pair-admin-login-toggle'),
      adminLoginPanel: byId('admin-login-panel'),
      adminUsername: byId('admin-username-input'),
      adminPassword: byId('admin-password-input'),
      adminLoginSubmit: byId('admin-login-submit'),
      adminLoginBack: byId('admin-login-back'),
      adminLoginError: byId('admin-login-error'),
      adminRoster: byId('admin-roster-screen'),
      adminRosterError: byId('admin-roster-error'),
      adminRosterEmpty: byId('admin-roster-empty'),
      adminComputerList: byId('admin-computer-list'),
      adminToolFilter: byId('admin-tool-filter'),
      adminLogout: byId('admin-logout-button'),
      adminEnrollmentButton: byId('admin-enrollment-button'),
      adminEnrollmentResult: byId('admin-enrollment-result'),
      search: byId('search-input'),
      toolFilter: byId('tool-filter'),
      projectFilterButton: byId('project-filter-button'),
      filterClearButton: byId('filter-clear-button'),
      taskSummary: byId('task-summary'),
      sessionList: byId('session-list'),
      listEmpty: byId('list-empty'),
      notice: byId('notice'),
      noticeText: byId('notice-text'),
      noticeRetry: byId('notice-retry'),
      // The ONE sign-out control, which now lives in 设置. Its id is unchanged.
      logout: byId('logout-button'),
      connBadge: byId('conn-badge'),
      detailBack: byId('detail-back'),
      detailStatus: byId('detail-status'),
      detailTitle: byId('detail-title'),
      detailTool: byId('detail-tool'),
      detailTruncated: byId('detail-truncated'),
      detailError: byId('detail-error'),
      messageList: byId('message-list'),
      composer: byId('composer'),
      workBuddyReadonlyNote: byId('workbuddy-readonly-note'),
      workBuddyReadonlyText: byId('workbuddy-readonly-text'),
      workBuddyReadonlyLink: byId('workbuddy-readonly-link'),
      sendInput: byId('send-input'),
      sendButton: byId('send-button'),
      stopButton: byId('stop-button'),
      stopReason: byId('stop-reason'),
      detailPartial: byId('detail-partial'),
      detailPartialText: byId('detail-partial-text'),
      detailPartialRetry: byId('detail-partial-retry'),
      approvalsPanel: byId('approvals-panel'),
      approvalsList: byId('approvals-list'),
      questionsPanel: byId('questions-panel'),
      questionsList: byId('questions-list'),
      questionsUnsupported: byId('questions-unsupported'),
      modelChipRow: byId('model-chip-row'),
      modelChipButton: byId('model-chip-button'),
      modelResetButton: byId('model-reset-button'),
      modelPicker: byId('model-picker'),
      modelPickerList: byId('model-picker-list'),
      modelPickerEffort: byId('model-picker-effort'),
      modelPickerEffortSelect: byId('model-picker-effort-select'),
      modelPickerNote: byId('model-picker-note'),
      themeChoices: byId('theme-choices'),
      prefsSummary: byId('prefs-summary'),
      prefsResetButton: byId('prefs-reset-button'),
      pinsSummary: byId('pins-summary'),
      pinsClearButton: byId('pins-clear-button'),
      settingsVersion: byId('settings-version'),
      accountSummary: byId('account-summary'),
      settingsAdminLogin: byId('settings-admin-login'),
      sheetBackdrop: byId('sheet-backdrop'),
      projectSheet: byId('project-sheet'),
      projectSheetClose: byId('project-sheet-close'),
      projectSearch: byId('project-search-input'),
      projectSheetList: byId('project-sheet-list'),
      projectSheetEmpty: byId('project-sheet-empty'),
      newSessionButton: byId('new-session-button'),
      newScreen: byId('new-screen'),
      newBack: byId('new-back'),
      toolChoices: byId('tool-choices'),
      newAvailability: byId('new-availability'),
      workBuddyOfficialHelp: byId('workbuddy-official-help'),
      workBuddyOfficialHelpText: byId('workbuddy-official-help-text'),
      newNativeControls: byId('new-native-controls'),
      modelSelect: byId('model-select'),
      effortRow: byId('effort-row'),
      effortSelect: byId('effort-select'),
      projectRow: byId('project-row'),
      projectSelect: byId('project-select'),
      newText: byId('new-text'),
      newTextHint: byId('new-text-hint'),
      cwdRow: byId('cwd-row'),
      cwdInput: byId('cwd-input'),
      newSubmit: byId('new-submit'),
      newError: byId('new-error')
    };

    function byId(id) {
      return document.getElementById(id);
    }

    var stored = prefs.get();

    var state = {
      // The PROTOCOL view. The workbench tabs are not screens: 会话/任务/设置 are
      // three shapes of the same list view, so switching them can never abandon
      // a refresh, a search string or a filter.
      screen: 'loading',
      tab: own(core.TAB_LABELS, stored.tab) ? stored.tab : 'chats',
      // The search string itself is deliberately NOT remembered: a remembered
      // search is how a list looks mysteriously empty after a restart. The tab,
      // the tool and the project filter are remembered (they are visible).
      query: '',
      toolFilter: stored.tool,
      projectFilter: stored.projectId,
      code: '',
      sessions: [],
      capabilities: null,
      current: null,
      online: true,
      // Have we ever seen this device accepted by the server? It starts false,
      // and only a successful call flips it. It is NOT inferred from an HTTP
      // status: a fresh device whose first call fails for any reason at all
      // (401, 403, 501 from a proxy, no network) must still be able to pair.
      authed: false,
      admin: false,
      identity: null,
      selectedComputer: null,
      adminComputers: [],
      adminRosterFilter: 'all',
      adminRosterLoading: false,
      adminRosterError: '',
      adminLoginBusy: false,
      adminReturnScreen: 'pair',
      userWasPairedBeforeAdmin: false,
      inflight: false,
      busySend: false,
      busyStop: false,
      busyAnswer: false,
      busyApprove: false,
      lastListMs: 0,
      lastReadMs: 0,
      // Which folded activity blocks the user opened, keyed by message id.
      // Kept outside the DOM so a 2-second refresh cannot lose it.
      expandedActivity: {},
      // Which model entries each open session has fetched, and which one the
      // user picked for the NEXT message only.
      sessionCatalog: null,
      // One catalog per tool, so the project sheet can show an honest
      // tool-by-tool mapping instead of assuming the last-fetched one.
      sessionCatalogs: {},
      // Drafts and receipts that must survive a poll: one entry per session for
      // the composer draft, and per callId / approvalId for the pending panels.
      drafts: {},
      answerDrafts: {},
      answerReceipts: {},
      approvalReceipts: {},
      timer: null,
      lastRosterMs: 0
    };


    // Requests currently in flight, and a generation counter for the detail
    // view. The counter is what lets a late answer for session A be recognised
    // as stale after the user has moved to session B (or back to the list).
    var pendingByScope = {};
    var detailRequestSeq = 0;
    var scopeGeneration = 0;
    // The new-session panel: which tool is chosen, what the desktop reported,
    // and the generation counters that make a late answer harmless.
    var newPanelSeq = 0;
    var createSeq = 0;
    var newState = {
      tool: 'codex',
      catalog: null,
      // One catalog per tool, so switching back and forth does not re-fetch in
      // a loop and a project chosen for one tool is still nameable.
      catalogs: {},
      catalogsByScope: {},
      projectNames: {},
      projectNamesByScope: {},
      loading: false,
      // One creation attempt = one requestId. It is reused when the user
      // retries the SAME attempt so the desktop can de-duplicate, and replaced
      // as soon as the user changes what would be created.
      requestId: '',
      busy: false,
      partial: null
    };

    function currentScopeKey() {
      if (state.admin) {
        return 'admin:' + (state.selectedComputer && state.selectedComputer.clientId
          ? String(state.selectedComputer.clientId) : 'roster');
      }
      var identity = state.identity || {};
      return 'user:' + (identity.clientId ? String(identity.clientId) : 'paired');
    }

    function scopedSessionKey(sessionId, scope) {
      var key = scope || currentScopeKey();
      return key.length + ':' + key + ':' + String(sessionId);
    }

    function toolCatalogMap(scope) {
      var key = scope || currentScopeKey();
      if (!state.sessionCatalogs[key]) state.sessionCatalogs[key] = {};
      return state.sessionCatalogs[key];
    }

    function newCatalogMap(scope) {
      var key = scope || currentScopeKey();
      if (!newState.catalogsByScope[key]) newState.catalogsByScope[key] = {};
      return newState.catalogsByScope[key];
    }

    function projectNamesMap(scope) {
      var key = scope || currentScopeKey();
      if (!newState.projectNamesByScope[key]) newState.projectNamesByScope[key] = {};
      return newState.projectNamesByScope[key];
    }

    function captureRpcContext() {
      return {
        admin: state.admin === true,
        clientId: state.admin && state.selectedComputer
          ? String(state.selectedComputer.clientId || '') : '',
        scope: currentScopeKey(),
        generation: scopeGeneration
      };
    }

    function rpcContextIsCurrent(context) {
      return !!context && context.generation === scopeGeneration && context.scope === currentScopeKey();
    }

    /** One transport boundary. Admin calls always name the captured target. */
    function rpc(body, context) {
      var ctx = context || captureRpcContext();
      var pending;
      if (ctx.admin) {
        if (!ctx.clientId || typeof apiClient.adminRpc !== 'function') {
          return Promise.resolve({ ok: false, code: 'admin_target_required', message: '请先选择一台在线电脑。', status: 400 });
        }
        pending = apiClient.adminRpc(ctx.clientId, body);
      } else {
        pending = apiClient.rpc(body);
      }
      return Promise.resolve(pending).then(function (result) {
        if (!rpcContextIsCurrent(ctx)) {
          return Object.assign({}, result || {}, { stale: true });
        }
        return result;
      });
    }

    function refreshInflightForScope() {
      state.inflight = (pendingByScope[currentScopeKey()] || 0) > 0;
    }

    function invalidateScopeRequests() {
      scopeGeneration += 1;
      detailRequestSeq += 1;
      newPanelSeq += 1;
      createSeq += 1;
      refreshInflightForScope();
    }

    // ---------------------------------------------------------------- shell

    /** Show one protocol screen, keeping the tab bar in step. */
    function show(screen) {
      state.screen = screen;
      if (el.loading) el.loading.hidden = screen !== 'loading';
      if (el.pair) el.pair.hidden = screen !== 'pair';
      if (screen === 'pair' && el.adminLoginPanel && el.adminLoginPanel.hidden && el.pairUserForm) {
        el.pairUserForm.hidden = false;
        if (el.pairAdminLoginToggle) el.pairAdminLoginToggle.hidden = false;
      }
      if (el.list) el.list.hidden = screen !== 'list';
      if (el.detail) el.detail.hidden = screen !== 'detail';
      if (el.newScreen) el.newScreen.hidden = screen !== 'new';
      if (el.settings) el.settings.hidden = screen !== 'settings';
      if (el.adminRoster) el.adminRoster.hidden = screen !== 'admin-roster';
      var chromeVisible = screen === 'list' || screen === 'detail' || screen === 'new' || screen === 'settings';
      if (el.tabbar) el.tabbar.hidden = !chromeVisible;
      if (el.newSessionButton) el.newSessionButton.hidden = !chromeVisible || screen === 'settings' || !state.selectedComputer && state.admin;
      if (el.adminContext) el.adminContext.hidden = !state.admin || !state.selectedComputer;
      if (el.appbarTitle) el.appbarTitle.textContent = state.admin ? 'AI 工作台 · 管理员' : 'AI 工作台';
      if (el.adminContextName) {
        var selected = state.selectedComputer;
        el.adminContextName.textContent = selected
          ? String(selected.ownerName || '未命名人员') + ' · ' + String(selected.clientName || '未命名电脑')
          : '';
        el.adminContextName.setAttribute('title', selected
          ? String(selected.ownerName || '') + ' · ' + String(selected.clientName || '') + ' · ' + String(selected.clientId || '') : '');
      }
      refreshInflightForScope();
      if (!chromeVisible) closeProjectSheet();
      renderTabs();
    }

    function renderTabs() {
      var tab = state.screen === 'settings' ? 'settings' : state.tab;
      [
        { node: el.tabChats, id: 'chats' },
        { node: el.tabTasks, id: 'tasks' },
        { node: el.tabSettings, id: 'settings' }
      ].forEach(function (entry) {
        if (!entry.node) return;
        var active = chromeVisible() && entry.id === tab;
        entry.node.setAttribute('class', 'tab' + (active ? ' tab-active' : ''));
        entry.node.setAttribute('aria-selected', active ? 'true' : 'false');
      });
      if (el.tabTasksBadge) {
        var counts = core.countTasks(state.sessions);
        var total = counts.needsInput + counts.working + counts.error;
        el.tabTasksBadge.hidden = total === 0;
        el.tabTasksBadge.textContent = total === 0 ? '' : String(total);
      }
    }

    function chromeVisible() {
      return state.screen === 'list' || state.screen === 'detail' ||
        state.screen === 'new' || state.screen === 'settings';
    }

    /**
     * Put desktop text on screen as RICH TEXT when the offline Markdown renderer
     * is available, and as plain text when it is not.
     *
     * The fallback matters: a missing or broken vendor bundle must degrade to
     * showing the source, never to injecting it.
     */
    function setRichText(element, text) {
      if (!element) return;
      var markdown = root && root.RCMarkdown;
      var value = text === null || text === undefined ? '' : String(text);
      if (markdown && typeof markdown.renderInto === 'function' && markdown.renderInto(element, value)) {
        return;
      }
      element.textContent = value;
    }

    function setOnline(online, message) {
      state.online = online;
      if (el.connBadge) {
        el.connBadge.textContent = online ? '已连接' : '离线';
      }
      if (!online && message !== undefined) {
        showNotice(message);
      }
    }

    // -------------------------------------------------- in-flight accounting
    //
    // A plain boolean is not enough here: with more than one request out, a
    // LATE answer would clear the flag while another request is still running,
    // and the poller (which refuses to stack) would fire again on top of it.
    // Count them instead, and derive the flag.

    function beginRequest(scope) {
      var key = scope || currentScopeKey();
      pendingByScope[key] = (pendingByScope[key] || 0) + 1;
      refreshInflightForScope();
    }

    function endRequest(scope) {
      var key = scope || currentScopeKey();
      pendingByScope[key] = Math.max(0, (pendingByScope[key] || 0) - 1);
      if (pendingByScope[key] === 0) delete pendingByScope[key];
      refreshInflightForScope();
    }

    /** True when the request never reached the server at all. */
    function isUnreachable(result) {
      return result.code == null && result.status == null;
    }

    // ---------------------------------------------------------------- errors

    /** The connection notice sits above every screen, so it is always visible. */
    function showNotice(message) {
      if (!el.notice) return;
      el.noticeText.textContent = message;
      el.notice.hidden = false;
      if (el.noticeRetry) el.noticeRetry.hidden = false;
    }

    function hideNotice() {
      if (el.notice) el.notice.hidden = true;
    }

    function showPairError(message) {
      if (el.pairError) el.pairError.textContent = message;
    }

    function showDetailError(message) {
      if (!el.detailError) return;
      el.detailError.textContent = message;
      el.detailError.hidden = false;
    }

    function hideDetailError() {
      if (el.detailError) el.detailError.hidden = true;
    }

    /** Turn a failed result into Chinese text and update the online flag. */
    function handleFailure(result, where) {
      // status == null means the request never reached the server at all:
      // no network, or the client's own abort budget expired.
      var unreachable = result.code == null && result.status == null;
      if (unreachable) {
        state.online = false;
        if (el.connBadge) el.connBadge.textContent = '离线';
      }
      var text = core.errorMessage(result.code, result.message);
      var authExpired = core.isAuthFailure(result.code);
      if (authExpired) {
        // Admin and paired-user cookies are independent. Clear the selected
        // admin target on expiry so a later action can never look like it fell
        // back to the paired computer.
        if (state.admin) {
          state.admin = false;
          state.selectedComputer = null;
          state.identity = null;
          state.sessions = [];
          state.capabilities = null;
          state.current = null;
          state.sessionCatalog = null;
          if (el.approvalsList) ui.clear(el.approvalsList);
          if (el.questionsList) ui.clear(el.questionsList);
          if (el.messageList) ui.clear(el.messageList);
          invalidateScopeRequests();
        }
        state.authed = false;
        if (el.connBadge) el.connBadge.textContent = '需要重新登录';
        show('pair');
        showPairError(text);
      }
      if (!authExpired) {
        if (where === 'detail') showDetailError(text);
        else showNotice(text);
      }
      return text;
    }

    function capabilityForCapabilities(capabilities, prefix, tool) {
      capabilities = capabilities || {};
      var toolStatus = capabilities.toolStatus && capabilities.toolStatus[tool];
      if (toolStatus && typeof toolStatus === 'object' && toolStatus.available === false) {
        return false;
      }
      var perTool = prefix + ':' + tool;
      if (own(capabilities, perTool)) {
        return capabilities[perTool] === true;
      }
      return capabilities[prefix] === true;
    }

    function capabilityFor(prefix, tool) {
      return capabilityForCapabilities(state.capabilities, prefix, tool);
    }

    function toolIsReadOnly(tool) {
      return capabilityFor('session.read', tool) && !capabilityFor('session.send', tool);
    }

    function stopCapabilityFor(tool) {
      var capabilities = state.capabilities || {};
      var legacyKey = 'stop:' + tool;
      if (own(capabilities, legacyKey)) {
        return capabilityForCapabilities(capabilities, 'stop', tool);
      }
      return capabilityForCapabilities(capabilities, 'session.stop', tool);
    }

    function availableToolIds() {
      var capabilities = state.capabilities || {};
      var out = [];
      var hasInventory = Array.isArray(capabilities.tools) ||
        !!(capabilities.toolStatus && typeof capabilities.toolStatus === 'object');
      if (Array.isArray(capabilities.tools)) {
        capabilities.tools.forEach(function (tool) {
          if (typeof tool === 'string' && tool !== '' && out.indexOf(tool) === -1) out.push(tool);
        });
      }
      if (capabilities.toolStatus && typeof capabilities.toolStatus === 'object') {
        Object.keys(capabilities.toolStatus).forEach(function (tool) {
          if (out.indexOf(tool) === -1) out.push(tool);
        });
      }
      if (out.length) return out;
      if (hasInventory) return [];
      // Compatibility for older bridge versions that predate explicit tool
      // inventory. Creation is still gated by per-tool capabilities below.
      return ['codex', 'dsh'];
    }

    function toolStatusReason(tool) {
      var statuses = state.capabilities && state.capabilities.toolStatus;
      var status = statuses && statuses[tool];
      return status && typeof status.reason === 'string' ? status.reason : '';
    }

    function makeWorkBuddyOfficialHelp() {
      var box = ui.make(document, 'div', 'workbuddy-official-help');
      box.appendChild(ui.make(document, 'p', '',
        'WorkBuddy 暂未接入此工作台。可在官方手机 App 登录与电脑相同的账号，继续已有聊天。'));
      var link = document.createElement('a');
      link.setAttribute('class', 'workbuddy-official-link');
      link.setAttribute('href', 'https://www.codebuddy.cn/docs/workbuddyapp/features/Multidevice');
      link.setAttribute('rel', 'noopener noreferrer');
      link.textContent = '查看 WorkBuddy 官方手机端多设备接入说明';
      box.appendChild(link);
      return box;
    }

    function own(object, key) {
      return Object.prototype.hasOwnProperty.call(object, key);
    }

    // -------------------------------------------------------------- pairing

    /** Read #pair=…, fill the field, then wipe it out of the address bar. */
    function consumePairFragment() {
      var location = host.location || {};
      var parsed = core.parsePairFragment(location.hash || '');
      if (!parsed.present) return;
      state.code = parsed.raw;
      if (el.pairCode) el.pairCode.value = parsed.raw;
      var rest = core.stripPairFragment(location.hash || '');
      if (host.history && typeof host.history.replaceState === 'function') {
        var base = (location.pathname || '') + (location.search || '');
        host.history.replaceState(null, '', base + rest);
      }
      location.hash = rest;
    }

    async function submitPair() {
      var raw = el.pairCode ? el.pairCode.value : '';
      if (!core.isValidPairCode(raw)) {
        if (el.pairError) {
          el.pairError.textContent =
            '配对码格式不正确：需要 ' + core.PAIR_CODE_LENGTH + ' 位（连字符可省略），字母只用 0-9 与 A-Z（不含 I、L、O、U）。';
        }
        return;
      }
      var name = (el.pairName && el.pairName.value.trim()) || deviceName;
      if (el.pairError) el.pairError.textContent = '';
      if (el.pairSubmit) el.pairSubmit.disabled = true;
      var result = await apiClient.pair(core.normalizePairCode(raw), name);
      if (el.pairSubmit) el.pairSubmit.disabled = false;
      if (!result.ok) {
        var message = core.errorMessage(result.code, result.message);
        if (el.pairError) el.pairError.textContent = message;
        if (result.code === null && result.status === null) setOnline(false, message);
        return;
      }
      state.code = '';
      state.authed = true;
      state.admin = false;
      state.selectedComputer = null;
      state.identity = { role: 'user', clientName: name };
      invalidateScopeRequests();
      hideNotice();
      showPairError('');
      setOnline(true);
      show('list');
      if (typeof apiClient.me === 'function') {
        var identity = await apiClient.me();
        if (identity.ok && identity.result && identity.result.role === 'user') {
          state.identity = Object.assign({}, identity.result);
          invalidateScopeRequests();
        }
      }
      await refreshList();
    }

    function showAdminLogin(returnScreen) {
      state.adminReturnScreen = returnScreen || 'pair';
      if (el.adminLoginPanel) el.adminLoginPanel.hidden = false;
      if (el.pairUserForm) el.pairUserForm.hidden = true;
      if (el.pairAdminLoginToggle) el.pairAdminLoginToggle.hidden = true;
      if (el.adminLoginError) el.adminLoginError.textContent = '';
      if (el.adminPassword) el.adminPassword.value = '';
      show('pair');
    }

    function hideAdminLogin() {
      if (el.adminLoginPanel) el.adminLoginPanel.hidden = true;
      if (el.pairUserForm) el.pairUserForm.hidden = false;
      if (el.pairAdminLoginToggle) el.pairAdminLoginToggle.hidden = false;
      if (el.adminPassword) el.adminPassword.value = '';
      if (el.adminLoginError) el.adminLoginError.textContent = '';
      var target = state.adminReturnScreen;
      if (target === 'settings' && state.authed) show('settings');
      else show('pair');
    }

    async function submitAdminLogin() {
      if (state.adminLoginBusy || typeof apiClient.adminLogin !== 'function') return;
      var username = el.adminUsername ? el.adminUsername.value.trim() : '';
      var password = el.adminPassword ? el.adminPassword.value : '';
      if (!username || !password) {
        if (el.adminLoginError) el.adminLoginError.textContent = '请输入管理员账号和密码。';
        return;
      }
      var previousScope = currentScopeKey();
      state.adminLoginBusy = true;
      if (el.adminLoginSubmit) el.adminLoginSubmit.disabled = true;
      if (el.adminLoginError) el.adminLoginError.textContent = '';
      var pending = apiClient.adminLogin(username, password);
      if (el.adminPassword) el.adminPassword.value = '';
      var result = await pending;
      state.adminLoginBusy = false;
      if (el.adminLoginSubmit) el.adminLoginSubmit.disabled = false;
      if (!result.ok) {
        if (el.adminLoginError) el.adminLoginError.textContent = core.errorMessage(result.code, result.message);
        return;
      }
      state.userWasPairedBeforeAdmin = !!(state.authed && state.identity && state.identity.role === 'user');
      state.admin = true;
      state.identity = { role: 'admin' };
      state.selectedComputer = null;
      state.authed = true;
      state.sessions = [];
      state.capabilities = null;
      state.current = null;
      state.sessionCatalog = null;
      state.adminComputers = [];
      state.adminRosterFilter = 'all';
      state.adminRosterError = '';
      if (el.approvalsList) ui.clear(el.approvalsList);
      if (el.questionsList) ui.clear(el.questionsList);
      if (el.messageList) ui.clear(el.messageList);
      if (previousScope !== currentScopeKey()) invalidateScopeRequests();
      if (el.adminLoginPanel) el.adminLoginPanel.hidden = true;
      if (el.pairAdminLoginToggle) el.pairAdminLoginToggle.hidden = false;
      if (el.adminUsername) el.adminUsername.value = '';
      show('admin-roster');
      await refreshAdminRoster();
    }

    async function refreshAdminRoster() {
      if (!state.admin || typeof apiClient.adminComputers !== 'function') return;
      var scope = currentScopeKey();
      var generation = scopeGeneration;
      state.adminRosterLoading = true;
      state.lastRosterMs = now();
      if (el.connBadge) el.connBadge.textContent = '读取电脑名册…';
      if (el.adminRosterError) {
        el.adminRosterError.hidden = true;
        el.adminRosterError.textContent = '';
      }
      var result = await apiClient.adminComputers();
      if (generation !== scopeGeneration || scope !== currentScopeKey()) return;
      state.adminRosterLoading = false;
      if (!result.ok) {
        if (core.isAuthFailure(result.code)) {
          state.admin = false;
          state.authed = false;
          state.selectedComputer = null;
          state.identity = null;
          invalidateScopeRequests();
          if (el.connBadge) el.connBadge.textContent = '需要重新登录';
          show('pair');
          if (el.adminRosterError) {
            el.adminRosterError.hidden = false;
            el.adminRosterError.textContent = '管理员登录已失效，请重新登录。';
          }
          return;
        }
        state.adminRosterError = core.errorMessage(result.code, result.message);
        if (el.connBadge) el.connBadge.textContent = '电脑名册暂不可用';
        if (el.adminRosterError) {
          el.adminRosterError.hidden = false;
          el.adminRosterError.textContent = state.adminRosterError;
        }
        return;
      }
      var rows = result.result && Array.isArray(result.result.computers) ? result.result.computers : [];
      state.adminComputers = rows.filter(function (computer) {
        return computer && typeof computer.clientId === 'string';
      });
      state.adminRosterError = '';
      if (el.connBadge) el.connBadge.textContent = '电脑名册已更新';
      renderAdminRoster();
    }

    function adminToolList(computer) {
      if (computer && Array.isArray(computer.tools)) return computer.tools;
      var legacy = computer && computer.capabilities && Array.isArray(computer.capabilities.tools)
        ? computer.capabilities.tools : [];
      return legacy.map(function (id) { return { id: id, available: true }; });
    }

    function allAdminToolIds() {
      var seen = {};
      var ids = [];
      state.adminComputers.forEach(function (computer) {
        adminToolList(computer).forEach(function (tool) {
          var id = tool && typeof tool.id === 'string' ? tool.id : '';
          if (id && !seen[id]) {
            seen[id] = true;
            ids.push(id);
          }
        });
      });
      ids.sort();
      return ids;
    }

    function renderAdminRoster() {
      if (!el.adminComputerList) return;
      ui.clear(el.adminComputerList);
      var toolIds = allAdminToolIds();
      if (el.adminToolFilter) {
        ui.clear(el.adminToolFilter);
        el.adminToolFilter.appendChild(ui.button(document, '全部工具',
          'chip' + (state.adminRosterFilter === 'all' ? ' chip-active' : ''), function () {
            state.adminRosterFilter = 'all';
            renderAdminRoster();
          }));
        toolIds.forEach(function (id) {
          el.adminToolFilter.appendChild(ui.button(document, core.toolLabel(id),
            'chip' + (state.adminRosterFilter === id ? ' chip-active' : ''), function () {
              state.adminRosterFilter = id;
              renderAdminRoster();
            }));
        });
      }
      var rows = state.adminComputers.filter(function (computer) {
        return state.adminRosterFilter === 'all' || adminToolList(computer).some(function (tool) {
          return tool && tool.id === state.adminRosterFilter;
        });
      });
      if (el.adminRosterEmpty) el.adminRosterEmpty.hidden = rows.length > 0;
      var owners = {};
      rows.forEach(function (computer) {
        var owner = String(computer.ownerName || '未命名人员');
        if (!owners[owner]) owners[owner] = [];
        owners[owner].push(computer);
      });
      Object.keys(owners).sort().forEach(function (owner) {
        var group = ui.make(document, 'section', 'admin-owner-group');
        var heading = ui.make(document, 'h3', 'admin-owner-title', owner);
        group.appendChild(heading);
        owners[owner].sort(function (a, b) {
          var byName = String(a.clientName || '').localeCompare(String(b.clientName || ''));
          return byName || String(a.clientId).localeCompare(String(b.clientId));
        }).forEach(function (computer) {
          group.appendChild(buildAdminComputerCard(computer));
        });
        el.adminComputerList.appendChild(group);
      });
      if (el.adminRosterError) {
        el.adminRosterError.textContent = state.adminRosterError;
        el.adminRosterError.hidden = !state.adminRosterError;
      }
    }

    function buildAdminComputerCard(computer) {
      var card = ui.make(document, 'article', 'admin-computer-card');
      var head = ui.make(document, 'div', 'admin-computer-head');
      var nameGroup = ui.make(document, 'div', '');
      nameGroup.appendChild(ui.make(document, 'h4', 'admin-computer-name', computer.clientName || '未命名电脑'));
      nameGroup.appendChild(ui.make(document, 'p', 'admin-computer-id', '电脑编号：' + computer.clientId));
      head.appendChild(nameGroup);
      var open = ui.button(document, '打开工作台', 'secondary', function () {
        selectComputer(computer.clientId);
      });
      open.disabled = computer.online !== true;
      open.setAttribute('data-client-id', computer.clientId);
      open.setAttribute('aria-label', '打开 ' + String(computer.ownerName || '未命名人员') + ' 的 ' + String(computer.clientName || '未命名电脑'));
      head.appendChild(open);
      card.appendChild(head);
      var lastSeen = core.formatRelativeTime(computer.lastSeen, now());
      card.appendChild(ui.make(document, 'p', 'admin-computer-status',
        (computer.online === true ? '在线' : '离线') + (lastSeen ? ' · 最近活动 ' + lastSeen : ' · 最近活动时间未知')));
      var tools = ui.make(document, 'div', 'admin-tool-list');
      adminToolList(computer).forEach(function (entry) {
        if (!entry || typeof entry.id !== 'string') return;
        var chip = ui.make(document, 'span', 'admin-tool-chip', core.toolLabel(entry.id));
        chip.setAttribute('data-available', entry.available === true ? 'true' : 'false');
        var readOnly = entry.available === true &&
          capabilityForCapabilities(computer.capabilities, 'session.read', entry.id) &&
          !capabilityForCapabilities(computer.capabilities, 'session.send', entry.id);
        var status = entry.available !== true
          ? (entry.id === 'workbuddy' ? '未接入' : (entry.reason || '不可用'))
          : (readOnly ? '只读' : '可用');
        var stateText = ui.make(document, 'span', 'admin-tool-state', status);
        if (entry.reason) stateText.setAttribute('title', String(entry.reason));
        chip.appendChild(stateText);
        tools.appendChild(chip);
      });
      if (tools.children.length === 0) {
        tools.appendChild(ui.make(document, 'span', 'muted small', '电脑未报告已连接的 AI 工具'));
      }
      card.appendChild(tools);
      var unavailableWorkBuddy = adminToolList(computer).filter(function (entry) {
        return entry && entry.id === 'workbuddy' && entry.available !== true;
      })[0];
      if (unavailableWorkBuddy) {
        card.appendChild(makeWorkBuddyOfficialHelp());
      }
      return card;
    }

    function selectComputer(clientId) {
      var computer = state.adminComputers.filter(function (row) { return row.clientId === clientId; })[0];
      if (!computer || computer.online !== true) return;
      if (state.current && el.sendInput) {
        state.drafts[scopedSessionKey(state.current.id)] = el.sendInput.value;
      }
      state.selectedComputer = computer;
      invalidateScopeRequests();
      state.adminRosterLoading = false;
      state.sessions = [];
      state.capabilities = null;
      state.current = null;
      state.sessionCatalog = null;
      state.query = '';
      state.toolFilter = 'all';
      state.projectFilter = '';
      state.busySend = false;
      state.busyStop = false;
      state.busyAnswer = false;
      state.busyApprove = false;
      newState.catalog = null;
      newState.tool = 'codex';
      newState.selectedKey = '';
      newState.selectedEffort = '';
      newState.projectId = '';
      newState.prefillProjectId = '';
      newState.requestId = '';
      newState.busy = false;
      newState.partial = null;
      if (el.sendInput) el.sendInput.value = '';
      if (el.sendButton) el.sendButton.disabled = false;
      if (el.stopButton) el.stopButton.disabled = false;
      if (el.detailPartialRetry) el.detailPartialRetry.disabled = false;
      if (el.approvalsList) ui.clear(el.approvalsList);
      if (el.questionsList) ui.clear(el.questionsList);
      if (el.approvalsPanel) el.approvalsPanel.hidden = true;
      if (el.questionsPanel) el.questionsPanel.hidden = true;
      if (el.messageList) ui.clear(el.messageList);
      clearFocusMemo();
      resetModelPickerPaint();
      hideDetailError();
      show('list');
      renderList();
      refreshList();
    }

    function returnToAdminRoster() {
      if (!state.admin || !state.selectedComputer) return;
      if (state.current && el.sendInput) {
        state.drafts[scopedSessionKey(state.current.id)] = el.sendInput.value;
      }
      state.selectedComputer = null;
      invalidateScopeRequests();
      state.adminRosterLoading = false;
      state.sessions = [];
      state.capabilities = null;
      state.current = null;
      state.sessionCatalog = null;
      state.busySend = false;
      state.busyStop = false;
      state.busyAnswer = false;
      state.busyApprove = false;
      if (el.sendInput) el.sendInput.value = '';
      if (el.sendButton) el.sendButton.disabled = false;
      if (el.stopButton) el.stopButton.disabled = false;
      if (el.detailPartialRetry) el.detailPartialRetry.disabled = false;
      if (el.approvalsList) ui.clear(el.approvalsList);
      if (el.questionsList) ui.clear(el.questionsList);
      if (el.approvalsPanel) el.approvalsPanel.hidden = true;
      if (el.questionsPanel) el.questionsPanel.hidden = true;
      if (el.messageList) ui.clear(el.messageList);
      clearFocusMemo();
      show('admin-roster');
      refreshAdminRoster();
    }

    async function generateEnrollmentCode() {
      if (!state.admin || typeof apiClient.adminEnrollmentCodes !== 'function') return;
      var context = captureRpcContext();
      if (el.adminEnrollmentButton) el.adminEnrollmentButton.disabled = true;
      if (el.adminEnrollmentResult) {
        el.adminEnrollmentResult.hidden = true;
        el.adminEnrollmentResult.textContent = '';
      }
      var result = await apiClient.adminEnrollmentCodes();
      if (el.adminEnrollmentButton) el.adminEnrollmentButton.disabled = false;
      if (!rpcContextIsCurrent(context) || state.screen !== 'admin-roster') return;
      if (!result.ok) {
        state.adminRosterError = core.errorMessage(result.code, result.message);
        renderAdminRoster();
        return;
      }
      var data = result.result || {};
      if (!data.code || !el.adminEnrollmentResult) return;
      el.adminEnrollmentResult.textContent = '登记码：' + String(data.code) + (data.expiresAt ? ' · 有效至 ' + String(data.expiresAt) : '');
      el.adminEnrollmentResult.hidden = false;
    }

    // ------------------------------------------------- workbench: tabs/filters

    function rememberPrefs(patch) {
      var next = prefs.set(patch);
      renderSettings();
      return next;
    }

    function selectTab(tab) {
      if (!own(core.TAB_LABELS, tab)) return;
      if (tab === 'settings') {
        state.tab = 'settings';
        show('settings');
      } else {
        state.tab = tab;
        show('list');
      }
      rememberPrefs({ tab: state.tab });
      renderList();
    }

    function setToolFilter(tool) {
      state.toolFilter = tool === '' ? 'all' : tool;
      rememberPrefs({ tool: state.toolFilter });
      renderList();
    }

    function setProjectFilter(projectId) {
      state.projectFilter = typeof projectId === 'string' ? projectId : '';
      rememberPrefs({ projectId: state.projectFilter });
      closeProjectSheet();
      renderList();
    }

    function clearFilters() {
      state.query = '';
      if (el.search) el.search.value = '';
      state.toolFilter = 'all';
      state.projectFilter = '';
      rememberPrefs({ tool: 'all', projectId: '' });
      renderList();
    }

    function projectDisplayName(projectId) {
      if (projectId === '') {
        return '全部项目';
      }
      var known = projectNamesMap()[projectId];
      if (known) {
        return known;
      }
      var fromList = core.listProjects(state.sessions).filter(function (project) {
        return project.id === projectId;
      })[0];
      if (fromList) {
        return core.projectLabel(fromList);
      }
      // An unknown id is still SHOWN as itself: pretending the filter is off
      // would hide sessions for a reason the user cannot see.
      return projectId;
    }

    function renderFilters() {
      if (el.toolFilter) {
        ui.clear(el.toolFilter);
        core.toolChips(state.sessions).forEach(function (chipEntry) {
          el.toolFilter.appendChild(ui.chip(
            document, chipEntry.label, state.toolFilter === chipEntry.id,
            function () { setToolFilter(chipEntry.id); }
          ));
        });
      }
      if (el.projectFilterButton) {
        var label = projectDisplayName(state.projectFilter);
        el.projectFilterButton.textContent = state.projectFilter === ''
          ? '全部项目' : '项目：' + label;
        el.projectFilterButton.setAttribute(
          'class', 'chip' + (state.projectFilter === '' ? '' : ' chip-active')
        );
      }
      if (el.filterClearButton) {
        var filtered = state.query !== '' || state.toolFilter !== 'all' || state.projectFilter !== '';
        el.filterClearButton.hidden = !filtered;
      }
    }

    function visibleSessions() {
      var rows = core.tabSessions(state.sessions, state.tab);
      rows = core.filterByTool(rows, state.toolFilter);
      // The project filter is matched through the SAME navigation options the
      // sheet shows. Without them, a filter expressed as one tool's project id
      // would miss the sessions that only report the directory.
      rows = core.filterByProject(rows, state.projectFilter, projectsForSheet());
      rows = core.filterSessions(rows, state.query);
      return core.withPinsFirst(rows, scopedPins());
    }

    function renderList() {
      if (!el.sessionList) return;
      renderFilters();
      var rows = visibleSessions();
      el.sessionList.textContent = '';
      rows.forEach(function (session) {
        el.sessionList.appendChild(buildSessionRow(session));
      });
      var total = state.sessions.length;
      if (el.listEmpty) {
        var empty = rows.length === 0 && total > 0;
        el.listEmpty.hidden = !empty;
        if (empty) {
          el.listEmpty.textContent = state.tab === 'tasks'
            ? '没有运行中或待确认的会话'
            : '没有匹配的会话';
        }
      }
      if (el.taskSummary) {
        var showSummary = state.tab === 'tasks';
        var summary = showSummary ? core.taskSummary(state.sessions) : '';
        el.taskSummary.hidden = !showSummary || summary === '';
        el.taskSummary.textContent = summary === '' ? '' : '任务总览：' + summary;
      }
      if (el.settings) {
        renderSettings();
      }
      renderTabs();
    }

    function isPinned(id) {
      return prefs.get().pins[pinKey(id)] === true;
    }

    function pinKey(id) {
      // A paired phone has one fixed computer, so keep its historic pin ids.
      // Admin pins need the client prefix because two computers may share a
      // session id.
      return state.admin && state.selectedComputer ? scopedSessionKey(id) : String(id);
    }

    function scopedPins() {
      var all = prefs.get().pins || {};
      var out = {};
      (state.sessions || []).forEach(function (session) {
        var key = pinKey(session.id);
        if (all[key] === true) out[String(session.id)] = true;
      });
      return out;
    }

    function clearScopedPins() {
      var all = prefs.get().pins || {};
      var next = {};
      var prefix = state.admin && state.selectedComputer
        ? currentScopeKey().length + ':' + currentScopeKey() + ':' : '';
      Object.keys(all).forEach(function (key) {
        if (prefix && key.indexOf(prefix) !== 0) next[key] = true;
      });
      rememberPrefs({ pins: next });
    }

    function buildSessionRow(session) {
      var item = document.createElement('li');
      item.setAttribute('class', 'session-item session-' + core.statusTone(session.status));
      item.setAttribute('data-id', session.id);

      var head = ui.make(document, 'div', 'session-head');
      var title = ui.make(document, 'div', 'session-title', session.title || '');
      head.appendChild(title);

      // The pin is a per-device convenience only; it never changes the session.
      var pin = ui.button(document, isPinned(session.id) ? '★' : '☆', 'pin-button' + (isPinned(session.id) ? ' pin-on' : ''), function (event) {
        if (event && typeof event.stopPropagation === 'function') event.stopPropagation();
        prefs.togglePin(pinKey(session.id));
        renderList();
      });
      pin.setAttribute('aria-label', isPinned(session.id) ? '取消置顶' : '置顶');
      pin.setAttribute('data-pin-for', String(session.id));
      head.appendChild(pin);
      item.appendChild(head);

      // A session that genuinely waits for the user says so, from the desktop's
      // own needsInput flag -- never from a local guess about its messages.
      if (core.sessionNeedsInput(session)) {
        var badge = ui.span(document, 'needs-input', '待确认');
        head.appendChild(badge);
      }

      var meta = ui.make(document, 'div', 'session-meta');

      var status = ui.span(document, 'status status-' + core.statusTone(session.status), core.statusLabel(session.status));
      meta.appendChild(status);

      // The product name a person recognises, not the lower-case wire id. The
      // id itself never reaches the screen as a label.
      var tool = ui.span(document, 'tool tool-' + (session.tool || 'unknown'), core.toolLabel(session.tool));
      tool.setAttribute('data-tool', session.tool || '');
      meta.appendChild(tool);
      if (toolIsReadOnly(session.tool)) {
        meta.appendChild(ui.span(document, 'read-only-badge', '只读'));
      }

      var project = core.sessionProject(session);
      if (project) {
        var cue = ui.span(document, 'project-cue', core.projectLabel(project));
        cue.setAttribute('title', project.cwd || project.id);
        meta.appendChild(cue);
      }

      var time = ui.span(document, 'time', core.formatRelativeTime(session.updatedAt, now()));
      meta.appendChild(time);

      item.appendChild(meta);
      item.addEventListener('click', function () {
        openSession(session.id);
      });
      return item;
    }

    async function refreshList() {
      state.lastListMs = now();
      var context = captureRpcContext();
      beginRequest(context.scope);
      var result = await rpc(core.listBody(), context);
      endRequest(context.scope);
      if (!result || result.stale) return;

      if (!result.ok) {
        if (core.isAuthFailure(result.code)) {
          // The admin cookie and the paired-device cookie are independent.
          // An expired admin target must return to login, never to user RPC.
          if (state.admin) {
            state.admin = false;
            state.selectedComputer = null;
            state.identity = null;
            state.sessions = [];
            state.capabilities = null;
            state.current = null;
            state.sessionCatalog = null;
            if (el.approvalsList) ui.clear(el.approvalsList);
            if (el.questionsList) ui.clear(el.questionsList);
            if (el.messageList) ui.clear(el.messageList);
            invalidateScopeRequests();
          }
          state.authed = false;
          if (el.connBadge) el.connBadge.textContent = '需要重新登录';
          show('pair');
          showPairError(core.errorMessage(result.code, result.message));
          return;
        }
        // The user is reading a session, or filling in the new-session panel.
        // Either way this refresh is a BACKGROUND one they did not ask for, so
        // it must never navigate them away -- and it must not hijack the notice
        // with "电脑没有及时回应" either. Only a genuinely unreachable server is
        // worth interrupting them for, because that is something they need.
        //
        // This is the SAME rule the success path below follows ("never leave a
        // screen the user opened"), and it has to hold on both paths.
        if (state.screen === 'detail' || state.screen === 'new' || state.screen === 'settings') {
          if (isUnreachable(result)) {
            handleFailure(result, 'list');
          }
          return;
        }
        // Any other failure. Whether we may use the list screen depends on
        // whether this device was EVER accepted by the server -- not on the
        // status code of this one call.
        if (state.authed) {
          // Already signed in: keep the session and the list, show what broke.
          // (This is the protocol-v1 v2 403 `forbidden` case: the identity is
          // fine, the permission is not.)
          show('list');
          handleFailure(result, 'list');
          return;
        }
        // Never signed in (fresh device, or the server answered with something
        // we do not recognise -- a proxy's 501, for instance). The pairing form
        // must stay reachable, so show it and report the problem above it.
        show('pair');
        handleFailure(result, 'list');
        return;
      }

      // A successful call is the only thing that may reveal the list screen.
      state.authed = true;
      hideNotice();
      if (el.listEmpty) el.listEmpty.hidden = true;
      setOnline(true);
      state.sessions = (result.result && result.result.sessions) || [];
      state.capabilities = (result.result && result.result.capabilities) || null;
      // Never yank the user out of the session, the new-session panel or the
      // settings view.
      if (state.screen !== 'detail' && state.screen !== 'new' && state.screen !== 'settings') {
        // 设置 is a view of the list screen, so a device that was left on 设置
        // comes back to 设置 instead of being pushed to 会话 by a poll.
        show(state.tab === 'settings' ? 'settings' : 'list');
      }
      renderList();
    }

    // -------------------------------------------------------------- settings

    var THEME_LABELS = { auto: '跟随系统', light: '浅色', dark: '深色' };

    function setTheme(theme) {
      var applied = prefsModule.applyTheme(document, theme);
      rememberPrefs({ theme: applied });
      renderSettings();
    }

    function renderSettings() {
      var current = prefs.get();
      if (el.themeChoices) {
        ui.clear(el.themeChoices);
        ['auto', 'light', 'dark'].forEach(function (theme) {
          el.themeChoices.appendChild(ui.chip(
            document, THEME_LABELS[theme], current.theme === theme,
            function () { setTheme(theme); }
          ));
        });
      }
      if (el.prefsSummary) {
        var toolLabel = state.toolFilter === 'all' ? '全部工具' : core.toolLabel(state.toolFilter);
        el.prefsSummary.textContent =
          '当前视图：' + core.tabLabel(state.tab) +
          ' · 工具：' + toolLabel +
          ' · 项目：' + projectDisplayName(state.projectFilter);
      }
      if (el.pinsSummary) {
        var count = prefsModule.pinnedCount(state.admin ? scopedPins() : current);
        el.pinsSummary.textContent = count === 0
          ? '还没有置顶的会话。在会话卡片上点 ☆ 就能置顶。'
          : '已置顶 ' + count + ' 个会话，它们排在列表最前面（只影响这台手机）。';
      }
      if (el.settingsVersion) {
        el.settingsVersion.textContent = APP_VERSION_TEXT;
      }
      if (el.accountSummary) {
        if (state.admin && state.selectedComputer) {
          el.accountSummary.textContent = '管理员正在管理：' + String(state.selectedComputer.ownerName || '未命名人员') + ' · ' + String(state.selectedComputer.clientName || '未命名电脑');
        } else if (state.admin) {
          el.accountSummary.textContent = '已使用管理员账号登录。';
        } else if (state.identity && (state.identity.ownerName || state.identity.clientName)) {
          el.accountSummary.textContent = '配对设备：' + String(state.identity.ownerName || '当前用户') + ' · ' + String(state.identity.clientName || '电脑');
        } else {
          el.accountSummary.textContent = state.authed ? '已配对到生成此配对码的电脑。' : '尚未配对电脑。';
        }
      }
      if (el.settingsAdminLogin) el.settingsAdminLogin.hidden = state.admin;
    }

    // ------------------------------------------------------- project sheet

    /** The tool the sheet is being shown for: the open session's, else the default. */
    function sheetTool() {
      return state.current ? state.current.tool : defaultTool();
    }

    /**
     * Every project catalog this device has actually fetched, tagged with the
     * tool it belongs to.
     *
     * The sheet used to read only the LAST catalog, which is why the same
     * directory could appear twice: once from the catalog of the tool being
     * looked at and once from a recent session's own report, spelled with the
     * other separator. Reading every fetched catalog is also what makes the
     * tool cue honest -- a directory is only tagged with a tool that really
     * reported it.
     */
    function catalogProjectsWithTools() {
      var out = [];
      // The tool the sheet is being shown for comes FIRST, so the id it wins by
      // is the id belonging to the tool the user is actually looking at. Two
      // tools can name the same directory differently, and the filter value has
      // to be one the open session list can match.
      var preferred = sheetTool();
      var catalogs = toolCatalogMap();
      var tools = Object.keys(catalogs);
      tools.sort(function (a, b) {
        if (a === preferred) return -1;
        if (b === preferred) return 1;
        return a < b ? -1 : (a > b ? 1 : 0);
      });
      tools.forEach(function (tool) {
        var entry = catalogs[tool];
        if (!entry || !entry.catalog) {
          return;
        }
        core.projectOptions(entry.catalog).forEach(function (project) {
          out.push({
            id: project.id,
            name: project.name,
            cwd: project.cwd,
            key: project.key,
            tool: tool
          });
        });
      });
      return out;
    }

    /** One navigation option per real directory, with real tool cues. */
    function projectsForSheet() {
      var sessionProjects = core.listProjects(state.sessions).map(function (project) {
        return { id: project.id, name: project.name, cwd: project.cwd, tool: '' };
      });
      // A session's own tool is a real cue for its directory.
      var bySessionPath = {};
      (state.sessions || []).forEach(function (session) {
        var project = core.sessionProject(session);
        if (!project) return;
        var path = core.canonicalPath(project.cwd);
        if (path === '') return;
        if (!bySessionPath[path]) bySessionPath[path] = session.tool;
      });
      sessionProjects.forEach(function (project) {
        project.tool = bySessionPath[core.canonicalPath(project.cwd)] || '';
      });
      return core.mergeProjectOptions(catalogProjectsWithTools(), sessionProjects);
    }

    function renderProjectSheet() {
      if (!el.projectSheetList) return;
      // The tool the sheet is shown for also becomes the composer's active
      // catalog, so the model picker reuses the answer we already have instead
      // of asking the desktop again.
      if (!state.sessionCatalog && toolCatalogMap()[sheetTool()]) {
        state.sessionCatalog = toolCatalogMap()[sheetTool()];
      }
      var query = el.projectSearch ? String(el.projectSearch.value || '').trim().toLowerCase() : '';
      var projects = projectsForSheet().filter(function (project) {
        if (query === '') return true;
        var toolSearch = core.projectToolIds(project, sheetTool())
          .map(function (tool) { return core.toolLabel(tool); }).join(' ');
        return (core.projectLabel(project) + ' ' + project.id + ' ' + project.cwd + ' ' + toolSearch)
          .toLowerCase().indexOf(query) !== -1;
      });
      ui.clear(el.projectSheetList);

      var allRow = document.createElement('li');
      allRow.setAttribute('class', 'sheet-row' + (state.projectFilter === '' ? ' sheet-row-active' : ''));
      var allButton = ui.button(document, '', 'sheet-row-button', function () {
        setProjectFilter('');
      });
      allButton.appendChild(ui.make(document, 'span', 'sheet-row-name', '全部项目'));
      allButton.setAttribute('data-project-id', '');
      allRow.appendChild(allButton);
      el.projectSheetList.appendChild(allRow);

      projects.forEach(function (project) {
        el.projectSheetList.appendChild(projectSheetRow(project));
      });
      if (el.projectSheetEmpty) {
        el.projectSheetEmpty.hidden = projects.length > 0;
      }
    }

    function projectSheetRow(project) {
      var preferred = sheetTool();
      var active = core.projectOptionMatches(project, state.projectFilter);
      var item = document.createElement('li');
      item.setAttribute('class', 'sheet-row' + (active ? ' sheet-row-active' : ''));
      var main = ui.button(document, '', 'sheet-row-button', function () {
        setProjectFilter(project.id);
      });
      main.appendChild(ui.make(document, 'span', 'sheet-row-name', core.projectLabel(project) || project.id));
      if (project.cwd && project.cwd !== core.projectLabel(project)) {
        main.appendChild(ui.make(document, 'span', 'sheet-row-path', project.cwd));
      }
      // Tool cues. A directory both tools really report is ONE row, and the row
      // says which tools map to it instead of listing the directory twice.
      var tools = core.projectToolIds(project, preferred);
      if (tools.length > 0) {
        var cues = ui.make(document, 'span', 'sheet-row-tools');
        tools.forEach(function (tool) {
          var cue = ui.span(document, 'tool-cue', core.toolLabel(tool));
          cue.setAttribute('data-tool', tool);
          cues.appendChild(cue);
        });
        main.appendChild(cues);
      }
      main.setAttribute('data-project-id', project.id);
      main.setAttribute('data-project-key', project.key);
      item.appendChild(main);
      return item;
    }

    async function openProjectSheet() {
      var context = captureRpcContext();
      openSheetUi();
      renderProjectSheet();
      // The catalog is the desktop's own project list; the session list alone
      // only knows projects that already have chats.
      if (!state.capabilities) {
        return;
      }
      await ensureSessionCatalog(sheetTool(), context);
      if (!rpcContextIsCurrent(context)) return;
      await loadSheetCatalogs(context);
      if (!rpcContextIsCurrent(context)) return;
      renderProjectSheet();
    }

    /**
     * Fetch the other tools' catalogs too.
     *
     * Showing "which tools map to this directory" honestly needs every tool's
     * own list, so the ones that were never fetched are requested now. Nothing
     * is invented in the meantime: a tool that has not answered has no cue.
     */
    async function loadSheetCatalogs(context) {
      if (!state.capabilities) {
        return;
      }
      var capabilities = state.capabilities || {};
      var tools = availableToolIds();
      var preferred = sheetTool();
      if (tools.indexOf(preferred) === -1) {
        tools = tools.concat([preferred]);
      }
      var wanted = [];
      tools.forEach(function (tool) {
        if (toolCatalogMap(context && context.scope)[tool]) {
          return;
        }
        if (!capabilityFor('models.list', tool)) {
          return;
        }
        wanted.push(loadSessionCatalog(tool, context));
      });
      await Promise.all(wanted);
    }

    function openSheetUi() {
      if (el.sheetBackdrop) el.sheetBackdrop.hidden = false;
      ui.openSheet(el.projectSheet);
    }

    function closeProjectSheet() {
      if (el.sheetBackdrop) el.sheetBackdrop.hidden = true;
      ui.closeSheet(el.projectSheet);
    }

    function defaultTool() {
      var capabilities = state.capabilities || {};
      var tools = availableToolIds();
      for (var i = 0; i < tools.length; i++) {
        if (capabilityFor('models.list', tools[i])) return tools[i];
      }
      return tools[0] || 'codex';
    }

    // ---------------------------------------------------------------- detail

    function captureScrollTop() {
      return el.messageList ? el.messageList.scrollTop : 0;
    }

    function restoreScrollTop(value) {
      if (el.messageList) el.messageList.scrollTop = value;
    }

    // ---------------------------------------------- focus and caret survival
    //
    // A 2-second poll repaints the pending panels and the model picker. The
    // rebuild must NOT cost the user their caret or their focus inside a field
    // they are still typing in. Anything a rebuild would move is snapshotted
    // before the repaint and restored after it:
    //
    //   - the focused control, identified by a MEANINGFUL key (a draft key or a
    //     data attribute), never by DOM position -- position is exactly what a
    //     repaint changes;
    //   - the selection on that control, including direction.
    //
    // Nothing is restored that the user did not leave there: restoreFocus()
    // only ever reinstates an element it just built, and only when the element
    // still had focus when the repaint started. The poll never moves focus on
    // its own, so a user who navigated away stays where they went.

    function focusableOf(node) {
      return !!(node && typeof node.focus === 'function');
    }

    /** A stable name for whatever the user is focused on. '' when unknown. */
    function focusKeyOf(node) {
      if (!node || typeof node.getAttribute !== 'function') {
        return '';
      }
      var custom = node.getAttribute('data-custom-for');
      if (custom) {
        return 'custom:' + custom;
      }
      var option = node.getAttribute('data-option-label');
      if (option) {
        return 'option:' + node.getAttribute('data-question-id') + '\u0000' + option;
      }
      var id = node.getAttribute('id');
      if (id) {
        return 'id:' + id;
      }
      var modelKey = node.getAttribute('data-model-key');
      if (modelKey !== null) {
        return 'model:' + modelKey;
      }
      return '';
    }

    /** Where the caret/selection is, as far as the host exposes it. */
    function selectionOf(node) {
      if (!node) {
        return null;
      }
      var start = node.selectionStart;
      var end = node.selectionEnd;
      if (typeof start !== 'number' || typeof end !== 'number') {
        return null;
      }
      return {
        start: start,
        end: end,
        direction: typeof node.selectionDirection === 'string' ? node.selectionDirection : 'none'
      };
    }

    function applySelection(node, selection) {
      if (!node || !selection || typeof node.setSelectionRange !== 'function') {
        return;
      }
      try {
        node.setSelectionRange(selection.start, selection.end, selection.direction);
      } catch (err) {
        // A host that refuses a range (an input type that does not support
        // selection) simply keeps its own caret.
      }
    }

    /** Snapshot + restore pair handed to each keyed reconciler. */
    function createFocusMemo() {
      var active = null;
      var activeKey = '';
      var selection = null;
      var scrollTop = 0;

      return {
        reset: function () {
          active = null;
          activeKey = '';
          selection = null;
          scrollTop = 0;
        },
        capture: function (scope) {
          active = null;
          activeKey = '';
          selection = null;
          scrollTop = scope ? scope.scrollTop : 0;
          var node = document.activeElement || null;
          if (!focusableOf(node)) {
            return;
          }
          if (scope && typeof ui.isInside === 'function' && !ui.isInside(scope, node)) {
            // The user is focused somewhere this reconciler does not own. It is
            // neither touched nor claimed.
            return;
          }
          active = node;
          activeKey = focusKeyOf(node);
          selection = selectionOf(node);
        },
        /** Re-apply focus and the caret to the node that was rebuilt. */
        restore: function (scope) {
          if (!active || activeKey === '') {
            return;
          }
          var next = findByFocusKey(scope, activeKey);
          if (!next) {
            return;
          }
          if (typeof next.focus === 'function') {
            next.focus();
          }
          applySelection(next, selection);
          if (scope && typeof scrollTop === 'number') {
            scope.scrollTop = scrollTop;
          }
        }
      };
    }

    /** The rebuilt element that carries the same meaningful key. */
    function findByFocusKey(scope, key) {
      if (!scope || !key) {
        return null;
      }
      var kind = key.slice(0, key.indexOf(':'));
      var rest = key.slice(key.indexOf(':') + 1);
      if (kind === 'custom') {
        return pickByAttr(scope, 'data-custom-for', rest);
      }
      if (kind === 'option') {
        var split = rest.split('\u0000');
        var found = pickByAttr(scope, 'data-option-label', split[1]);
        return found;
      }
      if (kind === 'id') {
        return scope.querySelector ? scope.querySelector('#' + rest) : null;
      }
      if (kind === 'model') {
        var rows = scope.querySelectorAll ? scope.querySelectorAll('.picker-row') : [];
        for (var i = 0; i < rows.length; i++) {
          if (rows[i].getAttribute('data-model-key') === rest) {
            return rows[i];
          }
        }
      }
      return null;
    }

    function pickByAttr(scope, attr, value) {
      var nodes = scope.querySelectorAll ? scope.querySelectorAll('[' + attr + ']') : [];
      for (var i = 0; i < nodes.length; i++) {
        if (nodes[i].getAttribute(attr) === value) {
          return nodes[i];
        }
      }
      return null;
    }

    /** The first button among a node's own children. Null when there is none. */
    function firstButton(scope) {
      if (!scope) {
        return null;
      }
      var children = scope.children || [];
      for (var i = 0; i < children.length; i++) {
        if (children[i].tagName === 'BUTTON') {
          return children[i];
        }
      }
      return null;
    }

    // One shared memo for the detail screen's keyed panels. There is only ever
    // one focused element, so one snapshot serves all of them.
    var focusMemo = createFocusMemo();

    /** Forget any pending focus/selection snapshot (leaving a session). */
    function clearFocusMemo() {
      focusMemo.reset();
    }

    /**
     * Reconcile a keyed list against the DOM, reusing nodes.
     *
     * A node is left EXACTLY as it is -- same element, same listeners, same
     * focus -- while its `signature` is unchanged. When the signature changes the
     * node is genuinely rebuilt, because a different native form is a different
     * set of controls, not the same controls with new text. Nodes whose key is
     * gone are removed. `update` only ever writes text and flags -- it never
     * replaces a control -- so it runs for every surviving node, reused or
     * freshly built, and there is exactly one place that decides what a card
     * says.
     *
     * Returns what it did, so the tests can tell "reused" from "rebuilt" instead
     * of guessing from the markup.
     */
    function reconcileByKey(container, entries, build, update) {
      var stats = { built: 0, reused: 0, replaced: 0, removed: 0, created: [] };
      if (!container) {
        return stats;
      }
      var existing = {};
      Array.prototype.slice.call(container.children).forEach(function (node) {
        var key = node.getAttribute ? node.getAttribute('data-reconcile-key') : null;
        if (key !== null && key !== undefined) {
          existing[key] = node;
        }
      });

      var kept = {};
      entries.forEach(function (entry, index) {
        var key = String(entry.key);
        kept[key] = true;
        var node = own(existing, key) ? existing[key] : null;
        var reusable = !!node && node.__rcSignature === entry.signature;
        if (reusable) {
          stats.reused += 1;
        } else {
          var replacement = build(entry);
          replacement.setAttribute('data-reconcile-key', key);
          replacement.__rcSignature = entry.signature;
          stats.created.push(replacement);
          if (node) {
            container.insertBefore(replacement, node);
            container.removeChild(node);
            stats.replaced += 1;
          } else {
            stats.built += 1;
          }
          node = replacement;
        }
        // `update` only writes text and flags; it never replaces a control. So
        // running it for a freshly built node is the same as running it for a
        // reused one, and there is exactly one place that decides what a card
        // says.
        if (update) {
          update(node, entry);
        }
        var current = container.children[index];
        if (current !== node) {
          container.insertBefore(node, current || null);
        }
      });

      Array.prototype.slice.call(container.children).forEach(function (node) {
        var key = node.getAttribute ? node.getAttribute('data-reconcile-key') : null;
        if (key !== null && key !== undefined && !own(kept, key)) {
          container.removeChild(node);
          stats.removed += 1;
        }
      });
      return stats;
    }

    function renderDetail() {
      var current = state.current;
      if (!current) return;
      var canSend = capabilityFor('session.send', current.tool);
      if (el.composer) el.composer.hidden = !canSend;
      if (el.workBuddyReadonlyNote) {
        var workBuddyReadOnly = current.tool === 'workbuddy' && toolIsReadOnly(current.tool);
        el.workBuddyReadonlyNote.hidden = canSend;
        if (el.workBuddyReadonlyText) {
          el.workBuddyReadonlyText.textContent = workBuddyReadOnly
            ? '可查看本机会话；续聊和授权操作暂未接入。'
            : '此工具暂不支持从手机续聊。';
        }
        if (el.workBuddyReadonlyLink) el.workBuddyReadonlyLink.hidden = !workBuddyReadOnly;
      }
      if (el.detailTitle) el.detailTitle.textContent = current.title || '';
      if (el.detailStatus) {
        el.detailStatus.textContent = core.statusLabel(current.status);
        el.detailStatus.setAttribute('class', 'status status-' + core.statusTone(current.status));
      }
      if (el.detailTool) {
        var toolText = core.toolLabel(current.tool);
        var project = current.project;
        if (project) {
          toolText += ' · ' + core.projectLabel(project);
        }
        el.detailTool.textContent = toolText;
      }

      // "not the whole history" note (CRD 0007). Purely informational: it lives
      // outside the message list, so toggling it cannot move the reading
      // position, and it disables nothing.
      var truncatedNote = core.historyTruncatedNotice(current.raw);
      if (el.detailTruncated) {
        el.detailTruncated.textContent = truncatedNote;
        el.detailTruncated.hidden = truncatedNote === '';
      }

      var list = el.messageList;
      if (list) {
        // Incremental reconcile, NOT a rebuild. Rebuilding every 2 seconds
        // would close the user's expanded activity blocks, throw away their
        // text selection and break scroll anchoring.
        reconcileMessages(list, core.groupMessages(current.messages));
      }
      renderPendingPanels(current);
      renderModelPicker();
      renderStopControls(current);
      renderPartialNotice();
    }

    /** A normal conversation turn. Never folded, rendered as Markdown. */
    function buildMessage(message) {
      var item = document.createElement('li');
      item.setAttribute('class', 'msg msg-' + (message.role || 'system'));

      var role = ui.make(document, 'div', 'msg-role', core.roleLabel(message.role));
      item.appendChild(role);

      var text = ui.make(document, 'div', 'msg-text');
      setRichText(text, message.text);
      item.appendChild(text);

      var time = ui.make(document, 'div', 'msg-time', core.formatClock(message.timestamp));
      item.appendChild(time);

      return item;
    }

    /**
     * One run of tool/system messages, folded into a <details> that is CLOSED by
     * default -- the shape Codex and DSH use for activity.
     */
    function buildActivityBlock(block) {
      var key = activityKey(block);
      var item = document.createElement('li');
      item.setAttribute('class', 'activity-item');

      var details = document.createElement('details');
      details.setAttribute('class', 'activity');
      details.setAttribute('data-activity-key', key);
      details.open = state.expandedActivity[key] === true;
      details.addEventListener('toggle', function () {
        state.expandedActivity[key] = details.open === true;
      });

      var summary = document.createElement('summary');
      summary.setAttribute('class', 'activity-summary');
      details.appendChild(summary);

      var body = ui.make(document, 'div', 'activity-body');
      details.appendChild(body);
      item.appendChild(details);
      return item;
    }

    /** Fill (or refill) the parts of an activity node that depend on content. */
    function fillActivityBlock(node, block) {
      // Standard DOM only: querySelector / textContent / createElement.
      // (An earlier revision used a helper that existed only in the test
      // harness, so every activity block threw in a real browser.)
      var summary = node.querySelector('summary');
      if (summary) {
        summary.textContent = core.activitySummary(block.items);
      }
      var body = node.querySelector('.activity-body');
      if (!body) return;
      body.textContent = '';
      block.items.forEach(function (message) {
        var row = ui.make(document, 'div', 'activity-row');

        row.appendChild(ui.span(document, 'activity-role', core.roleLabel(message.role)));

        var text = ui.make(document, 'div', 'activity-text');
        // Tool and system output is NOT Markdown: it is machine text, so it is
        // shown verbatim in a code block. Rendering it as Markdown would let a
        // tool's own output style itself, and would mangle paths and diffs.
        text.textContent = message.text === null || message.text === undefined ? '' : String(message.text);
        row.appendChild(text);

        body.appendChild(row);
      });
    }

    function activityKey(block) {
      var first = block.items && block.items[0];
      var localKey;
      if (first && first.id !== undefined && first.id !== null) {
        localKey = 'm:' + String(first.id);
      } else {
        localKey = 'n:' + String(block.count);
      }
      var current = state.current;
      return scopedSessionKey(current ? current.id : 'none') + ':act:' + localKey;
    }

    /** Stable identity for a block across polls (message ids are stable). */
    function blockKey(block, index) {
      if (block.type === 'activity') {
        return 'act:' + activityKey(block);
      }
      var message = block.message;
      if (message && message.id !== undefined && message.id !== null) {
        return 'msg:' + String(message.id);
      }
      return 'idx:' + String(index);
    }

    /**
     * Everything the rendered node depends on. When this is unchanged the node
     * is left completely alone -- that is what preserves `open`, the scroll
     * position and any text the user has selected.
     */
    function blockSignature(block) {
      if (block.type === 'activity') {
        return 'act|' + block.items.map(function (message) {
          return [message.id, message.role, message.text].join('\u0000');
        }).join('\u0001');
      }
      var message = block.message;
      return ['msg', message.id, message.role, message.text, message.timestamp].join('\u0000');
    }

    /**
     * Reconcile `blocks` into `container`, reusing the existing nodes.
     *
     * New blocks are appended, vanished ones removed, and a node whose
     * signature did not change is not touched at all.
     */
    function reconcileMessages(container, blocks) {
      var existing = {};
      Array.prototype.slice.call(container.children).forEach(function (node) {
        var key = node.getAttribute('data-block-key');
        if (key) existing[key] = node;
      });

      var kept = {};
      blocks.forEach(function (block, index) {
        var key = blockKey(block, index);
        var signature = blockSignature(block);
        kept[key] = true;

        var node = existing[key];
        if (node) {
          if (node.__rcSignature !== signature) {
            if (block.type === 'activity') {
              fillActivityBlock(node, block);
            } else {
              var text = node.querySelector('.msg-text');
              setRichText(text, block.message.text);
            }
            node.__rcSignature = signature;
          }
        } else {
          node = block.type === 'activity' ? buildActivityBlock(block) : buildMessage(block.message);
          node.setAttribute('data-block-key', key);
          node.__rcSignature = signature;
          if (block.type === 'activity') {
            fillActivityBlock(node, block);
          }
        }

        var current = container.children[index];
        if (current !== node) {
          container.insertBefore(node, current || null);
        }
      });

      Array.prototype.slice.call(container.children).forEach(function (node) {
        var key = node.getAttribute('data-block-key');
        if (key && !kept[key]) {
          container.removeChild(node);
        }
      });
    }

    /**
     * Fold the CURRENT DOM state back into `state.expandedActivity`, so a
     * rebuild elsewhere does not lose the user's choices.
     */
    function captureExpandedState() {
      if (!el.messageList) return;
      var found = el.messageList.querySelectorAll
        ? el.messageList.querySelectorAll('details')
        : [];
      Array.prototype.forEach.call(found, function (details) {
        var key = details.getAttribute('data-activity-key');
        if (key) {
          state.expandedActivity[key] = details.open === true;
        }
      });
    }

    /**
     * Stop button policy.
     *
     * protocol-v1 9.5: a button the computer cannot support must stay VISIBLE
     * but disabled, with a reason -- hiding it would pretend the feature does
     * not exist. When the computer does support stopping and the session simply
     * is not working right now, there is nothing to stop, so the task row's
     * "show/hide by canStop" wins and the button is hidden.
     */
    function stopButtonMode(current) {
      var supported = stopCapabilityFor(current.tool);
      if (!supported) return 'disabled';
      return core.canStopOf(current) ? 'enabled' : 'hidden';
    }

    function renderStopControls(current) {
      var mode = stopButtonMode(current);
      if (el.stopButton) {
        el.stopButton.hidden = mode === 'hidden';
        el.stopButton.disabled = mode !== 'enabled';
      }
      if (el.stopReason) {
        el.stopReason.hidden = mode !== 'disabled';
        el.stopReason.textContent = mode === 'disabled' ? STOP_UNSUPPORTED_TEXT : '';
      }
    }

    // ------------------------------------------- pending questions/approvals

    function answerDraftKey(sessionId, callId) {
      return scopedSessionKey(sessionId) + '\u0000' + String(callId);
    }

    function answerDraft(sessionId, callId) {
      var key = answerDraftKey(sessionId, callId);
      if (!own(state.answerDrafts, key)) {
        state.answerDrafts[key] = { selected: {}, custom: {} };
      }
      return state.answerDrafts[key];
    }

    function approvalReceiptKey(sessionId, approvalId) {
      return scopedSessionKey(sessionId) + '\u0000' + String(approvalId);
    }

    function renderPendingPanels(current) {
      renderPendingApprovals(current);
      renderPendingQuestions(current);
    }

    /**
     * Everything an approval card depends on.
     *
     * Two identical polls produce the SAME signature, so the card is left
     * exactly as it is -- which is what keeps a half-pressed decision, the
     * focus ring and the selection on it. A signature only changes when the
     * desktop genuinely changed the request (reason, tool, call id) or the
     * receipt moved from "nothing" to "submitted"/"failed".
     */
    function approvalSignature(current, approval) {
      var receipt = state.approvalReceipts[approvalReceiptKey(current.id, approval.id)] || null;
      return [
        current.id, approval.id, approval.toolName, approval.callId, approval.reason,
        receipt ? (receipt.state + '\u0000' + (receipt.message || '')) : 'none'
      ].join('\u0001');
    }

    function renderPendingApprovals(current) {
      if (!el.approvalsPanel) return;
      var approvals = core.pendingApprovalsOf({
        capabilities: state.capabilities,
        tool: current.tool,
        read: current.raw
      });
      if (approvals.length === 0) {
        el.approvalsPanel.hidden = true;
        // Remove the controls rather than leaving another session's request
        // hidden but still live in the DOM.
        ui.clear(el.approvalsList);
        return;
      }
      el.approvalsPanel.hidden = false;
      var entries = approvals.map(function (approval) {
        return {
          key: approval.id,
          signature: approvalSignature(current, approval),
          approval: approval
        };
      });
      focusMemo.capture(el.approvalsList);
      reconcileByKey(
        el.approvalsList,
        entries,
        function (entry) { return buildApprovalCard(current, entry.approval); },
        function (node, entry) { fillApprovalCard(node, current, entry.approval); }
      );
      focusMemo.restore(el.approvalsList);
    }

    function buildApprovalCard(current, approval) {
      var item = document.createElement('li');
      item.setAttribute('class', 'pending-card');
      item.setAttribute('data-approval-id', approval.id);

      var head = ui.make(document, 'div', 'pending-head');
      head.appendChild(ui.make(document, 'span', 'pending-tool', ''));
      head.appendChild(ui.span(document, 'pending-call', ''));
      item.appendChild(head);

      var reason = ui.make(document, 'p', 'pending-reason', '');
      item.appendChild(reason);
      item.appendChild(ui.make(
        document, 'p', 'pending-hint',
        '这是电脑端发出的真实权限请求。只对这一次请求生效，不会改变电脑的权限设置。'
      ));

      var actions = ui.make(document, 'div', 'pending-actions');
      var allow = ui.button(document, '仅允许本次', 'primary', function () {
        submitApproval(current, approval, 'allow-once');
      });
      var reject = ui.button(document, '拒绝', 'danger', function () {
        submitApproval(current, approval, 'reject');
      });
      allow.setAttribute('data-approval-decision', 'allow-once');
      reject.setAttribute('data-approval-decision', 'reject');
      actions.appendChild(allow);
      actions.appendChild(reject);
      item.appendChild(actions);

      item.appendChild(ui.make(document, 'p', 'pending-note', ''));
      return item;
    }

    /**
     * Bring a card's text and button state in step with the live data.
     *
     * Only text and the disabled flag are touched: the buttons themselves are
     * never replaced, so a decision the user is in the middle of making is not
     * thrown away by a poll.
     */
    function fillApprovalCard(item, current, approval) {
      var head = item.querySelector('.pending-head');
      if (head) {
        var tool = head.querySelector('.pending-tool');
        if (tool) tool.textContent = approval.toolName || '未命名工具';
        var call = head.querySelector('.pending-call');
        if (call) {
          call.textContent = approval.callId ? '调用 ' + approval.callId : '';
          call.hidden = !approval.callId;
        }
      }
      var reason = item.querySelector('.pending-reason');
      if (reason) {
        reason.textContent = approval.reason || '';
        reason.hidden = !approval.reason;
      }
      var receipt = state.approvalReceipts[approvalReceiptKey(current.id, approval.id)] || null;
      var submitted = !!(receipt && receipt.state === 'submitted');
      var actions = item.querySelector('.pending-actions');
      Array.prototype.forEach.call(actions ? actions.children : [], function (button) {
        button.disabled = submitted;
      });
      var note = item.querySelector('.pending-note');
      if (note) {
        note.textContent = receipt
          ? (receipt.state === 'submitted' ? APPROVAL_SENT_TEXT : (receipt.message || ''))
          : '';
        note.hidden = note.textContent === '';
      }
    }

    /**
     * The native form signature for one question batch.
     *
     * Questions, headers, details, option labels, descriptions, order and
     * multi-select are all in it. Anything a user can READ is in it, so a
     * genuinely different form always rebuilds; two polls over the same native
     * batch produce the same string and the DOM is left alone.
     */
    function questionSignature(batch) {
      return batch.questions.map(function (question) {
        return [
          question.id,
          question.multiSelect ? 'm' : 's',
          question.header || '',
          question.question,
          question.detail || '',
          question.options.map(function (option) {
            return option.label + '\u0002' + (option.description || '');
          }).join('\u0003')
        ].join('\u0002');
      }).join('\u0001');
    }

    /** One entry per batch the reconciler owns, keyed by the native callId. */
    function questionEntries(current, batches) {
      return batches.map(function (batch) {
        var receipt = state.answerReceipts[answerDraftKey(current.id, batch.callId)] || null;
        return {
          key: batch.callId,
          // The receipt is folded into the signature because it changes the
          // submit button's disabled flag and the note under it.
          signature: questionSignature(batch) + '\u0004' +
            (receipt ? (receipt.state + '\u0000' + (receipt.message || '')) : 'none'),
          batch: batch
        };
      });
    }

    function renderPendingQuestions(current) {
      if (!el.questionsPanel) return;
      var tool = current.tool;
      var input = { capabilities: state.capabilities, tool: tool, read: current.raw };
      var questionState = core.pendingQuestionsState(input);
      var raw = current.raw && Array.isArray(current.raw.pendingQuestions) ? current.raw.pendingQuestions : [];

      if (questionState === 'none') {
        // Nothing is pending -- and that is a fact about the DESKTOP, not about
        // this tool's capabilities. A session that is asking nothing must not be
        // dressed up as "the AI is waiting for you" just because Codex has no
        // native answer tool, so the whole panel goes away here.
        el.questionsPanel.hidden = true;
        if (el.questionsUnsupported) {
          el.questionsUnsupported.hidden = true;
          el.questionsUnsupported.textContent = '';
        }
        clearFocusMemo();
        ui.clear(el.questionsList);
        return;
      }
      // There IS a native question, but this tool has no answer capability:
      // show the truth and send the user to the computer instead of a button
      // that cannot work.
      if (questionState === 'unsupported') {
        el.questionsPanel.hidden = false;
        if (el.questionsUnsupported) {
          el.questionsUnsupported.hidden = false;
          el.questionsUnsupported.textContent = QUESTION_UNSUPPORTED_TEXT;
        }
        clearFocusMemo();
        ui.clear(el.questionsList);
        raw.forEach(function (entry) {
          var batch = entry && typeof entry === 'object' ? entry : {};
          var questions = Array.isArray(batch.questions) ? batch.questions : [];
          if (questions.length === 0) return;
          var item = document.createElement('li');
          item.setAttribute('class', 'pending-card');
          var head = ui.make(document, 'div', 'pending-head');
          head.appendChild(ui.span(document, 'pending-tool', questionBatchLabel(questions)));
          item.appendChild(head);
          questions.forEach(function (question) {
            item.appendChild(ui.make(document, 'p', 'pending-reason',
              core.clampText(question && question.question, core.Q_LIMITS.question)));
          });
          el.questionsList.appendChild(item);
        });
        return;
      }
      if (el.questionsUnsupported) {
        el.questionsUnsupported.hidden = true;
        el.questionsUnsupported.textContent = '';
      }
      if (questionState === 'oversized') {
        // Refuse the form rather than show a partial one: submitting a form the
        // user could not fully read would be worse than saying so.
        el.questionsPanel.hidden = false;
        clearFocusMemo();
        ui.clear(el.questionsList);
        var notice = document.createElement('li');
        notice.setAttribute('class', 'pending-card');
        notice.appendChild(ui.make(document, 'p', 'pending-reason', core.QUESTIONS_OVERSIZED_TEXT));
        el.questionsList.appendChild(notice);
        return;
      }

      el.questionsPanel.hidden = false;
      var entries = questionEntries(current, core.pendingQuestionsOf(input));
      focusMemo.capture(el.questionsList);
      reconcileByKey(
        el.questionsList,
        entries,
        function (entry) { return buildQuestionBatch(current, entry.batch); },
        function (node, entry) { fillQuestionBatch(node, current, entry.batch); }
      );
      focusMemo.restore(el.questionsList);
    }

    /**
     * Question label helpers.
     *
     * The card header is read by a human, so a native callId -- an internal
     * correlation id -- is not a title. The desktop's own `question.header` is
     * used when it gave one (it names the thing being asked about, e.g.
     * "构建失败"); otherwise the card just says what it is. The opaque callId
     * still travels on the element as `data-call-id`, which is what the answer
     * submit uses.
     */
    var QUESTION_PENDING_LABEL = '待回答的问题';

    function questionBatchLabel(questions) {
      var list = Array.isArray(questions) ? questions : [];
      for (var i = 0; i < list.length; i++) {
        var header = list[i] && typeof list[i].header === 'string' ? list[i].header : '';
        if (header !== '') {
          return core.clampText(header, core.Q_LIMITS.header);
        }
      }
      return QUESTION_PENDING_LABEL;
    }

    function buildQuestionBatch(current, batch) {
      var draft = answerDraft(current.id, batch.callId);
      // The form really changed, so a choice that is no longer offered must not
      // survive as a hidden selection the user can neither see nor clear.
      // Pruning against the LIVE form is what makes "the desktop changed the
      // question" land honestly instead of silently carrying a stale answer.
      reconcileDraftWithForm(draft, batch);
      var item = document.createElement('li');
      item.setAttribute('class', 'pending-card');
      item.setAttribute('data-call-id', batch.callId);

      var head = ui.make(document, 'div', 'pending-head');
      head.appendChild(ui.span(document, 'pending-tool', questionBatchLabel(batch.questions)));
      head.appendChild(ui.span(document, 'pending-call', ''));
      item.appendChild(head);

      batch.questions.forEach(function (question) {
        item.appendChild(buildQuestionRow(question, draft));
      });

      var actions = ui.make(document, 'div', 'pending-actions');
      var send = ui.button(document, '提交回答', 'primary', function () {
        submitAnswer(current, batch);
      });
      send.setAttribute('data-answer-call', batch.callId);
      actions.appendChild(send);
      item.appendChild(actions);

      item.appendChild(ui.make(document, 'p', 'pending-note', ''));
      return item;
    }

    /**
     * Bring one batch card in step with the live native form.
     *
     * The CONTROLS ARE NOT REBUILT HERE. This function is called on every poll,
     * including polls whose native form is byte-identical, and it deliberately
     * touches nothing that holds user state: the option buttons keep the
     * `aria-pressed` the user's own taps produced (the draft is applied once, at
     * build time), and the custom field keeps its value, its focus and its
     * caret. Only text that mirrors the desktop -- the header, the questions,
     * the receipt -- is written, and it is written identically each time.
     */
    function fillQuestionBatch(item, current, batch) {
      var head = item.querySelector('.pending-head');
      if (head) {
        var label = head.querySelector('.pending-tool');
        if (label) label.textContent = questionBatchLabel(batch.questions);
        var stateCue = head.querySelector('.pending-call');
        if (stateCue) {
          stateCue.textContent = batch.state === 'continued' ? '已继续' : '';
          stateCue.hidden = batch.state !== 'continued';
        }
      }
      var receipt = state.answerReceipts[answerDraftKey(current.id, batch.callId)] || null;
      var submitted = !!(receipt && receipt.state === 'submitted');
      // Deliberately a single simple selector: `.pending-actions button` is a
      // descendant combinator, which a minimal DOM may not resolve. Query the
      // container, then its own children.
      var send = firstButton(item.querySelector('.pending-actions'));
      if (send) {
        send.disabled = submitted;
      }
      var note = item.querySelector('.pending-note');
      if (note) {
        note.textContent = receipt
          ? (receipt.state === 'submitted' ? ANSWER_SENT_TEXT : (receipt.message || ''))
          : '';
        note.hidden = note.textContent === '';
      }
    }

    function buildQuestionRow(question, draft) {
      var wrap = ui.make(document, 'div', 'question');
      wrap.setAttribute('data-question-id', question.id);
      wrap.appendChild(ui.make(document, 'p', 'question-header', ''));
      wrap.appendChild(ui.make(document, 'p', 'question-text', ''));
      wrap.appendChild(ui.make(document, 'p', 'question-detail', ''));

      var options = ui.make(document, 'div', 'question-options');
      question.options.forEach(function (option) {
        var choice = ui.button(document, '', 'option', function () {
          // The tap updates the CONTROL ITSELF and then re-renders from the
          // draft. It deliberately does not rely on the card being rebuilt: a
          // card whose native form did not change is not rebuilt, and a poll
          // must not be able to un-press a choice the user just made.
          toggleOption(draft, question, option.label);
          paintQuestionRow(wrap, question, draft);
          renderDetail();
        });
        choice.setAttribute('data-option-label', option.label);
        choice.setAttribute('aria-pressed', 'false');
        choice.appendChild(ui.make(document, 'span', 'option-label', ''));
        choice.appendChild(ui.make(document, 'span', 'option-desc', ''));
        options.appendChild(choice);
      });
      wrap.appendChild(options);

      var custom = draft.custom[question.id];
      var input = document.createElement('input');
      input.setAttribute('class', 'field question-custom');
      input.setAttribute('type', 'text');
      input.setAttribute('autocomplete', 'off');
      input.setAttribute('maxlength', '1000');
      input.setAttribute('placeholder', question.multiSelect ? '补充说明（可选）' : '或自己输入答案');
      input.setAttribute('data-custom-for', question.id);
      if (typeof custom === 'string' && custom !== '') {
        input.value = custom;
      }
      input.addEventListener('input', function () {
        // Kept OUTSIDE the DOM so the 2-second poll cannot lose a half-typed
        // answer. No re-render here: that would move the caret.
        draft.custom[question.id] = input.value;
      });
      input.addEventListener('change', function () {
        draft.custom[question.id] = input.value;
      });
      wrap.appendChild(input);
      fillQuestionRow(wrap, question, draft);
      return wrap;
    }

    /**
     * Mirror the draft onto the option controls of one question row.
     *
     * Class and aria only: nothing here replaces a node, so the option the user
     * just pressed keeps its identity, its listeners and -- if it was the
     * focused element -- its focus.
     */
    function paintQuestionRow(wrap, question, draft) {
      var chosen = draft.selected[question.id];
      var selected = Array.isArray(chosen) ? chosen : [];
      Array.prototype.forEach.call(wrap.querySelectorAll('.option'), function (choice) {
        var label = choice.getAttribute('data-option-label');
        var active = label !== null && selected.indexOf(label) !== -1;
        choice.setAttribute('class', 'option' + (active ? ' option-active' : ''));
        choice.setAttribute('aria-pressed', active ? 'true' : 'false');
      });
    }

    /**
     * Write the desktop's own text into one question row.
     *
     * Only text and pressed STATE are written -- never a replacement node. The
     * pressed state comes from the draft, which is the same map the tap handler
     * writes to, so a poll and a tap can never disagree; and because nothing is
     * replaced, the custom field keeps its value and its caret and a poll cannot
     * take a half-typed answer away or move the cursor.
     */
    function fillQuestionRow(wrap, question, draft) {
      var header = wrap.querySelector('.question-header');
      if (header) {
        header.textContent = question.header || '';
        header.hidden = !question.header;
      }
      var text = wrap.querySelector('.question-text');
      if (text) text.textContent = question.question || '';
      var detail = wrap.querySelector('.question-detail');
      if (detail) {
        detail.textContent = question.detail || '';
        detail.hidden = !question.detail;
      }
      Array.prototype.forEach.call(wrap.querySelectorAll('.option'), function (choice, index) {
        var option = question.options[index];
        if (!option) return;
        var label = choice.querySelector('.option-label');
        if (label) label.textContent = option.label;
        var desc = choice.querySelector('.option-desc');
        if (desc) {
          desc.textContent = option.description || '';
          desc.hidden = !option.description;
        }
      });
      paintQuestionRow(wrap, question, draft);
      var input = wrap.querySelector('.question-custom');
      if (input) {
        var placeholder = question.multiSelect ? '补充说明（可选）' : '或自己输入答案';
        if (input.getAttribute('placeholder') !== placeholder) {
          input.setAttribute('placeholder', placeholder);
        }
        // The LIVE value wins over the draft: it is what the user can see, and
        // a host that never fired `input` (autofill, an IME commit) must not
        // have its text quietly reverted.
        if (typeof input.value === 'string') {
          draft.custom[question.id] = input.value;
        } else if (typeof draft.custom[question.id] === 'string' && input.value !== draft.custom[question.id]) {
          input.value = draft.custom[question.id];
        }
      }
    }

    /**
     * Drop selection entries the current native form no longer offers.
     *
     * A batch whose `callId` survived but whose options changed is a genuinely
     * different form: keeping a label that is gone would leave a "pressed"
     * option that is not on screen, and `validateAnswers` would refuse the whole
     * batch with no way for the user to see why.
     */
    function reconcileDraftWithForm(draft, batch) {
      batch.questions.forEach(function (question) {
        var labels = question.options.map(function (option) { return option.label; });
        var chosen = draft.selected[question.id];
        if (labels.length === 0) {
          // A free-form question has no options to keep.
          draft.selected[question.id] = [];
          return;
        }
        if (!Array.isArray(chosen)) {
          return;
        }
        var kept = chosen.filter(function (label) {
          return labels.indexOf(label) !== -1;
        });
        draft.selected[question.id] = question.multiSelect ? kept : kept.slice(0, 1);
      });
    }

    function toggleOption(draft, question, label) {
      var current = draft.selected[question.id];
      var selected = Array.isArray(current) ? current.slice() : [];
      var index = selected.indexOf(label);
      if (question.multiSelect) {
        if (index === -1) selected.push(label);
        else selected.splice(index, 1);
      } else {
        selected = index === -1 ? [label] : [];
      }
      draft.selected[question.id] = selected;
    }

    /**
     * The answer for the form that is ON SCREEN right now.
     *
     * The draft map is the source of truth for anything the user typed or
     * clicked, because a poll re-creates these controls and a text field that
     * never fired `input` (autofill, an IME commit) would otherwise be lost.
     * So each control is read back from the live DOM and only then merged with
     * the draft -- never the other way round.
     */
    function answerPayload(current, batch) {
      var draft = answerDraft(current.id, batch.callId);
      var live = el.questionsList
        ? el.questionsList.querySelectorAll('.question') : [];
      return batch.questions.map(function (question) {
        var selected = draft.selected[question.id];
        var list = Array.isArray(selected) ? selected.slice() : [];
        var custom = typeof draft.custom[question.id] === 'string' ? draft.custom[question.id] : '';
        for (var i = 0; i < live.length; i++) {
          if (live[i].getAttribute('data-question-id') !== question.id) {
            continue;
          }
          var options = live[i].querySelectorAll('.option');
          var ticked = [];
          for (var o = 0; o < options.length; o++) {
            if (options[o].getAttribute('aria-pressed') === 'true') {
              var label = options[o].getAttribute('data-option-label');
              if (label !== null) {
                ticked.push(label);
              }
            }
          }
          list = ticked;
          var field = live[i].querySelector('.question-custom');
          if (field) {
            custom = field.value;
            draft.custom[question.id] = custom;
          }
          break;
        }
        var answer = { id: question.id, selected: list };
        if (typeof custom === 'string' && custom !== '') {
          answer.custom = custom;
        }
        return answer;
      });
    }

    /** Submit exactly one answer batch, once, for the batch on screen. */
    async function submitAnswer(current, batch) {
      if (state.busyAnswer || !current || !capabilityFor('session.answer', current.tool)) return;
      var sessionId = current.id;
      var key = answerDraftKey(sessionId, batch.callId);
      var receipt = state.answerReceipts[key];
      if (receipt && receipt.state === 'submitted') {
        return; // already submitted once; only a fresh read may clear this
      }
      // Re-validate against the form the user is looking at, so an option that
      // is no longer offered can never be submitted.
      var answers = core.validateAnswers([batch], batch.callId, answerPayload(current, batch));
      if (!answers) {
        state.answerReceipts[key] = { state: 'error', message: '请为每个问题选择答案（单选只能选一个）。' };
        renderDetail();
        return;
      }
      var live = state.current;
      if (!live || live.id !== sessionId || live.scopeKey !== currentScopeKey()) {
        state.answerReceipts[key] = { state: 'error', message: '会话已经切换，请重新打开后再回答。' };
        return;
      }
      var context = captureRpcContext();
      state.busyAnswer = true;
      hideDetailError();
      var result = await rpc(core.sessionAnswerBody({
        tool: live.tool, sessionId: sessionId, callId: batch.callId, answers: answers
      }), context);
      if (!result || result.stale) return;
      state.busyAnswer = false;

      var accepted = !!(result.ok && result.result && result.result.accepted === true);
      state.answerReceipts[key] = accepted
        ? { state: 'submitted', message: '' }
        : { state: 'error', message: core.errorMessage(result.code, result.message) };
      if (!accepted && isUnreachable(result)) {
        handleFailure(result, 'detail');
      }
      renderDetail();
      // Re-read the desktop's own state: "submitted" is NOT "answered". Only
      // the next genuine read may settle or cancel this batch.
      if (accepted) await refreshDetail();
    }

    /** Submit exactly one explicit decision for one exact live approval. */
    async function submitApproval(current, approval, decision) {
      if (state.busyApprove || !current || !capabilityFor('session.approve', current.tool)) return;
      var sessionId = current.id;
      var key = approvalReceiptKey(sessionId, approval.id);
      var receipt = state.approvalReceipts[key];
      if (receipt && receipt.state === 'submitted') {
        return; // exactly once per request; native first answer wins
      }
      var live = state.current;
      if (!live || live.id !== sessionId || live.scopeKey !== currentScopeKey()) {
        state.approvalReceipts[key] = { state: 'error', message: '会话已经切换，请重新打开后再操作。' };
        renderDetail();
        return;
      }
      if (!core.approvalDecisionLabel(decision)) {
        return;
      }
      var context = captureRpcContext();
      state.busyApprove = true;
      hideDetailError();
      var result = await rpc(core.sessionApproveBody({
        tool: live.tool, sessionId: sessionId, approvalId: approval.id, decision: decision
      }), context);
      if (!result || result.stale) return;
      state.busyApprove = false;

      var accepted = !!(result.ok && result.result && result.result.accepted === true);
      if (accepted) {
        // 'submitted' means the transport took it, NOT that this phone won the
        // race: another client may have answered first. The card keeps its
        // receipt and disappears only when the desktop stops reporting it.
        state.approvalReceipts[key] = { state: 'submitted', message: '' };
      } else {
        state.approvalReceipts[key] = { state: 'error', message: core.errorMessage(result.code, result.message) };
        if (isUnreachable(result)) handleFailure(result, 'detail');
      }
      renderDetail();
      if (accepted) await refreshDetail();
    }

    // ------------------------------------------------------ model picker

    function selectedModelOption() {
      var sessionCatalog = state.sessionCatalog;
      if (!sessionCatalog) return null;
      return core.modelOptionByKey(core.modelOptions(sessionCatalog.catalog), sessionCatalog.key);
    }

    /**
     * Fetch one tool's catalog and RESOLVE once it has landed.
     *
     * There is one request PER TOOL, keyed by the in-flight promise: two callers
     * that want the same tool share one answer, while two different tools can be
     * in flight at the same time. (A single "which tool is loading" string used
     * to discard the first of two concurrent loads, which is how the project
     * sheet ended up knowing only one tool's projects.)
     *
     * Repainting is left to the caller: the composer's model picker belongs to
     * the session on screen, and the project sheet belongs to the list.
     */
    async function loadSessionCatalog(tool, requestContext) {
      if (!tool || !capabilityFor('models.list', tool)) {
        return;
      }
      var context = requestContext || captureRpcContext();
      var catalogs = toolCatalogMap(context.scope);
      if (catalogs[tool] && catalogs[tool].catalog) {
        return;
      }
      var requestKey = context.scope + '\u0000' + tool;
      var inflight = catalogRequests[requestKey];
      if (!inflight) {
        inflight = rpc(core.modelsListBody(tool), context).then(function (result) {
          delete catalogRequests[requestKey];
          if (!result || result.stale) return;
          storeCatalog(tool, result, context.scope);
        });
        catalogRequests[requestKey] = inflight;
      }
      await inflight;
    }

    /** Record one models.list answer under its tool. Never invents a catalog. */
    function storeCatalog(tool, result, scope) {
      var catalogs = toolCatalogMap(scope);
      if (!result || !result.ok) {
        catalogs[tool] = {
          tool: tool, catalog: null, key: '', effort: '',
          error: core.errorMessage(result ? result.code : null, result ? result.message : '')
        };
        return;
      }
      var loaded = { tool: tool, catalog: result.result || null, key: '', effort: '', error: '' };
      catalogs[tool] = loaded;
      rememberProjectNames(loaded.catalog, scope);
    }

    var catalogRequests = {};

    /**
     * Everything the model controls depend on.
     *
     * Two identical polls compute the same signature, so the picker, the chip
     * and the effort select are left exactly as they are. That is what stops the
     * controls -- and the user's focus inside them -- from churning every two
     * seconds. A chosen model, the native current model or a new catalog all
     * change it, and then the controls are rebuilt for real.
     */
    function modelPickerSignature(picker, current) {
      var options = picker ? core.modelOptions(picker.catalog) : [];
      return [
        picker ? (picker.tool || '') : '',
        picker ? (picker.key || '') : '',
        picker ? (picker.effort || '') : '',
        picker ? (picker.error || '') : '',
        picker ? (picker.catalog ? 'live' : 'none') : 'loading',
        current ? core.currentModelLabel(current) : '',
        options.map(function (option) {
          return [
            option.key,
            option.text || core.modelOptionLabel(option),
            core.modelOptionDescription(option)
          ].join('\u0002');
        }).join('\u0001')
      ].join('\u0000');
    }

    function renderModelPicker() {
      var picker = state.sessionCatalog;
      var options = picker ? core.modelOptions(picker.catalog) : [];
      var current = state.current ? state.current.currentModel : null;

      // The picker's own contents are the expensive part; when nothing they
      // depend on moved, they are not repainted at all.
      var signature = modelPickerSignature(picker, current);
      if (el.modelPicker && el.modelPicker.__rcSignature === signature) {
        return;
      }
      if (el.modelPicker) {
        el.modelPicker.__rcSignature = signature;
      }
      focusMemo.capture(el.modelPicker);

      if (el.modelChipButton) {
        var chosen = selectedModelOption();
        var label = chosen
          ? (chosen.text || core.modelOptionLabel(chosen))
          : core.inheritModelLabel(current);
        el.modelChipButton.textContent = label;
        el.modelChipButton.setAttribute('class', 'chip chip-quiet model-chip' + (chosen ? ' chip-active' : ''));
      }
      if (el.modelResetButton) {
        el.modelResetButton.hidden = !selectedModelOption();
      }
      if (el.modelPickerList) {
        ui.clear(el.modelPickerList);
        if (!picker) {
          el.modelPickerList.appendChild(ui.make(document, 'p', 'muted small', '正在读取可用模型…'));
        } else if (picker.error) {
          el.modelPickerList.appendChild(ui.make(document, 'p', 'muted small', picker.error));
        } else if (options.length === 0) {
          el.modelPickerList.appendChild(ui.make(document, 'p', 'muted small',
            '这台电脑没有报告可用模型，只能沿用当前模型。'));
        } else {
          el.modelPickerList.appendChild(modelPickerRow(null, core.inheritModelLabel(current)));
          options.forEach(function (option) {
            el.modelPickerList.appendChild(modelPickerRow(option, option.text || core.modelOptionLabel(option)));
          });
        }
      }
      if (el.modelPickerEffort && el.modelPickerEffortSelect) {
        var chosenOption = selectedModelOption();
        if (!chosenOption) {
          // Nothing chosen: the next message keeps the session's current model
          // and whatever reasoning effort that model already uses. Showing the
          // desktop's own value is information, NOT a selection -- no effort is
          // ever attached to an inherit send.
          if (picker) picker.effort = '';
          var inherited = current && current.reasoningEffort ? [current.reasoningEffort] : [];
          if (inherited.length === 0) {
            el.modelPickerEffort.hidden = true;
            el.modelPickerEffortSelect.textContent = '';
          } else {
            el.modelPickerEffort.hidden = false;
            el.modelPickerEffortSelect.textContent = '';
            var currentOption = document.createElement('option');
            currentOption.setAttribute('value', inherited[0]);
            currentOption.textContent = effortLabel(inherited[0]) + '（当前）';
            el.modelPickerEffortSelect.appendChild(currentOption);
            el.modelPickerEffortSelect.value = inherited[0];
          }
        } else {
          var efforts = chosenOption.reasoningEfforts;
          if (efforts.length === 0) {
            el.modelPickerEffort.hidden = true;
            el.modelPickerEffortSelect.textContent = '';
            if (picker) picker.effort = '';
          } else {
            el.modelPickerEffort.hidden = false;
            el.modelPickerEffortSelect.textContent = '';
            efforts.forEach(function (effort) {
              var node = document.createElement('option');
              node.setAttribute('value', effort);
              node.textContent = effortLabel(effort);
              el.modelPickerEffortSelect.appendChild(node);
            });
            var want = (picker && picker.effort && efforts.indexOf(picker.effort) !== -1)
              ? picker.effort
              : (chosenOption.defaultReasoningEffort || efforts[0]);
            if (picker) picker.effort = want;
            el.modelPickerEffortSelect.value = want;
          }
        }
      }
      if (el.modelPickerNote) {
        // The chosen value is a PREFERENCE for the next message; the desktop's
        // own report is what "现在" means. Never conflate the two.
        var note = current
          ? '电脑现在报告这个会话使用：' + core.currentModelLabel(current)
          : '电脑没有报告这个会话当前使用的模型。';
        el.modelPickerNote.textContent = note;
        el.modelPickerNote.hidden = false;
      }
      focusMemo.restore(el.modelPicker);
    }

    function modelPickerRow(option, label) {
      var key = option ? option.key : '';
      var active = option
        ? (state.sessionCatalog && state.sessionCatalog.key === option.key)
        : !(state.sessionCatalog && state.sessionCatalog.key);
      var row = ui.button(document, '', 'picker-row' + (active ? ' picker-row-active' : ''), function () {
        if (!state.sessionCatalog) return;
        state.sessionCatalog.key = key;
        state.sessionCatalog.effort = '';
        renderModelPicker();
      });
      row.setAttribute('data-model-key', key);
      // The id is the name the user is choosing; the native description is help
      // text, carried on the row as a tooltip and never in front of the id.
      var description = option ? core.modelOptionDescription(option) : '';
      if (description !== '') {
        row.setAttribute('title', description);
      }
      row.appendChild(ui.make(document, 'span', 'picker-row-label', label));
      if (description !== '') {
        // Secondary help. The id above stays the primary text even on a narrow
        // phone, where this line is the part that may get cut off.
        var help = ui.make(document, 'span', 'picker-row-desc', description);
        help.setAttribute('title', description);
        row.appendChild(help);
      }
      if (option && option.provider) {
        row.appendChild(ui.make(document, 'span', 'picker-row-provider', option.provider));
      }
      return row;
    }

    function effortLabel(effort) {
      var labels = { low: '低', medium: '中', high: '高', minimal: '最少' };
      return own(labels, effort) ? labels[effort] : effort;
    }

    function toggleModelPicker() {
      if (!el.modelPicker) return;
      el.modelPicker.hidden = !el.modelPicker.hidden;
      if (!el.modelPicker.hidden) {
        renderModelPicker();
        if (state.current) ensureSessionCatalog(state.current.tool);
      }
    }

    /** Let the next paint happen even if the computed signature is unchanged. */
    function resetModelPickerPaint() {
      if (el.modelPicker) {
        el.modelPicker.__rcSignature = null;
      }
    }

    // ------------------------------------------------------- session open

    async function openSession(id, fallback) {
      var session = null;
      (state.sessions || []).forEach(function (candidate) {
        if (candidate.id === id) session = candidate;
      });
      if (!session) {
        // A session created a moment ago may not be in the list yet; the create
        // result itself tells us the tool, which is all session.read needs.
        if (!fallback || !fallback.tool) return;
        session = { id: id, tool: fallback.tool, title: fallback.title || '', status: 'idle' };
      }
      // The draft belongs to the session it was typed in: save the one on
      // screen before pointing the composer at another session, then restore
      // whatever was typed in the one being opened. Without the save, text
      // typed for A would be sent to B.
      if (state.current && el.sendInput) {
        state.drafts[scopedSessionKey(state.current.id, state.current.scopeKey)] = el.sendInput.value;
      }
      // The partial-success note belongs to the session it was raised for.
      newState.partial = null;
      // A different session is a different model selection, and a different set
      // of pending controls. Nothing about the previous session may be reused --
      // including a focus snapshot taken inside its answer form.
      state.sessionCatalog = null;
      state.sessionCatalogs[currentScopeKey()] = {};
      clearFocusMemo();
      resetModelPickerPaint();
      if (el.modelPicker) el.modelPicker.hidden = true;
      state.current = {
        id: session.id,
        tool: session.tool,
        scopeKey: currentScopeKey(),
        title: session.title,
        status: session.status,
        messages: [],
        canStop: false,
        project: core.sessionProject(session),
        currentModel: null,
        raw: null
      };
      if (el.sendInput) {
        var stored = state.drafts[scopedSessionKey(session.id)];
        el.sendInput.value = typeof stored === 'string' ? stored : '';
      }      hideDetailError();
      show('detail');
      renderDetail();
      await refreshDetail();
    }

    async function refreshDetail() {
      var current = state.current;
      if (!current) return;

      // Stamp this request. Anything that comes back after the user has moved
      // on (another session, or back to the list) must be thrown away: writing
      // it would both show the wrong conversation and point the composer at the
      // wrong session, so the next message would be sent somewhere the user is
      // not looking.
      detailRequestSeq += 1;
      var requestSeq = detailRequestSeq;
      var targetId = current.id;
      var targetTool = current.tool;
      var context = captureRpcContext();
      var targetScope = current.scopeKey || context.scope;

      state.lastReadMs = now();
      beginRequest(context.scope);
      var result = await rpc(core.readBody(targetTool, targetId), context);
      endRequest(context.scope);

      if (!result || result.stale || targetScope !== context.scope || isStaleDetailResponse(requestSeq, targetId)) {
        return;
      }

      if (!result.ok) {
        if (core.isAuthFailure(result.code)) {
          handleFailure(result, 'detail');
          return;
        }
        handleFailure(result, 'detail');
        return;
      }
      // The session works again: a stale error from an earlier outage must not
      // stay on screen next to a 已连接 badge. This clears the ERROR only --
      // the partial-creation notice is a different element and is untouched.
      hideDetailError();
      var payload = result.result || {};
      clearStalePendingReceipts(payload, targetId, targetScope);
      // Remember where the user was reading before the DOM is rebuilt.
      var scrollTop = captureScrollTop();
      // A draft belongs to the session it was typed in; the composer holds the
      // text for whichever session is on screen. The draft map is authoritative
      // here: it is what openSession() and the input listener keep up to date.
      var draftKey = scopedSessionKey(targetId, targetScope);
      if (el.sendInput && state.drafts[draftKey] === undefined) {
        state.drafts[draftKey] = el.sendInput.value;
      }
      state.current = {
        id: payload.id || targetId,
        tool: payload.tool || targetTool,
        scopeKey: targetScope,
        title: payload.title || current.title,
        status: payload.status || current.status,
        messages: payload.messages || [],
        canStop: core.canStopOf(payload),
        project: core.sessionProject(payload) || current.project,
        // NATIVE current model, from the desktop only. Never from the picker.
        currentModel: core.currentModelOf(payload),
        // Kept so optional flags (historyTruncated, pendingQuestions, ...) can
        // be read without inventing a field on the normalised view.
        raw: payload
      };
      if (el.sendInput && state.drafts[draftKey] !== undefined && el.sendInput.value === '') {
        el.sendInput.value = state.drafts[draftKey];
      }
      renderDetail();
      restoreScrollTop(scrollTop);
      // The next-message model picker is only useful with a live catalog. It is
      // fetched for the session that is actually on screen -- once -- and a late
      // answer for a session the user has left is dropped by the sequence check.
      ensureSessionCatalog(state.current.tool);
    }

    function clearStalePendingReceipts(readResult, sessionId, scope) {
      var sessionPrefix = scopedSessionKey(sessionId, scope) + '\u0000';
      var activeQuestions = {};
      var activeApprovals = {};
      var batches = readResult && Array.isArray(readResult.pendingQuestions) ? readResult.pendingQuestions : [];
      batches.forEach(function (batch) {
        if (batch && typeof batch.callId === 'string') activeQuestions[batch.callId] = true;
      });
      var approvals = readResult && Array.isArray(readResult.pendingApprovals) ? readResult.pendingApprovals : [];
      approvals.forEach(function (approval) {
        if (approval && typeof approval.id === 'string') activeApprovals[approval.id] = true;
      });
      [state.answerDrafts, state.answerReceipts].forEach(function (map) {
        Object.keys(map).forEach(function (key) {
          if (key.indexOf(sessionPrefix) !== 0) return;
          var callId = key.slice(sessionPrefix.length);
          if (!activeQuestions[callId]) delete map[key];
        });
      });
      Object.keys(state.approvalReceipts).forEach(function (key) {
        if (key.indexOf(sessionPrefix) !== 0) return;
        var approvalId = key.slice(sessionPrefix.length);
        if (!activeApprovals[approvalId]) delete state.approvalReceipts[key];
      });
    }

    /** Fetch the picker's catalog once per tool, never stacking duplicates. */
    function ensureSessionCatalog(tool, requestContext) {
      if (!tool || !capabilityFor('models.list', tool)) {
        return;
      }
      var context = requestContext || captureRpcContext();
      var known = toolCatalogMap(context.scope)[tool] || state.sessionCatalog;
      if (known && known.tool === tool && known.catalog) {
        // Already fetched for this tool: reuse it (and make it the active one)
        // instead of re-asking the desktop on every open.
        state.sessionCatalog = known;
        renderModelPicker();
        return;
      }
      loadSessionCatalog(tool, context).then(function () {
        if (!rpcContextIsCurrent(context) || !state.current || state.current.scopeKey !== context.scope || state.current.tool !== tool) {
          return; // the user moved on: a late catalog is not this session's
        }
        if (toolCatalogMap(context.scope)[tool]) {
          state.sessionCatalog = toolCatalogMap(context.scope)[tool];
          renderModelPicker();
        } else {
          ensureSessionCatalog(tool, context);
        }
      });
    }

    /**
     * Has this detail response been overtaken by the user's own navigation?
     *
     * True when a newer detail request has started, when the app has left the
     * detail screen, or when the session on screen is no longer the one this
     * request was for.
     */
    function isStaleDetailResponse(requestSeq, targetId) {
      if (requestSeq !== detailRequestSeq) {
        return true;
      }
      if (state.screen !== 'detail') {
        return true;
      }
      var live = state.current;
      return !live || live.id !== targetId;
    }

    // ------------------------------------------------------- send and stop

    async function sendMessage(text) {
      if (state.busySend) return; // duplicate-submit guard: one in flight only
      var current = state.current;
      if (!current || !capabilityFor('session.send', current.tool)) return;
      var value = text === undefined ? (el.sendInput ? el.sendInput.value : '') : text;
      if (typeof value !== 'string' || value.trim() === '') return;

      state.busySend = true;
      if (el.sendButton) el.sendButton.disabled = true;
      hideDetailError();

      // The model override applies to THIS message only. `mode: 'inherit'`
      // (the default) emits the plain three-field body an older desktop knows.
      var chosen = selectedModelOption();
      var effort = state.sessionCatalog ? state.sessionCatalog.effort : '';
      var body = core.sessionSendBody({
        tool: current.tool,
        sessionId: current.id,
        text: value,
        mode: chosen ? 'select' : 'inherit',
        option: chosen,
        reasoningEffort: effort
      });

      var context = captureRpcContext();
      var result = await rpc(body, context);
      if (!result || result.stale) return;

      state.busySend = false;
      if (el.sendButton) el.sendButton.disabled = false;
      if (!result.ok) {
        // Keep the text: protocol-v1 3.7 forbids auto-resending, so the user
        // must be able to press send again themselves.
        handleFailure(result, 'detail');
        return;
      }
      hideDetailError();
      if (text === undefined && el.sendInput) {
        el.sendInput.value = '';
        delete state.drafts[scopedSessionKey(current.id, context.scope)];
      }
      await refreshDetail();
    }

    async function stopSession() {
      if (state.busyStop) return;
      var current = state.current;
      if (!current || !stopCapabilityFor(current.tool) || !core.canStopOf(current)) return;
      var context = captureRpcContext();
      if (current.scopeKey !== context.scope) return;
      state.busyStop = true;
      hideDetailError();
      var result = await rpc(core.stopBody(current.tool, current.id), context);
      if (!result || result.stale) return;
      state.busyStop = false;
      if (!result.ok) {
        handleFailure(result, 'detail');
        return;
      }
      hideDetailError();
      await refreshDetail();
    }

    async function logout() {
      if (state.admin) return adminLogout();
      await apiClient.logout();
      state.sessions = [];
      state.capabilities = null;
      state.current = null;
      state.sessionCatalog = null;
      state.sessionCatalogs[currentScopeKey()] = {};
      clearFocusMemo();
      state.authed = false;
      state.identity = null;
      invalidateScopeRequests();
      hideNotice();
      show('pair');
    }

    async function adminLogout() {
      if (!state.admin || typeof apiClient.adminLogout !== 'function') return;
      var result = await apiClient.adminLogout();
      if (!result.ok) {
        state.adminRosterError = core.errorMessage(result.code, result.message);
        if (state.screen === 'admin-roster') renderAdminRoster();
        else handleFailure(result, 'list');
        return;
      }
      var wasPaired = state.userWasPairedBeforeAdmin;
      state.admin = false;
      state.selectedComputer = null;
      state.identity = null;
      state.authed = false;
      if (el.connBadge) el.connBadge.textContent = '未登录';
      state.sessions = [];
      state.capabilities = null;
      state.current = null;
      state.sessionCatalog = null;
      state.sessionCatalogs = {};
      state.drafts = {};
      state.answerDrafts = {};
      state.answerReceipts = {};
      state.approvalReceipts = {};
      state.expandedActivity = {};
      newState.catalogsByScope = {};
      newState.projectNamesByScope = {};
      newState.catalog = null;
      newState.busy = false;
      if (el.adminPassword) el.adminPassword.value = '';
      if (el.adminUsername) el.adminUsername.value = '';
      if (el.adminLoginPanel) el.adminLoginPanel.hidden = true;
      if (el.pairUserForm) el.pairUserForm.hidden = false;
      if (el.pairAdminLoginToggle) el.pairAdminLoginToggle.hidden = false;
      clearFocusMemo();
      invalidateScopeRequests();
      hideNotice();

      var identity = typeof apiClient.me === 'function' ? await apiClient.me() : null;
      if (identity && identity.ok && identity.result && identity.result.role === 'user') {
        state.identity = Object.assign({}, identity.result);
        state.authed = true;
        invalidateScopeRequests();
        show('list');
        await refreshList();
        return;
      }
      if (wasPaired) {
        state.identity = { role: 'user' };
        state.authed = true;
        invalidateScopeRequests();
        show('list');
        await refreshList();
        return;
      }
      state.userWasPairedBeforeAdmin = false;
      show('pair');
    }

    // ------------------------------------------------------------- polling

    function scheduleTick() {
      if (state.timer !== null) clearTimer(state.timer);
      state.timer = setTimer(function () {
        tick();
      }, core.LIST_INTERVAL_MS);
    }

    async function tick() {
      if (state.admin && !state.selectedComputer) {
        if (state.screen === 'admin-roster' && !document.hidden && !state.adminRosterLoading &&
            now() - state.lastRosterMs >= core.LIST_INTERVAL_MS) {
          await refreshAdminRoster();
        }
        scheduleTick();
        return;
      }
      var action = core.nextPollAction({
        authed: state.authed,
        hidden: !!document.hidden,
        inflight: state.inflight,
        view: state.screen === 'detail' ? 'detail' : 'list',
        sessionId: state.current ? state.current.id : null,
        sessionStatus: state.current ? state.current.status : null,
        nowMs: now(),
        lastListMs: state.lastListMs,
        lastReadMs: state.lastReadMs
      });
      if (action === 'list') await refreshList();
      else if (action === 'read') await refreshDetail();
      scheduleTick();
    }

    async function retry() {
      if (state.screen === 'admin-roster') await refreshAdminRoster();
      else if (state.screen === 'detail') await refreshDetail();
      else await refreshList();
    }

    // ------------------------------------------------------- partial success

    function renderPartialNotice() {
      if (!el.detailPartial) return;
      var partial = newState.partial;
      if (!partial || state.screen !== 'detail') {
        el.detailPartial.hidden = true;
        return;
      }
      el.detailPartialText.textContent = partial.text;
      el.detailPartial.hidden = false;
    }

    function notePartial(text) {
      newState.partial = { text: text };
      renderPartialNotice();
    }

    function clearPartial() {
      newState.partial = null;
      renderPartialNotice();
    }

    // ------------------------------------------------------ new session panel

    function snapshotSessionIds() {
      var known = {};
      (state.sessions || []).forEach(function (session) { known[session.id] = true; });
      return known;
    }

    function pickDefaultTool() {
      var tools = availableToolIds();
      for (var i = 0; i < tools.length; i++) {
        if (capabilityFor('models.list', tools[i]) && capabilityFor('session.create', tools[i])) {
          return tools[i];
        }
      }
      return tools[0] || 'codex';
    }

    function openNewSession(prefill) {
      newPanelSeq += 1;
      newState.loading = false;
      newState.catalog = null;
      newState.error = '';
      newState.busy = false;
      newState.partial = null;
      newState.requestId = '';
      newState.selectedKey = '';
      newState.selectedEffort = '';
      if (el.newText) el.newText.value = '';
      if (el.newError) el.newError.textContent = '';
      newState.tool = prefill && prefill.tool ? prefill.tool : pickDefaultTool();
      newState.prefillProjectId = prefill && prefill.projectId ? prefill.projectId : '';
      state.projectId = newState.prefillProjectId;
      show('new');
      renderNewPanel();
      return loadCatalog(newState.tool);
    }

    function selectNewTool(tool) {
      if (newState.tool === tool && newState.catalog) return;
      newState.tool = tool;
      newState.catalog = null;
      newState.error = '';
      newState.selectedKey = '';
      newState.selectedEffort = '';
      // A different tool is a different creation: it gets its own requestId.
      newState.requestId = '';
      newPanelSeq += 1;
      renderNewPanel();
      loadCatalog(tool);
    }

    async function loadCatalog(tool) {
      var seq = newPanelSeq;
      if (!capabilityFor('models.list', tool)) {
        newState.loading = false;
        newState.catalog = null;
        renderNewPanel();
        return;
      }
      var catalogs = newCatalogMap();
      if (catalogs[tool]) {
        newState.catalog = catalogs[tool];
        renderNewPanel();
        return;
      }
      newState.loading = true;
      if (el.newSubmit) el.newSubmit.disabled = true;
      renderNewPanel();

      var context = captureRpcContext();
      var result = await rpc(core.modelsListBody(tool), context);

      // The user may have switched tool (or left) while this was in flight: a
      // late catalog must never land on a different tool's panel.
      if (!result || result.stale || !rpcContextIsCurrent(context) || seq !== newPanelSeq || newState.tool !== tool) {
        return;
      }
      newState.loading = false;
      if (!result.ok) {
        newState.catalog = null;
        newState.error = core.errorMessage(result.code, result.message);
        renderNewPanel();
        return;
      }
      newState.error = '';
      newState.catalog = result.result || null;
      newCatalogMap(context.scope)[tool] = newState.catalog;
      rememberProjectNames(newState.catalog, context.scope);
      renderNewPanel();
    }

    /** Remember the readable name of every catalog project (never invented). */
    function rememberProjectNames(catalog, scope) {
      var names = projectNamesMap(scope);
      core.projectOptions(catalog).forEach(function (project) {
        names[project.id] = core.projectLabel(project);
      });
    }

    /**
     * The projects of the tool's OWN live catalog for the panel that is open.
     *
     * A catalog this phone never fetched for this tool is NOT used: reusing
     * another tool's project ids is exactly how a create lands on the wrong
     * project. An empty result means "this tool has no such project", never
     * "use the other tool's id".
     */
    function newPanelProjects() {
      var catalog = newState.catalog;
      if (!catalog || typeof catalog !== 'object') {
        return [];
      }
      if (typeof catalog.tool === 'string' && catalog.tool !== '' && catalog.tool !== newState.tool) {
        return [];
      }
      return core.projectOptions(catalog);
    }

    /**
     * Resolve a project id against exactly this tool's live catalog.
     *
     * Returns the catalog's OWN id for that project, or '' when this tool does
     * not have it. A directory may be identified by a project id or by the path
     * itself, so both are tried -- but the answer is always an id out of this
     * tool's catalog, never a value carried over from somewhere else.
     */
    function resolveProjectIdForTool(tool, wanted) {
      var key = typeof wanted === 'string' ? wanted : '';
      if (key === '') {
        return '';
      }
      var catalog = newCatalogMap()[tool];
      if (catalog && typeof catalog.tool === 'string' && catalog.tool !== '' && catalog.tool !== tool) {
        catalog = null;
      }
      var projects = core.projectOptions(catalog);
      var wantedPath = core.canonicalPath(key);
      var found = '';
      projects.forEach(function (project) {
        if (found !== '') {
          return;
        }
        if (project.id === key) {
          found = project.id;
          return;
        }
        if (wantedPath !== '' && core.canonicalPath(project.cwd) === wantedPath) {
          found = project.id;
        }
      });
      return found;
    }

    function renderNewPanel() {
      // --- tool choices: an unusable tool is greyed, never silently missing ---
      if (el.toolChoices) {
        ui.clear(el.toolChoices);
        availableToolIds().forEach(function (tool) {
          var button = ui.button(document, core.toolLabel(tool),
            'choice' + (newState.tool === tool ? ' choice-active' : ''),
            function () { selectNewTool(tool); });
          button.setAttribute('data-tool', tool);
          button.disabled = !(capabilityFor('models.list', tool) && capabilityFor('session.create', tool));
          el.toolChoices.appendChild(button);
        });
      }

      var workBuddyUsable = capabilityFor('models.list', 'workbuddy') && capabilityFor('session.create', 'workbuddy');
      var workBuddyReported = availableToolIds().indexOf('workbuddy') !== -1;
      var workBuddyReadOnly = workBuddyReported && capabilityFor('session.read', 'workbuddy') &&
        !capabilityFor('session.send', 'workbuddy');
      var workBuddyCannotCreate = newState.tool === 'workbuddy' && !workBuddyUsable;
      var options = workBuddyCannotCreate ? [] : core.modelOptions(newState.catalog);
      var availability = '';
      var ready = false;
      if (workBuddyCannotCreate) {
        availability = '';
      } else if (!capabilityFor('session.create', newState.tool)) {
        availability = toolStatusReason(newState.tool) || '这台电脑不支持新建会话。';
      } else if (!capabilityFor('models.list', newState.tool)) {
        availability = toolStatusReason(newState.tool) || '该工具不支持读取模型列表，暂时不能新建。';
      } else if (newState.loading) {
        availability = '正在读取模型…';
      } else if (newState.error) {
        availability = newState.error;
      } else if (options.length === 0) {
        var reason = core.catalogReason(newState.catalog);
        availability = '没有可用模型' + (reason ? '：' + reason : '。');
      } else {
        ready = true;
      }

      if (el.newAvailability) {
        el.newAvailability.hidden = ready || workBuddyCannotCreate;
        el.newAvailability.textContent = availability;
      }
      if (el.workBuddyOfficialHelp) {
        var workBuddyReason = toolStatusReason('workbuddy');
        el.workBuddyOfficialHelp.hidden = !workBuddyReported || workBuddyUsable;
        el.workBuddyOfficialHelp.setAttribute('title', !workBuddyUsable ? workBuddyReason : '');
        if (el.workBuddyOfficialHelpText) {
          el.workBuddyOfficialHelpText.textContent = workBuddyReadOnly
            ? '可查看本机会话；续聊和授权操作暂未接入。'
            : 'WorkBuddy 暂未接入此工作台。可在官方手机 App 登录与电脑相同的账号，继续已有聊天。';
        }
      }
      if (el.newNativeControls) {
        el.newNativeControls.hidden = workBuddyCannotCreate;
      }

      // --- models: options come only from what the desktop reported ---
      if (el.modelSelect) {
        // The <option> value is the option's unique KEY (provider + id), never
        // the model id alone: DSH reports one id under several providers, and
        // duplicate values make the browser resolve the select to the FIRST
        // match -- which silently created the session on the wrong provider.
        var previousKey = newState.selectedKey;
        el.modelSelect.textContent = '';
        options.forEach(function (option) {
          var node = document.createElement('option');
          node.setAttribute('value', option.key);
          node.textContent = option.text || core.modelOptionLabel(option);
          el.modelSelect.appendChild(node);
        });
        var fallback = core.defaultModelOption(options);
        newState.selectedKey = core.modelOptionByKey(options, previousKey)
          ? previousKey
          : (fallback ? fallback.key : '');
        el.modelSelect.value = newState.selectedKey;
        el.modelSelect.disabled = !ready;
      }

      var selected = core.modelOptionByKey(options, newState.selectedKey);

      // --- reasoning effort: allowed to be submitted, options from the model ---
      if (el.effortRow && el.effortSelect) {
        var efforts = selected ? selected.reasoningEfforts : [];
        if (efforts.length === 0) {
          el.effortRow.hidden = true;
          el.effortSelect.textContent = '';
          newState.selectedEffort = '';
        } else {
          el.effortRow.hidden = false;
          el.effortSelect.textContent = '';
          efforts.forEach(function (effort) {
            var node = document.createElement('option');
            node.setAttribute('value', effort);
            node.textContent = effortLabel(effort);
            el.effortSelect.appendChild(node);
          });
          var want = (newState.selectedEffort && efforts.indexOf(newState.selectedEffort) !== -1)
            ? newState.selectedEffort
            : (selected.defaultReasoningEffort || efforts[0]);
          newState.selectedEffort = want;
          el.effortSelect.value = want;
        }
      }

      // --- optional project -------------------------------------------------
      // Codex: only a real project id from the live catalog (its native call
      // has no `cwd`, so an arbitrary path is never shown or sent).
      // DSH: a real project id, or a free-text working directory.
      //
      // The ids in this list are ALWAYS the chosen tool's own. A directory the
      // user picked elsewhere is resolved against this tool's catalog before it
      // can be shown, and when this tool does not have it the selection falls
      // back to "不使用项目" -- a project id from another tool is never
      // submitted in its place.
      var projects = newPanelProjects();
      if (el.projectRow && el.projectSelect) {
        if (projects.length === 0) {
          // No catalog for this tool yet (or it genuinely has no projects): the
          // row is hidden and NOTHING is consumed, so the directory the user
          // arrived with is still resolvable once the catalog lands.
          el.projectRow.hidden = true;
          el.projectSelect.textContent = '';
          newState.projectId = '';
        } else {
          el.projectRow.hidden = false;
          el.projectSelect.textContent = '';
          var none = document.createElement('option');
          none.setAttribute('value', '');
          none.textContent = '不使用项目';
          el.projectSelect.appendChild(none);
          projects.forEach(function (project) {
            var node = document.createElement('option');
            node.setAttribute('value', project.id);
            node.textContent = core.projectLabel(project) +
              (project.cwd ? '（' + project.cwd + '）' : '');
            el.projectSelect.appendChild(node);
          });
          var wanted = newState.projectId || newState.prefillProjectId || '';
          if (newState.projectId === '' && newState.prefillProjectId !== '') {
            wanted = resolveProjectIdForTool(newState.tool, newState.prefillProjectId);
          }
          // The prefill is consumed exactly once: it belongs to the entry into
          // this panel, not to every later repaint (which is how a project id
          // from one tool used to survive a switch to the other).
          newState.prefillProjectId = '';
          var known = projects.filter(function (project) { return project.id === wanted; })[0];
          newState.projectId = known ? wanted : '';
          el.projectSelect.value = newState.projectId;
        }
      }
      if (el.cwdRow) {
        el.cwdRow.hidden = newState.tool !== 'dsh';
      }

      // --- first message ----------------------------------------------------
      // Codex's native create_thread requires a prompt, so a Codex creation
      // must carry one. We say so plainly instead of inventing a filler prompt
      // the user never wrote.
      var needsText = newState.tool === 'codex';
      if (el.newTextHint) {
        el.newTextHint.hidden = !needsText;
        el.newTextHint.textContent = needsText ? 'Codex 需要首条消息才能真正开始这个会话。' : '';
      }
      if (el.newText) {
        el.newText.setAttribute(
          'placeholder',
          needsText ? 'Codex 必填：这个会话的第一条消息' : '可以留空，创建后再发'
        );
      }
      var textValue = el.newText ? el.newText.value : '';
      var textSatisfied = !needsText || textValue.trim() !== '';

      if (el.newSubmit) {
        el.newSubmit.disabled = !ready || newState.busy || !textSatisfied;
      }
    }

    /**
     * Create a session for real.
     *
     * One attempt = one `requestId`. It is generated here (the phone owns it),
     * reused when the SAME attempt is retried so the desktop can de-duplicate,
     * and replaced as soon as the user changes what would be created. We never
     * retry on our own: a blind retry is how duplicate sessions appear.
     *
     * Native contract: when a project is selected the desktop wants the project
     * id ONLY (its native create rejects workspaceId and cwd together), and a
     * free working directory travels only when no project was chosen.
     */
    async function submitNewSession() {
      if (newState.busy) return;
      if (!capabilityFor('models.list', newState.tool) || !capabilityFor('session.create', newState.tool)) return;
      var options = core.modelOptions(newState.catalog);
      var selected = core.modelOptionByKey(options, newState.selectedKey);
      if (!selected) return;

      if (!newState.requestId) {
        newState.requestId = core.newRequestId();
      }
      var firstText = el.newText ? el.newText.value : '';
      var optional = {
        tool: newState.tool,
        text: firstText,
        requestId: newState.requestId
      };
      // The project id is resolved against THIS tool's live catalog one last
      // time, immediately before the create goes out. What travels is therefore
      // always an id out of the catalog of the tool being created on -- never a
      // value remembered from the other tool, and never a fabricated one.
      //
      // When the chosen directory is NOT in this tool's catalog the create is
      // refused with an explanation instead of quietly falling back to a
      // directory the user did not choose (or, on Codex, to no project at all,
      // which would land the session somewhere they never picked).
      var selectedProjectValue = el.projectSelect && el.projectSelect.value ? el.projectSelect.value : '';
      var projectId = selectedProjectValue === ''
        ? ''
        : resolveProjectIdForTool(newState.tool, selectedProjectValue);
      if (selectedProjectValue !== '' && projectId === '') {
        if (el.newError) {
          el.newError.textContent =
            '这个项目不在 ' + core.toolLabel(newState.tool) +
            ' 的项目列表里。请重新选择项目，或改用当前工具真正拥有的目录。';
        }
        renderNewPanel();
        return;
      }
      if (projectId) {
        optional.projectId = projectId;
      } else if (newState.tool === 'dsh' && el.cwdInput && el.cwdInput.value.trim() !== '') {
        optional.cwd = el.cwdInput.value.trim();
      }
      var body = core.sessionCreateBody(Object.assign(
        optional, core.modelSelection(selected, newState.selectedEffort)
      ));

      newState.busy = true;
      createSeq += 1;
      var seq = createSeq;
      var context = captureRpcContext();
      var known = snapshotSessionIds();
      if (el.newSubmit) el.newSubmit.disabled = true;
      if (el.newError) el.newError.textContent = '';

      var result = await rpc(body, context);

      // A newer attempt (or a different tool) has taken over: drop this answer.
      if (!result || result.stale || !rpcContextIsCurrent(context) || seq !== createSeq) return;
      newState.busy = false;

      if (result.ok && result.result && typeof result.result.sessionId === 'string' &&
          result.result.sessionId !== '') {
        await adoptCreatedSession(result.result, firstText, context.scope);
        return;
      }

      if (isUnreachable(result) || result.code === 'bridge_timeout' ||
          result.code === 'bridge_bad_response') {
        await resolveUnknownCreate(known, context.scope, context.generation);
        return;
      }

      // A definite failure: nothing was created. The requestId is kept so that
      // if the user retries the same attempt, it still cannot duplicate.
      if (el.newError) {
        el.newError.textContent = core.errorMessage(result.code, result.message);
      }
      renderNewPanel();
    }

    /**
     * A session exists. Open it.
     *
     * A creation the desktop reports as COMPLETE must show no failure entry at
     * all -- offering "重发首条消息" after a confirmed success is a false
     * failure prompt, and it invites the user to send a duplicate message.
     * Only an explicitly partial result gets the in-session re-send.
     */
    async function adoptCreatedSession(created, firstText, scope) {
      newState.requestId = '';
      newState.partial = null;
      newState.pendingFirstText = '';
      clearPartial();
      await refreshList();
      if (scope !== currentScopeKey()) return;
      await openSession(created.sessionId, { tool: created.tool || newState.tool, title: created.title || '' });
      if (scope !== currentScopeKey()) return;

      // The desktop's own verdict, not our guess: only an explicit flag means
      // something was left unfinished.
      var isPartial = created.partial === true || created.incomplete === true;
      if (!isPartial) {
        return;
      }
      var hasFirstText = !!(firstText && firstText.trim() !== '');
      // Re-sending happens IN this session (session.send) -- never a new
      // creation, which would leave an orphan behind.
      newState.pendingFirstText = hasFirstText ? firstText : '';
      notePartial(hasFirstText
        ? '会话已创建，但首条消息未发出。可以用下面的按钮在这个会话里重发（不会重复创建）。'
        : '会话已创建，但后续步骤未完成。');
    }

    /**
     * The creation answer never arrived. Do NOT create again: ask the session
     * list whether a new session of this tool appeared, and adopt it if so.
     */
    async function resolveUnknownCreate(known, scope, generation) {
      var tool = newState.tool;
      await refreshList();
      if (scope !== currentScopeKey() || generation !== scopeGeneration) return;
      var candidate = null;
      (state.sessions || []).forEach(function (session) {
        if (!session || known[session.id]) return;
        if (session.tool !== tool) return;
        if (!candidate || String(session.updatedAt) > String(candidate.updatedAt)) {
          candidate = session;
        }
      });

      if (candidate) {
        newState.requestId = '';
        await openSession(candidate.id, { tool: candidate.tool, title: candidate.title });
        notePartial('创建请求没有返回结果，但电脑上出现了这个新会话，已经打开它。请确认是不是你要的会话。');
        return;
      }

      if (el.newError) {
        el.newError.textContent =
          '创建结果未知：电脑上没有找到新会话。可以先返回列表确认，再决定是否重试（重试不会重复创建）。';
      }
      renderNewPanel();
    }

    /** Re-send the first message inside the session that was already created. */
    async function retryFirstMessage() {
      var text = newState.pendingFirstText;
      var current = state.current;
      if (!text || !current || state.busySend || !capabilityFor('session.send', current.tool)) return;
      var context = captureRpcContext();
      if (context.scope !== current.scopeKey) return;
      state.busySend = true;
      if (el.detailPartialRetry) el.detailPartialRetry.disabled = true;
      var result = await rpc(core.sendBody(current.tool, current.id, text), context);
      if (!result || result.stale) return;
      state.busySend = false;
      if (el.detailPartialRetry) el.detailPartialRetry.disabled = false;
      if (!result.ok) {
        showDetailError(core.errorMessage(result.code, result.message));
        return;
      }
      newState.pendingFirstText = '';
      clearPartial();
      await refreshDetail();
    }

    // --------------------------------------------------------------- wiring

    function bind() {
      if (el.pairSubmit) {
        el.pairSubmit.addEventListener('click', function () {
          submitPair();
        });
      }
      if (el.pairAdminLoginToggle) {
        el.pairAdminLoginToggle.addEventListener('click', function () { showAdminLogin('pair'); });
      }
      if (el.adminLoginSubmit) {
        el.adminLoginSubmit.addEventListener('click', function () { submitAdminLogin(); });
      }
      if (el.adminLoginBack) {
        el.adminLoginBack.addEventListener('click', function () { hideAdminLogin(); });
      }
      if (el.settingsAdminLogin) {
        el.settingsAdminLogin.addEventListener('click', function () { showAdminLogin('settings'); });
      }
      if (el.adminLogout) {
        el.adminLogout.addEventListener('click', function () { adminLogout(); });
      }
      if (el.adminContextBack) {
        el.adminContextBack.addEventListener('click', function () { returnToAdminRoster(); });
      }
      if (el.adminEnrollmentButton) {
        el.adminEnrollmentButton.addEventListener('click', function () { generateEnrollmentCode(); });
      }
      if (el.noticeRetry) {
        el.noticeRetry.addEventListener('click', function () {
          retry();
        });
      }
      if (el.search) {
        el.search.addEventListener('input', function () {
          state.query = el.search.value;
          renderList();
        });
      }
      [{ node: el.tabChats, tab: 'chats' }, { node: el.tabTasks, tab: 'tasks' }, { node: el.tabSettings, tab: 'settings' }]
        .forEach(function (entry) {
          if (entry.node) {
            entry.node.addEventListener('click', function () { selectTab(entry.tab); });
          }
        });
      if (el.projectFilterButton) {
        el.projectFilterButton.addEventListener('click', function () {
          openProjectSheet();
        });
      }
      if (el.filterClearButton) {
        el.filterClearButton.addEventListener('click', function () { clearFilters(); });
      }
      if (el.projectSearch) {
        el.projectSearch.addEventListener('input', function () { renderProjectSheet(); });
      }
      if (el.projectSheetClose) {
        el.projectSheetClose.addEventListener('click', function () { closeProjectSheet(); });
      }
      if (el.sheetBackdrop) {
        el.sheetBackdrop.addEventListener('click', function () { closeProjectSheet(); });
      }
      if (el.prefsResetButton) {
        el.prefsResetButton.addEventListener('click', function () { clearFilters(); });
      }
      if (el.pinsClearButton) {
        el.pinsClearButton.addEventListener('click', function () {
          clearScopedPins();
          renderList();
        });
      }
      if (el.modelChipButton) {
        el.modelChipButton.addEventListener('click', function () { toggleModelPicker(); });
      }
      if (el.modelResetButton) {
        el.modelResetButton.addEventListener('click', function () {
          if (state.sessionCatalog) {
            state.sessionCatalog.key = '';
            state.sessionCatalog.effort = '';
          }
          renderModelPicker();
        });
      }
      if (el.modelPickerEffortSelect) {
        el.modelPickerEffortSelect.addEventListener('change', function () {
          if (state.sessionCatalog) {
            state.sessionCatalog.effort = el.modelPickerEffortSelect.value;
          }
        });
      }
      if (el.detailBack) {
        el.detailBack.addEventListener('click', function () {
          closeSession();
        });
      }
      if (el.sendButton) {
        el.sendButton.addEventListener('click', function () {
          sendMessage();
        });
      }
      if (el.sendInput) {
        el.sendInput.addEventListener('input', function () {
          var current = state.current;
          if (current) {
            state.drafts[scopedSessionKey(current.id, current.scopeKey)] = el.sendInput.value;
          }
        });
      }
      if (el.stopButton) {
        el.stopButton.addEventListener('click', function () {
          stopSession();
        });
      }
      if (el.logout) {
        el.logout.addEventListener('click', function () {
          logout();
        });
      }
      if (el.newSessionButton) {
        el.newSessionButton.addEventListener('click', function () {
          openNewSession();
        });
      }
      if (el.newBack) {
        el.newBack.addEventListener('click', function () {
          // Abandoning the panel abandons the attempt: the next "新建" is a new
          // creation and must get a new requestId.
          newPanelSeq += 1;
          createSeq += 1;
          newState.requestId = '';
          newState.busy = false;
          show('list');
          renderList();
        });
      }
      if (el.newSubmit) {
        el.newSubmit.addEventListener('click', function () {
          submitNewSession();
        });
      }
      if (el.modelSelect) {
        el.modelSelect.addEventListener('change', function () {
          newState.selectedKey = el.modelSelect.value;
          newState.selectedEffort = '';
          // A different model is a different creation.
          newState.requestId = '';
          renderNewPanel();
        });
      }
      if (el.effortSelect) {
        el.effortSelect.addEventListener('change', function () {
          newState.selectedEffort = el.effortSelect.value;
        });
      }
      if (el.projectSelect) {
        el.projectSelect.addEventListener('change', function () {
          newState.projectId = el.projectSelect.value;
          newState.requestId = '';
          // A chosen project and a free directory contradict each other, so the
          // directory field is cleared rather than sent alongside.
          if (newState.projectId && el.cwdInput) el.cwdInput.value = '';
        });
      }
      if (el.newText) {
        el.newText.addEventListener('input', function () {
          // The first message is part of the creation, so editing it makes this
          // a different creation. Re-render to update the submit gate (Codex
          // requires a first message).
          newState.requestId = '';
          renderNewPanel();
        });
      }
      if (el.detailPartialRetry) {
        el.detailPartialRetry.addEventListener('click', function () {
          retryFirstMessage();
        });
      }
      if (document.addEventListener) {
        document.addEventListener('visibilitychange', function () {
          if (!document.hidden) tick();
        });
      }
      if (host.addEventListener) {
        // A #pair= link that arrives while the page is already open is a
        // same-document navigation: nothing reloads, so start() does not run
        // again and the load-time read of the fragment would never happen.
        // consumePairFragment() returns immediately when there is no pair=
        // parameter, so it is safe to call on every hash change (Q-02).
        host.addEventListener('hashchange', function () {
          consumePairFragment();
        });
      }
      if (host.addEventListener) {
        host.addEventListener('offline', function () {
          state.online = false;
          if (el.connBadge) el.connBadge.textContent = '离线';
          showNotice('网络不可用或已离线，请检查网络后重试');
        });
        host.addEventListener('online', function () {
          state.online = true;
          if (el.connBadge) el.connBadge.textContent = '已连接';
          hideNotice();
          retry();
        });
      }
    }

    /**
     * Leaving a session: keep its draft and its expanded activity, and take the
     * session-specific panels off screen. Hiding them is not enough -- a hidden
     * panel still holds the previous session's questions and approvals in the
     * DOM, and a later read must never be the only thing standing between those
     * stale controls and a mistaken tap.
     */
    function closeSession() {
      captureExpandedState();
      var draft = el.sendInput ? el.sendInput.value : '';
      if (state.current) {
        state.drafts[scopedSessionKey(state.current.id, state.current.scopeKey)] = draft;
      }
      if (el.sendInput) el.sendInput.value = '';
      if (el.messageList) el.messageList.textContent = '';
      if (el.approvalsList) el.approvalsList.textContent = '';
      if (el.questionsList) el.questionsList.textContent = '';
      if (el.approvalsPanel) el.approvalsPanel.hidden = true;
      if (el.questionsPanel) el.questionsPanel.hidden = true;
      if (el.detailTruncated) el.detailTruncated.hidden = true;
      if (el.modelPicker) el.modelPicker.hidden = true;
      state.sessionCatalog = null;
      state.sessionCatalogs[currentScopeKey()] = {};
      clearFocusMemo();
      resetModelPickerPaint();
      state.current = null;
      show('list');
      renderList();
    }

    async function start() {
      bind();
      consumePairFragment();
      prefsModule.applyTheme(document, prefs.get().theme);
      renderSettings();
      if (el.pairName && !el.pairName.value) el.pairName.value = deviceName;
      // The pairing screen is ALWAYS the first screen: a device that has never
      // paired must be able to reach the code form even when the very first
      // request fails (no network, a proxy error, a 401). Only a successful
      // response moves the user on to the session list.
      state.authed = false;
      show('pair');
      scheduleTick();
      if (typeof apiClient.me === 'function') {
        var identity = await apiClient.me();
        if (identity.ok && identity.result && identity.result.role === 'admin') {
          state.admin = true;
          state.identity = Object.assign({}, identity.result);
          state.authed = true;
          invalidateScopeRequests();
          show('admin-roster');
          await refreshAdminRoster();
          return;
        }
        if (identity.ok && identity.result && identity.result.role === 'user') {
          state.admin = false;
          state.identity = Object.assign({}, identity.result);
          state.authed = true;
          invalidateScopeRequests();
        }
      }
      await refreshList();
    }

    return {
      state: state,
      elements: el,
      prefs: prefs,
      start: start,
      tick: tick,
      retry: retry,
      refreshList: refreshList,
      refreshDetail: refreshDetail,
      openSession: openSession,
      closeSession: closeSession,
      sendMessage: sendMessage,
      stopSession: stopSession,
      submitPair: submitPair,
      logout: logout,
      renderList: renderList,
      renderSettings: renderSettings,
      selectTab: selectTab,
      setToolFilter: setToolFilter,
      setProjectFilter: setProjectFilter,
      clearFilters: clearFilters,
      openProjectSheet: openProjectSheet,
      closeProjectSheet: closeProjectSheet,
      renderProjectSheet: renderProjectSheet,
      stopButtonMode: stopButtonMode,
      openNewSession: openNewSession,
      submitNewSession: submitNewSession,
      retryFirstMessage: retryFirstMessage,
      renderNewPanel: renderNewPanel,
      renderDetail: renderDetail,
      submitAnswer: submitAnswer,
      submitApproval: submitApproval,
      loadSessionCatalog: loadSessionCatalog,
      newState: newState
    };
  }

  return { createApp: createApp };
});
