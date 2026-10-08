// The code canvas's logic without the page (artifact.js draws it; src/__tests__/canvas.test.ts):
// which language a block is, how it's highlighted (a small tokenizer: keywords, strings,
// comments, numbers; no library), where it runs, and what a run may carry.
//
// Where code runs:
// - 'js' and 'py': in this browser, in runner.html (an opaque-origin sandbox: no cookies, no
//   storage, no way to Eden's page; its only network is cdn.jsdelivr.net for Pyodide), each run
//   in a Web Worker that Stop or the time limit terminates.
// - 'cloud': Eden's cloud runner (POST /api/chat/run); it answers "coming soon" until it's set up.

export const LIMITS = { codeBytes: 100_000, stdinBytes: 64_000, outputBytes: 200_000, timeMs: 30_000 };

// id: [label, runner, extension, aliases]
const TABLE = {
  javascript: ['JavaScript', 'js', 'js', ['js', 'mjs', 'cjs', 'node', 'jsx']],
  typescript: ['TypeScript', 'cloud', 'ts', ['ts', 'tsx']],
  python: ['Python', 'py', 'py', ['py', 'python3', 'py3']],
  bash: ['Bash', 'cloud', 'sh', ['sh', 'shell', 'zsh', 'console', 'shellscript']],
  go: ['Go', 'cloud', 'go', ['golang']],
  rust: ['Rust', 'cloud', 'rs', ['rs']],
  c: ['C', 'cloud', 'c', ['h']],
  cpp: ['C++', 'cloud', 'cpp', ['c++', 'cc', 'cxx', 'hpp']],
  java: ['Java', 'cloud', 'java', []],
  ruby: ['Ruby', 'cloud', 'rb', ['rb']],
  php: ['PHP', 'cloud', 'php', []],
  html: ['HTML', null, 'html', ['htm', 'xhtml', 'artifact']],
  css: ['CSS', null, 'css', []],
  json: ['JSON', null, 'json', []],
  sql: ['SQL', null, 'sql', []],
  text: ['Plain text', null, 'txt', ['txt', 'plaintext', '']],
};
export const LANGS = Object.entries(TABLE).map(([id, [label, runner, ext]]) => ({ id, label, runner, ext }));
const ALIAS = new Map();
for (const [id, [, , , aliases]] of Object.entries(TABLE)) { ALIAS.set(id, id); for (const a of aliases) ALIAS.set(a, id); }

/** A fence's language word as one of LANGS' ids, or '' when it isn't one. */
export const normLang = (word) => ALIAS.get(String(word ?? '').trim().toLowerCase()) ?? '';

