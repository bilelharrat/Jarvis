// Widgets Jarvis makes (the backend is jarvis.features.widgets): each on a card, and the ones
// pinned on the dashboard.
//
// A widget is untrusted: it's shown only in an iframe with sandbox (never allow-same-origin,
// scripts only when it asked for them), from its own address, with no referrer, so it can't
// reach this window, its storage, its token or the socket. Nothing here listens to messages
// from it. Titles are shown as data.
(() => {
  const F = window.jarvisFeatures;
  if (!F) return;
  const { el, send } = F;

  let pinned = [];
  const cards = new Map(); // widget id -> its card

  function mine(node) {
    node.setAttribute('data-no-i18n', '');
    return node;
  }

  function button(label, onClick, cls = 'btn') {
    const b = el('button', cls, label);
    b.type = 'button';
    b.addEventListener('click', onClick);
    return b;
  }

  function frame(widget) {
    const f = document.createElement('iframe');
    f.className = 'wg-frame';
    f.setAttribute('sandbox', widget.scripts ? 'allow-scripts' : '');
    f.setAttribute('referrerpolicy', 'no-referrer');
    f.setAttribute('loading', 'lazy');
    f.title = String(widget.title || '');
    f.height = String(Math.max(80, Math.min(640, Number(widget.height) || 220)));
    // Only its own address on this window's server: never an outside one.
    if (/^\/f\/widgets\/[A-Za-z0-9_-]{16,40}$/.test(String(widget.url || ''))) f.src = widget.url;
    return f;
  }

  function tidy() {
    if (typeof syncDismissAll === 'function') syncDismissAll();
  }

  // ── a widget on a card ──

  function showWidget(w) {
    const old = cards.get(w.id);
    if (old) old.remove();
    for (const [id, card] of cards) if (!card.isConnected) cards.delete(id);  // dismissed ones
    const card = el('div', 'card plain wg-card');
    card.dataset.widget = w.id;
    card.append(el('div', 'card-kicker', 'Widget'), mine(el('div', 'card-title', w.title)), frame(w));
    const actions = el('div', 'card-actions');
    const pin = button(w.pinned ? 'Pinned' : 'Pin to dashboard', () => { send({ type: 'widget_pin', id: w.id }); pin.textContent = F.t('Pinned'); pin.disabled = true; }, 'btn primary');
    pin.disabled = !!w.pinned;
    actions.append(pin, button('Dismiss', () => { card.remove(); cards.delete(w.id); tidy(); }));
    card.append(actions);
    F.$('cards').append(card);
    cards.set(w.id, card);
    tidy();
  }

  // ── the dashboard ──

  function panel() {
    let section = F.$('p-widgets');
    if (section) return section;
    const side = document.querySelector('.side.left');
    if (!side) return null;
    section = el('section', 'panel wg-panel');
    section.id = 'p-widgets';
    section.hidden = true;
    const list = el('div', 'wg-list');
    list.id = 'wg-list';
    section.append(el('h2', '', 'Widgets'), list);
    const markets = F.$('p-markets');
    if (markets) markets.after(section); else side.append(section);
    return section;
  }

  function renderPinned() {
    const section = panel();
    if (!section) return;
    const list = F.$('wg-list');
    const keep = new Map([...list.children].map((n) => [n.dataset.widget, n]));
    const items = pinned.map((w) => {
      const known = keep.get(w.id);
      if (known && known.dataset.height === String(w.height)) return known;  // left as it is: no reload
      const item = el('div', 'wg-item');
      item.dataset.widget = w.id;
      item.dataset.height = String(w.height);
      const head = el('div', 'wg-head');
      const remove = button('×', () => send({ type: 'widget_remove', id: w.id }), 'icon-btn wg-remove');
      remove.setAttribute('aria-label', F.t('Take this widget off the dashboard'));
      remove.title = F.t('Take this widget off the dashboard');
      head.append(mine(el('span', 'wg-title', w.title)), remove);
      item.append(head, frame(w));
      return item;
    });
    list.replaceChildren(...items);
    section.hidden = !pinned.length;
    // Each card's button says where its widget is now (a pin refused, one taken off).
    const on = new Set(pinned.map((w) => w.id));
    for (const [id, card] of cards) {
      const pin = card.querySelector('.card-actions .btn.primary');
      if (!pin) continue;
      pin.textContent = F.t(on.has(id) ? 'Pinned' : 'Pin to dashboard');
      pin.disabled = on.has(id);
    }
  }

  F.on('hello', () => { panel(); send({ type: 'widgets_state' }); }, { replay: true });
  F.on('widget', showWidget);
  F.on('widgets', (ev) => {
    pinned = ev.pinned || [];
    renderPinned();
    if (ev.error && typeof notice === 'function') notice('Widgets', '', ev.error, 8000);
  });
})();
