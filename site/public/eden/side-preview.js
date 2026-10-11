// The sidebar's first paint before the chats' bodies load (askeden opt2-ae-web), apart from app.js so it can be tested:
// the list records (convstore.js eden-chat-list) stand in for the chats in the sidebar until the bodies are in. While
// they show, a tap or right-click in the sidebar is held (no stand-in reaches a handler: renaming or deleting one would
// act on a copy with no messages) and done once startup is wired: a chat opens, any other button is pressed again.
// The stand-ins end when the bodies are read, or when reading them failed (an empty list then, never a held sidebar).

/** → the stand-ins for `records` (no messages; `remote` lets the Continue card count one that has some). */
// (the records are this read's own objects, so they're made into stand-ins in place: no second copy of thousands)
export const standIns = (records) => { for (const r of records) Object.assign(r, { nodes: {}, root: { children: [], sel: 0 }, remote: r.remote || r.has }); return records; };

/**
 * The sidebar's hold while stand-ins show. `nav` is the sidebar's scroller (#sideScroll).
 * → { show(records, current), showing(), convs(), current(), end(), replay({ chat(id), open(chat), buttons() }) }
 */
export function sidePreview(nav) {
  let shown = null; // { convs, current }
  let held = null; // { cid } or { label }
  const hold = (e) => {
    const b = e.target && e.target.closest ? e.target.closest('button') : null;
    e.preventDefault();
    e.stopPropagation();
    if (b && e.type === 'click') held = b.dataset && b.dataset.cid ? { cid: b.dataset.cid } : { label: b.getAttribute('aria-label') || b.title || '' };
  };
  const release = () => {
    nav.removeEventListener('click', hold, true);
    nav.removeEventListener('contextmenu', hold, true);
  };
  return {
    show(records, current) {
      if (!records || !records.length || shown) return false;
      shown = { convs: standIns(records), current };
      nav.addEventListener('click', hold, true);
      nav.addEventListener('contextmenu', hold, true);
      return true;
    },
    showing: () => Boolean(shown),
    convs: () => (shown ? shown.convs : null),
    current: () => (shown ? shown.current : null),
    /** The real list is (about to be) drawn: taps reach it again. */
    end() {
      if (!shown) return false;
      shown = null;
      release();
      return true;
    },
    /** The tap held meanwhile, done now. `chat(id)` finds a loaded chat, `open(c)` opens it, `buttons()` the sidebar's buttons. */
    replay({ chat, open, buttons }) {
      const h = held;
      held = null;
      if (!h) return;
      if (h.cid) { const c = chat(h.cid); if (c) open(c); return; }
      if (h.label) { const b = buttons().find((x) => (x.getAttribute('aria-label') || x.title || '') === h.label); if (b) b.click(); }
    },
  };
}

/**
 * Startup's order: the records first (IndexedDB reads in turn, and two reads at once slowed the small one 2-3×), the
 * bodies asked for next, the stand-ins drawn while they're read, then the stand-ins end, whether the bodies came or
 * the read failed (`failed(e)` is told). → resolves once the stand-ins have ended.
 */
export async function bootList({ records, bodies, show, end, failed = () => {} }) {
  let recs = null;
  try { recs = await records(); } catch { recs = null; }
  let reading; // asked for before the stand-ins are drawn, so IndexedDB reads them meanwhile
  try { reading = Promise.resolve(bodies()); } catch (e) { reading = Promise.reject(e); }
  try { show(recs); } catch { /* the first paint is a hint: the real list follows */ }
  try { await reading; } catch (e) { failed(e); } finally { end(); }
}
