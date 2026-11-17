// Mail: two sources — Gmail (direct, Google sign-in) and Mail on your Mac (the Eden Secretary app,
// POST /api/chat/jarvis mail_accounts / mail_search / mail_read / mail_draft / mail_send).
// Inbox, Sent, Drafts (and, for Gmail, Scheduled) with search; a message view (plain text)
// with Reply, Reply all, Forward, Draft reply with Eden and Summarize. Writing happens in the
// floating compose windows (compose.js): nothing a model writes is ever sent on its own, and
// every send goes through a review there.
// The panel: a sticky head (source, account, New email; folder tabs with counts; search, ⌘F),
// then the list (senders' avatars, grouped by day) beside a reading pane on a wide panel (one
// pane on a phone). Eden's card tops the inbox: Summarize (a digest card) and Rank by priority,
// as Eden Messenger has them (mail-model.js holds the logic; answers are cached per message).

import { el, ico, toast, debounce, placePopup, fmtCost, MAIL_ONLY } from './util.js';
import { api, getJSON, postJSON, isMock } from './api.js';
const isMockMail = () => isMock;
import { openCalendar } from './calendar-entry.js';
import { parseIcs, icsToDraft, icsStatusFor, draftFromEmail } from './calendar-rules.js';
import { timeText } from './calendar-model.js';
import { state } from './state.js';
import { initCompose, openCompose as composeOpen, draftReplyText, stripMd } from './compose-entry.js'; // compose.js loads on first use
import { routeSettings, modelInfo } from './router.js';
import { renderMarkdown } from './markdown.js';
import {
  nameOf, emailOf, avatarFor, groupByDay, dayLabel, mailLines, AI_MAX, RANKS, RANK_LABEL, RANK_SYSTEM, DIGEST_SYSTEM, SUMMARY_SYSTEM,
  parseRanks, sortByRank, rankCounts, parseDigest, makeCache, digestKey,
} from './mail-model.js';
import {
  setMailkitHandlers, getKit, prefs, onKit, maybeAutoLearn, voiceFor, voiceOn, askCheap, offerFor, dropOffer, mailAI, privateMail, rules as mailRules, logRule, serverDrafts, openMailSettings,
  snooze as kitSnooze, unsnooze, markDone, isDone, snoozedOf, dropFollowUp, vips, shortcutsNode,
} from './mailkit.js';
import { SPLITS, splitOf, snoozeChoices, dueSnoozes, followUpState, INSTANT_SYSTEM, parseInstant } from './mail-voice.js';
import { isQuestion, wantsNewest, keywordQuery, querySystem, parseQueries, ANSWER_SYSTEM, sourcesContext, citations, teamItemId, receiptText } from './mail-ask.js';
import { teamMail } from './spaces.js';
import { listKey, getList, putList, getMsg, putMsg, timing } from './mail-cache.js';
// Several mail accounts (ROADMAP Y, behind askeden.com's MAIL_MULTI): All inboxes, the accounts in the sidebar, From per account
import { PRIMARY, boxKey, parseBoxKey, mergeMailboxes, groupByBox, unreadByBox, sendFrom, wireBox, isExtra, homeBoxOf } from './mail-merge.js';
import { loadMailboxes, mailboxes, multiOn, multiAvailable, addMailbox, mailboxById, okMailboxes, nameOfBox, boxDot, rowMark, accountsNav, accountsSelect, boxProblems, manageMailboxes, lastFrom } from './mail-accounts.js';
import { scamSignals, safeForAuto } from './mail-check.js';
import { promisesIn, openPromises, pickedSlot, slotText } from './mail-plan.js';
import { matchRule, describeRule } from './mail-rules.js';
import { BRIEF, LEVELS as BRIEF_LEVELS, LEVEL_LABEL as BRIEF_LABEL, briefSystem, briefContext, parseBrief, briefPick, briefSpeech } from './mail-brief.js';
import { ownText } from './mail-voice.js';
import { t as tx, isFr, locale, speechLang, replyLanguageNote, contentLanguageNote } from './i18n.js';
// a JSON prompt with the language of its words added (the reasons and digest the person reads)
const withContentLang = (sys) => [sys, contentLanguageNote()].filter(Boolean).join('\n');

// The person's own text (subjects, senders, snippets, what the AI wrote): never translated; the placeholders are.
const PLACEHOLDER = new Set(['(no subject)', '(unknown sender)', '(no recipient)', '(unknown)', '(empty message)']);
const own = (tag, cls, text) => el(tag, { class: cls, 'data-no-i18n': '' }, PLACEHOLDER.has(text) ? tx(text) : text);
const DONE = isFr ? 'Terminé' : 'Done'; // Mail's Done (archive), not the dialogs' "OK"

