// Mail: two sources — Gmail (direct, Google sign-in) and Mail on your Mac (the Jarvis app,
// POST /api/chat/jarvis mail_accounts / mail_search / mail_read / mail_draft / mail_send).
// Inbox, Sent, Drafts (and, for Gmail, Scheduled) with search; a message view (plain text)
// with Reply, Reply all, Forward, Draft reply with Eden and Summarize. Writing happens in the
// floating compose windows (compose.js): nothing a model writes is ever sent on its own, and
// every send goes through a review there.
// The panel: a sticky head (source, account, New email; folder tabs with counts; search, ⌘F),
// then the list (senders' avatars, grouped by day) beside a reading pane on a wide panel (one
// pane on a phone). Eden's card tops the inbox: Summarize (a digest card) and Rank by priority,
// as Eden Messenger has them (mail-model.js holds the logic; answers are cached per message).

import { el, ico, toast, debounce } from './util.js';
import { api, getJSON, postJSON } from './api.js';
import { openCalendar } from './calendar.js';
import { parseIcs, icsToDraft, icsStatusFor, draftFromEmail } from './calendar-rules.js';
import { timeText } from './calendar-model.js';
import { state } from './state.js';
import { initCompose, openCompose } from './compose.js';
import { routeSettings, modelInfo } from './router.js';
import { renderMarkdown } from './markdown.js';
import {
  nameOf, emailOf, avatarFor, groupByDay, dayLabel, mailLines, AI_MAX, RANKS, RANK_LABEL, RANK_SYSTEM, DIGEST_SYSTEM, SUMMARY_SYSTEM,
  parseRanks, sortByRank, rankCounts, parseDigest, makeCache, digestKey,
} from './mail-model.js';

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
    hidden: Number(m.hidden) || 0, // hidden HTML parts the server left out of `body` (H8: the source card's badge)
    unread: m.unread === true || m.read === false, account: str(m.account), mailbox: str(m.mailbox),
    threadId: str(m.threadId ?? m.thread_id), messageId: str(m.messageId ?? m.message_id_header ?? ''), references: str(m.references),
    attachments: atts.filter((a) => !(a && a.inline && a.contentId)).map((a) => (typeof a === 'string' ? a : a && a.name) || 'attachment'),
    attachmentsFull: atts.filter((a) => a && typeof a === 'object'),
    scheduledAt: m.scheduledAt || null,
    calendar: m.calendar && typeof m.calendar.ics === 'string' ? { ics: m.calendar.ics, method: m.calendar.method || null } : null,
  };
}
const mail = { accounts: [], account: '', mailbox: 'inbox', query: '', source: 'gmail', google: null, rows: [], open: null, ranked: false, filter: 'all', counts: {}, digest: null };
let panelBody = null;
const LS = (() => { try { return localStorage; } catch { return null; } })();
try { mail.ranked = LS && LS.getItem('eden:mail:ranked') === '1'; } catch { /* storage blocked */ }
// Eden's answers, per message id (and per set of messages for the digest): reopening never bills again.
const rankCache = makeCache(LS, 'eden:mail:ranks', 400);
const sumCache = makeCache(LS, 'eden:mail:sums', 120);
const digestCache = makeCache(LS, 'eden:mail:digests', 12);
const ck = (id) => `${mail.source}:${id}`;

const FOLDER_ICO = { inbox: 'inbox', sent: 'send', drafts: 'doc', scheduled: 'clock' };

