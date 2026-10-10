'use strict';
/**
 * Read-only dump of both model catalogs.
 *
 * - DSH: `session/modelCatalog` (the provider groups the backend really offers)
 * - Codex: the real `create_thread` tool schema from the running app's pipe, so
 *   the model/thinking choices come from the app's own metadata instead of a
 *   hard-coded list.
 *
 * It prints ids, labels, provider names and property names only - never a
 * credential and never a chat message. Nothing here creates or changes anything.
 *
 * Usage:
 *   node scripts/models-check.js
 *   node scripts/models-check.js --codex-only
 *   node scripts/models-check.js --dsh-only
 */

const { readBrowserSecret, discoverBackend, DshClient } = require('../src/adapters/dsh');
const { CodexPipeClient, discoverCodexPipes, parseModelCatalog } = require('../src/adapters/codex');

async function dshCatalog() {
  const found = await discoverBackend({});
  if (found === null) {
    console.log('dsh: no backend answered on loopback');
    return;
  }
  const client = new DshClient({ baseUrl: found.baseUrl, secret: found.secret });
  // The catalog method takes no request parameter at all: `args` is empty.
  const catalog = await client.call('session/modelCatalog', {});
  console.log(`dsh: ${found.baseUrl}`);
  console.log(`dsh: top-level keys: ${Object.keys(catalog ?? {}).join(', ') || 'none'}`);
  const defaults = catalog?.default;
  if (defaults !== undefined) {
    console.log(`dsh: default = ${JSON.stringify(defaults)}`);
  }
  const groups = Array.isArray(catalog?.groups) ? catalog.groups : [];
  console.log(`dsh: groups = ${groups.length}`);
  for (const group of groups) {
    const models = Array.isArray(group?.models) ? group.models : [];
    const names = models.map((model) => `${model?.id}${model?.reasoning ? '(reasoning)' : ''}`);
    console.log(`  group ${String(group?.id)} "${String(group?.name ?? '')}": ${models.length} models -> ${names.join(', ')}`);
    const first = models[0];
    if (first !== undefined) {
      console.log(`    first model fields: ${Object.keys(first).join(',')}`);
    }
  }
  console.log(`dsh: failures = ${Array.isArray(catalog?.failures) ? catalog.failures.length : 'n/a'}`);
}

async function codexSchema() {
  const pipes = discoverCodexPipes();
  const preferred = process.env.CODEX_APP_TOOLS_PIPE_PATH;
  const candidates = [];
  for (const candidate of [preferred, ...pipes.map((name) => `\\\\.\\pipe\\${name}`)]) {
    if (typeof candidate === 'string' && candidate.length > 0 && !candidates.includes(candidate)) candidates.push(candidate);
  }
  if (candidates.length === 0) {
    console.log('codex: no app-tools pipe found');
    return;
  }
  // More than one pipe is alive and only one of them answers `tools/list`, so
  // every candidate is tried - the same rule `openCodexAdapter` uses. A client
  // that never speaks is closed before the next one is tried.
  for (const pipePath of candidates) {
    const client = new CodexPipeClient({ pipePath, timeoutMs: 5000 });
    let tools;
    try {
      tools = await client.listTools({ threadStartKind: 'all' }, { timeoutMs: 4000 });
    } catch (error) {
      console.log(`codex: ${pipePath} did not answer tools/list: ${error.message.slice(0, 80)}`);
      client.close();
      continue;
    }
    console.log(`codex: pipe ${pipePath} answered tools/list with ${tools.length} tools`);
    try {
      reportCodexTools(tools);
    } finally {
      client.close();
    }
    return;
  }
  console.log('codex: no pipe answered tools/list');
}

