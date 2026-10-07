// Jarvis Chat — the page's wiring: layout (source list, conversation, inspector), the
// transcript, conversations, palette, settings, dialogs, shortcuts and Esc order.

import './practice.js'; // first: practice mode (the tour's sandbox) scopes storage before any module reads it
import { $, el, ico, qsa, toast, copyText, download, fmtCost, relDay, isMobile, isNarrow, isTouch, setSeg, store, shortModel } from './util.js';
import { state, ui, saveSettings, savePersonas, loadConversations, saveConversation, addConversation, deleteConversation, newConversation, path, selectSibling, nodeText, sessionCost, persona, conversationMarkdown } from './state.js';
import { api, isMock, API_ROOT } from './api.js';
// The apps page (J.A.R.V.I.S., Eden Messenger) lives on askeden.com; a local Eden links there.
const DOWNLOAD_URL = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname) ? 'https://askeden.com/download' : '/download';
import { initMail, connectGmail, emailText } from './mail.js';
import { openCompose, initSignatures } from './compose.js';
import { renderMessage, emptyState, ui_open, artifactsIn } from './render.js';
import { routeSettings, initRouteControls, renderRouteControls, renderTurnCard, routePopContent, openChipPop, closeChipPop, chipPopOpenFor, initChipPop, hoverIntent, setOverride, setLevel, availableModels, currentOverride, modelInfo, schedulePreview } from './router.js';
import { initComposer, renderComposer, composerEscape, focusComposer, setComposerText, addContext, setMode, modelMenu, openMenu, closeMenu, clearAttachments, renderAttachments, addFile } from './composer.js';
import { sendMessage, runChat, stop, retry, regenerate, editResend, answerPermission, queueFollowUp, steerNow, dropQueued, runCode } from './chat.js';
import { initArtifact, openArtifact, closeArtifact, artifactOpen, refreshArtifact } from './artifact.js';
import { initPanels, openSpace, closeSpace, spaceOpen, checkJarvis, renderMemoryTab, searchNotes, attachNote, notify } from './panels.js';
import { initAccount } from './account.js';
import { initPrivacy, paint as paintPrivacy, privacyBody, privacySettings } from './privacy.js';
import { initPublish } from './publish.js';
import { initCode, projectPicker, loadProjects, renderPlan, loadChanges, setHunk, renderActivity, toggleDrawer } from './code.js';
import { initCalendar, openCalendar, calendarReturnPending } from './calendar.js';
import { initMemory } from './memory.js';
import { initBrief, openBrief } from './brief.js';
import { initFiles, openFiles, closePane } from './files.js';
import { initKnowledge, knowledgeItem } from './knowledge.js';
import { voiceSettings } from './voice.js';
import { initTasks, openTasks, pendingApprovals } from './tasks.js';
import { initWorkflows, openWorkflows, saveWorkflowFrom } from './workflows.js';
import { initLearned, learnedSettings } from './learned.js';
import { initAutopilot, autopilotSettings } from './autopilot.js';
import { acting, actingHas } from './acting.js';
import { initTour, startTour } from './tour.js'; // I1: the try-it tour
import { initHelp, helpCommands, helpButton } from './help.js'; // Help Center: FAQ and Ask Help
import { initBrowserPane, toggleBrowser, closeBrowser, browserJarvisChanged } from './browser-pane.js'; // the browser panel

