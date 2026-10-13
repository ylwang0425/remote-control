'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { analyzeNativeHistory } = require('../src/workbuddy-native/history-state');

const SESSION = 'session-native-1';
const CWD = 'D:\\work\\remote-control';

function call({
  id = 'event-call-1',
  callId = 'native-call-1',
  includeCallId = true,
  name = 'Bash',
  arguments: args = { command: 'npm test' },
  cwd,
} = {}) {
  return {
    id,
    type: 'function_call',
    ...(includeCallId ? { callId } : {}),
    name,
    arguments: args,
    ...(cwd !== undefined ? { cwd } : {}),
    timestamp: 1_800_000_000_000,
  };
}

function result(callId = 'native-call-1', id = 'event-result-1') {
  return { id, type: 'function_call_result', callId, output: { type: 'text', text: 'completed' }, timestamp: 1_800_000_001_000 };
}

function options(extra = {}) {
  return { sessionId: SESSION, cwd: CWD, historyTruncated: false, ...extra };
}

test('native callId is preserved, a matching native result closes it, and record hashes are never used as call ids', () => {
  const callRecord = call({ id: 'event-id-is-not-call-id' });
  const open = analyzeNativeHistory([callRecord], options());
  assert.deepEqual(open.unresolvedCalls, [{ callId: 'native-call-1', toolName: 'Bash', recordId: 'event-id-is-not-call-id' }]);
  assert.deepEqual(open.commandCandidates[0].scopeContext, {
    kind: 'command', command: 'npm test', cwd: CWD,
  });
  assert.equal(open.commandCandidates[0].complete, true);

  const closed = analyzeNativeHistory([callRecord, result('native-call-1')], options());
  assert.deepEqual(closed.unresolvedCalls, []);
  assert.deepEqual(closed.commandCandidates, []);
});

test('native record id is the fallback call identity only when callId is absent', () => {
  const idOnly = call({ id: 'real-native-call-id', includeCallId: false, name: 'AskUserQuestion', arguments: { questions: [
    { id: 'q-choice', question: 'Which one?', options: [{ label: 'A' }, { label: 'B', description: 'Second choice' }], multiSelect: false, isOther: true },
  ] } });
  const closed = analyzeNativeHistory([idOnly, { id: 'real-native-call-id', type: 'function_call_result', output: 'done' }], options());
  assert.deepEqual(closed.unresolvedCalls, []);

  const open = analyzeNativeHistory([idOnly], options());
  assert.equal(open.unresolvedCalls[0].callId, 'real-native-call-id');
  assert.equal(open.questionCandidates[0].complete, true);
  assert.deepEqual(open.questionCandidates[0].questions, [{
    id: 'q-choice', question: 'Which one?', options: [{ label: 'A' }, { label: 'B', description: 'Second choice' }], allowCustom: true,
  }]);
});

test('installed WorkBuddy 5.7.7 accepts source questions without ids; history does not invent renderer keys', () => {
  // Source-shape fixture based on the installed renderer path: it accepts
  // question text and supplies a q-index key for its own UI bookkeeping.
  const noSourceIds = call({ name: 'AskUserQuestion', arguments: { questions: [
    { question: 'Choose a color', header: 'Color', options: [{ label: 'Blue' }, { label: 'Green' }] },
    { question: 'Choose a size', options: [{ label: 'Small' }, { label: 'Large' }], multiSelect: true },
  ] } });
  const analysis = analyzeNativeHistory([noSourceIds], options());
  assert.equal(analysis.questionCandidates[0].complete, true);
  assert.deepEqual(analysis.questionCandidates[0].questions, [
    { question: 'Choose a color', header: 'Color', options: [{ label: 'Blue' }, { label: 'Green' }] },
    { question: 'Choose a size', options: [{ label: 'Small' }, { label: 'Large' }], multiSelect: true },
  ]);
  assert.equal(Object.hasOwn(analysis.questionCandidates[0].questions[0], 'id'), false);
  assert.equal(Object.hasOwn(analysis.questionCandidates[0].questions[1], 'id'), false);
});

