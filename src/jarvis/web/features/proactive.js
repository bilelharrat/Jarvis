// The proactive feature's window side (jarvis.features.proactive): Settings › Speaking up
// gains the weekend's own quiet hours, following a Focus mode (with why it can't, when it
// can't) and a snooze with its Resume; Settings › Morning briefing gains its sections (each
// on or off, in the owner's order), news topics and the evening wrap-up; a new Settings ›
// Weather and travel holds the weather heads-ups (severe weather, the air, big swings) and
// how the owner gets around (the usual way, places reached another way, arriving early),
// and a new Settings › Meetings holds the meeting offer, call notes, action items to
// Reminders and invitations that clash. Cards: a habit card gains "Make it a routine", a
// meeting starting offers notes, the notes' card gains Draft follow-up and Add to
// Reminders, and a clashing invitation shows its suggested reply to copy or draft.
// Weather heads-ups and invitation clashes get their own kickers on cards.
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
    code: ['Eden Code', 'What sessions did while you were away'],
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
    // What Settings says the weather watch sees: {words, place, details} (details: the
    // warnings and the air, the backend's words; '' when there are none).
    weatherLine(w, air) {
      if (!w) return { words: '', place: '', details: '' };
      if (!w.place) return { words: w.error || 'Needs your location, or a weather city, to watch the weather.', place: '', details: '' };
      const bits = Array.isArray(w.warnings) ? w.warnings.filter((x) => typeof x === 'string' && x) : [];
      if (air !== 'off' && w.air && Number.isFinite(w.air.aqi)) bits.push(`AQI ${w.air.aqi} · ${w.air.words}`);
      return { words: 'Watching the weather in', place: w.place, details: bits.join(' · ') };
    },
    MODES: ['driving', 'transit', 'walking'],
    // The places reached another way: the settings' own, else the backend's word.
    places(features, fallback) {
      const listed = Array.isArray((features || {}).travel_places) ? features.travel_places : fallback;
      return (Array.isArray(listed) ? listed : []).filter((p) => p && typeof p.place === 'string' && P.MODES.includes(p.mode)).map((p) => ({ place: p.place, mode: p.mode }));
    },
    // A place added (or its way changed): null when there's no place to add, or no room.
    withPlace(places, place, mode) {
      const name = String(place || '').replace(/\s+/g, ' ').trim().slice(0, 60);
      if (!name || !P.MODES.includes(mode)) return null;
      const out = places.map((p) => ({ ...p }));
      const known = out.find((p) => p.place.toLowerCase() === name.toLowerCase());
      if (known) known.mode = mode;
      else if (out.length >= 30) return null;
      else out.push({ place: name, mode });
      return out;
    },
    withoutPlace(places, place) {
      return places.filter((p) => p.place !== place).map((p) => ({ ...p }));
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
  let weather = null;  // what the weather watch last saw
  let commute = null;  // the backend's word on the commute profile

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

  // ── Settings › Weather and travel: weather heads-ups ──

  // Weather heads-ups say so on their cards (app.js's kickers name each kind of heads-up).
  if (typeof ALERT_KICKERS === 'object' && ALERT_KICKERS) {
    ALERT_KICKERS.weather = 'Weather';
    ALERT_KICKERS.clash = 'Calendar';
  }

  const AIR_MODES = [['off', 'Off'], ['sensitive', 'Sensitive groups'], ['unhealthy', 'Unhealthy']];

  function segmented(id, label, options, onPick) {
    const group = el('div', 'segmented');
    group.id = id;
    group.setAttribute('role', 'radiogroup');
    group.setAttribute('aria-label', label);
    for (const [value, text] of options) {
      const b = button(text, '', () => onPick(value));
      b.setAttribute('role', 'radio');
      b.dataset.mode = value;
      b.setAttribute('aria-checked', 'false');
      group.append(b);
    }
    return group;
  }

  function pick(id, value) {
    F.$(id)?.querySelectorAll('[role="radio"]').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.mode === value)));
  }

  function buildWeather() {
    const before = F.$('sw-briefing')?.closest('section.group');
    if (!before || F.$('travel-group')) return;
    const group = el('section', 'group');
    group.id = 'travel-group';
    const severe = toggle('sw-weather-severe', 'Severe weather', () => setFeatures({ weather_severe: features.weather_severe === false }));
    const swings = toggle('sw-weather-swings', 'Big temperature swings', () => setFeatures({ weather_swings: features.weather_swings === false }));
    const air = segmented('weather-air', 'Air quality warnings', AIR_MODES, (mode) => setFeatures({ weather_air: mode }));
    const status = el('p', 'small-status');
    status.id = 'weather-status';
    group.append(
      el('h3', '', 'Weather and travel'),
      row('Severe weather', 'In the US, warnings from the National Weather Service; elsewhere, storms, ice, heavy snow, gales and extreme heat or cold in the forecast', severe),
      row('Air quality warnings', 'When the air gets unhealthy for sensitive groups, or for everyone'),
      air,
      row('Big temperature swings', 'Said in the evening when tomorrow will be much warmer or colder than today', swings),
      status,
    );
    before.after(group);
    renderWeather();
  }

  function renderWeather() {
    F.$('sw-weather-severe')?.setAttribute('aria-checked', String(features.weather_severe !== false));
    F.$('sw-weather-swings')?.setAttribute('aria-checked', String(features.weather_swings !== false));
    const air = ['off', 'sensitive', 'unhealthy'].includes(features.weather_air) ? features.weather_air : 'sensitive';
    pick('weather-air', air);
    const status = F.$('weather-status');
    if (!status) return;
    const { words, place, details } = P.weatherLine(weather, air);
    status.replaceChildren();
    if (words) status.append(el('span', '', words));
    if (place) {
      status.append(' ', mine(el('bdi', '', place)), el('br'));
      status.append(details ? mine(el('span', 'weather-now', details)) : el('span', 'weather-now', 'No warnings right now.'));
    }
    status.hidden = !words;
  }

  // ── Settings › Weather and travel: how you get around ──

  const MODE_WORDS = { driving: 'Drive', transit: 'Transit', walking: 'Walk' };
  const EARLY = [0, 5, 10, 15, 20, 30];

  function buildCommute() {
    const group = F.$('travel-group');
    if (!group || F.$('commute-mode')) return;
    const mode = segmented('commute-mode', 'How you usually get around', P.MODES.map((m) => [m, MODE_WORDS[m]]), (m) => setFeatures({ travel_mode: m }));
    const early = el('select');
    early.id = 'commute-early';
    early.setAttribute('aria-label', 'Arrive early');
    for (const m of EARLY) {
      const option = el('option', '', m ? `${m} minutes early` : 'On time');
      option.value = String(m);
      early.append(option);
    }
    early.addEventListener('change', () => setFeatures({ arrive_early: Number(early.value) }));
    const list = el('ul', 'itemlist commute-places');
    list.id = 'commute-places';
    const place = el('input');
    place.type = 'text';
    place.id = 'commute-place';
    place.maxLength = 60;
    place.placeholder = 'e.g. office, dentist';
    place.setAttribute('aria-label', 'A place');
    const how = el('select');
    how.id = 'commute-place-mode';
    how.setAttribute('aria-label', 'How you get there');
    for (const m of P.MODES) {
      const option = el('option', '', MODE_WORDS[m]);
      option.value = m;
      how.append(option);
    }
    const add = button('Add', 'btn', () => {
      const places = P.withPlace(currentPlaces(), place.value, how.value);
      if (!places) return;
      setFeatures({ travel_places: places });
      place.value = '';
    });
    add.id = 'commute-add';
    place.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); add.click(); } });
    const addRow = el('div', 'row commute-add');
    addRow.append(place, how, add);
    group.append(
      row('Getting around', 'Leave-time heads-ups follow it: by car with traffic, by transit with its timetable, or on foot'),
      mode,
      row('Arrive early', 'Leave this much sooner than the trip needs', early),
      row('Places you get to another way', 'A place matches an event whose location or title has it'),
      list,
      addRow,
    );
    renderCommute();
  }

  function currentPlaces() {
    return P.places(features, commute && commute.places);
  }

  function renderCommute() {
    const c = commute || { mode: 'driving', places: [], early: 0 };
    pick('commute-mode', P.MODES.includes(features.travel_mode) ? features.travel_mode : c.mode);
    const early = Number.isInteger(features.arrive_early) ? features.arrive_early : c.early;
    const select = F.$('commute-early');
    if (select && document.activeElement !== select) {
      if (![...select.options].some((o) => o.value === String(early))) {
        const option = el('option', '', `${early} minutes early`);
        option.value = String(early);
        select.append(option);
      }
      select.value = String(early);
    }
    const list = F.$('commute-places');
    if (!list) return;
    const places = currentPlaces();
    list.replaceChildren(...places.map((p) => {
      const li = el('li');
      li.dataset.place = p.place;
      const words = el('span', 'fact');
      words.append(mine(el('bdi', '', p.place)), el('small', '', MODE_WORDS[p.mode]));
      const remove = button('Remove', 'btn', () => setFeatures({ travel_places: P.withoutPlace(currentPlaces(), p.place) }), 'Remove');
      li.append(words, remove);
      return li;
    }));
    list.hidden = !places.length;
  }

  // ── Settings › Meetings: offers, call notes, action items, invitations that clash ──

  function buildMeetings() {
    const before = F.$('travel-group') || F.$('sw-briefing')?.closest('section.group');
    if (!before || F.$('meetings-group')) return;
    const group = el('section', 'group');
    group.id = 'meetings-group';
    const offer = toggle('sw-meeting-offer', 'Offer to take notes', () => setFeatures({ meeting_offer: features.meeting_offer === false }));
    const calls = toggle('sw-call-notes', 'Notes for online calls', () => setFeatures({ call_notes: !features.call_notes }));
    const remind = toggle('sw-meeting-reminders', 'Action items to Reminders', () => setFeatures({ meeting_reminders: !features.meeting_reminders }));
    const list = el('input');
    list.type = 'text';
    list.id = 'meeting-reminders-list';
    list.maxLength = 80;
    list.placeholder = 'Your default list';
    list.addEventListener('change', () => setFeatures({ meeting_reminders_list: list.value.trim() }));
    const listRow = el('label', 'row stack');
    listRow.id = 'meeting-reminders-list-row';
    listRow.htmlFor = 'meeting-reminders-list';
    const listWords = el('span');
    listWords.append(el('strong', '', 'Reminders list'), el('small', '', 'Where the action items go'));
    listRow.append(listWords, list);
    const clashes = toggle('sw-clash-alerts', 'Invitations that clash', () => setFeatures({ clash_alerts: features.clash_alerts === false }));
    group.append(
      el('h3', '', 'Meetings'),
      row('Offer to take notes', 'A card as a meeting with other people, or a call, starts', offer),
      row('Notes for online calls', 'The call’s own sound too, so the notes say who spoke: you and them. Needs Screen Recording.', calls),
      row('Action items to Reminders', 'After the notes are written up, each action item goes on a Reminders list by itself', remind),
      listRow,
      row('Invitations that clash', 'A heads-up, with a reply to send, when an invitation breaks your time rules (Goals) or double-books you', clashes),
    );
    before.after(group);
    renderMeetings();
  }

  function renderMeetings() {
    F.$('sw-meeting-offer')?.setAttribute('aria-checked', String(features.meeting_offer !== false));
    F.$('sw-call-notes')?.setAttribute('aria-checked', String(Boolean(features.call_notes)));
    F.$('sw-meeting-reminders')?.setAttribute('aria-checked', String(Boolean(features.meeting_reminders)));
    F.$('sw-clash-alerts')?.setAttribute('aria-checked', String(features.clash_alerts !== false));
    const listRow = F.$('meeting-reminders-list-row');
    if (listRow) listRow.hidden = !features.meeting_reminders;
    const box = F.$('meeting-reminders-list');
    if (box && document.activeElement !== box) box.value = typeof features.meeting_reminders_list === 'string' ? features.meeting_reminders_list : '';
  }

  // ── cards: habits into routines, meeting offers and follow-ups, invitations that clash ──

  const settle = () => { if (typeof syncDismissAll === 'function') syncDismissAll(); };

  // A habit card gains "Make it a routine" (the backend puts up the routine's own card).
  F.on('suggestion', (ev) => {
    if (ev.category !== 'habit') return;
    const card = document.querySelector(`#cards [data-suggestion="${CSS.escape(String(ev.key || ''))}"]`);
    const actions = card && card.querySelector('.card-actions');
    if (!actions || actions.querySelector('.habit-routine')) return;
    const make = button('Make it a routine', 'btn habit-routine', () => {
      make.disabled = true;
      send({ type: 'habit_routine', key: ev.key });
    });
    actions.append(make);
  });

  function onHabit(habit) {
    const card = document.querySelector(`#cards [data-suggestion="${CSS.escape(String(habit.key || ''))}"]`);
    if (!card) return;
    if (habit.done) { card.remove(); settle(); return; }
    const make = card.querySelector('.habit-routine');
    if (make) make.disabled = false;
  }

  // A meeting starting: take notes? (a card, never spoken; it goes by itself).
  F.on('meeting_offer', (ev) => {
    const key = String(ev.key || '');
    document.querySelectorAll(`#cards [data-meeting-offer="${CSS.escape(key)}"]`).forEach((n) => n.remove());
    const card = el('div', 'card plain meeting-offer');
    card.dataset.meetingOffer = key;
    card.append(el('div', 'card-kicker', 'Meeting'));
    card.append(mine(el('div', 'card-title', String(ev.title || ''))));
    card.append(el('div', 'card-text', 'It’s starting. Take notes?'));
    const actions = el('div', 'card-actions');
    const act = (action) => { send({ type: 'meeting_offer', key, action }); card.remove(); settle(); };
    actions.append(button('Take notes', 'btn primary', () => act('notes')));
    if (ev.calls) actions.append(button('Notes on the call', 'btn', () => act('call')));
    actions.append(button('Not now', 'btn', () => act('dismiss')));
    card.append(actions);
    F.$('cards').append(card);
    settle();
    setTimeout(() => { card.remove(); settle(); }, Math.max(60, Number(ev.ttl) || 900) * 1000);
  });

  // The notes' card (app.js makes it as the write-up ends): a follow-up and Reminders.
  F.on('meeting', (ev) => {
    if (ev.active || ev.writing || !ev.path || !(Number(ev.actions) > 0)) return;
    const card = F.$('cards').lastElementChild;
    const actions = card && card.querySelector('.card-actions');
    if (!actions || card.dataset.meetingPath) return;
    card.dataset.meetingPath = ev.path;
    const follow = (action, b) => { b.disabled = true; send({ type: 'meeting_followup', path: ev.path, action }); };
    const draft = button('Draft follow-up', 'btn meeting-draft', () => follow('email', draft));
    const remind = button('Add to Reminders', 'btn meeting-remind', () => follow('reminders', remind));
    actions.insertBefore(draft, actions.lastElementChild);
    actions.insertBefore(remind, actions.lastElementChild);
  });

  function onFollowup(f) {
    if (!f || !(Number(f.added) > 0)) return;
    const card = document.querySelector(`#cards [data-meeting-path="${CSS.escape(String(f.path || ''))}"]`);
    if (!card) return;
    card.querySelector('.meeting-remind')?.remove();  // they're in Reminders already
    card.insertBefore(el('div', 'card-text', 'Action items added to Reminders.'), card.querySelector('.card-actions'));
  }

  // An invitation that clashes: the suggested reply, to copy or open as a Mail draft.
  function onClash(c) {
    const key = String((c && c.key) || '');
    const card = document.querySelector(`#cards [data-alert="${CSS.escape(key)}"]`);
    if (!card || card.querySelector('.clash-reply')) return;
    const reply = mine(el('div', 'card-text clash-reply', String(c.reply || '')));
    const actions = card.querySelector('.card-actions');
    card.insertBefore(reply, actions);
    const copy = button('Copy reply', 'btn', async () => {
      try { await navigator.clipboard.writeText(String(c.reply || '')); copy.textContent = 'Copied'; } catch (_) { copy.textContent = 'Couldn’t copy'; }
    });
    const mail = button('Draft in Mail', 'btn', () => { mail.disabled = true; send({ type: 'clash_reply', key }); });
    actions.insertBefore(copy, actions.lastElementChild);
    actions.insertBefore(mail, actions.lastElementChild);
  }

  // ── events ──

  function onPrefs(p) {
    if (!p) return;
    if (p.language) lang = p.language;
    if (p.features) features = p.features;
    renderQuiet();
    renderBriefing();
    renderWeather();
    renderCommute();
    renderMeetings();
  }

  // The backend's state when this script loads (it may load after the hello: a prefs event
  // since then is newer, and is replayed after it), after every hello, and as it changes.
  F.on('hello', (ev) => { onPrefs(ev.prefs); send({ type: 'proactive_state' }); }, { replay: true });
  F.on('prefs', onPrefs, { replay: true });
  F.on('proactive', (ev) => {
    if (ev.quiet) { quiet = ev.quiet; renderQuiet(); }
    if (ev.briefing) { briefing = ev.briefing; renderBriefing(); }
    if (ev.weather) { weather = ev.weather; renderWeather(); }
    if (ev.commute) { commute = ev.commute; renderCommute(); }
    if (ev.habit) onHabit(ev.habit);
    if (ev.meetings) onFollowup(ev.meetings.followup);
    if (ev.clash) onClash(ev.clash);
  });
  buildQuiet();
  buildBriefing();
  buildWeather();
  buildCommute();
  buildMeetings();
  send({ type: 'proactive_state' });
  // A pause ends by itself: Settings shows it, and the Focus line, as they are now.
  setInterval(() => { if (!F.$('settings')?.hidden) renderQuiet(); }, 30000);
})();
