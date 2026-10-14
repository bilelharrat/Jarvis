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
//
// The same card first, always (round 2, U1): two runs' cards each have a Stop, and after Stop
// on the first the old "the nth Stop in the pane" found the second card's, so the next Space
// stopped a run the owner never pointed at. A control found by its words is looked for only
// inside its own card while that card is still drawn; across the pane only when it's the one
// control of that name there. And the control in a gone one's place is never one that spends
// (U9): a button marked data-spends (Resume, Land, Start again) is passed over for a harmless
// one in the same card (Show session, Findings), else the card itself takes the focus, so a
// Space after Stop doesn't start the run again.
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
      place.scope = {
        name, tag: n.tagName, nth: alike(container, n.tagName, name, partName).indexOf(n),
        at: Math.max(0, controls(n).filter(usable).indexOf(active)),
        same: Math.max(0, alike(n, FOCUSABLE, sign).indexOf(active)),  // the nth alike in its own card
      };
      break;
    }
    return place;
  }

  // A control that spends or starts something again (Resume, Land): never the stand-in for a
  // gone one.
  const spends = (node) => !!(node.dataset && 'spends' in node.dataset);

  // The control at that place in the new drawing (or null): the same one in the same card,
  // else a harmless one in its place there, else the card; with no card around it (or the card
  // gone), the same one across the pane when it's the only one so named, else the one in its
  // place among the pane's.
  function findPlace(container, place) {
    if (!container || !place) return null;
    const part = place.scope ? alike(container, place.scope.tag, place.scope.name, partName)[place.scope.nth] : null;
    if (part) {
      const same = alike(part, FOCUSABLE, place.sign)[place.scope.same];
      if (same && usable(same)) return same;
      const inside = controls(part).filter(usable);
      const there = inside[Math.min(place.scope.at, inside.length - 1)];
      if (there && !spends(there)) return there;
      const harmless = inside.filter((n) => !spends(n));
      if (harmless.length) return harmless[Math.min(place.scope.at, harmless.length - 1)];
      if (!part.hasAttribute('tabindex')) part.setAttribute('tabindex', '-1');
      return part;
    }
    const same = alike(container, FOCUSABLE, place.sign);
    const again = place.scope ? (same.length === 1 ? same[0] : null) : same[place.nth];
    if (again && usable(again)) return again;
    const all = controls(container).filter((n) => usable(n) && !spends(n));
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
