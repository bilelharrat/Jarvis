// Team spaces (ROADMAP G8; JARVIS V1/docs/accounts.md "Team spaces"), at askeden.com only: a
// shared project across Eden accounts, with members (owner, member), a monthly AI budget out
// of the owner's Plus, and the router level its chats start from.
//
// spacesSection() is the account page's list (open one, make one, join with a code);
// openSpace(id) is a space's own sheet: its budget and who spent what, members, inviting,
// settings, "Chat in this space" (askeden.com then runs this browser's turns on the space's
// budget: a grant on the owner's account, until "Switch back"), and shared conversations.
//
// Shared conversations are end-to-end encrypted with the space's key: made by the owner's
// browser, it reaches each member's browser only sealed to that browser's own key (sync.js,
// eden-crypto.js), by a browser that has it, after both screens show the same six digits.
// askeden.com stores the sealed blobs and nothing it could read. Shared workflows (H9) are
// sealed the same way, as items of kind 'workflow': "Share to a space…" in the Workflows
// gallery (enableWorkflowSharing registers it), "Add to my workflows" here.

import { $, el, ico, toast, copyText, relDay } from './util.js';
import { state, ui, addConversation } from './state.js';
import { apiUrl, isMock } from './api.js';
import * as E from './eden-crypto.js';
import { deviceKey, keepSecret, keyGet, openEnvelope } from './sync.js';
import { setActing } from './acting.js';
import { importWorkflow, registerWorkflowSharer } from './workflows.js';
import { teamItemId, withComment, withoutComment } from './mail-ask.js';
import { locale, t } from './i18n.js';

const fill = (node, ...kids) => node.replaceChildren(...kids.filter((k) => k !== null && k !== undefined && k !== false));
const money = (n) => (typeof n === 'number' && Number.isFinite(n) ? n.toLocaleString(locale(), { style: 'currency', currency: 'USD', currencyDisplay: 'narrowSymbol' }) : '—');
const LEVEL_WORDS = { 1: 'Cheapest', 2: 'Thrifty', 3: 'Balanced', 4: 'Strong', 5: 'Best' };

