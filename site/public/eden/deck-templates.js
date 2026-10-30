// Eden Slides templates (web only: deck.js opens this only when !IN_APP). A gallery of starter decks and single
// slides (deck-templates-data.js), each thumbnail drawn by the deck's own renderer (deck-render.js, static mode:
// no script) in a sandboxed frame. Choosing a deck starts it, or on an existing deck replaces it or adds its
// slides; a single slide goes in after the selected one. deck.js saves each as a version (undoable). "Fill with
// Eden" starts the template, then asks the model through the normal Slides turn to write into its structure.
//
// A deck holding template text is marked `template` (deck-model.js keeps it, never sends it to the model): the editor
// doesn't search photos for placeholder words. Eden's next full rewrite (Fill with Eden) drops the mark.
//
// The pure parts (templateDeck, addTemplateSlides, insertTemplateSlide, fillPrompt) run in the tests too.

import { normalizeDeck, normalizeSlide, LIMITS, SLIDE_W, SLIDE_H } from './deck-model.js';
import { TEMPLATES, SLIDE_TEMPLATES, TEMPLATE_CATEGORIES } from './deck-templates-data.js';
import { TEMPLATE_LANGS, templateLang, loadTemplateLang, localizeDeck, tl, dirOf, covers } from './deck-templates-i18n.js';
import { languageName } from './deck-translate.js';
import { STYLE_THEMES, STYLE_IDS } from './deck-styles.js';
import { freeFaces } from './deck-fonts.js';

/** A template's style id ('' for a classic theme). */
export const styleOf = (t) => (STYLE_THEMES[t.deck.theme.base] ? t.deck.theme.base : '');
/** The style's name ('Classic' for the classic themes): English, for tl(). */
export const styleName = (id) => (STYLE_THEMES[id] ? STYLE_THEMES[id].name : 'Classic');

export { TEMPLATES, SLIDE_TEMPLATES };

const clone = (x) => JSON.parse(JSON.stringify(x));

/** A template as a fresh, cleaned deck (never the shared data object), in `pack`'s language (deck-templates-i18n.js). */
export function templateDeck(t, pack = null) {
  const r = normalizeDeck({ ...clone(t.deck), template: t.id }); // marked: placeholder words never become a photo search (deck.js)
  return r.deck ? (pack ? normalizeDeck(localizeDeck(r.deck, pack)).deck : r.deck) : null;
}

/** `deck` with the template's slides added at the end (its own theme kept; the slide limit holds). */
export function addTemplateSlides(deck, tplDeck) {
  const room = Math.max(0, LIMITS.slides - deck.slides.length);
  if (!room) return deck;
  const d = clone(deck);
  d.slides.push(...clone(tplDeck.slides).slice(0, room));
  d.template = d.template || tplDeck.template || 'slides';
  return normalizeDeck(d).deck || deck;
}

/** `deck` with one template slide after slide `after` (or at the end); unchanged at the slide limit. */
export function insertTemplateSlide(deck, after, slide) {
  const s = normalizeSlide(clone(slide));
  if (!s || deck.slides.length >= LIMITS.slides) return deck;
  const d = clone(deck);
  const at = Number.isInteger(after) && after >= 0 && after < d.slides.length ? after + 1 : d.slides.length;
  d.slides.splice(at, 0, s);
  d.template = d.template || 'slide';
  return d;
}

/** A one-slide deck to start from (no deck yet). */
export const slideDeck = (slide, pack = null) => { const d = normalizeDeck({ title: 'Untitled deck', theme: { base: 'glass' }, template: 'slide', slides: [clone(slide)] }).deck; return pack ? normalizeDeck({ ...localizeDeck(d, pack), title: d.slides[0].title || d.title }).deck : d; };

/** What Eden is asked after a template starts: write into its structure for the person's topic. */
export function fillPrompt(topic, t) {
  const what = String(topic || '').replace(/\s+/g, ' ').trim().slice(0, 600);
  const language = t && t.lang && t.lang !== 'en' ? languageName(t.lang) : ''; // 'French', 'Arabic'…
  return `Fill in this ${t ? `“${t.name}” ` : ''}template for: ${what}\n\n`
    + (language ? `Write everything in ${language} (the template’s language), including the speaker notes. ` : '')
    + 'Keep every slide, in the same order, with the same layout and kind of content (a chart stays a chart, a table a table, a diagram a diagram, with the same diagram type). '
    + 'Replace all the placeholder text with real content for this topic, and write speaker notes for each slide. '
    + 'Don’t invent numbers: use figures you know to be true or that this conversation gives, and where a number is unknown keep a clearly marked placeholder and say in the notes what to check. Keep the theme and motion.';
}