/* ================= theme ================= */
const darkMQ = matchMedia('(prefers-color-scheme: dark)');
function applyTheme() {
  const t = state.settings.theme || 'system';
  const dark = t === 'dark' || (t === 'system' && darkMQ.matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  $('themeIco').firstElementChild.setAttribute('href', dark ? '#i-sun' : '#i-moon');
  $('btnTheme').title = `Appearance: ${t[0].toUpperCase()}${t.slice(1)} (click to switch)`;
}
function setTheme(t) { state.settings.theme = t; saveSettings(); applyTheme(); }
darkMQ.addEventListener('change', applyTheme);

/* ================= layout ================= */
function syncScrim() {
  const s = $('sidebar');
  const on = (isMobile() && s.classList.contains('open')) || (isNarrow() && !isMobile() && !docksSidebar() && s.classList.contains('expanded')) || (isMobile() && $('inspector').classList.contains('open'));
  $('scrim').classList.toggle('on', on);
}
function toggleSidebar(force) {
  const s = $('sidebar');
  if (isMobile()) s.classList.toggle('open', force);
  else if (isNarrow()) { s.classList.toggle('expanded', force); if (docksSidebar()) store.set('jchat:sidebar', s.classList.contains('expanded')); }
  else { s.classList.toggle('closed', force === undefined ? undefined : !force); store.set('jchat:sidebar', !s.classList.contains('closed')); }
  syncScrim();
}
function closeOverlays() {
  $('sidebar').classList.remove('open', 'expanded');
  if (isNarrow()) $('inspector').classList.remove('open');
  syncScrim();
}
/** On a phone a sheet (Settings, a dialog, the palette, a panel) replaces the drawer and the inspector sheet: they stayed open behind it. */
function clearPhoneOverlays() { if (isMobile()) closeOverlays(); }
function inspectorVisible() { const i = $('inspector'); return isNarrow() ? i.classList.contains('open') : !i.classList.contains('closed'); }
function openInspector(tab) {
  const i = $('inspector');
  if (isNarrow()) i.classList.add('open');
  i.classList.remove('closed');
  if (!isNarrow()) store.set('jchat:inspector', true);
  if (tab) inspTab(tab);
  syncScrim();
}
function closeInspector() {
  const i = $('inspector');
  if (isNarrow()) i.classList.remove('open', 'full', 'peek');
  else { i.classList.add('closed'); store.set('jchat:inspector', false); }
  syncScrim();
}
function toggleInspector() { if (inspectorVisible()) closeInspector(); else openInspector(); }
const TABS = ['Route', 'Plan', 'Changes', 'Memory'];
let curTab = 'Route';
function inspTab(name) {
  curTab = name;
  setSeg($('inspSeg'), TABS.indexOf(name));
  qsa('.itab').forEach((t) => t.classList.toggle('on', t.id === `tab-${name}`));
  if (name === 'Changes') loadChanges();
  if (name === 'Memory') renderMemoryTab();
  if (name === 'Plan') renderPlan();
}
// crossing a breakpoint clears the other layout's classes (no stuck scrim or sheets)
for (const q of ['(max-width:1100px)', '(max-width:640px)']) {
  matchMedia(q).addEventListener('change', () => {
    $('sidebar').classList.remove('open', 'expanded');
    const i = $('inspector');
    const wasOpen = i.classList.contains('open') || !i.classList.contains('closed');
    i.classList.remove('open', 'full', 'peek');
    if (!isNarrow()) i.classList.toggle('closed', !(wasOpen && store.get('jchat:inspector', false)));
    else i.classList.add('closed');
    $('scrim').classList.remove('on');
    closeChipPop(); closeMenu();
  });
}
// Eden's iPad app (it marks the page .eden-ipad): from 820 to 1100px the whole sidebar docks
// beside the chat (mobile.css docks the rail's "expanded"), open unless closed with ⌘B or the
// sidebar button, as on a wide screen (jchat:sidebar). Registered after the listeners above,
// so it runs after they've cleared the classes.
const dockMQ = matchMedia('(min-width:820px) and (max-width:1100px)');
function docksSidebar() { return document.documentElement.classList.contains('eden-ipad') && dockMQ.matches; }
function syncDock() {
  if (!document.documentElement.classList.contains('eden-ipad')) return;
  const open = store.get('jchat:sidebar', true) !== false;
  $('sidebar').classList.toggle('expanded', docksSidebar() && open);
  if (!isNarrow()) $('sidebar').classList.toggle('closed', !open);
  syncScrim();
}
dockMQ.addEventListener('change', syncDock);
matchMedia('(max-width:1100px)').addEventListener('change', syncDock);

/* ================= conversations ================= */
function switchTo(c) {
  if (state.current === c) { if (isMobile()) closeOverlays(); return; }
  state.current = c;
  ui_open.editing = null;
  state.selectedNode = c ? [...path(c)].reverse().find((n) => n.role === 'assistant' && n.route) || null : null;
  store.set('jchat:current', c && !c.temp ? c.id : null);
  closeArtifact();
  closeChipPop();
  renderAll();
  if (curTab === 'Changes' && inspectorVisible()) loadChanges();
  if (isMobile()) closeOverlays();
  schedulePreview();
  focusComposer();
}
function newChat() {
  if (state.current && !state.current.temp && !Object.keys(state.current.nodes).length && state.current.kind === 'chat') { focusComposer(); return; }
  state.pendingMode = 'chat';
  switchTo(null);
}
function newTemp() {
  const c = newConversation({ temp: true });
  c.title = 'Temporary chat';
  state.convs.unshift(c);
  switchTo(c);
  toast('Temporary chat — nothing is saved');
}
function newCodeSession(project) {
  const c = newConversation({ kind: 'code', project });
  addConversation(c);
  switchTo(c);
}
function renameConversation(c, title) {
  const t = String(title || '').trim();
  if (!c || !t) return;
  c.title = t.slice(0, 120);
  c.titleSet = true;
  saveConversation(c);
  renderTitle(); renderSidebar();
}
function togglePin(c) { if (!c || c.temp) return; c.pinned = !c.pinned; saveConversation(c); renderSidebar(); toast(c.pinned ? 'Pinned' : 'Unpinned'); }
function removeConversation(c) {
  if (!c) return;
  confirmDialog(`Delete “${c.title}”? This can’t be undone.`, 'Delete', () => {
    stop(c);
    deleteConversation(c);
    if (state.current === c) switchTo(null);
    renderSidebar();
    toast('Deleted');
  }, true);
}
function exportConversation(c) {
  if (!c || !path(c).length) { toast('Nothing to export yet'); return; }
  const slug = c.title.toLowerCase().replace(/[^\w]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'chat';
  download(`${slug}.md`, conversationMarkdown(c));
}
function setPersona(id) {
  const c = state.current;
  if (c) { c.personaId = id || null; saveConversation(c); }
  else state.draftPersona = id || null;
  const p = persona(id);
  toast(p ? `Persona: ${p.name}` : 'No persona');
  renderAttachments(); renderTitle(); renderSidebar();
  if (c && !path(c).length) renderTranscript();
}

/* ================= sidebar ================= */
const secState = store.get('jchat:secs', {});
function section(id, title, items, { add } = {}) {
  const closed = !!secState[id];
  const sec = el('div', { class: `sec${closed ? ' closed' : ''}` });
  const head = el('div', { style: { display: 'flex', alignItems: 'center' } },
    el('button', { type: 'button', class: 'sec-h', 'aria-label': title, 'aria-expanded': String(!closed), onclick: () => { secState[id] = !secState[id]; store.set('jchat:secs', secState); renderSidebar(); } },
      el('span', 'txt', title), ico('chevd', 11, 'chev')));
  if (add) head.append(el('button', { type: 'button', class: 'sec-add', title: add.title, 'aria-label': add.title, onclick: add.run }, ico('plus')));
  sec.append(head, el('div', 'sec-items', el('div', '', ...items)));
  return sec;
}
function convItem(c, { child } = {}) {
  const streaming = state.streams.has(c.id);
  const lbl = el('span', 'lbl', c.title);
  if (c.kind === 'code' && !child) lbl.append(el('span', 'sub', c.project ? c.project.name : 'Code'));
  const st = streaming ? 'run' : c.status === 'waiting' ? 'wait' : null;
  return el('button', { type: 'button', class: `sitem${child ? ' child' : ''}${state.current === c ? ' active' : ''}`, 'aria-current': state.current === c ? 'page' : null, title: c.title, onclick: () => switchTo(c),
    oncontextmenu: (e) => { e.preventDefault(); convMenu(e.currentTarget, c); } },
    ico(c.temp ? 'clock' : c.kind === 'code' ? 'term' : 'chat'), lbl,
    c.pinned && !child ? ico('pin', 11, 'pin-ic') : null,
    st ? el('span', 'dots', el('span', { class: `dot ${st}`, title: st === 'run' ? 'running' : 'waiting for you' })) : null);
}
function statusDot(c) { return state.streams.has(c.id) ? 'run' : c.status === 'waiting' ? 'wait' : 'done'; }
function renderSidebar() {
  const nav = $('sideScroll');
  const scroll = nav.scrollTop;
  const saved = state.convs.filter((c) => !c.temp);
  const pinned = saved.filter((c) => c.pinned).sort((a, b) => b.updated - a.updated);
  // projects: every listed project, with its sessions
  const byProject = new Map();
  for (const p of state.projects) byProject.set(p.path, { project: p, convs: [] });
  for (const c of saved.filter((x) => x.kind === 'code' && x.project)) {
    if (!byProject.has(c.project.path)) byProject.set(c.project.path, { project: c.project, convs: [] });
    byProject.get(c.project.path).convs.push(c);
  }
  const projItems = [];
  for (const { project, convs } of byProject.values()) {
    convs.sort((a, b) => b.updated - a.updated);
    const branch = (convs[0] && convs[0].project.branch) || project.branch;
    const openKey = `p:${project.path}`;
    const expanded = secState[openKey] !== false;
    projItems.push(el('button', { type: 'button', class: 'sitem', title: `${project.path}${branch ? ` · ${branch}` : ''}`, 'aria-expanded': convs.length ? String(expanded) : null,
      onclick: () => { if (!convs.length) newCodeSession(project); else { secState[openKey] = !expanded; store.set('jchat:secs', secState); renderSidebar(); } } },
    ico('folder'), el('span', 'lbl', project.name, el('span', 'sub', `${branch || 'no branch'}${convs.length ? ` · ${convs.length} session${convs.length === 1 ? '' : 's'}` : ' · new session'}`)),
    convs.length ? el('span', 'dots', ...convs.slice(0, 4).map((c) => el('span', { class: `dot ${statusDot(c)}`, title: `${c.title} — ${statusDot(c) === 'run' ? 'running' : statusDot(c) === 'wait' ? 'waiting' : 'done'}` }))) : null));
    if (expanded) for (const c of convs.slice(0, 6)) projItems.push(convItem(c, { child: true }));
  }
  if (!projItems.length) projItems.push(el('div', 'side-empty', 'No projects yet.'));
  projItems.push(knowledgeItem()); // H11: folders indexed on the Mac, attached to projects (knowledge.js)
  // chats by day
  const chats = saved.filter((c) => c.kind !== 'code' && !c.pinned).sort((a, b) => b.updated - a.updated);
  const chatItems = [];
  let lastDay = '';
  for (const c of chats.slice(0, 80)) {
    const d = relDay(c.updated);
    if (d !== lastDay) { chatItems.push(el('div', 'sec-sub', d)); lastDay = d; }
    chatItems.push(convItem(c));
  }
  if (!chatItems.length) chatItems.push(el('div', 'side-empty', 'Your chats show here.'));
  const personaItems = state.personas.map((p) => el('div', 'srow',
    el('button', { type: 'button', class: 'sitem', title: `New chat with ${p.name}`, onclick: () => { newChat(); setPersona(p.id); } }, ico('spark'), el('span', 'lbl', p.name)),
    el('button', { type: 'button', class: 'iconbtn srow-edit', title: `Edit ${p.name}`, 'aria-label': `Edit persona ${p.name}`, onclick: () => editPersona(p.id) }, ico('edit', 13))));
  if (!personaItems.length) personaItems.push(el('div', 'side-empty', 'Custom instructions for a chat. Add one with +.'));
  const temps = state.convs.filter((c) => c.temp);
  // Acting for someone at askeden.com (acting.js): only what that grant can do here. The Mac,
  // Code and background tasks stay with this person's own account (they'd be refused); a
  // delegate's shared mail and calendar stay.
  const as = acting();
  const macItems = [
    ['brief', el('button', { type: 'button', class: 'sitem', title: 'Brief: your day, and meeting prep', onclick: () => { clearPhoneOverlays(); openBrief(); } }, ico('sun'), el('span', 'lbl', 'Brief'))],
    ['memory', el('button', { type: 'button', class: 'sitem', title: 'Memory', onclick: () => { clearPhoneOverlays(); openSpace('memory'); } }, ico('bulb'), el('span', 'lbl', 'Memory'))],
    ['brain', el('button', { type: 'button', class: 'sitem', title: 'Second Brain', onclick: () => { clearPhoneOverlays(); openSpace('brain'); } }, ico('search'), el('span', 'lbl', 'Second Brain'))],
    ['files', el('button', { type: 'button', class: 'sitem', title: 'Files on your Mac', onclick: () => openFiles() }, ico('folder'), el('span', 'lbl', 'Files'))],
    ['calendar', el('button', { type: 'button', class: 'sitem', title: 'Calendar', onclick: () => { clearPhoneOverlays(); openCalendar(); } }, ico('cal'), el('span', 'lbl', 'Calendar'))],
    ['mail', el('button', { type: 'button', class: 'sitem', title: 'Mail', onclick: () => { clearPhoneOverlays(); openSpace('mail'); } }, ico('mail'), el('span', 'lbl', 'Mail'))],
    ['routines', el('button', { type: 'button', class: 'sitem', title: 'Routines', onclick: () => { clearPhoneOverlays(); openSpace('routines'); } }, ico('routine'), el('span', 'lbl', 'Routines'))],
    ...[['meetings', 'Meetings', 'quote'], ['web', 'On a website', 'globe'], ['activity', 'Activity', 'clock']].map(([k, t, i]) =>
      [k, el('button', { type: 'button', class: 'sitem', title: t, onclick: () => { clearPhoneOverlays(); openSpace(k); } }, ico(i), el('span', 'lbl', t))]), // H5–H7
  ].filter(([k]) => !as || ((k === 'mail' || k === 'calendar') && actingHas(k))).map(([, b]) => b);
  nav.replaceChildren(
    pinned.length ? section('pinned', 'Pinned', pinned.map((c) => convItem(c))) : '',
    as ? '' : section('projects', 'Projects', projItems, { add: { title: 'New code session', run: projectPicker } }),
    section('chats', 'Chats', chatItems, { add: { title: 'New chat (⌘N)', run: newChat } }),
    section('personas', 'Personas', personaItems, { add: { title: 'New persona', run: () => editPersona(null) } }),
    macItems.length ? section('jarvis', as ? 'Shared with you' : 'Your Mac', macItems) : '',
    section('auto', 'Automations', [ // G3 background tasks, H9 saved workflows
      as ? null : el('button', { type: 'button', class: 'sitem', title: 'Tasks: watches Eden runs in the background', onclick: () => openTasks() }, ico('list'), el('span', 'lbl', 'Tasks'),
        pendingApprovals() ? el('span', { class: 'tk-badge', title: 'Waiting for your approval' }, String(pendingApprovals())) : null),
      el('button', { type: 'button', class: 'sitem', title: 'Workflows: saved recipes you run in one tap', onclick: () => openWorkflows() }, ico('spark'), el('span', 'lbl', 'Workflows')),
    ]),
    section('temp', 'Temporary', [
      el('button', { type: 'button', class: 'sitem', title: 'New temporary chat', onclick: newTemp }, ico('clock'), el('span', 'lbl', 'New temporary chat')),
      ...temps.map((c) => convItem(c)),
    ]));
  nav.scrollTop = scroll;
}

/* ================= titlebar ================= */
function renderTitle() {
  const c = state.current;
  const t = $('tbTitle');
  if (!t.isContentEditable) t.textContent = c ? c.title : 'New chat';
  const site = isMock ? 'Eden (mock)' : 'Eden';
  document.title = c && path(c).length ? `${c.title} — ${site}` : site;
  const code = c && c.kind === 'code';
  $('tbBranch').hidden = !(code && c.project && c.project.branch);
  $('tbBranchName').textContent = code && c.project ? c.project.branch || '' : '';
  $('tbDots').replaceChildren(...(code ? [el('span', { class: `dot ${statusDot(c)}`, title: statusDot(c) === 'run' ? 'running' : statusDot(c) === 'wait' ? 'waiting for you' : 'idle' })] : []));
  const tags = [];
  if (c && c.temp) tags.push(el('span', 'tag temp', 'Temporary'));
  const p = persona(c ? c.personaId : state.draftPersona);
  if (p) tags.push(el('span', 'tag', p.name));
  if (code && c.project) tags.push(el('span', 'tag', c.project.name));
  $('tbTags').replaceChildren(...tags);
  const s = sessionCost(c);
  $('tbCost').textContent = `${fmtCost(s.total)}${s.notional ? '*' : ''}`;
  $('tbCost').title = s.notional ? 'Session cost (* Claude via subscription: counted, not billed)' : 'Session cost';
  const pct = Number(($('jc-ctx-text').textContent || '0').replace('%', '')) || 0;
  $('tbCtxPct').textContent = `${pct}%`;
  $('ctxArc').setAttribute('stroke-dashoffset', String(40.2 * (1 - pct / 100)));
  $('tbCtx').title = `Context window: ${pct}% · session ${fmtCost(s.total)}`;
  $('btnConvMenu').disabled = !c;
  paintPrivacy(); // G9: the title bar's lock follows the chat
}

/* ================= transcript ================= */
const scrollcol = () => $('scrollcol');
const nearBottom = () => { const s = scrollcol(); return s.scrollHeight - s.scrollTop - s.clientHeight < 120; };
function toBottom() { const s = scrollcol(); s.scrollTop = s.scrollHeight; }
function msgEl(c, n, last) {
  const m = renderMessage(c, n, { last });
  const chip = m.querySelector('.route-chip');
  if (chip) hoverIntent(chip, () => routePopContent(n.route, n.usage, { onOpenConsole: () => { closeChipPop(); selectTurn(n); } }));
  return m;
}
function renderTranscript() {
  const c = state.current;
  const box = $('transcript');
  const nodes = path(c);
  if (!nodes.length) {
    box.replaceChildren(emptyState(c, { onSuggest: (text) => setComposerText(text) }));
    return;
  }
  box.replaceChildren(...nodes.map((n, i) => msgEl(c, n, i === nodes.length - 1)));
  requestAnimationFrame(toBottom);
}
function updateMessage(c, node, { final } = {}) {
  if (c !== state.current) { if (final) renderSidebar(); return; }
  const old = $('transcript').querySelector(`.msg[data-id="${node.id}"]`);
  const stick = nearBottom();
  const nodes = path(c);
  if (!old) { renderTranscript(); return; }
  const focusAct = document.activeElement && old.contains(document.activeElement) ? document.activeElement.dataset.act : null;
  const fresh = msgEl(c, node, nodes.at(-1) === node);
  old.replaceWith(fresh);
  if (focusAct) { const f = fresh.querySelector(`[data-act="${focusAct}"]`); if (f) f.focus(); }
  if (stick) toBottom();
  if (final) { renderComposer(); renderTitle(); refreshArtifact(); if (c.kind === 'code') renderPlan(); }
  else { renderTitle(); }
}
function selectTurn(node) {
  state.selectedNode = node;
  renderTurnCard(node);
  openInspector('Route');
}
function renderAll() { renderSidebar(); renderTitle(); renderTranscript(); renderComposer(); renderTurnCard(state.selectedNode); renderPlan(); renderActivity(); }

function animateOpen(body, open) {
  if (open) {
    body.style.maxHeight = `${body.scrollHeight}px`;
    const done = () => { body.style.maxHeight = 'none'; body.removeEventListener('transitionend', done); };
    body.addEventListener('transitionend', done);
    setTimeout(done, 450);
  } else {
    body.style.maxHeight = `${body.scrollHeight}px`;
    void body.offsetHeight;
    body.style.maxHeight = '0px';
  }
}

function nodeOf(target) {
  const m = target.closest('.msg');
  const c = state.current;
  return m && c ? c.nodes[m.dataset.id] : null;
}

function citePop(anchor, node, n) {
  const src = node && node.citations && node.citations[n - 1];
  if (!src) return;
  const pop = $('citePop');
  let href = null;
  try { const u = new URL(src.url); if (u.protocol === 'http:' || u.protocol === 'https:') href = u.href; } catch { href = null; }
  pop.replaceChildren(el('b', '', src.title || src.url), el('span', 'u', src.url),
    el('div', 'acts', href ? el('a', { class: 'cap primary', href, target: '_blank', rel: 'noopener noreferrer' }, 'Open') : null,
      el('button', { type: 'button', class: 'cap', onclick: () => copyText(src.url) }, 'Copy link')));
  pop.classList.add('open');
  const r = anchor.getBoundingClientRect();
  pop.style.left = `${Math.min(innerWidth - 296, Math.max(8, r.left - 20))}px`;
  pop.style.top = `${r.bottom + 140 > innerHeight ? r.top - 120 : r.bottom + 8}px`;
  pop._anchor = anchor;
  requestAnimationFrame(() => { const a = pop.querySelector('a, button'); if (a) a.focus(); });
}
function closeCite() { const p = $('citePop'); if (!p.classList.contains('open')) return false; p.classList.remove('open'); if (p._anchor && document.contains(p._anchor)) p._anchor.focus(); return true; }

function regenMenu(anchor, c, node) {
  const models = availableModels();
  const cur = node.route && node.route.model;
  openMenu(anchor, [
    { label: 'Try again', note: 'The router picks again (may choose the same model)', run: () => regenerate(c, node) },
    { label: 'With another model', note: 'A new draft on the model you pick', sub: () => models.map((m) => ({ label: m.name, note: m.id === cur ? 'This draft’s model' : '', run: () => { dispatchEvent(new CustomEvent('eden:choice', { detail: { kind: 'regenerate', c, node, to: m.id } })); regenerate(c, node, { model: m.id, effort: m.defaultEffort }); } })) }, // H2: learned.js
    '-',
    { label: 'More capable (Level 5)', note: 'Max performance for this draft', run: () => { const prev = state.settings.level; setLevel(5); regenerate(c, node); setTimeout(() => setLevel(prev), 0); } },
    { label: 'Cheaper (Level 1)', note: 'Max efficiency for this draft', run: () => { const prev = state.settings.level; setLevel(1); regenerate(c, node); setTimeout(() => setLevel(prev), 0); } },
  ]);
}

function onTranscriptClick(e) {
  const c = state.current;
  const cite = e.target.closest('[data-cite]');
  if (cite) { e.stopPropagation(); citePop(cite, nodeOf(cite), Number(cite.dataset.cite)); return; }
  const b = e.target.closest('[data-act]');
  if (!b || !c) return;
  const node = nodeOf(b);
  const act = b.dataset.act;
  switch (act) {
    case 'chip':
      if (chipPopOpenFor(b)) closeChipPop();
      else openChipPop(b, routePopContent(node.route, node.usage, { onOpenConsole: () => { closeChipPop(); selectTurn(node); } }));
      state.selectedNode = node; renderTurnCard(node);
      break;
    case 'think': {
      const open = !ui_open.thinks.has(node.id);
      if (open) ui_open.thinks.add(node.id); else ui_open.thinks.delete(node.id);
      b.setAttribute('aria-expanded', String(open));
      animateOpen(b.nextElementSibling, open);
      break;
    }
    case 'tool': {
      const card = b.closest('.tool');
      const id = card.dataset.tool;
      const open = !ui_open.tools.has(id);
      if (open) ui_open.tools.add(id); else ui_open.tools.delete(id);
      card.classList.toggle('open', open);
      b.setAttribute('aria-expanded', String(open));
      animateOpen(card.querySelector('.tool-body'), open);
      break;
    }
    case 'sib-prev': case 'sib-next': {
      if (state.streams.has(c.id)) { toast('Wait for the reply, or stop it first'); return; }
      const n = selectSibling(c, node, act === 'sib-prev' ? -1 : 1);
      if (n) { saveConversation(c); renderTranscript(); renderComposer(); renderTitle(); const m = $('transcript').querySelector(`.msg[data-id="${n.id}"] [data-act="${act}"]`); if (m && !m.disabled) m.focus(); }
      break;
    }
    case 'copy-msg': copyText(node.role === 'user' ? node.content || '' : nodeText(node)); break;
    case 'expand-user':
      if (ui_open.expanded.has(node.id)) ui_open.expanded.delete(node.id); else ui_open.expanded.add(node.id);
      updateMessage(c, node);
      break;
    case 'edit':
      ui_open.editing = node.id;
      renderTranscript();
      requestAnimationFrame(() => { const ta = $('transcript').querySelector('textarea[data-edit]'); if (ta) { ta.focus(); ta.selectionStart = ta.value.length; ta.style.height = `${Math.min(300, ta.scrollHeight)}px`; } });
      break;
    case 'edit-cancel': ui_open.editing = null; renderTranscript(); break;
    case 'edit-send': {
      const ta = b.closest('.msg').querySelector('textarea[data-edit]');
      const text = ta.value.trim();
      ui_open.editing = null;
      if (!text) { renderTranscript(); return; }
      editResend(c, node, text);
      break;
    }
    case 'regen': regenMenu(b, c, node); break;
    case 'inspect': selectTurn(node); break;
    case 'retry': retry(c, node); break;
    case 'perm': answerPermission(c, node, Number(b.closest('[data-perm]').dataset.perm), b.dataset.choice); break;
    case 'hunk': {
      const h = b.closest('[data-hunk]');
      const id = h.dataset.hunk;
      setHunk(c, id, b.dataset.state, { quiet: b.dataset.state === 'pending' });
      if (b.dataset.state === 'revert') {
        const part = (node.parts || []).find((p) => p.id === id.split(':')[0]);
        const file = b.dataset.file || (part && part.input && part.input.file_path) || 'that file';
        setComposerText(`Revert edit ${Number(id.split(':')[1]) + 1} you made to ${file}.`);
      }
      updateMessage(c, node);
      break;
    }
    case 'copy-code': { const blk = b.closest('.cblock'); if (blk) copyText(blk._code || ''); break; }
    case 'canvas': case 'codeview': {
      const blk = b.closest('.cblock');
      if (!blk) return;
      const arts = artifactsIn(nodeText(node));
      const a = arts.find((x) => x.code === blk._code);
      openArtifact({ title: a ? a.title : act === 'canvas' ? 'Artifact' : `${blk._lang || 'Code'} snippet`, lang: blk._lang === 'htm' ? 'html' : blk._lang, code: blk._code, nodeId: node.id });
      break;
    }
    case 'open-art': { const a = artifactsIn(nodeText(node))[Number(b.dataset.k)]; if (a) openArtifact({ ...a, nodeId: node.id }); break; }
    case 'open-keys': openSettings(0); break;
    default: break;
  }
}

/* ================= palette ================= */
let palIdx = 0, palItems = [];
function commands() {
  const c = state.current;
  const list = [
    { t: 'New chat', s: '⌘N', i: 'edit', run: newChat },
    { t: 'New temporary chat', s: 'Not saved', i: 'clock', run: newTemp },
    { t: 'New code session…', s: 'Code', i: 'term', run: projectPicker },
    { t: 'Open Route console', s: 'Inspector', i: 'sliders', run: () => openInspector('Route') },
    { t: 'Open Plan', s: 'Inspector', i: 'list', run: () => openInspector('Plan') },
    { t: 'Open Changes', s: 'Inspector', i: 'edit', run: () => openInspector('Changes') },
    { t: 'Toggle inspector', s: '⌘⌥0', i: 'insp', run: toggleInspector },
    { t: 'Toggle sidebar', s: '⌘B', i: 'side', run: () => toggleSidebar() },
    { t: 'Code activity', s: '⌘J', i: 'term', run: () => toggleDrawer() },
    { t: 'Morning brief', s: 'Calendar · mail · notes', i: 'sun', run: () => openBrief() },
    { t: 'Memory', s: 'Your Mac', i: 'bulb', run: () => openSpace('memory') },
    { t: 'Search Second Brain', s: 'Your Mac', i: 'search', run: () => openSpace('brain') },
    { t: 'Calendar', s: 'Your Mac · Google', i: 'cal', run: () => openCalendar() },
    { t: 'New calendar event…', s: 'Calendar', i: 'cal', run: () => openCalendar({ newEvent: true }) },
    { t: 'Open Mail', s: 'Gmail · Mail on your Mac', i: 'mail', run: () => openSpace('mail') },
    { t: 'Tasks', s: 'Background watches · approvals', i: 'list', run: () => openTasks() },
    { t: 'Workflows', s: 'Saved recipes', i: 'spark', run: () => openWorkflows() },
    { t: 'New email…', s: 'Compose · Gmail or Mail on your Mac', i: 'mail', run: () => openCompose({}) },
    { t: 'Send me a heads-up…', s: 'Your Mac · notify', i: 'bell', run: () => openSpace('routines') },
    { t: 'Meetings', s: 'Your Mac · notes and action items', i: 'quote', run: () => openSpace('meetings') },
    { t: 'Browser', s: '⌘⇧B', i: 'globe', run: () => toggleBrowser() },
    { t: 'Do this on a website…', s: 'Your Mac · the built-in browser', i: 'globe', run: () => openSpace('web') },
    { t: 'Activity: what Eden did', s: 'Undo', i: 'clock', run: () => openSpace('activity') },
    { t: 'Choose model…', s: '⌘⇧I', i: 'spark', run: () => { modelMenu(); } },
    { t: 'Use the router (auto)', s: 'Model', i: 'sliders', run: () => setOverride(null) },
    ...[1, 2, 3, 4, 5].map((n) => ({ t: `Router level ${n}`, s: 'Optimization', i: 'chart', run: () => { setLevel(n); toast(`Level ${n}`); } })),
    { t: 'New persona…', s: 'Personas', i: 'spark', run: () => editPersona(null) },
    { t: 'Settings & API keys', s: '⌘,', i: 'gear', run: () => openSettings(0) },
    { t: 'Switch appearance', s: 'Light / Dark / System', i: 'moon', run: cycleTheme },
    { t: 'Take the tour', s: 'Try every feature, safely', i: 'spark', run: () => startTour() },
    { t: 'Download apps', s: 'J.A.R.V.I.S. for Mac, Eden Messenger', i: 'down', run: () => { location.href = DOWNLOAD_URL; } },
    ...helpCommands(),
  ];
  if (c) list.push(
    { t: c.pinned ? 'Unpin this chat' : 'Pin this chat', s: 'Chat', i: 'pin', run: () => togglePin(c) },
    { t: 'Rename this chat', s: 'Double-click the title', i: 'edit', run: startRename },
    { t: 'Export as Markdown', s: 'Chat', i: 'down', run: () => exportConversation(c) },
    { t: 'Delete this chat…', s: 'Chat', i: 'trash', run: () => removeConversation(c) });
  for (const p of state.personas) list.push({ t: `Edit persona: ${p.name}`, s: 'Personas', i: 'spark', run: () => editPersona(p.id) });
  return list;
}
function openPalette() {
  clearPhoneOverlays();
  $('palette').classList.add('open');
  const inp = $('palInput');
  inp.value = '';
  renderPal('');
  // focus now: with a delay, keys typed straight after ⌘K went to the chat composer and Enter ran the
  // unfiltered top item (a recent code session) instead of what was typed (ROADMAP F13)
  inp.focus();
  setTimeout(() => { if ($('palette').classList.contains('open') && document.activeElement !== inp) inp.focus(); }, 30);
}
function closePalette() { if (!$('palette').classList.contains('open')) return false; $('palette').classList.remove('open'); focusComposer(); return true; }
function renderPal(q) {
  q = q.toLowerCase().trim();
  const convs = state.convs.filter((c) => {
    if (!q) return true;
    if (c.title.toLowerCase().includes(q)) return true;
    return Object.values(c.nodes).some((n) => (n.role === 'user' ? n.content || '' : nodeText(n)).toLowerCase().includes(q));
  }).sort((a, b) => b.updated - a.updated).slice(0, q ? 12 : 6)
    .map((c) => ({ t: c.title, s: c.kind === 'code' ? `Code · ${c.project ? c.project.name : ''}` : c.temp ? 'Temporary' : relDay(c.updated), i: c.kind === 'code' ? 'term' : 'chat', run: () => switchTo(c), group: 'Conversations' }));
  const cmds = commands().filter((x) => !q || `${x.t} ${x.s}`.toLowerCase().includes(q)).map((x) => ({ ...x, group: 'Actions' }));
  palItems = [...convs, ...cmds];
  palIdx = 0;
  const list = $('palList');
  if (!palItems.length) { list.replaceChildren(el('div', 'pal-empty', 'No results')); return; }
  const kids = [];
  let g = '';
  const touch = isTouch(); // shortcut-only subtitles (⌘N) mean nothing on a touch screen
  palItems.forEach((it, i) => {
    if (it.group !== g) { kids.push(el('div', { class: 'pal-grp', role: 'presentation' }, it.group)); g = it.group; }
    const row = el('div', { class: `pal-it${i === palIdx ? ' sel' : ''}`, role: 'option', id: `pal-${i}`, 'aria-selected': String(i === palIdx) }, ico(it.i), el('span', 't', it.t), el('span', 'sub', touch && /^[⌘⇧⌥]/.test(it.s || '') ? '' : it.s));
    row.addEventListener('mousemove', () => { if (palIdx !== i) { palIdx = i; paintPal(); } });
    row.addEventListener('click', () => execPal(i));
    kids.push(row);
  });
  list.replaceChildren(...kids);
  $('palInput').setAttribute('aria-activedescendant', 'pal-0');
}
function paintPal() {
  qsa('#palList .pal-it').forEach((r) => { const i = Number(r.id.slice(4)); r.classList.toggle('sel', i === palIdx); r.setAttribute('aria-selected', String(i === palIdx)); });
  const sel = $(`pal-${palIdx}`);
  if (sel) sel.scrollIntoView({ block: 'nearest' });
  $('palInput').setAttribute('aria-activedescendant', `pal-${palIdx}`);
}
function execPal(i) { const it = palItems[i]; if (!it) return; $('palette').classList.remove('open'); it.run(); }

/* ================= dialogs ================= */
let dlgReturn = null;
function openDialog(title, body) {
  dlgReturn = document.activeElement;
  clearPhoneOverlays();
  $('dlgTitle').textContent = title;
  if (body !== $('dlgBody')) $('dlgBody').replaceChildren(body);
  $('dlg').classList.add('open');
  requestAnimationFrame(() => { const f = $('dlgBody').querySelector('input, textarea, button'); (f || $('btnDlgClose')).focus(); });
}
function closeDialog() {
  if (!$('dlg').classList.contains('open')) return false;
  $('dlg').classList.remove('open');
  if (dlgReturn && document.contains(dlgReturn)) dlgReturn.focus();
  return true;
}
function confirmDialog(text, okLabel, run, danger) {
  openDialog('Are you sure?', el('div', '', el('p', { style: { fontSize: '14px', lineHeight: '1.45', color: 'var(--text2)' } }, text),
    el('div', { class: 'dlg-acts', style: { marginTop: '16px' } },
      el('button', { type: 'button', class: 'btn', onclick: closeDialog }, 'Cancel'),
      el('button', { type: 'button', class: `btn ${danger ? 'danger' : 'primary'}`, onclick: () => { closeDialog(); run(); } }, okLabel))));
}
function editPersona(id) {
  const p = id ? persona(id) : null;
  const name = el('input', { type: 'text', maxlength: 60, placeholder: 'e.g. Code Reviewer' });
  const sys = el('textarea', { placeholder: 'How it should answer: tone, format, what to focus on…' });
  name.value = p ? p.name : '';
  sys.value = p ? p.system : '';
  const save = () => {
    const n = name.value.trim();
    if (!n) { name.focus(); return; }
    if (p) Object.assign(p, { name: n, system: sys.value.trim() });
    else state.personas.push({ id: `p${Date.now().toString(36)}`, name: n, system: sys.value.trim() });
    savePersonas();
    closeDialog();
    renderSidebar(); renderAttachments(); renderTitle();
    toast(p ? 'Persona saved' : `Persona “${n}” added`);
  };
  openDialog(p ? 'Edit persona' : 'New persona', el('div', '',
    el('label', 'field', 'Name', name),
    el('label', 'field', 'Instructions (sent as the system prompt)', sys),
    el('div', 'dlg-acts',
      p ? el('button', { type: 'button', class: 'btn danger', onclick: () => {
        state.personas = state.personas.filter((x) => x !== p);
        savePersonas();
        for (const c of state.convs) if (c.personaId === p.id) { c.personaId = null; saveConversation(c); }
        closeDialog(); renderSidebar(); renderAttachments(); toast('Persona deleted');
      } }, 'Delete') : null,
      el('span', 'grow'),
      el('button', { type: 'button', class: 'btn', onclick: closeDialog }, 'Cancel'),
      el('button', { type: 'button', class: 'btn primary', onclick: save }, 'Save'))));
}
function convMenu(anchor, c) {
  openMenu(anchor, [
    { label: 'Rename', run: () => { if (state.current !== c) switchTo(c); startRename(); } },
    ...(c.temp ? [] : [{ label: c.pinned ? 'Unpin' : 'Pin', run: () => togglePin(c) }]),
    { label: 'Export as Markdown', run: () => exportConversation(c) },
    ...(c.kind !== 'code' ? [{ label: 'Save as workflow…', run: () => saveWorkflowFrom(c) }] : []), // H9
    ...(c.kind === 'code' ? [{ label: 'Code activity', key: '⌘J', run: () => toggleDrawer(true) }, { label: 'Changes', run: () => openInspector('Changes') }] : []),
    '-',
    { label: 'Delete…', danger: true, run: () => removeConversation(c) },
  ]);
}
function startRename() {
  const t = $('tbTitle');
  if (!state.current) { toast('Send a message first'); return; }
  t.contentEditable = 'true';
  t.focus();
  const r = document.createRange(); r.selectNodeContents(t);
  const s = getSelection(); s.removeAllRanges(); s.addRange(r);
}
function finishRename(save) {
  const t = $('tbTitle');
  if (t.contentEditable !== 'true') return;
  t.contentEditable = 'false';
  if (save) renameConversation(state.current, t.textContent);
  renderTitle();
}

/* ================= settings ================= */
let setTabI = 0;
function openSettings(i = 0) {
  if (i === 'accounts') i = 1;
  clearPhoneOverlays();
  $('settingsSheet').classList.add('open');
  setTabI = i;
  drawSettings();
  requestAnimationFrame(() => $('setSeg').querySelectorAll('button')[i].focus());
}
function closeSettings() { if (!$('settingsSheet').classList.contains('open')) return false; $('settingsSheet').classList.remove('open'); focusComposer(); return true; }
async function drawSettings() {
  setSeg($('setSeg'), setTabI);
  const body = $('setBody');
  if (setTabI === 0) {
    body.replaceChildren(el('div', 'muted', 'Loading…'));
    let keys;
    try { keys = await api.keys(); } catch (e) { body.replaceChildren(el('div', 'sp-warn', el('b', '', 'Couldn’t read the keys'), e.message)); return; }
    const provs = (state.meta && state.meta.providers) || Object.keys(keys).map((id) => ({ id, name: id }));
    const rows = provs.map((p) => keyRow(p, keys[p.id] || { set: false, source: null }));
    body.replaceChildren(el('div', 'set-sec', el('h3', '', 'API keys'),
      el('p', 'sp-note', state.meta && state.meta.hosted
        ? 'Your keys are stored encrypted on your account and used only for your chats, never by delegates or team spaces. They’re never shown again once saved; remove one any time. Chats on your own key don’t use your included AI.'
        : 'Keys stay on this Mac (~/.config/model-router/keys.json, readable only by you); the page never sees them again once saved. Environment variables win over the file.'),
      el('div', 'icard', ...rows)));
  } else if (setTabI === 1) {
    drawAccounts(body);
  } else if (setTabI === 2) {
    const cur = state.settings.theme || 'system';
    const seg = el('div', { class: 'seg', style: { '--n': 3 }, role: 'radiogroup', 'aria-label': 'Appearance' }, el('div', 'seg-thumb'),
      ...['system', 'light', 'dark'].map((t) => el('button', { type: 'button', role: 'radio', onclick: () => { setTheme(t); drawSettings(); } }, t[0].toUpperCase() + t.slice(1))));
    setSeg(seg, ['system', 'light', 'dark'].indexOf(cur));
    body.replaceChildren(el('div', 'set-sec', el('h3', '', 'Appearance'), seg,
      el('p', 'sp-note', 'System follows macOS. Reduced motion and reduced transparency in System Settings › Accessibility are honored.')), voiceSettings());
  } else if (setTabI === 3) {
    const sw = el('input', { type: 'checkbox', 'aria-label': 'Claude counts as subscription' });
    sw.checked = !!state.settings.subscriptionClaude;
    sw.addEventListener('change', () => { state.settings.subscriptionClaude = sw.checked; saveSettings(); schedulePreview(); toast(sw.checked ? 'Claude priced as subscription quota' : 'Claude priced at API rates'); });
    body.replaceChildren(el('div', 'set-sec', el('h3', '', 'Routing'),
      el('div', 'icard', el('div', 'prov', el('div', 'grow', el('div', 'p-n', 'Claude counts as subscription'), el('div', 'p-c', 'Claude through the Claude Code CLI is priced as a fraction of your plan’s quota, not API dollars, so the router uses it more freely.')), el('label', 'switch', sw, el('span', 'tr')))),
      el('p', 'sp-note', `Level ${state.settings.level}${currentOverride() ? ` · pinned to ${modelInfo(currentOverride().model)?.name || currentOverride().model}` : ' · auto'}. Levels, sliders, providers and the override live in the inspector’s Route tab.`),
      el('div', 'dlg-acts', el('button', { type: 'button', class: 'btn primary', onclick: () => { closeSettings(); openInspector('Route'); } }, 'Open Route console'))), privacySettings(), autopilotSettings(), learnedSettings()); // H3, H2
  } else {
    body.replaceChildren(el('div', 'set-sec about', el('h3', '', 'About'),
      el('p', '', el('b', '', 'Eden'), ' — one chat for every model you have: each message is routed by the Model Router (rules, rated by Gemini) and streamed from the model it picks, with your second brain, memory and calendar through the Jarvis app on your Mac, and Code sessions for your projects.'),
      el('p', '', 'Eden · design: Kimi K3 (Atelier). Input bar: from Jarvis Code.'),
      el('p', '', state.meta && state.meta.scope ? state.meta.scope : ''),
      el('p', '', 'Voice from J.A.R.V.I.S.: dictate with the mic in the input bar, have replies read aloud in the JARVIS voice, or talk with the waveform button. The microphone is used only when you press one of them.'),
      isMock ? el('p', '', el('b', '', 'Mock mode: '), 'every answer on this page is simulated in the browser (?mock=1).') : null,
      el('div', 'dlg-acts', helpButton(closeSettings), el('a', { class: 'btn', href: DOWNLOAD_URL }, 'Download apps'), el('button', { type: 'button', class: 'btn primary', onclick: () => { closeSettings(); startTour(); } }, 'Take the tour'))));
  }
}
async function drawAccounts(body) {
  body.replaceChildren(el('div', 'muted', 'Loading…'));
  let st;
  try { st = await api.googleStatus(); } catch (e) { body.replaceChildren(el('div', 'sp-warn', el('b', '', 'Couldn’t read the Gmail status'), e.message)); return; }
  if (setTabI !== 1) return;
  if (st.hosted || (state.meta && state.meta.hosted)) { drawHostedAccounts(body, st); return; } // askeden.com: no client to set up
  const id = el('input', { type: 'text', autocomplete: 'off', spellcheck: 'false', placeholder: 'xxxxxxxx.apps.googleusercontent.com', 'aria-label': 'Google OAuth client ID' });
  const secret = el('input', { type: 'password', autocomplete: 'off', spellcheck: 'false', placeholder: st.configured ? 'Saved (enter a new one to replace)' : 'Client secret', 'aria-label': 'Google OAuth client secret' });
  // the server always signs in with http://localhost:<port>/… (google-routes.ts localRedirectUri),
  // so show that one even when this page is open at 127.0.0.1 or [::1]
  const loopback = /^(127\.0\.0\.1|\[::1\])$/.test(location.hostname);
  const redirect = `${loopback ? `${location.protocol}//localhost${location.port ? `:${location.port}` : ''}` : location.origin}${API_ROOT}/api/chat/google/callback`;
  const save = async () => {
    if (!id.value.trim() || !secret.value.trim()) { toast('Enter both the client ID and the secret'); return; }
    try { await api.googleConfig(id.value.trim(), secret.value.trim()); id.value = ''; secret.value = ''; toast('Gmail client saved'); drawAccounts(body); }
    catch (e) { toast(`Couldn’t save: ${e.message}`); }
  };
  const status = st.connected ? `Connected as ${st.email || 'your Google account'}` : st.configured ? 'Set up — not connected yet' : 'Not set up';
  body.replaceChildren(el('div', 'set-sec', el('h3', '', 'Gmail'),
    el('div', 'icard',
      el('div', 'prov', el('span', { class: 'pdot gemini', 'aria-hidden': 'true' }), el('div', 'grow', el('div', 'p-n', 'Gmail'), el('div', `p-c${st.connected ? ' ok' : ''}`, status)),
        st.connected ? el('button', { type: 'button', class: 'cap rev', onclick: async () => { try { await api.googleDisconnect(); toast('Gmail disconnected'); drawAccounts(body); } catch (e) { toast(e.message); } } }, 'Disconnect')
          : st.configured ? el('button', { type: 'button', class: 'cap primary', onclick: connectGmail }, 'Connect Gmail') : null),
      el('div', { class: 'field', style: { marginTop: '10px' } }, 'OAuth client ID', id),
      el('div', 'field', 'Client secret', secret),
      el('div', 'dlg-acts', el('button', { type: 'button', class: 'btn primary', onclick: save }, st.configured ? 'Replace client' : 'Save'))),
    el('p', 'sp-note', 'How to: in Google Cloud Console › APIs & Services, enable the Gmail API, then create an OAuth client ID of type “Web application” with this authorized redirect URI:'),
    el('code', { class: 'readout', style: { display: 'block', userSelect: 'all' } }, redirect),
    el('p', 'sp-note', 'Paste its client ID and secret here. They’re stored on this Mac by the server and never shown again. Then press Connect Gmail and sign in.')),
  el('div', 'set-sec', el('h3', '', 'Mail on your Mac'),
    el('p', 'sp-note', state.jarvis.available ? 'Connected through the Jarvis app on your Mac: your Mail accounts show in the Mail panel.' : `Not connected: ${state.jarvis.reason || 'open the Jarvis app on your Mac'}.`)));
}

// askeden.com: Google is askeden.com's own sign-in client, so there's no client ID or secret to
// enter (that form is the Mac's): connect Gmail and Calendar, or disconnect.
function drawHostedAccounts(body, st) {
  const as = `Connected as ${st.email || 'your Google account'}`;
  const connectCalendar = async () => {
    try {
      const r = await api.googleConnect('calendar');
      if (!r || !r.url) { toast('Couldn’t start the Google sign-in'); return; }
      try { sessionStorage.setItem('eden:cal:return', '1'); } catch { /* private mode */ } // calendar.js's RETURN_KEY: back to the Calendar
      location.assign(r.url);
    } catch (e) { toast(`Couldn’t connect Google Calendar: ${e.message}`); }
  };
  const row = (name, on, button) => el('div', 'prov', el('span', { class: 'pdot gemini', 'aria-hidden': 'true' }), el('div', 'grow', el('div', 'p-n', name), el('div', `p-c${on ? ' ok' : ''}`, on ? as : 'Not connected')), button);
  body.replaceChildren(el('div', 'set-sec', el('h3', '', 'Google'),
    el('div', 'icard',
      row('Gmail', st.gmail, st.gmail ? null : el('button', { type: 'button', class: 'cap primary', onclick: connectGmail }, 'Connect Gmail')),
      row('Google Calendar', st.calendar, st.calendar ? null : el('button', { type: 'button', class: 'cap primary', onclick: connectCalendar }, 'Connect Calendar')),
      st.gmail || st.calendar ? el('div', 'dlg-acts', el('button', { type: 'button', class: 'cap rev', onclick: async () => { try { await api.googleDisconnect(); toast('Google disconnected'); drawAccounts(body); } catch (e) { toast(e.message); } } }, 'Disconnect Google')) : null),
    el('p', 'sp-note', 'On askeden.com, Eden asks Google for Gmail and for Calendar separately, through askeden.com’s own Google sign-in: there’s nothing to set up here. Your Google tokens are kept encrypted in your account and never reach this page; Disconnect also removes Eden’s access at Google.')),
  el('div', 'set-sec', el('h3', '', 'Mail on your Mac'),
    el('p', 'sp-note', state.jarvis.available ? 'Connected through the Jarvis app on your Mac: your Mail accounts show in the Mail panel.' : `Not connected: ${String(state.jarvis.reason || 'open the Jarvis app on your Mac').replace(/\.+$/, '')}.`)));
}

function keyRow(p, k) {
  const hosted = !!(state.meta && state.meta.hosted);
  // askeden.com keeps the key sealed in the account: only its last 4 characters and when it was added come back
  const status = k.set ? (k.source === 'env' ? 'Set in the environment' : k.source === 'account' ? `Set ····${k.last4 || ''}${k.added ? ` · added ${new Date(k.added).toLocaleDateString()}` : ''}` : 'Saved on this Mac')
    : hosted ? (p.available ? 'Not set: chats use your included AI' : 'Not set') : p.id === 'anthropic' && p.available ? 'No key — Claude works through your Claude Code subscription' : 'Not set';
  const row = el('div', 'key-row');
  const draw = (editing) => {
    const input = el('input', { type: 'password', autocomplete: 'off', spellcheck: 'false', placeholder: `${p.name || p.id} API key`, 'aria-label': `${p.name || p.id} API key` });
    const save = async () => {
      const v = input.value.trim();
      if (!v) { input.focus(); return; }
      try { const r = await api.setKey(p.id, v); input.value = ''; toast(r && r.check && r.check.ok ? `${p.name || p.id}: key works, saved` : `${p.name || p.id} key saved`); await reloadMeta(); drawSettings(); }
      catch (e) { toast(`Couldn’t save: ${e.message}`); }
    };
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); save(); } if (e.key === 'Escape') { e.stopPropagation(); draw(false); } });
    // (replaceChildren turns a null into the text "null": the parts not shown are dropped first)
    row.replaceChildren(...[
      el('span', { class: `pdot ${p.id}`, 'aria-hidden': 'true' }),
      el('div', 'grow', el('div', 'p-n', p.name || p.id), el('div', `p-c${k.set || (p.id === 'anthropic' && p.available) ? ' ok' : ''}`, status), !hosted && !p.available && p.reason && !k.set ? el('div', 'p-c', p.reason) : null),
      editing ? null : el('button', { type: 'button', class: 'cap', onclick: () => draw(true) }, k.set ? 'Replace' : 'Set key'),
      editing || !k.set || k.source === 'env' ? null : el('button', { type: 'button', class: 'cap rev', onclick: async () => {
        try { await api.setKey(p.id, ''); toast('Key removed'); await reloadMeta(); drawSettings(); } catch (e) { toast(`Couldn’t remove: ${e.message}`); }
      } }, 'Remove'),
      editing ? el('div', 'key-edit', input, el('button', { type: 'button', class: 'btn primary', onclick: save }, 'Save'), el('button', { type: 'button', class: 'btn', onclick: () => draw(false) }, 'Cancel')) : null,
    ].filter(Boolean));
    if (editing) requestAnimationFrame(() => input.focus());
  };
  draw(false);
  return row;
}
function cycleTheme() { const order = ['system', 'light', 'dark']; setTheme(order[(order.indexOf(state.settings.theme || 'system') + 1) % 3]); toast(`Appearance: ${state.settings.theme}`); }

