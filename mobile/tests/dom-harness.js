// dom-harness.js — a minimal DOM + fake clock + fake backend for driving the
// real mobile/web/js/app.js against the real mobile/web/index.html.
//
// MOCK LABEL: the DOM here is a stand-in for a browser, and the backend is
// canned. Everything about the UI logic under test (app.js, core.js) is REAL;
// only the host environment is simulated. The real-browser run is separate and
// is recorded in mobile/BUILD_REPORT.md.
//
// `innerHTML` is deliberately booby-trapped: assigning it throws. That turns
// "the UI must never inject server text as HTML" (task row item 9) into a test
// that cannot be quietly satisfied.
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const VOID_TAGS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
  'link', 'meta', 'param', 'source', 'track', 'wbr'
]);

class ClassList {
  constructor(element) {
    this._el = element;
  }
  _list() {
    return (this._el.getAttribute('class') || '').split(/\s+/).filter(Boolean);
  }
  _write(list) {
    this._el.setAttribute('class', list.join(' '));
  }
  contains(name) {
    return this._list().indexOf(name) !== -1;
  }
  add(name) {
    const list = this._list();
    if (list.indexOf(name) === -1) list.push(name);
    this._write(list);
  }
  remove(name) {
    this._write(this._list().filter((c) => c !== name));
  }
  toggle(name, force) {
    const on = force === undefined ? !this.contains(name) : !!force;
    if (on) this.add(name); else this.remove(name);
    return on;
  }
  get length() {
    return this._list().length;
  }
}

class Element {
  constructor(tag, ownerDocument) {
    this.tagName = String(tag).toUpperCase();
    this.ownerDocument = ownerDocument;
    this.attributes = new Map();
    this.childNodes = [];
    this.parentNode = null;
    this.style = {};
    this._listeners = new Map();
    this.classList = new ClassList(this);
    // Sizing/scroll stand-ins. Tests set these directly.
    this.scrollTop = 0;
    this.scrollHeight = 0;
    this.clientHeight = 0;
    // Boolean mirrors of the common reflected attributes.
    this.hidden = false;
    this.disabled = false;
    this.value = '';
    this.id = '';
    this.focused = false;
  }

  get children() {
    return this.childNodes.filter((n) => n instanceof Element);
  }

  get tag() {
    return this.tagName.toLowerCase();
  }

  setAttribute(name, value) {
    const key = String(name).toLowerCase();
    this.attributes.set(key, String(value));
    if (key === 'class') { /* classList reads through getAttribute */ }
    if (key === 'hidden') this.hidden = true;
    if (key === 'id') this.id = String(value);
  }

  getAttribute(name) {
    const key = String(name).toLowerCase();
    if (key === 'id' && this.id) return this.id;
    return this.attributes.has(key) ? this.attributes.get(key) : null;
  }

  hasAttribute(name) {
    return this.attributes.has(String(name).toLowerCase());
  }

  removeAttribute(name) {
    this.attributes.delete(String(name).toLowerCase());
  }

  appendChild(node) {
    if (node.parentNode) node.parentNode.removeChild(node);
    node.parentNode = this;
    this.childNodes.push(node);
    return node;
  }

  insertBefore(node, reference) {
    const index = this.childNodes.indexOf(reference);
    node.parentNode = this;
    if (index === -1) this.childNodes.push(node);
    else this.childNodes.splice(index, 0, node);
    return node;
  }

  removeChild(node) {
    const index = this.childNodes.indexOf(node);
    if (index !== -1) this.childNodes.splice(index, 1);
    node.parentNode = null;
    return node;
  }

  replaceChildren(...nodes) {
    this.childNodes.forEach((n) => { n.parentNode = null; });
    this.childNodes = [];
    nodes.forEach((n) => this.appendChild(n));
  }

  get textContent() {
    return this.childNodes.map((n) => n.textContent).join('');
  }

  set textContent(value) {
    this.childNodes.forEach((n) => { n.parentNode = null; });
    this.childNodes = [];
    const text = value === null || value === undefined ? '' : String(value);
    if (text !== '') this.appendChild(new TextNode(text, this.ownerDocument));
  }

  addEventListener(type, handler) {
    if (!this._listeners.has(type)) this._listeners.set(type, []);
    this._listeners.get(type).push(handler);
  }

  removeEventListener(type, handler) {
    const list = this._listeners.get(type);
    if (list) this._listeners.set(type, list.filter((h) => h !== handler));
  }

  /** Fire listeners as a DOM event would, with a minimal event object. */
  dispatch(type, detail) {
    const event = Object.assign({
      type,
      target: this,
      preventDefault() {},
      stopPropagation() {}
    }, detail || {});
    (this._listeners.get(type) || []).forEach((handler) => handler.call(this, event));
    return event;
  }

