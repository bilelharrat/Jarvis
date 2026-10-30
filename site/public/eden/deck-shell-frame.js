// The slide frame's half of the Keynote-style editor shell (deck-shell.js; web only). deck-render.js adds this CSS and
// script only to the progressive edit document (`cfg.progressive && mode === 'edit' && cfg.embedded`), never to the
// iPhone app, a shared copy or the PDF. No imports: the script is stringified into the sandboxed frame.
// The frame tells the page what is selected (deck-sel), where a right-click happened (deck-context) and which
// registered shortcut was pressed while it had focus (deck-key). The page sets the navigator view (deck-nav) and the
// shortcut list (deck-keys). The page checks every message's source (deck.js, deck-shell.js).

/** Keynote's navigator, canvas ground and notes, inside the frame. Scoped to the progressive edit mode only. */
export const SHELL_FRAME_CSS = `
.progressive.mode-edit{background:#ececf0;color:#1d1d1f}
.progressive.mode-edit.dark-ui{background:#1b1b1d;color:#f5f5f7}
.progressive.mode-edit #bar,.progressive.mode-edit .hint{display:none!important}
.progressive.mode-edit #strip{width:176px;padding:12px 10px 16px 6px;gap:6px;border-right:1px solid rgba(0,0,0,.09);background:rgba(246,246,248,.86);scrollbar-width:thin}
.progressive.mode-edit.dark-ui #strip{background:rgba(36,36,38,.86);border-color:rgba(255,255,255,.08)}
.progressive.mode-edit .thumb{display:flex;align-items:flex-start;gap:6px;width:100%;height:auto;padding:5px 6px;border:0;border-radius:10px;box-shadow:none;overflow:visible;transition:background-color .2s cubic-bezier(.32,.72,0,1)}
.progressive.mode-edit .thumb>div{position:relative;flex:none;width:136px;height:76.5px;border-radius:5px;overflow:hidden;box-shadow:0 0 0 .5px rgba(0,0,0,.18),0 1px 3px rgba(0,0,0,.12)}
.progressive.mode-edit .thumb .slide{transform:scale(.10625)}
.progressive.mode-edit .thumb .tn{position:static;order:-1;flex:none;width:18px;padding:2px 0 0;background:none;color:#6e6e73;font:600 11px/1.2 -apple-system,BlinkMacSystemFont,system-ui,sans-serif;text-align:right;font-variant-numeric:tabular-nums}
.progressive.mode-edit.dark-ui .thumb .tn{color:#98989d}
.progressive.mode-edit .thumb:hover{background:rgba(0,0,0,.04)}
.progressive.mode-edit.dark-ui .thumb:hover{background:rgba(255,255,255,.05)}
.progressive.mode-edit .thumb.on{background:rgba(10,132,255,.14)}
.progressive.mode-edit .thumb.on>div{box-shadow:0 0 0 2.5px #0a84ff}
.progressive.mode-edit.dark-ui .thumb.on{background:rgba(59,155,255,.2)}
.progressive.mode-edit.dark-ui .thumb.on>div{box-shadow:0 0 0 2.5px #3b9bff}
.progressive.mode-edit .thumb.on .tn{color:#0a84ff}.progressive.mode-edit.dark-ui .thumb.on .tn{color:#3b9bff}
.progressive.mode-edit .thumb.sel>div{box-shadow:0 0 0 2.5px rgba(10,132,255,.55)}
.progressive.mode-edit .thumb.drop{box-shadow:0 -3px 0 0 #0a84ff}
.progressive.mode-edit .thumb:focus-visible{outline:3px solid #0a84ff;outline-offset:1px}
.progressive.mode-edit #stage{padding:24px 28px 16px;gap:14px}
.progressive.mode-edit #frame{border-radius:4px;box-shadow:0 0 0 .5px rgba(0,0,0,.12),0 4px 14px rgba(0,0,0,.10),0 24px 60px rgba(0,0,0,.12)}
.progressive.mode-edit #notesbox{border-radius:10px;background:rgba(255,255,255,.82);border-color:rgba(0,0,0,.08);max-height:14vh}
.progressive.mode-edit.dark-ui #notesbox{background:rgba(255,255,255,.05);border-color:rgba(255,255,255,.09)}
.progressive.mode-edit #notesbox .nl{text-transform:uppercase;letter-spacing:.06em;font-size:10.5px}
.progressive.mode-edit.nav-hidden #strip{display:none}
.progressive.mode-edit.notes-hidden #notesbox{display:none}
/* Light table: the navigator fills the window as a grid; picking a slide goes back to the list (deck-shell.js View). */
.progressive.mode-edit.nav-grid #stage{display:none}
.progressive.mode-edit.nav-grid #strip{display:grid;width:auto;flex:1;grid-template-columns:repeat(auto-fill,minmax(232px,1fr));align-content:start;gap:12px;padding:20px 24px;border:0;background:transparent}
.progressive.mode-edit.nav-grid .thumb{flex-direction:column-reverse;align-items:center;gap:6px;padding:8px}
.progressive.mode-edit.nav-grid .thumb>div{width:208px;height:117px}
.progressive.mode-edit.nav-grid .thumb .slide{transform:scale(.1625)}
.progressive.mode-edit.nav-grid .thumb .tn{width:auto;text-align:center}
@media (max-width:640px){.progressive.mode-edit #strip{width:auto;padding:6px 8px;gap:4px;background:rgba(246,246,248,.92)}.progressive.mode-edit .thumb{flex-direction:column-reverse;align-items:center;width:auto;padding:4px;gap:2px}.progressive.mode-edit .thumb>div{width:104px;height:58.5px}.progressive.mode-edit .thumb .slide{transform:scale(.08125)}.progressive.mode-edit .thumb .tn{width:auto;text-align:center;padding:0}.progressive.mode-edit #stage{padding:10px}}
@media (prefers-reduced-motion:reduce){.progressive.mode-edit .thumb{transition:none}}
`;

