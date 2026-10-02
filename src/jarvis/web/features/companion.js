// The phone companion in Settings › iPhone & Watch (jarvis.companion): the pairing QR
// code and the certificate's security code, the paired phones and what each is sent,
// push notifications (the key, a test, when they go), what the phones did lately, and the
// certificate itself with the switch for plain HTTP. The switch, the pairing code and the
// list of phones stay app.js's; this adds to them.
(() => {
  const F = window.jarvisFeatures;
  if (!F) return;
  const { el, send } = F;
  const $ = (id) => document.getElementById(id);
  const PLAIN = 'companion_plain_http';
  const WHEN = 'companion_push_when';
  // What each phone can be sent (jarvis.companion DEFAULT_SETTINGS), in Settings' words.
  const KINDS = [
    ['approvals', 'Approvals', 'Cards waiting on your yes, with Allow and No on the Lock Screen'],
    ['code', 'Jarvis Code', 'A session finished or stopped'],
    ['delegations', 'Conversations', 'One Jarvis holds for you needs you'],
    ['calls', 'Calls', 'How a call went, and calls to the Jarvis number'],
  ];
  const HEADSUPS = [['urgent', 'Urgent only'], ['all', 'All'], ['off', 'Off']];

  let status = null;  // the latest companion event
  let features = {};  // prefs.features, for the plain HTTP switch
  let qrTimer = null;
  const openDevices = new Set();  // phones whose notification settings are open

  // ── pure helpers (tests/web/companion.test.mjs runs these) ──

  // The QR code's dark modules as one SVG path, with the four-module quiet zone around it.
  function qrPath(rows) {
    let d = '';
    rows.forEach((row, y) => {
      for (let x = 0; x < row.length; x += 1) {
        if (row[x] !== '1') continue;
        let run = 1;
        while (row[x + run] === '1') run += 1;
        d += `M${x + 4} ${y + 4}h${run}v1h-${run}z`;
        x += run - 1;
      }
    });
    return d;
  }

  // Dates in the window's language (app.js's uiLocale), or the system's.
  const locale = () => (typeof uiLocale === 'function' ? uiLocale() : undefined);

  function when(iso) {
    const at = new Date(iso);
    return Number.isNaN(at.getTime()) ? '' : at.toLocaleString(locale(), { dateStyle: 'medium', timeStyle: 'short' });
  }

  function day(iso) {
    const at = new Date(iso);
    return Number.isNaN(at.getTime()) ? '' : at.toLocaleDateString(locale(), { dateStyle: 'medium' });
  }

  // Why a test push didn't reach a phone, in words (the Mac's outcome codes).
  function outcome(code) {
    if (code === 'sent') return 'Sent.';
    if (code === 'gone') return 'Its app stopped taking notifications. Open it to turn them back on.';
    if (code === 'not this app') return 'Its app isn’t the one this key is for. Check the bundle ID.';
    return 'Not delivered.';
  }

  if (typeof window.__companionTest === 'function') window.__companionTest({ qrPath, outcome });

  // ── where it goes ──

  const group = $('sw-remote') && $('sw-remote').closest('section.group');
  if (!group || !$('remote-on')) return;

  const certNote = el('p', 'small-status companion-note', 'The first time, Safari warns about this Mac’s certificate: tap Show Details, then visit this website. The J.A.R.V.I.S. app checks it for you.');
  $('remote-url').closest('p').after(certNote);

  const qrBox = el('div', 'companion-qr');
  qrBox.hidden = true;
  const qrSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  qrSvg.setAttribute('role', 'img');
  qrSvg.setAttribute('aria-label', 'Pairing QR code');
  qrSvg.setAttribute('shape-rendering', 'crispEdges');
  const qrText = el('div', 'companion-qr-text');
  qrText.append(
    el('strong', '', 'Scan with the J.A.R.V.I.S. app'),
    el('small', '', 'It pairs and checks this Mac’s certificate in one go.'),
  );
  const typed = el('small', 'companion-typed');
  const shortCode = el('code', 'companion-mono');
  shortCode.dataset.noI18n = '';
  typed.append(el('span', '', 'Typing the code instead? The app should show this security code:'), shortCode);
  qrText.append(typed);
  qrBox.append(qrSvg, qrText);
  $('remote-code').after(qrBox);

  // The phones, with more than app.js's list shows (it stays, hidden, as it was).
  const list = el('ul', 'itemlist companion-devices');
  $('remote-devices').after(list);
  $('remote-devices').style.display = 'none';  // (.folders would show it despite hidden)

  // Push notifications: the key, a test, and when they go.
  const pushBox = el('details', 'watch-help companion-push');
  const pushStatus = el('p', 'small-status');
  const keyForm = el('div', 'companion-key-form');
  const keyText = el('textarea', 'companion-key');
  keyText.rows = 4;
  keyText.spellcheck = false;
  keyText.placeholder = '-----BEGIN PRIVATE KEY-----';
  keyText.setAttribute('aria-label', 'Push key (.p8)');
  const field = (label, value) => {
    const wrap = el('label', 'companion-field');
    const input = el('input');
    input.type = 'text';
    input.spellcheck = false;
    input.value = value;
    wrap.append(el('span', '', label), input);
    return [wrap, input];
  };
  const [keyIdField, keyId] = field('Key ID', '');
  const [teamField, teamId] = field('Team ID', '9ZSY5R8A5C');
  const [bundleField, bundleId] = field('Bundle ID', 'com.bshventures.jarvis.companion');
  const fields = el('div', 'companion-fields');
  fields.append(keyIdField, teamField, bundleField);
  const keyError = el('p', 'warn-line small-status');
  keyError.hidden = true;
  const keySave = el('button', 'btn primary', 'Save in the Keychain');
  keySave.type = 'button';
  const keyCancel = el('button', 'btn', 'Cancel');
  keyCancel.type = 'button';
  const keyButtons = el('div', 'row-actions');
  keyButtons.append(keySave, keyCancel);
  const keyHelp = el('small', 'companion-key-help', 'From your Apple Developer account: Certificates, IDs & Profiles › Keys, a key with Apple Push Notifications. Paste everything in its .p8 file. It goes to the Keychain and never leaves this Mac.');
  keyForm.append(el('strong', '', 'Apple push key'), keyHelp, keyText, fields, keyError, keyButtons);
  const pushActions = el('div', 'row-actions');
  const testAll = el('button', 'btn', 'Send a test push');
  testAll.type = 'button';
  const replaceKey = el('button', 'btn', 'Replace key…');
  replaceKey.type = 'button';
  const removeKey = el('button', 'btn', 'Remove key');
  removeKey.type = 'button';
  pushActions.append(testAll, replaceKey, removeKey);
  const testResult = el('ul', 'itemlist companion-test');
  const whenRow = el('div', 'row');
  const whenText = el('span');
  whenText.append(
    el('strong', '', 'Only when I’m away from the Mac'),
    el('small', '', 'No keyboard or mouse for two minutes, or the screen locked. In quiet hours only urgent heads-ups and VIPs make a sound.'),
  );
  const whenSwitch = el('button', 'switch');
  whenSwitch.type = 'button';
  whenSwitch.setAttribute('role', 'switch');
  whenSwitch.setAttribute('aria-label', 'Only when I’m away from the Mac');
  whenRow.append(whenText, whenSwitch);
  pushBox.append(el('summary', '', 'Notifications'), pushStatus, keyForm, pushActions, testResult, whenRow);
  let replacing = false;

  // What the phones did lately.
  const activity = el('details', 'watch-help companion-activity');
  const activityList = el('ul', 'itemlist companion-log');
  activity.append(el('summary', '', 'Recent phone activity'), activityList);

  // The certificate, and plain HTTP.
  const security = el('details', 'watch-help companion-security');
  const fpLine = el('p', 'small-status');
  const fpFull = el('code', 'companion-fingerprint');
  fpFull.dataset.noI18n = '';
  const expires = el('p', 'small-status');
  const plainRow = el('div', 'row');
  const plainText = el('span');
  plainText.append(
    el('strong', '', 'Also allow plain HTTP'),
    el('small', '', 'Only for the older app and web page. Anyone on your Wi-Fi could read what your phone and Mac send, and take over a paired phone’s access. Leave it off unless you need it.'),
  );
  const plainSwitch = el('button', 'switch');
  plainSwitch.type = 'button';
  plainSwitch.setAttribute('role', 'switch');
  plainSwitch.setAttribute('aria-label', 'Also allow plain HTTP');
  plainSwitch.setAttribute('aria-checked', 'false');
  plainRow.append(plainText, plainSwitch);
  const plainWarn = el('p', 'warn-line small-status', 'Plain HTTP is on: turn it off once your phone has the new app.');
  plainWarn.hidden = true;
  const renew = el('button', 'btn', 'New certificate…');
  renew.type = 'button';
  const renewAsk = el('div', 'companion-confirm');
  renewAsk.hidden = true;
  const renewGo = el('button', 'btn', 'Make a new certificate');
  renewGo.type = 'button';
  const renewCancel = el('button', 'btn', 'Cancel');
  renewCancel.type = 'button';
  const renewActions = el('div', 'row-actions');
  renewActions.append(renewGo, renewCancel);
  renewAsk.append(el('p', 'small-status', 'Every paired phone is unpaired and pairs again with the new one.'), renewActions);
  security.append(el('summary', '', 'Security'), fpLine, fpFull, expires, plainRow, plainWarn, renew, renewAsk);

  $('remote-on').querySelector('.watch-help').before(pushBox, activity, security);

  // ── rendering ──

  function toggle(label, on, change) {
    const button = el('button', 'switch');
    button.type = 'button';
    button.setAttribute('role', 'switch');
    button.setAttribute('aria-label', label);
    button.setAttribute('aria-checked', String(!!on));
    button.addEventListener('click', () => change(!on));
    return button;
  }

  // One phone's notification settings: what it's sent.
  function deviceSettings(d) {
    const box = el('details', 'companion-device-push');
    box.open = openDevices.has(d.id);
    box.addEventListener('toggle', () => { if (box.open) openDevices.add(d.id); else openDevices.delete(d.id); });
    const settings = d.settings || {};
    const set = (changes) => send({ type: 'companion_device', id: d.id, settings: changes });
    box.append(el('summary', '', 'What this phone is sent'));
    const heads = el('label', 'row');
    const headsText = el('span');
    headsText.append(el('strong', '', 'Heads-ups'), el('small', '', 'Rain, time to leave, messages that matter'));
    const select = el('select');
    select.setAttribute('aria-label', 'Heads-ups');
    for (const [value, label] of HEADSUPS) {
      const option = el('option', '', label);
      option.value = value;
      option.selected = settings.headsups === value;
      select.append(option);
    }
    select.addEventListener('change', () => set({ headsups: select.value }));
    heads.append(headsText, select);
    box.append(heads);
    for (const [key, label, note] of KINDS) {
      const row = el('div', 'row');
      const text = el('span');
      text.append(el('strong', '', label), el('small', '', note));
      row.append(text, toggle(label, settings[key] !== false, (on) => set({ [key]: on })));
      box.append(row);
    }
    const test = el('button', 'btn', 'Send a test push');
    test.type = 'button';
    test.hidden = !(status && status.push && (status.push.configured || status.push.via === 'account'));  // nothing to send with
    test.addEventListener('click', () => send({ type: 'companion_push_test', id: d.id }));
    box.append(test);
    return box;
  }

  function renderDevices() {
    const devices = (status && status.devices) || [];
    if (!devices.length) {
      list.replaceChildren(el('li', 'muted', 'No phones paired yet.'));
      return;
    }
    list.replaceChildren(...devices.map((d) => {
      const li = el('li', 'companion-device');
      const head = el('div', 'companion-device-head');
      const fact = el('span', 'fact');
      const name = el('strong', '', d.name);
      name.dataset.noI18n = '';
      const seen = el('small');
      if (d.last_seen) {
        const at = el('span', '', when(d.last_seen));
        at.dataset.noI18n = '';
        seen.append(el('span', '', 'Last used '), at);
      } else {
        seen.append(el('span', '', 'Not used yet'));
      }
      const push = d.push || {};
      let pushNote = 'Notifications not turned on in its app';
      if (push.registered) pushNote = push.environment === 'sandbox' ? 'Notifications on (development build)' : 'Notifications on';
      else if (push.error === 'gone') pushNote = 'Notifications stopped: open its app to turn them back on';
      const pushLine = el('small', push.error === 'gone' ? 'need' : '', pushNote);
      fact.append(name, seen, pushLine);
      const remove = el('button', 'btn', 'Remove');
      remove.type = 'button';
      remove.setAttribute('aria-label', `Unpair ${d.name}`);
      remove.addEventListener('click', () => send({ type: 'remote_remove', id: d.id }));
      head.append(fact, remove);
      li.append(head);
      if (push.registered) li.append(deviceSettings(d));
      return li;
    }));
  }

  function renderPush() {
    const info = (status && status.push) || {};
    const configured = !!info.configured;
    keyForm.hidden = configured && !replacing;
    keyCancel.hidden = !configured;
    pushActions.hidden = !configured && info.via !== 'account';
    replaceKey.hidden = removeKey.hidden = !configured;
    if (!configured && info.via === 'account') {
      // No key of the owner's own: the Jarvis account's (jarvis.features.account) is used.
      pushStatus.replaceChildren(el('span', '', 'Through your Jarvis account. A push key of your own here would be used instead.'));
    } else if (!configured) {
      pushStatus.replaceChildren(el('span', '', 'Not set up yet. With Apple’s push key, approvals and heads-ups reach your phone even when its app is closed.'));
    } else if (info.error) {
      const reason = el('code', 'companion-mono', info.error);
      reason.dataset.noI18n = '';
      pushStatus.replaceChildren(el('span', 'warn', 'Apple refused the push key. Check the Key ID, the Team ID and the bundle ID, or paste the key again.'), el('span', '', ' '), reason);
    } else {
      const ids = el('code', 'companion-mono', `${info.key_id} · ${info.team_id} · ${info.bundle_id}`);
      ids.dataset.noI18n = '';
      pushStatus.replaceChildren(el('span', '', 'Ready. '), ids);
    }
    whenSwitch.setAttribute('aria-checked', String(features[WHEN] !== 'always'));
  }

  function renderActivity(items) {
    const rows = (items || []).slice().reverse();
    activity.hidden = !rows.length;
    activityList.replaceChildren(...rows.map((item) => {
      const li = el('li');
      const fact = el('span', 'fact');
      fact.append(el('strong', '', item.label || item.action));
      const small = el('small');
      const who = el('span', '', `${item.name} · ${when(item.at)}${item.detail ? ` · ${item.detail}` : ''}`);
      who.dataset.noI18n = '';
      small.append(who);
      fact.append(small);
      li.append(fact);
      return li;
    }));
  }

  function renderSecurity() {
    const tls = status && status.tls;
    security.hidden = !tls;
    if (!tls) return;
    const code = el('code', 'companion-mono', tls.short);
    code.dataset.noI18n = '';
    fpLine.replaceChildren(el('span', '', 'Security code '), code);
    fpFull.textContent = tls.fingerprint;
    const until = el('b', 'companion-date', day(tls.expires));
    until.dataset.noI18n = '';
    const expired = new Date(tls.expires).getTime() < Date.now();
    expires.replaceChildren(el('span', '', expired ? 'Certificate expired ' : 'Certificate valid until '), until);
    expires.classList.toggle('warn-line', expired);
  }

  function renderPlain() {
    const on = features[PLAIN] === true;
    plainSwitch.setAttribute('aria-checked', String(on));
    plainWarn.hidden = !on;
    whenSwitch.setAttribute('aria-checked', String(features[WHEN] !== 'always'));
  }

  function renderTest(results) {
    const names = new Map(((status && status.devices) || []).map((d) => [d.id, d.name]));
    const entries = Object.entries(results || {});
    if (!entries.length) {
      testResult.replaceChildren(el('li', 'muted', 'No phone has notifications turned on yet. Open the J.A.R.V.I.S. app and allow them.'));
      return;
    }
    testResult.replaceChildren(...entries.map(([id, code]) => {
      const li = el('li');
      const fact = el('span', 'fact');
      const name = el('strong', '', names.get(id) || id);
      name.dataset.noI18n = '';
      fact.append(name, el('small', code === 'sent' ? '' : 'need', outcome(code)));
      li.append(fact);
      return li;
    }));
  }

  function render() {
    renderPush();
    renderDevices();
    renderActivity(status && status.audit);
    renderSecurity();
    renderPlain();
  }

  function showQr(ev) {
    clearTimeout(qrTimer);
    if (!ev.qr || !ev.qr.length) {
      qrBox.hidden = true;
      return;
    }
    const size = ev.qr.length + 8;
    qrSvg.setAttribute('viewBox', `0 0 ${size} ${size}`);
    const bg = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    bg.setAttribute('width', String(size));
    bg.setAttribute('height', String(size));
    bg.setAttribute('fill', '#fff');
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', qrPath(ev.qr));
    path.setAttribute('fill', '#000');
    qrSvg.replaceChildren(bg, path);
    shortCode.textContent = ev.short || '';
    qrBox.hidden = false;
    qrTimer = setTimeout(() => { qrBox.hidden = true; }, Math.max(1, ev.seconds || 0) * 1000);
  }

  // ── events ──

  F.on('hello', (ev) => {
    features = (ev.prefs && ev.prefs.features) || {};
    renderPlain();
    send({ type: 'companion' });
  }, { replay: true });
  F.on('prefs', (ev) => { features = ev.features || {}; renderPlain(); });
  F.on('companion', (ev) => { status = ev; render(); });
  F.on('companion_audit', (ev) => renderActivity(ev.items));
  F.on('companion_pairing', showQr);
  F.on('companion_push', (ev) => {
    keyError.hidden = !ev.error;
    keyError.textContent = ev.error || '';
    if (ev.saved) {
      keyText.value = '';  // the key is in the Keychain now: not kept in the page
      replacing = false;
      renderPush();
    }
  });
  F.on('companion_push_test', (ev) => renderTest(ev.results));
  F.on('remote_code', () => send({ type: 'companion_pairing' }));
  F.on('remote', (ev) => {
    if (!ev.running) { clearTimeout(qrTimer); qrBox.hidden = true; }
    send({ type: 'companion' });
  });

  keySave.addEventListener('click', () => {
    keyError.hidden = true;
    send({ type: 'companion_push_key', key: keyText.value, key_id: keyId.value, team_id: teamId.value, bundle_id: bundleId.value });
  });
  keyCancel.addEventListener('click', () => { replacing = false; keyText.value = ''; keyError.hidden = true; renderPush(); });
  replaceKey.addEventListener('click', () => { replacing = true; renderPush(); keyText.focus(); });
  removeKey.addEventListener('click', () => send({ type: 'companion_push_forget' }));
  testAll.addEventListener('click', () => { testResult.replaceChildren(); send({ type: 'companion_push_test' }); });
  whenSwitch.addEventListener('click', () => {
    send({ type: 'feature_prefs', changes: { [WHEN]: features[WHEN] === 'always' ? 'away' : 'always' } });
  });
  plainSwitch.addEventListener('click', () => {
    send({ type: 'feature_prefs', changes: { [PLAIN]: features[PLAIN] !== true } });
  });
  renew.addEventListener('click', () => { renewAsk.hidden = false; renew.hidden = true; });
  renewCancel.addEventListener('click', () => { renewAsk.hidden = true; renew.hidden = false; });
  renewGo.addEventListener('click', () => {
    renewAsk.hidden = true;
    renew.hidden = false;
    qrBox.hidden = true;
    send({ type: 'companion_new_certificate' });
  });

  // Fresh "last used" times whenever Settings opens.
  const sheet = $('settings');
  if (sheet) {
    new MutationObserver(() => { if (!sheet.hidden) send({ type: 'companion' }); })
      .observe(sheet, { attributes: true, attributeFilter: ['hidden'] });
  }
})();
