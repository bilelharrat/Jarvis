// Memory's window side (web/features/memory.js): every sentence it writes has its Chinese,
// its count patterns turn numbers into Chinese, the fragment never changes the window's
// own Chinese, and it never says "Claude Code" to the owner. node --test tests/web/
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const WEB = process.env.JARVIS_WEB_DIR || fileURLToPath(new URL('../../src/jarvis/web/', import.meta.url));
const source = readFileSync(`${WEB}/features/memory.js`, 'utf8');
const base = JSON.parse(readFileSync(`${WEB}/i18n-zh.json`, 'utf8'));
const ours = JSON.parse(readFileSync(`${WEB}/i18n/memory.json`, 'utf8'));
const strings = { ...base.strings, ...ours.strings };
const patterns = [...base.patterns, ...ours.patterns].map(([p, r]) => [new RegExp(p), r]);

function chinese(text) {
  const key = text.replace(/\s+/g, ' ').trim();
  if (strings[key] !== undefined) return strings[key];
  for (const [re, rep] of patterns) if (re.test(key)) return key.replace(re, rep);
  return null;
}

// Every quoted text in the script, read as a script is (comments, regular expressions and
// template literals' ${…} parts skipped).
function literals(code) {
  const out = [];
  let i = 0;
  let prev = '';
  while (i < code.length) {
    const c = code[i];
    if (c === '/' && code[i + 1] === '/') { i = code.indexOf('\n', i); if (i < 0) break; continue; }
    if (c === '/' && code[i + 1] === '*') { i = code.indexOf('*/', i) + 2; continue; }
    if (c === '/' && /[(,=:!&|?{};\n]/.test(prev)) {
      let j = i + 1;
      let inClass = false;
      while (j < code.length && (code[j] !== '/' || inClass)) {
        if (code[j] === '\\') j++;
        else if (code[j] === '[') inClass = true;
        else if (code[j] === ']') inClass = false;
        j++;
      }
      i = j + 1;
      prev = '/';
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      let j = i + 1;
      let text = '';
      while (j < code.length && code[j] !== c) {
        if (code[j] === '\\') { text += code[j + 1]; j += 2; continue; }
        if (c === '`' && code[j] === '$' && code[j + 1] === '{') {
          let depth = 1;
          j += 2;
          while (j < code.length && depth) { if (code[j] === '{') depth++; else if (code[j] === '}') depth--; j++; }
          text += '\u0000';
          continue;
        }
        text += code[j];
        j++;
      }
      out.push(text);
      i = j + 1;
      prev = c;
      continue;
    }
    if (!/\s/.test(c)) prev = c;
    i++;
  }
  return out;
}

const NOT_WORDS = /^(?:#|\.|\[|<|mem-|btn|aria-|data-|feature:|button:|Escape$|Tab$|English$)/;
function sentences() {
  const found = new Set();
  for (const text of literals(source)) {
    if (text.includes('\u0000') || NOT_WORDS.test(text) || !/[A-Za-z]{2}/.test(text)) continue;
    if (/\.json$|^[a-z_:.-]+$/.test(text) || /^[a-z]+(?: [a-z-]+)+$/.test(text)) continue;  // names and class lists
    if (/^[A-Z]/.test(text) || / [a-z]/.test(text)) found.add(text.replace('{n}', '2'));
  }
  return [...found];
}

test('every sentence the Memory window writes has its Chinese', () => {
  const all = sentences();
  assert.ok(all.length > 150, `only ${all.length} found: the scan has gone wrong`);
  assert.deepEqual(all.filter((s) => chinese(s) === null), []);
});

test('the pieces put together with the owner’s words have their Chinese too', () => {
  const pieces = [...source.matchAll(/\bT\('([^']+)'\)/g)].map((m) => m[1]);
  assert.ok(pieces.length > 15);
  assert.deepEqual(pieces.filter((p) => chinese(p) === null), []);
});

test('its patterns turn counts into Chinese', () => {
  assert.equal(chinese('12 facts'), '12 条事实');
  assert.equal(chinese('3 waiting for you'), '3 个等你处理');  // the window's own pattern
  assert.equal(chinese('This forgets 7 things:'), '这会忘记 7 条：');
  assert.equal(chinese('Memory has room for 40 more.'), '记忆还能再存 40 条。');
  assert.equal(chinese('went over 3 notes'), '看了 3 篇日记');
  assert.equal(chinese('1 that looked like a password, key or account number was left out.'), '有 1 条看起来像密码、密钥或账号，已略过。');
  assert.equal(chinese('4 that looked like a password, key or account number were left out.'), '有 4 条看起来像密码、密钥或账号，已略过。');
  assert.equal(chinese('“next week” isn\'t a date: give it like 2026-10-12.'), '“next week”不是日期：请写成 2026-10-12 这样。');
});

test('the fragment never changes a Chinese string the window already had', () => {
  for (const [key, value] of Object.entries(ours.strings)) {
    if (key in base.strings) assert.equal(value, base.strings[key], key);
  }
});

test('the owner never reads “Claude Code” in it', () => {
  const shown = literals(source).filter((t) => /Claude Code/.test(t));
  assert.deepEqual(shown, []);
  assert.ok(!Object.keys(ours.strings).some((k) => /Claude Code/.test(k)));
});
