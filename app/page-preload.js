// Runs inside every page of J.A.R.V.I.S.'s built-in browser, in an isolated world: the
// page's own scripts can't see it or reach the app through it. It is J.A.R.V.I.S.'s hand
// in the page:
// - draws the hand cursor, lights up what it's aiming at (snapping to the nearest thing
//   you can open, so you needn't be precise) and says what a pinch will do;
// - turns a pinch into a real click (the main process sends it; direct mouse and
//   keyboard input is blocked there), a pinch-and-move into scrolling that coasts;
// - asks for a second pinch before anything that starts a run, sends, posts or deletes;
// - on the BSH Research Center (only J.A.R.V.I.S. drives it) blocks the trackpad, wheel
//   and keys, which the main process can't all stop;
// - answers J.A.R.V.I.S.'s voice commands: find and press, read, scroll, the search box.

const { contextBridge, ipcRenderer, webFrame } = require('electron');

const CLICKABLE = [
  'a[href]', 'button', 'summary', 'select', 'textarea', 'label[for]',
  'input:not([type="hidden"])', '[role="button"]', '[role="tab"]', '[role="link"]',
  '[role="menuitem"]', '[role="option"]', '[role="switch"]', '[role="checkbox"]',
  '[role="radio"]', '[role="row"][tabindex]', '[onclick]', '[tabindex]:not([tabindex="-1"])',
].join(',');
// Anything that spends money, changes data or reaches other people needs a second pinch
// (or, by voice, a yes).
const RISKY = /\b(generate|regenerate|run|rerun|start|launch|create|delete|remove|erase|archive|discard|send|post|publish|submit|share|invite|buy|sell|trade|order|pay|purchase|checkout|transfer|sign ?out|log ?out|approve|reject|revoke|disconnect|upload|import|reset|clear|confirm|accept|agree|deactivate|promote|demote|ban|block)\b/i;
const MAGNET = [10, 20, 32]; // px rings searched around the cursor for something to snap to
const STICK = 14; // px outside the lit element before another can take over
const CONFIRM_MS = 4000;
const SCROLL_GAIN = 1.6; // the page moves a little further than the hand

let locked = false; // the main process says when (the Research Center's own pages)
let typing = false; // true only while J.A.R.V.I.S. itself fills in the search box
let ui = null;
let hover = null; // the element lit under the cursor
let latch = null; // what the current pinch will open
let scroller = null; // what the current pinch-and-move scrolls
let pending = null; // { el, at } waiting for a second pinch
let coast = 0;
let lastPointer = { x: -1, y: -1 };
let cursorAt = { x: 0, y: 0 };
let movedAt = 0; // when the hand last moved the cursor (what it's on is "this" for a while)

// ── the overlay ──

const STYLE = `
:host { all: initial; }
.layer { position: fixed; inset: 0; pointer-events: none; z-index: 2147483647; font: 600 13px -apple-system, BlinkMacSystemFont, "SF Pro Text", sans-serif; }
.cursor { position: absolute; left: 0; top: 0; width: 30px; height: 30px; margin: -15px 0 0 -15px; border-radius: 50%;
  border: 2px solid #4fd3ff; box-shadow: 0 0 16px rgba(79, 211, 255, .75), inset 0 0 8px rgba(79, 211, 255, .4);
  background: rgba(79, 211, 255, .08); transition: transform 45ms linear, width 120ms, height 120ms, margin 120ms, background 120ms, border-color 120ms; }
.cursor::after { content: ""; position: absolute; left: 50%; top: 50%; width: 5px; height: 5px; margin: -2.5px 0 0 -2.5px; border-radius: 50%; background: #e6f8ff; }
.cursor[data-mode="pinch"] { width: 22px; height: 22px; margin: -11px 0 0 -11px; background: rgba(79, 211, 255, .45); border-color: #e6f8ff; }
.cursor[data-mode="drag"] { width: 40px; height: 40px; margin: -20px 0 0 -20px; border-style: dashed; background: rgba(79, 211, 255, .14); }
.cursor[data-mode="fist"] { border-color: #f0a458; box-shadow: 0 0 16px rgba(240, 164, 88, .75); background: rgba(240, 164, 88, .12); }
.cursor[hidden], .ring[hidden], .pill[hidden] { display: none; }
.ring { position: absolute; left: 0; top: 0; border-radius: 10px; border: 2px solid #4fd3ff;
  box-shadow: 0 0 0 4px rgba(79, 211, 255, .16), 0 0 22px rgba(79, 211, 255, .45);
  transition: transform 90ms ease-out, width 90ms ease-out, height 90ms ease-out, border-color 120ms; }
.ring.risky { border-color: #f0a458; box-shadow: 0 0 0 4px rgba(240, 164, 88, .18), 0 0 22px rgba(240, 164, 88, .5); }
.ring.flash { animation: flash 650ms ease-out; }
@keyframes flash { 0% { box-shadow: 0 0 0 0 rgba(79, 211, 255, .9); } 100% { box-shadow: 0 0 0 16px rgba(79, 211, 255, 0); } }
.pill { position: absolute; left: 0; top: 0; max-width: 340px; padding: 6px 11px; border-radius: 999px; white-space: nowrap;
  overflow: hidden; text-overflow: ellipsis; color: #eaf8ff; background: rgba(6, 16, 28, .9);
  border: 1px solid rgba(79, 211, 255, .55); box-shadow: 0 6px 20px rgba(0, 0, 0, .3); transition: transform 90ms ease-out; }
.pill.risky { border-color: rgba(240, 164, 88, .8); color: #ffe6c7; }
.edge { position: absolute; inset: 0; box-shadow: inset 0 0 0 1px rgba(79, 211, 255, .35); border-radius: 2px; }
.edge[hidden] { display: none; }
`;

