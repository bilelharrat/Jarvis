// Eden Code in the page: the project picker (GET/POST /api/chat/projects), the inspector's
// Changes tab (GET /api/chat/code/changes: files + diff hunks, each one markable as
// reviewed or sent back with "ask to revert") and Plan tab (TodoWrite), the activity drawer.

import { $, el, ico, toast, noKeys, uid } from './util.js';
import { state, ui, saveConversation } from './state.js';
import { api } from './api.js';
import { todoList, hunkStates } from './render.js';
import { activity, sendMessage } from './chat.js';
import { locale } from './i18n.js';

let H = {};

/* ---------- Timed tasks for Code sessions ("resume this at 2 am", /later 2am) ---------- */
export const DEFAULT_CODE_RESUME = 'Carry on with my last request from where it was left, without repeating what is already done.';
const MAX_WAIT_SEC = 7 * 86400;

function resolveWallTime(now, hour, min, dayWord) {
  const d = new Date(now.getTime());
  d.setHours(hour, min, 0, 0);
  if (dayWord === 'tomorrow' || d.getTime() <= now.getTime()) d.setDate(d.getDate() + 1);
  if (d.getTime() - now.getTime() > MAX_WAIT_SEC * 1000) return null;
  return d;
}

function cleanTimedPrompt(rest) {
  let c = String(rest || '').trim();
  if (!c || /^(?:please\s+)?(?:resume|continue|carry\s+on|pick\s+(?:this\s+)?up|keep\s+going)(?:\s+(?:this(?:\s+(?:session|task|work))?|it|here|from\s+here|where\s+(?:we|you)\s+left\s+off))?\s*[.!]?$/i.test(c)) {
    return DEFAULT_CODE_RESUME;
  }
  c = c.replace(/^(?:please\s+)?(?:resume|continue|carry\s+on)(?:\s+this)?\s+(?:and|then)\s+/i, '').trim();
  return c || DEFAULT_CODE_RESUME;
}

/** Parse `<when> [task]` (for `/later <when> [task]` or `/schedule <when> [task]`) into `{ atMs, prompt, display }`. */
export function parseCodeWhenAndTask(raw, nowMs = Date.now()) {
  const s = String(raw || '').trim();
  if (!s) return null;
  const now = new Date(nowMs);

  const rel = /^(?:in\s+|after\s+)?(?:(\d+(?:\.\d+)?)\s*(?:hours?|hrs?|hr|h)\b\s*(?:(?:and\s+)?(\d+)\s*(?:minutes?|mins?|min|m)\b)?|(\d+(?:\.\d+)?)\s*(?:minutes?|mins?|min|m)\b|(\d+)\s*(?:seconds?|secs?|sec|s)\b)(?:\s*[:,;-]?\s*(.*))?$/is.exec(s);
  if (rel) {
    const h = Number(rel[1] || 0);
    const m = Number(rel[2] || rel[3] || 0);
    const sec = Number(rel[4] || 0);
    const deltaSec = h * 3600 + m * 60 + sec;
    if (deltaSec > 0 && deltaSec <= MAX_WAIT_SEC) {
      const prompt = cleanTimedPrompt(rel[5] || '');
      return { atMs: Math.round(nowMs + deltaSec * 1000), prompt, display: prompt === DEFAULT_CODE_RESUME ? 'Resume session' : prompt };
    }
  }

  const wordAt = /^(?:(tomorrow|tonight|today)\s+)?(?:at\s+)?(midnight|noon|midday)(?:\s+(tomorrow|tonight|today))?(?:\s*[:,;-]?\s*(.*))?$/is.exec(s);
  if (wordAt) {
    const dayWord = (wordAt[1] || wordAt[3] || '').toLowerCase();
    const hour = wordAt[2].toLowerCase() === 'midnight' ? 0 : 12;
    const target = resolveWallTime(now, hour, 0, dayWord);
    if (target) {
      const prompt = cleanTimedPrompt(wordAt[4] || '');
      return { atMs: target.getTime(), prompt, display: prompt === DEFAULT_CODE_RESUME ? 'Resume session' : prompt };
    }
  }

  const at = /^(?:(tomorrow|tonight|today)\s+)?(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)?(?:\s+(tomorrow|tonight|today))?(?:\s*[:,;-]?\s*(.*))?$/is.exec(s);
  if (at) {
    const dayWord = (at[1] || at[5] || '').toLowerCase();
    let hour = Number(at[2]);
    const min = Number(at[3] || 0);
    const ampm = (at[4] || '').toLowerCase().replace(/\./g, '');
    if (!ampm && at[3] === undefined && !/^(?:at|tomorrow|tonight|today)\b/i.test(s)) return null;
    if (min > 59) return null;
    if (ampm) {
      if (hour < 1 || hour > 12) return null;
      hour = ampm === 'am' ? (hour === 12 ? 0 : hour) : (hour === 12 ? 12 : hour + 12);
    } else if (hour > 23) return null;
    const target = resolveWallTime(now, hour, min, dayWord);
    if (target) {
      const prompt = cleanTimedPrompt(at[6] || '');
      return { atMs: target.getTime(), prompt, display: prompt === DEFAULT_CODE_RESUME ? 'Resume session' : prompt };
    }
  }
  return null;
}

