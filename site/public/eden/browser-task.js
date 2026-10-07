// "Do this on a website" (ROADMAP H6): Jarvis's browser agent, driven from Eden. browser_task
// asks the owner on their Mac first (a card), then works in its own tab of the built-in browser;
// this panel shows each step as it happens, the page it's on (a small picture only if the owner
// chose that on the card), and the cards waiting on the Mac: purchases, sign-ins, sends and
// form submits are answered there, never from here. Stop ends it (its open cards are answered
// no). Page words are data: shown as text only.

import { el, ico, toast } from './util.js';
import { api } from './api.js';

const POLL_MS = 1500;
const KEY = 'eden:web-task';
const STATUS = {
  waiting_owner: { t: 'Waiting for your OK on your Mac', c: 'wait' },
  running: { t: 'Working', c: 'run' },
  done: { t: 'Done', c: 'done' },
  failed: { t: 'Didn’t finish', c: 'fail' },
  stopped: { t: 'Stopped', c: 'done' },
  declined: { t: 'Not started: you said no', c: 'done' },
};
const live = (s) => s === 'waiting_owner' || s === 'running';

async function jarvis(tool, args) {
  const r = await api.jarvis(tool, args);
  if (r.is_error) throw new Error(r.text || 'The Jarvis app said no.');
  return JSON.parse(r.text);
}

const remembered = () => { try { return sessionStorage.getItem(KEY) || ''; } catch { return ''; } };
const remember = (id) => { try { if (id) sessionStorage.setItem(KEY, id); else sessionStorage.removeItem(KEY); } catch { /* private window */ } };
const host = (u) => { try { return new URL(u).host.replace(/^www\./, ''); } catch { return ''; } };

/** The "On a website" panel, in the space panel's body. */
export function browserTaskPanel(body, opts = {}) {
  const root = el('div', 'act-root');
  body.append(root);
  const id = remembered();
  if (id) watch(root, id); else form(root, opts.goal || '', opts.url || '');
}

