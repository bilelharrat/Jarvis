// Eden for Education (askeden ROADMAP L1–L7; server: JARVIS V1 site/src/edu/course.js), at
// askeden.com only. The Courses panel, a large sheet (panels.js adds .crsp):
//
//   home     two doors (I'm a student: join with a code · I teach: create a course), my courses as
//            cards, and how it works
//   create   a new course, with a live preview of what students will see
//   course   a header (name, Verified, term, join code) and tabs: Study (ask, quiz, flashcards,
//            review plan), Materials (drop files: their text is read in this browser by
//            course-extract.js), Rules and Insights (the professor's)
//   quiz     five checked questions, one at a time
//
// "Study" opens a chat in the course: its turns carry `course`, the server answers from the
// materials, and each reply's quotes come back checked (the `grounding` event, shown by
// groundingStrip() under the reply).

import { el, ico, toast } from './util.js';
import { api, getJSON, postJSON } from './api.js';
import { extractFile, kindOf, pageImages } from './course-extract.js';

const BASE = '/api/chat/courses';
let where = { view: 'home' }; // reopening the panel goes back to the same place

const study = (course, prompt = '') => dispatchEvent(new CustomEvent('eden:course-chat', { detail: { course: { id: course.id, name: course.name, verified: course.verified || null }, prompt } }));
const fail = (box, e) => box.replaceChildren(el('div', 'sp-warn', el('b', '', 'That didn’t work'), e.message || String(e)));
const loading = (text = 'Loading…') => el('div', 'crs-loading', el('span', 'crs-spin'), text);

// a course's colour and initials, from its id and name
const HUES = [212, 152, 268, 24, 340, 190, 40, 120];
const hueOf = (id) => HUES[[...String(id)].reduce((n, ch) => (n * 31 + ch.charCodeAt(0)) >>> 0, 7) % HUES.length];
const initials = (name) => {
  const words = String(name).match(/[\p{L}\p{N}]+/gu) || ['?'];
  return /^\p{L}{2,4}$/u.test(words[0]) ? words[0].toUpperCase() : words.slice(0, 2).map((w) => w[0].toUpperCase()).join(''); // "BIO 201" → BIO
};
const tile = (c, size = '') => el('span', { class: `crs-tile ${size}`, style: { '--h': hueOf(c.id || c.name) }, 'aria-hidden': 'true' }, initials(c.name));

const SHIELD = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3 4 6v6c0 4.5 3.4 8.3 8 9 4.6-.7 8-4.5 8-9V6l-8-3z"/><path d="m9 12 2 2 4-4"/></svg>';
const CAP = '<svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 9.5 12 5l10 4.5-10 4.5L2 9.5z"/><path d="M6 11.5V16c0 1.5 2.7 3 6 3s6-1.5 6-3v-4.5"/><path d="M22 9.5V15"/></svg>';
const BOOK = '<svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H20v15H6.5A2.5 2.5 0 0 0 4 20.5z"/><path d="M4 20.5A2.5 2.5 0 0 0 6.5 23H20v-5"/><path d="M8 7h8M8 11h6"/></svg>';
const UPLOAD = '<svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 16V4M7 9l5-5 5 5"/><path d="M4 16v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3"/></svg>';
const svg = (html, cls = '') => { const s = el('span', cls); s.innerHTML = html; return s; }; // constant markup above only

const badge = (v, small = false) => (v ? el('span', { class: `crs-badge${small ? ' sm' : ''}`, title: `Teacher verified with a ${v} school email` }, svg(SHIELD), small ? 'Verified' : 'Verified course') : null);

/** The Courses panel, in the space panel's body (panels.js). */
export function coursesPanel(body, to = null) {
  const root = el('div', 'crs-root');
  body.append(root);
  go(root, to || where);
}

// where the screens are, for a host that shows it (edu-app.js: the sidebar and the title bar)
const announce = (detail) => dispatchEvent(new CustomEvent('eden:courses-where', { detail }));

function go(root, to) {
  where = to;
  announce(to);
  root.scrollTop = 0;
  if (to.view === 'create') createView(root);
  else if (to.view === 'course') courseView(root, to.id, to.tab);
  else if (to.view === 'quiz') quizView(root, to.course);
  else home(root);
}

const back = (root, to, label) => el('button', { type: 'button', class: 'crs-back', onclick: () => go(root, to) }, ico('chevl', 12), label);

/* ---------- home ---------- */

