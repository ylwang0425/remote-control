'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildSessionReadResult } = require('../src/protocol');
const { analyzeNativeHistory } = require('../src/workbuddy-native/history-state');
const {
  WorkBuddyUiaPendingController,
  WorkBuddyUiaPendingControllerError,
  fingerprintHistoryAnalysis,
} = require('../src/workbuddy-native/uia-pending-controller');

const SESSION_ID = 'wb-session-001';
const CWD = 'D:\\work\\remote-control';
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function history(records, sessionId = SESSION_ID, cwd = CWD) {
  return analyzeNativeHistory(records, { sessionId, cwd, historyTruncated: false });
}

function questionRecord({ callId = 'native-question-call', questions, recordId = 'event-question' } = {}) {
  return {
    id: recordId,
    type: 'function_call',
    callId,
    name: 'AskUserQuestion',
    arguments: { questions: questions || [{
      question: 'Choose a color',
      header: 'Color',
      options: [{ label: 'Blue' }, { label: 'Green' }],
    }] },
  };
}

function commandRecord({ callId = 'native-command-call', command = 'git status --short', recordId = 'event-command' } = {}) {
  return {
    id: recordId,
    type: 'function_call',
    callId,
    name: 'Bash',
    arguments: { command },
  };
}

function control({ name, hash, type = 'ControlType.Button', enabled = true, patterns = ['invoke'] } = {}) {
  return {
    controlType: type,
    accessibleName: name ?? null,
    enabled,
    patterns,
    pathHash: hash,
    runtimeIdHash: type === 'ControlType.Text' ? null : hash,
    regionHash: 'a1a1a1a1a1a1a1a1',
    passwordProtected: false,
  };
}

function questionForm(overrides = {}) {
  const text = control({ type: 'ControlType.Text', name: null, hash: '1111111111111111', patterns: ['text'] });
  return {
    kind: 'question',
    complete: true,
    desktopGuide: false,
    conversationRegionHash: 'a1a1a1a1a1a1a1a1',
    scopePathHash: 'b2b2b2b2b2b2b2b2',
    visibleText: 'Color\nChoose a color\nBlue\nGreen',
    commandText: null,
    pageIndex: null,
    pageCount: null,
    questionIndexSource: 'unavailable',
    selectedCount: null,
    selectedCountSource: 'unavailable',
    controls: [
      text,
      control({ name: 'Blue', hash: '2222222222222222' }),
      control({ name: 'Green', hash: '3333333333333333' }),
      control({ name: 'Send', hash: '4444444444444444' }),
    ],
    ...overrides,
  };
}

function questionPageForm({ question, header, options, index, count, selectedCount = -1 } = {}) {
  const labels = options.map((option) => typeof option === 'string' ? option : option.label);
  const controls = [control({ type: 'ControlType.Text', name: null, hash: '1111111111111111', patterns: ['text'] })];
  labels.forEach((name, offset) => controls.push(control({
    name,
    hash: (0x2222222222222222n + BigInt(offset)).toString(16),
  })));
  if (index > 0) controls.push(control({ name: 'Previous question', hash: '3333333333333333' }));
  if (index < count - 1) controls.push(control({ name: 'Next question', hash: '4444444444444444' }));
  else controls.push(control({ name: 'Send', hash: '5555555555555555' }));
  const visibleText = [
    header,
    question,
    ...options.flatMap((option) => typeof option === 'string'
      ? [option]
      : [option.label, ...(option.description ? [option.description] : [])]),
    `${index + 1}/${count}`,
    ...(selectedCount > 0 ? [`${selectedCount} selected`] : []),
  ].filter(Boolean).join('\n');
  return questionForm({
    visibleText,
    controls,
    pageIndex: index + 1,
    pageCount: count,
    questionIndexSource: 'native-progress',
    selectedCount: selectedCount > 0 ? selectedCount : null,
    selectedCountSource: selectedCount > 0 ? 'native-visible-count' : 'unavailable',
  });
}

