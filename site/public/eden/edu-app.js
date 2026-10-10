// Eden for Education as its own app (askeden.com/edu; edu.askeden.com forwards here), in Eden's
// own frame (edu.html: app.css's glass sidebar, title bar, messages and composer). The same Eden
// account and the same courses (courses.js; server JARVIS V1 site/src/edu/course.js). Places, by
// the address's hash:
//
//   #/                     the courses home (join a class, create a course, my courses)
//   #/create               a new course
//   #/course/<id>[/<tab>]  a course (study, materials, rules, insights)
//   #/chat/<id>            a study chat in one course: answers from its materials, each quote checked
//
// Study chats are kept in this browser (localStorage, edu:chats:v1) and in the course on askeden.com
// (…/chats, only the student's own), so they follow a student between their phone and laptop.
// The study companion (study.js) opens on the right: flashcards, learn, test, match, and the sources.
// The notebook (notebook.js) opens there too, beside whatever you're reading (one panel at a time).
// Turns go to /api/chat/send with `course` and `temporary` (Eden's memory stays out of them).

import './i18n.js'; // first: the page's language (French loads its strings) before any module draws
import { t, locale, replyLanguageNote } from './i18n.js';
import { el, ico, toast } from './util.js';
import { api, getJSON, postJSON } from './api.js';
import { renderMarkdown } from './markdown.js';
import { coursesPanel, groundingStrip, stripSources } from './courses.js';
import { openTutor } from './tutor.js';
import { allowanceLine, offerOwnAllowance } from './edu-budget.js'; // who pays for students' AI (ROADMAP L9)
import { notebookView, clipMenu, syncNotes } from './notebook.js';
import { maybeTour, startTour } from './edu-tour.js';
import { openCompanion, closeCompanion, companionOpen, companionCourse, studyIntent, studyFromChat, openSet } from './study.js';
import { announce } from './edu-a11y.js';

const KEY = 'edu:chats:v1';
const MAX_CHATS = 200;
const $ = (id) => document.getElementById(id);
const view = $('eduView');
let live = null; // { chat, ctrl } while a reply streams
let courses = []; // the sidebar's list (GET /api/chat/courses)
let here = { view: 'home' };

/* ---------- appearance: Eden's setting, or this app's own choice ---------- */

// No choice: follow the system (app.css only has [data-theme="dark"] colours, no media query of its own).
const darkMQ = matchMedia('(prefers-color-scheme: dark)');
function theme() {
  let t = null;
  try { t = localStorage.getItem('edu:theme') || (JSON.parse(localStorage.getItem('jchat:settings') || '{}') || {}).theme; } catch { /* system */ }
  const dark = t === 'light' || t === 'dark' ? t === 'dark' : darkMQ.matches;
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  $('eduTheme').firstElementChild.firstElementChild.setAttribute('href', dark ? '#i-sun' : '#i-moon');
}
$('eduTheme').addEventListener('click', () => {
  const dark = document.documentElement.dataset.theme === 'dark';
  try { localStorage.setItem('edu:theme', dark ? 'light' : 'dark'); } catch { /* this visit only */ }
  document.documentElement.dataset.theme = dark ? 'light' : 'dark';
  theme();
});
darkMQ.addEventListener('change', theme);
theme();

/* ---------- the sidebar on a phone: a sheet over the page ---------- */

