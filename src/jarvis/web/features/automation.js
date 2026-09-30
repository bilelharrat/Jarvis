// The automation feature's window side: Settings › Routines (each schedule in the language
// the window speaks, and when it runs next), Settings › Timers & reminders (live countdowns,
// Stop, Snooze and Cancel), and Stop and Snooze on the card of a timer or alarm ringing.
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
    text.append(mine(el('strong', '', r.name)), about);
    text.title = r.prompt || '';
    li.append(
      text,
      button('Run now', 'btn', () => send({ type: 'routine_run', id: r.id })),
      button('Delete', 'btn', () => send({ type: 'routine_delete', id: r.id }), `Delete routine: ${r.name}`),
      toggle('', `Routine on: ${r.name}`, r.enabled, () => send({ type: 'routine_toggle', id: r.id, enabled: !r.enabled })),
    );
    return li;
  }

  // Drawn after app.js's own list on every change, in its place.
  function renderRoutines() {
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
    renderTimers();
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
    if (ev.routines) { routines = ev.routines; renderRoutines(); }
    if (ev.timers) { timers = ev.timers; renderTimers(); }
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