function commandForm({ command = 'git status --short', buttons = ['Run', 'Reject'], overrides = {} } = {}) {
  const controls = [
    control({ type: 'ControlType.Text', name: null, hash: '5555555555555555', patterns: ['text'] }),
    ...buttons.map((name, index) => control({
      name,
      hash: (index + 6).toString(16).repeat(16).slice(0, 16),
    })),
  ];
  return {
    kind: 'command',
    complete: true,
    desktopGuide: false,
    conversationRegionHash: 'a1a1a1a1a1a1a1a1',
    scopePathHash: 'c3c3c3c3c3c3c3c3',
    visibleText: 'WorkBuddy needs permission\n' + command + '\n' + buttons.join('\n'),
    commandText: command,
    controls,
    ...overrides,
  };
}

function pendingForms(forms, overrides = {}) {
  return {
    sessionId: SESSION_ID,
    snapshotComplete: true,
    conversationIdentityVerified: true,
    reason: null,
    forms,
    ...overrides,
  };
}

function input({ analysis, forms, sequence = 1, sessionId = SESSION_ID, epoch = 7, cwd = CWD } = {}) {
  const pendingFormsValue = { ...forms };
  if (!Object.hasOwn(pendingFormsValue, 'identityProof')) {
    pendingFormsValue.identityProof = {
      sessionId,
      expectedCandidateIndex: 0,
      candidateCount: 1,
      matchedCandidateIndex: 0,
      conversationHeaderMatches: 1,
      historyFingerprint: fingerprintHistoryAnalysis(analysis),
    };
  }
  return {
    sessionId,
    epoch,
    sequence,
    cwd,
    historyAnalysis: analysis,
    pendingForms: pendingFormsValue,
  };
}

function expectCode(action, code = 'stale_request') {
  assert.throws(action, (error) => error instanceof WorkBuddyUiaPendingControllerError && error.code === code);
}

test('question projection uses a short opaque alias, and a fresh plan maps it to the locally parsed native call', () => {
  const analysis = history([questionRecord()]);
  const controller = new WorkBuddyUiaPendingController();
  const forms = pendingForms([questionForm()]);
  const projection = controller.observe(input({ analysis, forms }));

  assert.equal(projection.pendingQuestions.length, 1);
  const batch = projection.pendingQuestions[0];
  assert.match(batch.callId, UUID_V4);
  assert.notEqual(batch.callId, 'native-question-call');
  assert.deepEqual(batch.questions.map((question) => question.id), ['bridge-q-0']);
  assert.deepEqual(projection.pendingApprovals, []);
  assert.deepEqual(projection.desktopGuide, []);

  const plan = controller.prepareDecision({
    ...input({ analysis, forms, sequence: 2 }),
    alias: batch.callId,
    answers: [{ id: 'bridge-q-0', selected: ['Blue'] }],
  });
  assert.equal(plan.kind, 'question');
  assert.equal(plan.nativeCallId, 'native-question-call');
  assert.deepEqual(plan.questions, [{
    question: 'Choose a color',
    header: 'Color',
    options: [{ label: 'Blue' }, { label: 'Green' }],
  }]);
  assert.equal(Object.hasOwn(plan.questions[0], 'id'), false);
  assert.deepEqual(plan.answers, [{ questionIndex: 0, selectedLabels: ['Blue'] }]);
  assert.equal(plan.freshFormProof.sequence, 2);
  assert.equal(plan.freshFormProof.pageIndex, 1);
  assert.equal(plan.freshFormProof.pageCount, 1);
  assert.equal(plan.freshFormProof.questionIndexSource, 'single-question-derived');
  assert.equal(plan.freshFormProof.conversationRegionHash, 'a1a1a1a1a1a1a1a1');
  assert.match(plan.freshFormProof.formFingerprint, /^[a-f0-9]{64}$/);
  assert.equal(Object.isFrozen(plan), true);
  assert.equal(Object.isFrozen(plan.freshFormProof), true);
  assert.equal(JSON.stringify(projection).includes('native-question-call'), false);

  expectCode(() => controller.prepareDecision({
    ...input({ analysis, forms, sequence: 3 }),
    alias: batch.callId,
    answers: [{ id: 'bridge-q-0', selected: ['Blue'] }],
  }));
});

