// The read-only page for a shared chat (ROADMAP Q3), at /s/<id>#<key> on askeden.com and on the
// Mac's Eden server: fetches the encrypted snapshot (/s/<id>/data), opens it with the key in the
// link's #fragment (never sent to the server; share-model.js says why), and draws it as untrusted
// Markdown (share-render.js). No sign-in, no cookies, nothing else is fetched.

import { el, copyText } from './util.js';
import { openSnapshot, keyFromHash, idFromPath } from './share-model.js';
import { renderSnapshot, wireSnapshot } from './share-render.js';

const main = document.getElementById('shr');
const say = (title, words) => { main.replaceChildren(el('div', 'shr-note-box', el('h1', 'shr-title', title), el('p', 'shr-note', words))); document.title = `${title} · Eden`; };

async function show() {
  const id = idFromPath(location.pathname);
  const key = keyFromHash(location.hash);
  if (!id) { say('This link isn’t right', 'Ask whoever shared it for the link again.'); return; }
  if (!key) { say('This link is missing its key', 'A shared chat’s link ends with # and a key. Ask for the whole link: it may have been cut off when it was copied.'); return; }
  let r;
  try { r = await fetch(`/s/${id}/data`, { credentials: 'omit', cache: 'no-store', referrerPolicy: 'no-referrer' }); } catch { say('Couldn’t load this chat', 'Check your connection and reload.'); return; }
  if (r.status === 404 || r.status === 410) { say('This shared chat isn’t here', 'It was revoked, it expired, or the link is wrong. Ask whoever shared it for a new one.'); return; }
  if (r.status === 429) { say('Slow down', 'Too many shared chats from this network in a minute. Wait a moment, then reload.'); return; }
  if (!r.ok) { say('Couldn’t load this chat', 'Something went wrong. Reload to try again.'); return; }
  try {
    const { blob, expires } = await r.json();
    const snap = await openSnapshot(blob, key);
    const view = renderSnapshot(snap);
    if (expires) view.querySelector('.shr-sub').append(` · until ${new Date(expires).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}`);
    main.replaceChildren(view);
    wireSnapshot(main, (t) => copyText(t));
    document.title = `${snap.title} · Eden`;
  } catch (e) { say('Couldn’t open this chat', e.message || 'The link’s key doesn’t open it.'); }
}

addEventListener('hashchange', show);
show();
