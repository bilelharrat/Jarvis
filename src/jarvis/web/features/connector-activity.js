// Tools & Accounts, for the connectors (jarvis.connector_log): every call Jarvis made in a
// connected account (the service, the tool, when, whether it read or changed something, and
// whether it was done, failed or declined; never what went in or came out), and a note on a
// connection that needs connecting again to be allowed more (Google Calendar's changes).
(() => {
  const F = window.jarvisFeatures;
  if (!F) return;
  const { el, send } = F;

  // ── pure helpers (tests/web/connector-activity.test.mjs runs these) ──

  function kindLabel(kind) {
    return kind === 'read' ? 'Read' : 'Change';
  }

  function outcomeLabel(outcome) {
    if (outcome === 'failed') return 'Failed';
    if (outcome === 'declined') return 'Declined';
    return '';
  }

  // "Sep 30, 9:14 AM" in the window's language (app.js's uiLocale).
  function when(iso) {
    const at = new Date(iso);
    if (Number.isNaN(at.getTime())) return '';
    const locale = typeof uiLocale === 'function' ? uiLocale() : undefined;
    return at.toLocaleString(locale, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  }

  if (typeof window.__connectorActivityTest === 'function') window.__connectorActivityTest({ kindLabel, outcomeLabel, when });

  // ── where it goes: the end of Tools & Accounts ──

  const sheet = document.getElementById('accounts');
  if (!sheet) return;
  const group = el('section', 'group conn-activity');
  const list = el('ul', 'itemlist conn-activity-list');
  const empty = el('p', 'empty', 'Nothing yet.');
  group.append(
    el('h3', '', 'Recent activity'),
    el('p', 'small-status', 'Every call Jarvis makes in your connected accounts: the tool, when, and whether it read or changed something. What was sent and what came back is never kept.'),
    list,
    empty,
  );
  sheet.append(group);
  let asked = false;

  function render(ev) {
    const items = Array.isArray(ev.items) ? ev.items : [];
    empty.hidden = items.length > 0;
    list.replaceChildren(...items.slice(0, 100).map((item) => {
      const li = el('li');
      const fact = el('span', 'fact');
      const what = el('strong', '', `${item.service} · ${item.tool}`);
      what.setAttribute('data-no-i18n', '');
      const detail = el('small');
      const badge = el('span', `conn-kind ${item.kind === 'read' ? 'read' : 'write'}`, kindLabel(item.kind));
      detail.append(badge, ' ', el('span', '', when(item.at)));
      const outcome = outcomeLabel(item.outcome);
      if (outcome) detail.append(' · ', el('span', `conn-outcome ${item.outcome}`, outcome));
      fact.append(what, detail);
      li.append(fact);
      return li;
    }));
  }

  // A connection that must sign in again for what its service can do now: noted on its
  // card, and again whenever the cards are drawn anew (a click on the catalog redraws them).
  const cards = document.getElementById('connections');
  let rescopes = [];
  function noteRescopes() {
    if (!cards) return;
    rescopes.forEach((needed, i) => {
      const card = cards.children[i];
      if (!needed || !card || card.querySelector('.conn-rescope')) return;
      card.append(el('div', 'conn-rescope', 'It can do more now: disconnect it and connect it again to allow it.'));
    });
  }
  if (cards) new MutationObserver(noteRescopes).observe(cards, { childList: true });

  F.on('connector_activity', render, { replay: true });
  F.on('connectors', (ev) => {
    rescopes = (ev.connections || []).map((c) => Boolean(c && c.rescope));
    noteRescopes();
    if (!asked) { asked = true; send({ type: 'connector_activity' }); }
  }, { replay: true });
})();