test('projected WorkBuddy questions and approvals satisfy the existing session.read protocol contract', () => {
  const questionAnalysis = history([questionRecord()]);
  const questionProjection = new WorkBuddyUiaPendingController().observe(input({
    analysis: questionAnalysis,
    forms: pendingForms([questionForm()]),
  }));
  const commandAnalysis = history([commandRecord()]);
  const approvalProjection = new WorkBuddyUiaPendingController().observe(input({
    analysis: commandAnalysis,
    forms: pendingForms([commandForm()]),
  }));
  const result = buildSessionReadResult({
    id: SESSION_ID,
    tool: 'workbuddy',
    title: 'WorkBuddy task',
    status: 'idle',
    messages: [],
    canStop: false,
    pendingQuestions: questionProjection.pendingQuestions,
    pendingApprovals: approvalProjection.pendingApprovals,
  });

  assert.deepEqual(result.pendingQuestions, questionProjection.pendingQuestions);
  assert.deepEqual(result.pendingApprovals, approvalProjection.pendingApprovals);
  assert.equal(Object.hasOwn(result.pendingApprovals[0], 'callId'), false);
});

test('helper plans preserve an optional source question id without inventing one when absent', () => {
  const analysis = history([questionRecord({ questions: [{
    id: 'source-question-17',
    question: 'Choose a color',
    header: 'Color',
    options: [{ label: 'Blue' }, { label: 'Green' }],
  }] })]);
  const controller = new WorkBuddyUiaPendingController();
  const forms = pendingForms([questionForm()]);
  const projection = controller.observe(input({ analysis, forms }));
  const plan = controller.prepareDecision({
    ...input({ analysis, forms, sequence: 2 }),
    alias: projection.pendingQuestions[0].callId,
    answers: [{ id: 'source-question-17', selected: ['Blue'] }],
  });
  assert.deepEqual(plan.questions, [{
    id: 'source-question-17',
    question: 'Choose a color',
    header: 'Color',
    options: [{ label: 'Blue' }, { label: 'Green' }],
  }]);
  assert.deepEqual(plan.answers, [{ questionIndex: 0, selectedLabels: ['Blue'] }]);
});

test('history alone, completed calls, incomplete identity proof, and incomplete forms never produce aliases', () => {
  const call = questionRecord();
  const analysis = history([call]);
  const completed = history([call, { id: 'event-result', type: 'function_call_result', callId: 'native-question-call', output: 'done' }]);
  const controller = new WorkBuddyUiaPendingController();

  assert.deepEqual(controller.observe(input({ analysis, forms: pendingForms([]) })).pendingQuestions, []);
  const noIdentity = controller.observe(input({
    analysis,
    forms: pendingForms([questionForm()], { conversationIdentityVerified: false }),
    sequence: 2,
  }));
  assert.deepEqual(noIdentity.pendingQuestions, []);
  assert.deepEqual(noIdentity.desktopGuide, [{ kind: 'question', message: 'Finish this request in WorkBuddy on the desktop.' }]);
  assert.deepEqual(controller.observe(input({ analysis: completed, forms: pendingForms([questionForm()]), sequence: 3 })).pendingQuestions, []);

  const partial = questionForm({ complete: false, desktopGuide: true, controls: [] });
  const guide = controller.observe(input({ analysis, forms: pendingForms([partial]), sequence: 4 }));
  assert.deepEqual(guide.pendingQuestions, []);
  assert.deepEqual(guide.desktopGuide.map((item) => item.kind), ['question']);
});

test('native identity proof must bind canonical session, exact candidate index, unique header, and exact history snapshot', () => {
  const analysis = history([questionRecord()]);
  const base = pendingForms([questionForm()]);
  const badProofs = [
    null,
    { sessionId: 'wb-session-other', expectedCandidateIndex: 0, candidateCount: 1, matchedCandidateIndex: 0,
      conversationHeaderMatches: 1, historyFingerprint: fingerprintHistoryAnalysis(analysis) },
    { sessionId: SESSION_ID, expectedCandidateIndex: 1, candidateCount: 2, matchedCandidateIndex: 0,
      conversationHeaderMatches: 1, historyFingerprint: fingerprintHistoryAnalysis(analysis) },
    { sessionId: SESSION_ID, expectedCandidateIndex: 0, candidateCount: 1, matchedCandidateIndex: 0,
      conversationHeaderMatches: 2, historyFingerprint: fingerprintHistoryAnalysis(analysis) },
    { sessionId: SESSION_ID, expectedCandidateIndex: 0, candidateCount: 1, matchedCandidateIndex: 0,
      conversationHeaderMatches: 1, historyFingerprint: '0'.repeat(64) },
  ];
  for (const [index, identityProof] of badProofs.entries()) {
    const result = new WorkBuddyUiaPendingController().observe(input({
      analysis,
      forms: { ...base, identityProof },
      sequence: index + 1,
    }));
    assert.deepEqual(result.pendingQuestions, []);
    assert.deepEqual(result.desktopGuide.map((item) => item.kind), ['question']);
  }

  const wrongCanonicalSession = new WorkBuddyUiaPendingController().observe(input({
    analysis,
    forms: { ...base, sessionId: 'wb-session-other' },
  }));
  assert.deepEqual(wrongCanonicalSession.pendingQuestions, []);
});

