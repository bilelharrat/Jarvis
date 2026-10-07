// The account page, in Eden at askeden.com (site/docs/web-auth.md, GET /api/web/account): the
// plan and what's left of the included AI, the devices and browsers signed in (a browser may
// sign browsers out; the apps are removed in the J.A.R.V.I.S. app), the ways to sign in (Apple,
// Google, a passkey: add one, unlink one while another remains; a passkey is made right here with
// WebAuthn, /api/web/passkey/options and /verify in "add" mode) and, without Plus, where to get it: by card
// with Stripe Checkout once askeden.com's billing is set up (config `billing`), or in the
// J.A.R.V.I.S. iPhone app. Inside the Eden iOS app only the iPhone app is offered (Apple's in-app
// purchase rules) unless the server's `billing_in_app` flag says otherwise. With Plus: "Manage
// billing" (Stripe's Customer Portal) or "Manage in the App Store", for whichever paid.
//
// Also: Sync (H1: this browser's end-to-end encrypted chat history, sync.js), Delegates (H14:
// who may use this account, within limits, and the accounts this one may use), Team spaces
// (G8, spaces.js), Published pages (G10, publish.js) and Connected apps (H13: Eden Messenger's
// @Eden, with Revoke). While this browser is acting for
// someone (a delegate's session, a space), a banner says so, with "Switch back".
//
// Opened from Settings (its "Account" button) and by #account in the address, where the server
// sends a browser back after adding a sign-in method (#account?error=<code>&provider=<p> when
// that didn't work), and Stripe sends it back after Checkout (#account?billing=success|cancelled),
// and by an invitation link (#delegate=<code>, #space=<code>). Hidden where
// there are no accounts: the local server (model-router-ui) has no /api/web/account, and its
// meta has no `hosted`. ?mock=1 answers it from mock.js.

import { $, el, svgEl, ico, toast } from './util.js';
import { state, ui } from './state.js';
import { apiUrl, isMock } from './api.js';
import { setActing } from './acting.js';
import * as Sync from './sync.js';
import { passphraseProblem, suggestPassphrase, verifyCode } from './eden-crypto.js';
import { spacesSection, inviteCard, enableWorkflowSharing } from './spaces.js';
import { publishedSection } from './publish.js';
import { IN_APP } from './native.js';
import { setPlanOffer } from './plan.js';

let H = {};
let available = false;
let returnFocus = null;
let busy = false;
// Where a signed-out browser goes: askeden.com/ (the landing page); in mock mode, this page again.
const HOME = () => (isMock ? location.pathname + location.search : '/');

const PROVIDERS = { apple: 'Apple', google: 'Google', passkey: 'Passkey' };
const APPS = { iphone: 'iPhone', ipad: 'iPad', watch: 'Apple Watch', mac: 'Mac' };
// What came back in #account?error=…: only these, in plain words (never text from the address).
const ERRORS = {
  taken: (p) => `This ${p} account is already used by another Eden account, so it wasn’t added.`,
  identity_taken: (p) => ERRORS.taken(p),
  cancelled: () => 'Adding it was cancelled. Nothing changed.',
  access_denied: () => 'Adding it was cancelled. Nothing changed.',
  expired: () => 'That took too long. Try again.',
  state: () => 'That took too long. Try again.',
  not_set_up: (p) => `Signing in with ${p} isn’t ready yet.`,
  rate_limited: () => 'Too many tries from this network. Wait a minute, then try again.',
};

/** replaceChildren, leaving out the parts that aren't there (null would show as "null"). */
const fill = (node, ...kids) => node.replaceChildren(...kids.filter((k) => k !== null && k !== undefined && k !== false));

/* ---------- talking to askeden.com ---------- */

async function call(path, init = {}) {
  const opts = { cache: 'no-store', ...init, headers: { 'X-Jarvis-Chat': '1', ...(init.body ? { 'content-type': 'application/json' } : {}), ...(init.headers || {}) } };
  if (isMock) return (await import('./mock.js')).mockFetch(path, opts);
  return fetch(apiUrl(path), opts);
}

async function read(res) {
  try { return await res.json(); } catch { return {}; }
}

async function post(path, payload = {}) {
  let res;
  try { res = await call(path, { method: 'POST', body: JSON.stringify(payload) }); }
  catch { throw new Error('Can’t reach askeden.com. Check your connection.'); }
  if (res.status === 401) { location.replace(HOME()); throw new Error('Signed out.'); }
  const body = await read(res);
  if (!res.ok) throw Object.assign(new Error(body.error || `askeden.com said ${res.status}.`), { code: body.code });
  return body;
}

async function load() {
  let res;
  try { res = await call('/api/web/account'); } catch { return { error: 'Can’t reach askeden.com. Check your connection.' }; }
  if (res.status === 401) { location.replace(HOME()); return { error: 'Signed out.' }; }
  if (!res.ok) return { error: (await read(res)).error || `askeden.com said ${res.status}.`, status: res.status };
  const account = await read(res);
  let config = {};
  try { const c = await call('/api/web/config'); if (c.ok) config = await read(c); } catch { /* no Add buttons then */ }
  return { account, config };
}

/* ---------- formatting ---------- */

