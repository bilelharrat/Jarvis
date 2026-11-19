// Eden Code's step-by-step replay (features/code_replay.py), from the More menu: a past
// session played back one step at a time with a scrubber (drag it, or ← → and Play): each
// message, the thinking, each step with its input, output and diff, and the files the
// session had changed as they were at each of the owner's messages (Claude Code's
// checkpoints), each one's change in that turn as a diff. "Fork from here" carries on from
// the end of the step's turn: the conversation in a fork, or a new session in an isolated
// copy with the files as they were then and a summary of the conversation as its draft.
// Settings › General › OpenTelemetry (features/code_otel.py) is drawn here too: the
// collector's address (off when empty), prompts opted in or not, what was sent, a test.
// Pure helpers exported for node's tests (tests/web/code-replay.test.mjs).
(function codeReplay(root) {
  'use strict';

  const KIND = { user: 'You', assistant: 'Eden', thinking: 'Thinking', tool: 'Step', agent: 'Subagent', note: 'Note', system: 'Note' };
  const PLAY_MS = 900;

  // A unified diff's lines, each with how it's drawn.
  function diffLines(diff) {
    return String(diff || '').split('\n').filter((l) => l !== '').map((text) => {
      let cls = 'ctx';
      if (text.startsWith('+++') || text.startsWith('---')) cls = 'file';
      else if (text.startsWith('@@')) cls = 'hunk';
      else if (text.startsWith('+')) cls = 'add';
      else if (text.startsWith('-')) cls = 'del';
      else if (text.startsWith('…')) cls = 'more';
      return { cls, text };
    });
  }

  // The turns: where each of the owner's messages is in the steps (its checkpoint, if any).
  function turnsOf(steps, checkpoints) {
    const kept = new Map((Array.isArray(checkpoints) ? checkpoints : []).map((c) => [c.uuid, c]));
    return (Array.isArray(steps) ? steps : []).filter((s) => s && s.kind === 'user').map((s, i) => ({ n: s.n, number: i + 1, uuid: s.uuid || '', checkpoint: kept.get(s.uuid) || null }));
  }

  // The checkpoint for step n: its turn's (the files as they were when that turn began).
  function checkpointFor(steps, checkpoints, n) {
    const step = Array.isArray(steps) ? steps[n] : null;
    if (!step || !step.turn) return null;
    return (Array.isArray(checkpoints) ? checkpoints : []).find((c) => c.uuid === step.turn) || null;
  }

  // "Step 5 of 120 · turn 2".
  function position(steps, n) {
    const total = Array.isArray(steps) ? steps.length : 0;
    if (!total) return 'No steps';
    const turn = turnsOf(steps).filter((t) => t.n <= n).length;
    return turn ? `Step ${n + 1} of ${total} · turn ${turn}` : `Step ${n + 1} of ${total}`;
  }

  // A step clamped into the list.
  function clamp(n, steps) {
    const total = Array.isArray(steps) ? steps.length : 0;
    if (!total) return 0;
    return Math.max(0, Math.min(total - 1, Number.isFinite(n) ? Math.round(n) : 0));
  }

  // Settings' line for the export: what went, what's waiting, the last trouble.
  function otelLine(s) {
    if (!s || !s.enabled) return 'Off. Nothing is sent.';
    if (!s.endpoint_ok) return 'That address can’t be used: https://…, or http:// on this Mac or your network.';
    if (s.error) return `${s.error}${s.waiting ? ` ${s.waiting} waiting to go.` : ''}`;
    return s.sent ? `On. ${s.sent} sent.` : 'On. Nothing sent yet: spans go as each turn ends.';
  }

  // Whether an address can be the collector's, as the backend has it (code_otel.endpoints):
  // https anywhere, plain http only to this Mac or the local network; "" is off.
  function endpointOk(text) {
    const given = String(text || '').trim();
    if (!given) return true;
    let u;
    try { u = new URL(given); } catch { return false; }
    if (u.username || u.password || /\s/.test(given)) return false;
    if (u.protocol === 'https:') return !!u.hostname;
    if (u.protocol !== 'http:') return false;
    const host = u.hostname.replace(/^\[|\]$/g, '').toLowerCase();
    return host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host === '::1'
      || /^127\./.test(host) || /^10\./.test(host) || /^192\.168\./.test(host) || /^172\.(1[6-9]|2\d|3[01])\./.test(host)
      || /^169\.254\./.test(host) || /^f[cd][0-9a-f]{2}:/.test(host) || /^fe80:/.test(host);
  }

  const api = { KIND, diffLines, turnsOf, checkpointFor, position, clamp, otelLine, endpointOk };
  if (typeof module === 'object' && module.exports) { module.exports = api; return; }
  const F = root.jarvisFeatures;
  if (!F) return;
  const { el } = F;
  const t = (text) => F.t(text);
  const mine = (node) => { node.setAttribute('data-no-i18n', ''); return node; };

  // The session being replayed: what the backend read, the step on show, steps read whole.
  const R = { id: 0, ref: '', loading: false, error: '', title: '', steps: [], checkpoints: [], copy: false, n: 0, full: new Map(), file: null, playing: 0, forking: false, forked: '', forkBad: false };
  let refN = 0;
  const ref = (p) => `${p}${++refN}`;
  const want = { step: '', file: '', fork: '' };

  function shown() { return typeof currentPane !== 'undefined' && currentPane === 'cw-replay' && !F.$('jc-pane').hidden; }
  function body() { return F.$('jc-pane-body'); }

  function load(task) {
    stop();
    Object.assign(R, { id: task.id, ref: ref('r'), loading: true, error: '', steps: [], checkpoints: [], n: 0, full: new Map(), file: null, forked: '' });
    if (!F.send({ type: 'cw_replay', id: task.id, ref: R.ref })) { R.loading = false; R.error = 'Not connected.'; }
  }

  function ask(n) {
    if (R.full.has(n) || !R.steps.length) return;
    want.step = ref('s');
    F.send({ type: 'cw_replay_step', id: R.id, n, ref: want.step });
  }

  function go(n) {
    R.n = clamp(n, R.steps);
    R.file = null;
    ask(R.n);
    if (shown()) draw(body());
  }

  function stop() { if (R.playing) { clearInterval(R.playing); R.playing = 0; } }
  function play() {
    if (R.playing) { stop(); if (shown()) draw(body()); return; }
    if (R.n >= R.steps.length - 1) R.n = 0;
    R.playing = setInterval(() => { if (R.n >= R.steps.length - 1 || !shown()) { stop(); if (shown()) draw(body()); return; } go(R.n + 1); }, PLAY_MS);
    go(R.n);
  }

  function pre(cls, text) { return mine(el('pre', `rp-pre ${cls}`, text)); }

  function diffView(diff) {
    const box = el('div', 'rp-diff');
    box.setAttribute('role', 'region');
    box.setAttribute('aria-label', t('Diff'));
    for (const line of diffLines(diff)) box.append(mine(el('div', `rp-l ${line.cls}`, line.text)));
    return box;
  }

  function stepView(head) {
    const card = el('article', `rp-step k-${head.kind}`);
    const top = el('div', 'rp-step-top');
    const full = R.full.get(head.n);
    top.append(el('span', 'rp-kind', t(KIND[head.kind] || 'Note')));
    // (a message's heading is its first words: once it's read whole, its text says them)
    if (!(full && full.text && !['tool', 'agent'].includes(head.kind))) top.append(mine(el('strong', 'rp-title', head.title || '')));
    if (head.error) top.append(el('span', 'rp-bad', t('Failed')));
    if (head.at) top.append(mine(el('time', 'rp-at', String(head.at).replace('T', ' ').slice(0, 19))));
    card.append(top);
    if (!full) { card.append(el('p', 'rp-wait', t('Reading this step…'))); return card; }
    if (full.hidden) card.append(el('p', 'rp-wait', t('Claude’s thinking here was hidden.')));
    if (full.text) card.append(pre('text', full.text));
    if (full.kind === 'user' && (full.pictures || (full.files || []).length)) {
      const bits = [];
      if (full.pictures) bits.push(`${full.pictures} ${t(full.pictures === 1 ? 'picture' : 'pictures')}`);
      if ((full.files || []).length) bits.push(full.files.join(', '));
      card.append(mine(el('p', 'rp-meta', bits.join(' · '))));
    }
    if (full.input) { const d = el('details', 'rp-io'); d.append(el('summary', '', t('Input')), pre('io', full.input)); card.append(d); }
    if (full.diff) card.append(diffView(full.diff));
    if (full.output !== undefined && full.output !== null) {
      const d = el('details', 'rp-io');
      d.open = !!full.error;
      d.append(el('summary', '', t('Output')), pre('io', full.output || t('(nothing)')));
      card.append(d);
    } else if (full.kind === 'tool' || full.kind === 'agent') card.append(el('p', 'rp-wait', t('No result came back for this step.')));
    return card;
  }

  function filesView(cp) {
    const box = el('section', 'rp-files');
    box.append(el('p', 'rp-label', t('Files at the start of this turn')));
    if (!cp || !cp.files.length) { box.append(el('p', 'rp-wait', t('No checkpoint here: Claude Code keeps one at each of your messages, once it has changed a file.'))); return box; }
    const list = el('div', 'rp-file-list');
    const changed = new Set(cp.changed || []);
    for (const f of cp.files) {
      const b = mine(el('button', `jc-mini rp-file${changed.has(f.name) ? ' changed' : ''}`, f.name));
      b.type = 'button';
      b.title = changed.has(f.name) ? t('Changed in this turn: show its change') : t('Show this file then, and its change');
      b.setAttribute('aria-pressed', String(!!(R.file && R.file.path === f.path)));
      b.addEventListener('click', () => {
        want.file = ref('f');
        R.file = { path: f.path, name: f.name, pending: true };
        F.send({ type: 'cw_replay_file', id: R.id, uuid: cp.uuid, path: f.path, ref: want.file });
        draw(body());
      });
      list.append(b);
    }
    box.append(list);
    const f = R.file;
    if (f) {
      if (f.pending) box.append(el('p', 'rp-wait', t('Reading the file…')));
      else if (f.error) box.append(el('p', 'rp-wait bad', f.error));
      else {
        const note = f.binary ? t('Not a text file.')
          : f.missing_before ? t('It wasn’t there yet: this turn made it.')
          : f.missing_after ? t('This turn removed it.')
          : f.after_is_now ? t('Its change since, to the file as it is now:') : t('Its change in this turn:');
        box.append(el('p', 'rp-meta', note));
        if (f.diff) box.append(diffView(f.diff));
        else if (!f.binary) box.append(el('p', 'rp-wait', t('No change.')));
        if (f.before) { const d = el('details', 'rp-io'); d.append(el('summary', '', t('As it was then')), pre('io', f.before)); box.append(d); }
      }
    }
    return box;
  }

  function actions() {
    const row = el('div', 'rp-actions');
    const fork = el('button', 'jc-btn small', t('Fork from here'));
    fork.type = 'button';
    fork.title = t('A new session with the conversation up to the end of this step’s turn. The files stay as they are now.');
    fork.disabled = R.forking;
    fork.addEventListener('click', () => forkFrom(false));
    row.append(fork);
    if (R.copy) {
      const files = el('button', 'jc-btn small', t('New session with the files as they were'));
      files.type = 'button';
      files.title = t('An isolated copy of the project, with every file this session changed put back as it was at the end of this step’s turn, and a summary of the conversation as your draft.');
      files.disabled = R.forking;
      files.addEventListener('click', () => forkFrom(true));
      row.append(files);
    }
    if (R.forked) row.append(el('span', `rp-meta${R.forkBad ? ' bad' : ''}`, R.forked));
    return row;
  }

  function forkFrom(files) {
    want.fork = ref('k');
    if (!F.send({ type: 'cw_replay_fork', id: R.id, n: R.n, files, ref: want.fork })) return;
    R.forking = true;
    R.forked = '';
    draw(body());
  }

  function scrubber() {
    const bar = el('div', 'rp-bar');
    const back = el('button', 'jc-mini', '‹');
    back.type = 'button';
    back.setAttribute('aria-label', t('Previous step'));
    back.disabled = R.n <= 0;
    back.addEventListener('click', () => { stop(); go(R.n - 1); });
    const next = el('button', 'jc-mini', '›');
    next.type = 'button';
    next.setAttribute('aria-label', t('Next step'));
    next.disabled = R.n >= R.steps.length - 1;
    next.addEventListener('click', () => { stop(); go(R.n + 1); });
    const playBtn = el('button', 'jc-mini rp-play', R.playing ? t('Pause') : t('Play'));
    playBtn.type = 'button';
    playBtn.addEventListener('click', play);
    const range = el('input', 'rp-range');
    range.type = 'range';
    range.min = '0';
    range.max = String(Math.max(0, R.steps.length - 1));
    range.value = String(R.n);
    range.setAttribute('aria-label', t('Step'));
    range.setAttribute('aria-valuetext', position(R.steps, R.n));
    range.addEventListener('input', () => { stop(); go(Number(range.value)); const again = body().querySelector('.rp-range'); if (again) again.focus(); });
    bar.append(back, playBtn, next, range);
    const where = el('p', 'rp-pos', position(R.steps, R.n));
    where.setAttribute('aria-live', 'polite');
    const turns = el('div', 'rp-turns');
    turns.setAttribute('aria-label', t('Turns'));
    for (const turn of turnsOf(R.steps, R.checkpoints)) {
      const b = el('button', `rp-turn${turn.checkpoint ? ' cp' : ''}`, String(turn.number));
      b.type = 'button';
      b.title = turn.checkpoint ? t('Turn with a checkpoint: go to its message') : t('Go to this turn’s message');
      b.setAttribute('aria-current', String(R.steps[R.n] && R.steps[R.n].turn === turn.uuid && !!turn.uuid));
      b.addEventListener('click', () => { stop(); go(turn.n); });
      turns.append(b);
    }
    const box = el('div', 'rp-scrub');
    box.append(bar, where, turns);
    return box;
  }

  function draw(target) {
    if (!target) return;
    const task = F.currentTask();
    if (!task) { target.replaceChildren(el('p', 'jc-empty', t('Open a session to replay it.'))); return; }
    const wrap = el('div', 'rp-root');
    if (task.id !== R.id) {
      const intro = el('p', 'rp-meta', t('Play this session back one step at a time: each message, the thinking, each step and its diff, and the files as they were at each of your messages.'));
      const start = el('button', 'jc-btn', t('Replay this session'));
      start.type = 'button';
      start.addEventListener('click', () => { load(task); draw(target); });
      wrap.append(intro, start);
      target.replaceChildren(wrap);
      return;
    }
    if (R.loading) { target.replaceChildren(el('p', 'jc-empty', t('Reading the session…'))); return; }
    if (R.error) { wrap.append(el('p', 'rp-wait bad', R.error)); }
    if (!R.steps.length) {
      if (!R.error) wrap.append(el('p', 'jc-empty', t('This session has no steps yet.')));
      target.replaceChildren(wrap);
      return;
    }
    const head = R.steps[R.n];
    wrap.append(scrubber(), stepView(head), filesView(checkpointFor(R.steps, R.checkpoints, R.n)), actions());
    target.replaceChildren(wrap);
  }

  F.registerPane('cw-replay', { title: 'Replay', render: (b) => draw(b) });
  if (F.registerMoreItem) F.registerMoreItem({ label: 'Replay the session step by step…', run: () => F.openPane('cw-replay'), when: (task) => !!task });

  F.on('cw_replay', (ev) => {
    if (ev.ref !== R.ref) return;
    R.loading = false;
    R.error = ev.error || '';
    Object.assign(R, { title: ev.title || '', steps: Array.isArray(ev.steps) ? ev.steps : [], checkpoints: Array.isArray(ev.checkpoints) ? ev.checkpoints : [], copy: !!ev.copy, n: 0 });
    ask(0);
    if (shown()) draw(body());
  });
  F.on('cw_replay_step', (ev) => {
    if (ev.ref !== want.step || !ev.step) return;
    R.full.set(ev.step.n, ev.step);
    if (R.full.size > 400) R.full.delete(R.full.keys().next().value);
    if (shown()) draw(body());
  });
  F.on('cw_replay_file', (ev) => {
    if (ev.ref !== want.file || !R.file) return;
    R.file = ev.error ? { path: R.file.path, error: ev.error } : ev;
    if (shown()) draw(body());
  });
  F.on('cw_replay_fork', (ev) => {
    if (ev.ref !== want.fork) return;
    R.forking = false;
    R.forkBad = !!ev.error;
    R.forked = ev.error || t('Started: it’s open in the sidebar.');
    if (shown()) draw(body());
  });
  F.on('hello', () => { R.loading = false; R.forking = false; if (shown()) draw(body()); });

  // ← → step through while the pane has the focus (not while typing).
  if (typeof document !== 'undefined') {
    document.addEventListener('keydown', (e) => {
      if (!shown() || !R.steps.length || e.metaKey || e.ctrlKey || e.altKey) return;
      const pane = F.$('jc-pane');
      const at = document.activeElement;
      // (in a field, the range among them, the keys are the field's own: the range steps itself)
      if (!pane || !at || !pane.contains(at) || /^(INPUT|TEXTAREA|SELECT)$/.test(at.tagName)) return;
      if (e.key === 'ArrowRight') { e.preventDefault(); stop(); go(R.n + 1); }
      else if (e.key === 'ArrowLeft') { e.preventDefault(); stop(); go(R.n - 1); }
    });
  }

  // ── Eden Code settings › General › OpenTelemetry ──
  let url = null;
  let sw = null;
  let line = null;
  let status = null;
  let prompts = false;
  function build() {
    const general = typeof document !== 'undefined' && document.getElementById('jcs-general');
    if (!general || document.getElementById('otel-url')) return;
    const label = el('p', 'jcs-label', t('OpenTelemetry'));
    const group = el('div', 'jcs-group');
    const first = el('label', 'jcs-row otel-row');
    const words = el('span');
    words.append(document.createTextNode(t('Send traces to')),
      el('small', '', t('An OTLP/HTTP collector (http://localhost:4318). Each turn, step, subagent, its tokens and cost. Never file contents, commands or keys. Empty: off.')));
    url = el('input', 'jcs-input');
    url.id = 'otel-url';
    url.spellcheck = false;
    url.placeholder = 'http://localhost:4318';
    url.setAttribute('autocomplete', 'off');
    const save = () => {
      const given = url.value.trim();
      if (!endpointOk(given)) { line.textContent = t(otelLine({ enabled: true, endpoint_ok: false })); return false; }
      F.send({ type: 'feature_prefs', changes: { code_otel_endpoint: given } });
      return true;
    };
    url.addEventListener('change', save);
    first.append(words, url);
    const second = el('div', 'jcs-row');
    const text = el('span');
    text.append(document.createTextNode(t('Include prompts and replies')),
      el('small', '', t('Your messages and Eden’s replies go with each turn, keys and passwords blanked out. Off: only the figures.')));
    sw = el('button', 'jcs-switch');
    sw.type = 'button';
    sw.id = 'otel-prompts';
    sw.setAttribute('role', 'switch');
    sw.setAttribute('aria-label', t('Include prompts and replies'));
    sw.setAttribute('aria-checked', 'false');
    sw.addEventListener('click', () => {
      prompts = !prompts;
      sw.setAttribute('aria-checked', String(prompts));
      F.send({ type: 'feature_prefs', changes: { code_otel_prompts: prompts } });
    });
    second.append(text, sw);
    const third = el('div', 'jcs-row');
    line = el('span', 'otel-line', t(otelLine(status)));
    line.setAttribute('aria-live', 'polite');
    const test = el('button', 'jc-btn small', t('Send a test'));
    test.type = 'button';
    test.addEventListener('click', () => { if (save()) F.send({ type: 'cw_otel_test' }); });
    third.append(line, test);
    group.append(first, second, third);
    const foot = general.querySelector('.jcs-foot');
    if (foot) general.insertBefore(label, foot); else general.append(label);
    general.insertBefore(group, label.nextSibling);
  }
  const take = (features) => {
    const f = features || {};
    const kept = typeof f.code_otel_endpoint === 'string' ? f.code_otel_endpoint : '';
    if (url && document.activeElement !== url) url.value = kept;
    prompts = f.code_otel_prompts === true;
    if (sw) sw.setAttribute('aria-checked', String(prompts));
    status = Object.assign({}, status || {}, { enabled: !!kept, endpoint_ok: true });
    if (line) line.textContent = t(otelLine(status));
  };
  build();
  F.on('prefs', (ev) => take(ev.features), { replay: true });
  F.on('hello', (ev) => { take(ev.prefs && ev.prefs.features); F.send({ type: 'cw_otel_status' }); }, { replay: true });
  F.on('code_otel', (ev) => {
    status = ev;
    if (!line) return;
    let words = t(otelLine(ev));
    if (ev.tested === true) words = `${t('Test sent.')} ${words}`;
    else if (ev.tested === false && ev.error) words = ev.error;
    line.textContent = words;
  });
})(typeof window === 'object' ? window : globalThis);
