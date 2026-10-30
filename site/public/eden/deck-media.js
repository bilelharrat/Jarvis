// Eden Slides' stock media library (web only: deck.js adds the Media tray when !IN_APP).
//
// Photos, video and audio come from Openverse and Wikimedia Commons through the local server
// (src/chat/stock-media.ts: GET /api/chat/media/search and /api/chat/media/file, no key); icons are the
// vendored Lucide set (deck-icons.json, ISC: deck-icons-license.txt). Everything shown is free to reuse,
// and every item keeps its licence and attribution: inserting one adds its credit to the deck's sources
// slide (addCredit). Photos and icons go through the normal picture flow (storeImage → deckImages,
// setImage with required alt text); an icon is drawn as a PNG in the colour picked (the theme accent by default).
//
// API for other modules (e.g. video/audio on slides):
//   searchMedia(kind, q, { page })  → Promise<{ items: MediaItem[], notices: string[], results }> (results = items)
//       kind: 'photo' | 'video' | 'audio' | 'icon'. Rejects with an Error whose message can be shown as is
//       (rate limits say so). Results are cached for CACHE_MS.
//   MediaItem: { id, kind, url, thumb, title, author, authorUrl, licence, licenceUrl, source, page,
//                original, provider, width?, height?, duration?, mime? }
//       url and thumb are same-origin (fine for <img>/<audio>/<video> under the page's CSP; Range works);
//       original is the file at its source, page the page that shows its licence. Icons also have `svg`
//       (the inner markup, 24×24 viewBox, stroke="currentColor").
//   registerMediaHandler(kind, fn)  fn(item, { deck, index }) → the new deck (or null to cancel). The Media
//       tray's Insert calls it for 'video' and 'audio'; the credit is added and the edit saved for you. With no
//       handler, Insert hands the file to video/audio on slides (deck-video-ui.js addMediaFile), then adds the credit.
//   creditLine(item), addCredit(deck, item)  the attribution text, and the deck with it in deck.sources.
//   creditInsert(before, after, item, c.deckCredits)  addCredit, and remembers which new picture/clip ids the credit
//       is for; deck.js commit runs pruneCredits(deck, c.deckCredits), so the credit goes when they're all removed.
//   iconSvg(item, color, size)  a standalone SVG string for an icon.

import { el, toast, addStylesheet } from './util.js';
import { t as tx } from './i18n.js';
import { apiUrl } from './api.js';
import { themeOf } from './deck-model.js';
import { LUCIDE, findIcons, iconSvg, okColor, creditLine, addCredit, creditInsert, pruneCredits } from './deck-media-model.js';

export { LUCIDE, findIcons, iconSvg, creditLine, addCredit, creditInsert, pruneCredits };

export const MEDIA_KINDS = ['photo', 'icon', 'video', 'audio'];
export const CACHE_MS = 5 * 60_000;
const KIND_LABEL = { photo: 'Photos', icon: 'Icons', video: 'Video', audio: 'Audio' };

const cache = new Map(); // `${kind}|${page}|${q}` → { at, value }
const handlers = new Map();
export function registerMediaHandler(kind, fn) { if (typeof fn === 'function') handlers.set(kind, fn); else handlers.delete(kind); }

// ── icons ──
let iconsP = null;
const loadIcons = () => (iconsP ??= fetch(new URL('./deck-icons.json', import.meta.url).href).then((r) => {
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}).then((j) => Object.entries(j.icons || {}).map(([name, [tags, svg]]) => ({ name, tags: String(tags || '').toLowerCase(), svg })), (e) => { iconsP = null; throw new Error(`The icons couldn’t be loaded (${e.message || e}).`); }));
const svgUrl = (svg) => `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
/** An icon as a PNG data URL (PowerPoint and the picture checks take PNG, not SVG). */
function iconPng(item, color, size = 512) {
  return new Promise((resolve, reject) => {
    const im = new Image();
    im.onload = () => {
      try {
        const cv = document.createElement('canvas');
        cv.width = size;
        cv.height = size;
        cv.getContext('2d').drawImage(im, 0, 0, size, size);
        resolve(cv.toDataURL('image/png'));
      } catch (e) { reject(e); }
    };
    im.onerror = () => reject(new Error('The icon couldn’t be drawn.'));
    im.src = svgUrl(iconSvg(item, color, size));
  });
}

// ── search ──
export async function searchMedia(kind, q, { page = 1 } = {}) {
  if (!MEDIA_KINDS.includes(kind)) throw new Error('Pick photos, icons, video or audio.');
  const query = String(q || '').replace(/\s+/g, ' ').trim().slice(0, 100);
  if (kind === 'icon') { const items = findIcons(await loadIcons(), query); return { items, notices: [], results: items }; }
  if (!query) throw new Error('Type what to search for.');
  const key = `${kind}|${page}|${query.toLowerCase()}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;
  let r;
  try {
    r = await fetch(apiUrl(`/api/chat/media/search?kind=${kind}&q=${encodeURIComponent(query)}&page=${page}`));
  } catch {
    throw new Error('Couldn’t reach Eden to search. Check the connection and try again.');
  }
  const j = await r.json().catch(() => null);
  if (r.status === 404) throw new Error('Stock media search isn’t available here yet: it needs Eden on your Mac.');
  if (!r.ok || !j || !Array.isArray(j.items)) throw new Error((j && j.error) || `The search failed (HTTP ${r.status}).`);
  const items = j.items.map((it) => ({ ...it, url: apiUrl(it.url), thumb: it.thumb ? apiUrl(it.thumb) : '' }));
  const value = { items, notices: Array.isArray(j.notices) ? j.notices : [], results: items }; // deck-video-ui.js reads `results`
  if (!value.notices.length) {
    if (cache.size > 100) cache.delete(cache.keys().next().value);
    cache.set(key, { at: Date.now(), value });
  }
  return value;
}

