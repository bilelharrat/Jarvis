// The audience page of an Eden Slides presentation (/a/<id>): vote in the poll on screen, ask and upvote questions,
// or follow the slides read-only. No account; this phone gets a voter id from the room (kept in this browser so a
// reload doesn't make a second voter). The room's rules: audience-core.js. Sealing: audience-crypto.js.

import { openBody, sealBody, readAudienceHash } from './audience-crypto.js';
import { maskRough } from './deck-live-model.js';

const $ = (id) => document.getElementById(id);
const main = $('aud');
const status = $('audStatus');
const say = (t) => { status.textContent = t; };
const announce = (t) => { $('audLive').textContent = ''; setTimeout(() => { $('audLive').textContent = t; }, 30); };
function el(tag, attrs = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') e.className = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v === true ? '' : String(v));
  }
  for (const k of kids.flat()) if (k !== null && k !== undefined && k !== false) e.append(k instanceof Node ? k : document.createTextNode(String(k)));
  return e;
}

const id = (/^\/a\/([A-Za-z0-9_-]{22})\/?$/.exec(location.pathname) || [])[1] || '';
const { key, follow: followLink } = readAudienceHash(location.hash);
const base = `/a/${id}`;
const store = { get: (k) => { try { return localStorage.getItem(k) || ''; } catch { return ''; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* blocked: this visit only */ } } };
const state = { voter: '', view: null, mine: { vote: {}, ups: new Set(), asked: new Set() }, opened: new Map(), deck: null, deckV: -1, tab: followLink ? 'follow' : 'live', shown: '', lastAnnounce: '' };