/** The row's time: today → 14:05, this week → Mon, else 3 Oct. */
function rowDate(d) {
  const t = Date.parse(d);
  if (Number.isNaN(t)) return d || '';
  const x = new Date(t), now = new Date();
  if (x.toDateString() === now.toDateString()) return x.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  if (now - x < 6 * 86_400_000) return x.toLocaleDateString([], { weekday: 'short' });
  return x.toLocaleDateString([], { day: 'numeric', month: 'short', ...(x.getFullYear() !== now.getFullYear() ? { year: '2-digit' } : {}) });
}
const when = (d) => new Date(d).toLocaleString([], { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

/** A sender's avatar: initials on a colour from the address, or a known brand's lettermark. */
function avatar(from, big = false) {
  const a = avatarFor(from);
  return el('span', { class: `av${big ? ' big' : ''}${a.brand ? ' brand' : ''}${a.text.length > 2 ? ' long' : ''}`, style: { '--av': a.bg }, 'aria-hidden': 'true' }, a.text);
}
const iconBtn = (name, label, onclick, cls = '') => el('button', { type: 'button', class: `mx-ib ${cls}`.trim(), 'aria-label': label, title: label, onclick }, ico(name, 15));
const rankPill = (r) => (r ? el('span', { class: `rk rk-${r.level}`, title: r.reason || RANK_LABEL[r.level] }, RANK_LABEL[r.level]) : null);

/**
 * Keyboard focus into the panel: the selected source tab. It's drawn at once, before Gmail or
 * your Mac answers (which can take seconds, or wait on Jarvis's card), so focus never waits on
 * the network; re-rendering (another source, ‹ Back) would otherwise drop it on the page.
 */
export function focusMail(body = panelBody) {
  const t = body && (body.querySelector('[data-src][aria-selected="true"]') || body.querySelector('button, input, select, textarea'));
  if (t) t.focus();
  return !!t;
}

/** An empty or waiting state: a soft icon, a line, a note and maybe a button. */
function emptyState(icon, title, note, action) {
  return el('div', 'mx-empty', el('span', 'mx-empty-ic', ico(icon, 22)), el('b', '', title), note ? el('p', '', note) : null, action || null);
}
const skeleton = (n = 7) => el('div', { class: 'mx-skel', 'aria-label': 'Loading mail', role: 'status' },
  ...Array.from({ length: n }, (_, i) => el('div', 'sk-row', el('span', 'sk av'), el('span', 'sk-lines', el('span', { class: 'sk l1', style: { width: `${40 + ((i * 17) % 35)}%` } }), el('span', { class: 'sk l2', style: { width: `${62 + ((i * 23) % 30)}%` } })))));

export async function mailPanel(body) {
  panelBody = body;
  body.classList.add('mailx');
  body.replaceChildren();
  mail.open = null;
  const srcSeg = el('div', { class: 'seg mx-src', style: { '--n': 2 }, role: 'tablist', 'aria-label': 'Mail source' }, el('div', 'seg-thumb'),
    el('button', { type: 'button', role: 'tab', 'data-src': 'gmail' }, 'Gmail'), el('button', { type: 'button', role: 'tab', 'data-src': 'mac' }, 'Mail on your Mac'));
  const si = mail.source === 'gmail' ? 0 : 1;
  srcSeg.querySelector('.seg-thumb').style.setProperty('--i', si);
  srcSeg.querySelectorAll('button').forEach((x, j) => { x.classList.toggle('on', j === si); x.setAttribute('aria-selected', String(j === si)); });
  srcSeg.addEventListener('click', (e) => { const x = e.target.closest('[data-src]'); if (x && x.dataset.src !== mail.source) { mail.source = x.dataset.src; mail.account = ''; mail.digest = null; if (!SOURCES[mail.source].boxes.some(([b]) => b === mail.mailbox)) mail.mailbox = 'inbox'; mailPanel(body); focusMail(body); } });

  const acct = el('select', { class: 'mx-acct', 'aria-label': 'Mail account' });
  const who = el('span', { class: 'mail-who' });
  const newBtn = el('button', { type: 'button', class: 'btn primary mx-new', onclick: () => openCompose({ source: mail.source, account: mail.account }) }, ico('edit', 14), el('span', '', 'New email'));
  const top = el('div', { class: 'mail-top mx-bar' }, srcSeg, who, acct, newBtn);
  const head = el('div', 'mx-head', top);
  const list = el('div', { class: 'mx-list', 'aria-live': 'polite' }, skeleton());
  const read = el('div', { class: 'mx-read' }, emptyState('mail', 'No message selected', 'Pick an email to read it here. Eden can summarize it or draft your reply.'));
  const root = el('div', 'mx', head, el('div', 'mx-main', list, read));
  body.append(root);
  acct.hidden = true;

  const gate = (node) => { list.replaceChildren(node); read.hidden = true; root.classList.add('gated'); };
  if (mail.source === 'gmail') {
    let st;
    try { st = await api.googleStatus(); } catch (e) { gate(el('div', 'sp-warn', el('b', '', 'Gmail isn’t available'), e.message)); return; }
    mail.google = st;
    if (!st.configured) {
      gate(emptyState('mail', 'Gmail isn’t set up yet', 'Eden reads Gmail directly with your Google sign-in. It needs a Google OAuth client once.',
        el('button', { type: 'button', class: 'btn primary', onclick: () => H.openSettings('accounts') }, 'Set up Gmail')));
      return;
    }
    if (!st.connected) {
      gate(emptyState('mail', 'Connect your Gmail', 'Sign in with Google to let Eden read your inbox, save drafts and (only when you confirm) send.',
        el('button', { type: 'button', class: 'btn primary', onclick: connectGmail }, 'Connect Gmail')));
      return;
    }
    who.replaceChildren(avatar(st.email || 'Gmail'), el('span', { class: 'mw-t', title: 'Signed in to Gmail' }, st.email || 'Gmail'));
  } else if (!H.jarvisAvailable()) {
    gate(emptyState('mail', 'Your Mac isn’t connected', `${H.jarvisReason() || ''} Mail on your Mac comes through the Jarvis app: open it to connect.`.trim()));
    return;
  }

  const src = SOURCES[mail.source];
  const boxes = src.boxes;
  const counts = (mail.counts[mail.source] ||= {});
  const folders = el('div', { class: 'mx-folders', role: 'tablist', 'aria-label': 'Mailbox' },
    ...boxes.map(([id, label]) => el('button', { type: 'button', role: 'tab', 'data-box': id }, ico(FOLDER_ICO[id] || 'mail', 14), el('span', 'fl', label), el('span', { class: 'fc', 'data-count': id }))));
  const q = el('input', { class: 'mx-q', type: 'search', placeholder: 'Search mail', 'aria-label': 'Search mail' });
  q.value = mail.query;
  const isMac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
  const search = el('label', 'mx-search', ico('search', 14), q, el('kbd', { 'aria-hidden': 'true' }, isMac ? '⌘F' : 'Ctrl F'));
  head.append(el('div', 'mx-bar2', folders, search));
  const paintCounts = () => folders.querySelectorAll('[data-count]').forEach((c) => { const n = counts[c.dataset.count]; c.textContent = n ? String(n) : ''; c.hidden = !n; });
  const paintSeg = () => {
    folders.querySelectorAll('[data-box]').forEach((b) => { const on = b.dataset.box === mail.mailbox; b.classList.toggle('on', on); b.setAttribute('aria-selected', String(on)); });
    search.hidden = mail.mailbox === 'scheduled';
    paintCounts();
  };
  paintSeg();

  const run = async () => {
    mail.digest = null;
    if (mail.rankState && !mail.rankState.busy) mail.rankState = null;
    root.classList.remove('reading');
    if (mail.mailbox === 'scheduled') { list.replaceChildren(skeleton(3)); await scheduledList(list, run); counts.scheduled = list.querySelectorAll('.mail-sched').length; paintCounts(); return; }
    list.replaceChildren(skeleton());
    try {
      const args = { mailbox: mail.mailbox, limit: 30, ...(mail.query ? { query: mail.query } : {}), ...(mail.account ? { account: mail.account } : {}) };
      const { rows, text } = await src.search(args);
      if (!rows) { mail.rows = []; list.replaceChildren(el('p', { class: 'note-full' }, text || 'Nothing found.')); return; }
      mail.rows = rows.map(normMsg);
      counts[mail.mailbox] = mail.mailbox === 'inbox' ? (mail.query ? counts.inbox : mail.rows.filter((m) => m.unread).length) : mail.rows.length;
      paintCounts();
      drawList();
      if (mail.ranked && mail.mailbox === 'inbox') rankInbox();
    } catch (e) { list.replaceChildren(el('div', 'sp-warn', el('b', '', 'Couldn’t read Mail'), e.message)); }
  };

  /** The list: Eden's card, the digest, then the messages by day (or by rank). */
  const drawList = () => {
    const rows = mail.rows;
    const inbox = mail.mailbox === 'inbox';
    const parts = [];
    if (inbox && rows.length) parts.push(edenCard());
    if (mail.digest) parts.push(digestCard());
    if (!rows.length) {
      parts.push(mail.query ? emptyState('search', 'No mail matches that', `Nothing in ${boxes.find(([b]) => b === mail.mailbox)?.[1] || 'this mailbox'} for “${mail.query}”.`)
        : emptyState(FOLDER_ICO[mail.mailbox] || 'mail', inbox ? 'You’re all caught up' : 'Nothing here', inbox ? 'New mail lands here. Eden can draft and schedule replies for you.' : null));
      list.replaceChildren(...parts);
      return;
    }
    const ranked = inbox && mail.ranked;
    const ranks = rankMap();
    const byDate = newestFirst(rows);
    let shown = ranked ? sortByRank(byDate, ranks) : byDate;
    if (ranked && mail.filter !== 'all') shown = shown.filter((m) => ranks.get(String(m.id))?.level === mail.filter);
    const groups = ranked
      ? RANKS.map((lv) => ({ label: RANK_LABEL[lv], lv, items: shown.filter((m) => ranks.get(String(m.id))?.level === lv) })).concat([{ label: 'Not ranked yet', items: shown.filter((m) => !ranks.get(String(m.id))) }]).filter((g) => g.items.length)
      : groupByDay(shown);
    for (const g of groups) parts.push(el('section', { class: 'mx-group', 'aria-label': g.label }, el('h4', `mx-day${g.lv ? ` rk-h rk-${g.lv}` : ''}`, el('span', '', g.label), el('span', 'n', String(g.items.length))), ...g.items.map((m) => row(m, ranks.get(String(m.id))))));
    if (ranked && !shown.length) parts.push(emptyState('sort', `Nothing marked ${RANK_LABEL[mail.filter]}`, null));
    list.replaceChildren(...parts);
  };
  const rankMap = () => { const m = new Map(); for (const r of mail.rows) { const v = rankCache.get(ck(r.id)); if (v) m.set(String(r.id), v); } return m; };

  const row = (m, rank) => {
    const out = mail.mailbox === 'drafts' || mail.mailbox === 'sent';
    const peer = out ? (m.to[0] || '') : m.from;
    const name = out ? (m.to.length ? `To ${m.to.map(nameOf).join(', ')}` : '(no recipient)') : nameOf(m.from) || '(unknown sender)';
    const open = () => (m.draftId ? openCompose({ source: 'gmail', draftId: m.draftId }) : openMessage(body, m));
    const r = el('div', { class: `mail-row${m.unread ? ' unread' : ''}${mail.open === m.id ? ' sel' : ''}`, 'data-id': m.id },
      el('button', { type: 'button', class: 'mr-main', onclick: open, 'aria-label': `${m.unread ? 'Unread. ' : ''}${name}: ${m.subject}` },
        avatar(peer || name),
        el('span', 'mr-txt',
          el('span', 'mr-top', el('b', { class: 'mr-n', title: out ? m.to.join(', ') : m.from }, name), m.attachments.length ? ico('clip', 12, 'mr-clip') : null, el('span', 'mr-d', rowDate(m.date))),
          el('span', 'mr-s', m.subject, m.scheduledAt ? el('span', 'mail-badge', `Scheduled · ${when(m.scheduledAt)}`) : null),
          rank && rank.reason ? el('span', 'mr-p mr-why', rankPill(rank), rank.reason) : m.snippet ? el('span', 'mr-p', m.snippet) : null)),
      m.draftId || out ? null : el('div', 'mr-acts',
        iconBtn('reply', 'Reply', () => quick(m, 'reply')),
        iconBtn('spark', 'Draft a reply with Eden', () => quick(m, 'ai')),
        iconBtn('chat', 'Ask Eden about it', () => quick(m, 'ask'))));
    return r;
  };
  /** A row's quick action: the full message is read first (a reply quotes it). */
  const quick = async (m, what) => {
    let msg = m;
    try { const j = await SOURCES[mail.source].read(m.id); msg = merge(m, j); } catch (e) { toast(`Couldn’t open the message: ${e.message}`); return; }
    if (what === 'ask') H.askEden(msg);
    else openCompose({ source: mail.source, account: msg.account || mail.account, mode: 'reply', message: msg, ...(what === 'ai' ? { ai: 'reply' } : {}) });
  };

  /** Eden's card above the inbox: the counts, Summarize and Rank by priority (as Eden Messenger has them). */
  const edenCard = () => {
    const rows = mail.rows;
    const unread = rows.filter((m) => m.unread).length;
    const today = rows.filter((m) => dayLabel(m.date) === 'Today').length;
    const c = rankCounts(rows, rankMap());
    const stats = [
      [String(unread), unread === 1 ? 'unread' : 'unread', unread ? 'hot' : ''],
      [String(today), 'today', ''],
      ...(mail.ranked ? [[String(c.urgent), 'urgent', c.urgent ? 'urg' : ''], [String(c.reply), 'need a reply', c.reply ? 'rep' : '']] : []),
    ];
    const rankBtn = el('button', { type: 'button', class: `mx-chip${mail.ranked ? ' on' : ''}`, 'aria-pressed': String(mail.ranked), title: 'Order the inbox by importance: urgent, needs reply, FYI, low', onclick: () => {
      mail.ranked = !mail.ranked; mail.filter = 'all';
      try { LS && LS.setItem('eden:mail:ranked', mail.ranked ? '1' : '0'); } catch { /* blocked */ }
      drawList();
      if (mail.ranked) rankInbox();
    } }, ico('sort', 14), el('span', '', mail.ranked ? 'Ranked by priority' : 'Rank by priority'));
    const sumBtn = el('button', { type: 'button', class: 'mx-chip', title: 'A short AI summary of your unread and today’s mail', onclick: () => runDigest(false) }, ico('spark', 14), el('span', '', 'Summarize'));
    const chips = mail.ranked ? el('div', { class: 'mx-filters', role: 'radiogroup', 'aria-label': 'Importance' },
      ...['all', ...RANKS].map((lv) => el('button', { type: 'button', role: 'radio', 'aria-checked': String(mail.filter === lv), class: `mx-f${mail.filter === lv ? ' on' : ''}${lv !== 'all' ? ` rk-${lv}` : ''}`, onclick: () => { mail.filter = lv; drawList(); } },
        lv === 'all' ? 'All' : RANK_LABEL[lv], lv !== 'all' && c[lv] ? el('span', 'n', String(c[lv])) : null))) : null;
    return el('div', 'mx-eden',
      el('div', 'mx-eden-top', el('span', 'mx-eden-orb', ico('spark', 15)),
        el('div', 'mx-stats', ...stats.map(([n, l, cls]) => el('span', `st ${cls}`, el('b', '', n), el('span', '', l)))),
        el('div', 'mx-eden-acts', sumBtn, rankBtn)),
      mail.rankState ? el('div', `mx-eden-note${mail.rankState.error ? ' bad' : ''}`, mail.rankState.error ? `Couldn’t rank: ${mail.rankState.error}` : mail.rankState.text) : null,
      chips);
  };

  /** Rank by priority: the messages not ranked yet go to a cheap model (sender, subject, snippet only). */
  const rankInbox = async () => {
    const todo = mail.rows.filter((m) => !rankCache.get(ck(m.id))).slice(0, AI_MAX);
    if (!todo.length || mail.rankState?.busy) return;
    const rows = mail.rows;
    mail.rankState = { busy: true, text: `Eden is ranking ${todo.length} email${todo.length === 1 ? '' : 's'}…` };
    drawList();
    try {
      const ids = todo.map((m) => String(m.id));
      let ranks = parseRanks((await askEden(RANK_SYSTEM, 'Inbox: emails to rank', mailLines(todo))).out, ids);
      if (!ranks.size) ranks = parseRanks((await askEden(`${RANK_SYSTEM}\nYour last answer wasn’t that JSON object. Reply with the JSON object only.`, 'Inbox: emails to rank', mailLines(todo))).out, ids);
      if (!ranks.size) throw new Error('Eden’s answer had no ranks in it.');
      for (const [id, v] of ranks) rankCache.set(ck(id), v);
      mail.rankState = null;
    } catch (e) { mail.rankState = { error: e.message }; }
    if (mail.rows === rows && document.contains(list)) drawList();
  };

  /** Summarize (the digest card): unread and today's mail, or the newest when there's neither. */
  const runDigest = async (again) => {
    const rows = mail.rows;
    let pick = rows.filter((m) => m.unread || dayLabel(m.date) === 'Today');
    const scope = pick.length ? 'Your unread and today’s mail' : 'Your newest mail';
    if (!pick.length) pick = rows.slice(0, 12);
    pick = pick.slice(0, AI_MAX);
    const key = `${mail.source}:${digestKey(pick)}`;
    const hit = !again && digestCache.get(key);
    mail.digest = { scope: `${scope} · ${pick.length} email${pick.length === 1 ? '' : 's'}`, ...(hit ? { ...hit, state: 'ready' } : { state: 'loading' }) };
    drawList();
    list.querySelector('.mx-digest')?.scrollIntoView({ block: 'nearest' });
    if (hit) return;
    const d = mail.digest;
    try {
      const { out, model } = await askEden(DIGEST_SYSTEM, 'Inbox: emails to summarize', mailLines(pick));
      // Not the JSON asked for: the answer's own words as the overview, never an error over a summary.
      const j = parseDigest(out, pick.map((m) => String(m.id))) || (out ? { overview: out.replace(/```[a-z]*|```/gi, '').trim().slice(0, 1200), bullets: [] } : null);
      if (!j) throw new Error('Eden’s answer was empty. Try again.');
      Object.assign(d, j, { model, state: 'ready' });
      digestCache.set(key, { ...j, model });
    } catch (e) { Object.assign(d, { state: 'error', error: e.message }); }
    if (mail.digest === d && document.contains(list)) drawList();
  };
  const digestCard = () => {
    const d = mail.digest;
    const byId = new Map(mail.rows.map((m) => [String(m.id), m]));
    return el('div', { class: 'mx-digest', role: 'region', 'aria-label': 'Summary' },
      el('div', 'dg-head', ico('spark', 15), el('b', '', 'Summary'), el('span', 'dg-scope', d.scope), iconBtn('x', 'Close the summary', () => { mail.digest = null; drawList(); })),
      d.state === 'loading' ? el('div', { class: 'dg-load', role: 'status' }, 'Reading your messages…', el('span', 'sk l1'), el('span', 'sk l2'), el('span', 'sk l3')) : null,
      d.state === 'error' ? el('p', { class: 'dg-err', role: 'alert' }, `The summary couldn’t be made: ${d.error}`) : null,
      d.state === 'ready' && d.overview ? el('p', 'dg-over', d.overview) : null,
      d.state === 'ready' && d.bullets.length ? el('ul', 'dg-list', ...d.bullets.map((b) => {
        const m = byId.get(b.id);
        return el('li', '', el('button', { type: 'button', class: 'dg-b', disabled: !m, onclick: () => m && openMessage(body, m) },
          m ? avatar(m.from) : el('span', 'dg-dot'),
          el('span', 'dg-t', b.who ? el('b', '', `${b.who}: `) : null, b.gist, b.needsReply ? el('span', 'rk rk-reply', 'Needs reply') : null)));
      })) : null,
      d.state === 'ready' && !d.bullets.length && !d.overview ? el('p', 'dg-over', 'Nothing here needs your attention.') : null,
      d.state !== 'loading' ? el('div', 'dg-foot', el('span', '', `Made by AI from senders, subjects and previews${d.model ? ` · ${d.model}` : ''}. Kept on this device.`),
        el('button', { type: 'button', class: 'cap', onclick: () => runDigest(true) }, ico('retry', 12), ' Summarize again')) : null);
  };

  mail.refresh = run;
  mail.redraw = () => { if (document.contains(list) && mail.mailbox !== 'scheduled' && mail.rows) drawList(); };
  mail.readPane = read;
  mail.root = root;
  mail.search = q;
  folders.addEventListener('click', (e) => { const b = e.target.closest('[data-box]'); if (!b) return; mail.mailbox = b.dataset.box; paintSeg(); run(); });
  folders.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
    const bs = [...folders.querySelectorAll('[data-box]')];
    const i = bs.findIndex((b) => b.dataset.box === mail.mailbox);
    const n = bs[(i + (e.key === 'ArrowRight' ? 1 : bs.length - 1)) % bs.length];
    n.focus(); n.click();
  });
  q.addEventListener('input', debounce(() => { mail.query = q.value.trim(); run(); }, 400));
  q.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); mail.query = q.value.trim(); run(); } });
  acct.addEventListener('change', () => { mail.account = acct.value; run(); });
  if (mail.source === 'gmail') { run(); return; }
  who.hidden = true;
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

