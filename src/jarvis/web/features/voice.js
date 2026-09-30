// Settings › Speaking and Listening (features/voice.py): the voice Jarvis speaks with, how
// hands-free tells your voice from other sounds, and the wake words. The hub sends the
// panes' state as a "voice" event; changes go back as voice_settings (and voice_list,
// voice_preview, voice_key and voice_key_forget for the buttons).
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

  const PROVIDERS = [['say', 'Mac'], ['elevenlabs', 'ElevenLabs'], ['fish', 'Fish Audio']];
  const NAMES = Object.fromEntries(PROVIDERS);

  // A stacked Settings row: its label and note, then the control under them.
  function row(label, note, control) {
    const r = el('div', 'row stack');
    const text = el('span');
    text.append(el('strong', '', label));
    if (note) text.append(note instanceof Node ? note : el('small', '', note));
    r.append(text);
    if (control) {
      if (control.matches('select, input')) control.setAttribute('aria-label', label);
      r.append(control);
    }
    return r;
  }

  // ── the Speaking group, placed right before Settings' Voice group ──

  const speaking = el('section', 'group voice-group');
  speaking.id = 'voice-speaking';
  speaking.append(el('h3', '', 'Speaking'));

  const provider = el('div', 'segmented');
  provider.id = 'voice-provider';
  provider.setAttribute('role', 'radiogroup');
  provider.setAttribute('aria-label', 'Voice provider');
  provider.append(...PROVIDERS.map(([id, name]) => {
    const b = radio(name, id, 'provider', (v) => change({ voice_provider: v }));
    b.setAttribute('data-no-i18n', '');
    return b;
  }));
  const providerNote = el('p', 'small-status');
  providerNote.id = 'voice-provider-note';
  const useEnv = el('button', 'btn', 'Use my .env settings');
  useEnv.type = 'button';
  useEnv.id = 'voice-use-env';
  useEnv.addEventListener('click', () => change({ voice_provider: '' }));

  // The Mac voice, for the language Jarvis speaks now.
  const macSelect = el('select');
  macSelect.id = 'voice-mac-select';
  macSelect.addEventListener('change', () => change({ voice_mac: macSelect.value }));
  const macRow = row('Voice', 'Enhanced and Premium voices sound most natural. Add them in System Settings › Accessibility › Spoken Content.', macSelect);

  // A cloud voice: listed from the account, or pasted by id.
  const cloudSelect = el('select');
  cloudSelect.id = 'voice-cloud-select';
  cloudSelect.addEventListener('change', () => {
    const picked = cloudSelect.selectedOptions[0];
    if (picked && picked.value) change({ voice_cloud: { id: picked.value, name: picked.dataset.name || picked.value } });
  });
  const listButton = el('button', 'btn', 'List my voices');
  listButton.type = 'button';
  listButton.id = 'voice-list';
  listButton.addEventListener('click', () => { if (state) send({ type: 'voice_list', provider: state.provider }); });
  const cloudPick = el('div', 'folder-form voice-pick');
  cloudPick.append(cloudSelect, listButton);
  const cloudRow = row('Voice', null, cloudPick);
  cloudSelect.setAttribute('aria-label', 'Voice');
  const idForm = el('form', 'folder-form');
  idForm.id = 'voice-id-form';
  const idInput = el('input');
  idInput.type = 'text';
  idInput.id = 'voice-id-input';
  idInput.spellcheck = false;
  idInput.autocomplete = 'off';
  idInput.placeholder = 'Or paste a voice ID';
  idInput.setAttribute('aria-label', 'Voice ID');
  const idUse = el('button', 'btn', 'Use');
  idUse.type = 'submit';
  idForm.append(idInput, idUse);
  idForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const id = idInput.value.trim();
    if (id) change({ voice_cloud: { id, name: id } });
  });

  // The API key: sent once, to the Keychain; the field never keeps it.
  const keyNote = el('small', '');
  keyNote.id = 'voice-key-note';
  const keyRow = row('API key', keyNote, null);
  const keyForm = el('form', 'folder-form');
  keyForm.id = 'voice-key-form';
  keyForm.autocomplete = 'off';
  const keyInput = el('input');
  keyInput.type = 'password';
  keyInput.id = 'voice-key-input';
  keyInput.autocomplete = 'off';
  keyInput.placeholder = 'Paste your key';
  keyInput.setAttribute('aria-label', 'API key');
  const keySave = el('button', 'btn', 'Save');
  keySave.type = 'submit';
  const keyForget = el('button', 'btn danger', 'Remove key');
  keyForget.type = 'button';
  keyForget.id = 'voice-key-forget';
  keyForget.addEventListener('click', () => { if (state) send({ type: 'voice_key_forget', provider: state.provider }); });
  keyForm.append(keyInput, keySave, keyForget);
  keyForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const key = keyInput.value.trim();
    keyInput.value = '';
    if (key && state) send({ type: 'voice_key', provider: state.provider, key });
  });

  const modelInput = el('input');
  modelInput.type = 'text';
  modelInput.id = 'voice-model';
  modelInput.spellcheck = false;
  modelInput.setAttribute('list', 'voice-models');
  const modelList = el('datalist');
  modelList.id = 'voice-models';
  modelInput.addEventListener('change', () => change({ voice_model: modelInput.value.trim() }));
  const modelRow = row('Model', null, modelInput);
  modelRow.append(modelList);

  const speed = el('input');
  speed.type = 'range';
  speed.id = 'voice-speed';
  speed.min = '70';
  speed.max = '130';
  speed.step = '5';
  const speedOut = el('output');
  speedOut.id = 'voice-speed-out';
  speed.addEventListener('input', () => { speedOut.textContent = `${speed.value}%`; });
  speed.addEventListener('change', () => change({ voice_speed: Number(speed.value) }));
  const speedRow = el('label', 'row stack');
  speedRow.htmlFor = 'voice-speed';
  const speedHead = el('span');
  speedHead.append(el('strong', '', 'Speed'), speedOut);
  speedRow.append(speedHead, speed);

  const preview = el('button', 'btn', 'Preview');
  preview.type = 'button';
  preview.id = 'voice-preview';
  preview.addEventListener('click', () => {
    if (!state) return;
    const cloud = (state.clouds || {})[state.provider];
    const voice = state.provider === 'say' ? macSelect.value : ((cloud && cloud.voice) || {}).id || '';
    send({ type: 'voice_preview', provider: state.provider, voice });
  });
  const speakingNote = el('p', 'small-status');
  speakingNote.id = 'voice-speaking-note';
  const speakingError = el('p', 'small-status warn-line');
  speakingError.id = 'voice-speaking-error';
  speakingError.hidden = true;

  speaking.append(provider, providerNote, macRow, cloudRow, idForm, keyRow, keyForm, modelRow, speedRow, preview, speakingNote, speakingError);

  // An option naming a voice or a model (data: never translated), or the window's own words.
  function option(value, label, selected, words = false) {
    const o = el('option', '', label);
    o.value = value;
    o.selected = selected;
    if (!words) o.setAttribute('data-no-i18n', '');
    return o;
  }

  let macAsked = false;  // the Mac's voices asked for once, if the hub hadn't listed them yet

  function renderSpeaking() {
    const p = state.provider || 'say';
    if (p === 'say' && state.mac_voices === null && !macAsked) {
      macAsked = true;
      send({ type: 'voice_list', provider: 'say' });
    }
    const cloud = p !== 'say' ? (state.clouds || {})[p] || {} : null;
    provider.querySelectorAll('button').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.provider === p)));
    providerNote.replaceChildren();
    if (!state.provider_set) providerNote.append(el('span', '', 'From your .env file (never changed here).'));
    else if ((state.env_provider || 'say') !== p) providerNote.append(el('span', '', `Picked here; your .env says ${NAMES[state.env_provider] || 'Mac'}.`), document.createTextNode(' '), useEnv);
    providerNote.hidden = !providerNote.childNodes.length;

    macRow.hidden = p !== 'say';
    for (const node of [cloudRow, idForm, keyRow, keyForm, modelRow]) node.hidden = p === 'say';

    // Mac voices, best first; the one speaking now stays listed even if the list isn't in.
    const voices = state.mac_voices || [];
    const now = state.mac_voice || '';
    const opts = voices.map((v) => option(v.name, v.quality === 'standard' ? v.name : `${v.name} · ${v.quality === 'premium' ? 'Premium' : 'Enhanced'}`, v.name === now));
    if (!voices.some((v) => v.name === now) && now) opts.unshift(option(now, now, true));
    if (document.activeElement !== macSelect) macSelect.replaceChildren(...opts);

    if (cloud) {
      const listed = cloud.voices || [];
      const current = cloud.voice || { id: '', name: '' };
      const choices = listed.map((v) => {
        const o = option(v.id, v.about ? `${v.name} · ${v.about}` : v.name, v.id === current.id);
        o.dataset.name = v.name;
        return o;
      });
      if (current.id && !listed.some((v) => v.id === current.id)) choices.unshift(option(current.id, current.name || current.id, true));
      if (!current.id) choices.unshift(option('', 'No voice picked yet', true, true));
      if (document.activeElement !== cloudSelect) cloudSelect.replaceChildren(...choices);
      listButton.disabled = state.busy === 'list';
      listButton.textContent = state.busy === 'list' ? 'Listing…' : 'List my voices';
      if (document.activeElement !== idInput) idInput.value = '';
      keyNote.textContent = cloud.key ? `Saved in the Keychain (${cloud.key}).` : cloud.env_key ? 'Using the key from your .env file.' : 'Kept in the Keychain; only its last four characters show here.';
      keyForget.hidden = !cloud.key;
      if (document.activeElement !== modelInput) modelInput.value = cloud.model || '';
      modelInput.placeholder = (cloud.models || [])[0] || '';  // what the service uses unless told
      modelList.replaceChildren(...(cloud.models || []).map((m) => option(m, m, false)));
    }
    if (document.activeElement !== speed) {
      speed.value = String(state.speed || 100);
      speedOut.textContent = `${speed.value}%`;
    }
    preview.disabled = state.busy === 'preview';
    preview.textContent = state.busy === 'preview' ? 'Playing…' : 'Preview';

    let note = '';
    if (cloud && !state.cloud_on) note = `${NAMES[p]} needs an API key and a voice; the Mac voice speaks until then.`;
    else if (cloud && state.cloud_error) note = `${NAMES[p]} failed last time; ${state.fallback_voice || state.mac_voice} spoke instead.`;
    else if (cloud) note = `If ${NAMES[p]} fails, ${state.fallback_voice || state.mac_voice} speaks instead.`;
    speakingNote.textContent = note;
    speakingNote.title = cloud && state.cloud_error ? state.cloud_error : '';
    speakingNote.hidden = !note;
    speakingError.textContent = state.speaking_error || '';
    speakingError.hidden = !state.speaking_error;
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

  // Wake words: the names that wake hands-free, each with Remove, and a field to add one.
  const wakeRow = el('div', 'row stack');
  const wakeLabel = el('span');
  wakeLabel.append(el('strong', '', 'Wake words'),
    el('small', '', '“Jarvis” works anywhere in a sentence; other names when a request starts with them (“Friday, what’s on today?”) or after “Hey”.'));
  wakeRow.append(wakeLabel);
  const wakeList = el('ul', 'folders voice-wake-list');
  wakeList.id = 'voice-wake-list';
  const wakeForm = el('form', 'folder-form');
  wakeForm.id = 'voice-wake-form';
  const wakeInput = el('input');
  wakeInput.id = 'voice-wake-input';
  wakeInput.type = 'text';
  wakeInput.maxLength = 20;
  wakeInput.placeholder = 'Add a name, like Friday';
  wakeInput.setAttribute('aria-label', 'Add a wake word');
  const wakeAdd = el('button', 'btn', 'Add');
  wakeAdd.type = 'submit';
  wakeForm.append(wakeInput, wakeAdd);
  wakeForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const word = wakeInput.value.trim();
    if (!word) return;
    change({ wake_add: word });
    wakeInput.value = '';
  });
  const wakeError = el('p', 'small-status warn-line');
  wakeError.id = 'voice-wake-error';
  wakeError.hidden = true;

  // Speech recognition: Whisper, or Apple's on-device recognizer (with its model's download).
  const engineRow = row('Speech recognition', 'Turns what you say into words, all on this Mac.', null);
  const engine = el('div', 'segmented');
  engine.id = 'voice-engine';
  engine.setAttribute('role', 'radiogroup');
  engine.setAttribute('aria-label', 'Speech recognition');
  engine.append(
    radio('Whisper', 'whisper', 'engine', (v) => change({ voice_engine: v })),
    radio('Apple (streaming)', 'apple', 'engine', (v) => change({ voice_engine: v })),
  );
  engine.firstChild.setAttribute('data-no-i18n', '');
  const engineNote = el('p', 'small-status');
  engineNote.id = 'voice-engine-note';
  const engineSize = el('p', 'small-status');
  engineSize.id = 'voice-engine-size';
  const download = el('button', 'btn', 'Download');
  download.type = 'button';
  download.id = 'voice-engine-download';
  download.addEventListener('click', () => { download.disabled = true; send({ type: 'voice_engine_download' }); });

  // Talk over Jarvis: its voice and the microphone through the Mac's echo cancellation.
  const talkRow = el('div', 'row');
  const talkLabel = el('span');
  talkLabel.append(el('strong', '', 'Talk over Jarvis'), el('small', '', 'Interrupt a reply just by speaking, no wake word'));
  const talkSwitch = el('button', 'switch');
  talkSwitch.type = 'button';
  talkSwitch.id = 'voice-talk-over';
  talkSwitch.setAttribute('role', 'switch');
  talkSwitch.setAttribute('aria-label', 'Talk over Jarvis');
  talkSwitch.addEventListener('click', () => change({ voice_talk_over: !(state && state.talk_over) }));
  talkRow.append(talkLabel, talkSwitch);
  const talkNote = el('p', 'small-status');
  talkNote.id = 'voice-talk-over-note';

  listening.append(detectorRow, detector, detectorNote, sensitivity, talkRow, talkNote, engineRow, engine, engineNote,
    engineSize, download, wakeRow, wakeList, wakeForm, wakeError);

  // What the hands-free row says about interrupting: true either way.
  const TALK_OVER_COPY = 'Say “Jarvis” to talk; talk over me to interrupt. Keeps the mic on.';
  const WAKE_WORD_COPY = 'Say “Jarvis” to talk, and “Jarvis, stop” to interrupt me. Keeps the mic on.';

  function renderTalkOver() {
    const on = !!state.talk_over;
    const talk = state.talk_over_state || {};
    talkSwitch.setAttribute('aria-checked', String(on));
    let note;
    if (!on) note = 'Off: say “Jarvis, stop” to interrupt me.';
    else if (talk.state === 'on') note = 'On: talk over me to interrupt (any voice near the Mac does). The Mac’s echo cancellation keeps my own voice out of the microphone.';
    else if (talk.state === 'preparing') note = 'Starting the Mac’s echo cancellation…';
    else if (talk.state === 'unavailable') note = `Talking over me needs the Mac’s echo cancellation, which couldn’t start (${talk.why || 'unknown'}). Say “Jarvis, stop” to interrupt.`;
    else note = 'Works while hands-free listens.';
    talkNote.textContent = note;
    const handsFree = F.$('sw-handsfree') && F.$('sw-handsfree').closest('.row');
    const small = handsFree && handsFree.querySelector('small');
    if (small) {
      const wanted = on && talk.state === 'on' ? TALK_OVER_COPY : WAKE_WORD_COPY;
      if (small.textContent !== wanted && F.t(wanted) !== small.textContent) small.textContent = wanted;
    }
  }

  function renderEngine() {
    const kind = state.engine === 'apple' ? 'apple' : 'whisper';
    engine.querySelectorAll('button').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.engine === kind)));
    const apple = state.apple || {};
    const language = (apple.locale || '').startsWith('zh') ? 'Chinese' : 'English';
    let note = 'Whisper, on this Mac: your words are read once you stop talking.';
    let size = '';
    if (kind === 'apple') {
      if (apple.state === 'on') note = 'Apple’s recognizer, on this Mac: captions as you speak, on the Neural Engine so a busy Mac doesn’t slow it; its words run about a second behind you.';
      else if (apple.state === 'preparing') note = 'Getting Apple’s recognizer ready…';
      else if (apple.state === 'needs_model') {
        note = `Apple’s speech model for ${language} isn’t on this Mac yet. macOS downloads it from Apple when you press Download.`;
        if (apple.bytes > 0) size = `About ${Math.max(1, Math.round(apple.bytes / 1e6))} MB.`;
      } else if (apple.state === 'downloading') note = `Downloading from Apple… ${Math.round((apple.progress || 0) * 100)}%`;
      else if (apple.state === 'failed') note = `Apple’s recognizer couldn’t start (${apple.why || 'unknown'}), so Whisper listens.`;
      else note = 'Starts when hands-free listens.';
    }
    engineNote.textContent = note;
    engineSize.textContent = size;
    engineSize.hidden = !size;
    download.hidden = !(kind === 'apple' && apple.state === 'needs_model');
    download.disabled = false;
    if (apple.state === 'needs_model' && apple.why) engineNote.title = apple.why;
  }

  function renderWakeWords() {
    const words = state.wake_words || [];
    wakeList.replaceChildren(...words.map((word) => {
      const li = el('li');
      const name = el('span', 'fact', word);
      name.setAttribute('data-no-i18n', '');
      const rm = el('button', 'btn', 'Remove');
      rm.type = 'button';
      rm.disabled = words.length <= 1;
      rm.setAttribute('aria-label', `Remove ${word}`);
      rm.addEventListener('click', () => change({ wake_remove: word }));
      li.append(name, rm);
      return li;
    }));
    wakeError.textContent = state.wake_error || '';
    wakeError.hidden = !state.wake_error;
    hint();
  }

  // The footer's "Say “Hey Jarvis”" (its first text, while hands-free is on) names the first
  // wake word when Jarvis isn't one. Written in English: the i18n layer puts it in Chinese.
  function hint() {
    const words = (state && state.wake_words) || [];
    const name = words.some((w) => w.toLowerCase() === 'jarvis') ? 'Jarvis' : words[0];
    const first = F.$('hint') && F.$('hint').firstChild;
    if (!name || !first || first.nodeType !== Node.TEXT_NODE) return;
    const wanted = `Say “Hey ${name}” · `;
    if (first.nodeValue !== wanted && F.t(wanted) !== first.nodeValue) first.nodeValue = wanted;
  }

  function sensitivityWord(value) {
    if (value >= 60) return 'Hears quieter voices';
    if (value <= 40) return 'Only clear speech';
    return 'Normal';
  }

  function place() {
    const settings = F.$('settings');
    if (!settings || listening.isConnected) return;
    const voiceGroup = F.$('mic-select') && F.$('mic-select').closest('section.group');
    if (voiceGroup) {
      voiceGroup.before(speaking);
      voiceGroup.after(listening);
      // Spoken replies and the AI voice effect are about the voice: they move to Speaking.
      const moved = ['sw-voice', 'sw-effect'].map((id) => F.$(id) && F.$(id).closest('.row')).filter(Boolean);
      providerNote.after(...moved);
    } else {
      settings.append(speaking, listening);
    }
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
  F.on('voice', (ev) => { state = ev; place(); render(); renderTalkOver(); renderEngine(); renderWakeWords(); renderSpeaking(); }, { replay: true });

  // Live captions under the orb while you talk to Jarvis (Apple's recognizer): the words so
  // far, then gone a few seconds after the last unless the request took their place.
  let caption = '';
  let captionTimer = null;
  F.on('voice_live', (ev) => {
    const heard = F.$('heard');
    if (!heard || !ev.text) return;
    caption = ev.final ? `“${ev.text}”` : `“${ev.text}…”`;
    heard.textContent = caption;
    heard.classList.add('live');
    clearTimeout(captionTimer);
    captionTimer = setTimeout(() => {
      if (heard.textContent === caption) heard.textContent = '';
      heard.classList.remove('live');
    }, 4000);
  });
  F.on('turn', () => { clearTimeout(captionTimer); const heard = F.$('heard'); if (heard) heard.classList.remove('live'); });
  F.on('prefs', () => hint());  // app.js writes the hint afresh with each settings change
  // A new connection (or backend) sends its own hello: ask for the pane's state again.
  F.on('hello', () => send({ type: 'voice_status' }), { replay: true });
})();
