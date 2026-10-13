'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { WorkBuddyAdapter, normalizeModelName, uniqueModelOptions, nativeIdentityTitle, nativeHistoryAnchors } = require('../src/adapters/workbuddy');

function fakeDb() {
  return { prepare: () => ({ all: () => [], get: () => null }), close() {} };
}

function control(safeActionLabel, fields = {}) {
  return {
    controlType: safeActionLabel === 'model-option' ? 'ControlType.ListItem'
      : safeActionLabel === 'composer' ? 'ControlType.Edit'
        : safeActionLabel === 'send-label' ? 'ControlType.Button'
          : safeActionLabel === 'new-task-tab' ? 'ControlType.TabItem' : 'ControlType.ComboBox',
    safeActionLabel, accessibleName: '', enabled: true, selected: false, offscreen: false, focusable: true,
    runtimeIdHash: '0123456789abcdef', structuralPathHash: 'fedcba9876543210', regionHash: 'aaaaaaaaaaaaaaaa',
    passwordProtected: false, rect: { x: 10, y: 20, width: 100, height: 30 }, draftState: 'unavailable',
    draftFingerprint: '', patterns: ['expandCollapse'], ...fields,
  };
}

function modelSnapshot(controls, overrides = {}) {
  return {
    operation: 'semantic-snapshot', inputDesktopKind: 'default',
    target: { processId: 10, handle: '20', visible: true, enabled: true, minimized: false,
      isForeground: false, foregroundHandle: '99', mainWindow: true },
    processContext: { sameWindowsSession: true, sameBitness: true, sameIntegrityLevel: true },
    uiaCom: { traversalTruncated: false, errorType: null, errorStage: '', composerBindingSucceeded: true },
    controls,
    ...overrides,
  };
}

function adapterWithModelUi() {
  const adapter = new WorkBuddyAdapter({ db: fakeDb(), configDir: 'C:\\fixture', columns: [],
    uiAutomation: { enabled: true, executablePath: 'D:\\tools\\WorkBuddy\\WorkBuddy.exe' } });
  const calls = [];
  adapter.nativeTitleCountStatement.get = () => ({ count: 0 });
  adapter.nativeTitleRowsStatement.all = () => [];
  adapter.uiAutomationInspector = {
    async discoverMainWindows() {
      return { inputDesktopKind: 'default', windows: [{ processId: 10, handle: '20', visible: true,
        enabled: true, minimized: false, isForeground: false, foregroundHandle: '99', mainWindow: true }] };
    },
    async readNativeModelCatalog() {
      calls.push('catalog');
      return { outcome: 'confirmed', targetContextVerified: true, catalog: {
        currentModel: 'Kimi-K3', models: ['Kimi-K3', 'Deepseek-V4.1-Flash'], targetContextVerified: true,
        composerVerified: true, initialDraftFingerprint: 'e3b0c44298fc1c14', finalDraftFingerprint: 'e3b0c44298fc1c14',
      } };
    },
    async semanticSnapshot() {
      calls.push('snapshot');
      return modelSnapshot([], { target: { processId: 10, handle: '20', visible: true, enabled: true, minimized: false,
        isForeground: false, foregroundHandle: '99', mainWindow: true },
        processContext: { sameWindowsSession: true, sameBitness: true, sameIntegrityLevel: true } });
    },
  };
  return { adapter, calls };
}

test('model labels normalize only the native selector prefix and reject ambiguous or unsafe options', () => {
  assert.equal(normalizeModelName('Select model: Kimi-K3'), 'Kimi-K3');
  assert.equal(normalizeModelName('选择模型： Kimi-K3'), 'Kimi-K3');
  assert.equal(normalizeModelName('Kimi-K3'), 'Kimi-K3');
  assert.deepEqual(uniqueModelOptions([
    { accessibleName: 'Kimi-K3' }, { accessibleName: 'Deepseek-V4.1-Flash' },
  ]), ['Kimi-K3', 'Deepseek-V4.1-Flash']);
  assert.deepEqual(uniqueModelOptions([{ accessibleName: 'Kimi-K3' }, { accessibleName: 'Kimi-K3' }]), []);
  assert.deepEqual(uniqueModelOptions([{ accessibleName: 'access_token=should-not-show' }]), []);
});

