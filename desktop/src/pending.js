'use strict';
/**
 * Bounded pending-request registry, protocol-v1 §10.2.
 *
 * One entry per `request` frame the relay sent us. At most `maxPending` (16, per
 * the contract) entries exist at once; a 17th request is refused, never queued.
 * Every id is answered at most once, and after the local deadline the id is
 * gone for good: a late `response` from us is simply never sent, and a late
 * relay frame for that id is dropped. Nothing is retried, ever - that is what
 * keeps `session.send` from double-posting a message.
 */

/** Per-connection pending limit, protocol-v1 §10.2. */
const MAX_PENDING = 16;

/** Default RPC budget when the relay does not state one, protocol-v1 §7.3. */
const DEFAULT_TIMEOUT_MS = 30000;

function deadlineError(id) {
  const err = new Error(`request ${id} exceeded its deadline`);
  err.code = 'bridge_timeout';
  err.id = id;
  return err;
}

class PendingRegistry {
  /** @param {{maxPending?: number}} [options] */
  constructor(options = {}) {
    this.maxPending = options.maxPending ?? MAX_PENDING;
    this.entries = new Map();
  }

  get size() {
    return this.entries.size;
  }

  /** Number of live deadline timers; used by tests to prove cleanup. */
  get activeTimers() {
    let count = 0;
    for (const entry of this.entries.values()) {
      if (entry.timer !== null) {
        count += 1;
      }
    }
    return count;
  }

  has(id) {
    return this.entries.has(id);
  }

  /**
   * Register a pending request.
   * @param {string} id the relay-generated request id
   * @param {{method?: string, timeoutMs?: number}} [options]
   * @returns {Promise<unknown>|null} null when the connection is already full
   */
  add(id, options = {}) {
    if (this.entries.has(id)) {
      return null;
    }
    if (this.entries.size >= this.maxPending) {
      return null;
    }
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const entry = { method: options.method ?? null, timer: null, resolve: null, reject: null };
    const promise = new Promise((resolve, reject) => {
      entry.resolve = resolve;
      entry.reject = reject;
    });
    entry.timer = setTimeout(() => {
      if (this.entries.get(id) !== entry) {
        return;
      }
      this.entries.delete(id);
      entry.timer = null;
      entry.reject(deadlineError(id));
    }, timeoutMs);
    // Deliberately not unref'd: a deadline must fire even if the socket that
    // carried the request has already gone quiet, and the bridge always holds
    // one open socket, so these timers never keep a dead process alive.
    this.entries.set(id, entry);
    return promise;
  }

  /**
   * Resolve one pending request. A second answer for the same id, or an answer
   * for an id that was never pending (or already timed out), is refused and
   * changes no state - the caller reports it as a protocol event.
   * @returns {boolean} true when this call was the one that settled the id
   */
  settle(id, value) {
    const entry = this.entries.get(id);
    if (entry === undefined) {
      return false;
    }
    this.entries.delete(id);
    this.clear(entry);
    entry.resolve(value);
    return true;
  }

  /** Reject one pending request. @returns {boolean} as {@link settle} */
  fail(id, error) {
    const entry = this.entries.get(id);
    if (entry === undefined) {
      return false;
    }
    this.entries.delete(id);
    this.clear(entry);
    entry.reject(error);
    return true;
  }

  /** Reject every pending request, e.g. because the connection dropped. */
  failAll(error) {
    const entries = [...this.entries.values()];
    this.entries.clear();
    for (const entry of entries) {
      this.clear(entry);
      entry.reject(error);
    }
  }

  clear(entry) {
    if (entry.timer !== null) {
      clearTimeout(entry.timer);
      entry.timer = null;
    }
  }
}

module.exports = { PendingRegistry, MAX_PENDING, DEFAULT_TIMEOUT_MS, deadlineError };
