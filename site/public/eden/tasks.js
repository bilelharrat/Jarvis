// Background tasks on the page (ROADMAP G3): the Tasks panel — make a task from a sentence (the
// model proposes it, you check and confirm it), see what each one is doing (status, last run,
// what it cost, what it's waiting for), pause, run now, delete — and the approval card that
// shows up anywhere in Eden when a task waits for you. Approve and Deny send only the
// approval's id: the server runs exactly what it holds, and nothing is sent without that tap.
//
// The server runs the tasks: askeden.com in the account, with the Mac off and this page closed
// (JARVIS V1 site/src/accounts/tasks.js; it also pushes to your iPhone), or Eden's server on the
// Mac while it runs (src/chat/tasks.ts). Both answer GET /api/chat/tasks and POST /api/chat/tasks
// { action, args } (docs/chat-api.md "Tasks"); ?mock=1 answers from tasksMock() below.

import { el, ico, toast } from './util.js';
import { state, ui } from './state.js';
import { getJSON, postJSON } from './api.js';

const POLL_MS = 60_000;
const KINDS = [['gmail', 'New email'], ['time', 'A time'], ['calendar', 'A meeting']];
const REPEATS = [['none', 'Once'], ['hourly', 'Every hour'], ['daily', 'Every day'], ['weekdays', 'Weekdays'], ['weekly', 'Every week']];
const ACTION_WORDS = { notify: 'Tell me', draft: 'Write Gmail drafts', send: 'Ask me to send them', calendar: 'Ask me to add events' };
const STATUS = { active: ['Active', 'ok'], paused: ['Paused', 'warn'], done: ['Done', ''], expired: ['Ended', ''] };
const OUTCOME = { acted: 'Acted', nothing: 'Nothing to do', skipped: 'Skipped', error: 'Didn’t work' };

const S = { data: null, error: null, draft: null, proposing: false, saving: false, open: false, timer: null, dismissed: new Set() };
let H = {};
let sheet = null;
let card = null;
let returnFocus = null;

const call = (action, args = {}) => postJSON('/api/chat/tasks', { action, args });
const tz = () => new Date().getTimezoneOffset();
// The IANA zone ("Europe/Paris") keeps repeating tasks on local time across daylight saving; tz stays for older servers.
const zone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;
const money = (n, d = 3) => (typeof n === 'number' && Number.isFinite(n) ? `$${n < 0.01 && n > 0 ? n.toFixed(d) : n.toFixed(2)}` : '—');
const hosted = () => Boolean((S.data && S.data.hosted) || (state.meta && state.meta.hosted));

function ago(ms) {
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return new Date(ms).toLocaleDateString([], { month: 'short', day: 'numeric' });
}
function when(ms) {
  if (!ms) return '';
  const d = new Date(ms);
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  return sameDay ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : d.toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}
/** ISO → the value of an <input type=datetime-local> (local time). */
function localInput(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}
function triggerText(t) {
  if (!t) return '';
  if (t.kind === 'gmail') return `Email matching “${t.query}”`;
  if (t.kind === 'calendar') return `${t.before_min} min before ${t.query ? `meetings matching “${t.query}”` : 'each meeting'}`;
  const r = REPEATS.find(([k]) => k === t.repeat);
  return `${r && t.repeat !== 'none' ? `${r[1]}, from ` : ''}${when(Date.parse(t.at))}`;
}

/* ---------------- data ---------------- */

export function pendingApprovals() {
  return S.data ? S.data.approvals.filter((a) => a.status === 'pending').length : 0;
}

async function refresh({ quiet = false } = {}) {
  try {
    const before = pendingApprovals();
    S.data = await getJSON('/api/chat/tasks');
    S.error = null;
    if (pendingApprovals() !== before) ui.renderSidebar();
  } catch (e) {
    if (e.status === 403) S.data = null; // acting for someone (acting.js): tasks stay with this person's own account
    if (!quiet) S.error = e.message;
  }
  paint();
  paintCard();
}

/* ---------------- the panel ---------------- */