test('models.list reports only the live native model options and marks the selected model', async () => {
  const { adapter, calls } = adapterWithModelUi();
  assert.equal(adapter.canModelsList(), true);
  const listed = await adapter.listModels();
  assert.deepEqual(listed.models, [
    { id: 'Kimi-K3', label: 'Kimi-K3', isDefault: true },
    { id: 'Deepseek-V4.1-Flash', label: 'Deepseek-V4.1-Flash', isDefault: false },
  ]);
  assert.deepEqual(listed.projects, []);
  assert.match(listed.catalogSource, /native model options.*UIA listbox/);
  assert.deepEqual(calls, ['snapshot', 'catalog']);
  await adapter.close();
});

test('a minimized exact native target is restored and reobserved before model access', async () => {
  const { adapter, calls } = adapterWithModelUi();
  const discover = adapter.uiAutomationInspector.discoverMainWindows;
  adapter.uiAutomationInspector.discoverMainWindows = async () => {
    const result = await discover(); result.windows[0].minimized = true; return result;
  };
  const observe = adapter.uiAutomationInspector.semanticSnapshot;
  adapter.uiAutomationInspector.activateSemanticSnapshot = async (...args) => {
    calls.push('restore'); return observe(...args);
  };
  const listed = await adapter.listModels();
  assert.equal(listed.models.length, 2);
  assert.deepEqual(calls, ['restore', 'snapshot', 'catalog']);
  await adapter.close();
});

test('model listing falls back only to a verified current model and rejects an incomplete native frame', async () => {
  const { adapter, calls } = adapterWithModelUi();
  const listed = await adapter.listModels();
  assert.equal(listed.models.length, 2);
  assert.deepEqual(calls, ['snapshot', 'catalog']);
  adapter.uiAutomationInspector.readNativeModelCatalog = async () => ({ outcome: 'blocked', targetContextVerified: true,
    catalog: { currentModel: '', models: [], targetContextVerified: true, composerVerified: false,
      initialDraftFingerprint: '', finalDraftFingerprint: '' } });
  await assert.rejects(adapter.listModels(), /native model selector and unchanged composer/);
  await adapter.close();
});

function identityAdapterFixture(rows, histories) {
  const adapter = new WorkBuddyAdapter({ db: fakeDb(), configDir: 'C:\\fixture', columns: [],
    uiAutomation: { enabled: true, executablePath: 'D:\\tools\\WorkBuddy\\WorkBuddy.exe' } });
  adapter.readStatement.get = (id) => rows.find((row) => row.id === id) ?? null;
  adapter.identityTitleCountStatement.get = (title) => ({ count: rows.filter((row) => nativeIdentityTitle(row) === title).length });
  adapter.identityCandidatesStatement.all = (title, limit) => rows.filter((row) => nativeIdentityTitle(row) === title).slice(0, limit);
  adapter.readSession = (id) => ({ id, historyTruncated: false, messages: histories[id] ?? [] });
  return adapter;
}