// ── the Media tray ──
// The toolbar is rebuilt after every edit, so what's on screen lives here and is drawn again.
const ui = { kind: 'photo', q: '', items: [], notices: [], status: '', busy: false, sel: -1, color: '', alt: '', seq: 0 };
const addCss = () => addStylesheet(new URL('./deck-media.css', import.meta.url).href, 'deck-media'); // noted for the page-update check
/** Which picture/clip ids each media-library credit is for (kept with the conversation; see pruneCredits). */
const owners = (c) => (c.deckCredits && typeof c.deckCredits === 'object' && !Array.isArray(c.deckCredits) ? c.deckCredits : (c.deckCredits = {}));
const fmtTime = (s) => (s ? `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}` : '');
const blobToDataUrl = (blob) => new Promise((res, rej) => { const fr = new FileReader(); fr.onload = () => res(String(fr.result || '')); fr.onerror = () => rej(fr.error); fr.readAsDataURL(blob); });

/**
 * ctx (from deck.js): { currentDeck(), cur(), slideAt(), storeImage(c, id, data, w, h), commit(deck, { toastText }),
 * setImage(deck, i, id, alt), keepFocus(key) }.
 */
export function mediaPanel(ctx) {
  addCss();
  const root = el('div', { class: 'deck-media' });
  const draw = () => {
    ui.redraw = draw; // a search or insert that finishes after the toolbar was rebuilt draws into the new tray
    const had = root.contains(document.activeElement) ? document.activeElement.dataset.key : '';
    const deck = ctx.currentDeck();
    const accent = deck ? themeOf(deck).colors.accent : '#2563eb';
    const color = okColor(ui.color || accent);
    const kinds = el('div', { class: 'deck-media-kinds', role: 'group', 'aria-label': tx('Kind of media') },
      ...MEDIA_KINDS.map((k) => el('button', { type: 'button', class: 'cap', 'data-key': `media-kind:${k}`, 'aria-pressed': String(ui.kind === k), onclick: () => { ctx.keepFocus && ctx.keepFocus(`media-kind:${k}`); pickKind(k); } }, tx(KIND_LABEL[k]))));
    const input = el('input', { type: 'search', class: 'deck-media-q', 'data-key': 'media-q', value: ui.q, 'aria-label': tx(`Search ${KIND_LABEL[ui.kind].toLowerCase()}`), placeholder: tx(ui.kind === 'icon' ? 'Search icons (e.g. rocket, chart)' : `Search free ${KIND_LABEL[ui.kind].toLowerCase()}`), oninput: (e) => { ui.q = e.target.value; } });
    const form = el('form', { class: 'deck-media-form', role: 'search', onsubmit: (e) => { e.preventDefault(); run(); } }, kinds, input, el('button', { type: 'submit', class: 'cap primary', 'data-key': 'media-go' }, tx('Search')));
    const status = el('p', { class: 'deck-media-status', role: 'status', 'aria-live': 'polite' }, ui.busy ? tx('Searching…') : [ui.status, ...ui.notices].filter(Boolean).join(' '));
    const tiles = el('div', { class: 'deck-choices deck-media-results', role: 'group', 'aria-label': tx('Results') },
      ...ui.items.map((it, k) => el('button', {
        type: 'button', class: 'deck-choice deck-media-tile', 'data-key': `media-item:${it.id}`, 'aria-pressed': String(ui.sel === k),
        'aria-label': it.kind === 'icon' ? `${it.title} icon` : `${it.title}, ${it.author}, ${it.licence}${it.duration ? `, ${fmtTime(it.duration)}` : ''}`,
        title: it.kind === 'icon' ? it.title : `${it.title} — ${it.author} (${it.licence})`,
        onclick: () => { ctx.keepFocus && ctx.keepFocus(`media-item:${it.id}`); ui.sel = k; ui.alt = it.kind === 'icon' ? `${it.title} icon` : it.title; draw(); },
      },
      it.kind === 'icon' ? el('img', { src: svgUrl(iconSvg(it, color, 48)), alt: '', width: 40, height: 40, class: 'deck-media-icon' })
        : it.thumb ? el('img', { src: it.thumb, alt: '', loading: 'lazy', decoding: 'async', onerror: (e) => e.target.replaceWith(el('span', { class: 'deck-media-glyph', 'aria-hidden': 'true' }, it.kind === 'video' ? '▶' : '▧')) }) // a preview the library couldn't serve
          : el('span', { class: 'deck-media-glyph', 'aria-hidden': 'true' }, it.kind === 'audio' ? '♪' : '▶'),
      el('span', { class: 'deck-media-cap' }, it.duration ? `${fmtTime(it.duration)} · ${it.title}` : it.title))));
    root.replaceChildren(form, status, ui.items.length ? tiles : '', details(ui.items[ui.sel], deck, accent, color));
    const back = had && [...root.querySelectorAll('[data-key]')].find((x) => x.dataset.key === had && !x.disabled);
    if (back) back.focus({ preventScroll: true });
    else if (had) root.querySelector('[data-key="media-q"]')?.focus({ preventScroll: true });
  };
  function details(it, deck, accent, color) {
    if (!it) return '';
    const alt = (it.kind === 'photo' || it.kind === 'icon') ? el('input', { type: 'text', class: 'deck-media-alt', 'data-key': 'media-alt', value: ui.alt, maxlength: 300, required: true, 'aria-label': tx('Alt text (what the picture shows, read by screen readers)'), placeholder: tx('Alt text: what it shows'), oninput: (e) => { ui.alt = e.target.value; } }) : null;
    const colors = it.kind === 'icon' ? el('span', { class: 'deck-media-colors', role: 'group', 'aria-label': tx('Icon colour') },
      el('button', { type: 'button', class: 'cap', 'data-key': 'media-accent', 'aria-pressed': String(color.toLowerCase() === accent.toLowerCase()), onclick: () => { ctx.keepFocus && ctx.keepFocus('media-accent'); ui.color = ''; draw(); } }, el('span', { class: 'deck-media-dot', style: { background: accent } }), tx('Accent')),
      deck ? el('button', { type: 'button', class: 'cap', 'data-key': 'media-text', onclick: () => { ctx.keepFocus && ctx.keepFocus('media-text'); ui.color = themeOf(deck).colors.text; draw(); } }, el('span', { class: 'deck-media-dot', style: { background: themeOf(deck).colors.text } }), tx('Text')) : null,
      el('input', { type: 'color', 'data-key': 'media-color', value: /^#[0-9a-f]{6}$/i.test(color) ? color : '#2563eb', 'aria-label': tx('Custom icon colour'), onchange: (e) => { ctx.keepFocus && ctx.keepFocus('media-color'); ui.color = e.target.value; draw(); } })) : null;
    const preview = it.kind === 'video' ? el('video', { src: it.url, controls: true, preload: 'none', poster: it.thumb || null, class: 'deck-media-preview', 'aria-label': `${tx('Preview')}: ${it.title}` })
      : it.kind === 'audio' ? el('audio', { src: it.url, controls: true, preload: 'none', class: 'deck-media-preview', 'aria-label': `${tx('Preview')}: ${it.title}` }) : null;
    const credit = el('p', { class: 'deck-media-credit' }, creditLine(it), ' ', it.page ? el('a', { href: it.page, target: '_blank', rel: 'noopener noreferrer' }, tx('Source')) : null, it.licenceUrl ? [' · ', el('a', { href: it.licenceUrl, target: '_blank', rel: 'noopener noreferrer' }, tx('Licence'))] : null);
    return el('div', { class: 'deck-media-detail' }, credit, preview, colors, alt,
      el('button', { type: 'button', class: 'cap primary', 'data-key': 'media-insert', disabled: ui.busy ? true : null, onclick: () => insert(it, color) }, tx(`Insert on slide ${ctx.slideAt() + 1}`)));
  }
  function pickKind(k) {
    if (ui.kind === k) return;
    ui.kind = k; ui.items = []; ui.notices = []; ui.status = ''; ui.sel = -1;
    if (k === 'icon' || ui.q.trim()) run(); else draw();
  }
  async function run() {
    const seq = ++ui.seq;
    ui.busy = true; ui.status = ''; ui.notices = []; ui.sel = -1;
    ui.redraw();
    try {
      const r = await searchMedia(ui.kind, ui.q);
      if (seq !== ui.seq) return;
      ui.items = r.items; ui.notices = r.notices;
      ui.status = r.items.length ? tx(`${r.items.length} results. Pick one to see its licence and insert it.`) : tx('Nothing matched. Try a shorter or more general word.');
    } catch (e) {
      if (seq !== ui.seq) return;
      ui.items = []; ui.status = e.message || String(e);
    }
    ui.busy = false;
    ui.redraw();
  }
  async function insert(it, color) {
    const deck = ctx.currentDeck();
    const c = ctx.cur();
    const i = ctx.slideAt();
    if (!deck || !c || !deck.slides[i]) return;
    if (it.kind === 'video' || it.kind === 'audio') {
      const fn = handlers.get(it.kind);
      if (fn) {
        const next = fn(it, { deck, index: i });
        if (next) ctx.commit(creditInsert(deck, next, it, owners(c)), { toastText: tx(`Added ${it.kind} to slide ${i + 1}`) });
        return;
      }
      ui.busy = true;
      ui.redraw();
      try { // the file goes into this browser's media store and onto the slide (deck-video-ui.js); then its credit
        const mod = await import('./deck-video-ui.js');
        const r = await fetch(it.url);
        if (!r.ok) throw new Error(((await r.json().catch(() => null)) || {}).error || `HTTP ${r.status}`);
        const blob = await r.blob();
        const ext = (/\.([a-z0-9]{2,4})(?:$|\?)/i.exec(it.original || '') || [])[1] || (it.kind === 'video' ? 'webm' : 'mp3');
        const name = `${it.title}${it.author && it.author !== 'Unknown' ? ` — ${it.author}` : ''}`.replace(/[\\/:*?"<>|]+/g, ' ').slice(0, 100);
        const before = ctx.currentDeck();
        if (await mod.addMediaFile(new File([blob], `${name}.${ext}`, { type: blob.type }), i)) {
          const after = ctx.currentDeck();
          const credited = after && creditInsert(before, after, it, owners(c));
          if (credited && credited !== after) ctx.commit(credited, { toastText: tx(`Added to slide ${i + 1}, with its credit on the sources slide`) });
        }
      } catch (e) {
        toast(`${tx('Couldn’t add that')}: ${e.message || e}`);
      }
      ui.busy = false;
      ui.redraw();
      return;
    }
    const alt = String(ui.alt || '').trim();
    if (!alt) { toast(tx('Add alt text first: say what the picture shows.')); root.querySelector('.deck-media-alt')?.focus(); return; }
    ui.busy = true;
    ui.redraw();
    try {
      let data;
      let w = 0;
      let h = 0;
      if (it.kind === 'icon') {
        data = await iconPng(it, color);
        w = 512; h = 512;
      } else {
        let r = await fetch(it.url);
        if (!r.ok && it.thumb) { const small = await fetch(it.thumb).catch(() => null); if (small && small.ok) r = small; } // Openverse can't always make the full size; its preview will do
        if (!r.ok) throw new Error(((await r.json().catch(() => null)) || {}).error || `HTTP ${r.status}`);
        data = await blobToDataUrl(await r.blob());
        if (!/^data:image\/(png|jpeg|gif|webp);base64,/.test(data)) throw new Error('it isn’t a picture');
        w = it.width || 0; h = it.height || 0;
      }
      const latest = ctx.currentDeck() || deck;
      const id = `m${Date.now().toString(36)}${i}`;
      ctx.storeImage(c, id, data, w, h);
      ctx.keepFocus && ctx.keepFocus('media-insert');
      ctx.commit(creditInsert(latest, ctx.setImage(latest, i, id, alt), it, owners(c)), { toastText: tx(`Added to slide ${i + 1}, with its credit on the sources slide`) });
    } catch (e) {
      toast(`${tx('Couldn’t add that')}: ${e.message || e}`);
    }
    ui.busy = false;
    ui.redraw();
  }
  draw();
  return root;
}
