// Chat that acts on Google Calendar and Gmail (the page side of eden-tools.js): which Google parts
// are connected, the system text that tells the model its tools, the @calendar / @mail scope chips,
// the approval cards under a reply, and the read tools' results going back to the model.
// Calendar changes happen only when a card's button is pressed (executeWrite refuses otherwise);
// mail is read-only plus drafts that open in the composer. See eden-tools.js.

import { el, ico, toast } from './util.js';
import { api, getJSON, postJSON } from './api.js';
import { state, ui, path, nodeText, saveConversation } from './state.js';
import * as T from './eden-tools.js';
import { openCalendar } from './calendar-entry.js';
import { openCompose } from './compose-entry.js';
import { searchChats, asksBack } from './recall-model.js';
import { chatVectors, queryVector } from './chat-vectors.js';
import { privacyOn } from './privacy.js';
import { locale } from './i18n.js';
import { singleFlight, DEADLINE } from './resilience.js';
import { IN_APP } from './native.js';
// The essay writer (essay.js, loaded on demand): askeden.com in a browser only. In the iPhone/Android app nothing of it
// runs: no system text, no essay blocks read, no cards, no essay module loaded.
const ESSAYS = !IN_APP;

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
  // Only when the message (or the last two of the person's) is about mail or the calendar, or @mail / @calendar points at it.
  const recent = state.current ? path(state.current).filter((n) => n.role === 'user' && !n.toolResult && n !== user).slice(-2).map((n) => n.content) : [];
  const want = user && user.toolResult ? { mail: true, calendar: true } : T.googleIntent(user && user.content, recent);
  if (scope === 'mail') want.mail = true;
  if (scope === 'calendar') want.calendar = true;
  if (c.calendar || c.mail) {
    const tools = T.toolsSystem({ calendar: c.calendar && want.calendar, mail: c.mail && want.mail, now: new Date(), zone: zone(), scope: scope === 'calendar' || scope === 'mail' ? scope : null });
    if (tools) parts.push(tools);
  } else if (want.mail || want.calendar) parts.push(T.connectSystem());
  // Chat search only when the message points back at an earlier chat ("what did I ask before", "in my other chat").
  // Offered on every message, a small model searched the person's chats for a plain question about the world
  // ("Rains" at LMU, 2026-10-12) instead of answering or searching the web.
  if (asksBack(user && user.content)) parts.push(T.chatsSystem());
  // the essay writer: Eden knows it exists; an essay open beside the chat is seen and written in (essay.js; loaded only
  // when one is on screen). The selection and blocks are kept as they are now (Eden's "selection" means what was selected
  // when this was sent: T19c), the chat remembers its essay (reopened with it), and the send says how much this turn
  // writes (routing: T18).
  if (ESSAYS) {
    parts.push(T.essaySystem());
    if (essayOnScreen()) {
      try {
        const [E, M] = await Promise.all([import('./essay.js'), import('./essay-model.js')]);
        const ctx = E.essayContext({ turn: user && user.id });
        if (ctx) {
          parts.push(T.essayOpenSystem(ctx));
          const cv = convOf(user);
          if (cv && cv.essayId !== ctx.id) cv.essayId = ctx.id;
          if (user) ESSAY_TURN.set(user.id, { essayId: ctx.id, ...M.essayAsk(user.content, ctx) });
        }
      } catch { /* no essay */ }
    }
  }
  if (scope === 'memory') parts.push('The user pointed at @memory: save the durable facts they state and use what you remember.');
  return parts.filter(Boolean).join('\n\n');
}

const essayOnScreen = () => ESSAYS && Boolean(document.querySelector('#split.art-open') && document.querySelector('#artifact.essay-on'));
const convOf = (user) => (user ? [state.current, ...(state.convs || [])].find((c) => c && c.nodes && c.nodes[user.id]) : null);
/** What each essay turn asked for (essay-model.js essayAsk), by its message's id: the send's `essay`, then the length check. */
const ESSAY_TURN = new Map();
/**
 * The send's `essay` field (T18a/b): { kind, words } on a turn about the open essay, or a feedback/rubric request
 * from the essay writer's buttons; {} otherwise (always {} in the app). The server routes these as careful writing.
 */
