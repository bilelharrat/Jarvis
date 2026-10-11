// Eden Code's own settings and intro, round 2 (askeden/docs/bug-sweep/r2-eden-code-shell.md): Settings › Eden Code
// opens the Eden Code settings sheet (CH2-4), the sheet is modal for the keyboard (CH2-5), and Eden Code's intro
// ends on an Eden Code card whose scrolling the keyboard can reach (CH2-6). Checked live with headless Chrome and
// axe too (the report's "Fixes (round 2)"). node --test tests/web/
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const web = (name) => readFileSync(new URL(`../../src/jarvis/web/${name}`, import.meta.url), 'utf8');

test('Settings › Eden Code has a way into Eden Code’s own settings, found by searching for them (CH2-4)', () => {
  const html = web('index.html');
  const group = html.slice(html.indexOf('id="jc-settings-group"'), html.indexOf('</section>', html.indexOf('id="jc-settings-group"')));
  assert.match(group, /data-settings-pane="code"/);
  assert.match(group, /data-keywords="[^"]*\bapi keys\b[^"]*\bsnippets\b[^"]*"/);
  assert.match(group, /<button type="button" class="btn" id="open-jc-settings">Open…<\/button>/);
  assert.match(group, /<button type="button" class="btn" id="open-jc-models">Open…<\/button>/);
  // ahead of Voice coding: the first thing in the pane
  assert.ok(html.indexOf('id="jc-settings-group"') < html.indexOf('<h3>Voice coding</h3>'));
  const app = web('app.js');
  assert.match(app, /function openJcSettingsFromSettings\(tab\) \{\n\s+toggleSettings\(false\);\n\s+if \(\$\('cc'\)\.hidden\) toggleCC\(true\);[^\n]*\n\s+openJcSettings\(tab\);/);
  assert.match(app, /\$\('open-jc-settings'\)\.addEventListener\('click', \(\) => openJcSettingsFromSettings\('general'\)\);/);
  assert.match(app, /\$\('open-jc-models'\)\.addEventListener\('click', \(\) => openJcSettingsFromSettings\('models'\)\);/);
});

// The sheet's modal part, run on a small stand-in DOM: what opening makes inert, and closing undoes.
function jcsModalFrom(app) {
  const start = app.indexOf('let jcsInert = [];');
  const end = app.indexOf('function openJcSettings(');
  assert.ok(start > 0 && end > start);
  return app.slice(start, end);
}
function node(name, children = [], extra = {}) {
  const n = { localName: name, inert: false, children, parentElement: null, ...extra };
  for (const c of children) c.parentElement = n;
  return n;
}

test('the Eden Code settings sheet makes everything around it inert while it’s open, and gives it back (CH2-5)', () => {
  const app = web('app.js');
  const sheet = node('div', [], { id: 'jc-settings' });
  const deck = node('div', [], { id: 'deck' });
  const cc = node('section', [deck, sheet], { id: 'cc' });
  const header = node('header');
  const script = node('script');
  const already = node('div', [], { inert: true });
  const body = node('body', [header, cc, script, already]);
  const ctx = { $: (id) => (id === 'jc-settings' ? sheet : null), document: { body } };
  vm.runInNewContext(`${jcsModalFrom(app)}; this.jcsModal = jcsModal;`, ctx);
  ctx.jcsModal(true);
  assert.deepEqual([deck.inert, header.inert, cc.inert, sheet.inert, script.inert], [true, true, false, false, false]);
  ctx.jcsModal(false);
  assert.deepEqual([deck.inert, header.inert, already.inert], [false, false, true]); // what was inert before stays so
  // opening: the opener is kept, the inert set made after Settings' own closing (a microtask), focus put back in it
  assert.match(app, /queueMicrotask\(\(\) => \{\n\s+if \(\$\('jc-settings'\)\.hidden\) return;\n\s+jcsModal\(true\);/);
  // closing: inert undone, focus back to the opener when it's still on screen, else the composer
  assert.match(app, /function closeJcSettings\(\) \{[\s\S]*?jcsModal\(false\);[\s\S]*?back\.focus\(\);\n\s+else \$\('deck-input'\)\.focus\(\);/);
});

test('Eden Code’s intro ends on an Eden Code card, and a card that scrolls can be scrolled from the keyboard (CH2-6)', () => {
  const intro = web('features/intro.js');
  const done = intro.slice(intro.indexOf('    // done'), intro.indexOf('  function micCard()'));
  const eden = done.slice(done.indexOf('if (EDEN) {'), done.indexOf('    for (const said of [\'“Eden, what’s on my calendar today?”\''));
  assert.match(eden, /primary: 'Start using Eden Code'/);
  assert.match(eden, /Run the tests and fix what fails/);
  assert.doesNotMatch(eden, /calendar|brief me|open Eden Code|Health & safety/);
  assert.match(eden, /Settings › Privacy & Safety › Set up Eden again…/);
  // Eden's own card is as it was
  assert.match(done, /primary: 'Start using Eden',/);
  assert.match(intro, /card\.scrollTop = scroll;\n\s+keyboardScroll\(card\);/);
  // the scroll check, on stand-ins
  const start = intro.indexOf('  const TABBABLE =');
  const fn = intro.slice(start, intro.indexOf('  window.addEventListener(\'resize\'', start));
  const ctx = {};
  vm.runInNewContext(`${fn}; this.keyboardScroll = keyboardScroll;`, ctx);
  const card = (scrolls, tabbable) => ({
    scrollHeight: scrolls ? 900 : 400, clientHeight: 400, attrs: {}, tabIndex: -1,
    querySelector: () => (tabbable ? {} : null),
    setAttribute(k, v) { this.attrs[k] = v; }, removeAttribute(k) { delete this.attrs[k]; if (k === 'tabindex') this.tabIndex = -1; },
  });
  const tall = card(true, false);
  ctx.keyboardScroll(tall);
  assert.equal(tall.tabIndex, 0);
  assert.equal(tall.attrs['aria-labelledby'], 'intro-title');
  const withButtons = card(true, true);
  ctx.keyboardScroll(withButtons);
  assert.equal(withButtons.tabIndex, -1);
  const short = card(false, false);
  ctx.keyboardScroll(short);
  assert.equal(short.tabIndex, -1);
});
