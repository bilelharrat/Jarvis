import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Deploy gate for the iPhone/iPad "no zoom, no sideways drift" lock (askeden/web/chat/app-lock.js). It has come back
// before when a stale copy of the chat pages was synced or deployed: this checks what is about to ship (public/eden).
const here = path.dirname(fileURLToPath(import.meta.url));
const eden = path.resolve(here, '..', 'public', 'eden');
const read = (f) => readFileSync(path.join(eden, f), 'utf8');

test('shipped pages load app-lock.js first, and the file keeps every part of the lock', () => {
  for (const page of ['index.html', 'edu.html', 'share.html']) {
    const html = read(page);
    const at = html.indexOf('<script src="app-lock.js"');
    if (page !== 'share.html') assert.ok(html.includes('<script src="app-lock.js" data-snap></script>'), `${page} needs data-snap`);
    assert.ok(at >= 0, `public/eden/${page} lost app-lock.js: run scripts/sync-eden.mjs from the current askeden repo`);
    const other = html.search(/<script\b(?![^>]*app-lock\.js)/);
    assert.ok(other < 0 || at < other, `${page}: app-lock.js must come before the other scripts`);
  }
  const js = read('app-lock.js');
  for (const part of ['EdenApp', 'maximum-scale=1', 'user-scalable=no', 'MutationObserver', 'touch-action:pan-y', 'overscroll-behavior-x:none', 'gesturestart', 'window.scrollTo(0, 0)', 'overscroll-behavior:contain', '#scrollcol', 'scrollsSideways', 'g.block', 'e.cancelable', 'lockdiag', 'PANES', '{overflow-x:hidden}', 'canScrollY']) {
    assert.ok(js.includes(part), `public/eden/app-lock.js lost: ${part}`);
  }
  assert.match(read('app.js'), /maximum-scale=1, user-scalable=no/);
});
