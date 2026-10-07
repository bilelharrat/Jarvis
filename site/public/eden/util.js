// Small DOM and formatting helpers. Everything that puts text on the page goes through
// textContent (el, text) — never innerHTML with data.

export const $ = (id) => document.getElementById(id);
export const qs = (sel, root = document) => root.querySelector(sel);
export const qsa = (sel, root = document) => [...root.querySelectorAll(sel)];

/** el('div', 'cls', 'text') or el('div', { class, title, ... }, ...children) */
export function el(tag, attrs, ...kids) {
  const n = document.createElement(tag);
  if (typeof attrs === 'string') { if (attrs) n.className = attrs; }
  else if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v === undefined || v === null || v === false) continue;
      if (k === 'class') n.className = v;
      else if (k === 'text') n.textContent = v;
      else if (k === 'style' && typeof v === 'object') {
        // Custom properties (--n, --c) only take through setProperty; Object.assign drops them.
        for (const [p, x] of Object.entries(v)) {
          if (x === undefined || x === null) continue;
          if (p.startsWith('--')) n.style.setProperty(p, String(x));
          else n.style[p] = x;
        }
      }
      else if (k.startsWith('on') && typeof v === 'function') n.addEventListener(k.slice(2), v);
      else if (k === 'dataset') Object.assign(n.dataset, v);
      else n.setAttribute(k, v === true ? '' : String(v));
    }
  }
  for (const k of kids.flat()) {
    if (k === undefined || k === null || k === false) continue;
    n.append(k instanceof Node ? k : document.createTextNode(String(k)));
  }
  return n;
}

const SVG_NS = 'http://www.w3.org/2000/svg';
export function svgEl(tag, attrs = {}) {
  const n = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v !== undefined && v !== null) n.setAttribute(k, String(v));
  return n;
}
/** An Atelier sprite icon: <svg class="ic"><use href="#i-name"/></svg> */
export function ico(name, size, cls = '') {
  const s = svgEl('svg', { class: `ic ${cls}`.trim(), 'aria-hidden': 'true' });
  if (size) { s.style.width = `${size}px`; s.style.height = `${size}px`; }
  s.append(svgEl('use', { href: `#i-${name}` }));
  return s;
}

export function uid(prefix = '') {
  const a = new Uint8Array(8);
  crypto.getRandomValues(a);
  return prefix + [...a].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function fmtCost(n, { notional } = {}) {
  if (n === undefined || n === null || Number.isNaN(n)) return '—';
  const v = Number(n);
  let s;
  if (v === 0) s = '$0';
  else if (v < 0.001) s = '<$0.001';
  else if (v < 0.1) s = `$${v.toFixed(3)}`;
  else if (v < 100) s = `$${v.toFixed(2)}`;
  else s = `$${Math.round(v)}`;
  return notional ? `${s}*` : s;
}
/**
 * The route's confidence as a whole percent. The router sends 0–100 (an integer:
 * src/router.ts), which the page multiplied by 100 again ("conf. 5600%"); a fraction
 * (0.82, as the mock sends) is still read as one. null when there's none.
 */
export function confidencePct(x) {
  if (typeof x !== 'number' || !Number.isFinite(x)) return null;
  const pct = !Number.isInteger(x) && x > 0 && x < 1 ? x * 100 : x;
  return Math.round(Math.min(100, Math.max(0, pct)));
}
export function fmtTokens(n) {
  if (!n) return '0';
  if (n >= 1e6) return `${+(n / 1e6).toFixed(n % 1e6 ? 2 : 0)}M`;
  if (n >= 1e3) return `${+(n / 1e3).toFixed(n >= 1e5 ? 0 : 1)}k`;
  return String(n);
}
export function sizeText(n) { return n < 1024 ? `${n} B` : n < 1_048_576 ? `${Math.round(n / 1024)} KB` : `${(n / 1_048_576).toFixed(1)} MB`; }

export const EFFORT_LABEL = { none: 'no thinking', minimal: 'minimal thinking', low: 'low effort', medium: 'medium effort', high: 'high effort', xhigh: 'extra-high effort', max: 'max effort' };
export const EFFORT_SHORT = { none: 'None', minimal: 'Minimal', low: 'Low', medium: 'Medium', high: 'High', xhigh: 'Extra high', max: 'Max' };
export function effortLabel(e) { return EFFORT_LABEL[e] || (e ? `${e} effort` : ''); }

export function shortModel(name) {
  return String(name || '').replace(/^Claude /, '').replace(/ \(preview\)$/, '');
}

let toastT;
export function toast(msg, action) {
  const t = $('toast');
  t.replaceChildren(document.createTextNode(msg));
  if (action) t.append(el('button', { type: 'button', onclick: () => { t.classList.remove('show'); action.run(); } }, action.label));
  t.classList.add('show');
  clearTimeout(toastT);
  toastT = setTimeout(() => t.classList.remove('show'), action ? 5000 : 2600);
}

export const store = {
  get(key, fallback) {
    try { const v = localStorage.getItem(key); return v === null ? fallback : JSON.parse(v); } catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); return true; } catch { return false; }
  },
  del(key) { try { localStorage.removeItem(key); } catch { /* private mode */ } },
};

