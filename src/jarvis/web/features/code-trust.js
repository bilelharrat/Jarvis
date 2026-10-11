// Trusting a project folder before its own Claude Code settings run (features/code_trust.py):
// a session in a folder whose settings would run commands (hooks, helpers, .mcp.json
// servers), let steps by unasked or change its environment gets a card listing them, and
// starts with the owner's own settings alone until "Trust this folder". Only from this
// window: the phone can't trust a folder.
(function (root) {
  'use strict';

  // A card's settled state, as it reads.
  function stateText(trusted) {
    return trusted ? 'Trusted: its sessions load this folder’s settings.' : '';
  }

  const api = { stateText };
  if (typeof module === 'object' && module.exports) { module.exports = api; return; }

  const F = root.jarvisFeatures;
  if (!F || !F.registerEntry) return;
  const { el, t } = F;
  const mine = (node) => { node.setAttribute('data-no-i18n', ''); return node; };
  const cards = new Set();  // the cards on show, each { li, project }

  function settle(card, trusted) {
    const { li } = card;
    if (!trusted || li.classList.contains('trusted')) return;
    li.classList.add('trusted');
    const actions = li.querySelector('.ct-buttons');
    if (actions) actions.replaceWith(el('div', 'ct-state', stateText(true)));
  }

  function trustEntry(e) {
    const li = el('li', `ct-card ${e.state || ''}`);
    const head = el('div', 'ct-head');
    head.append(el('strong', '', e.again ? 'This folder’s settings changed' : 'Trust this folder?'), mine(el('code', 'ct-name', e.name || '')));
    li.append(head, el('p', 'ct-why', 'Its own Claude Code settings would run these on your Mac, or let steps run without asking. Until you trust it, this session uses only your own settings (not the folder’s CLAUDE.md either).'));
    const list = el('ul', 'ct-items');
    for (const item of (e.items || []).slice(0, 60)) list.append(mine(el('li', '', item)));
    li.append(list);
    const buttons = el('div', 'ct-buttons');
    const yes = el('button', 'jc-mini ct-yes', 'Trust this folder');
    yes.type = 'button';
    yes.addEventListener('click', () => {
      const task = F.currentTask();
      if (!task) return;
      yes.disabled = true;
      F.send({ type: 'ct_trust', id: task.id });
    });
    buttons.append(yes, el('small', 'ct-note', 'Only if you know where this folder came from.'));
    li.append(buttons);
    const card = { li, project: e.project || '' };
    cards.add(card);
    return li;
  }
  F.registerEntry('trust', trustEntry);

  F.on('ct_state', (ev) => {
    for (const card of [...cards]) {
      if (!card.li.isConnected) { cards.delete(card); continue; }
      if (card.project === ev.project) settle(card, ev.trusted);
    }
  });
})(typeof window === 'object' ? window : globalThis);
