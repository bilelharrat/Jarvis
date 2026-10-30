// Find and spelling marks inside the web editor's slide frame (deck-render.js adds this script to the
// progressive edit frame only; never the iPhone app, the print copy or a shared deck). It takes
// { type: 'deck-marks', find: [...], cur, spell: [...] } from the page (deck-find.js): each mark is
// { index, path | fid, start, end, text }, character offsets into that piece's text. Marks are drawn
// with the CSS Custom Highlight API (no change to the slide's DOM); where it's missing, or for SVG text,
// the piece gets an outline instead. The current find match's slide number goes back as 'deck-mark-at'.
// While a piece is being typed in, its spelling marks step aside for the browser's own underline.
// Stringified into the sandboxed frame: self-contained, no imports.

export function marksFrame() {
  'use strict';
  const post = (m) => { if (window.parent !== window) window.parent.postMessage(m, '*'); };
  const HL = typeof Highlight === 'function' && window.CSS && CSS.highlights;
  const st = document.createElement('style');
  st.textContent = '::highlight(eden-find){background:rgba(255,204,0,.45);color:inherit}::highlight(eden-find-cur){background:#ffcc00;color:#1d1d1f}'
    + '::highlight(eden-spell){text-decoration:underline wavy #ff3b30;text-decoration-thickness:1.5px;text-underline-offset:3px;text-decoration-skip-ink:none}'
    + '.eden-find-el{outline:2px solid rgba(255,204,0,.9)!important;outline-offset:2px}.eden-find-cur-el{outline:3px solid #ffcc00!important;outline-offset:2px}'
    + '.eden-spell-el{text-decoration:underline wavy #ff3b30}';
  document.head.append(st);
  let last = { find: [], spell: [], cur: -1 };
  const slides = () => [...document.querySelectorAll('#frame > .slide')];
  // the pieces showing one mark: every part of a split slide, and the notes box under the current slide
  function piecesOf(m) {
    const out = [];
    const q = m.fid ? `.fr-el[data-fid="${CSS.escape(m.fid)}"] .fr-t, .fr-el[data-fid="${CSS.escape(m.fid)}"] .fr-stt` : `[data-path="${CSS.escape(m.path)}"]`;
    for (const sl of slides()) if (Number(sl.dataset.index) === m.index) for (const e of sl.querySelectorAll(q)) if (e.tagName !== 'ASIDE') out.push(e);
    if (m.path === 'notes') for (const e of document.querySelectorAll('#notesed [data-path="notes"]')) if (Number(e.dataset.index) === m.index) out.push(e);
    return out;
  }
  // a Range over [start, end) of the piece's text, or null when the text there isn't the mark's
  function rangeIn(el, m) {
    const full = el.textContent;
    let a = m.start, b = m.end;
    if (full.slice(a, b) !== m.text) { const at = full.indexOf(m.text); if (at < 0) return null; a = at; b = at + m.text.length; }
    const walk = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    const r = document.createRange();
    let pos = 0, n, set = 0;
    while ((n = walk.nextNode())) {
      const len = n.nodeValue.length;
      if (!(set & 1) && a <= pos + len) { r.setStart(n, a - pos); set |= 1; }
      if ((set & 1) && b <= pos + len) { r.setEnd(n, b - pos); set |= 2; break; }
      pos += len;
    }
    return set === 3 ? r : null;
  }
  const svg = (el) => el instanceof SVGElement;
  function draw() {
    document.querySelectorAll('.eden-find-el,.eden-find-cur-el,.eden-spell-el').forEach((e) => e.classList.remove('eden-find-el', 'eden-find-cur-el', 'eden-spell-el'));
    const sets = { 'eden-find': [], 'eden-find-cur': [], 'eden-spell': [] };
    const editing = document.activeElement && document.activeElement.isContentEditable ? document.activeElement : null;
    const mark = (m, name, cls) => {
      for (const el of piecesOf(m)) {
        if (name === 'eden-spell' && editing && editing.contains(el)) continue; // the browser underlines what's being typed
        const r = HL && !svg(el) ? rangeIn(el, m) : null;
        if (r) sets[name].push(r); else el.classList.add(cls);
      }
    };
    last.spell.forEach((m) => mark(m, 'eden-spell', 'eden-spell-el'));
    last.find.forEach((m, i) => mark(m, i === last.cur ? 'eden-find-cur' : 'eden-find', i === last.cur ? 'eden-find-cur-el' : 'eden-find-el'));
    if (HL) for (const [name, ranges] of Object.entries(sets)) { if (ranges.length) CSS.highlights.set(name, new Highlight(...ranges)); else CSS.highlights.delete(name); }
  }
  window.addEventListener('message', (e) => {
    if (e.source !== window.parent || !e.data || e.data.type !== 'deck-marks') return;
    const m = e.data;
    const ok = (x) => x && Number.isInteger(x.index) && Number.isInteger(x.start) && Number.isInteger(x.end) && typeof x.text === 'string' && (typeof x.path === 'string' || typeof x.fid === 'string');
    if (Array.isArray(m.find)) last.find = m.find.filter(ok).slice(0, 2000);
    if (Array.isArray(m.spell)) last.spell = m.spell.filter(ok).slice(0, 2000);
    if ('cur' in m) last.cur = Number.isInteger(m.cur) ? m.cur : -1;
    draw();
    const c = last.find[last.cur];
    if (c && m.go) { // the slide (or part of a split slide) that shows the current match
      const el = piecesOf(c).find((x) => !x.closest('#notesed'));
      const sl = el && el.closest('#frame > .slide');
      const k = sl ? slides().indexOf(sl) : slides().findIndex((s) => Number(s.dataset.index) === c.index);
      if (k >= 0) post({ type: 'deck-mark-at', k });
    }
  });
  // browser spell check while typing, in the slide's own language (the section's lang, else the page's)
  const spellOn = () => document.querySelectorAll('#frame [data-path], #notesed [data-path], #frame .fr-t, #frame .fr-stt').forEach((e) => { e.spellcheck = true; });
  spellOn();
  document.addEventListener('focusin', () => setTimeout(draw, 0));
  document.addEventListener('focusout', () => setTimeout(draw, 0));
  let queued = 0;
  const later = () => { if (!queued) queued = requestAnimationFrame(() => { queued = 0; spellOn(); draw(); }); };
  const notes = document.getElementById('notesed');
  if (notes) new MutationObserver(later).observe(notes, { childList: true });
  const frame = document.getElementById('frame');
  if (frame) new MutationObserver(later).observe(frame, { childList: true, subtree: true, characterData: false, attributes: false });
}