async function home(root) {
  root.replaceChildren(loading());
  let data;
  try { data = await getJSON(BASE); } catch (e) { fail(root, e); return; }
  const courses = data.courses;

  const code = el('input', { class: 'crs-code-in', placeholder: 'XXXX-XXXX-XXXX', 'aria-label': 'Course code', autocomplete: 'off', spellcheck: 'false', maxlength: '20' });
  const joinBtn = el('button', { type: 'submit', class: 'btn primary crs-big' }, 'Join class');
  const who = el('input', { class: 'crs-name-in', placeholder: 'Your name, as your professor knows you', 'aria-label': 'Your name for the class list', maxlength: '60', autocomplete: 'name' });
  const age = el('input', { type: 'checkbox', id: 'crsAge' });
  const join = el('form', { class: 'crs-join', onsubmit: async (e) => {
    e.preventDefault();
    if (!code.value.trim()) { code.focus(); return; }
    if (!age.checked) { toast('Confirm you’re 13 or older to join.'); age.focus(); return; }
    joinBtn.disabled = true;
    try { const c = await postJSON(`${BASE}/join`, { code: code.value, label: who.value.trim(), age13: true }); toast(`You joined ${c.name}`); go(root, { view: 'course', id: c.id, tab: 'study' }); }
    catch (err) { toast(err.message); joinBtn.disabled = false; }
  } }, el('div', 'crs-join-row', code, joinBtn), who,
  el('label', { class: 'crs-age', for: 'crsAge' }, age, el('span', '', 'I’m 13 or older, and I’ve read the ', el('a', { href: '/edu/privacy', target: '_blank', rel: 'noopener' }, 'student privacy notice'), '.')));

  const doors = el('div', 'crs-doors',
    el('section', 'crs-door student',
      svg(CAP, 'crs-door-ic'), el('h3', '', 'I’m a student'),
      el('p', '', 'Join with the code from your professor. Study from your class’s own slides and readings.'), join),
    el('section', 'crs-door teacher',
      svg(BOOK, 'crs-door-ic'), el('h3', '', 'I teach'),
      el('p', '', 'Turn your syllabus, slides and readings into a study assistant your students can trust.'),
      el('button', { type: 'button', class: 'btn primary crs-big', onclick: () => go(root, { view: 'create' }) }, ico('plus', 13), 'Create a course')));

  const out = [
    el('header', 'crs-hero',
      el('div', 'crs-eyebrow', 'Eden for Education'),
      el('h2', '', 'Study from your class’s own materials.'),
      el('p', '', 'Every answer points to the page or slide it came from, and Eden checks the quote is really there.')),
  ];
  if (courses.length) {
    out.push(el('div', 'crs-sec-h', el('h4', '', 'My courses'), el('span', 'muted', `${courses.length}`)),
      el('div', 'crs-grid', ...courses.map((c) => courseCard(root, c))));
  }
  out.push(doors);
  if (!courses.length) {
    const step = (n, t, d) => el('div', 'crs-step', el('span', 'crs-step-n', String(n)), el('b', '', t), el('span', 'muted', d));
    out.push(el('div', 'crs-sec-h', el('h4', '', 'How it works')),
      el('div', 'crs-steps',
        step(1, 'Professor adds materials', 'PDF, PowerPoint, Word or text. Eden reads them page by page.'),
        step(2, 'Students join with a code', 'One code for the class. No setup for students.'),
        step(3, 'Answers come with sources', 'Each one cites the slide or page, checked word for word.')));
  }
  root.replaceChildren(...out);
}

function courseCard(root, c) {
  const owner = c.role === 'owner';
  return el('button', { type: 'button', class: 'crs-card', style: { '--h': hueOf(c.id) }, onclick: () => go(root, { view: 'course', id: c.id, tab: owner ? 'materials' : 'study' }) },
    el('span', 'crs-card-band'),
    el('span', 'crs-card-body',
      el('span', 'crs-card-top', tile(c), badge(c.verified, true)),
      el('b', 'crs-card-name', c.name),
      el('span', 'muted', [c.term, `${c.docs} file${c.docs === 1 ? '' : 's'}`].filter(Boolean).join(' · ')),
      el('span', { class: `crs-role ${owner ? 'teach' : ''}` }, owner ? 'You teach this' : 'Student')));
}

/* ---------- create ---------- */

function createView(root) {
  const name = el('input', { id: 'crsName', placeholder: 'BIO 201 · Cell Biology', maxlength: '80', required: true, autocomplete: 'off' });
  const term = el('input', { id: 'crsTerm', placeholder: 'Fall 2026', maxlength: '40', autocomplete: 'off' });
  const ok = el('input', { type: 'checkbox', id: 'crsRights' });
  const create = el('button', { type: 'submit', class: 'btn primary crs-big', disabled: true }, 'Create course');
  const pName = el('b', 'crs-card-name', 'Your course name');
  const pTerm = el('span', 'muted', 'Term');
  const pTile = el('span', { class: 'crs-tile lg', style: { '--h': 212 } }, '?');
  const sync = () => {
    pName.textContent = name.value.trim() || 'Your course name';
    pTerm.textContent = term.value.trim() || 'Term';
    pTile.textContent = name.value.trim() ? initials(name.value) : '?';
    pTile.style.setProperty('--h', hueOf(name.value || 'x'));
    create.disabled = !(name.value.trim() && ok.checked);
  };
  for (const x of [name, term, ok]) x.addEventListener('input', sync);
  ok.addEventListener('change', sync);

  const form = el('form', { class: 'crs-create-form', onsubmit: async (e) => {
    e.preventDefault();
    create.disabled = true;
    try { const c = await postJSON(BASE, { name: name.value, term: term.value }); toast(`${c.name} is ready. Add your materials.`); go(root, { view: 'course', id: c.id, tab: 'materials' }); }
    catch (err) { toast(err.message); create.disabled = false; }
  } },
  el('label', { class: 'crs-field', for: 'crsName' }, 'Course name', name),
  el('label', { class: 'crs-field', for: 'crsTerm' }, 'Term (optional)', term),
  el('label', { class: 'crs-consent', for: 'crsRights' }, ok,
    el('span', '', el('b', '', 'I have the right to share these materials with my students.'),
      el('span', 'muted', 'Your own slides, notes and lesson plans, open textbooks, or readings your school licenses for this. Publisher textbooks usually can’t be uploaded. ', el('a', { href: '/edu/terms', target: '_blank', rel: 'noopener' }, 'Course materials terms')))),
  el('div', 'crs-privacy', ico('lock', 13), el('span', '', 'askeden.com reads your materials so Eden can answer from them. They’re never used to train AI models, and they’re deleted when you remove them or the course.')),
  create);

  const preview = el('aside', 'crs-preview',
    el('div', 'crs-eyebrow', 'What students will see'),
    el('div', 'crs-preview-card', pTile, el('div', 'crs-preview-txt', pName, pTerm),
      el('div', 'crs-preview-list',
        el('span', '', ico('check', 12), 'Answers from your materials, with the page or slide'),
        el('span', '', ico('check', 12), 'Practice quizzes checked against the source'),
        el('span', '', ico('check', 12), 'Explains and guides; doesn’t write graded work'))),
    el('p', 'sp-note', 'Signed in with a school email (.edu, .ac.uk and similar)? Your course gets the Verified badge.'));

  root.replaceChildren(back(root, { view: 'home' }, 'Courses'),
    el('header', 'crs-hero small', el('h2', '', 'Create a course'), el('p', '', 'Name it, then add your syllabus, slides and readings.')),
    el('div', 'crs-create', form, preview));
  name.focus();
}

/* ---------- a course ---------- */

