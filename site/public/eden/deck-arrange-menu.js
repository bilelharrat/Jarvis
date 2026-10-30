// The slide editor's right-click menu (web only): the one menu drawn for thumbnails, the slide, text and free
// elements, in the slide sorter too. Its items come from deck-shell.js (registerContextMenu: the shell's own, the
// arranging items in deck-arrange.js, Eden's AI items…), so features add items there, never here.
// Items: { label, icon, shortcut, run(ctx), disabled, checked, danger, items: [...] (a submenu) } | { separator } | { heading }.
// Keyboard-first: ↑ ↓ Home End move, → opens a submenu, ← closes it, Enter/Space choose, Escape closes and puts focus
// back where it was, a letter jumps to the next item starting with it.

import { el } from './util.js';
import { t as tx } from './i18n.js';
import { icon, formatKeys } from './deck-shell.js';

let open = null; // { root, close }
export const menuOpen = () => !!open;
export function closeMenu({ restore = true } = {}) { if (open) open.close(restore); }

/** Tidy a list: no separator first, last or twice in a row; a heading needs an item after it. */
export function tidy(list) {
  const out = [];
  for (const it of (list || []).filter(Boolean)) {
    if (it.separator) { if (out.length && !out.at(-1).separator) out.push(it); continue; }
    if (it.heading && out.length && out.at(-1).heading) out.pop();
    out.push(it);
  }
  while (out.length && (out.at(-1).separator || out.at(-1).heading)) out.pop();
  return out;
}

/** The menu at (x, y) in the page; `ctx` goes to each item's run; `back` gets focus when it closes. → false when empty. */
export function openContextMenu(items, x, y, { ctx = {}, back = null, keyboard = false, label = tx('Actions') } = {}) {
  closeMenu({ restore: false });
  const list = tidy(items);
  if (!list.some((it) => it.label)) return false;
  cssOnce();
  const layer = el('div', { class: 'dk-menu-layer' });
  const stack = [];
  const close = (restore = true) => {
    if (!open || open.root !== layer) return;
    open = null;
    layer.remove();
    removeEventListener('resize', onWin, true); removeEventListener('blur', onWin); document.removeEventListener('scroll', onWin, true);
    if (restore && back && back.isConnected) back.focus({ preventScroll: true });
  };
  const onWin = (e) => { if (e.type === 'scroll' && layer.contains(e.target)) return; close(e.type !== 'blur'); };
  const run = (it) => { close(true); setTimeout(() => { try { it.run(ctx); } catch (err) { console.error(err); } }, 0); };
  function menu(entries, px, py, name, parentItem) {
    const m = el('div', { class: 'dk-menu', role: 'menu', 'aria-label': name, tabindex: '-1' });
    for (const it of tidy(entries)) {
      if (it.separator) { m.append(el('div', { class: 'dk-sep', role: 'separator' })); continue; }
      if (it.heading) { m.append(el('div', { class: 'dk-head', role: 'presentation' }, it.heading)); continue; }
      const sub = Array.isArray(it.items) && it.items.length;
      const b = el('button', { type: 'button', class: `dk-item${it.danger ? ' dk-danger' : ''}`, role: it.checked === undefined ? 'menuitem' : 'menuitemcheckbox', tabindex: '-1',
        'aria-disabled': it.disabled ? 'true' : null, 'aria-haspopup': sub ? 'menu' : null, 'aria-expanded': sub ? 'false' : null,
        'aria-checked': it.checked === undefined ? null : String(!!it.checked) },
      el('span', { class: 'dk-ic', 'aria-hidden': 'true' }, it.checked ? icon('check', 14) : it.icon ? icon(it.icon, 15) : null), el('span', { class: 'dk-label' }, it.label),
      it.shortcut ? el('kbd', { class: 'dk-key' }, formatKeys(it.shortcut)) : null, sub ? el('span', { class: 'dk-key', 'aria-hidden': 'true' }, '›') : null);
      b.addEventListener('click', (e) => { e.stopPropagation(); if (it.disabled) return; if (sub) openSub(b, it); else if (it.run) run(it); });
      b.addEventListener('pointerenter', () => { b.focus({ preventScroll: true }); if (sub && !it.disabled) openSub(b, it, false); else trim(m); });
      b._item = it;
      m.append(b);
    }
    m.addEventListener('keydown', (e) => keys(e, m));
    m._parent = parentItem || null;
    layer.append(m);
    const r = m.getBoundingClientRect(); // keep it on screen
    m.style.left = `${Math.max(4, Math.min(px, innerWidth - r.width - 4))}px`;
    m.style.top = `${Math.max(4, Math.min(py, innerHeight - r.height - 4))}px`;
    stack.push(m);
    return m;
  }
  function trim(m) { while (stack.length && stack.at(-1) !== m) { const s = stack.pop(); if (s._parent) s._parent.setAttribute('aria-expanded', 'false'); s.remove(); } }
  function openSub(b, it, focus = true) {
    const m = b.closest('.dk-menu');
    trim(m);
    b.setAttribute('aria-expanded', 'true');
    const r = b.getBoundingClientRect();
    const s = menu(it.items, r.right - 2, r.top - 4, it.label, b);
    if (r.right + s.offsetWidth > innerWidth) s.style.left = `${Math.max(4, r.left - s.offsetWidth + 2)}px`;
    if (focus) first(s);
  }
  const usable = (m) => [...m.querySelectorAll(':scope > .dk-item')];
  const first = (m) => { const b = usable(m).find((x) => x.getAttribute('aria-disabled') !== 'true') || usable(m)[0]; if (b) b.focus({ preventScroll: true }); };
  function keys(e, m) {
    const all = usable(m), at = all.indexOf(document.activeElement);
    const step = (d) => { if (!all.length) return; let k = at; for (let n = 0; n < all.length; n++) { k = (k + d + all.length) % all.length; if (all[k].getAttribute('aria-disabled') !== 'true') break; } all[k].focus({ preventScroll: true }); };
    const b = all[at];
    if (e.key === 'ArrowDown') { e.preventDefault(); step(1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); step(-1); }
    else if (e.key === 'Home') { e.preventDefault(); if (all[0]) all[0].focus(); }
    else if (e.key === 'End') { e.preventDefault(); if (all.length) all.at(-1).focus(); }
    else if (e.key === 'ArrowRight' && b && b._item.items) { e.preventDefault(); if (!b._item.disabled) openSub(b, b._item); }
    else if ((e.key === 'ArrowLeft' || e.key === 'Escape') && m._parent) { e.preventDefault(); e.stopPropagation(); const p = m._parent; trim(p.closest('.dk-menu')); p.focus(); }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(true); }
    else if (e.key === 'Tab') { e.preventDefault(); close(true); }
    else if ((e.key === 'Enter' || e.key === ' ') && b) { e.preventDefault(); b.click(); }
    else if (e.key.length === 1 && /\S/.test(e.key) && !e.metaKey && !e.ctrlKey) {
      const ch = e.key.toLowerCase();
      const order = [...all.slice(at + 1), ...all.slice(0, at + 1)];
      const hit = order.find((x) => (x.querySelector('.dk-label').textContent || '').trim().toLowerCase().startsWith(ch));
      if (hit) { e.preventDefault(); hit.focus(); }
    }
  }
  layer.addEventListener('pointerdown', (e) => { if (e.target === layer) { e.preventDefault(); close(true); } });
  layer.addEventListener('contextmenu', (e) => { e.preventDefault(); if (e.target === layer) close(true); });
  document.body.append(layer);
  open = { root: layer, close };
  const m = menu(list, x, y, label);
  addEventListener('resize', onWin, true); addEventListener('blur', onWin); document.addEventListener('scroll', onWin, true);
  if (keyboard) first(m); else m.focus({ preventScroll: true });
  return true;
}

