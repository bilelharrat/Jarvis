// A page that stays open (the iPhone app keeps its web view for days; a browser tab, the Mac app)
// keeps running the code it loaded. Coming back to it, at most every 5 minutes, it asks the server
// whether index.html or a script or stylesheet it names changed since this page loaded; if so it reloads by itself
// when nothing would be lost (no reply streaming, an empty composer, not talking), and otherwise
// offers "Eden was updated · Reload" (iOS sweep 2026-10-09, A3 / C5).
//
// Also, in the iPhone and iPad app only: the page's text follows the system text size (A7).

import { el } from './util.js';
import { state } from './state.js';
import { isMock } from './api.js';
import { textHash, stampOf, stampChanged, updateAction, UPDATE_CHECK_MS } from './resilience.js';

// The page itself and every script and stylesheet index.html names on this server (a module that
// only app.js imports isn't looked at: a deploy changes app.js or app.css nearly always).
function FILES() {
  const out = { page: location.href.split('#')[0] };
  for (const tag of document.querySelectorAll('script[src], link[rel="stylesheet"][href]')) {
    try {
      const u = new URL(tag.getAttribute(tag.tagName === 'LINK' ? 'href' : 'src'), document.baseURI);
      if (u.origin === location.origin) out[u.pathname] = u.href;
    } catch { /* not a URL */ }
  }
  return out;
}

/** One file's stamp: its ETag or Last-Modified (a HEAD), else a hash of its text. Null when it can't be read. */
async function stampFile(url) {
  if (!url) return null;
  try {
    const head = await fetch(url, { method: 'HEAD', cache: 'no-store', credentials: 'same-origin' });
    if (head.ok) { const s = stampOf(head.headers); if (s) return s; }
    const res = await fetch(url, { cache: 'no-store', credentials: 'same-origin' });
    if (!res.ok) return null;
    return stampOf(res.headers) || `h:${textHash(await res.text())}`;
  } catch { return null; }
}
async function stampAll() {
  const f = FILES();
  const out = {};
  await Promise.all(Object.keys(f).map(async (k) => { out[k] = await stampFile(f[k]); }));
  return out;
}

let boot = null, lastLook = 0, looking = false, offered = false;

function busy() {
  const inp = document.getElementById('deck-input');
  const chips = document.getElementById('jc-attach');
  return {
    streaming: state.streams && state.streams.size > 0,
    draft: !!((inp && inp.value.trim()) || (chips && chips.childElementCount)),
    talking: document.documentElement.classList.contains('talking') || !!document.querySelector('#talk:not([hidden])'),
  };
}

function offer() {
  if (offered) return;
  offered = true;
  const bar = el('div', { class: 'eden-updated', role: 'status' },
    el('span', '', 'Eden was updated'),
    el('button', { type: 'button', class: 'cap primary', onclick: () => location.reload() }, 'Reload'),
    el('button', { type: 'button', class: 'iconbtn', 'aria-label': 'Not now', title: 'Not now', onclick: () => bar.remove() }, '×'));
  document.body.append(bar);
}

async function look(force = false) {
  if (looking || !boot || document.hidden || offered) return;
  if (!force && Date.now() - lastLook < UPDATE_CHECK_MS) return;
  looking = true;
  lastLook = Date.now();
  try {
    const now = await stampAll();
    if (!stampChanged(boot, now)) return;
    if (updateAction(busy()) === 'reload') location.reload();
    else offer();
  } finally { looking = false; }
}

/* ---------- the system text size, in the app ---------- */

// WebKit's `-apple-system-body` font follows the iOS text size (17px at the default size). The page
// is laid out in px, so its text is scaled with text-size-adjust by that ratio (0.85–1.6: past that
// the phone layout would no longer fit; VoiceOver users zoom further with the system zoom).
function followTextSize() {
  const root = document.documentElement;
  if (!root.classList.contains('eden-app')) return;
  const probe = el('span', { style: { font: '-apple-system-body', position: 'absolute', visibility: 'hidden' } }, 'x');
  document.body.append(probe);
  const px = parseFloat(getComputedStyle(probe).fontSize) || 17;
  probe.remove();
  const scale = Math.max(0.85, Math.min(1.6, px / 17));
  root.style.setProperty('--eden-text-scale', scale.toFixed(3));
  root.style.webkitTextSizeAdjust = root.style.textSizeAdjust = `${Math.round(scale * 100)}%`;
  root.classList.toggle('eden-big-text', scale > 1.15);
}

export function initPageUpdate() {
  // the app adds .eden-app after the first scripts run (app.js lockZoom): look once it's there too
  followTextSize();
  if (!document.documentElement.classList.contains('eden-app')) {
    const mo = new MutationObserver(() => { if (document.documentElement.classList.contains('eden-app')) { mo.disconnect(); followTextSize(); } });
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
  }
  if (isMock) return; // the sample page has no deploys
  // the stamp as loaded (a little after boot, off the first paint's path)
  setTimeout(() => { stampAll().then((s) => { boot = s; lastLook = Date.now(); }); }, 4000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) { followTextSize(); look(); } });
  addEventListener('pageshow', (e) => { if (e.persisted) { followTextSize(); look(true); } });
}