async function form(root, goal = '', start = '') {
  const ta = el('textarea', { rows: 3, maxlength: 1000, placeholder: 'e.g. Find the cheapest TAP flight to Lisbon on 18 October and put it in the basket', 'aria-label': 'What to do on a website' });
  ta.value = goal;
  const url = el('input', { type: 'url', placeholder: 'https://… (optional)', 'aria-label': 'Where to start' });
  if (/^https?:\/\//.test(start)) url.value = start; // from the browser panel: the page it's on
  const shots = el('input', { type: 'checkbox', id: 'webShots' });
  const go = el('button', { type: 'submit', class: 'btn primary' }, ico('globe', 14), 'Start');
  const recent = el('div', 'act-recent');
  const f = el('form', { class: 'web-form', onsubmit: async (e) => {
    e.preventDefault();
    const g = ta.value.trim();
    if (!g) { toast('Say what to do first'); ta.focus(); return; }
    go.disabled = true;
    try {
      const r = await jarvis('browser_task', { goal: g, ...(url.value.trim() ? { url: url.value.trim() } : {}), screenshots: shots.checked });
      remember(r.id);
      watch(root, r.id);
    } catch (err) { toast(err.message); go.disabled = false; }
  } },
  el('div', 'field', 'What should Jarvis do on a website?', ta),
  el('div', 'field', 'Start at', url),
  el('label', 'web-check', shots, el('span', '', 'Show pictures of the page here (you choose on your Mac too)')),
  el('div', 'dlg-acts', go));
  root.replaceChildren(f,
    el('p', 'sp-note', 'It runs in the built-in browser on your Mac, in a tab of its own, and asks you there before it starts. Buying, signing in, sending and submitting forms always ask you on your Mac first; Eden only shows that a question is waiting.'),
    recent);
  requestAnimationFrame(() => ta.focus());
  try {
    const { tasks } = await jarvis('browser_task_status', {});
    if (tasks.length) recent.replaceChildren(el('h4', '', 'Recent'), ...tasks.slice(0, 5).map((t) => el('button', { type: 'button', class: 'act-row', onclick: () => { remember(t.id); watch(root, t.id); } },
      el('span', 'act-ico', ico('globe', 15)),
      el('span', 'act-main', el('span', 'act-top', el('b', '', t.goal), el('span', `web-pill s-${(STATUS[t.status] || STATUS.done).c}`, (STATUS[t.status] || { t: t.status }).t)),
        el('span', 'act-sub', `${t.steps} step${t.steps === 1 ? '' : 's'}`)))));
  } catch { /* Jarvis away: the form says enough */ }
}

function watch(root, id) {
  const title = el('h3', 'act-title', '');
  const pill = el('span', 'web-pill', '');
  const stop = el('button', { type: 'button', class: 'btn web-stop' }, ico('x', 13), 'Stop');
  const page = el('div', 'web-page');
  const shot = el('img', { class: 'web-shot', alt: 'The page the task is on', hidden: true });
  const asks = el('div', { class: 'web-asks', 'aria-live': 'assertive' });
  const steps = el('ol', { class: 'web-steps', 'aria-live': 'polite', 'aria-label': 'Steps' });
  const result = el('div', 'web-result');
  const newer = el('button', { type: 'button', class: 'cap', onclick: () => { remember(''); form(root); } }, ico('plus', 12), 'New task');
  root.replaceChildren(el('div', 'web-head', title, pill, stop), page, shot, asks, steps, result, el('div', 'dlg-acts', newer));
  let timer = 0, n = 0, seen = '', ended = false, told = false;
  // The Eden iPhone app shows a running task on the Lock Screen (native.js; nothing elsewhere).
  const tell = (s) => {
    const op = live(s.status) ? (told ? 'update' : 'start') : 'end';
    if (op === 'end' && !told) return;
    told = op !== 'end';
    const last = s.steps[s.steps.length - 1];
    const step = s.status === 'waiting_owner' || s.approvals.length ? 'Waiting for your OK on your Mac' : last ? `${last.label}${last.detail ? ` · ${last.detail}` : ''}` : 'Starting';
    dispatchEvent(new CustomEvent('eden:task', { detail: { id, op, kind: 'browser', title: s.goal, model: 'Browser agent', step, outcome: s.status === 'done' ? 'done' : s.status === 'failed' ? 'failed' : 'stopped' } }));
  };
  stop.addEventListener('click', async () => {
    stop.disabled = true;
    try { await jarvis('browser_task_stop', { id }); } catch (e) { toast(e.message); }
    tick();
  });
  const tick = async () => {
    clearTimeout(timer);
    if (!root.isConnected) return; // the panel closed: stop asking
    let s;
    try { s = await jarvis('browser_task_status', { id, thumbnail: n++ % 2 === 0 }); } catch (e) {
      if (!root.isConnected) return;
      if (/No browser task/.test(e.message)) { remember(''); form(root); toast('That task is gone (Jarvis restarted).'); return; }
      result.replaceChildren(el('div', 'sp-warn', el('b', '', 'Can’t reach your Mac'), e.message));
      timer = setTimeout(tick, POLL_MS * 2);
      return;
    }
    if (!root.isConnected) return;
    tell(s);
    const st = STATUS[s.status] || { t: s.status, c: 'done' };
    title.textContent = s.goal;
    pill.className = `web-pill s-${st.c}`;
    pill.textContent = st.t;
    stop.hidden = !live(s.status);
    page.replaceChildren(...(s.url ? [ico('globe', 12), el('span', '', s.title || host(s.url)), el('span', 'muted', host(s.url))] : []));
    if (s.thumbnail) { shot.src = s.thumbnail; shot.hidden = false; } else if (!s.shots) shot.hidden = true;
    asks.replaceChildren(...s.approvals.map((a) => el('div', 'sp-warn web-ask', el('b', '', ico('lock', 12), ' Waiting for your OK on your Mac'), el('div', '', a.question),
      a.detail ? el('details', '', el('summary', '', 'What it shows'), el('p', 'web-ask-d', a.detail)) : null)));
    const sig = JSON.stringify(s.steps.map((x) => [x.n, x.ok, x.detail]));
    if (sig !== seen) {
      const more = s.steps.length > (seen ? JSON.parse(seen).length : 0);
      seen = sig;
      steps.replaceChildren(...s.steps.map((x) => el('li', `web-step ${x.ok === null ? 'is-run' : x.ok ? 'is-ok' : 'is-bad'}`,
        el('span', 'web-dot', x.ok === null ? el('span', 'act-spin', '') : ico(x.ok ? 'check' : 'x', 11)),
        el('span', 'web-step-t', el('b', '', x.label), x.detail ? el('span', 'muted', ` · ${x.detail}`) : null))));
      if (more) steps.lastElementChild?.scrollIntoView({ block: 'nearest' });
    }
    if (!s.steps.length && live(s.status)) steps.replaceChildren(el('li', 'muted web-none', s.status === 'waiting_owner' ? 'Answer the card on your Mac to start.' : 'Starting…'));
    if (!live(s.status)) {
      if (!ended) {
        ended = true;
        const cost = typeof s.cost === 'number' ? `It cost $${s.cost.toFixed(2)}.` : '';
        result.replaceChildren(el('div', `web-done s-${st.c}`, el('b', '', st.t), s.result ? el('p', '', s.result) : null, cost ? el('p', 'muted', cost) : null));
      }
      return;
    }
    timer = setTimeout(tick, POLL_MS);
  };
  tick();
}