async function courseView(root, id, tab) {
  root.replaceChildren(loading());
  let c;
  try { c = await getJSON(`${BASE}/${id}`); } catch (e) { where = { view: 'home' }; fail(root, e); return; }
  const owner = c.role === 'owner';
  const staff = owner || c.role === 'ta';
  const tabs = staff ? [['materials', 'Materials'], ['study', 'Study'], ['rules', 'Rules for Eden'], ['class', 'Class'], ['insights', 'Insights']] : [['study', 'Study'], ['materials', 'Materials']];
  if (!tabs.some(([k]) => k === tab)) tab = tabs[0][0];
  where = { view: 'course', id, tab };
  announce({ ...where, name: c.name, verified: c.verified || null });

  const meta = [c.term, c.role === 'ta' ? 'You’re a TA' : null, staff ? `${c.students} student${c.students === 1 ? '' : 's'}` : null, `${c.docs.length} file${c.docs.length === 1 ? '' : 's'}`].filter(Boolean).join(' · ');
  const head = el('header', { class: 'crs-chead', style: { '--h': hueOf(c.id) } },
    tile(c, 'lg'),
    el('div', 'crs-chead-txt', el('div', 'crs-chead-name', el('h2', '', c.name), badge(c.verified)), el('span', 'muted', meta)),
    staff ? el('div', 'crs-codebox',
      el('span', 'crs-eyebrow', 'Join code'),
      el('b', '', c.code),
      el('button', { type: 'button', class: 'btn', onclick: () => navigator.clipboard.writeText(c.code).then(() => toast('Code copied. Share it with your class.')) }, ico('copy', 12), 'Copy')) : null);

  const bar = el('div', { class: 'crs-tabs', role: 'tablist', 'aria-label': c.name },
    ...tabs.map(([k, t]) => el('button', { type: 'button', role: 'tab', class: `crs-tab${k === tab ? ' on' : ''}`, 'aria-selected': String(k === tab), onclick: () => go(root, { view: 'course', id, tab: k }) }, t)));
  const pane = el('div', { class: 'crs-pane', role: 'tabpanel' });
  const paused = c.paused ? el('div', 'crs-paused', ico('lock', 13), `Eden is paused for ${c.paused.label} until ${new Date(c.paused.until).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' })}.`) : '';
  root.replaceChildren(back(root, { view: 'home' }, 'All courses'), head, paused, bar, pane);

  if (tab === 'study') studyTab(root, pane, c);
  else if (tab === 'materials') materialsTab(root, pane, c);
  else if (tab === 'rules') rulesTab(pane, c);
  else if (tab === 'class') classTab(root, pane, c);
  else insightsTab(pane, c);
  seen(c); // what's new is marked until the next visit
}

function studyTab(root, pane, c) {
  // Eden's own input bar (app.css .jc-composer): one line that grows as you type, the round send button
  const q = el('textarea', { rows: '1', placeholder: `Ask anything about ${c.name}…`, 'aria-label': `Ask about ${c.name}` });
  const send = () => { const t = q.value.trim(); if (t) study(c, t); else study(c); };
  q.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); } });
  q.addEventListener('input', () => { q.style.height = 'auto'; q.style.height = `${Math.min(q.scrollHeight, 220)}px`; });
  const sendBtn = el('button', { type: 'submit', class: 'jc-send', 'aria-label': 'Ask' });
  sendBtn.innerHTML = '<svg width="15" height="15" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M8 2.5l5 5-1.1 1.1L8.8 5.5V13.5H7.2V5.5L4.1 8.6 3 7.5z"/></svg>'; // constant markup, as Eden's
  const talk = el('button', { type: 'button', class: 'edu-talk', title: 'Talk it through with J.A.R.V.I.S.', 'aria-label': 'Talk with J.A.R.V.I.S.', onclick: () => dispatchEvent(new CustomEvent('eden:tutor', { detail: { course: c }, cancelable: true })) }, el('span', 'tut-mini'));
  const ask = el('div', 'jc crs-askbar', el('form', { class: 'jc-composer', autocomplete: 'off', onsubmit: (e) => { e.preventDefault(); send(); } },
    el('div', 'jc-composer-top', q, talk, sendBtn)));
  const tool = (icon, t, d, run) => el('button', { type: 'button', class: 'crs-tool', onclick: run }, el('span', 'crs-tool-ic', ico(icon, 16)), el('b', '', t), el('span', 'muted', d));
  pane.replaceChildren(
    c.docs.length ? '' : el('div', 'sp-warn', el('b', '', 'No materials yet'), c.role === 'owner' ? 'Add files in Materials first; Eden answers from them.' : 'Your professor hasn’t added materials yet, so answers can’t be verified.'),
    ask,
    el('div', 'crs-note', svg(SHIELD), 'Answers cite the slide or page they come from. Anything not in the materials is labeled.'),
    el('div', 'crs-tools',
      tool('check', 'Practice quiz', 'Five questions, each checked against its source', () => go(root, { view: 'quiz', course: c })),
      tool('list', 'Flashcards and games', 'Cards, learn, test and match, from the materials', () => companion(c, 'Make 10 flashcards from the most important ideas in this course’s materials, each with the source it comes from.')),
      el('button', { type: 'button', class: 'crs-tool tutor', onclick: () => { if (dispatchEvent(new CustomEvent('eden:tutor', { detail: { course: c }, cancelable: true }))) location.href = `/edu#/course/${c.id}/study`; } },
        el('span', 'crs-tool-ic', el('span', 'tut-mini')), el('b', '', 'Talk with J.A.R.V.I.S.'), el('span', 'muted', 'Your tutor, out loud: ask, get quizzed, think it through')),
      tool('spark', 'Explain a hard topic', 'Step by step, then a question to check', () => study(c, 'What are the hardest ideas in this course’s materials? List them and ask me which one to explain step by step.')),
      tool('cal', 'Exam review plan', 'What to review, in what order', () => study(c, 'Make me an exam review plan from this course’s materials: the topics in order, what to review for each (with the source), and a quick self-test question for each.'))),
    el('button', { type: 'button', class: 'crs-link', onclick: () => study(c) }, 'Open an empty study chat'));
  if (c.role === 'student') pane.append(el('button', { type: 'button', class: 'crs-link danger', onclick: async () => {
    if (!confirm(`Leave ${c.name}?`)) return;
    try { await postJSON(`${BASE}/${c.id}/leave`, {}); go(root, { view: 'home' }); } catch (e) { toast(e.message); }
  } }, 'Leave this course'));
  q.focus();
}

