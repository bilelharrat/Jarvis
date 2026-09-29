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
  ws.onclose = () => {
    $('offline').hidden = false;
    setTimeout(connect, Math.min(5000, 500 * 2 ** retry++));
  };
}

function send(msg) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

function onEvent(ev) {
  switch (ev.type) {
    case 'hello':
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
      $('cards').querySelectorAll('.needs-ok').forEach((n) => n.remove());
      (ev.approvals || []).forEach(showApproval);
      if (ev.turn && ev.turn.user) { currentRid = ev.turn.rid; showHeard(ev.turn.user); $('reply').textContent = ev.turn.reply || ''; }
      send({ type: 'galaxy' });
      send({ type: 'connectors' });
      if (app && app.browser) send({ type: 'capabilities', browser: true });
      history = ev.history || [];
      renderHistory();
      if (ev.vitals) renderVitals(ev.vitals);
      renderWeather(ev.weather);
      $('v-accounts').textContent = (ev.accounts || []).length;
      $('v-model').textContent = ev.model_name || '–';
      renderMemory(ev.memory || []);
      renderRoutines(ev.routines || []);
      if (ev.remote) renderRemote(ev.remote);
      onMeeting(ev.meeting || { active: false });
      onVoiceCode(ev.voicecode);
      break;
    case 'memory': renderMemory(ev.items || []); break;
    case 'routines': renderRoutines(ev.items || []); break;
    case 'remote': renderRemote(ev); break;
    case 'devices': send({ type: 'remote' }); break;
    case 'remote_code': showRemoteCode(ev); break;
    case 'meeting': onMeeting(ev); break;
    case 'voicecode': onVoiceCode(ev.focus); break;
    case 'show_session': toggleCC(true); selectTask(ev.id); break;
    case 'caption': $('reply').textContent = ev.text; break;
    case 'shortcuts': renderShortcuts(ev.names || [], ev.instant || []); break;
    case 'vitals': renderVitals(ev); break;
    case 'weather': renderWeather(ev.weather); break;
    case 'history': history = ev.items || []; renderHistory(); break;
    case 'state': setState(ev.value); break;
    case 'level': document.documentElement.style.setProperty('--level', ev.value); break;
    case 'turn':
      currentRid = ev.rid;
      if (ev.user) { history.push({ role: 'user', text: ev.user, at: new Date().toISOString() }); history.push({ role: 'assistant', text: '', at: new Date().toISOString(), live: true }); renderHistory(); }
      showHeard(ev.user);
      $('reply').textContent = '';
      renderSources();
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
      if (last && last.live) { last.text = ev.text; renderHistory(); }
      break;
    }
    case 'sources': onSources(ev); break;
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
    case 'task_transcript': if (ev.id === ccSelected) { $('deck-timeline').replaceChildren(); ev.entries.forEach(appendEntry); renderInlineApprovals(); } break;
    case 'claude_projects': renderProjects(ev.items); break;
    case 'browser_cmd': runBrowserCommand(ev); break;
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
    case 'task_context': ccContext[ev.id] = ev.percent; renderCC(ccTasks); break;
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
  if (text) send({ type: 'ask', text });
}

$('orb').addEventListener('click', talkOrStop);
document.querySelectorAll('.chip').forEach((chip) => chip.addEventListener('click', () => {
  if (chip.dataset.action === 'briefing') send({ type: 'briefing' });
  else if (chip.dataset.ask) ask(chip.dataset.ask);
}));
$('ask-form').addEventListener('submit', (e) => {
  e.preventDefault();
  ask($('ask-input').value);
  $('ask-input').value = '';
  $('ask-input').blur();
});

