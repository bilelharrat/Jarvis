// Spaced repetition for the study companion (askeden ROADMAP Q7), the pure part: study.js draws it,
// the course object on askeden.com keeps each student's card states (private to them).
//
// The scheduler is FSRS-4.5 (the Free Spaced Repetition Scheduler, open-spaced-repetition, MIT) with its
// published default weights: each card has a stability S (days until recall falls to 90%) and a
// difficulty D (1–10); a review's grade (1 Again, 2 Hard, 3 Good, 4 Easy) and how well the card was
// still remembered at that moment give the new S and D, and the next review is when recall is
// expected to be 90% again. "Know it" counts as Good, "Still learning" as Again.

export const W = [0.4872, 1.4003, 3.7145, 13.8206, 5.1618, 1.2298, 0.8975, 0.031, 1.6474, 0.1367, 1.0461, 2.1072, 0.0793, 0.3246, 1.587, 0.2272, 2.8755];
export const DECAY = -0.5;
export const FACTOR = 19 / 81; // so that recall is 90% when t = S
export const RETENTION = 0.9;
export const DAY = 86_400_000;
export const RELEARN_MS = 10 * 60_000; // "Again": back in ten minutes, the same session
export const MAX_DAYS = 365;
export const NEW_PER_DAY = 10;
export const GRADES = [[1, 'Again'], [2, 'Hard'], [3, 'Good'], [4, 'Easy']];

const clampD = (d) => Math.min(10, Math.max(1, d));

/** How likely the card is still remembered `t` days after a review, with stability `s`. */
export const retrievability = (t, s) => Math.pow(1 + (FACTOR * Math.max(0, t)) / s, DECAY);

/** Days until recall falls to `r` (0.9: exactly S). */
export const intervalDays = (s, r = RETENTION) => (s / FACTOR) * (Math.pow(r, 1 / DECAY) - 1);

const initD = (g) => clampD(W[4] - (g - 3) * W[5]);

/** The new { s, d } after grade g, from the state before (null: the first time the card is seen). */
export function nextMemory(prev, g, elapsedDays) {
  if (!prev || !(prev.s > 0)) return { s: W[g - 1], d: initD(g) };
  const { s, d } = prev;
  const r = retrievability(elapsedDays, s);
  let ns;
  if (g === 1) {
    ns = Math.min(s, W[11] * Math.pow(d, -W[12]) * (Math.pow(s + 1, W[13]) - 1) * Math.exp(W[14] * (1 - r)));
  } else {
    const hard = g === 2 ? W[15] : 1, easy = g === 4 ? W[16] : 1;
    ns = s * (1 + Math.exp(W[8]) * (11 - d) * Math.pow(s, -W[9]) * (Math.exp(W[10] * (1 - r)) - 1) * hard * easy);
  }
  const nd = clampD(W[7] * initD(4) + (1 - W[7]) * (d - W[6] * (g - 3))); // mean reversion toward Good's start
  return { s: Math.max(0.01, ns), d: nd };
}

/**
 * A card's state after a review: { s, d, due, last, reps, lapses, first }. Again comes back in ten
 * minutes; Hard, Good and Easy when recall is due to fall to 90% (at least a day, at most a year).
 */
export function review(state, g, now = Date.now()) {
  g = Math.min(4, Math.max(1, Math.round(Number(g)) || 1));
  const prev = state && state.s > 0 ? state : null;
  const elapsed = prev && prev.last ? Math.max(0, (now - prev.last) / DAY) : 0;
  const { s, d } = nextMemory(prev, g, elapsed);
  const days = g === 1 ? 0 : Math.min(MAX_DAYS, Math.max(1, Math.round(intervalDays(s))));
  return {
    s: Math.round(s * 1000) / 1000, d: Math.round(d * 1000) / 1000,
    due: g === 1 ? now + RELEARN_MS : now + days * DAY, last: now,
    reps: ((prev && prev.reps) || 0) + 1, lapses: ((prev && prev.lapses) || 0) + (g === 1 && prev ? 1 : 0),
    first: (state && state.first) || now,
  };
}

