// mock-server.js — a REAL local HTTP server that speaks protocol-v1.
//
// MOCK LABEL: this stands in for the relay. It implements just enough of the
// frozen contract to drive the real UI: /health, /api/pair, /api/rpc,
// /api/logout, plus static hosting of mobile/web/.
//
// It exists for three jobs:
//   1. mobile/tests/workbench-server.test.js drives the REAL api.js over REAL
//      HTTP against it (real sockets, real cookies, real JSON) -- only the relay
//      is simulated, the client is the shipping one.
//   2. The Playwright run recorded in mobile/BUILD_REPORT.md loads the real page
//      from it, which is how the "does a same-origin POST carry Origin?" (M10)
//      question gets an empirical answer.
//   3. The workbench fixtures (models list, native current model, pending
//      questions, pending permission approvals, create/answer/approve results)
//      are injected here, so the exact same static bytes under mobile/web/ can be
//      exercised with clearly-labelled mock desktop state.
//
// Every fixture is OPTIONAL and the defaults are exactly the old ones: a caller
// that passes nothing gets the behaviour earlier revisions relied on.
//
// It enforces 5.3 exactly: a missing or non-matching Origin is a hard 403. That
// is what makes the Origin evidence meaningful.
'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const WEB_DIR = path.join(__dirname, '..', 'web');

const ALLOWED_ORIGIN = 'https://101.43.98.18';
const BODY_LIMITS = {
  '/api/me': 1024,
  '/api/pair': 4096,
  '/api/rpc': 65536,
  '/api/logout': 1024,
  '/api/admin/login': 4096,
  '/api/admin/computers': 1024,
  '/api/admin/logout': 1024,
  '/api/admin/rpc': 65536,
  '/api/admin/enrollment-codes': 1024
};
const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8'
};

const CAPABILITIES = {
  'sessions.list': true,
  'session.read': true,
  'session.send': true,
  'session.stop': true,
  'stop:codex': true,
  'stop:dsh': true,
  tools: ['codex', 'dsh']
};

const SESSIONS = [
  {
    id: 'a1', tool: 'codex', title: '重构 relay 的转发层', status: 'working',
    updatedAt: '2026-10-08T03:57:55Z', cwd: 'D:\\workspace\\codex-workspace\\remote-control'
  },
  {
    id: 'b2', tool: 'dsh', title: 'Fix login redirect', status: 'idle',
    updatedAt: '2026-10-08T02:00:00Z', cwd: null
  }
];

const DEFAULT_MESSAGES = [
  { id: 'm1', role: 'user', text: '帮我看看转发层', timestamp: '2026-10-08T03:55:02Z' },
  { id: 'm2', role: 'assistant', text: '我先读一下现有的转发代码。', timestamp: '2026-10-08T03:55:09Z' }
];

/** Bound one question batch exactly the way the contract does. */
function boundQuestions(batch) {
  return {
    callId: String(batch.callId),
    state: batch.state === 'continued' ? 'continued' : 'open',
    questions: (batch.questions || []).map((question) => Object.assign({}, question))
  };
}