const closeSide = () => {
  const had = $('sidebar').contains(document.activeElement);
  document.body.classList.remove('edu-side-open'); $('eduScrim').hidden = true; $('sidebar').classList.remove('expanded');
  sideInert();
  if (had && phone()) $('eduMenu').focus({ preventScroll: true }); // a screen reader's focus doesn't stay in a sheet that's gone
};
// on a phone the sidebar is a sheet off screen: out of reach of Tab and screen readers until it opens (Q9)
function sideInert() {
  const off = phone() && !document.body.classList.contains('edu-side-open');
  $('sidebar').inert = off;
  if (phone()) $('eduMenu').setAttribute('aria-expanded', String(!off));
}
// on a computer the title bar's button (or ⌘B) folds the sidebar away, as Eden's does, and it stays as left
const phone = () => matchMedia('(max-width: 760px)').matches;
function setSide(open) {
  $('sidebar').classList.toggle('closed', !open);
  $('eduMenu').setAttribute('aria-expanded', String(open));
  $('eduMenu').setAttribute('aria-label', open ? 'Hide the sidebar' : 'Show the sidebar');
  $('eduMenu').title = `${open ? 'Hide' : 'Show'} the sidebar (⌘B)`;
  try { localStorage.setItem('edu:side', open ? 'open' : 'closed'); } catch { /* this visit only */ }
}
const rail = () => matchMedia('(max-width: 1100px)').matches; // Eden's icon rail (app.css): the button opens it full, over the page
const toggleSide = () => {
  if (phone()) {
    if (document.body.classList.contains('edu-side-open')) { closeSide(); return; }
    document.body.classList.add('edu-side-open'); $('eduScrim').hidden = false; sideInert();
    const first = $('sidebar').querySelector('.sitem'); if (first) first.focus({ preventScroll: true });
    return;
  }
  if (rail()) { $('sidebar').classList.toggle('expanded'); return; }
  setSide($('sidebar').classList.contains('closed'));
};
addEventListener('click', (e) => { if (rail() && !phone() && $('sidebar').classList.contains('expanded') && !$('sidebar').contains(e.target) && !$('eduMenu').contains(e.target)) $('sidebar').classList.remove('expanded'); });
$('eduMenu').addEventListener('click', toggleSide);
addEventListener('keydown', (e) => { if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'b') { e.preventDefault(); toggleSide(); } });
try { if (localStorage.getItem('edu:side') === 'closed' && !phone()) setSide(false); } catch { /* open */ }
$('eduScrim').addEventListener('click', closeSide);
matchMedia('(max-width: 760px)').addEventListener('change', sideInert);
// "Skip to the page": the address is the app's route, so the link moves focus instead of following its #
document.querySelector('.edu-skip')?.addEventListener('click', (e) => { e.preventDefault(); view.focus(); });
sideInert();
addEventListener('keydown', (e) => { if (e.key === 'Escape') closeSide(); });

/* ---------- chats, kept in this browser ---------- */

function loadChats() {
  try { const v = JSON.parse(localStorage.getItem(KEY) || '[]'); return Array.isArray(v) ? v : []; } catch { return []; }
}
function saveChats(chats) {
  try { localStorage.setItem(KEY, JSON.stringify(chats.sort((a, b) => b.updated - a.updated).slice(0, MAX_CHATS))); }
  catch { toast('This browser’s storage is full: older study chats weren’t saved.'); }
}
const chatById = (id) => loadChats().find((c) => c.id === id) || null;
function putChat(chat, { upload = true } = {}) {
  saveChats([...loadChats().filter((c) => c.id !== chat.id), chat]);
  if (upload && chat.messages.length && !chat.messages.some((m) => m.streaming)) {
    postJSON(`/api/chat/courses/${chat.course.id}/chats`, { id: chat.id, title: chat.title, updated: chat.updated, messages: chat.messages }).catch(() => {}); // best effort: the browser keeps it either way
  }
}