async function api(path, body) {
  const init = { cache: 'no-store', method: body === undefined ? 'GET' : 'POST', headers: { 'X-Jarvis-Chat': '1', ...(body !== undefined ? { 'content-type': 'application/json' } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) };
  let res;
  try { res = isMock ? await (await import('./mock.js')).mockFetch(path, init) : await fetch(apiUrl(path), init); }
  catch { throw new Error('Can’t reach askeden.com. Check your connection.'); }
  let out = {};
  try { out = await res.json(); } catch { /* not JSON */ }
  if (!res.ok) throw Object.assign(new Error(out.error || `askeden.com said ${res.status}.`), { status: res.status, code: out.code });
  return out;
}

const field = (label, input, note) => el('label', 'acct-field', el('span', 'acct-k', label), input, note ? el('span', 'acct-sub', note) : null);
const levelSelect = (value) => {
  const s = el('select', { 'aria-label': 'Router level' }, ...[1, 2, 3, 4, 5].map((n) => {
    const o = el('option', { value: String(n) }, `${n} · ${LEVEL_WORDS[n]}`);
    if (n === Number(value)) o.selected = true;
    return o;
  }));
  return s;
};

/* ---------- the account page's section ---------- */

/** "Team spaces" on the account page. `ctx`: { redraw(), acting }. */
export function spacesSection(ctx = {}) {
  const box = el('div', 'acct-spaces', el('div', 'muted', 'Loading your spaces…'));
  const sec = el('section', { class: 'set-sec', 'aria-labelledby': 'acctSpacesH' }, el('h3', { id: 'acctSpacesH' }, 'Team spaces'), box);
  const draw = async () => {
    let data;
    try { data = await api('/api/web/space'); }
    catch (e) { box.replaceChildren(el('p', 'sp-note', e.status === 503 ? 'Team spaces aren’t available here yet.' : `Couldn’t load your spaces: ${e.message}`)); return; }
    const rows = data.spaces.map((s) => el('li', 'acct-dev',
      el('span', 'acct-ico', el('span', { class: 'acct-dot', 'aria-hidden': 'true' })),
      el('div', 'grow', el('div', 'p-n', el('span', { 'data-no-i18n': '' }, s.name), data.acting && data.acting.id === s.id ? el('span', 'acct-badge plus', 'In use') : null), el('div', 'p-c', s.owned ? 'You own it' : 'Member')),
      el('button', { type: 'button', class: 'cap', onclick: () => openSpace(s.id, { onChange: draw }) }, 'Open')));
    const create = data.can_create
      ? el('button', { type: 'button', class: 'cap primary', onclick: () => createForm(box, draw) }, 'New space')
      : el('span', 'acct-sub', 'Making a space needs Plus (its budget comes out of your Plus allowance).');
    const code = el('input', { type: 'text', class: 'acct-input', placeholder: 'XXXX-XXXX-XXXX', 'aria-label': 'Space invitation code', autocomplete: 'off', spellcheck: 'false' });
    const name = el('input', { type: 'text', class: 'acct-input', placeholder: 'Your name in the space', 'aria-label': 'Your name in the space', maxlength: '40' });
    const join = el('button', { type: 'button', class: 'cap', onclick: async () => {
      try {
        const r = await api('/api/web/space/join', { code: code.value, label: name.value });
        toast(`You joined ${r.joined.name}`);
        code.value = '';
        draw();
      } catch (e) { toast(e.message); }
    } }, 'Join');
    fill(box, 
      rows.length ? el('div', 'icard acct-card', el('ul', 'acct-list', ...rows)) : el('p', 'sp-note', 'A space is a shared project: its members chat on a monthly AI budget the owner sets aside from their Plus, and can share conversations, end-to-end encrypted.'),
      el('div', 'acct-row-actions', create),
      el('div', 'acct-join', el('span', 'acct-k', 'Have an invitation?'), el('div', 'acct-join-row', code, name, join)));
    if (ctx.prefill) { code.value = ctx.prefill; ctx.prefill = null; name.focus(); }
  };
  draw();
  return sec;
}

function createForm(box, done) {
  const name = el('input', { type: 'text', class: 'acct-input', value: '', maxlength: '60', placeholder: 'Launch team' });
  const label = el('input', { type: 'text', class: 'acct-input', maxlength: '40', placeholder: 'Your name' });
  const budget = el('input', { type: 'number', class: 'acct-input', min: '0', max: '200', step: '1', value: '10' });
  const level = levelSelect(3);
  const form = el('div', 'icard acct-card acct-form',
    field('Name', name),
    field('Your name in it', label),
    field('Monthly AI budget ($)', budget, 'Comes out of your Plus allowance. Members can’t spend more than this together.'),
    field('Router level for its chats', level),
    el('div', 'dlg-acts',
      el('button', { type: 'button', class: 'btn', onclick: () => done() }, 'Cancel'),
      el('button', { type: 'button', class: 'btn primary', onclick: async (e) => {
        e.currentTarget.disabled = true;
        try {
          const v = await api('/api/web/space/create', { name: name.value, label: label.value, budget_usd: Number(budget.value), level: Number(level.value) });
          toast(`${v.space.name} is ready`);
          done();
          openSpace(v.space.id, { onChange: done });
        } catch (err) { toast(err.message); e.currentTarget.disabled = false; }
      } }, 'Make the space')));
  box.replaceChildren(form);
  name.focus();
}

/* ---------- a space's sheet ---------- */

let current = null; // { id, onChange }

function sheet() {
  let s = $('spaceSheet');
  if (s) return s;
  s = el('div', { class: 'sheet acct-sheet', id: 'spaceSheet', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'spaceTitle' },
    el('div', 'sheet-card glass acct',
      el('div', 'sheet-head', el('h2', { id: 'spaceTitle' }, 'Team space'),
        el('button', { type: 'button', class: 'iconbtn', id: 'btnSpaceClose', 'aria-label': 'Close space', onclick: closeSpace }, ico('x'))),
      el('div', { class: 'sheet-body', id: 'spaceBody', 'aria-live': 'polite' })));
  s.addEventListener('click', (e) => { if (e.target === s) closeSpace(); });
  s.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeSpace(); } });
  document.body.append(s);
  return s;
}

export function closeSpace() {
  const s = $('spaceSheet');
  if (!s || !s.classList.contains('open')) return false;
  s.classList.remove('open');
  if (current && current.onChange) current.onChange();
  current = null;
  return true;
}

export async function openSpace(id, { onChange } = {}) {
  current = { id, onChange };
  const s = sheet();
  s.classList.add('open');
  $('btnSpaceClose').focus();
  await drawSpace();
}

