// The phone companion in Settings › iPhone & Watch (jarvis.companion): the pairing QR
// code and the certificate's security code, the paired phones, what they did lately, and
// the certificate itself with the switch for plain HTTP. The switch, the pairing code and
// the list of phones stay app.js's; this adds to them.
(() => {
  const F = window.jarvisFeatures;
  if (!F) return;
  const { el, send } = F;
  const $ = (id) => document.getElementById(id);
  const PLAIN = 'companion_plain_http';

  let status = null;  // the latest companion event
  let features = {};  // prefs.features, for the plain HTTP switch
  let qrTimer = null;

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

  if (typeof window.__companionTest === 'function') window.__companionTest({ qrPath });

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

  $('remote-on').querySelector('.watch-help').before(activity, security);

  // ── rendering ──

  function renderDevices() {
    const devices = (status && status.devices) || [];
    if (!devices.length) {
      list.replaceChildren(el('li', 'muted', 'No phones paired yet.'));
      return;
    }
    list.replaceChildren(...devices.map((d) => {
      const li = el('li');
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
      fact.append(name, seen);
      const remove = el('button', 'btn', 'Remove');
      remove.type = 'button';
      remove.setAttribute('aria-label', `Unpair ${d.name}`);
      remove.addEventListener('click', () => send({ type: 'remote_remove', id: d.id }));
      li.append(fact, remove);
      return li;
    }));
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
  }

  function render() {
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
  F.on('remote_code', () => send({ type: 'companion_pairing' }));
  F.on('remote', (ev) => {
    if (!ev.running) { clearTimeout(qrTimer); qrBox.hidden = true; }
    send({ type: 'companion' });
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
