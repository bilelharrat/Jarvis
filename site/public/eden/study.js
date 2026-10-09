// The study companion (Eden for Education, askeden ROADMAP L6): a panel that opens on the right, as
// Eden's cloud browser does (edu.html #companion, edu-app.js opens it), for the course being studied.
//
//   Sets     the class's shared sets (the professor's or a TA's, GET …/sets) and this browser's own
//            (localStorage edu:sets:<course>); "Make a set" asks for flashcards from the materials
//            (courseTask 'set'): only cards whose quote is really in their source are kept
//   Cards    flip cards: Space flips, ← → move, "Know it" / "Still learning", shuffle, star
//   Learn    multiple choice, then typing the term: each card until it's right twice
//   Test     ten questions (choice, true/false, written), a score, the misses with their sources
//   Match    six pairs against the clock
//   Source   the page or slide a citation or a card points to (GET …/source)

import { el, ico, toast } from './util.js';
import { api, getJSON, postJSON } from './api.js';

const BASE = '/api/chat/courses';
let panel = null;
let state = { course: null, tab: 'sets', set: null, source: null };
let keyHandler = null;

const SHIELD = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3 4 6v6c0 4.5 3.4 8.3 8 9 4.6-.7 8-4.5 8-9V6l-8-3z"/><path d="m9 12 2 2 4-4"/></svg>';
const shield = () => { const s = el('span', 'stu-shield'); s.innerHTML = SHIELD; return s; }; // constant markup

const mineKey = (id) => `edu:sets:${id}`;
const progKey = (id, set) => `edu:prog:${id}:${set}`;
const load = (k, d) => { try { const v = JSON.parse(localStorage.getItem(k) || 'null'); return v ?? d; } catch { return d; } };
const save = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { toast('This browser’s storage is full.'); } };
const norm = (t) => String(t).toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const shuffle = (a) => { a = [...a]; for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };

/** Close enough for a typed answer: the same words, allowing a typo or two. */
export function closeEnough(typed, want) {
  const a = norm(typed), b = norm(want);
  if (!a) return false;
  if (a === b) return true;
  const d = [];
  for (let i = 0; i <= a.length; i++) { d[i] = [i]; for (let j = 1; j <= b.length; j++) d[i][j] = i === 0 ? j : Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)); }
  return d[a.length][b.length] <= Math.max(1, Math.floor(b.length * 0.2));
}

/* ---------- the panel ---------- */

/** Opens the companion for a course ({ id, name, verified, role }), on a tab ('sets', 'cards', 'source'…). */
export function openCompanion(course, opts = {}) {
  panel = document.getElementById('companion');
  if (!panel || !course) return false;
  if (!state.course || state.course.id !== course.id) state = { course, tab: 'sets', set: null, source: null };
  else state.course = { ...state.course, ...course };
  if (opts.tab) state.tab = opts.tab;
  if (opts.source) state.source = opts.source;
  document.body.classList.add('companion-open');
  panel.setAttribute('aria-hidden', 'false');
  paint();
  return true;
}

export function closeCompanion() {
  document.body.classList.remove('companion-open');
  if (panel) panel.setAttribute('aria-hidden', 'true');
  setKeys(null);
}
export const companionOpen = () => document.body.classList.contains('companion-open');
export const companionCourse = () => state.course;

function setKeys(fn) {
  if (keyHandler) removeEventListener('keydown', keyHandler);
  keyHandler = fn;
  if (fn) addEventListener('keydown', fn);
}

const TABS = [['sets', 'Sets'], ['cards', 'Cards'], ['learn', 'Learn'], ['test', 'Test'], ['match', 'Match'], ['source', 'Source']];

