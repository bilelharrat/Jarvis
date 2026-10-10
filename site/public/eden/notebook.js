// The notebook (Eden for Education): each student's notes, per course: ones they write, and answers
// or source pages they clip ("Clip to notebook" under an answer, "Clip this page" in the companion).
// Notes are Markdown, kept in this browser (localStorage edu:notes:v1) and in the course on askeden.com
// (…/notes: only the student's own; the newest copy wins), so they follow a student between devices.
//
//   notebookView(root, { courses, courseId, noteId, go })   the notebook (all courses, or one) or one note;
//                                                         go(courseId, noteId) moves within it (edu-app.js
//                                                         draws it in the panel on the right, #notebookPane)
//   clipMenu(anchor, course, clip)                      "New note" or add to a recent note of that course

import { el, ico, toast } from './util.js';
import { getJSON, postJSON } from './api.js';
import { renderMarkdown } from './markdown.js';
import { locale, t } from './i18n.js';

const KEY = 'edu:notes:v1';
const BASE = '/api/chat/courses';
const newId = () => `n${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;

function all() { try { const v = JSON.parse(localStorage.getItem(KEY) || '{}'); return v && typeof v === 'object' ? v : {}; } catch { return {}; } }
function keep(map) { try { localStorage.setItem(KEY, JSON.stringify(map)); } catch { toast('This browser’s storage is full: the note is kept on askeden.com only.'); } }
const list = (courseId) => Object.values(all()).filter((n) => !courseId || n.courseId === courseId).sort((a, b) => b.updated - a.updated);
const snippet = (body) => String(body || '').replace(/[#>*_`[\]]/g, '').replace(/\s+/g, ' ').trim().slice(0, 140);
const when = (t) => { const d = Math.round((Date.now() - t) / 864e5); return d <= 0 ? new Date(t).toLocaleTimeString(locale(), { hour: 'numeric', minute: '2-digit' }) : d === 1 ? 'Yesterday' : new Date(t).toLocaleDateString(locale()); };

const timers = new Map();
/** Kept here at once; sent to askeden.com a moment after the last change. */
function store(note, { now = false } = {}) {
  const map = all();
  map[note.id] = note;
  keep(map);
  clearTimeout(timers.get(note.id));
  const send = () => postJSON(`${BASE}/${note.courseId}/notes`, { id: note.id, title: note.title, body: note.body, updated: note.updated, created: note.created }).catch(() => {});
  if (now) send(); else timers.set(note.id, setTimeout(send, 700));
}
function drop(note) {
  const map = all();
  delete map[note.id];
  keep(map);
  postJSON(`${BASE}/${note.courseId}/notes/${note.id}/delete`, {}).catch(() => {});
}

/** Notes made on another device: each course's list, newer ones fetched (in parallel across courses). */
export async function syncNotes(courses) {
  let changed = false;
  await Promise.all(courses.map(async (c) => {
    let remote = [];
    try { remote = (await getJSON(`${BASE}/${c.id}/notes`)).notes; } catch { return; }
    const map = all();
    await Promise.all(remote.map(async (r) => {
      const have = map[r.id];
      if (have && have.updated >= r.updated) return;
      try {
        const full = await getJSON(`${BASE}/${c.id}/notes/${r.id}`);
        const m = all();
        m[full.id] = { ...full, courseId: c.id, courseName: c.name };
        keep(m);
        changed = true;
      } catch { /* next time */ }
    }));
  }));
  return changed;
}

/* ---------- clipping ---------- */