document.addEventListener('keydown', (e) => {
  const typing = e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement;
  if (e.key === 'Escape') {
    if (typing) e.target.blur();
    if (!$('browser').hidden && !typing) toggleBrowser(false);
    else if (!$('cc').hidden) toggleCC(false);
    else if (!$('accounts').hidden) toggleAccounts(false);
    else if (!$('settings').hidden) toggleSettings(false);
    else if (galaxyMode === 'open') setGalaxyMode('off');
    else if (!$('activity').hidden) toggleDrawer(false);
    if (state !== 'idle') send({ type: 'stop' });
  } else if (e.code === 'Space' && !typing && !(e.target instanceof HTMLButtonElement) && galaxyMode !== 'open') {
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
  if (ev.rid === currentRid) renderSources();
  // The galaxy flies to the note Jarvis is drawing on.
  if (galaxyData && galaxyData.nodes.length) {
    if (galaxyMode === 'off') setGalaxyMode('ambient');
    galaxy.highlight(list.map((s) => s.id));
    galaxy.flyTo(ev.items[0].id, galaxyMode === 'open' ? 0.9 : 1.2);
  }
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
  galaxy: '☝ point · pinch a star to open it · pinch and move to spin · two-hand pinch to zoom · open palm to reset · fist to close',
  app: '☝ point · pinch to press · pinch and move to scroll · swipe an open hand to change the look · hold an open palm to talk · hold a fist to stop me',
};

function clickableAt(x, y) {
  handPoint = { x, y };
  const hit = document.elementFromPoint(x, y);
  const target = hit && hit.closest('button, a[href], [role="switch"], [role="radio"], input, select, summary');
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
    const i = LOOK_ORDER.indexOf(prefs.look || 'orb');
    setPrefs({ look: LOOK_ORDER[(i + dir + LOOK_ORDER.length) % LOOK_ORDER.length] });
  },
};

function handTarget() {
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
  ['hand-btn', 'hands-pill'].forEach((id) => $(id).setAttribute('aria-pressed', String(on)));
}

async function startHandControl() {
  handsOn = true;
  setHandButtons(true);
  $('hand-panel').hidden = false;
  $('hand-status').textContent = 'Loading hand tracking…';
  const { target, close, help } = handTarget();
  $('hand-help').textContent = help;
  try {
    handsModule = handsModule || (await import(`/static/hands.js?v=${Date.now()}`));
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
  }
}

function stopHandControl() {
  handsOn = false;
  if (handsModule) handsModule.stopHands();
  if (handHover) handHover.classList.remove('hand-hover');
  handHover = null;
  setHandButtons(false);
  $('hand-panel').hidden = true;
}

['hand-btn', 'hands-pill'].forEach((id) => $(id).addEventListener('click', () => {
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
  $('hud-clock').textContent = now.toLocaleTimeString(undefined, { hour12: false });
  $('console-clock').textContent = `${now.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit', second: '2-digit' })}  |  ${now.toLocaleDateString(undefined, { month: 'long', day: 'numeric', year: 'numeric' })}`;
  $('clock').textContent = now.toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
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
    const time = when.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
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

// The orb flanks itself with two columns: stats and weather on the left, camera and
// session on the right. The dashboards keep all four on the left.
function placePanels(look) {
  const left = document.querySelector('.side.left');
  const right = document.querySelector('.side.right');
  const moved = [$('p-camera'), $('p-uptime')];
  if (look === 'orb') right.prepend(...moved);
  else left.append(...moved);
}
placePanels(document.body.dataset.look);

function renderPrefs(p) {
  if (!p) return;
  prefs = p;
  document.body.dataset.look = p.look || 'orb';
  placePanels(document.body.dataset.look);
  document.querySelectorAll('#look-group button').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.look === p.look)));
  if (document.activeElement !== $('weather-city')) $('weather-city').value = p.weather_city || '';
  $('t-handsfree').setAttribute('aria-pressed', String(!!p.hands_free));
  const modelName = (p.models || []).find((m) => m.id === p.model);
  if (modelName) $('v-model').textContent = modelName.name;
  const persona = (p.personas || []).find((x) => x.id === p.persona);
  $('wordmark').textContent = persona ? persona.name.charAt(0) + persona.name.slice(1).toLowerCase() : 'Jarvis';
  const model = (p.models || []).find((m) => m.id === p.model);
  $('model-chip').textContent = model ? model.name : p.model;
  $('hf-indicator').hidden = !p.hands_free;
  $('hint').replaceChildren(...(p.hands_free
    ? [document.createTextNode('Say “Jarvis” · talk over me to interrupt')]
    : [document.createTextNode('Tap the orb, or press '), el('kbd', '', '⌥ Space'), document.createTextNode(' anywhere')]));
  setSwitch('sw-effect', p.voice_effect);
  $('mic-select').value = p.mic || 'builtin';
  setSwitch('sw-location', p.use_location !== false);
  setSwitch('sw-handsfree', p.hands_free);
  setSwitch('sw-briefing', p.briefing_enabled);
  setSwitch('sw-proactive', p.proactive);
  setSwitch('sw-control', p.control_always);
  setSwitch('sw-code-narrate', p.code_narrate);
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
  $('briefing-time').value = p.briefing_time;
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
}

function setPrefs(changes) {
  send({ type: 'set_prefs', changes });
}

function toggleSettings(open) {
  $('settings').hidden = !open;
  if (open) send({ type: 'shortcuts' });
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
$('sw-briefing').addEventListener('click', () => setPrefs({ briefing_enabled: !prefs.briefing_enabled }));
$('sw-proactive').addEventListener('click', () => setPrefs({ proactive: !prefs.proactive }));
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
$('briefing-time').addEventListener('change', (e) => setPrefs({ briefing_time: e.target.value }));
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
    const remove = el('button', 'btn', 'Disconnect');
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
      title.append(document.createTextNode(svc.name), el('span', 'badge', svc.connected ? 'Connected' : AUTH_BADGE[svc.auth]));
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

function renderVitals(v) {
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

function renderHistory() {
  const list = $('history');
  list.replaceChildren(...history.slice(-60).map((h) => {
    const li = el('li', h.role);
    li.append(document.createTextNode(h.text || '…'));
    const t = el('time', '', new Date(h.at).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }));
    li.append(t);
    return li;
  }));
  list.scrollTop = list.scrollHeight;
}

function renderLog() {
  $('rt-log').replaceChildren(...activity.slice(0, 30).map((a) => {
    const li = el('li', a.status === 'failed' ? 'failed' : '');
    li.append(el('time', '', `[${new Date(a.at).toLocaleTimeString(undefined, { hour12: false })}]`),
      document.createTextNode(`${a.label.toUpperCase()}${a.status === 'running' ? ' …' : a.status === 'failed' ? ' — FAILED' : ''}`));
    return li;
  }));
}

document.querySelectorAll('#look-group button').forEach((b) => b.addEventListener('click', () => setPrefs({ look: b.dataset.look })));
$('weather-city').addEventListener('change', (e) => setPrefs({ weather_city: e.target.value }));
$('clear-history').addEventListener('click', () => send({ type: 'clear_history' }));
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

let cameraStream = null;
async function toggleCamera() {
  const box = document.querySelector('.camera-box');
  if (cameraStream) {
    cameraStream.getTracks().forEach((t) => t.stop());
    cameraStream = null;
    $('camera').srcObject = null;
    box.classList.remove('on');
    $('camera-btn').textContent = 'Turn on';
    $('camera-btn').setAttribute('aria-pressed', 'false');
    return;
  }
  try {
    cameraStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
    $('camera').srcObject = cameraStream;
    box.classList.add('on');
    $('camera-btn').textContent = 'Turn off';
    $('camera-btn').setAttribute('aria-pressed', 'true');
  } catch (err) {
    $('camera-off').textContent = `Camera unavailable: ${err.message}`;
  }
}
$('camera-btn').addEventListener('click', toggleCamera);
$('c-camera').addEventListener('click', toggleCamera);

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
const MODE_NAMES = { plan: 'Plan mode', ask: 'Ask first', edits: 'Auto-edits', auto: 'Full auto' };

const TOOL_ICONS = {
  read: 'M2 8s2.5-4.5 6-4.5S14 8 14 8s-2.5 4.5-6 4.5S2 8 2 8z M8 6.2a1.8 1.8 0 100 3.6 1.8 1.8 0 000-3.6z',
  edit: 'M10.5 2.5l3 3L6 13H3v-3z',
  run: 'M2.5 3.5h11v9h-11z M4.5 7l2 1.5-2 1.5 M8 10.5h3',
  search: 'M7 3a4 4 0 110 8 4 4 0 010-8z M10 10l3.5 3.5',
  web: 'M8 1.8a6.2 6.2 0 110 12.4A6.2 6.2 0 018 1.8z M1.8 8h12.4 M8 1.8c1.8 2 2.6 4 2.6 6.2S9.8 12.2 8 14.2 M8 1.8C6.2 3.8 5.4 5.8 5.4 8s.8 4.2 2.6 6.2',
  other: 'M3 8h10 M8 3v10',
};
function toolKind(name) {
  if (['Read', 'NotebookRead'].includes(name)) return 'read';
  if (['Edit', 'MultiEdit', 'Write', 'NotebookEdit'].includes(name)) return 'edit';
  if (name === 'Bash') return 'run';
  if (['Grep', 'Glob', 'LS'].includes(name)) return 'search';
  if (['WebSearch', 'WebFetch'].includes(name)) return 'web';
  return 'other';
}
function icon(kind) {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('width', '15'); svg.setAttribute('height', '15'); svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('fill', 'none'); svg.setAttribute('stroke', 'currentColor'); svg.setAttribute('stroke-width', '1.4');
  const path = document.createElementNS(ns, 'path');
  path.setAttribute('d', TOOL_ICONS[kind] || TOOL_ICONS.other);
  svg.append(path);
  return svg;
}

function toggleCC(open) {
  $('cc').hidden = !open;
  $('cc-btn').setAttribute('aria-expanded', String(open));
  if (open) {
    send({ type: 'claude_projects' });
    if (ccSelected) { send({ type: 'task_transcript', id: ccSelected }); send({ type: 'task_context', id: ccSelected }); }
    setTimeout(() => $('deck-input').focus(), 30);
  }
}
$('cc-btn').addEventListener('click', () => toggleCC($('cc').hidden));
$('cc-close').addEventListener('click', () => toggleCC(false));

// ── sidebar: projects, each with its sessions ──

function renderProjects(items) {
  deckProjects = items;
  if (!deckProject && items.length) { selectProject((items.find((p) => p.running) || items[0]).name); return; }
  const filter = $('deck-filter').value.trim().toLowerCase();
  $('deck-project-list').replaceChildren(...items.filter((p) => !filter || p.name.toLowerCase().includes(filter)).map((p) => {
    const li = el('li', p.name === deckProject ? 'open' : '');
    const b = el('button', 'cc-project');
    b.type = 'button';
    b.setAttribute('aria-current', String(p.name === deckProject));
    b.append(el('span', 'cc-folder', p.name === deckProject ? '▾' : '▸'), el('span', 'cc-pname', p.name));
    if (p.branch) b.append(el('small', '', `⎇ ${p.branch}`));
    b.addEventListener('click', () => selectProject(p.name));
    li.append(b);
    if (p.name === deckProject) {
      const sessions = el('ul', 'cc-sessions');
      const mine = ccTasks.filter((t) => t.folder === p.name);
      for (const t of mine) {
        const row = el('button', 'cc-session');
        row.type = 'button';
        row.setAttribute('aria-current', String(t.id === ccSelected));
        const voiced = voiceFocus && voiceFocus.id === t.id ? ' 🎙' : '';
        row.append(el('span', `dot ${statusOf(t)}`), el('span', 'cc-stitle', (t.title || t.prompt || 'New session') + voiced), el('small', '', statusText(t)));
        row.addEventListener('click', () => selectTask(t.id));
        const item = el('li');
        item.append(row);
        sessions.append(item);
      }
      const add = el('button', 'cc-session add', '+ New session');
      add.type = 'button';
      add.addEventListener('click', () => newSession(false));
      const addLi = el('li');
      addLi.append(add);
      sessions.append(addLi);
      li.append(sessions);
    }
    return li;
  }));
}
$('deck-filter').addEventListener('input', () => renderProjects(deckProjects));

function selectProject(name) {
  deckProject = name;
  pastSessions = [];
  send({ type: 'claude_sessions', directory: name });
  document.querySelectorAll('.cc-project-name').forEach((n) => { n.textContent = name; });
  $('cc-cwd').textContent = `cwd: ~/…/${name}`;
  renderProjects(deckProjects);
  renderPast();
}

function renderPast() {
  $('cc-past-wrap').hidden = !pastSessions.length;
  $('cc-past').replaceChildren(...pastSessions.slice(0, 6).map((p) => {
    const li = el('li');
    const b = el('button', 'cc-past-item');
    b.type = 'button';
    b.append(el('span', '', p.title || 'Untitled session'), el('small', 'dim', new Date(p.last_modified).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })));
    b.addEventListener('click', () => { awaitingNewSession = true; send({ type: 'task_new', directory: deckProject, session_id: p.session_id, title: p.title, mode: 'ask', prompt: '' }); });
    li.append(b);
    return li;
  }));
}

