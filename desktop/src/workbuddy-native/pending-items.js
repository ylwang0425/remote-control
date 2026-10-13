'use strict';

const { randomUUID } = require('node:crypto');

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const RECORD_FIELDS = Object.freeze([
  'kind', 'nativeId', 'conversationId', 'turnId', 'itemId', 'actionId',
  'formSignature', 'runtimeIdHash', 'observedAt', 'expiresAt',
]);
const RESOLUTION_FIELDS = Object.freeze([
  'kind', 'conversationId', 'turnId', 'itemId', 'actionId', 'formSignature', 'runtimeIdHash',
]);
const RESOLUTION_FIELDS_WITH_NOW = Object.freeze([...RESOLUTION_FIELDS, 'now']);
const STRING_LIMITS = Object.freeze({
  nativeId: 256,
  conversationId: 256,
  turnId: 256,
  itemId: 256,
  actionId: 128,
  formSignature: 512,
  runtimeIdHash: 256,
});
const MAX_TOTAL_TEXT_BYTES = 4096;
const DEFAULT_MAX_ENTRIES = 512;
const MAX_ENTRIES_LIMIT = 4096;
const DEFAULT_MAX_AGE_MS = 30_000;
const DEFAULT_MAX_TTL_MS = 120_000;
const MAX_TIME_BOUND_MS = 300_000;

const ERROR_MESSAGES = Object.freeze({
  invalid_params: 'invalid pending native item',
  stale_request: 'pending native item is stale or no longer available',
  bridge_error: 'pending native item capacity reached',
});

class WorkBuddyPendingItemsError extends Error {
  constructor(code) {
    super(ERROR_MESSAGES[code] ?? ERROR_MESSAGES.bridge_error);
    this.name = 'WorkBuddyPendingItemsError';
    this.code = Object.hasOwn(ERROR_MESSAGES, code) ? code : 'bridge_error';
  }
}

function fail(code) {
  throw new WorkBuddyPendingItemsError(code);
}

function ownDataObject(value, allowedFields, requiredFields, code) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail(code);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) fail(code);
  if (Object.getOwnPropertySymbols(value).length !== 0) fail(code);

  const keys = Object.getOwnPropertyNames(value);
  if (keys.some((key) => !allowedFields.includes(key)) || requiredFields.some((key) => !keys.includes(key))) fail(code);
  const result = Object.create(null);
  for (const key of keys) {
    const property = Object.getOwnPropertyDescriptor(value, key);
    if (!property || !Object.hasOwn(property, 'value')) fail(code);
    result[key] = property.value;
  }
  return result;
}

function validateTextFields(record, code) {
  let totalBytes = 0;
  for (const [field, maxLength] of Object.entries(STRING_LIMITS)) {
    const value = record[field];
    if (typeof value !== 'string' || value.length === 0 || value.length > maxLength || /[\u0000-\u001f\u007f]/u.test(value)) {
      fail(code);
    }
    totalBytes += Buffer.byteLength(value, 'utf8');
    if (totalBytes > MAX_TOTAL_TEXT_BYTES) fail(code);
  }
}

function safeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function uuid() {
  const handle = randomUUID();
  if (!UUID_V4.test(handle)) fail('bridge_error');
  return handle;
}

function baseIdentityKey(record) {
  return JSON.stringify([
    record.kind,
    record.nativeId,
    record.conversationId,
    record.turnId,
    record.itemId,
    record.actionId,
  ]);
}

function sameRenderedForm(left, right) {
  return left.formSignature === right.formSignature && left.runtimeIdHash === right.runtimeIdHash;
}

/**
 * Hold short-lived opaque phone handles for WorkBuddy's native pending forms.
 * This class only checks the caller-supplied identity tuple. It does not read
 * UIA/DB state, authenticate runtime IDs, or report that a native answer worked.
 */
class WorkBuddyPendingItems {
  constructor({
    now = Date.now,
    maxEntries = DEFAULT_MAX_ENTRIES,
    maxAgeMs = DEFAULT_MAX_AGE_MS,
    maxTtlMs = DEFAULT_MAX_TTL_MS,
  } = {}) {
    if (typeof now !== 'function' || !Number.isInteger(maxEntries) || maxEntries < 1 || maxEntries > MAX_ENTRIES_LIMIT ||
        !Number.isInteger(maxAgeMs) || maxAgeMs < 1 || maxAgeMs > MAX_TIME_BOUND_MS ||
        !Number.isInteger(maxTtlMs) || maxTtlMs < 1 || maxTtlMs > MAX_TIME_BOUND_MS || maxAgeMs > maxTtlMs) {
      fail('invalid_params');
    }
    this._now = now;
    this._maxEntries = maxEntries;
    this._maxAgeMs = maxAgeMs;
    this._maxTtlMs = maxTtlMs;
    this._lastNow = 0;
    this._entries = new Map();
    this._activeByIdentity = new Map();
    this._closedIdentities = new Set();
    this._retired = false;
  }