  focus() {
    this.focused = true;
    this.ownerDocument.activeElement = this;
  }

  blur() {
    this.focused = false;
  }

  // Text-selection surface. Real inputs and textareas expose these, and the UI
  // relies on them to put the caret back after a poll repaints a form: without
  // them here, "the caret survived the poll" could not be tested at all.
  //
  // Defaults are 0 rather than null, like a fresh real input whose caret sits
  // at the start.
  get selectionStart() {
    return this._selectionStart === undefined ? 0 : this._selectionStart;
  }
  set selectionStart(value) {
    this._selectionStart = value;
  }
  get selectionEnd() {
    return this._selectionEnd === undefined ? 0 : this._selectionEnd;
  }
  set selectionEnd(value) {
    this._selectionEnd = value;
  }
  get selectionDirection() {
    return this._selectionDirection === undefined ? 'none' : this._selectionDirection;
  }
  set selectionDirection(value) {
    this._selectionDirection = value;
  }
  /** Mirrors the real DOM: setting the range also moves the stored bounds. */
  setSelectionRange(start, end, direction) {
    this._selectionStart = start;
    this._selectionEnd = end;
    if (direction !== undefined) {
      this._selectionDirection = direction;
    }
  }
  select() {
    this.setSelectionRange(0, String(this.value === undefined ? '' : this.value).length);
  }

  /** Standard DOM surface -- real elements have both of these. */
  querySelectorAll(selector) {
    const doc = this.ownerDocument;
    const out = [];
    // Descendants only, as in the real DOM: an element does not match itself.
    this.children.forEach((child) => {
      queryAll(child, (el) => el.tagName && doc._matches(el, selector), out);
    });
    return out;
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] || null;
  }

  // NOTE: `find` / `findAll` / `tag` are deliberately NOT defined here.
  //
  // An earlier revision of this harness provided them, and shipped code called
  // `element.find(...)` -- which the real DOM does not have, so every activity
  // block threw in a real browser while the whole suite stayed green. A harness
  // that invents APIs turns passing tests into false confidence, so the only
  // element APIs available now are the standard ones (querySelector,
  // querySelectorAll, children, textContent, ...). Tests that need a predicate
  // search use the free `queryAll(root, predicate)` helper exported below.
}

/** Depth-first predicate search. Free function on purpose: real elements have
 *  no such method, so tests must not pretend they do. */
function queryAll(root, predicate, out) {
  const acc = out || [];
  if (predicate(root)) acc.push(root);
  root.children.forEach((child) => queryAll(child, predicate, acc));
  return acc;
}

class TextNode {
  constructor(text, ownerDocument) {
    this.nodeValue = String(text);
    this.ownerDocument = ownerDocument;
    this.parentNode = null;
  }
  get textContent() {
    return this.nodeValue;
  }
  set textContent(value) {
    this.nodeValue = String(value);
  }
}

/** Booby-trap the HTML-injection APIs on every element. */
function sealInjection(element) {
  ['innerHTML', 'outerHTML'].forEach((prop) => {
    Object.defineProperty(element, prop, {
      configurable: true,
      get() {
        throw new Error(
          'the mobile UI must never read ' + prop + ' (test rail: no HTML injection)'
        );
      },
      set() {
        throw new Error(
          'the mobile UI must never write ' + prop + ' (task row item 9: use textContent)'
        );
      }
    });
  });
  element.insertAdjacentHTML = function () {
    throw new Error('the mobile UI must never call insertAdjacentHTML');
  };
  return element;
}

class Document {
  constructor() {
    this.documentElement = new Element('html', this);
    this.body = new Element('body', this);
    this.documentElement.appendChild(this.body);
    this.hidden = false;
    this.visibilityState = 'visible';
    this.readyState = 'complete';
    this.activeElement = null;
    this._listeners = new Map();
    this.sealed = sealInjection;
  }

  createElement(tag) {
    return sealInjection(new Element(tag, this));
  }

  createTextNode(text) {
    return new TextNode(text, this);
  }

  getElementById(id) {
    return queryAll(this.body, (el) => el.getAttribute && el.getAttribute('id') === id)[0] || null;
  }