/** A cheap routed model (router level 1, as the brief uses), the emails as an untrusted context block (H8). */
// Mail's AI (Summarize, Rank by priority, a message's summary): always a cheap, fast Gemini Flash,
// not whatever the router would pick, when this account can use it.
// The first of these this account can use, with as little thinking as it allows (the room goes to the answer).
const MAIL_MODELS = ['gemini-3.6-flash', 'gemini-3.5-flash', 'gemini-3.5-flash-lite', 'gemini-3.8-flash'];
function mailModel() {
  for (const id of MAIL_MODELS) {
    const m = modelInfo(id);
    if (!m || !m.available) continue;
    const efforts = (m.efforts || []).map((e) => (typeof e === 'string' ? e : e && e.id)).filter(Boolean);
    const effort = ['minimal', 'none', 'low'].find((e) => efforts.includes(e));
    return { model: id, ...(effort ? { effort } : {}) };
  }
  return null;
}
async function askEden(system, title, text, onText) {
  const settings = { ...routeSettings(), level: 1, efficiency: 80, performance: 30 };
  if (!settings.providers || !settings.providers.length) throw new Error('no model is available. Add a key in Settings.');
  const override = mailModel();
  let out = '', model = '';
  await api.send({ messages: [{ role: 'user', content: 'Do it for the emails in the context. Follow the answer format exactly.' }], context: [{ title, text, source: 'mail' }], system, settings, mode: 'chat', ...(override ? { override } : {}) }, {
    onEvent: (t, d) => {
      if (t === 'route') model = d.modelName || d.model || '';
      else if (t === 'text') { out += d.text || ''; if (onText) onText(out, model); }
      else if (t === 'error') throw new Error(d.message || 'Eden couldn’t do that.');
    },
  });
  return { out: out.trim(), model };
}