/* ================= slash commands ================= */
function slash(name, arg) {
  const c = state.current;
  switch (name) {
    case 'new': newChat(); return true;
    case 'temp': newTemp(); return true;
    case 'code': projectPicker(); return true;
    case 'chat': case 'search': case 'research':
      if (c && c.kind === 'code') return false;
      setMode(name);
      if (arg) setTimeout(() => sendFromComposer(arg, [], []), 0);
      return true;
    case 'manual': case 'edits': case 'plan': case 'auto':
      if (!c || c.kind !== 'code') return false;
      setMode({ manual: 'default', edits: 'acceptEdits', plan: 'plan', auto: 'bypassPermissions' }[name]);
      if (arg && name !== 'auto') setTimeout(() => sendFromComposer(arg, [], []), 0);
      return true;
    case 'model': {
      if (!arg) { modelMenu(); return true; }
      if (/^(auto|router)$/i.test(arg)) { setOverride(null); toast('Model Router (auto)'); return true; }
      const q = arg.toLowerCase();
      const m = availableModels().find((x) => x.id.toLowerCase() === q) || availableModels().find((x) => x.name.toLowerCase().includes(q) || x.id.includes(q));
      if (!m) { toast(`No available model matches “${arg}”`); return true; }
      setOverride(m.id); toast(`Model: ${m.name}`); return true;
    }
    case 'effort': {
      const o = currentOverride();
      if (!o) { toast('The router picks the effort; choose a model first'); return true; }
      const m = modelInfo(o.model);
      const e = String(arg || '').toLowerCase().replace(/^extra[- ]?high$/, 'xhigh');
      if (!m.efforts.includes(e)) { toast(`${m.name}: ${m.efforts.join(', ')}`); return true; }
      setOverride(o.model, e); toast(`Effort: ${e}`); return true;
    }
    case 'level': { const n = Number(arg); if (n >= 1 && n <= 5) { setLevel(n); toast(`Level ${n}`); } else toast('/level 1–5'); return true; }
    case 'persona': {
      if (!arg || /^none$/i.test(arg)) { setPersona(null); return true; }
      const p = state.personas.find((x) => x.name.toLowerCase().includes(arg.toLowerCase()));
      if (p) setPersona(p.id); else toast(`No persona called “${arg}”`);
      return true;
    }
    case 'note': case 'brain': openSpace('brain', { query: arg }); return true;
    case 'memory': openSpace('memory'); return true;
    case 'meetings': openSpace('meetings'); return true;
    case 'web': openSpace('web', { goal: arg }); return true;
    case 'undo': openSpace('activity'); return true; // (/activity is Code mode's tool activity)
    case 'brief': openBrief(); return true;
    case 'calendar': openCalendar(); return true;
    case 'canvas': {
      const n = [...path(c)].reverse().find((x) => x.role === 'assistant' && artifactsIn(nodeText(x)).length);
      if (n) openArtifact({ ...artifactsIn(nodeText(n)).at(-1), nodeId: n.id }); else toast('No artifact in this chat yet: ask for an HTML page or an SVG');
      return true;
    }
    case 'rename': if (arg) renameConversation(c, arg); else startRename(); return true;
    case 'export': exportConversation(c); return true;
    case 'pin': togglePin(c); return true;
    case 'copy': { const n = [...path(c)].reverse().find((x) => x.role === 'assistant'); if (n) copyText(nodeText(n)); else toast('No reply to copy yet'); return true; }
    case 'clear': clearConversation(); return true;
    case 'compact': compact(); return true;
    case 'route': openInspector('Route'); return true;
    case 'changes': openInspector('Changes'); return true;
    case 'todos': openInspector('Plan'); return true;
    case 'activity': toggleDrawer(true); return true;
    case 'settings': openSettings(0); return true;
    case 'theme': if (['light', 'dark', 'system'].includes(arg)) setTheme(arg); else cycleTheme(); return true;
    case 'stop': if (!stop()) toast('Nothing to stop'); return true;
    case 'tour': startTour(); return true;
    case 'help': setTimeout(() => setComposerText('?'), 0); setTimeout(() => $('deck-input').dispatchEvent(new Event('input')), 10); return true;
    default: return false;
  }
}

