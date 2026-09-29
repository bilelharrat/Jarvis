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
  if (onJarvisCodeEvent(ev)) return;
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
      if (!$('cc').hidden) { send({ type: 'claude_projects' }); if (deckProject) send({ type: 'claude_sessions', directory: deckProject }); }
      send({ type: 'connectors' });
      if (app) send({ type: 'capabilities', browser: !!app.browser, research: !!app.research });
      history = ev.history || [];
      renderHistory();
      if (ev.vitals) renderVitals(ev.vitals);
      renderWeather(ev.weather);
      renderMarkets(ev.markets);
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
    case 'research_cmd': runResearchCmd(ev); break;
    case 'ui': applyUi(ev); break;
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
    if (rcOpen && !typing) closeResearch();
    else if (!$('browser').hidden && !typing) toggleBrowser(false);
    else if (!$('cc').hidden) { if (!jcEscape(e)) toggleCC(false); }
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
  research: '✋ aim · pinch to open · pinch and move to scroll · swipe right for back · two-hand pinch to zoom · hold a fist to close',
  galaxy: '☝ point · pinch a star to open it · pinch and move to spin · two-hand pinch to zoom · open palm to reset · fist to close',
  app: '☝ point · pinch to press · pinch and move to scroll · wave to dismiss a notice (or change the look) · hold an open palm to talk · hold a fist to stop me',
};

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
      return;
    }
    const i = LOOK_ORDER.indexOf(prefs.look || 'orb');
    setPrefs({ look: LOOK_ORDER[(i + dir + LOOK_ORDER.length) % LOOK_ORDER.length] });
  },
};

