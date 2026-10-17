// A reader's news profile: their first-open answers (questions.js), checked and normalized, plus what Eden learned
// since from what they opened and what they turned down. Pure functions; store.js keeps it per account.
//
//   { v: 1, onboarded, answered, updated,
//     topics:  { <topic id>: weight }      chosen 1; a subtopic chosen 1.3; learned −1..2
//     follows: [string]                    as typed, trimmed, ≤ 30, ≤ 60 characters each
//     local:   string | null               a city or region as typed (≤ 80 characters)
//     less:    [less id]                   questions.js LESS
//     sensitive: 'show' | 'warn' | 'hide'
//     depth:   'headlines' | 'summary' | 'background'
//     amount:  5 | 10 | 20
//     hidden:  [story id]                  "Not interested" on one story (the latest 200)
//     opened:  number }                    stories opened, for how much to trust the learned weights

import { AMOUNTS, DEPTHS, LESS, SENSITIVE, TOPIC_IDS, topicById } from './questions.js';

export const CHOSEN = 1; // a topic the reader picked
export const CHOSEN_SUB = 1.3; // a subtopic they picked: more specific, so a stronger signal
export const OPEN_STEP = 0.08; // each story opened nudges its topics up…
export const LESS_STEP = 0.5; // …"Show less of this" pushes one down, harder
export const WEIGHT_MIN = -1;
export const WEIGHT_MAX = 2;
const MAX_FOLLOWS = 30;
const MAX_HIDDEN = 200;

export class ProfileError extends Error {
  constructor(message) {
    super(message);
    this.status = 400;
    this.code = 'bad_request';
  }
}

const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
const round = (x) => Math.round(x * 1000) / 1000;
const text = (v, max) => String(v ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);

/** A new reader: not onboarded, sensible defaults so a skipped question still gives a feed. */
export function emptyProfile(now = Date.now()) {
  return { v: 1, onboarded: false, answered: [], updated: now, topics: {}, follows: [], local: null, less: [], sensitive: 'warn', depth: 'summary', amount: 10, hidden: [], opened: 0 };
}

/**
 * The first-open answers (or a later edit from Settings) → a profile. Every field is optional (a step can be
 * skipped); anything unknown is refused rather than silently dropped, so a bad page is noticed in testing.
 * `previous` keeps what Eden learned (weights of topics not re-chosen, hidden stories, opens).
 */
export function fromAnswers(answers, previous = null, now = Date.now()) {
  if (!answers || typeof answers !== 'object' || Array.isArray(answers)) throw new ProfileError('Send your answers as an object.');
  const p = previous ? structuredClone(previous) : emptyProfile(now);
  const answered = [];
  if (answers.topics !== undefined) {
    if (!Array.isArray(answers.topics)) throw new ProfileError('topics is a list of topic ids.');
    const ids = [...new Set(answers.topics.map(String))];
    const unknown = ids.filter((id) => !topicById(id));
    if (unknown.length) throw new ProfileError(`Unknown topics: ${unknown.slice(0, 5).join(', ')}.`);
    // re-answering replaces the chosen set: picked ones get their weight, learned weights of others stay
    for (const [id, w] of Object.entries(p.topics)) if (w >= CHOSEN && !ids.includes(id)) delete p.topics[id];
    for (const id of ids) {
      const base = topicById(id).parent ? CHOSEN_SUB : CHOSEN;
      p.topics[id] = Math.max(base, p.topics[id] ?? 0);
      const parent = topicById(id).parent; // a subtopic implies some interest in its section
      if (parent && !(p.topics[parent] > 0)) p.topics[parent] = 0.5;
    }
    answered.push('topics');
  }
  if (answers.follows !== undefined) {
    if (!Array.isArray(answers.follows)) throw new ProfileError('follows is a list of names.');
    const seen = new Set();
    p.follows = answers.follows.map((f) => text(f, 60)).filter((f) => f.length >= 2 && !seen.has(f.toLowerCase()) && seen.add(f.toLowerCase())).slice(0, MAX_FOLLOWS);
    answered.push('follows');
  }
  if (answers.local !== undefined) {
    p.local = answers.local === null ? null : text(answers.local, 80) || null;
    answered.push('local');
  }
  if (answers.less !== undefined) {
    if (!Array.isArray(answers.less)) throw new ProfileError('less is a list.');
    const ids = [...new Set(answers.less.map(String))];
    const unknown = ids.filter((id) => !LESS.some((l) => l.id === id));
    if (unknown.length) throw new ProfileError(`Unknown choices: ${unknown.slice(0, 5).join(', ')}.`);
    p.less = ids;
    answered.push('less');
  }
  if (answers.sensitive !== undefined) {
    if (!SENSITIVE.includes(answers.sensitive)) throw new ProfileError(`sensitive is one of ${SENSITIVE.join(', ')}.`);
    p.sensitive = answers.sensitive;
    answered.push('sensitive');
  }
  if (answers.depth !== undefined) {
    if (!DEPTHS.includes(answers.depth)) throw new ProfileError(`depth is one of ${DEPTHS.join(', ')}.`);
    p.depth = answers.depth;
    answered.push('depth');
  }
  if (answers.amount !== undefined) {
    if (!AMOUNTS.includes(Number(answers.amount))) throw new ProfileError(`amount is one of ${AMOUNTS.join(', ')}.`);
    p.amount = Number(answers.amount);
    answered.push('amount');
  }
  if (answers.done === true) p.onboarded = true; // the last step (or "Skip all"): don't ask again
  p.answered = [...new Set([...(p.answered || []), ...answered])];
  p.updated = now;
  return p;
}

