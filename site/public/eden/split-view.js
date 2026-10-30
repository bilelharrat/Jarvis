// Eden Chat's multi-window / split-view controller, mirrored from Eden Code
// (src/eden_code/web/features/code-split/window.js): up to ten live chats side by side in
// vertical columns by default (or a 2×2 / 3×2 / 4×2 / 5×2 grid when switched), resizable dividers,
// a header on each pane (sidebar toggle on the leftmost/topmost pane, status dot, title,
// activity mark, layout mode, add, swap, "only this one", close), one-pane-at-a-time tab
// switcher when narrow, drag-and-drop from the sidebar, and per-pane transcript + composer
// with Steer without interrupting. Persisted in localStorage (`jchat:split`).

import { $, el, toast, fmtCost, relDay, shortModel, store } from './util.js';
import { state, path, addConversation, newConversation, sessionCost } from './state.js';
import { sendMessage, stop, queueFollowUp, steerNow, dropQueued } from './chat.js';
import { emptyState } from './render.js';
import { CHAT_MODES, CODE_MODES, icon, modelMenu, openMenu } from './composer.js';
import { currentOverride, modelInfo } from './router.js';
import { imagesAvailable, videosAvailable } from './image-mode.js';
import { putDraft, getDraft, storeDrafts, DRAFT_KEY } from './resilience.js';
import {
  MAX_PANES, MIN_PANE, MIN_PANE_H, GAP,
  gridFor, rects, dividers, clampFracs, cleanFracs, dragFracs, dropTarget, neighbor, sidePane,
  cleanState, resolveSide, restorePanes, splitCommand, findSession, pickable, route, afterChange,
  paneMark, keyAction,
} from './split-view-model.js';

export const SPLIT_KEY = 'jchat:split';
export const SPLIT_SHORTCUT = '⌘⇧\\';
export const SPLIT_HELP = 'Split view: up to 10 chats side by side · /split close';

const NS = 'http://www.w3.org/2000/svg';
const GLYPHS = {
  add: ['M8 3.5v9', 'M3.5 8h9'],
  swap: ['M3 5.5h9.5', 'M10 3l2.5 2.5L10 8', 'M13 10.5H3.5', 'M6 8l-2.5 2.5L6 13'],
  alone: ['M9.5 2.5h4v4', 'M13.5 2.5L9 7', 'M6.5 13.5h-4v-4', 'M2.5 13.5L7 9'],
  close: ['M4.5 4.5l7 7', 'M11.5 4.5l-7 7'],
  side: ['M2.5 3.5h11a1.5 1.5 0 0 1 1.5 1.5v6a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 1 11V5a1.5 1.5 0 0 1 1.5-1.5z', 'M6 3.5v9'],
  cols: ['M2.5 3.5h11a1.5 1.5 0 0 1 1.5 1.5v6a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 1 11V5a1.5 1.5 0 0 1 1.5-1.5z', 'M5.5 3.5v9', 'M8.5 3.5v9', 'M11.5 3.5v9'],
  grid: ['M2.5 3.5h11a1.5 1.5 0 0 1 1.5 1.5v6a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 1 11V5a1.5 1.5 0 0 1 1.5-1.5z', 'M8 3.5v9', 'M1 8h14'],
};

function glyph(name, size = 14) {
  const svg = document.createElementNS(NS, 'svg');
  for (const [k, v] of Object.entries({ width: size, height: size, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.5', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' })) svg.setAttribute(k, String(v));
  for (const d of GLYPHS[name] || []) {
    const p = document.createElementNS(NS, 'path');
    p.setAttribute('d', d);
    svg.append(p);
  }
  return svg;
}

let H = {};
let stage = null;
let ownNode = null;
const own = { own: true, key: '', head: null };
const R = {
  on: false,
  panes: [own],
  focus: 0,
  cols: [],
  rows: [],
  vertical: true, // vertical side-by-side columns by default (false: 2×2 / 3×2 grid)
  grid: { cols: 1, rows: 1, one: false },
  boxes: [],
  fresh: new Set(),
  restored: false,
};

let uid = 0;
let saveTimer = 0;
let saved = '';
let frameDue = 0;
const bars = new Map();
let dropOverlay = null;
let dropZone = null;
let dropLabel = null;
let draggedId = null;

const convOf = (id) => (id == null ? null : state.convs.find((x) => x.id === id) || null);
const idOf = (p) => (p.own ? (state.current ? state.current.id : null) : p.id);
const ids = () => R.panes.map(idOf);
const ownAt = () => R.panes.indexOf(own);
const focused = () => R.panes[R.focus] || own;
const frames = () => R.panes.filter((p) => !p.own);
const at = (p) => R.panes.indexOf(p);
const claim = () => { R.restored = true; };

function asksOf(id) {
  const c = convOf(id);
  if (!c) return 0;
  if (c.status === 'waiting') return 1;
  const last = path(c).at(-1);
  if (!last || last.role !== 'assistant') return 0;
  const perms = (last.parts || []).filter((p) => p.type === 'perm' && (!p.state || p.state === 'pending')).length;
  const bCard = last.browserCard && !last.browserCard.answer ? 1 : 0;
  return perms + bCard;
}

function statusOf(c) {
  if (!c) return 'past';
  if (state.streams.has(c.id)) return 'run';
  if (c.status === 'waiting' || asksOf(c.id) > 0) return 'wait';
  return 'done';
}

function named(c) {
  if (!c) return '';
  return H.titleOf ? H.titleOf(c) : String(c.title || '');
}

function readDrafts() {
  try { return JSON.parse(sessionStorage.getItem(DRAFT_KEY) || '{}') || {}; } catch { return {}; }
}
function keepPaneDraft(chatId, text) {
  if (!chatId) return;
  try {
    storeDrafts((json) => sessionStorage.setItem(DRAFT_KEY, json), putDraft(readDrafts(), chatId, text), chatId);
  } catch { /* storage blocked */ }
}

function makeHead(pane) {
  const box = el('div', 'sv-head');
  box.hidden = true;
  box.draggable = true;
  const dot = el('span', 'dot done');
  const title = el('span', { class: 'sv-title', 'data-no-i18n': '' });
  title.id = `sv-title-${(uid += 1)}`;
  const mark = el('span', 'sv-mark');
  mark.hidden = true;
  const tabs = el('div', { class: 'sv-tabs', role: 'tablist', 'aria-label': 'Panes' });
  tabs.hidden = true;
  tabs.addEventListener('keydown', tabKeys);

  const button = (cls, label, icName, word, run) => {
    const b = el('button', { type: 'button', class: `sv-btn ${cls}`, title: label, 'aria-label': label });
    b.append(glyph(icName), el('span', 'sv-word', word));
    b.addEventListener('click', (e) => { e.stopPropagation(); run(); });
    return b;
  };
  const side = button('sv-side', 'Hide sidebar', 'side', 'sidebar', () => H.toggleSidebar && H.toggleSidebar());
  side.hidden = true;
  side.setAttribute('aria-controls', 'sidebar');
  const mode = button('sv-layout', 'Arrange panes in a grid', 'grid', 'grid', () => setVertical(!R.vertical));
  mode.hidden = true;
  const addBtn = button('sv-add', 'Add a pane', 'add', 'add', () => add(null, { where: at(pane) + 1 }));
  const swap = button('sv-swap', 'Swap with the next pane', 'swap', 'swap', () => swapPane(at(pane)));
  const alone = button('sv-alone', 'Show only this chat', 'alone', 'alone', () => only(at(pane)));
  const close = button('sv-close', 'Close this pane', 'close', 'close', () => closePane(at(pane)));
  box.append(side, dot, title, tabs, mark, mode, addBtn, swap, alone, close);
  box.addEventListener('pointerdown', (e) => { if (!e.target.closest('button')) setFocus(at(pane), true); });
  box.addEventListener('dragstart', (e) => {
    if (e.target && e.target.closest && e.target.closest('button')) { e.preventDefault(); return; }
    const id = idOf(pane);
    if (!id) { e.preventDefault(); return; }
    draggedId = id;
    if (e.dataTransfer) {
      try {
        e.dataTransfer.setData('text/eden-chat', id);
        e.dataTransfer.setData('text/plain', title.textContent || '');
        e.dataTransfer.effectAllowed = 'move';
      } catch { /* ignore */ }
    }
    const center = $('center');
    if (center) center.classList.add('sv-drop-active');
    if (dropOverlay) {
      dropOverlay.hidden = false;
      dropZone.hidden = true;
    }
  });
  return { box, dot, title, mark, tabs, mode, add: addBtn, swap, side };
}

