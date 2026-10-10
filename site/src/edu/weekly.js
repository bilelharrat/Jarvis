// Eden for Education: the professor's weekly summary (askeden ROADMAP Q11), shown in the app
// (askeden.com sends no email). Built from the course's anonymous insight records (course.js
// `r:` keys: a question's status and the pages it hit, a practice quiz's score and the
// questions missed with their source page, hint-mode turns), for one week at a time:
//
//   - the five pages or slides students struggled with most: questions about them, answers there
//     that needed more than the page says, wrong practice-quiz answers whose source they are,
//     hint-mode turns on them, and the quiz questions most often missed there;
//   - the questions the materials don't cover, only once 3+ students asked (as insights do);
//   - graded assignments where many students needed hints;
//   - a suggested fix for each ("Add a worked example to Slide 14 of Lecture 5").
//
// Nothing here names or counts a single student's words: pages and counts, generated quiz
// questions, and not-covered questions only past the three-student threshold.

export const WEEKLY = { confusions: 5, gaps: 5, fixes: 8, weeksBack: 4, gapMin: 3 };
const DAY = 864e5;

const norm = (text) => String(text || '').toLowerCase().replace(/[‘’]/g, "'").replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const cap = (text) => String(text || '').replace(/^\p{Ll}/u, (c) => c.toUpperCase());

/** "slide 14" in "Lecture 5" → "Slide 14 of Lecture 5". */
export const whereOf = (name, loc) => (loc ? `${cap(loc)} of ${name || 'your materials'}` : name || 'your materials');

/** The suggested fix for one struggled-with page. */
export function fixFor(c) {
  const where = whereOf(c.name, c.loc);
  if (c.wrong >= 2 && c.wrong >= c.asks) return `Add a worked example to ${where}: ${c.wrong} practice-quiz answers about it were wrong.`;
  if (c.asks >= 2 && c.unclear * 2 >= c.asks) return `Expand ${where}: ${c.unclear} of ${c.asks} answers about it needed more than the page says.`;
  if (c.hints >= 2) return `Go over the idea behind ${where} in class: students on graded work kept asking for hints there.`;
  if (c.wrong >= 1) return `Add a worked example to ${where}: students asked about it ${c.asks} time${c.asks === 1 ? '' : 's'} and missed quiz questions on it.`;
  return `Students kept coming back to ${where}: a short recap or a worked example there may help.`;
}

/**
 * One week of a course, for its professor and TAs. `weeksAgo` 0 is the last seven days, 1 the seven before, …
 * `records`: the course's insight records; `assignments`: its graded assignments (hints.js).
 */
export function weeklySummary({ course = {}, records = [], assignments = [], now = Date.now(), weeksAgo = 0 } = {}) {
  const w = Math.min(WEEKLY.weeksBack - 1, Math.max(0, Math.floor(Number(weeksAgo) || 0)));
  const to = now - w * 7 * DAY;
  const from = to - 7 * DAY;
  const inWeek = records.filter((r) => r && r.at > from && r.at <= to);
  const before = records.filter((r) => r && r.at > from - 7 * DAY && r.at <= from && r.kind !== 'quiz').length;
  const asks = inWeek.filter((r) => r.kind !== 'quiz');
  const quizzes = inWeek.filter((r) => r.kind === 'quiz');

  // the pages: questions (their best page), unclear answers there, wrong quiz answers sourced there, hint turns
  const pages = new Map();
  const page = (name, loc) => {
    const k = `${name}\u0000${loc}`;
    if (!pages.has(k)) pages.set(k, { name, loc, asks: 0, unclear: 0, wrong: 0, hints: 0, who: new Set(), missed: new Map() });
    return pages.get(k);
  };
  for (const r of asks) {
    const h = Array.isArray(r.hits) ? r.hits[0] : null;
    if (!h || !h.name || r.status === 'general') continue; // not covered: that's a gap, not this page's
    const p = page(h.name, h.loc || '');
    p.asks++;
    if (r.status !== 'verified') p.unclear++;
    if (r.hint) p.hints++;
    p.who.add(r.member);
  }
  for (const r of quizzes) {
    for (const m of Array.isArray(r.missed) ? r.missed : []) {
      if (!m || !m.name) continue;
      const p = page(m.name, m.loc || '');
      p.wrong++;
      p.who.add(r.member);
      if (m.q) { const k = norm(m.q); const e = p.missed.get(k) || { q: m.q, n: 0 }; e.n++; p.missed.set(k, e); }
    }
  }
  const confusions = [...pages.values()]
    .map((p) => ({ ...p, score: p.asks + 2 * p.wrong + 0.5 * p.unclear + 0.5 * p.hints }))
    .filter((p) => p.asks + p.wrong >= 2 && p.who.size >= 2) // a class's confusion, not one student's
    .sort((a, b) => b.score - a.score || b.who.size - a.who.size)
    .slice(0, WEEKLY.confusions)
    .map((p) => ({
      name: p.name, loc: p.loc, where: whereOf(p.name, p.loc), asks: p.asks, unclear: p.unclear, wrong: p.wrong, hints: p.hints, students: p.who.size,
      missed: [...p.missed.values()].sort((a, b) => b.n - a.n).slice(0, 2).map(({ q, n }) => ({ q, n })),
      fix: fixFor(p),
    }));

  // not covered: as insights, only once three or more students asked
  const gapMap = new Map();
  for (const r of asks) if (r.q) { const k = norm(r.q); const g = gapMap.get(k) || { q: r.q, n: 0, who: new Set() }; g.n++; g.who.add(r.member); gapMap.set(k, g); }
  const gaps = [...gapMap.values()].filter((g) => g.who.size >= WEEKLY.gapMin).sort((a, b) => b.n - a.n).slice(0, WEEKLY.gaps)
    .map((g) => ({ q: g.q, n: g.n, students: g.who.size, fix: `Add material on “${g.q}”: ${g.who.size} students asked and Eden had to answer from general knowledge.` }));

  // graded assignments in hint mode
  const names = new Map(assignments.map((a) => [a.id, a.name]));
  const hintMap = new Map();
  for (const r of asks) if (r.hint) { const h = hintMap.get(r.hint) || { n: 0, who: new Set() }; h.n++; h.who.add(r.member); hintMap.set(r.hint, h); }
  const hints = [...hintMap].map(([id, h]) => ({ id, name: names.get(id) || 'A removed assignment', n: h.n, students: h.who.size }))
    .sort((a, b) => b.n - a.n).slice(0, 5)
    .map((h) => ({ ...h, ...(h.students >= WEEKLY.gapMin ? { fix: `${h.students} students needed hints on “${h.name}”: a short review of the idea before it’s due may help.` } : {}) }));

  const fixes = [...confusions.map((c) => c.fix), ...gaps.map((g) => g.fix), ...hints.filter((h) => h.fix).map((h) => h.fix)].slice(0, WEEKLY.fixes);
  const verified = asks.filter((r) => r.status === 'verified').length;
  return {
    course: course && course.name ? course.name : null,
    week: { from, to, weeksAgo: w },
    totals: {
      questions: asks.length,
      questionsBefore: before,
      students: new Set(inWeek.map((r) => r.member)).size,
      verifiedShare: asks.length ? Math.round((verified / asks.length) * 100) : null,
      quizzes: quizzes.length,
      quizAverage: quizzes.length ? Math.round((quizzes.reduce((n, r) => n + r.score / r.total, 0) / quizzes.length) * 100) : null,
      hintTurns: asks.filter((r) => r.hint).length,
    },
    confusions, gaps, hints, fixes,
    empty: !asks.length && !quizzes.length,
  };
}