async function drawSpace() {
  const body = $('spaceBody');
  if (!current) return;
  if (!body.firstChild) body.replaceChildren(el('div', 'muted', 'Loading…'));
  let v;
  try { v = await api('/api/web/space/view', { id: current.id }); }
  catch (e) { body.replaceChildren(el('div', 'sp-warn', el('b', '', 'Couldn’t open the space'), e.message)); return; }
  $('spaceTitle').setAttribute('data-no-i18n', ''); // the space's name
  $('spaceTitle').textContent = v.space.name;
  const owner = v.me.role === 'owner';
  const keyState = await spaceKey(v).catch((e) => ({ error: e.message }));
  fill(body, 
    budgetCard(v),
    el('div', 'acct-row-actions',
      el('button', { type: 'button', class: 'btn primary', onclick: () => useSpace(v) }, 'Chat in this space'),
      el('span', 'acct-sub', `Chats start at router level ${v.space.level} (${LEVEL_WORDS[v.space.level]}).`)),
    membersSection(v, owner),
    await sharedSection(v, keyState),
    await workflowsSection(v, keyState),
    await mailSection(v, keyState),
    owner ? settingsSection(v) : null,
    el('section', 'set-sec', el('h3', '', owner ? 'Delete the space' : 'Leave the space'),
      el('p', 'sp-note', owner ? 'Everyone loses access to its shared conversations; their own chats stay theirs.' : 'You lose access to its shared conversations and its budget.'),
      el('button', { type: 'button', class: 'cap rev', onclick: async (e) => {
        const b = e.currentTarget;
        if (b.dataset.sure !== '1') { b.dataset.sure = '1'; b.textContent = owner ? 'Delete it?' : 'Leave it?'; return; }
        try { await api(`/api/web/space/${owner ? 'delete' : 'leave'}`, { id: v.space.id }); toast(owner ? 'Space deleted' : 'You left the space'); closeSpace(); }
        catch (err) { toast(err.message); }
      } }, owner ? 'Delete' : 'Leave')));
}

function budgetCard(v) {
  const total = v.space.budget_usd || 0;
  const leftUsd = v.space.left_usd ?? total;
  const ratio = total > 0 ? Math.max(0, Math.min(1, leftUsd / total)) : 0;
  return el('div', 'icard acct-card',
    el('div', 'acct-allow',
      el('div', 'acct-row-top', el('span', 'acct-k', 'Shared AI this month'), el('b', 'acct-v', `${money(leftUsd)} left`)),
      el('div', { class: `acct-meter${ratio < 0.15 ? ' low' : ''}`, role: 'meter', 'aria-label': 'Shared AI left', 'aria-valuemin': '0', 'aria-valuemax': String(total), 'aria-valuenow': String(leftUsd) },
        el('span', { class: 'fill', style: { width: `${(ratio * 100).toFixed(1)}%` } })),
      el('div', 'acct-sub', `${money(v.space.spent_usd || 0)} of ${money(total)} used · from the owner’s Plus`)));
}

function membersSection(v, owner) {
  const rows = v.members.map((m) => el('li', `acct-dev${m.this ? ' this' : ''}`,
    el('span', 'acct-ico', (m.label || '?').slice(0, 1).toUpperCase()),
    el('div', 'grow', el('div', 'p-n', el('span', { 'data-no-i18n': '' }, m.label), m.this ? el('span', 'acct-badge', 'You') : null, m.role === 'owner' ? el('span', 'acct-badge', 'Owner') : null),
      el('div', 'p-c', `${money(m.spent_usd || 0)} this month · joined `, relDay(m.joined))),
    owner && m.role !== 'owner' ? el('button', { type: 'button', class: 'cap rev', onclick: async (e) => {
      const b = e.currentTarget;
      if (b.dataset.sure !== '1') { b.dataset.sure = '1'; b.textContent = 'Remove?'; return; }
      try { await api('/api/web/space/remove', { id: v.space.id, member: m.member }); toast(`${m.label} removed`); drawSpace(); }
      catch (err) { toast(err.message); }
    } }, 'Remove') : null));
  const out = el('div', 'acct-invite');
  return el('section', 'set-sec', el('h3', '', `Members (${v.members.length} of ${v.caps.members})`),
    el('div', 'icard acct-card', el('ul', 'acct-list', ...rows)),
    owner ? el('div', 'acct-row-actions', el('button', { type: 'button', class: 'cap primary', onclick: async () => {
      try {
        const inv = await api('/api/web/space/invite', { id: v.space.id });
        out.replaceChildren(inviteCard(inv, `Join “${v.space.name}” on Eden`));
      } catch (e) { toast(e.message); }
    } }, 'Invite someone')) : null,
    out);
}

/** An invitation to pass on (askeden.com sends nothing itself): the code, the link, copy, email. */
export function inviteCard({ code, link }, subject) {
  const mail = `mailto:?subject=${encodeURIComponent(t(subject))}&body=${encodeURIComponent(t(`Open ${link} (sign in to Eden with your own account), or enter the code ${code}. It works once, for 7 days.`))}`;
  return el('div', 'icard acct-card acct-code',
    el('div', 'acct-code-big', code),
    el('div', 'acct-sub', 'Works once, for 7 days. They sign in with their own Eden account.'),
    el('div', 'acct-row-actions',
      el('button', { type: 'button', class: 'cap', onclick: () => copyText(code) }, 'Copy code'),
      el('button', { type: 'button', class: 'cap', onclick: () => copyText(link) }, 'Copy link'),
      el('a', { class: 'cap', href: mail }, 'Email it')));
}