function renderDeckList() { renderProjects(deckProjects); renderPast(); }
function renderGit() { /* folded into /diff */ }

function statusOf(t) { return t.busy ? 'busy' : t.status === 'failed' ? 'failed' : t.status === 'waiting' ? 'waiting' : 'idle'; }
function statusText(t) { return t.busy ? 'working' : { waiting: 'your turn', failed: 'failed', stopped: 'ended', closed: 'ended', running: 'starting' }[t.status] || t.status; }

// ── the session: status line, spinner ──

const MODE_LINES = {
  plan: '⏸ plan mode on',
  ask: '? ask before edits',
  edits: '⏵⏵ accept edits on',
  auto: '⏵⏵⏵ full auto on',
};
let ccContext = {};
let workingSince = 0;

function renderCC(items) {
  ccTasks = items.filter((t) => t.kind === 'code');
  const running = ccTasks.filter((t) => t.busy).length;
  const waiting = ccTasks.filter((t) => !t.busy && t.status === 'waiting').length;
  $('cc-label').textContent = running ? `Claude Code · ${running} working` : ccTasks.length ? `Claude Code · ${ccTasks.length}` : 'Claude Code';
  $('deck-summary').textContent = [running && `${running} working`, waiting && `${waiting} waiting for you`].filter(Boolean).join(' · ');
  renderProjects(deckProjects);
  const t = ccTasks.find((x) => x.id === ccSelected);
  $('cc-welcome').hidden = !!t && $('deck-timeline').children.length > 0;
  if (!t) { $('cc-mode').textContent = '? for shortcuts'; $('cc-meta').textContent = ''; $('cc-working').hidden = true; return; }
  $('cc-mode').textContent = `${MODE_LINES[t.mode] || t.mode} (⇧tab to cycle)`;
  const ctx = ccContext[t.id];
  $('cc-meta').textContent = [
    t.model ? t.model.replace('claude-', '').replace(/-(\d)-(\d)$/, ' $1.$2') : '',
    ctx ? `${ctx}% context` : '',
    t.files_changed.length ? `${t.files_changed.length} file${t.files_changed.length === 1 ? '' : 's'} changed` : '',
    t.cost_usd ? `$${t.cost_usd.toFixed(2)}` : '',
  ].filter(Boolean).join(' · ');
  if (t.busy && !workingSince) workingSince = Date.now();
  if (!t.busy) workingSince = 0;
  $('cc-working').hidden = !t.busy;
  $('cc-working-text').textContent = `${t.last_action && t.last_action !== 'Working' ? t.last_action : 'Working'}…`;
  $('ds-voice').setAttribute('aria-pressed', String(!!voiceFocus && voiceFocus.id === t.id));
}

