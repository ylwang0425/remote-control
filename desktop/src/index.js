'use strict';
/**
 * The desktop bridge entry point.
 *
 *   node src/index.js                 run: local UI + relay link
 *   node src/index.js --self-check    offline checks, nothing touched
 *   node src/index.js --help          usage
 *
 * Configuration comes from a file and the environment (see `src/config.js`); the
 * relay URL and the config path can also be given on the command line. No path,
 * port or token is hard-coded anywhere.
 *
 * The token is a secret: it is read, put in one handshake header, and never
 * printed. `--self-check` reports only whether it is set.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  loadConfig, readTokenFile, redactedConfig, configPath, normalizeOwnerName,
  normalizeWorkBuddyExecutablePath, newClientId, saveConfig, validClientId,
} = require('./config');
const { EnrollmentError, normalizeRelayAddress, enrollDesktop } = require('./enrollment');
const {
  buildCapabilities,
  buildSessionsListResult,
  buildSessionReadResult,
  buildSessionSendResult,
  buildSessionStopResult,
  buildSessionAnswerResult,
  buildSessionApproveResult,
  buildModelsListResult,
  buildSessionCreateResult,
} = require('./protocol');
const { BridgeError, safeMessage } = require('./errors');
const { BridgeClient } = require('./bridge');
const { LocalUiServer } = require('./ui/server');
const { discoverCodexPipes } = require('./adapters/codex');
const { CreateLog, fingerprintOf } = require('./creates');
const { readRunStopRequestConfig, createRunStopRequestWatcher } = require('./run-stop-request');

/**
 * Per-source deadlines for `sessions.list`, measured on this machine: a Codex
 * list is about 1.2 s and a DSH list about 1 s when healthy, while a Codex
 * `read_thread` on a long thread has been seen to exceed 15 s. These budgets keep
 * one slow source from starving the other, and the caller falls back to that
 * source's last good answer rather than failing the whole list.
 */
const CODEX_LIST_TIMEOUT_MS = 8000;
const DSH_LIST_TIMEOUT_MS = 5000;
const WORKBUDDY_UNAVAILABLE_REASON = '未找到可读取的 WorkBuddy 本地会话存储。';
const WORKBUDDY_READ_ONLY_REASON = 'WorkBuddy 本机会话可读；模型、创建、发送、停止、回答和审批仅在对应原生能力实测后启用。';

function safeWorkBuddyLastSnapshot(value) {
  if (value === null || value === undefined || typeof value !== 'object' || Array.isArray(value)) return null;
  if (typeof value.observedAt !== 'string' || value.observedAt.length > 40 || Number.isNaN(Date.parse(value.observedAt))) return null;
  if (!['default', 'secure', 'other', 'unavailable'].includes(value.desktopKind) ||
      typeof value.targetMatched !== 'boolean' || typeof value.isForeground !== 'boolean') return null;
  return {
    observedAt: value.observedAt,
    desktopKind: value.desktopKind,
    targetMatched: value.targetMatched,
    isForeground: value.isForeground,
  };
}

/** Local-only status projection. Native helper/debug objects never pass through. */
function describeWorkBuddyUiAutomation(adapter, settings) {
  const enabled = settings?.enabled === true;
  let observed = null;
  try {
    const description = adapter?.describe?.();
    observed = safeWorkBuddyLastSnapshot(description?.uiAutomation?.lastSnapshot);
  } catch {
    // Status rendering must not fail the bridge or expose adapter diagnostics.
  }
  return {
    enabled,
    executablePathConfigured: typeof settings?.executablePath === 'string',
    needsUnlockedDesktop: enabled,
    requiresDefaultInputDesktop: enabled,
    requiresForegroundTarget: enabled,
    lastObserved: observed,
  };
}

const VERSION = require('../package.json').version;

const USAGE = `AI Remote — desktop bridge ${VERSION}

Usage:
  node src/index.js [options]

Options:
  --config <path>       config file (default: %USERPROFILE%\\.dsh\\ai-remote-desktop.json)
  --relay <url>         relay WebSocket URL (default: wss://101.43.98.18/bridge)
  --token-file <path>   read the bridge token from a file (never from the command line)
  --port <n>            local UI port (default: 18989)
  --no-bridge           start the local UI only, do not connect to the relay
  --self-check          run offline checks (no network, no session touched) and exit
  --help, -h            this text
  --version, -v         print the version

Exit codes:
  0  everything is fine (a warning, such as "bridge token not set yet", does not
     change this: a fresh install is expected to start without a token)
  1  a real check failed — the bridge cannot work on this machine as it is
  2  the command line itself was not understood
  3  reserved: used by --self-check only when a check could not be completed
     (for example the config file exists but is not readable)

Environment:
  AI_REMOTE_CONFIG, AI_REMOTE_RELAY_URL, AI_REMOTE_BRIDGE_TOKEN,
  AI_REMOTE_UI_PORT, AI_REMOTE_CLIENT_NAME, AI_REMOTE_CODEX_PIPE,
  AI_REMOTE_DSH_PORT, AI_REMOTE_NO_BRIDGE,
  AI_REMOTE_CODEX_NATIVE_CONTROL, CODEX_NATIVE_CONTROL_DIR, CODEX_NATIVE_RUN_ID

The bridge token is never printed, never written to a log and never put in a URL.
`;

/**
 * @param {string[]} argv
 * @returns {{configFile?: string, relay?: string, tokenFile?: string, port?: number, noBridge: boolean, selfCheck: boolean}}
 */
function parseArgs(argv) {
  const args = { noBridge: false, selfCheck: false };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    switch (value) {
      case '--help':
      case '-h':
        args.help = true;
        break;
      case '--version':
      case '-v':
        args.version = true;
        break;
      case '--self-check':
        args.selfCheck = true;
        break;
      case '--no-bridge':
        args.noBridge = true;
        break;
      case '--config':
        args.configFile = argv[(index += 1)];
        break;
      case '--relay':
        args.relay = argv[(index += 1)];
        break;
      case '--token-file':
        args.tokenFile = argv[(index += 1)];
        break;
      case '--port':
        args.port = Number(argv[(index += 1)]);
        break;
      default:
        if (value.startsWith('-')) {
          throw new Error(`unknown option ${value}`);
        }
    }
  }
  return args;
}

/**
 * Offline checks: everything a user can verify before anything is connected.
 * No network call, no session read, no adapter opened.
 * @returns {number} process exit code
 */
