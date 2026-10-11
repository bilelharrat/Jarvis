// An essay belongs to the chat it was written beside (askeden ROADMAP T20e). The conversation keeps the essay's
// id (c.essayId, set when a message goes with the essay open, or Eden writes in it), so:
// - New chat keeps an open essay beside it (where the canvas sits beside the chat: on a phone or a window up to
//   1100 px it lies over the chat, so the new chat shows, as before);
// - going back to that chat brings its essay back beside it; where it would lie over the chat, or when it was
//   closed, a chip above the composer opens it ("Open your essay");
// - an unrelated chat closes the canvas as before.
// essay.js marks its pane with the essay on screen (data-essay); essay.js itself is loaded only to open one.

import { $, el, ico, toast } from './util.js';
import { state } from './state.js';
import { setWide } from './artifact.js';

const GONE = new Set(); // essays that couldn't be opened (deleted, or not in this browser): no chip for them
let opening = ''; // an essay being opened beside its chat: no chip meanwhile
let chipEl = null;

/** The essay writer beside the chat: the open essay's id, '' for the Essays list, null when it isn't on screen. */
export function essayShown() {
  if (!$('split').classList.contains('art-open') || !$('artifact').classList.contains('essay-on')) return null;
  const p = $('artifact').querySelector('.es-pane');
  return p ? p.dataset.essay || '' : null;
}

/** The canvas sits beside the chat (app.css: up to 1100 px it's a sheet over the chat, on a phone the whole screen). */
const beside = () => matchMedia('(min-width:1101px)').matches;

/** A chat with nothing in it yet (New chat, a new temporary chat): the essay on screen stays for it. */
const fresh = (c) => !c || (c.kind !== 'code' && !Object.keys(c.nodes || {}).length);

/**
 * Switching to chat `c` (app.js switchTo, before it closes the canvas): true when the essay on screen stays,
 * for a new chat or the chat it belongs to. Where the canvas lies over the chat (a phone, a narrow window) it never stays.
 */
export function essayStays(c) {
  const on = essayShown();
  if (on === null || !beside()) return false;
  if (fresh(c)) { setWide(false); return true; } // beside the new chat, not over it
  return !!c.essayId && c.essayId === on;
}

/** After switching to chat `c`: its own essay comes back beside it, or (over the chat, or gone) the chip offers it. */
export function essayFollows(c) {
  if (c && c.essayId && !GONE.has(c.essayId) && beside() && essayShown() !== c.essayId) {
    const id = c.essayId;
    opening = id;
    import('./essay.js')
      .then((m) => (state.current === c ? m.openEssayById(id) : true))
      .then((ok) => { if (!ok) GONE.add(id); })
      .catch(() => {})
      .finally(() => { if (opening === id) opening = ''; chip(); });
  }
  chip();
}

async function openFromChip() {
  const c = state.current;
  if (!c || !c.essayId) return;
  const id = c.essayId;
  try {
    const ok = await (await import('./essay.js')).openEssayById(id);
    if (!ok) { GONE.add(id); toast('That essay isn’t in this browser any more'); }
  } catch (e) { toast(`Couldn’t open the essay writer: ${e.message}`); }
  chip();
}

/** The chip shows in a chat whose essay isn't on screen. */
function chip() {
  const c = state.current;
  const want = !!(c && c.essayId && !GONE.has(c.essayId) && opening !== c.essayId && essayShown() !== c.essayId);
  if (!chipEl) {
    if (!want) return;
    const form = $('deck-composer');
    if (!form) return;
    chipEl = el('button', { type: 'button', class: 'essay-chip', title: 'Open the essay you’re writing in this chat', onclick: openFromChip }, ico('edit', 13), el('span', null, 'Open your essay'));
    form.before(chipEl);
  }
  chipEl.hidden = !want;
}

/** Once, at startup (app.js): the chip follows the canvas, and the chat open at startup gets its essay back. */
export function initEssayChat() {
  const sync = () => chip();
  new MutationObserver(sync).observe($('split'), { attributes: true, attributeFilter: ['class'] });
  new MutationObserver(sync).observe($('artifact'), { attributes: true, attributeFilter: ['class'] });
  new MutationObserver(sync).observe($('artifact'), { attributes: true, attributeFilter: ['data-essay'], subtree: true }); // another essay in the pane
  essayFollows(state.current);
}