const KIND_LABEL = { slides: ['PPT', 'slides'], pdf: ['PDF', 'pages'], doc: ['DOC', 'sections'], text: ['TXT', 'sections'], epub: ['EPUB', 'parts'] };
const ago = (t) => { const d = Math.round((Date.now() - t) / 864e5); return d <= 0 ? 'today' : d === 1 ? 'yesterday' : d < 30 ? `${d} days ago` : new Date(t).toLocaleDateString(); };

function materialsTab(root, pane, c) {
  const owner = c.role === 'owner' || c.role === 'ta';
  const rows = el('div', 'crs-files');
  const last = lastSeen(c.id);
  const fileRow = (d) => {
    const [tag, unit] = KIND_LABEL[d.kind] || KIND_LABEL.text;
    const later = d.from && d.from > Date.now();
    const status = d.hidden ? el('span', 'crs-vis off', 'Hidden from students') : later ? el('span', 'crs-vis later', `Opens ${new Date(d.from).toLocaleDateString([], { month: 'short', day: 'numeric' })}`) : el('span', 'crs-ready', el('i'), owner ? 'Visible' : 'Ready');
    const isNew = !owner && last && d.added > last;
    return el('div', 'crs-file',
      el('span', { class: `crs-ext ${d.kind}` }, tag),
      el('span', 'crs-file-txt', el('b', '', d.name, isNew ? el('span', 'crs-new', 'New') : null), el('span', 'muted', `${d.parts} ${unit} · added ${ago(d.added)}`)),
      status,
      owner ? el('button', { type: 'button', class: 'crs-icon-btn plain', 'aria-label': `Who sees ${d.name}`, title: 'Who sees it', onclick: () => visibility(root, c, d) }, ico('sliders', 14)) : null,
      owner ? el('button', { type: 'button', class: 'crs-icon-btn', 'aria-label': `Remove ${d.name}`, title: 'Remove', onclick: async () => {
        if (!confirm(`Remove “${d.name}”? Eden stops answering from it.`)) return;
        try { await postJSON(`${BASE}/${c.id}/docs/${d.id}/delete`, {}); go(root, { view: 'course', id: c.id, tab: 'materials' }); } catch (e) { toast(e.message); }
      } }, ico('trash', 14)) : null);
  };
  rows.replaceChildren(...c.docs.map(fileRow));
  const out = [];
  if (owner) out.push(dropzone(root, c, rows));
  out.push(el('div', 'crs-sec-h', el('h4', '', 'Course materials'), el('span', 'muted', String(c.docs.length))));
  out.push(c.docs.length ? rows : el('div', 'crs-empty', owner ? 'Nothing here yet. Start with your syllabus and this week’s slides.' : 'Your professor hasn’t added materials yet.'));
  if (owner) out.push(el('button', { type: 'button', class: 'crs-link danger', onclick: async () => {
    if (!confirm(`Delete ${c.name}? Its materials are deleted and students lose access. This can’t be undone.`)) return;
    try { await postJSON(`${BASE}/${c.id}/delete`, {}); toast('Course deleted'); go(root, { view: 'home' }); } catch (e) { toast(e.message); }
  } }, 'Delete this course'));
  pane.replaceChildren(...out);
}

function dropzone(root, c, rows) {
  const input = el('input', { type: 'file', multiple: true, accept: '.pdf,.epub,.pptx,.docx,.txt,.md', class: 'crs-file-in', id: 'crsFiles' });
  const zone = el('label', { class: 'crs-drop', for: 'crsFiles' },
    svg(UPLOAD, 'crs-drop-ic'),
    el('b', '', 'Drop lesson plans, slides and readings here'),
    el('span', 'muted', 'or click to choose files · PDF, EPUB, PowerPoint, Word, text'),
    el('span', 'crs-drop-note', ico('lock', 11), 'Files are read on this device. Only their text is uploaded.'),
    input);
  const handle = async (files) => {
    let added = 0;
    for (const f of files) {
      if (!kindOf(f.name)) { toast(`${f.name}: Eden reads PDF, EPUB, PowerPoint (.pptx), Word (.docx) and text files.`); continue; }
      const status = el('span', 'muted', 'Reading…');
      const bar = el('i', { style: { '--p': '15%' } });
      const row = el('div', 'crs-file busy', el('span', { class: `crs-ext ${kindOf(f.name)}` }, (KIND_LABEL[kindOf(f.name)] || KIND_LABEL.text)[0]),
        el('span', 'crs-file-txt', el('b', '', f.name.replace(/\.[^.]+$/, '')), status), el('span', 'crs-progress', bar));
      rows.prepend(row);
      try {
        const got = await extractFile(f);
        let { parts } = got;
        bar.style.setProperty('--p', '45%');
        if (got.scanned && got.scanned.length) parts = await readScanned(c.id, f, got.scanned, parts, status);
        if (!parts.length) throw new Error('No text found in this file.');
        const book = looksLikeTextbook(f.name, parts);
        if (book && !confirm(`${f.name} looks like a publisher’s textbook (${book}).\n\nUpload only what you have the right to share with your students: your own notes and slides, open textbooks, or readings your school licenses for this. Publisher textbooks usually can’t be uploaded.\n\nAdd it anyway?`)) throw new Error('Not added.');
        const unit = (KIND_LABEL[got.kind] || KIND_LABEL.text)[1];
        // a big file goes in pieces: the first creates it, the rest are added to it
        const PIECE = 400;
        status.textContent = `Adding ${parts.length} ${unit}…`;
        const made = await postJSON(`${BASE}/${c.id}/docs`, { name: f.name.replace(/\.[^.]+$/, ''), kind: got.kind, parts: parts.slice(0, PIECE) });
        for (let i = PIECE; i < parts.length; i += PIECE) {
          status.textContent = `Adding ${unit} ${i + 1}–${Math.min(i + PIECE, parts.length)} of ${parts.length}…`;
          bar.style.setProperty('--p', `${45 + Math.round((i / parts.length) * 50)}%`);
          await postJSON(`${BASE}/${c.id}/docs`, { append: made.doc, parts: parts.slice(i, i + PIECE) });
        }
        added++;
      } catch (e) { row.classList.add('bad'); status.textContent = e.message; continue; }
      row.remove();
    }
    if (added) { toast(`Added ${added} file${added === 1 ? '' : 's'}`); go(root, { view: 'course', id: c.id, tab: 'materials' }); }
  };
  input.addEventListener('change', () => { const files = [...input.files]; input.value = ''; handle(files); });
  zone.addEventListener('dragover', (e) => { e.preventDefault(); zone.classList.add('over'); });
  zone.addEventListener('dragleave', () => zone.classList.remove('over'));
  zone.addEventListener('drop', (e) => { e.preventDefault(); zone.classList.remove('over'); handle([...e.dataTransfer.files]); });
  return zone;
}

