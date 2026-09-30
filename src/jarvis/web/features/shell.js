// The Mac app's shell, window side (app/features/shell.js is the other half): tells the app
// what JARVIS is doing for the menu bar icon and which cards wait for an OK (the Dock's
// badge, their notifications), hands it heads-ups to raise as macOS notifications, carries
// out what its menus and notifications ask over this window's connection, and adds the
// "This Mac" group to Settings (the menu bar icon, the global shortcuts).
(() => {
  // ── pure helpers (tests/web/shell.test.mjs requires this file for them) ──

  const CODE_KEYS = {
    Space: 'Space', Enter: 'Return', NumpadEnter: 'Return', Tab: 'Tab', Backspace: 'Backspace', Delete: 'Delete',
    ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right', Home: 'Home', End: 'End',
    PageUp: 'PageUp', PageDown: 'PageDown', Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']',
    Backslash: '\\', Semicolon: ';', Quote: "'", Comma: ',', Period: '.', Slash: '/', Backquote: '`',
  };

  // The key of a keydown as an accelerator names it: by its place on the keyboard (⌥ changes
  // the letter a key types, never where it is), or '' for a modifier, Escape or the like.
  function keyOf(code) {
    if (/^Key[A-Z]$/.test(code)) return code.slice(3);
    if (/^Digit[0-9]$/.test(code)) return code.slice(5);
    if (/^F([1-9]|1[0-9]|2[0-4])$/.test(code)) return code;
    return CODE_KEYS[code] || '';
  }

  // The key combination pressed, as an Electron accelerator ('' while only modifiers are held).
  function acceleratorFromKey(e) {
    const key = keyOf(String(e.code || ''));
    if (!key) return '';
    return [e.metaKey && 'Command', e.ctrlKey && 'Control', e.altKey && 'Alt', e.shiftKey && 'Shift', key].filter(Boolean).join('+');
  }

  // The modifiers held while a shortcut is being typed, as the Mac writes them.
  function heldLabel(e) {
    return [e.ctrlKey && '⌃', e.altKey && '⌥', e.shiftKey && '⇧', e.metaKey && '⌘'].filter(Boolean).join('');
  }

  if (typeof module === 'object' && module.exports) module.exports = { keyOf, acceleratorFromKey, heldLabel };
  if (typeof window === 'undefined' || !window.jarvisFeatures) return;

  const F = window.jarvisFeatures;
  const bridge = window.jarvisApp && window.jarvisApp.feature ? window.jarvisApp.feature : null;
  const CH = 'feature:shell:';
  // English for the page, which i18n.js translates as it appears (the tests find these).
  // What goes to the app (its menus, notifications) is translated here, with F.t.
  const en = (text) => text;
  const SHORTCUT_PREFS = { ask: 'shell_shortcut_ask', whatsThis: 'shell_shortcut_whats_this' };
  const SHORTCUT_DEFAULTS = { ask: 'Alt+Space', whatsThis: 'Alt+Shift+Space' };

  // What the app reports, as the window last heard it.
  const seen = { state: 'idle', muted: false, prefs: null };
  let ready = false; // the app's side answered hello
  let online = false;
  let canNotify = false; // the app raises notifications itself (not in the test window)
  const approvals = new Map(); // the cards waiting for an OK, as the hub sent them
  let keyStatus = null; // the global shortcuts, as the app has them: { live, ask: {accelerator, label, error}, whatsThis }

  const feature = (key, fallback) => {
    const features = (seen.prefs && seen.prefs.features) || {};
    return key in features ? features[key] : fallback;
  };
  const pausedUntil = () => Math.max(0, Number(feature('shell_pause_until', 0)) || 0) * 1000;

  function labels() {
    const t = F.t;
    const until = pausedUntil();
    return {
      idle: t('Ready'),
      listening: t('Listening…'),
      thinking: t('Thinking…'),
      speaking: t('Speaking…'),
      offline: t('Reconnecting…'),
      ask: t('Ask…'),
      mute: t('Mute'),
      unmute: t('Unmute'),
      handsFree: t('Hands-free'),
      pause: t('Pause heads-ups for an hour'),
      paused: t('Heads-ups paused'),
      pausedUntil: until > Date.now() ? t(`Heads-ups paused until ${clockText(until)}`) : '',
      resume: t('Resume heads-ups'),
      open: t('Open J.A.R.V.I.S.'),
      code: t('Jarvis Code'),
      browser: t('Browser'),
      quit: t('Quit J.A.R.V.I.S.'),
      needsOk: t('Needs your OK'),
      allow: t('Allow'),
      notNow: t('Not now'),
      purchaseHint: t('Say “confirm purchase”, or confirm it in J.A.R.V.I.S.'),
    };
  }

  // A card as the app's notification needs it: its words, and its buttons' in this language.
  function forApp(a) {
    return {
      id: String(a.id),
      question: String(a.question || ''),
      detail: String(a.detail || ''),
      choices: (a.choices || []).map((c) => ({ id: String(c.id), label: F.t(String(c.label || '')) })),
      askKind: String(a.ask_kind || ''),
      task: Number.isFinite(a.task_id) ? a.task_id : null,
    };
  }
  const sendApprovals = () => { if (ready) bridge.send(`${CH}approvals`, { items: [...approvals.values()].map(forApp) }); };

  // ── reporting to the app ──

  let reported = '';
  let reportSoon = 0;
  function report() {
    if (!bridge || !ready || reportSoon) return;
    reportSoon = setTimeout(() => {
      reportSoon = 0;
      const msg = {
        state: seen.state,
        online,
        muted: seen.muted,
        handsFree: Boolean(seen.prefs && seen.prefs.hands_free),
        pausedUntil: pausedUntil(),
        menuBar: feature('shell_menu_bar', true) !== false,
        shortcuts: {
          ask: feature(SHORTCUT_PREFS.ask, SHORTCUT_DEFAULTS.ask),
          whatsThis: feature(SHORTCUT_PREFS.whatsThis, SHORTCUT_DEFAULTS.whatsThis),
        },
        labels: labels(),
      };
      const sign = JSON.stringify(msg);
      if (sign === reported) return;
      reported = sign;
      bridge.send(`${CH}state`, msg);
    }, 0);
  }

  // Labels follow the language: once its Chinese strings have loaded.
  function afterLanguage(prefs) {
    const lang = (prefs && prefs.language) || 'en';
    Promise.resolve(window.jarvisI18n ? window.jarvisI18n.setLang(lang) : null).then(report, report);
  }

  // ── what the app's menus and notifications ask ──

  // A card opened from its notification: brought into view with a soft pulse.
  function flash(card) {
    card.scrollIntoView({ block: 'nearest' });
    card.classList.remove('shell-flash');
    void card.offsetWidth; // restart the animation
    card.classList.add('shell-flash');
    setTimeout(() => card.classList.remove('shell-flash'), 2000);
  }

  function openTask(id) {
    if (F.$('cc').hidden) toggleCC(true);
    selectTask(id);
  }

  function reveal(cmd) {
    if (cmd.what === 'approval') {
      if (Number.isFinite(cmd.task)) { openTask(cmd.task); return; } // Jarvis Code's, in its session
      const card = F.$('cards').querySelector(`[data-approval="${CSS.escape(String(cmd.id))}"]`);
      if (card) flash(card);
      return;
    }
    if (cmd.what !== 'alert') return;
    const key = String(cmd.key || '');
    const code = /^code(?:-ok)?:(\d+):/.exec(key); // Jarvis Code finished, or needs you
    if (code) { openTask(Number(code[1])); return; }
    let card = key ? F.$('cards').querySelector(`[data-alert="${CSS.escape(key)}"]`) : null;
    if (!card) { // its card timed out: back, for another minute
      card = notice(ALERT_KICKERS[cmd.kind] || 'Heads-up', String(cmd.title || ''), String(cmd.text || ''), 60000);
      card.dataset.alert = key;
    }
    flash(card);
  }

  function openPanel(panel) {
    if (panel === 'settings') { if (F.$('settings').hidden) toggleSettings(true); }
    else if (panel === 'code') { if (F.$('cc').hidden) toggleCC(true); }
    else if (panel === 'browser') toggleBrowser(true);
    else if (panel === 'brain') setGalaxyMode('open');
  }

  function run(cmd) {
    if (!cmd || typeof cmd !== 'object') return;
    switch (cmd.action) {
      case 'mute': F.send({ type: 'mute', value: true }); break;
      case 'unmute': F.send({ type: 'mute', value: false }); break;
      case 'hands-free': F.send({ type: 'set_prefs', changes: { hands_free: !(seen.prefs && seen.prefs.hands_free) } }); break;
      case 'pause': F.send({ type: 'shell_pause', minutes: 60 }); break;
      case 'resume': F.send({ type: 'shell_pause', minutes: 0 }); break;
      case 'open': openPanel(cmd.panel); break;
      case 'approve':
        if (approvals.has(cmd.id) && ['allow', 'deny'].includes(cmd.choice)) F.send({ type: 'approve', id: cmd.id, choice: cmd.choice });
        break;
      case 'reveal': reveal(cmd); break;
      default: break;
    }
  }

  // ── Settings › This Mac ──

  function switchRow(id, title, note) {
    const row = F.el('div', 'row');
    const words = F.el('span');
    words.append(F.el('strong', '', title));
    if (note) words.append(F.el('small', '', note));
    const sw = F.el('button', 'switch');
    sw.type = 'button';
    sw.id = id;
    sw.setAttribute('role', 'switch');
    sw.setAttribute('aria-checked', 'false');
    sw.setAttribute('aria-label', title);
    row.append(words, sw);
    return row;
  }

  // A global shortcut: its keys, and Change… to type new ones.
  function shortcutRow(slot, title, note) {
    const row = F.el('div', 'row shell-key-row');
    const words = F.el('span');
    words.append(F.el('strong', '', title), F.el('small', '', note));
    const keys = F.el('span', 'shell-key');
    const cap = F.el('kbd');
    cap.id = `shell-key-${slot}`;
    const change = F.el('button', 'btn', 'Change…');
    change.type = 'button';
    change.id = `shell-rec-${slot}`;
    change.addEventListener('click', () => (recordingSlot === slot ? stopRecording() : startRecording(slot)));
    keys.append(cap, change);
    row.append(words, keys);
    return row;
  }

  let group = null;
  function buildGroup() {
    if (group || !bridge) return;
    group = F.el('section', 'group shell-group');
    group.id = 'shell-group';
    const note = F.el('p', 'small-status');
    note.id = 'shell-key-note';
    note.hidden = true;
    note.setAttribute('aria-live', 'polite');
    group.append(
      F.el('h3', '', 'This Mac'),
      switchRow('sw-shell-menubar', 'Show in the menu bar', 'What JARVIS is doing at a glance, and Ask, Mute, Hands-free and Pause heads-ups from any app.'),
      shortcutRow('ask', 'Talk', 'From any app: shows JARVIS and starts listening.'),
      shortcutRow('whatsThis', 'What’s this?', 'From any app: JARVIS explains what’s in front of you.'),
      note,
    );
    const settings = F.$('settings');
    const accounts = F.$('open-accounts');
    const last = accounts ? accounts.closest('section.group') : null;
    settings.insertBefore(group, last && last.parentElement === settings ? last : null);
    F.$('sw-shell-menubar').addEventListener('click', () => {
      F.send({ type: 'feature_prefs', changes: { shell_menu_bar: feature('shell_menu_bar', true) === false } });
    });
  }

  function renderGroup() {
    if (!group) return;
    F.$('sw-shell-menubar').setAttribute('aria-checked', String(feature('shell_menu_bar', true) !== false));
    renderShortcuts();
  }

  // ── the global shortcuts ──

  let recordingSlot = '';
  let noteFrom = ''; // what the note is about: 'recorder', 'taken' (found at start) or ''

  function setNote(text, warn, from) {
    const note = F.$('shell-key-note');
    if (!note) return;
    note.hidden = !text;
    note.textContent = text || '';
    note.classList.toggle('warn-line', Boolean(warn));
    noteFrom = text ? from : '';
  }

  function problem(error, label) {
    if (error === 'taken') return en(`${label} is taken by another app. Pick another.`);
    if (error === 'modifier') return en('Use ⌃ or ⌥, or ⌘ together with ⇧, ⌃ or ⌥.');
    if (error === 'reserved') return en(`${label} belongs to macOS. Pick another.`);
    if (error === 'same') return en('Talk and What’s this? need different shortcuts.');
    return en('That key can’t be a shortcut.');
  }

  function renderShortcuts() {
    if (!group || !keyStatus) return;
    for (const slot of ['ask', 'whatsThis']) {
      const s = keyStatus[slot];
      if (!s) continue;
      if (recordingSlot !== slot) F.$(`shell-key-${slot}`).textContent = s.label;
      F.$(`shell-rec-${slot}`).disabled = !online && recordingSlot !== slot;
    }
    // A shortcut another app already had when JARVIS started: said until it's changed.
    const taken = ['ask', 'whatsThis'].map((slot) => keyStatus[slot]).find((s) => s && s.error === 'taken');
    if (taken && noteFrom !== 'recorder') setNote(problem('taken', taken.label), true, 'taken');
    else if (!taken && noteFrom === 'taken') setNote('', false, '');
    updateHint();
  }

  // The hint under the orb and the idle line say the shortcuts as they are now.
  function updateHint() {
    if (!keyStatus || !keyStatus.ask || !keyStatus.whatsThis) return;
    const caps = document.querySelectorAll('#hint kbd');
    if (caps[0]) caps[0].textContent = keyStatus.ask.label;
    if (caps[1]) caps[1].textContent = keyStatus.whatsThis.label;
    const idle = en(`Tap the orb or press ${keyStatus.ask.label}`);
    if (STATE_LINES.idle !== idle) {
      STATE_LINES.idle = idle;
      if (state === 'idle') setState('idle');
    }
  }

  function startRecording(slot) {
    if (recordingSlot) stopRecording();
    recordingSlot = slot;
    bridge.send(`${CH}recording`, true); // the app's own shortcuts step aside, so their keys reach here
    const cap = F.$(`shell-key-${slot}`);
    cap.textContent = '…';
    cap.classList.add('recording');
    F.$(`shell-rec-${slot}`).textContent = en('Cancel');
    setNote(en('Type the new shortcut, or press Esc.'), false, 'recorder');
    window.addEventListener('keydown', onRecordKey, true);
    window.addEventListener('keyup', onRecordKeyUp, true);
  }

  function stopRecording(tellApp = true) {
    if (!recordingSlot) return;
    window.removeEventListener('keydown', onRecordKey, true);
    window.removeEventListener('keyup', onRecordKeyUp, true);
    const slot = recordingSlot;
    recordingSlot = '';
    if (tellApp) bridge.send(`${CH}recording`, false);
    F.$(`shell-key-${slot}`).classList.remove('recording');
    F.$(`shell-rec-${slot}`).textContent = en('Change…');
    if (noteFrom === 'recorder') setNote('', false, '');
    renderShortcuts();
  }

  // While recording, every key is the shortcut's: none reaches the rest of the window
  // (Space would talk, Esc close Settings, ⌘, open Jarvis Code's settings).
  function onRecordKey(e) {
    e.preventDefault();
    e.stopImmediatePropagation();
    if (e.repeat) return;
    if (e.code === 'Escape' && !(e.metaKey || e.ctrlKey || e.altKey || e.shiftKey)) { stopRecording(); return; }
    const accelerator = acceleratorFromKey(e);
    const slot = recordingSlot;
    if (!accelerator) { F.$(`shell-key-${slot}`).textContent = heldLabel(e) || '…'; return; }
    stopRecording(false); // the app ends its own recording when it's asked to take one
    bridge.invoke(`${CH}shortcut`, { which: slot, accelerator }).then((r) => {
      if (r && r.ok) {
        F.send({ type: 'feature_prefs', changes: { [SHORTCUT_PREFS[slot]]: r.accelerator } });
        keyStatus = { ...keyStatus, [slot]: { accelerator: r.accelerator, label: r.label, error: '' } };
        setNote('', false, '');
      } else {
        setNote(problem(r && r.error, (r && r.label) || ''), true, 'recorder');
      }
      renderShortcuts();
    }, () => bridge.send(`${CH}recording`, false));
  }

  function onRecordKeyUp(e) {
    e.preventDefault();
    e.stopImmediatePropagation();
    if (recordingSlot) F.$(`shell-key-${recordingSlot}`).textContent = heldLabel(e) || '…';
  }

  // ── start: the group first, so the events heard next (and the one replayed) fill it in ──

  if (bridge) buildGroup();

  F.on('hello', (ev) => {
    seen.state = ev.state || 'idle';
    seen.muted = Boolean(ev.muted);
    seen.prefs = ev.prefs || seen.prefs;
    online = true;
    approvals.clear();
    (ev.approvals || []).forEach((a) => approvals.set(a.id, a));
    sendApprovals();
    renderGroup();
    afterLanguage(seen.prefs);
  }, { replay: true });
  F.on('approval', (ev) => {
    approvals.set(ev.id, ev);
    if (ready) bridge.send(`${CH}approval`, forApp(ev));
  });
  F.on('approval_resolved', (ev) => {
    approvals.delete(ev.id);
    if (ready) bridge.send(`${CH}approval-done`, { id: String(ev.id) });
  });

  // A heads-up while the window isn't in front (app.js asks first): the app raises it, so a
  // click on it can open JARVIS on its card. Without the app's side, app.js raises its own.
  window.addEventListener('jarvis-notify', (e) => {
    if (!ready || !canNotify || !e.detail) return;
    e.preventDefault();
    const ev = e.detail;
    bridge.send(`${CH}heads-up`, { key: String(ev.key || ''), kind: String(ev.alert_kind || ''), title: String(ev.title || ''), text: String(ev.text || '') });
  });
  F.on('state', (ev) => { seen.state = ev.value || 'idle'; report(); });
  F.on('muted', (ev) => { seen.muted = Boolean(ev.value); report(); });
  F.on('prefs', (ev) => { seen.prefs = ev; renderGroup(); afterLanguage(ev); });

  // Offline while the window's connection is down ("Reconnecting to Jarvis…" is showing).
  const offline = F.$('offline');
  if (offline) {
    new MutationObserver(() => { online = offline.hidden; report(); renderShortcuts(); })
      .observe(offline, { attributes: true, attributeFilter: ['hidden'] });
  }

  if (bridge) {
    bridge.on(`${CH}command`, run);
    bridge.on(`${CH}shortcuts`, (status) => { keyStatus = status; renderShortcuts(); });
    bridge.invoke(`${CH}hello`).then((info) => {
      if (!info) return;
      ready = true;
      canNotify = info.notify === true;
      if (info.shortcuts) keyStatus = info.shortcuts;
      renderShortcuts();
      report();
      sendApprovals();
      if (info.recovered) notice('Jarvis', '', 'The window stopped unexpectedly and was reloaded.', 15000);
    }, () => { /* an app without the shell feature: nothing to report to */ });
  }
})();
