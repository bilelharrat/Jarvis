// Eden News inside the chat app (owner, 2026-10-16: "build this one", the mockup's feed): askeden.com's News, in
// News' own look (site public/news/news.css: Apple News idiom), as a panel over the chat. Stories come from the same
// API as askedennews.com (GET /api/news/feed); their pictures through /api/news/image (the chat page allows images
// from askeden.com only). A story opens in the panel; "Ask Eden" starts a chat with the story as context.

import { el, ico } from './util.js';
import { t as tx, locale } from './i18n.js';

let pane = null;
let data = null;
let tab = 'forYou';
let story = null;
let loading = null;

const DOTS = ['#0a84ff', '#ff9f0a', '#30d158', '#bf5af2', '#ff375f', '#64d2ff'];
const dotFor = (name = '') => DOTS[[...String(name)].reduce((n, c) => (n + c.charCodeAt(0)) % DOTS.length, 0)];
const pic = (url) => (url && /^https:\/\//.test(url) ? `/api/news/image?u=${encodeURIComponent(url)}` : '');
const ago = (ms) => {
  const m = Math.max(1, Math.round((Date.now() - ms) / 60000));
  return m < 60 ? `${m} min` : m < 48 * 60 ? `${Math.round(m / 60)} h` : `${Math.round(m / 1440)} d`;
};

/** Load once a few minutes; the panel paints from the last copy at once. */
async function load(force = false) {
  if (loading) return loading;
  if (data && !force && Date.now() - data._at < 5 * 60_000) return data;
  loading = fetch('/api/news/feed', { credentials: 'same-origin', headers: { accept: 'application/json' } })
    .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
    .then((d) => { data = { ...d, _at: Date.now() }; return data; })
    .finally(() => { loading = null; });
  return loading;
}

function tabsOf(d) {
  const out = [];
  if (d && d.forYou && d.forYou.length) out.push({ id: 'forYou', name: 'For You' });
  out.push({ id: 'top', name: 'Top' });
  for (const s of (d && d.sections) || []) if (s.stories && s.stories.length) out.push({ id: `s:${s.id}`, name: s.name });
  return out;
}
function storiesOf(d, id) {
  if (!d) return [];
  if (id === 'forYou') return d.forYou && d.forYou.length ? d.forYou : [d.lead, ...(d.top || [])].filter(Boolean);
  if (id === 'top') return [d.lead, ...(d.top || [])].filter(Boolean);
  const s = (d.sections || []).find((x) => `s:${x.id}` === id);
  return s ? s.stories : [];
}

const publisher = (s) => el('span', 'nw-pub', el('span', { class: 'nw-dot', style: { background: dotFor(s.source) } }), el('span', { 'data-no-i18n': '' }, s.source || ''),
  s.outlets > 1 ? el('span', 'nw-more', ` + ${s.outlets - 1} ${tx('more')}`) : null);
const meta = (s) => el('span', 'nw-meta',
  s.outlets >= 2 ? el('span', 'nw-check', ico('check', 13), `${s.outlets} ${tx('sources')}`) : null,
  el('span', '', `${s.outlets >= 2 ? '· ' : ''}${ago(s.publishedAt || s.updatedAt || Date.now())} ${tx('ago')}`));

function leadCard(s) {
  const banner = el('span', 'nw-banner', s.image ? el('img', { src: pic(s.image), alt: '', loading: 'lazy' }) : null, el('span', 'nw-kicker', tx('Top story')));
  return el('button', { type: 'button', class: 'nw-card nw-lead', onclick: () => openStory(s) }, banner,
    el('span', 'nw-body', publisher(s), el('span', { class: 'nw-h-lead', 'data-no-i18n': '' }, s.title), meta(s)));
}
function row(s) {
  return el('button', { type: 'button', class: 'nw-row', onclick: () => openStory(s) },
    el('span', 'nw-text', publisher(s), el('span', { class: 'nw-h', 'data-no-i18n': '' }, s.title), meta(s)),
    s.image ? el('img', { class: 'nw-thumb', src: pic(s.image), alt: '', loading: 'lazy' }) : el('span', { class: 'nw-thumb', style: { background: dotFor(s.source) } }));
}

function feedView() {
  const d = data;
  const tabs = tabsOf(d);
  if (!tabs.some((x) => x.id === tab)) tab = tabs[0].id;
  const list = storiesOf(d, tab);
  const date = new Date().toLocaleDateString(locale(), { weekday: 'long', month: 'long', day: 'numeric' });
  const following = (d && d.following) || [];
  return el('div', 'nw-feed',
    el('div', 'nw-hero', el('p', 'nw-eyebrow', date), el('h1', 'nw-title', tx('News'))),
    el('div', { class: 'nw-tabs', role: 'tablist' }, ...tabs.map((x) => el('button', { type: 'button', class: 'nw-tab', role: 'tab', 'aria-selected': String(x.id === tab), onclick: () => { tab = x.id; paint(); } }, tx(x.name)))),
    following.length ? el('div', 'nw-rail', ...following.map((f) => el('span', 'nw-follow', el('span', { class: 'nw-dot', style: { background: dotFor(f.name) } }), el('b', { 'data-no-i18n': '' }, f.name || f.label || ''),
      el('span', `nw-count${f.count ? '' : ' zero'}`, String(f.count || 0))))) : null,
    el('h2', 'nw-sec', tx(tab === 'forYou' ? 'For You' : tab === 'top' ? 'Top Stories' : (tabs.find((x) => x.id === tab) || {}).name || 'Stories')),
    list.length ? leadCard(list[0]) : el('p', 'nw-empty', tx('No stories here right now.')),
    list.length > 1 ? el('div', 'nw-card nw-list', ...list.slice(1, 12).map(row)) : null,
    el('p', 'nw-foot', tx('Eden writes short summaries in its own words and links every story to its publishers. Read the full reporting at the source.')));
}

function storyView(s) {
  const ask = (q) => askAbout(s, q);
  return el('div', 'nw-story',
    el('div', 'nw-story-pic', s.image ? el('img', { src: pic(s.image), alt: '' }) : null, s.image ? el('span', 'nw-credit', `${tx('Photo')}: ${s.source}`) : null),
    el('div', 'nw-story-head', publisher(s), el('h1', { class: 'nw-story-title', 'data-no-i18n': '' }, s.title), meta(s)),
    el('div', 'nw-card nw-summary', s.summary ? el('p', { 'data-no-i18n': '' }, s.summary) : null,
      ...(s.sources || []).slice(0, 6).map((x) => el('a', { class: 'nw-src', href: x.url, target: '_blank', rel: 'noopener noreferrer' }, `${tx('Read at')} ${x.name} ›`))),
    el('h2', 'nw-sec', tx('Ask Eden')),
    el('div', 'nw-chips', ...['Why does this matter to me?', 'What led to this?', 'Explain it simply'].map((q) => el('button', { type: 'button', class: 'nw-chip', onclick: () => ask(tx(q)) }, tx(q)))));
}

function paint() {
  if (!pane) return;
  const body = pane.querySelector('.nw-scroll');
  pane.querySelector('.nw-back').setAttribute('aria-label', story ? tx('Back to News') : tx('Close News'));
  if (!data) body.replaceChildren(el('p', 'nw-empty', loading ? tx('Loading the news…') : tx('News couldn’t load. Try again in a minute.')));
  else body.replaceChildren(story ? storyView(story) : feedView());
  body.scrollTop = 0;
}

function openStory(s) { story = s; paint(); }

/** A chat about the story: its title, summary and sources go along as context (data, never instructions: H8). */
async function askAbout(s, question) {
  closeNews();
  dispatchEvent(new CustomEvent('eden:new-chat')); // a story gets its own chat (app.js), not the one that was open
  const { sendMessage } = await import('./chat.js');
  const text = [s.title, s.summary, ...(s.sources || []).map((x) => `${x.name}: ${x.url}`)].filter(Boolean).join('\n');
  sendMessage(question, [], { context: [{ title: `News: ${s.title}`.slice(0, 200), text, source: 'web' }] });
}

function build() {
  pane = el('section', { class: 'nw', id: 'newsPane', role: 'dialog', 'aria-label': tx('News'), hidden: '' },
    el('div', 'nw-bar',
      el('button', { type: 'button', class: 'nw-round nw-back', onclick: () => { if (story) { story = null; paint(); } else closeNews(); } }, ico('chevl', 18)),
      el('span', 'nw-bar-t', tx('Eden')),
      el('button', { type: 'button', class: 'nw-round', 'aria-label': tx('Refresh'), onclick: () => { data = null; paint(); load(true).then(paint, paint); } }, ico('retry', 16))),
    el('div', 'nw-scroll'),
    el('nav', { class: 'nw-dock', 'aria-label': tx('Eden') },
      el('button', { type: 'button', onclick: () => closeNews() }, ico('chat', 20), el('span', '', tx('Chat'))),
      el('button', { type: 'button', class: 'on', 'aria-current': 'page', onclick: () => { story = null; paint(); } }, ico('news', 20), el('span', '', tx('News')))));
  pane.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.stopPropagation(); closeNews(); } });
  document.body.append(pane);
}

export function openNews() {
  if (!pane) build();
  story = null;
  pane.hidden = false;
  document.documentElement.classList.add('news-open');
  paint();
  load().then(paint, paint);
  pane.querySelector('.nw-back').focus({ preventScroll: true });
}
export function closeNews() {
  if (!pane || pane.hidden) return false;
  pane.hidden = true;
  document.documentElement.classList.remove('news-open');
  return true;
}
export const newsOpen = () => Boolean(pane && !pane.hidden);
