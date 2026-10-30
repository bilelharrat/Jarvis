// Comments, tasks and live presence in the slide editor (web only; deck.js mounts the Comments tray and the presence
// line, deck-render.js runs deck-presence.js frameScript in the slide frame). The rules are in deck-comments-model.js
// (no DOM, tested); presence in deck-presence.js; the cross-device room (off by default) in deck-room.js.
//
// A comment change is written into the newest deck version in place (no new version: comments sit outside undo and
// don't use up the 40 versions), then saved; other tabs merge it (state.js → sync-model.js mergeComments).

import { el, toast } from './util.js';
import { t as tx } from './i18n.js';
import { state, ui as appUi, saveConversation, addConversation, newConversation } from './state.js';
import { postJSON } from './api.js';
import { IN_APP } from './native.js';
import { layoutDeck } from './deck-model.js';
import {
  commentsOf, addComment, addReply, setResolved, assignTask, setTaskDone, deleteComment, deleteReply, filterThreads, countsBySlide, pins,
  people, taskState, anchorIndex, mentionsIn, visible, cleanName, LIMITS,
} from './deck-comments-model.js';
import { Presence, colorFor, peerLine } from './deck-presence.js';
import { roomEnabled, openRoom, startRoom, stopRoom, readRoomLink } from './deck-room.js';

export { commentsOf };
let hooks = null; // deck.js: { conv, deck, frame, slide, at }
export function collabHooks(h) { hooks = h; }

const NAME_KEY = 'eden.collab.name';
const store = { get: (k) => { try { return localStorage.getItem(k) || ''; } catch { return ''; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* blocked */ } } };
const tabId = (() => { try { let v = sessionStorage.getItem('eden.collab.tab'); if (!v) { v = `t${Math.random().toString(36).slice(2, 10)}`; sessionStorage.setItem('eden.collab.tab', v); } return v; } catch { return `t${Math.random().toString(36).slice(2, 10)}`; } })();
const session = { get: (k) => { try { return sessionStorage.getItem(k) || ''; } catch { return ''; } }, set: (k, v) => { try { sessionStorage.setItem(k, v); } catch { /* blocked */ } } };
const myName = () => cleanName(session.get(NAME_KEY) || store.get(NAME_KEY)) || tx('Me'); // a name typed in this tab, else this browser's
const today = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const ago = (ms) => { const s = Math.max(0, (Date.now() - ms) / 1000); return s < 60 ? tx('just now') : s < 3600 ? `${Math.floor(s / 60)} min` : s < 86400 ? `${Math.floor(s / 3600)} h` : new Date(ms).toLocaleDateString(); };
const ui = { filter: 'open', draft: null, replyTo: '', replyText: {}, assignOpen: '', pick: false, focusKey: '' };
let panelEl = null, barEl = null, presence = null, presenceConv = null, room = null, roomState = { status: '', detail: '' };
let peers = [];

function cssOnce() {
  if (document.querySelector('link[data-deck-comments]')) return;
  document.head.append(el('link', { rel: 'stylesheet', href: new URL('./deck-comments.css', import.meta.url).href, 'data-deck-comments': '' }));
}

// ── the conversation's comments ──

/** Change the comments: `fn(list)` → the new list (or null: nothing). Written into the newest version, saved. */
function change(fn) {
  const c = hooks && hooks.conv();
  const vs = c && Array.isArray(c.deckVersions) ? c.deckVersions : [];
  if (!vs.length) return false;
  const next = fn(commentsOf(c));
  if (!next) return false;
  vs.at(-1).deck.comments = next; // in place: the same version object (deck.js tracks versions by identity)
  saveConversation(c);
  if (room) room.push(c).catch(() => {});
  refresh();
  return true;
}
const deckNow = () => (hooks && hooks.deck()) || null;
const slideTitle = (deck, i) => (deck && deck.slides[i] && deck.slides[i].title) || '';
const anchorLabel = (deck, t) => {
  const i = anchorIndex(deck, t);
  if (i < 0) return tx('A slide that’s gone');
  const part = t.anchor.path ? ` · ${t.anchor.path.replace(/\.(\d+)/g, (_, n) => ` ${Number(n) + 1}`).replace(/\./g, ' ')}` : '';
  return `${tx('Slide')} ${i + 1}${part}`;
};

