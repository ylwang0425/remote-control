'use strict';
/**
 * The create log: the durable answer to "did this `requestId` already make a
 * session?".
 *
 * `session.create` is not idempotent upstream, so this file is what stops a
 * phone retry, a coalesced double tap, or a bridge restart from producing a
 * second chat. Each key is in one of three states:
 *
 *   pending  - a native create is running, or a process died in the middle of
 *              one. Written **before** the native call, so a crash cannot lose
 *              the fact that something may have been created;
 *   done     - a session id is known. The same key returns that result and never
 *              calls the native API again;
 *   unknown  - a native create was attempted and no id was learned. The key is
 *              closed for ever: the only safe answer is "the outcome is unknown -
 *              look through the session list on this computer and confirm by
 *              hand what was created", never a blind second creation.
 *
 * Failure policy - **fail closed, never fail open**:
 *   - a missing file (ENOENT) is the only thing treated as "nothing created yet";
 *   - an unreadable or corrupt file is an error that *blocks creation*, because
 *     a log we cannot read cannot prove that a key was not already used;
 *   - a write must land (temp file + rename) *before* the native call runs. If it
 *     cannot, the create does not happen. A local bookkeeping failure must never
 *     turn into a duplicate chat on someone's desktop.
 *
 * Bounded without losing keys: the last `MAX_RESULTS` results are kept in full;
 * older keys degrade to a **tombstone** - request id, fingerprint and state, no
 * result body. A tombstone still refuses to create again and answers "result
 * unknown"; only the bulky result is dropped.
 *
 * It stores no text, no credential and no message content: a request id, a
 * fingerprint of the request, a session id, the tool and the model.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

/** How many full results are kept; older keys remain as tombstones. */
const MAX_RESULTS = 200;
const STATE_PENDING = 'pending';
const STATE_DONE = 'done';
const STATE_UNKNOWN = 'unknown';

class CreateLogUnavailableError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CreateLogUnavailableError';
    this.code = 'session_create_failed';
  }
}

function defaultPath() {
  const base = process.env.LOCALAPPDATA ?? path.join(os.homedir(), '.cache');
  return path.join(base, 'ai-remote', 'creates.json');
}

/** A stable description of what was asked, so one key cannot mean two things. */
function fingerprintOf(params) {
  return JSON.stringify({
    tool: params.tool,
    model: params.model ?? null,
    provider: params.provider ?? null,
    reasoningEffort: params.reasoningEffort ?? null,
    cwd: params.cwd ?? null,
    projectId: params.projectId ?? null,
    hasText: typeof params.text === 'string' && params.text.length > 0,
  });
}

class CreateLog {
  /**
   * @param {{path?: string}} [options]
   * @throws {CreateLogUnavailableError} when an existing log cannot be read
   */
  constructor(options = {}) {
    this.path = options.path ?? defaultPath();
    this.entries = this.load();
    /** requestId -> promise, while a create is running in this process. */
    this.inFlight = new Map();
  }