let H = {};
const DATA_NOTE = /^\(From the owner's Eden Secretary:[^)]*\)\s*/;
const strip = (t) => String(t || '').replace(DATA_NOTE, '').trim();

async function call(tool, args = {}) {
  const r = await api.jarvis(tool, args);
  if (r.is_error) throw new Error(strip(r.text) || 'Mail said no.');
  return strip(r.text);
}

/** A Gmail action; `box` names the mailbox (else the email's own, from its id, or the one in view; else homeBox()). */
async function gmail(action, args = {}, box) {
  const r = await api.gmail(action, args, wireBox(box === undefined ? routeBox(args) : box));
  if (r && r.error) throw new Error(r.error);
  return r && typeof r === 'object' && 'result' in r ? r.result : r;
}
const SOURCES = {
  gmail: {
    label: 'Gmail',
    boxes: [['inbox', 'Inbox'], ['sent', 'Sent'], ['drafts', 'Drafts'], ['scheduled', 'Scheduled']],
    search: async (args) => {
      const one = async (box) => {
        if (args.mailbox === 'drafts') { const j = await gmail('drafts', { limit: args.limit, ...(args.query ? { query: args.query } : {}) }, box); return arrayIn(j, ['drafts']) || []; }
        const j = await gmail('search', args, box);
        return arrayIn(j, ['messages', 'results', 'items']) || [];
      };
      // Each mailbox in view (one, or every account in All inboxes), tagged and merged newest first (mail-merge.js).
      const boxes = viewBoxes();
      const waiting = multi() && mail.box === 'all' ? mailboxes().filter((b) => b.status === 'reconnect').map((b) => ({ box: b.id, reconnect: true })) : [];
      if (boxes.length === 1) { const rows = (await one(boxes[0])).map((r) => ({ ...r, box: boxes[0] })); mail.boxErrors = waiting; return { rows, text: '' }; }
      const got = await Promise.allSettled(boxes.map(one));
      const failed = got.map((g, i) => (g.status === 'rejected' ? { box: boxes[i], error: g.reason && g.reason.message, reconnect: !!(g.reason && g.reason.code === 'reconnect') } : null)).filter(Boolean);
      if (failed.length === boxes.length) throw got[0].reason;
      mail.boxErrors = [...failed, ...waiting];
      return { rows: mergeMailboxes(boxes.map((box, i) => ({ box, rows: got[i].status === 'fulfilled' ? got[i].value : [] })), { page: args.limit || 30 }).rows, text: '' };
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
    box: isExtra(m.box) || m.box === PRIMARY ? m.box : '', alsoIn: Array.isArray(m.alsoIn) ? m.alsoIn.filter((b) => isExtra(b) || b === PRIMARY) : [],
    threadId: str(m.threadId ?? m.thread_id), messageId: str(m.messageId ?? m.message_id_header ?? ''), references: str(m.references),
    attachments: atts.filter((a) => !(a && a.inline && a.contentId)).map((a) => (typeof a === 'string' ? a : a && a.name) || 'attachment'),
    attachmentsFull: atts.filter((a) => a && typeof a === 'object'),
    scheduledAt: m.scheduledAt || null,
    labels: Array.isArray(m.labels) ? m.labels.map(String) : Array.isArray(m.labelIds) ? m.labelIds.map(String) : [],
    unsubscribe: m.unsubscribe && typeof m.unsubscribe === 'object' ? { url: typeof m.unsubscribe.url === 'string' && /^https:\/\//i.test(m.unsubscribe.url) ? m.unsubscribe.url : null, mailto: typeof m.unsubscribe.mailto === 'string' && /^mailto:/i.test(m.unsubscribe.mailto) ? m.unsubscribe.mailto : null } : null,
    calendar: m.calendar && typeof m.calendar.ics === 'string' ? { ics: m.calendar.ics, method: m.calendar.method || null } : null,
  };
}
const mail = { accounts: [], account: '', mailbox: 'inbox', query: '', source: 'gmail', google: null, rows: [], open: null, ranked: false, filter: 'all', counts: {}, digest: null,
  split: null, sel: -1, canModify: null, known: null, reminders: [], nudges: [], undo: null,
  box: 'all', idBox: new Map(), boxErrors: [], boxUnread: {} }; // box: 'all' (All inboxes) or one mailbox; idBox: each email's mailbox
let panelBody = null;
const LS = (() => { try { return localStorage; } catch { return null; } })();
try { mail.ranked = LS && LS.getItem('eden:mail:ranked') === '1'; } catch { /* storage blocked */ }
// Eden's answers, per message id (and per set of messages for the digest): reopening never bills again.
const rankCache = makeCache(LS, 'eden:mail:ranks', 400);
const sumCache = makeCache(LS, 'eden:mail:sums', 120);
const instantCache = makeCache(LS, 'eden:mail:instant', 150);
const autoCache = makeCache(LS, isMockMail() ? 'eden:mail:auto:mock' : 'eden:mail:auto', 120); // Auto Drafts, per message id
const digestCache = makeCache(LS, 'eden:mail:digests', 12);
try { const b = LS && LS.getItem('eden:mail:box'); if (b === 'all' || b === PRIMARY || isExtra(b)) mail.box = b; } catch { /* storage blocked */ }
if (typeof addEventListener === 'function') addEventListener('eden:mailboxes', (e) => { if (mail.onBoxesChanged) mail.onBoxesChanged(e.detail && e.detail.what); }); // mail-accounts.js
/** Several accounts are on (askeden.com, MAIL_MULTI) and this is Gmail. */
const multi = () => mail.source === 'gmail' && multiOn();
/** The first Gmail is connected (askeden.com's `google_data`). Mail also works without one: IMAP or Outlook only. */
const hasGmail = () => !!(mail.google && mail.google.connected);
/** The mailbox used when nothing names one: the first Gmail, else (no Gmail at all) the first working mailbox. */
const homeBox = () => (multi() ? homeBoxOf({ gmail: hasGmail(), boxes: mailboxes() }) : PRIMARY);
/** The address of homeBox(). */
const homeEmail = () => { const b = homeBox(); return b === PRIMARY ? (mail.google && mail.google.email) || '' : (mailboxById(b) || {}).email || ''; };
/** The mailbox an email is in (homeBox() unless a list said otherwise). */
const boxFor = (id) => mail.idBox.get(String(id)) || homeBox();
const tagBoxes = (rows) => { for (const r of rows || []) if (r && r.id) mail.idBox.set(String(r.id), r.box || homeBox()); };
/** The mailboxes a list reads: the one in view, or every working one in All inboxes. */
function viewBoxes() {
  if (!multi()) return [PRIMARY];
  if (mail.box !== 'all') return [mail.box];
  const ok = okMailboxes().map((b) => b.id);
  return ok.length ? ok : [homeBox()];
}
/** Where a Gmail call goes when the caller didn't say: the email's mailbox (args.id / args.ids), else the one in view. */
function routeBox(args) {
  const id = args && (args.id || (Array.isArray(args.ids) && args.ids[0]));
  if (id && mail.idBox.has(String(id))) return mail.idBox.get(String(id));
  return multi() && mail.box !== 'all' ? mail.box : homeBox();
}
function setBox(id) { mail.box = id; try { if (LS) LS.setItem('eden:mail:box', id); } catch { /* storage blocked */ } }
// Eden's key for an email: the first Gmail's stay `gmail:<id>` (saved ranks, summaries, snoozes keep working).
const ck = (id) => boxKey(mail.source, boxFor(id), id);
/** Compose from the right account: a reply from the mailbox the email came to, a new email from the one in view (mail-merge.js sendFrom). */
const openCompose = (o = {}) => composeOpen(withMailbox(o));
function withMailbox(o) {
  if ((o.source && o.source !== 'gmail') || !multi() || o.mailbox) return o;
  const fromMsg = o.message && o.message.id ? o.message.box || boxFor(o.message.id) : null;
  return { ...o, mailbox: fromMsg || sendFrom({ current: mail.box, last: lastFrom(), boxes: mailboxes() }) };
}
/** Recent correspondents of every mailbox (or the one), one list. */
async function contactsAll() {
  const boxes = multi() ? okMailboxes().map((b) => b.id) : [PRIMARY];
  if (!boxes.length) return null;
  const got = await Promise.all(boxes.map((b) => gmail('contacts', {}, b).catch(() => null)));
  if (boxes.length === 1) return got[0];
  const by = new Map();
  for (const c of got.flatMap((r) => (r && r.contacts) || [])) {
    const k = String(c.email).toLowerCase(), had = by.get(k);
    by.set(k, had ? { ...had, count: had.count + c.count, name: had.name || c.name } : { ...c });
  }
  return { contacts: [...by.values()].sort((a, b) => b.count - a.count) };
}
/** The history marks a cached list is checked against: { historyId } for one mailbox, { historyIds } for several. */
async function historyMarks() {
  const boxes = viewBoxes();
  const ps = await Promise.all(boxes.map((b) => gmail('profile', {}, b).catch(() => null)));
  if (boxes.length === 1) return { historyId: (ps[0] && ps[0].historyId) || null };
  const ids = {};
  boxes.forEach((b, i) => { if (ps[i] && ps[i].historyId) ids[b] = ps[i].historyId; });
  return { historyIds: ids };
}
/** Nothing changed in any mailbox of the list since it was cached (one history call each). */
async function historyUnchanged(cached) {
  const boxes = viewBoxes();
  const ids = cached.historyIds || (boxes.length === 1 ? { [boxes[0]]: cached.historyId } : null);
  if (!ids || !boxes.every((b) => ids[b])) return false;
  const hs = await Promise.all(boxes.map((b) => gmail('history', { startHistoryId: ids[b] }, b).catch(() => null)));
  return hs.every((h) => h && !h.tooOld && !h.changes);
}
/** Ask your inbox's search, in every mailbox in view: newest first, each tagged with its mailbox. */
async function searchFullAll(query, limit) {
  const boxes = viewBoxes();
  const got = await Promise.all(boxes.map((b) => gmail('searchFull', { query, limit }, b).then((r) => ((r && r.messages) || []).map((m) => ({ ...m, box: b })), () => null)));
  if (got.every((x) => x === null)) throw new Error('Gmail couldn’t be searched.');
  const all = got.flatMap((x) => x || []).sort((a, b) => (Date.parse(b.date) || 0) - (Date.parse(a.date) || 0));
  tagBoxes(all);
  return { messages: all };
}

const FOLDER_ICO = { inbox: 'inbox', sent: 'send', drafts: 'doc', scheduled: 'clock', team: 'user' };

/** The row's time: today → 14:05, this week → Mon, else 3 Oct. */
function rowDate(d) {
  const t = Date.parse(d);
  if (Number.isNaN(t)) return d || '';
  const x = new Date(t), now = new Date();
  if (x.toDateString() === now.toDateString()) return x.toLocaleTimeString(locale(), { hour: '2-digit', minute: '2-digit' });
  if (now - x < 6 * 86_400_000) return x.toLocaleDateString(locale(), { weekday: 'short' });
  return x.toLocaleDateString(locale(), { day: 'numeric', month: 'short', ...(x.getFullYear() !== now.getFullYear() ? { year: '2-digit' } : {}) });
}
const when = (d) => new Date(d).toLocaleString(locale(), { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

/** A sender's avatar: initials on a colour from the address, or a known brand's lettermark. */
function avatar(from, big = false) {
  const a = avatarFor(from);
  return el('span', { class: `av${big ? ' big' : ''}${a.brand ? ' brand' : ''}${a.text.length > 2 ? ' long' : ''}`, style: { '--av': a.bg }, 'aria-hidden': 'true' }, a.text);
}
const iconBtn = (name, label, onclick, cls = '') => el('button', { type: 'button', class: `mx-ib ${cls}`.trim(), 'aria-label': label, title: label, onclick }, ico(name, 15));
const rankPill = (r) => (r ? el('span', { class: `rk rk-${r.level}`, title: r.reason || RANK_LABEL[r.level] }, RANK_LABEL[r.level]) : null);

/**
 * Keyboard focus into the panel: the selected source tab. It's drawn at once, before Gmail or
 * your Mac answers (which can take seconds, or wait on Eden Secretary's card), so focus never waits on
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

/** What Eden did and what it cost (DESIGN.md): "Made from 9 emails · <b>model</b> · $0.002 · 1.4 s · …". */
function metaLine(lead, x = {}, tail = '') {
  const parts = [lead, x.model ? el('b', { 'data-no-i18n': '' }, x.model) : null, typeof x.cost === 'number' ? fmtCost(x.cost, { notional: x.notional }) : null, x.ms ? `${(x.ms / 1000).toFixed(1)} s` : null, tail].filter(Boolean);
  return el('p', 'mx-meta', ...parts.flatMap((p, i) => (i ? [' · ', p] : [p])));
}
/** Today's brief when one was made (same emails, or earlier today), without making one. */
function todaysBrief() {
  const pick = briefPick(visibleRows());
  const hit = pick.length ? briefCache.get(`${mail.source}:${today()}:${digestKey(pick)}`) : null;
  if (hit) return hit;
  const last = mail.lastBrief;
  return last && last.day === today() && last.source === mail.source ? last.brief : null;
}
async function draftFor(m, aiPrompt = '') {
  try { const full = merge(m, await readCached(m.id)); openCompose({ source: mail.source, account: full.account || mail.account, mode: 'reply', message: full, ai: 'reply', aiPrompt }); } catch (e) { toast(e.message); }
}
/**
 * The reading pane with nothing open, on the inbox: Today. A greeting and what needs you (from today's brief, or the
 * ranks), one thing to do first, three counts and today's mail. It calls no model by itself: the brief is one click.
 */
function todayPane() {
  const rows = visibleRows();
  const byId = new Map(rows.map((m) => [String(m.id), m]));
  const now = new Date();
  const h = now.getHours();
  const hi = h >= 5 && h < 12 ? 'Good morning' : h >= 12 && h < 18 ? 'Good afternoon' : 'Good evening';
  const unread = rows.filter((m) => m.unread).length;
  const brief = todaysBrief();
  const need = brief ? brief.items.filter((x) => (x.level === 'today' || x.level === 'reply') && byId.has(String(x.id))) : null;
  const ranked = !need && rows.some((m) => rankCache.get(ck(m.id)));
  const needN = need ? need.length : ranked ? rows.filter((m) => ['urgent', 'reply'].includes(rankCache.get(ck(m.id))?.level)).length : null;
  const line = needN === null ? (unread ? `${unread} unread.` : 'You’re all caught up.') : needN ? `${needN} email${needN === 1 ? '' : 's'} need${needN === 1 ? 's' : ''} you.` : 'Nothing needs you right now.';
  let card;
  if (brief) {
    const first = need.map((x) => ({ x, m: byId.get(String(x.id)) })).find(({ x, m }) => x.needsReply && safeForAuto(shieldOf(m)));
    const name = first ? String(first.x.who || nameOf(first.m.from) || '').split(/\s+/)[0] : '';
    const more = need.length - (first ? 1 : 0);
    card = el('section', { class: 'mx-noticed', 'aria-label': 'Eden noticed' },
      el('p', 'mx-kick', ico('spark', 14), 'Eden noticed'),
      own('p', 'mx-noticed-t', brief.headline || line),
      el('div', 'mx-acts',
        first ? el('button', { type: 'button', class: 'btn primary', onclick: () => draftFor(first.m, first.x.next || '') }, ico('edit', 14), el('span', '', name ? `Draft ${name} a reply` : 'Draft a reply'))
          : el('button', { type: 'button', class: 'btn primary', onclick: () => openBrief(false) }, ico('sun', 14), el('span', '', 'Open your daily brief')),
        first ? el('button', { type: 'button', class: 'mx-link', onclick: () => openBrief(false) }, more > 0 ? `${more} more thing${more === 1 ? '' : 's'} to decide` : 'Open your daily brief') : null),
      metaLine(`Made from ${brief.count} email${brief.count === 1 ? '' : 's'}`, brief, 'saved on this device'));
  } else {
    card = el('section', { class: 'mx-noticed', 'aria-label': 'Eden' },
      el('p', 'mx-kick', ico('spark', 14), 'Eden'),
      el('p', 'mx-noticed-t', rows.length ? 'Eden can read your unread and recent mail and tell you what needs you first.' : 'New mail lands in the list. Eden can rank it and draft replies in your style.'),
      rows.length ? el('div', 'mx-acts', el('button', { type: 'button', class: 'btn primary', onclick: () => openBrief(false) }, ico('sun', 14), el('span', '', 'Make my daily brief'))) : null,
      el('p', 'mx-meta', 'Reads your unread and last day’s emails. Nothing is sent or changed.'));
  }
  const todays = rows.filter((m) => dayLabel(m.date) === 'Today');
  const stat = (n, label) => el('div', '', el('b', '', String(n)), el('span', '', label));
  const recent = newestFirst(todays.length ? todays : rows).slice(0, todays.length ? 5 : 4);
  return el('div', 'mx-page mx-today',
    el('p', 'mx-k', now.toLocaleDateString(locale(), { weekday: 'long', month: 'long', day: 'numeric' })),
    el('h2', 'mx-big', `${tx(hi)}. ${line}`),
    card,
    el('div', 'mx-stats3', stat(unread, 'Unread'), needN === null ? stat(todays.length, 'Today') : stat(needN, 'Waiting on you'), stat((mail.nudges || []).length, 'You’re waiting on')),
    recent.length ? el('div', 'mx-mini', el('h3', '', todays.length ? 'Today' : 'Latest'),
      ...recent.map((m) => el('button', { type: 'button', class: 'mx-mrow', onclick: () => openMessage(mail.body, m) },
        avatar(m.from), el('span', 't', own('b', '', nameOf(m.from) || '(unknown sender)'), own('span', '', m.subject)), el('time', '', rowDate(m.date))))) : null);
}
const NO_MSG = () => emptyState('mail', 'No message selected', 'Pick an email to read it here. Eden can summarize it or draft your reply.');
const readEmpty = () => (mail.mailbox === 'inbox' && !mail.query && mail.rows && mail.rows.length ? todayPane() : NO_MSG());
/** Today again after the list changed, unless an email or a page is open (or focus is in the pane). */
function paintToday() {
  const pane = mail.readPane;
  if (!pane || mail.open || (mail.view && mail.view !== 'list')) return;
  const cur = pane.firstElementChild;
  if (cur && !cur.matches('.mx-today, .mx-empty')) return;
  if (pane.contains(document.activeElement) && document.activeElement !== pane) return;
  pane.replaceChildren(readEmpty());
}
const RAIL_KEY = 'eden:mail:rail';
const railPref = () => { try { return localStorage.getItem(RAIL_KEY) === '1'; } catch { return false; } };
/** The sidebar as an icon rail (true) or in full (false); with no argument, the other way round. Kept per browser. */
function setRail(on, root = mail.root) {
  if (!root) return;
  const rail = typeof on === 'boolean' ? on : !root.classList.contains('rail');
  root.classList.toggle('rail', rail);
  const b = root.querySelector('.mx-railbtn');
  if (b) { const t = rail ? 'Show the sidebar ([)' : 'Collapse the sidebar ([)'; b.title = t; b.setAttribute('aria-label', t); b.setAttribute('aria-expanded', String(!rail)); }
  try { localStorage.setItem(RAIL_KEY, rail ? '1' : '0'); } catch { /* blocked */ }
}
/** Back from the Daily brief or Ask your inbox (full pages) to the list. */
function leavePage() {
  if (!mail.root) return;
  mail.root.classList.remove('page');
  if (mail.view && mail.view !== 'list') {
    mail.view = 'list';
    if (mail.readPane && !mail.open) mail.readPane.replaceChildren(readEmpty());
  }
}

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
  const newBtn = el('button', { type: 'button', class: 'mx-new', onclick: () => openCompose({ source: mail.source, account: mail.account }) }, ico('edit', 15), el('span', '', 'New email'));
  const gear = iconBtn('gear', 'Mail settings: your writing style, snippets, shortcuts', () => openMailSettings({ fetchSamples: samplesFrom(mail.source), source: mail.source, previewRows: () => { const ctx = { known: mail.known || new Set(), vips: vips() }; return visibleRows().map((m) => ({ ...m, split: splitOf(m, ctx), fromName: nameOf(m.from) })); } }), 'mx-gear');
  // Eden Glass (DESIGN.md): a sidebar (mailboxes, Daily brief, Ask your inbox, the split inbox, the account),
  // the list, and the reading pane, which shows Today when nothing is open. A narrow panel folds the sidebar into a bar.
  const brand = el('div', 'mx-brand', el('span', 'mx-tile', ico('mail', 15)), el('span', '', 'Eden Mail'));
  const nav = el('nav', { class: 'mx-nav', 'aria-label': 'Mailboxes' });
  const splitNav = el('div', { class: 'mx-splitnav', hidden: true });
  const acctBox = el('div', 'mx-acctbox', el('div', 'mx-acct-row', who, gear), srcSeg, acct);
  // The sidebar folds to an icon rail (the button, or [), kept per browser; a narrow panel folds it into a bar anyway.
  const railBtn = el('button', { type: 'button', class: 'mx-ib mx-railbtn', onclick: () => setRail() }, ico('side', 16));
  const sideTop = el('div', 'mx-sidetop', brand, railBtn);
  const side = el('aside', { class: 'mx-side', 'aria-label': 'Mail' }, sideTop, newBtn, nav, splitNav, acctBox);
  newBtn.setAttribute('aria-label', 'New email');
  newBtn.title = 'New email (C)';
  const lhead = el('div', 'mx-lhead');
  const list = el('div', { class: 'mx-list', 'aria-live': 'polite' }, skeleton());
  const col = el('div', 'mx-col', lhead, list);
  const read = el('div', { class: 'mx-read' }, readEmpty());
  const split = el('div', { class: 'mx-split', role: 'separator', 'aria-orientation': 'vertical', 'aria-label': 'Resize the message list', title: 'Drag to resize · double-click to reset' });
  const main = el('div', 'mx-main', col, read, split);
  const root = el('div', 'mx', side, main);
  splitter(root, main, col, split);
  body.append(root);
  acct.hidden = true;
  mail.view = 'list';
  setRail(railPref(), root);

  const gate = (node) => { list.replaceChildren(node); read.hidden = true; root.classList.add('gated'); };
  if (mail.source === 'gmail') {
    let st;
    const boxesP = loadMailboxes(); // several accounts (askeden.com, MAIL_MULTI); [] elsewhere
    try { st = await api.googleStatus(); } catch (e) { gate(el('div', 'sp-warn', el('b', '', 'Gmail isn’t available'), e.message)); return; }
    await boxesP;
    if (multi() && mail.box !== 'all' && !mailboxById(mail.box)) setBox('all');
    mail.google = st;
    // No Gmail is fine when several accounts are on (askeden.com MAIL_MULTI): IMAP or Outlook mailboxes only.
    const noGmail = !st.connected && multiAvailable();
    if (noGmail && !mailboxes().length) {
      mail.onBoxesChanged = (what) => { if (what === 'add' && document.contains(root)) mailPanel(body); }; // the first one added opens Mail
      gate(emptyState('mail', 'Add your email', 'Add any email account: iCloud, Yahoo, Outlook, your own domain (IMAP), or Gmail. No Gmail needed.',
        el('button', { type: 'button', class: 'btn primary', onclick: (e) => addMailbox(e.currentTarget) }, 'Add an account')));
      return;
    }
    if (!st.configured && !noGmail) {
      gate(emptyState('mail', 'Gmail isn’t set up yet', 'Eden reads Gmail directly with your Google sign-in. It needs a Google OAuth client once.',
        el('button', { type: 'button', class: 'btn primary', onclick: () => H.openSettings('accounts') }, 'Set up Gmail')));
      return;
    }
    if (!st.connected && !noGmail) {
      gate(emptyState('mail', 'Connect your Gmail', 'Sign in with Google to let Eden read your inbox, save drafts and (only when you confirm) send.',
        el('button', { type: 'button', class: 'btn primary', onclick: connectGmail }, 'Connect Gmail')));
      return;
    }
    const whoEmail = st.connected ? st.email || 'Gmail' : homeEmail() || 'Mail';
    who.replaceChildren(avatar(whoEmail), el('span', { class: 'mw-t', title: st.connected ? 'Signed in to Gmail' : 'Your mail account' }, whoEmail));
    if (!mail.known) contactsAll().then((r) => { mail.contacts = (r && r.contacts) || []; mail.known = new Set(mail.contacts.filter((c) => c.count >= 2).map((c) => String(c.email).toLowerCase())); if (mail.redraw) mail.redraw(); }, () => { mail.known = new Set(); });
    maybeAutoLearn(samplesFrom('gmail'), 'gmail'); // homeBox()'s sent mail (samplesFrom): the first Gmail, else the first mailbox
  } else if (!H.jarvisAvailable()) {
    gate(emptyState('mail', 'Your Mac isn’t connected', `${H.jarvisReason() || ''} Mail on your Mac comes through the Eden app: open it to connect.`.trim()));
    return;
  }

  const src = SOURCES[mail.source];
  const boxes = mail.source === 'gmail' && teamMail.available() ? [...src.boxes, ['team', 'Team']] : src.boxes;
  const counts = (mail.counts[mail.source] ||= {});
  // (the label is also the button's name and tooltip: the icon rail hides the words)
  const box = ([id, label]) => el('button', { type: 'button', class: 'mx-nv', 'data-box': id, title: label, 'aria-label': label }, ico(FOLDER_ICO[id] || 'mail', 16), el('span', 'fl', label), el('span', { class: 'fc', 'data-count': id, 'aria-hidden': 'true' }));
  const tool = (id, icon, label, run) => el('button', { type: 'button', class: 'mx-nv', 'data-view': id, title: label, 'aria-label': label, onclick: run }, ico(icon, 16), el('span', 'fl', label));
  const folders = el('div', { class: 'mx-folders' }, box(boxes[0]),
    tool('brief', 'sun', 'Daily brief', () => openBrief(false)),
    tool('ask', 'spark', 'Ask your inbox', () => openAsk()),
    ...boxes.slice(1).map(box));
  nav.append(folders);
  // Several accounts (look A): All inboxes and each account under the mailboxes; a menu instead on a narrow panel.
  let acctNav = null, boxSel = null;
  const paintAccts = () => { if (acctNav) acctNav.paint(mail.box, mail.boxUnread); if (boxSel) boxSel.paint(mail.box); };
  if (multi()) {
    const pick = (id) => { if (id === mail.box) return; setBox(id); mail.digest = null; mail.sel = -1; if (mail.view !== 'list' || mail.open) closeReader(); paintAccts(); run(); };
    // an account added or removed (here, or in Add an account) re-reads All inboxes; a new name or colour only redraws
    const boxesChanged = (what) => {
      if (!document.contains(root)) return;
      if (what === 'remove' || what === 'add') { if (mail.box !== 'all' && !mailboxById(mail.box)) setBox('all'); mail.boxUnread = {}; paintAccts(); run(); }
      else { paintAccts(); if (mail.redraw) mail.redraw(); }
    };
    mail.onBoxesChanged = boxesChanged;
    acctNav = accountsNav({ current: mail.box, onPick: pick, onManage: (a) => manageMailboxes(a, { onChange: boxesChanged }) });
    boxSel = accountsSelect({ current: mail.box, onPick: pick });
    nav.append(acctNav.node);
    acctBox.append(boxSel.node);
    root.classList.add('multi');
    // opened on one account: the others' unread counts from All inboxes as last shown (this browser's copy, no call)
    if (mail.box !== 'all' && !Object.keys(mail.boxUnread).length) getList(listKey('gmail', 'all', 'inbox')).then((c) => {
      if (!c || !Array.isArray(c.rows) || Object.keys(mail.boxUnread).length) return;
      const now = Date.now();
      const rows = c.rows.map(normMsg).filter((m) => { const k = boxKey('gmail', m.box || homeBox(), m.id), z = snoozedOf(k); return !isDone(k) && !(z && Date.parse(z.until) > now); });
      mail.boxUnread = unreadByBox(rows);
      paintAccts();
    }, () => {});
  }
  const q = el('input', { class: 'mx-q', type: 'search', placeholder: 'Search, or ask a question', 'aria-label': 'Search mail, or ask a question' });
  q.value = mail.query;
  const isMac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
  const search = el('label', 'mx-search', ico('search', 14), q, el('kbd', { 'aria-hidden': 'true' }, isMac ? '⌘F' : 'Ctrl F'));
  // The list's head: the mailbox's name and count, Rank by priority and Read it to me, the search, and (ranked) the importance filter.
  const lTitle = el('h2', 'mx-lt-t'), lSub = el('span', 'mx-lt-n');
  const rankBtn = iconBtn('sort', 'Rank by priority: urgent, needs reply, FYI, low', () => {
    mail.ranked = !mail.ranked; mail.filter = 'all';
    try { LS && LS.setItem('eden:mail:ranked', mail.ranked ? '1' : '0'); } catch { /* blocked */ }
    drawList();
    if (mail.ranked) rankInbox();
  }, 'mx-rankbtn');
  const readBtn = iconBtn('speaker', 'Read my inbox out loud (V)', () => readInbox());
  const rankBar = el('div', 'mx-rankbar');
  const srow = el('div', 'mx-srow', search);
  lhead.append(el('div', 'mx-lt', lTitle, lSub, el('span', 'grow'), rankBtn, readBtn), srow, rankBar);
  const boxLabel = (id) => boxes.find(([b]) => b === id)?.[1] || 'Mail';
  const paintHead = (rows) => {
    const inbox = mail.mailbox === 'inbox';
    const splitOn = inbox && !mail.query && prefs().split && mail.split;
    lTitle.textContent = tx(splitOn ? (SPLITS.find(([id]) => id === mail.split)?.[1] || 'Inbox') : boxLabel(mail.mailbox));
    const shown = rows || [];
    const unread = shown.filter((m) => m.unread).length;
    lSub.textContent = mail.mailbox === 'scheduled' || mail.mailbox === 'team' ? '' : inbox ? (unread ? `${unread} ${tx('unread')}` : '') : (shown.length ? String(shown.length) : '');
    rankBtn.hidden = readBtn.hidden = !inbox;
    rankBtn.classList.toggle('on', !!mail.ranked);
    rankBtn.setAttribute('aria-pressed', String(!!mail.ranked));
    const c = inbox && mail.ranked ? rankCounts(shown, rankMap()) : null;
    rankBar.replaceChildren(...[
      c ? el('div', { class: 'mx-seg', role: 'radiogroup', 'aria-label': 'Importance' },
        ...['all', ...RANKS].map((lv) => el('button', { type: 'button', role: 'radio', 'aria-checked': String(mail.filter === lv), class: `${mail.filter === lv ? 'on' : ''}${lv !== 'all' ? ` rk-${lv}` : ''}`.trim() || null, onclick: () => { mail.filter = lv; drawList(); } },
          lv === 'all' ? 'All' : RANK_LABEL[lv], lv !== 'all' && c[lv] ? el('span', 'n', String(c[lv])) : null))) : null,
      inbox && mail.rankState ? el('div', `mx-eden-note${mail.rankState.error ? ' bad' : ''}`, mail.rankState.error ? `Couldn’t rank: ${mail.rankState.error}` : mail.rankState.text) : null].filter(Boolean));
    rankBar.hidden = !rankBar.childElementCount;
  };
  /** The split inbox in the sidebar (wide): Important, Other… with their unread counts. */
  const paintSplitNav = (bySplit) => {
    splitNav.hidden = !bySplit;
    if (!bySplit) { splitNav.replaceChildren(); return; }
    splitNav.replaceChildren(el('p', 'mx-sh', 'Inbox'), ...SPLITS.map(([id, label], i) => {
      const n = bySplit[id].length, unread = bySplit[id].filter((m) => m.unread).length;
      const on = mail.view === 'list' && mail.split === id;
      return el('button', { type: 'button', class: `mx-nv mx-nv-sp${on ? ' on' : ''}`, 'aria-current': on ? 'page' : null, title: `${label} (${i + 1})`, onclick: () => { if (mail.view !== 'list') closeReader(); mail.split = id; mail.sel = -1; mail.redraw(); } },
        el('span', `mx-dot${id === 'important' ? ' acc' : ''}`), el('span', 'fl', label), n ? el('span', `fc${unread ? ' unread' : ''}`, String(unread || n)) : null);
    }));
  };
  const paintCounts = () => folders.querySelectorAll('[data-count]').forEach((c) => {
    const n = counts[c.dataset.count]; c.textContent = n ? String(n) : ''; c.hidden = !n;
    const btn = c.closest('.mx-nv'), label = boxLabel(c.dataset.count);
    if (btn) btn.setAttribute('aria-label', n ? `${label}, ${n}` : label);
  });
  const paintSeg = () => {
    const view = mail.view || 'list';
    const mark = (b, on) => { b.classList.toggle('on', on); if (on) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current'); };
    folders.querySelectorAll('[data-box]').forEach((b) => mark(b, view === 'list' && b.dataset.box === mail.mailbox));
    folders.querySelectorAll('[data-view]').forEach((b) => mark(b, b.dataset.view === view));
    if (view !== 'list') splitNav.querySelectorAll('.mx-nv-sp.on').forEach((b) => mark(b, false));
    search.hidden = mail.mailbox === 'scheduled' || mail.mailbox === 'team';
    paintCounts();
  };
  paintSeg();

  const run = async () => {
    mail.digest = null;
    if (mail.rankState && !mail.rankState.busy) mail.rankState = null;
    root.classList.remove('reading');
    paintHead(null);
    paintSplitNav(null);
    if (mail.mailbox === 'scheduled') { list.replaceChildren(skeleton(3)); await scheduledList(list, run); counts.scheduled = list.querySelectorAll('.mail-sched').length; paintCounts(); paintToday(); return; }
    if (mail.mailbox === 'team') { list.replaceChildren(skeleton(4)); await teamList(list); counts.team = mail.teamItems ? mail.teamItems.length : 0; paintCounts(); paintToday(); return; }
    if (mail.mailbox === 'sent') loadReceipts();
    // Speed (mail-cache.js): the list as last shown, at once; then Gmail is asked what changed
    // (one call when nothing did) and the list read again only if something did.
    const my = (mail.runId = (mail.runId || 0) + 1);
    const gEmail = (mail.google && mail.google.email) || '';
    const key = listKey(mail.source, !multi() ? mail.account || gEmail : mail.box === 'all' ? 'all' : mail.box === PRIMARY ? gEmail : mail.box, mail.mailbox);
    const stopPanel = timing('panel');
    const show = (rows) => {
      const inView = multi() ? new Set(viewBoxes()) : null; // a saved list may hold an account removed since
      mail.rows = rows.filter((r) => !inView || inView.has(r.box || homeBox())).map(normMsg);
      tagBoxes(mail.rows);
      counts[mail.mailbox] = mail.mailbox === 'inbox' ? (mail.query ? counts.inbox : visibleRows().filter((m) => m.unread).length) : mail.rows.length;
      paintCounts();
      drawList();
    };
    const cached = mail.query ? null : await getList(key);
    if (my !== mail.runId) return;
    let shown = false;
    if (cached && Array.isArray(cached.rows)) { mail.sel = -1; show(cached.rows); stopPanel(); shown = true; prefetch(); }
    else list.replaceChildren(skeleton());
    const after = () => {
      if (mail.ranked && mail.mailbox === 'inbox') rankInbox();
      if (mail.mailbox === 'inbox' && !mail.query) { wakeSnoozes(); checkFollowUps(); runRules(); loadServerDrafts().then(autoDrafts); loadPromises(); autoBrief(); }
    };
    try {
      if (shown && mail.source === 'gmail' && (cached.historyId || cached.historyIds)) {
        const stop = timing('refresh');
        const same = await historyUnchanged(cached);
        stop();
        if (my !== mail.runId) return;
        if (same) { after(); return; } // nothing changed: the cache is the mailbox (each one, in All inboxes)
      }
      const args = { mailbox: mail.mailbox, limit: 30, ...(mail.query ? { query: mail.query } : {}), ...(mail.account ? { account: mail.account } : {}) };
      const [res, prof] = await Promise.all([src.search(args), mail.source === 'gmail' && !mail.query ? historyMarks() : null]);
      if (my !== mail.runId) return;
      const { rows, text } = res;
      if (!rows) { mail.rows = []; list.replaceChildren(el('p', { class: 'note-full' }, text || 'Nothing found.')); return; }
      if (!shown) mail.sel = -1;
      const keepOpen = mail.open;
      show(rows);
      if (keepOpen) mail.open = keepOpen;
      if (!shown) stopPanel();
      if (!mail.query) putList(key, { rows, ...(prof || { historyId: null }) });
      prefetch();
      after();
    } catch (e) { if (!shown) list.replaceChildren(el('div', 'sp-warn', el('b', '', 'Couldn’t read Mail'), e.message)); else toast(`Couldn’t refresh Mail: ${e.message}`); }
  };

  /** The list: Eden's card, the digest, then the messages by day (or by rank). */
  const drawList = () => {
    const inbox = mail.mailbox === 'inbox';
    const all = inbox ? visibleRows() : mail.rows;
    // the sidebar's unread per account: every one from All inboxes, or the one in view
    if (multi() && inbox && !mail.query) { mail.boxUnread = mail.box === 'all' ? unreadByBox(all) : { ...mail.boxUnread, [mail.box]: all.filter((m) => m.unread).length }; paintAccts(); }
    const splitOn = inbox && !mail.query && prefs().split;
    const bySplit = splitOn ? splitRows(all) : null;
    if (splitOn && (!mail.split || !bySplit[mail.split])) mail.split = SPLITS.map(([id]) => id).find((id) => bySplit[id].length) || 'important';
    const rows = splitOn ? bySplit[mail.split] : all;
    paintHead(rows);
    paintSplitNav(bySplit);
    paintToday();
    const parts = [];
    if (multi() && mail.boxErrors.length) parts.push(boxProblems(mail.boxErrors));
    if (splitOn) parts.push(splitBar(bySplit)); // (a narrow panel's; the sidebar has them on a wide one)
    if (inbox && !mail.query && (!splitOn || mail.split === 'important')) parts.push(...attentionGroups(), promiseStrip());
    if (mail.digest) parts.push(digestCard());
    if (!rows.length) {
      parts.push(mail.query ? emptyState('search', 'No mail matches that', `Nothing in ${boxes.find(([b]) => b === mail.mailbox)?.[1] || 'this mailbox'} for “${mail.query}”.`)
        : emptyState(FOLDER_ICO[mail.mailbox] || 'mail', inbox ? 'You’re all caught up' : 'Nothing here', inbox ? 'New mail lands here. Eden can draft and schedule replies for you.' : null));
      list.replaceChildren(...parts.filter(Boolean));
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
    list.replaceChildren(...parts.filter(Boolean)); // (a null would show as the text "null")
    paintSel();
  };
  const rankMap = () => { const m = new Map(); for (const r of mail.rows) { const v = rankCache.get(ck(r.id)); if (v) m.set(String(r.id), v); } return m; };

  const row = (m, rank) => {
    const out = mail.mailbox === 'drafts' || mail.mailbox === 'sent';
    const peer = out ? (m.to[0] || '') : m.from;
    const name = out ? (m.to.length ? `${tx('To')} ${m.to.map(nameOf).join(', ')}` : '(no recipient)') : nameOf(m.from) || '(unknown sender)';
    const open = () => (m.draftId ? openCompose({ source: 'gmail', draftId: m.draftId, mailbox: m.box || homeBox() }) : openMessage(body, m));
    const r = el('div', { class: `mail-row${m.unread ? ' unread' : ''}${mail.open === m.id ? ' sel' : ''}`, 'data-id': m.id },
      el('button', { type: 'button', class: 'mr-main', onclick: open, 'aria-label': `${m.unread ? 'Unread. ' : ''}${name}: ${m.subject}` },
        avatar(peer || name),
        el('span', 'mr-txt',
          el('span', 'mr-top', el('b', { class: 'mr-n', title: out ? m.to.join(', ') : m.from, 'data-no-i18n': '' }, PLACEHOLDER.has(name) ? tx(name) : name), !out && !safeForAuto(shieldOf(m)) ? el('span', { class: 'mail-badge sus', title: shieldOf(m).map((x) => x.text).join(' ') }, '⚠ Suspicious') : null, m.labels.includes('STARRED') ? ico('star', 12, 'mr-star') : null, m.attachments.length ? ico('clip', 12, 'mr-clip') : null, multi() && mail.box === 'all' ? rowMark(m) : null, el('span', 'mr-d', rowDate(m.date))),
          el('span', 'mr-s', own('span', '', m.subject), m.scheduledAt ? el('span', 'mail-badge', `Scheduled · ${when(m.scheduledAt)}`) : null, out ? receiptBadge(m) : null, !out && (autoCache.get(ck(m.id))?.text || bgDraft(m)) ? el('span', { class: 'mail-badge ad', title: 'Eden wrote a reply in your style: open the email to review it' }, '✦ Draft ready') : null),
          rank && rank.reason ? el('span', 'mr-p mr-why', rankPill(rank), own('span', '', rank.reason)) : m.snippet ? own('span', 'mr-p', m.snippet) : null)),
      m.draftId || out ? null : el('div', 'mr-acts',
        mail.mailbox === 'inbox' ? iconBtn('done', 'Done (E)', () => doneRows([m])) : null,
        mail.mailbox === 'inbox' ? iconBtn('clock', 'Remind me (H)', (e) => snoozeMenu([m], e.currentTarget)) : null,
        iconBtn('reply', 'Reply', () => quick(m, 'reply')),
        iconBtn('spark', 'Draft a reply with Eden', () => quick(m, 'ai')),
        iconBtn('chat', 'Ask Eden about it', () => quick(m, 'ask'))));
    return r;
  };
  /** A row's quick action: the full message is read first (a reply quotes it). */
  const quick = async (m, what) => {
    let msg = m;
    try { const j = await readCached(m.id); msg = merge(m, j); } catch (e) { toast(`Couldn’t open the message: ${e.message}`); return; }
    if (what === 'ask') H.askEden(msg);
    else openCompose({ source: mail.source, account: msg.account || mail.account, mode: 'reply', message: msg, ...(what === 'ai' ? { ai: 'reply' } : {}) });
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
      let ranks = parseRanks((await askEden(withContentLang(RANK_SYSTEM), 'Inbox: emails to rank', mailLines(todo))).out, ids);
      if (!ranks.size) ranks = parseRanks((await askEden(`${withContentLang(RANK_SYSTEM)}\nYour last answer wasn’t that JSON object. Reply with the JSON object only.`, 'Inbox: emails to rank', mailLines(todo))).out, ids);
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
      const { out, model } = await askEden(withContentLang(DIGEST_SYSTEM), 'Inbox: emails to summarize', mailLines(pick));
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
      d.state === 'ready' && d.overview ? own('p', 'dg-over', d.overview) : null,
      d.state === 'ready' && d.bullets.length ? el('ul', 'dg-list', ...d.bullets.map((b) => {
        const m = byId.get(b.id);
        return el('li', '', el('button', { type: 'button', class: 'dg-b', disabled: !m, onclick: () => m && openMessage(body, m) },
          m ? avatar(m.from) : el('span', 'dg-dot'),
          el('span', 'dg-t', b.who ? own('b', '', `${b.who}: `) : null, own('span', '', b.gist), b.needsReply ? el('span', 'rk rk-reply', 'Needs reply') : null)));
      })) : null,
      d.state === 'ready' && !d.bullets.length && !d.overview ? el('p', 'dg-over', 'Nothing here needs your attention.') : null,
      d.state !== 'loading' ? el('div', 'dg-foot', el('span', '', `Made by AI from senders, subjects and previews${d.model ? ` · ${d.model}` : ''}. Kept on this device.`),
        el('button', { type: 'button', class: 'cap', onclick: () => runDigest(true) }, ico('retry', 12), ' Summarize again')) : null);
  };

  mail.refresh = run;
  mail.redraw = () => { if (document.contains(list) && mail.mailbox !== 'scheduled' && mail.rows) drawList(); };
  mail.list = list;
  mail.quick = quick;
  mail.paintCounts = paintCounts;
  mail.body = body;
  mail.readPane = read;
  mail.root = root;
  mail.search = q;
  mail.paintSeg = paintSeg;
  folders.addEventListener('click', (e) => { const b = e.target.closest('[data-box]'); if (!b) return; mail.mailbox = b.dataset.box; leavePage(); paintSeg(); run(); });
  // Up and down (left and right on a narrow bar) move through the mailboxes and views; Enter or a click opens one.
  folders.addEventListener('keydown', (e) => {
    const step = { ArrowDown: 1, ArrowRight: 1, ArrowUp: -1, ArrowLeft: -1 }[e.key];
    if (!step) return;
    e.preventDefault();
    const bs = [...folders.querySelectorAll('.mx-nv')];
    const i = bs.indexOf(document.activeElement);
    bs[(i + step + bs.length) % bs.length].focus();
  });
  // A question ("when is the offsite?") goes to Ask your inbox on Enter; words search as you type.
  const askHint = el('button', { type: 'button', class: 'mx-askhint', hidden: true, onclick: () => openAsk(q.value.trim()) }, ico('spark', 12), el('span', '', 'Ask Eden'), el('kbd', '', '↵'));
  askHint.title = 'Ask Eden across all your mail (Enter)';
  srow.append(askHint);
  q.addEventListener('input', debounce(() => {
    const v = q.value.trim();
    askHint.hidden = !isQuestion(v);
    if (isQuestion(v)) return;
    mail.query = v; run();
  }, 400));
  q.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    const v = q.value.trim();
    if (isQuestion(v) || e.shiftKey) { openAsk(v); return; }
    mail.query = v; run();
  });
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
// 3.8 Flash first: it scores highest and costs the same as 3.7/3.6 (3.5 Flash is dropped: worse at twice the price).
// Flash-Lite is the last resort only (owner, 2026-11-10: quality over pennies).
const MAIL_MODELS = ['gemini-4-hydrogen', 'gemini-3.7-flash', 'gemini-3.6-flash', 'gemini-3.5-flash-lite'];
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
  if (!privateMail() && (!settings.providers || !settings.providers.length)) throw new Error('no model is available. Add a key in Settings.');
  const override = privateMail() ? null : mailModel();
  let out = '', model = '', cost, notional = false;
  const t0 = Date.now();
  await api.send({ messages: [{ role: 'user', content: 'Do it for the emails in the context. Follow the answer format exactly.' }], context: [{ title, text, source: 'mail' }], system, settings, mode: 'chat', ...(override ? { override } : {}), ...mailAI() }, {
    onEvent: (t, d) => {
      if (t === 'route') model = d.modelName || d.model || '';
      else if (t === 'text') { out += d.text || ''; if (onText) onText(out, model); }
      else if (t === 'usage' && d && typeof d.costUSD === 'number') { cost = (cost || 0) + d.costUSD; notional = notional || !!d.notional; }
      else if (t === 'error') throw new Error(d.message || 'Eden couldn’t do that.');
    },
  });
  return { out: out.trim(), model, cost, notional, ms: Date.now() - t0 };
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
  // no Gmail: nothing can be scheduled (the note below says so)
  try { jobs = !hasGmail() && multi() ? [] : ((await gmail('scheduled', {}, PRIMARY)) || {}).jobs || []; } catch (e) { res.replaceChildren(el('div', 'sp-warn', el('b', '', 'Couldn’t read the schedule'), e.message)); return; }
  const note = el('p', 'sp-note', !hasGmail() && multi()
    ? 'Scheduled send needs a Gmail account for now: add one under Accounts to schedule. Your other accounts send right away.'
    : state.meta && state.meta.hosted
    ? 'Your askeden.com account sends each one at its time, even with your Mac off. Each waits in your Gmail Drafts until then; cancelling leaves it there.'
    : 'Eden holds these on your Mac and sends each one at its time, only while Eden is running. Each waits in your Gmail Drafts until then; cancelling leaves it there.');
  if (!jobs.length) { res.replaceChildren(emptyState('clock', 'Nothing scheduled', 'In a compose window, open the arrow next to Send › Schedule send.'), note); return; }
  const order = (j) => (j.status === 'scheduled' || j.status === 'sending' ? 0 : 1);
  jobs.sort((a, b) => order(a) - order(b) || (order(a) ? b.sendAt.localeCompare(a.sendAt) : a.sendAt.localeCompare(b.sendAt)));
  res.replaceChildren(...jobs.map((j) => {
    const [label, cls] = STATUS[j.status] || [j.status, ''];
    const open = j.status !== 'sent' && j.status !== 'sending';
    return el('div', { class: 'mail-sched' },
      el('div', 'ms-top', avatar(j.to[0] || '?'), own('b', '', j.subject || '(no subject)'), el('span', `mail-badge ${cls}`, label), el('span', 'ms-when', when(j.status === 'sent' && j.sentAt ? j.sentAt : j.sendAt))),
      own('div', 'ms-sub', j.to.length ? `${tx('To')} ${j.to.join(', ')}` : '(no recipient)'),
      j.error ? el('div', 'ms-err', j.error) : null,
      open ? el('div', 'ms-acts',
        el('button', { type: 'button', class: 'cap', onclick: () => openCompose({ source: 'gmail', draftId: j.draftId, mailbox: PRIMARY }) }, 'Open draft'),
        j.status !== 'cancelled' ? el('button', { type: 'button', class: 'cap rev', onclick: async () => { try { await gmail('cancelScheduled', { id: j.id }, PRIMARY); toast('Cancelled: the email stays in Drafts'); again(); } catch (e) { toast(`Couldn’t cancel: ${e.message}`); } } }, 'Cancel schedule') : null) : null);
  }), note);
}

/** The reading pane (beside the list on a wide panel; on its own on a phone, with ‹ Back). */
async function openMessage(body, m) {
  const pane = mail.readPane, root = mail.root;
  if (!pane || !document.contains(pane)) return;
  mail.open = m.id;
  if (mail.view && mail.view !== 'list') { mail.view = 'list'; root.classList.remove('page'); if (mail.paintSeg) mail.paintSeg(); }
  root.querySelectorAll('.mail-row').forEach((r) => r.classList.toggle('sel', r.dataset.id === String(m.id)));
  root.classList.add('reading');
  pane.hidden = false;
  const back = el('button', { type: 'button', class: 'cap mx-back', onclick: () => { root.classList.remove('reading'); mail.open = null; root.querySelectorAll('.mail-row.sel').forEach((r) => r.classList.remove('sel')); const r = root.querySelector(`.mail-row[data-id="${CSS.escape(String(m.id))}"] .mr-main`); if (r) r.focus(); else focusMail(body); } }, ico('chevl', 14), 'Back');
  const view = el('div', { class: 'mail-view', 'aria-live': 'polite' }, el('div', 'mv-skel', el('span', 'sk l1'), el('span', 'sk l2'), el('span', 'sk l3'), el('span', 'sk l2')));
  const bar = el('div', { class: 'mail-top mv-top mv-bar', role: 'toolbar', 'aria-label': 'Email actions' }, back); // filled once the email is read
  pane.replaceChildren(bar, view);
  pane.scrollTop = 0;
  if (getComputedStyle(back).display !== 'none') back.focus();
  let msg = m;
  const stopOpen = timing('open');
  try { msg = merge(m, await readCached(m.id)); } catch (e) { view.replaceChildren(el('div', 'sp-warn', el('b', '', 'Couldn’t open the message'), e.message)); return; }
  if (mail.open !== m.id) return;
  if (!msg.account && mail.account) msg.account = mail.account;
  if (m.unread) { // read now: the row and the Inbox count say so (and Gmail, when Eden may change labels)
    m.unread = false;
    if (mail.source === 'gmail' && mail.canModify !== false) modify([m.id], [], ['UNREAD']).catch(() => {});
    if (mail.source === 'mac') call('mail_triage', { action: 'mark_read', message_ids: [m.id], confirm: true }).catch(() => {});
    const r = root.querySelector(`.mail-row[data-id="${CSS.escape(String(m.id))}"]`);
    if (r) r.classList.remove('unread');
    const counts = mail.counts[mail.source] || {};
    if (mail.mailbox === 'inbox' && counts.inbox) { counts.inbox--; const c = root.querySelector('[data-count="inbox"]'); if (c) { c.textContent = counts.inbox ? String(counts.inbox) : ''; c.hidden = !counts.inbox; } }
    if (mail.redraw) mail.redraw(); // the list head's and the split inbox's unread counts
  }
  const rank = rankCache.get(ck(msg.id));
  const dateText = msg.date ? (Number.isNaN(Date.parse(msg.date)) ? msg.date : new Date(msg.date).toLocaleString(locale(), { dateStyle: 'medium', timeStyle: 'short' })) : '';
  const meta = el('div', 'mv-from', avatar(msg.from, true),
    el('div', 'mv-who', el('div', 'mv-n', own('b', '', nameOf(msg.from) || '(unknown sender)'), own('span', 'mv-e', emailOf(msg.from))),
      el('div', 'mail-meta', msg.to.length ? el('div', '', el('span', 'k', 'To'), own('span', '', msg.to.join(', '))) : null, msg.cc.length ? el('div', '', el('span', 'k', 'Cc'), own('span', '', msg.cc.join(', '))) : null,
        multi() ? el('div', 'mv-acct', el('span', 'k', 'Account'), boxDot(msg.box || boxFor(msg.id)), own('span', '', nameOfBox(msg.box || boxFor(msg.id)))) : null)),
    el('span', 'mv-date', dateText));
  const compose = (mode, extra = {}) => openCompose({ source: mail.source, account: msg.account || mail.account, mode, message: msg, ...extra });
  const isMacDraft = mail.source === 'mac' && mail.mailbox === 'drafts';
  const allCount = msg.to.length + msg.cc.length;
  const sumBox = el('div', { class: 'mx-sum', hidden: true, 'aria-live': 'polite' });
  const summarize = async (again) => {
    sumBox.hidden = false;
    const hit = !again && sumCache.get(ck(msg.id));
    // (replaceChildren turns a null into the text "null": the parts not shown are dropped first)
    const paint = (text, x, done) => sumBox.replaceChildren(...[
      el('div', 'dg-head', ico('spark', 15), el('b', '', 'Summary'), el('span', 'dg-scope', ''), iconBtn('x', 'Close the summary', () => { sumBox.hidden = true; })),
      text ? el('div', { class: 'mx-sum-t', 'data-no-i18n': '' }, renderMarkdown(text)) : el('div', { class: 'dg-load', role: 'status' }, 'Reading the email…', el('span', 'sk l1'), el('span', 'sk l2')),
      done ? el('div', 'dg-foot', metaLine('Made by AI from this email', x, 'kept on this device'),
        el('button', { type: 'button', class: 'cap', onclick: () => H.summarize(msg) }, ico('chat', 12), ' Continue in chat'),
        el('button', { type: 'button', class: 'cap', onclick: () => summarize(true) }, ico('retry', 12), ' Again')) : null].filter(Boolean));
    if (hit) { paint(hit.text, hit, true); return; }
    paint('', {}, false);
    try {
      let raf = 0;
      const r = await askEden([SUMMARY_SYSTEM, replyLanguageNote()].filter(Boolean).join('\n'), `Email: ${msg.subject}`.slice(0, 120), emailText(msg).slice(0, 20_000), (t, mdl) => { if (!raf) raf = requestAnimationFrame(() => { raf = 0; paint(t, { model: mdl }, false); }); });
      if (raf) cancelAnimationFrame(raf);
      if (!r.out) throw new Error('Eden sent back nothing.');
      const x = { text: r.out, model: r.model, cost: r.cost, notional: r.notional, ms: r.ms };
      sumCache.set(ck(msg.id), x);
      paint(r.out, x, true);
    } catch (e) { sumBox.replaceChildren(el('div', 'dg-head', ico('spark', 15), el('b', '', 'Summary'), el('span', 'dg-scope', ''), iconBtn('x', 'Close', () => { sumBox.hidden = true; })), el('p', { class: 'dg-err', role: 'alert' }, `The summary couldn’t be made: ${e.message}`)); }
  };
  const btn = (icon, label, onclick, cls = 'btn') => el('button', { type: 'button', class: cls, onclick }, ico(icon, 14), el('span', '', label));
  // The toolbar (glass, on top): reply and forward on the left, Done, Remind me, Star and Share on the right.
  const tb = (icon, label, onclick) => el('button', { type: 'button', class: 'mv-tb', title: label, onclick }, ico(icon, 15), el('span', '', label));
  bar.append(...[
    isMacDraft ? el('button', { type: 'button', class: 'btn primary', onclick: () => openCompose({ source: 'mac', account: msg.account, to: msg.to, cc: msg.cc, subject: msg.subject === '(no subject)' ? '' : msg.subject, body: msg.body }) }, ico('edit', 14), el('span', '', 'Edit draft')) : null,
    isMacDraft ? null : tb('reply', 'Reply', () => compose('reply')),
    isMacDraft || allCount < 2 ? null : tb('replyall', 'Reply all', () => compose('replyAll')),
    isMacDraft ? null : tb('fwd', 'Forward', () => compose('forward')),
    el('span', 'grow'),
    mail.mailbox === 'inbox' ? tb('done', DONE, () => doneRows([m])) : null,
    mail.mailbox === 'inbox' ? tb('clock', 'Remind me', (e) => snoozeMenu([m], e.currentTarget)) : null,
    tb('star', m.labels.includes('STARRED') ? (mail.source === 'gmail' ? 'Unstar' : 'Unflag') : (mail.source === 'gmail' ? 'Star' : 'Flag'), () => toggleStar(m)),
    mail.source === 'gmail' && teamMail.available() && msg.threadId && (msg.box || boxFor(msg.id)) === PRIMARY ? tb('user', 'Share with team', () => shareThread(msg)) : null].filter(Boolean));
  // Eden's card: what it noticed (the rank's reason), and one blue action, Draft a reply (unless a reply is already drafted below).
  const ahead = isMacDraft ? null : autoDraftCard(msg);
  const canDraft = !isMacDraft && safeForAuto(shieldOf(msg));
  const eden = el('section', { class: 'mv-eden', 'aria-label': 'Eden' },
    el('p', 'mx-kick', ico('spark', 14), rank && rank.reason ? 'Eden noticed' : 'Eden'),
    rank && rank.reason ? own('p', 'mv-eden-t', rank.reason) : null,
    el('div', 'mx-acts',
      canDraft ? btn('edit', 'Draft a reply', () => compose('reply', { ai: 'reply' }), ahead ? 'btn' : 'btn primary') : null,
      btn('doc', 'Summarize', () => summarize(false)),
      btn('chat', 'Ask Eden', () => H.askEden(msg)),
      isMacDraft ? null : btn('cal', 'Add to calendar', () => addToCalendar(msg))));
  view.replaceChildren(...[
    el('div', 'mv-subj-row', own('h3', 'mail-subj', msg.subject), rankPill(rank)),
    meta,
    shieldBanner(msg),
    bookCard(msg),
    unsubBar(msg),
    receiptLine(msg),
    teamNote(msg),
    senderCard(msg),
    eden,
    inviteCard(msg),
    sumBox,
    el('div', { class: 'note-full mail-body', tabindex: '0', 'aria-label': 'Message' }, msg.body || msg.snippet || tx('(empty message)')),
    msg.attachments.length ? el('div', 'mv-atts', ...msg.attachments.map((a) => el('span', { class: 'mv-att', 'data-no-i18n': '' }, ico('clip', 14), a))) : null,
    ahead,
    isMacDraft || ahead || !canDraft ? null : instantBox(msg),
    isMacDraft ? el('p', 'sp-note', 'Saving from Eden makes a new draft in Mail; Eden can’t edit this one in place.') : null].filter(Boolean));
  stopOpen();
  if (sumCache.get(ck(msg.id))) summarize(false); // already summarized: shown again, not billed again
  prefetch();
}

/* ---------------- invitations and "Add to calendar" ---------------- */

const INV_WORD = { accepted: 'Going', declined: 'Not going', tentative: 'Maybe', needsAction: 'Not answered yet', delegated: 'Delegated' };
const icsWhen = (ev) => { const d = icsToDraft(ev); return d ? timeText({ allDay: d.allDay, start: d.allDay ? ymdOf(d.start) : d.start.toISOString(), end: d.allDay ? ymdOf(d.end) : d.end.toISOString() }, locale()) : ''; };
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
  const mine = [mail.google && mail.google.email, msg.account, ...mailboxes().map((b) => b.email), ...((msg.to || []).length === 1 ? msg.to : [])].map((a) => emailOf(String(a || '')) || String(a || '')).filter(Boolean);
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
    el('h4', { class: 'inv-title', 'data-no-i18n': '' }, ev.summary || tx('(No title)')),
    el('div', 'inv-row', ico('clock', 13), el('span', '', icsWhen(ev)), ev.rrule ? el('small', '', ' · repeats') : null),
    ev.location ? el('div', 'inv-row', ico('globe', 13), own('span', '', ev.location)) : null,
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
    if (r && r.url) {
      if (MAIL_ONLY) try { sessionStorage.setItem('eden:mail-only-return', '1'); } catch { /* blocked */ } // back to /mail after (app.js)
      location.assign(r.url); // top level: Google comes back to /#gmail=…
    }
    else toast('Couldn’t start the Google sign-in');
  } catch (e) { toast(`Couldn’t connect Gmail: ${e.message}`); }
}

export function initMail(handlers) {
  H = handlers;
  setMailkitHandlers({ openDialog: handlers.openDialog, closeDialog: handlers.closeDialog });
  onKit(() => { if (mail.redraw) mail.redraw(); });
  addEventListener('keydown', onMailKey);
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

/** The list | reading-pane divider: drag to set the list's width (kept in this browser), double-click to reset. */
function splitter(root, main, list, handle) {
  const KEY = 'eden:mail:listW';
  const place = () => { handle.style.left = `${list.offsetWidth}px`; };
  const set = (px) => {
    const max = Math.max(330, main.clientWidth - 360);
    const w = Math.round(Math.min(max, Math.max(260, px)));
    main.style.setProperty('--mx-list-w', `${w}px`);
    place();
    return w;
  };
  try { const saved = Number(localStorage.getItem(KEY)); if (saved > 0) main.style.setProperty('--mx-list-w', `${saved}px`); } catch { /* blocked */ }
  if (typeof ResizeObserver === 'function') new ResizeObserver(place).observe(list);
  handle.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    handle.setPointerCapture(e.pointerId);
    handle.classList.add('drag');
    root.classList.add('resizing');
    const left = main.getBoundingClientRect().left;
    let w = list.offsetWidth;
    const move = (ev) => { w = set(ev.clientX - left); };
    const up = () => {
      handle.removeEventListener('pointermove', move);
      handle.classList.remove('drag');
      root.classList.remove('resizing');
      try { localStorage.setItem(KEY, String(w)); } catch { /* blocked */ }
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', up, { once: true });
    handle.addEventListener('pointercancel', up, { once: true });
  });
  handle.addEventListener('dblclick', () => {
    main.style.removeProperty('--mx-list-w');
    try { localStorage.removeItem(KEY); } catch { /* blocked */ }
    requestAnimationFrame(place);
  });
  handle.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    const w = set(list.offsetWidth + (e.key === 'ArrowRight' ? 24 : -24));
    try { localStorage.setItem(KEY, String(w)); } catch { /* blocked */ }
  });
  handle.tabIndex = 0;
}

