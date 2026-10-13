'use strict';

const { BridgeError } = require('../errors');

/**
 * One WorkBuddy window has one native writer. The queue never retries an
 * operation: callers must inspect native state after an ambiguous receipt.
 * Retiring rejects queued and future work while allowing the one in-flight
 * UIA operation to settle before adapter resources are released.
 */
class WorkBuddyNativeWriter {
  constructor() {
    this.retired = false;
    this.tail = Promise.resolve();
    this.inFlight = 0;
    this.closePromise = null;
  }

  run(action, hooks) {
    if (this.retired) return Promise.reject(new BridgeError('not_capable', 'WorkBuddy native control is closed'));
    if (typeof action !== 'function') return Promise.reject(new BridgeError('invalid_params', 'WorkBuddy native action is invalid'));

    const operation = this.tail.then(async () => {
      if (this.retired) throw new BridgeError('not_capable', 'WorkBuddy native control is closed');
      hooks?.checkActive?.();
      this.inFlight += 1;
      try {
        return await action(hooks);
      } finally {
        this.inFlight -= 1;
      }
    });
    this.tail = operation.catch(() => undefined);
    return operation;
  }

  close() {
    this.retired = true;
    if (this.closePromise === null) this.closePromise = this.tail.then(() => undefined);
    return this.closePromise;
  }
}

module.exports = { WorkBuddyNativeWriter };
