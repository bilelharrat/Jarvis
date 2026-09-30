// What only the owner's own install shows (features/newuser.py): the BSH research desk's
// switch and the "How's the portfolio?" chip go when this Mac has no desk, and Markets opens
// a Research Center only when one is set (Settings › Markets; a new install has none).
(() => {
  const F = window.jarvisFeatures;
  if (!F) return;
  const $ = F.$;

  // Markets: a button that opens the Research Center, or, with none set, only the markets.
  function markets(p) {
    const panel = $('p-markets');
    if (!panel) return;
    const has = Boolean(p && p.research_url);
    panel.classList.toggle('no-research', !has);
    if (has) {
      panel.setAttribute('role', 'button');
      panel.tabIndex = 0;
      panel.setAttribute('aria-label', 'Markets — open the BSH Research Center');
      panel.title = 'Open the BSH Research Center';
    } else {
      panel.removeAttribute('role');
      panel.removeAttribute('tabindex');
      panel.setAttribute('aria-label', 'Markets');
      panel.removeAttribute('title');
    }
    const open = $('br-research');
    if (open) open.classList.toggle('no-research', !has);
  }

  function desk(ev) {
    const has = Boolean(ev && ev.bsh_desk);
    const row = $('sw-bsh') && $('sw-bsh').closest('.row');
    if (row) row.hidden = !has;
    const chip = document.querySelector('.chips .chip[data-ask^="How\'s the BSH portfolio"]');
    if (chip) chip.hidden = !has;
  }

  F.on('hello', (ev) => { markets(ev.prefs); F.send({ type: 'newuser_state' }); }, { replay: true });
  F.on('prefs', markets, { replay: true });
  F.on('newuser', desk, { replay: true });
})();
