// Eden Plus in the page (askeden.com; ?mock=1): for a free account where Plus can be bought here
// (plan-model.js), an "Upgrade" pill in the title bar beside the usage ring, a "Get Eden Plus"
// row in the ring's popover and the ⌘K palette, and "Get Plus" on a reply refused because the
// included AI ran out. With Plus: a "Plus" badge and "Manage billing" in the popover. Each opens
// the account page at its Plan (account.js listens for eden:get-plus / eden:manage-billing);
// nothing here goes to Stripe by itself. account.js calls setPlanOffer once it knows the account.

import { $, el, ico } from './util.js';
import { IN_APP } from './native.js';
import { planOffer, isLimitError } from './plan-model.js';

let offer = null;

export const currentOffer = () => offer;
export const getPlus = () => dispatchEvent(new CustomEvent('eden:get-plus'));
export const manageBilling = () => dispatchEvent(new CustomEvent('eden:manage-billing'));
export const addCredits = () => dispatchEvent(new CustomEvent('eden:add-credits'));
const usd = (n) => `$${(Number(n) || 0).toFixed(2)}`;

export function setPlanOffer(account, config) {
  offer = planOffer(account, config, IN_APP);
  drawPill();
  dispatchEvent(new CustomEvent('eden:plan'));
}

function drawPill() {
  const ring = $('tbCtx');
  if (!ring) return;
  let pill = $('tbPlus');
  if (!offer || !offer.upgrade) { if (pill) pill.remove(); return; }
  if (pill) return;
  pill = el('button', { type: 'button', id: 'tbPlus', class: 'tb-plus', title: `Get Eden Plus${offer.price ? `: $${offer.price}/month` : ''}`, 'aria-label': 'Upgrade to Eden Plus', onclick: getPlus },
    ico('spark'), el('span', 'tbu-l', 'Upgrade'));
  ring.after(pill);
}

/** The usage ring popover's plan rows; `close` closes the popover first. */
export function planRows(close = () => {}) {
  if (!offer || (!offer.plus && !offer.upgrade && !offer.credits && !(offer.balance > 0))) return [];
  const head = el('div', 'cp-t ap-t2', 'Plan');
  // Credits: the balance (spent after the included AI), and "Add credits" where packs are sold.
  const credits = offer.credits || offer.balance > 0 ? [
    el('div', 'ap-row', el('span', '', 'Credits'), el('b', '', usd(offer.balance))),
    offer.credits ? el('button', { type: 'button', class: 'cp-link plan-manage', onclick: () => { close(); addCredits(); } }, 'Add credits →') : null,
  ] : [];
  if (offer.plus) {
    return [head, el('div', 'ap-row', el('span', '', 'Eden Plus'), el('span', 'plan-badge', 'Plus')),
      offer.portal ? el('button', { type: 'button', class: 'cp-link plan-manage', onclick: () => { close(); manageBilling(); } }, 'Manage billing →') : null, ...credits].filter(Boolean);
  }
  return [head, el('div', 'ap-row', el('span', '', 'Free'), el('b', '', offer.price ? `Plus $${offer.price}/month` : 'Plus')),
    offer.upgrade ? el('button', { type: 'button', class: 'plan-up', onclick: () => { close(); getPlus(); } }, ico('spark'), 'Get Eden Plus') : null, ...credits].filter(Boolean);
}

/** The ⌘K palette's entry, or null. */
export function planCommand() {
  if (offer && offer.upgrade) return { t: 'Get Eden Plus', s: offer.price ? `$${offer.price}/month · more included AI` : 'More included AI', i: 'spark', run: getPlus };
  if (offer && offer.portal) return { t: 'Manage billing', s: 'Eden Plus', i: 'gear', run: manageBilling };
  return null;
}

/** "Get Plus" (or, with Plus, "Add credits") under an error that says the included AI ran out, or null. */
export function limitAction(message) {
  if (!offer || !isLimitError(message)) return null;
  if (offer.upgrade) return el('button', { type: 'button', class: 'cap primary', onclick: getPlus }, ico('spark'), 'Get Plus');
  if (offer.credits) return el('button', { type: 'button', class: 'cap primary', onclick: addCredits }, ico('spark'), 'Add credits');
  return null;
}
