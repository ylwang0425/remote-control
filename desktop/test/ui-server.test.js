'use strict';
/**
 * Tests for the local status/pairing UI (127.0.0.1:18989).
 *
 * The rules this page must obey (DoD D4, and the security shape of the bridge):
 * - it listens on loopback only;
 * - a request whose `Origin` is not the page's own origin is refused;
 * - every write needs the CSRF token that only the page can read;
 * - there is no shell, no file path and no command anywhere in the surface.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const { LocalUiServer, ALLOWED_ORIGIN_PREFIX } = require('../src/ui/server');
const { loadConfig, configPath, redactedConfig } = require('../src/config');
const { EnrollmentError } = require('../src/enrollment');

function request(port, options) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, method: options.method ?? 'GET', path: options.path ?? '/', headers: options.headers ?? {} },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => (body += chunk));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
      },
    );
    req.on('error', reject);
    if (options.body !== undefined) req.write(options.body);
    req.end();
  });
}

async function startUi(t, overrides = {}) {
  const server = new LocalUiServer({
    port: 0,
    state: () => ({
      bridge: { connected: true, clientName: 'DESKTOP-TEST', capabilities: { tools: ['codex', 'dsh'] } },
      codex: { pipe: '\\\\.\\pipe\\codex-browser-use-test', tools: 53, sessions: 10 },
      dsh: { port: 19387, pid: 46376, sessions: 445 },
      pairing: null,
    }),
    onPairCreate: async () => ({
      code: 'K7QP-3MZD-9XTB-2RCV-6HNF-0JWS',
      url: 'https://101.43.98.18/#pair=K7QP-3MZD-9XTB-2RCV-6HNF-0JWS',
      expiresAt: '2026-10-08T04:03:07Z',
    }),
    ...overrides,
  });
  const started = await server.start();
  t.after(() => server.stop());
  return { server, ...started };
}

test('a foreign Host header is refused: a rebound DNS name cannot reach this page', async (t) => {
  // A same-origin GET from a browser may carry no Origin at all, so Origin alone
  // cannot stop DNS rebinding: a domain that resolves to 127.0.0.1 would be able
  // to read the page (and the CSRF token in it). The Host header is what the
  // browser cannot lie about, so only the exact loopback hosts are accepted.
  const { port } = await startUi(t);
  for (const host of ['evil.example', 'evil.example:80', '127.0.0.1.evil.example', '127.0.0.1:1', 'localhost.evil.example']) {
    const response = await request(port, { path: '/api/status', headers: { Host: host } });
    assert.equal(response.status, 403, host);
    assert.equal(JSON.parse(response.body).error.code, 'host_forbidden');
  }
  for (const host of [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`, `LOCALHOST:${port}`]) {
    const response = await request(port, { path: '/api/status', headers: { Host: host } });
    assert.equal(response.status, 200, host);
  }
});

test('the page is served on loopback with the status JSON beside it', async (t) => {
  const { port } = await startUi(t);
  const page = await request(port, { path: '/' });
  assert.equal(page.status, 200);
  assert.match(page.headers['content-type'], /text\/html/);
  assert.match(page.body, /AI Remote/);
  assert.match(page.body, /id="ownerName" type="text" maxlength="128"/);
  const inlineScript = page.body.match(/<script>([\s\S]*?)<\/script>/)?.[1];
  assert.ok(inlineScript, 'the local page has its identity form script');
  assert.doesNotThrow(() => new Function(inlineScript), 'the inline page script parses');
  assert.match(page.headers['x-content-type-options'], /nosniff/);

  const status = await request(port, { path: '/api/status' });
  assert.equal(status.status, 200);
  const parsed = JSON.parse(status.body);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.bridge.connected, true);
  assert.equal(parsed.dsh.sessions, 445);
});

test('the page carries the CSRF token, and only same-origin reads may see it', async (t) => {
  const { port, csrfToken } = await startUi(t);
  const page = await request(port, { path: '/' });
  assert.ok(page.body.includes(csrfToken), 'the page is where the token is handed out');
  assert.ok(csrfToken.length >= 32);
});

test('a request from another origin is refused with origin_forbidden', async (t) => {
  const { port } = await startUi(t);
  for (const origin of ['http://evil.example', 'https://101.43.98.18', 'http://127.0.0.1:1', 'null']) {
    const response = await request(port, { path: '/api/status', headers: { Origin: origin } });
    assert.equal(response.status, 403, origin);
    assert.equal(JSON.parse(response.body).error.code, 'origin_forbidden');
  }
  const own = await request(port, { path: '/api/status', headers: { Origin: `${ALLOWED_ORIGIN_PREFIX}${port}` } });
  assert.equal(own.status, 200);
  const localhost = await request(port, { path: '/api/status', headers: { Origin: `http://localhost:${port}` } });
  assert.equal(localhost.status, 200);
});

test('a write without the CSRF token is refused, with it it works', async (t) => {
  const { port, csrfToken } = await startUi(t);
  const denied = await request(port, { method: 'POST', path: '/api/pair', headers: { Origin: `${ALLOWED_ORIGIN_PREFIX}${port}` } });
  assert.equal(denied.status, 403);
  assert.equal(JSON.parse(denied.body).error.code, 'csrf_required');

  const wrong = await request(port, {
    method: 'POST',
    path: '/api/pair',
    headers: { Origin: `${ALLOWED_ORIGIN_PREFIX}${port}`, 'X-CSRF-Token': 'not-the-token' },
  });
  assert.equal(wrong.status, 403);
  assert.equal(JSON.parse(wrong.body).error.code, 'csrf_required');

  const allowed = await request(port, {
    method: 'POST',
    path: '/api/pair',
    headers: { Origin: `${ALLOWED_ORIGIN_PREFIX}${port}`, 'X-CSRF-Token': csrfToken },
  });
  assert.equal(allowed.status, 200);
  const body = JSON.parse(allowed.body);
  assert.equal(body.ok, true);
  assert.match(body.code, /^[0-9A-HJKMNP-TV-Z]{4}(-[0-9A-HJKMNP-TV-Z]{4}){5}$/);
  assert.ok(body.url.startsWith('https://101.43.98.18/#pair='));
});

test('computer identity writes are CSRF-protected and never expose enrollment credentials', async (t) => {
  const clientId = '98c9e96b-5d91-4a04-8d89-e2bdd29e30a5';
  const received = [];
  const { port, csrfToken } = await startUi(t, {
    onIdentityUpdate: async ({ ownerName }) => ({ identity: { clientId, ownerName: ownerName.trim() }, helloUpdated: true }),
    onEnroll: async (input) => {
      received.push(input);
      return {
        identity: { clientId, ownerName: input.ownerName.trim() },
        relayUrl: 'wss://relay.example/bridge',
        connected: true,
        connecting: false,
        bridgeToken: 'must-not-reach-the-page',
      };
    },
  });
  const origin = `${ALLOWED_ORIGIN_PREFIX}${port}`;
  const denied = await request(port, {
    method: 'POST', path: '/api/identity', headers: { Origin: origin, 'Content-Type': 'application/json' },
    body: JSON.stringify({ ownerName: 'admin' }),
  });
  assert.equal(denied.status, 403);

  const saved = await request(port, {
    method: 'POST', path: '/api/identity',
    headers: { Origin: origin, 'X-CSRF-Token': csrfToken, 'Content-Type': 'application/json' },
    body: JSON.stringify({ ownerName: ' admin ' }),
  });
  assert.equal(saved.status, 200);
  assert.deepEqual(JSON.parse(saved.body), { ok: true, identity: { clientId, ownerName: 'admin' }, helloUpdated: true });

  const foreign = await request(port, {
    method: 'POST', path: '/api/enroll',
    headers: { Origin: 'https://evil.example', 'X-CSRF-Token': csrfToken, 'Content-Type': 'application/json' },
    body: JSON.stringify({ code: 'invitation', ownerName: 'admin', relayUrl: 'wss://relay.example/bridge' }),
  });
  assert.equal(foreign.status, 403);
  assert.deepEqual(received, [], 'a foreign origin cannot consume an invitation');

  const enrolled = await request(port, {
    method: 'POST', path: '/api/enroll',
    headers: { Origin: origin, 'X-CSRF-Token': csrfToken, 'Content-Type': 'application/json' },
    body: JSON.stringify({ code: 'one-use-secret', ownerName: 'admin', relayUrl: 'wss://relay.example/bridge' }),
  });
  assert.equal(enrolled.status, 200);
  assert.equal(received.length, 1);
  assert.equal(received[0].code, 'one-use-secret');
  assert.ok(!enrolled.body.includes('one-use-secret'));
  assert.ok(!enrolled.body.includes('must-not-reach-the-page'));
  assert.ok(!enrolled.body.includes('bridgeToken'));
  assert.deepEqual(JSON.parse(enrolled.body), {
    ok: true,
    identity: { clientId, ownerName: 'admin' },
    relayUrl: 'wss://relay.example/bridge',
    connected: true,
    connecting: false,
  });
});

test('oversized pairing requests are drained and rejected before consuming a code', async (t) => {
  let pairCalls = 0;
  const { port, csrfToken } = await startUi(t, {
    onPairCreate: async () => { pairCalls += 1; return { code: 'unused' }; },
  });
  const response = await request(port, {
    method: 'POST',
    path: '/api/pair',
    headers: {
      Origin: `${ALLOWED_ORIGIN_PREFIX}${port}`,
      'X-CSRF-Token': csrfToken,
      'Content-Length': '5000',
    },
    body: 'x'.repeat(5000),
  });
  assert.equal(response.status, 413);
  assert.equal(JSON.parse(response.body).error.code, 'body_too_large');
  assert.equal(pairCalls, 0);
});

test('computer identity endpoint rejects unknown fields and keeps error messages bounded', async (t) => {
  const { port, csrfToken } = await startUi(t, {
    onIdentityUpdate: async () => { throw new EnrollmentError('invalid_params', 'Computer name must be 1–64 printable characters.'); },
  });
  const headers = { Origin: `${ALLOWED_ORIGIN_PREFIX}${port}`, 'X-CSRF-Token': csrfToken, 'Content-Type': 'application/json' };
  const extra = await request(port, {
    method: 'POST', path: '/api/identity', headers, body: JSON.stringify({ ownerName: 'admin', bridgeToken: 'guess' }),
  });
  assert.equal(extra.status, 400);
  const invalid = await request(port, {
    method: 'POST', path: '/api/identity', headers, body: JSON.stringify({ ownerName: 'bad\nname' }),
  });
  assert.equal(invalid.status, 400);
  assert.match(JSON.parse(invalid.body).error.message, /printable/);
});

test('the pairing code is never cached and never logged by the response headers', async (t) => {
  const { port, csrfToken } = await startUi(t);
  const response = await request(port, {
    method: 'POST',
    path: '/api/pair',
    headers: { Origin: `${ALLOWED_ORIGIN_PREFIX}${port}`, 'X-CSRF-Token': csrfToken },
  });
  assert.equal(response.headers['cache-control'], 'no-store');
  assert.equal(response.headers['access-control-allow-origin'], undefined, 'no CORS headers, ever');
});

test('there is no shell, no exec and no path surface', async (t) => {
  const { port, csrfToken } = await startUi(t);
  const origin = `${ALLOWED_ORIGIN_PREFIX}${port}`;
  for (const path of ['/api/exec', '/api/shell', '/api/run', '/shell', '/api/files?path=C:\\']) {
    const response = await request(port, { path, headers: { Origin: origin } });
    assert.equal(response.status, 404, path);
  }
  for (const path of ['/api/exec', '/api/shell', '/api/run']) {
    const response = await request(port, {
      method: 'POST',
      path,
      headers: { Origin: origin, 'X-CSRF-Token': csrfToken },
      body: JSON.stringify({ cmd: 'calc.exe' }),
    });
    assert.equal(response.status, 404, `POST ${path}`);
  }
  const source = require('node:fs').readFileSync(require.resolve('../src/ui/server'), 'utf8');
  assert.ok(!/\bexecFile\b|\bspawn\b|child_process/.test(source), 'the UI server never imports a shell');
});

test('the server binds loopback only', async (t) => {
  const { server } = await startUi(t);
  assert.equal(server.address, '127.0.0.1');
});

test('an unknown method on a known write path is refused', async (t) => {
  const { port, csrfToken } = await startUi(t);
  const response = await request(port, {
    method: 'PUT',
    path: '/api/pair',
    headers: { Origin: `${ALLOWED_ORIGIN_PREFIX}${port}`, 'X-CSRF-Token': csrfToken },
  });
  assert.equal(response.status, 404);
});

test('config: defaults, file values and environment overrides', async () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const file = path.join(os.tmpdir(), `ai-remote-config-${Date.now()}.json`);
  fs.writeFileSync(
    file,
    JSON.stringify({ relayUrl: 'wss://example.test/bridge', bridgeToken: 'from-file-token', uiPort: 19999, tools: ['codex'] }),
  );
  try {
    const fromFile = loadConfig({ path: file, env: {} });
    assert.equal(fromFile.relayUrl, 'wss://example.test/bridge');
    assert.equal(fromFile.bridgeToken, 'from-file-token');
    assert.equal(fromFile.uiPort, 19999);
    assert.deepEqual(fromFile.tools, ['codex']);

    const fromEnv = loadConfig({ path: file, env: { AI_REMOTE_BRIDGE_TOKEN: 'from-env-token', AI_REMOTE_UI_PORT: '20001' } });
    assert.equal(fromEnv.bridgeToken, 'from-env-token');
    assert.equal(fromEnv.uiPort, 20001);
    assert.equal(fromEnv.bridgeTokenOverridden, true);

    const relayOverride = loadConfig({ path: file, env: { AI_REMOTE_RELAY_URL: '' } });
    assert.equal(relayOverride.relayUrlOverridden, true, 'even an empty explicit environment override must block a misleading enrollment');

    const missing = loadConfig({ path: path.join(os.tmpdir(), 'does-not-exist.json'), env: {} });
    assert.equal(missing.relayUrl, 'wss://101.43.98.18/bridge');
    assert.equal(missing.uiPort, 18989);
    assert.equal(missing.bridgeToken, null);

    const rendered = JSON.stringify(redactedConfig(fromFile));
    assert.ok(!rendered.includes('from-file-token'), 'the token never appears in a printable config');
    assert.equal(redactedConfig(fromFile).bridgeToken, '<set>');
    const contextConfig = redactedConfig({ ...fromFile, codex: { pipePath: null, contextThreadId: 'local-thread-id' } });
    assert.equal(contextConfig.codex.contextThreadId, '<set>', 'thread identifiers are not written to startup logs');
    assert.ok(configPath({ env: { AI_REMOTE_CONFIG: file } }).endsWith(path.basename(file)));
  } finally {
    fs.unlinkSync(file);
  }
});