function paint() {
  const c = state.course;
  const head = el('div', 'stu-head',
    el('div', 'stu-title', el('b', '', 'Study'), el('span', 'muted', c.name)),
    el('button', { type: 'button', class: 'iconbtn', 'aria-label': 'Close the study companion', title: 'Close', onclick: closeCompanion }, ico('x')));
  const needsSet = ['cards', 'learn', 'test', 'match'];
  const tabs = el('div', { class: 'stu-tabs', role: 'tablist', 'aria-label': 'Study modes' }, ...TABS.map(([k, t]) => el('button', {
    type: 'button', role: 'tab', class: k === state.tab ? 'on' : '', 'aria-selected': String(k === state.tab),
    disabled: needsSet.includes(k) && !state.set ? true : null, onclick: () => { state.tab = k; paint(); },
  }, t)));
  const body = el('div', 'stu-body');
  panel.replaceChildren(head, tabs, body);
  setKeys(null);
  if (state.tab === 'sets' || (needsSet.includes(state.tab) && !state.set)) sets(body);
  else if (state.tab === 'cards') cards(body);
  else if (state.tab === 'learn') learn(body);
  else if (state.tab === 'test') test(body);
  else if (state.tab === 'match') match(body);
  else source(body);
}

const setHead = () => el('div', 'stu-sethead', el('b', '', state.set.title), el('span', 'muted', `${state.set.cards.length} cards`));
const srcChip = (card) => (card.doc && card.at ? el('button', { type: 'button', class: 'stu-src', title: 'Open the source', onclick: (e) => { e.stopPropagation(); showSource({ doc: card.doc, loc: card.at }); } }, shield(), `${card.file} · ${card.at}`) : card.file ? el('span', 'stu-src', shield(), `${card.file} · ${card.at}`) : null);

/* ---------- sets ---------- */

async function sets(body) {
  const c = state.course;
  const staff = c.role === 'owner' || c.role === 'ta';
  const topic = el('input', { class: 'stu-in', placeholder: 'A topic (optional): e.g. membrane transport', maxlength: '200', 'aria-label': 'Topic for the new set' });
  const make = el('button', { type: 'submit', class: 'btn primary' }, ico('spark', 13), 'Make a set');
  const status = el('div', { class: 'muted stu-status', 'aria-live': 'polite' });
  const form = el('form', { class: 'stu-make', onsubmit: async (e) => {
    e.preventDefault();
    make.disabled = true;
    status.replaceChildren(el('span', 'crs-spin'), 'Writing cards from the materials and checking each one…');
    try {
      const made = await generateSet(c, topic.value.trim());
      const mine = load(mineKey(c.id), []);
      mine.unshift(made);
      save(mineKey(c.id), mine.slice(0, 40));
      state.set = made;
      state.tab = 'cards';
      paint();
    } catch (err) { status.replaceChildren(el('span', 'stu-bad', err.message)); make.disabled = false; }
  } }, topic, make);
  const list = el('div', 'stu-sets', el('div', 'muted', 'Loading…'));
  body.replaceChildren(
    el('div', 'stu-hero', el('b', '', 'Flashcards from your course'), el('span', 'muted', 'Every card comes from a slide or page, and Eden checks the quote is really there.')),
    form, status, list);
  let shared = [];
  try { shared = (await getJSON(`${BASE}/${c.id}/sets`)).sets; } catch { /* offline: just this browser's */ }
  const mine = load(mineKey(c.id), []);
  const row = (s, { own, sharedSet }) => el('div', 'stu-set',
    el('button', { type: 'button', class: 'stu-set-open', onclick: () => { state.set = s; state.tab = 'cards'; paint(); } },
      el('b', '', s.title), el('span', 'muted', `${s.cards.length} cards${sharedSet ? ' · from your professor' : ''}`)),
    staff && own ? el('button', { type: 'button', class: 'btn', title: 'Share with the class', onclick: async () => {
      try { await postJSON(`${BASE}/${c.id}/sets`, { title: s.title, cards: s.cards }); toast('Shared with the class'); sets(body); } catch (e) { toast(e.message); }
    } }, 'Share') : null,
    (own || (staff && sharedSet)) ? el('button', { type: 'button', class: 'iconbtn', 'aria-label': `Delete ${s.title}`, onclick: async () => {
      if (!confirm(`Delete “${s.title}”?`)) return;
      if (own) save(mineKey(c.id), load(mineKey(c.id), []).filter((x) => x.id !== s.id));
      else { try { await postJSON(`${BASE}/${c.id}/sets/${s.id}/delete`, {}); } catch (e) { toast(e.message); return; } }
      sets(body);
    } }, ico('trash', 13)) : null);
  const out = [];
  if (shared.length) out.push(el('div', 'stu-h', 'From your class'), ...shared.map((s) => row(s, { sharedSet: true })));
  out.push(el('div', 'stu-h', 'Your sets'));
  out.push(...(mine.length ? mine.map((s) => row(s, { own: true })) : [el('div', 'muted stu-empty', 'Make a set above. It’s kept in this browser.')]));
  list.replaceChildren(...out);
}

