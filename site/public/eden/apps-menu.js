// The Eden apps, from Eden's mark in the sidebar's foot: a click (or Enter/Space) opens a small
// card above it with the other apps in the portfolio and where to get them. Eden Code (the coding
// app, Eden's outline mark) comes first, then J.A.R.V.I.S. (the voice assistant, its blue orb).
// Eden for Education is its own app: askeden.com/edu (edu-app.js), and Eden Edu on the iPhone.
// Eden Messenger is left out for now. The downloads are askeden.com's, from Eden on the Mac too.
import { el } from './util.js';
import { state } from './state.js';

const SITE = 'https://askeden.com';
const APPS = [
  { id: 'eden-code', name: 'Eden Code', blurb: 'A coding agent for your projects: plans, edits, runs and explains.', href: `${SITE}/eden-code/download`, cta: 'Download for Mac' },
  { id: 'jarvis', name: 'J.A.R.V.I.S.', blurb: 'Your Mac by voice. Comes with Eden Code.', href: `${SITE}/jarvis/download`, cta: 'Download for Mac' },
  { id: 'edu', name: 'Eden for Education', blurb: 'Study from your professor’s slides and readings, with every answer checked against them.', href: `${SITE}/edu`, cta: 'Open the app' }, // its own app (askeden.com/edu, edu.askeden.com, the Eden Edu iPhone app)
];

let pop = null;
let mark = null;

function close({ focus = false } = {}) {
  if (!pop) return;
  pop.remove();
  pop = null;
  mark.setAttribute('aria-expanded', 'false');
  document.removeEventListener('pointerdown', outside, true);
  document.removeEventListener('keydown', onKey, true);
  if (focus) mark.focus();
}

function outside(e) {
  if (pop && !pop.contains(e.target) && !mark.contains(e.target)) close();
}

function onKey(e) {
  if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close({ focus: true }); }
}

function open() {
  pop = el('div', { class: 'apps-pop glass', id: 'appsPop', role: 'dialog', 'aria-label': 'Eden apps' });
  const head = el('div', 'apps-head');
  head.append(el('div', { class: 'orb', 'aria-hidden': 'true' }), el('div', 'apps-head-txt',
    el('b', { text: 'Eden' }), el('span', { text: 'You’re here' })));
  const list = el('ul', 'apps-list');
  for (const app of APPS) {
    // on askeden.com, an app that lives here opens in the page (app.js handles eden:open-space)
    const here = app.here && state.meta && state.meta.hosted;
    const a = here
      ? el('a', { class: 'apps-item', href: '#', onclick: (e) => { e.preventDefault(); close(); dispatchEvent(new CustomEvent('eden:open-space', { detail: { key: app.here } })); } })
      : el('a', { class: 'apps-item', href: app.href, target: '_blank', rel: 'noopener' });
    a.append(el('span', { class: `apps-icon ${app.id}`, 'aria-hidden': 'true' }),
      el('span', 'apps-txt', el('b', { text: app.name }), el('span', { text: app.blurb })),
      el('span', { class: 'apps-cta', text: here ? app.hereCta : app.cta }));
    list.append(el('li', null, a));
  }
  const more = el('a', { class: 'apps-more', href: `${SITE}/download`, target: '_blank', rel: 'noopener', text: 'All Eden apps' });
  pop.append(head, el('div', { class: 'apps-sec', text: 'More from Eden' }), list, more);
  document.body.append(pop);
  const r = mark.getBoundingClientRect();
  pop.style.left = `${Math.max(8, r.left - 4)}px`;
  pop.style.bottom = `${Math.max(8, window.innerHeight - r.top + 8)}px`;
  mark.setAttribute('aria-expanded', 'true');
  document.addEventListener('pointerdown', outside, true);
  document.addEventListener('keydown', onKey, true);
  pop.querySelector('a')?.focus();
}

export function initAppsMenu() {
  mark = document.querySelector('#sidebar .side-foot .orb');
  if (!mark || mark.dataset.apps) return;
  mark.dataset.apps = '1';
  mark.removeAttribute('aria-hidden');
  mark.setAttribute('role', 'button');
  mark.tabIndex = 0;
  mark.title = 'Eden apps';
  mark.setAttribute('aria-label', 'Eden apps');
  mark.setAttribute('aria-haspopup', 'dialog');
  mark.setAttribute('aria-expanded', 'false');
  mark.classList.add('apps-mark');
  const toggle = () => (pop ? close() : open());
  mark.addEventListener('click', toggle);
  mark.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); }
  });
  window.addEventListener('resize', () => close());
}

// Module scripts run once the page is parsed: the sidebar's foot is there.
initAppsMenu();