const money = (n) => (typeof n === 'number' && Number.isFinite(n) ? `$${n.toFixed(2)}` : '—');
const toDate = (x) => (x === null || x === undefined || x === '' ? null : new Date(typeof x === 'number' && x < 1e12 ? x * 1000 : x));
function day(x) {
  const d = toDate(x);
  if (!d || Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', ...(d.getFullYear() !== new Date().getFullYear() ? { year: 'numeric' } : {}) });
}
function ago(x) {
  const d = toDate(x);
  if (!d || Number.isNaN(d.getTime())) return '';
  const s = Math.max(0, (Date.now() - d.getTime()) / 1000);
  if (s < 90) return 'active now';
  if (s < 3600) return `active ${Math.round(s / 60)} min ago`;
  if (s < 86400) return `active ${Math.round(s / 3600)} h ago`;
  if (s < 86400 * 7) return `active ${Math.round(s / 86400)} d ago`;
  return `active ${day(d)}`;
}
function left(x) {
  const d = toDate(x);
  if (!d) return '';
  const days = Math.ceil((d.getTime() - Date.now()) / 86400000);
  return days <= 1 ? 'ends within a day' : `ends in ${days} days`;
}

/* ---------- small pictures (the sprite has none of these) ---------- */

const GLYPHS = {
  web: ['M3.5 12a8.5 8.5 0 1017 0 8.5 8.5 0 00-17 0z', 'M3.5 12h17M12 3.5c2.3 2.4 3.4 5.2 3.4 8.5s-1.1 6.1-3.4 8.5c-2.3-2.4-3.4-5.2-3.4-8.5s1.1-6.1 3.4-8.5z'],
  iphone: ['M8.5 2.75h7a2 2 0 012 2v14.5a2 2 0 01-2 2h-7a2 2 0 01-2-2V4.75a2 2 0 012-2z', 'M10.5 5.5h3'],
  ipad: ['M6 3h12a2 2 0 012 2v14a2 2 0 01-2 2H6a2 2 0 01-2-2V5a2 2 0 012-2z', 'M11 18h2'],
  watch: ['M8.5 6.5h7a2 2 0 012 2v7a2 2 0 01-2 2h-7a2 2 0 01-2-2v-7a2 2 0 012-2z', 'M9 6.5l.6-3.5h4.8l.6 3.5M9 17.5l.6 3.5h4.8l.6-3.5'],
  mac: ['M4.5 5h15a1.5 1.5 0 011.5 1.5V16H3V6.5A1.5 1.5 0 014.5 5z', 'M1.5 16h21l-1 2.5h-19z'],
  app: ['M4 6a2 2 0 012-2h12a2 2 0 012 2v9a2 2 0 01-2 2H9l-4.5 3.5c-.3.2-.5 0-.5-.3V6z', 'M8.5 9.5h7M8.5 12.5h4.5'],
};
function glyph(kind) {
  const s = svgEl('svg', { class: 'ic', viewBox: '0 0 24 24', 'aria-hidden': 'true' });
  for (const d of GLYPHS[kind] || GLYPHS.web) s.append(svgEl('path', { d }));
  return s;
}
// The providers' own marks, as on their buttons.
function mark(provider) {
  if (provider === 'passkey') {
    const k = svgEl('svg', { class: 'acct-mark passkey', viewBox: '0 0 24 24', 'aria-hidden': 'true', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.7', 'stroke-linecap': 'round' });
    for (const d of ['M13 8a4 4 0 1 1-8 0 4 4 0 0 1 8 0z', 'M2.75 20.25c.6-3.6 3.2-5.75 6.25-5.75 1.2 0 2.3.3 3.25.85', 'M20 13.5a2.5 2.5 0 1 1-5 0 2.5 2.5 0 0 1 5 0z', 'M17.5 16v5.25M17.5 19h1.75']) k.append(svgEl('path', { d }));
    return k;
  }
  const s = svgEl('svg', { class: `acct-mark ${provider}`, viewBox: provider === 'google' ? '0 0 48 48' : '0 0 24 24', 'aria-hidden': 'true' });
  if (provider === 'google') {
    for (const [fill, d] of [
      ['#EA4335', 'M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z'],
      ['#4285F4', 'M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z'],
      ['#FBBC05', 'M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z'],
      ['#34A853', 'M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z'],
    ]) s.append(svgEl('path', { fill, d }));
  } else {
    s.append(svgEl('path', { fill: 'currentColor', d: 'M16.37 12.6c-.02-2.2 1.8-3.26 1.88-3.31-1.03-1.5-2.62-1.7-3.18-1.73-1.35-.14-2.64.8-3.33.8-.69 0-1.74-.78-2.87-.76-1.47.02-2.83.86-3.59 2.18-1.53 2.66-.39 6.6 1.1 8.76.73 1.06 1.6 2.24 2.73 2.2 1.1-.04 1.51-.71 2.84-.71 1.32 0 1.7.71 2.86.69 1.18-.02 1.93-1.07 2.65-2.13.84-1.22 1.18-2.41 1.2-2.47-.03-.01-2.3-.88-2.33-3.52zM14.2 6.12c.6-.73 1.01-1.75.9-2.76-.87.04-1.92.58-2.54 1.31-.56.64-1.05 1.67-.92 2.66.97.08 1.96-.49 2.56-1.21z' }));
  }
  return s;
}

/* ---------- the sheet ---------- */

function sheet() {
  let s = $('accountSheet');
  if (s) return s;
  s = el('div', { class: 'sheet acct-sheet', id: 'accountSheet', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'acctTitle' },
    el('div', 'sheet-card glass acct',
      el('div', 'sheet-head', el('h2', { id: 'acctTitle' }, 'Account'),
        el('button', { type: 'button', class: 'iconbtn', id: 'btnAcctClose', 'aria-label': 'Close account', onclick: closeAccount }, ico('x'))),
      el('div', { class: 'sheet-body', id: 'acctBody', 'aria-live': 'polite' })));
  s.addEventListener('click', (e) => { if (e.target === s) closeAccount(); });
  s.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeAccount(); return; }
    if (e.key !== 'Tab') return;
    const f = [...s.querySelectorAll('button:not([disabled]), a[href], [tabindex="0"]')].filter((x) => x.offsetParent !== null);
    if (!f.length) return;
    if (e.shiftKey && document.activeElement === f[0]) { e.preventDefault(); f.at(-1).focus(); }
    else if (!e.shiftKey && document.activeElement === f.at(-1)) { e.preventDefault(); f[0].focus(); }
  });
  document.body.append(s);
  return s;
}

export const accountAvailable = () => available;
export const accountOpen = () => !!($('accountSheet') && $('accountSheet').classList.contains('open'));

/**
 * Opens the account page; `notice` is a line shown above it (what came back in #account), `ok`
 * shows it as good news, `waitPlus` watches for Plus to arrive (back from Stripe Checkout).
 */
export async function openAccount({ notice = null, ok = false, waitPlus = false, focusPlus = false } = {}) {
  if (H.beforeOpen) H.beforeOpen();
  const s = sheet();
  if (!s.classList.contains('open')) returnFocus = document.activeElement;
  s.classList.add('open');
  $('btnAcctClose').focus();
  const account = await draw(notice, { ok });
  if (focusPlus && account) showPlus();
  if (!waitPlus || !account) return;
  const shown = document.querySelector('#acctBody .acct-notice.ok');
  if (account.plan && account.plan.active) { if (shown) shown.textContent = 'Thank you! Plus is on.'; } // the webhook was first
  else watchForPlus();
}