/** Chats made on another device: each course's list from askeden.com, newer ones fetched into this browser. */
async function syncChats() {
  let changed = false;
  // every course at once, and each course's newer chats at once (one after another took seconds)
  await Promise.all(courses.map(async (course) => {
    let remote = [];
    try { remote = (await getJSON(`/api/chat/courses/${course.id}/chats`)).chats; } catch { return; }
    const local = new Map(loadChats().map((c) => [c.id, c]));
    await Promise.all(remote.filter((r) => { const have = local.get(r.id); return !have || have.updated < r.updated; }).map(async (r) => {
      try {
        const full = await getJSON(`/api/chat/courses/${course.id}/chats/${r.id}`);
        putChat({ id: full.id, title: full.title, updated: full.updated, messages: full.messages, course: { id: course.id, name: course.name, verified: course.verified || null } }, { upload: false });
        changed = true;
      } catch { /* next time */ }
    }));
  }));
  if (changed) side();
}
const newId = () => `s${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
const tr = t; // when()'s own `t` is a time
const when = (t) => {
  const d = Math.round((Date.now() - t) / 864e5);
  return d <= 0 ? new Date(t).toLocaleTimeString(locale(), { hour: 'numeric', minute: '2-digit' }) : d === 1 ? tr('Yesterday') : new Date(t).toLocaleDateString(locale());
};

/* ---------- the sidebar ---------- */

const HUES = [212, 152, 268, 24, 340, 190, 40, 120];
const hueOf = (id) => HUES[[...String(id)].reduce((n, ch) => (n * 31 + ch.charCodeAt(0)) >>> 0, 7) % HUES.length];
const initials = (name) => { const w = String(name).match(/[\p{L}\p{N}]+/gu) || ['?']; return /^\p{L}{2,4}$/u.test(w[0]) ? w[0].toUpperCase().slice(0, 3) : w.slice(0, 2).map((x) => x[0].toUpperCase()).join(''); };

async function loadCourses() {
  try { courses = (await getJSON('/api/chat/courses')).courses; } catch { courses = []; }
  try { localStorage.setItem('edu:courses', JSON.stringify(courses)); } catch { /* this visit only */ }
  side();
  syncChats();
  syncNotes(courses).then((changed) => { if (changed && notebookOpen() && !nbAt.noteId) paintNotebook(); });
}
// the sidebar's courses from the last visit, at once, while the fresh list loads
try { courses = JSON.parse(localStorage.getItem('edu:courses') || '[]') || []; } catch { courses = []; }

/** The course a page is about (a course page, a study chat), with the role from the list. */
function contextCourse() {
  let id = null, base = null;
  if (here.view === 'course' || here.view === 'quiz') id = here.id || (here.course && here.course.id);
  if (here.view === 'chat') { const c = chatById(here.id); if (c) { id = c.course.id; base = c.course; } }
  if (!id) return null;
  const listed = courses.find((c) => c.id === id);
  return { ...(base || {}), ...(listed || {}), id, name: (listed && listed.name) || (base && base.name) || here.name || 'Course' };
}

// the study companion: the title bar's button, Flashcards and games, a source under an answer
const studyBtn = () => el('button', { type: 'button', 'data-act': 'study', class: `iconbtn${companionOpen() ? ' on' : ''}`, 'aria-pressed': String(companionOpen()), title: 'Study companion: flashcards, learn, test, match', 'aria-label': 'Study companion', onclick: () => {
  const c = contextCourse();
  if (companionOpen()) closeCompanion(); else if (c) { closeNotebook(); openCompanion(c); } else toast('Open a course first');
  refreshActs();
} }, ico('list'));
const notebookBtn = () => el('button', { type: 'button', class: `iconbtn${notebookOpen() ? ' on' : ''}`, 'aria-pressed': String(notebookOpen()), title: 'Notebook', 'aria-label': 'Notebook', onclick: () => toggleNotebook() }, ico('doc'));

/* ---------- the notebook, in the panel on the right ---------- */

let nbAt = { filter: null, noteId: null, noteCourse: null };
const notebookOpen = () => document.body.classList.contains('notebook-open');
function openNotebook({ filter, noteId = null, noteCourse = null } = {}) {
  if (companionOpen()) closeCompanion();
  const c = contextCourse();
  nbAt = { filter: filter !== undefined ? filter : (c ? c.id : null), noteId, noteCourse: noteCourse || filter || null };
  document.body.classList.add('notebook-open');
  $('notebookPane').setAttribute('aria-hidden', 'false');
  $('notebookPane').inert = false;
  paintNotebook();
  side();
  refreshActs();
}
function closeNotebook() {
  if (!notebookOpen()) return;
  document.body.classList.remove('notebook-open');
  $('notebookPane').setAttribute('aria-hidden', 'true');
  $('notebookPane').inert = true;
  side();
  refreshActs();
}
const toggleNotebook = () => (notebookOpen() ? closeNotebook() : openNotebook());
function paintNotebook() {
  const pane = $('notebookPane');
  const c = courses.find((x) => x.id === (nbAt.noteId ? nbAt.noteCourse : nbAt.filter));
  const body = el('div', 'nb-pane-body');
  pane.replaceChildren(
    el('div', 'stu-head',
      el('div', 'stu-title', el('b', '', 'Notebook'), el('span', 'muted', c ? c.name : 'All courses')),
      el('button', { type: 'button', class: 'iconbtn', 'aria-label': 'Close the notebook', title: 'Close', onclick: closeNotebook }, ico('x'))),
    body);
  notebookView(body, {
    courses, courseId: nbAt.noteId ? nbAt.noteCourse : nbAt.filter, noteId: nbAt.noteId,
    go: (filter, noteId, noteCourse) => { nbAt = { filter: noteId ? nbAt.filter : filter, noteId, noteCourse: noteCourse || filter }; paintNotebook(); body.scrollTop = 0; },
  });
}
addEventListener('eden:notebook-open', (e) => { const { courseId, noteId } = e.detail || {}; openNotebook({ filter: courseId || null, noteId: noteId || null, noteCourse: courseId || null }); });
addEventListener('eden:notes-changed', () => { if (notebookOpen() && !nbAt.noteId) paintNotebook(); });
addEventListener('eden:companion-opened', closeNotebook);
let actsExtra = [];
const tutorBtn = () => el('button', { type: 'button', class: 'iconbtn', title: 'Talk it through with Eden, your tutor', 'aria-label': 'Talk with Eden', onclick: () => { const c = contextCourse(); if (c) tutor(c); } }, el('span', 'tut-mini'));
function refreshActs() { $('eduActs').replaceChildren(...actsExtra, ...(contextCourse() ? [tutorBtn(), studyBtn()] : []), notebookBtn()); }

/** J.A.R.V.I.S. out loud: in this study chat when there is one, else a new one marked as a tutor conversation. */
function tutor(course, chat = null) {
  if (!chat) {
    chat = here.view === 'chat' ? chatById(here.id) : null;
    if (!chat || chat.course.id !== course.id) {
      chat = { id: newId(), course: { id: course.id, name: course.name, verified: course.verified || null }, title: `${t('Talk with Eden')} · ${new Date().toLocaleDateString(locale(), { month: 'short', day: 'numeric' })}`, updated: Date.now(), messages: [] };
    }
  }
  openTutor(course, { chat, save: (c) => { putChat(c); side(); if (here.view === 'chat' && here.id === c.id) route(); } });
}
addEventListener('eden:tutor', (e) => { e.preventDefault(); const c = contextCourse() || (e.detail && e.detail.course); if (c) tutor({ ...(e.detail && e.detail.course), ...c }); });
addEventListener('eden:study-companion', (e) => {
  e.preventDefault();
  const c = contextCourse() || e.detail.course;
  closeNotebook();
  openCompanion({ ...e.detail.course, ...c }, e.detail.tab ? { tab: e.detail.tab } : {});
  refreshActs();
});
addEventListener('eden:clip', (e) => { // the companion's "Clip this page"
  const { course, title, body, anchor } = e.detail || {};
  const c = courses.find((x) => x.id === (course && course.id)) || course;
  if (c && anchor) clipMenu(anchor, c, { title, body });
});
addEventListener('eden:study-source', (e) => {
  const { course, doc, loc, quote } = e.detail || {};
  const c = (contextCourse() && contextCourse().id === course && contextCourse()) || courses.find((x) => x.id === course) || (companionCourse() && companionCourse().id === course && companionCourse());
  if (!c) return;
  closeNotebook();
  openCompanion(c, { tab: 'source', source: { doc, loc, quote } });
  refreshActs();
});

function side() {
  const item = (on, href, icon, label, sub, own = false) => el('a', { class: `sitem${on ? ' active' : ''}`, href, 'aria-current': on ? 'page' : null, onclick: closeSide },
    icon, el('span', { class: 'lbl', 'data-no-i18n': own ? '' : null }, label, sub ? el('span', 'sub', sub) : null)); // own: a course's or chat's name (its sub is already in the page's language)
  const nbItem = el('button', { type: 'button', id: 'nbSideItem', class: `sitem${notebookOpen() ? ' active' : ''}`, 'aria-pressed': String(notebookOpen()), onclick: () => { closeSide(); toggleNotebook(); } },
    ico('doc'), el('span', 'lbl', 'Notebook'));
  const sec = (title, kids) => el('div', 'sec', el('div', 'sec-h', el('span', 'txt', title)), el('div', 'edu-sec-items', ...kids));
  const tile = (c) => el('span', { class: 'edu-mini', style: { '--h': hueOf(c.id) }, 'aria-hidden': 'true' }, initials(c.name));
  const courseOn = (id) => (here.view === 'course' || here.view === 'quiz') && (here.id === id || (here.course && here.course.id === id));
  const chats = loadChats().slice(0, 12);
  $('eduSide').replaceChildren(
    sec('Eden for Education', [
      item(here.view === 'home', '#/', ico('list'), 'Home'),
      nbItem,
      item(here.view === 'create', '#/create', ico('plus'), 'Create a course'),
    ]),
    sec('My courses', courses.length
      ? courses.map((c) => item(courseOn(c.id), `#/course/${c.id}`, tile(c), c.name, c.role === 'owner' ? t('You teach this') : c.term || t('Student'), true))
      : [el('div', 'side-empty', 'Join a class or create a course to see it here.')]),
    sec('Study chats', chats.length
      ? chats.map((c) => item(here.view === 'chat' && here.id === c.id, `#/chat/${c.id}`, ico('chat'), c.title, `${c.course.name} · ${when(c.updated)}`, true))
      : [el('div', 'side-empty', 'Your study chats show here.')]),
  );
}