/** Newest first (what Gmail and Mail already give; a list that isn't is put right), undated ones last. */
const newestFirst = (rows) => rows.map((m, i) => [m, Date.parse(m.date), i]).sort((a, b) => (Number.isNaN(b[1]) ? -Infinity : b[1]) - (Number.isNaN(a[1]) ? -Infinity : a[1]) || a[2] - b[2]).map(([m]) => m);
const merge = (m, j) => ({ ...m, ...Object.fromEntries(Object.entries(normMsg(j || {})).filter(([, v]) => (Array.isArray(v) ? v.length : v))) });

const STATUS = {
  scheduled: ['Scheduled', ''], sending: ['Sending', ''], sent: ['Sent', 'ok'], failed: ['Failed', 'bad'],
  missed: ['Missed', 'warn'], cancelled: ['Cancelled', 'warn'], unknown: ['Check Sent', 'bad'],
};
/** Gmail › Scheduled: the jobs Eden holds on this Mac. */
async function scheduledList(res, again) {
  let jobs;
  try { jobs = ((await gmail('scheduled')) || {}).jobs || []; } catch (e) { res.replaceChildren(el('div', 'sp-warn', el('b', '', 'Couldn’t read the schedule'), e.message)); return; }
  const note = el('p', 'sp-note', state.meta && state.meta.hosted
    ? 'Your askeden.com account sends each one at its time, even with your Mac off. Each waits in your Gmail Drafts until then; cancelling leaves it there.'
    : 'Eden holds these on your Mac and sends each one at its time, only while Eden is running. Each waits in your Gmail Drafts until then; cancelling leaves it there.');
  if (!jobs.length) { res.replaceChildren(emptyState('clock', 'Nothing scheduled', 'In a compose window, open the arrow next to Send › Schedule send.'), note); return; }
  const order = (j) => (j.status === 'scheduled' || j.status === 'sending' ? 0 : 1);
  jobs.sort((a, b) => order(a) - order(b) || (order(a) ? b.sendAt.localeCompare(a.sendAt) : a.sendAt.localeCompare(b.sendAt)));
  res.replaceChildren(...jobs.map((j) => {
    const [label, cls] = STATUS[j.status] || [j.status, ''];
    const open = j.status !== 'sent' && j.status !== 'sending';
    return el('div', { class: 'mail-sched' },
      el('div', 'ms-top', avatar(j.to[0] || '?'), el('b', '', j.subject || '(no subject)'), el('span', `mail-badge ${cls}`, label), el('span', 'ms-when', when(j.status === 'sent' && j.sentAt ? j.sentAt : j.sendAt))),
      el('div', 'ms-sub', j.to.length ? `To ${j.to.join(', ')}` : '(no recipient)'),
      j.error ? el('div', 'ms-err', j.error) : null,
      open ? el('div', 'ms-acts',
        el('button', { type: 'button', class: 'cap', onclick: () => openCompose({ source: 'gmail', draftId: j.draftId }) }, 'Open draft'),
        j.status !== 'cancelled' ? el('button', { type: 'button', class: 'cap rev', onclick: async () => { try { await gmail('cancelScheduled', { id: j.id }); toast('Cancelled: the email stays in Drafts'); again(); } catch (e) { toast(`Couldn’t cancel: ${e.message}`); } } }, 'Cancel schedule') : null) : null);
  }), note);
}