function selfCheck(config) {
  const results = [];
  const add = (name, ok, detail, fatal = true) => results.push({ name, ok, detail, fatal });

  const major = Number(process.versions.node.split('.')[0]);
  add('node version', major >= 22, `v${process.versions.node} (needs 22 or newer)`);

  for (const module of ['./ws', './bridge', './protocol', './errors', './framing', './dsh-events', './codex-context', './adapters/codex', './adapters/dsh', './adapters/workbuddy', './ui/server']) {
    try {
      require(module.startsWith('./adapters') || module === './ui/server' ? path.join(__dirname, module.slice(2)) : module);
      add(`module ${module}`, true, 'loads');
    } catch (error) {
      add(`module ${module}`, false, safeMessage(error));
    }
  }

  let configParsed = true;
  try {
    if (fs.existsSync(config.configFile)) {
      JSON.parse(fs.readFileSync(config.configFile, 'utf8'));
    }
  } catch {
    configParsed = false;
  }
  add('config file', configParsed, fs.existsSync(config.configFile) ? `${config.configFile} (parsed)` : `${config.configFile} (not there yet, defaults are in use)`);

  const page = path.join(__dirname, '..', 'ui', 'index.html');
  add('local page', fs.existsSync(page), page);

  let tokenValue = config.bridgeToken;
  if (tokenValue === null && typeof config.tokenFile === 'string') {
    tokenValue = readTokenFile(config.tokenFile);
  }
  add('bridge token', tokenValue !== null, tokenValue === null ? 'not set — put it in the config file or AI_REMOTE_BRIDGE_TOKEN' : 'set (value never shown)', false);

  const codexPipes = discoverCodexPipes();
  add('codex app-tools pipes', true, codexPipes.length === 0 ? 'none visible right now' : `${codexPipes.length} on this machine`, false);
  add('dsh backend hint', true, config.dsh.port === null ? 'not configured; it will be discovered on loopback' : `port ${config.dsh.port} (configured)`, false);

  process.stdout.write('self-check\n');
  for (const result of results) {
    const mark = result.ok ? 'ok  ' : result.fatal ? 'FAIL' : 'warn';
    process.stdout.write(`  ${mark} ${result.name}: ${result.detail}\n`);
  }
  const failures = results.filter((result) => !result.ok && result.fatal);
  const warnings = results.filter((result) => !result.ok && !result.fatal);
  process.stdout.write(`  => ${results.length} checks, ${failures.length} failed, ${warnings.length} warning(s)\n`);
  if (failures.length > 0) return 1;
  // A warning is informational only. A freshly unpacked ZIP has no token yet,
  // and that must not look like a broken installation.
  return 0;
}

/**
 * Build the dispatcher that answers the four methods the relay forwards.
 *
 * Adapters are opened lazily and kept: the first `sessions.list` opens them, and
 * a later failure re-opens on the next call. Every adapter failure becomes a
 * contract-shaped error; a tool this desktop cannot do answers `not_capable`
 * rather than pretending.
 */
