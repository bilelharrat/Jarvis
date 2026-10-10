// Meetings (ROADMAP H5): Jarvis's meeting notes (meetings_list → meeting_read) and their action
// items, picked out by a cheap routed model (POST /api/chat/meetings/actions, held to a strict
// schema on the server). Each item turns into something only through its own approval: "Add to
// calendar" opens the calendar's own editor and review card, "Draft email" a compose window
// (Eden never sends), "Save as commitment" Jarvis's card on the Mac. Meeting text is data: shown
// as text only.

import { el, ico, toast, debounce } from './util.js';
import { api, postJSON } from './api.js';
import { openCompose } from './compose.js';
import { openCalendar } from './calendar.js';
import { closeSpace } from './panels.js';
import { locale } from './i18n.js';

const KIND = { event: { i: 'cal', t: 'Event' }, email: { i: 'mail', t: 'Email' }, promise: { i: 'check', t: 'Promise' }, task: { i: 'list', t: 'To do' } };
/** Action items already picked out this session, by meeting id (a second look costs nothing). */
const picked = new Map();
const EMAIL = /^[^@\s<>]{1,64}@[^@\s<>]{1,190}\.[A-Za-z]{2,}$/;

async function jarvis(tool, args) {
  const r = await api.jarvis(tool, args);
  if (r.is_error) throw new Error(r.text || 'The Jarvis app said no.');
  return JSON.parse(r.text);
}

const when = (iso) => {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return '';
  return `${d.toLocaleDateString(locale(), { weekday: 'short', day: 'numeric', month: 'short' })}, ${d.toLocaleTimeString(locale(), { hour: '2-digit', minute: '2-digit' })}`;
};
const busy = (box, text) => box.replaceChildren(el('div', 'muted act-busy', el('span', 'act-spin', ''), text));
const failed = (box, e, retry) => box.replaceChildren(el('div', 'sp-warn', el('b', '', 'That didn’t work'), e.message,
  retry ? el('div', 'dlg-acts', el('button', { type: 'button', class: 'btn', onclick: retry }, 'Try again')) : null));

/** The Meetings panel, in the space panel's body. */
export function meetingsPanel(body) {
  const root = el('div', 'act-root');
  body.append(root);
  list(root, '');
}

function list(root, query) {
  const q = el('input', { class: 'sp-search', type: 'search', placeholder: 'Search your meeting notes', 'aria-label': 'Search meetings' });
  q.value = query;
  const res = el('div', { class: 'act-list', 'aria-live': 'polite' });
  const run = async () => {
    busy(res, 'Asking your Mac…');
    try {
      const { items } = await jarvis('meetings_list', q.value.trim() ? { query: q.value.trim() } : {});
      if (!items.length) {
        res.replaceChildren(el('div', 'muted', q.value.trim() ? 'No meeting notes match that.' : 'No meeting notes yet. Say “Jarvis, take notes” in a meeting, or start notes from Jarvis’s meeting card.'));
        return;
      }
      res.replaceChildren(...items.map((m) => el('button', { type: 'button', class: 'act-row', onclick: () => open(root, m.id, q.value) },
        el('span', 'act-ico', ico('quote', 15)),
        el('span', 'act-main',
          el('span', 'act-top', el('b', { 'data-no-i18n': '' }, m.title), el('span', 'act-when', when(m.date))),
          m.preview ? el('span', { class: 'act-sub', 'data-no-i18n': '' }, m.preview) : null,
          el('span', 'act-chips', m.actions ? el('span', 'act-chip', `${m.actions} action item${m.actions === 1 ? '' : 's'}`) : null,
            m.decisions ? el('span', 'act-chip', `${m.decisions} decision${m.decisions === 1 ? '' : 's'}`) : null)),
        ico('chevr', 14, 'act-go'))));
    } catch (e) { failed(res, e, run); }
  };
  const deb = debounce(run, 400);
  q.addEventListener('input', deb);
  q.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); deb.cancel(); run(); } });
  root.replaceChildren(q, res, el('p', 'sp-note', 'Notes stay on your Mac. Action items are picked out by a low-cost model through the router; nothing happens until you approve each one.'));
  run();
}

async function open(root, id, query) {
  const back = el('button', { type: 'button', class: 'cap act-back', onclick: () => list(root, query) }, ico('chevl', 12), 'Meetings');
  const box = el('div', 'act-detail');
  root.replaceChildren(back, box);
  back.focus();
  busy(box, 'Reading the notes…');
  let m;
  try { m = await jarvis('meeting_read', { id }); } catch (e) { failed(box, e, () => open(root, id, query)); return; }
  const people = (m.attendees || []).map((p) => p.name || p.email).filter((x) => x && x !== 'You' && x !== 'Them');
  const items = el('div', { class: 'act-items', 'aria-live': 'polite' });
  const section = (title, lines) => (lines && lines.length ? el('section', 'act-sec', el('h4', '', title), el('ul', { 'data-no-i18n': '' }, ...lines.map((l) => el('li', '', l)))) : null);
  const transcript = (m.transcript || []).length ? el('details', 'act-tx', el('summary', '', `Transcript (${m.transcript.length} lines${m.cut ? ', cut' : ''})`),
    el('div', { class: 'act-tx-body', 'data-no-i18n': '' }, ...m.transcript.map((r) => el('p', '', el('span', 'act-tx-t', r.t), r.who ? el('b', '', `${r.who}: `) : null, r.text)))) : null;
  box.replaceChildren(
    el('h3', { class: 'act-title', 'data-no-i18n': '' }, m.title),
    el('div', { class: 'act-meta', 'data-no-i18n': '' }, when(m.date), people.length ? ` · ${people.join(', ')}` : ''),
    section('Summary', m.summary),
    section('Decisions', m.decisions),
    el('section', 'act-sec', el('h4', '', 'Action items'), items),
    section('Open questions', m.questions),
    transcript);
  extract(items, m);
}