setInterval(() => {
  if (!workingSince || $('cc').hidden) return;
  const secs = Math.round((Date.now() - workingSince) / 1000);
  $('cc-working-time').textContent = secs < 60 ? `${secs}s` : `${Math.floor(secs / 60)}m ${secs % 60}s`;
}, 1000);

function showPane() { /* one pane now: the transcript, with the welcome above it */ }

function selectTask(id) {
  ccSelected = id;
  const t = ccTasks.find((x) => x.id === id);
  if (t && t.folder !== deckProject) selectProject(t.folder);
  $('deck-timeline').replaceChildren();
  send({ type: 'task_transcript', id });
  send({ type: 'task_context', id });
  renderCC(ccTasks);
  $('deck-input').focus();
}

function newSession(voice) {
  if (!deckProject) return;
  awaitingNewSession = true;
  if (voice) send({ type: 'voicecode_start', directory: deckProject });
  else send({ type: 'task_new', directory: deckProject, prompt: '', mode: 'ask' });
}
$('cc-start-voice').addEventListener('click', () => newSession(true));
$('cc-start-typed').addEventListener('click', () => newSession(false));

// ── the transcript, Claude Code style ──

// Markdown-lite: code fences become <pre>, `code` and **bold** inline. Built with DOM nodes.
function richText(text) {
  const box = el('div', 'cc-md');
  text.split('```').forEach((part, i) => {
    if (i % 2) {
      box.append(el('pre', '', part.replace(/^[\w+-]*\n/, '')));
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
  const pre = el('pre', 'cc-diff');
  for (const line of text.split('\n')) {
    const cls = /^\+ ?/.test(line) && !line.startsWith('+++') ? 'diff-add' : /^- ?/.test(line) && !line.startsWith('---') ? 'diff-del' : '';
    pre.append(cls ? el('span', cls, `${line}\n`) : document.createTextNode(`${line}\n`));
  }
  return pre;
}

// Claude Code's own names for its tools, as its terminal shows them.
const TOOL_TITLES = { Edit: 'Update', MultiEdit: 'Update', Write: 'Write', Read: 'Read', Bash: 'Bash', Grep: 'Search', Glob: 'Search', WebFetch: 'Fetch', WebSearch: 'Web Search', TodoWrite: 'Update Todos', Task: 'Task', NotebookEdit: 'Update' };

function toolCall(e) {
  const detail = e.detail || '';
  let arg = '';
  if (e.tool === 'Bash') arg = detail.replace(/^\$ /, '').split('\n')[0];
  else if (['Edit', 'MultiEdit', 'Write', 'NotebookEdit'].includes(e.tool)) arg = detail.split('\n')[0].replace(' (new contents)', '');
  else arg = e.text.replace(/^(Reading|Searching for|Editing|Writing|Running)\s*/, '');
  return [TOOL_TITLES[e.tool] || e.tool, arg.slice(0, 120)];
}

function resultLine(e) {
  if (e.status === 'running') return '';
  if (e.status === 'failed') return `Error: ${(e.output || 'failed').split('\n')[0].slice(0, 200)}`;
  if (['Edit', 'MultiEdit', 'Write', 'NotebookEdit'].includes(e.tool)) {
    const lines = (e.detail || '').split('\n');
    const add = lines.filter((l) => l.startsWith('+ ')).length;
    const del = lines.filter((l) => l.startsWith('- ')).length;
    return e.tool === 'Write' ? `Wrote ${add} line${add === 1 ? '' : 's'}` : `Updated with ${add} addition${add === 1 ? '' : 's'} and ${del} removal${del === 1 ? '' : 's'}`;
  }
  const out = (e.output || '').trim();
  if (!out) return 'Done';
  const lines = out.split('\n');
  return lines.length > 3 ? `${lines.slice(0, 3).join('\n')}\n… +${lines.length - 3} lines` : out;
}

function appendEntry(e) {
  const tl = $('deck-timeline');
  const box = $('cc-scroll');
  const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 120;
  let li;
  if (e.role === 'user') {
    li = el('li', 'cc-user');
    li.append(el('span', 'cc-gutter', '>'), el('span', '', e.text));
  } else if (e.role === 'assistant') {
    li = el('li', 'cc-say');
    li.append(el('span', 'cc-dot', '⏺'), richText(e.text));
  } else if (e.role === 'tool' && e.tool) {
    li = el('li', `cc-tool ${e.status || ''}`);
    li.dataset.toolId = e.tool_id || '';
    const [name, arg] = toolCall(e);
    const head = el('div', 'cc-call');
    head.append(el('span', 'cc-dot', '⏺'), el('strong', '', name), el('span', 'cc-arg', arg ? `(${arg})` : ''));
    const res = el('div', 'cc-result');
    res.append(el('span', 'cc-elbow', '⎿'), el('span', 'cc-result-text', resultLine(e)));
    li.append(head, res);
    if (['Edit', 'MultiEdit', 'Write'].includes(e.tool) && e.detail) li.append(diffBlock(e.detail.split('\n').slice(1).join('\n')));
    res.hidden = e.status === 'running';
  } else if (e.role === 'plan') {
    li = el('li', 'cc-plan');
    li.append(el('p', 'cc-plan-head', 'Here is Claude’s plan:'), richText(e.text));
  } else if (e.role === 'note') {
    li = el('li', 'cc-note');
    li.append(el('span', 'cc-elbow', '⎿'), el('span', '', e.text));
  } else {
    li = el('li', 'cc-sys', e.text);
  }
  tl.insertBefore(li, tl.querySelector('.cc-ask'));
  $('cc-welcome').hidden = true;
  if (nearBottom) box.scrollTop = box.scrollHeight;
}

function updateEntry(ev) {
  const li = [...$('deck-timeline').children].find((n) => n.dataset.toolId === ev.tool_id);
  if (!li) return;
  li.className = `cc-tool ${ev.status}`;
  const res = li.querySelector('.cc-result');
  const tool = li.querySelector('.cc-call strong').textContent;
  const entry = { status: ev.status, output: ev.output, tool: Object.keys(TOOL_TITLES).find((k) => TOOL_TITLES[k] === tool) || tool, detail: '' };
  if (!['Update', 'Write'].includes(tool) || ev.status === 'failed') li.querySelector('.cc-result-text').textContent = resultLine(entry);
  res.hidden = false;
}

// An approval as Claude Code asks it: a bordered box with numbered choices.
function renderInlineApprovals() {
  document.querySelectorAll('#deck-timeline .cc-ask').forEach((n) => n.remove());
  for (const a of pendingApprovals.values()) {
    if (a.task_id !== ccSelected) continue;
    const li = el('li', 'cc-ask');
    li.dataset.approval = a.id;
    const kind = a.ask_kind === 'plan' ? 'Ready to code?' : a.ask_kind === 'question' ? a.question : a.tool === 'Bash' ? 'Bash command' : ['Edit', 'MultiEdit', 'Write'].includes(a.tool) ? (a.tool === 'Write' ? 'Create file' : 'Edit file') : a.question;
    li.append(el('p', 'cc-ask-head', kind));
    if (a.detail) li.append(a.ask_kind === 'plan' ? richText(a.detail) : diffBlock(a.detail));
    if (a.ask_kind !== 'question') li.append(el('p', '', a.ask_kind === 'plan' ? 'Would you like to proceed?' : 'Do you want to proceed?'));
    const list = el('ol', 'cc-choices');
    a.choices.forEach((c, i) => {
      const item = el('li');
      const b = el('button', i === 0 ? 'cc-choice active' : 'cc-choice');
      b.type = 'button';
      b.append(el('span', 'cc-pointer', i === 0 ? '❯' : ' '), document.createTextNode(`${i + 1}. ${c.label}`));
      b.addEventListener('click', () => answerApproval(a, c.id));
      item.append(b);
      list.append(item);
    });
    li.append(list, el('p', 'dim cc-ask-hint', 'Press a number, or say “yes”, “no” or “option 2”.'));
    $('deck-timeline').append(li);
    $('cc-welcome').hidden = true;
    $('cc-scroll').scrollTop = $('cc-scroll').scrollHeight;
  }
}

function answerApproval(a, choice) {
  send({ type: 'approve', id: a.id, choice });
  document.querySelectorAll(`[data-approval="${CSS.escape(a.id)}"]`).forEach((n) => n.remove());
}

// ── the prompt: messages, slash commands, shortcuts ──

const SLASH_COMMANDS = [
  ['plan', 'Plan mode: plan first, you approve'],
  ['ask', 'Ask before each edit and command'],
  ['edits', 'Accept edits automatically'],
  ['auto', 'Full auto: run anything'],
  ['undo', 'Undo the last round of file changes'],
  ['diff', 'What changed, summarised'],
  ['commit', 'Commit the changes'],
  ['pr', 'Push and open a pull request'],
  ['test', 'Run the tests'],
  ['compact', 'Compact the conversation'],
  ['context', 'Context window used'],
  ['cost', 'What this session has cost'],
  ['model', 'Switch model: /model sonnet'],
  ['new', 'New session in this project'],
  ['voice', 'Voice coding on or off for this session'],
  ['stop', 'Interrupt the current step'],
];
let slashIndex = 0;

function slashMatches() {
  const v = $('deck-input').value;
  if (!v.startsWith('/') || v.includes(' ')) return [];
  const q = v.slice(1).toLowerCase();
  return SLASH_COMMANDS.filter(([name]) => name.startsWith(q));
}

function renderSlash() {
  const items = slashMatches();
  $('cc-slash').hidden = !items.length;
  slashIndex = Math.min(slashIndex, Math.max(0, items.length - 1));
  $('cc-slash').replaceChildren(...items.map(([name, help], i) => {
    const b = el('button', i === slashIndex ? 'active' : '');
    b.type = 'button';
    b.setAttribute('role', 'option');
    b.append(el('strong', '', `/${name}`), el('span', 'dim', help));
    b.addEventListener('mousedown', (e) => { e.preventDefault(); pickSlash(name); });
    return b;
  }));
}

function pickSlash(name) {
  $('deck-input').value = name === 'model' ? '/model ' : `/${name}`;
  $('cc-slash').hidden = true;
  if (name !== 'model') $('deck-composer').requestSubmit();
  else $('deck-input').focus();
}

function sendToSession(text) {
  text = text.trim();
  if (!text) return;
  if (!ccSelected) {  // nothing open yet: the message starts a session here
    if (!deckProject) return;
    awaitingNewSession = true;
    send({ type: 'task_new', directory: deckProject, prompt: text, mode: 'ask' });
    return;
  }
  if (text.startsWith('/')) {
    if (text === '/new' || text === '/clear') awaitingNewSession = true;
    send({ type: 'code_command', id: ccSelected, text });
    return;
  }
  send({ type: 'task_send', id: ccSelected, text });
}

$('deck-composer').addEventListener('submit', (e) => {
  e.preventDefault();
  sendToSession($('deck-input').value);
  $('deck-input').value = '';
  $('deck-input').style.height = '';
  $('cc-slash').hidden = true;
});

const MODE_CYCLE = ['ask', 'edits', 'plan'];
$('deck-input').addEventListener('keydown', (e) => {
  const items = slashMatches();
  if (items.length && !$('cc-slash').hidden) {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); slashIndex = (slashIndex + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length; renderSlash(); return; }
    if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) { e.preventDefault(); pickSlash(items[slashIndex][0]); return; }
  }
  if (e.key === 'Tab' && e.shiftKey) {  // like Claude Code: shift+tab cycles the mode
    e.preventDefault();
    const t = ccTasks.find((x) => x.id === ccSelected);
    if (t) send({ type: 'task_mode', id: t.id, mode: MODE_CYCLE[(MODE_CYCLE.indexOf(t.mode) + 1) % MODE_CYCLE.length] });
    return;
  }
  if (e.key === 'Escape') {
    const t = ccTasks.find((x) => x.id === ccSelected);
    if (t && t.busy) { e.preventDefault(); send({ type: 'task_interrupt', id: t.id }); }
    return;
  }
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); $('deck-composer').requestSubmit(); }
});
$('deck-input').addEventListener('input', () => {
  slashIndex = 0;
  renderSlash();
  $('deck-input').style.height = 'auto';
  $('deck-input').style.height = `${Math.min(180, $('deck-input').scrollHeight)}px`;
});

