// Eden Crew in the chat (Eden Code's crews, on the owner's Mac; Eden's eden_crew.py). "/crew what to deliver" hands
// an outcome to a crew: Eden on the Mac plans it into steps (each with a model and a cost range), and one card in
// this conversation shows the plan, Start, then the same card follows the crew while it works (steps, spend against
// its ceiling, time) and ends with what it made. Questions it asks are answered on the card. A plan that runs
// commands or has a high ceiling, and anything else that needs the owner's fingerprint, is started or answered on
// the Mac: the card says so. The card polls crew_status (as browser-task.js polls its task); the crew's words are
// data, shown as text only. Pause and Stop from here; a crew is resumed on the Mac.

import { el, ico, toast } from './util.js';
import { api } from './api.js';
import { ui, addNode, path, saveConversation } from './state.js';
import { ensureConversation } from './chat.js';
import { ENDED, STATES, STEP_STATES, TYPES, MARK, money, range, stepMoney, summaryLine, doneLine, live } from './crew-model.js';

const POLL_MS = { planning: 2500, review: 10000, running: 3000, paused: 8000, stopping: 2500 };

/* ---------- the Mac ---------- */

async function call(tool, args) {
  const r = await api.jarvis(tool, args);
  if (r.is_error) throw new Error(r.text || 'The Eden app on your Mac said no.');
  return r.text;
}

const seen = new Map(); // crew id → its last crew_status, so a redrawn card shows at once
const boxes = new Map(); // crew id → the card elements showing it
const polls = new Map(); // crew id → its timer
const troubles = new Map(); // crew id → why the Mac can't be read right now

function watch(id) {
  if (!id || polls.has(id)) return;
  const tick = async () => {
    polls.delete(id);
    const shown = [...(boxes.get(id) || [])].filter((b) => b.isConnected);
    boxes.set(id, new Set(shown));
    if (!shown.length) return; // no card on screen: the next one starts it again
    try {
      seen.set(id, JSON.parse(await call('crew_status', { id })));
      troubles.delete(id);
    } catch (e) {
      troubles.set(id, e.message);
    }
    for (const b of shown) b.paint();
    const c = seen.get(id);
    if (!c || live(c)) polls.set(id, setTimeout(tick, (c && POLL_MS[c.state]) || 5000));
  };
  polls.set(id, setTimeout(tick, 0));
}

function refresh(id) {
  clearTimeout(polls.get(id));
  polls.delete(id);
  watch(id);
}

/* ---------- starting one ---------- */

/** "/crew what to deliver": a message from the owner and a card that follows the crew. */
export async function startCrew(brief) {
  const words = String(brief || '').trim();
  if (!words) { toast('Say what the crew should deliver: /crew compare three CRMs and recommend one'); return; }
  const c = ensureConversation();
  const last = path(c).at(-1);
  const user = addNode(c, last ? last.id : null, { role: 'user', content: words, origin: 'crew' });
  const part = { type: 'crew', id: '', n: 0 };
  const node = addNode(c, user.id, { role: 'assistant', parts: [{ type: 'text', text: 'I’ve handed this to a crew on your Mac.' }, part] });
  ui.render();
  try {
    const made = JSON.parse(await call('crew_plan', { brief: words }));
    Object.assign(part, { id: made.id, n: made.n });
  } catch (e) {
    part.error = e.message;
  }
  saveConversation(c);
  ui.updateMessage(c, node);
}

/* ---------- the card ---------- */

/** The crew's card, for render.js (part: {type: 'crew', id, n, error?}). */
export function crewCard(c, node, part) {
  const box = el('article', 'crew-card');
  box.setAttribute('aria-label', part.n ? `Crew ${part.n}` : 'Crew');
  box.paint = () => paint(box, part);
  if (part.id) {
    if (!boxes.has(part.id)) boxes.set(part.id, new Set());
    boxes.get(part.id).add(box);
    watch(part.id);
  }
  box.paint();
  return box;
}

function paint(box, part) {
  const c = part.id ? seen.get(part.id) : null;
  const trouble = part.error || (part.id && troubles.get(part.id));
  const kids = [];
  if (!c) {
    kids.push(head(part.n, 'Crew', trouble ? 'Can’t reach your Mac' : 'Planning on your Mac…'));
    kids.push(el('p', 'crew-note', trouble ? `${trouble}` : 'Eden on your Mac is writing the plan. Nothing runs until you start it.'));
    if (trouble && part.id) kids.push(el('div', 'crew-acts', btn('Try again', '', () => refresh(part.id))));
    box.replaceChildren(...kids);
    return;
  }
  kids.push(head(c.n, c.title || `Crew ${c.n}`, summaryLine(c), c));
  if (trouble) kids.push(el('p', 'crew-warn', `Can’t reach your Mac right now: ${trouble}`));
  const needs = (c.needs || []).filter((n) => n.kind !== 'plan');
  if (needs.length) kids.push(needsBlock(c, needs));
  if (c.state === 'review') kids.push(...review(c));
  else if (c.state !== 'planning') kids.push(stepList(c, false));
  if (ENDED.has(c.state) && c.state === 'done') kids.push(el('p', 'crew-done', doneLine(c)));
  if ((c.deliverables || []).length && c.state !== 'review') kids.push(files(c));
  if (c.state === 'paused') kids.push(el('p', 'crew-note', 'Resume it in Eden Code on your Mac.'));
  box.replaceChildren(...kids);
}