function createDispatcher(config, log, factories = {}) {
  const state = { codex: null, dsh: null, workbuddy: null, lastError: { codex: null, dsh: null, workbuddy: null } };
  let workbuddyAdapterConfigKey = null;
  let workbuddyOpenPromise = null;
  let workbuddyLifecycleTail = Promise.resolve();
  let acceptingRequests = true;
  let closePromise = null;
  const createLog = new CreateLog({ path: config.createLogPath });
  /**
   * Numbers that were really measured, `null` wherever nothing has been measured
   * yet. The local page must never invent a zero: "0 threads" and "not measured"
   * read the same to a person, and one of them is a lie.
   */
  const metrics = {
    codex: { tools: null, threads: null },
    dsh: { port: null, pid: null, sessions: null },
    workbuddy: { sessions: null },
  };

  async function codex() {
    if (state.codex !== null) return state.codex;
    const { CodexAdapter } = require('./adapters/codex');
    try {
      const options = {
        pipePath: config.codex.pipePath,
        contextThreadId: config.codex.contextThreadId,
      };
      if (config.codex?.nativeControl?.enabled === true) {
        const nativeControl = config.codex.nativeControl;
        if (typeof nativeControl.registryDir !== 'string' || !path.isAbsolute(nativeControl.registryDir) || !validClientId(nativeControl.runId)) {
          throw new BridgeError('not_capable', 'Codex native control is enabled without a valid private per-launch registry');
        }
        // This directory/run ID is supplied by the opt-in launcher to both the
        // bridge and the same Codex Desktop child. It contains private
        // authenticated loopback descriptors, so never log or return it.
        options.nativeControl = { registryDir: nativeControl.registryDir, runId: nativeControl.runId };
      }
      state.codex = await (factories.codex ?? CodexAdapter.open)(options);
      state.lastError.codex = null;
      metrics.codex.tools = state.codex.availableTools().length;
      log(`codex: pipe ${metrics.codex.tools} tools (${state.codex.availableTools().join(', ')})`);
      return state.codex;
    } catch (error) {
      state.lastError.codex = safeMessage(error);
      throw error;
    }
  }

  async function dsh() {
    if (state.dsh !== null) return state.dsh;
    const { DshAdapter } = require('./adapters/dsh');
    state.dsh = await (factories.dsh ?? DshAdapter.open)({ configuredPort: config.dsh.port });
    const described = state.dsh.describe();
    metrics.dsh.port = described.port ?? null;
    metrics.dsh.pid = described.pid ?? null;
    log(`dsh: backend on ${described.baseUrl}`);
    return state.dsh;
  }

  function workbuddyOptionsSnapshot() {
    const configuredUiAutomation = config.workbuddy?.uiAutomation ?? {};
    const options = {
      configDir: config.workbuddy?.configDir,
      uiAutomation: {
        enabled: configuredUiAutomation.enabled === true,
        ...(typeof configuredUiAutomation.executablePath === 'string'
          ? { executablePath: configuredUiAutomation.executablePath }
          : {}),
      },
    };
    // This in-memory key detects a settings change without returning local
    // paths from status or persisting an additional version field.
    return { options, key: JSON.stringify([options.configDir ?? null, options.uiAutomation.enabled, options.uiAutomation.executablePath ?? null]) };
  }

  async function closeWorkBuddyAdapter(adapter) {
    await adapter?.close?.();
  }

  async function workbuddy() {
    for (;;) {
      const target = workbuddyOptionsSnapshot();
      if (state.workbuddy !== null && workbuddyAdapterConfigKey === target.key) return state.workbuddy;

      if (state.workbuddy !== null) {
        const previous = state.workbuddy;
        state.workbuddy = null;
        workbuddyAdapterConfigKey = null;
        await closeWorkBuddyAdapter(previous);
      }

      if (workbuddyOpenPromise !== null) {
        await workbuddyOpenPromise;
        continue;
      }

      const { WorkBuddyAdapter } = require('./adapters/workbuddy');
      const opening = (async () => {
        try {
          const adapter = await (factories.workbuddy ?? WorkBuddyAdapter.open)(target.options);
          // A local settings request can arrive while open() is pending. Never
          // publish or use an instance created for a superseded configuration.
          if (workbuddyOptionsSnapshot().key !== target.key) {
            await closeWorkBuddyAdapter(adapter);
            return null;
          }
          state.workbuddy = adapter;
          workbuddyAdapterConfigKey = target.key;
          state.lastError.workbuddy = null;
          return adapter;
        } catch (error) {
          state.lastError.workbuddy = safeMessage(error);
          throw error;
        }
      })();
      workbuddyOpenPromise = opening;
      try {
        const opened = await opening;
        if (opened !== null) return opened;
      } finally {
        if (workbuddyOpenPromise === opening) workbuddyOpenPromise = null;
      }
    }
  }

  function withWorkBuddyLifecycle(operation) {
    const running = workbuddyLifecycleTail.then(operation, operation);
    workbuddyLifecycleTail = running.then(() => undefined, () => undefined);
    return running;
  }

  async function pair(open) {
    try {
      return await open();
    } catch (error) {
      return null;
    }
  }

  /**
   * Whether one adapter really implements one optional ability. A method that is
   * missing on a stand-in is "not measured", which is false - never true by
   * default, the same rule protocol-v1 §9.5 sets for every capability bit.
   */
  const adapterFlag = (adapter, method) => {
    if (adapter === null || typeof adapter[method] !== 'function') return false;
    try { return adapter[method]() === true; } catch { return false; }
  };
  const adapterAbility = (adapter, flag, operation) => adapterFlag(adapter, flag) && typeof adapter?.[operation] === 'function';

  /**
   * The capability options for the adapters that really answered.
   *
   * Every bit is the adapter's own answer: a tool that cannot carry a model for
   * the next message, or cannot hand an answer back to a native question, says
   * false instead of letting the phone draw a control whose call must fail.
   */
  function capabilityOptions(codexAdapter, dshAdapter, workbuddyAdapter) {
    const stopWorkbuddy = adapterAbility(workbuddyAdapter, 'canStop', 'stopSession');
    const modelsListWorkbuddy = adapterAbility(workbuddyAdapter, 'canModelsList', 'listModels');
    const sessionCreateWorkbuddy = modelsListWorkbuddy && adapterAbility(workbuddyAdapter, 'canCreate', 'createSession');
    const sendWorkbuddy = adapterAbility(workbuddyAdapter, 'canSend', 'sendMessage');
    const sendModelWorkbuddy = sendWorkbuddy && adapterFlag(workbuddyAdapter, 'canSendWithModel');
    const answerWorkbuddy = adapterAbility(workbuddyAdapter, 'canAnswer', 'answerQuestion');
    const approveWorkbuddy = adapterAbility(workbuddyAdapter, 'canApprove', 'approveRequest');
    return {
      stopCodex: adapterAbility(codexAdapter, 'canStop', 'stopSession'),
      stopDsh: adapterAbility(dshAdapter, 'canStop', 'stopSession'),
      stopWorkbuddy,
      modelsList: codexAdapter !== null || dshAdapter !== null || modelsListWorkbuddy,
      sessionCreate: codexAdapter !== null || dshAdapter !== null || sessionCreateWorkbuddy,
      modelsListWorkbuddy,
      sessionCreateWorkbuddy,
      sendCodex: adapterAbility(codexAdapter, 'canSend', 'sendMessage'),
      sendModelCodex: adapterAbility(codexAdapter, 'canSendWithModel', 'sendMessage'),
      sendModelDsh: adapterAbility(dshAdapter, 'canSendWithModel', 'sendMessage'),
      sendWorkbuddy,
      sendModelWorkbuddy,
      answerCodex: adapterAbility(codexAdapter, 'canAnswer', 'answerQuestion'),
      answerDsh: adapterAbility(dshAdapter, 'canAnswer', 'answerQuestion'),
      answerWorkbuddy,
      // Permission controls are advertised per adapter only when its native
      // request source and explicit decision method have both been measured.
      approveCodex: adapterAbility(codexAdapter, 'canApprove', 'approveRequest'),
      approveDsh: adapterAbility(dshAdapter, 'canApprove', 'approveRequest'),
      approveWorkbuddy,
    };
  }

  function capabilityToolStatus(codexAdapter, dshAdapter, workbuddyAdapter) {
    const workbuddyCapabilities = capabilityOptions(null, null, workbuddyAdapter);
    const workbuddyReadOnly = !(
      workbuddyCapabilities.sendWorkbuddy || workbuddyCapabilities.stopWorkbuddy ||
      workbuddyCapabilities.answerWorkbuddy || workbuddyCapabilities.approveWorkbuddy ||
      workbuddyCapabilities.sessionCreateWorkbuddy
    );
    return {
      codex: codexAdapter === null
        ? { available: false, reason: state.lastError.codex ?? 'no Codex app-tools pipe answered yet' }
        : { available: true },
      dsh: dshAdapter === null
        ? { available: false, reason: 'no DSH backend answered on loopback yet' }
        : { available: true },
      workbuddy: workbuddyAdapter == null
        ? { available: false, reason: state.lastError.workbuddy ?? WORKBUDDY_UNAVAILABLE_REASON }
        : { available: true, ...(workbuddyReadOnly ? { reason: WORKBUDDY_READ_ONLY_REASON } : {}) },
    };
  }

  async function capabilities() {
    const [codexAdapter, dshAdapter, workbuddyAdapter] = await Promise.all([pair(codex), pair(dsh), pair(workbuddy)]);
    const tools = [];
    if (codexAdapter !== null) tools.push('codex');
    if (dshAdapter !== null) tools.push('dsh');
    if (workbuddyAdapter !== null) tools.push('workbuddy');
    const toolStatus = capabilityToolStatus(codexAdapter, dshAdapter, workbuddyAdapter);
    // No default-on: with no session source the hello carries an empty `tools`
    // and false bits, which is the contract's "connected but nothing to show".
    return buildCapabilities(tools, { ...capabilityOptions(codexAdapter, dshAdapter, workbuddyAdapter), toolStatus });
  }

  /**
   * Capability checks for an exact-tool request must be derived from that one
   * adapter. Opening unrelated tools here can start native clients as a side
   * effect of a WorkBuddy request and makes a rejected operation depend on
   * other local tools being available.
   */
  function capabilitiesForTool(tool, adapter) {
    const codexAdapter = tool === 'codex' ? adapter : null;
    const dshAdapter = tool === 'dsh' ? adapter : null;
    const workbuddyAdapter = tool === 'workbuddy' ? adapter : null;
    return buildCapabilities([tool], {
      ...capabilityOptions(codexAdapter, dshAdapter, workbuddyAdapter),
      toolStatus: capabilityToolStatus(codexAdapter, dshAdapter, workbuddyAdapter),
    });
  }

  function route(params, capabilitiesNow) {
    if (params.tool === 'codex') return { open: codex, stopTool: 'codex', capabilities: capabilitiesNow };
    if (params.tool === 'dsh') return { open: dsh, stopTool: 'dsh', capabilities: capabilitiesNow };
    if (params.tool === 'workbuddy') return { open: workbuddy, stopTool: 'workbuddy', capabilities: capabilitiesNow };
    throw new BridgeError('invalid_params', 'params.tool must be "codex", "dsh" or "workbuddy"');
  }

  /**
   * Run one promise with a hard deadline.
   *
   * A slow source must not starve the others: the phone shows one list, and if
   * the Codex app takes fifteen seconds the DSH sessions arrive too late to be
   * useful. On timeout the caller falls back to its last good answer for that
   * source only.
   */
  function withTimeout(promise, timeoutMs, label) {
    let timer = null;
    const timeout = new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new BridgeError('bridge_error', `${label} took too long`)), timeoutMs);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
  }

  /** Last good answer per source, with when it was taken. */
  const lastGood = new Map();

  async function listSource(tool, adapter) {
    const extraIds = tool === 'codex' ? createLog.recentlyCreated('codex', 5) : [];
    const timeoutMs = tool === 'codex' ? CODEX_LIST_TIMEOUT_MS : DSH_LIST_TIMEOUT_MS;
    try {
      const listed = await withTimeout(adapter.listSessions({ extraIds }), timeoutMs, `${tool} list`);
      lastGood.set(tool, { sessions: listed, at: Date.now() });
      return listed;
    } catch (error) {
      const cached = lastGood.get(tool);
      if (cached !== undefined) {
        // Honest staleness: the answer is the last real one, not a fresh read.
        // The phone still gets the other source on time instead of a timeout.
        log(`${tool} list is stale (${safeMessage(error)}); using the answer from ${new Date(cached.at).toISOString()}`);
        return cached.sessions;
      }
      log(`${tool} list failed: ${safeMessage(error)}`);
      return [];
    }
  }

  async function dispatchUnlocked(request) {
    const { method, params } = request;
    const workbuddyHooks = request?.internal?.workbuddyHooks;
    if (method === 'models.list') {
      const routeInfo = route(params);
      const adapter = await pair(routeInfo.open);
      if (adapter === null) {
        if (params.tool === 'workbuddy') {
          throw new BridgeError('tool_unavailable', 'the WorkBuddy session source is not connected');
        }
        // "Connected but nothing to offer" is not an error (§9.5 precedent).
        return buildModelsListResult({ tool: params.tool, models: [] });
      }
      if (params.tool === 'workbuddy' && !adapterAbility(adapter, 'canModelsList', 'listModels')) {
        throw new BridgeError('not_capable', 'this WorkBuddy session source cannot list native models');
      }
      try {
        if (params.tool === 'workbuddy') workbuddyHooks?.checkActive?.();
        const listed = params.tool === 'workbuddy'
          ? await adapter.listModels(workbuddyHooks)
          : await adapter.listModels();
        return buildModelsListResult({ tool: params.tool, models: listed.models, projects: listed.projects });
      } catch (error) {
        log(`models.list failed: ${safeMessage(error)}`);
        if (params.tool === 'workbuddy') throw error;
        return buildModelsListResult({ tool: params.tool, models: [] });
      }
    }

    if (method === 'session.create') {
      const routeInfo = route(params);
      const adapter = await pair(routeInfo.open);
      if (adapter === null) {
        throw new BridgeError('tool_unavailable', `the ${params.tool} session source is not connected`);
      }
      if (params.tool === 'workbuddy' && !(
        adapterAbility(adapter, 'canModelsList', 'listModels') &&
        adapterAbility(adapter, 'canCreate', 'createSession')
      )) {
        throw new BridgeError('not_capable', 'this WorkBuddy session source cannot list models and create native sessions');
      }
      if (params.tool === 'workbuddy') workbuddyHooks?.checkActive?.();
      const listed = params.tool === 'workbuddy'
        ? await adapter.listModels({ ...workbuddyHooks, allowWindowActivation: true }).catch(() => ({ models: [], projects: [] }))
        : await adapter.listModels().catch(() => ({ models: [], projects: [] }));
      // The create path intentionally treats an unavailable model catalog as
      // empty, but a caller whose deadline elapsed while reading it must not
      // proceed into the create reservation or native UI action.
      if (params.tool === 'workbuddy') workbuddyHooks?.checkActive?.();
      // An empty catalog is not "anything goes": with nothing to check against,
      // the honest answer is that no model can be chosen, and no native session
      // is created at all.
      if (listed.models.length === 0) {
        throw new BridgeError('model_not_available', 'this computer reports no model catalog for that tool');
      }
      // Membership is checked on the pair that really identifies a model: the
      // same id exists under several DSH providers, and the wrong provider means
      // a session created with somebody else's route.
      const match = listed.models.find(
        (model) => model.id === params.model && (params.tool !== 'dsh' || model.provider === params.provider),
      );
      if (match === undefined) {
        throw new BridgeError('model_not_available', 'that model is not in this tool\'s catalog');
      }
      if (typeof params.reasoningEffort === 'string') {
        const efforts = Array.isArray(match.reasoningEfforts) ? match.reasoningEfforts : [];
        if (efforts.length > 0 && !efforts.includes(params.reasoningEffort)) {
          throw new BridgeError('invalid_params', 'that reasoning effort is not offered for this model');
        }
      }

      const runCreate = (onCreated) => {
        const input = {
          model: params.model,
          provider: params.provider,
          reasoningEffort: params.reasoningEffort,
          cwd: params.cwd,
          projectId: params.projectId,
          text: params.text,
        };
        if (params.tool === 'workbuddy') {
          workbuddyHooks?.checkActive?.();
          return adapter.createSession(input, { onCreated }, workbuddyHooks);
        }
        return adapter.createSession(input, { onCreated });
      };

      // The log is what makes a retry cheap and a double tap harmless: it
      // reserves the key on disk before the native call, coalesces concurrent
      // callers, and never creates twice for one key.
      const outcome = await createLog.run(params.requestId, fingerprintOf(params), async (onCreated) => {
        const created = await runCreate((value) => {
          const provisional = buildSessionCreateResult({
            sessionId: value.sessionId,
            tool: params.tool,
            title: value.title,
            model: params.model,
            provider: params.tool === 'dsh' ? params.provider : undefined,
            reasoningEffort: params.reasoningEffort,
            partial: true,
            incomplete: 'the remaining steps had not finished yet',
          });
          onCreated({ sessionId: value.sessionId, result: provisional });
        });
        return buildSessionCreateResult({
          sessionId: created.sessionId,
          tool: params.tool,
          title: created.title,
          model: params.model,
          provider: params.tool === 'dsh' ? params.provider : undefined,
          reasoningEffort: params.reasoningEffort,
          partial: created.partial === true,
          incomplete: created.incomplete,
        });
      });
      return outcome.deduplicated ? { ...outcome.result, deduplicated: true } : outcome.result;
    }

    if (method === 'sessions.list') {
      const [codexAdapter, dshAdapter, workbuddyAdapter] = await Promise.all([pair(codex), pair(dsh), pair(workbuddy)]);
      const tools = [];
      if (codexAdapter !== null) tools.push('codex');
      if (dshAdapter !== null) tools.push('dsh');
      if (workbuddyAdapter !== null) tools.push('workbuddy');
      const sessions = [];
      const capabilitiesNow = buildCapabilities(tools, {
        ...capabilityOptions(codexAdapter, dshAdapter, workbuddyAdapter),
        toolStatus: capabilityToolStatus(codexAdapter, dshAdapter, workbuddyAdapter),
      });
      for (const [tool, adapter] of [
        ['codex', codexAdapter],
        ['dsh', dshAdapter],
        ['workbuddy', workbuddyAdapter],
      ]) {
        if (adapter === null) continue;
        // Each source answers under its own deadline and falls back to its own
        // last good answer, so one slow app cannot take the whole list - and the
        // other source's sessions - past the phone's patience.
        const listed = await listSource(tool, adapter);
        metrics[tool][tool === 'codex' ? 'threads' : 'sessions'] = listed.length;
        sessions.push(...listed);
      }
      if (params.tool !== undefined) {
        return buildSessionsListResult({ sessions: sessions.filter((session) => session.tool === params.tool), capabilities: capabilitiesNow });
      }
      return buildSessionsListResult({ sessions, capabilities: capabilitiesNow });
    }

    const routeInfo = route(params);
    const adapter = await pair(() => routeInfo.open());
    if (adapter === null) {
      throw new BridgeError('tool_unavailable', `the ${params.tool} session source is not connected`);
    }
    const capabilitiesNow = capabilitiesForTool(params.tool, adapter);

    if (method === 'session.read') {
      let session;
      if (params.tool === 'workbuddy') {
        workbuddyHooks?.checkActive?.();
        session = typeof adapter.readSessionLive === 'function'
          ? await adapter.readSessionLive(params.sessionId, workbuddyHooks)
          : await adapter.readSession(params.sessionId);
        workbuddyHooks?.checkActive?.();
      } else {
        session = await adapter.readSession(params.sessionId);
      }
      return buildSessionReadResult({
        id: session.id,
        tool: session.tool,
        title: session.title,
        status: session.status,
        messages: session.messages,
        canStop: session.status === 'working' && capabilitiesNow[`stop:${session.tool}`] === true && session.canStop !== false,
        activeTurnId: session.activeTurnId,
        // Both travel only when the adapter really read them from native state.
        currentModel: session.currentModel,
        pendingQuestions: session.pendingQuestions,
        // A native permission approval only ever exists on the adapter's own
        // native event stream; absent means this bridge saw none.
        pendingApprovals: session.pendingApprovals,
        historyTruncated: session.historyTruncated,
      });
    }
    if (method === 'session.send') {
      // A present per-tool bit is authoritative. This prevents a generic send
      // capability advertised by another adapter from making a read-only tool
      // look writable on either the phone or this dispatcher.
      const sendCapability = `session.send:${params.tool}`;
      if (Object.prototype.hasOwnProperty.call(capabilitiesNow, sendCapability) && capabilitiesNow[sendCapability] !== true) {
        throw new BridgeError('not_capable', `this ${params.tool} session cannot receive messages`);
      }
      // CRD 0008 §B: a model for the NEXT message. Omitting it is the old
      // request exactly. The capability bit and the call agree: a tool whose
      // schema documents no model catalog refuses here, rather than sending a
      // model nobody could validate.
      if (params.model !== undefined && capabilitiesNow[`session.send:model:${params.tool}`] !== true) {
        throw new BridgeError('not_capable', `this ${params.tool} session cannot choose a model for the next message`);
      }
      const sendOptions = {
        model: params.model,
        provider: params.provider,
        reasoningEffort: params.reasoningEffort,
      };
      if (params.tool === 'workbuddy') {
        workbuddyHooks?.checkActive?.();
        await adapter.sendMessage(params.sessionId, params.text, sendOptions, workbuddyHooks);
      } else {
        await adapter.sendMessage(params.sessionId, params.text, sendOptions);
      }
      return buildSessionSendResult(params.sessionId);
    }
    if (method === 'session.answer') {
      // CRD 0008 §D: shape is checked by parseRequest; whether the call is
      // really waiting - and whether it can be answered at all on this tool - is
      // the adapter's fresh check against native state. No approval, no retry,
      // and no auto-answer ever happens here.
      if (capabilitiesNow[`session.answer:${params.tool}`] !== true || typeof adapter.answerQuestion !== 'function') {
        throw new BridgeError('not_capable', `this ${params.tool} session cannot answer a question`);
      }
      if (params.tool === 'workbuddy') workbuddyHooks?.checkActive?.();
      const answered = params.tool === 'workbuddy'
        ? await adapter.answerQuestion(params.sessionId, params.callId, params.answers, workbuddyHooks)
        : await adapter.answerQuestion(params.sessionId, params.callId, params.answers);
      // The existing DSH adapter returns only after its native acceptance /
      // exact-answer check, so retain that established confirmation semantics.
      // New ACP adapters must report confirmed only when they prove this exact
      // answer from native state; transport acknowledgement defaults to submitted.
      const answerState = answered?.state === undefined
        ? (params.tool === 'dsh' ? 'confirmed' : 'submitted')
        : answered.state;
      return buildSessionAnswerResult(params.sessionId, params.callId, answerState);
    }
    if (method === 'session.approve') {
      // Requirement F: one explicit human decision for one live native request.
      // The dispatcher only checks that this tool can decide at all; whether that
      // exact request is still waiting is the adapter's fresh check against the
      // live native event stream. Nothing here retries, auto-approves, changes a
      // policy or forwards an arbitrary command.
      if (capabilitiesNow[`session.approve:${params.tool}`] !== true || typeof adapter.approveRequest !== 'function') {
        throw new BridgeError('not_capable', `this ${params.tool} session cannot decide a permission approval`);
      }
      if (params.tool === 'workbuddy') workbuddyHooks?.checkActive?.();
      const decided = params.tool === 'workbuddy'
        ? await adapter.approveRequest(params.sessionId, params.approvalId, params.decision, workbuddyHooks)
        : await adapter.approveRequest(params.sessionId, params.approvalId, params.decision);
      return buildSessionApproveResult({
        sessionId: params.sessionId,
        approvalId: params.approvalId,
        // `submitted` is what the transport did; `confirmed` needs native proof
        // that the adapter read itself. Never upgraded here.
        state: decided?.state === 'confirmed' ? 'confirmed' : 'submitted',
      });
    }
    if (method === 'session.stop') {
      if (capabilitiesNow[`stop:${params.tool}`] !== true || !adapterAbility(adapter, 'canStop', 'stopSession')) {
        throw new BridgeError('not_capable', `this ${params.tool} session cannot be stopped`);
      }
      if (params.tool === 'workbuddy') {
        workbuddyHooks?.checkActive?.();
        await adapter.stopSession(params.sessionId, workbuddyHooks);
      } else {
        await adapter.stopSession(params.sessionId);
      }
      return buildSessionStopResult(params.sessionId);
    }
    throw new BridgeError('unknown_method', 'method is not allowed');
  }

  function dispatch(request) {
    if (!acceptingRequests) {
      return Promise.reject(new BridgeError('bridge_error', 'this computer is stopping and no longer accepts requests'));
    }
    const method = request?.method;
    const params = request?.params;
    // `sessions.list` reads WorkBuddy alongside the other sources, and every
    // exact WorkBuddy request may use its foreground UI writer. Serialize both
    // with local refresh so an accepted native action is never interrupted,
    // replayed, or raced against adapter replacement.
    if (method === 'sessions.list' || params?.tool === 'workbuddy') {
      return withWorkBuddyLifecycle(() => {
        // A timed-out WorkBuddy request may have spent its whole budget behind
        // a refresh or an earlier native action. Check it as soon as its turn
        // reaches the writer queue, before opening or touching native UI state.
        if (params?.tool === 'workbuddy') request?.internal?.workbuddyHooks?.checkActive?.();
        return dispatchUnlocked(request);
      });
    }
    return dispatchUnlocked(request);
  }

  /**
   * Release both adapters. The bridge itself is resident and never calls this;
   * a one-shot script must, because an open Codex named pipe keeps the Node event
   * loop alive for ever.
   */
  function stopAccepting() {
    acceptingRequests = false;
  }

  function close() {
    stopAccepting();
    if (closePromise !== null) return closePromise;
    closePromise = (async () => {
      await withWorkBuddyLifecycle(async () => {
        const previous = state.workbuddy;
        state.workbuddy = null;
        workbuddyAdapterConfigKey = null;
        await closeWorkBuddyAdapter(previous);
      });
      for (const key of ['codex', 'dsh']) {
        const previous = state[key];
        state[key] = null;
        try { await previous?.close?.(); } catch { /* the old adapter is already gone */ }
      }
    })();
    return closePromise;
  }

  /** Re-open only WorkBuddy after a local settings change; never touch its process. */
  function refreshWorkBuddy() {
    if (closePromise !== null) {
      return Promise.reject(new BridgeError('bridge_error', 'this computer is stopping'));
    }
    return withWorkBuddyLifecycle(async () => {
      metrics.workbuddy.sessions = null;
      lastGood.delete('workbuddy');
      // workbuddy() reuses an unchanged instance, but awaits its close before
      // replacement when the saved local configuration has changed.
      return capabilities();
    });
  }

  /**
   * What the local page may show. Every number here was really measured, and a
   * field that was not measured is `null` so the page prints no number at all
   * instead of a zero it made up.
   */
  return {
    dispatch,
    close,
    stopAccepting,
    refreshWorkBuddy,
    describe: () => ({
      codex: {
        available: state.codex !== null,
        tools: metrics.codex.tools,
        threads: metrics.codex.threads,
        reason: state.codex === null ? state.lastError.codex ?? 'no Codex app-tools pipe answered yet' : null,
      },
      dsh: {
        available: state.dsh !== null,
        port: metrics.dsh.port,
        pid: metrics.dsh.pid,
        sessions: metrics.dsh.sessions,
        reason: state.dsh === null ? 'no DSH backend answered on loopback yet' : null,
      },
      workbuddy: {
        available: state.workbuddy !== null,
        sessions: metrics.workbuddy.sessions,
        readOnly: state.workbuddy === null
          ? null
          : capabilityToolStatus(state.codex, state.dsh, state.workbuddy).workbuddy.reason === WORKBUDDY_READ_ONLY_REASON,
        reason: state.workbuddy === null
          ? state.lastError.workbuddy ?? WORKBUDDY_UNAVAILABLE_REASON
          : capabilityToolStatus(state.codex, state.dsh, state.workbuddy).workbuddy.reason ?? null,
        uiAutomation: describeWorkBuddyUiAutomation(state.workbuddy, config.workbuddy?.uiAutomation),
      },
    }),
  };
}

