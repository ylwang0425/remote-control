# vendor/ — offline Markdown renderer + sanitiser

Both libraries are **bundled locally**. The page loads them with relative paths
(`vendor/marked.min.js`, `vendor/purify.min.js`) and contacts **no CDN at run
time**. `mobile/tests/source-guards.test.js` fails the build if a remote
`src`/`href` ever appears, or if either version regresses.

| File | Package | Version | Bytes | SHA-256 |
| --- | --- | --- | --- | --- |
| `marked.min.js` | [marked](https://github.com/markedjs/marked) | **18.1.0** (MIT) | 47225 | `f424dcb508fdf93e0137a970cfce8f3207ea2e3f37eca5f7556a52875683632a` |
| `purify.min.js` | [DOMPurify](https://github.com/cure53/DOMPurify) | **3.4.16** (MPL-2.0 OR Apache-2.0) | 28885 | `2c90a9b46d6463f26038a29b686e82bc91de01fdac9d5229e7cfe3b360134ea2` |

## Where they came from

Fetched from the npm packument (`registry.npmjs.org/<pkg>/latest`) to pick the
current version, then the artifact was taken from **two independent mirrors** and
the bytes were compared:

- marked: `cdn.jsdelivr.net/npm/marked@18.1.0/lib/marked.umd.js` and `unpkg.com/marked@18.1.0/lib/marked.umd.js`
- DOMPurify: `cdn.jsdelivr.net/npm/dompurify@3.4.16/dist/purify.min.js` and `unpkg.com/dompurify@3.4.16/dist/purify.min.js`

**Both mirrors returned byte-identical files** for both packages, and the
version banner inside each file was checked (`DOMPurify 3.4.16`,
`marked v18.1.0`). `marked.min.js` is the official UMD build; marked v18 does not
ship a `marked.min.js` at the package root, so `lib/marked.umd.js` is vendored
under that name — it is the browser bundle, not a renamed ESM file.

## Why these versions

An earlier revision of this bundle shipped **DOMPurify 3.1.6**, which predates
several later XSS fixes. It was replaced. The outdated build must not come back:
`source-guards.test.js` asserts the 3.4.16 banner is present **and** that no
`DOMPurify 3.1.` banner is.

## How `js/markdown.js` uses them

```
server text
  -> marked.parse(text)                       (Markdown -> HTML string)
  -> DOMPurify.sanitize(html, { RETURN_DOM_FRAGMENT: true, ... })
  -> element.replaceChildren(fragment)        (nodes, never a string)
```

The result is a **DOM fragment**, so our own code never assigns `innerHTML`
anywhere — the tree-wide ban in `source-guards.test.js` still holds, and the
test DOM in `dom-harness.js` still throws if that sink is touched.

Two DOMPurify options are deliberately **absent**, both load-bearing:

- **`USE_PROFILES`** — DOMPurify's README (~L201-204) states it *overrides*
  `ALLOWED_TAGS`. Setting it silently disabled the explicit allow-list while
  still looking configured. Removed.
- **`SAFE_FOR_TEMPLATES`** — deletes `{{ ... }}`, which would mangle legitimate
  template code inside code blocks.

`js/markdown.js` also installs an `afterSanitizeAttributes` hook so every
`href`/`src` is re-checked against `core.isSafeHref` (http/https/mailto/# only),
which is what blocks `javascript:`, `data:`, `file:` and the
`java\tscript:` control-character bypass.

## Acceptance

`mobile/tests/sanitize-probe.html` (served at `/__sanitize` by the test mock
server) runs 17 hostile and benign samples through this exact path in a **real
browser DOM** and reports the outcome. Result: **17/17 pass, `__pwned === 0`**
— no injected script executed. See `mobile/BUILD_REPORT.md`.