function placeSideToggle() {
  const s = $('sidebar');
  const open = s ? !s.classList.contains('closed') : true;
  const label = open ? 'Hide sidebar' : 'Show sidebar';
  const nearest = R.on ? sidePane(R.boxes, R.focus, R.grid.one) : -1;
  R.panes.forEach((p, k) => {
    if (!p.head) return;
    const b = p.head.side;
    b.hidden = k !== nearest;
    b.setAttribute('aria-expanded', String(open));
    if (b.dataset.label !== label) {
      b.dataset.label = label;
      b.title = `${label} (⌘B)`;
      b.setAttribute('aria-label', label);
    }
    const node = p.own ? ownNode : p.box;
    if (node) node.classList.toggle('sv-side-pane', k === nearest);
  });
}

function followPaneReply(scroller, msg, { snapToTop = true } = {}) {
  if (!scroller || !msg) return;
  const q = msg.previousElementSibling && msg.previousElementSibling.classList.contains('user') ? msg.previousElementSibling : msg;
  const sRect = scroller.getBoundingClientRect();
  const qRect = q.getBoundingClientRect();
  const mRect = msg.getBoundingClientRect();
  const qTop = scroller.scrollTop + (qRect.top - sRect.top);
  const mTop = scroller.scrollTop + (mRect.top - sRect.top);
  const mBottom = scroller.scrollTop + (mRect.bottom - sRect.top);
  const mdEl = msg.querySelector(':scope > .bubble > .md');
  const mdTop = mdEl ? scroller.scrollTop + (mdEl.getBoundingClientRect().top - sRect.top) : mTop;
  let targetTop;
  if (mdEl && (mdTop - qTop) > Math.max(220, scroller.clientHeight * 0.42)) {
    targetTop = Math.max(0, Math.round(mdTop - 88));
  } else if (q !== msg && qRect.height > Math.max(140, scroller.clientHeight * 0.28)) {
    targetTop = Math.max(0, Math.round(mTop - 52));
  } else {
    targetTop = Math.max(0, Math.round(qTop - 12));
  }
  const turnSpan = Math.max(0, mBottom - targetTop);
  const runway = Math.max(24, Math.ceil(scroller.clientHeight - turnSpan - 12));
  if (msg.parentElement) msg.parentElement.style.paddingBottom = `${runway}px`;
  if (snapToTop) scroller.scrollTop = targetTop;
}

function modesForPane(c) {
  if (c && c.kind === 'code') return CODE_MODES;
  return CHAT_MODES.filter((m) => (m.id === 'image' ? imagesAvailable() : m.id === 'video' ? videosAvailable() : true));
}

