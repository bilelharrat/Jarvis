// Health & safety's window side (web/features/ops.js) and its part of the app itself
// (app/features/ops.js): every sentence the window writes has its Chinese, and the app's
// dialogs and restart answer only the window. node --test tests/web/
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const WEB = process.env.JARVIS_WEB_DIR || fileURLToPath(new URL('../../src/jarvis/web/', import.meta.url));
const source = readFileSync(`${WEB}/features/ops.js`, 'utf8');
const base = JSON.parse(readFileSync(`${WEB}/i18n-zh.json`, 'utf8'));
const ours = JSON.parse(readFileSync(`${WEB}/i18n/ops.json`, 'utf8'));
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
    if (c === '/' && /[(,=:!&|?{};\n]/.test(prev)) {  // a regular expression
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

// The window's own sentences: quoted texts that read as words (a capital letter, or a space
// between words), less selectors, class names, markup and template literals with values.
const NOT_WORDS = /^(?:#|\.|\[|<|ops-|btn|aria-|data-|feature:|button:|Escape$|Tab$|English$)/;
function sentences() {
  const found = new Set();
  for (const text of literals(source)) {
    if (text.includes('\u0000') || NOT_WORDS.test(text) || !/[A-Za-z]{2}/.test(text)) continue;
    if (/\.json$|^[a-z_:.-]+$/.test(text) || /^[a-z]+(?: [a-z-]+)+$/.test(text)) continue;  // names and class lists
    if (/^[A-Z]/.test(text) || / [a-z]/.test(text)) found.add(text.replace('{n}', '2'));  // countsLine's
  }
  return [...found];
}

test('every sentence the Health & safety window writes has its Chinese', () => {
  const all = sentences();
  assert.ok(all.length > 150, `only ${all.length} found: the scan has gone wrong`);
  const missing = all.filter((s) => chinese(s) === null);
  assert.deepEqual(missing, []);
});

test('its patterns turn counts and names into Chinese, never the other way round', () => {
  assert.equal(chinese('3 need attention'), '3 项需要处理');
  assert.equal(chinese('12.5 GB free'), '可用 12.5 GB');
  assert.equal(chinese('1,204 files'), '1,204 个文件');
  assert.equal(chinese('Have Notion ask before anything that changes your data?'), '让 Notion 在更改你的数据前先询问？');
  assert.equal(chinese('memory.json doesn’t match its checksum.'), null); // the backend's straight apostrophe only
  assert.equal(chinese("memory.json doesn't match its checksum."), 'memory.json 与校验和不一致。');
  assert.equal(chinese('250 USD a purchase, 100 a transfer, 500 a day'), '每次购买 250 USD，每次转账 100，每天 500');
});

test('the fragment never changes a Chinese string the window already had', () => {
  for (const [key, value] of Object.entries(ours.strings)) {
    if (key in base.strings) assert.equal(value, base.strings[key], key);
  }
});

// ── the app's side: dialogs and the restart ──

const { handlers, install } = require('../../app/features/ops.js');

function fakes({ canceled = false, paths = ['/Users/a/Backups'], dev = false } = {}) {
  const asked = [];
  const calls = [];
  const dialog = { showOpenDialog: async (win, options) => { asked.push({ win, options }); return { canceled, filePaths: paths }; } };
  const app = { relaunch: () => calls.push('relaunch'), quit: () => calls.push('quit') };
  const win = { isDestroyed: () => false };
  return { asked, calls, h: handlers({ dialog, app, getWindow: () => win, dev }), win };
}

test('the folder and file pickers say what they ask in the window’s words', async () => {
  const f = fakes();
  assert.equal(await f.h.pickFolder('/Users/a/Old', '选择 Jarvis 保存备份的位置'), '/Users/a/Backups');
  assert.equal(f.asked[0].options.message, '选择 Jarvis 保存备份的位置');
  assert.equal(f.asked[0].options.defaultPath, '/Users/a/Old');
  assert.deepEqual(f.asked[0].options.properties, ['openDirectory', 'createDirectory']);
  await f.h.pickBackup('relative/path', 42);
  assert.equal(f.asked[1].options.message, 'Choose a Jarvis backup to restore');
  assert.ok(f.asked[1].options.defaultPath.endsWith('/Documents'));
  assert.deepEqual(f.asked[1].options.filters, [{ name: 'Jarvis backup', extensions: ['zip'] }]);
  assert.equal(await fakes({ canceled: true }).h.pickFolder(), null);
});

test('a restart relaunches the app, except the development window that owns no backend', () => {
  const f = fakes();
  assert.deepEqual(f.h.restart(), { ok: true });
  assert.deepEqual(f.calls, ['relaunch', 'quit']);
  const dev = fakes({ dev: true });
  assert.deepEqual(dev.h.restart(), { ok: false, dev: true });
  assert.deepEqual(dev.calls, []);
});

test('only the window may ask: its channels answer nothing else', async () => {
  const handled = new Map();
  const calls = [];
  const ctx = {
    app: { relaunch: () => calls.push('relaunch'), quit: () => calls.push('quit') },
    ipcMain: { handle: (channel, fn) => handled.set(channel, fn) },
    getWindow: () => null,
    fromWindow: (event) => event === 'the window',
    dev: false,
  };
  install(ctx);
  assert.deepEqual([...handled.keys()].sort(), ['feature:ops:pick-backup', 'feature:ops:pick-folder', 'feature:ops:restart']);
  assert.deepEqual(await handled.get('feature:ops:restart')('a page'), { ok: false });
  assert.equal(await handled.get('feature:ops:pick-folder')('a page'), null);
  assert.deepEqual(calls, []);
  assert.deepEqual(await handled.get('feature:ops:restart')('the window'), { ok: true });
  assert.deepEqual(calls, ['relaunch', 'quit']);
});
