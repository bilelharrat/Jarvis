// Eden Travel's private things on this device, forgotten when the person isn't the one they were saved for (security
// review M4, 2026-10-28). Kept on the device: the last trips (travel.js eden:travel:saved), paid eSIMs' activation codes
// (travel-esim.js eden.trip.esims.<trip>), and the offline worker's caches (travel-sw.js eden-travel-*: documents, route
// maps, place photos). On a shared or borrowed computer the next person must never see them, so they go:
//   - on every sign-out of this page (state.js forgetOwner: Sign out, Sign out everywhere, account deleted) and on a 401
//     (the 30 days ran out, another device signed this browser out);
//   - when another account signs in here (state.js claimChats → travelOwner): saved items are keyed by account.
// Nothing here talks to the server. Never throws.

const OWNER = 'eden:travel:owner';
const KEYS = [/^eden:travel:/, /^eden\.trip\./]; // eden:travelChatW (a pane width) is no one's secret and stays

/** Everything Eden Travel kept on this device: local storage, the offline worker's caches. → Promise (never rejects) */
export async function forgetTravelDevice() {
  try {
    const ls = globalThis.localStorage;
    if (ls) {
      const gone = [];
      for (let i = 0; i < ls.length; i++) { const k = ls.key(i); if (k && KEYS.some((re) => re.test(k))) gone.push(k); }
      for (const k of gone) ls.removeItem(k);
    }
  } catch { /* storage blocked: nothing kept either */ }
  try {
    if (globalThis.caches) for (const k of await caches.keys()) if (k.startsWith('eden-travel-')) await caches.delete(k);
  } catch { /* no caches here */ }
}

/** This page is signed in to `account` now: what was kept for another account goes first, then it's this one's. */
export function travelOwner(account) {
  if (!account || typeof account !== 'string') return Promise.resolve();
  let was = null;
  try { was = localStorage.getItem(OWNER); } catch { return Promise.resolve(); }
  const done = was !== account ? forgetTravelDevice() : Promise.resolve(); // none yet (kept before accounts were): gone too
  return done.then(() => { try { localStorage.setItem(OWNER, account); } catch { /* blocked */ } });
}
