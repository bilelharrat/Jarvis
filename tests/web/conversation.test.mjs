// JARVIS's own conversation in the window (web/features/conversation*.js): every sentence
// it shows has its Chinese in web/i18n/conversation.json or the window's own i18n-zh.json,
// and the dynamic ones are covered by patterns. node --test tests/web/
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const WEB = process.env.JARVIS_WEB_DIR || fileURLToPath(new URL('../../src/jarvis/web/', import.meta.url));
const FILES = readdirSync(`${WEB}/features`).filter((f) => /^(conversation|personas).*\.js$/.test(f));
const source = FILES.map((f) => readFileSync(`${WEB}/features/${f}`, 'utf8')).join('\n');
const fragment = JSON.parse(readFileSync(`${WEB}/i18n/conversation.json`, 'utf8'));
const core = JSON.parse(readFileSync(`${WEB}/i18n-zh.json`, 'utf8'));
const strings = { ...core.strings, ...fragment.strings };
const patterns = [...core.patterns, ...fragment.patterns].map(([re, rep]) => [new RegExp(re), rep]);

function chinese(text) {
  const key = text.replace(/\s+/g, ' ').trim();
  if (!key || key in strings) return true;
  return patterns.some(([re]) => re.test(key));
}

// The sentences in the scripts: quoted text that starts with a capital or carries the
// typographic marks the window's own words use. Code (selectors, ids, keys) doesn't.
const KEYS = new Set(['Escape', 'Enter', 'Tab', 'ArrowUp', 'ArrowDown']);
function sentences() {
  const found = new Set();
  for (const m of source.matchAll(/'((?:[^'\\\n]|\\.)*)'/g)) {
    const s = m[1];
    if (/^[A-Z(]/.test(s) && /[a-z]/.test(s) && !/^[A-Z_]+$/.test(s) && !s.includes('${') && !KEYS.has(s)) found.add(s);
  }
  return [...found];
}

test('the conversation scripts are there', () => {
  assert.ok(FILES.includes('conversation.js'), FILES.join(', '));
});

test('every sentence the conversation feature shows has its Chinese', () => {
  const all = sentences();
  assert.ok(all.length >= 3, `only ${all.length} found`);
  const missing = all.filter((s) => !chinese(s));
  assert.deepEqual(missing, []);
});

test('the fragment is well formed', () => {
  assert.equal(typeof fragment.strings, 'object');
  for (const [en, zh] of Object.entries(fragment.strings)) {
    assert.equal(typeof zh, 'string', en);
    assert.ok(/[一-鿿]/.test(zh), `no Chinese for ${en}`);
  }
  for (const [re, rep] of fragment.patterns) assert.doesNotThrow(() => new RegExp(re), rep);
});