function adapterWithNativeWriter({ rows = [], histories = {}, newTaskSelected = true, onSent = null,
  startOnSkillsPage = false,
  newTaskPageProof = { snapshotComplete: true, verified: true, selectedNewTaskTabCount: 1,
    selectedConversationTabMatches: 0, conversationHeaderMatches: 0, visibleWelcomeMarkerMatches: 1,
    composerDocumentWelcomeMarkerMatches: 1, composerDocumentRegionHash: '1122334455667788' } } = {}) {
  const adapter = new WorkBuddyAdapter({ db: fakeDb(), configDir: 'C:\\fixture', columns: [],
    uiAutomation: { enabled: true, executablePath: 'D:\\tools\\WorkBuddy\\WorkBuddy.exe' } });
  const sessions = rows.map((row) => ({ ...row }));
  const transcripts = new Map(Object.entries(histories));
  let draft = '';
  let tabSelected = newTaskSelected;
  let skillsPage = startOnSkillsPage;
  const actions = [];
  const target = { processId: 42, handle: '84', visible: true, enabled: true, minimized: false, isForeground: false, mainWindow: true };
  const snapshot = () => {
    if (skillsPage) return modelSnapshot([
      control('new-task-tab', { accessibleName: '新建任务', controlType: 'ControlType.TabItem', selected: false,
        patterns: ['selectionItem'], regionHash: 'bbbbbbbbbbbbbbbb' }),
      control('', { accessibleName: '专家·技能·连接器', controlType: 'ControlType.TabItem', selected: true }),
    ], { target, newTaskPageProof: { snapshotComplete: true, verified: false, selectedNewTaskTabCount: 0,
      selectedConversationTabMatches: 0, conversationHeaderMatches: 0, visibleWelcomeMarkerMatches: 0,
      composerDocumentWelcomeMarkerMatches: 0, composerDocumentRegionHash: '' },
    processContext: { sameWindowsSession: true, sameBitness: true, sameIntegrityLevel: true },
    uiaCom: { traversalTruncated: false, errorType: null, errorStage: '', composerBindingSucceeded: false,
      composerModelCandidates: 0, composerSendCandidates: 0 } });
    const fingerprint = draft ? require('node:crypto').createHash('sha256').update(draft.trim()).digest('hex').slice(0, 16) : 'e3b0c44298fc1c14';
    return modelSnapshot([
      control('model-selector', { accessibleName: 'Select model: Kimi-K3', controlType: 'ControlType.ComboBox', regionHash: 'aaaaaaaaaaaaaaaa' }),
      control('composer', { accessibleName: 'Message', enabled: true, draftState: draft ? 'non-empty' : 'empty', draftFingerprint: fingerprint,
        patterns: ['value', 'text'], regionHash: 'aaaaaaaaaaaaaaaa' }),
      control('send-label', { accessibleName: 'Send', enabled: draft.length > 0, patterns: ['invoke'], regionHash: 'aaaaaaaaaaaaaaaa' }),
      control('new-task-tab', { accessibleName: '新建任务', controlType: 'ControlType.TabItem', selected: tabSelected,
        patterns: ['selectionItem'], regionHash: 'bbbbbbbbbbbbbbbb' }),
    ], { target, newTaskPageProof, processContext: { sameWindowsSession: true, sameBitness: true, sameIntegrityLevel: true },
      uiaCom: { traversalTruncated: false, errorType: null, errorStage: '', composerBindingSucceeded: true,
        composerModelCandidates: 1, composerSendCandidates: 1 } });
  };
  adapter.nativeTitleCountStatement.get = () => ({ count: sessions.length });
  adapter.nativeTitleRowsStatement.all = (limit) => sessions.slice(0, limit);
  adapter.nativeSessionIdsStatement.all = (limit) => sessions.map((row) => ({ id: row.id })).slice(0, limit);
  adapter.readStatement.get = (id) => sessions.find((row) => row.id === id) ?? null;
  adapter.identityTitleCountStatement.get = (title) => ({ count: sessions.filter((row) => nativeIdentityTitle(row) === title).length });
  adapter.identityCandidatesStatement.all = (title, limit) => sessions.filter((row) => nativeIdentityTitle(row) === title).slice(0, limit);
  adapter.readSession = (id) => {
    const native = transcripts.get(id);
    if (!native) throw Object.assign(new Error('not persisted'), { code: 'session_gone' });
    return native;
  };
  adapter.uiAutomationInspector = {
    async discoverMainWindows() { return { inputDesktopKind: 'default', windows: [target] }; },
    async semanticSnapshot() { return snapshot(); },
    async inspectConversationIdentity(request) {
      const row = sessions.find((entry) => entry.id === '11111111-2222-4333-8444-555555555555');
      const matchedCandidateIndex = request.anchorCandidates.findIndex((anchors) =>
        anchors.length > 0 && anchors.every((anchor) => transcripts.get(row.id)?.messages.some((message) => message.text.includes(anchor))));
      return { identityProof: { conversationRowMatches: 0, conversationHeaderMatches: 1,
        candidateCount: request.anchorCandidates.length, matchedCandidateIndex } };
    },
    async navigateConversation(request) {
      actions.push({ type: 'navigate', ...request });
      return { outcome: 'confirmed', targetContextVerified: true, identityProof: { matchedCandidateIndex: request.expectedCandidateIndex } };
    },
    async executeSemanticAction(request) {
      actions.push({ type: request.action, safeActionLabel: request.safeActionLabel,
        requireNewTaskIntent: request.requireNewTaskIntent === true, expectedDraftFingerprint: request.expectedDraftFingerprint });
      if (request.action === 'select' && request.safeActionLabel === 'new-task-tab') { tabSelected = true; skillsPage = false; }
      if (request.action === 'set-value') draft = request.payload;
      if (request.action === 'invoke' && request.safeActionLabel === 'send-label') {
        if (request.requireNewTaskIntent === true) {
          const id = '22222222-3333-4444-8555-666666666666';
          const row = { id, title: 'Native QA chat', custom_title: null, cwd: 'C:\\workspace', transport: 'local', deleted_at: null };
          sessions.push(row);
          transcripts.set(id, { id, historyTruncated: false, messages: [{ role: 'user', text: draft }] });
        } else {
          const id = '11111111-2222-4333-8444-555555555555';
          const prior = transcripts.get(id);
          transcripts.set(id, { ...prior, messages: [...prior.messages, { role: 'user', text: draft }] });
        }
        draft = '';
        onSent?.();
      }
      const operation = request.action;
      return { operation, inputDesktopKind: 'default', target, targetContextVerified: true,
        processContext: { sameWindowsSession: true, sameBitness: true, sameIntegrityLevel: true },
        uiaCom: snapshot().uiaCom, controls: snapshot().controls,
        actionResult: { attempted: true, submitted: true, conversationIdentityVerified: Boolean(request.identityTitle),
          newTaskIntentVerified: request.requireNewTaskIntent === true,
          newTaskNavigationSource: request.action === 'select' && request.safeActionLabel === 'new-task-tab' ? 'skills' : '',
          targetContextVerified: true, foregroundVerified: false,
          hresult: 0, stage: 'submitted', matchingControls: 1 } };
    },
  };
  return { adapter, actions, sessions, transcripts };
}