/** A PDF's scanned pages (pictures, no text), read on askeden.com 4 at a time, if the professor agrees to the cost. */
async function readScanned(id, file, pages, parts, status) {
  const n = pages.length;
  if (!confirm(`${file.name}: ${n} page${n === 1 ? ' is a picture' : 's are pictures'} with no text (a scan). Read ${n === 1 ? 'it' : 'them'} with Eden’s AI? It uses your included AI, about $${(n * 0.004).toFixed(2)}.`)) return parts;
  const read = [];
  for (let i = 0; i < pages.length; i += 4) {
    status.textContent = `Reading scanned pages: ${Math.min(i + 4, n)} of ${n}…`;
    const images = await pageImages(file, pages.slice(i, i + 4));
    const out = await postJSON(`${BASE}/${id}/ocr`, { images });
    read.push(...out.parts.filter((p) => p.text.trim()));
  }
  const num = (p) => Number(p.loc.replace(/\D+/g, '')) || 0;
  return [...parts, ...read].sort((a, b) => num(a) - num(b));
}

/** A publisher's textbook, by its name and first pages (a reason to show), or null. Open textbooks pass. */
export function looksLikeTextbook(name, parts) {
  const head = parts.slice(0, 6).map((p) => p.text).join('\n').slice(0, 20000);
  if (/creative commons|cc by|openstax|open textbook|libretexts/i.test(head)) return null;
  const publisher = /(pearson|mcgraw[- ]hill|wiley|cengage|elsevier|springer|macmillan|oxford university press|cambridge university press|w\. ?w\. ?norton|sage publications)/i.exec(head);
  if (publisher) return publisher[1];
  if (/\bISBN(?:-1[03])?:?\s*[\d-]{10,}/i.test(head) && /all rights reserved/i.test(head)) return 'ISBN and “all rights reserved”';
  if (parts.length > 250 && /all rights reserved/i.test(head)) return `${parts.length} pages, “all rights reserved”`;
  return null;
}

// what's new since the last visit (a student's own browser)
const lastSeen = (id) => { try { return Number(localStorage.getItem(`edu:seen:${id}`)) || 0; } catch { return 0; } };
function seen(c) { try { setTimeout(() => localStorage.setItem(`edu:seen:${c.id}`, String(Date.now())), 4000); } catch { /* none */ } }

/** Who sees a file: everyone, no one yet (hidden), or from a date (a unit that opens later). */
function visibility(root, c, d) {
  const date = el('input', { type: 'date', class: 'crs-date', value: d.from ? new Date(d.from).toISOString().slice(0, 10) : '' });
  const choice = (v, t, note) => el('label', 'crs-vis-opt', el('input', { type: 'radio', name: 'crs-vis', value: v, checked: (v === 'hidden' && d.hidden) || (v === 'later' && !d.hidden && d.from) || (v === 'all' && !d.hidden && !d.from) ? true : null }), el('span', '', el('b', '', t), el('span', 'muted', note)));
  const dlg = el('dialog', 'crs-dialog glass',
    el('form', { method: 'dialog', class: 'crs-dialog-body', onsubmit: async (e) => {
      const v = (e.target.querySelector('input[name="crs-vis"]:checked') || {}).value || 'all';
      const body = v === 'hidden' ? { hidden: true, from: null } : v === 'later' ? { hidden: false, from: date.value ? new Date(`${date.value}T08:00`).getTime() : null } : { hidden: false, from: null };
      try { await postJSON(`${BASE}/${c.id}/docs/${d.id}`, body); toast('Saved'); go(root, { view: 'course', id: c.id, tab: 'materials' }); } catch (err) { toast(err.message); }
    } },
    el('h3', '', `Who sees “${d.name}”`),
    choice('all', 'Students now', 'Eden answers from it and students see it.'),
    choice('later', 'Students from a date', 'For a unit that opens later.'), date,
    choice('hidden', 'No one yet', 'Only you and your TAs. Eden won’t use it for students.'),
    el('div', 'crs-dialog-acts', el('button', { type: 'button', class: 'btn', onclick: () => dlg.close() }, 'Cancel'), el('button', { type: 'submit', class: 'btn primary' }, 'Save'))));
  document.body.append(dlg);
  dlg.addEventListener('close', () => dlg.remove());
  dlg.showModal();
}

