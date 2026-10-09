// The window helpers of Eden Code's design match, masked secrets and video proof
// (web/features/code-design.js, code-secrets.js, code-video.js), and their Chinese.
// node --test tests/web/
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const dm = require('../../src/jarvis/web/features/code-design.js');
const sec = require('../../src/jarvis/web/features/code-secrets.js');
const vp = require('../../src/jarvis/web/features/code-video.js');
const WEB = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'src', 'jarvis', 'web');

test('a score reads as a percentage, and its progression as steps and a change', () => {
  assert.equal(dm.percent(0.8234), '82%');
  assert.equal(dm.percent(1.4), '100%');
  assert.equal(dm.percent('x'), '–');
  assert.deepEqual(dm.progression([0.62, 0.74, 0.82]), { text: '62% → 74% → 82%', delta: 20 });
  assert.deepEqual(dm.progression([]), { text: '', delta: 0 });
  assert.equal(dm.progression([0.9, 0.85]).delta, -5);
});

test('the sparkline runs from the first score to the last, 0% at the bottom', () => {
  assert.equal(dm.sparkPath([0, 1], 100, 20), 'M0.0,20.0 L100.0,0.0');
  assert.equal(dm.sparkPath([0.5], 100, 20), 'M50.0,10.0');
  assert.equal(dm.sparkPath([]), '');
});

test('the heat-map is clear where alike and red, more opaque, where not', () => {
  assert.deepEqual(dm.heatColor(0), [0, 0, 0, 0]);
  const warm = dm.heatColor(128);
  const hot = dm.heatColor(255);
  assert.equal(hot[0], 255);
  assert.ok(hot[1] < warm[1] && hot[3] > warm[3]);
});

test('only a picture of a kind and size the backend takes is a design', () => {
  assert.ok(dm.usable({ type: 'image/png', size: 1000 }));
  assert.ok(!dm.usable({ type: 'image/svg+xml', size: 1000 }));
  assert.ok(!dm.usable({ type: 'image/png', size: 9000000 }));
  assert.ok(!dm.usable(null));
  assert.equal(dm.refineLabel({ refined: 1, rounds: 3 }), 'Refine (round 2 of 3)');
  assert.equal(dm.jpegSrc('"><img>'), '');
});

test('a secret value is trimmed of a pasted newline and must be a sensible length', () => {
  assert.equal(sec.cleanValue('abcd1234\n'), 'abcd1234');
  assert.equal(sec.cleanValue('abc'), null);
  assert.equal(sec.cleanValue('x'.repeat(10001)), null);
  assert.equal(sec.cleanValue('ab\u0000cd'), null);
  assert.equal(sec.stateText('given', 'project'), 'Saved for this project, in the Keychain.');
  assert.equal(sec.stateText('given', 'session'), 'Saved for this session.');
  assert.equal(sec.stateText('waiting'), '');
});

test('a video is played from the window’s own server by its id only', () => {
  assert.equal(vp.videoSrc('0123456789abcdef01234567'), '/f/code-video/0123456789abcdef01234567');
  assert.equal(vp.videoSrc('../../etc/passwd'), '');
  assert.equal(vp.videoSrc('https://evil.test/x.webm'), '');
  assert.equal(vp.secondsText(7.94), '7.9 s');
  assert.equal(vp.secondsText(8), '8 s');
  assert.equal(vp.secondsText(0), '');
});

// The window's words in these modules: el()'s text, button labels, More menu items, notes.
function words(file) {
  const src = fs.readFileSync(path.join(WEB, 'features', file), 'utf8');
  const found = new Set();
  const patterns = [
    /\bel\('[\w-]+', '[^']*', '([^'$`]+)'\)/g,
    /\bbutton\('([^'$`]+)'/g,
    /\b(?:label|note|title): '([^'$`]+)'/g,
    /\bt\('([^'$`]+)'\)/g,
  ];
  for (const re of patterns) for (const m of src.matchAll(re)) if (/[a-z]/.test(m[1])) found.add(m[1]);
  return found;
}

test('every one of their sentences has its Chinese', () => {
  for (const [file, json] of [['code-design.js', 'code-design.json'], ['code-secrets.js', 'code-secrets.json'], ['code-video.js', 'code-video.json']]) {
    const zh = JSON.parse(fs.readFileSync(path.join(WEB, 'i18n', json), 'utf8'));
    const core = JSON.parse(fs.readFileSync(path.join(WEB, 'i18n-zh.json'), 'utf8'));
    const strings = { ...(core.strings || core), ...zh.strings };
    const patterns = (zh.patterns || []).map(([p]) => new RegExp(p));
    const missing = [...words(file)].filter((w) => !strings[w] && !patterns.some((re) => re.test(w)));
    assert.deepEqual(missing, [], `${file} has no Chinese for: ${missing.join(' | ')}`);
  }
});
