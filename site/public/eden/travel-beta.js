// Eden Travel's private beta, the page's half (server: site src/travel/beta.js).
// - "Something's wrong": a small button for the Travel bar (wrongButton) opening a sheet: what happened, an optional
//   picture the person attaches (a screenshot they took; the page can't capture itself reliably), and what was on screen
//   (view, trip id, day, the last error codes this page saw, its version), listed before sending. The trip's own details
//   (title, dates, stop names) go only when the box is ticked; it starts unticked. Sent to askeden.com only.
// - Usage counts: count('view:map') etc. (site beta.js FEATURES; others are dropped there). Kept in memory, sent at most
//   once a minute and when the page is hidden: names and numbers only.
// - noteError(e): the last error codes, for the report. Uncaught errors are noted by themselves.
//
// travel.js hands it, through init: { S }. Nothing here shows in the Eden iPhone app (travel.js keeps Travel behind !IN_APP).

import { el, ico, toast } from './util.js';
import { apiUrl, getJSON, postJSON } from './api.js';

let C = null;
export function init(ctx) {
  C = ctx;
  if (typeof document !== 'undefined' && !document.querySelector('link[href$="travel-beta.css"]')) document.head.append(el('link', { rel: 'stylesheet', href: 'travel-beta.css' }));
}

const PATH = '/api/chat/travel/beta';
const IMAGE_MAX = 4 * 1024 * 1024; // site beta.js IMAGE_MAX
const LONG_EDGE = 2000; // a larger picture is shrunk to this before it's sent, when the browser can
const TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif'];

/* ---------- the last errors the page saw ---------- */

const ERRORS = [];
/** An error's code (the server's `code`, an HTTP status, or a short message), kept with the last nine. */
export function errorCode(e) {
  if (!e) return '';
  if (typeof e === 'string') return e.slice(0, 160);
  const code = e.code || (e.status !== undefined && e.status !== null ? `http ${e.status}` : '') || e.name || '';
  const msg = String(e.message || '').replace(/\s+/g, ' ').slice(0, 100);
  return `${code}${code && msg ? ': ' : ''}${msg}`.slice(0, 160);
}
export function noteError(e) {
  const c = errorCode(e);
  if (!c) return;
  ERRORS.push(`${new Date().toISOString().slice(11, 19)} ${c}`);
  if (ERRORS.length > 9) ERRORS.shift();
}
if (typeof addEventListener !== 'undefined') {
  addEventListener('error', (e) => noteError(e.error || e.message));
  addEventListener('unhandledrejection', (e) => noteError(e.reason));
}

/* ---------- what was on screen ---------- */

/** The page's version: the iPhone app's own (its user agent), else the build the page names, else "web". */
export function pageVersion(ua = typeof navigator !== 'undefined' ? navigator.userAgent : '', doc = typeof document !== 'undefined' ? document : null) {
  const app = /\b(EdenTravel|EdenApp|AskEdenTravel)\/([\w.]+)/.exec(ua || '');
  if (app) return `${app[1]} ${app[2]}`;
  const meta = doc && doc.querySelector && doc.querySelector('meta[name="eden-build"]');
  return meta && meta.content ? `web ${meta.content}` : 'web';
}

/** What goes with every report (site beta.js cleanContext checks each field again). */
export function screenContext(S, env = {}) {
  const loc = env.location || (typeof location !== 'undefined' ? location : { hostname: '', pathname: '/' });
  const win = env.window || (typeof window !== 'undefined' ? window : { innerWidth: 0, innerHeight: 0 });
  return {
    view: S && S.data ? (S.memView ? 'memories' : S.view || null) : null,
    trip: S ? (S.member ? S.member.trip : S.id) || null : null,
    shared: Boolean(S && S.member),
    day: S && S.data && Number.isInteger(S.day) ? S.day : null,
    errors: [...(env.errors || ERRORS)],
    version: env.version || pageVersion(),
    host: loc.hostname,
    path: loc.pathname,
    standalone: Boolean(env.standalone ?? (typeof matchMedia !== 'undefined' && matchMedia('(display-mode: standalone)').matches)),
    offline: Boolean(S && S.offline) || (typeof navigator !== 'undefined' && navigator.onLine === false),
    viewport: win.innerWidth ? `${Math.round(win.innerWidth)}x${Math.round(win.innerHeight)}` : null,
  };
}

/** The trip's details, only when the person ticks the box: title, dates, travellers, each day's stops (name, time, kind,
 *  booked or not). No notes, no documents, no money or booking references. */
