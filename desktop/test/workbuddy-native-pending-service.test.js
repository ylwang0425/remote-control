'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { WorkBuddyPendingService } = require('../src/workbuddy-native/pending-service');
const { buildSessionReadResult } = require('../src/protocol');

const SESSION = 'wb-session-001';
const EXE = 'D:\\tools\\WorkBuddy\\WorkBuddy.exe';
function control(name, digit, type = 'ControlType.Button') {
  return { controlType: type, accessibleName: name, enabled: true,
    patterns: type === 'ControlType.Edit' ? ['value'] : ['invoke'],
    pathHash: digit.repeat(16), runtimeIdHash: digit.repeat(16),
    regionHash: 'aaaaaaaaaaaaaaaa', passwordProtected: false };
}
function fixture({ submitted = true, attempted = true, formOpen = true, stop = false } = {}) {
  const calls = [];
  const source = { cwd: 'C:/Users/test/WorkBuddy/project', historyTruncated: false,
    session: { id: SESSION, tool: 'workbuddy', title: 'Acceptance', status: 'unknown', canStop: false, messages: [] },
    records: [{ id: 'record-1', type: 'function_call', callId: 'actual-native-call', name: 'AskUserQuestion',
      arguments: { questions: [{ question: 'Choose a drink', header: 'Drink',
        options: [{ label: 'Tea', description: 'A warm drink' }, { label: 'Water' }] }] } }] };
  const form = { kind: 'question', complete: true, desktopGuide: false,
    conversationRegionHash: 'aaaaaaaaaaaaaaaa', scopePathHash: 'bbbbbbbbbbbbbbbb',
    visibleText: 'Choose a drink\n1/1\nTea\nWater', commandText: null,
    pageIndex: 1, pageCount: 1, questionIndexSource: 'native-progress',
    selectedCount: null, selectedCountSource: 'unavailable',
    controls: [control('1 Tea', '1'), control('2 Water', '2'), control('Send', '3'),
      control('Other (type your answer)', '4', 'ControlType.Edit')] };
  const context = { identityProof: { expectedCandidateIndex: 0, candidateCount: 1,
    matchedCandidateIndex: 0, conversationHeaderMatches: 1, rowMatches: 1 },
    pendingForms: { snapshotComplete: true, conversationIdentityVerified: true, reason: null,
      forms: formOpen ? [form] : [] },
    stopState: { idleObserved: !stop && !formOpen, conversationRegionHash: 'aaaaaaaaaaaaaaaa',
      control: stop ? control('Stop', '5') : null }, currentModel: 'Select model: GLM-5.3-Flash' };
  const service = new WorkBuddyPendingService({ executablePath: EXE,
    load(id) { assert.equal(id, SESSION); return source; },
    async readContext(id, hooks, analysis) { calls.push({ kind: 'read', id, analysis }); return context; },
    async execute(id, plan) { calls.push({ kind: 'execute', id, plan });
      return { uiSubmitted: submitted, attempted, nativeResultConfirmed: false }; } });
  return { service, source, context, calls };
}

test('live read combines actual metadata and numbered native options without fabricating a turn ID', async () => {
  const f = fixture();
  const read = await f.service.read(SESSION);
  const result = buildSessionReadResult(read);
  assert.equal(result.status, 'working');
  assert.equal(result.canStop, false);
  assert.equal(Object.hasOwn(result, 'activeTurnId'), false);
  assert.deepEqual(result.currentModel, { model: 'GLM-5.3-Flash' });
  assert.equal(result.pendingQuestions.length, 1);
  assert.notEqual(result.pendingQuestions[0].callId, 'actual-native-call');
  assert.equal(result.pendingQuestions[0].questions[0].options[0].description, 'A warm drink');
  assert.equal((await f.service.observation(SESSION)).input.cwd, 'C:\\Users\\test\\WorkBuddy\\project');
  f.service.retire();
});

