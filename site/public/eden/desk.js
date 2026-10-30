// "Desktop" layout (Settings › Appearance › Layout): Eden as the whole screen. A second skin over the same
// app, drawn from the owner's mock-up (1934×1209 stage, scaled to the window). It owns no data: chats come from
// state.convs, the chat window is the real transcript moved in, the composer hands its text to the real one,
// and apps open the real spaces. The real sidebar list, title bar, composer, canvas, drawer, inspector and
// buttons are moved in (park) and put back on Classic, so every feature carries over. initDesk() is called once from app.js; setLayout('desk'|'classic') switches.
import { $, el, toast } from './util.js';
import { state, saveSettings } from './state.js';

const W = 1934, MIN_W = 760;
const P = { // 24×24 stroke icons
  search: 'M11 4a7 7 0 100 14 7 7 0 000-14zM20 20l-3.5-3.5',
  edit: 'M4 20l1-4L16 5a2 2 0 013 3L8 19l-4 1zM14 7l3 3',
  globe: 'M12 3a9 9 0 100 18 9 9 0 000-18zM3 12h18M12 3c2.5 2.5 3.5 5.5 3.5 9s-1 6.5-3.5 9c-2.5-2.5-3.5-5.5-3.5-9s1-6.5 3.5-9z',
  game: 'M7 8h10a4 4 0 014 4v1a3 3 0 01-5 2l-1-1H9l-1 1a3 3 0 01-5-2v-1a4 4 0 014-4zM8 11v3M6.5 12.5h3',
  chat: 'M5 5h14a1 1 0 011 1v9a1 1 0 01-1 1h-8l-4 3.5V16H5a1 1 0 01-1-1V6a1 1 0 011-1z',
  music: 'M9 18V6l10-2v12M9 18a2.5 2.5 0 11-5 0 2.5 2.5 0 015 0zM19 16a2.5 2.5 0 11-5 0 2.5 2.5 0 015 0z',
  code: 'M9 8l-4 4 4 4M15 8l4 4-4 4',
  term: 'M7 9l3 3-3 3M12.5 15H17',
  sun: 'M12 8a4 4 0 100 8 4 4 0 000-8zM12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6L7 7M17 17l1.4 1.4M18.4 5.6L17 7M7 17l-1.4 1.4',
  spark: 'M12 4l1.8 5.2L19 11l-5.2 1.8L12 18l-1.8-5.2L5 11l5.2-1.8z',
  folder: 'M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2z',
  cal: 'M5 6h14a1 1 0 011 1v12a1 1 0 01-1 1H5a1 1 0 01-1-1V7a1 1 0 011-1zM4 10h16M8 4v4M16 4v4',
  mail: 'M5 6h14a1 1 0 011 1v10a1 1 0 01-1 1H5a1 1 0 01-1-1V7a1 1 0 011-1zM4 8l8 5 8-5',
  act: 'M3 12h4l3-7 4 14 3-7h4',
  home: 'M4 11l8-7 8 7M6 10v9h12v-9M10 19v-5h4v5',
  desk: 'M4 5h16a1 1 0 011 1v10a1 1 0 01-1 1H4a1 1 0 01-1-1V6a1 1 0 011-1zM9 21h6M12 17v4',
  doc: 'M7 4h7l4 4v11a1 1 0 01-1 1H7a1 1 0 01-1-1V5a1 1 0 011-1zM14 4v4h4',
  down: 'M12 5v10M7.5 11L12 15.5 16.5 11M5 19h14',
  pic: 'M5 5h14a1 1 0 011 1v12a1 1 0 01-1 1H5a1 1 0 01-1-1V6a1 1 0 011-1zM4 16l5-5 4 4 3-3 4 4M9 9.5h.01',
  x: 'M6 6l12 12M18 6L6 18',
  side: 'M4 5h16a1 1 0 011 1v12a1 1 0 01-1 1H4a1 1 0 01-1-1V6a1 1 0 011-1zM9 5v14',
  wifi: 'M3 9a14 14 0 0118 0M6 12.5a9.5 9.5 0 0112 0M9 16a5 5 0 016 0M12 19.5h.01',
  vol: 'M5 10h3l4-3.5v11L8 14H5zM15.5 9.5a3.5 3.5 0 010 5',
  power: 'M12 3v8M7 6.5a7.5 7.5 0 1010 0',
  moon: 'M20 14.5A8.5 8.5 0 019.5 4a8.5 8.5 0 1010.5 10.5z',
  sliders: 'M4 8h9M17 8h3M4 16h3M11 16h9M15 6v4M9 14v4',
  mic: 'M12 4a3 3 0 00-3 3v5a3 3 0 006 0V7a3 3 0 00-3-3zM6 12a6 6 0 0012 0M12 18v3',
  wave: 'M5 10v4M9 7v10M13 4v16M17 8v8M21 11v2',
  up: 'M12 19V6M6.5 11.5L12 6l5.5 5.5',
  routine: 'M20 12a8 8 0 11-2.3-5.6M20 3.5V8h-4.5',
  brain: 'M12 4a5 5 0 00-5 5c-2 .5-3 2.2-3 4a4 4 0 004 4h8a4 4 0 004-4c0-1.800-1-3.500-3-4a5 5 0 00-5-5zM12 4v13',
  quote: 'M7 8h4v4H7zM13 8h4v4h-4zM9 12c0 3-1 4-3 5M15 12c0 3-1 4-3 5',
  list: 'M9 6.500h11M9 12h11M9 17.500h11M4 6.500h.01M4 12h.01M4 17.500h.01',
  info: 'M12 8h.01M11 12h1v5h1M12 3a9 9 0 100 18 9 9 0 000-18z',
};
const ic = (n, s = 18, cls = '') => `<svg class="dk-i ${cls}" width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${P[n]}"/></svg>`;
const MARK = '<svg viewBox="43 81 410 422" width="62%" height="62%" aria-hidden="true"><g fill="#fff" stroke="#fff" stroke-width="18" stroke-linejoin="round"><polygon points="211,93 314,90 444,236 343,353 249,352 333,251"/><polygon points="252,235 160,346 282,491 186,494 52,350 151,234"/></g></svg>';