/* ================= Superhuman-style triage (mailkit.js holds the state, mail-voice.js the logic) ================= */

/** How to read the owner's sent mail for learning their style: Gmail (up to 8 pages of 40: 320) or Mail on your Mac (through Eden Secretary: 50). */
function samplesFrom(source) {
  if (source === 'gmail') return async (onCount) => {
    const out = [];
    let pageToken;
    for (let i = 0; i < 8 && out.length < 300; i++) {
      const r = await gmail('voiceSamples', { limit: 40, ...(pageToken ? { pageToken } : {}) }, homeBox());
      out.push(...((r && r.samples) || []));
      if (onCount) onCount(out.length);
      pageToken = r && r.nextPageToken;
      if (!pageToken) break;
    }
    return out;
  };
  return async (onCount) => {
    const { rows } = await SOURCES.mac.search({ mailbox: 'sent', limit: 50 });
    const out = [];
    for (const r of (rows || []).map(normMsg).slice(0, 50)) {
      try {
        const m = merge(r, await SOURCES.mac.read(r.id));
        out.push({ id: m.id, to: m.to.map(emailOf), subject: m.subject, date: m.date, text: m.body, reply: /^\s*re\s*:/i.test(m.subject) });
        if (onCount) onCount(out.length);
      } catch { /* one unreadable message */ }
    }
    return out;
  };
}

