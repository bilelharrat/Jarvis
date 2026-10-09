// Eden Code's diff view: hunks with three lines of context, a small syntax highlighter
// (keywords, strings, comments, numbers; no dependencies), the words that changed inside a
// changed line, unified or side by side, the unchanged lines between hunks collapsed, and
// long hunks drawn a slice at a time. Pure helpers are exported for node's tests; the
// window gets them, and buildHunk(), as window.JarvisDiff.
(function codeDiff(root) {
  // ── languages ──

  const WORDS = {
    python: 'and as assert async await break class continue def del elif else except False finally for from global if import in is lambda None nonlocal not or pass raise return self True try while with yield match case',
    js: 'async await break case catch class const continue debugger default delete do else export extends false finally for from function if import in instanceof let new null of return static super switch this throw true try typeof undefined var void while with yield interface type enum implements private public protected readonly declare namespace abstract as keyof',
    swift: 'actor as associatedtype async await break case catch class continue default defer deinit do else enum extension fallthrough false fileprivate final for func guard if import in init inout internal is let mutating nil nonisolated open operator override private protocol public repeat rethrows return self Self some static struct subscript super switch throw throws true try typealias var weak where while any',
    go: 'break case chan const continue default defer else fallthrough false for func go goto if import interface map nil package range return select struct switch true type var',
    rust: 'as async await break const continue crate dyn else enum extern false fn for if impl in let loop match mod move mut pub ref return self Self static struct super trait true type unsafe use where while',
    java: 'abstract assert boolean break byte case catch char class const continue default do double else enum extends false final finally float for fun goto if implements import in instanceof int interface is long native new null object override package private protected public return short static super switch synchronized this throw throws transient true try val var void volatile when while',
    c: 'auto bool break case char class const continue default delete do double else enum extern false float for goto if inline int long namespace new nullptr private protected public register return short signed sizeof static struct switch template this true typedef typename union unsigned using virtual void volatile while include define ifdef ifndef endif pragma',
    ruby: 'alias and begin break case class def defined do else elsif end ensure false for if in module next nil not or redo rescue retry return self super then true undef unless until when while yield require attr_accessor',
    shell: 'if then else elif fi case esac for while until do done in function return local export readonly echo exit set unset source',
    sql: 'select from where and or not insert into values update set delete create table index view drop alter add join left right inner outer on group by order having limit offset as distinct union all null is in like between case when then else end primary key foreign references default',
    php: 'abstract and array as break case catch class clone const continue declare default do echo else elseif empty enddeclare endfor endforeach endif endswitch endwhile extends final finally fn for foreach function global if implements include instanceof interface isset list match namespace new null or print private protected public require return static switch throw trait true false try unset use var while yield',
    lua: 'and break do else elseif end false for function goto if in local nil not or repeat return then true until while',
    json: 'true false null',
    yaml: 'true false null yes no on off',
    toml: 'true false',
    css: 'important',
    html: '',
    markdown: '',
  };
  const SPEC = {
    python: { line: ['#'], block: [], quotes: ['"""', "'''", '"', "'"] },
    js: { line: ['//'], block: [['/*', '*/']], quotes: ['`', '"', "'"] },
    swift: { line: ['//'], block: [['/*', '*/']], quotes: ['"""', '"'] },
    go: { line: ['//'], block: [['/*', '*/']], quotes: ['`', '"', "'"] },
    rust: { line: ['//'], block: [['/*', '*/']], quotes: ['"'] },
    java: { line: ['//'], block: [['/*', '*/']], quotes: ['"""', '"', "'"] },
    c: { line: ['//'], block: [['/*', '*/']], quotes: ['"', "'"] },
    ruby: { line: ['#'], block: [['=begin', '=end']], quotes: ['"', "'"] },
    shell: { line: ['#'], block: [], quotes: ['"', "'"] },
    sql: { line: ['--'], block: [['/*', '*/']], quotes: ["'", '"'], nocase: true },
    php: { line: ['//', '#'], block: [['/*', '*/']], quotes: ['"', "'"] },
    lua: { line: ['--'], block: [['--[[', ']]']], quotes: ['"', "'"] },
    json: { line: [], block: [], quotes: ['"'] },
    yaml: { line: ['#'], block: [], quotes: ['"', "'"], keys: true },
    toml: { line: ['#'], block: [], quotes: ['"""', '"', "'"], keys: true },
    css: { line: [], block: [['/*', '*/']], quotes: ['"', "'"] },
    html: { line: [], block: [['<!--', '-->']], quotes: ['"', "'"], tags: true },
    markdown: { line: [], block: [], quotes: ['`'], markdown: true },
  };
  const EXT = {
    py: 'python', pyi: 'python', pyw: 'python', js: 'js', mjs: 'js', cjs: 'js', jsx: 'js', ts: 'js', tsx: 'js', mts: 'js', cts: 'js',
    json: 'json', jsonc: 'js', css: 'css', scss: 'css', less: 'css', html: 'html', htm: 'html', xml: 'html', svg: 'html', vue: 'html', plist: 'html',
    swift: 'swift', go: 'go', rs: 'rust', java: 'java', kt: 'java', kts: 'java', scala: 'java', dart: 'java', cs: 'java', groovy: 'java', gradle: 'java',
    c: 'c', h: 'c', cc: 'c', cpp: 'c', cxx: 'c', hpp: 'c', m: 'c', mm: 'c', rb: 'ruby', rake: 'ruby', gemspec: 'ruby', sh: 'shell', bash: 'shell', zsh: 'shell', fish: 'shell',
    sql: 'sql', php: 'php', lua: 'lua', yml: 'yaml', yaml: 'yaml', toml: 'toml', md: 'markdown', markdown: 'markdown',
  };
  const NAMES = { Makefile: 'shell', Dockerfile: 'shell', Gemfile: 'ruby', Rakefile: 'ruby', Podfile: 'ruby', '.zshrc': 'shell', '.bashrc': 'shell' };
  const keywordSets = new Map();

  function langFor(path) {
    const name = String(path || '').split('/').pop();
    if (NAMES[name]) return NAMES[name];
    const ext = name.includes('.') ? name.split('.').pop().toLowerCase() : '';
    return EXT[ext] || '';
  }

  function keywordsOf(lang) {
    if (!keywordSets.has(lang)) {
      const spec = SPEC[lang] || {};
      const words = (WORDS[lang] || '').split(/\s+/).filter(Boolean);
      keywordSets.set(lang, new Set(spec.nocase ? words.map((w) => w.toLowerCase()) : words));
    }
    return keywordSets.get(lang);
  }

  // One line's pieces: [[class, text], …] ('' plain, k keyword, s string, c comment, n
  // number, t tag or key). state carries a comment or string that runs on to the next line.
  function highlight(text, lang, state = {}) {
    const spec = SPEC[lang];
    const line = String(text);
    if (!spec || line.length > 2000) return { segs: [['', line]], state: {} };
    const segs = [];
    const push = (cls, piece) => {
      if (!piece) return;
      const last = segs[segs.length - 1];
      if (last && last[0] === cls) last[1] += piece; else segs.push([cls, piece]);
    };
    const words = keywordsOf(lang);
    let i = 0;
    let open = state.open || null; // { cls, end }
    if (open) {
      const at = line.indexOf(open.end);
      if (at < 0) { push(open.cls, line); return { segs, state: { open } }; }
      push(open.cls, line.slice(0, at + open.end.length));
      i = at + open.end.length;
      open = null;
    }
    if (spec.markdown && /^\s{0,3}#{1,6}\s/.test(line)) return { segs: [['k', line]], state: {} };
    while (i < line.length) {
      const rest = line.slice(i);
      const lc = spec.line.find((m) => rest.startsWith(m) && (m !== '#' || lang !== 'shell' || i === 0 || /\s/.test(line[i - 1])));
      if (lc) { push('c', rest); break; }
      const block = spec.block.find(([start]) => rest.startsWith(start));
      if (block) {
        const end = rest.indexOf(block[1], block[0].length);
        if (end < 0) { push('c', rest); open = { cls: 'c', end: block[1] }; break; }
        push('c', rest.slice(0, end + block[1].length));
        i += end + block[1].length;
        continue;
      }
      const quote = spec.quotes.find((q) => rest.startsWith(q));
      if (quote) {
        let j = quote.length;
        let closed = false;
        while (j < rest.length) {
          if (rest[j] === '\\' && quote !== "'''" && !(lang === 'shell' && quote === "'")) { j += 2; continue; }
          if (rest.startsWith(quote, j)) { j += quote.length; closed = true; break; }
          j += 1;
        }
        const piece = rest.slice(0, Math.min(j, rest.length));
        const isKey = spec.keys || lang === 'json' ? /^\s*:/.test(rest.slice(piece.length)) : false;
        push(isKey ? 't' : 's', piece);
        i += piece.length;
        if (!closed && (quote.length === 3 || quote === '`')) { open = { cls: 's', end: quote }; break; }
        continue;
      }
      if (spec.tags && rest[0] === '<') {
        const tag = /^<\/?[A-Za-z][\w:.-]*/.exec(rest);
        if (tag) { push('t', tag[0]); i += tag[0].length; continue; }
      }
      const num = /^(?:0[xX][\da-fA-F_]+|0[bB][01_]+|\d[\d_]*(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(rest);
      if (num && (i === 0 || !/[\w$]/.test(line[i - 1]))) { push('n', num[0]); i += num[0].length; continue; }
      const word = /^[A-Za-z_$@][\w$]*/.exec(rest);
      if (word) {
        const w = word[0];
        const key = spec.nocase ? w.toLowerCase() : w;
        let cls = words.has(key) ? 'k' : '';
        if (!cls && spec.keys && /^\s*[:=]/.test(rest.slice(w.length)) && !segs.some(([c, t]) => c !== '' || t.trim())) cls = 't';
        if (!cls && lang === 'shell' && i > 0 && line[i - 1] === '$') cls = 't';
        push(cls, w);
        i += w.length;
        continue;
      }
      push('', line[i]);
      i += 1;
    }
    return { segs, state: open ? { open } : {} };
  }

  // ── what changed inside a changed line ──

  function tokens(text) { return String(text).match(/[\w$]+|\s+|[^\w\s$]/g) || []; }

  // The ranges of a and b that differ, as [start, end) character offsets: words that stayed
  // the same are left out. Past 200 tokens a side, just the stretch between what's common
  // at both ends. When most of the line changed, nothing is marked (it would be noise).
  function wordDiff(a, b) {
    const ta = tokens(a), tb = tokens(b);
    let ra = [], rb = [];
    if (ta.length <= 200 && tb.length <= 200) {
      const n = ta.length, m = tb.length;
      const dp = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
      for (let i = n - 1; i >= 0; i -= 1) {
        for (let j = m - 1; j >= 0; j -= 1) dp[i][j] = ta[i] === tb[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
      }
      const keepA = new Uint8Array(n), keepB = new Uint8Array(m);
      let i = 0, j = 0;
      while (i < n && j < m) {
        if (ta[i] === tb[j]) { keepA[i] = 1; keepB[j] = 1; i += 1; j += 1; } else if (dp[i + 1][j] >= dp[i][j + 1]) i += 1; else j += 1;
      }
      ra = spans(ta, keepA);
      rb = spans(tb, keepB);
    } else {
      let p = 0;
      while (p < ta.length && p < tb.length && ta[p] === tb[p]) p += 1;
      let s = 0;
      while (s < ta.length - p && s < tb.length - p && ta[ta.length - 1 - s] === tb[tb.length - 1 - s]) s += 1;
      const off = (list, k) => list.slice(0, k).join('').length;
      if (p < ta.length - s) ra = [[off(ta, p), off(ta, ta.length - s)]];
      if (p < tb.length - s) rb = [[off(tb, p), off(tb, tb.length - s)]];
    }
    const size = (rs) => rs.reduce((t, [x, y]) => t + y - x, 0);
    if (size(ra) > 0.7 * String(a).length && size(rb) > 0.7 * String(b).length) return { a: [], b: [] };
    return { a: ra, b: rb };
  }

  function spans(list, keep) {
    const out = [];
    let at = 0;
    for (let k = 0; k < list.length; k += 1) {
      const end = at + list[k].length;
      if (!keep[k] && list[k].trim()) {
        const last = out[out.length - 1];
        if (last && last[1] >= at - 1 && !list.slice(0, k).join('').slice(last[1], at).trim()) last[1] = end; else out.push([at, end]);
      }
      at = end;
    }
    return out;
  }

  // Highlighted pieces with the changed ranges marked: [[class, text, marked], …].
  function marked(segs, ranges) {
    if (!ranges || !ranges.length) return segs.map(([c, t]) => [c, t, false]);
    const out = [];
    let at = 0;
    for (const [cls, text] of segs) {
      const cuts = new Set([0, text.length]);
      for (const [x, y] of ranges) {
        if (x > at && x < at + text.length) cuts.add(x - at);
        if (y > at && y < at + text.length) cuts.add(y - at);
      }
      const points = [...cuts].sort((p, q) => p - q);
      for (let k = 1; k < points.length; k += 1) {
        const start = at + points[k - 1];
        const inside = ranges.some(([x, y]) => start >= x && start < y);
        out.push([cls, text.slice(points[k - 1], points[k]), inside]);
      }
      at += text.length;
    }
    return out;
  }

  // ── a hunk's rows ──

  // Its lines with their numbers, and each changed line paired with its counterpart (the
  // i-th removed line of a block with the i-th added one) for word marks and side by side.
  function rows(hunk) {
    const out = [];
    let o = hunk.old_start, n = hunk.new_start;
    const lines = hunk.lines || [];
    for (let k = 0; k < lines.length; k += 1) {
      const [tag, text] = lines[k];
      if (tag === '\\') { if (out.length) out[out.length - 1].noEol = true; continue; }
      if (tag === ' ') { out.push({ tag, text, o, n }); o += 1; n += 1; continue; }
      if (tag === '-') { out.push({ tag, text, o, n: null }); o += 1; continue; }
      if (tag === '+') { out.push({ tag, text, o: null, n }); n += 1; }
    }
    // Pair each run of removed lines with the added lines right after it.
    for (let k = 0; k < out.length;) {
      if (out[k].tag !== '-') { k += 1; continue; }
      let d = k;
      while (d < out.length && out[d].tag === '-') d += 1;
      let a = d;
      while (a < out.length && out[a].tag === '+') a += 1;
      const pairs = Math.min(d - k, a - d);
      for (let p = 0; p < pairs; p += 1) { out[k + p].pair = d + p; out[d + p].pair = k + p; }
      k = a;
    }
    return out;
  }

  // Side by side: [left row | null, right row | null] per line, removed beside added.
  function splitRows(list) {
    const out = [];
    for (let k = 0; k < list.length;) {
      const r = list[k];
      if (r.tag === ' ') { out.push([r, r]); k += 1; continue; }
      let d = k;
      const removed = [], added = [];
      while (d < list.length && list[d].tag === '-') { removed.push(list[d]); d += 1; }
      while (d < list.length && list[d].tag === '+') { added.push(list[d]); d += 1; }
      if (!removed.length && !added.length) { k += 1; continue; }
      for (let p = 0; p < Math.max(removed.length, added.length); p += 1) out.push([removed[p] || null, added[p] || null]);
      k = d;
    }
    return out;
  }

  // Unchanged lines between one hunk and the next (by new-file line numbers).
  function gap(prev, next) {
    if (!next) return 0;
    const before = prev ? prev.new_start + Math.max(prev.new_count, 0) : 1;
    return Math.max(0, next.new_start - before);
  }

  // ── drawing ──

  const CLASSES = { k: 'jcx-k', s: 'jcx-s', c: 'jcx-c', n: 'jcx-n', t: 'jcx-t' };

  function codeCell(doc, text, lang, state, ranges, cls) {
    const cell = doc.createElement('span');
    cell.className = `jcx-code${cls ? ` ${cls}` : ''}`;
    const lit = highlight(text, lang, state);
    for (const [c, piece, isMarked] of marked(lit.segs, ranges)) {
      if (!c && !isMarked) { cell.append(doc.createTextNode(piece)); continue; }
      const span = doc.createElement(isMarked ? 'mark' : 'span');
      span.className = [CLASSES[c] || '', isMarked ? 'jcx-w' : ''].filter(Boolean).join(' ');
      span.textContent = piece;
      cell.append(span);
    }
    if (!text) cell.append(doc.createTextNode(' '));
    return { cell, state: lit.state };
  }

  function lineNo(doc, value, side) {
    const b = doc.createElement('span');
    b.className = `jcx-ln ${side}`;
    b.textContent = value == null ? '' : String(value);
    if (value != null) { b.dataset.line = String(value); b.dataset.side = side; }
    return b;
  }

  // A hunk's lines as rows: unified (old no, new no, sign, code) or split (old | new).
  // opts: { mode, path, limit (rows drawn now), onMore() }. Returns the element and how many
  // rows are left undrawn.
  function buildHunk(doc, hunk, opts = {}) {
    const lang = langFor(opts.path);
    const list = rows(hunk);
    const box = doc.createElement('div');
    box.className = `jcx-lines ${opts.mode === 'split' ? 'split' : 'unified'}`;
    const words = new Map();
    for (let k = 0; k < list.length; k += 1) {
      const r = list[k];
      if (r.tag === '-' && r.pair != null) {
        const w = wordDiff(r.text, list[r.pair].text);
        words.set(k, w.a);
        words.set(r.pair, w.b);
      }
    }
    const index = new Map(list.map((r, k) => [r, k]));
    const limit = opts.limit || Infinity;
    let oldState = {}, newState = {};
    let drawn = 0;
    if (opts.mode === 'split') {
      const pairs = splitRows(list);
      for (const [left, right] of pairs) {
        if (drawn >= limit) break;
        const row = doc.createElement('div');
        row.className = `jcx-row ${left === right ? 'ctx' : 'chg'}`;  // (each side's cell says add or del)
        const l = left ? codeCell(doc, left.text, lang, oldState, words.get(index.get(left)), left.tag === '-' ? 'del' : '') : null;
        if (l) oldState = l.state;
        const r = right ? codeCell(doc, right.text, lang, newState, words.get(index.get(right)), right.tag === '+' ? 'add' : '') : null;
        if (r) newState = r.state;
        row.append(lineNo(doc, left ? left.o : null, 'o'), l ? l.cell : empty(doc), lineNo(doc, right ? right.n : null, 'n'), r ? r.cell : empty(doc));
        if (right) { row.dataset.side = 'n'; row.dataset.line = String(right.n); } else if (left) { row.dataset.side = 'o'; row.dataset.line = String(left.o); }
        box.append(row);
        drawn += 1;
      }
      return { el: box, left: Math.max(0, pairs.length - drawn) };
    }
    for (let k = 0; k < list.length && drawn < limit; k += 1) {
      const r = list[k];
      const row = doc.createElement('div');
      row.className = `jcx-row ${r.tag === '+' ? 'add' : r.tag === '-' ? 'del' : 'ctx'}`;
      let cell;
      if (r.tag === '-') ({ cell, state: oldState } = codeCell(doc, r.text, lang, oldState, words.get(k), ''));
      else {
        ({ cell, state: newState } = codeCell(doc, r.text, lang, newState, words.get(k), ''));
        if (r.tag === ' ') oldState = newState;
      }
      const sign = doc.createElement('span');
      sign.className = 'jcx-sg';
      sign.textContent = r.tag === ' ' ? ' ' : r.tag === '+' ? '+' : '−';
      row.append(lineNo(doc, r.o, 'o'), lineNo(doc, r.n, 'n'), sign, cell);
      row.dataset.side = r.tag === '-' ? 'o' : 'n';
      row.dataset.line = String(r.tag === '-' ? r.o : r.n);
      if (r.noEol) row.title = 'No newline at the end of the file';
      box.append(row);
      drawn += 1;
    }
    return { el: box, left: Math.max(0, list.length - drawn) };
  }

  function empty(doc) {
    const s = doc.createElement('span');
    s.className = 'jcx-code none';
    return s;
  }

  const api = { langFor, highlight, tokens, wordDiff, marked, rows, splitRows, gap, buildHunk };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.JarvisDiff = api;
})(typeof window === 'object' ? window : globalThis);
