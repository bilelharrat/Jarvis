// Eden Code on the phone (features/code_phone.py), the Mac's side: Open on my phone (a
// session's More menu, or /phone; the command is still code_phone_handoff) pins the open session to the phone's view and sends a push
// with its link; the Phone pane shows the switch for the phone's web page (off until turned
// on), its address and a QR code to open it, the session pinned now (Unpin), and how the last
// handoff went.
//
// At its top, "Pair the Eden Code app" (features/code_phone_pair.py): the QR code the native
// Eden Code apps scan (edencode://pair?…: the companion's own six-digit pairing code, the
// Mac's address and its certificate's fingerprint, docs/eden-code-phone.md "Pairing by QR"),
// the code as text to type instead, a countdown to its expiry and New code. The page's own QR
// code stays below it, labelled for the phone's browser.
//
// The address, titles and what the push said are data: text only, marked data-no-i18n. Pure
// helpers are exported for node --test (tests/web/code-phone.test.mjs).
(function (root) {
  'use strict';

  const PREF = 'code_phone_web';

  // The QR code's dark modules as one SVG path, with the four-module quiet zone (as the
  // companion's pairing code is drawn: features/companion.js).
  function qrPath(rows) {
    let d = '';
    (rows || []).forEach((row, y) => {
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

  // What the pane says of the pinned session.
  function pinnedText(pinned) {
    return pinned ? `On your phone: ${pinned.title || `#${pinned.id}`}` : 'Nothing pinned for your phone.';
  }

  // The pairing code's time left, m:ss ('' once it's gone).
  function countdown(seconds) {
    const s = Math.max(0, Math.floor(Number(seconds) || 0));
    return s ? `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}` : '';
  }

  // The six digits as people read them: "042 917".
  function spaced(code) {
    return /^\d{6}$/.test(code || '') ? `${code.slice(0, 3)} ${code.slice(3)}` : '';
  }

  // What the pairing section shows: 'off' (the companion isn't running), 'error', 'code' (a
  // live code and its QR), 'ask' (no code up: a button makes one).
  function pairView(pair, left) {
    if (!pair) return 'ask';
    if (!pair.running) return 'off';
    if (pair.error) return 'error';
    return pair.code && left > 0 ? 'code' : 'ask';
  }

  const api = { qrPath, pinnedText, countdown, spaced, pairView, PREF };
  if (typeof module === 'object' && module.exports) { module.exports = api; return; }

  const F = root.jarvisFeatures;
  if (!F) return;
  const { el, send, t } = F;
  const keepFocus = (box, drawIt) => (root.jarvisFocus ? root.jarvisFocus.keep(box, drawIt) : drawIt());
  const mine = (node) => { node.setAttribute('data-no-i18n', ''); return node; };
  const state = { on: false, running: false, url: '', qr: [], short: '', pinned: null, pushed: null };
  let body = null;
  // The pairing code on screen: the last code_phone_pair event, the time it ends (ms), and
  // whether a phone paired with it (the 'devices' event remote.py sends).
  let pair = null;
  let pairEnds = 0;
  let pairedNow = false;
  let ticker = null;
  const left = () => Math.max(0, Math.round((pairEnds - Date.now()) / 1000));

  function button(label, cls, run, title) {
    const b = el('button', cls, label);
    b.type = 'button';
    if (title) b.title = title;
    b.addEventListener('click', (e) => { e.preventDefault(); run(b); });
    return b;
  }

  function handoff() {
    const task = F.currentTask();
    if (!task) { F.openPane('phone'); return; }
    send({ type: 'code_phone_handoff', id: task.id });
    F.openPane('phone');
  }

  function qrNode(rows = state.qr, label = 'QR code for the phone page', cls = 'jcx-phone-qr') {
    const NS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(NS, 'svg');
    const size = rows.length + 8;
    svg.setAttribute('viewBox', `0 0 ${size} ${size}`);
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', t(label));
    svg.setAttribute('shape-rendering', 'crispEdges');
    svg.setAttribute('class', cls);
    const bg = document.createElementNS(NS, 'rect');
    bg.setAttribute('width', String(size));
    bg.setAttribute('height', String(size));
    bg.setAttribute('fill', '#fff');
    const path = document.createElementNS(NS, 'path');
    path.setAttribute('d', qrPath(rows));
    path.setAttribute('fill', '#000');
    svg.append(bg, path);
    return svg;
  }

  // Pair: turns the app's switch on first when it's off (the app reads the same
  // /api/code/phone/* calls the page does, behind code_phone_web), then a code.
  function askCode(fresh) {
    pairedNow = false;
    if (!state.on) {
      send({ type: 'feature_prefs', changes: { [PREF]: true } });
      setTimeout(() => send({ type: 'code_phone_state' }), 300);
    }
    send({ type: 'code_phone_pair', fresh: fresh === true });
  }

  function pairSection() {
    const box = el('section', 'jcx-pair');
    box.setAttribute('aria-label', t('Pair the Eden Code app'));
    box.append(el('h3', 'jcx-pair-title', 'Pair the Eden Code app'));
    const view = pairView(pair, left());
    if (pairedNow) {
      const done = el('p', 'jcx-pair-done', 'Paired. Your phone is connected to this Mac.');
      done.setAttribute('role', 'status');
      box.append(done);
    }
    if (view === 'off') {
      box.append(el('p', 'jcx-phone-warn', 'Turn on the phone companion in Settings › iPhone & Watch: pairing goes through it.'));
      return box;
    }
    if (view === 'error') box.append(mine(el('p', 'jcx-phone-warn', pair.error)));
    if (view !== 'code') {
      box.append(el('p', 'jc-dim jcx-phone-line', 'Open Eden Code on your iPhone or Android phone, tap Scan QR code, and point it here. Or scan with the phone’s Camera.'));
      box.append(button(state.on ? 'Show pairing code' : 'Turn on and show pairing code', 'jc-btn filled', () => askCode(false),
        'A one-time code for five minutes, the same one Settings › iPhone & Watch shows'));
      return box;
    }
    const row = el('div', 'jcx-pair-row');
    row.append(qrNode(pair.qr, 'QR code to pair the Eden Code app', 'jcx-phone-qr jcx-pair-qr'));
    const side = el('div', 'jcx-pair-side');
    side.append(el('p', 'jc-dim jcx-phone-line', 'Scan with Eden Code (Scan QR code) or the phone’s Camera. Or type this code:'));
    const code = mine(el('p', 'jcx-pair-code', spaced(pair.code)));
    code.setAttribute('aria-label', `${t('Pairing code')} ${pair.code.split('').join(' ')}`);
    side.append(code);
    const time = mine(el('p', 'jc-dim jcx-phone-line jcx-pair-left', `${t('Expires in')} ${countdown(left())}`));
    time.setAttribute('aria-live', 'off');
    side.append(time);
    side.append(button('New code', 'jc-btn small', () => askCode(true), 'Makes a new code; the old one stops working'));
    if (pair.mac) side.append(mine(el('p', 'jc-dim jcx-phone-line', `${t('This Mac:')} ${pair.mac}`)));
    if (pair.short) side.append(mine(el('p', 'jc-dim jcx-phone-line', `${t('Certificate')} ${pair.short}`)));
    row.append(side);
    box.append(row);
    if (!state.on) box.append(el('p', 'jcx-phone-warn', 'Eden Code on your phone is off: the app pairs, but sees nothing until you turn it on below.'));
    return box;
  }

  function tick() {
    clearInterval(ticker);
    ticker = null;
    if (pairView(pair, left()) !== 'code') return;
    ticker = setInterval(() => {
      const node = body && body.isConnected ? body.querySelector('.jcx-pair-left') : null;
      if (!node) { clearInterval(ticker); ticker = null; return; }
      if (left() <= 0) { render(); return; }
      node.textContent = `${t('Expires in')} ${countdown(left())}`;
    }, 1000);
  }

  function draw(target) {
    body = target;
    const wrap = el('div', 'jcx-phonepane');
    wrap.append(pairSection());
    const task = F.currentTask();
    wrap.append(el('p', 'jc-dim', 'Your sessions are on your phone too, live. To jump straight to this one there, use Open on my phone.'));
    const go = button('Open on my phone', 'jc-btn filled', handoff, 'Opens this session on your phone');
    go.disabled = !task;
    wrap.append(go);
    wrap.append(el('p', 'jc-dim jcx-phone-line', 'Sends a notification that opens this session on your phone. Sessions stay in sync either way.'));
    const pinned = mine(el('p', 'jcx-phone-line', ''));
    pinned.textContent = t(pinnedText(state.pinned));
    pinned.setAttribute('role', 'status');
    wrap.append(pinned);
    if (state.pinned) wrap.append(button('Unpin', 'jc-btn small', () => send({ type: 'code_phone_unpin' })));
    if (state.pushed && state.pushed.said) wrap.append(mine(el('p', 'jc-dim jcx-phone-line', state.pushed.said)));
    const sw = el('label', 'jcx-phone-switch');
    const box = el('input');
    box.type = 'checkbox';
    box.checked = state.on;
    box.addEventListener('change', () => {
      send({ type: 'feature_prefs', changes: { [PREF]: box.checked } });
      setTimeout(() => send({ type: 'code_phone_state' }), 300);
    });
    sw.append(box, el('span', '', 'Eden Code in your phone’s browser (sessions, messages, cards, Stop, model and mode; never Bypass permissions)'));
    wrap.append(sw);
    if (state.on && !state.running) wrap.append(el('p', 'jcx-phone-warn', 'Turn on the phone companion in Settings › iPhone & Watch: the page is served by it.'));
    if (state.on && state.url) {
      const link = mine(el('input', 'jc-field jcx-phone-url'));
      link.readOnly = true;
      link.value = state.url;
      link.setAttribute('aria-label', t('Phone page address'));
      link.addEventListener('focus', () => link.select());
      wrap.append(link);
      wrap.append(el('h3', 'jcx-pair-title jcx-pair-web', 'Or open Eden Code in the phone’s browser'));
      if (state.qr.length) wrap.append(qrNode());
      wrap.append(el('p', 'jc-dim jcx-phone-line', 'Open it on your phone, pair with the code from Settings › iPhone & Watch, then Share › Add to Home Screen. It works on this Mac’s Wi-Fi, or over Tailscale when you’re away.'));
      if (state.short) wrap.append(mine(el('p', 'jc-dim jcx-phone-line', `${t('Safari warns about this Mac’s own certificate once. Its fingerprint starts')} ${state.short}.`)));
    }
    keepFocus(target, () => target.replaceChildren(wrap));
    tick();
  }

  function render() { if (body && body.isConnected && body.querySelector('.jcx-phonepane')) draw(body); }

  F.registerPane('phone', { title: 'On your phone', render(target) {
    draw(target);
    send({ type: 'code_phone_state' });
    send({ type: 'code_phone_pair', peek: true });
  } });
  F.registerMoreItem({ label: 'Open on my phone', note: 'Opens this session on your phone', run: handoff });
  F.registerSlash({ name: 'phone', help: 'Open this session on your phone', run() { handoff(); return true; } });
  F.on('code_phone', (ev) => {
    Object.assign(state, {
      on: ev.on === true, running: ev.running === true, url: ev.url || '', qr: ev.qr || [],
      short: ev.short || '', pinned: ev.pinned || null, pushed: ev.pushed || null,
    });
    render();
  });
  F.on('code_phone_pair', (ev) => {
    pair = ev;
    pairEnds = Date.now() + (Number(ev.seconds) || 0) * 1000;
    if (ev.code) pairedNow = false;
    render();
  });
  // A phone paired (remote.py, POST /api/pair): the code is spent, so it goes from the screen.
  F.on('devices', (ev) => {
    if (!ev || ev.paired !== true || !pair || !pair.code) return;
    pair = { ...pair, code: '', qr: [] };
    pairedNow = true;
    render();
  });
  // Settings › iPhone & Watch made a new code: the same one, shown here too.
  F.on('remote_code', () => { if (body && body.isConnected) send({ type: 'code_phone_pair', peek: true }); });
  root.edenCodePair = { open() { F.openPane('phone'); askCode(false); } };
})(typeof window === 'object' ? window : globalThis);
