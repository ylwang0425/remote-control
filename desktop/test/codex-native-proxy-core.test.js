'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  nativeIdKey,
  nativeRequestFromMessage,
  JsonlTap,
  CodexNativeProxyCore,
  ProxyControlError,
} = require('../src/codex-native-proxy-core');

const THREAD = 'thread-native-fixture';
const TURN = 'turn-native-fixture';

function questionMessage(id, itemId = 'item-question') {
  return {
    jsonrpc: '2.0',
    id,
    method: 'item/tool/requestUserInput',
    params: {
      threadId: THREAD,
      turnId: TURN,
      itemId,
      questions: [{
        id: 'choice',
        header: 'Choose',
        question: 'Which route should be used?',
        isOther: true,
        options: [
          { label: 'Local', description: 'Use the local path.' },
          { label: 'Remote', description: 'Use the remote path.' },
        ],
      }],
    },
  };
}

function fixtureCore(options = {}) {
  const writes = [];
  const core = new CodexNativeProxyCore({
    writeToNative: options.writeToNative ?? ((line) => writes.push(JSON.parse(line))),
    interruptConfirmMs: options.interruptConfirmMs ?? 20,
    now: options.now,
  });
  return { core, writes };
}

function pending(core, message) {
  core.onNativeMessage(message);
  const snapshot = core.snapshot(message.params.threadId);
  const entry = snapshot.requests.find((candidate) => candidate.itemId === message.params.itemId);
  assert.ok(entry, 'native server request is exposed as live');
  return entry;
}

test('typed native ids stay distinct; a remote winner tombstones late GUI answers and an id reuse opens a new generation', async () => {
  const { core, writes } = fixtureCore();
  const stringRequest = pending(core, questionMessage('8', 'string-item'));
  const numberRequest = pending(core, questionMessage(8, 'number-item'));
  assert.notEqual(stringRequest.id, numberRequest.id);
  assert.equal(core.snapshot(THREAD).requests.length, 2);
  assert.equal(nativeIdKey('8'), 'string:"8"');
  assert.equal(nativeIdKey(8), 'number:8');

  const submitted = await core.respond({
    bridgeRequestId: stringRequest.id,
    threadId: THREAD,
    itemId: 'string-item',
    answer: { answers: [{ id: 'choice', selected: ['Local'] }] },
  });
  assert.deepEqual(submitted, { state: 'submitted' });
  assert.equal(writes.length, 1);
  assert.equal(writes[0].id, '8');
  assert.equal(core.onDesktopMessage({ jsonrpc: '2.0', id: '8', result: {} }), false, 'late GUI answer is consumed');
  assert.equal(core.onDesktopMessage({ jsonrpc: '2.0', id: '8', result: {} }), false, 'duplicate late GUI answer is also consumed');
  assert.equal(writes.length, 1, 'late GUI responses are never resent to the app-server');

  const desktopWon = { jsonrpc: '2.0', id: 8, result: { answers: {} } };
  assert.equal(core.onDesktopMessage(desktopWon), true, 'the GUI winner is forwarded');
  await assert.rejects(
    core.respond({ bridgeRequestId: numberRequest.id, threadId: THREAD, itemId: 'number-item', answer: { answers: [{ id: 'choice', selected: ['Local'] }] } }),
    (error) => error instanceof ProxyControlError && error.code === 'stale_request',
  );

  const replacement = pending(core, questionMessage('8', 'new-generation'));
  assert.notEqual(replacement.id, stringRequest.id);
  assert.equal(core.onDesktopMessage({ jsonrpc: '2.0', id: '8', result: {} }), true, 'native reuse clears the exact typed tombstone');
  assert.equal(core.snapshot(THREAD).requests.some((entry) => entry.id === replacement.id), false);
  core.close();
});

