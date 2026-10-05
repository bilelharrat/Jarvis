// What keeps the feature modules' stylesheets (web/features/*.css) cheap to apply, checked in
// their source (code-logbook.e2e.cjs checks the rules still place what they place, in a real
// page). node --test tests/web/
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import test from 'node:test';

const WEB = new URL('../../src/jarvis/web/', import.meta.url);
const read = (f) => readFileSync(new URL(f, WEB), 'utf8');

test('a feature’s body:has() rule asks only the body’s own children, never the whole page', () => {
  // body:has(#cc…) searched every element of the page again after any change anywhere in it, a
  // streamed word of a session included, and restyled the page each frame for it: about 0.4 ms
  // a frame (style 0.5 ms → 0.1 ms) while a session wrote, in Obsidian or a split pane.
  const html = read('index.html');
  const body = html.slice(html.indexOf('<body'), html.indexOf('</body>'));
  let seen = 0;
  for (const file of readdirSync(new URL('features/', WEB)).filter((f) => f.endsWith('.css')).sort()) {
    const css = read(`features/${file}`).replace(/\/\*[\s\S]*?\*\//g, '');  // (comments say body:has() too)
    for (const rule of css.match(/(?<![\w.#-])body(?:\[[^\]]*\]|\.[\w-]+)*:has\([^)]*\)/g) || []) {
      seen += 1;
      const m = /:has\(> #([\w-]+)/.exec(rule);
      assert.ok(m, `${file}: ${rule} looks through the whole page`);
      // …and what it asks about is one of those children (index.html puts each at its top level)
      assert.match(body, new RegExp(`\\n<\\w+ id="${m[1]}"`), `${file}: #${m[1]} is not at the body's top level`);
    }
  }
  assert.ok(seen >= 2, `only ${seen} body:has() rules found: the pattern no longer reads them`);
});
