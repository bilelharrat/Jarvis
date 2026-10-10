// Chat folders in the sidebar (folders-model.js has the rules): making, renaming and deleting them,
// moving chats in (menu or drag), and "Tidy up with Eden", which proposes folders from the chat
// titles, lets the person edit them, and files the chats only when they press Apply (with Undo).

import { el, ico, store, toast } from './util.js';
import { state, saveConversation } from './state.js';
import { api } from './api.js';
import { locale } from './i18n.js';
import { cleanName, folderList, unfiled, setFolder, proposeRequest, parseFolders, assignRequest, parseAssign, MAX_FOLDERS } from './folders-model.js';

let deps = { openDialog: () => {}, closeDialog: () => {}, render: () => {} };
export const initFolders = (d) => { deps = { ...deps, ...d }; };

const KEY = 'jchat:folders';
const empties = () => { const v = store.get(KEY, []); return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []; };
const keepEmpty = (names) => store.set(KEY, [...new Set(names.map(cleanName).filter(Boolean))].slice(0, 60));

export const folders = () => folderList(state.convs, empties());
export const chatsIn = (name) => state.convs.filter((c) => c && !c.temp && cleanName(c.folder).toLowerCase() === name.toLowerCase());

export function moveChat(c, name) {
  if (!c || c.temp) return;
  setFolder(c, name);
  saveConversation(c);
  deps.render();
}

/** A one-field dialog: name → onDone(name). */
function nameDialog(title, initial, label, onDone) {
  const input = el('input', { type: 'text', class: 'inp', value: initial || '', maxlength: '40', placeholder: 'Folder name', 'aria-label': 'Folder name', style: { width: '100%' } });
  const go = () => { const n = cleanName(input.value); if (!n) { input.focus(); return; } deps.closeDialog(); onDone(n); };
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); go(); } });
  deps.openDialog(title, el('div', '',
    input,
    el('div', { style: { display: 'flex', justifyContent: 'flex-end', gap: '8px', marginTop: '14px' } },
      el('button', { type: 'button', class: 'btn', onclick: () => deps.closeDialog() }, 'Cancel'),
      el('button', { type: 'button', class: 'btn primary', onclick: go }, label))));
}

export function newFolder(then) {
  nameDialog('New folder', '', 'Create', (n) => { keepEmpty([...empties(), n]); deps.render(); if (then) then(n); });
}
export function renameFolder(old) {
  nameDialog('Rename folder', old, 'Rename', (n) => {
    for (const c of chatsIn(old)) { setFolder(c, n); saveConversation(c); }
    keepEmpty(empties().map((x) => (x.toLowerCase() === old.toLowerCase() ? n : x)));
    deps.render();
  });
}
export function deleteFolder(name) {
  const list = chatsIn(name);
  const go = () => { for (const c of list) { setFolder(c, ''); saveConversation(c); } keepEmpty(empties().filter((x) => x.toLowerCase() !== name.toLowerCase())); deps.closeDialog(); deps.render(); toast(`Folder “${name}” deleted`); };
  if (!list.length) { go(); return; }
  deps.openDialog('Delete folder', el('div', '',
    el('p', { style: { fontSize: '14px', lineHeight: '1.45', color: 'var(--text2)', margin: '0 0 10px' } }, `“${name}” goes away. Its ${list.length} chat${list.length === 1 ? '' : 's'} stay, back in your chat list.`),
    el('div', { style: { display: 'flex', justifyContent: 'flex-end', gap: '8px', marginTop: '14px' } },
      el('button', { type: 'button', class: 'btn', onclick: () => deps.closeDialog() }, 'Cancel'),
      el('button', { type: 'button', class: 'btn danger', onclick: go }, 'Delete folder'))));
}

/** Menu entries for "move this chat to a folder". */
export function moveItems(c, openMenu, anchor) {
  const list = folders();
  const open = () => openMenu(anchor, [
    { heading: 'Move to folder' },
    ...list.map((f) => ({ label: f.name, note: String(f.count), run: () => moveChat(c, f.name) })),
    ...(list.length ? ['-'] : []),
    { label: 'New folder…', run: () => newFolder((n) => moveChat(c, n)) },
    ...(c.folder ? [{ label: 'Remove from folder', run: () => moveChat(c, '') }] : []),
  ]);
  return { label: c.folder ? `Folder: ${cleanName(c.folder)}…` : 'Move to folder…', run: () => setTimeout(open, 0) };
}

/* ---------- Tidy up with Eden ---------- */

const TIDY_KEY = 'jchat:tidyAt';
export const tidyLast = () => Number(store.get(TIDY_KEY, 0)) || 0;
export const tidyDismiss = () => { store.set(TIDY_KEY, Date.now()); deps.render(); };

