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
//   Review   today's due cards across every set of the course (Q7): FSRS (srs-model.js) schedules each card;
//            Cards' "Know it" / "Still learning" count as Good / Again. The schedule and the daily streak are
//            kept per student in the course on askeden.com (GET/POST …/reviews), and in this browser.

import { el, ico, toast } from './util.js';
import { t as tr, replyLanguageNote } from './i18n.js';
import { api, getJSON, postJSON } from './api.js';
import { review as srsReview, preview as srsPreview, dueToday, cardKey, mergeStates, bumpStreak, streakNow, dayKey } from './srs-model.js';
import { splitFigure } from './figures.js';
import { pageSpeech, readAloud, announce } from './edu-a11y.js';
import { voiceBtn, pickSpoken, LETTERS } from './voice-answer.js';

const BASE = '/api/chat/courses';
let panel = null;
let state = { course: null, tab: 'sets', set: null, source: null };
let keyHandler = null;
let opener = null; // what had focus before the companion opened: it gets it back on close
let reading = null; // stop() while a page is read aloud
const stopReading = () => { if (reading) { const r = reading; reading = null; r(); } };

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
  if (!companionOpen()) opener = document.activeElement;
  document.body.classList.add('companion-open');
  panel.setAttribute('aria-hidden', 'false');
  panel.inert = false;
  if (!panel.dataset.esc) { // Esc closes it, from anywhere inside
    panel.dataset.esc = '1';
    panel.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !e.defaultPrevented) { e.preventDefault(); closeCompanion(); } });
  }
  dispatchEvent(new CustomEvent('eden:companion-opened')); // edu-app.js: one panel on the right at a time
  paint();
  // a screen reader follows: focus moves into the panel (its title), unless it's already there
  if (!panel.contains(document.activeElement)) { const t = panel.querySelector('.stu-title'); if (t) t.focus({ preventScroll: true }); }
  return true;
}

export function closeCompanion() {
  const had = panel && panel.contains(document.activeElement);
  document.body.classList.remove('companion-open');
  if (panel) { panel.setAttribute('aria-hidden', 'true'); panel.inert = true; }
  setKeys(null);
  stopReading();
  const back = opener;
  opener = null;
  if (had && back && back.isConnected && back !== document.body) back.focus({ preventScroll: true });
}
export const companionOpen = () => document.body.classList.contains('companion-open');
export const companionCourse = () => state.course;

function setKeys(fn) {
  if (keyHandler) removeEventListener('keydown', keyHandler);
  keyHandler = fn;
  if (fn) addEventListener('keydown', fn);
}

const TABS = [['sets', 'Sets'], ['review', 'Review'], ['cards', 'Cards'], ['learn', 'Learn'], ['test', 'Test'], ['match', 'Match'], ['source', 'Source']];

function paint() {
  const c = state.course;
  stopReading();
  const tabFocus = panel.contains(document.activeElement) && document.activeElement.getAttribute('role') === 'tab';
  const head = el('div', 'stu-head',
    el('div', { class: 'stu-title', role: 'heading', 'aria-level': '2', tabindex: '-1' }, el('b', '', 'Study'), el('span', { class: 'muted', 'data-no-i18n': '' }, c.name)),
    el('button', { type: 'button', class: 'iconbtn', 'aria-label': 'Close the study companion', title: 'Close', onclick: closeCompanion }, ico('x')));
  const needsSet = ['cards', 'learn', 'test', 'match'];
  // tabs as a screen reader expects them: arrow keys, Home and End move between them
  const tabs = el('div', { class: 'stu-tabs', role: 'tablist', 'aria-label': 'Study modes', onkeydown: (e) => {
    const list = [...e.currentTarget.querySelectorAll('[role="tab"]:not([disabled])')];
    const at = list.indexOf(document.activeElement);
    const to = e.key === 'ArrowRight' ? at + 1 : e.key === 'ArrowLeft' ? at - 1 : e.key === 'Home' ? 0 : e.key === 'End' ? list.length - 1 : null;
    if (to === null || at < 0) return;
    e.preventDefault();
    e.stopPropagation(); // not the cards' arrow keys
    list[(to + list.length) % list.length].click();
  } }, ...TABS.map(([k, t]) => el('button', {
    type: 'button', role: 'tab', id: `stuTab-${k}`, 'aria-controls': 'stuBody', class: k === state.tab ? 'on' : '', 'aria-selected': String(k === state.tab),
    tabindex: k === state.tab ? '0' : '-1',
    disabled: needsSet.includes(k) && !state.set ? true : null, onclick: () => { state.tab = k; paint(); },
  }, t)));
  const body = el('div', { class: 'stu-body', id: 'stuBody', role: 'tabpanel', 'aria-labelledby': `stuTab-${state.tab}` });
  panel.replaceChildren(head, tabs, body);
  if (tabFocus) { const on = panel.querySelector('[role="tab"][aria-selected="true"]'); if (on) on.focus(); }
  setKeys(null);
  if (state.tab === 'sets' || (needsSet.includes(state.tab) && !state.set)) sets(body);
  else if (state.tab === 'cards') cards(body);
  else if (state.tab === 'learn') learn(body);
  else if (state.tab === 'test') test(body);
  else if (state.tab === 'match') match(body);
  else if (state.tab === 'review') reviewTab(body);
  else source(body);
}

