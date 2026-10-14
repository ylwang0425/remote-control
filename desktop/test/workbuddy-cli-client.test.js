'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough, Writable } = require('node:stream');
const { WorkBuddyCliClient } = require('../src/workbuddy-native/cli-client');
const ID = '2044490a-c920-43cc-868f-1e470bb3f567';
const OTHER = '987d1cef-9634-4acf-b738-6d28fbcbe22e';

function fixture({ account = 'same-owner', timeout = 1000, reply = true } = {}) {
  const frames = []; const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
  child.exitCode = null; child.kill = () => { child.exitCode = 0; child.emit('exit', 0); };
  child.stdin = new Writable({ write(bytes, _encoding, callback) {
    const frame = JSON.parse(bytes.toString()); frames.push(frame); callback();
    if (reply && frame.type === 'control_request') queueMicrotask(() => child.stdout.write(JSON.stringify({ type: 'control_response', response: {
      subtype: 'success', request_id: frame.request_id, response: frame.request.subtype === 'initialize'
        ? { account: { userId: account, token: 'private-fixture-token' }, models: [{ id: 'glm-5.1', name: 'GLM-5.1' }], currentModelId: 'glm-5.1' } : {} } }) + '\n'));
  } });
  let spawnOptions; let args;
  const client = new WorkBuddyCliClient({ executablePath: 'installed-WorkBuddy.exe', entry: 'installed-cli', configDir: 'local-data', cwd: 'local-project',
    sessionId: ID, accountId: 'same-owner', token: 'private-fixture-token', requestTimeoutMs: timeout,
    spawnProcess: (_exe, argv, options) => { args = argv; spawnOptions = options; return child; } });
  const failures = []; client.on('failure', error => failures.push(error));
  const emit = frame => child.stdout.write(JSON.stringify(frame) + '\n');
  return { client, child, frames, emit, failures, get args() { return args; }, get spawnOptions() { return spawnOptions; } };
}

test('background CLI uses default permissions, hidden argv spawning, and keeps credentials out of returned metadata', async t => {
  const f = fixture(); t.after(() => f.client.close());
  const result = await f.client.initialize();
  assert.equal(result.accountMatches, true);
  assert.equal(JSON.stringify(result).includes('private-fixture-token'), false);
  assert.equal(f.spawnOptions.windowsHide, true); assert.equal(f.spawnOptions.shell, false);
  assert.equal(f.spawnOptions.env.ELECTRON_RUN_AS_NODE, '1');
  assert.equal(f.spawnOptions.env.CODEBUDDY_AUTH_TOKEN, 'private-fixture-token');
  assert.equal(f.args.includes('private-fixture-token'), false);
  assert.equal(f.args.includes('default'), true);
  assert.equal(f.args.some(arg => /bypass|skip-permissions/.test(arg)), false);
  await f.client.send('a real fixture message', 'glm-5.1');
  assert.equal(f.frames.at(-1).session_id, ID);
});

test('a different authenticated account cannot send to the native conversation', async () => {
  const f = fixture({ account: 'other-owner' });
  await assert.rejects(f.client.initialize(), { code: 'not_capable' });
  assert.equal(f.client.closed, true);
  assert.equal(f.frames.some(frame => frame.type === 'user'), false);
});

test('Chinese terminal responses survive a UTF-8 character split across stdout chunks', async t => {
  const f = fixture(); t.after(() => f.client.close()); await f.client.initialize(); await f.client.send('颜色');
  let result; f.client.once('terminal', value => { result = value; });
  const bytes = Buffer.from(JSON.stringify({ type: 'result', session_id: ID, subtype: 'success', result: '已选择：蓝色' }) + '\n');
  const split = bytes.indexOf(Buffer.from('蓝')) + 1;
  f.child.stdout.write(bytes.subarray(0, split)); f.child.stdout.write(bytes.subarray(split));
  assert.equal(result.result, '已选择：蓝色');
});

test('a result for another UUID is refused rather than accepted as this turn', async () => {
  const f = fixture(); await f.client.initialize(); await f.client.send('fixture');
  let completed = false; f.client.on('terminal', () => { completed = true; });
  f.emit({ type: 'result', session_id: OTHER, subtype: 'success', result: 'wrong conversation' });
  assert.equal(completed, false); assert.equal(f.client.closed, true); assert.equal(f.failures.length, 1);
});

test('tool decisions are single-use, tied to the current turn, and never grant persistent suggestions', async t => {
  const f = fixture(); t.after(() => f.client.close()); await f.client.initialize(); await f.client.send('fixture');
  let permission; f.client.once('permission', value => { permission = value; });
  f.emit({ type: 'control_request', request_id: 'native-id', request: { subtype: 'can_use_tool', tool_name: 'Bash',
    tool_use_id: 'call-1', input: { command: 'echo fixture' }, permission_suggestions: [{ type: 'setMode', mode: 'bypassPermissions' }] } });
  assert.equal(f.frames.some(frame => frame.type === 'control_response'), false);
  f.client.decide(permission.handle, { allowed: true });
  assert.deepEqual(f.frames.at(-1).response.response, { allowed: true, tool_use_id: 'call-1' });
  assert.throws(() => f.client.decide(permission.handle, { allowed: true }), { code: 'not_capable' });
});

test('native cancellation and terminal results retire permission handles', async t => {
  const f = fixture(); t.after(() => f.client.close()); await f.client.initialize(); await f.client.send('fixture');
  const handles = []; f.client.on('permission', value => handles.push(value.handle));
  const ask = id => f.emit({ type: 'control_request', request_id: id, request: { subtype: 'can_use_tool', tool_name: 'AskUserQuestion', input: {} } });
  ask('first'); f.emit({ type: 'control_cancel_request', request_id: 'first' });
  assert.throws(() => f.client.decide(handles[0], { allowed: true }), { code: 'not_capable' });
  ask('second'); f.emit({ type: 'result', session_id: ID, subtype: 'success', result: 'complete' });
  assert.equal(f.client.status, 'idle'); assert.equal(f.client.permissions.size, 0);
  assert.throws(() => f.client.decide(handles[1], { allowed: true }), { code: 'not_capable' });
});

test('Stop interrupts only this owned UUID and rejects its pending action first', async t => {
  const f = fixture(); t.after(() => f.client.close()); await f.client.initialize(); await f.client.send('fixture');
  f.emit({ type: 'control_request', request_id: 'permission-id', request: { subtype: 'can_use_tool', tool_name: 'Bash', input: {}, tool_use_id: 'one' } });
  await f.client.stop();
  const responses = f.frames.filter(frame => frame.type === 'control_response');
  assert.equal(responses.at(-1).response.response.allowed, false);
  const interrupt = f.frames.find(frame => frame.request?.subtype === 'interrupt');
  assert.equal(interrupt.request.session_id, ID);
  assert.equal(f.client.permissions.size, 0);
});

test('split JSON frames work, timeout does not accept a late reply, and oversized frames close the owned process', async t => {
  const f = fixture({ reply: false, timeout: 20 }); t.after(() => f.client.close());
  await assert.rejects(f.client.initialize(), /timed out/);
  assert.equal(f.client.requests.size, 0);
  const line = JSON.stringify({ type: 'system', subtype: 'init', session_id: ID, model: 'glm-5.1' }) + '\n';
  f.child.stdout.write(line.slice(0, 10)); f.child.stdout.write(line.slice(10));
  assert.equal(f.client.currentModel, null); // A timed-out initialization cannot establish an authenticated model catalog.
  f.child.stdout.write('x'.repeat(2 * 1024 * 1024 + 1));
  assert.equal(f.client.closed, true);
});