/** Go to a deck slide in the frame. */
function goTo(i) {
  const f = hooks && hooks.frame(), deck = deckNow();
  if (!f || !deck) return;
  const k = layoutDeck(deck).findIndex((r) => r.index === i);
  if (k >= 0) f.contentWindow.postMessage({ type: 'deck-go', k }, '*');
}

// ── the frame: badges, pins, others' outlines and pointers; picking what a comment is about ──

function tellFrame() {
  const f = hooks && hooks.frame(), c = hooks && hooks.conv(), deck = deckNow();
  if (!f || !f.contentWindow || !deck || !c) return;
  const list = commentsOf(c);
  f.contentWindow.postMessage({ type: 'deck-collab', counts: countsBySlide(deck, list), pins: pins(deck, list), peers, pick: ui.pick }, '*');
}

if (!IN_APP && typeof addEventListener === 'function') {
  addEventListener('message', (e) => {
    const f = hooks && hooks.frame();
    if (!f || e.source !== f.contentWindow) return;
    const m = e.data && typeof e.data === 'object' ? e.data : {};
    const num = (v) => (Number.isInteger(v) && v >= 0 && v < 2000 ? v : -1);
    switch (m.type) {
      case 'deck-ready': ensurePresence(); tellFrame(); break;
      case 'deck-at': ensurePresence(); if (presence) presence.set({ index: num(m.index), k: num(m.k), path: '', x: null, y: null }); tellFrame(); if (panelEl && !panelEl.contains(document.activeElement)) refresh(); break; // (the slide's number on the button; never while typing in the tray)
      case 'deck-pointer': if (presence) presence.set({ ...(num(m.k) >= 0 ? { k: num(m.k), index: num(m.index) } : {}), x: Number.isFinite(m.x) ? m.x : null, y: Number.isFinite(m.y) ? m.y : null }); break;
      case 'deck-focus': if (presence) presence.set({ path: typeof m.path === 'string' && m.path.length < 40 ? m.path : '', ...(num(m.index) >= 0 ? { index: num(m.index) } : {}) }); break;
      case 'deck-pick':
        ui.pick = false;
        if (!m.cancel && num(m.index) >= 0) startDraft({ slide: num(m.index), path: typeof m.path === 'string' && /^[A-Za-z][A-Za-z0-9.]{0,39}$/.test(m.path) ? m.path : '' });
        else { tellFrame(); refresh(); }
        break;
      default: break;
    }
  });
  // another tab saved this chat: state.js merges it in (async), then the panel shows the result
  if (typeof BroadcastChannel === 'function') {
    const convs = new BroadcastChannel('eden-convs');
    convs.addEventListener('message', (e) => { const c = hooks && hooks.conv(); if (c && e.data && e.data.id === c.id) setTimeout(() => { refresh(); tellFrame(); }, 250); });
  }
  addEventListener('pagehide', () => { if (presence) presence.close(); presence = null; });
  // any save of this deck's chat (an edit, a model's new version, a comment): the room gets what it doesn't have
  addEventListener('eden:conv-saved', (e) => { const c = hooks && hooks.conv(); if (room && c && e.detail && e.detail.id === c.id) room.push(c).catch(() => {}); });
}

// ── presence ──

function ensurePresence() {
  const c = hooks && hooks.conv();
  if (!c || IN_APP || typeof BroadcastChannel !== 'function') return;
  const key = `${c.id}|${roomEnabled() && c.deckRoom ? c.deckRoom.id : ''}`;
  if (presence && presenceConv === key) return;
  if (presence) presence.close();
  if (room) { room.close(); room = null; }
  presenceConv = key;
  peers = [];
  roomState = { status: '', detail: '' };
  let channel = new BroadcastChannel('eden-deck-presence');
  let deckKey = c.id;
  if (roomEnabled() && c.deckRoom) { // across devices: askeden.com's deck room (deck-room.js; flag, not deployed)
    room = openRoom(c, {
      getConv: () => { const x = hooks && hooks.conv(); return x && x.deckRoom && c.deckRoom && x.deckRoom.id === c.deckRoom.id ? x : null; },
      onChange: (conv) => roomChanged(conv),
      onStatus: (status, detail = '') => { roomState = { status, detail }; drawBar(); if (status === 'open' || status === 'closed') refresh(); },
    });
    if (room) { channel = room.channel; deckKey = c.deckRoom.id; }
  }
  presence = new Presence({ channel, deck: deckKey, me: { id: tabId, name: myName(), color: colorFor(tabId) }, onChange: (list) => { peers = list; drawBar(); tellFrame(); } });
}