function overlay() {
  if (ui) return ui;
  const root = document.documentElement;
  if (!root) return null;
  const host = document.createElement('jarvis-hand');
  host.setAttribute('aria-hidden', 'true');
  host.style.cssText = 'all: initial; position: fixed; inset: 0; pointer-events: none; z-index: 2147483647;';
  const shadow = host.attachShadow({ mode: 'closed' });
  shadow.innerHTML = `<style>${STYLE}</style><div class="layer"><div class="edge"></div>`
    + '<div class="ring" hidden></div><div class="pill" hidden></div><div class="cursor" hidden></div></div>';
  root.appendChild(host);
  ui = {
    host,
    edge: shadow.querySelector('.edge'),
    ring: shadow.querySelector('.ring'),
    pill: shadow.querySelector('.pill'),
    cursor: shadow.querySelector('.cursor'),
  };
  ui.edge.hidden = !locked;
  // A page that rebuilds <html>'s children drops the overlay: put it back.
  new MutationObserver(() => { if (!host.isConnected) document.documentElement.appendChild(host); })
    .observe(root, { childList: true });
  return ui;
}

function labelOf(el) {
  const text = el.getAttribute('aria-label') || el.innerText || el.value || el.title || el.getAttribute('placeholder') || '';
  const clean = String(text).replace(/\s+/g, ' ').trim();
  if (clean) return clean.length > 48 ? `${clean.slice(0, 47)}…` : clean;
  return el.getAttribute('role') || el.tagName.toLowerCase();
}

function risky(el) {
  if (el.matches('a[href]') && !el.matches('[role="button"]')) return false; // links go places
  return RISKY.test(labelOf(el)) || (el.matches('button[type="submit"], input[type="submit"]') && !!el.form);
}

function usable(el) {
  if (!el || el === document.body || el === document.documentElement) return false;
  if (el.disabled || el.getAttribute('aria-disabled') === 'true') return false;
  const r = el.getBoundingClientRect();
  if (r.width < 2 || r.height < 2) return false;
  // A clickable wrapping most of the page would swallow every aim.
  return r.width * r.height < window.innerWidth * window.innerHeight * 0.45;
}

function clickableAt(x, y) {
  const hit = document.elementFromPoint(x, y);
  const el = hit && hit.closest ? hit.closest(CLICKABLE) : null;
  return usable(el) ? el : null;
}

function distance(x, y, r) {
  const dx = Math.max(r.left - x, 0, x - r.right);
  const dy = Math.max(r.top - y, 0, y - r.bottom);
  return Math.hypot(dx, dy);
}