async function extract(box, m, again = false) {
  if (!again && picked.has(m.id)) { showItems(box, m, picked.get(m.id)); return; }
  busy(box, 'Picking out the action items with a low-cost model…');
  try {
    const r = await postJSON('/api/chat/meetings/actions', { id: m.id });
    picked.set(m.id, r);
    showItems(box, m, r);
  } catch (e) {
    // The write-up's own action items still work, as plain to-dos.
    const own = (m.actions || []).map((text) => ({ text, kind: 'task', owner: null, due: null, start: null, minutes: null, to: null, subject: null, body: null }));
    box.replaceChildren(el('div', 'sp-warn', el('b', '', 'Couldn’t pick out the action items'), e.message,
      el('div', 'dlg-acts', el('button', { type: 'button', class: 'btn', onclick: () => extract(box, m, true) }, 'Try again'))));
    if (own.length) box.append(el('p', 'sp-note', 'From the notes’ own list:'), ...own.map((it) => itemCard(it, m)));
  }
}

function showItems(box, m, r) {
  const how = [r.modelName ? `Picked out by ${r.modelName}` : 'Picked out by the router’s low-cost pick', typeof r.costUSD === 'number' ? `$${r.costUSD < 0.01 ? r.costUSD.toFixed(4) : r.costUSD.toFixed(2)}` : '',
    r.dropped ? `${r.dropped} didn’t match the format and were left out` : ''].filter(Boolean).join(' · ');
  if (!r.items.length) {
    box.replaceChildren(el('div', 'muted', 'No action items in this meeting.'), el('p', 'act-how', how));
    return;
  }
  box.replaceChildren(...r.items.map((it) => itemCard(it, m)),
    el('p', 'act-how', how, ' ', el('button', { type: 'button', class: 'act-link', onclick: () => extract(box, m, true) }, 'Pick again')));
}

function itemCard(it, m) {
  const k = KIND[it.kind] || KIND.task;
  const note = el('div', { class: 'act-note', 'aria-live': 'polite' });
  const meta = [it.owner && `Who: ${it.owner}`, it.start ? `When: ${when(it.start)}` : it.due && `Due: ${new Date(`${it.due}T12:00`).toLocaleDateString(locale(), { weekday: 'short', day: 'numeric', month: 'short' })}`, it.to && `To: ${it.to}`].filter(Boolean);
  const btn = (label, icon, primary, run) => el('button', { type: 'button', class: `cap${primary ? ' primary' : ''}`, onclick: run }, ico(icon, 12), label);
  const commit = btn('Save as commitment', 'check', it.kind === 'promise', async (e) => {
    const b = e.currentTarget;
    b.disabled = true;
    note.replaceChildren(el('span', 'act-spin', ''), 'Waiting for your OK on your Mac…');
    try {
      const r = await api.jarvis('commitment_add', {
        text: it.text.slice(0, 300), ...(it.owner && !/^you$/i.test(it.owner) ? { to: it.owner.slice(0, 100) } : it.to ? { to: it.to.slice(0, 100) } : {}),
        ...(it.due ? { due: it.due } : {}), meeting: m.id, confirm: true,
      });
      let out = {};
      try { out = JSON.parse(r.text); } catch { out = { text: r.text }; }
      note.replaceChildren(out.done ? el('span', 'act-ok', ico('check', 12), 'Kept: Jarvis reminds you before it’s due.') : el('span', 'muted', out.text || 'Not kept.'));
      if (!out.done) b.disabled = false;
    } catch (err) { note.replaceChildren(el('span', 'muted', err.message)); b.disabled = false; }
  });
  return el('div', 'act-item',
    el('div', 'act-item-top', el('span', `act-kind k-${it.kind}`, ico(k.i, 12), k.t), el('b', { 'data-no-i18n': '' }, it.text)),
    meta.length ? el('div', 'act-sub', meta.join(' · ')) : null,
    el('div', 'acts',
      btn('Add to calendar', 'cal', it.kind === 'event', () => addToCalendar(it, m)),
      btn('Draft email', 'mail', it.kind === 'email', () => draftEmail(it, m)),
      commit),
    note);
}

function addToCalendar(it, m) {
  let start;
  if (it.start) start = new Date(it.start);
  else if (it.due) start = new Date(`${it.due}T09:00`);
  else { const d = new Date(); start = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1, 9, 0); }
  if (!Number.isFinite(start.getTime())) { toast('That time doesn’t look right: set it in the calendar.'); start = new Date(); }
  const end = new Date(start.getTime() + (it.minutes || 30) * 60_000);
  closeSpace();
  // The calendar's own editor, then its review card: nothing is added before that.
  openCalendar({ date: start, newEvent: { title: it.text.slice(0, 200), start, end, notes: `From the meeting “${m.title}”${m.date ? ` (${new Date(m.date).toLocaleDateString(locale())})` : ''}.` } });
}

function draftEmail(it, m) {
  const to = it.to && EMAIL.test(it.to.trim()) ? [it.to.trim()] : [];
  const body = it.body || `Hi${it.to && !to.length ? ` ${it.to.split(/\s+/)[0]}` : ''},\n\nFollowing up on “${m.title}”: ${it.text.replace(/\.$/, '')}.\n\nBest,`;
  closeSpace();
  // A compose window to review and send yourself: Eden never sends it.
  openCompose({ to, subject: it.subject || `Follow-up: ${m.title}`, body });
  if (it.to && !to.length) toast(`Add ${it.to}’s address in To.`);
}
