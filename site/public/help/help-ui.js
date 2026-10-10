// The Help Center's interface, shared by Eden's Help panel (web/chat/help.js) and the public
// page (web/help/page.js): search, topics, illustrated answers with "Was this helpful?", and
// Ask Help, a small chat answered from these pages that can look at a screenshot.
//
// No inline styles and no HTML strings (the public page's CSP is style-src 'self'): every node
// is built with h() and styled by web/help/help.css. The host passes what differs:
//
//   mountHelp(root, {
//     faq, core,             web/help/faq.json and help-core.js
//     imgBase,               where img/… lives ('/help/')
//     mode,                  'panel' (inside Eden) | 'page' (askeden.com/help)
//     theme(),               'light' | 'dark': which picture variant to show
//     ask(payload, signal),  → { text, cited, notSure, pages, left }   (throws Error with .status)
//     askState(),            → { ok: true, note } | { ok: false, reason, href, label }
//     canRun(open), run(open)  an answer's "open the feature" button, when the host can
//     tour(chapter)          the try-it tour at that chapter, or null
//     surface                'Eden on the web', 'Eden on your Mac', 'askeden.com/help' (for the support email)
//     lang                   'en' | 'fr' (default helpLang(): the same choice as web/chat/i18n.js);
//                            pass faq.fr.json as `faq` for French pages. Ask Help sends it as `lang`.
//   }) → { show(id), home(), askView(text), search(q), focus() }

import { cleanScreenshot } from './help-image.js';

const VOTES = 'eden:help:votes';
const CHAT = 'eden:help:chat'; // the Help chat: this tab only, never the person's conversations

/**
 * 'en' | 'fr', the same rule as web/chat/i18n.js (which the public page can't import): ?lang=
 * wins, then localStorage "eden:lang" ('en' | 'fr'), else the browser's languages.
 */
export function helpLang() {
  try { const q = new URLSearchParams(globalThis.location ? location.search : '').get('lang'); if (q === 'fr' || q === 'en') return q; } catch { /* none */ }
  try { const v = globalThis.localStorage && localStorage.getItem('eden:lang'); if (v === 'en' || v === 'fr') return v; } catch { /* private mode */ }
  const nav = globalThis.navigator;
  const list = nav ? (nav.languages && nav.languages.length ? nav.languages : [nav.language]) : [];
  for (const l of list) {
    const p = String(l || '').toLowerCase().slice(0, 2);
    if (p === 'fr' || p === 'en') return p;
  }
  return 'en';
}

