// Jarvis spaces through POST /api/chat/jarvis: Second Brain (search_notes → read_note →
// "Use in chat"), Memory (recall), Calendar (7 days), Routines (heads-up via notify_me),
// plus the inspector's Memory tab. Everything Jarvis returns is data: shown as text only.

import { $, el, ico, toast, debounce } from './util.js';
import { state, ui } from './state.js';
import { api } from './api.js';
import { mailPanel } from './mail.js';

let H = {};
const DATA_NOTE = /^\(From the owner's Jarvis:[^)]*\)\s*/;
const strip = (t) => String(t || '').replace(DATA_NOTE, '').trim();

export function parseNotes(text) {
  const t = strip(text);
  if (!t || /^Nothing in the second brain/i.test(t)) return [];
  return t.split(/\n\s*\n/).map((block) => {
    const [first, ...rest] = block.split('\n');
    const m = /^\[([^\]]+)\]\s+(.*?)(?:\s+\(([^()]*)\))?\s*$/.exec(first.trim());
    return m ? { id: m[1], title: m[2], meta: m[3] || '', excerpt: rest.join('\n').trim() } : { id: null, title: first.trim().slice(0, 80), meta: '', excerpt: rest.join('\n').trim() };
  }).filter((n) => n.title);
}
export function parseRecall(text) {
  const t = strip(text);
  if (!t || /^Nothing remembered/i.test(t)) return [];
  return t.split('\n').map((l) => l.replace(/^\s*-\s*/, '').trim()).filter(Boolean);
}
export function parseCalendar(text) {
  const t = strip(text);
  if (!t || /^Nothing on the calendar/i.test(t)) return [];
  const days = [];
  for (const line of t.split('\n')) {
    const m = /^\s*-\s*(\w{3} \d{1,2} \w{3})\s*(\(all day\)|\d{1,2}:\d{2}[–-]\d{1,2}:\d{2})?:\s*(.*?)(?:\s+\[([^\]]*)\])?\s*$/.exec(line);
    if (!m) { if (line.trim()) days.push({ day: '', events: [{ time: '', title: line.replace(/^\s*-\s*/, ''), cal: '' }] }); continue; }
    let d = days.find((x) => x.day === m[1]);
    if (!d) { d = { day: m[1], events: [] }; days.push(d); }
    d.events.push({ time: m[2] === '(all day)' ? 'all day' : (m[2] || ''), title: m[3], cal: m[4] || '' });
  }
  return days;
}

async function call(tool, args) {
  const r = await api.jarvis(tool, args);
  if (r.is_error) throw new Error(strip(r.text) || 'The Jarvis app said no.');
  return r.text || '';
}

export async function searchNotes(q) { return parseNotes(await call('search_notes', { query: q })); }

export async function checkJarvis() {
  try {
    const s = await api.jarvisStatus();
    state.jarvis = { available: !!s.available, reason: s.reason || null };
  } catch (e) {
    state.jarvis = { available: false, reason: e.message };
  }
  const box = $('jarvisState');
  box.classList.toggle('on', state.jarvis.available);
  $('jarvisStateText').textContent = state.jarvis.available ? 'connected' : 'not connected';
  box.title = state.jarvis.available ? 'Connected through the Jarvis app on your Mac: second brain, memory, calendar' : (state.jarvis.reason || 'The Jarvis app on your Mac isn’t reachable');
  return state.jarvis;
}

/* ---------- the space panel ---------- */
const SPACES = {
  brain: { t: 'Second Brain', i: 'search' },
  memory: { t: 'Memory', i: 'bulb' },
  cal: { t: 'Calendar', i: 'cal' }, // its own surface now (calendar.js): calendar() hands over to it
  routines: { t: 'Routines', i: 'routine' },
  mail: { t: 'Mail', i: 'mail' },
};
let openKey = null;
let returnFocus = null;

