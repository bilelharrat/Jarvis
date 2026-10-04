// The Obsidian look's reactor, its dial geometry (web/obsidian.js). node --test tests/web/
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const rx = require('../../src/jarvis/web/obsidian.js');
const ticks = (state, t = 0, level = 0) => Array.from({ length: rx.TICKS }, (_, i) => rx.tickLength(i, state, t, level));

test('at rest the dial is a still bezel: twelve long marks, the rest short', () => {
  const lens = ticks('idle', 3.2);
  assert.equal(lens.filter((l) => l === 12).length, 12);
  assert.equal(lens.filter((l) => l === 5).length, rx.TICKS - 12);
  assert.deepEqual(ticks('idle', 0), ticks('idle', 40));  // nothing moves but the light
});

test('listening, the ticks follow the voice: louder reaches further, never past the rim', () => {
  const quiet = Math.max(...ticks('listening', 1, 0));
  const loud = Math.max(...ticks('listening', 1, 1));
  assert.ok(loud > quiet + 15, `${quiet} → ${loud}`);
  for (const l of [...ticks('listening', 1, 1), ...ticks('speaking', 2.3)]) assert.ok(l >= 4 && l <= 46, l);
  assert.notDeepEqual(ticks('listening', 0, 0.5), ticks('listening', 0.4, 0.5));  // it moves
  assert.deepEqual(ticks('listening', 1, 7), ticks('listening', 1, 1));  // a level past 1 is 1
});

test('thinking, one bright bump goes round once in three seconds', () => {
  for (const t of [0, 0.7, 1.9]) {
    const lens = ticks('thinking', t);
    const bright = lens.map((l, i) => rx.tickBright(i, 'thinking', l, t)).filter(Boolean).length;
    assert.ok(bright > 15 && bright < 32, bright);
    assert.equal(lens.indexOf(Math.max(...lens)), (rx.sweepHead(t) + 16) % rx.TICKS);
  }
  assert.equal(rx.sweepHead(0), rx.sweepHead(3));
  assert.deepEqual(ticks('transcribing', 1.1), ticks('thinking', 1.1));
});

test('the inner ring: dark at rest, an arc while thinking, lit while speaking', () => {
  assert.deepEqual(rx.ringFor('idle', 5), [0, 0, 0]);
  const [a, , sweep] = rx.ringFor('thinking', 5);
  assert.ok(a > 0.9 && sweep < Math.PI);
  assert.equal(rx.ringFor('speaking', 5)[2], Math.PI * 2);
  assert.ok(rx.ringFor('listening', 5)[0] < rx.ringFor('speaking', 5)[0]);
});

test('a frame draws on any 2D context, scaled to its size, and leaves it as it found it', () => {
  const calls = [];
  let depth = 0;
  const ctx = new Proxy({}, {
    get(_, name) {
      if (name === 'save') return () => { depth += 1; };
      if (name === 'restore') return () => { depth -= 1; };
      return (...args) => calls.push([name, ...args]);
    },
    set() { return true; },
  });
  globalThis.Path2D = class { moveTo() {} lineTo() {} };
  for (const state of ['idle', 'listening', 'thinking', 'speaking']) rx.draw(ctx, 840, state, 1.5, 0.4);
  assert.equal(depth, 0);
  assert.deepEqual(calls.find((c) => c[0] === 'scale'), ['scale', 2, 2]);
  assert.ok(calls.some((c) => c[0] === 'clearRect'));
});

test('the look is wired: a skin over the orb, its own stylesheet and script, the HUD gone', () => {
  const web = (f) => readFileSync(new URL(`../../src/jarvis/web/${f}`, import.meta.url), 'utf8');
  const html = web('index.html');
  assert.match(html, /data-look="obsidian"[^>]*>Obsidian</);
  assert.match(html, /\/static\/obsidian\.css/);
  assert.match(html, /\/static\/app\.js"><\/script>\n<script src="\/static\/obsidian\.js">/);
  assert.doesNotMatch(html, /data-look="hud"|hud-only|Stark HUD/);
  assert.match(web('app.js'), /const SKINS = \['glass', 'obsidian'\]/);
  assert.match(web('app.js'), /LOOK_ORDER = \['orb', 'obsidian', 'console', 'glass'\]/);
  assert.doesNotMatch(web('app.css'), /data-look="hud"/);
});

test('in the day the dial draws in the look’s porcelain colours, at night in graphite', () => {
  const styles = [];
  const ctx = new Proxy({}, {
    get: (_, name) => (name === 'save' || name === 'restore' ? () => {} : () => {}),
    set: (_, name, value) => { if (/Style$/.test(name)) styles.push(String(value)); return true; },
  });
  globalThis.Path2D = class { moveTo() {} lineTo() {} };
  const day = { arc: '10, 108, 179', ring: '10, 12, 16', brass: '#e3b76a', core: '#0a3d6b' };
  rx.draw(ctx, 420, 'speaking', 1, 0.5, day);
  assert.ok(styles.some((s) => s.includes('10, 108, 179')) && styles.includes('#0a3d6b'));
  assert.ok(!styles.some((s) => s.includes('143, 216, 255') || s.includes('255, 255, 255')));
  styles.length = 0;
  rx.draw(ctx, 420, 'idle', 0, 0);
  assert.ok(styles.some((s) => s.includes(rx.NIGHT.arc)) && styles.includes(rx.NIGHT.core));
});

test('Obsidian flanks the stage with the orb’s panels and follows the Mac’s appearance', () => {
  const web = (f) => readFileSync(new URL(`../../src/jarvis/web/${f}`, import.meta.url), 'utf8');
  const css = web('obsidian.css');
  assert.doesNotMatch(css, /grid-template-areas/);  // no strip along the bottom
  assert.match(css, /body\[data-skin="obsidian"\]\[data-tone="light"\] \{[^}]*--ob-arc-rgb: 10, 108, 179/);
  assert.match(web('app.js'), /if \(skin === 'obsidian'\) return macLight\.matches;/);
});