const NB = '\u00a0';
// The Help interface's own words in French (the FAQ itself is faq.fr.json). Keys: the English as written here.
const FR = {
  'Search Help': 'Rechercher dans l’Aide',
  'Help topics': 'Rubriques d’aide',
  'Ask Help': 'Demander à l’Aide',
  Help: 'Aide',
  Popular: 'Populaires',
  Topics: 'Rubriques',
  'All topics': 'Toutes les rubriques',
  Topic: 'Rubrique',
  'No results': 'Aucun résultat',
  'Try other words, or ask Help in your own words.': 'Essayez d’autres mots, ou posez votre question à l’Aide avec vos propres mots.',
  'Read more': 'En savoir plus',
  Open: 'Ouvrir',
  'Try it': 'Essayer',
  'Try it in the tour': 'Essayer dans la visite guidée',
  'Thanks for telling us.': 'Merci de nous l’avoir dit.',
  'Sorry it didn’t help.': 'Désolé que cette page ne vous ait pas aidé.',
  'Ask Help instead': 'Demander plutôt à l’Aide',
  'Was this helpful?': `Cette page vous a-t-elle aidé${NB}?`,
  Yes: 'Oui',
  No: 'Non',
  Thanks: 'Merci',
  Related: 'Voir aussi',
  'Still stuck?': `Le problème persiste${NB}?`,
  'Ask about Eden, or paste a screenshot of the problem': 'Posez une question sur Eden, ou collez une capture d’écran du problème',
  'Send to Help': 'Envoyer à l’Aide',
  'Attach a screenshot': 'Joindre une capture d’écran',
  'Help conversation': 'Discussion avec l’Aide',
  'Contact support': 'Contacter l’assistance',
  Clear: 'Effacer',
  'Screenshot to send': 'Capture d’écran à envoyer',
  'Screenshot ready': 'Capture d’écran prête',
  'Remove the screenshot': 'Retirer la capture d’écran',
  'That picture couldn’t be read.': 'Impossible de lire cette image.',
  'From Help:': `D’après l’Aide${NB}:`,
  'Screenshot attached': 'Capture d’écran jointe',
  'Take the tour': 'Faire la visite guidée',
  'Browse topics': 'Parcourir les rubriques',
  'Ask anything about Eden.': 'Posez n’importe quelle question sur Eden.',
  'Answers come from the Help pages, with links to them. It can also look at a screenshot of a problem.': 'Les réponses viennent des pages d’aide, avec un lien vers chacune. L’Aide peut aussi regarder une capture d’écran d’un problème.',
  'Separate from your chats: nothing here goes into your history or uses your allowance.': `À part de vos discussions${NB}: rien ici n’entre dans votre historique ni ne consomme votre quota.`,
  'Sign in': 'Se connecter',
  'Help is looking…': 'L’Aide cherche…',
  'Help couldn’t answer just now. Try again.': 'L’Aide n’a pas pu répondre pour l’instant. Réessayez.',
  // help-image.js
  'That isn’t a picture. Attach a screenshot (PNG or JPEG).': 'Ce n’est pas une image. Joignez une capture d’écran (PNG ou JPEG).',
  'That picture is too big. Take a smaller screenshot, or crop it.': 'Cette image est trop grande. Faites une capture plus petite, ou recadrez-la.',
  'That screenshot is too big even when shrunk. Crop it to the part that matters.': 'Cette capture reste trop grande même réduite. Recadrez-la sur la partie utile.',
  'That picture couldn’t be cleaned. Take a new screenshot.': 'Impossible de nettoyer cette image. Faites une nouvelle capture d’écran.',
  // the servers' Ask Help errors (site/src/eden/help.js, src/chat/help.ts, help-core.js parseHelpBody)
  'Can’t reach Help right now. The Help pages still work.': 'Impossible de joindre l’Aide pour le moment. Les pages d’aide fonctionnent toujours.',
  'Sign in to ask Help. The Help pages work without signing in.': 'Connectez-vous pour poser une question à l’Aide. Les pages d’aide fonctionnent sans connexion.',
  'Help’s chat isn’t set up here yet. The Help pages above still work.': 'La discussion avec l’Aide n’est pas encore disponible ici. Les pages d’aide ci-dessus fonctionnent toujours.',
  'Help’s chat is resting for today. The Help pages still work, and Contact support reaches a person.': 'La discussion avec l’Aide fait une pause pour aujourd’hui. Les pages d’aide fonctionnent toujours, et «\u00a0Contacter l’assistance\u00a0» vous met en relation avec une personne.',
  'Help had a problem on the server. Try again, or write to support@askeden.com.': 'L’Aide a rencontré un problème sur le serveur. Réessayez, ou écrivez à support@askeden.com.',
  'That screenshot is too big (5 MB at most). Crop it, or send a smaller one.': 'Cette capture est trop grande (5 Mo au maximum). Recadrez-la, ou envoyez-en une plus petite.',
  'That screenshot isn’t a picture Help can read (PNG, JPEG or WebP).': 'L’Aide ne peut pas lire cette capture (PNG, JPEG ou WebP).',
  'Ask a question, or attach a screenshot.': 'Posez une question, ou joignez une capture d’écran.',
};
const FR_PATTERNS = [
  [/^(\d+) results$/, (m, n) => `${n} résultat${n === '1' ? '' : 's'}`],
  [/^Nothing in Help matches “(.*)”\.$/s, (m, q) => `Rien dans l’Aide ne correspond à «${NB}${q}${NB}».`],
  [/^(\d+)×(\d+), location and camera details removed$/, (m, w, hh) => `${w}×${hh}, localisation et détails de l’appareil photo supprimés`],
  [/^(\d+) Help questions? left today\.$/, (m, n) => `Il vous reste ${n} question${n === '1' ? '' : 's'} à l’Aide aujourd’hui.`],
  [/^Help couldn’t answer \((\d+)\)\.$/, (m, n) => `L’Aide n’a pas pu répondre (${n}).`],
  [/^Free, up to (\d+) questions and (\d+) screenshots a day\.$/, (m, a, b) => `Gratuit, jusqu’à ${a}${NB}questions et ${b}${NB}captures d’écran par jour.`],
  [/^That’s today’s (\d+) Help questions\. They start again at midnight UTC\. The Help pages and Contact support still work\.$/, (m, n) => `Vous avez posé vos ${n}${NB}questions à l’Aide pour aujourd’hui. Le compteur repart à minuit UTC. Les pages d’aide et «${NB}Contacter l’assistance${NB}» fonctionnent toujours.`],
  [/^That’s today’s (\d+) screenshots for Help\. Describe the problem in words instead, or try again tomorrow\.$/, (m, n) => `Vous avez envoyé vos ${n}${NB}captures d’écran à l’Aide pour aujourd’hui. Décrivez plutôt le problème avec des mots, ou réessayez demain.`],
];

