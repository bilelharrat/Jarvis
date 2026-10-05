'use strict';

// Everything from the server is rendered with textContent: replies, note titles, email
// subjects and tool output are data and must never become markup.

const $ = (id) => document.getElementById(id);
const token = new URLSearchParams(location.search).get('token') || '';
const app = window.jarvisApp || null;
if (app) document.body.classList.add('in-app');

// Split view's right pane (features/code-split.js): this window again, in a frame of the main
// one (?pane=code), showing one Jarvis Code session. What a window does for the hub (the
// built-in browser, PDFs, location, page checks, notifications, the second brain) stays the
// main window's: the pane drops the hub's asks for it and never answers one, and what's risky
// is checked by the main window (its Touch ID).
const inSplitPane = window.parent !== window && new URLSearchParams(location.search).get('pane') === 'code';
if (inSplitPane) document.body.classList.add('jc-split-pane');
const SPLIT_PANE_SKIPS = new Set([
  'browser_cmd', 'research_cmd', 'pdf_cmd', 'location_request', 'cv_page_check', 'dm_render', 'vp_capture',
  'code_voice_point', 'code_voice_file', 'show_session', 'ui', 'alert', 'desktop_hands', 'remote_code',
  'voice_typing', 'voice_typed', 'galaxy', 'galaxy_changed', 'sources', 'note', 'level',
]);
const SPLIT_PANE_QUIET = new Set([
  'capabilities', 'browser_result', 'research_result', 'pdf_result', 'location_fix', 'cv_page_result',
  'dm_render_result', 'vp_result', 'code_voice_pointed', 'code_voice_hand', 'galaxy',
]);

const STATE_LINES = {
  idle: 'Tap the orb or press ⌥ Space',
  listening: 'Listening…',
  transcribing: 'One moment…',
  thinking: 'Thinking…',
  speaking: 'Speaking · tap the orb to stop',
};

let ws = null;
let retry = 0;
let hubId = null;  // which backend this window last heard from (a restarted one numbers sessions from 1 again)
let state = 'idle';
let muted = false;
let prefs = null;
let activity = [];
let runningTools = 0;
let currentRid = '';
let sources = new Map();
let galaxyData = null;
let galaxyMode = 'off'; // off | ambient | open
let ambientTimer = null;
let selectedNote = null;
const galaxy = new window.Galaxy($('galaxy-canvas'));
galaxy.onSelect = (id) => { selectedNote = id; send({ type: 'note', id }); };

// ── socket ──

// Every event the hub sends is numbered (seq). Reconnecting, the window says the last it
// had, and from which backend: it gets the snapshot, then the session events it missed.
let lastSeq = 0;
// The window's one Jarvis Code store (code-store.js): every event goes in first, in order.
const codeStore = window.jarvisCodeStoreApi ? window.jarvisCodeStoreApi.createStore() : null;
function heard(ev) {
  if (inSplitPane && ev && SPLIT_PANE_SKIPS.has(ev.type)) return;  // the main window's
  if (ev && ev.type === 'hello') lastSeq = Number(ev.seq) || 0;
  else if (ev && ev.seq > lastSeq) lastSeq = ev.seq;
  if (codeStore) codeStore.take(ev);
  onEvent(ev);
  featureEvent(ev);
}

// A pane frame in bridge mode (?bridge=1, e.g. split view's second pane) opens no socket of
// its own: the window it's in hands it every event and sends what it sends
// (features/code-store.js), so both panes see one connection's events, in one order.
const bridged = new URLSearchParams(location.search).get('bridge') === '1' && window.parent !== window;
let bridgeOnline = false;

function connect() {
  if (bridged) {
    window.addEventListener('message', (e) => {
      if (e.source !== window.parent || e.origin !== location.origin || !e.data) return;
      if (e.data.jarvisBridge === 'event') heard(e.data.event);
      else if (e.data.jarvisBridge === 'online') { bridgeOnline = !!e.data.value; $('offline').hidden = bridgeOnline; }
    });
    window.parent.postMessage({ jarvisBridge: 'ready' }, location.origin);
    return;
  }
  const resume = hubId ? `&since=${lastSeq}&hub=${encodeURIComponent(hubId)}` : '';
  ws = new WebSocket(`ws://${location.host}/ws?token=${encodeURIComponent(token)}${resume}`);
  ws.onopen = () => { retry = 0; $('offline').hidden = true; };
  ws.onmessage = (e) => heard(JSON.parse(e.data));
  ws.onclose = (e) => {
    $('offline').hidden = false;
    if (e.code === 1009) notice('Jarvis', '', 'A message was too big for the connection and didn’t go.', 8000);
    setTimeout(connect, Math.min(5000, 500 * 2 ** retry++));
  };
}

// The window socket takes frames up to 64 MiB (server.serve): a message is kept well under.
const MAX_FRAME = 60 * 1024 * 1024;

// True once the message is on its way. False when there's no connection yet (a restart,
// the half second of a reconnect) or it's too big to send: the caller keeps the draft.
function send(msg) {
  if (inSplitPane && msg && SPLIT_PANE_QUIET.has(msg.type)) return true;  // the main window answers
  if (bridged) {
    if (!bridgeOnline) return false;
    window.parent.postMessage({ jarvisBridge: 'send', msg }, location.origin);
    return true;
  }
  if (!ws || ws.readyState !== WebSocket.OPEN) return false;
  const text = JSON.stringify(msg);
  // Length counts UTF-16 units; UTF-8 needs up to three bytes for one, so measure only then.
  if (text.length * 3 > MAX_FRAME && new Blob([text]).size > MAX_FRAME) return false;
  ws.send(text);
  return true;
}

// ── feature modules: web/features/*.js (loaded by features.js, after this file) ──
// They hear events, add Jarvis Code panes, menu items and composer @ suggestions, and add
// their own settings groups and dock buttons to the page, through window.jarvisFeatures.
const featureListeners = new Map();  // event type ('*': every event) -> handlers
const featureLast = new Map();  // the latest event of each type, for a listener added late
const featurePanes = new Map();  // Jarvis Code pane id -> { title, render(body, task) }
const featureMoreItems = [];  // Jarvis Code "More" menu items: { label, run, when?(task) }
const featureMentions = [];  // Jarvis Code composer: (query, textBefore) -> more @ suggestions
// Jarvis Code / commands: name -> { name, help, run?(arg, task), insert?, needsArg?, withoutSession? }
// (insert: text the palette puts in the composer, a snippet; run: the command itself).
const featureSlash = new Map();
const featureSessionOptions = [];  // () => fields a new session's task_new carries ({ isolated })
function featureSessionFields() {
  const fields = {};
  for (const fn of featureSessionOptions) {
    try { Object.assign(fields, fn() || {}); } catch (err) { console.error('feature session option', err); }
  }
  return fields;
}
const featureEntries = new Map();  // transcript entry role -> render(entry): an <li>, or null for none
// An approval drawn by a feature: view(approval, 'sheet' | 'card', answer(choice, feedback)) gives
// its element (an <li> for a sheet), or null for the usual buttons.
const featureApprovalViews = [];
function featureApproval(a, where, answer) {
  for (const view of featureApprovalViews) {
    try { const node = view(a, where, answer); if (node) return node; } catch (err) { console.error('feature approval view', err); }
  }
  return null;
}
// A feature's check before something risky goes ahead (Touch ID): check(kind, info) gives a
// Promise of true (go ahead) or false, or null to leave it to the usual way. Kinds: 'bypass'
// (a session into Bypass permissions; info.text is the usual question), 'bypass-default' (new
// sessions start in it), 'approve' (info: {approval, choice}).
const featureChecks = [];
function featureCheck(kind, info) {
  // Split view's pane: the main window checks (with its Touch ID), never this one on its own.
  if (inSplitPane) {
    try { return window.parent.jarvisFeatures.check(kind, info); } catch (err) { console.error('split pane check', err); }
  }
  for (const check of featureChecks) {
    try {
      const found = check(kind, info);
      if (found && typeof found.then === 'function') return found.then((ok) => ok === true, () => false);
    } catch (err) { console.error('feature check', err); }
  }
  return null;
}
// Bypass permissions, asked about first: a feature's check, or the usual question.
function confirmBypass(kind, text, then, otherwise) {
  const check = featureCheck(kind, { text });
  if (check) { check.then((ok) => { if (ok) then(); else if (otherwise) otherwise(); }); return; }
  if (confirm(tr(text))) then(); else if (otherwise) otherwise();
}
const featureDecorators = [];  // (entry, li) -> add to a transcript entry as it's drawn (pictures)
let featureRichText = null;  // (text) -> an element: a feature's fuller Markdown for Claude's words
const featureTabs = [];  // (element, tab) -> what a feature adds to each of the dock's tabs (browser.js)
let featureBookmarks = null;  // (list, bookmarks, query): a feature draws the library's Bookmarks tab (browser.js: folders)
function featureEvent(ev) {
  if (!ev || typeof ev.type !== 'string') return;
  featureLast.set(ev.type, ev);
  for (const fn of [...(featureListeners.get(ev.type) || []), ...(featureListeners.get('*') || [])]) {
    try { fn(ev); } catch (err) { console.error('feature event', ev.type, err); }
  }
}
window.jarvisFeatures = {
  on(type, fn, { replay = false } = {}) {
    if (!featureListeners.has(type)) featureListeners.set(type, []);
    featureListeners.get(type).push(fn);
    if (replay && featureLast.has(type)) {
      try { fn(featureLast.get(type)); } catch (err) { console.error('feature event', type, err); }
    }
  },
  send: (msg) => send(msg),
  store: codeStore,  // the one Jarvis Code store (code-store.js), fed by this window's socket
  t: (text) => (window.jarvisI18n ? window.jarvisI18n.t(text) : String(text)),
  el: (tag, cls, text) => el(tag, cls, text),
  $: (id) => $(id),
  registerPane(id, pane) { featurePanes.set(id, pane); PANE_TITLES[id] = pane.title || id; },
  openPane: (id) => openPane(id),
  registerMoreItem(item) { featureMoreItems.push(item); },
  registerMentions(suggest) { featureMentions.push(suggest); },
  registerSessionOption(fn) { featureSessionOptions.push(fn); },
  registerEntry(role, render) { featureEntries.set(role, render); },
  registerApprovalView(view) { featureApprovalViews.push(view); },
  registerCheck(check) { featureChecks.push(check); },
  answerApproval: (a, choice, feedback) => answerApproval(a, choice, feedback, true),  // as its card's button: checks first
  registerEntryDecorator(fn) { featureDecorators.push(fn); },
  registerRichText(render) { featureRichText = render; },
  currentTask: () => currentTask(),
  selectTask: (id) => { if ($('cc').hidden) toggleCC(true); selectTask(id); },
  registerSlash(command) { featureSlash.set(String(command.name).toLowerCase(), command); },
  registerTab(fn) { featureTabs.push(fn); if (browserState.tabs) { tabsShown = ''; renderTabs(browserState.tabs); } },
  registerBookmarks(render) { featureBookmarks = render; },
  unregisterSlash(name) { featureSlash.delete(String(name).toLowerCase()); },
  // Split view (features/code-split.js): whether this window is its right pane; the split
  // while it shows (see jcSplit), or null; the window's own pane, whatever has the focus; and
  // what the pane asks of the window it's in (its checks, its folder picker).
  splitPane: inSplitPane,
  registerSplit(view) { jcSplit = view || null; renderProjects(deckProjects); },
  selectHere: (id) => selectTask(id, true),
  check: (kind, info) => featureCheck(kind, info),
  pickFolder: (question) => pickFolderPath(question),
};

function onEvent(ev) {
  if (onJarvisCodeEvent(ev)) return;
  switch (ev.type) {
    case 'hello': {
      let reselect = null;
      if (hubId !== null && ev.hub_id !== hubId) {
        // A different backend: its session 1 isn't ours. Nothing of the old one stays, but
        // the chat that was open is opened again when it came back (a restart keeps its
        // id; matched by its Claude session, never just the number).
        const was = ccTasks.find((t) => t.id === ccSelected);
        reselect = was && was.session_id ? was.session_id : null;
        ccSelected = null;
        $('deck-timeline').replaceChildren();
        live.text = null;
        live.thinking = null;
        sources = new Map();
        foundFiles.clear();
      }
      hubId = ev.hub_id || null;
      setState(ev.state);
      setMuted(ev.muted);
      renderStatus(ev.status || {});
      activity = ev.activity || [];
      renderActivity();
      renderTasks(ev.tasks || []);
      renderCC(ev.tasks || []);
      renderPrefs(ev.prefs);
      renderBrain(ev.brain || {});
      // What the hub says is waiting replaces what the window had: one answered while the
      // window was away goes, one raised meanwhile gets its sheet and its number keys.
      $('cards').querySelectorAll('.needs-ok').forEach((n) => n.remove());
      pendingApprovals.clear();
      for (const id of approvalSeen.keys()) if (!(ev.approvals || []).some((a) => a.id === id)) approvalSeen.delete(id);
      (ev.approvals || []).forEach((a) => { approvalShown(a.id); showApproval(a); pendingApprovals.set(a.id, a); });
      renderInlineApprovals();
      if (ccSelected) {
        // What it missed: the hub sends it after this (replay) when it kept it all.
        if (!ev.replay) send({ type: 'task_transcript', id: ccSelected });
        send({ type: 'task_context', id: ccSelected });
      }
      if (reselect) { const again = ccTasks.find((t) => t.session_id === reselect); if (again) selectTask(again.id); }
      if (ev.turn && ev.turn.user) { currentRid = ev.turn.rid; showHeard(ev.turn.user); $('reply').textContent = ev.turn.reply || ''; }
      send({ type: 'galaxy' });
      if (!$('cc').hidden) { send({ type: 'claude_projects' }); send({ type: 'claude_history' }); if (deckProject) send({ type: 'claude_sessions', directory: deckProject }); }
      send({ type: 'connectors' });
      if (app) send({ type: 'capabilities', browser: !!app.browser, research: !!app.browser });
      history = ev.history || [];
      renderHistory();
      if (ev.vitals) renderVitals(ev.vitals);
      if (ev.usage) renderUsage(ev.usage);
      renderWeather(ev.weather);
      renderMarkets(ev.markets);
      $('v-accounts').textContent = (ev.accounts || []).length;
      $('v-model').textContent = ev.model_name || '–';
      renderMemory(ev.memory || []);
      if (ev.hearing) renderHearing(ev.hearing);
      if (ev.documents) renderDocuments(ev.documents);
      if (ev.interrupt_learning) renderInterruptLearning(ev.interrupt_learning);
      (ev.videos || []).filter((j) => !VIDEO_DONE.includes(j.state)).forEach(onVideo);  // still going
      if (ev.providers) onProviders(ev.providers);
      if (ev.goals) renderGoals(ev.goals);
      if (ev.delegations) renderDelegations(ev.delegations);
      if (ev.purchases) renderPurchases(ev.purchases);
      if (ev.file_index) renderFileIndex(ev.file_index);
      renderRoutines(ev.routines || []);
      if (ev.line) renderLine(ev.line);
      if (ev.remote) renderRemote(ev.remote);
      onMeeting(ev.meeting || { active: false });
      onVoiceCode(ev.voicecode);
      break;
    }
    case 'memory': renderMemory(ev.items || []); break;
    case 'hearing': renderHearing(ev); break;
    case 'documents': renderDocuments(ev.items || []); break;
    case 'interrupt_learning': renderInterruptLearning(ev.items || []); break;
    case 'suggestion': onSuggestion(ev); break;
    case 'video': onVideo(ev.job); break;
    case 'video_summary': onVideoSummary(ev); break;
    case 'goals': renderGoals(ev); break;
    case 'delegations': renderDelegations(ev.items || []); break;
    case 'purchases': renderPurchases(ev); break;
    case 'files_status': renderFileIndex(ev); break;
    case 'routines': renderRoutines(ev.items || []); break;
    case 'line': renderLine(ev); break;
    case 'remote': renderRemote(ev); break;
    case 'devices': send({ type: 'remote' }); break;
    case 'remote_code': showRemoteCode(ev); break;
    case 'meeting': onMeeting(ev); break;
    case 'voicecode': onVoiceCode(ev.focus); break;
    case 'show_session': awaitingNewSession = false; toggleCC(true); selectTask(ev.id); break;
    case 'caption': $('reply').textContent = ev.text; break;
    case 'shortcuts': renderShortcuts(ev.names || [], ev.instant || []); break;
    case 'vitals': renderVitals(ev); break;
    case 'usage': renderUsage(ev); break;
    case 'sysmon': renderSysmon(ev); break;
    case 'weather': renderWeather(ev.weather); break;
    case 'markets': renderMarkets(ev); break;
    case 'history': history = ev.items || []; renderHistory(); break;
    case 'state': setState(ev.value); break;
    case 'level': document.documentElement.style.setProperty('--level', ev.value); break;
    case 'turn':
      currentRid = ev.rid;
      if (ev.user) { history.push({ role: 'user', text: ev.user, at: new Date().toISOString() }); history.push({ role: 'assistant', text: '', at: new Date().toISOString(), live: true }); renderHistory(); }
      showHeard(ev.user);
      $('reply').textContent = '';
      renderSources();
      renderFiles();
      break;
    case 'turn_done':
      history = history.filter((h) => !(h.live && !h.text));
      history.forEach((h) => { delete h.live; });
      renderHistory();
      if (galaxyMode === 'ambient') scheduleAmbientEnd();
      break;
    case 'heard': if (!ev.text && state !== 'listening') $('state-line').textContent = 'I didn’t catch that. Tap to try again.'; break;
    case 'voice_typing':  // "Jarvis, start typing": what's said is typed at the focus
      $('vt-indicator').hidden = !ev.on;
      document.body.classList.toggle('voice-typing', !!ev.on);
      $('state-line').textContent = ev.on ? 'Typing what you say · “stop typing” to finish' : (STATE_LINES[state] || '');
      break;
    case 'voice_typed':
      if (ev.text && !ev.action) $('heard').textContent = ev.text;
      break;
    case 'reply': {
      $('reply').textContent = ev.text;
      const last = history[history.length - 1];
      if (last && last.live) {
        last.text = ev.text;
        // Only the answer's own line changes: the rest of the list stays as it is.
        const li = $('history').lastElementChild;
        if (li && li.firstChild && li.firstChild.nodeType === Node.TEXT_NODE) {
          li.firstChild.nodeValue = ev.text || '…';
          if (!historyScroll) historyScroll = requestAnimationFrame(() => { historyScroll = 0; $('history').scrollTop = $('history').scrollHeight; });
        } else renderHistory();
      }
      break;
    }
    case 'sources': onSources(ev); break;
    case 'files': onFiles(ev); break;
    case 'tool': onTool(ev); break;
    case 'approval': approvalShown(ev.id); showApproval(ev); pendingApprovals.set(ev.id, ev); renderInlineApprovals(); break;
    case 'approval_resolved': {
      document.querySelectorAll(`[data-approval="${CSS.escape(ev.id)}"]`).forEach((n) => n.remove());
      pendingApprovals.delete(ev.id);
      approvalSeen.delete(ev.id);
      break;
    }
    case 'status': renderStatus(ev); break;
    case 'tasks': {
      const before = new Set(ccTasks.map((t) => t.id));
      const liveBefore = ccTasks.map((t) => t.session_id).filter(Boolean);
      renderTasks(ev.items);
      renderCC(ev.items);
      const fresh = ev.items.find((t) => t.kind === 'code' && !before.has(t.id));
      if (fresh && awaitingNewSession) { awaitingNewSession = false; selectTask(fresh.id); }
      // A session that left the list (pruned) belongs in the history: one the history
      // doesn't have yet (started since it was read) is fetched again.
      const liveNow = new Set(ccTasks.map((t) => t.session_id));
      const known = new Set(codeHistory.map((h) => h.session_id));
      if (!$('cc').hidden && liveBefore.some((s) => !liveNow.has(s) && !known.has(s))) send({ type: 'claude_history' });
      break;
    }
    case 'task_log': if (ev.id === ccSelected) appendEntry(ev.entry); break;
    case 'task_log_update': if (ev.id === ccSelected) updateEntry(ev); break;
    case 'project_git': if (ev.directory === deckProject) renderGit(ev); break;
    case 'task_transcript': if (ev.id === ccSelected) replayTranscript(ev.entries || []); break;
    case 'claude_projects': renderProjects(ev.items); break;
    case 'browser_cmd': runBrowserCommand(ev); break;
    case 'research_cmd': runResearchCmd(ev); break;
    case 'ui': applyUi(ev); break;
    case 'desktop_hands': onDesktopHands(ev); break;
    case 'phone_status': onPhoneStatus(ev); break;
    case 'ask_queue': renderAskQueue(ev.items || []); break;
    case 'task_bash': onBang(ev); break;
    case 'task_memory': onMemory(ev); break;
    case 'pdf_cmd': makePdf(ev); break;
    case 'saved': onSaved(ev); break;
    case 'location_request': sendLocation(); break;
    case 'location':
      if (!ev.location && ev.error && /off for J\.A\.R\.V\.I\.S/.test(ev.error) && !locationWarned) {
        locationWarned = true;
        const openBtn = el('button', 'btn primary', 'Open Location settings');
        openBtn.type = 'button';
        openBtn.addEventListener('click', () => send({ type: 'open_privacy', pane: 'location' }));
        notice('Location', 'Turn on location for J.A.R.V.I.S.', 'For local weather and live traffic: switch on J.A.R.V.I.S. under Location Services.', 0, openBtn);
      }
      break;
    case 'claude_sessions':
      if (ev.directory === deckProject) { pastSessions = ev.items; renderPast(); }
      mergeHistory(ev.items || []);
      break;
    case 'claude_history': codeHistory = sortedHistory(ev.items || []); renderProjects(deckProjects); break;
    case 'task_context': ccContext[ev.id] = ev; renderCC(ccTasks); if (ev.id === ccSelected) renderCtxPop(); break;
    case 'task_finished': onTaskFinished(ev); break;
    case 'muted': setMuted(ev.value); break;
    case 'prefs': renderPrefs(ev); break;
    case 'brain': renderBrain(ev); break;
    case 'galaxy': galaxyData = ev; galaxy.setData(ev); renderLegend(); break;
    case 'galaxy_changed': send({ type: 'galaxy' }); break;
    case 'note': showNote(ev); break;
    case 'toast': notice(ev.title, '', ev.text, 8000); break;
    case 'alert': onAlert(ev); break;
    case 'connectors': renderConnectors(ev); break;
    case 'connector_error': showAccountsError(ev.text); break;
    case 'tools_reloaded':
      if (ev.accounts && ev.accounts.length) notice('Tools & Accounts', 'Tools updated', `Connected: ${ev.accounts.join(', ')}`, 6000);
      break;
    case 'error': notice('Heads up', 'Something went wrong', ev.text, 10000); break;
    case 'notice': notice('Heads up', ev.title || '', ev.text || '', ev.ms || 10000); break;
  }
}

// ── orb & conversation ──

function setState(next) {
  state = next;
  document.body.dataset.state = next;
  if (next !== 'listening') document.documentElement.style.setProperty('--level', 0);
  let line = STATE_LINES[next] || '';
  const look = document.body.dataset.look;
  if (look === 'console') line = { idle: prefs && prefs.hands_free ? '● Listening for wake word…' : '● Ready', listening: '● Listening…', transcribing: '● Transcribing…', thinking: '● Thinking…', speaking: '● Speaking…' }[next] || line;
  if (next === 'thinking' && runningTools > 0) line = 'Working on it…';
  if (next === 'idle' && prefs && prefs.hands_free && (!look || look === 'orb')) line = 'Say “Jarvis”, or tap the orb';
  // (Only when it changed: every step of a turn asks again, and new words lay the page out.)
  setText($('state-line'), line);
  $('orb').setAttribute('aria-label', next === 'idle' ? 'Talk to Jarvis' : 'Stop');
}

function showHeard(text) {
  $('heard').textContent = text ? `“${text}”` : '';
}

function talkOrStop() {
  if (state === 'idle') send({ type: 'listen' });
  else send({ type: 'stop' });
}

// images: pictures dropped or pasted for it ({media_type, data, name}); with nothing typed
// they go with "Take a look at this."
function ask(text, images = []) {
  text = text.trim();
  if (!text && images.length) text = tr('Take a look at this.');
  return !text || send(images.length ? { type: 'ask', text, images } : { type: 'ask', text });
}

// What a request box sends: its words and the pictures waiting by it. false when it
// couldn't be sent (not connected): the words and the pictures stay for another try.
function askFromBox(input) {
  if (picsReading.size) { notice('Jarvis', '', 'Still reading the picture. Send it again in a moment.', 4000); return null; }
  const images = askPics.map((p) => ({ media_type: p.type, data: p.data, name: p.name }));
  if (!ask(input.value, images)) return false;
  input.value = '';
  if (images.length) setAskPics([]);
  return true;
}

$('orb').addEventListener('click', talkOrStop);
document.querySelectorAll('.chip').forEach((chip) => chip.addEventListener('click', () => {
  if (chip.dataset.action === 'briefing') send({ type: 'briefing' });
  else if (chip.dataset.ask) ask(chip.dataset.ask);
}));
$('ask-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const sent = askFromBox($('ask-input'));
  if (sent === false) notice('Jarvis', '', 'Not connected yet. Your question is still here: send it again in a moment.', 6000);
  if (sent) $('ask-input').blur();
});

// Controls that answer Space themselves: buttons, links, disclosure rows (every tool row in
// Jarvis Code is a <summary>), and focusable widgets such as the Markets panel and the
// browser dock's handle. Space on them is theirs, never the microphone.
const OWN_SPACE = 'button, a[href], summary, select, [role="button"], [role="separator"], [role="switch"], [role="radio"], [role="checkbox"], [role="tab"], [role="menuitem"], [role="menuitemcheckbox"], [role="menuitemradio"], [role="option"], [role="slider"], [tabindex]:not([tabindex="-1"])';

function spaceTalks(e) {
  const t = e.target;
  return e.code === 'Space' && !e.repeat && !e.defaultPrevented && !e.isComposing && !e.metaKey && !e.ctrlKey
    && !(t instanceof Element && (t.closest(OWN_SPACE) || t.closest('input, textarea, [contenteditable]:not([contenteditable="false"])') || (t instanceof HTMLElement && t.isContentEditable)))
    && !typingLost();
}

// A redraw that takes away the text field being typed in (a pane drawn again on a step)
// leaves the focus on the page, where the keys still being typed would talk (Space) or
// answer an approval (a digit). They're typing, not commands: they do nothing until the
// owner moves the focus themselves (a click, or Tab).
let typedIn = null;  // the text field the last key went to
document.addEventListener('keydown', (e) => {
  const t = e.target;
  if (t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement || t instanceof HTMLSelectElement || (t instanceof HTMLElement && t.isContentEditable)) typedIn = t;
  else if (t !== document.body) typedIn = null;
}, true);
document.addEventListener('mousedown', () => { typedIn = null; }, true);
function typingLost() { return !!typedIn && !typedIn.isConnected && document.activeElement === document.body; }

document.addEventListener('keydown', (e) => {
  // Anywhere text goes in (fields, the composer and other text boxes, a title being
  // renamed), Space is a space: never the microphone.
  const field = e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement;
  const typing = field || e.target instanceof HTMLTextAreaElement || (e.target instanceof HTMLElement && e.target.isContentEditable);
  if (e.key === 'Escape') {
    if (field) e.target.blur();
    if (!$('browser').hidden && !typing) toggleBrowser(false);
    else if (!$('cc').hidden) { if (!jcEscape(e)) toggleCC(false); }
    else if (!$('accounts').hidden) toggleAccounts(false);
    else if (!$('settings').hidden) toggleSettings(false);
    else if (galaxyMode === 'open') setGalaxyMode('off');
    else if (!$('activity').hidden) toggleDrawer(false);
    if (state !== 'idle') send({ type: 'stop' });
  } else if (!typing && galaxyMode !== 'open' && spaceTalks(e)) {
    e.preventDefault();
    talkOrStop();
  }
});

if (app) app.onSummon(() => { if (state === 'idle') send({ type: 'listen' }); });
// ⌥⇧Space: with Jarvis Code open on a session, what's in front goes to that session.
function whatsThisMessage() { return { type: 'whats_this', session: !$('cc').hidden && markedSession() ? markedSession() : 0 }; }
if (app && app.onWhatsThis) app.onWhatsThis(() => send(whatsThisMessage()));

// ── sources & the galaxy ──

function onSources(ev) {
  if (!ev.items || !ev.items.length) return;
  const list = sources.get(ev.rid) || [];
  for (const item of ev.items) if (!list.some((s) => s.id === item.id)) list.push(item);
  sources.set(ev.rid, list);
  forgetOldTurns(sources);
  if (ev.rid === currentRid) renderSources();
  // The galaxy flies to the note Jarvis is drawing on.
  if (galaxyData && galaxyData.nodes.length) {
    if (galaxyMode === 'off') setGalaxyMode('ambient');
    galaxy.highlight(list.map((s) => s.id));
    galaxy.flyTo(ev.items[0].id, galaxyMode === 'open' ? 0.9 : 1.2);
  }
}

// One entry per request: only the recent ones can still be shown, so the rest go.
const TURNS_KEPT = 50;
function forgetOldTurns(map) {
  while (map.size > TURNS_KEPT) map.delete(map.keys().next().value);
}

// Files the index found for a request: open one, or ⌥-click to show it in Finder.
const foundFiles = new Map();
function onFiles(ev) {
  if (!ev.items || !ev.items.length) return;
  foundFiles.set(ev.rid, ev.items);
  forgetOldTurns(foundFiles);
  if (ev.rid === currentRid) renderFiles();
}
function renderFiles() {
  const list = foundFiles.get(currentRid) || [];
  const box = $('found-files');
  box.hidden = list.length === 0;
  box.replaceChildren(el('span', 'label', 'From your files:'), ...list.slice(0, 6).map((f) => {
    const b = el('button', 'source file');
    b.type = 'button';
    b.title = `${f.where || f.path} (⌥-click: show in Finder)`;
    b.append(icon(f.kind === 'pdf' ? 'pdf' : 'doc', 14), mine(el('span', '', f.name.length > 40 ? `${f.name.slice(0, 39)}…` : f.name)));
    b.addEventListener('click', (e) => send({ type: 'found_file_open', path: f.path, reveal: e.altKey }));
    return b;
  }));
}

function renderSources() {
  const list = sources.get(currentRid) || [];
  const box = $('sources');
  box.hidden = list.length === 0;
  const label = el('span', 'label', 'From your second brain:');
  box.replaceChildren(label, ...list.slice(0, 5).map((s) => {
    const b = el('button', 'source');
    b.type = 'button';
    const dot = el('i');
    dot.style.background = window.GALAXY_SOURCES.colors[s.source] || '#9fb3c8';
    b.append(dot, document.createTextNode(s.title.length > 42 ? `${s.title.slice(0, 41)}…` : s.title));
    b.addEventListener('click', () => {
      setGalaxyMode('open');
      galaxy.flyTo(s.id);
      selectedNote = s.id;
      send({ type: 'note', id: s.id });
    });
    return b;
  }));
}

function setGalaxyMode(mode) {
  clearTimeout(ambientTimer);
  galaxyMode = mode;
  document.body.classList.toggle('galaxy-ambient', mode === 'ambient');
  document.body.classList.toggle('galaxy-open', mode === 'open');
  $('galaxy').hidden = mode !== 'open';
  galaxy.interactive = mode === 'open';
  retargetHands();
  if (mode === 'off') {
    galaxy.stop();
    galaxy.reset();
    $('note-panel').hidden = true;
  } else {
    if (!galaxyData) send({ type: 'galaxy' });
    galaxy.start();
  }
  if (mode === 'open') {
    renderLegend();
    setTimeout(() => $('galaxy-q').focus(), 50);
  }
}

function scheduleAmbientEnd() {
  clearTimeout(ambientTimer);
  ambientTimer = setTimeout(() => { if (galaxyMode === 'ambient' && state === 'idle') setGalaxyMode('off'); }, 9000);
}

function renderLegend() {
  const counts = galaxy.counts();
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  $('galaxy-count').textContent = total ? `${total} notes` : 'Nothing indexed yet. Add sources in Settings.';
  $('galaxy-legend').replaceChildren(...Object.entries(counts).map(([source, n]) => {
    const li = el('li');
    const dot = el('i');
    dot.style.background = window.GALAXY_SOURCES.colors[source];
    dot.style.color = window.GALAXY_SOURCES.colors[source];
    li.append(dot, document.createTextNode(`${window.GALAXY_SOURCES.names[source] || source} · ${n}`));
    return li;
  }));
}

function showNote(n) {
  if (n.id !== selectedNote) return;
  $('note-panel').hidden = false;
  $('note-meta').textContent = [window.GALAXY_SOURCES.names[n.source] || n.source, n.group].filter(Boolean).join(' · ');
  $('note-title').textContent = n.title;
  $('note-text').textContent = n.text.length > 900 ? `${n.text.slice(0, 900)}…` : n.text;
  $('note-open').hidden = n.source === 'bsh';
}

$('note-open').addEventListener('click', () => { if (selectedNote) send({ type: 'open_note', id: selectedNote }); });
$('brain-btn').addEventListener('click', () => setGalaxyMode(galaxyMode === 'open' ? 'off' : 'open'));
$('galaxy-close').addEventListener('click', () => setGalaxyMode('off'));

// ── hand control (hands.js loads MediaPipe only when you turn it on) ──
// The same hands drive the galaxy while it's open and the rest of the app otherwise.
let handsModule = null;
let handsOn = false;
let handHover = null;
let handPoint = { x: 0, y: 0 };
const LOOK_ORDER = ['orb', 'obsidian', 'console', 'glass'];
const HAND_HELP = {
  page: '✋ aim · pinch to open · pinch and move to scroll · swipe right for back · two-hand pinch to zoom · hold a fist to close',
  galaxy: '☝ point · pinch a star to open it · pinch and move to spin · two-hand pinch to zoom · open palm to reset · fist to close',
  app: '☝ point · pinch to press · pinch and move to scroll · wave to dismiss a notice (or change the look) · hold an open palm to talk · hold a fist to stop me',
  desktop: '✋ aim · pinch to click (twice: double click) · pinch and move to drag · thumb to middle finger: right click · two fingers up and move to scroll · hold a fist to pause, an open palm to resume',
};

// Hands steering the whole Mac: gestures go to the backend, which moves the real pointer;
// a small indicator stays on top of every app.
let deskTarget = null;
const handHud = (u) => window.jarvisApp && window.jarvisApp.handHud && window.jarvisApp.handHud(u);
function desktopTarget() {
  if (!deskTarget) {
    deskTarget = {
      ...handsModule.desktopMessages(send),
      status: (text) => handHud({ status: tr(text) }),
      paused: (on) => handHud({ paused: on }),
      feedback: (fb) => handHud(fb),
    };
  }
  return deskTarget;
}
let handsBlockedCard = null;
function onDesktopHands(ev) {
  if (ev.state === 'blocked' || ev.state === 'error') {
    handHud({ blocked: true, status: ev.text });
    if (ev.state === 'error') notice('Hand control', 'Can’t steer the Mac', ev.text, 15000);
    else if (!handsBlockedCard || !handsBlockedCard.isConnected) {
      // Not allowed under Accessibility: one click to the switch. (One card: moves already
      // on their way are refused too, each with its own "blocked".)
      const open = el('button', 'btn primary', 'Open Accessibility settings');
      open.type = 'button';
      open.addEventListener('click', () => send({ type: 'open_privacy', pane: 'accessibility' }));
      handsBlockedCard = notice('Hand control', 'Can’t steer the Mac', ev.text, 15000, open);
    }
    if (handsOn) stopHandControl();
  }
}

function clickableAt(x, y) {
  handPoint = { x, y };
  const hit = document.elementFromPoint(x, y);
  const target = hit && hit.closest('button, a[href], [role="button"], [role="switch"], [role="radio"], input, select, summary');
  return target && !target.disabled ? target : null;
}

function scrollableAt(x, y) {
  for (let node = document.elementFromPoint(x, y); node && node !== document.body; node = node.parentElement) {
    const style = getComputedStyle(node);
    if (/(auto|scroll)/.test(style.overflowY) && node.scrollHeight > node.clientHeight) return node;
  }
  return null;
}

const appTarget = {
  labels: {
    resetHold: 'Hold open palm to talk…', reset: 'Listening', closeHold: 'Hold fist to stop me…',
    drag: 'Scrolling', hover: 'Pinch to press', opened: 'Pressed',
  },
  pickAtClient: (x, y) => clickableAt(x, y),
  hoverAtClient(x, y) {
    const target = x === null ? null : clickableAt(x, y);
    if (handHover !== target) {
      if (handHover) handHover.classList.remove('hand-hover');
      if (target) target.classList.add('hand-hover');
      handHover = target;
    }
    return target;
  },
  select(target) { if (target.isConnected) target.click(); },
  reset() { if (state === 'idle') send({ type: 'listen' }); },
  drag(dx, dy) {
    handPoint = { x: handPoint.x + dx, y: handPoint.y + dy };
    const box = scrollableAt(handPoint.x, handPoint.y);
    if (box) box.scrollBy(0, -dy * 1.6); // like a touchscreen: pull up to read on
  },
  swipe(dir) {
    const notices = [...$('cards').querySelectorAll('.card:not(.needs-ok)')];
    if (notices.length) {
      notices[notices.length - 1].remove();
      syncDismissAll();
      return;
    }
    const i = LOOK_ORDER.indexOf(prefs.look || 'orb');
    setPrefs({ look: LOOK_ORDER[(i + dir + LOOK_ORDER.length) % LOOK_ORDER.length] });
  },
};

function handTarget() {
  if (prefs && prefs.desktop_hands && handsModule) return { target: desktopTarget(), close: () => {}, help: HAND_HELP.desktop };
  if (browserOpenNow) return { target: pageTarget, close: () => toggleBrowser(false), help: HAND_HELP.page };
  return galaxyMode === 'open'
    ? { target: galaxy, close: () => setGalaxyMode('off'), help: HAND_HELP.galaxy }
    : { target: appTarget, close: () => send({ type: 'stop' }), help: HAND_HELP.app };
}

function retargetHands() {
  if (!handsOn || !handsModule) return;
  const { target, close, help } = handTarget();
  handsModule.setTarget(target, close);
  $('hand-help').textContent = help;
}

function setHandButtons(on) {
  ['hand-btn', 'hands-pill', 'br-hands'].forEach((id) => $(id).setAttribute('aria-pressed', String(on)));
  $('bd-guide').hidden = !(on && browserOpenNow);
  if (browserOpenNow) requestAnimationFrame(syncBrowserBounds); // the guide strip changes the slot
}

async function startHandControl() {
  handsOn = true;
  setHandButtons(true);
  $('hand-panel').hidden = false;
  $('hand-status').textContent = 'Loading hand tracking…';
  try {
    handsModule = handsModule || (await import(`/static/hands.js?v=${Date.now()}`));
    const { target, close, help } = handTarget(); // now that the Mac's target can be made
    $('hand-help').textContent = help;
    if (target.kind === 'desktop' && window.jarvisApp && window.jarvisApp.desktopHands) window.jarvisApp.desktopHands(true);
    await handsModule.startHands(target, {
      overlayCanvas: $('hand-overlay'),
      statusEl: $('hand-status'),
      cursorEl: $('hand-cursor'),
      close,
    });
  } catch (err) {
    $('hand-status').textContent = `Hand control couldn't start: ${err.message || err}`;
    handsOn = false;
    setHandButtons(false);
    if (window.jarvisApp && window.jarvisApp.desktopHands) window.jarvisApp.desktopHands(false);
  }
}

function stopHandControl() {
  handsOn = false;
  if (handsModule) handsModule.stopHands();
  if (window.jarvisApp && window.jarvisApp.desktopHands) window.jarvisApp.desktopHands(false);
  if (handHover) handHover.classList.remove('hand-hover');
  handHover = null;
  setHandButtons(false);
  $('hand-panel').hidden = true;
}

['hand-btn', 'hands-pill', 'br-hands'].forEach((id) => $(id).addEventListener('click', () => {
  if (handsOn) stopHandControl();
  else startHandControl();
}));
$('galaxy-search').addEventListener('submit', (e) => {
  e.preventDefault();
  const q = $('galaxy-q').value.trim().toLowerCase();
  if (!q || !galaxyData) return;
  const matches = galaxyData.nodes.filter((n) => n.title.toLowerCase().includes(q) || (n.group || '').toLowerCase().includes(q));
  galaxy.highlight(matches.slice(0, 30).map((n) => n.id));
  if (matches.length) {
    galaxy.flyTo(matches[0].id);
    selectedNote = matches[0].id;
    send({ type: 'note', id: matches[0].id });
  }
});
window.addEventListener('resize', () => galaxy.running && galaxy.resize());

// ── header & status ──

// The clock's formats. An Intl formatter is costly to make (toLocaleString with options
// makes one a call: three a second here), so each is made once and kept. But a formatter
// keeps the time zone it was made in, and the Mac's can change while the window is open (it
// sets its own after travel, say): they're made again when the language shown or the zone's
// offset changes, and at least once a minute, for a move to a zone with the same offset now
// but another summer time, which would part from it months later.
const CLOCK_FORMATS = {
  time: { hour: 'numeric', minute: '2-digit', second: '2-digit' },
  date: { month: 'long', day: 'numeric', year: 'numeric' },
  clock: { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' },
};
let clockFormats = null;  // { locale, offset, made, time, date, clock }

function tickClock() {
  const now = new Date();
  const locale = uiLocale();
  const offset = now.getTimezoneOffset();
  const kept = clockFormats;
  if (!kept || kept.locale !== locale || kept.offset !== offset || !(Math.abs(now - kept.made) < 60000)) {
    clockFormats = { locale, offset, made: now.getTime() };
    for (const [name, options] of Object.entries(CLOCK_FORMATS)) clockFormats[name] = new Intl.DateTimeFormat(locale, options);
  }
  // Each is written only when its words change: the header's clock and the greeting stay
  // the same for a minute or hours, and writing them every second laid the page out again.
  setText($('console-clock'), `${clockFormats.time.format(now)}  |  ${clockFormats.date.format(now)}`);
  setText($('clock'), clockFormats.clock.format(now));
  const h = now.getHours();
  setText($('greeting'), h < 5 ? 'Good evening.' : h < 12 ? 'Good morning.' : h < 18 ? 'Good afternoon.' : 'Good evening.');
}
tickClock();
setInterval(tickClock, 1000);

function renderStatus(status) {
  const b = status.battery;
  $('battery').textContent = b ? `${b.percent}%${b.plugged ? ' · charging' : ''}` : '';
  const next = status.next_event;
  if (next) {
    const when = new Date(next.begin);
    const today = new Date().toDateString() === when.toDateString();
    const time = when.toLocaleTimeString(uiLocale(), { hour: 'numeric', minute: '2-digit' });
    $('next-event').textContent = `Next: ${next.title}, ${today ? '' : 'tomorrow '}at ${time}`;
    $('next-event').hidden = false;
  } else {
    $('next-event').hidden = true;
  }
}

function setMuted(value) {
  muted = !!value;
  setSwitch('sw-voice', !muted);
}

// ── settings ──

function setSwitch(id, on) {
  $(id).setAttribute('aria-checked', String(!!on));
}

// The orb flanks itself with two columns: stats and weather on the left, markets and
// session on the right (Obsidian keeps the same two columns, as plain cards). The Command
// Center keeps all four on the left.
function placePanels(look) {
  const left = document.querySelector('.side.left');
  const right = document.querySelector('.side.right');
  const moved = [$('p-markets'), $('p-uptime')];
  if (look === 'orb') {
    left.prepend($('p-weather'), $('p-system'));  // weather on top, system stats under it
    right.prepend(...moved);
  } else {
    left.prepend($('p-system'), $('p-weather'));
    left.append(...moved);
  }
}
placePanels(document.body.dataset.look);

// Stark Glass and Obsidian are the Ambient Orb's elements in other materials: the orb's
// rules apply (data-look="orb"), and stark-glass.css or obsidian.css dresses them
// (data-skin). Glass comes at night or in white (data-tone="light"); "auto" follows the
// Mac's appearance as it changes. Obsidian always follows the Mac: graphite or porcelain.
const SKINS = ['glass', 'obsidian'];
const macLight = window.matchMedia('(prefers-color-scheme: light)');
function lookIsLight(skin, tone) {
  if (skin === 'obsidian') return macLight.matches;
  return skin === 'glass' && (tone === 'light' || (tone === 'auto' && macLight.matches));
}
function applyLook(look, tone = 'auto') {
  const skin = SKINS.includes(look) ? look : '';
  document.body.dataset.look = skin ? 'orb' : look;
  if (skin) document.body.dataset.skin = skin;
  else delete document.body.dataset.skin;
  if (lookIsLight(skin, tone)) document.body.dataset.tone = 'light';
  else delete document.body.dataset.tone;
}
macLight.addEventListener('change', () => { if (prefs) applyLook(prefs.look || 'orb', prefs.glass_tone); });
// The page arrives in the saved look (server.body_look): its tone too, before the socket
// opens, so a window never flashes the default look on its way to the chosen one.
applyLook(document.body.dataset.skin || document.body.dataset.look || 'orb', document.body.dataset.glassTone || 'dark');

function renderPrefs(p) {
  if (!p) return;
  prefs = p;
  applyLook(p.look || 'orb', p.glass_tone);
  placePanels(document.body.dataset.look);
  document.querySelectorAll('#look-group button').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.look === p.look)));
  $('tone-row').hidden = p.look !== 'glass';
  document.querySelectorAll('#tone-group button').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.tone === (p.glass_tone || 'auto'))));
  document.querySelectorAll('#lang-group button').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.lang === (p.language || 'en'))));
  if (window.jarvisI18n) window.jarvisI18n.setLang(p.language || 'en');
  if (document.activeElement !== $('weather-city')) $('weather-city').value = p.weather_city || '';
  const modelName = (p.models || []).find((m) => m.id === p.model);
  if (modelName) $('v-model').textContent = modelName.name;
  const persona = (p.personas || []).find((x) => x.id === p.persona);
  $('wordmark').textContent = persona ? persona.name.charAt(0) + persona.name.slice(1).toLowerCase() : 'Jarvis';
  const model = (p.models || []).find((m) => m.id === p.model);
  $('model-chip').textContent = model ? model.name : p.model;
  $('hf-indicator').hidden = !p.hands_free;
  // What to say or press, plus the What's-this key.
  $('hint').replaceChildren(...(p.hands_free
    ? [document.createTextNode('Say “Hey Jarvis” · '), el('kbd', '', '⌥ Space'), document.createTextNode(' talk · '), el('kbd', '', '⌥⇧ Space'), document.createTextNode(' what’s this?')]
    : [el('kbd', '', '⌥ Space'), document.createTextNode(' talk · '), el('kbd', '', '⌥⇧ Space'), document.createTextNode(' what’s this?')]));
  setSwitch('sw-effect', p.voice_effect);
  $('mic-select').value = p.mic || 'builtin';
  setSwitch('sw-location', p.use_location !== false);
  setSwitch('sw-handsfree', p.hands_free);
  setSwitch('sw-clap', p.clap_hands !== false);
  setSwitch('sw-desktop-hands', p.desktop_hands);
  setSwitch('sw-briefing', p.briefing_enabled);
  setSwitch('sw-proactive', p.proactive);
  setSwitch('sw-screen', p.screen_aware);
  setSwitch('sw-queue', p.queue_requests !== false);
  setSwitch('sw-code-queue', p.code_queue !== false);
  awake = p.code_keep_awake !== false;
  codeDefaults = { model: p.code_model || '', effort: p.code_effort || '', mode: p.code_mode || 'ask', ultracode: !!p.code_ultracode };
  renderComposer();
  if (!$('jc-settings').hidden) renderJcGeneral();
  $('screen-pill').hidden = !p.screen_aware;
  setSwitch('sw-control', p.control_always);
  setSwitch('sw-code-narrate', p.code_narrate);
  if (document.activeElement !== $('watchlist')) $('watchlist').value = (p.watchlist || []).join(' ');
  if (document.activeElement !== $('research-url')) $('research-url').value = p.research_url || '';
  if (document.activeElement !== $('invoice-from')) $('invoice-from').value = p.invoice_from || '';
  if (document.activeElement !== $('invoice-payment')) $('invoice-payment').value = p.invoice_payment || '';
  $('code-sentences').value = String(p.code_sentences || 3);
  setSwitch('sw-remote', p.remote_enabled);
  setSwitch('sw-proactive-voice', p.proactive_voice);
  const [qs, qe] = (p.quiet_hours || '22:00-07:00').split('-');
  if (document.activeElement !== $('quiet-start')) $('quiet-start').value = qs;
  if (document.activeElement !== $('quiet-end')) $('quiet-end').value = qe;
  setSwitch('sw-notes', p.brain_notes);
  setSwitch('sw-bsh', p.brain_bsh);
  setSwitch('sw-computer', p.brain_computer);
  setSwitch('sw-photos', p.brain_photos);
  setSwitch('sw-mail', p.brain_mail);
  setSwitch('sw-messages', p.brain_messages);
  $('model-select').replaceChildren(...(p.models || []).map((m) => {
    const o = el('option', '', m.name);
    o.value = m.id;
    o.selected = m.id === p.model;
    return o;
  }));
  $('persona-group').replaceChildren(...(p.personas || []).map((x) => {
    const b = el('button', '', x.name);
    b.type = 'button';
    b.setAttribute('role', 'radio');
    b.setAttribute('aria-checked', String(x.id === p.persona));
    b.addEventListener('click', () => setPrefs({ persona: x.id }));
    return b;
  }));
  $('humor').value = p.humor;
  $('humor-out').textContent = `${p.humor}%`;
  if (document.activeElement !== $('address')) $('address').value = p.address || '';
  if (document.activeElement !== $('owner-name')) $('owner-name').value = p.owner_name || '';
  document.querySelectorAll('#interrupt-group button').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.mode === (p.interruptions || 'urgent'))));
  if (document.activeElement !== $('vips')) $('vips').value = (p.vips || []).join(', ');
  setSwitch('sw-pay', p.pay_enabled !== false);
  setSwitch('sw-type-codes', p.type_codes !== false);
  $('pay-limits').classList.toggle('off', p.pay_enabled === false);
  for (const [id, key] of [['pay-purchase', 'pay_limit_purchase'], ['pay-transfer', 'pay_limit_transfer'], ['pay-day', 'pay_limit_day']]) {
    if (document.activeElement !== $(id) && p[key] !== undefined) $(id).value = String(p[key]);
  }
  if (p.pay_currency) $('pay-currency').value = p.pay_currency;
  setSwitch('sw-file-index', p.file_index !== false);
  setSwitch('sw-learn-speech', p.learn_speech !== false);
  setSwitch('sw-learn-interrupts', p.learn_interruptions !== false);
  setSwitch('sw-suggestions', p.suggestions !== false);
  if (document.activeElement !== $('documents-folder')) $('documents-folder').value = p.documents_folder || '';
  $('briefing-time').value = p.briefing_time;
  if (document.activeElement !== $('phone-from')) $('phone-from').value = p.phone_from || '';
  if (document.activeElement !== $('phone-me')) $('phone-me').value = p.phone_me || '';
  setSwitch('sw-wake-call', p.wake_call);
  setSwitch('sw-line-talk', p.line_talk !== false);
  if (document.activeElement !== $('line-about')) $('line-about').value = p.line_about || '';
  setSwitch('sw-line-booking', p.line_booking !== false);
  setSwitch('sw-line-autobook', !!p.line_autobook);
  $('line-minutes').value = String(p.line_minutes || 30);
  const [ls, le] = (p.line_hours || '09:00-17:00').split('-');
  if (document.activeElement !== $('line-start')) $('line-start').value = ls;
  if (document.activeElement !== $('line-end')) $('line-end').value = le;
  renderFallback();
  $('wake-call-time').value = p.wake_call_time || '07:00';
  $('folders').replaceChildren(...(p.brain_folders || []).map((f) => {
    const li = el('li');
    const name = el('span', '', f);
    name.title = f;
    const rm = el('button', 'btn', 'Remove');
    rm.type = 'button';
    rm.setAttribute('aria-label', `Remove ${f}`);
    rm.addEventListener('click', () => setPrefs({ brain_folders: prefs.brain_folders.filter((x) => x !== f) }));
    li.append(name, rm);
    return li;
  }));
  if (state === 'idle') setState('idle');
}

function renderBrain(b) {
  const counts = b.by_source || {};
  const parts = Object.entries(counts).map(([k, n]) => `${n} ${(window.GALAXY_SOURCES.names[k] || k).toLowerCase()}`);
  let text = b.notes ? `${b.notes} notes · ${parts.join(', ')}` : 'Empty so far.';
  if (b.state === 'building') text = b.detail || 'Building…';
  if (b.state === 'error') text = `Couldn't finish: ${b.detail}`;
  const errs = Object.entries(b.errors || {}).map(([k, v]) => `${k}: ${v}`);
  if (errs.length && b.state !== 'building') text += ` · Problems: ${errs.join('; ')}`;
  $('brain-status').textContent = text;
  $('fda-btn').hidden = !(b.errors && Object.values(b.errors).some(e => /Full Disk Access/.test(e || '')));
  $('brain-label').textContent = b.state === 'building' ? 'Second brain · updating' : b.notes ? `Second brain · ${b.notes}` : 'Second brain';
  $('brain-badge').textContent = b.state === 'building' ? '…' : b.notes ? (b.notes >= 1000 ? `${(b.notes / 1000).toFixed(b.notes >= 10000 ? 0 : 1)}k` : String(b.notes)) : '';
}

function setPrefs(changes) {
  send({ type: 'set_prefs', changes });
}

function toggleSettings(open) {
  $('settings').hidden = !open;
  if (open) { send({ type: 'shortcuts' }); send({ type: 'phone_status' }); send({ type: 'providers_list' }); }
  $('settings-btn').setAttribute('aria-expanded', String(open));
  // Settings always opens (and leaves) showing everything: a control it's asked to focus,
  // like the model menu from the model chip, is never filtered out.
  if ($('settings-search').value) { $('settings-search').value = ''; filterSettings(''); }
}

// ── search in Settings ──
// Each section's rows, notes and controls are kept or hidden as the query is typed: a row
// stays when every word of the query is in it, its section's title or the section's
// data-keywords (so "dark mode" finds Look, "twilio" the whole of Phone). A section with
// nothing left goes; the words found are highlighted (CSS custom highlights, so the text
// itself is never touched: translation and the controls' own updates carry on). The
// sections features add (window.jarvisFeatures) are searched too: they're read each time.
// Curly quotes are straightened so "can't" finds "can’t"; the text keeps its length, so
// a word's place in it is where to highlight.
function searchText(text) {
  return String(text || '').toLowerCase().replace(/[\u2018\u2019]/g, "'").replace(/[\u201c\u201d]/g, '"');
}

// Where a query word is found in a text: at the start of a word, so "phone" isn't found in
// "microphone" (Chinese has no spaces between words: there it's found anywhere).
function searchHits(text, word) {
  const out = [];
  const anywhere = /[^\x00-\x7f]/.test(word[0]);
  for (let at = text.indexOf(word); at !== -1; at = text.indexOf(word, at + word.length)) {
    if (anywhere || at === 0 || !/[a-z0-9]/.test(text[at - 1])) out.push(at);
  }
  return out;
}

// A section's parts as searched: its direct children, except a wrapper of rows (Phone's
// caller options), whose rows are searched one by one.
function settingsItems(group) {
  const out = [];
  for (const child of group.children) {
    if (child.tagName === 'H3') continue;
    if (child.tagName === 'DIV' && !child.matches('.row, .segmented, .limits, .folder-form') && child.querySelector(':scope > .row')) {
      for (const inner of child.children) out.push({ el: inner, parent: child });
    } else out.push({ el: child, parent: null });
  }
  return out;
}

function settingsHighlight(roots, words) {
  if (!window.CSS || !CSS.highlights || typeof Highlight === 'undefined') return;
  if (!words.length) { CSS.highlights.delete('settings-hit'); return; }
  const ranges = [];
  for (const root of roots) {
    const walk = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode: (n) => (n.parentElement && n.parentElement.closest('select, option, script, style') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
    });
    for (let node = walk.nextNode(); node; node = walk.nextNode()) {
      const text = searchText(node.data);
      for (const w of words) {
        for (const at of searchHits(text, w)) {
          const r = new Range();
          r.setStart(node, at);
          r.setEnd(node, at + w.length);
          ranges.push(r);
        }
      }
    }
  }
  CSS.highlights.set('settings-hit', new Highlight(...ranges));
}

function filterSettings(query) {
  const words = searchText(query).split(/\s+/).filter(Boolean);
  const sheet = $('settings');
  sheet.classList.toggle('searching', words.length > 0);
  for (const el of sheet.querySelectorAll('.search-out, .search-lead')) el.classList.remove('search-out', 'search-lead');
  const shown = [];
  let groups = 0;
  for (const group of sheet.querySelectorAll(':scope > section.group')) {
    if (!words.length) continue;
    const h3 = group.querySelector(':scope > h3');
    const context = searchText(`${h3 ? h3.textContent : ''} ${group.dataset.keywords || ''}`);
    let lead = null;
    const kept = new Set();
    for (const { el, parent } of settingsItems(group)) {
      const text = `${context} ${searchText(el.textContent)} ${searchText(el.dataset.keywords)}`;
      if (!words.every((w) => searchHits(text, w).length)) { el.classList.add('search-out'); continue; }
      if (parent) kept.add(parent);
      if (!lead && !el.hidden && !(parent && parent.hidden)) lead = parent || el;
      shown.push(el);
    }
    // A wrapper with none of its rows left goes too.
    for (const { parent } of settingsItems(group)) if (parent && !kept.has(parent)) parent.classList.add('search-out');
    if (!lead) { group.classList.add('search-out'); continue; }
    lead.classList.add('search-lead');
    if (h3) shown.push(h3);
    groups++;
  }
  $('settings-no-match').hidden = !words.length || groups > 0;
  settingsHighlight(shown, words);
}

$('settings-search').addEventListener('input', (e) => { filterSettings(e.target.value); $('settings').scrollTop = 0; });
$('settings-search').addEventListener('keydown', (e) => {
  // Esc clears the search first; with nothing typed it's Esc as anywhere else (Settings closes).
  if (e.key === 'Escape' && e.target.value) {
    e.preventDefault();
    e.stopPropagation();
    e.target.value = '';
    filterSettings('');
  } else if (e.key === 'Enter') {
    // Enter goes to the first setting found.
    e.preventDefault();
    const first = $('settings').querySelector(':scope > section.group:not(.search-out) :is(.row, .segmented, .folder-form, .limits, details):not(.search-out) :is(button, select, input, textarea, summary):not([hidden])');
    if (first) first.focus();
  }
});
// ⌘F finds in Settings while it's open (Jarvis Code and the browser keep theirs).
document.addEventListener('keydown', (e) => {
  if ($('settings').hidden || !$('cc').hidden || !e.metaKey || e.shiftKey || e.altKey || e.ctrlKey || e.key.toLowerCase() !== 'f') return;
  if (browserOpenNow && !$('settings').contains(document.activeElement)) return;
  e.preventDefault();
  e.stopPropagation();
  $('settings').scrollTop = 0;
  $('settings-search').focus();
  $('settings-search').select();
});

$('settings-btn').addEventListener('click', () => toggleSettings($('settings').hidden));
$('settings-close').addEventListener('click', () => toggleSettings(false));
$('model-chip').addEventListener('click', () => { toggleSettings(true); $('model-select').focus(); });
$('sw-voice').addEventListener('click', () => send({ type: 'mute', value: !muted }));
$('sw-effect').addEventListener('click', () => setPrefs({ voice_effect: !prefs.voice_effect }));
$('mic-select').addEventListener('change', (e) => setPrefs({ mic: e.target.value }));
$('sw-location').addEventListener('click', () => setPrefs({ use_location: prefs.use_location === false }));
$('sw-handsfree').addEventListener('click', () => setPrefs({ hands_free: !prefs.hands_free }));
$('sw-clap').addEventListener('click', () => setPrefs({ clap_hands: prefs.clap_hands === false }));
$('sw-desktop-hands').addEventListener('click', () => {
  const on = !prefs.desktop_hands;
  setPrefs({ desktop_hands: on });
  prefs.desktop_hands = on; // retarget now, not on the round trip
  if (handsOn) {
    retargetHands();
    if (window.jarvisApp && window.jarvisApp.desktopHands) window.jarvisApp.desktopHands(on);
  }
});
$('sw-briefing').addEventListener('click', () => setPrefs({ briefing_enabled: !prefs.briefing_enabled }));
$('sw-proactive').addEventListener('click', () => setPrefs({ proactive: !prefs.proactive }));
$('sw-screen').addEventListener('click', () => setPrefs({ screen_aware: !prefs.screen_aware }));
$('sw-queue').addEventListener('click', () => setPrefs({ queue_requests: prefs.queue_requests === false }));
$('sw-code-queue').addEventListener('click', () => setPrefs({ code_queue: prefs.code_queue === false }));
$('screen-pill').addEventListener('click', () => setPrefs({ screen_aware: false }));
$('sw-control').addEventListener('click', () => setPrefs({ control_always: !prefs.control_always }));
$('sw-code-narrate').addEventListener('click', () => setPrefs({ code_narrate: !prefs.code_narrate }));
$('code-sentences').addEventListener('change', (e) => setPrefs({ code_sentences: Number(e.target.value) }));
$('sw-remote').addEventListener('click', () => setPrefs({ remote_enabled: !prefs.remote_enabled }));
$('remote-pair').addEventListener('click', () => send({ type: 'remote_pair' }));
$('sw-proactive-voice').addEventListener('click', () => setPrefs({ proactive_voice: !prefs.proactive_voice }));
['quiet-start', 'quiet-end'].forEach((id) => $(id).addEventListener('change', () => {
  if ($('quiet-start').value && $('quiet-end').value) setPrefs({ quiet_hours: `${$('quiet-start').value}-${$('quiet-end').value}` });
}));
$('sw-notes').addEventListener('click', () => setPrefs({ brain_notes: !prefs.brain_notes }));
$('sw-bsh').addEventListener('click', () => setPrefs({ brain_bsh: !prefs.brain_bsh }));
for (const [id, key] of [['sw-computer', 'brain_computer'], ['sw-photos', 'brain_photos'], ['sw-mail', 'brain_mail'], ['sw-messages', 'brain_messages']]) {
  $(id).addEventListener('click', () => setPrefs({ [key]: !prefs[key] }));
}
$('fda-btn').addEventListener('click', () => send({ type: 'open_privacy', pane: 'full_disk' }));
$('model-select').addEventListener('change', (e) => setPrefs({ model: e.target.value }));
$('humor').addEventListener('input', (e) => { $('humor-out').textContent = `${e.target.value}%`; });
$('humor').addEventListener('change', (e) => setPrefs({ humor: Number(e.target.value) }));
$('address').addEventListener('change', (e) => setPrefs({ address: e.target.value }));
$('owner-name').addEventListener('change', (e) => setPrefs({ owner_name: e.target.value }));

// ── interruptions, purchases, the file index (Settings) ──
document.querySelectorAll('#interrupt-group button').forEach((b) => b.addEventListener('click', () => setPrefs({ interruptions: b.dataset.mode })));
$('vips').addEventListener('change', (e) => setPrefs({ vips: e.target.value.split(',').map((x) => x.trim()).filter(Boolean) }));
$('sw-learn-speech').addEventListener('click', () => setPrefs({ learn_speech: prefs.learn_speech === false }));
$('sw-learn-interrupts').addEventListener('click', () => setPrefs({ learn_interruptions: prefs.learn_interruptions === false }));
$('sw-suggestions').addEventListener('click', () => setPrefs({ suggestions: prefs.suggestions === false }));
$('documents-folder').addEventListener('change', (e) => setPrefs({ documents_folder: e.target.value.trim() }));
$('sw-pay').addEventListener('click', () => setPrefs({ pay_enabled: prefs.pay_enabled === false }));
$('sw-type-codes').addEventListener('click', () => setPrefs({ type_codes: prefs.type_codes === false }));
for (const [id, key] of [['pay-purchase', 'pay_limit_purchase'], ['pay-transfer', 'pay_limit_transfer'], ['pay-day', 'pay_limit_day']]) {
  $(id).addEventListener('change', (e) => { const n = Number(e.target.value); if (Number.isFinite(n) && n >= 0) setPrefs({ [key]: n }); });
}
$('pay-currency').addEventListener('change', (e) => setPrefs({ pay_currency: e.target.value }));
$('sw-file-index').addEventListener('click', () => setPrefs({ file_index: prefs.file_index === false }));
$('file-index-clear').addEventListener('click', () => { if (confirm(tr('Forget everything in the file index? It builds again the next time it runs.'))) send({ type: 'files_clear' }); });

function renderPurchases(t) {
  if (!t) return;
  const money = (n) => (n == null ? '–' : `${n.toLocaleString(uiLocale(), { maximumFractionDigits: 2 })} ${t.currency}`);
  const parts = [el('span', '', `Spent today: ${money(t.spent_today)} of ${money(t.limit_day)}`)];
  if (t.log_damaged) parts.push(el('span', 'warn', 'The purchase log can’t be read, so buying is paused until it’s fixed.'));
  $('pay-status').replaceChildren(...parts);
}

function renderFileIndex(st) {
  if (!st) return;
  const when = st.refreshed_at ? new Date(st.refreshed_at).toLocaleString(uiLocale(), { dateStyle: 'medium', timeStyle: 'short' }) : '';
  const count = (st.files || 0).toLocaleString(uiLocale());
  const line = st.state === 'running' ? `Indexing… ${count} files so far`
    : st.files ? (when ? `${count} files · updated ${when}` : `${count} files`) : 'Not indexed yet';
  const parts = [el('span', '', line)];
  if (st.pending) parts.push(el('span', '', `${st.pending.toLocaleString(uiLocale())} waiting for Spotlight`));
  const blocked = st.last && st.last.blocked;
  if (blocked && blocked.length) parts.push(el('span', 'warn', `Can’t read ${blocked.join(', ')}: allow folder access in System Settings › Privacy & Security.`));
  $('file-index-status').replaceChildren(...parts);
}

// ── goals and rules (goals.py), and conversations held for the user (delegate.py) ──
const HORIZON_NAMES = { week: 'This week', month: 'This month', quarter: 'This quarter', year: 'This year', someday: 'Someday' };
const RULE_KINDS = { time: 'Time', money: 'Money', health: 'Health', people: 'People', other: 'Other' };
let goalsState = { goals: [], constraints: [], review: false };

function renderGoals(g) {
  if (!g) return;
  goalsState = g;
  $('goals-unreadable').hidden = !g.unreadable;
  const active = (g.goals || []).filter((x) => x.status === 'active');
  $('goal-list').replaceChildren(...(active.length ? active.map((x) => {
    const li = el('li');
    const text = el('span', 'fact');
    text.append(mine(el('strong', '', x.text)), el('small', '', HORIZON_NAMES[x.horizon] || x.horizon));
    const done = el('button', 'btn', 'Done');
    done.type = 'button';
    done.addEventListener('click', () => send({ type: 'goal_update', id: x.id, status: 'done' }));
    const rm = el('button', 'btn', 'Remove');
    rm.type = 'button';
    rm.addEventListener('click', () => send({ type: 'goal_delete', id: x.id }));
    li.append(text, done, rm);
    return li;
  }) : [el('li', 'muted', 'No goals yet.')]));
  $('constraint-list').replaceChildren(...(g.constraints || []).map((c) => {
    const li = el('li');
    const text = el('span', 'fact');
    text.append(mine(el('strong', '', c.text)), el('small', '', RULE_KINDS[c.kind] || c.kind));
    const rm = el('button', 'btn', 'Remove');
    rm.type = 'button';
    rm.addEventListener('click', () => send({ type: 'constraint_delete', id: c.id }));
    li.append(text, rm);
    return li;
  }));
  setSwitch('sw-goal-review', !!g.review);
}
$('goal-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const text = $('goal-input').value.trim();
  if (text) send({ type: 'goal_add', text, horizon: $('goal-horizon').value });
  $('goal-input').value = '';
});
$('constraint-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const text = $('constraint-input').value.trim();
  if (text) send({ type: 'constraint_add', text, kind: $('constraint-kind').value });
  $('constraint-input').value = '';
});
$('sw-goal-review').addEventListener('click', () => send({ type: 'goal_review', on: !goalsState.review }));

const DELEGATION_STATUS = { active: 'In progress', waiting_owner: 'Needs you', done: 'Done', stopped: 'Stopped', expired: 'Timed out' };
function renderDelegations(items) {
  const list = $('delegation-list');
  if (!items || !items.length) { list.replaceChildren(el('li', 'muted', 'None yet.')); return; }
  list.replaceChildren(...items.slice(0, 20).map((d) => {
    const li = el('li', 'delegation');
    const text = el('span', 'fact');
    text.append(mine(el('strong', '', d.contact)), mine(el('span', 'goal', d.goal)),
      el('small', '', `${DELEGATION_STATUS[d.status] || d.status} · ${d.messages_sent} sent`));
    if (d.need_owner) text.append(mine(el('small', 'need', d.need_owner)));
    else if (d.summary) text.append(mine(el('small', '', d.summary)));
    li.append(text);
    if (['active', 'waiting_owner'].includes(d.status)) {
      if (d.status === 'waiting_owner') {
        const go = el('button', 'btn', 'Continue…');
        go.type = 'button';
        go.addEventListener('click', () => {
          const guidance = prompt(tr('What should Jarvis tell them, or do next?'));
          if (guidance !== null) send({ type: 'delegation_continue', id: d.id, guidance });
        });
        li.append(go);
      }
      const stop = el('button', 'btn', 'Stop');
      stop.type = 'button';
      stop.addEventListener('click', () => send({ type: 'delegation_stop', id: d.id }));
      li.append(stop);
    }
    return li;
  }));
}
$('briefing-time').addEventListener('change', (e) => setPrefs({ briefing_time: e.target.value }));

// Settings › Phone: the Auth Token goes one way, into the Keychain; the field empties at once.
$('phone-save').addEventListener('click', () => {
  const sid = $('phone-sid').value.trim(), token = $('phone-token').value.trim();
  if (!sid || !token) { $('phone-note').textContent = tr('Add both the Account SID and the Auth Token.'); return; }
  send({ type: 'phone_credentials', sid, token });
  $('phone-token').value = '';
  $('phone-note').textContent = tr('Saving…');
});
$('phone-forget').addEventListener('click', () => send({ type: 'phone_forget' }));
$('phone-test').addEventListener('click', () => { $('phone-note').textContent = tr('Calling…'); send({ type: 'phone_test' }); });
$('phone-caller-save').addEventListener('click', () => {
  $('phone-note').textContent = tr('Setting up the caller ID name…');
  send({ type: 'phone_caller_name', name: $('phone-caller-name').value.trim() });
});
// Settings › Phone › Answering: calls to the Twilio number, messages and bookings.
let lineOn = false;
$('sw-line').addEventListener('click', () => {
  $('line-note').textContent = tr(lineOn ? 'Turning answering off…' : 'Setting up answering on your Twilio account (about a minute)…');
  send({ type: 'line_set', on: !lineOn });
});
$('sw-line-talk').addEventListener('click', () => setPrefs({ line_talk: prefs.line_talk === false }));
$('line-about').addEventListener('change', (e) => setPrefs({ line_about: e.target.value }));
$('sw-line-booking').addEventListener('click', () => setPrefs({ line_booking: prefs.line_booking === false }));
$('sw-line-autobook').addEventListener('click', () => setPrefs({ line_autobook: !prefs.line_autobook }));
$('line-minutes').addEventListener('change', (e) => setPrefs({ line_minutes: Number(e.target.value) }));
for (const id of ['line-start', 'line-end']) {
  $(id).addEventListener('change', () => {
    if ($('line-start').value && $('line-end').value) setPrefs({ line_hours: `${$('line-start').value}-${$('line-end').value}` });
  });
}
$('phone-from').addEventListener('change', (e) => setPrefs({ phone_from: e.target.value }));
$('phone-me').addEventListener('change', (e) => setPrefs({ phone_me: e.target.value }));
$('sw-wake-call').addEventListener('click', () => setPrefs({ wake_call: !prefs.wake_call }));

// Settings › Brain › Fallback model: any added model (a Gemini key adds Gemini 2.5 Flash and
// Pro, and picks Flash when none is set).
function renderFallback() {
  if (!prefs) return;
  const info = (typeof providerInfo !== 'undefined' && providerInfo) || {};
  const added = (info.models || []).filter((m) => !m.builtin);
  const sel = $('fallback-select');
  // Automatic (the default) picks a Gemini model you've added, else any: named here when there is one.
  const auto = added.find((m) => m.ref === info.fallback_auto);
  const automatic = el('option', '', auto ? `${tr('Automatic')} · ${auto.name || auto.label || auto.model}` : tr('Automatic'));
  automatic.value = '';
  const off = el('option', '', tr('Off'));
  off.value = 'off';
  sel.replaceChildren(automatic, off, ...added.map((m) => { const o = el('option', '', m.name || m.label || m.model); o.value = m.ref; return o; }));
  sel.value = prefs.fallback_model === 'off' ? 'off' : added.some((m) => m.ref === prefs.fallback_model) ? prefs.fallback_model : '';
  setSwitch('sw-fallback-code', prefs.fallback_code !== false);
  setSwitch('sw-fallback-always', !!prefs.fallback_always);
  $('fallback-add').hidden = added.some((m) => /gemini/i.test(m.model || ''));
}
$('fallback-select').addEventListener('change', (e) => setPrefs({ fallback_model: e.target.value }));
$('sw-fallback-code').addEventListener('click', () => setPrefs({ fallback_code: prefs.fallback_code === false }));
$('sw-fallback-always').addEventListener('click', () => setPrefs({ fallback_always: !prefs.fallback_always }));
$('fallback-add').addEventListener('click', () => { toggleSettings(false); toggleCC(true); jcsKind = 'gemini'; openJcSettings('models'); });
$('wake-call-time').addEventListener('change', (e) => setPrefs({ wake_call_time: e.target.value }));
function onPhoneStatus(ev) {
  $('phone-signed').textContent = ev.signed_in ? tr('Signed in') + ` · ${ev.sid_hint}` : tr('Not set up yet');
  $('phone-forget').hidden = !ev.signed_in;
  if (ev.signed_in) $('phone-sid').value = '';
  $('phone-sid').placeholder = ev.signed_in ? ev.sid_hint : 'AC…';
  // A line each (the Contacts card, then Twilio), so each is translated on its own.
  if (ev.note !== undefined) $('phone-note').replaceChildren(...String(ev.note).split('\n').map((line) => el('div', '', line)));
}
$('brief-now').addEventListener('click', () => { toggleSettings(false); send({ type: 'briefing' }); });
$('rebuild').addEventListener('click', () => send({ type: 'brain_rebuild' }));
$('reset-btn').addEventListener('click', () => {
  send({ type: 'reset' });
  $('heard').textContent = '';
  $('reply').textContent = '';
  sources = new Map();
  renderSources();
  toggleSettings(false);
});

async function addFolder() {
  if (app && app.pickFolder) {
    const path = await app.pickFolder();
    if (path) setPrefs({ brain_folders: [...(prefs.brain_folders || []), path] });
  } else {
    $('folder-form').hidden = false;
    $('folder-path').focus();
  }
}
$('add-folder').addEventListener('click', addFolder);
$('folder-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const path = $('folder-path').value.trim();
  if (path) setPrefs({ brain_folders: [...(prefs.brain_folders || []), path] });
  $('folder-path').value = '';
  $('folder-form').hidden = true;
});

// ── tools & accounts ──

const AUTH_BADGE = { oauth: 'Sign in', token: 'Token', own_app: 'Your own app' };
const POLICY_NAMES = { ask: 'Ask before changes', allow: 'Allow everything', read_only: 'Read-only' };
const STATUS_NAMES = { connected: 'Connected', connecting: 'Connecting…', signing_in: 'Finish signing in in your browser', error: 'Problem', disconnected: 'Disconnected', off: 'Off' };
let openService = null;

function toggleAccounts(open) {
  $('accounts').hidden = !open;
  if (open) { toggleSettings(false); send({ type: 'connectors' }); }
}
$('accounts-close').addEventListener('click', () => toggleAccounts(false));
$('open-accounts').addEventListener('click', () => toggleAccounts(true));

function showAccountsError(text) {
  $('accounts-error').textContent = text;
  $('accounts-error').hidden = !text;
}

function link(href, text) {
  const a = el('a', '', text);
  a.href = href;
  a.target = '_blank';
  a.rel = 'noopener';
  return a;
}

function renderConnectors(data) {
  const conns = data.connections || [];
  $('connections-empty').hidden = conns.length > 0;
  $('connections').replaceChildren(...conns.map((c) => {
    const box = el('div', `conn ${c.status}`);
    const name = el('div', 'conn-name');
    name.append(el('span', 'conn-dot'), document.createTextNode(c.name));
    box.append(name, el('span', 'small-status', STATUS_NAMES[c.status] || c.status));
    const ro = c.tools.filter((t) => t.read_only).length;
    const meta = c.status === 'connected'
      ? `${c.tools.length} tools · ${ro} read-only${c.always_allow.length ? ` · always allowed: ${c.always_allow.join(', ')}` : ''}`
      : c.kind === 'stdio' ? c.command : c.url;
    box.append(el('div', 'conn-meta', meta));
    if (c.error) box.append(el('div', 'conn-error', c.error));
    const actions = el('div', 'conn-actions');
    if (c.status === 'signing_in' && c.sign_in_url) actions.append(link(c.sign_in_url, 'Open the sign-in page again'));
    const label = el('label', 'sr-only', `Permissions for ${c.name}`);
    const select = el('select');
    select.id = `policy-${c.id}`;
    label.htmlFor = select.id;
    for (const [id, text] of Object.entries(POLICY_NAMES)) {
      const o = el('option', '', text);
      o.value = id;
      o.selected = id === c.policy;
      select.append(o);
    }
    select.addEventListener('change', () => send({ type: 'connector_policy', id: c.id, policy: select.value }));
    const again = el('button', 'btn', c.status === 'connected' ? 'Reconnect' : 'Try again');
    again.type = 'button';
    again.addEventListener('click', () => send({ type: 'reconnect', id: c.id }));
    const remove = el('button', 'btn danger', 'Disconnect');
    remove.type = 'button';
    remove.addEventListener('click', () => send({ type: 'disconnect', id: c.id }));
    actions.append(label, select, again, remove);
    box.append(actions);
    return box;
  }));

  const byCat = new Map();
  for (const svc of data.catalog || []) {
    if (!byCat.has(svc.category)) byCat.set(svc.category, []);
    byCat.get(svc.category).push(svc);
  }
  const blocks = [];
  for (const [cat, list] of byCat) {
    blocks.push(el('div', 'catalog-cat', cat));
    const grid = el('div', 'catalog-grid');
    for (const svc of list) {
      const card = el('button', `svc${svc.connected ? ' done' : ''}`);
      card.type = 'button';
      const title = el('strong');
      title.append(document.createTextNode(svc.name), el('span', `badge ${svc.connected ? 'on' : svc.auth}`, svc.connected ? 'Connected' : AUTH_BADGE[svc.auth]));
      card.append(title, el('small', '', svc.blurb));
      card.disabled = svc.connected;
      card.addEventListener('click', () => { openService = openService === svc.id ? null : svc.id; renderConnectors(data); });
      grid.append(card);
      if (openService === svc.id && !svc.connected) grid.append(serviceForm(svc));
    }
    blocks.push(grid);
  }
  $('catalog').replaceChildren(...blocks);
}

function serviceForm(svc) {
  const form = el('form', 'svc-form');
  form.autocomplete = 'off';
  const fields = {};
  const field = (key, labelText, type) => {
    const id = `svc-${svc.id}-${key}`;
    const label = el('label', '', labelText);
    label.htmlFor = id;
    const input = el('input');
    input.id = id;
    input.type = type;
    input.autocomplete = 'off';
    fields[key] = input;
    form.append(label, input);
  };
  if (svc.auth === 'oauth') {
    form.append(el('p', '', `Jarvis opens ${svc.name}’s sign-in page in your browser. Approve access there and you’re done.`));
    if (svc.help) form.append(el('p', '', svc.help));  // a way round, when the sign-in can fail
    if (svc.help_url) form.append(link(svc.help_url, 'Setup guide'));
  } else if (svc.auth === 'token') {
    form.append(el('p', '', svc.help));
    if (svc.help_url) form.append(link(svc.help_url, `Create a ${svc.name} token`));
    field('token', `${svc.name} token`, 'password');
  } else {
    form.append(el('p', '', svc.help));
    if (svc.help_url) form.append(link(svc.help_url, 'Setup guide'));
    field('client_id', 'OAuth client ID', 'text');
    field('client_secret', 'OAuth client secret', 'password');
  }
  const go = el('button', 'btn primary', svc.auth === 'oauth' ? `Sign in to ${svc.name}` : `Connect ${svc.name}`);
  go.type = 'submit';
  form.append(go);
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    showAccountsError('');
    const msg = { type: 'connect', id: svc.id };
    for (const [k, input] of Object.entries(fields)) msg[k] = input.value;
    send(msg);
    openService = null;
  });
  return form;
}

$('custom-form').addEventListener('submit', (e) => {
  e.preventDefault();
  showAccountsError('');
  send({ type: 'add_custom', name: $('custom-name').value, target: $('custom-target').value, token: $('custom-token').value });
  $('custom-form').reset();
});

// ── the panels (and the Command Center's conversation) ──

let history = [];

function bar(id, pct) { $(id).style.width = `${Math.max(0, Math.min(100, pct))}%`; }

function renderVitals(v) {
  $('v-cpu').textContent = `${v.cpu}%`; bar('bar-cpu', v.cpu);
  $('v-mem').textContent = `${v.mem_used} / ${v.mem_total} GB`; bar('bar-mem', v.mem_pct);
  $('v-disk').textContent = `${v.disk_pct}%`; bar('bar-disk', v.disk_pct);
  if (v.battery) {
    $('v-batt').textContent = `${v.battery.percent}%${v.battery.plugged ? ' ⚡' : ''}`; bar('bar-batt', v.battery.percent);
  }
  const h = Math.floor(v.uptime / 3600), m = Math.floor((v.uptime % 3600) / 60), sec = v.uptime % 60;
  $('v-uptime').textContent = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
  $('v-commands').textContent = v.commands;
}

let lastWeather = null;  // what the card shows, for its pop-out

function renderWeather(w) {
  const chip = $('weather-chip');
  const card = $('p-weather');
  const ok = Boolean(w && !w.error);
  lastWeather = ok ? w : null;
  // With weather to show, the card opens the pop-out (a button, by mouse or keyboard).
  card.classList.toggle('wx-ready', ok);
  if (ok) {
    card.setAttribute('role', 'button');
    card.tabIndex = 0;
    card.setAttribute('aria-haspopup', 'dialog');
    card.setAttribute('aria-label', `Weather: ${w.temp}${w.unit}, ${w.summary}. Open details`);
  } else {
    for (const attr of ['role', 'tabindex', 'aria-haspopup', 'aria-label']) card.removeAttribute(attr);
  }
  if (!ok) {
    chip.hidden = true;
    $('weather-body').replaceChildren(el('p', 'muted', w && w.error ? w.error : 'Set your city in Settings to see the weather.'));
    closeWeather(false);
    return;
  }
  chip.hidden = false;
  chip.textContent = `${w.from_location ? '⌖ ' : ''}${w.temp}${w.unit}  ${w.city}`;
  const now = el('div', 'weather-now');
  const place = el('span');
  place.append(document.createTextNode(`${w.city}${w.region ? `, ${w.region}` : ''}`), el('br'), document.createTextNode(w.summary));
  now.append(el('b', '', `${w.temp}${w.unit}`), place);
  const grid = el('div', 'kv-grid');
  for (const [k, val] of [['Humidity', `${w.humidity}%`], ['Wind', `${w.wind} ${w.wind_unit}`], ['Feels like', `${w.feels}${w.unit}`]]) {
    const cell = el('div');
    cell.append(el('small', '', k), el('b', '', val));
    grid.append(cell);
  }
  $('weather-body').replaceChildren(now, grid);
  if (wxIsOpen()) renderWeatherPop(w);  // a refresh while it's open updates it in place
}

// ── the weather pop-out: the card, grown up (hours, the week, the details) ──

let wxReturnFocus = null;
let wxClosing = null;

function wxIsOpen() { return !$('wx-layer').hidden && !wxClosing; }
function wxCap(s) { return s ? s[0].toUpperCase() + s.slice(1) : ''; }

function wxIcon(code, day = true) {
  if (code === 0) return day ? '☀️' : '🌙';
  if (code === 1) return day ? '🌤️' : '🌙';
  if (code === 2) return day ? '⛅' : '☁️';
  if (code === 3) return '☁️';
  if (code === 45 || code === 48) return '🌫️';
  if (code >= 95) return '⛈️';
  if ((code >= 71 && code <= 77) || code === 85 || code === 86) return '🌨️';
  if ((code >= 51 && code <= 55) || (code >= 80 && code <= 82)) return day ? '🌦️' : '🌧️';
  if (code >= 56 && code <= 67) return '🌧️';
  return '☁️';
}

function wxGlyph(glyph, label) {
  const icon = el('span', 'wx-emoji', glyph);
  icon.setAttribute('role', 'img');
  icon.setAttribute('aria-label', wxCap(label || ''));
  return icon;
}
function wxEmoji(code, day, label) { return wxGlyph(wxIcon(code, day), label); }

// Sunrise and sunset as Apple draws them: half a sun on the horizon, an arrow up or down.
function wxSunIcon(kind) {
  const icon = wxGlyph('', kind);
  icon.classList.add('wx-sun');
  const arrow = kind === 'Sunrise' ? 'M12 10V2.5M9.6 4.9 12 2.5l2.4 2.4' : 'M12 2.5V10M9.6 7.6 12 10l2.4-2.4';
  icon.innerHTML = `<svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true"><path d="M5.5 19a6.5 6.5 0 0 1 13 0z" fill="#ffb340"/><path d="M3.6 12.4l1.5 1.5M20.4 12.4l-1.5 1.5M2 19h20M${arrow.slice(1)}" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
  return icon;
}

// A temperature's colour, as Apple's Weather paints its range bars: cold blue to hot red.
const WX_TEMP_STOPS = [[-10, [94, 92, 230]], [0, [64, 156, 255]], [8, [100, 210, 255]], [16, [48, 209, 88]], [23, [255, 214, 10]], [29, [255, 159, 10]], [36, [255, 69, 58]]];
function wxTempColor(t, unit) {
  const c = unit === '°F' ? ((t - 32) * 5) / 9 : t;
  let i = 0;
  while (i < WX_TEMP_STOPS.length - 1 && c > WX_TEMP_STOPS[i + 1][0]) i += 1;
  const [t0, a] = WX_TEMP_STOPS[i];
  const [t1, b] = WX_TEMP_STOPS[Math.min(i + 1, WX_TEMP_STOPS.length - 1)];
  const k = t1 === t0 ? 0 : Math.min(1, Math.max(0, (c - t0) / (t1 - t0)));
  return `rgb(${a.map((v, j) => Math.round(v + (b[j] - v) * k)).join(' ')})`;
}

function wxDot(fraction) {
  const dot = el('b');
  dot.style.left = `${Math.min(100, Math.max(0, fraction * 100))}%`;
  return dot;
}

function wxHourLabel(at) {
  return new Intl.DateTimeFormat(uiLocale(), { hour: 'numeric' }).format(new Date(at));
}

function wxHours(w) {
  const list = el('ol', 'wx-hours');
  list.tabIndex = 0;  // scrolls sideways with the arrow keys
  list.setAttribute('aria-label', 'Hourly forecast');
  const item = (cls, label, icon, rain, value) => {
    const li = el('li', `wx-hour ${cls}`.trim());
    const sky = el('span', 'wx-hour-sky');
    sky.append(icon);
    if (rain != null && rain >= 20) sky.append(el('small', 'wx-rain', `${rain}%`));
    li.append(el('small', 'wx-hour-time', label), sky, el('b', '', value));
    return li;
  };
  const d = w.details || {};
  list.append(item('now', 'Now', wxEmoji(w.code, d.is_day !== false, w.summary), null, `${w.temp}°`));
  const hours = w.hours || [];
  if (!hours.length) return list;
  // Sunrise and sunset fall between the hours, as in Apple's Weather.
  const first = w.observed || hours[0].at;
  const last = hours[hours.length - 1].at;
  const marks = [];
  for (const day of w.days || []) {
    for (const [kind, at] of [['Sunrise', day.sunrise], ['Sunset', day.sunset]]) {
      if (at && at > first && at < last) marks.push({ at, kind });
    }
  }
  const timeline = [...hours.map((h) => ({ at: h.at, hour: h })), ...marks].sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
  for (const entry of timeline) {
    if (entry.hour) {
      const h = entry.hour;
      list.append(item('', wxHourLabel(h.at), wxEmoji(h.code, h.is_day, h.summary), h.rain, h.temp == null ? '–' : `${h.temp}°`));
    } else {
      list.append(item('sun', clockText(entry.at), wxSunIcon(entry.kind), null, entry.kind));
    }
  }
  // A mouse wheel scrolls it sideways too (a trackpad already does).
  list.addEventListener('wheel', (e) => {
    if (Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return;
    const max = list.scrollWidth - list.clientWidth;
    if ((e.deltaY < 0 && list.scrollLeft <= 0) || (e.deltaY > 0 && list.scrollLeft >= max)) return;
    e.preventDefault();
    list.scrollLeft += e.deltaY;
  }, { passive: false });
  return list;
}

function wxDays(w) {
  const days = (w.days || []).filter((d) => d.high != null && d.low != null);
  if (!days.length) return null;
  const lo = Math.min(...days.map((d) => d.low));
  const hi = Math.max(...days.map((d) => d.high));
  const span = Math.max(1, hi - lo);
  const weekday = new Intl.DateTimeFormat(uiLocale(), { weekday: 'short' });
  const list = el('ol', 'wx-days');
  days.forEach((d, i) => {
    const row = el('li', 'wx-day');
    const sky = el('span', 'wx-day-sky');
    sky.append(wxEmoji(d.code, true, d.summary));
    if (d.rain != null && d.rain >= 20) sky.append(el('small', 'wx-rain', `${d.rain}%`));
    const range = el('span', 'wx-range');
    range.setAttribute('aria-hidden', 'true');
    const fill = el('i');
    fill.style.left = `${((d.low - lo) / span) * 100}%`;
    fill.style.right = `${((hi - d.high) / span) * 100}%`;
    fill.style.background = `linear-gradient(90deg, ${wxTempColor(d.low, w.unit)}, ${wxTempColor(d.high, w.unit)})`;
    range.append(fill);
    if (i === 0 && w.temp != null) range.append(wxDot((w.temp - lo) / span));  // where today is now
    const low = el('span', 'wx-lo', `${d.low}°`);
    low.setAttribute('aria-label', `Low ${d.low}°`);
    const high = el('span', 'wx-hi', `${d.high}°`);
    high.setAttribute('aria-label', `High ${d.high}°`);
    row.append(el('span', 'wx-day-name', i === 0 ? 'Today' : weekday.format(new Date(`${d.date}T12:00`))), sky, low, range, high);
    list.append(row);
  });
  return list;
}

function wxTile(label, value, unit, sub, ...extra) {
  const tile = el('div', 'wx-card wx-tile');
  const big = el('b', 'wx-value', value);
  if (unit) big.append(el('small', '', unit));
  tile.append(el('small', 'wx-label', label), big, ...extra);
  if (sub) tile.append(el('p', 'wx-sub', sub));
  return tile;
}

function wxTiles(w) {
  const d = w.details || {};
  const tiles = [];
  if (w.feels != null) {
    const gap = w.feels - w.temp;
    tiles.push(wxTile('Feels like', `${w.feels}°`, '', Math.abs(gap) <= 2 ? 'Similar to the actual temperature.' : gap < 0 ? 'Wind is making it feel cooler.' : 'Humidity is making it feel warmer.'));
  }
  if (d.uv != null) {
    const level = d.uv < 3 ? 'Low' : d.uv < 6 ? 'Moderate' : d.uv < 8 ? 'High' : d.uv < 11 ? 'Very high' : 'Extreme';
    const bar = el('span', 'wx-uvbar');
    bar.setAttribute('aria-hidden', 'true');
    bar.append(wxDot(d.uv / 11));
    tiles.push(wxTile('UV index', String(d.uv), '', w.uv_max != null ? `Peaks at ${w.uv_max} today.` : '', el('span', 'wx-level', level), bar));
  }
  if (w.wind != null) {
    const compass = el('span', 'wx-compass');
    compass.setAttribute('aria-hidden', 'true');
    for (const k of ['N', 'E', 'S', 'W']) compass.append(el('i', k.toLowerCase(), k));
    if (d.wind_deg != null) {
      const needle = el('b');
      needle.style.transform = `rotate(${d.wind_deg}deg)`;
      compass.append(needle);
    }
    const parts = [d.wind_dir ? `From the ${d.wind_dir}` : '', d.gusts != null ? `gusts ${d.gusts} ${w.wind_unit}` : ''].filter(Boolean);
    tiles.push(wxTile('Wind', String(w.wind), w.wind_unit, wxCap(parts.join(', ')) + (parts.length ? '.' : ''), compass));
  }
  if (w.humidity != null) {
    tiles.push(wxTile('Humidity', `${w.humidity}%`, '', w.humidity < 30 ? 'The air is dry.' : w.humidity < 60 ? 'Comfortable.' : 'It’s humid.'));
  }
  if (w.rain_chance != null) {
    const tomorrow = w.tomorrow && w.tomorrow.rain_chance != null ? `Tomorrow: ${w.tomorrow.rain_chance}%.` : '';
    tiles.push(wxTile('Chance of rain', `${w.rain_chance}%`, '', tomorrow || 'Today.'));
  }
  const today = (w.days || [])[0] || {};
  const tomorrow = (w.days || [])[1] || {};
  if (today.sunrise && today.sunset) {
    const now = w.observed || '';
    const [kind, at, other] = now < today.sunrise ? ['Sunrise', today.sunrise, `Sunset: ${clockText(today.sunset)}.`]
      : now < today.sunset ? ['Sunset', today.sunset, `Sunrise: ${clockText(today.sunrise)}.`]
        : ['Sunrise', tomorrow.sunrise || '', `Sunset: ${clockText(today.sunset)}.`];
    if (at) tiles.push(wxTile(kind, clockText(at), '', other));
  }
  if (d.visibility != null) {
    const km = d.visibility_unit === 'mi' ? d.visibility * 1.609 : d.visibility;
    const shown = d.visibility >= 10 ? Math.round(d.visibility) : d.visibility;
    tiles.push(wxTile('Visibility', String(shown), d.visibility_unit, km >= 16 ? 'Perfectly clear view.' : km >= 8 ? 'Clear view.' : km >= 3 ? 'Some haze.' : 'Poor visibility.'));
  }
  if (d.pressure != null) {
    const shown = d.pressure_unit === 'inHg' ? d.pressure.toFixed(2) : String(d.pressure);
    tiles.push(wxTile('Pressure', shown, d.pressure_unit, d.clouds != null ? `Cloud cover: ${d.clouds}%.` : ''));
  }
  return tiles;
}

function renderWeatherPop(w) {
  const body = $('wx-body');
  const oldHours = body.querySelector('.wx-hours');
  const keep = { top: $('wx-pop').scrollTop, left: oldHours ? oldHours.scrollLeft : 0 };

  const hero = el('div', 'wx-hero');
  const place = el('div', 'wx-place');
  place.append(el('span', 'wx-city', `${w.from_location ? '⌖ ' : ''}${w.city}`));
  if (w.region) place.append(el('span', 'wx-region', w.region));
  place.append(el('span', 'wx-sky', wxCap(w.summary)));
  if (w.high != null && w.low != null) place.append(el('span', 'wx-hl', `H:${w.high}°  L:${w.low}°`));
  hero.append(el('p', 'wx-temp', `${w.temp}${w.unit}`), place);

  const grid = el('div', 'wx-grid');
  const hourly = el('section', 'wx-card wx-hourly');
  hourly.append(el('small', 'wx-label', 'Hourly forecast'), wxHours(w));
  grid.append(hourly);
  const days = wxDays(w);
  const tiles = wxTiles(w);
  if (days) {
    const week = el('section', 'wx-card wx-week');
    week.append(el('small', 'wx-label', `${(w.days || []).length}-day forecast`), days);
    grid.append(week);
  }
  // Beside the week, the first four; the rest in a row under both.
  const side = el('div', 'wx-tiles');
  side.append(...tiles.slice(0, days ? 4 : tiles.length));
  grid.append(side);
  if (days && tiles.length > 4) {
    const row = el('div', 'wx-tiles wide');
    row.append(...tiles.slice(4));
    grid.append(row);
  }
  body.replaceChildren(hero, grid);
  $('wx-pop').scrollTop = keep.top;
  body.querySelector('.wx-hours').scrollLeft = keep.left;
}

// The pop-out grows from the card and shrinks back into it.
function wxFlight(pop) {
  const from = $('p-weather').getBoundingClientRect();
  const to = pop.getBoundingClientRect();
  if (!from.width || !to.width) return 'none';
  const dx = from.left + from.width / 2 - (to.left + to.width / 2);
  const dy = from.top + from.height / 2 - (to.top + to.height / 2);
  return `translate(${dx}px, ${dy}px) scale(${Math.max(0.2, from.width / to.width)})`;
}

function wxReduced() { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; }

function openWeather() {
  if (!lastWeather || wxIsOpen()) return;
  if (wxClosing) { wxClosing.cancel(); wxClosing = null; }
  wxReturnFocus = document.activeElement;
  renderWeatherPop(lastWeather);
  $('wx-layer').hidden = false;
  $('wx-pop').scrollTop = 0;
  const pop = $('wx-pop');
  $('wx-scrim').animate([{ opacity: 0 }, { opacity: 1 }], { duration: 280, easing: 'ease-out' });
  if (wxReduced()) {
    pop.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 160, easing: 'ease-out' });
  } else {
    pop.animate([
      { transform: wxFlight(pop), opacity: 0 },
      { opacity: 1, offset: 0.3 },
      { transform: 'none', opacity: 1 },
    ], { duration: 480, easing: 'cubic-bezier(0.32, 0.72, 0, 1)' });
  }
  $('wx-close').focus({ preventScroll: true });
}

function closeWeather(animate = true) {
  if ($('wx-layer').hidden || wxClosing) return;
  const pop = $('wx-pop');
  const done = () => {
    $('wx-layer').hidden = true;
    wxClosing = null;
    const back = wxReturnFocus;
    wxReturnFocus = null;
    if (back && document.contains(back) && typeof back.focus === 'function') back.focus({ preventScroll: true });
  };
  if (!animate) { done(); return; }
  const reduced = wxReduced();
  const frames = reduced
    ? [{ opacity: 1 }, { opacity: 0 }]
    : [{ transform: 'none', opacity: 1 }, { opacity: 1, offset: 0.55 }, { transform: wxFlight(pop), opacity: 0 }];
  const flight = pop.animate(frames, { duration: reduced ? 140 : 280, easing: 'cubic-bezier(0.4, 0, 0.9, 0.6)', fill: 'forwards' });
  const scrim = $('wx-scrim').animate([{ opacity: 1 }, { opacity: 0 }], { duration: reduced ? 140 : 260, easing: 'ease-in', fill: 'forwards' });
  wxClosing = { cancel() { flight.cancel(); scrim.cancel(); } };
  flight.onfinish = () => { flight.cancel(); scrim.cancel(); done(); };
}

$('p-weather').addEventListener('click', openWeather);
$('p-weather').addEventListener('keydown', (e) => {
  if (lastWeather && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); openWeather(); }
});
$('wx-close').addEventListener('click', () => closeWeather());
$('wx-scrim').addEventListener('click', () => closeWeather());
// Escape closes it, and only it: not also the window behind or Jarvis mid-sentence.
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && wxIsOpen()) { e.preventDefault(); e.stopPropagation(); closeWeather(); }
}, true);
// Tab stays inside while it's open.
$('wx-pop').addEventListener('keydown', (e) => {
  if (e.key !== 'Tab') return;
  const stops = [...$('wx-pop').querySelectorAll('button, [tabindex="0"]')];
  if (!stops.length) return;
  const first = stops[0];
  const last = stops[stops.length - 1];
  if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
});

// ── Claude usage: the Session card's cell, and everything else in its pop-out ──
let lastUsage = null;
let usageReturnFocus = null;
const usd = (n) => (n >= 100 ? `$${Math.round(n)}` : n >= 10 ? `$${n.toFixed(1)}` : `$${(n || 0).toFixed(2)}`);
function tokensText(n) {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)}M`;
  if (n >= 1e3) return `${Math.round(n / 1e3)}k`;
  return String(n || 0);
}
function resetText(at) {
  if (!at) return '';
  const when = new Date(at * 1000);
  const soon = when - Date.now() < 20 * 3600 * 1000;
  const time = when.toLocaleTimeString(uiLocale(), { hour: 'numeric', minute: '2-digit' });
  return soon ? `resets ${time}` : `resets ${when.toLocaleDateString(uiLocale(), { weekday: 'short' })} ${time}`;
}
function limitLevel(l) {
  const pct = l.utilization == null ? null : Math.round(l.utilization * 100);
  return l.status === 'rejected' || (pct != null && pct >= 100) ? 'full' : l.status === 'allowed_warning' || (pct != null && pct >= 80) ? 'warn' : '';
}

function renderUsage(u) {
  lastUsage = u;
  // Always the plan's 5-hour window: "–" until Anthropic has said how much of it is used.
  const five = (u.limits || []).find((l) => l.type === 'five_hour');
  const meter = document.querySelector('#p-uptime .usage-meter');
  const pct = five && five.utilization != null ? Math.round(five.utilization * 100) : null;
  $('v-usage-label').textContent = '5-hour limit';
  $('v-usage').textContent = five && five.status === 'rejected' ? 'Used up' : pct == null ? '–' : `${pct}% used`;
  $('v-usage-bar').style.width = `${Math.min(100, pct == null ? 0 : pct)}%`;
  meter.className = `usage-meter ${five ? limitLevel(five) : ''}`;
  meter.title = five && five.resets_at ? resetText(five.resets_at) : '';
  if (usageIsOpen()) renderUsagePop(u);
}

function usageRows(items, total) {
  const box = el('div');
  for (const it of items) {
    const row = el('div', 'usage-row');
    const bar = el('div', 'usage-bar');
    const fill = el('span');
    fill.style.width = `${total ? Math.max(2, Math.round((it.cost / total) * 100)) : 0}%`;
    bar.append(fill);
    row.append(mine(el('span', '', it.name)), bar, el('span', 'usage-note', `${usd(it.cost)} · ${tokensText(it.tokens)} tokens`));
    box.append(row);
  }
  return box;
}

function renderUsagePop(u) {
  const body = $('usage-body');
  const parts = [];
  // The plan's limits, as Claude Code last reported them.
  const plan = el('section');
  plan.append(el('h3', '', 'Plan limits'));
  // The 5-hour and weekly windows always, then any other the plan has (Opus, Sonnet, extra).
  const known = (u.limits || []).filter((l) => l.utilization != null || l.status === 'rejected');
  const limits = [
    ...['five_hour', 'seven_day'].map((type) => known.find((l) => l.type === type) || { type, label: type === 'five_hour' ? '5-hour limit' : 'Weekly limit', pending: true }),
    ...known.filter((l) => l.type !== 'five_hour' && l.type !== 'seven_day'),
  ];
  for (const l of limits) {
    if (l.pending) {
      const row = el('div', 'usage-row');
      row.append(el('span', '', l.label), el('div', 'usage-bar'), el('span', 'usage-note', 'Checking…'));
      plan.append(row);
      continue;
    }
    const pct = l.utilization == null ? 100 : Math.round(l.utilization * 100);
    const row = el('div', `usage-row ${limitLevel(l)}`);
    const bar = el('div', 'usage-bar');
    const fill = el('span');
    fill.style.width = `${Math.min(100, pct)}%`;
    bar.append(fill);
    const note = l.status === 'rejected' ? `Used up · ${resetText(l.resets_at)}` : `${pct}% used${l.resets_at ? ` · ${resetText(l.resets_at)}` : ''}`;
    row.append(el('span', '', l.label), bar, el('span', 'usage-note', note));
    plan.append(row);
  }
  parts.push(plan);
  // How much, over four spans.
  const spend = el('section');
  spend.append(el('h3', '', 'Consumption'));
  const tiles = el('div', 'usage-tiles');
  for (const [label, b] of [['This session', u.session], ['Today', u.today], ['Last 7 days', u.week], ['Last 30 days', u.month]]) {
    const tile = el('div', 'usage-tile');
    tile.append(el('small', '', label), el('b', '', usd(b.cost)), el('span', '', `${b.requests} answers · ${tokensText(b.tokens)} tokens`));
    tiles.append(tile);
  }
  spend.append(tiles);
  parts.push(spend);
  // The last two weeks.
  const days = el('section');
  days.append(el('h3', '', 'Last 14 days'));
  const chart = el('div', 'usage-chart');
  const top = Math.max(...u.history.map((d) => d.cost), 0.0001);
  u.history.forEach((d, i) => {
    const day = el('div', `usage-day${i === u.history.length - 1 ? ' today' : ''}`);
    const bar = el('i');
    bar.style.height = `${Math.round((d.cost / top) * 86)}px`;
    day.title = `${d.date}: ${usd(d.cost)} · ${tokensText(d.tokens)} tokens`;
    const date = new Date(`${d.date}T12:00:00`);
    day.append(bar, el('small', '', date.toLocaleDateString(uiLocale(), { weekday: 'narrow' })));
    chart.append(day);
  });
  days.append(chart);
  parts.push(days);
  // Where it went: JARVIS, Jarvis Code, research; and which models.
  const split = el('div', 'usage-split');
  const where = el('section');
  where.append(el('h3', '', 'Where it went · 30 days'));
  where.append(u.month.sources.length ? usageRows(u.month.sources, u.month.cost) : el('p', 'usage-empty', 'Nothing yet.'));
  const models = el('section');
  models.append(el('h3', '', 'By model · 30 days'));
  models.append(u.month.models.length ? usageRows(u.month.models, u.month.cost) : el('p', 'usage-empty', 'Nothing yet.'));
  split.append(where, models);
  parts.push(split);
  // Every API provider added in Settings (Gemini, OpenRouter…), used yet or not.
  const apis = el('section');
  apis.append(el('h3', '', 'API providers'));
  const provs = u.providers || [];
  if (!provs.length) apis.append(el('p', 'usage-empty', 'Add a model with an API key (Jarvis Code › model menu) and its usage shows here.'));
  const ptop = Math.max(1, ...provs.map((p) => p.month.tokens));
  for (const p of provs) {
    const row = el('div', 'usage-row api');
    const bar = el('div', 'usage-bar');
    const fill = el('span');
    fill.style.width = `${p.month.tokens ? Math.max(2, Math.round((100 * p.month.tokens) / ptop)) : 0}%`;
    bar.append(fill);
    const name = el('span');
    name.append(mine(el('span', '', p.name)));
    if (p.kind && p.kind !== p.name) name.append(el('small', 'usage-kind', ` ${p.kind}`));
    const cost = p.month.cost ? ` · ${usd(p.month.cost)}` : '';
    const note = p.month.requests
      ? `Today ${tokensText(p.today.tokens)} · 30 days ${tokensText(p.month.tokens)} tokens${cost}`
      : 'Not used yet';
    row.append(name, bar, el('span', 'usage-note', note));
    apis.append(row);
  }
  parts.push(apis);
  // The tokens themselves.
  const kinds = el('section');
  kinds.append(el('h3', '', 'Tokens · 30 days'));
  const kt = el('div', 'usage-tiles');
  for (const [label, key] of [['Input', 'input'], ['Output', 'output'], ['Cache reads', 'cache_read'], ['Cache writes', 'cache_write']]) {
    const tile = el('div', 'usage-tile');
    tile.append(el('small', '', label), el('b', '', tokensText(u.month[key])));
    kt.append(tile);
  }
  kinds.append(kt);
  parts.push(kinds);
  body.replaceChildren(...parts);
}

function usageIsOpen() { return !$('usage-layer').hidden; }
function openUsage() {
  if (!lastUsage || usageIsOpen()) return;
  usageReturnFocus = document.activeElement;
  renderUsagePop(lastUsage);
  $('usage-layer').hidden = false;
  $('usage-pop').scrollTop = 0;
  $('usage-scrim').animate([{ opacity: 0 }, { opacity: 1 }], { duration: 240, easing: 'ease-out' });
  $('usage-pop').animate(wxReduced() ? [{ opacity: 0 }, { opacity: 1 }] : [{ transform: 'translateY(14px) scale(0.97)', opacity: 0 }, { transform: 'none', opacity: 1 }],
    { duration: 320, easing: 'cubic-bezier(0.32, 0.72, 0, 1)' });
  $('usage-close').focus({ preventScroll: true });
}
function closeUsage() {
  if (!usageIsOpen()) return;
  $('usage-layer').hidden = true;
  const back = usageReturnFocus;
  usageReturnFocus = null;
  if (back && document.contains(back) && typeof back.focus === 'function') back.focus({ preventScroll: true });
}
$('p-uptime').addEventListener('click', openUsage);
$('p-uptime').addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openUsage(); } });
$('usage-close').addEventListener('click', closeUsage);
$('usage-scrim').addEventListener('click', closeUsage);
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && usageIsOpen()) { e.preventDefault(); e.stopPropagation(); closeUsage(); }
}, true);

// ── System stats › the full picture: Activity Monitor's tabs, each with its chart ──
let sysTab = 'cpu';
let sysReturnFocus = null;
const SYS_RED = '#ff5f57', SYS_BLUE = '#0a84ff', SYS_GREEN = '#30d158', SYS_AMBER = '#ffb340', SYS_ORANGE = '#ff9f0a';
function bytesText(n) {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let v = Math.max(0, n || 0);
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i += 1; }
  return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}
const rateText = (n) => `${bytesText(n)}/s`;
const countText = (n) => (n || 0).toLocaleString(uiLocale());

// An Activity Monitor graph: the last few minutes, stacked areas or lines, 0 to max.
function sysChart(history, series, { max = null, stacked = false } = {}) {
  const w = 600, h = 150;
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
  svg.setAttribute('preserveAspectRatio', 'none');
  for (const y of [0.25, 0.5, 0.75]) {
    const line = document.createElementNS(SVG_NS, 'line');
    line.setAttribute('class', 'grid'); line.setAttribute('x1', 0); line.setAttribute('x2', w);
    line.setAttribute('y1', h * y); line.setAttribute('y2', h * y);
    svg.append(line);
  }
  const n = history.length;
  const top = max || Math.max(1, ...history.flatMap((p) => series.map((s) => (stacked ? series.reduce((a, t) => a + (p[t.key] || 0), 0) : p[s.key] || 0))));
  const x = (i) => (n <= 1 ? w : (i / (180 - 1)) * w + (w - ((n - 1) / (180 - 1)) * w));
  const base = new Array(n).fill(0);
  for (const s of series) {
    const ys = history.map((p, i) => (stacked ? base[i] : 0) + (p[s.key] || 0));
    const pts = ys.map((v, i) => `${x(i).toFixed(1)},${(h - (Math.min(v, top) / top) * h).toFixed(1)}`);
    if (!pts.length) continue;
    if (s.fill !== false) {
      const floor = stacked ? base.map((v, i) => `${x(i).toFixed(1)},${(h - (Math.min(v, top) / top) * h).toFixed(1)}`).reverse() : [`${x(n - 1).toFixed(1)},${h}`, `${x(0).toFixed(1)},${h}`];
      const area = document.createElementNS(SVG_NS, 'polygon');
      area.setAttribute('points', [...pts, ...floor].join(' '));
      area.setAttribute('fill', s.color); area.setAttribute('fill-opacity', stacked ? '0.55' : '0.22');
      svg.append(area);
    }
    const line = document.createElementNS(SVG_NS, 'polyline');
    line.setAttribute('class', 'line'); line.setAttribute('points', pts.join(' ')); line.setAttribute('stroke', s.color);
    svg.append(line);
    if (stacked) ys.forEach((v, i) => { base[i] = v; });
  }
  return { svg, top };
}

function sysChartBox(history, series, opts, topLabel) {
  const box = el('div', 'sys-chart');
  const { svg, top } = sysChart(history, series, opts);
  box.append(svg);
  const legend = el('div', 'sys-legend');
  const last = history[history.length - 1] || {};
  for (const s of series) {
    const item = el('span');
    const dot = el('i'); dot.style.background = s.color;
    item.append(dot, el('span', '', `${s.label} ${s.fmt(last[s.key] || 0)}`));
    legend.append(item);
  }
  legend.append(el('span', 'sys-top', topLabel ? topLabel(top) : ''));
  box.append(legend);
  return box;
}

function sysTile(label, value, sub) {
  const tile = el('div', 'usage-tile');
  tile.append(el('small', '', label), el('b', '', value));
  if (sub) tile.append(el('span', '', sub));
  return tile;
}

function sysTable(cols, rows) {
  const table = el('table', 'sys-table');
  const head = el('tr');
  for (const c of cols) head.append(el('th', c.num ? 'num' : '', c.label));
  const thead = el('thead'); thead.append(head);
  const body = el('tbody');
  for (const r of rows) {
    const tr = el('tr');
    cols.forEach((c, i) => { const td = el('td', c.num ? 'num' : '', c.get(r)); if (i === 0) mine(td); tr.append(td); });
    body.append(tr);
  }
  table.append(thead, body);
  return table;
}

function renderSysmon(ev) {
  if (!sysIsOpen() || ev.tab !== sysTab) return;
  const h = ev.history || [];
  const parts = [];
  const pct = (v) => `${Math.round(v)}%`;
  if (ev.tab === 'cpu' && ev.cpu) {
    const c = ev.cpu;
    parts.push(sysChartBox(h, [{ key: 'system', label: 'System', color: SYS_RED, fmt: pct }, { key: 'user', label: 'User', color: SYS_BLUE, fmt: pct }], { max: 100, stacked: true }, () => 'CPU load · 6 min'));
    const tiles = el('div', 'sys-tiles');
    tiles.append(sysTile('System', pct(c.system)), sysTile('User', pct(c.user)), sysTile('Idle', pct(c.idle)),
      sysTile('Processes', countText(c.processes)), sysTile('Threads', countText(c.threads)), sysTile('Load average', c.load.map((v) => v.toFixed(1)).join('  '), '1, 5 and 15 min'));
    const cores = el('div', 'sys-cores');
    c.cores.forEach((v, i) => { const core = el('div', 'sys-core'); const bar = el('i'); const fill = el('span'); fill.style.height = `${Math.min(100, v)}%`; bar.append(fill); core.append(bar, el('span', '', `Core ${i + 1} · ${Math.round(v)}%`)); cores.append(core); });
    parts.push(tiles, cores);
    parts.push(sysTable([
      { label: 'Process', get: (p) => p.name }, { label: '% CPU', num: true, get: (p) => p.cpu.toFixed(1) },
      { label: 'Threads', num: true, get: (p) => p.threads }, { label: 'PID', num: true, get: (p) => p.pid }, { label: 'User', get: (p) => p.user || '' },
    ], ev.processes || []));
  } else if (ev.tab === 'memory' && ev.memory) {
    const m = ev.memory;
    const color = m.pressure >= 80 ? SYS_RED : m.pressure >= 50 ? SYS_AMBER : SYS_GREEN;
    parts.push(sysChartBox(h, [{ key: 'pressure', label: 'Memory pressure', color, fmt: pct }], { max: 100 }, () => '6 min'));
    const tiles = el('div', 'sys-tiles');
    tiles.append(sysTile('Physical memory', bytesText(m.total)), sysTile('Memory used', bytesText(m.used)),
      sysTile('App memory', bytesText(m.app)), sysTile('Wired memory', bytesText(m.wired)), sysTile('Compressed', bytesText(m.compressed)),
      sysTile('Cached files', bytesText(m.cached)), sysTile('Swap used', bytesText(m.swap), m.swap_total ? `of ${bytesText(m.swap_total)}` : ''));
    const stack = el('div', 'sys-stack');
    const key = el('div', 'sys-legend');
    for (const [label, v, c] of [['App memory', m.app, SYS_BLUE], ['Wired memory', m.wired, SYS_ORANGE], ['Compressed', m.compressed, SYS_AMBER], ['Cached files', m.cached, 'rgba(160,160,170,0.55)']]) {
      const seg = el('span'); seg.style.width = `${(100 * v) / m.total}%`; seg.style.background = c; stack.append(seg);
      const item = el('span'); const dot = el('i'); dot.style.background = c; item.append(dot, el('span', '', label)); key.append(item);
    }
    parts.push(tiles, stack, key);
    parts.push(sysTable([
      { label: 'Process', get: (p) => p.name }, { label: 'Memory', num: true, get: (p) => bytesText(p.memory) },
      { label: 'Threads', num: true, get: (p) => p.threads }, { label: 'PID', num: true, get: (p) => p.pid }, { label: 'User', get: (p) => p.user || '' },
    ], ev.processes || []));
  } else if (ev.tab === 'energy') {
    const e = ev.energy || {};
    parts.push(sysChartBox(h, [{ key: 'battery', label: 'Battery', color: SYS_GREEN, fmt: pct }], { max: 100 }, () => '6 min'));
    const tiles = el('div', 'sys-tiles');
    if (e.percent != null) tiles.append(sysTile('Battery', `${e.percent}%`, e.plugged ? 'On power adapter' : 'On battery'));
    if (e.minutes_left != null) tiles.append(sysTile(e.plugged ? 'Until full' : 'Time left', `${Math.floor(e.minutes_left / 60)}:${String(e.minutes_left % 60).padStart(2, '0')}`));
    if (e.watts != null) tiles.append(sysTile(e.watts < 0 ? 'Drawing' : 'Charging at', `${Math.abs(e.watts)} W`));
    if (e.health != null) tiles.append(sysTile('Battery health', `${e.health}%`, 'of its design capacity'));
    if (e.cycles != null) tiles.append(sysTile('Cycle count', countText(e.cycles), e.design_cycles ? `of ${countText(e.design_cycles)}` : ''));
    if (e.temperature != null) tiles.append(sysTile('Temperature', `${e.temperature} °C`));
    parts.push(tiles);
    parts.push(ev.processes && ev.processes.length ? sysTable([
      { label: 'Process', get: (p) => p.name }, { label: 'Energy impact', num: true, get: (p) => p.energy.toFixed(1) }, { label: 'PID', num: true, get: (p) => p.pid },
    ], ev.processes) : el('p', 'sys-note', 'Measuring energy impact…'));
  } else if (ev.tab === 'disk' && ev.disk) {
    const d = ev.disk;
    parts.push(sysChartBox(h, [{ key: 'read', label: 'Read', color: SYS_BLUE, fmt: rateText, fill: true }, { key: 'write', label: 'Written', color: SYS_RED, fmt: rateText }], {}, (t) => `peak ${rateText(t)}`));
    const last = h[h.length - 1] || {};
    const tiles = el('div', 'sys-tiles');
    tiles.append(sysTile('Reads/sec', countText(last.reads)), sysTile('Writes/sec', countText(last.writes)),
      sysTile('Data read', bytesText(d.read_total), 'since startup'), sysTile('Data written', bytesText(d.write_total), 'since startup'),
      sysTile('Reads in', countText(d.reads_total)), sysTile('Writes out', countText(d.writes_total)));
    parts.push(tiles);
    parts.push(sysTable([
      { label: 'Volume', get: (v) => v.name }, { label: 'Used', num: true, get: (v) => bytesText(v.used) },
      { label: 'Free', num: true, get: (v) => bytesText(v.total - v.used) }, { label: 'Size', num: true, get: (v) => bytesText(v.total) }, { label: 'Format', get: (v) => v.fs },
    ], d.volumes || []));
    parts.push(el('p', 'sys-note', 'macOS doesn’t show other apps how much each process reads or writes.'));
  } else if (ev.tab === 'network' && ev.network) {
    const nw = ev.network;
    parts.push(sysChartBox(h, [{ key: 'down', label: 'Received', color: SYS_BLUE, fmt: rateText }, { key: 'up', label: 'Sent', color: SYS_ORANGE, fmt: rateText }], {}, (t) => `peak ${rateText(t)}`));
    const last = h[h.length - 1] || {};
    const tiles = el('div', 'sys-tiles');
    tiles.append(sysTile('Packets in/sec', countText(last.pin)), sysTile('Packets out/sec', countText(last.pout)),
      sysTile('Data received', bytesText(nw.received), 'since startup'), sysTile('Data sent', bytesText(nw.sent), 'since startup'),
      sysTile('Packets in', countText(nw.packets_in)), sysTile('Packets out', countText(nw.packets_out)));
    parts.push(tiles);
    parts.push(sysTable([
      { label: 'Interface', get: (i) => i.name }, { label: 'Received', num: true, get: (i) => bytesText(i.received) },
      { label: 'Sent', num: true, get: (i) => bytesText(i.sent) }, { label: 'Status', get: (i) => (i.up ? 'Active' : 'Inactive') },
    ], nw.interfaces || []));
    parts.push(el('p', 'sys-note', 'macOS doesn’t show other apps how much each process sends or receives.'));
  }
  const body = $('sys-body');
  const keep = body.scrollTop;
  body.replaceChildren(...parts);
  body.scrollTop = keep;
}

function sysIsOpen() { return !$('sys-layer').hidden; }
function selectSysTab(tab) {
  sysTab = tab;
  for (const b of $('sys-tabs').querySelectorAll('button')) b.setAttribute('aria-selected', String(b.dataset.tab === tab));
  $('sys-body').replaceChildren(el('p', 'usage-empty', 'Measuring…'));
  send({ type: 'sysmon_open', tab });
}
function openSys() {
  if (sysIsOpen()) return;
  sysReturnFocus = document.activeElement;
  $('sys-layer').hidden = false;
  $('sys-pop').scrollTop = 0;
  $('sys-scrim').animate([{ opacity: 0 }, { opacity: 1 }], { duration: 240, easing: 'ease-out' });
  $('sys-pop').animate(wxReduced() ? [{ opacity: 0 }, { opacity: 1 }] : [{ transform: 'translateY(14px) scale(0.97)', opacity: 0 }, { transform: 'none', opacity: 1 }],
    { duration: 320, easing: 'cubic-bezier(0.32, 0.72, 0, 1)' });
  selectSysTab(sysTab);
  $('sys-close').focus({ preventScroll: true });
}
function closeSys() {
  if (!sysIsOpen()) return;
  $('sys-layer').hidden = true;
  send({ type: 'sysmon_close' });
  const back = sysReturnFocus;
  sysReturnFocus = null;
  if (back && document.contains(back) && typeof back.focus === 'function') back.focus({ preventScroll: true });
}
$('p-system').addEventListener('click', openSys);
$('p-system').addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openSys(); } });
$('sys-close').addEventListener('click', closeSys);
$('sys-scrim').addEventListener('click', closeSys);
$('sys-tabs').addEventListener('click', (e) => { const b = e.target.closest('button[data-tab]'); if (b) selectSysTab(b.dataset.tab); });
$('sys-tabs').addEventListener('keydown', (e) => {
  if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
  const tabs = ['cpu', 'memory', 'energy', 'disk', 'network'];
  const next = tabs[(tabs.indexOf(sysTab) + (e.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length];
  selectSysTab(next);
  $('sys-tabs').querySelector(`[data-tab="${next}"]`).focus();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && sysIsOpen()) { e.preventDefault(); e.stopPropagation(); closeSys(); }
}, true);

let historyScroll = 0;

function renderHistory() {
  const list = $('history');
  list.replaceChildren(...history.slice(-60).map((h) => {
    const li = el('li', h.role);
    li.append(document.createTextNode(h.text || '…'));
    li.append(el('time', '', clockText(h.at)));
    return li;
  }));
  list.scrollTop = list.scrollHeight;
}

document.querySelectorAll('#look-group button').forEach((b) => b.addEventListener('click', () => setPrefs({ look: b.dataset.look })));
document.querySelectorAll('#tone-group button').forEach((b) => b.addEventListener('click', () => setPrefs({ glass_tone: b.dataset.tone })));
document.querySelectorAll('#lang-group button').forEach((b) => b.addEventListener('click', () => setPrefs({ language: b.dataset.lang })));
$('weather-city').addEventListener('change', (e) => setPrefs({ weather_city: e.target.value }));
$('vt-indicator').addEventListener('click', () => send({ type: 'voice_typing', on: false }));
$('clear-history').addEventListener('click', () => send({ type: 'clear_history' }));
$('export-history').addEventListener('click', () => send({ type: 'export_history' }));

// Requests typed or said while JARVIS is still answering wait here, in order; ✕ takes one
// back before it's sent.
function renderAskQueue(items) {
  const list = $('ask-queue');
  list.hidden = !items.length;
  list.replaceChildren(...items.map((item) => {
    const li = el('li', 'ask-queued');
    li.append(el('span', 'ask-queued-kicker', 'Next'), mine(el('span', 'ask-queued-text', item.text)));
    const x = el('button', 'ask-queued-x', '✕');
    x.type = 'button';
    x.setAttribute('aria-label', 'Don’t send this');
    x.addEventListener('click', () => send({ type: 'unqueue', id: item.id }));
    li.append(x);
    return li;
  }));
}

async function makePdf(ev) {
  let pdf = '';
  try { if (app && app.pdf) pdf = await app.pdf(ev.html); } catch (_) { /* HTML copy instead */ }
  send({ type: 'pdf_result', id: ev.id, pdf });
}

function onSaved(ev) {
  let reveal = null;
  if (ev.path) {
    reveal = el('button', 'btn', 'Show in Finder');
    reveal.type = 'button';
    reveal.addEventListener('click', () => send({ type: 'reveal', path: ev.path }));
  }
  notice('Saved', ev.title, ev.text, 12000, reveal);
}

// "Jarvis, open Jarvis Code / close the browser / turn on hand control."
function applyUi(ev) {
  if (ev.action === 'hands') {
    if (ev.on && !handsOn) startHandControl();
    else if (!ev.on && handsOn) stopHandControl();
    return;
  }
  if (ev.action !== 'panel') return;
  const open = ev.open !== false;
  switch (ev.name) {
    case 'code': toggleCC(open); break;
    case 'browser': if (app && app.browser) toggleBrowser(open); break;
    case 'research': if (open) openResearch(lastResearchPath); else toggleBrowser(false); break;
    case 'settings': toggleSettings(open); break;
    case 'simulator': if (open) { toggleCC(true); openPane('sim'); } else if (currentPane === 'sim') closePane(); break;
    case 'accounts': toggleAccounts(open); break;
    case 'brain': setGalaxyMode(open ? 'open' : 'off'); break;
    case 'activity': toggleDrawer(open); break;
    default:
  }
}
$('chat-form').addEventListener('submit', (e) => { e.preventDefault(); askFromBox($('chat-input')); });
$('c-mic').addEventListener('click', talkOrStop);
$('c-keys').addEventListener('click', () => $('chat-input').focus());

// ── markets: the day at a glance ──

const MK_STATUS = { open: 'Open', pre: 'Pre-market', after: 'After hours', closed: 'Closed' };

function mkPct(p) { return `${p >= 0 ? '+' : '−'}${Math.abs(p).toFixed(2)}%`; }
function mkPrice(q) {
  if (q.yield) return `${q.last.toFixed(3)}%`;
  return q.last >= 1000 ? q.last.toLocaleString(uiLocale(), { maximumFractionDigits: 0 }) : q.last.toFixed(2);
}

function sparkline(points, up) {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 80 24');
  svg.setAttribute('preserveAspectRatio', 'none');
  svg.setAttribute('class', `mk-spark ${up ? 'up' : 'down'}`);
  svg.setAttribute('aria-hidden', 'true');
  if (points && points.length > 1) {
    const lo = Math.min(...points), hi = Math.max(...points), span = hi - lo || 1;
    const line = document.createElementNS(ns, 'polyline');
    line.setAttribute('points', points.map((p, i) => `${(i / (points.length - 1)) * 80},${22 - ((p - lo) / span) * 20}`).join(' '));
    svg.append(line);
  }
  return svg;
}

function closesIn() {
  const et = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const mins = 16 * 60 - (et.getHours() * 60 + et.getMinutes());
  return mins > 0 ? ` · closes in ${Math.floor(mins / 60)}h ${mins % 60}m` : '';
}

// Four rows, the size of System stats: index, level and the day's move, with the day's
// line where a stat has its bar. The watchlist and summary are for "how's the market?".
function renderMarkets(m) {
  if (!m || !m.indices) return;
  $('mk-status').textContent = `${MK_STATUS[m.status] || m.status}${m.status === 'open' ? closesIn() : ''}`;
  $('mk-status').dataset.state = m.status;
  $('mk-status').title = (uiLocale() && m.headline_zh) || m.headline || '';
  $('mk-indices').replaceChildren(...m.indices.map((q) => {
    const row = el('div', `meter mk-row ${q.pct >= 0 ? 'up' : 'down'}`);
    const value = el('b');
    value.append(document.createTextNode(`${mkPrice(q)} `), el('span', 'mk-pct', mkPct(q.pct)));
    row.append(el('span', '', q.name), value, sparkline(q.spark, q.pct >= 0));
    return row;
  }));
}

$('watchlist').addEventListener('change', (e) => setPrefs({ watchlist: e.target.value }));
$('research-url').addEventListener('change', (e) => setPrefs({ research_url: e.target.value }));
$('invoice-from').addEventListener('change', (e) => setPrefs({ invoice_from: e.target.value }));
$('invoice-payment').addEventListener('change', (e) => setPrefs({ invoice_payment: e.target.value }));

// ── Claude Code deck ──

let ccSelected = null;
let ccTasks = [];
let deckProject = null;
let deckProjects = [];
let deckTab = 'active';
let pastSessions = [];
// Past sessions in every project, newest first, from Claude Code's own records (the hub's
// claude_history): the sidebar lists them under each project, so they outlast a restart.
let codeHistory = [];
const showAllPast = new Set();  // projects listing all their past sessions, not the latest few
const PAST_SHOWN = 5;
let newMode = 'ask';
let awaitingNewSession = false;
const pendingApprovals = new Map();
const MODE_NAMES = { plan: 'Plan', ask: 'Manual', edits: 'Accept edits', smart: 'Auto', auto: 'Bypass permissions' };

// Split view (features/code-split.js) shows a second session beside the open one. While it
// shows, it says where a session asked for goes (take(id): true when the pane beside took it,
// so a click in the sidebar opens in the pane with the focus), which session the sidebar marks
// (the focused pane's) and whether a session is on screen (shows(id)).
let jcSplit = null;  // { take(id), marked(), shows(id) } while a split shows
function markedSession() { return jcSplit ? jcSplit.marked() : ccSelected; }
function sessionOnScreen(id) { return jcSplit ? jcSplit.shows(id) : id === ccSelected; }

function toggleCC(open) {
  if (inSplitPane && !open) return;  // the split's pane closes from the main window
  $('cc').hidden = !open;
  $('cc-btn').setAttribute('aria-expanded', String(open));
  if (open) {
    send({ type: 'claude_projects' });
    send({ type: 'claude_history' });
    if (ccSelected) { send({ type: 'task_transcript', id: ccSelected }); send({ type: 'task_context', id: ccSelected }); }
    requestAnimationFrame(() => { moveGlider(); });
    if (currentPane) renderPaneBody();
    setTimeout(() => { if (!inSplitPane || document.hasFocus()) $('deck-input').focus(); }, 40);
  } else {
    closeMenu();
    if (currentPane === 'sim') closeSimPanel();
  }
}
$('cc-btn').addEventListener('click', () => toggleCC($('cc').hidden));

// The sidebar folds away (and stays folded next time).
function setSide(open) {
  $('cc').classList.toggle('side-hidden', !open);
  const b = $('jc-side-toggle');
  b.setAttribute('aria-expanded', String(open));
  b.setAttribute('aria-label', open ? 'Hide sidebar' : 'Show sidebar');
  b.title = open ? 'Hide sidebar (⌘\\)' : 'Show sidebar (⌘\\)';
  try { localStorage.setItem('jc.side', open ? 'open' : 'closed'); } catch (_) { /* private mode */ }
  setTimeout(() => { moveGlider(); }, 380);
}
$('jc-side-toggle').addEventListener('click', () => setSide($('cc').classList.contains('side-hidden')));
try { if (localStorage.getItem('jc.side') === 'closed') setSide(false); } catch (_) { /* private mode */ }
document.addEventListener('keydown', (e) => {
  if (!$('cc').hidden && e.metaKey && !e.shiftKey && !e.altKey && e.key === '\\') { e.preventDefault(); setSide($('cc').classList.contains('side-hidden')); }  // (⌘⇧\: split view's; ⌥⌘\: Logbook's margin)
});
$('cc-close').addEventListener('click', () => toggleCC(false));

// ── sidebar: projects, each with its sessions ──

const openProjects = new Set();

function renderProjects(items) {
  deckProjects = items || [];
  if (!deckProject && deckProjects.length) { selectProject((deckProjects.find((p) => p.running) || deckProjects[0]).name); return; }
  const filter = $('deck-filter').value.trim().toLowerCase();
  const marked = markedSession();  // the open session's row (split view: the focused pane's)
  const shown = [filter, deckProject, ccSelected, marked, voiceFocus && voiceFocus.id, [...openProjects], deckProjects.map((p) => [p.name, p.branch]),
    ccTasks.map((t) => [t.id, t.folder, t.title || t.prompt, statusOf(t), statusText(t), t.mode, t.session_id]),
    [...showAllPast], new Date().toDateString()];
  if (!changed('projects', shown, historySignature())) { moveGlider(); return; }
  $('deck-project-list').replaceChildren(...deckProjects.filter((p) => !filter || p.name.toLowerCase().includes(filter)).map((p) => {
    const li = el('li');
    const open = openProjects.has(p.name) || p.name === deckProject;
    const b = el('button', 'jc-project');
    b.type = 'button';
    b.setAttribute('aria-expanded', String(open));
    b.dataset.key = `p:${p.name}`;
    if (p.name === deckProject) b.setAttribute('aria-current', 'true');
    b.append(el('span', 'jc-chev', '▶'), mine(el('span', 'jc-pname', p.name)));
    if (p.branch) b.append(mine(el('span', 'jc-branch', p.branch)));
    b.addEventListener('click', () => {
      if (p.name === deckProject && open) openProjects.delete(p.name); else openProjects.add(p.name);
      selectProject(p.name);
    });
    li.append(b);
    if (open) {
      const sessions = el('ul', 'jc-sessions');
      for (const t of ccTasks.filter((x) => x.folder === p.name)) {
        const row = el('button', 'jc-session');
        row.type = 'button';
        row.dataset.task = t.id;
        row.dataset.key = `t:${t.id}`;
        row.setAttribute('aria-current', String(t.id === marked));
        const title = t.title || t.prompt ? mine(el('span', 'jc-stitle', t.title || t.prompt)) : el('span', 'jc-stitle', 'New session');
        if (voiceFocus && voiceFocus.id === t.id) { const r = el('span', 'jc-mini-reactor'); r.title = 'Voice coding'; title.append(r); }
        row.append(el('span', `jc-dot ${statusOf(t)}`), title, el('small', '', `${statusText(t)} · ${MODE_NAMES[t.mode] || t.mode}`));
        row.addEventListener('click', () => selectTask(t.id));
        const item = el('li');
        item.append(row);
        sessions.append(item);
      }
      // Its history: past sessions not open now, newest first; a click reopens one with
      // its conversation so far.
      const live = new Set(ccTasks.map((t) => t.session_id).filter(Boolean));
      const past = codeHistory.filter((h) => h.folder === p.name && !live.has(h.session_id));
      const all = showAllPast.has(p.name);
      for (const h of all ? past : past.slice(0, PAST_SHOWN)) {
        const item = el('li');
        item.append(pastRow(p.name, h));
        sessions.append(item);
      }
      if (past.length > PAST_SHOWN) {
        const more = el('button', 'jc-session more', all ? 'Show fewer' : `Show ${past.length - PAST_SHOWN} more`);
        more.type = 'button';
        more.dataset.key = `m:${p.name}`;
        more.addEventListener('click', () => { if (all) showAllPast.delete(p.name); else showAllPast.add(p.name); renderProjects(deckProjects); });
        const moreLi = el('li');
        moreLi.append(more);
        sessions.append(moreLi);
      }
      const add = el('button', 'jc-session add', '+ New session');
      add.type = 'button';
      add.addEventListener('click', () => { deckProject = p.name; newSession(false); });
      const addLi = el('li');
      addLi.append(add);
      sessions.append(addLi);
      li.append(sessions);
    }
    return li;
  }));
  moveGlider();
}
$('deck-filter').addEventListener('input', () => renderProjects(deckProjects));

// The history's part of the sidebar's signature, worked out once for each list the hub
// sends: it can be thousands of past sessions, and the sidebar is asked again on every step
// of every session. (The list is replaced, never changed in place.)
const historySig = { list: null, json: '' };
function historySignature() {
  if (historySig.list !== codeHistory) {
    historySig.list = codeHistory;
    historySig.json = JSON.stringify(codeHistory.map((h) => [h.session_id, h.folder, h.title, h.modified]));
  }
  return historySig.json;
}

// A past session in the sidebar: its title and when it was last used.
function pastRow(folder, h) {
  const row = el('button', 'jc-session past');
  row.type = 'button';
  row.dataset.session = h.session_id;
  row.dataset.key = `s:${h.session_id}`;
  if (h.first_prompt) row.title = h.first_prompt;
  row.append(el('span', 'jc-dot past'), h.title ? mine(el('span', 'jc-stitle', h.title)) : el('span', 'jc-stitle', 'Untitled session'));
  row.append(mine(el('small', '', [sessionWhen(h), h.branch && `⎇ ${h.branch}`].filter(Boolean).join(' · '))));
  row.addEventListener('click', () => resumeSession(folder, h));
  return row;
}

// Reopens a past session (Claude Code's resume): the hub reads its conversation so far into
// the transcript, and shows the one already open rather than a copy.
function resumeSession(folder, h) {
  awaitingNewSession = true;
  send({ type: 'task_new', directory: folder, session_id: h.session_id, title: h.title || '', prompt: '' });
}

// When a session was last used: the time today, the weekday this week, else the date.
function sessionWhen(h) {
  const d = new Date(h.modified || h.last_modified);
  if (Number.isNaN(d.getTime())) return '';
  const now = new Date();
  if (d.toDateString() === now.toDateString()) return d.toLocaleTimeString(uiLocale(), { hour: 'numeric', minute: '2-digit' });
  if (now - d < 6 * 86400000 && now > d) return d.toLocaleDateString(uiLocale(), { weekday: 'short' });
  return d.toLocaleDateString(uiLocale(), { month: 'short', day: 'numeric', ...(d.getFullYear() !== now.getFullYear() ? { year: 'numeric' } : {}) });
}

function sortedHistory(items) {
  return items.filter((h) => h && h.session_id && h.folder).sort((a, b) => (b.modified || 0) - (a.modified || 0));
}

// One project's latest sessions (claude_sessions) freshen the history in place.
function mergeHistory(items) {
  if (!items.length) return;
  const byId = new Map(codeHistory.map((h) => [h.session_id, h]));
  for (const h of items) if (h && h.session_id) byId.set(h.session_id, h);
  codeHistory = sortedHistory([...byId.values()]);
  renderProjects(deckProjects);
}

// The selection pill glides to the selected session, or to the project when none is open,
// and lifts into place as it lands (the BSH sidebar's levitate).
let gliderOn = null;
function moveGlider() {
  const glider = $('jc-glider');
  const row = document.querySelector(`#deck-project-list .jc-session[aria-current="true"]`)
    || document.querySelector(`#deck-project-list .jc-project[aria-current="true"]`);
  if (!row || $('cc').hidden) { glider.style.opacity = '0'; gliderOn = null; return; }
  if (gliderOn !== row.dataset.key) {
    gliderOn = row.dataset.key;
    glider.classList.remove('lift');
    void glider.offsetWidth; // restart the animation
    glider.classList.add('lift');
  }
  const wrap = glider.parentElement.getBoundingClientRect();
  const r = row.getBoundingClientRect();
  glider.style.top = `${r.top - wrap.top + glider.parentElement.scrollTop}px`;
  glider.style.height = `${r.height}px`;
  glider.style.left = `${r.left - wrap.left}px`;
  glider.style.opacity = '1';
}

function selectProject(name) {
  const other = deckProject !== name;
  if (other) pastSessions = [];
  deckProject = name;
  // With no session open, a pane is the project's (its Git, dev servers, tests, files):
  // it's drawn again for the project picked, so its buttons never act on another.
  if (other && !ccSelected && currentPane) renderPaneBody();
  send({ type: 'claude_sessions', directory: name });
  if (!projectFiles[name]) send({ type: 'project_files', directory: name });
  document.querySelectorAll('.cc-project-name').forEach((n) => { n.textContent = name; });
  renderProjects(deckProjects);
  renderPast();
  if (!ccSelected) renderHeader(null);
}

function renderPast() {
  $('cc-past-wrap').hidden = !pastSessions.length;
  $('cc-past').replaceChildren(...pastSessions.slice(0, 6).map((p) => {
    const li = el('li');
    const b = el('button', 'jc-past-item');
    b.type = 'button';
    b.append(el('span', '', p.title || 'Untitled session'), el('small', '', new Date(p.last_modified).toLocaleString(uiLocale(), { dateStyle: 'medium', timeStyle: 'short' })));
    b.addEventListener('click', () => resumeSession(deckProject, p));
    li.append(b);
    return li;
  }));
}

function renderDeckList() { renderProjects(deckProjects); renderPast(); }
function renderGit() { /* the Changes pane shows the diff */ }
function showPane() { /* one column now: the transcript, with the welcome above it */ }

function statusOf(t) { return t.busy ? 'busy' : t.status === 'failed' ? 'failed' : t.status === 'waiting' ? 'waiting' : 'idle'; }
function statusText(t) { return t.busy ? 'working' : { waiting: 'your turn', failed: 'failed', stopped: 'ended', closed: 'ended', running: 'starting' }[t.status] || t.status; }

// ── header, mode, status ──

const MODE_LINES = {
  plan: '⏸ Plan: explores and plans, changes nothing until you approve',
  ask: 'Manual: asks before each edit and command',
  edits: '⏵⏵ Accept edits: edits go ahead, commands ask',
  smart: '✦ Auto: safe steps go ahead, a safety check asks about risky ones',
  auto: '⚡ Bypass permissions: runs anything without asking',
};
const MODEL_LABELS = { 'claude-opus-5-5': 'Opus 5.5', 'claude-sonnet-5-5': 'Sonnet 5.5', 'claude-haiku-4-5': 'Haiku 4.5', 'claude-fable-5-1': 'Fable 5.1' };
let ccContext = {};
let workingSince = 0;
let renaming = null;  // the session whose new name is being typed in the title

function currentTask() { return ccTasks.find((x) => x.id === ccSelected) || null; }

function renderHeader(t) {
  const p = deckProjects.find((x) => x.name === (t ? t.folder : deckProject));
  // (The title is written every time, changed or not: features watch it to know the header
  // was drawn again, for another session perhaps with the same title. Not while its new name
  // is being typed: each step of a session at work wrote the old one back over the typing.)
  const title = $('jc-title');
  if (!(title.isContentEditable && t && t.id === renaming)) title.textContent = t ? (t.title || t.prompt || 'New session') : (deckProject || 'Jarvis Code');
  const sub = [];
  if (t || deckProject) sub.push(t ? t.folder : deckProject);
  if (p && p.branch) sub.push(`⎇ ${p.branch}`);
  if (t && t.session_id) sub.push(t.session_id.slice(0, 8));
  const base = (path) => path.split('/').filter(Boolean).pop();
  if (t && t.add_dirs && t.add_dirs.length) sub.push(`+ ${t.add_dirs.map(base).join(', ')}`);
  if (t && t.plugins && t.plugins.length) sub.push(`plugins: ${t.plugins.map(base).join(', ')}`);
  setText($('jc-sub'), sub.join('  ·  '));
}

function renderCC(items) {
  ccTasks = (items || []).filter((t) => t.kind === 'code');
  const running = ccTasks.filter((t) => t.busy).length;
  const waiting = ccTasks.filter((t) => !t.busy && t.status === 'waiting').length;
  // (Written only when it changed: the hub sends the list on every step of every session.)
  setText($('cc-label'), running ? `Jarvis Code · ${running} working` : ccTasks.length ? `Jarvis Code · ${ccTasks.length}` : 'Jarvis Code');
  setText($('deck-summary'), [running && `${running} working`, waiting && `${waiting} waiting for you`].filter(Boolean).join(' · '));
  renderProjects(deckProjects);
  const t = currentTask();
  renderHeader(t);
  $('cc-welcome').hidden = !!t && $('deck-timeline').children.length > 0;
  renderComposer();
  if (!t) {
    setText($('cc-mode'), 'Pick a session, or start one. ? for shortcuts');
    setText($('cc-meta'), '');
    $('cc-working').hidden = true;
    $('jc-todos').hidden = true;
    $('jc-bg').hidden = true;
    drawnParts.delete('todos');  // hidden here: drawn again when a session shows
    drawnParts.delete('background');
    setCtx(null);
    if (changed('queue', null)) renderQueue(null);
    return;
  }
  setText($('cc-mode'), `${MODE_LINES[t.mode] || t.mode} · ⇧⇥ to switch${t.ultracode ? ' · ultracode on' : ''}`);
  setText($('cc-meta'), [
    t.files_changed.length ? `${t.files_changed.length} file${t.files_changed.length === 1 ? '' : 's'}` : '',
    t.cost_usd ? `$${t.cost_usd.toFixed(2)}` : '',
    t.queued ? `${t.queued} queued` : '',
  ].filter(Boolean).join(' · '));
  setCtx(ccContext[t.id] ? ccContext[t.id].percent : null);
  if (t.busy && !workingSince) workingSince = Date.now();
  if (!t.busy) workingSince = 0;
  $('cc-working').hidden = !t.busy;
  setText($('cc-working-text'), `${t.last_action && t.last_action !== 'Working' ? t.last_action : 'Working'}…`);
  if (changed('todos', [t.id, t.todos])) renderTodos(t.todos || []);
  if (changed('background', [t.id, t.background])) renderBackground(t.background || []);
  if (changed('queue', [t.id, t.queue, t.steerable])) renderQueue(t);
  if (currentPane === 'background' && changed('bgpane', [t.id, t.background])) renderPaneBody();
  // The session started running while its MCP servers showed as not running: ask again.
  if (currentPane === 'mcp' && changed('mcplive', [t.id, t.status, t.busy]) && mcpAnswer && mcpAnswer.id === t.id && !mcpAnswer.connected && mcpAsked !== t.id) {
    mcpAsked = t.id;
    send({ type: 'task_mcp', id: t.id });
  }
}

function setCtx(percent) {
  const ring = $('jc-ctx-ring');
  $('jc-ctx').hidden = percent == null;
  if (percent == null) return;
  ring.style.strokeDashoffset = String(50.3 * (1 - Math.min(100, percent) / 100));
  ring.style.stroke = percent > 80 ? 'rgb(var(--c-warning))' : '';
  $('jc-ctx-text').textContent = `${percent}%`;
}

function renderTodos(todos) {
  const box = $('jc-todos');
  box.hidden = !todos.length || todos.every((x) => x.status === 'completed');
  if (box.hidden) return;
  const done = todos.filter((x) => x.status === 'completed').length;
  const det = el('details');
  det.open = true;
  det.append(el('summary', '', `To-dos · ${done} of ${todos.length} done`), checklist(todos));
  box.replaceChildren(det);
}

function checklist(todos) {
  const ul = el('ul', 'jc-checklist');
  ul.append(...todos.map((x) => {
    const li = el('li', x.status);
    li.append(el('span', 'box'), el('span', '', x.status === 'in_progress' && x.active ? x.active : x.content));
    return li;
  }));
  return ul;
}

function renderBackground(items) {
  const box = $('jc-bg');
  box.hidden = !items.length;
  box.replaceChildren(...items.map((b) => {
    const chip = el('span', 'jc-bgchip');
    const stop = el('button', 'jc-mini', 'Stop');
    stop.type = 'button';
    stop.addEventListener('click', () => send({ type: 'task_bg_stop', id: ccSelected, bg: b.id }));
    chip.append(el('span', 'jc-dot busy'), el('span', '', b.description || b.kind || 'Background task'), stop);
    return chip;
  }));
}

setInterval(() => {
  if (!workingSince || $('cc').hidden) return;
  const secs = Math.round((Date.now() - workingSince) / 1000);
  $('cc-working-time').textContent = secs < 60 ? `${secs}s` : `${Math.floor(secs / 60)}m ${secs % 60}s`;
}, 1000);

window.addEventListener('resize', () => { moveGlider(); });

// Double-click the title to rename the session.
$('jc-title').addEventListener('dblclick', () => {
  const t = currentTask();
  if (!t) return;
  const h = $('jc-title');
  renaming = t.id;
  h.contentEditable = 'true';
  h.focus();
  document.getSelection().selectAllChildren(h);
});
$('jc-title').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); $('jc-title').blur(); }
  if (e.key === 'Escape') { $('jc-title').contentEditable = 'false'; renderHeader(currentTask()); }
});
$('jc-title').addEventListener('blur', () => {
  const h = $('jc-title');
  if (h.contentEditable !== 'true') return;
  h.contentEditable = 'false';
  const t = currentTask();
  const title = h.textContent.trim();
  if (t && title && title !== (t.title || t.prompt)) send({ type: 'task_rename', id: t.id, title });
});

// here: in this window's own pane, wherever a split has the focus.
function selectTask(id, here = false) {
  if (!here && jcSplit && jcSplit.take(id)) return;
  const previous = ccSelected;
  ccSelected = id;
  featureEvent({ type: 'jc_select', id, previous });  // (the composer still holds previous's draft)
  const t = currentTask();
  if (t && t.folder !== deckProject) { openProjects.add(t.folder); selectProject(t.folder); }
  $('deck-timeline').replaceChildren();
  live.text = null;
  live.thinking = null;
  recall.index = -1;
  closeJcFind();
  // What the window already heard of it, drawn at once; the hub's whole copy replaces it.
  const known = codeStore ? codeStore.transcript(id) : [];
  if (known.length) replayTranscript(known);
  send({ type: 'task_transcript', id });
  send({ type: 'task_context', id });
  renderCC(ccTasks);
  if (currentPane) renderPaneBody();
  if (!inSplitPane || document.hasFocus()) $('deck-input').focus();  // (split view's pane: only while it has the focus)
}

function newSession(voice) {
  if (!deckProject) return;
  awaitingNewSession = true;
  if (voice) send({ type: 'voicecode_start', directory: deckProject });
  else send({ type: 'task_new', directory: deckProject, prompt: '', ...takePending(), ...featureSessionFields() });
}
$('cc-start-voice').addEventListener('click', () => newSession(true));
$('cc-start-typed').addEventListener('click', () => newSession(false));
$('jc-new').addEventListener('click', () => newSession(false));
document.querySelectorAll('.jc-starter').forEach((b) => b.addEventListener('click', () => {
  $('deck-input').value = b.dataset.say;
  $('deck-composer').requestSubmit();
}));

// ── the transcript ──

function copyButton(getText) {
  const b = el('button', 'jc-mini jc-copy', 'Copy');
  b.type = 'button';
  b.addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(getText()); b.textContent = 'Copied'; } catch (_) { b.textContent = 'Couldn’t copy'; }
    setTimeout(() => { b.textContent = 'Copy'; }, 1400);
  });
  return b;
}

// Markdown-lite: code fences become <pre> (with Copy), `code` and **bold** inline. DOM only.
// A feature's fuller Markdown (registerRichText) draws it instead, when there is one.
function richText(text) {
  if (featureRichText) {
    try { const drawn = featureRichText(text); if (drawn) return drawn; } catch (err) { console.error('feature rich text', err); }
  }
  const box = mine(el('div', 'jc-md'));
  String(text || '').split('```').forEach((part, i) => {
    if (i % 2) {
      const code = part.replace(/^[\w+-]*\n/, '');
      const pre = el('pre', '', code);
      pre.append(copyButton(() => code));
      box.append(pre);
      return;
    }
    for (const para of part.split(/\n{2,}/)) {
      if (!para.trim()) continue;
      const p = el('p');
      for (const bit of para.split(/(`[^`]+`|\*\*[^*]+\*\*)/)) {
        if (bit.startsWith('`') && bit.endsWith('`') && bit.length > 2) p.append(el('code', '', bit.slice(1, -1)));
        else if (bit.startsWith('**') && bit.endsWith('**') && bit.length > 4) p.append(el('strong', '', bit.slice(2, -2)));
        else p.append(document.createTextNode(bit));
      }
      box.append(p);
    }
  });
  return box;
}

function diffBlock(text) {
  const pre = el('pre', 'jc-code');
  for (const line of String(text || '').split('\n')) {
    const cls = /^\+(?!\+\+)/.test(line) ? 'add' : /^-(?!--)/.test(line) ? 'del' : /^@@/.test(line) ? 'hunk' : '';
    pre.append(cls ? el('span', cls, `${line}\n`) : document.createTextNode(`${line}\n`));
  }
  return pre;
}

const TOOL_VERBS = { Edit: 'Edited', MultiEdit: 'Edited', Write: 'Wrote', Read: 'Read', Bash: 'Ran', Grep: 'Searched', Glob: 'Found files', WebFetch: 'Fetched', WebSearch: 'Searched the web', NotebookEdit: 'Edited notebook', Agent: 'Agent' };

function toolKindClass(tool) {
  if (['Edit', 'MultiEdit', 'Write', 'NotebookEdit'].includes(tool)) return 'edit';
  if (tool === 'Bash') return 'run';
  if (tool === 'Agent') return 'agent';
  return '';
}

function toolArg(e) {
  const detail = e.detail || '';
  if (e.tool === 'Bash') return detail.replace(/^\$ /, '').split('\n')[0];
  if (['Edit', 'MultiEdit', 'Write', 'NotebookEdit'].includes(e.tool)) return detail.split('\n')[0].replace(' (new contents)', '');
  return e.text.replace(/^(Reading|Searching for|Editing|Writing|Running)\s*/, '');
}

function toolState(li, status) {
  const st = li.querySelector('.jc-tstate');
  if (!st) return;
  st.className = `jc-tstate ${status}`;
  st.textContent = status === 'running' ? '' : status === 'failed' ? 'Failed' : '✓';
}

function toolEntry(e) {
  const li = el('li', 'jc-toolwrap');
  li.dataset.toolId = e.tool_id || '';
  const det = el('details', 'jc-tool-row');
  const sum = el('summary');
  const icon = el('span', `jc-ticon ${toolKindClass(e.tool)}`, { Bash: '›_', Read: '≡', Grep: '⌕', Glob: '⌕', WebFetch: '↗', WebSearch: '⌕', Edit: '✎', MultiEdit: '✎', Write: '+', NotebookEdit: '✎' }[e.tool] || '•');
  const label = el('span', 'jc-tlabel');
  label.append(document.createTextNode(`${TOOL_VERBS[e.tool] || e.tool} `), el('code', '', toolArg(e).slice(0, 140)));
  sum.append(icon, label, el('span', 'jc-tstate'));
  det.append(sum);
  const body = el('div', 'jc-tbody');
  if (['Edit', 'MultiEdit', 'Write'].includes(e.tool) && e.detail) body.append(diffBlock(e.detail.split('\n').slice(1).join('\n')));
  const out = el('pre', 'jc-code jc-out', e.output || '');
  out.hidden = !e.output;
  body.append(out);
  det.append(body);
  li.append(det);
  toolState(li, e.status || 'done');
  return li;
}

function agentEntry(e) {
  const li = el('li', 'jc-agent');
  li.dataset.toolId = e.tool_id || '';
  const head = el('div', 'jc-agent-head');
  head.append(el('span', 'jc-badge', `Agent · ${e.agent || 'general'}`), mine(el('span', 'jc-tlabel', e.text.replace(/^Agent:\s*/, ''))), el('span', 'jc-tstate'));
  li.append(head, el('ul', 'jc-agent-steps'));
  const out = mine(el('div', 'jc-md jc-out'));
  out.hidden = true;
  li.append(out);
  toolState(li, e.status || 'done');
  return li;
}

const live = { text: null, thinking: null, frame: 0, raw: '', drawnAt: 0 };
const TIMELINE_MAX = 400;  // what the hub keeps of a session (tasks.py); the window keeps no more

// The transcript follows the newest entry only while the reader is at the bottom. That is
// read once per frame, before the frame's first change, and the scroll is written once
// after it: reading it after every insert laid out the whole transcript each time.
// how: 'follow' (only if at the bottom), 'show' (always, gliding) or 'jump' (always, at once:
// a session opening lands on its newest entry instead of gliding through all of them).
const follow = { frame: 0, bottom: true, jump: false };
function followBottom(how = 'follow') {
  const box = $('cc-scroll');
  if (how !== 'follow') follow.bottom = true;
  if (how === 'jump') follow.jump = true;
  if (follow.frame) return;
  if (how === 'follow') follow.bottom = box.scrollHeight - box.scrollTop - box.clientHeight < 140;
  follow.frame = requestAnimationFrame(() => {
    follow.frame = 0;
    if (follow.bottom) box.scrollTo({ top: box.scrollHeight, behavior: follow.jump ? 'instant' : 'auto' });
    follow.jump = false;
  });
}

// A session's transcript as the hub sends it on opening: built without a layout per entry.
function replayTranscript(entries) {
  $('deck-timeline').replaceChildren();
  live.text = null;
  live.thinking = null;
  for (const e of entries.slice(-TIMELINE_MAX)) appendEntry(e, true);
  renderInlineApprovals();
  followBottom('jump');
}

function appendEntry(e, replaying = false) {
  const tl = $('deck-timeline');
  if (!replaying) followBottom();
  let li;
  if (e.role === 'user') {
    li = el('li', 'jc-user');
    li.append(mine(el('span', 'jc-user-text', e.text)));
    li.dataset.n = e.n || '';
    if (e.images) li.append(el('span', 'jc-pics', `🖼 ${e.images} image${e.images === 1 ? '' : 's'}`));
    if (e.files && e.files.length) li.append(el('span', 'jc-pics', `📄 ${e.files.join(', ')}`));
    li.append(userActions(e));
  } else if (e.role === 'assistant') {
    if (live.text) { live.text.remove(); live.text = null; }
    li = el('li', 'jc-say');
    li.dataset.raw = e.text;
    li.append(richText(e.text), copyButton(() => e.text));
  } else if (e.role === 'thinking') {
    if (live.thinking) { live.thinking.remove(); live.thinking = null; }
    li = el('li');
    const det = el('details', 'jc-think');
    det.append(el('summary', '', 'Thinking'), mine(el('div', '', e.text)));
    li.append(det);
  } else if (e.role === 'tool' && e.tool === 'Agent') {
    li = agentEntry(e);
  } else if (e.role === 'tool' && e.tool) {
    li = toolEntry(e);
  } else if (e.role === 'subtool') {
    const agent = byToolId(tl, '.jc-agent', e.parent);
    if (agent) { agent.querySelector('.jc-agent-steps').append(mine(el('li', '', e.text))); return; }
    li = el('li', 'jc-note');
    li.append(document.createTextNode('↳ '), mine(el('span', '', e.text)));
  } else if (e.role === 'todos') {
    li = el('li', 'jc-inline-todos');
    li.append(checklist(e.todos || []));
  } else if (e.role === 'plan') {
    li = el('li', 'jc-plan');
    li.append(el('p', 'jc-plan-head', 'Plan'), richText(e.text));
  } else if (e.role === 'turn') {
    const parts = [e.seconds ? `${e.seconds}s` : '', e.tokens ? `${(e.tokens / 1000).toFixed(1)}k tokens` : '', e.cost ? `$${e.cost.toFixed(2)}` : ''].filter(Boolean);
    if (!parts.length) return;
    li = el('li', 'jc-turn', parts.join(' · '));
  } else if (featureEntries.has(e.role)) {
    try { li = featureEntries.get(e.role)(e); } catch (err) { console.error('feature entry', e.role, err); }
    if (!li) return;
  } else {
    li = el('li', 'jc-note');
    li.append(el('span', '', e.role === 'note' ? '⎿' : 'ⓘ'), el('span', '', e.text));
  }
  for (const decorate of featureDecorators) {
    try { decorate(e, li); } catch (err) { console.error('feature entry decorator', err); }
  }
  tl.insertBefore(li, tl.querySelector(':scope > .jc-ask'));
  $('cc-welcome').hidden = true;
  // Oldest out first; approval sheets and the live reply sit at the end and stay. The sheets
  // are counted from this entry on (it went in before the first of them), not by a second
  // walk through the inside of every entry: a transcript is hundreds of them.
  let sheets = 0;
  for (let n = li; n; n = n.nextElementSibling) if (n.classList.contains('jc-ask')) sheets++;
  const keep = TIMELINE_MAX + sheets + (live.text ? 1 : 0) + (live.thinking ? 1 : 0);
  while (tl.childElementCount > keep) tl.firstElementChild.remove();
}

// The first element under root matching selector whose data-tool-id is id (a string; any
// other id matches nothing), as [...root.querySelectorAll(selector)].find() would give it,
// without listing every step of the transcript first.
function byToolId(root, selector, id) {
  return typeof id === 'string' ? root.querySelector(`${selector}[data-tool-id="${CSS.escape(id)}"]`) : null;
}

const ACT_ICONS = {
  rewind: '<svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3.5 6.5A5 5 0 1 1 3 9.5"/><path d="M3 2.8v3.9h3.9"/></svg>',
  fork: '<svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true"><circle cx="4.5" cy="3.5" r="1.6"/><circle cx="11.5" cy="3.5" r="1.6"/><circle cx="8" cy="12.5" r="1.6"/><path d="M4.5 5.1v1.4c0 1.5 1.2 2.5 3.5 2.5s3.5-1 3.5-2.5V5.1M8 9v1.9"/></svg>',
};
const ACT_WAIT = 'Ready once Claude Code has taken this message';

// Under a message of yours, on hover: put the files back as they were before it (a second
// click confirms), or start a new session from just before it.
function userActions(e) {
  const wrap = el('span', 'jc-user-actions');
  const button = (kind, label, title) => {
    const b = el('button', `jc-act ${kind}`);
    b.type = 'button';
    b.dataset.title = title;
    b.insertAdjacentHTML('beforeend', ACT_ICONS[kind]);
    b.append(el('span', 'jc-act-label', label));
    return b;
  };
  const rewind = button('rewind', 'Rewind', 'Put the files back as they were before this message');
  const fork = button('fork', 'Fork', 'A new session from just before this message');
  const uuid = () => { const li = wrap.closest('li'); return li ? li.dataset.uuid : ''; };
  let armed = 0;
  const disarm = () => { clearTimeout(armed); armed = 0; rewind.classList.remove('armed'); rewind.querySelector('.jc-act-label').textContent = tr('Rewind'); };
  rewind.addEventListener('click', () => {
    if (!uuid()) return;
    if (!armed) {
      rewind.classList.add('armed');
      rewind.querySelector('.jc-act-label').textContent = tr('Click to rewind files');
      armed = setTimeout(disarm, 3500);
      return;
    }
    disarm();
    send({ type: 'task_rewind', id: ccSelected, uuid: uuid() });
  });
  rewind.addEventListener('mouseleave', () => { if (armed) disarm(); });
  fork.addEventListener('click', () => { if (uuid()) { awaitingNewSession = true; send({ type: 'task_fork', id: ccSelected, uuid: uuid() }); } });
  wrap.append(rewind, fork);
  requestAnimationFrame(() => {
    const li = wrap.closest('li');
    if (li && e.uuid) li.dataset.uuid = e.uuid;
    actionsReady(wrap, !!(li && li.dataset.uuid));
  });
  return wrap;
}

function actionsReady(wrap, ready) {
  for (const b of wrap.querySelectorAll('.jc-act')) {
    b.disabled = !ready;
    b.title = tr(ready ? b.dataset.title : ACT_WAIT);
  }
}

function onEntryMeta(ev) {
  if (ev.id !== ccSelected) return;
  const li = [...$('deck-timeline').querySelectorAll('.jc-user')].find((n) => String(n.dataset.n) === String(ev.n));
  if (!li) return;
  li.dataset.uuid = ev.uuid;
  const wrap = li.querySelector('.jc-user-actions');
  if (wrap) actionsReady(wrap, true);
}

function updateEntry(ev) {
  const li = byToolId($('deck-timeline'), '', ev.tool_id);
  if (!li) return;
  toolState(li, ev.status);
  const out = li.querySelector('.jc-out');
  if (out && ev.output && !li.querySelector('.jc-code:not(.jc-out)')) {
    if (li.classList.contains('jc-agent')) out.replaceChildren(richText(ev.output));
    else out.textContent = ev.output;
    out.hidden = false;
  }
}

// Claude's words (and thinking) as they're written.
function onStream(ev) {
  if (ev.id !== ccSelected) return;
  const tl = $('deck-timeline');
  followBottom();
  if (ev.part === 'thinking') {
    if (!live.thinking) {
      live.thinking = el('li', 'jc-think');
      live.thinking.append(el('span', 'jc-sheen', 'Thinking… '), el('span', 'jc-dim'));
      tl.insertBefore(live.thinking, tl.querySelector('.jc-ask'));
    }
    const tail = live.thinking.lastChild;
    tail.textContent = (tail.textContent + ev.text).slice(-220);
  } else {
    if (live.thinking) { live.thinking.remove(); live.thinking = null; }
    if (!live.text) {
      live.text = el('li', 'jc-say live');
      live.raw = '';
      tl.insertBefore(live.text, tl.querySelector(':scope > .jc-ask'));
    }
    live.raw += ev.text;
    if (!live.frame) {
      // At most one redraw per frame, not per token; and a long reply redraws less often
      // (1 ms more per 200 characters, at least every half second), since each redraw is
      // of the whole reply so far. Nothing is drawn while the panel is closed.
      const wait = Math.min(500, live.raw.length / 200) - (performance.now() - live.drawnAt);
      const draw = () => {
        live.frame = 0;
        if (!live.text || $('cc').hidden) return;
        live.text.replaceChildren(richText(live.raw));
        live.drawnAt = performance.now();
        followBottom();
      };
      live.frame = wait > 16 ? setTimeout(() => requestAnimationFrame(draw), wait) : requestAnimationFrame(draw);
    }
  }
  $('cc-welcome').hidden = true;
}

// An approval, as a sheet in the conversation: capsule answers, number keys, and a
// "tell Claude what to do instead" box for no. Only a new approval gets a sheet and only an
// answered one loses it: rebuilding every sheet on each approval event (from any session,
// or JARVIS itself) wiped a reason being typed and dropped the focus to the page, where the
// next digit typed answered the approval.
function renderInlineApprovals() {
  const tl = $('deck-timeline');
  const want = [...pendingApprovals.values()].filter((a) => a.task_id === ccSelected);
  const ids = new Set(want.map((a) => a.id));
  tl.querySelectorAll(':scope > .jc-ask').forEach((n) => { if (!ids.has(n.dataset.approval)) n.remove(); });
  let added = false;
  for (const a of want) {
    if (tl.querySelector(`:scope > .jc-ask[data-approval="${CSS.escape(a.id)}"]`)) continue;
    tl.append(approvalSheet(a));
    added = true;
  }
  if (!added) return;
  $('cc-welcome').hidden = true;
  const first = tl.querySelector(':scope > .jc-ask .jc-choices button');
  if (first && document.activeElement === $('deck-input') && !$('deck-input').value) first.focus();
  followBottom('show');
}

function approvalSheet(a) {
  const custom = featureApproval(a, 'sheet', (choice, feedback) => answerApproval(a, choice, feedback));
  if (custom) { custom.classList.add('jc-ask'); custom.dataset.approval = a.id; return custom; }
  const li = el('li', 'jc-ask');
  li.dataset.approval = a.id;
  const title = a.ask_kind === 'plan' ? 'Ready to code?' : a.ask_kind === 'question' ? a.question : a.tool === 'Bash' ? 'Run this command?' : a.tool === 'Write' ? 'Create this file?' : ['Edit', 'MultiEdit'].includes(a.tool) ? 'Make this edit?' : a.question;
  const head = el('p', 'jc-ask-head');
  head.append(el('span', `jc-ticon ${toolKindClass(a.tool)}`, a.ask_kind === 'plan' ? '☰' : a.ask_kind === 'question' ? '?' : a.tool === 'Bash' ? '›_' : '✎'), el('span', '', title));
  li.append(head);
  if (a.detail) li.append(a.ask_kind === 'plan' ? richText(a.detail) : a.ask_kind === 'question' ? el('p', 'jc-dim', '') : diffBlock(a.detail));
  const row = el('div', 'jc-choices');
  const feedback = el('div', 'jc-feedback');
  feedback.hidden = true;
  const input = el('input', 'jc-field');
  input.placeholder = 'Tell Claude what to do instead (optional)';
  const sendNo = el('button', 'jc-btn small', 'Send');
  sendNo.type = 'button';
  feedback.append(input, sendNo);
  let withReason = 'deny'; // "No" and "Keep planning" can both carry a reason
  a.choices.forEach((c, i) => {
    const b = el('button', `jc-btn small ${i === 0 ? 'filled' : ''}`);
    b.type = 'button';
    b.append(el('kbd', '', String(i + 1)), document.createTextNode(c.label));
    b.addEventListener('click', () => {
      if (c.id === 'deny' || c.id === 'plan_keep') {
        withReason = c.id;
        input.placeholder = c.id === 'plan_keep' ? 'What should the plan change? (optional)' : 'Tell Claude what to do instead (optional)';
        feedback.hidden = false;
        input.focus();
        return;
      }
      answerApproval(a, c.id);
    });
    row.append(b);
  });
  sendNo.addEventListener('click', () => answerApproval(a, withReason, input.value));
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); answerApproval(a, withReason, input.value); } });
  li.append(row, feedback, el('p', 'jc-ask-hint', 'Press a number, or just say “yes”, “no, …”, “always” or “allow all edits”.'));
  return li;
}

// Follow-ups waiting for the current step, newest last; ✕ takes one back unsent.
function renderQueue(t) {
  const items = (t && t.queue) || [];
  const list = $('jc-queue');
  list.hidden = !items.length;
  $('jc-steer').hidden = !(t && t.steerable);
  const more = t && t.queued > items.length ? t.queued - items.length : 0;
  list.replaceChildren(...items.map((q) => {
    const li = el('li', 'jc-queued');
    li.append(el('span', 'jc-queued-kicker', 'Queued'), q.text ? mine(el('span', 'jc-queued-text', q.text)) : el('span', 'jc-queued-text', q.images ? `${q.images} image${q.images === 1 ? '' : 's'}` : ''));
    const x = el('button', 'jc-queued-x', '✕');
    x.type = 'button';
    x.setAttribute('aria-label', 'Don’t send this');
    x.addEventListener('click', () => send({ type: 'task_unqueue', id: t.id, item: q.id }));
    if (t.steerable) {
      const now = el('button', 'jc-queued-steer', 'Steer now');
      now.type = 'button';
      now.title = 'Send it into the running step now, without stopping it';
      now.addEventListener('click', () => send({ type: 'task_steer', id: t.id, item: q.id }));
      li.append(now);
    }
    li.append(x);
    return li;
  }));
  if (more) list.append(el('li', 'jc-queued', `and ${more} more waiting`));
}

// An approval answers only once it has been up a moment, and not right after another answer:
// the second click of a double-click, or a card that has just slid (or arrived) under the
// pointer, never answers what the owner didn't read.
const APPROVAL_SETTLE = 400;  // ms
const approvalSeen = new Map();  // approval id -> when the window first showed it
let approvalAnsweredAt = -Infinity;
function approvalShown(id) { if (!approvalSeen.has(id)) approvalSeen.set(id, performance.now()); }

function answerApproval(a, choice, feedback, deliberate = false) {
  const now = performance.now();
  // (deliberate: a notification's own button, not a pointer or key in the window: no settle)
  if (!deliberate && (now - approvalAnsweredAt < APPROVAL_SETTLE || now - (approvalSeen.get(a.id) ?? -Infinity) < APPROVAL_SETTLE)) return;
  const go = () => {
    approvalAnsweredAt = performance.now();  // (one a check turned down can be tried again at once)
    send({ type: 'approve', id: a.id, choice, feedback: feedback || '' });
    document.querySelectorAll(`[data-approval="${CSS.escape(a.id)}"]`).forEach((n) => n.remove());
  };
  const check = featureCheck('approve', { approval: a, choice });
  if (check) check.then((ok) => { if (ok) go(); }); else go();
}

// ── the composer: messages, / commands, @ files, pictures ──

const SLASH_COMMANDS = [
  ['plan', 'Plan first, you approve'], ['manual', 'Ask before each edit and command'], ['edits', 'Accept edits automatically'],
  ['auto', 'Auto: a safety check decides what to ask'], ['bypass', 'Bypass permissions: run anything'],
  ['ultracode', 'Multi-agent workflows for big tasks, on or off'], ['add-dir', 'Add a folder to this session'],
  ['settings', 'Jarvis Code settings'], ['undo', 'Undo the last round of file changes'], ['diff', 'Show what changed'],
  ['commit', 'Commit the changes'], ['pr', 'Push and open a pull request'], ['test', 'Run the tests'],
  ['compact', 'Compact the conversation'], ['context', 'Context window used'], ['cost', 'What this session has cost'],
  ['model', 'Switch model: /model sonnet'], ['effort', 'How hard it thinks: /effort high'], ['fork', 'Fork this session'],
  ['rename', 'Rename: /rename New name'], ['export', 'Save the transcript as Markdown'], ['files', 'Browse the project'],
  ['terminal', 'Open a terminal here'], ['mcp', 'MCP servers'], ['permissions', 'Commands it won’t ask about again'],
  ['init', 'Write a CLAUDE.md for this project'], ['review', 'Review the changes'], ['new', 'New session in this project'],
  ['voice', 'Voice coding on or off'], ['stop', 'Interrupt the current step'],
  ['resume', 'Resume a past session'], ['rewind', 'Put the files back to before a message'],
  ['copy', 'Copy the last reply'], ['memory', 'Open this project’s CLAUDE.md'], ['todos', 'The to-do list'],
  ['status', 'What it’s doing now'], ['agents', 'Subagents set up here'], ['hooks', 'Hooks set up here'],
  ['help', 'Commands and shortcuts'],
];
// What typing ? in an empty composer lists, as in Claude Code.
const JC_KEYS = [
  ['⏎', 'Send'], ['⇧⏎', 'New line'], ['⌘⏎', 'Steer: into the running step'], ['↑ ↓', 'Your earlier messages'],
  ['⇧⇥', 'Switch permission mode'], ['⌘⇧I', 'Model'], ['⌘⇧E', 'Effort'], ['⌘U', 'Attach files'],
  ['⌘F', 'Search the transcript'], ['⌘⇧F', 'Project files'], ['⌘,', 'Settings'],
  ['Esc', 'Interrupt, or close a menu or pane'], ['1–9', 'Answer an approval'], ['/', 'Commands'],
  ['@', 'Mention a file'], ['!', 'Run a shell command'], ['#', 'Save a note to CLAUDE.md'],
];
const projectFiles = {};
const customSlash = {};  // project -> its and the user's custom commands and skills
let pickIndex = 0;
let attachments = [];

function suggestions() {
  const input = $('deck-input');
  const v = input.value.slice(0, input.selectionStart);
  if (input.value === '?') return { kind: 'keys', items: JC_KEYS.map(([key, help]) => ({ label: key, help, value: '' })) };
  if (/^\/[\w.:-]*$/.test(v)) {
    const q = v.slice(1).toLowerCase();
    if (deckProject && !customSlash[deckProject]) { customSlash[deckProject] = []; send({ type: 'slash_list', directory: deckProject }); }
    const ours = new Set(SLASH_COMMANDS.map(([name]) => name));
    const features = [...featureSlash.values()].filter((c) => !ours.has(c.name));
    features.forEach((c) => ours.add(c.name));
    const custom = (customSlash[deckProject] || []).filter((c) => !ours.has(c.name.toLowerCase()));
    return {
      kind: 'slash',
      items: [
        ...SLASH_COMMANDS.filter(([name]) => name.startsWith(q)).map(([name, help]) => ({ label: `/${name}`, help, value: name })),
        ...features.filter((c) => c.name.startsWith(q)).map((c) => ({ label: `/${c.name}`, help: c.help || '', value: c.name, feature: c })),
        ...custom.filter((c) => c.name.toLowerCase().startsWith(q)).map((c) => ({ label: `/${c.name}`, help: `${c.help || ''}${c.help ? ' · ' : ''}${c.scope}`, value: c.name, custom: true })),
      ].slice(0, 60),
    };
  }
  const m = v.match(/(?:^|\s)@([\w./-]*)$/);
  if (m) {
    const q = m[1].toLowerCase();
    const files = (projectFiles[deckProject] || []).filter((f) => f.toLowerCase().includes(q)).sort((x, y) => x.length - y.length).slice(0, 12);
    const more = featureMentions.flatMap((suggest) => { try { return suggest(m[1], v) || []; } catch (err) { console.error('feature mentions', err); return []; } });
    return { kind: 'at', query: m[1], items: [...more, ...files.map((f) => ({ label: f, help: '', value: f }))].slice(0, 16) };
  }
  return { kind: '', items: [] };
}

function renderSuggestions() {
  const s = suggestions();
  const box = $('cc-slash');
  box.hidden = !s.items.length;
  pickIndex = Math.min(pickIndex, Math.max(0, s.items.length - 1));
  box.replaceChildren(...s.items.map((item, i) => {
    const b = el('button', i === pickIndex ? 'active' : '');
    b.type = 'button';
    b.setAttribute('role', 'option');
    if (s.kind === 'at') {
      b.append(el('code', '', item.label));
      if (item.help) { const help = el('span', '', item.help); help.setAttribute('data-no-i18n', ''); b.append(help); }
    } else b.append(el('strong', '', item.label), el('span', '', item.help));
    b.addEventListener('mousedown', (e) => { e.preventDefault(); pick(s, item); });
    return b;
  }));
}

function pick(s, item) {
  const input = $('deck-input');
  if (s.kind === 'keys') {  // a list to read, not to pick from
    input.value = '';
    $('cc-slash').hidden = true;
    input.focus();
    return;
  }
  if (s.kind === 'slash' && item.feature && item.feature.insert !== undefined) {  // a snippet: its words, to edit
    input.value = item.feature.insert;
    input.selectionStart = input.selectionEnd = input.value.length;
    input.dispatchEvent(new Event('input'));  // (its height)
    $('cc-slash').hidden = true;
    input.focus();
    return;
  }
  if (s.kind === 'slash') {
    const needsArg = item.custom || (item.feature && item.feature.needsArg) || ['model', 'effort', 'rename'].includes(item.value);
    input.value = `/${item.value}${needsArg ? ' ' : ''}`;
    $('cc-slash').hidden = true;
    if (!needsArg) $('deck-composer').requestSubmit();
    else input.focus();
    return;
  }
  const before = input.value.slice(0, input.selectionStart).replace(/@[\w./-]*$/, `@${item.value} `);
  input.value = before + input.value.slice(input.selectionStart);
  input.selectionStart = input.selectionEnd = before.length;
  $('cc-slash').hidden = true;
  input.focus();
}

// /copy: the last reply, as Claude wrote it (Markdown and all).
async function copyLastReply() {
  const last = [...$('deck-timeline').querySelectorAll(':scope > .jc-say[data-raw]')].pop();
  if (!last) { jcNote('There’s no reply to copy yet.'); return; }
  try { await navigator.clipboard.writeText(last.dataset.raw); jcNote('Copied the last reply.'); } catch (_) { jcNote('Couldn’t copy the reply.'); }
}

// /resume: this project's past sessions, as the welcome lists them.
function resumeMenu() {
  if (!deckProject) return;
  if (!pastSessions.length) {
    send({ type: 'claude_sessions', directory: deckProject });
    jcNote('Looking for past sessions in this project…');
    return;
  }
  openMenu($('jc-plus'), [
    { heading: 'Resume a session' },
    ...pastSessions.slice(0, 12).map((p) => ({
      label: p.title || 'Untitled session', mine: !!p.title,
      note: new Date(p.last_modified).toLocaleString(uiLocale(), { dateStyle: 'medium', timeStyle: 'short' }),
      run: () => resumeSession(deckProject, p),
    })),
  ]);
}

// /rewind: the messages it can put the files back to before, newest first.
function rewindMenu() {
  const t = currentTask();
  const points = [...$('deck-timeline').querySelectorAll(':scope > .jc-user[data-uuid]')].reverse().slice(0, 12);
  if (!t || !points.length) { jcNote('Nothing to rewind to yet: send a message first.'); return; }
  openMenu($('jc-plus'), [
    { heading: 'Put the files back to before…' },
    ...points.map((li) => ({
      label: (li.querySelector('.jc-user-text') || li).textContent.slice(0, 70), mine: true,
      run: () => send({ type: 'task_rewind', id: t.id, uuid: li.dataset.uuid }),
    })),
  ]);
}

// ↑ and ↓ in the composer step through your earlier messages in this session.
const recall = { index: -1, draft: '' };
function recallMessage(step) {
  const input = $('deck-input');
  const said = [...$('deck-timeline').querySelectorAll(':scope > .jc-user .jc-user-text')].map((n) => n.textContent);
  if (!said.length) return false;
  if (recall.index < 0) { if (step > 0) return false; recall.draft = input.value; }
  const next = recall.index < 0 ? said.length - 1 : recall.index + step;
  if (next < 0) return true;  // at the oldest: stay there
  if (next >= said.length) { recall.index = -1; input.value = recall.draft; } else { recall.index = next; input.value = said[next]; }
  input.selectionStart = input.selectionEnd = input.value.length;
  return true;
}

const SLASH_MODE_IDS = { manual: 'ask', ask: 'ask', edits: 'edits', auto: 'smart', bypass: 'auto', plan: 'plan' };
// With no session open yet, these work on their own; a mode command starts the session in
// that mode ("/plan add a cache": planning that). Anything else starts one with it.
const SLASH_WITHOUT_SESSION = new Set(['files', 'terminal', 'help', 'resume', 'memory', 'settings', 'config', 'effort', 'ultracode', 'add-dir']);
function slashWithoutSession(text) {
  const [word, ...rest] = text.slice(1).split(/\s+/);
  const name = word.toLowerCase();
  const arg = rest.join(' ').trim();
  if (!name) return true;  // a bare slash: nothing to start
  if (SLASH_MODE_IDS[name]) {
    const mode = SLASH_MODE_IDS[name];
    if (mode === 'smart' && !autoCapable(composerState().modelId)) { jcNote('Auto needs Opus, Sonnet or Fable. Pick one of them first.'); return true; }
    const msg = { type: 'task_new', directory: deckProject, prompt: arg, mode, add_dirs: [...pending.dirs], plugins: [...pending.plugins], ...featureSessionFields() };
    const start = () => { if (!send(msg)) return unsent(); takePending(); awaitingNewSession = true; return true; };
    if (mode === 'auto') { confirmBypass('bypass', 'Bypass permissions lets Jarvis Code run any command and change any file without asking you. Use it only for a project you could lose. Switch?', start); return true; }
    return start();
  }
  if (name === 'model' && !arg) { modelMenu(); return true; }
  if (SLASH_WITHOUT_SESSION.has(name)) { localSlash(text); return true; }
  const featured = featureSlash.get(name);
  if (featured && (featured.insert !== undefined || featured.withoutSession)) return runFeatureSlash(featured, arg, null);
  return false;
}

function localSlash(text) {
  const [name, ...rest] = text.slice(1).split(' ');
  const arg = rest.join(' ').trim();
  const t = currentTask();
  switch (name) {
    case 'files': openPane('files'); return true;
    case 'help': setTimeout(showSlash); return true;  // once the composer has been cleared
    case 'copy': copyLastReply(); return true;
    case 'resume': resumeMenu(); return true;
    case 'rewind': if (t) rewindMenu(); return true;
    case 'memory':
      openPane('files');
      fileView = { path: 'CLAUDE.md' };
      send({ type: 'file_read', directory: deckProject, path: 'CLAUDE.md' });
      drawViewer();
      return true;
    case 'terminal': openPane('terminal'); return true;
    case 'mcp': openPane('mcp'); return true;
    case 'permissions': openPane('rules'); return true;
    case 'diff': openPane('diff'); return false;  // also says it out loud / in the log
    case 'fork': if (t) { awaitingNewSession = true; send({ type: 'task_fork', id: t.id }); } return true;
    case 'rename':
      if (t && arg) send({ type: 'task_rename', id: t.id, title: arg });
      else if (t) $('jc-title').dispatchEvent(new MouseEvent('dblclick'));  // name it in place
      return true;
    case 'export': if (t) send({ type: 'task_export', id: t.id }); return true;
    case 'effort':
      if (arg === 'ultracode') applyEffort(5);
      else if (arg && EFFORTS.includes(arg)) applyEffort(EFFORTS.indexOf(arg));
      else openEffort();
      return true;
    case 'ultracode': applyEffort(composerState().ultracode ? EFFORTS.indexOf('high') : 5); return true;
    case 'settings': case 'config': openJcSettings('general'); return true;
    case 'manual': case 'ask': case 'edits': case 'auto': case 'bypass': case 'plan': {
      const mode = SLASH_MODE_IDS[name];
      if (name === 'plan' && arg) return false;  // "/plan the migration": plan mode, then that ask
      setMode(mode);
      return true;
    }
    case 'add-dir': addCodeFolder(); return true;
    case 'model': if (!arg) { modelMenu(); return true; } return false;
    case 'init': if (t) send({ type: 'task_send', id: t.id, plain: true, text: 'Look over this project and write (or update) a CLAUDE.md at its root that orients a new contributor: how to build, test and lint, the layout, and the conventions.' }); return true;
    case 'review': if (t) send({ type: 'task_send', id: t.id, plain: true, text: 'Review the uncommitted changes in this project for bugs, security problems and anything that breaks existing behavior. List findings by severity.' }); return true;
    default: {
      const command = featureSlash.get(name.toLowerCase());  // a feature's: /btw, /goal, a snippet
      return command ? runFeatureSlash(command, arg, t) : false;
    }
  }
}

// A feature's / command typed out in full: it runs, or a snippet puts its words in the
// composer (once the command typed there has been cleared). False: not handled here.
function runFeatureSlash(command, arg, t) {
  if (command.insert === undefined) return command.run ? command.run(arg, t) !== false : false;
  setTimeout(() => {
    const input = $('deck-input');
    input.value = command.insert;
    input.dispatchEvent(new Event('input'));
    $('cc-slash').hidden = true;
    input.focus();
  });
  return true;
}

// A message that didn't go keeps its text and files in the composer, and says why.
function unsent() {
  jcNote(ws && ws.readyState === WebSocket.OPEN
    ? 'That message is too big to send. Take a file or two out and send again.'
    : 'Not connected yet. Your message and files are still here: send again in a moment.');
  return false;
}

// True when the composer can be cleared: the message went, or there was nothing to send.
// steer: true sends it into the running step without stopping it (Cursor's "steer"),
// false queues it; undefined follows the setting.
function sendToSession(text, steer) {
  text = text.trim();
  const images = attachments.map((a) => ({ media_type: a.type, data: a.data, name: a.name }));
  if (!text && !images.length) return true;
  const t = currentTask();
  if (!t) {
    if (!deckProject) return false;
    if (text.startsWith('/') && !images.length && slashWithoutSession(text)) return true;
    const extra = { add_dirs: [...pending.dirs], plugins: [...pending.plugins] };
    if (!send({ type: 'task_new', directory: deckProject, prompt: text, images, ...extra, ...featureSessionFields() })) return unsent();
    takePending();  // the folders and plugins went with it
    clearAttachments();
    awaitingNewSession = true;
    return true;
  }
  if (text.startsWith('/') && !images.length) {
    if (localSlash(text)) return true;
    if (!send({ type: 'code_command', id: t.id, text })) return unsent();
    if (text === '/new' || text === '/clear') awaitingNewSession = true;
    return true;
  }
  if (text.startsWith('!') && !images.length) { runBang(t, text.slice(1).trim()); return true; }
  if (text.startsWith('#') && !images.length) { saveMemory(t, text.slice(1).trim()); return true; }
  const ran = bangContext.get(t.id);
  if (ran && ran.length) {
    // What the user ran with ! goes to Claude with their next message, as in Claude Code.
    const blocks = ran.map((r) => `$ ${r.command}\n${r.output.trim() || '(no output)'}${r.code ? `\n(exit ${r.code})` : ''}`);
    text = `I ran this in the project first:\n\n\`\`\`\n${blocks.join('\n\n')}\n\`\`\`\n\n${text}`;
  }
  if (!send({ type: 'task_send', id: t.id, text, images, ...(steer === undefined ? {} : { steer }) })) return unsent();
  bangContext.delete(t.id);  // only once it went with this message
  clearAttachments();
  return true;
}

// ! runs a command in the project (its output rides along with the next message); #
// saves a line to the project's CLAUDE.md.
const bangContext = new Map();
const bangEntries = new Map();
let bangRef = 0;

function runBang(t, command) {
  if (!command) return;
  const ref = `b${++bangRef}`;
  const li = el('li', 'jc-bang');
  const head = el('div', 'jc-bang-head');
  head.append(el('span', 'jc-bang-prompt', '$'), el('code', '', command), el('span', 'jc-bang-state', 'Running…'));
  li.append(head);
  $('deck-timeline').append(li);
  $('cc-scroll').scrollTop = $('cc-scroll').scrollHeight;
  bangEntries.set(ref, { li, task: t.id });
  send({ type: 'task_bash', id: t.id, command, ref });
}

function onBang(ev) {
  const entry = bangEntries.get(ev.ref);
  if (!entry) return;
  bangEntries.delete(ev.ref);
  entry.li.querySelector('.jc-bang-state').textContent = ev.code ? `exit ${ev.code}` : 'Done · goes with your next message';
  entry.li.classList.toggle('failed', !!ev.code);
  const out = el('pre', 'jc-bang-out', ev.output || '(no output)');
  entry.li.append(out);
  const list = bangContext.get(entry.task) || [];
  list.push({ command: ev.command, output: (ev.output || '').slice(-8000), code: ev.code });
  bangContext.set(entry.task, list);
}

function saveMemory(t, note) {
  if (!note) return;
  send({ type: 'task_memory', id: t.id, text: note });
}

function onMemory(ev) {
  const li = el('li', 'jc-note', ev.ok ? `Remembered in ${ev.path.split('/').slice(-2).join('/')}: ${ev.text}` : 'Couldn’t save that to CLAUDE.md.');
  $('deck-timeline').append(li);
}

let steerThis; // set for one submit by ⌘↩ or the Steer button
function steerSubmit() {
  const t = currentTask();
  if (!t || !t.steerable) return false;
  steerThis = true;
  $('deck-composer').requestSubmit();
  return true;
}
$('jc-steer').addEventListener('click', steerSubmit);
$('deck-composer').addEventListener('submit', (e) => {
  e.preventDefault();
  const steer = steerThis;
  steerThis = undefined;
  if (!sendToSession($('deck-input').value, steer)) return;  // not sent: the draft stays
  recall.index = -1;
  $('deck-input').value = '';
  $('deck-input').style.height = '';
  $('cc-slash').hidden = true;
});

const MODE_CYCLE = ['ask', 'edits', 'plan', 'smart'];
function nextMode() {
  const s = composerState();
  const cycle = MODE_CYCLE.filter((m) => m !== 'smart' || autoCapable(s.modelId));
  return cycle[(cycle.indexOf(s.mode) + 1) % cycle.length];  // from Bypass: back to Manual
}
$('deck-input').addEventListener('keydown', (e) => {
  const s = suggestions();
  if (s.items.length && !$('cc-slash').hidden) {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); pickIndex = (pickIndex + (e.key === 'ArrowDown' ? 1 : -1) + s.items.length) % s.items.length; renderSuggestions(); return; }
    if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) { e.preventDefault(); pick(s, s.items[pickIndex]); return; }
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); $('cc-slash').hidden = true; return; }
  }
  if (e.key === 'Tab' && e.shiftKey) {  // shift+tab cycles the mode, as in Claude Code
    e.preventDefault();
    setMode(nextMode());
    return;
  }
  if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && !(e.shiftKey || e.metaKey || e.ctrlKey || e.altKey)) {
    const input = e.target;
    const up = e.key === 'ArrowUp';
    const onEdge = up ? !input.value.slice(0, input.selectionStart).includes('\n') : !input.value.slice(input.selectionEnd).includes('\n');
    if ((recall.index >= 0 || (up && !input.value)) && onEdge && recallMessage(up ? -1 : 1)) { e.preventDefault(); return; }
  }
  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && steerSubmit()) { e.preventDefault(); return; }
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); $('deck-composer').requestSubmit(); }
});
$('deck-input').addEventListener('input', () => {
  recall.index = -1;
  pickIndex = 0;
  renderSuggestions();
  $('deck-input').style.height = 'auto';
  $('deck-input').style.height = `${Math.min(220, $('deck-input').scrollHeight)}px`;
});

// Attachments, as Claude Code's "Add files or photos": pictures, PDFs, and text or code
// files (sent as documents with their names). Paste, drop, ⌘U or the + menu.
const TEXT_FILE = /\.(md|markdown|txt|log|json|jsonl|csv|tsv|ya?ml|toml|ini|cfg|conf|xml|html?|css|scss|less|m?js|cjs|tsx?|jsx|vue|svelte|py|pyi|rb|go|rs|java|kt|kts|swift|m|mm|c|h|cc|cpp|hpp|cs|php|pl|lua|r|dart|scala|sh|bash|zsh|fish|sql|graphql|proto|env\.example|gitignore|dockerfile|makefile|gradle|plist|strings|diff|patch)$/i;
const TEXT_TYPES = ['application/json', 'application/xml', 'application/javascript', 'application/x-yaml', 'application/yaml', 'application/toml', 'application/x-sh', 'application/sql'];

function fileKind(file) {
  if (file.type.startsWith('image/')) return 'image';
  if (file.type === 'application/pdf' || /\.pdf$/i.test(file.name)) return 'pdf';
  if (file.type.startsWith('text/') || TEXT_TYPES.includes(file.type) || TEXT_FILE.test(file.name) || /^(Makefile|Dockerfile|Gemfile|Procfile|LICENSE|README)$/i.test(file.name)) return 'text';
  return '';
}
function jcNote(text) { notice('Jarvis Code', '', text, 6000).classList.add('jc-notecard'); }  // (split view's pane shows only these cards)
function sizeText(n) { return n < 1024 ? `${n} B` : n < 1_048_576 ? `${Math.round(n / 1024)} KB` : `${(n / 1_048_576).toFixed(1)} MB`; }

// Files picked and still being read: they count against the limits like attached ones
// (attach.js), so a drop or paste of many files at once can't slip past them.
const reading = new Set();

function addFile(file) {
  if (!file) return;
  const kind = fileKind(file);
  if (!kind) { jcNote(`${file.name} can’t be attached: pictures, PDFs and text or code files only.`); return; }
  // A Retina screenshot is often over the 6 MB limit: it's scaled down first (fitPicture).
  if (kind === 'image' && file.size > window.JarvisAttach.LIMITS.binary && !fittedPictures.has(file)) {
    fitPicture(file).then((fitted) => (fitted ? addFile(fitted) : jcNote(`${file.name} couldn’t be read.`)));
    return;
  }
  const held = [...attachments, ...reading].map((a) => ({ kind: a.kind, size: a.size || 0 }));
  const why = window.JarvisAttach.check(held, kind, file.size);
  if (why === 'files') { jcNote('Up to six attachments per message.'); return; }
  if (why === 'size' && kind === 'text') { jcNote(`${file.name} is over 400 KB. Put it in the project and mention it with @ instead.`); return; }
  if (why === 'size') { jcNote(`${file.name} is over 6 MB.`); return; }
  if (why === 'total') { jcNote(`${file.name} would make this message too big to send. Send it in a message of its own.`); return; }
  const slot = { kind, size: file.size };
  reading.add(slot);
  // It goes with the composer it was dropped on, whichever session shows once it's read.
  const into = attachments;
  const reader = new FileReader();
  reader.onerror = () => { reading.delete(slot); jcNote(`${file.name} couldn’t be read.`); };
  reader.onload = () => {
    reading.delete(slot);
    const result = String(reader.result);
    if (kind === 'text') {
      if (result.includes('\u0000')) { jcNote(`${file.name} isn’t a text file.`); return; }
      into.push({ kind, type: 'text/plain', data: result, name: file.name, size: file.size });
    } else {
      into.push({ kind, type: kind === 'pdf' ? 'application/pdf' : file.type, data: result.split(',', 2)[1], url: kind === 'image' ? result : '', name: file.name, size: file.size });
    }
    if (into === attachments) renderAttachments();
  };
  if (kind === 'text') reader.readAsText(file); else reader.readAsDataURL(file);
}
const addImageFile = addFile;

function removeChip(label, onRemove) {
  const x = el('button', 'jc-chip-x', '×');
  x.type = 'button';
  x.setAttribute('aria-label', `Remove ${label}`);
  x.addEventListener('click', onRemove);
  return x;
}

function renderAttachments() {
  const box = $('jc-attach');
  const chips = attachments.map((a, i) => {
    const drop = () => { attachments.splice(i, 1); renderAttachments(); };
    if (a.kind === 'image' || (!a.kind && a.url)) {
      const t = el('span', 'jc-thumb-img');
      const img = el('img');
      img.src = a.url;
      img.alt = a.name || 'Attached image';
      t.append(img, removeChip(a.name || 'image', drop));
      return t;
    }
    const chip = el('span', 'jc-file-chip');
    chip.title = a.name;
    chip.append(icon(a.kind === 'pdf' ? 'pdf' : 'doc', 15), el('span', 'nm', a.name), el('small', '', sizeText(a.size || 0)), removeChip(a.name, drop));
    return chip;
  });
  // Folders and plugins picked before there's a session: they join the next one.
  for (const [list, kind] of [[pending.dirs, 'folder'], [pending.plugins, 'puzzle']]) {
    list.forEach((path, i) => {
      const chip = el('span', 'jc-file-chip pending');
      chip.title = `${path} (joins the next session)`;
      chip.append(icon(kind, 15), el('span', 'nm', path.split('/').filter(Boolean).pop()), removeChip(path, () => { list.splice(i, 1); renderAttachments(); }));
      chips.push(chip);
    });
  }
  box.hidden = !chips.length;
  box.replaceChildren(...chips);
}
function clearAttachments() { attachments = []; renderAttachments(); }
$('deck-input').addEventListener('paste', (e) => {
  const files = [...(e.clipboardData ? e.clipboardData.files : [])];
  if (files.length) { e.preventDefault(); files.forEach(addFile); }
});
$('deck-composer').addEventListener('dragover', (e) => { e.preventDefault(); $('deck-composer').classList.add('drag'); });
$('deck-composer').addEventListener('dragleave', () => $('deck-composer').classList.remove('drag'));
$('deck-composer').addEventListener('drop', (e) => {
  e.preventDefault();
  $('deck-composer').classList.remove('drag');
  [...e.dataTransfer.files].forEach(addFile);
});
$('jc-file').addEventListener('change', (e) => { [...e.target.files].forEach(addFile); e.target.value = ''; });

// ⌘F in Jarvis Code: find in the transcript. Matching entries are marked; ⏎ and ⇧⏎ step
// through them (newest first), Esc closes. What the hub keeps (400 entries) is searched.
const jcFind = { hits: [], at: -1 };
function openJcFind() {
  $('jc-find').hidden = false;
  $('jc-find-input').focus();
  $('jc-find-input').select();
  runJcFind(0);
}
function closeJcFind(refocus) {
  if ($('jc-find').hidden) return;
  $('jc-find').hidden = true;
  $('deck-timeline').querySelectorAll('.jc-hit').forEach((n) => n.classList.remove('jc-hit', 'jc-hit-now'));
  jcFind.hits = [];
  jcFind.at = -1;
  if (refocus) $('deck-input').focus();
}
function runJcFind(step) {
  const q = $('jc-find-input').value.trim().toLowerCase();
  $('deck-timeline').querySelectorAll('.jc-hit').forEach((n) => n.classList.remove('jc-hit', 'jc-hit-now'));
  jcFind.hits = q ? [...$('deck-timeline').children].filter((li) => !li.classList.contains('jc-ask') && li.textContent.toLowerCase().includes(q)) : [];
  const n = jcFind.hits.length;
  $('jc-find-count').textContent = !q ? '' : n ? '' : tr('No matches');
  if (!n) { jcFind.at = -1; return; }
  jcFind.at = step === 0 || jcFind.at < 0 ? n - 1 : (jcFind.at + step + n) % n;
  jcFind.hits.forEach((li) => li.classList.add('jc-hit'));
  const now = jcFind.hits[jcFind.at];
  now.classList.add('jc-hit-now');
  now.querySelectorAll('details').forEach((d) => { if (d.textContent.toLowerCase().includes(q)) d.open = true; });
  now.scrollIntoView({ block: 'center', behavior: 'instant' });
  $('jc-find-count').textContent = `${jcFind.at + 1}/${n}`;
}
$('jc-find-input').addEventListener('input', () => runJcFind(0));
$('jc-find-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); runJcFind(e.shiftKey ? 1 : -1); }
  if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeJcFind(true); }
});
$('jc-find-prev').addEventListener('click', () => runJcFind(-1));
$('jc-find-next').addEventListener('click', () => runJcFind(1));
$('jc-find-close').addEventListener('click', () => closeJcFind(true));

// Number keys answer the approval on screen; ⇧⌘F opens the files; ⌘F finds in the transcript.
document.addEventListener('keydown', (e) => {
  if ($('cc').hidden) return;
  if (e.key.toLowerCase() === 'f' && e.metaKey && !e.shiftKey && !e.altKey && !e.ctrlKey
    && (!browserOpenNow || $('cc').contains(document.activeElement))) {
    e.preventDefault();
    e.stopPropagation();  // the browser's own ⌘F is for its page
    openJcFind();
    return;
  }
  if (e.key.toLowerCase() === 'f' && e.metaKey && e.shiftKey) { e.preventDefault(); openPane('files'); return; }
  if (e.metaKey && !e.altKey && !e.ctrlKey) {
    const key = e.key.toLowerCase();
    if (key === 'u' && !e.shiftKey) { e.preventDefault(); $('jc-file').click(); return; }
    if (key === ',' && !e.shiftKey) { e.preventDefault(); openJcSettings('general'); return; }
    if (e.shiftKey && key === 'm') { e.preventDefault(); setMode(nextMode()); return; }
    if (e.shiftKey && key === 'i') { e.preventDefault(); modelMenu(); return; }
    if (e.shiftKey && key === 'e') { e.preventDefault(); openEffort(); return; }
  }
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  const tag = document.activeElement && document.activeElement.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || document.activeElement.isContentEditable) return;  // typing
  const a = [...pendingApprovals.values()].find((x) => x.task_id === ccSelected);
  const n = Number(e.key);
  const inDeck = !(e.target instanceof Element) || e.target === document.body || $('cc').contains(e.target);
  const writingReason = !!document.querySelector('#deck-timeline .jc-feedback:not([hidden])');
  // Only the approval whose sheet is on screen: never one a sheet over the transcript (the
  // agent board) hides.
  const sheet = a && document.querySelector(`#deck-timeline [data-approval="${CSS.escape(a.id)}"]`);
  const shown = !!sheet && sheet.checkVisibility({ visibilityProperty: true });
  if (a && shown && !a.multi && n >= 1 && n <= a.choices.length && inDeck && !e.repeat && !writingReason && !typingLost()) {  // (several at once: its sheet's own keys)
    e.preventDefault();
    const c = a.choices[n - 1];
    if (c.id === 'deny') { const box = document.querySelector(`[data-approval="${CSS.escape(a.id)}"] .jc-feedback`); if (box) { box.hidden = false; box.querySelector('input').focus(); } } else answerApproval(a, c.id);
  }
});

// Esc in Jarvis Code undoes the most specific thing first, as in Claude Code: a menu or
// suggestion list, an edit, the running step, the open pane, and only then the panel
// (never with unsent text in the composer). True when it handled the key.
function jcEscape(e) {
  if (!$('jc-settings').hidden) { closeJcSettings(); return true; }
  if (!$('jc-submenu').hidden) { closeSubmenu(true); return true; }
  if (!$('jc-effort-pop').hidden) { closeEffort(true); return true; }
  if (!$('jc-menu').hidden) { closeMenu(true); return true; }
  if (!$('cc-slash').hidden) { $('cc-slash').hidden = true; return true; }
  if (!$('jc-find').hidden) { closeJcFind(true); return true; }
  if ($('jc-title').isContentEditable) return true;
  // Esc in a pane's text box (a search, a rule being typed) only leaves the box: stopping
  // the step at work is what it means in the composer, not there.
  if (e.target instanceof HTMLElement && $('jc-pane').contains(e.target) && (e.target.matches('input, textarea, select') || e.target.isContentEditable)) {
    e.target.blur();
    return true;
  }
  const t = currentTask();
  if (t && t.busy) { send({ type: 'task_interrupt', id: t.id }); return true; }
  if (currentPane) { closePane(); return true; }
  const field = e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLInputElement;
  return field && !!e.target.value;
}

// ── the composer's controls, as in Claude Code: + menu, mode, model, effort, mic ──

const SVG_NS = 'http://www.w3.org/2000/svg';
const ICON_PATHS = {
  ask: ['M5.4 8.4V4.2a1 1 0 0 1 2 0v3.4', 'M7.4 7.4V3.1a1 1 0 0 1 2 0v4.3', 'M9.4 7.5V4.1a1 1 0 0 1 2 0v4.8c0 2.8-1.8 4.6-4.3 4.6-1.6 0-2.6-.7-3.4-2L2.3 9a1 1 0 0 1 1.7-1l1.4 1.6'],
  edits: ['M3 13l.9-3.2 6.8-6.8a1.5 1.5 0 0 1 2.2 2.1L6.1 11.9z', 'M9.7 4.1l2.1 2.1'],
  plan: ['M6 4h7.5', 'M6 8h7.5', 'M6 12h7.5', 'M2.6 4h.5', 'M2.6 8h.5', 'M2.6 12h.5'],
  smart: ['M7.2 2l1.3 3.3 3.3 1.3-3.3 1.3-1.3 3.3-1.3-3.3-3.3-1.3 3.3-1.3z', 'M12.4 9.8l.6 1.5 1.5.6-1.5.6-.6 1.5-.6-1.5-1.5-.6 1.5-.6z'],
  auto: ['M9.2 1.6L3.4 9.1h4.2l-1.1 5.3 5.8-7.6H8.1z'],
  clip: ['M13.2 7.3l-5.3 5.3a3.2 3.2 0 0 1-4.5-4.5L8.8 2.7a2.1 2.1 0 0 1 3 3L6.6 11a1 1 0 0 1-1.5-1.5l4.9-4.9'],
  folder: ['M2 4.6A1.6 1.6 0 0 1 3.6 3h2.7l1.6 1.7h4.5A1.6 1.6 0 0 1 14 6.3v5.1a1.6 1.6 0 0 1-1.6 1.6H3.6A1.6 1.6 0 0 1 2 11.4z'],
  slash: ['M10.6 2.4L5.4 13.6'],
  plug: ['M6 1.8v3', 'M10 1.8v3', 'M4.3 4.8h7.4v2.5a3.7 3.7 0 0 1-7.4 0z', 'M8 11v3.2'],
  puzzle: ['M3 3.2h3.4v.9a1.6 1.6 0 1 0 3.2 0v-.9H13v3.4h-.9a1.6 1.6 0 1 0 0 3.2h.9V13H9.6v-.9a1.6 1.6 0 1 0-3.2 0v.9H3z'],
  gear: ['M8 5.7a2.3 2.3 0 1 0 0 4.6 2.3 2.3 0 0 0 0-4.6z', 'M8 1.6v1.7M8 12.7v1.7M1.6 8h1.7M12.7 8h1.7M3.5 3.5l1.2 1.2M11.3 11.3l1.2 1.2M3.5 12.5l1.2-1.2M11.3 4.7l1.2-1.2'],
  key: ['M10.3 2.2a3.5 3.5 0 1 1-2.9 5.4L2.6 12.4V14h2.2v-1.3h1.4v-1.4h1.3l1.4-1.4', 'M10.9 4.5h.01'],
  chev: ['M6 3.5l4.5 4.5L6 12.5'],
  doc: ['M4 1.8h5.2L12.4 5v8.6a.6.6 0 0 1-.6.6H4a.6.6 0 0 1-.6-.6V2.4a.6.6 0 0 1 .6-.6z', 'M9 1.8V5.2h3.4', 'M5.6 8.2h4.8M5.6 10.6h4.8'],
  pdf: ['M4 1.8h5.2L12.4 5v8.6a.6.6 0 0 1-.6.6H4a.6.6 0 0 1-.6-.6V2.4a.6.6 0 0 1 .6-.6z', 'M9 1.8V5.2h3.4', 'M5.4 11.6c1.8-.8 3.4-2.9 3.9-4.9M6.3 9.8c1.7.1 3.4.6 4.2 1.4'],
  check: ['M3.4 8.6l3 3 6.2-7.2'],
};

function icon(name, size = 16) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  for (const [k, v] of Object.entries({ width: size, height: size, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.4', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true', class: `ic ic-${name}` })) svg.setAttribute(k, String(v));
  for (const d of ICON_PATHS[name] || []) {
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', d);
    svg.append(path);
  }
  return svg;
}

const JC_MODES = [
  { id: 'ask', label: 'Manual', note: 'Asks before each edit and command' },
  { id: 'edits', label: 'Accept edits', note: 'Edits files without asking; commands still ask' },
  { id: 'plan', label: 'Plan', note: 'Explores and plans; changes nothing until you approve' },
  { id: 'smart', label: 'Auto', note: 'Safe steps go ahead; a safety check asks about risky ones' },
  { id: 'auto', label: 'Bypass permissions', note: 'Runs anything without asking', danger: true },
];
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
const EFFORT_NAMES = { low: 'Low', medium: 'Medium', high: 'High', xhigh: 'Extra high', max: 'Max' };
const EFFORT_NOTES = [
  'Fastest: quick answers, light thinking.',
  'A balance of speed and thought.',
  'The default: thinks things through.',
  'Deeper reasoning for harder problems.',
  'Thinks as hard as it can. Slower, and costs more.',
  'Big tasks become multi-agent workflows that plan, build and check in parallel (at Extra high effort). The most thorough, and the most costly.',
];
const GAUGE = [18, 36, 56, 76, 100, 100];

let codeDefaults = { model: '', effort: '', mode: 'ask', ultracode: false };  // Settings › Jarvis Code
let modelList = [];  // Claude's models, then the ones added with an API key
let providerInfo = { kinds: [], providers: [], models: [], limits: {} };
const pending = { dirs: [], plugins: [] };  // + menu choices made before there's a session
let dictating = false;

function takePending() {
  const out = { add_dirs: [...pending.dirs], plugins: [...pending.plugins] };
  pending.dirs.length = 0;
  pending.plugins.length = 0;
  renderAttachments();
  return out;
}

function autoCapable(modelId) {
  const name = String(modelId || '').toLowerCase();
  return name.includes('claude') && !name.includes('haiku');
}

function modelEntry(ref) { return modelList.find((m) => m.ref === ref) || null; }
function refForModel(id) { const m = modelList.find((x) => x.builtin && x.model === id); return m ? m.ref : ''; }

// What the composer shows: the open session's settings, or with none open, what the next
// session starts with (Settings › Jarvis Code).
function composerState() {
  const t = currentTask();
  const fallback = (prefs && prefs.model) || 'opus';
  if (t) {
    const ref = t.model_ref || refForModel(t.model) || (t.model ? '' : fallback);
    const entry = modelEntry(ref);
    const id = t.model || (entry && entry.model) || '';
    return {
      t, mode: t.mode, ref, modelId: id,
      label: (entry && entry.label) || t.model_label || MODEL_LABELS[id] || String(id).replace(/^claude-/, '') || 'Default',
      effort: t.effort || 'high', ultracode: !!t.ultracode, pending: !!t.effort_pending,
    };
  }
  const ref = codeDefaults.model || fallback;
  const entry = modelEntry(ref);
  return {
    t: null, mode: codeDefaults.mode || 'ask', ref, modelId: entry ? entry.model : '',
    label: entry ? entry.label : (MODEL_LABELS[ref] || 'Default'),
    effort: codeDefaults.effort || 'high', ultracode: !!codeDefaults.ultracode, pending: false,
  };
}

function effortStop(s) { return s.ultracode ? 5 : Math.max(0, EFFORTS.indexOf(s.effort || 'high')); }
function effortName(stop) { return stop === 5 ? 'Ultracode' : EFFORT_NAMES[EFFORTS[stop]]; }

function renderComposer() {
  if (!$('jc-mode-btn')) return;
  const s = composerState();
  const mode = JC_MODES.find((m) => m.id === s.mode) || JC_MODES[0];
  if ($('jc-mode-btn').dataset.mode !== mode.id) $('jc-mode-ic').replaceChildren(icon(mode.id, 14));
  setText($('jc-mode-label'), mode.label);
  $('jc-mode-btn').dataset.mode = mode.id;
  $('jc-bypass').setAttribute('aria-pressed', String(mode.id === 'auto'));
  $('jc-mode-btn').title = `${mode.label}: ${mode.note} (⌘⇧M or ⇧⇥ to switch)`;
  setText($('jc-model-label'), s.label);
  $('jc-model').title = `Model: ${s.label} (⌘⇧I)`;
  const stop = effortStop(s);
  setText($('jc-effort-label'), `${effortName(stop)}${s.pending ? ' · next step' : ''}`);
  $('jc-effort').classList.toggle('ultra', stop === 5);
  $('jc-effort').title = `Effort: ${effortName(stop)} (⌘⇧E)`;
  $('jc-gauge-fill').style.strokeDashoffset = String(100 - GAUGE[stop]);
  $('jc-dictate').setAttribute('aria-pressed', String(dictating));
  $('jc-dictate').classList.toggle('live', dictating);
}

// ── menus: glass, with icons, notes, submenus and the keyboard ──

function menuItem(item) {
  if (item === '-') return el('hr');
  if (item.heading) { const h = el('p', 'jc-menu-head', item.heading); h.setAttribute('role', 'presentation'); return h; }
  if (item.foot) { const f = el('p', 'jc-menu-foot', item.foot); f.setAttribute('role', 'presentation'); return f; }
  const isSwitch = item.switch !== undefined;
  const b = el('button', ['jc-mi', isSwitch ? 'jc-menu-switch' : '', item.danger ? 'danger' : '', item.sub ? 'has-sub' : ''].filter(Boolean).join(' '));
  b.type = 'button';
  b.setAttribute('role', isSwitch ? 'menuitemcheckbox' : item.checked !== undefined ? 'menuitemradio' : 'menuitem');
  if (isSwitch) b.setAttribute('aria-checked', String(!!item.switch));
  else if (item.checked !== undefined) b.setAttribute('aria-checked', String(!!item.checked));
  if (item.disabled) { b.disabled = true; b.setAttribute('aria-disabled', 'true'); }
  if (item.icon) b.append(icon(item.icon, 16));
  const text = el('span', 'mi-text');
  const label = el('span', 'mi-label', item.label);
  text.append(item.mine ? mine(label) : label);  // mine: the owner's words or names, never translated
  if (item.note) text.append(el('small', '', item.note));
  b.append(text);
  if (isSwitch) b.append(el('span', `sw ${item.switch ? 'on' : ''}`));
  else if (item.checked) b.append(icon('check', 14));
  else if (item.key) b.append(el('span', 'k', item.key));
  if (item.sub) {
    b.setAttribute('aria-haspopup', 'menu');
    b.setAttribute('aria-expanded', 'false');
    b.append(icon('chev', 12));
    let hover = 0;
    b.addEventListener('mouseenter', () => { clearTimeout(hover); hover = setTimeout(() => openMenu(b, item.sub(), { sub: true, noFocus: true, kind: item.subKind }), 140); });
    b.addEventListener('mouseleave', () => clearTimeout(hover));
  } else {
    // Moving onto another row of the main menu closes an open submenu.
    b.addEventListener('mouseenter', () => { if (b.parentElement && b.parentElement.id === 'jc-menu') closeSubmenu(); });
  }
  b.addEventListener('click', () => {
    if (item.sub) { openMenu(b, item.sub(), { sub: true, kind: item.subKind }); return; }
    if (isSwitch && item.keepOpen) {  // flips in place; the menu stays for the next one
      const on = b.getAttribute('aria-checked') !== 'true';
      b.setAttribute('aria-checked', String(on));
      b.querySelector('.sw').classList.toggle('on', on);
      item.run(on);
      return;
    }
    closeMenu();
    item.run();
  });
  return b;
}

function placePopup(pop, anchor, side) {
  const r = anchor.getBoundingClientRect();
  const w = pop.offsetWidth, h = pop.offsetHeight;
  let left, top;
  if (side === 'right') {
    left = r.right + 4 + w > window.innerWidth - 8 ? r.left - w - 4 : r.right + 4;
    top = Math.min(window.innerHeight - h - 8, r.top - 6);
  } else {
    left = Math.min(window.innerWidth - w - 8, Math.max(8, r.left + r.width / 2 > window.innerWidth / 2 ? r.right - w : r.left));
    top = r.top - h - 8 >= 8 && (r.bottom + 8 + h > window.innerHeight - 8 || r.top > window.innerHeight / 2) ? r.top - h - 8 : r.bottom + 8;
  }
  pop.style.left = `${Math.max(8, left)}px`;
  pop.style.top = `${Math.max(8, top)}px`;
}

function openMenu(anchor, items, opts = {}) {
  const menu = opts.sub ? $('jc-submenu') : $('jc-menu');
  if (opts.sub) {
    const parent = $('jc-submenu').dataset.parent && document.querySelector(`[data-sub-open="1"]`);
    if (parent) { parent.removeAttribute('data-sub-open'); parent.setAttribute('aria-expanded', 'false'); }
  } else {
    closeSubmenu();
    closeEffort();
    closeMenu();
  }
  menu.replaceChildren(...items.map(menuItem));
  menu.classList.toggle('rich', items.some((i) => i && typeof i === 'object' && (i.note || i.icon)));
  menu.hidden = false;
  placePopup(menu, anchor, opts.sub ? 'right' : 'auto');
  anchor.setAttribute('aria-expanded', 'true');
  if (opts.sub) { anchor.setAttribute('data-sub-open', '1'); menu.dataset.parent = '1'; menu.dataset.kind = opts.kind || ''; } else menu.dataset.anchor = anchor.id || '';
  if (!opts.noFocus) {
    const first = menu.querySelector('button:not([disabled])[aria-checked="true"]') || menu.querySelector('button:not([disabled])');
    if (first) first.focus();
  }
}
function closeSubmenu(refocus) {
  const sub = $('jc-submenu');
  if (sub.hidden) return;
  sub.hidden = true;
  const parent = document.querySelector('[data-sub-open="1"]');
  if (parent) { parent.removeAttribute('data-sub-open'); parent.setAttribute('aria-expanded', 'false'); if (refocus) parent.focus(); }
}
function closeMenu(refocus) {
  closeSubmenu();
  const menu = $('jc-menu');
  if (menu.hidden) return;
  menu.hidden = true;
  const anchor = menu.dataset.anchor && $(menu.dataset.anchor);
  if (anchor) { anchor.setAttribute('aria-expanded', 'false'); if (refocus) anchor.focus(); }
}
document.addEventListener('mousedown', (e) => {
  const inside = (id) => $(id).contains(e.target);
  if (!$('jc-menu').hidden && !inside('jc-menu') && !inside('jc-submenu') && !e.target.closest('[aria-haspopup]')) closeMenu();
  if (!$('jc-effort-pop').hidden && !inside('jc-effort-pop') && !e.target.closest('#jc-effort')) closeEffort();
});
for (const id of ['jc-menu', 'jc-submenu']) {
  $(id).addEventListener('keydown', (e) => {
    const menu = $(id);
    const items = [...menu.querySelectorAll('button:not([disabled])')];
    const i = items.indexOf(document.activeElement);
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      items[(i + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length].focus();
    } else if (e.key === 'Home' || e.key === 'End') {
      e.preventDefault();
      items[e.key === 'Home' ? 0 : items.length - 1].focus();
    } else if (e.key === 'ArrowRight' && document.activeElement.classList.contains('has-sub')) {
      e.preventDefault();
      document.activeElement.click();
    } else if (e.key === 'ArrowLeft' && id === 'jc-submenu') {
      e.preventDefault();
      closeSubmenu(true);
    } else if (e.key === 'Tab') {
      closeMenu();
    }
  });
}

// ── permission mode ──

function setMode(id) {
  if (!JC_MODES.some((m) => m.id === id)) return;
  const s = composerState();
  if (id === 'smart' && !autoCapable(s.modelId)) { jcNote('Auto needs Opus, Sonnet or Fable. Pick one of them first.'); return; }
  const target = s.t ? s.t.id : null;  // (the session it was asked for, whatever shows by the time it's a yes)
  const go = () => {
    if (target !== null) send({ type: 'task_mode', id: target, mode: id });
    else { codeDefaults.mode = id; send({ type: 'code_defaults', code_mode: id }); renderComposer(); }
  };
  if (id === 'auto' && s.mode !== 'auto') confirmBypass('bypass', 'Bypass permissions lets Jarvis Code run any command and change any file without asking you. Use it only for a project you could lose. Switch?', go);
  else go();
}

function modeMenu() {
  const s = composerState();
  const capable = autoCapable(s.modelId);
  openMenu($('jc-mode-btn'), [
    ...JC_MODES.map((m) => ({
      icon: m.id, label: m.label, danger: m.danger, checked: s.mode === m.id,
      note: m.id === 'smart' && !capable ? 'Needs Opus, Sonnet or Fable' : m.note,
      disabled: m.id === 'smart' && !capable,
      run: () => setMode(m.id),
    })),
    { foot: s.t ? '⌘⇧M or ⇧⇥ to switch' : 'For the next session · ⌘⇧M or ⇧⇥ to switch' },
  ]);
}
$('jc-mode-btn').addEventListener('click', () => { if ($('jc-menu').hidden || $('jc-menu').dataset.anchor !== 'jc-mode-btn') modeMenu(); else closeMenu(); });

// ── model: Claude's, and any added with an API key ──

function pickModel(ref) {
  const s = composerState();
  if (s.t) send({ type: 'task_model', id: s.t.id, ref });
  else { codeDefaults.model = ref; send({ type: 'code_defaults', code_model: ref }); renderComposer(); }
}

function modelMenu() {
  const s = composerState();
  const builtins = modelList.filter((m) => m.builtin);
  const mine = modelList.filter((m) => !m.builtin);
  const claude = builtins.length ? builtins : [['opus', 'claude-opus-5-5'], ['sonnet', 'claude-sonnet-5-5'], ['haiku', 'claude-haiku-4-5'], ['fable', 'claude-fable-5-1']].map(([ref, model]) => ({ ref, model, label: MODEL_LABELS[model] }));
  openMenu($('jc-model'), [
    { heading: 'Claude' },
    ...claude.map((m) => ({ label: m.label, checked: s.ref === m.ref || s.modelId === m.model, run: () => pickModel(m.ref) })),
    ...(mine.length ? [{ heading: 'Your models' }, ...mine.map((m) => ({ label: m.label, note: m.provider_name, checked: s.ref === m.ref, run: () => pickModel(m.ref) }))] : []),
    '-',
    { icon: 'key', label: mine.length ? 'Models & API keys…' : 'Add a model with an API key…', run: () => openJcSettings('models') },
  ]);
}
$('jc-model').addEventListener('click', () => { if ($('jc-menu').hidden || $('jc-menu').dataset.anchor !== 'jc-model') modelMenu(); else closeMenu(); });

// ── effort: a slider, with Ultracode past Max ──

function showEffortValue(stop) {
  $('ep-value').textContent = effortName(stop);
  $('ep-value').classList.toggle('ultra', stop === 5);
  $('ep-note').textContent = EFFORT_NOTES[stop];
  $('ep-range').setAttribute('aria-valuetext', effortName(stop));
  $('ep-range').style.setProperty('--fill', `${(stop / 5) * 100}%`);
  $('ep-range').parentElement.style.setProperty('--p', String(stop / 5));
  $('jc-effort-pop').classList.toggle('ultra', stop === 5);
}
// The context window: how full it is and with what, sized for the session's model (a
// Gemini session's 2M, not Claude's), with Compact (summarize, keep going) and Clear.
const CX_COLORS = ['var(--cx-1)', 'var(--cx-2)', 'var(--cx-3)', 'var(--cx-4)', 'var(--cx-5)', 'var(--cx-6)'];
function tokens(n) {
  if (!n) return '0';
  if (n >= 1e6) return `${+(n / 1e6).toFixed(n % 1e6 ? 2 : 0)}M`;
  if (n >= 1e3) return `${+(n / 1e3).toFixed(n >= 1e5 ? 0 : 1)}k`;
  return String(n);
}
let cxArmed = 0;
function cxDisarm() { clearTimeout(cxArmed); cxArmed = 0; $('cx-clear').classList.remove('armed'); $('cx-clear').textContent = tr('Clear'); }
function renderCtxPop() {
  const pop = $('jc-ctx-pop');
  if (pop.hidden) return;
  const c = ccContext[ccSelected];
  if (!c) { $('cx-total').textContent = '…'; return; }
  $('cx-total').textContent = c.max ? `${tokens(c.tokens)} / ${tokens(c.max)} (${c.percent}%)` : tokens(c.tokens);
  const cats = c.categories || [];
  $('cx-bar').replaceChildren(...cats.map((cat, i) => {
    const seg = el('i');
    seg.style.width = `${c.max ? (100 * cat.tokens) / c.max : 0}%`;
    seg.style.background = CX_COLORS[i % CX_COLORS.length];
    return seg;
  }));
  if (c.compact_at) {
    const mark = el('b', 'cx-mark');
    mark.style.left = `${c.compact_at}%`;
    $('cx-bar').append(mark);
  }
  $('cx-legend').replaceChildren(...cats.map((cat, i) => {
    const li = el('li');
    const dot = el('i');
    dot.style.background = CX_COLORS[i % CX_COLORS.length];
    li.append(dot, el('span', '', cat.name), el('b', '', tokens(cat.tokens)));
    return li;
  }));
  $('cx-note').textContent = c.autocompact
    ? (c.compact_at ? `Compacts on its own at ${c.compact_at}% (the mark).` : 'Compacts on its own when it fills up.')
    : 'Auto-compact is off: compact or clear before it fills up.';
}
function openCtx() {
  const pop = $('jc-ctx-pop');
  if (!pop.hidden) { closeCtx(true); return; }
  closeMenu();
  closeEffort();
  pop.hidden = false;
  cxDisarm();
  renderCtxPop();
  placePopup(pop, $('jc-ctx'), 'auto');
  $('jc-ctx').setAttribute('aria-expanded', 'true');
  if (ccSelected) send({ type: 'task_context', id: ccSelected });
}
function closeCtx(refocus) {
  const pop = $('jc-ctx-pop');
  if (pop.hidden) return;
  pop.hidden = true;
  cxDisarm();
  $('jc-ctx').setAttribute('aria-expanded', 'false');
  if (refocus) $('jc-ctx').focus();
}
$('jc-ctx').addEventListener('click', openCtx);
$('cx-compact').addEventListener('click', () => {
  const t = currentTask();
  if (!t) return;
  send({ type: 'code_command', id: t.id, text: '/compact' });
  closeCtx();
  jcNote('Compacting: the conversation so far becomes a summary, and the session keeps going.');
});
$('cx-clear').addEventListener('click', () => {
  const t = currentTask();
  if (!t) return;
  if (!cxArmed) {
    $('cx-clear').classList.add('armed');
    $('cx-clear').textContent = tr('Click again to clear');
    cxArmed = setTimeout(cxDisarm, 3500);
    return;
  }
  cxDisarm();
  closeCtx();
  awaitingNewSession = true;
  send({ type: 'code_command', id: t.id, text: '/clear' });
});
document.addEventListener('pointerdown', (e) => {
  if (!$('jc-ctx-pop').hidden && !e.target.closest('#jc-ctx-pop, #jc-ctx')) closeCtx();
});
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('jc-ctx-pop').hidden) { e.stopPropagation(); closeCtx(true); } }, true);

function openEffort() {
  const pop = $('jc-effort-pop');
  if (!pop.hidden) { closeEffort(true); return; }
  closeMenu();
  const stop = effortStop(composerState());
  $('ep-range').value = String(stop);
  showEffortValue(stop);
  pop.hidden = false;
  placePopup(pop, $('jc-effort'), 'auto');
  $('jc-effort').setAttribute('aria-expanded', 'true');
  $('ep-range').focus();
}
function closeEffort(refocus) {
  const pop = $('jc-effort-pop');
  if (pop.hidden) return;
  pop.hidden = true;
  $('jc-effort').setAttribute('aria-expanded', 'false');
  if (refocus) $('jc-effort').focus();
}
function applyEffort(stop) {
  stop = Math.max(0, Math.min(5, Number(stop) || 0));
  const ultracode = stop === 5;
  const effort = ultracode ? 'xhigh' : EFFORTS[stop];
  const s = composerState();
  if (s.t) {
    if (effort !== s.effort) send({ type: 'task_effort', id: s.t.id, effort });
    if (ultracode !== s.ultracode) send({ type: 'task_ultracode', id: s.t.id, on: ultracode });
  } else {
    Object.assign(codeDefaults, { effort, ultracode });
    send({ type: 'code_defaults', code_effort: effort, code_ultracode: ultracode });
    renderComposer();
  }
}
$('jc-effort').addEventListener('click', openEffort);
$('ep-range').addEventListener('input', () => showEffortValue(Number($('ep-range').value)));
$('ep-range').addEventListener('change', () => applyEffort($('ep-range').value));
$('ep-range').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); applyEffort($('ep-range').value); closeEffort(true); } });

// ── + : files, folders, slash commands, connectors, plugins ──

async function pickFolderPath(question) {
  if (inSplitPane) { try { return await window.parent.jarvisFeatures.pickFolder(question); } catch (_) { /* its own way */ } }  // the app's picker
  if (app && app.pickFolder) return app.pickFolder();
  const typed = prompt(tr(question));
  return typed ? typed.trim() : null;
}
async function addCodeFolder() {
  const path = await pickFolderPath('The full path of the folder:');
  if (!path) return;
  const t = currentTask();
  if (t) send({ type: 'task_add_dir', id: t.id, directory: path });
  else if (!pending.dirs.includes(path)) { pending.dirs.push(path); renderAttachments(); }
}
async function addCodePlugin() {
  const path = await pickFolderPath('The full path of the plugin folder (the one with .claude-plugin/plugin.json):');
  if (!path) return;
  const t = currentTask();
  if (t) send({ type: 'task_add_plugin', id: t.id, directory: path });
  else if (!pending.plugins.includes(path)) { pending.plugins.push(path); renderAttachments(); }
}
function showSlash() {
  const input = $('deck-input');
  if (!input.value.startsWith('/')) input.value = `/${input.value.trimStart()}`;
  input.focus();
  input.selectionStart = input.selectionEnd = 1;
  pickIndex = 0;
  renderSuggestions();
}

function connectorItems(ask = true) {
  const t = currentTask();
  if (!t) return [{ label: 'Open a session to choose its connectors', disabled: true }];
  if (ask) send({ type: 'task_mcp', id: t.id });  // fresh status; the list redraws when it comes
  const off = new Set(t.disabled_mcp || []);
  const servers = new Map(mcpServers.map((x) => [x.name, x]));
  off.forEach((name) => { if (!servers.has(name)) servers.set(name, { name, status: 'off' }); });
  const items = [...servers.values()].filter((x) => x.name).map((x) => ({
    label: x.name, mine: true, note: off.has(x.name) ? 'Off for this session' : (x.status && x.status !== 'connected' ? x.status : ''),
    switch: !off.has(x.name), keepOpen: true,
    run: (on) => send({ type: 'task_mcp_toggle', id: t.id, name: x.name, enabled: on }),
  }));
  return [
    ...(items.length ? items : [{ label: t.busy || t.status === 'waiting' ? 'No connectors in this session' : 'Connectors show once the session is running', disabled: true }]),
    '-',
    { label: 'Manage MCP servers…', run: () => openPane('mcp') },
  ];
}
function refreshConnectorsMenu() {
  const sub = $('jc-submenu');
  if (sub.hidden || sub.dataset.kind !== 'connectors') return;
  const had = [...sub.querySelectorAll('button')].indexOf(document.activeElement);  // keep the keyboard's place
  sub.replaceChildren(...connectorItems(false).map(menuItem));
  const buttons = [...sub.querySelectorAll('button:not([disabled])')];
  if (had >= 0 && buttons.length) buttons[Math.min(had, buttons.length - 1)].focus();
}

function plusMenu() {
  const t = currentTask();
  openMenu($('jc-plus'), [
    { icon: 'clip', label: 'Add files or photos', key: '⌘U', run: () => $('jc-file').click() },
    { icon: 'folder', label: 'Add folder', note: t ? '' : 'Joins the next session', run: addCodeFolder },
    { icon: 'slash', label: 'Slash commands', key: '/', run: showSlash },
    { icon: 'plug', label: 'Connectors', sub: connectorItems, subKind: 'connectors' },
    { icon: 'puzzle', label: 'Add plugins', note: t ? '' : 'Joins the next session', run: addCodePlugin },
    '-',
    { icon: 'gear', label: 'Jarvis Code settings', key: '⌘,', run: () => openJcSettings('general') },
  ]);
}
$('jc-plus').addEventListener('click', () => { if ($('jc-menu').hidden || $('jc-menu').dataset.anchor !== 'jc-plus') plusMenu(); else closeMenu(); });

// ── the mic: dictation into the text box (voice coding is the header's Voice) ──

$('jc-dictate').addEventListener('click', () => {
  dictating = !dictating;
  renderComposer();
  send({ type: 'dictate', on: dictating });
  $('deck-input').focus();
});
function onDictation(ev) {
  // The hub tells every window, the split view's other pane too: the words go only to the
  // composer whose mic took them.
  if (!dictating) return;
  dictating = false;
  renderComposer();
  const text = String(ev.text || '').trim();
  if (!text) return;
  const input = $('deck-input');
  const at = input.selectionStart ?? input.value.length;
  const end = input.selectionEnd ?? at;
  const before = input.value.slice(0, at);
  const after = input.value.slice(end);
  const lead = before && !/\s$/.test(before) ? ' ' : '';
  const tail = after && !/^\s/.test(after) ? ' ' : '';
  input.value = `${before}${lead}${text}${tail}${after}`;
  input.selectionStart = input.selectionEnd = (before + lead + text).length;
  input.dispatchEvent(new Event('input'));
  input.focus();
}

// ── Jarvis Code settings: new-session defaults, behavior, Models & API keys ──

let jcsKind = 'openrouter';
const providerChecks = {};  // provider id -> its last check (models it offers)

function selectJcsTab(tab) {
  document.querySelectorAll('.jcs-tabs [role="tab"]').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === tab)));
  $('jcs-general').hidden = tab !== 'general';
  $('jcs-models').hidden = tab !== 'models';
  if (tab === 'models') checkGeminiOnce();
}
// A Gemini key's full model list comes with a check: run once when the Models tab first
// shows it, so every model on the key is there to add without pressing Check key.
function checkGeminiOnce() {
  if ($('jc-settings').hidden || $('jcs-models').hidden) return;
  for (const p of providerInfo.providers) {
    if (p.kind !== 'gemini' || providerChecks[p.id]) continue;
    providerChecks[p.id] = { busy: true };
    send({ type: 'providers_check', id: p.id });
  }
}
function openJcSettings(tab = 'general') {
  closeMenu();
  closeEffort();
  $('jc-settings').hidden = false;
  selectJcsTab(tab);
  renderJcGeneral();
  renderProviders();
  send({ type: 'providers_list' });
  (tab === 'models' ? $('jcs-key') : $('jcs-close')).focus();
}
function closeJcSettings() {
  $('jc-settings').hidden = true;
  $('jcs-key').value = '';  // a key never lingers in the window
  $('deck-input').focus();
}
$('jcs-close').addEventListener('click', closeJcSettings);
$('jc-settings').addEventListener('mousedown', (e) => { if (e.target === $('jc-settings')) closeJcSettings(); });
document.querySelectorAll('.jcs-tabs [role="tab"]').forEach((b) => b.addEventListener('click', () => selectJcsTab(b.dataset.tab)));

function option(value, label, selected) {
  const o = el('option', '', label);
  o.value = value;
  o.selected = !!selected;
  return o;
}
function renderJcGeneral() {
  const fallback = (prefs && prefs.model) || 'opus';
  const jarvisModel = modelEntry(fallback);
  const sel = $('jcs-model');
  const mine = modelList.filter((m) => !m.builtin);
  const claude = el('optgroup');
  claude.label = 'Claude';
  claude.append(option('', `Same as J.A.R.V.I.S. (${jarvisModel ? jarvisModel.label : 'default'})`, !codeDefaults.model),
    ...modelList.filter((m) => m.builtin).map((m) => option(m.ref, m.label, codeDefaults.model === m.ref)));
  const yours = el('optgroup');
  yours.label = 'Your models';
  yours.append(...mine.map((m) => option(m.ref, `${m.label} · ${m.provider_name}`, codeDefaults.model === m.ref)));
  sel.replaceChildren(claude, ...(mine.length ? [yours] : []));
  $('jcs-mode').replaceChildren(...JC_MODES.map((m) => option(m.id, m.label, (codeDefaults.mode || 'ask') === m.id)));
  const stop = codeDefaults.ultracode ? 5 : Math.max(0, EFFORTS.indexOf(codeDefaults.effort || 'high'));
  $('jcs-effort').value = String(stop);
  $('jcs-effort').style.setProperty('--fill', `${(stop / 5) * 100}%`);
  $('jcs-effort').parentElement.style.setProperty('--p', String(stop / 5));
  $('jcs-effort-out').textContent = effortName(stop);
  $('jcs-effort-out').classList.toggle('ultra', stop === 5);
  $('jcs-queue').setAttribute('aria-checked', String(!prefs || prefs.code_queue !== false));
  $('jcs-awake').setAttribute('aria-checked', String(awake));
}
$('jcs-model').addEventListener('change', () => { codeDefaults.model = $('jcs-model').value; send({ type: 'code_defaults', code_model: codeDefaults.model }); renderComposer(); });
$('jcs-mode').addEventListener('change', () => {
  const id = $('jcs-mode').value;
  const go = () => { codeDefaults.mode = id; send({ type: 'code_defaults', code_mode: id }); renderComposer(); };
  if (id === 'auto') confirmBypass('bypass-default', 'New sessions would run any command and change any file without asking. Start them in Bypass permissions?', go, renderJcGeneral);
  else go();
});
$('jcs-effort').addEventListener('input', () => {
  const stop = Number($('jcs-effort').value);
  $('jcs-effort').style.setProperty('--fill', `${(stop / 5) * 100}%`);
  $('jcs-effort').parentElement.style.setProperty('--p', String(stop / 5));
  $('jcs-effort-out').textContent = effortName(stop);
  $('jcs-effort-out').classList.toggle('ultra', stop === 5);
});
$('jcs-effort').addEventListener('change', () => {
  const stop = Number($('jcs-effort').value);
  Object.assign(codeDefaults, { effort: stop === 5 ? 'xhigh' : EFFORTS[stop], ultracode: stop === 5 });
  send({ type: 'code_defaults', code_effort: codeDefaults.effort, code_ultracode: codeDefaults.ultracode });
  renderComposer();
});
$('jcs-queue').addEventListener('click', () => setPrefs({ code_queue: !(prefs && prefs.code_queue !== false) }));
$('jcs-awake').addEventListener('click', () => send({ type: 'awake', on: !awake }));

function onProviders(ev) {
  providerInfo = { kinds: ev.kinds || [], providers: ev.providers || [], models: ev.models || [], limits: ev.limits || {}, advice: ev.advice || '', fallback_auto: ev.fallback_auto || '' };
  renderFallback();
  $('jcs-advice').textContent = providerInfo.advice;
  $('jcs-advice').hidden = !providerInfo.advice;
  modelList = providerInfo.models;
  renderComposer();
  if (!$('jc-settings').hidden) { checkGeminiOnce(); renderProviders(); renderJcGeneral(); }
}
function onProviderCheck(ev) {
  providerChecks[ev.id] = ev;
  if (!$('jc-settings').hidden) renderProviders();
}
function onProvidersError(ev) {
  $('jcs-help').textContent = ev.text || 'That didn’t work.';
  $('jcs-help').classList.add('bad');
}

function statusLine(p) {
  const check = providerChecks[p.id];
  if (check && check.busy) return ['Checking the key…', ''];
  const st = (check && !check.busy && check) || p.status;
  if (!st) return ['Not checked yet', ''];
  if (st.ok) {
    const count = st.count ?? (st.models || []).length;
    const note = check && check.note ? ` · ${check.note}` : '';
    return [`Key works · ${count} model${count === 1 ? '' : 's'}${note}`, 'good'];
  }
  return [st.error || 'That key didn’t work.', 'bad'];
}

function renderProviders() {
  const list = $('jcs-providers');
  list.replaceChildren(...providerInfo.providers.map((p) => {
    const li = el('li', 'jcs-provider');
    const head = el('div', 'jcs-p-head');
    const title = el('div', 'jcs-p-title');
    title.append(el('strong', '', p.name), el('small', '', `${p.kind_name}${p.base_url && p.kind === 'custom' ? ` · ${p.base_url}` : ''} · key ${p.key_hint}`));
    const [line, cls] = statusLine(p);
    const status = el('p', `jcs-p-status ${cls}`, line);
    const check = el('button', 'jc-btn', 'Check key');
    check.type = 'button';
    check.addEventListener('click', () => { providerChecks[p.id] = { busy: true }; renderProviders(); send({ type: 'providers_check', id: p.id }); });
    const remove = el('button', 'jc-btn danger', 'Remove');
    remove.type = 'button';
    remove.addEventListener('click', () => { if (confirm(tr(`Remove ${p.name} and its key from this Mac? Its models go too.`))) send({ type: 'providers_remove', id: p.id }); });
    head.append(title, check, remove);
    const models = el('div', 'jcs-p-models');
    models.append(...p.models.map((m) => {
      const chip = el('span', 'jcs-model-chip');
      chip.append(el('span', '', m.label), removeChip(m.label, () => send({ type: 'providers_remove_model', ref: m.ref })));
      return chip;
    }));
    const add = el('form', 'jcs-p-add');
    const input = el('input', 'jcs-input');
    input.placeholder = p.kind === 'openrouter' ? 'Model id, e.g. openai/gpt-5' : 'Model id';
    input.spellcheck = false;
    input.setAttribute('aria-label', `Add a model from ${p.name}`);
    const listId = `jcs-dl-${p.id}`;
    const dl = el('datalist');
    dl.id = listId;
    const offered = (providerChecks[p.id] && providerChecks[p.id].models) || [];
    const kind = providerInfo.kinds.find((k) => k.id === p.kind);
    const names = offered.length ? offered.filter((m) => m.tools !== false).map((m) => m.id) : ((kind && kind.suggested) || []);
    dl.append(...names.slice(0, 400).map((id) => option(id, id)));
    input.setAttribute('list', listId);
    const go = el('button', 'jc-btn', 'Add model');
    go.type = 'submit';
    add.append(input, dl, go);
    add.addEventListener('submit', (e) => {
      e.preventDefault();
      const model = input.value.trim();
      if (model) send({ type: 'providers_add_model', id: p.id, model });
    });
    li.append(head, status, models, add);
    // Gemini: every model on the key (Google's own list, by name and number), each a click
    // to add, or all at once. OpenRouter's hundreds stay in the id box.
    const added = new Set(p.models.map((m) => m.model));
    const more = p.kind === 'gemini' ? offered.filter((m) => m.tools !== false && !added.has(m.id)) : [];
    if (more.length) {
      const box = el('div', 'jcs-p-more');
      const top = el('div', 'jcs-p-more-head');
      const all = el('button', 'jc-btn', 'Add all');
      all.type = 'button';
      all.addEventListener('click', () => send({ type: 'providers_add_models', id: p.id, models: more.map((m) => ({ model: m.id, label: m.name })) }));
      top.append(el('small', '', 'More models on this key'), all);
      const chips = el('div', 'jcs-p-models');
      chips.append(...more.map((m) => {
        const b = mine(el('button', 'jcs-model-chip jcs-model-add', `+ ${m.name}`));
        b.type = 'button';
        b.title = m.id;
        b.addEventListener('click', () => send({ type: 'providers_add_model', id: p.id, model: m.id, label: m.name }));
        return b;
      }));
      box.append(top, chips);
      li.append(box);
    }
    return li;
  }));
  // The add form: one chip per kind of provider.
  const kinds = providerInfo.kinds.length ? providerInfo.kinds : [{ id: 'openrouter', name: 'OpenRouter' }];
  if (!kinds.some((k) => k.id === jcsKind)) jcsKind = kinds[0].id;
  $('jcs-kinds').replaceChildren(...kinds.map((k) => {
    const b = el('button', 'jcs-kind', k.name);
    b.type = 'button';
    b.setAttribute('role', 'radio');
    b.setAttribute('aria-checked', String(k.id === jcsKind));
    b.addEventListener('click', () => { jcsKind = k.id; renderProviders(); });
    return b;
  }));
  const kind = kinds.find((k) => k.id === jcsKind) || {};
  $('jcs-blurb').textContent = kind.blurb || '';
  $('jcs-url-row').hidden = !kind.needs_base_url;
  $('jcs-auth-row').hidden = !(kind.auth_choices && kind.auth_choices.length > 1);
  $('jcs-key').placeholder = kind.key_prefix ? `Paste your key (${kind.key_prefix}…)` : 'Paste your key';
  const help = $('jcs-help');
  if (!help.classList.contains('bad')) {
    help.replaceChildren();
    if (kind.help_url) {
      const a = el('a', '', kind.help_url.replace(/^https:\/\//, ''));
      a.href = kind.help_url;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      help.append(document.createTextNode('Get a key at '), a);
    }
  }
  const full = providerInfo.limits.providers && providerInfo.providers.length >= providerInfo.limits.providers;
  $('jcs-add-btn').disabled = !!full;
}
$('jcs-add').addEventListener('submit', (e) => {
  e.preventDefault();
  const key = $('jcs-key').value.trim();
  $('jcs-help').classList.remove('bad');
  if (!key) { onProvidersError({ text: 'Paste the provider’s API key first.' }); return; }
  send({ type: 'providers_add', kind: jcsKind, name: $('jcs-name').value.trim(), key, base_url: $('jcs-url').value.trim(), auth: $('jcs-auth').value });
  $('jcs-key').value = '';  // sent once, to the Keychain; never kept here
  $('jcs-name').value = '';
  $('jcs-help').textContent = 'Adding…';
});
['jcs-key', 'jcs-name', 'jcs-url'].forEach((id) => $(id).addEventListener('input', () => { $('jcs-help').classList.remove('bad'); }));

let awake = false;
$('jc-more').addEventListener('click', () => {
  const t = currentTask();
  openMenu($('jc-more'), [
    { label: 'Artifacts', run: () => openPane('artifacts') },
    { label: 'Files', key: '⇧⌘F', run: () => openPane('files') },
    { label: 'Background tasks', run: () => openPane('background') },
    { label: 'iOS Simulator', run: () => openPane('sim') },
    { label: 'MCP servers', run: () => openPane('mcp') },
    { label: 'Activity', note: 'Every step and why it ran', run: () => openPane('audit') },
    { label: 'Permissions', run: () => openPane('rules') },
    ...featureMoreItems.filter((i) => !i.when || i.when(t)).map(({ when, ...item }) => item),
    '-',
    { label: 'Rename session…', run: () => $('jc-title').dispatchEvent(new MouseEvent('dblclick')) },
    { label: 'Fork session', run: () => { if (t) { awakeNewSessionFork(t); } } },
    { label: 'Export transcript', run: () => t && send({ type: 'task_export', id: t.id }) },
    { label: 'Interrupt', key: 'Esc', run: () => t && send({ type: 'task_interrupt', id: t.id }) },
    { label: 'End session', run: () => t && send({ type: 'task_cancel', id: t.id }) },
    '-',
    { label: 'Keep computer awake', note: 'While Jarvis Code works', switch: awake, run: () => send({ type: 'awake', on: !awake }) },
  ]);
});
// Activity: every step a session took and why it could (automatic, you allowed it, denied,
// Bypass), filterable; the Permissions pane is where the rules behind "automatic" live.
let auditItems = [];
let auditFor = null;  // the session auditItems are the steps of
// The steps shown are the session's own: another session's go, and its own are asked for.
function askAudit(t) {
  if (auditFor !== t.id) { auditItems = []; auditFor = t.id; }
  send({ type: 'task_audit', id: t.id });
}
let auditFilter = 'all';
let auditQuery = '';
const AUDIT_FILTERS = [['all', 'All'], ['commands', 'Commands'], ['edits', 'Edits'], ['web', 'Web'], ['asked', 'You decided'], ['denied', 'Denied']];
function auditKind(a) {
  if (a.tool === 'Bash') return 'commands';
  if (/^(Edit|MultiEdit|Write|NotebookEdit)$/.test(a.tool)) return 'edits';
  if (/^(WebFetch|WebSearch)$/.test(a.tool) || a.tool.includes('browser')) return 'web';
  return 'other';
}
function renderAudit(body, t) {
  if (!t) { body.replaceChildren(el('p', 'jc-empty', 'Pick a session to see what it did.')); return; }
  if (auditFor !== t.id) askAudit(t);  // another session picked while the pane is open
  const counts = { auto: 0, allowed: 0, denied: 0, bypass: 0 };
  for (const a of auditItems) counts[a.decision] = (counts[a.decision] || 0) + 1;
  const bar = el('div', 'jc-audit-bar');
  for (const [id, label] of AUDIT_FILTERS) {
    const b = el('button', `jc-audit-filter${auditFilter === id ? ' on' : ''}`, label);
    b.type = 'button';
    b.addEventListener('click', () => { auditFilter = id; renderPaneBody(); });
    bar.append(b);
  }
  const search = el('input', 'jc-field');
  search.placeholder = tr('Search steps…');
  search.value = auditQuery;
  search.addEventListener('input', () => { auditQuery = search.value; renderAuditList(list); });
  const summary = el('p', 'jc-dim', `${auditItems.length} ${tr('steps')} · ${counts.auto} ${tr('automatic')} · ${counts.allowed} ${tr('you allowed')} · ${counts.denied} ${tr('denied')}${counts.bypass ? ` · ${counts.bypass} ${tr('in Bypass')}` : ''}`);
  const list = el('ul', 'jc-audit-list');
  renderAuditList(list);
  body.replaceChildren(summary, bar, search, list);
}
function renderAuditList(list) {
  const q = auditQuery.trim().toLowerCase();
  const shown = auditItems.slice().reverse().filter((a) => (auditFilter === 'all'
    || (auditFilter === 'asked' ? a.decision === 'allowed' || a.decision === 'denied' : auditFilter === 'denied' ? a.decision === 'denied' : auditKind(a) === auditFilter))
    && (!q || `${a.tool} ${a.what} ${a.why}`.toLowerCase().includes(q)));
  if (!shown.length) { list.replaceChildren(el('li', 'jc-empty', auditItems.length ? 'Nothing matches.' : 'Nothing yet: steps show up here as the session works.')); return; }
  list.replaceChildren(...shown.slice(0, 500).map((a) => {
    const li = el('li', `jc-audit-row ${a.decision}`);
    const head = el('div', 'jc-audit-head');
    const time = new Date(a.at).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit', second: '2-digit' });
    head.append(el('span', `jc-audit-chip ${a.decision}`, { auto: 'Automatic', allowed: 'You allowed', denied: 'Denied', bypass: 'Bypass' }[a.decision] || a.decision),
      el('strong', '', a.tool.split('__').pop()), el('span', 'jc-audit-time', time));
    li.append(head, mine(el('code', 'jc-audit-what', a.what)), el('small', 'jc-audit-why', a.why));
    return li;
  }));
}
let bypassBefore = 'ask';
$('jc-bypass').addEventListener('click', () => {
  const s = composerState();
  if (s.mode === 'auto') setMode(bypassBefore === 'auto' ? 'ask' : bypassBefore);
  else { bypassBefore = s.mode; setMode('auto'); } // setMode asks before Bypass goes on
});

function awakeNewSessionFork(t) { awaitingNewSession = true; send({ type: 'task_fork', id: t.id }); }

// ── the workbench pane ──

let currentPane = null;
const PANE_TITLES = { terminal: 'Terminal', diff: 'Changes', sim: 'iOS Simulator', files: 'Files', artifacts: 'Artifacts', background: 'Background tasks', mcp: 'MCP servers', rules: 'Permissions', audit: 'Activity' };
const term = { id: null, xterm: null, fit: null, loading: null, observer: null };
let diffFiles = [];
let simPanel = null; // the iOS Simulator pane (simulator.js) while it's showing
function closeSimPanel() { if (simPanel) { simPanel.unmount(); simPanel = null; } }
let fileView = null;
let mcpServers = [];
let mcpAnswer = null; // the latest answer for the session on show: { id, connected }
let mcpAsked = null; // the session an MCP question is out for
let rules = [];

document.querySelectorAll('.jc-tool[data-pane]').forEach((b) => b.addEventListener('click', () => {
  if (currentPane === b.dataset.pane) closePane(); else openPane(b.dataset.pane);
}));
$('jc-browser').addEventListener('click', () => { if (typeof toggleBrowser === 'function') toggleBrowser(true); });
$('jc-pane-close').addEventListener('click', closePane);

function openPane(kind) {
  if (currentPane === 'sim' && kind !== 'sim') closeSimPanel();
  currentPane = kind;
  $('jc-pane').hidden = false;
  $('jc-pane-title').textContent = PANE_TITLES[kind] || kind;
  document.querySelectorAll('.jc-tool[data-pane]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.pane === kind)));
  const t = currentTask();
  if (kind === 'diff' && t) send({ type: 'task_diff', id: t.id });
  if (kind === 'mcp' && t) { mcpAnswer = null; mcpAsked = t.id; send({ type: 'task_mcp', id: t.id }); }
  if (kind === 'rules' && t) send({ type: 'task_rules', id: t.id });
  if (kind === 'audit' && t) askAudit(t);
  if ((kind === 'files' || kind === 'artifacts') && deckProject && !projectFiles[deckProject]) send({ type: 'project_files', directory: deckProject });
  renderPaneBody();
}

function closePane() {
  if (currentPane === 'sim') closeSimPanel();
  if (currentPane === 'terminal' && term.id) { send({ type: 'term_close', term: term.id }); term.id = null; }
  currentPane = null;
  $('jc-pane').hidden = true;
  document.querySelectorAll('.jc-tool[data-pane]').forEach((b) => b.setAttribute('aria-pressed', 'false'));
}

function renderPaneBody() {
  const body = $('jc-pane-body');
  body.classList.toggle('flush', currentPane === 'terminal');
  $('jc-pane-extra').replaceChildren();
  const t = currentTask();
  const featurePane = featurePanes.get(currentPane);
  if (featurePane) return featurePane.render(body, t);
  if (currentPane === 'terminal') return renderTerminal(body);
  if (currentPane === 'diff') return renderDiffPane(body);
  if (currentPane === 'sim') return renderSimPane(body);
  if (currentPane === 'files') return renderFilesPane(body, (projectFiles[deckProject] || []), 'Filter files…');
  if (currentPane === 'artifacts') {
    const root = t ? t.path : '';
    const changed = (t ? t.files_changed : []).map((f) => (root && f.startsWith(`${root}/`) ? f.slice(root.length + 1) : f));
    const created = diffFiles.filter((f) => f.new).map((f) => f.path);
    return renderFilesPane(body, [...new Set([...changed, ...created])], 'Files this session made or changed');
  }
  if (currentPane === 'background') {
    const items = t ? t.background : [];
    if (!items.length) { body.replaceChildren(el('p', 'jc-empty', 'Nothing running in the background.')); return; }
    const ul = el('ul', 'jc-list');
    ul.append(...items.map((b) => {
      const li = el('li');
      const stop = el('button', 'jc-btn small danger', 'Stop');
      stop.type = 'button';
      stop.addEventListener('click', () => send({ type: 'task_bg_stop', id: t.id, bg: b.id }));
      li.append(el('span', 'jc-dot busy'), el('span', '', b.description || b.kind || b.id), stop);
      return li;
    }));
    body.replaceChildren(ul);
    return;
  }
  if (currentPane === 'mcp') {
    // Why there's nothing to list: no session, one that isn't running (its servers start
    // with it), the answer still to come, or a running session with none.
    const answer = t && mcpAnswer && mcpAnswer.id === t.id ? mcpAnswer : null;
    if (t && !answer && mcpAsked !== t.id) { mcpAsked = t.id; send({ type: 'task_mcp', id: t.id }); }
    const empty = !t ? 'Open a session to see its MCP servers.'
      : !answer ? 'Checking MCP servers…'
        : !answer.connected ? 'MCP servers show while the session is running.'
          : !mcpServers.length ? 'No MCP servers in this project.' : '';
    if (empty) { body.replaceChildren(el('p', 'jc-empty', empty)); return; }
    const ul = el('ul', 'jc-list');
    ul.append(...mcpServers.map((s) => { const li = el('li'); li.append(el('span', '', s.name), el('small', '', s.status)); return li; }));
    body.replaceChildren(ul);
    return;
  }
  if (currentPane === 'audit') return renderAudit(body, t);
  if (currentPane === 'rules') {
    const ro = el('div', 'jc-audit-switch');
    const sw = el('button', `sw${prefs && prefs.code_read_only !== false ? ' on' : ''}`);
    sw.type = 'button';
    sw.setAttribute('role', 'switch');
    sw.setAttribute('aria-checked', String(!!(prefs && prefs.code_read_only !== false)));
    sw.setAttribute('aria-label', 'Read-only commands without asking');
    sw.addEventListener('click', () => setPrefs({ code_read_only: !(prefs && prefs.code_read_only !== false) }));
    ro.append(el('span', '', ''), sw);
    ro.firstChild.append(el('strong', '', 'Read-only commands without asking'), el('small', '', 'ls, cat, grep, git status, git log, git diff… Anything that writes, deletes, installs or chains commands still asks.'));
    const intro = el('p', 'jc-dim', 'Commands Jarvis Code runs here without asking (from “Yes, and don’t ask again”).');
    if (!rules.length) { body.replaceChildren(ro, intro, el('p', 'jc-empty', 'None yet.')); return; }
    const ul = el('ul', 'jc-list');
    ul.append(...rules.map((r) => {
      const li = el('li');
      const rm = el('button', 'jc-btn small', 'Remove');
      rm.type = 'button';
      rm.addEventListener('click', () => send({ type: 'task_rules', id: t.id, remove: r }));
      li.append(el('span', '', ''), rm);
      li.firstChild.append(el('code', '', `${r} …`));
      return li;
    }));
    body.replaceChildren(ro, intro, ul);
  }
}

// Undo this session's own changes in one file (never another's edits in it): a second
// click within a few seconds confirms.
function revertButton(t, path) {
  const b = el('button', 'jc-mini jc-revert', 'Revert');
  b.type = 'button';
  b.title = tr('Undo this session’s own changes in this file');
  let armed = 0;
  b.addEventListener('click', (e) => {
    e.preventDefault();  // (inside the summary: never opens or closes the file)
    e.stopPropagation();
    if (!armed) {
      b.textContent = tr('Click to revert');
      b.classList.add('armed');
      armed = setTimeout(() => { armed = 0; b.textContent = tr('Revert'); b.classList.remove('armed'); }, 3500);
      return;
    }
    clearTimeout(armed);
    armed = 0;
    send({ type: 'task_revert', id: t.id, path });
  });
  return b;
}

function renderDiffPane(body) {
  const t = currentTask();
  if (!t) { body.replaceChildren(el('p', 'jc-empty', 'Open a session to see its changes.')); return; }
  if (!diffFiles.length) { body.replaceChildren(el('p', 'jc-empty', 'No changes against the last commit.')); return; }
  const added = diffFiles.reduce((n, f) => n + f.added, 0), removed = diffFiles.reduce((n, f) => n + f.removed, 0);
  const extra = el('span', 'jc-dim');
  extra.append(el('span', 'jc-plus', `+${added}`), document.createTextNode(' '), el('span', 'jc-minus', `−${removed}`));
  $('jc-pane-extra').replaceChildren(extra);
  body.replaceChildren(...diffFiles.map((f, i) => {
    const det = el('details', 'jc-card jc-diff-file');
    det.open = i < 4;
    const sum = el('summary');
    sum.append(el('span', '', f.path), el('span', 'jc-spacer'), el('span', 'jc-plus', `+${f.added}`), el('span', 'jc-minus', `−${f.removed}`));
    if (!f.new) sum.append(revertButton(t, f.path));
    det.append(sum);
    const text = f.hunks.map((h) => [`@@ line ${h.line}${h.where ? ` · ${h.where}` : ''}`, ...h.removed.map((l) => `-${l}`), ...h.added.map((l) => `+${l}`)].join('\n')).join('\n');
    det.append(diffBlock(text));
    return det;
  }));
}

function renderSimPane(body) {
  // Mounted once: renderPaneBody runs again on unrelated changes and mustn't restart the stream.
  if (simPanel && !simPanel.closed && body.contains(simPanel.el)) return;
  closeSimPanel();
  simPanel = window.JarvisSim.mount(body, { send });
}

function renderFilesPane(body, files, placeholder) {
  const filter = el('input', 'jc-field');
  filter.placeholder = placeholder;
  filter.style.width = '100%';
  const list = el('ul', 'jc-files-list');
  const viewer = el('div', 'jc-viewer');
  const draw = () => {
    const q = filter.value.trim().toLowerCase();
    const shown = files.filter((f) => !q || f.toLowerCase().includes(q)).slice(0, 300);
    list.replaceChildren(...(shown.length ? shown.map((f) => {
      const li = el('li');
      const b = mine(el('button', '', f));
      b.type = 'button';
      b.addEventListener('click', () => { fileView = { path: f }; send({ type: 'file_read', directory: deckProject, path: f }); drawViewer(viewer); });
      li.append(b);
      return li;
    }) : [el('li', 'jc-empty', files.length ? 'No matches.' : 'Nothing here yet.')]));
  };
  filter.addEventListener('input', draw);
  draw();
  drawViewer(viewer);
  body.replaceChildren(filter, list, viewer);
  filter.focus();
}

// Files and artifacts: Markdown, HTML, CSV and JSON show as what they are (Source flips
// to the text); Open hands the file to its own app.
const PREVIEWS = { md: 'markdown', markdown: 'markdown', html: 'html', htm: 'html', csv: 'csv', tsv: 'csv', json: 'json' };
let viewSource = false;

function csvRows(text, sep) {
  const rows = [];
  let row = [], cell = '', quoted = false;
  for (let i = 0; i < text.length && rows.length < 201; i += 1) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i += 1; } else if (c === '"') quoted = false; else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === sep) { row.push(cell); cell = ''; }
    else if (c === '\n') { row.push(cell.replace(/\r$/, '')); rows.push(row); row = []; cell = ''; }
    else cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

function previewOf(path, text) {
  const kind = PREVIEWS[(path.split('.').pop() || '').toLowerCase()];
  if (!kind || viewSource) return null;
  if (kind === 'markdown') { const d = el('div', 'jc-preview jc-md'); d.append(richText(text)); return d; }
  if (kind === 'html') {
    const frame = document.createElement('iframe');
    frame.className = 'jc-preview jc-html';
    frame.setAttribute('sandbox', ''); // no scripts, no forms, no same-origin
    frame.srcdoc = text;
    return frame;
  }
  if (kind === 'json') {
    try { const pre = el('pre', 'jc-code'); pre.textContent = JSON.stringify(JSON.parse(text), null, 2); return pre; } catch (_) { return null; }
  }
  const rows = csvRows(text, path.toLowerCase().endsWith('.tsv') ? '\t' : ',');
  if (!rows.length) return null;
  const wrap = el('div', 'jc-preview jc-table-wrap');
  const table = el('table', 'jc-table');
  rows.forEach((r, i) => {
    const tr = el('tr');
    r.forEach((c) => tr.append(el(i === 0 ? 'th' : 'td', '', c)));
    table.append(tr);
  });
  wrap.append(table);
  return wrap;
}

function drawViewer(viewer) {
  viewer = viewer || document.querySelector('#jc-pane-body .jc-viewer');
  if (!viewer || !fileView) return;
  if (!fileView.text && !fileView.error) { viewer.replaceChildren(el('p', 'jc-dim', `Opening ${fileView.path}…`)); return; }
  const bar = el('div', 'jc-viewer-bar');
  bar.append(el('span', 'jc-label', fileView.path + (fileView.truncated ? ' (first 300 KB)' : '')));
  const kind = PREVIEWS[(fileView.path.split('.').pop() || '').toLowerCase()];
  if (kind && !fileView.error) {
    const flip = el('button', 'jc-btn small', viewSource ? 'Preview' : 'Source');
    flip.type = 'button';
    flip.addEventListener('click', () => { viewSource = !viewSource; drawViewer(viewer); });
    bar.append(flip);
  }
  const open = el('button', 'jc-btn small', 'Open');
  open.type = 'button';
  open.title = 'Open in its own app';
  open.addEventListener('click', () => send({ type: 'file_open', directory: deckProject, path: fileView.path }));
  bar.append(open);
  if (fileView.error) { viewer.replaceChildren(bar, el('p', 'jc-dim', fileView.error)); return; }
  let body = previewOf(fileView.path, fileView.text);
  if (!body) {
    body = el('pre', 'jc-code');
    for (const line of fileView.text.split('\n').slice(0, 4000)) body.append(el('span', 'ln', `${line}\n`));
  }
  viewer.replaceChildren(bar, body);
  viewer.scrollIntoView({ block: 'nearest' });
}

// The terminal: xterm.js drawing a real shell in the project folder.
function loadScript(src) {
  return new Promise((resolve, reject) => { const s = document.createElement('script'); s.src = src; s.onload = resolve; s.onerror = reject; document.head.append(s); });
}
async function ensureXterm() {
  if (window.Terminal && window.FitAddon) return;
  if (!term.loading) {
    const css = document.createElement('link');
    css.rel = 'stylesheet';
    css.href = '/xterm/xterm/css/xterm.css';
    document.head.append(css);
    term.loading = loadScript('/xterm/xterm/lib/xterm.js').then(() => loadScript('/xterm/addon-fit/lib/addon-fit.js'));
  }
  await term.loading;
}

async function renderTerminal(body) {
  const t = currentTask();
  if (!t && !deckProject) { body.replaceChildren(el('p', 'jc-empty', 'Pick a project first.')); return; }
  const host = el('div', 'jc-term');
  body.replaceChildren(host);
  try { await ensureXterm(); } catch (_) { host.replaceChildren(el('p', 'jc-empty', 'The terminal component didn’t load.')); return; }
  if (!term.xterm) {
    term.xterm = new window.Terminal({
      fontFamily: 'ui-monospace, "SF Mono", Menlo, monospace', fontSize: 12.5, cursorBlink: true, allowProposedApi: false,
      theme: { background: '#0d0d10', foreground: '#e6e6ea', cursor: '#40b0f0', selectionBackground: 'rgba(64,176,240,0.35)' },
    });
    term.fit = new window.FitAddon.FitAddon();
    term.xterm.loadAddon(term.fit);
    term.xterm.onData((data) => term.id && send({ type: 'term_input', term: term.id, data }));
  }
  term.xterm.open(host);
  requestAnimationFrame(() => { try { term.fit.fit(); } catch (_) { /* hidden */ } sendTermSize(); term.xterm.focus(); });
  if (term.observer) term.observer.disconnect();
  term.observer = new ResizeObserver(() => { try { term.fit.fit(); } catch (_) { /* hidden */ } sendTermSize(); });
  term.observer.observe(host);
  send(t ? { type: 'term_open', id: t.id } : { type: 'term_open', directory: deckProject });
}
function sendTermSize() {
  if (term.id && term.xterm) send({ type: 'term_resize', term: term.id, cols: term.xterm.cols, rows: term.xterm.rows });
}
function onTermOpen(ev) {
  term.id = ev.term;
  $('jc-pane-extra').replaceChildren(el('span', 'jc-dim', ev.folder));
  sendTermSize();
}
function onTermData(ev) {
  if (!term.xterm || ev.term !== term.id) return;
  const bytes = Uint8Array.from(atob(ev.data), (c) => c.charCodeAt(0));
  term.xterm.write(bytes);
}

// ── voice coding: which session your voice goes to ──
let voiceFocus = null;
const MODE_LABELS = MODE_NAMES;

function onVoiceCode(focus) {
  voiceFocus = focus || null;
  $('code-pill').hidden = !voiceFocus;
  if (voiceFocus) $('code-text').textContent = `Voice coding · ${voiceFocus.folder} · ${MODE_LABELS[voiceFocus.mode] || voiceFocus.mode}`;
  $('cc-voice-head').setAttribute('aria-pressed', String(!!voiceFocus));
  $('cc-voice-label').textContent = voiceFocus ? `Voice · ${voiceFocus.folder}` : 'Voice off';
  $('deck-input').placeholder = voiceFocus && voiceFocus.id === ccSelected ? 'Listening: just talk (say “exit code mode” to stop), or type…' : 'Ask Jarvis Code to plan, build or fix something…';
  renderProjects(deckProjects);
}

$('cc-voice-head').addEventListener('click', () => {
  if (voiceFocus) send({ type: 'voicecode_exit' });
  else if (ccSelected) send({ type: 'voicecode_enter', id: ccSelected });
  else newSession(true);
});
$('code-exit').addEventListener('click', () => send({ type: 'voicecode_exit' }));

// Events for Jarvis Code beyond the core ones.
function onJarvisCodeEvent(ev) {
  switch (ev.type) {
    case 'task_stream': onStream(ev); return true;
    case 'task_entry_meta': onEntryMeta(ev); return true;
    case 'task_diff': if (ev.id === ccSelected) { diffFiles = ev.files || []; if (currentPane === 'diff' || currentPane === 'artifacts') renderPaneBody(); } return true;
    case 'task_rules': if (ev.id === ccSelected) { rules = ev.rules || []; if (currentPane === 'rules') renderPaneBody(); } return true;
    case 'task_audit': if (ev.id === ccSelected) { auditItems = ev.items || []; auditFor = ev.id; if (currentPane === 'audit') renderPaneBody(); } return true;
    case 'task_mcp': if (ev.id === ccSelected) { mcpServers = ev.servers || []; mcpAnswer = { id: ev.id, connected: ev.connected !== false }; mcpAsked = null; if (currentPane === 'mcp') renderPaneBody(); refreshConnectorsMenu(); } return true;
    case 'dictation': onDictation(ev); return true;
    case 'providers': onProviders(ev); return true;
    case 'providers_check': onProviderCheck(ev); return true;
    case 'providers_error': onProvidersError(ev); return true;
    case 'slash_list': customSlash[ev.directory] = ev.items || []; if (!$('cc-slash').hidden) renderSuggestions(); return true;
    case 'project_files': projectFiles[ev.directory] = ev.files || []; if (currentPane === 'files' && ev.directory === deckProject) renderPaneBody(); return true;
    case 'file_content': if (fileView && ev.path === fileView.path) { fileView = ev; drawViewer(); } return true;
    case 'term_open': onTermOpen(ev); return true;
    case 'term_data': onTermData(ev); return true;
    case 'term_exit':
      if (ev.term === term.id) {
        if (term.xterm) term.xterm.write('\r\n[shell exited — reopen the Terminal to start a new one]\r\n');
        term.id = null;
      }
      return true;
    case 'sim_list': case 'sim_status': case 'sim_frame': case 'sim_shot': case 'sim_apps':
    case 'sim_error': case 'sim_installed': case 'sim_watch_ended':
      if (simPanel) simPanel.onEvent(ev);
      return true;
    case 'awake': awake = !!ev.on; return true;
    default: return false;
  }
}

// ── built-in browser (in the J.A.R.V.I.S. app only) ──

// ── The browser: a dock at the side, resizable, where the BSH Research Center opens ──
// The page is a native view over #browser-slot. Hands steer whatever it shows (a "page"
// target: aim with the hand, pinch to open, pinch and move to scroll, swipe to go back,
// fist to close); on the Research Center's own pages only Jarvis can drive it.

const BD_MIN = 380;
// What the header calls each Research Center page (its own titles don't say).
const RC_NAMES = {
  '/': 'Home', '/markets': 'Markets', '/market-radar': 'Markets · Market', '/weekly-summary': 'Markets · Pulse',
  '/news-desk': 'Markets · News', '/research-desk': 'Research desk', '/reports': 'Reports', '/tracking': 'Tracking',
  '/messages': 'Messages', '/trader-stats': 'Trader stats', '/stock-research': 'Stock research',
  '/source-library': 'Source library', '/innovation-lab': 'Innovation lab', '/help': 'Help', '/settings': 'Settings',
  '/login': 'Sign in',
};
let browserOpenNow = false;
let browserState = {};
let pageHover = null; // what a pinch would open, as the page reports it
let noteUntil = 0;
let researchShown = false;
let lastResearchPath = '/markets';

function browserOpen() { return browserOpenNow; }
// '' when none is set (a new install): Markets is then only the markets.
function researchBaseUrl() { return (prefs && prefs.research_url) || ''; }

function pageName(url, title, base = '') {
  const own = String(title || '').replace(/[|·–—-]\s*BSH Research Center\s*$/i, '').trim();
  if (own && !/^BSH Research Center$/i.test(own)) return own;
  let path = '/';
  try {
    path = new URL(url).pathname;
    // The hosted Research Center lives under /research: its pages are named without it.
    let root = '';
    try { root = new URL(base).pathname.replace(/\/+$/, ''); } catch (_) { /* no base given */ }
    if (root && (path === root || path.startsWith(`${root}/`))) path = path.slice(root.length) || '/';
    let end = path.length;
    while (end > 0 && path[end - 1] === '/') end -= 1; // a loop: /\/+$/ is quadratic on long runs
    path = path.slice(0, end) || '/';
  } catch (_) { return own; }
  if (RC_NAMES[path]) return RC_NAMES[path];
  let last = path.split('/').filter(Boolean).pop() || '';
  try { last = decodeURIComponent(last); } catch (_) { /* a malformed %-escape: shown as it is */ }
  return last ? last.replace(/[-_]/g, ' ').replace(/^./, (c) => c.toUpperCase()) : 'Home';
}

function dockWidth() {
  if (document.body.classList.contains('browser-full') || document.body.classList.contains('browser-page-full')) return window.innerWidth;
  let saved = 0;
  try { saved = Number(localStorage.getItem('jarvis.browserWidth')) || 0; } catch (_) { /* private mode */ }
  const max = Math.max(BD_MIN, window.innerWidth - 420);
  return Math.round(Math.min(max, Math.max(BD_MIN, saved || window.innerWidth * 0.46)));
}

function applyDockWidth(w) {
  document.body.style.setProperty('--bd-w', `${w}px`);
  // The dashboard shares the window with the dock: its side panels step back when narrow.
  document.body.classList.toggle('browser-narrow', window.innerWidth - w < 1100);
  // A slim dock keeps room for the address: Bookmarks is then a tab in History's panel.
  document.body.classList.toggle('browser-slim', w < 460);
}

function slotBounds() {
  const r = $('browser-slot').getBoundingClientRect();
  return { x: r.left, y: r.top, width: r.width, height: r.height };
}

function syncBrowserBounds() {
  if (browserOpenNow && app && app.browser && $('br-message').hidden && $('bd-lib').hidden) {
    const b = slotBounds();
    slotSeen = boundsKey(b);
    app.browser.setBounds(b);
  }
}

// The page is a native view laid over the slot, so it goes where it's told, not where the
// slot is. The slot also moves without changing size (the dock slides in, full screen and
// the guide strip shift it), which no ResizeObserver sees; so while the browser is open,
// every frame checks where the slot is and moves the page there when it has moved.
let slotSeen = '';
let slotWatching = false;
const boundsKey = (b) => [b.x, b.y, b.width, b.height].map(Math.round).join(',');
function watchSlot() {
  if (slotWatching) return;
  slotWatching = true;
  const tick = () => {
    if (!browserOpenNow) { slotWatching = false; slotSeen = ''; return; }
    if (boundsKey(slotBounds()) !== slotSeen) syncBrowserBounds();
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

function toggleBrowser(open) {
  if (!app || !app.browser) return;
  browserOpenNow = open;
  $('browser').hidden = !open;
  document.body.classList.toggle('browser-open', open);
  $('browser-btn').setAttribute('aria-expanded', String(open));
  if (open) {
    applyDockWidth(dockWidth());
    requestAnimationFrame(() => { const b = slotBounds(); slotSeen = boundsKey(b); app.browser.show(b); watchSlot(); });
  } else {
    app.browser.hide();
    if (app.browser.find) { closeFind(); closeLibrary(); document.body.classList.remove('browser-full', 'browser-page-full'); $('br-full').setAttribute('aria-pressed', 'false'); }
    document.body.style.removeProperty('--bd-w');
    document.body.classList.remove('browser-narrow');
    pageHover = null;
    if (researchShown) { researchShown = false; send({ type: 'research_state', open: false }); }
  }
  $('bd-guide').hidden = !(open && handsOn);
  retargetHands();
}

async function openResearch(path = '/markets') {
  if (!researchBaseUrl()) return { error: 'No Research Center is set up. Add its address in Settings › Markets.' };
  lastResearchPath = path;
  if (!app || !app.browser) {
    window.open(`${researchBaseUrl()}${path}`, '_blank', 'noopener');
    return { ok: true };
  }
  if (!browserOpenNow) toggleBrowser(true);
  $('br-message').hidden = true;
  return app.browser.command({ action: 'research', args: { base: researchBaseUrl(), path } });
}

// Tabs, as in Safari: the page's title (the Research Center's own page name), a close button
// on hover or on the tab you're on, and + for a new one. ⌘T and ⌘W work in the page too.
let tabsShown = '';
let tabOnShow = null; // the pill lifts only when the tab on show changes
function renderTabs(list) {
  const key = JSON.stringify(list.map((t) => [t.id, t.title, t.url, t.active, t.loading, t.pinned, t.audible, t.muted, t.split, t.popout, t.private, t.agentProfile, (t.favicon || '').length]));
  if (key === tabsShown) return;
  tabsShown = key;
  const strip = $('bd-tabs');
  const now = (list.find((t) => t.active) || {}).id;
  const lift = now !== tabOnShow && tabOnShow !== null;
  tabOnShow = now;
  strip.replaceChildren(...list.map((t) => {
    const tab = el('div', `bd-tab${t.active ? ' active' : ''}${t.active && lift ? ' lift' : ''}${t.loading ? ' loading' : ''}`);
    tab.setAttribute('role', 'tab');
    tab.setAttribute('aria-selected', String(t.active));
    tab.tabIndex = 0;
    let host = '';
    try { host = new URL(t.url).host; } catch (_) { /* an empty tab */ }
    const title = t.research ? `Research · ${pageName(t.url, t.title, researchBaseUrl())}` : (t.title || host || 'New tab');
    tab.title = title;
    tab.append(mine(el('span', 'bd-tab-title', title)));
    const pick = () => app.browser.tab('select', t.id);
    tab.addEventListener('click', pick);
    tab.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(); } });
    if (list.length > 1) {
      const x = el('button', 'bd-tab-x', '✕');
      x.type = 'button';
      x.setAttribute('aria-label', 'Close tab');
      x.addEventListener('click', (e) => { e.stopPropagation(); app.browser.tab('close', t.id); });
      tab.append(x);
    }
    tab.dataset.tab = t.id;
    for (const fn of featureTabs) {
      try { fn(tab, t); } catch (err) { console.error('feature tab', err); }
    }
    return tab;
  }));
  const plus = el('button', 'bd-tab-new', '+');
  plus.type = 'button';
  plus.setAttribute('aria-label', 'New tab');
  plus.title = 'New tab (⌘T)';
  plus.addEventListener('click', () => { app.browser.tab('new'); setTimeout(() => $('br-url').focus(), 120); });
  strip.append(plus);
  const active = strip.querySelector('.bd-tab.active');
  if (active) active.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  requestAnimationFrame(syncBrowserBounds); // the strip's height is the slot's
}
// ── Chrome's everyday features: shortcuts, find, bookmarks and history, suggestions,
// downloads (each asks first) and full screen ──

// The same shortcuts as Chrome, whether the page or Jarvis's window has the keyboard (the
// page's come from the main process as 'browser:shortcut').
function browserKey(action) {
  switch (action) {
    case 'address': $('br-url').focus(); $('br-url').select(); break;
    case 'find': openFind(); break;
    case 'bookmark': toggleBookmark(); break;
    case 'history': toggleLibrary('history'); break;
    case 'full': setBrowserFull(!document.body.classList.contains('browser-full')); break;
    case 'close': toggleBrowser(false); break;
    default: break;
  }
}
window.addEventListener('keydown', (e) => {
  if (!browserOpenNow || !app || !app.browser) return;
  const key = e.key.toLowerCase();
  const act = (fn) => { e.preventDefault(); fn(); };
  if (e.ctrlKey && key === 'tab') return act(() => app.browser.shortcut(e.shiftKey ? 'previous' : 'next'));
  if (!e.metaKey) return;
  if (e.ctrlKey && key === 'f') return act(() => browserKey('full'));
  if (e.altKey) { if (key === 'i' || e.code === 'KeyI') act(() => app.browser.shortcut('devtools')); return; }
  if (e.shiftKey) {
    if (key === 't') act(() => app.browser.shortcut('reopen'));
    if (key === '[' || key === '{') act(() => app.browser.shortcut('previous'));
    if (key === ']' || key === '}') act(() => app.browser.shortcut('next'));
    return;
  }
  const typing = document.activeElement && /^(INPUT|TEXTAREA)$/.test(document.activeElement.tagName) && document.activeElement !== $('br-url');
  if (typing && !['t', 'w'].includes(key)) return; // Jarvis's own fields keep their keys
  if (key === 't') return act(() => { app.browser.tab('new'); setTimeout(() => $('br-url').focus(), 120); });
  if (key === 'w') return act(() => ((browserState.tabs || []).length > 1 ? app.browser.tab('close') : toggleBrowser(false)));
  if (key === 'l') return act(() => browserKey('address'));
  if (key === 'f') return act(() => browserKey('find'));
  if (key === 'd') return act(() => browserKey('bookmark'));
  if (key === 'y') return act(() => browserKey('history'));
  if (key === 'r') return act(() => app.browser.nav('reload'));
  if (key === '[') return act(() => app.browser.nav('back'));
  if (key === ']') return act(() => app.browser.nav('forward'));
  if (key === 'p') return act(() => app.browser.shortcut('print'));
  if (key === '=' || key === '+') return act(() => app.browser.shortcut('zoom-in'));
  if (key === '-') return act(() => app.browser.shortcut('zoom-out'));
  if (key === '0') return act(() => app.browser.shortcut('zoom-reset'));
  if (/^[1-9]$/.test(key)) return act(() => app.browser.shortcut(`tab${key}`));
});

// Esc leaves full screen first (before anything else takes Esc to close the browser).
window.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape' || !browserOpenNow || !document.body.classList.contains('browser-full')) return;
  if (!$('bd-find').hidden || !$('bd-lib').hidden) return;
  e.preventDefault();
  e.stopImmediatePropagation();
  setBrowserFull(false);
}, true);

// Find in page (⌘F): matches as you type, ↩ / ⇧↩ for next and previous.
let findText = '';
function openFind() {
  $('bd-find').hidden = false;
  $('bd-find-input').focus();
  $('bd-find-input').select();
  requestAnimationFrame(syncBrowserBounds);
}
function closeFind() {
  if ($('bd-find').hidden) return;
  $('bd-find').hidden = true;
  findText = '';
  $('bd-find-count').textContent = '';
  app.browser.find({ stop: true });
  requestAnimationFrame(syncBrowserBounds);
}
function findStep(forward) {
  const text = $('bd-find-input').value;
  if (!text) { closeFindResults(); return; }
  app.browser.find({ text, forward, next: text === findText });
  findText = text;
}
function closeFindResults() { findText = ''; $('bd-find-count').textContent = ''; app.browser.find({ stop: true }); }

// Bookmarks (★ in the address bar, ⌘D) and history (⌘Y), shown in place of the page.
let libKind = 'bookmarks';
let libData = { bookmarks: [], history: [] };
async function refreshLibrary(action, url, title) {
  libData = (await app.browser.data(action, url, title)) || libData;
  const here = browserState.url || '';
  $('br-star').setAttribute('aria-pressed', String(libData.bookmarks.some((b) => b.url === here)));
  const seen = new Set();
  $('br-suggest').replaceChildren(...[...libData.bookmarks, ...libData.history].filter((x) => !seen.has(x.url) && seen.add(x.url)).slice(0, 200).map((x) => {
    const o = el('option');
    o.value = x.url;
    o.label = x.title || x.url;
    return o;
  }));
  if (!$('bd-lib').hidden) renderLibrary();
}
function toggleBookmark() {
  const url = browserState.url || '';
  if (!/^https?:/.test(url)) return;
  refreshLibrary('bookmark', url, browserState.title || url);
}
// History (the clock) and Bookmarks (the book) are one panel with two tabs: each button
// opens its tab, switches to it when the other is showing, and closes it when it's lit.
function toggleLibrary(kind) {
  if ($('bd-lib').hidden) return openLibrary(kind);
  if (libKind === kind) return closeLibrary();
  libKind = kind;
  renderLibrary();
}
function openLibrary(kind) {
  libKind = kind;
  $('bd-lib').hidden = false;
  app.browser.hide(); // the page is a native view over the slot: it steps aside
  refreshLibrary();
  renderLibrary();
  $('bd-lib-search').value = '';
  $('bd-lib-search').focus();
}
function closeLibrary() {
  if ($('bd-lib').hidden) return;
  $('bd-lib').hidden = true;
  $('br-library').setAttribute('aria-pressed', 'false');
  $('br-history').setAttribute('aria-pressed', 'false');
  if (browserOpenNow && $('br-message').hidden) app.browser.show(slotBounds());
}
function renderLibrary() {
  $('bd-lib-bookmarks').setAttribute('aria-selected', String(libKind === 'bookmarks'));
  $('bd-lib-history').setAttribute('aria-selected', String(libKind === 'history'));
  $('br-library').setAttribute('aria-pressed', String(libKind === 'bookmarks'));
  $('br-history').setAttribute('aria-pressed', String(libKind === 'history'));
  $('bd-lib-clear').hidden = libKind !== 'history' || !libData.history.length;
  const q = $('bd-lib-search').value.trim().toLowerCase();
  if (libKind === 'bookmarks' && featureBookmarks) { featureBookmarks($('bd-lib-list'), libData.bookmarks, q); return; }
  const items = (libKind === 'bookmarks' ? libData.bookmarks.slice().reverse() : libData.history)
    .filter((x) => !q || `${x.title} ${x.url}`.toLowerCase().includes(q)).slice(0, 300);
  let day = '';
  const rows = [];
  for (const x of items) {
    if (libKind === 'history') {
      const d = new Date(x.at).toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' });
      if (d !== day) { day = d; rows.push(el('li', 'bd-lib-day', d)); }
    }
    const li = el('li', 'bd-lib-row');
    const go = el('button', 'bd-lib-go');
    go.type = 'button';
    let host = x.url;
    try { host = new URL(x.url).host; } catch (_) { /* shown as it is */ }
    go.append(mine(el('span', 'bd-lib-title', x.title || host)), mine(el('span', 'bd-lib-url', host)));
    if (libKind === 'history') go.append(el('span', 'bd-lib-time', new Date(x.at).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })));
    go.addEventListener('click', (e) => {
      if (e.metaKey) app.browser.tab('new', null, x.url);
      else app.browser.nav('go', x.url);
      closeLibrary();
    });
    li.append(go);
    if (libKind === 'bookmarks') {
      const x2 = el('button', 'bd-tab-x', '✕');
      x2.type = 'button';
      x2.setAttribute('aria-label', 'Remove bookmark');
      x2.addEventListener('click', () => refreshLibrary('bookmark', x.url));
      li.append(x2);
    }
    rows.push(li);
  }
  if (!rows.length) rows.push(el('li', 'bd-lib-empty', q ? 'Nothing matches.' : libKind === 'bookmarks' ? 'No bookmarks yet. Press ★ in the address bar (⌘D) to add this page.' : 'No history yet.'));
  $('bd-lib-list').replaceChildren(...rows);
}

// Downloads: each waits for Save (Jarvis can click in this browser; a file never lands on
// the Mac without you), then shows its progress and Show in Finder.
function fileSize(n) {
  if (!n) return '';
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)} GB`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(n / 1e3))} KB`;
}
function onDownload(d) {
  let li = document.querySelector(`#bd-downloads [data-id="${d.id}"]`);
  if (!li) {
    li = el('li', 'bd-dl');
    li.dataset.id = d.id;
    $('bd-downloads').prepend(li);
  }
  const size = fileSize(d.total);
  const text = el('div', 'bd-dl-text');
  const note = d.state === 'asking' ? `${d.from ? `From ${d.from}` : 'Download'}${size ? ` · ${size}` : ''}`
    : d.state === 'progressing' ? `${fileSize(d.received) || '0 KB'}${size ? ` of ${size}` : ''}`
      : d.state === 'completed' ? `Saved to Downloads${size ? ` · ${size}` : ''}` : d.state === 'cancelled' ? 'Cancelled' : 'Didn’t finish';
  text.append(mine(el('b', '', d.name)), el('small', '', note));
  const acts = el('div', 'bd-dl-acts');
  const button = (label, action, cls = '') => {
    const b = el('button', `bd-dl-btn ${cls}`, label);
    b.type = 'button';
    b.addEventListener('click', () => {
      app.browser.download(d.id, action);
      if (action === 'cancel' || action === 'show') setTimeout(() => li.remove(), action === 'show' ? 1500 : 0);
    });
    return b;
  };
  if (d.state === 'asking') acts.append(button('Save', 'save', 'primary'), button('Cancel', 'cancel'));
  else if (d.state === 'progressing') acts.append(button('Cancel', 'cancel'));
  else if (d.state === 'completed') acts.append(button('Show in Finder', 'show'));
  else setTimeout(() => li.remove(), 4000);
  const bar = el('i', 'bd-dl-bar');
  if (d.state === 'progressing' && d.total) bar.style.width = `${Math.round((100 * d.received) / d.total)}%`;
  li.replaceChildren(text, acts, bar);
  li.classList.toggle('asking', d.state === 'asking');
  requestAnimationFrame(syncBrowserBounds);
}

// Full screen: the browser takes the whole window (⌃⌘F, Esc to leave); a page's own full
// screen (a video) also hides the tabs and address bar.
let fullBefore = false;
function setBrowserFull(on) {
  document.body.classList.toggle('browser-full', on);
  $('br-full').setAttribute('aria-pressed', String(on));
  $('br-full').title = on ? 'Leave full screen (Esc)' : 'Full screen (⌃⌘F)';
  if (browserOpenNow) { applyDockWidth(dockWidth()); requestAnimationFrame(syncBrowserBounds); }
}
function setPageFull(on) {
  if (on) fullBefore = document.body.classList.contains('browser-full');
  document.body.classList.toggle('browser-page-full', on);
  setBrowserFull(on || fullBefore);
}

if (app && app.browser && app.browser.find) {
  app.browser.onFound((r) => { $('bd-find-count').textContent = r.matches ? `${r.active} of ${r.matches}` : tr('No matches'); });
  app.browser.onShortcut(browserKey);
  app.browser.onDownload(onDownload);
  app.browser.onPageFullscreen(setPageFull);
  $('bd-find-input').addEventListener('input', () => { findText = ''; findStep(true); });
  $('bd-find-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); findStep(!e.shiftKey); }
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeFind(); }
  });
  $('bd-find-next').addEventListener('click', () => findStep(true));
  $('bd-find-prev').addEventListener('click', () => findStep(false));
  $('bd-find-done').addEventListener('click', closeFind);
  $('br-star').addEventListener('click', toggleBookmark);
  $('br-library').addEventListener('click', () => toggleLibrary('bookmarks'));
  $('br-history').addEventListener('click', () => toggleLibrary('history'));
  $('bd-lib-bookmarks').addEventListener('click', () => { libKind = 'bookmarks'; renderLibrary(); });
  $('bd-lib-history').addEventListener('click', () => { libKind = 'history'; renderLibrary(); });
  $('bd-lib-search').addEventListener('input', renderLibrary);
  $('bd-lib-search').addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeLibrary(); } });
  $('bd-lib-done').addEventListener('click', closeLibrary);
  $('bd-lib-clear').addEventListener('click', () => refreshLibrary('clear-history'));
  $('br-full').addEventListener('click', () => setBrowserFull(!document.body.classList.contains('browser-full')));
  // The shield: ads and trackers blocked on this page; a click allows this site (or blocks it
  // again), ⌥-click turns blocking off or on everywhere.
  $('br-shield').addEventListener('click', (e) => app.browser.shields(e.altKey ? 'toggle' : 'site'));
  app.browser.onState((st) => {
    const sh = st.shields;
    $('br-shield').hidden = !sh || !sh.ready || sh.research || !/^https?:/.test(st.url || '');
    if (!sh) return;
    const on = sh.on && !sh.allowed;
    $('br-shield').setAttribute('aria-pressed', String(on));
    $('br-blocked').textContent = on && sh.blocked ? String(sh.blocked > 999 ? '999+' : sh.blocked) : '';
    $('br-shield').title = !sh.on ? tr('Ad blocking is off everywhere · ⌥-click to turn it on')
      : sh.allowed ? `${tr('Ads allowed on')} ${sh.site} · ${tr('click to block them again')}`
        : `${sh.blocked} ${tr('ads and trackers blocked on this page')} · ${tr('click to allow them on')} ${sh.site} · ${tr('⌥-click: off everywhere')}`;
  });
  let starFor = '';
  app.browser.onState((st) => {
    if (st.url !== starFor) { starFor = st.url; refreshLibrary(); }
    if (!$('bd-lib').hidden && st.url && st.loading) closeLibrary(); // a page went on its way
  });
}

function showBrowserError(text) {
  $('br-message-text').textContent = browserState.research || /Research Center/.test(text)
    ? `${text} Start it, or set its address in Settings › Research Center.` : text;
  $('br-message').hidden = false;
  $('bd-progress').hidden = true;
  if (app && app.browser) app.browser.hide();
}

function showBrowserNote(text) {
  noteUntil = Date.now() + 2600;
  $('bd-status').textContent = text;
  $('bd-status').classList.add('note');
  setTimeout(() => {
    if (Date.now() < noteUntil) return;
    $('bd-status').classList.remove('note');
    $('bd-status').textContent = $('hand-status').textContent;
  }, 2700);
}

const pageTarget = {
  kind: 'page',
  move: (x, y, mode) => app.browser.hand({ t: 'move', x, y, mode }),
  hide: () => app.browser.hand({ t: 'hide', x: 0, y: 0 }),
  press: (x, y) => app.browser.hand({ t: 'press', x, y }),
  drag: (dx, dy) => app.browser.hand({ t: 'drag', dx, dy, x: 0, y: 0 }),
  release: ({ tap, vx, vy }) => app.browser.hand({ t: 'release', tap, vx, vy, x: 0, y: 0 }),
  swipe: (dir) => app.browser.command({ action: dir > 0 ? 'back' : 'forward' }),
  zoomBy: (f) => app.browser.hand({ t: 'zoom', f }),
  hoverLabel: () => (pageHover ? pageHover.label : ''),
  hoverRisky: () => !!(pageHover && pageHover.risky),
};

async function runBrowserCommand(ev) {
  if (!app || !app.browser) return;
  $('br-jarvis').hidden = false;
  const behind = ev.args && (ev.args.background || ev.args.op === 'list'); // work in a tab behind, or a list
  if (!browserOpenNow && !behind && !['read', 'snapshot', 'describe', 'wait', 'console', 'network'].includes(ev.action)) toggleBrowser(true); // looks don't open it
  let result;
  try {
    result = await app.browser.command({ action: ev.action, args: ev.args || {} });
  } catch (err) {
    result = { error: String(err) };
  }
  $('br-jarvis').hidden = true;
  send({ type: 'browser_result', id: ev.id, result });
}

async function runResearchCmd(ev) {
  const args = ev.args || {};
  let result;
  try {
    if (!app || !app.browser) result = { error: 'The Research Center only opens in the J.A.R.V.I.S. app window.' };
    else if (ev.action === 'open') result = await openResearch(args.path || '/markets');
    else if (ev.action === 'close') { toggleBrowser(false); result = { ok: true }; }
    else if (ev.action === 'lock') result = { ok: true, locked: await app.browser.researchLock(!!args.on) };
    else if (!browserOpenNow || !browserState.research) result = { error: 'The Research Center is closed. Open it first.' };
    else result = await app.browser.command({ action: ev.action, args });
  } catch (err) {
    result = { error: String(err) };
  }
  send({ type: 'research_result', id: ev.id, result });
}

// The hand camera's status line doubles as the dock's guide line.
new MutationObserver(() => {
  if (Date.now() >= noteUntil) $('bd-status').textContent = $('hand-status').textContent;
}).observe($('hand-status'), { childList: true, characterData: true, subtree: true });

$('p-markets').addEventListener('click', () => openResearch('/'));
$('p-markets').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openResearch('/'); }
});

if (app && app.browser) {
  $('browser-btn').hidden = false;
  $('browser-btn').addEventListener('click', () => toggleBrowser(!browserOpenNow));
  $('br-close').addEventListener('click', () => toggleBrowser(false));
  $('br-back').addEventListener('click', () => app.browser.nav('back'));
  $('br-forward').addEventListener('click', () => app.browser.nav('forward'));
  $('br-reload').addEventListener('click', () => app.browser.nav('reload'));
  $('br-research').addEventListener('click', () => openResearch(lastResearchPath));
  // The lock badge: J.A.R.V.I.S. only on the Research Center, or your mouse and keyboard too.
  $('br-lock').addEventListener('click', () => app.browser.researchLock(!browserState.lockWanted));
  $('br-retry').addEventListener('click', () => {
    $('br-message').hidden = true;
    app.browser.show(slotBounds());
    if (browserState.research || /Research Center/.test($('br-message-text').textContent)) openResearch(lastResearchPath);
    else app.browser.nav('reload');
  });
  $('browser-bar').addEventListener('submit', (e) => {
    e.preventDefault();
    app.browser.nav('go', $('br-url').value);
    $('br-url').blur();
  });
  // Three states: J.A.R.V.I.S. only (locked), its sign-in page while locked (the user signs
  // in themselves), or shared (the default: the mouse and keyboard work, and so does Jarvis).
  function renderResearchLock(st) {
    const badge = $('br-lock');
    badge.hidden = !st.research;
    const shared = !st.lockWanted;
    badge.classList.toggle('shared', !!st.research && shared);
    badge.classList.toggle('open', !!st.research && !shared && !st.locked);
    badge.setAttribute('aria-pressed', String(!shared));
    $('br-lock-shackle').setAttribute('d', shared ? 'M4 5.5V4a2 2 0 014 0' : 'M4 5.5V4a2 2 0 014 0v1.5');
    $('br-lock-text').textContent = shared ? 'You and J.A.R.V.I.S.' : st.locked ? 'J.A.R.V.I.S. only' : 'Sign in yourself, then I take over';
    badge.title = shared
      ? 'Your mouse and keyboard work here, and J.A.R.V.I.S. can drive it too. Click to make it J.A.R.V.I.S. only.'
      : 'Only J.A.R.V.I.S. drives the Research Center: your voice and your hands. Click to use your mouse and keyboard too.';
  }
  app.browser.onState((st) => {
    browserState = st;
    renderTabs(st.tabs || []);
    if (document.activeElement !== $('br-url')) $('br-url').value = st.url || '';
    $('br-back').disabled = !st.canBack;
    $('br-forward').disabled = !st.canForward;
    $('bd-progress').hidden = !st.loading;
    renderResearchLock(st);
    $('br-zoom').hidden = !st.zoom || st.zoom === 100;
    $('br-zoom').textContent = `${st.zoom}%`;
    if (st.error) showBrowserError(st.error);
    const was = researchShown;
    researchShown = !!st.research && browserOpenNow;
    if (researchShown || was) {
      send({ type: 'research_state', open: researchShown, url: st.url || '', title: pageName(st.url, st.title, researchBaseUrl()), locked: !!st.locked });
    }
  });
  app.browser.onOpen(() => { if (!browserOpenNow) toggleBrowser(true); });
  app.browser.onHover((hover) => { pageHover = hover; });
  app.browser.onNote((note) => { if (note && note.text) showBrowserNote(note.text); });
  app.browser.onEscape(() => {
    if (document.body.classList.contains('browser-full')) setBrowserFull(false);
    else if (browserState.locked) toggleBrowser(false);
  });
  const follow = () => {
    if (!browserOpenNow) return;
    applyDockWidth(dockWidth());
    syncBrowserBounds();
  };
  new ResizeObserver(() => syncBrowserBounds()).observe($('browser-slot'));
  window.addEventListener('resize', follow);

  // Drag the dock's edge to resize it. The page steps out of the way meanwhile: a native
  // view would swallow the pointer as soon as the drag crossed it.
  const handle = $('bd-handle');
  let dragging = false;
  const endDrag = () => {
    if (!dragging) return;
    dragging = false;
    handle.classList.remove('dragging');
    document.body.classList.remove('bd-resizing');
    const w = parseInt(getComputedStyle(document.body).getPropertyValue('--bd-w'), 10);
    try { if (w) localStorage.setItem('jarvis.browserWidth', String(w)); } catch (_) { /* private mode */ }
    if ($('br-message').hidden) app.browser.show(slotBounds());
  };
  handle.addEventListener('pointerdown', (e) => {
    dragging = true;
    handle.setPointerCapture(e.pointerId);
    handle.classList.add('dragging');
    document.body.classList.add('bd-resizing');
    app.browser.hide();
  });
  handle.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    applyDockWidth(Math.round(Math.min(window.innerWidth - 420, Math.max(BD_MIN, window.innerWidth - e.clientX))));
  });
  handle.addEventListener('pointerup', endDrag);
  handle.addEventListener('pointercancel', endDrag);
  handle.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    const w = parseInt(getComputedStyle(document.body).getPropertyValue('--bd-w'), 10) || dockWidth();
    const next = Math.round(Math.min(window.innerWidth - 420, Math.max(BD_MIN, w + (e.key === 'ArrowLeft' ? 40 : -40))));
    applyDockWidth(next);
    try { localStorage.setItem('jarvis.browserWidth', String(next)); } catch (_) { /* private mode */ }
    syncBrowserBounds();
  });
}

// ── location (the app window holds macOS's location permission) ──

let locationWarned = false;

function sendLocation() {
  if (!navigator.geolocation) { send({ type: 'location_fix', error: 'No location services in this window.' }); return; }
  navigator.geolocation.getCurrentPosition(
    (pos) => send({ type: 'location_fix', lat: pos.coords.latitude, lon: pos.coords.longitude, accuracy: pos.coords.accuracy }),
    (err) => send({ type: 'location_fix', error: err.code === 1 ? 'Location access is off for J.A.R.V.I.S. (System Settings > Privacy & Security > Location Services).' : `No location fix: ${err.message}` }),
    { enableHighAccuracy: false, timeout: 15000, maximumAge: 10 * 60 * 1000 },
  );
}

// ── cards ──

let instantShortcuts = new Set();

function renderShortcuts(names, instant) {
  instantShortcuts = new Set(instant);
  const list = $('shortcut-list');
  if (!names.length) {
    list.replaceChildren(el('li', 'muted', 'No shortcuts on this Mac yet. Make some in the Shortcuts app (Home scenes work well).'));
    return;
  }
  list.replaceChildren(...names.map((name) => {
    const li = el('li', 'row');
    const label = el('span', '', name);
    const sw = el('button', 'switch');
    sw.type = 'button';
    sw.setAttribute('role', 'switch');
    sw.setAttribute('aria-checked', String(instant.includes(name)));
    sw.setAttribute('aria-label', `Run “${name}” instantly`);
    sw.addEventListener('click', () => {
      const on = sw.getAttribute('aria-checked') !== 'true';
      sw.setAttribute('aria-checked', String(on));
      // Kept locally too, so two quick toggles don't race the settings echo.
      if (on) instantShortcuts.add(name); else instantShortcuts.delete(name);
      setPrefs({ instant_shortcuts: [...instantShortcuts] });
    });
    li.append(label, sw);
    return li;
  }));
}

// ── the phone companion ──

let remoteCodeTimer = null;

function renderRemote(r) {
  $('remote-on').hidden = !r.running;
  $('remote-error').hidden = !r.error;
  $('remote-error').textContent = r.error || '';
  $('remote-url').textContent = (r.urls || [])[0] || '';
  const devices = r.devices || [];
  $('remote-devices').replaceChildren(...(devices.length ? devices.map((d) => {
    const li = el('li');
    const seen = d.last_seen ? `last used ${new Date(d.last_seen).toLocaleString(uiLocale())}` : 'not used yet';
    const name = el('span', 'fact', `${d.name} · ${seen}`);
    const rm = el('button', 'btn', 'Remove');
    rm.type = 'button';
    rm.setAttribute('aria-label', `Remove ${d.name}`);
    rm.addEventListener('click', () => send({ type: 'remote_remove', id: d.id }));
    li.append(name, rm);
    return li;
  }) : [el('li', 'muted', 'No phones paired yet.')]));
  if (r.running === false) $('remote-code').hidden = true;
}

function showRemoteCode(ev) {
  clearInterval(remoteCodeTimer);
  const until = Date.now() + ev.seconds * 1000;
  const box = $('remote-code');
  box.hidden = false;
  const tick = () => {
    const left = Math.max(0, Math.round((until - Date.now()) / 1000));
    box.textContent = left ? `${ev.code.slice(0, 3)} ${ev.code.slice(3)}  ·  ${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}` : 'Code expired. Pair again for a new one.';
    if (!left) clearInterval(remoteCodeTimer);
  };
  tick();
  remoteCodeTimer = setInterval(tick, 1000);
}

function renderRoutines(items) {
  const list = $('routine-list');
  if (!items.length) {
    list.replaceChildren(el('li', 'muted', 'No routines yet.'));
    return;
  }
  list.replaceChildren(...items.map((r) => {
    const li = el('li', 'routine');
    const text = el('span', 'fact');
    text.append(mine(el('strong', '', r.name)), el('small', '', `${r.when}${r.enabled ? '' : ' · paused'}`));
    text.title = r.prompt;
    const sw = el('button', 'switch');
    sw.type = 'button';
    sw.setAttribute('role', 'switch');
    sw.setAttribute('aria-checked', String(r.enabled));
    sw.setAttribute('aria-label', `${r.name} on`);
    sw.addEventListener('click', () => send({ type: 'routine_toggle', id: r.id, enabled: !r.enabled }));
    const run = el('button', 'btn', 'Run now');
    run.type = 'button';
    run.addEventListener('click', () => send({ type: 'routine_run', id: r.id }));
    const rm = el('button', 'btn', 'Delete');
    rm.type = 'button';
    rm.setAttribute('aria-label', `Delete ${r.name}`);
    rm.addEventListener('click', () => send({ type: 'routine_delete', id: r.id }));
    li.append(text, run, rm, sw);
    return li;
  }));
}

// The calls to the Jarvis number, newest first: who, when, what they said (theirs, never
// translated), and for a time a caller asked for, Book and Let go.
const LINE_KINDS = {
  message: 'Left a message', booking: 'Wants to meet', schedule: 'Wants a time', missed: 'Missed call',
  talk: 'Talked with Jarvis', errand: 'Called for you',
};
const LINE_STATUS = {
  booked: 'Booked', declined: 'Let go', replaced: 'Asked again',
  calling: 'On the call', done: 'Done', failed: "Didn't work out", partial: 'Partly done',
};
function renderLine(line) {
  lineOn = !!line.on;
  setSwitch('sw-line', lineOn);
  $('sw-line').disabled = !!line.busy;
  $('line-options').classList.toggle('off', !lineOn);
  if (line.busy) $('line-note').textContent = tr(line.busy === 'on' ? 'Setting up answering on your Twilio account (about a minute)…' : 'Turning answering off…');
  else $('line-note').textContent = line.note || '';
  const calls = line.calls || [];
  $('line-calls').hidden = !calls.length;
  $('line-calls').replaceChildren(...calls.map((c) => {
    const li = el('li', 'routine');
    const text = el('span', 'fact');
    const when = c.at ? new Date(c.at).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' }) : '';
    // The window's words (what kind of call, what came of it) apart from the caller's time
    // and the clock, so each is translated as it appears.
    const about = el('small');
    about.append(el('bdi', '', LINE_KINDS[c.kind] || ''));
    if (c.kind === 'booking' || (c.kind === 'errand' && c.said)) about.append(' · ', mine(el('bdi', '', c.said)));
    if (LINE_STATUS[c.status]) about.append(' · ', el('bdi', '', LINE_STATUS[c.status]));
    if (when) about.append(' · ', mine(el('bdi', '', when)));
    text.append(mine(el('strong', '', c.who)), about);
    if (c.words) text.append(mine(el('small', 'line-words', `“${c.words}”`)));
    li.append(text);
    if (c.kind === 'booking' && c.status === 'waiting') {
      const book = el('button', 'btn', 'Book');
      book.type = 'button';
      book.setAttribute('aria-label', `Book ${c.who}`);
      book.addEventListener('click', () => send({ type: 'line_book', id: c.id }));
      const drop = el('button', 'btn', 'Let go');
      drop.type = 'button';
      drop.setAttribute('aria-label', `Let ${c.who}'s request go`);
      drop.addEventListener('click', () => send({ type: 'line_decline', id: c.id }));
      li.append(book, drop);
    }
    return li;
  }));
}

function renderMemory(items) {
  const list = $('memory-list');
  if (!items.length) {
    list.replaceChildren(el('li', 'muted', 'Nothing yet.'));
    return;
  }
  list.replaceChildren(...items.map((f) => {
    const li = el('li');
    const text = mine(el('span', 'fact', f.text));
    const rm = el('button', 'btn', 'Forget');
    rm.type = 'button';
    rm.setAttribute('aria-label', `Forget: ${f.text}`);
    rm.addEventListener('click', () => send({ type: 'memory_forget', id: f.id }));
    li.append(text, rm);
    return li;
  }));
}

$('memory-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const text = $('memory-input').value.trim();
  if (text) send({ type: 'memory_add', text });
  $('memory-input').value = '';
});

// ── what JARVIS has learned: your words, who's worth an interruption; your documents ──

function renderHearing(h) {
  const rows = (h.corrections || []).map((c) => {
    const li = el('li');
    const rm = el('button', 'btn', 'Forget');
    rm.type = 'button';
    rm.setAttribute('aria-label', `Forget: ${c.heard}`);
    rm.addEventListener('click', () => send({ type: 'hearing_forget', what: c.heard }));
    li.append(mine(el('span', 'fact', `${c.heard} → ${c.meant}`)), rm);
    return li;
  });
  const words = (h.words || []).map((w) => w.word).slice(0, 40);
  if (words.length) {
    const line = el('span', 'fact');  // one piece, so the row doesn't spread it apart
    line.append(el('span', '', 'Words I listen for'), document.createTextNode(': '), mine(el('span', '', words.join(', '))));
    const li = el('li', 'muted');
    li.append(line);
    rows.push(li);
  }
  $('hearing-list').replaceChildren(...(rows.length ? rows : [el('li', 'muted', 'Nothing learned yet.')]));
}

function renderInterruptLearning(items) {
  $('interrupt-learning-list').replaceChildren(...(items.length ? items.map((r) => {
    const li = el('li');
    const undo = el('button', 'btn', 'Undo');
    undo.type = 'button';
    undo.setAttribute('aria-label', `Undo: ${r.who}`);
    undo.addEventListener('click', () => send({ type: 'interrupt_learning_reset', who: r.who }));
    li.append(mine(el('span', 'fact', r.why)), undo);  // the reason, in the owner's language
    return li;
  }) : [el('li', 'muted', 'Nothing learned yet.')]));
}

function renderDocuments(items) {
  $('document-list').replaceChildren(...(items.length ? items.slice(0, 12).map((d) => {
    const li = el('li');
    const name = mine(el('span', 'fact', d.gist ? `${d.title} — ${d.gist}` : d.title));
    name.title = d.path;
    const open = el('button', 'btn', 'Open');
    open.type = 'button';
    open.addEventListener('click', () => send({ type: 'document_open', path: d.path }));
    const rm = el('button', 'btn', 'Forget');
    rm.type = 'button';
    rm.setAttribute('aria-label', `Forget: ${d.title}`);
    rm.addEventListener('click', () => send({ type: 'document_forget', path: d.path }));
    li.append(name, open, rm);
    return li;
  }) : [el('li', 'muted', 'None yet.')]));
}

// A suggestion of what you'll likely want next: nothing happens without a tap. "Not now"
// and "Don't suggest this" teach it what to leave alone; one left on screen closes quietly.
const SUGGESTION_MS = 10 * 60 * 1000;
function onSuggestion(ev) {
  const key = String(ev.key || '');
  $('cards').querySelectorAll(`[data-suggestion="${CSS.escape(key)}"]`).forEach((n) => n.remove());
  const card = el('div', 'card plain');
  card.dataset.suggestion = key;
  card.append(el('div', 'card-kicker', 'Suggestion'));
  if (ev.title) card.append(mine(el('div', 'card-title', ev.title)));  // may quote a meeting or an email
  if (ev.text) card.append(mine(el('div', 'card-text', ev.text)));
  const actions = el('div', 'card-actions');
  let answered = false;
  const react = (action) => {
    if (answered) return;
    answered = true;
    send({ type: 'suggestion_reaction', key, action });
    card.remove();
    syncDismissAll();
  };
  for (const [label, action, cls] of [['Do it', 'accepted', 'btn primary'], ['Not now', 'dismissed', 'btn'], ['Don’t suggest this', 'never', 'btn']]) {
    const b = el('button', cls, label);
    b.type = 'button';
    b.addEventListener('click', () => react(action));
    actions.append(b);
  }
  card.append(actions);
  $('cards').append(card);
  syncDismissAll();
  setTimeout(() => react('closed'), SUGGESTION_MS);  // also after "Dismiss all" took it away
}

// ── videos: drop one on the window (or name one) to have it summarized ──

const VIDEO_FILE = /\.(mp4|m4v|mov|qt|m4a|m4b|mp3|wav|aiff?|aifc|caf|aac|3gp|3g2|flac|webm|mkv|avi)$/i;
const VIDEO_DONE = ['ready', 'failed', 'cancelled'];
const VIDEO_STATE = { starting: 'Starting…', fetching: 'Fetching…', extracting: 'Pulling out the sound…', ready: 'Ready', failed: 'Failed', cancelled: 'Cancelled' };
const videoCards = new Map();
const isMedia = (f) => f.type.startsWith('video/') || f.type.startsWith('audio/') || VIDEO_FILE.test(f.name);
const dragsFiles = (e) => !!e.dataTransfer && [...e.dataTransfer.types].includes('Files');
const dragsPictures = (e) => [...(e.dataTransfer.items || [])].some((i) => i.kind === 'file' && i.type.startsWith('image/'));
let dropGlow = 0;
document.addEventListener('dragover', (e) => {
  if (!dragsFiles(e)) return;
  e.preventDefault();
  // While pictures are dragged over the window, the request box they'll join is outlined
  // (dragover repeats while the pointer is in the window; leaving it, the outline goes).
  if (!$('cc').hidden || !dragsPictures(e)) return;
  document.body.classList.add('drop-pictures');
  clearTimeout(dropGlow);
  dropGlow = setTimeout(() => document.body.classList.remove('drop-pictures'), 200);
});
document.addEventListener('drop', (e) => {
  document.body.classList.remove('drop-pictures');
  if (!dragsFiles(e) || (e.target.closest && e.target.closest('#deck-composer'))) return;  // the composer attaches its own
  e.preventDefault();  // never open a dropped file in place of the window
  const files = [...e.dataTransfer.files];
  addPictures(files.filter(isPicture));
  const file = files.find(isMedia);
  if (!file) return;
  const path = window.jarvisApp && window.jarvisApp.pathFor ? window.jarvisApp.pathFor(file) : '';
  if (!path) { notice('Video', '', 'Drop the file from Finder.', 5000); return; }
  send({ type: 'video_summarize', path });
});

// ── pictures: drop or paste a screenshot to ask Jarvis about it ──
// They wait as thumbnails by the request box (the one the look shows) and go with what's
// typed there next. With Jarvis Code open they join its composer instead.

const PICTURE_FILE = /\.(png|jpe?g|gif|webp|heic|heif|tiff?|bmp)$/i;
const isPicture = (f) => f.type.startsWith('image/') || PICTURE_FILE.test(f.name);
const PICTURE_EDGE = 2000;  // Claude looks at about 1,600 px on the long side
const PICTURE_BYTES = 3_500_000;  // under Claude's 5 MB a picture once in base64
const PICTURE_TYPES = /^image\/(png|jpeg|gif|webp)$/;
const fittedPictures = new WeakSet();

// A picture as Claude takes it. One already small and in a type Claude reads goes as it is;
// otherwise (a 5K Retina screenshot is 10 MB and more, a HEIC from the iPhone) it's scaled
// to PICTURE_EDGE on its long side and saved as PNG, or JPEG when the PNG is still big.
// null when it can't be read as a picture.
async function fitPicture(file) {
  let bitmap;
  try { bitmap = await createImageBitmap(file); } catch { return null; }
  const scale = Math.min(1, PICTURE_EDGE / Math.max(bitmap.width, bitmap.height));
  if (scale === 1 && file.size <= PICTURE_BYTES && PICTURE_TYPES.test(file.type)) { bitmap.close(); return file; }
  const canvas = new OffscreenCanvas(Math.max(1, Math.round(bitmap.width * scale)), Math.max(1, Math.round(bitmap.height * scale)));
  canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  let blob = await canvas.convertToBlob({ type: 'image/png' });
  if (blob.size > PICTURE_BYTES) blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.88 });
  const fitted = new File([blob], file.name, { type: blob.type });
  fittedPictures.add(fitted);
  return fitted;
}

let askPics = [];  // [{ type, data (base64), url, name, size, order }]
const picsReading = new Set();
let picsOrder = 0;  // pictures read at once keep the order they were dropped in

function requestBox() {
  const look = document.body.dataset.look;
  return $(look === 'console' ? 'chat-input' : 'ask-input');
}

function addPictures(files) {
  if (!files.length) return;
  if (!$('cc').hidden) { files.forEach((f) => addFile(f)); return; }
  files.forEach(addAskPicture);
  requestBox().focus();
}

async function addAskPicture(file) {
  if (askPics.length + picsReading.size >= window.JarvisAttach.LIMITS.files) { notice('Jarvis', '', 'Up to six pictures per request.', 5000); return; }
  const slot = { kind: 'image', size: 0 };
  const order = picsOrder++;
  picsReading.add(slot);
  try {
    const fitted = await fitPicture(file);
    if (!fitted) { notice('Jarvis', '', `${file.name} isn’t a picture Jarvis can read.`, 5000); return; }
    slot.size = fitted.size;
    const held = [...askPics].map((p) => ({ kind: 'image', size: p.size }));
    if (window.JarvisAttach.check(held, 'image', fitted.size)) { notice('Jarvis', '', `${file.name} would make this request too big to send.`, 5000); return; }
    const url = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(fitted);
    });
    const pic = { type: fitted.type, data: url.split(',', 2)[1], url, name: file.name, size: fitted.size, order };
    setAskPics([...askPics, pic].sort((a, b) => a.order - b.order));
  } catch {
    notice('Jarvis', '', `${file.name} couldn’t be read.`, 5000);
  } finally {
    picsReading.delete(slot);
  }
}

function setAskPics(list) {
  askPics = list;
  for (const box of document.querySelectorAll('[data-pics]')) {
    box.hidden = !list.length;
    box.parentElement.classList.toggle('has-pics', list.length > 0);
    box.parentElement.style.setProperty('--pics', String(list.length));
    box.replaceChildren(...list.map((p, i) => {
      const pic = el('span', 'ask-pic');
      pic.title = p.name;
      const img = el('img');
      img.src = p.url;
      img.alt = p.name || 'Picture';
      const x = el('button', 'ask-pic-x', '×');
      x.type = 'button';
      x.setAttribute('aria-label', `Remove ${p.name || 'picture'}`);
      x.addEventListener('click', () => { setAskPics(askPics.filter((_, k) => k !== i)); requestBox().focus(); });
      pic.append(img, x);
      return pic;
    }));
  }
}

for (const id of ['ask-input', 'chat-input']) {
  $(id).addEventListener('paste', (e) => {
    const files = [...(e.clipboardData ? e.clipboardData.files : [])].filter(isPicture);
    if (!files.length) return;
    e.preventDefault();
    files.forEach(addAskPicture);
  });
}

function dropVideoCard(id, card) {
  card.remove();
  videoCards.delete(id);
  syncDismissAll();
}

function onVideo(job) {
  if (!job) return;
  let card = videoCards.get(job.id);
  if (!card) {
    card = el('div', 'card plain');
    card.append(el('div', 'card-kicker', 'Video'), mine(el('div', 'card-title')), el('div', 'card-text'), el('div', 'card-actions'));
    videoCards.set(job.id, card);
    $('cards').append(card);
  }
  if (card.dataset.summary) return;  // the write-up is showing: progress has nothing to add
  card.querySelector('.card-title').textContent = job.title;
  const text = card.querySelector('.card-text');
  if (job.state === 'transcribing') text.textContent = `Transcribing… ${Math.round((job.progress || 0) * 100)}%`;
  else if (job.state === 'failed') mine(text).textContent = job.error || 'Failed';
  else text.textContent = VIDEO_STATE[job.state] || '';
  const actions = card.querySelector('.card-actions');
  const done = VIDEO_DONE.includes(job.state);
  const b = el('button', 'btn', done ? 'Dismiss' : 'Cancel');
  b.type = 'button';
  b.addEventListener('click', () => (done ? dropVideoCard(job.id, card) : send({ type: 'video_cancel', id: job.id })));
  actions.replaceChildren(b);
  syncDismissAll();
}

// The write-up in full: headings, bullets and text as plain text (never HTML).
function onVideoSummary(ev) {
  const card = videoCards.get(ev.id) || el('div', 'card plain');
  card.dataset.summary = '1';
  card.replaceChildren(el('div', 'card-kicker', 'Video summary'), mine(el('div', 'card-title', ev.title)));
  const body = mine(el('div', 'card-text video-summary'));
  for (const line of String(ev.markdown || '').split('\n')) {
    if (!line.trim()) continue;
    const h = line.match(/^#{1,4}\s+(.*)/);
    const b = line.match(/^\s*[-*]\s+(?:\[[ x]\]\s+)?(.*)/);
    body.append(h ? el('h4', '', h[1]) : b ? el('div', 'li', `• ${b[1]}`) : el('p', '', line));
  }
  const actions = el('div', 'card-actions');
  if (ev.path) {
    const open = el('button', 'btn primary', 'Open');
    open.type = 'button';
    open.title = '⌥-click to show it in Finder';
    open.addEventListener('click', (e) => send({ type: 'video_open', id: ev.id, reveal: e.altKey }));
    actions.append(open);
  }
  const close = el('button', 'btn', 'Dismiss');
  close.type = 'button';
  close.addEventListener('click', () => dropVideoCard(ev.id, card));
  actions.append(close);
  card.append(body, actions);
  if (!card.isConnected) $('cards').append(card);
  videoCards.set(ev.id, card);
  syncDismissAll();
}

// What the user, Claude or their data says stays as it is; the window's own words are
// translated around it (i18n.js skips anything inside data-no-i18n).
function tr(text) { return window.jarvisI18n ? window.jarvisI18n.t(text) : text; }

// A time as the lists show it. Intl formatters are costly to make (toLocaleTimeString makes
// one per call): one per language and style, kept.
const TIME_STYLES = { hm: { hour: 'numeric', minute: '2-digit' }, hms24: { hour: 'numeric', minute: 'numeric', second: 'numeric', hour12: false } };
const timeFormats = new Map();
function clockText(at, style = 'hm') {
  const when = new Date(at);
  if (Number.isNaN(when.getTime())) return '';  // Intl throws where toLocaleTimeString said "Invalid Date"
  const locale = uiLocale();
  const key = `${locale || ''}|${style}`;
  if (!timeFormats.has(key)) timeFormats.set(key, new Intl.DateTimeFormat(locale, TIME_STYLES[style]));
  return timeFormats.get(key).format(when);
}

// Redraw a part of the window only when what it shows has changed. The hub resends whole
// lists on every step of every session; rebuilding each time replaced the buttons under
// the pointer (a click that straddled an update was lost), dropped the keyboard focus and
// reopened what the user had folded.
// more: a part of the signature already in JSON, kept apart so a long one isn't escaped
// again (JSON.stringify writes no line breaks, so the two never run together).
const drawnParts = new Map();
function changed(part, data, more) {
  const sig = more === undefined ? JSON.stringify(data) : `${JSON.stringify(data)}\n${more}`;
  if (drawnParts.get(part) === sig) return false;
  drawnParts.set(part, sig);
  return true;
}
function uiLocale() { return window.jarvisI18n && window.jarvisI18n.lang() === 'zh' ? 'zh-CN' : undefined; }

function mine(node) {
  node.setAttribute('data-no-i18n', '');
  return node;
}

function el(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
}

function showApproval(a) {
  if ($('cards').querySelector(`[data-approval="${CSS.escape(a.id)}"]`)) return;  // its card (a sheet in Jarvis Code is not one)
  const card = el('div', 'card needs-ok');
  card.dataset.approval = a.id;
  card.append(el('div', 'card-kicker', 'Needs your OK'), el('div', 'card-title', a.question));
  const custom = featureApproval(a, 'card', (choice, feedback) => answerApproval(a, choice, feedback));
  if (custom) { card.append(custom); $('cards').prepend(card); if (app) app.attention(); return; }
  if (a.detail) card.append(el('pre', '', a.detail));
  const actions = el('div', 'card-actions');
  a.choices.forEach((c, i) => {
    const b = el('button', i === 0 ? 'btn primary' : 'btn', c.label);
    b.type = 'button';
    b.addEventListener('click', () => answerApproval(a, c.id));
    actions.append(b);
  });
  card.append(actions);
  $('cards').prepend(card);
  if (app) app.attention();
}

// onDismiss: called only when the Dismiss button is pressed (not when the card times out).
// Notices never pile up: the same words already up aren't said again (that one stays up
// longer), and only the newest NOTICES_KEPT stay, the oldest going first.
const NOTICES_KEPT = 6;
function notice(kicker, title, text, ms, extra, onDismiss) {
  const words = JSON.stringify([kicker, title, text]);
  const same = !extra && !onDismiss && [...$('cards').querySelectorAll(':scope > .card.plain')].find((c) => c.noticeWords === words);
  if (same) {
    if (same.noticeTimer) { clearTimeout(same.noticeTimer); same.noticeTimer = ms ? setTimeout(() => { same.remove(); syncDismissAll(); }, ms) : 0; }
    return same;
  }
  const older = $('cards').querySelectorAll(':scope > .card.plain');
  for (let i = 0; i <= older.length - NOTICES_KEPT; i++) older[i].remove();
  const card = el('div', 'card plain');
  card.noticeWords = words;
  card.append(el('div', 'card-kicker', kicker));
  if (title) card.append(el('div', 'card-title', title));
  if (text) card.append(el('div', 'card-text', text.length > 400 ? `${text.slice(0, 400)}…` : text));
  const actions = el('div', 'card-actions');
  if (extra) actions.append(extra);
  const dismiss = el('button', 'btn', 'Dismiss');
  dismiss.type = 'button';
  dismiss.addEventListener('click', () => { card.remove(); syncDismissAll(); if (onDismiss) onDismiss(); });
  actions.append(dismiss);
  card.append(actions);
  $('cards').append(card);
  syncDismissAll();
  if (ms) card.noticeTimer = setTimeout(() => { card.remove(); syncDismissAll(); }, ms);
  return card;
}

// Two or more notices: one button clears them all (approvals stay).
function syncDismissAll() {
  const plain = $('cards').querySelectorAll('.card.plain').length;
  let all = $('cards-clear');
  if (plain < 2) { if (all) all.remove(); return; }
  if (!all) {
    all = el('button', 'btn cards-clear', 'Dismiss all');
    all.id = 'cards-clear';
    all.type = 'button';
    all.addEventListener('click', () => { $('cards').querySelectorAll('.card.plain').forEach((n) => n.remove()); syncDismissAll(); });
  }
  if ($('cards').firstElementChild !== all) $('cards').prepend(all);
}

const ALERT_KICKERS = { leave: 'Time to go', soon: 'Coming up', battery: 'Power', rain: 'Weather', mail: 'Email', message: 'Message', delegate: 'Conversation', files: 'For your meeting', task: 'Background work', learned: 'Learned', call: 'Phone call', voicemail: 'Voicemail' };

// A heads-up JARVIS raised on its own. Claude Code already has its own cards; everything
// else gets one, plus a macOS notification when the window isn't in front.
function onAlert(ev) {
  const kicker = ALERT_KICKERS[ev.alert_kind] || 'Heads-up';
  const key = String(ev.key || '');
  if (key.startsWith('interrupt:')) {
    // A text or email that interrupted: opening or dismissing its card teaches which
    // senders are worth it (a card that just times out teaches nothing).
    const open = el('button', 'btn primary', 'Open');
    open.type = 'button';
    const card = notice(kicker, ev.title, ev.text, 60000, open, () => send({ type: 'alert_reaction', key, kind: ev.alert_kind, action: 'dismissed' }));
    card.dataset.alert = key;
    open.addEventListener('click', () => { send({ type: 'alert_reaction', key, kind: ev.alert_kind, action: 'opened' }); card.remove(); syncDismissAll(); });
  } else if (!['task', 'meeting'].includes(ev.alert_kind)) {
    // Dismissed, or clicked into (read): how Jarvis learns which kinds are worth it.
    const card = notice(kicker, ev.title, ev.text, 60000, null, () => send({ type: 'alert_reaction', key, kind: ev.alert_kind, action: 'dismissed' }));
    card.dataset.alert = key;
    card.addEventListener('click', (e) => { if (!e.target.closest('button')) send({ type: 'alert_reaction', key, kind: ev.alert_kind, action: 'opened' }); }, { once: true });
  }
  if (document.hidden || !document.hasFocus()) {
    // A feature can raise it instead (the app's shell: clicking it opens JARVIS on this card).
    const taken = !window.dispatchEvent(new CustomEvent('jarvis-notify', { cancelable: true, detail: ev }));
    if (!taken) {
      try { new Notification(ev.title, { body: ev.text, silent: true }); } catch (_) { /* notifications off */ }
    }
  }
}

// ── meeting notes ──

let meetingStarted = null;
let meetingTimer = null;

function onMeeting(ev) {
  const pill = $('meeting-pill');
  clearInterval(meetingTimer);
  if (ev.active) {
    meetingStarted = new Date(ev.started);
    const tick = () => {
      const s = Math.max(0, Math.round((Date.now() - meetingStarted) / 1000));
      const clock = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
      $('meeting-text').textContent = `Taking notes · ${ev.title} · ${clock}`;
    };
    tick();
    meetingTimer = setInterval(tick, 1000);
    pill.hidden = false;
    pill.dataset.mode = 'live';
    $('meeting-stop').hidden = false;
    $('chip-meeting').hidden = true;
    return;
  }
  meetingStarted = null;
  $('chip-meeting').hidden = false;
  if (ev.writing) {
    pill.hidden = false;
    pill.dataset.mode = 'writing';
    $('meeting-text').textContent = `Writing up ${ev.title}…`;
    $('meeting-stop').hidden = true;
    return;
  }
  pill.hidden = true;
  if (ev.path) {
    const open = el('button', 'btn primary', 'Open notes');
    open.type = 'button';
    open.addEventListener('click', () => send({ type: 'open_report', path: ev.path }));
    const text = `${ev.minutes} min · ${ev.decisions} decision${ev.decisions === 1 ? '' : 's'} · ${ev.actions} action item${ev.actions === 1 ? '' : 's'}`;
    notice('Meeting notes', ev.title, text, 60000, open);
  }
}

$('meeting-stop').addEventListener('click', () => send({ type: 'meeting_stop' }));
$('chip-meeting').addEventListener('click', () => send({ type: 'meeting_start', title: 'Meeting' }));

function onTaskFinished(ev) {
  if (ev.id === ccSelected) send({ type: 'task_context', id: ev.id });
  // The session on screen shows its own end of turn: a card would only cover its Changes pane.
  if (ev.task_kind === 'code' && sessionOnScreen(ev.id) && !$('cc').hidden) return;
  const title = { done: ev.task_kind === 'research' ? 'Report ready' : 'Finished', stopped: 'Stopped', failed: 'Didn’t finish' }[ev.status] || ev.status;
  let extra = null;
  if (ev.report_path) {
    extra = el('button', 'btn primary', 'Open report');
    extra.type = 'button';
    extra.addEventListener('click', () => send({ type: 'open_report', path: ev.report_path }));
  }
  notice(ev.label || 'Background task', title, ev.result, ev.report_path ? 30000 : 15000, extra);
}

// ── activity drawer ──

const ACTIVITY_MAX = 200;  // the hub keeps 60, the drawer shows 40
let activityFrame = 0;

function onTool(ev) {
  const i = activity.findIndex((a) => a.id === ev.id);
  if (i >= 0) activity[i] = ev;
  else {
    activity.unshift(ev);
    if (activity.length > ACTIVITY_MAX) activity.length = ACTIVITY_MAX;
  }
  runningTools = activity.filter((a) => a.status === 'running').length;
  if (state === 'thinking') setState('thinking');
  if (!activityFrame) activityFrame = requestAnimationFrame(() => { activityFrame = 0; renderActivity(); });
}

function renderActivity() {
  const today = new Date().toDateString();
  const todays = activity.filter((a) => new Date(a.at).toDateString() === today);
  $('activity-label').textContent = todays.length
    ? `Activity · ${todays.length} action${todays.length === 1 ? '' : 's'} today`
    : 'Activity';
  $('activity-list').replaceChildren(...activity.slice(0, 40).map((a) => {
    const li = el('li', a.status);
    const t = el('time', '', clockText(a.at));
    t.dateTime = a.at;
    const st = a.status === 'running' ? 'working' : a.status === 'failed' ? 'failed' : a.ms ? `${(a.ms / 1000).toFixed(1)}s` : '';
    li.append(t, el('span', '', a.label), el('span', 'st', st));
    return li;
  }));
  $('activity-empty').hidden = activity.length > 0 || $('tasks-list').childElementCount > 0;
}

const TASKS_SHOWN = 20;  // besides everything still running

// One box per task, kept and updated in place (see changed()): the Stop under the pointer
// must survive the list the hub sends on every step.
function renderTasks(items) {
  const list = $('tasks-list');
  let rest = TASKS_SHOWN;
  const shown = items.filter((t) => t.status === 'running' || rest-- > 0);
  const old = new Map([...list.children].map((box) => [box.dataset.task, box]));
  shown.forEach((t, i) => {
    let box = old.get(String(t.id));
    old.delete(String(t.id));
    if (!box) {
      box = el('div');
      box.dataset.task = String(t.id);
      const top = el('div', 'task-top');
      top.append(el('span'), el('span'));
      box.append(top, el('div', 'task-prompt'), el('div', 'task-state'));
    }
    box.className = `task ${t.status}`;
    const [label, status] = box.firstElementChild.children;
    setText(label, t.label || `Jarvis Code · ${t.folder}`);
    setText(status, t.status);
    setText(box.children[1], t.prompt.length > 140 ? `${t.prompt.slice(0, 140)}…` : t.prompt);
    setText(box.children[2], t.last_action + (t.cost_usd ? ` · $${t.cost_usd.toFixed(2)}` : ''));
    taskButton(box, t);
    if (list.children[i] !== box) list.insertBefore(box, list.children[i] || null);
  });
  old.forEach((box) => box.remove());
  $('activity-empty').hidden = activity.length > 0 || list.childElementCount > 0;
}

function setText(node, text) { if (node.textContent !== text) node.textContent = text; }

function taskButton(box, t) {
  const kind = t.status === 'running' ? 'stop' : t.report_path ? 'report' : '';
  let b = box.querySelector(':scope > .btn');
  if (b && b.dataset.kind === kind && b.dataset.path === (t.report_path || '')) return;
  if (b) b.remove();
  if (!kind) return;
  b = el('button', 'btn', kind === 'stop' ? 'Stop' : 'Open report');
  b.type = 'button';
  b.dataset.kind = kind;
  b.dataset.path = t.report_path || '';
  const { id, report_path: path } = t;
  b.addEventListener('click', () => send(kind === 'stop' ? { type: 'task_cancel', id } : { type: 'open_report', path }));
  box.append(b);
}

function toggleDrawer(open) {
  $('activity').hidden = !open;
  $('activity-btn').setAttribute('aria-expanded', String(open));
}
$('activity-btn').addEventListener('click', () => toggleDrawer($('activity').hidden));
$('activity-close').addEventListener('click', () => toggleDrawer(false));

connect();
