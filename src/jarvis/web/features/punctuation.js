// Spoken punctuation, the window's side (src/jarvis/punctuation.py): for a person who dictates and
// listens instead of looking, a blind or low-vision professor with a screen reader.
//   - fromSpeech(text, language): the punctuation a person says becomes the marks, spaced and
//     capitalised the way they are written: "Dear Ann comma new paragraph thanks for the notes
//     period" is "Dear Ann,\n\nThanks for the notes." A comma or full stop the recogniser wrote
//     beside the word it heard goes, so the mark is written once; a mark word that is also an
//     ordinary word (a grace period, a dash of salt) stays a word when the words around it say so.
//   - toSpeech(text, level, language): the text made ready for a voice to say its punctuation
//     aloud, at the level the listener picks (none, some, all) like a screen reader's.
//   - describe(text, language): how a text is punctuated: how many sentences, how many of each mark.
// English, and Chinese (a language that starts with "zh"); anything else is English.
//
// This is the same code as the Python one, step for step, and tests/punctuation_cases.json holds the
// answers both must give, byte for byte (tests/web/punctuation.test.mjs, tests/test_punctuation.py).
// So a text is walked one character (code point) at a time, and what is a space, a letter or a digit
// is spelled out below, instead of leaning on regular-expression extras the two languages don't
// share. Change a rule here and in punctuation.py together, and add the case that shows it.
(function (root) {
  'use strict';

  const LEVELS = Object.freeze(['none', 'some', 'all']);

  // ── what a character is ──

  const chars = (codes) => new Set(codes.map((c) => String.fromCharCode(c)));
  // What separates words on a line, and what ends a line (written out: \s differs between languages).
  const HSPACE = chars([0x20, 0x09, 0x0b, 0x0c, 0xa0, 0x1680, 0x2000, 0x2001, 0x2002, 0x2003, 0x2004, 0x2005,
    0x2006, 0x2007, 0x2008, 0x2009, 0x200a, 0x202f, 0x205f, 0x3000]);
  const LINE_ENDS = chars([0x0a, 0x0d, 0x2028, 0x2029]);
  const BLANKS = new Set([...HSPACE, ...LINE_ENDS]);
  const DIGITS = new Set('0123456789');
  // Marks that keep the two word characters around them in one word: don't, e-mail, snake_case,
  // example.com, 3.5, a.m, and/or, me@home. (A mark word inside one of these is not a mark.)
  const JOINERS = new Set(["'", '’', '-', '_', '.', '@', '/', '\\']);

  // Lower case for ASCII letters only: the words that mean a mark are English, and the case of any
  // other letter is none of their business (and one place two languages could disagree).
  const lower = (text) => text.replace(/[A-Z]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 32));

  // "L" for a letter, "N" for a number, "M" for a mark that sits on a letter (an accent), "o" for
  // everything else (and for no character at all). The argument is one code point, or ''.
  const KINDS = new Map();
  const KINDS_KEPT = 4096; // (a text of a thousand different scripts must not grow the table for good)
  const LETTER = /^\p{L}$/u;
  const NUMBER = /^\p{N}$/u;
  const MARK = /^\p{M}$/u;
  function kind(c) {
    let k = KINDS.get(c);
    if (k === undefined) {
      k = 'o';
      if (c.length > 0) {
        if (LETTER.test(c)) k = 'L';
        else if (NUMBER.test(c)) k = 'N';
        else if (MARK.test(c)) k = 'M';
      }
      if (KINDS.size < KINDS_KEPT) KINDS.set(c, k);
    }
    return k;
  }
  const startsWord = (c) => { const k = kind(c); return k === 'L' || k === 'N'; };

  const isUpper = (c) => c !== c.toLowerCase();

  // The word with its first letter in capitals, and nothing else changed: "thanks" is "Thanks" and
  // "NASA" stays. A letter whose capital is more than one letter (ß) is left, and so is a word that
  // already has a capital inside (iPhone, eBay): that is how it was meant to be written.
  function capitalised(word) {
    const letters = Array.from(word);
    const first = letters[0];
    const capital = first.toUpperCase();
    if (capital === first || Array.from(capital).length !== 1) return word;
    for (let k = 1; k < letters.length; k++) if (isUpper(letters[k])) return word;
    return capital + letters.slice(1).join('');
  }

  // ── the words that mean a mark (English) ──

  const SPACE = 0; // a mark leaves a space beside it
  const HUG = 1; // hugs the word there
  const NUMBER_ONLY = 2; // hugs it if it is a number (50%)

  // The words said, the mark, how the mark sits against the word before it and the word after it,
  // and whether the next word starts a sentence. The one place the spoken words of English are kept.
  const SPOKEN = [
    [['comma'], ',', HUG, SPACE, false],
    [['period', 'full stop'], '.', HUG, SPACE, true],
    [['question mark'], '?', HUG, SPACE, true],
    [['exclamation mark', 'exclamation point'], '!', HUG, SPACE, true],
    [['colon'], ':', HUG, SPACE, false],
    [['semicolon', 'semi colon'], ';', HUG, SPACE, false],
    [['dash', 'em dash'], '—', SPACE, SPACE, false],
    [['hyphen'], '-', HUG, HUG, false],
    [['ellipsis', 'dot dot dot'], '…', HUG, SPACE, false],
    [['open parenthesis', 'open paren', 'left paren', 'open bracket'], '(', SPACE, HUG, false],
    [['close parenthesis', 'close paren', 'right paren', 'close bracket'], ')', HUG, SPACE, false],
    [['open quote', 'begin quote'], '"', SPACE, HUG, false],
    [['close quote', 'end quote', 'unquote'], '"', HUG, SPACE, false],
    [['apostrophe'], "'", HUG, HUG, false],
    [['new line', 'newline'], '\n', HUG, HUG, true],
    [['new paragraph'], '\n\n', HUG, HUG, true],
    [['at sign'], '@', HUG, HUG, false],
    [['ampersand'], '&', SPACE, SPACE, false],
    [['slash'], '/', HUG, HUG, false],
    [['percent sign'], '%', NUMBER_ONLY, SPACE, false],
    [['dollar sign'], '$', SPACE, HUG, false],
  ];
  // text: what is written; before: SPACE, HUG or NUMBER_ONLY, how it sits against the word before it;
  // after: SPACE or HUG, how it sits against the word after it; starts: whether the next word starts
  // a sentence.
  const MARKS = new Map();
  for (const [wordList, text, before, after, starts] of SPOKEN) {
    for (const words of wordList) MARKS.set(words, { text, before, after, starts });
  }
  const FIRST_WORDS = new Set([...MARKS.keys()].map((words) => words.split(' ')[0]));
  const LONGEST_PHRASE = Math.max(...[...MARKS.keys()].map((words) => words.split(' ').length));

  // Words that are also ordinary words. One of these is a mark only when nothing around it says it is
  // the ordinary word (see BEFORE_ORDINARY, and "of" after it). A phrase goes by its last word: "em
  // dash", "semi colon" and "open quote" are as ambiguous as "dash", "colon" and "quote".
  const AMBIGUOUS = new Set(['period', 'colon', 'dash', 'quote', 'slash', 'comma']);
  // After one of these an ambiguous word is the ordinary word: "a dash of salt", "that quote", "a
  // grace period", "the trial period". (Not a mark when it's last in the text or right before
  // another mark word: there it's always a mark.)
  const BEFORE_ORDINARY = new Set((
    'a an the this that these those one each every same any another my your his her its our '
    + 'their no some per time grace trial waiting cooling probationary school class exam billing '
    + 'reporting reading long short whole entire ice dark middle early late first last next '
    + 'previous final key').split(' '));
  // What the recogniser writes beside a word it also heard as a mark; the mark is written once.
  // (A "?" or "!" it wrote is kept, unless the spoken word names that same mark.)
  const DROP = new Set([',', '.']);
  const NO_SPACE_BEFORE = new Set(Array.from(',.;:!?)]}…”’»')); // (text beside a mark)
  const NO_SPACE_AFTER = new Set(Array.from('([{“‘«¿¡'));

  // The words that mean a mark (Chinese): one per first character, so the first character finds it.
  // The mark, and which more of the recogniser's own marks go with it (the same mark, said twice).
  const SPOKEN_ZH = [
    ['新段落', '\n\n', ''], ['结束引号', '”', ''], ['闭引号', '”', ''], ['开引号', '“', ''],
    ['感叹号', '！', '！!'], ['省略号', '……', ''], ['左括号', '（', ''], ['右括号', '）', ''],
    ['逗号', '，', ''], ['句号', '。', ''], ['问号', '？', '？?'], ['冒号', '：', ''],
    ['分号', '；', ''], ['顿号', '、', ''], ['换行', '\n', ''],
  ];
  const ZH_BY_FIRST = new Map(SPOKEN_ZH.map((row) => [row[0][0], row]));
  const ZH_DROP = '，。,.';

  // ── dictating: spoken marks become marks ──

  // The text in pieces that keep every character: ['w', a word], ['h', spaces on a line], ['n', a line
  // end] and ['o', any other single character].
  function tokens(text) {
    const cs = Array.from(text);
    const count = cs.length;
    const out = [];
    let i = 0;
    while (i < count) {
      const c = cs[i];
      if (HSPACE.has(c)) {
        let j = i + 1;
        while (j < count && HSPACE.has(cs[j])) j++;
        out.push(['h', cs.slice(i, j).join('')]);
        i = j;
      } else if (LINE_ENDS.has(c)) {
        out.push(['n', c]);
        i++;
      } else if (startsWord(c)) {
        let j = i + 1;
        while (j < count) {
          const d = cs[j];
          if (kind(d) !== 'o') j++;
          else if (JOINERS.has(d) && j + 1 < count && startsWord(cs[j + 1])) j += 2;
          else break;
        }
        out.push(['w', cs.slice(i, j).join('')]);
        i = j;
      } else {
        out.push(['o', c]);
        i++;
      }
    }
    return out;
  }

  // Where mark words are said: [first token, last token, the words], longest phrase first.
  function find(toks) {
    const count = toks.length;
    const found = [];
    let i = 0;
    while (i < count) {
      if (toks[i][0] !== 'w' || !FIRST_WORDS.has(lower(toks[i][1]))) { i++; continue; }
      const words = [];
      let best = null;
      let j = i;
      while (words.length < LONGEST_PHRASE) {
        words.push(lower(toks[j][1]));
        const phrase = words.join(' ');
        if (MARKS.has(phrase)) best = [j, phrase];
        if (j + 2 < count && toks[j + 1][0] === 'h' && toks[j + 2][0] === 'w') j += 2;
        else break;
      }
      if (best === null) {
        i++;
      } else {
        found.push([i, best[0], best[1]]);
        i = best[0] + 1;
      }
    }
    return found;
  }

  // Whether the tokens from first up to stop are only spaces (and line ends, if lines) and a comma or
  // full stop the recogniser wrote: nothing between that matters.
  function onlyNoise(toks, first, stop, lines) {
    for (let k = first; k < stop; k++) {
      const [kd, text] = toks[k];
      if (kd === 'h' || (kd === 'n' && lines) || (kd === 'o' && DROP.has(text))) continue;
      return false;
    }
    return true;
  }

  // Whether the ambiguous word found[k] is the ordinary word and not a mark: it comes after one of
  // BEFORE_ORDINARY, or before "of", unless it is the first word, right after a line end or after
  // another mark (that one ended at lastEnd). Last in the text, or right before another mark word, it
  // is always a mark.
  function staysAWord(toks, found, k, firstWord, lastEnd) {
    const [start, end] = found[k];
    const count = toks.length;
    if (k + 1 < found.length && onlyNoise(toks, end + 1, found[k + 1][0], false)) return false;
    if (onlyNoise(toks, end + 1, count, true)) return false;
    if (start >= 2 && toks[start - 1][0] === 'h' && toks[start - 2][0] === 'w'
      && BEFORE_ORDINARY.has(lower(toks[start - 2][1]))) return true;
    const beforeOf = end + 2 < count && toks[end + 1][0] === 'h' && toks[end + 2][0] === 'w'
      && lower(toks[end + 2][1]) === 'of';
    if (!beforeOf) return false;
    let p = start - 1;
    while (p >= 0 && toks[p][0] === 'h') p--;
    const leading = start === firstWord
      || (p >= 0 && toks[p][0] === 'n')
      || (lastEnd >= 0 && onlyNoise(toks, lastEnd + 1, start, false));
    return !leading;
  }

  // Which of the words found are marks (the rest stay ordinary words).
  function decide(toks, found) {
    let firstWord = 0;
    while (toks[firstWord][0] !== 'w') firstWord++;
    const marks = [];
    let lastEnd = -1;
    for (let k = 0; k < found.length; k++) {
      const [start, end, phrase] = found[k];
      const words = phrase.split(' ');
      const ambiguous = AMBIGUOUS.has(words[words.length - 1]);
      if (ambiguous && staysAWord(toks, found, k, firstWord, lastEnd)) continue;
      marks.push([start, end, phrase]);
      lastEnd = end;
    }
    return marks;
  }

  // What to do with the marks said: a Map of the first token of a mark to [its last token, the mark],
  // and a Set of the tokens to drop: the comma or full stop the recogniser wrote beside a mark (a "?"
  // or "!" too, when the mark is that same one).
  function plan(toks) {
    const count = toks.length;
    const at = new Map();
    const removed = new Set();
    const found = find(toks);
    if (!found.length) return [at, removed];
    for (const [start, end, phrase] of decide(toks, found)) {
      const mark = MARKS.get(phrase);
      const same = mark.text === '?' || mark.text === '!' ? mark.text : '';
      let j = start - 1;
      while (j >= 0 && toks[j][0] === 'h') j--;
      if (j >= 0 && toks[j][0] === 'o' && (DROP.has(toks[j][1]) || toks[j][1] === same)) removed.add(j);
      j = end + 1;
      while (j < count && toks[j][0] === 'h') j++;
      if (j < count && toks[j][0] === 'o' && (DROP.has(toks[j][1]) || toks[j][1] === same)) removed.add(j);
      at.set(start, [end, mark]);
    }
    return [at, removed];
  }

  // Whether a space follows the thing just written (a mark, or a piece of the text).
  function spaceAfter(last) {
    const kd = last[0];
    if (kd === 'm') return last[1].after === SPACE;
    if (kd === 'n') return false;
    return kd === 'w' || !NO_SPACE_AFTER.has(last[1]);
  }

  // Whether a space comes before a piece of the text that follows a mark.
  function spaceBefore(kd, text) {
    if (kd === 'n') return false;
    return kd === 'w' || !NO_SPACE_BEFORE.has(text);
  }

  // The text written out: each mark spaced the way it is written (the spaces the text had beside it
  // are replaced, all others kept), the recogniser's own marks gone, and the first letter of each
  // sentence, line and the text in capitals.
  function layOut(toks, at, removed) {
    const count = toks.length;
    const out = [];
    let capital = true; // the next word starts a sentence
    let last = null; // what was written last: ['m', mark] or [kind, text]; null at first
    let gap = ''; // the spaces seen since
    let i = 0;
    while (i < count) {
      if (removed.has(i)) { i++; continue; }
      if (at.has(i)) {
        const [end, mark] = at.get(i);
        let space = '';
        if (last !== null) {
          const number = last[0] === 'w' && DIGITS.has(last[1][last[1].length - 1]);
          const loose = mark.before === SPACE || (mark.before === NUMBER_ONLY && !number);
          space = loose && spaceAfter(last) ? ' ' : '';
        }
        out.push(space + mark.text);
        if (mark.starts) capital = true;
        last = ['m', mark];
        gap = '';
        i = end + 1;
        continue;
      }
      const kd = toks[i][0];
      let piece = toks[i][1];
      i++;
      if (kd === 'h') { gap += piece; continue; }
      if (last !== null && last[0] === 'm') {
        out.push(last[1].after === SPACE && spaceBefore(kd, piece) ? ' ' : '');
      } else {
        out.push(gap);
      }
      if (kd === 'w') {
        if (capital) {
          piece = capitalised(piece);
          capital = false;
        }
      } else if (kd === 'n') {
        capital = true;
      }
      out.push(piece);
      last = [kd, piece];
      gap = '';
    }
    if (last === null || last[0] !== 'm') out.push(gap);
    return out.join('');
  }

  // English: the marks said become marks, and the text around them is laid out as written.
  function dictatedEn(text) {
    const toks = tokens(text);
    const [at, removed] = plan(toks);
    return layOut(toks, at, removed);
  }

  // Chinese: the words are replaced where they stand (no spaces are involved), and a comma or full
  // stop the recogniser wrote beside one goes. Everything else is left alone.
  function dictatedZh(text) {
    const out = [];
    let start = 0; // where the plain text since the last mark begins
    let i = 0;
    const count = text.length;
    while (i < count) {
      const row = ZH_BY_FIRST.get(text[i]);
      if (row === undefined || !text.startsWith(row[0], i)) { i++; continue; }
      const [words, mark, same] = row;
      const drop = ZH_DROP + same;
      let before = text.slice(start, i);
      let e = before.length;
      while (e > 0 && (before[e - 1] === ' ' || before[e - 1] === '\t')) e--;
      if (e > 0 && drop.includes(before[e - 1])) before = before.slice(0, e - 1);
      out.push(before);
      out.push(mark);
      i += words.length;
      start = i;
      let j = i;
      while (j < count && (text[j] === ' ' || text[j] === '\t')) j++;
      if (j < count && drop.includes(text[j])) { i = j + 1; start = i; }
    }
    if (out.length === 0) return text;
    out.push(text.slice(start));
    return out.join('');
  }

  // "zh" for a language that starts with zh (zh-CN, zh_TW), else "en".
  const tongue = (language) => (lower(String(language)).startsWith('zh') ? 'zh' : 'en');

  // fromSpeech without the safety net.
  const dictated = (text, language) => (tongue(language) === 'zh' ? dictatedZh(text) : dictatedEn(text));

  // Dictated text with the spoken punctuation turned into marks, spaced and capitalised the way it is
  // written. Anything that is not text comes back as it was.
  function fromSpeech(text, language = 'en') {
    if (typeof text !== 'string' || text === '') return text;
    try {
      return dictated(text, language);
    } catch (_err) { // an odd character must never stop a person from typing
      return text;
    }
  }

  // ── listening: marks become words ──

  // What each mark is called when it is said, in each language.
  const NAMES = {
    en: {
      comma: 'comma', period: 'period', dot: 'dot', point: 'point', question: 'question mark',
      exclaim: 'exclamation mark', colon: 'colon', semicolon: 'semicolon',
      open_paren: 'open parenthesis', close_paren: 'close parenthesis', open_quote: 'open quote',
      close_quote: 'close quote', dash: 'dash', hyphen: 'hyphen', apostrophe: 'apostrophe',
      ellipsis: 'ellipsis', newline: 'new line', paragraph: 'new paragraph', slash: 'slash',
      backslash: 'backslash', at: 'at', hash: 'hash', ampersand: 'ampersand', asterisk: 'asterisk',
      underscore: 'underscore', equals: 'equals', plus: 'plus', percent: 'percent', dollar: 'dollar',
      tilde: 'tilde', caret: 'caret', bar: 'bar', less: 'less than', greater: 'greater than',
      open_bracket: 'open bracket', close_bracket: 'close bracket', open_brace: 'open brace',
      close_brace: 'close brace',
    },
    zh: {
      comma: '逗号', period: '句号', dot: '点', point: '小数点', question: '问号', exclaim: '感叹号',
      colon: '冒号', semicolon: '分号', enum: '顿号', open_paren: '左括号', close_paren: '右括号',
      open_quote: '开引号', close_quote: '结束引号', dash: '破折号', hyphen: '连字符', apostrophe: '撇号',
      ellipsis: '省略号', newline: '换行', paragraph: '新段落', slash: '斜杠', backslash: '反斜杠',
      at: '艾特', hash: '井号', ampersand: '和号', asterisk: '星号', underscore: '下划线', equals: '等号',
      plus: '加号', percent: '百分号', dollar: '美元符号', tilde: '波浪号', caret: '脱字符', bar: '竖线',
      less: '小于号', greater: '大于号', open_bracket: '左方括号', close_bracket: '右方括号',
      open_brace: '左花括号', close_brace: '右花括号',
    },
  };
  // The marks only level "all" says.
  const SYMBOLS = {
    '/': 'slash', '\\': 'backslash', '@': 'at', '#': 'hash', '&': 'ampersand', '*': 'asterisk',
    '_': 'underscore', '=': 'equals', '+': 'plus', '%': 'percent', '$': 'dollar', '~': 'tilde',
    '^': 'caret', '|': 'bar', '<': 'less', '>': 'greater', '[': 'open_bracket', ']': 'close_bracket',
    '{': 'open_brace', '}': 'close_brace',
  };
  // Chinese marks (and whether each ends a sentence); only a Chinese text has them to say.
  const FULL = {
    '，': ['comma', false], '。': ['period', true], '？': ['question', true], '！': ['exclaim', true],
    '：': ['colon', false], '；': ['semicolon', false], '、': ['enum', false],
    '（': ['open_paren', false], '）': ['close_paren', false],
  };
  // "didn't" and "dogs'" have this in them; the curly ones too.
  const APOSTROPHES = new Set(["'", '‘', '’']);
  // The characters that may close a sentence after its last mark: ."), ?'
  const SENTENCE_TAIL = new Set(Array.from('"”’\')]}»'));
  const OPENING = new Set(Array.from('([{'));
  const WATCH_EN = new Set([
    ...[...BLANKS].filter((c) => c !== ' '),
    ...Array.from('.,?!:;()"“”-–—…\'‘’'),
    ...Object.keys(SYMBOLS),
  ]);
  const WATCH_ZH = new Set([...WATCH_EN, ...Object.keys(FULL)]);

  // The abbreviations whose full stop is not the end of a sentence, in lower case with the stop.
  // (e.g. i.e. a.m. p.m. U.S. and any run of single letters, like J.R.R., are known without this.)
  const ABBREVIATIONS = new Set((
    'dr. mr. mrs. ms. prof. st. jr. sr. vs. etc. e.g. i.e. inc. ltd. co. no. a.m. p.m. u.s. '
    + 'al. cf. ph.d. pp. vol. dept. approx.').split(' '));
  const CAPITAL_ONLY = new Set(['no']); // "No. 5" is an abbreviation; "I said no." is a sentence
  const LONGEST_ABBREVIATION = 8; // letters and dots before the stop; a longer run is a word or an address

  // Single letters with dots between: U.S, e.g, a.m, J.R.R (the last stop is not in the word).
  function initials(letters) {
    if (letters.length < 3 || letters.length % 2 === 0) return false;
    for (let k = 0; k < letters.length; k++) {
      if (k % 2) {
        if (letters[k] !== '.') return false;
      } else if (kind(letters[k]) !== 'L') {
        return false;
      }
    }
    return true;
  }

  // Whether the full stop at cs[i] closes an abbreviation or a single capital initial.
  function abbreviation(cs, i) {
    let j = i;
    while (j > 0 && (cs[j - 1] === '.' || kind(cs[j - 1]) === 'L' || kind(cs[j - 1]) === 'M')) {
      j--;
      if (i - j > LONGEST_ABBREVIATION) return false;
    }
    if (j === i || (j > 0 && DIGITS.has(cs[j - 1]))) return false; // nothing before it, or part of "5A."
    const letters = cs.slice(j, i);
    const word = letters.join('');
    const low = lower(word);
    if (ABBREVIATIONS.has(`${low}.`)) return !CAPITAL_ONLY.has(low) || isUpper(letters[0]);
    if (letters.length === 1) return isUpper(word);
    return initials(letters);
  }

  // Whether a sentence could end at cs[j - 1]: only closing marks, then a space or the end.
  function ends(cs, j) {
    const count = cs.length;
    while (j < count && SENTENCE_TAIL.has(cs[j])) j++;
    return j >= count || BLANKS.has(cs[j]);
  }

  // The white space at both ends of a text (spaces, tabs, line ends) cut off.
  function trimmed(text) {
    let a = 0;
    let b = text.length;
    while (a < b && BLANKS.has(text[a])) a++;
    while (b > a && BLANKS.has(text[b - 1])) b--;
    return text.slice(a, b);
  }

  // The text as a list: pieces that stay as they are (a character, or a few), and [name, ends] for
  // each mark to be said (ends: it closes a sentence). Spaces and line ends are looked at only here;
  // the white space of the text is trimmed, a run of it is one space, a line end is a mark.
  function speak(text, level, lang) {
    const cs = Array.from(trimmed(text));
    const count = cs.length;
    const names = NAMES[lang];
    const everything = level === 'all';
    const watch = lang === 'zh' ? WATCH_ZH : WATCH_EN;
    const items = [];
    let i = 0;
    while (i < count) {
      const c = cs[i];
      if (!watch.has(c)) {
        items.push(c);
        i++;
        continue;
      }
      const before = i > 0 ? cs[i - 1] : '';
      const after = i + 1 < count ? cs[i + 1] : '';
      let step = 1;
      if (BLANKS.has(c)) {
        let j = i + 1;
        while (j < count && BLANKS.has(cs[j])) j++;
        let breaks = 0;
        for (let k = i; k < j; k++) {
          if (LINE_ENDS.has(cs[k]) && !(cs[k] === '\r' && k + 1 < j && cs[k + 1] === '\n')) breaks++;
        }
        if (breaks === 0) items.push(' ');
        else items.push([names[breaks === 1 ? 'newline' : 'paragraph'], false]);
        step = j - i;
      } else if (c === '.') {
        let run = 1;
        while (i + run < count && cs[i + run] === '.') run++;
        if (run >= 3) {
          if (everything) items.push([names.ellipsis, ends(cs, i + run)]);
          else items.push('.'.repeat(run));
          step = run;
        } else if (DIGITS.has(before) && DIGITS.has(after)) {
          items.push(everything ? [names.point, false] : c);
        } else if (before !== '.' && ends(cs, i + 1) && !abbreviation(cs, i)) {
          items.push([names.period, true]);
        } else {
          items.push(everything ? [names.dot, false] : c);
        }
      } else if (c === ',') {
        items.push(DIGITS.has(before) && DIGITS.has(after) ? c : [names.comma, false]);
      } else if (c === '?') {
        items.push([names.question, ends(cs, i + 1)]);
      } else if (c === '!') {
        items.push([names.exclaim, ends(cs, i + 1)]);
      } else if (c === ':') {
        if (everything || ends(cs, i + 1)) items.push([names.colon, false]);
        else items.push(c);
      } else if (c === ';') {
        items.push([names.semicolon, false]);
      } else if (c === '(') {
        items.push([names.open_paren, false]);
      } else if (c === ')') {
        items.push([names.close_paren, false]);
      } else if (c === '"') {
        const opening = before === '' || BLANKS.has(before) || OPENING.has(before);
        items.push([names[opening ? 'open_quote' : 'close_quote'], false]);
      } else if (c === '“') {
        items.push([names.open_quote, false]);
      } else if (c === '”') {
        items.push([names.close_quote, false]);
      } else if (c === '–' || c === '—') {
        items.push([names.dash, false]);
      } else if (c === '-') {
        if ((before === '' || BLANKS.has(before)) && (after === '' || BLANKS.has(after))) {
          items.push([names.dash, false]);
        } else if (everything && kind(before) !== 'o' && kind(after) !== 'o') {
          items.push([names.hyphen, false]);
        } else {
          items.push(c);
        }
      } else if (c === '…') {
        let run = 1;
        while (i + run < count && cs[i + run] === '…') run++;
        if (everything) items.push([names.ellipsis, ends(cs, i + run)]);
        else items.push(c.repeat(run));
        step = run;
      } else if (APOSTROPHES.has(c)) {
        const inside = kind(before) !== 'o' && kind(after) !== 'o';
        items.push(inside || !everything ? c : [names.apostrophe, false]);
      } else if (c in SYMBOLS) {
        items.push(everything ? [names[SYMBOLS[c]], false] : c);
      } else { // a Chinese mark (only in a Chinese text)
        const [key, closes] = FULL[c];
        items.push([names[key], closes]);
      }
      i += step;
    }
    return items;
  }

  // The items as one line: each mark's name between single spaces, spaces collapsed, trimmed.
  function said(items) {
    const parts = items.map((item) => (typeof item === 'string' ? item : ` ${item[0]} `));
    const line = parts.join('').replace(/ {2,}/g, ' ');
    let a = 0;
    let b = line.length;
    while (a < b && line[a] === ' ') a++;
    while (b > a && line[b - 1] === ' ') b--;
    return line.slice(a, b);
  }

  // "none", "some" or "all"; anything else (a typo, a missing setting) is "some".
  function levelOf(level) {
    const word = typeof level === 'string' ? lower(level) : '';
    return LEVELS.includes(word) ? word : 'some';
  }

  // Text made ready for a voice to say its punctuation aloud. level "none" gives the text back
  // unchanged; "some" says the marks that end and divide sentences; "all" says every mark.
  function toSpeech(text, level = 'some', language = 'en') {
    if (typeof text !== 'string') return text;
    const lv = levelOf(level);
    if (lv === 'none') return text;
    try {
      return said(speak(text, lv, tongue(language)));
    } catch (_err) { // (a voice that fails to read is worse than one that reads it plain)
      return text;
    }
  }

  // ── describing ──

  const SIGNS = new Set(['at', 'dollar', 'percent', 'equals', 'plus', 'less than', 'greater than']);
  const PLURALS = new Map([
    ['dash', 'dashes'], ['hash', 'hashes'], ['slash', 'slashes'], ['backslash', 'backslashes'],
    ['ellipsis', 'ellipses'], ['open parenthesis', 'open parentheses'],
    ['close parenthesis', 'close parentheses'],
  ]);

  // "1 comma", "2 commas", "3 open parentheses", "1 at sign".
  function plural(name, count) {
    if (SIGNS.has(name)) name += ' sign';
    if (count === 1) return `1 ${name}`;
    return `${count} ${PLURALS.has(name) ? PLURALS.get(name) : `${name}s`}`;
  }

  // "a", "a and b", "a, b and c".
  function andJoin(parts, joiner, comma) {
    if (parts.length === 1) return parts[0];
    return parts.slice(0, -1).join(comma) + joiner + parts[parts.length - 1];
  }

  // The sentence a voice says about a text's punctuation, the marks that are most used first.
  function summary(counts, sentences, lang) {
    const names = Object.keys(counts).sort((a, b) => (counts[b] - counts[a]) || (a < b ? -1 : a > b ? 1 : 0));
    if (lang === 'zh') {
      if (!names.length) return '没有标点。';
      const parts = names.map((name) => `${counts[name]} 个${name}`);
      return `${sentences} 句话。${andJoin(parts, '和 ', '，')}。`;
    }
    if (!names.length) return 'No punctuation.';
    const parts = names.map((name) => plural(name, counts[name]));
    const noun = sentences === 1 ? 'sentence' : 'sentences';
    return `${sentences} ${noun}. ${andJoin(parts, ' and ', ', ')}.`;
  }

  function described(text, language) {
    const lang = tongue(language);
    const items = speak(text, 'all', lang);
    if (!items.length) {
      const empty = lang === 'zh' ? '没有可描述的内容。' : "There's nothing to describe.";
      return { summary: empty, spoken: '', counts: {}, sentences: 0 };
    }
    const names = NAMES[lang];
    const layout = [names.newline, names.paragraph]; // (where a line ends is not punctuation)
    const counts = {};
    let sentences = 0;
    for (const item of items) {
      if (typeof item === 'string') continue;
      const [name, closes] = item;
      if (closes) sentences++;
      if (!layout.includes(name)) counts[name] = (counts[name] || 0) + 1;
    }
    sentences = sentences || 1;
    return { summary: summary(counts, sentences, lang), spoken: said(items), counts, sentences };
  }

  // How a text is punctuated: { summary: a sentence a voice can say, spoken: the text with every mark
  // said, counts: { name: how many } for the marks there are, sentences: how many }.
  function describe(text, language = 'en') {
    try {
      return described(typeof text === 'string' ? text : '', language);
    } catch (_err) {
      return { summary: "There's nothing to describe.", spoken: '', counts: {}, sentences: 0 };
    }
  }

  const lib = { LEVELS, fromSpeech, toSpeech, describe };
  root.jarvisPunctuation = lib;
  if (typeof module === 'object' && module.exports) module.exports = lib;
})(typeof window !== 'undefined' ? window : globalThis);
