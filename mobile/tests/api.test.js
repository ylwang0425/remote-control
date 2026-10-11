// Unit tests for mobile/web/js/api.js — the HTTP client of the mobile UI.
//
// MOCK LABEL: everything in this file is driven by an injected fake `fetch`
// (tests/api.test.js builds the canned responses itself). NO real network
// request is made here. The real end-to-end HTTP behaviour is covered by
// mobile/tests/mock-server.test.js (a real local HTTP server) and by the
// Playwright run recorded in mobile/BUILD_REPORT.md.
//
// Run with:  D:\env\node.exe --test mobile/tests/api.test.js
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const api = require(path.join(__dirname, '..', 'web', 'js', 'api.js'));

/** Build a fake fetch that records every call and replays one canned response. */
function fakeFetch(response) {
  const calls = [];
  const impl = function (url, init) {
    calls.push({ url: url, init: init });
    if (response instanceof Error) {
      return Promise.reject(response);
    }
    return Promise.resolve({
      status: response.status,
      json: function () {
        return response.body === undefined
          ? Promise.reject(new Error('not json'))
          : Promise.resolve(response.body);
      }
    });
  };
  impl.calls = calls;
  return impl;
}

test('pair posts exactly {code, deviceName} as same-origin JSON with cookies', async () => {
  const f = fakeFetch({ status: 200, body: { ok: true } });
  const client = api.createApi({ fetch: f });
  const out = await client.pair('K7QP-3MZD-9XTB-2RCV-6HNF-0JWS', 'Pixel 8');

  assert.equal(f.calls.length, 1);
  const call = f.calls[0];
  // Seam rule: root-relative path only, never an absolute host.
  assert.equal(call.url, '/api/pair');
  assert.ok(!/^https?:/i.test(call.url), 'must not hard-code a backend origin');
  assert.equal(call.init.method, 'POST');
  assert.equal(call.init.headers['Content-Type'], 'application/json');
  assert.equal(call.init.credentials, 'include');
  // protocol-v1 7.2: the body has these two fields, and no others.
  assert.deepEqual(JSON.parse(call.init.body), {
    code: 'K7QP-3MZD-9XTB-2RCV-6HNF-0JWS',
    deviceName: 'Pixel 8'
  });
  assert.equal(out.ok, true);
});

test('pair surfaces the 6.1 error body of a rejected pairing', async () => {
  const f = fakeFetch({
    status: 401,
    body: { ok: false, error: { code: 'invalid_credentials', message: 'pairing code has expired' } }
  });
  const client = api.createApi({ fetch: f });
  const out = await client.pair('BAD', 'Pixel 8');
  assert.equal(out.ok, false);
  assert.equal(out.code, 'invalid_credentials');
  assert.equal(out.message, 'pairing code has expired');
  assert.equal(out.status, 401);
});

test('rpc posts {method, params} to /api/rpc', async () => {
  const f = fakeFetch({ status: 200, body: { ok: true, result: { sessions: [], capabilities: {} } } });
  const client = api.createApi({ fetch: f });
  const out = await client.rpc({ method: 'sessions.list', params: {} });

  const call = f.calls[0];
  assert.equal(call.url, '/api/rpc');
  assert.equal(call.init.method, 'POST');
  assert.equal(call.init.headers['Content-Type'], 'application/json');
  assert.equal(call.init.credentials, 'include');
  assert.deepEqual(JSON.parse(call.init.body), { method: 'sessions.list', params: {} });

  assert.equal(out.ok, true);
  assert.deepEqual(out.result, { sessions: [], capabilities: {} });
});

test('a business error arrives as HTTP 200 + ok:false (protocol-v1 6.1)', async () => {
  const f = fakeFetch({
    status: 200,
    body: { ok: false, error: { code: 'bridge_offline', message: 'bridge offline' } }
  });
  const client = api.createApi({ fetch: f });
  const out = await client.rpc({ method: 'sessions.list', params: {} });
  // The transport said 200; the business layer said no. The client must branch
  // on `ok`, not on the HTTP status.
  assert.equal(out.ok, false);
  assert.equal(out.code, 'bridge_offline');
  assert.equal(out.status, 200);
});

test('a transport failure becomes a client-side error with no protocol code', async () => {
  const f = fakeFetch(new TypeError('Failed to fetch'));
  const client = api.createApi({ fetch: f });
  const out = await client.rpc({ method: 'sessions.list', params: {} });
  assert.equal(out.ok, false);
  // No contract error code exists for "the phone has no network", so `code`
  // stays null and the message is already human-readable Chinese.
  assert.equal(out.code, null);
  assert.match(out.message, /网络|离线/);
});

test('a non-contract response body is rejected instead of guessed at', async () => {
  const f = fakeFetch({ status: 502, body: undefined }); // e.g. an HTML error page
  const client = api.createApi({ fetch: f });
  const out = await client.rpc({ method: 'sessions.list', params: {} });
  assert.equal(out.ok, false);
  assert.equal(out.code, null);
  assert.equal(out.status, 502);
  assert.match(out.message, /无法识别/);
});