function settingsSection(v) {
  const name = el('input', { type: 'text', class: 'acct-input', value: v.space.name, maxlength: '60' });
  const budget = el('input', { type: 'number', class: 'acct-input', min: '0', max: '200', step: '1', value: String(v.space.budget_usd) });
  const level = levelSelect(v.space.level);
  return el('section', 'set-sec', el('h3', '', 'Settings'),
    el('div', 'icard acct-card acct-form',
      field('Name', name),
      field('Monthly AI budget ($)', budget, 'Out of your Plus allowance; members share it.'),
      field('Router level its chats start from', level),
      el('div', 'dlg-acts', el('button', { type: 'button', class: 'btn primary', onclick: async () => {
        try { await api('/api/web/space/update', { id: v.space.id, name: name.value, budget_usd: Number(budget.value), level: Number(level.value) }); toast('Saved'); drawSpace(); }
        catch (e) { toast(e.message); }
      } }, 'Save'))));
}

async function useSpace(v) {
  try {
    await api('/api/web/space/use', { id: v.space.id });
    setActing({ type: 'space', id: v.space.id, label: v.space.name, features: ['chat'] }); // chat only, from the first moment of the reload (acting.js)
    sessionStorage.setItem('eden:space-level', String(v.space.level));
    toast(`Chatting in ${v.space.name}`);
    setTimeout(() => location.reload(), 500); // the page's allowance and badge become the space's
  } catch (e) { toast(e.message); }
}

/* ---------- the space key and shared conversations ---------- */

