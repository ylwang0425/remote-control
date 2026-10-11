// core-workbench.test.js — pure-logic tests for the mobile workbench additions
// in web/js/core.js and web/js/prefs.js.
//
// No DOM, no network: these are the functions the UI and the tests both call,
// so a mistake here is a mistake in what the phone can display or submit.
//
// Run with:  D:\env\node.exe --test mobile/tests/core-workbench.test.js
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const core = require(path.join(__dirname, '..', 'web', 'js', 'core.js'));
const prefs = require(path.join(__dirname, '..', 'web', 'js', 'prefs.js'));

// ---------------------------------------------------------------------------
// Workbench list shaping: tabs, tool filter, project filter, pins
// ---------------------------------------------------------------------------

const SESSIONS = [
  { id: 'a1', tool: 'codex', title: '重构转发层', status: 'working', updatedAt: '2026-10-08T03:57:55Z', cwd: 'D:\\w\\remote-control' },
  { id: 'b2', tool: 'dsh', title: 'Fix login redirect', status: 'idle', updatedAt: '2026-10-08T02:00:00Z', cwd: null },
  { id: 'c3', tool: 'dsh', title: '等确认的任务', status: 'idle', updatedAt: '2026-10-08T01:00:00Z', cwd: null, needsInput: true },
  { id: 'd4', tool: 'trae', title: '出错的会话', status: 'error', updatedAt: '2026-10-07T09:00:00Z', cwd: '/srv/x' },
  {
    id: 'e5', tool: 'dsh', title: '带项目的会话', status: 'stopped',
    updatedAt: '2026-10-07T08:00:00Z', projectId: 'p1', projectName: 'remote-control', cwd: 'D:\\w\\remote-control'
  }
];

test('the 任务 tab keeps exactly the working, failed and waiting sessions', () => {
  const tasks = core.tabSessions(SESSIONS, 'tasks');
  assert.deepEqual(tasks.map((s) => s.id), ['a1', 'c3', 'd4']);

  // The default tab shows everything, in the desktop's own order.
  assert.deepEqual(core.tabSessions(SESSIONS, 'chats').map((s) => s.id), ['a1', 'b2', 'c3', 'd4', 'e5']);
  // An unknown tab is not a filter: it degrades to the full list.
  assert.deepEqual(core.tabSessions(SESSIONS, 'nonsense').map((s) => s.id), ['a1', 'b2', 'c3', 'd4', 'e5']);
  assert.deepEqual(core.tabSessions(null, 'tasks'), []);
  // The input is never mutated.
  assert.equal(SESSIONS.length, 5);
});

test('needsInput comes from the desktop flag and nothing else', () => {
  assert.equal(core.sessionNeedsInput({ id: 'x', status: 'idle' }), false);
  assert.equal(core.sessionNeedsInput({ id: 'x', status: 'idle', needsInput: 'yes' }), false);
  assert.equal(core.sessionNeedsInput({ id: 'x', needsInput: true }), true);
  // A session with a question-looking title is NOT automatically a task.
  assert.equal(core.isTaskSession({ id: 'x', title: '要不要继续？', status: 'idle' }), false);
});

test('the tool chips are the tools the list really mentions', () => {
  const chips = core.toolChips(SESSIONS);
  assert.deepEqual(chips.map((c) => c.id), ['all', 'codex', 'dsh', 'trae']);
  assert.equal(chips[0].label, '全部');
  assert.equal(chips[1].label, 'Codex');
  assert.equal(chips[2].label, 'DSH');
  // An unknown tool keeps its own chip rather than becoming invisible.
  assert.equal(chips[3].label, 'trae');
  assert.deepEqual(core.toolChips(null).map((c) => c.id), ['all']);

  assert.deepEqual(core.filterByTool(SESSIONS, 'dsh').map((s) => s.id), ['b2', 'c3', 'e5']);
  assert.deepEqual(core.filterByTool(SESSIONS, 'all').map((s) => s.id), ['a1', 'b2', 'c3', 'd4', 'e5']);
  assert.deepEqual(core.filterByTool(SESSIONS, '').length, 5);
});