/* ---------- the title bar ---------- */

function bar(title, { badge = null, acts = [], own = false } = {}) {
  $('eduTitle').replaceChildren(own ? el('span', { 'data-no-i18n': '' }, title) : title); // own: a course's name, never translated
  $('eduBadge').hidden = !badge;
  $('eduBadge').replaceChildren(...(badge ? [ico('check', 11), badge] : []));
  actsExtra = acts;
  refreshActs();
  const was = document.title;
  document.title = title === 'Eden for Education' ? title : `${own ? title : t(title)} · Eden for Education`;
  if (was !== document.title && booted) announce(title); // a screen reader hears where it is after moving (Q9)
}
let booted = false;
setTimeout(() => { booted = true; }, 1500);

/* ---------- routing ---------- */

let quiet = false; // a hash we wrote ourselves (courses.js moved on its own): don't render again
function route() {
  if (quiet) { quiet = false; return; }
  const h = location.hash;
  const chat = /^#\/chat\/([\w-]+)/.exec(h);
  const course = /^#\/course\/([A-Za-z0-9_-]{22})(?:\/(\w+))?/.exec(h);
  if (chat) {
    const c = chatById(chat[1]);
    if (c) return chatView(c);
    history.replaceState(null, '', '#/');
  }
  // the notebook's old addresses (links, bookmarks): the panel opens over the courses home
  const nb = /^#\/notebook(?:\/([A-Za-z0-9_-]{22})\/([\w-]+))?/.exec(h);
  if (nb) { history.replaceState(null, '', '#/'); openNotebook({ filter: nb[1] || null, noteId: nb[2] || null, noteCourse: nb[1] || null }); return coursesView({ view: 'home' }); }
  if (course) return coursesView({ view: 'course', id: course[1], tab: course[2] });
  if (h === '#/create') return coursesView({ view: 'create' });
  coursesView({ view: 'home' });
}
addEventListener('hashchange', route);