// Number keys answer the approval on screen, as in Claude Code.
document.addEventListener('keydown', (e) => {
  if ($('cc').hidden || e.metaKey || e.ctrlKey || e.altKey) return;
  if (document.activeElement === $('deck-input') && $('deck-input').value) return;
  const a = [...pendingApprovals.values()].find((x) => x.task_id === ccSelected);
  const n = Number(e.key);
  if (a && n >= 1 && n <= a.choices.length) { e.preventDefault(); answerApproval(a, a.choices[n - 1].id); }
});

$('ds-voice').addEventListener('click', () => {
  if (!ccSelected) { newSession(true); return; }
  if (voiceFocus && voiceFocus.id === ccSelected) send({ type: 'voicecode_exit' });
  else send({ type: 'voicecode_enter', id: ccSelected });
});
$('cc-voice-head').addEventListener('click', () => {
  if (voiceFocus) send({ type: 'voicecode_exit' });
  else if (ccSelected) send({ type: 'voicecode_enter', id: ccSelected });
  else newSession(true);
});
$('code-exit').addEventListener('click', () => send({ type: 'voicecode_exit' }));

// ── voice coding: which session your voice goes to ──
let voiceFocus = null;
const MODE_LABELS = { plan: 'Plan mode', ask: 'Ask first', edits: 'Auto-edits', auto: 'Full auto' };