test('the project filter and the project sheet use real project data only', () => {
  // A real projectId wins; a session that only reports a directory still has a
  // cue, keyed by that DIRECTORY -- canonicalised, so a path that differs only
  // by separator or trailing slash is one cue instead of two.
  assert.deepEqual(core.sessionProject(SESSIONS[0]), {
    id: 'd:/w/remote-control', name: '', cwd: 'd:/w/remote-control'
  });
  assert.deepEqual(core.sessionProject(SESSIONS[4]), {
    id: 'p1', name: 'remote-control', cwd: 'D:\\w\\remote-control'
  });
  assert.equal(core.sessionProject(SESSIONS[1]), null);
  assert.equal(core.sessionProject(null), null);

  assert.deepEqual(core.listProjects(SESSIONS).map((p) => p.id), [
    'd:/w/remote-control', '/srv/x', 'p1'
  ]);
  assert.deepEqual(core.filterByProject(SESSIONS, 'p1').map((s) => s.id), ['e5']);
  assert.deepEqual(core.filterByProject(SESSIONS, '/srv/x').map((s) => s.id), ['d4']);
  // A filter saved before paths were canonicalised still selects the sessions
  // in that directory: the comparison is done on the canonical path.
  assert.deepEqual(core.filterByProject(SESSIONS, 'D:\\W\\remote-control\\').map((s) => s.id),
    ['a1', 'e5']);
  // No filter is not "a project called empty string".
  assert.equal(core.filterByProject(SESSIONS, '').length, 5);

  // Readable names: the reported name, else the tail of the path (Windows and
  // POSIX separators both work, trailing separators included).
  assert.equal(core.projectLabel({ id: 'p1', name: 'remote-control', cwd: '' }), 'remote-control');
  assert.equal(core.projectLabel({ id: 'x', name: '', cwd: 'D:\\work\\codex-workspace\\remote-control\\' }), 'remote-control');
  assert.equal(core.projectLabel({ id: 'x', name: '', cwd: '/srv/app' }), 'app');
  assert.equal(core.projectLabel(null), '');
});

// ---------------------------------------------------------------------------
// Directory identity: canonical paths and one navigation option per directory
// ---------------------------------------------------------------------------

test('a Windows path is canonicalised for equality, whatever separator or case it uses', () => {
  // The defect this exists for: the same directory listed twice because one
  // copy said `D:\w\app` and the other said `d:/w/app/`.
  const forms = [
    'D:\\w\\remote-control',
    'd:/w/remote-control',
    'D:/W/Remote-Control/',
    'd:\\w\\remote-control\\\\',
    ' D:\\w\\remote-control '
  ];
  const canonical = core.canonicalPath(forms[0]);
  assert.equal(canonical, 'd:/w/remote-control');
  forms.forEach((form) => {
    assert.equal(core.canonicalPath(form), canonical, 'these are the same directory: ' + JSON.stringify(form));
  });

  // Genuinely different directories stay different.
  assert.notEqual(core.canonicalPath('D:\\w\\app'), core.canonicalPath('D:\\w\\app2'));
  assert.notEqual(core.canonicalPath('D:\\w\\app'), core.canonicalPath('D:\\x\\app'));

  // A missing or blank path has no identity at all -- never the empty key.
  assert.equal(core.canonicalPath(null), '');
  assert.equal(core.canonicalPath(undefined), '');
  assert.equal(core.canonicalPath(''), '');
  assert.equal(core.canonicalPath('   '), '');
  // A bare drive or root keeps one separator rather than emptying out.
  assert.equal(core.canonicalPath('D:\\'), 'd:');
  assert.equal(core.canonicalPath('D:/'), 'd:');
  assert.equal(core.canonicalPath('/'), '/');
  // Inner spaces are part of the directory, never trimmed away.
  assert.equal(core.canonicalPath('C:\\Program Files'), 'c:/program files');
});

test('every project option is matched by its own id and by its canonical directory', () => {
  const option = core.projectOptions({
    projects: [{ id: 'p1', name: 'remote-control', cwd: 'D:\\W\\remote-control\\' }]
  })[0];
  assert.equal(option.id, 'p1');
  assert.equal(option.key, 'c:d:/w/remote-control');
  assert.deepEqual(Object.keys(option.matchIds).sort(), ['d:/w/remote-control', 'p1']);

  assert.deepEqual(core.projectPathKeys({ id: 'x', cwd: '' }), { x: true });
  assert.deepEqual(core.projectPathKeys({ id: '', cwd: 'D:\\a\\b' }), { 'd:/a/b': true });
  assert.deepEqual(core.projectPathKeys(null), {});

  // A catalog entry without a path still gets a stable, non-empty key.
  const noPath = core.projectOptions({ projects: [{ id: 'only-id' }] })[0];
  assert.equal(noPath.key, 'id:only-id');
  assert.equal(noPath.cwd, '');
});