/** Detect natural timed messages in a Code session, e.g. "resume this at 2 am", "at 2am run the tests". */
export function parseNaturalCodeTimedMessage(text, nowMs = Date.now()) {
  const s = String(text || '').trim();
  if (!s || s.startswith?.('/') || s.startsWith('/') || s.length > 1000 || s.includes('\n')) return null;

  const resumeFirst = /^\s*(?:please\s+)?(?:resume|continue|carry\s+on|pick\s+this\s+up|wake(?:\s+up)?|run\s+this|start\s+this)(?:\s+(?:this(?:\s+(?:session|task|work))?|it|here|from\s+here|where\s+(?:we|you)\s+left\s+off))?\s+((?:(?:tomorrow|tonight|today)\s+)?(?:at\s+(?:\d{1,2}(?::\d{2})?\s*(?:a\.?m\.?|p\.?m\.?)?|midnight|noon|midday)|\d{1,2}(?::\d{2})?\s*(?:a\.?m\.?|p\.?m\.?)|in\s+\d+(?:\.\d+)?\s*(?:hours?|hrs?|hr|h|minutes?|mins?|min|m|seconds?|secs?|sec|s)(?:\s+(?:and\s+)?\d+\s*(?:minutes?|mins?|min|m))?)(?:\s+(?:tomorrow|tonight|today))?)(?:\s*(?:,|;|:|\band\b|\bthen\b|\bto\b)\s*(.+)|\s*)?$/is.exec(s);
  if (resumeFirst) {
    const parsed = parseCodeWhenAndTask(resumeFirst[1].trim(), nowMs);
    if (parsed) {
      const prompt = cleanTimedPrompt(resumeFirst[2] || '');
      return { atMs: parsed.atMs, prompt, display: prompt === DEFAULT_CODE_RESUME ? 'Resume session' : prompt };
    }
  }

  const timeFirst = /^\s*((?:(?:tomorrow|tonight|today)\s+)?at\s+(?:\d{1,2}(?::\d{2})?\s*(?:a\.?m\.?|p\.?m\.?)|(?:\d{1,2}:\d{2})|midnight|noon|midday)(?:\s+(?:tomorrow|tonight|today))?|in\s+\d+(?:\.\d+)?\s*(?:hours?|hrs?|hr|h|minutes?|mins?|min|m|seconds?|secs?|sec|s)(?:\s+(?:and\s+)?\d+\s*(?:minutes?|mins?|min|m))?)(?:\s*(?:,|;|:|-|\bplease\b)\s*|\s+)(.+)$/is.exec(s);
  if (timeFirst) {
    const parsed = parseCodeWhenAndTask(timeFirst[1].trim(), nowMs);
    if (parsed && timeFirst[2].trim()) {
      const prompt = cleanTimedPrompt(timeFirst[2] || '');
      return { atMs: parsed.atMs, prompt, display: prompt === DEFAULT_CODE_RESUME ? 'Resume session' : prompt };
    }
  }
  return null;
}

export function formatScheduledTime(atMs) {
  const d = new Date(atMs);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  const timeStr = d.toLocaleTimeString(locale(), { hour: 'numeric', minute: '2-digit' });
  if (sameDay) return timeStr;
  const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  if (d.toDateString() === tomorrow.toDateString()) return `tomorrow ${timeStr}`;
  return d.toLocaleString(locale(), { weekday: 'short', hour: 'numeric', minute: '2-digit' });
}