const APPS = () => [['Browser', 'globe', '#2f9bff', () => $('btnBrowser').click()], ['Chat', 'chat', '#5b6cf0', () => { H.newChat(); show('chat'); }],
  ['Eden Code', 'code', '#12305a', () => H.projectPicker()], ...(H.openEssayWriter ? [['Essays', 'edit', '#f5476a', () => H.openEssayWriter()]] : []), ['Tasks', 'list', '#34c759', () => H.openTasks()], ['Workflows', 'spark', '#a24ae6', () => H.openWorkflows()]];
const PC = () => [['Brief', 'sun', () => H.openBrief()], ['Memory', 'spark', () => openSpace('memory')], ['Second Brain', 'brain', () => openSpace('brain')], ['Files', 'folder', () => show('files')],
  ['Calendar', 'cal', () => H.openCalendar()], ['Mail', 'mail', () => openSpace('mail')], ['Routines', 'routine', () => openSpace('routines')], ['Meetings', 'quote', () => openSpace('meetings')],
  ['On a website', 'globe', () => openSpace('web')], ['Activity', 'act', () => openSpace('activity')], ...(state.meta && state.meta.hosted ? [['Courses', 'doc', () => openSpace('courses')]] : [])];
const RAIL = [['Home', 'home', '#2f9bff'], ['Desktop', 'desk', '#2fc0d6'], ['Documents', 'doc', '#6a5ae8'], ['Downloads', 'down', '#34c759'], ['Games', 'game', '#a24ae6'], ['Music', 'music', '#f5476a'], ['Pictures', 'pic', '#ff9f0a']];
const FOLDERS = ['Desktop', 'Documents', 'Downloads', 'Games', 'Music', 'Pictures', 'Projects', 'Videos'];

let H = {}, root, stage, win, top, view = 'files', folder = 'Home', on = false;
const parked = []; // [node, parent, nextSibling]: what moved in, so Classic gets it back
const wired = () => !!root;
function park(n, to, before = null) { if (!n || n.parentNode === to) return; parked.push([n, n.parentNode, n.nextSibling]); to.insertBefore(n, before); }
function unpark() { while (parked.length) { const [n, p, nx] = parked.pop(); p.insertBefore(n, nx && nx.parentNode === p ? nx : null); } }
function ask(text) { show('chat'); const i = $('deck-input'); i.value = text; i.dispatchEvent(new Event('input', { bubbles: true })); i.focus(); }
function openSpace(k) { H.openSpace && H.openSpace(k); }
function html(s) { const t = document.createElement('template'); t.innerHTML = s.trim(); return t.content.firstChild; }
function on_(n, f) { n.addEventListener('click', f); return n; }
const sec = (t, kids) => el('div', 'dk-sec', el('h4', '', t), ...kids);

