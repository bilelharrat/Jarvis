// Eden Slides' media library, the parts without a page (deck-media.js uses them; tests run them in Node):
// icon search over the vendored Lucide set, an icon as standalone SVG, and an item's credit on the sources slide.

import { LIMITS } from './deck-model.js';

export const LUCIDE = { title: 'Lucide icons', author: 'Lucide Contributors', licence: 'ISC', licenceUrl: 'https://lucide.dev/license', page: 'https://lucide.dev', source: 'Lucide' };

// ── icons ──
const STARTER = ['lightbulb', 'target', 'rocket', 'users', 'chart-line', 'shield-check', 'globe', 'leaf', 'heart', 'star', 'clock', 'calendar', 'map-pin', 'mail', 'phone', 'message-circle', 'book-open', 'graduation-cap', 'briefcase', 'dollar-sign', 'trending-up', 'zap', 'settings', 'circle-check'];
const iconItem = (ic) => ({ ...LUCIDE, id: `lucide:${ic.name}`, kind: 'icon', name: ic.name, title: ic.name.replace(/-/g, ' '), svg: ic.svg, url: '', thumb: '', original: '', provider: 'Lucide', authorUrl: '' });
/** Icons whose name or tags hold every word of q; the name counts first. */
export function findIcons(icons, q, max = 60) {
  const words = String(q || '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  if (!words.length) return STARTER.map((n) => icons.find((ic) => ic.name === n)).filter(Boolean).map(iconItem);
  const name = words.join('-');
  const score = (ic) => (ic.name === name ? 0 : ic.name.startsWith(name) ? 1 : words.every((w) => ic.name.includes(w)) ? 2 : words.every((w) => ic.name.includes(w) || ic.tags.includes(w)) ? 3 : 9);
  return icons.map((ic) => [score(ic), ic]).filter(([s]) => s < 9).sort((a, b) => a[0] - b[0] || a[1].name.length - b[1].name.length).slice(0, max).map(([, ic]) => iconItem(ic));
}
export const okColor = (c) => (/^#[0-9a-f]{3,8}$/i.test(String(c || '')) ? c : '#2563eb');
export function iconSvg(item, color = '#2563eb', size = 512) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="${okColor(color)}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${item.svg}</svg>`;
}

// ── attribution ──
/** “Title” by Author · CC BY 4.0 · Openverse (flickr). */
export function creditLine(item) {
  if (!item) return '';
  if (item.kind === 'icon' || item.source === 'Lucide') return `Icons: ${LUCIDE.title} · ${LUCIDE.licence} licence`;
  const kind = { photo: 'Photo', video: 'Video', audio: 'Audio' }[item.kind] || 'Media';
  const by = item.author && item.author !== 'Unknown' ? ` by ${item.author}` : '';
  const via = item.provider && item.provider.toLowerCase() !== String(item.source || '').toLowerCase() ? `${item.source} (${item.provider})` : item.source;
  return `${kind}: “${item.title}”${by} · ${item.licence}${via ? ` · ${via}` : ''}`.slice(0, 200);
}
/** The deck with item's credit in its sources (once; the sources slide is drawn from them). */
export function addCredit(deck, item) {
  if (!deck || !item) return deck;
  const sources = Array.isArray(deck.sources) ? deck.sources : [];
  const title = creditLine(item);
  const url = item.kind === 'icon' ? LUCIDE.licenceUrl : item.page || item.licenceUrl || '';
  if (sources.some((s) => s.title === title || (url && s.url === url)) || sources.length >= LIMITS.sources) return deck;
  const n = sources.reduce((m, s) => Math.max(m, Number(s.n) || 0), 0) + 1;
  return { ...deck, sources: [...sources, { n, title, ...(url ? { url } : {}) }] };
}

/** The picture and media ids a deck uses (slide pictures, video/audio files and posters, free-form pictures, logos). */
export function mediaIds(deck) {
  const out = new Set();
  const walk = (v, key) => {
    if (typeof v === 'string') { if (/^(image|src|poster|logo)$/.test(key) && /^[A-Za-z][\w-]{2,80}$/.test(v)) out.add(v); return; }
    if (Array.isArray(v)) { for (const x of v) walk(x, key); return; }
    if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) if (k !== 'sources') walk(x, k);
  };
  walk(deck, '');
  return out;
}
/**
 * `after` (the deck once item's file is on a slide) with item's credit, and the ids the insert added recorded in
 * owners[credit] (the conversation's c.deckCredits), so pruneCredits can drop the credit when they're all gone.
 */
export function creditInsert(before, after, item, owners) {
  if (!after) return after;
  const had = before ? mediaIds(before) : new Set();
  const fresh = [...mediaIds(after)].filter((id) => !had.has(id));
  const title = creditLine(item);
  if (owners && fresh.length) owners[title] = [...new Set([...(owners[title] || []), ...fresh])].slice(-200);
  return addCredit(after, item);
}
/** The deck without the media-library credits whose pictures and clips no slide uses any more (other sources stay). */
export function pruneCredits(deck, owners) {
  if (!deck || !Array.isArray(deck.sources) || !deck.sources.length || !owners) return deck;
  const used = mediaIds(deck);
  const keep = deck.sources.filter((s) => { const ids = owners[s.title]; return !Array.isArray(ids) || !ids.length || ids.some((id) => used.has(id)); });
  return keep.length === deck.sources.length ? deck : { ...deck, sources: keep };
}