/** A note made from a clip, or the clip added to the end of an existing note. */
export function clip(course, { title, body }, into = null) {
  const now = Date.now();
  const stamp = `\n\n---\n*${t('Clipped')} ${new Date(now).toLocaleString(locale(), { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}*\n\n`;
  const note = into
    ? { ...into, body: `${into.body.trimEnd()}${stamp}${title ? `### ${title}\n\n` : ''}${body}`, updated: now }
    : { id: newId(), courseId: course.id, courseName: course.name, title: (title || t('Clipped answer')).slice(0, 120), body, created: now, updated: now };
  store(note, { now: true });
  dispatchEvent(new CustomEvent('eden:notes-changed'));
  return note;
}

/** The little menu a clip button opens: a new note, or one of this course's recent notes. */
export function clipMenu(anchor, course, what) {
  document.querySelector('.nb-menu')?.remove();
  const recent = list(course.id).slice(0, 5);
  const done = (note) => {
    menu.remove();
    toast('Clipped to your notebook', { label: 'Open', run: () => dispatchEvent(new CustomEvent('eden:notebook-open', { detail: { courseId: course.id, noteId: note.id } })) });
  };
  const menu = el('div', { class: 'nb-menu glass', role: 'menu', 'aria-label': 'Clip to' },
    el('div', 'nb-menu-h', 'Clip to'),
    el('button', { type: 'button', role: 'menuitem', class: 'nb-menu-item', onclick: () => done(clip(course, what)) }, ico('plus', 13), el('span', '', 'A new note')),
    ...recent.map((n) => el('button', { type: 'button', role: 'menuitem', class: 'nb-menu-item', onclick: () => done(clip(course, what, n)) }, ico('doc', 13), el('span', { 'data-no-i18n': '' }, n.title))));
  document.body.append(menu);
  const r = anchor.getBoundingClientRect();
  menu.style.left = `${Math.max(8, Math.min(innerWidth - 268, r.left))}px`;
  menu.style.top = `${r.bottom + 6 + 220 > innerHeight ? Math.max(8, r.top - 6 - menu.offsetHeight) : r.bottom + 6}px`;
  const away = (e) => { if (!menu.contains(e.target) && e.target !== anchor) { menu.remove(); removeEventListener('pointerdown', away, true); } };
  addEventListener('pointerdown', away, true);
  menu.querySelector('button').focus();
}

/* ---------- the notebook ---------- */

/** The notebook: every course's notes (or one course's), a search, and a new note; or one note open. */
export function notebookView(root, { courses = [], courseId = null, noteId = null, go = (c, n, nc) => { location.hash = n ? `#/notebook/${nc || c}/${n}` : '#/notebook'; } } = {}) {
  if (noteId) return editor(root, courses, courseId, noteId, go);
  const q = el('input', { class: 'nb-search', type: 'search', placeholder: 'Search your notes', 'aria-label': 'Search your notes' });
  const filter = el('select', { class: 'nb-filter', 'aria-label': 'Course' },
    el('option', { value: '' }, 'All courses'), ...courses.map((c) => el('option', { value: c.id, selected: c.id === courseId ? true : null, 'data-no-i18n': '' }, c.name)));
  const grid = el('div', 'nb-grid');
  const draw = () => {
    const words = q.value.trim().toLowerCase();
    const notes = list(filter.value || null).filter((n) => !words || `${n.title} ${n.body}`.toLowerCase().includes(words));
    grid.replaceChildren(...(notes.length ? notes.map((n) => el('button', { type: 'button', class: 'nb-card', onclick: () => go(filter.value || null, n.id, n.courseId) },
      el('b', { 'data-no-i18n': '' }, n.title), el('span', { class: 'nb-snip', 'data-no-i18n': '' }, snippet(n.body) || t('Empty note')), el('span', { class: 'nb-meta', 'data-no-i18n': '' }, `${n.courseName || ''} · ${t(when(n.updated))}`)))
      : [el('div', 'crs-empty', words ? 'No note matches.' : 'No notes yet. Write one, or tap “Clip to notebook” under any answer.')]));
  };
  q.addEventListener('input', draw);
  filter.addEventListener('change', draw);
  const newNote = () => {
    const c = courses.find((x) => x.id === (filter.value || courseId)) || courses[0];
    if (!c) { toast('Join or create a course first: notes belong to a course.'); return; }
    const now = Date.now();
    const note = { id: newId(), courseId: c.id, courseName: c.name, title: t('Untitled note'), body: '', created: now, updated: now };
    store(note, { now: true });
    go(filter.value || null, note.id, c.id);
  };
  root.replaceChildren(el('div', 'nb',
    el('div', 'nb-bar', q, filter, el('button', { type: 'button', class: 'btn primary', onclick: newNote }, ico('plus', 13), 'New note')),
    el('p', 'nb-hint muted', 'Your notes for every course, and the answers and pages you clip. Only you can see them.'),
    grid));
  draw();
}

function editor(root, courses, courseId, noteId, go) {
  let note = all()[noteId];
  if (!note) {
    root.replaceChildren(el('div', 'nb', el('div', 'crs-loading', el('span', 'crs-spin'), 'Opening the note…')));
    getJSON(`${BASE}/${courseId}/notes/${noteId}`).then((full) => {
      const c = courses.find((x) => x.id === courseId);
      const m = all(); m[full.id] = { ...full, courseId, courseName: c ? c.name : '' }; keep(m);
      editor(root, courses, courseId, noteId, go);
    }, () => { root.replaceChildren(el('div', 'nb', el('div', 'sp-warn', el('b', '', 'That note is gone'), el('button', { type: 'button', class: 'crs-back', onclick: () => go(null, null) }, 'Back to the notebook')))); });
    return;
  }
  const title = el('input', { class: 'nb-title', value: note.title, maxlength: '120', 'aria-label': 'Title' });
  const body = el('textarea', { class: 'nb-body', placeholder: 'Write your notes… Markdown works: # headings, **bold**, - lists.', 'aria-label': 'Note' });
  body.value = note.body;
  const preview = el('div', { class: 'nb-preview md', hidden: true });
  const saved = el('span', 'nb-saved muted', 'Saved');
  const change = () => {
    note = { ...note, title: title.value.trim() || t('Untitled note'), body: body.value, updated: Date.now() };
    store(note);
    saved.textContent = 'Saved';
  };
  title.addEventListener('input', () => { saved.textContent = 'Saving…'; change(); });
  body.addEventListener('input', () => { saved.textContent = 'Saving…'; change(); });
  const mode = (show) => {
    preview.hidden = !show; body.hidden = show;
    if (show) preview.replaceChildren(renderMarkdown(body.value || `*${t('Nothing written yet.')}*`, {}));
    seg.querySelectorAll('button').forEach((b, i) => b.classList.toggle('on', (i === 1) === show));
  };
  const seg = el('div', { class: 'crs-seg', role: 'group', 'aria-label': 'View' },
    el('button', { type: 'button', class: 'on', onclick: () => mode(false) }, 'Write'),
    el('button', { type: 'button', onclick: () => mode(true) }, 'Read'));
  const course = courses.find((c) => c.id === note.courseId) || { id: note.courseId, name: note.courseName };
  root.replaceChildren(el('div', 'nb nb-open',
    el('div', 'nb-top',
      el('button', { type: 'button', class: 'crs-back', onclick: () => go(courseId, null) }, ico('chevl', 12), 'All notes'),
      el('span', { class: 'nb-course muted', 'data-no-i18n': '' }, course.name || ''),
      el('span', { style: { flex: '1' } }),
      saved, seg,
      el('button', { type: 'button', class: 'btn', title: 'Quiz me on this note', onclick: () => dispatchEvent(new CustomEvent('eden:course-chat', { detail: { course, prompt: `Quiz me on these notes of mine, one question at a time, checking against the course materials where you can:\n\n${body.value.slice(0, 6000)}` } })) }, ico('spark', 13), 'Quiz me on it'),
      el('button', { type: 'button', class: 'crs-icon-btn', 'aria-label': 'Delete this note', title: 'Delete', onclick: () => { if (confirm(`Delete “${note.title}”?`)) { drop(note); go(courseId, null); } } }, ico('trash', 14))),
    title, body, preview));
  if (!note.body) body.focus(); else mode(true); // a note with something in it opens to read; tap Write to edit
}
