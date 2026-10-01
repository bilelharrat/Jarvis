// The intro's window side (web/features/intro.js): every sentence it writes has its Chinese
// (web/i18n/intro.json over i18n-zh.json), its walkthroughs' links go only to the services
// they name, and keys only ever leave in their own message. node --test tests/web/
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const WEB = process.env.JARVIS_WEB_DIR || fileURLToPath(new URL('../../src/jarvis/web/', import.meta.url));
const source = readFileSync(`${WEB}/features/intro.js`, 'utf8');
const base = JSON.parse(readFileSync(`${WEB}/i18n-zh.json`, 'utf8'));
const ours = JSON.parse(readFileSync(`${WEB}/i18n/intro.json`, 'utf8'));
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

// The window's own sentences, less selectors, class lists, markup, message types, names
// (shown as they are, data-no-i18n) and the group keys the catalog gives.
const NOT_WORDS = /^(?:#|\.|\[|<|intro-|button:|btn|aria-|data-|https?:|Escape$|Tab$|Space$|English$|Google Gemini$|OpenRouter$|Work$|Google$|Developer$|Business$|Design$|M\d)/;
function sentences() {
  const found = new Set();
  for (const text of literals(source)) {
    if (text.includes('\u0000') || NOT_WORDS.test(text) || !/[A-Za-z]{2}/.test(text)) continue;
    if (/^[a-z_:.-]+$/.test(text) || /^[a-z]+(?: [a-z-]+)+$/.test(text)) continue;
    if (/^[A-Z]/.test(text) || / [a-z]/.test(text)) found.add(text);
  }
  return [...found];
}

test('every sentence the intro writes has its Chinese', () => {
  const all = sentences();
  assert.ok(all.length > 120, `only ${all.length} found: the scan has gone wrong`);
  const missing = all.filter((s) => chinese(s) === null);
  assert.deepEqual(missing, []);
});

test('the walkthroughs’ steps split at the redirect URI still read in Chinese', () => {
  for (const piece of ['Under Clients, press Create Client, pick Web application, and add this authorized redirect URI:', 'In the sidebar, open OAuth and add this redirect URL:']) {
    assert.ok(chinese(piece), piece);
  }
});

test('the fragment never changes a Chinese string the window already had', () => {
  for (const [key, value] of Object.entries(ours.strings)) {
    if (key in base.strings) assert.equal(value, base.strings[key], key);
  }
});

test('its links go only to the services the cards name, over https', () => {
  const links = [...source.matchAll(/'(https?:\/\/[^']+)'/g)].map((m) => new URL(m[1]));
  assert.ok(links.length >= 7);
  const hosts = new Set(['platform.claude.com', 'fish.audio', 'www.twilio.com', 'console.twilio.com', 'aistudio.google.com', 'openrouter.ai']);
  for (const url of links) {
    assert.equal(url.protocol, 'https:', String(url));
    assert.ok(hosts.has(url.hostname), String(url));
  }
});

test('a key goes out only in its own message, never into the state the cards draw from', () => {
  for (const type of ['signin_key', 'voice_key', 'providers_add', 'phone_credentials']) assert.ok(source.includes(`type: '${type}'`), type);
  assert.ok(!/S\.\w*[kK]ey\w*\s*=\s*(?:key|value|token)\b/.test(source), 'a pasted key was kept in S');
  assert.ok(!/localStorage|sessionStorage/.test(source), 'the intro stores nothing in the browser');
});