/** Read the mock's mutable state out of `options` so tests can steer it. */
function createMockServer(options) {
  const opts = options || {};
  // 'strict'  -> enforce protocol-v1 5.3 (the shipping behaviour).
  // 'observe' -> skip the check but STILL record the raw Origin header. Used
  //              only by the M10 probe, where the browser is served from
  //              http://127.0.0.1:<port> and its Origin can never match
  //              https://101.43.98.18. The recorded value is the evidence.
  const originMode = opts.originMode || 'strict';
  const state = {
    // Every request that arrived, with the headers we care about. This is the
    // evidence log for the Origin question.
    log: [],
    // Every accepted RPC body, in order. The workbench fixtures are scripted
    // from these so a fixture can depend on the request it answers.
    rpcBodies: [],
    pairingCodes: new Map(opts.pairingCodes || [['K7QP3MZD9XTB2RCV6HNF0JWS', { used: false }]]),
    sessions: new Set(opts.sessionCookies || []),
    adminSessions: new Set(opts.adminCookies || []),
    adminCredentials: opts.adminCredentials || { username: 'admin', password: 'mock-admin-password' },
    identity: opts.identity || { clientId: 'client-user-1', ownerName: '测试用户', clientName: '测试电脑' },
    computers: (opts.computers || []).map((computer) => Object.assign({}, computer)),
    adminRpcCalls: [],
    enrollmentCode: opts.enrollmentCode || 'MOCK-ENROLLMENT-CODE',
    enrollmentExpiresAt: opts.enrollmentExpiresAt || '2026-10-11T12:00:00Z',
    bridgeOnline: opts.bridgeOnline === undefined ? true : opts.bridgeOnline,
    capabilityOverride: opts.capabilities || null,
    readResult: opts.readResult || null,
    // Optional desktop state. When set, these override the old canned answers.
    catalog: opts.catalog || null,
    modelsResult: opts.modelsResult || null,
    currentModel: opts.currentModel || null,
    pendingQuestions: opts.pendingQuestions || null,
    pendingApprovals: opts.pendingApprovals || null,
    createResult: opts.createResult || null,
    sendResult: opts.sendResult || null,
    stopResult: opts.stopResult || null,
    answerResult: opts.answerResult || null,
    approveResult: opts.approveResult || null,
    onAnswer: opts.onAnswer || null,
    onApprove: opts.onApprove || null,
    answered: [],
    approved: []
  };

  function json(res, status, body, extraHeaders) {
    const payload = JSON.stringify(body);
    const headers = Object.assign({
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      Vary: 'Origin, Cookie'
    }, extraHeaders || {});
    // protocol-v1 5.2 / 3.3: CORS headers must never appear.
    res.writeHead(status, headers);
    res.end(payload);
  }

  const fail = (res, status, code, message) => json(res, status, { ok: false, error: { code, message } });
  const business = (res, code, message) => json(res, 200, { ok: false, error: { code, message } });
  const succeed = (res, result) => json(res, 200, { ok: true, result });

  function readBody(req, limit) {
    return new Promise((resolve) => {
      let size = 0;
      const chunks = [];
      req.on('data', (chunk) => {
        size += chunk.length;
        if (size > limit) {
          resolve({ tooLarge: true });
          req.destroy();
          return;
        }
        chunks.push(chunk);
      });
      req.on('end', () => resolve({ size, text: Buffer.concat(chunks).toString('utf8') }));
      req.on('error', () => resolve({ tooLarge: false, text: '' }));
    });
  }

  function cookieSession(req) {
    const raw = req.headers.cookie || '';
    const match = /(?:^|;\s*)rc_session=([A-Za-z0-9_-]{43})/.exec(raw);
    return match ? match[1] : null;
  }

  function cookieAdmin(req) {
    const raw = req.headers.cookie || '';
    const match = /(?:^|;\s*)rc_admin=([A-Za-z0-9_-]{43})/.exec(raw);
    return match ? match[1] : null;
  }

  function originAllowed(req) {
    const origin = req.headers.origin;
    if (typeof origin !== 'string') return false;
    // 5.3: trim, lower-case, then byte-for-byte equal.
    return origin.trim().toLowerCase() === ALLOWED_ORIGIN;
  }

  function sessionReadResult(id) {
    const meta = SESSIONS.find((s) => s.id === id);
    if (!meta) return null;
    const result = {
      id: meta.id, tool: meta.tool, title: meta.title, status: meta.status,
      messages: DEFAULT_MESSAGES,
      canStop: meta.status === 'working'
    };
    if (meta.status === 'working') result.activeTurnId = 'turn-7';
    if (state.currentModel) result.currentModel = state.currentModel;
    if (state.pendingQuestions) result.pendingQuestions = state.pendingQuestions.map(boundQuestions);
    if (state.pendingApprovals) {
      result.pendingApprovals = state.pendingApprovals.map((approval) => Object.assign({}, approval));
    }
    return result;
  }

  /** Resolve a fixture: a value, a function of the request body, or null. */
  function scripted(fixture, body, fallback) {
    if (fixture === null || fixture === undefined) return fallback;
    return typeof fixture === 'function' ? fixture(body, state) : fixture;
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const route = url.pathname;

    state.log.push({
      method: req.method,
      path: route,
      origin: req.headers.origin === undefined ? null : req.headers.origin,
      contentType: req.headers['content-type'] || null,
      cookie: req.headers.cookie || null,
      at: Date.now()
    });

    // ---- probe-only endpoint: what did the browser actually send? ---------
    if (req.method === 'GET' && route === '/__requests') {
      return json(res, 200, { ok: true, requests: state.log, rpcBodies: state.rpcBodies });
    }

    // ---- probe-only page: the real-DOM sanitising probe -------------------
    // The page lives in mobile/tests/ while its /vendor/* and /js/* references
    // resolve to the real shipping files under mobile/web/, so the probe runs
    // against the same bytes the phone loads.
    if (req.method === 'GET' && route === '/__sanitize') {
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff'
      });
      return res.end(fs.readFileSync(path.join(__dirname, 'sanitize-probe.html')));
    }

    // ---- static hosting of the real UI (the seam product) -----------------
    if (req.method === 'GET' && !route.startsWith('/api/') && route !== '/health') {
      const rel = route === '/' ? 'index.html' : route.replace(/^\/+/, '');
      const file = path.join(WEB_DIR, rel);
      if (!file.startsWith(WEB_DIR) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
        return fail(res, 404, 'not_found', 'not found');
      }
      res.writeHead(200, {
        'Content-Type': CONTENT_TYPES[path.extname(file)] || 'application/octet-stream',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff'
      });
      return res.end(fs.readFileSync(file));
    }

    // ---- GET /health (no Origin check, 7.1) -------------------------------
    if (route === '/health') {
      if (req.method !== 'GET') return fail(res, 405, 'method_not_allowed', 'method not allowed');
      return json(res, 200, { ok: true, bridgeOnline: state.bridgeOnline });
    }

    if (!route.startsWith('/api/')) return fail(res, 404, 'not_found', 'not found');
    if (req.method !== 'POST') return fail(res, 405, 'method_not_allowed', 'method not allowed');
    if (originMode === 'strict' && !originAllowed(req)) {
      return fail(res, 403, 'origin_forbidden', 'origin not allowed');
    }
    if (!/^application\/json/i.test(req.headers['content-type'] || '')) {
      return fail(res, 415, 'unsupported_media_type', 'content type must be application/json');
    }
    const limit = BODY_LIMITS[route] || 1024;
    const body = await readBody(req, limit);
    if (body.tooLarge) return fail(res, 413, 'payload_too_large', 'request body too large');

    let parsed;
    try { parsed = JSON.parse(body.text || '{}'); } catch (err) {
      return fail(res, 400, 'invalid_json', 'invalid json body');
    }
    if (!parsed || typeof parsed !== 'object') return fail(res, 400, 'invalid_json', 'invalid json body');

    // Browser-readable identity/roster lookups use same-origin POSTs so the
    // browser supplies Origin to the relay's CSRF guard. They accept no fields.
    if (route === '/api/me') {
      if (Object.keys(parsed).length !== 0) return fail(res, 400, 'invalid_request', 'invalid request body');
      const admin = cookieAdmin(req);
      if (admin && state.adminSessions.has(admin)) return succeed(res, { role: 'admin' });
      const session = cookieSession(req);
      if (!session || !state.sessions.has(session)) return fail(res, 401, 'unauthenticated', 'unauthenticated');
      return succeed(res, Object.assign({ role: 'user' }, state.identity));
    }

    if (route === '/api/admin/computers') {
      if (Object.keys(parsed).length !== 0) return fail(res, 400, 'invalid_request', 'invalid request body');
      const admin = cookieAdmin(req);
      if (!admin || !state.adminSessions.has(admin)) return fail(res, 401, 'unauthenticated', 'unauthenticated');
      return succeed(res, { computers: state.computers });
    }

    // ---- POST /api/admin/login: independent administrator cookie ---------
    if (route === '/api/admin/login') {
      if (parsed.username !== state.adminCredentials.username || parsed.password !== state.adminCredentials.password) {
        return fail(res, 401, 'invalid_credentials', 'invalid administrator credentials');
      }
      const admin = cryptoRandom();
      state.adminSessions.add(admin);
      return json(res, 200, { ok: true, result: { role: 'admin' } }, {
        'Set-Cookie': 'rc_admin=' + admin + '; Path=/; HttpOnly; Secure; SameSite=Strict'
      });
    }

    // ---- POST /api/pair (7.2) --------------------------------------------
    if (route === '/api/pair') {
      if (typeof parsed.code !== 'string') return fail(res, 400, 'invalid_request', 'invalid request body');
      const normalized = String(parsed.code).replace(/[\s-]/g, '').toUpperCase()
        .replace(/O/g, '0').replace(/[IL]/g, '1').replace(/U/g, 'V');
      if (normalized.length !== 24 || !/^[0-9A-HJKMNP-TV-Z]+$/.test(normalized)) {
        return fail(res, 401, 'invalid_credentials', 'pairing code is not valid');
      }
      const record = state.pairingCodes.get(normalized);
      if (!record) return fail(res, 404, 'not_found', 'not found');
      if (record.used) return fail(res, 401, 'invalid_credentials', 'pairing code already used');
      record.used = true;
      const session = cryptoRandom();
      state.sessions.add(session);
      return json(res, 200, { ok: true }, {
        'Set-Cookie': 'rc_session=' + session + '; Path=/; Max-Age=2592000; HttpOnly; Secure; SameSite=Strict'
      });
    }

    // ---- Admin-only endpoints use the independent rc_admin cookie --------
    const admin = cookieAdmin(req);
    if (route === '/api/admin/logout') {
      if (!admin || !state.adminSessions.has(admin)) return fail(res, 401, 'unauthenticated', 'unauthenticated');
      state.adminSessions.delete(admin);
      return json(res, 200, { ok: true }, {
        'Set-Cookie': 'rc_admin=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict'
      });
    }
    if (route === '/api/admin/enrollment-codes') {
      if (!admin || !state.adminSessions.has(admin)) return fail(res, 401, 'unauthenticated', 'unauthenticated');
      return succeed(res, { code: state.enrollmentCode, expiresAt: state.enrollmentExpiresAt });
    }
    if (route === '/api/admin/rpc') {
      if (!admin || !state.adminSessions.has(admin)) return fail(res, 401, 'unauthenticated', 'unauthenticated');
      if (typeof parsed.clientId !== 'string' || typeof parsed.method !== 'string' ||
          !parsed.params || typeof parsed.params !== 'object' || Array.isArray(parsed.params)) {
        return fail(res, 400, 'invalid_request', 'invalid request body');
      }
      const computer = state.computers.find((row) => row.clientId === parsed.clientId);
      if (!computer) return fail(res, 503, 'target_offline', 'target offline or unavailable');
      state.adminRpcCalls.push({ clientId: parsed.clientId, method: parsed.method, params: parsed.params });
      if (computer.online !== true) return fail(res, 503, 'target_offline', 'target offline or unavailable');
      const method = parsed.method;
      const params = parsed.params;
      const allowedMethods = ['sessions.list', 'session.read', 'session.send', 'session.stop', 'models.list', 'session.create', 'session.answer', 'session.approve'];
      if (!allowedMethods.includes(method)) return business(res, 'unknown_method', 'unknown method');
      const configured = computer.rpcResults && computer.rpcResults[method];
      const configuredResult = typeof configured === 'function' ? configured(parsed, state, computer) : configured;
      if (configuredResult !== undefined) {
        return configuredResult && configuredResult.ok !== undefined
          ? json(res, 200, configuredResult)
          : succeed(res, configuredResult);
      }
      if (method === 'sessions.list') {
        return succeed(res, {
          sessions: computer.sessions || [],
          capabilities: computer.capabilities || { 'sessions.list': true, tools: [] }
        });
      }
      if (method === 'models.list') {
        const catalog = computer.catalogs && computer.catalogs[params.tool] || computer.catalog;
        if (catalog) return succeed(res, catalog);
        return business(res, 'not_capable', 'this tool does not support listing models');
      }
      if (method === 'session.read') {
        const reads = computer.reads || {};
        const read = reads[params.sessionId] || computer.readResult;
        if (read) return succeed(res, read);
        const session = (computer.sessions || []).find((row) => row.id === params.sessionId);
        if (!session) return business(res, 'session_not_found', 'not found');
        return succeed(res, Object.assign({ messages: [], canStop: false }, session));
      }
      if (method === 'session.create') {
        const created = computer.createResult;
        if (created) return succeed(res, typeof created === 'function' ? created(parsed, state, computer) : created);
        return business(res, 'session_create_failed', 'no create fixture configured');
      }
      if (method === 'session.send') return succeed(res, { accepted: true, sessionId: params.sessionId });
      if (method === 'session.stop') return succeed(res, { accepted: true, sessionId: params.sessionId });
      if (method === 'session.answer') {
        state.answered.push({ clientId: parsed.clientId, method, params });
        return succeed(res, { accepted: true, sessionId: params.sessionId, callId: params.callId });
      }
      if (method === 'session.approve') {
        state.approved.push({ clientId: parsed.clientId, method, params });
        return succeed(res, { accepted: true, sessionId: params.sessionId, approvalId: params.approvalId, state: 'submitted' });
      }
    }

    // Everything below needs a session cookie (7.3, 7.4).
    const session = cookieSession(req);
    if (!session || !state.sessions.has(session)) {
      return fail(res, 401, 'unauthenticated', 'unauthenticated');
    }

    // ---- POST /api/logout (7.4) ------------------------------------------
    if (route === '/api/logout') {
      state.sessions.delete(session);
      return json(res, 200, { ok: true }, {
        'Set-Cookie': 'rc_session=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict'
      });
    }

    // ---- POST /api/rpc (7.3) ---------------------------------------------
    if (route === '/api/rpc') {
      if (typeof parsed.method !== 'string') return fail(res, 400, 'invalid_request', 'invalid request body');
      const params = parsed.params || {};
      const whitelist = {
        'sessions.list': [],
        'session.read': ['tool', 'sessionId'],
        'session.send': ['tool', 'sessionId', 'text', 'model', 'provider', 'reasoningEffort'],
        'session.stop': ['tool', 'sessionId'],
        'models.list': ['tool'],
        'session.create': ['tool', 'model', 'provider', 'reasoningEffort', 'cwd', 'projectId', 'text', 'requestId'],
        'session.answer': ['tool', 'sessionId', 'callId', 'answers'],
        'session.approve': ['tool', 'sessionId', 'approvalId', 'decision']
      };
      if (!Object.prototype.hasOwnProperty.call(whitelist, parsed.method)) {
        return business(res, 'unknown_method', 'unknown method');
      }
      const allowed = whitelist[parsed.method];
      const extra = Object.keys(params).filter((k) => allowed.indexOf(k) === -1);
      if (extra.length > 0) {
        return business(res, 'invalid_params', 'invalid params');
      }
      state.rpcBodies.push(parsed);
      if (!state.bridgeOnline) {
        return fail(res, 503, 'bridge_offline', 'bridge offline');
      }

      if (parsed.method === 'sessions.list') {
        return succeed(res, {
          sessions: opts.sessions || SESSIONS,
          capabilities: state.capabilityOverride || CAPABILITIES
        });
      }

      if (parsed.method === 'session.read') {
        if (state.readResult) return succeed(res, state.readResult);
        const result = sessionReadResult(params.sessionId);
        if (!result) return business(res, 'session_not_found', 'not found');
        return succeed(res, result);
      }

      if (parsed.method === 'models.list') {
        if (state.modelsResult) return succeed(res, scripted(state.modelsResult, parsed, null));
        if (state.catalog) return succeed(res, state.catalog);
        return business(res, 'not_capable', 'this tool does not support listing models');
      }

      if (parsed.method === 'session.create') {
        if (!state.createResult) return business(res, 'session_create_failed', 'no create fixture configured');
        return succeed(res, scripted(state.createResult, parsed, null));
      }

      if (parsed.method === 'session.send') {
        if (typeof params.text !== 'string' || params.text === '') {
          return business(res, 'invalid_params', 'invalid params');
        }
        return succeed(res, scripted(state.sendResult, parsed, { accepted: true, sessionId: params.sessionId }));
      }

      if (parsed.method === 'session.stop') {
        return succeed(res, scripted(state.stopResult, parsed, { accepted: true, sessionId: params.sessionId }));
      }

      if (parsed.method === 'session.answer') {
        // The mock records the request, then a fixture decides the answer. The
        // default is a plain transport acceptance -- never "the user answered
        // it", which is what the UI must not claim either.
        if (typeof params.callId !== 'string' || !Array.isArray(params.answers)) {
          return business(res, 'invalid_params', 'invalid params');
        }
        state.answered.push(parsed);
        if (state.onAnswer) {
          const outcome = state.onAnswer(parsed, state);
          if (outcome === 'stale') return business(res, 'not_capable', 'this question is no longer active');
          if (outcome) return succeed(res, outcome);
        }
        if (state.answerResult) return succeed(res, scripted(state.answerResult, parsed, null));
        return succeed(res, { accepted: true, sessionId: params.sessionId, callId: params.callId });
      }

      if (parsed.method === 'session.approve') {
        if (typeof params.approvalId !== 'string' ||
            ['allow-once', 'reject'].indexOf(params.decision) === -1) {
          return business(res, 'invalid_params', 'invalid params');
        }
        state.approved.push(parsed);
        if (state.onApprove) {
          const outcome = state.onApprove(parsed, state);
          if (outcome === 'stale') return business(res, 'not_capable', 'this approval is no longer active');
          if (outcome) return succeed(res, outcome);
        }
        if (state.approveResult) return succeed(res, scripted(state.approveResult, parsed, null));
        return succeed(res, {
          accepted: true, sessionId: params.sessionId,
          approvalId: params.approvalId, state: 'submitted'
        });
      }
    }

    return fail(res, 404, 'not_found', 'not found');
  });

  function cryptoRandom() {
    // 32 random bytes as base64url without padding -> 43 chars (4.1).
    const bytes = require('node:crypto').randomBytes(32);
    return bytes.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  return {
    server,
    state,
    listen() {
      return new Promise((resolve) => {
        server.listen(0, '127.0.0.1', () => {
          const { port } = server.address();
          resolve('http://127.0.0.1:' + port);
        });
      });
    },
    close() {
      return new Promise((resolve) => server.close(resolve));
    }
  };
}

module.exports = { createMockServer, ALLOWED_ORIGIN, SESSIONS, CAPABILITIES };