export function scheduleCodeTask(c, { atMs, prompt, display }) {
  if (!c || c.kind !== 'code') return null;
  c.scheduled = Array.isArray(c.scheduled) ? c.scheduled : [];
  const item = {
    id: uid('sched'),
    at: atMs,
    text: prompt || DEFAULT_CODE_RESUME,
    display: display || (prompt === DEFAULT_CODE_RESUME ? 'Resume session' : prompt),
  };
  c.scheduled.push(item);
  c.scheduled.sort((a, b) => a.at - b.at);
  saveConversation(c);
  ui.renderComposer();
  ui.renderSidebar();
  toast(`Scheduled for ${formatScheduledTime(atMs)}: ${item.display}`);
  ensureScheduleLoop();
  return item;
}

export function runScheduledCodeTaskNow(c, id) {
  if (!c || !Array.isArray(c.scheduled)) return;
  const item = id ? c.scheduled.find((x) => x.id === id) : c.scheduled[0];
  if (!item) return;
  c.scheduled = c.scheduled.filter((x) => x !== item);
  saveConversation(c);
  ui.renderComposer();
  ui.renderSidebar();
  fireScheduledItem(c, item);
}

export function cancelScheduledCodeTask(c, id) {
  if (!c || !Array.isArray(c.scheduled)) return;
  const item = id ? c.scheduled.find((x) => x.id === id) : c.scheduled[0];
  if (!item) return;
  c.scheduled = c.scheduled.filter((x) => x !== item);
  saveConversation(c);
  ui.renderComposer();
  ui.renderSidebar();
  toast(`Cancelled timed task for ${formatScheduledTime(item.at)}`);
}

function fireScheduledItem(c, item) {
  const prev = state.current;
  if (state.streams.has(c.id)) {
    // Session is currently mid-step: queue it to run right after
    c.queue = c.queue || [];
    c.queue.push({ id: uid('q'), text: item.text, state: 'queued' });
    ui.renderComposer();
    return;
  }
  state.current = c;
  try {
    sendMessage(item.text, []);
  } finally {
    if (prev && prev !== c) {
      state.current = prev;
      ui.render();
    }
  }
}

let schedInterval = 0;
export function ensureScheduleLoop() {
  if (schedInterval) return;
  schedInterval = setInterval(() => {
    const now = Date.now();
    let anyLeft = false;
    for (const c of state.convs) {
      if (!c || c.kind !== 'code' || !Array.isArray(c.scheduled) || !c.scheduled.length) continue;
      const due = c.scheduled.filter((x) => x.at <= now);
      if (due.length) {
        c.scheduled = c.scheduled.filter((x) => x.at > now);
        saveConversation(c);
        for (const item of due) fireScheduledItem(c, item);
        ui.renderComposer();
        ui.renderSidebar();
      }
      if (c.scheduled.length) anyLeft = true;
    }
    if (anyLeft && state.current && state.current.kind === 'code' && Array.isArray(state.current.scheduled) && state.current.scheduled.length) {
      ui.renderComposer();
    }
    if (!anyLeft) {
      clearInterval(schedInterval);
      schedInterval = 0;
    }
  }, 1000);
}

export function scheduleTaskDialog(c = state.current, prefill = '') {
  if (!c || c.kind !== 'code') {
    toast('Open a Code session first to schedule a timed coding task.');
    return;
  }
  const body = $('dlgBody');
  const whenInput = el('input', { type: 'text', value: '2:00 am', placeholder: 'e.g. 2:00 am, in 30m, tomorrow 9am', 'aria-label': 'When to run' });
  const promptInput = el('textarea', { rows: '3', placeholder: 'Leave blank to resume this session where it left off, or type what to do…', 'aria-label': 'Task instructions' });
  promptInput.value = prefill;
  const err = el('div', { class: 'muted', 'aria-live': 'polite' });
  const presets = el('div', { style: { display: 'flex', flexWrap: 'wrap', gap: '6px', marginBottom: '10px' } },
    ...[['In 30m', 'in 30m'], ['In 1h', 'in 1h'], ['2:00 AM', '2:00 am'], ['6:00 AM', '6:00 am'], ['9:00 AM', '9:00 am']].map(([lbl, val]) =>
      el('button', { type: 'button', class: 'cap', onclick: () => { whenInput.value = val; whenInput.focus(); } }, lbl)));
  const submit = () => {
    const parsed = parseCodeWhenAndTask(whenInput.value.trim());
    if (!parsed) {
      err.textContent = 'Enter a time like “2am”, “in 45m”, or “tomorrow 9:00am”.';
      whenInput.focus();
      return;
    }
    const custom = promptInput.value.trim();
    const prompt = custom ? cleanTimedPrompt(custom) : parsed.prompt;
    const display = custom || parsed.display;
    H.closeDialog();
    scheduleCodeTask(c, { atMs: parsed.atMs, prompt, display });
  };
  whenInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); submit(); } });
  body.replaceChildren(
    el('p', 'sp-note', `Schedule a timed task for ${c.project ? c.project.name : 'this Code session'}. Leave the task blank to resume from where it left off.`),
    presets,
    el('div', 'field', 'When', whenInput),
    el('div', { class: 'field', style: { marginTop: '10px' } }, 'What to do (optional)', promptInput),
    err,
    el('div', { class: 'dlg-acts', style: { marginTop: '14px' } },
      el('button', { type: 'button', class: 'btn', onclick: () => H.closeDialog() }, 'Cancel'),
      el('button', { type: 'button', class: 'btn primary', onclick: submit }, 'Schedule')),
  );
  H.openDialog('Schedule timed task', body);
  setTimeout(() => { whenInput.focus(); whenInput.select(); }, 40);
}

