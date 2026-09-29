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
      renderTasks(ev.tasks || []);
      renderPrefs(ev.prefs);
      renderBrain(ev.brain || {});
      $('cards').querySelectorAll('.needs-ok').forEach((n) => n.remove());
      (ev.approvals || []).forEach(showApproval);
      if (ev.turn && ev.turn.user) { currentRid = ev.turn.rid; showHeard(ev.turn.user); $('reply').textContent = ev.turn.reply || ''; }
      send({ type: 'galaxy' });
      send({ type: 'connectors' });
      break;
    case 'state': setState(ev.value); break;
    case 'level': document.documentElement.style.setProperty('--level', ev.value); break;
    case 'turn':
      currentRid = ev.rid;
      showHeard(ev.user);
      $('reply').textContent = '';
      renderSources();
      break;
    case 'turn_done':
      if (galaxyMode === 'ambient') scheduleAmbientEnd();
      break;
    case 'heard': if (!ev.text && state !== 'listening') $('state-line').textContent = 'I didn’t catch that. Tap to try again.'; break;
    case 'reply': $('reply').textContent = ev.text; break;
    case 'sources': onSources(ev); break;
    case 'tool': onTool(ev); break;
    case 'approval': showApproval(ev); break;
    case 'approval_resolved': { const n = document.querySelector(`[data-approval="${CSS.escape(ev.id)}"]`); if (n) n.remove(); break; }
    case 'status': renderStatus(ev); break;
    case 'tasks': renderTasks(ev.items); break;
    case 'task_finished': onTaskFinished(ev); break;
    case 'muted': setMuted(ev.value); break;
    case 'prefs': renderPrefs(ev); break;
    case 'brain': renderBrain(ev); break;
    case 'galaxy': galaxyData = ev; galaxy.setData(ev); renderLegend(); break;
    case 'galaxy_changed': send({ type: 'galaxy' }); break;
    case 'note': showNote(ev); break;
    case 'toast': notice(ev.title, '', ev.text, 8000); break;
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
  if (next === 'thinking' && runningTools > 0) line = 'Working on it…';
  if (next === 'idle' && prefs && prefs.hands_free) line = 'Say “Jarvis”, or tap the orb';
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
  else ask(chip.dataset.ask);
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
    if (!$('accounts').hidden) toggleAccounts(false);
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
  $('clock').textContent = now.toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
  const h = now.getHours();
  $('greeting').textContent = h < 5 ? 'Good evening.' : h < 12 ? 'Good morning.' : h < 18 ? 'Good afternoon.' : 'Good evening.';
}
tickClock();
setInterval(tickClock, 15000);

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
}

// ── settings ──

function setSwitch(id, on) {
  $(id).setAttribute('aria-checked', String(!!on));
}

function renderPrefs(p) {
  if (!p) return;
  prefs = p;
  const persona = (p.personas || []).find((x) => x.id === p.persona);
  $('wordmark').textContent = persona ? persona.name.charAt(0) + persona.name.slice(1).toLowerCase() : 'Jarvis';
  const model = (p.models || []).find((m) => m.id === p.model);
  $('model-chip').textContent = model ? model.name : p.model;
  $('hf-indicator').hidden = !p.hands_free;
  $('hint').replaceChildren(...(p.hands_free
    ? [document.createTextNode('Say “Jarvis” · talk over me to interrupt')]
    : [document.createTextNode('Tap the orb, or press '), el('kbd', '', '⌥ Space'), document.createTextNode(' anywhere')]));
  setSwitch('sw-effect', p.voice_effect);
  setSwitch('sw-handsfree', p.hands_free);
  setSwitch('sw-briefing', p.briefing_enabled);
  setSwitch('sw-notes', p.brain_notes);
  setSwitch('sw-bsh', p.brain_bsh);
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
  $('brain-label').textContent = b.state === 'building' ? 'Second brain · updating' : b.notes ? `Second brain · ${b.notes}` : 'Second brain';
}

function setPrefs(changes) {
  send({ type: 'set_prefs', changes });
}

function toggleSettings(open) {
  $('settings').hidden = !open;
  $('settings-btn').setAttribute('aria-expanded', String(open));
}

$('settings-btn').addEventListener('click', () => toggleSettings($('settings').hidden));
$('settings-close').addEventListener('click', () => toggleSettings(false));
$('model-chip').addEventListener('click', () => { toggleSettings(true); $('model-select').focus(); });
$('sw-voice').addEventListener('click', () => send({ type: 'mute', value: !muted }));
$('sw-effect').addEventListener('click', () => setPrefs({ voice_effect: !prefs.voice_effect }));
$('sw-handsfree').addEventListener('click', () => setPrefs({ hands_free: !prefs.hands_free }));
$('sw-briefing').addEventListener('click', () => setPrefs({ briefing_enabled: !prefs.briefing_enabled }));
$('sw-notes').addEventListener('click', () => setPrefs({ brain_notes: !prefs.brain_notes }));
$('sw-bsh').addEventListener('click', () => setPrefs({ brain_bsh: !prefs.brain_bsh }));
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

// ── cards ──

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

function onTaskFinished(ev) {
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
