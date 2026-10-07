// Mail: two sources — Gmail (direct, Google sign-in) and Mail on your Mac (the Jarvis app,
// POST /api/chat/jarvis mail_accounts / mail_search / mail_read / mail_draft / mail_send).
// Inbox, Sent, Drafts (and, for Gmail, Scheduled) with search; a message view (plain text)
// with Reply, Reply all, Forward, Draft reply with Eden and Summarize. Writing happens in the
// floating compose windows (compose.js): nothing a model writes is ever sent on its own, and
// every send goes through a review there.

import { el, toast, debounce } from './util.js';
import { api } from './api.js';
import { initCompose, openCompose } from './compose.js';

let H = {};
const DATA_NOTE = /^\(From the owner's Jarvis:[^)]*\)\s*/;
const strip = (t) => String(t || '').replace(DATA_NOTE, '').trim();

async function call(tool, args = {}) {
  const r = await api.jarvis(tool, args);
  if (r.is_error) throw new Error(strip(r.text) || 'Mail said no.');
  return strip(r.text);
}

async function gmail(action, args = {}) {
  const r = await api.gmail(action, args);
  if (r && r.error) throw new Error(r.error);
  return r && typeof r === 'object' && 'result' in r ? r.result : r;
}
const SOURCES = {
  gmail: {
    label: 'Gmail',
    boxes: [['inbox', 'Inbox'], ['sent', 'Sent'], ['drafts', 'Drafts'], ['scheduled', 'Scheduled']],
    search: async (args) => {
      if (args.mailbox === 'drafts') { const j = await gmail('drafts', { limit: args.limit, ...(args.query ? { query: args.query } : {}) }); return { rows: arrayIn(j, ['drafts']) || [], text: '' }; }
      const j = await gmail('search', args);
      return { rows: arrayIn(j, ['messages', 'results', 'items']) || [], text: '' };
    },
    read: async (id) => gmail('read', { id }),
  },
  mac: {
    label: 'Mail on your Mac',
    boxes: [['inbox', 'Inbox'], ['sent', 'Sent'], ['drafts', 'Drafts']],
    search: async (args) => { const text = await call('mail_search', args); const j = parseJSON(text); return { rows: arrayIn(j, ['messages', 'results', 'items', 'emails']), text }; },
    read: async (id) => { const text = await call('mail_read', { id }); const j = parseJSON(text); return j && typeof j === 'object' && !Array.isArray(j) ? j : { body: text }; },
  },
};
/** JSON from a tool's text, or null (then the text is shown as it is). */
export function parseJSON(text) {
  const t = strip(text);
  try { return JSON.parse(t); } catch { /* maybe prose around it */ }
  const i = t.search(/[[{]/);
  if (i >= 0) { try { return JSON.parse(t.slice(i)); } catch { /* not JSON */ } }
  return null;
}
const str = (v) => (v === undefined || v === null ? '' : Array.isArray(v) ? v.map(str).filter(Boolean).join(', ') : typeof v === 'object' ? (v.name && v.email ? `${v.name} <${v.email}>` : v.email || v.name || v.address || '') : String(v));
/** A list of addresses (header strings are split on commas outside quotes). */
const list = (v) => {
  if (Array.isArray(v)) return v.map(str).filter(Boolean);
  const out = [];
  let cur = '', q = false;
  for (const ch of String(v || '')) { if (ch === '"') q = !q; if (!q && (ch === ',' || ch === ';')) { if (cur.trim()) out.push(cur.trim()); cur = ''; continue; } cur += ch; }
  if (cur.trim()) out.push(cur.trim());
  return out;
};
function arrayIn(j, keys) {
  if (Array.isArray(j)) return j;
  if (j && typeof j === 'object') for (const k of keys) if (Array.isArray(j[k])) return j[k];
  return null;
}
function normAccount(a) {
  if (typeof a === 'string') return { id: a, name: a };
  return { id: String(a.id ?? a.email ?? a.name ?? ''), name: str(a.name || a.email || a.id), email: a.email || '' };
}
function normMsg(m) {
  const atts = Array.isArray(m.attachments) ? m.attachments : [];
  return {
    id: String(m.id ?? m.message_id ?? m.messageId ?? ''),
    draftId: m.draftId ? String(m.draftId) : '',
    from: str(m.from ?? m.sender), to: list(m.to), cc: list(m.cc), bcc: list(m.bcc), replyTo: str(m.replyTo ?? m.reply_to),
    subject: str(m.subject) || '(no subject)', date: str(m.date ?? m.received ?? m.sent),
    snippet: str(m.snippet ?? m.preview ?? m.excerpt), body: str(m.body ?? m.text ?? m.content ?? m.plain),
    html: typeof m.html === 'string' ? m.html : '',
    unread: m.unread === true || m.read === false, account: str(m.account), mailbox: str(m.mailbox),
    threadId: str(m.threadId ?? m.thread_id), messageId: str(m.messageId ?? m.message_id_header ?? ''), references: str(m.references),
    attachments: atts.filter((a) => !(a && a.inline && a.contentId)).map((a) => (typeof a === 'string' ? a : a && a.name) || 'attachment'),
    attachmentsFull: atts.filter((a) => a && typeof a === 'object'),
    scheduledAt: m.scheduledAt || null,
  };
}
function niceDate(d) {
  const t = Date.parse(d);
  if (Number.isNaN(t)) return d;
  const x = new Date(t), now = new Date();
  return x.toDateString() === now.toDateString() ? x.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : x.toLocaleDateString([], { day: 'numeric', month: 'short' });
}
const when = (d) => new Date(d).toLocaleString([], { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

const mail = { accounts: [], account: '', mailbox: 'inbox', query: '', source: 'gmail', google: null };
let panelBody = null;

export async function mailPanel(body) {
  panelBody = body;
  body.replaceChildren();
  const srcSeg = el('div', { class: 'seg', style: { '--n': 2, marginBottom: '10px' }, role: 'tablist', 'aria-label': 'Mail source' }, el('div', 'seg-thumb'),
    el('button', { type: 'button', role: 'tab', 'data-src': 'gmail' }, 'Gmail'), el('button', { type: 'button', role: 'tab', 'data-src': 'mac' }, 'Mail on your Mac'));
  const si = mail.source === 'gmail' ? 0 : 1;
  srcSeg.querySelector('.seg-thumb').style.setProperty('--i', si);
  srcSeg.querySelectorAll('button').forEach((x, j) => { x.classList.toggle('on', j === si); x.setAttribute('aria-selected', String(j === si)); });
  srcSeg.addEventListener('click', (e) => { const x = e.target.closest('[data-src]'); if (x && x.dataset.src !== mail.source) { mail.source = x.dataset.src; mail.account = ''; if (!SOURCES[mail.source].boxes.some(([b]) => b === mail.mailbox)) mail.mailbox = 'inbox'; mailPanel(body); } });
  body.append(srcSeg);
  if (mail.source === 'gmail') {
    let st;
    try { st = await api.googleStatus(); } catch (e) { body.append(el('div', 'sp-warn', el('b', '', 'Gmail isn’t available'), e.message)); return; }
    mail.google = st;
    if (!st.configured) {
      body.append(el('div', 'sp-warn', el('b', '', 'Gmail isn’t set up yet'), 'Eden reads Gmail directly with your Google sign-in. It needs a Google OAuth client once.'),
        el('div', 'dlg-acts', el('button', { type: 'button', class: 'btn primary', onclick: () => H.openSettings('accounts') }, 'Set up Gmail')));
      return;
    }
    if (!st.connected) {
      body.append(el('p', 'sp-note', 'Sign in with Google to let Eden read your inbox, save drafts and (only when you confirm) send.'),
        el('div', 'dlg-acts', el('button', { type: 'button', class: 'btn primary', onclick: connectGmail }, 'Connect Gmail')));
      return;
    }
  } else if (!H.jarvisAvailable()) {
    body.append(el('div', 'sp-warn', el('b', '', 'Your Mac isn’t connected'), `${H.jarvisReason() || ''} Mail on your Mac comes through the Jarvis app: open it to connect.`));
    return;
  }
  const src = SOURCES[mail.source];
  const boxes = src.boxes;
  const acct = el('select', { 'aria-label': 'Mail account' });
  const seg = el('div', { class: 'seg', style: { '--n': boxes.length }, role: 'tablist', 'aria-label': 'Mailbox' }, el('div', 'seg-thumb'),
    ...boxes.map(([id, label]) => el('button', { type: 'button', role: 'tab', 'data-box': id }, label)));
  const q = el('input', { class: 'sp-search', type: 'search', placeholder: 'Search mail…', 'aria-label': 'Search mail' });
  q.value = mail.query;
  const res = el('div', { 'aria-live': 'polite' });
  const top = el('div', { class: 'mail-top' }, acct, seg, el('button', { type: 'button', class: 'btn primary', onclick: () => openCompose({ source: mail.source, account: mail.account }) }, 'New email'));
  body.append(top, q, res);
  const paintSeg = () => {
    const i = boxes.findIndex(([b]) => b === mail.mailbox);
    seg.querySelector('.seg-thumb').style.setProperty('--i', i);
    seg.querySelectorAll('button').forEach((b, j) => { b.classList.toggle('on', j === i); b.setAttribute('aria-selected', String(j === i)); });
    q.hidden = mail.mailbox === 'scheduled';
  };
  paintSeg();
  const run = async () => {
    if (mail.mailbox === 'scheduled') { scheduledList(res, run); return; }
    res.replaceChildren(el('div', 'muted', 'Reading Mail…'));
    try {
      const args = { mailbox: mail.mailbox, limit: 30, ...(mail.query ? { query: mail.query } : {}), ...(mail.account ? { account: mail.account } : {}) };
      const { rows, text } = await src.search(args);
      if (!rows) { res.replaceChildren(el('p', { class: 'note-full' }, text || 'Nothing found.')); return; }
      if (!rows.length) { res.replaceChildren(el('div', 'muted', mail.query ? 'No mail matches that.' : 'Nothing here.')); return; }
      res.replaceChildren(...rows.map(normMsg).map((m) => el('button', { type: 'button', class: `mail-row${m.unread ? ' unread' : ''}`, onclick: () => (m.draftId ? openCompose({ source: 'gmail', draftId: m.draftId }) : openMessage(body, m)) },
        el('span', 'mr-top', el('b', '', mail.mailbox === 'drafts' || mail.mailbox === 'sent' ? (m.to.length ? `To: ${m.to.join(', ')}` : '(no recipient)') : m.from || '(unknown sender)'), el('span', 'mr-d', niceDate(m.date))),
        el('span', 'mr-s', m.subject, m.scheduledAt ? el('span', 'mail-badge', `Scheduled · ${when(m.scheduledAt)}`) : null), m.snippet ? el('span', 'mr-p', m.snippet) : null)));
    } catch (e) { res.replaceChildren(el('div', 'sp-warn', el('b', '', 'Couldn’t read Mail'), e.message)); }
  };
  mail.refresh = run;
  seg.addEventListener('click', (e) => { const b = e.target.closest('[data-box]'); if (!b) return; mail.mailbox = b.dataset.box; paintSeg(); run(); });
  q.addEventListener('input', debounce(() => { mail.query = q.value.trim(); run(); }, 400));
  q.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); mail.query = q.value.trim(); run(); } });
  acct.addEventListener('change', () => { mail.account = acct.value; run(); });
  // accounts (Gmail: the one signed in)
  if (mail.source === 'gmail') {
    acct.hidden = true;
    top.prepend(el('span', { class: 'mail-who', title: 'Signed in to Gmail' }, mail.google.email || 'Gmail'));
    run();
    return;
  }
  try {
    const text = await call('mail_accounts');
    const j = parseJSON(text);
    const accts = (arrayIn(j, ['accounts', 'items']) || []).map(normAccount).filter((a) => a.id);
    mail.accounts = accts;
    acct.replaceChildren(el('option', { value: '' }, accts.length ? 'All accounts' : (text && !j ? text.slice(0, 60) : 'Default account')), ...accts.map((a) => el('option', { value: a.id }, a.email && a.email !== a.name ? `${a.name} — ${a.email}` : a.name)));
    acct.value = mail.account;
    acct.hidden = accts.length < 2 && !mail.account;
  } catch { acct.replaceChildren(el('option', { value: '' }, 'Default account')); acct.hidden = true; }
  run();
}

const STATUS = {
  scheduled: ['Scheduled', ''], sending: ['Sending', ''], sent: ['Sent', 'ok'], failed: ['Failed', 'bad'],
  missed: ['Missed', 'warn'], cancelled: ['Cancelled', 'warn'], unknown: ['Check Sent', 'bad'],
};
/** Gmail › Scheduled: the jobs Eden holds on this Mac. */
async function scheduledList(res, again) {
  res.replaceChildren(el('div', 'muted', 'Reading the schedule…'));
  let jobs;
  try { jobs = ((await gmail('scheduled')) || {}).jobs || []; } catch (e) { res.replaceChildren(el('div', 'sp-warn', el('b', '', 'Couldn’t read the schedule'), e.message)); return; }
  const note = el('p', 'sp-note', 'Eden holds these on your Mac and sends each one at its time, only while Eden is running. Each waits in your Gmail Drafts until then; cancelling leaves it there.');
  if (!jobs.length) { res.replaceChildren(el('div', 'muted', 'Nothing scheduled. In a compose window, open the arrow next to Send › Schedule send.'), note); return; }
  const order = (j) => (j.status === 'scheduled' || j.status === 'sending' ? 0 : 1);
  jobs.sort((a, b) => order(a) - order(b) || (order(a) ? b.sendAt.localeCompare(a.sendAt) : a.sendAt.localeCompare(b.sendAt)));
  res.replaceChildren(...jobs.map((j) => {
    const [label, cls] = STATUS[j.status] || [j.status, ''];
    const open = j.status !== 'sent' && j.status !== 'sending';
    return el('div', { class: 'mail-sched' },
      el('div', 'ms-top', el('b', '', j.subject || '(no subject)'), el('span', `mail-badge ${cls}`, label), el('span', 'ms-when', when(j.status === 'sent' && j.sentAt ? j.sentAt : j.sendAt))),
      el('div', 'ms-sub', j.to.length ? `To ${j.to.join(', ')}` : '(no recipient)'),
      j.error ? el('div', 'ms-err', j.error) : null,
      open ? el('div', 'ms-acts',
        el('button', { type: 'button', class: 'cap', onclick: () => openCompose({ source: 'gmail', draftId: j.draftId }) }, 'Open draft'),
        j.status !== 'cancelled' ? el('button', { type: 'button', class: 'cap rev', onclick: async () => { try { await gmail('cancelScheduled', { id: j.id }); toast('Cancelled: the email stays in Drafts'); again(); } catch (e) { toast(`Couldn’t cancel: ${e.message}`); } } }, 'Cancel schedule') : null) : null);
  }), note);
}

async function openMessage(body, m) {
  const back = el('button', { type: 'button', class: 'cap', onclick: () => { body.replaceChildren(); mailPanel(body); } }, '‹ Back');
  const view = el('div', { class: 'mail-view', 'aria-live': 'polite' }, el('div', 'muted', 'Opening…'));
  body.replaceChildren(el('div', 'mail-top', back), view);
  back.focus();
  let msg = m;
  try {
    const j = await SOURCES[mail.source].read(m.id);
    msg = { ...m, ...Object.fromEntries(Object.entries(normMsg(j || {})).filter(([, v]) => (Array.isArray(v) ? v.length : v))) };
  } catch (e) { view.replaceChildren(el('div', 'sp-warn', el('b', '', 'Couldn’t open the message'), e.message)); return; }
  if (!msg.account && mail.account) msg.account = mail.account;
  const meta = el('div', 'mail-meta',
    el('div', '', el('span', 'k', 'From'), msg.from || '—'),
    msg.to.length ? el('div', '', el('span', 'k', 'To'), msg.to.join(', ')) : null,
    msg.cc.length ? el('div', '', el('span', 'k', 'Cc'), msg.cc.join(', ')) : null,
    msg.date ? el('div', '', el('span', 'k', 'Date'), Number.isNaN(Date.parse(msg.date)) ? msg.date : new Date(msg.date).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })) : null);
  const compose = (mode, extra = {}) => openCompose({ source: mail.source, account: msg.account || mail.account, mode, message: msg, ...extra });
  const isMacDraft = mail.source === 'mac' && mail.mailbox === 'drafts';
  const allCount = msg.to.length + msg.cc.length;
  view.replaceChildren(...[el('h3', 'mail-subj', msg.subject), meta,
    el('div', { class: 'note-full mail-body', tabindex: '0', 'aria-label': 'Message' }, msg.body || msg.snippet || '(empty message)'),
    msg.attachments.length ? el('div', 'muted', `Attachments: ${msg.attachments.join(', ')}`) : null,
    el('div', 'mail-acts-row',
      isMacDraft ? el('button', { type: 'button', class: 'btn primary', onclick: () => openCompose({ source: 'mac', account: msg.account, to: msg.to, cc: msg.cc, subject: msg.subject === '(no subject)' ? '' : msg.subject, body: msg.body }) }, 'Edit draft') : null,
      isMacDraft ? null : el('button', { type: 'button', class: 'btn', onclick: () => compose('reply') }, 'Reply'),
      isMacDraft || allCount < 2 ? null : el('button', { type: 'button', class: 'btn', onclick: () => compose('replyAll') }, 'Reply all'),
      isMacDraft ? null : el('button', { type: 'button', class: 'btn', onclick: () => compose('forward') }, 'Forward'),
      el('span', 'grow'),
      el('button', { type: 'button', class: 'btn', onclick: () => H.summarize(msg) }, 'Summarize'),
      isMacDraft ? null : el('button', { type: 'button', class: 'btn primary', title: 'Opens a reply and Eden writes it; you review before anything is sent', onclick: () => compose('reply', { ai: 'reply' }) }, '✦ Draft reply with Eden')),
    isMacDraft ? el('p', 'sp-note', 'Saving from Eden makes a new draft in Mail; Jarvis can’t edit this one in place.') : null].filter(Boolean));
}

export function emailText(m) {
  return [`From: ${m.from}`, m.to.length ? `To: ${m.to.join(', ')}` : '', m.cc.length ? `Cc: ${m.cc.join(', ')}` : '', m.date ? `Date: ${m.date}` : '', `Subject: ${m.subject}`, '', m.body || m.snippet || ''].filter((x, i) => x || i > 4).join('\n');
}

export async function connectGmail() {
  try {
    const r = await api.googleConnect();
    if (r && r.url) location.assign(r.url); // top level: Google comes back to /#gmail=…
    else toast('Couldn’t start the Google sign-in');
  } catch (e) { toast(`Couldn’t connect Gmail: ${e.message}`); }
}

export function initMail(handlers) {
  H = handlers;
  initCompose({
    openDialog: handlers.openDialog,
    closeDialog: handlers.closeDialog,
    jarvisAvailable: handlers.jarvisAvailable,
    jarvisReason: handlers.jarvisReason,
    onSent: () => { if (panelBody && document.contains(panelBody) && mail.refresh && (mail.mailbox === 'drafts' || mail.mailbox === 'sent' || mail.mailbox === 'scheduled')) mail.refresh(); },
  });
}
