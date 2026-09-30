// The Mac app's shell, window side (app/features/shell.js is the other half): tells the app
// what JARVIS is doing for the menu bar icon, carries out what its menus ask over this
// window's connection, and adds the "This Mac" group to Settings.
(() => {
  if (typeof window === 'undefined' || !window.jarvisFeatures) return;
  const F = window.jarvisFeatures;
  const bridge = window.jarvisApp && window.jarvisApp.feature ? window.jarvisApp.feature : null;
  const CH = 'feature:shell:';

  // What the app reports, as the window last heard it.
  const seen = { state: 'idle', muted: false, prefs: null };
  let ready = false; // the app's side answered hello
  let online = false;

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
      quit: t('Quit J.A.R.V.I.S.'),
    };
  }

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

  // ── what the app's menus ask ──

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

  let group = null;
  function buildGroup() {
    if (group || !bridge) return;
    group = F.el('section', 'group shell-group');
    group.id = 'shell-group';
    group.append(
      F.el('h3', '', 'This Mac'),
      switchRow('sw-shell-menubar', 'Show in the menu bar', 'What JARVIS is doing at a glance, and Ask, Mute, Hands-free and Pause heads-ups from any app.'),
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
  }

  // ── start: the group first, so the events heard next (and the one replayed) fill it in ──

  if (bridge) buildGroup();

  F.on('hello', (ev) => {
    seen.state = ev.state || 'idle';
    seen.muted = Boolean(ev.muted);
    seen.prefs = ev.prefs || seen.prefs;
    online = true;
    renderGroup();
    afterLanguage(seen.prefs);
  }, { replay: true });
  F.on('state', (ev) => { seen.state = ev.value || 'idle'; report(); });
  F.on('muted', (ev) => { seen.muted = Boolean(ev.value); report(); });
  F.on('prefs', (ev) => { seen.prefs = ev; renderGroup(); afterLanguage(ev); });

  // Offline while the window's connection is down ("Reconnecting to Jarvis…" is showing).
  const offline = F.$('offline');
  if (offline) {
    new MutationObserver(() => { online = offline.hidden; report(); })
      .observe(offline, { attributes: true, attributeFilter: ['hidden'] });
  }

  if (bridge) {
    bridge.on(`${CH}command`, run);
    bridge.invoke(`${CH}hello`).then((info) => {
      if (!info) return;
      ready = true;
      report();
    }, () => { /* an app without the shell feature: nothing to report to */ });
  }
})();