function buildSheet() {
  sheet = el('div', { class: 'sheet tk-sheet', id: 'tasksSheet', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'tkTitle' },
    el('div', 'sheet-card glass tk-card',
      el('div', 'sheet-head', ico('list'), el('h2', { id: 'tkTitle' }, 'Tasks'),
        el('button', { type: 'button', class: 'iconbtn', 'aria-label': 'Close tasks', onclick: closeTasks }, ico('x'))),
      el('div', { class: 'sheet-body tk-body', id: 'tkBody' })));
  sheet.addEventListener('click', (e) => { if (e.target === sheet) closeTasks(); });
  sheet.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.stopPropagation(); e.preventDefault(); if (S.draft) { S.draft = null; paint(); } else closeTasks(); return; }
    if (e.key !== 'Tab') return;
    const f = [...sheet.querySelectorAll('button:not([disabled]), input, textarea, select, summary, a[href]')].filter((x) => x.offsetParent !== null);
    if (!f.length) return;
    if (e.shiftKey && document.activeElement === f[0]) { e.preventDefault(); f.at(-1).focus(); }
    else if (!e.shiftKey && document.activeElement === f.at(-1)) { e.preventDefault(); f[0].focus(); }
  });
  document.body.append(sheet);
}

/** Opens the Tasks panel; `prefill` (a task input) goes straight to the confirm form. */
export function openTasks({ prefill = null } = {}) {
  if (!sheet) buildSheet();
  if (H.beforeOpen) H.beforeOpen();
  returnFocus = document.activeElement;
  S.open = true;
  if (prefill) S.draft = { task: prefill, problems: [] };
  sheet.classList.add('open');
  paint();
  refresh();
  requestAnimationFrame(() => { const f = sheet.querySelector(S.draft ? '.tk-form input' : '#tkAsk') || sheet.querySelector('button'); if (f) f.focus(); });
}
export function closeTasks() {
  if (!sheet || !sheet.classList.contains('open')) return false;
  sheet.classList.remove('open');
  S.open = false;
  S.draft = null;
  const back = returnFocus;
  returnFocus = null;
  if (back && back !== document.body && document.contains(back)) back.focus();
  return true;
}
export const tasksOpen = () => Boolean(sheet && sheet.classList.contains('open'));

function paint() {
  if (!sheet || !S.open) return;
  const body = sheet.querySelector('#tkBody');
  const keepScroll = body.scrollTop;
  const parts = [];
  if (S.draft) parts.push(confirmForm(S.draft));
  else parts.push(asker());
  if (S.error) parts.push(el('div', 'sp-warn', el('b', '', 'Couldn’t read your tasks'), S.error));
  const d = S.data;
  if (d) {
    const pending = d.approvals.filter((a) => a.status === 'pending');
    if (pending.length) parts.push(el('section', 'tk-sec', el('h3', '', `Waiting for you (${pending.length})`), ...pending.map((a) => approvalCard(a))));
    parts.push(el('section', 'tk-sec', el('h3', '', 'Your tasks'),
      d.tasks.length ? el('div', 'tk-list', ...d.tasks.map(taskRow)) : el('p', 'muted', 'No tasks yet. Describe one above: “Tell me when the lawyer replies, then draft an answer.”')));
    const recent = d.approvals.filter((a) => a.status !== 'pending').slice(0, 6);
    if (recent.length) parts.push(el('details', 'tk-recent', el('summary', '', `Recent decisions (${recent.length})`), ...recent.map((a) => el('div', 'tk-done-row', el('span', `tk-pill ${a.status === 'approved' ? 'ok' : a.status === 'failed' ? 'bad' : ''}`, a.status), el('span', 'grow', a.summary), a.result || a.error ? el('span', 'muted', a.result || a.error) : null))));
  } else if (!S.error) parts.push(el('div', 'muted', 'Loading your tasks…'));
  parts.push(el('p', 'sp-note', hosted()
    ? 'Tasks run in your askeden.com account, with your Mac off and this page closed. Each run uses a small model on your included AI, within the task’s budget. Eden writes drafts on its own; it sends email or changes your calendar only after you approve, here or from the notification on your iPhone.'
    : 'Tasks run while Eden is running on this Mac. Each run uses Claude Haiku (your API key or Claude Code), within the task’s budget. Eden writes drafts on its own; it sends email or changes your calendar only after you approve here. Notes reach your iPhone through Jarvis.'));
  body.replaceChildren(...parts);
  body.scrollTop = keepScroll;
}