// What the cursor at (x, y) is on: the thing under it, else the nearest thing within a
// few rings of it; the lit element keeps the light until the cursor is clearly off it.
function targetAt(x, y) {
  if (hover && hover.isConnected && distance(x, y, hover.getBoundingClientRect()) <= STICK && usable(hover)) {
    const direct = clickableAt(x, y);
    return direct && direct !== hover && !hover.contains(direct) ? direct : hover;
  }
  const direct = clickableAt(x, y);
  if (direct) return direct;
  let best = null, bestD = Infinity;
  for (const r of MAGNET) {
    for (let i = 0; i < 8; i += 1) {
      const a = (i * Math.PI) / 4;
      const el = clickableAt(x + r * Math.cos(a), y + r * Math.sin(a));
      if (!el) continue;
      const d = distance(x, y, el.getBoundingClientRect());
      if (d < bestD) { best = el; bestD = d; }
    }
    if (best) break;
  }
  return best;
}

function place(el, extra = '') {
  const u = overlay();
  if (!u) return;
  if (!el) { u.ring.hidden = true; u.pill.hidden = true; return; }
  const r = el.getBoundingClientRect();
  const pad = 4;
  u.ring.hidden = false;
  u.ring.className = `ring${risky(el) ? ' risky' : ''}${extra}`;
  u.ring.style.width = `${r.width + pad * 2}px`;
  u.ring.style.height = `${r.height + pad * 2}px`;
  u.ring.style.transform = `translate(${r.left - pad}px, ${r.top - pad}px)`;
  const waiting = pending && pending.el === el && Date.now() - pending.at < CONFIRM_MS;
  u.pill.textContent = waiting ? `Pinch again to confirm “${labelOf(el)}”` : risky(el) ? `“${labelOf(el)}” needs a second pinch` : labelOf(el);
  u.pill.className = `pill${risky(el) ? ' risky' : ''}`;
  u.pill.hidden = false;
  const above = r.top > 44;
  const px = Math.min(Math.max(8, r.left), window.innerWidth - 348);
  u.pill.style.transform = `translate(${px}px, ${above ? r.top - 38 : r.bottom + 10}px)`;
}

function report(el) {
  ipcRenderer.send('page:hover', el ? { label: labelOf(el), risky: risky(el) } : null);
}

function pointTo(x, y) {
  // The real (virtual) mouse follows, so the page shows its own hover states too.
  if (Math.abs(x - lastPointer.x) < 3 && Math.abs(y - lastPointer.y) < 3) return;
  lastPointer = { x, y };
  const z = webFrame.getZoomFactor();
  ipcRenderer.send('page:pointer', { x: Math.round(x * z), y: Math.round(y * z) });
}

function centerOf(el) {
  const r = el.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
}

function clickEl(el) {
  const c = centerOf(el);
  const z = webFrame.getZoomFactor();
  place(el, ' flash');
  ipcRenderer.send('page:click', { x: Math.round(c.x * z), y: Math.round(c.y * z) });
}

// ── scrolling ──

function scrollableFrom(node, axis = 'y') {
  for (let el = node; el && el !== document.documentElement; el = el.parentElement) {
    const style = getComputedStyle(el);
    const overflow = axis === 'y' ? style.overflowY : style.overflowX;
    const room = axis === 'y' ? el.scrollHeight - el.clientHeight : el.scrollWidth - el.clientWidth;
    if (/(auto|scroll|overlay)/.test(overflow) && room > 4) return el;
  }
  return document.scrollingElement || document.documentElement;
}

function mainScroller() {
  const probe = document.elementFromPoint(window.innerWidth * 0.55, window.innerHeight * 0.55);
  return scrollableFrom(probe, 'y');
}

function stopCoast() {
  if (coast) cancelAnimationFrame(coast);
  coast = 0;
}

function glide(el, vx, vy) {
  stopCoast();
  let last = performance.now();
  const frame = (now) => {
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    el.scrollBy(vx * dt, vy * dt);
    const decay = Math.pow(0.04, dt); // about a second to settle
    vx *= decay;
    vy *= decay;
    coast = Math.hypot(vx, vy) > 25 ? requestAnimationFrame(frame) : 0;
  };
  coast = requestAnimationFrame(frame);
}

// ── hands ──