const post = async (p, body, headers = {}) => {
  const r = await fetch(`${base}${p}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body), cache: 'no-store', credentials: 'omit' });
  const out = await r.json().catch(() => ({}));
  if (!r.ok) { const e = new Error(out.error || 'Something went wrong.'); e.status = r.status; e.code = out.code; throw e; }
  return out;
};
const open = async (body, kind) => {
  const k = `${kind}:${body}`;
  if (!state.opened.has(k)) state.opened.set(k, await openBody(body, key, kind));
  return state.opened.get(k);
};

function gone(words) {
  say('Ended');
  $('audTabs').hidden = true;
  main.replaceChildren(el('div', { class: 'aud-card' }, el('h1', {}, 'This presentation isn’t live'), el('p', { class: 'aud-note' }, words)));
}

async function join() {
  const saved = store.get(`eden.aud.${id}`);
  if (/^[A-Za-z0-9_-]{22}$/.test(saved)) {
    try {
      const me = await post('/act', { t: 'me' }, { 'x-voter': saved });
      state.voter = saved;
      state.mine = { vote: me.vote || {}, ups: new Set(me.ups || []), asked: new Set(me.asked || []) };
      return;
    } catch (e) { if (e.status !== 401) throw e; }
  }
  const { voter } = await post('/join', {});
  state.voter = voter;
  store.set(`eden.aud.${id}`, voter);
}
const act = (m) => post('/act', m, { 'x-voter': state.voter }).catch(async (e) => {
  if (e.status === 401) { await join(); return post('/act', m, { 'x-voter': state.voter }); }
  throw e;
});

// ── the live stream (server-sent events, read with fetch) ──

async function listen() {
  let wait = 1000;
  for (;;) {
    try {
      const r = await fetch(`${base}/events`, { cache: 'no-store', credentials: 'omit' });
      if (r.status === 404) { gone('It ended, or the link is wrong. Ask the presenter for the link again.'); return; }
      if (!r.ok || !r.body) throw new Error('stream');
      say('Live');
      wait = 1000;
      const reader = r.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const chunk = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const data = chunk.split('\n').filter((l) => l.startsWith('data: ')).map((l) => l.slice(6)).join('\n');
          if (/^event: view$/m.test(chunk) && data) { try { await onView(JSON.parse(data)); } catch { /* one bad event */ } }
        }
      }
      if (state.view && state.view.closed) return;
    } catch { /* below */ }
    say(wait >= 8000 ? 'Lost the connection: retrying' : 'Reconnecting…');
    await new Promise((res) => setTimeout(res, wait));
    wait = Math.min(15000, wait * 2);
  }
}

async function onView(v) {
  state.view = v;
  if (v.closed) { gone('The presenter ended it. Thanks for taking part.'); return; }
  if (v.deckV !== state.deckV && v.deckV > 0) {
    state.deckV = v.deckV;
    fetch(`${base}/deck`, { cache: 'no-store', credentials: 'omit' }).then((r) => r.json()).then(async (d) => { state.deck = d.body ? await open(d.body, 'deck') : null; draw(); }).catch(() => {});
  }
  $('audTabs').hidden = !(v.deckV > 0);
  await draw();
}

// ── drawing ──

async function draw() {
  const v = state.view;
  if (!v) return;
  $('tabLive').setAttribute('aria-pressed', String(state.tab === 'live'));
  $('tabFollow').setAttribute('aria-pressed', String(state.tab === 'follow'));
  if (state.tab === 'follow' && v.deckV > 0) return drawFollow(v);
  const l = v.live;
  const what = l ? await open(l.body, l.kind) : null;
  const sig = l ? `${l.kind}:${l.id}` : 'wait';
  if (!l || !what) {
    if (state.shown !== 'wait') { state.shown = 'wait'; main.replaceChildren(el('div', { class: 'aud-card' }, el('h1', {}, 'You’re in'), el('p', { class: 'aud-note', id: 'audWait' }))); }
    $('audWait').textContent = v.total ? `The presenter is on slide ${v.k + 1} of ${v.total}. A poll or questions will show here when they’re on screen.` : 'A poll or questions will show here when they’re on screen.';
    return;
  }
  if (state.shown !== sig) {
    state.shown = sig;
    main.replaceChildren(l.kind === 'poll' ? pollView(l, what) : qaView(l, what));
    announce(l.kind === 'poll' ? `New poll: ${what.q}` : `Questions are open: ${what.q}`);
  }
  if (l.kind === 'poll') updatePoll(l, what); else await updateQa(l);
}

function pollView(l, what) {
  const opts = Array.isArray(what.o) ? what.o.slice(0, 6) : [];
  return el('section', { class: 'aud-card', 'aria-labelledby': 'pollQ' },
    el('p', { class: 'aud-kicker' }, 'Live poll'),
    el('h1', { id: 'pollQ' }, maskRough(what.q || 'Poll')),
    el('div', { class: 'aud-opts', role: 'group', 'aria-labelledby': 'pollQ' },
      opts.map((o, i) => el('button', { type: 'button', class: 'aud-opt', 'data-i': i, 'aria-pressed': 'false', onclick: () => vote(l.id, i) },
        el('span', { class: 'aud-bar', 'aria-hidden': 'true' }), el('span', { class: 'aud-opt-t' }, maskRough(o)), el('span', { class: 'aud-pct' })))),
    el('p', { class: 'aud-note', id: 'pollNote' }));
}
function updatePoll(l) {
  const mine = state.mine.vote[l.id];
  const voted = Number.isInteger(mine);
  const total = l.votes || 0;
  main.querySelectorAll('.aud-opt').forEach((b) => {
    const i = Number(b.dataset.i), n = (l.counts || [])[i] || 0, pct = total ? Math.round((n / total) * 100) : 0;
    b.setAttribute('aria-pressed', String(mine === i));
    b.disabled = !!l.locked;
    b.querySelector('.aud-bar').style.width = voted || l.locked ? `${pct}%` : '0';
    b.querySelector('.aud-pct').textContent = voted || l.locked ? `${pct}%` : '';
    b.setAttribute('aria-label', `${b.querySelector('.aud-opt-t').textContent}${voted || l.locked ? `: ${n} vote${n === 1 ? '' : 's'}, ${pct}%` : ''}`);
  });
  $('pollNote').textContent = l.locked ? `Voting has closed. ${total} vote${total === 1 ? '' : 's'}.` : voted ? `Thanks. ${total} vote${total === 1 ? '' : 's'} so far; tap another answer to change yours.` : 'Tap an answer to vote.';
}
async function vote(pid, i) {
  const before = state.mine.vote[pid];
  state.mine.vote[pid] = i;
  if (state.view && state.view.live) updatePoll(state.view.live);
  try { await act({ t: 'vote', poll: pid, option: i }); announce('Vote counted'); }
  catch (e) { state.mine.vote[pid] = before; if (state.view && state.view.live) updatePoll(state.view.live); announce(e.message); $('pollNote').textContent = e.message; }
}

function qaView(l, what) {
  const text = el('textarea', { id: 'qText', maxlength: '280', rows: '3', required: true, 'aria-describedby': 'qHelp' });
  const name = el('input', { id: 'qName', type: 'text', maxlength: '40', autocomplete: 'off' });
  name.value = store.get('eden.aud.name');
  const msg = el('p', { class: 'aud-note', id: 'qHelp' }, 'Up to 280 characters. Leave the name empty to ask anonymously.');
  const form = el('form', { class: 'aud-ask', onsubmit: async (e) => {
    e.preventDefault();
    const t = text.value.replace(/\s+/g, ' ').trim();
    if (!t) { text.focus(); return; }
    store.set('eden.aud.name', name.value.trim());
    form.querySelector('button').disabled = true;
    try {
      const body = await sealBody({ text: t.slice(0, 280) }, key, 'question');
      const out = await act({ t: 'ask', qa: l.id, body, name: name.value.trim() || undefined });
      if (out && out.id) state.mine.asked.add(out.id);
      text.value = '';
      msg.textContent = 'Sent. Others can upvote it now.';
      announce('Question sent');
    } catch (err) { msg.textContent = err.message; announce(err.message); }
    form.querySelector('button').disabled = false;
  } },
  el('label', { for: 'qText' }, 'Your question'), text,
  el('label', { for: 'qName' }, 'Name (optional)'), name,
  el('button', { type: 'submit', class: 'aud-primary' }, 'Send question'), msg);
  return el('section', { class: 'aud-card', 'aria-labelledby': 'qaQ' },
    el('p', { class: 'aud-kicker' }, 'Questions'),
    el('h1', { id: 'qaQ' }, maskRough(what.q || 'Questions?')),
    form,
    el('h2', { class: 'aud-h2' }, 'Most upvoted'),
    el('ol', { class: 'aud-qs', id: 'qList' }));
}
async function updateQa(l) {
  const list = $('qList');
  if (!list) return;
  const items = [];
  for (const q of l.questions || []) {
    const v = await open(q.body, 'question');
    if (!v || typeof v.text !== 'string') continue;
    const mineQ = state.mine.asked.has(q.id), up = state.mine.ups.has(q.id);
    items.push(el('li', { class: `aud-q${q.answered ? ' answered' : ''}` },
      el('div', { class: 'aud-q-t' }, maskRough(v.text.slice(0, 280)), el('span', { class: 'aud-q-by' }, [q.name ? maskRough(q.name) : 'Anonymous', mineQ ? ' · yours' : '', q.answered ? ' · answered' : ''].join(''))),
      el('button', { type: 'button', class: 'aud-up', 'aria-pressed': String(up), disabled: mineQ || null, 'aria-label': `Upvote. ${q.up} upvote${q.up === 1 ? '' : 's'}`, onclick: () => upvote(q.id, !up) }, el('span', { 'aria-hidden': 'true' }, '▲'), ` ${q.up}`)));
  }
  const focused = document.activeElement && list.contains(document.activeElement) ? [...list.querySelectorAll('.aud-up')].indexOf(document.activeElement) : -1;
  list.replaceChildren(...(items.length ? items : [el('li', { class: 'aud-note' }, 'No questions yet. Be the first.')]));
  if (focused >= 0) { const b = list.querySelectorAll('.aud-up')[focused]; if (b) b.focus(); }
}
async function upvote(qid, on) {
  if (on) state.mine.ups.add(qid); else state.mine.ups.delete(qid);
  try { const r = await act({ t: 'up', q: qid, on }); if (r.up) state.mine.ups.add(qid); else state.mine.ups.delete(qid); }
  catch (e) { announce(e.message); }
  if (state.view && state.view.live && state.view.live.kind === 'qa') await updateQa(state.view.live);
}

// ── following the slides ──

function drawFollow(v) {
  const d = state.deck;
  if (state.shown !== 'follow') {
    state.shown = 'follow';
    main.replaceChildren(el('section', { class: 'aud-card aud-follow', 'aria-labelledby': 'fTitle' },
      el('h1', { id: 'fTitle', class: 'aud-sr' }, 'The presenter’s slides'),
      el('div', { class: 'aud-stage', id: 'fStage' }),
      el('p', { class: 'aud-note', id: 'fPos', 'aria-live': 'polite' })));
  }
  const slides = d && Array.isArray(d.slides) ? d.slides : [];
  const s = slides[v.k];
  $('fPos').textContent = slides.length ? `Slide ${v.k + 1} of ${slides.length}${d.title ? ` · ${d.title}` : ''}` : 'The slides are loading…';
  const stage = $('fStage');
  if (!s || typeof s.doc !== 'string') { stage.replaceChildren(); return; }
  if (stage.dataset.k === `${state.deckV}:${v.k}`) return fit();
  stage.dataset.k = `${state.deckV}:${v.k}`;
  // no scripts and its own opaque origin: the slide can draw and nothing else
  const f = el('iframe', { sandbox: '', title: s.label || `Slide ${v.k + 1}`, referrerpolicy: 'no-referrer', tabindex: '-1', width: '1280', height: '720' });
  f.srcdoc = s.doc;
  stage.replaceChildren(f);
  fit();
}
function fit() {
  const stage = $('fStage');
  const f = stage && stage.querySelector('iframe');
  if (!f) return;
  const s = stage.clientWidth / 1280;
  f.style.transform = `scale(${s})`;
  stage.style.height = `${Math.round(720 * s)}px`;
}
addEventListener('resize', () => { if (state.shown === 'follow') fit(); });

addEventListener('hashchange', () => { const h = readAudienceHash(location.hash); if (h.follow !== (state.tab === 'follow')) { state.tab = h.follow ? 'follow' : 'live'; state.shown = ''; draw(); } });
$('tabLive').addEventListener('click', () => { state.tab = 'live'; state.shown = ''; draw(); });
$('tabFollow').addEventListener('click', () => { state.tab = 'follow'; state.shown = ''; draw(); });

(async () => {
  if (!id) { gone('The link is incomplete. Ask the presenter for it again.'); return; }
  try { await join(); } catch (e) {
    if (e.status === 404) gone('It ended, or the link is wrong. Ask the presenter for the link again.');
    else { say('Couldn’t join'); main.replaceChildren(el('div', { class: 'aud-card' }, el('h1', {}, 'Couldn’t join'), el('p', { class: 'aud-note' }, e.message))); }
    return;
  }
  listen();
})();
