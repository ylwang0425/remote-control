// m10-origin-probe.js — answers the M10 question with evidence:
//   "does a same-origin POST from a browser carry an Origin header?"
//
// protocol-v1 5.3 makes a missing Origin a hard 403, so if the answer were "no"
// the whole mobile link would be dead. This script serves the real mobile/web/
// page over real HTTP and records the exact Origin header of every request, so
// the answer comes from an observed transcript rather than from reasoning.
//
// MOCK LABEL: the backend is the local mock relay. The BROWSER is real, the
// HTTP is real, and mobile/web/ plus mobile/web/js/api.js are the shipping files.
//
// Run:  node mobile/tests/m10-origin-probe.js [port]
// Then: open the printed page URL in a browser, and read the printed evidence URL.
'use strict';

const { createMockServer } = require('./mock-server.js');

const port = Number(process.argv[2] || 18110);

// 'observe' skips the 5.3 check but still records the raw header, so a browser
// served from 127.0.0.1 can drive the whole UI while we watch what it sends.
const server = createMockServer({ originMode: 'observe' });

server.server.listen(port, '127.0.0.1', async () => {
  const base = 'http://127.0.0.1:' + port;
  process.stdout.write('M10_ORIGIN_PROBE_READY\n');
  process.stdout.write('page_url=' + base + '/\n');
  process.stdout.write('deep_link=' + base + '/#pair=K7QP3MZD9XTB2RCV6HNF0JWS\n');
  process.stdout.write('evidence_url=' + base + '/__requests\n');
  process.stdout.write('pid=' + process.pid + '\n');

  // Node's own fetch is the control: it is NOT a browser, so it should send no
  // Origin at all. That contrast is what makes the browser result meaningful.
  try {
    await fetch(base + '/api/rpc', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ method: 'sessions.list', params: {} })
    });
    process.stdout.write('control_request_done=node-fetch (no Origin expected)\n');
  } catch (err) {
    process.stdout.write('control_request_failed=' + err.message + '\n');
  }
});