test('multi-page questions project the complete local call from one exact visible page and reject ambiguous mappings', () => {
  const twoQuestionRecord = questionRecord({ questions: [
    { question: 'Choose a color', options: [{ label: 'Blue' }, { label: 'Green' }] },
    { question: 'Choose a size', options: [{ label: 'Small' }, { label: 'Large' }] },
  ] });
  const analysis = history([twoQuestionRecord]);
  const controller = new WorkBuddyUiaPendingController();
  const firstPage = questionPageForm({ question: 'Choose a color', options: ['Blue', 'Green'], index: 0, count: 2 });
  const firstProjection = controller.observe(input({ analysis, forms: pendingForms([firstPage]) }));
  assert.equal(firstProjection.pendingQuestions.length, 1);
  assert.deepEqual(firstProjection.pendingQuestions[0].questions.map((item) => item.question), [
    'Choose a color', 'Choose a size',
  ]);
  assert.deepEqual(firstProjection.desktopGuide, []);
  const firstAlias = firstProjection.pendingQuestions[0].callId;
  const completeAnswerPlan = controller.prepareDecision({
    ...input({ analysis, forms: pendingForms([firstPage]), sequence: 2 }),
    alias: firstAlias,
    answers: [
      { id: 'bridge-q-1', selected: ['Small'] },
      { id: 'bridge-q-0', selected: ['Blue'] },
    ],
  });
  assert.deepEqual(completeAnswerPlan.answers, [
    { questionIndex: 0, selectedLabels: ['Blue'] },
    { questionIndex: 1, selectedLabels: ['Small'] },
  ]);
  assert.equal(completeAnswerPlan.freshFormProof.pageIndex, 1);
  assert.equal(completeAnswerPlan.freshFormProof.pageCount, 2);
  assert.equal(completeAnswerPlan.freshFormProof.questionIndexSource, 'native-progress');

  const secondPage = questionPageForm({ question: 'Choose a size', options: ['Small', 'Large'], index: 1, count: 2 });
  const secondProjection = new WorkBuddyUiaPendingController().observe(input({ analysis, forms: pendingForms([secondPage]) }));
  assert.equal(secondProjection.pendingQuestions.length, 1);

  const wrongIndex = questionPageForm({ question: 'Choose a color', options: ['Blue', 'Green'], index: 1, count: 2 });
  const mismatched = new WorkBuddyUiaPendingController().observe(input({ analysis, forms: pendingForms([wrongIndex]) }));
  assert.deepEqual(mismatched.pendingQuestions, []);
  assert.deepEqual(mismatched.desktopGuide.map((item) => item.kind), ['question']);

  const wrongCount = questionPageForm({ question: 'Choose a color', options: ['Blue', 'Green'], index: 0, count: 3 });
  const countMismatch = new WorkBuddyUiaPendingController().observe(input({ analysis, forms: pendingForms([wrongCount]) }));
  assert.deepEqual(countMismatch.pendingQuestions, []);

  const singleAnalysis = history([questionRecord()]);
  const duplicateForms = pendingForms([questionForm(), questionForm({ scopePathHash: 'd4d4d4d4d4d4d4d4' })]);
  const ambiguous = controller.observe(input({ analysis: singleAnalysis, forms: duplicateForms, sequence: 2 }));
  assert.deepEqual(ambiguous.pendingQuestions, []);
  assert.deepEqual(ambiguous.desktopGuide.map((item) => item.kind), ['question']);
});

