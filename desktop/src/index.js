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

const { loadConfig, readTokenFile, redactedConfig, configPath, normalizeOwnerName, newClientId, saveConfig } = require('./config');
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

/**
 * Per-source deadlines for `sessions.list`, measured on this machine: a Codex
 * list is about 1.2 s and a DSH list about 1 s when healthy, while a Codex
 * `read_thread` on a long thread has been seen to exceed 15 s. These budgets keep
 * one slow source from starving the other, and the caller falls back to that
 * source's last good answer rather than failing the whole list.
 */
const CODEX_LIST_TIMEOUT_MS = 8000;
const DSH_LIST_TIMEOUT_MS = 5000;
const WORKBUDDY_UNAVAILABLE_REASON =
  'WorkBuddy 未接入此桥接器的受信会话控制通道。已检视的本机接口依赖 WorkBuddy 内部上下文；当前本桥接器不能真实读取或操作它的会话、模型、项目、提问与审批。';

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
  AI_REMOTE_DSH_PORT, AI_REMOTE_NO_BRIDGE

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

  for (const module of ['./ws', './bridge', './protocol', './errors', './framing', './dsh-events', './adapters/codex', './adapters/dsh', './ui/server']) {
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
  const state = { codex: null, dsh: null, lastError: { codex: null, dsh: null } };
  const createLog = new CreateLog({ path: config.createLogPath });
  /**
   * Numbers that were really measured, `null` wherever nothing has been measured
   * yet. The local page must never invent a zero: "0 threads" and "not measured"
   * read the same to a person, and one of them is a lie.
   */
  const metrics = {
    codex: { tools: null, threads: null },
    dsh: { port: null, pid: null, sessions: null },
  };

  async function codex() {
    if (state.codex !== null) return state.codex;
    const { CodexAdapter } = require('./adapters/codex');
    state.codex = await (factories.codex ?? CodexAdapter.open)({
      pipePath: config.codex.pipePath,
      contextThreadId: config.codex.contextThreadId,
    });
    metrics.codex.tools = state.codex.availableTools().length;
    log(`codex: pipe ${metrics.codex.tools} tools (${state.codex.availableTools().join(', ')})`);
    return state.codex;
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
  const adapterFlag = (adapter, method) => adapter !== null && typeof adapter[method] === 'function' && adapter[method]() === true;

  /**
   * The capability options for the adapters that really answered.
   *
   * Every bit is the adapter's own answer: a tool that cannot carry a model for
   * the next message, or cannot hand an answer back to a native question, says
   * false instead of letting the phone draw a control whose call must fail.
   */
  function capabilityOptions(codexAdapter, dshAdapter) {
    return {
      stopCodex: codexAdapter === null ? false : codexAdapter.canStop(),
      stopDsh: dshAdapter === null ? false : dshAdapter.canStop(),
      modelsList: codexAdapter !== null || dshAdapter !== null,
      sessionCreate: codexAdapter !== null || dshAdapter !== null,
      sendModelCodex: adapterFlag(codexAdapter, 'canSendWithModel'),
      sendModelDsh: adapterFlag(dshAdapter, 'canSendWithModel'),
      answerCodex: adapterFlag(codexAdapter, 'canAnswer'),
      answerDsh: adapterFlag(dshAdapter, 'canAnswer'),
      // Requirement F: per tool, because only one of the two channels really
      // carries a native permission request. Codex's app-tools pipe has no such
      // surface, so its bit is false and the phone draws no button for it.
      approveCodex: adapterFlag(codexAdapter, 'canApprove'),
      approveDsh: adapterFlag(dshAdapter, 'canApprove'),
    };
  }

  function capabilityToolStatus(codexAdapter, dshAdapter) {
    return {
      codex: codexAdapter === null
        ? { available: false, reason: 'no Codex app-tools pipe answered yet' }
        : { available: true },
      dsh: dshAdapter === null
        ? { available: false, reason: 'no DSH backend answered on loopback yet' }
        : { available: true },
      workbuddy: { available: false, reason: WORKBUDDY_UNAVAILABLE_REASON },
    };
  }

  async function capabilities() {
    const [codexAdapter, dshAdapter] = await Promise.all([pair(codex), pair(dsh)]);
    const tools = [];
    if (codexAdapter !== null) tools.push('codex');
    if (dshAdapter !== null) tools.push('dsh');
    const toolStatus = capabilityToolStatus(codexAdapter, dshAdapter);
    // No default-on: with no session source the hello carries an empty `tools`
    // and false bits, which is the contract's "connected but nothing to show".
    return buildCapabilities(tools, { ...capabilityOptions(codexAdapter, dshAdapter), toolStatus });
  }

  function route(params, capabilitiesNow) {
    if (params.tool === 'codex') return { open: codex, stopTool: 'codex', capabilities: capabilitiesNow };
    if (params.tool === 'dsh') return { open: dsh, stopTool: 'dsh', capabilities: capabilitiesNow };
    if (params.tool === 'workbuddy') {
      throw new BridgeError('not_capable', 'WorkBuddy session control is unavailable on this desktop');
    }
    throw new BridgeError('invalid_params', 'params.tool must be "codex" or "dsh"');
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

  async function dispatch({ method, params }) {
    if (method === 'models.list') {
      const adapter = await pair(params.tool === 'codex' ? codex : dsh);
      if (adapter === null) {
        // "Connected but nothing to offer" is not an error (§9.5 precedent).
        return buildModelsListResult({ tool: params.tool, models: [] });
      }
      try {
        const listed = await adapter.listModels();
        return buildModelsListResult({ tool: params.tool, models: listed.models, projects: listed.projects });
      } catch (error) {
        log(`models.list failed: ${safeMessage(error)}`);
        return buildModelsListResult({ tool: params.tool, models: [] });
      }
    }

    if (method === 'session.create') {
      const adapter = await pair(params.tool === 'codex' ? codex : dsh);
      if (adapter === null) {
        throw new BridgeError('tool_unavailable', `the ${params.tool} session source is not connected`);
      }
      const listed = await adapter.listModels().catch(() => ({ models: [], projects: [] }));
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

      const runCreate = (onCreated) =>
        adapter.createSession(
          {
            model: params.model,
            provider: params.provider,
            reasoningEffort: params.reasoningEffort,
            cwd: params.cwd,
            projectId: params.projectId,
            text: params.text,
          },
          { onCreated },
        );

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
      if (params.tool === 'workbuddy') {
        throw new BridgeError('not_capable', 'WorkBuddy sessions are unavailable on this desktop');
      }
      const [codexAdapter, dshAdapter] = await Promise.all([pair(codex), pair(dsh)]);
      const tools = [];
      if (codexAdapter !== null) tools.push('codex');
      if (dshAdapter !== null) tools.push('dsh');
      const sessions = [];
      const capabilitiesNow = buildCapabilities(tools, {
        ...capabilityOptions(codexAdapter, dshAdapter),
        toolStatus: capabilityToolStatus(codexAdapter, dshAdapter),
      });
      for (const [tool, adapter] of [
        ['codex', codexAdapter],
        ['dsh', dshAdapter],
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

    const capabilitiesNow = await capabilities();
    const routeInfo = route(params, capabilitiesNow);
    const adapter = await pair(() => routeInfo.open());
    if (adapter === null) {
      throw new BridgeError('bridge_error', `the ${params.tool} session source is not connected`);
    }

    if (method === 'session.read') {
      const session = await adapter.readSession(params.sessionId);
      return buildSessionReadResult({
        id: session.id,
        tool: session.tool,
        title: session.title,
        status: session.status,
        messages: session.messages,
        canStop: session.status === 'working' && capabilitiesNow[`stop:${session.tool}`] === true,
        activeTurnId: session.activeTurnId,
        // Both travel only when the adapter really read them from native state.
        currentModel: session.currentModel,
        pendingQuestions: session.pendingQuestions,
        // A native permission approval only ever exists on the adapter's own
        // native event stream; absent means this bridge saw none.
        pendingApprovals: session.pendingApprovals,
      });
    }
    if (method === 'session.send') {
      // CRD 0008 §B: a model for the NEXT message. Omitting it is the old
      // request exactly. The capability bit and the call agree: a tool whose
      // schema documents no model catalog refuses here, rather than sending a
      // model nobody could validate.
      if (params.model !== undefined && capabilitiesNow[`session.send:model:${params.tool}`] !== true) {
        throw new BridgeError('not_capable', `this ${params.tool} session cannot choose a model for the next message`);
      }
      await adapter.sendMessage(params.sessionId, params.text, {
        model: params.model,
        provider: params.provider,
        reasoningEffort: params.reasoningEffort,
      });
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
      await adapter.answerQuestion(params.sessionId, params.callId, params.answers);
      return buildSessionAnswerResult(params.sessionId, params.callId);
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
      const decided = await adapter.approveRequest(params.sessionId, params.approvalId, params.decision);
      return buildSessionApproveResult({
        sessionId: params.sessionId,
        approvalId: params.approvalId,
        // `submitted` is what the transport did; `confirmed` needs native proof
        // that the adapter read itself. Never upgraded here.
        state: decided?.state === 'confirmed' ? 'confirmed' : 'submitted',
      });
    }
    if (method === 'session.stop') {
      if (capabilitiesNow[`stop:${params.tool}`] !== true || adapter.canStop() !== true) {
        throw new BridgeError('not_capable', `this ${params.tool} session cannot be stopped`);
      }
      await adapter.stopSession(params.sessionId);
      return buildSessionStopResult(params.sessionId);
    }
    throw new BridgeError('unknown_method', 'method is not allowed');
  }

  /**
   * Release both adapters. The bridge itself is resident and never calls this;
   * a one-shot script must, because an open Codex named pipe keeps the Node event
   * loop alive for ever.
   */
  function close() {
    try {
      state.codex?.close();
    } catch {
      // already gone
    }
    try {
      state.dsh?.close();
    } catch {
      // already gone
    }
    state.codex = null;
    state.dsh = null;
  }

  /**
   * What the local page may show. Every number here was really measured, and a
   * field that was not measured is `null` so the page prints no number at all
   * instead of a zero it made up.
   */
  return {
    dispatch,
    close,
    describe: () => ({
      codex: {
        available: state.codex !== null,
        tools: metrics.codex.tools,
        threads: metrics.codex.threads,
        reason: state.codex === null ? 'no Codex app-tools pipe answered yet' : null,
      },
      dsh: {
        available: state.dsh !== null,
        port: metrics.dsh.port,
        pid: metrics.dsh.pid,
        sessions: metrics.dsh.sessions,
        reason: state.dsh === null ? 'no DSH backend answered on loopback yet' : null,
      },
      workbuddy: { available: false, reason: WORKBUDDY_UNAVAILABLE_REASON },
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
        workbuddy: { available: false, reason: WORKBUDDY_UNAVAILABLE_REASON },
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
    return { ui, get bridge() { return bridge; }, clientName };
  }
  if (token === null) {
    log('no bridge token configured: the local UI is up, the relay link stays down');
    log('set bridgeToken in the config file, or AI_REMOTE_BRIDGE_TOKEN, or pass --token-file <path>');
    return { ui, get bridge() { return bridge; }, clientName };
  }

  await startBridge(token);
  return { ui, get bridge() { return bridge; }, clientName };
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

  const running = await run(config, args, log);
  const shutdown = async () => {
    log('stopping');
    await running.bridge?.stop();
    await running.ui.stop();
    process.exit(0);
  };
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