function onHand(msg) {
  const u = overlay();
  if (!u) return;
  const x = Math.round(msg.x * window.innerWidth);
  const y = Math.round(msg.y * window.innerHeight);
  switch (msg.t) {
    case 'move': {
      cursorAt = { x, y };
      movedAt = Date.now();
      u.cursor.hidden = false;
      u.cursor.dataset.mode = msg.mode || 'aim';
      u.cursor.style.transform = `translate(${x}px, ${y}px)`;
      if (msg.mode === 'drag') return; // the page is moving under a held pinch
      const el = targetAt(x, y);
      if (el !== hover) {
        hover = el;
        report(el);
      }
      place(el);
      const aim = el ? centerOf(el) : { x, y };
      pointTo(aim.x, aim.y);
      return;
    }
    case 'press':
      stopCoast();
      latch = targetAt(x, y);
      scroller = null;
      return;
    case 'drag': {
      if (!scroller) scroller = scrollableFrom(document.elementFromPoint(cursorAt.x, cursorAt.y), 'y');
      latch = null; // a pinch that moved is a scroll, not a click
      scroller.scrollBy(-msg.dx * window.innerWidth * SCROLL_GAIN, -msg.dy * window.innerHeight * SCROLL_GAIN);
      return;
    }
    case 'release': {
      if (msg.tap && latch && latch.isConnected) {
        if (!risky(latch) || (pending && pending.el === latch && Date.now() - pending.at < CONFIRM_MS)) {
          pending = null;
          clickEl(latch);
          ipcRenderer.send('page:note', { text: `Opened “${labelOf(latch)}”` });
        } else {
          pending = { el: latch, at: Date.now() };
          place(latch);
          ipcRenderer.send('page:note', { text: `Pinch again to confirm “${labelOf(latch)}”` });
        }
      } else if (scroller && Math.hypot(msg.vx, msg.vy) > 0.3) {
        glide(scroller, -msg.vx * window.innerWidth * SCROLL_GAIN, -msg.vy * window.innerHeight * SCROLL_GAIN);
      }
      latch = null;
      scroller = null;
      return;
    }
    case 'hide':
      u.cursor.hidden = true;
      if (hover) { hover = null; report(null); }
      place(null);
      return;
    default:
  }
}

// ── voice commands ──

function visible(el) {
  const r = el.getBoundingClientRect();
  if (r.width < 2 || r.height < 2) return false;
  const style = getComputedStyle(el);
  return style.visibility !== 'hidden' && style.display !== 'none' && Number(style.opacity) > 0.05;
}

function inView(el) {
  const r = el.getBoundingClientRect();
  return r.bottom > 0 && r.top < window.innerHeight && r.right > 0 && r.left < window.innerWidth;
}