/** The class: who's in it, TAs, removing someone, a new join code, sharing it. */
async function classTab(root, pane, c) {
  const owner = c.role === 'owner';
  pane.replaceChildren(loading());
  let list;
  try { list = (await getJSON(`${BASE}/${c.id}/members`)).members; } catch (e) { fail(pane, e); return; }
  const link = `${location.origin}/edu`;
  const share = el('div', 'crs-share',
    el('div', 'crs-share-txt', el('b', '', 'Invite your class'), el('span', 'muted', `Students open ${location.host}/edu, then join with code ${c.code}.`)),
    el('div', 'crs-share-acts',
      el('button', { type: 'button', class: 'btn', onclick: () => navigator.clipboard.writeText(`Join ${c.name} on Eden for Education: ${link} — code ${c.code}`).then(() => toast('Invitation copied')) }, ico('copy', 12), 'Copy invitation'),
      el('a', { class: 'btn', href: `https://classroom.google.com/share?url=${encodeURIComponent(link)}&title=${encodeURIComponent(`${c.name}: join code ${c.code}`)}`, target: '_blank', rel: 'noopener' }, 'Share to Google Classroom'),
      owner ? el('button', { type: 'button', class: 'btn', onclick: async () => {
        if (!confirm('Make a new join code? The current code stops working; students already in the class stay.')) return;
        try { const r = await postJSON(`${BASE}/${c.id}/code`, {}); toast(`New code: ${r.code}`); go(root, { view: 'course', id: c.id, tab: 'class' }); } catch (e) { toast(e.message); }
      } }, 'New code') : null));
  const role = { owner: 'Professor', ta: 'TA', student: 'Student' };
  const row = (m) => el('div', 'crs-member',
    el('span', { class: 'crs-avatar', 'aria-hidden': 'true' }, (m.label.match(/\p{L}/u) || ['?'])[0].toUpperCase()),
    el('span', 'crs-file-txt', el('b', '', m.label, m.you ? el('span', 'muted', ' (you)') : null), el('span', 'muted', `Joined ${ago(m.joined)}`)),
    el('span', `crs-role-tag ${m.role}`, role[m.role]),
    owner && m.role !== 'owner' ? el('button', { type: 'button', class: 'btn', onclick: async () => {
      try { await postJSON(`${BASE}/${c.id}/members/${m.id}/role`, { role: m.role === 'ta' ? 'student' : 'ta' }); classTab(root, pane, c); } catch (e) { toast(e.message); }
    } }, m.role === 'ta' ? 'Make student' : 'Make TA') : null,
    owner && m.role !== 'owner' ? el('button', { type: 'button', class: 'crs-icon-btn', 'aria-label': `Remove ${m.label}`, title: 'Remove from the class', onclick: async () => {
      if (!confirm(`Remove ${m.label} from ${c.name}? They lose access and their study chats here are deleted.`)) return;
      try { await postJSON(`${BASE}/${c.id}/members/${m.id}/remove`, {}); classTab(root, pane, c); } catch (e) { toast(e.message); }
    } }, ico('trash', 14)) : null);
  const students = list.filter((m) => m.role === 'student').length;
  pane.replaceChildren(share,
    el('div', 'crs-sec-h', el('h4', '', 'People'), el('span', 'muted', `${students} student${students === 1 ? '' : 's'} · ${list.length - students - 1} TA${list.length - students - 1 === 1 ? '' : 's'}`)),
    el('div', 'crs-files', ...list.map(row)),
    el('p', 'sp-note', owner ? 'TAs can add materials, change the rules and see insights. Only you can remove people, change the code or delete the course.' : 'Only the professor can remove people or change the code.'));
}

/** Flashcards and games: the study companion when this page has one (edu-app.js), else a chat. */
function companion(c, fallback) {
  const ev = new CustomEvent('eden:study-companion', { detail: { course: c }, cancelable: true });
  if (!dispatchEvent(ev)) return;
  study(c, fallback);
}

function rulesTab(pane, c) {
  let mode = c.mode === 'strict' ? 'strict' : 'fallback';
  const summary = el('span', '');
  const paint = () => {
    for (const card of cards) { const on = card.dataset.mode === mode; card.classList.toggle('on', on); card.querySelector('input').checked = on; }
    summary.textContent = mode === 'strict' ? 'If something isn’t covered, Eden says so and points you to office hours.' : 'If something isn’t covered, Eden says so and labels any general answer.';
  };
  const card = (m, t, d) => el('label', { class: 'crs-mode', 'data-mode': m },
    el('input', { type: 'radio', name: 'crs-mode', value: m, onchange: () => { mode = m; paint(); } }),
    el('b', '', t), el('span', 'muted', d));
  const cards = [
    card('fallback', 'Course first, then a labeled general answer', 'Recommended. Eden says the materials don’t cover it, then gives a general answer marked “Not from your course”.'),
    card('strict', 'Course materials only', 'Eden says it isn’t covered and suggests asking you or a TA. Nothing beyond the materials.'),
  ];
  const instr = el('textarea', { id: 'crsInstr', rows: '4', maxlength: '2000', placeholder: 'e.g. Use the lecture’s terms. Ask one guiding question before explaining. For lab safety, point to the lab manual.' });
  instr.value = c.instructions || '';
  const save = el('button', { type: 'submit', class: 'btn primary crs-big' }, 'Save rules');
  // exam pauses: Eden stops answering students between these times
  let pauses = (c.pauses || []).map((p) => ({ ...p }));
  const local = (ms) => { const d = new Date(ms); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 16); };
  const pauseList = el('div', 'crs-pauses');
  const drawPauses = () => pauseList.replaceChildren(...pauses.map((p, i) => el('div', 'crs-pause',
    el('input', { class: 'crs-pause-name', value: p.label, maxlength: '60', 'aria-label': 'What it is', oninput: (e) => { p.label = e.target.value; } }),
    el('input', { type: 'datetime-local', value: local(p.start), 'aria-label': 'Starts', onchange: (e) => { p.start = new Date(e.target.value).getTime(); } }),
    el('span', 'muted', 'to'),
    el('input', { type: 'datetime-local', value: local(p.end), 'aria-label': 'Ends', onchange: (e) => { p.end = new Date(e.target.value).getTime(); } }),
    el('button', { type: 'button', class: 'crs-icon-btn', 'aria-label': 'Remove this pause', onclick: () => { pauses.splice(i, 1); drawPauses(); } }, ico('trash', 13)))),
    pauses.length ? '' : el('div', 'muted crs-pause-none', 'No pauses. Eden answers students any time.'));
  drawPauses();
  const addPause = el('button', { type: 'button', class: 'btn', onclick: () => {
    const start = new Date(); start.setDate(start.getDate() + 7); start.setHours(10, 0, 0, 0);
    pauses.push({ label: 'Midterm', start: start.getTime(), end: start.getTime() + 90 * 60e3 });
    drawPauses();
  } }, ico('plus', 12), 'Add an exam pause');
  const form = el('form', { class: 'crs-rules', onsubmit: async (e) => {
    e.preventDefault();
    save.disabled = true;
    try { await postJSON(`${BASE}/${c.id}`, { mode, instructions: instr.value, pauses }); toast('Rules saved'); } catch (err) { toast(err.message); }
    save.disabled = false;
  } },
  el('h4', 'crs-h', 'When a question isn’t covered by your materials'),
  el('div', 'crs-modes', ...cards),
  el('h4', 'crs-h', 'Always on'),
  el('div', 'crs-always',
    el('span', '', ico('check', 12), 'Every answer cites the slide or page, and the quote is checked'),
    el('span', '', ico('check', 12), 'Eden explains and works similar examples; it doesn’t write graded work'),
    el('span', '', ico('check', 12), 'You see topics in Insights, never who asked')),
  el('label', { class: 'crs-field', for: 'crsInstr' }, 'Extra instructions for Eden', instr),
  el('h4', 'crs-h', 'Exam pauses'),
  el('p', 'sp-note', 'During a pause Eden doesn’t answer students in this course. You and your TAs can still use it.'),
  pauseList, addPause,
  save);
  const preview = el('aside', 'crs-preview',
    el('div', 'crs-eyebrow', 'What students see'),
    el('div', 'crs-preview-card',
      el('div', 'crs-preview-top', badge(c.verified, true) || el('span', 'muted', 'Not verified yet'), el('span', 'muted', c.name)),
      el('b', '', `How Eden helps in ${c.name}`),
      el('div', 'crs-preview-list',
        el('span', '', ico('check', 12), 'Answers come from your course materials, with the page or slide.'),
        el('span', '', ico('check', 12), summary),
        el('span', '', ico('check', 12), 'Eden explains and guides; it won’t write graded work for you.'))));
  pane.replaceChildren(el('div', 'crs-split', form, preview));
  paint();
}

