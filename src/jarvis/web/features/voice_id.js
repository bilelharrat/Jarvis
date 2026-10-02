// Settings › Listening › Recognise my voice (features/voice_id.py): Jarvis learns the
// owner's voice from five sentences and then answers only them, or asks for their voice
// before risky steps. State comes as a "voice_id" event; changes go back as
// voice_id_settings, voice_id_download, voice_id_enroll and voice_id_forget.
(() => {
  const F = window.jarvisFeatures;
  if (!F) return;
  const { el, send } = F;

  // What the owner reads to teach Jarvis their voice (Chinese in i18n/voice_id.json).
  const SENTENCES = [
    'The quick brown fox jumps over the lazy dog.',
    'Jarvis, what’s on my calendar tomorrow morning?',
    'Please remind me to call the office at half past four.',
    'Seven sunny summer days are better than one rainy week.',
    'Open the report and read me the first paragraph.',
  ];

  window.jarvisVoiceId = { SENTENCES }; // the intro's "Only answer my voice" card reads them too

  let state = null;

  function button(label, id, run, cls = 'btn') {
    const b = el('button', cls, label);
    b.type = 'button';
    b.id = id;
    b.addEventListener('click', run);
    return b;
  }

  const block = el('div', 'voice-id');
  block.id = 'voice-id';

  const head = el('div', 'row');
  const label = el('span');
  label.append(el('strong', '', 'Recognise my voice'), el('small', '', 'Jarvis learns your voice and checks it in hands-free'));
  const toggle = button('', 'voice-id-switch', () => send({ type: 'voice_id_settings', changes: { voice_id_on: !(state && state.on) } }), 'switch');
  toggle.setAttribute('role', 'switch');
  toggle.setAttribute('aria-label', 'Recognise my voice');
  head.append(label, toggle);

  const scope = el('div', 'segmented');
  scope.id = 'voice-id-scope';
  scope.setAttribute('role', 'radiogroup');
  scope.setAttribute('aria-label', 'Whose voice Jarvis answers');
  for (const [value, text] of [['all', 'Everything'], ['risky', 'Only risky actions']]) {
    const b = button(text, `voice-id-scope-${value}`, () => send({ type: 'voice_id_settings', changes: { voice_id_scope: value } }), '');
    b.setAttribute('role', 'radio');
    b.dataset.scope = value;
    scope.append(b);
  }
  const scopeNote = el('p', 'small-status');
  scopeNote.id = 'voice-id-scope-note';

  const why = el('p', 'small-status');
  why.id = 'voice-id-why';
  const model = el('div', 'row voice-id-model');
  const modelNote = el('small');
  modelNote.id = 'voice-id-size';
  const download = button('Download', 'voice-id-download', () => { download.disabled = true; send({ type: 'voice_id_download' }); });
  model.append(modelNote, download);
  const progress = el('progress');
  progress.id = 'voice-id-progress';
  progress.max = 1;

  // Enrollment: the sentence to read, one at a time.
  const teach = el('div', 'voice-id-teach');
  teach.id = 'voice-id-teach';
  const teachNote = el('p', 'small-status');
  teachNote.id = 'voice-id-teach-note';
  const sentence = el('p', 'voice-id-sentence');
  sentence.id = 'voice-id-sentence';
  const actions = el('div', 'row voice-id-actions');
  const start = button('Teach Jarvis your voice', 'voice-id-start', () => { start.disabled = true; send({ type: 'voice_id_enroll', action: 'start' }); });
  const cancel = button('Cancel', 'voice-id-cancel', () => send({ type: 'voice_id_enroll', action: 'cancel' }));
  const forget = button('Forget my voice', 'voice-id-forget', () => send({ type: 'voice_id_forget' }));
  actions.append(start, cancel, forget);
  teach.append(teachNote, sentence, actions);

  const error = el('p', 'small-status voice-id-error');
  error.id = 'voice-id-error';
  error.setAttribute('role', 'alert');

  block.append(head, scope, scopeNote, why, model, progress, teach, error);

  function place() {
    if (block.isConnected) return;
    const listening = F.$('voice-listening');
    if (listening) listening.append(block);
  }

  function render() {
    if (!state) return;
    const on = !!state.on;
    toggle.setAttribute('aria-checked', String(on));
    scope.hidden = scopeNote.hidden = !on;
    scope.querySelectorAll('button').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.scope === state.scope)));
    scopeNote.textContent = state.scope === 'all'
      ? 'Anyone else is ignored. Tapping the orb, ⌥Space and typing are never checked.'
      : 'Anyone can ask questions; approvals, sends, purchases, deletes and Jarvis Code approvals by voice need yours.';
    why.textContent = state.why || '';
    why.hidden = !state.why;

    const dl = state.downloading;
    const needsModel = on && state.configured && !state.model;
    model.hidden = !needsModel || !!dl;
    if (state.size > 0) modelNote.textContent = `The voice model is ${(state.size / 1e6).toFixed(1)} MB and stays on this Mac.`;
    download.disabled = false;
    progress.hidden = !dl;
    if (dl) progress.value = dl.total > 0 ? Math.min(1, dl.done / dl.total) : 0;

    const enrolling = state.enrolling;
    teach.hidden = !(on && state.model);
    sentence.hidden = !enrolling;
    cancel.hidden = !enrolling;
    start.hidden = forget.hidden = !!enrolling;
    forget.hidden = forget.hidden || !state.enrolled;
    start.disabled = false;
    start.textContent = state.enrolled ? 'Retrain' : 'Teach Jarvis your voice';
    if (enrolling) {
      const n = enrolling.index + 1;
      teachNote.textContent = enrolling.again
        ? `I didn’t catch that. Read sentence ${n} of ${SENTENCES.length} again:`
        : `Read sentence ${n} of ${SENTENCES.length} aloud:`;
      sentence.textContent = SENTENCES[enrolling.index] || '';
    } else {
      teachNote.textContent = state.enrolled
        ? 'Jarvis knows your voice.'
        : 'Read five short sentences aloud, in a quiet room. Your voiceprint stays on this Mac.';
    }
    error.textContent = state.error || '';
    error.hidden = !state.error;
  }

  F.on('voice_id', (ev) => { state = ev; place(); render(); }, { replay: true });
  F.on('voice', () => { place(); }, { replay: true });
  F.on('hello', () => send({ type: 'voice_id_status' }), { replay: true });
})();