test('a live localized Other editor enables custom text only when complete metadata does not forbid it', () => {
  const question = { question: 'Add details', options: [{ label: 'Continue' }] };
  const analysis = history([questionRecord({ questions: [question] })]);
  const form = questionPageForm({ question: 'Add details', options: ['Continue'], index: 0, count: 1 });
  const withOther = pendingForms([{
    ...form,
    controls: [...form.controls, control({
      type: 'ControlType.Edit',
      name: '其他（输入你的答案）',
      hash: '6666666666666666',
      patterns: ['value'],
    })],
  }]);
  const controller = new WorkBuddyUiaPendingController();
  const projected = controller.observe(input({ analysis, forms: withOther }));
  assert.equal(projected.pendingQuestions[0].questions[0].allowCustom, true);
  const plan = controller.prepareDecision({
    ...input({ analysis, forms: withOther, sequence: 2 }),
    alias: projected.pendingQuestions[0].callId,
    answers: [{ id: 'bridge-q-0', selected: [], custom: 'A free-form answer' }],
  });
  assert.deepEqual(plan.answers, [{ questionIndex: 0, selectedLabels: [], custom: 'A free-form answer' }]);

  const forbiddenAnalysis = history([questionRecord({ questions: [{ ...question, allowCustom: false }] })]);
  const forbidden = new WorkBuddyUiaPendingController().observe(input({ analysis: forbiddenAnalysis, forms: withOther }));
  assert.deepEqual(forbidden.pendingQuestions, []);
  assert.deepEqual(forbidden.desktopGuide.map((item) => item.kind), ['question']);

  const declaredCustomAnalysis = history([questionRecord({ questions: [{ ...question, allowCustom: true }] })]);
  const noEditor = new WorkBuddyUiaPendingController().observe(input({
    analysis: declaredCustomAnalysis,
    forms: pendingForms([form]),
  }));
  assert.equal(Object.hasOwn(noEditor.pendingQuestions[0].questions[0], 'allowCustom'), false);
});

test('multi-page aliases require native progress and selected counts must match their visible text', () => {
  const analysis = history([questionRecord({ questions: [
    { question: 'Choose a color', options: [{ label: 'Blue' }, { label: 'Green' }], multiSelect: true },
    { question: 'Choose a size', options: [{ label: 'Small' }, { label: 'Large' }] },
  ] })]);
  const contentOnly = questionForm({
    visibleText: 'Choose a color\nBlue\nGreen',
    pageIndex: null,
    pageCount: null,
    questionIndexSource: 'unavailable',
  });
  const noProgress = new WorkBuddyUiaPendingController().observe(input({
    analysis,
    forms: pendingForms([contentOnly]),
  }));
  assert.deepEqual(noProgress.pendingQuestions, []);

  const visibleCountForm = questionPageForm({
    question: 'Choose a color',
    options: ['Blue', 'Green'],
    index: 0,
    count: 2,
    selectedCount: 1,
  });
  const controller = new WorkBuddyUiaPendingController();
  const projection = controller.observe(input({ analysis, forms: pendingForms([visibleCountForm]) }));
  const plan = controller.prepareDecision({
    ...input({ analysis, forms: pendingForms([visibleCountForm]), sequence: 2 }),
    alias: projection.pendingQuestions[0].callId,
    answers: [
      { id: 'bridge-q-0', selected: ['Blue'] },
      { id: 'bridge-q-1', selected: ['Small'] },
    ],
  });
  assert.equal(plan.freshFormProof.selectedCount, 1);
  assert.equal(plan.freshFormProof.selectedCountSource, 'native-visible-count');

  const countDisagreement = {
    ...questionPageForm({
    question: 'Choose a color',
    options: ['Blue', 'Green'],
    index: 0,
    count: 2,
    selectedCount: 3,
    }),
    selectedCount: 2,
  };
  const rejected = new WorkBuddyUiaPendingController().observe(input({
    analysis,
    forms: pendingForms([countDisagreement]),
  }));
  assert.deepEqual(rejected.pendingQuestions, []);
});