/** This browser's copy of the space key: { key } when it has it, else { waiting, code } or { error }. */
async function spaceKey(v) {
  const id = v.space.id;
  const d = await deviceKey();
  await api('/api/web/space/key-register', { id, public_key: d.public, alg: d.alg });
  const have = await keyGet(`space:${id}`);
  if (have && v.key && have.gen === v.key.gen) return { key: have.key, rec: have };
  if (!v.key && v.me.role === 'owner') {
    // The owner's browser makes the space's key, and keeps it sealed to itself on the server too.
    const secret = E.newSecret();
    const gen = E.b64(E.randomBytes(9)).replace(/\+/g, '-').replace(/\//g, '_');
    const self = await E.sealTo(d.public, d.alg, secret, E.SPACE_SEAL_LABEL);
    await api('/api/web/space/key-init', { id, gen, proof: await E.proofOf(secret, E.SPACE_LABEL), ...self });
    const rec = await keepSecret(`space:${id}`, secret, gen, E.SPACE_SEAL_LABEL, self);
    v.key = { gen };
    return { key: rec.key, rec };
  }
  if (!v.key) return { waiting: true, code: await E.verifyCode(d.public), why: 'The owner’s browser makes the space’s key the first time it opens the space.' };
  const { sealed } = await api('/api/web/space/key-mine', { id });
  if (!sealed) return { waiting: true, code: await E.verifyCode(d.public) };
  const secret = await E.openSealed(d.privateKey, sealed.alg, sealed.sealed_key, sealed.sender_key, E.SPACE_SEAL_LABEL);
  const rec = await keepSecret(`space:${id}`, secret, sealed.gen, E.SPACE_SEAL_LABEL, { sealed_key: sealed.sealed_key, sender_key: sealed.sender_key, alg: sealed.alg });
  return { key: rec.key, rec };
}

const itemName = (spaceId, convId) => `${spaceId}:${convId}`;

async function sharedSection(v, ks) {
  const sec = el('section', 'set-sec', el('h3', '', 'Shared conversations'));
  if (ks.error) { sec.append(el('p', 'sp-note', `The space’s key isn’t available in this browser: ${ks.error}`)); return sec; }
  if (ks.waiting) {
    sec.append(el('div', 'icard acct-card acct-wait',
      el('b', '', 'Waiting for the space’s key'),
      el('p', 'sp-note', ks.why || 'A member whose browser has it gives this browser access (Open the space › Give access). Check they see this code:'),
      el('div', 'acct-code-big', ks.code)));
    return sec;
  }
  const label = (m) => (v.members.find((x) => x.member === m) || {}).label || t('A former member');
  // Browsers waiting for the key: this one has it, so it can give it (after the codes match).
  const waiting = v.keys.filter((k) => !k.sealed);
  if (waiting.length) {
    const rows = await Promise.all(waiting.map(async (k) => el('li', 'acct-dev',
      el('div', 'grow', el('div', 'p-n', `${label(k.member)}’s browser`), el('div', 'p-c', 'Give access only if their screen shows this code: '), el('div', 'acct-code-big small', await E.verifyCode(k.public_key))),
      el('button', { type: 'button', class: 'cap primary', onclick: async () => {
        try {
          const secret = await openEnvelope(ks.rec, E.SPACE_SEAL_LABEL);
          const s = await E.sealTo(k.public_key, k.alg, secret, E.SPACE_SEAL_LABEL);
          await api('/api/web/space/key-seal', { id: v.space.id, proof: await E.proofOf(secret, E.SPACE_LABEL), target: `${k.member}:${k.device}`, public_key: k.public_key, ...s });
          toast('Access given');
          drawSpace();
        } catch (e) { toast(e.message); }
      } }, 'Give access'))));
    sec.append(el('p', 'acct-k', 'Waiting for the space’s key'), el('div', 'icard acct-card', el('ul', 'acct-list', ...rows)));
  }
  const rows = await Promise.all(v.convs.filter((c) => (c.kind || 'conv') === 'conv').map(async (c) => {
    let title = t('A shared conversation');
    if (c.meta) { try { title = (await E.openItem(ks.key, `${itemName(v.space.id, c.id)}:meta`, c.meta, E.SPACE_LABEL)).title || title; } catch { /* sealed with another key */ } }
    const mine = v.members.find((m) => m.this);
    return el('li', 'acct-dev',
      el('div', 'grow', el('div', { class: 'p-n', 'data-no-i18n': '' }, title), el('div', 'p-c', el('span', { 'data-no-i18n': '' }, label(c.by)), ' · ', relDay(c.updated))),
      el('button', { type: 'button', class: 'cap', onclick: () => openShared(v, ks, c, title) }, 'Open'),
      mine && (c.by === mine.member || v.me.role === 'owner') ? el('button', { type: 'button', class: 'cap rev', onclick: async () => {
        try { await api('/api/web/space/conv-delete', { id: v.space.id, conv: c.id }); drawSpace(); } catch (e) { toast(e.message); }
      } }, 'Remove') : null);
  }));
  const choices = state.convs.filter((c) => !c.temp && c.nodes && Object.keys(c.nodes).length).slice(0, 100);
  const pick = el('select', { 'aria-label': 'A conversation to share' }, el('option', { value: '' }, 'Choose one of your chats…'), ...choices.map((c) => el('option', { value: c.id, 'data-no-i18n': '' }, c.title || 'Untitled')));
  sec.append(
    rows.length ? el('div', 'icard acct-card', el('ul', 'acct-list', ...rows)) : el('p', 'sp-note', 'Nothing shared yet.'),
    el('div', 'acct-join-row', pick, el('button', { type: 'button', class: 'cap primary', onclick: async () => {
      const c = state.convs.find((x) => x.id === pick.value);
      if (!c) { toast('Choose a chat first'); return; }
      try { await share(v, ks, c); toast(`Shared “${c.title}”`); drawSpace(); } catch (e) { toast(e.message); }
    } }, 'Share')),
    el('p', 'sp-note', 'End-to-end encrypted with the space’s key: askeden.com stores only what it can’t read. Images aren’t shared.'));
  return sec;
}

function strip(c) {
  const out = { ...c, nodes: {}, queue: [], status: 'idle' };
  for (const [id, n] of Object.entries(c.nodes || {})) {
    const m = { ...n };
    if (m.attachments) m.attachments = m.attachments.map((a) => (a.kind === 'image' ? { kind: 'image', name: a.name, mime: a.mime, size: a.size } : a));
    if (m.streaming) { m.streaming = false; m.finish = m.finish || 'aborted'; }
    out.nodes[id] = m;
  }
  delete out.project;
  return out;
}

async function share(v, ks, c) {
  const id = c.id.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40);
  const existing = v.convs.find((x) => x.id === id);
  const value = { v: 1, conv: strip(c) };
  if (JSON.stringify(value).length > 450_000) throw new Error('That chat is too big to share (over ~450 KB).');
  const data = await E.sealItem(ks.key, itemName(v.space.id, id), value, E.SPACE_LABEL);
  const meta = await E.sealItem(ks.key, `${itemName(v.space.id, id)}:meta`, { title: c.title || 'Untitled' }, E.SPACE_LABEL);
  await api('/api/web/space/conv-put', { id: v.space.id, conv: id, data, meta, base_rev: existing ? existing.rev : 0 });
}

