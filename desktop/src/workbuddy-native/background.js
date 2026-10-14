'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createHash, randomUUID } = require('node:crypto');
const { WorkBuddyCliClient, installedCli } = require('./cli-client');
const { desktopAccountId, loadCredentials, boundedJson } = require('./credentials');
const { BridgeError } = require('../errors');
const { buildSessionReadResult, assertAnswerBatch } = require('../protocol');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

class WorkBuddyBackground {
  constructor({ adapter, executablePath, indexFile, clientFactory, identity = desktopAccountId, credentials = loadCredentials }) {
    this.adapter = adapter; this.identity = identity; this.credentials = credentials;
    this.runtime = clientFactory ? {} : installedCli(executablePath);
    this.clientFactory = clientFactory || (options => new WorkBuddyCliClient(options));
    this.indexFile = indexFile || path.join(os.homedir(), '.dsh', 'ai-remote-workbuddy-sessions.json');
    this.entries = new Map(); this.retired = false; this.catalog = null; this.catalogPromise = null; this.busyCwds = new Set();
  }

  auth() {
    if (this.retired) throw new BridgeError('not_capable', 'WorkBuddy background adapter is closed');
    const accountId = this.identity(); const credential = this.credentials(undefined, accountId);
    if (!credential) throw new BridgeError('not_capable', 'Complete the official WorkBuddy CLI login on this computer first');
    return { accountId, token: credential.token };
  }

  rows() {
    let accountId; try { accountId = this.identity(); } catch { return []; }
    try {
      const data = boundedJson(this.indexFile, 1024 * 1024);
      if (data.accountId !== accountId || !Array.isArray(data.sessions) || data.sessions.length > 1000) return [];
      return data.sessions.filter(row => row && UUID.test(row.id) && row.user_id === accountId &&
        typeof row.cwd === 'string' && path.isAbsolute(row.cwd) && typeof row.title === 'string' && row.title.length <= 200);
    } catch { return []; }
  }
  row(id) { return this.rows().find(row => row.id === id) || null; }

  remember(row) {
    const accountId = this.identity(); const rows = this.rows(); const index = rows.findIndex(item => item.id === row.id);
    if (index >= 0) rows[index] = row; else rows.push(row);
    if (rows.length > 1000) throw new BridgeError('bridge_error', 'WorkBuddy background session index is full');
    fs.mkdirSync(path.dirname(this.indexFile), { recursive: true, mode: 0o700 });
    if (fs.lstatSync(path.dirname(this.indexFile)).isSymbolicLink()) throw new BridgeError('bridge_error', 'WorkBuddy background index directory is invalid');
    const temp = this.indexFile + '.' + randomUUID() + '.tmp';
    try { fs.writeFileSync(temp, JSON.stringify({ accountId, sessions: rows }), { mode: 0o600, flag: 'wx' }); fs.renameSync(temp, this.indexFile); }
    finally { if (fs.existsSync(temp)) fs.unlinkSync(temp); }
  }

  projects() {
    const accountId = this.identity(); const seen = new Set(); const projects = [];
    const rows = this.adapter.db.prepare('SELECT cwd FROM sessions WHERE user_id = ? AND transport = ? AND deleted_at IS NULL LIMIT 2000').all(accountId, 'local');
    for (const row of [...rows, ...this.rows()]) {
      if (typeof row.cwd !== 'string' || !path.isAbsolute(row.cwd)) continue;
      let cwd; try { cwd = fs.realpathSync(row.cwd); if (!fs.statSync(cwd).isDirectory()) continue; } catch { continue; }
      const key = process.platform === 'win32' ? cwd.toLowerCase() : cwd;
      if (seen.has(key)) continue; seen.add(key);
      projects.push({ id: 'wb-project-' + createHash('sha256').update(key).digest('hex').slice(0, 24), name: path.basename(cwd), cwd });
    }
    return projects.slice(0, 200);
  }