/** The Help interface's English text in `lang` ('fr' has its own; anything unknown stays as written). */
export function helpText(text, lang = helpLang()) {
  if (lang !== 'fr' || typeof text !== 'string') return text;
  if (Object.hasOwn(FR, text)) return FR[text];
  for (const [re, to] of FR_PATTERNS) if (re.test(text)) return text.replace(re, to);
  return text;
}

function h(tag, attrs, ...kids) {
  const n = document.createElement(tag);
  if (typeof attrs === 'string') n.className = attrs;
  else if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v === null || v === undefined || v === false) continue;
      if (k === 'class') n.className = v;
      else if (k.startsWith('on') && typeof v === 'function') n.addEventListener(k.slice(2), v);
      else if (v === true) n.setAttribute(k, '');
      else n.setAttribute(k, String(v));
    }
  }
  for (const k of kids.flat()) if (k !== null && k !== undefined && k !== false) n.append(k.nodeType ? k : String(k));
  return n;
}

const ICONS = {
  search: 'M10.5 4a6.5 6.5 0 104.1 11.5l4.2 4.2 1.2-1.2-4.2-4.2A6.5 6.5 0 0010.5 4zm0 1.7a4.8 4.8 0 110 9.6 4.8 4.8 0 010-9.6z',
  back: 'M14.7 5.3l1.2 1.2L10.4 12l5.5 5.5-1.2 1.2L8 12z',
  chev: 'M9.3 5.3L8.1 6.5l5.5 5.5-5.5 5.5 1.2 1.2L16 12z',
  clip: 'M16.5 6.5v8a4.5 4.5 0 01-9 0V6a3 3 0 016 0v8a1.5 1.5 0 01-3 0V7h-1.5v7a3 3 0 006 0V6a4.5 4.5 0 00-9 0v8.5a6 6 0 0012 0v-8z',
  send: 'M12 4l6 6-1.3 1.3-3.8-3.8V20h-1.8V7.5l-3.8 3.8L6 10z',
  x: 'M6.4 5.2L12 10.8l5.6-5.6 1.2 1.2-5.6 5.6 5.6 5.6-1.2 1.2-5.6-5.6-5.6 5.6-1.2-1.2 5.6-5.6-5.6-5.6z',
  mail: 'M4 6h16a1 1 0 011 1v10a1 1 0 01-1 1H4a1 1 0 01-1-1V7a1 1 0 011-1zm.8 1.6v.3l7.2 4.7 7.2-4.7v-.3zm14.4 2.2L12 14.4 4.8 9.8V16.4h14.4z',
  spark: 'M12 3l1.9 5.4L19.5 10l-5.6 1.9L12 17.5l-1.9-5.6L4.5 10l5.6-1.6z',
};
function icon(name) {
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  s.setAttribute('viewBox', '0 0 24 24');
  s.setAttribute('aria-hidden', 'true');
  s.setAttribute('class', 'hc-ic');
  const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  p.setAttribute('d', ICONS[name] || ICONS.spark);
  s.append(p);
  return s;
}

const safeHref = (u) => (/^(https:\/\/|mailto:|\/(?!\/))/i.test(u) ? u : null);