export async function loadProjects() {
  try {
    state.projects = await api.projects();
    state.projectsError = null;
  } catch (e) {
    state.projects = [];
    state.projectsError = e.message;
    // On askeden.com without a Mac (503/404), avoid logging console noise
    if (e.status !== 503 && e.status !== 404) {
      console.warn('Projects not available:', e.message);
    }
  }
  return state.projects;
}

export function projectPicker() {
  const body = $('dlgBody');
  const list = el('div', { role: 'list' });
  const err = el('div', { class: 'muted', 'aria-live': 'polite' });
  const path = el('input', { type: 'text', placeholder: '/Users/you/code/project', 'aria-label': 'Project folder path', spellcheck: 'false' });
  const name = el('input', { type: 'text', placeholder: 'my-app', 'aria-label': 'New project name', spellcheck: 'false', maxlength: '80' });
  const start = (p) => { H.closeDialog(); H.newCodeSession(p); };
  const draw = () => {
    if (!state.projects.length) list.replaceChildren(el('div', 'muted', state.projectsError ? `Couldn’t load projects: ${state.projectsError}` : 'No projects yet: make one or choose a folder above.'));
    else list.replaceChildren(...state.projects.map((p) => el('button', { type: 'button', class: 'proj-row', role: 'listitem', onclick: () => start(p) },
      ico('folder'), el('div', { class: 'grow', 'data-no-i18n': '' }, el('b', '', p.name), el('span', '', `${p.path}${p.branch ? ` · ${p.branch}` : ''}`)))));
  };
  // Made or chosen: straight into a session on it.
  const opened = (res) => {
    state.projects = res.projects || state.projects;
    const p = res.added && state.projects.find((x) => x.path === res.added);
    if (p) start(p); else { err.textContent = ''; draw(); }
  };
  const create = async () => {
    const v = name.value.trim();
    if (!v) { name.focus(); return; }
    err.textContent = 'Making the folder…';
    try { opened(await api.createProject(v)); toast(`Made ~/Eden Projects/${v}`); }
    catch (e) { err.textContent = e.message; }
  };
  const pick = async () => {
    err.textContent = 'Choose a folder in the window that opened…';
    try { opened(await api.pickProject()); }
    catch (e) { err.textContent = e.message; }
  };
  const add = async () => {
    const v = path.value.trim();
    if (!v) { path.focus(); return; }
    err.textContent = 'Adding…';
    try { state.projects = await api.addProject(v); err.textContent = ''; path.value = ''; draw(); toast('Project added'); }
    catch (e) { err.textContent = e.message; }
  };
  name.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); create(); } });
  path.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); add(); } });
  const code = state.meta && state.meta.code;
  const more = el('details', 'proj-path', el('summary', '', 'Or paste a folder’s path'),
    el('div', 'key-edit', path, el('button', { type: 'button', class: 'btn', onclick: add }, 'Add')));
  // (no null in the list: the page would print it, as the word "null")
  body.replaceChildren(...[
    code && code.available === false ? el('div', { class: 'sp-warn', style: { marginBottom: '10px' } }, el('b', '', 'Code mode is unavailable'), code.reason || 'Claude Code wasn’t found.') : null,
    el('div', 'proj-new',
      el('div', 'field', 'New project', el('div', 'key-edit', name, el('button', { type: 'button', class: 'btn primary', onclick: create }, 'Create'))),
      el('button', { type: 'button', class: 'btn proj-pick', onclick: pick }, ico('folder'), 'Choose a folder…')),
    el('p', 'sp-note', 'New projects go in ~/Eden Projects. Or open one you have:'),
    el('div', { style: { margin: '4px 0 10px' } }, list),
    more,
    err,
  ].filter(Boolean));
  H.openDialog('New code session', body);
  draw();
  loadProjects().then(draw);
  setTimeout(() => name.focus(), 50);
}

