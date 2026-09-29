// Runs inside the BSH Research Center page that J.A.R.V.I.S. shows, in an isolated world:
// the page's own scripts can't see it or reach the app through it. It is J.A.R.V.I.S.'s
// hand in the page:
// - draws the hand cursor, lights up what it's aiming at (snapping to the nearest thing
//   you can open, so you needn't be precise) and says what a pinch will do;
// - turns a pinch into a real click (the main process sends it; direct mouse and
//   keyboard input is blocked there), a pinch-and-move into scrolling that coasts;
// - asks for a second pinch before anything that starts a run, sends, posts or deletes;
// - blocks the trackpad and wheel while J.A.R.V.I.S. is in control;
// - answers J.A.R.V.I.S.'s voice commands: find and press, read, scroll, the search box.

const { ipcRenderer, webFrame } = require('electron');

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

let locked = true;
let typing = false; // true only while J.A.R.V.I.S. itself fills in the search box
let ui = null;
let hover = null; // the element lit under the cursor
let latch = null; // what the current pinch will open
let scroller = null; // what the current pinch-and-move scrolls
let pending = null; // { el, at } waiting for a second pinch
let coast = 0;
let lastPointer = { x: -1, y: -1 };
let cursorAt = { x: 0, y: 0 };

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
  ipcRenderer.send('research:hover', el ? { label: labelOf(el), risky: risky(el) } : null);
}

function pointTo(x, y) {
  // The real (virtual) mouse follows, so the page shows its own hover states too.
  if (Math.abs(x - lastPointer.x) < 3 && Math.abs(y - lastPointer.y) < 3) return;
  lastPointer = { x, y };
  const z = webFrame.getZoomFactor();
  ipcRenderer.send('research:pointer', { x: Math.round(x * z), y: Math.round(y * z) });
}

function centerOf(el) {
  const r = el.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
}

function clickEl(el) {
  const c = centerOf(el);
  const z = webFrame.getZoomFactor();
  place(el, ' flash');
  ipcRenderer.send('research:click', { x: Math.round(c.x * z), y: Math.round(c.y * z) });
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
          ipcRenderer.send('research:note', { text: `Opened “${labelOf(latch)}”` });
        } else {
          pending = { el: latch, at: Date.now() };
          place(latch);
          ipcRenderer.send('research:note', { text: `Pinch again to confirm “${labelOf(latch)}”` });
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

function readPage() {
  const main = document.querySelector('main') || mainScroller() || document.body;
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
  return {
    title: document.title,
    url: location.href,
    path: location.pathname,
    headings,
    text: (main.innerText || '').slice(0, 14000),
    actions,
    hovered: hover ? labelOf(hover) : '',
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

async function command({ action, args = {} }) {
  switch (action) {
    case 'locate': {
      const el = find(args.text);
      if (!el) return { ok: false, message: `Nothing on the page matches “${args.text}”.` };
      el.scrollIntoView({ block: 'center', inline: 'nearest' });
      await new Promise((r) => setTimeout(r, 60));
      const c = centerOf(el);
      const z = webFrame.getZoomFactor();
      place(el, ' flash');
      setTimeout(() => { if (hover !== el) place(hover); }, 900);
      return { ok: true, label: labelOf(el), risky: risky(el), x: Math.round(c.x * z), y: Math.round(c.y * z) };
    }
    case 'read': return readPage();
    case 'scroll': return scrollPage(args);
    case 'search': return search(args);
    case 'navigate': return navigate(args);
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
  ipcRenderer.send('research:result', { id, result });
});

window.addEventListener('DOMContentLoaded', () => overlay());