test('history retains an explicit allowCustom false so the UIA controller cannot enable Other', () => {
  const explicitFalse = call({ name: 'AskUserQuestion', arguments: { questions: [
    { question: 'Choose a color', options: [{ label: 'Blue' }, { label: 'Green' }], allowCustom: false },
  ] } });
  const analysis = analyzeNativeHistory([explicitFalse], options());
  assert.equal(analysis.questionCandidates[0].complete, true);
  assert.deepEqual(analysis.questionCandidates[0].questions, [{
    question: 'Choose a color', options: [{ label: 'Blue' }, { label: 'Green' }], allowCustom: false,
  }]);
});

test('history completeness must be explicit and complete native results are the only close signal', () => {
  const unknown = analyzeNativeHistory([call()]);
  assert.equal(unknown.complete, false);
  assert.deepEqual(unknown.unresolvedCalls, []);
  assert.deepEqual(unknown.commandCandidates, []);
  assert.ok(unknown.issues.includes('history_completeness_unknown'));

  const truncated = analyzeNativeHistory([call(), { type: 'function_call_output', callId: 'native-call-1', output: 'text' }], options({ historyTruncated: true }));
  assert.equal(truncated.complete, false);
  assert.deepEqual(truncated.unresolvedCalls, []);
  assert.deepEqual(truncated.commandCandidates, []);

  const malformedResult = analyzeNativeHistory([call(), { type: 'function_call_result', callId: {}, output: 'done' }], options());
  assert.equal(malformedResult.complete, false);
  assert.deepEqual(malformedResult.unresolvedCalls, []);
});

test('identical native call updates deduplicate, while a conflicting identity suppresses context', () => {
  const duplicate = analyzeNativeHistory([
    call({ id: 'event-first' }),
    call({ id: 'event-repeat' }),
  ], options());
  assert.equal(duplicate.unresolvedCalls.length, 1);
  assert.equal(duplicate.commandCandidates.length, 1);
  assert.equal(duplicate.commandCandidates[0].complete, true);

  const conflict = analyzeNativeHistory([
    call({ arguments: { command: 'npm test' } }),
    call({ id: 'event-other', arguments: { command: 'Remove-Item -Recurse D:\\work' } }),
  ], options());
  assert.equal(conflict.unresolvedCalls.length, 1);
  assert.equal(conflict.unresolvedCalls[0].callId, 'native-call-1');
  assert.equal(conflict.unresolvedCalls[0].ambiguous, true);
  assert.equal(conflict.unresolvedCalls[0].toolName, null);
  assert.deepEqual(conflict.commandCandidates, []);
});

test('command candidates separate safe command text from a complete scoped context', () => {
  const missingCwd = analyzeNativeHistory([call()], options({ cwd: undefined }));
  assert.equal(missingCwd.commandCandidates[0].complete, false);
  assert.deepEqual(missingCwd.commandCandidates[0].metadata, { commandText: 'npm test' });
  assert.equal(Object.hasOwn(missingCwd.commandCandidates[0], 'scopeContext'), false);

  const conflictingCwd = analyzeNativeHistory([call({ arguments: { command: 'npm test', cwd: 'D:\\other' } })], options());
  assert.equal(conflictingCwd.commandCandidates[0].complete, false);
  assert.deepEqual(conflictingCwd.commandCandidates[0].metadata, { commandText: 'npm test' });
  assert.equal(Object.hasOwn(conflictingCwd.commandCandidates[0], 'scopeContext'), false);

  const relativeCwd = analyzeNativeHistory([call({ arguments: { command: 'npm test', cwd: '..\\other' } })], options({ cwd: undefined }));
  assert.equal(relativeCwd.commandCandidates[0].complete, false);
  assert.equal(Object.hasOwn(relativeCwd.commandCandidates[0], 'scopeContext'), false);

  const commandOnlyCwd = analyzeNativeHistory([call({ arguments: { command: 'npm test', cwd: CWD } })], options({ cwd: undefined }));
  assert.equal(commandOnlyCwd.commandCandidates[0].complete, false);
  assert.equal(Object.hasOwn(commandOnlyCwd.commandCandidates[0], 'scopeContext'), false);
});