/** The inbox without what's Done in Eden or snoozed until later. */
function visibleRows() {
  const now = Date.now();
  const reminded = new Set(mail.reminders.filter((r) => r.source === mail.source).map((r) => String(r.id)));
  return (mail.rows || []).filter((m) => { const z = snoozedOf(ck(m.id)); return !isDone(ck(m.id)) && !(z && Date.parse(z.until) > now) && !reminded.has(String(m.id)); });
}
function splitRows(rows) {
  const ctx = { known: mail.known || new Set(), vips: vips() };
  const out = Object.fromEntries(SPLITS.map(([id]) => [id, []]));
  for (const m of rows) out[splitOf(m, ctx)].push(m);
  return out;
}
function splitBar(bySplit) {
  return el('div', { class: 'mx-splits', role: 'tablist', 'aria-label': 'Split inbox' },
    ...SPLITS.map(([id, label], i) => {
      const n = bySplit[id].length, unread = bySplit[id].filter((m) => m.unread).length;
      return el('button', { type: 'button', role: 'tab', class: `mx-sp${mail.split === id ? ' on' : ''}`, 'aria-selected': String(mail.split === id), title: `${label} (${i + 1})`,
        onclick: () => { mail.split = id; mail.sel = -1; mail.redraw(); } }, el('span', '', label), n ? el('span', `n${unread ? ' unread' : ''}`, String(unread || n)) : null);
    }));
}

/** Reminders (snoozes now due) and follow-ups nobody answered: at the top of Important. */
function attentionGroups() {
  const out = [];
  const rem = mail.reminders.filter((r) => r.source === mail.source);
  if (rem.length) out.push(el('section', { class: 'mx-group mx-attn', 'aria-label': 'Reminders' }, el('h4', 'mx-day attn', ico('bell', 12), el('span', '', 'Reminders'), el('span', 'n', String(rem.length))),
    ...rem.map((r) => el('div', 'mail-row attn', el('button', { type: 'button', class: 'mr-main', onclick: () => { mail.reminders = mail.reminders.filter((x) => x !== r); openMessage(mail.body, normMsg({ ...r, id: r.id })); } },
      avatar(r.from || '?'), el('span', 'mr-txt', el('span', 'mr-top', own('b', 'mr-n', nameOf(r.from) || '(unknown sender)'), el('span', 'mr-d', 'Reminder')), own('span', 'mr-s', r.subject || '(no subject)'), r.snippet ? own('span', 'mr-p', r.snippet) : null)),
    el('div', 'mr-acts', iconBtn('x', 'Dismiss the reminder', () => { mail.reminders = mail.reminders.filter((x) => x !== r); mail.redraw(); }))))));
  if (mail.nudges.length && mail.source === 'gmail') out.push(el('section', { class: 'mx-group mx-attn', 'aria-label': 'No reply yet' }, el('h4', 'mx-day attn', ico('clock', 12), el('span', '', 'No reply yet'), el('span', 'n', String(mail.nudges.length))),
    ...mail.nudges.map(({ f, lastId }) => el('div', 'mail-row attn', el('div', 'mr-main', avatar(f.to[0] || '?'),
      el('span', 'mr-txt', el('span', 'mr-top', own('b', 'mr-n', `${tx('To')} ${f.to.join(', ') || tx('(no recipient)')}`), el('span', 'mr-d', `Sent ${rowDate(f.sentAt)}`)), own('span', 'mr-s', f.subject), el('span', 'mr-p', 'Nobody has replied yet.'))),
    el('div', 'mr-acts on',
      el('button', { type: 'button', class: 'mx-chip accent', onclick: async () => {
        try { const m = merge(normMsg({ id: lastId }), await SOURCES.gmail.read(lastId)); openCompose({ source: 'gmail', mode: 'reply', message: m, ai: 'reply', aiPrompt: 'a short, friendly follow-up: I’m checking in on my last email, since I haven’t heard back' }); } catch (e) { toast(`Couldn’t open it: ${e.message}`); }
      } }, ico('spark', 13), el('span', '', 'Nudge')),
      iconBtn('x', 'Stop reminding me', () => { dropFollowUp(f.id); mail.nudges = mail.nudges.filter((x) => x.f !== f); mail.redraw(); }))))));
  return out;
}

/** Snoozes now due come back: into Gmail's inbox again (unread), and to the top as reminders. */
async function wakeSnoozes() {
  const kit = getKit();
  const due = dueSnoozes(kit.snoozed).filter((k) => k.startsWith(`${mail.source}:`));
  if (!due.length) return;
  const items = due.map((k) => { const p = parseBoxKey(k); return { key: k, ...kit.snoozed[k], id: p.id, box: p.box }; });
  const ids = items.map((x) => x.id);
  for (const x of items) mail.idBox.set(String(x.id), x.box); // modify() groups them by mailbox
  if (mail.source === 'gmail' && mail.canModify !== false) await modify(ids, ['INBOX', 'UNREAD'], []).catch(() => {});
  for (const x of items) unsnooze(x.key);
  mail.reminders.push(...items.map((x) => ({ id: x.id, box: x.box, source: mail.source, from: x.from, subject: x.subject, snippet: x.snippet, date: x.date, threadId: x.threadId })));
  toast(items.length === 1 ? `Reminder: ${items[0].subject || 'an email'} is back` : `${items.length} snoozed emails are back`);
  mail.redraw();
}

