// Eden Slides presenting extras (web only), the pure part: rehearsal timings, a self-running show's plan, and live
// poll and Q&A slides. No DOM. deck-model.js keeps these fields through normalizeSlide/normalizeDeck (one hook each);
// deck-present.js is the UI; audience-core.js is the room the audience joins.
//
// On a slide:
//   target   seconds the presenter means to spend on it (1..3600)
//   took     seconds the last saved rehearsal spent on it (1..3600)
//   live     { kind: 'poll' | 'qa', id }   a poll slide is a 'bullets' slide: its title is the question and its
//            2–6 bullets are the options, so the PDF, the PowerPoint and the iPhone app show it as a plain list.
// On the deck:
//   rehearsed  when the timings were saved (ms)

export const LIVE = { minOptions: 2, maxOptions: 6, question: 160, option: 80, maxSeconds: 3600 };
const LIVE_ID = /^[A-Za-z0-9_-]{6,16}$/;
const isObj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
const secs = (v) => (typeof v === 'number' && Number.isFinite(v) && v >= 1 ? Math.min(LIVE.maxSeconds, Math.round(v)) : 0);
const oneLine = (v, max) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩﻿]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max) : '');
const rid = () => { const b = globalThis.crypto.getRandomValues(new Uint8Array(6)); let s = ''; for (const x of b) s += 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'[x & 63]; return s; };

/** The fields of a slide this module owns, cleaned: { target?, took?, live? }. */
export function liveFields(s) {
  const out = {};
  if (!isObj(s)) return out;
  const target = secs(s.target);
  if (target) out.target = target;
  const took = secs(s.took);
  if (took) out.took = took;
  const l = s.live;
  if (isObj(l) && (l.kind === 'poll' || l.kind === 'qa') && typeof l.id === 'string' && LIVE_ID.test(l.id)) out.live = { kind: l.kind, id: l.id };
  return out;
}
/** The deck-level field: { rehearsed? }. */
export function liveDeckFields(raw) {
  const t = isObj(raw) && typeof raw.rehearsed === 'number' && Number.isFinite(raw.rehearsed) && raw.rehearsed > 0 ? Math.floor(raw.rehearsed) : 0;
  return t ? { rehearsed: t } : {};
}
/** Fields Eden must not drop when it rewrites a slide (deck-model applyPatch keeps them). */
export const KEEP_ON_REPLACE = ['target', 'took', 'live'];

const bulletText = (b) => (typeof b === 'string' ? b : isObj(b) ? String(b.text || '') : '');

/** A new poll slide: { layout:'bullets', title: question, bullets: options, live }. Null if it isn't a poll. */
export function pollSlide(question, options) {
  const q = oneLine(question, LIVE.question);
  const opts = (Array.isArray(options) ? options : []).map((o) => oneLine(o, LIVE.option)).filter(Boolean).slice(0, LIVE.maxOptions);
  if (!q || opts.length < LIVE.minOptions) return null;
  return { layout: 'bullets', kicker: 'Live poll', title: q, bullets: opts, live: { kind: 'poll', id: rid() } };
}
/** A new Q&A slide. */
export function qaSlide(title = 'Questions?') {
  return { layout: 'bullets', kicker: 'Q&A', title: oneLine(title, LIVE.question) || 'Questions?', bullets: ['Ask and upvote questions on your phone'], live: { kind: 'qa', id: rid() } }; // the live questions take the list's place while presenting
}
/** What the audience sees of a live slide: { kind, id, question, options? } or null. */
export function liveOf(s) {
  if (!isObj(s) || !isObj(s.live)) return null;
  const { kind, id } = s.live;
  if (kind === 'poll') {
    const options = (s.bullets || []).map(bulletText).map((t) => oneLine(t, LIVE.option)).filter(Boolean).slice(0, LIVE.maxOptions);
    if (options.length < LIVE.minOptions) return null;
    return { kind, id, question: oneLine(s.title, LIVE.question) || 'Poll', options };
  }
  if (kind === 'qa') return { kind, id, question: oneLine(s.title, LIVE.question) || 'Questions?' };
  return null;
}

// ── time ──

/** 0:42, 3:10, 1:02:03. */
export function clock(seconds) {
  const s = Math.max(0, Math.floor(Number(seconds) || 0));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}` : `${m}:${String(r).padStart(2, '0')}`;
}
/** "1:30", "90", "1m 30s", "2m" → seconds (0 when it isn't a time). */
export function parseClock(v) {
  const t = String(v ?? '').trim().toLowerCase();
  if (!t) return 0;
  let m;
  if ((m = /^(\d{1,2}):(\d{1,2}):(\d{2})$/.exec(t))) return secs(+m[1] * 3600 + +m[2] * 60 + +m[3]);
  if ((m = /^(\d{1,3}):(\d{1,2})$/.exec(t))) return +m[2] < 60 ? secs(+m[1] * 60 + +m[2]) : 0;
  if ((m = /^(?:(\d{1,3})\s*m(?:in)?)?\s*(?:(\d{1,4})\s*s(?:ec)?)?$/.exec(t)) && (m[1] || m[2])) return secs((+m[1] || 0) * 60 + (+m[2] || 0));
  if (/^\d{1,4}$/.test(t)) return secs(+t);
  return 0;
}

/**
 * A rehearsal in progress: per deck-slide seconds, fed by the slide the presenter is on. Pure (time comes in).
 * `at(index, now)` when the slide changes; `pause(now)`/`resume(now)`; `stop(now)` → the seconds per slide index.
 */
export function rehearsal(count, now) {
  const spent = new Array(Math.max(0, count)).fill(0);
  let cur = -1, since = now, paused = false, total = 0;
  const bank = (t) => { if (!paused && cur >= 0 && cur < spent.length) { const d = Math.max(0, t - since); spent[cur] += d; total += d; } since = t; };
  return {
    at(index, t) { bank(t); cur = Number.isInteger(index) && index >= 0 && index < spent.length ? index : -1; },
    pause(t) { bank(t); paused = true; },
    resume(t) { since = t; paused = false; },
    get paused() { return paused; },
    get index() { return cur; },
    /** Seconds so far: { total, slide } (with the running slide's part). */
    read(t) { const run = !paused && cur >= 0 ? Math.max(0, t - since) : 0; return { total: (total + run) / 1000, slide: ((cur >= 0 ? spent[cur] : 0) + run) / 1000 }; },
    stop(t) { bank(t); cur = -1; return spent.map((ms) => Math.round(ms / 1000)); },
  };
}

/**
 * The summary of a rehearsal: one row per slide (the ones visited), and the lines a person reads.
 * `took` is seconds per slide index (from rehearsal().stop).
 */
export function rehearsalReport(deck, took) {
  const rows = deck.slides.map((s, i) => {
    const t = Math.max(0, Math.round(took[i] || 0));
    const target = s.target || 0;
    return { i, title: oneLine(s.title, 80) || `Slide ${i + 1}`, took: t, target, over: target > 0 && t > target * 1.1 + 5, under: target > 0 && t < target * 0.5 };
  });
  const total = rows.reduce((a, r) => a + r.took, 0);
  const targetTotal = rows.reduce((a, r) => a + r.target, 0);
  const lines = rows.filter((r) => r.took > 0 || r.target > 0).map((r) => `Slide ${r.i + 1} took ${clock(r.took)}${r.target ? `, target ${clock(r.target)}` : ''}`);
  return { rows, total, targetTotal, lines, over: rows.filter((r) => r.over).map((r) => r.i), skipped: rows.filter((r) => r.took === 0).map((r) => r.i) };
}

/** The deck with this rehearsal's times saved on its slides (slides not visited keep their old time). */
export function saveTimings(deck, took, now = Date.now(), { asTargets = false } = {}) {
  const d = JSON.parse(JSON.stringify(deck));
  d.slides.forEach((s, i) => {
    const t = secs(took[i]);
    if (!t) return;
    s.took = t;
    if (asTargets) s.target = t;
  });
  d.rehearsed = Math.floor(now);
  return d;
}
/** The deck with slide i's target set (0 clears it). */
export function setTarget(deck, i, seconds) {
  if (!deck.slides[i]) return deck;
  const d = JSON.parse(JSON.stringify(deck));
  const t = secs(seconds);
  if (t) d.slides[i].target = t; else delete d.slides[i].target;
  return d;
}

/**
 * A self-running show: seconds to stay on each drawn slide (deck-model layoutDeck's rows, so a slide drawn in two
 * parts shares its time). The rehearsed time, else the target, else `fallback`. Never under 2 s.
 */
export function showPlan(deck, drawn, { fallback = 8 } = {}) {
  return drawn.map((r) => {
    const s = r.index >= 0 ? deck.slides[r.index] : null;
    const t = (s && (s.took || s.target)) || fallback;
    return Math.max(2, Math.round((t / Math.max(1, r.parts || 1)) * 10) / 10);
  });
}
export const hasTimings = (deck) => deck.slides.some((s) => s.took || s.target);

// ── what the audience writes, shown on the big screen ──

// A short list (English, French, Spanish, German, Portuguese, Italian): whole words only, so "Scunthorpe" stays.
const ROUGH = ['fuck', 'fucking', 'fucker', 'motherfucker', 'shit', 'bullshit', 'cunt', 'bitch', 'asshole', 'dick', 'cock', 'pussy', 'bastard', 'slut', 'whore', 'wanker', 'twat', 'nigger', 'nigga', 'faggot', 'fag', 'retard', 'putain', 'merde', 'connard', 'connasse', 'salope', 'encule', 'enculé', 'pute', 'mierda', 'puta', 'cabron', 'cabrón', 'pendejo', 'gilipollas', 'scheisse', 'scheiße', 'arschloch', 'fotze', 'caralho', 'porra', 'merda', 'cazzo', 'stronzo', 'vaffanculo'];
const ROUGH_RE = new RegExp(`(^|[^\\p{L}\\p{N}])(${ROUGH.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})(?=$|[^\\p{L}\\p{N}])`, 'giu');
/** Text with rough words masked (f***). */
export function maskRough(text) {
  return String(text ?? '').replace(ROUGH_RE, (_, pre, w) => `${pre}${w[0]}${'*'.repeat(Math.max(2, [...w].length - 1))}`);
}
export const hasRough = (text) => { ROUGH_RE.lastIndex = 0; const r = ROUGH_RE.test(String(text ?? '')); ROUGH_RE.lastIndex = 0; return r; };