  async listModels(hooks) {
    hooks?.checkActive?.(); const auth = this.auth();
    if (this.catalog?.accountId === auth.accountId && Date.now() - this.catalog.at < 300000) return { models: this.catalog.models, projects: this.projects() };
    if (!this.catalogPromise) {
      this.catalogPromise = (async () => {
        const client = this.clientFactory({ ...this.runtime, ...auth, configDir: this.adapter.configDir, cwd: fs.realpathSync(this.adapter.configDir), authOnly: true });
        try {
          const initialized = await client.initialize();
          if (!initialized.accountMatches || initialized.models.length === 0) throw new BridgeError('not_capable', 'WorkBuddy CLI authentication has expired or no models are available');
          this.catalog = { at: Date.now(), accountId: auth.accountId, models: initialized.models }; return initialized.models;
        } finally { client.close(); }
      })().finally(() => { this.catalogPromise = null; });
    }
    const models = await this.catalogPromise; hooks?.checkActive?.(); this.auth();
    if (this.identity() !== auth.accountId) throw new BridgeError('not_capable', 'WorkBuddy desktop account changed during model discovery');
    return { models, projects: this.projects() };
  }

  target(sessionId, auth) {
    if (!UUID.test(sessionId || '')) throw new BridgeError('invalid_params', 'WorkBuddy background resume needs a native UUID');
    const native = this.adapter.db.prepare('SELECT * FROM sessions WHERE id = ? AND transport = ? AND deleted_at IS NULL').get(sessionId, 'local');
    const row = native || this.row(sessionId);
    if (!row || row.user_id !== auth.accountId) throw new BridgeError('session_not_found', 'WorkBuddy conversation is not owned by the current desktop account');
    if (native && ['working', 'running', 'pending', 'queued', 'waiting', 'waiting-for-user'].includes(row.status)) throw new BridgeError('bridge_error', 'WorkBuddy desktop is already running this conversation; finish or stop its current turn first');
    this.adapter.readSession(sessionId); return row;
  }

  async start(row, text, model, resume, hooks) {
    hooks?.checkActive?.(); const auth = this.auth(); const cwd = fs.realpathSync(row.cwd);
    const cwdKey = process.platform === 'win32' ? cwd.toLowerCase() : cwd;
    const busy = () => this.busyCwds.has(cwdKey) || [...this.entries.values()].some(e => e.row.id === row.id && (e.starting || e.client.status === 'working'));
    if (busy()) throw new BridgeError('bridge_error', 'This WorkBuddy background session or project is already running');
    if ([...this.entries.values()].filter(e => e.starting || e.client.status === 'working').length >= 4) throw new BridgeError('bridge_error', 'WorkBuddy background four-task limit has been reached');
    const catalog = await this.listModels(hooks);
    if (!catalog.models.some(item => item.id === model)) throw new BridgeError('invalid_params', 'Select a model from the authenticated WorkBuddy catalog');
    if (busy()) throw new BridgeError('bridge_error', 'WorkBuddy background project became busy');
    if ([...this.entries.values()].filter(e => e.starting || e.client.status === 'working').length >= 4) throw new BridgeError('bridge_error', 'WorkBuddy background four-task limit has been reached');
    if (resume) this.target(row.id, auth);
    this.busyCwds.add(cwdKey);
    let client;
    try { client = this.clientFactory({ ...this.runtime, ...auth, configDir: this.adapter.configDir, cwd, sessionId: row.id, resume, model }); }
    catch (error) { this.busyCwds.delete(cwdKey); throw error; }
    for (const [id, old] of this.entries) if (old.client.closed && this.entries.size >= 128) this.entries.delete(id);
    const entry = { client, row, pending: new Map(), starting: true }; this.entries.set(row.id, entry);
    const release = () => { this.busyCwds.delete(cwdKey); entry.starting = false; };
    client.on('permission', event => this.permission(entry, event)); client.once('failure', release);
    client.on('terminal', () => {
      release(); entry.pending.clear();
      if (!resume || this.row(row.id)) {
        try { this.remember({ ...row, model: client.currentModel || model, updated_at: new Date().toISOString() }); } catch {}
      }
      client.close();
    });
    try {
      await client.initialize(); hooks?.checkActive?.();
      if (this.identity() !== auth.accountId) throw new BridgeError('not_capable', 'WorkBuddy account changed before sending');
      await client.send(text, model); entry.starting = false; return entry;
    } catch (error) { release(); client.close(); throw error; }
  }

