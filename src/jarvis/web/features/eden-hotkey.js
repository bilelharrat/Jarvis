// Ask Eden from anywhere on the Mac (askeden ROADMAP H10), window side: its rows in Settings ›
// This Mac (a switch, off until turned on, and its keys with Change…), and the setting handed
// to the app, which registers the global shortcut and opens the small Eden window
// (app/features/eden-window.js). The setting itself is kept with the others
// (features/eden_hotkey.py: eden_hotkey, eden_hotkey_keys).
(() => {
  if (typeof window === 'undefined' || !window.jarvisFeatures) return;
  const F = window.jarvisFeatures;
  const bridge = window.jarvisApp && window.jarvisApp.feature ? window.jarvisApp.feature : null;
  if (!bridge) return; // a browser tab or the test window without the app: nothing to set up
  const CH = 'feature:eden:';
  const en = (text) => text;
  const DEFAULT_KEYS = 'Control+Alt+Space';

  // shell.js's spelling of a key, by its place on the keyboard
  const CODE_KEYS = {
    Space: 'Space', Enter: 'Return', NumpadEnter: 'Return', Tab: 'Tab', Backspace: 'Backspace', Delete: 'Delete',
    ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right', Home: 'Home', End: 'End',
    PageUp: 'PageUp', PageDown: 'PageDown', Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']',
    Backslash: '\\', Semicolon: ';', Quote: "'", Comma: ',', Period: '.', Slash: '/', Backquote: '`',
  };
  function keyOf(code) {
    if (/^Key[A-Z]$/.test(code)) return code.slice(3);
    if (/^Digit[0-9]$/.test(code)) return code.slice(5);
    if (/^F([1-9]|1[0-9]|2[0-4])$/.test(code)) return code;
    return CODE_KEYS[code] || '';
  }
  const held = (e) => [e.ctrlKey && '⌃', e.altKey && '⌥', e.shiftKey && '⇧', e.metaKey && '⌘'].filter(Boolean).join('');
  // As the Mac writes it (shell-lib.js's shortcutLabel): "⌃⌥ Space", "⌃⌥J".
  function labelOf(accelerator) {
    const parts = String(accelerator || '').split('+');
    const key = parts.pop() || '';
    const signs = [['Control', '⌃'], ['Alt', '⌥'], ['Shift', '⇧'], ['Command', '⌘']].filter(([m]) => parts.includes(m)).map(([, sign]) => sign).join('');
    return key.length > 1 ? `${signs} ${key}`.trim() : `${signs}${key}`;
  }

  let prefs = null;
  let status = null; // as the app has it: { on, accelerator, label, error }
  let group = null;
  let recording = false;

  const feature = (key, fallback) => {
    const f = (prefs && prefs.features) || {};
    return key in f ? f[key] : fallback;
  };
  const wanted = () => ({ on: feature('eden_hotkey', false) === true, accelerator: feature('eden_hotkey_keys', DEFAULT_KEYS) || DEFAULT_KEYS });

  let waited = 0;
  function build() {
    if (group) return;
    const shellGroup = F.$('shell-group');
    const settings = F.$('settings');
    if (!settings) return;
    // shell.js (loaded after this file) adds This Mac: wait a moment for it
    if (!shellGroup && waited < 10) { waited += 1; setTimeout(render, 300); return; }
    group = F.el('div', 'eden-hotkey');
    const row = F.el('div', 'row');
    const words = F.el('span');
    words.append(F.el('strong', '', en('Ask Eden from anywhere')),
      F.el('small', '', en('A small Eden window, ready to type, from any app: Eden on this Mac, or askeden.com when it isn’t running.')));
    const sw = F.el('button', 'switch');
    sw.type = 'button';
    sw.id = 'sw-eden-hotkey';
    sw.setAttribute('role', 'switch');
    sw.setAttribute('aria-checked', 'false');
    sw.setAttribute('aria-label', en('Ask Eden from anywhere'));
    sw.addEventListener('click', () => F.send({ type: 'feature_prefs', changes: { eden_hotkey: !wanted().on } }));
    row.append(words, sw);
    const keyRow = F.el('div', 'row shell-key-row');
    keyRow.id = 'eden-hotkey-keys';
    const keyWords = F.el('span');
    keyWords.append(F.el('strong', '', en('Ask Eden')), F.el('small', '', en('From any app: opens Eden with the message box ready.')));
    const keys = F.el('span', 'shell-key');
    const cap = F.el('kbd');
    cap.id = 'eden-hotkey-cap';
    const change = F.el('button', 'btn', en('Change…'));
    change.type = 'button';
    change.id = 'eden-hotkey-change';
    change.addEventListener('click', () => (recording ? stop(true) : start()));
    keys.append(cap, change);
    keyRow.append(keyWords, keys);
    const note = F.el('p', 'small-status');
    note.id = 'eden-hotkey-note';
    note.hidden = true;
    note.setAttribute('aria-live', 'polite');
    group.append(row, keyRow, note);
    // In This Mac, under JARVIS's own shortcuts; its own group when that isn't there.
    const anchor = shellGroup && F.$('shell-key-note');
    if (anchor) anchor.after(group);
    else {
      const section = F.el('section', 'group');
      section.append(F.el('h3', '', en('Eden')), group);
      settings.append(section);
    }
  }

  function setNote(text, warn) {
    const note = F.$('eden-hotkey-note');
    if (!note) return;
    note.hidden = !text;
    note.textContent = text || '';
    note.classList.toggle('warn-line', Boolean(warn));
  }

  function problem(error, label) {
    if (error === 'same') return en(`${label} is already one of JARVIS’s shortcuts. Pick another.`);
    if (error === 'taken') return en(`${label} is taken by another app. Pick another.`);
    if (error === 'modifier') return en('Use ⌃ or ⌥, or ⌘ together with ⇧, ⌃ or ⌥.');
    if (error === 'reserved') return en(`${label} belongs to macOS. Pick another.`);
    return en('That key can’t be a shortcut.');
  }

  function render() {
    build();
    if (!group) return;
    const w = wanted();
    F.$('sw-eden-hotkey').setAttribute('aria-checked', String(w.on));
    F.$('eden-hotkey-keys').hidden = !w.on;
    if (!recording) F.$('eden-hotkey-cap').textContent = labelOf(w.accelerator);
    if (!recording) setNote(w.on && status && status.error === 'taken' ? problem('taken', status.label) : '', true);
  }

  // The setting, to the app (it registers the shortcut, or takes it away).
  function report() {
    bridge.send(`${CH}hotkey`, wanted());
  }

  function start() {
    recording = true;
    bridge.send('feature:shell:recording', true); // every JARVIS shortcut steps aside, so the keys reach here
    F.$('eden-hotkey-cap').textContent = '…';
    F.$('eden-hotkey-change').textContent = en('Cancel');
    setNote(en('Type the new shortcut, or press Esc.'), false);
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('keyup', onKeyUp, true);
  }

  function stop(tellApp) {
    if (!recording) return;
    recording = false;
    window.removeEventListener('keydown', onKey, true);
    window.removeEventListener('keyup', onKeyUp, true);
    if (tellApp) bridge.send('feature:shell:recording', false);
    F.$('eden-hotkey-change').textContent = en('Change…');
    setNote('', false);
    render();
  }

  function onKey(e) {
    e.preventDefault();
    e.stopImmediatePropagation();
    if (e.repeat) return;
    if (e.code === 'Escape' && !(e.metaKey || e.ctrlKey || e.altKey || e.shiftKey)) { stop(true); return; }
    const key = keyOf(String(e.code || ''));
    if (!key) { F.$('eden-hotkey-cap').textContent = held(e) || '…'; return; }
    const accelerator = [e.metaKey && 'Command', e.ctrlKey && 'Control', e.altKey && 'Alt', e.shiftKey && 'Shift', key].filter(Boolean).join('+');
    stop(true); // the shortcuts come back first, so the new keys are tried against them
    bridge.invoke(`${CH}try`, accelerator).then((r) => {
      if (r && r.ok) {
        F.send({ type: 'feature_prefs', changes: { eden_hotkey_keys: r.accelerator } });
        status = { ...(status || {}), accelerator: r.accelerator, label: r.label, error: '' };
        render();
      } else {
        setNote(problem(r && r.error, (r && r.label) || ''), true);
      }
    }, () => {});
  }

  function onKeyUp(e) {
    e.preventDefault();
    e.stopImmediatePropagation();
    if (recording) F.$('eden-hotkey-cap').textContent = held(e) || '…';
  }

  bridge.on(`${CH}status`, (s) => { status = s; render(); });
  F.on('hello', (ev) => { prefs = ev.prefs || prefs; render(); report(); }, { replay: true });
  F.on('prefs', (ev) => { prefs = ev; render(); report(); });
})();
