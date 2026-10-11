// source-guards.test.js — static checks over the files this task ships.
//
// These are not behaviour tests: they read the real source text and assert the
// task row's prohibitions hold. They are what keeps a future edit from quietly
// re-introducing an injection sink, a cleartext escape hatch, a TLS bypass or a
// leaked secret.
//
// Everything here reads real files on disk. Nothing is mocked.
//
// One guard is release-only: the keystore-password leakage scan needs the real
// mobile/.private/keystore.pass, which is never published. Where that file is
// absent the guard reports an explicit skip (never a synthetic secret); where it
// is present the full length/read/scan assertions run unchanged.
//
// Run with:  D:\env\node.exe --test mobile/tests/source-guards.test.js
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const MOBILE = path.join(__dirname, '..');
const WEB = path.join(MOBILE, 'web');
const ANDROID = path.join(MOBILE, 'android');

function walk(dir, out) {
  const acc = out || [];
  if (!fs.existsSync(dir)) return acc;
  fs.readdirSync(dir, { withFileTypes: true }).forEach((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, acc);
    else acc.push(full);
  });
  return acc;
}

function read(file) {
  return fs.readFileSync(file, 'utf8');
}

function webFiles() {
  return walk(WEB);
}

// Vendored third-party bundles (marked, DOMPurify) are allowed to build HTML
// internally -- that is what a renderer does. They are therefore excluded from
// the "our code never builds HTML" scan and covered by their own checks below.
const VENDOR = path.join(WEB, 'vendor');

function ourWebFiles() {
  return webFiles().filter((f) => !f.startsWith(VENDOR));
}

function androidSources() {
  return walk(ANDROID).filter((f) => /\.(java|xml)$/i.test(f));
}

const rel = (f) => path.relative(MOBILE, f).replace(/\\/g, '/');

// ---------------------------------------------------------------------------
// mobile/web — injection safety, the seam, and no secrets
// ---------------------------------------------------------------------------