/** Another device changed the deck: kept here, and the canvas shows the newest version. */
async function roomChanged(conv) {
  saveConversation(conv);
  if (hooks && hooks.conv() === conv) { const { openDeck } = await import('./deck.js'); openDeck(conv); }
  refresh(); tellFrame();
}

// A collaborator link (#deck-room&room=…&key=…&seat=…): its own chat for the shared deck, opened when the deck arrives.
if (!IN_APP && typeof location !== 'undefined' && roomEnabled()) {
  const link = readRoomLink(location.hash);
  if (link) {
    try { history.replaceState(null, '', location.pathname + location.search); } catch { /* the key stays in the address */ }
    let tries = 0;
    const join = () => {
      if (!Array.isArray(state.convs) || (!state.convs.length && tries++ < 30)) { setTimeout(join, 300); return; } // the chats load first
      let c = state.convs.find((x) => x.deckRoom && x.deckRoom.id === link.id);
      if (!c) {
        c = newConversation();
        Object.assign(c, { title: tx('Shared deck'), titleSet: true, mode: 'slides', privacy: true, deckRoom: { ...link, owner: false }, deckVersions: [] }); // private: a copy of someone else's deck never goes to this account's sync
        addConversation(c);
      }
      state.current = c; appUi.render(); appUi.renderSidebar();
      toast(tx('Joining the shared deck…'));
      const r = openRoom(c, { getConv: () => c, onChange: async (conv) => { saveConversation(conv); r.close(); const { openDeck } = await import('./deck.js'); openDeck(conv); }, onStatus: (st, d) => { if (st === 'closed' || st === 'error') toast(d === 'revoked' || d === 'forbidden' ? tx('This link was revoked or isn’t valid.') : tx('Couldn’t join the shared deck.')); } });
      // (this first link only fetches the deck; the editor opens its own once the deck is shown)
      if (!r) toast(tx('This link is incomplete.'));
    };
    setTimeout(join, 0);
  }
}

export function presenceBar() {
  if (IN_APP) return null;
  cssOnce();
  barEl ||= el('div', { class: 'deck-presence', role: 'status', 'aria-label': tx('Who else is here') });
  ensurePresence();
  drawBar();
  return barEl;
}
function drawBar() {
  if (!barEl) return;
  const me = myName();
  const lines = peers.map((p) => [p, peerLine(p, { you: me })]);
  const key = JSON.stringify([roomState.status, lines.map(([p, l]) => [p.color, l])]);
  if (barEl.dataset.key === key) return; // pointer moves only: the line stays as it is (and screen readers aren't told)
  barEl.dataset.key = key;
  const roomLine = room && roomState.status && roomState.status !== 'open' ? el('span', { class: 'deck-peer deck-room-state', style: { '--peer': '#8e8e93' } }, roomState.status === 'offline' ? tx('Offline: changes will sync') : roomState.status === 'connecting' ? tx('Connecting…') : roomState.status === 'closed' ? tx('No longer shared') : tx('Sync problem')) : null;
  barEl.replaceChildren(...(roomLine ? [roomLine] : []), ...lines.map(([p, line]) => el('span', { class: 'deck-peer', title: line, style: { '--peer': p.color } },
    el('i', { 'aria-hidden': 'true' }, (p.name.match(/\p{L}|\p{N}/u) || ['?'])[0].toUpperCase()), el('span', '', line))));
  barEl.hidden = !lines.length && !roomLine;
}

// ── the Comments tray ──

