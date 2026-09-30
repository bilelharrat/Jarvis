// The proactive feature's window side (jarvis.features.proactive): Settings › Speaking up
// gains the weekend's own quiet hours, following a Focus mode (with why it can't, when it
// can't) and a snooze with its Resume.
//
// Everything the backend or the owner wrote (a Focus mode's name, a time) is shown with
// textContent and marked data-no-i18n; the window's own words are translated by i18n.js as
// they appear. The helpers at the top are pure (window.jarvisProactive), so node --test can
// check them without a page.
(() => {
  const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
  const P = {
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
  };
  window.jarvisProactive = P;

  const F = window.jarvisFeatures;
  if (!F || typeof document === 'undefined') return;
  const { el, send } = F;
  const mine = (node) => { node.setAttribute('data-no-i18n', ''); return node; };

  let lang = 'en';
  let features = {};
  let quiet = null;

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

  // ── events ──

  function onPrefs(p) {
    if (!p) return;
    if (p.language) lang = p.language;
    if (p.features) features = p.features;
    renderQuiet();
  }

  // The backend's state when this script loads (it may load after the hello: a prefs event
  // since then is newer, and is replayed after it), after every hello, and as it changes.
  F.on('hello', (ev) => { onPrefs(ev.prefs); send({ type: 'proactive_state' }); }, { replay: true });
  F.on('prefs', onPrefs, { replay: true });
  F.on('proactive', (ev) => {
    if (ev.quiet) { quiet = ev.quiet; renderQuiet(); }
  });
  buildQuiet();
  send({ type: 'proactive_state' });
  // A pause ends by itself: Settings shows it, and the Focus line, as they are now.
  setInterval(() => { if (!F.$('settings')?.hidden) renderQuiet(); }, 30000);
})();
