// Hand control of the Mac picks up by itself once Accessibility is switched on: after a
// refusal the backend looks at the permission again for a while (desktop_hands.py) and says
// "allowed" when it's given, so the "Can't steer the Mac" card goes and hand control starts
// again, without the owner turning it back on. Only a session the owner started, though: one
// two claps set off (app.js: handsBlockedFromClaps) was never asked for, so granting the
// permission just clears the card and the camera stays off.
(function (root) {
  'use strict';
  const F = root.jarvisFeatures;
  if (!F) return;
  /* global handsBlockedCard, handsBlockedFromClaps, handsOn, startHandControl, notice */

  F.on('desktop_hands', (ev) => {
    if (!ev || ev.state !== 'allowed') return;
    try {
      if (typeof handsBlockedCard !== 'undefined' && handsBlockedCard && handsBlockedCard.isConnected) handsBlockedCard.remove();
    } catch (_err) { /* the card already went */ }
    if (typeof handsBlockedFromClaps !== 'undefined' && handsBlockedFromClaps) return;
    if (typeof handsOn !== 'undefined' && !handsOn && typeof startHandControl === 'function') startHandControl();
    if (typeof notice === 'function') notice(F.t('Hand control'), '', F.t('Allowed. Hand control of the Mac is on.'), 5000);
  });
})(typeof window !== 'undefined' ? window : globalThis);
