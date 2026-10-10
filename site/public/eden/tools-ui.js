// Chat that acts on Google Calendar and Gmail (the page side of eden-tools.js): which Google parts
// are connected, the system text that tells the model its tools, the @calendar / @mail scope chips,
// the approval cards under a reply, and the read tools' results going back to the model.
// Calendar changes happen only when a card's button is pressed (executeWrite refuses otherwise);
// mail is read-only plus drafts that open in the composer. See eden-tools.js.

import { el, ico, toast } from './util.js';
import { api, getJSON, postJSON } from './api.js';
import { state, ui, path, nodeText, saveConversation } from './state.js';
import * as T from './eden-tools.js';
import { openCalendar } from './calendar.js';
import { openCompose } from './compose.js';
import { searchChats } from './recall-model.js';
import { chatVectors, queryVector } from './chat-vectors.js';
import { privacyOn } from './privacy.js';
import { locale } from './i18n.js';
import { singleFlight, DEADLINE } from './resilience.js';

/** The chats_search tool: words plus meaning over this browser's chats (never from a temporary or private chat). */
async function searchPastChats({ query, from, to, limit }) {
  const cur = state.current;
  if (cur && (cur.temp || cur.course || privacyOn(cur))) return [];
  const convs = state.convs || [];
  const [vecs, qvec] = await Promise.all([chatVectors(convs).catch(() => ({})), queryVector(query)]);
  return searchChats(convs, query, { from, to, limit, currentId: cur && cur.id, vecs, qvec, isPrivate: privacyOn });
}

const zone = () => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || null; } catch { return null; } };
const gcal = (action, args = {}) => postJSON('/api/chat/gcal', { action, args });
const gmail = async (action, args = {}) => { const r = await api.gmail(action, args); if (r && r.error) throw new Error(r.error); return r && typeof r === 'object' && 'result' in r ? r.result : r; };

let conn = { calendar: false, mail: false, at: 0 };
// The two looks run side by side, 5 s at most each, one round at a time (a send never waits on a
// slow server for long, and never piles requests on it: B1, B2). A look that didn't answer isn't
// kept: the next send asks again, and meanwhile what was known stays.
const look = singleFlight(async () => {
  const late = Symbol('late');
  const ask = (f) => f().catch((e) => (e && e.timeout ? late : null)); // not there: nothing connected
  const [g, c] = await Promise.all([
    ask(() => api.googleStatus({ timeout: DEADLINE.google })),
    ask(() => getJSON('/api/chat/gcal/status', { timeout: DEADLINE.google })),
  ]);
  if (g === late || c === late) return conn;
  const mail = Boolean(g && g.connected && g.gmail !== false);
  const calendar = Boolean((g && g.calendar === true) || (c && c.connected && c.calendar));
  conn = { calendar, mail, at: Date.now() };
  return conn;
});
/** Which Google parts are connected (cached for a minute; `force` after a sign-in). */
export async function connection(force = false) {
  if (!force && Date.now() - conn.at < 60_000) return conn;
  return look();
}

/* ---------- @ scopes ---------- */
const SCOPE_TITLE = /^@(calendar|mail|browser|memory)$/;
export const scopeOf = (blocks) => { const b = (blocks || []).find((x) => SCOPE_TITLE.test(x.title || '')); return b ? b.title.slice(1) : null; };
const BLOCK_TEXT = { calendar: 'Calendar scope: the user’s Google Calendar events for the coming week are attached when the message is sent.', mail: 'Mail scope: a summary of the recent inbox is attached when the message is sent.', browser: 'Browser scope: do this in the cloud browser.', memory: 'Memory scope: remember what the user states and recall what is relevant.' };