function handTarget() {
  if (rcOpen) return { target: researchTarget, close: closeResearch, help: HAND_HELP.research };
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
  ['hand-btn', 'hands-pill', 'rc-hands'].forEach((id) => $(id).setAttribute('aria-pressed', String(on)));
  placeHandPanel();
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

['hand-btn', 'hands-pill', 'rc-hands'].forEach((id) => $(id).addEventListener('click', () => {
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
  setSwitch('sw-briefing', p.briefing_enabled);
  setSwitch('sw-proactive', p.proactive);
  setSwitch('sw-control', p.control_always);
  setSwitch('sw-code-narrate', p.code_narrate);
  if (document.activeElement !== $('watchlist')) $('watchlist').value = (p.watchlist || []).join(' ');
  if (document.activeElement !== $('research-url')) $('research-url').value = p.research_url || '';
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
$('export-history').addEventListener('click', () => send({ type: 'export_history' }));

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
    case 'research': if (open) openResearch(rcOpen ? rcPath : '/markets'); else closeResearch(); break;
    case 'settings': toggleSettings(open); break;
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
  return q.last >= 1000 ? q.last.toLocaleString(undefined, { maximumFractionDigits: 0 }) : q.last.toFixed(2);
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
  $('mk-status').title = m.headline || '';
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
    requestAnimationFrame(() => { setThumb(); moveGlider(); });
    if (currentPane) renderPaneBody();
    setTimeout(() => $('deck-input').focus(), 40);
  } else {
    closeMenu();
    if (currentPane === 'sim') { send({ type: 'sim_watch', udid: '' }); simWatching = ''; }
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
  setTimeout(() => { setThumb(); moveGlider(); }, 380);
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
  $('deck-project-list').replaceChildren(...deckProjects.filter((p) => !filter || p.name.toLowerCase().includes(filter)).map((p) => {
    const li = el('li');
    const open = openProjects.has(p.name) || p.name === deckProject;
    const b = el('button', 'jc-project');
    b.type = 'button';
    b.setAttribute('aria-expanded', String(open));
    b.append(el('span', 'jc-chev', '▶'), el('span', 'jc-pname', p.name));
    if (p.branch) b.append(el('span', 'jc-branch', p.branch));
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
        row.setAttribute('aria-current', String(t.id === ccSelected));
        const title = el('span', 'jc-stitle', t.title || t.prompt || 'New session');
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

// The selection pill glides to the selected session.
function moveGlider() {
  const glider = $('jc-glider');
  const row = document.querySelector(`#deck-project-list .jc-session[aria-current="true"]`);
  if (!row || $('cc').hidden) { glider.style.opacity = '0'; return; }
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
    b.append(el('span', '', p.title || 'Untitled session'), el('small', '', new Date(p.last_modified).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })));
    b.addEventListener('click', () => { awaitingNewSession = true; send({ type: 'task_new', directory: deckProject, session_id: p.session_id, title: p.title, mode: 'ask', prompt: '' }); });
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
  plan: '⏸ Plan mode: Jarvis Code plans, you approve (⇧⇥ to switch)',
  ask: 'Asks before each edit and command (⇧⇥ to switch)',
  edits: '⏵⏵ Auto-edits: edits go ahead, commands ask (⇧⇥ to switch)',
  auto: '⏵⏵⏵ Full auto: runs anything (⇧⇥ to switch)',
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
  $('jc-sub').textContent = sub.join('  ·  ');
}

function setThumb() {
  const group = $('jc-mode');
  const on = group.querySelector('button[aria-checked="true"]');
  const thumb = group.querySelector('.jc-thumb');
  if (!on) { thumb.style.width = '0'; return; }
  thumb.style.left = `${on.offsetLeft}px`;
  thumb.style.width = `${on.offsetWidth}px`;
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
  const mode = t ? t.mode : 'ask';
  document.querySelectorAll('#jc-mode button').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.mode === mode)));
  setThumb();
  if (!t) {
    $('cc-mode').textContent = 'Pick a session, or start one. ? for shortcuts';
    $('cc-meta').textContent = '';
    $('cc-working').hidden = true;
    $('jc-todos').hidden = true;
    $('jc-bg').hidden = true;
    $('jc-model').textContent = 'Model';
    $('jc-effort').textContent = 'Effort';
    setCtx(null);
    return;
  }
  $('cc-mode').textContent = MODE_LINES[t.mode] || t.mode;
  $('jc-model').textContent = MODEL_LABELS[t.model] || (t.model ? t.model.replace('claude-', '') : 'Model');
  $('jc-effort').textContent = t.effort ? `Effort: ${t.effort}` : 'Effort';
  $('cc-meta').textContent = [
    t.files_changed.length ? `${t.files_changed.length} file${t.files_changed.length === 1 ? '' : 's'}` : '',
    t.cost_usd ? `$${t.cost_usd.toFixed(2)}` : '',
    t.queued ? `${t.queued} queued` : '',
  ].filter(Boolean).join(' · ');
  setCtx(ccContext[t.id]);
  if (t.busy && !workingSince) workingSince = Date.now();
  if (!t.busy) workingSince = 0;
  $('cc-working').hidden = !t.busy;
  $('cc-working-text').textContent = `${t.last_action && t.last_action !== 'Working' ? t.last_action : 'Working'}…`;
  renderTodos(t.todos || []);
  renderBackground(t.background || []);
  $('ds-voice').setAttribute('aria-pressed', String(!!voiceFocus && voiceFocus.id === t.id));
  if (currentPane === 'background') renderPaneBody();
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

document.querySelectorAll('#jc-mode button').forEach((b) => b.addEventListener('click', () => {
  const t = currentTask();
  if (!t) return;
  if (b.dataset.mode === 'auto' && !confirm('Full auto lets this session run any command without asking. Switch?')) return;
  send({ type: 'task_mode', id: t.id, mode: b.dataset.mode });
}));
window.addEventListener('resize', () => { setThumb(); moveGlider(); });

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
  else send({ type: 'task_new', directory: deckProject, prompt: '', mode: 'ask' });
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
  const box = el('div', 'jc-md');
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
  head.append(el('span', 'jc-badge', `Agent · ${e.agent || 'general'}`), el('span', 'jc-tlabel', e.text.replace(/^Agent:\s*/, '')), el('span', 'jc-tstate'));
  li.append(head, el('ul', 'jc-agent-steps'));
  const out = el('div', 'jc-md jc-out');
  out.hidden = true;
  li.append(out);
  toolState(li, e.status || 'done');
  return li;
}

const live = { text: null, thinking: null, frame: 0 };

function appendEntry(e) {
  const tl = $('deck-timeline');
  const box = $('cc-scroll');
  const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 140;
  let li;
  if (e.role === 'user') {
    li = el('li', 'jc-user', e.text);
    li.dataset.n = e.n || '';
    if (e.images) li.append(el('span', 'jc-pics', `🖼 ${e.images} image${e.images === 1 ? '' : 's'}`));
    li.append(userActions(e));
  } else if (e.role === 'assistant') {
    if (live.text) { live.text.remove(); live.text = null; }
    li = el('li', 'jc-say');
    li.append(richText(e.text), copyButton(() => e.text));
  } else if (e.role === 'thinking') {
    if (live.thinking) { live.thinking.remove(); live.thinking = null; }
    li = el('li');
    const det = el('details', 'jc-think');
    det.append(el('summary', '', 'Thinking'), el('div', '', e.text));
    li.append(det);
  } else if (e.role === 'tool' && e.tool === 'Agent') {
    li = agentEntry(e);
  } else if (e.role === 'tool' && e.tool) {
    li = toolEntry(e);
  } else if (e.role === 'subtool') {
    const agent = [...tl.querySelectorAll('.jc-agent')].find((n) => n.dataset.toolId === e.parent);
    if (agent) { agent.querySelector('.jc-agent-steps').append(el('li', '', e.text)); return; }
    li = el('li', 'jc-note', `↳ ${e.text}`);
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
  tl.insertBefore(li, tl.querySelector('.jc-ask'));
  $('cc-welcome').hidden = true;
  if (nearBottom) box.scrollTop = box.scrollHeight;
}

function userActions(e) {
  const wrap = el('span', 'jc-user-actions');
  const rewind = el('button', 'jc-mini', '⟲ Rewind code to here');
  rewind.type = 'button';
  const fork = el('button', 'jc-mini', '⑂ Fork from here');
  fork.type = 'button';
  const ready = () => !!wrap.closest('li').dataset.uuid;
  rewind.addEventListener('click', () => {
    if (!ready()) return;
    if (confirm('Put the files back as they were before this message?')) send({ type: 'task_rewind', id: ccSelected, uuid: wrap.closest('li').dataset.uuid });
  });
  fork.addEventListener('click', () => { if (ready()) { awaitingNewSession = true; send({ type: 'task_fork', id: ccSelected, uuid: wrap.closest('li').dataset.uuid }); } });
  wrap.append(rewind, fork);
  if (e.uuid) requestAnimationFrame(() => { const li = wrap.closest('li'); if (li) li.dataset.uuid = e.uuid; });
  return wrap;
}

function onEntryMeta(ev) {
  if (ev.id !== ccSelected) return;
  const li = [...$('deck-timeline').querySelectorAll('.jc-user')].find((n) => String(n.dataset.n) === String(ev.n));
  if (li) li.dataset.uuid = ev.uuid;
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
  const box = $('cc-scroll');
  const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 140;
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
      live.text.dataset.raw = '';
      tl.insertBefore(live.text, tl.querySelector('.jc-ask'));
    }
    live.text.dataset.raw += ev.text;
    if (!live.frame) {
      // One redraw per frame, not per token: a long reply would otherwise re-render
      // itself hundreds of times a second.
      live.frame = requestAnimationFrame(() => {
        live.frame = 0;
        if (!live.text) return;
        live.text.replaceChildren(richText(live.text.dataset.raw));
        if (nearBottom) box.scrollTop = box.scrollHeight;
      });
    }
  }
  $('cc-welcome').hidden = true;
  if (nearBottom) box.scrollTop = box.scrollHeight;
}

// An approval, as a sheet in the conversation: capsule answers, number keys, and a
// "tell Claude what to do instead" box for no.
function renderInlineApprovals() {
  document.querySelectorAll('#deck-timeline .jc-ask').forEach((n) => n.remove());
  for (const a of pendingApprovals.values()) {
    if (a.task_id !== ccSelected) continue;
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
    a.choices.forEach((c, i) => {
      const b = el('button', `jc-btn small ${i === 0 ? 'filled' : ''}`);
      b.type = 'button';
      b.append(el('kbd', '', String(i + 1)), document.createTextNode(c.label));
      b.addEventListener('click', () => {
        if (c.id === 'deny') { feedback.hidden = false; input.focus(); return; }
        answerApproval(a, c.id);
      });
      row.append(b);
    });
    sendNo.addEventListener('click', () => answerApproval(a, 'deny', input.value));
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); answerApproval(a, 'deny', input.value); } });
    li.append(row, feedback, el('p', 'jc-ask-hint', 'Press a number, or just say “yes”, “no, …” or “option 2”.'));
    $('deck-timeline').append(li);
    if (document.activeElement === $('deck-input') && !$('deck-input').value) row.querySelector('button').focus();
    $('cc-welcome').hidden = true;
    $('cc-scroll').scrollTop = $('cc-scroll').scrollHeight;
  }
}

