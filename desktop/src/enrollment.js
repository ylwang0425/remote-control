'use strict';

/** HTTPS enrollment transport. Invitation codes and returned bridge tokens are never logged. */

const https = require('node:https');
const { normalizeOwnerName, validClientId } = require('./config');

const MAX_RESPONSE_BYTES = 8192;
const REQUEST_TIMEOUT_MS = 10000;

class EnrollmentError extends Error {
  constructor(code, message, statusCode = 400) {
    super(message);
    this.name = 'EnrollmentError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

/**
 * Accept either the desktop's WSS bridge address or its HTTPS base address.
 * The enrollment request always goes to the HTTPS origin, never to the browser
 * page and never with an Origin header.
 */
function normalizeRelayAddress(value) {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > 2048) {
    throw new EnrollmentError('invalid_params', 'Enter the relay HTTPS address or WSS bridge address.');
  }
  let parsed;
  try {
    parsed = new URL(value.trim());
  } catch {
    throw new EnrollmentError('invalid_params', 'Enter a valid relay address.');
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new EnrollmentError('invalid_params', 'The relay address cannot contain credentials, a query or a fragment.');
  }
  if (parsed.protocol === 'https:') {
    if (parsed.pathname !== '/') {
      throw new EnrollmentError('invalid_params', 'Use the HTTPS server origin without a path.');
    }
    return {
      relayUrl: `wss://${parsed.host}/bridge`,
      enrollmentUrl: new URL('/api/desktop/enroll', parsed.origin).toString(),
    };
  }
  if (parsed.protocol === 'wss:') {
    if (parsed.pathname !== '/bridge') {
      throw new EnrollmentError('invalid_params', 'The WSS address must end in /bridge.');
    }
    return {
      relayUrl: parsed.toString(),
      enrollmentUrl: new URL('/api/desktop/enroll', `https://${parsed.host}`).toString(),
    };
  }
  throw new EnrollmentError('invalid_params', 'The relay address must use HTTPS or WSS.');
}

function validateCode(value) {
  if (typeof value !== 'string' || /\p{Cc}/u.test(value)) {
    throw new EnrollmentError('invalid_params', 'Enter the one-use enrollment code.');
  }
  const code = value.trim();
  if (code.length < 1 || code.length > 256) {
    throw new EnrollmentError('invalid_params', 'The enrollment code is not valid.');
  }
  return code;
}

function requestJson(url, payload) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8');
  return new Promise((resolve, reject) => {
    const request = https.request(url, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'Content-Length': body.length,
      },
      timeout: REQUEST_TIMEOUT_MS,
    }, (response) => {
      let size = 0;
      const chunks = [];
      response.on('data', (chunk) => {
        size += chunk.length;
        if (size > MAX_RESPONSE_BYTES) {
          response.destroy();
          reject(new EnrollmentError('enrollment_failed', 'The relay returned an oversized enrollment response.', 502));
          return;
        }
        chunks.push(chunk);
      });
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json;
        try {
          json = JSON.parse(text);
        } catch {
          reject(new EnrollmentError('enrollment_failed', 'The relay returned an invalid enrollment response.', 502));
          return;
        }
        resolve({ statusCode: response.statusCode ?? 0, json });
      });
    });
    request.on('timeout', () => request.destroy(new Error('timeout')));
    request.on('error', () => reject(new EnrollmentError('enrollment_failed', 'Could not reach the relay enrollment endpoint.', 502)));
    request.end(body);
  });
}

/** Submit one invitation exactly once and return only the private token to the caller. */
async function enrollDesktop({ relayAddress, code, clientId, ownerName, clientName, sendJson = requestJson }) {
  const address = normalizeRelayAddress(relayAddress);
  const invitation = validateCode(code);
  const name = normalizeOwnerName(ownerName);
  if (!validClientId(clientId)) {
    throw new EnrollmentError('invalid_params', 'The local computer ID is invalid.');
  }
  const payload = { code: invitation, clientId, ownerName: name };
  if (typeof clientName === 'string' && clientName.trim().length > 0) {
    payload.clientName = clientName.trim().slice(0, 64);
  }

  let response;
  try {
    response = await sendJson(address.enrollmentUrl, payload);
  } catch {
    throw new EnrollmentError('enrollment_failed', 'Could not reach the relay enrollment endpoint.', 502);
  }
  const result = response?.json?.result;
  const token = result?.bridgeToken;
  if (!Number.isInteger(response?.statusCode) || response.statusCode < 200 || response.statusCode >= 300 || response?.json?.ok !== true) {
    throw new EnrollmentError('enrollment_failed', 'The relay did not accept this enrollment code.', 502);
  }
  if (result?.clientId !== clientId || typeof token !== 'string' || token.length < 1 || token.length > 4096 || /\p{Cc}/u.test(token)) {
    throw new EnrollmentError('enrollment_failed', 'The relay returned an invalid enrollment result.', 502);
  }
  return { clientId, bridgeToken: token, relayUrl: address.relayUrl };
}

module.exports = { EnrollmentError, normalizeRelayAddress, validateCode, enrollDesktop };