function asker() {
  const ta = el('textarea', { id: 'tkAsk', rows: '2', maxlength: '1000', placeholder: 'Describe a task: “Tell me when the lawyer replies, then draft an answer.”', 'aria-label': 'Describe a task' });
  const go = el('button', { type: 'button', class: 'btn primary', disabled: S.proposing ? true : null }, S.proposing ? 'Asking Eden…' : 'Set it up');
  const propose = async () => {
    const text = ta.value.trim();
    if (text.length < 3) { ta.focus(); toast('Describe the task in a sentence'); return; }
    S.proposing = true;
    paint();
    try {
      const r = await call('propose', { text, tz: tz(), zone: zone() });
      S.draft = { task: r.proposal, problems: r.problems || [], cost: r.costUSD };
    } catch (e) {
      toast(`Couldn’t set it up: ${e.message}`);
    } finally {
      S.proposing = false;
      paint();
      requestAnimationFrame(() => { const f = sheet.querySelector('.tk-form input'); if (f) f.focus(); });
    }
  };
  ta.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); propose(); } });
  go.addEventListener('click', propose);
  return el('section', 'tk-new icard',
    el('div', 'tk-new-row', ta, go),
    el('div', 'tk-new-foot', el('span', 'muted', 'Eden proposes the task; you check it before anything starts.'),
      el('button', { type: 'button', class: 'cap', onclick: () => { S.draft = { task: blankTask(), problems: [] }; paint(); } }, 'Set up by hand')));
}

function blankTask() {
  return { title: '', trigger: { kind: 'gmail', query: '' }, every_min: 30, plan: '', actions: ['notify'], budget: { run_usd: 0.05, month_usd: 1 }, expires: new Date(Date.now() + 30 * 86400_000).toISOString() };
}

const field = (label, input, note) => el('label', 'field tk-field', el('span', '', label), input, note ? el('span', 'tk-hint', note) : null);