export function tripDetails(trip) {
  if (!trip || typeof trip !== 'object') return null;
  return {
    title: String(trip.title || '').slice(0, 120), destination: String(trip.destination || '').slice(0, 120), start: trip.start || null, travelers: trip.travelers ?? null,
    days: (trip.days || []).slice(0, 60).map((d) => ({
      title: String(d.title || '').slice(0, 80),
      stops: (d.stops || []).slice(0, 40).map((s) => ({ name: String((s.place && s.place.name) || s.name || '').slice(0, 120), at: s.at || null, kind: s.kind || null, mode: s.mode || null, booked: Boolean(s.booked) })),
    })),
  };
}

/** The context as lines the person reads before sending (nothing is sent that isn't listed). */
export function contextLines(ctx, { consent = false, hasTrip = false } = {}) {
  const VIEW = { workspace: 'Day', board: 'Journey', map: 'Map', companion: 'Today', discover: 'Explore', group: 'Group', memories: 'Memories' };
  return [
    ctx.view ? `Screen: ${VIEW[ctx.view] || ctx.view}${Number.isInteger(ctx.day) ? `, day ${ctx.day + 1}` : ''}` : 'Screen: no trip open',
    ctx.trip ? `Trip id: ${ctx.trip}${ctx.shared ? ' (shared with you)' : ''}` : null,
    `Version: ${ctx.version} · ${ctx.host}${ctx.path}${ctx.viewport ? ` · ${ctx.viewport}` : ''}${ctx.offline ? ' · offline' : ''}`,
    ctx.errors.length ? `Last errors: ${ctx.errors.join(' · ')}` : 'Last errors: none',
    hasTrip ? (consent ? 'Trip details: title, dates and stop names' : 'Trip details: not included') : null,
  ].filter(Boolean);
}

/* ---------- the picture ---------- */

const b64 = (buf) => {
  const bytes = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
};

/** A picked file as { data, type, bytes }: shrunk to LONG_EDGE as JPEG where the browser can, else as it is (≤ 4 MB). */
async function readPicture(file) {
  if (!TYPES.includes(file.type) && !/\.(jpe?g|png|webp|heic|heif)$/i.test(file.name || '')) throw new Error('Attach a JPEG, PNG, WebP or HEIC picture.');
  try {
    if (typeof createImageBitmap === 'function' && typeof OffscreenCanvas === 'function') {
      const bmp = await createImageBitmap(file);
      const k = Math.min(1, LONG_EDGE / Math.max(bmp.width, bmp.height));
      if (k < 1 || file.size > IMAGE_MAX) {
        const cv = new OffscreenCanvas(Math.round(bmp.width * k), Math.round(bmp.height * k));
        cv.getContext('2d').drawImage(bmp, 0, 0, cv.width, cv.height);
        const blob = await cv.convertToBlob({ type: 'image/jpeg', quality: 0.85 });
        if (blob.size <= IMAGE_MAX) return { data: b64(await blob.arrayBuffer()), type: 'image/jpeg', bytes: blob.size };
      }
    }
  } catch { /* the browser can't read it: sent as it is below */ }
  if (file.size > IMAGE_MAX) throw new Error('The picture can be 4 MB at most.');
  return { data: b64(await file.arrayBuffer()), type: file.type, bytes: file.size };
}

/* ---------- the sheet ---------- */

/** The Travel bar's button. */
export function wrongButton(cls = 'tv-pill') {
  return el('button', { type: 'button', class: `${cls} tvb-wrong`, 'data-k': 'wrong', title: 'Something’s wrong? Tell us', 'aria-label': 'Something’s wrong? Tell us', onclick: () => openWrong() }, ico('info', 14), el('span', 'tvb-wrong-label', 'Something’s wrong'));
}

