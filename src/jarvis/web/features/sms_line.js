// Settings › Texts to the Jarvis number (the backend is jarvis.features.sms_line): a heads-up
// for each text people send the owner's Twilio number, and cards answered by text from the
// owner's own phone with a one-time code. The texts listed are people's words (data-no-i18n).
(() => {
  const F = window.jarvisFeatures;
  if (!F) return;
  const { el, send } = F;

  const state = { on: false, approvals: false, number: '', me: false, paused: false, error: '', texts: [] };
  const parts = {};

  function mine(node) {
    node.setAttribute('data-no-i18n', '');
    return node;
  }

  function toggle(id, label, note, key) {
    const row = el('div', 'row');
    const words = el('span');
    words.append(el('strong', '', label), el('small', '', note));
    const sw = el('button', 'switch');
    sw.type = 'button';
    sw.id = id;
    sw.setAttribute('role', 'switch');
    sw.setAttribute('aria-checked', 'false');
    sw.setAttribute('aria-label', label);
    sw.addEventListener('click', () => {
      const next = sw.getAttribute('aria-checked') !== 'true';
      sw.setAttribute('aria-checked', String(next));  // shown now; the prefs event confirms it
      send({ type: 'feature_prefs', changes: { [key]: next } });
    });
    row.append(words, sw);
    return [row, sw];
  }

  function build() {
    if (parts.section) return parts.section;
    const settings = F.$('settings');
    if (!settings) return null;
    const section = el('section', 'group sms-line');
    section.id = 'sms-line-group';
    const [onRow, onSwitch] = toggle('sw-sms-line', 'Tell me about texts', 'A heads-up when someone texts your Twilio number, with who it’s from', 'sms_line_on');
    const [okRow, okSwitch] = toggle('sw-sms-approvals', 'Answer cards by text',
      'When a card waits a minute on the Mac, Jarvis texts it to your own number with a code: reply YES and the code, or NO and the code. Never for purchases, never in quiet hours. About 1¢ a text.',
      'sms_approvals');
    const status = el('p', 'small-status sms-status');
    status.id = 'sms-line-status';
    status.setAttribute('aria-live', 'polite');
    const list = el('ul', 'itemlist sms-texts');
    list.id = 'sms-line-texts';
    section.append(el('h3', '', 'Texts to the Jarvis number'), onRow, okRow, status, list);
    const phone = F.$('phone-sid');
    const after = phone ? phone.closest('section.group') : null;
    if (after && after.nextElementSibling) settings.insertBefore(section, after.nextElementSibling);
    else settings.append(section);
    Object.assign(parts, { section, onSwitch, okSwitch, status, list });
    return section;
  }

  function when(iso) {
    const at = new Date(iso);
    if (Number.isNaN(at.getTime())) return '';
    const time = at.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    return at.toDateString() === new Date().toDateString() ? time : `${at.toLocaleDateString([], { weekday: 'short' })} ${time}`;
  }

  function statusLine() {
    if (!state.number) return 'Add your Twilio number under Phone first.';
    if (state.approvals && !state.me) return 'Add your own number under Phone so cards can reach you.';
    if (state.paused) return 'Answering by text is off for an hour: someone sent wrong codes. Answer cards on the Mac.';
    return state.error || '';
  }

  function textItem(t) {
    const li = el('li', 'sms-text');
    const fact = el('span', 'fact');
    fact.append(mine(el('strong', '', t.who || t.from)), mine(el('span', 'sms-body', t.body)));
    const at = when(t.at);
    if (at) fact.append(mine(el('small', '', at)));
    li.append(fact);
    return li;
  }

  function render() {
    if (!build()) return;
    parts.onSwitch.setAttribute('aria-checked', String(!!state.on));
    parts.okSwitch.setAttribute('aria-checked', String(!!state.approvals));
    parts.status.textContent = statusLine();
    parts.status.hidden = !parts.status.textContent;
    parts.list.replaceChildren(...(state.on ? state.texts.slice(0, 10).map(textItem) : []));
  }

  function fromPrefs(p) {
    if (!p) return;
    const features = p.features || {};
    state.on = features.sms_line_on === true;
    state.approvals = features.sms_approvals === true;
    if (typeof p.phone_from === 'string') state.number = p.phone_from;
    if (typeof p.phone_me === 'string') state.me = Boolean(p.phone_me);
    render();
  }

  F.on('hello', (ev) => { fromPrefs(ev.prefs); send({ type: 'sms_line' }); }, { replay: true });
  F.on('prefs', fromPrefs);
  F.on('sms_line', (ev) => {
    Object.assign(state, {
      on: !!ev.on, approvals: !!ev.approvals, number: ev.number || '', me: !!ev.me,
      paused: !!ev.paused, error: ev.error || '', texts: Array.isArray(ev.texts) ? ev.texts : [],
    });
    render();
  });
})();
