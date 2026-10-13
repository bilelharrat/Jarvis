// The website ↔ server contract (docs/chat-api.md). With ?mock=1 every call is answered in
// the browser by mock.js, through the same Response/stream path.

import { nativeTransport } from './native.js';
import { actingAnswer } from './acting.js';
import { mockAllowed, isLocalServer } from './tour-model.js';
import { deadline, singleFlight, approvalGap, DEADLINE } from './resilience.js';

// Practice mode (?practice=1) on any host: its storage is sandboxed. ?mock=1 alone only on a developer's own
// machine (localhost, 127.0.0.1, ::1, *.localhost, *.test): on askeden.com or any real server the mock would
// write sample chats into a person's real storage, which then syncs (R2C-20, R3-1; tour-model.js mockAllowed).
const MOCK = mockAllowed(location.hostname, location.search);
/** Only a developer's own server is "model-router-ui"; on askeden.com and in the app the page says nothing of it (R3-4). */
export const LOCAL_SERVER = isLocalServer(location.hostname);

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
/** Straight to the server (or ?mock=1's sample answers): no acting refusal, no on-device turn. */
export const rawFetch = network;
/**
 * askeden.com's own JSON calls (sync, team spaces): GET without a body, else POST it. Errors carry
 * `status` (0: no connection) and the server's `code`.
 */
export async function askedenJSON(path, body) {
  const init = { cache: 'no-store', method: body === undefined ? 'GET' : 'POST', headers: { 'X-Jarvis-Chat': '1', ...(body !== undefined ? { 'content-type': 'application/json' } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) };
  let res;
  try { res = await network(path, init); }
  catch { throw Object.assign(new Error('Can’t reach askeden.com. Check your connection.'), { status: 0 }); }
  let out = {};
  try { out = await res.json(); } catch { /* not JSON */ }
  if (!res.ok) throw Object.assign(new Error(out.error || `askeden.com said ${res.status}.`), { status: res.status, code: out.code });
  return out;
}

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
  let code = '';
  try {
    const j = await res.json();
    if (j && (j.error || j.message)) msg = j.error || j.message;
    if (j && typeof j.code === 'string') code = j.code;
  } catch { /* not JSON */ }
  if (res.status === 404 && LOCAL_SERVER) msg = `${msg} — is the Eden server running (model-router-ui)?`;
  const e = new ApiError(res.status, msg);
  if (code) e.code = code; // askeden.com's { error, code } (mac_timeout, approval_pending, request_id_reused…)
  return e;
}

/** The error a client deadline ends a request with (`timeout: true`, so a caller can offer Retry). */
export const LATE = 'The server didn’t answer in time. Try again.';
export const MAC_LATE = 'Your Mac didn’t answer in time. Check that Eden is open on your Mac, then try again.';
function lateError(message = LATE) { const e = new ApiError(0, message); e.timeout = true; return e; }

/**
 * GET JSON. `timeout` (ms): a client deadline over the whole request, body included; past it the
 * call fails with an ApiError whose `timeout` is true (`late` is its message).
 */
export const getJSON = (path, opts) => requestJSON(path, { method: 'GET', headers: headers(path) }, opts);

/**
 * getJSON's and postJSON's one request: `init` is the fetch options, or `init(signal)` gives them (a
 * POST mints its approval token there, under the same deadline); then the answer as JSON, with the
 * same errors. A GET is sent at once (in the same turn, as before).
 */
