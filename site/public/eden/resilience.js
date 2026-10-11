// Small pure helpers that keep the page from hanging on a slow server or a slow Mac (iOS sweep
// 2026-10-09, A1–A3, B1–B3, B9, B18, C1–C5): client deadlines, one request in flight at a time,
// Stop that ends a wait at once, Talk's turn caps, a deployed-page stamp, a draft kept per chat.
// No DOM here: src/__tests__/resilience.test.ts loads this file as the page serves it.

/** How long the page waits before it says so (ms). */
export const DEADLINE = { status: 8_000, jarvis: 25_000, google: 5_000, voice: 15_000, head: 25_000, approval: 130_000 };

/**
 * A signal that aborts when `parent` does or after `ms`. `timedOut()` tells the two apart; `clear()`
 * stops the clock (the parent still aborts it). `extend()` (optional) is asked when the clock runs
 * out: true gives it another `ms` (a Jarvis call while its approval card is up on the Mac).
 */
export function deadline(ms, parent, { extend } = {}) {
  const ctrl = new AbortController();
  let late = false, timer = null;
  const onParent = () => ctrl.abort(parent.reason);
  if (parent) { if (parent.aborted) ctrl.abort(parent.reason); else parent.addEventListener('abort', onParent, { once: true }); }
  const arm = () => {
    timer = setTimeout(() => {
      if (extend && extend()) { arm(); return; }
      late = true;
      ctrl.abort();
    }, ms);
  };
  if (!ctrl.signal.aborted && ms > 0) arm();
  return {
    signal: ctrl.signal,
    timedOut: () => late,
    clear: () => { clearTimeout(timer); timer = null; },
    done: () => { clearTimeout(timer); timer = null; if (parent) parent.removeEventListener('abort', onParent); },
  };
}

/**
 * `p`, or `fallback` when `signal` aborts or `ms` passes first (a pre-send check that mustn't hold
 * up the send, and that Stop ends at once). `p` keeps running; its result is then ignored.
 */
export function untilStopped(p, signal, ms = 0, fallback = undefined) {
  return new Promise((resolve, reject) => {
    let t = null;
    const end = () => { clearTimeout(t); if (signal) signal.removeEventListener('abort', give); };
    const give = () => { end(); resolve(fallback); };
    if (signal && signal.aborted) { resolve(fallback); return; }
    if (signal) signal.addEventListener('abort', give, { once: true });
    if (ms > 0) t = setTimeout(give, ms);
    Promise.resolve(p).then((v) => { end(); resolve(v); }, (e) => { end(); reject(e); });
  });
}

/** `fn` that never runs twice at once: a call while one runs gets that run's promise. */
export function singleFlight(fn) {
  let running = null;
  const wrapped = (...args) => {
    if (running) return running;
    const p = Promise.resolve().then(() => fn(...args));
    running = p;
    const clear = () => { if (running === p) running = null; };
    p.then(clear, clear);
    return p;
  };
  wrapped.busy = () => running !== null;
  return wrapped;
}

/** The gap before the n-th look at a waiting approval (2 s, 3 s, 5 s, then every 8 s). */
export const approvalGap = (n) => [2000, 3000, 5000][n] || 8000;

/* ---------- Talk: when a turn is sent ---------- */

/** Talk sends a turn after this long with no change in what was heard… */
export const TALK_PAUSE_MS = 1200;
/** …and at the latest after this long, or this many characters (a recognizer that never stops). */
export const TALK_MAX_MS = 30_000;
export const TALK_MAX_CHARS = 2_000;

/**
 * One recognition result in Talk: what to do with the pause timer. `prev` is what was heard at the
 * last result ({ text, start }), `text` what is heard now, `now` the time. Returns
 * { action: 'send' | 'restart' | 'keep' | 'none', turn } where `turn` is the new { text, start }.
 * The same words again (a recognizer that repeats its results) keep the running timer, so the
 * turn still ends; a turn past TALK_MAX_MS or TALK_MAX_CHARS is sent at once.
 */
export function talkStep(prev, text, now) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  if (!t) return { action: 'none', turn: { text: '', start: 0 } };
  const start = prev && prev.start ? prev.start : now;
  const turn = { text: t, start };
  if (t.length >= TALK_MAX_CHARS || now - start >= TALK_MAX_MS) return { action: 'send', turn };
  if (prev && prev.text === t) return { action: 'keep', turn };
  return { action: 'restart', turn };
}
/** A turn's words as sent: at most TALK_MAX_CHARS, cut at a space when there is one near the end. */
export function talkText(text) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  if (t.length <= TALK_MAX_CHARS) return t;
  const cut = t.lastIndexOf(' ', TALK_MAX_CHARS);
  return t.slice(0, cut > TALK_MAX_CHARS - 200 ? cut : TALK_MAX_CHARS);
}

/** After this many turns in a row that ended at the cap (not at a pause), Talk stops and asks (R2-3). */
export const TALK_CAPPED_MAX = 2;
/**
 * Turns in a row that ended at TALK_MAX_CHARS / TALK_MAX_MS: one more for a capped turn, back to 0
 * for one that ended normally. At TALK_CAPPED_MAX Talk pauses instead of listening again: a
 * recognizer that never pauses (a TV, a noisy room) would otherwise send big turns non-stop.
 */
export function talkCapped(run, capped) { return capped ? (Number(run) || 0) + 1 : 0; }
export const talkShouldPause = (run) => (Number(run) || 0) >= TALK_CAPPED_MAX;

/* ---------- has the deployed page changed? ---------- */

/** Look at most this often (on coming back to the page). */
export const UPDATE_CHECK_MS = 5 * 60_000;

