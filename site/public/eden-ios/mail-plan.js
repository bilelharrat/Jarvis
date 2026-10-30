// Eden Mail's Day 3 logic (ROADMAP P3), pure so the tests load it on its own:
//  - Promises: what the owner promised in their sent mail ("I'll send the deck by Friday") and what
//    others promised them ("we'll get back to you Monday"), with a due date when the words give one.
//  - Free times: three slots from the owner's calendar for "Suggest times", spread over the days,
//    in working hours; and which offered slot a reply picked ("Tuesday at 10 works").
// No imports.

const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();
const DAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);

/* ================= promises ================= */

// a promise: the speaker commits to doing something (I'll / we'll / let me / I will / I'm going to …)
const PROMISE = /\b(i['’]ll|i will|i['’]m going to|i am going to|we['’]ll|we will|let me|i can (send|get|share|have)|i['’]ll make sure|i promise to|expect (it|them|the \w+) (by|on))\b[^.!?\n]{3,160}/i;
const NOT_A_PROMISE = /\b(i['’]ll (be|have) (in|at|out|away|on leave)|let me know|i['’]ll see you|we['’]ll see|i will not|i won['’]t|if you|would you|could you|i['’]ll be there)\b/i;

/** When a phrase in a promise says it's due ("by Friday", "tomorrow", "end of day", "next week", "by Nov 12"): a Date, or null. */
export function dueOf(text, sent = new Date()) {
  const t = String(text || '').toLowerCase();
  const base = startOfDay(sent);
  if (/\b(end of (the )?day|eod|today|tonight|this (afternoon|evening))\b/.test(t)) return base;
  if (/\btomorrow\b/.test(t)) return addDays(base, 1);
  if (/\b(end of (the )?week|eow|this week)\b/.test(t)) return addDays(base, ((5 - base.getDay() + 7) % 7));
  if (/\bnext week\b/.test(t)) return addDays(base, ((5 - base.getDay() + 7) % 7) + 7);
  if (/\b(end of (the )?month|this month)\b/.test(t)) return new Date(base.getFullYear(), base.getMonth() + 1, 0);
  const inN = /\bin (\d{1,2}|a|one|two|three|a couple of) (day|days|week|weeks)\b/.exec(t);
  if (inN) { const n = { a: 1, one: 1, two: 2, three: 3, 'a couple of': 2 }[inN[1]] || Number(inN[1]); return addDays(base, /week/.test(inN[2]) ? n * 7 : n); }
  const wd = /\b(?:by|on|before|until|this|next)?\s*(sunday|monday|tuesday|wednesday|thursday|friday|saturday|mon|tue|tues|wed|thu|thur|thurs|fri|sat|sun)\b/.exec(t);
  if (wd) { const i = DAYS.findIndex((d) => d.startsWith(wd[1].slice(0, 3))); return addDays(base, ((i - base.getDay() + 7) % 7) || 7); } // the next such day
  const md = /\b(?:by|on|before)?\s*(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})\b|\b(\d{1,2})(?:st|nd|rd|th)?\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\b/.exec(t);
  if (md) {
    const mon = MONTHS.indexOf((md[1] || md[4]).slice(0, 3)), day = Number(md[2] || md[3]);
    let d = new Date(base.getFullYear(), mon, day);
    if (d < addDays(base, -60)) d = new Date(base.getFullYear() + 1, mon, day);
    return d;
  }
  return null;
}

/** A short stable id for a promise (its words and where it came from), so ticking it off sticks. */
export function promiseId(text, source) {
  let h = 2166136261;
  for (const c of `${source}|${clean(text).toLowerCase()}`) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); }
  return (h >>> 0).toString(36);
}

/**
 * Promises in one email's own text (no quoted thread). `mine`: the owner wrote it (they owe), else
 * the sender owes the owner. → [{ id, text, due: Date | null, who, mine, msgId, threadId, subject, sent }].
 */
export function promisesIn({ text, from = '', to = [], date, id = '', threadId = '', subject = '' }, mine) {
  const sent = Number.isFinite(Date.parse(date)) ? new Date(date) : new Date();
  const out = [];
  for (const sentence of String(text || '').split(/(?<=[.!?])\s+|\n+/)) {
    const m = PROMISE.exec(sentence);
    if (!m || NOT_A_PROMISE.test(m[0])) continue;
    const words = clean(sentence).replace(/^(and|also|so|ok|okay|sure|great|thanks)[,!]?\s+/i, '');
    if (words.length < 12 || words.length > 220) continue;
    const who = mine ? (Array.isArray(to) ? to[0] : to) || '' : from;
    out.push({ id: promiseId(words, id), text: words.replace(/[.!]+$/, ''), due: dueOf(words, sent), who, mine, msgId: id, threadId, subject, sent: sent.toISOString() });
  }
  return out.slice(0, 3);
}

