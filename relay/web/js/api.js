/*!
 * api.js — HTTP client for the AI Remote mobile web UI.
 *
 * Same-origin only: every path is root-relative ("/api/pair"), so the page works
 * unchanged at the root of https://101.43.98.18/ and can never be pointed at a
 * different backend by editing the markup. See protocol-v1 7.
 *
 * Every call resolves to a plain result object and never rejects:
 *
 *   { ok: true,  result: <body or body.result> }
 *   { ok: false, code: <protocol-v1 6.2 code | null>, message: <Chinese text>, status: <HTTP status | null> }
 *
 * `code` is null when the failure has no protocol code — no network, a client
 * timeout, or a body that is not the 6.1 shape. Inventing a code there would
 * make the client look like it spoke a protocol the relay does not have.
 */
(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module && module.exports) {
    module.exports = api;
  }
  if (root) {
    root.RCApi = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // Ordinary RPCs keep the server's existing method budgets and this 35s client
  // guard. A narrowly scoped per-call override may use the server's 60s ceiling
  // with a longer client guard; other calls keep this default so one slow native
  // tool cannot stall the poller for unrelated sessions.
  var CLIENT_TIMEOUT_MS = 35000;
  var MAX_RPC_TIMEOUT_MS = 60000;
  var MIN_RPC_TIMEOUT_MS = 1000;
  var MAX_CLIENT_TIMEOUT_MS = 120000;

  var PATHS = {
    health: '/health',
    me: '/api/me',
    pair: '/api/pair',
    rpc: '/api/rpc',
    logout: '/api/logout',
    adminLogin: '/api/admin/login',
    adminLogout: '/api/admin/logout',
    adminComputers: '/api/admin/computers',
    adminRpc: '/api/admin/rpc',
    adminEnrollmentCodes: '/api/admin/enrollment-codes'
  };

  var JSON_HEADERS = { 'Content-Type': 'application/json' };

  function createApi(options) {
    var opts = options || {};
    var doFetch = opts.fetch || (typeof fetch === 'function' ? fetch.bind(root) : null);
    var setTimeoutImpl = opts.setTimeout || setTimeout;
    var clearTimeoutImpl = opts.clearTimeout || clearTimeout;
    var timeoutMs = typeof opts.timeoutMs === 'number' ? opts.timeoutMs : CLIENT_TIMEOUT_MS;

    if (!doFetch) {
      throw new Error('api.createApi needs a fetch implementation');
    }

    /** Turn a Response into the result shape above. Never throws. */
    function parse(response) {
      var status = response && typeof response.status === 'number' ? response.status : null;
      var bodyPromise;
      try {
        bodyPromise = response.json();
      } catch (err) {
        bodyPromise = Promise.reject(err);
      }
      return Promise.resolve(bodyPromise).then(
        function (body) {
          return interpret(status, body);
        },
        function () {
          // Not JSON at all: a proxy error page, an empty 502, ...
          return {
            ok: false,
            code: null,
            message: '服务器返回了无法识别的响应（HTTP ' + status + '）',
            status: status
          };
        }
      );
    }

    /**
     * protocol-v1 6.1: success is {"ok":true,...}; failure is
     * {"ok":false,"error":{"code","message"}} -- and for /api/rpc a business
     * failure still arrives with HTTP 200. So `ok` is the single branch point.
     */
    function interpret(status, body) {
      if (body && body.ok === true) {
        return { ok: true, result: body.result === undefined ? body : body.result, status: status };
      }
      if (body && body.ok === false && body.error && typeof body.error.code === 'string') {
        return {
          ok: false,
          code: body.error.code,
          message: typeof body.error.message === 'string' ? body.error.message : '',
          status: status
        };
      }
      return {
        ok: false,
        code: null,
        message: '服务器返回了无法识别的响应（HTTP ' + status + '）',
        status: status
      };
    }

    /** Run one request with a client-side abort budget. */
    function send(path, init, requestTimeoutMs) {
      var effectiveTimeoutMs = typeof requestTimeoutMs === 'number' ? requestTimeoutMs : timeoutMs;
      var controller = typeof AbortController === 'function' ? new AbortController() : null;
      var timer = null;
      var aborted = false;
      var requestInit = init;
      if (controller) {
        requestInit = Object.assign({}, init, { signal: controller.signal });
      }
      var promise = Promise.resolve()
        .then(function () {
          // The abort budget may already have expired while this call sat in the
          // microtask queue. AbortSignal never re-fires, so check it here too --
          // otherwise such a request would stay in flight forever and the
          // poller (which refuses to stack) would stop polling for good.
          if (controller && controller.signal.aborted) {
            var err = new Error('aborted');
            err.name = 'AbortError';
            throw err;
          }
          return doFetch(path, requestInit);
        })
        .then(parse, function (err) {
          if (aborted || (err && err.name === 'AbortError')) {
            return { ok: false, code: null, message: '请求超时，请检查网络后重试', status: null };
          }
          return { ok: false, code: null, message: '网络不可用或已离线，请检查网络后重试', status: null };
        });

      if (controller) {
        timer = setTimeoutImpl(function () {
          aborted = true;
          controller.abort();
        }, effectiveTimeoutMs);
      }
      return promise.then(function (out) {
        if (timer !== null) {
          clearTimeoutImpl(timer);
        }
        return out;
      });
    }

    function postJson(path, body, requestTimeoutMs) {
      return send(path, {
        method: 'POST',
        headers: JSON_HEADERS,
        // Same-origin fetch already sends the rc_session cookie; `include` makes
        // the intent explicit and keeps working behind a rewrite (protocol-v1 5.2).
        credentials: 'include',
        body: JSON.stringify(body === undefined ? {} : body)
      }, requestTimeoutMs);
    }

    /** Validate per-call budgets; timeoutMs stays at the HTTP envelope level. */
    function normalizeRpcOptions(options) {
      if (options === undefined) return { ok: true, value: {} };
      if (!options || typeof options !== 'object' || Array.isArray(options)) {
        return { ok: false, message: 'RPC options must be an object containing only timeoutMs and clientTimeoutMs' };
      }
      var keys = Object.keys(options);
      if (keys.some(function (key) { return key !== 'timeoutMs' && key !== 'clientTimeoutMs'; })) {
        return { ok: false, message: 'RPC options may contain only timeoutMs and clientTimeoutMs' };
      }
      var value = {};
      if (Object.prototype.hasOwnProperty.call(options, 'timeoutMs')) {
        if (!Number.isInteger(options.timeoutMs) || options.timeoutMs < MIN_RPC_TIMEOUT_MS || options.timeoutMs > MAX_RPC_TIMEOUT_MS) {
          return { ok: false, message: 'timeoutMs must be an integer between 1000 and 60000' };
        }
        value.timeoutMs = options.timeoutMs;
      }
      if (Object.prototype.hasOwnProperty.call(options, 'clientTimeoutMs')) {
        if (!Number.isInteger(options.clientTimeoutMs) || options.clientTimeoutMs < MIN_RPC_TIMEOUT_MS || options.clientTimeoutMs > MAX_CLIENT_TIMEOUT_MS) {
          return { ok: false, message: 'clientTimeoutMs must be an integer between 1000 and 120000' };
        }
        value.clientTimeoutMs = options.clientTimeoutMs;
      }
      if (value.timeoutMs !== undefined) {
        if (value.clientTimeoutMs !== undefined && value.clientTimeoutMs <= value.timeoutMs) {
          return { ok: false, message: 'clientTimeoutMs must be greater than timeoutMs' };
        }
        if (value.clientTimeoutMs === undefined && value.timeoutMs >= timeoutMs) {
          return { ok: false, message: 'clientTimeoutMs must exceed timeoutMs when the request timeout reaches the client default' };
        }
      }
      return { ok: true, value: value };
    }

    function invalidRpcOptions(message) {
      return Promise.resolve({ ok: false, code: null, message: message, status: null });
    }

    return {
      health: function () {
        return send(PATHS.health, { method: 'GET', credentials: 'include' });
      },
      me: function () {
        return postJson(PATHS.me, {});
      },
      // protocol-v1 7.2: exactly {code, deviceName}.
      pair: function (code, deviceName) {
        return postJson(PATHS.pair, { code: code, deviceName: deviceName });
      },
      // protocol-v1 7.3: {method, params} plus an optional top-level timeoutMs.
      // clientTimeoutMs is local-only and never crosses the wire.
      rpc: function (body, rpcOptions) {
        var normalized = normalizeRpcOptions(rpcOptions);
        if (!normalized.ok) return invalidRpcOptions(normalized.message);
        var requestBody = { method: body.method, params: body.params || {} };
        if (normalized.value.timeoutMs !== undefined) requestBody.timeoutMs = normalized.value.timeoutMs;
        return postJson(PATHS.rpc, requestBody, normalized.value.clientTimeoutMs);
      },
      adminLogin: function (username, password) {
        return postJson(PATHS.adminLogin, { username: username, password: password });
      },
      adminLogout: function () {
        return postJson(PATHS.adminLogout, {});
      },
      adminComputers: function () {
        return postJson(PATHS.adminComputers, {});
      },
      adminRpc: function (clientId, body, rpcOptions) {
        var normalized = normalizeRpcOptions(rpcOptions);
        if (!normalized.ok) return invalidRpcOptions(normalized.message);
        var requestBody = {
          clientId: clientId,
          method: body.method,
          params: body.params || {}
        };
        if (normalized.value.timeoutMs !== undefined) requestBody.timeoutMs = normalized.value.timeoutMs;
        return postJson(PATHS.adminRpc, requestBody, normalized.value.clientTimeoutMs);
      },
      adminEnrollmentCodes: function () {
        return postJson(PATHS.adminEnrollmentCodes, {});
      },
      logout: function () {
        return postJson(PATHS.logout, {});
      },
      paths: PATHS
    };
  }

  return { createApi: createApi, PATHS: PATHS, CLIENT_TIMEOUT_MS: CLIENT_TIMEOUT_MS };
});