async function run(config, args, log) {
  const clientName = config.clientName ?? os.hostname().slice(0, 64) ?? 'DESKTOP';
  const dispatcher = createDispatcher(config, log);
  const bridgeRequested = config.autoStartBridge && !args.noBridge;
  let token = config.bridgeToken;
  if (token === null && typeof args.tokenFile === 'string') token = readTokenFile(args.tokenFile);
  let identityPersisted = true;
  if (config.clientId === null && (token !== null || config.ownerName !== null)) {
    const clientId = newClientId();
    try {
      saveConfig(config.configFile, { clientId });
      config.clientId = clientId;
    } catch {
      identityPersisted = false;
      log('could not save a stable computer ID; the relay link stays down until the local config can be written');
    }
  }
  const bridgeEnabled = bridgeRequested && identityPersisted;
  const status = {
    identity: { clientId: config.clientId, ownerName: config.ownerName },
    bridge: {
      connected: false,
      clientName,
      clientId: config.clientId,
      ownerName: config.ownerName,
      relayUrl: config.relayUrl,
      capabilities: {},
    },
    codex: { available: false, reason: 'not connected yet' },
    dsh: { available: false, reason: 'not connected yet' },
    workbuddy: { available: false, reason: WORKBUDDY_UNAVAILABLE_REASON },
    pairing: null,
  };

  let bridge = null;

  function updateStatusFromAdapters() {
    const described = dispatcher.describe();
    status.codex = { ...described.codex };
    status.dsh = { ...described.dsh };
    status.workbuddy = { ...described.workbuddy };
    return described;
  }

  async function currentCapabilities() {
    try {
      const listed = await dispatcher.dispatch({ method: 'sessions.list', params: {} });
      updateStatusFromAdapters();
      return listed.capabilities;
    } catch {
      const described = updateStatusFromAdapters();
      const toolStatus = {
        codex: described.codex.available ? { available: true } : { available: false, reason: described.codex.reason },
        dsh: described.dsh.available ? { available: true } : { available: false, reason: described.dsh.reason },
        workbuddy: {
          available: described.workbuddy.available,
          ...(typeof described.workbuddy.reason === 'string' ? { reason: described.workbuddy.reason } : {}),
        },
      };
      // If the combined session list itself failed, membership is unknown. Do
      // not claim any configured tool as an opened native session adapter.
      return buildCapabilities([], { toolStatus });
    }
  }

  function setBridgeListeners(instance) {
    instance.on('ready', (negotiated) => {
      status.bridge.connected = true;
      log(`relay link ready (heartbeat ${negotiated.heartbeatIntervalMs} ms)`);
    });
    instance.on('close', () => {
      status.bridge.connected = false;
      log('relay link closed; reconnecting with backoff');
    });
    instance.on('auth.rejected', () => log('the relay refused the token: retrying slowly, check the token'));
    instance.on('pair.used', (event) => log(`a phone paired: ${event.deviceName}`));
    instance.on('error', (error) => log(`bridge error: ${safeMessage(error)}`));
    instance.on('request.received', (request) => log(`request: ${request.method}`));
  }

  async function startBridge(token, relayUrl = config.relayUrl) {
    const capabilities = await currentCapabilities();
    status.bridge.capabilities = capabilities;
    status.bridge.relayUrl = relayUrl;
    status.bridge.clientId = config.clientId;
    status.bridge.ownerName = config.ownerName;
    const instance = new BridgeClient({
      url: relayUrl,
      token,
      clientId: config.clientId,
      ownerName: config.ownerName,
      clientName,
      capabilities,
      dispatch: dispatcher.dispatch,
    });
    bridge = instance;
    setBridgeListeners(instance);
    await instance.start();
    const connected = await instance.waitUntilConnected(15000);
    status.bridge.connected = connected;
    log(connected ? 'connected to the relay' : 'the relay link is not up yet; the bridge keeps retrying');
  }

  const ui = new LocalUiServer({
    port: config.uiPort,
    state: () => {
      const described = updateStatusFromAdapters();
      // Only measured numbers travel; the page decides how to say "not measured".
      return {
        ...status,
        identity: { ...status.identity },
        bridge: { ...status.bridge, connected: bridge === null ? false : bridge.connected },
        codex: { ...described.codex },
        dsh: { ...described.dsh },
        workbuddy: { ...described.workbuddy },
      };
    },
    onPairCreate: async () => {
      if (bridge === null || !bridge.connected) {
        throw new BridgeError('bridge_error', 'the relay link is not up');
      }
      const created = await bridge.createPairCode();
      status.pairing = { codeId: created.id, expiresAt: created.expiresAt };
      return created;
    },
    onIdentityUpdate: async ({ ownerName: rawOwnerName }) => {
      let ownerName;
      try { ownerName = normalizeOwnerName(rawOwnerName); } catch (error) {
        throw new EnrollmentError('invalid_params', error.message, 400);
      }
      const clientId = config.clientId ?? newClientId();
      try {
        saveConfig(config.configFile, { clientId, ownerName });
      } catch {
        throw new EnrollmentError('config_write_failed', 'Could not save the computer settings.', 500);
      }
      config.clientId = clientId;
      config.ownerName = ownerName;
      identityPersisted = true;
      status.identity = { clientId, ownerName };
      status.bridge.clientId = clientId;
      status.bridge.ownerName = ownerName;
      let helloSent = bridge === null ? false : bridge.updateIdentity({ clientId, ownerName, clientName });
      if (bridge === null && bridgeRequested && token !== null) {
        await startBridge(token);
        helloSent = bridge?.connected === true;
      }
      return { identity: { clientId, ownerName }, helloUpdated: helloSent };
    },
    onWorkBuddyUiAutomationUpdate: async ({ enabled, executablePath }) => {
      let normalizedExecutablePath = config.workbuddy?.uiAutomation?.executablePath ?? null;
      if (executablePath !== undefined) {
        try {
          normalizedExecutablePath = normalizeWorkBuddyExecutablePath(executablePath);
        } catch (error) {
          throw new EnrollmentError('invalid_params', error.message, 400);
        }
      }
      const uiAutomation = {
        enabled,
        executablePath: normalizedExecutablePath,
        configurationValid: true,
      };
      try {
        saveConfig(config.configFile, { workbuddy: { uiAutomation } });
      } catch {
        throw new EnrollmentError('config_write_failed', 'Could not save the local WorkBuddy settings.', 500);
      }
      config.workbuddy = { ...config.workbuddy, uiAutomation };

      // The explicit local click replaces only this adapter. Its close method
      // releases local reader/helper resources and must not start or stop the
      // WorkBuddy process. The same authenticated bridge then advertises the
      // newly measured flags without changing client identity or credentials.
      const capabilities = await dispatcher.refreshWorkBuddy();
      const described = updateStatusFromAdapters();
      status.bridge.capabilities = capabilities;
      const capabilitiesUpdated = bridge !== null && typeof bridge.updateCapabilities === 'function'
        ? bridge.updateCapabilities(capabilities)
        : false;
      return {
        uiAutomation: {
          enabled,
          executablePathConfigured: typeof normalizedExecutablePath === 'string',
          configurationValid: true,
        },
        workbuddyAvailable: described.workbuddy.available,
        readOnly: described.workbuddy.readOnly,
        capabilitiesUpdated,
      };
    },
    onEnroll: async ({ code, ownerName: rawOwnerName, relayUrl: rawRelayUrl }) => {
      if (config.bridgeTokenOverridden || config.relayUrlOverridden || args.relay !== undefined) {
        throw new EnrollmentError(
          'config_override',
          'Enrollment is disabled while the relay URL or bridge credential is set by an environment or command-line override.',
          409,
        );
      }
      let ownerName;
      try { ownerName = normalizeOwnerName(rawOwnerName); } catch (error) {
        throw new EnrollmentError('invalid_params', error.message, 400);
      }
      const clientId = config.clientId ?? newClientId();
      try {
        // Check that the private config can be atomically replaced before the
        // relay consumes this one-use invitation. This does not save its code.
        saveConfig(config.configFile, {});
      } catch {
        throw new EnrollmentError('config_write_failed', 'Make the local config file writable before using an enrollment code.', 500);
      }
      const enrollment = await enrollDesktop({
        relayAddress: rawRelayUrl,
        code,
        clientId,
        ownerName,
        clientName,
      });
      try {
        saveConfig(config.configFile, {
          clientId,
          ownerName,
          relayUrl: enrollment.relayUrl,
          bridgeToken: enrollment.bridgeToken,
        });
      } catch {
        throw new EnrollmentError(
          'config_write_failed',
          'The relay accepted the invitation, but the private computer credential could not be saved. Ask for a fresh invitation before retrying.',
          500,
        );
      }
      config.clientId = clientId;
      config.ownerName = ownerName;
      identityPersisted = true;
      config.relayUrl = enrollment.relayUrl;
      config.bridgeToken = enrollment.bridgeToken;
      token = enrollment.bridgeToken;
      status.identity = { clientId, ownerName };
      status.bridge.clientId = clientId;
      status.bridge.ownerName = ownerName;
      status.bridge.relayUrl = enrollment.relayUrl;
      if (bridge !== null) {
        bridge.updateConnection({
          url: enrollment.relayUrl,
          token: enrollment.bridgeToken,
          clientId,
          ownerName,
          clientName,
        });
        status.bridge.connected = false;
      } else if (bridgeRequested) {
        await startBridge(enrollment.bridgeToken, enrollment.relayUrl);
      }
      return {
        identity: { clientId, ownerName },
        relayUrl: enrollment.relayUrl,
        connected: bridge === null ? false : bridge.connected,
        connecting: bridge !== null && ['connecting', 'handshaking', 'reconnecting'].includes(bridge.state),
      };
    },
  });
  const started = await ui.start();
  log(`local UI on ${started.url} (loopback only)`);
  log(`config: ${JSON.stringify(redactedConfig(config))}`);

  if (!bridgeEnabled) {
    if (!bridgeRequested) {
      log('relay link disabled (--no-bridge): the local UI is up, nothing is connected');
    }
    return {
      ui, get bridge() { return bridge; }, clientName,
      stopAcceptingRequests: () => dispatcher.stopAccepting(),
      closeAdapters: () => dispatcher.close(),
    };
  }
  if (token === null) {
    log('no bridge token configured: the local UI is up, the relay link stays down');
    log('set bridgeToken in the config file, or AI_REMOTE_BRIDGE_TOKEN, or pass --token-file <path>');
    return {
      ui, get bridge() { return bridge; }, clientName,
      stopAcceptingRequests: () => dispatcher.stopAccepting(),
      closeAdapters: () => dispatcher.close(),
    };
  }

  await startBridge(token);
  return {
    ui, get bridge() { return bridge; }, clientName,
    stopAcceptingRequests: () => dispatcher.stopAccepting(),
    closeAdapters: () => dispatcher.close(),
  };
}

