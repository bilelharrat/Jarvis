// Settings › Oura Ring (features/oura.py): connect the owner's Oura ring, so last night's
// sleep and readiness are in the morning briefing and the wake-up call. Oura takes OAuth
// only: the owner makes a free app on Oura's developer site with the redirect URI shown
// here, pastes its client ID and secret (kept in the Keychain), then Connect opens Oura's
// consent page. helpers is exported for node --test (tests/web/oura.test.mjs).
(function (root) {
  'use strict';

  const helpers = {
    // The status line for the backend's oura event.
    status(s) {
      if (!s) return '';
      if (s.connecting) return 'Waiting for you to allow access on Oura’s page in your browser…';
      if (s.error) return s.error;
      if (s.connected) return s.last ? `Connected. Last read at ${s.last}.` : 'Connected. Your sleep is in the morning briefing.';
      if (s.client) return 'App saved. Now connect, and allow access on Oura’s page.';
      return 'Not connected.';
    },
  };

  if (typeof module === 'object' && module.exports) { module.exports = helpers; return; }

  const F = root.jarvisFeatures;
  if (!F) return;
  const { el, send } = F;
  const t = (s) => F.t(s);
  let state = null;

  function button(label, run, cls = 'btn') {
    const b = el('button', cls, t(label));
    b.type = 'button';
    b.addEventListener('click', run);
    return b;
  }

  function field(id, label, type) {
    const row = el('label', 'row stack');
    row.htmlFor = id;
    const input = el('input');
    input.id = id;
    input.type = type;
    input.spellcheck = false;
    input.autocomplete = 'off';
    row.append(el('strong', '', t(label)), input);
    return row;
  }

  function group() {
    let section = F.$('oura-group');
    if (section) return section;
    const settings = F.$('settings');
    if (!settings) return null;
    section = el('section', 'group oura-group');
    section.id = 'oura-group';
    const status = el('p', 'small-status');
    status.id = 'oura-status';
    const steps = el('ol', 'oura-steps');
    const one = el('li');
    one.append(document.createTextNode(t('Make a free app on Oura’s developer site (any name) with this redirect URI:') + ' '));
    const uri = el('code', 'oura-uri');
    uri.id = 'oura-uri';
    uri.setAttribute('data-no-i18n', '');
    one.append(uri, document.createTextNode(' '), button('Open Oura’s site', () => send({ type: 'oura_open_apps' }), 'btn small'));
    steps.append(one, el('li', '', t('Paste its client ID and secret, and save.')), el('li', '', t('Connect, and allow access on Oura’s page.')));
    const save = button('Save', () => {
      const id = F.$('oura-client-id').value.trim();
      const secret = F.$('oura-client-secret').value.trim();
      send({ type: 'oura_save_client', client_id: id, client_secret: secret });
      F.$('oura-client-secret').value = '';
    });
    const actions = el('div', 'row oura-actions');
    const connect = button('Connect with Oura', () => send({ type: 'oura_connect' }), 'btn primary');
    connect.id = 'oura-connect';
    const off = button('Disconnect', () => send({ type: 'oura_disconnect' }));
    off.id = 'oura-disconnect';
    actions.append(connect, off);
    section.append(el('h3', '', t('Oura Ring')), status, steps,
      field('oura-client-id', 'Client ID', 'text'), field('oura-client-secret', 'Client secret', 'password'), save, actions);
    const last = settings.querySelector('#open-accounts');
    const before = last ? last.closest('section.group') : null;
    if (before) settings.insertBefore(section, before); else settings.append(section);
    return section;
  }

  function render() {
    if (!group() || !state) return;
    F.$('oura-status').textContent = t(helpers.status(state));
    F.$('oura-uri').textContent = state.redirect_uri || '';
    F.$('oura-connect').disabled = !state.client || state.connecting;
    F.$('oura-connect').textContent = t(state.connected ? 'Reconnect' : 'Connect with Oura');
    F.$('oura-disconnect').hidden = !state.connected;
  }

  F.on('hello', () => { group(); send({ type: 'oura_state' }); }, { replay: true });
  F.on('oura', (ev) => { state = ev; render(); });
})(typeof window !== 'undefined' ? window : globalThis);