test('localized WorkBuddy page fields bind one current Chinese question and options to the full local batch', () => {
  const analysis = history([questionRecord({ questions: [
    { question: '喜欢哪个颜色？', options: [{ label: '红色' }, { label: '蓝色' }], multiSelect: true },
    { question: '选择一个形状', options: [{ label: '圆形' }, { label: '方形' }] },
    { question: '选择一个大小', options: [{ label: '大' }, { label: '小' }] },
  ] })]);
  const form = {
    kind: 'question',
    complete: true,
    desktopGuide: false,
    conversationRegionHash: 'a1a1a1a1a1a1a1a1',
    scopePathHash: 'b2b2b2b2b2b2b2b2',
    visibleText: '1/3\n已选择 2 个\n喜欢哪个颜色？\n红色\n蓝色',
    commandText: null,
    pageIndex: 1,
    pageCount: 3,
    questionIndexSource: 'native-progress',
    selectedCount: 2,
    selectedCountSource: 'native-visible-count',
    controls: [
      control({ type: 'ControlType.Text', name: null, hash: '1111111111111111', patterns: ['text'] }),
      control({ name: '下一题', hash: '3333333333333333' }),
      control({ name: '红色', hash: '5555555555555555' }),
      control({ name: '蓝色', hash: '6666666666666666' }),
      control({ type: 'ControlType.Edit', name: '其他（输入你的答案）', hash: '7777777777777777', patterns: ['value'] }),
    ],
  };
  const forms = pendingForms([form]);
  const controller = new WorkBuddyUiaPendingController();
  const projection = controller.observe(input({ analysis, forms }));
  assert.equal(projection.pendingQuestions.length, 1);
  assert.deepEqual(projection.pendingQuestions[0].questions.map((item) => item.question), [
    '喜欢哪个颜色？', '选择一个形状', '选择一个大小',
  ]);
  assert.equal(projection.pendingQuestions[0].questions[0].allowCustom, true);
  const plan = controller.prepareDecision({
    ...input({ analysis, forms, sequence: 2 }),
    alias: projection.pendingQuestions[0].callId,
    answers: [
      { id: 'bridge-q-0', selected: ['红色', '蓝色'] },
      { id: 'bridge-q-1', selected: ['圆形'] },
      { id: 'bridge-q-2', selected: ['大'] },
    ],
  });
  assert.equal(plan.freshFormProof.pageIndex, 1);
  assert.equal(plan.freshFormProof.pageCount, 3);
  assert.equal(plan.freshFormProof.selectedCount, 2);
  assert.equal(plan.freshFormProof.selectedCountSource, 'native-visible-count');
  assert.deepEqual(plan.questions.map((question) => question.question), [
    '喜欢哪个颜色？', '选择一个形状', '选择一个大小',
  ]);
  assert.ok(plan.questions.every((question) => !Object.hasOwn(question, 'id')));
  assert.deepEqual(plan.answers, [
    { questionIndex: 0, selectedLabels: ['红色', '蓝色'] },
    { questionIndex: 1, selectedLabels: ['圆形'] },
    { questionIndex: 2, selectedLabels: ['大'] },
  ]);
});

test('redrawn scope or runtime invalidates the old alias and requires a new matching projection', () => {
  const analysis = history([questionRecord()]);
  const controller = new WorkBuddyUiaPendingController();
  const first = controller.observe(input({ analysis, forms: pendingForms([questionForm()]) })).pendingQuestions[0].callId;
  const redrawn = questionForm({
    controls: questionForm().controls.map((item, index) => index === 1 ? { ...item, runtimeIdHash: '9999999999999999' } : item),
  });
  const secondProjection = controller.observe(input({ analysis, forms: pendingForms([redrawn]), sequence: 2 }));
  assert.equal(secondProjection.pendingQuestions.length, 1);
  const second = secondProjection.pendingQuestions[0].callId;
  assert.match(second, UUID_V4);
  assert.notEqual(second, first);
  expectCode(() => controller.prepareDecision({
    ...input({ analysis, forms: pendingForms([redrawn]), sequence: 3 }),
    alias: first,
    answers: [{ id: 'bridge-q-0', selected: ['Blue'] }],
  }));
});