  async create(input, hooks, workbuddyHooks) {
    if (input.provider || input.reasoningEffort) throw new BridgeError('not_capable', 'WorkBuddy CLI does not expose a verified provider or reasoning-effort selector');
    const auth = this.auth(); const catalog = await this.listModels(workbuddyHooks);
    if (!catalog.models.some(model => model.id === input.model)) throw new BridgeError('invalid_params', 'Choose an authenticated WorkBuddy model');
    let cwd;
    if (input.projectId || input.cwd) {
      const project = catalog.projects.find(item => (!input.projectId || item.id === input.projectId) && (!input.cwd || item.cwd === input.cwd));
      if (!project) throw new BridgeError('invalid_params', 'Choose an existing WorkBuddy project from this computer');
      cwd = project.cwd;
    } else { cwd = path.join(os.homedir(), 'WorkBuddy', 'AI-Remote', randomUUID()); fs.mkdirSync(cwd, { recursive: true }); }
    const now = new Date().toISOString();
    const row = { id: randomUUID(), user_id: auth.accountId, cwd, title: this.adapter.redactCliTitle(input.text),
      created_at: now, updated_at: now, last_activity_at: now, deleted_at: null, transport: 'local', model: input.model };
    // This is our own CLI index, never a fabricated WorkBuddy desktop DB row.
    this.remember(row);
    const entry = await this.start(row, input.text, input.model, false, workbuddyHooks);
    const persisted = await this.waitForMessage(row.id, input.text, entry, workbuddyHooks);
    hooks?.onCreated?.({ sessionId: row.id });
    return { sessionId: row.id, title: row.title, partial: !persisted,
      ...(persisted ? {} : { incomplete: 'The background CLI started, but its first message has not yet been confirmed in the local archive. Refresh before retrying.' }) };
  }

  async send(sessionId, text, options, hooks) {
    if (options.provider || options.reasoningEffort) throw new BridgeError('not_capable', 'WorkBuddy CLI does not expose a verified provider or reasoning-effort selector');
    const row = this.target(sessionId, this.auth());
    const previousCount = this.adapter.readSession(sessionId).messages.filter(message => message.role === 'user' && message.text === text).length;
    const entry = await this.start(row, text, options.model || row.model || 'auto', true, hooks);
    if (!await this.waitForMessage(sessionId, text, entry, hooks, previousCount)) throw new BridgeError('bridge_error', 'WorkBuddy background send has not been confirmed in the original archive; refresh before retrying');
    return { accepted: true, sessionId };
  }

  async waitForMessage(id, text, entry, hooks, previousCount = 0) {
    const deadline = Date.now() + 8000;
    do {
      hooks?.checkActive?.();
      try { if (this.adapter.readSession(id).messages.filter(message => message.role === 'user' && message.text === text).length > previousCount) return true; } catch {}
      if (entry.client.closed) break;
      await sleep(100);
    } while (Date.now() < deadline);
    return false;
  }

  permission(entry, { handle, request }) {
    for (const id of entry.pending.keys()) if (!entry.client.permissions.has(id)) entry.pending.delete(id);
    try {
      let projection;
      if (request.tool_name === 'AskUserQuestion' && Array.isArray(request.input?.questions)) {
        const questions = request.input.questions.map((q, i) => ({ id: `q-${i}`, question: q.question,
          ...(q.header ? { header: q.header } : {}), ...(Array.isArray(q.options) && q.options.length ? { options: q.options.map(o => ({ label: o.label, ...(o.description ? { description: o.description } : {}) })) } : {}),
          multiSelect: q.multiSelect === true, allowCustom: true }));
        projection = { kind: 'question', batch: { callId: handle, state: 'open', questions } };
        buildSessionReadResult({ id: entry.row.id, tool: 'workbuddy', title: entry.row.title, status: 'working', messages: [], canStop: true, pendingQuestions: [projection.batch] });
      } else {
        const input = request.input || {}; let context;
        if (['Bash', 'PowerShell'].includes(request.tool_name) && typeof input.command === 'string') context = { kind: 'command', command: input.command, cwd: entry.row.cwd };
        else if (['Write', 'Edit', 'MultiEdit'].includes(request.tool_name) && typeof input.file_path === 'string') context = { kind: 'file-change', summary: `${request.tool_name}: ${JSON.stringify(input)}`, grantRoot: path.resolve(entry.row.cwd, input.file_path) };
        else if (request.tool_name === 'WebFetch' && typeof input.url === 'string') {
          const url = new URL(input.url);
          if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error();
          context = { kind: 'network', networkHost: url.hostname, protocol: url.protocol.slice(0, -1), ...(url.port ? { networkPort: Number(url.port) } : {}) };
        } else throw new Error();
        if (this.adapter.redactCliTitle(JSON.stringify(context), 8192) !== JSON.stringify(context)) throw new Error();
        const reason = typeof request.decision_reason === 'string' && request.decision_reason.trim()
          ? this.adapter.redactCliTitle(request.decision_reason, 4000)
          : `WorkBuddy CLI 正在等待 ${request.tool_name} 的本次执行授权。`;
        projection = { kind: 'approval', approval: { id: handle, toolName: request.tool_name, reason, ...(request.tool_use_id ? { callId: request.tool_use_id } : {}), context } };
        buildSessionReadResult({ id: entry.row.id, tool: 'workbuddy', title: entry.row.title, status: 'working', messages: [], canStop: true, pendingApprovals: [projection.approval] });
      }
      entry.pending.set(handle, projection);
    } catch { entry.client.decide(handle, { allowed: false, reason: 'This remote adapter cannot safely present the complete native request; no permission was granted' }); }
  }

