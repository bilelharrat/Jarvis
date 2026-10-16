// What the review extension draws, worked out without VS Code (so node --test checks it):
// where each hunk of a session's change sits in the file as it is now, the file as it was
// before the session's hunks (for the side-by-side diff), a session's line in the side bar,
// and the turns' receipts as Markdown.
//
// A hunk is the Changes pane's own (code_changes.public): {id, n, old_start, new_start,
// lines: [[tag, text]], cut, kept}, tag ' ' (context), '+' (added), '-' (removed) or '\\'
// (git's "no newline at end of file"). Line numbers from the API are 1-based; VS Code's
// are 0-based, so everything here returns 0-based lines.
//
// Cost policy: no model is called here.

'use strict';

// Where a hunk sits in the file now: the lines it added (0-based), the lines it took out
// (each shown above the line that now follows them), and the range a comment may be put on.
function hunkPlaces(hunk) {
  const added = [];
  const removed = []; // [{ line, texts }]: texts taken out just above `line`
  let line = Math.max(0, (hunk.new_start || 1) - 1);
  let first = -1;
  let pending = [];
  const flush = () => { if (pending.length) { removed.push({ line, texts: pending }); pending = []; } };
  for (const [tag, text] of hunk.lines || []) {
    if (tag === '-') {
      if (first < 0) first = line;
      pending.push(text);
    } else if (tag === '+') {
      flush();
      if (first < 0) first = line;
      added.push(line);
      line += 1;
    } else if (tag === ' ') {
      flush();
      line += 1;
    }
  }
  flush();
  const start = Math.max(0, (hunk.new_start || 1) - 1);
  const end = Math.max(start, line - 1);
  return { id: hunk.id, n: hunk.n, kept: !!hunk.kept, first: first < 0 ? start : first, start, end, added, removed };
}

// The file as it was before these hunks, from the file as it is now: each hunk's new lines
// put back as its old ones, bottom to top. null when it can't be told for sure: a hunk cut
// short by the API (cut > 0), or the file no longer matching a hunk (changed since).
function baseText(current, hunks) {
  if (!Array.isArray(hunks) || hunks.some((h) => h.cut > 0)) return null;
  const endsNewline = current.endsWith('\n');
  const lines = current.split('\n');
  if (endsNewline) lines.pop();
  const sorted = [...hunks].sort((a, b) => (b.new_start || 0) - (a.new_start || 0));
  for (const h of sorted) {
    const now = [];
    const before = [];
    for (const [tag, text] of h.lines || []) {
      if (tag === ' ' || tag === '+') now.push(text);
      if (tag === ' ' || tag === '-') before.push(text);
    }
    // git's new_start for an empty new side is the line before it (0 at the top).
    const at = now.length ? (h.new_start || 1) - 1 : (h.new_start || 0);
    for (let i = 0; i < now.length; i += 1) {
      if (lines[at + i] !== now[i]) return null;
    }
    lines.splice(at, now.length, ...before);
  }
  return lines.length ? lines.join('\n') + (endsNewline ? '\n' : '') : '';
}

const STATUS = { M: 'changed', A: 'new', D: 'deleted', R: 'renamed', '?': 'new' };

function fileLabel(file) {
  const counts = `+${file.added || 0} −${file.removed || 0}`;
  return { label: file.path, description: `${STATUS[file.status] || file.status} · ${counts}` };
}

function sessionLabel(s) {
  const title = s.title || s.prompt || `Session ${s.id}`;
  const state = s.busy ? 'working' : (s.status || '');
  const files = (s.files_changed || []).length;
  const bits = [s.folder, state, files ? `${files} file${files === 1 ? '' : 's'}` : ''].filter(Boolean);
  return { label: title.length > 80 ? `${title.slice(0, 79)}…` : title, description: bits.join(' · ') };
}

const RISK = { high: '🔴 High risk', medium: '🟡 Medium risk', low: '🟢 Low risk' };

// The turns' receipts, newest first, as one Markdown page.
function receiptsMarkdown(session, receipts) {
  const title = (session && (session.title || session.prompt)) || 'Eden Code session';
  const out = [`# Receipts · ${title}`, ''];
  if (!receipts || !receipts.length) {
    out.push('No receipts yet: a turn that changes files ends with one.');
    return out.join('\n') + '\n';
  }
  for (const item of [...receipts].reverse()) {
    const r = item.receipt || {};
    out.push(`## ${item.at ? item.at.replace('T', ' ') : `Turn ${item.n}`}`, '');
    out.push(`**${RISK[r.risk] || r.risk || 'Risk unknown'}**${r.why ? `: ${r.why}` : ''}`, '');
    const files = r.files || [];
    out.push(`**Files** (${r.file_count ?? files.length}): ${files.map((f) => `\`${f}\``).join(', ') || 'none'}`);
    if (r.tests) {
      const t = r.tests;
      const said = t.passed === null || t.passed === undefined ? 'ran' : t.passed ? 'passed' : 'failed';
      const counts = [t.passed_count ? `${t.passed_count} passed` : '', t.failed_count ? `${t.failed_count} failed` : ''].filter(Boolean).join(', ');
      out.push(`**Tests**: \`${t.command}\` ${said}${counts ? ` (${counts})` : ''}`);
    } else {
      out.push('**Tests**: none run');
    }
    if (r.check) out.push(`**Check**: ${r.check.status}${r.check.text ? `: ${r.check.text}` : ''}`);
    // The receipt's own words (code_receipts.receipt_text) say the rest: its own check,
    // the requirements met, the assumptions made.
    if (item.text) out.push('', ...String(item.text).split('\n').map((l) => `> ${l}`));
    out.push('', '---', '');
  }
  return out.join('\n');
}

// The comment the editor sends for one line (the API words them all as one message).
function commentOf(file, line0, text, excerpt = '') {
  return { path: file, line: line0 + 1, text: String(text).trim(), excerpt: String(excerpt).trim().slice(0, 300) };
}

module.exports = { hunkPlaces, baseText, fileLabel, sessionLabel, receiptsMarkdown, commentOf };
