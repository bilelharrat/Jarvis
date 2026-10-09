// The window's classic scripts share one global scope, where a second `function x` quietly
// replaces the first (Settings' Add folder once ran Eden Code's). Compiled together in a
// block, a name declared twice is a SyntaxError: node --test tests/web/
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

// fileURLToPath, not .pathname: the repo's path has a space in it (%20 in a URL).
const WEB = process.env.JARVIS_WEB_DIR || fileURLToPath(new URL('../../src/jarvis/web/', import.meta.url));
const SCRIPTS = ['i18n.js', 'galaxy.js', 'attach.js', 'simulator.js', 'code-store.js', 'app.js', 'obsidian.js', 'features.js']; // in index.html's order
// The feature modules' scripts (web/features/*.js) share that scope too: features.js loads
// them after app.js, in name order.
const FEATURES = existsSync(`${WEB}/features`)
  ? readdirSync(`${WEB}/features`).filter((f) => f.endsWith('.js')).sort().map((f) => `features/${f}`)
  : [];

test('no name is declared twice across the window scripts', () => {
  const source = [...SCRIPTS, ...FEATURES].map((f) => readFileSync(`${WEB}/${f}`, 'utf8')).join('\n;\n');
  assert.doesNotThrow(() => new Function(`'use strict';{\n${source}\n}`), SyntaxError);
});

test('index.html loads exactly these scripts, in this order', () => {
  const html = readFileSync(`${WEB}/index.html`, 'utf8');
  const loaded = [...html.matchAll(/<script src="\/static\/([\w.-]+)"/g)].map((m) => m[1]);
  assert.deepEqual(loaded, SCRIPTS);
});
