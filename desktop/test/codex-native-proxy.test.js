'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { PassThrough, Readable, Writable } = require('node:stream');
const { CodexNativeControlClient, readDescriptor } = require('../src/codex-native-control');
const {
  childEnvironment,
  isAppServerStdioInvocation,
  pipeTapped,
  startNativeProxy,
  validControlArgs,
  writeChunk,
} = require('../src/codex-native-proxy');

const RUN_ID = '816f5b92-2695-466b-ab4b-e9a404a343a5';

function tempDirectory() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'codex-native-proxy-'));
}

test('real CLI child preserves Desktop argv, cwd, auth, PATH and existing MCP env while removing only proxy control env', () => {
  const source = {
    PATH: 'C:\\existing-bin',
    CODEX_HOME: 'C:\\Users\\fixture\\.codex',
    CODEX_MCP_NODE_PATH: 'C:\\existing\\mcp-node.exe',
    CODEX_CLI_PATH: 'codex-native-proxy',
    AI_REMOTE_CODEX_NATIVE_CONTROL: '1',
    CODEX_NATIVE_CONTROL_DIR: 'C:\\private\\run',
    CODEX_NATIVE_RUN_ID: RUN_ID,
    CODEX_NATIVE_REAL_CLI_PATH: 'C:\\Codex\\codex.exe',
    CODEX_NATIVE_NODE_PATH: 'C:\\bridge\\node.exe',
    CODEX_NATIVE_PROXY_EXE_PATH: 'C:\\bridge\\codex-native-proxy.exe',
    CODEX_NATIVE_PROXY_SCRIPT: 'C:\\bridge\\src\\codex-native-proxy.js',
  };
  const child = childEnvironment(source, 'C:\\Codex\\codex.exe');
  assert.equal(child.PATH, source.PATH);
  assert.equal(child.CODEX_HOME, source.CODEX_HOME);
  assert.equal(child.CODEX_MCP_NODE_PATH, source.CODEX_MCP_NODE_PATH, 'existing vendor key remains intact');
  assert.equal(child.CODEX_CLI_PATH, 'C:\\Codex\\codex.exe');
  for (const key of Object.keys(source).filter((key) => key.startsWith('CODEX_NATIVE_') || key === 'AI_REMOTE_CODEX_NATIVE_CONTROL')) {
    assert.equal(Object.hasOwn(child, key), false, `${key} is proxy-only and must not recursively register a child`);
  }
});

test('opt-in validates real executable identity and fails closed before spawning without explicit consent', async (t) => {
  const registryDir = tempDirectory();
  t.after(() => fs.rmSync(registryDir, { recursive: true, force: true }));
  assert.equal(validControlArgs({ registryDir, runId: RUN_ID, realCliPath: process.execPath, proxyExePath: __filename }), true);
  assert.equal(validControlArgs({ registryDir, runId: RUN_ID, realCliPath: process.execPath, proxyExePath: process.execPath }), false);
  await assert.rejects(startNativeProxy({
    env: { CODEX_NATIVE_REAL_CLI_PATH: process.execPath, AI_REMOTE_CODEX_NATIVE_CONTROL: '0' },
    realCliPath: process.execPath,
    registryDir,
    runId: RUN_ID,
    proxyExePath: __filename,
    spawn() { throw new Error('must not spawn'); },
  }), /explicit user opt-in/);
});

