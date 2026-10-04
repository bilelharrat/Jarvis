// Ultracode's shimmer in Jarvis blue (web/features/code-ultracode.css): CSS alone. node --test tests/web/
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';

const web = (f) => new URL(`../../src/jarvis/web/${f}`, import.meta.url);
const css = readFileSync(web('features/code-ultracode.css'), 'utf8');
const ON = ':is(.jc-effort-pop.ultra, .jcs-effort:has(#jcs-effort-out.ultra)) .jc-slider';

test('it has no script: nothing that watches the page or loops can hold the window up', () => {
  assert.equal(existsSync(web('features/code-ultracode.js')), false);
  assert.doesNotMatch(css, /expression\(|url\((?!"data:image\/svg\+xml)/);  // only its own pixel tiles
});

test('both sliders get it, only on Ultracode: the popover and Settings’ default', () => {
  assert.ok(css.includes(`${ON}::before`) && css.includes(`${ON}::after`));
  assert.match(css, /\.jc-effort-pop\.ultra \.ep-ticks span\.uc/);
  assert.match(css, /#jcs-effort-out\.ultra/);
});

test('the pixels fade in from the left: each layer intersects its tile with a ramp', () => {
  // The mask shorthand resets mask-composite, so the composite comes after it, in each layer.
  const layers = css.split(/::before \{|::after \{/).slice(1).map((b) => b.slice(0, b.indexOf('\n}'))).filter((b) => b.includes('mask: url'));
  assert.equal(layers.length, 2);
  for (const layer of layers) {
    const mask = layer.search(/\n  mask: url/);
    const comp = layer.search(/mask-composite: intersect/);
    assert.ok(mask > 0 && comp > mask, 'mask-composite after the mask shorthand');
    assert.match(layer, /linear-gradient\(90deg, transparent \d+%/);
  }
});

test('the stop dots and the thumb stay above the mosaic', () => {
  assert.match(css, /\.jc-slider \.jc-dots \{ z-index: 2; \}/);
  assert.match(css, /\.jc-slider input \{ z-index: 3; \}/);
  assert.match(css, /pointer-events: none/);
});

test('it flows right to left, out of the thumb: the fill, the stream, the sweep and the words', () => {
  assert.match(css, /@keyframes uc-fill \{ from \{ clip-path: inset\(0 0 0 100%\); \}/);  // from the thumb
  for (const k of ['uc-flow-a', 'uc-flow-b']) {
    const block = css.slice(css.indexOf(`@keyframes ${k}`), css.indexOf('}\n}', css.indexOf(`@keyframes ${k}`)));
    const [from, to] = [...block.matchAll(/mask-position: (-?\d+)(?:px)? 0/g)].map((m) => Number(m[1])).filter((_, i) => i % 2 === 0);
    assert.ok(to < from, `${k} moves left`);
    assert.equal(from - to, 60);  // one tile: a seamless loop
  }
  assert.match(css, /@keyframes uc-sweep \{ from \{ background-position: 10% 0, 0 0; \} to \{ background-position: 90% 0, 0 0; \} \}/);
  assert.match(css, /@keyframes uc-letters \{ from \{ background-position: 0 0; \} to \{ background-position: 100% 0; \} \}/);
});

test('it is Jarvis blue, not violet, the button included', () => {
  assert.match(css, /--uc-c2: #3fb8f2/);
  assert.doesNotMatch(css, /#8f72e0|#6248cf|#9a86ff|purple/);
  assert.match(css, /#jc-effort\.ultra \{ color: rgb\(var\(--uc-tx-1\)\); \}/);
});

test('it holds still under reduced motion', () => {
  const still = css.slice(css.indexOf('@media (prefers-reduced-motion: reduce)'));
  assert.ok(still.includes(`${ON}::before`) && still.includes(`${ON}::after`) && /animation: none/.test(still));
});

test('each tone has its own pixels: night and day, the Mac’s or Obsidian’s', () => {
  const tones = css.match(/--uc-l1: #[0-9a-f]{6}/g) || [];
  assert.equal(tones.length, 4);
  assert.match(css, /@media \(prefers-color-scheme: dark\)/);
  assert.match(css, /body\[data-skin="obsidian"\]\[data-tone="light"\] \.deck\.jc/);
});