  capture(input) {
    if (this._retired) fail('stale_request');
    const record = ownDataObject(input, RECORD_FIELDS, RECORD_FIELDS, 'invalid_params');
    if (record.kind !== 'question' && record.kind !== 'approval') fail('invalid_params');
    validateTextFields(record, 'invalid_params');

    const now = this._readNow();
    if (!safeInteger(record.observedAt) || !safeInteger(record.expiresAt) ||
        record.observedAt > now || now - record.observedAt > this._maxAgeMs ||
        record.expiresAt <= now || record.expiresAt <= record.observedAt ||
        record.expiresAt - record.observedAt > this._maxTtlMs) {
      fail('stale_request');
    }

    const identity = baseIdentityKey(record);
    if (this._closedIdentities.has(identity)) fail('stale_request');
    this._sweep(now);

    const existingHandle = this._activeByIdentity.get(identity);
    if (existingHandle !== undefined) {
      const existing = this._entries.get(existingHandle);
      if (existing && sameRenderedForm(existing, record)) {
        const refreshed = Object.freeze({ ...record });
        this._entries.set(existingHandle, refreshed);
        return existingHandle;
      }
      // A redraw/recreated runtime invalidates the old phone handle. The
      // identity remains open, so a fresh handle may represent the new form.
      this._removeActive(existingHandle);
    }

    if (this._entries.size + this._closedIdentities.size >= this._maxEntries) fail('bridge_error');
    const handle = uuid();
    this._entries.set(handle, Object.freeze({ ...record }));
    this._activeByIdentity.set(identity, handle);
    return handle;
  }

  resolve(handle, input) {
    if (this._retired) fail('stale_request');
    if (typeof handle !== 'string' || !UUID_V4.test(handle)) fail('stale_request');
    const resolution = ownDataObject(input, RESOLUTION_FIELDS_WITH_NOW, RESOLUTION_FIELDS, 'invalid_params');
    if (resolution.kind !== 'question' && resolution.kind !== 'approval') fail('invalid_params');
    for (const field of RESOLUTION_FIELDS) {
      if (field !== 'kind' && (typeof resolution[field] !== 'string' || resolution[field].length === 0 ||
          resolution[field].length > STRING_LIMITS[field] || /[\u0000-\u001f\u007f]/u.test(resolution[field]))) {
        fail('invalid_params');
      }
    }
    if (resolution.now !== undefined && !safeInteger(resolution.now)) fail('invalid_params');

    const now = this._readNow(resolution.now);
    this._sweep(now);
    const record = this._entries.get(handle);
    if (!record) fail('stale_request');
    for (const field of RESOLUTION_FIELDS) {
      if (record[field] !== resolution[field]) fail('stale_request');
    }
    if (now - record.observedAt > this._maxAgeMs || now >= record.expiresAt) {
      this._removeActive(handle);
      fail('stale_request');
    }

    const identity = baseIdentityKey(record);
    this._removeActive(handle);
    this._closedIdentities.add(identity);
    return Object.freeze({ ...record });
  }

  invalidateConversation(conversationId, options = {}) {
    if (this._retired) return;
    const parsedOptions = ownDataObject(options, ['exceptTurnId'], [], 'invalid_params');
    const exceptTurnId = parsedOptions.exceptTurnId;
    if (typeof conversationId !== 'string' || conversationId.length === 0 || conversationId.length > STRING_LIMITS.conversationId ||
        /[\u0000-\u001f\u007f]/u.test(conversationId) ||
        (exceptTurnId !== undefined && (typeof exceptTurnId !== 'string' || exceptTurnId.length === 0 ||
          exceptTurnId.length > STRING_LIMITS.turnId || /[\u0000-\u001f\u007f]/u.test(exceptTurnId)))) {
      fail('invalid_params');
    }
    this._sweep(this._readNow());
    for (const [handle, record] of this._entries) {
      if (record.conversationId === conversationId && (exceptTurnId === undefined || record.turnId !== exceptTurnId)) {
        this._closedIdentities.add(baseIdentityKey(record));
        this._removeActive(handle);
      }
    }
  }

  retire() {
    if (this._retired) return;
    this._retired = true;
    this._entries.clear();
    this._activeByIdentity.clear();
    this._closedIdentities.clear();
  }

  _readNow(advisoryNow) {
    const current = this._now();
    if (!safeInteger(current)) fail('bridge_error');
    if (advisoryNow !== undefined && !safeInteger(advisoryNow)) fail('invalid_params');
    this._lastNow = Math.max(this._lastNow, current, advisoryNow ?? 0);
    return this._lastNow;
  }

  _sweep(now) {
    for (const [handle, record] of this._entries) {
      if (now >= record.expiresAt || now - record.observedAt > this._maxAgeMs) this._removeActive(handle);
    }
  }

  _removeActive(handle) {
    const record = this._entries.get(handle);
    if (!record) return;
    this._entries.delete(handle);
    const identity = baseIdentityKey(record);
    if (this._activeByIdentity.get(identity) === handle) this._activeByIdentity.delete(identity);
  }
}

module.exports = {
  WorkBuddyPendingItems,
  WorkBuddyPendingItemsError,
};
