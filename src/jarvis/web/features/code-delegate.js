// Eden Code's attention-aware delegation (features/code_delegate.py), its window side:
// Settings › General › "While you're busy": hold non-urgent heads-ups in meetings and Focus
// for a digest at the next break (code_delegate_hold, on), meeting action items as proposed
// to-do cards (code_delegate_meeting_cards, on), and easy cards started without the owner
// near the end of the day or when they step away (code_delegate_autostart, off; its caps:
// code_delegate_per_day, code_delegate_spend, code_delegate_end; and code_delegate_model,
// off). The group also says how many heads-ups are held now, with "Show them now".
// Pure logic exported for node's tests (tests/web/code-delegate.test.mjs).
(function codeDelegate(root) {
  'use strict';

  const PER_DAY = [1, 2, 3, 4, 5];
  const SPEND = [1, 2, 3, 5, 10];
  const SWITCHES = [
    ['code_delegate_hold', true, 'Hold heads-ups in meetings and Focus',
      'Eden Code’s heads-ups that can wait come as one digest at your next break. A session stuck on a risky question, a failing deploy or a production alert still reaches you.'],
    ['code_delegate_meeting_cards', true, 'Meeting action items become to-do cards',
      'Coding tasks from your meeting notes are added to the project’s to-do column in Plan mode. Nothing runs until you start them.'],
    ['code_delegate_autostart', false, 'Start easy cards without me',
      'Near the end of the day, or when you step away, Eden starts small low-risk cards itself (typos, docs, tests…): one at a time, in an isolated copy, its commands sandboxed, never pushed, within your spending caps.'],
    ['code_delegate_model', false, 'Check each card with a model too',
      'One Haiku call for each card the rules pass, up to 20 a day; it can only say no. Off: rules only, no cost.'],
  ];

  // A switch's value from the prefs: what's kept, else its default.
  function valueOf(features, key, fallback) {
    const f = features || {};
    return typeof f[key] === 'boolean' ? f[key] : fallback;
  }

  // The nearest offered choice for a kept number (a cap typed elsewhere still shows).
  function nearest(list, value, fallback) {
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    return list.reduce((best, x) => (Math.abs(x - n) < Math.abs(best - n) ? x : best), list[0]);
  }

  // "17:30", or the default for anything else.
  function clock(value) {
    return typeof value === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(value) ? value : '17:30';
  }

  // The held line: "" when nothing's held.
  function heldLine(state, tr = (s) => s) {
    const n = state && Number.isInteger(state.held) ? state.held : 0;
    if (!n) return '';
    return n === 1 ? tr('1 heads-up is waiting for your next break.') : `${n} ${tr('heads-ups are waiting for your next break.')}`;
  }

  const api = { PER_DAY, SPEND, SWITCHES, valueOf, nearest, clock, heldLine };
  if (typeof module === 'object' && module.exports) { module.exports = api; return; }
  const F = root.jarvisFeatures;
  if (!F) return;
  const el = F.el;
  const t = (text) => F.t(text);
  const send = (changes) => F.send({ type: 'feature_prefs', changes });
  const switches = new Map();  // key -> [button, value]
  let perDay = null;
  let spend = null;
  let end = null;
  let held = null;
  let heldRow = null;
  let caps = null;

  function select(id, list, fmt, key) {
    const s = el('select', 'jcs-select');
    s.id = id;
    for (const v of list) {
      const o = el('option', '', fmt(v));
      o.value = String(v);
      s.append(o);
    }
    s.addEventListener('change', () => send({ [key]: Number(s.value) }));
    return s;
  }

  function build() {
    const general = typeof document !== 'undefined' && document.getElementById('jcs-general');
    if (!general || document.getElementById('dlg-group')) return;
    const label = el('p', 'jcs-label', t('While you’re busy'));
    const group = el('div', 'jcs-group');
    group.id = 'dlg-group';
    for (const [key, fallback, name, small] of SWITCHES) {
      const row = el('div', 'jcs-row');
      const words = el('span');
      words.append(document.createTextNode(t(name)), el('small', '', t(small)));
      const sw = el('button', 'jcs-switch');
      sw.type = 'button';
      sw.id = `dlg-${key.replace('code_delegate_', '').replace(/_/g, '-')}`;
      sw.setAttribute('role', 'switch');
      sw.setAttribute('aria-label', t(name));
      sw.setAttribute('aria-checked', String(fallback));
      switches.set(key, [sw, fallback]);
      sw.addEventListener('click', () => {
        const now = !(switches.get(key)[1]);
        switches.set(key, [sw, now]);
        sw.setAttribute('aria-checked', String(now));
        if (key === 'code_delegate_autostart' && caps) caps.hidden = !now;
        send({ [key]: now });
      });
      row.append(words, sw);
      group.append(row);
      if (key === 'code_delegate_autostart') {
        caps = el('div', 'dlg-caps');
        caps.hidden = true;
        perDay = select('dlg-per-day', PER_DAY, (v) => (v === 1 ? t('1 a day') : `${v} ${t('a day')}`), 'code_delegate_per_day');
        spend = select('dlg-spend', SPEND, (v) => `$${v} ${t('each')}`, 'code_delegate_spend');
        end = el('input', 'jcs-input dlg-end');
        end.type = 'time';
        end.id = 'dlg-end';
        end.setAttribute('aria-label', t('My day ends at'));
        end.addEventListener('change', () => { if (/^\d\d:\d\d$/.test(end.value)) send({ code_delegate_end: end.value }); });
        const a = el('label', 'jcs-row');
        a.append(el('span', '', t('At most')), perDay);
        const b = el('label', 'jcs-row');
        b.append(el('span', '', t('Spending cap')), spend);
        const c = el('label', 'jcs-row');
        const cw = el('span');
        cw.append(document.createTextNode(t('My day ends at')), el('small', '', t('Cards may start from half an hour before.')));
        c.append(cw, end);
        caps.append(a, b, c);
        group.append(caps);
      }
    }
    heldRow = el('div', 'jcs-row dlg-held');
    heldRow.hidden = true;
    held = el('span', 'dlg-held-text');
    held.setAttribute('role', 'status');
    const now = el('button', 'jc-btn small', t('Show them now'));
    now.type = 'button';
    now.addEventListener('click', () => F.send({ type: 'code_delegate_digest' }));
    heldRow.append(held, now);
    group.append(heldRow);
    const foot = general.querySelector('.jcs-foot');
    if (foot) general.insertBefore(label, foot); else general.append(label);
    general.insertBefore(group, label.nextSibling);
    F.send({ type: 'code_delegate' });
  }

  const take = (features) => {
    const f = features || {};
    for (const [key, fallback] of SWITCHES) {
      const pair = switches.get(key);
      if (!pair) continue;
      const v = valueOf(f, key, fallback);
      switches.set(key, [pair[0], v]);
      pair[0].setAttribute('aria-checked', String(v));
      if (key === 'code_delegate_autostart' && caps) caps.hidden = !v;
    }
    if (perDay) perDay.value = String(nearest(PER_DAY, f.code_delegate_per_day, 2));
    if (spend) spend.value = String(nearest(SPEND, f.code_delegate_spend, 2));
    if (end) end.value = clock(f.code_delegate_end);
  };
  build();
  F.on('prefs', (ev) => take(ev.features), { replay: true });
  F.on('hello', (ev) => take(ev.prefs && ev.prefs.features), { replay: true });
  F.on('code_delegate', (ev) => {
    if (!heldRow) return;
    const line = heldLine(ev, t);
    heldRow.hidden = !line;
    held.textContent = line;
  }, { replay: true });
})(typeof window === 'object' ? window : globalThis);
