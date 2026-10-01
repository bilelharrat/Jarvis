// Settings › Chats: talk to Jarvis from Telegram, iMessage, WhatsApp, Signal, Slack and
// Discord (the backend is jarvis.channels). Each chat is connected here (a pasted token goes
// one way, into the Keychain, and the field empties at once), paired with a one-time code (or,
// for WhatsApp and Signal, the owner's own linked account), switched on or off, and told what
// to pass on: heads-ups (urgent only, all, none) and approval cards. Group chats are off until
// switched on, and each group JARVIS was asked in has its own switch and tool setting. Names
// and addresses the chats bring are shown as data (data-no-i18n), never as markup.
(() => {
  const F = window.jarvisFeatures;
  if (!F) return;
  const { el, send } = F;

  const ORDER = ['telegram', 'imessage', 'whatsapp', 'signal', 'slack', 'discord'];
  const STATUS = {
    off: 'Off',
    needs_setup: 'Not set up',
    starting: 'Starting…',
    listening: 'On',
    needs_pairing: 'Waiting for you to pair',
    reconnecting: 'Reconnecting…',
    error: 'Stopped',
  };
  const HELP = {
    telegram: 'In Telegram, message @BotFather, send /newbot and paste the token it gives you here. Then press Pair and send the code to your new bot.',
    slack: 'Make a Slack app of your own (api.slack.com/apps) with Socket Mode on. Give its bot the chat:write, im:history, im:read, files:read and files:write scopes, subscribe it to message.im and turn on its Messages tab. Paste its app-level token (with connections:write) and its bot token. Then press Pair and send the code to the app in a direct message.',
    discord: 'In the Discord Developer Portal, make an application, add a bot and copy its token. Invite the bot to a server you’re in, so you can message it. Then press Pair and send the code to the bot in a direct message.',
    whatsapp: 'Uses the WhatsApp linked in Tools & Accounts. Message yourself in WhatsApp (the chat with your own number) to talk to Jarvis; its replies start with “Jarvis:”. What anyone else writes to you is never read as yours.',
    signal: 'Signal works through signal-cli, linked to your account as one of its devices; Jarvis doesn’t install it. In Terminal: brew install signal-cli, then signal-cli link -n Jarvis, and scan the sgnl:// link it prints as a QR code (on your phone: Signal › Settings › Linked devices). Then press Check again. Talk to Jarvis in your Note to Self chat.',
    imessage: 'Pick the conversation Jarvis reads. Note to self: text your own number or email from your iPhone; Jarvis’s replies start with “Jarvis:”, and a note to self doesn’t make your phone buzz. Or sign a second Apple ID in to Messages on this Mac just for Jarvis and text that. In any other conversation, start a message with “Jarvis,” and everyone in it sees the reply. Needs Full Disk Access.',
  };
  const TOKENS = {
    telegram: [['token', 'Bot token', '123456789:AAE…']],
    slack: [['app_token', 'App-level token', 'xapp-…'], ['bot_token', 'Bot token', 'xoxb-…']],
    discord: [['token', 'Bot token', 'Paste the bot token']],
  };
  const WHO = { you: 'you', 'someone else': 'someone else', jarvis: 'Jarvis' };

  let state = { items: [], audit: [] };
  let chats = null; // the iMessage conversations to pick from, once asked for
  let chatsError = '';
  const notes = {}; // channel -> { text, error }
  const opened = new Set(); // the chats shown open
  const drawn = new Map(); // channel -> what its block was drawn from
  const deadlines = new Map(); // channel -> when its pairing code runs out (ms)
  let timer = null;

  function mine(node) {
    node.setAttribute('data-no-i18n', '');
    return node;
  }

  function button(label, onClick, cls = 'btn') {
    const b = el('button', cls, label);
    b.type = 'button';
    b.addEventListener('click', onClick);
    return b;
  }

  function toggle(label, on, onClick) {
    const row = el('div', 'row');
    const words = el('span');
    words.append(el('strong', '', label));
    const sw = el('button', 'switch');
    sw.type = 'button';
    sw.setAttribute('role', 'switch');
    sw.setAttribute('aria-checked', String(!!on));
    sw.setAttribute('aria-label', label);
    sw.addEventListener('click', onClick);
    row.append(words, sw);
    return row;
  }

  function prefs(id, what, value) {
    send({ type: 'feature_prefs', changes: { [`channels_${id}_${what}`]: value } });
  }

  function group() {
    let section = F.$('channels-group');
    if (section) return section;
    const settings = F.$('settings');
    if (!settings) return null;
    section = el('section', 'group channels-group');
    section.id = 'channels-group';
    const log = el('details', 'channels-log');
    log.append(el('summary', '', 'Recent activity'));
    const list = el('ul', 'folders');
    list.id = 'channels-audit';
    log.append(list);
    const holder = el('div', 'channels-list');
    holder.id = 'channels-list';
    section.append(
      el('h3', '', 'Chats'),
      el('p', 'group-note', 'Message Jarvis from your phone. Only you count: each chat is paired with you, and what you send goes through the same checks as asking out loud. Replies come back where you wrote.'),
      holder,
      log,
    );
    // Before the last group (Tools & Accounts…, New conversation), else at the end.
    const last = settings.querySelector('#open-accounts');
    const before = last ? last.closest('section.group') : null;
    if (before) settings.insertBefore(section, before); else settings.append(section);
    return section;
  }

  function statusLine(item) {
    if (item.state === 'error' && item.error) return item.error;
    if (item.on && item.state === 'listening' && item.pairs && !item.owner) return STATUS.needs_pairing;
    if (item.on && (item.state === 'off' || item.state === 'starting')) return item.ready ? STATUS.starting : STATUS.needs_setup;
    if (!item.ready) return STATUS.needs_setup;
    return STATUS[item.state] || STATUS.off;
  }

  function setupForm(item) {
    const box = el('div', 'channel-setup');
    box.append(el('p', 'channel-help', HELP[item.id]));
    const inputs = TOKENS[item.id].map(([key, label, hint]) => {
      const row = el('label', 'row stack');
      const words = el('span');
      words.append(el('strong', '', label));
      const input = el('input');
      input.type = 'password';
      input.autocomplete = 'off';
      input.spellcheck = false;
      input.placeholder = hint;
      input.dataset.key = key;
      input.setAttribute('aria-label', `${item.title} ${label}`);
      row.append(words, input);
      box.append(row);
      return input;
    });
    const actions = el('div', 'folder-form');
    actions.append(button('Save to Keychain', () => {
      const msg = { type: 'channels_connect', channel: item.id };
      for (const input of inputs) {
        const value = input.value.trim();
        if (!value) { note(item.id, 'Paste the token first.', true); return; }
        msg[input.dataset.key] = value;
      }
      send(msg);
      inputs.forEach((input) => { input.value = ''; });
      note(item.id, 'Checking…', false);
    }, 'btn primary'));
    box.append(actions);
    return box;
  }

  function pairing(item) {
    const box = el('div', 'channel-pairing');
    if (item.owner) {
      const row = el('div', 'row');
      const words = el('span');
      const who = el('strong');
      who.append(document.createTextNode('Paired with '), mine(el('span', 'channel-owner', item.owner)));
      words.append(who);
      row.append(words, button('Unpair', () => send({ type: 'channels_unpair', channel: item.id })));
      box.append(row);
    }
    if (item.code) {
      const how = el('p', 'small-status');
      how.append(document.createTextNode('Send this to the bot in a direct message:'));
      if (item.bot) how.append(document.createTextNode(' '), mine(el('strong', '', item.bot)));
      const code = mine(el('p', 'channel-code', `${item.how || '/pair'} ${item.code}`));
      code.dataset.channel = item.id;
      box.append(how, code);
      deadlines.set(item.id, Date.now() + item.seconds * 1000);
      tickCodes();
    } else {
      deadlines.delete(item.id);
      box.append(button(item.owner ? 'Pair another account' : 'Pair', () => send({ type: 'channels_pair', channel: item.id }), item.owner ? 'btn' : 'btn primary'));
    }
    return box;
  }

  function tickCodes() {
    if (timer) return;
    timer = setInterval(() => {
      if (!deadlines.size) { clearInterval(timer); timer = null; return; }
      for (const [id, until] of deadlines) {
        const node = document.querySelector(`.channel-code[data-channel="${id}"]`);
        const left = Math.max(0, Math.round((until - Date.now()) / 1000));
        if (!node) { deadlines.delete(id); continue; }
        const base = node.textContent.split(' · ')[0];
        node.textContent = left ? `${base} · ${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}` : base;
        if (!left) {
          deadlines.delete(id);
          node.replaceWith(el('p', 'small-status', 'The code expired. Press Pair for a new one.'));
        }
      }
    }, 1000);
  }

  function imessage(item) {
    const box = el('div', 'channel-imessage');
    box.append(el('p', 'channel-help', HELP.imessage));
    const chosen = item.chat || null;
    if (chosen) {
      const now = el('p', 'small-status');
      now.append(document.createTextNode('Reading: '), mine(el('strong', '', chosen.name || chosen.id)));
      if (chosen.self) now.append(document.createTextNode(' '), el('span', '', '(note to self)'));
      box.append(now);
    }
    if (chatsError === 'full_disk') {
      box.append(el('p', 'small-status warn-line', 'Jarvis needs Full Disk Access to read Messages.'));
      box.append(button('Open Full Disk Access settings', () => send({ type: 'open_privacy', pane: 'full_disk' })));
    } else if (chatsError) {
      box.append(el('p', 'small-status warn-line', 'Couldn’t read Messages just now. Try again.'));
    }
    if (!chats) {
      box.append(button(chosen ? 'Change conversation' : 'Choose a conversation', () => send({ type: 'channels_chats' }), chosen ? 'btn' : 'btn primary'));
      return box;
    }
    const pick = el('label', 'row stack');
    const words = el('span');
    words.append(el('strong', '', 'Conversation'));
    const select = el('select');
    select.setAttribute('aria-label', 'Conversation');
    select.append(el('option', '', 'Choose…'));
    select.firstChild.value = '';
    for (const c of chats) {
      const option = mine(el('option', '', c.name !== c.id ? `${c.name} (${c.id})` : c.name));
      option.value = c.id;
      option.selected = !!chosen && chosen.id === c.id;
      select.append(option);
    }
    pick.append(words, select);
    box.append(pick);
    const account = el('div', 'segmented channel-account');
    account.setAttribute('role', 'radiogroup');
    account.setAttribute('aria-label', 'Messages on this Mac is signed in as');
    let signedIn = item.account || 'mine';
    const accounts = [['mine', 'My Apple ID'], ['jarvis', 'Jarvis’s own Apple ID']];
    const radios = accounts.map(([value, label]) => {
      const b = el('button', '', label);
      b.type = 'button';
      b.setAttribute('role', 'radio');
      b.setAttribute('aria-checked', String(value === signedIn));
      b.addEventListener('click', () => { signedIn = value; radios.forEach((r, i) => r.setAttribute('aria-checked', String(accounts[i][0] === value))); });
      return b;
    });
    account.append(...radios);
    box.append(el('p', 'small-status', 'Messages on this Mac is signed in as:'), account);
    const handles = el('div', 'channel-handles');
    let prefix = !!item.prefix;
    const prefixRow = toggle('Only messages that start with “Jarvis,”', prefix, (e) => {
      prefix = !prefix;
      e.currentTarget.setAttribute('aria-checked', String(prefix));
    });
    const drawHandles = () => {
      const c = chats.find((x) => x.id === select.value);
      handles.replaceChildren();
      if (!c || !c.group) return;
      handles.append(el('p', 'small-status', 'Which of these are you?'));
      for (const h of c.handles || []) {
        const label = el('label', 'channel-handle');
        const box2 = el('input');
        box2.type = 'checkbox';
        box2.value = h;
        box2.checked = (item.handles || []).includes(h.toLowerCase());
        label.append(box2, mine(el('span', '', h)));
        handles.append(label);
      }
    };
    select.addEventListener('change', drawHandles);
    drawHandles();
    box.append(handles, prefixRow);
    box.append(button('Use this conversation', () => {
      if (!select.value) { note('imessage', 'Pick a conversation first.', true); return; }
      const ticked = [...handles.querySelectorAll('input:checked')].map((i) => i.value);
      send({ type: 'channels_imessage', channel: 'imessage', chat: select.value, account: signedIn, handles: ticked, prefix });
      note('imessage', 'Saving…', false);
    }, 'btn primary'));
    return box;
  }

  function whatsapp(item) {
    const box = el('div', 'channel-imessage');
    box.append(el('p', 'channel-help', HELP.whatsapp));
    if (!item.linked) {
      box.append(el('p', 'small-status warn-line', 'Link WhatsApp in Tools & Accounts first.'));
      box.append(button('Open Tools & Accounts', () => { const open = F.$('open-accounts'); if (open) open.click(); }, 'btn primary'));
    } else if (item.phone) {
      const now = el('p', 'small-status');
      now.append(document.createTextNode('Your number: '), mine(el('strong', '', item.phone)));
      box.append(now);
    }
    return box;
  }

  function signal(item) {
    const box = el('div', 'channel-imessage');
    box.append(el('p', 'channel-help', HELP.signal));
    if (item.account) {
      const now = el('p', 'small-status');
      now.append(document.createTextNode('Using: '), mine(el('strong', '', item.account)));
      box.append(now);
    }
    if (!item.found) box.append(el('p', 'small-status warn-line', 'signal-cli isn’t on this Mac.'));
    else if (item.problem) box.append(el('p', 'small-status warn-line', 'signal-cli couldn’t list its accounts.'));
    else if (item.found && !(item.accounts || []).length) box.append(el('p', 'small-status warn-line', 'No account is linked in signal-cli yet.'));
    const accounts = item.accounts || [];
    if (accounts.length && accounts.some((a) => a !== item.account)) {
      const pick = el('label', 'row stack');
      const words = el('span');
      words.append(el('strong', '', 'Account'));
      const select = el('select');
      select.setAttribute('aria-label', 'Signal account');
      for (const a of accounts) {
        const option = mine(el('option', '', a));
        option.value = a;
        option.selected = a === item.account;
        select.append(option);
      }
      pick.append(words, select);
      box.append(pick, button('Use this account', () => {
        send({ type: 'channels_signal', channel: 'signal', account: select.value });
        note('signal', 'Checking…', false);
      }, 'btn primary'));
    }
    box.append(button('Check again', () => {
      send({ type: 'channels_signal', channel: 'signal' });
      note('signal', 'Checking…', false);
    }));
    return box;
  }

  function groups(item) {
    const box = el('div', 'channel-forward channel-groups');
    box.append(toggle('Answer in group chats', item.groups_on, () => prefs(item.id, 'groups', !item.groups_on)));
    if (!item.groups_on) return box;
    box.append(el('p', 'channel-help', item.id === 'whatsapp'
      ? 'In a group, start a message with “Jarvis,” or reply to one of its messages. A group is added here switched off the first time you ask in it; turn it on to let Jarvis answer there from your account.'
      : 'In a group you’ve added the bot to, mention it or reply to it. It answers only you, everyone there sees the answer, and it never sends, calls or buys anything elsewhere from a group; cards come to your direct chat.'));
    for (const g of item.groups || []) {
      const row = el('div', 'channel-group');
      const head = el('div', 'row');
      const name = el('span');
      name.append(mine(el('strong', '', g.name || g.id)));
      const sw = el('button', 'switch');
      sw.type = 'button';
      sw.setAttribute('role', 'switch');
      sw.setAttribute('aria-checked', String(!!g.on));
      sw.setAttribute('aria-label', 'Answer in this group');
      sw.addEventListener('click', () => send({ type: 'channels_group', channel: item.id, chat: g.id, on: !g.on }));
      head.append(name, sw);
      const seg = el('div', 'segmented channel-tools');
      seg.setAttribute('role', 'radiogroup');
      seg.setAttribute('aria-label', 'What Jarvis may use there');
      for (const [level, label] of [['none', 'No tools'], ['read', 'Read-only'], ['act', 'Can act']]) {
        const b = el('button', '', label);
        b.type = 'button';
        b.setAttribute('role', 'radio');
        b.setAttribute('aria-checked', String(g.tools === level));
        b.addEventListener('click', () => send({ type: 'channels_group', channel: item.id, chat: g.id, tools: level }));
        seg.append(b);
      }
      row.append(head, seg, button('Forget this group', () => send({ type: 'channels_group', channel: item.id, chat: g.id, forget: true })));
      box.append(row);
    }
    if (!(item.groups || []).length) box.append(el('p', 'small-status', 'No groups yet.'));
    return box;
  }

  function forwarding(item) {
    const box = el('div', 'channel-forward');
    box.append(el('p', 'small-status', 'Heads-ups sent here'));
    const seg = el('div', 'segmented');
    seg.setAttribute('role', 'radiogroup');
    seg.setAttribute('aria-label', `Heads-ups sent to ${item.title}`);
    for (const [mode, label] of [['urgent', 'Urgent only'], ['all', 'All'], ['none', 'None']]) {
      const b = el('button', '', label);
      b.type = 'button';
      b.setAttribute('role', 'radio');
      b.setAttribute('aria-checked', String(item.forward === mode));
      b.addEventListener('click', () => prefs(item.id, 'forward', mode));
      seg.append(b);
    }
    box.append(seg);
    box.append(toggle('Ask me here when you need an OK', item.approvals, () => prefs(item.id, 'approvals', !item.approvals)));
    return box;
  }

  function block(item) {
    const details = el('details', 'channel');
    details.dataset.channel = item.id;
    details.open = opened.has(item.id);
    details.addEventListener('toggle', () => { if (details.open) opened.add(item.id); else opened.delete(item.id); });
    const summary = el('summary');
    const status = el('span', `channel-status${item.state === 'error' ? ' warn' : ''}`, statusLine(item));
    summary.append(el('span', 'channel-name', item.title), status);
    const body = el('div', 'channel-body');
    if (item.ready) {
      body.append(toggle(`Use ${item.title}`, item.on, () => prefs(item.id, 'on', !item.on)));
      if (item.bot) {
        const bot = el('p', 'small-status');
        bot.append(document.createTextNode('Connected as '), mine(el('strong', '', item.bot)));
        body.append(bot);
      }
    }
    if (item.id === 'imessage') body.append(imessage(item));
    else if (item.id === 'whatsapp') body.append(whatsapp(item));
    else if (item.id === 'signal') body.append(signal(item));
    else if (!item.ready) body.append(setupForm(item));
    else {
      if (item.state === 'error') body.append(setupForm(item)); // a refused token: paste a new one
      body.append(pairing(item));
    }
    if (item.ready) {
      body.append(forwarding(item));
      if (item.group_chats) body.append(groups(item));
      const stop = { imessage: 'Stop using iMessage', whatsapp: 'Stop using WhatsApp', signal: 'Stop using Signal' }[item.id] || 'Disconnect';
      body.append(button(stop, () => send({ type: 'channels_disconnect', channel: item.id }), 'btn danger'));
    }
    const said = notes[item.id];
    const line = el('p', `small-status channel-note${said && said.error ? ' warn-line' : ''}`, said ? said.text : '');
    line.setAttribute('aria-live', 'polite');
    line.hidden = !said;
    body.append(line);
    details.append(summary, body);
    return details;
  }

  function busy(node) {
    const focus = document.activeElement;
    return !!(focus && node.contains(focus) && focus.matches('input, select'));
  }

  function render() {
    const section = group();
    if (!section) return;
    const list = F.$('channels-list');
    const items = ORDER.map((id) => (state.items || []).find((i) => i.id === id)).filter(Boolean);
    for (const item of items) {
      const sig = JSON.stringify([item, notes[item.id] || null, item.id === 'imessage' ? [chats, chatsError] : null]);
      const old = list.querySelector(`details.channel[data-channel="${item.id}"]`);
      if (old && drawn.get(item.id) === sig) continue;
      if (old && busy(old)) continue; // never redrawn under a field being typed in
      drawn.set(item.id, sig);
      const fresh = block(item);
      if (old) old.replaceWith(fresh); else list.append(fresh);
    }
    const audit = F.$('channels-audit');
    const lines = (state.audit || []).slice().reverse();
    audit.replaceChildren(...(lines.length ? lines.map((e) => {
      const li = el('li');
      const when = new Date(e.at);
      li.append(
        mine(el('span', 'channel-when', Number.isNaN(when.getTime()) ? '' : when.toLocaleString(window.jarvisI18n && window.jarvisI18n.lang() === 'zh' ? 'zh-CN' : undefined, { hour: 'numeric', minute: '2-digit', month: 'short', day: 'numeric' }))),
        el('span', 'channel-what', (state.items.find((i) => i.id === e.channel) || {}).title || e.channel),
        el('span', 'channel-what', WHO[e.who] || e.who),
        el('span', 'channel-what', e.kind),
      );
      return li;
    }) : [el('li', 'muted', 'Nothing yet.')]));
  }

  function note(id, text, error) {
    notes[id] = { text, error: !!error };
    render();
  }

  F.on('channels', (ev) => {
    const before = (state.items || []).find((i) => i.id === 'imessage');
    const after = (ev.items || []).find((i) => i.id === 'imessage');
    const was = before && before.chat ? before.chat.id : '';
    const now = after && after.chat ? after.chat.id : '';
    if (now && now !== was) { chats = null; delete notes.imessage; } // saved: the picker's done
    state = ev;
    render();
  }, { replay: true });
  F.on('channels_note', (ev) => note(ev.channel, ev.text, ev.error));
  F.on('channels_chats', (ev) => { chats = ev.items || []; chatsError = ev.error || ''; opened.add('imessage'); render(); });
  F.on('hello', () => send({ type: 'channels_status' }), { replay: true });
  // Signal is found on this Mac (or not) when its card is first opened, never at start-up.
  document.addEventListener('toggle', (e) => {
    const d = e.target;
    if (!(d instanceof HTMLDetailsElement) || !d.open || d.dataset.channel !== 'signal') return;
    const item = (state.items || []).find((i) => i.id === 'signal');
    if (item && !item.looked) send({ type: 'channels_signal', channel: 'signal' });
  }, true);
})();
