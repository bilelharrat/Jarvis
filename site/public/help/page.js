// askeden.com/help (and /help on Eden's server on the Mac): the Help Center as its own page.
// The FAQ works for everyone, signed in or not, so people who can't sign in still get help.
// Ask Help needs a signed-in browser on askeden.com (POST /api/help/ask, free and capped); on
// the Mac it asks Eden's own server (POST /api/chat/help). #<page-id> or #<topic> opens one.

import { mountHelp } from './help-ui.js';
import * as core from './help-core.js';

const root = document.getElementById('help');
let where = 'unknown'; // 'askeden' (signed in) | 'signed-out' | 'mac'

async function whoAmI() {
  // askeden.com: 'askeden' (signed in) or 'signed-out'; Eden's server on a Mac: 'mac'
  try {
    const r = await fetch('/help/session.json', { cache: 'no-store', credentials: 'same-origin' });
    const j = r.ok ? await r.json() : null;
    if (j && ['askeden', 'signed-out', 'mac'].includes(j.where)) return j.where;
  } catch {
    // below
  }
  return 'signed-out';
}

async function ask(payload, signal) {
  const path = where === 'mac' ? '/api/chat/help' : '/api/help/ask';
  let res;
  try {
    res = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json', 'X-Jarvis-Chat': '1' }, body: JSON.stringify(payload), signal, credentials: 'same-origin' });
  } catch (e) {
    if (e.name === 'AbortError') throw e;
    throw new Error('Can’t reach Help right now. The Help pages still work.');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401) where = 'signed-out';
    const err = new Error(data.error || `Help couldn’t answer (${res.status}).`);
    err.status = res.status;
    throw err;
  }
  return data;
}

function askState() {
  const d = core.HELP_DEFAULTS;
  if (where === 'askeden') return { ok: true, note: `Free, up to ${d.messagesPerDay} questions and ${d.screenshotsPerDay} screenshots a day.` };
  if (where === 'mac') return { ok: true, note: 'Answered on this Mac by a low-cost model, from the Help pages.' };
  return { ok: false, reason: 'Sign in to ask Help your own question. Everything on the Help topics tab works without signing in, and Contact support reaches a person.', href: '/signin?return=%2Fhelp', label: 'Sign in to ask' };
}

async function start() {
  const [faq, who] = await Promise.all([fetch('/help/faq.json', { cache: 'no-cache' }).then((r) => r.json()), whoAmI()]);
  where = who;
  if (where === 'askeden' || where === 'mac') {
    document.getElementById('hpOpen').hidden = false;
    document.getElementById('hpSignin').hidden = true;
  }
  const dark = matchMedia('(prefers-color-scheme: dark)');
  const ui = mountHelp(root, {
    faq,
    core,
    imgBase: '/help/',
    mode: 'page',
    theme: () => (dark.matches ? 'dark' : 'light'),
    ask,
    askState,
    canRun: () => false,
    run: () => false,
    tour: where === 'askeden' || where === 'mac' ? () => { location.href = '/?tour=1'; } : null,
    surface: where === 'mac' ? 'Help on my Mac' : 'askeden.com/help',
    onNavigate: (v) => {
      const hash = v.name === 'entry' ? `#${v.id}` : v.name === 'cat' ? `#${v.id}` : v.name === 'ask' ? '#ask' : '';
      if (location.hash !== hash) history.replaceState(null, '', `${location.pathname}${location.search}${hash}`);
    },
  });
  const open = () => {
    const id = decodeURIComponent(location.hash.slice(1));
    if (!id) return;
    if (id === 'ask') ui.askView();
    else if (faq.entries.some((e) => e.id === id)) ui.show(id);
    else if (faq.categories.some((c) => c.id === id)) ui.home(), root.querySelectorAll('.hc-cat').forEach((b, i) => { if (faq.categories[i].id === id) b.click(); });
  };
  addEventListener('hashchange', open);
  open();
}

start().catch(() => {
  root.replaceChildren();
  const p = document.createElement('p');
  p.className = 'hp-loading';
  p.textContent = 'Help didn’t load. Reload the page, or write to support@askeden.com.';
  root.append(p);
});
