// Who pays for students' AI in a course (ROADMAP L9; server: JARVIS V1 site/src/edu/budget.js).
//
// Students: their course turns are paid by the professor's course budget when there is one, then by
// a free daily study allowance; past both, askeden.com answers 402 and this module asks, plainly,
// whether to use their own Eden allowance for that course (this browser session only). The choice
// rides on every course send as `eduOwn: true` (api.js send extras), and on the tutor's voice.
// allowanceLine() says what's left today in plain words.
//
// The professor: budgetTab() in the course (Budget tab): a monthly amount out of their own Plus
// allowance or credits, each student's daily cap, pause, spend by day, top usage (anonymous unless
// they show the class list's names), and alerts at 80% and 100%.

import { el, ico, toast } from './util.js';
import { addSendExtra, getJSON, postJSON } from './api.js';

const BASE = '/api/chat/courses';
const ownKey = (id) => `edu:own:${id}`;

/** True when the student chose their own Eden allowance for this course in this browser session. */
export function usesOwn(courseId) {
  try { return sessionStorage.getItem(ownKey(courseId)) === '1'; } catch { return false; }
}
function setOwn(courseId, on) {
  try { if (on) sessionStorage.setItem(ownKey(courseId), '1'); else sessionStorage.removeItem(ownKey(courseId)); } catch { /* this page only */ }
}
addSendExtra((b) => (b && typeof b.course === 'string' && usesOwn(b.course) ? { eduOwn: true } : null));

/**
 * The clear prompt after a 402 in a course: resolves true when the student chose their own allowance
 * (remembered for this course until the tab closes), false otherwise.
 */
export function offerOwnAllowance(course, message) {
  return new Promise((resolve) => {
    const dlg = el('dialog', { class: 'edu-own', 'aria-labelledby': 'eduOwnH' });
    const done = (yes) => { if (yes) setOwn(course.id, true); dlg.close(); dlg.remove(); resolve(yes); };
    dlg.append(
      el('h3', { id: 'eduOwnH' }, 'Today’s free study AI is used up'),
      el('p', '', message || 'You’ve used today’s free study AI. It refills at midnight UTC.'),
      el('p', 'muted', `You can keep studying ${course.name || 'this course'} on your own Eden allowance (your plan, trial or credits). Your professor isn’t charged. This lasts until you close this tab.`),
      el('div', 'edu-own-acts',
        el('button', { type: 'button', class: 'btn', onclick: () => done(false) }, 'Not now'),
        el('button', { type: 'button', class: 'btn primary', onclick: () => done(true) }, 'Use my own allowance')));
    dlg.addEventListener('cancel', (e) => { e.preventDefault(); done(false); });
    document.body.append(dlg);
    dlg.showModal();
  });
}

/** "Free today: about 40 more questions…" for a student; nothing for the professor or TAs. Call .refresh() after a turn. */
export function allowanceLine(courseId) {
  const line = el('p', { class: 'edu-left', 'aria-live': 'polite', hidden: true });
  line.refresh = async () => {
    try {
      const d = await getJSON(`${BASE}/${courseId}/allowance`);
      if (d.role !== 'student') { line.hidden = true; return; }
      line.replaceChildren(ico('spark', 12), el('span', '', usesOwn(courseId) ? 'You chose your own Eden allowance for this course until you close this tab.' : d.text));
      if (usesOwn(courseId)) line.append(el('button', { type: 'button', class: 'crs-link', onclick: () => { setOwn(courseId, false); line.refresh(); } }, 'Stop using it'));
      line.hidden = false;
    } catch { line.hidden = true; }
  };
  line.refresh();
  return line;
}

const usd = (n) => (n >= 10 ? `$${n.toFixed(0)}` : n >= 0.01 || n === 0 ? `$${n.toFixed(2)}` : '<$0.01');