function answerApproval(a, choice, feedback) {
  send({ type: 'approve', id: a.id, choice, feedback: feedback || '' });
  document.querySelectorAll(`[data-approval="${CSS.escape(a.id)}"]`).forEach((n) => n.remove());
}

// ── the composer: messages, / commands, @ files, pictures ──

const SLASH_COMMANDS = [
  ['plan', 'Plan first, you approve'], ['ask', 'Ask before each edit and command'], ['edits', 'Accept edits automatically'],
  ['auto', 'Full auto: run anything'], ['undo', 'Undo the last round of file changes'], ['diff', 'Show what changed'],
  ['commit', 'Commit the changes'], ['pr', 'Push and open a pull request'], ['test', 'Run the tests'],
  ['compact', 'Compact the conversation'], ['context', 'Context window used'], ['cost', 'What this session has cost'],
  ['model', 'Switch model: /model sonnet'], ['effort', 'How hard it thinks: /effort high'], ['fork', 'Fork this session'],
  ['rename', 'Rename: /rename New name'], ['export', 'Save the transcript as Markdown'], ['files', 'Browse the project'],
  ['terminal', 'Open a terminal here'], ['mcp', 'MCP servers'], ['permissions', 'Commands it won’t ask about again'],
  ['init', 'Write a CLAUDE.md for this project'], ['review', 'Review the changes'], ['new', 'New session in this project'],
  ['voice', 'Voice coding on or off'], ['stop', 'Interrupt the current step'],
];
const projectFiles = {};
let pickIndex = 0;
let attachments = [];

function suggestions() {
  const input = $('deck-input');
  const v = input.value.slice(0, input.selectionStart);
  if (/^\/[\w-]*$/.test(v)) {
    const q = v.slice(1).toLowerCase();
    return { kind: 'slash', items: SLASH_COMMANDS.filter(([name]) => name.startsWith(q)).map(([name, help]) => ({ label: `/${name}`, help, value: name })) };
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
    const needsArg = ['model', 'effort', 'rename'].includes(item.value);
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
    case 'effort': if (t && arg) send({ type: 'task_effort', id: t.id, effort: arg }); return true;
    case 'init': if (t) send({ type: 'task_send', id: t.id, text: 'Look over this project and write (or update) a CLAUDE.md at its root that orients a new contributor: how to build, test and lint, the layout, and the conventions.' }); return true;
    case 'review': if (t) send({ type: 'task_send', id: t.id, text: 'Review the uncommitted changes in this project for bugs, security problems and anything that breaks existing behavior. List findings by severity.' }); return true;
    default: return false;
  }
}