function clearConversation() {
  const c = state.current;
  if (!c) return;
  if (c.kind === 'code') newCodeSession(c.project);
  else { const pid = c.personaId; newChat(); if (pid) setPersona(pid); }
  toast('Fresh start');
}
async function compact() {
  const c = state.current;
  if (!c || !path(c).length) { toast('Nothing to compact yet'); return; }
  if (c.kind === 'code') { sendMessage('/compact', []); return; }
  toast('Compacting: summarizing this chat…');
  const messages = path(c).filter((n) => n.role === 'user' || nodeText(n)).map((n) => ({ role: n.role, content: n.role === 'user' ? n.content || '' : nodeText(n) }));
  messages.push({ role: 'user', content: 'Summarize our conversation so far as compact notes: the goal, the decisions and facts established, open questions, and anything I asked you to remember. Under 300 words.' });
  let summary = '';
  try {
    await api.send({ ...privacyBody(c), messages, settings: { ...(await import('./router.js')).routeSettings(), level: 1, efficiency: 80, performance: 30 }, mode: 'chat' }, {
      onEvent: (t, d) => { if (t === 'text') summary += d.text || ''; if (t === 'error') throw new Error(d.message); },
    });
  } catch (e) { toast(`Couldn’t compact: ${e.message}`); return; }
  if (!summary.trim()) { toast('Couldn’t compact: empty summary'); return; }
  const pid = c.personaId;
  const title = c.title;
  newChat();
  if (pid) setPersona(pid);
  addContext({ title: `Earlier: ${title}`.slice(0, 70), text: summary.trim() });
}