// ── the gallery ──

let cssP = null;
function loadCss() {
  if (cssP) return cssP;
  cssP = new Promise((done) => {
    const l = document.createElement('link');
    l.rel = 'stylesheet';
    l.href = new URL('./deck-templates.css', import.meta.url).href;
    l.onload = l.onerror = () => done();
    document.head.append(l);
  });
  return cssP;
}

function h(tag, attrs, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') n.className = v;
    else if (k.startsWith('on') && typeof v === 'function') n.addEventListener(k.slice(2), v);
    else n.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of kids.flat()) if (c !== null && c !== undefined && c !== false) n.append(c);
  return n;
}

/**
 * Open the gallery. `host`: { deck (the open deck or null), deckDocument (deck-render.js), tx (translate),
 * kind: 'deck'|'slide', apply({ how: 'start'|'replace'|'append'|'insert', deck?, slide?, topic?, template? }) }.
 */
export async function openTemplateGallery(host) {
  await loadCss();
  const tx0 = host.tx || ((s) => s);
  const opener = document.activeElement;
  // the gallery speaks the interface's language; the templates come in the language picked here (the interface's at first)
  const iface = templateLang(document.documentElement.lang);
  const uiPack = iface === 'en' ? null : await loadTemplateLang(iface).catch(() => null);
  const tx = (s, n) => { const v = uiPack && uiPack.ui && uiPack.ui[s] !== undefined ? uiPack.ui[s] : tx0(s); return n === undefined ? v : v.replace('{n}', String(n)); };
  let saved = '';
  try { saved = localStorage.getItem('eden:template-lang') || ''; } catch { /* storage blocked */ }
  let pack = null;
  const has = !!host.deck;
  const ui = { kind: host.kind === 'slide' ? 'slide' : 'deck', cat: 'All', style: 'all', q: '', lang: saved ? templateLang(saved) : iface };
  pack = await loadTemplateLang(ui.lang).catch(() => { ui.lang = 'en'; return null; });
  const L = (s) => tl(s, pack);
  // a template this language hasn't fully caught up with is shown, and started, in English (never half translated)
  const packFor = (t) => (pack && covers(t, pack, (d) => normalizeDeck(clone(d)).deck) ? pack : null);
  const langAttrs = () => ({ lang: ui.lang, dir: dirOf(ui.lang) });

  const dlg = h('dialog', { class: 'dtpl', 'aria-labelledby': 'dtplTitle' });
  const close = () => {
    if (!dlg.open && !dlg.isConnected) return;
    io.disconnect();
    try { dlg.close(); } catch { /* already closed */ }
    dlg.remove();
    if (opener && opener.isConnected && opener.focus) opener.focus();
    else { const b = document.querySelector('[data-deck="templates"],[data-key="btn:templates"],[data-key="tool:file"]'); if (b) b.focus(); } // the menu that opened it has closed
  };
  // Escape closes only the gallery (the canvas behind it listens for Escape too)
  dlg.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); } });
  dlg.addEventListener('cancel', (e) => { e.preventDefault(); close(); });
  dlg.addEventListener('click', (e) => { if (e.target === dlg) close(); }); // the backdrop

  // thumbnails: one static, script-free slide per frame, drawn when it scrolls into view
  const io = new IntersectionObserver((entries) => {
    for (const en of entries) if (en.isIntersecting) { io.unobserve(en.target); draw(en.target); }
  }, { root: null, rootMargin: '200px' });
  const thumb = (deck, k = 0) => {
    const box = h('div', { class: 'dtpl-thumb', 'aria-hidden': 'true' });
    box._deck = { ...deck, slides: [deck.slides[k]] };
    io.observe(box);
    return box;
  };
  // the styles' free fonts (deck-fonts.js), loaded into this page from their files (the page allows fonts from 'self'
  // only), so the thumbnails, drawn in shadow roots, show the real type
  const faces = new Set();
  const addFonts = (deck) => {
    if (typeof FontFace === 'undefined') return;
    for (const fam of Object.values((deck.theme && deck.theme.fonts) || {})) for (const f of freeFaces(fam)) {
      const key = `${f.family}/${f.weight}/${f.style}`;
      if (faces.has(key)) continue;
      faces.add(key);
      try { const ff = new FontFace(f.family, `url(${new URL(`./${f.path}`, import.meta.url).href})`, { weight: String(f.weight), style: f.style }); document.fonts.add(ff); ff.load().catch(() => {}); } catch { /* the stack's next face draws */ }
    }
  };
  // A thumbnail is the renderer's static, script-free slide (Eden's own template data, every text escaped) drawn in a
  // shadow root: one sandboxed frame per card would cost a renderer process each, and 70 of them stall the page.
  function draw(box) {
    let html;
    try { html = host.deckDocument(box._deck, { mode: 'static' }); } catch { box.classList.add('dtpl-thumb-fail'); return; }
    addFonts(box._deck);
    const css = (/<style>([\s\S]*?)<\/style>/.exec(html) || [])[1] || '';
    const body = /<body class="([^"]*)">([\s\S]*)<\/body>/.exec(html);
    if (!body || box.shadowRoot) return;
    const root = box.attachShadow({ mode: 'open' });
    root.innerHTML = `<style>${css.replace(/:root\b/g, ':host')}.dtpl-slide{position:absolute;left:0;top:0;width:${SLIDE_W}px;height:${SLIDE_H}px;transform-origin:0 0;font-family:var(--bf);color:var(--text);-webkit-font-smoothing:antialiased;overflow:hidden}</style><div class="dtpl-slide ${body[1]}">${body[2]}</div>`;
    const inner = root.querySelector('.dtpl-slide');
    const fit = () => { if (box.clientWidth) inner.style.transform = `scale(${box.clientWidth / SLIDE_W})`; };
    fit();
    new ResizeObserver(fit).observe(box);
  }

  const title = h('h2', { id: 'dtplTitle' }, tx('Templates'));
  const closeBtn = h('button', { type: 'button', class: 'dtpl-x', 'aria-label': tx('Close templates'), onclick: close }, '×');
  const tabs = h('div', { class: 'dtpl-tabs', role: 'group', 'aria-label': tx('Template kind') });
  const tab = (kind, label) => h('button', { type: 'button', class: 'dtpl-tab', 'data-kind': kind, 'aria-pressed': String(ui.kind === kind), onclick: () => { ui.kind = kind; showGrid(); } }, tx(label));
  tabs.append(tab('deck', 'Whole decks'), tab('slide', 'Single slides'));
  const langSel = h('select', { class: 'dtpl-lang', 'aria-label': tx('Template language'), onchange: async () => {
    const want = langSel.value;
    try { pack = await loadTemplateLang(want); ui.lang = want; } catch { langSel.value = ui.lang; return; }
    try { localStorage.setItem('eden:template-lang', want); } catch { /* storage blocked */ }
    showGrid();
    langSel.focus();
  } }, ...TEMPLATE_LANGS.map(([c, name]) => h('option', { value: c, lang: c, selected: c === ui.lang ? true : null }, name)));
  const search = h('input', { type: 'search', class: 'dtpl-search', placeholder: tx('Search templates'), 'aria-label': tx('Search templates'), oninput: () => { ui.q = search.value.trim().toLowerCase(); fillGrid(); } });
  const cats = h('div', { class: 'dtpl-cats', role: 'group', 'aria-label': tx('Categories') });
  const styles = h('div', { class: 'dtpl-cats dtpl-styles', role: 'group', 'aria-label': tx('Styles') });
  const grid = h('div', { class: 'dtpl-grid', role: 'list', 'aria-label': tx('Templates') });
  const count = h('p', { class: 'dtpl-count', role: 'status' });
  const body = h('div', { class: 'dtpl-body' });
  const hint = h('p', { class: 'dtpl-hint' }, tx(has ? 'Arrow keys move between templates. Enter opens one. Your deck is kept as a version you can go back to.' : 'Arrow keys move between templates. Enter opens one.'));
  dlg.append(h('div', { class: 'dtpl-head' }, title, closeBtn), body);

  // the grid: roving focus, arrow keys by row and column, Home/End
  grid.addEventListener('keydown', (e) => {
    const all = [...grid.querySelectorAll('.dtpl-card')];
    const i = all.indexOf(document.activeElement);
    if (i < 0) return;
    const cols = Math.max(1, all.filter((c) => c.offsetTop === all[0].offsetTop).length);
    const fwd = grid.dir === 'rtl' ? -1 : 1; // an Arabic grid runs right to left
    const to = { ArrowRight: i + fwd, ArrowLeft: i - fwd, ArrowDown: i + cols, ArrowUp: i - cols, Home: 0, End: all.length - 1 }[e.key];
    if (to === undefined) return;
    e.preventDefault();
    const next = all[Math.max(0, Math.min(all.length - 1, to))];
    all.forEach((c) => c.setAttribute('tabindex', c === next ? '0' : '-1'));
    next.focus();
    next.scrollIntoView({ block: 'nearest' });
  });

  function fillStyles() {
    const swatch = (id) => { const th = STYLE_THEMES[id]; return th ? h('span', { class: 'dtpl-sw', 'aria-hidden': 'true', style: `background:${th.colors.bg};border-color:${th.colors.accent};color:${th.colors.text}` }, 'Aa') : null; };
    styles.replaceChildren(...(ui.kind === 'deck' ? ['all', ...STYLE_IDS, 'classic'] : []).map((id) => h('button', { type: 'button', class: 'dtpl-cat', 'data-style': id, 'aria-pressed': String(ui.style === id), onclick: () => { ui.style = id; fillStyles(); fillGrid(); } }, swatch(id), id === 'all' ? tx('All styles') : L(styleName(id === 'classic' ? '' : id)))));
    styles.hidden = ui.kind !== 'deck';
  }
  function fillCats() {
    cats.replaceChildren(...(ui.kind === 'deck' ? TEMPLATE_CATEGORIES : []).map((c) => h('button', { type: 'button', class: 'dtpl-cat', 'aria-pressed': String(ui.cat === c), onclick: () => { ui.cat = c; fillCats(); fillGrid(); } }, c === 'All' ? tx('All') : L(c))));
    cats.hidden = ui.kind !== 'deck';
  }
  function fillGrid() {
    const q = ui.q;
    const match = (...s) => !q || s.join(' ').toLowerCase().includes(q);
    const cards = ui.kind === 'deck'
      ? TEMPLATES.filter((t) => (ui.cat === 'All' || t.category === ui.cat) && (ui.style === 'all' || styleOf(t) === (ui.style === 'classic' ? '' : ui.style)) && match(L(styleName(styleOf(t))), t.name, t.description, t.category, L(t.name), L(t.description), L(t.category))).map((t) => {
        const pk = packFor(t), Lt = (x) => tl(x, pk);
        const d = templateDeck(t, pk);
        return h('div', { role: 'listitem' }, h('button', { type: 'button', class: 'dtpl-card', 'data-tpl': t.id, tabindex: '-1', onclick: () => showDetail(t), ...(pk ? {} : { lang: 'en', dir: 'ltr' }) },
          thumb(d), h('span', { class: 'dtpl-name' }, Lt(t.name)), h('span', { class: 'dtpl-desc' }, Lt(t.description)), h('span', { class: 'dtpl-meta' }, `${L(t.category)} · ${L(styleName(styleOf(t)))} · ${tx('{n} slides', d.slides.length)}${pack && !pk ? ` · ${tx('in English')}` : ''}`)));
      })
      : SLIDE_TEMPLATES.filter((s) => match(s.name, s.slide.title || '', s.slide.kicker || '', L(s.name))).map((s) => {
        const one = slideDeck(s.slide, packFor(s));
        const d = { ...one, theme: host.deck ? host.deck.theme : one.theme };
        return h('div', { role: 'listitem' }, h('button', { type: 'button', class: 'dtpl-card', 'data-slide': s.id, tabindex: '-1', 'aria-label': `${L(s.name)}: ${tx(has ? 'insert after the selected slide' : 'start a deck with this slide')}`, onclick: () => { close(); host.apply(has ? { how: 'insert', slide: one.slides[0] } : { how: 'start', deck: one }); } },
          thumb(d), h('span', { class: 'dtpl-name' }, L(s.name))));
      });
    grid.replaceChildren(...cards);
    Object.entries(langAttrs()).forEach(([k, v]) => grid.setAttribute(k, v));
    const first = grid.querySelector('.dtpl-card');
    if (first) first.setAttribute('tabindex', '0');
    count.textContent = cards.length ? tx(cards.length === 1 ? '{n} template' : '{n} templates', cards.length) : tx('No templates match. Try another word.');
  }
  function showGrid(focusId) {
    dlg.classList.remove('dtpl-detail-on');
    title.textContent = tx('Templates');
    tabs.querySelectorAll('.dtpl-tab').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.kind === ui.kind)));
    fillCats();
    fillStyles();
    fillGrid();
    body.replaceChildren(h('div', { class: 'dtpl-tools' }, tabs, search, h('label', { class: 'dtpl-lang-wrap' }, h('span', {}, tx('Template language')), langSel)), cats, styles, count, grid, hint);
    const back = focusId && grid.querySelector(`[data-tpl="${focusId}"]`);
    if (back) { grid.querySelectorAll('.dtpl-card').forEach((c) => c.setAttribute('tabindex', c === back ? '0' : '-1')); back.focus(); back.scrollIntoView({ block: 'nearest' }); }
  }
  function showDetail(t) {
    const pk = packFor(t);
    const d = templateDeck(t, pk);
    const tt = { ...t, name: tl(t.name, pk), lang: pk ? ui.lang : 'en' }; // for Eden's prompt (fillPrompt)
    dlg.classList.add('dtpl-detail-on');
    title.textContent = tl(t.name, pk);
    const back = h('button', { type: 'button', class: 'dtpl-back', onclick: () => showGrid(t.id) }, `← ${tx('All templates')}`);
    const strip = h('ol', { class: 'dtpl-strip', 'aria-label': tx('Slides in this template'), ...(pk ? langAttrs() : { lang: 'en', dir: 'ltr' }) },
      ...d.slides.map((s, k) => h('li', {}, thumb(d, k), h('span', { class: 'dtpl-slide-name' }, `${k + 1}. ${s.title || s.quote || ''}`))));
    const go = (how) => { close(); host.apply({ how, deck: templateDeck(t, pk), template: tt }); };
    const topic = h('input', { type: 'text', class: 'dtpl-topic', id: 'dtplTopic', maxlength: '600', placeholder: tx('e.g. a bakery opening a second shop in Lyon') });
    const fill = () => {
      const v = topic.value.trim();
      if (!v) { topic.setAttribute('aria-invalid', 'true'); topic.focus(); return; }
      close();
      host.apply({ how: has ? 'replace' : 'start', deck: templateDeck(t, pk), template: tt, topic: v });
    };
    topic.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); fill(); } });
    const acts = h('div', { class: 'dtpl-acts' },
      has ? h('button', { type: 'button', class: 'cap primary', 'data-act': 'replace', onclick: () => go('replace') }, tx('Replace my deck'))
        : h('button', { type: 'button', class: 'cap primary', 'data-act': 'start', onclick: () => go('start') }, tx('Use this template')),
      has ? h('button', { type: 'button', class: 'cap', 'data-act': 'append', onclick: () => go('append') }, tx('Add these {n} slides', d.slides.length)) : null);
    const fillBox = h('div', { class: 'dtpl-fill' },
      h('label', { for: 'dtplTopic' }, tx('Fill with Eden: what is your deck about?')),
      h('div', { class: 'dtpl-fill-row' }, topic, h('button', { type: 'button', class: 'cap', 'data-act': 'fill', onclick: fill }, tx('Fill with Eden'))),
      h('p', { class: 'dtpl-note' }, tx(has ? 'Replaces your deck with this template, then Eden writes your content into it. Undo brings your deck back.' : 'Starts this template, then Eden writes your content into it. Eden marks any number it can’t check.')));
    body.replaceChildren(back, h('p', { class: 'dtpl-desc-lg', ...(pk ? langAttrs() : { lang: 'en' }) }, tl(t.description, pk)), strip, acts, fillBox);
    (acts.querySelector('.primary') || back).focus();
  }

  document.body.append(dlg);
  dlg.showModal();
  showGrid();
  const first = grid.querySelector('.dtpl-card');
  if (first) first.focus();
  return { close, dialog: dlg };
}