/** A short hash of text (FNV-1a), for a file served without an ETag or Last-Modified. */
export function textHash(s) {
  let h = 0x811c9dc5;
  const t = String(s);
  for (let i = 0; i < t.length; i++) { h ^= t.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(16).padStart(8, '0');
}
/** One file's stamp from its response headers (an ETag first), or null to hash its text. */
export function stampOf(headers) {
  const get = (k) => (headers && typeof headers.get === 'function' ? headers.get(k) : headers && headers[k]) || '';
  const etag = String(get('etag')).replace(/^W\//, '');
  if (etag) return `e:${etag}`;
  const lm = String(get('last-modified'));
  return lm ? `m:${lm}` : null;
}
/** True when a stamp taken now differs from the one taken at boot (unknown on either side: no). */
export function stampChanged(boot, now) {
  if (!boot || !now) return false;
  return Object.keys(boot).some((k) => boot[k] && now[k] && boot[k] !== now[k]);
}
/**
 * What to do about a newer page: reload quietly when nothing would be lost, else offer it. `busy` is
 * { streaming, draft, talking, attachments, dictating, mail, importing, dialog, field, … }: any one
 * true (a reply streaming, words or files in the composer, Talk or dictation running, a Mail message
 * being written, an import running, a dialog or sheet open) means the banner (R2C-3).
 */
export function updateAction(busy) {
  return busy && typeof busy === 'object' && Object.values(busy).some(Boolean) ? 'banner' : 'reload';
}

/* ---------- the unsent draft, per chat ---------- */

export const DRAFT_KEY = 'eden:drafts';
/** At most this many chats' drafts, each at most this many characters (sessionStorage holds ~5 MB): R2C-8. */
export const DRAFT_CHATS = 20;
export const DRAFT_MAX_CHARS = 20_000;
const newestFirst = (m) => Object.keys(m).sort((a, b) => (m[b].at || 0) - (m[a].at || 0));
/** The drafts map with `chat`'s text set (or removed when empty); the oldest go past 20 chats. */
export function putDraft(map, chat, text) {
  const m = { ...(map && typeof map === 'object' ? map : {}) };
  const k = chat || 'new';
  delete m[k];
  if (String(text || '').trim()) m[k] = { text: String(text).slice(0, DRAFT_MAX_CHARS), at: Date.now() };
  for (const x of newestFirst(m).slice(DRAFT_CHATS)) delete m[x];
  return m;
}
export function getDraft(map, chat) {
  const d = map && typeof map === 'object' ? map[chat || 'new'] : null;
  return d && typeof d.text === 'string' ? d.text : '';
}
/**
 * Writes the drafts map with `write(json)`. When that throws (storage full), the oldest half of the
 * drafts go (never `keep`'s, the one being typed) and it's written once more. Returns the map as
 * stored, or null when it couldn't be (storage off, or still full): R2C-8.
 */
export function storeDrafts(write, map, keep = 'new') {
  const m = map && typeof map === 'object' ? map : {};
  try { write(JSON.stringify(m)); return m; } catch { /* full: drop the oldest, once */ }
  const keys = newestFirst(m).filter((k) => k !== keep);
  const fewer = {};
  if (m[keep]) fewer[keep] = m[keep];
  for (const k of keys.slice(0, Math.floor(keys.length / 2))) fewer[k] = m[k];
  try { write(JSON.stringify(fewer)); return fewer; } catch { return null; }
}

/* ---------- what's attached to the draft (R2-16) ---------- */

export const DRAFT_FILES_KEY = 'eden:draft-files';
/** Attachments are kept with the draft up to this size (characters of JSON, ~2 MB); past it only their count. */
export const DRAFT_FILES_MAX = 2_000_000;
const FILE_KINDS = ['image', 'text', 'doc', 'video'];
/**
 * What's kept of the composer's attachments for `chat`: { chat, at, files } when they fit in
 * DRAFT_FILES_MAX, else { chat, at, dropped: n } (so the page can say they were removed). A
 * picture's data URL isn't kept twice (it's rebuilt from `data`). Null when nothing is attached.
 */
export function packDraftFiles(chat, files, max = DRAFT_FILES_MAX) {
  const list = (Array.isArray(files) ? files : []).filter((f) => f && FILE_KINDS.includes(f.kind));
  if (!list.length) return null;
  const at = Date.now();
  const slim = list.map((f) => { const o = { ...f }; if (typeof o.data === 'string' && typeof o.url === 'string' && o.url.startsWith('data:')) delete o.url; return o; });
  const out = { chat: chat || 'new', at, files: slim };
  return JSON.stringify(out).length <= max ? out : { chat: chat || 'new', at, dropped: list.length };
}
/** The kept attachments for `chat`: { files, dropped } (none when they were kept for another chat). */
export function unpackDraftFiles(slot, chat) {
  const none = { files: [], dropped: 0 };
  if (!slot || typeof slot !== 'object' || slot.chat !== (chat || 'new')) return none;
  if (!Array.isArray(slot.files)) return { files: [], dropped: Math.max(0, Number(slot.dropped) || 0) };
  const files = slot.files.filter((f) => f && typeof f === 'object' && FILE_KINDS.includes(f.kind) && typeof f.name === 'string').map((f) => {
    const o = { ...f };
    if (o.kind === 'image' && typeof o.data === 'string' && !o.url) o.url = `data:${String(o.mime || 'image/png')};base64,${o.data}`;
    return o;
  });
  return { files, dropped: 0 };
}

/* ---------- text from other apps ---------- */

/** Bidi override and isolate controls (U+202A–202E, U+2066–2069): a shared prompt or file name that reads differently from what it is. */
export const stripBidi = (s) => String(s == null ? '' : s).replace(/[‪-‮⁦-⁩]/g, '');
