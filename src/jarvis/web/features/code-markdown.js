// Jarvis Code's transcript in full Markdown (features/code_workspace.py serves its pictures):
// - Claude's words as Markdown: headings, paragraphs, lists (nested, numbered, to-dos),
//   tables, links, quotes, rules, and code blocks in colour (code_diff.js's highlighter)
//   with a Copy button. Drawn with DOM calls only: nothing Claude writes becomes markup,
//   links go only to web addresses (opened outside), pictures on the web are never loaded,
//   and a link to a project file opens it in the Files pane. It draws everything app.js's
//   richText drew: replies as they stream, plans, an agent's result, a Markdown preview.
// - The pictures that go with transcript entries: what the owner attached to a message and
//   what a step returned (a screenshot), read from Claude Code's own record when the entry
//   comes into view, shown small, larger on a click.
// The parser is pure and exported for node --test (tests/web/code-markdown.test.mjs).
(function (root) {
  'use strict';

  const MAX_DEPTH = 8;  // quotes and lists inside each other, at most
  const MAX_INLINE = 6;  // emphasis inside emphasis, at most
  const SPAN_MAX = 2000;  // characters an emphasis may run over
  const HIGHLIGHT_LINES = 1500;  // longer code blocks are shown plain

  // ── blocks ──

  const FENCE = /^( {0,3})(`{3,}|~{3,})(.*)$/;
  // A heading's opening #s (on a line with no other line break in it); its text and closing
  // #s are read by heading(), with loops: a regex for them backtracks over a long run of
  // spaces mid-line, quadratic in the line's length.
  const HEADING = /^ {0,3}(#{1,6})(?=[ \t]|$)(?!.*[\r\u2028\u2029])/;
  const RULE = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
  const QUOTE = /^ {0,3}>/;
  const ITEM = /^([ \t]*)([-*+]|\d{1,9}[.)])([ \t]+|$)(.*)$/;
  const DELIM_CELL = /^:?-+:?$/;

  function lead(line) {
    return line.match(/^[ \t]*/)[0].replace(/\t/g, '    ').length;
  }

  // A line without its first `n` columns of indentation (tabs count as four).
  function dedent(line, n) {
    let col = 0;
    let i = 0;
    while (i < line.length && col < n && (line[i] === ' ' || line[i] === '\t')) {
      col += line[i] === '\t' ? 4 : 1;
      i += 1;
    }
    return line.slice(i);
  }

  // `s` without its trailing spaces and tabs (/[ \t]+$/ backtracks quadratically when a long
  // run of them is followed by more text).
  function trimTabs(s) {
    let end = s.length;
    while (end > 0 && (s[end - 1] === ' ' || s[end - 1] === '\t')) end -= 1;
    return s.slice(0, end);
  }

  // A heading line's level and text (without the closing #s), or null.
  function heading(line) {
    const m = HEADING.exec(line);
    if (!m) return null;
    let text = trimTabs(line.slice(m[0].length)).replace(/^[ \t]+/, '');
    let end = text.length;
    while (end > 0 && text[end - 1] === '#') end -= 1;
    if (end < text.length && end > 0 && (text[end - 1] === ' ' || text[end - 1] === '\t')) text = trimTabs(text.slice(0, end));
    return { level: m[1].length, text: text.trim() };
  }

  // A table row's cells: split on | outside `code` (and not \|).
  function splitRow(line) {
    let s = line.trim();
    if (s.startsWith('|')) s = s.slice(1);
    if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1);
    const cells = [];
    let cell = '';
    let ticks = 0;
    for (let i = 0; i < s.length; i += 1) {
      const c = s[i];
      if (c === '\\' && s[i + 1] === '|') { cell += '|'; i += 1; continue; }
      if (c === '`') {
        let run = 1;
        while (s[i + run] === '`') run += 1;
        ticks = ticks === run ? 0 : ticks || run;
        cell += '`'.repeat(run);
        i += run - 1;
        continue;
      }
      if (c === '|' && !ticks) { cells.push(cell.trim()); cell = ''; continue; }
      cell += c;
    }
    cells.push(cell.trim());
    return cells;
  }

  function alignOf(cell) {
    const left = cell.startsWith(':');
    const right = cell.endsWith(':');
    return left && right ? 'center' : right ? 'right' : left ? 'left' : '';
  }

  function isDelimRow(line) {
    if (!/[-]/.test(line) || !/^[\s|:-]+$/.test(line)) return false;
    const cells = splitRow(line);
    return cells.length > 0 && cells.every((c) => DELIM_CELL.test(c));
  }

  // Would this line start a block of its own (so it doesn't carry on a paragraph)?
  function startsBlock(line) {
    return FENCE.test(line) || HEADING.test(line) || RULE.test(line) || QUOTE.test(line);
  }

  // A list item may break into a paragraph only when it's a bullet or starts at 1, and
  // isn't empty (as in CommonMark): "Steps:\n1. …" is a list, "in 2019. Then" isn't.
  function interrupts(m) {
    if (!m[4].trim()) return false;
    return !/\d/.test(m[2]) || parseInt(m[2], 10) === 1;
  }

  function parse(src, depth = 0) {
    const lines = String(src || '').replace(/\r\n?/g, '\n').split('\n');
    const blocks = [];
    let para = [];
    const flush = () => {
      if (para.length) blocks.push({ type: 'para', text: para.join('\n') });
      para = [];
    };
    let i = 0;
    while (i < lines.length) {
      const line = lines[i];
      if (!line.trim()) { flush(); i += 1; continue; }
      let m = FENCE.exec(line);
      if (m && !(m[2][0] === '`' && m[3].includes('`'))) {  // (a backtick fence's info has none)
        flush();
        const indent = m[1].length;
        const fence = m[2];
        const info = m[3].trim();
        const closer = new RegExp(`^ {0,3}${fence[0] === '`' ? '`' : '~'}{${fence.length},}[ \\t]*$`);
        const body = [];
        let closed = false;
        i += 1;
        while (i < lines.length) {
          if (closer.test(lines[i])) { closed = true; i += 1; break; }
          body.push(indent ? dedent(lines[i], indent) : lines[i]);
          i += 1;
        }
        blocks.push({ type: 'code', info, text: body.join('\n'), open: !closed });
        continue;
      }
      const titled = heading(line);
      if (titled) { flush(); blocks.push({ type: 'heading', ...titled }); i += 1; continue; }
      if (RULE.test(line)) { flush(); blocks.push({ type: 'rule' }); i += 1; continue; }
      if (QUOTE.test(line)) {
        flush();
        const inner = [];
        while (i < lines.length && QUOTE.test(lines[i])) {
          inner.push(lines[i].replace(/^ {0,3}> ?/, ''));
          i += 1;
        }
        const text = inner.join('\n');
        blocks.push({ type: 'quote', blocks: depth < MAX_DEPTH ? parse(text, depth + 1) : [{ type: 'para', text }] });
        continue;
      }
      if (line.includes('|') && i + 1 < lines.length && isDelimRow(lines[i + 1])) {
        const head = splitRow(line);
        const align = splitRow(lines[i + 1]).map(alignOf);
        if (head.length === align.length) {
          flush();
          const rows = [];
          i += 2;
          while (i < lines.length && lines[i].trim() && lines[i].includes('|') && !startsBlock(lines[i])) {
            const cells = splitRow(lines[i]);
            rows.push(head.map((_, k) => cells[k] || ''));
            i += 1;
          }
          blocks.push({ type: 'table', head, align, rows });
          continue;
        }
      }
      m = ITEM.exec(line);
      if (m && lead(line) <= 3 && (!para.length || interrupts(m))) {
        flush();
        const [list, next] = parseList(lines, i, depth);
        blocks.push(list);
        i = next;
        continue;
      }
      para.push(line);
      i += 1;
    }
    flush();
    return blocks;
  }

  function parseList(lines, start, depth) {
    const first = ITEM.exec(lines[start]);
    const ordered = /\d/.test(first[2]);
    const mark = ordered ? first[2].slice(-1) : first[2];
    const base = lead(lines[start]);
    const list = { type: 'list', ordered, start: ordered ? parseInt(first[2], 10) : 1, items: [] };
    let i = start;
    while (i < lines.length) {
      const m = ITEM.exec(lines[i]);
      if (!m || lead(lines[i]) !== base) break;
      if (/\d/.test(m[2]) !== ordered || (ordered ? m[2].slice(-1) : m[2]) !== mark) break;
      const spaces = m[3].replace(/\t/g, '    ').length;
      const column = base + m[2].length + (spaces >= 1 && spaces <= 4 ? spaces : 1);
      const own = [m[4]];
      i += 1;
      let blanks = 0;
      while (i < lines.length) {
        const l = lines[i];
        if (!l.trim()) { blanks += 1; own.push(''); i += 1; continue; }
        const at = lead(l);
        // Inside the item: indented to its text, or a list item a little further in (the
        // two spaces many write under "1. …" count as nested too).
        if (at >= column || (ITEM.test(l) && at >= base + 2)) {
          own.push(dedent(l, Math.min(at, column)));
          blanks = 0;
          i += 1;
          continue;
        }
        if (!blanks && !ITEM.test(l) && !startsBlock(l)) { own.push(l.trim()); i += 1; continue; }  // carries on its text
        break;
      }
      while (own.length > 1 && !own[own.length - 1].trim()) own.pop();
      let task = null;
      const done = /^\[([ xX])\][ \t]+/.exec(own[0]);
      if (done) { task = done[1] !== ' '; own[0] = own[0].slice(done[0].length); }
      const text = own.join('\n');
      list.items.push({ task, blocks: depth < MAX_DEPTH ? parse(text, depth + 1) : [{ type: 'para', text }] });
      if (blanks && i < lines.length) {
        const next = ITEM.exec(lines[i]);
        if (!next || lead(lines[i]) !== base) break;
      }
    }
    return [list, i];
  }

  // ── inline ──

  const PUNCT = '!"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~';

  // Where a link may go: web addresses only (opened outside); a path in the project
  // becomes a link that opens the file here. Anything else (javascript:, data:, file:) is
  // just text.
  function linkTarget(raw) {
    const href = String(raw || '').trim().replace(/^<(.*)>$/, '$1');
    if (/^https?:\/\/[^\s]+$/i.test(href)) return { href };
    if (!href || /^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith('//') || href.startsWith('#')) return null;
    const m = /^([^\s#?]+?)(?:(?::|#L)(\d+)(?:-L?\d+)?)?$/.exec(href);
    if (!m || m[1].split('/').includes('..') || m[1].startsWith('~')) return null;
    return { path: m[1].replace(/^\.\//, ''), line: m[2] ? parseInt(m[2], 10) : 0 };
  }

  // [label](target "title") at i: its label, its target and where it ends; null if it isn't one.
  function linkAt(text, i) {
    let depth = 0;
    let j = i;
    for (; j < text.length; j += 1) {
      const c = text[j];
      if (c === '\\') { j += 1; continue; }
      if (c === '[') depth += 1;
      else if (c === ']') { depth -= 1; if (!depth) break; }
      if (j - i > SPAN_MAX) return null;
    }
    if (j >= text.length || text[j + 1] !== '(') return null;
    let k = j + 2;
    let parens = 1;
    for (; k < text.length; k += 1) {
      const c = text[k];
      if (c === '\\') { k += 1; continue; }
      if (c === '(') parens += 1;
      else if (c === ')') { parens -= 1; if (!parens) break; }
      else if (c === '\n') return null;
      if (k - j > SPAN_MAX) return null;
    }
    if (k >= text.length) return null;
    const target = untitled(text.slice(j + 2, k).trim());
    return { label: text.slice(i + 1, j), target, end: k + 1 };
  }

  // A link's target without its "title" (or 'title'), found from the end: the regex for it,
  // /\s+(?:"[^"]*"|'[^']*')$/, backtracks over every space before a quote mid-target.
  function untitled(inside) {
    const q = inside[inside.length - 1];
    if (q !== '"' && q !== "'") return inside;
    const open = inside.lastIndexOf(q, inside.length - 2);
    if (open < 1 || !/\s/.test(inside[open - 1])) return inside;
    let end = open;
    while (end > 0 && /\s/.test(inside[end - 1])) end -= 1;
    return inside.slice(0, end);
  }

  const BARE_URL = /^https?:\/\/[^\s<>"'`]+/i;

  // A bare address without the punctuation after it, and without the ) that closes words
  // around it rather than its own (. Counted once, not per ) taken off: a long run of them
  // would make that quadratic, as /[.,;:!?*_~]+$/ is over a long run of dots mid-address.
  function trimUrl(url) {
    let end = url.length;
    while (end > 0 && '.,;:!?*_~'.includes(url[end - 1])) end -= 1;
    const out = url.slice(0, end);
    const opens = (out.match(/\(/g) || []).length;
    let closes = (out.match(/\)/g) || []).length;
    while (end > 0 && out[end - 1] === ')' && opens < closes) { end -= 1; closes -= 1; }
    return out.slice(0, end);
  }

  function inline(text, depth = 0) {
    const src = String(text || '');
    const out = [];
    let buf = '';
    const push = (tok) => {
      if (buf) { out.push({ t: 'text', v: buf }); buf = ''; }
      out.push(tok);
    };
    const unclosed = new Set();  // delimiters with no closer anywhere after: never looked for again
    let i = 0;
    while (i < src.length) {
      const c = src[i];
      if (c === '\\' && i + 1 < src.length) {
        const n = src[i + 1];
        if (n === '\n') { push({ t: 'br' }); i += 2; continue; }
        if (PUNCT.includes(n)) { buf += n; i += 2; continue; }
      }
      if (c === '`') {
        let run = 1;
        while (src[i + run] === '`') run += 1;
        const ticks = '`'.repeat(run);
        let close = src.indexOf(ticks, i + run);
        while (close >= 0 && src[close + run] === '`') {  // a longer run isn't this one's end
          let more = run;
          while (src[close + more] === '`') more += 1;
          close = src.indexOf(ticks, close + more);
        }
        if (close < 0) { buf += ticks; i += run; continue; }
        let code = src.slice(i + run, close).replace(/\n/g, ' ');
        // (one space each side comes off, unless it's all spaces: tested without a regex,
        // since /^ .*[^ ].* $/ backtracks quadratically over a long span)
        if (code.length > 2 && code[0] === ' ' && code[code.length - 1] === ' ' && /[^ ]/.test(code)) code = code.slice(1, -1);
        push({ t: 'code', v: code });
        i = close + run;
        continue;
      }
      if (c === '\n') {
        buf = trimTabs(buf);
        push({ t: 'br' });
        i += 1;
        while (src[i] === ' ' || src[i] === '\t') i += 1;
        continue;
      }
      if ((c === '!' && src[i + 1] === '[') || c === '[') {
        const at = c === '!' ? i + 1 : i;
        const link = linkAt(src, at);
        if (link) {
          const target = linkTarget(link.target);
          if (c === '!') {
            // A picture on the web is never fetched (it would say who's reading): its
            // description, as a link to it.
            const alt = `🖼 ${link.label || 'image'}`;
            push(target && target.href ? { t: 'link', href: target.href, c: [{ t: 'text', v: alt }] } : { t: 'text', v: alt });
          } else {
            const kids = depth < MAX_INLINE ? inline(link.label, depth + 1) : [{ t: 'text', v: link.label }];
            if (target && target.href) push({ t: 'link', href: target.href, c: kids });
            else if (target && target.path) push({ t: 'path', path: target.path, line: target.line, c: kids });
            else {  // somewhere it may not go: its words only
              if (buf) { out.push({ t: 'text', v: buf }); buf = ''; }
              out.push(...kids);
            }
          }
          i = link.end;
          continue;
        }
      }
      if (c === '<') {
        const m = /^<(https?:\/\/[^\s<>]+)>/i.exec(src.slice(i, i + SPAN_MAX));
        if (m) { push({ t: 'link', href: m[1], c: [{ t: 'text', v: m[1] }] }); i += m[0].length; continue; }
      }
      if ((c === 'h' || c === 'H') && (i === 0 || /[\s(\[{"'*_~]/.test(src[i - 1]))) {
        const m = BARE_URL.exec(src.slice(i, i + SPAN_MAX));
        if (m) {
          const url = trimUrl(m[0]);
          if (url.length > 'https://'.length) { push({ t: 'link', href: url, c: [{ t: 'text', v: url }] }); i += url.length; continue; }
        }
      }
      if ((c === '*' || c === '_' || c === '~') && depth < MAX_INLINE) {
        const span = emphasis(src, i, unclosed);
        if (span) {
          push({ t: span.kind, c: inline(src.slice(span.from, span.to), depth + 1) });
          i = span.end;
          continue;
        }
      }
      buf += c;
      i += 1;
    }
    if (buf) out.push({ t: 'text', v: buf });
    return out;
  }

  const WORD = /[\p{L}\p{N}]/u;

  // ***both***, **strong**, __strong__, *em*, _em_, ~~del~~ starting at i: its kind, where
  // its inside is and where it ends; null when it isn't one.
  function emphasis(src, i, unclosed) {
    const c = src[i];
    let n = 1;
    while (src[i + n] === c && n < 3) n += 1;
    if (c === '~' && n !== 2) return null;
    const d = c.repeat(n);
    const from = i + n;
    if (from >= src.length || /\s/.test(src[from]) || src[from] === c) return null;
    if (c === '_' && i > 0 && WORD.test(src[i - 1])) return null;  // snake_case isn't emphasis
    if (unclosed.has(d)) return null;
    let at = from;
    for (let tries = 0; tries < 20; tries += 1) {
      const close = src.indexOf(d, at + 1);
      if (close < 0) { unclosed.add(d); return null; }  // none after this one, nor after any later
      if (close - from > SPAN_MAX) return null;
      const after = src[close + n];
      if (!/\s/.test(src[close - 1]) && after !== c && !(c === '_' && after && WORD.test(after))) {
        const kind = c === '~' ? 'del' : n === 3 ? 'both' : n === 2 ? 'strong' : 'em';
        return { kind, from, to: close, end: close + n };
      }
      at = close;
    }
    return null;
  }

  // ── code blocks: which language, and the pieces of each line ──

  const FENCE_LANGS = {
    python: 'python', py: 'python', python3: 'python', pycon: 'python', javascript: 'js', js: 'js', jsx: 'js', mjs: 'js', cjs: 'js',
    typescript: 'js', ts: 'js', tsx: 'js', json: 'json', jsonc: 'js', json5: 'js', bash: 'shell', sh: 'shell', zsh: 'shell',
    shell: 'shell', console: 'shell', fish: 'shell', swift: 'swift', go: 'go', golang: 'go', rust: 'rust', rs: 'rust',
    java: 'java', kotlin: 'java', kt: 'java', scala: 'java', dart: 'java', csharp: 'java', cs: 'java', 'c#': 'java', groovy: 'java',
    c: 'c', h: 'c', cpp: 'c', 'c++': 'c', cc: 'c', objc: 'c', 'objective-c': 'c', ruby: 'ruby', rb: 'ruby', sql: 'sql',
    php: 'php', lua: 'lua', yaml: 'yaml', yml: 'yaml', toml: 'toml', css: 'css', scss: 'css', less: 'css', html: 'html',
    xml: 'html', svg: 'html', vue: 'html', markdown: 'markdown', md: 'markdown', diff: 'diff', patch: 'diff',
  };

  // The language of a fence's info string ("python", "ts title=x", "src/app.py"), as the
  // highlighter names it; langFor reads a file name's extension.
  function fenceLang(info, langFor) {
    const word = String(info || '').trim().split(/\s+/)[0].toLowerCase().replace(/^\{\.?|\}$/g, '');
    if (!word) return '';
    if (FENCE_LANGS[word]) return FENCE_LANGS[word];
    if (typeof langFor === 'function') return langFor(word.includes('.') ? word : `x.${word}`) || '';
    return '';
  }

  const api = { parse, inline, splitRow, linkTarget, fenceLang, trimUrl };
  if (typeof module === 'object' && module.exports) { module.exports = api; return; }

  const F = root.jarvisFeatures;
  if (!F) return;
  const { t } = F;
  root.JarvisMarkdown = api;

  // ── drawing ──

  const COLORS = { k: 'jcx-k', s: 'jcx-s', c: 'jcx-c', n: 'jcx-n', t: 'jcx-t' };

  function copyButton(getText) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'jc-mini jc-copy';
    b.textContent = t('Copy');
    b.addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(getText()); b.textContent = t('Copied'); } catch (_) { b.textContent = t('Couldn’t copy'); }
      setTimeout(() => { b.textContent = t('Copy'); }, 1400);
    });
    return b;
  }

  function codeBlock(block) {
    const pre = document.createElement('pre');
    pre.className = 'cw-pre';
    const code = document.createElement('code');
    const D = root.JarvisDiff;
    const lang = fenceLang(block.info, D && D.langFor);
    if (lang) pre.dataset.lang = lang;
    const lines = block.text.split('\n');
    if (lang === 'diff') {
      // Each line a row of its own, so an added or removed one is coloured across the width.
      for (const line of lines) {
        const cls = /^\+(?!\+\+)/.test(line) ? 'cw-add' : /^-(?!--)/.test(line) ? 'cw-del' : /^@@/.test(line) ? 'cw-hunk' : '';
        const row = document.createElement('span');
        row.className = `cw-line${cls ? ` ${cls}` : ''}`;
        row.textContent = line || ' ';
        code.append(row);
      }
    } else if (lang && D && D.highlight && lines.length <= HIGHLIGHT_LINES) {
      let state = {};
      lines.forEach((line, k) => {
        const lit = D.highlight(line, lang, state);
        state = lit.state;
        for (const [cls, piece] of lit.segs) {
          if (!cls) { code.append(document.createTextNode(piece)); continue; }
          const s = document.createElement('span');
          s.className = COLORS[cls] || '';
          s.textContent = piece;
          code.append(s);
        }
        if (k < lines.length - 1) code.append(document.createTextNode('\n'));
      });
    } else {
      code.textContent = block.text;
    }
    pre.append(code, copyButton(() => block.text));
    return pre;
  }

  function drawInline(tokens, into, ctx) {
    for (const tok of tokens) {
      if (tok.t === 'text') into.append(document.createTextNode(tok.v));
      else if (tok.t === 'br') into.append(document.createElement('br'));
      else if (tok.t === 'code') { const c = document.createElement('code'); c.textContent = tok.v; into.append(c); }
      else if (tok.t === 'strong' || tok.t === 'em' || tok.t === 'del' || tok.t === 'both') {
        const n = document.createElement(tok.t === 'both' ? 'strong' : tok.t);
        const inner = tok.t === 'both' ? n.appendChild(document.createElement('em')) : n;
        drawInline(tok.c, inner, ctx);
        into.append(n);
      } else if (tok.t === 'link') {
        const a = document.createElement('a');
        a.href = tok.href;
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
        a.title = tok.href;
        drawInline(tok.c, a, ctx);
        into.append(a);
      } else if (tok.t === 'path') {
        const a = document.createElement('a');
        a.href = '#';
        a.className = 'cw-md-path';
        a.title = tok.line ? `${tok.path}:${tok.line}` : tok.path;
        a.addEventListener('click', (e) => { e.preventDefault(); openPath(tok.path, tok.line); });
        drawInline(tok.c, a, ctx);
        into.append(a);
      }
    }
  }

  function drawBlocks(blocks, into, ctx) {
    for (const b of blocks) {
      if (b.type === 'para') {
        const p = document.createElement('p');
        drawInline(inline(b.text), p, ctx);
        into.append(p);
      } else if (b.type === 'heading') {
        const h = document.createElement(`h${b.level}`);
        drawInline(inline(b.text), h, ctx);
        into.append(h);
      } else if (b.type === 'code') {
        into.append(codeBlock(b));
      } else if (b.type === 'rule') {
        into.append(document.createElement('hr'));
      } else if (b.type === 'quote') {
        const q = document.createElement('blockquote');
        drawBlocks(b.blocks, q, ctx);
        into.append(q);
      } else if (b.type === 'list') {
        const list = document.createElement(b.ordered ? 'ol' : 'ul');
        if (b.ordered && b.start !== 1) list.start = b.start;
        for (const item of b.items) {
          const li = document.createElement('li');
          if (item.task !== null) {
            li.className = 'cw-task';
            const box = document.createElement('span');
            box.className = `cw-check${item.task ? ' done' : ''}`;
            box.setAttribute('aria-hidden', 'true');
            box.textContent = item.task ? '✓' : '';
            li.append(box);
          }
          if (item.blocks.length === 1 && item.blocks[0].type === 'para') drawInline(inline(item.blocks[0].text), li, ctx);
          else drawBlocks(item.blocks, li, ctx);
          list.append(li);
        }
        if (b.items.some((item) => item.task !== null)) list.classList.add('cw-tasks');
        into.append(list);
      } else if (b.type === 'table') {
        const wrap = document.createElement('div');
        wrap.className = 'cw-table';
        const table = document.createElement('table');
        const head = document.createElement('thead');
        const hr = document.createElement('tr');
        b.head.forEach((cell, k) => {
          const th = document.createElement('th');
          if (b.align[k]) th.style.textAlign = b.align[k];
          drawInline(inline(cell), th, ctx);
          hr.append(th);
        });
        head.append(hr);
        const body = document.createElement('tbody');
        for (const row of b.rows.slice(0, 1000)) {
          const tr = document.createElement('tr');
          row.forEach((cell, k) => {
            const td = document.createElement('td');
            if (b.align[k]) td.style.textAlign = b.align[k];
            drawInline(inline(cell), td, ctx);
            tr.append(td);
          });
          body.append(tr);
        }
        table.append(head, body);
        wrap.append(table);
        into.append(wrap);
      }
    }
  }

  function render(text) {
    const box = document.createElement('div');
    box.className = 'jc-md cw-md';
    box.setAttribute('data-no-i18n', '');
    drawBlocks(parse(text), box, {});
    return box;
  }

  // A project file named in a reply: shown in the Files pane (features/code-editor.js), at
  // its line when one was named.
  function openPath(path, line) {
    const task = F.currentTask();
    if (task && task.path && path.startsWith(`${task.path}/`)) path = path.slice(task.path.length + 1);
    if (root.JarvisEditor && root.JarvisEditor.open) root.JarvisEditor.open(path, line);
    else if (typeof fileView !== 'undefined') {
      fileView = { path };  // the core viewer (app.js), read-only
      F.openPane('files');
      F.send({ type: 'file_read', directory: typeof deckProject !== 'undefined' ? deckProject : '', path });
    }
  }

  if (F.registerRichText) F.registerRichText(render);

  // ── pictures: attachments and screenshots, from Claude Code's record ──

  const THUMB = 240;  // px: the longer side of a thumbnail
  const KEPT = 300;  // thumbnails kept in memory (the oldest go)
  const thumbs = new Map();  // entry key -> [thumbnail data URL | null (too big)]
  const waiting = new Map();  // entry key -> { task, rows: Set, tries, out, alone }
  let asking = 0;
  const RETRIES = [1500, 3000, 6000];  // the record can lag the live entry by a moment

  function keep(key, list) {
    thumbs.delete(key);
    thumbs.set(key, list);
    while (thumbs.size > KEPT) thumbs.delete(thumbs.keys().next().value);
  }

  function shrink(picture) {
    return new Promise((resolve) => {
      if (!picture || picture.too_big || !/^image\/[\w.+-]+$/.test(picture.media_type) || !/^[A-Za-z0-9+/]+={0,2}$/.test(picture.data || '')) { resolve(null); return; }
      const img = new Image();
      img.onload = () => {
        const scale = Math.min(1, THUMB / Math.max(img.naturalWidth, img.naturalHeight, 1));
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
        canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
        canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
        try { resolve(canvas.toDataURL('image/jpeg', 0.84)); } catch (_) { resolve(null); }
      };
      img.onerror = () => resolve(null);
      img.src = `data:${picture.media_type};base64,${picture.data}`;
    });
  }

  function taskId() { const task = F.currentTask(); return task ? task.id : null; }

  function fill(row, key) {
    const list = thumbs.get(key);
    if (!list) return;
    row.replaceChildren(...list.map((src, k) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'cw-thumb';
      if (!src) {
        b.classList.add('none');
        b.disabled = true;
        b.textContent = 'Too big to show';
        return b;
      }
      b.title = 'Show larger';
      const img = document.createElement('img');
      img.src = src;
      img.alt = '';
      b.append(img);
      b.addEventListener('click', () => showLarger(key, k, src));
      return b;
    }));
    row.classList.add('filled');
    const li = row.closest('li');
    const said = li && li.querySelector(':scope > .jc-pics');
    if (said && said.textContent.startsWith('🖼')) said.hidden = true;
  }

  function ask(key, row) {
    const task = taskId();
    if (!key || task === null) return;
    if (thumbs.has(key)) { fill(row, key); return; }
    const w = waiting.get(key) || { task, rows: new Set(), tries: 0 };
    w.rows.add(row);
    waiting.set(key, w);
    if (!asking) asking = setTimeout(askNow, 30);
  }

  function askNow() {
    asking = 0;
    const task = taskId();
    const ready = [...waiting.entries()].filter(([, w]) => w.task === task && !w.out);
    // (24 at most in one ask; an entry whose pictures didn't all fit in an answer beside others'
    // is asked for alone, with a whole answer's room)
    const alone = ready.find(([, w]) => w.alone);
    const keys = (alone ? [alone] : ready.slice(0, 24)).map(([k]) => k);
    if (!keys.length) return;
    keys.forEach((k) => { waiting.get(k).out = true; });
    F.send({ type: 'cw_media', id: task, keys });
  }

  const seen = 'IntersectionObserver' in root ? new IntersectionObserver((items) => {
    for (const item of items) {
      if (!item.isIntersecting) continue;
      seen.unobserve(item.target);
      const key = item.target.dataset.key;
      if (key) ask(key, item.target);
      else item.target.dataset.visible = '1';  // its key (the message's id) comes later
    }
  }, { rootMargin: '200px' }) : null;

  function placeholders(count) {
    const row = document.createElement('div');
    row.className = 'cw-thumbs';
    row.dataset.count = String(count);
    for (let k = 0; k < Math.min(count, 6); k += 1) {
      const s = document.createElement('span');
      s.className = 'cw-thumb loading';
      row.append(s);
    }
    return row;
  }

  function watch(row) {
    if (seen) seen.observe(row); else if (row.dataset.key) ask(row.dataset.key, row);
  }

  F.registerEntryDecorator((e, li) => {
    if (!(Number(e.images) > 0)) return;
    if (e.role === 'user') {
      const row = placeholders(Number(e.images));
      if (e.uuid) row.dataset.key = e.uuid;
      li.append(row);
      watch(row);
    } else if (e.role === 'tool' && e.tool_id) {
      const row = placeholders(Number(e.images));
      row.dataset.key = e.tool_id;
      row.classList.add('cw-tool-thumbs');
      li.append(row);
      watch(row);
    }
  });

  // A message's id arrives once Claude Code has taken it: its pictures can be asked for.
  F.on('task_entry_meta', (ev) => {
    if (ev.id !== taskId()) return;
    const li = [...document.querySelectorAll('#deck-timeline > .jc-user')].find((n) => String(n.dataset.n) === String(ev.n));
    const row = li && li.querySelector(':scope > .cw-thumbs');
    if (!row || row.dataset.key) return;
    row.dataset.key = ev.uuid;
    if (row.dataset.visible || !seen) ask(ev.uuid, row);
  });

  // A step that finished with pictures (a screenshot).
  F.on('task_log_update', (ev) => {
    if (ev.id !== taskId() || !(Number(ev.images) > 0)) return;
    const li = [...document.querySelectorAll('#deck-timeline [data-tool-id]')].find((n) => n.dataset.toolId === ev.tool_id);
    if (!li || li.querySelector(':scope > .cw-thumbs')) return;
    const row = placeholders(Number(ev.images));
    row.dataset.key = ev.tool_id;
    row.classList.add('cw-tool-thumbs');
    li.append(row);
    watch(row);
  });

  F.on('cw_media', async (ev) => {
    if (ev.ref) { onLarger(ev); return; }
    const items = ev.items || {};
    const shared = (ev.keys || []).length > 1;
    for (const key of ev.keys || []) {
      const w = waiting.get(key);
      if (!w) continue;
      w.out = false;
      if (items[key] && shared && items[key].some((p) => p && p.too_big)) {
        // An answer holds only so much, and what doesn't fit is marked too big, as a picture
        // too big on its own is (code_records): asked for again alone, what's too big then is.
        w.alone = true;
      } else if (items[key]) {
        waiting.delete(key);
        const list = await Promise.all(items[key].map(shrink));
        keep(key, list);
        for (const row of w.rows) if (row.isConnected) fill(row, key);
      } else if (w.tries < RETRIES.length) {
        w.out = true;  // (asked again in its time, not with the next ones)
        setTimeout(() => { w.out = false; if (waiting.get(key) === w && !asking) asking = setTimeout(askNow, 0); }, RETRIES[w.tries]);
        w.tries += 1;
      } else {
        waiting.delete(key);
        for (const row of w.rows) row.remove();  // not in the record: the count still says it
      }
    }
    // More were waiting than one ask takes: the next ones (rows already seen aren't watched
    // any more, so nothing else would ask for them).
    if (!asking && [...waiting.values()].some((w) => w.task === taskId() && !w.out)) asking = setTimeout(askNow, 0);
  });

  // Another session shown: what was waiting for this one isn't asked for.
  F.on('jc_select', () => { waiting.clear(); });

  // ── larger, on a click: the thumbnail at once, the whole picture when it comes ──

  let lightbox = null;
  function closeLarger() {
    if (!lightbox) return;
    lightbox.remove();
    lightbox = null;
  }

  function showLarger(key, index, thumb) {
    closeLarger();
    lightbox = document.createElement('div');
    lightbox.className = 'cw-lightbox';
    lightbox.setAttribute('role', 'dialog');
    lightbox.setAttribute('aria-modal', 'true');
    lightbox.setAttribute('aria-label', 'Picture');
    const ref = `big-${Date.now()}`;
    lightbox.dataset.ref = ref;
    lightbox.dataset.index = String(index);
    const img = document.createElement('img');
    img.src = thumb;
    img.alt = '';
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'jc-icon cw-lightbox-close';
    close.setAttribute('aria-label', 'Close');
    close.textContent = '✕';
    lightbox.append(img, close);
    lightbox.addEventListener('click', closeLarger);
    document.body.append(lightbox);
    close.focus();
    const task = taskId();
    if (task !== null) F.send({ type: 'cw_media', id: task, keys: [key], ref });
  }

  function onLarger(ev) {
    if (!lightbox || lightbox.dataset.ref !== ev.ref) return;
    const list = Object.values(ev.items || {})[0] || [];
    const picture = list[Number(lightbox.dataset.index) || 0];
    if (picture && picture.data && /^image\/[\w.+-]+$/.test(picture.media_type) && /^[A-Za-z0-9+/]+={0,2}$/.test(picture.data)) {
      lightbox.querySelector('img').src = `data:${picture.media_type};base64,${picture.data}`;
    }
  }

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && lightbox) { e.preventDefault(); e.stopPropagation(); closeLarger(); }
  }, true);
})(typeof window === 'object' ? window : globalThis);