function find(text) {
  const want = String(text || '').replace(/\s+/g, ' ').trim().toLowerCase();
  if (!want) return null;
  const pool = [...document.querySelectorAll(CLICKABLE)].filter((el) => visible(el) && usable(el));
  const score = (el) => {
    const label = labelOf(el).toLowerCase();
    if (label === want) return 0;
    if (label.startsWith(want)) return 1;
    if (new RegExp(`\\b${want.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(label)) return 2;
    if (label.includes(want)) return 3;
    return 9;
  };
  let best = null, bestScore = 9;
  for (const el of pool) {
    const s = score(el) + (inView(el) ? 0 : 0.5);
    if (s < bestScore) { best = el; bestScore = s; }
  }
  return best;
}

// ── the fuller read JARVIS's and Jarvis Code's browser_read ask for (rich) ──
// What <main> leaves out: an open dialog, an alert or toast, a fixed banner or drawer, a
// sidebar (an order summary with the total). Each goes ahead of <main>'s text, labelled.
const REGIONS = [
  ['Dialog', 'dialog[open], [role="dialog"], [role="alertdialog"], [aria-modal="true"], [popover]:popover-open'],
  ['Alert', '[role="alert"], [role="status"], [aria-live="assertive"], [aria-live="polite"], output'],
  ['Sidebar', 'aside, [role="complementary"]'],
];
const REGION_MAX = 3000;
const REGIONS_MAX = 8000;
const SECRET_FIELD = /(pass(word|code|phrase)?|\bpin\b|cvv|cvc|csc|security.?code|card.?(number|no)|cc-|one.?time|otp|2fa|verification.?code|\bssn\b|social.?security|iban|routing|account.?number)/i;

const squash = (text, max) => String(text || '').replace(/\s+/g, ' ').trim().slice(0, max);

function regionName(el) {
  const by = (el.getAttribute('aria-labelledby') || '').split(/\s+/).filter(Boolean)
    .map((id) => { const n = document.getElementById(id); return n ? n.innerText : ''; }).join(' ');
  const heading = el.querySelector('h1, h2, h3, h4, legend, [role="heading"]');
  return squash(by || el.getAttribute('aria-label') || (heading && heading.innerText) || '', 80);
}

// Fixed or sticky boxes near the top of the tree: cookie banners, drawers, sticky summaries.
function pinnedBoxes() {
  const found = [];
  const walk = (el, depth) => {
    for (const kid of el.children) {
      if (found.length >= 12 || kid.tagName === 'JARVIS-HAND' || kid.tagName === 'SCRIPT' || kid.tagName === 'STYLE') continue;
      const position = getComputedStyle(kid).position;
      if ((position === 'fixed' || position === 'sticky') && visible(kid) && inView(kid)) found.push(kid);
      else if (depth < 3) walk(kid, depth + 1);
    }
  };
  if (document.body) walk(document.body, 0);
  return found;
}

function regionsOutside(main) {
  const picked = [];
  const add = (kind, el) => {
    if (!el || el === main || main.contains(el) || el.closest('jarvis-hand') || !visible(el)) return;
    if (picked.some((p) => p.el.contains(el) || el.contains(p.el))) return;
    const text = squash(el.innerText, REGION_MAX);
    if (text) picked.push({ kind, el, text, name: regionName(el) });
  };
  for (const [kind, selector] of REGIONS) {
    let els = [];
    try { els = [...document.querySelectorAll(selector)]; } catch (_) { els = []; }
    for (const el of els.slice(0, 20)) add(kind, el);
  }
  for (const el of pinnedBoxes()) add('Banner', el);
  return picked.slice(0, 8);
}

// A form field's own label, as a screen reader says it: aria-labelledby, aria-label, its
// <label>, the legend of its group (for a radio or checkbox), its title.
function fieldLabel(f) {
  const by = (f.getAttribute('aria-labelledby') || '').split(/\s+/).filter(Boolean)
    .map((id) => { const n = document.getElementById(id); return n ? n.innerText : ''; }).join(' ');
  const labels = f.labels ? [...f.labels].map((l) => l.innerText).join(' ') : '';
  const fieldset = (f.type === 'radio' || f.type === 'checkbox') && f.closest('fieldset');
  const legend = fieldset && fieldset.querySelector('legend');
  return squash([legend ? legend.innerText : '', by || f.getAttribute('aria-label') || labels || f.title || ''].filter(Boolean).join(': '), 120);
}

function fieldError(f) {
  const id = f.getAttribute('aria-errormessage');
  if (f.getAttribute('aria-invalid') === 'true') {
    const n = id && document.getElementById(id);
    const described = (f.getAttribute('aria-describedby') || '').split(/\s+/).filter(Boolean)
      .map((d) => { const x = document.getElementById(d); return x ? x.innerText : ''; }).join(' ');
    return squash((n && n.innerText) || described || 'invalid', 160);
  }
  try { if (f.matches(':user-invalid')) return squash(f.validationMessage || 'invalid', 160); } catch (_) { /* older engine */ }
  return '';
}

function richField(f) {
  const tag = f.tagName.toLowerCase();
  const type = String(f.type || '').toLowerCase();
  const label = fieldLabel(f);
  const out = {
    tag, type, name: f.name || '', id: f.id || '', label: label || labelOf(f),
    placeholder: f.getAttribute('placeholder') || '', autocomplete: f.getAttribute('autocomplete') || '',
  };
  const secret = type === 'password' || SECRET_FIELD.test(`${label} ${out.name} ${out.id} ${out.autocomplete} ${out.placeholder}`);
  if (type === 'checkbox' || type === 'radio') out.checked = Boolean(f.checked);
  else if (tag === 'select') {
    out.value = squash([...f.selectedOptions].map((o) => o.label).join(', '), 120);
    out.options = [...f.options].slice(0, 12).map((o) => squash(o.label, 40));
    if (f.options.length > 12) out.more = f.options.length - 12;
  } else if (typeof f.value === 'string' && f.value) out.value = secret ? '(hidden)' : squash(f.value, 120);
  if (f.required) out.required = true;
  if (f.disabled) out.disabled = true;
  const error = fieldError(f);
  if (error) out.error = error;
  return out;
}

function readPage(args = {}) {
  const main = document.querySelector('main') || mainScroller() || document.body;
  const links = [...document.querySelectorAll('a[href]')].filter(visible).slice(0, 40)
    .map((a) => ({ text: labelOf(a), href: a.href })).filter((l) => l.text);
  const fields = args.rich
    ? [...document.querySelectorAll('input:not([type="hidden"]), textarea, select')].filter(visible).slice(0, 40).map(richField)
    : [...document.querySelectorAll('input, textarea, select')].filter(visible).slice(0, 30)
      .map((f) => ({ tag: f.tagName.toLowerCase(), type: f.type || '', name: f.name || '', label: labelOf(f) }));
  const headings = [...document.querySelectorAll('h1, h2, h3')].filter(visible)
    .map((h) => h.innerText.replace(/\s+/g, ' ').trim()).filter(Boolean).slice(0, 30);
  const seen = new Set();
  const actions = [];
  for (const el of document.querySelectorAll(CLICKABLE)) {
    if (!visible(el) || !inView(el) || !usable(el)) continue;
    const label = labelOf(el);
    if (seen.has(label)) continue;
    seen.add(label);
    actions.push(label);
    if (actions.length >= 60) break;
  }
  const page = {
    title: document.title,
    url: location.href,
    path: location.pathname,
    headings,
    text: (main.innerText || '').slice(0, 14000),
    actions,
    links,
    fields,
    hovered: hover ? labelOf(hover) : '',
  };
  if (!args.rich) return page;
  // Dialogs, alerts, banners and sidebars first (a sidebar's total counts for the purchase
  // guard), then <main>; read on from offset past the limit.
  let budget = REGIONS_MAX;
  const regions = [];
  for (const r of regionsOutside(main)) {
    if (budget <= 0) break;
    const text = r.text.slice(0, budget);
    budget -= text.length;
    regions.push({ kind: r.kind, name: r.name, text });
  }
  const head = regions.map((r) => `[${r.kind}${r.name ? `: ${r.name}` : ''}]\n${r.text}`).join('\n\n');
  const full = `${head}${head ? '\n\n[Main content]\n' : ''}${main.innerText || ''}`.slice(0, 2_000_000);
  const offset = Math.max(0, Math.min(full.length, Number(args.offset) || 0));
  const limit = Math.max(1000, Math.min(120000, Number(args.limit) || 20000));
  return {
    ...page,
    text: full.slice(offset, offset + limit),
    offset,
    total: full.length,
    more: offset + limit < full.length,
    regions: regions.map((r) => ({ kind: r.kind, name: r.name })),
  };
}

function scrollPage({ direction = 'down', amount = 1 }) {
  const el = mainScroller();
  stopCoast();
  const page = el.clientHeight || window.innerHeight;
  if (direction === 'top') el.scrollTo({ top: 0, behavior: 'smooth' });
  else if (direction === 'bottom') el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
  else {
    const sign = direction === 'up' ? -1 : 1;
    el.scrollBy({ top: sign * page * 0.8 * Math.max(0.25, Math.min(5, Number(amount) || 1)), behavior: 'smooth' });
  }
  return { ok: true };
}

function searchBox() {
  return document.querySelector('.yf-search-input')
    || [...document.querySelectorAll('input[type="search"], input[placeholder*="earch" i]')].find(visible);
}

// Fill the page's search box and submit it, the way the app's own form expects (its
// v-model listens for input events; the form handles submit).
function search({ query }) {
  const input = searchBox();
  if (!input) return { ok: false, message: 'There is no search box on this page.' };
  input.scrollIntoView({ block: 'center' });
  input.focus();
  typing = true;
  try {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, String(query || ''));
    input.dispatchEvent(new Event('input', { bubbles: true }));
    if (input.form) input.form.requestSubmit();
    else input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
  } finally {
    typing = false;
  }
  return { ok: true };
}

async function navigate({ path }) {
  if (location.pathname + location.search === path) return { ok: true };
  // The app's router follows history changes; a full load is the fallback.
  history.pushState(null, '', path);
  window.dispatchEvent(new PopStateEvent('popstate', { state: null }));
  await new Promise((r) => setTimeout(r, 350));
  return { ok: location.pathname + location.search === path };
}

// ── find in page (⌘F): every match highlighted, the current one brighter and in view ──
let findRanges = [];
let findAt = -1;
let findFor = '';
function findStyle() {
  if (document.getElementById('jarvis-find-style')) return;
  const style = document.createElement('style');
  style.id = 'jarvis-find-style';
  style.textContent = '::highlight(jarvis-find){background-color:rgba(255,213,0,.55);color:inherit}'
    + '::highlight(jarvis-find-now){background-color:#ff9632;color:#000}';
  (document.head || document.documentElement).append(style);
}
// Across text fragments, as Chrome's find does: a word split over styled runs (or, on some
// pages, a span per letter) is still one match.
function findMatches(text) {
  const needle = text.toLowerCase();
  const nodes = [];
  const starts = [];
  let flat = '';
  const walker = document.createTreeWalker(document.body || document.documentElement, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) => {
      const parent = node.parentElement;
      if (!parent || /^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE)$/.test(parent.tagName) || !parent.getClientRects().length) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  for (let node = walker.nextNode(); node && flat.length < 5e6; node = walker.nextNode()) {
    starts.push(flat.length);
    nodes.push(node);
    flat += node.data;
  }
  const at = (pos) => { // the fragment holding character pos
    let lo = 0, hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid] <= pos) lo = mid; else hi = mid - 1;
    }
    return lo;
  };
  const hay = flat.toLowerCase();
  const ranges = [];
  for (let i = hay.indexOf(needle); i >= 0 && ranges.length < 2000; i = hay.indexOf(needle, i + needle.length)) {
    const a = at(i), b = at(i + needle.length - 1);
    const range = new Range();
    range.setStart(nodes[a], i - starts[a]);
    range.setEnd(nodes[b], i + needle.length - starts[b]);
    ranges.push(range);
  }
  return ranges;
}
// Highlights are drawing only: if the API isn't there, matches still count and scroll.
function paint(name, ranges) {
  try {
    if (!ranges) CSS.highlights.delete(name);
    else { findStyle(); CSS.highlights.set(name, new Highlight(...ranges)); }
  } catch { /* no highlight API in this world */ }
}
function clearFind() {
  paint('jarvis-find', null);
  paint('jarvis-find-now', null);
  findRanges = []; findAt = -1; findFor = '';
}
function findInPage({ text = '', forward = true, stop = false }) {
  text = String(text).slice(0, 200);
  if (stop || !text) { clearFind(); return { ok: true, matches: 0, active: 0 }; }
  if (text !== findFor) {
    clearFind();
    findFor = text;
    findRanges = findMatches(text);
    findAt = forward ? -1 : findRanges.length;
    if (findRanges.length) paint('jarvis-find', findRanges);
  }
  if (!findRanges.length) return { ok: true, matches: 0, active: 0 };
  findAt = (findAt + (forward ? 1 : -1) + findRanges.length) % findRanges.length;
  const range = findRanges[findAt];
  paint('jarvis-find-now', [range]);
  const rect = range.getBoundingClientRect();
  if (rect.top < 60 || rect.bottom > innerHeight - 60) window.scrollBy({ top: rect.top - innerHeight / 2, behavior: 'instant' });
  return { ok: true, matches: findRanges.length, active: findAt + 1 };
}

// ── point and speak: what the hand is on, for "make this bigger" in Jarvis Code ──

const POINT_FRESH_MS = 4000; // the hand dropped while the words were said still counts

// A CSS path that finds the element again: from the nearest ancestor with a unique id,
// each step its tag, two classes and its place among siblings of that tag.
function selectorOf(el) {
  const parts = [];
  for (let node = el; node && node.nodeType === 1 && node !== document.documentElement && parts.length < 6; node = node.parentElement) {
    if (node.id && /^[A-Za-z][\w-]*$/.test(node.id) && document.querySelectorAll(`#${node.id}`).length === 1) {
      parts.unshift(`#${node.id}`);
      break;
    }
    let part = node.tagName.toLowerCase();
    const classes = [...node.classList].filter((c) => /^[A-Za-z][\w-]*$/.test(c)).slice(0, 2);
    if (classes.length) part += `.${classes.join('.')}`;
    const same = node.parentElement ? [...node.parentElement.children].filter((c) => c.tagName === node.tagName) : [];
    if (same.length > 1) part += `:nth-of-type(${same.indexOf(node) + 1})`;
    parts.unshift(part);
  }
  return parts.join(' > ');
}

// The element under the hand's cursor (else the control it lights), where it is on the
// page, and its words.
function pointed() {
  if (!ui || (ui.cursor.hidden && Date.now() - movedAt > POINT_FRESH_MS)) return { ok: false, message: 'The hand isn’t pointing at the page.' };
  const under = document.elementFromPoint(cursorAt.x, cursorAt.y);
  const el = under && usable(under) ? under : (hover && hover.isConnected ? hover : under);
  if (!el || el === document.body || el === document.documentElement) return { ok: false, message: 'Nothing is under the hand.' };
  const r = el.getBoundingClientRect();
  const words = el.getAttribute('aria-label') || el.innerText || el.value || el.getAttribute('alt') || el.title || '';
  return {
    ok: true,
    tag: el.tagName.toLowerCase(),
    text: String(words).replace(/\s+/g, ' ').trim().slice(0, 200),
    selector: selectorOf(el),
    box: { x: Math.round(r.left), y: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) },
  };
}