export function openSpace(key, opts = {}) {
  const s = SPACES[key];
  if (!s) return;
  openKey = key;
  returnFocus = document.activeElement;
  $('spTitle').textContent = s.t;
  $('spIco').firstElementChild.setAttribute('href', `#i-${s.i}`);
  $('spacePanel').classList.add('open');
  $('spacePanel').classList.toggle('wide', key === 'mail');
  const body = $('spBody');
  body.replaceChildren();
  if (key === 'mail') { mailPanel(body).then(focusFirst); return; }
  if (!state.jarvis.available && key !== 'routines') { body.append(unavailable(key)); focusFirst(); return; }
  if (key === 'brain') brain(body, opts.query || '');
  else if (key === 'memory') memory(body);
  else if (key === 'cal') calendar(body);
  else routines(body);
  focusFirst();
}
function focusFirst() { requestAnimationFrame(() => { const f = $('spBody').querySelector('input, button, textarea') || $('btnSpClose'); f.focus(); }); }
export function closeSpace() {
  if (!$('spacePanel').classList.contains('open')) return false;
  // A click outside closes the panel on pointerdown, and that click places focus itself (in
  // the composer, say): handing focus back to what had it before the panel opened stole it,
  // so the next Enter pressed that button ("Toggle inspector"). Only Esc, the close button
  // and the panel's own actions hand focus back.
  const byPointer = !!(window.event && window.event.type === 'pointerdown');
  $('spacePanel').classList.remove('open');
  openKey = null;
  const back = returnFocus;
  returnFocus = null;
  if (!byPointer && back && back !== document.body && document.contains(back)) back.focus();
  return true;
}
export const spaceOpen = () => $('spacePanel').classList.contains('open');

function unavailable(key) {
  return el('div', '', el('div', 'sp-warn', el('b', '', 'Your Mac isn’t connected'), state.jarvis.reason || 'The Jarvis app didn’t answer.'),
    el('p', 'sp-note', 'This data comes through the Jarvis app on your Mac: open it to connect. The first time, it asks you on screen whether Eden may use your second brain, memory and calendar.'),
    el('div', 'dlg-acts', el('button', { type: 'button', class: 'btn primary', onclick: async () => { await checkJarvis(); openSpace(key); } }, 'Try again')));
}

function loading(box, text = 'Asking your Mac…') { box.replaceChildren(el('div', 'muted', text)); }
function failed(box, e) { box.replaceChildren(el('div', 'sp-warn', el('b', '', 'That didn’t work'), e.message)); }

function brain(body, query) {
  const q = el('input', { class: 'sp-search', type: 'search', placeholder: 'Search your notes, documents, past research…', 'aria-label': 'Search your second brain' });
  q.value = query;
  const res = el('div', { 'aria-live': 'polite' });
  const run = async () => {
    const v = q.value.trim();
    if (!v) { res.replaceChildren(el('div', 'muted', 'Type to search. Notes stay on your Mac; what you use goes with your next message.')); return; }
    loading(res);
    try {
      const notes = await searchNotes(v);
      if (!notes.length) { res.replaceChildren(el('div', 'muted', 'Nothing in the second brain matches that.')); return; }
      res.replaceChildren(...notes.map((n) => noteRow(n)));
    } catch (e) { failed(res, e); }
  };
  const deb = debounce(run, 400);
  q.addEventListener('input', deb);
  q.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); deb.cancel(); run(); } });
  body.append(q, res);
  run();
}

function noteRow(n) {
  const full = el('div', 'note-full');
  full.hidden = true;
  let text = null;
  const read = async () => {
    if (!n.id) return n.excerpt;
    if (text !== null) return text;
    text = strip(await call('read_note', { id: n.id }));
    return text;
  };
  const row = el('div', 'sb-res',
    el('b', '', n.title), n.meta ? el('span', 'm', n.meta) : null, n.excerpt ? el('p', '', n.excerpt) : null,
    el('div', 'acts',
      n.id ? el('button', { type: 'button', class: 'cap', onclick: async (e) => {
        const b = e.currentTarget;
        if (!full.hidden) { full.hidden = true; b.textContent = 'Read'; return; }
        b.textContent = 'Reading…';
        try { full.textContent = await read(); full.hidden = false; b.textContent = 'Hide'; } catch (err) { b.textContent = 'Read'; toast(err.message); }
      } }, 'Read') : null,
      el('button', { type: 'button', class: 'cap primary', onclick: async () => {
        try { const t = await read(); H.addContext({ title: `Note: ${n.title}`, text: t || n.excerpt }); } catch (err) { toast(err.message); }
      } }, 'Use in chat')),
    full);
  return row;
}
export async function attachNote(n) {
  try {
    const t = n.id ? strip(await call('read_note', { id: n.id })) : n.excerpt;
    H.addContext({ title: `Note: ${n.title}`, text: t || n.excerpt });
  } catch (e) { toast(e.message); }
}