/** What a chat message asks the companion for: 'cards', 'learn', 'test' or 'match', and its topic; null for an ordinary question. */
export function studyIntent(text) {
  const t = String(text || '').trim();
  const m = /\b(flash ?cards?|study set|quizlet|learn mode|match(?:ing)? game|practice test|test me|quiz me)\b/i.exec(t);
  if (!m) return null;
  const w = m[1].toLowerCase();
  const tab = /test|quiz/.test(w) ? 'test' : /learn/.test(w) ? 'learn' : /match/.test(w) ? 'match' : 'cards';
  // the topic: what's left once the request words go ("make flashcards about mitosis" → "mitosis")
  const topic = t.replace(m[0], ' ')
    .replace(/\b(can|could|would|will) you\b|\bplease\b|\b(make|create|give|generate|build|do|start|open)( me| us)?\b|\b(some|a|an|the|set of|me|for me|on|about|of|from|it|this|that|these|them|everything|whole course|course|materials?|for)\b|[?.!,]/gi, ' ')
    .replace(/\s+/g, ' ').trim();
  return { tab, topic: topic.split(' ').length >= 1 && topic.length > 2 ? topic : '' };
}

/** From a study chat: a checked set on the topic, opened in the companion on the asked mode. Returns { title, count, id }. */
export async function studyFromChat(course, topic, tab = 'cards') {
  openCompanion(course, { tab: 'sets' });
  const body = panel && panel.querySelector('.stu-body');
  if (body) body.replaceChildren(el('div', 'stu-status muted', el('span', 'crs-spin'), `Making flashcards${topic ? ` on ${topic}` : ''} from the materials and checking each one…`));
  const made = await generateSet(course, topic);
  const mine = load(mineKey(course.id), []);
  mine.unshift(made);
  save(mineKey(course.id), mine.slice(0, 40));
  state.set = made;
  state.tab = tab;
  openCompanion(course);
  return { id: made.id, title: made.title, count: made.cards.length };
}

/** Opens one of this browser's sets again (the card a study chat left behind). */
export function openSet(course, id, tab = 'cards') {
  const set = load(mineKey(course.id), []).find((s) => s.id === id);
  if (!set) { openCompanion(course, { tab: 'sets' }); return; }
  openCompanion(course);
  state.set = set;
  state.tab = tab;
  paint();
}

/** A study set from the materials: the cards whose quote checks out against its source. */
async function generateSet(c, topic) {
  let text = '', grounding = null, error = null;
  await api.send({ messages: [{ role: 'user', content: topic ? `Make flashcards on: ${topic}` : 'Make flashcards on this course.' }], course: c.id, courseTask: 'set', topic, temporary: true, mode: 'chat' }, {
    onEvent: (type, d) => {
      if (type === 'text') text += d.text || '';
      else if (type === 'grounding') grounding = d;
      else if (type === 'error') error = d.message;
    },
  });
  if (error) throw new Error(error);
  let parsed = null;
  try { parsed = JSON.parse(text.replace(/^\s*```(?:json)?\s*|\s*```\s*$/g, '')); } catch { /* below */ }
  const raw = parsed && Array.isArray(parsed.cards) ? parsed.cards : [];
  const cardsOut = raw.map((x, i) => ({ x, s: grounding && grounding.sources && grounding.sources[i] }))
    .filter(({ x, s }) => s && s.ok && x && x.term && x.def)
    .map(({ x, s }) => ({ term: String(x.term).slice(0, 200), def: String(x.def).slice(0, 1000), doc: s.doc, file: s.file, at: s.at }));
  if (cardsOut.length < 2) throw new Error('Eden couldn’t make cards it could check against the materials. Try a topic from the course.');
  return { id: `m${Date.now().toString(36)}`, title: String((parsed && parsed.title) || topic || 'Study set').slice(0, 80), cards: cardsOut, created: Date.now() };
}