test('identical fresh polls preserve a phone answer while a gap beyond TTL expires its alias', () => {
  let now = 100;
  const analysis = history([questionRecord()]);
  const forms = pendingForms([questionForm()]);
  const controller = new WorkBuddyUiaPendingController({ now: () => now, ttlMs: 100 });
  const first = controller.observe(input({ analysis, forms })).pendingQuestions[0].callId;
  now += 50;
  const poll = controller.observe(input({ analysis, forms, sequence: 2 })).pendingQuestions[0].callId;
  assert.equal(poll, first);
  now = 249;
  const secondPoll = controller.observe(input({ analysis, forms, sequence: 3 })).pendingQuestions[0].callId;
  assert.equal(secondPoll, first);
  now = 350;
  expectCode(() => controller.prepareDecision({
    ...input({ analysis, forms, sequence: 4 }),
    alias: first,
    answers: [{ id: 'bridge-q-0', selected: ['Blue'] }],
  }));
});

test('question answer labels and question identities are checked before the one-shot plan is consumed', () => {
  const analysis = history([questionRecord()]);
  const controller = new WorkBuddyUiaPendingController();
  const forms = pendingForms([questionForm()]);
  const alias = controller.observe(input({ analysis, forms })).pendingQuestions[0].callId;
  expectCode(() => controller.prepareDecision({
    ...input({ analysis, forms, sequence: 2 }),
    alias,
    answers: [{ id: 'bridge-q-0', selected: ['Red'] }],
  }), 'invalid_params');
  const plan = controller.prepareDecision({
    ...input({ analysis, forms, sequence: 2 }),
    alias,
    answers: [{ id: 'bridge-q-0', selected: ['Green'] }],
  });
  assert.deepEqual(plan.answers, [{ questionIndex: 0, selectedLabels: ['Green'] }]);
});

test('command approval projection binds exact command and session cwd; plans expose only allow-once or reject', () => {
  const analysis = history([commandRecord()]);
  const controller = new WorkBuddyUiaPendingController();
  const forms = pendingForms([commandForm()]);
  const projection = controller.observe(input({ analysis, forms }));
  assert.equal(projection.pendingApprovals.length, 1);
  const approval = projection.pendingApprovals[0];
  assert.match(approval.id, UUID_V4);
  assert.notEqual(approval.id, 'native-command-call');
  assert.equal(Object.hasOwn(approval, 'callId'), false);
  assert.deepEqual(approval.context, { kind: 'command', command: 'git status --short', cwd: CWD });

  const plan = controller.prepareDecision({
    ...input({ analysis, forms, sequence: 2 }),
    alias: approval.id,
    decision: 'allow-once',
  });
  assert.equal(plan.kind, 'approval');
  assert.equal(plan.nativeCallId, 'native-command-call');
  assert.equal(plan.decision, 'allow-once');
  assert.equal(plan.targetControl.accessibleName, 'Run');
  assert.deepEqual(plan.context, { kind: 'command', command: 'git status --short', cwd: CWD });
  assert.equal(plan.freshFormProof.sequence, 2);
  assert.equal(JSON.stringify(projection).includes('native-command-call'), false);
});

test('unsupported full-scope labels and cwd mismatches remain desktop-guide only; native Skip is never a decision', () => {
  const analysis = history([commandRecord()]);
  const controller = new WorkBuddyUiaPendingController();
  const fullScope = commandForm({ buttons: ['Run', 'Reject', 'Always allow'] });
  const unsupported = controller.observe(input({ analysis, forms: pendingForms([fullScope]) }));
  assert.deepEqual(unsupported.pendingApprovals, []);
  assert.deepEqual(unsupported.desktopGuide.map((item) => item.kind), ['command']);

  const extraOutcome = commandForm({ buttons: ['Run', 'Reject', 'Skip'] });
  const extra = controller.observe(input({ analysis, forms: pendingForms([extraOutcome]), sequence: 2 }));
  assert.equal(extra.pendingApprovals.length, 1);
  const allowed = controller.prepareDecision({ ...input({ analysis, forms: pendingForms([extraOutcome]), sequence: 3 }),
    alias: extra.pendingApprovals[0].id, decision: 'allow-once' });
  assert.equal(allowed.targetControl.accessibleName, 'Run');

  const wrongCwd = controller.observe(input({
    analysis,
    forms: pendingForms([commandForm()]),
    sequence: 4,
    cwd: 'D:\\work\\other',
  }));
  assert.deepEqual(wrongCwd.pendingApprovals, []);
});