// courses.js says where it went (a card, a tab, Back): the address, the sidebar and the title follow
addEventListener('eden:courses-where', (e) => {
  const to = e.detail || {};
  here = to;
  const hash = to.view === 'course' ? `#/course/${to.id}${to.tab ? `/${to.tab}` : ''}` : to.view === 'create' ? '#/create' : to.view === 'quiz' ? location.hash : '#/';
  if (hash !== location.hash) { quiet = true; location.hash = hash; }
  if (to.view === 'course') {
    const c = courses.find((x) => x.id === to.id);
    bar(to.name || (c && c.name) || t('Course'), { own: !!(to.name || (c && c.name)), badge: to.verified || (c && c.verified) ? 'Verified' : null });
    if (to.name && !c) loadCourses(); // joined or made just now
  } else if (to.view === 'quiz') bar('Practice quiz');
  else if (to.view === 'create') bar('Create a course');
  else bar('Eden for Education');
  side();
});

// courses.js: Study, the tiles, Review with Eden… open a study chat here
let pendingPrompt = '';
addEventListener('eden:course-chat', (e) => {
  const { course, prompt, focus } = e.detail || {};
  if (!course) return;
  const chat = { id: newId(), course, title: prompt ? prompt.slice(0, 60) : t(`Studying ${course.name}`), updated: Date.now(), messages: [] };
  if (focus && focus.doc && focus.loc) chat.focus = { doc: String(focus.doc), loc: String(focus.loc) }; // "Explain this slide": answers start from that page (Q8)
  putChat(chat);
  pendingPrompt = prompt || '';
  location.hash = `#/chat/${chat.id}`;
});


function coursesView(to) {
  document.body.classList.remove('edu-in-chat');
  view.replaceChildren();
  view.scrollTop = 0;
  coursesPanel(view, to);
}

/* ---------- a study chat, in Eden's own message and composer styles ---------- */

const SEND_SVG = '<svg width="15" height="15" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M8 2.5l5 5-1.1 1.1L8.8 5.5V13.5H7.2V5.5L4.1 8.6 3 7.5z"/></svg>';
const STOP_SVG = '<svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor" aria-hidden="true"><rect x="1.5" y="1.5" width="9" height="9" rx="2"/></svg>';

