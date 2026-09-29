'use strict';

// The phone companion: talk to J.A.R.V.I.S. on the Mac from anywhere on the same network
// (or tailnet). Voice in is the keyboard's dictation mic; voice out is Jarvis's own voice,
// fetched from the Mac and played here.

const $ = (id) => document.getElementById(id);
const TOKEN_KEY = 'jarvis-token';
let token = '';
let polling = null;
let busy = false;

function readToken() {
  try { return localStorage.getItem(TOKEN_KEY) || ''; } catch (_) { return ''; }
}

function saveToken(value) {
  try {
    if (value) localStorage.setItem(TOKEN_KEY, value);
    else localStorage.removeItem(TOKEN_KEY);
  } catch (_) { /* private mode: paired for this visit only */ }
}

async function api(path, body) {
  const res = await fetch(path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (res.status === 401) {
    token = '';
    saveToken('');
    show('pair');
    throw new Error('unpaired');
  }
  return res;
}

function show(view) {
  $('pair').hidden = view !== 'pair';
  $('app').hidden = view !== 'app';
  clearInterval(polling);
  if (view === 'app') {
    refresh();
    polling = setInterval(() => { if (!document.hidden) refresh(); }, 2500);
  }
}

// ── pairing ──

$('pair-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('pair-error').textContent = '';
  try {
    const res = await fetch('/api/pair', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: $('pair-code').value.trim(), name: $('pair-name').value.trim() }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Pairing failed.');
    token = data.token;
    saveToken(token);
    show('app');
  } catch (err) {
    $('pair-error').textContent = err.message;
  }
});

$('copy-token').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(token);
    $('copy-token').textContent = 'Copied. Paste it after “Bearer ” in the shortcut.';
  } catch (_) {
    $('copy-token').textContent = token; // no clipboard over plain http: show it to copy
  }
});

$('unpair').addEventListener('click', () => {
  token = '';
  saveToken('');
  show('pair');
});

// ── state ──

function setStatus(kind, text) {
  $('status').dataset.state = kind;
  $('status-text').textContent = text;
}

async function refresh() {
  let state;
  try {
    state = await (await api('/api/state')).json();
  } catch (err) {
    if (err.message !== 'unpaired') setStatus('offline', 'Mac not reachable');
    return;
  }
  document.body.dataset.state = state.state;
  setStatus(state.state === 'idle' ? 'online' : 'busy', state.state === 'idle' ? `Online · ${state.model}` : state.state);
  const w = state.weather;
  $('weather').hidden = !w || !!w.error;
  if (w && !w.error) $('weather').textContent = `${w.temp}${w.unit} ${w.summary} in ${w.city}. High ${w.high}, low ${w.low}.`;
  const next = state.next_event;
  $('next-event').hidden = !next;
  if (next) {
    const at = new Date(next.begin).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    $('next-event').textContent = `Next: ${next.title} at ${at}${next.location ? ` · ${next.location}` : ''}`;
  }
  $('meeting').hidden = !state.meeting;
  if (state.meeting) $('meeting').textContent = `● Taking notes: ${state.meeting}`;
  const notes = $('notes-btn');
  notes.textContent = state.meeting ? 'Stop notes' : 'Take notes';
  notes.dataset.command = state.meeting ? 'meeting_stop' : 'meeting_start';
  if (!busy && state.turn && state.turn.reply) {
    $('heard').textContent = state.turn.user ? `“${state.turn.user}”` : '';
    $('reply').textContent = state.turn.reply;
  }
  renderApprovals(state.approvals || []);
  const running = (state.tasks || []).filter((t) => ['running', 'waiting'].includes(t.status));
  $('tasks').hidden = !running.length;
  $('task-list').replaceChildren(...running.map((t) => {
    const li = document.createElement('li');
    li.textContent = t.title || t.label;
    const small = document.createElement('small');
    small.textContent = `${t.label} · ${t.last_action}`;
    li.append(small);
    return li;
  }));
}

function renderApprovals(items) {
  $('approvals').replaceChildren(...items.map((a) => {
    const card = document.createElement('div');
    card.className = 'approval';
    const q = document.createElement('p');
    q.textContent = a.question;
    card.append(q);
    if (a.detail) {
      const pre = document.createElement('pre');
      pre.textContent = a.detail;
      card.append(pre);
    }
    const row = document.createElement('div');
    row.className = 'row';
    for (const c of a.choices) {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = c.label;
      b.addEventListener('click', async () => {
        card.remove();
        await api('/api/approve', { id: a.id, choice: c.id }).catch(() => {});
        refresh();
      });
      row.append(b);
    }
    card.append(row);
    return card;
  }));
}

// ── asking ──

// iOS only lets audio play from a tap: prime the player during the tap, fill it later.
const SILENCE = 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=';
function primeAudio() {
  const player = $('player');
  if (!$('voice').checked || player.dataset.primed) return;
  player.src = SILENCE;
  player.play().then(() => { player.dataset.primed = '1'; }).catch(() => {});
}

async function speak(text) {
  if (!$('voice').checked || !text) return;
  try {
    const res = await api('/api/say', { text });
    if (!res.ok) return;
    const player = $('player');
    if (player.dataset.url) URL.revokeObjectURL(player.dataset.url);
    player.dataset.url = URL.createObjectURL(await res.blob());
    player.src = player.dataset.url;
    await player.play();
  } catch (_) { /* no voice: the text is on screen */ }
}

async function ask(text) {
  text = text.trim();
  if (!text || busy) return;
  busy = true;
  document.body.dataset.state = 'thinking';
  $('heard').textContent = `“${text}”`;
  $('reply').textContent = '…';
  try {
    const data = await (await api('/api/ask', { text })).json();
    if (data.error) throw new Error(data.error);
    renderApprovals(data.approvals || []);
    if (!data.done && (data.approvals || []).length) {
      $('reply').textContent = 'I need your OK for that; tap below.';
    } else if (!data.done) {
      // Past the phone's wait: it goes on on the Mac, where the answer shows.
      $('reply').textContent = data.reply ? `${data.reply}…` : 'Still working on it on the Mac…';
    } else {
      $('reply').textContent = data.reply || 'Done.';
      speak(data.reply);
    }
  } catch (err) {
    if (err.message !== 'unpaired') $('reply').textContent = `Couldn’t reach the Mac: ${err.message}`;
  } finally {
    busy = false;
    refresh();
  }
}

$('ask-form').addEventListener('submit', (e) => {
  e.preventDefault();
  primeAudio();
  const text = $('ask-input').value;
  $('ask-input').value = '';
  $('ask-input').blur();
  ask(text);
});

$('orb').addEventListener('click', () => {
  primeAudio();
  $('ask-input').focus(); // then the keyboard's mic key dictates
});

document.querySelectorAll('.chip').forEach((chip) => chip.addEventListener('click', async () => {
  primeAudio();
  if (chip.dataset.ask) return ask(chip.dataset.ask);
  const type = chip.dataset.command;
  const body = type === 'meeting_start' ? { type, title: 'Meeting' } : { type };
  await api('/api/command', body).catch(() => {});
  refresh();
}));

document.addEventListener('visibilitychange', () => { if (!document.hidden && token) refresh(); });

token = readToken();
show(token ? 'app' : 'pair');