function sendToSession(text) {
  text = text.trim();
  const images = attachments.map((a) => ({ media_type: a.type, data: a.data }));
  if (!text && !images.length) return;
  clearAttachments();
  const t = currentTask();
  if (!t) {
    if (!deckProject) return;
    awaitingNewSession = true;
    send({ type: 'task_new', directory: deckProject, prompt: text, mode: 'ask' });
    return;
  }
  if (text.startsWith('/') && !images.length) {
    if (localSlash(text)) return;
    if (text === '/new' || text === '/clear') awaitingNewSession = true;
    send({ type: 'code_command', id: t.id, text });
    return;
  }
  send({ type: 'task_send', id: t.id, text, images });
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
  const s = suggestions();
  if (s.items.length && !$('cc-slash').hidden) {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); pickIndex = (pickIndex + (e.key === 'ArrowDown' ? 1 : -1) + s.items.length) % s.items.length; renderSuggestions(); return; }
    if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) { e.preventDefault(); pick(s, s.items[pickIndex]); return; }
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); $('cc-slash').hidden = true; return; }
  }
  if (e.key === 'Tab' && e.shiftKey) {  // shift+tab cycles the mode, as in Claude Code
    e.preventDefault();
    const t = currentTask();
    if (t) send({ type: 'task_mode', id: t.id, mode: MODE_CYCLE[(MODE_CYCLE.indexOf(t.mode) + 1) % MODE_CYCLE.length] });
    return;
  }
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); $('deck-composer').requestSubmit(); }
});
$('deck-input').addEventListener('input', () => {
  pickIndex = 0;
  renderSuggestions();
  $('deck-input').style.height = 'auto';
  $('deck-input').style.height = `${Math.min(220, $('deck-input').scrollHeight)}px`;
});

// Pictures: paste, drop, or the paperclip.
function addImageFile(file) {
  if (!file || !file.type.startsWith('image/') || attachments.length >= 6 || file.size > 6_000_000) return;
  const reader = new FileReader();
  reader.onload = () => {
    const url = String(reader.result);
    attachments.push({ type: file.type, data: url.split(',', 2)[1], url });
    renderAttachments();
  };
  reader.readAsDataURL(file);
}
function renderAttachments() {
  const box = $('jc-attach');
  box.hidden = !attachments.length;
  box.replaceChildren(...attachments.map((a, i) => {
    const t = el('span', 'jc-thumb-img');
    const img = el('img');
    img.src = a.url;
    img.alt = 'Attached image';
    const x = el('button', '', '×');
    x.type = 'button';
    x.setAttribute('aria-label', 'Remove image');
    x.addEventListener('click', () => { attachments.splice(i, 1); renderAttachments(); });
    t.append(img, x);
    return t;
  }));
}
function clearAttachments() { attachments = []; renderAttachments(); }
$('deck-input').addEventListener('paste', (e) => {
  const files = [...(e.clipboardData ? e.clipboardData.files : [])].filter((f) => f.type.startsWith('image/'));
  if (files.length) { e.preventDefault(); files.forEach(addImageFile); }
});
$('deck-composer').addEventListener('dragover', (e) => { e.preventDefault(); $('deck-composer').classList.add('drag'); });
$('deck-composer').addEventListener('dragleave', () => $('deck-composer').classList.remove('drag'));
$('deck-composer').addEventListener('drop', (e) => {
  e.preventDefault();
  $('deck-composer').classList.remove('drag');
  [...e.dataTransfer.files].forEach(addImageFile);
});
$('jc-attach-btn').addEventListener('click', () => $('jc-file').click());
$('jc-file').addEventListener('change', (e) => { [...e.target.files].forEach(addImageFile); e.target.value = ''; });

// Number keys answer the approval on screen; ⇧⌘F opens the files.
document.addEventListener('keydown', (e) => {
  if ($('cc').hidden) return;
  if (e.key.toLowerCase() === 'f' && e.metaKey && e.shiftKey) { e.preventDefault(); openPane('files'); return; }
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  const tag = document.activeElement && document.activeElement.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || document.activeElement.isContentEditable) return;  // typing
  const a = [...pendingApprovals.values()].find((x) => x.task_id === ccSelected);
  const n = Number(e.key);
  if (a && n >= 1 && n <= a.choices.length) {
    e.preventDefault();
    const c = a.choices[n - 1];
    if (c.id === 'deny') { const box = document.querySelector(`[data-approval="${CSS.escape(a.id)}"] .jc-feedback`); if (box) { box.hidden = false; box.querySelector('input').focus(); } } else answerApproval(a, c.id);
  }
});