/** The language of some code: the fence's word when it names one, else a guess from the code. */
export function detectLang(code, hint = '') {
  const named = normLang(hint);
  if (named && named !== 'text') return named;
  const s = String(code || '');
  const first = s.split('\n', 1)[0];
  if (/^#!.*\b(bash|sh|zsh)\b/.test(first)) return 'bash';
  if (/^#!.*\bpython/.test(first)) return 'python';
  if (/^#!.*\b(node|deno|bun)\b/.test(first)) return 'javascript';
  if (/^<\?php/.test(s)) return 'php';
  if (/^\s*(<!doctype html|<html[\s>])/i.test(s)) return 'html';
  if (/^\s*package\s+main\b/m.test(s) || /\bfunc\s+main\s*\(\)/.test(s)) return 'go';
  if (/\bfn\s+main\s*\(\)|\blet\s+mut\b|println!\(/.test(s)) return 'rust';
  if (/\bpublic\s+(static\s+)?(class|void)\b|System\.out\.print/.test(s)) return 'java';
  if (/#include\s*<(iostream|vector|string|map)>|\bstd::|\bcout\s*<</.test(s)) return 'cpp';
  if (/#include\s*<\w+\.h>|\bprintf\s*\(/.test(s) && /\bint\s+main\s*\(/.test(s)) return 'c';
  if (/^\s*(def|class)\s+\w+.*:\s*$/m.test(s) || /^\s*(import|from)\s+[\w.]+(\s+import\b|\s*$)/m.test(s) && !/[;{}]\s*$/m.test(s) || /\bprint\(/.test(s) && !/[;{}]\s*$/m.test(s)) return 'python';
  if (/^\s*(def\s+\w+[^:]*$|puts\s|require\s+['"])/m.test(s) && /^\s*end\s*$/m.test(s)) return 'ruby';
  if (/:\s*(string|number|boolean|void)\b|\binterface\s+\w+\s*\{|\btype\s+\w+\s*=/.test(s)) return 'typescript';
  if (/\b(const|let|var|function)\b|=>|console\.log|require\(|import\s.+\sfrom\s/.test(s)) return 'javascript';
  if (/^\s*(SELECT|INSERT|UPDATE|CREATE TABLE|DELETE)\b/im.test(s)) return 'sql';
  if (/^\s*[{[]/.test(s)) { try { JSON.parse(s); return 'json'; } catch { /* not JSON */ } }
  if (/^\s*(echo|cd|ls|export|if \[|for \w+ in|npm|pip|brew|git)\b/m.test(s)) return 'bash';
  return 'text';
}

export const langInfo = (id) => LANGS.find((l) => l.id === id) || LANGS.find((l) => l.id === 'text');
/** Where a language runs: 'js', 'py', 'cloud', or null (nothing to run). */
export const runnerOf = (id) => langInfo(id).runner;

/** Enough code to deserve the canvas (a one-liner stays in the chat). */
export const substantial = (code) => String(code || '').replace(/\n+$/, '').split('\n').length >= 4;

/** A download name: the title's words, or "code", with the language's extension. */
export function fileName(title, lang) {
  const base = String(title || '').toLowerCase().replace(/\.[a-z0-9]{1,5}$/, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'code';
  const ext = langInfo(lang).ext;
  return /-snippet$/.test(base) ? `code.${ext}` : `${base}.${ext}`;
}

const bytes = (s) => new TextEncoder().encode(String(s ?? '')).length;

/** May this run start? { ok, runner } or { ok: false, why } (the server checks cloud runs again). */
export function checkRun({ lang, code, stdin = '' }) {
  const runner = runnerOf(lang);
  if (!runner) return { ok: false, why: `${langInfo(lang).label} doesn’t run; pick a language to run it as.` };
  if (!String(code || '').trim()) return { ok: false, why: 'There’s no code to run.' };
  if (bytes(code) > LIMITS.codeBytes) return { ok: false, why: `Code over ${LIMITS.codeBytes / 1000} KB doesn’t run.` };
  if (bytes(stdin) > LIMITS.stdinBytes) return { ok: false, why: `Input over ${LIMITS.stdinBytes / 1000} KB doesn’t run.` };
  return { ok: true, runner };
}

/** Appending output, capped: once the cap is reached the rest is dropped with one note. */
export function appendCapped(total, text, cap = LIMITS.outputBytes) {
  if (total >= cap) return { text: '', total, cut: false };
  const room = cap - total;
  if (text.length <= room) return { text, total: total + text.length, cut: false };
  return { text: `${text.slice(0, room)}\n… output cut at ${Math.round(cap / 1000)} KB\n`, total: cap, cut: true };
}

/** What Eden is asked when the viewer asks for an edit of a selection. */
export function editRequest({ title, lang, code, selection, instruction }) {
  const label = langInfo(lang).label;
  return `Edit ${title ? `“${title}”` : 'this file'} (${label}) in the canvas. ${String(instruction || '').trim() || 'Improve it.'}\n\n`
    + `Change only this part unless the change needs more:\n\`\`\`${lang}\n${selection}\n\`\`\`\n\n`
    + `Reply with the whole revised file in one \`\`\`${lang} block.\n\nThe file now:\n\`\`\`${lang}\n${code}\n\`\`\``;
}

/** The file in a reply to an edit request: the longest fenced block, preferring the language asked for. */
export function revisedIn(text, lang) {
  const re = /^ {0,3}(`{3,}|~{3,})\s*([\w+-]*)[^\n]*\n([\s\S]*?)\n {0,3}\1\s*$/gm;
  let best = null, m;
  while ((m = re.exec(String(text || '')))) {
    const same = normLang(m[2]) === lang;
    const score = (same ? 1e9 : 0) + m[3].length;
    if (!best || score > best.score) best = { code: m[3], score };
  }
  return best ? best.code : null;
}

// ── highlighting ──

const KW = {
  javascript: 'await break case catch class const continue default delete do else export extends finally for from function if import in instanceof let new of return static super switch this throw try typeof var void while yield async null undefined true false',
  python: 'and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return try while with yield None True False self print',
  bash: 'if then else elif fi for while until do done case esac function in return local export echo exit set unset readonly shift source',
  go: 'break case chan const continue default defer else fallthrough for func go goto if import interface map package range return select struct switch type var nil true false',
  rust: 'as async await break const continue crate else enum extern false fn for if impl in let loop match mod move mut pub ref return self Self static struct super trait true type unsafe use where while',
  c: 'auto break case char const continue default do double else enum extern float for goto if int long register return short signed sizeof static struct switch typedef union unsigned void volatile while include define NULL',
  java: 'abstract boolean break byte case catch char class const continue default do double else enum extends final finally float for if implements import instanceof int interface long new null package private protected public return short static super switch this throw throws try void while true false var',
  ruby: 'begin break case class def do else elsif end ensure false for if in module next nil not or redo rescue retry return self super then true undef unless until when while yield puts require',
  php: 'abstract and array as break case catch class const continue default do echo else elseif extends final for foreach function global if implements interface namespace new null private protected public require return static switch throw try use var while true false',
  sql: 'select from where insert into values update set delete create table drop alter join left right inner outer on group by order having limit as and or not null primary key distinct count',
  css: '', json: 'true false null', html: '', text: '',
};
KW.typescript = `${KW.javascript} interface type enum implements private public protected readonly declare namespace abstract as keyof never unknown any string number boolean`;
KW.cpp = `${KW.c} class namespace template typename using new delete public private protected virtual override bool true false nullptr std cout cin endl auto`;
const KWSETS = Object.fromEntries(Object.entries(KW).map(([k, v]) => [k, new Set(v.split(' ').filter(Boolean))]));
const HASH_COMMENT = new Set(['python', 'bash', 'ruby']);
const SLASH_COMMENT = new Set(['javascript', 'typescript', 'go', 'rust', 'c', 'cpp', 'java', 'php', 'css']);

/**
 * The code as tokens [{ t, v }]: t is 'kw', 'str', 'com', 'num', 'fn' or '' (plain). Joining
 * every v gives the code back exactly.
 */
export function tokenize(code, lang) {
  const s = String(code ?? '');
  const out = [];
  const kws = KWSETS[lang] || KWSETS.text;
  if (lang === 'text' || !KWSETS[lang]) return s ? [{ t: '', v: s }] : [];
  const ci = lang === 'sql';
  let i = 0, plain = '';
  const push = (t, v) => { if (plain) { out.push({ t: '', v: plain }); plain = ''; } out.push({ t, v }); };
  while (i < s.length) {
    const c = s[i], rest2 = s.slice(i, i + 2);
    // comments
    if ((SLASH_COMMENT.has(lang) && rest2 === '//' && lang !== 'css') || (HASH_COMMENT.has(lang) && c === '#') || (lang === 'php' && c === '#') || (lang === 'sql' && rest2 === '--')) {
      const end = s.indexOf('\n', i); const j = end < 0 ? s.length : end; push('com', s.slice(i, j)); i = j; continue;
    }
    if ((SLASH_COMMENT.has(lang) && rest2 === '/*') || (lang === 'html' && s.startsWith('<!--', i))) {
      const close = lang === 'html' ? '-->' : '*/'; const end = s.indexOf(close, i + 2); const j = end < 0 ? s.length : end + close.length; push('com', s.slice(i, j)); i = j; continue;
    }
    if (lang === 'python' && (s.startsWith('"""', i) || s.startsWith("'''", i))) {
      const q = s.slice(i, i + 3); const end = s.indexOf(q, i + 3); const j = end < 0 ? s.length : end + 3; push('str', s.slice(i, j)); i = j; continue;
    }
    // strings
    if (c === '"' || c === "'" || (c === '`' && ['javascript', 'typescript', 'go', 'bash'].includes(lang))) {
      let j = i + 1;
      while (j < s.length && s[j] !== c) { if (s[j] === '\\') j++; else if (s[j] === '\n' && c !== '`') break; j++; }
      j = Math.min(s.length, j + 1);
      push('str', s.slice(i, j)); i = j; continue;
    }
    // numbers
    if (/[0-9]/.test(c) && !/[\w$]/.test(s[i - 1] || '')) {
      const m = /^(0x[0-9a-f_]+|\d[\d_]*(\.\d+)?(e[+-]?\d+)?)/i.exec(s.slice(i)); push('num', m[0]); i += m[0].length; continue;
    }
    // words
    if (/[A-Za-z_$@]/.test(c)) {
      const m = /^[A-Za-z_$@][\w$]*/.exec(s.slice(i)); const w = m[0];
      if (kws.has(ci ? w.toLowerCase() : w)) push('kw', w);
      else if (s[i + w.length] === '(') push('fn', w);
      else plain += w;
      i += w.length; continue;
    }
    plain += c; i++;
  }
  if (plain) out.push({ t: '', v: plain });
  return out;
}
