'use strict';
/**
 * Test entry point for `node --test desktop/test`.
 *
 * Node's test runner resolves a bare directory argument as a module, so this
 * file is what `D:\env\node.exe --test desktop/test` actually loads: it pulls in
 * every sibling `*.test.js`, and `node:test` then runs every top-level test they
 * register, in this one process, in a deterministic order.
 *
 * Adding a test file needs no edit here: the scan below picks it up.
 */

const fs = require('node:fs');
const path = require('node:path');

const files = fs
  .readdirSync(__dirname)
  .filter((name) => name.endsWith('.test.js'))
  .sort();

if (files.length === 0) {
  throw new Error('no *.test.js files found next to test/index.js');
}

for (const name of files) {
  require(path.join(__dirname, name));
}
