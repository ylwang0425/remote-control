'use strict';
/**
 * The local status and computer registration page, on `127.0.0.1:18989`.
 *
 * What it is for: showing whether the relay link and adapters are up, letting
 * the person at the computer name/enroll this machine, and minting a phone code.
 *
 * What it deliberately is not:
 * - **not a remote control for the machine.** There is no shell, no exec, no
 *   file path and no command parameter anywhere in this surface. Its writes are
 *   limited to identity settings, one explicit relay enrollment and pairing.
 * - **not open to other origins.** Any request carrying a foreign `Origin` is
 *   refused, so a page the user happens to have open cannot talk to this server.
 * - **not writable without the CSRF token.** The token is handed out inside the
 *   HTML, which only a same-origin page can read; a write without it is refused.
 */

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { validClientId } = require('../config');

const ALLOWED_ORIGIN_PREFIX = 'http://127.0.0.1:';
const ALLOWED_ORIGIN_ALIASES = ['http://localhost:', 'http://[::1]:'];
const BIND_ADDRESS = '127.0.0.1';
const MAX_BODY_BYTES = 4096;

function json(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
  });
  res.end(body);
}

class LocalUiServer {
  /**
   * @param {object} options
   * @param {number} [options.port] 0 picks a free port (tests)
   * @param {() => object} options.state current bridge/adapter state
   * @param {() => Promise<{code: string, url: string, expiresAt: string}>} [options.onPairCreate]
   * @param {(identity: {ownerName: string}) => Promise<object>} [options.onIdentityUpdate]
   * @param {(enrollment: {code: string, ownerName: string, relayUrl: string}) => Promise<object>} [options.onEnroll]
   * @param {(settings: {enabled: boolean, executablePath?: string}) => Promise<object>} [options.onWorkBuddyUiAutomationUpdate]
   * @param {string} [options.htmlPath]
   */
  constructor(options) {
    this.port = options.port ?? 18989;
    this.state = options.state ?? (() => ({}));
    this.onPairCreate = options.onPairCreate ?? null;
    this.onIdentityUpdate = options.onIdentityUpdate ?? null;
    this.onEnroll = options.onEnroll ?? null;
    this.onWorkBuddyUiAutomationUpdate = options.onWorkBuddyUiAutomationUpdate ?? null;
    this.onWorkBuddyBackgroundUpdate = options.onWorkBuddyBackgroundUpdate ?? null;
    this.htmlPath = options.htmlPath ?? path.join(__dirname, '..', '..', 'ui', 'index.html');
    this.csrfToken = crypto.randomBytes(32).toString('base64url');
    this.address = null;
    this.server = http.createServer((req, res) => this.onRequest(req, res));
  }