/** The reading pane (beside the list on a wide panel; on its own on a phone, with ‹ Back). */
async function openMessage(body, m) {
  const pane = mail.readPane, root = mail.root;
  if (!pane || !document.contains(pane)) return;
  mail.open = m.id;
  root.querySelectorAll('.mail-row').forEach((r) => r.classList.toggle('sel', r.dataset.id === String(m.id)));
  root.classList.add('reading');
  pane.hidden = false;
  const back = el('button', { type: 'button', class: 'cap mx-back', onclick: () => { root.classList.remove('reading'); mail.open = null; root.querySelectorAll('.mail-row.sel').forEach((r) => r.classList.remove('sel')); const r = root.querySelector(`.mail-row[data-id="${CSS.escape(String(m.id))}"] .mr-main`); if (r) r.focus(); else focusMail(body); } }, ico('chevl', 14), 'Back');
  const view = el('div', { class: 'mail-view', 'aria-live': 'polite' }, el('div', 'mv-skel', el('span', 'sk l1'), el('span', 'sk l2'), el('span', 'sk l3'), el('span', 'sk l2')));
  pane.replaceChildren(el('div', 'mail-top mv-top', back), view);
  pane.scrollTop = 0;
  if (getComputedStyle(back).display !== 'none') back.focus();
  let msg = m;
  try { msg = merge(m, await SOURCES[mail.source].read(m.id)); } catch (e) { view.replaceChildren(el('div', 'sp-warn', el('b', '', 'Couldn’t open the message'), e.message)); return; }
  if (mail.open !== m.id) return;
  if (!msg.account && mail.account) msg.account = mail.account;
  if (m.unread) { // read now: the row and the Inbox count say so
    m.unread = false;
    const r = root.querySelector(`.mail-row[data-id="${CSS.escape(String(m.id))}"]`);
    if (r) r.classList.remove('unread');
    const counts = mail.counts[mail.source] || {};
    if (mail.mailbox === 'inbox' && counts.inbox) { counts.inbox--; const c = root.querySelector('[data-count="inbox"]'); if (c) { c.textContent = counts.inbox ? String(counts.inbox) : ''; c.hidden = !counts.inbox; } }
  }
  const rank = rankCache.get(ck(msg.id));
  const dateText = msg.date ? (Number.isNaN(Date.parse(msg.date)) ? msg.date : new Date(msg.date).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })) : '';
  const meta = el('div', 'mv-from', avatar(msg.from, true),
    el('div', 'mv-who', el('div', 'mv-n', el('b', '', nameOf(msg.from) || '(unknown sender)'), el('span', 'mv-e', emailOf(msg.from))),
      el('div', 'mail-meta', msg.to.length ? el('div', '', el('span', 'k', 'To'), msg.to.join(', ')) : null, msg.cc.length ? el('div', '', el('span', 'k', 'Cc'), msg.cc.join(', ')) : null)),
    el('span', 'mv-date', dateText));
  const compose = (mode, extra = {}) => openCompose({ source: mail.source, account: msg.account || mail.account, mode, message: msg, ...extra });
  const isMacDraft = mail.source === 'mac' && mail.mailbox === 'drafts';
  const allCount = msg.to.length + msg.cc.length;
  const sumBox = el('div', { class: 'mx-sum', hidden: true, 'aria-live': 'polite' });
  const summarize = async (again) => {
    sumBox.hidden = false;
    const hit = !again && sumCache.get(ck(msg.id));
    // (replaceChildren turns a null into the text "null": the parts not shown are dropped first)
    const paint = (text, model, done) => sumBox.replaceChildren(...[
      el('div', 'dg-head', ico('spark', 15), el('b', '', 'Summary'), el('span', 'dg-scope', model ? `by ${model}` : ''), iconBtn('x', 'Close the summary', () => { sumBox.hidden = true; })),
      text ? el('div', 'mx-sum-t', renderMarkdown(text)) : el('div', { class: 'dg-load', role: 'status' }, 'Reading the email…', el('span', 'sk l1'), el('span', 'sk l2')),
      done ? el('div', 'dg-foot', el('span', '', 'Made by AI from this email. Kept on this device.'),
        el('button', { type: 'button', class: 'cap', onclick: () => H.summarize(msg) }, ico('chat', 12), ' Continue in chat'),
        el('button', { type: 'button', class: 'cap', onclick: () => summarize(true) }, ico('retry', 12), ' Again')) : null].filter(Boolean));
    if (hit) { paint(hit.text, hit.model, true); return; }
    paint('', '', false);
    try {
      let raf = 0;
      const { out, model } = await askEden(SUMMARY_SYSTEM, `Email: ${msg.subject}`.slice(0, 120), emailText(msg).slice(0, 20_000), (t, mdl) => { if (!raf) raf = requestAnimationFrame(() => { raf = 0; paint(t, mdl, false); }); });
      if (raf) cancelAnimationFrame(raf);
      if (!out) throw new Error('Eden sent back nothing.');
      sumCache.set(ck(msg.id), { text: out, model });
      paint(out, model, true);
    } catch (e) { sumBox.replaceChildren(el('div', 'dg-head', ico('spark', 15), el('b', '', 'Summary'), el('span', 'dg-scope', ''), iconBtn('x', 'Close', () => { sumBox.hidden = true; })), el('p', { class: 'dg-err', role: 'alert' }, `The summary couldn’t be made: ${e.message}`)); }
  };
  const btn = (icon, label, onclick, cls = 'btn') => el('button', { type: 'button', class: cls, onclick }, ico(icon, 14), el('span', '', label));
  view.replaceChildren(...[
    el('div', 'mv-subj-row', el('h3', 'mail-subj', msg.subject), rankPill(rank)),
    rank && rank.reason ? el('p', 'mv-why', rank.reason) : null,
    meta,
    el('div', 'mv-eden',
      el('span', 'mv-eden-l', ico('spark', 13), 'Eden'),
      btn('doc', 'Summarize', () => summarize(false), 'mx-chip'),
      isMacDraft ? null : btn('spark', 'Draft reply with Eden', () => compose('reply', { ai: 'reply' }), 'mx-chip accent'),
      btn('chat', 'Ask Eden', () => H.askEden(msg), 'mx-chip'),
      isMacDraft ? null : btn('cal', 'Add to calendar', () => addToCalendar(msg), 'mx-chip')),
    inviteCard(msg),
    sumBox,
    el('div', { class: 'note-full mail-body', tabindex: '0', 'aria-label': 'Message' }, msg.body || msg.snippet || '(empty message)'),
    msg.attachments.length ? el('div', 'mv-atts', ...msg.attachments.map((a) => el('span', 'mv-att', ico('clip', 13), a))) : null,
    el('div', 'mail-acts-row',
      isMacDraft ? el('button', { type: 'button', class: 'btn primary', onclick: () => openCompose({ source: 'mac', account: msg.account, to: msg.to, cc: msg.cc, subject: msg.subject === '(no subject)' ? '' : msg.subject, body: msg.body }) }, 'Edit draft') : null,
      isMacDraft ? null : btn('reply', 'Reply', () => compose('reply'), 'btn primary'),
      isMacDraft || allCount < 2 ? null : btn('replyall', 'Reply all', () => compose('replyAll')),
      isMacDraft ? null : btn('fwd', 'Forward', () => compose('forward'))),
    isMacDraft ? el('p', 'sp-note', 'Saving from Eden makes a new draft in Mail; Jarvis can’t edit this one in place.') : null].filter(Boolean));
  if (sumCache.get(ck(msg.id))) summarize(false); // already summarized: shown again, not billed again
}