// A shared conversation, opened here as a copy among this browser's chats.
async function openShared(v, ks, c, title) {
  try {
    const got = await api('/api/web/space/conv-get', { id: v.space.id, conv: c.id });
    const value = await E.openItem(ks.key, itemName(v.space.id, c.id), got.data, E.SPACE_LABEL);
    const conv = value.conv;
    const copyId = `c${[...E.randomBytes(8)].map((b) => b.toString(16).padStart(2, '0')).join('')}`;
    const copy = { ...conv, id: copyId, title: `${title} (${v.space.name})`, pinned: false, temp: false, queue: [], status: 'idle', created: Date.now(), updated: Date.now() };
    addConversation(copy);
    ui.renderSidebar();
    toast(`Added “${copy.title}” to your chats`, { label: 'Open', run: () => { state.current = copy; ui.render(); ui.renderSidebar(); closeSpace(); } });
  } catch (e) { toast(e.message === 'wrong key' ? 'This browser’s copy of the space key doesn’t open it.' : e.message); }
}

/* ---------- shared workflows (H9): sealed with the space key, like conversations ---------- */

const workflowItem = (w) => `wf-${String(w.id || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 37) || 'x'}`;

// What a space gets of a workflow: the recipe, never the example values its blanks were made
// from (they came from the sharer's own chat) or that chat's title.
function shareable(w) {
  return {
    id: w.id, name: w.name, template: w.template, mode: w.mode, level: w.level, model: w.model || null, effort: w.effort || null,
    blanks: (w.blanks || []).map((b) => ({ key: b.key, label: b.label, required: b.required !== false })),
    slots: (w.slots || []).map((x) => ({ name: x.name, kind: x.kind, optional: true })),
    updated: w.updated || Date.now(),
  };
}

/** A small chooser over the gallery: which space to share to; null when cancelled. */
function chooseSpace(spaces, name) {
  return new Promise((resolve) => {
    const back = document.activeElement;
    let s = null;
    const done = (v) => { s.remove(); if (back && document.contains(back)) back.focus(); resolve(v); };
    s = el('div', { class: 'sheet acct-sheet open', id: 'spacePick', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'spacePickT' },
      el('div', 'sheet-card sm glass acct',
        el('div', 'sheet-head', el('h2', { id: 'spacePickT' }, 'Share to a space'),
          el('button', { type: 'button', class: 'iconbtn', 'aria-label': 'Cancel', onclick: () => done(null) }, ico('x'))),
        el('div', 'sheet-body',
          el('p', 'sp-note', `Members of the space can add “${name}” to their own workflows. It’s end-to-end encrypted with the space’s key; your example values stay with you.`),
          el('div', 'icard acct-card', el('ul', 'acct-list', ...spaces.map((sp) => el('li', 'acct-dev',
            el('span', 'acct-ico', el('span', { class: 'acct-dot', 'aria-hidden': 'true' })),
            el('div', 'grow', el('div', { class: 'p-n', 'data-no-i18n': '' }, sp.name), el('div', 'p-c', sp.owned ? 'You own it' : 'Member')),
            el('button', { type: 'button', class: 'cap primary', onclick: () => done(sp) }, 'Share'))))))));
    s.addEventListener('click', (e) => { if (e.target === s) done(null); });
    s.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); done(null); } });
    document.body.append(s);
    s.querySelector('.cap.primary').focus();
  });
}

/** "Share to a space…" (workflows.js): the space's key seals it here; → what to tell the owner ('' if cancelled). */
async function shareWorkflow(w) {
  const { spaces } = await api('/api/web/space');
  if (!spaces || !spaces.length) throw new Error('you aren’t in a team space yet (Account › Team spaces).');
  const target = spaces.length === 1 ? spaces[0] : await chooseSpace(spaces, w.name);
  if (!target) return '';
  const v = await api('/api/web/space/view', { id: target.id });
  const ks = await spaceKey(v);
  if (ks.error) throw new Error(`the space’s key isn’t available in this browser: ${ks.error}`);
  if (ks.waiting) throw new Error(`this browser doesn’t have ${v.space.name}’s key yet: open the space (Account › Team spaces) and ask a member to give it access.`);
  const id = workflowItem(w);
  const existing = v.convs.find((x) => x.id === id);
  const data = await E.sealItem(ks.key, itemName(v.space.id, id), { v: 1, kind: 'workflow', workflow: shareable(w) }, E.SPACE_LABEL);
  const meta = await E.sealItem(ks.key, `${itemName(v.space.id, id)}:meta`, { title: w.name, kind: 'workflow' }, E.SPACE_LABEL);
  await api('/api/web/space/conv-put', { id: v.space.id, conv: id, data, meta, base_rev: existing ? existing.rev : 0, kind: 'workflow' });
  return `Shared “${w.name}” to ${v.space.name}`;
}

/** At askeden.com (account.js, once accounts are there): workflows can be shared to a space. */
export function enableWorkflowSharing() { registerWorkflowSharer(shareWorkflow); }

