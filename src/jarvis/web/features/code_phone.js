// Eden Code on the phone (features/code_phone.py), the Mac's side: Hand off to phone (a
// session's More menu, or /phone) pins the open session to the phone's view and sends a push
// with its link; the Phone pane shows the switch for the phone's web page (off until turned
// on), its address and a QR code to open it, the session pinned now (Unpin), and how the last
// handoff went.
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

  const api = { qrPath, pinnedText, PREF };
  if (typeof module === 'object' && module.exports) { module.exports = api; return; }

  const F = root.jarvisFeatures;
  if (!F) return;
  const { el, send, t } = F;
  const keepFocus = (box, drawIt) => (root.jarvisFocus ? root.jarvisFocus.keep(box, drawIt) : drawIt());
  const mine = (node) => { node.setAttribute('data-no-i18n', ''); return node; };
  const state = { on: false, running: false, url: '', qr: [], short: '', pinned: null, pushed: null };
  let body = null;

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

  function qrNode() {
    const NS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(NS, 'svg');
    const size = state.qr.length + 8;
    svg.setAttribute('viewBox', `0 0 ${size} ${size}`);
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', t('QR code for the phone page'));
    svg.setAttribute('shape-rendering', 'crispEdges');
    svg.setAttribute('class', 'jcx-phone-qr');
    const bg = document.createElementNS(NS, 'rect');
    bg.setAttribute('width', String(size));
    bg.setAttribute('height', String(size));
    bg.setAttribute('fill', '#fff');
    const path = document.createElementNS(NS, 'path');
    path.setAttribute('d', qrPath(state.qr));
    path.setAttribute('fill', '#000');
    svg.append(bg, path);
    return svg;
  }

  function draw(target) {
    body = target;
    const wrap = el('div', 'jcx-phonepane');
    const task = F.currentTask();
    wrap.append(el('p', 'jc-dim', 'Start at the desk, carry on from your phone: Hand off pins this session to your phone’s view and sends a notification with its link.'));
    const go = button('Hand off this session', 'jc-btn filled', handoff, 'Pins it for your phone and sends a notification');
    go.disabled = !task;
    wrap.append(go);
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
      if (state.qr.length) wrap.append(qrNode());
      wrap.append(el('p', 'jc-dim jcx-phone-line', 'Open it on your phone, pair with the code from Settings › iPhone & Watch, then Share › Add to Home Screen. It works on this Mac’s Wi-Fi, or over Tailscale when you’re away.'));
      if (state.short) wrap.append(mine(el('p', 'jc-dim jcx-phone-line', `${t('Safari warns about this Mac’s own certificate once. Its fingerprint starts')} ${state.short}.`)));
    }
    keepFocus(target, () => target.replaceChildren(wrap));
  }

  function render() { if (body && body.isConnected && body.querySelector('.jcx-phonepane')) draw(body); }

  F.registerPane('phone', { title: 'On your phone', render(target) { draw(target); send({ type: 'code_phone_state' }); } });
  F.registerMoreItem({ label: 'Hand off to phone', note: 'Carry on with this session on your phone', run: handoff });
  F.registerSlash({ name: 'phone', help: 'Hand this session off to your phone', run() { handoff(); return true; } });
  F.on('code_phone', (ev) => {
    Object.assign(state, {
      on: ev.on === true, running: ev.running === true, url: ev.url || '', qr: ev.qr || [],
      short: ev.short || '', pinned: ev.pinned || null, pushed: ev.pushed || null,
    });
    render();
  });
})(typeof window === 'object' ? window : globalThis);
