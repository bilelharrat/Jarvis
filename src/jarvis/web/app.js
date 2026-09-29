'use strict';

// Everything from the server is rendered with textContent: replies, email subjects and
// tool output are data and must never become markup.

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
let activity = [];
let runningTools = 0;

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
      $('cards').querySelectorAll('.needs-ok').forEach((n) => n.remove());
      (ev.approvals || []).forEach(showApproval);
      if (ev.turn && ev.turn.user) { showHeard(ev.turn.user); $('reply').textContent = ev.turn.reply || ''; }
      break;
    case 'state': setState(ev.value); break;
    case 'level': document.documentElement.style.setProperty('--level', ev.value); break;
    case 'turn': showHeard(ev.user); $('reply').textContent = ''; break;
    case 'heard': if (!ev.text) $('state-line').textContent = 'I didn’t catch that. Tap to try again.'; break;
    case 'reply': $('reply').textContent = ev.text; break;
    case 'tool': onTool(ev); break;
    case 'approval': showApproval(ev); break;
    case 'approval_resolved': { const n = document.querySelector(`[data-approval="${CSS.escape(ev.id)}"]`); if (n) n.remove(); break; }
    case 'status': renderStatus(ev); break;
    case 'tasks': renderTasks(ev.items); break;
    case 'task_finished':
      notice(`Claude Code · ${ev.folder}`, { done: 'Finished', stopped: 'Stopped', failed: 'Didn’t finish' }[ev.status] || ev.status, ev.result, 15000);
      break;
    case 'muted': setMuted(ev.value); break;
    case 'error': notice('Heads up', 'Something went wrong', ev.text, 10000); break;
  }
}

// ── orb & conversation ──

function setState(next) {
  state = next;
  document.body.dataset.state = next;
  if (next !== 'listening') document.documentElement.style.setProperty('--level', 0);
  $('state-line').textContent = (next === 'thinking' && runningTools > 0) ? 'Working on it…' : STATE_LINES[next] || '';
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
  if (!text) return;
  send({ type: 'ask', text });
}

$('orb').addEventListener('click', talkOrStop);
document.querySelectorAll('.chip').forEach((chip) => chip.addEventListener('click', () => ask(chip.dataset.ask)));
$('ask-form').addEventListener('submit', (e) => {
  e.preventDefault();
  ask($('ask-input').value);
  $('ask-input').value = '';
  $('ask-input').blur();
});

document.addEventListener('keydown', (e) => {
  const typing = e.target instanceof HTMLInputElement;
  if (e.key === 'Escape') {
    if (typing) e.target.blur();
    closePopovers();
    if (state !== 'idle') send({ type: 'stop' });
  } else if (e.code === 'Space' && !typing && !(e.target instanceof HTMLButtonElement)) {
    e.preventDefault();
    talkOrStop();
  }
});

if (app) app.onSummon(() => { if (state === 'idle') send({ type: 'listen' }); });

// ── header ──

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
  $('mute-btn').textContent = `Voice replies: ${muted ? 'off' : 'on'}`;
}

function closePopovers() {
  $('settings').hidden = true;
  $('settings-btn').setAttribute('aria-expanded', 'false');
}

$('settings-btn').addEventListener('click', (e) => {
  e.stopPropagation();
  const open = $('settings').hidden;
  $('settings').hidden = !open;
  $('settings-btn').setAttribute('aria-expanded', String(open));
});
document.addEventListener('click', (e) => { if (!e.target.closest('.settings')) closePopovers(); });
$('mute-btn').addEventListener('click', () => { send({ type: 'mute', value: !muted }); closePopovers(); });
$('reset-btn').addEventListener('click', () => {
  send({ type: 'reset' });
  $('heard').textContent = '';
  $('reply').textContent = '';
  closePopovers();
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

function notice(kicker, title, text, ms) {
  const card = el('div', 'card');
  card.append(el('div', 'card-kicker', kicker), el('div', 'card-title', title));
  if (text) card.append(el('div', 'card-text', text.length > 400 ? `${text.slice(0, 400)}…` : text));
  const dismiss = el('button', 'btn', 'Dismiss');
  dismiss.type = 'button';
  dismiss.addEventListener('click', () => card.remove());
  const actions = el('div', 'card-actions');
  actions.append(dismiss);
  card.append(actions);
  $('cards').append(card);
  if (ms) setTimeout(() => card.remove(), ms);
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
  const list = $('activity-list');
  list.replaceChildren(...activity.slice(0, 40).map((a) => {
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
    top.append(el('span', '', `Claude Code · ${t.folder}`), el('span', '', t.status));
    box.append(top, el('div', 'task-prompt', t.prompt.length > 140 ? `${t.prompt.slice(0, 140)}…` : t.prompt));
    box.append(el('div', 'task-state', t.last_action + (t.cost_usd ? ` · $${t.cost_usd.toFixed(2)}` : '')));
    if (t.status === 'running') {
      const stop = el('button', 'btn', 'Stop task');
      stop.type = 'button';
      stop.addEventListener('click', () => send({ type: 'task_cancel', id: t.id }));
      box.append(stop);
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