/** Runs in the sandboxed frame (stringified by deck-render.js). */
export function shellFrame() {
  'use strict';
  const post = (m) => { if (window.parent !== window) window.parent.postMessage(m, '*'); };
  const body = document.body;
  const slideOf = (n) => n && n.closest && n.closest('#frame > .slide');
  const idxOf = (n) => { const s = slideOf(n); const i = s ? Number(s.dataset.index) : -1; return Number.isInteger(i) ? i : -1; };
  // the selected text (a title, a bullet, the notes): the inspector's Text section follows it
  let lastPath = null;
  document.addEventListener('focusin', (e) => {
    const t = e.target.closest && e.target.closest('[data-path]');
    if (!t) return;
    lastPath = t.dataset.path;
    const index = t.dataset.path === 'notes' ? Number(t.dataset.index) : idxOf(t);
    post({ type: 'deck-sel', index: Number.isInteger(index) ? index : -1, path: lastPath, editing: !!t.isContentEditable });
  });
  document.addEventListener('focusout', (e) => {
    const t = e.target.closest && e.target.closest('[data-path]');
    if (!t || (e.relatedTarget && e.relatedTarget.closest && e.relatedTarget.closest('[data-path]'))) return;
    setTimeout(() => { const a = document.activeElement; if (!(a && a.closest && a.closest('[data-path]'))) { lastPath = null; post({ type: 'deck-sel', index: -1, path: null }); } }, 0);
  });
  // right-click (or the context-menu key): the page draws the menu over the frame
  document.addEventListener('contextmenu', (e) => {
    if (!body.classList.contains('mode-edit')) return;
    const n = e.target;
    if (n && n.isContentEditable) return; // the browser's own menu while typing (spelling, paste)
    const thumb = n.closest && n.closest('.thumb');
    const free = n.closest && n.closest('[data-fid]');
    const text = n.closest && n.closest('[data-path]');
    let x = e.clientX, y = e.clientY;
    if (!x && !y && n.getBoundingClientRect) { const r = n.getBoundingClientRect(); x = r.left + 12; y = r.top + 12; } // the keyboard's menu key
    let target = 'slide', index = idxOf(n);
    const m = { type: 'deck-context', x, y };
    if (thumb) {
      target = 'thumb';
      const s = document.querySelectorAll('#frame > .slide')[Number(thumb.dataset.k)];
      index = s ? Number(s.dataset.index) : -1;
      m.k = Number(thumb.dataset.k);
    } else if (free) { target = 'element'; m.id = free.dataset.fid; }
    else if (text) { target = 'text'; m.path = text.dataset.path; if (text.dataset.path === 'notes') index = Number(text.dataset.index); }
    else if (!slideOf(n)) return; // the grey ground around the slide: nothing to offer
    e.preventDefault();
    post({ ...m, target, index: Number.isInteger(index) ? index : -1 });
  });
  // the navigator view: list (Keynote's navigator), grid (light table) or hidden; and notes shown or not
  const setNav = (mode) => {
    body.classList.toggle('nav-hidden', mode === 'hidden');
    body.classList.toggle('nav-grid', mode === 'grid');
    const on = document.querySelector('#strip .thumb.on');
    if (on) on.scrollIntoView({ block: 'nearest' });
    dispatchEvent(new Event('resize')); // the viewer refits the slide to the room it now has
  };
  document.addEventListener('click', (e) => { // in the light table, a pick goes back to the canvas
    if (!body.classList.contains('nav-grid')) return;
    if (e.target.closest && e.target.closest('.thumb')) { setNav('list'); post({ type: 'deck-nav', mode: 'list' }); }
  });
  // shortcuts the page registered (deck-shell.js registerShortcut) also work while the frame has focus
  let keys = new Set();
  const comboOf = (e) => {
    const k = e.key && e.key.length === 1 ? e.key.toUpperCase() : e.key;
    return `${e.metaKey || e.ctrlKey ? 'Mod+' : ''}${e.altKey ? 'Alt+' : ''}${e.shiftKey ? 'Shift+' : ''}${e.code && /^Key[A-Z]$/.test(e.code) ? e.code.slice(3) : e.code && /^Digit\d$/.test(e.code) ? e.code.slice(5) : k}`;
  };
  document.addEventListener('keydown', (e) => {
    if (!keys.size || !body.classList.contains('mode-edit')) return;
    const typing = e.target && e.target.isContentEditable;
    if (typing && !(e.metaKey || e.ctrlKey)) return; // typed letters stay text
    if (typing && !/Mac|iPhone|iPad/.test(navigator.platform || '') && e.ctrlKey && e.altKey && e.getModifierState && e.getModifierState('AltGraph')) return; // AltGr letters (ń, €) are typed
    const c = comboOf(e);
    if (!keys.has(c)) return;
    e.preventDefault(); e.stopPropagation();
    post({ type: 'deck-key', combo: c });
  }, true);
  window.addEventListener('message', (e) => {
    if (e.source !== window.parent) return;
    const m = e.data || {};
    if (m.type === 'deck-nav' && ['list', 'grid', 'hidden'].includes(m.mode)) setNav(m.mode);
    else if (m.type === 'deck-notes') { body.classList.toggle('notes-hidden', m.show === false); dispatchEvent(new Event('resize')); }
    else if (m.type === 'deck-keys' && Array.isArray(m.keys)) keys = new Set(m.keys.filter((x) => typeof x === 'string' && x.length < 40).slice(0, 80));
    else if (m.type === 'deck-thumbs-sel' && Array.isArray(m.ks)) { const set = new Set(m.ks.filter(Number.isInteger)); document.querySelectorAll('#strip .thumb').forEach((t, j) => t.classList.toggle('sel', set.has(j))); }
  });
}
