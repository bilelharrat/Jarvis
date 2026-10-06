// Eden's sign-in page: asks askeden.com for a code, shows it (and its QR code) until the
// J.A.R.V.I.S. app approves this browser, then opens Eden. The code's secret and, once
// approved, the session are HttpOnly cookies: nothing here ever holds them.

const $ = (id) => document.getElementById(id);
const POLL_MS = 2500;
let expiresAt = 0;
let pollTimer = 0;
let clockTimer = 0;

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
    location.replace('/');
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

async function apple() {
  try {
    const res = await fetch('/api/web/config', { cache: 'no-store' });
    const config = await answer(res);
    if (config.apple) $('appleBox').hidden = false;
  } catch {
    // the code is enough
  }
}

$('again').addEventListener('click', start);
start();
apple();