test('the project sheet offers ONE option per directory, with honest tool cues', () => {
  // The catalog of the tool being looked at.
  const catalog = [
    { id: 'p1', name: 'remote-control', cwd: 'D:\\workspace\\remote-control', key: 'c:d:/workspace/remote-control', tool: 'dsh' },
    { id: 'p2', name: 'other-app', cwd: 'D:\\work\\other-app', key: 'c:d:/work/other-app', tool: 'dsh' }
  ];
  // What the session list reports: the SAME directory written the other way,
  // plus a directory no catalog knows about.
  const fromSessions = [
    { id: 'd:/workspace/remote-control', name: '', cwd: 'd:/workspace/remote-control/', tool: 'codex' },
    { id: 'D:\\loose\\dir', name: '', cwd: 'D:\\loose\\dir\\', tool: 'codex' }
  ];

  const merged = core.mergeProjectOptions(catalog, fromSessions);
  assert.equal(merged.length, 3, 'the duplicated directory must be folded into one entry');
  assert.deepEqual(merged.map((entry) => entry.id), ['p1', 'p2', 'D:\\loose\\dir']);

  // The duplicated directory keeps the CATALOG's id (that is what a create can
  // send) and now carries both tools' cues.
  assert.deepEqual(core.projectToolIds(merged[0], 'codex'), ['codex', 'dsh']);
  assert.deepEqual(core.projectToolIds(merged[1], 'codex'), ['dsh']);
  assert.deepEqual(core.projectToolIds(merged[2], 'dsh'), ['codex']);

  // A session entry with no directory and no id contributes nothing.
  assert.equal(core.mergeProjectOptions([], [{ id: '', cwd: '' }]).length, 0);
  assert.equal(core.mergeProjectOptions(null, null).length, 0);

  // Two catalog entries with the same id are one project, not two rows.
  assert.equal(core.mergeProjectOptions(
    [{ id: 'p1', cwd: 'D:\\a' }, { id: 'p1', cwd: 'D:\\b' }], []
  ).length, 1);
});

test('a project option is recognised by either identity, and never as "no filter"', () => {
  const entry = core.mergeProjectOptions(
    [{ id: 'p1', name: 'app', cwd: 'D:\\w\\app', key: 'c:d:/w/app', tool: 'dsh' }], []
  )[0];
  assert.equal(core.projectOptionMatches(entry, 'p1'), true);
  assert.equal(core.projectOptionMatches(entry, 'D:/W/App/'), true);
  assert.equal(core.projectOptionMatches(entry, ''), false);
  assert.equal(core.projectOptionMatches(entry, 'p9'), false);
  assert.equal(core.projectOptionMatches(null, 'p1'), false);

  // An entry that only knows a directory is matched by that directory.
  const loose = core.mergeProjectOptions([], [{ id: 'D:\\loose\\dir', cwd: 'D:\\loose\\dir', tool: 'codex' }])[0];
  assert.equal(core.projectOptionMatches(loose, 'd:/loose/dir'), true);
  assert.equal(core.projectOptionMatches(loose, 'D:\\loose\\dir'), true);
  assert.equal(core.projectOptionMatches(loose, ''), false);
});

test('the tool display names are product names, and an unknown tool keeps its own id', () => {
  assert.equal(core.toolLabel('codex'), 'Codex');
  assert.equal(core.toolLabel('dsh'), 'DSH');
  assert.equal(core.toolLabel('workbuddy'), 'WorkBuddy');
  // A tool the phone does not know keeps its own id instead of borrowing a label.
  assert.equal(core.toolLabel('trae'), 'trae');
  assert.equal(core.toolLabel(''), '');
  assert.equal(core.toolLabel(null), '');
  assert.deepEqual(core.toolChips([{ id: 'x', tool: 'trae' }]), [
    { id: 'all', label: '全部' }, { id: 'trae', label: 'trae' }
  ]);
  // The search index accepts the name the user can SEE, not only the wire id.
  assert.equal(core.filterSessions([{ id: 'z', tool: 'codex', title: 'x' }], 'Codex').length, 1);
  assert.equal(core.filterSessions([{ id: 'z', tool: 'dsh', title: 'x' }], 'dsh').length, 1);
});

test('pins move a session to the front without reordering anything else', () => {
  const ordered = core.withPinsFirst(SESSIONS, { c3: true, e5: true });
  assert.deepEqual(ordered.map((s) => s.id), ['c3', 'e5', 'a1', 'b2', 'd4']);
  // A pin for a session that is gone changes nothing.
  assert.deepEqual(core.withPinsFirst(SESSIONS, { zz: true }).map((s) => s.id),
    ['a1', 'b2', 'c3', 'd4', 'e5']);
  assert.equal(core.withPinsFirst(SESSIONS, null).length, 5);

  const on = core.togglePin({}, 'a1');
  assert.deepEqual(on.next, { a1: true });
  assert.equal(on.pinned, true);
  const off = core.togglePin(on.next, 'a1');
  assert.deepEqual(off.next, {});
  assert.equal(off.pinned, false);
  // Junk in the map is dropped, and the input map is not mutated.
  const original = { b2: true, bad: 'yes' };
  const cleaned = core.togglePin(original, 'a1');
  assert.deepEqual(cleaned.next, { b2: true, a1: true });
  assert.deepEqual(original, { b2: true, bad: 'yes' });
});