export function openWrong() {
  const S = (C && C.S) || {};
  document.querySelector('.tvb-sheet')?.remove();
  const back = document.activeElement;
  const ctx = screenContext(S);
  const trip = S.data && S.data.trip ? S.data.trip : null;
  let picture = null;
  let sending = false;
  const close = () => { sheet.remove(); if (back && back.focus) back.focus(); };
  const what = el('textarea', { id: 'tvbWhat', class: 'tvb-what', rows: '5', maxlength: '4000', required: true, placeholder: 'What were you doing, and what went wrong?' });
  const file = el('input', { type: 'file', id: 'tvbPic', accept: 'image/*', class: 'tvb-file' });
  const picNote = el('p', { class: 'tv-fine', role: 'status', 'aria-live': 'polite' }, 'Optional. A screenshot you took helps most.');
  const consent = el('input', { type: 'checkbox', id: 'tvbConsent' });
  const list = el('ul', 'tvb-ctx');
  const say = el('p', { class: 'tv-note', role: 'status', 'aria-live': 'polite' });
  const send = el('button', { type: 'submit', class: 'tv-btn primary' }, 'Send');
  const drawList = () => list.replaceChildren(...contextLines(ctx, { consent: consent.checked, hasTrip: Boolean(trip) }).map((l) => el('li', '', l)));
  consent.addEventListener('change', drawList);
  file.addEventListener('change', async () => {
    picture = null;
    const f = file.files && file.files[0];
    if (!f) { picNote.textContent = 'Optional. A screenshot you took helps most.'; return; }
    picNote.textContent = 'Reading the picture…';
    try { picture = await readPicture(f); picNote.textContent = `Attached: ${f.name || 'picture'} (${Math.max(1, Math.round(picture.bytes / 1024))} KB).`; }
    catch (e) { file.value = ''; picNote.textContent = String(e.message || e); }
  });
  const submit = async (e) => {
    e.preventDefault();
    if (sending) return;
    const text = what.value.trim();
    if (text.length < 3) { say.textContent = 'Say what happened, in a few words.'; what.focus(); return; }
    sending = true;
    send.disabled = true;
    say.textContent = 'Sending…';
    try {
      await postJSON(PATH, { action: 'feedback', args: { text, context: ctx, consent: consent.checked && Boolean(trip), trip: consent.checked ? tripDetails(trip) : null, image: picture ? { data: picture.data } : null } }, { timeout: 60_000 });
      count('feedback');
      close();
      toast('Thank you. Your report is with the Eden team.');
    } catch (err) {
      noteError(err);
      say.textContent = String((err && err.message) || err);
      send.disabled = false;
      sending = false;
    }
  };
  const sheet = el('div', { class: 'tvb-sheet', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'tvbTitle', tabindex: '-1', onkeydown: (e) => { if (e.key === 'Escape') close(); }, onclick: (e) => { if (e.target === sheet) close(); } },
    el('form', { class: 'tvb-card glass-card', onsubmit: submit, novalidate: true },
      el('div', 'tvb-top', el('h2', { id: 'tvbTitle' }, 'Something’s wrong?'), el('button', { type: 'button', class: 'tv-x', 'aria-label': 'Close', onclick: close }, ico('x', 16))),
      el('label', { for: 'tvbWhat', class: 'tvb-label' }, 'What happened'), what,
      el('label', { for: 'tvbPic', class: 'tvb-label' }, 'A picture'), file, picNote,
      trip ? el('label', { class: 'tvb-check' }, consent, el('span', '', 'Include this trip’s details (its title, dates and stop names) so we can see what you saw')) : null,
      el('div', 'tvb-label', 'Sent with it'), list,
      el('p', 'tv-fine', 'Goes to the Eden team only, on askeden.com. No other company sees it.'),
      say,
      el('div', 'tv-acts', send, el('button', { type: 'button', class: 'tv-btn quiet', onclick: close }, 'Cancel'))));
  drawList();
  document.body.append(sheet);
  what.focus();
}

/* ---------- usage counts ---------- */

const COUNTS = new Map();
let timer = null;
/** One use of a feature (site beta.js FEATURES names it). */
export function count(feature) {
  if (!/^[a-z][a-z0-9:-]{1,39}$/.test(String(feature || ''))) return;
  COUNTS.set(feature, (COUNTS.get(feature) || 0) + 1);
  if (!timer && typeof setTimeout !== 'undefined') { timer = setTimeout(() => { timer = null; flush(); }, 60_000); timer.unref?.(); }
}
/** The counts so far, emptied (what one send carries). */
export function takeCounts() {
  const out = Object.fromEntries(COUNTS);
  COUNTS.clear();
  return out;
}
export function flush({ leaving = false } = {}) {
  if (!COUNTS.size) return;
  const counts = takeCounts();
  const body = JSON.stringify({ action: 'usage', args: { counts } });
  // the page going away: a request that outlives it (keepalive), same site, same session cookie
  if (leaving && typeof fetch === 'function') { fetch(apiUrl(PATH), { method: 'POST', keepalive: true, credentials: 'same-origin', headers: { 'content-type': 'application/json', 'X-Jarvis-Chat': '1' }, body }).catch(() => {}); return; }
  postJSON(PATH, { action: 'usage', args: { counts } }, { timeout: 15_000 }).catch(() => {}); // lost counts are only counts
}
if (typeof document !== 'undefined') document.addEventListener('visibilitychange', () => { if (document.hidden) flush({ leaving: true }); });

/** { on, member } from the server; a failure reads as "not in a beta" (the server gates the routes anyway). */
export async function betaStatus() {
  try { return await getJSON(PATH, { timeout: 5000 }); } catch { return { on: false, member: true }; }
}