/** Follow-ups now due: if nobody else wrote in the thread since, it shows under "No reply yet". */
async function checkFollowUps() {
  if (mail.source !== 'gmail') return;
  const due = (getKit().followups || []).filter((f) => f.source === 'gmail' && Date.parse(f.dueAt) <= Date.now()).slice(0, 20);
  if (!due.length) { mail.nudges = []; return; }
  const byBox = new Map(); // a follow-up is checked in the mailbox it was sent from (compose.js records it)
  for (const f of due) { const b = isExtra(f.box) ? f.box : homeBox(); if (!byBox.has(b)) byBox.set(b, []); byBox.get(b).push(f); }
  const nudges = [];
  let any = false;
  for (const [box, fs] of byBox) {
    let r;
    try { r = await gmail('threads', { ids: fs.map((f) => f.threadId) }, box); any = true; } catch { continue; }
    const me = box === PRIMARY ? (mail.google && mail.google.email) || '' : (mailboxById(box) || {}).email || '';
    const byId = new Map(((r && r.threads) || []).map((t) => [t.id, t]));
    for (const f of fs) {
      const t = byId.get(f.threadId);
      if (!t || t.missing) { dropFollowUp(f.id); continue; }
      const st = followUpState(f, t, me);
      if (st === 'replied') dropFollowUp(f.id);
      else if (st === 'nudge') { const lastId = t.messages[t.messages.length - 1].id; mail.idBox.set(String(lastId), box); nudges.push({ f, lastId }); }
    }
  }
  if (!any) return;
  mail.nudges = nudges;
  mail.redraw();
}

/** Gmail labels (Done, snooze, star, read). A 403 means the grant has no gmail.modify: Eden keeps it itself from then on. */
async function modify(ids, add, remove) {
  try {
    let r;
    for (const [box, part] of groupByBox(ids, boxFor)) r = await gmail('modify', { ids: part, add, remove }, box); // rows from several accounts: one call each
    mail.canModify = true;
    return r;
  } catch (e) {
    if (e.status === 403 || /scope|permission|insufficient/i.test(e.message)) {
      mail.canModify = false;
    }
    throw e;
  }
}

/** Done (E): out of the inbox. Gmail archives it (labels only: nothing is deleted); else Eden hides it. Undo with Z. */
async function doneRows(ms, { snoozing = false, quiet = false } = {}) {
  if (!ms.length) return;
  const keys = ms.map((m) => ck(m.id));
  const stopAct = timing('action');
  const idx = Math.max(0, mail.sel);
  if (!snoozing) markDone(keys); // hidden at once; replaced by Gmail's archive when that works
  if (mail.open && ms.some((m) => m.id === mail.open)) closeReader();
  mail.sel = Math.min(idx, visibleRows().length - 1);
  mail.redraw();
  stopAct();
  let archived = false;
  if (mail.source === 'gmail' && mail.canModify !== false) {
    try { await modify(ms.map((m) => m.id), [], ['INBOX']); archived = true; } catch { /* kept in Eden */ }
  }
  if (archived) { mail.rows = mail.rows.filter((r) => !ms.includes(r)); if (!snoozing) markDone(keys, false); mail.redraw(); }
  // Mail on your Mac: Eden Secretary archives it in Mail once the Undo has had its moment (Mail has no "unarchive" script)
  if (mail.source === 'mac' && !snoozing) setTimeout(async () => {
    if (!keys.every((k) => isDone(k))) return; // undone meanwhile
    try { await call('mail_triage', { action: 'archive', message_ids: ms.map((m) => m.id), confirm: true }); mail.rows = mail.rows.filter((r) => !ms.includes(r)); markDone(keys, false); }
    catch { /* an older Eden, or Mail said no: kept in Eden */ }
  }, 6000);
  const undo = async () => {
    if (archived) await modify(ms.map((m) => m.id), ['INBOX'], []).catch(() => {});
    if (!mail.rows.some((r) => ms.includes(r))) mail.rows = [...mail.rows, ...ms];
    markDone(keys, false);
    for (const k of keys) unsnooze(k);
    mail.redraw();
  };
  mail.undo = undo;
  const where = archived ? ' · archived in Gmail' : mail.source === 'mac' ? ' · Mail on your Mac archives it in a few seconds' : mail.source === 'gmail' ? (state.meta && state.meta.hosted ? ' · kept in Eden' : ' · kept in Eden (reconnect Gmail in Settings › Accounts & memory to archive there too)') : ' · kept in Eden';
  if (!snoozing && !quiet) { toast(`${ms.length === 1 ? 'Done' : `${ms.length} done`}${where}`, { label: 'Undo', run: undo }); announce(`${ms.length === 1 ? `Done: ${ms[0].subject}` : `${ms.length} emails done`}. Z to undo.`); }
}

/** Remind me (H): out of the inbox until a time, then back on top. */
function snoozeMenu(ms, anchor) {
  const pop = el('div', { class: 'mx-pop glass', role: 'menu', 'aria-label': 'Remind me' });
  const close = () => { pop.remove(); removeEventListener('pointerdown', outside, true); removeEventListener('keydown', esc, true); if (anchor && document.contains(anchor)) anchor.focus(); };
  const outside = (e) => { if (!pop.contains(e.target)) close(); };
  const esc = (e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); } };
  const choose = (at) => {
    if (!(at instanceof Date) || Number.isNaN(at.getTime()) || at.getTime() < Date.now() + 60_000) { toast('Pick a time at least a minute from now'); return; }
    close();
    for (const m of ms) kitSnooze(ck(m.id), { until: at.toISOString(), from: m.from, subject: m.subject, snippet: m.snippet, date: m.date, threadId: m.threadId });
    doneRows(ms, { snoozing: true });
    toast(`Snoozed until ${when(at)}`, { label: 'Undo', run: () => mail.undo && mail.undo() });
  };
  const custom = el('input', { type: 'datetime-local', 'aria-label': 'Pick a date and time' });
  const pad = (n) => String(n).padStart(2, '0');
  const local = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const t = new Date(Date.now() + 86_400_000); t.setHours(9, 0, 0, 0);
  custom.value = local(t);
  pop.append(el('div', 'mx-pop-h', 'Remind me'),
    ...snoozeChoices().map((c, i) => el('button', { type: 'button', role: 'menuitem', class: 'mx-mi', onclick: () => choose(c.at) }, el('span', 'grow', c.label), el('span', 'mx-mi-k', i < 9 ? when(c.at) : ''))),
    el('div', 'mx-pop-row', custom, el('button', { type: 'button', class: 'btn primary', onclick: () => choose(new Date(custom.value)) }, 'Set')));
  document.body.append(pop);
  placePopup(pop, anchor || mail.root, 'below');
  addEventListener('pointerdown', outside, true);
  addEventListener('keydown', esc, true);
  requestAnimationFrame(() => { const b = pop.querySelector('button'); if (b) b.focus(); });
  pop.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    const bs = [...pop.querySelectorAll('button')];
    const i = bs.indexOf(document.activeElement);
    bs[(i + (e.key === 'ArrowDown' ? 1 : bs.length - 1)) % bs.length].focus();
  });
}

async function toggleStar(m, { quiet = false } = {}) {
  const on = !m.labels.includes('STARRED');
  if (mail.source === 'mac') { // a flag in Mail on your Mac (Eden's mail_triage)
    try { toast(await call('mail_triage', { action: on ? 'flag' : 'unflag', message_ids: [m.id], confirm: true })); m.labels = on ? [...m.labels, 'STARRED'] : m.labels.filter((l) => l !== 'STARRED'); mail.redraw(); }
    catch (e) { toast(`Couldn’t flag it: ${e.message}`); }
    return;
  }
  m.labels = on ? [...m.labels, 'STARRED'] : m.labels.filter((l) => l !== 'STARRED');
  mail.redraw();
  if (mail.open === m.id) openMessage(mail.body, m);
  try { await modify([m.id], on ? ['STARRED'] : [], on ? [] : ['STARRED']); if (!quiet) { toast(on ? 'Starred' : 'Star removed'); announce(on ? 'Starred' : 'Star removed'); } }
  catch (e) { m.labels = on ? m.labels.filter((l) => l !== 'STARRED') : [...m.labels, 'STARRED']; mail.redraw(); if (mail.canModify !== false) toast(`Couldn’t star it: ${e.message}`); }
}
async function setUnread(m, unread, { quiet = false } = {}) {
  m.unread = unread;
  mail.redraw();
  if (mail.source === 'gmail' && mail.canModify !== false) modify([m.id], unread ? ['UNREAD'] : [], unread ? [] : ['UNREAD']).catch(() => {});
  if (mail.source === 'mac') call('mail_triage', { action: unread ? 'mark_unread' : 'mark_read', message_ids: [m.id], confirm: true }).catch(() => {});
  if (!quiet) { toast(unread ? 'Marked unread' : 'Marked read'); announce(unread ? 'Marked unread' : 'Marked read'); }
}

function closeReader() {
  if (!mail.root) return;
  mail.root.classList.remove('reading', 'page');
  mail.open = null;
  mail.view = 'list';
  if (mail.paintSeg) mail.paintSeg();
  if (mail.readPane) mail.readPane.replaceChildren(readEmpty());
  if (mail.redraw) mail.redraw(); // the sidebar's split marks the list again
}

/* ---------- keyboard (Superhuman's): j k Enter u e h s r a f c / 1–4 z ? ---------- */

const rowEls = () => (mail.list ? [...mail.list.querySelectorAll('.mx-group:not(.mx-attn) .mail-row')] : []);
const rowMsg = (r) => r && mail.rows.find((m) => String(m.id) === r.dataset.id);
function paintSel() {
  const rs = rowEls();
  rs.forEach((r, i) => r.classList.toggle('kb', i === mail.sel));
  const r = rs[mail.sel];
  if (r) r.scrollIntoView({ block: 'nearest' });
}
function current() {
  if (mail.open) return mail.rows.find((m) => m.id === mail.open) || null;
  return rowMsg(rowEls()[mail.sel]);
}
function typing(t) {
  return t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || t.closest('.cw, [role="dialog"], .dlg, .mx-pop'));
}
function onMailKey(e) {
  if (e.metaKey || e.ctrlKey || e.altKey || e.defaultPrevented) return;
  if (!mail.root || !document.contains(mail.root) || mail.root.closest('[hidden]') || !document.getElementById('spacePanel')?.classList.contains('open')) return;
  if (typing(e.target) || document.getElementById('dlg')?.classList.contains('open')) return;
  const k = e.key;
  const rs = rowEls();
  const move = (d) => { if (!rs.length) return; mail.sel = Math.max(0, Math.min(rs.length - 1, (mail.sel < 0 ? (d > 0 ? -1 : rs.length) : mail.sel) + d)); paintSel(); const m = rowMsg(rs[mail.sel]); if (m) announce(`${m.unread ? 'Unread. ' : ''}${nameOf(m.from)}: ${m.subject}. ${mail.sel + 1} of ${rs.length}.`); if (mail.open && m) openMessage(mail.body, m); };
  const m = current();
  const inbox = mail.mailbox === 'inbox';
  const run = (fn) => { e.preventDefault(); fn(); };
  switch (k) {
    case 'j': case 'ArrowDown': return run(() => move(1));
    case 'k': case 'ArrowUp': return run(() => move(-1));
    case 'Enter': case 'o': if (!mail.open && m) run(() => (m.draftId ? openCompose({ source: 'gmail', draftId: m.draftId, mailbox: m.box || homeBox() }) : openMessage(mail.body, m))); return;
    case 'u': case 'Escape': if (mail.open) run(() => { closeReader(); paintSel(); }); return;
    case 'e': if (inbox && m) run(() => doneRows([m])); return;
    case 'h': if (inbox && m) run(() => snoozeMenu([m], (rs[mail.sel] || mail.root).querySelector('.mr-main') || mail.root)); return;
    case 's': if (m && !m.draftId) run(() => toggleStar(m)); return;
    case 'U': if (m) run(() => setUnread(m, true)); return;
    case 'I': if (m) run(() => setUnread(m, false)); return;
    case 'r': if (m && !m.draftId) run(() => mail.quick(m, 'reply')); return;
    case 'a': if (m && !m.draftId) run(async () => { const full = merge(m, await SOURCES[mail.source].read(m.id).catch(() => ({}))); openCompose({ source: mail.source, account: full.account || mail.account, mode: 'replyAll', message: full }); }); return;
    case 'f': if (m && !m.draftId) run(async () => { const full = merge(m, await SOURCES[mail.source].read(m.id).catch(() => ({}))); openCompose({ source: mail.source, account: full.account || mail.account, mode: 'forward', message: full }); }); return;
    case 'c': return run(() => openCompose({ source: mail.source, account: mail.account }));
    case '/': if (mail.search) run(() => { mail.search.focus(); mail.search.select(); }); return;
    case 'z': if (mail.undo) run(() => { const u = mail.undo; mail.undo = null; u(); toast('Undone'); }); return;
    case '[': return run(() => setRail());
    case '?': return run(() => H.openDialog('Mail shortcuts', shortcutsNode()));
    case 'v': return run(() => readInbox());
    case '1': case '2': case '3': case '4': if (inbox && prefs().split) run(() => { mail.split = SPLITS[Number(k) - 1][0]; mail.sel = -1; closeReader(); mail.redraw(); }); return;
    default:
  }
}

/* ---------- reading pane extras ---------- */

/** Unsubscribe in one click: the sender's https page in a new tab, or an email to their unsubscribe address (reviewed before it goes). */
function unsubBar(msg) {
  const u = msg.unsubscribe;
  if (!u || (!u.url && !u.mailto)) return null;
  const go = () => {
    if (u.url) { window.open(u.url, '_blank', 'noopener,noreferrer'); toast('The sender’s unsubscribe page opened in a new tab'); return; }
    const mt = /^mailto:([^?]+)(?:\?(.*))?$/i.exec(u.mailto);
    if (!mt) return;
    const q = new URLSearchParams(mt[2] || '');
    openCompose({ source: mail.source, account: mail.account, to: [decodeURIComponent(mt[1])], subject: q.get('subject') || 'Unsubscribe', body: q.get('body') || 'Please unsubscribe me from this list.' });
  };
  return el('div', 'mv-unsub', ico('unsub', 13), el('span', '', 'A mailing list.'), el('button', { type: 'button', class: 'cap', onclick: go }, 'Unsubscribe'),
    mail.mailbox === 'inbox' ? el('button', { type: 'button', class: 'cap', onclick: () => { const m = mail.rows.find((x) => x.id === msg.id); if (m) doneRows([m]); } }, DONE) : null);
}

const senderCache = new Map();
/** About the sender (Superhuman's sidebar): your recent emails with them, and how you usually write to them. */
function senderCard(msg) {
  if (mail.source !== 'gmail') return null;
  const addr = emailOf(msg.from);
  const me = mail.google && mail.google.email ? mail.google.email.toLowerCase() : '';
  if (!addr || !addr.includes('@') || addr === me || msg.unsubscribe) return null;
  // Relationship memory (ROADMAP P3): what you last discussed, promises between you, meetings ahead, notes, how you write to them
  const owe = (mail.promises || []).filter((p) => emailOf(p.who) === addr);
  const box = el('details', 'mv-sender');
  const sumText = el('span', '', own('span', '', `${nameOf(msg.from)} · ${addr.split('@')[1]}`), owe.length ? ` · ${owe.length} promise${owe.length === 1 ? '' : 's'}` : '');
  const sum = el('summary', '', ico('user', 13), sumText);
  const body = el('div', 'mv-sender-b', el('span', 'sk l2'));
  box.append(sum, body);
  box.addEventListener('toggle', async () => {
    if (!box.open || box.dataset.loaded) return;
    box.dataset.loaded = '1';
    let rows = senderCache.get(addr);
    if (!rows) {
      try { const b = msg.box || boxFor(msg.id); const r = await gmail('search', { query: `from:${addr} OR to:${addr}`, limit: 8 }, b); rows = (arrayIn(r, ['messages']) || []).map((x) => ({ ...x, box: b })); tagBoxes(rows); senderCache.set(addr, rows); }
      catch (e) { body.replaceChildren(el('p', 'muted', `Couldn’t look them up: ${e.message}`)); return; }
    }
    const p = getKit().voice?.stats?.perPerson?.[addr];
    const fromThem = rows.filter((r) => emailOf(r.from) === addr).length;
    const others = rows.filter((r) => String(r.id) !== String(msg.id));
    const meetings = el('div', 'mv-rel-sec');
    const notes = el('div', 'mv-rel-sec');
    body.replaceChildren(...[
      others[0] ? el('p', 'mv-sender-n', el('b', '', 'Last time: '), own('span', '', others[0].subject || '(no subject)'), ` (${rowDate(others[0].date)})`) : null,
      el('p', 'mv-sender-n', rows.length ? `${rows.length} recent email${rows.length === 1 ? '' : 's'} between you (${fromThem} from them, ${rows.length - fromThem} from you).` : 'No other recent emails between you.'),
      owe.length ? el('div', 'mv-rel-sec', el('b', '', 'Promises between you'), el('ul', '', ...owe.slice(0, 4).map((x) => el('li', '', `${x.mine ? 'You' : 'They'}: `, own('span', '', x.text), x.due ? ` (${x.overdue ? 'overdue, ' : ''}${rowDate(new Date(x.due).toISOString())})` : '')))) : null,
      meetings, notes,
      p ? el('p', 'mv-sender-n', `You usually write to them “${p.greeting || 'no greeting'}” … “${p.signoff || 'no sign-off'}”, about ${p.words} words.`) : null,
      el('ul', 'mv-sender-l', ...others.slice(0, 6).map((r) => el('li', '', el('button', { type: 'button', class: 'cap', onclick: () => openMessage(mail.body, normMsg(r)) },
        el('span', 'grow', emailOf(r.from) === addr ? '' : 'You: ', own('span', '', r.subject || '(no subject)')), el('span', 'muted', rowDate(r.date)))))),
    ].filter(Boolean));
    // meetings with them in the next 30 days (Google Calendar), and notes that mention them (Second Brain, on the Mac)
    (async () => {
      try {
        const r = await postJSON('/api/chat/gcal', { action: 'events', args: { start: new Date().toISOString(), end: new Date(Date.now() + 30 * 86_400_000).toISOString() } });
        const mine = ((r && r.events) || []).filter((e) => (e.attendees || []).some((a) => String(a.email || '').toLowerCase() === addr)).slice(0, 3);
        if (mine.length && document.contains(meetings)) meetings.replaceChildren(el('b', '', 'Meetings ahead'), el('ul', '', ...mine.map((e) => own('li', '', `${e.title} · ${new Date(e.start).toLocaleString(locale(), { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}`))));
      } catch { /* no calendar */ }
    })();
    if (H.jarvisAvailable && H.jarvisAvailable()) (async () => {
      try {
        const text = await call('search_notes', { query: nameOf(msg.from) || addr });
        const j = parseJSON(text);
        const hits = (arrayIn(j, ['results', 'items', 'notes']) || []).slice(0, 3);
        if (hits.length && document.contains(notes)) notes.replaceChildren(el('b', '', 'In your notes'), el('ul', '', ...hits.map((h) => own('li', '', String(h.title || h.name || tx('A note')).slice(0, 80)))));
      } catch { /* Eden said no, or nothing */ }
    })();
  });
  return box;
}

