/* Mail signatures (per address), as compose.js keeps them. Kept by Eden's server on the Mac
   (GET/POST /api/chat/signatures: every browser there has the same ones); on askeden.com, the
   `eden/signatures` item of the account's end-to-end encrypted sync (when Sync is on; otherwise this
   browser only). This browser keeps a copy either way, so a window opens with its signature at once;
   the later change (`at`) wins. Apart from compose.js so askeden.com joins the synced item at startup
   while Compose itself loads on first use (mail-lazy.js, opt1-ae-web). */
import { store } from './util.js';
import { state } from './state.js';
import { postJSON } from './api.js';

export const SIGS_KEY = 'eden:mail:signatures';
let sigSyncHook = null;
export const sigStore = {
  get() { const v = store.get(SIGS_KEY, null); return v && Array.isArray(v.list) ? { list: v.list, defaults: v.defaults || {}, at: v.at || 0 } : { list: [], defaults: {}, at: 0 }; },
  /** `from`: another browser's copy (the server's, or synced): kept here only. */
  set(v, { from = false } = {}) {
    const next = { list: v.list, defaults: v.defaults || {}, at: from ? v.at || 0 : Date.now() };
    store.set(SIGS_KEY, next);
    if (from) return;
    if (state.meta && state.meta.hosted) { if (sigSyncHook) sigSyncHook.changed(); return; }
    postJSON('/api/chat/signatures', next).then((kept) => { if (kept && kept.at > next.at) sigStore.set(kept, { from: true }); }, () => { /* pushed again at the next load */ });
  },
};
export const hasSigs = (v) => v.list.length > 0 || Object.keys(v.defaults).length > 0;
/** askeden.com: the signatures' item in the end-to-end encrypted sync (sync.js syncItem). */
export const signaturesSyncItem = {
  key: 'eden/signatures',
  value: () => sigStore.get(),
  merge: (theirs) => {
    if (!theirs || !Array.isArray(theirs.list) || !((theirs.at || 0) > sigStore.get().at)) return false;
    sigStore.set(theirs, { from: true });
    return true;
  },
  bind(hook) { sigSyncHook = hook; },
};