/** What each grade would do, for the buttons: [{ g, label, due, text }] ("10 min", "3 days", "2 mo"). */
export function preview(state, now = Date.now()) {
  return GRADES.map(([g, label]) => { const n = review(state, g, now); return { g, label, due: n.due, text: waitText(n.due - now) }; });
}

export function waitText(ms) {
  const min = Math.round(ms / 60_000);
  if (min < 60) return `${Math.max(1, min)} min`;
  const days = Math.round(ms / DAY);
  if (days < 1) return `${Math.round(ms / 3600_000)} h`;
  if (days < 31) return `${days} day${days === 1 ? '' : 's'}`;
  if (days < 365) return `${Math.round(days / 30)} mo`;
  return `${Math.round((days / 365) * 10) / 10} yr`;
}

/** A card's key within its set: from its term and definition, so editing a set keeps the rest's history. */
export function cardKey(card) {
  const t = `${norm(card && card.term)}|${norm(card && card.def).slice(0, 120)}`;
  let h = 0x811c9dc5;
  for (let i = 0; i < t.length; i++) { h ^= t.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(36);
}
const norm = (t) => String(t || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

/** The local day, YYYY-MM-DD. */
export function dayKey(ms = Date.now()) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
export function endOfDay(ms = Date.now()) { const d = new Date(ms); d.setHours(23, 59, 59, 999); return d.getTime(); }
/** The day before a YYYY-MM-DD day. */
export function prevDay(day) { const d = new Date(`${day}T12:00:00Z`); d.setUTCDate(d.getUTCDate() - 1); return d.toISOString().slice(0, 10); }

/**
 * Today's review across a course's sets: the cards due by the end of today (oldest first), then up to
 * `newPerDay` cards never seen, less the new ones already started today. sets: [{ id, title, cards }];
 * states: { [setId]: { [cardKey]: state } }. Returns [{ set, card, key, state }].
 */
export function dueToday(sets, states, now = Date.now(), { newPerDay = NEW_PER_DAY } = {}) {
  const end = endOfDay(now), today = dayKey(now);
  const due = [], fresh = [];
  let startedToday = 0;
  const seen = new Set();
  for (const set of sets || []) {
    if (!set || !Array.isArray(set.cards) || seen.has(set.id)) continue;
    seen.add(set.id);
    const st = (states && states[set.id]) || {};
    for (const v of Object.values(st)) if (v && v.first && dayKey(v.first) === today) startedToday++;
    const keys = new Set();
    for (const card of set.cards) {
      const key = cardKey(card);
      if (keys.has(key)) continue;
      keys.add(key);
      const state = st[key];
      if (state && state.due) { if (state.due <= end) due.push({ set, card, key, state }); }
      else fresh.push({ set, card, key, state: null });
    }
  }
  due.sort((a, b) => a.state.due - b.state.due);
  return [...due, ...fresh.slice(0, Math.max(0, newPerDay - startedToday))];
}

/** Two copies of a set's states (this browser's, the server's): for each card, the later review wins. */
export function mergeStates(a, b) {
  const out = { ...(a || {}) };
  for (const [k, v] of Object.entries(b || {})) if (v && (!out[k] || (v.last || 0) > (out[k].last || 0))) out[k] = v;
  return out;
}

/** The daily streak after studying on `day`: { last, count, best }. */
export function bumpStreak(streak, day) {
  const s = streak && streak.last ? streak : { last: null, count: 0, best: 0 };
  if (s.last === day) return s;
  const count = s.last && s.last === prevDay(day) ? s.count + 1 : 1;
  return { last: day, count, best: Math.max(s.best || 0, count) };
}

/** The streak as it stands today: unbroken while the last study day is today or yesterday. */
export function streakNow(streak, today = dayKey()) {
  if (!streak || !streak.last) return 0;
  return streak.last === today || streak.last === prevDay(today) ? streak.count : 0;
}
