'use strict';
/**
 * Read-only probe for the local DSH Desktop backend.
 *
 * It discovers the running backend on loopback, calls `session/list` for real,
 * and optionally `session/page` for one session - and prints counts, field names
 * and id prefixes only. Message text and titles never leave the process, so this
 * tool can be run at any time without spilling a conversation into a log.
 *
 * Usage:
 *   node scripts/dsh-probe.js                       # discover + count sessions
 *   node scripts/dsh-probe.js --read <sessionId>    # also read one session (counts only)
 *   node scripts/dsh-probe.js --port 19387          # force a candidate port
 *
 * The credential (the local DSH browser-session secret) is read inside this
 * process and used only for the loopback requests below. It is never printed.
 */

const { execFile } = require('node:child_process');

const {
  readBrowserSecret,
  parseNetstatListeners,
  parseTasklistNames,
  scanDshPorts,
  discoverBackend,
  DshClient,
  DshAdapter,
  portHintPath,
} = require('../src/adapters/dsh');

function execFileText(file, args, timeoutMs = 4000) {
  return new Promise((resolve) => {
    execFile(file, args, { timeout: timeoutMs, windowsHide: true }, (error, stdout) => resolve(error ? '' : String(stdout ?? '')));
  });
}

async function backendPid(port) {
  const [netstat, tasklist] = await Promise.all([execFileText('netstat', ['-ano']), execFileText('tasklist', ['/FO', 'CSV', '/NH'])]);
  const names = parseTasklistNames(tasklist);
  const listener = parseNetstatListeners(netstat).find((entry) => entry.localPort === port);
  if (listener === undefined) return null;
  return { pid: listener.pid, image: names.get(listener.pid) ?? '' };
}

function describe(value) {
  if (Array.isArray(value)) return `array(${value.length})`;
  if (value === null) return 'null';
  if (typeof value === 'object') return `object{${Object.keys(value).join(',')}}`;
  return typeof value;
}

async function main() {
  const argv = process.argv.slice(2);
  const readArg = argv.includes('--read') ? argv[argv.indexOf('--read') + 1] : null;
  const readFirst = argv.includes('--read-first');
  const portArg = argv.includes('--port') ? Number(argv[argv.indexOf('--port') + 1]) : undefined;

  const scanned = await scanDshPorts();
  console.log(`loopback listeners owned by a DeepSeek Harness process: ${scanned.length} (${scanned.join(', ') || 'none'})`);
  console.log(`port hint file: ${portHintPath()}`);

  const secret = readBrowserSecret();
  console.log(`local browser-session credential: read (${secret.length} bytes, never printed)`);

  const found = await discoverBackend({ secret, configuredPort: portArg });
  if (found === null) {
    console.error('no DSH backend answered session/list on loopback');
    process.exit(2);
  }
  console.log(`backend found: ${found.baseUrl}`);
  const owner = await backendPid(found.port);
  if (owner !== null) {
    console.log(`backend owner: pid ${owner.pid} image "${owner.image}"`);
  }

  const adapter = new DshAdapter({
    client: new DshClient({ baseUrl: found.baseUrl, secret }),
    backend: { port: found.port, baseUrl: found.baseUrl, pid: owner?.pid ?? null },
  });
  console.log(`adapter describe(): ${JSON.stringify(adapter.describe())}`);

  const sessions = await adapter.listSessions();
  console.log(`session/list -> sessions counted: ${sessions.length}`);
  const statuses = new Map();
  for (const session of sessions) statuses.set(session.status, (statuses.get(session.status) ?? 0) + 1);
  console.log(`  statuses: ${[...statuses].map(([status, count]) => `${status}=${count}`).join(' ')}`);
  if (sessions.length > 0) {
    console.log(`  session fields: ${Object.keys(sessions[0]).join(',')}`);
    console.log(`  first session id prefix: ${sessions[0].id.slice(0, 8)}…`);
    console.log(`  sessions with a cwd: ${sessions.filter((session) => session.cwd !== null).length}`);
  }

  const readId = readArg ?? (readFirst && sessions.length > 0 ? sessions[0].id : null);
  if (readId !== null) {
    const session = await adapter.readSession(readId);
    console.log(`session/page -> session ${readId.slice(0, 8)}… read (read-only)`);
    console.log(`  status=${session.status} canStop=${session.canStop} messages=${session.messages.length}`);
    const roles = new Map();
    for (const message of session.messages) roles.set(message.role, (roles.get(message.role) ?? 0) + 1);
    console.log(`  messages by role: ${[...roles].map(([role, count]) => `${role}=${count}`).join(' ') || 'none'}`);
    console.log(`  message fields: ${session.messages.length > 0 ? Object.keys(session.messages[0]).join(',') : 'n/a'}`);
    console.log(`  list value shape: ${describe(found.listValue)}`);
  } else if (readArg !== null || readFirst) {
    console.log('session/page -> skipped: no session to read');
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`dsh probe failed: ${error.message}`);
    process.exit(1);
  });
}

module.exports = { main, backendPid };
