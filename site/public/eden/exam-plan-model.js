// The exam plan (askeden ROADMAP Q8), the pure part: courses.js draws it, the course object keeps it
// per student. From the exam's date and what it covers (files, or chapters of a file), a day for each
// day until the exam: what to read (file · first page – last page), a short quiz written from exactly
// those pages, and the day's due flashcards (Q7). The last day or two are for going over everything.
// Adjustable: change the date or what's covered, tick days off, and "I'm behind" spreads what's left
// from today.

const DAY = 86_400_000;
export const MAX_DAYS = 120;

/** Days between two YYYY-MM-DD days (b − a). */
export const daysBetween = (a, b) => Math.round((Date.parse(`${b}T12:00:00Z`) - Date.parse(`${a}T12:00:00Z`)) / DAY);
export const addDays = (day, n) => new Date(Date.parse(`${day}T12:00:00Z`) + n * DAY).toISOString().slice(0, 10);
const isDay = (d) => typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d) && !Number.isNaN(Date.parse(`${d}T12:00:00Z`));

/**
 * A file's chapters, from its pages' labels: an EPUB's "ch. N…" parts, or slides/pages of a file named
 * by week or lecture have none (the whole file is one piece). [{ label, from, to }] or [].
 */
export function chaptersOf(locs) {
  const out = [];
  (locs || []).forEach((loc, i) => {
    const m = /^ch\. (\d+)(?::\s*([^()]*))?/.exec(String(loc));
    if (!m) return;
    const last = out[out.length - 1];
    if (last && last.n === Number(m[1])) last.to = i;
    else out.push({ n: Number(m[1]), label: `Chapter ${m[1]}${m[2] && m[2].trim() ? `: ${m[2].trim()}` : ''}`, from: i, to: i });
  });
  return out.length >= 2 ? out : [];
}

/**
 * Builds the plan. outline: [{ id, name, parts: [loc…] }] (the course's files, as the student may see
 * them); picks: [{ doc, from?, to? }] (part indices, inclusive; a whole file when left out); today and
 * exam: YYYY-MM-DD. Returns { exam, title, picks, created, days: [{ date, read: [{ doc, name, from, to,
 * fromLoc, toLoc }], review, done }] } or throws with a sentence to show.
 */
export function buildPlan({ outline, picks, today, exam, title = 'Exam', now = Date.now() }) {
  if (!isDay(today) || !isDay(exam)) throw new Error('Choose the exam’s date.');
  const n = daysBetween(today, exam);
  if (n < 1) throw new Error('The exam date has to be after today.');
  if (n > MAX_DAYS) throw new Error(`Plans go up to ${MAX_DAYS} days ahead. Choose a nearer date, or make the plan closer to the exam.`);
  const pages = pagesOf(outline, picks);
  if (!pages.length) throw new Error('Choose at least one file or chapter the exam covers.');
  const cleanPicks = normPicks(outline, picks);
  return { exam, title: String(title || 'Exam').slice(0, 80), picks: cleanPicks, created: now, days: spread(pages, datesFrom(today, n)) };
}

/** Every page the picks cover, in course order: [{ doc, name, i, loc }]. */
function pagesOf(outline, picks) {
  const out = [];
  for (const p of normPicks(outline, picks)) {
    const f = outline.find((d) => d.id === p.doc);
    for (let i = p.from; i <= p.to; i++) if (f.parts[i] != null) out.push({ doc: f.id, name: f.name, i, loc: f.parts[i] }); // null: outside the professor's scope
  }
  return out;
}

function normPicks(outline, picks) {
  const out = [];
  for (const f of outline || []) {
    if (!f || !Array.isArray(f.parts) || !f.parts.length) continue;
    for (const p of picks || []) {
      if (!p || p.doc !== f.id) continue;
      const last = f.parts.length - 1;
      const from = Math.max(0, Math.min(last, Number.isInteger(p.from) ? p.from : 0));
      const to = Math.max(from, Math.min(last, Number.isInteger(p.to) ? p.to : last));
      out.push({ doc: f.id, from, to });
    }
  }
  // overlapping picks of one file become one
  out.sort((a, b) => (a.doc === b.doc ? a.from - b.from : 0));
  const merged = [];
  for (const p of out) {
    const m = merged.find((x) => x.doc === p.doc && p.from <= x.to + 1 && p.to >= x.from - 1);
    if (m) { m.from = Math.min(m.from, p.from); m.to = Math.max(m.to, p.to); } else merged.push({ ...p });
  }
  return merged;
}

/** The pages over these days (the exam is the day after the last): reading days, then going-over days. */
function spread(pages, dates) {
  const n = dates.length;
  const reviewDays = n >= 8 ? 2 : n >= 3 ? 1 : 0;
  const readDays = Math.max(1, Math.min(n - reviewDays, pages.length));
  const days = [];
  for (let k = 0; k < readDays; k++) {
    const slice = pages.slice(Math.floor((k * pages.length) / readDays), Math.floor(((k + 1) * pages.length) / readDays));
    days.push({ date: dates[k], read: runs(slice), review: false, done: false });
  }
  // days left before the exam (more days than pages, or the last one or two): going over everything, varied
  return days.concat(goingOver(dates.slice(readDays)));
}

