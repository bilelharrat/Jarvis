// Spoken punctuation (web/features/punctuation.js), run without a page. Every case in
// tests/punctuation_cases.json is checked here, and the Python side (tests/test_punctuation.py)
// checks the very same file: that is what proves the two give identical answers.
// node --test tests/web/
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const P = require('../../src/jarvis/web/features/punctuation.js');
const SOURCE = readFileSync(new URL('../../src/jarvis/web/features/punctuation.js', import.meta.url), 'utf8');
const CASES = JSON.parse(readFileSync(new URL('../punctuation_cases.json', import.meta.url), 'utf8'));

const shown = (text) => JSON.stringify(text).slice(0, 48);
// Call fn with the case's text and whichever of its settings the case has (so the defaults are tried too).
const ask = (fn, c, ...keys) => fn(c.in, ...keys.filter((key) => key in c).map((key) => c[key]));

CASES.from_speech.forEach((c, n) => {
  test(`from_speech ${n}: ${shown(c.in)}`, () => assert.equal(ask(P.fromSpeech, c, 'language'), c.out));
});
CASES.to_speech.forEach((c, n) => {
  test(`to_speech ${n}: ${shown(c.in)} (${c.level})`, () => assert.equal(ask(P.toSpeech, c, 'level', 'language'), c.out));
});
CASES.describe.forEach((c, n) => {
  test(`describe ${n}: ${shown(c.in)}`, () => assert.deepEqual(ask(P.describe, c, 'language'), c.out));
});

test('the cases are enough', () => {
  assert.ok(CASES.from_speech.length >= 60);
  assert.ok(CASES.to_speech.length >= 50);
  assert.ok(CASES.describe.length >= 12);
});

test('the page gets the same library on window, and node gets it from require', () => {
  const win = {};
  new Function('window', SOURCE)(win);
  assert.deepEqual(Object.keys(win.jarvisPunctuation).sort(), ['LEVELS', 'describe', 'fromSpeech', 'toSpeech']);
  assert.deepEqual(Object.keys(P).sort(), ['LEVELS', 'describe', 'fromSpeech', 'toSpeech']);
  assert.deepEqual([...win.jarvisPunctuation.LEVELS], ['none', 'some', 'all']);
  assert.equal(win.jarvisPunctuation.fromSpeech('hello comma world'), 'Hello, world');
  assert.equal(win.jarvisPunctuation.toSpeech('Hello, world.'), 'Hello comma world period');
  assert.deepEqual(win.jarvisPunctuation.describe('Hi, you.').counts, { comma: 1, period: 1 });
});

test('the defaults are English and some', () => {
  assert.equal(P.fromSpeech('hi comma you'), 'Hi, you');
  assert.equal(P.toSpeech('Hi, you.'), 'Hi comma you period');
  assert.deepEqual(P.describe('Hi, you.').counts, { comma: 1, period: 1 });
});

test('a language that starts with zh is Chinese, anything else is English', () => {
  for (const language of ['zh', 'zh-CN', 'zh_TW', 'ZH', 'Zh-Hans']) {
    assert.equal(P.fromSpeech('你好逗号世界', language), '你好，世界');
    assert.equal(P.toSpeech('你好，世界', 'some', language), '你好 逗号 世界');
  }
  for (const language of ['en', 'en-US', 'fr', '', null, 5, 'auto']) {
    assert.equal(P.fromSpeech('hi comma you', language), 'Hi, you');
    assert.equal(P.fromSpeech('你好逗号世界', language), '你好逗号世界');
    assert.equal(P.toSpeech('Hi, you.', 'some', language), 'Hi comma you period');
  }
});

test('the level may be in any case, and one that is not a level is some', () => {
  for (const level of ['ALL', 'All', 'all']) assert.equal(P.toSpeech('a-b', level), 'a hyphen b');
  for (const level of ['loud', '', ' all', null, 3, ['all']]) assert.equal(P.toSpeech('Hi, a-b.', level), 'Hi comma a-b period');
});