async function insightsTab(pane, c, days = 7) {
  pane.replaceChildren(loading());
  let d;
  try { d = await getJSON(`${BASE}/${c.id}/insights?days=${days}`); } catch (e) { fail(pane, e); return; }
  const range = el('div', { class: 'crs-seg', role: 'group', 'aria-label': 'Time range' }, ...[[7, '7 days'], [30, '30 days'], [365, 'This year']].map(([n, t]) =>
    el('button', { type: 'button', class: n === days ? 'on' : '', 'aria-pressed': String(n === days), onclick: () => insightsTab(pane, c, n) }, t)));
  const stat = (v, label, note) => el('div', 'crs-stat', el('span', 'muted', label), el('b', '', v), note ? el('span', 'crs-stat-note', note) : null);
  const max = d.topics.length ? d.topics[0].n : 1;
  pane.replaceChildren(
    el('div', 'crs-sec-h', el('span', 'muted', 'Anonymous: topics and counts, never who asked.'), range),
    el('div', 'crs-stats',
      stat(String(d.students), 'Students studying'),
      stat(String(d.questions), 'Questions asked'),
      stat(d.verifiedShare === null ? '—' : `${d.verifiedShare}%`, 'Answered from your materials', d.general ? `${d.general} answered from general knowledge` : null),
      stat(d.quizAverage === null ? '—' : `${d.quizAverage}%`, 'Practice quiz average', d.quizzes ? `${d.quizzes} quiz${d.quizzes === 1 ? '' : 'zes'} taken` : 'No quizzes yet')),
    el('div', 'crs-split',
      el('section', 'crs-box',
        el('h4', 'crs-h', 'What students ask about most'),
        ...(d.topics.length ? d.topics.map((t) => el('div', 'crs-bar',
          el('span', 'crs-bar-txt', el('b', '', t.loc), el('span', 'muted', t.name)),
          el('span', 'crs-bar-track', el('i', { style: { width: `${Math.max(4, Math.round((t.n / max) * 100))}%` } })),
          el('span', 'crs-n', String(t.n)))) : [el('div', 'crs-empty', 'No questions yet. Share the join code with your class.')])),
      el('section', 'crs-box',
        el('h4', 'crs-h', 'Not covered by your materials'),
        el('p', 'sp-note', 'Eden answered these from general knowledge. Add a page on them and the answers become verified.'),
        ...(d.gaps.length ? d.gaps.map((g) => el('div', 'crs-gap', el('span', '', g.q), el('span', 'crs-pill', `${g.n}×`))) : [el('div', 'crs-empty', 'None so far.')]))));
}

/* ---------- practice quiz ---------- */

function quizView(root, c) {
  const topic = el('input', { class: 'crs-topic', placeholder: 'Topic (optional): e.g. the electron transport chain', maxlength: '200', 'aria-label': 'Quiz topic' });
  const box = el('div', 'crs-quiz');
  const start = el('form', { class: 'crs-quiz-start', onsubmit: (e) => { e.preventDefault(); runQuiz(box, c, topic.value.trim(), start); } },
    topic, el('button', { type: 'submit', class: 'btn primary crs-big' }, 'Start quiz'));
  root.replaceChildren(back(root, { view: 'course', id: c.id, tab: 'study' }, c.name),
    el('header', 'crs-hero small', el('h2', '', 'Practice quiz'), el('p', '', 'Five questions written from your course’s materials. Each is checked against the slide or page it comes from before you see it.')),
    start, box);
  topic.focus();
}