test('only the app-server stdio invocation exposes control; CLI probes remain transparent', async (t) => {
  assert.equal(isAppServerStdioInvocation(['-c', 'features.code_mode_host=true', 'app-server', '--analytics-default-enabled', '-c', 'features.prefer_mxc=true']), true, 'matches the installed Desktop child and the current CLI default of stdio://');
  assert.equal(isAppServerStdioInvocation(['app-server', '--listen', 'stdio://']), true);
  assert.equal(isAppServerStdioInvocation(['app-server', '--listen=stdio']), true);
  assert.equal(isAppServerStdioInvocation(['app-server', '--stdio']), true);
  assert.equal(isAppServerStdioInvocation(['app-server', '--listen', 'ws://127.0.0.1:1234']), false);
  assert.equal(isAppServerStdioInvocation(['app-server', '--listen', 'off']), false);
  assert.equal(isAppServerStdioInvocation(['app-server', 'generate-ts', '--listen', 'stdio://']), false);
  assert.equal(isAppServerStdioInvocation(['exec-server', '--listen', 'stdio://']), false);
  assert.equal(isAppServerStdioInvocation(['app-server', '--help', '--listen', 'stdio']), false);
  assert.equal(isAppServerStdioInvocation(['--version']), false);

  const registryDir = tempDirectory();
  t.after(() => fs.rmSync(registryDir, { recursive: true, force: true }));
  const childScript = path.join(registryDir, 'probe-child.js');
  fs.writeFileSync(childScript, [
    "const fs = require('node:fs');",
    "process.stdin.pipe(process.stdout);",
    "process.stdin.on('end', () => { fs.writeFileSync(process.env.CODEX_FIXTURE_REPORT, JSON.stringify(process.argv.slice(2))); process.exitCode = 4; });",
  ].join('\n'));
  const desktopInput = new PassThrough();
  const output = [];
  const desktopOutput = new Writable({ write(chunk, enc, callback) { output.push(Buffer.from(chunk)); callback(); } });
  const resultPromise = startNativeProxy({
    env: {
      ...process.env,
      AI_REMOTE_CODEX_NATIVE_CONTROL: '1',
      CODEX_NATIVE_CONTROL_DIR: registryDir,
      CODEX_NATIVE_RUN_ID: RUN_ID,
      CODEX_NATIVE_REAL_CLI_PATH: process.execPath,
      CODEX_FIXTURE_REPORT: path.join(registryDir, 'probe-args.json'),
    },
    realCliPath: process.execPath,
    proxyExePath: __filename,
    registryDir,
    runId: RUN_ID,
    args: [childScript, '--version', 'argument with spaces', 'trailing\\'],
    desktopInput,
    desktopOutput,
  });
  desktopInput.write(Buffer.from('probe-', 'utf8'));
  desktopInput.end(Buffer.from('bytes\n', 'utf8'));
  const result = await resultPromise;
  assert.equal(result.code, 4);
  assert.equal(Buffer.concat(output).toString('utf8'), 'probe-bytes\n');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(registryDir, 'probe-args.json'), 'utf8')), ['--version', 'argument with spaces', 'trailing\\']);
  assert.deepEqual(fs.readdirSync(registryDir).filter((name) => name.startsWith('codex-native-')), []);
});