function makePane(id) {
  const p = { own: false, id: id ?? null, key: id || '', renderedId: undefined, recall: { index: -1, draft: '' }, steerThis: false };
  p.head = makeHead(p);
  p.box = el('section', { class: 'sv-pane', 'aria-labelledby': p.head.title.id });
  p.scroll = el('div', { class: 'sv-scroll', tabindex: '-1' });
  p.pick = el('div', 'sv-pick');
  p.pick.hidden = true;
  p.pickList = el('ul', 'sv-pick-list');
  const newBtn = el('button', { type: 'button', class: 'sv-pick-new', onclick: () => startNewInPane(p) }, '+ New chat');
  p.pick.append(el('div', 'sv-pick-head', el('span', 'sv-pick-label', 'Open a chat here'), newBtn), p.pickList);
  p.transcript = el('div', { class: 'sv-transcript', role: 'log', 'aria-live': 'polite', 'aria-relevant': 'additions' });
  p.scroll.append(p.pick, p.transcript);

  // Delegated transcript interactions inside this pane
  p.transcript.addEventListener('click', (e) => {
    setFocus(at(p));
    const c = convOf(p.id);
    if (H.onPaneTranscriptClick) H.onPaneTranscriptClick(e, c, p.transcript, (text) => setPaneText(p, text));
  });
  p.transcript.addEventListener('keydown', (e) => {
    const ta = e.target.closest('textarea[data-edit]');
    if (ta && e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      ta.closest('.msg')?.querySelector('[data-act="edit-send"]')?.click();
    }
  });
  p.transcript.addEventListener('input', (e) => {
    const ta = e.target.closest('textarea[data-edit]');
    if (ta) { ta.style.height = 'auto'; ta.style.height = `${Math.min(300, ta.scrollHeight)}px`; }
  });

  // Per-pane composer dock (with Steer without interrupting, Queue, Send/Stop, Mode & Model)
  p.queue = el('ul', { class: 'jc-queue', hidden: '', 'aria-label': 'Waiting to be sent' });
  p.orb = el('button', { type: 'button', class: 'jc-orb', 'aria-expanded': 'false', 'aria-label': 'Composer options', title: 'Options: mode, model, cost' });
  p.orb.innerHTML = '<svg class="jc-reactor" width="17" height="17" viewBox="0 0 40 40" aria-hidden="true"><circle class="halo" cx="20" cy="20" r="18.2"/><circle class="ring" cx="20" cy="20" r="14.6"/><circle class="inner" cx="20" cy="20" r="11.4"/><circle class="core" cx="20" cy="20" r="8.6"/><circle class="shine" cx="17.2" cy="16.8" r="3"/></svg>';
  p.input = el('textarea', { class: 'sv-input', rows: '1', placeholder: 'Message Eden — routed automatically…', 'aria-label': 'Message Eden' });
  p.steerBtn = el('button', { type: 'button', class: 'jc-steer', hidden: '', title: 'Steer: send into the running step without stopping it (⌘↩)' });
  p.steerBtn.innerHTML = '<svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 13c0-5 3-8 8-8"/><path d="M8 2l3 3-3 3"/></svg><span>Steer</span>';
  p.sendBtn = el('button', { type: 'submit', class: 'jc-send', 'aria-label': 'Send', title: 'Send (⏎)' });
  p.sendBtn.innerHTML = '<svg class="i-send" width="15" height="15" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M8 2.5l5 5-1.1 1.1L8.8 5.5V13.5H7.2V5.5L4.1 8.6 3 7.5z"/></svg><svg class="i-stop" width="12" height="12" viewBox="0 0 12 12" fill="currentColor" aria-hidden="true"><rect x="1.5" y="1.5" width="9" height="9" rx="2"/></svg>';

  p.modeIc = el('span', { class: 'jc-mode-ic', 'aria-hidden': 'true' });
  p.modeLbl = el('span', 'sv-mode-label', 'Chat');
  p.modeBtn = el('button', { type: 'button', class: 'jc-pill', 'aria-haspopup': 'menu', 'aria-expanded': 'false', title: 'Mode (⇧Tab to switch)' },
    p.modeIc, p.modeLbl);
  p.metaSpan = el('span', 'jc-meta');
  p.modelLbl = el('span', '', 'Model Router');
  p.modelBtn = el('button', { type: 'button', class: 'jc-pill ghost', 'aria-haspopup': 'menu', 'aria-expanded': 'false', title: 'Model' }, p.modelLbl);

  const drawer = el('div', 'jc-composer-drawer',
    el('div', 'jc-composer-drawer-in',
      el('div', 'jc-composer-row', p.modeBtn, el('span', 'jc-spacer'), p.metaSpan, p.modelBtn)));

  p.form = el('form', { class: 'jc-composer', autocomplete: 'off' },
    el('div', 'jc-composer-top', p.orb, el('div', 'jc-input-wrap', p.input), p.steerBtn, p.sendBtn),
    drawer);

  p.dock = el('div', 'jc jc-dock sv-dock', el('div', 'jc-column', p.queue, p.form));
  p.box.append(p.head.box, p.scroll, p.dock);

  p.box.addEventListener('pointerdown', () => setFocus(at(p)), true);
  p.box.addEventListener('keydown', () => setFocus(at(p)), true);

  p.orb.addEventListener('click', () => {
    const exp = !p.form.classList.contains('expanded');
    p.form.classList.toggle('expanded', exp);
    p.orb.setAttribute('aria-expanded', String(exp));
    if (exp) p.input.focus();
  });
  p.modeBtn.addEventListener('click', () => {
    const c = convOf(p.id);
    const modes = modesForPane(c);
    const cur = c ? c.mode : 'chat';
    openMenu(p.modeBtn, modes.map((m) => ({
      icon: m.icon, label: m.label, danger: m.danger, checked: cur === m.id, note: m.note,
      run: () => {
        if (c) { c.mode = m.id; c.chatPinned = m.id === 'chat'; H.save && H.save(c); }
        else p.pendingMode = m.id;
        renderPaneComposer(p);
      },
    })));
  });
  p.modelBtn.addEventListener('click', () => modelMenu());
  p.steerBtn.addEventListener('click', () => { p.steerThis = true; p.form.requestSubmit(); });
  p.sendBtn.addEventListener('click', (e) => {
    const c = convOf(p.id);
    if (c && state.streams.has(c.id)) {
      e.preventDefault();
      if (p.input.value.trim()) { p.steerThis = true; p.form.requestSubmit(); return; }
      stop(c);
    }
  });
  p.input.addEventListener('input', () => {
    p.recall.index = -1;
    p.input.style.height = 'auto';
    p.input.style.height = `${Math.min(220, p.input.scrollHeight)}px`;
    if (p.id) keepPaneDraft(p.id, p.input.value);
  });
  p.input.addEventListener('keydown', (e) => {
    if (e.key === 'Tab' && e.shiftKey) {
      e.preventDefault();
      const c = convOf(p.id);
      const modes = modesForPane(c).filter((m) => m.id !== 'bypassPermissions');
      const cur = c ? c.mode : (p.pendingMode || 'chat');
      const next = modes[(modes.findIndex((m) => m.id === cur) + 1) % modes.length];
      if (next) {
        if (c) { c.mode = next.id; c.chatPinned = next.id === 'chat'; H.save && H.save(c); }
        else p.pendingMode = next.id;
        renderPaneComposer(p);
      }
      return;
    }
    if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && !(e.shiftKey || e.metaKey || e.ctrlKey || e.altKey)) {
      const up = e.key === 'ArrowUp';
      const onEdge = up ? !p.input.value.slice(0, p.input.selectionStart).includes('\n') : !p.input.value.slice(p.input.selectionEnd).includes('\n');
      if ((p.recall.index >= 0 || (up && !p.input.value)) && onEdge && recallInPane(p, up ? -1 : 1)) { e.preventDefault(); return; }
    }
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      const c = convOf(p.id);
      if (c && state.streams.has(c.id)) p.steerThis = true;
      p.form.requestSubmit();
      return;
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      p.form.requestSubmit();
    }
  });
  p.form.addEventListener('submit', (e) => {
    e.preventDefault();
    submitPane(p);
  });

  if (p.id) {
    const draft = getDraft(readDrafts(), p.id);
    if (draft) p.input.value = draft;
  }
  stage.append(p.box);
  p.renderedId = p.id;
  renderPaneBody(p);
  renderPaneComposer(p);
  return p;
}

function recallInPane(p, step) {
  const c = convOf(p.id);
  const said = path(c).filter((n) => n.role === 'user').map((n) => n.content || '');
  if (!said.length) return false;
  if (p.recall.index < 0) { if (step > 0) return false; p.recall.draft = p.input.value; }
  const next = p.recall.index < 0 ? said.length - 1 : p.recall.index + step;
  if (next < 0) return true;
  if (next >= said.length) { p.recall.index = -1; p.input.value = p.recall.draft; }
  else { p.recall.index = next; p.input.value = said[next]; }
  p.input.selectionStart = p.input.selectionEnd = p.input.value.length;
  p.input.style.height = 'auto';
  p.input.style.height = `${Math.min(220, p.input.scrollHeight)}px`;
  return true;
}

function setPaneText(p, text) {
  p.input.value = text;
  p.input.focus();
  p.input.selectionStart = p.input.selectionEnd = text.length;
  p.input.style.height = 'auto';
  p.input.style.height = `${Math.min(220, p.input.scrollHeight)}px`;
  if (p.id) keepPaneDraft(p.id, text);
}

function startNewInPane(p) {
  const c = newConversation({ mode: p.pendingMode || 'chat' });
  p.pendingMode = undefined;
  addConversation(c);
  p.id = c.id;
  p.key = c.id;
  changed({ move: true });
}

function submitPane(p) {
  const steer = p.steerThis;
  p.steerThis = false;
  const text = p.input.value.trim();
  if (!text) return;
  if (text.startsWith('/')) {
    const [word, ...rest] = text.slice(1).split(/\s+/);
    const cmd = word.toLowerCase();
    if (cmd === 'split') {
      command(rest.join(' ').trim(), at(p));
      p.input.value = '';
      p.input.style.height = '';
      return;
    }
    if (H.slash && H.slash(cmd, rest.join(' ').trim())) {
      p.input.value = '';
      p.input.style.height = '';
      return;
    }
  }
  let c = convOf(p.id);
  if (c && state.streams.has(c.id)) {
    const willSteer = steer || Boolean(state.settings && state.settings.queueFollowUps === false);
    const item = queueFollowUp(c, text, { steer: willSteer });
    if (!item) return;
    if (c.kind !== 'code' && !willSteer) toast('Queued: sends when Eden finishes');
    p.input.value = '';
    p.input.style.height = '';
    keepPaneDraft(c.id, '');
    renderPaneComposer(p);
    return;
  }
  if (!c) {
    c = newConversation();
    if (p.pendingMode && p.pendingMode !== 'chat') c.mode = p.pendingMode;
    p.pendingMode = undefined;
    addConversation(c);
    p.id = c.id;
    p.key = c.id;
  }
  const ok = sendMessage(text, [], { conv: c });
  if (!ok) return;
  p.recall.index = -1;
  p.input.value = '';
  p.input.style.height = '';
  keepPaneDraft(c.id, '');
  changed();
}

