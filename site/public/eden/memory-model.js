// The pure part of Eden's memory hygiene (ROADMAP N11): how old each remembered fact is, in
// words, and whether it is worth asking "is this still true?". A wrong or outdated fact is
// handed to later chats as if it were true, so the Memory page shows every fact's age and
// marks the ones that may have gone stale or that Jarvis worked out itself. No DOM, no fetch
// and no imports (src/__tests__/memory-staleness.test.ts runs this file as it is; memory.js
// draws with it). Every function takes `now` so the result is the same on any day.
//
// A fact as memory_list gives it (Jarvis, memory.py): { id, text, category, confidence, expires,
// on, source, origin, learned, changed }. `learned` is when it was first learned and `changed`
// when it was last edited, switched on or off, or said again; both are ISO times Jarvis wrote
// without a time zone (the Mac's own clock), or missing.
//
// Stale = not touched for as long as facts of its topic stay true, counted from the later of
// `learned` and `changed` (an edit means the owner just looked at it). The limits are a judgement
// about how fast each kind of fact changes, not a measurement:
//   health 90 days   (conditions, doses and doctors change, and a wrong one does the most harm)
//   work 120 days    (jobs, projects, employers, tools)
//   preferences 180  (likes and habits drift)
//   places 180       (where they live, travel, favourite spots)
//   other 365        (and any topic Jarvis adds later)
//   people 730       (names, birthdays, who is related to whom: slow to change)
// Never touched with no usable date (missing, unreadable, or in the future beyond clock skew) =
// "age unknown", treated as possibly stale. A fact with an end date still ahead (`expires`) is the
// owner's own time limit: Jarvis drops it that day, so it is not flagged.
//
// Inferred = Jarvis worked it out or took it from somewhere else, rather than the owner saying it
// or typing it into Settings: noticed, proposed (suggested, then approved), dream (drawn from daily
// notes, then approved), import and before (provenance not kept) are marked; said and settings are
// not. A fact synced from the owner's iPhone is not marked: it is the owner's own memory, only its
// original source isn't carried over. An unknown or missing source is marked (we can't show they said it).

const DAY_MS = 86_400_000;
const MONTH_DAYS = 30.44;
/** A date up to this far ahead of now is clock skew between the Mac and this browser (time zones are at most about 26 hours apart), not a real future date. */
export const FUTURE_SKEW_MS = 2 * DAY_MS;
/** Dates before this are placeholders (1970, 0001), not a moment anyone learned something. */
const MIN_YEAR = 2000;

/** Days without being touched after which a fact of that topic is worth a second look. */
export const REVIEW_AFTER_DAYS = { health: 90, work: 120, preferences: 180, places: 180, other: 365, people: 730 };
export const TOPIC_LABEL = { people: 'People', preferences: 'Preferences', work: 'Work', health: 'Health', places: 'Places', other: 'Other' };
/** Sources whose words are the owner's own: not marked inferred. */
export const SAID_SOURCES = ['said', 'settings', 'synced'];
/** The words the page shows (kept here so the page and the tests agree). */
export const WORDS = { stale: 'May be out of date', recheck: 'Still true?', inferred: 'inferred', review: 'Needs review', unknown: 'age unknown' };

const INFERRED_WHY = {
  noticed: 'Jarvis picked this up from a conversation; you didn’t tell it directly. Inferred facts are the likeliest to be wrong.',
  proposed: 'Jarvis suggested this after a conversation and you approved it, but you didn’t say it in these words. Inferred facts are the likeliest to be wrong.',
  dream: 'Jarvis drew this from your daily notes and you approved it, but you didn’t say it in these words. Inferred facts are the likeliest to be wrong.',
  import: 'Imported from somewhere else, not something you told Jarvis. Inferred facts are the likeliest to be wrong.',
  before: 'Kept from before Jarvis recorded where facts came from, so nothing shows that you said it. Inferred facts are the likeliest to be wrong.',
};
const INFERRED_UNKNOWN = 'Nothing shows that you said this to Jarvis. Inferred facts are the likeliest to be wrong.';
const UNKNOWN_WHY = {
  missing: 'Jarvis has no date for this fact, so it can’t tell how old it is. Worth checking that it is still true.',
  invalid: 'Jarvis’s date for this fact can’t be read, so it can’t tell how old it is. Worth checking that it is still true.',
  future: 'The date on this fact is in the future, so it can’t be trusted to say how old it is. Worth checking that it is still true.',
};