function build() {
  root = el('div', { id: 'desk', hidden: '' });
  stage = el('div', 'dk-stage');
  const side = el('aside', 'dk-side');
  const search = html(`<div class="dk-sr"><div class="dk-search" role="button" tabindex="0">${ic('search', 18)}<span>Search</span><kbd>Ctrl K</kbd></div><button type="button" class="dk-ib" aria-label="New chat" title="New chat">${ic('edit', 19)}</button></div>`);
  on_(search.firstChild, () => $('btnPalette').click()); on_(search.lastChild, () => { H.newChat(); show('chat'); });
  side.append(search, el('div', { class: 'dk-scroll', id: 'dkScroll' }), html(`<div class="dk-foot" id="dkFoot"><span class="dk-eden">${MARK}</span><div><b>Eden</b><small><i></i><span id="dkState">listening</span></small></div><span class="dk-sp"></span></div>`));
  top = html(`<header class="dk-top files"><button type="button" class="dk-ib" id="dkSide" aria-label="Toggle sidebar">${ic('side', 21)}</button><span class="dk-eden sm">${MARK}</span><b id="dkTitle">Files</b><span class="dk-tb" id="dkTb"></span><span class="dk-sp"></span><time id="dkClock"></time></header>`);
  on_(top.querySelector('#dkSide'), () => stage.classList.toggle('nosid'));
  win = el('section', { class: 'dk-win', id: 'dkWin', 'aria-label': 'Window' });
  stage.append(side, top, win, el('div', { class: 'dk-ask', id: 'dkAsk', hidden: '' }));
  root.append(stage); document.body.append(root);
  // chats: the real list's clicks and the composer's sends bring the chat window forward
  addEventListener('eden:conv-opened', () => { if (on) show('chat'); });
  $('deck-composer').addEventListener('submit', () => { if (on && view !== 'chat') show('chat'); }, true);
}

/** An approval card above the composer: dispatch `eden:desk-ask` with { text, allow, deny, onAllow, onDeny }. */
function showAsk(d) {
  const a = $('dkAsk'); if (!a || !d) return;
  a.innerHTML = `<span class="dk-eden">${MARK}</span><div><b>Eden needs your OK</b><small></small></div><span class="dk-sp"></span><button type="button" class="dk-no">${d.deny || 'Not now'}</button><button type="button" class="dk-yes">${d.allow || 'Allow'}</button>`;
  a.querySelector('small').textContent = d.text || '';
  const done = (f) => () => { a.hidden = true; f && f(); };
  a.querySelector('.dk-no').onclick = done(d.onDeny); a.querySelector('.dk-yes').onclick = done(d.onAllow); a.hidden = false;
}

function renderFiles() {
  const rail = el('nav', 'dk-rail');
  for (const [n, i, c] of RAIL) rail.append(on_(html(`<button type="button" class="${n === folder ? 'on' : ''}"><span style="background:${c}">${ic(i, 16)}</span>${n}</button>`), () => { folder = n; if (n !== 'Home') ask(`Show me what is in my ${n} folder`); else renderFiles(); }));
  const cards = el('div', 'dk-cards');
  cards.append(on_(html(`<button type="button" class="dk-card"><span class="dk-ci" style="background:#2f9bff">${ic('search', 17)}</span><div><b>Ask about your files</b><small>“Hey Eden, find my tax PDFs” searches every folder.</small></div></button>`), () => H.openFiles()),
    on_(html(`<button type="button" class="dk-card"><span class="dk-ci" style="background:#ff9f0a">${ic('spark', 17)}</span><div><b>Tidy up</b><small>Eden sorts Downloads into folders, and asks before moving anything.</small></div></button>`), () => ask('Tidy up my Downloads folder, and ask before moving anything')));
  const grid = el('div', 'dk-grid');
  for (const f of FOLDERS) grid.append(on_(html(`<button type="button" class="dk-fold"><svg width="44" height="36" viewBox="0 0 44 36" aria-hidden="true"><path d="M2 6a4 4 0 014-4h10l5 5h17a4 4 0 014 4v19a4 4 0 01-4 4H6a4 4 0 01-4-4z" fill="#3fb0ff"/><path d="M2 12a4 4 0 014-4h32a4 4 0 014 4v18a4 4 0 01-4 4H6a4 4 0 01-4-4z" fill="#5cc2ff"/></svg>${f}</button>`), () => ask(`Show me what is in my ${f} folder`)));
  win.replaceChildren(html(`<div class="dk-wh"><b>Files</b><span class="dk-sp"></span><span class="dk-pill">${folder}</span><button type="button" class="dk-x" aria-label="Close">${ic('x', 18)}</button></div>`),
    el('div', 'dk-wb', rail, el('div', 'dk-main',
      html(`<div class="dk-hd"><span class="dk-big">${ic('home', 26)}</span><div><h2>${folder}</h2><p>Your folders, with Eden built in.</p></div></div>`), cards, el('h5', '', 'FOLDERS'), grid)));
  on_(win.querySelector('.dk-x'), () => { win.hidden = true; });
}