/** Print the send/create schema facts this round depends on. */
function reportCodexTools(tools) {
  for (const name of ['create_thread', 'send_message_to_thread']) {
    const tool = tools.find((entry) => entry.name === name);
    if (tool === undefined) {
      console.log(`codex: ${name} not in this pipe's catalog`);
      continue;
    }
    const properties = tool.inputSchema?.properties ?? {};
    console.log(`codex: ${name} properties: ${Object.keys(properties).join(', ')}`);
    for (const key of ['model', 'thinking', 'target']) {
      const property = properties[key];
      if (property === undefined) continue;
      const values = property.enum ?? property.items?.enum ?? property.anyOf ?? property.oneOf ?? null;
      console.log(`  ${name}.${key}: ${JSON.stringify(values)} (type=${String(property.type ?? 'unknown')})`);
      // The description is where this host writes its real model ids and
      // reasoning efforts. It is tool metadata, never a credential and never a
      // chat message, so printing it is what makes the catalog auditable.
      if (typeof property.description === 'string' && property.description.length > 0) {
        console.log(`  ${name}.${key}.description: ${property.description}`);
      }
      if (key === 'model') {
        const parsed = parseModelCatalog(property.description ?? '');
        console.log(
          `  ${name}.${key} parsed ids: ${parsed.length === 0 ? 'none' : parsed.map((model) => `${model.id}[${model.reasoningEfforts.join('|')}]`).join(', ')}`,
        );
      }
    }
  }
}

/** Look for model lists anywhere the app really reports them. */
function collectModelStrings(value, key, out, depth = 0) {
  if (depth > 6 || value === null || value === undefined) return out;
  if (typeof value === 'string') {
    if (/model/i.test(key)) out.add(`${key}=${value}`);
    return out;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectModelStrings(item, key, out, depth + 1);
    return out;
  }
  if (typeof value === 'object') {
    for (const [childKey, childValue] of Object.entries(value)) {
      if (/model/i.test(childKey)) {
        if (typeof childValue === 'string') out.add(`${childKey}=${childValue}`);
        else if (Array.isArray(childValue)) {
          for (const item of childValue) {
            if (typeof item === 'string') out.add(`${childKey}[]=${item}`);
            else if (item && typeof item === 'object') collectModelStrings(item, childKey, out, depth + 1);
          }
        }
      }
      collectModelStrings(childValue, childKey, out, depth + 1);
    }
  }
  return out;
}

async function codexUsage() {
  const pipes = discoverCodexPipes();
  const pipePath = process.env.CODEX_APP_TOOLS_PIPE_PATH ?? (pipes.length > 0 ? `\\\\.\\pipe\\${pipes[0]}` : null);
  if (pipePath === null) return;
  const client = new CodexPipeClient({ pipePath, timeoutMs: 6000 });
  try {
    const value = await client.callTool({ namespace: 'codex_app', tool: 'get_usage_limits', arguments: {}, threadId: 'probe' });
    const interesting = [...collectModelStrings(value, '', new Set())].slice(0, 12);
    console.log(`codex: get_usage_limits top-level keys: ${Object.keys(value ?? {}).join(', ') || 'none'}`);
    console.log(`codex: model-ish entries: ${interesting.length > 0 ? interesting.join(' | ') : 'none found'}`);
  } catch (error) {
    console.log(`codex: get_usage_limits failed: ${error.message}`);
  } finally {
    client.close();
  }
}

async function main() {
  const argv = process.argv.slice(2);
  if (!argv.includes('--codex-only')) {
    try {
      await dshCatalog();
    } catch (error) {
      console.log(`dsh: catalog read failed: ${error.message}`);
    }
  }
  if (!argv.includes('--dsh-only')) {
    await codexSchema();
    if (argv.includes('--usage')) {
      await codexUsage();
    }
  }
}

if (require.main === module) {
  main()
    .then(() => process.exit(0))
    .catch((error) => {
      console.error(`models check failed: ${error.message}`);
      process.exit(1);
    });
}

module.exports = { main, dshCatalog, codexSchema, reportCodexTools, codexUsage, collectModelStrings, readBrowserSecret };
