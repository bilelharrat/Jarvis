// What Jarvis did (the actions feature, jarvis.features.actions): a History tab in the
// Activity drawer beside what's happening now. Every tool call of the last 90 days, searched,
// newest first, a day under its own heading, older ones a page at a time. And an Undo button
// under the reply after a turn that did something undoable. The words beside a call (an
// app's or a site's name) and what an action was are the owner's data: shown as text, with
// data-no-i18n.
(() => {
  const F = window.jarvisFeatures;
  if (!F) return;
  const { el, $, send } = F;
  const T = (text) => F.t(text);

  const S = { tab: 'now', q: '', seq: 0, items: [], more: false, asked: false, timer: 0 };
  const NOW_PARTS = ['tasks-list', 'activity-list', 'activity-empty'];

  function locale() { return window.jarvisI18n && window.jarvisI18n.lang() === 'zh' ? 'zh-CN' : undefined; }

  function dayText(stamp) {
    const d = new Date(stamp);
    const now = new Date();
    const days = Math.round((new Date(now.toDateString()) - new Date(d.toDateString())) / 86400000);
    if (days === 0) return T('Today');
    if (days === 1) return T('Yesterday');
    const opts = { weekday: 'long', day: 'numeric', month: 'long' };
    if (d.getFullYear() !== now.getFullYear()) opts.year = 'numeric';
    return d.toLocaleDateString(locale(), opts);
  }

  function timeText(stamp) {
    return new Date(stamp).toLocaleTimeString(locale(), { hour: 'numeric', minute: '2-digit' });
  }

  function build() {
    if ($('act-tabs')) return true;
    const drawer = $('activity');
    const head = drawer && drawer.querySelector('.drawer-head');
    if (!head) return false;
    const bar = el('div', 'act-tabs');
    bar.id = 'act-tabs';
    bar.setAttribute('role', 'tablist');
    bar.setAttribute('aria-label', 'Activity');
    for (const [id, label] of [['now', 'Now'], ['history', 'History']]) {
      const b = el('button', 'act-tab', label);
      b.type = 'button';
      b.id = `act-tab-${id}`;
      b.setAttribute('role', 'tab');
      b.addEventListener('click', () => show(id));
      bar.append(b);
    }
    head.after(bar);
    const box = el('section', 'act-history');
    box.id = 'act-history';
    box.hidden = true;
    box.setAttribute('role', 'tabpanel');
    const field = el('input', 'act-search');
    field.id = 'act-search';
    field.type = 'search';
    field.placeholder = 'Search what Jarvis did';
    field.setAttribute('aria-label', 'Search what Jarvis did');
    field.addEventListener('input', () => {
      clearTimeout(S.timer);
      S.timer = setTimeout(() => ask(field.value.trim(), ''), 250);
    });
    const days = el('div', 'act-days');
    days.id = 'act-days';
    const more = el('button', 'btn act-more', 'Show earlier');
    more.type = 'button';
    more.id = 'act-more';
    more.hidden = true;
    more.addEventListener('click', () => {
      const last = S.items[S.items.length - 1];
      if (last) ask(S.q, last.t);
    });
    const empty = el('p', 'empty act-empty');
    empty.id = 'act-empty';
    empty.hidden = true;
    box.append(field, days, more, empty);
    drawer.append(box);
    return true;
  }

  function show(tab) {
    if (!build()) return;
    S.tab = tab;
    for (const id of ['now', 'history']) {
      const b = $(`act-tab-${id}`);
      b.setAttribute('aria-selected', String(id === tab));
      b.tabIndex = id === tab ? 0 : -1;
    }
    const history = tab === 'history';
    for (const id of NOW_PARTS) {
      const part = $(id);
      if (part) part.classList.toggle('act-away', history);
    }
    $('act-history').hidden = !history;
    if (history) {
      if (!S.asked) ask(S.q, '');
      $('act-search').focus({ preventScroll: true });
    }
  }

  function ask(q, before) {
    S.seq += 1;
    S.asked = true;
    send({ type: 'action_log', q, before, seq: String(S.seq) });
  }

  function render() {
    const days = $('act-days');
    if (!days) return;
    const groups = [];
    for (const item of S.items) {
      const key = new Date(item.t).toDateString();
      if (!groups.length || groups[groups.length - 1].key !== key) groups.push({ key, stamp: item.t, items: [] });
      groups[groups.length - 1].items.push(item);
    }
    days.replaceChildren(...groups.map((group) => {
      const box = el('section', 'act-day');
      box.append(el('h3', 'act-day-head', dayText(group.stamp)));
      const list = el('ol', 'activity-list act-list');
      list.append(...group.items.map((item) => {
        const li = el('li', item.outcome);
        const t = el('time', '', timeText(item.t));
        t.dateTime = item.t;
        const what = el('span', 'act-what');
        what.append(el('span', '', item.label));
        if (item.summary) {
          const words = el('small', 'act-words', item.summary);
          words.setAttribute('data-no-i18n', '');
          what.append(words);
        }
        const st = el('span', 'st', item.outcome === 'failed' ? 'failed' : item.outcome === 'stopped' ? 'stopped' : '');
        li.append(t, what, st);
        return li;
      }));
      box.append(list);
      return box;
    }));
    $('act-more').hidden = !S.more;
    const empty = $('act-empty');
    empty.hidden = S.items.length > 0;
    empty.textContent = S.q ? 'Nothing Jarvis did matches.' : 'Nothing Jarvis did is kept yet.';
  }

  // ── Undo, under the reply ──

  function undoChip() {
    let chip = $('act-undo');
    if (chip) return chip;
    const caption = document.querySelector('.caption');
    if (!caption) return null;
    chip = el('div', 'act-undo');
    chip.id = 'act-undo';
    chip.hidden = true;
    const label = el('span', 'act-undo-label');
    label.id = 'act-undo-label';
    label.setAttribute('data-no-i18n', '');
    const b = el('button', 'act-undo-btn', 'Undo');
    b.type = 'button';
    b.id = 'act-undo-btn';
    b.addEventListener('click', () => {
      send({ type: 'undo_action', id: chip.dataset.id || '' });
      chip.hidden = true;
    });
    chip.append(label, b);
    caption.append(chip);
    return chip;
  }

  F.on('undo_offer', (ev) => {
    const chip = undoChip();
    if (!chip) return;
    chip.dataset.id = ev.id || '';
    $('act-undo-label').textContent = ev.label || '';
    chip.hidden = !ev.id;
  });
  F.on('turn', (ev) => {
    const chip = $('act-undo');
    if (ev.user && chip) chip.hidden = true; // a new request: that offer was for the last one
  });

  F.on('action_log', (ev) => {
    if (String(ev.seq || '') !== String(S.seq)) return; // an older search, or another window's
    S.q = ev.q || '';
    S.items = ev.before ? [...S.items, ...(ev.items || [])] : (ev.items || []);
    S.more = !!ev.more;
    render();
  });
  // A turn that used tools adds to today's history: asked again when it's showing.
  F.on('turn_done', () => { if (S.tab === 'history' && !$('act-history').hidden) ask(S.q, ''); });

  if (build()) show('now');
})();
