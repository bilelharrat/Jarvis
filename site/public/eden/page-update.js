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
// Files loaded after startup (lazy modules, their stylesheets: util.js noteAsset) join the list once
// loaded, each stamped as it loads: efficiency pass 2 (pass 1 left share.css and import-chatgpt.css out).
const extra = new Map(); // pathname -> URL
// The modules chat history lives in, looked at too (they're imported, not named in index.html): a deploy that
// changed only them was never noticed, so the iPhone and Mac apps kept running the old sync code for days.
export const SYNC_FILES = ['cloud-sync.js', 'sync-model.js', 'state.js', 'convstore.js', 'sync.js', 'account.js', 'app.js', 'chat.js'];
function FILES() {
  const out = { page: location.href.split('#')[0] };
  for (const f of SYNC_FILES) {
    try { const u = new URL(f, import.meta.url); if (u.origin === location.origin) out[u.pathname] = u.href; } catch { /* not a URL */ }
  }
  for (const [k, u] of extra) out[k] = u;
  for (const tag of document.querySelectorAll('script[src], link[rel="stylesheet"][href]')) {
    try {
      const u = new URL(tag.getAttribute(tag.tagName === 'LINK' ? 'href' : 'src'), document.baseURI);
      if (u.origin === location.origin) out[u.pathname] = u.href;
    } catch { /* not a URL */ }
  }
  return out;
}

/** One file's stamp: its ETag or Last-Modified, else a hash of its text. Null when it can't be read. */
async function stampFile(url) {
  if (!url) return null;
  try {
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

/** What a reload now would lose (any true: offer the banner instead): R2C-3. */
function busy() {
  const q = (sel) => document.querySelector(sel);
  const inp = document.getElementById('deck-input');
  const chips = document.getElementById('jc-attach');
  const root = document.documentElement;
  const a = document.activeElement;
  const typed = (x) => !!x && ((('value' in x) && typeof x.value === 'string' && x.value.trim() !== '') || (x.isContentEditable && (x.textContent || '').trim() !== ''));
  return {
    streaming: !!(state.streams && state.streams.size > 0),
    draft: !!(inp && inp.value.trim()),
    // files, pictures or context in the composer (not the persona or Use-my-Mac chips: those stay)
    attachments: !!(chips && chips.querySelector('.jc-thumb-img, .jc-file-chip:not(.persona):not(.mac-chip)')),
    talking: root.classList.contains('talking') || !!q('#talk:not([hidden])'),
    // dictating: recording, or the recording being turned into words (voice.js paintMic)
    dictating: !!q('#jc-dictate.live, #jc-dictate.busy'),
    // a Mail message being written (compose.js), with words in it
    mail: [...document.querySelectorAll('.cw-ed')].some((x) => (x.textContent || '').trim() !== ''),
    // an import reading a file (import-chatgpt.js marks the page while it runs)
    importing: root.classList.contains('eden-importing'),
    // any dialog or sheet open: Share, Import, Settings, Account, Help, the palette, a confirm, a sheet's or the calendar's form
    dialog: !!q('dialog[open], .sheet.open, #palette.open, .sh-dlg, .cal-sheet:not([hidden])'),
    // a field with words in it and the cursor in it (a search, a rename, a form)
    field: !!a && a !== document.body && a !== inp && typed(a),
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
// The probe is measured with text-size-adjust at 100% (on it and, for that moment, on the page):
// measured under the page's own scale it read back that scale, so a smaller system size was never
// followed until a relaunch (R2-4). Looked at again on coming back to the page and on a resize.
function systemTextPx() {
  const root = document.documentElement;
  const was = [root.style.webkitTextSizeAdjust, root.style.textSizeAdjust];
  root.style.webkitTextSizeAdjust = root.style.textSizeAdjust = '100%';
  const probe = el('span', { 'aria-hidden': 'true', style: { font: '-apple-system-body', webkitTextSizeAdjust: '100%', textSizeAdjust: '100%', position: 'absolute', visibility: 'hidden', pointerEvents: 'none' } }, 'x');
  document.body.append(probe);
  const px = parseFloat(getComputedStyle(probe).fontSize) || 17;
  probe.remove();
  [root.style.webkitTextSizeAdjust, root.style.textSizeAdjust] = was;
  return px;
}
function followTextSize() {
  const root = document.documentElement;
  if (!root.classList.contains('eden-app')) return;
  const scale = Math.max(0.85, Math.min(1.6, systemTextPx() / 17));
  const pct = `${Math.round(scale * 100)}%`;
  root.style.setProperty('--eden-text-scale', scale.toFixed(3));
  root.style.webkitTextSizeAdjust = root.style.textSizeAdjust = pct;
  root.classList.toggle('eden-big-text', scale > 1.15);
}
let sizeT = 0;
const followTextSizeSoon = () => { clearTimeout(sizeT); sizeT = setTimeout(followTextSize, 150); };

export function initPageUpdate() {
  // the app adds .eden-app after the first scripts run (app.js lockZoom): look once it's there too
  followTextSize();
  if (!document.documentElement.classList.contains('eden-app')) {
    const mo = new MutationObserver(() => { if (document.documentElement.classList.contains('eden-app')) { mo.disconnect(); followTextSize(); } });
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
  }
  // the system size can change while Eden is in the background, or with the page open (iPad Split View, Control Center)
  // (and once more a moment later: WebKit can take a beat to pick up the new size after coming back)
  document.addEventListener('visibilitychange', () => { if (!document.hidden) { followTextSize(); setTimeout(followTextSize, 700); } });
  addEventListener('resize', followTextSizeSoon);
  addEventListener('pageshow', (e) => { if (e.persisted) followTextSize(); });
  if (isMock) return; // the sample page has no deploys
  // the stamp as loaded (a little after boot, off the first paint's path)
  setTimeout(() => { stampAll().then((s) => { boot = { ...s, ...boot }; lastLook = Date.now(); }); }, 4000);
  addEventListener('eden:asset', (e) => {
    let u;
    try { u = new URL(e.detail, document.baseURI); } catch { return; }
    if (u.origin !== location.origin || extra.has(u.pathname)) return;
    extra.set(u.pathname, u.href);
    // loaded now: its stamp as loaded (before the boot stamp, that one takes it in)
    stampFile(u.href).then((s) => { if (s) boot = { [u.pathname]: s, ...boot }; });
  });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) look(); });
  addEventListener('pageshow', (e) => { if (e.persisted) look(true); });
}
