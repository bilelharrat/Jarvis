// The Jarvis account in Settings › iPhone & Watch (jarvis.features.account): what it adds,
// linking this Mac with the iPhone (the code, big, and its QR code), and once linked the
// plan, this month's usage, the account's devices, the relay, Eden on the web (whether
// askeden.com reaches this Mac, and how its line is) and Jarvis Plus switches, sync,
// approving a browser's sign-in to Eden at askeden.com (its code, typed here),
// trusting a browser for Eden sync (this Mac holds Eden's key once a browser that syncs, or
// the recovery passphrase, gave it; then it approves browsers whose six digits match), and
// Unlink. The token, the sync key and Eden's key never come to the window.
(() => {
  const F = window.jarvisFeatures;
  if (!F) return;
  const { el, send } = F;
  const $ = (id) => document.getElementById(id);
  const RELAY = 'account_relay';
  const PLUS = 'account_plus_ai';
  const EDEN_LINK = 'account_eden_link';
  const PERKS = [
    ['AI included', 'Jarvis Plus answers without a Claude sign-in or an API key of your own.'],
    ['Notifications without a push key', 'Approvals and heads-ups reach your iPhone through the account’s Apple push key.'],
    ['Your Mac from anywhere', 'Your iPhone reaches this Mac away from home, with no shared Wi-Fi. What goes between them stays encrypted end to end.'],
    ['Sync', 'Memory and settings stay the same on your iPhone and this Mac, sealed so only your devices can read them.'],
  ];
  const KINDS = { iphone: 'iPhone', ipad: 'iPad', watch: 'Apple Watch', mac: 'Mac' };

  let status = null;  // the latest account event
  let tick = null;
  let confirming = false;
  let approvalError = '';  // why the code typed for a browser's sign-in didn't go
  let esync = null;  // Eden sync's key on this Mac: the latest account_esync event
  let esyncStopping = false;

  // ── pure helpers (tests/web/account.test.mjs runs these) ──

  // The QR code's dark modules as one SVG path, with the four-module quiet zone around it
  // (as the companion's pairing code is drawn).
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

  // How a link in progress is going, in words.
  function linkLine(link) {
    if (!link) return '';
    if (link.state === 'waiting') return 'Waiting for your iPhone…';
    if (link.state === 'linked') return 'Linked.';
    if (link.state === 'expired') return 'That code expired. Get a new one.';
    if (link.state === 'denied') return 'Your iPhone said no. Get a new code to try again.';
    return link.error || 'Linking didn’t work. Get a new code to try again.';
  }

  // A link code as it's shown (XXXX-XXXX), from what was typed: any case, with or without
  // the dash or spaces; null when it isn't one (Crockford base32: no I, L, O or U).
  function codeOf(text) {
    const clean = String(text || '').trim().replace(/^jarvis-link:\/\//i, '').replace(/[\s-]/g, '').toUpperCase();
    if (!/^[0-9A-HJKMNP-TV-Z]{8}$/.test(clean)) return null;
    return `${clean.slice(0, 4)}-${clean.slice(4)}`;
  }

  // How a browser's sign-in, approved here, went.
  function approvalLine(approval) {
    if (!approval) return '';
    if (approval.state === 'approved') return 'Approved. The browser is signed in to Eden.';
    if (approval.state === 'denied') return 'Turned down. The browser isn’t signed in.';
    if (approval.state === 'error') return approval.error || 'That didn’t work. Get a new code in the browser.';
    return '';
  }

  // Where Eden sync stands on this Mac, in words (the box's first line).
  function esyncLine(e) {
    if (!e || e.state === 'unknown') return e && e.error ? e.error : 'Checking with askeden.com…';
    if (e.state === 'off') return 'Eden sync isn’t on for your account yet. Turn it on in Eden at askeden.com (Account › Sync); then this Mac can let your other browsers in.';
    if (e.state === 'locked') return 'To approve browsers, this Mac needs Eden’s key once: ask a browser that already syncs, or use your recovery passphrase.';
    if (e.state === 'asking') return 'In Eden on a browser that already syncs, open Account › Sync and approve this Mac if it shows the same code:';
    const n = (e.requests || []).length;
    if (!n) return 'No browser is waiting. On the new browser, open Account › Sync in Eden and choose “Ask a device that syncs”.';
    return n === 1 ? 'A device is waiting. Approve it only if it shows the same code.' : `${n} devices are waiting. Approve each only if it shows the same code.`;
  }

  // Dollars as the account counts them.
  function dollars(value) {
    const n = Number(value);
    return Number.isFinite(n) ? `$${n.toFixed(2)}` : '';
  }

  // The plan, in a few words.
  function planLine(plan) {
    if (!plan || plan.name !== 'plus' || !plan.active) return 'Free plan';
    return 'Jarvis Plus';
  }

  // The relay's state, in words.
  function relayLine(relay) {
    if (!relay || !relay.on) return 'Off';
    if (relay.state === 'listening') return 'Reachable from anywhere';
    if (relay.state === 'connecting' || relay.state === 'waiting') return 'Connecting…';
    return 'Waits for the phone companion to be on';
  }

  // Eden on the web's line to this Mac (jarvis.eden_link), in words: [text, needs attention].
  function edenLinkLine(link) {
    if (!link || !link.on) return ['Off: Eden at askeden.com can’t reach Jarvis, Code mode or privacy mode on this Mac.', false];
    if (link.state === 'open') return ['Connected: Eden at askeden.com reaches Jarvis, Code mode and privacy mode here.', false];
    if (link.state === 'waiting') return [`Offline${link.error ? `: ${link.error.replace(/\.$/, '')}` : ''}. Trying again…`, true];
    return ['Connecting to askeden.com…', false];
  }

  if (typeof window.__accountTest === 'function') window.__accountTest({ qrPath, linkLine, codeOf, approvalLine, esyncLine, dollars, planLine, relayLine, edenLinkLine });

  // ── where it goes: before iPhone & Watch ──

  const phones = $('sw-remote') && $('sw-remote').closest('section.group');
  if (!phones || $('account-group')) return;

  const locale = () => (typeof uiLocale === 'function' ? uiLocale() : undefined);
  function when(ms) {
    const at = new Date(Number(ms));
    return Number.isNaN(at.getTime()) ? '' : at.toLocaleDateString(locale(), { dateStyle: 'medium' });
  }
  function data(tag, cls, text) {
    const node = el(tag, cls, text);
    node.dataset.noI18n = '';
    return node;
  }
  function button(label, cls, run) {
    const b = el('button', cls, label);
    b.type = 'button';
    b.addEventListener('click', run);
    return b;
  }
  function toggle(label, on, change) {
    const b = el('button', 'switch');
    b.type = 'button';
    b.setAttribute('role', 'switch');
    b.setAttribute('aria-label', label);
    b.setAttribute('aria-checked', String(!!on));
    b.addEventListener('click', () => change(!on));
    return b;
  }

  const group = el('section', 'group account-group');
  group.id = 'account-group';
  group.dataset.settingsPane = 'devices';
  group.dataset.keywords = 'account jarvis plus askeden link relay sync subscription iphone eden web privacy';
  const heading = el('h3', '', 'Jarvis account');
  const intro = el('p', 'small-status', 'An optional account at askeden.com, for what your devices can’t do alone. Everything works without it, as before.');
  const problem = el('p', 'warn-line small-status');
  problem.hidden = true;
  // The rows are the group's own children, as Settings' other groups have them (its
  // dividers and spacing are drawn between a group's children).
  const show = (...nodes) => group.replaceChildren(heading, intro, ...nodes, problem);
  show();
  phones.before(group);

  // ── not linked ──

  function perks() {
    const list = el('ul', 'account-perks');
    for (const [title, note] of PERKS) {
      const li = el('li');
      li.append(el('strong', '', title), el('small', '', note));
      list.append(li);
    }
    return list;
  }

  function linkBox(link) {
    const box = el('div', 'account-link');
    if (link.qr && link.qr.length && link.state === 'waiting') {
      const size = link.qr.length + 8;
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.setAttribute('role', 'img');
      svg.setAttribute('aria-label', 'Link QR code');
      svg.setAttribute('shape-rendering', 'crispEdges');
      svg.setAttribute('viewBox', `0 0 ${size} ${size}`);
      const bg = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
      bg.setAttribute('width', String(size));
      bg.setAttribute('height', String(size));
      bg.setAttribute('fill', '#fff');
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('d', qrPath(link.qr));
      path.setAttribute('fill', '#000');
      svg.append(bg, path);
      box.append(svg);
    }
    const text = el('div', 'account-link-text');
    if (link.state === 'waiting') {
      text.append(
        data('code', 'account-code', link.code),
        el('small', '', 'In the J.A.R.V.I.S. app on your iPhone, open Settings › Account, then scan this or type the code.'),
      );
      const left = el('small', 'account-left');
      left.id = 'account-left';
      text.append(left);
    }
    const line = el('p', link.state === 'waiting' ? 'small-status' : 'small-status need', linkLine(link));
    text.append(line);
    const actions = el('div', 'row-actions');
    if (link.state === 'waiting') actions.append(button('Cancel', 'btn', () => send({ type: 'account_link_cancel' })));
    else actions.append(button('Get a new code', 'btn primary', () => send({ type: 'account_link' })));
    text.append(actions);
    box.append(text);
    return box;
  }

  function renderUnlinked() {
    const link = status && status.link;
    // While a code is up, it's what matters: what the account adds was read already.
    if (link && link.state !== 'linked') show(linkBox(link));
    else show(perks(), button('Link with your iPhone', 'btn primary account-start', () => send({ type: 'account_link' })));
  }

  // ── linked ──

  function row(title, note, control) {
    const r = el('div', 'row');
    const t = el('span');
    t.append(el('strong', '', title));
    if (note) t.append(note instanceof Node ? note : el('small', '', note));
    r.append(t);
    if (control) r.append(control);
    return r;
  }

  function planBox(info) {
    const plan = (info && info.plan) || {};
    const usage = (info && info.usage) || {};
    const box = el('div', 'account-plan');
    const name = el('strong', 'account-plan-name', planLine(plan));
    const lines = el('div', 'account-plan-lines');
    if (plan.name === 'plus' && plan.active && plan.expires) {
      const until = el('small');
      until.append(el('span', '', plan.renews ? 'Renews ' : 'Ends '), data('span', '', when(plan.expires)));
      lines.append(until);
    }
    if (usage.budget_usd !== undefined && plan.name === 'plus' && plan.active) {
      const month = el('small');
      month.append(el('span', '', 'This month '), data('span', 'account-mono', `${dollars(usage.spent_usd)} / ${dollars(usage.budget_usd)}`));
      lines.append(month);
    }
    if (Number(usage.trial_left_usd) > 0) {
      const trial = el('small');
      trial.append(el('span', '', 'Trial left '), data('span', 'account-mono', dollars(usage.trial_left_usd)));
      lines.append(trial);
    }
    if (!(plan.name === 'plus' && plan.active)) lines.append(el('small', '', 'Subscribe to Jarvis Plus in the J.A.R.V.I.S. app on your iPhone.'));
    box.append(name, lines);
    return box;
  }

  function devicesList(info) {
    const devices = (info && info.devices) || [];
    const list = el('ul', 'itemlist account-devices');
    if (!devices.length) {
      list.append(el('li', 'muted', 'Devices show here once askeden.com answers.'));
      return list;
    }
    for (const d of devices) {
      const li = el('li');
      const fact = el('span', 'fact');
      fact.append(data('strong', '', d.name || KINDS[d.kind] || d.kind || ''));
      const small = el('small');
      small.append(el('span', '', KINDS[d.kind] || 'Device'));
      if (d.this) small.append(el('span', '', ' · '), el('span', '', 'This Mac'));
      else if (d.last_seen) small.append(el('span', '', ' · '), el('span', '', 'Last seen '), data('span', '', when(d.last_seen)));
      fact.append(small);
      li.append(fact);
      list.append(li);
    }
    return list;
  }

  function syncLine(sync) {
    const s = sync || {};
    if (s.error) return el('small', s.state === 'ok' ? '' : 'need', s.error);
    if (s.state === 'ok') {
      const line = el('small');
      line.append(el('span', '', 'Up to date'));
      return line;
    }
    return el('small', '', 'Not synced yet');
  }

  // ── approving a browser's sign-in to Eden ──

  // One field for the code, kept across renders (an account event mid-typing keeps it).
  const codeField = el('input', 'account-approve-code');
  codeField.type = 'text';
  codeField.id = 'account-approve-code';
  codeField.placeholder = 'K7QM-4ZTR';
  codeField.maxLength = 24;
  codeField.autocomplete = 'off';
  codeField.spellcheck = false;
  codeField.setAttribute('autocapitalize', 'characters');
  codeField.setAttribute('aria-label', 'Sign-in code');
  codeField.addEventListener('input', () => {
    if (!approvalError) return;
    approvalError = '';
    render();
  });

  function approveBox() {
    const box = el('div', 'account-approve');
    box.append(el('strong', '', 'Approve a sign-in to Eden'));
    const asked = status.approval;
    const actions = el('div', 'row-actions');
    if (asked && asked.state === 'asking') {
      const who = el('div', 'account-approve-who');
      who.append(el('small', '', 'Asking to sign in to your account at askeden.com:'), data('strong', '', asked.name), data('small', 'account-mono', asked.code));
      box.append(who, el('small', '', 'It can use Eden and the AI included with your plan for 30 days, until you sign it out. Only approve a sign-in you just started yourself.'));
      actions.append(
        button('Approve sign-in', 'btn primary', () => send({ type: 'account_web_approve', code: asked.code })),
        button('Deny', 'btn', () => send({ type: 'account_web_deny', code: asked.code })),
      );
      box.append(actions);
      return box;
    }
    if (asked) {
      box.append(el('small', asked.state === 'error' ? 'need' : '', approvalLine(asked)));
      actions.append(button('Done', 'btn', () => { codeField.value = ''; send({ type: 'account_web_clear' }); }));
      box.append(actions);
      return box;
    }
    box.append(el('small', '', 'Signing in to Eden at askeden.com shows a code like K7QM-4ZTR. Type it here to let that browser in.'));
    const form = el('form', 'account-approve-form');
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      const code = codeOf(codeField.value);
      if (!code) {
        approvalError = 'That isn’t a sign-in code. It has eight letters and numbers, like K7QM-4ZTR.';
        render();
        return;
      }
      approvalError = '';
      codeField.value = code;
      send({ type: 'account_web_peek', code });
    });
    const go = el('button', 'btn', 'Continue');
    go.type = 'submit';
    form.append(codeField, go);
    box.append(form);
    if (approvalError) box.append(el('small', 'need', approvalError));
    return box;
  }

  // ── trusting a browser for Eden sync ──

  // Its own node, kept across renders and redrawn alone (askeden.com is asked every few
  // seconds while it's shown), so an open details or a half-typed passphrase stays.
  const esyncNode = el('div', 'account-approve account-esync');
  const phraseField = el('input', 'account-esync-phrase');
  phraseField.type = 'password';
  phraseField.autocomplete = 'off';
  phraseField.spellcheck = false;
  phraseField.placeholder = 'Recovery passphrase';
  phraseField.setAttribute('aria-label', 'Recovery passphrase');
  const KIND = { web: 'Browser', iphone: 'iPhone', ipad: 'iPad', mac: 'Mac' };

  function drawEsync() {
    const e = esync;
    const typing = document.activeElement === phraseField;
    const nodes = [el('strong', '', 'Trust a browser for Eden sync'), el('small', '', esyncLine(e))];
    const actions = el('div', 'row-actions');
    if (e && e.state === 'asking' && e.asking) {
      nodes.push(data('code', 'account-code', e.asking.code));
      actions.append(button('Cancel', 'btn', () => send({ type: 'account_esync_cancel' })));
      nodes.push(actions);
    } else if (e && e.state === 'locked') {
      actions.append(button('Ask a browser that syncs', 'btn primary', () => send({ type: 'account_esync_ask' })));
      nodes.push(actions);
      if (e.asking && e.asking.state !== 'waiting' && e.asking.state !== 'joined') {
        const why = { denied: 'The browser said no.', expired: 'That request ran out. Ask again.' }[e.asking.state] || e.asking.error;
        if (why) nodes.push(el('small', 'need', why));
      }
      if (e.wrap) {
        const form = el('form', 'account-approve-form account-esync-form');
        const go = el('button', 'btn', 'Unlock');
        go.type = 'submit';
        form.addEventListener('submit', (event) => {
          event.preventDefault();
          if (!phraseField.value) return;
          const passphrase = phraseField.value;
          phraseField.value = '';
          go.disabled = true;
          go.textContent = 'Unlocking…';
          send({ type: 'account_esync_unlock', passphrase });
        });
        form.append(phraseField, go);
        nodes.push(form);
      }
    } else if (e && e.state === 'on') {
      if ((e.requests || []).length) {
        const list = el('ul', 'account-esync-list');
        for (const r of e.requests) {
          const li = el('li');
          const who = el('div', 'account-approve-who');
          who.append(data('strong', '', r.name), el('small', '', `${KIND[r.kind] || 'Device'} · approve only if it shows`));
          const row = el('div', 'account-esync-row');
          row.append(data('code', 'account-code', r.code));
          const act = el('div', 'row-actions');
          act.append(
            button('Approve', 'btn primary', () => send({ type: 'account_esync_approve', device_id: r.device_id, public_key: r.public_key })),
            button('Deny', 'btn', () => send({ type: 'account_esync_deny', device_id: r.device_id })),
          );
          row.append(act);
          li.append(who, row);
          list.append(li);
        }
        nodes.push(list);
      }
      const others = (e.trusted || []).filter((t) => !t.this).length;
      const foot = el('small', '', `This Mac has Eden’s key${others ? `, with ${others} other ${others === 1 ? 'device' : 'devices'}` : ''}. It never reads your chats; it only hands the key on.`);
      nodes.push(foot);
      if (esyncStopping) {
        const ask = el('div', 'row-actions');
        ask.append(
          button('Stop holding the key', 'btn', () => { esyncStopping = false; send({ type: 'account_esync_forget' }); }),
          button('Cancel', 'btn', () => { esyncStopping = false; drawEsync(); }),
        );
        nodes.push(el('small', '', 'Browsers that sync keep syncing; this Mac just can’t approve new ones until it gets the key again.'), ask);
      } else {
        nodes.push(button('Stop here…', 'btn account-esync-stop', () => { esyncStopping = true; drawEsync(); }));
      }
    }
    if (e && e.problem) nodes.push(el('small', 'need', e.problem));
    else if (e && e.done) nodes.push(el('small', 'account-esync-done', e.done));
    esyncNode.replaceChildren(...nodes);
    if (typing && phraseField.isConnected) phraseField.focus();
  }

  function renderLinked() {
    const info = status.info;
    const relay = status.relay || {};
    const plus = status.plus || {};
    const nodes = [planBox(info)];
    nodes.push(row('Reach this Mac from anywhere', el('small', '', relayLine(relay)),
      toggle('Reach this Mac from anywhere', relay.on, (on) => send({ type: 'feature_prefs', changes: { [RELAY]: on } }))));
    const eden = status.eden_link || {};
    const [edenWords, edenNeed] = edenLinkLine(eden);
    nodes.push(row('Eden on the web reaches this Mac', el('small', edenNeed ? 'need' : '', edenWords),
      toggle('Eden on the web reaches this Mac', eden.on, (on) => send({ type: 'feature_prefs', changes: { [EDEN_LINK]: on } }))));
    const plusNote = plus.in_use && !plus.chosen
      ? 'In use: this Mac has no other way in to Claude.'
      : 'Claude in Jarvis and Jarvis Code runs on your account’s allowance.';
    nodes.push(row('Use Jarvis Plus for AI', plusNote,
      toggle('Use Jarvis Plus for AI', plus.chosen, (on) => send({ type: 'feature_prefs', changes: { [PLUS]: on } }))));
    nodes.push(row('Notifications', status.push_via_account ? 'Through your Jarvis account' : 'With your own push key, or not set up (iPhone & Watch › Notifications)'));
    nodes.push(row('Sync', syncLine(status.sync), button('Sync now', 'btn', () => send({ type: 'account_sync' }))));
    nodes.push(approveBox());
    drawEsync();
    nodes.push(esyncNode);
    const devices = el('details', 'watch-help account-devices-box');
    devices.append(el('summary', '', 'Devices on this account'), devicesList(info));
    nodes.push(devices);
    if (confirming) {
      const ask = el('div', 'account-confirm');
      ask.append(
        el('p', 'small-status', 'This Mac leaves the account: no included AI, relay, account notifications or sync until you link it again. Your iPhone keeps everything.'),
      );
      const actions = el('div', 'row-actions');
      actions.append(
        button('Unlink this Mac', 'btn', () => { confirming = false; send({ type: 'account_unlink' }); }),
        button('Cancel', 'btn', () => { confirming = false; render(); }),
      );
      ask.append(actions);
      nodes.push(ask);
    } else {
      nodes.push(button('Unlink…', 'btn account-unlink', () => { confirming = true; render(); }));
    }
    show(...nodes);
  }

  function render() {
    clearInterval(tick);
    tick = null;
    const typing = document.activeElement === codeField;
    if (status && status.error && !status.linked) {
      problem.textContent = status.error;
      problem.hidden = false;
    } else {
      problem.hidden = true;
    }
    if (status && status.linked) renderLinked();
    else renderUnlinked();
    if (typing && codeField.isConnected) codeField.focus();
    const link = status && status.link;
    if (link && link.state === 'waiting' && !(status && status.linked)) {
      let left = Number(link.seconds) || 0;
      const show = () => {
        const node = $('account-left');
        if (!node) return;
        const m = Math.floor(left / 60);
        const s = String(left % 60).padStart(2, '0');
        node.replaceChildren(el('span', '', 'Good for '), data('span', 'account-mono', `${m}:${s}`));
      };
      show();
      tick = setInterval(() => { left = Math.max(0, left - 1); show(); if (!left) clearInterval(tick); }, 1000);
    }
  }

  // ── events ──

  F.on('hello', () => send({ type: 'account' }), { replay: true });
  F.on('account_esync', (ev) => {
    esync = ev;
    if (esyncNode.isConnected) drawEsync();
  });
  F.on('account', (ev) => {
    if (ev.linked && !esync) send({ type: 'account_esync' });
    if (!ev.linked) esync = null;
    status = ev;
    if (!ev.linked) confirming = false;
    if (ev.approval_error) approvalError = ev.approval_error;
    render();
  });

  render();
  // Fresh usage and devices whenever Settings opens.
  const sheet = $('settings');
  // Browsers waiting to sync show up while Settings is open (askeden.com asked every 6 s).
  setInterval(() => {
    if (sheet && !sheet.hidden && esyncNode.isConnected && esync && esync.state === 'on') send({ type: 'account_esync' });
  }, 6000);
  if (sheet) {
    new MutationObserver(() => {
      if (sheet.hidden) return;
      send({ type: 'account' });
      if (status && status.linked) send({ type: 'account_esync' });
    })
      .observe(sheet, { attributes: true, attributeFilter: ['hidden'] });
  }
})();
