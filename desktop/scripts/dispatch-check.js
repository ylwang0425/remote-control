'use strict';
/**
 * Real, read-only end-to-end check of the dispatcher the relay talks to.
 *
 * It uses the same `createDispatcher` the bridge uses, against the Codex app and
 * the DSH backend that are running on this machine, and prints counts, roles and
 * timestamps only. No message text is printed, and nothing is sent to any
 * session: this is the proof that `sessions.list` really contains both sources
 * and that a `session.read` returns real messages rather than placeholders.
 *
 * Usage:
 *   node scripts/dispatch-check.js            # list + read one session per tool
 *   node scripts/dispatch-check.js --list-only
 */

const { createDispatcher } = require('../src/index');
const { loadConfig } = require('../src/config');

function tally(values) {
  const counts = new Map();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts].map(([key, count]) => `${key}=${count}`).join(' ');
}

async function main() {
  const listOnly = process.argv.includes('--list-only');
  const config = loadConfig({ env: process.env });
  const dispatcher = createDispatcher(config, (message) => console.log(`  [log] ${message}`));
  try {
    await run(dispatcher, listOnly);
  } finally {
    dispatcher.close();
  }
}

async function run(dispatcher, listOnly) {
  const listed = await dispatcher.dispatch({ method: 'sessions.list', params: {} });
  const sessions = listed.sessions;
  const byTool = sessions.reduce((acc, session) => {
    acc[session.tool] = (acc[session.tool] ?? 0) + 1;
    return acc;
  }, {});
  console.log(`sessions.list -> ${sessions.length} sessions (codex=${byTool.codex ?? 0}, dsh=${byTool.dsh ?? 0})`);
  console.log(`  capabilities: ${JSON.stringify(listed.capabilities)}`);
  console.log('  first five (id prefix, tool, status, updatedAt):');
  for (const session of sessions.slice(0, 5)) {
    console.log(`    ${session.id.slice(0, 8)}… ${session.tool} ${session.status} ${session.updatedAt}`);
  }
  const years = tally(sessions.map((session) => session.updatedAt.slice(0, 4)));
  console.log(`  updatedAt years: ${years}`);
  console.log(`  statuses: ${tally(sessions.map((session) => session.status))}`);

  if (listOnly) return;

  for (const tool of ['codex', 'dsh']) {
    const target = sessions.find((session) => session.tool === tool);
    if (target === undefined) {
      console.log(`session.read (${tool}) -> skipped: no session of this tool in the list`);
      continue;
    }
    try {
      const read = await dispatcher.dispatch({ method: 'session.read', params: { tool, sessionId: target.id } });
      console.log(
        `session.read (${tool}) -> ${target.id.slice(0, 8)}… status=${read.status} canStop=${read.canStop} messages=${read.messages.length}` +
          ` roles: ${tally(read.messages.map((message) => message.role)) || 'none'}`,
      );
      // A bracketed summary is legitimate content for a tool item, and tool items
      // are exactly what a long session's log is full of. What must never happen
      // is an invented placeholder standing in for an assistant or user message,
      // so the "must be 0" gate is scoped to those two roles.
      const forged = read.messages.filter(
        (message) => (message.role === 'assistant' || message.role === 'user') && /^\[[a-z]+\/[a-z-]+\]$/.test(message.text.trim()),
      ).length;
      const toolSummaries = read.messages.filter((message) => message.role === 'tool' && /^\[[^\]]+\]$/.test(message.text.trim())).length;
      console.log(`  invented placeholder bodies in chat roles: ${forged} (must be 0)`);
      console.log(`  bracketed tool summaries (legitimate, informational): ${toolSummaries}`);
      console.log(`  message fields: ${read.messages.length > 0 ? Object.keys(read.messages[0]).join(',') : 'n/a'}`);
      console.log(`  id sample: ${read.messages.slice(0, 3).map((message) => message.id).join(', ') || 'none'}`);
    } catch (error) {
      console.log(`session.read (${tool}) -> failed: ${error.code ?? 'error'} ${error.message}`);
    }
  }
}

if (require.main === module) {
  main()
    .then(() => {
      // The Codex named pipe stays open by design; a one-shot check must not hang.
      process.exit(0);
    })
    .catch((error) => {
      console.error(`dispatch check failed: ${error.message}`);
      process.exit(1);
    });
}

module.exports = { main };
