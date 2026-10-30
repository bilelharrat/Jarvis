// A Slides reply in the chat (ROADMAP Q14): the deck's JSON never shows as a code block; the bubble
// shows its words and this card instead ("Writing slides… 4 so far" while it streams, then the deck
// with Open). render.js draws it; deck.js opens the canvas on `eden:open-deck`.

import { el, ico } from './util.js';
import { splitDeckReply, slidesSoFar, deckFromReply, themeOf } from './deck-model.js';
import { IN_APP } from './native.js'; // the responsive card layout (deck-web) is web-only; the iPhone app keeps its card

/** Whether a reply's text has a deck block (cheap test before splitting). */
export const hasDeck = (text) => /(^|\n) {0,3}(`{3,}|~{3,})[ \t]*(deck|deck-patch|slides)[ \t]*\n/.test(String(text || ''));

/** { text, card } for a reply's text part: the words to show, and the card (or null). */
export function deckPart(c, node, text) {
  if (!hasDeck(text)) return { text, card: null };
  const split = splitDeckReply(text);
  return { text: split.text, card: deckCard(c, node, split.blocks) };
}

function deckCard(c, node, blocks) {
  const last = blocks.at(-1);
  const version = (c.deckVersions || []).find((v) => v.nodeId === node.id);
  let title = 'Slide deck', sub = '', ready = false, problem = '', deckObj = null;
  if (node.streaming || !last.closed) {
    const n = slidesSoFar(last.json);
    title = last.kind === 'patch' ? 'Changing the slides…' : 'Writing slides…';
    sub = node.streaming ? (n ? `${n} slide${n === 1 ? '' : 's'} so far` : 'Starting the deck') : 'The deck was cut off before it finished. Try again, or ask for fewer slides.';
    if (!node.streaming) problem = sub;
  } else if (version) {
    ready = true;
    deckObj = version.deck;
    title = deckObj.title;
    const thName = themeOf(deckObj).name;
    sub = `${last.kind === 'patch' ? 'Changed · ' : ''}${deckObj.slides.length} slide${deckObj.slides.length === 1 ? '' : 's'} · ${thName}`;
  } else {
    const r = deckFromReply(blocks.map((b) => '```' + (b.kind === 'patch' ? 'deck-patch' : 'deck') + '\n' + b.json + '\n```').join('\n'), null);
    problem = r && r.error ? r.error : '';
    if (r && r.deck) {
      deckObj = r.deck;
      title = deckObj.title || title;
      const thName = themeOf(deckObj).name;
      sub = `${deckObj.slides.length} slide${deckObj.slides.length === 1 ? '' : 's'} · ${thName}`;
    } else {
      sub = problem || 'Open it in the canvas';
    }
    ready = !problem;
  }

  let miniHero = null;
  if (ready && deckObj && Array.isArray(deckObj.slides) && deckObj.slides.length) {
    const th = themeOf(deckObj);
    const s0 = deckObj.slides[0] || {};
    const validImg = (id) => id && !String(id).startsWith('vis') && c && c.deckImages && c.deckImages[id] ? c.deckImages[id].data : '';
    const coverImg = validImg(s0.image) || validImg((deckObj.slides.find((s) => s && validImg(s.image)) || {}).image);
    const pills = deckObj.slides.slice(0, 4).map((sl, idx) =>
      el('span', 'dc-pill', `${String(idx + 1).padStart(2, '0')} ${(sl.title || sl.kicker || sl.layout || 'Slide').slice(0, 22)}`),
    );
    miniHero = el(
      'div',
      {
        class: 'dc-stage',
        style: `--dc-bg:${th.colors.bg};--dc-bg2:${th.colors.bg2};--dc-fg:${th.colors.text};--dc-mu:${th.colors.muted};--dc-ac:${th.colors.accent};--dc-ac2:${th.colors.accent2}`,
        onclick: () => dispatchEvent(new CustomEvent('eden:open-deck', { detail: { c, node } })),
      },
      el(
        'div',
        'dc-cover',
        el('div', 'dc-cover-txt',
          el('span', 'dc-kicker', s0.kicker || 'PRESENTATION DECK'),
          el('div', { class: 'dc-title', 'data-no-i18n': '' }, s0.title || title),
          s0.subtitle ? el('div', { class: 'dc-sub', 'data-no-i18n': '' }, s0.subtitle) : null,
        ),
        coverImg ? el('div', 'dc-cover-pic', el('img', { src: coverImg, alt: s0.alt || title })) : null,
      ),
      el('div', 'dc-strip', ...pills, deckObj.slides.length > 4 ? el('span', 'dc-pill dc-more', `+${deckObj.slides.length - 4} more`) : null),
    );
  }

  return el('div', { class: `artlink deck-link${problem ? ' bad' : ''}${miniHero ? ' has-stage' : ''}${IN_APP ? '' : ' deck-web'}` },
    miniHero,
    el('div', 'dc-bar',
      ico('art'),
      el('div', 'grow', el('b', ready ? { 'data-no-i18n': '' } : {}, title), el('span', '', sub)),
      ready ? el('button', { type: 'button', class: 'cap', onclick: () => dispatchEvent(new CustomEvent('eden:export-deck-pptx', { detail: { c, node } })) }, ico('down', 13), '.pptx') : null,
      ready ? el('button', { type: 'button', class: 'cap primary', onclick: () => dispatchEvent(new CustomEvent('eden:open-deck', { detail: { c, node } })) }, 'Open') : null,
    ));
}