/* ---------- Plan tab ---------- */
export function renderPlan() {
  const c = state.current;
  const card = $('planCard');
  if (!c || c.kind !== 'code') { card.replaceChildren(el('div', 'muted', 'In a Code session, the agent’s to-do list (TodoWrite) shows here and checks off live.')); return; }
  if (!c.todos || !c.todos.length) { card.replaceChildren(el('div', 'muted', noKeys('No plan yet. Ask for something bigger, or use Plan mode (⇧Tab), and the to-dos show here.'))); return; }
  const done = c.todos.filter((t) => t.status === 'completed').length;
  card.replaceChildren(el('div', { class: 'muted', style: { marginBottom: '4px' } }, `${done} of ${c.todos.length} done`), todoList(c.todos));
}

/* ---------- Changes tab ---------- */
export function parseDiff(diff) {
  const files = [];
  let f = null, h = null;
  for (const line of String(diff || '').split('\n')) {
    const m = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
    if (m) { f = { path: m[2], hunks: [] }; files.push(f); h = null; continue; }
    if (!f) continue;
    if (line.startsWith('@@')) { h = { header: line, lines: [] }; f.hunks.push(h); continue; }
    if (h && (line.startsWith('+') || line.startsWith('-') || line.startsWith(' ') || line === '\\ No newline at end of file')) h.lines.push(line);
  }
  return files;
}

let changes = null, loadingChanges = false, openFiles = new Set();
export async function loadChanges(quiet) {
  const c = state.current;
  const card = $('chgCard');
  if (!c || c.kind !== 'code' || !c.project) { changes = null; card.replaceChildren(el('div', 'muted', 'Open a Code session to see its project’s uncommitted changes.')); return; }
  if (loadingChanges) return;
  loadingChanges = true;
  if (!quiet || !changes) card.replaceChildren(el('div', 'muted', 'Reading git status…'));
  try {
    const r = await api.changes(c.project.path);
    if (state.current !== c) return;
    changes = { ...r, parsed: parseDiff(r.diff), conv: c };
    if (r.branch && c.project.branch !== r.branch) { c.project.branch = r.branch; saveConversation(c); H.renderTitle(); H.renderSidebar(); }
    drawChanges();
  } catch (e) {
    card.replaceChildren(el('div', 'muted', `Couldn’t read changes: ${e.message}`));
  } finally { loadingChanges = false; }
}