/** The menu entries for "@": [{ label, help, value, scope }] (browser only when it exists on this server). */
export function mentionEntries(q) {
  return T.mentionItems(q).map((m) => ({ label: `@${m.name}`, help: m.help, value: m.name, scope: m.name }));
}
/** Picking @calendar etc.: one scope chip at a time (it's a context block, so the composer draws and removes it). */
export function setScope(scope) {
  state.draftContext = state.draftContext.filter((x) => !SCOPE_TITLE.test(x.title || ''));
  if (scope) state.draftContext.push({ title: `@${scope}`, text: BLOCK_TEXT[scope], kind: 'scope', scope });
}
/** Backspace in an empty composer removes the last scope chip; true when it did. */
export function dropScope() {
  const i = state.draftContext.findLastIndex((x) => SCOPE_TITLE.test(x.title || ''));
  if (i < 0) return false;
  state.draftContext.splice(i, 1);
  return true;
}
/** A leading "@calendar …" typed by hand: the same as picking it. */
export function typedMention(text, context = []) {
  if (scopeOf(context)) return { text, context };
  const m = T.parseMention(text);
  if (!m.scope) return { text, context };
  return { text: m.text || text, context: [...context, { title: `@${m.scope}`, text: BLOCK_TEXT[m.scope], kind: 'scope', scope: m.scope }] };
}

/** Before a send: the scope chip's text becomes the real calendar / inbox summary (written on the user's message so history keeps it). */
export async function fillScopes(user) {
  const b = (user.context || []).find((x) => SCOPE_TITLE.test(x.title || ''));
  if (!b || b.filled) return;
  const scope = b.title.slice(1);
  try {
    if (scope === 'calendar') {
      const now = new Date(), end = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 7);
      const day = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      const j = await gcal('events', { start: T.isoWithOffset(day), end: T.isoWithOffset(end) });
      b.text = T.calendarContext(j.events, { now });
      b.source = 'calendar';
    } else if (scope === 'mail') {
      const j = await gmail('search', { mailbox: 'inbox', limit: 12 });
      b.text = T.mailContext(Array.isArray(j) ? j : j.messages || j.results || j.items || []);
      b.source = 'mail';
    }
    b.filled = true;
  } catch (e) {
    b.text = `${BLOCK_TEXT[scope]} (It could not be loaded: ${String(e.message || e).slice(0, 120)}.)`;
  }
}

/** The system text for this send: the persona's, then the Google tools (narrowed by the scope) or the Connect hint. */
export async function toolsSystemFor(user, base = '') {
  const c = await connection();
  const scope = scopeOf(user && user.context);
  const parts = [base || ''];
  if (c.calendar || c.mail) parts.push(T.toolsSystem({ calendar: c.calendar, mail: c.mail, now: new Date(), zone: zone(), scope: scope === 'calendar' || scope === 'mail' ? scope : null }));
  else parts.push(T.connectSystem());
  parts.push(T.chatsSystem());
  if (scope === 'memory') parts.push('The user pointed at @memory: save the durable facts they state and use what you remember.');
  return parts.filter(Boolean).join('\n\n');
}

/* ---------- after a reply ---------- */

addEventListener('eden:turn-done', (e) => {
  const { c, node } = e.detail || {};
  if (c && node) afterTurn(c, node);
});

async function afterTurn(c, node) {
  if (node.tools || node.error || node.finish !== 'stop') return;
  const user = path(c).filter((n) => n.role === 'user').at(-1);
  noteRaw(node); // the raw JSON of each call, before the blocks are stripped from the reply
  const found = T.parseToolCalls(nodeText(node), { zone: zone() });
  const parts = node.parts || [];
  const text = parts.filter((p) => p.type === 'text');
  if (text.length && found.text !== nodeText(node)) { text[0].text = found.text; for (const p of text.slice(1)) p.text = ''; }
  const list = [];
  const reads = [];
  // the raw call is kept (JSON) so a reloaded chat can rebuild its cards
  const rawCalls = [...nodeTextRaw(node)];
  found.calls.forEach((r, i) => {
    if (!r.ok) { list.push({ state: 'error', error: r.error, name: 'tool' }); return; }
    const raw = rawCalls[i];
    if (r.call.kind === 'read') reads.push({ raw, call: r.call });
    else list.push({ raw, name: r.call.name, state: 'pending' });
  });
  const cn = await connection();
  if (!list.some((t) => t.name === 'connect_google') && !cn.calendar && !cn.mail && user && T.wantsGoogle(user.content)) list.push({ raw: { name: 'connect_google', args: {} }, name: 'connect_google', state: 'pending' });
  if (list.length) { node.tools = list; saveConversation(c); ui.updateMessage(c, node); }
  if (reads.length) runReads(c, node, reads);
}
const rawStore = new WeakMap();
const nodeTextRaw = (node) => rawStore.get(node) || [];
function noteRaw(node) {
  const out = [];
  String(nodeText(node)).replace(/<eden-tool>([\s\S]*?)<\/eden-tool>/g, (_, b) => { try { out.push(JSON.parse(b.trim().replace(/^```(?:json)?\s*|\s*```$/g, ''))); } catch { out.push(null); } return ''; });
  rawStore.set(node, out.slice(0, T.MAX_CALLS));
}

