// The first-run walkthrough of J.A.R.V.I.S. Daredevil (features/accessibility_setup.py), and the
// trusted person in Settings › Accessibility (features/accessibility_helper.py).
//
// The first time the window opens in screen-reader mode, a dialog walks through the setup one
// step at a time: the speaking speed, colours and text size, who reads the replies, the keys, an
// email account and a trusted person. Each step is announced and takes the focus; Tab stays in
// the dialog; Escape (or "skip setup") ends it. Everything can be said instead: the backend hears
// "next", "back", "finish", "say that again", "play a sample" and the choices themselves, and
// sends "a11y_setup_cmd" here. Alt+Shift+W, "run setup again" or the button in Settings opens it
// again.
(function (root) {
  'use strict';

  const F = root.jarvisFeatures;
  const lib = root.jarvisAccessibility;
  if (!F || !lib || !lib.change || !root.document) return;
  const doc = root.document;
  const { el, send } = F;
  const t = (s) => F.t(s);
  const $ = (id) => doc.getElementById(id);
  const IS_MAC = /Mac|iPhone|iPad/i.test((root.navigator && root.navigator.platform) || '');
  const KEYS = IS_MAC ? 'Command Shift' : 'Alt Shift';

  let features = {}; // prefs.features as the backend last sent them
  let speed = 100; // the speaking speed, from the voice feature's "voice" event
  let dialog = null;
  let step = 0;
  let from = null; // what had the focus before the dialog opened
  let opened = false; // opened on its own this session (once)
  let paused = false; // closed for a moment while Settings › Email accounts is open

  // ── the steps ──

  function radios(label, key, options) {
    const wrap = el('div', 'segmented');
    wrap.setAttribute('role', 'radiogroup');
    wrap.setAttribute('aria-label', t(label));
    const now = lib.prefs()[key];
    for (const [value, name] of options) {
      const b = el('button', '', t(name));
      b.type = 'button';
      b.setAttribute('role', 'radio');
      b.dataset.value = value;
      b.setAttribute('aria-checked', String(String(now) === String(value)));
      b.addEventListener('click', () => {
        lib.change({ [key]: value });
        wrap.querySelectorAll('[role="radio"]').forEach((r) => r.setAttribute('aria-checked', String(r === b)));
        lib.announce(`${t(name)}.`);
      });
      wrap.append(b);
    }
    return wrap;
  }
  function button(label, run, cls = 'btn') {
    const b = el('button', cls, t(label));
    b.type = 'button';
    b.addEventListener('click', run);
    return b;
  }
  function setSpeed(next) {
    speed = Math.max(50, Math.min(250, next));
    send({ type: 'voice_settings', changes: { voice_speed: speed } });
    const status = $('a11y-setup-speed');
    if (status) status.textContent = t(`Speaking at ${speed} percent.`);
    lib.announce(`Speaking at ${speed} percent.`);
    send({ type: 'a11y_setup', open: true, step: 'speed', sample: true });
  }
  function stopLabel() {
    const shell = root.jarvisShell;
    return (shell && shell.stopLabel && shell.stopLabel()) || (IS_MAC ? '⌘⌥.' : 'Ctrl+Alt+Backspace');
  }
  const mailGroup = () => { const g = $('mail-group'); return g && !g.hidden ? g : null; };

  const STEPS = [
    {
      id: 'welcome',
      title: 'Welcome',
      words: () => `This short setup has ${STEPS.length - 2} steps. Answer with the keyboard, or by voice: say next, back, or skip setup. Tab moves between the choices.`,
      build: () => [],
    },
    {
      id: 'speed',
      title: 'Speaking speed',
      words: () => `How fast Jarvis’s own voice speaks. It is ${speed} percent now. Say faster or slower, or use the buttons. Your screen reader keeps its own speed.`,
      build: () => {
        const status = el('p', 'small-status', t(`Speaking at ${speed} percent.`));
        status.id = 'a11y-setup-speed';
        status.setAttribute('role', 'status');
        return [status, row([
          button('Slower', () => setSpeed(speed - 20)), button('Faster', () => setSpeed(speed + 20)), button('Normal speed', () => setSpeed(100)),
          button('Hear a sample', () => send({ type: 'a11y_setup', open: true, step: 'speed', sample: true })),
        ])];
      },
    },
    {
      id: 'look',
      title: 'Colours and text size',
      words: () => 'For low vision. Pick a colour pairing and a text size, or say yellow on black, white on black, black on yellow, yellow on blue, or larger text.',
      build: () => [
        radios('Colours', 'a11y_colors', [['auto', 'Auto'], ['yellow', 'Yellow on black'], ['white', 'White on black'], ['yellow-bg', 'Black on yellow'], ['yellow-blue', 'Yellow on blue'], ['off', 'Off']]),
        radios('Text size', 'a11y_text_size', [['auto', 'Auto'], ['normal', 'Normal'], ['large', 'Large'], ['larger', 'Larger'], ['largest', 'Largest']]),
      ],
    },
    {
      id: 'reader',
      title: 'Who reads the replies',
      words: () => 'Your screen reader, in your own voice and speed, or Jarvis’s voice. Auto uses your screen reader when one is running. Say my screen reader, or Jarvis’s voice.',
      build: () => [radios('Who reads the replies', 'a11y_voice', [['auto', 'Auto'], ['reader', 'My screen reader'], ['jarvis', 'Jarvis’s voice']])],
    },
    {
      id: 'keys',
      title: 'The keys',
      words: () => `Press ${lib.askKeys()} from any program to talk to Jarvis, and ${stopLabel()} to make it stop talking at once. In this window, ${KEYS} H lists the other keys, and ${KEYS} W brings back this setup. You can change the keys in Settings, General, Shortcuts.`,
      build: () => [],
    },
    {
      id: 'email',
      title: 'Your email',
      words: () => (mailGroup()
        ? 'Jarvis can read and send your email. Add an account now, or later in Settings, Email accounts. The setup carries on when you close Settings.'
        : (IS_MAC ? 'Jarvis uses the accounts in the Mail app. Nothing to add here.' : 'You can add an email account later, in Settings, Email accounts.')),
      build: () => (mailGroup() ? [button('Add an email account', openMail, 'btn primary')] : []),
    },
    {
      id: 'helper',
      title: 'A trusted person',
      words: () => 'Someone Jarvis can email when you need a hand: say send this to my helper, or I need help. Their name and email, and a phone number if you like. You can leave it empty.',
      build: () => helperFields('a11y-setup'),
    },
    {
      id: 'done',
      title: 'All set',
      words: () => `Setup is done. Say run setup again, or press ${KEYS} W, to come back to it. Press ${lib.askKeys()} to talk to Jarvis.`,
      build: () => [],
    },
  ];
  function row(children) {
    const r = el('div', 'row a11y-setup-row');
    r.append(...children);
    return r;
  }

  // ── the dialog ──

  function render() {
    const s = STEPS[step];
    dialog.replaceChildren();
    const heading = el('h2', '', `${t(`Step ${step + 1} of ${STEPS.length}`)}: ${t(s.title)}`);
    heading.id = 'a11y-setup-title';
    heading.tabIndex = -1;
    const words = el('p', '', t(s.words()));
    words.id = 'a11y-setup-words';
    const body = el('div', 'a11y-setup-body');
    body.append(...s.build().filter(Boolean));
    const nav = el('div', 'row a11y-setup-nav');
    const back = button('Back', () => go(step - 1));
    back.disabled = step === 0;
    const last = step === STEPS.length - 1;
    const next = button(last ? 'Finish' : 'Next', () => (last ? finish() : go(step + 1)), 'btn primary');
    nav.append(back, next);
    if (!last) nav.append(button('Skip setup', finish));
    dialog.append(heading, words, body, nav);
    heading.focus();
    lib.announce(`${t(`Step ${step + 1} of ${STEPS.length}`)}. ${t(s.title)}. ${t(s.words())}`);
    send({ type: 'a11y_setup', open: true, step: s.id });
  }
  function go(to) {
    if (!dialog) return;
    if (STEPS[step].id === 'helper' && !saveHelper('a11y-setup')) return; // (it said what to fix)
    step = Math.max(0, Math.min(STEPS.length - 1, to));
    render();
  }
  function trap(e) {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish(); return; }
    if (e.key !== 'Tab') return;
    const stops = [...dialog.querySelectorAll('button, input, [tabindex="0"]')].filter((n) => !n.disabled && n.tabIndex !== -1);
    if (!stops.length) return;
    const at = stops.indexOf(doc.activeElement);
    const to = e.shiftKey ? (at <= 0 ? stops.length - 1 : at - 1) : (at < 0 || at === stops.length - 1 ? 0 : at + 1);
    e.preventDefault();
    stops[to].focus();
  }
  function open(at = 0) {
    if (dialog) { render(); return; }
    paused = false;
    from = doc.activeElement;
    dialog = el('div', 'sr-help a11y-setup');
    dialog.id = 'a11y-setup';
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    dialog.setAttribute('aria-labelledby', 'a11y-setup-title');
    dialog.setAttribute('aria-describedby', 'a11y-setup-words');
    dialog.addEventListener('keydown', trap);
    doc.body.append(dialog);
    step = at;
    render();
  }
  function close() {
    if (!dialog) return;
    dialog.remove();
    dialog = null;
    if (from && from.isConnected && from !== doc.body) from.focus();
  }
  function finish() {
    if (dialog && STEPS[step].id === 'helper') saveHelper('a11y-setup');
    close();
    paused = false;
    send({ type: 'a11y_setup', open: false, done: true });
    lib.announce(`Setup closed. ${KEYS} W brings it back.`);
  }

  // Adding an email account happens in Settings: the dialog steps aside, and comes back on the next
  // step when Settings closes.
  function openMail() {
    paused = true;
    const at = step;
    close();
    const sheet = $('settings');
    if (sheet && sheet.hidden) { const opener = $('settings-btn'); if (opener) opener.click(); }
    root.setTimeout(() => {
      const group = mailGroup();
      const first = group && group.querySelector('input, button');
      if (first) { first.scrollIntoView({ block: 'center' }); first.focus(); }
      lib.announce('Email accounts. When you have added one, press Escape to close Settings, and the setup carries on.');
    }, 100);
    if (sheet) {
      const watch = new MutationObserver(() => {
        if (!sheet.hidden) return;
        watch.disconnect();
        if (paused) open(Math.min(at + 1, STEPS.length - 1));
      });
      watch.observe(sheet, { attributes: true, attributeFilter: ['hidden'] });
    }
  }

  // ── the trusted person (in the setup, and in Settings › Accessibility) ──

  const HELPER = [['name', 'Name', 'a11y_helper_name', 'text', 'name'], ['email', 'Email address', 'a11y_helper_email', 'email', 'email'], ['phone', 'Phone (optional)', 'a11y_helper_phone', 'tel', 'tel']];
  function helperFields(prefix) {
    const out = [];
    for (const [id, label, key, type, auto] of HELPER) {
      const wrap = el('label', 'a11y-field');
      const input = el('input');
      input.id = `${prefix}-helper-${id}`;
      input.type = type;
      input.autocomplete = `off`;
      input.dataset.auto = auto;
      input.value = features[key] || '';
      wrap.append(el('span', '', t(label)), input);
      out.push(wrap);
    }
    const status = el('p', 'small-status');
    status.id = `${prefix}-helper-status`;
    status.setAttribute('role', 'status');
    out.push(row([button('Save', () => saveHelper(prefix))]), status);
    return out;
  }
  const EMAIL = /^[^@\s]+@[^@\s]+\.[A-Za-z]{2,}$/;
  function saveHelper(prefix, quiet = false) {
    const value = (id) => { const n = $(`${prefix}-helper-${id}`); return n ? n.value.trim() : null; };
    const name = value('name');
    if (name === null) return false;
    const email = value('email');
    const phone = value('phone');
    const status = $(`${prefix}-helper-status`);
    const say = (words) => { if (status) status.textContent = t(words); if (!quiet) lib.announce(words); };
    if (email && !EMAIL.test(email)) { say('That email address is not complete. Check it and save again.'); return false; }
    if (phone && !/^[+\d][\d ()./-]{0,29}$/.test(phone)) { say('The phone number can have digits, spaces and a plus sign only.'); return false; }
    const changes = { a11y_helper_name: name, a11y_helper_email: email, a11y_helper_phone: phone };
    if (Object.entries(changes).every(([k, v]) => (features[k] || '') === v)) return true;
    lib.change(changes);
    features = { ...features, ...changes };
    say(name || email ? `Saved. Your trusted person is ${name || email}.` : 'Saved. No trusted person is set.');
    return true;
  }

  function buildSettings() {
    const more = $('a11y-more');
    if (!more || $('a11y-helper-group')) return Boolean(more);
    const box = el('div', 'a11y-helper-group');
    box.id = 'a11y-helper-group';
    box.setAttribute('role', 'group');
    box.setAttribute('aria-labelledby', 'a11y-helper-title');
    const title = el('h4', '', t('Trusted person'));
    title.id = 'a11y-helper-title';
    box.append(title, el('p', 'group-note', t('Someone Jarvis can email when you need a hand: say “send this to my helper” or “I need help”. A picture of your screen goes only when you ask for one.')));
    box.append(...helperFields('a11y-settings'));
    const again = button('Run the setup again', () => open(0));
    again.id = 'a11y-setup-again';
    more.append(box, row([again]));
    return true;
  }
  function fillSettings() {
    for (const [id, , key] of HELPER) {
      const input = $(`a11y-settings-helper-${id}`);
      if (input && doc.activeElement !== input) input.value = features[key] || '';
    }
  }

  // ── when it opens on its own ──

  function maybeOpen() {
    if (opened || dialog || paused || features.a11y_setup_done === true || !lib.prefsSeen() || lib.inEdenCode() || !lib.effective()) return;
    opened = true;
    root.setTimeout(() => { if (!dialog && lib.effective()) open(0); }, 600); // (after the welcome is said)
  }

  F.on('prefs', (ev) => {
    features = { ...((ev && ev.features) || {}) };
    if (!buildSettings()) root.setTimeout(buildSettings, 0);
    fillSettings();
    maybeOpen();
  }, { replay: true });
  F.on('a11y', maybeOpen);
  F.on('voice', (ev) => { if (ev && typeof ev.speed === 'number') speed = ev.speed; }, { replay: true });
  F.on('a11y_setup_cmd', (ev) => {
    const action = ev && ev.action;
    if (action === 'open') open(0);
    else if (!dialog) return;
    else if (action === 'next') { if (step === STEPS.length - 1) finish(); else go(step + 1); }
    else if (action === 'back') go(step - 1);
    else if (action === 'finish') finish();
    else if (action === 'repeat') render();
  });

  lib.setup = { open, finish, state: () => ({ open: Boolean(dialog), step: dialog ? STEPS[step].id : '', steps: STEPS.map((s) => s.id) }) };
})(typeof window !== 'undefined' ? window : globalThis);
