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

  // The server clamps its own RPC timeouts to at most 60s and defaults to 30s
  // (protocol-v1 7.3). The client budget sits just above the server's own
  // ceiling so a hung socket can never leave a request in flight forever --
  // the poller refuses to stack, so a never-settling request would silently
  // stop all polling.
  var CLIENT_TIMEOUT_MS = 35000;

  var PATHS = {
    health: '/health',
    pair: '/api/pair',
    rpc: '/api/rpc',
    logout: '/api/logout'
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
    function send(path, init) {
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
        }, timeoutMs);
      }
      return promise.then(function (out) {
        if (timer !== null) {
          clearTimeoutImpl(timer);
        }
        return out;
      });
    }

    function postJson(path, body) {
      return send(path, {
        method: 'POST',
        headers: JSON_HEADERS,
        // Same-origin fetch already sends the rc_session cookie; `include` makes
        // the intent explicit and keeps working behind a rewrite (protocol-v1 5.2).
        credentials: 'include',
        body: JSON.stringify(body === undefined ? {} : body)
      });
    }

    return {
      health: function () {
        return send(PATHS.health, { method: 'GET', credentials: 'include' });
      },
      // protocol-v1 7.2: exactly {code, deviceName}.
      pair: function (code, deviceName) {
        return postJson(PATHS.pair, { code: code, deviceName: deviceName });
      },
      // protocol-v1 7.3: exactly {method, params}.
      rpc: function (body) {
        return postJson(PATHS.rpc, { method: body.method, params: body.params || {} });
      },
      logout: function () {
        return postJson(PATHS.logout, {});
      },
      paths: PATHS
    };
  }

  return { createApi: createApi, PATHS: PATHS, CLIENT_TIMEOUT_MS: CLIENT_TIMEOUT_MS };
});
