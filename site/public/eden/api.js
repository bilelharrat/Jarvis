// The website ↔ server contract (docs/chat-api.md). With ?mock=1 every call is answered in
// the browser by mock.js, through the same Response/stream path.

import { nativeTransport } from './native.js';
import { actingAnswer } from './acting.js';
import { deadline, singleFlight, approvalGap, DEADLINE } from './resilience.js';

const MOCK = new URLSearchParams(location.search).get('mock') === '1';

/**
 * Where the server lives. Every request is built from API_ROOT: by default the path the page
 * is served under its chat mount (http://localhost:5174/ → "",
 * https://askeden.com/ai/ → "/ai"). A <meta name="jarvis-api-root" content="…"> in
 * index.html re-points it (another path or origin).
 */
const metaRoot = document.querySelector('meta[name="jarvis-api-root"]');
export const API_ROOT = (metaRoot && metaRoot.content.trim() ? metaRoot.content.trim() : location.pathname.replace(/\/chat(?:\/.*)?$/, '').replace(/\/[^/]*\.html?$/, '')).replace(/\/$/, '');
export const API_BASE = `${API_ROOT}/api/chat`;
/** A server path ("/api/chat/meta", "/artifact/x") as a URL under API_ROOT. */
export function apiUrl(path) {
  if (/^[a-z][\w+.-]*:/i.test(path)) return path; // already absolute (or blob: in mock mode)
  return path.startsWith('/') ? `${API_ROOT}${path}` : path;
}

let mockFetch = null;
async function transport(path, init) {
  // acting for someone at askeden.com: what the grant can't do is answered here, unsent (acting.js)
  const refused = actingAnswer(init && init.method, path);
  if (refused) return refused;
  // inside the Eden iPhone app, a turn may run on the phone itself (native.js); null elsewhere
  return nativeTransport(path, init, network) || network(path, init);
}
async function network(path, init) {
  if (MOCK) {
    if (!mockFetch) mockFetch = (await import('./mock.js')).mockFetch;
    return mockFetch(path, init);
  }
  return fetch(apiUrl(path), init);
}
export const isMock = MOCK;

export class ApiError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function headers(path, extra = {}) {
  const h = { ...extra };
  if (path.startsWith('/api/chat')) h['X-Jarvis-Chat'] = '1';
  return h;
}

async function errorFrom(res) {
  let msg = `${res.status} ${res.statusText || ''}`.trim();
  try {
    const j = await res.json();
    if (j && (j.error || j.message)) msg = j.error || j.message;
  } catch { /* not JSON */ }
  if (res.status === 404) msg = `${msg} — is the Eden server running (model-router-ui)?`;
  return new ApiError(res.status, msg);
}

/** The error a client deadline ends a request with (`timeout: true`, so a caller can offer Retry). */
export const LATE = 'The server didn’t answer in time. Try again.';
/** The largest request the servers take (src/chat/http.ts MAX_BODY_BYTES). */
export const MAX_SEND = 25 * 1024 * 1024;
/** A reply that stopped coming mid-way (AC5). */
export const STALLED = 'The reply stopped coming: the server went quiet. Try again.';
/** A stream that stays open (the server's `: ping` keeps coming) but sends no event (AC2-1). */
export const QUIET = 'The reply stopped coming: the model went quiet. Try again.';
/**
 * AC2-1/AC2-2: the longest a chat, Compare or EVES stream may go without a real event. The servers' `: ping` comments
 * (every 15 s, for proxies) keep `idleTimeout` happy, so a hung model used to look alive forever; this limit counts only
 * events. The Mac's server ends a silent model at 2-3 min itself (stream.ts MODEL_IDLE): this is the net behind it.
 */
export const QUIET_LIMIT = { ms: 240_000 };
export const MAC_LATE = 'Your Mac didn’t answer in time. Check that Eden is open on your Mac, then try again.';
function lateError(message = LATE) { const e = new ApiError(0, message); e.timeout = true; return e; }

/**
 * GET JSON. `timeout` (ms): a client deadline over the whole request, body included; past it the
 * call fails with an ApiError whose `timeout` is true (`late` is its message).
 */
