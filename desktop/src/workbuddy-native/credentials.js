'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { BridgeError } = require('../errors');

function boundedJson(file, limit = 32768) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > limit) throw new Error('Not a bounded regular file');
  const fd = fs.openSync(file, 'r');
  try {
    const buffer = Buffer.alloc(limit + 1);
    const count = fs.readSync(fd, buffer, 0, buffer.length, 0);
    if (count > limit) throw new Error('File exceeds bound');
    return JSON.parse(buffer.subarray(0, count).toString('utf8'));
  } finally { fs.closeSync(fd); }
}

// The desktop's public account ID is identity evidence only. Its encrypted
// access/refresh tokens are neither decrypted nor copied by the bridge.
function desktopAccountId() {
  try {
    const data = boundedJson(path.join(os.homedir(), 'AppData', 'Local', 'CodeBuddyExtension', 'Data', 'Public', 'auth', 'workbuddy-desktop.info'), 1024 * 1024);
    const id = data.account?.uid;
    if (typeof id === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(id)) return id;
  } catch {}
  throw new BridgeError('not_capable', 'Sign into the local WorkBuddy desktop account before enabling its background CLI');
}

function credentialFile() { return path.join(os.homedir(), '.dsh', 'ai-remote-workbuddy-auth.json'); }

function loadCredentials(file = credentialFile(), expectedAccountId = desktopAccountId()) {
  try {
    const data = boundedJson(file);
    if (data.source !== 'official-sdk-external-login' || data.userId !== expectedAccountId ||
        typeof data.token !== 'string' || data.token.length < 16 || data.token.length > 16384 || /[\r\n\0]/.test(data.token)) return null;
    return { userId: data.userId, token: data.token };
  } catch { return null; }
}

function saveCredentials(info, file = credentialFile(), expectedAccountId = desktopAccountId()) {
  if (!info || info.userId !== expectedAccountId || typeof info.token !== 'string' ||
      info.token.length < 16 || info.token.length > 16384 || /[\r\n\0]/.test(info.token)) {
    throw new BridgeError('not_capable', 'The CLI login does not match the active WorkBuddy desktop account');
  }
  const parent = path.dirname(file);
  fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
  if (fs.lstatSync(parent).isSymbolicLink()) throw new BridgeError('bridge_error', 'Private WorkBuddy configuration directory is not a regular directory');
  const temporary = path.join(parent, `.workbuddy-auth-${randomUUID()}.tmp`);
  const fd = fs.openSync(temporary, 'wx', 0o600);
  let written = false;
  try {
    // Apply the Windows ACL before writing any credential bytes. Restrict to
    // this Windows user and SYSTEM; credentials never enter command arguments.
    if (process.platform === 'win32') {
      const sid = execFileSync('whoami.exe', ['/user', '/fo', 'csv', '/nh'], { encoding: 'utf8', windowsHide: true }).match(/S-1-5-\d+(?:-\d+)+/)?.[0];
      if (!sid) throw new Error('Windows user SID is unavailable');
      execFileSync('icacls.exe', [temporary, '/inheritance:r', '/grant:r', `*${sid}:(F)`, '*S-1-5-18:(F)'], { windowsHide: true, stdio: 'ignore' });
    }
    fs.writeFileSync(fd, JSON.stringify({ source: 'official-sdk-external-login', userId: info.userId,
      token: info.token, obtainedAt: new Date().toISOString() }));
    fs.fsyncSync(fd);
    written = true;
  } catch {
    throw new BridgeError('bridge_error', 'Could not securely store the WorkBuddy SDK login on this computer');
  } finally { fs.closeSync(fd); if (!written && fs.existsSync(temporary)) fs.unlinkSync(temporary); }
  try { fs.renameSync(temporary, file); }
  finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
}

module.exports = { desktopAccountId, credentialFile, loadCredentials, saveCredentials, boundedJson };
