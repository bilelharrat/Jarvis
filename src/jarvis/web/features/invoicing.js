// Settings › Invoicing (the backend is jarvis.features.invoicing): payment reminders for
// overdue invoices (a routine the owner switches on here), whether Stripe can make payment
// links, the client list and the recurring invoices. Names, addresses, amounts and dates are
// the owner's data (data-no-i18n); the window's words around them are translated.
(() => {
  const F = window.jarvisFeatures;
  if (!F) return;
  const { el, send } = F;

  const EVERY = { weekly: 'Weekly', monthly: 'Monthly', quarterly: 'Quarterly', yearly: 'Yearly' };
  const state = { reminders: false, stripe: '', clients: [], recurring: [], error: '' };
  const parts = {};

  function mine(node) {
    node.setAttribute('data-no-i18n', '');
    return node;
  }

  function money(amount, currency) {
    if (typeof amount !== 'number' || !Number.isFinite(amount)) return '';
    const symbol = { USD: '$', EUR: '€', GBP: '£', JPY: '¥', CNY: '¥', CAD: 'CA$', AUD: 'A$' }[currency] || '';
    const n = amount.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    return symbol ? `${symbol}${n}` : `${n} ${currency || ''}`.trim();
  }

  function day(iso) {
    const at = new Date(`${iso}T12:00:00`);
    return Number.isNaN(at.getTime()) ? String(iso || '') : at.toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' });
  }

  function button(label, onClick) {
    const b = el('button', 'btn', label);
    b.type = 'button';
    b.addEventListener('click', onClick);
    return b;
  }

  function build() {
    if (parts.section) return parts.section;
    const settings = F.$('settings');
    if (!settings) return null;
    const section = el('section', 'group invoicing-group');
    section.id = 'invoicing-group';
    const row = el('div', 'row');
    const words = el('span');
    words.append(el('strong', '', 'Remind clients of overdue invoices'),
      el('small', '', 'A routine on weekdays at 9: Jarvis looks for overdue invoices and shows you each reminder email before it goes, one a week per invoice at most.'));
    const sw = el('button', 'switch');
    sw.type = 'button';
    sw.id = 'sw-invoice-reminders';
    sw.setAttribute('role', 'switch');
    sw.setAttribute('aria-label', 'Remind clients of overdue invoices');
    sw.addEventListener('click', () => {
      state.reminders = !state.reminders;
      sw.setAttribute('aria-checked', String(state.reminders));
      send({ type: 'invoice_reminders', on: state.reminders });
    });
    row.append(words, sw);
    const stripe = el('p', 'small-status invoicing-stripe');
    stripe.id = 'invoicing-stripe';
    const error = el('p', 'small-status warn-line invoicing-error');
    error.id = 'invoicing-error';
    const clientsHead = el('h4', 'invoicing-subhead', 'Clients');
    const clients = el('ul', 'itemlist invoicing-clients');
    clients.id = 'invoicing-clients';
    const recurringHead = el('h4', 'invoicing-subhead', 'Recurring invoices');
    const recurring = el('ul', 'itemlist invoicing-recurring');
    recurring.id = 'invoicing-recurring';
    section.append(el('h3', '', 'Invoicing'), row, stripe, error, clientsHead, clients, recurringHead, recurring);
    const invoiceFrom = F.$('invoice-from');
    const after = invoiceFrom ? invoiceFrom.closest('section.group') : null;
    if (after && after.nextElementSibling) settings.insertBefore(section, after.nextElementSibling);
    else settings.append(section);
    Object.assign(parts, { section, sw, stripe, error, clientsHead, clients, recurringHead, recurring });
    return section;
  }

  function clientItem(c) {
    const li = el('li', 'invoicing-client');
    const fact = el('span', 'fact');
    fact.append(mine(el('strong', '', c.name)));
    const more = [c.email, c.currency].filter(Boolean).join(' · ');
    if (more) fact.append(mine(el('small', '', more)));
    li.append(fact, button('Remove', () => send({ type: 'invoicing_client_remove', id: c.id })));
    return li;
  }

  function scheduleItem(r) {
    const li = el('li', 'invoicing-schedule');
    const fact = el('span', 'fact');
    fact.append(mine(el('strong', '', r.client)));
    const about = el('small');
    about.append(mine(el('bdi', '', money(r.total, r.currency))), ' · ', el('bdi', '', EVERY[r.every] || r.every),
      ' · ', el('bdi', '', 'next on'), ' ', mine(el('bdi', '', day(r.next))));
    fact.append(about);
    li.append(fact, button('Stop', () => send({ type: 'invoicing_stop', id: r.id })));
    return li;
  }

  function render() {
    if (!build()) return;
    parts.sw.setAttribute('aria-checked', String(!!state.reminders));
    // Why Stripe can't make links (not connected, read-only, missing tools), else that it can.
    parts.stripe.textContent = state.stripe || 'Payment links: Stripe is connected. Ask for one on any invoice.';
    parts.error.textContent = state.error;
    parts.error.hidden = !state.error;
    parts.clients.replaceChildren(...state.clients.map(clientItem));
    parts.clientsHead.hidden = !state.clients.length;
    parts.recurring.replaceChildren(...state.recurring.map(scheduleItem));
    parts.recurringHead.hidden = !state.recurring.length;
  }

  F.on('hello', () => send({ type: 'invoicing' }), { replay: true });
  F.on('routines', () => send({ type: 'invoicing' }));  // the reminders routine may have gone
  F.on('invoicing', (ev) => {
    Object.assign(state, {
      reminders: !!ev.reminders,
      stripe: typeof ev.stripe === 'string' ? ev.stripe : '',
      clients: Array.isArray(ev.clients) ? ev.clients : [],
      recurring: Array.isArray(ev.recurring) ? ev.recurring : [],
      error: ev.error || '',
    });
    render();
  });
})();
