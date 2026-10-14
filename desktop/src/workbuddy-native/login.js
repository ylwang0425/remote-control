'use strict';
const fs = require('node:fs');
const { WorkBuddyCliClient, installedCli } = require('./cli-client');
const { desktopAccountId, loadCredentials, saveCredentials } = require('./credentials');
const { BridgeError } = require('../errors');

class WorkBuddyLogin {
  constructor() { this.client = null; this.state = 'idle'; this.epoch = 0; this.timer = null; }
  describe() { return { state: this.state }; }
  close() { this.epoch++; clearTimeout(this.timer); this.client?.close(); this.client = null; this.state = 'idle'; }

  async verify(options) {
    const accountId = desktopAccountId(); const credentials = loadCredentials(undefined, accountId);
    if (!credentials) throw new BridgeError('not_capable', '请先完成 WorkBuddy 官方 CLI 登录。');
    const client = new WorkBuddyCliClient({ ...installedCli(options.executablePath), configDir: options.configDir,
      cwd: fs.realpathSync(options.configDir), accountId, token: credentials.token, authOnly: true });
    try {
      const initialized = await client.initialize();
      if (!initialized.accountMatches || initialized.models.length === 0) throw new BridgeError('not_capable', 'WorkBuddy CLI 登录已过期，请重新登录同一桌面账号。');
      return { verified: true };
    } finally { client.close(); }
  }

  async start(options, onReady) {
    if (this.client && !this.client.closed) throw new BridgeError('bridge_error', 'WorkBuddy 登录正在进行，请完成当前官方页面。');
    const accountId = desktopAccountId(); const epoch = ++this.epoch;
    const client = new WorkBuddyCliClient({ ...installedCli(options.executablePath), configDir: options.configDir,
      cwd: fs.realpathSync(options.configDir), accountId, authOnly: true });
    this.client = client; this.state = 'starting';
    this.timer = setTimeout(() => { if (this.epoch === epoch) { client.close(); this.state = 'expired'; } }, 300000);
    const url = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new BridgeError('bridge_error', '无法及时生成 WorkBuddy 官方登录页，请重试。')), 20000);
      client.once('authUrl', value => { clearTimeout(timer); this.state = 'awaiting-login'; resolve(value); });
      client.once('failure', error => { clearTimeout(timer); this.state = 'failed'; reject(error); });
    });
    // Attach the rejection immediately, even if initialize itself fails first.
    url.catch(() => {});
    client.once('authResult', async info => {
      if (this.epoch !== epoch) return;
      clearTimeout(this.timer);
      try {
        if (!info || desktopAccountId() !== accountId) throw new Error();
        saveCredentials(info); client.close();
        await this.verify(options);
        if (this.epoch !== epoch) return;
        await onReady(); this.state = 'ready';
      } catch { this.state = 'failed'; client.close(); }
    });
    try { await client.initialize(); client.authenticate(); return { authUrl: await url, state: this.state }; }
    catch (error) { clearTimeout(this.timer); client.close(); this.state = 'failed'; throw error; }
  }
}

module.exports = { WorkBuddyLogin };