test('the task summary counts what the desktop actually reported', () => {
  const counts = core.countTasks(SESSIONS);
  assert.deepEqual(counts, { needsInput: 1, working: 1, error: 1 });
  assert.equal(core.taskSummary(SESSIONS), '待你确认 1 · 运行中 1 · 出错 1');
  assert.equal(core.taskSummary([]), '');
  assert.equal(core.taskSummary([{ id: 'x', status: 'idle' }]), '');
  assert.equal(core.tabLabel('settings'), '设置');
  assert.equal(core.tabLabel('nope'), '会话');
});

// ---------------------------------------------------------------------------
// params builders: the additive wire shapes
// ---------------------------------------------------------------------------

test('session.send without a chosen model is byte-for-byte the old body', () => {
  assert.deepEqual(
    core.sessionSendBody({ tool: 'codex', sessionId: 'a1', text: '你好', mode: 'inherit' }),
    { method: 'session.send', params: { tool: 'codex', sessionId: 'a1', text: '你好' } }
  );
  // mode omitted entirely behaves the same way (an older caller).
  assert.deepEqual(
    core.sessionSendBody({ tool: 'dsh', sessionId: 'b2', text: 'hi' }).params,
    { tool: 'dsh', sessionId: 'b2', text: 'hi' }
  );
});

test('a chosen model travels with its provider and effort, and only for the next message', () => {
  const options = core.modelOptions({ models: [
    { id: 'deepseek-flash', label: 'flash', provider: 'deepseek-official',
      reasoningEfforts: ['low', 'high'], defaultReasoningEffort: 'high' },
    { id: 'deepseek-flash', label: 'flash', provider: 'deepseek-account' }
  ] });
  const second = core.modelOptionByKey(options, core.modelOptionKey(options[1]));

  assert.deepEqual(core.sendModelOverride({
    mode: 'select', tool: 'dsh', option: second, reasoningEffort: 'high'
  }), { model: 'deepseek-flash', provider: 'deepseek-account', reasoningEffort: 'high' });

  assert.deepEqual(core.sessionSendBody({
    tool: 'dsh', sessionId: 'b2', text: '继续',
    mode: 'select', option: second, reasoningEffort: 'high'
  }), {
    method: 'session.send',
    params: {
      tool: 'dsh', sessionId: 'b2',
      model: 'deepseek-flash', provider: 'deepseek-account', reasoningEffort: 'high',
      text: '继续'
    }
  });

  // Codex forbids a provider, so a Codex choice never grows one.
  const codex = core.modelOptions({ models: [{ id: 'gpt-5-codex', label: 'GPT-5 Codex' }] })[0];
  assert.deepEqual(core.sendModelOverride({ mode: 'select', tool: 'codex', option: codex }),
    { model: 'gpt-5-codex' });

  // Nothing chosen, or an unusable option: no override at all.
  assert.deepEqual(core.sendModelOverride({ mode: 'select', tool: 'dsh', option: null }), {});
  assert.deepEqual(core.sendModelOverride({ mode: 'inherit', tool: 'dsh', option: codex }), {});
  assert.deepEqual(core.sendModelOverride(null), {});
});

test('the model id leads the label and the native description follows it', () => {
  // The real Codex catalog puts a vague English sentence in `label`. The phone
  // truncates, so a label that starts with the sentence hides the one thing the
  // user is choosing: the model id.
  const codex = core.modelOptions({ models: [
    { id: 'gpt-5-codex-mini', label: 'Fast and affordable model for easier tasks.' }
  ] })[0];
  const label = core.modelOptionLabel(codex);
  assert.ok(label.startsWith('gpt-5-codex-mini'),
    'the model id must be the first thing on the row: ' + label);
  assert.ok(label.includes('Fast and affordable'), 'the native description is not dropped: ' + label);
  assert.equal(core.modelOptionDescription(codex), 'Fast and affordable model for easier tasks.');
  // The description is help text, so it must not be mistaken for a name.
  assert.notEqual(core.modelOptionDescription(codex), codex.id);

  // DSH: id first, then the label, then the provider that disambiguates it.
  const dsh = core.modelOptions({ models: [
    { id: 'deepseek-flash', label: 'flash', provider: 'deepseek-account' }
  ] })[0];
  assert.equal(core.modelOptionLabel(dsh), 'deepseek-flash · flash · deepseek-account');

  // No invented parts: an entry with no label keeps just its id, and a label
  // that merely repeats the id is not printed twice (nor offered as help).
  const bare = core.modelOptions({ models: [{ id: 'gpt-5' }] })[0];
  assert.equal(core.modelOptionLabel(bare), 'gpt-5');
  assert.equal(core.modelOptionDescription(bare), '');
  const same = core.modelOptions({ models: [{ id: 'gpt-5', label: 'gpt-5' }] })[0];
  assert.equal(core.modelOptionLabel(same), 'gpt-5');
  assert.equal(core.modelOptionDescription(same), '');
  // A provider alone still disambiguates two entries with the same id.
  const two = core.modelOptions({ models: [
    { id: 'm', provider: 'p1' }, { id: 'm', provider: 'p2' }
  ] });
  assert.equal(core.modelOptionLabel(two[0]), 'm · p1');
  assert.equal(core.modelOptionLabel(two[1]), 'm · p2');
  assert.equal(core.modelOptionDescription(null), '');
  assert.equal(core.modelOptionLabel(null), '');
});