test('sensitive or incomplete command and question inputs expose metadata only', () => {
  const credential = analyzeNativeHistory([call({ arguments: { command: 'tool --api-key=abcd123456789' } })], options());
  assert.equal(credential.commandCandidates[0].complete, false);
  assert.deepEqual(credential.commandCandidates[0].metadata, {});

  const partialQuestion = call({ name: 'AskUserQuestion', arguments: { questions: [
    { id: 'q-one', question: 'Choose', options: [{ label: 'A' }, { description: 'missing label' }] },
  ] } });
  const partial = analyzeNativeHistory([partialQuestion], options());
  assert.equal(partial.questionCandidates[0].complete, false);
  assert.deepEqual(partial.questionCandidates[0].metadata, { questionCount: 1 });
  assert.equal(Object.hasOwn(partial.questionCandidates[0], 'questions'), false);

  const secretQuestion = call({ name: 'AskUserQuestion', arguments: { questions: [
    { id: 'q-secret', question: 'Enter the credential', isSecret: true, options: [{ label: 'Enter' }] },
  ] } });
  const secret = analyzeNativeHistory([secretQuestion], options());
  assert.equal(secret.questionCandidates[0].complete, false);
  assert.equal(Object.hasOwn(secret.questionCandidates[0], 'questions'), false);
});

test('native truncation markers and malformed records suppress all inferred open calls', () => {
  const compacted = analyzeNativeHistory([call(), { id: 'event-large', type: 'message', _compactTruncated: true }], options());
  assert.equal(compacted.complete, false);
  assert.deepEqual(compacted.unresolvedCalls, []);
  assert.deepEqual(compacted.questionCandidates, []);

  const malformed = analyzeNativeHistory([call(), null], options());
  assert.equal(malformed.complete, false);
  assert.deepEqual(malformed.unresolvedCalls, []);
  assert.deepEqual(malformed.commandCandidates, []);
});

test('duplicate question and option identities and protocol-limit overflow refuse full questions', () => {
  const duplicateQuestionIds = call({ name: 'AskUserQuestion', arguments: { questions: [
    { id: 'q-one', question: 'First' },
    { id: 'q-one', question: 'Second' },
  ] } });
  const duplicate = analyzeNativeHistory([duplicateQuestionIds], options());
  assert.equal(duplicate.questionCandidates[0].complete, false);

  const tooManyOptions = call({ name: 'AskUserQuestion', arguments: { questions: [
    { id: 'q-options', question: 'Pick', options: Array.from({ length: 13 }, (_, index) => ({ label: `Option ${index}` })) },
  ] } });
  const overflow = analyzeNativeHistory([tooManyOptions], options());
  assert.equal(overflow.questionCandidates[0].complete, false);

  const tooManyQuestions = call({ name: 'AskUserQuestion', arguments: { questions: Array.from({ length: 9 }, (_, index) => ({ id: `q-${index}`, question: 'Pick' })) } });
  const questionOverflow = analyzeNativeHistory([tooManyQuestions], options());
  assert.equal(questionOverflow.questionCandidates[0].complete, false);
});

test('oversize record count or JSONL payload never yields unresolved-call evidence', () => {
  const tooManyRecords = analyzeNativeHistory(Array.from({ length: 5001 }, (_, index) => ({ id: `event-${index}`, type: 'topic' })), options());
  assert.equal(tooManyRecords.complete, false);
  assert.deepEqual(tooManyRecords.unresolvedCalls, []);

  const tooLarge = analyzeNativeHistory([call(), { id: 'large-metadata', type: 'topic', text: 'x'.repeat(512 * 1024) }], options());
  assert.equal(tooLarge.complete, false);
  assert.deepEqual(tooLarge.unresolvedCalls, []);
});
