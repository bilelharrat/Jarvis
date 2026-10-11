// EVES on the page (eves.js and eves-model.js, about 85 KB) loads only where the server offers it (meta `eves: true`:
// Eden's server on the Mac; askeden.com doesn't), right after meta, not with the page (askeden opt2-ae-web). This small
// module stands in for it under the same names until then:
//
// - before meta EVES is off anyway (eves.js evesAvailable needs meta), so until eves.js is in, the page is as it was
//   then: the chip hidden, sends without the setting (so no EVES stream can come back), no EVES section in Settings;
// - what eves.js needs from boot is kept and handed over: composer.js's menu handlers (initEves) and the draft
//   (setEvesDraft); a reply drawn with EVES's parts before the load is drawn again once it's in;
// - verify.js's clicks (the label under every reply, all servers) were started by eves.js's initEves: started here.

import { $ } from './util.js';
import { state, ui } from './state.js';
import { initVerify } from './verify.js';
import { lazyModule } from './lazy-load.js';

let H = null; // composer.js's handlers (initEves)
let draft = null; // the composer's text while eves.js loads
let redraw = false; // a reply with EVES's parts was drawn without them
const evesMod = lazyModule('./eves.js', (m) => {
  if (H) m.initEves(H);
  if (draft !== null) m.setEvesDraft(draft);
  draft = null;
  ui.renderComposer();
  if (redraw) { redraw = false; ui.render(); }
  return m;
}, { what: 'EVES' });
const mod = () => evesMod.now();
/** eves.js, loaded once (the tests wait on it). */
export const loadEves = () => evesMod();

const offered = () => !!state.meta && typeof state.meta === 'object' && state.meta.eves === true; // eves-model.js evesOffered
/** After every meta load (app.js reloadMeta): eves.js loads once the server offers EVES. */
export function evesMetaReady() { if (offered() && !mod()) evesMod().catch(() => {}); }

export function initEves(handlers) {
  H = { ...(H || {}), ...handlers };
  initVerify();
  const m = mod();
  if (m) m.initEves(handlers);
}
export function setEvesDraft(text) {
  const m = mod();
  if (m) m.setEvesDraft(text); else draft = String(text || '');
}
/** The chip: what eves.js draws when EVES isn't available, until it's in. */
export function renderEvesChip() {
  const m = mod();
  if (m) { m.renderEvesChip(); return; }
  const b = $('jc-eves');
  if (b) b.hidden = true;
  if (typeof document !== 'undefined' && document.body) document.body.classList.remove('eves-draft');
}
export function withEvesSetting(settings) { const m = mod(); return m ? m.withEvesSetting(settings) : settings; }
export function evesWanted(c, user, text) { const m = mod(); return m ? m.evesWanted(c, user, text) : null; }
/** Only reached once eves.js is in: an EVES run starts from evesWanted, or from a stream the setting asked for. */
export function beginEves(node, plan, ctrl, onChange) { return mod().beginEves(node, plan, ctrl, onChange); }
export function decorateEves(m, c, node) {
  const e = mod();
  if (e) return e.decorateEves(m, c, node);
  if (node && node.role === 'assistant' && node.eves) { redraw = true; evesMod().catch(() => {}); }
  return m;
}
export function evesSettings() { const m = mod(); return m ? m.evesSettings() : null; }