/**
 * The days after the reading, up to the exam, each with something different to do (QA 2026-10-09: a
 * plan with few pages filled the rest with identical review days). The last day is a full practice
 * test; the one before, your weakest pages first (quiz misses, quizWeakRanges); earlier ones take
 * turns: a mixed quiz on everything, a rest day, weakest pages, a rest day… A rest day has nothing new
 * (review: false, rest: true): it isn't counted as a day to do.
 */
function goingOver(dates) {
  const n = dates.length;
  const cycle = ['mixed', 'rest', 'weak', 'rest'];
  const kinds = dates.map((_, k) => (k === n - 1 ? 'practice' : k === n - 2 ? 'weak' : cycle[k % cycle.length]));
  for (let k = n - 2; k >= 0; k--) if (kinds[k] !== 'rest' && kinds[k] === kinds[k + 1]) kinds[k] = kinds[k + 1] === 'weak' ? 'mixed' : 'weak'; // never the same twice in a row
  return dates.map((date, k) => {
    const kind = kinds[k];
    return kind === 'rest' ? { date, read: [], review: false, rest: true, kind, done: false } : { date, read: [], review: true, kind, done: false };
  });
}
const datesFrom = (today, n, skip = new Set()) => Array.from({ length: n }, (_, k) => addDays(today, k)).filter((d) => !skip.has(d));

/** Consecutive pages of one file → one reading. */
function runs(pages) {
  const out = [];
  for (const p of pages) {
    const last = out[out.length - 1];
    if (last && last.doc === p.doc && last.to === p.i - 1) { last.to = p.i; last.toLoc = p.loc; }
    else out.push({ doc: p.doc, name: p.name, from: p.i, to: p.i, fromLoc: p.loc, toLoc: p.loc });
  }
  return out;
}

/** A reading's words: "Lecture 3 · slide 4 – slide 9". */
export const readingText = (r) => `${r.name} · ${r.fromLoc}${r.to > r.from ? ` – ${r.toLoc}` : ''}`;

/** The quiz for a day: its readings as page ranges (the server writes questions from just those pages). */
export const quizRanges = (day) => (day.read || []).slice(0, 6).map(({ doc, from, to }) => ({ doc, from, to }));

/**
 * A "weakest pages first" day's quiz: the covered pages missed most in practice quizzes, as page
 * ranges (at most `max`, most-missed first). misses: [{ file, at }] (a quiz's missed question: its
 * source file's name and page label, as runQuiz keeps them). [] when nothing missed is in the plan.
 */
export function quizWeakRanges(plan, outline, misses, max = 6) {
  const count = new Map();
  for (const m of misses || []) {
    if (!m || typeof m.file !== 'string' || typeof m.at !== 'string') continue;
    for (const f of outline || []) {
      if (!f || f.name !== m.file || !Array.isArray(f.parts)) continue;
      const i = f.parts.indexOf(m.at);
      if (i < 0 || !(plan.picks || []).some((p) => p.doc === f.id && i >= p.from && i <= p.to)) continue;
      const key = `${f.id}\u0000${i}`;
      count.set(key, (count.get(key) || 0) + 1);
    }
  }
  return [...count.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, max)
    .map(([key]) => { const [doc, i] = key.split('\u0000'); return { doc, from: Number(i), to: Number(i) }; });
}

/** Today's day in the plan, or null. */
export const planToday = (plan, today) => (plan && plan.days ? plan.days.find((d) => d.date === today) || null : null);

/**
 * "I'm behind" or a new exam date: whatever isn't ticked off (days before today included) is spread
 * again from today to the exam. Days already done stay as they were.
 */
export function reflow(plan, today, exam = plan.exam, outline = null) {
  if (!isDay(today) || !isDay(exam)) throw new Error('Choose the exam’s date.');
  const n = daysBetween(today, exam);
  if (n < 1) throw new Error('The exam date has to be after today.');
  if (n > MAX_DAYS) throw new Error(`Plans go up to ${MAX_DAYS} days ahead.`);
  const done = plan.days.filter((d) => d.done);
  const pages = [];
  for (const d of plan.days) {
    if (d.done) continue;
    for (const r of d.read) {
      const f = outline && outline.find((x) => x.id === r.doc);
      // page labels: from the course's outline; else the reading's own ends, and "part N" between them
      for (let i = r.from; i <= r.to; i++) pages.push({ doc: r.doc, name: r.name, i, loc: (f && f.parts[i]) || (i === r.from ? r.fromLoc : i === r.to ? r.toLoc : `part ${i + 1}`) });
    }
  }
  // days already ticked off stay as they are; what's left goes on the other days from today to the exam
  const dates = datesFrom(today, n, new Set(done.map((d) => d.date)));
  if (!dates.length) throw new Error('There’s no day left before the exam to plan.');
  const days = pages.length ? spread(pages, dates) : goingOver(dates);
  return { ...plan, exam, days: [...done, ...days].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0)) };
}

/** How far along: { done, total, behind } (behind: days before today not ticked off). */
export function progress(plan, today) {
  const work = plan.days.filter((d) => d.read.length || d.review);
  return { done: work.filter((d) => d.done).length, total: work.length, behind: work.filter((d) => !d.done && d.date < today).length };
}
