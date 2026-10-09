// Settings › Email accounts (features/winmail.py): add the email accounts Jarvis reads and sends
// through, on a PC (on a Mac, Mail.app is used and this page never appears: the backend doesn't
// answer). Type the address; the provider's servers and what to do about its password come back;
// "Check it" signs in to both servers and says so in words; "Add account" keeps it. The password
// goes to the backend once, straight to the system's secret store, and the field is cleared.
// Every control has a label, the results are announced (role=status), and nothing needs a mouse.
(function (root) {
  'use strict';

  // The server fields a window may send as typed, for the words the page says.
  const lib = {
    // The "Server settings" a person changed from what was guessed: only those are sent.
    changed(guess, typed) {
      const out = {};
      for (const key of Object.keys(typed)) {
        const value = String(typed[key] == null ? '' : typed[key]).trim();
        if (value !== '' && String(guess[key] == null ? '' : guess[key]) !== value) out[key] = value;
      }
      return out;
    },
    // What to say about a list of accounts.
    summary(accounts) {
      if (!accounts.length) return 'No email accounts yet.';
      return `${accounts.length} email ${accounts.length === 1 ? 'account' : 'accounts'}.`;
    },
  };
  root.jarvisMailAccounts = lib;

  const F = root.jarvisFeatures;
  if (!F || !root.document) return;
  const doc = root.document;
  const { el, send } = F;
  const t = (s) => F.t(s);

  let accounts = [];
  let outlook = { available: false, open: false };
  let guess = null; // the servers last guessed for the address being typed
  let group = null;
  const field = {};

  function labeled(id, label, note, input) {
    const row = el('label', 'row stack');
    row.setAttribute('for', id);
    const words = el('span');
    words.append(el('strong', '', t(label)));
    if (note) words.append(el('small', '', t(note)));
    input.id = id;
    row.append(words, input);
    return row;
  }
  function input(type, extra = {}) {
    const node = el('input');
    node.type = type;
    node.autocomplete = 'off';
    node.spellcheck = false;
    for (const [k, v] of Object.entries(extra)) node.setAttribute(k, v);
    return node;
  }

  const say = (text, bad = false) => {
    const status = field.result;
    if (!status) return;
    status.textContent = text;
    status.classList.toggle('mail-bad', bad);
  };

  function drawList() {
    if (!field.list) return;
    field.summary.textContent = t(lib.summary(accounts));
    field.list.replaceChildren(...accounts.map((a) => {
      const li = el('li', 'mail-account');
      const name = el('span', 'mail-name', a.address + (a.label ? ` (${a.label})` : ''));
      const check = el('button', 'btn', t('Check'));
      check.type = 'button';
      check.setAttribute('aria-label', `${t('Check')} ${a.address}`);
      check.addEventListener('click', () => {
        say(t('Checking…'));
        if (a.kind === 'outlook') { send({ type: 'mail_outlook', action: 'check' }); return; }
        send({ type: 'mail_check', address: a.address, name: a.name, label: a.label, imap_host: a.imap_host, imap_port: a.imap_port, imap_security: a.imap_security, smtp_host: a.smtp_host, smtp_port: a.smtp_port, smtp_security: a.smtp_security, username: a.username });
      });
      const password = el('button', 'btn', t('Change password'));
      password.type = 'button';
      password.setAttribute('aria-label', `${t('Change password')} ${a.address}`);
      password.addEventListener('click', () => {
        field.address.value = a.address;
        field.name.value = a.name || '';
        field.label.value = a.label || '';
        send({ type: 'mail_guess', address: a.address });
        field.password.focus();
      });
      password.hidden = a.kind === 'outlook';  // (Outlook is signed in already: there is no password of ours)
      const remove = el('button', 'btn', t('Remove'));
      remove.type = 'button';
      remove.setAttribute('aria-label', `${t('Remove')} ${a.address}`);
      remove.addEventListener('click', () => {
        if (root.confirm(`${t('Remove')} ${a.address}? ${t('Your mail stays where it is.')}`)) send({ type: 'mail_remove', id: a.id });
      });
      li.append(name, check, password, remove);
      return li;
    }));
  }

  const SERVER_KEYS = ['imap_host', 'imap_port', 'imap_security', 'smtp_host', 'smtp_port', 'smtp_security', 'username'];
  function typed() {
    const servers = {};
    for (const key of SERVER_KEYS) servers[key] = field[key].value;
    return {
      address: field.address.value.trim(),
      password: field.password.value,
      name: field.name.value.trim(),
      label: field.label.value.trim(),
      // Only what was changed from the guess: the backend knows the provider's own servers best.
      ...(guess ? lib.changed(guess, servers) : lib.changed({}, servers)),
    };
  }

  function fillServers(account) {
    field.imap_host.value = account.imap_host || '';
    field.imap_port.value = account.imap_port || '';
    field.imap_security.value = account.imap_security || 'ssl';
    field.smtp_host.value = account.smtp_host || '';
    field.smtp_port.value = account.smtp_port || '';
    field.smtp_security.value = account.smtp_security || 'ssl';
    field.username.value = account.username || '';
  }

  function ask(kind) {
    const values = typed();
    if (!values.address) { say(t('Type your email address first.'), true); field.address.focus(); return; }
    if (!values.password && !accounts.some((a) => a.id === values.address.toLowerCase() && a.has_password)) {
      say(t('Type the app password first.'), true);
      field.password.focus();
      return;
    }
    say(kind === 'mail_save' ? t('Signing in and saving…') : t('Checking…'));
    send({ type: kind, ...values });
    values.password = '';
  }

  function build() {
    const sheet = doc.getElementById('settings');
    if (!sheet || group) return;
    group = el('section', 'group');
    group.id = 'mail-group';
    group.hidden = true; // until the backend answers (a Mac has Mail.app instead)
    group.dataset.settingsPane = 'general';
    group.dataset.keywords = 'email mail gmail outlook icloud yahoo account accounts imap smtp password send read inbox';
    group.append(el('h3', '', t('Email accounts')));
    group.append(el('p', 'group-note', t('Jarvis reads and sends your email through your own accounts, straight from this computer. Passwords are kept in the system’s password store and are never shown again.')));
    field.summary = el('p', 'small-status');
    field.summary.id = 'mail-summary';
    field.list = el('ul', 'mail-list');
    field.list.id = 'mail-list';
    field.list.setAttribute('aria-label', t('Your email accounts'));
    group.append(field.summary, field.list);

    // The Outlook program on this PC (shown only where it is): no address, no password, nothing to type.
    field.outlookBox = el('div', 'mail-outlook');
    field.outlookBox.hidden = true;
    field.outlookBox.append(el('h4', '', t('Use Outlook on this PC')));
    field.outlookBox.append(el('p', 'group-note', t('If your mail is in Outlook (a school or an office account), Jarvis can read and send it through the Outlook program that is already signed in on this computer. Nothing to type. What you send goes out from Outlook, in your own signature and font, and is kept in your Sent Items. Outlook has to be open.')));
    field.outlookAdd = el('button', 'btn primary', t('Use my Outlook'));
    field.outlookAdd.type = 'button';
    field.outlookAdd.id = 'mail-outlook-add';
    field.outlookAdd.addEventListener('click', () => { say(t('Asking Outlook…')); send({ type: 'mail_outlook', action: 'add' }); });
    field.outlookBox.append(field.outlookAdd);
    group.append(field.outlookBox);

    const form = el('form', 'mail-form');
    form.id = 'mail-form';
    form.autocomplete = 'off';
    form.setAttribute('aria-label', t('Add an email account'));
    form.append(el('h4', '', t('Add an account')));
    field.address = input('email', { inputmode: 'email' });
    form.append(labeled('mail-address', 'Email address', 'For example name@gmail.com', field.address));
    field.help = el('p', 'small-status');
    field.help.id = 'mail-help';
    field.help.setAttribute('role', 'status');
    form.append(field.help);
    field.password = input('password');
    field.password.setAttribute('aria-describedby', 'mail-help');
    form.append(labeled('mail-password', 'App password', 'Not your usual password: the one made for apps, as the advice above says.', field.password));
    field.name = input('text');
    form.append(labeled('mail-name', 'Name on your emails', 'Optional. What people see as the sender.', field.name));
    field.label = input('text');
    form.append(labeled('mail-label', 'Label', 'Optional. A word for this account, such as Work.', field.label));

    const more = el('details', 'mail-servers');
    more.append(el('summary', '', t('Server settings (filled in for you)')));
    const select = (options) => {
      const node = el('select');
      for (const [value, name] of options) node.append(el('option', '', t(name)));
      [...node.options].forEach((o, i) => { o.value = options[i][0]; });
      return node;
    };
    const SECURITY = [['ssl', 'SSL'], ['starttls', 'STARTTLS'], ['none', 'None (this computer only)']];
    field.imap_host = input('text');
    field.imap_port = input('number', { min: '1', max: '65535' });
    field.imap_security = select(SECURITY);
    field.smtp_host = input('text');
    field.smtp_port = input('number', { min: '1', max: '65535' });
    field.smtp_security = select(SECURITY);
    field.username = input('text');
    more.append(
      labeled('mail-imap-host', 'Incoming server', 'Reads your mail (IMAP)', field.imap_host),
      labeled('mail-imap-port', 'Incoming port', '', field.imap_port),
      labeled('mail-imap-security', 'Incoming security', '', field.imap_security),
      labeled('mail-smtp-host', 'Outgoing server', 'Sends your mail (SMTP)', field.smtp_host),
      labeled('mail-smtp-port', 'Outgoing port', '', field.smtp_port),
      labeled('mail-smtp-security', 'Outgoing security', '', field.smtp_security),
      labeled('mail-username', 'Sign-in name', 'Only if it isn’t your email address', field.username),
    );
    form.append(more);

    const actions = el('div', 'mail-actions');
    const check = el('button', 'btn', t('Check it'));
    check.type = 'button';
    check.addEventListener('click', () => ask('mail_check'));
    const add = el('button', 'btn primary', t('Add account'));
    add.type = 'submit';
    actions.append(check, add);
    form.append(actions);
    field.result = el('p', 'small-status');
    field.result.id = 'mail-result';
    field.result.setAttribute('role', 'status');
    field.result.setAttribute('aria-live', 'polite');
    form.append(field.result);
    form.addEventListener('submit', (e) => { e.preventDefault(); ask('mail_save'); });
    field.address.addEventListener('input', () => { guess = null; });
    field.address.addEventListener('change', () => {
      const address = field.address.value.trim();
      for (const key of SERVER_KEYS) field[key].value = key.endsWith('_security') ? 'ssl' : '';
      field.help.textContent = '';
      if (address) send({ type: 'mail_guess', address });
    });
    group.append(form);

    const before = doc.getElementById('a11y-group');
    if (before) before.after(group);
    else (sheet.querySelector('.group') || sheet.lastElementChild).before(group);
  }

  F.on('mail_accounts', (ev) => {
    accounts = Array.isArray(ev.accounts) ? ev.accounts : [];
    outlook = ev.outlook && typeof ev.outlook === 'object' ? ev.outlook : { available: false, open: false };
    build();
    group.hidden = false;
    field.outlookBox.hidden = !outlook.available || accounts.some((a) => a.kind === 'outlook');
    drawList();
  }, { replay: true });

  F.on('mail_guess', (ev) => {
    if (!field.help || ev.address !== field.address.value.trim()) return;
    if (!ev.ok) { field.help.textContent = ev.text || ''; guess = null; return; }
    guess = ev.account;
    fillServers(ev.account);
    field.help.textContent = ev.help
      ? `${ev.provider}: ${ev.help}`
      : t('I don’t know this provider’s servers; I’ve guessed them. Open Server settings to change them.');
    if (!field.name.value && ev.account && ev.account.name) field.name.value = ev.account.name;
  });

  F.on('mail_check', (ev) => {
    if (!field.result) return;
    say(ev.text || '', !ev.ok);
    if (ev.ok && ev.saved) {
      field.password.value = '';
      field.address.value = '';
      field.name.value = '';
      field.label.value = '';
      field.help.textContent = '';
      field.address.focus();
    }
  });

  const hello = () => send({ type: 'mail_status' });
  F.on('hello', hello);
  hello();
  const mount = () => build();
  if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', mount); else mount();
  lib.state = () => ({ accounts, guess });
})(typeof window !== 'undefined' ? window : globalThis);