/** Instant replies: three short replies in the owner's style, one click opens it (never sent unseen). */
function instantBox(msg) {
  if (!prefs().instant || msg.unsubscribe || mail.mailbox !== 'inbox') return null;
  const addr = emailOf(msg.from);
  const me = mail.google && mail.google.email ? mail.google.email.toLowerCase() : '';
  if (!addr || addr === me || /(^|[.+_-])(no-?reply|do-?not-?reply|notifications?|mailer-daemon)([.+_-]|@)/i.test(addr)) return null;
  const box = el('div', { class: 'mv-instant', 'aria-live': 'polite' });
  const paint = (replies, note) => box.replaceChildren(...[
    el('span', 'mv-instant-l', ico('spark', 12), voiceOn() ? 'Reply in your style' : 'Quick replies'),
    ...replies.map((t) => el('button', { type: 'button', class: 'mx-chip mv-ir', title: t, 'data-no-i18n': '', onclick: () => openCompose({ source: mail.source, account: msg.account || mail.account, mode: 'reply', message: msg, body: t }) }, t)),
    note ? el('span', 'muted', note) : null].filter(Boolean));
  const hit = instantCache.get(ck(msg.id));
  if (hit) { paint(hit); return box; }
  paint([], 'Thinking of replies…');
  (async () => {
    try {
      const v = await voiceFor({ to: [addr], about: `${msg.subject} ${msg.body || msg.snippet}`.slice(0, 3000), reply: true, withFrame: false });
      const sys = v.on ? `${INSTANT_SYSTEM}\n\n${v.system}` : INSTANT_SYSTEM;
      const { out } = await askCheap(sys, 'Suggest the three replies as the JSON object.', [{ title: `The email: ${msg.subject}`.slice(0, 120), text: emailText(msg).slice(0, 12_000) }, ...v.context.slice(0, 3)]);
      const replies = parseInstant(out);
      if (!replies.length) throw new Error('no replies');
      instantCache.set(ck(msg.id), replies);
      if (document.contains(box)) paint(replies);
    } catch { box.remove(); }
  })();
  return box;
}


/* ================= Ask your mail: Eden across the whole mailbox (mail-ask.js) ================= */

let askRun = 0;
const ASK_IDEAS = ['What’s my latest email?', 'Who’s waiting on a reply from me?', 'Any receipts or invoices this week?', 'When is my next trip?'];
/**
 * Ask your inbox: a page of its own, centred. The question box, a few questions to start from, then Eden's answers
 * (newest on top; this visit's earlier ones stay).
 */
function openAsk(question = '') {
  const pane = mail.readPane, root = mail.root;
  if (!pane || !document.contains(pane)) return;
  mail.open = null;
  mail.view = 'ask';
  root.classList.add('reading', 'page');
  root.querySelectorAll('.mail-row.sel').forEach((r) => r.classList.remove('sel'));
  if (mail.paintSeg) mail.paintSeg();
  if (mail.redraw) mail.redraw();
  pane.hidden = false;
  const back = el('button', { type: 'button', class: 'cap mx-back', onclick: () => closeReader() }, ico('chevl', 14), 'Back');
  const input = el('input', { class: 'ak-q', type: 'search', placeholder: 'Ask anything about your mail', 'aria-label': 'Ask a question about your mail', enterkeyhint: 'search', autocomplete: 'off' });
  const thread = el('div', { class: 'ak-thread' });
  const page = el('div', 'mx-page mx-askp');
  const go = (q = input.value.trim()) => { if (!q) { input.focus(); return; } input.value = ''; page.classList.add('asked'); askMail(q, thread, input); };
  const form = el('form', { class: 'ak-box', onsubmit: (e) => { e.preventDefault(); go(); } }, ico('spark', 18), input, el('button', { type: 'submit', class: 'btn primary' }, 'Ask'));
  page.append(
    el('div', 'ak-hero', el('p', 'mx-k', 'Ask your inbox'), el('h2', 'mx-big', 'What do you want to know?'), el('p', 'ak-sub', 'Eden searches your mail and answers with the emails it used.')),
    form,
    el('div', 'ak-ideas', ...ASK_IDEAS.map((t) => el('button', { type: 'button', class: 'ak-idea', onclick: () => go(t) }, t))),
    thread);
  if (mail.askThread && mail.askThread.length) { page.classList.add('asked'); thread.append(...mail.askThread); }
  pane.replaceChildren(el('div', 'mail-top mv-top', back), page);
  pane.scrollTop = 0;
  if (question) go(question); else input.focus();
}
/** Numbers like [2] in the answer become small source marks. */
function markCitations(node, n) {
  const walk = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
  const hits = [];
  for (let t = walk.nextNode(); t; t = walk.nextNode()) if (/\[\d{1,2}\]/.test(t.nodeValue)) hits.push(t);
  for (const t of hits) {
    const frag = document.createDocumentFragment();
    for (const part of t.nodeValue.split(/(\[\d{1,2}\])/)) {
      const m = /^\[(\d{1,2})\]$/.exec(part);
      if (m && Number(m[1]) >= 1 && Number(m[1]) <= n) frag.append(el('span', { class: 'cite', title: `Source ${m[1]}` }, m[1]));
      else if (part) frag.append(document.createTextNode(part));
    }
    t.replaceWith(frag);
  }
}
/** Mail on your Mac: up to `max` emails, read in full, from these mailboxes (newest first when there's no query). */
async function macFind(query, boxes, max, seen = new Set()) {
  const out = [];
  for (const box of boxes) {
    const { rows } = await SOURCES.mac.search({ mailbox: box, limit: 6, ...(query ? { query } : {}) }).catch(() => ({ rows: [] }));
    for (const r of (rows || []).map(normMsg)) {
      if (seen.has(r.id) || seen.size >= max) continue;
      seen.add(r.id);
      try { out.push(merge(r, await SOURCES.mac.read(r.id))); } catch { out.push(r); }
    }
  }
  return out;
}
/**
 * Eden searches the mailbox for the question, reads what it finds and answers, with the emails as sources. A question
 * about the newest mail ("what's my latest email?"), or one no search matches, is answered from the inbox's newest emails.
 */
async function askMail(question, host, input) {
  if (!question || !host) return;
  const my = ++askRun;
  const card = el('section', { class: 'ak-ans', role: 'region', 'aria-label': `Eden’s answer: ${question.slice(0, 80)}` });
  const status = el('div', { class: 'dg-load', role: 'status' }, 'Looking through your mail…', el('span', 'sk l1'), el('span', 'sk l2'), el('span', 'sk l3'));
  card.append(el('div', 'ak-qh', ico('spark', 15), own('h3', '', question)), status);
  host.prepend(card);
  mail.askThread = [card, ...(mail.askThread || []).filter((c) => c !== card)].slice(0, 6);
  [...host.children].slice(6).forEach((c) => c.remove());
  const say = (t) => { status.firstChild.textContent = t; };
  const t0 = Date.now();
  const newest = wantsNewest(question);
  let searches = 0, fellBack = false, readNewest = false;
  try {
    let found = [];
    if (mail.source === 'gmail') {
      let queries = [];
      if (!newest) {
        try { queries = parseQueries((await askCheap(querySystem(), question, [])).out); } catch { /* the key words then */ }
        if (!queries.length) queries = [keywordQuery(question)].filter(Boolean);
      }
      const seen = new Set();
      for (const query of queries) {
        say(`Searching: ${query}`);
        let r;
        searches++;
        try { r = await searchFullAll(query, 8); } catch { continue; }
        for (const m of (r && r.messages) || []) if (!seen.has(m.id) && seen.size < 15) { seen.add(m.id); found.push(m); }
        if (my !== askRun) return;
      }
      if (!found.length && queries.length && queries[0] !== keywordQuery(question) && keywordQuery(question)) {
        searches++;
        const r = await searchFullAll(keywordQuery(question), 8).catch(() => null);
        found = (r && r.messages) || [];
      }
      if (!found.length) { // nothing to search for, or nothing matched: the inbox's newest emails
        say(newest ? 'Reading your newest emails…' : 'No search matched. Reading your newest emails…');
        const r = await searchFullAll('in:inbox', 10).catch(() => null);
        found = (r && r.messages) || [];
        readNewest = true; fellBack = !newest;
      }
    } else {
      const query = newest ? '' : keywordQuery(question, 3);
      say(query ? `Searching Mail on your Mac: ${query}` : 'Reading your newest emails…');
      if (query) { searches = 2; found = await macFind(query, ['inbox', 'sent'], 10); }
      if (!found.length) { found = await macFind('', ['inbox'], 10); readNewest = true; fellBack = !!query; }
    }
    if (my !== askRun && !document.contains(card)) return;
    if (!found.length) { status.replaceWith(el('p', 'ak-none', 'Eden couldn’t read any email to answer from. Check that your mail is connected, then try again.')); return; }
    const { list: sources, context } = sourcesContext(found);
    say(`Reading ${sources.length} email${sources.length === 1 ? '' : 's'}…`);
    const answer = el('div', { class: 'mx-sum-t ak-t', 'data-no-i18n': '' });
    let out = '', model = '', frame = 0, cost, notional = false;
    const paint = () => { frame = 0; answer.replaceChildren(renderMarkdown(out)); };
    const note = readNewest ? '\nThese are the inbox’s newest emails, newest first ([1] is the latest).' : '';
    await api.send({ messages: [{ role: 'user', content: question }], context: context.map((c) => ({ ...c, source: 'mail' })), system: [ANSWER_SYSTEM + note, replyLanguageNote()].filter(Boolean).join('\n'), settings: routeSettings(), mode: 'chat', ...mailAI() }, {
      onEvent: (t, d) => {
        if (t === 'route') { model = d.modelName || d.model || ''; say(`${model} is reading ${sources.length} emails…`); }
        else if (t === 'text') { if (!out) status.replaceWith(answer); out += d.text || ''; if (!frame) frame = requestAnimationFrame(paint); }
        else if (t === 'usage' && d && typeof d.costUSD === 'number') { cost = (cost || 0) + d.costUSD; notional = notional || !!d.notional; }
        else if (t === 'error') throw new Error(d.message || 'Eden couldn’t answer.');
      },
    });
    if (frame) cancelAnimationFrame(frame);
    if (!out.trim()) throw new Error('Eden sent back nothing.');
    paint();
    markCitations(answer, sources.length);
    const cited = citations(out, sources.length);
    const order = [...cited, ...sources.map((_, i) => i + 1).filter((n) => !cited.includes(n))];
    const n = sources.length, s = n === 1 ? '' : 's';
    const lead = readNewest ? `${fellBack ? 'No search matched, so Eden read' : 'Read'} your ${n} newest email${s}` : `Searched your mail ${searches} time${searches === 1 ? '' : 's'} and read ${n} email${s}`;
    card.append(
      el('p', 'ak-src-h', cited.length ? 'Sources' : 'Emails Eden read'),
      el('div', 'ak-src', ...order.slice(0, cited.length ? 6 : 4).map((i) => {
        const m = sources[i - 1];
        return el('button', { type: 'button', class: 'ak-s', 'data-no-i18n': '', onclick: () => openMessage(mail.body, normMsg(m)) },
          el('span', 'cite', String(i)), avatar(m.from), el('span', 't', el('b', '', nameOf(m.from) || tx('(unknown)')), el('span', '', `${m.subject || tx('(no subject)')} · ${rowDate(m.date)}`)), ico('chevr', 14));
      })),
      metaLine(lead, { model, cost, notional, ms: Date.now() - t0 }, 'check the sources'),
      el('div', 'mx-acts', el('button', { type: 'button', class: 'mx-link', onclick: () => { if (input) { input.focus(); input.scrollIntoView({ block: 'center', behavior: 'smooth' }); } } }, 'Ask a follow-up')));
  } catch (e) {
    if (document.contains(status)) status.replaceWith(el('p', { class: 'dg-err', role: 'alert' }, `Eden couldn’t answer: ${e.message}`));
    else card.append(el('p', { class: 'dg-err', role: 'alert' }, `Eden couldn’t finish: ${e.message}`));
  }
}

/* ================= Team: shared threads with comments (spaces.js teamMail, askeden.com) ================= */

/** Opens Mail on the Team folder and that thread (from a space's "Open in Mail"). */
export function queueTeamOpen(detail) { mail.source = 'gmail'; mail.mailbox = 'team'; mail.pendingTeam = detail; }

async function teamList(list) {
  let items;
  try { items = await teamMail.list(); } catch (e) { list.replaceChildren(el('div', 'sp-warn', el('b', '', 'Couldn’t read your team spaces'), e.message)); return; }
  mail.teamItems = items;
  mail.teamIndex = new Map(items.map((t) => [t.threadId, t]));
  if (!items.length) {
    list.replaceChildren(emptyState('user', 'Nothing shared with your team yet', 'Open an email and press Share with team: everyone in the space can read the thread and comment. It’s end-to-end encrypted with the space’s key.'));
    return;
  }
  list.replaceChildren(el('section', { class: 'mx-group', 'aria-label': 'Shared with your team' }, el('h4', 'mx-day', el('span', '', 'Shared with your team'), el('span', 'n', String(items.length))),
    ...items.map((t) => el('div', { class: 'mail-row', 'data-team': t.id },
      el('button', { type: 'button', class: 'mr-main', onclick: () => openTeam(t.space.id, t.id) },
        avatar(t.by || '?'),
        el('span', 'mr-txt',
          el('span', 'mr-top', own('b', 'mr-n', t.title), el('span', 'mr-d', rowDate(new Date(t.updated).toISOString()))),
          el('span', 'mr-s', `${t.space.name} · shared by ${t.by} · ${t.comments} comment${t.comments === 1 ? '' : 's'}`),
          t.last ? own('span', 'mr-p', t.last) : null))))));
  if (mail.pendingTeam) { const p = mail.pendingTeam; mail.pendingTeam = null; openTeam(p.space, p.id); }
}

/** A shared thread in the reading pane: its messages, the team's comments, and a box to add one. */
async function openTeam(spaceId, id) {
  const pane = mail.readPane, root = mail.root;
  if (!pane || !document.contains(pane)) return;
  root.classList.add('reading');
  pane.hidden = false;
  mail.open = null;
  const back = el('button', { type: 'button', class: 'cap mx-back', onclick: () => closeReader() }, ico('chevl', 14), 'Back');
  const view = el('div', { class: 'mail-view', 'aria-live': 'polite' }, el('div', 'mv-skel', el('span', 'sk l1'), el('span', 'sk l2'), el('span', 'sk l3')));
  pane.replaceChildren(el('div', 'mail-top mv-top', back), view);
  let got;
  try { got = await teamMail.get(spaceId, id); } catch (e) { view.replaceChildren(el('div', 'sp-warn', el('b', '', 'Couldn’t open it'), e.message)); return; }
  const paint = (value) => {
    const th = value.thread || { messages: [] };
    const comments = el('div', 'mt-comments', ...(value.comments || []).map((c) => el('div', 'mt-c',
      el('div', 'mt-c-h', avatar(c.label, false), own('b', '', c.label), el('span', 'muted', when(c.at)),
        c.member === got.me.member ? iconBtn('trash', 'Delete your comment', async () => { try { paint(await teamMail.comment(spaceId, id, '', { remove: c.id })); } catch (e) { toast(e.message); } }) : null),
      own('div', 'mt-c-t', c.text))), (value.comments || []).length ? null : el('p', 'muted', 'No comments yet. Start the conversation for your team.'));
    const box = el('textarea', { rows: '2', class: 'mt-in', placeholder: 'Comment for your team… (⌘↵ to post)', 'aria-label': 'Comment for your team', maxlength: '2000' });
    const post = async () => {
      const t = box.value.trim();
      if (!t) return;
      box.disabled = true;
      try { const next = await teamMail.comment(spaceId, id, t); paint(next); syncTeamRow(id, next); } catch (e) { toast(`Couldn’t post it: ${e.message}`); box.disabled = false; }
    };
    box.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); post(); } });
    view.replaceChildren(
      el('div', 'mv-subj-row', own('h3', 'mail-subj', th.subject || '(no subject)'), own('span', 'mail-badge', got.space.name)),
      el('p', 'mv-why', `Shared by ${value.by || 'a member'} · ${th.messages.length} message${th.messages.length === 1 ? '' : 's'} · end-to-end encrypted`),
      ...th.messages.map((m) => el('article', 'mt-msg',
        el('div', 'mv-from', avatar(m.from), el('div', 'mv-who', el('div', 'mv-n', own('b', '', nameOf(m.from)), own('span', 'mv-e', emailOf(m.from))), m.to ? el('div', 'mail-meta', el('div', '', el('span', 'k', 'To'), own('span', '', String(m.to)))) : null), el('span', 'mv-date', m.date ? new Date(m.date).toLocaleString(locale(), { dateStyle: 'medium', timeStyle: 'short' }) : '')),
        el('div', { class: 'note-full mail-body', tabindex: '0' }, m.body || ''),
        (m.attachments || []).length ? el('div', 'mv-atts', ...m.attachments.map((a) => el('span', { class: 'mv-att', 'data-no-i18n': '' }, ico('clip', 13), a))) : null)),
      el('h4', 'mt-h', ico('chat', 13), `Team comments (${(value.comments || []).length})`),
      comments,
      el('div', 'mt-new', box, el('button', { type: 'button', class: 'btn primary', onclick: post }, 'Comment')));
  };
  paint(got.value);
}