/** The professor's Budget tab. */
export async function budgetTab(pane, c, { names = false } = {}) {
  pane.replaceChildren(el('div', 'crs-empty', 'Loading…'));
  let d;
  try { d = await getJSON(`${BASE}/${c.id}/budget`); } catch (e) { pane.replaceChildren(el('div', 'sp-warn', e.message)); return; }
  let labels = new Map();
  if (names) {
    try { labels = new Map(((await getJSON(`${BASE}/${c.id}/members`)).members || []).map((m) => [m.id, m.label])); } catch { /* anonymous */ }
  }
  const stat = (v, label, note) => el('div', 'crs-stat', el('span', 'muted', label), el('b', '', v), note ? el('span', 'crs-stat-note', note) : null);
  const alerts = [];
  if (d.funded && !d.funding_ok) alerts.push(el('div', 'crs-paused', ico('lock', 13), d.why));
  if (d.alert === 100) alerts.push(el('div', 'crs-paused', ico('lock', 13), `This month’s course budget is used up (${usd(d.spent_usd)} of ${usd(d.monthly_usd)}). Students are on their free daily allowance until the 1st, or raise the budget.`));
  else if (d.alert === 80) alerts.push(el('div', 'crs-paused', ico('spark', 13), `80% of this month’s course budget is used (${usd(d.spent_usd)} of ${usd(d.monthly_usd)}).`));
  if (d.paused) alerts.push(el('div', 'crs-paused', ico('lock', 13), 'The course budget is paused. Students use their free daily allowance.'));

  const monthly = el('input', { type: 'number', min: '0', max: String(d.limits.max_monthly_usd), step: '1', value: String(d.monthly_usd || 0), id: 'crsBudget', inputmode: 'decimal' });
  const daily = el('input', { type: 'number', min: '0.05', max: String(d.limits.max_student_daily_usd), step: '0.05', value: String(d.student_daily_usd), id: 'crsDaily', inputmode: 'decimal' });
  const save = el('button', { type: 'submit', class: 'btn primary' }, 'Save budget');
  const form = el('form', { class: 'crs-rules', onsubmit: async (e) => {
    e.preventDefault();
    save.disabled = true;
    try { await postJSON(`${BASE}/${c.id}/budget`, { monthly_usd: Number(monthly.value) || 0, student_daily_usd: Number(daily.value) || d.student_daily_usd }); toast('Budget saved'); budgetTab(pane, c, { names }); } catch (err) { toast(err.message); save.disabled = false; }
  } },
  el('label', { class: 'crs-field', for: 'crsBudget' }, 'Monthly course budget (US dollars, AI cost)', monthly),
  el('label', { class: 'crs-field', for: 'crsDaily' }, 'Each student, at most a day', daily),
  el('p', 'sp-note', 'It comes out of your own Eden Plus allowance first, then your credits; askeden.com never charges a card for it. Students use it first, then their free daily allowance. Set $0 to stop funding.'),
  el('div', 'edu-own-acts',
    d.funded ? el('button', { type: 'button', class: 'btn', onclick: async () => {
      try { await postJSON(`${BASE}/${c.id}/budget`, { paused: !d.paused }); toast(d.paused ? 'Budget resumed' : 'Budget paused'); budgetTab(pane, c, { names }); } catch (err) { toast(err.message); }
    } }, d.paused ? 'Resume' : 'Pause') : null,
    save));

  const maxDay = Math.max(0.000001, ...d.days.map((x) => x.usd));
  const top = d.top.map((t, i) => ({ ...t, name: (names && labels.get(t.student)) || `Student ${i + 1}` }));
  const maxTop = top.length ? top[0].usd : 1;
  pane.replaceChildren(
    ...alerts,
    el('div', 'crs-stats',
      stat(d.funded ? `${usd(d.spent_usd)} of ${usd(d.monthly_usd)}` : 'Not funded', 'This month', d.funded ? `${d.pct}% used` : 'Students use their free daily allowance'),
      stat(usd(d.left_usd), 'Left this month', d.held_usd > 0 ? `${usd(d.held_usd)} held by answers being written` : null),
      stat(String(d.students_today), 'Students on the budget today'),
      stat(usd(d.student_daily_usd), 'Each student a day')),
    el('div', 'crs-split',
      el('section', 'crs-box', el('h4', 'crs-h', 'Course budget'), form,
        el('p', 'sp-note', `Without a budget every student still gets a free daily allowance (about ${Math.round(d.free.daily_usd / 0.002)} questions and ${Math.round(d.free.voice_chars / 900)} minutes of the tutor’s voice a day, across all their courses).`)),
      el('section', 'crs-box',
        el('h4', 'crs-h', 'Spend by day'),
        ...(d.days.length ? d.days.slice(-14).map((x) => el('div', 'crs-bar',
          el('span', 'crs-bar-txt', el('b', '', new Date(`${x.day}T12:00:00Z`).toLocaleDateString([], { month: 'short', day: 'numeric' }))),
          el('span', 'crs-bar-track', el('i', { style: { width: `${Math.max(4, Math.round((x.usd / maxDay) * 100))}%` } })),
          el('span', 'crs-n', usd(x.usd)))) : [el('div', 'crs-empty', 'Nothing spent yet this month.')]),
        el('h4', 'crs-h', 'Top usage this month'),
        el('p', 'sp-note', names ? 'Names as students gave them when joining.' : 'Anonymous by default.'),
        ...(top.length ? top.map((t) => el('div', 'crs-bar',
          el('span', 'crs-bar-txt', el('b', '', t.name)),
          el('span', 'crs-bar-track', el('i', { style: { width: `${Math.max(4, Math.round((t.usd / maxTop) * 100))}%` } })),
          el('span', 'crs-n', usd(t.usd)))) : [el('div', 'crs-empty', 'No one yet.')]),
        top.length ? el('button', { type: 'button', class: 'crs-link', onclick: () => budgetTab(pane, c, { names: !names }) }, names ? 'Hide names' : 'Show names') : null)));
}