export async function copyText(text) {
  try { await navigator.clipboard.writeText(text); toast('Copied'); return true; }
  catch {
    const ta = el('textarea', { style: { position: 'fixed', opacity: '0' } });
    ta.value = text;
    document.body.append(ta); ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch { ok = false; }
    ta.remove();
    toast(ok ? 'Copied' : 'Couldn’t copy');
    return ok;
  }
}

export function download(name, text, type = 'text/markdown') {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = el('a', { href: url, download: name });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

export function debounce(fn, ms) {
  let t;
  const d = (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
  d.cancel = () => clearTimeout(t);
  return d;
}

export function relDay(ts) {
  const d = new Date(ts), now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  if (ts >= start) return 'Today';
  if (ts >= start - 864e5) return 'Yesterday';
  if (ts >= start - 7 * 864e5) return 'Previous 7 days';
  return d.getFullYear() === now.getFullYear() ? 'Earlier' : String(d.getFullYear());
}

export const isMobile = () => matchMedia('(max-width:640px)').matches;
/** A touch screen (no hover, or a finger as the main pointer): keyboard hints mean nothing there.
 *  Not while Eden's iPad app has a hardware keyboard attached (the app marks the page .eden-kbd). */
export const isTouch = () => !(typeof document !== 'undefined' && document.documentElement.classList.contains('eden-kbd'))
  && matchMedia('(hover:none), (pointer:coarse)').matches;
const KEY_HINT = /\s*\((?:[^()]*?(?:[⌘⇧⌥⇥⏎↵]|\bEsc\b))[^()]*\)|\s*·?\s*\bEsc stops\b/g;
/** Text without its keyboard hints ("(⇧Tab)", "(⌘⇧I)", "Esc stops") on a touch screen; unchanged elsewhere. */
export function noKeys(text, touch = isTouch()) {
  return touch ? String(text).replace(KEY_HINT, '').replace(/\s+([.,;:])/g, '$1') : text;
}
export const isNarrow = () => matchMedia('(max-width:1100px)').matches;

/** Position a fixed popup next to an anchor (Jarvis Code's placePopup). */
export function placePopup(pop, anchor, side) {
  const r = anchor.getBoundingClientRect();
  const w = pop.offsetWidth, h = pop.offsetHeight;
  let left, top;
  if (side === 'right') {
    left = r.right + 4 + w > window.innerWidth - 8 ? r.left - w - 4 : r.right + 4;
    top = Math.min(window.innerHeight - h - 8, r.top - 6);
  } else if (side === 'below') {
    left = Math.min(window.innerWidth - w - 8, Math.max(8, r.left));
    top = r.bottom + 8 + h > window.innerHeight - 8 && r.top - h - 8 >= 8 ? r.top - h - 8 : r.bottom + 8;
  } else {
    left = Math.min(window.innerWidth - w - 8, Math.max(8, r.left + r.width / 2 > window.innerWidth / 2 ? r.right - w : r.left));
    top = r.top - h - 8 >= 8 && (r.bottom + 8 + h > window.innerHeight - 8 || r.top > window.innerHeight / 2) ? r.top - h - 8 : r.bottom + 8;
  }
  pop.style.left = `${Math.max(8, left)}px`;
  pop.style.top = `${Math.max(8, top)}px`;
}

/** Same seg control logic everywhere: thumb + .on + aria. */
export function setSeg(seg, i) {
  const thumb = seg.querySelector('.seg-thumb');
  if (thumb) thumb.style.setProperty('--i', i);
  [...seg.querySelectorAll('button')].forEach((b, j) => {
    b.classList.toggle('on', j === i);
    if (b.getAttribute('role') === 'tab') b.setAttribute('aria-selected', String(j === i));
    if (b.getAttribute('role') === 'radio') b.setAttribute('aria-checked', String(j === i));
  });
}
