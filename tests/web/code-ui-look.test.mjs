// Eden Code's look, checked in the source (the real look is checked in the app): the page's
// own controls follow the window's light and dark (audit G3, G14: a checkbox was a white
// square on the dark cards: the to-do card's "On the cloud machine", Share live's, the
// Multi-repo picks), and every pane's green chip is styled, not only three panes' (G10).
// node --test tests/web/
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const web = (f) => readFileSync(new URL(`../../src/jarvis/web/${f}`, import.meta.url), 'utf8');

test('checkboxes and selects follow the window’s light or dark, in its blue', () => {
  const css = web('eden-code.css');
  const rule = css.match(/body:not\(\[data-skin\]\) \.deck\.jc \{[^}]*\}/)[0];
  assert.match(rule, /color-scheme: light dark;/);
  assert.match(rule, /accent-color: rgb\(var\(--c-accent\)\);/);
  // The checkboxes it's for are plain native ones inside the deck.
  for (const f of ['features/code-todo.js', 'features/code_share.js', 'features/code-multirepo.js']) {
    assert.match(web(f), /type = 'checkbox'/, f);
  }
});

test('a green chip is green in every pane', () => {
  const css = web('features/code_isolation.css');
  assert.match(css, /^\.jcx-chip\.good \{ color: rgb\(var\(--c-success-ink\)\); background: rgb\(var\(--c-success-soft\)\); \}$/m);
  assert.match(web('features/code-stack.js'), /jcx-chip \$\{p\.state === 'merged' \? 'good'/);
  assert.match(web('features/code-triggers.js'), /jcx-chip \$\{on \? 'good'/);
});
