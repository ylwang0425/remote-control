'use strict';
/**
 * The local status and pairing page, on `127.0.0.1:18989`.
 *
 * What it is for: showing whether the relay link and the two adapters are up,
 * and letting the person at the computer mint a pairing code for their phone.
 *
 * What it deliberately is not:
 * - **not a remote control for the machine.** There is no shell, no exec, no
 *   file path and no command parameter anywhere in this surface. The only write
 *   it accepts is "make a pairing code".
 * - **not open to other origins.** Any request carrying a foreign `Origin` is
 *   refused, so a page the user happens to have open cannot talk to this server.
 * - **not writable without the CSRF token.** The token is handed out inside the
 *   HTML, which only a same-origin page can read; a write without it is refused.
 */

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

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
   * @param {string} [options.htmlPath]
   */
  constructor(options) {
    this.port = options.port ?? 18989;
    this.state = options.state ?? (() => ({}));
    this.onPairCreate = options.onPairCreate ?? null;
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
      req.on('data', (chunk) => {
        size += chunk.length;
        if (size > MAX_BODY_BYTES) {
          req.destroy();
          resolve(null);
          return;
        }
        chunks.push(chunk);
      });
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
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
    // Everything else - including anything that looks like a command surface -
    // is simply not there.
    json(res, 404, { ok: false, error: { code: 'not_found', message: 'not found' } });
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
    await this.readBody(req);
    const token = req.headers['x-csrf-token'];
    if (typeof token !== 'string' || token.length === 0 || !safeEqual(token, this.csrfToken)) {
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

module.exports = { LocalUiServer, ALLOWED_ORIGIN_PREFIX, BIND_ADDRESS };