// "Get Plus" from elsewhere (plan.js, /#plus from the front page): the Plan, highlighted, its
// button focused. Never on to Stripe by itself: the person presses it.
function showPlus() {
  const card = document.querySelector('#acctBody .acct-plus') || document.querySelector('#acctBody .acct-card');
  if (!card) return;
  card.scrollIntoView({ block: 'center', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
  card.classList.remove('flash');
  void card.offsetWidth; // restart the highlight
  card.classList.add('flash');
  const b = card.querySelector('.btn.primary, button.cap.primary');
  if (b) b.focus({ preventScroll: true });
}

// Back from Checkout before Stripe's webhook got here: look again for a little while.
async function watchForPlus() {
  for (let i = 0; i < 10; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    if (!accountOpen()) return;
    const { account } = await load();
    if (account && account.plan && account.plan.active) { draw('Plus is on. Thank you!', { ok: true }); return; }
  }
  if (accountOpen()) draw('Your payment went through. Plus can take a minute to show here: look again shortly.', { ok: true });
}

export function closeAccount() {
  const s = $('accountSheet');
  if (!s || !s.classList.contains('open')) return false;
  s.classList.remove('open');
  const back = returnFocus;
  returnFocus = null;
  if (back && back !== document.body && document.contains(back)) back.focus();
  return true;
}

async function draw(notice, { ok = false } = {}) {
  const body = $('acctBody');
  if (!body.firstChild || notice) body.replaceChildren(el('div', 'muted', 'Loading…'));
  const { account, config, error } = await load();
  if (account) setPlanOffer(account, config);
  if (error) {
    body.replaceChildren(el('div', 'sp-warn', el('b', '', 'Couldn’t read your account'), error),
      el('div', 'dlg-acts', el('button', { type: 'button', class: 'btn primary', onclick: () => draw() }, 'Try again')));
    return;
  }
  const invite = pendingInvite;
  pendingInvite = null;
  body.replaceChildren(...[
    notice ? el('div', { class: `sp-warn acct-notice${ok ? ' ok' : ''}`, role: ok ? 'status' : 'alert' }, notice) : null,
    account.acting ? actingBanner(account.acting) : null,
    planSection(account, config),
    syncSection(),
    delegatesSection(invite && invite.kind === 'delegate' ? invite.code : null),
    spacesSection({ prefill: invite && invite.kind === 'space' ? invite.code : null }),
    el('section', { class: 'set-sec acct-published', 'aria-labelledby': 'acctPubH' }, el('h3', { id: 'acctPubH' }, 'Published'), publishedSection()),
    devicesSection(account),
    appsSection(),
    methodsSection(account, config),
    account.acting ? null : deleteSection(),
  ].filter(Boolean));
  return account;
}

/* ---------- acting for someone (a delegate, a team space) ---------- */

async function switchBack() {
  try { await post('/api/web/deleg/leave'); } catch (e) { toast(e.message); return; }
  setActing(null); // the page loads as this person again: every panel back (acting.js)
  sessionStorage.removeItem('eden:space-level');
  location.reload();
}

function actingWords(a) {
  if (a.type === 'space') return { title: `Chatting in ${a.label}`, sub: 'Your turns use the space’s shared AI budget. Your chats stay in this browser.' };
  const what = (a.features || []).filter((f) => f !== 'chat');
  return { title: `Using ${a.label}’s Eden`, sub: `As a delegate: chat${what.length ? ` and ${what.join(' and ')}` : ' only'}, on the limit they set${a.expires ? `, until ${day(a.expires)}` : ''}.` };
}

function actingBanner(a) {
  const w = actingWords(a);
  return el('div', 'acct-acting',
    el('div', 'grow', el('b', '', w.title), el('p', '', w.sub)),
    el('button', { type: 'button', class: 'btn', onclick: switchBack }, 'Switch back'));
}

// The page's own reminder while acting: a pill above the composer's corner.
function actingPill(a) {
  if ($('actingPill')) return;
  const w = actingWords(a);
  document.body.append(el('div', { class: 'acting-pill glass', id: 'actingPill', role: 'status' },
    el('span', 'acting-dot', ''), el('span', 'acting-t', w.title),
    el('button', { type: 'button', class: 'cap', onclick: switchBack }, 'Switch back')));
}

/* ---------- Sync: chat history on every device, end-to-end encrypted ---------- */

let syncWatch = null;
let waitingCode = null;

function syncSection() {
  const box = el('div', 'acct-sync');
  const sec = el('section', { class: 'set-sec', 'aria-labelledby': 'acctSyncH' }, el('h3', { id: 'acctSyncH' }, 'Sync'), box);
  const draw = () => drawSync(box).catch((e) => box.replaceChildren(el('p', 'sp-note', `Sync isn’t available: ${e.message}`)));
  // Redrawn when what it shows changes, never under someone's typing.
  const sig = () => { const i = Sync.info(); const s = i.server || {}; return JSON.stringify([i.on, i.hasKey, i.error, i.tooBig, s.items, s.key && s.key.gen, s.key && s.key.wrap, s.key && s.key.epoch, s.key && s.key.wrap_stale, (s.requests || []).map((r) => r.device_id), (s.trusted || []).map((t) => [t.device_id, t.pending]), Math.floor((i.last || 0) / 60000)]); };
  let shown = '';
  if (syncWatch) syncWatch();
  syncWatch = Sync.onSyncChange(() => {
    if (!box.isConnected) return;
    const a = document.activeElement;
    if (a && box.contains(a) && (a.tagName === 'INPUT' || a.tagName === 'SUMMARY')) return;
    if (box.querySelector('details[open]') || sig() === shown) return;
    shown = sig();
    draw();
  });
  shown = sig();
  draw();
  // While it's open (and the tab visible): a browser asking to join shows up within seconds.
  Sync.watchStatus(() => box.isConnected && accountOpen());
  return sec;
}

const LEAD = 'Your chats on every device where you sign in to Eden. End-to-end encrypted: askeden.com stores them sealed with a key only your devices have, and can’t read them.';

function passphraseFields({ confirm = true } = {}) {
  const a = el('input', { type: 'password', class: 'acct-input', autocomplete: 'new-password', placeholder: 'Recovery passphrase', 'aria-label': 'Recovery passphrase' });
  const b = confirm ? el('input', { type: 'password', class: 'acct-input', autocomplete: 'new-password', placeholder: 'Type it again', 'aria-label': 'Type the passphrase again' }) : null;
  const shown = el('div', 'acct-sub', '');
  const suggest = el('button', { type: 'button', class: 'cap', onclick: () => {
    const p = suggestPassphrase();
    a.value = p; if (b) b.value = p;
    a.type = 'text';
    shown.textContent = 'Write it down or keep it in your password manager. askeden.com can’t recover it.';
  } }, 'Suggest one');
  return { a, b, shown, suggest, value: () => a.value, check: () => {
    const p = passphraseProblem(a.value);
    if (p) return p;
    if (b && b.value !== a.value) return 'The two passphrases differ.';
    return '';
  } };
}

async function drawSync(box) {
  const i = Sync.info();
  const s = i.server;
  if (!s) { box.replaceChildren(el('p', 'sp-note', i.error || (isMock ? 'Sync works at askeden.com, not in this preview.' : 'Checking…'))); return; }
  const lead = el('p', 'sp-note', LEAD);
  if (!s.key) {
    // The first device: make the key, with a recovery passphrase.
    const f = passphraseFields();
    const go = el('button', { type: 'button', class: 'btn primary', onclick: async () => {
      const why = f.check();
      if (why) { toast(why); return; }
      go.disabled = true; go.textContent = 'Turning on…';
      try { await Sync.turnOn(f.value()); toast('Sync is on'); } catch (e) { toast(e.message); go.disabled = false; go.textContent = 'Turn on sync'; }
    } }, 'Turn on sync');
    box.replaceChildren(lead, el('div', 'icard acct-card acct-form',
      el('b', '', 'Choose a recovery passphrase'),
      el('p', 'acct-sub', 'It unlocks your history in a browser when no other device is at hand (at least 12 characters; a few unrelated words work well). It’s stretched with PBKDF2 (600 000 rounds) and never sent.'),
      f.a, f.b, f.shown, el('div', 'acct-row-actions', f.suggest, go)));
    return;
  }
  if (!i.on) {
    // The key exists; this browser hasn't got it yet.
    const code = waitingCode;
    const ask = el('button', { type: 'button', class: 'btn primary', onclick: async () => {
      ask.disabled = true;
      const result = await Sync.requestTrust({ onCode: (c) => { waitingCode = c; drawSync(box); } }).catch((e) => { toast(e.message); return 'error'; });
      waitingCode = null;
      if (result === 'approved') toast('This browser now syncs');
      else if (result === 'denied') toast('The other device said no');
      else if (result === 'expired') toast('That request ran out. Ask again.');
      drawSync(box);
    } }, 'Ask a device that syncs');
    const f = passphraseFields({ confirm: false });
    const unlock = el('button', { type: 'button', class: 'btn', onclick: async () => {
      unlock.disabled = true; unlock.textContent = 'Unlocking…';
      try { await Sync.unlock(f.value()); toast('This browser now syncs'); } catch (e) { toast(e.message); unlock.disabled = false; unlock.textContent = 'Unlock'; }
    } }, 'Unlock');
    fill(box, lead,
      code ? el('div', 'icard acct-card acct-wait',
        el('b', '', 'Waiting for approval'),
        el('p', 'acct-sub', 'On a device that already syncs (another browser: Account › Sync; or the J.A.R.V.I.S. app on your iPhone or Mac, in Settings under your Jarvis account), approve this one if it shows the same code:'),
        el('div', 'acct-code-big', code),
        el('div', 'acct-row-actions', el('button', { type: 'button', class: 'cap', onclick: () => { Sync.cancelRequest(); waitingCode = null; drawSync(box); } }, 'Cancel')))
        : el('div', 'icard acct-card acct-form',
          el('b', '', 'Trust this browser'),
          el('p', 'acct-sub', 'Sync is on for your account. Approve this browser from a device that already syncs, a browser or the J.A.R.V.I.S. app (both show the same six digits), or use your recovery passphrase.'),
          el('div', 'acct-row-actions', ask),
          el('div', 'acct-join-row', f.a, unlock)),
      i.error ? el('p', 'sp-note', i.error) : null);
    return;
  }
  // On: status, waiting browsers, trusted ones.
  const when = i.running ? 'Syncing…' : i.last ? `Last synced ${agoShort(i.last)}` : 'Not synced yet';
  const top = el('div', 'icard acct-card',
    el('div', 'acct-allow',
      el('div', 'acct-row-top', el('span', 'acct-k', 'Sync is on'), el('b', 'acct-v', `${i.synced} ${i.synced === 1 ? 'chat' : 'chats'}`)),
      el('div', 'acct-sub', [when, i.tooBig ? `${i.tooBig} too big to sync` : '', i.error].filter(Boolean).join(' · ')),
      el('div', 'acct-row-actions',
        el('button', { type: 'button', class: 'cap primary', disabled: i.running, onclick: async (e) => { e.currentTarget.disabled = true; e.currentTarget.textContent = 'Syncing…'; await Sync.syncNow(); drawSync(box); } }, 'Sync now'))));
  const waiting = await Promise.all((s.requests || []).map(async (r) => el('li', 'acct-dev',
    el('span', 'acct-ico', glyph(r.kind)),
    el('div', 'grow', el('div', 'p-n', String(r.name || 'A browser').replace(/^Eden on the web: /, '')), el('div', 'p-c', 'Approve only if it shows this code:'), el('div', 'acct-code-big small', await verifyCode(r.public_key))),
    el('span', 'acct-confirm',
      el('button', { type: 'button', class: 'cap', onclick: async () => { try { await Sync.deny(r.device_id); } catch (e) { toast(e.message); } } }, 'Deny'),
      el('button', { type: 'button', class: 'cap primary', onclick: async () => { try { await Sync.approve(r); toast('Approved'); } catch (e) { toast(e.message); } } }, 'Approve')))));
  const trusted = (s.trusted || []).map((t) => el('li', `acct-dev${t.this ? ' this' : ''}`,
    el('span', 'acct-ico', glyph(t.kind)),
    el('div', 'grow', el('div', 'p-n', String(t.name || 'A device').replace(/^Eden on the web: /, ''), t.this ? el('span', 'acct-badge', 'This browser') : null),
      el('div', 'p-c', `${t.via === 'created' ? 'Made the key' : t.via === 'passphrase' ? 'Unlocked with the passphrase' : 'Approved'} · ${day(t.added)}${t.pending ? ' · Gets the new key when it next opens Eden' : ''}`)),
    t.this ? confirmButton('Stop here', 'Stop syncing in this browser?', async () => { await Sync.forgetHere(); toast('This browser stopped syncing'); })
      // Removing changes the key (sync.js removeDevice), so it can't read what's synced from now on.
      : confirmButton('Remove', 'Stop it syncing? The key changes.', async () => { const { dropped } = await Sync.removeDevice(t.device_id); toast(dropped.length ? `Removed; the key changed. Approve ${dropped.join(', ')} again.` : 'Removed; the key changed'); })));
  const f = passphraseFields();
  const change = el('details', 'acct-more', el('summary', '', s.key.wrap ? 'Change the recovery passphrase' : s.key.wrap_stale ? 'Set the recovery passphrase again' : 'Add a recovery passphrase'),
    el('div', 'acct-form', f.a, f.b, f.shown, el('div', 'acct-row-actions', f.suggest, el('button', { type: 'button', class: 'cap primary', onclick: async () => {
      const why = f.check();
      if (why) { toast(why); return; }
      try { await Sync.changePassphrase(f.value()); toast('Recovery passphrase changed'); } catch (e) { toast(e.message); }
    } }, 'Save'))));
  fill(box, lead, top,
    waiting.length ? el('p', 'acct-k acct-gap', 'Waiting for approval') : null,
    waiting.length ? el('div', 'icard acct-card', el('ul', 'acct-list', ...waiting)) : null,
    el('p', 'acct-k acct-gap', 'Devices with the key'),
    el('div', 'icard acct-card', el('ul', 'acct-list', ...trusted)),
    s.key.wrap_stale && !s.key.wrap ? el('div', 'sp-warn acct-gap', el('b', '', 'Your recovery passphrase no longer unlocks'), 'Eden’s key changed when a device was removed, and the passphrase was for the old one. Set it again below (the same one is fine).') : null,
    change,
    el('div', 'acct-foot',
      el('p', 'sp-note', 'Images stay on the device they were added on. Starting over deletes the synced copies on askeden.com (every browser keeps its own chats) and makes a new key.'),
      confirmButton('Start over', 'Delete the synced history on askeden.com?', async () => { await Sync.startOver(); toast('Synced history deleted'); })));
}

function agoShort(t) {
  const s = Math.max(0, (Date.now() - t) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return day(t);
}

/* ---------- Delegates ---------- */

const FEATURE_WORDS = { chat: 'Chat', mail: 'Mail', calendar: 'Calendar' };

function delegatesSection(prefill) {
  const box = el('div', 'acct-deleg', el('div', 'muted', 'Loading…'));
  const sec = el('section', { class: 'set-sec', 'aria-labelledby': 'acctDelegH' }, el('h3', { id: 'acctDelegH' }, 'Delegates'), box);
  // `keep`: an invitation just made, shown under the list until the page is drawn again.
  const draw = async (keep = null) => {
    let d;
    try { d = await (async () => { const r = await call('/api/web/deleg'); const b = await read(r); if (!r.ok) throw new Error(b.error || `askeden.com said ${r.status}.`); return b; })(); }
    catch (e) { box.replaceChildren(el('p', 'sp-note', `Couldn’t load delegates: ${e.message}`)); return; }
    const rows = (d.delegates || []).map((x) => {
      const status = { invited: 'Invited, not accepted yet', invite_expired: 'Invitation ran out', expired: 'Access ran out', active: 'Active' }[x.status] || x.status;
      return el('li', 'acct-dev',
        el('span', 'acct-ico', (x.name || '?').slice(0, 1).toUpperCase()),
        el('div', 'grow',
          el('div', 'p-n', x.name),
          el('div', 'p-c', [status, x.features.map((f) => FEATURE_WORDS[f] || f).join(', '), `${money(x.spent_usd)} of ${money(x.cap_usd)} this month`, x.status === 'active' || x.status === 'invited' ? `until ${day(x.expires)}` : ''].filter(Boolean).join(' · ')),
          x.cap_usd > 0 ? meter(Math.max(0, x.cap_usd - x.spent_usd), x.cap_usd, `${x.name}’s limit left`) : null),
        confirmButton('Revoke', `Revoke ${x.name}’s access?`, async () => { await post('/api/web/deleg/revoke', { id: x.id }); toast(`${x.name} can’t use your account any more`); draw(); }));
    });
    const mine = (d.mine || []).filter((g) => g.type === 'delegate').map((g) => el('li', 'acct-dev',
      el('span', 'acct-ico', glyph('web')),
      el('div', 'grow', el('div', 'p-n', `${g.label}’s Eden`), el('div', 'p-c', d.acting && d.acting.type === 'delegate' && g.id.endsWith(d.acting.id) ? 'In use in this browser' : 'You’re a delegate')),
      el('span', 'acct-confirm',
        el('button', { type: 'button', class: 'cap primary', onclick: async () => { try { await post('/api/web/deleg/use', { id: g.id }); setActing({ type: 'delegate', id: g.id, label: g.label, features: g.features || ['chat'] }); location.reload(); } catch (e) { toast(e.message); } } }, 'Use'),
        confirmButton('Leave', 'Give up this access?', async () => { await post('/api/web/deleg/quit', { id: g.id }); toast('Done'); draw(); }))));
    const out = el('div', 'acct-invite', keep);
    const code = el('input', { type: 'text', class: 'acct-input', placeholder: 'XXXX-XXXX-XXXX', 'aria-label': 'Delegate invitation code', autocomplete: 'off', spellcheck: 'false' });
    if (prefill) { code.value = prefill; prefill = null; }
    fill(box, 
      el('p', 'sp-note', 'Let an assistant or someone in your family use Eden on your account, signed in with their own: chat only unless you add Mail or Calendar, on a monthly limit out of your allowance, until a date you choose. They never see your account, devices or sign-in methods.'),
      rows.length ? el('div', 'icard acct-card', el('ul', 'acct-list', ...rows)) : null,
      el('div', 'acct-row-actions', el('button', { type: 'button', class: 'cap primary', onclick: () => inviteForm(out, d, draw) }, 'Invite someone')),
      out,
      mine.length ? el('p', 'acct-k acct-gap', 'Accounts you can use') : null,
      mine.length ? el('div', 'icard acct-card', el('ul', 'acct-list', ...mine)) : null,
      el('div', 'acct-join', el('span', 'acct-k', 'Invited to help someone?'), el('div', 'acct-join-row', code,
        el('button', { type: 'button', class: 'cap', onclick: async () => {
          try { const r = await post('/api/web/deleg/accept', { code: code.value }); toast(`You can now use ${r.accepted.from}’s Eden`); draw(); }
          catch (e) { toast(e.message); }
        } }, 'Accept'))));
    if (code.value) code.focus();
  };
  draw();
  return sec;
}

function inviteForm(out, d, done) {
  const name = el('input', { type: 'text', class: 'acct-input', maxlength: '40', placeholder: 'Sam (assistant)' });
  const from = el('input', { type: 'text', class: 'acct-input', maxlength: '40', placeholder: 'Your name, as they’ll see it' });
  const cap = el('input', { type: 'number', class: 'acct-input', min: '0', max: String(d.max_cap || 500), step: '1', value: '5' });
  const mail = el('input', { type: 'checkbox' });
  const cal = el('input', { type: 'checkbox' });
  const days = el('select', { 'aria-label': 'Access lasts' }, ...(d.days || [7, 30, 90, 365]).map((n) => {
    const o = el('option', { value: String(n) }, n === 365 ? 'A year' : `${n} days`);
    if (n === 30) o.selected = true;
    return o;
  }));
  out.replaceChildren(el('div', 'icard acct-card acct-form',
    el('label', 'acct-field', el('span', 'acct-k', 'Who'), name),
    el('label', 'acct-field', el('span', 'acct-k', 'From'), from),
    el('label', 'acct-field', el('span', 'acct-k', 'Monthly limit ($)'), cap, el('span', 'acct-sub', 'Out of your allowance; it can’t go past what you have left.')),
    el('div', 'acct-field', el('span', 'acct-k', 'They can use'),
      el('label', 'acct-check', el('input', { type: 'checkbox', checked: true, disabled: true }), 'Chat'),
      el('label', 'acct-check', mail, 'Mail (your Google mail on askeden.com)'),
      el('label', 'acct-check', cal, 'Calendar')),
    el('label', 'acct-field', el('span', 'acct-k', 'For'), days),
    el('div', 'dlg-acts',
      el('button', { type: 'button', class: 'btn', onclick: () => out.replaceChildren() }, 'Cancel'),
      el('button', { type: 'button', class: 'btn primary', onclick: async (e) => {
        e.currentTarget.disabled = true;
        try {
          const r = await post('/api/web/deleg/invite', { name: name.value, from: from.value, cap_usd: Number(cap.value), features: ['chat', ...(mail.checked ? ['mail'] : []), ...(cal.checked ? ['calendar'] : [])], days: Number(days.value) });
          done(inviteCard(r, 'You’re invited to use Eden'));
        } catch (err) { toast(err.message); e.currentTarget.disabled = false; }
      } }, 'Make the invitation'))));
  name.focus();
}


/* ---------- the plan and the included AI ---------- */

function meter(leftUsd, totalUsd, label) {
  const ratio = totalUsd > 0 ? Math.max(0, Math.min(1, leftUsd / totalUsd)) : 0;
  const low = ratio < 0.15;
  return el('div', { class: `acct-meter${low ? ' low' : ''}`, role: 'meter', 'aria-label': label, 'aria-valuemin': '0', 'aria-valuemax': String(totalUsd), 'aria-valuenow': String(leftUsd), 'aria-valuetext': `${money(leftUsd)} of ${money(totalUsd)} left` },
    el('span', { class: 'fill', style: { width: `${(ratio * 100).toFixed(1)}%` } }));
}

// Where Plus was bought (the plan's `source`), as the plan's line says it.
const SOURCE_WORDS = { app_store: 'bought in the iPhone app', stripe: 'billed on askeden.com', both: 'in the App Store and on askeden.com' };

// Stripe Checkout or its Customer Portal: askeden.com makes the session, then the browser goes there.
async function openBilling(button, kind) {
  button = button || el('button'); // from the ring popover or the palette: no button of its own
  const label = button.textContent;
  button.disabled = true;
  button.textContent = kind === 'checkout' ? 'Opening checkout…' : 'Opening billing…';
  if (kind === 'portal' && !document.contains(button)) toast('Opening billing…');
  try {
    const { url } = await post(`/api/web/billing/${kind}`);
    if (!/^https:\/\//.test(url || '') && !/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//.test(url || '')) throw new Error('askeden.com sent back no billing page. Try again.');
    location.assign(url);
  } catch (e) {
    toast(e.message);
    button.disabled = false;
    button.textContent = label;
  }
}

function planSection(a, config = {}) {
  const plan = a.plan || {};
  const u = a.usage || {};
  const plus = plan.active === true || plan.name === 'plus';
  const renews = plan.renews === false ? `Ends ${day(plan.expires)}` : plan.expires ? `Renews ${day(plan.expires)}` : '';
  const head = el('div', 'acct-plan',
    el('div', { class: 'orb', 'aria-hidden': 'true' }),
    el('div', 'grow',
      el('div', 'acct-plan-name', plus ? 'Plus' : 'Free', plus ? el('span', 'acct-badge plus', 'Active') : null),
      el('div', 'acct-sub', plus ? [renews, SOURCE_WORDS[plan.source] || SOURCE_WORDS.app_store].filter(Boolean).join(' · ') : 'Some AI included to try Eden.')));
  // Buying and managing on the web: in a browser once billing is set up; inside the Eden iOS app
  // only with the server's flag (Apple's in-app purchase rules; the US link-out later).
  const web = config.billing === true && (!IN_APP || config.billing_in_app === true);
  const manage = plan.manage || {};
  const portal = Boolean(manage.stripe) && (!IN_APP || config.billing_in_app === true);
  const manageRow = manage.stripe || manage.app_store ? el('div', 'acct-row-actions acct-manage',
    portal ? el('button', { type: 'button', class: 'cap primary', onclick: (e) => openBilling(e.currentTarget, 'portal') }, 'Manage billing') : null,
    manage.stripe && !portal ? el('span', 'acct-sub', 'Billing is managed at askeden.com in a browser.') : null,
    manage.app_store ? el('a', { class: 'cap', href: manage.app_store, target: '_blank', rel: 'noopener' }, 'Manage in the App Store') : null) : null;
  const warnings = [
    plan.payment_failed ? el('div', 'sp-warn acct-notice', el('b', '', 'Your last payment didn’t go through'), `Update your card ${portal ? 'in Manage billing' : 'at askeden.com'}, or Plus stops in a few days.`) : null,
    plan.source === 'both' ? el('p', 'sp-note', 'You’re paying for Plus twice: in the App Store and on askeden.com. Cancel one of them.') : null,
  ];

  let allowance;
  if (plus) {
    allowance = el('div', 'acct-allow',
      el('div', 'acct-row-top', el('span', 'acct-k', 'Included AI this month'), el('b', 'acct-v', `${money(u.left_usd)} left`)),
      meter(u.left_usd || 0, u.budget_usd || 0, 'Included AI left this month'),
      el('div', 'acct-sub', `${money(u.left_usd)} of ${money(u.budget_usd)}${u.period_end ? ` · starts again ${day(u.period_end)}` : ''}`));
  } else {
    const total = typeof u.trial_usd === 'number' ? u.trial_usd : null; // the trial's size, when the server says it
    allowance = el('div', 'acct-allow',
      el('div', 'acct-row-top', el('span', 'acct-k', 'Trial AI'), el('b', 'acct-v', `${money(u.trial_left_usd)} left`)),
      total ? meter(u.trial_left_usd || 0, total, 'Trial AI left') : null,
      el('div', 'acct-sub', total ? `${money(u.trial_left_usd)} of ${money(total)} · used once, not monthly` : 'Used once, not monthly.'));
  }

  const iPhone = (a.devices || []).some((d) => d.kind === 'iphone');
  const included = typeof u.plus_usd === 'number' ? money(u.plus_usd) : 'more';
  const price = a.plus && typeof a.plus.price_usd === 'number' ? `$${a.plus.price_usd}` : '$20';
  let getPlus = null;
  if (!plus && web) {
    getPlus = el('div', 'acct-plus',
      el('div', 'grow',
        el('b', '', 'Plus'),
        el('p', '', `Includes ${included} of AI every month. Pay by card with Stripe; cancel any time.`),
        el('p', 'acct-alt', 'or in the J.A.R.V.I.S. iPhone app')),
      el('button', { type: 'button', class: 'btn primary', onclick: (e) => openBilling(e.currentTarget, 'checkout') }, `Get Plus: ${price}/month`));
  } else if (!plus) {
    getPlus = el('div', 'acct-plus',
      el('div', 'grow',
        el('b', '', 'Get Plus in the J.A.R.V.I.S. iPhone app'),
        el('p', '', `Plus includes ${included} AI every month. It’s bought in the J.A.R.V.I.S. app for iPhone (Settings › Account), with your Apple ID${config.billing === true ? '.' : '; askeden.com takes no payments.'}`)),
      iPhone ? null : el('a', { class: 'btn primary', href: '/jarvis/iphone', target: '_blank', rel: 'noopener' }, 'Get the iPhone app'));
  }

  return el('section', { class: 'set-sec', 'aria-labelledby': 'acctPlanH' }, el('h3', { id: 'acctPlanH' }, 'Plan'),
    ...warnings.filter(Boolean),
    el('div', 'icard acct-card', head, allowance, manageRow),
    el('p', 'sp-note', 'Chats on your own keys don’t use your allowance (Settings › Models & API keys).'), getPlus);
}

/* ---------- devices and browsers ---------- */

/** A two-step button: the first press asks, in place; the second does it. */
function confirmButton(label, question, run, { danger = true } = {}) {
  const box = el('span', 'acct-confirm');
  const first = () => box.replaceChildren(el('button', { type: 'button', class: `cap${danger ? ' rev' : ''}`, onclick: ask }, label));
  const ask = () => {
    const yes = el('button', { type: 'button', class: 'cap rev', onclick: async () => {
      if (busy) return;
      busy = true;
      yes.disabled = true;
      yes.textContent = 'Working…';
      try { await run(); } catch (e) { toast(e.message); first(); } finally { busy = false; }
    } }, label);
    box.replaceChildren(el('span', 'acct-q', question), el('button', { type: 'button', class: 'cap', onclick: () => { first(); box.querySelector('button').focus(); } }, 'Cancel'), yes);
    yes.focus();
  };
  first();
  return box;
}

function deviceRow(d) {
  const web = d.kind === 'web';
  const name = String(d.name || (web ? 'A browser' : APPS[d.kind] || 'A device')).replace(/^Eden on the web: /, '');
  const facts = [web ? 'Browser' : APPS[d.kind] || d.kind, ago(d.last_seen), web && d.expires ? left(d.expires) : ''].filter(Boolean).join(' · ');
  let action;
  if (web && d.this) {
    action = confirmButton('Sign out', 'Sign out here?', async () => { await Sync.forgetAllKeys(); await post('/api/web/signout'); location.replace(HOME()); });
  } else if (web) {
    action = confirmButton('Sign out', 'Sign it out?', async () => { await post(`/api/web/devices/${encodeURIComponent(d.id)}/signout`); toast('Signed that browser out'); draw(); });
  } else {
    action = el('span', 'acct-note', 'Remove in the J.A.R.V.I.S. app');
  }
  return el('li', `acct-dev${d.this ? ' this' : ''}`,
    el('span', 'acct-ico', glyph(d.kind)),
    el('div', 'grow', el('div', 'p-n', name, d.this ? el('span', 'acct-badge', 'This browser') : null), el('div', 'p-c', facts)),
    action);
}

function devicesSection(a) {
  const devices = (a.devices || []).slice().sort((x, y) => (y.this ? 1 : 0) - (x.this ? 1 : 0) || (x.kind === 'web' ? 1 : 0) - (y.kind === 'web' ? 1 : 0));
  const browsers = devices.filter((d) => d.kind === 'web').length;
  return el('section', { class: 'set-sec', 'aria-labelledby': 'acctDevH' }, el('h3', { id: 'acctDevH' }, 'Devices and browsers'),
    el('div', 'icard acct-card', el('ul', 'acct-list', ...devices.map(deviceRow))),
    el('div', 'acct-foot',
      el('p', 'sp-note', 'Browsers stay signed in for 30 days. Your iPhone, iPad, Watch and Mac are removed in the J.A.R.V.I.S. app (Settings › Account).'),
      browsers ? confirmButton('Sign out everywhere', browsers === 1 ? 'Sign out this browser?' : `Sign out all ${browsers} browsers, this one too?`, async () => { await Sync.forgetAllKeys(); await post('/api/web/signout-everywhere'); location.replace(HOME()); }) : null));
}

/* ---------- connected apps (Eden Messenger's @Eden: site/src/accounts/scoped.js) ---------- */

function appRow(a, again) {
  const name = a.name || a.client || 'An app';
  const facts = [a.scope === 'ask' ? 'Can ask Eden' : a.scope, a.last_used ? ago(a.last_used).replace(/^active/, 'used') : 'not used yet', a.created ? `connected ${day(a.created)}` : '', a.expires ? left(a.expires) : ''].filter(Boolean).join(' · ');
  return el('li', 'acct-dev',
    el('span', 'acct-ico', glyph('app')),
    el('div', 'grow', el('div', 'p-n', name), el('div', 'p-c', facts)),
    confirmButton('Revoke', `Disconnect ${name}?`, async () => { await post(`/api/web/apps/${encodeURIComponent(a.id)}/revoke`); toast(`${name} disconnected`); again(); }));
}

/** Apps connected to this account (GET /api/web/apps), each with Revoke; loads on its own. */
function appsSection() {
  const box = el('div', 'acct-apps', el('div', 'muted', 'Loading…'));
  const paint = async () => {
    let res;
    try { res = await call('/api/web/apps'); } catch { fill(box, el('p', 'sp-note', 'Can’t reach askeden.com. Check your connection.')); return; }
    if (res.status === 401) { location.replace(HOME()); return; }
    const body = await read(res);
    if (!res.ok) { fill(box, el('p', 'sp-note', `Couldn’t load your connected apps: ${body.error || `askeden.com said ${res.status}.`}`)); return; }
    const apps = Array.isArray(body.connections) ? body.connections : [];
    fill(box,
      apps.length ? el('div', 'icard acct-card', el('ul', 'acct-list', ...apps.map((a) => appRow(a, paint)))) : null,
      el('p', 'sp-note', apps.length
        ? 'Each one can only ask Eden about what you choose to send it, on your included AI; none can read your chats, mail, calendar, notes or account. Revoking one stops it at once.'
        : 'None. When an app such as Eden Messenger connects to Eden (@Eden in a conversation), it shows here, with Revoke.'));
  };
  paint();
  return el('section', { class: 'set-sec', 'aria-labelledby': 'acctAppsH' }, el('h3', { id: 'acctAppsH' }, 'Connected apps'), box);
}

/* ---------- ways to sign in ---------- */

function methodsSection(a, config) {
  const ids = Array.isArray(a.identities) ? a.identities : [];
  const rows = Object.entries(PROVIDERS).map(([p, label]) => {
    const linked = ids.find((i) => i.provider === p);
    if (linked) {
      const last = ids.length <= 1;
      const unlink = last
        ? el('button', { type: 'button', class: 'cap', disabled: true, title: 'Your only way to sign in: add another first', 'aria-describedby': 'acctLastNote' }, 'Unlink')
        : confirmButton('Unlink', `Stop signing in with ${label}?`, async () => { await post(`/api/web/identities/${p}/unlink`); toast(`${label} unlinked`); draw(); });
      return el('li', 'acct-dev', el('span', 'acct-ico', mark(p)),
        el('div', 'grow', el('div', 'p-n', label), el('div', 'p-c', [linked.email || ({ apple: 'Apple ID', google: 'Google account', passkey: 'On your device or password manager' })[p], linked.added ? `added ${day(linked.added)}` : ''].filter(Boolean).join(' · '))),
        unlink);
    }
    const ready = config && config[p] === true && (p !== 'passkey' || typeof window.PublicKeyCredential === 'function');
    const add = p === 'passkey'
      ? el('button', { type: 'button', class: 'cap primary', onclick: (e) => addPasskey(e.currentTarget) }, 'Add a passkey')
      : el('a', { class: 'cap primary', href: `/api/web/${p}?link=1`, onclick: isMock ? (e) => mockLink(e, p) : undefined }, `Add ${label}`);
    return el('li', 'acct-dev off', el('span', 'acct-ico', mark(p)),
      el('div', 'grow', el('div', 'p-n', label), el('div', 'p-c', ready ? (p === 'passkey' ? 'Sign in with Face ID, Touch ID or your device’s PIN' : 'Not linked') : 'Not available yet')),
      ready ? add : null);
  });
  const last = ids.length <= 1;
  return el('section', { class: 'set-sec', 'aria-labelledby': 'acctWaysH' }, el('h3', { id: 'acctWaysH' }, 'Ways to sign in'),
    el('div', 'icard acct-card', el('ul', 'acct-list', ...rows)),
    el('p', { class: 'sp-note', id: 'acctLastNote' }, `${last && ids.length ? 'This is your only way to sign in, so it can’t be unlinked. ' : ''}Any of them opens the same account. A browser can also be approved from the J.A.R.V.I.S. app on your iPhone.`),
    el('p', 'sp-note', el('a', { href: '/privacy', target: '_blank', rel: 'noopener' }, 'Privacy Policy'), ' · ', el('a', { href: '/terms', target: '_blank', rel: 'noopener' }, 'Terms of Service'), ' · ', el('a', { href: '/download' }, 'Download apps')));
}

/* ---------- deleting the account (POST /api/web/account/delete; site/src/eden/session.js) ---------- */

/** Delete account: the person types DELETE, then everything goes and every device is signed out. */
function deleteSection() {
  const input = el('input', { type: 'text', class: 'acct-del-input', autocomplete: 'off', autocapitalize: 'characters', spellcheck: 'false', 'aria-label': 'Type DELETE to confirm', placeholder: 'DELETE' });
  const go = el('button', { type: 'button', class: 'cap rev', disabled: true }, 'Delete my account');
  input.addEventListener('input', () => { go.disabled = input.value.trim() !== 'DELETE'; });
  let busy = false;
  go.addEventListener('click', async () => {
    if (busy || input.value.trim() !== 'DELETE') return;
    busy = true;
    go.disabled = true;
    go.textContent = 'Deleting…';
    try {
      await post('/api/web/account/delete', { confirm: 'DELETE' });
      try { await Sync.forgetAllKeys(); } catch { /* the account is gone either way */ }
      location.replace(HOME());
    } catch (e) {
      // Signed in too long ago: sign out, then back here after a fresh sign-in.
      if (e.code === 'sign_in_again') {
        toast(e.message);
        try { await Sync.forgetAllKeys(); await post('/api/web/signout'); } catch { /* signed out either way below */ }
        location.replace('/signin?return=%2Faccount');
        return;
      }
      toast(e.message);
      go.textContent = 'Delete my account';
      go.disabled = input.value.trim() !== 'DELETE';
    } finally { busy = false; }
  });
  return el('section', { class: 'set-sec acct-delete', 'aria-labelledby': 'acctDelH' }, el('h3', { id: 'acctDelH' }, 'Delete account'),
    el('p', 'sp-note', 'Deletes your Eden account for good (you’ll be asked to sign in again if you signed in more than 10 minutes ago): every device and browser is signed out, and your account’s data, ways to sign in, passkeys and published pages are deleted. Plus bought on askeden.com is cancelled; Plus from the App Store is cancelled in your iPhone’s Settings. This can’t be undone.'),
    el('div', 'acct-foot', el('label', 'sp-note', 'Type DELETE to confirm ', input), go));
}

/* ---------- a passkey for this account (WebAuthn) ---------- */

const b64u = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const fromB64u = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4)), (c) => c.charCodeAt(0));

/** "Add a passkey": askeden.com's options, the browser makes it (Face ID, Touch ID, a PIN), askeden.com checks and links it. */
async function addPasskey(button) {
  if (isMock) { toast('Passkeys need askeden.com.'); return; }
  button.disabled = true;
  try {
    const o = await post('/api/web/passkey/options', { mode: 'add' });
    const pk = o.publicKey;
    const made = await navigator.credentials.create({ publicKey: { ...pk, challenge: fromB64u(pk.challenge), user: { ...pk.user, id: fromB64u(pk.user.id) } } });
    if (!made) return;
    const r = made.response;
    await post('/api/web/passkey/verify', { credential: { id: made.id, rawId: b64u(made.rawId), type: made.type, response: { clientDataJSON: b64u(r.clientDataJSON), attestationObject: b64u(r.attestationObject) } } });
    toast('Passkey added');
    draw();
  } catch (e) {
    toast(e && e.name === 'NotAllowedError' ? 'The passkey was cancelled. Nothing changed.' : e && e.name === 'InvalidStateError' ? 'This device already has a passkey for Eden.' : (e && e.message) || 'The passkey wasn’t added.');
  } finally {
    button.disabled = false;
  }
}

// ?mock=1: "Add" can't go to Apple or Google; the mock links it at once.
async function mockLink(e, p) {
  e.preventDefault();
  await call(`/api/web/${p}?link=1`);
  draw(`${PROVIDERS[p]} added (simulated).`);
}

/* ---------- #account ---------- */

let pendingInvite = null; // { kind: 'delegate' | 'space', code } from an invitation link

function fromHash() {
  const inv = /^#(delegate|space)=([0-9A-Za-z-]{12,16})$/.exec(location.hash);
  if (inv) {
    history.replaceState(null, '', location.pathname + location.search);
    pendingInvite = { kind: inv[1], code: inv[2].toUpperCase() };
    return { notice: inv[1] === 'space' ? 'You’re invited to a team space. Add your name and join it below (Team spaces).' : 'You’re invited to help someone with their Eden. Accept it below (Delegates).' };
  }
  // #plus (the front page's "Get Plus", through sign-in): the Plan, ready to buy.
  if (location.hash === '#plus') {
    history.replaceState(null, '', location.pathname + location.search);
    return { notice: null, focusPlus: true };
  }
  const m = /^#account(?:\?(.*))?$/.exec(location.hash);
  if (!m) return null;
  const q = new URLSearchParams(m[1] || '');
  history.replaceState(null, '', location.pathname + location.search);
  if (q.has('plus')) return { notice: null, focusPlus: true };
  const p = PROVIDERS[q.get('provider')] || 'sign-in';
  const code = q.get('error');
  if (code) return { notice: Object.hasOwn(ERRORS, code) ? ERRORS[code](p) : `Adding ${p === 'sign-in' ? 'that sign-in' : p} didn’t finish. Try again.` };
  // Back from Stripe Checkout (eden/billing.js success_url, cancel_url).
  if (q.get('billing') === 'success') return { notice: 'Thank you! Your payment went through, and Plus is being switched on.', ok: true, waitPlus: true };
  if (q.get('billing') === 'cancelled') return { notice: 'Checkout was cancelled. Nothing was charged.' };
  if (q.get('linked')) toast(`${p} added`);
  return { notice: null };
}

/** The acting state changed under the page: the panels it hides or shows, and Jarvis's status. */
function acted() {
  ui.renderSidebar();
  dispatchEvent(new CustomEvent('eden:acting'));
}

/**
 * Finds out whether this Eden has accounts (askeden.com, or ?mock=1) and, if so, shows the
 * Settings button and opens the page for #account. Call once meta has loaded.
 * handlers: { beforeOpen() } (closes phone overlays).
 */
export async function initAccount(handlers = {}) {
  H = handlers;
  addEventListener('hashchange', () => { if (available) { const h = fromHash(); if (h) openAccount(h); } });
  // Back from Stripe with the browser's Back button: the page as it was (its buttons still
  // "Opening…") comes out of the back-forward cache, so it's drawn again.
  addEventListener('pageshow', (e) => { if (e.persisted && accountOpen()) draw(); });
  if (!isMock && !(state.meta && state.meta.hosted)) { if (setActing(null)) acted(); return; } // the local server: no accounts
  let res;
  try { res = await call('/api/web/account'); } catch { return; }
  if (!res.ok) return;
  available = true;
  addEventListener('eden:get-plus', () => openAccount({ focusPlus: true }));
  addEventListener('eden:manage-billing', () => openBilling(null, 'portal'));
  enableWorkflowSharing(); // Workflows › Share to a space… (spaces.js)
  const me = await read(res);
  // What the page assumed at load (acting.js keeps it between loads) against what's true now.
  if (setActing(me.acting || null)) acted();
  // Acting for someone: say so everywhere, and start a space's chats at its router level.
  if (me.acting) {
    actingPill(me.acting);
    const level = Number(sessionStorage.getItem('eden:space-level'));
    if (me.acting.type === 'space' && level >= 1 && level <= 5) state.settings.level = level;
  } else {
    sessionStorage.removeItem('eden:space-level');
    // The access this browser was using ended (revoked, run out, removed from the space).
    if (me.acting_ended) { post('/api/web/deleg/leave').catch(() => {}); toast('Your access to that account or space ended. You’re back on your own.'); }
  }
  call('/api/web/config').then((c) => (c.ok ? read(c) : {})).catch(() => ({})).then((config) => setPlanOffer(me, config));
  if (!isMock) Sync.initSync(me.account_id);
  const button = $('btnAccount');
  if (button) {
    button.hidden = false;
    button.addEventListener('click', () => { if (H.closeSettings) H.closeSettings(); openAccount(); });
  }
  const h = fromHash();
  if (h) openAccount(h);
}
