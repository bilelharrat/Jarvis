// Eden for Education: graded work in hint mode (ROADMAP Q10) and the professor's weekly summary (Q11).
// Server: JARVIS V1 site/src/edu/hints.js and weekly.js, through course.js
//   GET/POST /api/chat/courses/<id>/assignments, POST …/assignments/<a>/delete, GET …/weekly?week=0..3
//
// - assignmentsTab: the professor's "Graded work" tab. An assignment has a name, the files (and pages or
//   slides) it covers, a due date, and optionally its questions pasted in; while it's graded, a student's
//   question about it gets hints and step checks from Eden, never the final answer.
// - weeklyCard: the top of Insights. The week's five most-struggled-with pages or slides (questions,
//   wrong practice-quiz answers, hint use), questions the materials don't cover (3+ students), and fixes.
// - hintNote: the "Hint mode: graded assignment" line under a student's reply (courses.js groundingStrip).

import { el, ico, toast } from './util.js';
import { getJSON, postJSON } from './api.js';

const BASE = '/api/chat/courses';
const day = (ms) => new Date(ms).toLocaleDateString([], { month: 'short', day: 'numeric' });
const when = (ms) => new Date(ms).toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
const localInput = (ms) => { const d = new Date(ms); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 16); };

/** Under a reply that was answered in hint mode. */
export function hintNote(hint) {
  if (!hint) return null;
  return el('div', { class: 'crs-hint', role: 'note' },
    el('div', 'crs-ground-h', ico('lock', 12), hint.label || 'Hint mode: graded assignment'),
    el('span', 'muted', el('span', { 'data-no-i18n': '' }, hint.name || 'This assignment'), ' is graded, so Eden gives hints and checks your steps instead of answers.',
      hint.struck ? ` ${hint.struck === 1 ? 'A final answer was' : `${hint.struck} final answers were`} removed.` : ''));
}

/* ---------- the professor's graded work ---------- */

export async function assignmentsTab(pane, c) {
  pane.replaceChildren(el('div', 'crs-empty', 'Loading…'));
  let list;
  try { list = (await getJSON(`${BASE}/${c.id}/assignments`)).assignments; } catch (e) { pane.replaceChildren(el('div', 'sp-warn', e.message)); return; }
  const rows = list.length ? list.map((a) => el('div', 'crs-asg',
    el('div', 'crs-asg-txt',
      el('b', { 'data-no-i18n': '' }, a.name),
      el('span', 'muted', [a.graded ? (a.active ? 'Graded: hint mode on' : 'Graded: past its due date') : 'Not graded: normal answers', a.due ? `due ${when(a.due)}` : null, a.files.map((f) => `${f.name}${f.pages ? ` (${f.pages})` : ''}`).join(', ') || null].filter(Boolean).join(' · '))),
    el('div', 'crs-row-btns',
      el('button', { type: 'button', class: 'btn', onclick: () => editor(pane, c, a) }, ico('edit', 12), 'Edit'),
      el('button', { type: 'button', class: 'crs-icon-btn', 'aria-label': `Delete ${a.name}`, onclick: async () => {
        if (!confirm(`Delete “${a.name}”? Questions about it get normal answers again.`)) return;
        try { await postJSON(`${BASE}/${c.id}/assignments/${a.id}/delete`, {}); assignmentsTab(pane, c); } catch (err) { toast(err.message); }
      } }, ico('trash', 13))))) : [el('div', 'crs-empty', 'No graded work yet.')];
  pane.replaceChildren(
    el('div', 'crs-sec-h', el('span', 'muted', 'While an assignment is graded, Eden tutors students on it: hints, one step at a time, and checks of their own work. It never gives the final answer or a full solution.'),
      el('button', { type: 'button', class: 'btn primary', onclick: () => editor(pane, c, null) }, ico('plus', 12), 'Add an assignment')),
    el('section', 'crs-box', ...rows),
    el('p', 'sp-note', 'Eden decides a question is about an assignment from its pages and words, and from whether the student is asking for the work itself. Final answers in a reply are removed before the student sees them. Hint mode ends two weeks after the due date. You see how often it was used in Insights, never who.'));
}