export function commentsPanel() {
  if (IN_APP) return null;
  cssOnce();
  if (!panelEl) {
    panelEl = el('div', { class: 'deck-comments' });
    panelEl.addEventListener('focusin', (e) => { const k = e.target.dataset && e.target.dataset.ck; if (k) ui.focusKey = k; });
  }
  const had = ui.focusKey;
  refresh();
  setTimeout(() => { // the toolbar was redrawn: focus goes back where it was in the tray, if it was lost
    const lost = !document.activeElement || document.activeElement === document.body;
    const back = had && panelEl.querySelector(`[data-ck="${CSS.escape(had)}"]`);
    if (lost && back && panelEl.isConnected) back.focus({ preventScroll: true });
  }, 0);
  return panelEl;
}

/** Start a comment on a slide (or a piece of it): the right-click menu's "Add comment" (deck-arrange.js). */
export function commentOn(anchor) { if (anchor && Number.isInteger(anchor.slide) && anchor.slide >= 0) startDraft({ slide: anchor.slide, path: typeof anchor.path === 'string' && /^[A-Za-z][A-Za-z0-9.]{0,39}$/.test(anchor.path) ? anchor.path : '' }); }
function startDraft(anchor) {
  const deck = deckNow();
  ui.draft = { anchor: { ...anchor, title: slideTitle(deck, anchor.slide) }, text: '', to: '', due: '' };
  ui.focusKey = 'draft-text';
  openTray();
  refresh();
  tellFrame();
  setTimeout(() => { const t = panelEl && panelEl.querySelector('[data-ck="draft-text"]'); if (t) t.focus(); }, 0);
}
function openTray() {
  const b = document.getElementById('deck-tools-comments-button');
  if (b && b.getAttribute('aria-expanded') !== 'true') b.click();
}

/** A textarea with @mention suggestions under it (people who commented, were assigned, or are here now). */
function mentionBox({ key, value, label, onInput, onSubmit }) {
  const area = el('textarea', { class: 'deck-cm-text', rows: '2', maxlength: String(LIMITS.text), 'aria-label': label, placeholder: tx('Add a comment… @ to mention someone'), 'data-ck': key });
  area.value = value || '';
  const sugg = el('div', { class: 'deck-cm-sugg', role: 'group', 'aria-label': tx('Mention'), hidden: true });
  const update = () => {
    onInput(area.value);
    const before = area.value.slice(0, area.selectionStart);
    const m = before.match(/(?:^|\s)@([\p{L}\p{N}._-]{0,30})$/u);
    const names = m ? people(commentsOf(hooks.conv()), [...peers.map((p) => p.name), myName()]).filter((n) => n.toLowerCase().startsWith(m[1].toLowerCase())).slice(0, 6) : [];
    sugg.replaceChildren(...names.map((n) => el('button', { type: 'button', class: 'cap', onclick: () => {
      const at = before.length - m[1].length - 1;
      const token = /\s/.test(n) ? `@[${n}] ` : `@${n} `;
      area.value = area.value.slice(0, at) + token + area.value.slice(area.selectionStart);
      area.focus(); area.selectionStart = area.selectionEnd = at + token.length; update();
    } }, `@${n}`)));
    sugg.hidden = !names.length;
  };
  area.addEventListener('input', update);
  area.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); onSubmit(); } e.stopPropagation(); });
  return [area, sugg];
}
/** Text with its @mentions marked. */
function withMentions(textValue) {
  const parts = [];
  let last = 0;
  for (const m of textValue.matchAll(/@(?:\[[^\]\n]{1,60}\]|[\p{L}\p{N}][\p{L}\p{N}._-]{0,39})/gu)) {
    parts.push(textValue.slice(last, m.index), el('b', 'deck-cm-at', m[0].replace(/[[\]]/g, '')));
    last = m.index + m[0].length;
  }
  parts.push(textValue.slice(last));
  return parts;
}