test('turn/item completion invalidates requests even without serverRequest/resolved', async () => {
  const { core } = fixtureCore();
  const itemRequest = pending(core, questionMessage(91, 'completed-item'));
  core.onNativeMessage({ method: 'item/completed', params: { threadId: THREAD, turnId: TURN, item: { id: 'completed-item' } } });
  assert.equal(core.snapshot(THREAD).requests.some((entry) => entry.id === itemRequest.id), false);
  assert.equal(core.onDesktopMessage({ jsonrpc: '2.0', id: 91, result: {} }), false);
  await assert.rejects(core.respond({ bridgeRequestId: itemRequest.id, threadId: THREAD, itemId: 'completed-item', answer: { answers: [{ id: 'choice', selected: ['Local'] }] } }), /no longer waiting/);

  const turnRequest = pending(core, questionMessage(92, 'completed-turn'));
  core.onNativeMessage({ method: 'turn/completed', params: { threadId: THREAD, turn: { id: TURN, status: 'completed' } } });
  assert.deepEqual(core.snapshot(THREAD).requests, []);
  assert.equal(core.snapshot(THREAD).activeTurnId, null);
  assert.equal(core.onDesktopMessage({ jsonrpc: '2.0', id: 92, result: {} }), false);
  await assert.rejects(core.respond({ bridgeRequestId: turnRequest.id, threadId: THREAD, itemId: 'completed-turn', answer: { answers: [{ id: 'choice', selected: ['Local'] }] } }), /no longer waiting/);
  core.close();
});

