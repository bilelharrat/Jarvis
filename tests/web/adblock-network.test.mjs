// The browser's ad blocker on the network side (app/main.js's readyAdblock): node --test tests/web/
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const MAIN = fileURLToPath(new URL('../../app/main.js', import.meta.url));
const require = createRequire(MAIN); // the app's own node_modules
const { ElectronBlocker } = require('@ghostery/adblocker-electron');

test('only pages’ and frames’ responses wait for the main thread: the engine changes no other', () => {
  // main.js asks for frames' response headers only (main.js runs in Electron: read from its source)...
  const filter = readFileSync(MAIN, 'utf8').match(/webRequest\.onHeadersReceived\((\{[^}]*\})/)[1];
  assert.match(filter, /urls: \['<all_urls>'\], types: \['mainFrame', 'subFrame'\]/);
  // ...since the engine answers every other response unchanged, on a page a $csp filter is for too.
  const engine = ElectronBlocker.parse("example.test$csp=script-src 'self'", { loadNetworkFilters: true });
  const answer = (resourceType) => {
    let out;
    engine.onHeadersReceived({
      url: 'https://example.test/x', resourceType, referrer: 'https://example.test/', responseHeaders: { 'Content-Type': ['text/html'] },
    }, (response) => { out = response; });
    return out;
  };
  assert.deepEqual(answer('mainFrame').responseHeaders['content-security-policy'], ["script-src 'self'"]);
  for (const type of ['image', 'script', 'stylesheet', 'font', 'xhr', 'media', 'object', 'ping', 'cspReport', 'webSocket', 'other']) {
    assert.deepEqual(answer(type), {}, `the engine changed a ${type}'s headers: main.js must ask for them too`);
  }
});
