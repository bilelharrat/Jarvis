// Activity (ROADMAP H7): one timeline of what Eden did, grouped by day, with Undo where it can
// be undone (GET /api/chat/actions, POST /api/chat/actions/undo). Changes made through Jarvis
// (the Mac's calendar and Mail, memory, promises, browser tasks) are undone by Jarvis after its
// card on the Mac; Eden's own Google changes after this panel's review. A sent email can't be
// undone, and the row says so.

import { el, ico, toast } from './util.js';
import { getJSON, postJSON } from './api.js';
import { locale } from './i18n.js';

const KIND = { calendar: 'cal', mail: 'mail', memory: 'bulb', promise: 'check', browser: 'globe', sheet: 'chart', other: 'more' };
const FILTERS = [['all', 'All'], ['calendar', 'Calendar'], ['mail', 'Mail'], ['memory', 'Memory'], ['other', 'Other']];
let filter = 'all';

const dayKey = (iso) => { const d = new Date(iso); return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`; };
function dayName(iso) {
  const d = new Date(iso), now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  if (d.getTime() >= start) return 'Today';
  if (d.getTime() >= start - 864e5) return 'Yesterday';
  return d.toLocaleDateString(locale(), { weekday: 'long', day: 'numeric', month: 'long' });
}
const time = (iso) => new Date(iso).toLocaleTimeString(locale(), { hour: '2-digit', minute: '2-digit' });
const kindOf = (it) => (['calendar', 'mail', 'memory'].includes(it.kind) ? it.kind : 'other');

/** The Activity panel, in the space panel's body. */
export function activityPanel(body) {
  const root = el('div', 'act-root');
  body.append(root);
  render(root);
}

async function render(root) {
  const seg = el('div', { class: 'act-filter', role: 'group', 'aria-label': 'Show' }, ...FILTERS.map(([k, t]) =>
    el('button', { type: 'button', class: `act-f${filter === k ? ' on' : ''}`, 'aria-pressed': String(filter === k), onclick: () => { filter = k; render(root); } }, t)));
  const res = el('div', { class: 'act-list', 'aria-live': 'polite' });
  root.replaceChildren(seg, res);
  res.replaceChildren(el('div', 'muted act-busy', el('span', 'act-spin', ''), 'Asking your Mac…'));
  let data;
  try { data = await getJSON('/api/chat/actions'); } catch (e) {
    res.replaceChildren(el('div', 'sp-warn', el('b', '', 'That didn’t work'), e.message,
      el('div', 'dlg-acts', el('button', { type: 'button', class: 'btn', onclick: () => render(root) }, 'Try again'))));
    return;
  }
  if (!root.isConnected) return;
  const items = data.items.filter((it) => filter === 'all' || kindOf(it) === filter);
  const out = [];
  if (data.mac && !data.mac.available) out.push(el('div', 'sp-warn', el('b', '', 'Your Mac isn’t connected'), 'Only Eden’s own Google changes show. What Eden did through Jarvis (Mac calendar and Mail, memory) shows when it’s back.'));
  if (!items.length) out.push(el('div', 'muted act-empty', filter === 'all' ? 'Nothing yet. Calendar events, emails, memory changes and browser tasks Eden makes show here, with Undo where it can be undone.' : 'Nothing of that kind yet.'));
  let day = '';
  for (const it of items) {
    if (dayKey(it.at) !== day) { day = dayKey(it.at); out.push(el('h4', 'act-day', dayName(it.at))); }
    out.push(row(root, it));
  }
  out.push(el('p', 'sp-note', 'Undo puts back what Eden changed: an event added is removed, one changed or removed goes back as it was, a draft is deleted. Jarvis keeps what it needs for 7 days.'));
  res.replaceChildren(...out);
}

function row(root, it) {
  const where = it.where === 'google' && it.tool !== 'file_save' ? 'Google' : 'Your Mac'; // file_save: a spreadsheet Eden saved on the Mac itself (Q15)
  const side = el('div', 'act-side');
  if (it.undone) side.append(el('span', 'act-done', ico('retry', 11), `Undone ${time(it.undone)}`));
  else if (it.undo && it.undo.possible) side.append(el('button', { type: 'button', class: 'cap', onclick: () => review(root, card, it) }, ico('retry', 12), 'Undo'));
  const why = !it.undone && it.undo && !it.undo.possible && it.undo.why ? el('div', 'act-why', it.undo.why) : null;
  const card = el('div', `act-entry${it.undone ? ' is-undone' : ''}`,
    el('span', 'act-ico', ico(KIND[it.kind] || 'more', 15)),
    el('div', 'act-main',
      el('div', 'act-top', el('b', '', it.label), el('span', 'act-when', time(it.at))),
      el('div', 'act-sub', [it.detail, where].filter(Boolean).join(' · ')),
      why),
    side);
  return card;
}

/** The review before an undo: what goes back; Jarvis's card on the Mac follows for Mac changes. */
function review(root, card, it) {
  if (card.querySelector('.act-review')) return;
  const mac = it.where !== 'google';
  const side = card.querySelector('.act-side');
  side.hidden = true; // the review's own buttons stand in
  const go = el('button', { type: 'button', class: 'btn primary' }, 'Undo');
  const box = el('div', { class: 'act-review', role: 'group', 'aria-label': 'Undo this?' },
    el('b', '', 'Undo this?'), el('div', '', it.label),
    el('div', 'muted', mac ? 'Jarvis asks you on your Mac too; it happens only on your yes there.' : it.tool === 'file_save' ? 'Eden puts the file on your Mac back as it was.' : 'Eden puts it back in Google now. Nobody is emailed about it.'),
    el('div', 'dlg-acts', el('button', { type: 'button', class: 'btn', onclick: () => { box.remove(); side.hidden = false; side.querySelector('button')?.focus(); } }, 'Cancel'), go));
  go.addEventListener('click', async () => {
    go.disabled = true;
    go.textContent = mac ? 'Waiting for your Mac…' : 'Undoing…';
    try {
      const r = await postJSON('/api/chat/actions/undo', { id: it.id, confirm: true });
      toast(r.text || (r.done ? 'Undone.' : 'Nothing changed.'));
      if (root.isConnected) render(root);
    } catch (e) { toast(e.message); go.disabled = false; go.textContent = 'Undo'; }
  });
  card.querySelector('.act-main').append(box);
  go.focus();
}