test('Desktop response wins atomically over a phone response and a repeated phone decision is stale', async () => {
  let releaseWrite;
  const { core, writes } = fixtureCore({ writeToNative: (line) => new Promise((resolve) => {
    writes.push(JSON.parse(line));
    releaseWrite = resolve;
  }) });
  const request = pending(core, questionMessage(101));
  const inFlight = core.respond({ bridgeRequestId: request.id, threadId: THREAD, itemId: 'item-question', answer: { answers: [{ id: 'choice', selected: ['Local'] }] } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(core.onDesktopMessage({ jsonrpc: '2.0', id: 101, result: { answers: {} } }), false, 'GUI loses after phone claimed the request');
  await assert.rejects(core.respond({ bridgeRequestId: request.id, threadId: THREAD, itemId: 'item-question', answer: { answers: [{ id: 'choice', selected: ['Local'] }] } }), /no longer waiting/);
  releaseWrite();
  assert.deepEqual(await inFlight, { state: 'submitted' });
  assert.equal(writes.length, 1);
  core.close();
});

test('question answers preserve native ids and enforce option, custom, secret and multiplicity semantics', async () => {
  const { core, writes } = fixtureCore();
  const request = pending(core, questionMessage(111));
  await core.respond({ bridgeRequestId: request.id, threadId: THREAD, itemId: 'item-question', answer: { answers: [{ id: 'choice', selected: ['Remote'] }] } });
  assert.deepEqual(writes[0].result, { answers: { choice: { answers: ['Remote'] } } });

  const freeForm = pending(core, {
    jsonrpc: '2.0', id: 112, method: 'item/tool/requestUserInput',
    params: { threadId: THREAD, turnId: 'turn-free', itemId: 'item-free', questions: [{ id: 'text', question: 'Describe it', isOther: true, isSecret: false, options: null }] },
  });
  await core.respond({ bridgeRequestId: freeForm.id, threadId: THREAD, itemId: 'item-free', answer: { answers: [{ id: 'text', selected: [], custom: 'A thoughtful answer' }] } });
  assert.deepEqual(writes[1].result, { answers: { text: { answers: ['A thoughtful answer'] } } });

  assert.equal(nativeRequestFromMessage({
    jsonrpc: '2.0', id: 113, method: 'item/tool/requestUserInput',
    params: { threadId: THREAD, turnId: 'turn-secret', itemId: 'secret-item', questions: [{ id: 'password', question: 'Secret?', isSecret: true }] },
  }), null, 'secret prompts remain in Desktop');
  const multiselect = pending(core, {
    jsonrpc: '2.0', id: 114, method: 'item/tool/requestUserInput',
    params: { threadId: THREAD, turnId: 'turn-multi', itemId: 'multi-item', questions: [{ id: 'many', question: 'Choose', multiSelect: true, isOther: true, options: [{ label: 'A' }, { label: 'B' }] }] },
  });
  await core.respond({ bridgeRequestId: multiselect.id, threadId: THREAD, itemId: 'multi-item', answer: { answers: [{ id: 'many', selected: ['A'], custom: 'Other detail' }] } });
  assert.deepEqual(writes[2].result, { answers: { many: { answers: ['A', 'Other detail'] } } });
  core.close();
});

test('native question id __proto__ is answered as data without object-prototype mutation', async () => {
  const { core, writes } = fixtureCore();
  const message = questionMessage(115, 'prototype-key-item');
  message.params.questions = [{
    id: '__proto__',
    question: 'Choose one option',
    isOther: false,
    isSecret: false,
    options: [{ label: 'Safe' }],
  }];
  const request = pending(core, message);
  await core.respond({
    bridgeRequestId: request.id,
    threadId: THREAD,
    itemId: 'prototype-key-item',
    answer: { answers: [{ id: '__proto__', selected: ['Safe'] }] },
  });
  assert.equal(JSON.stringify(writes[0].result), '{"answers":{"__proto__":{"answers":["Safe"]}}}');
  assert.equal(Object.getPrototypeOf(writes[0].result.answers), Object.prototype);
  assert.equal(Object.hasOwn(writes[0].result.answers, '__proto__'), true);
  core.close();
});

test('command, network and file approvals show complete context and reject additional grants or amendments', () => {
  const base = { threadId: THREAD, turnId: TURN, itemId: 'approve-item' };
  const command = nativeRequestFromMessage({
    jsonrpc: '2.0', id: 120, method: 'item/commandExecution/requestApproval',
    params: { ...base, kind: 'command', command: 'git status\ngit diff', cwd: 'D:\\repo', reason: 'Run the requested review.', availableDecisions: ['accept', 'decline', 'acceptForSession'] },
  });
  assert.equal(command.kind, 'command-approval');
  assert.equal(command.toolName, 'commandExecution');
  assert.deepEqual(command.availableDecisions, ['accept', 'decline']);
  assert.equal(command.command, 'git status\ngit diff');

  const defaults = nativeRequestFromMessage({
    jsonrpc: '2.0', id: 121, method: 'item/commandExecution/requestApproval',
    params: { ...base, command: 'npm test', cwd: 'D:\\repo' },
  });
  assert.ok(defaults, 'omitted availableDecisions use the native one-time accept/decline defaults');
  assert.equal(nativeRequestFromMessage({
    jsonrpc: '2.0', id: 122, method: 'item/commandExecution/requestApproval',
    params: { ...base, command: 'npm test', cwd: 'D:\\repo', kind: 'writeStdin' },
  }), null);
  assert.equal(nativeRequestFromMessage({
    jsonrpc: '2.0', id: 123, method: 'item/commandExecution/requestApproval',
    params: { ...base, command: 'npm test', cwd: 'D:\\repo', additionalPermissions: { fileSystem: { write: ['D:\\outside'] } } },
  }), null, 'an unshown file grant is unsupported');
  const proposedAmendments = nativeRequestFromMessage({
    jsonrpc: '2.0', id: 124, method: 'item/commandExecution/requestApproval',
    params: {
      ...base,
      kind: 'command',
      environmentId: null,
      command: 'npm test',
      cwd: 'D:\\repo',
      approvalId: 'approval-callback-1',
      commandActions: [{ type: 'unknown', command: 'npm test' }],
      proposedExecpolicyAmendment: ['npm', 'test'],
      proposedNetworkPolicyAmendments: [{ host: 'packages.example', action: 'allow' }],
      availableDecisions: ['accept', 'decline', { acceptWithExecpolicyAmendment: { execpolicy_amendment: ['npm', 'test'] } }],
    },
  });
  assert.ok(proposedAmendments, 'schema-valid amendment suggestions coexist with one-time accept');
  assert.equal(proposedAmendments.callId, 'approval-callback-1');
  assert.match(proposedAmendments.reason, /Native command action preview/);
  assert.deepEqual(proposedAmendments.availableDecisions, ['accept', 'decline']);

  const network = nativeRequestFromMessage({
    jsonrpc: '2.0', id: 125, method: 'item/commandExecution/requestApproval',
    params: { ...base, kind: 'command', networkApprovalContext: { host: 'packages.example', protocol: 'https', port: 443 }, reason: 'Download requested dependencies.' },
  });
  assert.equal(network.kind, 'network-approval');
  assert.equal(network.networkPort, 443);
  const combinedNetwork = nativeRequestFromMessage({
    jsonrpc: '2.0', id: 126, method: 'item/commandExecution/requestApproval',
    params: { ...base, command: 'curl packages.example', cwd: 'D:\\repo', networkApprovalContext: { host: 'packages.example', protocol: 'https' } },
  });
  assert.ok(combinedNetwork, 'network approval retains an accompanying command preview');
  assert.equal(combinedNetwork.networkHost, 'packages.example');
  assert.match(combinedNetwork.reason, /Requested command: curl packages\.example/);

  const file = nativeRequestFromMessage({
    jsonrpc: '2.0', id: 127, method: 'item/fileChange/requestApproval', params: { ...base, startedAtMs: 42, grantRoot: 'D:\\repo', reason: 'Apply the proposed patch.' },
  }, { patchSummary: '--- update: src/app.js\n+const ready = true;' });
  assert.equal(file.kind, 'file-change-approval');
  assert.equal(file.summary, '--- update: src/app.js\n+const ready = true;');
  assert.equal(nativeRequestFromMessage({
    jsonrpc: '2.0', id: 128, method: 'item/fileChange/requestApproval', params: { ...base, startedAtMs: 42, grantRoot: 'D:\\repo', additionalPermissions: { network: { enabled: true } } },
  }, { patchSummary: '--- update: src/app.js\n+const ready = true;' }), null);
});

test('file patch is correlated by exact thread/turn/item, changed diffs retire old handles, and turn completion clears context', async () => {
  const { core } = fixtureCore();
  const requestMessage = {
    jsonrpc: '2.0', id: 'file-1', method: 'item/fileChange/requestApproval',
    params: { threadId: THREAD, turnId: TURN, itemId: 'file-item', grantRoot: 'D:\\repo' },
  };
  core.onNativeMessage(requestMessage);
  assert.deepEqual(core.snapshot(THREAD).requests, [], 'file request stays hidden until complete patch arrives');
  core.onNativeMessage({ method: 'item/fileChange/patchUpdated', params: { threadId: THREAD, turnId: TURN, itemId: 'file-item', changes: [{ path: 'src/a.js', kind: { type: 'update', move_path: null }, diff: '+const a = 1;' }] } });
  const original = core.snapshot(THREAD).requests[0];
  assert.ok(original);
  assert.equal(original.context.kind, 'file-change');
  assert.match(original.context.summary, /src\/a\.js/);
  assert.equal(original.context.grantRoot, 'D:\\repo');

  core.onNativeMessage({ method: 'item/fileChange/patchUpdated', params: { threadId: THREAD, turnId: TURN, itemId: 'file-item', changes: [{ path: 'src/a.js', kind: { type: 'update', move_path: 'src/old.js' }, diff: '+const a = 2;' }] } });
  const updated = core.snapshot(THREAD).requests[0];
  assert.ok(updated);
  assert.notEqual(updated.id, original.id);
  assert.match(updated.context.summary, /moved from src\/old\.js/);
  await assert.rejects(core.respond({ bridgeRequestId: original.id, threadId: THREAD, itemId: 'file-item', answer: { decision: 'accept' } }), /no longer waiting/);

  core.onNativeMessage({ method: 'turn/completed', params: { threadId: THREAD, turn: { id: TURN, status: 'completed' } } });
  assert.deepEqual(core.snapshot(THREAD).requests, []);
  assert.equal(core.filePatchCache.size, 0);
  core.close();
});

test('native resolution is not confirmation, duplicate approval submissions are one-shot, and default decisions are allow-once only', async () => {
  const { core, writes } = fixtureCore();
  const request = pending(core, {
    jsonrpc: '2.0', id: 130, method: 'item/commandExecution/requestApproval',
    params: { threadId: THREAD, turnId: TURN, itemId: 'approve', command: 'npm test', cwd: 'D:\\repo' },
  });
  let first;
  await Promise.all([
    core.respond({ bridgeRequestId: request.id, threadId: THREAD, itemId: 'approve', answer: { decision: 'accept' } }).then((value) => { first = value; }),
    core.respond({ bridgeRequestId: request.id, threadId: THREAD, itemId: 'approve', answer: { decision: 'acceptForSession' } }).catch((error) => { assert.ok(error instanceof ProxyControlError); }),
  ]);
  assert.deepEqual(first, { state: 'submitted' });
  assert.equal(writes.length, 1);
  assert.deepEqual(writes[0].result, { decision: 'accept' });
  core.onNativeMessage({ method: 'serverRequest/resolved', params: { requestId: 130, threadId: THREAD } });
  assert.equal(core.onDesktopMessage({ jsonrpc: '2.0', id: 130, result: {} }), false);
  core.close();
});

test('timed-out internal RPC ids are swallowed when the native response arrives late', async () => {
  const { core, writes } = fixtureCore();
  await assert.rejects(core.callNative('turn/interrupt', { threadId: THREAD, turnId: TURN }, 2), /timed out/);
  const request = writes.map((line) => line.id).find((id) => typeof id === 'string' && id.startsWith('codex-native-'));
  assert.ok(request);
  assert.equal(core.onNativeMessage({ jsonrpc: '2.0', id: request, result: {} }), true);
  assert.equal(core.onNativeMessage({ jsonrpc: '2.0', id: 'not-ours', result: {} }), false);
  core.close();
});

test('interrupt is sent to the exact live turn and is confirmed only by its interrupted completion event', async () => {
  let core;
  const writes = [];
  core = new CodexNativeProxyCore({
    interruptConfirmMs: 50,
    writeToNative: (line) => {
      const message = JSON.parse(line);
      writes.push(message);
      if (message.method === 'turn/interrupt') {
        setImmediate(() => core.onNativeMessage({ jsonrpc: '2.0', id: message.id, result: { turnId: TURN } }));
        setTimeout(() => core.onNativeMessage({ method: 'turn/completed', params: { threadId: THREAD, turn: { id: TURN, status: 'interrupted' } } }), 5);
      }
    },
  });
  core.onNativeMessage({ method: 'turn/started', params: { threadId: THREAD, turn: { id: TURN } } });
  assert.deepEqual(await core.interrupt(THREAD, TURN), { state: 'confirmed' });
  assert.equal(writes.length, 1);
  assert.deepEqual(writes[0].params, { threadId: THREAD, turnId: TURN });
  await assert.rejects(core.interrupt(THREAD, TURN), /no longer running/);
  core.close();
});

test('JSONL tap preserves fragmentation, malformed bytes, and flush on child exit while suppressing only an explicit loser', () => {
  const seen = [];
  const tap = new JsonlTap({ onLine: (message, line) => {
    seen.push(message);
    return message?.id === 'suppressed' ? false : true;
  } });
  assert.deepEqual(tap.push(Buffer.from('{"jsonrpc":"2.0","id":"1",')) , []);
  const emitted = tap.push(Buffer.from('"method":"ping"}\nnot-json\n{"jsonrpc":"2.0","id":"suppressed"}\n{"last":true}'));
  assert.equal(Buffer.concat(emitted).toString(), '{"jsonrpc":"2.0","id":"1","method":"ping"}\nnot-json\n');
  assert.equal(Buffer.concat(tap.flush()).toString(), '{"last":true}');
  assert.deepEqual(seen[0], { jsonrpc: '2.0', id: '1', method: 'ping' });
  assert.equal(seen[1], null);
  assert.deepEqual(seen[2], { jsonrpc: '2.0', id: 'suppressed' });
});
