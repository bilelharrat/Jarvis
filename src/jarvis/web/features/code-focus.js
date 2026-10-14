// The keyboard's place through a redraw, for Eden Code's panes (Daredevil depends on it).
//
// A pane drawn anew (replaceChildren) takes the focused element off the page with the rest,
// and the focus falls to the page: after Stop, Resume, Merge, Add a third or a switch, the
// keys and a screen reader start again from the top. keep(container, draw) draws and puts
// the focus back on the same control in the new drawing: the one with the same data-focus,
// id, or name and words (the nth such, when there are several); when it's gone (Stop, once
// stopped), the control in its place in the same card (the nearest named part around it:
// an id, a data-focus or an aria-label), else among the pane's own. The to-do lane does the
// same by data-focus (code-todo.js). Nothing is sent and no model is called; no window events.
// helpers is exported for node --test (tests/web/code-focus.test.mjs).
(function (root) {
  'use strict';

  const FOCUSABLE = 'button, input, select, textarea, a, [tabindex]';

  // What a control is called, to find it again: its data-focus, its id, else its tag, its
  // name and its words.
  function signature(node) {
    if (!node || node.nodeType !== 1) return '';
    const data = node.dataset && node.dataset.focus;
    if (data) return `focus:${data}`;
    if (node.id) return `#${node.id}`;
    const named = node.getAttribute('aria-label') || '';
    const words = String(node.textContent || '').trim().slice(0, 80);
    return `${node.tagName}|${named}|${words}`;
  }

  const usable = (node) => !node.disabled && !node.hidden && node.tabIndex >= 0 && !(node.closest && node.closest('[hidden]'));

  // A named part around a control (a card): its data-focus, id or name, not its words (they
  // change with what it shows: Running, Stopped).
  function partName(node) {
    if (!node || node.nodeType !== 1) return '';
    if (node.dataset && node.dataset.focus) return `focus:${node.dataset.focus}`;
    if (node.id) return `#${node.id}`;
    const label = node.getAttribute('aria-label');
    return label ? `${node.tagName}|${label}` : '';
  }
  const controls = (box) => [...box.querySelectorAll(FOCUSABLE)];
  // The container's elements (sel) with this name, by naming (signature or partName).
  const alike = (container, sel, sign, naming = signature) => [...container.querySelectorAll(sel)].filter((n) => naming(n) === sign);

  // Where the focus is in the container: its signature and which of those it is (nth), the
  // named part around it and where in it, and where among all the container's controls; or
  // null when the focus is elsewhere.
  function placeOf(container, active) {
    if (!container || !active || active === container || !container.contains(active)) return null;
    const sign = signature(active);
    const place = { sign, nth: Math.max(0, alike(container, FOCUSABLE, sign).indexOf(active)), at: Math.max(0, controls(container).filter(usable).indexOf(active)) };
    for (let n = active.parentNode; n && n !== container; n = n.parentNode) {
      const name = partName(n);
      if (!name) continue;
      place.scope = { name, tag: n.tagName, nth: alike(container, n.tagName, name, partName).indexOf(n), at: Math.max(0, controls(n).filter(usable).indexOf(active)) };
      break;
    }
    return place;
  }

  // The control at that place in the new drawing (or null).
  function findPlace(container, place) {
    if (!container || !place) return null;
    const same = alike(container, FOCUSABLE, place.sign);
    if (same[place.nth] && usable(same[place.nth])) return same[place.nth];
    if (place.scope) {
      const part = alike(container, place.scope.tag, place.scope.name, partName)[place.scope.nth];
      const inside = part ? controls(part).filter(usable) : [];
      if (inside.length) return inside[Math.min(place.scope.at, inside.length - 1)];
    }
    const all = controls(container).filter(usable);
    return all.length ? all[Math.min(place.at, all.length - 1)] : null;
  }

  // Draws (draw() replaces the container's contents) and keeps the focus's place.
  function keep(container, draw) {
    const doc = (container && container.ownerDocument) || root.document;
    const active = doc ? doc.activeElement : null;
    const place = placeOf(container, active);
    const out = draw();
    if (place && doc) {
      const now = doc.activeElement;
      if (!(now && container.contains(now) && now !== container)) {
        const again = findPlace(container, place);
        if (again && typeof again.focus === 'function') again.focus();
      }
    }
    return out;
  }

  const helpers = { signature, placeOf, findPlace, keep };
  if (typeof module === 'object' && module.exports) { module.exports = helpers; return; }
  root.jarvisFocus = helpers;
})(typeof window !== 'undefined' ? window : globalThis);
