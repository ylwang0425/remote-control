'use strict';
/**
 * Tests for the reconnect backoff schedule (protocol-v1 §10.4):
 * 1000, 2000, 4000, 8000, 16000, 30000, 30000, ... ms, plus 0-20% jitter,
 * reset after a successful `hello.ok`, and no reconnect storm on HTTP 401.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { Backoff, BACKOFF_STEPS_MS, AUTH_REJECT_RETRY_MS } = require('../src/backoff');

test('the backoff schedule is the one the contract pins', () => {
  assert.deepEqual(BACKOFF_STEPS_MS, [1000, 2000, 4000, 8000, 16000, 30000]);
});

test('no jitter means the plain schedule, and the last step repeats forever', () => {
  const backoff = new Backoff({ random: () => 0 });
  const seen = [];
  for (let i = 0; i < 9; i += 1) {
    seen.push(backoff.next());
  }
  assert.deepEqual(seen, [1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000, 30000]);
});

test('each delay carries between 0% and 20% jitter', () => {
  assert.equal(new Backoff({ random: () => 0 }).next(), 1000);
  assert.equal(new Backoff({ random: () => 1 }).next(), 1200);
  assert.equal(new Backoff({ random: () => 0.5 }).next(), 1100);
});

test('a successful connection resets the schedule to the first step', () => {
  const backoff = new Backoff({ random: () => 0 });
  assert.equal(backoff.next(), 1000);
  assert.equal(backoff.next(), 2000);
  assert.equal(backoff.next(), 4000);
  assert.equal(backoff.attempts, 3);
  backoff.reset();
  assert.equal(backoff.attempts, 0);
  assert.equal(backoff.next(), 1000);
});

test('an invalid token is not a reconnect storm: one retry per 300 seconds', () => {
  assert.equal(AUTH_REJECT_RETRY_MS, 300000);
  const backoff = new Backoff({ random: () => 0 });
  assert.equal(backoff.reject(), AUTH_REJECT_RETRY_MS);
  assert.equal(backoff.reject(), AUTH_REJECT_RETRY_MS);
  backoff.reset();
  assert.equal(backoff.next(), 1000);
});

test('jitter never pushes a delay past the 20% ceiling', () => {
  const backoff = new Backoff();
  for (let i = 0; i < 50; i += 1) {
    const step = BACKOFF_STEPS_MS[Math.min(i, BACKOFF_STEPS_MS.length - 1)];
    const delay = backoff.next();
    assert.ok(delay >= step, `${delay} >= ${step}`);
    assert.ok(delay <= step * 1.2, `${delay} <= ${step * 1.2}`);
  }
});
