// Jarvis Code's Files pane, editable (features/code_workspace.py, code_editor.py):
// - the project's files, filtered as you type, the ones opened lately first;
// - a plain editor for each file opened (tabs): a text box with line numbers, find and
//   replace (text or a regular expression, match case), undo and redo (the box's own),
//   Tab to indent, a new line keeping the one above's indent, and ⌘S to save;
// - a save names the version of the file it was edited from: if it changed on disk since
//   (Claude edited it, another editor saved it), nothing is written and the pane says so,
//   with the differences, to overwrite or take what's on disk;
// - a file Claude changes while it's open comes back by itself when there's nothing unsaved
//   in it, and says so when there is;
// - "Open in" the editors on this Mac (VS Code, Cursor, Xcode, Zed), at the line, or the
//   whole project; the file's own app; Finder;
// - unsaved changes are kept in the window's storage as they're typed, and come back when
//   the file is opened again (after a reload, or a crash), still checked against the
//   version they were edited from.
// Markdown, HTML, CSV and JSON still preview as what they are (app.js's previewOf). A file
// asked for elsewhere (/memory, "open hub.py" by voice, a link in a reply) opens here, at
// its line. window.JarvisEditor: open(path, line), and registerView for other views of the
// project beside the file list.
// Pure helpers are exported for node --test (tests/web/code-editor.test.mjs).
(function (root) {
  'use strict';

  const MATCHES_MAX = 10000;  // matches find counts, at most
  const LIST_MAX = 200;  // files the list shows
  const OPEN_MAX = 8;  // files open at once (the oldest unchanged one makes room)
  const DRAFTS_KEY = 'jarvis.editor.drafts';  // unsaved changes, kept in the window's storage
  const DRAFTS_MAX = 12;  // files with unsaved changes kept, the newest
  const DRAFT_CHARS = 2000000;  // a bigger file's unsaved changes aren't kept
  const PREVIEWS = { md: 'markdown', markdown: 'markdown', html: 'html', htm: 'html', csv: 'csv', tsv: 'csv', json: 'json' };

  // ── pure helpers ──

  // Line and column (1-based) of a position in the text.
  function lineCol(text, pos) {
    let line = 1;
    let start = 0;
    for (let i = text.indexOf('\n'); i >= 0 && i < pos; i = text.indexOf('\n', i + 1)) {
      line += 1;
      start = i + 1;
    }
    return { line, col: pos - start + 1 };
  }

  // Where lines `from` to `to` (1-based, inclusive) are in the text: [start, end).
  function lineSpan(text, from, to = from) {
    let start = 0;
    let line = 1;
    while (line < from) {
      const next = text.indexOf('\n', start);
      if (next < 0) return [text.length, text.length];
      start = next + 1;
      line += 1;
    }
    let end = start;
    while (line <= to) {
      const next = text.indexOf('\n', end);
      if (next < 0) { end = text.length; break; }
      end = line === to ? next : next + 1;
      line += 1;
    }
    return [start, end];
  }

  function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

  // Every match of a query in the text: [[start, end], …] (at most MATCHES_MAX), or an
  // error for a regular expression that isn't one.
  function findAll(text, query, opts = {}) {
    if (!query) return { ranges: [], error: '' };
    let re;
    try {
      const source = opts.regex ? query : escapeRe(query);
      re = new RegExp(opts.word ? `\\b(?:${source})\\b` : source, `g${opts.caseSensitive ? '' : 'i'}m`);
    } catch (err) {
      return { ranges: [], error: String(err.message || err) };
    }
    const ranges = [];
    let m;
    while ((m = re.exec(text)) !== null && ranges.length < MATCHES_MAX) {
      if (m[0] === '') { re.lastIndex += 1; continue; }  // an empty match finds nothing
      ranges.push([m.index, m.index + m[0].length]);
    }
    return { ranges, error: '' };
  }

  // What replaces one match: the text as typed, or with $1, $& from a regular expression.
  function replacement(matched, query, replace, opts = {}) {
    if (!opts.regex) return replace;
    try {
      return matched.replace(new RegExp(opts.word ? `\\b(?:${query})\\b` : query, opts.caseSensitive ? '' : 'i'), replace);
    } catch (_) {
      return replace;
    }
  }

  // The files to list for a filter: the name matching first, then the path; shorter first.
  // With no filter, the ones opened lately come first.
  function rankFiles(files, query, recent = []) {
    const q = String(query || '').trim().toLowerCase();
    if (!q) {
      const lately = recent.filter((f) => files.includes(f));
      const seen = new Set(lately);
      return [...lately, ...files.filter((f) => !seen.has(f))].slice(0, LIST_MAX);
    }
    const scored = [];
    for (const f of files) {
      const lower = f.toLowerCase();
      const at = lower.indexOf(q);
      if (at < 0) continue;
      const name = lower.slice(lower.lastIndexOf('/') + 1);
      const score = (name.startsWith(q) ? 0 : name.includes(q) ? 1 : 2) * 10000 + f.length;
      scored.push([score, f]);
      if (scored.length > 20000) break;
    }
    return scored.sort((a, b) => a[0] - b[0] || (a[1] < b[1] ? -1 : 1)).slice(0, LIST_MAX).map(([, f]) => f);
  }

  // How the file indents: a tab, or the smallest run of spaces its lines start with.
  function indentUnit(text) {
    let tabs = 0;
    const widths = new Map();
    for (const line of text.split('\n', 2000)) {
      if (line.startsWith('\t')) tabs += 1;
      const m = /^( +)\S/.exec(line);
      if (m && m[1].length <= 8) widths.set(m[1].length, (widths.get(m[1].length) || 0) + 1);
    }
    const spaced = [...widths.values()].reduce((a, b) => a + b, 0);
    if (tabs > spaced) return '\t';
    for (const w of [2, 4, 3, 8]) if ((widths.get(w) || 0) > 0 && (w !== 8 || !widths.get(4))) return ' '.repeat(w);
    return '    ';
  }

  function previewKind(path) { return PREVIEWS[(String(path).split('.').pop() || '').toLowerCase()] || ''; }

  // Lines outdented by one unit: [new text, how much each line lost].
  function outdent(lines, unit) {
    const cut = [];
    const out = lines.map((line) => {
      let n = 0;
      if (unit === '\t' && line.startsWith('\t')) n = 1;
      else { while (n < unit.length && line[n] === ' ') n += 1; if (!n && line.startsWith('\t')) n = 1; }
      cut.push(n);
      return line.slice(n);
    });
    return [out, cut];
  }

  const api = { lineCol, lineSpan, findAll, replacement, rankFiles, indentUnit, previewKind, outdent };
  if (typeof module === 'object' && module.exports) { module.exports = api; return; }

  const F = root.jarvisFeatures;
  if (!F) return;
  const { el } = F;
  const mine = (node) => { node.setAttribute('data-no-i18n', ''); return node; };

  // ── state ──

  const docs = new Map();  // key -> doc
  const scopes = new Map();  // scope -> { open: [paths], active: path, view: 'list'|'editor'|<registered> }
  const recentFiles = new Map();  // scope -> [paths opened lately]
  const views = new Map();  // registered views: id -> { label, render(host, ctx) }
  let editors = null;  // the editors on this Mac, once asked
  let rootEl = null;
  let seenFileView = null;
  const pendingLines = new Map();  // path -> { start, end } asked by voice, till it opens
  const restoredScopes = new Set();  // scopes whose files with unsaved changes were reopened

  // ── unsaved changes, kept as they're typed ──

  function readDrafts() {
    try {
      const d = JSON.parse(localStorage.getItem(DRAFTS_KEY) || '{}');
      return d && typeof d === 'object' && !Array.isArray(d) ? d : {};
    } catch (_) { return {}; }
  }
  function writeDrafts(d) {
    try { localStorage.setItem(DRAFTS_KEY, JSON.stringify(d)); } catch (_) { /* storage full or off: they just aren't kept */ }
  }
  function draftOf(key) {
    const d = readDrafts()[key];
    return d && typeof d.text === 'string' ? d : null;
  }
  function stashDraft(doc) {
    const d = readDrafts();
    const text = doc.ui ? doc.ui.ta.value : '';
    if (doc.dirty && doc.editable && text.length <= DRAFT_CHARS) {
      d[doc.key] = { text, base: doc.version, crlf: doc.crlf, create: !!doc.create, at: Date.now() };
    } else delete d[doc.key];
    for (const k of Object.keys(d).sort((a, b) => (d[b].at || 0) - (d[a].at || 0)).slice(DRAFTS_MAX)) delete d[k];
    writeDrafts(d);
  }
  function dropDraft(key) {
    const d = readDrafts();
    if (key in d) { delete d[key]; writeDrafts(d); }
  }
  function stashSoon(doc) {
    clearTimeout(doc.stashTimer);
    doc.stashTimer = setTimeout(() => stashDraft(doc), 500);
  }
  // The files of this scope that had unsaved changes: open again, once a page load.
  function reopenDrafts(scope) {
    if (restoredScopes.has(scope)) return;
    restoredScopes.add(scope);
    const prefix = `${scope}\n`;
    for (const key of Object.keys(readDrafts())) {
      if (key.startsWith(prefix) && !docs.has(key)) openDoc(key.slice(prefix.length), { background: true });
    }
  }

  function project() { return typeof deckProject !== 'undefined' ? deckProject : ''; }
  function scopeOf(task) { return task ? `task:${task.path || task.id}` : `project:${project()}`; }
  function where(task) { return task ? { id: task.id, directory: project() } : { directory: project() }; }
  function keyOf(scope, path) { return `${scope}\n${path}`; }
  function scopeState(scope) {
    if (!scopes.has(scope)) scopes.set(scope, { open: [], active: '', view: 'list', filter: '' });
    return scopes.get(scope);
  }
  function current() {
    const task = F.currentTask();
    const scope = scopeOf(task);
    return { task, scope, state: scopeState(scope) };
  }
  function paneShown() {
    return typeof currentPane !== 'undefined' && currentPane === 'files' && !F.$('jc-pane').hidden;
  }
  function button(label, cls, run, title) {
    const b = el('button', cls || 'jc-btn small', label);
    b.type = 'button';
    if (title) b.title = title;
    b.addEventListener('click', run);
    return b;
  }

  // ── opening and closing files ──

  function openDoc(path, opts = {}) {
    const { task, scope, state } = current();
    path = String(path || '').replace(/^\.\//, '');
    if (!path) return;
    const key = keyOf(scope, path);
    let doc = docs.get(key);
    if (!doc) {
      doc = { key, scope, path, where: where(task), loading: true, dirty: false, text: '', version: null, crlf: false, editable: false, error: '', banner: null };
      docs.set(key, doc);
      state.open.push(path);
      // Too many open: the oldest with nothing unsaved goes.
      while (state.open.length > OPEN_MAX) {
        const old = state.open.find((p) => p !== path && !(docs.get(keyOf(scope, p)) || {}).dirty);
        if (!old) break;
        closeDoc(scope, old, true);
      }
      F.send({ type: 'cw_file_read', ...doc.where, path, ref: key });
    }
    if (opts.line) doc.mark = { start: opts.line, end: opts.end || opts.line };
    if (opts.allowCreate) doc.allowCreate = true;
    if (opts.background) return;  // (reopened for its unsaved changes: a tab, not shown)
    state.active = path;
    state.view = 'editor';
    const lately = (recentFiles.get(scope) || []).filter((p) => p !== path);
    recentFiles.set(scope, [path, ...lately].slice(0, 12));
    if (!paneShown()) F.openPane('files'); else draw();
    if (!doc.loading) applyMark(doc);
  }

  function closeDoc(scope, path, quiet) {
    const state = scopeState(scope);
    const key = keyOf(scope, path);
    const doc = docs.get(key);
    if (doc) clearTimeout(doc.stashTimer);
    dropDraft(key);  // (closed unsaved on purpose: the second click)
    docs.delete(key);
    state.open = state.open.filter((p) => p !== path);
    if (state.active === path) {
      state.active = state.open[state.open.length - 1] || '';
      if (!state.active && state.view === 'editor') state.view = 'list';
    }
    if (!quiet) draw();
  }

  // ── the editor for one file ──

  function makeEditor(doc) {
    const wrap = el('div', 'ce-edit');
    const gutter = mine(el('pre', 'ce-gutter'));
    gutter.setAttribute('aria-hidden', 'true');
    const box = el('div', 'ce-textwrap');
    const ta = el('textarea', 'ce-text');
    mine(ta);
    ta.spellcheck = false;
    ta.setAttribute('autocapitalize', 'off');
    ta.setAttribute('autocomplete', 'off');
    ta.setAttribute('autocorrect', 'off');
    ta.wrap = 'off';
    ta.setAttribute('aria-label', `Contents of ${doc.path}`);
    const markBar = el('div', 'ce-mark');
    markBar.hidden = true;
    box.append(markBar, ta);
    wrap.append(gutter, box);
    doc.ui = { wrap, gutter, ta, markBar, lines: 0 };
    ta.addEventListener('input', () => { onEdit(doc); });
    ta.addEventListener('scroll', () => { gutter.scrollTop = ta.scrollTop; placeMark(doc); });
    ta.addEventListener('keydown', (e) => onKey(doc, e));
    for (const ev of ['keyup', 'click', 'select', 'focus']) ta.addEventListener(ev, () => showCaret(doc));
    return wrap;
  }

  function fillEditor(doc, text) {
    const { ta } = doc.ui;
    ta.value = text;
    ta.setSelectionRange(0, 0);  // (a file opens at its top; a reload puts the caret back after)
    ta.scrollTop = 0;
    ta.readOnly = !doc.editable;
    doc.unit = indentUnit(text);
    ta.style.tabSize = doc.unit === '\t' ? '4' : String(doc.unit.length);
    numberLines(doc);
  }

  function numberLines(doc) {
    const { ta, gutter } = doc.ui;
    let lines = 1;
    for (let i = ta.value.indexOf('\n'); i >= 0; i = ta.value.indexOf('\n', i + 1)) lines += 1;
    if (lines === doc.ui.lines) return;
    doc.ui.lines = lines;
    const out = new Array(lines);
    for (let i = 0; i < lines; i += 1) out[i] = String(i + 1);
    gutter.textContent = `${out.join('\n')}\n`;
    gutter.style.width = `${Math.max(3, String(lines).length) + 1.6}ch`;
  }

  function onEdit(doc) {
    numberLines(doc);
    const dirty = doc.ui.ta.value !== doc.text;
    if (dirty !== doc.dirty) { doc.dirty = dirty; drawTabs(); drawDocBar(doc); }
    stashSoon(doc);
    showCaret(doc);
    if (doc.find && doc.find.open) refind(doc, false);
    if (doc.mark) { doc.mark = null; placeMark(doc); }
  }

  function lineHeight(doc) {
    const h = parseFloat(getComputedStyle(doc.ui.ta).lineHeight);
    return Number.isFinite(h) && h > 0 ? h : 18;
  }

  // Scroll so a line shows about a third of the way down.
  function scrollToLine(doc, line) {
    const { ta } = doc.ui;
    ta.scrollTop = Math.max(0, (line - 1) * lineHeight(doc) - ta.clientHeight / 3);
  }

  // Lines asked for (a search result, "read lines 10 to 20 of hub.py", a link): selected,
  // marked in the margin, and in view.
  function applyMark(doc) {
    if (!doc.ui || !doc.mark) return;
    const { ta } = doc.ui;
    const [s, e] = lineSpan(ta.value, doc.mark.start, doc.mark.end);
    requestAnimationFrame(() => {
      ta.focus({ preventScroll: true });
      ta.setSelectionRange(s, e);
      scrollToLine(doc, doc.mark ? doc.mark.start : 1);
      placeMark(doc);
      showCaret(doc);
    });
  }

  function placeMark(doc) {
    if (!doc.ui) return;
    const bar = doc.ui.markBar;
    if (!doc.mark) { bar.hidden = true; return; }
    const lh = lineHeight(doc);
    const pad = parseFloat(getComputedStyle(doc.ui.ta).paddingTop) || 0;
    bar.hidden = false;
    bar.style.top = `${pad + (doc.mark.start - 1) * lh - doc.ui.ta.scrollTop}px`;
    bar.style.height = `${(doc.mark.end - doc.mark.start + 1) * lh}px`;
  }

  function showCaret(doc) {
    if (!doc.ui || !doc.ui.status) return;
    const { ta } = doc.ui;
    const { line, col } = lineCol(ta.value, ta.selectionStart);
    const picked = ta.selectionEnd - ta.selectionStart;
    doc.ui.caret.textContent = `Ln ${line}, Col ${col}${picked ? ` (${picked} selected)` : ''}`;
  }

  // Typing as the owner would, so ⌘Z undoes it: the box's own undo keeps every step.
  function insert(ta, text) {
    if (!document.execCommand('insertText', false, text)) {
      const { selectionStart: s, selectionEnd: e, value } = ta;
      ta.value = value.slice(0, s) + text + value.slice(e);
      ta.selectionStart = ta.selectionEnd = s + text.length;
      ta.dispatchEvent(new Event('input'));
    }
  }

  function onKey(doc, e) {
    const { ta } = doc.ui;
    const cmd = e.metaKey || e.ctrlKey;
    const key = e.key.toLowerCase();
    const stop = () => { e.preventDefault(); e.stopPropagation(); };
    if (cmd && key === 's') { stop(); save(doc, false); return; }
    if (cmd && key === 'f') { stop(); openFind(doc); return; }
    if (cmd && key === 'g') { stop(); step(doc, e.shiftKey ? -1 : 1); return; }
    if (e.key === 'Escape') {
      e.stopPropagation();  // never the session's interrupt or the pane closing from here
      if (doc.find && doc.find.open) { e.preventDefault(); closeFind(doc); } else ta.blur();
      return;
    }
    if (ta.readOnly || e.isComposing) return;
    if (e.key === 'Tab' && !cmd && !e.altKey) {
      stop();
      indent(doc, e.shiftKey);
      return;
    }
    if (e.key === 'Enter' && !cmd && !e.altKey && !e.shiftKey) {
      const before = ta.value.slice(0, ta.selectionStart);
      const lineStart = before.lastIndexOf('\n') + 1;
      const lead = /^[ \t]*/.exec(before.slice(lineStart))[0];
      if (lead) { stop(); insert(ta, `\n${lead}`); }
    }
  }

  function indent(doc, out) {
    const { ta } = doc.ui;
    const unit = doc.unit || '    ';
    const { selectionStart: s, selectionEnd: e, value } = ta;
    const oneLine = !value.slice(s, e).includes('\n');
    if (!out && oneLine) { insert(ta, unit); return; }
    const start = value.lastIndexOf('\n', s - 1) + 1;
    const endAt = value.indexOf('\n', e - (e > s && value[e - 1] === '\n' ? 1 : 0));
    const end = endAt < 0 ? value.length : endAt;
    const lines = value.slice(start, end).split('\n');
    let changed;
    let firstShift;
    if (out) {
      const [cut, lost] = outdent(lines, unit);
      changed = cut;
      firstShift = -lost[0];
    } else {
      changed = lines.map((l) => (l ? unit + l : l));
      firstShift = lines[0] ? unit.length : 0;
    }
    const text = changed.join('\n');
    ta.setSelectionRange(start, end);
    insert(ta, text);
    ta.setSelectionRange(Math.max(start, s + firstShift), start + text.length);
  }

  // ── find and replace ──

  function makeFind(doc) {
    const bar = el('div', 'ce-find');
    bar.hidden = true;
    const row = el('div', 'ce-find-row');
    const input = el('input', 'jc-field ce-find-input');
    input.type = 'search';
    input.placeholder = 'Find';
    input.setAttribute('aria-label', 'Find in this file');
    const toggle = (label, title, prop) => {
      const b = button(label, 'ce-opt', () => { doc.find[prop] = !doc.find[prop]; b.setAttribute('aria-pressed', String(doc.find[prop])); refind(doc, true); }, title);
      b.setAttribute('aria-pressed', 'false');
      mine(b);
      return b;
    };
    const count = el('span', 'ce-count');
    count.setAttribute('aria-live', 'polite');
    const prev = button('↑', 'jc-icon ce-step', () => step(doc, -1), 'Previous match (⇧⌘G)');
    const next = button('↓', 'jc-icon ce-step', () => step(doc, 1), 'Next match (⌘G)');
    const more = button('⇄', 'jc-icon ce-step', () => { rrow.hidden = !rrow.hidden; if (!rrow.hidden) rinput.focus(); }, 'Replace');
    const close = button('✕', 'jc-icon ce-step', () => closeFind(doc), 'Close (Esc)');
    row.append(input, toggle('Aa', 'Match case', 'caseSensitive'), toggle('.*', 'Regular expression', 'regex'), count, prev, next, more, close);
    const rrow = el('div', 'ce-find-row');
    rrow.hidden = true;
    const rinput = el('input', 'jc-field ce-find-input');
    rinput.placeholder = 'Replace with';
    rinput.setAttribute('aria-label', 'Replace with');
    rrow.append(rinput, button('Replace', 'jc-mini', () => replaceOne(doc)), button('All', 'jc-mini', () => replaceAll(doc), 'Replace all'));
    bar.append(row, rrow);
    doc.find = { open: false, caseSensitive: false, regex: false, ranges: [], at: -1, input, rinput, count, bar };
    input.addEventListener('input', () => refind(doc, true));
    const keys = (e) => {
      if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); if (e.target === rinput) replaceOne(doc); else step(doc, e.shiftKey ? -1 : 1); }
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeFind(doc); }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'g') { e.preventDefault(); e.stopPropagation(); step(doc, e.shiftKey ? -1 : 1); }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'f') { e.preventDefault(); e.stopPropagation(); input.select(); }
    };
    input.addEventListener('keydown', keys);
    rinput.addEventListener('keydown', keys);
    return bar;
  }

  function openFind(doc) {
    if (!doc.find) return;
    doc.find.open = true;
    doc.find.bar.hidden = false;
    const { ta } = doc.ui;
    const picked = ta.value.slice(ta.selectionStart, ta.selectionEnd);
    if (picked && !picked.includes('\n') && picked.length < 200) doc.find.input.value = picked;
    doc.find.input.focus();
    doc.find.input.select();
    refind(doc, true);
  }

  function closeFind(doc) {
    doc.find.open = false;
    doc.find.bar.hidden = true;
    doc.ui.ta.focus();
  }

  function refind(doc, jump) {
    const f = doc.find;
    const { ta } = doc.ui;
    const found = findAll(ta.value, f.input.value, f);
    f.ranges = found.ranges;
    f.error = found.error;
    if (jump && f.ranges.length) {
      const from = ta.selectionStart;
      f.at = Math.max(0, f.ranges.findIndex(([s]) => s >= from));
      if (f.ranges[f.at][0] < from) f.at = 0;
      select(doc, false);
    } else if (!f.ranges.length) f.at = -1;
    else f.at = Math.min(Math.max(f.at, 0), f.ranges.length - 1);
    countLine(doc);
  }

  function countLine(doc) {
    const f = doc.find;
    f.count.classList.toggle('bad', !!f.error);
    if (f.error) f.count.textContent = 'Not a valid expression';
    else if (!f.input.value) f.count.textContent = '';
    else if (!f.ranges.length) f.count.textContent = 'No matches';
    else f.count.textContent = `${f.at + 1} of ${f.ranges.length}${f.ranges.length >= MATCHES_MAX ? '+' : ''}`;
  }

  function select(doc, focus) {
    const f = doc.find;
    const r = f.ranges[f.at];
    if (!r) return;
    const { ta } = doc.ui;
    if (focus) ta.focus({ preventScroll: true });
    ta.setSelectionRange(r[0], r[1]);
    scrollToLine(doc, lineCol(ta.value, r[0]).line);
    showCaret(doc);
  }

  function step(doc, by) {
    if (!doc.find) return;
    if (!doc.find.open) { openFind(doc); return; }
    const f = doc.find;
    if (!f.ranges.length) return;
    f.at = (f.at + by + f.ranges.length) % f.ranges.length;
    select(doc, false);
    countLine(doc);
  }

  function replaceOne(doc) {
    const f = doc.find;
    const { ta } = doc.ui;
    if (ta.readOnly || !f.ranges.length) return;
    const r = f.ranges[f.at];
    if (!r) return;
    ta.focus({ preventScroll: true });
    ta.setSelectionRange(r[0], r[1]);
    insert(ta, replacement(ta.value.slice(r[0], r[1]), f.input.value, f.rinput.value, f));
    const after = ta.selectionEnd;
    refind(doc, false);
    f.at = Math.max(0, f.ranges.findIndex(([s]) => s >= after));
    if (f.ranges.length) select(doc, false);
    countLine(doc);
  }

  function replaceAll(doc) {
    const f = doc.find;
    const { ta } = doc.ui;
    if (ta.readOnly || !f.ranges.length) return;
    let out = '';
    let at = 0;
    for (const [s, e] of f.ranges) {
      out += ta.value.slice(at, s) + replacement(ta.value.slice(s, e), f.input.value, f.rinput.value, f);
      at = e;
    }
    out += ta.value.slice(at);
    const top = ta.scrollTop;
    ta.focus({ preventScroll: true });
    ta.setSelectionRange(0, ta.value.length);
    insert(ta, out);  // one step to undo
    ta.setSelectionRange(0, 0);
    ta.scrollTop = top;
    refind(doc, false);
  }

  // ── saving, and what's on disk ──

  function save(doc, force) {
    if (!doc.ui || !doc.editable || doc.saving) return;
    doc.saving = true;
    drawDocBar(doc);
    F.send({ type: 'cw_file_save', ...doc.where, path: doc.path, text: doc.ui.ta.value, base: doc.version, crlf: doc.crlf, force: !!force, ref: doc.key, create: !!doc.create });
  }

  function reload(doc) {
    doc.banner = null;
    doc.reloading = true;
    clearTimeout(doc.stashTimer);
    dropDraft(doc.key);  // (what's on disk now, in place of the unsaved changes)
    F.send({ type: 'cw_file_read', ...doc.where, path: doc.path, ref: doc.key });
    drawBanner(doc);
  }

  function compare(doc) {
    F.send({ type: 'cw_file_compare', ...doc.where, path: doc.path, text: doc.ui.ta.value, ref: doc.key });
    doc.banner = { ...(doc.banner || {}), comparing: true };
    drawBanner(doc);
  }

  // Did files open here change on disk (Claude edited them)? Asked after a step ends.
  let checkTimer = 0;
  function checkSoon() {
    clearTimeout(checkTimer);
    checkTimer = setTimeout(() => {
      const { scope, state } = current();
      for (const path of state.open) {
        const doc = docs.get(keyOf(scope, path));
        if (doc && doc.version && !doc.saving && !doc.loading) F.send({ type: 'cw_file_stat', ...doc.where, path, base: doc.version, ref: doc.key });
      }
    }, 400);
  }

  // ── drawing ──

  function drawTabs() {
    if (!rootEl) return;
    const { scope, state } = current();
    const tabs = rootEl.querySelector('.ce-tabs');
    tabs.hidden = !state.open.length;
    tabs.replaceChildren(...state.open.map((path) => {
      const doc = docs.get(keyOf(scope, path));
      const tab = el('div', `ce-tab${path === state.active && state.view === 'editor' ? ' on' : ''}${doc && doc.dirty ? ' dirty' : ''}`);
      tab.setAttribute('role', 'tab');
      tab.setAttribute('aria-selected', String(path === state.active && state.view === 'editor'));
      const name = mine(button(path.split('/').pop(), 'ce-tab-name', () => { state.active = path; state.view = 'editor'; draw(); }));
      name.title = path;
      let armed = 0;
      const x = button('×', 'ce-tab-x', () => {
        if (doc && doc.dirty && !armed) {
          x.classList.add('armed');
          x.textContent = '?';
          x.title = 'Unsaved changes: click again to close without saving';
          armed = setTimeout(() => { armed = 0; x.classList.remove('armed'); x.textContent = '×'; x.title = 'Close'; }, 3000);
          return;
        }
        clearTimeout(armed);
        closeDoc(scope, path);
      }, 'Close');
      x.setAttribute('aria-label', `Close ${path.split('/').pop()}`);
      tab.append(name, x);
      return tab;
    }));
  }

  function drawSegments() {
    const { state } = current();
    const seg = rootEl.querySelector('.ce-seg');
    const items = [['list', 'Files'], ...[...views.entries()].map(([id, v]) => [id, v.label])];
    seg.hidden = items.length < 2;
    seg.replaceChildren(...items.map(([id, label]) => {
      const on = id === 'list' ? state.view === 'list' : state.view === id;
      const b = button(label, `jcx-seg-btn${on ? ' on' : ''}`, () => { state.view = id; draw(); if (id !== 'list' && views.get(id).focus) views.get(id).focus(); });
      b.setAttribute('aria-pressed', String(on));
      return b;
    }));
  }

  function drawList(host) {
    const { scope, state } = current();
    let filter = host.querySelector('.ce-filter');
    let list = host.querySelector('.ce-files');
    if (!filter) {
      filter = el('input', 'jc-field ce-filter');
      filter.type = 'search';
      filter.placeholder = 'Filter files…';
      filter.setAttribute('aria-label', 'Filter files');
      filter.addEventListener('input', () => { current().state.filter = filter.value; drawList(host); });
      filter.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { const first = list.querySelector('button'); if (first) first.click(); }
        if (e.key === 'Escape' && filter.value) { e.preventDefault(); e.stopPropagation(); filter.value = ''; current().state.filter = ''; drawList(host); }
      });
      list = el('ul', 'jc-files-list ce-files');
      host.append(filter, list);
    }
    if (filter.value !== state.filter && document.activeElement !== filter) filter.value = state.filter;
    const all = (typeof projectFiles !== 'undefined' && projectFiles[project()]) || null;
    if (!all) {
      list.replaceChildren(el('li', 'jc-empty', project() ? 'Reading the project…' : 'Pick a project first.'));
      if (project() && typeof projectFiles !== 'undefined' && !(project() in projectFiles)) F.send({ type: 'project_files', directory: project() });
      return;
    }
    const shown = rankFiles(all, filter.value, recentFiles.get(scope) || []);
    const open = new Set(state.open);
    list.replaceChildren(...(shown.length ? shown.map((f) => {
      const li = el('li');
      const b = el('button', open.has(f) ? 'open' : '');
      b.type = 'button';
      mine(b);
      const cut = f.lastIndexOf('/');
      if (cut >= 0) b.append(el('span', 'ce-dir', f.slice(0, cut + 1)));
      b.append(document.createTextNode(f.slice(cut + 1)));
      b.title = f;
      b.addEventListener('click', () => openDoc(f));
      li.append(b);
      return li;
    }) : [el('li', 'jc-empty', all.length ? 'No matches.' : 'No files here yet.')]));
  }

  function drawDocBar(doc) {
    if (!doc.ui || !doc.ui.bar) return;
    const bar = doc.ui.bar;
    const path = mine(el('span', 'ce-path', doc.path));
    path.title = doc.path;
    const parts = [path];
    if (doc.dirty) parts.push(el('span', 'ce-chip warn', 'Unsaved'));
    if (!doc.loading && !doc.error && !doc.editable) parts.push(el('span', 'ce-chip', 'Read-only'));
    parts.push(el('span', 'jc-spacer'));
    const kind = previewKind(doc.path);
    if (kind && !doc.error && !doc.loading) {
      parts.push(button(doc.preview ? 'Edit' : 'Preview', 'jc-mini', () => { doc.preview = !doc.preview; drawDoc(doc); }));
    }
    if (!doc.error && !doc.loading) parts.push(button('Find', 'jc-mini', () => { if (doc.preview) { doc.preview = false; drawDoc(doc); } openFind(doc); }, 'Find (⌘F)'));
    parts.push(button('Open in…', 'jc-mini', (e) => openInMenu(e.currentTarget, doc)));
    if (doc.editable) {
      const s = button(doc.saving ? 'Saving…' : 'Save', `jc-mini ce-save${doc.dirty ? ' ready' : ''}`, () => save(doc, false), 'Save (⌘S)');
      s.disabled = !!doc.saving || (!doc.dirty && !doc.create);
      parts.push(s);
    }
    bar.replaceChildren(...parts);
  }

  function drawBanner(doc) {
    if (!doc.ui || !doc.ui.banner) return;
    const host = doc.ui.banner;
    const b = doc.banner;
    host.hidden = !b;
    if (!b) { host.replaceChildren(); return; }
    host.className = `ce-banner ${b.kind || ''}`;
    const text = el('span', 'ce-banner-text', b.text);
    const actions = el('span', 'ce-banner-actions');
    if (b.kind === 'conflict') {
      actions.append(
        button('Compare', 'jc-mini', () => compare(doc)),
        button('Use the disk’s', 'jc-mini', () => reload(doc), 'Your unsaved changes here are dropped'),
        button('Overwrite', 'jc-mini danger', () => save(doc, true), 'Save yours over what’s on disk'),
      );
    } else if (b.kind === 'changed') {
      actions.append(
        button('Compare', 'jc-mini', () => compare(doc)),
        button('Reload', 'jc-mini', () => reload(doc), 'Your unsaved changes here are dropped'),
        button('Keep mine', 'jc-mini', () => { doc.banner = null; drawBanner(doc); }),
      );
    } else if (b.kind === 'restored') {
      actions.append(
        button('Compare', 'jc-mini', () => compare(doc)),
        button('Discard them', 'jc-mini', () => reload(doc), 'Back to what’s on disk'),
        button('Keep them', 'jc-mini', () => { doc.banner = null; drawBanner(doc); }),
      );
    } else {
      actions.append(button('Dismiss', 'jc-mini', () => { doc.banner = null; drawBanner(doc); }));
    }
    host.replaceChildren(text, actions);
    if (b.hunks) host.append(diffView(doc, b.hunks));
    else if (b.comparing) host.append(el('p', 'jc-dim ce-compare-note', 'Comparing…'));
  }

  function diffView(doc, hunks) {
    const box = el('div', 'ce-compare');
    const D = root.JarvisDiff;
    if (!hunks.length) { box.append(el('p', 'jc-dim', 'No differences: what’s on disk is what’s here.')); return box; }
    box.append(el('p', 'jc-dim ce-compare-note', 'On disk (−) and here (+):'));
    for (const h of hunks.slice(0, 40)) {
      if (D && D.buildHunk) {
        const built = D.buildHunk(document, h, { mode: 'unified', path: doc.path, limit: 400 });
        built.el.classList.add('ce-hunk');
        box.append(mine(built.el));
      } else {
        const pre = mine(el('pre', 'jc-code'));
        pre.textContent = h.lines.map(([tag, t]) => `${tag}${t}`).join('\n');
        box.append(pre);
      }
    }
    return box;
  }

  function drawDoc(doc) {
    const host = rootEl.querySelector('.ce-editor-view');
    if (!doc.ui) {
      const frame = el('div', 'ce-doc');
      const bar = el('div', 'ce-doc-bar');
      const banner = el('div', 'ce-banner');
      banner.hidden = true;
      const find = makeFind(doc);
      const edit = makeEditor(doc);
      const preview = el('div', 'ce-preview');
      const status = el('div', 'ce-status');
      const caret = el('span', '', '');
      const facts = el('span', 'ce-facts');
      status.append(caret, facts);
      frame.append(bar, banner, find, edit, preview, status);
      Object.assign(doc.ui, { frame, bar, banner, preview, status, caret, facts });
      if (!doc.loading && !doc.error) fillEditor(doc, doc.pendingText !== undefined ? doc.pendingText : doc.text);
      doc.pendingText = undefined;
    }
    if (host.firstChild !== doc.ui.frame) host.replaceChildren(doc.ui.frame);
    drawDocBar(doc);
    drawBanner(doc);
    const showing = doc.loading ? 'loading' : doc.error ? 'error' : doc.preview && previewKind(doc.path) ? 'preview' : 'edit';
    doc.ui.wrap.hidden = showing !== 'edit';
    doc.ui.preview.hidden = showing === 'edit';
    doc.ui.status.hidden = showing !== 'edit';
    if (showing === 'loading') doc.ui.preview.replaceChildren(el('p', 'jc-dim', 'Opening…'));
    else if (showing === 'error') doc.ui.preview.replaceChildren(el('p', 'jc-dim ce-error', doc.error));
    else if (showing === 'preview') {
      const shown = typeof previewOf === 'function' ? previewOf(doc.path, doc.ui.ta.value) : null;
      doc.ui.preview.replaceChildren(shown || el('p', 'jc-dim', 'No preview for this file.'));
    }
    const why = {
      too_big: 'Too big to edit here: its first 300 KB, read-only. Open it in an editor to change it.',
      not_utf8: 'Not UTF-8 text, so it’s read-only here: saving would change its bytes.',
      line_endings: 'Its lines end in different ways, so it’s read-only here: saving would change them.',
      git: 'One of git’s own files: read-only here.',
    }[doc.why];
    const facts = [doc.crlf ? 'CRLF' : 'LF', doc.unit === '\t' ? 'Indent: tabs' : `Indent: ${(doc.unit || '    ').length} spaces`, why ? '' : 'UTF-8'];
    doc.ui.facts.replaceChildren(...facts.filter(Boolean).map((f) => el('span', '', f)));  // (each its own words, for Chinese)
    if (why && !doc.banner) { doc.banner = { kind: 'info', text: why }; drawBanner(doc); }
    showCaret(doc);
    if (showing === 'edit') requestAnimationFrame(() => placeMark(doc));
  }

  function draw() {
    if (!rootEl || !paneShown()) return;
    const { scope, state } = current();
    rootEl.classList.toggle('editing', state.view === 'editor' && !!state.active);
    drawSegments();
    drawTabs();
    const listHost = rootEl.querySelector('.ce-list-view');
    const editorHost = rootEl.querySelector('.ce-editor-view');
    const viewHost = rootEl.querySelector('.ce-other-view');
    listHost.hidden = state.view !== 'list';
    editorHost.hidden = state.view !== 'editor';
    viewHost.hidden = state.view === 'list' || state.view === 'editor';
    if (state.view === 'list') drawList(listHost);
    else if (state.view === 'editor') {
      const doc = docs.get(keyOf(scope, state.active));
      if (doc) drawDoc(doc); else { state.view = 'list'; draw(); return; }
    } else {
      const view = views.get(state.view);
      if (!view) { state.view = 'list'; draw(); return; }
      view.render(viewHost, { task: F.currentTask(), where: where(F.currentTask()), project: project() });
    }
    const pick = rootEl.querySelector('.ce-open-project');
    pick.hidden = state.view === 'editor' || !project();
  }

  // ── Open in… ──

  function openInMenu(anchor, doc) {
    if (!editors) { F.send({ type: 'cw_editors' }); editors = []; }
    const line = doc && doc.ui ? lineCol(doc.ui.ta.value, doc.ui.ta.selectionStart).line : 0;
    const task = F.currentTask();
    const open = (editor, path, at = 0) => F.send({ type: 'cw_open_in', ...where(task), editor, path, line: at });
    const items = [];
    if (editors.length && doc) {
      items.push({ heading: 'Open this file in' });
      for (const ed of editors) items.push({ label: ed.name, run: () => open(ed.id, doc.path, line) });
      items.push('-');
    }
    if (editors.length) {
      items.push({ heading: 'Open the project in' });
      for (const ed of editors) items.push({ label: ed.name, run: () => open(ed.id, '') });
      items.push('-');
    }
    if (doc) items.push({ label: 'Its own app', run: () => open('app', doc.path) });
    items.push({ label: 'Show in Finder', run: () => open('finder', doc ? doc.path : '') });
    if (typeof openMenu === 'function') openMenu(anchor, items);
  }

  // ── the pane ──

  function mount(body) {
    if (!rootEl) {
      rootEl = el('div', 'ce-root');
      const top = el('div', 'ce-top');
      const seg = el('div', 'jcx-seg ce-seg');
      seg.setAttribute('role', 'tablist');
      const whole = button('Open in…', 'jc-mini ce-open-project', (e) => openInMenu(e.currentTarget, null), 'Open the project in an editor, or in Finder');
      top.append(seg, el('span', 'jc-spacer'), whole);
      const tabs = el('div', 'ce-tabs');
      tabs.setAttribute('role', 'tablist');
      tabs.setAttribute('aria-label', 'Open files');
      const listView = el('div', 'ce-list-view');
      const editorView = el('div', 'ce-editor-view');
      const otherView = el('div', 'ce-other-view');
      rootEl.append(top, tabs, listView, editorView, otherView);
    }
    if (body.firstChild !== rootEl || body.childNodes.length !== 1) body.replaceChildren(rootEl);
  }

  F.registerPane('files', {
    title: 'Files',
    render(body) {
      mount(body);
      if (!editors) { editors = []; F.send({ type: 'cw_editors' }); }
      // A file asked for through the core's viewer (/memory, "open hub.py" by voice).
      if (typeof fileView !== 'undefined' && fileView && fileView.path && fileView !== seenFileView && fileView.text === undefined && !fileView.error) {
        seenFileView = fileView;
        const lines = pendingLines.get(fileView.path);
        pendingLines.delete(fileView.path);
        openDoc(fileView.path, lines ? { line: lines.start, end: lines.end } : {});
        return;
      }
      reopenDrafts(current().scope);
      draw();
      checkSoon();
    },
  });

  // /memory opens the pane before it names the file (app.js): the file's answer opens it here.
  F.on('file_content', (ev) => {
    if (typeof fileView === 'undefined' || fileView !== ev || ev === seenFileView || !ev.path || !paneShown()) return;
    seenFileView = ev;
    openDoc(ev.path);
  });

  // ── events ──

  function docOf(ev) { return ev && ev.ref ? docs.get(ev.ref) : null; }

  F.on('cw_file', (ev) => {
    const doc = docOf(ev);
    if (!doc) return;
    const keepAt = doc.ui && doc.reloading ? { s: doc.ui.ta.selectionStart, e: doc.ui.ta.selectionEnd, top: doc.ui.ta.scrollTop } : null;
    doc.loading = false;
    doc.reloading = false;
    doc.error = ev.error || '';
    doc.create = !!ev.missing && !!doc.allowCreate;
    if (doc.create) { doc.error = ''; doc.editable = true; doc.text = ''; doc.version = null; }
    if (!ev.error) {
      doc.text = ev.text || '';
      doc.version = ev.version || null;
      doc.crlf = !!ev.crlf;
      doc.editable = !!ev.editable;
      doc.why = ev.why || '';
    }
    doc.dirty = false;
    if (doc.banner && doc.banner.kind !== 'info') doc.banner = null;
    // Unsaved changes kept from before (a reload, a crash): back in the editor, still
    // saved only over the version they were edited from.
    const draft = !doc.error && doc.editable ? draftOf(doc.key) : null;
    let shown = doc.text;
    if (draft && draft.text !== doc.text) {
      shown = draft.text;
      doc.dirty = true;
      if (draft.create) { doc.create = true; doc.version = null; } else doc.version = draft.base || doc.version;
      const moved = !draft.create && draft.base && ev.version && draft.base.sha !== ev.version.sha;
      doc.banner = moved
        ? { kind: 'changed', text: 'Your unsaved changes are back, but the file changed on disk since.' }
        : { kind: 'restored', text: 'Your unsaved changes from before are back.' };
    } else if (draft) dropDraft(doc.key);
    if (doc.ui && !doc.error) {
      fillEditor(doc, shown);
      if (keepAt) {
        doc.ui.ta.setSelectionRange(Math.min(keepAt.s, shown.length), Math.min(keepAt.e, shown.length));
        doc.ui.ta.scrollTop = keepAt.top;
      }
    } else if (!doc.ui) doc.pendingText = shown;
    const { scope, state } = current();
    if (doc.scope === scope && state.active === doc.path && state.view === 'editor') { draw(); applyMark(doc); } else drawTabs();
  });

  F.on('cw_file_saved', (ev) => {
    const doc = docOf(ev);
    if (!doc) return;
    doc.saving = false;
    if (ev.ok) {
      doc.version = ev.version;
      doc.text = doc.ui ? doc.ui.ta.value : doc.text;
      doc.dirty = doc.ui ? doc.ui.ta.value !== doc.text : false;
      doc.create = false;
      clearTimeout(doc.stashTimer);
      dropDraft(doc.key);
      doc.banner = { kind: 'saved', text: 'Saved.' };
      setTimeout(() => { if (doc.banner && doc.banner.kind === 'saved') { doc.banner = null; drawBanner(doc); } }, 1800);
    } else if (ev.conflict) {
      doc.banner = { kind: 'conflict', text: ev.missing ? 'It was deleted on disk since you opened it.' : 'It changed on disk since you opened it. Nothing was saved.', disk: ev };
    } else if (ev.error) {
      doc.banner = { kind: 'error', text: ev.error };
    }
    drawTabs();
    drawDocBar(doc);
    drawBanner(doc);
  });

  F.on('cw_file_stat', (ev) => {
    const doc = docOf(ev);
    if (!doc || !ev.changed || doc.saving || doc.loading) return;
    if (!doc.dirty) {
      reload(doc);  // Claude (or another editor) changed it: what's on disk now, in place
      return;
    }
    if (!doc.banner || doc.banner.kind !== 'conflict') {
      doc.banner = { kind: 'changed', text: ev.missing ? 'It was deleted on disk. Save to put your version back.' : 'It changed on disk while you were editing it.' };
      drawBanner(doc);
    }
  });

  F.on('cw_file_compare', (ev) => {
    const doc = docOf(ev);
    if (!doc || !doc.banner) return;
    doc.banner = { ...doc.banner, comparing: false, hunks: ev.hunks || [] };
    if (ev.error) doc.banner.text = ev.error;
    drawBanner(doc);
  });

  F.on('cw_editors', (ev) => { editors = ev.items || []; });

  // A step ended in the session on show: files open here may have changed.
  F.on('task_log_update', (ev) => { const task = F.currentTask(); if (task && ev.id === task.id && paneShown()) checkSoon(); });
  F.on('task_finished', (ev) => { const task = F.currentTask(); if (task && ev.id === task.id && paneShown()) checkSoon(); });
  window.addEventListener('focus', () => { if (paneShown()) checkSoon(); });

  // "Read lines 10 to 20 of hub.py" (code-voice.js opens the file through the core viewer).
  F.on('code_voice_file', (ev) => { if (ev.path && ev.start) pendingLines.set(ev.path, { start: ev.start, end: ev.end || ev.start }); });

  root.JarvisEditor = {
    open(path, line, end) { openDoc(path, line ? { line, end } : {}); },
    // A file that may not exist yet (CLAUDE.local.md): saving makes it.
    openNew(path) { openDoc(path, { allowCreate: true }); },
    registerView(id, view) { views.set(id, view); if (rootEl) draw(); },
    showView(id) { const { state } = current(); state.view = id; if (!paneShown()) F.openPane('files'); else draw(); },
    where: () => where(F.currentTask()),
    dirty: () => [...docs.values()].filter((d) => d.dirty).map((d) => d.path),
  };
})(typeof window === 'object' ? window : globalThis);
