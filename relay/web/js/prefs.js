/*!
 * prefs.js — the small set of choices the phone remembers between visits.
 *
 * Purely local UI state: pinned sessions, the theme, and the last list filters.
 * Nothing here is protocol data, nothing is sent to the desktop, and a storage
 * that is missing or broken (private mode, a cleared profile, a WebView with
 * DOM storage off) degrades to in-memory defaults instead of throwing.
 *
 * The stored value is re-validated on load: a hand-edited or stale blob can
 * only ever produce a theme, a tab, a tool filter, a project filter or a pin
 * map that this UI understands.
 */
(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module && module.exports) {
    module.exports = api;
  }
  if (root) {
    root.RCPrefs = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var KEY = 'rc.workbench.v1';

  var THEMES = { auto: true, light: true, dark: true };
  var TABS = { chats: true, tasks: true, settings: true };

  function own(object, key) {
    return Object.prototype.hasOwnProperty.call(object, key);
  }

  function defaults() {
    return {
      theme: 'auto',
      tab: 'chats',
      tool: 'all',
      projectId: '',
      pins: {}
    };
  }

  function cleanPinMap(value) {
    var out = {};
    if (value && typeof value === 'object') {
      Object.keys(value).forEach(function (key) {
        if (value[key] === true && key !== '') {
          out[key] = true;
        }
      });
    }
    return out;
  }

  /** Coerce anything into a usable snapshot. Never throws, never invents. */
  function normalize(raw) {
    var out = defaults();
    var source = raw && typeof raw === 'object' ? raw : {};
    if (own(THEMES, source.theme)) {
      out.theme = source.theme;
    }
    if (own(TABS, source.tab)) {
      out.tab = source.tab;
    }
    if (typeof source.tool === 'string' && source.tool !== '') {
      out.tool = source.tool;
    }
    if (typeof source.projectId === 'string') {
      out.projectId = source.projectId;
    }
    out.pins = cleanPinMap(source.pins);
    return out;
  }

  /**
   * Read the stored snapshot.
   *
   * `storage` is any Web Storage work-alike (window.localStorage). A hostile or
   * broken one is contained here: an exception from getItem, a non-string
   * payload and unparsable JSON all fall back to the defaults.
   */
  function load(storage) {
    if (!storage || typeof storage.getItem !== 'function') {
      return defaults();
    }
    var text;
    try {
      text = storage.getItem(KEY);
    } catch (err) {
      return defaults();
    }
    if (typeof text !== 'string' || text === '') {
      return defaults();
    }
    var parsed;
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      return defaults();
    }
    return normalize(parsed);
  }

  /** Write the snapshot. Returns false when storage refused (never throws). */
  function save(storage, prefs) {
    if (!storage || typeof storage.setItem !== 'function') {
      return false;
    }
    try {
      storage.setItem(KEY, JSON.stringify(normalize(prefs)));
      return true;
    } catch (err) {
      return false;
    }
  }

  function togglePin(prefs, id) {
    var out = normalize(prefs);
    var key = id === null || id === undefined ? '' : String(id);
    if (key === '') {
      return out;
    }
    if (out.pins[key] === true) {
      delete out.pins[key];
    } else {
      out.pins[key] = true;
    }
    return out;
  }

  function pinnedCount(prefs) {
    return Object.keys(normalize(prefs).pins).length;
  }

  /**
   * Apply the theme to the document.
   *
   * 'auto' removes the override so the stylesheet's prefers-color-scheme media
   * query wins; light/dark pin it. Only the one attribute is touched.
   */
  function applyTheme(doc, theme) {
    if (!doc || !doc.documentElement) {
      return 'auto';
    }
    var value = own(THEMES, theme) ? theme : 'auto';
    if (value === 'auto') {
      doc.documentElement.removeAttribute('data-theme');
    } else {
      doc.documentElement.setAttribute('data-theme', value);
    }
    return value;
  }

  function createPrefs(storage) {
    var current = load(storage);
    return {
      get: function () {
        return current;
      },
      set: function (patch) {
        current = normalize(Object.assign({}, current, patch || {}));
        save(storage, current);
        return current;
      },
      togglePin: function (id) {
        current = togglePin(current, id);
        save(storage, current);
        return current;
      },
      storage: storage
    };
  }

  return {
    KEY: KEY,
    THEMES: THEMES,
    defaults: defaults,
    normalize: normalize,
    load: load,
    save: save,
    togglePin: togglePin,
    pinnedCount: pinnedCount,
    applyTheme: applyTheme,
    createPrefs: createPrefs
  };
});
