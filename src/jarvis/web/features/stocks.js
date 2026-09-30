// Price alerts in Settings › Markets (jarvis.features.stocks): the alerts set by voice, each
// with a Remove button, and the watchlist's big-move heads-up (a percent, or off).
(() => {
  const F = window.jarvisFeatures;
  if (!F) return;
  const { el, send } = F;
  const MOVE = 'stocks_move_alert';
  const MOVES = [[0, 'Off'], [3, '3% or more'], [5, '5% or more'], [10, '10% or more']];

  // ── pure helpers (tests/web/stocks.test.mjs runs these) ──

  function price(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return '';
    return n.toLocaleString('en-US', { minimumFractionDigits: n < 1000 ? 2 : 0, maximumFractionDigits: n < 1000 ? 2 : 0 });
  }

  // What an alert watches for, in the window's words (the name stays as it is).
  function what(a) {
    if (a.kind === 'move') return `Moves ${a.value}% in a day`;
    return a.kind === 'above' ? `Goes above ${price(a.value)}` : `Goes below ${price(a.value)}`;
  }

  function state(a) {
    if (a.fired) return 'Went off today';
    if (a.waiting) return 'Waits for the price to come back first';
    return 'Watching';
  }

  if (typeof window.__stocksTest === 'function') window.__stocksTest({ price, what, state });

  // ── where it goes: under the watchlist in Settings › Markets ──

  const watch = document.getElementById('watchlist');
  const group = watch && watch.closest('section.group');
  if (!group) return;
  const box = el('div', 'stocks-box');
  const moveRow = el('label', 'row');
  moveRow.htmlFor = 'stocks-move';
  const moveText = el('span');
  moveText.append(el('strong', '', 'Big moves on my watchlist'), el('small', '', 'A heads-up when a stock on your watchlist moves this much in a day'));
  const select = el('select');
  select.id = 'stocks-move';
  for (const [value, label] of MOVES) {
    const option = el('option', '', label);
    option.value = String(value);
    select.append(option);
  }
  select.addEventListener('change', () => send({ type: 'feature_prefs', changes: { [MOVE]: Number(select.value) } }));
  moveRow.append(moveText, select);
  const head = el('p', 'small-status', 'Price alerts: say “Jarvis, tell me when Nvidia goes above 150.”');
  const list = el('ul', 'itemlist stocks-alerts');
  const note = el('p', 'small-status stocks-cap');
  box.append(moveRow, head, list, note);
  watch.closest('label').after(box);

  function render(ev) {
    const items = Array.isArray(ev.items) ? ev.items : [];
    list.replaceChildren(...items.map((a) => {
      const li = el('li');
      const fact = el('span', 'fact');
      const name = el('strong', '', String(a.name || a.symbol || ''));
      name.setAttribute('data-no-i18n', '');
      const detail = el('small');
      detail.append(el('span', '', what(a)), ' · ', el('span', '', state(a)));
      fact.append(name, detail);
      const rm = el('button', 'btn', 'Remove');
      rm.type = 'button';
      rm.setAttribute('aria-label', `Remove the ${a.symbol} alert`);
      rm.addEventListener('click', () => { rm.disabled = true; send({ type: 'price_alert_remove', id: a.id }); });
      li.append(fact, rm);
      return li;
    }));
    note.textContent = ev.sent_today ? `${ev.sent_today} of ${ev.cap} price heads-ups used today` : '';
    note.hidden = !ev.sent_today;
    if (ev.move !== undefined && document.activeElement !== select) select.value = String(Math.round(Number(ev.move) || 0));
  }

  function fromPrefs(p) {
    const features = (p && p.features) || {};
    if (MOVE in features && document.activeElement !== select) {
      const value = String(Math.round(Number(features[MOVE]) || 0));
      select.value = MOVES.some(([v]) => String(v) === value) ? value : '0';
    }
  }

  F.on('price_alerts', render, { replay: true });
  F.on('prefs', fromPrefs, { replay: true });
  F.on('hello', (ev) => { fromPrefs(ev.prefs); send({ type: 'price_alerts' }); }, { replay: true });
})();
