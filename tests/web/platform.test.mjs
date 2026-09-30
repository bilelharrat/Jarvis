// The platform features' window side (web/features: local-models, skills, jarvis-mcp,
// widgets and pictures): every sentence they write has its Chinese, and their fragments
// never change a Chinese string the window already had; and their part of the app itself
// (app/features/platform.js). node --test tests/web/
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);

const WEB = process.env.JARVIS_WEB_DIR || fileURLToPath(new URL('../../src/jarvis/web/', import.meta.url));
const FILES = ['local-models.js', 'skills.js', 'jarvis-mcp.js', 'widgets.js'].filter((f) => existsSync(`${WEB}/features/${f}`));
const FRAGMENTS = ['local-models.json', 'skills.json', 'jarvis-mcp.json', 'widgets.json'].filter((f) => existsSync(`${WEB}/i18n/${f}`));
const base = JSON.parse(readFileSync(`${WEB}/i18n-zh.json`, 'utf8'));
// As the server merges them (server.zh_strings): the base, then every fragment in name order.
const merged = { strings: { ...base.strings }, patterns: [...base.patterns] };
for (const name of readdirSync(`${WEB}/i18n`).filter((f) => f.endsWith('.json')).sort()) {
  const data = JSON.parse(readFileSync(`${WEB}/i18n/${name}`, 'utf8'));
  Object.assign(merged.strings, data.strings || {});
  merged.patterns.push(...(data.patterns || []));
}
const patterns = merged.patterns.map(([p, r]) => [new RegExp(p), r]);

function chinese(text) {
  const key = text.replace(/\s+/g, ' ').trim();
  if (merged.strings[key] !== undefined) return merged.strings[key];
  for (const [re, rep] of patterns) if (re.test(key)) return key.replace(re, rep);
  return null;
}

// Every quoted text in a script, read as a script is (comments, regular expressions and
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

// The window's own sentences: quoted texts that read as words, less selectors, class names,
// event and command names, markup and template literals with values in them.
const NOT_WORDS = /^(?:#|\.|\[|<|aria-|data-|feature:|btn|lm-|sk-|mcp-|wg-|allow-|image\/|http|Enter$|Escape$|Tab$)/;
function sentences(source) {
  const found = new Set();
  for (const text of literals(source)) {
    if (text.includes('\u0000') || NOT_WORDS.test(text) || !/[A-Za-z]{2}/.test(text)) continue;
    if (/\.(?:json|js|css|md|png)$|^[a-z_:.-]+$/.test(text) || /^[a-z][a-z-]*(?: [a-z-]+)+$/.test(text)) continue;
    if (/^[A-Z]/.test(text) || / [a-z]/.test(text)) found.add(text);
  }
  return [...found];
}

for (const file of FILES) {
  test(`every sentence ${file} writes has its Chinese`, () => {
    const all = sentences(readFileSync(`${WEB}/features/${file}`, 'utf8'));
    assert.ok(all.length > 5, `only ${all.length} found in ${file}: the scan has gone wrong`);
    const missing = all.filter((s) => chinese(s) === null);
    assert.deepEqual(missing, []);
  });
}

test('the platform fragments never change a Chinese string the window already had', () => {
  for (const name of FRAGMENTS) {
    const ours = JSON.parse(readFileSync(`${WEB}/i18n/${name}`, 'utf8'));
    for (const [key, value] of Object.entries(ours.strings)) {
      if (key in base.strings) assert.equal(value, base.strings[key], `${name}: ${key}`);
    }
    for (const [pattern] of ours.patterns || []) assert.doesNotThrow(() => new RegExp(pattern), `${name}: ${pattern}`);
  }
});

test('the patterns put names and counts into Chinese', () => {
  assert.equal(chinese('Ollama is added already.'), 'Ollama 已经添加了。');
});

// ── the app's side: the folder a skill is installed from ──

const { handlers, install } = require('../../app/features/platform.js');

function fakes({ canceled = false, paths = ['/Users/a/Downloads/skills'] } = {}) {
  const asked = [];
  const dialog = { showOpenDialog: async (win, options) => { asked.push({ win, options }); return { canceled, filePaths: paths }; } };
  const win = { isDestroyed: () => false };
  return { asked, win, h: handlers({ dialog, getWindow: () => win }) };
}

test('the skill folder picker asks in the window’s words and gives back the folder', async () => {
  const f = fakes();
  assert.equal(await f.h.pickSkillFolder('选择一个技能，或一个装有技能的文件夹'), '/Users/a/Downloads/skills');
  assert.equal(f.asked[0].win, f.win);
  assert.equal(f.asked[0].options.message, '选择一个技能，或一个装有技能的文件夹');
  assert.deepEqual(f.asked[0].options.properties, ['openDirectory']);
  assert.ok(f.asked[0].options.defaultPath.endsWith('/Downloads'));
  await f.h.pickSkillFolder('x'.repeat(201));  // not a short line of words: the app's own
  assert.equal(f.asked[1].options.message, 'Choose a skill, or a folder of skills');
  assert.equal(await fakes({ canceled: true }).h.pickSkillFolder(), null);
  assert.equal(await fakes({ paths: [] }).h.pickSkillFolder(), null);
});

test('only the window may ask for a folder', async () => {
  const handled = new Map();
  install({ ipcMain: { handle: (channel, fn) => handled.set(channel, fn) }, getWindow: () => null, fromWindow: (event) => event === 'the window' });
  assert.deepEqual([...handled.keys()], ['feature:platform:pick-folder']);
  assert.equal(await handled.get('feature:platform:pick-folder')('a page', 'Choose'), null);
});