test('a stale approval is revoked when the fresh history or native form no longer matches', () => {
  const call = commandRecord();
  const analysis = history([call]);
  const forms = pendingForms([commandForm()]);
  const controller = new WorkBuddyUiaPendingController();
  const alias = controller.observe(input({ analysis, forms })).pendingApprovals[0].id;
  const completed = history([call, { id: 'event-result', type: 'function_call_result', callId: 'native-command-call', output: 'done' }]);
  expectCode(() => controller.prepareDecision({
    ...input({ analysis: completed, forms, sequence: 2 }),
    alias,
    decision: 'reject',
  }));
  expectCode(() => controller.prepareDecision({
    ...input({ analysis, forms, sequence: 3 }),
    alias,
    decision: 'reject',
  }));
});

test('a command plan targets the fresh reject control and is consumed exactly once', () => {
  const analysis = history([commandRecord()]);
  const controller = new WorkBuddyUiaPendingController();
  const forms = pendingForms([commandForm()]);
  const alias = controller.observe(input({ analysis, forms })).pendingApprovals[0].id;
  const plan = controller.prepareDecision({
    ...input({ analysis, forms, sequence: 2 }),
    alias,
    decision: 'reject',
  });
  assert.equal(plan.decision, 'reject');
  assert.equal(plan.targetControl.accessibleName, 'Reject');
  expectCode(() => controller.prepareDecision({
    ...input({ analysis, forms, sequence: 3 }),
    alias,
    decision: 'allow-once',
  }));
});

test('fresh sequence, exact selected session, and adapter epoch are required for one-shot consumption', () => {
  const analysis = history([questionRecord()]);
  const forms = pendingForms([questionForm()]);
  const controller = new WorkBuddyUiaPendingController();
  const alias = controller.observe(input({ analysis, forms, sequence: 1, epoch: 7 })).pendingQuestions[0].callId;
  expectCode(() => controller.prepareDecision({
    ...input({ analysis, forms, sequence: 1, epoch: 7 }),
    alias,
    answers: [{ id: 'bridge-q-0', selected: ['Blue'] }],
  }));
  const otherSessionAnalysis = history([questionRecord()], 'wb-session-002');
  expectCode(() => controller.prepareDecision({
    ...input({ analysis: otherSessionAnalysis, forms, sequence: 2, sessionId: 'wb-session-002', epoch: 7 }),
    alias,
    answers: [{ id: 'bridge-q-0', selected: ['Blue'] }],
  }));
  expectCode(() => controller.prepareDecision({
    ...input({ analysis, forms, sequence: 2, epoch: 8 }),
    alias,
    answers: [{ id: 'bridge-q-0', selected: ['Blue'] }],
  }));
});

test('malformed context and credential or truncation evidence never become actionable', () => {
  const analysis = history([commandRecord({ command: 'deploy --api-key=abcdefghijklmno' })]);
  const controller = new WorkBuddyUiaPendingController();
  const secretForm = commandForm({
    command: 'deploy --api-key=abcdefghijklmno',
    overrides: { visibleText: 'Run deploy --api-key=abcdefghijklmno Reject' },
  });
  const result = controller.observe(input({ analysis, forms: pendingForms([secretForm]) }));
  assert.deepEqual(result.pendingApprovals, []);
  assert.deepEqual(result.desktopGuide.map((item) => item.kind), ['command']);
});

test('session invalidation and controller retirement revoke aliases', () => {
  const analysis = history([questionRecord()]);
  const forms = pendingForms([questionForm()]);
  const controller = new WorkBuddyUiaPendingController();
  const alias = controller.observe(input({ analysis, forms })).pendingQuestions[0].callId;
  controller.invalidateSession(SESSION_ID);
  expectCode(() => controller.prepareDecision({
    ...input({ analysis, forms, sequence: 2 }),
    alias,
    answers: [{ id: 'bridge-q-0', selected: ['Blue'] }],
  }));

  const other = new WorkBuddyUiaPendingController();
  const anotherAlias = other.observe(input({ analysis, forms })).pendingQuestions[0].callId;
  other.retire();
  expectCode(() => other.prepareDecision({
    ...input({ analysis, forms, sequence: 2 }),
    alias: anotherAlias,
    answers: [{ id: 'bridge-q-0', selected: ['Blue'] }],
  }));
});
