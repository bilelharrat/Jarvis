// The first minute (ROADMAP Q4): a small glass card under a new person's first answer that explains it with that
// turn's real numbers (the model the router picked and why, its cost against the most expensive model, the label
// under the reply), three starter prompts, and a link to the try-it tour (I1). Dismissed with ×, never shown again.
// The words and rules are in first-run-model.js (tested); this file only draws and stores.

import { el, store } from './util.js';
import { state, ui } from './state.js';
import { FIRST_KEY, STARTERS, claim, explain, isNewUser, showsFor } from './first-run-model.js';

let H = { setComposerText: () => {}, startTour: () => {} };
const practice = () => document.documentElement.classList.contains('eden-practice'); // the tour's sandbox: not the real first answer

function dismiss(c, node) {
  store.set(FIRST_KEY, { ...(store.get(FIRST_KEY, {}) || {}), dismissed: true });
  ui.updateMessage(c, node); // not `final`: that would notify the Mac of the turn again
}

function card(c, node) {
  const x = explain(node);
  const row = (title, text) => el('div', 'fr-row', el('b', '', title), el('p', '', text));
  const rows = [row(x.model, x.why)];
  if (x.cost) rows.push(row('What it cost', x.cost));
  rows.push(row(x.label.has ? `The label: “${x.label.text}”` : 'The label under replies', x.label.meaning));
  return el('section', { class: 'fr-card glass', role: 'note', 'aria-label': 'What Eden just did' },
    el('div', 'fr-head',
      el('span', 'fr-kicker', 'Your first answer'),
      el('h3', '', 'What Eden just did'),
      el('button', { type: 'button', class: 'iconbtn fr-x', 'aria-label': 'Dismiss', title: 'Dismiss', onclick: () => dismiss(c, node) }, '×')),
    ...rows,
    el('div', 'fr-try',
      el('b', '', 'Try one of these next'),
      el('div', 'fr-starters', ...STARTERS.map((s) => el('button', { type: 'button', class: `fr-starter ${s.kind}`, title: s.why, onclick: () => H.setComposerText(s.text) },
        el('span', 'fr-st-t', s.title), el('span', 'fr-st-x', s.text))))),
    el('div', 'fr-foot',
      el('span', '', 'Want to see everything Eden does?'),
      el('button', { type: 'button', class: 'fr-link', onclick: () => H.startTour() }, 'Take the try-it tour'),
      el('button', { type: 'button', class: 'fr-link quiet', onclick: () => dismiss(c, node) }, 'Got it')));
}

/** Puts the card under the reply it belongs to (app.js calls this for every message it draws). */
export function decorateFirstRun(m, c, node) {
  if (practice() || !showsFor(store.get(FIRST_KEY, null), c, node)) return m;
  const after = m.querySelector(':scope > .vf') || m.querySelector(':scope > .bubble');
  const box = card(c, node);
  if (after) after.after(box); else m.append(box);
  return m;
}

let started = false;
/** Once, from app.js: the handlers, and the first finished reply claims the card. */
export function initFirstRun(handlers = {}) {
  H = { ...H, ...handlers };
  if (started) return;
  started = true;
  addEventListener('eden:turn-done', (e) => {
    const { c, node } = e.detail || {};
    if (!c || !node) return;
    const rec = claim(store.get(FIRST_KEY, null), { isNew: isNewUser(state.convs.includes(c) ? state.convs : [...state.convs, c], node.id), conv: c, node, practice: practice(), temp: !!c.temp });
    if (!rec) return;
    store.set(FIRST_KEY, rec);
    if (!rec.skip) ui.updateMessage(c, node);
  });
  // The label comes after `done` (the checks after a reply); chat.js redraws the reply then, and the card with it.
}