  _matches(el, selector) {
    const sel = selector.trim();
    if (sel.startsWith('#')) return el.getAttribute('id') === sel.slice(1);
    if (sel.startsWith('.')) return el.classList.contains(sel.slice(1));
    if (sel.startsWith('[') && sel.endsWith(']')) {
      const body = sel.slice(1, -1);
      const eq = body.indexOf('=');
      if (eq === -1) return el.hasAttribute(body);
      const name = body.slice(0, eq);
      const want = body.slice(eq + 1).replace(/^["']|["']$/g, '');
      return el.getAttribute(name) === want;
    }
    return el.tagName.toLowerCase() === sel.toLowerCase();
  }

  querySelector(selector) {
    return queryAll(this.documentElement, (el) => el.tagName && this._matches(el, selector))[0] || null;
  }

  querySelectorAll(selector) {
    return queryAll(this.documentElement, (el) => el.tagName && this._matches(el, selector))
      .filter((el) => el.tagName !== 'HTML');
  }

  addEventListener(type, handler) {
    if (!this._listeners.has(type)) this._listeners.set(type, []);
    this._listeners.get(type).push(handler);
  }

  dispatch(type, detail) {
    const event = Object.assign({ type, preventDefault() {}, stopPropagation() {} }, detail || {});
    (this._listeners.get(type) || []).forEach((h) => h.call(this, event));
    return event;
  }
}

const TAG_RE = /<!--[\s\S]*?-->|<\/?([A-Za-z][A-Za-z0-9-]*)((?:\s+[^\s=/>]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?)*)\s*(\/?)>|([^<]+)/g;
const ATTR_RE = /([^\s=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;

/** Parse a well-formed subset of HTML into `doc`. Good enough for our own markup. */
function parseInto(html, doc, target) {
  const stack = [target];
  let match;
  TAG_RE.lastIndex = 0;
  while ((match = TAG_RE.exec(html)) !== null) {
    const [whole, tagName, attrText, selfClosing, text] = match;
    if (whole.startsWith('<!--')) continue;
    if (text !== undefined) {
      const trimmed = text.trim();
      if (trimmed !== '') stack[stack.length - 1].appendChild(new TextNode(trimmed, doc));
      continue;
    }
    const name = tagName.toLowerCase();
    if (whole.startsWith('</')) {
      for (let i = stack.length - 1; i > 0; i--) {
        if (stack[i].tagName.toLowerCase() === name) {
          stack.length = i;
          break;
        }
      }
      continue;
    }
    const element = doc.createElement(name);
    let attrMatch;
    ATTR_RE.lastIndex = 0;
    while ((attrMatch = ATTR_RE.exec(attrText || '')) !== null) {
      const key = attrMatch[1];
      if (!key) continue;
      const value = attrMatch[2] !== undefined ? attrMatch[2]
        : attrMatch[3] !== undefined ? attrMatch[3]
          : attrMatch[4] !== undefined ? attrMatch[4] : '';
      element.setAttribute(key, value);
    }
    stack[stack.length - 1].appendChild(element);
    if (!selfClosing && !VOID_TAGS.has(name)) stack.push(element);
  }
  return target;
}

const WEB_DIR = path.join(__dirname, '..', 'web');

/** Parse the REAL mobile/web/index.html into a Document. */
function loadIndexHtml() {
  const html = fs.readFileSync(path.join(WEB_DIR, 'index.html'), 'utf8');
  const doc = new Document();
  const bodyMatch = /<body[^>]*>([\s\S]*?)<\/body>/i.exec(html);
  const body = bodyMatch ? bodyMatch[1] : html;
  parseInto(body.replace(/<script[\s\S]*?<\/script>/gi, ''), doc, doc.body);
  doc.markup = html;
  return doc;
}

/** A window-ish host object with fake timers and a controllable online state. */
function makeHost(doc, options) {
  const opts = options || {};
  const timers = [];
  let clock = opts.startMs === undefined ? 1700000000000 : opts.startMs;
  const host = {
    document: doc,
    navigator: { onLine: opts.online === undefined ? true : opts.online },
    location: { hash: opts.hash || '' },
    history: {
      replaceState(state, title, url) {
        const hashIndex = String(url).indexOf('#');
        host.location.hash = hashIndex === -1 ? '' : String(url).slice(hashIndex);
      }
    },
    _listeners: new Map(),
    addEventListener(type, handler) {
      if (!host._listeners.has(type)) host._listeners.set(type, []);
      host._listeners.get(type).push(handler);
    },
    dispatch(type, detail) {
      (host._listeners.get(type) || []).forEach((h) => h({ type }));
    },
    now() {
      return clock;
    },
    advance(ms) {
      clock += ms;
    },
    setTimeout(fn, ms) {
      timers.push({ fn, at: clock + (ms || 0), id: timers.length + 1 });
      return timers.length;
    },
    clearTimeout(id) {
      const timer = timers.find((t) => t.id === id);
      if (timer) timer.cancelled = true;
    },
    /** Run every timer whose deadline has passed. */
    runDueTimers() {
      let ran = 0;
      timers.slice().forEach((timer) => {
        if (!timer.cancelled && timer.at <= clock) {
          timer.cancelled = true;
          ran++;
          timer.fn();
        }
      });
      return ran;
    },
    pendingTimers() {
      return timers.filter((t) => !t.cancelled).length;
    }
  };
  return host;
}

module.exports = {
  Document,
  Element,
  loadIndexHtml,
  makeHost,
  parseInto,
  queryAll
};