test('same-title native sessions bind by one unique complete history candidate, not sidebar order', async () => {
  const rows = [
    { id: 'native-empty', title: '开始新的对话', custom_title: null, cwd: 'C:\\empty', transport: 'local', deleted_at: null },
    { id: 'native-one', title: '开始新的对话', custom_title: null, cwd: 'C:\\one', transport: 'local', deleted_at: null },
    { id: 'native-two', title: '开始新的对话', custom_title: null, cwd: 'C:\\two', transport: 'local', deleted_at: null },
  ];
  const histories = {
    'native-empty': [],
    'native-one': [{ role: 'user', text: 'first distinct request' }, { role: 'assistant', text: 'first native response' }],
    'native-two': [{ role: 'user', text: 'second distinct request' }, { role: 'assistant', text: 'second native response' }],
  };
  const adapter = identityAdapterFixture(rows, histories);
  let privateRequest;
  let matchedCandidateIndex = 2;
  adapter.uiAutomationInspector = { async inspectConversationIdentity(request) {
    privateRequest = request;
    return { identityProof: { conversationRowMatches: 3, conversationHeaderMatches: 1,
      candidateCount: 3, matchedCandidateIndex } };
  } };
  const target = { processId: 42, handle: '84' };
  const expected = await adapter.verifyNativeConversationIdentity('native-two', target);
  assert.equal(expected.title, '开始新的对话');
  assert.equal(expected.expectedCandidateIndex, 2);
  assert.deepEqual(privateRequest.anchorCandidates, [
    [],
    ['first distinct request', 'first native response'],
    ['second distinct request', 'second native response'],
  ]);
  matchedCandidateIndex = 1;
  await assert.rejects(adapter.verifyNativeConversationIdentity('native-two', target), /could not be uniquely matched/);
  await adapter.close();
});

test('identity binding refuses incomplete or indistinguishable same-title histories and unsafe titles', async () => {
  assert.equal(nativeIdentityTitle({ id: 'session-fallback', title: '', custom_title: null }), null);
  assert.equal(nativeIdentityTitle({ id: 'x', title: 'access_token=private', custom_title: null }), null);
  assert.deepEqual(nativeHistoryAnchors({ historyTruncated: false, messages: [] }), []);
  assert.equal(nativeHistoryAnchors({ historyTruncated: true, messages: [{ role: 'user', text: 'complete?' }] }), null);
  const rows = [
    { id: 'same-one', title: 'Untitled chat', custom_title: null, cwd: 'C:\\one', transport: 'local', deleted_at: null },
    { id: 'same-two', title: 'Untitled chat', custom_title: null, cwd: 'C:\\two', transport: 'local', deleted_at: null },
  ];
  const duplicateMessages = [{ role: 'user', text: 'same request' }, { role: 'assistant', text: 'same response' }];
  const adapter = identityAdapterFixture(rows, { 'same-one': duplicateMessages, 'same-two': duplicateMessages });
  adapter.uiAutomationInspector = { async inspectConversationIdentity() {
    return { identityProof: { conversationRowMatches: 2, conversationHeaderMatches: 1,
      candidateCount: 2, matchedCandidateIndex: -1 } };
  } };
  // The candidate lookup remains pure; the helper must report -1 for identical
  // histories, and the binding method rejects that ambiguous result.
  await assert.rejects(adapter.verifyNativeConversationIdentity('same-one', { processId: 42, handle: '84' }),
    /could not be uniquely matched/);
  await adapter.close();
});