/** The FAQ's markdown-lite as nodes: paragraphs, "- " lists, **bold**, `code`, [text](url), [#page] citations. */
export function renderText(md, { cite } = {}) {
  const frag = document.createDocumentFragment();
  const inline = (text) => {
    const out = [];
    const re = /\*\*([^*]+)\*\*|`([^`]+)`|\[#([a-z0-9-]+)\]|\[([^\]]+)\]\(([^)\s]+)\)|(https:\/\/askeden\.com\/[\w/#?=.-]*|askeden\.com\/[\w/#?=.…-]*|support@askeden\.com)/g;
    let at = 0;
    let m;
    while ((m = re.exec(text))) {
      if (m.index > at) out.push(text.slice(at, m.index));
      if (m[1]) out.push(h('strong', null, m[1]));
      else if (m[2]) out.push(h('code', null, m[2]));
      else if (m[3]) out.push(cite ? cite(m[3]) : '');
      else if (m[4]) {
        const href = safeHref(m[5]);
        out.push(href ? h('a', { href, target: href.startsWith('/') ? null : '_blank', rel: 'noopener' }, m[4]) : m[4]);
      } else if (m[6]) {
        const raw = m[6];
        const href = raw.includes('@') ? `mailto:${raw}` : raw.startsWith('https://') ? raw : /…$/.test(raw) ? null : `https://${raw}`;
        out.push(href ? h('a', { href, target: '_blank', rel: 'noopener' }, raw) : raw);
      }
      at = re.lastIndex;
    }
    if (at < text.length) out.push(text.slice(at));
    return out;
  };
  const ITEM = /^\s*(?:[-*•]|\d+[.)])\s+/;
  const list = (lines) => {
    const items = lines.filter((l) => l.trim());
    return h(/^\s*\d/.test(items[0] || '') ? 'ol' : 'ul', null, items.map((l) => h('li', null, inline(l.replace(ITEM, '')))));
  };
  for (const block of String(md || '').split(/\n{2,}/)) {
    const lines = block.split('\n');
    const at = lines.findIndex((l) => ITEM.test(l));
    if (at < 0) { frag.append(h('p', null, inline(lines.join(' ')))); continue; }
    if (at > 0) frag.append(h('p', null, inline(lines.slice(0, at).join(' '))));
    frag.append(list(lines.slice(at)));
  }
  return frag;
}

function readJson(store, key, fallback) {
  try {
    const v = JSON.parse(store.getItem(key) || 'null');
    return v ?? fallback;
  } catch {
    return fallback;
  }
}
function writeJson(store, key, value) {
  try { store.setItem(key, JSON.stringify(value)); } catch { /* private mode: kept for this view only */ }
}
const local = () => { try { return window.localStorage; } catch { return null; } };
const session = () => { try { return window.sessionStorage; } catch { return null; } };

