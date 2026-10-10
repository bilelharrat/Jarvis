// A Slides reply in the chat (ROADMAP Q14): the deck's JSON never shows as a code block; the bubble
// shows its words and this card instead ("Writing slides… 4 so far" while it streams, then the deck
// with Open). render.js draws it; deck.js opens the canvas on `eden:open-deck`.

import { el, ico } from './util.js';
import { splitDeckReply, slidesSoFar, deckFromReply } from './deck-model.js';

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
  let title = 'Slide deck', sub = '', ready = false, problem = '';
  if (node.streaming || !last.closed) {
    const n = slidesSoFar(last.json);
    title = last.kind === 'patch' ? 'Changing the slides…' : 'Writing slides…';
    sub = node.streaming ? (n ? `${n} slide${n === 1 ? '' : 's'} so far` : 'Starting the deck') : 'The deck was cut off before it finished. Try again, or ask for fewer slides.';
    if (!node.streaming) problem = sub;
  } else if (version) {
    ready = true;
    title = version.deck.title;
    sub = `${last.kind === 'patch' ? 'Changed · ' : ''}${version.deck.slides.length} slide${version.deck.slides.length === 1 ? '' : 's'} · ${version.deck.theme && version.deck.theme.base ? version.deck.theme.base.replace('-', ' ') : 'glass'} theme`;
  } else {
    const r = deckFromReply(blocks.map((b) => '```' + (b.kind === 'patch' ? 'deck-patch' : 'deck') + '\n' + b.json + '\n```').join('\n'), null);
    problem = r && r.error ? r.error : '';
    sub = problem || 'Open it in the canvas';
    ready = !problem;
  }
  return el('div', { class: `artlink deck-link${problem ? ' bad' : ''}` },
    ico('art'),
    el('div', 'grow', el('b', ready ? { 'data-no-i18n': '' } : {}, title), el('span', '', sub)),
    ready ? el('button', { type: 'button', class: 'cap', onclick: () => dispatchEvent(new CustomEvent('eden:open-deck', { detail: { c, node } })) }, 'Open') : null);
}