const ISO = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,9})?)?(Z|[+-]\d{2}:?\d{2})?)?$/;

/** The reference time as milliseconds: a number, a Date or an ISO string; the clock when it is none of them. */
function toNow(now) {
  if (typeof now === 'number' && Number.isFinite(now)) return now;
  if (now instanceof Date && Number.isFinite(now.getTime())) return now.getTime();
  if (typeof now === 'string') { const t = Date.parse(now); if (Number.isFinite(t)) return t; }
  return Date.now();
}

/** Milliseconds for an ISO date or date-time that names a real day, else NaN (Date.parse alone rolls 31 February over into March). */
function isoMs(value) {
  const s = value.trim();
  const m = ISO.exec(s);
  if (!m) return NaN;
  const n = (i) => (m[i] === undefined ? 0 : Number(m[i]));
  const [y, mo, d, h, mi, se] = [n(1), n(2), n(3), n(4), n(5), n(6)];
  if (y < MIN_YEAR || mo < 1 || mo > 12 || d < 1 || d > new Date(Date.UTC(y, mo, 0)).getUTCDate() || h > 23 || mi > 59 || se > 59) return NaN;
  return Date.parse(s.replace(' ', 'T'));
}

/**
 * One date as it was stored, checked against `now`: { status, ms? }. status is 'ok', 'missing' (nothing
 * there), 'invalid' (not a real date) or 'future' (more than the clock skew ahead of now).
 */
export function parseWhen(value, now = Date.now()) {
  const t = toNow(now);
  if (value === undefined || value === null || (typeof value === 'string' && !value.trim())) return { status: 'missing' };
  let ms = NaN;
  if (typeof value === 'string') ms = isoMs(value);
  else if (typeof value === 'number') ms = Number.isFinite(value) && value >= Date.UTC(MIN_YEAR, 0, 1) ? value : NaN;
  else if (value instanceof Date) ms = value.getTime() >= Date.UTC(MIN_YEAR, 0, 1) ? value.getTime() : NaN;
  if (!Number.isFinite(ms)) return { status: 'invalid' };
  if (ms > t + FUTURE_SKEW_MS) return { status: 'future' };
  return { status: 'ok', ms };
}

/** Whole days from a past moment to now (never negative: a date a little ahead is today). */
const daysSince = (ms, now) => Math.max(0, Math.floor((now - ms) / DAY_MS));

/** "today", "yesterday", "3 days ago", "a week ago", "3 weeks ago", "a month ago", "5 months ago", "a year ago", "2 years ago" (to the nearest week, month or year); '' for no age. */
export function agoWords(days) {
  if (typeof days !== 'number' || !Number.isFinite(days) || days < 0) return '';
  const d = Math.floor(days);
  if (d < 1) return 'today';
  if (d === 1) return 'yesterday';
  if (d < 7) return `${d} days ago`;
  if (d < 30) { const w = Math.round(d / 7); return w === 1 ? 'a week ago' : `${w} weeks ago`; }
  if (d < 365) { const mo = Math.min(11, Math.round(d / MONTH_DAYS)); return mo === 1 ? 'a month ago' : `${mo} months ago`; }
  const y = Math.round(d / 365);
  return y === 1 ? 'a year ago' : `${y} years ago`;
}

/** What the row says about the age: "learned 3 weeks ago", or "age unknown" when there is no usable number of days. */
export function ageWords(days) {
  const a = agoWords(days);
  return a ? `learned ${a}` : WORDS.unknown;
}

/** A limit in days as a person says it: "3 months", "4 months", "a year", "2 years". */
export function thresholdWords(days) {
  if (days < 60) return `${days} days`;
  if (days < 365) return `${Math.round(days / MONTH_DAYS)} months`;
  const y = Math.round(days / 365);
  return y === 1 ? 'a year' : `${y} years`;
}

/** A topic Jarvis knows, else 'other' (so a topic added later still gets a limit). */
export function topicOf(category) {
  const k = typeof category === 'string' ? category.trim().toLowerCase() : '';
  return Object.hasOwn(REVIEW_AFTER_DAYS, k) ? k : 'other';
}

/** Days after which a fact of this topic is worth re-checking. */
export const thresholdFor = (category) => REVIEW_AFTER_DAYS[topicOf(category)];

