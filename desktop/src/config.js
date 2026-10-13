'use strict';
/**
 * Configuration for the desktop bridge.
 *
 * Precedence, lowest first: built-in defaults, the config file, the environment.
 * The bridge token is a secret: it is stored only in the private config file or
 * environment, used for the handshake header, and never printed. `redactedConfig`
 * is the only shape that may be logged or shown in the UI.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const CLIENT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const OWNER_NAME_MAX_CHARS = 64;
const NATIVE_RUN_ID = CLIENT_ID;

const DEFAULTS = Object.freeze({
  relayUrl: 'wss://101.43.98.18/bridge',
  clientName: null, // null = use the machine host name
  clientId: null,
  ownerName: null,
  uiPort: 18989,
  bridgeToken: null,
  codex: { pipePath: null, contextThreadId: null, nativeControl: { enabled: false, registryDir: null, runId: null } },
  dsh: { port: null },
  workbuddy: {
    configDir: null,
    uiAutomation: { enabled: false, executablePath: null, configurationValid: true },
  },
  tools: ['codex', 'dsh'],
  autoStartBridge: true,
});

/** A trimmed, printable label. It is never used as an authentication value. */
function normalizeOwnerName(value) {
  if (typeof value !== 'string' || /\p{Cc}/u.test(value)) {
    throw new TypeError('Computer name must be 1–64 printable characters');
  }
  const name = value.trim();
  const count = [...name].length;
  if (count < 1 || count > OWNER_NAME_MAX_CHARS) {
    throw new TypeError('Computer name must be 1–64 printable characters');
  }
  return name;
}

function newClientId() {
  return crypto.randomUUID();
}

function validClientId(value) {
  return typeof value === 'string' && CLIENT_ID.test(value);
}

/**
 * Validate the one local executable override accepted by WorkBuddy UIA. This
 * config is never accepted from the phone or relay; the local settings page
 * calls the same validator before it is persisted.
 */
function normalizeWorkBuddyExecutablePath(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 2048 || /[\p{Cc}"]/u.test(value)) {
    throw new TypeError('WorkBuddy executable path must be an absolute WorkBuddy.exe path');
  }
  const normalized = path.win32.normalize(value.trim());
  if (!path.win32.isAbsolute(normalized) || path.win32.basename(normalized).toLowerCase() !== 'workbuddy.exe') {
    throw new TypeError('WorkBuddy executable path must be an absolute WorkBuddy.exe path');
  }
  return normalized;
}

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
  const nativeControlEnabled = env.AI_REMOTE_CODEX_NATIVE_CONTROL === '0'
    ? false
    : env.AI_REMOTE_CODEX_NATIVE_CONTROL === '1' || fromFile.codex?.nativeControl?.enabled === true;
  const nativeControlRegistryDir = env.CODEX_NATIVE_CONTROL_DIR;
  const nativeControlRunId = env.CODEX_NATIVE_RUN_ID;
  if (nativeControlEnabled && (
    typeof nativeControlRegistryDir !== 'string' || !path.isAbsolute(nativeControlRegistryDir) ||
    typeof nativeControlRunId !== 'string' || !NATIVE_RUN_ID.test(nativeControlRunId)
  )) {
    throw new Error('Codex native control opt-in needs this launch\'s absolute registry directory and UUID v4 run ID');
  }
  const token = env.AI_REMOTE_BRIDGE_TOKEN ?? pick('bridgeToken', DEFAULTS.bridgeToken);
  const workbuddyUiConfig = fromFile.workbuddy?.uiAutomation;
  const workbuddyExeConfigured = workbuddyUiConfig?.executablePath !== undefined && workbuddyUiConfig?.executablePath !== null;
  let workbuddyExecutablePath = null;
  let workbuddyUiConfigurationValid = true;
  if (workbuddyExeConfigured) {
    try {
      workbuddyExecutablePath = normalizeWorkBuddyExecutablePath(workbuddyUiConfig.executablePath);
    } catch {
      workbuddyUiConfigurationValid = false;
    }
  }
  let ownerName = null;
  try {
    if (typeof fromFile.ownerName === 'string') ownerName = normalizeOwnerName(fromFile.ownerName);
  } catch {
    // A damaged/old label is treated as unset and can be repaired in the local UI.
  }
  const config = {
    relayUrl: env.AI_REMOTE_RELAY_URL ?? pick('relayUrl', DEFAULTS.relayUrl),
    clientName: env.AI_REMOTE_CLIENT_NAME ?? pick('clientName', DEFAULTS.clientName),
    clientId: validClientId(fromFile.clientId) ? fromFile.clientId : null,
    ownerName,
    uiPort: asNumber(env.AI_REMOTE_UI_PORT ?? pick('uiPort', DEFAULTS.uiPort), DEFAULTS.uiPort),
    bridgeToken: typeof token === 'string' && token.length > 0 ? token : null,
    bridgeTokenOverridden: env.AI_REMOTE_BRIDGE_TOKEN !== undefined,
    relayUrlOverridden: env.AI_REMOTE_RELAY_URL !== undefined,
    codex: {
      pipePath: env.AI_REMOTE_CODEX_PIPE ?? fromFile.codex?.pipePath ?? DEFAULTS.codex.pipePath,
      contextThreadId: env.CODEX_THREAD_ID ?? fromFile.codex?.contextThreadId ?? DEFAULTS.codex.contextThreadId,
      nativeControl: {
        enabled: nativeControlEnabled,
        registryDir: nativeControlEnabled ? nativeControlRegistryDir : null,
        runId: nativeControlEnabled ? nativeControlRunId : null,
      },
    },
    dsh: {
      port: asNumber(env.AI_REMOTE_DSH_PORT ?? fromFile.dsh?.port ?? null, null),
    },
    workbuddy: {
      configDir: (env.WORKBUDDY_CONFIG_DIR ?? fromFile.workbuddy?.configDir ?? path.join(os.homedir(), '.workbuddy')),
      uiAutomation: {
        enabled: workbuddyUiConfig?.enabled === true && workbuddyUiConfigurationValid,
        executablePath: workbuddyExecutablePath,
        configurationValid: workbuddyUiConfigurationValid,
      },
    },
    tools: Array.isArray(fromFile.tools) && fromFile.tools.length > 0 ? fromFile.tools : DEFAULTS.tools,
    autoStartBridge:
      env.AI_REMOTE_NO_BRIDGE === '1' ? false : (fromFile.autoStartBridge ?? DEFAULTS.autoStartBridge),
    configFile: file,
  };
  return config;
}