/* ---------------- invitations and "Add to calendar" ---------------- */

const INV_WORD = { accepted: 'Going', declined: 'Not going', tentative: 'Maybe', needsAction: 'Not answered yet', delegated: 'Delegated' };
const icsWhen = (ev) => { const d = icsToDraft(ev); return d ? timeText({ allDay: d.allDay, start: d.allDay ? ymdOf(d.start) : d.start.toISOString(), end: d.allDay ? ymdOf(d.end) : d.end.toISOString() }, navigator.language || 'en-US') : ''; };
const ymdOf = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/** Opens the calendar's editor with what this email says (its invitation, else the first date in it); nothing is added until the owner reviews it there. */
function addToCalendar(msg, ev = null) {
  if (!ev && msg.calendar) { const ics = parseIcs(msg.calendar.ics); ev = ics.events.find((e) => !e.recurrenceId) || ics.events[0] || null; }
  const d = ev ? icsToDraft(ev) : null;
  const draft = d ? { ...d, from: `From the invitation in “${msg.subject}”. Guests aren’t copied: this adds it to your own calendar only.` }
    : (() => { const x = draftFromEmail(msg); return { ...x, from: x.found ? `Found “${x.found}” in the email: check the time.` : 'No date found in the email: pick one.' }; })();
  openCalendar({ date: draft.start, newEvent: draft });
}

