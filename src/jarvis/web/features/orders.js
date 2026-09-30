// Settings › Orders and subscriptions (the backend is jarvis.features.orders): orders found
// in the owner's email and where each stands, subscriptions and when each renews, and the
// settings for both. Shop names, numbers, dates and prices come from email: data
// (data-no-i18n); the window's own words around them are translated.
(() => {
  const F = window.jarvisFeatures;
  if (!F) return;
  const { el, send } = F;

  const STATUS = {
    ordered: 'Ordered',
    shipped: 'Shipped',
    out_for_delivery: 'Out for delivery',
    delivered: 'Delivered',
    cancelled: 'Cancelled',
    returned: 'Returned',
  };
  const FINAL = ['delivered', 'cancelled', 'returned'];
  const PERIOD = { weekly: 'a week', monthly: 'a month', yearly: 'a year' };
  const DAYS = [[0, 'Off'], [1, 'A day before'], [3, '3 days before'], [7, 'A week before']];
  const state = { on: true, days: 3, orders: [], subscriptions: [], error: '' };
  const parts = {};

  function mine(node) {
    node.setAttribute('data-no-i18n', '');
    return node;
  }

  function money(amount, currency) {
    if (typeof amount !== 'number' || !Number.isFinite(amount)) return '';
    const symbol = { USD: '$', EUR: '€', GBP: '£', JPY: '¥', CNY: '¥' }[currency] || '';
    const n = amount.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    return symbol ? `${symbol}${n}` : `${n} ${currency || ''}`.trim();
  }

  function day(iso) {
    if (!iso) return '';
    const at = new Date(`${iso}T12:00:00`);
    return Number.isNaN(at.getTime()) ? iso : at.toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' });
  }

  // One line under a name: groups joined by " · ", each group's pieces by a space. A piece
  // is [text, data]: data is the email's (kept as it is), the rest the window's words.
  function line(groups) {
    const small = el('small');
    const shown = groups.map((g) => g.filter(([text]) => text)).filter((g) => g.length);
    shown.forEach((group, i) => {
      if (i) small.append(' · ');
      group.forEach(([text, data], j) => {
        if (j) small.append(' ');
        small.append(data ? mine(el('bdi', '', text)) : el('bdi', '', text));
      });
    });
    return shown.length ? small : null;
  }

  function removeButton(item) {
    const b = el('button', 'btn', 'Remove');
    b.type = 'button';
    b.title = 'Remove from the list';
    b.addEventListener('click', () => send({ type: 'orders_forget', id: item.id }));
    return b;
  }

  function build() {
    if (parts.section) return parts.section;
    const settings = F.$('settings');
    if (!settings) return null;
    const section = el('section', 'group orders-group');
    section.id = 'orders-group';
    const row = el('div', 'row');
    const words = el('span');
    words.append(el('strong', '', 'Find orders in my email'),
      el('small', '', 'Order and shipping emails become a list here, with a heads-up when a delivery is on its way or has arrived. Rules read most of them; the rest go to Haiku, at most 30 a day. Needs Full Disk Access.'));
    const sw = el('button', 'switch');
    sw.type = 'button';
    sw.id = 'sw-orders';
    sw.setAttribute('role', 'switch');
    sw.setAttribute('aria-label', 'Find orders in my email');
    sw.addEventListener('click', () => {
      state.on = !state.on;
      sw.setAttribute('aria-checked', String(state.on));
      send({ type: 'feature_prefs', changes: { orders_on: state.on } });
    });
    row.append(words, sw);
    const remind = el('label', 'row');
    remind.htmlFor = 'orders-renewal';
    const remindWords = el('span');
    remindWords.append(el('strong', '', 'Remind me before a renewal'), el('small', '', 'For subscriptions found in your email'));
    const select = el('select');
    select.id = 'orders-renewal';
    for (const [value, text] of DAYS) {
      const option = el('option', '', text);
      option.value = String(value);
      select.append(option);
    }
    select.addEventListener('change', () => send({ type: 'feature_prefs', changes: { orders_renewal_days: Number(select.value) } }));
    remind.append(remindWords, select);
    const status = el('p', 'small-status orders-status');
    status.id = 'orders-status';
    const ordersList = el('ul', 'itemlist orders-list');
    ordersList.id = 'orders-list';
    const subsHead = el('h4', 'orders-subhead', 'Subscriptions');
    const subsList = el('ul', 'itemlist orders-subs');
    subsList.id = 'orders-subs';
    section.append(el('h3', '', 'Orders and subscriptions'), row, remind, status, ordersList, subsHead, subsList);
    const anchor = F.$('delegation-list');
    const before = anchor ? anchor.closest('section.group') : null;
    if (before && before.nextElementSibling) settings.insertBefore(section, before.nextElementSibling);
    else settings.append(section);
    Object.assign(parts, { section, sw, select, status, ordersList, subsHead, subsList });
    return section;
  }

  function orderItem(o) {
    const li = el('li', 'order');
    const fact = el('span', 'fact');
    fact.append(mine(el('strong', '', o.merchant)));
    const due = !FINAL.includes(o.status) && o.expected ? day(o.expected) : '';
    const about = line([
      [[STATUS[o.status] || o.status, false]],
      [[o.number ? `#${o.number}` : '', true]],
      [[due ? 'Due' : '', false], [due, true]],
      [[[o.carrier, o.tracking].filter(Boolean).join(' '), true]],
      [[money(o.amount, o.currency), true]],
    ]);
    if (about) fact.append(about);
    if (o.items) fact.append(mine(el('small', '', o.items)));
    li.append(fact, removeButton(o));
    return li;
  }

  function subItem(s) {
    const li = el('li', 'order sub');
    const fact = el('span', 'fact');
    fact.append(mine(el('strong', '', s.merchant)));
    const price = money(s.amount, s.currency);
    const about = line([
      [[price, true], [price ? PERIOD[s.period] || '' : '', false]],
      [[!price ? PERIOD[s.period] || '' : '', false]],
      [[s.renews ? 'Renews' : '', false], [day(s.renews), true]],
    ]);
    if (about) fact.append(about);
    li.append(fact, removeButton(s));
    return li;
  }

  function render() {
    if (!build()) return;
    parts.sw.setAttribute('aria-checked', String(!!state.on));
    parts.select.value = String(DAYS.some(([d]) => d === state.days) ? state.days : 3);
    parts.status.textContent = state.error || (state.on && !state.orders.length && !state.subscriptions.length ? 'No orders found yet.' : '');
    parts.status.hidden = !parts.status.textContent;
    parts.ordersList.replaceChildren(...state.orders.slice(0, 30).map(orderItem));
    parts.subsList.replaceChildren(...state.subscriptions.slice(0, 20).map(subItem));
    parts.subsHead.hidden = !state.subscriptions.length;
  }

  function fromPrefs(p) {
    if (!p) return;
    const features = p.features || {};
    state.on = features.orders_on !== false;
    if (Number.isFinite(features.orders_renewal_days)) state.days = features.orders_renewal_days;
    render();
  }

  F.on('hello', (ev) => { fromPrefs(ev.prefs); send({ type: 'orders' }); }, { replay: true });
  F.on('prefs', fromPrefs);
  F.on('orders', (ev) => {
    state.orders = Array.isArray(ev.orders) ? ev.orders : [];
    state.subscriptions = Array.isArray(ev.subscriptions) ? ev.subscriptions : [];
    state.error = ev.error || '';
    if (typeof ev.on === 'boolean') state.on = ev.on;
    render();
  });
})();