test('health is a GET on the relative /health path', async () => {
  const f = fakeFetch({ status: 200, body: { ok: true, bridgeOnline: true } });
  const client = api.createApi({ fetch: f });
  const out = await client.health();
  assert.equal(f.calls[0].url, '/health');
  assert.equal(f.calls[0].init.method, 'GET');
  assert.equal(out.ok, true);
  assert.equal(out.result.bridgeOnline, true);
});

test('logout posts to /api/logout with an empty body', async () => {
  const f = fakeFetch({ status: 200, body: { ok: true } });
  const client = api.createApi({ fetch: f });
  await client.logout();
  assert.equal(f.calls[0].url, '/api/logout');
  assert.equal(f.calls[0].init.method, 'POST');
  assert.deepEqual(JSON.parse(f.calls[0].init.body), {});
});

test('identity and admin roster use same-origin empty JSON POSTs with cookies', async () => {
  const f = fakeFetch({ status: 200, body: { ok: true, result: { role: 'admin' } } });
  const client = api.createApi({ fetch: f });
  const me = await client.me();
  const computers = await client.adminComputers();
  assert.equal(me.ok, true);
  assert.equal(f.calls[0].url, '/api/me');
  assert.equal(f.calls[0].init.method, 'POST');
  assert.equal(f.calls[0].init.credentials, 'include');
  assert.deepEqual(JSON.parse(f.calls[0].init.body), {});
  assert.equal(computers.ok, true);
  assert.equal(f.calls[1].url, '/api/admin/computers');
  assert.equal(f.calls[1].init.method, 'POST');
  assert.equal(f.calls[1].init.credentials, 'include');
  assert.deepEqual(JSON.parse(f.calls[1].init.body), {});
});

test('admin login and logout use their separate session endpoints', async () => {
  const f = fakeFetch({ status: 200, body: { ok: true, result: { role: 'admin' } } });
  const client = api.createApi({ fetch: f });
  await client.adminLogin('operator', 'one-time-password');
  await client.adminLogout();
  assert.equal(f.calls[0].url, '/api/admin/login');
  assert.equal(f.calls[0].init.method, 'POST');
  assert.equal(f.calls[0].init.credentials, 'include');
  assert.deepEqual(JSON.parse(f.calls[0].init.body), { username: 'operator', password: 'one-time-password' });
  assert.equal(f.calls[1].url, '/api/admin/logout');
  assert.deepEqual(JSON.parse(f.calls[1].init.body), {});
});

test('admin RPC always includes the exact selected computer ID', async () => {
  const f = fakeFetch({ status: 200, body: { ok: true, result: { sessions: [] } } });
  const client = api.createApi({ fetch: f });
  const body = { method: 'session.answer', params: { tool: 'workbuddy', sessionId: 'same-id', callId: 'call-a', answers: [] } };
  await client.adminRpc('computer-b', body);
  assert.equal(f.calls[0].url, '/api/admin/rpc');
  assert.deepEqual(JSON.parse(f.calls[0].init.body), {
    clientId: 'computer-b', method: 'session.answer', params: body.params
  });
});

test('enrollment code is generated only by the explicit admin action', async () => {
  const f = fakeFetch({ status: 200, body: { ok: true, result: { code: 'one-use', expiresAt: 'soon' } } });
  const client = api.createApi({ fetch: f });
  const out = await client.adminEnrollmentCodes();
  assert.equal(f.calls[0].url, '/api/admin/enrollment-codes');
  assert.deepEqual(JSON.parse(f.calls[0].init.body), {});
  assert.equal(out.result.code, 'one-use');
});

test('a hung request is aborted so polling can never stack forever', async () => {
  // fetch that never settles unless aborted
  const fetchImpl = function (url, init) {
    return new Promise(function (resolve, reject) {
      init.signal.addEventListener('abort', function () {
        const e = new Error('aborted');
        e.name = 'AbortError';
        reject(e);
      });
    });
  };
  const timers = [];
  const client = api.createApi({
    fetch: fetchImpl,
    setTimeout: function (fn, ms) {
      timers.push(fn);
      assert.equal(ms, 35000, 'client abort budget sits above the 30s server timeout');
      return timers.length;
    },
    clearTimeout: function () {}
  });
  const pending = client.rpc({ method: 'session.read', params: { tool: 'codex', sessionId: 'a1' } });
  assert.equal(timers.length, 1, 'a client-side abort timer must be armed');
  // Let the request actually start before the timer fires -- in production the
  // timer fires 35s later, long after fetch() has been called.
  await Promise.resolve();
  timers[0](); // fire the timeout
  const out = await pending;
  assert.equal(out.ok, false);
  assert.equal(out.code, null);
  assert.match(out.message, /超时/);
});