// A small Gemini model, picked on purpose: sorting titles needs no router, and one provider being out of credit mustn't stop it.
const SORT_MODEL = 'gemini-3.5-flash-lite';

/** A model error in plain words (providers send JSON). */
export function plainError(message) {
  const m = String(message || '');
  if (/insufficient_quota|credit_balance|no credits|billing/i.test(m)) return 'A model provider is out of credit right now. Try again in a little while.';
  if (/429|busy|rate/i.test(m)) return 'The model is busy right now. Try again in a minute.';
  const found = /"message"\s*:\s*"([^"]{3,160})/.exec(m);
  return found ? found[1] : m.slice(0, 160).replace(/[{}"]/g, '');
}

async function ask({ system, prompt }) {
  const { routeSettings } = await import('./router.js');
  let out = '';
  await api.send({ messages: [{ role: 'user', content: prompt }], system, temporary: true, mode: 'chat', settings: { ...routeSettings(), level: 1, efficiency: 90, performance: 20, autoSearch: false }, override: { model: SORT_MODEL } }, {
    onEvent: (t, d) => { if (t === 'text') out += d.text || ''; if (t === 'error') throw new Error(d.message || 'Eden couldn’t answer.'); },
  });
  return out;
}

const para = (t) => el('p', { style: { fontSize: '14px', lineHeight: '1.45', color: 'var(--text2)', margin: '0 0 10px' } }, t);
const buttons = (...b) => el('div', { style: { display: 'flex', justifyContent: 'flex-end', gap: '8px', marginTop: '14px' } }, ...b);
let undo = null;
// The run lives in the sidebar (tidyCard), not in a dialog: the person keeps using Eden while it works.
// { phase: 'run' | 'review' | 'error', done, total, text, names, plan, chats, cancelled }
let tidy = null;

export function tidyUp() {
  if (tidy) { if (tidy.phase === 'review') openReview(); return; }
  const chats = unfiled(state.convs).filter((c) => c.nodes && !c.remote);
  const { openDialog, closeDialog } = deps;
  if (chats.length < 8) { openDialog('Tidy up with Eden', el('div', '', para('There aren’t enough chats outside folders to sort yet.'), buttons(el('button', { type: 'button', class: 'btn primary', onclick: () => closeDialog() }, 'OK')))); return; }
  openDialog('Tidy up with Eden', el('div', '',
    para(`Eden will read the titles of your ${chats.length.toLocaleString(locale())} chats that aren’t in a folder and suggest folders. You can keep using Eden while it works, nothing moves until you press Apply, and you can undo it.`),
    para('The titles go to a small, low-cost AI model to sort them. It costs a few cents of your included AI.'),
    buttons(
      el('button', { type: 'button', class: 'btn', onclick: () => { tidyDismiss(); closeDialog(); } }, 'Not now'),
      el('button', { type: 'button', class: 'btn primary', onclick: () => { closeDialog(); run(chats); } }, 'Start'))));
}

/** The sidebar's card while a tidy-up runs or waits for review; null when there's none. */
export function tidyCard() {
  if (!tidy) return null;
  const x = (title, fn) => el('button', { type: 'button', class: 'iconbtn tidy-x', title, 'aria-label': title, onclick: fn }, '×');
  if (tidy.phase === 'run') {
    const frac = tidy.total ? Math.min(1, tidy.done / tidy.total) : 0;
    const bar = el('div', { class: 'tidy-bar', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': String(Math.round(frac * 100)), 'aria-label': 'Sorting chats' }, el('i'));
    bar.firstChild.style.width = `${Math.round(frac * 100)}%`;
    return el('div', { class: 'tidy-nudge run' },
      el('div', 'tidy-go', ico('spark', 14), el('span', '', el('b', '', 'Tidying up'), el('small', '', tidy.text), bar)),
      x('Cancel', () => { tidy.cancelled = true; tidy = null; deps.render(); }));
  }
  if (tidy.phase === 'review') {
    return el('div', { class: 'tidy-nudge' },
      el('button', { type: 'button', class: 'tidy-go', onclick: () => openReview() }, ico('spark', 14), el('span', '', el('b', '', 'Folders ready'), el('small', '', `${tidy.rows.length} suggested · tap to review`))),
      x('Discard', () => { tidy = null; deps.render(); }));
  }
  return el('div', { class: 'tidy-nudge' },
    el('div', 'tidy-go', ico('spark', 14), el('span', '', el('b', '', 'Couldn’t tidy up'), el('small', '', tidy.text))),
    x('Dismiss', () => { tidy = null; deps.render(); }));
}

async function run(chats) {
  const mine = { phase: 'run', done: 0, total: chats.length, text: 'Reading your chat titles…', cancelled: false };
  tidy = mine;
  deps.render();
  const alive = () => tidy === mine && !mine.cancelled;
  try {
    const names = parseFolders(await ask(proposeRequest(chats)));
    if (!alive()) return;
    if (names.length < 2) throw new Error('Eden couldn’t find clear topics in these chats.');
    const plan = new Map(); // chat → folder
    const BATCH = 220;
    for (let i = 0; i < chats.length && alive(); i += BATCH) {
      mine.done = i;
      mine.text = `Sorting ${Math.min(i + BATCH, chats.length).toLocaleString(locale())} of ${chats.length.toLocaleString(locale())} chats…`;
      deps.render();
      const batch = chats.slice(i, i + BATCH);
      let got;
      try { got = parseAssign(await ask(assignRequest(batch, names)), batch.length, names); } catch (e) { if (i === 0) throw e; got = new Array(batch.length).fill(null); }
      batch.forEach((c, k) => { if (got[k]) plan.set(c, got[k]); });
    }
    if (!alive()) return;
    const rows = names.map((n) => ({ name: n, on: true, count: [...plan.values()].filter((v) => v === n).length })).filter((r) => r.count > 0).slice(0, MAX_FOLDERS);
    if (!rows.length) throw new Error('Nothing fit well enough to sort.');
    Object.assign(mine, { phase: 'review', rows, plan, chats });
    deps.render();
    toast('Folders are ready to review');
  } catch (e) {
    if (tidy === mine) { Object.assign(mine, { phase: 'error', text: plainError(e.message) }); deps.render(); }
  }
}

function openReview() {
  if (!tidy || tidy.phase !== 'review') return;
  const body = el('div');
  const show = (...n) => body.replaceChildren(...n);
  deps.openDialog('Tidy up with Eden', body);
  review(tidy.rows.map((r) => r.name), tidy.plan, tidy.chats, show, deps.closeDialog);
}

function review(names, plan, chats, show, closeDialog) {
  const rows = tidy.rows;
  const list = el('div', { style: { display: 'flex', flexDirection: 'column', gap: '6px', maxHeight: '48vh', overflowY: 'auto', margin: '0 0 6px' } });
  rows.forEach((r) => {
    const cb = el('input', { type: 'checkbox', checked: 'checked', 'aria-label': `Use folder ${r.name}`, onchange: () => { r.on = cb.checked; } });
    const inp = el('input', { type: 'text', class: 'inp', value: r.name, maxlength: '40', 'aria-label': 'Folder name', style: { flex: '1', minWidth: '0' }, oninput: () => { r.edit = inp.value; } });
    list.append(el('label', { style: { display: 'flex', gap: '8px', alignItems: 'center' } }, cb, inp, el('span', { style: { fontSize: '12.5px', color: 'var(--text3)', whiteSpace: 'nowrap' } }, `${r.count.toLocaleString(locale())} chats`)));
  });
  const left = chats.length - [...plan.values()].length;
  show(
    para(`Eden suggests ${rows.length} folders. Rename or untick any, then press Apply.${left > 0 ? ` ${left.toLocaleString(locale())} chats didn’t fit and stay where they are.` : ''}`),
    list,
    buttons(
      el('button', { type: 'button', class: 'btn', onclick: () => closeDialog() }, 'Later'),
      el('button', { type: 'button', class: 'btn primary', onclick: () => apply(rows, plan, show, closeDialog) }, 'Apply')));
}

function apply(rows, plan, show, closeDialog) {
  const use = new Map(rows.filter((r) => r.on).map((r) => [r.name, cleanName(r.edit ?? r.name) || r.name]));
  const before = [];
  let moved = 0;
  for (const [c, f] of plan) {
    const to = use.get(f);
    if (!to) continue;
    before.push([c, c.folder || '', c.metaAt]);
    setFolder(c, to);
    saveConversation(c);
    moved++;
  }
  undo = before;
  tidy = null;
  store.set(TIDY_KEY, Date.now());
  deps.render();
  show(
    para(`Sorted ${moved.toLocaleString(locale())} chats into ${new Set(use.values()).size} folders.`),
    buttons(
      el('button', { type: 'button', class: 'btn', onclick: () => { for (const [c, f, at] of undo || []) { setFolder(c, f); c.metaAt = Date.now(); if (at === undefined && !f) delete c.folder; saveConversation(c); } undo = null; deps.render(); closeDialog(); toast('Tidy-up undone'); } }, 'Undo'),
      el('button', { type: 'button', class: 'btn primary', onclick: () => closeDialog() }, 'Done')));
}