async function command({ action, args = {} }) {
  switch (action) {
    case 'pointed': return pointed();
    case 'locate': {
      let el = null;
      if (args.selector) { try { el = document.querySelector(args.selector); } catch (_) { el = null; } }
      el = el || find(args.text);
      if (!el) return { ok: false, message: `Nothing on the page matches “${args.text || args.selector}”.` };
      el.scrollIntoView({ block: 'center', inline: 'nearest' });
      await new Promise((r) => setTimeout(r, 60));
      const c = centerOf(el);
      const z = webFrame.getZoomFactor();
      place(el, ' flash');
      setTimeout(() => { if (hover !== el) place(hover); }, 900);
      return { ok: true, label: labelOf(el), risky: risky(el), x: Math.round(c.x * z), y: Math.round(c.y * z) };
    }
    case 'read': return readPage(args);
    case 'scroll': return scrollPage(args);
    case 'search': return search(args);
    case 'navigate': return navigate(args);
    case 'find': return findInPage(args);
    case 'dialogs': agentDialogs = Boolean(args.agent); return { ok: true };
    default: return { ok: false, message: `Unknown command ${action}` };
  }
}

// ── lock: while J.A.R.V.I.S. is in control, the wheel and trackpad do nothing ──

// (The main process already drops the mouse and keyboard; this also stops the wheel,
// which it can't see, and anything that reaches the page some other way.)
const block = (event) => { if (locked && !typing) { event.preventDefault(); event.stopImmediatePropagation(); } };
for (const type of ['wheel', 'mousewheel', 'touchstart', 'touchmove', 'dragstart', 'drop', 'contextmenu',
  'keydown', 'keypress', 'keyup', 'beforeinput', 'paste', 'cut', 'compositionstart']) {
  window.addEventListener(type, block, { capture: true, passive: false });
}

