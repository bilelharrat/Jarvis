// Eden's sign-in page (askeden.com/signin): Continue with Apple, Continue with Google (each
// only when /api/web/config says it's set up), and Approve from your iPhone: a code (and its
// QR code) shown until the J.A.R.V.I.S. app approves this browser, then Eden opens. The code's
// secret and, once signed in, the session are HttpOnly cookies: nothing here ever holds them.
// A passkey: "Sign in with a passkey", or "Create an account with a passkey" (WebAuthn, through
// /api/web/passkey/options and /verify). With Turnstile on (config `turnstile`, a site key), its
// widget shows here: Apple and Google then post their start with its token, and a passkey sign-up
// sends it; a new account isn't made without it (accounts/turnstile.js).
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
  verify: 'Finish the check below (it confirms you’re a person), then continue.',
  signups_closed: 'Eden is opening soon — sign-ups are closed for now. If you already have an Eden account, sign in with the way you used before.',
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

// ── Turnstile (only with a site key) ──

let human = null; // { token } once the widget passes; null before, or once it runs out
let turnstileOn = false;

function loadTurnstile(siteKey) {
  turnstileOn = true;
  $('human').hidden = false;
  window.onEdenTurnstile = () => {
    window.turnstile.render('#human', {
      sitekey: siteKey,
      action: 'signup',
      callback: (token) => { human = { token }; },
      'expired-callback': () => { human = null; },
      'error-callback': () => { human = null; },
    });
  };
  const script = document.createElement('script');
  script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit&onload=onEdenTurnstile';
  script.async = true;
  document.head.append(script);
}

function resetTurnstile() {
  human = null;
  if (window.turnstile) window.turnstile.reset('#human');
}

function say(words) {
  $('alert').textContent = words;
  $('alert').hidden = false;
}

/** Apple or Google with Turnstile on: a form post carrying the token (the server checks it). */
function postStart(e, provider) {
  if (!turnstileOn) return; // a plain link, as always
  e.preventDefault();
  if (!human) return say(ERRORS.verify);
  const form = document.createElement('form');
  form.method = 'POST';
  form.action = `/api/web/${provider}`;
  for (const [name, value] of [['cf-turnstile-response', human.token], ['return', back]]) {
    const input = document.createElement('input');
    input.type = 'hidden';
    input.name = name;
    input.value = value;
    form.append(input);
  }
  document.body.append(form);
  form.submit();
}

// ── passkeys ──

const b64u = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const fromB64u = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4)), (c) => c.charCodeAt(0));

/** What the server sends, as navigator.credentials takes it. */
function forBrowser(pk) {
  const out = { ...pk, challenge: fromB64u(pk.challenge) };
  if (pk.user) out.user = { ...pk.user, id: fromB64u(pk.user.id) };
  return out;
}

/** A PublicKeyCredential, as JSON for /api/web/passkey/verify. */
function toJson(c) {
  const r = c.response;
  const response = { clientDataJSON: b64u(r.clientDataJSON) };
  if (r.attestationObject) response.attestationObject = b64u(r.attestationObject);
  if (r.authenticatorData) response.authenticatorData = b64u(r.authenticatorData);
  if (r.signature) response.signature = b64u(r.signature);
  if (r.userHandle) response.userHandle = b64u(r.userHandle);
  return { id: c.id, rawId: b64u(c.rawId), type: c.type, response };
}

async function passkey(mode) {
  $('alert').hidden = true;
  if (mode === 'signup' && turnstileOn && !human) return say(ERRORS.verify);
  const post = (path, body) => fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), cache: 'no-store' });
  try {
    const opened = await post('/api/web/passkey/options', { mode, ...(mode === 'signup' && human ? { turnstile: human.token } : {}) });
    if (mode === 'signup') resetTurnstile(); // a token works once
    const o = await answer(opened);
    if (!opened.ok) return say(o.error || `askeden.com said ${opened.status}. Try again.`);
    const credential = mode === 'signin' ? await navigator.credentials.get({ publicKey: forBrowser(o.publicKey) }) : await navigator.credentials.create({ publicKey: forBrowser(o.publicKey) });
    if (!credential) return;
    const done = await post('/api/web/passkey/verify', { credential: toJson(credential), return: back });
    const v = await answer(done);
    if (!done.ok) return say(v.error || `askeden.com said ${done.status}. Try again.`);
    location.replace(v.to || back);
  } catch (error) {
    if (error && error.name === 'NotAllowedError') return say('The passkey was cancelled or timed out. Nothing changed.');
    if (error && error.name === 'InvalidStateError') return say('This device already has a passkey for Eden. Sign in with it instead.');
    say('That passkey didn’t work here. Try again, or use another way in.');
  }
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
  const passkeys = ways.passkey === true && typeof window.PublicKeyCredential === 'function';
  $('passkey').hidden = !passkeys;
  $('newPasskey').hidden = !passkeys;
  $('passkey').addEventListener('click', () => passkey('signin'));
  $('passkeyNew').addEventListener('click', () => passkey('signup'));
  for (const id of ['apple', 'google']) $(id).addEventListener('click', (e) => postStart(e, id));
  if (typeof ways.turnstile === 'string' && ways.turnstile) loadTurnstile(ways.turnstile);
  // Apple and Google come back through the server, which keeps the return address itself.
  if (back !== '/') for (const id of ['apple', 'google']) $(id).href = `/api/web/${id}?return=${encodeURIComponent(back)}`;
  const providers = ways.apple === true || ways.google === true || passkeys;
  $('ways').removeAttribute('aria-busy');
  $('ways').hidden = !providers;
  // Sign-ups closed (SIGNUPS, docs/web-auth.md): existing accounts only, said once, no "make an account".
  const closed = ways.signups === 'closed';
  if (closed) $('newPasskey').hidden = true;
  $('newHere').hidden = !providers || closed;
  $('newApp').hidden = providers || closed;
  $('closed').hidden = !closed;
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