test('our own web code never uses an HTML-injection sink', () => {
  // Our code produces no HTML at all. Server text reaches the DOM only as:
  //   text -> marked.parse -> DOMPurify.sanitize(RETURN_DOM_FRAGMENT)
  //        -> element.replaceChildren(fragment)
  // which never involves innerHTML on our side. The vendored renderer is the
  // only HTML producer, and its output is turned into nodes before it is used.
  const offenders = [];
  ourWebFiles()
    .filter((f) => /\.(js|html|css)$/i.test(f))
    .forEach((file) => {
      read(file).split('\n').forEach((line, index) => {
        if (/\.(innerHTML|outerHTML)\s*=/.test(line) ||
            /insertAdjacentHTML\s*\(/.test(line) ||
            /document\.write\s*\(/.test(line)) {
          offenders.push(rel(file) + ':' + (index + 1) + ' ' + line.trim());
        }
      });
    });
  assert.deepEqual(offenders, [], 'server text must never be assembled as HTML by our code');
});

test('the markdown path always sanitises and inserts NODES, never a string', () => {
  const file = path.join(WEB, 'js', 'markdown.js');
  assert.ok(fs.existsSync(file), 'markdown.js must exist');
  const text = read(file);
  assert.match(text, /DOMPurify\s*\.\s*sanitize\s*\(/, 'output must go through DOMPurify.sanitize');
  assert.match(text, /RETURN_DOM_FRAGMENT:\s*true/, 'sanitiser must return nodes, not a string');
  assert.match(text, /replaceChildren\s*\(/, 'sanitised nodes must be inserted as nodes');
  assert.ok(!/\.innerHTML\s*=/.test(text), 'markdown.js itself must not assign innerHTML');
  assert.match(text, /addHook\s*\(\s*['"]afterSanitizeAttributes['"]/,
    'link targets must be re-checked after sanitising');

  // The two options that quietly defeat the configuration must stay absent as
  // CONFIG KEYS (the words may of course appear in an explanatory comment):
  // USE_PROFILES overrides ALLOWED_TAGS (DOMPurify README ~L201-204), and
  // SAFE_FOR_TEMPLATES deletes {{ }} from legitimate code blocks.
  assert.ok(!/USE_PROFILES\s*:/.test(text), 'USE_PROFILES overrides ALLOWED_TAGS and must not be set');
  assert.ok(!/SAFE_FOR_TEMPLATES\s*:/.test(text), 'SAFE_FOR_TEMPLATES mangles code and must not be set');
  // and the explicit allow-list plus the belt-and-braces forbid list must exist
  assert.match(text, /ALLOWED_TAGS\s*:/, 'an explicit allow-list must be present');
  assert.match(text, /FORBID_TAGS\s*:/, 'dangerous tags must also be named explicitly');
  ['script', 'iframe', 'form', 'input', 'style'].forEach((tag) => {
    assert.ok(new RegExp("['\"]" + tag + "['\"]").test(text), tag + ' must be named in the forbid list');
  });
});

test('the vendored libraries are the current releases and are byte-pinned', () => {
  const vendorFiles = walk(VENDOR);
  assert.ok(vendorFiles.length >= 2, 'marked and DOMPurify must be vendored locally');
  const names = vendorFiles.map((f) => path.basename(f));
  assert.ok(names.includes('marked.min.js'), 'marked must be vendored');
  assert.ok(names.includes('purify.min.js'), 'DOMPurify must be vendored');

  const purify = read(path.join(VENDOR, 'purify.min.js'));
  const marked = read(path.join(VENDOR, 'marked.min.js'));
  // Versions that shipped with known later XSS fixes must not come back.
  assert.match(purify, /DOMPurify 3\.4\.16/, 'DOMPurify must be the current 3.4.16 build');
  assert.ok(!/DOMPurify 3\.1\./.test(purify), 'the outdated 3.1.x build must not return');
  assert.match(marked, /marked v18\./, 'marked must be the current v18 build');
});

test('the web UI uses same-origin APIs and only the approved official WorkBuddy guide link', () => {
  const officialWorkBuddyGuide = 'https://www.codebuddy.cn/docs/workbuddyapp/features/Multidevice';
  ourWebFiles()
    .filter((f) => /\.(js|html|css)$/i.test(f))
    .forEach((file) => {
      const text = read(file);
      assert.ok(!/\.\.\/relay|relay\//.test(text), rel(file) + ' must not reference the relay tree');
      // A bare 'http://' string is a scheme comparison (the link allow-list in
      // core.js); 'http://host' is a hard-coded cleartext URL and is banned.
      assert.ok(!/http:\/\/(?!["']|$)/i.test(text), rel(file) + ' must never hard-code a cleartext http:// URL');
      // The only absolute URLs allowed are the documented service origin and
      // the user-requested official WorkBuddy mobile multi-device guide.
      const absolute = text.match(/https?:\/\/[^\s"'<>)]+/gi) || [];
      absolute.forEach((url) => {
        assert.ok(
          url.startsWith('https://101.43.98.18') || url === officialWorkBuddyGuide,
          rel(file) + ' references an unexpected absolute URL: ' + url
        );
      });
    });
});

test('the web UI loads nothing from a remote host at run time', () => {
  // The vendored bundles are the reason this can hold: no CDN, ever.
  const html = read(path.join(WEB, 'index.html'));
  ['marked.min.js', 'purify.min.js'].forEach((name) => {
    assert.ok(html.includes('vendor/' + name), name + ' must be loaded from the local vendor directory');
  });
  (html.match(/<(script|link)[^>]*(src|href)\s*=\s*"([^"]*)"/gi) || []).forEach((tag) => {
    const url = /"([^"]*)"/.exec(tag);
    if (url) {
      assert.ok(!/^(https?:)?\/\//i.test(url[1]), 'remote asset is forbidden: ' + url[1]);
    }
  });
});

test('the web UI carries no token, password, cookie value or pairing code literal', () => {
  ourWebFiles().forEach((file) => {
    const text = read(file);
    // A literal rc_session value (43 base64url chars) must never be baked in.
    assert.ok(!/rc_session\s*[:=]\s*["'][A-Za-z0-9_-]{20,}/.test(text), rel(file) + ' has a hard-coded cookie value');
    assert.ok(!/bridgeToken\s*[:=]\s*["'][A-Za-z0-9_-]{20,}/.test(text), rel(file) + ' has a hard-coded bridge token');
    assert.ok(!/(password|passwd|keystorePass)\s*[:=]\s*["'][^"']+["']/i.test(text), rel(file) + ' has a hard-coded password');
    // No CDN: every script/link must be a relative path.
    (text.match(/<(script|link)[^>]*(src|href)\s*=\s*"([^"]*)"/gi) || []).forEach((tag) => {
      const url = /"([^"]*)"\s*$/.exec(tag.replace(/\/?>$/, '')) || /"([^"]*)"/.exec(tag);
      if (url) {
        assert.ok(
          !/^(https?:)?\/\//i.test(url[1]),
          rel(file) + ' loads a remote asset (no CDN allowed): ' + url[1]
        );
      }
    });
  });
});

test('creating a session goes through the real session.create RPC', () => {
  // The old rule was "the phone may not create sessions". The user overrode it
  // (CRD 0006), so what is checked now is the opposite and stricter: a creation
  // must be a real RPC with a client-generated idempotency key, never something
  // the UI fakes locally.
  const app = read(path.join(WEB, 'js', 'app.js'));
  assert.match(app, /core\.sessionCreateBody\s*\(/, 'the panel must build a real session.create body');
  assert.match(app, /newRequestId\s*\(/, 'each creation attempt needs a requestId');
  assert.match(app, /core\.modelsListBody\s*\(/, 'models must come from a live models.list call');

  const core = read(path.join(WEB, 'js', 'core.js'));
  assert.match(core, /method:\s*'session\.create'/, 'session.create must be a real RPC method');
  // No blind re-creation: the timeout path must consult the session list.
  assert.match(app, /resolveUnknownCreate/, 'an unknown create result must be reconciled, not repeated');
  assert.ok(!/requestId\s*=\s*core\.newRequestId\(\)[\s\S]{0,200}?retry/i.test(app),
    'a retry must reuse the requestId rather than mint a new one');

  // And the phone must not invent models.
  ['gpt-', 'claude-', 'qwen', 'llama'].forEach((needle) => {
    assert.ok(!new RegExp(needle, 'i').test(app) && !new RegExp(needle, 'i').test(core),
      'no hard-coded model name is allowed in the UI: ' + needle);
  });
});

// ---------------------------------------------------------------------------
// M8: the signing secret must not exist outside mobile/.private/
// ---------------------------------------------------------------------------

// The signing secret lives only in the local, never-published mobile/.private/
// directory (see .gitignore: `**/.private/`). This check is therefore the one
// release-only guard in this file: it can only run where the release keystore
// password is actually present. In a published source-only checkout there is no
// password to scan FOR, so the guard is reported as an explicit skip instead of
// failing -- without inventing a stand-in secret and without relaxing anything
// for the checkouts that do hold the real one.
const RELEASE_ONLY_SKIP =
  'release-only check: mobile/.private/keystore.pass is absent (local signing ' +
  'secrets are never published), so there is no password to scan for; this guard ' +
  'runs in full on a release checkout that holds the keystore password';

test('the keystore password never appears in the web UI, dist/ or the report', (t) => {
  const passFile = path.join(MOBILE, '.private', 'keystore.pass');
  if (!fs.existsSync(passFile)) {
    t.skip(RELEASE_ONLY_SKIP);
    return;
  }

  // From here on the password file IS present, so every assertion below is
  // required to hold exactly as before: the scan must be real, not vacuous.
  // First line of the password file; apksigner uses the second line for the key.
  const password = fs.readFileSync(passFile, 'utf8').split(/\r?\n/)[0].trim();
  assert.ok(password.length >= 20,
    'the password could not be read (length ' + password.length + '); ' +
    'a short value would make the scan below vacuously true');

  const needle = Buffer.from(password, 'utf8');
  const offenders = [];

  const scan = (file) => {
    const bytes = fs.readFileSync(file);
    if (bytes.indexOf(needle) !== -1) offenders.push(rel(file));
  };

  // Everything a user or an attacker can reach: the served page, the shipped
  // artifact, and the report.
  webFiles().forEach(scan);
  walk(path.join(MOBILE, 'dist')).forEach(scan);
  const report = path.join(MOBILE, 'BUILD_REPORT.md');
  if (fs.existsSync(report)) scan(report);

  assert.deepEqual(offenders, [], 'the keystore password leaked into: ' + offenders.join(', '));
});

test('no keystore or password file is shipped inside dist/', () => {
  const distFiles = walk(path.join(MOBILE, 'dist'));
  const leaked = distFiles
    .map(rel)
    .filter((name) => /keystore|\.pass$|\.jks$|\.p12$/i.test(name));
  assert.deepEqual(leaked, [], 'signing material must never reach dist/');
});

// ---------------------------------------------------------------------------
// mobile/android — TLS, bridge, storage and permission guards
// ---------------------------------------------------------------------------

test('the Android shell never ignores a TLS error', () => {
  const sources = androidSources();
  assert.ok(sources.length > 0, 'the Android project must exist');
  sources.forEach((file) => {
    const text = read(file);
    assert.ok(!/onReceivedSslError/.test(text), rel(file) + ' overrides onReceivedSslError; the app must not handle it');
    assert.ok(!/proceed\s*\(\s*\)/.test(text), rel(file) + ' calls SslErrorHandler.proceed()');
    assert.ok(!/checkServerTrusted|TrustAllCerts|X509TrustManager/.test(text),
      rel(file) + ' contains a custom trust manager');
    assert.ok(!/ALLOW_ALL_HOSTNAME|HostnameVerifier/.test(text), rel(file) + ' contains a hostname verifier override');
  });
});

test('the Android shell exposes no JavaScript bridge', () => {
  androidSources().forEach((file) => {
    const text = read(file);
    assert.ok(!/addJavascriptInterface/.test(text), rel(file) + ' registers a native JS bridge');
    assert.ok(!/@JavascriptInterface/.test(text), rel(file) + ' declares a JavascriptInterface');
  });
});

test('the Android shell minimises file and content access', () => {
  const java = androidSources().filter((f) => f.endsWith('.java'));
  const text = java.map(read).join('\n');
  assert.match(text, /setAllowFileAccess\s*\(\s*false\s*\)/);
  assert.match(text, /setAllowContentAccess\s*\(\s*false\s*\)/);
  assert.match(text, /setAllowFileAccessFromFileURLs\s*\(\s*false\s*\)/);
  assert.match(text, /setAllowUniversalAccessFromFileURLs\s*\(\s*false\s*\)/);
  assert.match(text, /setDomStorageEnabled\s*\(\s*true\s*\)/);
});

test('the Android shell persists cookies across restarts', () => {
  const text = androidSources().filter((f) => f.endsWith('.java')).map(read).join('\n');
  assert.match(text, /setAcceptCookie\s*\(\s*true\s*\)/,
    'the cookie store must accept cookies');
  assert.match(text, /CookieManager\s*\.\s*getInstance\s*\(\s*\)\s*\.\s*flush\s*\(\s*\)/,
    'the cookie store must be flushed so the login survives a restart');
});

test('the Android shell sends external URLs to the system browser and keeps Back in the WebView', () => {
  const text = androidSources().filter((f) => f.endsWith('.java')).map(read).join('\n');
  assert.match(text, /Intent\.ACTION_VIEW/, 'external links must open in the system browser');
  assert.match(text, /canGoBack\s*\(\s*\)/, 'the back key must prefer WebView history');
  assert.match(text, /goBack\s*\(\s*\)/);
});

test('the Android manifest is closed by default', () => {
  const manifestPath = path.join(ANDROID, 'AndroidManifest.xml');
  assert.ok(fs.existsSync(manifestPath), 'AndroidManifest.xml must exist');
  const manifest = read(manifestPath);
  // Check what the manifest DECLARES, not what its comments say: the comments
  // deliberately name the permissions this app refuses to request.
  const declared = manifest.replace(/<!--[\s\S]*?-->/g, '');

  assert.match(declared, /usesCleartextTraffic\s*=\s*"false"/, 'cleartext must be off');
  assert.match(declared, /android:debuggable\s*=\s*"false"/, 'release build must not be debuggable');
  assert.match(declared, /android:allowBackup\s*=\s*"false"/, 'allowBackup must be explicit');
  assert.match(declared, /windowSoftInputMode\s*=\s*"adjustResize"/, 'the keyboard must not cover the composer');
  assert.match(declared, /minSdkVersion\s*=\s*"26"/);
  assert.match(declared, /targetSdkVersion\s*=\s*"35"/);

  // Only the network permission: no file-content permissions at all.
  const permissions = (declared.match(/<uses-permission[^>]*android:name\s*=\s*"([^"]+)"/g) || [])
    .map((tag) => /"([^"]+)"/.exec(tag)[1]);
  assert.deepEqual(permissions, ['android.permission.INTERNET'],
    'the app must request the network permission and nothing else');

  const forbidden = [
    'READ_EXTERNAL_STORAGE', 'WRITE_EXTERNAL_STORAGE', 'MANAGE_EXTERNAL_STORAGE',
    'READ_MEDIA_IMAGES', 'READ_MEDIA_VIDEO', 'READ_MEDIA_AUDIO',
    'ACCESS_MEDIA_LOCATION', 'READ_CONTACTS', 'CAMERA', 'RECORD_AUDIO'
  ];
  forbidden.forEach((name) => {
    assert.ok(!declared.includes(name), 'manifest must not request ' + name);
  });
});