function confirmForm(draft) {
  const t = structuredClone(draft.task || blankTask());
  t.trigger = t.trigger || { kind: 'gmail', query: '' };
  const g = (S.data && S.data.google) || { gmail: true, calendar: true };
  const form = el('form', { class: 'tk-form icard', novalidate: true });
  const name = el('input', { type: 'text', maxlength: '80', value: t.title || '', placeholder: 'A short name', 'aria-label': 'Task name' });
  const kindSel = el('div', { class: 'tk-kinds', role: 'radiogroup', 'aria-label': 'What starts it' });
  const trig = el('div', 'tk-trig');
  const every = el('input', { type: 'number', min: '15', max: '1440', step: '5', value: String(t.every_min || 30), 'aria-label': 'Check every (minutes)' });
  const everyField = field('Check every (minutes, 15 at least)', every);
  const drawTrigger = () => {
    kindSel.replaceChildren(...KINDS.map(([k, label]) => el('button', { type: 'button', role: 'radio', 'aria-checked': String(t.trigger.kind === k), class: `cap${t.trigger.kind === k ? ' primary' : ''}`, onclick: () => { save(); t.trigger = k === 'gmail' ? { kind: 'gmail', query: '' } : k === 'calendar' ? { kind: 'calendar', query: '', before_min: 30 } : { kind: 'time', at: new Date(Date.now() + 3600_000).toISOString(), repeat: 'none' }; drawTrigger(); } }, label)));
    everyField.hidden = t.trigger.kind === 'time';
    if (t.trigger.kind === 'gmail') {
      const q = el('input', { type: 'text', maxlength: '300', value: t.trigger.query || '', placeholder: 'from:lawyer@firm.com', 'data-k': 'query', 'aria-label': 'Gmail search' });
      trig.replaceChildren(field('Email that matches (a Gmail search)', q, g.gmail ? null : 'Gmail isn’t connected: connect it in Mail first, or the task waits.'));
    } else if (t.trigger.kind === 'calendar') {
      const q = el('input', { type: 'text', maxlength: '200', value: t.trigger.query || '', placeholder: 'acme (empty: every meeting)', 'data-k': 'query', 'aria-label': 'Meetings matching' });
      const m = el('input', { type: 'number', min: '5', max: '240', value: String(t.trigger.before_min || 30), 'data-k': 'before_min', 'aria-label': 'Minutes before' });
      trig.replaceChildren(el('div', 'tk-two', field('Meetings matching', q, g.calendar ? null : 'Google Calendar isn’t connected: connect it in Calendar first.'), field('Minutes before', m)));
    } else {
      const at = el('input', { type: 'datetime-local', value: localInput(t.trigger.at), 'data-k': 'at', 'aria-label': 'When' });
      const rep = el('select', { 'data-k': 'repeat', 'aria-label': 'Repeat' }, ...REPEATS.map(([k, label]) => { const o = el('option', { value: k }, label); if (k === (t.trigger.repeat || 'none')) o.selected = true; return o; }));
      trig.replaceChildren(el('div', 'tk-two', field('When', at), field('Repeat', rep)));
    }
  };
  const plan = el('textarea', { rows: '3', maxlength: '2000', placeholder: 'What should Eden do each time?', 'aria-label': 'What to do' });
  plan.value = t.plan || '';
  const boxes = Object.entries(ACTION_WORDS).map(([k, label]) => {
    const cb = el('input', { type: 'checkbox', value: k, 'aria-label': label });
    cb.checked = (t.actions || []).includes(k);
    cb.addEventListener('change', () => {
      if (k === 'send' && cb.checked) boxes.find((b) => b.firstChild.value === 'draft').firstChild.checked = true;
      if (k === 'draft' && !cb.checked) boxes.find((b) => b.firstChild.value === 'send').firstChild.checked = false;
    });
    return el('label', 'tk-check', cb, el('span', '', label));
  });
  const run = el('input', { type: 'number', min: '0.005', max: '0.5', step: '0.005', value: String((t.budget && t.budget.run_usd) ?? 0.05), 'aria-label': 'Budget per run (dollars)' });
  const month = el('input', { type: 'number', min: '0.05', max: '20', step: '0.05', value: String((t.budget && t.budget.month_usd) ?? 1), 'aria-label': 'Budget per month (dollars)' });
  const ends = el('input', { type: 'date', value: (t.expires || '').slice(0, 10), 'aria-label': 'Ends on' });
  function save() {
    t.title = name.value.trim();
    for (const inp of trig.querySelectorAll('[data-k]')) {
      const k = inp.dataset.k;
      if (k === 'at') t.trigger.at = inp.value ? new Date(inp.value).toISOString() : '';
      else if (k === 'before_min') t.trigger.before_min = Number(inp.value);
      else t.trigger[k] = inp.value;
    }
    t.every_min = Number(every.value);
    t.plan = plan.value.trim();
    t.actions = boxes.map((b) => b.firstChild).filter((cb) => cb.checked).map((cb) => cb.value);
    t.budget = { run_usd: Number(run.value), month_usd: Number(month.value) };
    if (ends.value) t.expires = new Date(`${ends.value}T23:59:00`).toISOString();
    draft.task = t;
  }
  drawTrigger();
  const problems = (draft.problems || []).length ? el('div', 'sp-warn tk-problems', el('b', '', 'Check this first'), ...draft.problems.map((p) => el('div', '', p))) : null;
  const create = el('button', { type: 'submit', class: 'btn primary', disabled: S.saving ? true : null }, S.saving ? 'Starting…' : 'Start task');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    save();
    if (!t.actions.length) { toast('Pick at least one thing Eden may do'); return; }
    S.saving = true;
    create.disabled = true;
    try {
      const { workflow, ...task } = t;
      await call('create', { task: { ...task, ...(workflow ? { workflow } : {}) }, confirm: true, tz: tz(), zone: zone() });
      S.draft = null;
      toast('Task started');
      await refresh();
    } catch (err) {
      draft.problems = [err.message];
      toast(`Couldn’t start it: ${err.message}`);
    } finally {
      S.saving = false;
      paint();
    }
  });
  form.append(
    el('h3', 'tk-form-h', draft.cost ? `Eden’s proposal (${money(draft.cost, 4)})` : 'New task'),
    problems,
    field('Name', name),
    el('div', 'field tk-field', el('span', '', 'What starts it'), kindSel),
    trig,
    everyField,
    field('What to do (your words: the only instructions Eden follows)', plan),
    el('div', 'field tk-field', el('span', '', 'Eden may'), el('div', 'tk-checks', ...boxes)),
    el('div', 'tk-two', field('Budget per run ($)', run), field('Budget per month ($)', month)),
    field('Ends on (90 days at most)', ends),
    el('p', 'tk-hint', 'Sending email and changing your calendar always wait for your approval. Email the task reads is treated as data: instructions inside it are never followed.'),
    el('div', 'dlg-acts', el('button', { type: 'button', class: 'btn', onclick: () => { S.draft = null; paint(); } }, 'Cancel'), create));
  return form;
}

