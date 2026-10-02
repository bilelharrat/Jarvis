// The Jarvis account in Settings › iPhone & Watch (jarvis.features.account): what it adds,
// linking this Mac with the iPhone (the code, big, and its QR code), and once linked the
// plan, this month's usage, the account's devices, the relay and Jarvis Plus switches,
// sync and Unlink. The token and the sync key never come to the window.
(() => {
  const F = window.jarvisFeatures;
  if (!F) return;
  const { el, send } = F;
  const $ = (id) => document.getElementById(id);
  const RELAY = 'account_relay';
  const PLUS = 'account_plus_ai';
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

  if (typeof window.__accountTest === 'function') window.__accountTest({ qrPath, linkLine, dollars, planLine, relayLine });

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
  group.dataset.keywords = 'account jarvis plus askeden link relay sync subscription iphone';
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
        el('small', '', 'In the J.A.R.V.I.S. app on your iPhone, open Settings › Account › Link a Mac, then scan this or type the code.'),
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

  function renderLinked() {
    const info = status.info;
    const relay = status.relay || {};
    const plus = status.plus || {};
    const nodes = [planBox(info)];
    nodes.push(row('Reach this Mac from anywhere', el('small', '', relayLine(relay)),
      toggle('Reach this Mac from anywhere', relay.on, (on) => send({ type: 'feature_prefs', changes: { [RELAY]: on } }))));
    const plusNote = plus.in_use && !plus.chosen
      ? 'In use: this Mac has no other way in to Claude.'
      : 'Claude in Jarvis and Jarvis Code runs on your account’s allowance.';
    nodes.push(row('Use Jarvis Plus for AI', plusNote,
      toggle('Use Jarvis Plus for AI', plus.chosen, (on) => send({ type: 'feature_prefs', changes: { [PLUS]: on } }))));
    nodes.push(row('Notifications', status.push_via_account ? 'Through your Jarvis account' : 'With your own push key, or not set up (iPhone & Watch › Notifications)'));
    nodes.push(row('Sync', syncLine(status.sync), button('Sync now', 'btn', () => send({ type: 'account_sync' }))));
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
    if (status && status.error && !status.linked) {
      problem.textContent = status.error;
      problem.hidden = false;
    } else {
      problem.hidden = true;
    }
    if (status && status.linked) renderLinked();
    else renderUnlinked();
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
  F.on('account', (ev) => { status = ev; if (!ev.linked) confirming = false; render(); });

  render();
  // Fresh usage and devices whenever Settings opens.
  const sheet = $('settings');
  if (sheet) {
    new MutationObserver(() => { if (!sheet.hidden) send({ type: 'account' }); })
      .observe(sheet, { attributes: true, attributeFilter: ['hidden'] });
  }
})();
