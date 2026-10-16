// Eden Code's sidebar, as wide as the owner drags it (like Claude Code's desktop app or VS
// Code): a thin handle on the sidebar's right edge. Drag it and the sidebar, the main column
// and everything placed from them (the composer, the panes, split view's two halves, the
// board) follow at once; a double-click (or Enter) gives back the look's own width.
//
// The width is the --jc-side-w custom property on #cc (app.css, eden-code.css, code-split.css
// and code-logbook.css place the sidebar and the main column from it, through --jc-main-l):
// set inline once the owner has moved it, absent otherwise, so each look keeps its own
// default (260px in Eden's look, 268px in Stark Glass, 256px in Obsidian). It is never under
// 200px, never over 45% of the window, and never so wide the main column gets under 420px;
// a window made smaller narrows it to fit, and the owner's width comes back once there's
// room. It's remembered per window kind (Eden Code's own window, Eden Secretary's) in
// localStorage, a convenience of this Mac's window only (private mode: forgotten, no harm).
// Folding the sidebar away (⌘\, "Hide sidebar") keeps the width for when it comes back.
//
// For the keys and a screen reader (Daredevil depends on it) the handle is a focusable
// separator ("Resize sidebar", its width in pixels as its value): ← and → move it 16px
// (with Shift, 64px), Home and End to the narrowest and widest, Enter to the default.
// Window events: none. Nothing is sent and no model is called. Not in split view's right
// pane, which has no sidebar. helpers are exported for node --test
// (tests/web/code-side.test.mjs).
(function (root) {
  'use strict';

  const MIN = 200;          // the narrowest sidebar
  const MAX_SHARE = 0.45;   // of the window, the widest
  const MAIN_MIN = 420;     // the main column, never narrower than this
  const GUTTERS = 36;       // the sidebar's and the main column's margins (12px each side, about)
  const STEP = 16;
  const BIG_STEP = 64;

  // The widest the sidebar may be in a window this wide (never under MIN: a window too small
  // for both still has a usable sidebar, and below 900px app.css hides it anyway).
  function maxWidth(windowWidth) {
    const w = Number(windowWidth);
    if (!Number.isFinite(w) || w <= 0) return MIN;
    return Math.max(MIN, Math.floor(Math.min(w * MAX_SHARE, w - MAIN_MIN - GUTTERS)));
  }

  // A width made safe for this window: a whole number of pixels from MIN to maxWidth.
  // Nothing usable (nothing kept, NaN, '', a word) is null: the look's default.
  function clampWidth(width, windowWidth) {
    const w = width === null || width === undefined || (typeof width === 'string' && width.trim() === '') ? Number.NaN : Number(width);
    if (!Number.isFinite(w)) return null;
    return Math.round(Math.min(maxWidth(windowWidth), Math.max(MIN, w)));
  }

  // Where a window kind keeps its width: Eden Code's own window (body data-app="eden-code")
  // and Eden Secretary's each their own.
  function storageKey(kind) {
    const name = String(kind || '').replace(/[^\w-]/g, '').slice(0, 32) || 'secretary';
    return `jc.sideWidth.${name}`;
  }

  // The width after a key on the handle (or undefined: not one of its keys). null: back to
  // the default.
  function keyWidth(key, shift, now, windowWidth) {
    const step = shift ? BIG_STEP : STEP;
    switch (key) {
      case 'ArrowLeft': return clampWidth(now - step, windowWidth);
      case 'ArrowRight': return clampWidth(now + step, windowWidth);
      case 'Home': return MIN;
      case 'End': return maxWidth(windowWidth);
      case 'Enter': return null;
      default: return undefined;
    }
  }

  const helpers = { MIN, MAX_SHARE, MAIN_MIN, GUTTERS, STEP, BIG_STEP, maxWidth, clampWidth, storageKey, keyWidth };
  if (typeof module === 'object' && module.exports) { module.exports = helpers; return; }

  const doc = root.document;
  const F = root.jarvisFeatures;
  const cc = doc && doc.getElementById('cc');
  const side = doc && doc.getElementById('jc-side');
  if (!cc || !side || doc.body.classList.contains('jc-split-pane')) return;
  const t = (s) => (F && typeof F.t === 'function' ? F.t(s) : s);

  const key = storageKey(doc.body.dataset.app);
  const winWidth = () => root.innerWidth || 1280;
  // The look's own width: the stylesheet's --jc-side-w with the owner's taken off.
  function defaultWidth() {
    const kept = cc.style.getPropertyValue ? cc.style.getPropertyValue('--jc-side-w') : '';
    if (kept && cc.style.removeProperty) cc.style.removeProperty('--jc-side-w');
    const css = root.getComputedStyle ? parseFloat(root.getComputedStyle(cc).getPropertyValue('--jc-side-w')) : Number.NaN;
    if (kept) cc.style.setProperty('--jc-side-w', kept);
    return Number.isFinite(css) && css > 0 ? Math.round(css) : 260;
  }
  function stored() {
    try { return clampWidth(root.localStorage.getItem(key), 1e6); } catch (_) { return null; }
  }
  function remember(width) {
    try {
      if (width === null) root.localStorage.removeItem(key);
      else root.localStorage.setItem(key, String(width));
    } catch (_) { /* private mode: this window only */ }
  }

  const handle = doc.createElement('div');
  handle.className = 'jc-side-handle';
  handle.id = 'jc-side-handle';
  handle.tabIndex = 0;
  handle.setAttribute('role', 'separator');
  handle.setAttribute('aria-orientation', 'vertical');
  handle.setAttribute('aria-controls', 'jc-side');
  handle.setAttribute('aria-label', t('Resize sidebar'));
  handle.title = t('Resize sidebar');
  side.append(handle);

  let wanted = stored();  // the owner's width (null: the look's), kept while the window is too small for it
  let shown = 0;

  // Puts a width on show (null: the default), clamped to this window, and tells the handle.
  function apply(width) {
    const max = maxWidth(winWidth());
    const fallback = defaultWidth();
    shown = width === null ? Math.min(fallback, max) : clampWidth(width, winWidth());
    if (width === null && shown === fallback) cc.style.removeProperty('--jc-side-w');
    else cc.style.setProperty('--jc-side-w', `${shown}px`);
    handle.setAttribute('aria-valuemin', String(MIN));
    handle.setAttribute('aria-valuemax', String(max));
    handle.setAttribute('aria-valuenow', String(shown));
    handle.setAttribute('aria-valuetext', t(`${shown} px`));
    // Split view's halves and the selection's glider measure what moved.
    if (typeof root.CustomEvent === 'function') cc.dispatchEvent(new root.CustomEvent('jc-side-resize', { detail: { width: shown } }));
    if (typeof root.moveGlider === 'function') root.moveGlider();
  }
  function choose(width) {
    wanted = width;
    apply(width);
    remember(width);
  }

  // The first width with no glide from the default to it.
  cc.classList.add('jc-side-dragging');
  apply(wanted);
  root.requestAnimationFrame(() => root.requestAnimationFrame(() => cc.classList.remove('jc-side-dragging')));

  handle.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    if (handle.setPointerCapture && e.pointerId !== undefined) handle.setPointerCapture(e.pointerId);
    handle.focus();
    cc.classList.add('jc-side-dragging');
    const startX = e.clientX;
    const startW = shown;
    let moved = false;
    const move = (ev) => {
      moved = true;
      wanted = clampWidth(startW + (ev.clientX - startX), winWidth());
      apply(wanted);
    };
    const end = () => {
      cc.classList.remove('jc-side-dragging');
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', end);
      handle.removeEventListener('pointercancel', end);
      if (moved) remember(wanted);
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', end);
    handle.addEventListener('pointercancel', end);
  });
  handle.addEventListener('dblclick', (e) => { e.preventDefault(); choose(null); });
  handle.addEventListener('keydown', (e) => {
    const to = keyWidth(e.key, e.shiftKey, shown, winWidth());
    if (to === undefined || e.metaKey || e.ctrlKey || e.altKey) return;
    e.preventDefault();
    e.stopPropagation();  // (Enter is the handle's here, never the composer's or a card's)
    choose(to);
  });

  // A smaller window narrows it; a bigger one gives the owner's width back.
  let pending = 0;
  root.addEventListener('resize', () => {
    if (pending) return;
    pending = root.requestAnimationFrame(() => { pending = 0; apply(wanted); });
  });

  if (F) F.codeSide = { width: () => shown, set: choose, reset: () => choose(null) };
})(typeof window !== 'undefined' ? window : globalThis);
