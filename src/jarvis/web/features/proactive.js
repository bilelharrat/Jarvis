// The proactive feature's window side (jarvis.features.proactive): Settings › Speaking up
// gains the weekend's own quiet hours, following a Focus mode (with why it can't, when it
// can't) and a snooze with its Resume; Settings › Morning briefing gains its sections (each
// on or off, in the owner's order), news topics and the evening wrap-up.
//
// Everything the backend or the owner wrote (a Focus mode's name, a time) is shown with
// textContent and marked data-no-i18n; the window's own words are translated by i18n.js as
// they appear. The helpers at the top are pure (window.jarvisProactive), so node --test can
// check them without a page.
(() => {
  const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
  // The briefing's sections: what each is called in Settings, and what it covers.
  const SECTIONS = {
    calendar: ['Calendar', 'Today’s events'],
    weather: ['Weather', 'Now and today, warnings, the air'],
    commute: ['Commute', 'How long to your first event somewhere'],
    mail: ['Email', 'Unread email'],
    reminders: ['Reminders', 'Due today and overdue'],
    code: ['Jarvis Code', 'What sessions did while you were away'],
    tasks: ['Background tasks', 'Research that finished'],
    markets: ['Markets', 'Your watchlist'],
    bsh: ['BSH alerts', 'Portfolio alerts from the research desk'],
    health: ['Health', 'Sleep and steps from your iPhone'],
    news: ['News', 'Headlines on your topics'],
  };
  const P = {
    SECTIONS,
    // Two time boxes as a range ("" unless both are times).
    range(start, end) {
      return HHMM.test(start) && HHMM.test(end) ? `${start}-${end}` : '';
    },
    // A clock time the window shows: "3:40 PM", 下午3:40.
    clock(epochSeconds, lang = 'en') {
      const at = new Date(Number(epochSeconds) * 1000);
      if (!epochSeconds || Number.isNaN(at.getTime())) return '';
      return new Intl.DateTimeFormat(lang === 'zh' ? 'zh-CN' : undefined, { hour: 'numeric', minute: '2-digit' }).format(at);
    },
    // Heads-ups paused until when (0 when they aren't), from the shell's setting.
    pausedUntil(features, now = Date.now()) {
      const until = Number((features || {}).shell_pause_until) || 0;
      return until * 1000 > now ? until : 0;
    },
    // What Settings says about Focus: [words, a mode's name or ''].
    focusLine(quiet) {
      const q = quiet || {};
      if (!q.follow) return ['', ''];
      const focus = q.focus || {};
      if (focus.state === 'on') return ['A Focus is on now: I’m keeping to cards.', focus.name || ''];
      if (focus.state === 'no_access') return ['I can’t see your Focus: allow Full Disk Access for J.A.R.V.I.S. in System Settings › Privacy & Security.', ''];
      if (focus.state === 'unavailable') return ['This Mac doesn’t show me its Focus.', ''];
      if (focus.state === 'off') return ['No Focus is on.', ''];
      return ['', ''];
    },
    // The briefing's sections to show: the settings' own (the backend cleans them), else
    // what the backend last said (their defaults), known ones only.
    sections(features, fallback) {
      const listed = Array.isArray((features || {}).briefing_sections) ? features.briefing_sections : fallback;
      return (Array.isArray(listed) ? listed : []).filter((s) => s && SECTIONS[s.id]).map((s) => ({ id: s.id, on: s.on !== false }));
    },
    // A section moved up (-1) or down (+1), the rest in place.
    move(sections, id, delta) {
      const out = sections.map((s) => ({ ...s }));
      const at = out.findIndex((s) => s.id === id);
      const to = at + delta;
      if (at < 0 || to < 0 || to >= out.length) return out;
      [out[at], out[to]] = [out[to], out[at]];
      return out;
    },
    // A section switched on or off.
    toggled(sections, id) {
      return sections.map((s) => (s.id === id ? { ...s, on: !s.on } : { ...s }));
    },
  };
  window.jarvisProactive = P;

  const F = window.jarvisFeatures;
  if (!F || typeof document === 'undefined') return;
  const { el, send } = F;
  const mine = (node) => { node.setAttribute('data-no-i18n', ''); return node; };

  let lang = 'en';
  let features = {};
  let quiet = null;
  let briefing = null;  // the backend's word on the briefing (its sections' defaults)

  function button(label, cls, onClick, aria) {
    const b = el('button', cls, label);
    b.type = 'button';
    if (aria) b.setAttribute('aria-label', aria);
    b.addEventListener('click', onClick);
    return b;
  }

  function toggle(id, label, onClick) {
    const sw = button('', 'switch', onClick, label);
    sw.id = id;
    sw.setAttribute('role', 'switch');
    sw.setAttribute('aria-checked', 'false');
    return sw;
  }

  function row(title, note, ...controls) {
    const r = el('div', 'row');
    const words = el('span');
    words.append(el('strong', '', title));
    if (note) words.append(el('small', '', note));
    r.append(words, ...controls);
    return r;
  }

  function timeBox(id, label) {
    const box = el('input');
    box.type = 'time';
    box.id = id;
    box.setAttribute('aria-label', label);
    return box;
  }

  const setFeatures = (changes) => send({ type: 'feature_prefs', changes });

  // ── Settings › Speaking up: quiet hours ──

  function buildQuiet() {
    const after = F.$('quiet-start')?.closest('.row');
    if (!after || F.$('sw-quiet-weekend')) return;
    const weekend = toggle('sw-quiet-weekend', 'Own quiet hours at weekends', () => {
      setFeatures({ quiet_weekend: features.quiet_weekend ? '' : '23:30-09:00' });
    });
    const start = timeBox('quiet-weekend-start', 'Weekend quiet hours start');
    const end = timeBox('quiet-weekend-end', 'Weekend quiet hours end');
    const hours = el('span', 'time-range');
    hours.append(start, end);
    const weekendHours = row('At weekends', 'Friday and Saturday nights, and the mornings after', hours);
    weekendHours.id = 'quiet-weekend-row';
    for (const box of [start, end]) {
      box.addEventListener('change', () => {
        const spec = P.range(start.value, end.value);
        if (spec) setFeatures({ quiet_weekend: spec });
      });
    }
    const focus = toggle('sw-quiet-focus', 'Follow Focus', () => setFeatures({ quiet_focus: !features.quiet_focus }));
    const focusStatus = el('p', 'small-status');
    focusStatus.id = 'quiet-focus-status';
    const snooze = button('Snooze for an hour', 'btn', () => {
      send({ type: 'proactive_snooze', minutes: P.pausedUntil(features) ? 0 : 60 });
    });
    snooze.id = 'quiet-snooze';
    const snoozeStatus = el('small');
    snoozeStatus.id = 'quiet-snooze-status';
    const snoozeWords = el('span');
    snoozeWords.append(el('strong', '', 'Snooze heads-ups'), snoozeStatus);
    const snoozeRow = el('div', 'row');
    snoozeRow.append(snoozeWords, snooze);
    after.after(
      row('Own hours at weekends', 'Keep different quiet hours on weekend nights', weekend),
      weekendHours,
      row('Follow Focus', 'While a Focus mode is on (Do Not Disturb, Sleep, Work…), heads-ups stay cards.', focus),
      focusStatus,
      snoozeRow,
    );
    renderQuiet();
  }

  function renderQuiet() {
    const weekend = String(features.quiet_weekend || '');
    F.$('sw-quiet-weekend')?.setAttribute('aria-checked', String(Boolean(weekend)));
    const hoursRow = F.$('quiet-weekend-row');
    if (hoursRow) hoursRow.hidden = !weekend;
    const [ws, we] = (weekend || '23:30-09:00').split('-');
    const start = F.$('quiet-weekend-start');
    const end = F.$('quiet-weekend-end');
    if (start && document.activeElement !== start) start.value = ws;
    if (end && document.activeElement !== end) end.value = we;
    F.$('sw-quiet-focus')?.setAttribute('aria-checked', String(features.quiet_focus !== false));
    const status = F.$('quiet-focus-status');
    if (status) {
      const [words, name] = P.focusLine(quiet && { ...quiet, follow: features.quiet_focus !== false });
      status.replaceChildren();
      if (words) status.append(el('span', '', words));
      if (name) status.append(' ', mine(el('bdi', '', name)));
      status.hidden = !words;
    }
    const until = P.pausedUntil(features);
    const snooze = F.$('quiet-snooze');
    if (snooze) {
      snooze.textContent = until ? 'Resume heads-ups' : 'Snooze for an hour';
      snooze.hidden = quiet ? quiet.snooze === false : false;
    }
    const snoozeStatus = F.$('quiet-snooze-status');
    if (snoozeStatus) {
      snoozeStatus.replaceChildren();
      if (until) snoozeStatus.append(el('span', '', 'Paused until'), ' ', mine(el('bdi', '', P.clock(until, lang))));
      else snoozeStatus.append(el('span', '', 'Or say “snooze everything for an hour”.'));
    }
  }

  // ── Settings › Morning briefing: sections, topics, the evening wrap-up ──

  function buildBriefing() {
    const group = F.$('sw-briefing')?.closest('section.group');
    if (!group || F.$('brief-sections')) return;
    const list = el('ul', 'itemlist brief-sections');
    list.id = 'brief-sections';
    const topics = el('input');
    topics.type = 'text';
    topics.id = 'brief-topics';
    topics.maxLength = 200;
    topics.placeholder = 'e.g. AI, climate tech';
    topics.addEventListener('change', () => setFeatures({ briefing_topics: topics.value.trim() }));
    const topicsRow = el('label', 'row stack');
    topicsRow.htmlFor = 'brief-topics';
    const topicsWords = el('span');
    topicsWords.append(el('strong', '', 'News topics'), el('small', '', 'Separated by commas; the News section reads their headlines'));
    topicsRow.append(topicsWords, topics);
    const wrapup = toggle('sw-wrapup', 'Evening wrap-up', () => setFeatures({ wrapup_on: !(briefing && briefing.wrapup.on) }));
    const wrapTime = timeBox('wrapup-time', 'Evening wrap-up time');
    wrapTime.addEventListener('change', () => { if (HHMM.test(wrapTime.value)) setFeatures({ wrapup_time: wrapTime.value }); });
    const timeRow = el('label', 'row');
    timeRow.htmlFor = 'wrapup-time';
    const timeWords = el('span');
    timeWords.append(el('strong', '', 'Wrap-up time'));
    timeRow.append(timeWords, wrapTime);
    const now = button('Wrap up now', 'btn', () => {
      if (typeof toggleSettings === 'function') toggleSettings(false);
      send({ type: 'briefing_wrapup_now' });
    });
    now.id = 'wrapup-now';
    group.append(
      el('p', 'small-status brief-lead', 'What it covers, in this order:'),
      list,
      topicsRow,
      row('Evening wrap-up', 'What happened today, tomorrow’s first event, and what’s still open', wrapup),
      timeRow,
      now,
    );
    renderBriefing();
  }

  function sectionRow(s, index, count, sections) {
    const [name, hint] = SECTIONS[s.id];
    const li = el('li', `brief-section${s.on ? '' : ' off'}`);
    li.dataset.id = s.id;
    li.setAttribute('aria-label', name);
    const fact = el('span', 'fact');
    fact.append(el('strong', '', name), el('small', '', hint));
    const up = button('↑', 'btn brief-move', () => setFeatures({ briefing_sections: P.move(sections, s.id, -1) }), 'Move up');
    const down = button('↓', 'btn brief-move', () => setFeatures({ briefing_sections: P.move(sections, s.id, 1) }), 'Move down');
    up.disabled = index === 0;
    down.disabled = index === count - 1;
    const sw = button('', 'switch', () => setFeatures({ briefing_sections: P.toggled(sections, s.id) }), 'In the briefing');
    sw.setAttribute('role', 'switch');
    sw.setAttribute('aria-checked', String(s.on));
    li.append(fact, up, down, sw);
    return li;
  }

  function renderBriefing() {
    const list = F.$('brief-sections');
    if (!list) return;
    const sections = P.sections(features, briefing && briefing.sections);
    list.replaceChildren(...sections.map((s, i) => sectionRow(s, i, sections.length, sections)));
    const topics = F.$('brief-topics');
    const wanted = typeof features.briefing_topics === 'string' ? features.briefing_topics : (briefing && briefing.topics) || '';
    if (topics && document.activeElement !== topics) topics.value = wanted;
    const wrap = (briefing && briefing.wrapup) || { on: false, time: '21:00' };
    const on = 'wrapup_on' in features ? Boolean(features.wrapup_on) : Boolean(wrap.on);
    const at = HHMM.test(features.wrapup_time || '') ? features.wrapup_time : wrap.time;
    F.$('sw-wrapup')?.setAttribute('aria-checked', String(on));
    const box = F.$('wrapup-time');
    if (box && document.activeElement !== box) box.value = at;
    if (briefing) briefing.wrapup = { ...wrap, on, time: at };
  }

  // ── events ──

  function onPrefs(p) {
    if (!p) return;
    if (p.language) lang = p.language;
    if (p.features) features = p.features;
    renderQuiet();
    renderBriefing();
  }

  // The backend's state when this script loads (it may load after the hello: a prefs event
  // since then is newer, and is replayed after it), after every hello, and as it changes.
  F.on('hello', (ev) => { onPrefs(ev.prefs); send({ type: 'proactive_state' }); }, { replay: true });
  F.on('prefs', onPrefs, { replay: true });
  F.on('proactive', (ev) => {
    if (ev.quiet) { quiet = ev.quiet; renderQuiet(); }
    if (ev.briefing) { briefing = ev.briefing; renderBriefing(); }
  });
  buildQuiet();
  buildBriefing();
  send({ type: 'proactive_state' });
  // A pause ends by itself: Settings shows it, and the Focus line, as they are now.
  setInterval(() => { if (!F.$('settings')?.hidden) renderQuiet(); }, 30000);
})();