function chatView(chat) {
  here = { view: 'chat', id: chat.id };
  document.body.classList.add('edu-in-chat');
  bar(chat.course.name, {
    own: true,
    badge: chat.course.verified ? 'Verified' : null,
    acts: [
      el('a', { class: 'iconbtn', href: `#/course/${chat.course.id}/study`, title: 'Course', 'aria-label': 'Open the course' }, ico('doc')),
      el('button', { type: 'button', class: 'iconbtn', title: 'New study chat', 'aria-label': 'New study chat', onclick: () => dispatchEvent(new CustomEvent('eden:course-chat', { detail: { course: chat.course } })) }, ico('edit')),
      el('button', { type: 'button', class: 'iconbtn', title: 'Delete this chat', 'aria-label': 'Delete this chat', onclick: () => {
        if (!confirm('Delete this study chat from this browser?')) return;
        saveChats(loadChats().filter((c) => c.id !== chat.id));
        postJSON(`/api/chat/courses/${chat.course.id}/chats/${chat.id}/delete`, {}).catch(() => {});
        location.hash = `#/course/${chat.course.id}/study`;
      } }, ico('trash')),
    ],
  });
  side();

  const transcript = el('div', { class: 'edu-transcript', role: 'log', 'aria-live': 'polite', 'aria-label': 'Study chat' });
  const scroll = el('div', { class: 'edu-scroll', tabindex: '-1' }, transcript);
  const input = el('textarea', { rows: '1', placeholder: `Ask about ${chat.course.name}…`, 'aria-label': `Ask about ${chat.course.name}` });
  const sendBtn = el('button', { type: 'submit', class: 'jc-send', 'aria-label': 'Send' });
  sendBtn.innerHTML = SEND_SVG; // constant markup
  const form = el('form', { class: 'jc-composer', autocomplete: 'off', onsubmit: (e) => { e.preventDefault(); if (live) live.ctrl.abort(); else send(chat, input.value, ui); } },
    el('div', 'jc-composer-top', input, el('button', { type: 'button', class: 'edu-talk', title: 'Talk it through with Eden', 'aria-label': 'Talk with Eden', onclick: () => tutor(contextCourse() || chat.course, chat) }, el('span', 'tut-mini')), sendBtn));
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); form.requestSubmit(); } });
  input.addEventListener('input', () => { input.style.height = 'auto'; input.style.height = `${Math.min(input.scrollHeight, 220)}px`; });
  const ui = { transcript, scroll, input, sendBtn, left: allowanceLine(chat.course.id) };

  view.replaceChildren(el('div', 'edu-chat', scroll,
    el('div', 'jc jc-dock', el('div', 'jc-column', form, el('p', 'edu-fine', 'Answers come from your course materials, with the slide or page. Anything else is labeled.'), ui.left))));
  paint(chat, ui);
  if (pendingPrompt) { const p = pendingPrompt; pendingPrompt = ''; send(chat, p, ui); }
  else input.focus();
}

function paint(chat, ui) {
  if (!chat.messages.length) {
    const tip = (t, d, p) => el('button', { type: 'button', onclick: () => { ui.input.value = tr(p); ui.input.focus(); } }, el('b', '', t), el('span', '', d));
    ui.transcript.replaceChildren(el('div', 'edu-empty',
      el('span', 'edu-logo lg', ''),
      el('h1', { 'data-no-i18n': '' }, `${t('Study')} ${chat.course.name}`),
      el('p', 'lead', 'Ask about anything in the course. Eden answers from your professor’s materials and shows where each answer came from.'),
      el('div', 'sugg',
        tip('Summarize the latest lecture', 'The key ideas, with sources', 'Summarize the most recent lecture in the materials, with the key ideas and sources.'),
        tip('Quiz me', 'One question at a time', 'Quiz me with one multiple-choice question at a time from the materials. Wait for my answer, then tell me if I’m right and cite the source.'),
        tip('Explain a hard idea', 'Simply, step by step', 'Pick the hardest idea in the materials and explain it simply, step by step, with sources.'),
        tip('Make a review plan', 'Before the exam', 'Make me an exam review plan from the materials: topics in order, what to review for each (with the source), and a self-test question for each.'))));
    return;
  }
  const course = contextCourse() || chat.course;
  ui.transcript.replaceChildren(...chat.messages.map((m, i) => message(m, chat.course.id, course, m.role === 'assistant' ? questionBefore(chat, i) : '')));
  showLatest(ui);
}
const questionBefore = (chat, i) => { for (let j = i - 1; j >= 0; j--) if (chat.messages[j].role === 'user') return chat.messages[j].text; return ''; };

/** The newest question at the top of the view, its answer below it: a long answer is read from its
 * start, scrolling down, instead of the view jumping to its end. */