async function main(argv = process.argv.slice(2)) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (error) {
    process.stderr.write(`${safeMessage(error)}\n\n${USAGE}`);
    return 2;
  }
  if (args.help) {
    process.stdout.write(USAGE);
    return 0;
  }
  if (args.version) {
    process.stdout.write(`${VERSION}\n`);
    return 0;
  }

  const config = loadConfig({ path: args.configFile ?? configPath(), env: process.env });
  if (args.relay !== undefined) config.relayUrl = args.relay;
  if (args.port !== undefined && Number.isInteger(args.port)) config.uiPort = args.port;
  if (typeof args.tokenFile === 'string') config.tokenFile = args.tokenFile;

  const log = (message) => process.stdout.write(`${new Date().toISOString()} ${message}\n`);

  if (args.selfCheck) {
    return selfCheck(config);
  }

  // The opt-in launcher supplies a private per-run stop credential only to the
  // bridge process. Validate it before opening listeners so the launcher never
  // starts a hidden bridge that it cannot later stop after Codex exits.
  const stopRequestConfig = readRunStopRequestConfig(config.codex?.nativeControl, process.env);
  const running = await run(config, args, log);
  let shutdownPromise = null;
  let stopWatcher = null;
  const shutdown = () => {
    if (shutdownPromise !== null) return shutdownPromise;
    stopWatcher?.close();
    running.stopAcceptingRequests?.();
    shutdownPromise = (async () => {
      log('stopping');
      try {
        await running.bridge?.stop();
        await running.ui.stop();
        await running.closeAdapters?.();
        process.exit(0);
      } catch (error) {
        log(`graceful shutdown failed: ${safeMessage(error)}`);
      }
    })();
    return shutdownPromise;
  };
  stopWatcher = createRunStopRequestWatcher(stopRequestConfig, shutdown);
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
  log('running; press Ctrl+C to stop');
  return null; // keep running
}

if (require.main === module) {
  main().then(
    (code) => {
      if (code !== null) process.exit(code);
    },
    (error) => {
      process.stderr.write(`fatal: ${safeMessage(error)}\n`);
      process.exit(1);
    },
  );
}

module.exports = { main, parseArgs, selfCheck, createDispatcher, USAGE };