// Esc in Jarvis Code undoes the most specific thing first, as in Claude Code: a menu or
// suggestion list, an edit, the running step, the open pane, and only then the panel
// (never with unsent text in the composer). True when it handled the key.
function jcEscape(e) {
  if (!$('jc-menu').hidden) { closeMenu(); return true; }
  if (!$('cc-slash').hidden) { $('cc-slash').hidden = true; return true; }
  if ($('jc-title').isContentEditable) return true;
  const t = currentTask();
  if (t && t.busy) { send({ type: 'task_interrupt', id: t.id }); return true; }
  if (currentPane) { closePane(); return true; }
  const field = e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLInputElement;
  return field && !!e.target.value;
}

// ── menus: model, effort, More ──

function openMenu(anchor, items) {
  const menu = $('jc-menu');
  menu.replaceChildren(...items.map((item) => {
    if (item === '-') return el('hr');
    const b = el('button', item.switch !== undefined ? 'jc-menu-switch' : '');
    b.type = 'button';
    b.setAttribute('role', item.checked !== undefined ? 'menuitemradio' : 'menuitem');
    if (item.checked !== undefined) b.setAttribute('aria-checked', String(item.checked));
    if (item.switch !== undefined) {
      const text = el('span', '', item.label);
      if (item.note) text.append(el('small', '', item.note));
      b.append(text, el('span', `sw ${item.switch ? 'on' : ''}`));
    } else {
      b.append(el('span', '', item.label));
      if (item.key) b.append(el('span', 'k', item.key));
    }
    b.addEventListener('click', () => { closeMenu(); item.run(); });
    return b;
  }));
  menu.hidden = false;
  const r = anchor.getBoundingClientRect();
  const w = menu.offsetWidth, h = menu.offsetHeight;
  menu.style.left = `${Math.max(8, Math.min(window.innerWidth - w - 8, r.right - w))}px`;
  menu.style.top = `${r.bottom + 6 + h > window.innerHeight ? r.top - h - 6 : r.bottom + 6}px`;
  anchor.setAttribute('aria-expanded', 'true');
  menu.dataset.anchor = anchor.id;
  const first = menu.querySelector('button');
  if (first) first.focus();
}
function closeMenu() {
  const menu = $('jc-menu');
  if (menu.hidden) return;
  menu.hidden = true;
  const anchor = menu.dataset.anchor && $(menu.dataset.anchor);
  if (anchor) anchor.setAttribute('aria-expanded', 'false');
}
document.addEventListener('mousedown', (e) => {
  if (!$('jc-menu').hidden && !$('jc-menu').contains(e.target) && !e.target.closest('[aria-haspopup]')) closeMenu();
});

$('jc-model').addEventListener('click', () => {
  const t = currentTask();
  if (!t) return;
  openMenu($('jc-model'), Object.entries({ opus: 'Opus 5.5', sonnet: 'Sonnet 5.5', haiku: 'Haiku 4.5', fable: 'Fable 5.1' }).map(([key, label]) => ({
    label, checked: MODEL_LABELS[t.model] === label, run: () => send({ type: 'code_command', id: t.id, text: `/model ${key}` }),
  })));
});
$('jc-effort').addEventListener('click', () => {
  const t = currentTask();
  if (!t) return;
  const notes = { low: 'Fastest', medium: '', high: 'The default', xhigh: '', max: 'Thinks as hard as it can' };
  openMenu($('jc-effort'), ['low', 'medium', 'high', 'xhigh', 'max'].map((e) => ({
    label: `${e[0].toUpperCase()}${e.slice(1)}${notes[e] ? ` · ${notes[e]}` : ''}`, checked: (t.effort || 'high') === e,
    run: () => send({ type: 'task_effort', id: t.id, effort: e }),
  })));
});
let awake = false;
$('jc-more').addEventListener('click', () => {
  const t = currentTask();
  openMenu($('jc-more'), [
    { label: 'Artifacts', run: () => openPane('artifacts') },
    { label: 'Files', key: '⇧⌘F', run: () => openPane('files') },
    { label: 'Background tasks', run: () => openPane('background') },
    { label: 'iOS Simulator', run: () => openPane('sim') },
    { label: 'MCP servers', run: () => openPane('mcp') },
    { label: 'Permissions', run: () => openPane('rules') },
    '-',
    { label: 'Rename session…', run: () => $('jc-title').dispatchEvent(new MouseEvent('dblclick')) },
    { label: 'Fork session', run: () => { if (t) { awakeNewSessionFork(t); } } },
    { label: 'Export transcript', run: () => t && send({ type: 'task_export', id: t.id }) },
    { label: 'Interrupt', key: 'Esc', run: () => t && send({ type: 'task_interrupt', id: t.id }) },
    { label: 'End session', run: () => t && send({ type: 'task_cancel', id: t.id }) },
    '-',
    { label: 'Keep computer awake', note: 'Only while Jarvis is running', switch: awake, run: () => send({ type: 'awake', on: !awake }) },
  ]);
});
function awakeNewSessionFork(t) { awaitingNewSession = true; send({ type: 'task_fork', id: t.id }); }

// ── the workbench pane ──