let styled = false;
function cssOnce() {
  if (styled || typeof document === 'undefined') return;
  styled = true;
  document.head.append(el('style', { id: 'dk-menu-css' }, `
.dk-menu-layer{position:fixed;inset:0;z-index:2147483000}
.dk-menu{position:fixed;min-width:220px;max-width:min(320px,calc(100vw - 8px));max-height:calc(100vh - 8px);overflow:auto;padding:5px;border-radius:12px;background:var(--glass2,rgba(250,250,252,.92));-webkit-backdrop-filter:blur(30px) saturate(180%);backdrop-filter:blur(30px) saturate(180%);border:.5px solid var(--hairline,rgba(0,0,0,.08));box-shadow:0 2px 6px rgba(0,0,0,.1),0 24px 64px rgba(0,0,0,.16);color:var(--text,#1d1d1f);font:13px/1.2 -apple-system,BlinkMacSystemFont,system-ui,sans-serif;outline:none}
.dk-item{display:flex;align-items:center;gap:6px;width:100%;min-height:28px;padding:4px 10px 4px 6px;border:0;border-radius:6px;background:none;color:inherit;font:inherit;text-align:left;cursor:default}
.dk-item:focus{outline:none;background:var(--accent,#0a84ff);color:#fff}
.dk-item:focus-visible{outline:2px solid var(--accent,#0a84ff);outline-offset:1px}
.dk-item[aria-disabled="true"]{opacity:.45}
.dk-item[aria-disabled="true"]:focus{background:rgba(127,127,127,.18);color:inherit}
.dk-danger{color:#d70015}:root[data-theme="dark"] .dk-danger:not(:focus),.dark .dk-danger:not(:focus){color:#ff6961}@media (prefers-color-scheme:dark){:root:not([data-theme="light"]) .dk-danger:not(:focus){color:#ff6961}}.dk-danger:focus{background:#ff3b30;color:#fff}
.dk-ic{width:16px;flex:none;display:inline-flex;justify-content:center}
.dk-label{flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dk-key{opacity:.6;font:inherit;font-size:12px;flex:none}
.dk-head{padding:6px 10px 2px 28px;font-size:11px;font-weight:600;color:var(--text2,#6e6e73)}
.dk-sep{height:.5px;margin:4px 8px;background:var(--hairline,rgba(0,0,0,.12))}
@media (pointer:coarse){.dk-item{min-height:44px}}`));
}