/* ---------- cards ---------- */

function cards(body) {
  const set = state.set;
  const prog = load(progKey(state.course.id, set.id), { known: [], star: [] });
  let order = set.cards.map((_, i) => i);
  let i = 0, flipped = false;
  const view = el('div', 'stu-cards');
  const draw = () => {
    const k = order[i];
    const card = set.cards[k];
    const known = prog.known.includes(k), star = prog.star.includes(k);
    const face = el('button', { type: 'button', class: `stu-card${flipped ? ' flipped' : ''}`, 'aria-label': flipped ? `Answer: ${card.def}` : `Term: ${card.term}. Press to flip.`, onclick: () => { flipped = !flipped; draw(); } },
      el('span', 'stu-card-inner',
        el('span', 'stu-face front', el('span', 'stu-face-label', 'Term'), el('span', 'stu-face-text', card.term)),
        el('span', 'stu-face back', el('span', 'stu-face-label', 'Definition'), el('span', 'stu-face-text sm', card.def), srcChip(card))));
    const knownN = prog.known.length;
    view.replaceChildren(setHead(),
      el('div', 'stu-prog', el('i', { style: { width: `${Math.round((knownN / set.cards.length) * 100)}%` } })),
      el('div', 'stu-meta', el('span', 'muted', `${i + 1} / ${order.length}`), el('span', 'muted', `${knownN} known`),
        el('button', { type: 'button', class: `iconbtn${star ? ' on' : ''}`, 'aria-pressed': String(star), 'aria-label': 'Star this card', title: 'Star', onclick: () => { toggle(prog.star, k); save(progKey(state.course.id, set.id), prog); draw(); } }, ico('pin', 14))),
      face,
      el('div', 'stu-row',
        el('button', { type: 'button', class: 'iconbtn', 'aria-label': 'Previous card', onclick: () => go(-1) }, ico('chevl')),
        el('button', { type: 'button', class: 'btn stu-still', onclick: () => { remove(prog.known, k); save(progKey(state.course.id, set.id), prog); go(1); } }, 'Still learning'),
        el('button', { type: 'button', class: `btn primary${known ? ' done' : ''}`, onclick: () => { if (!known) prog.known.push(k); save(progKey(state.course.id, set.id), prog); go(1); } }, ico('check', 13), 'Know it'),
        el('button', { type: 'button', class: 'iconbtn', 'aria-label': 'Next card', onclick: () => go(1) }, ico('chevr'))),
      el('div', 'stu-row small',
        el('button', { type: 'button', class: 'stu-link', onclick: () => { order = shuffle(order); i = 0; flipped = false; draw(); } }, 'Shuffle'),
        el('button', { type: 'button', class: 'stu-link', onclick: () => { const s = order.filter((x) => prog.star.includes(x)); if (!s.length) { toast('Star some cards first'); return; } order = s; i = 0; flipped = false; draw(); } }, 'Starred only'),
        el('button', { type: 'button', class: 'stu-link', onclick: () => { prog.known = []; save(progKey(state.course.id, set.id), prog); order = set.cards.map((_, x) => x); i = 0; draw(); } }, 'Start over')),
      el('p', 'stu-keys muted', 'Space flips · ← → move'));
  };
  const go = (d) => { i = (i + d + order.length) % order.length; flipped = false; draw(); };
  body.replaceChildren(view);
  draw();
  setKeys((e) => {
    if (!companionOpen() || state.tab !== 'cards' || /INPUT|TEXTAREA/.test(document.activeElement && document.activeElement.tagName)) return;
    if (e.key === ' ') { e.preventDefault(); flipped = !flipped; draw(); }
    else if (e.key === 'ArrowRight') go(1);
    else if (e.key === 'ArrowLeft') go(-1);
  });
}
const toggle = (a, x) => { const i = a.indexOf(x); if (i >= 0) a.splice(i, 1); else a.push(x); };
const remove = (a, x) => { const i = a.indexOf(x); if (i >= 0) a.splice(i, 1); };

