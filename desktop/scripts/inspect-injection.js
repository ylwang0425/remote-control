'use strict';
/**
 * Read-only inspection of how DSH reports the runtime context and skill catalog
 * that it injects into a session.
 *
 * The goal is to find a **native flag** - a field, a part type, a role, a source
 * marker - that says "this was injected by the backend, a person did not type it".
 * The phone must filter on that flag and never on text, because a user who pastes
 * similar text would otherwise lose their own words.
 *
 * It prints structural facts only: event types, roles, content part types, the
 * key names of each event, and booleans. **No message text is printed.**
 *
 * Usage:
 *   node scripts/inspect-injection.js               # the 5 newest sessions
 *   node scripts/inspect-injection.js --sessions 20
 */

const { readBrowserSecret, discoverBackend, DshClient } = require('../src/adapters/dsh');

function keysOf(value, prefix = '') {
  if (value === null || typeof value !== 'object') return [];
  return Object.entries(value).map(([key, child]) => {
    const label = prefix.length > 0 ? `${prefix}.${key}` : key;
    if (child !== null && typeof child === 'object' && !Array.isArray(child)) return `${label}{${Object.keys(child).join(',')}}`;
    return label;
  });
}

function partTypesOf(content) {
  if (!Array.isArray(content)) return [];
  return content.map((part) => (part && typeof part === 'object' && typeof part.type === 'string' ? part.type : typeof part)).join(',');
}

function booleansOf(value, prefix = '') {
  const found = [];
  if (value === null || typeof value !== 'object') return found;
  for (const [key, child] of Object.entries(value)) {
    const label = prefix.length > 0 ? `${prefix}.${key}` : key;
    if (typeof child === 'boolean') found.push(`${label}=${child}`);
    else if (typeof child === 'string' && /^(user|assistant|system|tool|runtime|internal|injected|skill|context|hook|synthetic)$/i.test(child)) {
      found.push(`${label}="${child}"`);
    } else if (child !== null && typeof child === 'object') found.push(...booleansOf(child, label));
  }
  return found;
}

/** A cheap, local fingerprint so two events can be told apart without printing text. */
function textShapeOf(text) {
  if (typeof text !== 'string' || text.length === 0) return 'empty';
  return `len=${text.length} firstWord=${text.trim().split(/\s+/)[0]?.slice(0, 24) ?? ''}`;
}

async function main() {
  const argv = process.argv.slice(2);
  const limit = argv.includes('--sessions') ? Number(argv[argv.indexOf('--sessions') + 1]) : 5;
  const found = await discoverBackend({});
  if (found === null) {
    console.log('no DSH backend answered');
    return;
  }
  const client = new DshClient({ baseUrl: found.baseUrl, secret: found.secret });
  const list = await client.call('session/list', {});
  const items = (Array.isArray(list?.items) ? list.items : []).slice(0, Number.isFinite(limit) ? limit : 5).filter((item) => typeof item?.parentSessionId !== 'string');
  console.log(`sessions inspected: ${items.length} of ${Array.isArray(list?.items) ? list.items.length : 0}`);

  for (const item of items) {
    const sessionId = String(item?.sessionId ?? '');
    if (sessionId.length === 0) continue;
    const projections = await client.call('session/projections', { sessionId });
    const cut = Number.isInteger(projections?.asOfSeq) ? projections.asOfSeq : null;
    if (cut === null) continue;
    const page = await client.call('session/page', {
      address: { kind: 'session', sessionId },
      throughSeq: cut,
      maxMessages: 60,
    });
    const records = Array.isArray(page?.records) ? page.records : [];
    const shapes = new Map();
    for (const record of records) {
      const event = record?.event ?? record;
      const message = event?.data?.message ?? null;
      const partTypes = partTypesOf(message?.content);
      const marker = booleansOf(event).join(' ');
      const shape = [
        `event.type=${String(event?.type)}`,
        `role=${String(message?.role ?? '(none)')}`,
        `parts=${partTypes || '(none)'}`,
        `eventKeys=${keysOf(event).join('|')}`,
        message === null ? '' : `messageKeys=${keysOf(message).join('|')}`,
        // `source` is the native provenance marker: what made this entry.
        event?.data?.source !== undefined ? `data.source=${JSON.stringify(event.data.source)}` : '',
        message?.source !== undefined ? `message.source=${JSON.stringify(message.source)}` : '',
        marker.length > 0 ? `markers=${marker}` : '',
      ]
        .filter((piece) => piece.length > 0)
        .join('  ');
      const current = shapes.get(shape) ?? { count: 0, sample: textShapeOf(eventTextOf(event)) };
      current.count += 1;
      shapes.set(shape, current);
    }
    console.log(`\nsession ${sessionId.slice(0, 8)}… records=${records.length} distinct shapes=${shapes.size}`);
    let index = 0;
    for (const [shape, info] of shapes) {
      index += 1;
      console.log(`  #${index} x${info.count} ${shape}`);
      console.log(`       sampleText: ${info.sample}`);
      if (index >= 12) break;
    }
  }
}

function eventTextOf(event) {
  const message = event?.data?.message ?? event?.data ?? {};
  const content = message?.content;
  if (Array.isArray(content)) {
    return content
      .map((part) => (part && typeof part === 'object' && typeof part.text === 'string' ? part.text : ''))
      .join('');
  }
  return typeof message?.text === 'string' ? message.text : '';
}

if (require.main === module) {
  main()
    .then(() => process.exit(0))
    .catch((error) => {
      console.error(`inspect failed: ${error.message}`);
      process.exit(1);
    });
}

module.exports = { main, keysOf, partTypesOf, booleansOf, textShapeOf };