function dropPane(p) {
  if (p.id && p.input && p.input.value.trim()) keepPaneDraft(p.id, p.input.value);
  if (p.box) p.box.remove();
}

function renderPanePicker(p) {
  if (!p || p.own) return;
  const c = convOf(p.id);
  if (c) { p.pick.hidden = true; return; }
  const others = ids().filter((x, k) => R.panes[k] !== p && x != null);
  const items = pickable(state.convs, others).slice(0, 8);
  p.pick.hidden = false;
  p.pickList.replaceChildren(...items.map((x) => {
    const b = el('button', { type: 'button', class: 'sv-pick-row' },
      el('span', `dot ${statusOf(x)}`),
      el('span', { class: 'sv-pick-title', 'data-no-i18n': '' }, named(x) || 'New chat'),
      el('small', '', x.kind === 'code' && x.project ? x.project.name : relDay(x.updated)));
    b.addEventListener('click', () => showIn(at(p), x.id));
    return el('li', '', b);
  }));
}

function renderPaneBody(p) {
  if (!p || p.own) return;
  renderPanePicker(p);
  const c = convOf(p.id);
  const nodes = c ? path(c) : [];
  if (!nodes.length) {
    p.transcript.replaceChildren(emptyState(c, { onSuggest: (text) => setPaneText(p, text) }));
    return;
  }
  const existing = p.transcript.querySelectorAll(':scope > .msg');
  if (existing.length > 0 && !p.transcript.querySelector('#empty') && existing.length < nodes.length) {
    let match = true;
    for (let i = 0; i < existing.length; i += 1) {
      if (existing[i].dataset.id !== nodes[i].id) { match = false; break; }
    }
    if (match && H.msgEl) {
      const prevIdx = existing.length - 1;
      existing[prevIdx].replaceWith(H.msgEl(c, nodes[prevIdx], false));
      for (let i = existing.length; i < nodes.length; i += 1) {
        p.transcript.append(H.msgEl(c, nodes[i], i === nodes.length - 1));
      }
      requestAnimationFrame(() => {
        const lastMsg = p.transcript.lastElementChild;
        if (lastMsg && lastMsg.classList.contains('msg')) followPaneReply(p.scroll, lastMsg);
      });
      return;
    }
  }
  if (H.msgEl) {
    p.transcript.replaceChildren(...nodes.map((n, i) => H.msgEl(c, n, i === nodes.length - 1)));
    requestAnimationFrame(() => {
      const lastMsg = p.transcript.lastElementChild;
      if (lastMsg && lastMsg.classList.contains('msg')) followPaneReply(p.scroll, lastMsg);
    });
  }
}

function renderPaneComposer(p) {
  if (!p || p.own) return;
  const c = convOf(p.id);
  const code = Boolean(c && c.kind === 'code');
  const streaming = Boolean(c && state.streams.has(c.id));
  const modes = modesForPane(c);
  const modeId = c ? c.mode : (p.pendingMode || 'chat');
  const m = modes.find((x) => x.id === modeId) || modes[0];
  p.modeIc.replaceChildren(icon(m.icon, 14));
  p.modeLbl.textContent = m.label;
  p.modeBtn.dataset.mode = m.css || m.id;
  p.modeBtn.title = `${m.label}: ${m.note} (⇧⇥ to switch)`;

  const o = currentOverride();
  const om = o && modelInfo(o.model);
  p.modelLbl.textContent = o ? (om ? shortModel(om.name) : o.model) : code ? 'Claude Code' : 'Model Router';
  p.modelBtn.classList.toggle('routed', !o);

  const s = sessionCost(c);
  const lastTurn = s.turns.at(-1);
  p.metaSpan.hidden = !code;
  p.metaSpan.textContent = code && s.turns.length ? `${fmtCost(lastTurn)} · ${fmtCost(s.total)}` : '';

  p.sendBtn.classList.toggle('stop', streaming);
  p.sendBtn.setAttribute('aria-label', streaming ? 'Stop' : 'Send');
  p.sendBtn.title = streaming ? 'Stop (Esc). Type to steer instead: it goes in without stopping the reply' : 'Send (⏎)';
  p.steerBtn.hidden = !streaming;
  p.form.classList.toggle('busy', streaming);
  p.input.placeholder = code ? `Ask Eden in ${c.project ? c.project.name : 'this project'}…`
    : m.id === 'search' ? 'Search the web — answers with sources…'
    : m.id === 'research' ? 'What should I research? A sourced report…'
    : m.id === 'compare' ? 'Ask several models at once…'
    : 'Message Eden — routed automatically…';

  const q = (c && c.queue) || [];
  p.queue.hidden = !q.length;
  p.queue.replaceChildren(...q.map((item) => {
    const steered = item.state === 'sent' || item.state === 'sending' || Boolean(item.steer);
    return el('li', item.state === 'queued' && !steered ? 'jc-queued jc-queued-wait' : 'jc-queued',
      el('span', 'jc-queued-kicker', item.state === 'sent' ? 'Steered' : item.state === 'sending' ? 'Steering…' : item.steer ? 'Steered' : 'Queued'),
      el('span', { class: 'jc-queued-text', title: item.text }, el('span', { 'data-no-i18n': '' }, item.text), item.state === 'sent' ? ' — sent to the running step' : item.steer ? ' — into the running step' : ''),
      item.state === 'queued' && !item.steer && streaming ? el('button', { type: 'button', class: 'jc-queued-steer', title: 'Send it into the running step now, without stopping it', onclick: () => steerNow(c, item.id) }, 'Steer now') : null,
      item.state === 'sent' ? null : el('button', { type: 'button', class: 'jc-queued-x', 'aria-label': 'Remove from the queue', onclick: () => dropQueued(c, item.id) }, '×'));
  }));
}

export function updateSplitMessage(c, node, { final } = {}) {
  if (!R.on || !c) return;
  const fId = idOf(focused());
  if (c.id !== fId && node && node.role === 'assistant') {
    R.fresh.add(c.id);
    soon();
  }
  for (const p of frames()) {
    if (p.id !== c.id) continue;
    const old = p.transcript.querySelector(`.msg[data-id="${node.id}"]`);
    const keepTop = p.scroll.scrollTop;
    const nodes = path(c);
    if (!old || !H.msgEl) {
      renderPaneBody(p);
    } else {
      const isLast = nodes.at(-1) === node;
      const fresh = H.msgEl(c, node, isLast);
      old.replaceWith(fresh);
      if (isLast) followPaneReply(p.scroll, fresh, { snapToTop: true });
      else p.scroll.scrollTop = keepTop;
    }
    if (final) renderPaneComposer(p);
    soon();
  }
}

export function renderSplitPaneFor(c) {
  if (!R.on || !c) return;
  for (const p of frames()) {
    if (p.id === c.id) {
      p.renderedId = p.id;
      renderPaneBody(p);
      renderPaneComposer(p);
    }
  }
  soon();
}

function turnOn() {
  if (R.on) return;
  R.on = true;
  R.fresh.clear();
  if (ownNode) {
    ownNode.setAttribute('role', 'region');
    ownNode.setAttribute('aria-labelledby', own.head.title.id);
  }
}

function turnOff() {
  for (const p of frames()) dropPane(p);
  R.on = false;
  R.panes = [own];
  R.focus = 0;
  R.fresh.clear();
  if (ownNode) {
    ownNode.removeAttribute('role');
    ownNode.removeAttribute('aria-labelledby');
  }
}

