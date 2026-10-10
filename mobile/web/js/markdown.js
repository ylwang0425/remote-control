/*!
 * markdown.js — offline Markdown rendering for the chat view.
 *
 * Two layers, both required:
 *   1. `marked` turns the text into HTML, with tables / lists / code fences /
 *      blockquotes / links enabled.
 *   2. `DOMPurify` cleans that HTML.
 *
 * The result is a **DocumentFragment**, never a string, and it is inserted with
 * `replaceChildren()`. This module therefore never assigns `innerHTML` at all,
 * which is why the tree-wide ban on that sink (mobile/tests/source-guards.test.js
 * and the booby-trapped DOM in mobile/tests/dom-harness.js) still holds.
 *
 * Both libraries are vendored under mobile/web/vendor/ -- there is no CDN, and
 * nothing is fetched at runtime. If either fails to load, this module degrades
 * to plain text rather than rendering anything unclean.
 */
(function (root) {
  'use strict';

  var core = root && root.RCCore ? root.RCCore : null;

  // DOMPurify cannot be trusted to know which schemes we want, so we decide and
  // it removes anything we say no to.
  var HOOK_INSTALLED = false;

  function installUrlHook(DOMPurify) {
    if (HOOK_INSTALLED || !DOMPurify || typeof DOMPurify.addHook !== 'function') {
      return;
    }
    HOOK_INSTALLED = true;
    DOMPurify.addHook('afterSanitizeAttributes', function (node) {
      ['href', 'src', 'xlink:href'].forEach(function (attribute) {
        if (!node.hasAttribute || !node.hasAttribute(attribute)) {
          return;
        }
        var value = node.getAttribute(attribute);
        if (!core || !core.isSafeHref(value)) {
          node.removeAttribute(attribute);
          return;
        }
        // A link leaving this page must not be able to reach back through
        // window.opener, and must not leak the referrer.
        if (attribute === 'href' && node.tagName === 'A') {
          node.setAttribute('rel', 'noopener noreferrer');
        }
      });
    });
  }

  function available() {
    return typeof root.marked !== 'undefined' &&
      typeof root.DOMPurify !== 'undefined' &&
      typeof root.marked.parse === 'function';
  }

  var MARKED_OPTIONS = {
    gfm: true,        // tables, strikethrough, autolinks
    breaks: true,     // a single newline is a line break, as chat users expect
    pedantic: false
    // `headerIds` / `mangle` are gone from marked v5+; passing them did nothing.
  };

  // A deliberately small allow-list. Anything not named here is dropped, which
  // covers <script>, <style>, <iframe>, <form>, <input>, <object>, <embed>,
  // <svg> and every `on*` handler (event attributes are never in ALLOWED_ATTR).
  //
  // TWO OPTIONS ARE DELIBERATELY ABSENT, and both are load-bearing:
  //
  //   USE_PROFILES      -- DOMPurify's README (lines ~201-204) states that
  //                        USE_PROFILES *overrides* ALLOWED_TAGS. Setting it
  //                        disabled the whole allow-list below while still
  //                        looking configured. Removed.
  //   SAFE_FOR_TEMPLATES -- deletes `{{ ... }}` sequences, which would silently
  //                        mangle legitimate template code inside code blocks.
  //                        Removed.
  var PURIFY_CONFIG = {
    ALLOWED_TAGS: [
      'p', 'br', 'hr', 'strong', 'em', 'del', 'code', 'pre', 'blockquote',
      'ul', 'ol', 'li', 'a', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
      'table', 'thead', 'tbody', 'tr', 'th', 'td', 'span', 'sup', 'sub'
    ],
    ALLOWED_ATTR: ['href', 'title', 'class'],
    // Belt and braces: name the dangerous ones explicitly as well, so the
    // intent survives anyone editing the allow-list above.
    FORBID_TAGS: [
      'script', 'style', 'iframe', 'frame', 'frameset', 'object', 'embed',
      'form', 'input', 'button', 'textarea', 'select', 'option', 'link',
      'meta', 'base', 'template', 'noscript', 'svg', 'math', 'img', 'video',
      'audio', 'source', 'track', 'canvas', 'foreignObject'
    ],
    FORBID_ATTR: ['style', 'srcset', 'src', 'action', 'formaction', 'method', 'ping', 'target', 'srcdoc'],
    ALLOW_DATA_ATTR: false,
    ALLOW_ARIA_ATTR: false,
    // Return DOM nodes so we never have to touch innerHTML ourselves.
    RETURN_DOM_FRAGMENT: true
  };

  /** Markdown -> sanitized DocumentFragment. Returns null when unavailable. */
  function toFragment(text) {
    if (!available()) {
      return null;
    }
    var DOMPurify = root.DOMPurify;
    installUrlHook(DOMPurify);
    var source = text === null || text === undefined ? '' : String(text);
    var html = root.marked.parse(source, MARKED_OPTIONS);
    return DOMPurify.sanitize(html, PURIFY_CONFIG);
  }

  /**
   * Add a copy control to every code block.
   *
   * The button is built with createElement and its label comes from our own
   * literal, so decorating cannot become an injection path.
   */
  function decorateCodeBlocks(fragment, document) {
    var blocks = fragment.querySelectorAll ? fragment.querySelectorAll('pre') : [];
    Array.prototype.forEach.call(blocks, function (pre) {
      var wrapper = document.createElement('div');
      wrapper.setAttribute('class', 'code-block');
      pre.parentNode.insertBefore(wrapper, pre);
      wrapper.appendChild(pre);

      var button = document.createElement('button');
      button.setAttribute('type', 'button');
      button.setAttribute('class', 'copy-code');
      button.textContent = '复制';
      button.addEventListener('click', function () {
        copyText(pre.textContent || '', document).then(function (ok) {
          button.textContent = ok ? '已复制' : '复制失败';
          root.setTimeout(function () { button.textContent = '复制'; }, 1500);
        });
      });
      wrapper.appendChild(button);
    });
  }

  function copyText(text, document) {
    if (root.navigator && root.navigator.clipboard && root.navigator.clipboard.writeText) {
      return root.navigator.clipboard.writeText(text).then(
        function () { return true; },
        function () { return legacyCopy(text, document); }
      );
    }
    return Promise.resolve(legacyCopy(text, document));
  }

  /** Fallback for a WebView without the async clipboard API. */
  function legacyCopy(text, document) {
    try {
      var area = document.createElement('textarea');
      area.value = text;
      area.setAttribute('class', 'copy-shim');
      document.body.appendChild(area);
      area.select();
      var ok = document.execCommand && document.execCommand('copy');
      document.body.removeChild(area);
      return !!ok;
    } catch (err) {
      return false;
    }
  }

  /**
   * Render Markdown into an element.
   *
   * Falls back to plain text on purpose: showing the raw Markdown source is
   * better than injecting HTML we could not clean.
   */
  function renderInto(element, text) {
    if (!element) {
      return false;
    }
    var value = text === null || text === undefined ? '' : String(text);
    try {
      var fragment = toFragment(value);
      if (!fragment) {
        // No sanitiser available: show the source rather than nothing.
        element.textContent = value;
        return false;
      }
      decorateCodeBlocks(fragment, element.ownerDocument);
      insertNodes(element, fragment);
      return true;
    } catch (err) {
      // Whatever went wrong -- a DOM method this WebView lacks, a parser edge
      // case -- the body must never end up blank. textContent cannot execute
      // anything, so this fallback is always safe.
      element.textContent = value;
      return false;
    }
  }

  /**
   * Insert nodes without innerHTML, and without assuming a young API.
   *
   * `replaceChildren` is standard but recent; in a WebView that lacks it the
   * call throws and the message body would stay BLANK. So it is detected, and
   * the fallback swaps the children by hand instead of giving up.
   */
  function insertNodes(element, fragment) {
    if (typeof element.replaceChildren === 'function') {
      element.replaceChildren(fragment);
      return;
    }
    while (element.firstChild) {
      element.removeChild(element.firstChild);
    }
    element.appendChild(fragment);
  }

  root.RCMarkdown = {
    available: available,
    toFragment: toFragment,
    renderInto: renderInto
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