test('same-child proxy routes native control while transparently forwarding normal JSON-RPC and degrading safely on an oversized line', async (t) => {
  const registryDir = tempDirectory();
  t.after(() => fs.rmSync(registryDir, { recursive: true, force: true }));
  const reportPath = path.join(registryDir, 'child-fixture.json');
  const childScript = path.join(registryDir, 'native-child.js');
  fs.writeFileSync(childScript, [
    "'use strict';",
    "const fs = require('node:fs');",
    "const data = { args: process.argv.slice(2), cwd: process.cwd(), codeCli: process.env.CODEX_CLI_PATH, home: process.env.CODEX_HOME, mcpNode: process.env.CODEX_MCP_NODE_PATH, auth: process.env.CODEX_FIXTURE_AUTH, optIn: process.env.AI_REMOTE_CODEX_NATIVE_CONTROL, registry: process.env.CODEX_NATIVE_CONTROL_DIR, runId: process.env.CODEX_NATIVE_RUN_ID, proxyNode: process.env.CODEX_NATIVE_NODE_PATH, received: [], internalIds: [] };",
    "const fragments = (text) => { const bytes = Buffer.from(text); let offset = 0; const sizes = [1, 2, 5, 3, 8]; let index = 0; while (offset < bytes.length) { const end = Math.min(bytes.length, offset + sizes[index++ % sizes.length]); process.stdout.write(bytes.subarray(offset, end)); offset = end; } };",
    "const normalResponse = '{\"jsonrpc\":\"2.0\",\"id\":\"desktop-1\",\"result\":{\"ok\":true}}\\n';",
    "const turnStarted = '{\"jsonrpc\":\"2.0\",\"method\":\"turn/started\",\"params\":{\"threadId\":\"thread-fixture\",\"turn\":{\"id\":\"turn-fixture\",\"status\":\"inProgress\"}}}\\n';",
    "const serverQuestion = JSON.stringify({jsonrpc:'2.0',id:202,method:'item/tool/requestUserInput',params:{threadId:'thread-fixture',turnId:'turn-fixture',itemId:'item-fixture',questions:[{id:'question-fixture',header:'Choose',question:'Which option?',options:[{label:'A',description:'First'}],isOther:false,isSecret:false}]}})+'\\n';",
    "let pending = '';",
    "function receive(message) { data.received.push(message); if (message.method === 'thread/resume') { fragments(normalResponse); fragments(turnStarted); fragments(serverQuestion); } else if (message.id === 202) { fragments('{\"jsonrpc\":\"2.0\",\"method\":\"serverRequest/resolved\",\"params\":{\"threadId\":\"thread-fixture\",\"requestId\":202}}\\n'); } else if (message.method === 'turn/interrupt') { data.internalIds.push(message.id); fragments(JSON.stringify({jsonrpc:'2.0',id:message.id,result:{accepted:true}})+'\\n'); fragments('{\"jsonrpc\":\"2.0\",\"method\":\"turn/completed\",\"params\":{\"threadId\":\"thread-fixture\",\"turn\":{\"id\":\"turn-fixture\",\"status\":\"interrupted\"}}}\\n'); } }",
    "process.stderr.write('fixture stderr marker\\n');",
    "process.stdin.on('data', (chunk) => { pending += chunk.toString('utf8'); let newline; while ((newline = pending.indexOf('\\n')) !== -1) { const line = pending.slice(0, newline); pending = pending.slice(newline + 1); receive(JSON.parse(line)); } });",
    "process.stdin.on('end', () => { const largeLine = JSON.stringify({jsonrpc:'2.0',method:'fixture/oversized',params:{value:'x'.repeat(1024)}})+'\\n'; fragments(largeLine); fs.writeFileSync(process.env.CODEX_FIXTURE_REPORT, JSON.stringify(data)); process.exitCode = 7; });",
    "process.stdin.resume();",
  ].join('\n'));

  const desktopInput = new PassThrough();
  const outputChunks = [];
  const errorChunks = [];
  const slowOutput = new Writable({
    highWaterMark: 1,
    write(chunk, encoding, callback) {
      outputChunks.push(Buffer.from(chunk));
      setTimeout(callback, 2);
    },
  });
  const slowError = new Writable({
    highWaterMark: 1,
    write(chunk, encoding, callback) {
      errorChunks.push(Buffer.from(chunk));
      setTimeout(callback, 2);
    },
  });
  const env = {
    ...process.env,
    AI_REMOTE_CODEX_NATIVE_CONTROL: '1',
    CODEX_NATIVE_CONTROL_DIR: registryDir,
    CODEX_NATIVE_RUN_ID: RUN_ID,
    CODEX_NATIVE_REAL_CLI_PATH: process.execPath,
    CODEX_NATIVE_PROXY_EXE_PATH: __filename,
    CODEX_NATIVE_NODE_PATH: process.execPath,
    CODEX_HOME: path.join(registryDir, 'codex-home'),
    CODEX_MCP_NODE_PATH: path.join(registryDir, 'mcp-node.exe'),
    CODEX_CLI_PATH: 'codex-native-proxy',
    CODEX_FIXTURE_AUTH: 'private-test-marker-never-logged',
    CODEX_FIXTURE_REPORT: reportPath,
  };
  const running = startNativeProxy({
    env,
    realCliPath: process.execPath,
    proxyExePath: __filename,
    registryDir,
    runId: RUN_ID,
    cwd: registryDir,
    args: [childScript, '-c', 'features.code_mode_host=true', 'app-server', '--analytics-default-enabled', '-c', 'features.prefer_mxc=true'],
    desktopInput,
    desktopOutput: slowOutput,
    desktopError: slowError,
    tapMaxLineBytes: 512,
  });
  let client = null;
  let result;
  try {
    desktopInput.write(Buffer.from('{"jsonrpc":"2.0","id":"desktop-', 'utf8'));
    desktopInput.write(Buffer.from('1","method":"thread/resume","params":{"threadId":"thread-fixture"}}\n', 'utf8'));
    const deadline = Date.now() + 5000;
    let descriptor = null;
    while (Date.now() < deadline && descriptor === null) {
      const filename = fs.readdirSync(registryDir).find((name) => name.startsWith('codex-native-') && name.endsWith('.json'));
      if (filename !== undefined) descriptor = readDescriptor(registryDir, filename, RUN_ID);
      if (descriptor === null) await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.ok(descriptor, 'the same child published its authenticated control endpoint');
    client = new CodexNativeControlClient(descriptor);
    await client.initialize();
    let snapshot = null;
    while (Date.now() < deadline) {
      snapshot = await client.snapshot('thread-fixture');
      if (snapshot.activeTurnId === 'turn-fixture' && snapshot.requests.length === 1) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(snapshot.activeTurnId, 'turn-fixture');
    assert.equal(snapshot.requests.length, 1);
    const request = snapshot.requests[0];
    const answer = await client.respond({
      bridgeRequestId: request.id,
      threadId: 'thread-fixture',
      itemId: 'item-fixture',
      answer: { answers: [{ id: 'question-fixture', selected: ['A'] }] },
    });
    assert.deepEqual(answer, { state: 'submitted' });
    const interrupt = await client.interrupt('thread-fixture', 'turn-fixture');
    assert.deepEqual(interrupt, { state: 'confirmed' });
    desktopInput.end();
    result = await running;
  } finally {
    client?.close();
    if (!desktopInput.destroyed && !desktopInput.writableEnded) desktopInput.end();
    if (result === undefined) await Promise.race([running, new Promise((resolve) => setTimeout(resolve, 5000))]);
  }
  assert.equal(result.code, 7);
  const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
  assert.deepEqual(report.args, ['-c', 'features.code_mode_host=true', 'app-server', '--analytics-default-enabled', '-c', 'features.prefer_mxc=true']);
  assert.equal(report.cwd, registryDir);
  assert.equal(report.codeCli, fs.realpathSync.native(process.execPath));
  assert.equal(report.home, env.CODEX_HOME);
  assert.equal(report.mcpNode, env.CODEX_MCP_NODE_PATH);
  assert.equal(report.auth, env.CODEX_FIXTURE_AUTH);
  assert.equal(report.optIn, undefined);
  assert.equal(report.registry, undefined);
  assert.equal(report.runId, undefined);
  assert.equal(report.proxyNode, undefined);
  const expectedForwarded = [
    '{"jsonrpc":"2.0","id":"desktop-1","result":{"ok":true}}\n',
    '{"jsonrpc":"2.0","method":"turn/started","params":{"threadId":"thread-fixture","turn":{"id":"turn-fixture","status":"inProgress"}}}\n',
    '{"jsonrpc":"2.0","id":202,"method":"item/tool/requestUserInput","params":{"threadId":"thread-fixture","turnId":"turn-fixture","itemId":"item-fixture","questions":[{"id":"question-fixture","header":"Choose","question":"Which option?","options":[{"label":"A","description":"First"}],"isOther":false,"isSecret":false}]}}\n',
    '{"jsonrpc":"2.0","method":"serverRequest/resolved","params":{"threadId":"thread-fixture","requestId":202}}\n',
    '{"jsonrpc":"2.0","method":"turn/completed","params":{"threadId":"thread-fixture","turn":{"id":"turn-fixture","status":"interrupted"}}}\n',
    JSON.stringify({ jsonrpc: '2.0', method: 'fixture/oversized', params: { value: 'x'.repeat(1024) } }) + '\n',
  ].join('');
  const output = Buffer.concat(outputChunks).toString('utf8');
  assert.equal(output, expectedForwarded, 'normal notifications, RPC responses, requests and an oversized line remain byte-identical to Desktop');
  assert.equal(report.internalIds.length, 1);
  assert.equal(output.includes(`"id":"${report.internalIds[0]}","result":{"accepted":true}`), false, 'only the proxy-owned native RPC response is consumed');
  assert.equal(report.received.some((message) => message.method === 'turn/interrupt'), true);
  assert.deepEqual(report.received.find((message) => message.id === 202), {
    jsonrpc: '2.0', id: 202, result: { answers: { 'question-fixture': { answers: ['A'] } } },
  }, 'the answer is written once to the same child and is not echoed back to Desktop');
  assert.equal(Buffer.concat(errorChunks).toString('utf8'), 'fixture stderr marker\n');
  assert.equal(output.includes(env.CODEX_FIXTURE_AUTH), false, 'auth context is never logged to the Desktop stream');
  assert.deepEqual(fs.readdirSync(registryDir).filter((name) => name.startsWith('codex-native-')), [], 'the per-child descriptor is removed on child exit');
});

test('control degradation disables the endpoint but retains its descriptor until the real child exits', async (t) => {
  const registryDir = tempDirectory();
  t.after(() => fs.rmSync(registryDir, { recursive: true, force: true }));
  const childScript = path.join(registryDir, 'degrading-child.js');
  const triggerMarker = path.join(registryDir, 'degrade-triggered');
  const afterMarker = path.join(registryDir, 'after-degrade-received');
  fs.writeFileSync(childScript, [
    "'use strict';",
    "const fs = require('node:fs');",
    "let pending = '';",
    "process.stdin.on('data', (chunk) => { pending += chunk.toString('utf8'); let newline; while ((newline = pending.indexOf('\\n')) !== -1) { const message = JSON.parse(pending.slice(0, newline)); pending = pending.slice(newline + 1); if (message.method === 'fixture/degrade') { process.stdout.write(JSON.stringify({jsonrpc:'2.0',method:'fixture/oversized',params:{value:'x'.repeat(1024)}})+'\\n'); fs.writeFileSync(process.env.CODEX_FIXTURE_TRIGGER_MARKER, 'triggered'); } else if (message.method === 'fixture/after-degrade') { fs.writeFileSync(process.env.CODEX_FIXTURE_AFTER_MARKER, 'received'); process.stdout.write('{\"jsonrpc\":\"2.0\",\"id\":\"after-degrade\",\"result\":{\"ok\":true}}\\n'); } } });",
    "process.stdin.on('end', () => { process.exitCode = 0; });",
    "process.stdin.resume();",
  ].join('\n'));

  const desktopInput = new PassThrough();
  const outputChunks = [];
  const desktopOutput = new Writable({ write(chunk, encoding, callback) { outputChunks.push(Buffer.from(chunk)); callback(); } });
  const running = startNativeProxy({
    env: {
      ...process.env,
      AI_REMOTE_CODEX_NATIVE_CONTROL: '1',
      CODEX_NATIVE_CONTROL_DIR: registryDir,
      CODEX_NATIVE_RUN_ID: RUN_ID,
      CODEX_NATIVE_REAL_CLI_PATH: process.execPath,
      CODEX_FIXTURE_TRIGGER_MARKER: triggerMarker,
      CODEX_FIXTURE_AFTER_MARKER: afterMarker,
    },
    realCliPath: process.execPath,
    proxyExePath: __filename,
    registryDir,
    runId: RUN_ID,
    cwd: registryDir,
    args: [childScript, 'app-server', '--listen', 'stdio://'],
    desktopInput,
    desktopOutput,
    tapMaxLineBytes: 512,
  });

  let nativeDescriptor;
  try {
    const descriptorDeadline = Date.now() + 5000;
    while (Date.now() < descriptorDeadline) {
      const filename = fs.readdirSync(registryDir).find((name) => name.startsWith('codex-native-') && name.endsWith('.json'));
      if (filename !== undefined) {
        nativeDescriptor = readDescriptor(registryDir, filename, RUN_ID);
        if (nativeDescriptor !== null) break;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.ok(nativeDescriptor, 'the app-server child published its control descriptor');
    const initialClient = new CodexNativeControlClient({ ...nativeDescriptor, connectTimeoutMs: 300, timeoutMs: 300 });
    await initialClient.initialize();
    initialClient.close();

    desktopInput.write('{"jsonrpc":"2.0","method":"fixture/degrade"}\n');
    const degradedDeadline = Date.now() + 5000;
    let controlsUnavailable = false;
    while (Date.now() < degradedDeadline) {
      if (!fs.existsSync(triggerMarker)) {
        await new Promise((resolve) => setTimeout(resolve, 10));
        continue;
      }
      const probe = new CodexNativeControlClient({ ...nativeDescriptor, connectTimeoutMs: 100, timeoutMs: 100 });
      try {
        await probe.initialize();
        probe.close();
      } catch {
        controlsUnavailable = true;
        probe.close();
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(controlsUnavailable, true, 'the listener is no longer available after the tap safety limit');
    assert.equal(fs.existsSync(path.join(registryDir, `codex-native-${RUN_ID}-${nativeDescriptor.instanceId}.json`)), true, 'the descriptor remains as a child-liveness record while the child is still alive');

    desktopInput.write('{"jsonrpc":"2.0","method":"fixture/after-degrade"}\n');
    const forwardedDeadline = Date.now() + 5000;
    while (Date.now() < forwardedDeadline && !fs.existsSync(afterMarker)) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(fs.existsSync(afterMarker), true, 'the same real child remains alive to process ordinary input after control degradation');
    assert.equal(Buffer.concat(outputChunks).toString('utf8'), `${JSON.stringify({ jsonrpc: '2.0', method: 'fixture/oversized', params: { value: 'x'.repeat(1024) } })}\n{"jsonrpc":"2.0","id":"after-degrade","result":{"ok":true}}\n`, 'native stdout remains byte-transparent after the control listener is disabled');
    assert.equal(fs.existsSync(path.join(registryDir, `codex-native-${RUN_ID}-${nativeDescriptor.instanceId}.json`)), true, 'the liveness descriptor is not removed while the child is alive');
  } finally {
    if (!desktopInput.destroyed && !desktopInput.writableEnded) desktopInput.end();
    let cleanupTimer;
    await Promise.race([running, new Promise((resolve) => { cleanupTimer = setTimeout(resolve, 5000); })]);
    clearTimeout(cleanupTimer);
  }

  await running;
  assert.deepEqual(fs.readdirSync(registryDir).filter((name) => name.startsWith('codex-native-')), [], 'the descriptor is removed only after the same child exits');
});

test('pipeTapped waits for destination backpressure and preserves fragmented bytes without loss', async () => {
  const original = Buffer.from('{"jsonrpc":"2.0","method":"test","params":{"value":1}}\n{"method":"second"}\n', 'utf8');
  const chunks = [original.subarray(0, 1), original.subarray(1, 9), original.subarray(9, 31), original.subarray(31)];
  const source = Readable.from(chunks);
  const received = [];
  const slowDestination = new Writable({
    highWaterMark: 1,
    write(chunk, encoding, callback) {
      received.push(Buffer.from(chunk));
      setTimeout(callback, 2);
    },
  });
  const messages = [];
  const { JsonlTap } = require('../src/codex-native-proxy-core');
  const tap = new JsonlTap({ onLine(message) { messages.push(message.method); } });
  await pipeTapped(source, slowDestination, tap, (error) => { throw error; });
  assert.deepEqual(messages, ['test', 'second']);
  assert.deepEqual(Buffer.concat(received), original);
  const direct = new Writable({ highWaterMark: 1, write(chunk, enc, done) { setTimeout(done, 3); } });
  await writeChunk(direct, Buffer.from('slow write'));
  direct.end();
});
