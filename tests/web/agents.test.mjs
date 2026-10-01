// The agents, loop notices and videos in the window (web/features/agents.js, loops.js,
// video_gen.js): every sentence they show has its Chinese in their i18n fragment or the
// window's own i18n-zh.json (names of apps and of Jarvis itself stay as they are), and the
// fragments are well formed. node --test tests/web/
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const WEB = process.env.JARVIS_WEB_DIR || fileURLToPath(new URL('../../src/jarvis/web/', import.meta.url));
const core = JSON.parse(readFileSync(`${WEB}/i18n-zh.json`, 'utf8'));
const NAMES = new Set(['Jarvis', 'Telegram', 'Slack', 'Discord', 'WhatsApp', 'Escape', 'Enter']);

function check(feature) {
  const source = readFileSync(`${WEB}/features/${feature}.js`, 'utf8');
  const fragment = JSON.parse(readFileSync(`${WEB}/i18n/${feature}.json`, 'utf8'));
  const strings = { ...core.strings, ...fragment.strings };
  const patterns = [...core.patterns, ...fragment.patterns].map(([re, rep]) => [new RegExp(re), rep]);
  const chinese = (text) => {
    const key = text.replace(/\s+/g, ' ').trim();
    return !key || key in strings || patterns.some(([re]) => re.test(key));
  };
  const found = new Set();
  for (const m of source.matchAll(/'((?:[^'\\\n]|\\.)*)'/g)) {
    const s = m[1];
    if (/^[A-Z(]/.test(s) && /[a-z]/.test(s) && !/^[A-Z_]+$/.test(s) && !s.includes('${') && !NAMES.has(s)) found.add(s);
  }
  for (const m of source.matchAll(/`((?:[^`\\]|\\.)*)`/g)) {  // a sentence with a number in it
    const s = m[1].replace(/\$\{[^}]+\}/g, '2');
    if (/^[\d(]/.test(s) && /[a-z]{3}/.test(s)) found.add(s);
  }
  return { found: [...found], missing: [...found].filter((s) => !chinese(s)), fragment };
}

for (const feature of ['agents', 'loops', 'video_gen']) {
  test(`every sentence ${feature} shows has its Chinese`, (t) => {
    if (!existsSync(`${WEB}/features/${feature}.js`)) return t.skip('not here');
    const { found, missing } = check(feature);
    assert.ok(found.length >= 3, `only ${found.length} found`);
    assert.deepEqual(missing, []);
  });

  test(`the ${feature} fragment is well formed`, (t) => {
    if (!existsSync(`${WEB}/i18n/${feature}.json`)) return t.skip('not here');
    const fragment = JSON.parse(readFileSync(`${WEB}/i18n/${feature}.json`, 'utf8'));
    for (const [en, zh] of Object.entries(fragment.strings)) assert.ok(/[一-鿿]/.test(zh), `no Chinese for ${en}`);
    for (const [re, rep] of fragment.patterns) assert.doesNotThrow(() => new RegExp(re), rep);
  });
}