const setHead = () => el('div', 'stu-sethead', el('b', { 'data-no-i18n': '' }, state.set.title), el('span', 'muted', `${state.set.cards.length} cards`));
const srcChip = (card) => (card.doc && card.at ? el('button', { type: 'button', class: 'stu-src', title: 'Open the source', onclick: (e) => { e.stopPropagation(); showSource({ doc: card.doc, loc: card.at }); } }, shield(), el('span', { 'data-no-i18n': '' }, `${card.file} · ${card.at}`)) : card.file ? el('span', 'stu-src', shield(), el('span', { 'data-no-i18n': '' }, `${card.file} · ${card.at}`)) : null);

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
  const today = el('div', 'stu-today');
  body.replaceChildren(
    el('div', 'stu-hero', el('b', '', 'Flashcards from your course'), el('span', 'muted', 'Every card comes from a slide or page, and Eden checks the quote is really there.')),
    today, form, status, list);
  reviewSummary(c).then(({ due, streak }) => today.replaceChildren(el('button', { type: 'button', class: `stu-review-go${due ? ' due' : ''}`, onclick: () => { state.tab = 'review'; paint(); } },
    ico('cal', 14), el('b', '', due ? `Review today (${due} due)` : 'Review today: all caught up'), streakChip(streak)))).catch(() => {});
  let shared = [];
  try { shared = (await getJSON(`${BASE}/${c.id}/sets`)).sets; } catch { /* offline: just this browser's */ }
  const mine = load(mineKey(c.id), []);
  const row = (s, { own, sharedSet }) => el('div', 'stu-set',
    el('button', { type: 'button', class: 'stu-set-open', onclick: () => { state.set = s; state.tab = 'cards'; paint(); } },
      el('b', { 'data-no-i18n': '' }, s.title), el('span', 'muted', `${s.cards.length} cards${sharedSet ? ' · from your professor' : ''}`)),
    staff && own ? el('button', { type: 'button', class: 'btn', title: 'Share with the class', onclick: async () => {
      try { await postJSON(`${BASE}/${c.id}/sets`, { title: s.title, cards: s.cards }); toast('Shared with the class'); sets(body); } catch (e) { toast(e.message); }
    } }, 'Share') : null,
    (own || (staff && sharedSet)) ? el('button', { type: 'button', class: 'iconbtn', 'aria-label': `${tr('Delete')} ${s.title}`, onclick: async () => {
      if (!confirm(`Delete “${s.title}”?`)) return;
      if (own) { save(mineKey(c.id), load(mineKey(c.id), []).filter((x) => x.id !== s.id)); dropSchedule(c, s.id); }
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
  // English, then French ("fais-moi des fiches sur…", "interroge-moi", "teste-moi", "un test blanc")
  const m = /\b(flash ?cards?|study set|quizlet|learn mode|match(?:ing)? game|practice test|test me|quiz me)\b/i.exec(t)
    || /(?:^|[\s'’])(fiches? de révision|fiches?(?= (?:sur|à propos|pour réviser)\b)|(?<=(?:fais|faites|crée|créez|génère|générez|prépare|préparez|donne|donnez|faire|créer|générer|préparer)(?:[- ](?:moi|nous))? (?:des |quelques )?)fiches|cartes? mémoire|série de fiches|mode apprentissage|jeu d[’']association|test blanc|interroge[sz]?[- ]moi|teste[sz]?[- ]moi|fais[- ]moi (?:un )?quiz|un quiz)(?=$|[\s?.!,])/i.exec(t);
  if (!m) return null;
  const w = m[1].toLowerCase();
  const tab = /test|quiz|interroge/.test(w) ? 'test' : /learn|apprentissage/.test(w) ? 'learn' : /match|association/.test(w) ? 'match' : 'cards';
  // the topic: what's left once the request words go ("make flashcards about mitosis" → "mitosis")
  const topic = t.replace(m[0], ' ') // word edges are Unicode-aware, so French words like "ça" aren't cut
    .replace(/(?<![\p{L}\p{N}_])(?:(can|could|would|will) you|please|(make|create|give|generate|build|do|start|open)( me| us)?|(some|a|an|the|set of|me|for me|on|about|of|from|it|this|that|these|them|everything|whole course|course|materials?|for))(?![\p{L}\p{N}_])|[?.!,]/giu, ' ')
    .replace(/(?:^|\s)(?:peux|pouvez|pourrais|pourriez)[- ](?:tu|vous)|s’il (?:te|vous) plaît|s'il (?:te|vous) plaît|(?:fais|faites|faire|crée|créez|créer|donne|donnez|génère|générez|prépare|préparez)(?:[- ](?:moi|nous))?|(?:^|\s)(?:me|te|des|de|du|d’|d'|la|le|les|un|une|sur|à propos de|pour moi|tout le cours|cours|ce|cette|ces)(?=\s|$)/gi, ' ')
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
  await api.send({ messages: [{ role: 'user', content: topic ? `Make flashcards on: ${topic}` : 'Make flashcards on this course.' }], course: c.id, courseTask: 'set', topic, ...(replyLanguageNote() ? { system: replyLanguageNote() } : {}), temporary: true, mode: 'chat' }, {
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
  return { id: `m${Date.now().toString(36)}`, title: String((parsed && parsed.title) || topic || tr('Study set')).slice(0, 80), cards: cardsOut, created: Date.now() };
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
    const focusK = view.contains(document.activeElement) ? document.activeElement.dataset.k : null; // the same control keeps focus after the redraw
    const face = el('button', { type: 'button', 'data-k': 'face', class: `stu-card${flipped ? ' flipped' : ''}`, 'aria-label': flipped ? `Definition: ${card.def}` : `Term: ${card.term}. Press Space to flip.`, onclick: () => { flipped = !flipped; draw(); } },
      el('span', 'stu-card-inner',
        el('span', 'stu-face front', el('span', 'stu-face-label', 'Term'), el('span', { class: 'stu-face-text', 'data-no-i18n': '' }, card.term)),
        el('span', 'stu-face back', el('span', 'stu-face-label', 'Definition'), el('span', { class: 'stu-face-text sm', 'data-no-i18n': '' }, card.def), srcChip(card))));
    const knownN = prog.known.length;
    view.replaceChildren(setHead(),
      el('div', { class: 'stu-prog', 'aria-hidden': 'true' }, el('i', { style: { width: `${Math.round((knownN / set.cards.length) * 100)}%` } })),
      el('div', 'stu-meta', el('span', 'muted', el('span', 'sr-only', 'Card '), `${i + 1} / ${order.length}`), el('span', 'muted', `${knownN} known`),
        el('button', { type: 'button', 'data-k': 'star', class: `iconbtn${star ? ' on' : ''}`, 'aria-pressed': String(star), 'aria-label': 'Star this card', title: 'Star', onclick: () => { toggle(prog.star, k); save(progKey(state.course.id, set.id), prog); draw(); } }, ico('pin', 14))),
      face,
      el('div', 'stu-row',
        el('button', { type: 'button', 'data-k': 'prev', class: 'iconbtn', 'aria-label': 'Previous card', onclick: () => go(-1) }, ico('chevl')),
        el('button', { type: 'button', 'data-k': 'still', class: 'btn stu-still', onclick: () => { remove(prog.known, k); save(progKey(state.course.id, set.id), prog); grade(state.course, set, card, 1); go(1); } }, 'Still learning'),
        el('button', { type: 'button', 'data-k': 'know', class: `btn primary${known ? ' done' : ''}`, onclick: () => { if (!known) prog.known.push(k); save(progKey(state.course.id, set.id), prog); grade(state.course, set, card, 3); go(1); } }, ico('check', 13), 'Know it'),
        el('button', { type: 'button', 'data-k': 'next', class: 'iconbtn', 'aria-label': 'Next card', onclick: () => go(1) }, ico('chevr'))),
      el('div', 'stu-row small',
        el('button', { type: 'button', 'data-k': 'shuffle', class: 'stu-link', onclick: () => { order = shuffle(order); i = 0; flipped = false; draw(); announce('Shuffled'); } }, 'Shuffle'),
        el('button', { type: 'button', 'data-k': 'starred', class: 'stu-link', onclick: () => { const s = order.filter((x) => prog.star.includes(x)); if (!s.length) { toast('Star some cards first'); return; } order = s; i = 0; flipped = false; draw(); } }, 'Starred only'),
        el('button', { type: 'button', 'data-k': 'over', class: 'stu-link', onclick: () => { prog.known = []; save(progKey(state.course.id, set.id), prog); order = set.cards.map((_, x) => x); i = 0; draw(); } }, 'Start over')),
      el('p', 'stu-keys muted', 'Space flips · ← → move'));
    if (focusK) { const n = view.querySelector(`[data-k="${focusK}"]`); if (n) n.focus({ preventScroll: true }); }
  };
  // a screen reader hears the new card (the focused card face reads itself)
  const sayCard = () => { if (document.activeElement && document.activeElement.dataset.k === 'face') return; const c = set.cards[order[i]]; announce(flipped ? `Definition: ${c.def}` : `Card ${i + 1} of ${order.length}. ${c.term}`); };
  const go = (d) => { i = (i + d + order.length) % order.length; flipped = false; draw(); sayCard(); };
  body.replaceChildren(view);
  draw();
  setKeys((e) => {
    const a = document.activeElement;
    if (!companionOpen() || state.tab !== 'cards' || e.metaKey || e.ctrlKey || e.altKey || /INPUT|TEXTAREA|SELECT/.test(a && a.tagName)) return;
    if (a && a !== document.body && !panel.contains(a)) return; // keys elsewhere on the page are theirs
    const onCard = a && a.dataset && a.dataset.k === 'face';
    if (e.key === ' ') { if (a && /^(BUTTON|A)$/.test(a.tagName) && !onCard) return; e.preventDefault(); flipped = !flipped; draw(); sayCard(); } // Space on a button presses that button
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
  let first = true; // after the first question, focus moves to each new one (a screen reader reads it)
  const view = el('div', 'stu-learn');
  body.replaceChildren(view);
  const next = () => {
    const left = [...right.keys()].filter((k) => right[k] < 2);
    if (!left.length) {
      view.replaceChildren(setHead(), el('div', 'stu-done', el('b', { tabindex: '-1', class: 'stu-focus' }, 'You’ve learned this set'), el('span', 'muted', `All ${n} cards, each right twice.`),
        el('div', 'stu-row', el('button', { type: 'button', class: 'btn primary', onclick: () => { state.tab = 'test'; paint(); } }, 'Take a test'), el('button', { type: 'button', class: 'btn', onclick: () => learn(body) }, 'Learn again'))));
      view.querySelector('.stu-focus').focus();
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
      const btns = choices.map((t, ci) => el('button', { type: 'button', class: 'stu-choice', onclick: () => {
        if (btns[0].disabled) return;
        btns.forEach((b) => { b.disabled = true; if (b.dataset.v === card.def) b.classList.add('right'); });
        if (t !== card.def) btns.find((b) => b.dataset.v === t).classList.add('wrong');
        after(t === card.def, card.def);
      } }, el('span', 'stu-letter', LETTERS[ci]), el('span', { 'data-no-i18n': '' }, t)));
      btns.forEach((b, x) => { b.dataset.v = choices[x]; });
      const q = el('div', { class: 'stu-q', tabindex: '-1' }, el('span', 'stu-face-label', 'Term'), el('b', { 'data-no-i18n': '' }, card.term));
      view.replaceChildren(...head, q, el('div', { class: 'stu-choices', role: 'group', 'aria-label': 'Choose the definition' }, ...btns),
        voiceBtn('Answer by voice', (heard) => pickSpoken(heard, choices, (ci) => btns[ci].click())), feedback);
      if (!first) q.focus();
    } else { // write the term
      const input = el('input', { class: 'stu-in', placeholder: 'Type the term', 'aria-label': 'Your answer: the term', 'aria-describedby': 'stuLearnQ', autocomplete: 'off' });
      const form = el('form', { class: 'stu-write', onsubmit: (e) => { e.preventDefault(); if (input.disabled) return; input.disabled = true; after(closeEnough(input.value, card.term), card.term); } },
        input, el('button', { type: 'submit', class: 'btn primary' }, 'Check'));
      view.replaceChildren(...head, el('div', { class: 'stu-q', id: 'stuLearnQ' }, el('span', 'stu-face-label', 'Definition'), el('span', { 'data-no-i18n': '' }, card.def)), form,
        voiceBtn('Say the term', (heard) => { input.value = heard; form.requestSubmit(); }),
        el('button', { type: 'button', class: 'stu-link', onclick: () => { input.disabled = true; after(false, card.term); } }, 'I don’t know'), feedback);
      input.focus();
    }
    first = false;
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
      el('div', 'stu-done', el('div', { class: 'crs-ring', style: { '--p': `${Math.round((score / qs.length) * 100)}%` }, 'aria-hidden': 'true' }, el('b', '', `${score}/${qs.length}`)),
        el('b', { tabindex: '-1', class: 'stu-focus' }, el('span', 'sr-only', `You scored ${score} out of ${qs.length}. `), score === qs.length ? 'Perfect' : score / qs.length >= 0.7 ? 'Nice work' : 'Keep going')),
      el('div', 'stu-h', 'Review'),
      ...qs.map((q, x) => el('div', `stu-review ${results[x] ? 'ok' : 'no'}`,
        el('b', { 'data-no-i18n': '' }, q.kind === 'write' ? q.prompt : set.cards[q.k].term),
        el('span', '', results[x] ? 'Correct' : `Answer: ${q.kind === 'tf' ? `${q.want} — ${set.cards[q.k].def}` : q.want}${answers[x] ? ` · you said: ${answers[x]}` : ''}`),
        srcChip(set.cards[q.k]))),
      el('div', 'stu-row', el('button', { type: 'button', class: 'btn primary', onclick: () => test(body) }, 'New test'), el('button', { type: 'button', class: 'btn', onclick: () => { state.tab = 'learn'; paint(); } }, 'Learn the misses')));
    body.querySelector('.stu-focus').focus();
  } });
  qs.forEach((q, x) => {
    const n = el('span', 'stu-qn', String(x + 1));
    let input, voice;
    // each question's group is named by its own words, so a screen reader reads the question with it
    const ids = `stuTq${x}L stuTq${x}P${q.kind === 'tf' ? ` stuTq${x}S` : ''}`;
    if (q.kind === 'write') {
      input = el('input', { class: 'stu-in', placeholder: 'Type the term', 'aria-labelledby': ids, autocomplete: 'off', oninput: (e) => { answers[x] = e.target.value; } });
      voice = voiceBtn('Say the term', (heard) => { input.value = heard; answers[x] = heard; announce(`Answer ${x + 1}: ${heard}`); });
    } else {
      const opts = q.kind === 'tf' ? ['True', 'False'] : q.choices;
      const radios = opts.map((o) => el('input', { type: 'radio', name: `q${x}`, value: o, onchange: () => { answers[x] = o; } }));
      input = el('div', { class: 'stu-opts', role: 'radiogroup', 'aria-labelledby': ids }, ...opts.map((o, oi) => el('label', 'stu-opt',
        radios[oi], q.kind === 'tf' ? null : el('span', 'stu-letter', LETTERS[oi]), el('span', q.kind === 'tf' ? '' : { 'data-no-i18n': '' }, o)))); // True/False are the page's; a choice is the card's
      voice = voiceBtn('Answer by voice', (heard) => pickSpoken(heard, opts, (oi) => { radios[oi].checked = true; answers[x] = opts[oi]; announce(`Answer ${x + 1}: ${q.kind === 'tf' ? '' : `${LETTERS[oi]}, `}${opts[oi]}`); }));
    }
    form.append(el('div', 'stu-tq', n, el('div', 'stu-tq-body',
      el('span', { class: 'stu-face-label', id: `stuTq${x}L` }, `Question ${x + 1}: `, q.kind === 'write' ? 'Definition → term' : q.kind === 'tf' ? 'True or false' : 'Choose the definition'),
      el('b', { id: `stuTq${x}P`, 'data-no-i18n': '' }, q.prompt), q.kind === 'tf' ? el('span', { class: 'stu-shown', id: `stuTq${x}S`, 'data-no-i18n': '' }, q.shown) : null, input, voice)));
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
  const timed = load('edu:match-timed', true) !== false; // untimed: the same game at your own pace (screen readers, voice control)
  let picked = null, left = pairs.length, start = 0, timer = 0, misses = 0;
  const clock = el('b', { class: 'stu-clock', 'aria-hidden': 'true' }, timed ? '0.0s' : '');
  const grid = el('div', { class: 'stu-match', role: 'group', 'aria-label': 'Terms and definitions' });
  const side = (t) => (t.side === 't' ? 'Term' : 'Definition');
  const btns = tiles.map((t) => el('button', { type: 'button', class: 'stu-tile', 'aria-pressed': 'false', onclick: () => {
    if (timed && !start) { start = performance.now(); timer = setInterval(() => { clock.textContent = `${((performance.now() - start) / 1000).toFixed(1)}s`; }, 100); }
    if (!start) start = performance.now();
    const b = btns[tiles.indexOf(t)];
    if (picked === null) { picked = t; b.classList.add('sel'); b.setAttribute('aria-pressed', 'true'); announce(`${side(t)} picked. Now choose its ${t.side === 't' ? 'definition' : 'term'}.`); return; }
    const a = btns[tiles.indexOf(picked)];
    if (picked === t) { a.classList.remove('sel'); a.setAttribute('aria-pressed', 'false'); picked = null; announce('Unpicked'); return; }
    if (picked.k === t.k && picked.side !== t.side) {
      a.classList.add('gone'); b.classList.add('gone'); a.disabled = b.disabled = true; left--;
      a.setAttribute('aria-hidden', 'true'); b.setAttribute('aria-hidden', 'true');
      if (!left) {
        clearInterval(timer);
        const secs = (performance.now() - start) / 1000;
        if (timed && (!best || secs < best)) save(`edu:match:${state.course.id}:${set.id}`, secs);
        const done = el('div', 'stu-done', el('b', { tabindex: '-1', class: 'stu-focus' }, timed ? `Matched in ${secs.toFixed(1)}s` : 'All matched'),
          el('span', 'muted', timed ? (best && secs >= best ? `Your best: ${best.toFixed(1)}s` : 'Your best time') : `${misses} wrong ${misses === 1 ? 'try' : 'tries'}`),
          el('button', { type: 'button', class: 'btn primary', onclick: () => match(body) }, 'Play again'));
        grid.replaceWith(done);
        done.querySelector('.stu-focus').focus();
      } else {
        announce(`Matched. ${left} pair${left === 1 ? '' : 's'} left.`);
        const next = btns.find((x) => !x.disabled); // focus was on a tile that's gone
        if (next && (document.activeElement === a || document.activeElement === b || document.activeElement === document.body)) next.focus();
      }
    } else { misses++; announce('Not a match. Try again.'); a.setAttribute('aria-pressed', 'false'); a.classList.add('wrong'); b.classList.add('wrong'); setTimeout(() => { a.classList.remove('wrong', 'sel'); b.classList.remove('wrong'); }, 450); }
    picked = null;
  } }, el('span', 'sr-only', `${side(t)}: `), el('span', { 'data-no-i18n': '' }, t.text)));
  grid.append(...btns);
  const toggle = el('label', 'stu-timed', el('input', { type: 'checkbox', checked: timed ? true : null, onchange: (e) => { save('edu:match-timed', e.target.checked); clearInterval(timer); match(body); } }), 'Timer');
  body.replaceChildren(setHead(), el('div', 'stu-meta', el('span', 'muted', 'Match each term with its definition'), el('span', 'stu-meta-r', toggle, clock)), grid);
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
  // the page's own text, and what its figures show (described by Eden's AI when it was added, Q6); the quote highlighted in either
  const { text: own, figure } = splitFigure(p.text);
  const marked = (t) => {
    const at = s.quote ? t.toLowerCase().indexOf(String(s.quote).toLowerCase()) : -1;
    return at >= 0 ? [t.slice(0, at), el('mark', '', t.slice(at, at + s.quote.length)), t.slice(at + s.quote.length)] : [t];
  };
  const text = el('div', { class: 'stu-page-text', 'data-no-i18n': '' }, ...marked(own));
  const fig = figure ? el('section', { class: 'stu-figure', 'aria-labelledby': 'stuFigH' },
    el('div', { class: 'stu-figure-h', id: 'stuFigH', role: 'heading', 'aria-level': '4' }, ico('art', 12), 'Figure description'),
    el('div', { class: 'stu-page-text', 'data-no-i18n': '' }, ...marked(figure)),
    el('span', 'muted stu-figure-note', 'Written by Eden’s AI from the picture on this page')) : null;
  const readBtn = el('button', { type: 'button', class: 'btn', 'aria-pressed': 'false', onclick: () => {
    if (reading) { stopReading(); return; }
    readBtn.setAttribute('aria-pressed', 'true');
    readBtn.lastChild.textContent = 'Stop reading';
    reading = readAloud(pageSpeech(p), { onend: () => { reading = null; if (readBtn.isConnected) { readBtn.setAttribute('aria-pressed', 'false'); readBtn.lastChild.textContent = 'Read this page aloud'; } } });
  } }, ico('speaker', 13), el('span', '', 'Read this page aloud'));
  body.replaceChildren(
    el('div', 'stu-page', el('div', 'stu-page-head', el('span', { class: `crs-ext ${p.kind}`, 'aria-hidden': 'true' }, p.kind === 'slides' ? 'PPT' : p.kind === 'doc' ? 'DOC' : p.kind === 'pdf' ? 'PDF' : p.kind === 'epub' ? 'EPUB' : 'TXT'),
      el('div', { class: 'grow', role: 'heading', 'aria-level': '3' }, el('b', { 'data-no-i18n': '' }, p.name), el('span', 'muted', el('span', 'sr-only', ', '), p.loc))), text, fig),
    el('div', 'stu-row', readBtn, el('button', { type: 'button', class: 'btn primary', onclick: () => dispatchEvent(new CustomEvent('eden:course-chat', { detail: { course: state.course, prompt: tr(`Explain ${p.loc} of “${p.name}” step by step, then ask me a question to check I understood.`), focus: { doc: p.doc, loc: p.loc } } })) }, ico('spark', 13), `Explain this ${p.kind === 'slides' ? 'slide' : 'page'}`),
      el('button', { type: 'button', class: 'btn', onclick: (e) => dispatchEvent(new CustomEvent('eden:clip', { detail: { course: state.course, anchor: e.currentTarget, title: `${p.name} · ${p.loc}`, body: `${p.text}\n\n**${tr('Source:')}** ${p.name} · ${p.loc}` } })) }, ico('pin', 13), 'Clip this page')));
}

/* ---------- review: spaced repetition across the course's sets (Q7) ---------- */

const srsKey = (id) => `edu:srs:${id}`;
let srs = { course: null, states: {}, streak: null, dirty: [] };

/** This student's schedule for the course: this browser's copy, merged with askeden.com's (the later review of each card wins). */
async function loadSchedule(c) {
  if (srs.course !== c.id) srs = { course: c.id, ...load(srsKey(c.id), { states: {}, streak: null, dirty: [] }) };
  try {
    const remote = await getJSON(`${BASE}/${c.id}/reviews`);
    for (const [set, cards] of Object.entries(remote.sets || {})) srs.states[set] = mergeStates(srs.states[set], cards);
    if (remote.streak && (!srs.streak || remote.streak.last >= srs.streak.last)) srs.streak = remote.streak;
    // reviews made offline go up now
    const dirty = srs.dirty.splice(0);
    for (const set of dirty) postJSON(`${BASE}/${c.id}/reviews`, { set, cards: srs.states[set] || {}, day: srs.streak && srs.streak.last }).catch(() => { if (!srs.dirty.includes(set)) srs.dirty.push(set); });
  } catch { /* offline, or not on askeden.com: this browser's copy */ }
  save(srsKey(c.id), { states: srs.states, streak: srs.streak, dirty: srs.dirty });
  return srs;
}

/** One review: the card's next date, the streak, kept here and sent to askeden.com. */
function grade(c, set, card, g) {
  if (srs.course !== c.id) srs = { course: c.id, ...load(srsKey(c.id), { states: {}, streak: null, dirty: [] }) };
  const key = cardKey(card);
  const states = srs.states[set.id] || (srs.states[set.id] = {});
  states[key] = srsReview(states[key], g);
  const day = dayKey();
  srs.streak = bumpStreak(srs.streak, day);
  save(srsKey(c.id), { states: srs.states, streak: srs.streak, dirty: srs.dirty });
  postJSON(`${BASE}/${c.id}/reviews`, { set: set.id, cards: { [key]: states[key] }, day })
    .then((r) => { if (r && r.streak && r.streak.count > ((srs.streak && srs.streak.count) || 0)) srs.streak = r.streak; })
    .catch(() => { if (!srs.dirty.includes(set.id)) { srs.dirty.push(set.id); save(srsKey(c.id), { states: srs.states, streak: srs.streak, dirty: srs.dirty }); } });
  return states[key];
}

function dropSchedule(c, setId) {
  if (srs.course === c.id) { delete srs.states[setId]; save(srsKey(c.id), { states: srs.states, streak: srs.streak, dirty: srs.dirty.filter((x) => x !== setId) }); }
  postJSON(`${BASE}/${c.id}/reviews/${encodeURIComponent(setId)}/delete`, {}).catch(() => {});
}

/** Every set of the course this browser can study: the class's and this browser's own. */
async function allSets(c) {
  let shared = [];
  try { shared = (await getJSON(`${BASE}/${c.id}/sets`)).sets || []; } catch { /* paused or offline */ }
  return [...shared, ...load(mineKey(c.id), [])];
}

/** How many cards are due today across the course's sets, and the streak (for "Review today (N due)"). */
export async function reviewSummary(c) {
  const [sets] = await Promise.all([allSets(c), loadSchedule(c)]);
  return { due: dueToday(sets, srs.states).length, streak: streakNow(srs.streak, dayKey()), best: (srs.streak && srs.streak.best) || 0 };
}

const streakChip = (n) => (n ? el('span', { class: 'stu-streak', title: `${n} day${n === 1 ? '' : 's'} in a row` }, ico('spark', 12), `${n}-day streak`) : null);

async function reviewTab(body) {
  const c = state.course;
  body.replaceChildren(el('div', 'muted', 'Loading…'));
  const [sets] = await Promise.all([allSets(c), loadSchedule(c)]);
  if (state.tab !== 'review') return;
  let queue = dueToday(sets, srs.states);
  const total = queue.length;
  let done = 0, shown = false;
  const view = el('div', 'stu-cards stu-review');
  body.replaceChildren(view);
  const draw = () => {
    const streak = streakNow(srs.streak, dayKey());
    if (!queue.length) {
      view.replaceChildren(el('div', 'stu-done',
        el('b', '', total ? 'Today’s review is done' : 'Nothing to review today'),
        el('span', 'muted', total ? `${done} card${done === 1 ? '' : 's'} reviewed. They’ll come back when you’re about to forget them.` : sets.length ? 'Cards come back here on the day they’re due.' : 'Make a set first; its cards then come back here when they’re due.'),
        streakChip(streak),
        el('div', 'stu-row', el('button', { type: 'button', class: 'btn', onclick: () => { state.tab = 'sets'; paint(); } }, 'Back to sets'))));
      return;
    }
    const { set, card, state: st } = queue[0];
    const face = el('button', { type: 'button', class: `stu-card${shown ? ' flipped' : ''}`, 'aria-label': shown ? `Answer: ${card.def}` : `Term: ${card.term}. Press to show the answer.`, onclick: () => { shown = !shown; draw(); } },
      el('span', 'stu-card-inner',
        el('span', 'stu-face front', el('span', 'stu-face-label', st ? 'Term' : 'New card'), el('span', { class: 'stu-face-text', 'data-no-i18n': '' }, card.term)),
        el('span', 'stu-face back', el('span', 'stu-face-label', 'Definition'), el('span', { class: 'stu-face-text sm', 'data-no-i18n': '' }, card.def), srcChip(card))));
    const acts = shown
      ? el('div', { class: 'stu-grades', role: 'group', 'aria-label': 'How well did you know it?' }, ...srsPreview(st).map((p) => el('button', { type: 'button', class: `btn stu-grade g${p.g}`, onclick: () => answer(p.g) },
        el('b', '', p.label), el('span', 'muted', p.text))))
      : el('div', 'stu-row', el('button', { type: 'button', class: 'btn primary', onclick: () => { shown = true; draw(); } }, 'Show answer'));
    view.replaceChildren(
      el('div', 'stu-sethead', el('b', '', 'Review today'), el('span', { class: 'muted', 'data-no-i18n': '' }, set.title)),
      el('div', 'stu-prog', el('i', { style: { width: `${Math.round((done / Math.max(1, total)) * 100)}%` } })),
      el('div', 'stu-meta', el('span', 'muted', `${queue.length} left`), streakChip(streak)),
      face, acts,
      el('p', 'stu-keys muted', 'Space shows the answer · 1 Again · 2 Hard · 3 Good · 4 Easy'));
  };
  const answer = (g) => {
    const { set, card } = queue.shift();
    const next = grade(c, set, card, g);
    if (g === 1) queue.push({ set, card, key: cardKey(card), state: next }); // again, later in this session
    else done++;
    shown = false;
    draw();
  };
  draw();
  setKeys((e) => {
    if (!companionOpen() || state.tab !== 'review' || !queue.length || /INPUT|TEXTAREA/.test(document.activeElement && document.activeElement.tagName)) return;
    if (e.key === ' ') { e.preventDefault(); shown = !shown; draw(); }
    else if (shown && /^[1-4]$/.test(e.key)) answer(Number(e.key));
  });
}