test('a public answer is freshly bound, submitted once, and stripped of phone and native call identifiers', async () => {
  const f = fixture();
  const batch = (await f.service.read(SESSION)).pendingQuestions[0];
  const decision = { answers: [{ id: batch.questions[0].id, selected: ['Tea'] }] };
  assert.deepEqual(await f.service.decide(SESSION, batch.callId, decision), { accepted: true, state: 'submitted' });
  const executed = f.calls.find(c => c.kind === 'execute');
  assert.equal(executed.plan.expectedExePath, EXE);
  assert.equal(JSON.stringify(executed.plan).includes(batch.callId), false);
  assert.equal(JSON.stringify(executed.plan).includes('actual-native-call'), false);
  assert.equal(Object.hasOwn(executed.plan, 'sessionId'), false);
  assert.equal(Object.hasOwn(executed.plan.freshFormProof, 'sessionId'), false);
  await assert.rejects(f.service.decide(SESSION, batch.callId, decision), { code: 'not_capable' });
  assert.equal(f.calls.filter(c => c.kind === 'execute').length, 1);
  f.service.retire();
});

test('an uncertain native input consumes the alias and cannot be replayed as success', async () => {
  const f = fixture({ submitted: false });
  const batch = (await f.service.read(SESSION)).pendingQuestions[0];
  const decision = { answers: [{ id: batch.questions[0].id, selected: ['Tea'] }] };
  await assert.rejects(f.service.decide(SESSION, batch.callId, decision), { code: 'bridge_error' });
  await assert.rejects(f.service.decide(SESSION, batch.callId, decision), { code: 'not_capable' });
  assert.equal(f.calls.filter(c => c.kind === 'execute').length, 1);
  f.service.retire();
});

test('a custom answer can bind the native form when its alternative choices are disabled', async () => {
  const f = fixture();
  f.context.pendingForms.forms[0].controls[0].enabled = false;
  f.context.pendingForms.forms[0].controls[1].enabled = false;
  const batch = (await f.service.read(SESSION)).pendingQuestions[0];
  assert.ok(batch);
  await f.service.decide(SESSION, batch.callId,
    { answers: [{ id: batch.questions[0].id, selected: [], custom: 'A custom drink' }] });
  const plan = f.calls.find(c => c.kind === 'execute').plan;
  assert.equal(plan.answers[0].custom, 'A custom drink');
  assert.deepEqual(plan.answers[0].selectedLabels, []);
  f.service.retire();
});

test('switching away from the native form refuses the old phone answer before input', async () => {
  const f = fixture();
  const batch = (await f.service.read(SESSION)).pendingQuestions[0];
  f.context.pendingForms.forms = [];
  await assert.rejects(f.service.decide(SESSION, batch.callId,
    { answers: [{ id: batch.questions[0].id, selected: ['Tea'] }] }), { code: 'not_capable' });
  assert.equal(f.calls.some(c => c.kind === 'execute'), false);
  f.service.retire();
});

test('stop requires a real native control and reports submission without a fabricated completion', async () => {
  const f = fixture({ formOpen: false, stop: true });
  assert.equal((await f.service.read(SESSION)).canStop, true);
  assert.deepEqual(await f.service.stop(SESSION), { accepted: true, status: 'submitted' });
  assert.equal(f.calls.find(c => c.kind === 'execute').plan.kind, 'stop');
  f.context.stopState.control = null;
  await assert.rejects(f.service.stop(SESSION), { code: 'not_capable' });
  f.service.retire();
  await assert.rejects(f.service.read(SESSION), { code: 'not_capable' });
});

test('native command cards with Skip map only the exact localized Run or Reject to one phone decision', async () => {
  for (const [decision, label] of [['allow-once', '运行'], ['reject', '拒绝']]) {
    const f = fixture();
    f.source.records = [{ id: 'command-1', type: 'function_call', callId: 'native-command', name: 'PowerShell',
      arguments: { command: 'Write-Output QA' } }];
    f.context.pendingForms.forms = [{ kind: 'command', complete: true, desktopGuide: false,
      conversationRegionHash: 'aaaaaaaaaaaaaaaa', scopePathHash: 'bbbbbbbbbbbbbbbb',
      visibleText: 'Write-Output QA', commandText: 'Write-Output QA',
      controls: [control('运行', '1'), control('跳过', '2'), control('拒绝', '3')] }];
    const approval = (await f.service.read(SESSION)).pendingApprovals[0];
    assert.ok(approval);
    assert.deepEqual(await f.service.decide(SESSION, approval.id, { decision }), { accepted: true, state: 'submitted' });
    const plan = f.calls.find(c => c.kind === 'execute').plan;
    assert.equal(plan.targetControl.accessibleName, label);
    assert.equal(plan.context.command, 'Write-Output QA');
    assert.equal(plan.context.cwd, 'C:\\Users\\test\\WorkBuddy\\project');
    f.service.retire();
  }
});