function refresh() {
  if (!panelEl || !hooks) return;
  const c = hooks.conv(), deck = deckNow();
  if (!c || !deck) { panelEl.replaceChildren(); return; }
  const list = commentsOf(c);
  const me = myName();
  const open = visible(list).filter((t) => !t.resolved).length;
  const mine = filterThreads(deck, list, 'mine', { me }).length;
  const btn = document.getElementById('deck-tools-comments-button'); // the tray's button says how many are open
  if (btn) { btn.dataset.count = open ? String(open) : ''; btn.setAttribute('aria-label', `${tx('Comments')}${open ? `, ${open} ${tx('open')}` : ''}`); }
  const slide = hooks.slide();
  const nameIn = el('input', { type: 'text', class: 'deck-cm-name', maxlength: String(LIMITS.name), value: me, 'aria-label': tx('Your name on comments'), 'data-ck': 'name', onchange: (e) => { store.set(NAME_KEY, cleanName(e.target.value)); session.set(NAME_KEY, cleanName(e.target.value)); if (presence) presence.rename(myName()); refresh(); } });
  const filters = [['open', tx('Open')], ['mine', `${tx('My tasks')}${mine ? ` (${mine})` : ''}`], ['mentions', tx('@ me')], ['slide', tx('This slide')], ['tasks', tx('All tasks')], ['resolved', tx('Resolved')], ['all', tx('All')]];
  const filterSel = el('select', { class: 'deck-theme', 'aria-label': tx('Show comments'), 'data-ck': 'filter', onchange: (e) => { ui.filter = e.target.value; refresh(); } },
    ...filters.map(([v, l]) => el('option', { value: v, selected: v === ui.filter ? true : null }, l)));
  const head = el('div', 'deck-tool-head', el('h4', '', tx('Comments'), ' ', el('small', '', `${open} ${tx('open')}`)), filterSel);
  const who = el('label', 'deck-cm-who', el('span', '', tx('You are')), nameIn);
  const actions = el('div', 'deck-cm-actions',
    el('button', { type: 'button', class: 'cap primary', 'data-ck': 'new-slide', onclick: () => startDraft({ slide: hooks.slide() }) }, `${tx('Comment on slide')} ${slide + 1}`),
    el('button', { type: 'button', class: 'cap', 'data-ck': 'pick', 'aria-pressed': String(ui.pick), onclick: () => { ui.pick = !ui.pick; tellFrame(); refresh(); if (ui.pick) toast(tx('Click a title, a bullet or a chart on the slide. Escape cancels.')); } }, ui.pick ? tx('Click on the slide… (cancel)') : tx('Comment on a part…')));
  const kids = [head, who, actions];
  if (roomEnabled()) kids.push(togetherBox(c));
  if (ui.draft) kids.push(draftBox(deck));
  const shown = filterThreads(deck, list, ui.filter, { me, slide });
  kids.push(shown.length ? el('ol', { class: 'deck-cm-list', 'aria-label': tx('Comment threads') }, ...shown.map((t) => thread(deck, t, me)))
    : el('p', 'deck-cm-empty', ui.filter === 'mine' ? tx('No tasks for you.') : ui.filter === 'open' ? tx('No open comments. Select a slide and comment on it.') : tx('Nothing here.')));
  panelEl.replaceChildren(...kids);
}

function draftBox(deck) {
  const d = ui.draft;
  const post = () => {
    const textValue = d.text.trim();
    if (!textValue) { toast(tx('Write the comment first')); return; }
    const ok = change((list) => addComment(list, { by: myName(), text: textValue, anchor: d.anchor, task: d.to ? { to: d.to, due: d.due } : null }));
    if (!ok) { toast(tx('This deck has too many comments: resolve or delete some first')); return; }
    const named = mentionsIn(textValue);
    ui.draft = null; ui.focusKey = 'new-slide';
    toast(named.length ? `${tx('Comment added; mentioned')} ${named.join(', ')}` : d.to ? `${tx('Task assigned to')} ${d.to}` : tx('Comment added'));
    refresh(); tellFrame();
  };
  const [area, sugg] = mentionBox({ key: 'draft-text', value: d.text, label: `${tx('Comment on')} ${anchorLabel(deck, { anchor: d.anchor })}`, onInput: (v) => { d.text = v; }, onSubmit: post });
  return el('div', { class: 'deck-cm-draft', role: 'group', 'aria-label': tx('New comment') },
    el('div', 'deck-cm-anchor', anchorLabel(deck, { anchor: d.anchor })), area, sugg,
    assignFields(d, 'draft'),
    el('div', 'deck-cm-row', el('button', { type: 'button', class: 'cap primary', 'data-ck': 'draft-post', onclick: post }, tx('Comment')),
      el('button', { type: 'button', class: 'cap', 'data-ck': 'draft-cancel', onclick: () => { ui.draft = null; ui.focusKey = 'new-slide'; refresh(); } }, tx('Cancel'))));
}

