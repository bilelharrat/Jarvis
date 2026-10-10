// The intro (features/intro): first-run Setup as a guided tour, one idea a card, shown by
// itself on a fresh install (ops_state's setup.show) and from Settings › Health & safety ›
// "Set up Jarvis again…" (window.jarvisIntro.open). Every setting goes through the
// backend's own messages and stores: keys only ever go one way, to the Keychain (signin_key,
// phone_credentials, voice_key, providers_add, connect), and are never shown again. The
// "Try it" cards succeed on the hub's real events (state, heard, turn, reply, ui), never on
// a timer. What's the owner's own (names, numbers, what the microphone heard, replies)
// carries data-no-i18n; every sentence of the window's own has its Chinese in
// web/i18n/intro.json.
(() => {
  const F = window.jarvisFeatures;
  if (!F) return;
  const { el, $ } = F;

  const S = {
    prefs: {},
    open: false,
    autoShown: false,
    card: 'welcome',
    celebrated: new Set(),
    perms: null,
    claude: null,
    signin: null,
    signinBusy: false,
    mic: { state: '', text: '', peak: 0, bars: [] },
    voiceMuted: false,
    voice: null,
    voiceBusy: false,
    talk: { phase: '', heard: '', reply: '', rid: '' },
    wake: { phase: '', heard: '', reply: '', rid: '' },
    clap: false,
    voiceId: null, // the voice_id event: Settings › Listening › Recognise my voice
    hubState: 'idle',
    connectors: null,
    openSvc: '',
    connErr: { id: '', text: '' },
    phone: null,
    phoneNote: '',
    phoneCalled: false,
    phoneAsked: false,
    providers: null,
    modelKind: 'gemini',
    modelBusy: false,
    modelErr: '',
    modelNew: '', // the provider id just added, waiting for its check
    modelChecks: {}, // provider id -> { ok, error }
    knownProviders: null, // provider ids there before a paste
  };
  // Eden Code's window (app/flavor.js) sets up only what coding needs: Claude, other models
  // and the developer tools; the voice, the phone and the iPhone are J.A.R.V.I.S.'s.
  const EDEN = document.body.dataset.app === 'eden-code';
  const HEARD = 0.1; // a level this high is a voice, not the room
  const BARS = 28;

  const SECTIONS = EDEN ? [
    ['welcome', 'Welcome'], ['sound', 'Boot-up sound'], ['claude', 'Claude'], ['accounts', 'Developer tools'], ['models', 'Other AI models'], ['done', 'All set'],
  ] : [
    ['welcome', 'Welcome'], ['language', 'Language'], ['sound', 'Boot-up sound'], ['permissions', 'Permissions'], ['claude', 'Claude'],
    ['try', 'Try it'], ['me', 'Your voice'], ['voice', 'The voice'], ['accounts', 'Accounts'], ['phone', 'Phone calls'],
    ['models', 'Other AI models'], ['companion', 'iPhone & Watch'], ['done', 'All set'],
  ];
  const SECTION_OF = {
    welcome: 'welcome', language: 'language', sound: 'sound', mic: 'permissions', permissions: 'permissions', claude: 'claude',
    talk: 'try', wake: 'try', clap: 'try', 'voice-id': 'me', voice: 'voice', twilio: 'phone', 'twilio-keys': 'phone',
    'wake-call': 'phone', 'iphone-calls': 'phone', models: 'models', companion: 'companion', done: 'done',
  };
  const GROUPS = {
    Work: ['briefcase', 'Your work apps', 'Tasks, issues, docs and messages: Jarvis reads them for you, and asks before it changes anything.'],
    Google: ['mail', 'Google', 'Gmail, Google Calendar and Drive, through Google’s own connectors.'],
    Developer: ['code', 'Developer tools', 'Code, errors, deployments and data, for Jarvis and Eden Code.'],
    Business: ['chart', 'Business tools', 'Customers, payments and deals.'],
    Design: ['pen', 'Design tools', 'Designs, components and brand assets.'],
  };
  const STATUS = {
    connected: ['ok', 'Connected'], connecting: ['info', 'Connecting…'], signing_in: ['info', 'Finish signing in in your browser'],
    error: ['bad', 'Problem'], disconnected: ['muted', 'Disconnected'], off: ['muted', 'Off'],
  };
  const PERM_STATE = { granted: 'ok', denied: 'bad', off: 'bad', restricted: 'bad', unknown: 'muted', not_running: 'muted' };
  const MODEL_KINDS = {
    gemini: {
      name: 'Google Gemini', url: 'https://aistudio.google.com/app/apikey', open: 'Open Google AI Studio', placeholder: 'AIza…',
      steps: ['Open Google AI Studio and sign in with your Google account.', 'Press Create API key, then copy the key (it starts with AIza).', 'Paste it here. Google’s free tier is enough to start.'],
    },
    openrouter: {
      name: 'OpenRouter', url: 'https://openrouter.ai/settings/keys', open: 'Open OpenRouter', placeholder: 'sk-or-…',
      steps: ['Sign in at openrouter.ai and add a few dollars of credit.', 'Under Settings › API Keys, press Create key, then copy it (it starts with sk-or-).', 'Paste it here. One key reaches GPT, Gemini, Grok, DeepSeek and more.'],
    },
  };
  const CALLING = 'Calling you now.'; // the hub's phone_status note when a test call went out
  const ICONS = {
    mic: '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21"/>',
    shield: '<path d="M12 3l7 3v5c0 4.5-3 8.3-7 10-4-1.7-7-5.5-7-10V6z"/><path d="M9 12l2 2 4-4"/>',
    globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.5 2.6 3.8 5.6 3.8 9s-1.3 6.4-3.8 9c-2.5-2.6-3.8-5.6-3.8-9S9.5 5.6 12 3z"/>',
    spark: '<path d="M12 3v5M12 16v5M3 12h5M16 12h5M5.6 5.6l3.2 3.2M15.2 15.2l3.2 3.2M5.6 18.4l3.2-3.2M15.2 8.8l3.2-3.2"/>',
    keys: '<rect x="2.5" y="6" width="19" height="12" rx="2.5"/><path d="M6.5 10h.01M10 10h.01M14 10h.01M17.5 10h.01M7.5 14h9"/>',
    hand: '<path d="M8 13V5.5a1.5 1.5 0 0 1 3 0V12M11 11.5V4a1.5 1.5 0 0 1 3 0v7.5M14 11.5V6a1.5 1.5 0 0 1 3 0v8c0 4-2.7 7-6.5 7-2.6 0-4.3-1.3-5.6-3.4L3.2 14a1.5 1.5 0 0 1 2.5-1.6L8 15"/>',
    wave: '<path d="M4 10v4M8 7v10M12 4v16M16 8v8M20 11v2"/>',
    plug: '<path d="M9 3v5M15 3v5M6 8h12v3a6 6 0 0 1-12 0zM12 17v4"/>',
    briefcase: '<rect x="3" y="7" width="18" height="13" rx="2"/><path d="M8 7V5a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M3 12.5h18"/>',
    mail: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3.5 6.5l8.5 6.5 8.5-6.5"/>',
    code: '<path d="M8 8l-4 4 4 4M16 8l4 4-4 4M13.5 5l-3 14"/>',
    chart: '<path d="M5 20V11M11 20V5M17 20v-7M3 20h18"/>',
    pen: '<path d="M4 20l4-1 11-11-3-3L5 16zM14 6l3 3"/>',
    phone: '<path d="M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2z"/>',
    alarm: '<circle cx="12" cy="13" r="7"/><path d="M12 9.5V13l2.5 2M5 4L2.5 6.5M19 4l2.5 2.5"/>',
    iphone: '<rect x="7" y="2.5" width="10" height="19" rx="2.5"/><path d="M11 18.5h2"/>',
    chip: '<rect x="6" y="6" width="12" height="12" rx="2"/><path d="M9 2.5v3M15 2.5v3M9 18.5v3M15 18.5v3M2.5 9h3M2.5 15h3M18.5 9h3M18.5 15h3"/>',
    devices: '<rect x="3" y="3" width="9" height="17" rx="2"/><rect x="14" y="8" width="7" height="9" rx="2"/><path d="M15.5 8V6h4v2M15.5 17v2h4v-2"/>',
    check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
    back: '<path d="M15 5l-7 7 7 7"/>',
  };

  function data(node) { node.setAttribute('data-no-i18n', ''); return node; }
  function button(label, cls, run) {
    const b = el('button', cls || 'btn', label);
    b.type = 'button';
    if (run) b.addEventListener('click', run);
    return b;
  }
  function link(href, label, cls) {
    const a = el('a', cls || 'btn intro-link', label);
    a.href = href;
    a.target = '_blank';
    a.rel = 'noopener';
    return a;
  }
  function svg(name, size) {
    const n = el('span', 'intro-svg');
    n.setAttribute('aria-hidden', 'true');
    n.innerHTML = `<svg viewBox="0 0 24 24" width="${size || 24}" height="${size || 24}" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${ICONS[name] || ''}</svg>`;
    return n;
  }
  function copy(text, b) {
    try { navigator.clipboard.writeText(text); } catch (_) { /* no clipboard: the text is on screen to select */ }
    if (b) { b.textContent = 'Copied'; setTimeout(() => { if (b.isConnected) b.textContent = 'Copy'; }, 1600); }
  }
  function para(text, cls) { return el('p', cls || 'intro-note', text); }
  function pill(state, label) {
    const p = el('span', 'intro-pill', label);
    p.dataset.state = state;
    return p;
  }
  function keycap(label) { return data(el('kbd', 'intro-key', label)); }
  function codeChip(value) {
    const box = el('span', 'intro-code');
    const code = data(el('code', '', value));
    const b = button('Copy', 'intro-copy', () => copy(value, b));
    box.append(code, b);
    return box;
  }
  // A numbered walkthrough: each step a sentence (or nodes), "{redirect_uri}" as text to copy.
  function steps(items) {
    const ol = el('ol', 'intro-steps');
    for (const item of items) {
      const li = el('li', '');
      const text = el('div', 'intro-step');
      if (typeof item === 'string') {
        item.split('{redirect_uri}').forEach((part, i) => {
          if (i) text.append(codeChip((S.connectors && S.connectors.redirect_uri) || ''));
          if (part.trim()) text.append(el('span', '', part.trim()));
        });
      } else text.append(...item);
      li.append(text);
      ol.append(li);
    }
    return ol;
  }
  function field(id, label, opts = {}) {
    const wrap = el('label', 'intro-field');
    wrap.htmlFor = id;
    wrap.append(el('span', '', label));
    const input = el('input', '');
    input.id = id;
    input.type = opts.type || 'text';
    input.autocomplete = 'off';
    input.spellcheck = false;
    if (opts.placeholder) input.placeholder = opts.placeholder;
    if (opts.value !== undefined) input.value = opts.value;
    if (opts.change) input.addEventListener('change', () => opts.change(input.value.trim()));
    wrap.append(input);
    return wrap;
  }
  // A secret pasted once: the field empties as it goes, and it goes only in the message.
  function secretForm(id, label, placeholder, busy, submit, go) {
    const form = el('form', 'intro-form');
    form.autocomplete = 'off';
    form.append(field(id, label, { type: 'password', placeholder }));
    const b = el('button', 'btn primary intro-small', busy ? 'Checking…' : (go || 'Connect'));
    b.type = 'submit';
    b.disabled = busy;
    form.append(b);
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const input = $(id);
      const value = input.value.trim();
      if (!value || busy) return;
      input.value = '';
      submit(value);
    });
    return form;
  }
  function switchRow(title, note, on, run, id) {
    const row = el('div', 'intro-row');
    const label = el('span', 'intro-row-text');
    label.append(el('strong', '', title));
    if (note) label.append(el('small', '', note));
    const sw = el('button', 'switch');
    sw.type = 'button';
    sw.setAttribute('role', 'switch');
    sw.setAttribute('aria-checked', String(Boolean(on)));
    sw.setAttribute('aria-label', title);
    if (id) sw.id = id;
    sw.addEventListener('click', run);
    row.append(label, sw);
    return row;
  }
  function callout(state, nodes) {
    const box = el('div', 'intro-callout');
    box.dataset.state = state;
    box.append(...nodes);
    return box;
  }
  function setPrefs(changes) { F.send({ type: 'set_prefs', changes }); }
  function permRow(id) { return S.perms && S.perms.rows ? S.perms.rows.find((r) => r.id === id) : null; }

  // ── the cards ──

  function cardIds() {
    const groups = S.connectors ? [...new Set((S.connectors.catalog || []).map((e) => e.category))] : [];
    if (EDEN) return ['welcome', 'sound', 'claude', ...(groups.includes('Developer') ? ['accounts:Developer'] : []), 'models', 'done'];
    return ['welcome', 'language', 'sound', 'mic', 'permissions', 'claude', 'talk', 'wake', 'clap',
      ...(S.voiceId && S.voiceId.configured === false ? [] : ['voice-id']), 'voice',
      ...(groups.length ? groups.map((g) => `accounts:${g}`) : ['accounts:']),
      'twilio', 'twilio-keys', 'wake-call', 'iphone-calls', 'models', 'companion', 'done'];
  }
  function sectionOf(id) { return id.startsWith('accounts:') ? 'accounts' : SECTION_OF[id] || 'welcome'; }

  function orb(live) {
    const o = el(live ? 'button' : 'div', 'intro-orb');
    if (live) {
      o.type = 'button';
      o.setAttribute('aria-label', 'Talk to Jarvis');
      o.addEventListener('click', () => F.send({ type: S.hubState === 'idle' ? 'listen' : 'stop' }));
    }
    o.dataset.state = S.hubState;
    o.append(el('i', 'intro-orb-core'));
    return o;
  }
  function tile(icon, tone) {
    const t = el('div', 'intro-tile');
    t.dataset.tone = tone;
    t.append(svg(icon, 44));
    return t;
  }

  // What each card shows: { visual, title, lead, body: [nodes], ok, primary, later, skipTo }.
  function spec(id) {
    const p = S.prefs || {};
    if (id === 'welcome' && EDEN) {
      const mark = el('div', 'intro-eden-mark');
      mark.setAttribute('aria-hidden', 'true');
      return {
        visual: mark, title: 'Welcome to Eden Code.', primary: 'Get started',
        lead: 'Plan, build and fix in your own projects: it edits, runs and explains, and asks before anything risky.',
        body: [para('Sign in to Claude and you’re ready. The rest is optional, and stays in Settings.', 'intro-note intro-center')],
      };
    }
    if (id === 'welcome') {
      return {
        visual: orb(false), title: 'Hello. I’m Jarvis.', primary: 'Get started',
        lead: 'Your assistant on this Mac: talk to it, and it handles your day, your mail, your apps and your code.',
        body: [para('A few minutes to set things up. Everything here is optional, and you can come back any time from Settings.', 'intro-note intro-center')],
      };
    }
    if (id === 'language') {
      const choices = el('div', 'intro-choices');
      choices.setAttribute('role', 'radiogroup');
      choices.setAttribute('aria-label', 'Language');
      for (const [code, name, sub] of [['en', 'English', 'English'], ['zh', '中文', '简体中文']]) {
        const b = el('button', 'intro-choice');
        b.type = 'button';
        b.setAttribute('role', 'radio');
        b.dataset.lang = code;
        b.setAttribute('aria-checked', String((p.language || 'en') === code));
        b.append(data(el('strong', '', name)), data(el('small', '', sub)));
        b.addEventListener('click', () => setPrefs({ language: code }));
        choices.append(b);
      }
      return { visual: tile('globe', 'blue'), title: 'Which language?', lead: 'Jarvis shows, speaks and listens in the language you pick.', body: [choices] };
    }
    if (id === 'sound') {
      // The boot-up sound (app/loading.js): on, or off from the next launch. Also in Settings › General.
      const on = p.boot_sound !== false;
      const choices = el('div', 'intro-choices');
      choices.setAttribute('role', 'radiogroup');
      choices.setAttribute('aria-label', 'Boot-up sound');
      for (const [value, name, sub] of [[true, 'On', 'A short sound as the app opens'], [false, 'Off', 'Opens quietly']]) {
        const b = el('button', 'intro-choice');
        b.type = 'button';
        b.setAttribute('role', 'radio');
        b.setAttribute('aria-checked', String(on === value));
        b.append(data(el('strong', '', name)), data(el('small', '', sub)));
        b.addEventListener('click', () => setPrefs({ boot_sound: value }));
        choices.append(b);
      }
      return {
        visual: tile('wave', 'violet'), title: 'Boot-up sound?',
        lead: EDEN ? 'Eden Code plays a short sound as it opens. Keep it, or open quietly.' : 'Jarvis plays a short sound as it opens. Keep it, or open quietly.',
        body: [choices, para('You can change this any time in Settings › General.', 'intro-note intro-center')],
      };
    }
    if (id === 'mic') return micCard();
    if (id === 'permissions') return permsCard();
    if (id === 'claude') return claudeCard();
    if (id === 'talk' || id === 'wake') return tryCard(id);
    if (id === 'clap') return clapCard();
    if (id === 'voice-id') return voiceIdCard();
    if (id === 'voice') return voiceCard();
    if (id.startsWith('accounts:')) return accountsCard(id.slice('accounts:'.length));
    if (id === 'twilio') return twilioCard();
    if (id === 'twilio-keys') return twilioKeysCard();
    if (id === 'wake-call') return wakeCallCard();
    if (id === 'iphone-calls') {
      return {
        visual: tile('iphone', 'green'), title: 'Call people from your Mac',
        lead: 'Say “Jarvis, call Sam” and the call rings from your iPhone, through this Mac, for you to talk.',
        body: [steps([
          'On your iPhone, open Settings › Apps › Phone › Calls on Other Devices, turn it on, and turn on this Mac.',
          'On this Mac, open FaceTime › Settings and turn on Calls from iPhone.',
          'Keep both signed in to the same Apple Account, near each other on the same Wi‑Fi.',
        ])],
      };
    }
    if (id === 'models') return modelsCard();
    if (id === 'companion') {
      const open = button('Open iPhone & Watch settings', 'btn', () => {
        close();
        if (typeof toggleSettings === 'function') toggleSettings(true);
        const sw = $('sw-remote');
        if (sw) { sw.scrollIntoView({ block: 'center' }); sw.focus({ preventScroll: true }); }
      });
      return {
        visual: tile('devices', 'slate'), title: 'Jarvis on your iPhone and Apple Watch', later: true,
        lead: 'Ask Jarvis from your phone or your wrist, wherever you are.',
        body: [steps(['Turn on the companion in Settings › iPhone & Watch.', 'Open the Jarvis app on your iPhone and pair it with the code this Mac shows.']), open],
      };
    }
    // done
    const list = el('ul', 'intro-try-list');
    for (const said of ['“Jarvis, what’s on my calendar today?”', '“Jarvis, brief me.”', '“Jarvis, remind me at 5 to call Sam.”', '“Jarvis, open Eden Code.”', '“Jarvis, run a checkup.”']) list.append(el('li', '', said));
    return {
      visual: orb(false), ok: true, title: 'You’re all set', primary: 'Start using Jarvis',
      lead: 'A few things to try:',
      body: [list, para('Anything you skipped is in Settings, and Settings › Health & safety › Set up Jarvis again… brings this back.', 'intro-note intro-center')],
    };
  }

  function micCard() {
    const m = S.mic;
    const row = permRow('microphone');
    const blocked = row && ['denied', 'off', 'restricted'].includes(row.state);
    const ok = !blocked && (m.peak >= HEARD || (m.state === 'heard' && Boolean(m.text)));
    const silent = blocked || (!ok && (m.state === 'silent' || m.state === 'metered' || (m.state === 'heard' && !m.text)));
    const body = [];
    const bars = el('div', 'intro-bars');
    bars.id = 'intro-bars';
    for (let i = 0; i < BARS; i++) {
      const b = el('i', '');
      b.style.height = `${6 + Math.round((m.bars[m.bars.length - BARS + i] || 0) * 46)}px`;
      bars.append(b);
    }
    body.push(bars);
    const status = el('p', 'intro-status');
    const listening = m.state === 'listening' || m.state === 'starting';
    if (ok && m.text) status.append(el('span', '', 'Jarvis heard:'), document.createTextNode(' '), data(el('q', '', m.text)));
    else if (ok) status.textContent = 'Jarvis hears you.';
    else if (listening) status.textContent = 'Listening… say something.';
    else if (m.state === 'transcribing') status.textContent = 'One moment…';
    else if (m.state === 'busy') status.textContent = 'Jarvis is busy. Try again in a moment.';
    else if (m.state === 'error') status.textContent = m.text || 'Jarvis couldn’t use the microphone.';
    else if (!silent) status.textContent = 'Press Test, then say a few words.';
    if (status.childNodes.length) body.push(status);
    if (silent) {
      body.push(callout('warn', [
        el('strong', '', blocked ? 'The microphone is turned off for Jarvis.' : 'Jarvis didn’t hear anything.'),
        steps(['Open System Settings › Privacy & Security › Microphone.', 'Turn on J.A.R.V.I.S.', 'Quit Jarvis (⌘Q) and open it again.']),
        button('Open Microphone settings', 'btn intro-small', () => F.send({ type: 'ops_open_settings', pane: 'microphone' })),
      ]));
    }
    const test = button(listening ? 'Listening…' : ok || silent ? 'Test again' : 'Test the microphone', ok ? 'btn' : 'btn primary', () => {
      S.mic = { state: 'starting', text: '', peak: 0, bars: [] };
      F.send({ type: 'ops_mic_meter' });
      fill();
    });
    test.id = 'intro-mic-test';
    test.disabled = listening || m.state === 'transcribing';
    body.push(el('div', 'intro-actions'));
    body[body.length - 1].append(test);
    return {
      visual: tile('mic', 'red'), ok, later: true, title: ok ? 'Jarvis hears you' : 'Can Jarvis hear you?',
      lead: 'Jarvis needs the microphone to hear you. Press Test, then say a few words: the bars move as it hears you.', body,
    };
  }

  function permsCard() {
    const body = [];
    const rows = S.perms && S.perms.rows ? S.perms.rows.filter((r) => r.id !== 'microphone') : null;
    if (!rows) body.push(para('Checking…'));
    else {
      const list = el('ul', 'intro-list');
      for (const r of rows) {
        const li = el('li', 'intro-item');
        li.dataset.perm = r.id;
        li.dataset.state = PERM_STATE[r.state] || 'warn';
        const text = el('div', 'intro-item-text');
        const name = el('div', 'intro-item-name');
        name.append(el('strong', '', r.title), pill(li.dataset.state, r.label));
        text.append(name, el('small', '', r.why));
        const side = el('div', 'intro-item-side');
        if (r.state !== 'granted') side.append(button('Open System Settings', 'btn intro-small', () => F.send({ type: 'ops_open_settings', pane: r.pane })));
        li.append(text, side);
        list.append(li);
      }
      body.push(list);
      if (S.perms.error) body.push(para(S.perms.error, 'intro-note warn'));
    }
    const allowed = rows && rows.every((r) => r.state === 'granted');
    return {
      visual: tile('shield', 'blue'), compact: true, ok: Boolean(allowed), later: true, title: 'What Jarvis may use',
      lead: 'macOS asks the first time Jarvis needs each of these. You can allow them now: this list updates as you do.', body,
    };
  }

  function claudeCard() {
    const k = S.signin || {};
    const c = S.claude;
    const body = [];
    let ok = false;
    let title = 'Sign in to Claude';
    if (k.mode === 'key') {
      ok = true;
      title = 'Claude is connected';
      const line = el('div', 'intro-line');
      line.append(pill('ok', 'Your API key'), data(el('span', 'intro-meta', k.hint || '')));
      body.push(line, para('Claude’s usage is billed to your own Anthropic account. The key stays in your Keychain.'));
      body.push(button('Remove the key', 'btn intro-small', () => { S.signinBusy = true; F.send({ type: 'signin_forget' }); fill(); }));
    } else if (c && c.state === 'ok') {
      ok = true;
      title = 'Claude is connected';
      const line = el('div', 'intro-line');
      line.append(pill('ok', 'Signed in through Claude Code'));
      if (c.meta) line.append(data(el('span', 'intro-meta', c.meta)));
      body.push(line, para('This Mac is signed in to Claude already, so there’s nothing to do here.'));
    } else {
      body.push(steps([
        [el('span', '', 'Open the Anthropic Console and sign up, or sign in.'), link('https://platform.claude.com/settings/keys', 'Open the Anthropic Console', 'btn intro-small intro-link')],
        'Add credit under Settings › Billing: Claude is billed to your Anthropic account as you use it.',
        'Under Settings › API keys, press Create key and name it Jarvis.',
        'Copy the key (it starts with sk-ant-). The Console shows it only once.',
        'Paste it here. Jarvis checks it with Anthropic and keeps it in your Keychain.',
      ]));
      const form = secretForm('intro-claude-key', 'Anthropic API key', 'sk-ant-…', S.signinBusy, (key) => {
        S.signinBusy = true;
        F.send({ type: 'signin_key', key });
        fill();
      });
      body.push(form);
      if (!c) body.push(para('Checking…'));
      body.push(para('You pay Anthropic only for what Jarvis uses. You can set a monthly limit under Settings › Billing › Spend limits.'));
    }
    if (k.error) body.push(para(k.error, 'intro-note warn'));
    else if (k.note && !ok) body.push(para(k.note, 'intro-note'));
    return { visual: tile('spark', 'clay'), compact: true, ok, later: !ok, title, lead: 'Jarvis thinks with Claude, Anthropic’s AI.', body };
  }

  function chat(t) {
    const box = el('div', 'intro-chat');
    if (t.heard) {
      const you = el('div', 'intro-bubble you');
      you.append(data(el('span', '', t.heard)));
      box.append(you);
    }
    if (t.reply) {
      const me = el('div', 'intro-bubble jarvis');
      me.append(data(el('span', '', t.reply)));
      box.append(me);
    }
    return box;
  }

  function tryCard(id) {
    const t = S[id];
    const p = S.prefs || {};
    const ok = t.phase === 'done';
    const body = [];
    const status = el('p', 'intro-status');
    if (ok) status.textContent = 'That’s it: Jarvis heard you and answered.';
    else if (t.phase === 'listening') status.textContent = 'Listening… ask “What time is it?”';
    else if (t.phase === 'heard') status.textContent = 'Thinking…';
    else if (t.phase === 'missed') status.textContent = 'Jarvis didn’t catch that. Try again.';
    else status.textContent = 'Waiting for you…';
    if (id === 'talk') {
      const keys = el('div', 'intro-keys');
      keys.append(keycap('⌥'), keycap('Space'));
      body.push(keys, status, chat(t));
      if (!ok) body.push(para('Or tap the orb. ⌥ Space works from any app, even when Jarvis is hidden.', 'intro-note intro-center'));
      return {
        visual: orb(true), ok, later: true, title: ok ? 'You talked to Jarvis' : 'Talk to Jarvis',
        lead: 'Press ⌥ Space, then ask “What time is it?”', body,
      };
    }
    if (!p.hands_free) {
      body.push(callout('info', [
        para('Hands-free keeps the microphone on and listens for its name. You can turn it off any time in Settings.', 'intro-note'),
        button('Turn on hands-free', 'btn primary intro-small', () => setPrefs({ hands_free: true })),
      ]));
    } else body.push(status, chat(t));
    return {
      visual: orb(false), ok, later: true, title: ok ? 'Jarvis heard its name' : 'Just say “Jarvis”',
      lead: 'With hands-free on, no keys are needed: say “Jarvis, what time is it?”', body,
    };
  }

  function clapCard() {
    const p = S.prefs || {};
    const ok = S.clap;
    const body = [];
    if (!p.hands_free) {
      body.push(callout('info', [para('Claps are heard while hands-free listens.', 'intro-note'), button('Turn on hands-free', 'btn primary intro-small', () => setPrefs({ hands_free: true }))]));
    } else if (p.clap_hands === false) {
      body.push(callout('info', [para('Clap twice for hand control is off in Settings › Listening.', 'intro-note'), button('Turn it on', 'btn primary intro-small', () => setPrefs({ clap_hands: true }))]));
    } else if (ok) {
      body.push(para('Hand control is on: point to move the pointer, pinch to click. Say “Jarvis, stop hand control” or press below to turn it off.', 'intro-status'));
      body.push(button('Turn hand control off', 'btn intro-small', () => {
        if (typeof stopHandControl === 'function' && typeof handsOn !== 'undefined' && handsOn) stopHandControl();
      }));
    } else body.push(el('p', 'intro-status', 'Waiting for two claps…'));
    body.push(para('Hand control uses the camera, and only while it’s on.', 'intro-note intro-center'));
    return {
      visual: tile('hand', 'amber'), ok, later: true, title: ok ? 'Hand control is on' : 'Clap twice',
      lead: 'Two quick claps turn on hand control: steer the Mac with your hand in front of the camera.', body,
    };
  }

  // Only my voice: the owner picks whose voice Jarvis answers, the model downloads (its size
  // shown first) and they read the five sentences, all through voice_id's own messages.
  function voiceIdCard() {
    const v = S.voiceId || {};
    const p = S.prefs || {};
    const on = Boolean(v.on);
    const ok = on && Boolean(v.enrolled);
    const body = [];
    const choices = el('div', 'intro-choices');
    choices.setAttribute('role', 'radiogroup');
    choices.setAttribute('aria-label', 'Whose voice Jarvis answers');
    for (const [scope, name, sub] of [
      ['all', 'Only me', 'Anyone else is ignored.'],
      ['risky', 'Anyone, but risky steps need me', 'Approvals, sends, purchases and deletes by voice need yours.'],
    ]) {
      const b = el('button', 'intro-choice');
      b.type = 'button';
      b.id = `intro-voice-id-${scope}`;
      b.setAttribute('role', 'radio');
      b.setAttribute('aria-checked', String(on && v.scope === scope));
      b.append(el('strong', '', name), el('small', '', sub));
      b.addEventListener('click', () => F.send({ type: 'voice_id_settings', changes: { voice_id_on: true, voice_id_scope: scope } }));
      choices.append(b);
    }
    body.push(choices);
    const enrolling = v.enrolling;
    if (on && v.downloading) {
      const bar = el('progress', 'intro-progress');
      bar.max = 1;
      bar.value = v.downloading.total > 0 ? Math.min(1, v.downloading.done / v.downloading.total) : 0;
      body.push(el('p', 'intro-status', 'Downloading the voice model…'), bar);
    } else if (on && !v.model) {
      const size = v.size > 0 ? `The voice model is ${(v.size / 1e6).toFixed(1)} MB and stays on this Mac.` : 'The voice model stays on this Mac.';
      body.push(callout('info', [para(size, 'intro-note'), button('Download', 'btn primary intro-small', () => F.send({ type: 'voice_id_download' }))]));
    } else if (on && enrolling) {
      const sentences = (window.jarvisVoiceId && window.jarvisVoiceId.SENTENCES) || [];
      const n = enrolling.index + 1;
      body.push(el('p', 'intro-status', enrolling.again
        ? `I didn’t catch that. Read sentence ${n} of ${sentences.length} again:`
        : `Read sentence ${n} of ${sentences.length} aloud:`));
      const line = el('p', 'intro-sentence', sentences[enrolling.index] || '');
      line.id = 'intro-voice-id-sentence';
      body.push(line, button('Cancel', 'btn intro-small', () => F.send({ type: 'voice_id_enroll', action: 'cancel' })));
    } else if (on) {
      body.push(el('p', 'intro-status', v.enrolled ? 'Jarvis knows your voice.' : 'Read five short sentences aloud, in a quiet room. Your voiceprint stays on this Mac.'));
      const teach = button(v.enrolled ? 'Retrain' : 'Teach Jarvis your voice', v.enrolled ? 'btn intro-small' : 'btn primary intro-small', () => F.send({ type: 'voice_id_enroll', action: 'start' }));
      teach.id = 'intro-voice-id-teach';
      body.push(teach);
    }
    if (v.error) body.push(callout('bad', [para(v.error, 'intro-note')]));
    if (on && !p.hands_free) body.push(para('Voices are checked while hands-free listens; turn it on in the Try it cards or Settings › Listening.', 'intro-note intro-center'));
    body.push(para('Tapping the orb, ⌥ Space and typing always work, whoever you are.', 'intro-note intro-center'));
    return {
      visual: tile('wave', 'violet'), ok, later: true, compact: true,
      title: ok ? 'Jarvis knows your voice' : 'Only answer my voice',
      lead: 'Jarvis learns what you sound like, so other people and the TV can’t give it orders. It adds no wait to its answers.',
      body,
    };
  }

  function voiceCard() {
    const v = S.voice || {};
    const fish = ((v.clouds || {}).fish) || {};
    const own = Boolean(fish.key) || Boolean(v.jarvis_own_key);
    const body = [];
    const play = button('Play a sample', 'btn', () => F.send({ type: 'ops_voice_test' }));
    play.id = 'intro-voice-play';
    body.push(el('div', 'intro-actions'));
    body[0].append(play);
    if (S.voiceMuted) {
      body.push(callout('warn', [para('Spoken replies are off, so Jarvis stays quiet.', 'intro-note'), button('Turn spoken replies on', 'btn intro-small', () => { S.voiceMuted = false; F.send({ type: 'mute', value: false }); F.send({ type: 'ops_voice_test' }); fill(); })]));
    }
    if (v.provider && v.provider !== 'jarvis') body.push(para('You’ve picked another voice in Settings › Speaking; the JARVIS voice is there too.'));
    if (own) {
      const line = el('div', 'intro-line');
      line.append(pill('ok', 'Unlimited'), el('span', '', 'Your Fish Audio key'), data(el('span', 'intro-meta', fish.key || '')));
      body.push(line);
    } else {
      const more = el('details', 'intro-more');
      more.append(el('summary', '', 'Make it unlimited (optional)'));
      more.append(para('The JARVIS voice comes with a daily allowance. With your own Fish Audio key it has no limit, billed by Fish Audio.'));
      more.append(steps([
        [el('span', '', 'Sign in (or sign up) at fish.audio.'), link('https://fish.audio/app/api-keys/', 'Open Fish Audio', 'btn intro-small intro-link')],
        'Open API Keys and create a key.',
        'Copy it and paste it here. It goes into your Keychain.',
      ]));
      more.append(secretForm('intro-fish-key', 'Fish Audio API key', '', S.voiceBusy, (key) => {
        S.voiceBusy = true;
        F.send({ type: 'voice_key', provider: 'fish', key });
        fill();
      }, 'Save'));
      if (S.voiceOpen) more.open = true;
      more.addEventListener('toggle', () => { S.voiceOpen = more.open; });
      body.push(more);
    }
    if (v.speaking_error) body.push(para(v.speaking_error, 'intro-note warn'));
    return {
      visual: tile('wave', 'violet'), compact: true, ok: own, later: true, title: 'The JARVIS voice',
      lead: 'Jarvis speaks in its own voice, ready to go. Play a sample to hear it.', body,
    };
  }

  function accountsCard(group) {
    const c = S.connectors;
    if (!c) return { visual: tile('plug', 'teal'), title: 'Connect your accounts', later: true, lead: 'Jarvis can work in the apps you use.', body: [para('Checking…')] };
    const [icon, title, lead] = GROUPS[group] || ['plug', 'More accounts', 'Jarvis can work in these for you, and asks before it changes anything.'];
    const conns = new Map((c.connections || []).map((x) => [x.id, x]));
    const services = (c.catalog || []).filter((e) => e.category === group);
    const list = el('ul', 'intro-list');
    let connected = 0;
    for (const svc of services) {
      const conn = conns.get(svc.id);
      const li = el('li', 'intro-item intro-svc');
      li.dataset.svc = svc.id;
      const text = el('div', 'intro-item-text');
      text.append(data(el('strong', '', svc.name)), el('small', '', svc.blurb));
      const side = el('div', 'intro-item-side');
      if (conn) {
        const [state, label] = STATUS[conn.status] || ['muted', conn.status];
        if (conn.status === 'connected') connected++;
        side.append(pill(state, label));
        if (conn.status === 'signing_in' && conn.sign_in_url) side.append(link(conn.sign_in_url, 'Open the sign-in page again', 'intro-textlink'));
        if (conn.status === 'error' || conn.status === 'disconnected') side.append(button('Try again', 'btn intro-small', () => F.send({ type: 'reconnect', id: svc.id })));
      } else if (svc.auth === 'oauth') {
        side.append(button('Connect', 'btn intro-small', () => { S.connErr = { id: '', text: '' }; F.send({ type: 'connect', id: svc.id }); }));
      } else {
        const open = S.openSvc === svc.id;
        const b = button(open ? 'Close' : 'Set up', 'btn intro-small', () => { S.openSvc = open ? '' : svc.id; S.connErr = { id: '', text: '' }; fill(); });
        b.setAttribute('aria-expanded', String(open));
        side.append(b);
      }
      li.append(text, side);
      if (conn && conn.error) li.append(data(el('p', 'intro-note warn intro-wide', conn.error)));
      if (!conn && S.openSvc === svc.id) li.append(serviceForm(svc));
      if (S.connErr.id === svc.id && S.connErr.text) li.append(el('p', 'intro-note warn intro-wide', S.connErr.text));
      list.append(li);
    }
    const body = [list];
    if (group === 'Google') body.unshift(para('Easier first: add your Google account in System Settings › Internet Accounts. Jarvis already reads Mail and Calendar from there, so you may not need these.', 'intro-note'));
    body.push(para('Connect one now, or any time in Tools & Accounts.', 'intro-note intro-center'));
    const visual = tile(icon, 'teal');
    if (!GROUPS[group]) visual.append(data(el('span', 'intro-tile-label', group)));
    return { visual, compact: true, ok: connected > 0, later: true, title, lead, body };
  }

  function serviceForm(svc) {
    const box = el('form', 'intro-svc-form intro-wide');
    box.autocomplete = 'off';
    if (svc.steps && svc.steps.length) box.append(steps(svc.steps));
    else if (svc.help) box.append(data(el('p', 'intro-note', svc.help)));
    if (svc.help_url) box.append(link(svc.help_url, 'Setup guide', 'intro-textlink'));
    const fields = svc.auth === 'token'
      ? [['token', 'Access token', 'password']]
      : [['client_id', 'OAuth client ID', 'text'], ['client_secret', 'OAuth client secret', 'password']];
    for (const [key, label, type] of fields) box.append(field(`intro-svc-${svc.id}-${key}`, label, { type }));
    const go = el('button', 'btn primary intro-small', 'Connect');
    go.type = 'submit';
    box.append(go);
    box.addEventListener('submit', (e) => {
      e.preventDefault();
      const msg = { type: 'connect', id: svc.id };
      for (const [key] of fields) {
        const input = $(`intro-svc-${svc.id}-${key}`);
        msg[key] = input.value.trim();
        input.value = '';
      }
      S.connErr = { id: '', text: '' };
      S.openSvc = '';
      F.send(msg);
      fill();
    });
    return box;
  }

  function phoneReady() {
    const p = S.prefs || {};
    return Boolean(S.phone && S.phone.signed_in && p.phone_from && p.phone_me);
  }

  function twilioCard() {
    const ready = phoneReady();
    const body = [steps([
      [el('span', '', 'Sign up at twilio.com: the free trial asks you to verify your own mobile number, and that’s the number Jarvis calls.'), link('https://www.twilio.com/try-twilio', 'Open Twilio', 'btn intro-small intro-link')],
      [el('span', '', 'Get a number that can make calls: in the Twilio Console, open Phone Numbers (Numbers & senders in the new Console) and buy a number with Voice. The trial’s credit covers one.'), link('https://console.twilio.com/us1/develop/phone-numbers/manage/search', 'Buy a number', 'btn intro-small intro-link')],
      [el('span', '', 'On the Console’s home page, find your Account SID and Auth Token: you paste them next.'), link('https://console.twilio.com/', 'Open the Twilio Console', 'btn intro-small intro-link')],
    ])];
    if (ready) body.unshift(callout('ok', [el('strong', '', 'Phone calls are set up.')]));
    return {
      visual: tile('phone', 'green'), compact: true, ok: ready, later: true, skipTo: 'iphone-calls', title: 'Jarvis can call you',
      lead: 'Wake-up calls, reminders and messages to people, from your own Twilio account: a number is about $1.15 a month, calls about 1.4¢ a minute.', body,
    };
  }

  function twilioKeysCard() {
    const p = S.prefs || {};
    const ph = S.phone || {};
    const body = [];
    if (ph.signed_in) {
      const line = el('div', 'intro-line');
      line.append(pill('ok', 'Twilio is connected'), data(el('span', 'intro-meta', ph.sid_hint || '')));
      line.append(button('Forget sign-in', 'btn intro-small', () => F.send({ type: 'phone_forget' })));
      body.push(line);
    } else {
      const form = el('form', 'intro-form intro-form-stack');
      form.autocomplete = 'off';
      form.append(field('intro-tw-sid', 'Account SID', { placeholder: 'AC…' }), field('intro-tw-token', 'Auth Token', { type: 'password', placeholder: 'Paste your Auth Token' }));
      const save = el('button', 'btn primary intro-small', 'Save to Keychain');
      save.type = 'submit';
      form.append(save);
      form.addEventListener('submit', (e) => {
        e.preventDefault();
        const sid = $('intro-tw-sid').value.trim();
        const token = $('intro-tw-token').value.trim();
        if (!sid || !token) { S.phoneNote = 'Add both the Account SID and the Auth Token.'; fill(); return; }
        $('intro-tw-token').value = '';
        S.phoneNote = 'Saving…';
        F.send({ type: 'phone_credentials', sid, token });
        fill();
      });
      body.push(form);
    }
    const numbers = el('div', 'intro-form-stack');
    numbers.append(
      field('intro-tw-from', 'Your Twilio number', { placeholder: '+1 415 555 0100', value: p.phone_from || '', change: (v) => setPrefs({ phone_from: v }) }),
      field('intro-tw-me', 'Your own number', { placeholder: '+1 415 555 0199', value: p.phone_me || '', change: (v) => setPrefs({ phone_me: v }) }),
    );
    body.push(numbers);
    const call = button('Call me now', phoneReady() ? 'btn primary' : 'btn', () => { S.phoneNote = 'Calling…'; S.phoneAsked = true; F.send({ type: 'phone_test' }); fill(); });
    call.id = 'intro-tw-call';
    call.disabled = !phoneReady();
    const row = el('div', 'intro-actions');
    row.append(call);
    body.push(row);
    if (S.phoneCalled) body.push(el('p', 'intro-status', 'Your phone should ring now.'));
    else if (S.phoneNote) body.push(el('p', 'intro-note', S.phoneNote));
    const more = el('details', 'intro-more');
    more.append(el('summary', '', 'Good to know'));
    more.append(el('ul', 'intro-bullets'));
    for (const text of [
      'On a free trial, calls start with Twilio’s trial message (press a key to hear Jarvis), and Jarvis can call only numbers you’ve verified in Twilio, in your own country.',
      'To drop both, upgrade: press Upgrade in the Twilio Console, then add a payment method and a starting balance.',
      'To call another country, allow it in the Console’s Voice geographic permissions (search for Geo permissions).',
    ]) more.lastChild.append(el('li', '', text));
    body.push(more);
    return {
      visual: tile('keys', 'green'), compact: true, ok: S.phoneCalled, later: true, skipTo: 'iphone-calls', title: 'Connect Twilio',
      lead: 'Paste your Account SID and Auth Token: they go into your Mac’s Keychain. Then the numbers, and a test call.', body,
    };
  }

  function wakeCallCard() {
    const p = S.prefs || {};
    const body = [switchRow('Wake-up call', 'Jarvis rings you with the morning brief.', p.wake_call, () => setPrefs({ wake_call: !p.wake_call }), 'intro-wake-call')];
    const time = el('label', 'intro-row');
    time.htmlFor = 'intro-wake-time';
    const tl = el('span', 'intro-row-text');
    tl.append(el('strong', '', 'Call at'));
    const input = el('input', 'intro-time');
    input.type = 'time';
    input.id = 'intro-wake-time';
    input.value = p.wake_call_time || '07:00';
    input.addEventListener('change', () => { if (/^\d\d:\d\d$/.test(input.value)) setPrefs({ wake_call_time: input.value }); });
    time.append(tl, input);
    body.push(time);
    if (!phoneReady()) body.push(para('Wake-up calls need Twilio set up (the cards before this one).', 'intro-note warn'));
    else body.push(para('Jarvis needs to be running on this Mac at that time.', 'intro-note'));
    return {
      visual: tile('alarm', 'green'), ok: Boolean(p.wake_call && phoneReady()), later: true, title: 'A wake-up call',
      lead: 'Start the day with Jarvis on the phone: your calendar, the weather and the news.', body,
    };
  }

  function modelsCard() {
    const kind = MODEL_KINDS[S.modelKind];
    const mine = ((S.providers && S.providers.providers) || []).filter((x) => x.kind !== 'anthropic');
    const body = [];
    if (mine.length) {
      const list = el('ul', 'intro-list');
      for (const x of mine) {
        const li = el('li', 'intro-item');
        li.dataset.provider = x.id;
        const text = el('div', 'intro-item-text');
        text.append(data(el('strong', '', x.name || x.kind_name)), data(el('small', '', x.key_hint || '')));
        const check = S.modelChecks[x.id];
        const side = el('div', 'intro-item-side');
        if (check) side.append(check.ok ? pill('ok', 'Works') : pill('bad', 'Didn’t work'));
        else if (x.id === S.modelNew) side.append(pill('info', 'Checking…'));
        else side.append(pill('ok', 'Added'));
        li.append(text, side);
        if (check && !check.ok && check.error) li.append(data(el('p', 'intro-note warn intro-wide', check.error)));
        list.append(li);
      }
      body.push(list);
    }
    const seg = el('div', 'segmented intro-seg');
    seg.setAttribute('role', 'radiogroup');
    seg.setAttribute('aria-label', 'Provider');
    for (const [id, k] of Object.entries(MODEL_KINDS)) {
      const b = data(el('button', '', k.name));
      b.type = 'button';
      b.setAttribute('role', 'radio');
      b.dataset.kind = id;
      b.setAttribute('aria-checked', String(S.modelKind === id));
      b.addEventListener('click', () => { S.modelKind = id; S.modelErr = ''; fill(); });
      seg.append(b);
    }
    body.push(seg);
    const first = kind.steps[0];
    body.push(steps([[el('span', '', first), link(kind.url, kind.open, 'btn intro-small intro-link')], ...kind.steps.slice(1)]));
    body.push(secretForm('intro-model-key', 'API key', kind.placeholder, S.modelBusy, (key) => {
      S.modelBusy = true;
      S.modelErr = '';
      S.knownProviders = new Set(((S.providers && S.providers.providers) || []).map((x) => x.id));
      F.send({ type: 'providers_add', kind: S.modelKind, name: '', key });
      fill();
    }, 'Add'));
    if (S.modelErr) body.push(para(S.modelErr, 'intro-note warn'));
    body.push(para('More models, and which one stands in, are in Settings › Models.', 'intro-note intro-center'));
    const ok = mine.some((x) => S.modelChecks[x.id] && S.modelChecks[x.id].ok);
    return {
      visual: tile('chip', 'indigo'), compact: true, ok, later: true, title: 'A second AI, just in case',
      lead: 'When Claude can’t answer (a usage limit, an outage), Jarvis carries on with another model. Optional.', body,
    };
  }

  // ── the sheet ──

  function layer() {
    if ($('intro')) return $('intro');
    const root = el('div', 'intro-layer');
    root.id = 'intro';
    root.hidden = true;
    const pop = el('section', 'intro-pop');
    pop.setAttribute('role', 'dialog');
    pop.setAttribute('aria-modal', 'true');
    pop.setAttribute('aria-labelledby', 'intro-title');
    const top = el('header', 'intro-top');
    const back = el('button', 'intro-back');
    back.type = 'button';
    back.id = 'intro-back';
    back.setAttribute('aria-label', 'Go back');
    back.append(svg('back', 18));
    back.addEventListener('click', () => go(-1));
    const skip = button('Skip setup', 'intro-skip', () => { F.send({ type: 'ops_setup', state: 'skipped' }); close(); });
    skip.id = 'intro-skip';
    top.append(back, skip);
    const stage = el('div', 'intro-stage');
    stage.id = 'intro-stage';
    const foot = el('footer', 'intro-foot');
    const next = button('Continue', 'btn primary intro-primary', () => primary());
    next.id = 'intro-next';
    const later = button('Not now', 'intro-later', () => notNow());
    later.id = 'intro-later';
    const dots = el('ol', 'intro-dots');
    dots.id = 'intro-dots';
    const live = el('p', 'sr-only');
    live.id = 'intro-live';
    live.setAttribute('aria-live', 'polite');
    foot.append(next, later, dots, live);
    pop.append(top, stage, foot);
    pop.addEventListener('keydown', trapTab);
    root.append(el('div', 'intro-scrim'), pop);
    document.body.append(root);
    return root;
  }

  function trapTab(e) {
    if (e.key !== 'Tab') return;
    const pop = e.currentTarget;
    const stops = [...pop.querySelectorAll('button:not([disabled]), a[href], input, select, summary, [tabindex="0"]')].filter((n) => n.offsetParent !== null);
    if (!stops.length) return;
    const first = stops[0];
    const last = stops[stops.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  }

  let returnFocus = null;
  let pollTimer = null;
  function isOpen() { const l = $('intro'); return Boolean(l && !l.hidden); }

  function open(card) {
    const root = layer();
    if (!isOpen()) returnFocus = document.activeElement;
    S.autoShown = true;
    if (typeof toggleSettings === 'function' && $('settings') && !$('settings').hidden) toggleSettings(false);
    const opsLayer = $('ops-layer');
    if (opsLayer && !opsLayer.hidden) { const x = $('ops-close'); if (x) x.click(); }
    root.hidden = false;
    S.open = true;
    F.send({ type: 'connectors' }); // the accounts cards are made from the catalog
    show(card && cardIds().includes(card) ? card : 'welcome', 1);
  }

  function close() {
    const root = $('intro');
    if (!root || root.hidden) return;
    root.hidden = true;
    S.open = false;
    stopPoll();
    const back = returnFocus;
    returnFocus = null;
    if (back && document.contains(back) && typeof back.focus === 'function') back.focus({ preventScroll: true });
  }

  function finish() {
    F.send({ type: 'ops_setup', state: 'done' });
    close();
  }

  function go(step) {
    const ids = cardIds();
    const i = ids.indexOf(S.card);
    const n = Math.max(0, Math.min(ids.length - 1, (i < 0 ? 0 : i) + step));
    if (ids[n] !== S.card) show(ids[n], step);
  }
  function primary() { if (S.card === 'done') finish(); else go(1); }
  function notNow() {
    const s = spec(S.card);
    if (s.skipTo && cardIds().includes(s.skipTo)) show(s.skipTo, 1); else go(1);
  }

  function stopPoll() { if (pollTimer) { clearInterval(pollTimer); pollTimer = null; } }

  // What a card asks the hub for as it comes in.
  function enter(id) {
    stopPoll();
    if (id === 'mic' || id === 'permissions') {
      F.send({ type: 'ops_permissions' });
      pollTimer = setInterval(() => { if (document.hasFocus()) F.send({ type: 'ops_permissions' }); }, 4000);
    }
    if (id === 'claude') { F.send({ type: 'ops_claude' }); F.send({ type: 'signin_state' }); }
    if (id === 'talk' || id === 'wake') { const t = S[id]; if (t.phase !== 'done') S[id] = { phase: '', heard: '', reply: '', rid: '' }; }
    if (id === 'voice-id') F.send({ type: 'voice_id_status' });
    if (id === 'voice') F.send({ type: 'voice_status' });
    if (id.startsWith('accounts:')) F.send({ type: 'connectors' });
    if (id === 'twilio' || id === 'twilio-keys' || id === 'wake-call') F.send({ type: 'phone_status' });
    if (id === 'models') F.send({ type: 'providers_list' });
  }

  function show(id, dir) {
    S.card = id;
    const stage = $('intro-stage');
    const old = $('intro-card');
    const card = el('article', 'intro-card');
    card.dataset.card = id;
    card.classList.add(dir < 0 ? 'from-left' : 'from-right');
    if (old) { old.removeAttribute('id'); old.remove(); }
    card.id = 'intro-card';
    stage.append(card);
    enter(id);
    if (spec(id).ok) S.celebrated.add(id); // done before: shown as done, no fanfare
    fill();
    const title = $('intro-title');
    if (title) title.focus({ preventScroll: true });
  }

  // The current card drawn again (an event changed what it shows): what's typed in its
  // fields, the focus and the scroll stay as they were.
  function fill() {
    const card = $('intro-card');
    if (!card || !S.open) return;
    const typed = new Map();
    card.querySelectorAll('input[id]').forEach((i) => typed.set(i.id, i.value));
    const active = document.activeElement && card.contains(document.activeElement) ? document.activeElement.id : '';
    const caret = active && $(active) && typeof $(active).selectionStart === 'number' ? [$(active).selectionStart, $(active).selectionEnd] : null;
    const scroll = card.scrollTop;
    const s = spec(S.card);
    const visual = el('div', 'intro-visual');
    visual.append(s.visual);
    const fresh = s.ok && !S.celebrated.has(S.card);
    if (s.ok && S.card !== 'done') {
      const badge = el('span', fresh ? 'intro-check pop' : 'intro-check');
      badge.append(svg('check', 18));
      visual.append(badge);
    }
    if (fresh) {
      S.celebrated.add(S.card);
      visual.classList.add('yay');
      $('intro-live').textContent = s.title;
    }
    card.dataset.ok = String(Boolean(s.ok));
    card.classList.toggle('compact', Boolean(s.compact));
    const title = el('h2', 'intro-title', s.title);
    title.id = 'intro-title';
    title.tabIndex = -1;
    const nodes = [visual, title];
    if (s.lead) nodes.push(el('p', 'intro-lead', s.lead));
    const body = el('div', 'intro-body');
    body.append(...(s.body || []));
    nodes.push(body);
    const wasFocusTitle = document.activeElement && document.activeElement.id === 'intro-title';
    card.replaceChildren(...nodes);
    for (const [id, value] of typed) { const i = $(id); if (i && card.contains(i)) i.value = value; }
    if (active && $(active) && card.contains($(active))) {
      $(active).focus({ preventScroll: true });
      if (caret) { try { $(active).setSelectionRange(caret[0], caret[1]); } catch (_) { /* not a text field */ } }
    } else if (wasFocusTitle) title.focus({ preventScroll: true });
    card.scrollTop = scroll;
    // the footer
    const next = $('intro-next');
    next.textContent = s.primary || 'Continue';
    const later = $('intro-later');
    later.hidden = !s.later || Boolean(s.ok);
    $('intro-back').hidden = S.card === 'welcome';
    const at = SECTIONS.findIndex(([sid]) => sid === sectionOf(S.card));
    const dots = $('intro-dots');
    dots.setAttribute('aria-label', 'Setup progress');
    dots.replaceChildren(...SECTIONS.map(([sid, label], i) => {
      const li = el('li', i === at ? 'on' : i < at ? 'done' : '');
      li.dataset.section = sid;
      li.title = label;
      if (i === at) li.setAttribute('aria-current', 'step');
      return li;
    }));
  }

  // ── the hub's events ──

  F.on('hello', (ev) => {
    if (ev.prefs) S.prefs = ev.prefs;
    S.hubState = ev.state || 'idle';
  }, { replay: true });

  F.on('prefs', (ev) => {
    const handsBefore = Boolean(S.prefs && S.prefs.hands_free);
    S.prefs = ev;
    if (!handsBefore && ev.hands_free && S.card === 'wake') S.wake = { phase: '', heard: '', reply: '', rid: '' };
    if (S.open) fill();
  });

  F.on('ops_state', (ev) => {
    if (ev.setup && ev.setup.show && !S.autoShown) open();
  }, { replay: true });

  F.on('ops_permissions', (ev) => { S.perms = ev; if (S.open && (S.card === 'mic' || S.card === 'permissions')) fill(); });
  F.on('ops_claude', (ev) => { S.claude = ev; if (S.open && S.card === 'claude') fill(); });
  F.on('signin', (ev) => {
    const changed = !S.signin || S.signin.mode !== ev.mode;
    S.signin = ev;
    S.signinBusy = false;
    if (changed && S.open && S.card === 'claude') F.send({ type: 'ops_claude' });
    if (S.open && S.card === 'claude') fill();
  });
  F.on('ops_voice', (ev) => { S.voiceMuted = Boolean(ev.muted); if (S.open && S.card === 'voice') fill(); });
  F.on('voice_id', (ev) => { S.voiceId = ev; if (S.open && S.card === 'voice-id') fill(); }, { replay: true });
  F.on('voice', (ev) => { S.voice = ev; S.voiceBusy = false; if (S.open && S.card === 'voice') fill(); });

  F.on('ops_mic', (ev) => {
    const m = S.mic;
    if (ev.state === 'level') {
      const level = Number(ev.level) || 0;
      m.peak = Math.max(m.peak, level);
      m.bars = [...m.bars, level].slice(-BARS);
      const bars = $('intro-bars');
      if (bars) [...bars.children].forEach((b, i) => { b.style.height = `${6 + Math.round((m.bars[m.bars.length - BARS + i] || 0) * 46)}px`; });
      if (m.peak >= HEARD && !S.celebrated.has('mic') && S.open && S.card === 'mic') fill();
      return;
    }
    if (ev.state === 'metered') m.peak = Math.max(m.peak, Number(ev.peak) || 0);
    S.mic = { ...m, state: ev.state, text: ev.text || '' };
    if (S.open && S.card === 'mic') fill();
  });

  // Try it: the hub's own events say it heard and answered.
  F.on('state', (ev) => {
    S.hubState = ev.value || 'idle';
    if (!S.open) return;
    const t = S.card === 'talk' || S.card === 'wake' ? S[S.card] : null;
    if (t && S.card === 'talk' && ev.value === 'listening' && t.phase !== 'done') S.talk = { phase: 'listening', heard: '', reply: '', rid: '' };
    else if (t && ev.value === 'idle' && t.phase === 'listening') t.phase = 'missed';
    const o = document.querySelector('#intro-card .intro-orb');
    if (o) o.dataset.state = S.hubState;
    if (t) fill();
  });
  F.on('heard', (ev) => {
    if (!S.open || (S.card !== 'talk' && S.card !== 'wake')) return;
    const t = S[S.card];
    if (t.phase === 'done') return;
    const text = String(ev.text || '').trim();
    if (S.card === 'talk' && t.phase !== 'listening' && t.phase !== 'missed') return;
    if (S.card === 'wake' && !(S.prefs && S.prefs.hands_free)) return;
    S[S.card] = text ? { phase: 'heard', heard: text, reply: '', rid: '' } : { ...t, phase: 'missed' };
    fill();
  });
  F.on('turn', (ev) => {
    if (!S.open || (S.card !== 'talk' && S.card !== 'wake')) return;
    const t = S[S.card];
    if (t.phase !== 'heard' || !ev.user) return;
    t.rid = ev.rid || '';
  });
  F.on('reply', (ev) => {
    if (!S.open || (S.card !== 'talk' && S.card !== 'wake')) return;
    const t = S[S.card];
    const text = String(ev.text || '').trim();
    if (!text) return;
    if (t.phase === 'heard' && (!t.rid || ev.rid === t.rid)) { t.phase = 'done'; t.rid = ev.rid || t.rid; }
    if (t.phase === 'done' && (!t.rid || ev.rid === t.rid)) { t.reply = text; fill(); }
  });
  F.on('ui', (ev) => {
    if (ev.action !== 'hands' || !ev.on || !S.open || S.card !== 'clap') return;
    S.clap = true;
    fill();
  });

  F.on('connectors', (ev) => {
    S.connectors = ev;
    if (!S.open) return;
    if (S.card === 'accounts:') { const first = cardIds().find((x) => x.startsWith('accounts:')); if (first && first !== 'accounts:') { show(first, 1); return; } }
    if (S.card.startsWith('accounts:')) fill();
  });
  F.on('connector_error', (ev) => {
    S.connErr = { id: ev.id || '', text: ev.text || '' };
    if (S.open && S.card.startsWith('accounts:')) fill();
  });

  F.on('phone_status', (ev) => {
    S.phone = ev;
    if (ev.note !== undefined) {
      S.phoneNote = String(ev.note || '');
      if (S.phoneAsked && ev.note === CALLING) S.phoneCalled = true;
      if (S.phoneAsked && ev.note !== CALLING && ev.note) S.phoneAsked = false;
    }
    if (S.open && (S.card === 'twilio' || S.card === 'twilio-keys' || S.card === 'wake-call')) fill();
  });

  F.on('providers', (ev) => {
    S.providers = ev;
    if (S.modelBusy && S.knownProviders) {
      const added = (ev.providers || []).find((x) => !S.knownProviders.has(x.id) && x.kind !== 'anthropic');
      if (added) {
        S.modelBusy = false;
        S.knownProviders = null;
        S.modelNew = added.id;
        F.send({ type: 'providers_check', id: added.id });
      }
    }
    if (S.open && S.card === 'models') fill();
  });
  F.on('providers_check', (ev) => {
    S.modelChecks[ev.id] = { ok: Boolean(ev.ok), error: ev.error || '' };
    if (ev.id === S.modelNew) S.modelNew = '';
    if (S.open && S.card === 'models') fill();
  });
  F.on('providers_error', (ev) => {
    if (!S.modelBusy) return;
    S.modelBusy = false;
    S.knownProviders = null;
    S.modelErr = ev.text || '';
    if (S.open && S.card === 'models') fill();
  });

  // Escape closes the intro (it shows again at the next start until finished or skipped).
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || !isOpen()) return;
    e.preventDefault();
    e.stopPropagation();
    close();
  }, true);

  window.addEventListener('focus', () => {
    if (!S.open) return;
    if (S.card === 'mic' || S.card === 'permissions') F.send({ type: 'ops_permissions' });
    if (S.card === 'claude') F.send({ type: 'ops_claude' });
    if (S.card.startsWith('accounts:')) F.send({ type: 'connectors' });
  });

  window.jarvisIntro = { open: (card) => open(card), close: () => close(), isOpen: () => isOpen(), card: () => S.card };
})();