test('session.answer and session.approve carry exactly the whitelisted fields', () => {
  assert.deepEqual(core.sessionAnswerBody({
    tool: 'dsh', sessionId: 'b2', callId: 'call-1',
    answers: [
      { id: 'q1', selected: ['重试'], extra: 'dropped' },
      { id: 'q2', selected: [], custom: '按我的想法来' },
      { id: '', selected: ['x'] },
      null
    ]
  }), {
    method: 'session.answer',
    params: {
      tool: 'dsh', sessionId: 'b2', callId: 'call-1',
      answers: [
        { id: 'q1', selected: ['重试'] },
        { id: 'q2', selected: [], custom: '按我的想法来' }
      ]
    }
  });
  // No answers at all is still the documented shape, never a crash.
  assert.deepEqual(core.sessionAnswerBody({ tool: 'dsh', sessionId: 'b2', callId: 'c' }).params.answers, []);

  assert.deepEqual(core.sessionApproveBody({
    tool: 'dsh', sessionId: 'b2', approvalId: 'ev-1', decision: 'allow-once', junk: 1
  }), {
    method: 'session.approve',
    params: { tool: 'dsh', sessionId: 'b2', approvalId: 'ev-1', decision: 'allow-once' }
  });
  assert.equal(core.approvalDecisionLabel('allow-once'), '仅允许本次');
  assert.equal(core.approvalDecisionLabel('reject'), '拒绝');
  // No allow-always and no permissive default.
  assert.equal(core.approvalDecisionLabel('allow-always'), '');
  assert.equal(core.approvalDecisionLabel(''), '');
});

// ---------------------------------------------------------------------------
// pending questions: labels, cardinality and the honest caps
// ---------------------------------------------------------------------------

const CAPS_DSH = { 'session.answer:dsh': true, 'session.approve:dsh': true };
const CAPS_CODEX = { 'session.answer:codex': false, 'session.approve:codex': false };

function openBatch() {
  return {
    callId: 'call-42',
    state: 'open',
    questions: [
      {
        id: 'q1', question: '要重试吗？', header: '构建失败', detail: '第 3 步超时',
        options: [{ label: '重试', description: '再跑一次' }, { label: '跳过' }]
      },
      {
        id: 'q2', question: '选哪些文件？', multiSelect: true,
        options: [{ label: 'a.js' }, { label: 'b.js' }, { label: 'c.js' }]
      }
    ]
  };
}

test('pending questions are projected verbatim, with their own labels', () => {
  const input = { capabilities: CAPS_DSH, tool: 'dsh', read: { pendingQuestions: [openBatch()] } };
  assert.equal(core.pendingQuestionsState(input), 'ready');
  const batches = core.pendingQuestionsOf(input);
  assert.equal(batches.length, 1);
  assert.equal(batches[0].callId, 'call-42');
  assert.equal(batches[0].state, 'open');
  assert.deepEqual(batches[0].questions[0].options.map((o) => o.label), ['重试', '跳过']);
  assert.equal(batches[0].questions[0].header, '构建失败');
  assert.equal(batches[0].questions[1].multiSelect, true);
  assert.equal(core.readNeedsInput(input), true);

  // Nothing pending is reported as nothing pending, not as an empty form.
  assert.equal(core.pendingQuestionsState({ capabilities: CAPS_DSH, tool: 'dsh', read: {} }), 'none');
  assert.equal(core.readNeedsInput({ capabilities: CAPS_DSH, tool: 'dsh', read: {} }), false);
});

