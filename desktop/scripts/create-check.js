'use strict';
/**
 * Real, mostly read-only verification of the CRD 0006 / 0007 behaviour.
 *
 * It prints counts, ids, byte sizes and flags - never a chat message body. It
 * makes exactly **one** real DSH session (the coordinator asked for a real
 * creation) and no Codex thread, sends no prompt to it, and proves that the same
 * `requestId` cannot create a second one.
 *
 * Usage:
 *   node scripts/create-check.js              # catalogs + one real DSH create + dedupe + history size
 *   node scripts/create-check.js --no-create  # catalogs and history size only
 */

const crypto = require('node:crypto');

const { createDispatcher } = require('../src/index');
const { loadConfig } = require('../src/config');
const { envelopeBytes } = require('../src/protocol');

function tally(values) {
  const counts = new Map();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts].map(([key, count]) => `${key}=${count}`).join(' ');
}

async function main() {
  const noCreate = process.argv.includes('--no-create');
  const config = loadConfig({ env: process.env });
  const dispatcher = createDispatcher(config, (message) => console.log(`  [log] ${message}`));
  const historyBytes = [];

  try {
    for (const tool of ['codex', 'dsh']) {
      const listed = await dispatcher.dispatch({ method: 'models.list', params: { tool } });
      const providers = tally(listed.models.map((model) => model.provider ?? '(none)'));
      console.log(`models.list ${tool}: models=${listed.models.length} providers: ${providers || '(none)'}`);
      console.log(`  first three ids: ${listed.models.slice(0, 3).map((model) => model.id).join(', ') || 'none'}`);
      const withEfforts = listed.models.filter((model) => Array.isArray(model.reasoningEfforts) && model.reasoningEfforts.length > 0);
      console.log(`  models with reasoningEfforts: ${withEfforts.length}; default-marked: ${listed.models.filter((m) => m.isDefault).length}`);
      console.log(`  projects: ${(listed.projects ?? []).length}`);
    }

    // The history size is what made the phone time out before the byte budget.
    const sessions = await dispatcher.dispatch({ method: 'sessions.list', params: {} });
    for (const tool of ['codex', 'dsh']) {
      const target = sessions.sessions.find((session) => session.tool === tool);
      if (target === undefined) continue;
      const read = await dispatcher.dispatch({ method: 'session.read', params: { tool, sessionId: target.id } });
      const bytes = envelopeBytes({ type: 'response', id: '00000000-0000-4000-8000-000000000000', ok: true, result: read });
      historyBytes.push(`${tool}=${bytes}`);
      console.log(
        `session.read ${tool}: messages=${read.messages.length} envelope=${bytes} bytes ` +
          `historyTruncated=${read.historyTruncated === true} frameOk=${bytes <= 262144}`,
      );
    }

    if (noCreate) return;

    const dshModels = await dispatcher.dispatch({ method: 'models.list', params: { tool: 'dsh' } });
    const chosen = dshModels.models.find((model) => model.isDefault) ?? dshModels.models[0];
    if (chosen === undefined) {
      console.log('session.create: skipped, the DSH catalog is empty');
      return;
    }
    const requestId = crypto.randomUUID();
    const params = {
      tool: 'dsh',
      model: chosen.id,
      provider: chosen.provider,
      reasoningEffort: Array.isArray(chosen.reasoningEfforts) && chosen.reasoningEfforts.includes('high') ? 'high' : undefined,
      requestId,
    };
    console.log(`session.create: model=${chosen.id} provider=${chosen.provider} effort=${params.reasoningEffort ?? '(native default)'} requestId=${requestId.slice(0, 8)}…`);
    const created = await dispatcher.dispatch({ method: 'session.create', params });
    console.log(`  created session: ${String(created.sessionId).slice(0, 8)}… partial=${created.partial === true} model=${created.model} provider=${created.provider}`);

    // The same request id again must not create a second session.
    const again = await dispatcher.dispatch({ method: 'session.create', params });
    console.log(`  same requestId again: session ${String(again.sessionId).slice(0, 8)}… deduplicated=${again.deduplicated === true} sameId=${again.sessionId === created.sessionId}`);

    const listed = await dispatcher.dispatch({ method: 'sessions.list', params: {} });
    const visible = listed.sessions.some((session) => session.id === created.sessionId);
    console.log(`  visible in sessions.list: ${visible} (total ${listed.sessions.length})`);

    const after = await dispatcher.dispatch({ method: 'sessions.list', params: { tool: 'dsh' } });
    const count = after.sessions.filter((session) => session.id === created.sessionId).length;
    console.log(`  the created id appears exactly ${count} time(s) in the DSH list (1 = no duplicate)`);
    console.log(`history envelope bytes: ${historyBytes.join(' ')}`);
  } finally {
    dispatcher.close();
  }
}

if (require.main === module) {
  main()
    .then(() => process.exit(0))
    .catch((error) => {
      console.error(`create check failed: ${error.code ?? ''} ${error.message}`);
      process.exit(1);
    });
}

module.exports = { main };