  /** @returns {object[]} @throws {CreateLogUnavailableError} */
  load() {
    let text;
    try {
      text = fs.readFileSync(this.path, 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT') {
        return []; // first run on this machine
      }
      throw new CreateLogUnavailableError(`the local create log cannot be read (${error.code ?? 'error'})`);
    }
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new CreateLogUnavailableError('the local create log is not valid JSON');
    }
    if (parsed === null || typeof parsed !== 'object' || !Array.isArray(parsed.creates)) {
      throw new CreateLogUnavailableError('the local create log has an unexpected shape');
    }
    return parsed.creates.filter((entry) => typeof entry?.requestId === 'string' && typeof entry?.state === 'string');
  }

  /** A create must not run unless the log is writable. */
  assertUsable() {
    if (this.entries === null) {
      throw new CreateLogUnavailableError('the local create log is not usable');
    }
  }

  /**
   * Write the log atomically and let a failure surface: a create that cannot be
   * recorded must not happen, so this throws instead of degrading to "no
   * deduplication".
   */
  save() {
    const directory = path.dirname(this.path);
    const temporary = `${this.path}.tmp-${process.pid}`;
    try {
      fs.mkdirSync(directory, { recursive: true });
      fs.writeFileSync(temporary, JSON.stringify({ creates: this.entries }), { mode: 0o600 });
      fs.renameSync(temporary, this.path);
    } catch (error) {
      try {
        fs.unlinkSync(temporary);
      } catch {
        // nothing to clean up
      }
      throw new CreateLogUnavailableError(`the local create log cannot be written (${error.code ?? 'error'})`);
    }
    return true;
  }

  /** Keep every key, but only the newest `MAX_RESULTS` bodies. */
  compact() {
    const ordered = this.entries;
    if (ordered.length <= MAX_RESULTS) return ordered;
    const keepFrom = ordered.length - MAX_RESULTS;
    return ordered.map((entry, index) => {
      if (index >= keepFrom || entry.result === undefined) return entry;
      const { result, ...tombstone } = entry; // eslint-disable-line no-unused-vars
      return { ...tombstone, result: null, bodyDropped: true };
    });
  }

  find(requestId) {
    return this.entries.find((entry) => entry.requestId === requestId) ?? null;
  }

  /**
   * The ids this bridge created recently, newest first.
   *
   * The Codex app's own `list_threads` does not always include a brand-new
   * thread, so this is the index the dispatcher merges those chats back into
   * `sessions.list` with - each one re-read natively, so the title and the
   * status are the app's own and nothing is invented.
   * @param {string} [tool]
   * @param {number} [limit]
   */
  recentlyCreated(tool, limit = 5) {
    return this.entries
      .filter(
        (entry) =>
          entry.state === STATE_DONE &&
          typeof entry.sessionId === 'string' &&
          (tool === undefined || entry.result?.tool === tool || entry.tool === tool),
      )
      .slice(-Math.max(1, limit))
      .reverse()
      .map((entry) => entry.sessionId);
  }

  /** Update memory, then persist; a failed write restores memory and throws. */
  put(entry) {
    const previous = this.entries;
    this.entries = [...previous.filter((item) => item.requestId !== entry.requestId), entry];
    this.entries = this.compact();
    try {
      this.save();
    } catch (error) {
      this.entries = previous;
      throw error;
    }
    return entry;
  }

  /**
   * Run one create for a key, at most once, even under concurrency.
   *
   * @param {string} requestId
   * @param {string} fingerprint
   * @param {(onCreated: (created: {sessionId: string, result?: object}) => void) => Promise<object>} worker
   * @returns {Promise<{result: object, deduplicated: boolean}>}
   */
  async run(requestId, fingerprint, worker) {
    const existing = this.find(requestId);
    if (existing !== null) {
      if (existing.fingerprint !== fingerprint) {
        const error = new Error('this requestId was already used for a different request');
        error.code = 'invalid_params';
        throw error;
      }
      if (existing.state === STATE_DONE && existing.result) {
        return { result: { ...existing.result }, deduplicated: true };
      }
      if (existing.state === STATE_DONE && !existing.result) {
        // Tombstone: the key is known to have created something, but the body is
        // gone. Never create again. The person is sent to the session list to
        // confirm by hand what exists - suggesting a fresh request id would be
        // exactly the duplication this file exists to prevent.
        const error = new Error(
          'this requestId already created a session, but its stored result is gone. Look through the session list on this computer for the session it created and open it there - do not create it again.',
        );
        error.code = 'session_create_failed';
        throw error;
      }
      const running = this.inFlight.get(requestId);
      if (running !== undefined) {
        // A second tap joins the create that is already running: same result, but
        // this caller is told it did not create anything itself.
        const shared = await running;
        return { ...shared, deduplicated: true };
      }
      const error = new Error(
        existing.state === STATE_UNKNOWN
          ? 'the outcome of this requestId is unknown. Look through the session list on this computer for a recently created session and open it there - do not create it again.'
          : 'an earlier attempt with this requestId may already have created a session. Look through the session list on this computer before anything else - do not create it again.',
      );
      error.code = 'session_create_failed';
      throw error;
    }

    // Reserve on disk *before* the native call. If this write fails, no session
    // is created at all - that is the whole point of failing closed.
    this.put({ requestId, fingerprint, state: STATE_PENDING, at: new Date().toISOString() });

    const promise = (async () => {
      let created = null;
      const onCreated = (value) => {
        created = value;
        this.put({
          requestId,
          fingerprint,
          state: STATE_DONE,
          sessionId: value.sessionId,
          result: value.result ?? { sessionId: value.sessionId, partial: true, incomplete: 'a later step failed' },
          at: new Date().toISOString(),
        });
      };
      try {
        const result = await worker(onCreated);
        this.put({ requestId, fingerprint, state: STATE_DONE, sessionId: result.sessionId, result, at: new Date().toISOString() });
        return { result, deduplicated: false };
      } catch (error) {
        if (created === null) {
          this.put({ requestId, fingerprint, state: STATE_UNKNOWN, at: new Date().toISOString() });
        }
        throw error;
      } finally {
        this.inFlight.delete(requestId);
      }
    })();

    this.inFlight.set(requestId, promise);
    return promise;
  }
}

module.exports = {
  CreateLog,
  CreateLogUnavailableError,
  fingerprintOf,
  defaultPath,
  MAX_RESULTS,
  STATE_PENDING,
  STATE_DONE,
  STATE_UNKNOWN,
};