// ── the page's alert, confirm and prompt while JARVIS or Jarvis Code acts in this tab ──
// They go to the app, which hands them to the agent to answer (the page waits for the answer,
// as it would for the box). Otherwise, and in frames inside the page, they're the page's own
// box as always. Electron's own box can't be closed once the agent has answered over the
// DevTools protocol, so the agent never answers that one.
let agentDialogs = false;
try {
  const own = { alert: window.alert, confirm: window.confirm, prompt: window.prompt };
  const ask = (type) => (...args) => {
    if (!agentDialogs) return own[type].apply(window, args); // exactly as the page called it
    const text = (v) => (v === undefined || v === null ? '' : String(v)).slice(0, 2000);
    const answer = ipcRenderer.sendSync('page:dialog', { type, message: text(args[0]), value: text(args[1]) });
    return type === 'alert' ? undefined : answer;
  };
  contextBridge.executeInMainWorld({
    func: (alertFn, confirmFn, promptFn) => {
      for (const [name, fn] of [['alert', alertFn], ['confirm', confirmFn], ['prompt', promptFn]]) {
        try { Object.defineProperty(fn, 'name', { value: name }); } catch (e) { /* kept */ }
        window[name] = fn;
      }
    },
    args: [ask('alert'), ask('confirm'), ask('prompt')],
  });
} catch (_) { /* no bridge here: the page keeps its own */ }

ipcRenderer.on('jarvis:hand', (_event, msg) => onHand(msg));
ipcRenderer.on('jarvis:locked', (_event, value) => {
  locked = Boolean(value);
  if (ui) ui.edge.hidden = !locked;
});
ipcRenderer.on('jarvis:command', async (_event, { id, action, args }) => {
  let result;
  try {
    result = await command({ action, args });
  } catch (err) {
    result = { ok: false, message: String(err && err.message ? err.message : err) };
  }
  ipcRenderer.send('page:result', { id, result });
});

window.addEventListener('DOMContentLoaded', () => overlay());