let currentPane = null;
const PANE_TITLES = { terminal: 'Terminal', diff: 'Changes', sim: 'iOS Simulator', files: 'Files', artifacts: 'Artifacts', background: 'Background tasks', mcp: 'MCP servers', rules: 'Permissions' };
const term = { id: null, xterm: null, fit: null, loading: null, observer: null };
let diffFiles = [];
let simDevices = [];
let simWatching = '';
let fileView = null;
let mcpServers = [];
let rules = [];

document.querySelectorAll('.jc-tool[data-pane]').forEach((b) => b.addEventListener('click', () => {
  if (currentPane === b.dataset.pane) closePane(); else openPane(b.dataset.pane);
}));
$('jc-browser').addEventListener('click', () => { if (typeof toggleBrowser === 'function') toggleBrowser(true); });
$('jc-pane-close').addEventListener('click', closePane);

function openPane(kind) {
  if (currentPane === 'sim' && kind !== 'sim') { send({ type: 'sim_watch', udid: '' }); simWatching = ''; }
  currentPane = kind;
  $('jc-pane').hidden = false;
  $('jc-pane-title').textContent = PANE_TITLES[kind] || kind;
  document.querySelectorAll('.jc-tool[data-pane]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.pane === kind)));
  const t = currentTask();
  if (kind === 'diff' && t) send({ type: 'task_diff', id: t.id });
  if (kind === 'sim') send({ type: 'sim_list' });
  if (kind === 'mcp' && t) send({ type: 'task_mcp', id: t.id });
  if (kind === 'rules' && t) send({ type: 'task_rules', id: t.id });
  if ((kind === 'files' || kind === 'artifacts') && deckProject && !projectFiles[deckProject]) send({ type: 'project_files', directory: deckProject });
  renderPaneBody();
}

function closePane() {
  if (currentPane === 'sim') { send({ type: 'sim_watch', udid: '' }); simWatching = ''; }
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
  if (currentPane === 'rules') {
    const intro = el('p', 'jc-dim', 'Commands Jarvis Code runs here without asking (from “Yes, and don’t ask again”).');
    if (!rules.length) { body.replaceChildren(intro, el('p', 'jc-empty', 'None yet.')); return; }
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
    body.replaceChildren(intro, ul);
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
  const box = el('div', 'jc-sim');
  const booted = simDevices.filter((d) => d.state === 'Booted');
  if (!simDevices.length) { body.replaceChildren(el('p', 'jc-empty', 'Looking for simulators… (Xcode needs to be installed)')); return; }
  if (booted.length) {
    const device = booted[0];
    if (simWatching !== device.udid) { simWatching = device.udid; send({ type: 'sim_watch', udid: device.udid }); }
    const img = el('img');
    img.id = 'jc-sim-img';
    img.alt = `${device.name} screen`;
    const open = el('button', 'jc-btn small', 'Open Simulator');
    open.type = 'button';
    open.addEventListener('click', () => send({ type: 'sim_open' }));
    box.append(el('p', 'jc-dim', `${device.name} · ${device.os}`), img, open);
  } else {
    box.append(el('p', 'jc-dim', 'No simulator is running. Boot one:'));
    const ul = el('ul', 'jc-list');
    ul.append(...simDevices.slice(0, 8).map((d) => {
      const li = el('li');
      const boot = el('button', 'jc-btn small', 'Boot');
      boot.type = 'button';
      boot.addEventListener('click', () => { boot.textContent = 'Booting…'; send({ type: 'sim_boot', udid: d.udid }); });
      li.append(el('span', '', `${d.name}`), el('small', '', d.os), boot);
      return li;
    }));
    box.append(ul);
  }
  body.replaceChildren(box);
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

function drawViewer(viewer) {
  viewer = viewer || document.querySelector('#jc-pane-body .jc-viewer');
  if (!viewer || !fileView) return;
  if (!fileView.text && !fileView.error) { viewer.replaceChildren(el('p', 'jc-dim', `Opening ${fileView.path}…`)); return; }
  if (fileView.error) { viewer.replaceChildren(el('p', 'jc-dim', fileView.error)); return; }
  const pre = el('pre', 'jc-code');
  for (const line of fileView.text.split('\n').slice(0, 4000)) pre.append(el('span', 'ln', `${line}\n`));
  viewer.replaceChildren(el('p', 'jc-label', fileView.path + (fileView.truncated ? ' (first 300 KB)' : '')), pre);
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
const MODE_LABELS = { plan: 'Plan mode', ask: 'Ask first', edits: 'Auto-edits', auto: 'Full auto' };

function onVoiceCode(focus) {
  voiceFocus = focus || null;
  $('code-pill').hidden = !voiceFocus;
  if (voiceFocus) $('code-text').textContent = `Voice coding · ${voiceFocus.folder} · ${MODE_LABELS[voiceFocus.mode] || voiceFocus.mode}`;
  $('cc-voice-head').setAttribute('aria-pressed', String(!!voiceFocus));
  $('cc-voice-label').textContent = voiceFocus ? `Voice · ${voiceFocus.folder}` : 'Voice off';
  $('ds-voice').setAttribute('aria-pressed', String(!!voiceFocus && voiceFocus.id === ccSelected));
  $('deck-input').placeholder = voiceFocus && voiceFocus.id === ccSelected ? 'Listening: just talk (say “exit code mode” to stop), or type…' : 'Ask Jarvis Code to plan, build or fix something…';
  renderProjects(deckProjects);
}

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

// Events for Jarvis Code beyond the core ones.
function onJarvisCodeEvent(ev) {
  switch (ev.type) {
    case 'task_stream': onStream(ev); return true;
    case 'task_entry_meta': onEntryMeta(ev); return true;
    case 'task_diff': if (ev.id === ccSelected) { diffFiles = ev.files || []; if (currentPane === 'diff' || currentPane === 'artifacts') renderPaneBody(); } return true;
    case 'task_rules': if (ev.id === ccSelected) { rules = ev.rules || []; if (currentPane === 'rules') renderPaneBody(); } return true;
    case 'task_mcp': if (ev.id === ccSelected) { mcpServers = ev.servers || []; if (currentPane === 'mcp') renderPaneBody(); } return true;
    case 'project_files': projectFiles[ev.directory] = ev.files || []; if (currentPane === 'files' && ev.directory === deckProject) renderPaneBody(); return true;
    case 'file_content': if (fileView && ev.path === fileView.path) { fileView = ev; drawViewer(); } return true;
    case 'term_open': onTermOpen(ev); return true;
    case 'term_data': onTermData(ev); return true;
    case 'term_exit': if (ev.term === term.id && term.xterm) term.xterm.write('\r\n[shell exited — reopen the Terminal to start a new one]\r\n'); return true;
    case 'sim_list': simDevices = ev.devices || []; if (currentPane === 'sim') renderPaneBody(); return true;
    case 'sim_frame': { const img = $('jc-sim-img'); if (img) img.src = `data:image/jpeg;base64,${ev.jpeg}`; return true; }
    case 'awake': awake = !!ev.on; return true;
    default: return false;
  }
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

// ── BSH Research Center ──
// The market breakdown opens the owner's research app inside the window. Only J.A.R.V.I.S.
// drives it: the page ignores the mouse and keyboard (main.js) and answers to voice (the
// research tools) and hands (a "page" target: aim with the hand, pinch to open, pinch
// and move to scroll, swipe to go back, fist to close).

const RC_DEFAULT = 'http://127.0.0.1:8010';
// What the header calls each page (the app's own titles don't say).
const RC_NAMES = {
  '/': 'Home', '/markets': 'Markets', '/market-radar': 'Markets · Market', '/weekly-summary': 'Markets · Pulse',
  '/news-desk': 'Markets · News', '/research-desk': 'Research desk', '/reports': 'Reports', '/tracking': 'Tracking',
  '/messages': 'Messages', '/trader-stats': 'Trader stats', '/stock-research': 'Stock research',
  '/source-library': 'Source library', '/innovation-lab': 'Innovation lab', '/help': 'Help', '/settings': 'Settings',
  '/login': 'Sign in',
};

function rcPageName(url, title) {
  const own = String(title || '').replace(/\s*[|·–—-]\s*BSH Research Center\s*$/i, '').trim();
  if (own && !/^BSH Research Center$/i.test(own)) return own;
  let path = '/';
  try { path = new URL(url).pathname.replace(/\/+$/, '') || '/'; } catch (_) { return own; }
  if (RC_NAMES[path]) return RC_NAMES[path];
  const last = decodeURIComponent(path.split('/').filter(Boolean).pop() || '');
  return last ? last.replace(/[-_]/g, ' ').replace(/^./, (c) => c.toUpperCase()) : 'Home';
}
let rcOpen = false;
let rcPath = '/markets';
let rcHover = null; // what a pinch would open, as the page reports it
let rcState = {};
let rcNoteUntil = 0;

function rcBounds() {
  const r = $('rc-slot').getBoundingClientRect();
  return { x: r.left, y: r.top, width: r.width, height: r.height };
}

function rcBase() {
  return (prefs && prefs.research_url) || RC_DEFAULT;
}

async function openResearch(path = '/markets') {
  rcPath = path;
  if (!app || !app.research) {
    window.open(`${rcBase()}${path}`, '_blank', 'noopener');
    return { ok: true };
  }
  if (!rcOpen) {
    rcOpen = true;
    rcState = {};
    $('rc').hidden = false;
    document.body.classList.add('rc-open');
    $('rc-page').textContent = 'Opening the market breakdown…';
    $('rc-progress').hidden = false;
    retargetHands();
  }
  $('rc-message').hidden = true;
  await new Promise((r) => requestAnimationFrame(r));
  placeHandPanel();
  const result = await app.research.show(rcBounds(), rcBase(), path);
  if (result && result.error) showResearchError(result.error);
  return result || { ok: true };
}

function closeResearch() {
  if (!rcOpen) return;
  rcOpen = false;
  $('rc').hidden = true;
  document.body.classList.remove('rc-open');
  if (app && app.research) app.research.hide();
  rcHover = null;
  placeHandPanel();
  retargetHands();
  send({ type: 'research_state', open: false });
}

function showResearchError(text) {
  $('rc-message-text').textContent = `${text} Start it, or set its address in Settings → Research Center.`;
  $('rc-message').hidden = false;
  $('rc-progress').hidden = true;
  if (app && app.research) app.research.hide();
}

function showRcNote(text) {
  rcNoteUntil = Date.now() + 2600;
  $('rc-status').textContent = text;
  $('rc-status').classList.add('note');
  setTimeout(() => {
    if (Date.now() < rcNoteUntil) return;
    $('rc-status').classList.remove('note');
    $('rc-status').textContent = handsOn ? $('hand-status').textContent : 'Say “Jarvis, …” or raise a hand';
  }, 2700);
}

// The hand camera lives in the rail while the research center is open.
function placeHandPanel() {
  const panel = $('hand-panel');
  const cam = $('rc-cam');
  const inRail = rcOpen && handsOn;
  cam.hidden = !inRail;
  if (inRail) {
    const r = cam.getBoundingClientRect();
    Object.assign(panel.style, { left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, right: 'auto', bottom: 'auto' });
  } else {
    ['left', 'top', 'width', 'right', 'bottom'].forEach((k) => { panel.style[k] = ''; });
  }
}

const researchTarget = {
  kind: 'page',
  move: (x, y, mode) => app.research.hand({ t: 'move', x, y, mode }),
  hide: () => app.research.hand({ t: 'hide', x: 0, y: 0 }),
  press: (x, y) => app.research.hand({ t: 'press', x, y }),
  drag: (dx, dy) => app.research.hand({ t: 'drag', dx, dy, x: 0, y: 0 }),
  release: ({ tap, vx, vy }) => app.research.hand({ t: 'release', tap, vx, vy, x: 0, y: 0 }),
  swipe: (dir) => app.research.command({ action: dir > 0 ? 'back' : 'forward' }),
  zoomBy: (f) => app.research.hand({ t: 'zoom', f }),
  hoverLabel: () => (rcHover ? rcHover.label : ''),
};

async function runResearchCmd(ev) {
  const args = ev.args || {};
  let result;
  try {
    if (!app || !app.research) result = { error: 'The Research Center only opens in the J.A.R.V.I.S. app window.' };
    else if (ev.action === 'open') {
      result = rcOpen ? await app.research.command({ action: 'open', args }) : await openResearch(args.path || '/markets');
      if (result && !result.error && !result.url) result = { ...result, url: rcState.url || '', title: rcState.title || '' };
    } else if (ev.action === 'close') {
      closeResearch();
      result = { ok: true };
    } else if (!rcOpen) result = { error: 'The Research Center is closed. Open it first.' };
    else result = await app.research.command({ action: ev.action, args });
  } catch (err) {
    result = { error: String(err) };
  }
  send({ type: 'research_result', id: ev.id, result });
}

$('p-markets').addEventListener('click', () => openResearch('/markets'));
$('p-markets').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openResearch('/markets'); }
});
$('rc-close').addEventListener('click', closeResearch);
$('rc-retry').addEventListener('click', () => openResearch(rcPath));
// What JARVIS hears and says shows in the rail too (the dashboard is behind the page).
new MutationObserver(() => { $('rc-heard').textContent = $('heard').textContent; }).observe($('heard'), { childList: true, characterData: true, subtree: true });
new MutationObserver(() => { $('rc-reply').textContent = $('reply').textContent; }).observe($('reply'), { childList: true, characterData: true, subtree: true });
new MutationObserver(() => {
  if (rcOpen && Date.now() >= rcNoteUntil) $('rc-status').textContent = $('hand-status').textContent;
}).observe($('hand-status'), { childList: true, characterData: true, subtree: true });

if (app && app.research) {
  app.research.onState((st) => {
    if (!rcOpen) return;
    rcState = st;
    const title = rcPageName(st.url, st.title);
    $('rc-page').textContent = title;
    $('rc-progress').hidden = !st.loading;
    $('rc-lock').classList.toggle('open', !st.locked);
    $('rc-lock-text').textContent = st.locked ? 'J.A.R.V.I.S. only' : 'Sign in yourself, then I take over';
    $('rc-zoom').hidden = !st.zoom || st.zoom === 100;
    $('rc-zoom').textContent = `${st.zoom}%`;
    if (st.error) { showResearchError(st.error); return; }
    send({ type: 'research_state', open: true, url: st.url || '', title, locked: !!st.locked });
  });
  app.research.onHover((hover) => { rcHover = hover; });
  app.research.onNote((note) => { if (note && note.text) showRcNote(note.text); });
  if (app.research.onEscape) app.research.onEscape(closeResearch);
  const follow = () => {
    if (!rcOpen) return;
    placeHandPanel();
    if ($('rc-message').hidden) app.research.setBounds(rcBounds());
  };
  new ResizeObserver(follow).observe($('rc-slot'));
  window.addEventListener('resize', follow);
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
    top.append(el('span', '', t.label || `Jarvis Code · ${t.folder}`), el('span', '', t.status));
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