test('native cancellation notices do not prevent binding the original conversation after Stop', () => {
  const messages = [{ role: 'user', text: 'First request' }, { role: 'assistant', text: 'Actual response' },
    { role: 'user', text: 'Next request' }, { role: 'assistant', text: 'Interrupted by user' }];
  assert.deepEqual(nativeHistoryAnchors({ messages }), ['Actual response', 'Next request']);
  messages.at(-1).text = '[User Cancelled]';
  assert.deepEqual(nativeHistoryAnchors({ messages }), ['Actual response', 'Next request']);
  assert.deepEqual(nativeHistoryAnchors({ messages: [{ role: 'user', text: 'Interrupted by user' }] }), ['Interrupted by user']);
});

test('create sends one first message from a selected empty New Task page and reports only its persisted native UUID', async () => {
  const { adapter, actions } = adapterWithNativeWriter();
  const callbacks = [];
  let hookChecks = 0;
  const result = await adapter.createSession({ model: 'Kimi-K3', text: '只回复 WORKBUDDY-PARITY-OK' }, {
    onCreated(value) {
      assert.equal(adapter.nativeWriter.inFlight, 0);
      callbacks.push(value);
    },
  }, { checkActive() { hookChecks += 1; }, remainingBudgetMs() { return 30000; } });
  assert.equal(adapter.canCreate(), true);
  assert.equal(result.sessionId, '22222222-3333-4444-8555-666666666666');
  assert.equal(result.title, 'Native QA chat');
  assert.deepEqual(callbacks, [{ sessionId: result.sessionId }]);
  assert.deepEqual(actions.map((entry) => entry.type), ['set-value', 'invoke']);
  assert.equal(actions[0].requireNewTaskIntent, true);
  assert.equal(actions[1].requireNewTaskIntent, true);
  assert.ok(hookChecks >= 4);
  await adapter.close();
});

test('create does not confirm or announce a persisted chat after its RPC expires following native Send', async () => {
  let expired = false;
  const { adapter, actions, sessions, transcripts } = adapterWithNativeWriter({ onSent() { expired = true; } });
  const callbacks = [];
  await assert.rejects(adapter.createSession({ model: 'Kimi-K3', text: 'first message' }, {
    onCreated(value) { callbacks.push(value); },
  }, {
    checkActive() {
      if (expired) throw Object.assign(new Error('request expired'), { code: 'bridge_timeout' });
    },
    remainingBudgetMs() { return 30000; },
  }), (error) => error.code === 'bridge_timeout');
  assert.deepEqual(actions.map((entry) => entry.type), ['set-value', 'invoke']);
  assert.equal(sessions.some((row) => row.id === '22222222-3333-4444-8555-666666666666'), true);
  assert.deepEqual(transcripts.get('22222222-3333-4444-8555-666666666666').messages,
    [{ role: 'user', text: 'first message' }]);
  assert.deepEqual(callbacks, []);
  await adapter.close();
});

test('create refuses an empty composer when UIA does not prove the blank New Task page region', async () => {
  const { adapter, actions } = adapterWithNativeWriter({ newTaskPageProof: {
    snapshotComplete: true, verified: false, selectedNewTaskTabCount: 1, selectedConversationTabMatches: 1,
    conversationHeaderMatches: 0, visibleWelcomeMarkerMatches: 1, composerDocumentWelcomeMarkerMatches: 1,
    composerDocumentRegionHash: '1122334455667788',
  } });
  await assert.rejects(adapter.createSession({ model: 'Kimi-K3', text: 'first message' }),
    (error) => error.code === 'not_capable');
  assert.deepEqual(actions, []);
  await adapter.close();
});