async function requestJSON(path, init, { signal, timeout = 0, late = LATE } = {}) {
  const d = timeout ? deadline(timeout, signal) : null;
  const sig = d ? d.signal : signal;
  try {
    let res;
    try { res = await transport(path, { ...(typeof init === 'function' ? await init(sig) : init), signal: sig }); }
    catch (e) { if (d && d.timedOut()) throw lateError(late); if (e.name === 'AbortError' || e instanceof ApiError) throw e; throw new ApiError(0, 'Can’t reach the server.'); }
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

export const postJSON = (path, body, opts) => requestJSON(path, async (sig) => {
  const token = await approvalFor(path, body, sig);
  return { method: 'POST', headers: headers(path, { 'content-type': 'application/json', ...(token ? { 'x-eden-approval': token } : {}) }), body: JSON.stringify(body) };
}, opts);

/**
 * POST and read Server-Sent Events from the response body: onEvent(type, data) for each
 * `event: <type>\ndata: <json>` block. Resolves when the stream ends; rejects with
 * AbortError when aborted.
 */
export async function streamSSE(path, body, { signal, onEvent, headTimeout = 0, late = LATE, wait = 0 }) {
  // `headTimeout`: how long the server may take to start answering (a turn through the Mac); the
  // stream itself then runs as long as it needs (Stop still ends it: the caller's signal goes on).
  const d = headTimeout ? deadline(headTimeout, signal) : null;
  let res;
  try {
    // `wait` (s): askeden.com answers 504 mac_timeout at that point rather than holding the turn (a turn through the Mac)
    res = await transport(path, { method: 'POST', headers: headers(path, { 'content-type': 'application/json', accept: 'text/event-stream', ...(wait ? { 'x-eden-wait': String(wait) } : {}) }), body: JSON.stringify(body), signal: d ? d.signal : signal });
  } catch (e) { if (d && d.timedOut()) { d.done(); throw lateError(late); } if (d) d.done(); if (e.name === 'AbortError') throw e; throw new ApiError(0, 'Can’t reach the server.'); }
  if (d) d.clear();
  if (!res.ok || !res.body) {
    if (d) d.done();
    if (res.ok) throw new ApiError(0, 'The server sent no stream.');
    const e = await errorFrom(res);
    if (wait && res.status === 504 && e.code === 'mac_timeout') throw lateError(late); // the server's own deadline: the same "didn't answer in time"
    throw e;
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
    let parsed;
    try { parsed = JSON.parse(data.join('\n')); } catch { parsed = { text: data.join('\n') }; }
    onEvent(type, parsed);
  };
  try {
    for (;;) {
      const { value, done } = await reader.read();
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
    if (d) d.done();
    try { reader.releaseLock(); } catch { /* already released */ }
  }
}

/**
 * Eden Secretary's first call from Eden waits for the owner's "Let Eden use Eden Secretary?" card on the Mac.
 * While any Eden Secretary call has run 3 s, the status is polled; when the server says the call is
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
    const poll = () => (document.hidden || holding ? Promise.resolve() : statusOnce()
      .then((s) => { if (approvalPoll === me && !holding) setApproval(!!s && s.approval === 'waiting'); }, () => {}))
      .finally(() => { if (approvalPoll === me) me.t = setTimeout(poll, 1500); });
    me.t = setTimeout(poll, 3000);
    approvalPoll = me;
  }
  try { return await p; } finally {
    if (!--jarvisPending) { clearTimeout(approvalPoll.t); approvalPoll = null; setApproval(false); }
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/**
 * POST /api/chat/jarvis with a client deadline (25 s; longer only while the Mac shows its "Let
 * Eden use Eden Secretary?" card, up to 130 s). `x-eden-wait: 20` asks askeden.com to answer within 20 s:
 * when the card is up it says so at once (202 { approval: 'waiting' }) instead of holding the
 * request, and the call looks at the status until the card is answered, then asks again. A server
 * that doesn't know the header holds the request as before; the status poll above still says so.
 *
 * Each call has its own `x-eden-request-id` (R2C-4): every pass after a 202, and Try again of the
 * same call (the same tool and arguments, byte for byte), send the same id, so a call the Mac ran
 * once (approved after the page gave up) is answered from what it kept (`x-eden-replayed: 1`) and
 * never run twice. A call that didn't finish keeps its id for a while for that Try again; one that
 * finished lets it go. 409 request_id_reused (a bug) gets one new id, never a loop. 504
 * approval_pending (a server that had no id) isn't retried: it runs once approved on the Mac. 504
 * mac_timeout is "Your Mac didn't answer" with Try again. Old servers ignore the header.
 */
const jarvisIds = new Map(); // body -> { id, at }: calls that didn't finish, for Try again
const JARVIS_ID_MS = 10 * 60_000;
function newRequestId() {
  try { if (globalThis.crypto && typeof crypto.randomUUID === 'function') return crypto.randomUUID(); } catch { /* below */ }
  const b = new Uint8Array(16);
  try { crypto.getRandomValues(b); } catch { for (let i = 0; i < 16; i++) b[i] = Math.floor(Math.random() * 256); }
  return [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
}
async function jarvisCall(tool, args) {
  const started = Date.now();
  const body = JSON.stringify({ tool, arguments: args });
  const path = '/api/chat/jarvis';
  const kept = jarvisIds.get(body);
  jarvisIds.delete(body); // in flight: a second identical call at the same time gets its own id
  let id = kept && Date.now() - kept.at < JARVIS_ID_MS ? kept.id : newRequestId();
  let reminted = false;
  const keepForRetry = () => {
    jarvisIds.set(body, { id, at: Date.now() });
    for (const [k, v] of jarvisIds) if (Date.now() - v.at > JARVIS_ID_MS || jarvisIds.size > 20) jarvisIds.delete(k);
  };
  for (;;) {
    const d = deadline(DEADLINE.jarvis, null, { extend: () => approvalWaiting && Date.now() - started < DEADLINE.approval });
    let res, out, again = false;
    try {
      res = await transport(path, { method: 'POST', headers: headers(path, { 'content-type': 'application/json', 'x-eden-wait': '20', 'x-eden-request-id': id }), body, signal: d.signal });
      if (!res.ok) throw await errorFrom(res);
      out = await res.json();
    } catch (e) {
      if (d.timedOut()) { keepForRetry(); throw lateError(approvalWaiting ? 'Eden is still waiting for you to approve it on your Mac (“Let Eden use Eden Secretary?”). Approve it there, then try again.' : MAC_LATE); }
      if (e instanceof ApiError && e.status === 409 && e.code === 'request_id_reused' && !reminted) { reminted = true; id = newRequestId(); again = true; }
      else if (e instanceof ApiError && e.status === 504 && e.code === 'mac_timeout') { keepForRetry(); throw lateError(MAC_LATE); }
      else if (e instanceof ApiError && e.status === 504 && e.code === 'approval_pending') { keepForRetry(); e.approvalPending = true; throw e; } // it runs once approved: not asked again
      else if (e instanceof ApiError || e.name === 'AbortError') { keepForRetry(); throw e; } // (didn't finish: Try again asks with the same id)
      else { keepForRetry(); throw new ApiError(0, 'Can’t reach the server.'); }
    } finally { d.done(); }
    if (again) continue;
    if (!(res.status === 202 && out && out.approval === 'waiting')) return out; // an answer (a replayed one, `x-eden-replayed: 1`, is one too)
    // The card is up on the Mac: say so, and look until it's answered (or it's too late).
    holding++;
    try {
      setApproval(true);
      for (let n = 0; ; n++) {
        if (Date.now() - started > DEADLINE.approval) { keepForRetry(); throw lateError('Eden is still waiting for you to approve it on your Mac (“Let Eden use Eden Secretary?”). Approve it there, then try again.'); }
        await sleep(approvalGap(n));
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
  // `x-eden-wait: 25`: askeden.com answers 504 mac_timeout at its deadline (shown as the same timeout), never a 202 (R2C-5).
  send: (body, opts) => { const b = withSendExtras(body); const viaMac = !!(b && (b.mac || b.persona === 'jarvis')); return streamSSE(b && b.mac ? '/api/chat/mac/send' : '/api/chat/send', b, viaMac ? { headTimeout: DEADLINE.head, wait: 25, late: b.mac ? MAC_LATE : 'Eden didn’t start answering in time. Try again.', ...opts } : opts); },
  // Compare (G6): several models at once, lane-tagged events; its estimate; stop one lane.
  compare: (body, opts) => streamSSE('/api/chat/compare', body, opts),
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