async function workflowsSection(v, ks) {
  const items = v.convs.filter((c) => c.kind === 'workflow');
  if (!items.length || ks.error || ks.waiting) return null; // nothing yet, or no key here (the conversations' section says why)
  const label = (m) => (v.members.find((x) => x.member === m) || {}).label || t('A former member');
  const mine = v.members.find((m) => m.this);
  const rows = await Promise.all(items.map(async (c) => {
    let title = t('A shared workflow');
    if (c.meta) { try { title = (await E.openItem(ks.key, `${itemName(v.space.id, c.id)}:meta`, c.meta, E.SPACE_LABEL)).title || title; } catch { /* sealed with another key */ } }
    return el('li', 'acct-dev',
      el('span', 'acct-ico', ico('spark', 14)),
      el('div', 'grow', el('div', { class: 'p-n', 'data-no-i18n': '' }, title), el('div', 'p-c', el('span', { 'data-no-i18n': '' }, label(c.by)), ' · ', relDay(c.updated))),
      el('button', { type: 'button', class: 'cap primary', onclick: async () => {
        try {
          const got = await api('/api/web/space/conv-get', { id: v.space.id, conv: c.id });
          const value = await E.openItem(ks.key, itemName(v.space.id, c.id), got.data, E.SPACE_LABEL);
          if (!value || value.kind !== 'workflow' || !value.workflow) throw new Error('That isn’t a workflow.');
          const copy = importWorkflow(value.workflow, { space: v.space.name, by: label(c.by) });
          toast(`Added “${copy.name}” to your workflows`);
        } catch (e) { toast(e.message === 'wrong key' ? 'This browser’s copy of the space key doesn’t open it.' : `Couldn’t add it: ${e.message}`); }
      } }, 'Add to my workflows'),
      mine && (c.by === mine.member || v.me.role === 'owner') ? el('button', { type: 'button', class: 'cap rev', onclick: async () => {
        try { await api('/api/web/space/conv-delete', { id: v.space.id, conv: c.id }); drawSpace(); } catch (e) { toast(e.message); }
      } }, 'Remove') : null);
  }));
  return el('section', 'set-sec', el('h3', '', 'Shared workflows'),
    el('div', 'icard acct-card', el('ul', 'acct-list', ...rows)),
    el('p', 'sp-note', 'Recipes members shared from their Workflows (⋯ › Share to a space…), end-to-end encrypted like the conversations. Adding one puts a copy in your own gallery.'));
}


/* ---------- shared email threads (Eden Mail, askeden ROADMAP O5): sealed with the space key, with comments ---------- */
// An item of kind 'mail': { v: 1, kind: 'mail', thread: { threadId, subject, messages: [{ from, to,
// cc, date, subject, body, attachments }] }, comments: [{ id, member, label, text, at }], by, updated }.
// Its meta (sealed too) says { title, kind: 'mail', comments, last } so lists need no fetch.
// A comment is a new revision of the item (conv-put with base_rev); a clash re-reads and retries.

const views = new Map(); // space id → { v, ks, at }
async function spaceWithKey(id, fresh = false) {
  const hit = views.get(id);
  if (hit && !fresh && Date.now() - hit.at < 30_000) return hit;
  const v = await api('/api/web/space/view', { id });
  const ks = await spaceKey(v);
  const out = { v, ks, at: Date.now() };
  views.set(id, out);
  return out;
}
const meOf = (v) => v.members.find((m) => m.this) || { member: '', label: 'You' };
const mailMeta = (value) => {
  const last = (value.comments || [])[value.comments.length - 1];
  return { title: value.thread.subject || '(no subject)', kind: 'mail', comments: (value.comments || []).length, last: last ? `${last.label}: ${last.text}`.slice(0, 120) : '' };
};
async function putMail(v, ks, id, value, baseRev) {
  const data = await E.sealItem(ks.key, itemName(v.space.id, id), value, E.SPACE_LABEL);
  if (data.length > 690_000) throw new Error('That thread is too long to share (over ~500 KB).');
  const meta = await E.sealItem(ks.key, `${itemName(v.space.id, id)}:meta`, mailMeta(value), E.SPACE_LABEL);
  return api('/api/web/space/conv-put', { id: v.space.id, conv: id, data, meta, base_rev: baseRev, kind: 'mail' });
}

