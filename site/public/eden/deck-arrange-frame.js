// Arranging, the slide frame's side (web editor only: deck-render.js embeds `arrangeFrame` in the progressive edit
// document, stringified, so it runs only inside the sandboxed frame). It marks hidden slides (skipped when
// presenting), groups the thumbnail strip into sections that collapse, lets the navigator pick several slides, asks the
// page for the right-click menu, and draws the editor's zoom, rulers, guides and grid (shortcuts: deck-shell-frame.js). Guides and the grid are
// offered to the free-form editor's snapping (window.edenSnap, deck-freeform-draw.js). Messages:
//   page → frame: deck-arrange { hidden, sections, collapsed, zoom, rulers, grid, gridSize, snap, guides },
//                 deck-arrange-insert { index, path, text }
//   frame → page: deck-ctx { kind: thumb|canvas|text|free, index, k, ids, path, x, y, keyboard }, deck-thumb-pick { k, how: range|toggle|all }, deck-thumbs-key { k, key: delete|copy|cut },
//                 deck-slide-paste { text, k }, deck-guides { guides }, deck-section-toggle { name, collapsed }, deck-fit { s }

export function arrangeFrame() {
  'use strict';
  if (window.parent === window) return;
  const post = (m) => window.parent.postMessage(m, '*');
  const body = document.body;
  const $ = (id) => document.getElementById(id);
  const slides = () => [...document.querySelectorAll('#frame > .slide')];
  const editing = () => body.classList.contains('mode-edit') && !body.classList.contains('overview');
  const cfg = { hidden: [], sections: [], collapsed: [], zoom: 0, rulers: false, grid: false, gridSize: 40, snap: false, guides: { x: [], y: [] } };
  const live = (s) => { const l = $('live'); if (l) l.textContent = s; };
  const css = document.createElement('style');
  css.textContent = `
#ezs{display:contents}
.ez #ezs{display:flex;flex:1 1 auto;min-height:0;align-self:stretch;overflow:auto;padding:4px}
.ez #ezs>#frame{margin:auto}
.er #ezs{padding:24px 4px 4px 24px}.er:not(.ez) #frame{margin:22px 0 0 22px}
.ea-ruler{position:absolute;z-index:6;background:rgba(246,246,248,.96);border:0;padding:0;margin:0;cursor:copy;display:none}
.dark-ui .ea-ruler{background:rgba(36,36,38,.96)}
.er.mode-edit .ea-ruler{display:block}
.ea-ruler:focus-visible{outline:3px solid #2f6df6;outline-offset:1px}
.ea-ruler canvas{display:block;pointer-events:none}
.egrid{position:absolute;inset:0;z-index:4;pointer-events:none;display:none;background-image:linear-gradient(to right,rgba(47,109,246,.22) 1px,transparent 1px),linear-gradient(to bottom,rgba(47,109,246,.22) 1px,transparent 1px);background-size:calc(var(--g) * var(--s)) calc(var(--g) * var(--s))}
.eg-on.mode-edit .egrid{display:block}
.eg{position:absolute;z-index:5;display:none;background:transparent}
.mode-edit .eg{display:block}
.eg.v{top:0;bottom:0;width:9px;margin-left:-4px;cursor:ew-resize}.eg.h{left:0;right:0;height:9px;margin-top:-4px;cursor:ns-resize}
.eg::after{content:"";position:absolute;background:#e5484d}
.eg.v::after{left:4px;top:0;bottom:0;width:1px}.eg.h::after{top:4px;left:0;right:0;height:1px}
.eg:focus-visible{outline:none}.eg:focus-visible::after{box-shadow:0 0 0 2px rgba(229,72,77,.45)}
.thumb.ea-hid>div>:not(.ea-badge){opacity:.4}
.thumb .ea-badge{position:absolute;z-index:3;right:4px;top:3px;font:600 10px -apple-system,system-ui,sans-serif;color:#fff;background:rgba(0,0,0,.6);border-radius:5px;padding:1px 5px}
.ea-sec{display:flex;align-items:center;gap:6px;width:100%;flex:none;flex-basis:100%;box-sizing:border-box;min-height:32px;padding:4px 8px;border:0;border-radius:8px;background:rgba(127,127,127,.12);color:inherit;font:600 12px -apple-system,system-ui,sans-serif;text-align:left;cursor:pointer}
.dark-ui .ea-sec{color:#eef0f5}
.ea-sec:focus-visible{outline:3px solid #2f6df6;outline-offset:2px}
.ea-sec .ea-tw{display:inline-block;transition:transform .15s}.ea-sec[aria-expanded="false"] .ea-tw{transform:rotate(-90deg)}
.ea-sec .ea-n{margin-left:auto;font-weight:500;opacity:.7}
.thumb.ea-folded{display:none}
@media (max-width:640px){.ea-sec{width:auto;flex-basis:auto;flex-direction:column;justify-content:center}}
@media (prefers-reduced-motion:reduce){.ea-sec .ea-tw{transition:none}}`;
  document.head.append(css);

  // ── the scroll box the zoomed slide sits in (invisible to the layout at "fit") ──
  const frame = $('frame');
  if (!frame) return;
  const box = document.createElement('div');
  box.id = 'ezs';
  frame.parentNode.insertBefore(box, frame);
  box.append(frame);
  const grid = document.createElement('div'); grid.className = 'egrid'; grid.setAttribute('aria-hidden', 'true');
  frame.append(grid);
  const scale = () => parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--s')) || 1;

  // ── hidden slides and sections ──
  const indexOfK = (k) => { const s = slides()[k]; return s ? Number(s.dataset.index) : -1; };
  const sectionAt = (i) => cfg.sections.find((s) => i >= s.start && i <= s.end && s.name);
  function mark() {
    const hid = new Set(cfg.hidden);
    for (const s of slides()) { if (hid.has(Number(s.dataset.index))) s.dataset.hide = '1'; else delete s.dataset.hide; }
    decorate();
  }
  let decorating = false;
  function decorate() {
    const strip = $('strip');
    if (!strip || decorating) return;
    decorating = true;
    strip.querySelectorAll('.ea-sec').forEach((e) => e.remove());
    const hid = new Set(cfg.hidden), folded = new Set(cfg.collapsed);
    let last = null;
    for (const t of strip.querySelectorAll('.thumb')) {
      const i = indexOfK(Number(t.dataset.k));
      const h = hid.has(i);
      t.classList.toggle('ea-hid', h);
      let badge = t.querySelector('.ea-badge');
      if (h && !badge) { badge = document.createElement('span'); badge.className = 'ea-badge'; badge.textContent = 'Hidden'; (t.querySelector(':scope > div') || t).append(badge); }
      else if (!h && badge) badge.remove();
      const base = (t.getAttribute('aria-label') || '').replace(/, hidden$/, '');
      t.setAttribute('aria-label', h ? `${base}, hidden` : base);
      const sec = i >= 0 ? sectionAt(i) : null;
      const name = sec ? sec.name : '';
      if (sec && sec !== last) {
        const b = document.createElement('button');
        b.type = 'button'; b.className = 'ea-sec'; b.dataset.section = name;
        const open = !folded.has(name);
        b.setAttribute('aria-expanded', String(open));
        const tw = document.createElement('span'); tw.className = 'ea-tw'; tw.setAttribute('aria-hidden', 'true'); tw.textContent = '▾';
        const nm = document.createElement('span'); nm.textContent = name;
        const n = document.createElement('span'); n.className = 'ea-n'; n.textContent = String(sec.end - sec.start + 1);
        b.setAttribute('aria-label', `Section ${name}, ${sec.end - sec.start + 1} slides`);
        b.append(tw, nm, n);
        b.addEventListener('click', () => toggleSection(name));
        strip.insertBefore(b, t);
      }
      last = sec;
      t.classList.toggle('ea-folded', !!name && folded.has(name) && !t.classList.contains('on'));
    }
    decorating = false;
  }
  function toggleSection(name) {
    const folded = new Set(cfg.collapsed);
    const was = folded.has(name);
    if (was) folded.delete(name); else folded.add(name);
    cfg.collapsed = [...folded];
    decorate();
    const b = [...document.querySelectorAll('#strip .ea-sec')].find((x) => x.dataset.section === name);
    if (b) b.focus();
    live(`${name} ${was ? 'expanded' : 'collapsed'}`);
    post({ type: 'deck-section-toggle', name, collapsed: !was });
  }
  const strip = $('strip');
  if (strip) new MutationObserver(() => { if (!decorating) decorate(); }).observe(strip, { childList: true });
  // the current thumbnail stays visible even inside a folded section
  new MutationObserver(() => { if (!decorating && strip) for (const t of strip.querySelectorAll('.thumb')) { const sec = sectionAt(indexOfK(Number(t.dataset.k))); t.classList.toggle('ea-folded', !!sec && cfg.collapsed.includes(sec.name) && !t.classList.contains('on')); } })
    .observe(strip || body, { attributes: true, subtree: true, attributeFilter: ['class'] });

  // ── right-click (and Shift+F10, the menu key): the page draws the one menu (deck-arrange-menu.js); deck-shell-frame.js
  // steps aside when this has already handled it (defaultPrevented) ──
  function target(t) {
    if (!t || !t.closest || !editing()) return null;
    const th = t.closest('#strip .thumb');
    if (th) return { kind: 'thumb', index: indexOfK(Number(th.dataset.k)), k: Number(th.dataset.k), el: th };
    const cur = document.querySelector('#frame > .slide.cur');
    const curIndex = cur ? Number(cur.dataset.index) : -1;
    const fe = t.closest('#frame > .slide > .free > .fr-el');
    if (fe) {
      const on = [...fe.parentElement.querySelectorAll(':scope > .fr-el.fr-on')].map((e) => e.dataset.fid);
      return { kind: 'free', index: curIndex, ids: on.includes(fe.dataset.fid) ? on : [fe.dataset.fid], el: fe };
    }
    const tx = t.closest('[data-path]');
    if (tx && (tx.closest('#frame') || tx.closest('#notesbox'))) return { kind: 'text', index: Number(tx.dataset.index || (tx.closest('.slide') || {}).dataset.index), path: tx.dataset.path, el: tx };
    if (t.closest('#frame')) return { kind: 'canvas', index: curIndex, el: frame };
    return null;
  }
  function ask(e, keyboard) {
    const tg = target(keyboard ? document.activeElement : e.target);
    if (!tg) return false;
    let x = e.clientX, y = e.clientY;
    if (keyboard || (!x && !y)) { const r = tg.el.getBoundingClientRect(); x = r.left + Math.min(24, r.width / 2); y = r.top + Math.min(r.height, 28); }
    const { el, ...m } = tg;
    post({ type: 'deck-ctx', ...m, x: Math.round(x), y: Math.round(y), keyboard: !!keyboard });
    return true;
  }
  let viaKey = 0;
  addEventListener('contextmenu', (e) => {
    if (e.target.isContentEditable || (e.target.closest && e.target.closest('[contenteditable="true"],[contenteditable="plaintext-only"]'))) return; // typing: the browser's own menu (spelling)
    if (Date.now() - viaKey < 500) { e.preventDefault(); e.stopPropagation(); return; }
    if (ask(e, false)) { e.preventDefault(); e.stopPropagation(); } // one menu: the shell frame's listener never sees it
  }, true);
  addEventListener('keydown', (e) => {
    if (!((e.key === 'F10' && e.shiftKey) || e.key === 'ContextMenu') || (e.target && e.target.isContentEditable)) return;
    if (ask(e, true)) { e.preventDefault(); e.stopPropagation(); viaKey = Date.now(); }
  }, true);

  // ── the navigator: several slides at once (Shift-click a run, ⌘-click one more, Shift+↑↓, ⌘A); the page keeps the
  // selection (deck-shell.js select) and highlights it back (deck-thumbs-sel). Delete, ⌘C, ⌘X act on it; paste lands after.
  const picked = () => document.querySelectorAll('#strip .thumb.sel').length;
  addEventListener('click', (e) => {
    const th = editing() && e.target.closest && e.target.closest('#strip .thumb');
    if (!th || !(e.shiftKey || e.metaKey || e.ctrlKey)) return;
    e.preventDefault(); e.stopPropagation(); // not a jump to that slide
    post({ type: 'deck-thumb-pick', k: Number(th.dataset.k), how: e.shiftKey ? 'range' : 'toggle' });
  }, true);
  addEventListener('keydown', (e) => {
    const t = e.target;
    const th = editing() && t && t.closest && t.closest('#strip .thumb');
    if (!th) return;
    const mod = e.metaKey || e.ctrlKey;
    const all = [...document.querySelectorAll('#strip .thumb:not(.ea-folded)')];
    if (e.shiftKey && !mod && !e.altKey && (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'ArrowRight' || e.key === 'ArrowLeft')) {
      e.preventDefault(); e.stopPropagation();
      const n = all[all.indexOf(th) + (e.key === 'ArrowDown' || e.key === 'ArrowRight' ? 1 : -1)];
      if (!n) return;
      n.focus();
      post({ type: 'deck-thumb-pick', k: Number(n.dataset.k), how: 'range' });
    } else if (mod && !e.altKey && (e.key === 'a' || e.key === 'A')) { e.preventDefault(); e.stopPropagation(); post({ type: 'deck-thumb-pick', how: 'all' }); live('All slides selected'); }
    else if (mod && !e.shiftKey && !e.altKey && (e.key === 'c' || e.key === 'C' || e.key === 'x' || e.key === 'X')) { e.preventDefault(); e.stopPropagation(); post({ type: 'deck-thumbs-key', k: Number(th.dataset.k), key: e.key === 'c' || e.key === 'C' ? 'copy' : 'cut' }); }
    else if ((e.key === 'Delete' || e.key === 'Backspace') && picked() > 1) { e.preventDefault(); e.stopPropagation(); post({ type: 'deck-thumbs-key', k: Number(th.dataset.k), key: 'delete' }); }
  }, true);
  addEventListener('paste', (e) => {
    const t = e.target;
    if (!editing() || (t.closest && t.closest('[contenteditable="true"],[contenteditable="plaintext-only"],input,textarea'))) return;
    const th = t.closest && t.closest('#strip .thumb');
    if (!th && !(t.closest && t.closest('#strip'))) return; // on the slide, ⌘V pastes free elements (deck-freeform-draw.js)
    const text = (e.clipboardData && e.clipboardData.getData('text/plain')) || '';
    if (!text) return;
    e.preventDefault();
    post({ type: 'deck-slide-paste', text: text.slice(0, 12_000_000), k: th ? Number(th.dataset.k) : -1 });
  }, true);

  // ── zoom ──
  function zoom() {
    window.edenZoom = cfg.zoom > 0 ? cfg.zoom : 0;
    window.edenPad = cfg.rulers ? 22 : 0;
    body.classList.toggle('ez', cfg.zoom > 0);
    body.classList.toggle('er', !!cfg.rulers);
    body.classList.toggle('eg-on', !!cfg.grid);
    document.documentElement.style.setProperty('--g', String(cfg.gridSize || 40));
    dispatchEvent(new Event('resize')); // the viewer fits the slide again (deck-render.js fit reads edenZoom)
    requestAnimationFrame(rulers);
  }

  // ── rulers ──
  const mkRuler = (dir) => {
    const b = document.createElement('button');
    b.type = 'button'; b.className = `ea-ruler ea-${dir}`;
    b.setAttribute('aria-label', dir === 'top' ? 'Ruler: press Enter to add a horizontal guide' : 'Ruler: press Enter to add a vertical guide');
    const c = document.createElement('canvas'); c.setAttribute('aria-hidden', 'true');
    b.append(c);
    b.addEventListener('click', (e) => { if (e.detail === 0) addGuide(dir === 'top' ? 'y' : 'x', dir === 'top' ? 360 : 640, true); }); // keyboard (a pointer drags instead)
    b.addEventListener('pointerdown', (e) => { if (e.button !== 0) return; e.preventDefault(); dragNew(dir === 'top' ? 'y' : 'x', e); });
    return b;
  };
  const stage = $('stage');
  const top = mkRuler('top'), left = mkRuler('left');
  if (stage) stage.append(top, left);
  function rulers() {
    if (!cfg.rulers || !stage) return;
    const sr = stage.getBoundingClientRect(), fr = frame.getBoundingClientRect(), vr = (body.classList.contains('ez') ? box : stage).getBoundingClientRect();
    const s = scale(), dpr = devicePixelRatio || 1, T = 18;
    const l = Math.max(fr.left, vr.left), r = Math.min(fr.right, vr.right), t = Math.max(fr.top, vr.top), b = Math.min(fr.bottom, vr.bottom);
    const draw = (btn, horiz) => {
      const len = Math.max(0, horiz ? r - l : b - t);
      Object.assign(btn.style, horiz ? { left: `${l - sr.left}px`, top: `${Math.max(vr.top, fr.top - T - 2) - sr.top}px`, width: `${len}px`, height: `${T}px` } : { left: `${Math.max(vr.left, fr.left - T - 2) - sr.left}px`, top: `${t - sr.top}px`, width: `${T}px`, height: `${len}px` });
      const c = btn.firstChild;
      c.width = Math.round((horiz ? len : T) * dpr); c.height = Math.round((horiz ? T : len) * dpr);
      c.style.width = `${horiz ? len : T}px`; c.style.height = `${horiz ? T : len}px`;
      const g = c.getContext('2d');
      if (!g) return;
      g.scale(dpr, dpr);
      const dark = body.classList.contains('dark-ui');
      g.fillStyle = g.strokeStyle = dark ? '#a3abbd' : '#5b6475';
      g.font = '9px -apple-system,system-ui,sans-serif';
      g.lineWidth = 1;
      const off = horiz ? l - fr.left : t - fr.top; // the slide's pixel at the ruler's start
      const step = s >= 1.5 ? 10 : s >= 0.6 ? 20 : 40;
      const max = horiz ? 1280 : 720;
      g.beginPath();
      for (let v = 0; v <= max; v += step) {
        const p = v * s - off;
        if (p < -1 || p > len + 1) continue;
        const major = v % (step * 4) === 0;
        const h = major ? T * 0.6 : T * 0.3;
        if (horiz) { g.moveTo(Math.round(p) + 0.5, T); g.lineTo(Math.round(p) + 0.5, T - h); } else { g.moveTo(T, Math.round(p) + 0.5); g.lineTo(T - h, Math.round(p) + 0.5); }
        if (major && v > 0) { if (horiz) g.fillText(String(v), p + 2, 9); else { g.save(); g.translate(9, p + 2); g.rotate(Math.PI / 2); g.fillText(String(v), 0, 0); g.restore(); } }
      }
      g.stroke();
    };
    draw(top, true); draw(left, false);
  }
  box.addEventListener('scroll', () => requestAnimationFrame(rulers), { passive: true });
  addEventListener('resize', () => requestAnimationFrame(rulers));
  if (window.ResizeObserver) new ResizeObserver(() => requestAnimationFrame(rulers)).observe(frame);

  // ── guides: drag one out of a ruler, drag it off the slide to remove; keys: arrows move, Delete removes ──
  function drawGuides() {
    frame.querySelectorAll(':scope > .eg').forEach((g) => g.remove());
    const s = scale();
    for (const axis of ['x', 'y']) for (const v of cfg.guides[axis]) {
      const g = document.createElement('div');
      g.className = `eg ${axis === 'x' ? 'v' : 'h'}`;
      g.dataset.axis = axis; g.dataset.v = String(v);
      g.style[axis === 'x' ? 'left' : 'top'] = `${v * s}px`;
      g.tabIndex = 0;
      g.setAttribute('role', 'slider');
      g.setAttribute('aria-orientation', axis === 'x' ? 'horizontal' : 'vertical');
      g.setAttribute('aria-label', axis === 'x' ? 'Vertical guide' : 'Horizontal guide');
      g.setAttribute('aria-valuemin', '0'); g.setAttribute('aria-valuemax', axis === 'x' ? '1280' : '720'); g.setAttribute('aria-valuenow', String(v));
      g.setAttribute('aria-valuetext', `${v} pixels; arrow keys move it, Delete removes it`);
      g.addEventListener('pointerdown', (e) => { if (e.button !== 0) return; e.preventDefault(); e.stopPropagation(); dragGuide(g, e); });
      g.addEventListener('keydown', (e) => keyGuide(g, e));
      frame.append(g);
    }
  }
  const saveGuides = () => post({ type: 'deck-guides', guides: cfg.guides });
  function setGuide(axis, from, to) {
    const list = cfg.guides[axis].filter((v) => v !== from);
    if (to !== null) list.push(to);
    cfg.guides = { ...cfg.guides, [axis]: [...new Set(list)] };
  }
  function addGuide(axis, v, focus) {
    if (cfg.guides[axis].length >= 20) { live('At most 20 guides each way'); return; }
    let at = v;
    while (cfg.guides[axis].includes(at)) at += 10;
    setGuide(axis, null, at);
    drawGuides(); saveGuides();
    if (focus) { const g = [...frame.querySelectorAll(':scope > .eg')].find((x) => x.dataset.axis === axis && Number(x.dataset.v) === at); if (g) g.focus(); }
    live(`${axis === 'x' ? 'Vertical' : 'Horizontal'} guide added at ${at}`);
  }
  const slidePt = (e, axis) => { const r = frame.getBoundingClientRect(), s = scale(); return Math.round(((axis === 'x' ? e.clientX - r.left : e.clientY - r.top)) / s); };
  function follow(axis, start, onEnd) {
    const max = axis === 'x' ? 1280 : 720;
    let cur = start;
    const move = (ev) => { cur = slidePt(ev, axis); onEnd(cur, false, max); };
    const up = (ev) => { removeEventListener('pointermove', move, true); removeEventListener('pointerup', up, true); removeEventListener('pointercancel', up, true); cur = slidePt(ev, axis); onEnd(cur, true, max); };
    addEventListener('pointermove', move, true); addEventListener('pointerup', up, true); addEventListener('pointercancel', up, true);
  }
  function dragGuide(g, e) {
    const axis = g.dataset.axis, was = Number(g.dataset.v), s = scale();
    follow(axis, was, (v, done, max) => {
      const inside = v >= 0 && v <= max;
      g.style[axis === 'x' ? 'left' : 'top'] = `${Math.max(0, Math.min(max, v)) * s}px`;
      g.style.opacity = inside ? '' : '0.3';
      if (!done) return;
      setGuide(axis, was, inside ? v : null);
      drawGuides(); saveGuides();
      live(inside ? `Guide at ${v}` : 'Guide removed');
    });
  }
  function dragNew(axis, e) {
    const s = scale();
    const g = document.createElement('div');
    g.className = `eg ${axis === 'x' ? 'v' : 'h'}`;
    g.style.opacity = '0.3';
    frame.append(g);
    follow(axis, -1, (v, done, max) => {
      const inside = v >= 0 && v <= max;
      g.style[axis === 'x' ? 'left' : 'top'] = `${Math.max(0, Math.min(max, v)) * s}px`;
      g.style.opacity = inside ? '' : '0.3';
      if (!done) return;
      g.remove();
      if (inside) addGuide(axis, v, false); else live('No guide added');
    });
  }
  function keyGuide(g, e) {
    const axis = g.dataset.axis, v = Number(g.dataset.v), max = axis === 'x' ? 1280 : 720;
    const d = { ArrowLeft: -1, ArrowUp: -1, ArrowRight: 1, ArrowDown: 1 }[e.key];
    if (d) {
      e.preventDefault(); e.stopPropagation();
      const to = Math.max(0, Math.min(max, v + d * (e.shiftKey ? 10 : 1)));
      setGuide(axis, v, to); drawGuides(); saveGuides();
      const n = [...frame.querySelectorAll(':scope > .eg')].find((x) => x.dataset.axis === axis && Number(x.dataset.v) === to);
      if (n) n.focus();
    } else if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault(); e.stopPropagation();
      setGuide(axis, v, null); drawGuides(); saveGuides();
      live('Guide removed');
      (axis === 'x' ? left : top).focus();
    } else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); body.focus(); }
  }
  if (window.ResizeObserver) new ResizeObserver(() => drawGuides()).observe(frame);

  // what free-form elements snap to, besides the slide and each other (deck-freeform-draw.js drag)
  window.edenSnap = () => {
    const x = [...cfg.guides.x], y = [...cfg.guides.y];
    if (cfg.snap) { const g = cfg.gridSize || 40; for (let v = g; v < 1280; v += g) x.push(v); for (let v = g; v < 720; v += g) y.push(v); }
    return { x, y, r: cfg.snap ? (cfg.gridSize || 40) / 2 : 0 };
  };

  // ── the page ──
  addEventListener('message', (e) => {
    if (e.source !== window.parent) return;
    const m = e.data || {};
    if (m.type === 'deck-arrange') {
      const ints = (v, max) => (Array.isArray(v) ? v.filter((n) => Number.isInteger(n) && n >= 0 && n <= max) : []);
      cfg.hidden = ints(m.hidden, 1000);
      cfg.sections = Array.isArray(m.sections) ? m.sections.filter((s) => s && typeof s.name === 'string' && Number.isInteger(s.start) && Number.isInteger(s.end)).slice(0, 200) : [];
      cfg.collapsed = Array.isArray(m.collapsed) ? m.collapsed.filter((s) => typeof s === 'string').slice(0, 200) : [];
      cfg.zoom = Number.isFinite(m.zoom) && m.zoom >= 0.25 && m.zoom <= 4 ? m.zoom : 0;
      cfg.rulers = m.rulers === true; cfg.grid = m.grid === true; cfg.snap = m.snap === true;
      cfg.gridSize = [20, 40, 80].includes(m.gridSize) ? m.gridSize : 40;
      cfg.guides = { x: ints(m.guides && m.guides.x, 1280), y: ints(m.guides && m.guides.y, 720) };
      mark(); zoom(); drawGuides();
      post({ type: 'deck-fit', s: scale() });
    } else if (m.type === 'deck-arrange-insert' && typeof m.text === 'string' && typeof m.path === 'string') {
      const sl = slides().find((s) => Number(s.dataset.index) === m.index && s.classList.contains('cur')) || slides().find((s) => Number(s.dataset.index) === m.index);
      const t = sl && [...sl.querySelectorAll('[data-path]')].find((x) => x.dataset.path === m.path);
      if (!t) return;
      t.dispatchEvent(new MouseEvent('click', { bubbles: true })); // starts editing (deck-render.js editable)
      if (!t.isContentEditable) return;
      const r = document.createRange(); r.selectNodeContents(t); r.collapse(false);
      const s = getSelection(); s.removeAllRanges(); s.addRange(r);
      document.execCommand('insertText', false, m.text.slice(0, 2000));
    }
  });
}