function onVoiceCode(focus) {
  voiceFocus = focus || null;
  $('code-pill').hidden = !voiceFocus;
  if (voiceFocus) $('code-text').textContent = `Voice coding · ${voiceFocus.folder} · ${MODE_LABELS[voiceFocus.mode] || voiceFocus.mode}`;
  $('cc-voice-head').setAttribute('aria-pressed', String(!!voiceFocus));
  $('cc-voice-label').textContent = voiceFocus ? `Voice coding · ${voiceFocus.folder}` : 'Voice coding off';
  $('ds-voice').setAttribute('aria-pressed', String(!!voiceFocus && voiceFocus.id === ccSelected));
  $('deck-input').placeholder = voiceFocus && voiceFocus.id === ccSelected ? 'Listening: just talk (say “exit code mode” to stop), or type' : 'Try “plan a retry for the query”, or just talk';
  renderProjects(deckProjects);
}

// ── built-in browser (in the J.A.R.V.I.S. app only) ──

function slotBounds() {
  const r = $('browser-slot').getBoundingClientRect();
  return { x: r.left, y: r.top, width: r.width, height: r.height };
}

function toggleBrowser(open) {
  if (!app || !app.browser) return;
  $('browser').hidden = !open;
  $('browser-btn').setAttribute('aria-expanded', String(open));
  if (open) requestAnimationFrame(() => app.browser.show(slotBounds()));
  else app.browser.hide();
}