test('a tool without the answer capability is unsupported, not answerable', () => {
  const input = { capabilities: CAPS_CODEX, tool: 'codex', read: { pendingQuestions: [openBatch()] } };
  // The batch is really there, so the UI must show it -- but as information.
  assert.equal(core.pendingQuestionsState(input), 'unsupported');
  assert.deepEqual(core.pendingQuestionsOf(input), []);
  // A missing capability is false (protocol-v1 9.5), so it is unsupported too.
  assert.equal(core.pendingQuestionsState({ capabilities: {}, tool: 'codex', read: { pendingQuestions: [openBatch()] } }), 'unsupported');
});

test('no pending question is "none", whatever the tool can do', () => {
  // The bug this covers: a Codex read (session.answer:codex === false) with NO
  // pendingQuestions was reported as 'unsupported', and the UI then painted
  // "AI 在等你回答" plus an "answer on the computer" notice for a session that
  // was waiting for nothing. Absence of a question is about the DESKTOP; the
  // capability is about us, and it must never manufacture a waiting state.
  const noQuestion = [
    { capabilities: CAPS_CODEX, tool: 'codex', read: { pendingQuestions: [] } },
    { capabilities: CAPS_CODEX, tool: 'codex', read: {} },
    { capabilities: {}, tool: 'codex', read: {} },
    { capabilities: {}, tool: 'codex', read: { pendingQuestions: [] } }
  ];
  noQuestion.forEach((input) => {
    assert.equal(core.pendingQuestionsState(input), 'none', JSON.stringify(input));
    assert.deepEqual(core.pendingQuestionsOf(input), []);
    assert.equal(core.readNeedsInput(input), false);
  });

  // ...while a genuine form under the same false capability stays 'unsupported',
  // so the "answer on the computer" guidance is still available for a real one.
  assert.equal(core.pendingQuestionsState({
    capabilities: CAPS_CODEX, tool: 'codex', read: { pendingQuestions: [openBatch()] }
  }), 'unsupported');
});

test('an oversized native form is refused rather than trimmed', () => {
  const tooManyBatches = [];
  for (let i = 0; i < core.Q_LIMITS.batches + 1; i++) {
    tooManyBatches.push({ callId: 'c' + i, state: 'open', questions: [{ id: 'q', question: 'x' }] });
  }
  assert.equal(core.pendingQuestionsState({ capabilities: CAPS_DSH, tool: 'dsh', read: { pendingQuestions: tooManyBatches } }), 'oversized');

  const tooManyQuestions = [{
    callId: 'c', state: 'open',
    questions: Array.from({ length: core.Q_LIMITS.questions + 1 }, (_, i) => ({ id: 'q' + i, question: 'x' }))
  }];
  assert.equal(core.pendingQuestionsState({ capabilities: CAPS_DSH, tool: 'dsh', read: { pendingQuestions: tooManyQuestions } }), 'oversized');

  const tooManyOptions = [{
    callId: 'c', state: 'open',
    questions: [{
      id: 'q', question: 'x',
      options: Array.from({ length: core.Q_LIMITS.options + 1 }, (_, i) => ({ label: 'o' + i }))
    }]
  }];
  assert.equal(core.pendingQuestionsState({ capabilities: CAPS_DSH, tool: 'dsh', read: { pendingQuestions: tooManyOptions } }), 'oversized');

  // A batch with no usable question cannot be answered, so it is refused.
  assert.equal(core.pendingQuestionsState({
    capabilities: CAPS_DSH, tool: 'dsh', read: { pendingQuestions: [{ callId: 'c', state: 'open', questions: [] }] }
  }), 'oversized');
  assert.match(core.QUESTIONS_OVERSIZED_TEXT, /电脑上回答/);
});

test('display text is sanitised and bounded; identity strings keep their exact value', () => {
  // Control characters cannot forge a row, and whitespace is collapsed.
  assert.equal(core.clampText('a\u0000b\u001fc\n\nd', 100), 'a b c d');
  assert.equal(core.clampText('  前后有空格  ', 100), '前后有空格');
  // Unicode survives, and the cap counts characters not UTF-16 code units: a
  // cut in the middle of an emoji would produce a broken glyph on the phone.
  assert.equal(core.clampText('中文🙂abc', 4), '中文🙂a');
  assert.equal(core.clampText('中文🙂abc', 3), '中文🙂');
  assert.equal(core.clampText('🙂🙂🙂', 2), '🙂🙂');
  assert.equal(core.clampText('\u007f', 10), '');

  const long = 'x'.repeat(core.Q_LIMITS.question + 50);
  const batches = core.pendingQuestionsOf({
    capabilities: CAPS_DSH, tool: 'dsh',
    read: { pendingQuestions: [{ callId: 'c', state: 'open', questions: [{ id: 'q', question: long }] }] }
  });
  assert.equal(batches[0].questions[0].question.length, core.Q_LIMITS.question);
});