/**
 * An invitation (a text/calendar part or .ics attachment Gmail found): what, when, where, who
 * asks, the owner's answer, and Yes / No / Maybe through Google Calendar when the event is in it
 * (Google sends the answer to the organizer), plus Add to calendar. Shown as data, set as text.
 */
function inviteCard(msg) {
  if (!msg.calendar || !msg.calendar.ics) return null;
  let ics;
  try { ics = parseIcs(msg.calendar.ics); } catch { return null; }
  const ev = ics.events.find((e) => !e.recurrenceId) || ics.events[0];
  if (!ev || !ev.start) return null;
  const method = String(msg.calendar.method || ics.method || '').toUpperCase();
  const mine = [mail.google && mail.google.email, msg.account, ...((msg.to || []).length === 1 ? msg.to : [])].map((a) => emailOf(String(a || '')) || String(a || '')).filter(Boolean);
  const icsStatus = icsStatusFor(ev, mine);
  const kind = method === 'CANCEL' || ev.status === 'CANCELLED' ? 'Cancelled event' : method === 'REPLY' ? 'Reply to your invitation' : ev.sequence > 0 ? 'Updated invitation' : 'Invitation';
  const status = el('span', 'inv-status');
  const note = el('p', { class: 'inv-note', 'aria-live': 'polite' });
  const btns = [['accepted', 'Yes'], ['declined', 'No'], ['tentative', 'Maybe']].map(([v, t]) => el('button', { type: 'button', class: 'inv-rs', 'data-rsvp': v, disabled: true, 'aria-pressed': 'false' }, t));
  const openBtn = el('button', { type: 'button', class: 'mx-chip', hidden: true }, ico('cal', 13), el('span', '', 'Open in calendar'));
  const addBtn = el('button', { type: 'button', class: 'mx-chip', onclick: () => addToCalendar(msg, ev) }, ico('plus', 13), el('span', '', 'Add to calendar'));
  const paintStatus = (s) => {
    status.textContent = s ? INV_WORD[s] || s : '';
    status.className = `inv-status st-${s || 'none'}`;
    btns.forEach((b) => { const on = b.dataset.rsvp === s; b.classList.toggle('on', on); b.setAttribute('aria-pressed', String(on)); });
  };
  paintStatus(icsStatus);
  const reply = method === 'REPLY' ? (ev.attendees || []).find((a) => a.status !== 'needsAction') : null;
  const asking = method !== 'REPLY' && method !== 'CANCEL' && ev.status !== 'CANCELLED';
  const card = el('section', { class: `mx-inv${asking ? '' : ' quiet'}`, 'aria-label': kind },
    el('div', 'inv-top', el('span', 'inv-ico', ico('cal', 16)), el('span', 'inv-kind', kind), status),
    el('h4', 'inv-title', ev.summary || '(No title)'),
    el('div', 'inv-row', ico('clock', 13), el('span', '', icsWhen(ev)), ev.rrule ? el('small', '', ' · repeats') : null),
    ev.location ? el('div', 'inv-row', ico('globe', 13), el('span', '', ev.location)) : null,
    ev.organizer ? el('div', 'inv-row', ico('user', 13), el('span', '', `Organizer: ${ev.organizer.name || ev.organizer.email}`)) : null,
    ev.attendees.length ? el('div', 'inv-row', ico('user', 13), el('span', '', `${ev.attendees.length} guest${ev.attendees.length === 1 ? '' : 's'}${['accepted', 'declined', 'tentative'].map((k) => [k, ev.attendees.filter((a) => a.status === k).length]).filter(([, n]) => n).map(([k, n]) => ` · ${n} ${k === 'accepted' ? 'yes' : k === 'declined' ? 'no' : 'maybe'}`).join('')}`)) : null,
    reply ? el('div', 'inv-row', ico('check', 13), el('span', '', `${reply.name || reply.email} answered: ${INV_WORD[reply.status] || reply.status}`)) : null,
    asking ? el('div', 'inv-acts', el('span', 'inv-going', 'Going?'), el('div', { class: 'inv-btns', role: 'group', 'aria-label': 'Your answer' }, ...btns), el('span', 'grow'), addBtn, openBtn) : el('div', 'inv-acts', el('span', 'grow'), openBtn),
    note);
  // Is it in Google Calendar? Then Yes / No / Maybe answer there (Google tells the organizer).
  if (ev.uid) (async () => {
    let st;
    try { st = await getJSON('/api/chat/gcal/status'); } catch { st = null; }
    if (!st || !st.calendar) { if (asking) note.textContent = 'Connect Google Calendar (Calendar › Connect) to answer here.'; return; }
    let found;
    try { found = await postJSON('/api/chat/gcal', { action: 'findInvite', args: { iCalUID: ev.uid } }); } catch (e) { note.textContent = `Couldn’t look in your calendar: ${e.message}`; return; }
    if (!document.contains(card)) return;
    const gev = found && found.event;
    if (!gev) { if (asking) note.textContent = 'Not in your Google Calendar yet: answer from the organizer’s email, or add it to your calendar.'; return; }
    const self = (gev.attendees || []).find((a) => a.self);
    paintStatus(gev.selfStatus || (self && self.status) || icsStatus);
    openBtn.hidden = false;
    openBtn.onclick = () => openCalendar({ date: new Date(gev.allDay ? `${gev.start}T00:00` : gev.start) });
    addBtn.hidden = true;
    if (!self || self.organizer) { note.textContent = self && self.organizer ? 'You organized this event.' : ''; return; }
    btns.forEach((b) => {
      b.disabled = false;
      b.onclick = async () => {
        btns.forEach((x) => { x.disabled = true; });
        note.textContent = 'Sending your answer…';
        try {
          await postJSON('/api/chat/gcal', { action: 'respond', args: { calendarId: found.calendarId || gev.calendarId, id: gev.id, status: b.dataset.rsvp, sendUpdates: 'all', confirm: true } });
          paintStatus(b.dataset.rsvp);
          note.textContent = `Answered ${b.textContent}: Google Calendar has it and the organizer is told.`;
        } catch (e) { note.textContent = `Couldn’t answer: ${e.message}`; }
        btns.forEach((x) => { x.disabled = false; });
      };
    });
    note.textContent = '';
  })();
  return card;
}

