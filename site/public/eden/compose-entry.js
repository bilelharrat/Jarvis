// The compose windows' way in (efficiency pass 2), kept tiny so the page doesn't load compose.js
// (with compose-marks.js, about 190 KB) until an email is written: Mail, the palette, a chat's
// "Open in Mail", Eden's tools and Meetings call openCompose here. compose.js is set up (its
// handlers from mail.js, the From addresses, the emails left open) when it first loads, and at
// once at startup when an email was being written as the page closed (they come back minimised).
// Signatures (below) start their sync at load, without the windows; compose.js reads and writes
// them through sigStore.

import { lazy, store, addStylesheet } from './util.js';
import { untilStopped } from './resilience.js';
import { getJSON, postJSON } from './api.js';
import { state } from './state.js';
import { syncItem } from './sync.js';

let H = null; // mail.js's handlers (openDialog, closeDialog, jarvisAvailable, jarvisReason, onSent)
let ready = null; // compose.js's first look at the From addresses (Gmail, Mail on the Mac)
// compose.css too (it stood just before mail.css in index.html: put back there), loaded before a window shows
const mod = lazy(() => Promise.all([import('./compose.js'), addStylesheet(new URL('./compose.css', import.meta.url).href, 'compose', 'link[href="mail.css"]')])
  .then(([m]) => { ready = m.initCompose(H || {}); return m; }), [new URL('./compose.js', import.meta.url).href]);

/** Markdown's bold, italics and links as plain text (plain-text windows, previews). */
export const stripMd = (t) => String(t || '').replace(/\*\*([^*]+)\*\*|__([^_]+)__/g, '$1$2').replace(/(^|[^*])\*([^*\n]+)\*/g, '$1$2').replace(/\[([^\]]+)\]\((https?:[^)]+)\)/g, '$1 ($2)');

/** handlers: { openDialog, closeDialog, jarvisAvailable, jarvisReason, onSent } (mail.js, at startup). */
export function initCompose(handlers) {
  H = handlers;
  let open = [];
  try { open = store.get('eden:compose:open', []); } catch { /* storage off */ }
  if (Array.isArray(open) && open.length) mod({ quiet: true }).catch(() => {}); // compose.js's K.open: bring them back now
}

/** A compose window (compose.js openCompose's options). With no `source`, it waits (≤1.5 s) to know the accounts first. */
export function openCompose(opts = {}) {
  return mod().then(async (m) => {
    if (!opts.source && ready) await untilStopped(ready, null, 1500).catch(() => {});
    return m.openCompose(opts);
  }, () => null);
}

/** A reply written without a window (Auto Drafts): compose.js's draftReplyText. */
export const draftReplyText = (m, opts) => mod({ quiet: true }).then((c) => c.draftReplyText(m, opts));

const K = { sigs: 'eden:mail:signatures' };

/* ================= signatures (per address) =================
   Kept by Eden's server on the Mac (GET/POST /api/chat/signatures: every browser there has the
   same ones); on askeden.com, the `eden/signatures` item of the account's end-to-end encrypted
   sync (when Sync is on; otherwise this browser only). This browser keeps a copy either way, so a
   window opens with its signature at once; the later change (`at`) wins. */
let sigSyncHook = null;
export const sigStore = {
  get() { const v = store.get(K.sigs, null); return v && Array.isArray(v.list) ? { list: v.list, defaults: v.defaults || {}, at: v.at || 0 } : { list: [], defaults: {}, at: 0 }; },
  /** `from`: another browser's copy (the server's, or synced): kept here only. */
  set(v, { from = false } = {}) {
    const next = { list: v.list, defaults: v.defaults || {}, at: from ? v.at || 0 : Date.now() };
    store.set(K.sigs, next);
    if (from) return;
    if (state.meta && state.meta.hosted) { if (sigSyncHook) sigSyncHook.changed(); return; }
    postJSON('/api/chat/signatures', next).then((kept) => { if (kept && kept.at > next.at) sigStore.set(kept, { from: true }); }, () => { /* pushed again at the next load */ });
  },
};
const hasSigs = (v) => v.list.length > 0 || Object.keys(v.defaults).length > 0;
/** After the page knows where it runs (state.meta): the server's signatures, or the synced ones. */
export async function initSignatures() {
  if (state.meta && state.meta.hosted) {
    syncItem({
      key: 'eden/signatures',
      value: () => sigStore.get(),
      merge: (theirs) => {
        if (!theirs || !Array.isArray(theirs.list) || !((theirs.at || 0) > sigStore.get().at)) return false;
        sigStore.set(theirs, { from: true });
        return true;
      },
      bind(hook) { sigSyncHook = hook; },
    });
    return;
  }
  try {
    const kept = await getJSON('/api/chat/signatures');
    const mine = sigStore.get();
    if (kept && kept.at > mine.at) sigStore.set(kept, { from: true });
    // this browser's own (from before they were kept by the server, or saved while it was away)
    else if (hasSigs(mine) && (mine.at > kept.at || !hasSigs(kept))) {
      const stored = await postJSON('/api/chat/signatures', { ...mine, at: mine.at || Date.now() });
      if (stored) store.set(K.sigs, stored);
    }
  } catch { /* no server (or an older one): this browser's copy */ }
}