async function runQuiz(box, c, topic, start) {
  start.hidden = true;
  box.replaceChildren(el('div', 'crs-qcard', loading('Writing questions from the materials and checking each one…')));
  let text = '', grounding = null, error = null;
  try {
    await api.send({ messages: [{ role: 'user', content: topic ? `Make a practice quiz on: ${topic}` : 'Make a practice quiz on this course.' }], course: c.id, courseTask: 'quiz', topic, temporary: true, mode: 'chat' }, {
      onEvent: (type, d) => {
        if (type === 'text') text += d.text || '';
        else if (type === 'grounding') grounding = d;
        else if (type === 'error') error = d.message;
      },
    });
  } catch (e) { error = e.message; }
  let qs = [];
  try { qs = JSON.parse(text.replace(/^\s*```(?:json)?\s*|\s*```\s*$/g, '')).questions || []; } catch { /* below */ }
  const checked = qs.map((q, i) => ({ q, src: grounding && grounding.sources && grounding.sources[i] }))
    .filter((x) => x.src && x.src.ok && Array.isArray(x.q.choices) && x.q.choices.length >= 2 && Number.isInteger(x.q.answer) && x.q.choices[x.q.answer] !== undefined);
  if (!checked.length) {
    start.hidden = false;
    box.replaceChildren(el('div', 'sp-warn', el('b', '', 'No quiz this time'), error || 'Eden couldn’t write questions it could check against the materials. Try a topic from the course.'));
    return;
  }
  let i = 0, score = 0;
  const show = () => {
    if (i >= checked.length) {
      const pct = Math.round((score / checked.length) * 100);
      postJSON(`${BASE}/${c.id}/quiz-score`, { score, total: checked.length, topic }).catch(() => {}); // anonymous, for the professor's insights
      box.replaceChildren(el('div', 'crs-qcard crs-result',
        el('div', { class: 'crs-ring', style: { '--p': `${pct}%` } }, el('b', '', `${score}/${checked.length}`)),
        el('h3', '', pct === 100 ? 'Perfect score' : pct >= 60 ? 'Nice work' : 'Keep going'),
        el('p', 'muted', pct === 100 ? 'You got every question right.' : 'Go back over the sources of the ones you missed.'),
        el('div', 'crs-row-btns',
          el('button', { type: 'button', class: 'btn primary crs-big', onclick: () => runQuiz(box, c, topic, start) }, 'Another quiz'),
          el('button', { type: 'button', class: 'btn crs-big', onclick: () => study(c, `I just took a practice quiz${topic ? ` on ${topic}` : ''}. Explain the ideas behind it again, briefly, with sources.`) }, 'Review with Eden'))));
      return;
    }
    const { q, src } = checked[i];
    const feedback = el('div', { class: 'crs-feedback', 'aria-live': 'polite' });
    const next = el('button', { type: 'button', class: 'btn primary crs-big', hidden: true, onclick: () => { i++; show(); } }, i + 1 < checked.length ? 'Next question' : 'See my score');
    const choices = q.choices.map((t, k) => el('button', { type: 'button', class: 'crs-choice', onclick: () => {
      choices.forEach((b, j) => { b.disabled = true; if (j === q.answer) b.classList.add('right'); else if (j === k) b.classList.add('wrong'); });
      const right = k === q.answer;
      if (right) score++;
      feedback.className = `crs-feedback ${right ? 'right' : 'wrong'}`;
      feedback.replaceChildren(el('b', '', right ? 'Correct' : `Not quite. The answer is ${String.fromCharCode(65 + q.answer)}.`),
        el('span', '', String(q.explain || '')),
        el('span', 'crs-src-line', svg(SHIELD), `${src.file} · ${src.at}`, el('span', 'muted', ' · quote checked')));
      next.hidden = false;
      next.focus();
    } }, el('span', 'crs-letter', String.fromCharCode(65 + k)), el('span', '', String(t))));
    box.replaceChildren(el('div', 'crs-qcard',
      el('div', 'crs-qtop', el('span', 'muted', `Question ${i + 1} of ${checked.length}`), el('span', 'muted', `${src.file} · ${src.at}`)),
      el('div', 'crs-qbar', el('i', { style: { width: `${Math.round((i / checked.length) * 100)}%` } })),
      el('h3', 'crs-q', String(q.q || '')),
      el('div', 'crs-choices', ...choices), feedback, next));
  };
  show();
}

/* ---------- under a reply ---------- */

/** Under a reply in a course chat: Verified / Partly verified / General, and the checked quotes. */
export function groundingStrip(g, courseId = null) {
  if (!g) return null;
  const where = g.scope === 'files' ? 'your files' : 'your course';
  const label = g.scope === 'web'
    ? (g.status === 'web' ? 'High-stakes question: checked against the web sources above' : 'High-stakes question: not checked against sources. Confirm with a professional.')
    : { verified: `Verified from ${where}`, partial: 'Partly verified', general: `Not from ${where === 'your files' ? 'your files' : 'your course materials'}` }[g.status] || '';
  if (g.scope === 'web') return el('div', { class: `crs-ground ${g.status === 'web' ? 'partial' : 'general'}` }, el('div', 'crs-ground-h', ico('info', 12), label));
  const box = el('div', { class: `crs-ground ${g.status}` }, el('div', 'crs-ground-h', g.status === 'verified' ? svg(SHIELD) : ico('info', 12), label));
  for (const s of g.sources || []) {
    const open = courseId && s.doc && s.at ? () => dispatchEvent(new CustomEvent('eden:study-source', { detail: { course: courseId, doc: s.doc, loc: s.at, quote: s.ok ? s.quote : '' } })) : null;
    box.append(el(open ? 'button' : 'div', { ...(open ? { type: 'button', onclick: open } : {}), class: `crs-src${s.ok ? '' : ' bad'}${open ? ' link' : ''}`, title: s.quote ? `“${s.quote}”` : '' },
      el('b', '', `${s.n}`), el('span', 'crs-src-txt', s.file ? `${s.file} · ${s.at}` : 'No source given'),
      s.ok ? null : el('span', 'crs-flag', s.file ? 'quote not found in the source' : 'unsupported')));
  }
  return box;
}

/** A course reply's text for display: the <sources> block (shown by groundingStrip instead) cut off, also while it streams. */
export function stripSources(text) {
  const t = String(text).replace(/\s*<sources>[\s\S]*$/i, '');
  const lt = t.lastIndexOf('<');
  return lt >= 0 && t.length - lt < 9 && '<sources>'.startsWith(t.slice(lt).toLowerCase()) ? t.slice(0, lt).trimEnd() : t;
}