function changed({ move = false } = {}) {
  for (const p of frames()) {
    if (p.renderedId !== p.id) {
      p.renderedId = p.id;
      renderPaneBody(p);
      renderPaneComposer(p);
    } else {
      renderPanePicker(p);
    }
  }
  layout();
  render();
  if (H.renderSidebar) H.renderSidebar();
  if (H.renderTitle) H.renderTitle();
  save();
  if (move) placeFocus();
}

export function add(id = null, { where = null, focus = true, quiet = false } = {}) {
  claim();
  const curId = state.current ? state.current.id : null;
  if (id != null && id === curId && !R.on) {
    toast('That chat is open here already: pick another one to see beside it.');
    return null;
  }
  if (id != null && R.on && ids().includes(id)) {
    setFocus(ids().indexOf(id), true);
    return null;
  }
  if (R.panes.length >= MAX_PANES) {
    toast('Split view holds up to 10 chats.');
    return null;
  }
  const p = makePane(id);
  const was = focused();
  turnOn();
  const k = where == null ? R.panes.length : Math.max(0, Math.min(R.panes.length, where));
  R.panes.splice(k, 0, p);
  R.focus = focus ? k : at(was);
  if (id != null) R.fresh.delete(id);
  changed();
  if (!quiet && focus) setTimeout(placeFocus, 40);
  return p;
}

export function showIn(k, id) {
  const p = R.panes[k];
  if (!p || id == null) return;
  const j = ids().indexOf(id);
  if (j >= 0) { setFocus(j, true); return; }
  R.fresh.delete(id);
  const c = convOf(id);
  if (p.own) {
    R.focus = k;
    if (c && H.selectHere) H.selectHere(c);
    setFocus(k, true, true);
    return;
  }
  if (p.id && p.input && p.input.value.trim()) keepPaneDraft(p.id, p.input.value);
  p.id = id;
  p.key = id;
  p.renderedId = id;
  if (p.input) {
    p.input.value = getDraft(readDrafts(), id) || '';
    p.input.style.height = 'auto';
  }
  renderPaneBody(p);
  renderPaneComposer(p);
  setFocus(k, true, true);
}

export function closePane(k) {
  if (!R.on || !R.panes[k]) return;
  claim();
  const p = R.panes[k];
  const was = focused();
  let next = was;
  if (p.own) {
    const near = [k + 1, k - 1, ...R.panes.map((_, i) => i)].filter((i) => i >= 0 && i < R.panes.length && i !== k);
    const q = R.panes[near.find((i) => R.panes[i].id != null) ?? near[0]];
    const take = q.id;
    const carryDraft = q.input ? q.input.value : '';
    R.panes[at(q)] = own;
    R.panes.splice(k, 1);
    dropPane(q);
    if (was === p || was === q) next = own;
    if (R.panes.length < 2) turnOff();
    else R.focus = Math.max(0, at(next));
    if (take != null && H.selectHere) H.selectHere(convOf(take));
    if (carryDraft && H.setComposerText) H.setComposerText(carryDraft);
  } else {
    R.panes.splice(k, 1);
    dropPane(p);
    if (was === p) next = R.panes[Math.max(0, k - 1)];
    if (R.panes.length < 2) turnOff();
    else R.focus = Math.max(0, at(next));
  }
  changed({ move: true });
}

export function only(k = R.focus) {
  const keep = R.panes[k];
  if (!R.on || !keep) return;
  claim();
  const take = keep.own ? null : keep.id;
  const carryDraft = !keep.own && keep.input ? keep.input.value : '';
  turnOff();
  if (take != null && H.selectHere) H.selectHere(convOf(take));
  if (carryDraft && H.setComposerText) H.setComposerText(carryDraft);
  changed({ move: true });
}

export function swapPane(k = R.focus) {
  const n = R.panes.length;
  if (!R.on || n < 2 || !R.panes[k]) return;
  claim();
  const j = (k + 1) % n;
  const was = focused();
  [R.panes[k], R.panes[j]] = [R.panes[j], R.panes[k]];
  R.focus = at(was);
  changed({ move: true });
}

function movePane(j, k) {
  const was = focused();
  const [p] = R.panes.splice(j, 1);
  R.panes.splice(Math.max(0, Math.min(R.panes.length, k > j ? k - 1 : k)), 0, p);
  R.focus = at(was);
  changed();
}

export function setVertical(on) {
  claim();
  const want = Boolean(on);
  if (R.vertical === want) return;
  R.vertical = want;
  layout();
  render();
  save();
}

export function setFocus(k, move = false, force = false) {
  if (!R.on || !R.panes[k]) return;
  if (R.focus !== k || force) {
    R.focus = k;
    const id = idOf(R.panes[k]);
    if (id != null) R.fresh.delete(id);
    const c = convOf(id);
    if (c) {
      state.selectedNode = [...path(c)].reverse().find((n) => n.role === 'assistant' && n.route) || null;
      if (H.renderInspector) H.renderInspector();
    }
    if (H.renderSidebar) H.renderSidebar();
    if (H.renderTitle) H.renderTitle();
    layout();
    render();
    save();
  }
  if (move) placeFocus();
}

function placeFocus() {
  if (!R.on) {
    const inp = $('deck-input');
    if (inp) inp.focus();
    return;
  }
  const p = focused();
  if (p.own) {
    const inp = $('deck-input');
    if (inp) inp.focus();
    return;
  }
  if (p.input) p.input.focus();
}

function area() {
  if (!stage) return { left: 0, top: 0, width: 1000, height: 700 };
  const box = stage.getBoundingClientRect();
  return { left: box.left, top: box.top, width: Math.max(0, box.width), height: Math.max(0, box.height) };
}

const place = (node, b) => {
  if (!node || !b) return;
  node.style.setProperty('--sv-x', `${b.x}px`);
  node.style.setProperty('--sv-y', `${b.y}px`);
  node.style.setProperty('--sv-w', `${b.w}px`);
  node.style.setProperty('--sv-h', `${b.h}px`);
};

const colMin = (room) => Math.min(MIN_PANE, Math.max(100, Math.floor(((room.width - GAP * Math.max(0, R.grid.cols - 1)) / Math.max(1, R.grid.cols)) * 0.6)));

const shares = (room) => ({
  cols: clampFracs(cleanFracs(R.cols, R.grid.cols), room.width, colMin(room)),
  rows: clampFracs(cleanFracs(R.rows, R.grid.rows), room.height, MIN_PANE_H),
});

export function layout() {
  const center = $('center');
  if (!center || !ownNode) return;
  center.classList.toggle('sv-on', R.on);
  if (!R.on) {
    center.classList.remove('sv-one');
    for (const name of ['--sv-x', '--sv-y', '--sv-w', '--sv-h']) ownNode.style.removeProperty(name);
    ownNode.classList.remove('sv-front', 'sv-corner', 'sv-side-pane', 'sv-top');
    drawDividers([]);
    placeSideToggle();
    return;
  }
  const room = area();
  const n = R.panes.length;
  const vert = R.vertical || n < 4;
  let grid = gridFor(n, room.width, room.height, undefined, undefined, undefined, vert);
  if (vert && grid.cols < n && room.width >= n * 120 + (n - 1) * GAP && room.height >= 100) {
    grid = gridFor(n, room.width, room.height, 120, 100, GAP, true);
  } else if (grid.one && n > 1 && room.width >= 420 && room.height >= 280) {
    grid = gridFor(n, room.width, room.height, 120, 100, GAP, vert);
  }
  const wasOne = R.grid.one;
  R.grid = grid;
  const { cols, rows } = shares(room);
  R.boxes = rects(n, grid, cols, rows, room.width, room.height);
  center.classList.toggle('sv-one', grid.one);
  R.panes.forEach((p, k) => {
    const node = p.own ? ownNode : p.box;
    const b = R.boxes[k];
    place(node, b);
    node.classList.toggle('sv-front', grid.one && k === R.focus);
    node.classList.toggle('sv-corner', b.x < 1 && b.y < 1);
    node.classList.toggle('sv-top', b.y < 1);
  });
  drawDividers(dividers(n, grid, cols, rows, room.width, room.height));
  placeSideToggle();
  if (wasOne !== grid.one) soon();
}

