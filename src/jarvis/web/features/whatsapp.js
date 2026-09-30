// WhatsApp in Tools & Accounts (features/whatsapp.py): link the owner's own account by
// scanning a code with the phone, see that it's connected, unlink it. Reading and sending
// are JARVIS's tools; every send is a card with the exact text first.
(function whatsappFeature() {
  const F = window.jarvisFeatures;
  const sheet = F && F.$('accounts');
  if (!sheet) return;
  const { el, send } = F;

  const group = el('section', 'group wa-group');
  group.id = 'wa-group';
  const head = el('div', 'wa-head');
  head.append(el('h3', '', 'WhatsApp'), el('span', 'wa-dot'));
  const status = el('p', 'small-status wa-status', 'Not linked');
  const error = el('p', 'form-error wa-error');
  error.hidden = true;
  const qrBox = el('div', 'wa-qr-box');
  qrBox.hidden = true;
  const qr = el('img', 'wa-qr');
  qr.alt = 'WhatsApp link code';
  qrBox.append(
    qr,
    el('p', 'group-note', 'On your phone: WhatsApp → Settings → Linked devices → Link a device, then scan this code.'),
  );
  const actions = el('div', 'wa-actions');
  const link = el('button', 'btn primary', 'Link WhatsApp');
  link.type = 'button';
  const unlink = el('button', 'btn', 'Unlink');
  unlink.type = 'button';
  unlink.hidden = true;
  actions.append(link, unlink);
  const announceRow = el('label', 'wa-announce');
  const announce = el('input');
  announce.type = 'checkbox';
  announceRow.append(announce, el('span', '', 'Tell me when a WhatsApp message comes in'));
  announceRow.hidden = true;
  const note = el(
    'p',
    'group-note',
    'Jarvis links as one of your WhatsApp devices, as WhatsApp Web does, and stays offline so your phone keeps its notifications. It reads your chats and sends only what you approve. WhatsApp doesn’t officially support assistants like this: use it for your own everyday messages, never bulk sending.',
  );
  group.append(head, status, error, qrBox, actions, announceRow, note);
  const first = sheet.querySelector('section.group');
  if (first) first.after(group);
  else sheet.append(group);

  let state = 'off';
  link.addEventListener('click', () => send({ type: 'whatsapp_link' }));
  unlink.addEventListener('click', () => {
    if (state === 'linking' || state === 'starting' || state === 'installing') {
      send({ type: 'whatsapp_unlink' });  // stop waiting for a scan
      return;
    }
    if (confirm(F.t('Unlink WhatsApp from Jarvis? Jarvis logs out of your account and forgets what it saw.'))) {
      send({ type: 'whatsapp_unlink' });
    }
  });
  announce.addEventListener('change', () => {
    send({ type: 'feature_prefs', changes: { whatsapp_announce: announce.checked } });
  });

  function render(ev) {
    state = ev.state || 'off';
    group.dataset.state = state;
    let line = ev.line || state;
    if (state === 'connected' && ev.me) {
      const who = [ev.me.name, ev.me.phone].filter(Boolean).join(' · ');
      line = who ? `Connected as ${who}` : 'Connected';
      if (ev.unread) line += ` · ${ev.unread} unread`;
    }
    status.textContent = line;
    error.textContent = ev.error || '';
    error.hidden = !ev.error;
    const waiting = state === 'linking' || state === 'starting' || state === 'installing';
    qrBox.hidden = !(state === 'linking' && ev.qr);
    if (ev.qr) qr.src = ev.qr;
    link.hidden = !(state === 'off' || state === 'error' || state === 'elsewhere');
    link.textContent = state === 'off' ? 'Link WhatsApp' : 'Try again';
    unlink.hidden = !(waiting || state === 'connected' || state === 'connecting');
    unlink.textContent = waiting ? 'Cancel' : 'Unlink';
    announceRow.hidden = !(state === 'connected' || state === 'connecting');
    if (ev.show && sheet.hidden && typeof toggleAccounts === 'function') toggleAccounts(true);
  }

  function renderPrefs(prefs) {
    const features = (prefs && prefs.features) || {};
    announce.checked = features.whatsapp_announce === true;
  }

  F.on('whatsapp', render, { replay: true });
  F.on('hello', (ev) => { renderPrefs(ev.prefs); send({ type: 'whatsapp_status' }); }, { replay: true });
  F.on('prefs', (ev) => renderPrefs(ev.prefs || ev), { replay: true });
  send({ type: 'whatsapp_status' });
})();