/** The chat window: the real conversation, canvas and activity drawer, moved in. */
function renderChat() {
  win.replaceChildren(html(`<div class="dk-wh"><b>Chat</b><span class="dk-sp"></span><button type="button" class="dk-x" aria-label="Close">${ic('x', 18)}</button></div>`));
  on_(win.querySelector('.dk-x'), () => show('files'));
  const body = el('div', 'dk-cb'); win.append(body);
  park($('sv-stage') || $('split'), body); park($('drawer'), body);
}

function show(v) {
  if (!wired()) return;
  view = v; win.hidden = false;
  top.classList.toggle('files', v === 'files'); win.classList.toggle('chat', v === 'chat');
  $('dkTitle').textContent = 'Files';
  if (v === 'files') { unparkWindow(); renderFiles(); } else renderChat();
}
function unparkWindow() { for (const n of [$('drawer'), $('sv-stage'), $('split')]) { const k = parked.findIndex((p) => p[0] === n); if (k >= 0) { const [nd, p, nx] = parked.splice(k, 1)[0]; p.insertBefore(nd, nx && nx.parentNode === p ? nx : null); } } }

function fill() { // the sidebar, top bar and composer: real parts in the mock-up's frame
  const sc = $('dkScroll');
  sc.replaceChildren(
    sec('APPS', APPS().map(([n, i, c, f]) => on_(html(`<button type="button" class="dk-app"><span class="dk-tile" style="background:${c}">${ic(i, 17)}</span>${n}</button>`), f))),
    sec(/Mac/.test(navigator.platform) ? 'YOUR MAC' : 'YOUR PC', PC().map(([n, i, f]) => on_(html(`<button type="button" class="dk-pc">${ic(i, 18)}${n}</button>`), f))),
    el('div', 'dk-sec dk-chats', el('h4', '', 'CHATS')));
  park($('sideScroll'), sc);
  const foot = $('dkFoot');
  for (const id of ['btnMore', 'btnTheme', 'btnSettings']) park($(id), foot);
  park($('titlebar'), $('dkTb'));
  park($('inspector'), stage);
  park(document.querySelector('.jc-dock'), stage);
  stage.classList.add('dk-live');
}

function tick() {
  const n = new Date(), c = $('dkClock'); if (!c) return;
  c.textContent = `${n.toLocaleDateString('en-GB', { weekday: 'short' })} ${n.getDate()} ${n.toLocaleDateString('en-GB', { month: 'short' })} ${n.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}`;
}
function fit() {
  if (!on) return;
  const z = Math.min(1.5, Math.max(0.55, innerWidth / W));
  stage.style.cssText = `zoom:${z};width:${innerWidth / z}px;height:${innerHeight / z}px`;
}

export function layout() { return 'classic'; }
export function setLayout(l, { save = true } = {}) {
  // Desktop layout disabled permanently
  if (save && state.settings.layout) { delete state.settings.layout; saveSettings(); }
  if (on) {
    on = false;
    if (root) root.hidden = true;
    document.documentElement.dataset.layout = 'classic';
    if (stage) stage.classList.remove('dk-live');
    unpark();
  }
}

export function initDesk(hooks) {
  // Desktop layout retired: ensure state is reset to classic
  if (state.settings.layout === 'desk') {
    delete state.settings.layout;
    saveSettings();
  }
  document.documentElement.dataset.layout = 'classic';
}