const hunkKey = (file, h) => `${file}|${h.header}`;
function drawChanges() {
  const card = $('chgCard');
  const c = changes && changes.conv;
  if (!c) return;
  c.hunks = c.hunks || {};
  const files = changes.files || [];
  if (!files.length) { card.replaceChildren(el('div', 'muted', `No uncommitted changes${changes.branch ? ` on ${changes.branch}` : ''}.`)); return; }
  const parsed = changes.parsed;
  const allHunks = parsed.flatMap((f) => f.hunks.map((h) => hunkKey(f.path, h)));
  const pending = allHunks.filter((k) => !c.hunks[k] || c.hunks[k] === 'pending').length;
  const add = files.reduce((n, f) => n + (f.added || 0), 0), del = files.reduce((n, f) => n + (f.removed || 0), 0);
  const kids = [el('div', 'chg-head', el('span', '', `${changes.branch ? `${changes.branch} · ` : ''}${files.length} file${files.length === 1 ? '' : 's'} · +${add} −${del}`),
    allHunks.length ? el('button', { type: 'button', class: 'cap ok', 'data-chg': 'all', disabled: !pending }, pending ? `Mark all reviewed (${pending})` : 'All reviewed') : null)];
  for (const f of files) {
    const pf = parsed.find((x) => x.path === f.path);
    const open = openFiles.has(f.path);
    kids.push(el('button', { type: 'button', class: 'chg-row', 'data-chg': 'file', 'data-path': f.path, 'aria-expanded': String(open) },
      el('span', 'chg-st', f.status || 'M'), el('div', { class: 'grow', 'data-no-i18n': '' }, el('b', '', f.path.split('/').pop()), el('span', '', f.path)),
      el('span', 'chg-n', el('span', 'a', `+${f.added || 0}`), ' ', el('span', 'd', `−${f.removed || 0}`))));
    if (open && pf) {
      if (!pf.hunks.length) kids.push(el('div', 'muted', 'No text diff (new, binary or untracked file).'));
      for (const h of pf.hunks) {
        const key = hunkKey(f.path, h);
        const st = c.hunks[key] || 'pending';
        const pre = el('pre');
        for (const l of h.lines.slice(0, 300)) pre.append(el('span', l[0] === '+' ? 'al' : l[0] === '-' ? 'dl' : 'cl', l), '\n');
        kids.push(el('div', { class: 'chg-hunk', 'data-state': st, 'data-key': key },
          el('div', 'hb', el('span', 'h', h.header), hunkStates(),
            el('span', 'hunk-actions',
              el('button', { type: 'button', class: 'cap ok', 'data-chg': 'hunk', 'data-state': 'reviewed' }, 'Reviewed'),
              el('button', { type: 'button', class: 'cap rev', 'data-chg': 'hunk', 'data-state': 'revert' }, 'Ask to revert'))),
          el('div', 'diff', pre)));
      }
    }
  }
  card.replaceChildren(...kids);
}

function hunkText(key) {
  const [file, header] = [key.slice(0, key.indexOf('|')), key.slice(key.indexOf('|') + 1)];
  const f = changes.parsed.find((x) => x.path === file);
  const h = f && f.hunks.find((x) => x.header === header);
  return { file, text: h ? [h.header, ...h.lines].join('\n') : '' };
}

export function setHunk(c, key, st, { quiet } = {}) {
  c.hunks = c.hunks || {};
  c.hunks[key] = st;
  saveConversation(c);
  if (!quiet) toast(st === 'reviewed' ? 'Marked reviewed' : st === 'revert' ? 'Revert request is in the composer' : 'Back to pending');
}

export function initCode(handlers) {
  H = handlers;
  $('btnChgRefresh').addEventListener('click', () => loadChanges());
  $('chgCard').addEventListener('click', (e) => {
    const b = e.target.closest('[data-chg], [data-act="hunk"]');
    if (!b || !changes) return;
    const c = changes.conv;
    const kind = b.dataset.chg || 'hunk';
    if (kind === 'file') { const p = b.dataset.path; if (openFiles.has(p)) openFiles.delete(p); else openFiles.add(p); drawChanges(); return; }
    if (kind === 'all') {
      for (const f of changes.parsed) for (const h of f.hunks) { const k = hunkKey(f.path, h); if (!c.hunks[k] || c.hunks[k] === 'pending') c.hunks[k] = 'reviewed'; }
      saveConversation(c); drawChanges(); toast('All hunks marked reviewed'); return;
    }
    const wrap = b.closest('.chg-hunk');
    if (!wrap) return;
    const key = wrap.dataset.key;
    const st = b.dataset.state;
    setHunk(c, key, st);
    if (st === 'revert') { const { file, text } = hunkText(key); H.quote(`Revert this change in ${file}:\n\`\`\`diff\n${text}\n\`\`\`\n`); }
    drawChanges();
  });
}

/* ---------- the activity drawer (⌘J) ---------- */
export function renderActivity() {
  const c = state.current;
  const box = $('drBody');
  const lines = (c && activity.get(c.id)) || [];
  if (!lines.length) { box.replaceChildren(el('span', 'p', c && c.kind === 'code' ? 'No tool activity yet in this session.' : 'Tool activity shows here during Code sessions.')); return; }
  box.replaceChildren(...lines.flatMap((l) => [el('span', { class: l.k, 'data-no-i18n': '' }, l.t), '\n'])); // tool calls and their output: never translated
  box.scrollTop = box.scrollHeight;
}
export function toggleDrawer(force) {
  const d = $('drawer');
  const open = force !== undefined ? force : !d.classList.contains('open');
  d.classList.toggle('open', open);
  if (open) renderActivity();
  return open;
}
