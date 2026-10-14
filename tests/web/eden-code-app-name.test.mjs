// The app's own name in Eden Code's window (round 3, U3-6): the window's features said "Eden
// Secretary" (the assistant's name) in a dozen places of Eden Code's own window. Each such
// sentence now goes through jarvisFeatures.own(secretary, code) (app.js), which picks Eden
// Code's whole sentence in Eden Code's window, and each of the two has its Chinese.
// The window's own audit of what shows is tests/web/eden-code-names.e2e.cjs. node --test tests/web/
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import test from 'node:test';

const WEB = new URL('../../src/jarvis/web/', import.meta.url);
const read = (p) => readFileSync(new URL(p, WEB), 'utf8');
const FILES = ['code_issues.js', 'code-health.js', 'code-lessons.js', 'code-mcp.js', 'code-receipts.js', 'code-rules.js', 'code-handoff.js', 'code-router.js'];
const NAMES = /Eden Secretary|Jarvis|JARVIS|J\.A\.R\.V\.I\.S/;

const zh = (() => {
  const base = JSON.parse(read('i18n-zh.json'));
  const strings = { ...base.strings };
  const patterns = [...base.patterns];
  for (const f of readdirSync(new URL('i18n/', WEB))) {
    const j = JSON.parse(read(`i18n/${f}`));
    Object.assign(strings, j.strings || {});
    patterns.push(...(j.patterns || []));
  }
  return (s) => strings[s] !== undefined || patterns.some(([p]) => new RegExp(p).test(s));
})();

test('app.js gives features the app’s own name: Eden Code in Eden Code’s window', () => {
  const app = read('app.js');
  assert.match(app, /appName: \(\) => \(inEdenCode \? 'Eden Code' : 'Eden Secretary'\)/);
  assert.match(app, /own: \(secretary, code\) => \(inEdenCode \? code : secretary\)/);
  // Eden Code's settings: the default model isn't "Same as Eden Secretary" there.
  assert.match(app, /inEdenCode \? `Eden’s default \(\$\{same\}\)` : `Same as Eden Secretary \(\$\{same\}\)`/);
  assert.ok(zh('Eden’s default (Claude Sonnet)'));
});

test('every sentence of Eden Code’s features that names Eden Secretary has an Eden Code twin, both in Chinese', () => {
  for (const file of FILES) {
    const src = read(`features/${file}`);
    const pairs = [...src.matchAll(/own\(\s*'((?:[^'\\]|\\.)*)',\s*'((?:[^'\\]|\\.)*)'\s*\)/g)].map((m) => [m[1], m[2]]);
    const firsts = new Set(pairs.map(([a]) => a));
    // Every literal naming the assistant is the first of an own(…) pair (or the SCOPES entry
    // code-mcp.js reads through own()).
    const code = src.replace(/(^|\s)\/\/.*$/gm, '$1');  // (comments, which aren't shown)
    for (const [, text] of code.matchAll(/'((?:[^'\\\n]|\\.)*)'/g)) {
      if (!NAMES.test(text)) continue;
      const viaScopes = file === 'code-mcp.js' && text === 'From Eden Secretary or a plugin' && src.includes("own(SCOPES.other, 'From Eden Code or a plugin')");
      assert.ok(firsts.has(text) || viaScopes, `${file}: “${text}” is shown in Eden Code as it is`);
    }
    for (const [secretary, code] of pairs) {
      assert.doesNotMatch(code, NAMES, `${file}: ${code}`);
      assert.ok(zh(secretary), `${file}: no Chinese for “${secretary}”`);
      assert.ok(zh(code), `${file}: no Chinese for “${code}”`);
    }
    if (pairs.length) assert.match(src, /const own = F\.own \|\| \(\(secretary\) => secretary\);/, file);
  }
});