/** "Assign to" and "Due" fields bound to `o.to` / `o.due`. */
function assignFields(o, key) {
  const listId = `deck-cm-people-${key}`;
  const names = people(commentsOf(hooks.conv()), [...peers.map((p) => p.name), myName()]);
  return el('div', 'deck-cm-row',
    el('label', 'deck-cm-field', el('span', '', tx('Assign to')), el('input', { type: 'text', list: listId, maxlength: String(LIMITS.name), value: o.to || '', placeholder: tx('Nobody'), 'data-ck': `${key}-to`, oninput: (e) => { o.to = cleanName(e.target.value); } })),
    el('datalist', { id: listId }, ...names.map((n) => el('option', { value: n }))),
    el('label', 'deck-cm-field', el('span', '', tx('Due')), el('input', { type: 'date', value: o.due || '', 'data-ck': `${key}-due`, oninput: (e) => { o.due = e.target.value; } })));
}

function thread(deck, t, me) {
  const id = t.id;
  const st = taskState(t, today());
  const i = anchorIndex(deck, t);
  const replies = (t.replies || []).filter((r) => !r.deleted);
  const kids = [
    el('div', 'deck-cm-top',
      el('button', { type: 'button', class: 'deck-cm-anchor', 'data-ck': `go-${id}`, disabled: i < 0 ? true : null, onclick: () => goTo(i), title: tx('Show this slide') }, anchorLabel(deck, t)),
      t.resolved ? el('span', 'deck-cm-flag', tx('Resolved')) : null),
    el('div', 'deck-cm-msg', el('div', 'deck-cm-by', el('strong', '', t.by), ' · ', ago(t.at)), el('div', 'deck-cm-body', ...withMentions(t.text))),
  ];
  if (t.task) {
    kids.push(el('div', { class: `deck-cm-task ${st}` },
      el('span', '', `${tx('Task for')} ${t.task.to}${t.task.due ? ` · ${tx('due')} ${t.task.due}` : ''}`, st === 'overdue' ? ` · ${tx('overdue')}` : st === 'today' ? ` · ${tx('due today')}` : ''),
      el('label', 'deck-cm-done', el('input', { type: 'checkbox', checked: t.task.done ? true : null, 'data-ck': `done-${id}`, onchange: (e) => change((list) => setTaskDone(list, id, e.target.checked)) }), tx('Done'))));
  }
  for (const r of replies) {
    kids.push(el('div', 'deck-cm-msg deck-cm-reply', el('div', 'deck-cm-by', el('strong', '', r.by), ' · ', ago(r.at),
      r.by === me ? el('button', { type: 'button', class: 'deck-cm-x', 'aria-label': tx('Delete reply'), 'data-ck': `delr-${r.id}`, onclick: () => change((list) => deleteReply(list, id, r.id)) }, '×') : null),
    el('div', 'deck-cm-body', ...withMentions(r.text))));
  }
  if (ui.replyTo === id) {
    const send = () => { const v = (ui.replyText[id] || '').trim(); if (!v) return; change((list) => addReply(list, id, { by: myName(), text: v })); ui.replyText[id] = ''; ui.replyTo = ''; ui.focusKey = `reply-${id}`; refresh(); };
    const [area, sugg] = mentionBox({ key: `replytext-${id}`, value: ui.replyText[id], label: tx('Reply'), onInput: (v) => { ui.replyText[id] = v; }, onSubmit: send });
    area.placeholder = tx('Reply… @ to mention someone');
    kids.push(area, sugg, el('div', 'deck-cm-row', el('button', { type: 'button', class: 'cap primary', 'data-ck': `send-${id}`, onclick: send }, tx('Reply')),
      el('button', { type: 'button', class: 'cap', 'data-ck': `cancel-${id}`, onclick: () => { ui.replyTo = ''; ui.focusKey = `reply-${id}`; refresh(); } }, tx('Cancel'))));
  }
  if (ui.assignOpen === id) {
    const o = { to: (t.task && t.task.to) || '', due: (t.task && t.task.due) || '' };
    kids.push(assignFields(o, `as-${id}`), el('div', 'deck-cm-row',
      el('button', { type: 'button', class: 'cap primary', 'data-ck': `assign-save-${id}`, onclick: () => { change((list) => assignTask(list, id, o)); ui.assignOpen = ''; ui.focusKey = `assign-${id}`; refresh(); if (o.to) toast(`${tx('Task assigned to')} ${o.to}`); } }, tx('Save')),
      el('button', { type: 'button', class: 'cap', 'data-ck': `assign-cancel-${id}`, onclick: () => { ui.assignOpen = ''; refresh(); } }, tx('Cancel'))));
  }
  kids.push(el('div', 'deck-cm-row deck-cm-tools',
    ui.replyTo !== id ? el('button', { type: 'button', class: 'cap', 'data-ck': `reply-${id}`, onclick: () => { ui.replyTo = id; ui.focusKey = `replytext-${id}`; refresh(); setTimeout(() => { const a = panelEl.querySelector(`[data-ck="replytext-${id}"]`); if (a) a.focus(); }, 0); } }, tx('Reply')) : null,
    el('button', { type: 'button', class: 'cap', 'data-ck': `resolve-${id}`, onclick: () => { change((list) => setResolved(list, id, !t.resolved)); } }, t.resolved ? tx('Reopen') : tx('Resolve')),
    ui.assignOpen !== id ? el('button', { type: 'button', class: 'cap', 'data-ck': `assign-${id}`, onclick: () => { ui.assignOpen = id; refresh(); } }, t.task ? tx('Reassign') : tx('Assign')) : null,
    t.by === me ? el('button', { type: 'button', class: 'cap', 'data-ck': `del-${id}`, onclick: () => { if (confirm(tx('Delete this comment and its replies?'))) change((list) => deleteComment(list, id)); } }, tx('Delete')) : null));
  return el('li', { class: `deck-cm-thread${t.resolved ? ' resolved' : ''}`, 'data-thread': id }, ...kids);
}