export function essayBody(user) {
  if (!ESSAYS) return {};
  const a = user && ESSAY_TURN.get(user.id);
  if (a) return { essay: { kind: a.kind, words: a.words } };
  if (user && user.origin === 'essay') return { essay: { kind: /rubric/i.test(user.content || '') ? 'rubric' : 'feedback', words: 900 } };
  return {};
}
/** The same for the estimate line while typing (router.js preview): the open essay's size rides along as context. */
export async function essayPreviewBody(text) {
  if (!essayOnScreen()) return {};
  try {
    const [E, M] = await Promise.all([import('./essay.js'), import('./essay-model.js')]);
    const ctx = E.essayContext();
    if (!ctx) return {};
    const a = M.essayAsk(text, ctx);
    const chars = ctx.blocks.reduce((n, b) => n + String(b.text).length, 0) + (ctx.rubric ? ctx.rubric.text.length : 0);
    return { essay: { kind: a.kind, words: a.words }, context: { sessionTokens: Math.ceil(chars / 4) + 2500 } };
  } catch { return {}; }
}

/* ---------- after a reply ---------- */

addEventListener('eden:turn-done', (e) => {
  const { c, node } = e.detail || {};
  if (c && node) afterTurn(c, node);
});

async function afterTurn(c, node) {
  // on the website, a reply cut off at the model's output limit still puts in the essay text it finished (T19a)
  const cutOff = ESSAYS && node.finish === 'length';
  if (node.tools || node.error || (node.finish !== 'stop' && !cutOff)) return;
  const user = path(c).filter((n) => n.role === 'user').at(-1);
  noteRaw(node); // the raw JSON of each call, before the blocks are stripped from the reply
  const found = T.parseToolCalls(nodeText(node), { zone: zone(), ...(ESSAYS ? { essays: true, cutOff } : {}) });
  if (cutOff) { found.calls = found.calls.filter((r) => r.ok && r.call.kind === 'essay'); if (!found.calls.length) return; }
  const parts = node.parts || [];
  const text = parts.filter((p) => p.type === 'text');
  if (text.length && found.text !== nodeText(node)) { text[0].text = found.text; for (const p of text.slice(1)) p.text = ''; }
  const list = [];
  const reads = [];
  // the raw call is kept (JSON) so a reloaded chat can rebuild its cards
  const rawCalls = [...nodeTextRaw(node)];
  const essay = [];
  found.calls.forEach((r, i) => {
    // an essay block that couldn't be read keeps its text, so Eden's words are never lost (T19b)
    if (!r.ok) { list.push({ state: 'error', error: r.error, name: r.raw ? r.raw.name : 'tool', ...(r.raw ? { raw: r.raw } : {}), ...(r.rawText ? { rawText: r.rawText } : {}) }); return; }
    const raw = 'raw' in r ? r.raw : rawCalls[i]; // the essay-aware reading (website) carries each call's raw form
    if (r.call.kind === 'read') reads.push({ raw, call: r.call });
    else if (r.call.kind === 'essay') { const t = { raw, name: r.call.name, state: 'running', ...(r.partial ? { partial: true } : {}) }; list.push(t); essay.push([t, { ...r.call, ...(r.partial ? { partial: true } : {}) }]); }
    else list.push({ raw, name: r.call.name, state: 'pending' });
  });
  // Eden's writing goes into the open essay at once, in order; each card can undo its change (and the reply's later ones)
  if (essay.length) {
    const E = await import('./essay.js');
    const group = { cards: [], end: null };
    let added = 0, total = 0;
    for (const [t, call] of essay) {
      const before = E.essaySnapshot();
      const r = await applyEssay(c, node, t, call, { quiet: true, turn: user && user.id });
      if (t.state === 'done' && before) { group.cards.push(t); UNDO.set(t, { group, before }); }
      if (r && r.ok) { added += r.added || 0; total = r.total || total; }
    }
    group.end = E.essaySnapshot();
    const ask = user && ESSAY_TURN.get(user.id);
    const wrote = ask && ask.whole ? total : added;
    // a length asked for and not met: said plainly, with a way to finish it (T19f)
    if (ask && ask.min && added && wrote < Math.round(ask.min * 0.92) && !cutOff) list.push({ name: 'essay_note', note: 'short', state: 'pending', wrote, min: ask.min, max: ask.max, said: ask.said, whole: ask.whole });
    if (cutOff && essay.some(([t]) => t.partial || t.state === 'done')) list.push({ name: 'essay_note', note: 'cutoff', state: 'pending' });
  }
  // asked for the essay writer and the model didn't offer it: the button anyway
  if (ESSAYS && !cutOff && !list.some((t) => t.name === 'open_essay_writer') && user && T.wantsEssayWriter(user.content)) { const style = T.essayStyleIn(user.content); list.push({ raw: { name: 'open_essay_writer', args: style ? { style } : {} }, name: 'open_essay_writer', state: 'pending' }); }
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
  if (ESSAYS && t.name === 'essay_note') return essayNote(c, node, t);
  if (t.state === 'error' && !t.raw) {
    if (!ESSAYS || !t.rawText) return el('div', 'notice warn', `Eden couldn’t use a tool: ${t.error}`);
    // a block that couldn't be read: its text, kept, with a way into the essay (T19b)
    const words = t.rawText.replace(/<[^>]+>/g, ' ').replace(/\{\s*"name"[\s\S]*?"text"\s*:\s*"/, '').replace(/"\s*(,\s*"where"[\s\S]*)?\}+\s*$/, '').replace(/\\n/g, '\n').trim();
    return el('div', { class: 'toolcard error', role: 'group', 'aria-label': 'Eden’s text' },
      el('div', 'tc-title', ico('edit', 15), 'Not put in your essay'),
      el('div', { class: 'errbox', role: 'alert' }, ico('x'), el('span', '', `Eden’s change came back garbled (${t.error}), so nothing changed in your essay. Its text is below.`)),
      el('details', 'tc-raw', el('summary', '', 'Eden’s text'), el('div', { class: 'tc-raw-t', 'data-no-i18n': '' }, words.slice(0, 20_000))),
      el('div', 'tc-acts',
        el('button', { type: 'button', class: 'cap primary', onclick: () => applyEssay(c, node, t, { name: 'essay_write', kind: 'essay', args: { text: words, where: 'end' } }) }, 'Put it at the end of the essay'),
        el('button', { type: 'button', class: 'cap', onclick: () => navigator.clipboard.writeText(words).then(() => toast('Copied'), () => toast('Couldn’t copy')) }, 'Copy')));
  }
  const v = T.validateCall(t.raw || {}, { zone: zone(), essays: ESSAYS });
  if (!v.ok) return el('div', 'notice warn', `Eden couldn’t use a tool: ${v.error}`);
  const call = v.call;
  const spec = T.cardFor(call, { zone: zone(), locale: locale() });
  if (!spec) return null;
  const root = el('div', { class: `toolcard ${t.state}${spec.danger ? ' danger' : ''}`, role: 'group', 'aria-label': spec.title, 'data-tool': call.name });
  root.append(el('div', 'tc-title', ico(call.name.startsWith('mail') ? 'mail' : call.name === 'connect_google' ? 'link' : call.name === 'open_essay_writer' || call.kind === 'essay' ? 'edit' : 'cal', 15), spec.title));
  if (spec.rows.length) root.append(el('dl', 'tc-rows', ...spec.rows.flatMap(([k, val]) => [el('dt', '', k), el('dd', OWN_ROWS.has(k) ? { 'data-no-i18n': '' } : '', String(val))])));
  if (spec.notice && t.state === 'pending') root.append(el('div', { class: `tc-notice${call.draft && call.draft.attendees.length ? ' guests' : ''}` }, spec.notice));
  if (t.state === 'done') {
    root.append(el('div', 'tc-done', ico('check', 14), t.result || 'Done.'));
    for (const n of t.notes || []) root.append(el('div', 'tc-notice', n));
    if (UNDO.has(t)) root.append(el('div', 'tc-acts', el('button', { type: 'button', class: 'cap', onclick: () => undoEssay(c, node, t) }, 'Undo'))); // an essay change made in this page
  } else if (t.state === 'cancelled') root.append(el('div', 'tc-done muted', call.kind === 'essay' ? 'Undone: the essay is back as it was.' : 'Cancelled. Nothing was changed.'));
  else if (t.state === 'running') root.append(el('div', 'tc-done muted', 'Working…'));
  else {
    if (t.state === 'error') root.append(el('div', { class: 'errbox', role: 'alert' }, ico('x'), el('span', '', call.kind === 'essay' ? `Not put in your essay: ${t.error}` : t.error), t.reconnect ? el('button', { type: 'button', class: 'cap', onclick: () => connect('calendar') }, 'Connect Google') : ''));
    const acts = el('div', 'tc-acts');
    const btn = (label, cls, fn) => acts.append(el('button', { type: 'button', class: `cap ${cls}`, onclick: fn }, label));
    for (const a of spec.actions) {
      if (a === 'approve') btn(t.state === 'error' ? 'Try again' : spec.approve, spec.danger ? 'danger' : 'primary', () => approve(c, node, t, call));
      if (a === 'edit') btn('Edit', '', () => editCall(call));
      if (a === 'open') btn(spec.approve, 'primary', () => { openCompose({ to: call.args.to, cc: call.args.cc, subject: call.args.subject, body: call.args.body }); t.state = 'done'; t.result = 'Opened in Mail. Review it and press Send there.'; saveConversation(c); ui.updateMessage(c, node); });
      if (a === 'connect') btn(spec.approve, 'primary', () => connect(/mail/i.test(nodeText(node)) ? 'gmail' : 'calendar'));
      if (a === 'retry') btn('Try again', 'primary', () => retryEssay(c, node, t, call));
      if (a === 'essay') btn(spec.approve, 'primary', () => import('./essay.js').then((m) => (call.args.style ? m.newEssayIn(call.args.style) : m.openEssays())).then(() => { t.state = 'done'; t.result = 'Opened beside the chat.'; saveConversation(c); ui.updateMessage(c, node); }).catch((err) => toast(`Couldn’t open the essay writer: ${err.message}`)));
      if (a === 'cancel') btn('Cancel', '', () => { t.state = 'cancelled'; saveConversation(c); ui.updateMessage(c, node); });
    }
    root.append(acts);
  }
  return root;
}
/** One of Eden's essay changes, applied to the open essay (essay.js); its card then offers Undo. */
const UNDO = new WeakMap();
async function applyEssay(c, node, t, call, { quiet = false, turn = null } = {}) {
  let r;
  try { r = await (await import('./essay.js')).applyEssayCall(call, { turn: turn || turnOf(c, node) }); } catch (err) { r = { ok: false, error: err.message }; }
  if (r.ok) { t.state = 'done'; t.result = r.result; t.notes = r.notes && r.notes.length ? r.notes : undefined; t.change = r.change || null; delete t.error; } else { t.state = 'error'; t.error = r.error; }
  if (!quiet) { saveConversation(c); ui.updateMessage(c, node); }
  return r;
}
const turnOf = (c, node) => (c && node && node.parent && c.nodes && c.nodes[node.parent] ? node.parent : null);
/** Try again on an essay card: applied as its own step, with its own Undo (T19c). */
async function retryEssay(c, node, t, call) {
  const E = await import('./essay.js');
  const before = E.essaySnapshot();
  await applyEssay(c, node, t, call, { quiet: true });
  if (t.state === 'done' && before) { const group = { cards: [t], end: E.essaySnapshot() }; UNDO.set(t, { group, before }); }
  saveConversation(c); ui.updateMessage(c, node);
}
/**
 * Undo on an essay card: the essay goes back to before that change (the reply's later changes go too). Untouched since,
 * it's put back exactly; after the person has typed elsewhere, only Eden's changes are taken out (T20f).
 */
