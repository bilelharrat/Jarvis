// Eden Code's glass look (eden-code-glass.css, the "A · Workbench" mockup), checked in the
// source: it loads after eden-code.css, only in Eden Code's own window, and it leaves the
// composer exactly as eden-code.css draws it (the owner asked for the same input bar).
// node --test tests/web/
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const web = (f) => readFileSync(new URL(`../../src/jarvis/web/${f}`, import.meta.url), 'utf8');
const css = web('eden-code-glass.css');
const rules = css.replace(/\/\*[\s\S]*?\*\//g, '');

test('the glass sheet loads right after eden-code.css', () => {
  const page = web('index.html');
  assert.match(page, /href="\/static\/eden-code\.css">\n<link rel="stylesheet" href="\/static\/eden-code-glass\.css">/);
});

test('every rule is Eden Code’s own window, never the Code panel in Eden Secretary', () => {
  for (const block of rules.match(/[^{}]+\{/g)) {
    const sel = block.replace(/\{$/, '').trim();
    if (sel.startsWith('@media')) continue;
    for (const one of sel.split(',')) assert.match(one.trim(), /^body(\.in-app)?\.eden-code:not\(\[data-skin\]\)/, one);
  }
});

test('the composer and its dock are left as they are', () => {
  assert.doesNotMatch(rules, /jc-composer|jc-dock|jc-send|jc-orb|jc-pill|#jc-model|#deck-input/);
});

test('light and dark both have the wallpaper and the panels', () => {
  assert.equal((rules.match(/--ecg-wall:/g) || []).length, 2);
  assert.match(rules, /prefers-color-scheme: dark/);
});

test('in full screen the sidebar drops the room kept for the window buttons', () => {
  assert.match(rules, /\.win-fullscreen \.deck\.jc \.jc-side \{ padding-top: 14px; \}/);
  assert.match(web('app.js'), /onWindowFullscreen\(\(on\) => document\.body\.classList\.toggle\('win-fullscreen', on\)\)/);
  const main = readFileSync(new URL('../../app/main.js', import.meta.url), 'utf8');
  assert.match(main, /win\.on\('enter-full-screen', sendFull\)/);
  assert.match(main, /win\.on\('leave-full-screen', sendFull\)/);
});

test('the composer’s mode pill says just “Bypass”, the menu keeps “Bypass permissions”', () => {
  const js = web('app.js');
  assert.match(js, /\{ id: 'auto', label: 'Bypass permissions', short: 'Bypass',/);
  assert.match(js, /setText\(\$\('jc-mode-label'\), mode\.short \|\| mode\.label\)/);
});

test('editing a sent message is a Liquid Glass pane: tinted, blurred, sheen, glass capsules, Resend last', () => {
  assert.match(rules, /\.jc-user\.cs-editing \{[^}]*background: var\(--ecg-lg-fill\);[^}]*backdrop-filter: blur\(40px\)/);
  assert.match(rules, /\.jc-user\.cs-editing::before \{[^}]*var\(--ecg-lg-sheen\)/);
  assert.match(rules, /\.cs-editor-row \.jc-btn\.filled \{\s*order: 4;/);
  assert.match(rules, /\.cs-editor-files input:checked \{ background: #34c759; \}/);
  assert.equal((rules.match(/--ecg-lg-fill:/g) || []).length, 2, 'light and dark');
});

test('the title bar has a Files button that opens the Files pane', () => {
  const page = web('index.html');
  assert.match(page, /class="jc-tool" data-pane="files" title="Files \(⇧⌘F\)" aria-label="Files"/);
  assert.ok(page.indexOf('data-pane="files"') < page.indexOf('data-pane="diff"'), 'right after the terminal, before Changes');
});