test('what is not text comes back as it was', () => {
  for (const odd of [null, undefined, 5, 2.5, ['a', 'b'], { a: 1 }, true]) {
    assert.equal(P.fromSpeech(odd), odd);
    assert.equal(P.toSpeech(odd), odd);
    assert.equal(P.toSpeech(odd, 'none'), odd);
    assert.deepEqual(P.describe(odd), { summary: "There's nothing to describe.", spoken: '', counts: {}, sentences: 0 });
  }
});

// ── anything at all ──

// A small seeded random number generator, so a failure can be run again.
function generator(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomText(random, size) {
  const pick = (list) => list[Math.floor(random() * list.length)];
  const words = ['comma', 'period', 'full stop', 'question mark', 'exclamation mark', 'colon', 'semicolon', 'semi colon', 'dash', 'em dash',
    'hyphen', 'ellipsis', 'dot dot dot', 'open paren', 'close paren', 'open quote', 'close quote', 'end quote', 'unquote', 'apostrophe',
    'new line', 'newline', 'new paragraph', 'at sign', 'ampersand', 'slash', 'percent sign', 'dollar sign', 'the', 'a', 'of', 'grace',
    'hello', 'World', 'NASA', 'iPhone', '3.5', 'Dr.', 'e.g.', 'U.S.', 'No.', 'no.', 'Ph.D.', 'p.m.', 'et al.', '5A.', 'x--y', '3:30', "don't",
    'https://x.com/a?b=1', 'a@b.com', '你好', '逗号', '句号', '新段落', '左括号', '结束引号', '开引号', '问号', 'ß', 'café', 'école', '😀',
    String.fromCharCode(0x200d), String.fromCharCode(0x301), String.fromCharCode(0xfe0f), '\u0000', 'ǆ', 'İ', 'ﬁ', String.fromCharCode(0xd800)];
  const marks = [...',.?!:;()"\'“”‘’-–—…/\\@#&*_=+%$~^|<>[]{}`，。？！：；、（）', '……', '...', '..', '«', '»', '¿'];
  const spaces = [' ', ' ', ' ', '  ', '\t', '\n', '\n\n', '\r\n', '\r', String.fromCharCode(0xa0), String.fromCharCode(0x2028),
    String.fromCharCode(0x2029), String.fromCharCode(0x3000), String.fromCharCode(0x200b), String.fromCharCode(0xfeff), '\u000b', '\u0085', ''];
  let text = '';
  for (let k = 0; k < size; k++) {
    const roll = random();
    if (roll < 0.45) text += pick(words);
    else if (roll < 0.7) text += pick(marks);
    else if (roll < 0.93) text += pick(spaces);
    else text += String.fromCodePoint(pick([32 + Math.floor(random() * 95), 128 + Math.floor(random() * (0xd800 - 128)), 0xe000 + Math.floor(random() * (0x11000 - 0xe000))]));
  }
  return text;
}

test('nothing throws on a few thousand odd texts, and what comes out is plain', () => {
  const random = generator(20261008);
  for (let n = 0; n < 3000; n++) {
    const text = randomText(random, Math.floor(random() * 40));
    for (const language of ['en', 'zh']) {
      assert.equal(typeof P.fromSpeech(text, language), 'string');
      assert.equal(typeof P.describe(text, language).summary, 'string');
      for (const level of ['some', 'all']) {
        const said = P.toSpeech(text, level, language);
        assert.equal(typeof said, 'string');
        assert.ok(!/[\n\r]/.test(said) && !said.includes('  ') && said === said.replace(/^ +| +$/g, ''), JSON.stringify(text));
      }
    }
    assert.equal(P.toSpeech(text, 'none'), text);
    assert.equal(P.toSpeech(text, 'none', 'zh'), text);
  }
});

test('text with no mark word only gets a capital, and is then left alone', () => {
  const random = generator(99);
  const words = ['hello', 'World', 'NASA', 'iPhone', 'ok', '3.5', 'Dr.', 'e.g.', 'U.S.', 'école', 'ça', 'ß', 'ﬁsh', '你好', '😀', 'x', "don't",
    'well-known', 'a@b.com', 'periods', 'commas', 'dashboard'];
  const pieces = [...',.?!:;()"\'-—…/&%$', ' ', ' ', '  ', '\t', '\n', '\r\n', String.fromCharCode(0xa0)];
  for (let n = 0; n < 1500; n++) {
    let text = '';
    const size = Math.floor(random() * 25);
    for (let k = 0; k < size; k++) text += random() < 0.5 ? words[Math.floor(random() * words.length)] : pieces[Math.floor(random() * pieces.length)];
    const once = P.fromSpeech(text);
    assert.equal(P.fromSpeech(once), once);
    assert.equal(once.toLowerCase(), text.toLowerCase());
    assert.equal(Array.from(once).length, Array.from(text).length);
    assert.equal(P.fromSpeech(text, 'zh'), text);
  }
});

test('describe says what toSpeech says', () => {
  const random = generator(11);
  for (let n = 0; n < 800; n++) {
    const text = randomText(random, Math.floor(random() * 30));
    for (const language of ['en', 'zh']) {
      const described = P.describe(text, language);
      assert.equal(described.spoken, P.toSpeech(text, 'all', language));
      assert.deepEqual(Object.keys(described).sort(), ['counts', 'sentences', 'spoken', 'summary']);
      for (const count of Object.values(described.counts)) assert.ok(Number.isInteger(count) && count > 0);
    }
  }
});

test('what a listener hears, a dictator can say back', () => {
  for (const text of ['Hello, world.', 'Is it ready? Yes! Go (now) — please.', 'Dear Ann: thanks; bye.', 'He said "hello" and left.',
    'One.\n\nTwo.\nThree.', 'Dear Ann,\n\nThanks for the notes.', 'Wait… what?', 'Meet Dr. Smith at 3:30 p.m.', 'A well-known fact.']) {
    assert.equal(P.fromSpeech(P.toSpeech(text, 'some')), text);
  }
});

test('a mark word is a whole word only, and not inside an address or a hyphenated word', () => {
  for (const word of ['commas', 'periodic', 'dashboard', 'colonel', 'slashes', 'newlines', 'comma2']) {
    assert.equal(P.fromSpeech(`hello ${word} there`), `Hello ${word} there`);
  }
  for (const text of ['my.period.tracker', 'comma-separated', 'read/slash/write', 'a@period.com']) {
    assert.equal(P.fromSpeech(text), text[0].toUpperCase() + text.slice(1));
  }
});

// ── how long it takes ──

const took = (fn, ...args) => {
  const start = performance.now();
  fn(...args);
  return (performance.now() - start) / 1000;
};

test('a long text takes a fraction of a second', () => {
  const chunk = 'Dear Ann comma thanks for the notes period new paragraph see the U.S. (p. 3.5) at 3:30 ';
  const text = chunk.repeat(Math.ceil(200000 / chunk.length)).slice(0, 200000);
  assert.equal(text.length, 200000);
  assert.ok(took(P.fromSpeech, text) < 1);
  assert.ok(took(P.toSpeech, text, 'some') < 1);
  assert.ok(took(P.toSpeech, text, 'all') < 1);
  assert.ok(took(P.describe, text) < 1);
  assert.ok(took(P.fromSpeech, '你好逗号世界句号'.repeat(25000), 'zh') < 1);
  assert.ok(took(P.toSpeech, '你好，世界。'.repeat(33000), 'all', 'zh') < 1);
});

test('awkward long texts are no slower', () => {
  const awkward = [' '.repeat(200000) + 'a', '.'.repeat(200000), 'a.'.repeat(100000), '.' + ')'.repeat(200000), '?'.repeat(200000),
    'period '.repeat(30000), 'a'.repeat(200000), 'period' + ',.'.repeat(100000), 'a\n'.repeat(100000), 'A. '.repeat(60000),
    '…'.repeat(100000), "'".repeat(100000), 'Dr.U.S.A.e.g.i.e.'.repeat(12000)];
  for (const text of awkward) {
    assert.ok(took(P.fromSpeech, text) < 1, JSON.stringify(text.slice(0, 12)));
    assert.ok(took(P.toSpeech, text, 'some') < 1, JSON.stringify(text.slice(0, 12)));
    assert.ok(took(P.toSpeech, text, 'all') < 1, JSON.stringify(text.slice(0, 12)));
    assert.ok(took(P.describe, text) < 1, JSON.stringify(text.slice(0, 12)));
  }
});