async function editor(pane, c, a) {
  let docs = c.docs || [];
  if (!docs.length) { try { docs = (await getJSON(`${BASE}/${c.id}`)).docs; } catch { /* below */ } }
  const name = el('input', { id: 'asgName', maxlength: '80', required: true, value: a ? a.name : '', placeholder: 'e.g. Problem Set 3' });
  const due = el('input', { id: 'asgDue', type: 'datetime-local', value: a && a.due ? localInput(a.due) : '' });
  const graded = el('input', { type: 'checkbox', id: 'asgGraded', checked: a ? a.graded : true });
  const text = el('textarea', { id: 'asgText', rows: '5', maxlength: '6000', placeholder: 'Optional: paste the questions. Eden then recognizes them when a student pastes one, even without naming the assignment. Students never see this.' });
  text.value = a && a.text ? a.text : '';
  const picked = new Map((a ? a.files : []).map((f) => [f.doc, f.pages]));
  const fileRows = docs.map((d) => {
    const box = el('input', { type: 'checkbox', checked: picked.has(d.id), 'aria-label': d.name });
    const pages = el('input', { class: 'crs-asg-pages', placeholder: 'all pages, or e.g. 3–9, 12', value: picked.get(d.id) || '', 'aria-label': `Pages or slides of ${d.name}` });
    return { d, box, pages, row: el('label', 'crs-asg-file', box, el('span', { 'data-no-i18n': '' }, d.name), pages) };
  });
  const save = el('button', { type: 'submit', class: 'btn primary crs-big' }, a ? 'Save' : 'Add assignment');
  const form = el('form', { class: 'crs-rules', onsubmit: async (e) => {
    e.preventDefault();
    save.disabled = true;
    const body = {
      ...(a ? { id: a.id } : {}), name: name.value.trim(), graded: graded.checked, text: text.value,
      due: due.value ? new Date(due.value).getTime() : null,
      files: fileRows.filter((r) => r.box.checked).map((r) => ({ doc: r.d.id, pages: r.pages.value.trim() })),
    };
    try { await postJSON(`${BASE}/${c.id}/assignments`, body); toast(a ? 'Saved' : 'Assignment added'); assignmentsTab(pane, c); }
    catch (err) { toast(err.message); save.disabled = false; }
  } },
  el('label', { class: 'crs-field', for: 'asgName' }, 'Name', name),
  el('label', { class: 'crs-field', for: 'asgDue' }, 'Due', due),
  el('label', { class: 'crs-asg-graded', for: 'asgGraded' }, graded, 'Graded: Eden gives hints, never the answer'),
  el('h4', 'crs-h', 'What it covers'),
  ...(fileRows.length ? fileRows.map((r) => r.row) : [el('div', 'crs-empty', 'Add the assignment’s files under Materials first, or paste its questions below.')]),
  el('label', { class: 'crs-field', for: 'asgText' }, 'Its questions', text),
  el('div', 'crs-row-btns', save, el('button', { type: 'button', class: 'btn crs-big', onclick: () => assignmentsTab(pane, c) }, 'Cancel')));
  pane.replaceChildren(form);
  name.focus();
}

/* ---------- the weekly summary ---------- */

/** The week's card for the Insights tab (fills itself in); `weeksAgo` 0 is the last seven days. */
export function weeklyCard(c, weeksAgo = 0) {
  const card = el('section', { class: 'crs-box crs-week', 'aria-live': 'polite' }, el('div', 'crs-empty', 'Loading this week…'));
  fillWeek(card, c, weeksAgo);
  return card;
}

async function fillWeek(card, c, weeksAgo) {
  let w;
  try { w = await getJSON(`${BASE}/${c.id}/weekly?week=${weeksAgo}`); } catch (e) { card.replaceChildren(el('div', 'sp-warn', e.message)); return; }
  const nav = el('div', { class: 'crs-seg', role: 'group', 'aria-label': 'Week' },
    el('button', { type: 'button', disabled: weeksAgo >= 3, onclick: () => fillWeek(card, c, weeksAgo + 1) }, ico('chevl', 11), 'Earlier'),
    el('button', { type: 'button', disabled: weeksAgo === 0, onclick: () => fillWeek(card, c, weeksAgo - 1) }, 'Later', ico('chevr', 11)));
  const range = `${day(w.week.from)} – ${day(w.week.to)}`;
  const head = el('div', 'crs-sec-h', el('h4', 'crs-h', weeksAgo ? `The week of ${range}` : `This week · ${range}`), nav);
  if (w.empty) { card.replaceChildren(head, el('div', 'crs-empty', 'No questions or quizzes this week.')); return; }
  const t = w.totals;
  const trend = t.questionsBefore ? (t.questions >= t.questionsBefore ? ` (up from ${t.questionsBefore})` : ` (down from ${t.questionsBefore})`) : '';
  const parts = [head,
    el('p', 'muted', `${t.students} student${t.students === 1 ? '' : 's'} asked ${t.questions} question${t.questions === 1 ? '' : 's'}${trend}`,
      t.verifiedShare === null ? '' : `; ${t.verifiedShare}% answered from your materials`,
      t.quizzes ? `; practice quizzes averaged ${t.quizAverage}%` : '', t.hintTurns ? `; ${t.hintTurns} in hint mode` : '', '.')];
  parts.push(el('h4', 'crs-h', 'Where students struggled'));
  if (w.confusions.length) {
    parts.push(el('ol', 'crs-week-list', ...w.confusions.map((x) => el('li', '',
      el('b', { 'data-no-i18n': '' }, x.where),
      el('span', 'muted', [x.asks ? `${x.asks} question${x.asks === 1 ? '' : 's'}` : null, x.wrong ? `${x.wrong} wrong quiz answer${x.wrong === 1 ? '' : 's'}` : null, x.hints ? `${x.hints} in hint mode` : null, `${x.students} students`].filter(Boolean).join(' · ')),
      ...x.missed.map((m) => el('span', 'crs-week-missed', 'Missed: ', el('span', { 'data-no-i18n': '' }, `“${m.q}”`), m.n > 1 ? ` (${m.n}×)` : ''))))));
  } else parts.push(el('div', 'crs-empty', 'Nothing stood out: no page drew questions or wrong answers from several students.'));
  if (w.gaps.length) {
    parts.push(el('h4', 'crs-h', 'Not covered by your materials'),
      ...w.gaps.map((g) => el('div', 'crs-gap', el('span', { 'data-no-i18n': '' }, g.q), el('span', 'crs-pill', `${g.students} students`))));
  }
  if (w.hints.length) {
    parts.push(el('h4', 'crs-h', 'Graded work in hint mode'),
      ...w.hints.map((h) => el('div', 'crs-gap', el('span', { 'data-no-i18n': '' }, h.name), el('span', 'crs-pill', `${h.n}× · ${h.students} student${h.students === 1 ? '' : 's'}`))));
  }
  if (w.fixes.length) parts.push(el('h4', 'crs-h', 'Suggested fixes'), el('ul', 'crs-week-fixes', ...w.fixes.map((f) => el('li', '', ico('bulb', 12), el('span', '', f)))));
  card.replaceChildren(...parts);
}