/** Editing together on other devices (flag): start, the two links, stop. */
function togetherBox(c) {
  const r = c.deckRoom;
  const copy = (text, what) => { navigator.clipboard.writeText(text).then(() => toast(`${what} ${tx('copied')}`), () => toast(tx('Couldn’t copy'))); };
  if (!r) {
    return el('div', 'deck-cm-row deck-cm-together', el('button', { type: 'button', class: 'cap', 'data-ck': 'together', onclick: async () => {
      try { await startRoom(c, { post: postJSON }); saveConversation(c); ensurePresence(); refresh(); toast(tx('Editing together is on: copy a link for each person')); } catch (e) { toast(e.message || tx('Couldn’t start editing together')); }
    } }, tx('Edit together on other devices…')));
  }
  const state1 = roomState.status === 'open' ? `${tx('Live')} · ${peers.length + 1} ${tx('here')}` : roomState.status === 'offline' ? tx('Offline: changes will sync') : roomState.status || '';
  return el('div', 'deck-cm-together', el('h4', '', tx('Editing together'), ' ', el('small', '', state1)),
    r.owner && r.links ? el('div', 'deck-cm-row',
      el('button', { type: 'button', class: 'cap', 'data-ck': 'copy-edit', onclick: () => copy(r.links.edit, tx('Edit link')) }, tx('Copy edit link')),
      el('button', { type: 'button', class: 'cap', 'data-ck': 'copy-view', onclick: () => copy(r.links.view, tx('View link')) }, tx('Copy view-only link')),
      el('button', { type: 'button', class: 'cap', 'data-ck': 'stop-together', onclick: async () => { if (!confirm(tx('Stop editing together? Both links stop working.'))) return; try { await stopRoom(c, { post: postJSON }); saveConversation(c); ensurePresence(); refresh(); } catch (e) { toast(e.message || tx('Couldn’t stop it')); } } }, tx('Stop'))) : null,
    el('p', '', tx('Anyone with a link can open this deck: send it only to the people it’s for. The link holds the key; askeden.com sees only encrypted data.')));
}