async function undoEssay(c, node, t) {
  const u = UNDO.get(t);
  const E = await import('./essay.js');
  const now = E.essaySnapshot();
  if (!now || !u.group.end || now.id !== u.group.end.id) { toast('Open that essay to undo this.'); return; }
  const k = u.group.cards.indexOf(t);
  const cards = u.group.cards.slice(k);
  let why;
  if (now.doc === u.group.end.doc) {
    // the title goes back only if this reply set it and it hasn't changed since (a title made afterwards stays)
    why = E.essayRestore({ ...u.before, title: now.title === u.group.end.title ? u.before.title : now.title });
  } else {
    why = E.essayUndoChanges(cards.map((x) => x.change).filter(Boolean));
    if (!why && cards.some((x) => x.name === 'essay_title') && now.title === u.group.end.title) E.essayRestore({ ...E.essaySnapshot(), title: u.before.title });
  }
  if (why) { toast(why); return; }
  for (const x of u.group.cards.splice(k)) { UNDO.delete(x); x.state = 'cancelled'; }
  u.group.end = E.essaySnapshot();
  saveConversation(c); ui.updateMessage(c, node);
}
/** The note under an essay reply: a length asked for and not met, or a reply cut off at its limit (T19f, T19a). */
function essayNote(c, node, t) {
  const send = async (msg) => { t.state = 'done'; saveConversation(c); ui.updateMessage(c, node); const { sendMessage } = await import('./chat.js'); sendMessage(msg); };
  if (t.note === 'cutoff') {
    return el('div', { class: 'toolcard', role: 'group', 'aria-label': 'Cut off' },
      el('div', 'tc-title', ico('edit', 15), 'Eden stopped at its length limit'),
      el('div', 'tc-notice', 'What it finished is in your essay. It can carry on from there.'),
      t.state === 'pending' ? el('div', 'tc-acts', el('button', { type: 'button', class: 'cap primary', onclick: () => send('Continue writing the essay from exactly where you stopped (the text so far is in the essay).') }, 'Continue')) : null);
  }
  const range = t.said || (t.max && t.max !== t.min ? `${t.min.toLocaleString()}–${t.max.toLocaleString()}` : t.min.toLocaleString());
  const more = Math.max(50, Math.round(((t.min + (t.max || t.min)) / 2 - t.wrote) / 10) * 10);
  return el('div', { class: 'toolcard', role: 'group', 'aria-label': 'Length' },
    el('div', 'tc-title', ico('edit', 15), 'Shorter than you asked'),
    el('div', 'tc-notice', `${t.whole ? 'Your essay is' : 'Eden wrote'} ${t.wrote.toLocaleString()} words; you asked for ${range}.`),
    t.state === 'pending' ? el('div', 'tc-acts', el('button', { type: 'button', class: 'cap primary', onclick: () => send(`Add about ${more} more words to the essay where they help the argument most (more evidence and analysis, not filler), keeping its voice.`) }, `Write about ${more} more`)) : null);
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
.toolcard .cap.danger{color:var(--danger,#ff453a)}
.tc-writing{display:flex;align-items:center;gap:6px;margin-top:8px;font-size:12.5px;color:var(--accent,#0a84ff)}
.toolcard.error{box-shadow:inset 0 0 0 .5px var(--danger,#ff453a)}
.toolcard .tc-raw{margin:8px 0}.toolcard .tc-raw summary{cursor:pointer;color:var(--text2,#666)}
.toolcard .tc-raw-t{white-space:pre-wrap;max-height:220px;overflow:auto;margin-top:6px;padding:8px;border-radius:8px;background:var(--surface,rgba(127,127,127,.06));font-size:12.5px}`;
if (typeof document !== 'undefined' && !document.getElementById('tools-css')) document.head.append(Object.assign(document.createElement('style'), { id: 'tools-css', textContent: CSS }));