/** True when the fact is not something the owner said or typed into Settings (see the header). */
export function isInferred(source) {
  return !SAID_SOURCES.includes(typeof source === 'string' ? source : '');
}

/** The end date (YYYY-MM-DD) is still ahead: the owner gave the fact its own time limit. */
function hasFutureEnd(expires, now) {
  if (typeof expires !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(expires.trim())) return false;
  const end = isoMs(expires);
  return Number.isFinite(end) && Date.parse(`${expires.trim()}T23:59:59`) >= now;
}

/**
 * Everything the page shows about one fact's age:
 *   ageDays        whole days since it was learned, or null when that date is unusable
 *   ageWords       "learned 3 weeks ago" | "age unknown"
 *   dateStatus     'ok' | 'missing' | 'invalid' | 'future' (the learned date)
 *   touchedDays    whole days since it was last learned or changed, or null with no usable date
 *   thresholdDays  the topic's limit; topic: the topic used ('other' for a stray one)
 *   stale          worth asking "is this still true?"; staleReason: 'old' | 'age-unknown' | null
 *   staleWhy       the reason in a sentence for people ('' when not stale)
 *   inferred       Jarvis worked it out rather than the owner saying it; inferredWhy: the sentence
 */
export function assess(fact, now = Date.now()) {
  const t = toNow(now);
  const f = fact && typeof fact === 'object' ? fact : {};
  const topic = topicOf(f.category);
  const thresholdDays = REVIEW_AFTER_DAYS[topic];
  // The learned date: `learned`, else `when` or `at` (other names for it); the first one that is there.
  const asked = [f.learned, f.when, f.at].map((v) => parseWhen(v, t));
  const learned = asked.find((p) => p.status === 'ok') || asked.find((p) => p.status !== 'missing') || { status: 'missing' };
  const changed = parseWhen(f.changed, t);
  const ageDays = learned.status === 'ok' ? daysSince(learned.ms, t) : null;
  const touchedMs = Math.max(...[learned, changed].filter((p) => p.status === 'ok').map((p) => p.ms), -Infinity);
  const touchedDays = Number.isFinite(touchedMs) ? daysSince(touchedMs, t) : null;
  const touchedByEdit = touchedDays !== null && ageDays !== null && touchedDays < ageDays;

  let staleReason = null;
  if (!hasFutureEnd(f.expires, t)) {
    if (touchedDays === null) staleReason = 'age-unknown';
    else if (touchedDays >= thresholdDays) staleReason = 'old';
  }
  let staleWhy = '';
  if (staleReason === 'old') {
    const since = touchedByEdit || ageDays === null ? 'Last changed' : 'Learned';
    staleWhy = `${since} ${agoWords(touchedDays)}. ${TOPIC_LABEL[topic]} facts are worth re-checking after about ${thresholdWords(thresholdDays)}.`;
  } else if (staleReason === 'age-unknown') staleWhy = UNKNOWN_WHY[learned.status] || UNKNOWN_WHY.missing;

  const inferred = isInferred(f.source);
  return {
    ageDays, ageWords: ageWords(ageDays), dateStatus: learned.status, touchedDays, thresholdDays, topic,
    stale: staleReason !== null, staleReason, staleWhy,
    inferred, inferredWhy: inferred ? INFERRED_WHY[f.source] || INFERRED_UNKNOWN : '',
  };
}

/** Whether the fact belongs under "Needs review". */
export const needsReview = (fact, now = Date.now()) => assess(fact, now).stale;

/**
 * Counts over the facts a page is showing the owner (pass the live ones, not those waiting to be
 * forgotten): { total, stale, inferred, ageUnknown, byTopic: { topic: stale count } }. `stale` is what
 * the "Needs review" filter holds, `ageUnknown` the part of it with no usable date.
 */
export function summarize(facts, now = Date.now()) {
  const t = toNow(now);
  const out = { total: 0, stale: 0, inferred: 0, ageUnknown: 0, byTopic: {} };
  for (const fact of facts || []) {
    if (!fact || typeof fact !== 'object') continue;
    const a = assess(fact, t);
    out.total++;
    if (a.inferred) out.inferred++;
    if (a.stale) {
      out.stale++;
      out.byTopic[a.topic] = (out.byTopic[a.topic] || 0) + 1;
      if (a.staleReason === 'age-unknown') out.ageUnknown++;
    }
  }
  return out;
}
