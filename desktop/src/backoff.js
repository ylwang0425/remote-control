'use strict';
/**
 * Reconnect backoff, protocol-v1 §10.4.
 *
 * The schedule is frozen by the contract: 1000, 2000, 4000, 8000, 16000, 30000,
 * then 30000 forever. Every delay carries 0-20% jitter so that many desktops do
 * not reconnect in lockstep. A connection that reaches `hello.ok` resets the
 * schedule. An HTTP 401 is a configuration error, not a flaky network, so it
 * backs off to one attempt per five minutes instead of a login storm.
 */

/** Contract-pinned reconnect schedule, in milliseconds. */
const BACKOFF_STEPS_MS = [1000, 2000, 4000, 8000, 16000, 30000];

/** Contract-pinned retry interval after an invalid bridge token (HTTP 401). */
const AUTH_REJECT_RETRY_MS = 300000;

class Backoff {
  /** @param {{random?: () => number}} [options] */
  constructor(options = {}) {
    this.random = options.random ?? Math.random;
    this.attempts = 0;
  }

  /**
   * The next reconnect delay: the next schedule step plus 0-20% jitter.
   * @returns {number} milliseconds
   */
  next() {
    const step = BACKOFF_STEPS_MS[Math.min(this.attempts, BACKOFF_STEPS_MS.length - 1)];
    this.attempts += 1;
    return Math.round(step * (1 + this.random() * 0.2));
  }

  /** The delay after the relay refused our token: one attempt per five minutes. */
  reject() {
    this.attempts = 0;
    return AUTH_REJECT_RETRY_MS;
  }

  /** A successful connection (hello.ok) puts the schedule back to the start. */
  reset() {
    this.attempts = 0;
  }
}

module.exports = { Backoff, BACKOFF_STEPS_MS, AUTH_REJECT_RETRY_MS };