if (app && app.browser) {
  $('browser-btn').hidden = false;
  $('browser-btn').addEventListener('click', () => toggleBrowser($('browser').hidden));
  $('br-close').addEventListener('click', () => toggleBrowser(false));
  $('br-back').addEventListener('click', () => app.browser.nav('back'));
  $('br-forward').addEventListener('click', () => app.browser.nav('forward'));
  $('br-reload').addEventListener('click', () => app.browser.nav('reload'));
  $('browser-bar').addEventListener('submit', (e) => {
    e.preventDefault();
    app.browser.nav('go', $('br-url').value);
    $('br-url').blur();
  });
  app.browser.onState((st) => {
    if (document.activeElement !== $('br-url')) $('br-url').value = st.url || '';
    $('br-back').disabled = !st.canBack;
    $('br-forward').disabled = !st.canForward;
  });
  app.browser.onOpen(() => { if ($('browser').hidden) toggleBrowser(true); });
  new ResizeObserver(() => { if (!$('browser').hidden) app.browser.setBounds(slotBounds()); }).observe($('browser-slot'));
  window.addEventListener('resize', () => { if (!$('browser').hidden) app.browser.setBounds(slotBounds()); });
  // Approval cards must stay visible: the browser makes room for them.
  new MutationObserver(() => {
    document.body.classList.toggle('cards-open', $('cards').childElementCount > 0);
  }).observe($('cards'), { childList: true });
}