export function mountHelp(root, opts) {
  const { faq, core } = opts;
  const lang = opts.lang === 'fr' || opts.lang === 'en' ? opts.lang : helpLang();
  const tr = (text) => helpText(text, lang);
  const index = core.buildIndex(faq);
  const byId = Object.fromEntries(faq.entries.map((e) => [e.id, e]));
  const cats = faq.categories;
  const catOf = Object.fromEntries(cats.map((c) => [c.id, c]));
  const votes = readJson(local() || { getItem: () => null }, VOTES, {});
  let chat = readJson(session() || { getItem: () => null }, CHAT, []);
  let view = { name: 'home' };
  let shot = null; // the screenshot waiting to be sent
  let asking = null; // AbortController of the question in flight

  root.classList.add('hc');
  root.dataset.mode = opts.mode || 'panel';
  root.replaceChildren();

  // ── the top: search and the two tabs ──
  const q = h('input', { type: 'search', class: 'hc-q', placeholder: tr('Search Help'), 'aria-label': tr('Search Help'), autocomplete: 'off', spellcheck: 'false' });
  const tabBrowse = h('button', { type: 'button', role: 'tab', class: 'hc-tab on', 'aria-selected': 'true', onclick: () => go({ name: 'home' }) }, tr('Help topics'));
  const tabAsk = h('button', { type: 'button', role: 'tab', class: 'hc-tab', 'aria-selected': 'false', onclick: () => go({ name: 'ask' }) }, icon('spark'), tr('Ask Help'));
  const top = h('div', 'hc-top',
    h('label', 'hc-search', icon('search'), q),
    h('div', { class: 'hc-tabs', role: 'tablist', 'aria-label': tr('Help') }, tabBrowse, tabAsk));
  const body = h('div', { class: 'hc-body', tabindex: '-1' });
  const live = h('div', { class: 'hc-sr', role: 'status', 'aria-live': 'polite' });
  root.append(top, body, live);

  let typing = 0;
  q.addEventListener('input', () => {
    clearTimeout(typing);
    typing = setTimeout(() => go(q.value.trim() ? { name: 'search', q: q.value.trim() } : { name: 'home' }, { keepFocus: true }), 120);
  });
  q.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      const first = body.querySelector('.hc-row');
      if (first) first.click();
    }
  });

  function go(next, { keepFocus = false, push = true } = {}) {
    view = next;
    const asks = next.name === 'ask';
    tabAsk.classList.toggle('on', asks);
    tabAsk.setAttribute('aria-selected', String(asks));
    tabBrowse.classList.toggle('on', !asks);
    tabBrowse.setAttribute('aria-selected', String(!asks));
    if (next.name !== 'search' && !keepFocus) q.value = '';
    if (next.name === 'home') drawHome();
    else if (next.name === 'cat') drawCategory(next.id);
    else if (next.name === 'entry') drawEntry(next.id);
    else if (next.name === 'search') drawSearch(next.q);
    else drawAsk(next.prefill);
    body.scrollTop = 0;
    if (push && opts.onNavigate) opts.onNavigate(next);
    if (!keepFocus && next.name === 'entry') requestAnimationFrame(() => body.querySelector('h2')?.focus());
  }

  const row = (e, sub) => h('button', { type: 'button', class: 'hc-row', onclick: () => go({ name: 'entry', id: e.id }) },
    h('span', 'hc-row-t', e.q), sub ? h('span', 'hc-row-s', sub) : null, icon('chev'));

  function drawHome() {
    const popular = ['first-message', 'signin-ways', 'err-mac-offline', 'allowance', 'privacy-mode', 'mac-link'].map((id) => byId[id]).filter(Boolean);
    body.replaceChildren(
      h('section', 'hc-sec',
        h('h2', 'hc-h', tr('Popular')),
        h('div', 'hc-list', popular.map((e) => row(e, catOf[e.cat]?.title)))),
      h('section', 'hc-sec',
        h('h2', 'hc-h', tr('Topics')),
        h('div', 'hc-cats', cats.map((c) => h('button', { type: 'button', class: `hc-cat${c.id === 'trouble' ? ' warn' : ''}`, onclick: () => go({ name: 'cat', id: c.id }) },
          h('span', 'hc-cat-t', c.title), h('span', 'hc-cat-n', `${faq.entries.filter((e) => e.cat === c.id).length}`))))),
      stuck());
  }

  function drawCategory(id) {
    const c = catOf[id];
    body.replaceChildren(
      backTo(tr('All topics'), { name: 'home' }),
      h('h2', { class: 'hc-title', tabindex: '-1' }, c ? c.title : tr('Topic')),
      h('div', 'hc-list', faq.entries.filter((e) => e.cat === id).map((e) => row(e))),
      stuck());
  }

  function drawSearch(text) {
    const results = core.search(index, text, { limit: 12 }).filter((r, i, all) => i < 3 || r.score >= all[0].score * 0.25);
    live.textContent = results.length ? tr(`${results.length} results`) : tr('No results');
    body.replaceChildren(
      results.length
        ? h('div', 'hc-list', results.map((r) => row(byId[r.id], catOf[byId[r.id].cat]?.title)))
        : h('div', 'hc-empty', h('p', null, tr(`Nothing in Help matches “${text}”.`)), h('p', null, tr('Try other words, or ask Help in your own words.'))),
      stuck(text));
  }

  function backTo(label, target) {
    return h('button', { type: 'button', class: 'hc-back', onclick: () => go(target) }, icon('back'), label);
  }

  function figure(key) {
    const im = faq.images && faq.images[key];
    if (!im) return null;
    const dark = opts.theme && opts.theme() === 'dark' && im.dark;
    const src = `${opts.imgBase}${dark ? im.dark : im.src}`;
    return h('figure', `hc-fig${im.phone ? ' phone' : ''}`,
      h('img', { src, alt: im.alt, loading: 'lazy', decoding: 'async', width: im.w, height: im.h }),
      im.caption ? h('figcaption', null, im.caption) : null);
  }

  function actions(e, { compact = false } = {}) {
    const btns = [];
    if (e.open && e.open.faq && byId[e.open.faq]) btns.push(h('button', { type: 'button', class: 'hc-btn', onclick: () => go({ name: 'entry', id: e.open.faq }) }, e.open.label || tr('Read more')));
    else if (e.open && opts.canRun && opts.canRun(e.open)) btns.push(h('button', { type: 'button', class: 'hc-btn primary', onclick: () => opts.run(e.open) }, e.open.label || tr('Open')));
    else if (e.open && e.open.href && opts.links !== false) btns.push(h('a', { class: 'hc-btn primary', href: e.open.href }, e.open.label || tr('Open')));
    if (e.tour && opts.tour) btns.push(h('button', { type: 'button', class: 'hc-btn', onclick: () => opts.tour(e.tour) }, tr(compact ? 'Try it' : 'Try it in the tour')));
    return btns.length ? h('div', 'hc-acts', btns) : null;
  }

  function drawEntry(id) {
    const e = byId[id];
    if (!e) { drawHome(); return; }
    const c = catOf[e.cat];
    const vote = h('div', 'hc-vote');
    const drawVote = () => {
      const v = votes[e.id];
      if (v === 1) vote.replaceChildren(h('span', 'hc-vote-done', tr('Thanks for telling us.')));
      else if (v === -1) vote.replaceChildren(h('span', 'hc-vote-done', tr('Sorry it didn’t help.')), h('button', { type: 'button', class: 'hc-link', onclick: () => go({ name: 'ask', prefill: e.q.replace(/^"|"$/g, '') }) }, tr('Ask Help instead')));
      else vote.replaceChildren(h('span', null, tr('Was this helpful?')),
        h('button', { type: 'button', class: 'hc-chip', onclick: () => cast(1) }, tr('Yes')),
        h('button', { type: 'button', class: 'hc-chip', onclick: () => cast(-1) }, tr('No')));
    };
    const cast = (v) => {
      votes[e.id] = v;
      const store = local();
      if (store) writeJson(store, VOTES, votes); // kept in this browser only
      drawVote();
      live.textContent = tr('Thanks');
    };
    drawVote();
    const related = faq.entries.filter((x) => x.cat === e.cat && x.id !== e.id).slice(0, 3);
    body.replaceChildren(
      backTo(c ? c.title : tr('All topics'), c ? { name: 'cat', id: c.id } : { name: 'home' }),
      h('article', { class: 'hc-entry', id: `help-${e.id}` },
        h('h2', { class: 'hc-title', tabindex: '-1' }, e.q),
        h('div', 'hc-answer', renderText(e.a)),
        (e.img || []).map(figure),
        actions(e),
        vote),
      related.length ? h('section', 'hc-sec', h('h3', 'hc-h', tr('Related')), h('div', 'hc-list', related.map((x) => row(x)))) : null,
      stuck(e.q));
  }

  function stuck(prefill) {
    return h('div', 'hc-stuck',
      h('span', null, tr('Still stuck?')),
      h('button', { type: 'button', class: 'hc-btn', onclick: () => go({ name: 'ask', prefill: prefill && !/^"/.test(prefill) ? prefill : '' }) }, icon('spark'), tr('Ask Help')));
  }

  // ── Ask Help ──
  const ta = h('textarea', { class: 'hc-in', rows: '2', placeholder: tr('Ask about Eden, or paste a screenshot of the problem'), 'aria-label': tr('Ask Help') });
  const file = h('input', { type: 'file', accept: 'image/png,image/jpeg,image/webp,image/heic,image/*', hidden: true });
  const strip = h('div', { class: 'hc-strip', hidden: true });
  const screenshotNote = lang === 'fr' && core.SCREENSHOT_NOTE_FR ? core.SCREENSHOT_NOTE_FR : core.SCREENSHOT_NOTE;
  const note = h('p', { class: 'hc-note', hidden: true, role: 'note' }, screenshotNote);
  const send = h('button', { type: 'submit', class: 'hc-send', 'aria-label': tr('Send to Help') }, icon('send'));
  const attach = h('button', { type: 'button', class: 'hc-attach', 'aria-label': tr('Attach a screenshot'), title: tr('Attach a screenshot') }, icon('clip'));
  const form = h('form', 'hc-form', strip, note, h('div', 'hc-bar', attach, ta, send), file);
  const log = h('div', { class: 'hc-log', role: 'log', 'aria-live': 'polite', 'aria-label': tr('Help conversation') });
  const gate = h('div', 'hc-gate');
  const support = h('a', { class: 'hc-link', href: core.supportMailto([], { lang }) }, icon('mail'), tr('Contact support'));
  const clear = h('button', { type: 'button', class: 'hc-link', onclick: () => { chat = []; saveChat(); drawAsk(); } }, tr('Clear'));
  const askFoot = h('div', 'hc-askfoot', support, clear);
  const askView = h('div', 'hc-ask', gate, log, form, askFoot);

  attach.addEventListener('click', () => file.click());
  file.addEventListener('change', () => { if (file.files && file.files[0]) takeShot(file.files[0]); file.value = ''; });
  ta.addEventListener('paste', (e) => {
    const item = [...(e.clipboardData?.items || [])].find((i) => i.kind === 'file' && i.type.startsWith('image/'));
    if (item) { e.preventDefault(); takeShot(item.getAsFile()); }
  });
  askView.addEventListener('dragover', (e) => { if ([...(e.dataTransfer?.items || [])].some((i) => i.kind === 'file')) e.preventDefault(); });
  askView.addEventListener('drop', (e) => {
    const f = [...(e.dataTransfer?.files || [])].find((x) => x.type.startsWith('image/'));
    if (f) { e.preventDefault(); takeShot(f); }
  });
  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); form.requestSubmit(); }
  });
  form.addEventListener('submit', (e) => { e.preventDefault(); submit(); });

  async function takeShot(f) {
    try {
      const s = await cleanScreenshot(f);
      dropShot();
      shot = s;
      strip.replaceChildren(
        h('img', { src: s.url, alt: tr('Screenshot to send'), class: 'hc-thumb' }),
        h('div', 'hc-strip-t', h('b', null, tr('Screenshot ready')), h('span', null, tr(`${s.width}×${s.height}, location and camera details removed`))),
        h('button', { type: 'button', class: 'hc-x', 'aria-label': tr('Remove the screenshot'), onclick: () => { dropShot(); ta.focus(); } }, icon('x')));
      strip.hidden = false;
      note.hidden = false;
      live.textContent = screenshotNote;
      ta.focus();
    } catch (err) {
      bubble('help', tr(err.message || 'That picture couldn’t be read.'), { error: true });
    }
  }
  function dropShot() {
    if (shot) URL.revokeObjectURL(shot.url);
    shot = null;
    strip.hidden = true;
    note.hidden = true;
    strip.replaceChildren();
  }

  function saveChat() {
    const store = session();
    if (store) writeJson(store, CHAT, chat.slice(-20)); // text only: a screenshot is never kept
    support.href = core.supportMailto(chat, { surface: opts.surface || '', lang });
  }

  function citeChip(id) {
    const e = byId[id];
    if (!e) return '';
    return h('button', { type: 'button', class: 'hc-cite', onclick: () => go({ name: 'entry', id }) }, e.q.replace(/^"|"$/g, ''));
  }

  function bubble(role, text, { image = false, error = false, cited = [], notSure = false } = {}) {
    const b = h('div', `hc-msg ${role}${error ? ' error' : ''}`);
    if (role === 'user') {
      if (image) b.append(h('span', 'hc-msg-img', tr('Screenshot attached')));
      if (text) b.append(h('p', { 'data-no-i18n': '' }, text)); // the person's own words
    } else {
      b.append(renderText(text, { cite: () => '' }));
      if (cited.length) b.append(h('div', 'hc-cites', h('span', null, tr('From Help:')), cited.map(citeChip)));
      const first = byId[cited[0]];
      if (first && !error) { const a = actions(first, { compact: true }); if (a) b.append(a); }
      if (notSure) {
        b.append(h('div', 'hc-acts',
          opts.tour ? h('button', { type: 'button', class: 'hc-btn', onclick: () => opts.tour(null) }, tr('Take the tour')) : null,
          h('button', { type: 'button', class: 'hc-btn', onclick: () => go({ name: 'home' }) }, tr('Browse topics')),
          h('a', { class: 'hc-btn', href: core.supportMailto(chat, { surface: opts.surface || '', lang }) }, tr('Contact support'))));
      }
    }
    log.append(b);
    b.scrollIntoView({ block: 'nearest' });
    return b;
  }

  async function drawAsk(prefill) {
    body.replaceChildren(askView);
    log.replaceChildren();
    if (!chat.length) {
      log.append(h('div', 'hc-hello',
        h('p', null, h('b', null, tr('Ask anything about Eden.')), ` ${tr('Answers come from the Help pages, with links to them. It can also look at a screenshot of a problem.')}`),
        h('p', 'hc-small', tr('Separate from your chats: nothing here goes into your history or uses your allowance.'))));
    }
    for (const m of chat) bubble(m.role === 'user' ? 'user' : 'help', m.content, { image: m.image, cited: m.cited || [], notSure: m.notSure });
    saveChat();
    if (prefill) ta.value = prefill;
    gate.replaceChildren();
    form.hidden = false;
    const st = await (opts.askState ? opts.askState() : { ok: true });
    if (view.name !== 'ask') return;
    if (!st.ok) {
      form.hidden = true;
      gate.append(h('div', 'hc-gatebox', h('p', null, tr(st.reason)), st.href ? h('a', { class: 'hc-btn primary', href: st.href }, tr(st.label || 'Sign in')) : null));
    } else if (st.note) gate.append(h('p', 'hc-small', tr(st.note)));
    requestAnimationFrame(() => { if (!form.hidden) ta.focus(); });
  }

  async function submit() {
    if (asking) return;
    const question = ta.value.trim();
    if (!question && !shot) { ta.focus(); return; }
    const image = shot;
    const history = chat.slice(-6).map((m) => ({ role: m.role, content: m.content }));
    chat.push({ role: 'user', content: question, image: Boolean(image) });
    bubble('user', question, { image: Boolean(image) });
    ta.value = '';
    shot = null; // the thumbnail's URL goes once it's sent
    strip.hidden = true;
    note.hidden = true;
    strip.replaceChildren();
    const wait = h('div', 'hc-msg help wait', h('span', 'hc-dots', h('i'), h('i'), h('i')), h('span', 'hc-sr', tr('Help is looking…')));
    log.append(wait);
    wait.scrollIntoView({ block: 'nearest' });
    asking = new AbortController();
    send.disabled = true;
    try {
      const r = await opts.ask({ question, history, image: image ? { mime: image.mime, data: image.data } : null, ...(lang === 'fr' ? { lang } : {}) }, asking.signal);
      wait.remove();
      const msg = { role: 'assistant', content: r.text, cited: r.cited || [], notSure: Boolean(r.notSure) };
      chat.push(msg);
      bubble('help', msg.content, msg);
      if (r.left && typeof r.left.messages === 'number' && r.left.messages <= 5) bubble('help', tr(`${r.left.messages} Help question${r.left.messages === 1 ? '' : 's'} left today.`), {});
    } catch (err) {
      wait.remove();
      if (err && err.name === 'AbortError') return;
      bubble('help', tr((err && err.message) || 'Help couldn’t answer just now. Try again.'), { error: true });
      if (err && err.status === 401) drawAsk();
    } finally {
      if (image) URL.revokeObjectURL(image.url);
      asking = null;
      send.disabled = false;
      saveChat();
    }
  }

  go({ name: 'home' }, { push: false });
  return {
    show: (id) => go(byId[id] ? { name: 'entry', id } : { name: 'home' }),
    home: () => go({ name: 'home' }),
    askView: (text) => go({ name: 'ask', prefill: text || '' }),
    search: (text) => { q.value = text; go({ name: 'search', q: text }, { keepFocus: true }); },
    focus: () => (view.name === 'ask' ? ta.focus() : q.focus()),
    view: () => view,
    stop: () => asking && asking.abort(),
  };
}