test('create refuses unsupported project/model choices before any native write', async () => {
  const { adapter, actions } = adapterWithNativeWriter();
  await assert.rejects(adapter.createSession({ model: 'Deepseek-V4.1-Flash', text: 'first message' }),
    (error) => error.code === 'model_not_available');
  await assert.rejects(adapter.createSession({ model: 'Kimi-K3', text: 'first message', cwd: 'C:\\unlisted' }),
    (error) => error.code === 'not_capable');
  assert.deepEqual(actions, []);
  await adapter.close();
});

test('create from the global Skills page selects New Task without treating its search Edit as an empty composer', async () => {
  const { adapter, actions } = adapterWithNativeWriter({ newTaskSelected: false, startOnSkillsPage: true });
  const callbacks = [];
  const result = await adapter.createSession({ model: 'Kimi-K3', text: 'first message from Skills' }, {
    onCreated(value) { callbacks.push(value); },
  });
  assert.equal(result.sessionId, '22222222-3333-4444-8555-666666666666');
  assert.deepEqual(actions.map((entry) => entry.type), ['select', 'set-value', 'invoke']);
  assert.equal(actions[0].safeActionLabel, 'new-task-tab');
  assert.equal(actions[0].requireNewTaskIntent, false);
  assert.equal(actions[1].requireNewTaskIntent, true);
  assert.deepEqual(callbacks, [{ sessionId: result.sessionId }]);
  await adapter.close();
});

test('models.list navigates from a verified Skills page to read the native New Task model selector', async () => {
  const { adapter, actions } = adapterWithNativeWriter({ newTaskSelected: false, startOnSkillsPage: true });
  adapter.uiAutomationInspector.readNativeModelCatalog = async () => ({ outcome: 'confirmed', targetContextVerified: true,
    catalog: { targetContextVerified: true, composerVerified: true, currentModel: 'Kimi-K3',
      models: ['Kimi-K3', 'Deepseek-V4.1-Flash'], initialDraftFingerprint: 'e3b0c44298fc1c14',
      finalDraftFingerprint: 'e3b0c44298fc1c14' } });
  const listed = await adapter.listModels();
  assert.equal(listed.currentModel, 'Kimi-K3');
  assert.equal(listed.models.length, 2);
  assert.equal(actions.length, 1);
  assert.equal(actions[0].type, 'select');
  assert.equal(actions[0].safeActionLabel, 'new-task-tab');
  await adapter.close();
});

test('send routes by native UUID and complete history, then invokes one exact native Send action', async () => {
  const id = '11111111-2222-4333-8444-555555555555';
  const row = { id, title: 'Stable native chat', custom_title: null, cwd: 'C:\\chat', transport: 'local', deleted_at: null };
  const { adapter, actions } = adapterWithNativeWriter({ rows: [row], histories: {
    [id]: { id, historyTruncated: false, messages: [
      { role: 'user', text: 'first unique message' }, { role: 'assistant', text: 'native reply' },
    ] },
  } });
  const result = await adapter.sendMessage(id, 'continue this exact chat');
  assert.deepEqual(result, { accepted: true, sessionId: id });
  assert.equal(actions[0].type, 'navigate');
  assert.equal(actions[0].sessionId, id);
  assert.equal(actions[0].expectedCandidateIndex, 0);
  assert.deepEqual(actions.slice(1).map((entry) => entry.type), ['set-value', 'invoke']);
  assert.equal(actions[1].requireNewTaskIntent, false);
  assert.equal(actions[2].requireNewTaskIntent, false);
  await adapter.close();
});

test('capabilities expose only model listing and the reviewed New Task/send paths', async () => {
  const { adapter } = adapterWithModelUi();
  assert.equal(adapter.canModelsList(), true);
  assert.equal(adapter.canCreate(), true);
  assert.equal(adapter.canSend(), true);
  assert.equal(adapter.canSendWithModel(), false);
  assert.equal(adapter.canStop(), false);
  assert.equal(adapter.canAnswer(), false);
  assert.equal(adapter.canApprove(), false);
  assert.equal(adapter.describe().uiAutomation.needsUnlockedDesktop, true);
  await adapter.close();
});
