// The built-in browser's window side (src/jarvis/web/features/browser.js): its pure helpers,
// and a Chinese entry for every sentence it shows. node --test tests/web/
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const WEB = fileURLToPath(new URL('../../src/jarvis/web/', import.meta.url));
const win = require(`${WEB}features/browser.js`);

test('what a site asks for, as the prompt says it', () => {
  assert.equal(win.askText(['microphone', 'camera']), 'wants to use your camera and microphone');
  assert.equal(win.askText(['location']), 'wants to know your location');
  assert.equal(win.askText(['notifications']), 'wants to show notifications');
  assert.equal(win.askText(['clipboard']), 'wants to see what you copy to the clipboard');
  assert.equal(win.onceFits(['camera', 'microphone']), true);
  assert.equal(win.onceFits(['notifications']), false, 'Allow this time is for what a page uses while you’re on it');
});

// The window's sentences in browser.js: its quoted texts that read as words (not class names,
// channels, markup or code).
function sentences(source) {
  const found = new Set();
  for (const m of source.matchAll(/'((?:[^'\\\n]|\\.)*)'/g)) {
    const text = m[1];
    if (!/[A-Za-z]/.test(text) || text.startsWith('<') || /^[a-z0-9:_.#\- ]+$/.test(text) && !/^wants to /.test(text)) continue;
    if (/^(feature:browser:|data-|aria-|http|M\d|[a-z]+\/)/.test(text) || /[{}()=>;]/.test(text) && !/\{(host|what|a|b)\}/.test(text)) continue;
    if (/^[a-z]+(-[a-z]+)+$/.test(text) || /^[a-z]+[A-Z][A-Za-z]*$/.test(text)) continue; // a class, an attribute (viewBox)
    if (/^(svg|button|select|option|label|section|div|span|strong|small|li|ul|p|b|h3)$/.test(text)) continue;
    found.add(text);
  }
  return found;
}

test('every sentence the browser feature shows has its Chinese', () => {
  const source = readFileSync(`${WEB}features/browser.js`, 'utf8');
  const base = JSON.parse(readFileSync(`${WEB}i18n-zh.json`, 'utf8'));
  const mine = JSON.parse(readFileSync(`${WEB}i18n/browser.json`, 'utf8'));
  const strings = { ...base.strings, ...mine.strings };
  const patterns = [...base.patterns, ...mine.patterns].map(([p, r]) => [new RegExp(p), r]);
  const zh = (text) => strings[text] || (patterns.find(([re]) => re.test(text)) || [])[1];
  const missing = [...sentences(source)].filter((text) => !zh(text.replace(/\\'/g, "'")));
  assert.deepEqual(missing, []);
  // Names put together at run time, as the window shows them.
  for (const text of ['Camera: meet.google.com', 'Forget zoom.us', 'Clipboard: localhost:3000']) assert.ok(zh(text), text);
  assert.ok(!zh('Forget the old folder and everything in it?') || strings['Forget the old folder and everything in it?'], 'a pattern caught a sentence');
});
