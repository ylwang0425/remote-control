/*!
 * ui.js — small DOM builders for the mobile workbench.
 *
 * Standard DOM only: createElement / setAttribute / textContent / appendChild.
 * No HTML strings, no innerHTML, no template literals that build markup — the
 * same rule the rest of mobile/web follows, and the test DOM throws if it is
 * ever broken.
 *
 * Also owns the two pieces of transient UI state that must survive a re-render:
 * a sheet's "armed" element (so the next outside click closes it) and nothing
 * else. Everything user-visible comes from arguments.
 */
(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module && module.exports) {
    module.exports = api;
  }
  if (root) {
    root.RCUi = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function make(doc, tag, className, text) {
    var node = doc.createElement(tag);
    if (className) {
      node.setAttribute('class', className);
    }
    if (text !== undefined && text !== null) {
      node.textContent = String(text);
    }
    return node;
  }

  function button(doc, label, className, onClick) {
    var node = make(doc, 'button', className || 'btn', label);
    node.setAttribute('type', 'button');
    if (typeof onClick === 'function') {
      node.addEventListener('click', onClick);
    }
    return node;
  }

  function clear(node) {
    if (node) {
      node.textContent = '';
    }
    return node;
  }

  /** A text-only span with a class. Used for every piece of desktop text. */
  function span(doc, className, text) {
    return make(doc, 'span', className, text);
  }

  function textLine(doc, tag, className, text) {
    if (text === undefined || text === null || String(text) === '') {
      return null;
    }
    return make(doc, tag, className, text);
  }

  function appendAll(parent, children) {
    (children || []).forEach(function (child) {
      if (child) {
        parent.appendChild(child);
      }
    });
    return parent;
  }

  // --- sheets -------------------------------------------------------------
  //
  // A sheet is the markup for a bottom panel; the OPEN/CLOSED state lives in the
  // `hidden` attribute, so it is not lost by re-rendering its contents. The
  // first click after opening is what arms it: an iOS tap that opened the sheet
  // would otherwise close it again in the same gesture.

  function openSheet(sheet) {
    if (!sheet) return;
    sheet.hidden = false;
    sheet.__rcArmed = false;
  }

  function closeSheet(sheet) {
    if (!sheet) return;
    sheet.hidden = true;
    sheet.__rcArmed = false;
  }

  /** Close `sheet` on a click outside it. Returns true when it actually closed. */
  function sheetOutsideClick(sheet, target) {
    if (!sheet || sheet.hidden) {
      return false;
    }
    if (sheet.__rcArmed !== true) {
      sheet.__rcArmed = true;
      return false;
    }
    var node = target;
    while (node) {
      if (node === sheet) {
        return false;
      }
      node = node.parentNode;
    }
    closeSheet(sheet);
    return true;
  }

  function isInside(root, node) {
    var walk = node;
    while (walk) {
      if (walk === root) {
        return true;
      }
      walk = walk.parentNode;
    }
    return false;
  }

  /** Radio-style chip. `active` is the caller's decision, never guessed here. */
  function chip(doc, label, active, onClick, extraClass) {
    var node = button(doc, label, 'chip' + (extraClass ? ' ' + extraClass : '') + (active ? ' chip-active' : ''), onClick);
    if (active) {
      node.setAttribute('aria-pressed', 'true');
    } else {
      node.setAttribute('aria-pressed', 'false');
    }
    return node;
  }

  /** A labelled row: label on the left, control on the right. */
  function fieldRow(doc, labelText, control, forId) {
    var row = make(doc, 'div', 'field-row');
    var label = make(doc, 'label', 'field-row-label', labelText);
    if (forId) {
      label.setAttribute('for', forId);
    }
    row.appendChild(label);
    if (control) {
      row.appendChild(control);
    }
    return row;
  }

  return {
    make: make,
    button: button,
    chip: chip,
    span: span,
    textLine: textLine,
    clear: clear,
    appendAll: appendAll,
    fieldRow: fieldRow,
    openSheet: openSheet,
    closeSheet: closeSheet,
    sheetOutsideClick: sheetOutsideClick,
    isInside: isInside
  };
});
