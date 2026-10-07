// Acting for someone (a delegate, a team space): the page's copy of the grant rule
// (public/eden/acting.js, from askeden web/chat by scripts/sync-eden.mjs) must say what the
// server says (accounts/delegates.js grantAllows and ownRoute) for every route hosted Eden
// answers, so the page never sends what would be a 403 and never hides what would work.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import { grantAllows, ownRoute } from '../src/accounts/delegates.js';
import * as page from '../public/eden/acting.js';

const read = (p) => fs.readFileSync(new URL(p, import.meta.url), 'utf8');

// Every "METHOD /api/…" hosted Eden names (chat.js, google-data.js, tasks.js), and a few more.
function routes() {
  const found = new Set(['GET /api/chat/tasks', 'POST /api/chat/tasks', 'GET /api/chat/published', 'POST /api/chat/publish', 'POST /api/chat/mac/send', 'POST /api/chat/voice']);
  for (const file of ['../src/eden/chat.js', '../src/eden/google-data.js', '../src/accounts/delegates.js']) {
    for (const m of read(file).matchAll(/'((?:GET|POST) \/api\/[a-z/-]+)'/g)) found.add(m[1]);
  }
  return [...found].sort();
}

const GRANTS = [
  { type: 'delegate', id: 'g1', label: 'Bilel', features: ['chat'] },
  { type: 'delegate', id: 'g2', label: 'Bilel', features: ['chat', 'mail'] },
  { type: 'delegate', id: 'g3', label: 'Bilel', features: ['chat', 'calendar'] },
  { type: 'delegate', id: 'g4', label: 'Bilel', features: ['chat', 'mail', 'calendar'] },
  { type: 'space', id: 's1', label: 'Launch', features: ['chat'] },
];

test('the page’s grant rule matches the server’s, route by route, for every kind of grant', () => {
  const all = routes();
  assert.ok(all.length > 25, `found ${all.length} routes`);
  for (const grant of GRANTS) {
    page.setActing(grant);
    for (const route of all) {
      const [method, path] = route.split(' ');
      const server = grantAllows(grant, method, path) || ownRoute(path);
      assert.equal(page.actingAllows(method, path), server, `${grant.type} ${grant.features.join('+')}: ${route}`);
    }
  }
  page.setActing(null);
  for (const route of all) assert.equal(page.actingAllows(...route.split(' ')), true, `not acting: ${route}`);
});