/* ---------- learn: choice first, then writing, until each card is right twice ---------- */

function learn(body) {
  const set = state.set;
  const n = set.cards.length;
  const right = new Array(n).fill(0);
  let current = null;
  const view = el('div', 'stu-learn');
  body.replaceChildren(view);
  const next = () => {
    const left = [...right.keys()].filter((k) => right[k] < 2);
    if (!left.length) {
      view.replaceChildren(setHead(), el('div', 'stu-done', el('b', '', 'You’ve learned this set'), el('span', 'muted', `All ${n} cards, each right twice.`),
        el('div', 'stu-row', el('button', { type: 'button', class: 'btn primary', onclick: () => { state.tab = 'test'; paint(); } }, 'Take a test'), el('button', { type: 'button', class: 'btn', onclick: () => learn(body) }, 'Learn again'))));
      return;
    }
    let k = left[Math.floor(Math.random() * left.length)];
    if (left.length > 1 && k === current) k = left.find((x) => x !== current);
    current = k;
    const card = set.cards[k];
    const pct = Math.round((right.reduce((a, b) => a + b, 0) / (n * 2)) * 100);
    const feedback = el('div', { class: 'stu-feedback', 'aria-live': 'polite' });
    const after = (ok, shown) => {
      if (ok) right[k]++; else right[k] = Math.max(0, right[k] - 1);
      feedback.className = `stu-feedback ${ok ? 'ok' : 'no'}`;
      feedback.replaceChildren(el('b', '', ok ? 'Correct' : 'Not quite'), ok ? null : el('span', '', `Answer: ${shown}`), srcChip(card),
        el('button', { type: 'button', class: 'btn primary stu-next', onclick: next }, 'Continue'));
      feedback.querySelector('.stu-next').focus();
    };
    const head = [setHead(), el('div', 'stu-prog', el('i', { style: { width: `${pct}%` } })), el('div', 'stu-meta', el('span', 'muted', `${pct}% learned`))];
    if (right[k] === 0 || n < 4) { // choose the definition
      const others = shuffle(set.cards.filter((_, x) => x !== k)).slice(0, 3).map((c) => c.def);
      const choices = shuffle([card.def, ...others]);
      const btns = choices.map((t) => el('button', { type: 'button', class: 'stu-choice', onclick: () => {
        btns.forEach((b) => { b.disabled = true; if (b.dataset.v === card.def) b.classList.add('right'); });
        if (t !== card.def) btns.find((b) => b.dataset.v === t).classList.add('wrong');
        after(t === card.def, card.def);
      } }, t));
      btns.forEach((b, x) => { b.dataset.v = choices[x]; });
      view.replaceChildren(...head, el('div', 'stu-q', el('span', 'stu-face-label', 'Term'), el('b', '', card.term)), el('div', 'stu-choices', ...btns), feedback);
    } else { // write the term
      const input = el('input', { class: 'stu-in', placeholder: 'Type the term', 'aria-label': 'Your answer', autocomplete: 'off' });
      const form = el('form', { class: 'stu-write', onsubmit: (e) => { e.preventDefault(); input.disabled = true; after(closeEnough(input.value, card.term), card.term); } },
        input, el('button', { type: 'submit', class: 'btn primary' }, 'Check'));
      view.replaceChildren(...head, el('div', 'stu-q', el('span', 'stu-face-label', 'Definition'), el('span', '', card.def)), form,
        el('button', { type: 'button', class: 'stu-link', onclick: () => { input.disabled = true; after(false, card.term); } }, 'I don’t know'), feedback);
      input.focus();
    }
  };
  next();
}

/* ---------- test ---------- */