/** The Team list's row for a thread, after a comment here (no reload of the list). */
function syncTeamRow(id, value) {
  const t = (mail.teamItems || []).find((x) => x.id === id);
  if (!t) return;
  const last = (value.comments || [])[value.comments.length - 1];
  Object.assign(t, { comments: (value.comments || []).length, last: last ? `${last.label}: ${last.text}`.slice(0, 120) : '', updated: Date.now() });
  const r = mail.list && mail.list.querySelector(`[data-team="${CSS.escape(id)}"]`);
  if (!r) return;
  r.querySelector('.mr-s').textContent = `${t.space.name} · shared by ${t.by} · ${t.comments} comment${t.comments === 1 ? '' : 's'}`;
  const p = r.querySelector('.mr-p') || r.querySelector('.mr-txt').appendChild(el('span', 'mr-p'));
  p.textContent = t.last;
}

async function shareThread(msg) {
  try {
    toast('Reading the whole thread…');
    const t = await gmail('thread', { id: msg.threadId }, PRIMARY);
    const shared = await teamMail.share({ threadId: msg.threadId, subject: msg.subject, messages: (t && t.messages) || [] });
    if (!shared) return;
    mail.teamIndex = null;
    toast(`${tx('Shared with')} ${shared.space.name}`, { label: 'Open', run: () => { mail.mailbox = 'team'; mail.pendingTeam = { space: shared.space.id, id: shared.id }; if (mail.body) mailPanel(mail.body); } });
  } catch (e) { toast(`Couldn’t share it: ${e.message}`); }
}

/** Under a message whose thread the team has: how many comments, and a link to them. */
function teamNote(msg) {
  if (mail.source !== 'gmail' || !teamMail.available() || !msg.threadId) return null;
  const box = el('div', { class: 'mv-team', hidden: true });
  (async () => {
    if (!mail.teamIndex) { try { const items = await teamMail.list(); mail.teamIndex = new Map(items.map((t) => [t.threadId, t])); } catch { return; } }
    const t = mail.teamIndex.get(String(msg.threadId).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 37)) || mail.teamIndex.get(teamItemId(msg.threadId).slice(3));
    if (!t || !document.contains(box)) return;
    box.replaceChildren(ico('user', 13), el('span', '', `Shared in ${t.space.name} · ${t.comments} comment${t.comments === 1 ? '' : 's'}${t.last ? ` · ${t.last}` : ''}`), el('button', { type: 'button', class: 'cap', onclick: () => openTeam(t.space.id, t.id) }, 'Open'));
    box.hidden = false;
  })();
  return box;
}

/* ================= Read receipts (askeden.com: accounts/receipts.js) ================= */

async function loadReceipts() {
  if (!teamMail.available() || mail.source !== 'gmail') return;
  try {
    const r = await getJSON('/api/chat/receipts');
    const byThread = new Map();
    for (const x of (r && r.receipts) || []) if (x.thread && !byThread.has(x.thread)) byThread.set(x.thread, x);
    mail.receipts = byThread;
    // opens since this browser last looked: a toast
    let seen = 0;
    try { seen = Number(localStorage.getItem('eden:mail:rcptSeen')) || 0; } catch { /* blocked */ }
    const fresh = ((r && r.receipts) || []).filter((x) => x.opens.some((o) => o.at > seen && o.via !== 'apple'));
    if (seen && fresh.length) toast(fresh.length === 1 ? `“${fresh[0].subject || 'Your email'}” was opened` : `${fresh.length} of your emails were opened`);
    try { localStorage.setItem('eden:mail:rcptSeen', String(Date.now())); } catch { /* blocked */ }
    if (mail.redraw) mail.redraw();
  } catch { /* an older server, or signed out */ }
}
function receiptBadge(m) {
  const r = mail.receipts && m.threadId && mail.receipts.get(m.threadId);
  if (!r) return null;
  const n = r.opens.length;
  return el('span', { class: `mail-badge rc${n ? ' ok' : ''}`, title: receiptText(r, Date.now(), locale()) }, n ? `Opened${n > 1 ? ` ${n}×` : ''}` : 'Not opened');
}
function receiptLine(msg) {
  const r = mail.receipts && msg.threadId && mail.receipts.get(msg.threadId);
  if (!r) return null;
  return el('div', 'mv-rcpt', ico('check', 13), el('span', '', receiptText(r, Date.now(), locale())));
}


/* ================= Speed: emails read ahead, opened from the cache (mail-cache.js) ================= */

/** An email's full text: this browser's copy when it has one (an email doesn't change), else Gmail's / your Mac's, kept. */
async function readCached(id) {
  const key = ck(id);
  const hit = await getMsg(key);
  if (hit) return { ...hit, unread: undefined, read: undefined, labels: undefined, labelIds: undefined }; // the row's own read state and labels are newer
  const j = await SOURCES[mail.source].read(id);
  if (j && typeof j === 'object') putMsg(key, j);
  return j;
}
let prefetching = null;
/** The next few emails the owner is likely to open (after the one selected, else the newest unread), read ahead quietly. */
function prefetch() {
  if (prefetching || !mail.rows || !mail.rows.length || mail.source !== 'gmail') return;
  const rows = visibleRows();
  const from = Math.max(0, rows.findIndex((m) => String(m.id) === String(mail.open)) + 1);
  const next = [...rows.slice(from, from + 3), ...rows.filter((m) => m.unread).slice(0, 3)].filter((m, i, a) => !m.draftId && a.indexOf(m) === i).slice(0, 4);
  prefetching = (async () => {
    for (const m of next) {
      const key = ck(m.id);
      if (await getMsg(key)) continue;
      try { const j = await SOURCES[mail.source].read(m.id); if (j && typeof j === 'object') await putMsg(key, j); } catch { /* read when opened */ }
    }
  })().finally(() => { prefetching = null; });
}


/* ================= Auto Drafts (ROADMAP P1): replies written ahead, in the owner's voice ================= */
// The inbox's emails that need a reply (Rank by priority's "urgent" / "needs reply", from a person,
// in the last 4 days, not answered yet) get a reply written ahead by draftReplyText (compose.js):
// "✦ Draft ready" on the row, the draft on top of the email, "Open draft" puts it in a compose
// window to review and send. Nothing is saved to Gmail or sent. At most prefs().autoDraftsPerDay a
// day (each is one routed AI turn); edits to them count in the score (Mail settings).

const ROBOT_ADDR = /(^|[.+_-])(no-?reply|do-?not-?reply|notifications?|mailer-daemon|bounces?|news(letter)?|digest|marketing|receipts?|billing|alerts?)([.+_-]|@)/i;
const AUTO_DAY = isMock ? 'eden:mail:autoDay:mock' : 'eden:mail:autoDay';
function autoLeft() {
  const day = new Date().toISOString().slice(0, 10);
  let v = null;
  try { v = JSON.parse(localStorage.getItem(AUTO_DAY) || 'null'); } catch { /* blocked */ }
  const used = v && v.day === day ? v.n : 0;
  return { day, used, left: Math.max(0, (Number(prefs().autoDraftsPerDay) || 0) - used) };
}
function autoUse() { const a = autoLeft(); try { localStorage.setItem(AUTO_DAY, JSON.stringify({ day: a.day, n: a.used + 1 })); } catch { /* blocked */ } }

let autoBusy = false;
async function autoDrafts() {
  if (autoBusy || mail.source !== 'gmail' || !prefs().autoDrafts || mail.mailbox !== 'inbox') return;
  if (mail.bgOn) return; // askeden.com drafts in the background (every 20 minutes): one drafter, not two
  if (!autoLeft().left) return;
  autoBusy = true;
  try {
    const me = mail.google && mail.google.email ? mail.google.email.toLowerCase() : '';
    const fresh = (m) => { const t = Date.parse(m.date); return Number.isFinite(t) && Date.now() - t < 4 * 86_400_000; };
    const people = visibleRows().filter((m) => fresh(m) && !m.unsubscribe && !ROBOT_ADDR.test(emailOf(m.from)) && emailOf(m.from) !== me && !autoCache.get(ck(m.id)) && !bgDraft(m));
    if (!people.length) return;
    // which need a reply: Rank by priority's answers (asked for here when not there yet: one cheap call)
    const unranked = people.filter((m) => !rankCache.get(ck(m.id))).slice(0, AI_MAX);
    if (unranked.length) {
      try {
        const ranks = parseRanks((await askEden(withContentLang(RANK_SYSTEM), 'Inbox: emails to rank', mailLines(unranked))).out, unranked.map((m) => String(m.id)));
        for (const [id, v] of ranks) rankCache.set(ck(id), v);
      } catch { return; }
    }
    const want = people.filter((m) => { const r = rankCache.get(ck(m.id)); return r && (r.level === 'urgent' || r.level === 'reply'); }).slice(0, 3);
    for (const m of want) {
      if (!autoLeft().left || !prefs().autoDrafts) break;
      let full;
      try { full = merge(m, await readCached(m.id)); } catch { continue; }
      if (!safeForAuto(shieldOf(full))) { autoCache.set(ck(m.id), { discarded: true, unsafe: true }); continue; } // the shield: never drafted to by itself
      try {
        const d = await draftReplyText(full);
        autoUse();
        autoCache.set(ck(m.id), { text: d.text, model: d.model, at: Date.now(), situation: d.situation, inVoice: d.inVoice });
        if (mail.redraw) mail.redraw();
        if (mail.open === m.id && mail.body) openMessage(mail.body, m);
      } catch { break; } // a failing model: try again on the next refresh
    }
  } finally { autoBusy = false; }
}

/** On top of an email Eden pre-wrote a reply for: the draft, Open draft (to review and send), Discard. */
/** A drafted reply's head: To, who, and what Eden did. */
function replyHead(msg, what) {
  return el('div', 'rp-h', el('span', 'k', tx('To')), avatar(msg.from), own('span', 'rp-to', nameOf(msg.from) || emailOf(msg.from) || '(unknown sender)'), el('span', 'grow'), el('span', 'mx-kick', ico('spark', 13), what));
}
function autoDraftCard(msg) {
  const bg = bgDraft(msg);
  if (bg) return bgDraftCard(msg, bg);
  const d = autoCache.get(ck(msg.id));
  if (!d || !d.text) return null;
  const preview = stripMd(d.text).split('\n').filter((l) => l.trim()).slice(0, 10).join('\n');
  const open = () => openCompose({ source: mail.source, account: msg.account || mail.account, mode: 'reply', message: msg, body: d.text, md: true, aiDraft: { situation: d.situation } });
  const card = el('section', { class: 'mx-reply', 'aria-label': 'A reply Eden wrote ahead' },
    replyHead(msg, 'Eden drafted a reply'),
    own('div', 'rp-t', preview),
    el('div', 'rp-f',
      metaLine(d.inVoice ? 'In your style' : 'Drafted by Eden', d, 'not sent or saved until you press Send'),
      el('span', 'grow'),
      el('button', { type: 'button', class: 'btn', onclick: () => { autoCache.set(ck(msg.id), { discarded: true }); card.remove(); if (mail.redraw) mail.redraw(); } }, 'Discard'),
      el('button', { type: 'button', class: 'btn primary', onclick: open }, ico('edit', 14), el('span', '', 'Review and send'))));
  return card;
}


/* ================= The shield (ROADMAP P2, mail-check.js): scams and text aimed at AI ================= */

/** This email's warnings (known: the people the owner writes to; contacts: their names, for impersonation). */
function shieldOf(m) {
  const me = mail.google && mail.google.email ? mail.google.email.toLowerCase() : '';
  if (!m || emailOf(m.from) === me) return [];
  return scamSignals(m, { known: mail.known || new Set(), contacts: mail.contacts || [], me });
}
function shieldBanner(msg) {
  const sig = shieldOf(msg);
  if (!sig.length) return null;
  const high = !safeForAuto(sig);
  return el('div', { class: `mv-shield ${high ? 'high' : 'warn'}`, role: high ? 'alert' : 'note' },
    el('b', '', high ? '⚠ This email may be a scam or a trick' : 'Be careful with this email'),
    el('ul', '', ...sig.map((x) => el('li', '', x.text))),
    high ? el('p', 'muted', 'Eden won’t draft replies or act on it by itself. Check with the sender another way (a phone number you already have) before paying, signing in or sending anything.') : null);
}


/* ================= Promises (ROADMAP P3, mail-plan.js): you owe / you're owed ================= */

const PROMISE_KEY = isMock ? 'eden:mail:promises:mock' : 'eden:mail:promises';
let promisesBusy = false;
/** The last two weeks' promises, sent and received (Gmail), read again at most every 2 hours; on the Mac, Eden Secretary's commitments too. */
async function loadPromises() {
  if (promisesBusy || mail.source !== 'gmail') return;
  let cached = null;
  try { cached = JSON.parse(localStorage.getItem(PROMISE_KEY) || 'null'); } catch { /* blocked */ }
  const done = new Set(Object.keys(getKit().done || {}).filter((k) => k.startsWith('promise:')).map((k) => k.slice(8)));
  if (cached && Array.isArray(cached.list)) { mail.promises = openPromises(cached.list, done); if (mail.redraw) mail.redraw(); }
  if (cached && Date.now() - cached.at < 2 * 3600_000) return;
  promisesBusy = true;
  try {
    const me = homeEmail();
    const [sent, inbox] = await Promise.all([
      gmail('searchFull', { query: 'in:sent newer_than:14d', limit: 15 }, homeBox()).catch(() => null), // homeBox()'s, for now (one saved list)
      gmail('searchFull', { query: 'in:inbox newer_than:14d -category:promotions -category:social', limit: 15 }, homeBox()).catch(() => null),
    ]);
    const list = [];
    for (const m of (sent && sent.messages) || []) list.push(...promisesIn({ ...m, text: ownText(m.body), to: [emailOf(String(m.to || '').split(',')[0])] }, true));
    for (const m of (inbox && inbox.messages) || []) if (emailOf(m.from) !== me.toLowerCase() && safeForAuto(shieldOf(m))) list.push(...promisesIn({ ...m, text: ownText(m.body) }, false));
    const lean = list.map((p) => ({ ...p, due: p.due ? new Date(p.due).toISOString() : null }));
    try { localStorage.setItem(PROMISE_KEY, JSON.stringify({ at: Date.now(), list: lean })); } catch { /* full */ }
    mail.promises = openPromises(lean, done);
    const urgent = mail.promises.filter((p) => p.mine && (p.overdue || p.today));
    if (urgent.length) toast(urgent.length === 1 ? `You promised: ${urgent[0].text} (${urgent[0].overdue ? 'overdue' : 'due today'})` : `${urgent.length} of your promises are due today or overdue`);
    if (mail.redraw) mail.redraw();
  } finally { promisesBusy = false; }
}

/** "You owe 3 · You're owed 2" on top of the inbox; opens the list. */
function promiseStrip() {
  const ps = mail.promises || [];
  if (!ps.length) return null;
  const owe = ps.filter((p) => p.mine), owed = ps.filter((p) => !p.mine);
  const late = owe.filter((p) => p.overdue || p.today).length;
  const box = el('section', { class: 'mx-group mx-attn mx-prom', 'aria-label': 'Promises' });
  const head = el('button', { type: 'button', class: 'mx-prom-h', 'aria-expanded': String(!!mail.promOpen), onclick: () => { mail.promOpen = !mail.promOpen; mail.redraw(); } },
    ico('check', 12), el('span', '', `You owe ${owe.length}`), late ? el('span', 'mail-badge sus', `${late} due`) : null, el('span', 'sep', '·'), el('span', '', `You’re owed ${owed.length}`), el('span', 'grow'), ico('chevd', 12));
  box.append(head);
  if (mail.promOpen) for (const p of ps.slice(0, 12)) {
    box.append(el('div', 'mail-row attn', el('button', { type: 'button', class: 'mr-main', onclick: () => p.msgId && openMessage(mail.body, normMsg({ id: p.msgId, from: p.mine ? '' : p.who, subject: p.subject, date: p.sent })) },
      avatar(p.who || '?'), el('span', 'mr-txt', el('span', 'mr-top', own('b', 'mr-n', p.mine ? `${tx('You')} → ${nameOf(p.who) || p.who || tx('them')}` : `${nameOf(p.who) || p.who} → ${tx('you')}`), el('span', `mr-d${p.overdue ? ' late' : ''}`, p.due ? (p.overdue ? 'Overdue' : p.today ? 'Today' : rowDate(new Date(p.due).toISOString())) : 'No date')),
        own('span', 'mr-s', p.text), p.subject ? own('span', 'mr-p', p.subject) : null)),
      el('div', 'mr-acts', iconBtn('check', 'Done: kept, or no longer needed', () => { markDone([`promise:${p.id}`]); mail.promises = (mail.promises || []).filter((x) => x.id !== p.id); mail.redraw(); }))));
  }
  return box;
}

/* ================= Scheduling that books itself (ROADMAP P3) ================= */

/** A reply in a thread where the owner offered times: the time they picked → Book it (Google Calendar, invitation sent). */
function bookCard(msg) {
  if (mail.source !== 'gmail' || !msg.threadId) return null;
  const offer = offerFor(msg.threadId);
  const me = mail.google && mail.google.email ? mail.google.email.toLowerCase() : '';
  if (!offer || emailOf(msg.from) === me) return null;
  const slots = offer.slots.map((x) => ({ start: new Date(x.start), end: new Date(x.end) }));
  const picked = pickedSlot(msg.body || msg.snippet, slots);
  const note = el('p', { class: 'muted', 'aria-live': 'polite' });
  const book = async (slot, b) => {
    b.disabled = true;
    note.textContent = 'Booking…';
    try {
      const cals = await postJSON('/api/chat/gcal', { action: 'calendars' });
      const cal = ((cals && cals.calendars) || []).find((c) => c.primary) || ((cals && cals.calendars) || []).find((c) => !c.readOnly);
      if (!cal) throw new Error('no Google Calendar you can add to');
      await postJSON('/api/chat/gcal', { action: 'create', args: { calendarId: cal.id, sendUpdates: 'all', confirm: true, event: { title: offer.title, allDay: false, start: slot.start.toISOString(), end: slot.end.toISOString(), attendees: offer.attendees.map((email) => ({ email })) } } });
      dropOffer(msg.threadId);
      note.textContent = `Booked ${slotText(slot)}. ${offer.attendees.length === 1 ? 'They get' : 'Everyone gets'} an invitation from Google Calendar.`;
      card.querySelectorAll('button').forEach((x) => { x.disabled = true; });
    } catch (e) { note.textContent = `Couldn’t book it: ${e.message}`; b.disabled = false; }
  };
  const card = el('section', { class: 'mx-book', 'aria-label': 'Book the meeting' },
    el('div', 'dg-head', ico('cal', 15), el('b', '', picked ? `${nameOf(msg.from) || 'They'} picked ${slotText(picked)}` : 'Did they pick one of your times?')),
    el('div', 'mx-book-acts', ...(picked ? [picked] : slots).map((x) => el('button', { type: 'button', class: picked ? 'btn primary' : 'btn', onclick: (e) => book(x, e.currentTarget) }, picked ? 'Book it' : slotText(x))),
      el('button', { type: 'button', class: 'btn', onclick: () => { dropOffer(msg.threadId); card.remove(); } }, 'Not needed')),
    note);
  return card;
}