// ---------------------------------------------------------------------------
// validateAnswers: the last check before a live native form is touched
// ---------------------------------------------------------------------------

const BATCH = core.pendingQuestionsOf({
  capabilities: CAPS_DSH, tool: 'dsh', read: { pendingQuestions: [openBatch()] }
});

test('a single-select question takes exactly one real option, or custom text', () => {
  assert.deepEqual(core.validateAnswers(BATCH, 'call-42', [{ id: 'q1', selected: ['重试'] }, { id: 'q2', selected: ['a.js'] }]),
    [{ id: 'q1', selected: ['重试'] }, { id: 'q2', selected: ['a.js'] }]);

  // custom text instead of an option is fine
  assert.deepEqual(core.validateAnswers(BATCH, 'call-42', [
    { id: 'q1', selected: [], custom: '换个做法' }, { id: 'q2', selected: ['b.js', 'c.js'] }
  ]), [
    { id: 'q1', selected: [], custom: '换个做法' }, { id: 'q2', selected: ['b.js', 'c.js'] }
  ]);

  // an option that is no longer offered is dropped, and then the question has
  // no answer left -> refuse the whole batch
  assert.equal(core.validateAnswers(BATCH, 'call-42', [
    { id: 'q1', selected: ['不存在'] }, { id: 'q2', selected: ['a.js'] }
  ]), null);
  // single-select cannot take two
  assert.equal(core.validateAnswers(BATCH, 'call-42', [
    { id: 'q1', selected: ['重试', '跳过'] }, { id: 'q2', selected: ['a.js'] }
  ]), null);
  // single-select cannot take an option AND custom text
  assert.equal(core.validateAnswers(BATCH, 'call-42', [
    { id: 'q1', selected: ['重试'], custom: '还是别的' }, { id: 'q2', selected: ['a.js'] }
  ]), null);
  // every question must be answered
  assert.equal(core.validateAnswers(BATCH, 'call-42', [{ id: 'q1', selected: ['重试'] }]), null);
  // a stale callId answers nothing
  assert.equal(core.validateAnswers(BATCH, 'call-gone', [{ id: 'q1', selected: ['重试'] }]), null);
  // duplicates in a multi-select collapse to one label
  assert.deepEqual(core.validateAnswers(BATCH, 'call-42', [
    { id: 'q1', selected: ['重试'] }, { id: 'q2', selected: ['a.js', 'a.js', 'b.js'] }
  ])[1].selected, ['a.js', 'b.js']);
});

test('a free-form question can only be answered with text', () => {
  const free = core.pendingQuestionsOf({
    capabilities: CAPS_DSH, tool: 'dsh',
    read: { pendingQuestions: [{ callId: 'c9', state: 'continued', questions: [{ id: 'q', question: '补充说明？' }] }] }
  });
  assert.equal(core.validateAnswers(free, 'c9', [{ id: 'q', selected: [] }]), null);
  assert.equal(core.validateAnswers(free, 'c9', [{ id: 'q', selected: ['x'] }]), null);
  assert.deepEqual(core.validateAnswers(free, 'c9', [{ id: 'q', selected: [], custom: '就这样' }]),
    [{ id: 'q', selected: [], custom: '就这样' }]);
});

// ---------------------------------------------------------------------------
// pending permission approvals
// ---------------------------------------------------------------------------

test('pending approvals keep their real ids, tool names and reasons', () => {
  const id = '3f1a6f4e-2b0c-4d5e-8a91-0c2b7d6e5f40';
  const input = {
    capabilities: CAPS_DSH, tool: 'dsh',
    read: { pendingApprovals: [{ id: id, toolName: 'shell', callId: 'call-7', reason: '想运行 npm test' }] }
  };
  const approvals = core.pendingApprovalsOf(input);
  assert.equal(approvals.length, 1);
  assert.equal(approvals[0].id, id);
  assert.equal(approvals[0].toolName, 'shell');
  assert.equal(approvals[0].reason, '想运行 npm test');
  assert.equal(core.readNeedsInput(input), true);

  // No capability -> no approve button, and the read is not "needs input" from
  // an approvals point of view.
  assert.deepEqual(core.pendingApprovalsOf({ capabilities: CAPS_CODEX, tool: 'codex', read: input.read }), []);
  // An entry with no id can never be submitted, so it is not rendered.
  assert.deepEqual(core.pendingApprovalsOf({
    capabilities: CAPS_DSH, tool: 'dsh', read: { pendingApprovals: [{ toolName: 'shell' }] }
  }), []);
  // More live requests than the contract can represent: show none of them
  // rather than an incomplete set of buttons.
  const many = Array.from({ length: core.Q_LIMITS.approvals + 1 }, (_, i) => ({ id: 'id-' + i, toolName: 'shell' }));
  assert.deepEqual(core.pendingApprovalsOf({ capabilities: CAPS_DSH, tool: 'dsh', read: { pendingApprovals: many } }), []);
});