/**
 * Merge a small settings update into the existing private config without
 * discarding adapter options or future fields. The temporary file keeps a
 * failed write from leaving half a JSON document behind.
 */
function saveConfig(file, updates) {
  let current;
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('invalid configuration shape');
    }
    current = parsed;
  } catch (error) {
    if (error?.code === 'ENOENT') {
      current = {};
    } else {
      throw new Error('the existing configuration could not be read safely');
    }
  }
  const next = { ...current, ...updates };
  // Local WorkBuddy UIA settings are nested. Merge that one subtree so saving
  // the opt-in cannot erase configDir or unrelated future WorkBuddy options.
  if (updates.workbuddy !== null && typeof updates.workbuddy === 'object' && !Array.isArray(updates.workbuddy)) {
    next.workbuddy = { ...(current.workbuddy && typeof current.workbuddy === 'object' && !Array.isArray(current.workbuddy) ? current.workbuddy : {}), ...updates.workbuddy };
    if (updates.workbuddy.uiAutomation !== null && typeof updates.workbuddy.uiAutomation === 'object' && !Array.isArray(updates.workbuddy.uiAutomation)) {
      next.workbuddy.uiAutomation = {
        ...(current.workbuddy?.uiAutomation && typeof current.workbuddy.uiAutomation === 'object' && !Array.isArray(current.workbuddy.uiAutomation) ? current.workbuddy.uiAutomation : {}),
        ...updates.workbuddy.uiAutomation,
      };
    }
  }
  const directory = path.dirname(file);
  fs.mkdirSync(directory, { recursive: true });
  const temp = `${file}.${crypto.randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temp, `${JSON.stringify(next, null, 2)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    fs.renameSync(temp, file);
  } catch (error) {
    try { fs.unlinkSync(temp); } catch { /* no temporary file to remove */ }
    throw error;
  }
  return next;
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
    codex: {
      ...config.codex,
      contextThreadId: config.codex?.contextThreadId == null ? null : '<set>',
      nativeControl: {
        enabled: config.codex?.nativeControl?.enabled === true,
      },
    },
    workbuddy: {
      configured: typeof config.workbuddy?.configDir === 'string',
      uiAutomation: {
        enabled: config.workbuddy?.uiAutomation?.enabled === true,
        executablePathConfigured: typeof config.workbuddy?.uiAutomation?.executablePath === 'string',
        configurationValid: config.workbuddy?.uiAutomation?.configurationValid !== false,
      },
    },
  };
}

module.exports = {
  DEFAULTS,
  CLIENT_ID,
  OWNER_NAME_MAX_CHARS,
  configPath,
  loadConfig,
  readTokenFile,
  redactedConfig,
  normalizeOwnerName,
  newClientId,
  validClientId,
  normalizeWorkBuddyExecutablePath,
  saveConfig,
};