function memory(body) {
  const q = el('input', { class: 'sp-search', type: 'search', placeholder: 'Filter what your Mac remembers (empty lists everything)', 'aria-label': 'Filter memory' });
  const res = el('div', { 'aria-live': 'polite' });
  const run = async () => {
    loading(res);
    try {
      const facts = parseRecall(await call('recall', { query: q.value.trim() }));
      if (!facts.length) { res.replaceChildren(el('div', 'muted', 'Nothing remembered about that.')); return; }
      res.replaceChildren(...facts.map((f) => el('div', 'mem-row', el('span', 'mem-txt', f),
        el('button', { type: 'button', class: 'cap', onclick: () => H.addContext({ title: `Memory: ${f.slice(0, 40)}${f.length > 40 ? '…' : ''}`, text: f }) }, 'Use'))));
    } catch (e) { failed(res, e); }
  };
  q.addEventListener('input', debounce(run, 400));
  body.append(q, res, el('p', 'sp-note', 'This is what the Jarvis app on your Mac remembers; change it there. "Use" sends a fact with your next message.'));
  run();
}

async function calendar(body) {
  // The calendar is a surface of its own (calendar.js: month, week, day, agenda; the Mac and
  // Google); this panel only hands over to it.
  loading(body, 'Opening the calendar…');
  try {
    const { openCalendar } = await import('./calendar.js');
    closeSpace();
    openCalendar();
  } catch (e) { failed(body, e); }
}

function routines(body) {
  const ta = el('textarea', { rows: 3, maxlength: 300, placeholder: 'e.g. The report is ready to read.', 'aria-label': 'Heads-up text' });
  const title = el('input', { type: 'text', placeholder: 'Title (optional)', 'aria-label': 'Heads-up title' });
  body.append(
    el('p', 'sp-note', 'Routines (morning brief, digests, the weekly router refresh) run in the Jarvis app on your Mac; set them up there. From here you can send yourself a heads-up through it.'),
    el('div', { class: 'field', style: { marginTop: '12px' } }, 'Heads-up', title, ta),
    el('div', 'dlg-acts', el('button', { type: 'button', class: 'btn primary', onclick: () => notify(ta.value, title.value) }, ico('bell', 14), 'Send heads-up')));
  if (!state.jarvis.available) body.prepend(el('div', 'sp-warn', el('b', '', 'Your Mac isn’t connected'), `${state.jarvis.reason || ''} Open the Jarvis app on your Mac to connect.`));
}

export async function notify(text, title) {
  const t = String(text || '').trim();
  if (!t) { toast('Write the heads-up first'); return; }
  try { await call('notify_me', { text: t.slice(0, 300), ...(title && title.trim() ? { title: title.trim() } : {}) }); toast('Heads-up sent to your Mac'); closeSpace(); }
  catch (e) { toast(`Couldn’t send: ${e.message}`); }
}

/* ---------- inspector: Memory tab ---------- */
let memLoaded = false;
export async function renderMemoryTab(force) {
  const card = $('memCard');
  if (!state.jarvis.available) { card.replaceChildren(el('div', 'muted', `${state.jarvis.reason || 'Your Mac isn’t connected.'} Open the Jarvis app on your Mac to connect.`)); return; }
  if (memLoaded && !force) return;
  memLoaded = true;
  card.replaceChildren(el('div', 'muted', 'Asking your Mac…'));
  try {
    const facts = parseRecall(await call('recall', { query: $('memQ').value.trim() }));
    if (!facts.length) { card.replaceChildren(el('div', 'muted', 'Nothing remembered about that.')); return; }
    card.replaceChildren(...facts.map((f) => el('div', 'mem-row', el('span', 'mem-txt', f),
      el('button', { type: 'button', class: 'iconbtn', style: { width: '24px', height: '24px' }, title: 'Use in the next message', 'aria-label': 'Use in the next message', onclick: () => H.addContext({ title: `Memory: ${f.slice(0, 40)}${f.length > 40 ? '…' : ''}`, text: f }) }, ico('plus', 12)))));
  } catch (e) { card.replaceChildren(el('div', 'muted', `Couldn’t read memory: ${e.message}`)); }
}

export function initPanels(handlers) {
  H = handlers;
  $('btnSpClose').addEventListener('click', closeSpace);
  $('memQ').addEventListener('input', debounce(() => renderMemoryTab(true), 400));
  document.addEventListener('pointerdown', (e) => {
    if (spaceOpen() && !$('spacePanel').contains(e.target) && !e.target.closest('.sitem, .pal-it, .jc-menu, .sheet, #toast')) closeSpace();
  });
}
export { ui };