function head(n, title, line, c) {
  const tile = el('span', 'crew-tile', ico('routine', 18));
  const words = el('div', 'crew-head-words',
    el('p', 'crew-kicker', n ? `Crew ${n}` : 'Crew'),
    el('h3', { class: 'crew-title', 'data-no-i18n': '' }, title),
    el('p', 'crew-line', line));
  const acts = el('div', 'crew-acts');
  if (c && c.state === 'running') acts.append(btn('Pause', '', () => act(c, 'crew_pause')));
  if (c && ['running', 'paused', 'planning'].includes(c.state)) acts.append(btn('Stop', 'danger', () => {
    if (confirm(`Stop Crew ${c.n}? Every step ends; what it made stays in its folder.`)) act(c, 'crew_stop');
  }));
  return el('header', 'crew-head', tile, words, acts);
}

function btn(label, cls, run, disabled) {
  return el('button', { type: 'button', class: `btn ${cls || ''}`.trim(), onclick: run, disabled: !!disabled }, label);
}

async function act(c, tool, args = {}) {
  try {
    toast(await call(tool, { id: c.id, ...args }));
  } catch (e) {
    toast(e.message);
  }
  refresh(c.id);
}

function review(c) {
  const out = [];
  if (c.summary) out.push(el('p', { class: 'crew-summary', 'data-no-i18n': '' }, c.summary));
  out.push(stepList(c, true));
  const est = el('p', 'crew-est',
    el('b', '', range(c.low, c.high)), ` ${c.confidence || 'rough'} estimate · stops at ${money(c.ceiling)} · after ${c.hours} hours of work`);
  out.push(est);
  if ((c.unsupported || []).length) {
    out.push(el('div', 'crew-not',
      el('p', 'crew-kicker', 'Not in this crew'),
      ...c.unsupported.map((u) => el('p', { class: 'crew-not-row', 'data-no-i18n': '' }, el('b', '', u.what), u.why ? ` · ${u.why}` : ''))));
  }
  if ((c.questions || []).length) {
    out.push(el('div', 'crew-qs',
      el('p', 'crew-kicker', 'The planner asks'),
      ...c.questions.map((q) => el('p', { class: 'crew-q', 'data-no-i18n': '' }, q)),
      el('p', 'crew-note', 'Answer these in Eden Code on your Mac when you change the plan.')));
  }
  const start = btn(c.start_here ? 'Start crew' : 'Start it on your Mac', 'primary', () => act(c, 'crew_start'), !c.start_here);
  const why = c.start_here ? 'Nothing runs until you start it. It never sends, posts, buys or deploys.'
    : 'This plan needs your fingerprint (it runs commands or its ceiling is high): start it in Eden Code on your Mac.';
  out.push(el('footer', 'crew-foot', el('p', 'crew-note', why),
    el('div', 'crew-acts', btn('Discard', '', () => { if (confirm(`Discard Crew ${c.n}?`)) act(c, 'crew_stop'); }), start)));
  return out;
}

function stepList(c, planning) {
  const list = el('ol', 'crew-steps');
  for (const s of c.steps || []) {
    const state = STEP_STATES[s.state] || s.state;
    const mark = el('span', `crew-mark crew-m-${s.state}`, ico(MARK[s.state] || 'clock', 13));
    mark.setAttribute('aria-hidden', 'true');
    const meta = [TYPES[s.type] || s.type, s.label].filter(Boolean).join(' · ');
    const lines = [el('p', 'crew-step-meta', planning ? meta : `${state} · ${meta}`)];
    const check = s.verdict && s.verdict.why ? `${s.verdict.met ? 'Check passed' : 'Check found'}: ${s.verdict.why}` : '';
    if (!planning && (check || s.why)) lines.push(el('p', { class: 'crew-step-why', 'data-no-i18n': '' }, check || s.why));
    list.append(el('li', 'crew-step', mark,
      el('div', 'crew-step-main', el('p', { class: 'crew-step-title', 'data-no-i18n': '' }, s.title), ...lines),
      el('span', 'crew-step-money', stepMoney(s))));
  }
  return list;
}

function needsBlock(c, needs) {
  const box = el('section', 'crew-needs', el('p', 'crew-kicker', `Needs you · ${needs.length}`));
  for (const n of needs) {
    const step = n.step ? (c.steps || []).find((s) => s.id === n.step) : null;
    const row = el('div', 'crew-need');
    if (step) row.append(el('p', 'crew-need-step', `Step ${String(n.step).replace(/^s/, '')} · `, el('span', { 'data-no-i18n': '' }, step.title)));
    row.append(el('p', { class: 'crew-need-q', 'data-no-i18n': '' }, n.question));
    if (!n.here) {
      row.append(el('p', 'crew-note', 'Answer this one in Eden Code on your Mac: it needs your fingerprint.'));
    } else {
      const acts = el('div', 'crew-acts');
      for (const ch of (n.choices || []).filter((x) => x.id !== 'deny')) {
        acts.append(el('button', { type: 'button', class: 'btn tinted', 'data-no-i18n': '', onclick: () => act(c, 'crew_answer', { need: n.id, choice: ch.id }) }, ch.label));
      }
      if (n.free_text) {
        const words = el('input', { type: 'text', maxlength: 2000, placeholder: 'Or say it in your own words', 'aria-label': 'Your answer' });
        const send = () => { const w = words.value.trim(); if (w) act(c, 'crew_answer', { need: n.id, choice: 'answer', words: w }); };
        words.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); send(); } });
        acts.append(el('span', 'crew-own', words, btn('Send', 'primary', send)));
      }
      row.append(acts);
    }
    box.append(row);
  }
  return box;
}

function files(c) {
  const list = el('ul', 'crew-files');
  for (const d of c.deliverables) {
    list.append(el('li', 'crew-file', ico('doc', 13), el('span', { 'data-no-i18n': '' }, d.name), el('small', '', d.size > 0 ? '' : 'not made yet')));
  }
  return el('section', 'crew-made', el('p', 'crew-kicker', 'What it made'), list);
}