function approvalCard(a, { compact = false } = {}) {
  const busy = { v: false };
  const act = async (approve, btns) => {
    if (busy.v) return;
    busy.v = true;
    btns.forEach((b) => { b.disabled = true; });
    try {
      const r = await call(approve ? 'approve' : 'deny', approve ? { id: a.id, confirm: true } : { id: a.id });
      const out = r.approval;
      toast(out.status === 'approved' ? (out.result || 'Done') : out.status === 'denied' ? 'Denied: nothing was sent' : `It didn’t work: ${out.error || out.status}`);
    } catch (e) {
      toast(`Couldn’t ${approve ? 'approve' : 'deny'} it: ${e.message}`);
    } finally {
      busy.v = false;
      await refresh();
    }
  };
  const approveBtn = el('button', { type: 'button', class: 'btn primary' }, a.kind === 'send' ? 'Send' : 'Add to calendar');
  const denyBtn = el('button', { type: 'button', class: 'btn' }, 'Deny');
  approveBtn.addEventListener('click', () => act(true, [approveBtn, denyBtn]));
  denyBtn.addEventListener('click', () => act(false, [approveBtn, denyBtn]));
  const details = [];
  if (a.kind === 'send') {
    details.push(['To', [...(a.to || []), ...(a.cc || [])].join(', ') || (a.details || []).find((d) => d.label === 'To')?.value || ''], ['Subject', a.subject || '']);
    if (a.preview && !compact) details.push(['Message', a.preview]);
  } else if (a.event) {
    details.push(['Event', a.event.title], ['Starts', when(Date.parse(a.event.start))], ['Ends', when(Date.parse(a.event.end))]);
    if (a.event.location) details.push(['Where', a.event.location]);
  }
  for (const d of a.details || []) if (!details.some(([k]) => k === d.label) && !compact) details.push([d.label, d.value]);
  const flags = a.flags || [];
  return el('div', { class: `tk-appr${compact ? ' compact' : ''}`, role: 'group', 'aria-label': `Approval: ${a.summary}` },
    el('div', 'tk-appr-h', ico(a.kind === 'send' ? 'send' : 'cal', 15), el('b', '', a.summary)),
    el('div', 'tk-appr-from', `From your task “${a.task_title}” · ${ago(a.created)}`),
    el('dl', 'tk-appr-d', ...details.filter(([, v]) => v).flatMap(([k, v]) => [el('dt', '', k), el('dd', '', v)])),
    flags.length ? el('div', 'tk-flags', ...flags.map((f) => el('div', '', ico('lock', 12), f))) : null,
    el('div', 'tk-appr-acts', denyBtn, approveBtn));
}