/* ================= sending from the composer ================= */
function sendFromComposer(text, attachments, context) {
  const meta = state.meta;
  const c = state.current;
  if (c && c.kind === 'code') {
    if (meta && meta.code && meta.code.available === false) { toast(`Code mode is unavailable: ${meta.code.reason || ''}`); return false; }
  } else if (meta && !(meta.providers || []).some((p) => p.available) && !currentOverride()) {
    toast('No model provider is available. Add an API key in Settings.', { label: 'Settings', run: () => openSettings(0) });
    return false;
  }
  if (!c && state.pendingMode && state.pendingMode !== 'chat') {
    const ok = sendMessage(text, attachments, { context });
    if (ok && state.current) { state.current.mode = state.pendingMode; state.pendingMode = 'chat'; }
    return ok;
  }
  const ok = sendMessage(text, attachments, { context });
  if (ok) clearAttachments();
  return ok;
}

/* ================= global keys + Esc order ================= */
function onKey(e) {
  const mod = e.metaKey || e.ctrlKey;
  const k = e.key.toLowerCase();
  if (mod && !e.altKey && k === 'k') { e.preventDefault(); if (!closePalette()) openPalette(); return; }
  if (mod && !e.altKey && !e.shiftKey && k === 'n') { e.preventDefault(); newChat(); return; }
  if (mod && e.shiftKey && k === 'o') { e.preventDefault(); newChat(); return; }
  if (mod && !e.altKey && !e.shiftKey && k === 'b') { e.preventDefault(); toggleSidebar(); return; }
  if (mod && !e.altKey && e.shiftKey && k === 'b') { e.preventDefault(); toggleBrowser(); return; }
  if (mod && e.altKey && e.code === 'Digit0') { e.preventDefault(); toggleInspector(); return; }
  if (mod && !e.altKey && !e.shiftKey && k === 'j') { e.preventDefault(); toggleDrawer(); return; }
  if (mod && !e.altKey && k === ',') { e.preventDefault(); openSettings(0); return; }
  if (e.key !== 'Escape') return;
  if ($('tbTitle').isContentEditable) { finishRename(false); return; }
  if (closeDialog() || closeSettings()) { e.preventDefault(); return; }
  if (closePalette()) return;
  if (closeCite()) return;
  if (closeChipPop(true)) return;
  if (composerEscape(e)) { e.preventDefault(); return; }
  if (closeSpace()) return;
  if (closePane()) return;
  if (ui_open.editing) { ui_open.editing = null; renderTranscript(); return; }
  // the running turn stops before panes close (as Jarvis Code interrupts first)
  // Esc stops the running reply (as in Jarvis Code), never with unsent text in the composer
  const tag = document.activeElement && document.activeElement.tagName;
  const inField = (tag === 'INPUT' || tag === 'TEXTAREA') && document.activeElement.id !== 'deck-input';
  const draft = document.activeElement && document.activeElement.id === 'deck-input' && $('deck-input').value.trim();
  if (!inField && !draft && stop()) { toast('Stopped'); return; }
  if (artifactOpen()) { closeArtifact(); return; }
  if (document.activeElement && document.activeElement.closest('#browserPane') && closeBrowser()) return;
  if ($('drawer').classList.contains('open')) { toggleDrawer(false); return; }
  if (isNarrow() && $('inspector').classList.contains('open')) { closeInspector(); return; }
  if ($('sidebar').classList.contains('open') || ($('sidebar').classList.contains('expanded') && !docksSidebar())) { closeOverlays(); }
}

