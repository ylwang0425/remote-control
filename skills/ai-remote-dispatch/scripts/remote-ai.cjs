#!/usr/bin/env node
'use strict';

// Dependency-free client. Node 22 is already bundled with the Windows bridge.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const https = require('node:https');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

const TOOLS = ['codex', 'dsh', 'workbuddy'];
const METHODS = ['sessions.list', 'models.list', 'session.read', 'session.create', 'session.send', 'session.stop', 'session.answer', 'session.approve'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const COMPUTER_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MAX_RESPONSE = 2 * 1024 * 1024;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

class RemoteError extends Error {
  constructor(code, message, uncertain = false) { super(message); this.code = code; this.uncertain = uncertain; }
}

function loadConfig(filename = path.join(os.homedir(), '.dsh', 'ai-remote-desktop.json')) {
  const cfg = JSON.parse(fs.readFileSync(filename, 'utf8').replace(/^\uFEFF/, ''));
  let url;
  try { url = new URL(cfg.relayUrl); } catch { throw new RemoteError('config', 'Invalid relayUrl in desktop registration'); }
  if (!['wss:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash ||
      !['/', '/bridge', ''].includes(url.pathname)) throw new RemoteError('config', 'Registration must use a plain HTTPS/WSS server address');
  if (!COMPUTER_UUID.test(cfg.clientId || '') || !/^[A-Za-z0-9_-]{43}$/.test(cfg.bridgeToken || '')) throw new RemoteError('config', 'Desktop registration is incomplete; enroll this computer first');
  url.protocol = 'https:'; url.pathname = '/';
  return { origin: url.origin, clientId: cfg.clientId, token: cfg.bridgeToken };
}

class Client {
  constructor(config, request = https.request) { this.config = config; this.request = request; }
  post(route, body, timeoutMs = 15000) {
    if (!['/api/fleet/computers', '/api/fleet/rpc'].includes(route)) throw new RemoteError('invalid_request', 'Unknown shared API route');
    const raw = Buffer.from(JSON.stringify(body));
    if (raw.length > 16384) throw new RemoteError('too_long', 'Request exceeds the relay 16 KiB body limit');
    return new Promise((resolve, reject) => {
      const deadline = setTimeout(() => req.destroy(new Error('deadline')), timeoutMs + 5000);
      const req = this.request(new URL(route, this.config.origin), {
        method: 'POST', rejectUnauthorized: true,
        headers: { 'Origin': this.config.origin, 'Authorization': `Bearer ${this.config.token}`, 'Content-Type': 'application/json', 'Content-Length': raw.length },
      }, res => {
        // Never follow a redirect carrying a registration credential.
        if (res.statusCode >= 300 && res.statusCode < 400) { res.resume(); req.destroy(); clearTimeout(deadline); reject(new RemoteError('redirect_refused', 'Server redirect refused; no credential was forwarded')); return; }
        let size = 0; const chunks = [];
        res.on('data', chunk => {
          size += chunk.length;
          if (size > MAX_RESPONSE) req.destroy(new Error('response too large')); else chunks.push(chunk);
        });
        res.on('error', () => { clearTimeout(deadline); reject(new RemoteError('transport', 'Response interrupted; a write may already have reached the computer', true)); });
        res.on('end', () => {
          clearTimeout(deadline);
          let value;
          try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { reject(new RemoteError('bad_response', 'Server returned invalid JSON', true)); return; }
          if (res.statusCode !== 200 || value.ok !== true) {
            const code = typeof value.error?.code === 'string' ? value.error.code : `http_${res.statusCode}`;
            const definite = ['invalid_params', 'invalid_request', 'unknown_method', 'not_capable', 'tool_unavailable', 'forbidden', 'unauthenticated', 'origin_forbidden', 'target_offline', 'bridge_offline', 'rate_limited', 'bridge_busy', 'too_long'];
            reject(new RemoteError(code, typeof value.error?.message === 'string' ? value.error.message.slice(0, 500) : 'Shared request failed', !definite.includes(code)));
          } else if (!value.result || typeof value.result !== 'object') reject(new RemoteError('bad_response', 'Missing result', true));
          else resolve(value.result);
        });
      });
      req.on('error', () => { clearTimeout(deadline); reject(new RemoteError('transport', 'HTTPS failed; check certificate, connection and server address. A write may already have reached the computer', true)); });
      req.end(raw);
    });
  }
  inventory() { return this.post('/api/fleet/computers', {}); }
  rpc(computer, method, params, timeoutMs = 15000) {
    if (!COMPUTER_UUID.test(computer || '') || !METHODS.includes(method)) throw new RemoteError('invalid_request', 'Use an exact computer UUID and an allowlisted method');
    return this.post('/api/fleet/rpc', { clientId: computer, method, params, timeoutMs }, timeoutMs);
  }
}

function capable(computer, method, tool) {
  const caps = computer.capabilities || {};
  return typeof caps[`${method}:${tool}`] === 'boolean' ? caps[`${method}:${tool}`] : caps[method] === true;
}

function candidates(inventory, options) {
  if (!Array.isArray(inventory.computers)) throw new RemoteError('bad_response', 'Missing computer roster');
  const matches = inventory.computers.filter(c => (!options.owner || c.ownerName === options.owner) &&
    (!options.computer || c.clientId === options.computer || c.clientName === options.computer));
  if (options.computer && matches.length > 1) throw new RemoteError('ambiguous_target', 'Computer name is duplicated; use its UUID');
  const result = [];
  for (const c of matches) {
    if (!c.online || !COMPUTER_UUID.test(c.clientId)) continue;
    for (const tool of TOOLS) {
      if (options.tool && options.tool !== 'auto' && options.tool !== tool) continue;
      if (c.tools?.some(t => t.id === tool && t.available === true) &&
          ['models.list', 'session.create', 'session.read'].every(m => capable(c, m, tool))) result.push({ computer: c, tool });
    }
  }
  if (!result.length) throw new RemoteError('no_target', 'No matching online tool supports new tasks and reading replies; inspect inventory and native capability reasons');
  return result;
}

async function prepare(client, candidate, options) {
  const { computer, tool } = candidate;
  const catalog = await client.rpc(computer.clientId, 'models.list', { tool });
  if (catalog.tool !== tool || !Array.isArray(catalog.models)) throw new RemoteError('bad_response', 'Model catalog does not match selected tool');
  const models = catalog.models.filter(m => typeof m.id === 'string' && m.id && (!options.model || m.id === options.model) && (!options.provider || m.provider === options.provider));
  if (!models.length) throw new RemoteError('no_model', 'Requested model/provider is absent from the fresh target catalog');
  if (options.model && models.length > 1) throw new RemoteError('ambiguous_model', 'Model ID has multiple providers; specify --provider');
  const model = models.find(m => m.isDefault === true) || models[0];
  if (tool === 'dsh' && !model.provider) throw new RemoteError('no_model', 'DSH catalog did not provide a provider for this model');
  if (options.effort && !(model.reasoningEfforts || []).some(e => (typeof e === 'string' ? e : e.effort) === options.effort)) throw new RemoteError('invalid_effort', 'Reasoning effort is absent from the selected model catalog');
  const params = { tool, model: model.id };
  if (tool === 'dsh') params.provider = model.provider;
  if (options.effort) params.reasoningEffort = options.effort;
  if (options.project) {
    const projects = (catalog.projects || []).filter(p => p.id === options.project || p.name === options.project || p.cwd === options.project);
    if (projects.length !== 1) throw new RemoteError('invalid_project', 'Project is missing or ambiguous in this target tool catalog; use its exact ID');
    params.projectId = projects[0].id;
  }
  return { ...candidate, params };
}

function privateDirectory(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (fs.lstatSync(dir).isSymbolicLink()) throw new RemoteError('local_storage', 'Task directory must not be a symbolic link');
  if (process.platform === 'win32') {
    const who = execFileSync('whoami.exe', [], { encoding: 'utf8', windowsHide: true }).trim();
    execFileSync('icacls.exe', [dir, '/inheritance:r', '/grant:r', `${who}:(OI)(CI)F`, '*S-1-5-18:(OI)(CI)F'], { stdio: 'ignore', windowsHide: true });
  } else fs.chmodSync(dir, 0o700);
}

class Journal {
  constructor(config, root = path.join(os.homedir(), '.dsh', 'ai-remote-dispatch', 'tasks')) { this.config = config; this.root = root; privateDirectory(root); }
  save(task) {
    if (!UUID.test(task.taskId || '')) throw new RemoteError('local_storage', 'Invalid task ID');
    const dest = path.join(this.root, `${task.taskId}.json`), temp = `${dest}.${crypto.randomUUID()}.tmp`;
    const value = { ...task, origin: this.config.origin, sourceClientId: this.config.clientId };
    fs.writeFileSync(temp, JSON.stringify(value, null, 2), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    fs.renameSync(temp, dest);
    return task;
  }
  load(id) {
    if (!UUID.test(id || '')) throw new RemoteError('local_storage', 'Use the task UUID returned by ask');
    const filename = path.join(this.root, `${id}.json`);
    if (fs.lstatSync(filename).isSymbolicLink()) throw new RemoteError('local_storage', 'Task record must not be a symbolic link');
    const task = JSON.parse(fs.readFileSync(filename, 'utf8'));
    if (task.origin !== this.config.origin || task.sourceClientId !== this.config.clientId || task.taskId !== id) throw new RemoteError('local_storage', 'Task belongs to a different server or registered identity');
    return task;
  }
}

function taskOutput(task, extra = {}) {
  return { taskId: task.taskId, computerId: task.computerId, ownerName: task.ownerName, computerName: task.computerName,
    tool: task.tool, model: task.model, ...(task.provider ? { provider: task.provider } : {}),
    ...(task.sessionId ? { sessionId: task.sessionId } : {}), requestId: task.requestId, ...extra };
}

async function collect(client, task, waitSeconds, { now = Date.now, pause = sleep } = {}) {
  if (!task.sessionId) return taskOutput(task, { status: task.status, error: task.error, message: 'Creation outcome is unresolved; inspect sessions.list on this exact computer. Do not send the question again automatically.' });
  const end = now() + waitSeconds * 1000;
  while (true) {
    let read;
    try { read = await client.rpc(task.computerId, 'session.read', { tool: task.tool, sessionId: task.sessionId }); }
    catch (e) { return taskOutput(task, { status: 'read-failed', error: e.code || 'error', message: e.message }); }
    if (read.id !== task.sessionId || read.tool !== task.tool || !Array.isArray(read.messages)) throw new RemoteError('bad_response', 'Read result belongs to another session or tool');
    const answer = read.messages.filter(m => m.role === 'assistant' && typeof m.text === 'string' && m.text.trim()).map(m => m.text).join('\n\n');
    const pendingQuestions = read.pendingQuestions || [], pendingApprovals = read.pendingApprovals || [];
    const extra = { nativeStatus: read.status, ...(answer ? { answer } : {}), ...(read.currentModel ? { currentModel: read.currentModel } : {}), ...(read.historyTruncated ? { historyTruncated: true } : {}) };
    if (pendingQuestions.length || pendingApprovals.length) return taskOutput(task, { ...extra, status: 'needs-input', pendingQuestions, pendingApprovals });
    if (read.status === 'error') return taskOutput(task, { ...extra, status: 'failed' });
    // An acknowledgment, arbitrary assistant text, or unknown native status is
    // never promoted into a completed model turn.
    if (read.status === 'idle' && answer && read.canStop !== true && !read.activeTurnId && !task.partial) return taskOutput(task, { ...extra, status: 'completed' });
    if (now() >= end) return taskOutput(task, { ...extra, status: task.partial ? 'creation-partial' : read.status === 'unknown' ? 'unverified' : 'pending', message: 'No completed answer verified within the wait budget; collect this task again without resending' });
    await pause(Math.min(3000, Math.max(1, end - now())));
  }
}

async function dispatch(client, journal, prepared, question, waitSeconds) {
  const { computer, tool, params } = prepared;
  const task = { taskId: crypto.randomUUID(), requestId: crypto.randomUUID(), computerId: computer.clientId,
    ownerName: computer.ownerName, computerName: computer.clientName, tool, model: params.model,
    ...(params.provider ? { provider: params.provider } : {}), createdAt: new Date().toISOString(), status: 'submitting' };
  journal.save(task); // Persist the request identity BEFORE the only write attempt.
  let created;
  try { created = await client.rpc(computer.clientId, 'session.create', { ...params, text: question, requestId: task.requestId }, 60000); }
  catch (e) {
    task.status = e.uncertain ? 'creation-unknown' : 'rejected'; task.error = e.code || 'error'; journal.save(task);
    return taskOutput(task, { status: task.status, error: task.error, message: e.message });
  }
  if (created.tool !== tool || typeof created.sessionId !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/.test(created.sessionId)) {
    task.status = 'creation-unknown'; task.error = 'bad_response'; journal.save(task);
    return taskOutput(task, { status: task.status, message: 'Invalid creation receipt; do not repeat this write automatically' });
  }
  task.sessionId = created.sessionId; task.partial = created.partial === true; task.status = task.partial ? 'creation-partial' : 'accepted'; journal.save(task);
  return collect(client, task, waitSeconds);
}

async function ask(client, journal, options, question) {
  const choices = candidates(await client.inventory(), options);
  const prepared = [], skipped = [];
  // Read-only preparation can fail without sending any question. Once a write
  // is attempted there is no fallback or retry on a different person's tool.
  for (const candidate of choices) {
    try { prepared.push(await prepare(client, candidate, options)); }
    catch (e) { skipped.push({ computerId: candidate.computer.clientId, tool: candidate.tool, error: e.code || 'error', message: e.message }); }
    if (prepared.length && !options.all) break;
    if (prepared.length > 16) throw new RemoteError('too_many_targets', 'Fan-out exceeds 16 tools; narrow --owner, --computer or --tool');
  }
  if (!prepared.length) return { status: 'no-target', results: [], skipped };
  // Distinct computers may run in parallel. Tools on the same computer run
  // sequentially, including collection, so native writers never overlap here.
  const groups = new Map();
  for (const p of prepared) { if (!groups.has(p.computer.clientId)) groups.set(p.computer.clientId, []); groups.get(p.computer.clientId).push(p); }
  const queue = [...groups.values()], results = [];
  await Promise.all(Array.from({ length: Math.min(4, queue.length) }, async () => {
    while (queue.length) {
      const group = queue.shift();
      for (const p of group) {
        const result = await dispatch(client, journal, p, question, options.wait);
        results.push(result);
        // A still-running or unresolved task may be using this computer. Do
        // not start its next writer; let the caller collect/stop the first.
        if (!['completed', 'failed', 'rejected'].includes(result.status)) break;
      }
    }
  }));
  return { results, skipped, notStarted: prepared.length - results.length };
}

function parseArgs(argv) {
  const command = argv.shift() || 'help', options = { tool: 'auto', wait: 45 };
  const names = { '--config': 'config', '--owner': 'owner', '--computer': 'computer', '--tool': 'tool', '--model': 'model', '--provider': 'provider', '--effort': 'effort', '--project': 'project', '--question-file': 'questionFile', '--wait-seconds': 'wait', '--task': 'task', '--method': 'method', '--params-file': 'paramsFile' };
  while (argv.length) {
    const key = argv.shift();
    if (key === '--all') { options.all = true; continue; }
    const name = names[key];
    if (!name || !argv.length || argv[0].startsWith('--')) throw new RemoteError('arguments', 'Unknown option or missing value; use help');
    options[name] = argv.shift();
  }
  options.wait = Number(options.wait);
  if (!Number.isFinite(options.wait) || options.wait < 0 || options.wait > 600) throw new RemoteError('arguments', '--wait-seconds must be between 0 and 600');
  if (options.tool !== 'auto' && !TOOLS.includes(options.tool)) throw new RemoteError('arguments', 'Unknown tool');
  return { command, options };
}

function readInput(filename) {
  if (!filename || !path.isAbsolute(filename)) throw new RemoteError('arguments', 'Input JSON/question files must have absolute paths');
  if (fs.statSync(filename).size > 65536) throw new RemoteError('too_long', 'Input file is too large');
  return fs.readFileSync(filename, 'utf8').replace(/^\uFEFF/, '');
}

const HELP = `AI Remote Dispatch (Node 22+, no npm dependencies)
  inventory [--owner NAME]
  models --computer UUID --tool codex|dsh|workbuddy
  ask --question-file ABS_PATH [--owner NAME] [--computer UUID] [--tool auto|codex|dsh|workbuddy]
      [--model ID --provider ID --effort LEVEL --project ID] [--all] [--wait-seconds 45]
  collect --task UUID [--wait-seconds 45]
  rpc --computer UUID --method METHOD --params-file ABS_PATH
All commands: --config ABS_PATH (default ~/.dsh/ai-remote-desktop.json)
Credentials come only from that computer's existing registration. Never supply admin credentials.
ask creates a dedicated chat. --all explicitly fans out across matching tools (maximum 16).
No write is retried. A pending/unresolved task must be collected or inspected, not resubmitted.`;

async function main(argv) {
  const { command, options } = parseArgs([...argv]);
  if (command === 'help' || command === '--help') { console.log(HELP); return; }
  let cfg;
  try {
    cfg = loadConfig(options.config);
    const client = new Client(cfg);
    let result;
    if (command === 'inventory') {
      result = await client.inventory();
      if (options.owner) result.computers = result.computers.filter(c => c.ownerName === options.owner);
    } else if (command === 'models') {
      if (options.tool === 'auto') throw new RemoteError('arguments', 'models requires --tool');
      result = await client.rpc(options.computer, 'models.list', { tool: options.tool });
    } else if (command === 'rpc') {
      if (!METHODS.includes(options.method)) throw new RemoteError('arguments', 'Method is not allowlisted');
      result = await client.rpc(options.computer, options.method, JSON.parse(readInput(options.paramsFile)), 60000);
    } else if (command === 'ask') {
      const question = readInput(options.questionFile);
      if (!question.trim() || [...question].length > 16384 || question.includes('\0')) throw new RemoteError('arguments', 'Question is empty or too long');
      result = await ask(client, new Journal(cfg), options, question);
    } else if (command === 'collect') {
      result = await collect(client, new Journal(cfg).load(options.task), options.wait);
    } else throw new RemoteError('arguments', 'Unknown command; use help');
    // Suppress accidental echo of our own credential even if a peer includes it.
    console.log(JSON.stringify(result, null, 2).split(cfg.token).join('[REDACTED_SECRET]'));
  } catch (e) {
    const message = cfg ? String(e.message).split(cfg.token).join('[REDACTED_SECRET]') : 'Unable to load desktop registration or command input';
    console.log(JSON.stringify({ status: 'error', code: e.code || 'local_error', message, ...(e.uncertain ? { outcomeUncertain: true } : {}) }));
    process.exitCode = 1;
  }
}

module.exports = { Client, Journal, RemoteError, loadConfig, capable, candidates, prepare, collect, dispatch, ask, parseArgs, main };
if (require.main === module) main(process.argv.slice(2)).catch(e => { console.error(JSON.stringify({ status: 'error', code: e.code || 'arguments', message: 'Invalid command; run help' })); process.exitCode = 1; });