/* ================= Voice and screen readers (ROADMAP P4: email by voice, Daredevil) ================= */

let live = null;
/** Says something to screen readers (VoiceOver, NVDA): what an action did, which email is selected. */
function announce(text) {
  if (!live || !document.contains(live)) { live = el('div', { class: 'sr-only', 'aria-live': 'polite', role: 'status' }); document.body.append(live); }
  live.textContent = '';
  setTimeout(() => { live.textContent = String(text || '').slice(0, 300); }, 30);
}

/** "Read it to me" (V): the inbox in a few spoken sentences, on this device (the system voice: nothing is sent anywhere). */
function readInbox() {
  const synth = typeof speechSynthesis !== 'undefined' ? speechSynthesis : null;
  const rows = visibleRows();
  const ctx = { known: mail.known || new Set(), vips: vips() };
  const important = rows.filter((m) => splitOf(m, ctx) === 'important');
  const unread = rows.filter((m) => m.unread);
  const needs = rows.filter((m) => { const r = rankCache.get(ck(m.id)); return r && (r.level === 'urgent' || r.level === 'reply'); });
  const owe = (mail.promises || []).filter((p) => p.mine && (p.overdue || p.today));
  const sus = rows.filter((m) => !safeForAuto(shieldOf(m)));
  const parts = [
    `${unread.length ? `${unread.length} unread` : 'Nothing unread'}, ${important.length} important.`,
    ...needs.slice(0, 3).map((m) => `${nameOf(m.from)} ${rankCache.get(ck(m.id)).level === 'urgent' ? 'needs you soon' : 'is waiting for an answer'}: ${m.subject}.`),
    needs.length > 3 ? `And ${needs.length - 3} more waiting for a reply.` : '',
    !needs.length && unread.length ? `Newest: ${unread.slice(0, 2).map((m) => `${nameOf(m.from)}, ${m.subject}`).join('; ')}.` : '',
    owe.length ? `You promised: ${owe.map((p) => p.text).slice(0, 2).join('; ')}.` : '',
    sus.length ? `Careful: ${sus.length === 1 ? 'one email looks like a scam' : `${sus.length} emails look like scams`}.` : '',
    autoCache && rows.some((m) => autoCache.get(ck(m.id))?.text) ? 'Eden drafted replies for some of them.' : '',
  ].filter(Boolean).map((x) => tx(x)); // spoken: in the page's language
  const text = parts.join(' ');
  announce(text);
  if (!synth) { toast(text); return; }
  if (synth.speaking) { synth.cancel(); return; } // V again: stop
  const u = new SpeechSynthesisUtterance(text);
  u.rate = 1.05;
  u.lang = speechLang();
  synth.speak(u);
  toast('Reading your inbox (V again to stop)');
}

/* ================= Inbox rules (ROADMAP P4, mail-rules.js) ================= */

let rulesBusy = false;
/** The rules that are on, over the inbox as loaded: each acts once per email; what they did goes to the log. */
async function runRules() {
  if (rulesBusy || mail.mailbox !== 'inbox') return;
  const on = mailRules().filter((r) => r.on);
  if (!on.length) return;
  rulesBusy = true;
  try {
    const kitDone = getKit().done || {};
    const ctx = { known: mail.known || new Set(), vips: vips() };
    const log = [];
    for (const r of on) {
      for (const m of visibleRows()) {
        const key = `rule:${r.id}:${m.id}`;
        if (kitDone[key] || !matchRule(r.rule, m, { split: splitOf(m, ctx) })) continue;
        const safe = safeForAuto(shieldOf(m));
        const what = { archive: 'Archived', markRead: 'Marked read', star: 'Starred', snooze: `Snoozed ${r.rule.snoozeDays} d`, draft: 'Drafted a reply', notify: 'Told you' }[r.rule.action];
        try {
          if (r.rule.action === 'archive') await doneRows([m], { quiet: true });
          else if (r.rule.action === 'markRead') { if (m.unread) await setUnread(m, false, { quiet: true }); }
          else if (r.rule.action === 'star') { if (!m.labels.includes('STARRED')) await toggleStar(m, { quiet: true }); }
          else if (r.rule.action === 'snooze') { const at = new Date(Date.now() + r.rule.snoozeDays * 86_400_000); at.setHours(8, 0, 0, 0); kitSnooze(ck(m.id), { until: at.toISOString(), from: m.from, subject: m.subject, snippet: m.snippet, date: m.date, threadId: m.threadId }); await doneRows([m], { snoozing: true }); }
          else if (r.rule.action === 'draft') { if (!safe || mail.source !== 'gmail' || autoCache.get(ck(m.id))) continue; const full = merge(m, await readCached(m.id)); const d = await draftReplyTextAsk(full, r.rule.draftAsk); autoCache.set(ck(m.id), { text: d.text, model: d.model, at: Date.now(), situation: d.situation, inVoice: d.inVoice }); }
          else if (r.rule.action === 'notify') toast(`${nameOf(m.from)}: ${m.subject}`, { label: 'Open', run: () => openMessage(mail.body, m) });
        } catch { continue; }
        markDone([key]);
        log.push({ at: Date.now(), rule: r.id, what, subject: String(m.subject || '').slice(0, 120), from: emailOf(m.from) });
      }
    }
    if (log.length) { logRule(log); announce(`Rules: ${log.length} email${log.length === 1 ? '' : 's'} handled.`); if (mail.redraw) mail.redraw(); }
  } finally { rulesBusy = false; }
}
/** A rule's draft: like an Auto Draft, with what the rule says to reply (never sent). */
const draftReplyTextAsk = (m, ask) => draftReplyText(m, { ask });


/* ---------- Auto Drafts written while Mail was closed (askeden.com: accounts/autodrafts.js) ---------- */

/** The background draft for an email (askeden.com wrote it as a Gmail draft), or null. */
const bgDraft = (m) => (mail.source === 'gmail' && mail.bgDrafts && m && (m.box || boxFor(m.id)) === PRIMARY ? mail.bgDrafts.get(String(m.id)) || null : null);
async function loadServerDrafts() {
  if (mail.source !== 'gmail' || !teamMail.available()) return;
  try {
    const st = await serverDrafts.get();
    mail.bgDrafts = new Map(((st && st.made) || []).map((x) => [String(x.msgId), x]));
    mail.bgOn = Boolean(st && st.on);
    if (mail.bgDrafts.size && mail.redraw) mail.redraw();
  } catch { /* an older site, or signed out */ }
}
function bgDraftCard(msg, d) {
  const card = el('section', { class: 'mx-reply', 'aria-label': 'A reply Eden wrote while Mail was closed' },
    replyHead(msg, 'Eden drafted a reply while you were away'),
    el('p', 'rp-t muted', `It’s in your Gmail Drafts, in this thread. Nothing was sent.${d.reason ? ` (${d.reason})` : ''}`),
    el('div', 'rp-f',
      el('span', 'grow'),
      el('button', { type: 'button', class: 'btn', onclick: async () => {
        try { await gmail('deleteDraft', { id: d.draftId }, PRIMARY); } catch { /* already gone */ }
        try { await serverDrafts.drop(d.msgId); } catch { /* the list catches up */ }
        mail.bgDrafts.delete(String(d.msgId));
        card.remove();
        if (mail.redraw) mail.redraw();
        toast('Draft discarded');
      } }, 'Discard'),
      el('button', { type: 'button', class: 'btn primary', onclick: () => openCompose({ source: 'gmail', draftId: d.draftId, mailbox: PRIMARY, aiDraft: { situation: null } }) }, ico('edit', 14), el('span', '', 'Review and send'))));
  return card;
}


/* ================= The daily brief (mail-brief.js): every email ranked, in depth ================= */

const briefCache = makeCache(LS, isMock ? 'eden:mail:brief:mock' : 'eden:mail:brief', 6);
const BRIEF_DAY = isMock ? 'eden:mail:briefDay:mock' : 'eden:mail:briefDay';
const today = () => new Date().toISOString().slice(0, 10);
let briefRun = 0;

/** Once a day, the first time the inbox loads: the brief is made in the background and offered. */
function autoBrief() {
  if (mail.source !== 'gmail' || prefs().dailyBrief === false || !mail.rows || !mail.rows.length) return;
  let last = '';
  try { last = localStorage.getItem(BRIEF_DAY) || ''; } catch { /* blocked */ }
  if (last === today()) return;
  const pick = briefPick(visibleRows());
  if (pick.length < 2) return;
  try { localStorage.setItem(BRIEF_DAY, today()); } catch { /* blocked */ }
  makeBrief(pick).then((b) => { if (b) toast(`Your daily brief is ready: ${b.items.filter((x) => x.level === 'today' || x.level === 'reply').length} need you`, { label: 'Open', run: () => openBrief(false) }); }).catch(() => {});
}

/** The brief for these emails: from the cache (same emails, same day), else made now. → { headline, items, model, at, count } */
async function makeBrief(pick, { force = false, onStep } = {}) {
  const key = `${mail.source}:${today()}:${digestKey(pick)}`;
  const hit = !force && briefCache.get(key);
  const keep = (b) => { mail.lastBrief = { day: today(), source: mail.source, brief: b }; return b; };
  if (hit) return keep(hit);
  const t0 = Date.now();
  const step = (t) => { if (onStep) onStep(t); };
  // each email in full (this browser's copy when it has one)
  const full = [];
  for (const [i, m] of pick.entries()) {
    step(`Reading your emails… ${i + 1} of ${pick.length}`);
    let x;
    try { x = merge(m, await readCached(m.id)); } catch { x = m; }
    const sig = shieldOf(x);
    full.push(safeForAuto(sig) ? x : { ...x, suspicious: sig.map((s) => s.text).join(' ') });
  }
  step(`Writing your brief from ${full.length} emails…`);
  const context = briefContext(full).map((c) => ({ ...c, source: 'mail' }));
  let out = '', model = '', cost, notional = false;
  await api.send({ messages: [{ role: 'user', content: 'Write my daily brief from these emails, as the JSON object.' }], context, system: briefSystem(new Date(), mail.google && mail.google.email), settings: routeSettings(), mode: 'chat', ...mailAI() }, {
    onEvent: (t, d) => {
      if (t === 'route') { model = d.modelName || d.model || ''; step(`${model} is writing your brief from ${full.length} emails…`); }
      else if (t === 'text') out += d.text || '';
      else if (t === 'usage' && d && typeof d.costUSD === 'number') { cost = (cost || 0) + d.costUSD; notional = notional || !!d.notional; }
      else if (t === 'error') throw new Error(d.message || 'Eden couldn’t write the brief.');
    },
  });
  const b = parseBrief(out, full.map((m) => String(m.id)));
  if (!b) throw new Error('the brief came back in a form Eden couldn’t read. Try again.');
  const brief = { ...b, model, cost, notional, ms: Date.now() - t0, at: Date.now(), count: full.length };
  briefCache.set(key, brief);
  return keep(brief);
}

/** Opens the brief as a page of its own beside the sidebar (made first when it isn't ready). */
async function openBrief(force) {
  const pane = mail.readPane, root = mail.root;
  if (!pane || !document.contains(pane)) return;
  const my = ++briefRun;
  mail.open = null;
  mail.view = 'brief';
  root.classList.add('reading', 'page');
  root.querySelectorAll('.mail-row.sel').forEach((r) => r.classList.remove('sel'));
  if (mail.paintSeg) mail.paintSeg();
  if (mail.redraw) mail.redraw();
  pane.hidden = false;
  const back = el('button', { type: 'button', class: 'cap mx-back', onclick: () => closeReader() }, ico('chevl', 14), 'Back');
  const view = el('div', { class: 'mail-view mx-page mx-brief', 'aria-live': 'polite' });
  const status = el('div', { class: 'dg-load', role: 'status' }, 'Getting your emails…', el('span', 'sk l1'), el('span', 'sk l2'), el('span', 'sk l3'));
  view.replaceChildren(el('p', 'mx-k', `Daily brief · ${new Date().toLocaleDateString(locale(), { weekday: 'long', month: 'long', day: 'numeric' })}`), el('h2', 'mx-big', 'Reading your mail…'), status);
  pane.replaceChildren(el('div', 'mail-top mv-top', back), view);
  pane.scrollTop = 0;
  const pick = briefPick(visibleRows());
  if (!pick.length) { status.replaceWith(emptyState('mail', 'Nothing to brief you on', 'No unread or recent email in your inbox.')); view.querySelector('.mx-big').textContent = 'All quiet.'; return; }
  let brief;
  try { brief = await makeBrief(pick, { force, onStep: (t) => { if (my === briefRun && status.firstChild) status.firstChild.textContent = t; } }); }
  catch (e) { if (my === briefRun) { status.replaceWith(el('p', { class: 'dg-err', role: 'alert' }, `The brief couldn’t be made: ${e.message}`)); view.querySelector('.mx-big').textContent = 'Your daily brief'; } return; }
  if (my !== briefRun || !document.contains(view)) return;
  paintBrief(view, brief, pick);
}

/**
 * The brief, as DESIGN.md's page: the date and a headline, then two columns: what needs you (cards, each with what
 * they ask and what's next, and the first one's Draft a reply in blue) and what's worth knowing (one line each).
 */
function paintBrief(view, brief, pick) {
  const byId = new Map([...pick, ...mail.rows].map((m) => [String(m.id), m]));
  const counts = Object.fromEntries(BRIEF_LEVELS.map((lv) => [lv, brief.items.filter((x) => x.level === lv).length]));
  const made = new Date(brief.at).toLocaleString(locale(), { weekday: 'long', month: 'long', day: 'numeric' });
  let primaryUsed = false;
  const item = (x) => {
    const m = byId.get(String(x.id));
    const open = () => m && openMessage(mail.body, m);
    const canDraft = m && x.needsReply && safeForAuto(shieldOf(m));
    const draftCls = canDraft && !primaryUsed ? 'btn primary' : 'btn';
    if (canDraft) primaryUsed = true;
    return el('article', `bf-item bf-${x.level}`,
      el('div', 'bf-head', m ? avatar(m.from) : el('span', 'dg-dot'),
        el('div', 'bf-who', own('b', '', x.who || (m ? nameOf(m.from) : '')), own('span', 'bf-title', x.title || (m && m.subject) || '')),
        x.deadline ? el('span', 'bf-due', ico('clock', 11), x.deadline) : null),
      m && !safeForAuto(shieldOf(m)) ? el('p', 'bf-scam', '⚠ Eden’s scam check flags this email: don’t reply, click its links or pay anything until you’ve checked with the sender another way.') : null,
      x.about ? el('p', 'bf-about', x.about) : null,
      x.asks.length ? el('div', 'bf-sec', el('span', 'k', 'They’re asking'), el('ul', '', ...x.asks.map((a) => el('li', '', a)))) : null,
      x.details.length ? el('div', 'bf-sec', el('span', 'k', 'Key details'), el('ul', '', ...x.details.map((a) => el('li', '', a)))) : null,
      x.next ? el('p', 'bf-next', el('b', '', 'Next: '), x.next) : null,
      el('div', 'mx-acts',
        canDraft ? el('button', { type: 'button', class: draftCls, onclick: () => draftFor(m, x.next || '') }, ico('edit', 14), el('span', '', 'Draft a reply')) : null,
        m ? el('button', { type: 'button', class: 'btn', onclick: open }, 'Open') : null,
        m && mail.mailbox === 'inbox' ? el('button', { type: 'button', class: 'btn', onclick: (e) => { doneRows([m]); e.currentTarget.closest('.bf-item').classList.add('bf-done'); } }, 'Done') : null));
  };
  const line = (x) => {
    const m = byId.get(String(x.id));
    return el('button', { type: 'button', class: 'mx-mrow', disabled: !m, onclick: () => m && openMessage(mail.body, m) },
      m ? avatar(m.from) : el('span', 'dg-dot'), el('span', 't', own('b', '', x.who || (m ? nameOf(m.from) : '')), own('span', '', x.about || x.title || (m && m.subject) || '')), x.deadline ? el('span', 'bf-due', x.deadline) : null);
  };
  const group = (lv, render) => (counts[lv] ? el('section', { class: 'bf-group', 'aria-label': BRIEF_LABEL[lv] }, el('h4', `bf-h bf-${lv}`, BRIEF_LABEL[lv], el('span', 'n', String(counts[lv]))), render(brief.items.filter((x) => x.level === lv))) : null);
  const need = counts.today + counts.reply;
  const speak = el('button', { type: 'button', class: 'btn', onclick: () => { const s = typeof speechSynthesis !== 'undefined' ? speechSynthesis : null; const t = briefSpeech(brief); if (s) { if (s.speaking) { s.cancel(); return; } s.speak(new SpeechSynthesisUtterance(t)); } else toast(t.slice(0, 200)); } }, ico('speaker', 14), el('span', '', 'Read it to me'));
  const headline = brief.headline || (need ? `${need} email${need === 1 ? '' : 's'} need${need === 1 ? 's' : ''} you.` : 'Nothing needs you today.');
  view.replaceChildren(...[
    el('div', 'bf-top', el('div', '', el('p', 'mx-k', `Daily brief · ${made}`), own('h2', `mx-big${headline.length > 90 ? ' long' : ''}`, headline)), speak),
    el('div', 'bf-cols',
      el('div', 'bf-col', group('today', (xs) => xs.map(item)), group('reply', (xs) => xs.map(item)), need ? null : el('p', 'mx-meta', 'Nothing needs you right now.')),
      el('div', 'bf-col', group('fyi', (xs) => el('div', 'bf-lines', ...xs.map(line))), group('low', (xs) => el('div', 'bf-lines', ...xs.map(line))))),
    el('div', 'bf-foot', metaLine(`Made from ${brief.count} email${brief.count === 1 ? '' : 's'} (unread and the last day’s)`, brief, 'saved on this device. Check anything important in the email itself'),
      el('button', { type: 'button', class: 'mx-link', onclick: () => openBrief(true) }, ico('retry', 12), ' Make it again')),
  ].filter(Boolean));
}