function bar(kind, idx) {
  const name = `${kind}${idx}`;
  if (bars.has(name)) return bars.get(name);
  const center = $('center');
  const d = el('div', `sv-divider sv-divider-${kind}`);
  d.tabIndex = 0;
  d.title = 'Drag to resize · double-click for equal sizes';
  const label = kind === 'col' ? 'Resize the columns' : 'Resize the rows';
  for (const [k, v] of Object.entries({ role: 'separator', 'aria-orientation': kind === 'col' ? 'vertical' : 'horizontal', 'aria-label': label, 'aria-valuemin': '0', 'aria-valuemax': '100' })) d.setAttribute(k, v);
  const across = kind === 'col' ? 'width' : 'height';
  const list = () => (kind === 'col' ? 'cols' : 'rows');
  const count = () => (kind === 'col' ? R.grid.cols : R.grid.rows);
  const minOf = (room) => (kind === 'col' ? colMin(room) : MIN_PANE_H);
  const moveTo = (pos) => {
    const room = area();
    const now = shares(room)[list()];
    R[list()] = dragFracs(now, idx, pos, room[across], minOf(room));
    layout();
  };
  d.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    claim();
    d.setPointerCapture(e.pointerId);
    center.classList.add('sv-dragging', `sv-dragging-${kind}`);
    const move = (ev) => { const room = area(); moveTo(kind === 'col' ? ev.clientX - room.left : ev.clientY - room.top); };
    const end = () => {
      center.classList.remove('sv-dragging', `sv-dragging-${kind}`);
      d.removeEventListener('pointermove', move);
      d.removeEventListener('pointerup', end);
      d.removeEventListener('pointercancel', end);
      save();
    };
    d.addEventListener('pointermove', move);
    d.addEventListener('pointerup', end);
    d.addEventListener('pointercancel', end);
  });
  d.addEventListener('dblclick', () => { claim(); R[list()] = []; layout(); save(); });
  d.addEventListener('keydown', (e) => {
    const [back, on] = { col: ['ArrowLeft', 'ArrowRight'], row: ['ArrowUp', 'ArrowDown'] }[kind];
    if (![back, on, 'Enter', 'Home', 'End'].includes(e.key)) return;
    e.preventDefault();
    claim();
    if (e.key === 'Enter') { R[list()] = []; layout(); save(); return; }
    const room = area();
    const size = room[across];
    const fr = shares(room)[list()];
    const inner = size - GAP * (count() - 1);
    const now = fr.slice(0, idx).reduce((s, f) => s + f, 0) * inner + (idx - 1) * GAP + GAP / 2;
    const step = (e.shiftKey ? 0.1 : 0.02) * size;
    const to = { [back]: now - step, [on]: now + step, Home: 0, End: size }[e.key];
    moveTo(to);
    save();
  });
  bars.set(name, d);
  return d;
}

function drawDividers(list) {
  if (!stage) return;
  const keep = new Set();
  for (const x of list) {
    const d = bar(x.kind, x.index);
    keep.add(d);
    if (!d.isConnected) stage.append(d);
    place(d, x);
    const fr = shares(area())[x.kind === 'col' ? 'cols' : 'rows'];
    const pct = Math.round(fr.slice(0, x.index).reduce((s, f) => s + f, 0) * 100);
    d.setAttribute('aria-valuenow', String(pct));
  }
  for (const d of bars.values()) if (!keep.has(d) && d.isConnected) d.remove();
}

function markOn(node, kind) {
  if (!node) return;
  node.hidden = !kind;
  if (node.dataset.kind === kind) return;
  node.dataset.kind = kind;
  node.className = `sv-mark ${kind}`;
  node.textContent = kind === 'needs' ? 'Needs you' : kind === 'new' ? 'New reply' : '';
}

function tabKeys(e) {
  const tabs = [...e.currentTarget.querySelectorAll('.sv-tab')];
  const i = tabs.indexOf(document.activeElement);
  if (i < 0) return;
  const to = { ArrowLeft: i - 1, ArrowRight: i + 1, Home: 0, End: tabs.length - 1 }[e.key];
  if (to === undefined) return;
  e.preventDefault();
  const t = tabs[(to + tabs.length) % tabs.length];
  for (const x of tabs) x.tabIndex = x === t ? 0 : -1;
  t.focus();
}

function renderTabs(box) {
  const items = R.panes.map((p, k) => {
    const id = idOf(p);
    const c = convOf(id);
    const asks = asksOf(id);
    return {
      k,
      words: named(c),
      hasConv: Boolean(c),
      own: p.own,
      dot: c ? (asks ? 'needs' : statusOf(c)) : 'past',
      mark: k === R.focus ? '' : paneMark(asks, id != null && R.fresh.has(id)),
    };
  });
  const key = JSON.stringify([items, R.focus]);
  if (box.dataset.key === key) return;
  const hadFocus = box.contains(document.activeElement);
  box.dataset.key = key;
  box.replaceChildren(...items.map((x) => {
    const b = el('button', {
      type: 'button',
      class: 'sv-tab',
      role: 'tab',
      'aria-selected': String(x.k === R.focus),
      tabindex: String(x.k === R.focus ? 0 : -1),
      'data-pane': String(x.k),
    });
    const mark = el('span', 'sv-mark');
    markOn(mark, x.mark);
    b.append(
      el('span', `dot ${x.dot}`),
      el('span', { class: 'sv-tab-title', 'data-no-i18n': x.words ? '' : null }, x.words || (x.hasConv ? 'New chat' : x.own ? 'New chat' : 'Pick a chat')),
      mark,
    );
    b.addEventListener('click', () => setFocus(x.k, true));
    return b;
  }));
  if (hadFocus) { const sel = box.querySelector('[aria-selected="true"]'); if (sel) sel.focus(); }
}

export function render() {
  const splitBtn = $('btnSplit');
  if (splitBtn) {
    splitBtn.classList.toggle('active', R.on);
    splitBtn.setAttribute('aria-pressed', String(R.on));
  }
  if (own.head) own.head.box.hidden = !R.on;
  if (!R.on) return;
  const one = R.grid.one;
  const n = R.panes.length;
  R.panes.forEach((p, k) => {
    const h = p.head;
    if (!h) return;
    const id = idOf(p);
    const c = convOf(id);
    const asks = asksOf(id);
    const isFocused = R.focus === k;
    h.box.hidden = false;
    h.box.classList.toggle('sv-focused', isFocused);
    h.dot.className = `dot ${c ? (asks ? 'needs' : statusOf(c)) : 'past'}`;
    const words = named(c);
    const label = words || (c ? 'New chat' : p.own ? 'New chat' : 'Pick a chat');
    if (h.title.textContent !== label) h.title.textContent = label;
    markOn(h.mark, isFocused ? '' : paneMark(asks, id != null && R.fresh.has(id)));
    h.add.disabled = n >= MAX_PANES;
    h.add.hidden = n >= MAX_PANES;
    h.mode.hidden = n < 4 || one;
    const modeLabel = R.vertical ? 'Arrange panes in a grid' : 'Keep panes vertical';
    const modeIcon = R.vertical ? 'grid' : 'cols';
    const modeWord = R.vertical ? 'grid' : 'vertical';
    h.mode.setAttribute('aria-pressed', String(R.vertical));
    if (h.mode.dataset.label !== modeLabel) {
      h.mode.dataset.label = modeLabel;
      h.mode.title = modeLabel;
      h.mode.setAttribute('aria-label', modeLabel);
      h.mode.replaceChildren(glyph(modeIcon), el('span', 'sv-word', modeWord));
    }
    const swapLabel = n === 2 ? 'Swap sides' : 'Swap with the next pane';
    if (h.swap.dataset.label !== swapLabel) {
      h.swap.dataset.label = swapLabel;
      h.swap.title = swapLabel;
      h.swap.setAttribute('aria-label', swapLabel);
    }
    const tabsOn = one && isFocused;
    h.tabs.hidden = !tabsOn;
    h.title.hidden = tabsOn;
    if (tabsOn) renderTabs(h.tabs);
    else h.tabs.dataset.key = '';
    if (!p.own) renderPanePicker(p);
  });
}