export function emailText(m) {
  return [`From: ${m.from}`, m.to.length ? `To: ${m.to.join(', ')}` : '', m.cc.length ? `Cc: ${m.cc.join(', ')}` : '', m.date ? `Date: ${m.date}` : '', `Subject: ${m.subject}`, '', m.body || m.snippet || ''].filter((x, i) => x || i > 4).join('\n');
}

export async function connectGmail() {
  try {
    const r = await api.googleConnect('gmail');
    if (r && r.url) location.assign(r.url); // top level: Google comes back to /#gmail=…
    else toast('Couldn’t start the Google sign-in');
  } catch (e) { toast(`Couldn’t connect Gmail: ${e.message}`); }
}

export function initMail(handlers) {
  H = handlers;
  // ⌘F (Ctrl F) in the Mail panel: its search, not the page's
  addEventListener('keydown', (e) => {
    if (!(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey || e.key.toLowerCase() !== 'f') return;
    const q = mail.search;
    if (!q || !document.contains(q) || q.closest('[hidden]') || !document.getElementById('spacePanel')?.classList.contains('open')) return;
    e.preventDefault();
    q.focus(); q.select();
  });
  initCompose({
    openDialog: handlers.openDialog,
    closeDialog: handlers.closeDialog,
    jarvisAvailable: handlers.jarvisAvailable,
    jarvisReason: handlers.jarvisReason,
    onSent: () => { if (panelBody && document.contains(panelBody) && mail.refresh && (mail.mailbox === 'drafts' || mail.mailbox === 'sent' || mail.mailbox === 'scheduled')) mail.refresh(); },
  });
}
