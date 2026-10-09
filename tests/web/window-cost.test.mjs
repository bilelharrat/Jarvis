// What keeps the window cheap to draw, checked in its source (window.e2e.cjs checks the same
// in a real page).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const web = (f) => readFileSync(new URL(`../../src/jarvis/web/${f}`, import.meta.url), 'utf8');

test('a body:has() rule asks only the body’s own children, never the whole page', () => {
  // body:has(#cc…) searched every element of the page again after any change anywhere in it
  // (a streamed word, a step of a session): about a millisecond each time with Eden Code open.
  for (const file of ['app.css', 'obsidian.css', 'stark-glass.css', 'simulator.css', 'remote.css']) {
    const css = web(file).replace(/\/\*[\s\S]*?\*\//g, '');  // (the comments say body:has() too)
    const rules = css.match(/\bbody(?:\[[^\]]*\]|\.[\w-]+)*:has\([^)]*\)/g) || [];
    for (const rule of rules) assert.match(rule, /:has\(> /, `${file}: ${rule}`);
  }
  assert.equal((web('app.css').match(/body:has\(> #(cc|settings|accounts):not\(\[hidden\]\)\)/g) || []).length, 5);
});

test('the panels those rules ask about are the body’s own children', () => {
  const html = web('index.html');
  const body = html.slice(html.indexOf('<body'), html.indexOf('</body>'));
  for (const [tag, id] of [['section', 'cc'], ['aside', 'settings'], ['aside', 'accounts']]) {
    assert.match(body, new RegExp(`\\n<${tag} id="${id}"`), `#${id} is not at the body's top level`);
  }
});