  /** @returns {Promise<{url: string, port: number, csrfToken: string}>} */
  start() {
    return new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(this.port, BIND_ADDRESS, () => {
        const address = this.server.address();
        this.address = address.address;
        this.port = address.port;
        resolve({ url: `http://${BIND_ADDRESS}:${address.port}`, port: address.port, csrfToken: this.csrfToken });
      });
    });
  }

  stop() {
    return new Promise((resolve) => {
      this.server.close(() => resolve());
    });
  }

  /** Where the page is allowed to come from: this exact loopback origin. */
  allowedOrigins() {
    return [`${ALLOWED_ORIGIN_PREFIX}${this.port}`, ...ALLOWED_ORIGIN_ALIASES.map((prefix) => `${prefix}${this.port}`)];
  }

  /**
   * The Host names this server answers to, exactly.
   *
   * A rebinding attack points a domain at 127.0.0.1 and then lets the browser
   * make a same-origin request; such a request may carry no `Origin` at all. The
   * `Host` header is the one the attacker cannot forge, so anything that is not
   * exactly one of these three names is refused. The comparison is exact: a
   * suffix or prefix match would let `127.0.0.1.evil.example` through.
   */
  allowedHosts() {
    return [`127.0.0.1:${this.port}`, `localhost:${this.port}`, `[::1]:${this.port}`];
  }

  hostAllowed(req) {
    const host = req.headers.host;
    if (typeof host !== 'string' || host.length === 0) {
      return false;
    }
    return this.allowedHosts().includes(host.trim().toLowerCase());
  }

  originAllowed(req) {
    const origin = req.headers.origin;
    if (origin === undefined) {
      // A browser same-origin GET may omit it; anything without an Origin that
      // asks for a write still needs the CSRF token below.
      return true;
    }
    return this.allowedOrigins().includes(String(origin).trim().toLowerCase().replace(/\/$/, ''));
  }

  readBody(req) {
    return new Promise((resolve) => {
      let size = 0;
      const chunks = [];
      let tooLarge = false;
      req.on('data', (chunk) => {
        size += chunk.length;
        if (size > MAX_BODY_BYTES) {
          tooLarge = true;
        } else if (!tooLarge) {
          chunks.push(chunk);
        }
      });
      req.on('end', () => resolve(tooLarge ? null : Buffer.concat(chunks).toString('utf8')));
    });
  }

  async onRequest(req, res) {
    const url = new URL(req.url, `http://${BIND_ADDRESS}:${this.port}`);
    if (!this.hostAllowed(req)) {
      json(res, 403, { ok: false, error: { code: 'host_forbidden', message: 'host not allowed' } });
      return;
    }
    if (!this.originAllowed(req)) {
      json(res, 403, { ok: false, error: { code: 'origin_forbidden', message: 'origin not allowed' } });
      return;
    }

    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      this.servePage(res);
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/status') {
      json(res, 200, { ok: true, ...this.state() });
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/pair') {
      await this.handlePair(req, res);
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/identity') {
      await this.handleIdentity(req, res);
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/workbuddy-ui-automation') {
      await this.handleWorkBuddyUiAutomation(req, res);
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/workbuddy-background') {
      await this.handleWorkBuddyBackground(req, res);
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/enroll') {
      await this.handleEnroll(req, res);
      return;
    }
    // Everything else - including anything that looks like a command surface -
    // is simply not there.
    json(res, 404, { ok: false, error: { code: 'not_found', message: 'not found' } });
  }

  hasCsrf(req) {
    const token = req.headers['x-csrf-token'];
    return typeof token === 'string' && token.length > 0 && safeEqual(token, this.csrfToken);
  }

  async readJsonBody(req, res) {
    if (!String(req.headers['content-type'] ?? '').toLowerCase().startsWith('application/json')) {
      json(res, 415, { ok: false, error: { code: 'json_required', message: 'send a JSON request body' } });
      return null;
    }
    const raw = await this.readBody(req);
    if (raw === null) {
      json(res, 413, { ok: false, error: { code: 'body_too_large', message: 'request body is too large' } });
      return null;
    }
    let value;
    try { value = JSON.parse(raw); } catch {
      json(res, 400, { ok: false, error: { code: 'invalid_json', message: 'request body must be valid JSON' } });
      return null;
    }
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      json(res, 400, { ok: false, error: { code: 'invalid_params', message: 'request body must be an object' } });
      return null;
    }
    return value;
  }

  async handleIdentity(req, res) {
    if (!this.hasCsrf(req)) {
      json(res, 403, { ok: false, error: { code: 'csrf_required', message: 'a CSRF token is required for writes' } });
      return;
    }
    const body = await this.readJsonBody(req, res);
    if (body === null) return;
    if (Object.keys(body).some((key) => key !== 'ownerName') || typeof body.ownerName !== 'string') {
      json(res, 400, { ok: false, error: { code: 'invalid_params', message: 'ownerName is required' } });
      return;
    }
    if (this.onIdentityUpdate === null) {
      json(res, 503, { ok: false, error: { code: 'identity_unavailable', message: 'computer registration is not available' } });
      return;
    }
    try {
      const updated = await this.onIdentityUpdate({ ownerName: body.ownerName });
      json(res, 200, {
        ok: true,
        identity: publicIdentity(updated?.identity),
        helloUpdated: updated?.helloUpdated === true,
      });
    } catch (error) {
      this.actionFailure(res, error, 'Could not save the computer name.');
    }
  }

  async handleWorkBuddyUiAutomation(req, res) {
    if (!this.hasCsrf(req)) {
      json(res, 403, { ok: false, error: { code: 'csrf_required', message: 'a CSRF token is required for writes' } });
      return;
    }
    const body = await this.readJsonBody(req, res);
    if (body === null) return;
    const allowedKeys = new Set(['enabled', 'executablePath']);
    if (Object.keys(body).some((key) => !allowedKeys.has(key)) || typeof body.enabled !== 'boolean' ||
        (Object.hasOwn(body, 'executablePath') &&
          (typeof body.executablePath !== 'string' || body.executablePath.length === 0 || body.executablePath.length > 2048))) {
      json(res, 400, { ok: false, error: { code: 'invalid_params', message: 'enabled and an optional absolute WorkBuddy.exe path are required' } });
      return;
    }
    if (this.onWorkBuddyUiAutomationUpdate === null) {
      json(res, 503, { ok: false, error: { code: 'workbuddy_settings_unavailable', message: 'local WorkBuddy settings are not available' } });
      return;
    }
    try {
      const updated = await this.onWorkBuddyUiAutomationUpdate({
        enabled: body.enabled,
        ...(Object.hasOwn(body, 'executablePath') ? { executablePath: body.executablePath } : {}),
      });
      json(res, 200, {
        ok: true,
        uiAutomation: {
          enabled: updated?.uiAutomation?.enabled === true,
          executablePathConfigured: updated?.uiAutomation?.executablePathConfigured === true,
          configurationValid: updated?.uiAutomation?.configurationValid === true,
        },
        workbuddyAvailable: updated?.workbuddyAvailable === true,
          readOnly: typeof updated?.readOnly === 'boolean' ? updated.readOnly : null,
        capabilitiesUpdated: updated?.capabilitiesUpdated === true,
      });
    } catch (error) {
      this.actionFailure(res, error, 'Could not save the local WorkBuddy settings.');
    }
  }

  async handleWorkBuddyBackground(req, res) {
    if (!this.hasCsrf(req)) { json(res, 403, { ok: false, error: { code: 'csrf_required', message: 'a CSRF token is required for writes' } }); return; }
    const body = await this.readJsonBody(req, res);
    if (body === null) return;
    if (Object.keys(body).some(key => !['action', 'executablePath'].includes(key)) || !['login', 'enable', 'disable'].includes(body.action) ||
        (Object.hasOwn(body, 'executablePath') && typeof body.executablePath !== 'string')) {
      json(res, 400, { ok: false, error: { code: 'invalid_params', message: 'Choose login, enable or disable for the local WorkBuddy background adapter' } }); return;
    }
    if (this.onWorkBuddyBackgroundUpdate === null) { json(res, 503, { ok: false, error: { code: 'workbuddy_settings_unavailable', message: 'WorkBuddy background settings are not available' } }); return; }
    try {
      const value = await this.onWorkBuddyBackgroundUpdate(body);
      let authUrl;
      if (value?.authUrl) {
        const url = new URL(value.authUrl);
        if (url.protocol !== 'https:' || url.hostname !== 'www.workbuddy.cn' || url.username || url.password) throw new Error();
        authUrl = url.href;
      }
      json(res, 200, { ok: true, enabled: value?.enabled === true, state: typeof value?.state === 'string' ? value.state : 'idle', ...(authUrl ? { authUrl } : {}) });
    } catch (error) { this.actionFailure(res, error, 'Could not update WorkBuddy background settings.'); }
  }

  async handleEnroll(req, res) {
    if (!this.hasCsrf(req)) {
      json(res, 403, { ok: false, error: { code: 'csrf_required', message: 'a CSRF token is required for writes' } });
      return;
    }
    const body = await this.readJsonBody(req, res);
    if (body === null) return;
    if (Object.keys(body).some((key) => !['code', 'ownerName', 'relayUrl'].includes(key)) ||
        typeof body.code !== 'string' || typeof body.ownerName !== 'string' || typeof body.relayUrl !== 'string') {
      json(res, 400, { ok: false, error: { code: 'invalid_params', message: 'code, ownerName and relayUrl are required' } });
      return;
    }
    if (this.onEnroll === null) {
      json(res, 503, { ok: false, error: { code: 'enrollment_unavailable', message: 'computer enrollment is not available' } });
      return;
    }
    try {
      const enrolled = await this.onEnroll({ code: body.code, ownerName: body.ownerName, relayUrl: body.relayUrl });
      json(res, 200, {
        ok: true,
        identity: publicIdentity(enrolled?.identity),
        relayUrl: typeof enrolled?.relayUrl === 'string' && enrolled.relayUrl.length <= 2048 ? enrolled.relayUrl : '',
        connected: enrolled?.connected === true,
        connecting: enrolled?.connecting === true,
      });
    } catch (error) {
      this.actionFailure(res, error, 'Could not enroll this computer.');
    }
  }

  actionFailure(res, error, fallback) {
    const status = Number.isInteger(error?.statusCode) && error.statusCode >= 400 && error.statusCode <= 599 ? error.statusCode : 500;
    const code = typeof error?.code === 'string' && /^[a-z_]{1,40}$/.test(error.code) ? error.code : 'operation_failed';
    const message = status < 500 && typeof error?.message === 'string' ? error.message : fallback;
    json(res, status, { ok: false, error: { code, message } });
  }

  servePage(res) {
    let html;
    try {
      html = fs.readFileSync(this.htmlPath, 'utf8');
    } catch {
      json(res, 500, { ok: false, error: { code: 'internal', message: 'the local page is missing' } });
      return;
    }
    const body = html.replaceAll('__CSRF_TOKEN__', this.csrfToken);
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Length': Buffer.byteLength(body),
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'no-referrer',
      'Content-Security-Policy':
        "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'; " +
        "style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:",
    });
    res.end(body);
  }

  async handlePair(req, res) {
    const body = await this.readBody(req);
    if (body === null) {
      json(res, 413, { ok: false, error: { code: 'body_too_large', message: 'request body is too large' } });
      return;
    }
    if (!this.hasCsrf(req)) {
      json(res, 403, { ok: false, error: { code: 'csrf_required', message: 'a CSRF token is required for writes' } });
      return;
    }
    if (this.onPairCreate === null) {
      json(res, 503, { ok: false, error: { code: 'bridge_offline', message: 'the relay link is not up yet' } });
      return;
    }
    try {
      const created = await this.onPairCreate();
      json(res, 200, { ok: true, ...created });
    } catch (error) {
      json(res, 502, { ok: false, error: { code: 'bridge_error', message: 'the relay did not answer' } });
    }
  }
}

function safeEqual(a, b) {
  const left = Buffer.from(String(a), 'utf8');
  const right = Buffer.from(String(b), 'utf8');
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function publicIdentity(value) {
  if (value === null || typeof value !== 'object' || !validClientId(value.clientId) || typeof value.ownerName !== 'string') {
    return null;
  }
  return { clientId: value.clientId, ownerName: value.ownerName };
}

module.exports = { LocalUiServer, ALLOWED_ORIGIN_PREFIX, BIND_ADDRESS };
