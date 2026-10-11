'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { loadConfig, newClientId, normalizeOwnerName, saveConfig } = require('../src/config');
const { EnrollmentError, enrollDesktop, normalizeRelayAddress, validateCode } = require('../src/enrollment');

test('computer names are trimmed printable labels with a 64-code-point bound', () => {
  assert.equal(normalizeOwnerName('  study desk  '), 'study desk');
  assert.equal(normalizeOwnerName('🧑‍💻'.repeat(21)).length, 105, 'ZWJ emoji are printable and count as code points');
  assert.equal([...normalizeOwnerName('🪑'.repeat(64))].length, 64, 'supplementary characters count by Unicode code point');
  assert.throws(() => normalizeOwnerName('   '), /1–64/);
  assert.throws(() => normalizeOwnerName('desk\nname'), /1–64/);
  assert.throws(() => normalizeOwnerName('🪑'.repeat(65)), /1–64/);
  assert.throws(() => normalizeOwnerName(null), /1–64/);
});

test('saving identity keeps one UUID stable and merges the existing private config', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-remote-identity-'));
  const file = path.join(directory, 'desktop.json');
  const clientId = newClientId();
  fs.writeFileSync(file, JSON.stringify({
    bridgeToken: 'private-token',
    tools: ['codex'],
    codex: { contextThreadId: 'thread-kept', pipePath: null },
    futureSetting: { keep: true },
  }));
  try {
    saveConfig(file, { clientId, ownerName: 'admin' });
    const loaded = loadConfig({ path: file, env: {} });
    assert.equal(loaded.clientId, clientId);
    assert.equal(loaded.ownerName, 'admin');
    assert.equal(loaded.bridgeToken, 'private-token');
    assert.deepEqual(loaded.tools, ['codex']);
    const persisted = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(persisted.codex.contextThreadId, 'thread-kept');
    assert.deepEqual(persisted.futureSetting, { keep: true });
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('relay enrollment addresses accept HTTPS origins or the WSS bridge path only', () => {
  assert.deepEqual(normalizeRelayAddress('https://relay.example'), {
    relayUrl: 'wss://relay.example/bridge',
    enrollmentUrl: 'https://relay.example/api/desktop/enroll',
  });
  assert.deepEqual(normalizeRelayAddress('wss://relay.example/bridge'), {
    relayUrl: 'wss://relay.example/bridge',
    enrollmentUrl: 'https://relay.example/api/desktop/enroll',
  });
  for (const url of ['http://relay.example', 'ws://relay.example/bridge', 'https://relay.example/path', 'wss://relay.example/not-bridge', 'wss://name:secret@relay.example/bridge']) {
    assert.throws(() => normalizeRelayAddress(url), EnrollmentError, url);
  }
});

test('one-use enrollment is sent once, over the native HTTPS endpoint, and is correlated to the local UUID', async () => {
  const clientId = '98c9e96b-5d91-4a04-8d89-e2bdd29e30a5';
  const calls = [];
  const result = await enrollDesktop({
    relayAddress: 'wss://relay.example/bridge',
    code: ' INVITE-123 ',
    clientId,
    ownerName: '  admin ',
    clientName: 'DESKTOP-7F3A',
    sendJson: async (url, payload) => {
      calls.push({ url, payload });
      return { statusCode: 200, json: { ok: true, result: { clientId, bridgeToken: 'private-credential' } } };
    },
  });
  assert.equal(calls.length, 1, 'the one-use enrollment request is never retried');
  assert.equal(calls[0].url, 'https://relay.example/api/desktop/enroll');
  assert.deepEqual(calls[0].payload, {
    code: 'INVITE-123',
    clientId,
    ownerName: 'admin',
    clientName: 'DESKTOP-7F3A',
  });
  assert.deepEqual(result, { clientId, bridgeToken: 'private-credential', relayUrl: 'wss://relay.example/bridge' });
});

test('enrollment refuses a mismatched native UUID or malformed credential result', async () => {
  const clientId = '98c9e96b-5d91-4a04-8d89-e2bdd29e30a5';
  const input = { relayAddress: 'https://relay.example', code: 'invite', clientId, ownerName: 'admin' };
  await assert.rejects(
    enrollDesktop({ ...input, sendJson: async () => ({ statusCode: 200, json: { ok: true, result: { clientId: '6c580936-26f2-4ef5-8e7b-431b701abe75', bridgeToken: 'token' } } }) }),
    /invalid enrollment result/,
  );
  await assert.rejects(
    enrollDesktop({ ...input, sendJson: async () => ({ statusCode: 200, json: { ok: true, result: { clientId, bridgeToken: 'token\nforged' } } }) }),
    /invalid enrollment result/,
  );
  await assert.rejects(enrollDesktop({ ...input, code: 'bad\ncode' }), /enrollment code/i);
  assert.equal(validateCode('  invite  '), 'invite');
});
