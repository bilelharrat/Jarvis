// The account page (account.js, with Sync's and Team spaces' parts it brings: cloud-sync.js, spaces.js, mail-ask.js,
// about 130 KB) loads when it's needed, not with the page (askeden opt2-ae-web). This small module stands in for it
// under the same names:
//
// - initAccount (after meta): where there are accounts (askeden.com, ?mock=1) account.js loads at once and runs its own
//   initAccount, as before (it starts the sync, says who's acting, the plan offer, #account links); on the Mac's server
//   (no accounts) it does what account.js did there, and nothing loads: its hash and back-forward listeners only act
//   where accounts are;
// - openAccount loads it and opens the page (the tour); accountOpen and closeAccount answer from the page's sheet, which
//   only account.js makes.

import { $ } from './util.js';
import { state, ui } from './state.js';
import { isMock } from './api.js';
import { setActing } from './acting.js';
import { lazyModule } from './lazy-load.js';

const accountMod = lazyModule('./account.js', (m) => m, { what: 'your account' });
/** account.js, loaded once (the tests and the tour wait on it). */
export const loadAccount = () => accountMod();

/** Call once meta has loaded. handlers: { beforeOpen(), closeSettings() } (account.js initAccount). */
export function initAccount(handlers = {}) {
  if (!isMock && !(state.meta && state.meta.hosted)) {
    // the local server: no accounts (what account.js's initAccount does here)
    if (setActing(null)) { ui.renderSidebar(); dispatchEvent(new CustomEvent('eden:acting')); }
    return Promise.resolve();
  }
  return accountMod().then((m) => m.initAccount(handlers), () => {});
}

export const accountOpen = () => !!($('accountSheet') && $('accountSheet').classList.contains('open'));
export function openAccount(opts) { return accountMod().then((m) => m.openAccount(opts)); }
/** False when the page isn't open (then account.js may not be loaded at all). */
export function closeAccount() {
  const m = accountMod.now();
  return accountOpen() && m ? m.closeAccount() : false;
}