/* ================= inspector sheet grabber (≤640px) ================= */
function initGrab() {
  const g = $('inspGrab'), i = $('inspector');
  let y0 = null;
  g.addEventListener('pointerdown', (e) => { y0 = e.clientY; g.setPointerCapture(e.pointerId); });
  g.addEventListener('pointerup', (e) => {
    if (y0 === null) return;
    const dy = e.clientY - y0;
    y0 = null;
    if (dy < -50) { if (i.classList.contains('peek')) i.classList.remove('peek'); else i.classList.add('full'); }
    else if (dy > 50) { if (i.classList.contains('full')) i.classList.remove('full'); else if (!i.classList.contains('peek')) i.classList.add('peek'); else closeInspector(); }
    else i.classList.toggle('full');
  });
}

/* ================= meta ================= */
async function reloadMeta() {
  try { state.meta = await api.meta(); state.metaError = null; }
  catch (e) { state.metaError = e.message; }
  renderRouteControls();
  renderComposer();
  if (!state.current || !path(state.current).length) renderTranscript();
}

/* ================= init ================= */
function init() {
  applyTheme();
  loadConversations();
  const cur = store.get('jchat:current', null);
  state.current = state.convs.find((c) => c.id === cur) || null;
  if (state.current) state.selectedNode = [...path(state.current)].reverse().find((n) => n.role === 'assistant' && n.route) || null;
  if (!isNarrow()) {
    if (store.get('jchat:sidebar', true) === false) $('sidebar').classList.add('closed');
    $('inspector').classList.toggle('closed', !store.get('jchat:inspector', false));
  }
  syncDock();
  Object.assign(ui, { render: () => { renderTranscript(); renderTitle(); renderComposer(); }, renderSidebar, renderTitle, renderComposer, updateMessage, renderInspector: () => renderTurnCard(state.selectedNode), renderPlan, loadChanges: (quiet) => { if (curTab === 'Changes' && inspectorVisible()) loadChanges(quiet); }, renderActivity });

  initRouteControls();
  initChipPop();
  initComposer({
    send: sendFromComposer, stop: () => stop(), slash,
    queue: (t) => { const c = state.current; queueFollowUp(c, t); if (c.kind !== 'code') toast('Steer queued: it goes as soon as this reply ends'); },
    steerNow: (id) => steerNow(state.current, id), dropQueued: (id) => dropQueued(state.current, id),
    setPersona, editPersona, newTemp, openSettings, openInspector, openBrain: () => openSpace('brain'),
    searchNotes, attachNote, save: (c) => { saveConversation(c); renderTitle(); renderSidebar(); }, confirm: (text, ok, run) => confirmDialog(text, ok, run, true),
    compact, clear: clearConversation,
  });
  initArtifact({ quote: (t) => setComposerText(t, { append: true }) });
  initPrivacy({ confirm: (text, ok, run) => confirmDialog(text, ok, run, true), schedulePreview });
  initPublish({ openDialog, closeDialog });
  initPanels({ addContext: (b) => { addContext(b); closeSpace(); } });
  initCalendar({ addContext: (b) => addContext(b), openSettings });
  initMemory({ addContext: (b) => addContext(b) });
  initBrief({ addContext: (b) => addContext(b) });
  initFiles({ addContext: (b) => addContext(b), addFile, setComposerText, focusComposer, renderComposer, clearPhoneOverlays }); // G2/H4 (files.js)
  initKnowledge({ switchTo, renderSidebar, renderComposer, clearPhoneOverlays }); // H11 (knowledge.js)
  initCode({ closeDialog, openDialog, newCodeSession, renderTitle, renderSidebar, quote: (t) => setComposerText(t, { append: true }) });
  initMail({
    openDialog, closeDialog, openSettings, jarvisAvailable: () => state.jarvis.available, jarvisReason: () => state.jarvis.reason,
    summarize: (m) => {
      closeSpace();
      if (state.current && (state.current.kind === 'code' || state.streams.has(state.current.id))) newChat();
      sendFromComposer('Summarize this email: key points, asks, deadlines.', [], [{ title: `Email: ${m.subject}`.slice(0, 80), text: emailText(m), source: 'mail', hidden: m.hidden || 0 }]);
    },
    writeReply: async (m) => {
      let out = '';
      await api.send({
        messages: [{ role: 'user', content: 'Write a reply to this email for me to send. Output only the body of the reply (greeting to sign-off), no subject line, no notes.' }],
        settings: routeSettings(), mode: 'chat', context: [{ title: `Email: ${m.subject}`, text: emailText(m), source: 'mail', hidden: m.hidden || 0 }],
      }, { onEvent: (t, d) => { if (t === 'text') out += d.text || ''; if (t === 'error') throw new Error(d.message || 'failed'); } });
      return out.trim();
    },
  });
  initGrab();
  // back from Google's sign-in
  const gh = /#gmail=(\w+)/.exec(location.hash);
  if (gh) {
    history.replaceState(null, '', location.pathname + location.search);
    // Calendar's own Connect (or Settings') left a note to come back to it: say what was connected.
    const toCalendar = gh[1] === 'connected' && calendarReturnPending();
    toast(gh[1] === 'connected' ? (toCalendar ? 'Google Calendar connected' : 'Gmail connected') : 'Google sign-in didn’t finish. Try again.');
    if (gh[1] === 'connected') setTimeout(() => (toCalendar ? openCalendar() : openSpace('mail')), 300);
  }
  // a link to Settings › Models & API keys (askeden.com's "Add your Anthropic API key…")
  if (location.hash === '#settings=keys') {
    history.replaceState(null, '', location.pathname + location.search);
    setTimeout(() => openSettings(0), 0);
  }
  // G3 background tasks (their approval card shows anywhere) and H9 saved workflows.
  initTasks({ beforeOpen: clearPhoneOverlays });
  initWorkflows({
    beforeOpen: clearPhoneOverlays,
    current: () => state.current,
    messagesOf: (c) => path(c).filter((n) => n.role === 'user').map((n) => ({ role: 'user', content: n.content || '', attachments: n.attachments || [] })),
    run: (text, attachments, { mode } = {}) => {
      closeSpace();
      newChat();
      if (mode && mode !== 'chat' && !state.current) state.pendingMode = mode;
      return sendFromComposer(text, attachments);
    },
    openTasks,
  });

  $('transcript').addEventListener('click', onTranscriptClick);
  $('transcript').addEventListener('keydown', (e) => {
    const cite = e.target.closest('sup.cite');
    if (cite && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); citePop(cite, nodeOf(cite), Number(cite.dataset.cite)); return; }
    const ta = e.target.closest('textarea[data-edit]');
    if (ta && e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); ta.closest('.msg').querySelector('[data-act="edit-send"]').click(); }
  });
  $('transcript').addEventListener('input', (e) => { const ta = e.target.closest('textarea[data-edit]'); if (ta) { ta.style.height = 'auto'; ta.style.height = `${Math.min(300, ta.scrollHeight)}px`; } });
  document.addEventListener('pointerdown', (e) => {
    if ($('citePop').classList.contains('open') && !e.target.closest('#citePop, [data-cite]')) $('citePop').classList.remove('open');
    // the narrow inspector closes on a click outside it (it's an overlay there)
    if (isNarrow() && !isMobile() && $('inspector').classList.contains('open') && !e.target.closest('#inspector, #btnInspector, .route-chip, [data-act="inspect"], .jc-menu, #chipPop, #palette, .sheet')) closeInspector();
  });
  addEventListener('keydown', onKey);

  $('btnSearch').addEventListener('click', openPalette);
  $('btnPalette').addEventListener('click', openPalette);
  $('btnNew').addEventListener('click', newChat);
  $('btnTheme').addEventListener('click', cycleTheme);
  $('btnSettings').addEventListener('click', () => openSettings(0));
  $('btnHamburger').addEventListener('click', () => toggleSidebar());
  $('btnSidebarDesk').addEventListener('click', () => toggleSidebar());
  $('btnInspector').addEventListener('click', toggleInspector);
  $('btnInspClose').addEventListener('click', closeInspector);
  $('btnConvMenu').addEventListener('click', () => { if (state.current) convMenu($('btnConvMenu'), state.current); });
  $('btnDrawerClose').addEventListener('click', () => toggleDrawer(false));
  $('scrim').addEventListener('click', closeOverlays);
  $('inspSeg').addEventListener('click', (e) => { const b = e.target.closest('[data-tab]'); if (b) inspTab(b.dataset.tab); });
  $('inspSeg').addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
    e.preventDefault();
    const i = (TABS.indexOf(curTab) + (e.key === 'ArrowRight' ? 1 : -1) + TABS.length) % TABS.length;
    inspTab(TABS[i]);
    $('inspSeg').querySelectorAll('button')[i].focus();
  });
  $('setSeg').addEventListener('click', (e) => { const b = e.target.closest('button[data-i]'); if (b) { setTabI = Number(b.dataset.i); drawSettings(); } });
  $('btnSetClose').addEventListener('click', closeSettings);
  $('settingsSheet').addEventListener('click', (e) => { if (e.target === $('settingsSheet')) closeSettings(); });
  $('btnDlgClose').addEventListener('click', closeDialog);
  $('dlg').addEventListener('click', (e) => { if (e.target === $('dlg')) closeDialog(); });
  $('palette').addEventListener('click', (e) => { if (e.target === $('palette')) closePalette(); });
  $('palInput').addEventListener('input', (e) => renderPal(e.target.value));
  $('palInput').addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); palIdx = Math.min(palItems.length - 1, palIdx + 1); paintPal(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); palIdx = Math.max(0, palIdx - 1); paintPal(); }
    else if (e.key === 'Enter') { e.preventDefault(); execPal(palIdx); }
  });
  const title = $('tbTitle');
  title.addEventListener('dblclick', startRename);
  title.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); finishRename(true); } });
  title.addEventListener('blur', () => finishRename(true));
  // trap Tab inside modal sheets
  for (const id of ['dlg', 'settingsSheet', 'palette']) {
    $(id).addEventListener('keydown', (e) => {
      if (e.key !== 'Tab') return;
      const f = [...$(id).querySelectorAll('button:not([disabled]), input, textarea, select, a[href], [tabindex="0"]')].filter((x) => x.offsetParent !== null);
      if (!f.length) return;
      if (e.shiftKey && document.activeElement === f[0]) { e.preventDefault(); f.at(-1).focus(); }
      else if (!e.shiftKey && document.activeElement === f.at(-1)) { e.preventDefault(); f[0].focus(); }
    });
  }

  renderRouteControls();
  renderAll();
  reloadMeta().then(() => { renderAll(); initAccount({ beforeOpen: clearPhoneOverlays, closeSettings }); initLearned(); initAutopilot(); initSignatures(); }); // H2/H3, signatures: after meta (askeden.com or the Mac)
  initTour(); // I1: practice mode's tour, or the welcome on a first visit
  initHelp({ runCommand: (t) => commands().find((x) => x.t === t)?.run(), hasCommand: (t) => commands().some((x) => x.t === t), openSettings, openPalette, startTour, beforeOpen: clearPhoneOverlays });
  addEventListener('eden:open-settings', (e) => openSettings((e.detail && e.detail.tab) || 0)); // autopilot.js
  addEventListener('eden:acting', () => { renderSidebar(); checkJarvis().then(() => renderComposer()); }); // account.js: acting for someone began or ended under the page
  addEventListener('eden:open-inspector', (e) => openInspector((e.detail && e.detail.tab) || 'Route'));
  loadProjects().then(() => renderSidebar());
  initBrowserPane({ openSpace });
  checkJarvis().then(() => { renderComposer(); browserJarvisChanged(); if (curTab === 'Memory') renderMemoryTab(true); });
  // A Jarvis call waiting on the owner's "Let Eden use Jarvis?" card (api.js): say so instead of spinning.
  addEventListener('eden:jarvis-approval', (e) => {
    const w = !!(e.detail && e.detail.waiting);
    $('jarvisState').classList.toggle('wait', w);
    $('jarvisState').title = w ? 'Jarvis is asking “Let Eden use Jarvis?” on your Mac' : state.jarvis.available ? 'Connected through the Jarvis app on your Mac: second brain, memory, calendar' : (state.jarvis.reason || 'The Jarvis app on your Mac isn’t reachable');
    $('jarvisStateText').textContent = w ? 'approve Eden on your Mac' : state.jarvis.available ? 'connected' : 'not connected';
  });
  if (isMock) document.title = 'Eden (mock)';
  focusComposer();
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();

export { runChat, runCode, notify, shortModel };

// Scrollbars show only while scrolling (app.css .is-scrolling): on the element that scrolls, for a moment.
const scrollHide = new WeakMap();
document.addEventListener('scroll', (e) => {
  const box = e.target === document ? document.documentElement : e.target;
  if (!(box instanceof Element)) return;
  box.classList.add('is-scrolling');
  clearTimeout(scrollHide.get(box));
  scrollHide.set(box, setTimeout(() => box.classList.remove('is-scrolling'), 900));
}, { capture: true, passive: true });
