// The automation feature's window side: Settings › Routines (each schedule in the language
// the window speaks, when it runs next, and under "How it runs" whether it runs on its own,
// its model, tools and delivery, its standing orders and its last runs), Settings › Timers
// & reminders (live countdowns, Stop, Snooze and Cancel), Settings › Email rules ("when an
// email from … arrives, …": routines on the mail trigger), and Stop and Snooze on the card
// of a timer or alarm ringing.
//
// Everything a routine or a timer carries (its name, its prompt, its label, when it runs) is
// the owner's or the backend's data: shown with textContent and marked data-no-i18n. The
// helpers at the top are pure (window.jarvisAutomation), so node --test can check them
// without a page.
(() => {
  const A = {
    // A time the window shows: "3:30 PM" today, "Tue 3:30 PM" within the week, else the date.
    when(iso, lang = 'en', now = new Date()) {
      const at = new Date(iso);
      if (!iso || Number.isNaN(at.getTime())) return '';
      const locale = lang === 'zh' ? 'zh-CN' : undefined;
      const days = Math.round((new Date(at).setHours(0, 0, 0, 0) - new Date(now).setHours(0, 0, 0, 0)) / 86400000);
      const style = days === 0 ? { hour: 'numeric', minute: '2-digit' }
        : days > 0 && days < 7 ? { weekday: 'short', hour: 'numeric', minute: '2-digit' }
          : { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' };
      return new Intl.DateTimeFormat(locale, style).format(at);
    },
    // A routine's (or a timer's) schedule in the window's language: the backend says both.
    schedule(r, lang = 'en') {
      return (lang === 'zh' && r.when_zh) || r.when || '';
    },
    // Time left on a countdown: 4:12, 1:05:00.
    left(seconds) {
      const s = Math.max(0, Math.round(seconds));
      const h = Math.floor(s / 3600);
      const m = Math.floor((s % 3600) / 60);
      const rest = String(s % 60).padStart(2, '0');
      return h ? `${h}:${String(m).padStart(2, '0')}:${rest}` : `${m}:${rest}`;
    },
    // Seconds from now until a timer's due time (this Mac's time, as the backend keeps it).
    until(iso, now = Date.now()) {
      const at = new Date(iso).getTime();
      return Number.isNaN(at) ? 0 : Math.max(0, (at - now) / 1000);
    },
    // The timer an alert's key names ("timer:ab12cd:153000" -> "ab12cd"), for its card.
    ringId(key) {
      const parts = String(key || '').split(':');
      return ['timer', 'alarm'].includes(parts[0]) && parts[1] ? parts[1] : '';
    },
    // An email rule is a routine that runs when an email arrives.
    isEmailRule(r) {
      return r.kind === 'event' && ((r.spec || {}).trigger || {}).type === 'mail';
    },
    // How a routine runs, in a few words (the window's words, each translated on its own).
    howItRuns(r) {
      const parts = [];
      if (r.own) {
        parts.push('On its own', ({ haiku: 'Haiku', sonnet: 'Sonnet', opus: 'Opus' })[r.model] || 'Haiku');
        parts.push(({ none: 'no tools', read_only: 'reads only', normal: 'can act' })[r.tools] || 'reads only');
      } else parts.push('In the conversation');
      const where = ({ card: 'card only', forward: 'to your phone', file: 'to a file' })[r.deliver];
      if (where) parts.push(where);
      return parts;
    },
  };
  window.jarvisAutomation = A;

  const F = window.jarvisFeatures;
  if (!F || typeof document === 'undefined') return;
  const { el, send } = F;
  const mine = (node) => { node.setAttribute('data-no-i18n', ''); return node; };

  let lang = 'en';
  let features = {};
  let routines = [];
  let timers = { items: [], ringing: [] };
  let running = {};  // routine id -> when its run began
  let lastRuns = {};  // routine id -> its last run
  const histories = new Map();  // routine id -> its runs, newest first (once asked for)
  const opened = new Set();  // routines whose "How it runs" is open: kept open across redraws

  function button(label, cls, onClick, aria) {
    const b = el('button', cls, label);
    b.type = 'button';
    if (aria) b.setAttribute('aria-label', aria);
    b.addEventListener('click', onClick);
    return b;
  }

  function toggle(id, label, on, onClick) {
    const sw = button('', 'switch', onClick, label);
    if (id) sw.id = id;
    sw.setAttribute('role', 'switch');
    sw.setAttribute('aria-checked', String(!!on));
    return sw;
  }

  function row(title, note, control) {
    const r = el('div', 'row');
    const words = el('span');
    words.append(el('strong', '', title));
    if (note) words.append(el('small', '', note));
    r.append(words, control);
    return r;
  }

  function choice(label, value, options, onChange, disabled) {
    const select = el('select');
    select.setAttribute('aria-label', label);
    for (const [v, text] of options) {
      const option = el('option', '', text);
      option.value = v;
      select.append(option);
    }
    select.value = value;
    select.disabled = !!disabled;
    select.addEventListener('change', () => onChange(select.value));
    const r = el('label', 'row');
    const words = el('span');
    words.append(el('strong', '', label));
    r.append(words, select);
    return r;
  }

  // ── Settings › Routines ──

  function routineRow(r) {
    const li = el('li', 'routine auto-routine');
    li.dataset.id = r.id;
    const text = el('span', 'fact');
    const about = el('small', 'auto-when');
    about.append(mine(el('bdi', '', A.schedule(r, lang))));
    if (!r.enabled) about.append(el('span', 'auto-sep', ' · '), el('span', '', 'paused'));
    else if (r.next_run) {
      const next = mine(el('bdi', 'auto-next', A.when(r.next_run, lang)));
      next.dataset.at = r.next_run;
      about.append(el('span', 'auto-sep', ' · '), el('span', '', 'Next run'), ' ', next);
    }
    if (running[r.id]) about.append(el('span', 'auto-sep', ' · '), el('span', 'auto-running', 'Running…'));
    else if (lastRuns[r.id] && lastRuns[r.id].status !== 'ok') {
      about.append(el('span', 'auto-sep', ' · '), el('span', 'auto-bad', lastRuns[r.id].status === 'failed' ? 'Last run failed' : 'Last run skipped'));
    }
    text.append(mine(el('strong', '', r.name)), about);
    text.title = r.prompt || '';
    li.append(
      text,
      button('Run now', 'btn', () => send({ type: 'routine_run', id: r.id })),
      button('Delete', 'btn', () => send({ type: 'routine_delete', id: r.id }), `Delete routine: ${r.name}`),
      toggle('', `Routine on: ${r.name}`, r.enabled, () => send({ type: 'routine_toggle', id: r.id, enabled: !r.enabled })),
      jobDetails(r),
    );
    return li;
  }

  // "How it runs": on its own or in the conversation, its model, tools and delivery, its
  // standing orders (each can be taken back; new ones only come by voice, on a card), and
  // its last runs.
  function jobDetails(r) {
    const details = el('details', 'auto-more');
    const summary = el('summary');
    const how = el('small', 'auto-how');
    A.howItRuns(r).forEach((part, i) => {
      if (i) how.append(el('span', 'auto-sep', ' · '));
      how.append(el('span', '', part));
    });
    summary.append(el('span', '', 'How it runs'), how);
    details.append(summary);
    const job = (changes) => send({ type: 'automation_job', id: r.id, ...changes });
    const body = el('div', 'auto-job');
    body.append(
      row('On its own', 'A session of its own that never joins our conversation',
        toggle('', `On its own: ${r.name}`, r.own, () => job({ own: !r.own }))),
      choice('Model', r.model || 'haiku', [['haiku', 'Haiku'], ['sonnet', 'Sonnet'], ['opus', 'Opus']], (v) => job({ model: v }), !r.own),
      choice('Tools', r.tools || 'read_only', [['none', 'None: it only writes'], ['read_only', 'Read only'], ['normal', 'Can act, asking first']], (v) => job({ tools: v }), !r.own),
      choice('Result', r.deliver || 'speak', [['speak', 'Say it'], ['card', 'Card only'], ['forward', 'Send to my phone and chats'], ['file', 'Save to a file']], (v) => job({ deliver: v })),
    );
    const words = lang === 'zh' ? (r.may_words_zh || []) : (r.may_words || []);
    if ((r.may || []).length) {
      const may = el('div', 'auto-may');
      may.append(el('strong', '', 'May do without asking'));
      const list = el('ul', 'auto-chips');
      r.may.forEach((grant, i) => {
        const chip = el('li', 'auto-chip');
        chip.append(mine(el('span', '', words[i] || grant)),
          button('×', 'auto-chip-x', () => send({ type: 'automation_unmay', id: r.id, grant }), `Take back: ${words[i] || grant}`));
        list.append(chip);
      });
      may.append(list);
      body.append(may);
    }
    const past = el('div', 'auto-history');
    past.append(el('strong', '', 'Last runs'));
    const runs = el('ol', 'auto-runs');
    runs.dataset.id = r.id;
    past.append(runs);
    body.append(past);
    details.append(body);
    fillHistory(runs, histories.get(r.id));
    details.open = opened.has(r.id);
    details.addEventListener('toggle', () => {
      if (details.open) { opened.add(r.id); send({ type: 'automation_history', id: r.id }); } else opened.delete(r.id);
    });
    return details;
  }

  const STATUS = { ok: 'Done', failed: 'Failed', skipped: 'Skipped' };
  function fillHistory(list, runs) {
    if (!runs) { list.replaceChildren(el('li', 'muted', 'Loading…')); return; }
    if (!runs.length) { list.replaceChildren(el('li', 'muted', 'It hasn’t run yet.')); return; }
    list.replaceChildren(...runs.map((run) => {
      const li = el('li', `auto-run ${run.status}`);
      const head = el('small');
      head.append(mine(el('bdi', '', A.when(run.at, lang))), el('span', 'auto-sep', ' · '),
        mine(el('bdi', '', run.cause)), el('span', 'auto-sep', ' · '), el('span', 'auto-status', STATUS[run.status] || run.status));
      li.append(head);
      const said = [run.output, run.note].filter(Boolean).join(' — ');
      if (said) li.append(mine(el('span', 'auto-said', said)));
      return li;
    }));
  }

  // Drawn after app.js's own list on every change, in its place (email rules too).
  function renderRoutines() {
    renderEmailRules();
    const list = F.$('routine-list');
    if (!list) return;
    if (!routines.length) {
      list.replaceChildren(el('li', 'muted', 'No routines yet.'));
      return;
    }
    list.replaceChildren(...routines.map(routineRow));
  }

  // ── Settings › Timers & reminders ──

  const KIND_NAMES = { timer: 'Timer', alarm: 'Alarm', reminder: 'Reminder' };
  let timersGroup = null;

  function buildGroups() {
    if (timersGroup) return;
    const settings = F.$('settings');
    if (!settings) return;
    const routinesGroup = F.$('routine-list')?.closest('section.group');
    timersGroup = el('section', 'group auto-group');
    timersGroup.id = 'auto-timers';
    const list = el('ul', 'itemlist auto-timer-list');
    list.id = 'auto-timer-list';
    timersGroup.append(
      el('h3', '', 'Timers & reminders'),
      el('p', 'small-status', 'Say “Jarvis, set a timer for 12 minutes”, “wake me at 6:30” or “remind me every 20 minutes to stretch until 6”.'),
      list,
      row('Ring my phone for alarms', 'An alarm you ask to call you also rings your phone (set it up under Phone).',
        toggle('sw-auto-alarm-phone', 'Ring my phone for alarms', features.alarm_phone,
          () => send({ type: 'feature_prefs', changes: { alarm_phone: !features.alarm_phone } }))),
    );
    if (routinesGroup) routinesGroup.after(timersGroup);
    else settings.append(timersGroup);
    buildEmailGroup(timersGroup);
    renderTimers();
    renderEmailRules();
  }

  function timerRow(t) {
    const li = el('li', 'auto-timer');
    li.dataset.id = t.id;
    if (t.ringing) li.classList.add('ringing');
    const fact = el('span', 'fact');
    fact.append(t.label ? mine(el('strong', '', t.label)) : el('strong', '', KIND_NAMES[t.kind] || 'Timer'));
    const about = el('small');
    if (t.ringing) about.append(el('span', 'auto-ringing', 'Ringing'), el('span', 'auto-sep', ' · '));
    else if (t.kind === 'timer') {
      const left = mine(el('bdi', 'auto-left', A.left(A.until(t.due))));
      left.dataset.due = t.due;
      about.append(left, ' ', el('span', '', 'left'), el('span', 'auto-sep', ' · '));
    }
    about.append(mine(el('bdi', '', A.schedule(t, lang))));
    fact.append(about);
    li.append(fact);
    if (t.ringing) {
      li.append(
        button('Snooze', 'btn', () => send({ type: 'automation_timer', action: 'snooze', id: t.id })),
        button('Stop', 'btn primary', () => send({ type: 'automation_timer', action: 'stop', id: t.id })),
      );
    } else {
      li.append(button('Cancel', 'btn', () => send({ type: 'automation_timer', action: 'cancel', id: t.id }), `Cancel: ${t.label || KIND_NAMES[t.kind]}`));
    }
    return li;
  }

  // ── Settings › Email rules ──

  let emailGroup = null;
  const DELIVER_CHOICES = [['speak', 'Say it'], ['card', 'Card only'], ['forward', 'Send to my phone and chats'], ['file', 'Save to a file']];

  function buildEmailGroup(after) {
    emailGroup = el('section', 'group auto-group');
    emailGroup.id = 'auto-email';
    const list = el('ul', 'itemlist auto-email-list');
    list.id = 'auto-email-list';
    const form = el('form', 'folder-form auto-email-form');
    const field = (name, placeholder, max) => {
      const input = el('input');
      input.name = name;
      input.placeholder = placeholder;
      input.maxLength = max;
      input.setAttribute('aria-label', placeholder);
      return input;
    };
    const sender = field('from', 'From: a name or an address', 120);
    const subject = field('subject', 'Subject has (optional)', 120);
    const then = field('then', 'Then: e.g. tell me what they need', 500);
    const deliver = el('select');
    deliver.setAttribute('aria-label', 'Result');
    for (const [v, text] of DELIVER_CHOICES) { const o = el('option', '', text); o.value = v; deliver.append(o); }
    const add = el('button', 'btn', 'Add rule');
    add.type = 'submit';
    form.append(sender, subject, then, deliver, add);
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      if (!sender.value.trim() && !subject.value.trim()) { sender.focus(); return; }
      send({ type: 'automation_email_rule', from: sender.value.trim(), subject: subject.value.trim(), then: then.value.trim(), deliver: deliver.value });
      sender.value = subject.value = then.value = '';
    });
    emailGroup.append(
      el('h3', '', 'Email rules'),
      el('p', 'small-status', 'When an email from someone, or about something, arrives, I read it with no tools at hand (what it says is never obeyed) and tell you, or do what you say with it. Say “Jarvis, when an email from Ann arrives, tell me what she needs”, or add one here. It uses the same watch on Mail as interruptions.'),
      list,
      form,
    );
    after.after(emailGroup);
  }

  function renderEmailRules() {
    const list = F.$('auto-email-list');
    if (!list) return;
    const rules = routines.filter(A.isEmailRule);
    if (!rules.length) { list.replaceChildren(el('li', 'muted', 'No email rules yet.')); return; }
    list.replaceChildren(...rules.map((r) => {
      const li = el('li', 'auto-rule');
      li.dataset.id = r.id;
      const fact = el('span', 'fact');
      fact.append(mine(el('strong', '', A.schedule(r, lang))), mine(el('small', '', r.prompt || '')));
      li.append(
        fact,
        button('Delete', 'btn', () => send({ type: 'routine_delete', id: r.id }), `Delete routine: ${r.name}`),
        toggle('', `Routine on: ${r.name}`, r.enabled, () => send({ type: 'routine_toggle', id: r.id, enabled: !r.enabled })),
      );
      return li;
    }));
  }

  function renderTimers() {
    const list = F.$('auto-timer-list');
    if (!list) return;
    const items = timers.items || [];
    if (!items.length) list.replaceChildren(el('li', 'muted', 'No timers, alarms or reminders.'));
    else list.replaceChildren(...items.map(timerRow));
  }

  function syncSwitches() {
    const sw = F.$('sw-auto-alarm-phone');
    if (sw) sw.setAttribute('aria-checked', String(!!features.alarm_phone));
  }

  // ── a timer or alarm ringing: Stop and Snooze on its card ──

  if (typeof ALERT_KICKERS === 'object') Object.assign(ALERT_KICKERS, { timer: 'Timer', alarm: 'Alarm', reminder: 'Reminder' });

  function onRing(ev) {
    const id = A.ringId(ev.key);
    const card = F.$('cards')?.lastElementChild;
    if (!id || !card || !card.classList.contains('plain') || card.dataset.ring) return;
    card.dataset.ring = id;
    const actions = card.querySelector('.card-actions');
    const act = (label, action, cls) => button(label, cls, () => {
      send({ type: 'automation_timer', action, id });
      card.remove();
    });
    actions.prepend(act('Snooze', 'snooze', 'btn'), act('Stop', 'stop', 'btn primary'));
  }

  // ── events ──

  function onPrefs(p) {
    if (!p) return;
    if (p.features) { features = p.features; syncSwitches(); }
    if (p.language && p.language !== lang) { lang = p.language; renderRoutines(); renderTimers(); }
  }

  // The backend's state when this script loads (it may load after the hello: what app.js
  // drew since then is newer than a replayed hello), after every hello, and as it changes.
  F.on('hello', (ev) => {
    onPrefs(ev.prefs);
    routines = ev.routines || [];
    renderRoutines();
    send({ type: 'automation_state' });
  });
  F.on('automation', (ev) => {
    if (ev.language) lang = ev.language;
    let redraw = false;
    if (ev.running) { running = ev.running; redraw = true; }
    if (ev.last_runs) { lastRuns = ev.last_runs; redraw = true; }
    if (ev.routines) { routines = ev.routines; redraw = true; }
    if (redraw) renderRoutines();
    if (ev.running && !ev.routines) opened.forEach((id) => send({ type: 'automation_history', id }));  // a run just ended
    if (ev.timers) { timers = ev.timers; renderTimers(); }
  });
  F.on('automation_history', (ev) => {
    histories.set(ev.id, ev.runs || []);
    const list = document.querySelector(`#routine-list .auto-runs[data-id="${CSS.escape(String(ev.id))}"]`);
    if (list) fillHistory(list, ev.runs || []);
  });
  F.on('routines', (ev) => { routines = ev.items || []; renderRoutines(); });
  F.on('prefs', onPrefs);
  F.on('alert', onRing);
  buildGroups();
  send({ type: 'automation_state' });
  // Countdowns tick each second while Settings is open; "Tue 3:30 PM" becomes "3:30 PM" at
  // midnight. Both are rewritten in place, so nothing open or focused in a list moves.
  setInterval(() => {
    if (F.$('settings')?.hidden) return;
    document.querySelectorAll('#auto-timer-list .auto-left').forEach((node) => {
      node.textContent = A.left(A.until(node.dataset.due));
    });
  }, 1000);
  setInterval(() => {
    document.querySelectorAll('#routine-list .auto-next').forEach((node) => {
      node.textContent = A.when(node.dataset.at, lang);
    });
  }, 60000);
})();