function soon() {
  if (frameDue) return;
  frameDue = requestAnimationFrame(() => { frameDue = 0; render(); });
}

function save() {
  if (!R.restored) return;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(keep, 400);
}

function keep() {
  saveTimer = 0;
  const st = cleanState(!R.on ? { on: false, panes: [], cols: R.cols, rows: R.rows, vertical: R.vertical } : {
    on: true,
    panes: R.panes.map((p) => { const id = idOf(p); return { id, key: id || '' }; }),
    own: ownAt(),
    focus: R.focus,
    cols: R.cols,
    rows: R.rows,
    vertical: R.vertical,
  });
  const text = JSON.stringify(st);
  if (text !== saved) {
    saved = text;
    store.set(SPLIT_KEY, st);
  }
}

export function restoreSplitState() {
  if (R.restored) return;
  R.restored = true;
  const raw = store.get(SPLIT_KEY, null);
  if (!raw) return;
  const st = cleanState(raw);
  saved = JSON.stringify(st);
  R.cols = st.cols;
  R.rows = st.rows;
  R.vertical = st.vertical !== false;
  if (!st.on) return;
  const all = state.convs.filter((x) => !x.temp).map((x) => x.id);
  const curId = state.current ? state.current.id : null;
  const back = restorePanes(st, (p) => resolveSide(p, true, all, (id) => id), curId);
  if (!back.ok) {
    save();
    return;
  }
  const minePane = back.panes.find((x) => x.own);
  if (minePane && minePane.id != null && minePane.id !== curId && H.selectHere) {
    const c = convOf(minePane.id);
    if (c) H.selectHere(c);
  }
  for (const p of frames()) dropPane(p);
  turnOn();
  R.panes = back.panes.map((x) => (x.own ? own : makePane(x.id)));
  R.focus = back.focus;
  changed();
}

export function command(arg = '', from = R.focus) {
  claim();
  if (R.on && R.panes[from] && R.focus !== from) setFocus(from);
  const { action, query } = splitCommand(arg);
  if (action === 'open') { add(null); return true; }
  if (action === 'close') { if (R.on) closePane(R.focus); else toast('There’s no split view to close.'); return true; }
  if (action === 'off') { if (R.on) only(R.focus); else toast('There’s no split view to close.'); return true; }
  if (action === 'swap') { if (R.on) swapPane(R.focus); else toast('There’s no split view to swap.'); return true; }
  if (action === 'new') {
    const p = add(null);
    if (p) startNewInPane(p);
    return true;
  }
  if (action === 'vertical') { setVertical(true); toast('Split view: vertical columns'); return true; }
  if (action === 'grid') { setVertical(false); toast('Split view: grid layout'); return true; }
  const id = findSession(state.convs.filter((c) => !c.temp), query);
  if (id == null) { toast(`No chat matches “${query}”.`); return true; }
  add(id);
  return true;
}

export function handleSplitKey(e) {
  const act = keyAction(e);
  if (!act) return false;
  if (act === 'side') {
    e.preventDefault();
    if (H.toggleSidebar) H.toggleSidebar();
    return true;
  }
  if (act === 'split') {
    e.preventDefault();
    add(null);
    return true;
  }
  if (!R.on) return false;
  if (act.startsWith('move-')) {
    e.preventDefault();
    claim();
    setFocus(neighbor(R.boxes, R.focus, act.slice(5), R.grid.one), true);
    return true;
  }
  if (act.startsWith('pane-')) {
    const typing = Boolean(document.activeElement && /^(INPUT|TEXTAREA)$/.test(document.activeElement.tagName));
    if (typing && document.body.classList.contains('browser-open')) return false;
    e.preventDefault();
    claim();
    const k = Number(act.slice(5)) - 1;
    if (R.panes[k]) setFocus(k, true);
    return true;
  }
  return false;
}

export function takeConv(c) {
  if (!R.on) return false;
  const id = c ? c.id : null;
  if (id == null) {
    if (!focused().own) {
      const p = focused();
      p.id = null;
      p.key = '';
      renderPaneBody(p);
      renderPaneComposer(p);
      changed({ move: true });
      return true;
    }
    return false;
  }
  const where = route(ids(), ownAt(), R.focus, id);
  if (!where) {
    if (state.current && id === state.current.id && !focused().own) setFocus(ownAt(), true);
    return false;
  }
  if (where.focus != null) { setFocus(where.focus, true); return true; }
  showIn(where.show, id);
  return true;
}

export function onOwnChanged(id, previous) {
  if (!R.on) return;
  const fix = afterChange(ids(), ownAt(), ownAt(), id, previous);
  if (fix && fix.close != null) { closePane(fix.close); return; }
  if (fix && fix.show != null) {
    const p = R.panes[fix.pane];
    if (p && !p.own) {
      p.id = fix.show;
      p.key = fix.show;
      renderPaneBody(p);
      renderPaneComposer(p);
    }
  }
  changed();
}

export function onConvDeleted(c) {
  if (!R.on || !c) return;
  const gone = frames().filter((p) => p.id === c.id);
  for (const p of gone) closePane(at(p));
}

export function rowItem(c) {
  if (!c || c.temp) return null;
  const curId = state.current ? state.current.id : null;
  if (!R.on && c.id === curId) return { label: 'Open in split view', note: 'Open here already', disabled: true };
  if (R.on && ids().includes(c.id)) return { label: 'Open in split view', note: 'In a pane already', disabled: true };
  if (R.panes.length >= MAX_PANES) return { label: 'Open in split view', note: 'All 10 panes in use', disabled: true };
  return { label: 'Open in split view', key: R.on ? '' : SPLIT_SHORTCUT, run: () => add(c.id) };
}

export function splitMenuItems() {
  if (!R.on) return [{ label: 'Split view', note: 'Another chat beside this one', key: SPLIT_SHORTCUT, run: () => add(null) }];
  return [
    R.panes.length < MAX_PANES ? { label: 'Add a pane', note: 'Another chat beside these', key: SPLIT_SHORTCUT, run: () => add(null) } : null,
    R.panes.length >= 4 && !R.vertical ? { label: 'Keep panes vertical', run: () => setVertical(true) } : null,
    R.panes.length >= 4 && R.vertical ? { label: 'Arrange panes in a grid', run: () => setVertical(false) } : null,
    { label: 'Swap with the next pane', run: () => swapPane(R.focus) },
    { label: 'Close this pane', run: () => closePane(R.focus) },
    { label: 'Close split view', note: 'Keep only this chat', run: () => only(R.focus) },
  ].filter(Boolean);
}