// ---------------------------------------------------------------------------
// native current model
// ---------------------------------------------------------------------------

test('the native current model is read from the desktop, never from the picker', () => {
  assert.deepEqual(core.currentModelOf({ currentModel: { model: 'deepseek-flash', provider: 'p', reasoningEffort: 'high' } }),
    { model: 'deepseek-flash', provider: 'p', reasoningEffort: 'high' });
  // Codex omits it entirely -> no claim about a current model.
  assert.equal(core.currentModelOf({}), null);
  assert.equal(core.currentModelOf({ currentModel: {} }), null);
  assert.equal(core.currentModelOf({ currentModel: { model: '   ' } }), null);
  assert.equal(core.currentModelOf({ currentModel: 'deepseek' }), null);
  assert.equal(core.currentModelOf(null), null);

  assert.equal(core.currentModelLabel({ model: 'm', provider: 'p', reasoningEffort: 'low' }), 'm · p · low');
  assert.equal(core.inheritModelLabel(null), '沿用当前模型');
  assert.equal(core.inheritModelLabel({ model: 'm' }), '沿用当前模型（现在：m）');
});

// ---------------------------------------------------------------------------
// prefs.js — local pins, theme and remembered filters
// ---------------------------------------------------------------------------

function fakeStorage(initial) {
  const map = new Map(Object.entries(initial || {}));
  return {
    getItem(key) { return map.has(key) ? map.get(key) : null; },
    setItem(key, value) { map.set(key, String(value)); },
    removeItem(key) { map.delete(key); },
    dump() { return Object.fromEntries(map); }
  };
}

test('prefs round-trip through storage and survive junk', () => {
  const storage = fakeStorage();
  const store = prefs.createPrefs(storage);
  assert.deepEqual(store.get(), prefs.defaults());

  store.set({ theme: 'dark', tool: 'dsh', projectId: 'p1' });
  store.togglePin('a1');
  const reloaded = prefs.load(storage);
  assert.equal(reloaded.theme, 'dark');
  assert.equal(reloaded.tool, 'dsh');
  assert.equal(reloaded.projectId, 'p1');
  assert.deepEqual(reloaded.pins, { a1: true });
  assert.equal(prefs.pinnedCount(reloaded), 1);

  // A hand-edited or truncated blob never produces something unusable.
  const broken = fakeStorage({ [prefs.KEY]: '{not json' });
  assert.deepEqual(prefs.load(broken), prefs.defaults());
  const weird = fakeStorage({ [prefs.KEY]: JSON.stringify({ theme: 'neon', tab: 'nope', pins: { a: 'yes', b: true } }) });
  const cleaned = prefs.load(weird);
  assert.equal(cleaned.theme, 'auto');
  assert.equal(cleaned.tab, 'chats');
  assert.deepEqual(cleaned.pins, { b: true });

  // A storage that throws (private mode / a WebView with DOM storage off) is
  // contained: defaults on read, false on write, never an exception.
  const hostile = {
    getItem() { throw new Error('denied'); },
    setItem() { throw new Error('denied'); }
  };
  assert.deepEqual(prefs.load(hostile), prefs.defaults());
  assert.equal(prefs.save(hostile, { theme: 'dark' }), false);
  assert.deepEqual(prefs.load(null), prefs.defaults());
  assert.equal(prefs.save(null, {}), false);
});

test('the theme is applied as one attribute, and only one', () => {
  const attributes = new Map();
  const doc = {
    documentElement: {
      setAttribute(name, value) { attributes.set(name, value); },
      removeAttribute(name) { attributes.delete(name); },
      getAttribute(name) { return attributes.has(name) ? attributes.get(name) : null; }
    }
  };
  assert.equal(prefs.applyTheme(doc, 'dark'), 'dark');
  assert.equal(doc.documentElement.getAttribute('data-theme'), 'dark');
  assert.equal(prefs.applyTheme(doc, 'light'), 'light');
  assert.equal(doc.documentElement.getAttribute('data-theme'), 'light');
  // 'auto' hands control back to the system colour scheme.
  assert.equal(prefs.applyTheme(doc, 'auto'), 'auto');
  assert.equal(doc.documentElement.getAttribute('data-theme'), null);
  // An unknown value is 'auto', never a third state.
  assert.equal(prefs.applyTheme(doc, 'neon'), 'auto');
  assert.equal(prefs.applyTheme(null, 'dark'), 'auto');
  assert.deepEqual([...attributes.keys()], []);
});