async function runReads(c, node, reads) {
  const rounds = path(c).filter((n) => n.role === 'user' && n.toolResult).length;
  if (rounds >= T.MAX_ROUNDS) { node.notes = [...(node.notes || []), 'Eden stopped looking things up after a few rounds.']; ui.updateMessage(c, node); return; }
  const out = [];
  for (const { call } of reads) {
    try { out.push(`## ${call.name} ${JSON.stringify(call.args)}\n${await T.executeRead(call, { gcal, gmail, chats: searchPastChats })}`); }
    catch (e) { out.push(`## ${call.name}\nFailed: ${String(e.message || e).slice(0, 200)}`); }
  }
  const { sendMessage } = await import('./chat.js');
  const kind = reads[0].call.name.startsWith('calendar') ? 'calendar' : reads[0].call.name === 'chats_search' ? 'chats' : 'mail';
  sendMessage(`(Eden ran ${reads.map((r) => r.call.name).join(', ')} and attached the result.)`, [], { context: [{ title: kind === 'calendar' ? 'Calendar lookup' : kind === 'chats' ? 'Chat search' : 'Mail lookup', text: out.join('\n\n'), source: kind }], toolResult: true });
}

/* ---------- cards ---------- */

async function approve(c, node, t, call) {
  t.state = 'running'; ui.updateMessage(c, node);
  try {
    t.result = await T.executeWrite(call, { gcal }, { approved: true, zone: zone() });
    t.state = 'done';
    dispatchEvent(new CustomEvent('eden:calendar-changed'));
  } catch (e) {
    t.state = 'error';
    t.error = String(e.message || e);
    t.reconnect = /reconnect|scope|permission|sign in|401|403/i.test(t.error);
  }
  saveConversation(c);
  ui.updateMessage(c, node);
}

async function connect(scope) {
  try {
    const r = await api.googleConnect(scope);
    if (!r || !r.url) { toast('Couldn’t start the Google sign-in'); return; }
    location.assign(r.url);
  } catch (e) { toast(`Couldn’t connect Google: ${e.message}`); }
}

