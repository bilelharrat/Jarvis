// Eden's own voice in Eden Code, the window's side (features/code_voice_live.py):
// - the title bar's Voice switch turns Eden's ears and voice on and off (Eden Code's own window
//   only; inside Eden Secretary it stays the voice-focus switch it was). The app asks for the
//   microphone first (window.jarvisApp.microphone: the macOS prompt is the app's, never at
//   launch);
// - the switch becomes a live indicator in the glass look: listening, thinking, speaking, or
//   ready (push-to-talk), glowing while Eden's ears are on;
// - push-to-talk: hold the right Option key (⌥) and talk, let go to send it to the session in
//   front. It stays out of the way of typing: another key pressed while it's held means the
//   ⌥ was for a character, and nothing is recorded or sent;
// - voice follows the session in front while it's on;
// - Settings › Voice: Eden's voice in Eden Code, hands-free conversation or push-to-talk only,
//   the wake word "Eden", and which voice Eden speaks with (the same picker as Eden Secretary's
//   Settings › Speaking: features/voice.py's voice_settings).
// The composer and its Dictate mic are left as they are; Dictate only gets the app's
// microphone prompt before its first use.
// Cost policy: no model calls; window-only state and the backend's switches.
// Pure helpers are exported for node --test (tests/web/code-voice-live.test.mjs).
(function (root) {
  'use strict';

  const HOLD_MS = 180; // ⌥ held this long, alone, before the microphone opens
  const PTT_LABEL = 'right ⌥';

  // What the indicator shows: 'off', 'ready' (ears on, push-to-talk), 'listening', 'thinking'
  // or 'speaking'. live: the backend's code_voice_live; hub: its state ('idle', 'listening',
  // 'transcribing', 'thinking', 'speaking'); focus: voicecode's focus ({busy}) or null.
  function voiceState(live, hub, focus) {
    if (!live || !live.active) return 'off';
    if (hub === 'speaking') return 'speaking';
    if (hub === 'listening' || hub === 'transcribing') return 'listening';
    if (hub === 'thinking' || (focus && focus.busy)) return 'thinking';
    return live.listening ? 'listening' : 'ready';
  }

  const STATE_WORDS = {
    off: 'Voice off',
    ready: 'Voice',
    listening: 'Listening',
    thinking: 'Thinking',
    speaking: 'Speaking',
  };

  // The switch's words: the state, then the session's folder when there is one.
  function pillLabel(state, folder) {
    const word = STATE_WORDS[state] || STATE_WORDS.off;
    return state !== 'off' && folder ? `${word} · ${folder}` : word;
  }

  // What the switch says to a screen reader (its title too): the state and how to talk.
  function pillHelp(state, live) {
    if (state === 'off') return 'Turn on Eden’s voice in Eden Code';
    const how = live && live.hands_free === false
      ? `Hold ${PTT_LABEL} to talk`
      : live && live.wake ? 'Say “Eden” and talk' : `Just talk, or hold ${PTT_LABEL}`;
    return `${STATE_WORDS[state]}. ${how}. Click to turn Eden’s voice off.`;
  }

  const isPttKey = (ev) => ev.code === 'AltRight' && !ev.metaKey && !ev.ctrlKey && !ev.shiftKey;

  // Hold to talk as a small machine, so it can be tested without a keyboard: keyDown(ev) and
  // keyUp(ev) as they arrive, tick() when HOLD_MS has passed. send({down}) opens and closes
  // the microphone. Another key while ⌥ is held cancels a press that hasn't opened yet (that
  // ⌥ was for a character), and closes one that has (a chord, not talk).
  function createPtt({ send, schedule = (fn, ms) => setTimeout(fn, ms), cancel = (t) => clearTimeout(t) }) {
    let held = false;
    let open = false;
    let timer = null;
    const stopTimer = () => { if (timer !== null) { cancel(timer); timer = null; } };
    function close() {
      stopTimer();
      held = false;
      if (open) { open = false; send({ down: false }); }
    }
    return {
      keyDown(ev) {
        if (isPttKey(ev)) {
          if (held || ev.repeat) return true;
          held = true;
          timer = schedule(() => { timer = null; if (held) { open = true; send({ down: true }); } }, HOLD_MS);
          return true;
        }
        if (held) close();
        return false;
      },
      keyUp(ev) {
        if (ev.code !== 'AltRight') return false;
        if (!held && !open) return false;
        close();
        return true;
      },
      blur: close,
      get open() { return open; },
      get held() { return held; },
    };
  }

  // A microphone answer from the app that means Eden can listen.
  const micAllowed = (status) => status === undefined || status === null || status === 'granted' || status === 'not-determined';

  const api = { voiceState, pillLabel, pillHelp, isPttKey, createPtt, micAllowed, HOLD_MS, STATE_WORDS };
  if (typeof module === 'object' && module.exports) { module.exports = api; return; }

  const F = root.jarvisFeatures;
  if (!F) return;
  const inCode = typeof inEdenCode !== 'undefined' && inEdenCode;
  if (!inCode || F.splitPane) return; // Eden Secretary keeps its own voice; the split's pane has no title bar
  const { el, t } = F;
  const doc = document;

  let live = null; // code_voice_live
  let hubState = 'idle';
  let focus = null; // voicecode focus
  let micAsked = false;
  // Settings › Voice is built further down; the replayed hello/prefs above it arrive while this
  // file is still running, before its rows exist (a ReferenceError on every start, once).
  let settingsReady = false;

  async function microphone() {
    const app = root.jarvisApp;
    if (!app || typeof app.microphone !== 'function') return true; // a browser tab: the page can't ask
    let status = null;
    try { status = await app.microphone(); } catch (_) { status = null; }
    micAsked = true;
    if (micAllowed(status)) return true;
    if (typeof notice === 'function') {
      notice(t('Voice'), t('Eden Code can’t use the microphone'), t('Allow Eden Code in System Settings › Privacy & Security › Microphone, then turn Voice on again.'), 9000);
    }
    return false;
  }

  const shown = () => (typeof ccSelected !== 'undefined' ? ccSelected : null);

  async function toggle() {
    if (live && live.active) { F.send({ type: 'code_voice_live', on: false }); return; }
    if (!(await microphone())) return;
    const id = shown();
    F.send(id ? { type: 'code_voice_live', on: true, id } : { type: 'code_voice_live', on: true });
  }
  root.edenCodeVoice = { toggle, state: () => voiceState(live, hubState, focus) };

  function render() {
    const btn = F.$('cc-voice-head');
    if (!btn) return;
    const state = voiceState(live, hubState, focus);
    const folder = focus && focus.folder ? focus.folder : '';
    btn.dataset.voiceState = state;
    btn.setAttribute('aria-pressed', String(state !== 'off'));
    const help = t(pillHelp(state, live));
    btn.title = help;
    btn.setAttribute('aria-description', help);
    const label = F.$('cc-voice-label');
    if (label) label.textContent = folder && state !== 'off' ? `${t(STATE_WORDS[state])} · ${folder}` : t(pillLabel(state, ''));
    drawSettings();
  }

  F.on('code_voice_live', (ev) => { live = ev; render(); followShown(); }, { replay: true });
  F.on('state', (ev) => { hubState = ev.value || 'idle'; render(); });
  F.on('voicecode', (ev) => { focus = ev.focus || null; render(); });
  F.on('hello', (ev) => {
    hubState = ev.state || 'idle';
    focus = ev.voicecode || null;
    F.send({ type: 'code_voice_live_status' });
    render();
  }, { replay: true });

  // Voice follows the session in front while it's on: what's said goes to the one you see.
  function followShown() {
    const id = shown();
    if (live && live.active && id && (!focus || focus.id !== id)) F.send({ type: 'voicecode_enter', id });
  }
  F.on('jc_select', () => setTimeout(followShown, 0));

  // ── hold right ⌥ to talk ──
  const ptt = createPtt({
    send: async ({ down }) => {
      if (down && !micAsked && !(await microphone())) return;
      F.send(down ? { type: 'code_voice_ptt', down: true, id: shown() || 0 } : { type: 'code_voice_ptt', down: false });
    },
  });
  root.addEventListener('keydown', (ev) => { ptt.keyDown(ev); }, true);
  root.addEventListener('keyup', (ev) => { if (ptt.keyUp(ev)) ev.preventDefault(); }, true);
  root.addEventListener('blur', () => ptt.blur());

  // ── Dictate: the app's microphone prompt before its first use (the button is untouched) ──
  const dictate = F.$('jc-dictate');
  if (dictate) {
    dictate.addEventListener('click', (ev) => {
      if (micAsked || !root.jarvisApp || typeof root.jarvisApp.microphone !== 'function') return;
      ev.stopImmediatePropagation();
      microphone().then((ok) => { if (ok) dictate.click(); });
    }, true);
  }

  // ── a spoken change being walked through: the Changes pane shows it ──
  F.on('code_voice_change', (ev) => {
    if (ev.id === shown() && typeof F.openPane === 'function') F.openPane('diff');
  });

  // ── Settings › Voice: Eden's voice in Eden Code ──
  let features = {};
  let voice = null; // features/voice.py's "voice" event (Settings › Speaking)
  const took = (p) => { if (p && p.features) { features = p.features; drawSettings(); } };
  F.on('hello', (ev) => took(ev.prefs), { replay: true });
  F.on('prefs', took, { replay: true });
  F.on('voice', (ev) => { voice = ev; drawSettings(); }, { replay: true });

  function switchRow(id, label, note, onClick) {
    const row = el('div', 'jcs-row');
    const text = el('span');
    text.append(doc.createTextNode(t(label)), el('small', '', t(note)));
    const sw = el('button', 'jcs-switch');
    sw.type = 'button';
    sw.id = id;
    sw.setAttribute('role', 'switch');
    sw.setAttribute('aria-label', t(label));
    sw.setAttribute('aria-checked', 'false');
    sw.addEventListener('click', onClick);
    row.append(text, sw);
    return row;
  }
  const setFeature = (changes) => F.send({ type: 'feature_prefs', changes });
  const PROVIDERS = [['jarvis', 'Eden (cloud)'], ['local', 'On this Mac (offline)'], ['say', 'Mac voice'], ['elevenlabs', 'ElevenLabs'], ['fish', 'Fish Audio']];
  const provider = el('select', 'jcs-select');
  provider.id = 'ecv-provider';
  provider.setAttribute('aria-label', t('Eden’s voice'));
  for (const [v, l] of PROVIDERS) { const o = el('option', '', t(l)); o.value = v; provider.append(o); }
  provider.addEventListener('change', () => F.send({ type: 'voice_settings', changes: { voice_provider: provider.value } }));
  const localPick = el('select', 'jcs-select');
  localPick.id = 'ecv-local';
  localPick.setAttribute('aria-label', t('Voice on this Mac'));
  localPick.addEventListener('change', () => F.send({ type: 'voice_settings', changes: { voice_local: localPick.value } }));
  const voiceRow = el('label', 'jcs-row');
  const voiceText = el('span');
  voiceText.append(doc.createTextNode(t('Eden’s voice')), el('small', '', t('The voice Eden speaks with, here and in Eden Secretary (Settings › Speaking there has the rest)')));
  const picks = el('span', 'ecv-picks');
  picks.append(provider, localPick);
  voiceRow.append(voiceText, picks);

  const rows = el('div', 'ecv-rows');
  rows.append(
    switchRow('ecv-on', 'Eden’s voice in Eden Code', 'Eden listens and speaks while you code: replies, progress and reviews out loud. The microphone opens only while this is on',
      () => toggle()),
    switchRow('ecv-hands-free', 'Hands-free conversation', `Off: the microphone opens only while you hold ${PTT_LABEL}`,
      () => setFeature({ code_voice_hands_free: features.code_voice_hands_free === false })),
    switchRow('ecv-wake', 'Wake word “Eden”', 'Say “Eden” or “Hey Eden” first. Off, everything you say goes to the session in front; on, Eden Secretary and Eden Code don’t both answer',
      () => setFeature({ code_voice_wake: features.code_voice_wake !== true })),
    voiceRow,
  );
  const help = el('p', 'jcs-note ecv-help', t(`Say “read me the changes”, then “next change”, “keep it” or “undo it”. “Stop”, “approve” and “what changed” work too. Hold ${PTT_LABEL} to talk at any time.`));
  rows.append(help);

  function place() {
    const group = doc.getElementById('ecs-voice');
    if (!group || rows.parentNode === group) return Boolean(group);
    group.prepend(rows);
    return true;
  }

  function drawSettings() {
    if (!settingsReady || !place()) return;
    const set = (id, on) => { const n = doc.getElementById(id); if (n) n.setAttribute('aria-checked', String(Boolean(on))); };
    set('ecv-on', live && live.active);
    set('ecv-hands-free', features.code_voice_hands_free !== false);
    set('ecv-wake', features.code_voice_wake === true);
    if (voice) {
      provider.value = voice.provider || 'jarvis';
      const local = voice.local || {};
      const list = local.voices || [];
      if (localPick.options.length !== list.length) {
        localPick.replaceChildren(...list.map((v) => { const o = el('option', '', v.name); o.value = v.id; return o; }));
      }
      localPick.value = local.voice || (list[0] && list[0].id) || '';
      localPick.hidden = provider.value !== 'local' || !list.length;
    } else {
      localPick.hidden = true;
    }
  }
  // Settings opened: what the voice is now (Eden Secretary's Speaking pane asks the same way).
  const sheet = F.$('jc-settings');
  if (sheet) {
    new MutationObserver(() => { if (!sheet.hidden) { place(); F.send({ type: 'voice_status' }); drawSettings(); } })
      .observe(sheet, { attributes: true, attributeFilter: ['hidden'] });
  }
  settingsReady = true;
  place();
  render();
})(typeof window === 'object' ? window : globalThis);
