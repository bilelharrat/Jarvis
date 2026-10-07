// Messages as Atelier draws them: user bubbles, assistant bubbles with the routing chip and
// its rationale, the thinking block, tool cards (Edit/Write as diffs), permission cards,
// research cards and sources, drafts pagers. Actions are data-act attributes handled by
// one delegated listener (app.js).

import { el, ico, fmtCost, effortLabel, shortModel, sizeText, noKeys } from './util.js';
import { state, siblings, summarizeInput, nodeText, attachmentData, persona } from './state.js';
import { renderMarkdown, CANVAS_LANGS } from './markdown.js';
import { ratedBadge } from './router.js';
import { whereBadge } from './privacy.js';
import { isSpeaking } from './voice.js';
import { compareView, openGroupOf, reopenButton, setLaneRenderer, strongerButton } from './compare.js';
import { approvalCard, isTainted, sourceStrip } from './guard.js';
import { macCard } from './files.js';
import { feedbackButtons } from './learned.js';

export const ui_open = { thinks: new Set(), tools: new Set(), expanded: new Set(), editing: null };
// an answer drawn as one lane of a side-by-side comparison (compare.js): no pager, no "Try again"
setLaneRenderer((c, node) => assistantMessage(c, node, false, { lane: true }));

const TOOL_ICONS = { Read: 'doc', Grep: 'search', Glob: 'search', LS: 'folder', Edit: 'edit', MultiEdit: 'edit', Write: 'edit', NotebookEdit: 'edit', Bash: 'term', BashOutput: 'term', WebSearch: 'globe', WebFetch: 'globe', TodoWrite: 'list', Task: 'spark' };

export function renderMessage(c, node, { last } = {}) {
  if (node.role !== 'user') { const g = openGroupOf(c, node); if (g) return compareView(c, g.user); } // answers side by side (G1, G6)
  return node.role === 'user' ? userMessage(c, node, last) : assistantMessage(c, node, last);
}

function pager(c, node, label) {
  const sib = siblings(c, node);
  if (sib.length < 2) return null;
  const i = sib.indexOf(node.id);
  return el('span', { class: 'drafts', role: 'group', 'aria-label': label },
    el('button', { type: 'button', 'data-act': 'sib-prev', 'aria-label': `Previous ${label.toLowerCase()}`, disabled: i === 0 }, ico('chevl')),
    el('span', { 'aria-live': 'polite' }, `${i + 1} of ${sib.length}`),
    el('button', { type: 'button', 'data-act': 'sib-next', 'aria-label': `Next ${label.toLowerCase()}`, disabled: i === sib.length - 1 }, ico('chevr')));
}

function userMessage(c, node, last) {
  const wrap = el('div', { class: `msg user${last ? ' last' : ''}`, 'data-id': node.id });
  if (ui_open.editing === node.id) {
    const ta = el('textarea', { 'aria-label': 'Edit your message', 'data-edit': '1' });
    ta.value = node.content || '';
    wrap.append(el('div', 'edit-box', ta, el('div', 'row',
      el('button', { type: 'button', class: 'btn', 'data-act': 'edit-cancel' }, 'Cancel'),
      el('button', { type: 'button', class: 'btn primary', 'data-act': 'edit-send' }, 'Send'))),
    el('div', 'notice', 'Sending makes a new branch; the old one stays in the pager.'));
    return wrap;
  }
  if (node.steered) wrap.append(el('span', { class: 'steered', title: 'Sent while the previous reply was streaming' }, '↳ steered'));
  const text = node.content || '';
  // a very long message (a pasted document) shows its first lines, with "Show all"
  const lines = text.length > 1200 ? text.split('\n').length : 0;
  const long = text.length > 3000 || lines > 24;
  const open = ui_open.expanded.has(node.id);
  const bubble = el('div', `bubble${long && !open ? ' clamp' : ''}`);
  bubble.append(long ? el('span', 'utext', text) : document.createTextNode(text));
  if (long) bubble.append(el('button', { type: 'button', class: 'more', 'data-act': 'expand-user', 'aria-expanded': String(open) },
    open ? 'Show less' : `Show all · ${lines > 1 ? `${lines} lines, ` : ''}${text.length.toLocaleString()} characters`));
  const data = attachmentData.get(node.id) || [];
  for (const a of node.attachments || []) {
    const live = data.find((d) => d.name === a.name && d.kind === a.kind);
    const thumb = a.kind === 'image' && live && live.url ? el('img', { class: 'thumb', src: live.url, alt: '' }) : el('span', 'thumb');
    bubble.append(el('span', 'attach', thumb, `${a.name}${a.size ? ` · ${sizeText(a.size)}` : ''}${a.kind === 'image' && !live ? ' · image not kept after reload' : ''}`));
  }
  for (const ctx of node.context || []) bubble.append(el('span', 'ctxchip', `⧉ ${ctx.title}`));
  wrap.append(bubble);
  wrap.append(el('div', 'msg-acts',
    pager(c, node, 'Branch'),
    el('button', { type: 'button', class: 'iconbtn', 'data-act': 'copy-msg', title: 'Copy', 'aria-label': 'Copy message' }, ico('copy')),
    c.kind === 'code' ? null : el('button', { type: 'button', class: 'iconbtn', 'data-act': 'edit', title: 'Edit and resend (new branch)', 'aria-label': 'Edit and resend' }, ico('edit'))));
  return wrap;
}