function test(body) {
  const set = state.set;
  const pick = shuffle(set.cards.map((_, i) => i)).slice(0, Math.min(10, set.cards.length));
  const qs = pick.map((k, x) => {
    const card = set.cards[k];
    const kind = set.cards.length < 4 ? (x % 2 ? 'tf' : 'write') : ['choice', 'tf', 'write'][x % 3];
    if (kind === 'choice') return { k, kind, prompt: card.term, choices: shuffle([card.def, ...shuffle(set.cards.filter((_, y) => y !== k)).slice(0, 3).map((c) => c.def)]), want: card.def };
    if (kind === 'tf') {
      const truth = Math.random() < 0.5;
      const shown = truth ? card.def : shuffle(set.cards.filter((_, y) => y !== k))[0].def;
      return { k, kind, prompt: card.term, shown, want: truth ? 'True' : 'False' };
    }
    return { k, kind, prompt: card.def, want: card.term };
  });
  const answers = new Array(qs.length).fill(null);
  const form = el('form', { class: 'stu-test', onsubmit: (e) => {
    e.preventDefault();
    const results = qs.map((q, x) => (q.kind === 'write' ? closeEnough(answers[x] || '', q.want) : answers[x] === q.want));
    const score = results.filter(Boolean).length;
    body.replaceChildren(setHead(),
      el('div', 'stu-done', el('div', { class: 'crs-ring', style: { '--p': `${Math.round((score / qs.length) * 100)}%` } }, el('b', '', `${score}/${qs.length}`)),
        el('b', '', score === qs.length ? 'Perfect' : score / qs.length >= 0.7 ? 'Nice work' : 'Keep going')),
      el('div', 'stu-h', 'Review'),
      ...qs.map((q, x) => el('div', `stu-review ${results[x] ? 'ok' : 'no'}`,
        el('b', '', q.kind === 'write' ? q.prompt : set.cards[q.k].term),
        el('span', '', results[x] ? 'Right' : `Answer: ${q.kind === 'tf' ? `${q.want} — ${set.cards[q.k].def}` : q.want}${answers[x] ? ` · you said: ${answers[x]}` : ''}`),
        srcChip(set.cards[q.k]))),
      el('div', 'stu-row', el('button', { type: 'button', class: 'btn primary', onclick: () => test(body) }, 'New test'), el('button', { type: 'button', class: 'btn', onclick: () => { state.tab = 'learn'; paint(); } }, 'Learn the misses')));
  } });
  qs.forEach((q, x) => {
    const n = el('span', 'stu-qn', String(x + 1));
    let input;
    if (q.kind === 'write') {
      input = el('input', { class: 'stu-in', placeholder: 'Type the term', 'aria-label': `Answer ${x + 1}`, autocomplete: 'off', oninput: (e) => { answers[x] = e.target.value; } });
    } else {
      const opts = q.kind === 'tf' ? ['True', 'False'] : q.choices;
      input = el('div', { class: 'stu-opts', role: 'radiogroup', 'aria-label': `Question ${x + 1}` }, ...opts.map((o) => el('label', 'stu-opt',
        el('input', { type: 'radio', name: `q${x}`, value: o, onchange: () => { answers[x] = o; } }), el('span', '', o))));
    }
    form.append(el('div', 'stu-tq', n, el('div', 'stu-tq-body',
      el('span', 'stu-face-label', q.kind === 'write' ? 'Definition → term' : q.kind === 'tf' ? 'True or false' : 'Choose the definition'),
      el('b', '', q.prompt), q.kind === 'tf' ? el('span', 'stu-shown', q.shown) : null, input)));
  });
  form.append(el('button', { type: 'submit', class: 'btn primary stu-submit' }, 'Submit test'));
  body.replaceChildren(setHead(), form);
}

/* ---------- match ---------- */

