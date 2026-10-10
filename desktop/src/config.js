'use strict';
/**
 * Configuration for the desktop bridge.
 *
 * Precedence, lowest first: built-in defaults, the config file, the environment.
 * The bridge token is a secret: it is read, used for one handshake header, and
 * never printed. `redactedConfig` is the only shape that may be logged or shown
 * in the UI.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const DEFAULTS = Object.freeze({
  relayUrl: 'wss://101.43.98.18/bridge',
  clientName: null, // null = use the machine host name
  uiPort: 18989,
  bridgeToken: null,
  codex: { pipePath: null, contextThreadId: null },
  dsh: { port: null },
  tools: ['codex', 'dsh'],
  autoStartBridge: true,
});

/** Where the config file lives, unless the environment names another one. */
function configPath(options = {}) {
  const env = options.env ?? process.env;
  if (typeof env.AI_REMOTE_CONFIG === 'string' && env.AI_REMOTE_CONFIG.length > 0) {
    return env.AI_REMOTE_CONFIG;
  }
  return path.join(os.homedir(), '.dsh', 'ai-remote-desktop.json');
}

function readConfigFile(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function asNumber(value, fallback) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 && number <= 65535 ? number : fallback;
}

/**
 * @param {{path?: string, env?: Record<string, string|undefined>}} [options]
 * @returns {typeof DEFAULTS & {configFile: string}}
 */
function loadConfig(options = {}) {
  const env = options.env ?? process.env;
  const file = options.path ?? configPath({ env });
  const fromFile = readConfigFile(file);
  const pick = (key, fallback) => (fromFile[key] === undefined ? fallback : fromFile[key]);
  const token = env.AI_REMOTE_BRIDGE_TOKEN ?? pick('bridgeToken', DEFAULTS.bridgeToken);
  const config = {
    relayUrl: env.AI_REMOTE_RELAY_URL ?? pick('relayUrl', DEFAULTS.relayUrl),
    clientName: env.AI_REMOTE_CLIENT_NAME ?? pick('clientName', DEFAULTS.clientName),
    uiPort: asNumber(env.AI_REMOTE_UI_PORT ?? pick('uiPort', DEFAULTS.uiPort), DEFAULTS.uiPort),
    bridgeToken: typeof token === 'string' && token.length > 0 ? token : null,
    codex: {
      pipePath: env.AI_REMOTE_CODEX_PIPE ?? fromFile.codex?.pipePath ?? DEFAULTS.codex.pipePath,
      contextThreadId: env.CODEX_THREAD_ID ?? fromFile.codex?.contextThreadId ?? DEFAULTS.codex.contextThreadId,
    },
    dsh: {
      port: asNumber(env.AI_REMOTE_DSH_PORT ?? fromFile.dsh?.port ?? null, null),
    },
    tools: Array.isArray(fromFile.tools) && fromFile.tools.length > 0 ? fromFile.tools : DEFAULTS.tools,
    autoStartBridge:
      env.AI_REMOTE_NO_BRIDGE === '1' ? false : (fromFile.autoStartBridge ?? DEFAULTS.autoStartBridge),
    configFile: file,
  };
  return config;
}

/**
 * The token-bearing file a user can use instead of putting the secret in the
 * environment. Reading it is one line, and the value never leaves this call.
 * @param {string} file
 * @returns {string|null}
 */
function readTokenFile(file) {
  try {
    const value = fs.readFileSync(file, 'utf8').trim();
    return value.length > 0 ? value : null;
  } catch {
    return null;
  }
}

/** A config safe to print: the token is reduced to a marker. */
function redactedConfig(config) {
  return {
    ...config,
    bridgeToken: config.bridgeToken === null ? null : '<set>',
  };
}

module.exports = { DEFAULTS, configPath, loadConfig, readTokenFile, redactedConfig };
