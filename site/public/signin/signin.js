// Eden's sign-in page (askeden.com/signin): Continue with Apple, Continue with Google (each
// only when /api/web/config says it's set up), and Approve from your iPhone: a code (and its
// QR code) shown until the J.A.R.V.I.S. app approves this browser, then Eden opens. The code's
// secret and, once signed in, the session are HttpOnly cookies: nothing here ever holds them.
// ?return=<path> (Eden Messenger's "Connect Eden" page, a deep link like /#tasks): where every
// way in goes back to once signed in, if return.js finds it safe; else Eden's home.

import { safeReturn } from './return.js';

const $ = (id) => document.getElementById(id);
const back = safeReturn(new URLSearchParams(location.search).get('return'));
const POLL_MS = 2500;
let expiresAt = 0;
let pollTimer = 0;
let clockTimer = 0;

// ── a sign-in that came back with ?error=<code> (the provider callbacks) ──
//
// Only known codes are shown, in plain words: the page never prints text taken from its URL.

const PROVIDER = { apple: 'Apple', google: 'Google' };
const ERRORS = {
  cancelled: 'You cancelled the sign-in. Nothing changed.',
  access_denied: 'You cancelled the sign-in. Nothing changed.',
  expired: 'That sign-in took too long or was started in another window. Try again.',
  state: 'That sign-in took too long or was started in another window. Try again.',
  taken: (p) => `This ${p ? `${p} ` : ''}account is already used by another Eden account. Sign in with it to open that one, or choose a different ${p ? `${p} ` : ''}account.`,
  identity_taken: (p) => ERRORS.taken(p),
  not_allowed: 'Eden on the web isn’t open to this account yet.',
  not_set_up: 'That way of signing in isn’t ready yet. Use another one below.',
  rate_limited: 'Too many tries from this network. Wait a minute, then try again.',
  email: 'Google didn’t share a verified email address for that account. Try another way.',
  signed_out: 'You were signed out. Sign in again to carry on.',
  server: 'Something went wrong on our side. Try again in a moment.',
};

function showError() {
  const q = new URLSearchParams(location.search);
  const code = q.get('error');
  if (!code) return;
  const words = Object.hasOwn(ERRORS, code) ? ERRORS[code] : 'That sign-in didn’t finish. Try again.';
  const provider = PROVIDER[q.get('provider')] || '';
  $('alert').textContent = typeof words === 'function' ? words(provider) : words;
  $('alert').hidden = false;
  // A reload shouldn't show it again (where to go back to stays).
  history.replaceState(null, '', back === '/' ? location.pathname : `${location.pathname}?return=${encodeURIComponent(back)}`);
}

// ── Approve from your iPhone (the code and QR code) ──

function status(text, kind = '') {
  const node = $('status');
  node.textContent = text;
  node.className = `status ${kind}`.trim();
}

function drawQr(rows) {
  const ns = 'http://www.w3.org/2000/svg';
  const size = rows.length + 8; // a quiet zone of 4 modules all round
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', `0 0 ${size} ${size}`);
  svg.setAttribute('shape-rendering', 'crispEdges');
  let d = '';
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) if (row[x] === '1') d += `M${x + 4} ${y + 4}h1v1h-1z`;
  });
  const path = document.createElementNS(ns, 'path');
  path.setAttribute('d', d);
  path.setAttribute('fill', '#000');
  svg.append(path);
  $('qr').replaceChildren(svg);
  $('qr').classList.remove('used');
}

async function answer(res) {
  try {
    return await res.json();
  } catch {
    return {};
  }
}

function stop() {
  clearTimeout(pollTimer);
  clearInterval(clockTimer);
}

function ended(words, kind = 'warn') {
  stop();
  status(words, kind);
  $('qr').classList.add('used');
  $('again').hidden = false;
}

function tick() {
  const left = Math.max(0, Math.round((expiresAt - Date.now()) / 1000));
  if (!left) return ended('That code ran out. Get a new one.');
  const m = Math.floor(left / 60);
  const s = String(left % 60).padStart(2, '0');
  status(`Waiting for the app… (code good for ${m}:${s})`);
}

async function poll() {
  let res;
  try {
    res = await fetch('/api/web/link/poll', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}', cache: 'no-store' });
  } catch {
    pollTimer = setTimeout(poll, POLL_MS * 2); // offline for a moment: keep trying while the code lasts
    return;
  }
  if (res.status === 202) {
    pollTimer = setTimeout(poll, POLL_MS);
    return;
  }
  const body = await answer(res);
  if (res.ok && body.status === 'signed_in') {
    stop();
    status('Approved. Opening Eden…', 'ok');
    location.replace(back);
    return;
  }
  if (res.status === 429) {
    pollTimer = setTimeout(poll, 10_000);
    return;
  }
  if (body.code === 'denied') return ended('Turned down in the app. Get a new code to try again.');
  if (body.code === 'expired' || body.code === 'no_link' || body.code === 'not_found') return ended('That code ran out. Get a new one.');
  ended(body.error || `askeden.com said ${res.status}. Get a new code to try again.`);
}

async function start() {
  stop();
  $('again').hidden = true;
  $('code').textContent = '····-····';
  status('Getting a code…');
  let res;
  try {
    res = await fetch('/api/web/link', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}', cache: 'no-store' });
  } catch {
    return ended('Can’t reach askeden.com. Check your connection.');
  }
  const link = await answer(res);
  if (!res.ok || !link.code) return ended(link.error || `askeden.com said ${res.status}.`);
  $('code').textContent = link.code;
  if (Array.isArray(link.qr)) drawQr(link.qr);
  expiresAt = Date.now() + (Number(link.expires_in) || 600) * 1000;
  tick();
  clockTimer = setInterval(tick, 1000);
  pollTimer = setTimeout(poll, POLL_MS);
}

/** Opens the code panel (and gets a code) in place of its button. */
function phone({ focus = true } = {}) {
  $('phone').setAttribute('aria-expanded', 'true');
  $('phone').hidden = true;
  $('link').hidden = false;
  if (focus) $('linkTitle').focus();
  start();
}

// ── which ways in are set up ──

async function config() {
  const ask = new AbortController();
  const late = setTimeout(() => ask.abort(), 4000);
  try {
    const res = await fetch('/api/web/config', { cache: 'no-store', signal: ask.signal });
    return res.ok ? await answer(res) : {};
  } catch {
    return {}; // the code is enough
  } finally {
    clearTimeout(late);
  }
}

async function main() {
  showError();
  $('again').addEventListener('click', start);
  $('phone').addEventListener('click', () => phone());
  const ways = await config();
  $('apple').hidden = ways.apple !== true;
  $('google').hidden = ways.google !== true;
  // Apple and Google come back through the server, which keeps the return address itself.
  if (back !== '/') for (const id of ['apple', 'google']) $(id).href = `/api/web/${id}?return=${encodeURIComponent(back)}`;
  const providers = ways.apple === true || ways.google === true;
  $('ways').removeAttribute('aria-busy');
  $('ways').hidden = !providers;
  $('newHere').hidden = !providers;
  $('newApp').hidden = providers;
  if (providers) {
    // Apple or Google first; the code waits for a click, so no code is made for nothing.
    $('or').hidden = false;
    $('phone').hidden = false;
  } else {
    // Only the code: straight to it, as the page always did.
    phone({ focus: false });
  }
}

main();