function match(body) {
  const set = state.set;
  const pairs = shuffle(set.cards.map((_, i) => i)).slice(0, Math.min(6, set.cards.length));
  const tiles = shuffle(pairs.flatMap((k) => [{ k, text: set.cards[k].term, side: 't' }, { k, text: set.cards[k].def, side: 'd' }]));
  const best = load(`edu:match:${state.course.id}:${set.id}`, null);
  let picked = null, left = pairs.length, start = 0, timer = 0;
  const clock = el('b', 'stu-clock', '0.0s');
  const grid = el('div', 'stu-match');
  const btns = tiles.map((t) => el('button', { type: 'button', class: 'stu-tile', onclick: () => {
    if (!start) { start = performance.now(); timer = setInterval(() => { clock.textContent = `${((performance.now() - start) / 1000).toFixed(1)}s`; }, 100); }
    const b = btns[tiles.indexOf(t)];
    if (picked === null) { picked = t; b.classList.add('sel'); return; }
    const a = btns[tiles.indexOf(picked)];
    if (picked === t) { a.classList.remove('sel'); picked = null; return; }
    if (picked.k === t.k && picked.side !== t.side) {
      a.classList.add('gone'); b.classList.add('gone'); a.disabled = b.disabled = true; left--;
      if (!left) {
        clearInterval(timer);
        const secs = (performance.now() - start) / 1000;
        if (!best || secs < best) save(`edu:match:${state.course.id}:${set.id}`, secs);
        grid.replaceWith(el('div', 'stu-done', el('b', '', `Matched in ${secs.toFixed(1)}s`), el('span', 'muted', best && secs >= best ? `Your best: ${best.toFixed(1)}s` : 'Your best time'),
          el('button', { type: 'button', class: 'btn primary', onclick: () => match(body) }, 'Play again')));
      }
    } else { a.classList.add('wrong'); b.classList.add('wrong'); setTimeout(() => { a.classList.remove('wrong', 'sel'); b.classList.remove('wrong'); }, 450); }
    picked = null;
  } }, t.text));
  grid.append(...btns);
  body.replaceChildren(setHead(), el('div', 'stu-meta', el('span', 'muted', 'Match each term with its definition'), clock), grid);
}

/* ---------- source ---------- */

/** Shows a page or slide in the companion ({ doc, loc }): from a citation under an answer or a card. */
export function showSource(src) {
  if (!state.course) return;
  state.source = src;
  state.tab = 'source';
  openCompanion(state.course);
}

async function source(body) {
  const s = state.source;
  if (!s) { body.replaceChildren(el('div', 'muted stu-empty', 'Tap a source under an answer, or on a card, to see the page or slide it comes from.')); return; }
  body.replaceChildren(el('div', 'muted', 'Loading…'));
  let p;
  try { p = await getJSON(`${BASE}/${state.course.id}/source?doc=${encodeURIComponent(s.doc)}&loc=${encodeURIComponent(s.loc)}`); }
  catch (e) { body.replaceChildren(el('div', 'sp-warn', el('b', '', 'Couldn’t open it'), e.message)); return; }
  const quoteAt = s.quote ? p.text.toLowerCase().indexOf(String(s.quote).toLowerCase()) : -1;
  const text = el('div', 'stu-page-text');
  if (quoteAt >= 0) text.append(p.text.slice(0, quoteAt), el('mark', '', p.text.slice(quoteAt, quoteAt + s.quote.length)), p.text.slice(quoteAt + s.quote.length));
  else text.textContent = p.text;
  body.replaceChildren(
    el('div', 'stu-page', el('div', 'stu-page-head', el('span', `crs-ext ${p.kind}`, p.kind === 'slides' ? 'PPT' : p.kind === 'doc' ? 'DOC' : p.kind === 'pdf' ? 'PDF' : p.kind === 'epub' ? 'EPUB' : 'TXT'),
      el('div', 'grow', el('b', '', p.name), el('span', 'muted', p.loc))), text),
    el('div', 'stu-row', el('button', { type: 'button', class: 'btn primary', onclick: () => dispatchEvent(new CustomEvent('eden:course-chat', { detail: { course: state.course, prompt: `Explain ${p.loc} of “${p.name}” step by step, then ask me a question to check I understood.` } })) }, ico('spark', 13), 'Explain this page')));
}