function taskRow(t) {
  const [label, cls] = STATUS[t.status] || [t.status, ''];
  const r = t.last_run;
  const busy = { v: false };
  const act = async (action, words) => {
    if (busy.v) return;
    busy.v = true;
    try { await call(action, { id: t.id }); toast(words); } catch (e) { toast(e.message); } finally { busy.v = false; await refresh(); }
  };
  const acts = [];
  if (t.status === 'active') acts.push(el('button', { type: 'button', class: 'cap', onclick: () => act('run', 'Running it now') }, 'Run now'), el('button', { type: 'button', class: 'cap', onclick: () => act('pause', 'Paused') }, 'Pause'));
  if (t.status === 'paused') acts.push(el('button', { type: 'button', class: 'cap primary', onclick: () => act('resume', 'Resumed') }, 'Resume'));
  acts.push(el('button', { type: 'button', class: 'cap rev', onclick: () => { if (window.confirm(`Delete the task “${t.title}”? Its pending approvals are cancelled.`)) act('delete', 'Task deleted'); } }, 'Delete'));
  const runs = (t.runs || []).map((x) => el('li', '', el('span', `tk-pill ${x.outcome === 'acted' ? 'ok' : x.outcome === 'error' ? 'bad' : x.outcome === 'skipped' ? 'warn' : ''}`, OUTCOME[x.outcome] || x.outcome),
    el('span', 'tk-run-t', `${when(x.at)}${x.cost_usd ? ` · ${money(x.cost_usd, 4)}` : ''}`),
    el('div', 'tk-run-s', x.error || x.summary || ''),
    (x.effects || []).length ? el('div', 'tk-run-e', x.effects.map(effectText).join(' · ')) : null));
  return el('article', { class: 'tk-task', 'aria-label': t.title },
    el('div', 'tk-task-h', el('b', 'grow', t.title), el('span', `tk-pill ${cls}`, label)),
    el('div', 'tk-task-m', triggerText(t.trigger), t.trigger.kind !== 'time' ? ` · every ${t.every_min} min` : ''),
    el('div', 'tk-task-m', el('span', '', `This month ${money(t.spent ? t.spent.usd : 0, 4)} of ${money(t.budget.month_usd)}`), r ? el('span', '', ` · last run ${money(r.cost_usd, 4)}`) : null,
      t.status === 'active' && t.next_at ? el('span', '', ` · next ${when(t.next_at)}`) : null),
    r ? el('div', `tk-last ${r.outcome}`, el('span', 'tk-last-k', `${OUTCOME[r.outcome] || r.outcome}, ${ago(r.at)}`), el('span', '', r.error || r.summary || '')) : el('div', 'tk-last muted', 'Not run yet.'),
    t.paused_reason ? el('div', 'sp-warn', t.paused_reason) : null,
    el('details', 'tk-more', el('summary', '', 'Plan and runs'),
      el('p', 'tk-plan', t.plan),
      el('p', 'muted', `May: ${t.actions.map((a) => ACTION_WORDS[a]).join(', ')} · ends ${new Date(t.expires).toLocaleDateString()}${t.workflow ? ` · from the workflow “${t.workflow.name}”` : ''}`),
      runs.length ? el('ul', 'tk-runs', ...runs) : el('p', 'muted', 'No runs yet.')),
    el('div', 'tk-acts', ...acts));
}

function effectText(e) {
  if (e.type === 'notify') return `Told you${e.pushed ? '' : ' (here only)'}`;
  if (e.type === 'draft') return `Draft to ${(e.to || []).join(', ')}${e.flagged && e.flagged.length ? ' ⚠' : ''}`;
  if (e.type === 'approval') return e.kind === 'send' ? 'Asked to send' : 'Asked to add an event';
  return e.type;
}

/* ---------------- the approval card in Eden ---------------- */

function paintCard() {
  const pending = S.data ? S.data.approvals.filter((a) => a.status === 'pending' && !S.dismissed.has(a.id)) : [];
  if (!pending.length || S.open) { if (card) card.hidden = true; return; }
  if (!card) {
    card = el('div', { class: 'tk-float glass', id: 'tkFloat', role: 'region', 'aria-label': 'A task is waiting for you', 'aria-live': 'polite' });
    document.body.append(card);
  }
  card.hidden = false;
  const a = pending[0];
  // (replaceChildren would turn a null into the text "null": the parts not shown are dropped first)
  card.replaceChildren(...[
    el('div', 'tk-float-h', ico('bell', 14), el('span', 'grow', pending.length > 1 ? `${pending.length} tasks are waiting for you` : 'A task is waiting for you'),
      el('button', { type: 'button', class: 'iconbtn', 'aria-label': 'Hide for now', onclick: () => { for (const p of pending) S.dismissed.add(p.id); paintCard(); } }, ico('x', 14))),
    approvalCard(a, { compact: true }),
    el('button', { type: 'button', class: 'cap tk-float-all', onclick: () => openTasks() }, pending.length > 1 ? `Open Tasks (${pending.length})` : 'Open Tasks'),
  ]);
}

