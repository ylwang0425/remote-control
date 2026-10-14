'use strict';

// Own one headless process from the locally installed WorkBuddy distribution.
// Account credentials and raw initialization replies never leave this module.
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { EventEmitter } = require('node:events');
const { randomUUID } = require('node:crypto');
const { StringDecoder } = require('node:string_decoder');
const { BridgeError } = require('../errors');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_FRAME_BYTES = 2 * 1024 * 1024;
const MAX_PENDING = 32;

function installedCli(executablePath) {
  if (process.platform !== 'win32' || !path.isAbsolute(executablePath || '') ||
      path.basename(executablePath).toLowerCase() !== 'workbuddy.exe') {
    throw new BridgeError('not_capable', 'Configure the installed WorkBuddy.exe before using its background CLI');
  }
  const entry = path.join(path.dirname(executablePath), 'resources', 'app.asar.unpacked', 'cli', 'bin', 'codebuddy');
  for (const file of [executablePath, entry]) {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new BridgeError('not_capable', 'WorkBuddy CLI installation is not a regular local file');
  }
  return { executablePath, entry };
}

class WorkBuddyCliClient extends EventEmitter {
  constructor({ executablePath, entry, configDir, cwd, sessionId, resume = false, model,
    token, accountId, authOnly = false, spawnProcess = spawn, requestTimeoutMs = 45000 }) {
    super();
    if (!authOnly && !UUID.test(sessionId || '')) throw new BridgeError('invalid_params', 'A background WorkBuddy turn needs an exact native UUID');
    this.sessionId = sessionId;
    this.accountId = accountId;
    this.closed = false;
    this.requests = new Map();
    this.permissions = new Map();
    this.buffer = '';
    this.decoder = new StringDecoder('utf8');
    this.requestTimeoutMs = requestTimeoutMs;
    this.authOnly = authOnly;
    this.status = 'starting';
    this.currentModel = null;
    this.terminal = null;
    const args = [entry, '--print', '--input-format', 'stream-json', '--output-format', 'stream-json',
      '--verbose', '--permission-mode', 'default', '--replay-user-messages'];
    if (authOnly) args.push('--no-session-persistence');
    else args.push(resume ? '--resume' : '--session-id', sessionId);
    if (model) args.push('--model', model);
    const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1', CODEBUDDY_CONFIG_DIR: configDir,
      WORKBUDDY_CONFIG_DIR: configDir, CODEBUDDY_CODE_ENTRYPOINT: 'sdk-ts', DISABLE_AUTOUPDATER: '1',
      // WorkBuddy distributions may contain only the lite bundle. Let the vendor
      // bootstrap select it first and use its own fallback on older installs.
      CODEBUDDY_FORCE_LITE_WB_BUNDLE: '1', CODEBUDDY_DISABLE_AUTO_MEMORY: '1' };
    // Use the official SDK login result; never read/decrypt another application's credentials.
    delete env.CODEBUDDY_AUTH_TOKEN;
    if (token) env.CODEBUDDY_AUTH_TOKEN = token;
    this.child = spawnProcess(executablePath, args, { cwd, env, windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
    this.child.stdout.on('data', bytes => this.consume(bytes));
    this.child.stdin.on('error', () => { if (!this.closed) this.fail('WorkBuddy background input channel ended'); });
    this.child.stderr.on('data', () => {}); // Vendor stderr may contain credentials and private paths.
    this.child.on('error', () => this.fail('WorkBuddy background CLI could not start'));
    this.child.on('exit', () => {
      if (!this.closed && this.terminal === null) this.fail('WorkBuddy background CLI exited before a terminal result');
      this.close();
    });
  }

  write(frame) {
    if (this.closed || this.child.stdin.destroyed) throw new BridgeError('bridge_error', 'WorkBuddy background process has ended');
    this.child.stdin.write(JSON.stringify(frame) + '\n');
  }

  request(request) {
    if (this.closed || this.requests.size >= MAX_PENDING) return Promise.reject(new BridgeError('bridge_error', 'WorkBuddy control channel is unavailable'));
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.requests.delete(id);
        reject(new BridgeError('bridge_error', 'WorkBuddy background control request timed out'));
      }, this.requestTimeoutMs);
      this.requests.set(id, { resolve, reject, timer });
      try { this.write({ type: 'control_request', request_id: id, request }); }
      catch (error) { clearTimeout(timer); this.requests.delete(id); reject(error); }
    });
  }

  respond(id, response) {
    this.write({ type: 'control_response', response: { subtype: 'success', request_id: id, response } });
  }

  async initialize() {
    const initialized = await this.request({ subtype: 'initialize', hasPrompt: !this.authOnly,
      capabilities: { askUserQuestion: true } });
    const account = initialized?.account;
    this.authenticated = typeof account?.userId === 'string' && typeof account?.token === 'string' && account.token.length > 0;
    this.accountMatches = this.authenticated && account.userId === this.accountId;
    const models = Array.isArray(initialized?.models) ? initialized.models : [];
    this.models = models.filter(m => m && typeof m.id === 'string' && /^[A-Za-z0-9._:/+-]{1,128}$/.test(m.id) &&
      typeof m.name === 'string' && m.name.length > 0 && m.name.length <= 180).slice(0, 128)
      .map(m => ({ id: m.id, label: m.name, isDefault: m.id === initialized.currentModelId }));
    this.currentModel = this.models.some(m => m.id === initialized?.currentModelId) ? initialized.currentModelId : null;
    if (!this.authOnly && !this.accountMatches) {
      this.close();
      throw new BridgeError('not_capable', 'WorkBuddy CLI needs an official login using the same desktop account');
    }
    this.status = 'idle';
    return { authenticated: this.authenticated, accountMatches: this.accountMatches, models: this.models, currentModel: this.currentModel };
  }

  authenticate() {
    if (!this.authOnly) throw new BridgeError('not_capable', 'Authentication is only available in the local login flow');
    // Authentication uses its own URL/result callbacks, not the control request acknowledgement.
    this.request({ subtype: 'authenticate', methodId: 'external' }).catch(() => {});
  }

  async send(text, model) {
    if (this.status !== 'idle' || this.closed) throw new BridgeError('bridge_error', 'This WorkBuddy background session is already running');
    if (!this.accountMatches) throw new BridgeError('not_capable', 'WorkBuddy CLI account is not verified');
    if (typeof text !== 'string' || !text.trim() || [...text].length > 65536) throw new BridgeError('invalid_params', 'A WorkBuddy message must be non-empty and bounded');
    if (model) {
      if (!this.models.some(m => m.id === model)) throw new BridgeError('invalid_params', 'The selected model is not in the authenticated WorkBuddy CLI catalog');
      if (model !== this.currentModel) {
        await this.request({ subtype: 'set_model', session_id: this.sessionId, model });
        this.currentModel = model;
      }
    }
    this.terminal = null;
    this.status = 'working';
    this.turnId = randomUUID();
    this.write({ type: 'user', session_id: this.sessionId, message: { role: 'user', content: text }, parent_tool_use_id: null });
  }

  consume(bytes) {
    if (this.closed) return;
    this.buffer += this.decoder.write(bytes);
    for (;;) {
      const end = this.buffer.indexOf('\n');
      if (end < 0) {
        if (Buffer.byteLength(this.buffer) > MAX_FRAME_BYTES) this.fail('WorkBuddy CLI sent an oversized frame');
        return;
      }
      const line = this.buffer.slice(0, end); this.buffer = this.buffer.slice(end + 1);
      if (Buffer.byteLength(line) > MAX_FRAME_BYTES) { this.fail('WorkBuddy CLI sent an oversized frame'); return; }
      let frame;
      try { frame = JSON.parse(line); } catch { continue; }
      if (!frame || typeof frame !== 'object') continue;
      try { this.onFrame(frame); } catch { this.fail('WorkBuddy background frame could not be processed'); }
      if (this.closed) return;
    }
  }

  onFrame(frame) {
    if (frame.type === 'control_response') {
      const response = frame.response;
      const item = this.requests.get(response?.request_id);
      if (!item) return;
      this.requests.delete(response.request_id); clearTimeout(item.timer);
      if (response.subtype === 'success') item.resolve(response.response);
      else item.reject(new BridgeError('bridge_error', 'WorkBuddy refused the background control request'));
      return;
    }
    if (frame.type === 'control_request') {
      const request = frame.request || {};
      if (request.subtype === 'elicitation_create') { this.respond(frame.request_id, { action: 'cancel' }); return; }
      if (this.authOnly && request.subtype === 'auth_url_callback') {
        let url;
        try { url = new URL(request.authState?.authUrl); } catch { return this.fail('WorkBuddy login URL is invalid'); }
        if (url.protocol !== 'https:' || url.hostname !== 'www.workbuddy.cn' || url.username || url.password) return this.fail('WorkBuddy login URL is not the official domain');
        this.respond(frame.request_id, { received: true }); this.emit('authUrl', url.href); return;
      }
      if (this.authOnly && request.subtype === 'auth_result_callback') {
        this.respond(frame.request_id, { handled: true });
        const info = request.userinfo;
        const matches = request.success === true && info?.userId === this.accountId && typeof info.token === 'string' && info.token.length > 0;
        this.emit('authState', { success: request.success === true, accountMatches: info?.userId === this.accountId,
          credentialPresent: typeof info?.token === 'string' && info.token.length > 0,
          failureType: typeof request.error?.type === 'string' ? request.error.type : null });
        this.emit('authResult', matches ? { userId: info.userId, token: info.token } : null);
        return;
      }
      if (!this.authOnly && this.status === 'working' && request.subtype === 'can_use_tool' && this.permissions.size < MAX_PENDING) {
        const handle = randomUUID();
        this.permissions.set(handle, { nativeId: frame.request_id, request, turnId: this.turnId });
        this.emit('permission', { handle, request }); return;
      }
      this.respond(frame.request_id, { allowed: false, reason: 'Unsupported or inactive remote request', tool_use_id: request.tool_use_id });
      return;
    }
    if (frame.type === 'control_cancel_request') {
      for (const [handle, item] of this.permissions) if (item.nativeId === frame.request_id) this.permissions.delete(handle);
      return;
    }
    if (this.authOnly) return;
    if (typeof frame.session_id === 'string' && frame.session_id && frame.session_id !== this.sessionId) return this.fail('WorkBuddy returned a different conversation UUID');
    if (frame.type === 'system' && frame.subtype === 'init' && typeof frame.model === 'string' && this.models?.some(m => m.id === frame.model)) this.currentModel = frame.model;
    if (frame.type === 'result') {
      this.status = 'idle'; this.permissions.clear(); this.terminal = frame;
      this.emit('terminal', frame);
    } else if (['user', 'assistant', 'stream_event', 'system'].includes(frame.type)) this.emit('frame', frame);
  }

  decide(handle, response) {
    const item = this.permissions.get(handle);
    if (!item || item.turnId !== this.turnId || this.status !== 'working' || this.closed) throw new BridgeError('not_capable', 'This WorkBuddy request is no longer waiting');
    this.respond(item.nativeId, { ...response, tool_use_id: item.request.tool_use_id });
    this.permissions.delete(handle);
    return { state: 'submitted' };
  }

  async stop() {
    if (this.status !== 'working') throw new BridgeError('not_capable', 'This WorkBuddy background turn is not running');
    for (const handle of [...this.permissions.keys()]) this.decide(handle, { allowed: false, reason: 'User stopped the current turn', interrupt: true });
    await this.request({ subtype: 'interrupt', session_id: this.sessionId, reason: 'User requested stop from AI Remote' });
  }

  fail(message) {
    this.status = 'error'; this.emit('failure', new BridgeError('bridge_error', message)); this.close();
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.permissions.clear();
    for (const item of this.requests.values()) { clearTimeout(item.timer); item.reject(new BridgeError('bridge_error', 'WorkBuddy background process ended')); }
    this.requests.clear(); this.child.stdin.end();
    const timer = setTimeout(() => { if (this.child.exitCode === null) this.child.kill(); }, 1500);
    timer.unref();
  }
}

module.exports = { WorkBuddyCliClient, installedCli };