export const teamMail = {
  /** Team spaces live on askeden.com only. */
  available: () => Boolean(state.meta && state.meta.hosted),
  /** Every shared thread in every space this browser has the key of: [{ space, id, rev, title, comments, last, by, updated, threadId }]. */
  async list() {
    const { spaces } = await api('/api/web/space');
    const out = [];
    for (const sp of spaces || []) {
      let got;
      try { got = await spaceWithKey(sp.id, true); } catch { continue; }
      const { v, ks } = got;
      if (!ks.key) continue;
      const label = (m) => (v.members.find((x) => x.member === m) || {}).label || t('A former member');
      for (const c of v.convs.filter((x) => x.kind === 'mail')) {
        let meta = {};
        if (c.meta) { try { meta = await E.openItem(ks.key, `${itemName(v.space.id, c.id)}:meta`, c.meta, E.SPACE_LABEL); } catch { /* another key */ } }
        out.push({ space: { id: v.space.id, name: v.space.name }, id: c.id, rev: c.rev, title: meta.title || 'A shared email', comments: meta.comments || 0, last: meta.last || '', by: label(c.by), updated: c.updated, threadId: c.id.slice(3) });
      }
    }
    return out.sort((a, b) => b.updated - a.updated);
  },
  /** One shared thread, opened: { value, rev, me, space }. */
  async get(spaceId, id) {
    const { v, ks } = await spaceWithKey(spaceId);
    if (!ks.key) throw new Error('this browser doesn’t have the space’s key yet (Account › Team spaces).');
    const got = await api('/api/web/space/conv-get', { id: spaceId, conv: id });
    const value = await E.openItem(ks.key, itemName(spaceId, id), got.data, E.SPACE_LABEL);
    return { value, rev: got.rev, me: meOf(v), space: { id: spaceId, name: v.space.name } };
  },
  /** Shares a thread ({ threadId, subject, messages }) to a space the owner picks; → { space, id } or null. */
  async share(thread) {
    const { spaces } = await api('/api/web/space');
    if (!spaces || !spaces.length) throw new Error('you aren’t in a team space yet (Account › Team spaces).');
    const target = spaces.length === 1 ? spaces[0] : await chooseSpace(spaces, thread.subject || 'this email');
    if (!target) return null;
    const { v, ks } = await spaceWithKey(target.id, true);
    if (ks.error) throw new Error(`the space’s key isn’t available in this browser: ${ks.error}`);
    if (ks.waiting) throw new Error(`this browser doesn’t have ${v.space.name}’s key yet: open the space and ask a member to give it access.`);
    const id = teamItemId(thread.threadId);
    const existing = v.convs.find((x) => x.id === id);
    let value = { v: 1, kind: 'mail', thread, comments: [], by: meOf(v).label, updated: Date.now() };
    if (existing) { // shared before: the newer messages, the comments kept
      const old = await teamMail.get(v.space.id, id);
      value = { ...old.value, thread, updated: Date.now() };
      await putMail(v, ks, id, value, old.rev);
    } else await putMail(v, ks, id, value, 0);
    return { space: { id: v.space.id, name: v.space.name }, id };
  },
  /** Adds (or, with `remove`, takes back) a comment; a clash with another member's comment re-reads and tries again. */
  async comment(spaceId, id, text, { remove = null } = {}) {
    for (let i = 0; i < 4; i++) {
      const { v, ks } = await spaceWithKey(spaceId);
      const cur = await teamMail.get(spaceId, id);
      const me = meOf(v);
      const next = remove ? withoutComment(cur.value, remove, me.member) : withComment(cur.value, { member: me.member, label: me.label, text });
      try { await putMail(v, ks, id, next, cur.rev); return next; }
      catch (e) { if (e.status !== 409) throw e; }
    }
    throw new Error('Others are commenting right now: try again.');
  },
  async remove(spaceId, id) { await api('/api/web/space/conv-delete', { id: spaceId, conv: id }); },
};

async function mailSection(v, ks) {
  const items = v.convs.filter((c) => c.kind === 'mail');
  if (!items.length || ks.error || ks.waiting) return null;
  const label = (m) => (v.members.find((x) => x.member === m) || {}).label || t('A former member');
  const rows = await Promise.all(items.map(async (c) => {
    let meta = {};
    if (c.meta) { try { meta = await E.openItem(ks.key, `${itemName(v.space.id, c.id)}:meta`, c.meta, E.SPACE_LABEL); } catch { /* another key */ } }
    return el('li', 'acct-dev',
      el('span', 'acct-ico', ico('mail', 14)),
      el('div', 'grow', el('div', { class: 'p-n', 'data-no-i18n': '' }, meta.title || t('A shared email')), el('div', 'p-c', el('span', { 'data-no-i18n': '' }, label(c.by)), ` · ${meta.comments || 0} comment${meta.comments === 1 ? '' : 's'} · `, relDay(c.updated))),
      el('button', { type: 'button', class: 'cap primary', onclick: () => { closeSpace(); dispatchEvent(new CustomEvent('eden:open-team-mail', { detail: { space: v.space.id, id: c.id } })); } }, 'Open in Mail'));
  }));
  return el('section', 'set-sec', el('h3', '', 'Shared emails'),
    el('div', 'icard acct-card', el('ul', 'acct-list', ...rows)),
    el('p', 'sp-note', 'Email threads members shared from Mail (Share with team), with the team’s comments. End-to-end encrypted with the space’s key.'));
}
