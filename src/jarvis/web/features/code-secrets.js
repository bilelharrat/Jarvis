// A session's request for a secret (features/code_secrets.py): a card in its transcript with
// a masked field, where the owner types an API key or a password and picks where it's kept
// (this session, or this project in the Keychain), or declines; and the Secrets pane (More
// menu), which lists the names a session can use and removes them.
//
// The value goes from the field straight to the backend, which keeps it in the Keychain: the
// field is cleared as it's sent, never shown (no "show" button), never kept in the window and
// never sent back. Claude only gets the name ($SECRET_…). The reason on the card is Claude's
// words: shown as text, marked as such. Pure helpers are exported for node --test.
(function (root) {
  'use strict';

  const VALUE_MIN = 4;
  const VALUE_MAX = 10000;

  // A value the backend takes: 4 to 10,000 characters, no NUL (a pasted line's newline goes).
  function cleanValue(raw) {
    const value = String(raw == null ? '' : raw).replace(/[\r\n]+$/, '');
    if (value.length < VALUE_MIN || value.length > VALUE_MAX || value.includes('\u0000')) return null;
    return value;
  }

  // A card's settled state, as it reads.
  function stateText(state, scope) {
    if (state === 'given') return scope === 'project' ? 'Saved for this project, in the Keychain.' : 'Saved for this session.';
    if (state === 'declined') return 'You declined.';
    if (state === 'expired') return 'No answer: the request expired.';
    return '';
  }

  const api = { cleanValue, stateText };
  if (typeof module === 'object' && module.exports) { module.exports = api; return; }

  const F = root.jarvisFeatures;
  if (!F) return;
  const { el, t } = F;
  const mine = (node) => { node.setAttribute('data-no-i18n', ''); return node; };
  const cards = new Map();  // ask id -> its card

  function button(label, cls, run) {
    const b = el('button', cls || 'jc-mini', label);
    b.type = 'button';
    b.addEventListener('click', run);
    return b;
  }

  function settle(card, state, scope) {
    card.className = `sec-card ${state}`;
    const form = card.querySelector('.sec-form');
    if (form) {
      const input = form.querySelector('input.sec-input');
      if (input) input.value = '';
      form.remove();
    }
    let line = card.querySelector('.sec-state');
    if (!line) { line = el('div', 'sec-state'); card.append(line); }
    line.textContent = t(stateText(state, scope));
  }

  function secretEntry(e) {
    const li = el('li', `sec-card ${e.state || ''}`);
    li.dataset.ask = e.ask || '';
    const head = el('div', 'sec-head');
    head.append(el('strong', '', 'Jarvis Code asks for a secret'), mine(el('code', 'sec-name', `$${e.name || ''}`)));
    li.append(head);
    if (e.why) {
      const why = el('div', 'sec-why');
      why.append(el('span', 'sec-why-label', 'Its reason:'), mine(el('span', '', e.why)));
      li.append(why);
    }
    if (e.state !== 'waiting') {
      settle(li, e.state, e.scope);
      return li;
    }
    const form = el('form', 'sec-form');
    form.autocomplete = 'off';
    const input = el('input', 'sec-input');
    input.type = 'password';
    input.autocomplete = 'new-password';
    input.spellcheck = false;
    input.setAttribute('autocapitalize', 'off');
    input.setAttribute('autocorrect', 'off');
    input.setAttribute('aria-label', t('The secret’s value'));
    input.placeholder = t('Paste or type it here');
    input.dataset.noI18n = '';
    const scopes = el('div', 'sec-scopes');
    scopes.setAttribute('role', 'radiogroup');
    const name = `sec-scope-${e.ask}`;
    for (const [value, label] of [['session', 'This session'], ['project', 'This project']]) {
      const opt = el('label');
      const radio = el('input');
      radio.type = 'radio';
      radio.name = name;
      radio.value = value;
      radio.checked = value === 'session';
      opt.append(radio, el('span', '', label));
      scopes.append(opt);
    }
    const error = el('div', 'sec-error');
    error.hidden = true;
    const save = button('Save', 'jc-mini sec-save', () => form.requestSubmit());
    const decline = button('Decline', 'jc-mini', () => {
      input.value = '';
      F.send({ type: 'sec_answer', ask: e.ask, decline: true });
    });
    const buttons = el('div', 'sec-buttons');
    buttons.append(save, decline);
    form.append(input, scopes, buttons, error, el('small', 'sec-note',
      'It goes straight to the Keychain. Jarvis Code only ever sees its name, never the value, and it’s scrubbed from the transcript and the session’s output. A session’s own is deleted when the session ends.'));
    form.addEventListener('submit', (ev) => {
      ev.preventDefault();
      const value = cleanValue(input.value);
      input.value = '';  // never kept in the window, whatever happens next
      if (value === null) {
        error.textContent = t('That secret is too short or too long.');
        error.hidden = false;
        return;
      }
      error.hidden = true;
      const picked = form.querySelector(`input[name="${name}"]:checked`);
      save.disabled = true;
      F.send({ type: 'sec_answer', ask: e.ask, value, scope: picked ? picked.value : 'session' });
    });
    li.append(form);
    cards.set(e.ask, li);
    return li;
  }
  F.registerEntry('secret', secretEntry);

  F.on('sec_state', (ev) => {
    const card = cards.get(ev.ask);
    if (card && card.isConnected) settle(card, ev.state, ev.scope);
    if (card) cards.delete(ev.ask);
    const task = F.currentTask();
    if (task && task.id === ev.id && paneOpen()) F.send({ type: 'sec_list', id: task.id });
  });
  F.on('sec_error', (ev) => {
    const card = cards.get(ev.ask);
    const error = card && card.querySelector('.sec-error');
    if (error) {
      error.textContent = t(ev.text);
      error.hidden = false;
      const save = card.querySelector('.sec-save');
      if (save) save.disabled = false;
    } else if (typeof jcNote === 'function') jcNote(ev.text);
  });

  // ── the Secrets pane ──

  function paneOpen() {
    return typeof currentPane !== 'undefined' && currentPane === 'sec-pane' && F.$('jc-pane') && !F.$('jc-pane').hidden;
  }

  function list(ev, scope, names, empty) {
    if (!names.length) return el('p', 'cv-note', empty);
    const ul = el('ul', 'sec-list');
    for (const n of names) {
      const li = el('li');
      li.append(mine(el('code', 'sec-name', `$${n}`)), button('Remove', 'jc-mini danger', () => F.send({ type: 'sec_remove', id: ev.id, name: n, scope })));
      ul.append(li);
    }
    return ul;
  }

  function renderPane(ev) {
    const body = F.$('jc-pane-body');
    if (!body || !paneOpen()) return;
    body.replaceChildren(
      el('p', 'sec-note', 'The secrets this session can use, by name. Their values stay in the Keychain and are never shown.'),
      el('h4', '', 'This session'),
      list(ev, 'session', ev.session || [], 'None yet.'),
      el('h4', '', 'This project'),
      list(ev, 'project', ev.projects || [], 'None yet.'),
    );
  }

  F.registerPane('sec-pane', {
    title: 'Secrets',
    render(body) {
      body.replaceChildren(el('p', 'cv-note', 'Looking…'));
      const task = F.currentTask();
      if (task) F.send({ type: 'sec_list', id: task.id });
    },
  });
  F.registerMoreItem({ label: 'Secrets', note: 'Keys and passwords you gave this session', when: (task) => !!task, run: () => F.openPane('sec-pane') });
  F.on('sec_list', (ev) => {
    const task = F.currentTask();
    if (task && task.id === ev.id) renderPane(ev);
  });
})(typeof window === 'object' ? window : globalThis);