function showLatest(ui) {
  const users = ui.transcript.querySelectorAll('.msg.user');
  const q = users[users.length - 1];
  if (!q) return;
  const top = q.getBoundingClientRect().top - ui.scroll.getBoundingClientRect().top + ui.scroll.scrollTop - 12;
  ui.scroll.scrollTop = Math.max(0, top);
}

/** What a clipped answer becomes in the notebook: the answer, then its checked sources. */
function clipOf(m, question) {
  const sources = (m.grounding && m.grounding.sources || []).filter((s) => s.ok && s.file);
  const seen = new Set();
  const list = sources.filter((s) => { const k = `${s.file}·${s.at}`; if (seen.has(k)) return false; seen.add(k); return true; }).map((s) => `- ${s.file} · ${s.at}`);
  const body = `${stripSources(m.text).replace(/\s*\[\d+\]/g, '')}${list.length ? `\n\n**${t('Sources')}**\n${list.join('\n')}` : ''}`;
  return { title: question ? question.slice(0, 90) : t('Clipped answer'), body };
}

function message(m, courseId = null, course = null, question = '') {
  if (m.kind === 'set') { // flashcards asked for in the chat: made in the companion, a card here to open them again
    const names = { cards: 'Flashcards', learn: 'Learn', test: 'Practice test', match: 'Match' };
    const body = m.streaming
      ? [el('div', 'edu-set-txt', el('b', '', m.text || 'Making a study set…'), el('span', 'muted', 'Opening in the study companion'))]
      : m.error ? [el('div', { class: 'errbox', role: 'alert' }, ico('x'), el('span', '', m.error))]
        : [el('div', 'edu-set-txt', el('b', { 'data-no-i18n': '' }, m.set.title), el('span', 'muted', `${m.set.count} flashcards · each checked against its source`)),
          el('button', { type: 'button', class: 'btn primary', onclick: () => course && openSet(course, m.set.id, m.set.tab) }, `Open ${names[m.set.tab] || 'flashcards'}`)];
    return el('div', 'msg assistant', el('div', 'bubble edu-set', el('span', 'edu-set-ic', ico('list', 18)), ...body));
  }
  if (m.role === 'user') return el('div', 'msg user', el('div', 'bubble', el('span', { class: 'utext', 'data-no-i18n': '' }, m.text)));
  const bubble = el('div', 'bubble');
  const shown = stripSources(m.text || '');
  if (shown) { const md = el('div', 'md'); md.append(renderMarkdown(shown, { untrusted: true })); bubble.append(md); } // answers read course files: images held, link destinations shown (H8)
  if (m.streaming && !shown) bubble.append(el('div', { class: 'typing', 'aria-label': 'Working' }, el('i'), el('i'), el('i')));
  if (m.grounding && !m.streaming) bubble.append(groundingStrip(m.grounding, courseId));
  if (m.error) bubble.append(el('div', { class: 'errbox', role: 'alert' }, ico('x'), el('span', '', m.error)));
  const out = el('div', 'msg assistant', bubble);
  if (!m.streaming && shown && course) {
    const clipBtn = el('button', { type: 'button', class: 'edu-clip', title: 'Clip this answer to your notebook', onclick: () => clipMenu(clipBtn, course, clipOf(m, question)) }, ico('pin', 12), 'Clip to notebook');
    out.append(el('div', 'edu-acts', clipBtn, m.meta ? el('span', 'edu-meta', m.meta) : null));
  } else if (m.meta && !m.streaming) out.append(el('div', 'edu-meta', m.meta));
  return out;
}