/** The cards under an assistant reply: one per tool call that needs the user. */
export function toolCards(c, node) {
  if (!node.tools || node.streaming) return [];
  return node.tools.map((t) => card(c, node, t)).filter(Boolean);
}
// rows whose value is the person's own (event title, place, notes, addresses, subject): never translated
const OWN_ROWS = new Set(['What', 'Where', 'Guests', 'Notes', 'Event', 'To', 'Cc', 'Subject', 'Title', 'Location']);
function card(c, node, t) {
  if (t.state === 'error' && !t.raw) return el('div', 'notice warn', `Eden couldn’t use a tool: ${t.error}`);
  const v = T.validateCall(t.raw || {}, { zone: zone() });
  if (!v.ok) return el('div', 'notice warn', `Eden couldn’t use a tool: ${v.error}`);
  const call = v.call;
  const spec = T.cardFor(call, { zone: zone(), locale: locale() });
  if (!spec) return null;
  const root = el('div', { class: `toolcard ${t.state}${spec.danger ? ' danger' : ''}`, role: 'group', 'aria-label': spec.title, 'data-tool': call.name });
  root.append(el('div', 'tc-title', ico(call.name.startsWith('mail') ? 'mail' : call.name === 'connect_google' ? 'link' : 'cal', 15), spec.title));
  if (spec.rows.length) root.append(el('dl', 'tc-rows', ...spec.rows.flatMap(([k, val]) => [el('dt', '', k), el('dd', OWN_ROWS.has(k) ? { 'data-no-i18n': '' } : '', String(val))])));
  if (spec.notice && t.state === 'pending') root.append(el('div', { class: `tc-notice${call.draft && call.draft.attendees.length ? ' guests' : ''}` }, spec.notice));
  if (t.state === 'done') root.append(el('div', 'tc-done', ico('check', 14), t.result || 'Done.'));
  else if (t.state === 'cancelled') root.append(el('div', 'tc-done muted', 'Cancelled. Nothing was changed.'));
  else if (t.state === 'running') root.append(el('div', 'tc-done muted', 'Working…'));
  else {
    if (t.state === 'error') root.append(el('div', { class: 'errbox', role: 'alert' }, ico('x'), el('span', '', t.error), t.reconnect ? el('button', { type: 'button', class: 'cap', onclick: () => connect('calendar') }, 'Connect Google') : ''));
    const acts = el('div', 'tc-acts');
    const btn = (label, cls, fn) => acts.append(el('button', { type: 'button', class: `cap ${cls}`, onclick: fn }, label));
    for (const a of spec.actions) {
      if (a === 'approve') btn(t.state === 'error' ? 'Try again' : spec.approve, spec.danger ? 'danger' : 'primary', () => approve(c, node, t, call));
      if (a === 'edit') btn('Edit', '', () => editCall(call));
      if (a === 'open') btn(spec.approve, 'primary', () => { openCompose({ to: call.args.to, cc: call.args.cc, subject: call.args.subject, body: call.args.body }); t.state = 'done'; t.result = 'Opened in Mail. Review it and press Send there.'; saveConversation(c); ui.updateMessage(c, node); });
      if (a === 'connect') btn(spec.approve, 'primary', () => connect(/mail/i.test(nodeText(node)) ? 'gmail' : 'calendar'));
      if (a === 'cancel') btn('Cancel', '', () => { t.state = 'cancelled'; saveConversation(c); ui.updateMessage(c, node); });
    }
    root.append(acts);
  }
  return root;
}
/** "Edit": the calendar's own event editor, prefilled; saving there is its own review step. */
function editCall(call) {
  if (call.name === 'calendar_create') {
    const d = call.draft;
    openCalendar({ date: d.start, newEvent: { title: d.title, allDay: d.allDay, start: d.start, end: d.end, location: d.location, notes: d.notes, recurrence: d.recurrence, attendees: d.attendees, timeZone: d.timeZone } });
  } else openCalendar(call.changes && call.changes.start ? { date: new Date(call.changes.start) } : {});
}

/* ---------- styles (kept with the cards that use them) ---------- */
const CSS = `.toolcard{margin:10px 0 0;padding:12px 14px;border-radius:var(--r-md,12px);background:var(--surface2,rgba(127,127,127,.08));box-shadow:inset 0 0 0 .5px var(--line,rgba(127,127,127,.3));font-size:13px;max-width:460px}
.toolcard .tc-title{display:flex;align-items:center;gap:7px;font-weight:600;margin-bottom:8px}
.toolcard .tc-rows{display:grid;grid-template-columns:auto 1fr;gap:3px 12px;margin:0 0 8px}
.toolcard dt{color:var(--text3,#888)}.toolcard dd{margin:0;word-break:break-word}
.toolcard .tc-notice{font-size:12px;color:var(--text2,#666);margin:0 0 8px}
.toolcard .tc-notice.guests{color:var(--warn,#b25b00);font-weight:600}
.toolcard .tc-acts{display:flex;gap:8px;flex-wrap:wrap}
.toolcard .tc-done{display:flex;align-items:center;gap:6px}.toolcard .tc-done.muted{color:var(--text3,#888)}
.toolcard.done{box-shadow:inset 0 0 0 .5px rgba(48,209,88,.5)}.toolcard.cancelled{opacity:.7}
.toolcard .cap.danger{color:var(--danger,#ff453a)}`;
if (typeof document !== 'undefined' && !document.getElementById('tools-css')) document.head.append(Object.assign(document.createElement('style'), { id: 'tools-css', textContent: CSS }));