/** The open promises, soonest due first (no date last), overdue marked; old ones (14 days past due or 30 days old with no date) dropped. */
export function openPromises(list, done = new Set(), now = new Date()) {
  const today = startOfDay(now);
  return (list || []).filter((p) => !done.has(p.id))
    .filter((p) => (p.due ? new Date(p.due) >= addDays(today, -14) : Date.parse(p.sent) >= addDays(today, -30).getTime()))
    .map((p) => ({ ...p, overdue: Boolean(p.due && new Date(p.due) < today), today: Boolean(p.due && startOfDay(new Date(p.due)).getTime() === today.getTime()) }))
    .sort((a, b) => (a.due ? Date.parse(a.due) : Infinity) - (b.due ? Date.parse(b.due) : Infinity));
}

/* ================= free times and the reply that picks one ================= */

/**
 * Up to `n` free slots of `minutes` from `from` over the next `days` working days, between
 * `dayStart` and `dayEnd` (hours), not overlapping `busy` ([{ start: Date, end: Date }]),
 * one per day first (spread out), on the hour or half hour, at least 2 hours from now.
 */
export function freeSlots(busy, { from = new Date(), days = 7, minutes = 30, n = 3, dayStart = 9, dayEnd = 18 } = {}) {
  const earliest = new Date(from.getTime() + 2 * 3600_000);
  const intervals = (busy || []).map((b) => [new Date(b.start).getTime(), new Date(b.end).getTime()]);
  const free = (s, e) => !intervals.some(([a, b]) => s < b && e > a);
  const perDay = [];
  for (let d = 0, work = 0; work < days && d < days * 2 + 7; d++) {
    const day = addDays(startOfDay(from), d);
    if (day.getDay() === 0 || day.getDay() === 6) continue;
    work++;
    const slots = [];
    for (let h = dayStart * 60; h + minutes <= dayEnd * 60; h += 30) {
      const s = new Date(day.getFullYear(), day.getMonth(), day.getDate(), Math.floor(h / 60), h % 60);
      const e = new Date(s.getTime() + minutes * 60_000);
      if (s < earliest || !free(s.getTime(), e.getTime())) continue;
      if (s.getHours() === 12 || (s.getHours() === 13 && s.getMinutes() === 0 && minutes > 30)) continue; // lunch, when there's another choice
      slots.push({ start: s, end: e });
    }
    if (slots.length) perDay.push(slots);
  }
  const out = [];
  // a mid-morning or mid-afternoon slot each day first, then any
  for (const slots of perDay) { if (out.length >= n) break; out.push(slots.find((x) => x.start.getHours() === 10 || x.start.getHours() === 14) || slots[0]); }
  for (const slots of perDay) for (const x of slots) { if (out.length >= n) break; if (!out.includes(x)) out.push(x); }
  return out.slice(0, n).sort((a, b) => a.start - b.start);
}

const hm = (d) => d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }).replace(':00', '').toLowerCase().replace(' ', '');
/** "Tue Oct 13, 10–10:30am" lines for the email. */
export const slotText = (s) => `${s.start.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })}, ${hm(s.start)}–${hm(s.end)}`;

/**
 * Which offered slot a reply picks: "Tuesday works", "10am on the 13th", "the first one", "option 2".
 * → the slot, or null when it can't tell (more than one fits, or none).
 */
export function pickedSlot(reply, slots) {
  const t = String(reply || '').toLowerCase();
  if (!slots || !slots.length) return null;
  const ord = /\b(first|1st|second|2nd|third|3rd|option ([123])|#([123]))\b/.exec(t);
  if (ord) { const i = ord[2] || ord[3] ? Number(ord[2] || ord[3]) - 1 : { first: 0, '1st': 0, second: 1, '2nd': 1, third: 2, '3rd': 2 }[ord[1]]; if (slots[i]) return slots[i]; }
  const hits = slots.filter((s) => {
    const day = DAYS[s.start.getDay()];
    const dayHit = new RegExp(`\\b${day.slice(0, 3)}`).test(t) || new RegExp(`\\b${s.start.getDate()}(st|nd|rd|th)?\\b`).test(t);
    const h = s.start.getHours(), h12 = ((h + 11) % 12) + 1;
    const timeHit = new RegExp(`\\b${h12}(:${String(s.start.getMinutes()).padStart(2, '0')})?\\s*(${h < 12 ? 'am|a\\.m\\.' : 'pm|p\\.m\\.'})?\\b`).test(t);
    return dayHit && (timeHit || !/\d/.test(t.replace(/\b\d{1,2}(st|nd|rd|th)\b/g, '')));
  });
  return hits.length === 1 ? hits[0] : null;
}