/**
 * What the reader did with a story → the profile, learned. `topics` are the story's topic ids (rank.js classify).
 *   open  — read it: its topics up a little (more for the first opens, less once there's history)
 *   less  — "Show less of this": its main topic down
 *   more  — "More like this": its main topic up
 *   hide  — "Not interested": this story never again, its topics down a little
 */
export function learn(profile, { action, story, topics = [] }, now = Date.now()) {
  const p = structuredClone(profile);
  const ids = topics.filter((id) => TOPIC_IDS.includes(id));
  const bump = (id, d) => { p.topics[id] = round(clamp((p.topics[id] ?? 0) + d, WEIGHT_MIN, WEIGHT_MAX)); };
  const main = ids[0];
  switch (action) {
    case 'open': {
      const step = OPEN_STEP / Math.sqrt(1 + (p.opened || 0) / 50); // early opens teach more than the 500th
      for (const id of ids) bump(id, step);
      p.opened = (p.opened || 0) + 1;
      break;
    }
    case 'less':
      if (main) bump(main, -LESS_STEP);
      break;
    case 'more':
      if (main) bump(main, LESS_STEP);
      break;
    case 'hide':
      if (typeof story === 'string' && story) p.hidden = [...(p.hidden || []).filter((s) => s !== story), story].slice(-MAX_HIDDEN);
      for (const id of ids) bump(id, -OPEN_STEP);
      break;
    default:
      throw new ProfileError('action is open, less, more or hide.');
  }
  p.updated = now;
  return p;
}

/** The profile as the page sees it (nothing hidden from the reader: it's theirs). */
export const publicProfile = (p) => ({ ...p, hidden: (p.hidden || []).length });

/** A profile the app kept on the device, rebuilt from untrusted JSON: only known topics, lists and choices survive. */
export function cleanProfile(raw, now = Date.now()) {
  const r = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const p = emptyProfile(now);
  for (const [id, w] of Object.entries(r.topics && typeof r.topics === 'object' ? r.topics : {})) {
    if (TOPIC_IDS.includes(id) && Number.isFinite(Number(w))) p.topics[id] = round(clamp(Number(w), WEIGHT_MIN, WEIGHT_MAX));
  }
  const seen = new Set();
  p.follows = (Array.isArray(r.follows) ? r.follows : []).map((f) => text(f, 60)).filter((f) => f.length >= 2 && !seen.has(f.toLowerCase()) && seen.add(f.toLowerCase())).slice(0, MAX_FOLLOWS);
  p.local = r.local ? text(r.local, 80) || null : null;
  p.less = (Array.isArray(r.less) ? r.less : []).map(String).filter((id) => LESS.some((l) => l.id === id));
  if (SENSITIVE.includes(r.sensitive)) p.sensitive = r.sensitive;
  if (DEPTHS.includes(r.depth)) p.depth = r.depth;
  if (AMOUNTS.includes(Number(r.amount))) p.amount = Number(r.amount);
  p.hidden = (Array.isArray(r.hidden) ? r.hidden : []).map((x) => String(x).slice(0, 200)).slice(-MAX_HIDDEN);
  p.onboarded = true;
  p.answered = ['app'];
  return p;
}
