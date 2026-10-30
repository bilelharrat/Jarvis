// Eden at the controls of the cloud browser (askeden.com: the site's eden/browser-turn.js): the
// "Use the browser" toggle and /browse, the step chips under a reply ("Opened nytimes.com",
// "Clicked “Sign in”"), and the cards a browser turn can end with: an approval for something that
// can't be undone (Approve runs exactly that action, on the same page, then Eden goes on), a page
// that needs a password or payment details (the owner takes over in the panel), or "you took
// over" (Resume). The cards answer through window events that chat.js turns into the next turn.

import { el, ico } from './util.js';

const KEY = 'eden:browse';
let on = false;
try { on = sessionStorage.getItem(KEY) === '1'; } catch { /* private window */ }

/** The composer's toggle: every message in this tab goes to the browser while it's on. */
export const browseMode = () => on;
export function setBrowseMode(v) {
  on = Boolean(v);
  try { if (on) sessionStorage.setItem(KEY, '1'); else sessionStorage.removeItem(KEY); } catch { /* private window */ }
  dispatchEvent(new CustomEvent('eden:browse-mode', { detail: { on } }));
}

/** "/browse what to do" → { browse: true, text } (the command is dropped from the message). */
export function parseBrowse(text) {
  const m = /^\s*\/browse\b\s*/i.exec(String(text || ''));
  return m ? { browse: true, text: String(text).slice(m[0].length) } : { browse: false, text };
}

/** What the send body says about the browser for this message. */
export function browserBody(user, { panelOpen = false } = {}) {
  const out = {};
  if (user && user.browserAnswer) out.browser = user.browserAnswer;
  else if ((user && user.browser) || on) out.browser = true;
  if (panelOpen) out.browserPanel = true;
  return out;
}

const KIND = { purchase: 'A purchase or payment', send: 'Sends or posts something', login: 'Signs in or creates an account', delete: 'Deletes or cancels something', accept: 'Accepts terms or cookies', form: 'Submits your details', download: 'Downloads a program' };

/** The step chips: one per tool call, newest last (a failed one marked). */
export function stepChips(node) {
  const steps = node.steps || [];
  if (!steps.length) return null;
  const list = el('ol', { class: 'ba-steps', 'aria-label': 'What Eden did in the browser' });
  for (const s of steps) list.append(el('li', { class: `ba-step${s.ok === false ? ' bad' : ''}` }, ico(s.ok === false ? 'x' : 'globe', 11), el('span', '', s.text)));
  if (node.streaming) list.append(el('li', 'ba-step live', el('i', 'ba-dot'), el('span', '', 'Working in the browser…')));
  return list;
}

const fire = (name, detail) => dispatchEvent(new CustomEvent(name, { detail }));

/** The card a browser turn ended with (null: none). */
export function browserCard(c, node) {
  const b = node.browserCard;
  if (!b) return null;
  if (b.kind === 'approval') {
    const answered = b.answer;
    const card = el('div', { class: `g-card glass ba-card${answered ? ' answered' : ''}`, role: 'group', 'aria-label': `Eden asks: ${b.summary}` });
    card.append(el('div', 'g-head', el('span', 'g-shield', ico('lock', 15)), el('div', 'g-head-t', el('b', answered ? { 'data-no-i18n': '' } : '', answered ? b.summary : `Eden wants to: ${b.summary}`), el('span', '', KIND[b.action] || 'Can’t be undone'))));
    if (answered) { card.append(el('div', { class: `g-state ${answered === 'approve' ? 'approved' : 'denied'}`, role: 'status' }, ico(answered === 'approve' ? 'check' : 'x', 13), answered === 'approve' ? 'Approved' : 'Not done')); return card; }
    card.append(el('p', 'g-reason', 'Nothing happens until you choose. Approve runs exactly this, on the same page; the page’s own words never approve anything.'));
    card.append(el('div', 'g-acts',
      el('button', { type: 'button', class: 'btn', onclick: () => fire('eden:browser-answer', { c, node, deny: b.id }) }, 'Not now'),
      el('button', { type: 'button', class: 'btn primary', onclick: () => fire('eden:browser-answer', { c, node, approve: b.id }) }, 'Approve')));
    return card;
  }
  if (b.kind === 'takeover' || b.kind === 'paused') {
    return el('div', { class: 'g-card glass ba-card', role: 'group' },
      el('div', 'g-head', el('span', 'g-shield', ico('lock', 15)), el('div', 'g-head-t', el('b', '', b.kind === 'paused' ? 'You have the browser' : 'Your turn in the browser'), el('span', '', b.kind === 'paused' ? 'Eden is paused' : 'Eden never types passwords or payment details'))),
      el('div', 'g-acts',
        b.kind === 'takeover' ? el('button', { type: 'button', class: 'btn', onclick: () => fire('eden:browser-takeover', {}) }, 'Take over') : null,
        el('button', { type: 'button', class: 'btn primary', onclick: () => fire('eden:browser-resume', {}) }, 'Resume')));
  }
  return null;
}

/**
 * Where a message sent while Eden is still replying goes. It never stops the run (only Stop does):
 * a Code turn or a browser run takes it as steering for the next step ('steer-code', 'steer-browser',
 * once the run's id is known); anything else waits in the queue and is sent when the reply ends ('wait').
 */
export function followUpRoute({ kind, browserRun = false, runId = '', turnId = '' } = {}) {
  if (kind === 'code') return turnId ? 'steer-code' : 'wait';
  if (browserRun) return runId ? 'steer-browser' : 'wait';
  return 'wait';
}
/** The chat note under a reply for a message the running agent took as guidance. */
export const steerNote = (text) => `↳ Steered: ${String(text || '')}`;
