// Settings › Listening: how hands-free tells your voice from other sounds (features/voice.py).
// The hub sends the pane's state as a "voice" event; changes go back as voice_settings.
(() => {
  const F = window.jarvisFeatures;
  if (!F) return;
  const { el, send } = F;

  let state = null;  // the latest "voice" event

  function radio(label, value, group, pick) {
    const b = el('button', '', label);
    b.type = 'button';
    b.setAttribute('role', 'radio');
    b.dataset[group] = value;
    b.addEventListener('click', () => pick(value));
    return b;
  }

  function change(changes) {
    send({ type: 'voice_settings', changes });
  }

  // ── the Listening group, placed right after Settings' Voice group ──

  const listening = el('section', 'group voice-group');
  listening.id = 'voice-listening';
  listening.append(el('h3', '', 'Listening'));

  const detectorRow = el('div', 'row stack');
  const detectorLabel = el('span');
  detectorLabel.append(el('strong', '', 'Voice detection'), el('small', '', 'How hands-free tells your voice from other sounds'));
  detectorRow.append(detectorLabel);
  const detector = el('div', 'segmented');
  detector.id = 'voice-detector';
  detector.setAttribute('role', 'radiogroup');
  detector.setAttribute('aria-label', 'Voice detection');
  detector.append(
    radio('Neural', 'neural', 'detector', (v) => change({ voice_detector: v })),
    radio('Loudness', 'energy', 'detector', (v) => change({ voice_detector: v })),
  );
  const detectorNote = el('p', 'small-status');
  detectorNote.id = 'voice-detector-note';

  const sensitivity = el('label', 'row stack');
  sensitivity.htmlFor = 'voice-sensitivity';
  const sensitivityHead = el('span');
  const sensitivityOut = el('output');
  sensitivityOut.id = 'voice-sensitivity-out';
  sensitivityHead.append(el('strong', '', 'Sensitivity'), sensitivityOut);
  const slider = el('input');
  slider.type = 'range';
  slider.id = 'voice-sensitivity';
  // Higher is more sensitive: the model's threshold is 1 - value.
  slider.min = '10';
  slider.max = '80';
  slider.step = '5';
  slider.addEventListener('input', () => { sensitivityOut.textContent = sensitivityWord(Number(slider.value)); });
  slider.addEventListener('change', () => change({ voice_vad_threshold: Math.round(100 - Number(slider.value)) / 100 }));
  sensitivity.append(sensitivityHead, slider);

  listening.append(detectorRow, detector, detectorNote, sensitivity);

  function sensitivityWord(value) {
    if (value >= 60) return 'Hears quieter voices';
    if (value <= 40) return 'Only clear speech';
    return 'Normal';
  }

  function place() {
    const settings = F.$('settings');
    if (!settings || listening.isConnected) return;
    const voiceGroup = F.$('sw-voice') && F.$('sw-voice').closest('section.group');
    if (voiceGroup) voiceGroup.after(listening);
    else settings.append(listening);
  }

  function render() {
    if (!state) return;
    const kind = state.detector === 'energy' ? 'energy' : 'neural';
    detector.querySelectorAll('button').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.detector === kind)));
    const threshold = typeof state.threshold === 'number' ? state.threshold : 0.5;
    if (document.activeElement !== slider) {
      slider.value = String(Math.round((1 - threshold) * 100));
      sensitivityOut.textContent = sensitivityWord(Number(slider.value));
    }
    sensitivity.hidden = kind !== 'neural' || state.neural_ok === false;
    let note;
    if (kind === 'energy') note = 'Loudness decides: any loud sound can start listening.';
    else if (state.neural_ok === false) note = 'The neural detector couldn’t load here, so loudness decides.';
    else note = 'A neural model tells speech from noise: doors, typing and fans don’t start a request.';
    detectorNote.textContent = note;
    detectorNote.title = state.neural_why || '';
  }

  place();
  F.on('voice', (ev) => { state = ev; place(); render(); }, { replay: true });
  // A new connection (or backend) sends its own hello: ask for the pane's state again.
  F.on('hello', () => send({ type: 'voice_status' }), { replay: true });
})();
