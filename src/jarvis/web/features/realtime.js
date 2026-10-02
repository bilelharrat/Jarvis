// Settings › Listening › Realtime conversation (features/realtime.py): a natural spoken
// back-and-forth through OpenAI Realtime or Gemini Live, on the owner's own key. State comes
// as a "realtime" event; changes go back as realtime_settings. On the orb: a long press
// starts one (realtime_start), a tap while one runs ends it (realtime_stop), and a ring
// shows it's on.
(() => {
  const F = window.jarvisFeatures;
  if (!F) return;
  const { el, send } = F;

  const LONG_PRESS = 600;  // ms
  let state = null;

  function change(changes) {
    send({ type: 'realtime_settings', changes });
  }

  const block = el('div', 'realtime');
  block.id = 'realtime';

  const head = el('div', 'row');
  const label = el('span');
  label.append(el('strong', '', 'Realtime conversation'), el('small', '', 'Talk back and forth naturally; replies start in about a second'));
  const toggle = el('button', 'switch');
  toggle.type = 'button';
  toggle.id = 'realtime-switch';
  toggle.setAttribute('role', 'switch');
  toggle.setAttribute('aria-label', 'Realtime conversation');
  toggle.addEventListener('click', () => change({ realtime_on: !(state && state.on) }));
  head.append(label, toggle);

  const provider = el('div', 'segmented');
  provider.id = 'realtime-provider';
  provider.setAttribute('role', 'radiogroup');
  provider.setAttribute('aria-label', 'Realtime voice provider');
  for (const [value, text] of [['auto', 'Automatic'], ['openai', 'OpenAI'], ['gemini', 'Gemini']]) {
    const b = el('button', '', text);
    b.type = 'button';
    b.setAttribute('role', 'radio');
    b.dataset.provider = value;
    b.addEventListener('click', () => change({ realtime_provider: value }));
    provider.append(b);
  }

  const voice = el('div', 'segmented');
  voice.id = 'realtime-voice';
  voice.setAttribute('role', 'radiogroup');
  voice.setAttribute('aria-label', 'Realtime voice');
  for (const [value, text] of [['jarvis', 'Jarvis’s voice'], ['model', 'The model’s voice (fastest)']]) {
    const b = el('button', '', text);
    b.type = 'button';
    b.setAttribute('role', 'radio');
    b.dataset.voice = value;
    b.addEventListener('click', () => change({ realtime_voice: value }));
    voice.append(b);
  }

  const minutesRow = el('label', 'row realtime-minutes');
  minutesRow.htmlFor = 'realtime-minutes';
  const minutesLabel = el('span');
  const used = el('small');
  used.id = 'realtime-used';
  minutesLabel.append(el('strong', '', 'Minutes a day'), used);
  const minutes = el('input');
  minutes.type = 'number';
  minutes.id = 'realtime-minutes';
  minutes.min = '1';
  minutes.max = '240';
  minutes.step = '1';
  minutes.inputMode = 'numeric';
  minutes.setAttribute('aria-label', 'Minutes a day');
  minutes.addEventListener('change', () => {
    const n = Math.round(Number(minutes.value));
    if (n >= 1 && n <= 240) change({ realtime_minutes: n });
    else if (state) minutes.value = String(state.minutes);
  });
  minutesRow.append(minutesLabel, minutes);

  const how = el('p', 'small-status');
  how.id = 'realtime-how';
  const cost = el('p', 'small-status');
  cost.id = 'realtime-cost';
  const talkOver = el('p', 'small-status');
  talkOver.id = 'realtime-talk-over';
  const why = el('p', 'small-status realtime-why');
  why.id = 'realtime-why';
  why.setAttribute('role', 'status');

  block.append(head, provider, voice, minutesRow, how, cost, talkOver, why);

  function place() {
    if (block.isConnected) return;
    const listening = F.$('voice-listening');
    if (listening) listening.append(block);
  }

  function render() {
    if (!state) return;
    const on = !!state.on;
    toggle.setAttribute('aria-checked', String(on));
    provider.hidden = minutesRow.hidden = how.hidden = cost.hidden = !on;
    voice.hidden = !on || !state.jarvis_voice;
    voice.querySelectorAll('button').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.voice === (state.voice || 'jarvis'))));
    provider.querySelectorAll('button').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.provider === state.provider)));
    if (document.activeElement !== minutes) minutes.value = String(state.minutes);
    used.textContent = `${state.used} of ${state.minutes} minutes used today`;
    how.textContent = 'Say “Jarvis” or hold the orb to start. It ends after 20 seconds of quiet, when you say “that’s all”, or when you tap the orb. Claude still does the work, with every approval.';
    cost.textContent = 'Billed per minute to your own OpenAI or Google key from Settings › Models: roughly $0.02–0.10 a minute with OpenAI, less with Gemini.';
    talkOver.hidden = !on || !!state.talk_over;
    talkOver.textContent = 'Turn on Talk over Jarvis to interrupt it while it speaks.';
    why.textContent = state.why || '';
    why.hidden = !on || !state.why;
    if (state.active) document.body.dataset.realtime = 'on';
    else delete document.body.dataset.realtime;
    showLine();
  }

  // The state line under the orb says a conversation is on, and how to end it.
  function showLine() {
    if (!state || !state.active) return;
    const line = F.$('state-line');
    if (line) line.textContent = state.state === 'speaking' ? 'Realtime · talk over me or tap the orb to end' : 'Realtime conversation · tap the orb to end';
  }

  // ── the orb: hold to start, tap to end ──

  const orb = F.$('orb');
  let pressTimer = null;
  let swallowClick = false;
  if (orb) {
    orb.addEventListener('pointerdown', () => {
      clearTimeout(pressTimer);
      if (!state || !state.on || state.active) return;
      pressTimer = setTimeout(() => {
        pressTimer = null;
        swallowClick = true;  // the click that ends this press isn't a tap
        send({ type: 'realtime_start' });
      }, LONG_PRESS);
    });
    for (const type of ['pointerup', 'pointerleave', 'pointercancel']) {
      orb.addEventListener(type, () => { clearTimeout(pressTimer); pressTimer = null; });
    }
    orb.addEventListener('click', (e) => {
      if (swallowClick) {
        swallowClick = false;
        e.stopImmediatePropagation();
        return;
      }
      if (state && state.active) {
        e.stopImmediatePropagation();
        send({ type: 'realtime_stop' });
      }
    }, true);
  }

  F.on('realtime', (ev) => { state = ev; place(); render(); }, { replay: true });
  F.on('voice', () => { place(); }, { replay: true });
  F.on('state', () => showLine());
  F.on('hello', () => send({ type: 'realtime_status' }), { replay: true });
})();
