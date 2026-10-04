// Logbook: Jarvis Code as a ship's log, under the Obsidian look only (body[data-skin=
// "obsidian"]; every other look's Jarvis Code is left exactly as it is). The session's title in
// large light type over one line (branch · model · effort · tokens · elapsed); the transcript as
// a ledger: numbered one-line rows (READ, EDIT, RUN…) with the target on a dotted leader and the
// result on the right, your messages large beside the gutter's "YOU"; a margin of the files
// touched, the plan and the context window, which folds away (its button in the head, or ⌥⌘\;
// kept in prefs: features/code_logbook.py); the composer as a field of its own with its
// controls as chips; the session index by day with status glyphs (and, in split view, folded to
// a rail); approvals as brass ledger entries (Allow ⏎, Always ⌥⏎, Deny esc).
// It decorates what app.js and the other modules draw (never draws the deck again): what it
// adds is taken away when the look changes. Pure helpers are exported for node --test
// (tests/web/code-logbook.test.mjs).
(function codeLogbook(root) {
  'use strict';

  // ── pure logic (tests/web/code-logbook.test.mjs) ──

  const READS = new Set(['Read', 'NotebookRead', 'WebFetch', 'LS']);
  const SEARCHES = new Set(['Grep', 'Glob', 'WebSearch', 'ToolSearch']);
  const EDITS = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit']);
  const RUNS = new Set(['Bash', 'BashOutput', 'KillShell', 'KillBash']);

  // What a transcript entry is, as a step: read, search, edit, run, agent, tool (another
  // server's), you (your message), wait (an approval or a question for you), text (Claude's
  // words or thinking), or null for what isn't a step (a turn's totals, a note, a sub-step).
  function stepKind(entry) {
    const e = entry || {};
    if (e.approval) return 'wait';
    switch (e.role) {
      case 'user': return 'you';
      case 'assistant': case 'thinking': case 'plan': case 'live': return 'text';
      case 'tool': {
        if (e.tool === 'Agent') return 'agent';
        if (READS.has(e.tool)) return 'read';
        if (SEARCHES.has(e.tool)) return 'search';
        if (EDITS.has(e.tool)) return 'edit';
        if (RUNS.has(e.tool)) return 'run';
        if (e.tool === 'AskUserQuestion') return 'wait';
        return 'tool';
      }
      default: return null;
    }
  }

  // The word a ledger row gives its step.
  function kindWord(entry) {
    const e = entry || {};
    if (e.tool === 'Write') return 'WRITE';
    if (e.tool === 'WebFetch') return 'FETCH';
    return { read: 'READ', search: 'SEARCH', edit: 'EDIT', run: 'RUN', agent: 'AGENT', tool: 'TOOL', wait: 'ASK' }[stepKind(e)] || '';
  }

  // A step's colour: read (and search, another server's tool), edit, run (and an agent), you
  // (your messages, what waits on you), text.
  function kindClass(kind) {
    return { read: 'read', search: 'read', tool: 'read', edit: 'edit', run: 'run', agent: 'run', you: 'you', wait: 'you', text: 'text' }[kind] || 'text';
  }

  // The head's line in parts: the numbers (5.5, 82k, 4m 12s) set in mono, the words not.
  function metaParts(text) {
    return String(text || '').split(/(\d[\d.,:]*(?:[kKMhms](?![a-z]))?)/).filter(Boolean).map((t) => ({ text: t, num: /^\d/.test(t) }));
  }

  // When an entry was written ("2026-10-03T15:20:01", the backend's local time), in ms.
  function entryTime(entry) {
    const t = entry && entry.at ? Date.parse(entry.at) : NaN;
    return Number.isFinite(t) ? t : null;
  }

  // What a step acted on: the command, the file, the pattern.
  function stepTarget(entry) {
    const e = entry || {};
    const detail = String(e.detail || '');
    const first = detail.split('\n')[0];
    if (RUNS.has(e.tool)) return first.replace(/^\$ /, '') || String(e.text || '').replace(/^Running /, '');
    if (EDITS.has(e.tool)) return first.replace(/ \(new contents\)$/, '');
    if (e.tool === 'Agent') return String(e.text || '').replace(/^Agent:\s*/, '');
    if (SEARCHES.has(e.tool)) return String(e.text || '').replace(/^Searching for /, '') || first;
    return String(e.text || '').replace(/^(Reading|Running|Editing|Writing)\s*/, '') || first;
  }

  // The +/− lines a step's diff shows (approval_detail: the path, then "- old", "+ new").
  function diffStats(detail) {
    let added = 0;
    let removed = 0;
    for (const line of String(detail || '').split('\n').slice(1)) {
      if (/^\+(?!\+\+)/.test(line)) added += 1;
      else if (/^-(?!--)/.test(line)) removed += 1;
    }
    return { added, removed };
  }

  // A row's result, on the right: [{ text, tone }] (tone: add, del, ok, bad, muted, live).
  function ledgerResult(entry) {
    const e = entry || {};
    const out = String(e.output || '');
    if (e.status === 'running') return [{ text: '…', tone: 'live' }];
    const failed = e.status === 'failed';
    const kind = stepKind(e);
    if (kind === 'edit') {
      const { added, removed } = diffStats(e.detail);
      const parts = [];
      if (added) parts.push({ text: `+${added}`, tone: 'add' });
      if (removed) parts.push({ text: `−${removed}`, tone: 'del' });
      if (!parts.length && e.tool === 'Write') parts.push({ text: 'new', tone: 'muted' });
      if (failed) parts.push({ text: '✗', tone: 'bad' });
      return parts.length ? parts : [{ text: '✓', tone: 'ok' }];
    }
    if (kind === 'run') {
      const passed = [/(\d+) passed/, /# pass (\d+)/, /Tests:\s+(\d+) passed/, /(\d+) tests? passed/].map((re) => out.match(re)).find(Boolean);
      const broke = [/(\d+) failed/, /# fail ([1-9]\d*)/, /(\d+) errors?\b/].map((re) => out.match(re)).find((m) => m && Number(m[1]) > 0);
      if (broke) return [{ text: `${broke[1]} ✗`, tone: 'bad' }];
      if (passed) return [{ text: `${passed[1]} ✓`, tone: failed ? 'bad' : 'ok' }];
      return [{ text: failed ? '✗' : '✓', tone: failed ? 'bad' : 'ok' }];
    }
    if (failed) return [{ text: '✗', tone: 'bad' }];
    if (kind === 'read' && e.tool !== 'WebFetch' && out) {
      const lines = out.replace(/\n$/, '').split('\n').length;
      return [{ text: `${lines}${out.length >= 2000 ? '+' : ''} ln`, tone: 'muted' }];
    }
    if (kind === 'search' && out) {
      const found = out.split('\n').filter((l) => l.trim()).length;
      return [{ text: `${found}${out.length >= 2000 ? '+' : ''} found`, tone: 'muted' }];
    }
    return [{ text: '✓', tone: 'ok' }];
  }

  // The files a session touched, with their lines: from the Changes view's files when there
  // are some (path, added, removed), else from the steps' own diffs. The biggest first; add and
  // del are each file's share (%) of the biggest one's lines, for its bar.
  function touchStats(entries, changed) {
    const by = new Map();
    if (Array.isArray(changed) && changed.length) {
      for (const f of changed) if (f && f.path) by.set(f.path, { path: f.path, added: Number(f.added) || 0, removed: Number(f.removed) || 0 });
    } else {
      for (const e of entries || []) {
        if (stepKind(e) !== 'edit' || e.status === 'failed') continue;
        const path = stepTarget(e);
        if (!path) continue;
        const { added, removed } = diffStats(e.detail);
        const was = by.get(path) || { path, added: 0, removed: 0 };
        by.set(path, { path, added: was.added + added, removed: was.removed + removed });
      }
    }
    const files = [...by.values()].sort((a, b) => (b.added + b.removed) - (a.added + a.removed) || a.path.localeCompare(b.path));
    const most = Math.max(1, ...files.map((f) => f.added + f.removed));
    return files.map((f) => ({
      ...f,
      name: f.path.split('/').filter(Boolean).pop() || f.path,
      delta: [f.added ? `+${f.added}` : '', f.removed ? `−${f.removed}` : ''].filter(Boolean).join(' ') || '±0',
      add: Math.round((100 * f.added) / most),
      del: Math.round((100 * f.removed) / most),
    }));
  }

  // 00:00 from the session's start; past an hour, 1:02:03.
  function clock(seconds) {
    const s = Math.max(0, Math.floor(Number(seconds) || 0));
    const two = (n) => String(n).padStart(2, '0');
    const h = Math.floor(s / 3600);
    return h ? `${h}:${two(Math.floor((s % 3600) / 60))}:${two(s % 60)}` : `${two(Math.floor(s / 60))}:${two(s % 60)}`;
  }

  // 12s, 4m 12s, 1h 3m.
  function span(seconds) {
    const s = Math.max(0, Math.round(Number(seconds) || 0));
    if (s < 60) return `${s}s`;
    if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
    return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
  }

  // 31.2k tok.
  function tokensText(n) {
    const v = Number(n) || 0;
    if (!v) return '';
    if (v < 1000) return `${v} tok`;
    if (v < 1e6) return `${(v / 1000).toFixed(v < 100000 ? 1 : 0).replace(/\.0$/, '')}k tok`;
    return `${(v / 1e6).toFixed(1).replace(/\.0$/, '')}M tok`;
  }

  // How long ago, as the index says it: now, 4m, 2h; before today, the day it was.
  function ago(ms, now = Date.now(), locale) {
    if (!Number.isFinite(ms)) return '';
    const secs = Math.max(0, (now - ms) / 1000);
    if (secs < 60) return 'now';
    if (secs < 3600) return `${Math.floor(secs / 60)}m`;
    if (dayKey(ms, now) === 'today') return `${Math.floor(secs / 3600)}h`;
    const d = new Date(ms);
    if (now - ms < 6 * 86400000) return d.toLocaleDateString(locale, { weekday: 'short' });
    return d.toLocaleDateString(locale, { month: 'short', day: 'numeric' });
  }

  // The index's day groups: today, yesterday, else the date (YYYY-MM-DD, local).
  function dayKey(ms, now = Date.now()) {
    if (!Number.isFinite(ms)) return 'earlier';
    const day = (t) => { const d = new Date(t); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
    const key = day(ms);
    if (key === day(now)) return 'today';
    const y = new Date(now);
    y.setDate(y.getDate() - 1);
    if (key === day(y.getTime())) return 'yesterday';
    return key;
  }

  // The context window's bar: each kind's share of the window (%), the biggest few, in order.
  function contextSegments(ctx, most = 4) {
    const c = ctx || {};
    const max = Number(c.max) || Number(c.tokens) || 0;
    if (!max) return [];
    const cats = (Array.isArray(c.categories) ? c.categories : []).filter((x) => x && x.tokens > 0);
    return cats.slice(0, most).map((x) => ({ name: String(x.name || ''), pct: Math.max(0.5, Math.round((1000 * x.tokens) / max) / 10) }));
  }

  // A session's glyph in the index: needs (brass diamond), running (arc dot), failed, done.
  function rowState(task, asks) {
    if (asks > 0) return 'needs';
    if (!task) return 'done';
    if (task.busy || task.status === 'running') return 'running';
    if (task.status === 'failed') return 'failed';
    return 'done';
  }

  const api = {
    stepKind, kindWord, kindClass, metaParts, entryTime, stepTarget, diffStats, ledgerResult,
    touchStats, clock, span, tokensText, ago, dayKey, contextSegments, rowState,
  };
  if (typeof module === 'object' && module.exports) { module.exports = api; return; }
  const F = root.jarvisFeatures;
  if (!F) return;

  const on = () => document.body.dataset.skin === 'obsidian';
  const cc = $('cc');
  const main = cc.querySelector('.jc-main');
  const tl = $('deck-timeline');
  const shared = () => F.codeSessions || null;
  const reduced = () => root.matchMedia && root.matchMedia('(prefers-reduced-motion: reduce)').matches;
  // What this module adds to others' elements: taken away when the look changes.
  const extra = (tag, cls, text) => { const n = el(tag, `lb-x ${cls}`, text); return n; };
  let frame = 0;  // the redraw asked for (schedule)
  let drawnMargin = '';  // what the margin last drew

  // Every entry as it's drawn keeps its data (the hub's entry) on its element.
  F.registerEntryDecorator((entry, li) => { li.lbEntry = entry; });
  F.on('task_log_update', (ev) => {
    if (ev.id !== ccSelected) return;
    const li = [...tl.querySelectorAll('[data-tool-id]')].find((n) => n.dataset.toolId === ev.tool_id);
    if (li && li.lbEntry) Object.assign(li.lbEntry, { status: ev.status, output: ev.output || li.lbEntry.output });
    schedule();
  });

  // ── the pieces that stay (hidden by the stylesheet in every other look) ──

  const meta = el('p', 'lb-meta');
  meta.setAttribute('data-no-i18n', '');
  cc.querySelector('.jc-titles').append(meta);

  const margin = el('aside', 'lb-margin');
  margin.setAttribute('aria-label', 'Margin: files touched, the plan, the context window');
  const marginSection = (title) => {
    const box = el('section', 'lb-msec');
    const h = el('h2', 'lb-mhead');
    const count = mine(el('span', 'lb-mcount'));
    h.append(el('span', '', title), count);
    box.append(h);
    margin.append(box);
    return { box, count };
  };
  const touched = marginSection('TOUCHED');
  const touchedList = el('div', 'lb-files');
  touched.box.append(touchedList);
  const plan = marginSection('PLAN');
  const planList = el('ol', 'lb-plan');
  plan.box.append(planList);
  const context = marginSection('CONTEXT');
  const ctxBar = el('span', 'lb-ctxbar');
  ctxBar.setAttribute('role', 'img');
  const ctxNames = mine(el('span', 'lb-ctxnames'));
  context.box.append(ctxBar, ctxNames);
  $('jc-body').insertBefore(margin, $('cc-scroll').nextSibling);

  // ── 5. the composer: a field of its own, its controls as chips (app.js's own buttons) ──
  const form = $('deck-composer');
  const controls = form.querySelector('.jc-composer-row');
  const attachBox = $('jc-attach');
  const attachHome = attachBox.parentElement;
  const NS = 'http://www.w3.org/2000/svg';
  const ICONS = {
    clip: 'M13.2 7.6 8 12.8a3.3 3.3 0 0 1-4.7-4.7l5.6-5.6a2.2 2.2 0 0 1 3.1 3.1l-5.6 5.6a1.1 1.1 0 0 1-1.6-1.6L10 4.4',
    model: 'M8 1.8l1.6 4.6 4.6 1.6-4.6 1.6L8 14.2 6.4 9.6 1.8 8l4.6-1.6z',
    stop: 'M4.5 4.5h7v7h-7z',
    chev: 'M5 6.5 8 9.5l3-3',
    margin: 'M3.8 2.5h8.4a1.3 1.3 0 0 1 1.3 1.3v8.4a1.3 1.3 0 0 1-1.3 1.3H3.8a1.3 1.3 0 0 1-1.3-1.3V3.8a1.3 1.3 0 0 1 1.3-1.3zM10 2.5v11',
  };
  function lbIcon(name, size = 14) {
    const svg = document.createElementNS(NS, 'svg');
    for (const [k, v] of Object.entries({ width: size, height: size, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.5', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true', class: `lb-ic lb-ic-${name}` })) svg.setAttribute(k, String(v));
    const path = document.createElementNS(NS, 'path');
    path.setAttribute('d', ICONS[name]);
    if (name === 'stop') { path.setAttribute('fill', 'currentColor'); path.setAttribute('stroke', 'none'); }
    svg.append(path);
    return svg;
  }
  $('jc-plus').prepend(lbIcon('clip', 15));
  $('jc-model').prepend(lbIcon('model', 13));
  $('jc-effort').append(lbIcon('chev', 10));  // (the mode and the model have their own)
  // While the session works and nothing's typed, send is a stop square (Esc, as ever, too).
  const stop = el('button', 'jc-round lb-stop');
  stop.type = 'button';
  stop.setAttribute('aria-label', 'Stop');
  stop.title = 'Stop (esc)';
  stop.append(lbIcon('stop', 12));
  stop.addEventListener('click', () => { const t = currentTask(); if (t) F.send({ type: 'task_interrupt', id: t.id }); });
  controls.append(stop);
  // The mode's explanation (the status line's words): on the mode chip, as a tooltip.
  const modeTip = el('span', 'lb-tip');
  modeTip.id = 'lb-mode-tip';
  modeTip.setAttribute('role', 'tooltip');
  $('jc-mode-btn').append(modeTip);
  const hint = el('p', 'lb-hint', '⏎ send · esc stop');
  hint.setAttribute('aria-hidden', 'true');
  form.after(hint);
  $('deck-input').addEventListener('input', () => schedule());
  function renderComposer(t) {
    if (attachBox.parentElement !== form) form.prepend(attachBox);
    const busy = !!(t && t.busy) && !$('deck-input').value.trim();
    cc.classList.toggle('lb-busy', busy);
    const tip = ($('cc-mode') && $('cc-mode').textContent) || '';
    if (modeTip.textContent !== tip) modeTip.textContent = tip;
    if (!$('jc-mode-btn').hasAttribute('aria-describedby')) $('jc-mode-btn').setAttribute('aria-describedby', 'lb-mode-tip');
  }
  function plainComposer() {
    if (attachBox.parentElement !== attachHome) attachHome.insertBefore(attachBox, $('jc-queue'));
    cc.classList.remove('lb-busy');
    $('jc-mode-btn').removeAttribute('aria-describedby');
  }

  // ── 4b. the margin folds away: its button in the head, ⌥⌘\; kept in prefs ──
  let marginOn = true;  // features/code_logbook.py: code_margin
  const marginBtn = el('button', 'jc-tool lb-margin-btn');
  marginBtn.type = 'button';
  marginBtn.append(lbIcon('margin', 17));
  function drawMarginBtn() {
    const label = marginOn ? 'Hide the margin' : 'Show the margin';
    marginBtn.setAttribute('aria-label', label);
    marginBtn.title = `${F.t(label)} (⌥⌘\\)`;
    marginBtn.setAttribute('aria-pressed', String(marginOn));
  }
  function setMargin(open) {
    marginOn = open;
    drawMarginBtn();
    drawnMargin = '';
    schedule();
    F.send({ type: 'feature_prefs', changes: { code_margin: open } });
  }
  marginBtn.addEventListener('click', () => setMargin(!marginOn));
  cc.querySelector('.jc-capsule').append(marginBtn);
  drawMarginBtn();
  const takePrefs = (features) => {
    const open = !features || features.code_margin !== false;
    if (open !== marginOn) { marginOn = open; drawMarginBtn(); drawnMargin = ''; schedule(); }
  };
  F.on('prefs', (p) => takePrefs(p && p.features), { replay: true });
  F.on('hello', (ev) => takePrefs(ev.prefs && ev.prefs.features), { replay: true });
  // ⌥⌘\: the margin (⌘\ is the sidebar's, ⌘⇧\ split view's).
  document.addEventListener('keydown', (e) => {
    if (!on() || cc.hidden || !e.metaKey || !e.altKey || e.shiftKey || e.ctrlKey) return;
    if (!(e.code === 'Backslash' || e.key === '\\' || e.key === '«')) return;  // (« is ⌥\ on a US layout)
    e.preventDefault();
    setMargin(!marginOn);
  });

  // The index folds to a rail of glyphs in split view.
  const fold = el('button', 'jc-icon lb-fold');
  fold.type = 'button';
  fold.append(mine(el('span', '', '≡')));
  const folded = () => cc.classList.contains('lb-folded');
  function drawFold() {
    const label = folded() ? 'Unfold the index' : 'Fold the index to a rail';
    fold.setAttribute('aria-label', label);
    fold.title = label;
    fold.setAttribute('aria-pressed', String(folded()));
  }
  fold.addEventListener('click', () => {
    cc.classList.toggle('lb-folded');
    try { localStorage.setItem('jc.fold', folded() ? 'rail' : 'open'); } catch (_) { /* private mode */ }
    drawFold();
    if (typeof moveGlider === 'function') setTimeout(moveGlider, 380);
  });
  try { if (localStorage.getItem('jc.fold') === 'rail') cc.classList.add('lb-folded'); } catch (_) { /* private mode */ }
  drawFold();
  const sideHead = cc.querySelector('.jc-side-head');
  if (sideHead) sideHead.insertBefore(fold, sideHead.firstChild);

  // ── the session on show ──

  const task = () => currentTask();
  // The transcript as steps: [{ li, entry, kind, at }], in order (approvals last).
  function steps() {
    const out = [];
    for (const li of tl.children) {
      if (li.classList.contains('jc-ask')) {
        const a = pendingApprovals.get(li.dataset.approval);
        out.push({ li, entry: { approval: true, ...(a || {}) }, kind: 'wait', at: null });
        continue;
      }
      if (li === live.text) { out.push({ li, entry: { role: 'live' }, kind: 'text', at: Date.now() }); continue; }
      const entry = li.lbEntry;
      const kind = stepKind(entry);
      if (!kind) continue;
      out.push({ li, entry, kind, at: entryTime(entry) });
    }
    return out;
  }
  const firstAt = (list) => { for (const s of list) if (s.at != null) return s.at; return null; };
  function elapsed(list, t) {
    const first = firstAt(list);
    if (first == null) return 0;
    const times = list.map((s) => s.at).filter((x) => x != null);
    const end = t && t.busy ? Date.now() : Math.max(...times);
    return Math.max(0, (end - first) / 1000);
  }

  // ── 1. the head: title, and one mono line ──

  function renderMeta(t, list) {
    if (!t) { meta.textContent = ''; meta.dataset.text = ''; return; }
    const project = deckProjects.find((p) => p.name === t.folder);
    const branch = (t.workspace && t.workspace.branch) || (project && project.branch) || '';
    const model = String(t.model_label || MODEL_LABELS[t.model] || t.model || '').toLowerCase();
    const effort = String(t.effort || ($('jc-effort-label') && $('jc-effort-label').textContent) || '').toLowerCase();
    const ctx = ccContext[t.id];
    const text = [branch, model, effort, ctx ? tokensText(ctx.tokens) : '', span(elapsed(list, t))].filter(Boolean).join(' · ');
    if (meta.dataset.text === text) return;
    meta.dataset.text = text;
    meta.replaceChildren(...metaParts(text).map((p) => (p.num ? el('span', 'lb-num', p.text) : document.createTextNode(p.text))));
  }

  // ── 3. the ledger ──

  function renderLedger(list) {
    const first = firstAt(list);
    let n = 0;
    for (const s of list) {
      const { li, entry, kind } = s;
      if (kind === 'you' && li.classList.contains('jc-user')) {
        gutter(li, [s.at != null && first != null ? clock((s.at - first) / 1000) : '', 'YOU']);
      } else if (li.classList.contains('jc-say') && !li.classList.contains('live')) {
        gutter(li, [s.at != null && first != null ? clock((s.at - first) / 1000) : '']);
      } else if (kind === 'wait' && li.classList.contains('jc-ask')) {
        n += 1;
        approvalEntry(li, entry, n);
      } else if (li.classList.contains('jc-toolwrap') || li.classList.contains('jc-agent')) {
        n += 1;
        row(li, entry, n);
      }
    }
  }
  function gutter(li, lines) {
    let g = li.querySelector(':scope > .lb-gut');
    if (!g) { g = extra('span', 'lb-gut'); li.prepend(g); }
    const key = lines.join('|');
    if (g.dataset.key === key) return;
    g.dataset.key = key;
    g.replaceChildren(...lines.filter(Boolean).map((line) => (line === 'YOU' ? el('span', 'lb-you', 'YOU') : mine(el('span', '', line)))));
  }
  function row(li, entry, n) {
    const head = li.querySelector(':scope > details > summary') || li.querySelector(':scope > .jc-agent-head');
    if (!head || !entry) return;
    let parts = head.lbParts;
    if (!parts || !parts.n.isConnected) {
      const num = extra('span', 'lb-n');
      num.setAttribute('data-no-i18n', '');
      const kind = extra('span', 'lb-kind');
      const what = extra('span', 'lb-what');
      const target = mine(el('span', 'lb-target'));
      what.append(target, el('span', 'lb-lead'));
      const result = extra('span', 'lb-result');
      result.setAttribute('data-no-i18n', '');
      head.prepend(num, kind, what);
      head.append(result);
      parts = head.lbParts = { n: num, kind, target, result };
      li.classList.add('lb-row');
    }
    const k = stepKind(entry);
    const number = `№ ${String(n).padStart(2, '0')}`;
    if (parts.n.textContent !== number) parts.n.textContent = number;
    const w = kindWord(entry);
    if (parts.kind.dataset.word !== w) { parts.kind.dataset.word = w; parts.kind.textContent = w; parts.kind.className = `lb-x lb-kind ${kindClass(k)}`; }
    const target = stepTarget(entry);
    if (parts.target.textContent !== target) { parts.target.textContent = target; parts.target.title = target; }
    const res = ledgerResult(entry);
    const key = JSON.stringify(res);
    if (parts.result.dataset.key !== key) {
      parts.result.dataset.key = key;
      parts.result.replaceChildren(...res.map((r) => el('span', `lb-r ${r.tone}`, r.text)));
    }
  }

  // ── 7. approvals: brass ledger entries ──

  const ASKS = { Bash: 'RUN THIS?', Write: 'CREATE THIS?', Edit: 'EDIT THIS?', MultiEdit: 'EDIT THIS?', NotebookEdit: 'EDIT THIS?' };
  const KEYS = { allow: '⏎', always: '⌥⏎', allow_edits: '', deny: 'esc' };
  function approvalEntry(li, a, n) {
    const label = a.ask_kind === 'plan' ? 'READY TO CODE?' : a.ask_kind === 'question' ? 'QUESTION' : ASKS[a.tool] || 'ALLOW THIS?';
    let top = li.querySelector(':scope > .lb-ask');
    if (!top) {
      top = extra('div', 'lb-ask');
      const num = mine(el('span', 'lb-n'));
      top.append(num, el('span', 'lb-ask-label', label));
      li.prepend(top);
      li.setAttribute('role', 'group');
      li.setAttribute('aria-label', label);
      li.dataset.lbRole = '1';
    }
    top.querySelector('.lb-n').textContent = String(n).padStart(2, '0');
    li.dataset.lbAsk = a.ask_kind || a.tool || '';
    const choices = (a.choices || []);
    li.querySelectorAll('.jc-choices > button').forEach((b, i) => {
      const id = choices[i] && choices[i].id;
      if (id && b.dataset.lbChoice !== id) b.dataset.lbChoice = id;
      if (!id || b.querySelector('.lb-key') || !KEYS[id]) return;
      const k = extra('span', 'lb-key', KEYS[id]);
      k.setAttribute('data-no-i18n', '');
      k.setAttribute('aria-hidden', 'true');
      b.append(k);
    });
  }
  // ⏎ allows, ⌥⏎ always, esc denies: only while the approval has the focus (a choice keeps its
  // own Enter), or is the pane's latest and nothing else has the focus (never while typing:
  // there ⏎ sends and esc stops, as ever).
  document.addEventListener('keydown', (e) => {
    if (!on() || cc.hidden || e.metaKey || e.ctrlKey || e.shiftKey || e.isComposing) return;
    if (e.key !== 'Enter' && e.key !== 'Escape') return;
    const sheets = [...tl.querySelectorAll(':scope > .jc-ask[data-approval]')].filter((s) => s.querySelector('.jc-choices'));
    const sheet = sheets[sheets.length - 1];
    if (!sheet) return;
    const target = e.target instanceof Element ? e.target : null;
    const inSheet = !!target && !!target.closest('.jc-ask') && target.closest('.jc-ask') === sheet;
    const control = target && target.closest('input, textarea, select, [contenteditable="true"], button, a[href], summary, [role="button"], [role="menuitem"], [role="slider"], [role="separator"], [role="option"]');
    if (target && target.closest('.jc-feedback')) return;  // the reason being written
    if (!inSheet && control) return;
    if (inSheet && e.key === 'Enter' && !e.altKey && control) return;  // the focused choice's own Enter
    if (!inSheet && target && target !== document.body && !cc.contains(target)) return;
    const a = pendingApprovals.get(sheet.dataset.approval);
    if (!a) return;
    // The number keys' own safeguards, and the split's: never an approval the owner can't see
    // (behind the agent board, or the pane narrow split view hides), never the window's own
    // pane while the right one has the focus, never a held key, one of several at once, a key
    // something else already took (Esc closing the board) or keys typed into a field a redraw
    // just took away.
    if (e.defaultPrevented || e.repeat || a.multi) return;
    if (typeof typingLost === 'function' && typingLost()) return;
    if (!sheet.checkVisibility({ visibilityProperty: true })) return;
    const split = typeof F.splitState === 'function' ? F.splitState() : null;
    if (!inSheet && split && split.on && split.focus === 'right') return;
    const has = (id) => (a.choices || []).some((c) => c.id === id);
    const choice = e.key === 'Escape' ? 'deny' : e.altKey ? (has('always') ? 'always' : null) : (has('allow') ? 'allow' : null);
    if (!choice || !has(choice)) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    answerApproval(a, choice);
  }, true);

  // ── 4. the margin ──

  let changesAsked = { id: null, at: 0 };
  function changedFiles(t) {
    const C = root.JarvisChanges;
    if (!C || !C.store) return null;
    const view = (C.store.views && C.store.views.get(t.id)) || 'session';
    const data = C.store.data.get(`${t.id}:${view}`);
    if (data && Array.isArray(data.files)) return data.files;
    if (C.request && (changesAsked.id !== t.id || Date.now() - changesAsked.at > 20000)) {
      changesAsked = { id: t.id, at: Date.now() };
      C.request(t);
    }
    return null;
  }
  function renderMargin(t, list) {
    marginBtn.hidden = !t;
    if (!t || !marginOn) { margin.hidden = true; return; }
    const files = touchStats(list.map((s) => s.entry), changedFiles(t));
    const todos = t.todos || [];
    const segs = contextSegments(ccContext[t.id]);
    const ctx = ccContext[t.id];
    const key = JSON.stringify([files, todos, segs, ctx && ctx.percent]);
    margin.hidden = !files.length && !todos.length && !ctx;  // nothing to show: no column
    if (key === drawnMargin) return;
    drawnMargin = key;
    touched.box.hidden = !files.length;
    touched.count.textContent = String(files.length);
    touchedList.replaceChildren(...files.slice(0, 12).map((f) => {
      const b = el('button', 'lb-file');
      b.type = 'button';
      b.title = f.path;
      const top = el('span', 'lb-file-top');
      top.append(mine(el('span', 'lb-file-name', f.name)), mine(el('span', 'lb-file-delta', f.delta)));
      const bars = el('span', 'lb-file-bars');
      bars.setAttribute('aria-hidden', 'true');
      const add = el('i', 'add');
      add.style.width = `${f.add}%`;
      const del = el('i', 'del');
      del.style.width = `${f.del}%`;
      bars.append(add, del);
      b.append(top, bars);
      b.addEventListener('click', () => openFile(f.path));
      return b;
    }));
    plan.box.hidden = !todos.length;
    plan.count.textContent = todos.length ? `${todos.filter((x) => x.status === 'completed').length}/${todos.length}` : '';
    planList.replaceChildren(...todos.map((x) => {
      const li = el('li', `lb-todo ${x.status}`);
      li.append(mine(el('span', 'lb-todo-mark', x.status === 'completed' ? '✓' : x.status === 'in_progress' ? '›' : '·')), mine(el('span', '', x.status === 'in_progress' && x.active ? x.active : x.content)));
      return li;
    }));
    context.box.hidden = !ctx;
    context.count.textContent = ctx && ctx.percent != null ? `${ctx.percent}%` : '';
    ctxBar.replaceChildren(...segs.map((s, i) => {
      const seg = el('i', `lb-seg s${i}`);
      seg.style.width = `${s.pct}%`;
      return seg;
    }));
    ctxBar.setAttribute('aria-label', ctx ? `${ctx.percent}% of the context window` : '');
    ctxNames.textContent = segs.map((s) => s.name.toLowerCase()).join(' · ');
  }
  // A file in the margin, in the Changes pane, open and in view.
  function openFile(path) {
    openPane('diff');
    let tries = 0;
    const find = () => {
      const file = [...document.querySelectorAll('#jc-pane-body .jcx-file')].find((d) => {
        const p = d.querySelector('.jcx-path');
        return p && (p.textContent === path || path.endsWith(`/${p.textContent}`) || p.textContent.endsWith(path));
      });
      if (file) { file.open = true; file.scrollIntoView({ block: 'start', behavior: reduced() ? 'auto' : 'smooth' }); return; }
      if (++tries < 20) setTimeout(find, 150);
    };
    find();
  }

  // ── 6. the session index ──

  const DAYS = { today: 'TODAY', yesterday: 'YESTERDAY' };
  function rowTime(row) {
    if (row.dataset.task) {
      const id = Number(row.dataset.task);
      const S = shared();
      const m = S && S.meta.get(id);
      const t = ccTasks.find((x) => x.id === id);
      const when = Date.parse((m && m.updated) || (t && t.started) || '');
      return Number.isFinite(when) ? when : null;
    }
    const h = codeHistory.find((x) => x.session_id === row.dataset.session);
    return h ? Number(h.modified) || Date.parse(h.last_modified || '') || null : null;
  }
  function renderIndex() {
    if (F.splitPane) return;
    const S = shared();
    const split = typeof F.splitState === 'function' ? F.splitState() : null;
    const now = Date.now();
    let moved = false;
    for (const ul of $('deck-project-list').querySelectorAll('.jc-sessions')) {
      const items = [...ul.children].filter((li) => li.querySelector(':scope > .jc-session[data-task], :scope > .jc-session.past[data-session]'));
      if (!items.length) continue;
      items.forEach((li, i) => { if (li.dataset.lbIdx === undefined) li.dataset.lbIdx = String(i); });
      const timed = items.map((li) => { const row = li.querySelector('.jc-session'); return { li, row, at: rowTime(row) }; });
      timed.sort((a, b) => (b.at || 0) - (a.at || 0) || Number(a.li.dataset.lbIdx) - Number(b.li.dataset.lbIdx));
      // Day by day, newest first; the group heads drawn again only when the order changes.
      const groups = [];
      for (const x of timed) {
        const key = dayKey(x.at, now);
        if (!groups.length || groups[groups.length - 1].key !== key) groups.push({ key, at: x.at, rows: [] });
        groups[groups.length - 1].rows.push(x.li);
      }
      const sig = JSON.stringify(groups.map((g) => [g.key, g.rows.map((li) => li.dataset.lbIdx)]));
      if (ul.dataset.lbSig !== sig || !ul.querySelector(':scope > .lb-day')) {
        ul.dataset.lbSig = sig;
        ul.querySelectorAll(':scope > .lb-day').forEach((n) => n.remove());
        const tail = [...ul.children].filter((li) => !items.includes(li));
        const ordered = [];
        for (const g of groups) {
          const head = extra('li', 'lb-day');
          head.setAttribute('role', 'presentation');
          const label = DAYS[g.key] ? el('span', '', DAYS[g.key]) : mine(el('span', '', Number.isFinite(g.at) ? new Date(g.at).toLocaleDateString(uiLocale(), { weekday: 'short', month: 'short', day: 'numeric' }).toUpperCase() : '—'));
          head.append(label, mine(el('span', 'lb-day-count')));
          head.lbRows = g.rows;
          ordered.push(head, ...g.rows);
        }
        ul.append(...ordered, ...tail);
        moved = true;
      }
      for (const head of ul.querySelectorAll(':scope > .lb-day')) {
        const shown = (head.lbRows || []).filter((li) => !li.hidden).length;
        head.hidden = !shown;
        const count = String(shown).padStart(2, '0');
        const c = head.querySelector('.lb-day-count');
        if (c.textContent !== count) c.textContent = count;
      }
      // Each row: its glyph, its time, its pane.
      for (const x of timed) {
        const row = x.row;
        const id = row.dataset.task ? Number(row.dataset.task) : null;
        const t = id != null ? ccTasks.find((y) => y.id === id) : null;
        const asks = id != null && S && S.needsYou ? S.needsYou(id).length : 0;
        const state = id != null ? rowState(t, asks) : 'done';
        if (row.dataset.lbState !== state) row.dataset.lbState = state;
        let when = row.querySelector(':scope > .lb-when');
        if (!when) { when = extra('small', 'lb-when'); row.append(when); }
        const text = state === 'needs' ? 'you' : ago(x.at, now, uiLocale());
        if (when.dataset.text !== text) {
          when.dataset.text = text;
          when.replaceChildren(state === 'needs' ? el('span', '', 'you') : mine(el('span', '', text)));
        }
        const pane = split && split.on ? (id != null && id === ccSelected ? 'L' : id != null && id === split.right ? 'R' : '') : '';
        let tag = row.querySelector(':scope > .lb-pane');
        if (pane && !tag) { tag = extra('span', 'lb-pane'); tag.setAttribute('data-no-i18n', ''); row.append(tag); }
        if (tag) { if (pane) { if (tag.textContent !== pane) tag.textContent = pane; } else tag.remove(); }
        const title = row.querySelector('.jc-stitle');
        if (title && row.title !== title.textContent) { row.title = title.textContent; row.dataset.lbTitle = '1'; }
      }
    }
    fold.hidden = !(split && split.on);
    if (moved && typeof moveGlider === 'function') moveGlider();
  }
  // The look changes away: the index as it was, in its own order.
  function plainIndex() {
    for (const ul of $('deck-project-list').querySelectorAll('.jc-sessions')) {
      delete ul.dataset.lbSig;
      const items = [...ul.children].filter((li) => li.dataset.lbIdx !== undefined);
      if (!items.length) continue;
      const tail = [...ul.children].filter((li) => li.dataset.lbIdx === undefined);
      items.sort((a, b) => Number(a.dataset.lbIdx) - Number(b.dataset.lbIdx));
      ul.append(...items, ...tail);
      items.forEach((li) => delete li.dataset.lbIdx);
    }
    for (const row of $('deck-project-list').querySelectorAll('[data-lb-state], [data-lb-title]')) {
      row.removeAttribute('data-lb-state');
      if (row.dataset.lbTitle) { row.removeAttribute('title'); row.removeAttribute('data-lb-title'); }
    }
    if (typeof moveGlider === 'function') moveGlider();
  }

  // ── all of it, once a frame at most ──

  let wasOn = false;
  const watchers = [];
  function schedule() {
    if (frame) return;
    frame = requestAnimationFrame(() => { frame = 0; draw(); });
  }
  function draw() {
    const now = on();
    cc.classList.toggle('lb', now);
    if (!now) {
      if (wasOn) {
        plainIndex();
        plainComposer();
        cc.querySelectorAll('.lb-x').forEach((n) => n.remove());
        tl.querySelectorAll('.lb-row').forEach((n) => n.classList.remove('lb-row'));
        tl.querySelectorAll('[data-lb-role]').forEach((n) => { n.removeAttribute('role'); n.removeAttribute('aria-label'); n.removeAttribute('data-lb-role'); });
        tl.querySelectorAll('[data-lb-ask], [data-lb-choice]').forEach((n) => { n.removeAttribute('data-lb-ask'); n.removeAttribute('data-lb-choice'); });
        tl.querySelectorAll('[data-tool-id], .jc-agent').forEach((li) => {
          const head = li.querySelector('summary, .jc-agent-head');
          if (head) delete head.lbParts;
        });
        drawnMargin = '';
      }
      wasOn = false;
      for (const w of watchers) w.takeRecords();
      return;
    }
    wasOn = true;
    const t = task();
    const list = t ? steps() : [];
    renderMeta(t, list);
    renderLedger(list);
    renderMargin(t, list);
    renderComposer(t);
    renderIndex();
    for (const w of watchers) w.takeRecords();  // (what this drew isn't news)
  }

  const watch = (node, options) => {
    const w = new MutationObserver(schedule);
    w.observe(node, options);
    watchers.push(w);
  };
  watch(tl, { childList: true });
  watch($('deck-project-list'), { childList: true, subtree: true, attributes: true, attributeFilter: ['hidden'] });
  watch(document.body, { attributes: true, attributeFilter: ['data-skin', 'data-tone'] });
  watch(cc, { attributes: true, attributeFilter: ['class', 'hidden'] });
  for (const type of ['tasks', 'task_context', 'jc_select', 'task_log', 'approval', 'approval_resolved', 'code_meta', 'code_changes', 'claude_history', 'task_finished', 'prefs', 'hello', 'task_transcript', 'task_stream']) {
    F.on(type, () => schedule());
  }
  F.on('task_finished', (ev) => { if (ev.id === ccSelected) changesAsked.at = 0; });  // its files, asked for again
  // While a session works (or waits on you), its clock and the last tick grow.
  setInterval(() => {
    if (!on() || cc.hidden || document.hidden) return;
    const t = task();
    if (t && (t.busy || tl.querySelector(':scope > .jc-ask'))) schedule();
  }, 1000);
  draw();
})(typeof window === 'object' ? window : globalThis);