/* ---------------- wiring ---------------- */

/** At page load: the approval card, a poll every minute while the page is visible, #tasks (from a push) opens the panel. */
export function initTasks(handlers = {}) {
  H = handlers;
  const poll = () => { if (document.visibilityState === 'visible') refresh({ quiet: true }); };
  refresh({ quiet: true });
  S.timer = setInterval(poll, POLL_MS);
  document.addEventListener('visibilitychange', poll);
  const fromLink = () => {
    if (!/^#tasks\b/.test(location.hash)) return;
    history.replaceState(null, '', location.pathname + location.search);
    setTimeout(() => openTasks(), 300);
  };
  fromLink();
  addEventListener('hashchange', fromLink); // a link to #tasks while the page is open
  addEventListener('eden:acting', () => refresh({ quiet: true })); // began or ended acting for someone (account.js)
}

/* ================= mock (?mock=1) ================= */

const MKEY = 'mock:tasks';
function mstate() {
  try { const s = JSON.parse(sessionStorage.getItem(MKEY) || 'null'); if (s) return s; } catch { /* fresh */ }
  const now = Date.now();
  const s = {
    tasks: [{
      id: 'a1b2c3d4e5f60718', title: 'Lawyer reply', status: 'active', trigger: { kind: 'gmail', query: 'from:lawyer@firm.com' }, every_min: 15,
      plan: 'Tell me when the lawyer replies, then draft an answer and ask me before sending it.', actions: ['notify', 'draft', 'send'],
      budget: { run_usd: 0.05, month_usd: 1 }, expires: new Date(now + 28 * 86400_000).toISOString(), tz: 0, created: new Date(now - 2 * 86400_000).toISOString(),
      next_at: now + 9 * 60_000, spent: { month: '', usd: 0.0123 }, total_usd: 0.0123, failures: 0,
      last_run: { at: now - 6 * 60_000, outcome: 'acted', summary: 'The lawyer replied: the contract is ready to sign. I drafted a reply.', cost_usd: 0.0041, effects: [{ type: 'notify', text: 'Your lawyer replied.', pushed: true }, { type: 'draft', to: ['lawyer@firm.com'], subject: 'Re: Contract' }, { type: 'approval', kind: 'send' }], error: null },
      runs: [],
    }],
    approvals: [{
      id: '0f1e2d3c4b5a6978', task: 'a1b2c3d4e5f60718', task_title: 'Lawyer reply', kind: 'send', status: 'pending', created: now - 6 * 60_000, decided: null,
      summary: 'Send “Re: Contract” to lawyer@firm.com', to: ['lawyer@firm.com'], cc: [], subject: 'Re: Contract',
      preview: 'Thanks — I’ve read it and I’m happy to sign. Could we do Thursday at 10?', flags: [], result: null, error: null,
    }],
  };
  s.tasks[0].runs = [s.tasks[0].last_run];
  return s;
}
const msave = (s) => sessionStorage.setItem(MKEY, JSON.stringify(s));
const mjson = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** mock.js hands /api/chat/tasks here. A sentence becomes a plausible proposal; runs are simulated. */
export function tasksMock(p, method, body) {
  if (p !== '/api/chat/tasks') return null;
  const s = mstate();
  const now = Date.now();
  if (method === 'GET') return mjson({ ...s, google: { gmail: true, calendar: true }, limits: { max: 20, minEvery: 15, maxDays: 90 }, hosted: new URLSearchParams(location.search).get('acct') !== 'none' && new URLSearchParams(location.search).has('acct') });
  const a = body.args || {};
  const task = (id) => s.tasks.find((t) => t.id === id);
  const appr = (id) => s.approvals.find((x) => x.id === id);
  const hex = () => [...crypto.getRandomValues(new Uint8Array(8))].map((b) => b.toString(16).padStart(2, '0')).join('');
  switch (body.action) {
    case 'propose': {
      const text = String(a.text || '');
      const who = (/(?:when|if)\s+(?:the\s+)?([\w.@-]+(?:\s[\w.@-]+)?)\s+(?:replies|writes|emails|answers)/i.exec(text) || [])[1];
      const daily = /every (?:morning|day)|daily|each morning/i.exec(text);
      const meeting = /before (?:my |each |every )?(?:meeting|call)/i.exec(text);
      const trigger = meeting ? { kind: 'calendar', query: '', before_min: 30 } : daily ? { kind: 'time', at: new Date(new Date().setHours(24 + 8, 0, 0, 0)).toISOString(), repeat: 'daily' } : { kind: 'gmail', query: who ? (who.includes('@') ? `from:${who}` : `from:${who.toLowerCase().replace(/^the\s+/, '')}`) : 'is:unread' };
      const actions = ['notify', ...(/draft|answer|reply/i.test(text) ? ['draft'] : []), ...(/send/i.test(text) ? ['send'] : [])];
      return mjson({ proposal: { title: text.split(/[,.]/)[0].slice(0, 40), trigger, every_min: 15, plan: text, actions, budget: { run_usd: 0.05, month_usd: 1 }, expires: new Date(now + 30 * 86400_000).toISOString(), tz: 0 }, problems: who && !who.includes('@') ? [`Which address does ${who} write from? Change the Gmail search to from:their@address.`] : [], costUSD: 0.0011 });
    }
    case 'create': {
      if (a.confirm !== true) return mjson({ error: 'create needs confirm: true' }, 400);
      const t = a.task || {};
      if (!t.plan) return mjson({ error: 'Say what Eden should do (the plan).' }, 400);
      if (t.trigger && t.trigger.kind !== 'time' && Number(t.every_min) < 15) return mjson({ error: 'How often to check (minutes) must be between 15 and 1440.' }, 400);
      const made = { ...t, id: hex(), status: 'active', created: new Date(now).toISOString(), next_at: t.trigger && t.trigger.kind === 'time' ? Date.parse(t.trigger.at) : now + 60_000, spent: { month: '', usd: 0 }, total_usd: 0, last_run: null, runs: [], failures: 0, title: t.title || String(t.plan).slice(0, 40) };
      s.tasks.unshift(made);
      msave(s);
      return mjson({ task: made });
    }
    case 'pause': case 'resume': { const t = task(a.id); if (!t) return mjson({ error: 'That task is gone.' }, 404); t.status = body.action === 'pause' ? 'paused' : 'active'; msave(s); return mjson({ task: t }); }
    case 'delete': s.tasks = s.tasks.filter((t) => t.id !== a.id); s.approvals.forEach((x) => { if (x.task === a.id && x.status === 'pending') x.status = 'cancelled'; }); msave(s); return mjson({ deleted: true });
    case 'run': {
      const t = task(a.id);
      if (!t) return mjson({ error: 'That task is gone.' }, 404);
      const run = { at: now, outcome: 'nothing', summary: 'Nothing new since the last look.', cost_usd: 0, effects: [], error: null };
      t.last_run = run;
      t.runs = [run, ...(t.runs || [])].slice(0, 10);
      msave(s);
      return mjson({ task: t });
    }
    case 'approve': case 'deny': {
      const x = appr(a.id);
      if (!x) return mjson({ error: 'That approval is gone.' }, 404);
      if (x.status !== 'pending') return mjson({ error: `It was already ${x.status}.` }, 409);
      if (body.action === 'approve' && a.confirm !== true) return mjson({ error: 'approve needs confirm: true' }, 400);
      Object.assign(x, body.action === 'approve' ? { status: 'approved', result: `Sent to ${x.to.join(', ')} (mock: nothing left the browser).` } : { status: 'denied' }, { decided: now });
      msave(s);
      return mjson({ approval: x });
    }
    default:
      return mjson({ error: 'Unknown action' }, 400);
  }
}
