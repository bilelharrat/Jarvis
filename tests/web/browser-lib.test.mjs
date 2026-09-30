// The built-in browser's everyday logic (app/browser-lib.js): node --test tests/web/
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const lib = require('../../app/browser-lib.js');

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) J.A.R.V.I.S./0.1.0 Chrome/152.0.7977.130 Electron/44.4.5 Safari/537.36';

test('the user agent loses the app’s name and Electron, and nothing else', () => {
  assert.equal(lib.cleanUserAgent(UA, 'J.A.R.V.I.S.'),
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.7977.130 Safari/537.36');
  assert.equal(lib.cleanUserAgent('Mozilla/5.0 Chrome/1 Safari/537.36', 'J.A.R.V.I.S.'), 'Mozilla/5.0 Chrome/1 Safari/537.36');
  assert.ok(!lib.cleanUserAgent(UA.replace('J.A.R.V.I.S.', 'JaRViS'), 'J.A.R.V.I.S.').includes('Electron'));
  assert.equal(lib.cleanUserAgent(UA, 'J.A.R.V.I.S.').includes('JARVIS'), false);
  assert.equal(lib.cleanUserAgent('', 'x'), '');
});