export function splitPaletteCommands() {
  return [
    { t: 'Split view: add a pane', s: SPLIT_SHORTCUT, i: 'side', run: () => add(null) },
    ...(R.on ? [
      { t: 'Split view: swap panes', s: '/split swap', i: 'side', run: () => swapPane(R.focus) },
      ...(R.panes.length >= 4 ? [
        R.vertical
          ? { t: 'Split view: arrange panes in a grid', s: '/split grid', i: 'side', run: () => setVertical(false) }
          : { t: 'Split view: keep panes vertical', s: '/split vertical', i: 'side', run: () => setVertical(true) },
      ] : []),
      { t: 'Split view: close this pane', s: '/split close', i: 'x', run: () => closePane(R.focus) },
      { t: 'Split view: close split view', s: '/split off', i: 'x', run: () => only(R.focus) },
    ] : []),
  ];
}

export function splitState() {
  return {
    on: R.on,
    panes: R.on ? ids() : [],
    own: ownAt(),
    focused: R.focus,
    vertical: R.vertical,
    focusedConv: () => (R.on ? convOf(idOf(focused())) : state.current),
    shows: (id) => R.on && id != null && ids().includes(id),
  };
}

function dropBoxes() {
  const room = area();
  if (!R.on) return { room, boxes: [{ x: 0, y: 0, w: room.width, height: room.height, h: room.height }], map: [0], max: MAX_PANES };
  if (R.grid.one) return { room, boxes: [R.boxes[R.focus]], map: [R.focus], max: MAX_PANES - R.panes.length + 1 };
  return { room, boxes: R.boxes, map: R.panes.map((_, k) => k), max: MAX_PANES };
}

function targetAt(e) {
  const { room, boxes, map, max } = dropBoxes();
  const z = parseFloat(stage && stage.closest && stage.closest('.dk-stage') ? stage.closest('.dk-stage').style.zoom : '') || 1;
  const t = dropTarget((e.clientX - room.left) / z, (e.clientY - room.top) / z, boxes, max);
  if (!t) return null;
  if (t.replace != null) return { replace: map[t.replace], box: boxes[t.replace] };
  const b = boxes[t.box];
  const w = Math.min(b.w * 0.34, 260);
  return { add: boxes.length === 1 ? map[0] + t.add : t.add, box: { x: t.side === 'left' ? b.x : b.x + b.w - w, y: b.y, w, h: b.h } };
}

function land(chatId, t) {
  claim();
  const c = convOf(chatId);
  if (!c) return;
  const j = R.on ? ids().indexOf(chatId) : -1;
  if (t.add != null) {
    if (j >= 0) { movePane(j, t.add); setFocus(ids().indexOf(chatId), true); return; }
    add(chatId, { where: t.add });
    return;
  }
  const k = t.replace;
  if (j >= 0) {
    if (j !== k) {
      const was = focused();
      [R.panes[j], R.panes[k]] = [R.panes[k], R.panes[j]];
      R.focus = at(was);
      changed();
    }
    setFocus(ids().indexOf(chatId), true);
    return;
  }
  if (!R.on || R.panes[k].own) {
    if (R.on) setFocus(k);
    if (H.selectHere) H.selectHere(c);
    return;
  }
  showIn(k, chatId);
}

export function initSplitView(handlers) {
  H = handlers || {};
  const center = $('center');
  stage = $('sv-stage');
  ownNode = $('sv-own');
  if (!center || !stage || !ownNode) return;

  own.head = makeHead(own);
  ownNode.prepend(own.head.box);
  ownNode.addEventListener('pointerdown', () => { if (R.on) setFocus(ownAt()); }, true);
  ownNode.addEventListener('keydown', () => { if (R.on) setFocus(ownAt()); }, true);

  // Drop overlay for dragging chats from the sidebar into split zones
  dropOverlay = el('div', 'sv-drop');
  dropOverlay.hidden = true;
  dropZone = el('div', 'sv-drop-zone');
  dropLabel = el('span', 'sv-drop-label');
  dropZone.append(dropLabel);
  dropOverlay.append(dropZone);
  stage.append(dropOverlay);

  document.addEventListener('dragstart', (e) => {
    const elTarget = e.target && e.target.nodeType === 3 ? e.target.parentElement : e.target;
    const item = elTarget && elTarget.closest ? elTarget.closest('.sitem[data-chat-id]') : null;
    if (!item || item.getAttribute('draggable') !== 'true') return;
    let id = '';
    try { id = e.dataTransfer ? e.dataTransfer.getData('text/eden-chat') : ''; } catch { /* ignore */ }
    draggedId = id || item.dataset.chatId || null;
    if (draggedId) {
      center.classList.add('sv-drop-active');
      dropOverlay.hidden = false;
      dropZone.hidden = true;
    }
  });
  document.addEventListener('dragend', () => {
    draggedId = null;
    center.classList.remove('sv-drop-active');
    if (dropOverlay) dropOverlay.hidden = true;
  });

  const hasChatDrag = (e) => Boolean(draggedId || (e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('text/eden-chat')));
  center.addEventListener('dragenter', (e) => {
    if (dropOverlay && dropOverlay.hidden && hasChatDrag(e)) {
      center.classList.add('sv-drop-active');
      dropOverlay.hidden = false;
      dropZone.hidden = true;
    }
  });
  let lastDropKey = '';
  dropOverlay.addEventListener('dragover', (e) => {
    if (!hasChatDrag(e)) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
    const t = targetAt(e);
    dropZone.hidden = !t;
    if (!t) { lastDropKey = ''; return; }
    const key = `${t.add ?? ''}:${t.replace ?? ''}:${t.box.x},${t.box.y},${t.box.w},${t.box.h}`;
    if (key === lastDropKey) return;
    lastDropKey = key;
    place(dropZone, t.box);
    dropZone.classList.toggle('add', t.add != null);
    const words = t.add != null ? (R.on ? 'Add a pane here' : 'Open beside') : (R.on ? 'Show here' : 'Open here');
    if (dropLabel.dataset.words !== words) { dropLabel.dataset.words = words; dropLabel.textContent = words; }
  });
  dropOverlay.addEventListener('dragleave', (e) => {
    if (!dropOverlay.contains(e.relatedTarget)) { dropZone.hidden = true; lastDropKey = ''; }
  });
  dropOverlay.addEventListener('drop', (e) => {
    e.preventDefault();
    e.stopPropagation();
    let chatId = draggedId;
    try { chatId = e.dataTransfer.getData('text/eden-chat') || chatId; } catch { /* ignore */ }
    const t = targetAt(e);
    draggedId = null;
    lastDropKey = '';
    center.classList.remove('sv-drop-active');
    dropOverlay.hidden = true;
    if (chatId && t) land(chatId, t);
  });

  const splitBtn = $('btnSplit');
  if (splitBtn) splitBtn.addEventListener('click', () => add(null));

  if (typeof ResizeObserver === 'function') {
    new ResizeObserver(() => { if (R.on) layout(); }).observe(stage);
  }
  const side = $('sidebar');
  if (side && typeof MutationObserver === 'function') {
    new MutationObserver(() => { if (R.on) { placeSideToggle(); layout(); } }).observe(side, { attributes: true, attributeFilter: ['class'] });
  }
  addEventListener('pagehide', () => { if (saveTimer) { clearTimeout(saveTimer); keep(); } });

  restoreSplitState();
}
