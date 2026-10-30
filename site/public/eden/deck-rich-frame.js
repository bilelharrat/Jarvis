// Rich text in the web editor's slide frame (deck-render.js embeds richFrame() when progressive, edit, embedded).
// It runs inside the sandboxed frame only (stringified, so it must be self-contained). It tells the page what text is
// selected (slide, path, character offsets, where it is on screen) so the page can show the format bar, sends the
// formatting keys (⌘B ⌘I ⌘U ⌘⇧X ⌘K ⌘⇧> ⌘⇧< ⌘⇧7 ⌘⇧8, Tab / Shift+Tab in a bullet, ⌥F10 to reach the bar), and puts the
// selection back after the page redraws the deck (every edit draws a new frame). The page does the formatting
// (deck-rich-ui.js → deck-rich.js); nothing here changes the deck.

export function richFrame() {
  'use strict';
  const SKIP = '.col-num,.eb-dot,.q-dash'; // decoration inside a text, not part of its words
  const post = (m) => { if (window.parent !== window) window.parent.postMessage(m, '*'); };
  const editing = () => document.body.classList.contains('mode-edit');
  const fieldOf = (n) => {
    const e = n && (n.nodeType === 1 ? n : n.parentElement);
    const f = e && e.closest && e.closest('#frame [data-path]');
    return f && !f.closest('aside') && f.dataset.path !== 'notes' ? f : null;
  };
  const texts = (f) => {
    const w = document.createTreeWalker(f, NodeFilter.SHOW_TEXT, { acceptNode: (t) => (t.parentElement && t.parentElement.closest(SKIP) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT) });
    const out = [];
    for (let t = w.nextNode(); t; t = w.nextNode()) out.push(t);
    return out;
  };
  const words = (f) => texts(f).map((t) => t.data).join('');
  // the character offset of a DOM point inside a text (decoration skipped)
  function offset(f, node, off) {
    const r = document.createRange();
    try { r.setStart(node, off); } catch { return 0; }
    let n = 0;
    for (const t of texts(f)) {
      if (t === node) return n + Math.min(off, t.length);
      if (r.comparePoint(t, 0) >= 0) return n;
      n += t.length;
    }
    return n;
  }
  function point(f, n) {
    const ts = texts(f);
    for (const t of ts) { if (n <= t.length) return [t, n]; n -= t.length; }
    return ts.length ? [ts[ts.length - 1], ts[ts.length - 1].length] : [f, 0];
  }
  const indexOf = (f) => Number(f.dataset.index || (f.closest('.slide') && f.closest('.slide').dataset.index));
  function current() {
    const sel = getSelection();
    if (sel && sel.rangeCount) {
      const f = fieldOf(sel.anchorNode);
      if (f && fieldOf(sel.focusNode) === f) {
        const a = offset(f, sel.anchorNode, sel.anchorOffset), b = offset(f, sel.focusNode, sel.focusOffset);
        const range = sel.getRangeAt(0);
        return { f, start: Math.min(a, b), end: Math.max(a, b), rect: a === b ? f.getBoundingClientRect() : range.getBoundingClientRect() };
      }
    }
    const f = fieldOf(document.activeElement);
    return f ? { f, start: 0, end: 0, rect: f.getBoundingClientRect() } : null;
  }
  let raf = 0;
  function report() {
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(() => {
      const c = editing() ? current() : null;
      if (!c || !Number.isInteger(indexOf(c.f)) || indexOf(c.f) < 0) { post({ type: 'deck-rich-sel', path: null }); return; }
      const r = c.rect;
      post({ type: 'deck-rich-sel', index: indexOf(c.f), path: c.f.dataset.path, start: c.start, end: c.end, editing: c.f.isContentEditable, rect: { x: r.left, y: r.top, w: r.width, h: r.height } });
    });
  }
  document.addEventListener('selectionchange', report);
  document.addEventListener('focusin', report);
  document.addEventListener('focusout', () => setTimeout(report, 0));
  addEventListener('resize', report);
  // a format key: the page applies it (with the words typed so far, so nothing is lost) and redraws
  function send(type, extra = {}) {
    const c = current();
    if (!c) return false;
    const msg = { type, index: indexOf(c.f), path: c.f.dataset.path, start: c.start, end: c.end, editing: c.f.isContentEditable, ...extra };
    if (c.f.isContentEditable && c.f.dataset.was !== undefined) {
      msg.value = words(c.f);
      c.f.dataset.was = c.f.textContent; // already sent: the commit on leaving the text has nothing more to say
    }
    post(msg);
    return true;
  }
  addEventListener('keydown', (e) => {
    if (!editing() || !fieldOf(document.activeElement)) return;
    const meta = e.metaKey || e.ctrlKey, k = (e.key || '').toLowerCase();
    let done = false;
    if (meta && !e.altKey && !e.shiftKey && (k === 'b' || k === 'i' || k === 'u')) done = send('deck-fmt', { patch: { [k]: 'toggle' } });
    else if (meta && e.shiftKey && (k === 'x' || e.code === 'KeyX')) done = send('deck-fmt', { patch: { s: 'toggle' } });
    else if (meta && e.shiftKey && (k === '>' || k === '.' || e.code === 'Period')) done = send('deck-fmt', { patch: { size: 'up' } });
    else if (meta && e.shiftKey && (k === '<' || k === ',' || e.code === 'Comma')) done = send('deck-fmt', { patch: { size: 'down' } });
    else if (meta && e.shiftKey && e.code === 'Digit7') done = send('deck-list', { kind: 'num' });
    else if (meta && e.shiftKey && e.code === 'Digit8') done = send('deck-list', { kind: 'bullet' });
    else if (meta && !e.shiftKey && k === 'k') done = send('deck-link');
    else if (e.key === 'F10' && e.altKey) done = send('deck-fmt-bar');
    else if (e.key === 'Tab' && !meta && !e.altKey && document.activeElement.isContentEditable && /bullets\.\d+/.test(document.activeElement.dataset.path)) done = send('deck-indent', { dir: e.shiftKey ? -1 : 1 });
    if (done) { e.preventDefault(); e.stopImmediatePropagation(); }
  }, true);
  // after a redraw: the same text, selected again (and still being typed in, if it was)
  addEventListener('message', (e) => {
    if (e.source !== window.parent) return;
    const m = e.data || {};
    // the format bar or Inspector (page) asks: sent from here, with the selection and the words typed so far
    if (m.type === 'deck-rich-do' && m.action && /^deck-(fmt|list|indent|link|align)$/.test(m.action.type)) {
      const { type, ...extra } = m.action;
      if (!send(type, extra)) post({ ...m.action, fallback: true }); // nothing selected here any more: the page uses what it last saw
      return;
    }
    if (m.type !== 'deck-select'|| typeof m.path !== 'string' || !Number.isInteger(m.index)) return;
    const sel = `#frame .slide[data-index="${m.index}"] [data-path="${CSS.escape(m.path)}"]`;
    const f = document.querySelector(sel);
    if (!f || !editing()) return;
    if (m.edit && !f.isContentEditable) {
      f.dataset.was = f.textContent;
      try { f.contentEditable = 'plaintext-only'; } catch { f.contentEditable = 'true'; }
      if (!f.isContentEditable) f.contentEditable = 'true';
    }
    f.focus({ preventScroll: true });
    const len = words(f).length;
    const a = Math.max(0, Math.min(len, m.start | 0)), b = Math.max(a, Math.min(len, m.end | 0));
    if (a !== b || m.edit) {
      const r = document.createRange();
      const [sn, so] = point(f, a), [en, eo] = point(f, b);
      try { r.setStart(sn, so); r.setEnd(en, eo); const s = getSelection(); s.removeAllRanges(); s.addRange(r); } catch { /* the text changed shape: focus is enough */ }
    }
    report();
  });
  post({ type: 'deck-rich-sel', path: null, boot: true }); // a new frame: whatever was selected in the old one is gone
}