export async function getJSON(path, { signal, timeout = 0, late = LATE } = {}) {
  const d = timeout ? deadline(timeout, signal) : null;
  try {
    let res;
    try { res = await transport(path, { method: 'GET', headers: headers(path), signal: d ? d.signal : signal }); }
    catch (e) { if (d && d.timedOut()) throw lateError(late); if (e.name === 'AbortError') throw e; throw new ApiError(0, 'Can’t reach the server.'); }
    if (!res.ok) throw await errorFrom(res);
    try { return await res.json(); } catch (e) { if (d && d.timedOut()) throw lateError(late); throw e; }
  } finally { if (d) d.done(); }
}

// askeden.com refuses a Gmail send/schedule or a calendar create/update/delete/RSVP without a
// short-lived single-use approval token for that exact action (accounts/approvals.js). Every such
// call here comes from a click (Send, Add, Save, the approval card), so the token is minted as part
// of it. A server without the endpoint (the Mac's own) answers 404: no token needed there.
const GUARDED = { '/api/chat/gmail': ['gmail', ['send', 'schedule']], '/api/chat/gcal': ['gcal', ['create', 'update', 'delete', 'respond']], '/api/chat/sheets': ['sheets', ['write', 'upload', 'trash']] }; // sheets: Q15 (sheet-google.js)
const canon = (v) => (Array.isArray(v) ? `[${v.map(canon).join(',')}]` : v && typeof v === 'object' ? `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canon(v[k])}`).join(',')}}` : JSON.stringify(v));
async function approvalFor(path, body, signal) {
  const g = GUARDED[path];
  if (MOCK || !g || !body || !g[1].includes(body.action) || !globalThis.crypto || !crypto.subtle) return null;
  const exact = JSON.parse(JSON.stringify({ action: body.action, args: body.args === undefined ? {} : body.args }));
  const bytes = new TextEncoder().encode(`${g[0]}\n${canon(exact)}`);
  const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map((b) => b.toString(16).padStart(2, '0')).join('');
  let res;
  try { res = await transport('/api/chat/approve', { method: 'POST', headers: headers('/api/chat/approve', { 'content-type': 'application/json' }), body: JSON.stringify({ kind: g[0], hash }), signal }); }
  catch (e) { if (e.name === 'AbortError') throw e; throw new ApiError(0, 'Can’t reach the server.'); }
  if (res.status === 404) return null;
  if (!res.ok) throw await errorFrom(res);
  return (await res.json()).token || null;
}

export async function postJSON(path, body, { signal, timeout = 0, late = LATE } = {}) {
  const d = timeout ? deadline(timeout, signal) : null;
  const sig = d ? d.signal : signal;
  try {
    let res;
    try {
      const token = await approvalFor(path, body, sig);
      res = await transport(path, { method: 'POST', headers: headers(path, { 'content-type': 'application/json', ...(token ? { 'x-eden-approval': token } : {}) }), body: JSON.stringify(body), signal: sig });
    } catch (e) { if (d && d.timedOut()) throw lateError(late); if (e.name === 'AbortError' || e instanceof ApiError) throw e; throw new ApiError(0, 'Can’t reach the server.'); }
    if (!res.ok) throw await errorFrom(res);
    try { return await res.json(); } catch (e) { if (d && d.timedOut()) throw lateError(late); throw e; }
  } finally { if (d) d.done(); }
}

/**
 * POST and read Server-Sent Events from the response body: onEvent(type, data) for each
 * `event: <type>\ndata: <json>` block. Resolves when the stream ends; rejects with
 * AbortError when aborted.
 */
export async function streamSSE(path, body, { signal, onEvent, headTimeout = 0, idleTimeout = 0, quietTimeout = 0, late = LATE }) {
  // `headTimeout`: how long the server may take to start answering (a turn through the Mac); the
  // stream itself then runs as long as it needs (Stop still ends it: the caller's signal goes on).
  // `idleTimeout` (AC5): the longest silence allowed, before the answer starts and between any two bytes after it
  // (the servers send a `: ping` comment every 15 s, so a long think never trips it); past it the turn ends with
  // an ApiError whose `timeout` is true, and the page offers Retry.
  // `quietTimeout` (AC2-1): the longest time with no event at all (pings don't count): a model that hangs behind a live server.
  const json = JSON.stringify(body);
  if (json.length > MAX_SEND) throw new ApiError(413, `request too large (over ${MAX_SEND / 1024 / 1024} MB)`); // AC6: the server's limit, said before uploading it
  const d = headTimeout || idleTimeout ? deadline(headTimeout || idleTimeout, signal) : null;
  let res;
  try {
    res = await transport(path, { method: 'POST', headers: headers(path, { 'content-type': 'application/json', accept: 'text/event-stream' }), body: json, signal: d ? d.signal : signal });
  } catch (e) { if (d && d.timedOut()) { d.done(); throw lateError(late); } if (d) d.done(); if (e.name === 'AbortError') throw e; throw new ApiError(0, 'Can’t reach the server.'); }
  if (d) d.clear();
  if (!res.ok || !res.body) {
    if (d) d.done();
    throw res.ok ? new ApiError(0, 'The server sent no stream.') : await errorFrom(res);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  const flush = (block) => {
    let type = 'message';
    const data = [];
    for (const line of block.split(/\r?\n/)) {
      if (!line || line.startsWith(':')) continue;
      const i = line.indexOf(':');
      const field = i < 0 ? line : line.slice(0, i);
      let value = i < 0 ? '' : line.slice(i + 1);
      if (value.startsWith(' ')) value = value.slice(1);
      if (field === 'event') type = value;
      else if (field === 'data') data.push(value);
    }
    if (!data.length) return;
    heard(); // a real event, not a `: ping`
    let parsed;
    // AC9: every event's data is JSON; anything else is a broken stream, never words in the reply
    try { parsed = JSON.parse(data.join('\n')); } catch { console.warn(`Eden: an unreadable "${type}" event was dropped`); return; }
    onEvent(type, parsed);
  };
  let stalled = false, idle = null, silent = false, hush = null;
  const quiet = () => { clearTimeout(idle); if (idleTimeout) idle = setTimeout(() => { stalled = true; reader.cancel().catch(() => {}); }, idleTimeout); };
  function heard() { clearTimeout(hush); if (quietTimeout) hush = setTimeout(() => { silent = true; reader.cancel().catch(() => {}); }, quietTimeout); }
  heard();
  const stop = () => { reader.cancel().catch(() => {}); }; // Stop ends the read even where the body isn't tied to the request's signal
  if (signal) signal.addEventListener('abort', stop, { once: true });
  try {
    for (;;) {
      quiet();
      const { value, done } = await reader.read();
      if (signal && signal.aborted) throw new DOMException('Stopped', 'AbortError');
      if (stalled) throw lateError(STALLED);
      if (silent) throw lateError(QUIET);
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let m;
      while ((m = /\r?\n\r?\n/.exec(buf))) {
        const block = buf.slice(0, m.index);
        buf = buf.slice(m.index + m[0].length);
        flush(block);
      }
    }
    buf += decoder.decode();
    if (buf.trim()) flush(buf);
  } finally {
    clearTimeout(idle);
    clearTimeout(hush);
    if (signal) signal.removeEventListener('abort', stop);
    if (d) d.done();
    try { reader.releaseLock(); } catch { /* already released */ }
  }
}

/**
 * Jarvis's first call from Eden waits for the owner's "Let Eden use Jarvis?" card on the Mac.
 * While any Jarvis call has run 3 s, the status is polled; when the server says the call is
 * waiting on that card, `eden:jarvis-approval` fires on window with { waiting: true }, and with
 * { waiting: false } once nothing is waiting. jarvisApprovalWaiting() reads the current state.
 */
let jarvisPending = 0, approvalPoll = null, approvalWaiting = false, holding = 0;
function setApproval(w) {
  if (w === approvalWaiting) return;
  approvalWaiting = w;
  dispatchEvent(new CustomEvent('eden:jarvis-approval', { detail: { waiting: w } }));
}
export const jarvisApprovalWaiting = () => approvalWaiting;
/** The Mac's status, at most one request at a time (every caller shares the one in flight), 8 s at most. */
const statusOnce = singleFlight(() => getJSON('/api/chat/jarvis/status', { timeout: DEADLINE.status, late: MAC_LATE }));
async function watchApproval(p) {
  jarvisPending++;
  if (!approvalPoll) {
    const me = {};
    // one look at a time (the next is set after this one ends); none while the page is hidden,
    // nor while a call that the server said is waiting looks for itself (jarvisCall)
    // the first look at 3 s, then 1.5, 3 and every 5 s (AJ14: each look is a round trip to the Mac on askeden.com)
    const poll = () => (document.hidden || holding ? Promise.resolve() : statusOnce()
      .then((s) => { if (approvalPoll === me && !holding) setApproval(!!s && s.approval === 'waiting'); }, () => {}))
      .finally(() => { if (approvalPoll === me) me.t = setTimeout(poll, STATUS_GAPS[Math.min(me.n++, STATUS_GAPS.length - 1)]); });
    me.n = 0;
    me.t = setTimeout(poll, 3000);
    approvalPoll = me;
  }
  try { return await p; } finally {
    if (!--jarvisPending) { clearTimeout(approvalPoll.t); approvalPoll = null; setApproval(false); }
  }
}

const STATUS_GAPS = [1500, 3000, 5000];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * AJ1: each Jarvis call carries an id (`call` in the body) that Eden on the Mac remembers for a few
 * minutes, so asking again (after askeden.com gave up at 20 s, after the approval card, "Try again")
 * joins the first run instead of doing it twice. A call that ended without an answer (too slow,
 * unreachable, stopped) leaves its id here: the same tool with the same arguments asked again within
 * RETRY_KEEP_MS is that retry. A call that got an answer (or a 4xx refusal) doesn't: doing it again is new.
 * AJ2-2: the id is written down while the call runs too, in localStorage (keyed by a hash of the
 * tool and arguments, never the arguments): after a reload, or from another tab, the same action
 * asked while it's pending (or unanswered) is that same call. AJ2-11: kept 10 minutes, which covers
 * Jarvis's 300 s card and the 5 minutes Eden keeps an answer.
 */
const RETRY_KEEP_MS = 10 * 60_000;
const PENDING_KEY = 'eden:jarvis-calls';
const unanswered = new Map(); // hash → { id, at }: this page's copy (storage can be off)
function newCallId() {
  const a = new Uint8Array(12);
  crypto.getRandomValues(a);
  return btoa(String.fromCharCode(...a)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
/** A short hash of a call's tool and arguments (cyrb53): what's stored, so no email or event text is. */
function callHash(str) {
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (h2 >>> 0).toString(36) + (h1 >>> 0).toString(36);
}
function storedCalls() {
  try { const m = JSON.parse(localStorage.getItem(PENDING_KEY) || '{}'); return m && typeof m === 'object' && !Array.isArray(m) ? m : {}; } catch { return {}; }
}
function changeStored(fn) {
  try {
    const m = storedCalls();
    fn(m);
    const now = Date.now();
    const keys = Object.keys(m).filter((k) => m[k] && typeof m[k].id === 'string' && now - m[k].at < RETRY_KEEP_MS).sort((a, b) => m[b].at - m[a].at).slice(0, 50);
    localStorage.setItem(PENDING_KEY, JSON.stringify(Object.fromEntries(keys.map((k) => [k, m[k]]))));
  } catch { /* storage off: this page's copy only */ }
}
function callIdFor(key) {
  const now = Date.now();
  const mine = unanswered.get(key);
  const stored = storedCalls()[key];
  const kept = [mine, stored].filter((e) => e && typeof e.id === 'string' && now - e.at < RETRY_KEEP_MS).sort((a, b) => b.at - a.at)[0];
  const id = kept ? kept.id : newCallId();
  rememberCall(key, id); // pending: a reload or another tab asking the same joins it
  return id;
}
function rememberCall(key, id) {
  const e = { id, at: Date.now() };
  unanswered.set(key, e);
  for (const k of unanswered.keys()) { if (unanswered.size <= 50) break; unanswered.delete(k); }
  changeStored((m) => { m[key] = e; });
}
function forgetCall(key, id) {
  if (unanswered.get(key)?.id === id) unanswered.delete(key);
  changeStored((m) => { if (m[key] && m[key].id === id) delete m[key]; });
}
function keepUnanswered(key, id, e) {
  if (e instanceof ApiError && e.status >= 400 && e.status < 500) { forgetCall(key, id); return; } // refused: it didn't run
  rememberCall(key, id);
}

/**
 * POST /api/chat/jarvis with a client deadline (25 s; longer only while the Mac shows its "Let
 * Eden use Jarvis?" card, up to 130 s). `x-eden-wait: 20` asks askeden.com to answer within 20 s:
 * when the card is up it says so at once (202 { approval: 'waiting' }) instead of holding the
 * request, and the call looks at the status until the card is answered, then asks again. A server
 * that doesn't know the header holds the request as before; the status poll above still says so.
 */
async function jarvisCall(tool, args) {
  const key = callHash(`${tool}\u0000${JSON.stringify(args)}`);
  const id = callIdFor(key);
  let out;
  try { out = await jarvisAsk(tool, args, id); } catch (e) { keepUnanswered(key, id, e); throw e; }
  forgetCall(key, id); // answered: doing it again is a new call
  return out;
}
async function jarvisAsk(tool, args, id) {
  const started = Date.now();
  const body = JSON.stringify({ tool, arguments: args, call: id });
  const path = '/api/chat/jarvis';
  let gap = 0; // the looks between asks space out across re-asks too (a 202 that keeps coming: AJ14)
  for (;;) {
    const d = deadline(DEADLINE.jarvis, null, { extend: () => approvalWaiting && Date.now() - started < DEADLINE.approval });
    let res, out;
    try {
      res = await transport(path, { method: 'POST', headers: headers(path, { 'content-type': 'application/json', 'x-eden-wait': '20' }), body, signal: d.signal });
      if (!res.ok) throw await errorFrom(res);
      out = await res.json();
    } catch (e) {
      if (d.timedOut()) throw lateError(approvalWaiting ? 'Eden is still waiting for you to approve it on your Mac (“Let Eden use your Mac?”). Approve it there, then try again.' : MAC_LATE);
      if (e instanceof ApiError || e.name === 'AbortError') throw e;
      throw new ApiError(0, 'Can’t reach the server.');
    } finally { d.done(); }
    if (!(res.status === 202 && out && out.approval === 'waiting')) return out;
    // The card is up on the Mac: say so, and look until it's answered (or it's too late).
    holding++;
    try {
      setApproval(true);
      for (;;) {
        if (Date.now() - started > DEADLINE.approval) throw lateError('Eden is still waiting for you to approve it on your Mac (“Let Eden use your Mac?”). Approve it there, then try again.');
        await sleep(approvalGap(gap++));
        if (document.hidden) continue;
        const s = await statusOnce().catch(() => null);
        if (!s || s.approval !== 'waiting') break;
      }
    } finally { holding--; }
    setApproval(false);
  }
}

// Fields other modules add to every chat send (voice.js: `persona: 'jarvis'` while in Talk mode).
const sendExtras = new Set();
export function addSendExtra(fn) { sendExtras.add(fn); }
function withSendExtras(body) {
  let b = body;
  for (const f of sendExtras) { try { const x = f(body); if (x) b = { ...b, ...x }; } catch { /* an extra never breaks a send */ } }
  return b;
}

export const api = {
  meta: () => getJSON('/api/chat/meta'),
  // A video for the next turn (askeden.com: on to Gemini's Files API, site src/eden/video.js) →
  // { file, uri, mime, size, seconds, estimate { model, name, tokens, usd, confirm } }
  video: async (file, seconds) => {
    const name = String(file.name || 'video').replace(/[^\x20-\x7e]/g, '_').slice(0, 120);
    const res = await transport('/api/chat/video', { method: 'POST', headers: headers('/api/chat/video', { 'content-type': file.type || 'video/mp4', 'x-eden-name': name, 'x-eden-seconds': String(Math.round(seconds || 0)) }), body: file });
    if (!res.ok) throw await errorFrom(res);
    return res.json();
  },
  route: (body, signal) => postJSON('/api/route', body, { signal }),
  keys: () => getJSON('/api/chat/keys'),
  setKey: (provider, key) => postJSON('/api/chat/keys', { provider, key }),
  // Eden's memory across chats on askeden.com (Settings › Memory): { on, notice, items }
  memory: () => getJSON('/api/chat/memory'),
  memoryDo: (body) => postJSON('/api/chat/memory', body),
  jarvisStatus: () => statusOnce(), // 8 s at most, one at a time (B1, C3)
  jarvis: (tool, args = {}) => watchApproval(jarvisCall(tool, args)), // 25 s at most unless an approval is up on the Mac (A1, C1)
  projects: () => getJSON('/api/chat/projects'),
  addProject: (path) => postJSON('/api/chat/projects', { path }),
  createProject: (name) => postJSON('/api/chat/projects', { create: name }), // → { projects, added }
  pickProject: () => postJSON('/api/chat/projects', { pick: true }), // the Mac's folder picker → { projects, added }
  changes: (project) => getJSON(`/api/chat/code/changes?project=${encodeURIComponent(project)}`),
  artifact: (html) => postJSON('/api/chat/artifact', { html }),
  // A turn that uses the Mac ("Use my Mac", project knowledge: files.js) goes to mac/send, which askeden.com forwards to the Mac.
  // A Talk turn (persona 'jarvis') or a "Use my Mac" turn may go through the Mac: it must start answering within 25 s (C4).
  send: (body, opts) => { const b = withSendExtras(body); const viaMac = !!(b && (b.mac || b.persona === 'jarvis')); return streamSSE(b && b.mac ? '/api/chat/mac/send' : '/api/chat/send', b, viaMac ? { headTimeout: DEADLINE.head, idleTimeout: DEADLINE.idle, quietTimeout: QUIET_LIMIT.ms, late: b.mac ? MAC_LATE : 'Eden didn’t start answering in time. Try again.', ...opts } : { idleTimeout: DEADLINE.idle, quietTimeout: QUIET_LIMIT.ms, ...opts }); }, // AC5: never "typing" forever
  // Compare (G6): several models at once, lane-tagged events; its estimate; stop one lane.
  compare: (body, opts) => streamSSE('/api/chat/compare', body, { idleTimeout: DEADLINE.idle, quietTimeout: QUIET_LIMIT.ms, ...opts }), // AC2-2: a stalled compare ends too
  compareEstimate: (body, signal) => postJSON('/api/chat/compare/estimate', body, { signal }),
  researchEstimate: (body, signal) => postJSON('/api/chat/research/estimate', body, { signal }), // Q2: { searches, typicalUSD, maxUSD, fits, latencyS, models }
  compareStop: (id, lane) => postJSON('/api/chat/compare/stop', { id, lane }),
  code: (body, opts) => streamSSE('/api/chat/code', body, opts),
  gmail: (action, args = {}) => postJSON('/api/chat/gmail', { action, args }),
  googleStatus: (opts) => getJSON('/api/chat/google/status', opts),
  googleConfig: (clientId, clientSecret) => postJSON('/api/chat/google/config', { clientId, clientSecret }),
  googleConnect: (scope) => postJSON('/api/chat/google/connect', scope ? { scope } : {}), // scope (askeden.com: its own consent): gmail | calendar
  // disconnecting also clears the mail kept in this browser (mail-cache.js)
  googleDisconnect: async () => { const r = await postJSON('/api/chat/google/disconnect', {}); try { (await import('./mail-cache.js')).clearMailCache(); } catch { /* none kept */ } return r; },
  codeSteer: (turnId, text) => postJSON('/api/chat/code/steer', { turnId, text }),
  browserSteer: (runId, text) => postJSON('/api/chat/browser/steer', { runId, text }), // a message to the running browser agent: guidance for its next step
};
