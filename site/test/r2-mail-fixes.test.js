// Bug sweep round 2, Ask Eden Mail on askeden.com (askeden docs/bug-sweep/r2-ask-eden-mail.md, AM2-9): Gmail's batch
// endpoint, once it failed as a whole, is skipped for a while. The Worker makes a Gmail client per request, so the
// switch must live outside it (one holder per isolate, handed to every client), or it lasted one request.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../src/eden/google-data.js', import.meta.url), 'utf8');

test('AM2-9: every Gmail client the Worker makes shares one module-level batch switch', () => {
  assert.match(src, /^const gmailBatch = \{ offUntil: 0 \};$/m, 'module level: lives as long as the isolate');
  const made = [...src.matchAll(/createGmailApi\(\{([^\n]*)\}\)/g)].map((m) => m[1]);
  assert.ok(made.length >= 1);
  for (const opts of made) assert.match(opts, /batch: gmailBatch/, opts);
});
