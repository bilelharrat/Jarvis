// Eden Code waiting out Claude's usage limit (features/code_limit.py): the setting (switch
// to the fallback model, or wait for the limit to reset) in Eden Code settings › While it
// works, and, for a session that's waiting, a countdown in its header with Try now and Use
// the fallback. Its queued messages show in the queue as usual: they wait with it.
(() => {
  const F = window.jarvisFeatures;
  if (!F) return;
  const { el, send, t } = F;
  const state = { features: {}, tasks: [] };
  let ticker = 0;

  // ── the setting ──

  const pick = el('select', 'jcs-select');
  pick.id = 'jcx-limit-wait';
  pick.setAttribute('aria-label', 'When Claude’s usage limit is reached');
  for (const [value, label] of [['fallback', 'Switch to the fallback model'], ['wait', 'Wait for it to reset']]) {
    const o = el('option', '', label);
    o.value = value;
    pick.append(o);
  }
  pick.addEventListener('change', () => send({ type: 'feature_prefs', changes: { code_limit_wait: pick.value === 'wait' } }));
  (function addSetting() {
    const queue = document.getElementById('jcs-queue');
    const group = queue && queue.closest('.jcs-group');
    if (!group) return;
    const row = el('label', 'jcs-row');
    const text = el('span');
    text.append(document.createTextNode(t('When Claude’s usage limit is reached')),
      el('small', '', 'Waiting holds the session and anything you send it, then carries on on Claude when the limit resets.'));
    row.append(text, pick);
    group.append(row);
  })();
  const drawSetting = () => { pick.value = state.features.code_limit_wait ? 'wait' : 'fallback'; };

  // ── the header's countdown ──

  const bar = el('div', 'jcx-limit');
  bar.hidden = true;
  const words = el('span', 'jcx-limit-words');
  const left = el('span', 'jcx-limit-left');
  left.dataset.noI18n = '';
  const now = el('button', 'jcx-limit-btn', 'Try now');
  now.type = 'button';
  now.title = t('Sends it to Claude again now; if the limit is still there, it waits again');
  const fallback = el('button', 'jcx-limit-btn', 'Use the fallback');
  fallback.type = 'button';
  fallback.title = t('Moves the session to the fallback model, which carries on from here');
  bar.append(el('span', 'jcx-limit-dot'), words, left, now, fallback);

  function held() {
    const task = F.currentTask();
    if (!task) return null;
    const fresh = state.tasks.find((x) => x.id === task.id) || task;
    return fresh.hold_until && fresh.hold_until * 1000 > Date.now() ? fresh : null;
  }

  function clock(seconds) {
    const s = Math.max(0, Math.round(seconds));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const pad = (n) => String(n).padStart(2, '0');
    return h ? `${h}:${pad(m)}:${pad(s % 60)}` : `${m}:${pad(s % 60)}`;
  }

  function draw() {
    const titles = document.querySelector('.jc-titles');
    if (titles && !bar.isConnected) titles.append(bar);
    const task = held();
    bar.hidden = !task;
    if (!task) {
      if (ticker) { clearInterval(ticker); ticker = 0; }
      return;
    }
    const until = new Date(task.hold_until * 1000);
    const today = until.toDateString() === new Date().toDateString();  // a weekly limit: its day too
    const at = today ? until.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
      : until.toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' });
    words.textContent = t(`Waiting for Claude’s limit to reset at ${at}`);
    left.textContent = clock(task.hold_until - Date.now() / 1000);
    now.onclick = () => send({ type: 'code_limit', id: task.id, action: 'now' });
    fallback.onclick = () => send({ type: 'code_limit', id: task.id, action: 'fallback' });
    if (!ticker) ticker = setInterval(draw, 1000);
  }

  const title = document.getElementById('jc-title');
  if (title) new MutationObserver(draw).observe(title, { childList: true, characterData: true, subtree: true });

  // ── events ──

  function prefsFrom(prefs) {
    if (prefs && prefs.features) state.features = prefs.features;
    drawSetting();
  }
  F.on('hello', (ev) => { state.tasks = ev.tasks || []; prefsFrom(ev.prefs); draw(); }, { replay: true });
  F.on('prefs', (ev) => prefsFrom(ev), { replay: true });
  F.on('tasks', (ev) => { state.tasks = ev.items || []; draw(); }, { replay: true });
  drawSetting();
  draw();
})();