async function runBrowserCommand(ev) {
  if (!app || !app.browser) return;
  $('br-jarvis').hidden = false;
  if ($('browser').hidden && ev.action !== 'read') toggleBrowser(true);
  let result;
  try {
    result = await app.browser.command({ action: ev.action, args: ev.args || {} });
  } catch (err) {
    result = { error: String(err) };
  }
  $('br-jarvis').hidden = true;
  send({ type: 'browser_result', id: ev.id, result });
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
    const seen = d.last_seen ? `last used ${new Date(d.last_seen).toLocaleString()}` : 'not used yet';
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
    text.append(el('strong', '', r.name), el('small', '', `${r.when}${r.enabled ? '' : ' · paused'}`));
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
    const text = el('span', 'fact', f.text);
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

function el(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
}

function showApproval(a) {
  if (document.querySelector(`[data-approval="${CSS.escape(a.id)}"]`)) return;
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
  const card = el('div', 'card');
  card.append(el('div', 'card-kicker', kicker));
  if (title) card.append(el('div', 'card-title', title));
  if (text) card.append(el('div', 'card-text', text.length > 400 ? `${text.slice(0, 400)}…` : text));
  const actions = el('div', 'card-actions');
  if (extra) actions.append(extra);
  const dismiss = el('button', 'btn', 'Dismiss');
  dismiss.type = 'button';
  dismiss.addEventListener('click', () => card.remove());
  actions.append(dismiss);
  card.append(actions);
  $('cards').append(card);
  if (ms) setTimeout(() => card.remove(), ms);
}

const ALERT_KICKERS = { leave: 'Time to go', soon: 'Coming up', battery: 'Power', rain: 'Weather', mail: 'Email', task: 'Background work' };

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

function onTool(ev) {
  const i = activity.findIndex((a) => a.id === ev.id);
  if (i >= 0) activity[i] = ev; else activity.unshift(ev);
  runningTools = activity.filter((a) => a.status === 'running').length;
  renderLog();
  if (state === 'thinking') setState('thinking');
  renderActivity();
}

function renderActivity() {
  const today = new Date().toDateString();
  const todays = activity.filter((a) => new Date(a.at).toDateString() === today);
  $('activity-label').textContent = todays.length
    ? `Activity · ${todays.length} action${todays.length === 1 ? '' : 's'} today`
    : 'Activity';
  $('activity-list').replaceChildren(...activity.slice(0, 40).map((a) => {
    const li = el('li', a.status);
    const t = el('time', '', new Date(a.at).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }));
    t.dateTime = a.at;
    const st = a.status === 'running' ? 'working' : a.status === 'failed' ? 'failed' : a.ms ? `${(a.ms / 1000).toFixed(1)}s` : '';
    li.append(t, el('span', '', a.label), el('span', 'st', st));
    return li;
  }));
  $('activity-empty').hidden = activity.length > 0 || $('tasks-list').childElementCount > 0;
}

function renderTasks(items) {
  $('tasks-list').replaceChildren(...items.map((t) => {
    const box = el('div', `task ${t.status}`);
    const top = el('div', 'task-top');
    top.append(el('span', '', t.label || `Claude Code · ${t.folder}`), el('span', '', t.status));
    box.append(top, el('div', 'task-prompt', t.prompt.length > 140 ? `${t.prompt.slice(0, 140)}…` : t.prompt));
    box.append(el('div', 'task-state', t.last_action + (t.cost_usd ? ` · $${t.cost_usd.toFixed(2)}` : '')));
    if (t.status === 'running') {
      const stop = el('button', 'btn', 'Stop');
      stop.type = 'button';
      stop.addEventListener('click', () => send({ type: 'task_cancel', id: t.id }));
      box.append(stop);
    } else if (t.report_path) {
      const open = el('button', 'btn', 'Open report');
      open.type = 'button';
      open.addEventListener('click', () => send({ type: 'open_report', path: t.report_path }));
      box.append(open);
    }
    return box;
  }));
  renderActivity();
}

function toggleDrawer(open) {
  $('activity').hidden = !open;
  $('activity-btn').setAttribute('aria-expanded', String(open));
}
$('activity-btn').addEventListener('click', () => toggleDrawer($('activity').hidden));
$('activity-close').addEventListener('click', () => toggleDrawer(false));

connect();