  snapshot(id, session) {
    const entry = this.entries.get(id); if (!entry) return session;
    const pending = [...entry.pending].filter(([id]) => entry.client.permissions.has(id)).map(([, value]) => value);
    return { ...session, status: entry.client.status === 'working' ? 'working' : entry.client.status === 'error' || entry.client.terminal?.is_error === true ? 'error' : 'idle',
      canStop: !entry.client.closed && entry.client.status === 'working',
      ...(entry.client.currentModel ? { currentModel: { model: entry.client.currentModel } } : {}),
      pendingQuestions: pending.filter(item => item.kind === 'question').map(item => item.batch),
      pendingApprovals: pending.filter(item => item.kind === 'approval').map(item => item.approval) };
  }

  answer(id, handle, answers, hooks) {
    hooks?.checkActive?.(); this.auth(); assertAnswerBatch(answers, handle);
    const entry = this.entries.get(id); const pending = entry?.pending.get(handle); const native = entry?.client.permissions.get(handle);
    if (!native || pending?.kind !== 'question') throw new BridgeError('not_capable', 'This WorkBuddy question is no longer waiting');
    const questions = pending.batch.questions;
    if (answers.length !== questions.length) throw new BridgeError('invalid_params', 'Answer every question in the current batch');
    const mapped = {};
    for (const question of questions) {
      const answer = answers.find(item => item.id === question.id); const labels = question.options?.map(item => item.label) || [];
      if (!answer || answer.selected.some(label => !labels.includes(label)) || (!question.multiSelect && answer.selected.length > 1) || (!answer.selected.length && !answer.custom)) throw new BridgeError('invalid_params', 'The answer does not match the current WorkBuddy question');
      mapped[question.question] = [...answer.selected, ...(answer.custom ? [answer.custom] : [])].join(', ');
    }
    const result = entry.client.decide(handle, { allowed: true, updatedInput: { ...native.request.input, answers: mapped } });
    entry.pending.delete(handle); return result;
  }

  approve(id, handle, decision, hooks) {
    hooks?.checkActive?.(); this.auth();
    if (!['allow-once', 'reject'].includes(decision)) throw new BridgeError('invalid_params', 'Choose allow once or reject');
    const entry = this.entries.get(id);
    if (entry?.pending.get(handle)?.kind !== 'approval') throw new BridgeError('not_capable', 'This WorkBuddy permission is no longer waiting');
    const native = entry.client.permissions.get(handle);
    if (!native) throw new BridgeError('not_capable', 'This WorkBuddy permission is no longer waiting');
    const result = entry.client.decide(handle, decision === 'allow-once' ? { allowed: true, updatedInput: native.request.input } : { allowed: false, reason: 'User rejected this one action' });
    entry.pending.delete(handle); return result;
  }

  async stop(id, hooks) {
    hooks?.checkActive?.(); this.auth(); const entry = this.entries.get(id);
    if (!entry || entry.client.closed) throw new BridgeError('not_capable', 'There is no owned WorkBuddy background turn to stop');
    await entry.client.stop();
  }

  close() { this.retired = true; for (const entry of this.entries.values()) entry.client.close(); this.entries.clear(); this.busyCwds.clear(); }
}

module.exports = { WorkBuddyBackground };