function routeChip(node) {
  const r = node.route;
  const actual = node.usage && typeof node.usage.costUSD === 'number';
  const est = typeof r.costUSD === 'number';
  const cost = actual ? fmtCost(node.usage.costUSD) : est ? `~${fmtCost(r.costUSD)}` : '—';
  const name = `${shortModel(r.modelName || r.model)}${r.effort ? ` · ${r.effortLabel || effortLabel(r.effort)}` : ''}`;
  return el('button', { type: 'button', class: 'route-chip', 'data-act': 'chip', 'aria-haspopup': 'dialog', 'aria-expanded': 'false', 'aria-label': `Routed to ${name}, ${actual ? 'cost' : 'estimated'} ${cost}. Show why.` },
    el('span', { class: `pdot ${r.provider || ''}`, 'aria-hidden': 'true' }),
    el('span', 'nm', name),
    est || actual ? el('span', { class: 'chip-cost', title: actual ? (node.usage.notional ? 'Subscription: not billed' : 'Actual cost') : 'Estimated cost' }, `${cost}${actual && node.usage.notional ? '*' : ''}`) : null,
    ratedBadge(r));
}

function assistantMessage(c, node, last, { lane = false } = {}) {
  const wrap = el('div', { class: `msg assistant${last ? ' last' : ''}`, 'data-id': node.id });
  if (node.route) {
    const head = el('div', 'msg-head');
    head.append(el('div', 'chip-wrap', routeChip(node), whereBadge(node.route)));
    if (node.route.rationale && !lane) head.append(el('div', 'rationale', node.route.rationale));
    wrap.append(head);
  }
  const bubble = el('div', 'bubble');
  { const strip = sourceStrip(node); if (strip) bubble.append(strip); } // what this reply read from outside (H8)
  const sources = node.citations || [];
  const research = node.mode === 'research';
  if (research) {
    const live = node.streaming;
    const secs = node.doneAt && node.startedAt ? Math.max(1, Math.round((node.doneAt - node.startedAt) / 1000)) : 0;
    const card = el('div', 'research',
      el('div', 'res-head', ico('globe'), el('span', '', `Deep Research · ${String(node.topic || 'report').slice(0, 60)}`),
        el('span', { class: `res-done${live ? ' live' : ''}` }, live ? 'Researching…' : node.error ? 'Stopped' : `Completed${secs ? ` · ${secs < 60 ? `${secs}s` : `${Math.round(secs / 60)} min`}` : ''}`)),
      el('div', { class: `res-rail${live ? ' live' : ''}` }, el('i')));
    if (sources.length) card.append(sourceList(sources));
    bubble.append(card);
  }
  if (node.thinking || (node.streaming && node.thinkingLive)) {
    const open = ui_open.thinks.has(node.id);
    const live = node.streaming && node.thinkingLive;
    const secs = node.thinkMs ? Math.max(1, Math.round(node.thinkMs / 1000)) : 0;
    const btn = el('button', { type: 'button', class: `thinking${live ? ' live' : ''}`, 'data-act': 'think', 'aria-expanded': String(open) },
      ico('spark', 13, 'think-ic'), live ? 'Thinking…' : `Thought for ${secs || 1}s`, ico('chevr', 12, 'chv'));
    const body = el('div', 'think-body', el('div', '', node.thinking || ''));
    if (open) body.style.maxHeight = 'none';
    bubble.append(btn, body);
  }
  const parts = node.parts || [];
  for (const [i, part] of parts.entries()) {
    if (part.type === 'text') {
      if (!part.text) continue;
      const md = el('div', 'md');
      md.append(renderMarkdown(part.text, { sources, untrusted: isTainted(node) })); // H8: held images, visible link destinations
      bubble.append(md);
    } else if (part.type === 'tool') bubble.append(toolCard(c, node, part));
    else if (part.type === 'perm') bubble.append(part.approval ? approvalCard(c, node, part.approval, { perm: i }) : permCard(c, part, i));
    else if (part.type === 'note') bubble.append(el('div', 'notice', part.text));
    else if (part.type === 'mac') bubble.append(macCard(c, node, part)); // what Eden read on the Mac (files.js)
  }
  if (node.streaming && !nodeText(node) && !parts.some((p) => p.type === 'tool') && !node.thinkingLive) bubble.append(el('div', { class: 'typing', 'aria-label': 'Working' }, el('i'), el('i'), el('i')));
  if (sources.length && !research) bubble.append(sourceList(sources));
  if (!node.streaming) {
    const arts = artifactsIn(nodeText(node));
    arts.forEach((a, k) => bubble.append(el('div', 'artlink', ico('art'),
      el('div', 'grow', el('b', '', a.title), el('span', '', `Artifact · ${a.lang} · live preview`)),
      el('button', { type: 'button', class: 'cap', 'data-act': 'open-art', 'data-k': String(k) }, 'Open'))));
  }
  for (const a of node.approvals || []) bubble.append(approvalCard(c, node, a)); // actions the server's gate holds (H8)
  for (const n of node.notes || []) bubble.append(el('div', 'notice warn', n));
  if (node.error) {
    bubble.append(el('div', { class: 'errbox', role: 'alert' }, ico('x'), el('span', '', node.error),
      el('button', { type: 'button', class: 'cap primary', 'data-act': 'retry' }, ico('retry'), 'Retry')));
  } else if (node.finish === 'aborted') bubble.append(el('div', 'stopped', 'Stopped.'));
  else if (node.finish === 'length') bubble.append(el('div', 'notice warn', 'Cut off at the model’s output limit.'));
  wrap.append(bubble);
  if (!node.streaming) {
    wrap.append(el('div', 'msg-acts',
      lane ? null : pager(c, node, 'Draft'),
      el('button', { type: 'button', class: 'iconbtn', 'data-act': 'copy-msg', title: 'Copy', 'aria-label': 'Copy reply' }, ico('copy')),
      lane ? null : strongerButton(c, node),
      lane ? null : reopenButton(c, node),
      lane ? null : feedbackButtons(c, node), // H2: 👍 / 👎 teach the router (learned.js)
      nodeText(node).trim() ? el('button', { type: 'button', class: `iconbtn${isSpeaking(node.id) ? ' on' : ''}`, 'data-act': 'speak', 'aria-pressed': String(isSpeaking(node.id)), title: isSpeaking(node.id) ? 'Stop reading' : 'Read aloud', 'aria-label': 'Read aloud' }, ico('speaker')) : null,
      c.kind === 'code' || lane ? null : el('button', { type: 'button', class: 'iconbtn', 'data-act': 'regen', 'aria-haspopup': 'menu', 'aria-expanded': 'false', title: 'Try again', 'aria-label': 'Try again' }, ico('retry')),
      node.route ? el('button', { type: 'button', class: 'iconbtn', 'data-act': 'inspect', title: 'Route console', 'aria-label': 'Open in Route console' }, ico('sliders')) : null));
  }
  return wrap;
}

