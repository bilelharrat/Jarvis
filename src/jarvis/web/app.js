'use strict';

// Everything from the server is rendered with textContent: replies, note titles, email
// subjects and tool output are data and must never become markup.

const $ = (id) => document.getElementById(id);
const token = new URLSearchParams(location.search).get('token') || '';
const app = window.jarvisApp || null;
if (app) document.body.classList.add('in-app');

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

function connect() {
  ws = new WebSocket(`ws://${location.host}/ws?token=${encodeURIComponent(token)}`);
  ws.onopen = () => { retry = 0; $('offline').hidden = true; };
  ws.onmessage = (e) => onEvent(JSON.parse(e.data));
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
  if (!ws || ws.readyState !== WebSocket.OPEN) return false;
  const text = JSON.stringify(msg);
  // Length counts UTF-16 units; UTF-8 needs up to three bytes for one, so measure only then.
  if (text.length * 3 > MAX_FRAME && new Blob([text]).size > MAX_FRAME) return false;
  ws.send(text);
  return true;
}

function onEvent(ev) {
  if (onJarvisCodeEvent(ev)) return;
  switch (ev.type) {
    case 'hello':
      if (hubId !== null && ev.hub_id !== hubId) {
        // A different backend: its session 1 isn't ours. Nothing of the old one stays.
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
      renderLog();
      renderTasks(ev.tasks || []);
      renderCC(ev.tasks || []);
      renderPrefs(ev.prefs);
      renderBrain(ev.brain || {});
      // What the hub says is waiting replaces what the window had: one answered while the
      // window was away goes, one raised meanwhile gets its sheet and its number keys.
      $('cards').querySelectorAll('.needs-ok').forEach((n) => n.remove());
      pendingApprovals.clear();
      (ev.approvals || []).forEach((a) => { showApproval(a); pendingApprovals.set(a.id, a); });
      renderInlineApprovals();
      if (ccSelected) { send({ type: 'task_transcript', id: ccSelected }); send({ type: 'task_context', id: ccSelected }); }  // what it missed
      if (ev.turn && ev.turn.user) { currentRid = ev.turn.rid; showHeard(ev.turn.user); $('reply').textContent = ev.turn.reply || ''; }
      send({ type: 'galaxy' });
      if (!$('cc').hidden) { send({ type: 'claude_projects' }); if (deckProject) send({ type: 'claude_sessions', directory: deckProject }); }
      send({ type: 'connectors' });
      if (app) send({ type: 'capabilities', browser: !!app.browser, research: !!app.browser });
      history = ev.history || [];
      renderHistory();
      if (ev.vitals) renderVitals(ev.vitals);
      if (ev.defense) renderDefense(ev.defense);
      renderWeather(ev.weather);
      renderMarkets(ev.markets);
      $('v-accounts').textContent = (ev.accounts || []).length;
      $('v-model').textContent = ev.model_name || '–';
      renderMemory(ev.memory || []);
      if (ev.providers) onProviders(ev.providers);
      if (ev.goals) renderGoals(ev.goals);
      if (ev.delegations) renderDelegations(ev.delegations);
      if (ev.purchases) renderPurchases(ev.purchases);
      if (ev.file_index) renderFileIndex(ev.file_index);
      renderRoutines(ev.routines || []);
      if (ev.remote) renderRemote(ev.remote);
      onMeeting(ev.meeting || { active: false });
      onVoiceCode(ev.voicecode);
      break;
    case 'memory': renderMemory(ev.items || []); break;
    case 'goals': renderGoals(ev); break;
    case 'delegations': renderDelegations(ev.items || []); break;
    case 'purchases': renderPurchases(ev); break;
    case 'files_status': renderFileIndex(ev); break;
    case 'routines': renderRoutines(ev.items || []); break;
    case 'remote': renderRemote(ev); break;
    case 'devices': send({ type: 'remote' }); break;
    case 'remote_code': showRemoteCode(ev); break;
    case 'meeting': onMeeting(ev); break;
    case 'voicecode': onVoiceCode(ev.focus); break;
    case 'show_session': awaitingNewSession = false; toggleCC(true); selectTask(ev.id); break;
    case 'caption': $('reply').textContent = ev.text; break;
    case 'shortcuts': renderShortcuts(ev.names || [], ev.instant || []); break;
    case 'vitals': renderVitals(ev); break;
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
    case 'approval': showApproval(ev); pendingApprovals.set(ev.id, ev); renderInlineApprovals(); break;
    case 'approval_resolved': {
      document.querySelectorAll(`[data-approval="${CSS.escape(ev.id)}"]`).forEach((n) => n.remove());
      pendingApprovals.delete(ev.id);
      break;
    }
    case 'status': renderStatus(ev); break;
    case 'tasks': {
      const before = new Set(ccTasks.map((t) => t.id));
      renderTasks(ev.items);
      renderCC(ev.items);
      const fresh = ev.items.find((t) => t.kind === 'code' && !before.has(t.id));
      if (fresh && awaitingNewSession) { awaitingNewSession = false; selectTask(fresh.id); }
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
    case 'defense': renderDefense(ev); break;
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
    case 'claude_sessions': if (ev.directory === deckProject) { pastSessions = ev.items; renderPast(); } break;
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
  if (look === 'hud') line = { idle: 'Awaiting command…', listening: 'Listening…', transcribing: 'Processing…', thinking: 'Computing…', speaking: 'Responding…' }[next] || line;
  if (look === 'console') line = { idle: prefs && prefs.hands_free ? '● Listening for wake word…' : '● Ready', listening: '● Listening…', transcribing: '● Transcribing…', thinking: '● Thinking…', speaking: '● Speaking…' }[next] || line;
  $('core-text').innerHTML = '';
  $('core-text').append(...({ idle: ['Core', 'active'], listening: ['Voice', 'input'], transcribing: ['Parsing', 'input'], thinking: ['Core', 'computing'], speaking: ['Core', 'output'] }[next] || ['Core', 'active']).flatMap((w, i) => (i ? [el('br'), document.createTextNode(w)] : [document.createTextNode(w)])));
  if (next === 'thinking' && runningTools > 0) line = 'Working on it…';
  if (next === 'idle' && prefs && prefs.hands_free && (!look || look === 'orb')) line = 'Say “Jarvis”, or tap the orb';
  $('state-line').textContent = line;
  $('orb').setAttribute('aria-label', next === 'idle' ? 'Talk to Jarvis' : 'Stop');
}

function showHeard(text) {
  $('heard').textContent = text ? `“${text}”` : '';
}

function talkOrStop() {
  if (state === 'idle') send({ type: 'listen' });
  else send({ type: 'stop' });
}

function ask(text) {
  text = text.trim();
  return !text || send({ type: 'ask', text });
}

$('orb').addEventListener('click', talkOrStop);
document.querySelectorAll('.chip').forEach((chip) => chip.addEventListener('click', () => {
  if (chip.dataset.action === 'briefing') send({ type: 'briefing' });
  else if (chip.dataset.ask) ask(chip.dataset.ask);
}));
$('ask-form').addEventListener('submit', (e) => {
  e.preventDefault();
  if (!ask($('ask-input').value)) { notice('Jarvis', '', 'Not connected yet. Your question is still here: send it again in a moment.', 6000); return; }
  $('ask-input').value = '';
  $('ask-input').blur();
});

// Controls that answer Space themselves: buttons, links, disclosure rows (every tool row in
// Jarvis Code is a <summary>), and focusable widgets such as the Markets panel and the
// browser dock's handle. Space on them is theirs, never the microphone.
const OWN_SPACE = 'button, a[href], summary, select, [role="button"], [role="separator"], [role="switch"], [role="radio"], [role="checkbox"], [role="tab"], [role="menuitem"], [role="menuitemcheckbox"], [role="menuitemradio"], [role="option"], [role="slider"], [tabindex]:not([tabindex="-1"])';

function spaceTalks(e) {
  const t = e.target;
  return e.code === 'Space' && !e.repeat && !e.defaultPrevented && !e.isComposing && !e.metaKey && !e.ctrlKey
    && !(t instanceof Element && (t.closest(OWN_SPACE) || t.closest('input, textarea, [contenteditable]:not([contenteditable="false"])') || (t instanceof HTMLElement && t.isContentEditable)));
}

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
if (app && app.onWhatsThis) app.onWhatsThis(() => send({ type: 'whats_this' }));

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
const LOOK_ORDER = ['orb', 'hud', 'console'];
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
function onDesktopHands(ev) {
  if (ev.state === 'blocked' || ev.state === 'error') {
    handHud({ blocked: true, status: ev.text });
    notice('Hand control', 'Can’t steer the Mac', ev.text, 15000);
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

function tickClock() {
  const now = new Date();
  $('hud-clock').textContent = now.toLocaleTimeString(uiLocale(), { hour12: false });
  $('console-clock').textContent = `${now.toLocaleTimeString(uiLocale(), { hour: 'numeric', minute: '2-digit', second: '2-digit' })}  |  ${now.toLocaleDateString(uiLocale(), { month: 'long', day: 'numeric', year: 'numeric' })}`;
  $('clock').textContent = now.toLocaleString(uiLocale(), { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
  const h = now.getHours();
  $('greeting').textContent = h < 5 ? 'Good evening.' : h < 12 ? 'Good morning.' : h < 18 ? 'Good afternoon.' : 'Good evening.';
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
  $('t-voice').setAttribute('aria-pressed', String(!muted));
  $('h-voice').textContent = muted ? 'Muted' : 'Online';
}

// ── settings ──

function setSwitch(id, on) {
  $(id).setAttribute('aria-checked', String(!!on));
}

// The orb flanks itself with two columns: stats and weather on the left, markets and
// session on the right. The dashboards keep all four on the left.
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

function renderPrefs(p) {
  if (!p) return;
  prefs = p;
  document.body.dataset.look = p.look || 'orb';
  placePanels(document.body.dataset.look);
  document.querySelectorAll('#look-group button').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.look === p.look)));
  document.querySelectorAll('#lang-group button').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.lang === (p.language || 'en'))));
  if (window.jarvisI18n) window.jarvisI18n.setLang(p.language || 'en');
  if (document.activeElement !== $('weather-city')) $('weather-city').value = p.weather_city || '';
  $('t-handsfree').setAttribute('aria-pressed', String(!!p.hands_free));
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
  $('pay-limits').classList.toggle('off', p.pay_enabled === false);
  for (const [id, key] of [['pay-purchase', 'pay_limit_purchase'], ['pay-transfer', 'pay_limit_transfer'], ['pay-day', 'pay_limit_day']]) {
    if (document.activeElement !== $(id) && p[key] !== undefined) $(id).value = String(p[key]);
  }
  if (p.pay_currency) $('pay-currency').value = p.pay_currency;
  setSwitch('sw-file-index', p.file_index !== false);
  $('briefing-time').value = p.briefing_time;
  if (document.activeElement !== $('phone-from')) $('phone-from').value = p.phone_from || '';
  if (document.activeElement !== $('phone-me')) $('phone-me').value = p.phone_me || '';
  setSwitch('sw-wake-call', p.wake_call);
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
}

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
$('sw-pay').addEventListener('click', () => setPrefs({ pay_enabled: prefs.pay_enabled === false }));
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
$('phone-from').addEventListener('change', (e) => setPrefs({ phone_from: e.target.value }));
$('phone-me').addEventListener('change', (e) => setPrefs({ phone_me: e.target.value }));
$('sw-wake-call').addEventListener('click', () => setPrefs({ wake_call: !prefs.wake_call }));

// Settings › Brain › Fallback model: any added model (a Gemini key adds Gemini 2.5 Flash and
// Pro, and picks Flash when none is set).
function renderFallback() {
  if (!prefs) return;
  const added = ((typeof providerInfo !== 'undefined' && providerInfo && providerInfo.models) || []).filter((m) => !m.builtin);
  const sel = $('fallback-select');
  const none = el('option', '', tr('None'));
  none.value = '';
  sel.replaceChildren(none, ...added.map((m) => { const o = el('option', '', m.name || m.label || m.model); o.value = m.ref; return o; }));
  sel.value = added.some((m) => m.ref === prefs.fallback_model) ? prefs.fallback_model : '';
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
  if (ev.note !== undefined) $('phone-note').textContent = ev.note;
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
  $('accounts-btn').setAttribute('aria-expanded', String(open));
  if (open) { toggleSettings(false); send({ type: 'connectors' }); }
}
$('accounts-btn').addEventListener('click', () => toggleAccounts($('accounts').hidden));
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

// ── dashboards (Stark HUD, Command Center) ──

let history = [];

function bar(id, pct) { $(id).style.width = `${Math.max(0, Math.min(100, pct))}%`; }

// The HUD's Defense panel: the Mac's real shields and link.
function rate(bytes) {
  if (!(bytes >= 0)) return '–';
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(1)} MB/s`;
  if (bytes >= 1e3) return `${Math.round(bytes / 1e3)} KB/s`;
  return `${Math.round(bytes)} B/s`;
}

function renderDefense(d) {
  const shields = d.shields || [];
  const up = shields.filter((x) => x.on).length;
  $('df-score').textContent = shields.length ? `${up}/${shields.length} up` : '–';
  const link = d.link || {};
  $('df-kind').textContent = link.name ? `${link.kind} · ${link.name}` : (link.kind || 'Link');
  $('df-addr').textContent = link.address || '';
  $('df-ping').textContent = d.latency == null ? 'no route' : `${Math.round(d.latency)} ms`;
  $('df-ping').classList.toggle('bad', d.latency == null || d.latency > 150);
  $('df-shields').replaceChildren(...shields.map((x) => {
    const li = el('li', x.on ? 'on' : x.on === false ? 'off' : 'unknown');
    li.title = x.detail;
    li.append(el('b', '', x.name), el('span', '', x.on ? 'On' : x.on === false ? 'Off' : '?'));
    return li;
  }));
}

function renderVitals(v) {
  if (v.net) { $('df-down').textContent = rate(v.net.down); $('df-up').textContent = rate(v.net.up); }
  $('v-cpu').textContent = `${v.cpu}%`; bar('bar-cpu', v.cpu);
  $('v-mem').textContent = `${v.mem_used} / ${v.mem_total} GB`; bar('bar-mem', v.mem_pct);
  $('v-disk').textContent = `${v.disk_pct}%`; bar('bar-disk', v.disk_pct);
  if (v.battery) {
    $('v-batt').textContent = `${v.battery.percent}%${v.battery.plugged ? ' ⚡' : ''}`; bar('bar-batt', v.battery.percent);
    $('h-power').textContent = `${v.battery.percent}%`; bar('h-power-bar', v.battery.percent);
  }
  const h = Math.floor(v.uptime / 3600), m = Math.floor((v.uptime % 3600) / 60), sec = v.uptime % 60;
  $('v-uptime').textContent = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
  $('v-commands').textContent = v.commands;
  const busy = v.cpu > 85 || v.mem_pct > 92;
  $('sys-status').textContent = busy ? 'Under load' : 'Optimal';
}

function renderWeather(w) {
  const chip = $('weather-chip');
  if (!w || w.error) {
    chip.hidden = true;
    $('weather-body').replaceChildren(el('p', 'muted', w && w.error ? w.error : 'Set your city in Settings to see the weather.'));
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
}

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

function renderLog() {
  $('rt-log').replaceChildren(...activity.slice(0, 30).map((a) => {
    const li = el('li', a.status === 'failed' ? 'failed' : '');
    li.append(el('time', '', `[${clockText(a.at, 'hms24')}]`),
      document.createTextNode(`${a.label.toUpperCase()}${a.status === 'running' ? ' …' : a.status === 'failed' ? ' — FAILED' : ''}`));
    return li;
  }));
}

document.querySelectorAll('#look-group button').forEach((b) => b.addEventListener('click', () => setPrefs({ look: b.dataset.look })));
document.querySelectorAll('#lang-group button').forEach((b) => b.addEventListener('click', () => setPrefs({ language: b.dataset.lang })));
$('weather-city').addEventListener('change', (e) => setPrefs({ weather_city: e.target.value }));
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
$('chat-form').addEventListener('submit', (e) => { e.preventDefault(); ask($('chat-input').value); $('chat-input').value = ''; });
$('term-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const cmd = $('term-input').value.trim().replace(/^jarvis\s+(--ask\s+)?/i, '');
  if (!cmd) return;
  $('term-out').textContent = `Running: ${cmd}`;
  ask(cmd);
  $('term-input').value = '';
});
$('t-handsfree').addEventListener('click', () => setPrefs({ hands_free: !prefs.hands_free }));
$('t-voice').addEventListener('click', () => send({ type: 'mute', value: !muted }));
$('t-brain').addEventListener('click', () => setGalaxyMode('open'));
$('t-stop').addEventListener('click', () => send({ type: 'stop' }));
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
let newMode = 'ask';
let awaitingNewSession = false;
const pendingApprovals = new Map();
const MODE_NAMES = { plan: 'Plan', ask: 'Manual', edits: 'Accept edits', smart: 'Auto', auto: 'Bypass permissions' };

function toggleCC(open) {
  $('cc').hidden = !open;
  $('cc-btn').setAttribute('aria-expanded', String(open));
  if (open) {
    send({ type: 'claude_projects' });
    if (ccSelected) { send({ type: 'task_transcript', id: ccSelected }); send({ type: 'task_context', id: ccSelected }); }
    requestAnimationFrame(() => { moveGlider(); });
    if (currentPane) renderPaneBody();
    setTimeout(() => $('deck-input').focus(), 40);
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
  if (!$('cc').hidden && e.metaKey && e.key === '\\') { e.preventDefault(); setSide($('cc').classList.contains('side-hidden')); }
});
$('cc-close').addEventListener('click', () => toggleCC(false));

// ── sidebar: projects, each with its sessions ──

const openProjects = new Set();

function renderProjects(items) {
  deckProjects = items || [];
  if (!deckProject && deckProjects.length) { selectProject((deckProjects.find((p) => p.running) || deckProjects[0]).name); return; }
  const filter = $('deck-filter').value.trim().toLowerCase();
  const shown = [filter, deckProject, ccSelected, voiceFocus && voiceFocus.id, [...openProjects], deckProjects.map((p) => [p.name, p.branch]),
    ccTasks.map((t) => [t.id, t.folder, t.title || t.prompt, statusOf(t), statusText(t), t.mode])];
  if (!changed('projects', shown)) { moveGlider(); return; }
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
        row.setAttribute('aria-current', String(t.id === ccSelected));
        const title = t.title || t.prompt ? mine(el('span', 'jc-stitle', t.title || t.prompt)) : el('span', 'jc-stitle', 'New session');
        if (voiceFocus && voiceFocus.id === t.id) { const r = el('span', 'jc-mini-reactor'); r.title = 'Voice coding'; title.append(r); }
        row.append(el('span', `jc-dot ${statusOf(t)}`), title, el('small', '', `${statusText(t)} · ${MODE_NAMES[t.mode] || t.mode}`));
        row.addEventListener('click', () => selectTask(t.id));
        const item = el('li');
        item.append(row);
        sessions.append(item);
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
  if (deckProject !== name) pastSessions = [];
  deckProject = name;
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
    b.addEventListener('click', () => { awaitingNewSession = true; send({ type: 'task_new', directory: deckProject, session_id: p.session_id, title: p.title, prompt: '' }); });
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

function currentTask() { return ccTasks.find((x) => x.id === ccSelected) || null; }

function renderHeader(t) {
  const p = deckProjects.find((x) => x.name === (t ? t.folder : deckProject));
  $('jc-title').textContent = t ? (t.title || t.prompt || 'New session') : (deckProject || 'Jarvis Code');
  const sub = [];
  if (t || deckProject) sub.push(t ? t.folder : deckProject);
  if (p && p.branch) sub.push(`⎇ ${p.branch}`);
  if (t && t.session_id) sub.push(t.session_id.slice(0, 8));
  const base = (path) => path.split('/').filter(Boolean).pop();
  if (t && t.add_dirs && t.add_dirs.length) sub.push(`+ ${t.add_dirs.map(base).join(', ')}`);
  if (t && t.plugins && t.plugins.length) sub.push(`plugins: ${t.plugins.map(base).join(', ')}`);
  $('jc-sub').textContent = sub.join('  ·  ');
}

function renderCC(items) {
  ccTasks = (items || []).filter((t) => t.kind === 'code');
  const running = ccTasks.filter((t) => t.busy).length;
  const waiting = ccTasks.filter((t) => !t.busy && t.status === 'waiting').length;
  $('cc-label').textContent = running ? `Jarvis Code · ${running} working` : ccTasks.length ? `Jarvis Code · ${ccTasks.length}` : 'Jarvis Code';
  $('deck-summary').textContent = [running && `${running} working`, waiting && `${waiting} waiting for you`].filter(Boolean).join(' · ');
  renderProjects(deckProjects);
  const t = currentTask();
  renderHeader(t);
  $('cc-welcome').hidden = !!t && $('deck-timeline').children.length > 0;
  renderComposer();
  if (!t) {
    $('cc-mode').textContent = 'Pick a session, or start one. ? for shortcuts';
    $('cc-meta').textContent = '';
    $('cc-working').hidden = true;
    $('jc-todos').hidden = true;
    $('jc-bg').hidden = true;
    drawnParts.delete('todos');  // hidden here: drawn again when a session shows
    drawnParts.delete('background');
    setCtx(null);
    if (changed('queue', null)) renderQueue(null);
    return;
  }
  $('cc-mode').textContent = `${MODE_LINES[t.mode] || t.mode} · ⇧⇥ to switch${t.ultracode ? ' · ultracode on' : ''}`;
  $('cc-meta').textContent = [
    t.files_changed.length ? `${t.files_changed.length} file${t.files_changed.length === 1 ? '' : 's'}` : '',
    t.cost_usd ? `$${t.cost_usd.toFixed(2)}` : '',
    t.queued ? `${t.queued} queued` : '',
  ].filter(Boolean).join(' · ');
  setCtx(ccContext[t.id] ? ccContext[t.id].percent : null);
  if (t.busy && !workingSince) workingSince = Date.now();
  if (!t.busy) workingSince = 0;
  $('cc-working').hidden = !t.busy;
  $('cc-working-text').textContent = `${t.last_action && t.last_action !== 'Working' ? t.last_action : 'Working'}…`;
  if (changed('todos', [t.id, t.todos])) renderTodos(t.todos || []);
  if (changed('background', [t.id, t.background])) renderBackground(t.background || []);
  if (changed('queue', [t.id, t.queue, t.steerable])) renderQueue(t);
  if (currentPane === 'background' && changed('bgpane', [t.id, t.background])) renderPaneBody();
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

function selectTask(id) {
  ccSelected = id;
  const t = currentTask();
  if (t && t.folder !== deckProject) { openProjects.add(t.folder); selectProject(t.folder); }
  $('deck-timeline').replaceChildren();
  live.text = null;
  live.thinking = null;
  send({ type: 'task_transcript', id });
  send({ type: 'task_context', id });
  renderCC(ccTasks);
  if (currentPane) renderPaneBody();
  $('deck-input').focus();
}

function newSession(voice) {
  if (!deckProject) return;
  awaitingNewSession = true;
  if (voice) send({ type: 'voicecode_start', directory: deckProject });
  else send({ type: 'task_new', directory: deckProject, prompt: '', ...takePending() });
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
function richText(text) {
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
    const agent = [...tl.querySelectorAll('.jc-agent')].find((n) => n.dataset.toolId === e.parent);
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
  } else {
    li = el('li', 'jc-note');
    li.append(el('span', '', e.role === 'note' ? '⎿' : 'ⓘ'), el('span', '', e.text));
  }
  tl.insertBefore(li, tl.querySelector(':scope > .jc-ask'));
  $('cc-welcome').hidden = true;
  // Oldest out first; approval sheets and the live reply sit at the end and stay.
  const keep = TIMELINE_MAX + tl.querySelectorAll(':scope > .jc-ask').length + (live.text ? 1 : 0) + (live.thinking ? 1 : 0);
  while (tl.childElementCount > keep) tl.firstElementChild.remove();
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
  const li = [...$('deck-timeline').querySelectorAll('[data-tool-id]')].find((n) => n.dataset.toolId === ev.tool_id);
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

function answerApproval(a, choice, feedback) {
  send({ type: 'approve', id: a.id, choice, feedback: feedback || '' });
  document.querySelectorAll(`[data-approval="${CSS.escape(a.id)}"]`).forEach((n) => n.remove());
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
];
const projectFiles = {};
const customSlash = {};  // project -> its and the user's custom commands and skills
let pickIndex = 0;
let attachments = [];

function suggestions() {
  const input = $('deck-input');
  const v = input.value.slice(0, input.selectionStart);
  if (/^\/[\w.:-]*$/.test(v)) {
    const q = v.slice(1).toLowerCase();
    if (deckProject && !customSlash[deckProject]) { customSlash[deckProject] = []; send({ type: 'slash_list', directory: deckProject }); }
    const ours = new Set(SLASH_COMMANDS.map(([name]) => name));
    const custom = (customSlash[deckProject] || []).filter((c) => !ours.has(c.name.toLowerCase()));
    return {
      kind: 'slash',
      items: [
        ...SLASH_COMMANDS.filter(([name]) => name.startsWith(q)).map(([name, help]) => ({ label: `/${name}`, help, value: name })),
        ...custom.filter((c) => c.name.toLowerCase().startsWith(q)).map((c) => ({ label: `/${c.name}`, help: `${c.help || ''}${c.help ? ' · ' : ''}${c.scope}`, value: c.name, custom: true })),
      ].slice(0, 60),
    };
  }
  const m = v.match(/(?:^|\s)@([\w./-]*)$/);
  if (m) {
    const q = m[1].toLowerCase();
    const files = (projectFiles[deckProject] || []).filter((f) => f.toLowerCase().includes(q)).sort((x, y) => x.length - y.length).slice(0, 12);
    return { kind: 'at', query: m[1], items: files.map((f) => ({ label: f, help: '', value: f })) };
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
    if (s.kind === 'at') b.append(el('code', '', item.label));
    else b.append(el('strong', '', item.label), el('span', '', item.help));
    b.addEventListener('mousedown', (e) => { e.preventDefault(); pick(s, item); });
    return b;
  }));
}

function pick(s, item) {
  const input = $('deck-input');
  if (s.kind === 'slash') {
    const needsArg = item.custom || ['model', 'effort', 'rename'].includes(item.value);
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

function localSlash(text) {
  const [name, ...rest] = text.slice(1).split(' ');
  const arg = rest.join(' ').trim();
  const t = currentTask();
  switch (name) {
    case 'files': openPane('files'); return true;
    case 'terminal': openPane('terminal'); return true;
    case 'mcp': openPane('mcp'); return true;
    case 'permissions': openPane('rules'); return true;
    case 'diff': openPane('diff'); return false;  // also says it out loud / in the log
    case 'fork': if (t) { awaitingNewSession = true; send({ type: 'task_fork', id: t.id }); } return true;
    case 'rename': if (t && arg) send({ type: 'task_rename', id: t.id, title: arg }); return true;
    case 'export': if (t) send({ type: 'task_export', id: t.id }); return true;
    case 'effort':
      if (arg === 'ultracode') applyEffort(5);
      else if (arg && EFFORTS.includes(arg)) applyEffort(EFFORTS.indexOf(arg));
      else openEffort();
      return true;
    case 'ultracode': applyEffort(composerState().ultracode ? EFFORTS.indexOf('high') : 5); return true;
    case 'settings': case 'config': openJcSettings('general'); return true;
    case 'manual': case 'ask': case 'edits': case 'auto': case 'bypass': case 'plan': {
      const mode = { manual: 'ask', ask: 'ask', edits: 'edits', auto: 'smart', bypass: 'auto', plan: 'plan' }[name];
      if (name === 'plan' && arg) return false;  // "/plan the migration": plan mode, then that ask
      setMode(mode);
      return true;
    }
    case 'add-dir': addCodeFolder(); return true;
    case 'model': if (!arg) { modelMenu(); return true; } return false;
    case 'init': if (t) send({ type: 'task_send', id: t.id, plain: true, text: 'Look over this project and write (or update) a CLAUDE.md at its root that orients a new contributor: how to build, test and lint, the layout, and the conventions.' }); return true;
    case 'review': if (t) send({ type: 'task_send', id: t.id, plain: true, text: 'Review the uncommitted changes in this project for bugs, security problems and anything that breaks existing behavior. List findings by severity.' }); return true;
    default: return false;
  }
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
    const extra = { add_dirs: [...pending.dirs], plugins: [...pending.plugins] };
    if (!send({ type: 'task_new', directory: deckProject, prompt: text, images, ...extra })) return unsent();
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
  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && steerSubmit()) { e.preventDefault(); return; }
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); $('deck-composer').requestSubmit(); }
});
$('deck-input').addEventListener('input', () => {
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
function jcNote(text) { notice('Jarvis Code', '', text, 6000); }
function sizeText(n) { return n < 1024 ? `${n} B` : n < 1_048_576 ? `${Math.round(n / 1024)} KB` : `${(n / 1_048_576).toFixed(1)} MB`; }

// Files picked and still being read: they count against the limits like attached ones
// (attach.js), so a drop or paste of many files at once can't slip past them.
const reading = new Set();

function addFile(file) {
  if (!file) return;
  const kind = fileKind(file);
  if (!kind) { jcNote(`${file.name} can’t be attached: pictures, PDFs and text or code files only.`); return; }
  const held = [...attachments, ...reading].map((a) => ({ kind: a.kind, size: a.size || 0 }));
  const why = window.JarvisAttach.check(held, kind, file.size);
  if (why === 'files') { jcNote('Up to six attachments per message.'); return; }
  if (why === 'size' && kind === 'text') { jcNote(`${file.name} is over 400 KB. Put it in the project and mention it with @ instead.`); return; }
  if (why === 'size') { jcNote(`${file.name} is over 6 MB.`); return; }
  if (why === 'total') { jcNote(`${file.name} would make this message too big to send. Send it in a message of its own.`); return; }
  const slot = { kind, size: file.size };
  reading.add(slot);
  const reader = new FileReader();
  reader.onerror = () => { reading.delete(slot); jcNote(`${file.name} couldn’t be read.`); };
  reader.onload = () => {
    reading.delete(slot);
    const result = String(reader.result);
    if (kind === 'text') {
      if (result.includes('\u0000')) { jcNote(`${file.name} isn’t a text file.`); return; }
      attachments.push({ kind, type: 'text/plain', data: result, name: file.name, size: file.size });
    } else {
      attachments.push({ kind, type: kind === 'pdf' ? 'application/pdf' : file.type, data: result.split(',', 2)[1], url: kind === 'image' ? result : '', name: file.name, size: file.size });
    }
    renderAttachments();
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

// Number keys answer the approval on screen; ⇧⌘F opens the files.
document.addEventListener('keydown', (e) => {
  if ($('cc').hidden) return;
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
  if (a && n >= 1 && n <= a.choices.length && inDeck && !e.repeat && !writingReason) {
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
  if ($('jc-title').isContentEditable) return true;
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
  $('jc-mode-label').textContent = mode.label;
  $('jc-mode-btn').dataset.mode = mode.id;
  $('jc-bypass').setAttribute('aria-pressed', String(mode.id === 'auto'));
  $('jc-mode-btn').title = `${mode.label}: ${mode.note} (⌘⇧M or ⇧⇥ to switch)`;
  $('jc-model-label').textContent = s.label;
  $('jc-model').title = `Model: ${s.label} (⌘⇧I)`;
  const stop = effortStop(s);
  $('jc-effort-label').textContent = `${effortName(stop)}${s.pending ? ' · next step' : ''}`;
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
  text.append(el('span', 'mi-label', item.label));
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
  if (id === 'auto' && s.mode !== 'auto' && !confirm(tr('Bypass permissions lets Jarvis Code run any command and change any file without asking you. Use it only for a project you could lose. Switch?'))) return;
  if (s.t) send({ type: 'task_mode', id: s.t.id, mode: id });
  else { codeDefaults.mode = id; send({ type: 'code_defaults', code_mode: id }); renderComposer(); }
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
    label: x.name, note: off.has(x.name) ? 'Off for this session' : (x.status && x.status !== 'connected' ? x.status : ''),
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
  if (id === 'auto' && !confirm(tr('New sessions would run any command and change any file without asking. Start them in Bypass permissions?'))) { renderJcGeneral(); return; }
  codeDefaults.mode = id;
  send({ type: 'code_defaults', code_mode: id });
  renderComposer();
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
  providerInfo = { kinds: ev.kinds || [], providers: ev.providers || [], models: ev.models || [], limits: ev.limits || {}, advice: ev.advice || '' };
  renderFallback();
  $('jcs-advice').textContent = providerInfo.advice;
  $('jcs-advice').hidden = !providerInfo.advice;
  modelList = providerInfo.models;
  renderComposer();
  if (!$('jc-settings').hidden) { renderProviders(); renderJcGeneral(); }
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
  if (kind === 'mcp' && t) send({ type: 'task_mcp', id: t.id });
  if (kind === 'rules' && t) send({ type: 'task_rules', id: t.id });
  if (kind === 'audit' && t) send({ type: 'task_audit', id: t.id });
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
    if (!mcpServers.length) { body.replaceChildren(el('p', 'jc-empty', t && t.client !== null ? 'No MCP servers in this project.' : 'Open a session to see its MCP servers.')); return; }
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
      const b = el('button', '', f);
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
    case 'task_audit': if (ev.id === ccSelected) { auditItems = ev.items || []; if (currentPane === 'audit') renderPaneBody(); } return true;
    case 'task_mcp': if (ev.id === ccSelected) { mcpServers = ev.servers || []; if (currentPane === 'mcp') renderPaneBody(); refreshConnectorsMenu(); } return true;
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
const RC_DEFAULT = 'https://app.bshventures.com/research';
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
function researchBaseUrl() { return (prefs && prefs.research_url) || RC_DEFAULT; }

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
  const key = JSON.stringify(list.map((t) => [t.id, t.title, t.url, t.active, t.loading]));
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
    return tab;
  }));
  const plus = el('button', 'bd-tab-new', '+');
  plus.type = 'button';
  plus.setAttribute('aria-label', 'New tab');
  plus.title = 'New tab (⌘T)';
  plus.addEventListener('click', () => { app.browser.tab('new'); setTimeout(() => $('br-url').focus(), 120); });
  strip.append(plus);
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
    case 'history': openLibrary('history'); break;
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
function openLibrary(kind) {
  libKind = kind;
  $('bd-lib').hidden = false;
  $('br-library').setAttribute('aria-pressed', 'true');
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
  if (browserOpenNow && $('br-message').hidden) app.browser.show(slotBounds());
}
function renderLibrary() {
  $('bd-lib-bookmarks').setAttribute('aria-selected', String(libKind === 'bookmarks'));
  $('bd-lib-history').setAttribute('aria-selected', String(libKind === 'history'));
  $('bd-lib-clear').hidden = libKind !== 'history' || !libData.history.length;
  const q = $('bd-lib-search').value.trim().toLowerCase();
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
  $('br-library').addEventListener('click', () => ($('bd-lib').hidden ? openLibrary('bookmarks') : closeLibrary()));
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
  if (!browserOpenNow && ev.action !== 'read') toggleBrowser(true);
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
  app.browser.onState((st) => {
    browserState = st;
    renderTabs(st.tabs || []);
    if (document.activeElement !== $('br-url')) $('br-url').value = st.url || '';
    $('br-back').disabled = !st.canBack;
    $('br-forward').disabled = !st.canForward;
    $('bd-progress').hidden = !st.loading;
    $('br-lock').hidden = !st.research;
    $('br-lock').classList.toggle('open', !!st.research && !st.locked);
    $('br-lock-text').textContent = st.locked ? 'J.A.R.V.I.S. only' : 'Sign in yourself, then I take over';
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
const drawnParts = new Map();
function changed(part, data) {
  const sig = JSON.stringify(data);
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
  if (a.detail) card.append(el('pre', '', a.detail));
  const actions = el('div', 'card-actions');
  a.choices.forEach((c, i) => {
    const b = el('button', i === 0 ? 'btn primary' : 'btn', c.label);
    b.type = 'button';
    b.addEventListener('click', () => { send({ type: 'approve', id: a.id, choice: c.id }); card.remove(); });
    actions.append(b);
  });
  card.append(actions);
  $('cards').prepend(card);
  if (app) app.attention();
}

function notice(kicker, title, text, ms, extra) {
  const card = el('div', 'card plain');
  card.append(el('div', 'card-kicker', kicker));
  if (title) card.append(el('div', 'card-title', title));
  if (text) card.append(el('div', 'card-text', text.length > 400 ? `${text.slice(0, 400)}…` : text));
  const actions = el('div', 'card-actions');
  if (extra) actions.append(extra);
  const dismiss = el('button', 'btn', 'Dismiss');
  dismiss.type = 'button';
  dismiss.addEventListener('click', () => { card.remove(); syncDismissAll(); });
  actions.append(dismiss);
  card.append(actions);
  $('cards').append(card);
  syncDismissAll();
  if (ms) setTimeout(() => { card.remove(); syncDismissAll(); }, ms);
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

const ALERT_KICKERS = { leave: 'Time to go', soon: 'Coming up', battery: 'Power', rain: 'Weather', mail: 'Email', message: 'Message', delegate: 'Conversation', files: 'For your meeting', task: 'Background work' };

// A heads-up JARVIS raised on its own. Claude Code already has its own cards; everything
// else gets one, plus a macOS notification when the window isn't in front.
function onAlert(ev) {
  if (!['task', 'meeting'].includes(ev.alert_kind)) notice(ALERT_KICKERS[ev.alert_kind] || 'Heads-up', ev.title, ev.text, 60000);
  if (document.hidden || !document.hasFocus()) {
    try { new Notification(ev.title, { body: ev.text, silent: true }); } catch (_) { /* notifications off */ }
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
  if (ev.task_kind === 'code' && ev.id === ccSelected && !$('cc').hidden) return;
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

const ACTIVITY_MAX = 200;  // the hub keeps 60, the drawer shows 40, the HUD log 30
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
  if (!activityFrame) activityFrame = requestAnimationFrame(() => { activityFrame = 0; renderLog(); renderActivity(); });
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