async function send(chat, text, ui) {
  text = String(text || '').trim();
  if (!text || live) return;
  const history = chat.messages.filter((m) => !m.error && !m.kind && (m.text || '').trim()).map((m) => ({ role: m.role, content: m.role === 'assistant' ? stripSources(m.text) : m.text }));
  // "make flashcards", "quiz me", "match game"…: a checked study set, opened in the companion, not a wall of text
  const want = studyIntent(text);
  if (want) return studySet(chat, text, want, ui);
  chat.messages.push({ role: 'user', text });
  if (chat.messages.length === 1) chat.title = text.slice(0, 60);
  const reply = { role: 'assistant', text: '', streaming: true };
  chat.messages.push(reply);
  chat.updated = Date.now();
  putChat(chat);
  side();
  ui.input.value = '';
  ui.input.style.height = 'auto';
  const ctrl = new AbortController();
  live = { chat, ctrl };
  ui.transcript.setAttribute('aria-busy', 'true'); // a screen reader reads the answer once, when it's done, not each streamed word
  ui.sendBtn.innerHTML = STOP_SVG;
  ui.sendBtn.setAttribute('aria-label', 'Stop');
  paint(chat, ui);
  // just enough room under the new question for it to reach the top while its answer is still short
  const users = ui.transcript.querySelectorAll('.msg.user');
  const q = users[users.length - 1];
  if (q) ui.transcript.style.minHeight = `${q.getBoundingClientRect().top - ui.transcript.getBoundingClientRect().top + ui.scroll.clientHeight - 24}px`;
  showLatest(ui);
  let last = ui.transcript.lastElementChild;
  let frame = 0;
  const repaint = () => {
    if (frame) return;
    frame = requestAnimationFrame(() => { frame = 0; const n = message(reply, chat.course.id); last.replaceWith(n); last = n; }); // the view stays where the reader is
  };
  let route = null, usage = null, owe = false;
  try {
    await api.send({ messages: [...history, { role: 'user', content: text }], course: chat.course.id, ...(chat.focus ? { focus: chat.focus } : {}), ...(replyLanguageNote() ? { system: replyLanguageNote() } : {}), temporary: true, mode: 'chat' }, {
      signal: ctrl.signal,
      onEvent: (type, d) => {
        if (type === 'text') { reply.text += d.text || ''; repaint(); }
        else if (type === 'grounding') reply.grounding = d;
        else if (type === 'route') route = d;
        else if (type === 'usage') usage = d;
        else if (type === 'error') reply.error = d.message || 'That didn’t work.';
      },
    });
  } catch (e) {
    if (e.name !== 'AbortError') reply.error = e.message || 'Couldn’t reach askeden.com.';
    if (e.status === 402) owe = true; // the free study AI (or the course budget) ran out: ask about their own, below
  }
  if (frame) cancelAnimationFrame(frame);
  reply.streaming = false;
  if (ctrl.signal.aborted && !reply.error) reply.meta = 'Stopped.';
  else if (route || usage) reply.meta = [route && (route.name || route.model), usage && typeof usage.costUSD === 'number' ? (usage.costUSD < 0.001 ? '<$0.001' : `$${usage.costUSD.toFixed(3)}`) : null].filter(Boolean).join(' · ');
  chat.updated = Date.now();
  putChat(chat);
  live = null;
  ui.transcript.setAttribute('aria-busy', 'false');
  ui.sendBtn.innerHTML = SEND_SVG;
  ui.sendBtn.setAttribute('aria-label', 'Send');
  const n = message(reply, chat.course.id, contextCourse() || chat.course, text);
  last.replaceWith(n);
  if (ui.left) ui.left.refresh();
  if (owe) { // a clear choice, never automatic: their own Eden allowance for this course, this tab only
    if (await offerOwnAllowance(chat.course, reply.error)) {
      chat.messages.splice(-2);
      putChat(chat);
      paint(chat, ui);
      return send(chat, text, ui);
    }
  }
  ui.input.focus({ preventScroll: true });
}

async function studySet(chat, text, want, ui) {
  // "about it": the topic is the last thing asked in this chat
  const prev = [...chat.messages].reverse().find((m) => m.role === 'user' && !studyIntent(m.text));
  const topic = want.topic || (prev ? prev.text.slice(0, 200) : '');
  chat.messages.push({ role: 'user', text });
  if (chat.messages.length === 1) chat.title = text.slice(0, 60);
  const reply = { role: 'assistant', kind: 'set', text: `Making flashcards${topic ? ` on “${topic.slice(0, 60)}”` : ''}…`, streaming: true };
  chat.messages.push(reply);
  ui.input.value = '';
  live = { chat, ctrl: new AbortController() };
  paint(chat, ui);
  const course = contextCourse() || chat.course;
  try {
    const made = await studyFromChat(course, topic, want.tab);
    reply.set = { ...made, tab: want.tab };
    refreshActs();
  } catch (e) { reply.error = e.message || 'Couldn’t make the set.'; }
  reply.streaming = false;
  delete reply.text;
  chat.updated = Date.now();
  putChat(chat);
  live = null;
  paint(chat, ui);
  side();
  ui.input.focus();
}

route();
loadCourses().then(() => maybeTour('home'));
addEventListener('eden:courses-where', (e) => { if (e.detail && e.detail.view === 'course') setTimeout(() => maybeTour('course'), 600); });
$('eduTour').addEventListener('click', () => { closeSide(); if (here.view !== 'home') location.hash = '#/'; setTimeout(() => startTour('home'), here.view === 'home' ? 0 : 500); }); // the sidebar's "Take the tour"