function sourceList(sources) {
  return el('div', 'sources', ...sources.map((s, i) => el('button', { type: 'button', class: 'src', 'data-cite': String(i + 1), title: s.url }, `${i + 1} · ${hostOf(s.url)}${s.title ? ` — ${s.title}` : ''}`)));
}
export function hostOf(u) { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return String(u || ''); } }

/** Canvas-able blocks in a reply: ```html, ```svg, ```artifact. */
export function artifactsIn(text) {
  const out = [];
  const re = /^ {0,3}(`{3,}|~{3,})\s*([\w+-]*)[^\n]*\n([\s\S]*?)\n {0,3}\1\s*$/gm;
  let m;
  while ((m = re.exec(text))) {
    const lang = (m[2] || '').toLowerCase();
    if (!CANVAS_LANGS.has(lang)) continue;
    const code = m[3];
    const t = /<title>([^<]{1,80})<\/title>/i.exec(code) || /<h1[^>]*>([^<]{1,80})<\/h1>/i.exec(code);
    out.push({ lang: lang === 'htm' || lang === 'xhtml' ? 'html' : lang, code, title: t ? t[1].trim() : lang === 'svg' ? 'SVG drawing' : 'Artifact' });
  }
  return out;
}

/* ---------- tool cards ---------- */

function toolSummary(part) {
  const inp = part.input || {};
  const target = summarizeInput(inp);
  let res = '';
  if (part.result) {
    const out = String(part.result.output || '');
    const lines = out ? out.split('\n').length : 0;
    if (!part.result.ok) res = 'failed';
    else if (part.name === 'Read') res = `${lines} lines`;
    else if (part.name === 'Grep' || part.name === 'Glob') res = `${out.trim() ? lines : 0} matches`;
    else if (part.name === 'Edit' || part.name === 'Write' || part.name === 'MultiEdit') { const d = diffStats(part); res = `+${d.a} −${d.d}`; }
    else if (lines) res = `${lines} line${lines === 1 ? '' : 's'} of output`;
  } else res = 'running…';
  if (part.name === 'TodoWrite') return `${(inp.todos || []).length} to-dos`;
  return [target, res].filter(Boolean).join(' — ');
}

function toolCard(c, node, part) {
  const open = ui_open.tools.has(part.id);
  const st = !part.result ? 'run' : part.result.ok ? 'done' : 'fail';
  const card = el('div', { class: `tool${open ? ' open' : ''}`, 'data-tool': part.id });
  card.append(el('button', { type: 'button', class: 'tool-head', 'data-act': 'tool', 'aria-expanded': String(open) },
    ico(TOOL_ICONS[part.name] || 'term'), el('span', 'tname', part.name), el('span', 'tsum', toolSummary(part)),
    el('span', { class: `tstat ${st}`, 'aria-label': st === 'run' ? 'running' : st === 'done' ? 'done' : 'failed' }), ico('chevr', 12, 'tchev')));
  const body = el('div', 'tool-body');
  if (open) body.style.maxHeight = 'none';
  const inner = el('div');
  const inp = part.input || {};
  if (part.name === 'Edit' || part.name === 'Write' || part.name === 'MultiEdit') {
    inner.append(diffView(c, part));
  } else if (part.name === 'Bash') {
    inner.append(el('div', 'codeblk', `$ ${inp.command || ''}`));
  } else if (part.name === 'TodoWrite') {
    inner.append(todoList(inp.todos || []));
  } else if (Object.keys(inp).length) {
    inner.append(el('div', 'lbl2', 'Input'), el('div', 'codeblk', JSON.stringify(inp, null, 2)));
  }
  if (part.result && part.name !== 'TodoWrite' && !(part.result.ok && (part.name === 'Edit' || part.name === 'Write' || part.name === 'MultiEdit'))) {
    const out = String(part.result.output || '');
    inner.append(el('div', 'lbl2', part.result.ok ? 'Output' : 'Error'), numbered(out || '(no output)', !part.result.ok, part.name === 'Read'));
  }
  body.append(inner);
  card.append(body);
  return card;
}

function numbered(text, err, lines) {
  const box = el('div', `codeblk${err ? ' err' : ''}`);
  if (!lines) { box.textContent = text; return box; }
  // Claude Code's Read output already carries "  12→" line numbers: show them as numbers
  for (const [i, line] of text.split('\n').entries()) {
    const m = /^\s*(\d+)[→\t](.*)$/.exec(line);
    box.append(el('span', 'ln', m ? m[1] : String(i + 1)), `${m ? m[2] : line}\n`);
  }
  return box;
}

export function todoList(todos) {
  const box = el('div', 'plan-list');
  if (!todos.length) { box.append(el('div', 'muted', 'No to-dos yet.')); return box; }
  for (const t of todos) {
    const status = t.status || 'pending';
    box.append(el('div', { class: `pitem${status === 'completed' ? ' done' : status === 'in_progress' ? ' prog' : ''}` },
      el('span', 'box', ico('check')), el('span', 'pt', status === 'in_progress' && t.activeForm ? t.activeForm : t.content || ''),
      status === 'in_progress' ? el('span', 'live', 'in progress') : null));
  }
  return box;
}

/* ---------- diffs ---------- */

export function lineDiff(a, b) {
  const A = a.split('\n'), B = b.split('\n');
  if (A.length * B.length > 250000) return [...A.map((t) => ['-', t]), ...B.map((t) => ['+', t])];
  const n = A.length, m = B.length;
  const dp = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = A[i] === B[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const out = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (A[i] === B[j]) { out.push([' ', A[i]]); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) out.push(['-', A[i++]]);
    else out.push(['+', B[j++]]);
  }
  while (i < n) out.push(['-', A[i++]]);
  while (j < m) out.push(['+', B[j++]]);
  return out;
}

function editsOf(part) {
  const inp = part.input || {};
  if (part.name === 'Write') return [{ old: '', neu: String(inp.content || '') }];
  if (part.name === 'MultiEdit') return (inp.edits || []).map((e) => ({ old: String(e.old_string || ''), neu: String(e.new_string || '') }));
  return [{ old: String(inp.old_string || ''), neu: String(inp.new_string || '') }];
}
function diffStats(part) {
  let a = 0, d = 0;
  for (const e of editsOf(part)) for (const [k] of lineDiff(e.old, e.neu)) { if (k === '+') a++; else if (k === '-') d++; }
  return { a, d };
}

function diffView(c, part) {
  const box = el('div', 'diff');
  const file = (part.input || {}).file_path || (part.input || {}).path || '';
  if (file) box.append(el('div', 'diff-file', file));
  editsOf(part).forEach((e, k) => {
    const id = `${part.id}:${k}`;
    const st = (c.hunks && c.hunks[id]) || 'pending';
    const rows = part.name === 'Write' ? e.neu.split('\n').map((t) => ['+', t]) : lineDiff(e.old, e.neu);
    const shown = rows.length > 400 ? rows.slice(0, 400) : rows;
    const hunk = el('div', { class: 'diff-hunk', 'data-hunk': id, 'data-state': st });
    const adds = rows.filter((r) => r[0] === '+').length, dels = rows.filter((r) => r[0] === '-').length;
    hunk.append(el('div', 'hunk-bar', el('span', '', `${part.name === 'Write' ? 'new file' : `edit ${k + 1}`} · +${adds} −${dels}`),
      el('span', 'hb-r', hunkStates(),
        el('span', 'hunk-actions',
          el('button', { type: 'button', class: 'cap ok', 'data-act': 'hunk', 'data-state': 'reviewed', 'data-hunk-id': id }, 'Mark reviewed'),
          el('button', { type: 'button', class: 'cap rev', 'data-act': 'hunk', 'data-state': 'revert', 'data-hunk-id': id, 'data-file': file }, 'Ask to revert')))));
    const pre = el('pre');
    for (const [kind, text] of shown) pre.append(el('span', kind === '+' ? 'al' : kind === '-' ? 'dl' : 'cl', `${kind === ' ' ? ' ' : kind} ${text}`), '\n');
    if (rows.length > shown.length) pre.append(el('span', 'cl', `… ${rows.length - shown.length} more lines`));
    hunk.append(pre);
    box.append(hunk);
  });
  return box;
}
export function hunkStates() {
  return el('span', '',
    el('span', 'hstate ok', '✓ Reviewed', el('button', { type: 'button', 'data-act': 'hunk', 'data-state': 'pending', 'aria-label': 'Undo reviewed' }, 'undo')),
    el('span', 'hstate rv', 'Revert asked', el('button', { type: 'button', 'data-act': 'hunk', 'data-state': 'pending', 'aria-label': 'Undo' }, 'undo')));
}

/* ---------- permission card ---------- */

const MODE_NAMES = { default: 'Manual', acceptEdits: 'Accept edits', plan: 'Plan', bypassPermissions: 'Auto' };
function permCard(c, part, index) {
  const tools = [...new Set((part.denials || []).map((d) => d.tool))];
  const card = el('div', { class: `perm glass${part.state && part.state !== 'pending' ? ' approved' : ''}`, 'data-perm': String(index) });
  if (part.state && part.state !== 'pending') {
    const ok = part.state !== 'denied';
    card.append(el('div', 'p-t', ico(ok ? 'check' : 'x', 16), ok ? `${part.state === 'always' ? 'Always allowed' : 'Allowed once'} — ${tools.join(', ')}` : `Denied — Eden won’t run ${tools.join(', ')}`));
    return card;
  }
  card.append(el('div', 'p-t', el('span', { style: { color: 'var(--warn)', display: 'inline-flex' } }, ico('term')), `Allow Eden to use ${tools.join(', ') || 'this tool'}?`));
  for (const d of part.denials || []) {
    const inp = d.input || {};
    card.append(el('code', 'mono', `${d.tool}: ${inp.command || inp.file_path || inp.url || summarizeInput(inp) || JSON.stringify(inp)}`));
  }
  card.append(el('div', 'p-acts',
    el('button', { type: 'button', class: 'cap primary', 'data-act': 'perm', 'data-choice': 'once' }, 'Allow once'),
    el('button', { type: 'button', class: 'cap', 'data-act': 'perm', 'data-choice': 'always' }, 'Always allow'),
    el('button', { type: 'button', class: 'cap rev', 'data-act': 'perm', 'data-choice': 'deny' }, 'Deny')));
  card.append(el('div', 'p-mode', 'Mode: ', el('b', '', MODE_NAMES[c.mode] || 'Manual'), noKeys(' — approvals required · change it in the composer (⇧Tab)')));
  return card;
}

/* ---------- empty state ---------- */

export function emptyState(c, { onSuggest }) {
  const meta = state.meta;
  const code = c && c.kind === 'code';
  const p = c && persona(c.personaId);
  const box = el('div', { id: 'empty' },
    el('div', 'orb', ''),
    el('h1', '', code ? `Code in ${c.project ? c.project.name : 'a project'}` : p ? p.name : 'What can I help with?'),
    el('p', 'lead', code ? 'Eden plans, reads, edits and runs commands in this project through Claude Code. Approvals show here.'
      : c && c.temp ? 'Temporary chat: nothing is saved. Each message is routed to the best model for it.'
      : 'Each message goes to the model that fits it best — routed by the rules and rated by Gemini — with the cost on every reply.'));
  const SUGG = code
    ? [['Explain this project', 'Read the layout and summarize how it fits together'], ['Find and fix a bug', 'Look for failing tests and fix the cause'], ['Plan a feature', noKeys('Switch to Plan mode first (⇧Tab)')], ['Review my changes', 'Check the uncommitted diff for problems']]
    : [['Draft a reply', 'Write a short, friendly email declining a meeting'], ['Build something', 'Make an HTML page with a bouncing ball animation'], ['Compare options', 'Make a table comparing three note-taking apps'], ['Research', 'What changed in web accessibility rules this year? (Research mode)']];
  box.append(el('div', 'sugg', ...SUGG.map(([t, s]) => el('button', { type: 'button', onclick: () => onSuggest(s, t) }, el('b', '', t), el('span', '', s)))));
  const hints = el('div', 'hints');
  if (state.metaError) hints.append(el('div', 'hint', `Can’t reach the Eden server: ${state.metaError}`));
  else if (meta) {
    const avail = (meta.providers || []).filter((x) => x.available);
    if (!avail.length) hints.append(el('div', 'hint', 'No model providers are available yet. Add an API key, or sign in to Claude Code.', el('button', { type: 'button', 'data-act': 'open-keys' }, 'Add a key')));
    else {
      const off = (meta.providers || []).filter((x) => !x.available);
      if (off.length) hints.append(el('div', 'hint', `Routing across ${avail.map((x) => x.name).join(', ')}. ${off.map((x) => `${x.name}: ${x.reason || 'unavailable'}`).join(' · ')}`, el('button', { type: 'button', 'data-act': 'open-keys' }, 'Keys')));
    }
    if (meta.classifier && meta.classifier.available === false) hints.append(el('div', 'hint', `Rules-only routing: ${meta.classifier.reason || 'Gemini isn’t available for ratings'}.`));
    if (code && meta.code && meta.code.available === false) hints.append(el('div', 'hint', `Code mode is unavailable: ${meta.code.reason || 'Claude Code not found'}.`));
  }
  if (hints.childNodes.length) box.append(hints);
  return box;
}
