// askeden.com/help (and /help on Eden's server on the Mac): the Help Center as its own page.
// The FAQ works for everyone, signed in or not, so people who can't sign in still get help.
// Ask Help needs a signed-in browser on askeden.com (POST /api/help/ask, free and capped); on
// the Mac it asks Eden's own server (POST /api/chat/help). #<page-id> or #<topic> opens one.

import { helpLang, helpText, mountHelp } from './help-ui.js';
import * as core from './help-core.js';

const root = document.getElementById('help');
// English or French: ?lang=, else the choice made in Eden (localStorage "eden:lang"), else the browser's
const lang = helpLang();
const tr = (text) => helpText(text, lang);
const FR_PAGE = {
  title: 'Aide Eden',
  description: 'L’aide d’Eden sur askeden.com et dans l’app Eden pour iPhone\u00a0: réponses, solutions et tutoriels.',
  sub: 'Aide',
  failed: 'L’Aide n’a pas pu se charger. Rechargez la page, ou écrivez à support@askeden.com.',
  mac: 'Répondu sur ce Mac par un modèle économique, à partir des pages d’aide.',
  signedOut: 'Connectez-vous pour poser votre propre question à l’Aide. Tout l’onglet Rubriques d’aide fonctionne sans connexion, et «\u00a0Contacter l’assistance\u00a0» vous met en relation avec une personne.',
  signInToAsk: 'Se connecter pour demander',
  surfaceMac: 'mon Mac',
};
const say = (key, english) => (lang === 'fr' ? FR_PAGE[key] : english);

/** The page's own words (index.html carries the French in data-fr) and <html lang>. */
function translatePage() {
  if (lang !== 'fr') return;
  document.documentElement.lang = 'fr';
  document.title = FR_PAGE.title;
  document.querySelector('meta[name="description"]')?.setAttribute('content', FR_PAGE.description);
  const sub = document.querySelector('.hp-sub');
  if (sub) sub.textContent = FR_PAGE.sub;
  for (const n of document.querySelectorAll('[data-fr]')) n.textContent = n.dataset.fr;
}
translatePage();
let where = 'unknown'; // 'askeden' (signed in) | 'signed-out' | 'mac'

async function whoAmI() {
  // askeden.com: 'askeden' (signed in) or 'signed-out'; Eden's server on a Mac: 'mac'
  try {
    const r = await fetch('/help/session.json', { cache: 'no-store', credentials: 'same-origin' });
    const j = r.ok ? await r.json() : null;
    if (j && ['askeden', 'signed-out', 'mac'].includes(j.where)) return j.where;
  } catch {
    // below
  }
  return 'signed-out';
}

async function ask(payload, signal) {
  const path = where === 'mac' ? '/api/chat/help' : '/api/help/ask';
  let res;
  try {
    res = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json', 'X-Jarvis-Chat': '1' }, body: JSON.stringify(payload), signal, credentials: 'same-origin' });
  } catch (e) {
    if (e.name === 'AbortError') throw e;
    throw new Error(tr('Can’t reach Help right now. The Help pages still work.'));
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401) where = 'signed-out';
    const err = new Error(tr(data.error || `Help couldn’t answer (${res.status}).`));
    err.status = res.status;
    throw err;
  }
  return data;
}

function askState() {
  const d = core.HELP_DEFAULTS;
  if (where === 'askeden') return { ok: true, note: tr(`Free, up to ${d.messagesPerDay} questions and ${d.screenshotsPerDay} screenshots a day.`) };
  if (where === 'mac') return { ok: true, note: say('mac', 'Answered on this Mac by a low-cost model, from the Help pages.') };
  return { ok: false, reason: say('signedOut', 'Sign in to ask Help your own question. Everything on the Help topics tab works without signing in, and Contact support reaches a person.'), href: '/signin?return=%2Fhelp', label: say('signInToAsk', 'Sign in to ask') };
}

async function start() {
  const faqFile = lang === 'fr' ? '/help/faq.fr.json' : '/help/faq.json';
  const [faq, who] = await Promise.all([fetch(faqFile, { cache: 'no-cache' }).then((r) => r.json()), whoAmI()]);
  where = who;
  if (where === 'askeden' || where === 'mac') {
    document.getElementById('hpOpen').hidden = false;
    document.getElementById('hpSignin').hidden = true;
  }
  const dark = matchMedia('(prefers-color-scheme: dark)');
  const ui = mountHelp(root, {
    faq,
    core,
    lang,
    imgBase: '/help/',
    mode: 'page',
    theme: () => (dark.matches ? 'dark' : 'light'),
    ask,
    askState,
    canRun: () => false,
    run: () => false,
    tour: where === 'askeden' || where === 'mac' ? () => { location.href = '/?tour=1'; } : null,
    surface: where === 'mac' ? say('surfaceMac', 'Help on my Mac') : 'askeden.com/help',
    onNavigate: (v) => {
      const hash = v.name === 'entry' ? `#${v.id}` : v.name === 'cat' ? `#${v.id}` : v.name === 'ask' ? '#ask' : '';
      if (location.hash !== hash) history.replaceState(null, '', `${location.pathname}${location.search}${hash}`);
    },
  });
  const open = () => {
    const id = decodeURIComponent(location.hash.slice(1));
    if (!id) return;
    if (id === 'ask') ui.askView();
    else if (faq.entries.some((e) => e.id === id)) ui.show(id);
    else if (faq.categories.some((c) => c.id === id)) ui.home(), root.querySelectorAll('.hc-cat').forEach((b, i) => { if (faq.categories[i].id === id) b.click(); });
  };
  addEventListener('hashchange', open);
  open();
}

start().catch(() => {
  root.replaceChildren();
  const p = document.createElement('p');
  p.className = 'hp-loading';
  p.textContent = say('failed', 'Help didn’t load. Reload the page, or write to support@askeden.com.');
  root.append(p);
});
